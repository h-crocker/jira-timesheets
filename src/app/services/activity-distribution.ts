import type {
  ActivityEvent,
  ActivityKind,
  CalendarEvent,
  EngineInput,
  ExecutionPlan,
  JiraWorklog,
  WorklogCreation,
  WorklogDeletion,
} from '../models/domain';
import { type LeavePlan, clashesWithLeave, planLeave } from './leave-planner';
import {
  BLOCK_SECONDS,
  type Interval,
  addDays,
  daySlot,
  durationSeconds,
  freeGaps,
  isoWeekday,
  matchRecorded,
  recurringEvents,
  sameMinute,
  startOfDay,
  worklogInterval,
} from './schedule-time';

/** How much each kind of evidence counts, and the most it can add per issue per day. */
export const EVIDENCE_WEIGHTS: Record<ActivityKind, { weight: number; cap: number }> = {
  'jira-worklog': { weight: 4, cap: Infinity },
  'pr-opened': { weight: 3, cap: Infinity },
  review: { weight: 3, cap: 6 },
  commit: { weight: 1, cap: 5 },
  comment: { weight: 1, cap: 3 },
  'pr-merged': { weight: 1, cap: Infinity },
};
/** Weight an issue gets on a quiet day between two days with evidence for it. */
export const BRIDGE_WEIGHT = 1;
export const PLACEHOLDER_COMMENT = 'General work';
const MAX_COMMENT_LENGTH = 255;

interface Classified {
  weekEnd: Date;
  leave: LeavePlan;
  /** Work days that can be filled: before the cutoff and not days off. */
  fillable: number[];
  recurring: CalendarEvent[];
  unrecordedRecurring: CalendarEvent[];
  /** Worklogs the app created, which stay only if the plan still wants them. */
  generated: JiraWorklog[];
  /** Worklogs on or after the cutoff, left as they are. */
  fixed: JiraWorklog[];
  /** Worklogs Jira added automatically (or anything else), which become evidence and go. */
  automatic: JiraWorklog[];
  evidence: ActivityEvent[];
}

/** Days from the one after `now` are left alone; the fill stops at the start of tomorrow. */
function fillCutoff(weekStart: Date, weekEnd: Date, now: Date | undefined): Date {
  if (now === undefined) {
    return weekEnd;
  }
  const tomorrow = addDays(startOfDay(now), 1);
  if (tomorrow < weekStart) {
    return weekStart;
  }
  return tomorrow > weekEnd ? weekEnd : tomorrow;
}

function classify(input: EngineInput): Classified {
  const { weekStart, settings } = input;
  const weekEnd = addDays(weekStart, 7);
  const inWeek = (at: Date) => at >= weekStart && at < weekEnd;
  const cutoff = fillCutoff(weekStart, weekEnd, input.now);
  const worklogs = input.worklogs.filter((worklog) => inWeek(worklog.started));
  const leave = planLeave(weekStart, settings, worklogs, input.leaveDays ?? []);
  const fillable = [...new Set(settings.workDays)]
    .filter((weekday) => !leave.offDays.has(weekday) && addDays(weekStart, weekday - 1) < cutoff)
    .sort((a, b) => a - b);

  const recurring = recurringEvents(weekStart, settings).filter(
    (event) => fillable.includes(isoWeekday(event.start)) && !clashesWithLeave(event, leave),
  );
  const others = worklogs.filter((worklog) => !leave.handled.has(worklog.id));
  const past = others.filter((worklog) => worklog.started < cutoff);
  const { recorded, unrecorded } = matchRecorded(
    recurring,
    past.filter((worklog) => !worklog.generated),
  );
  const automatic = past.filter((worklog) => !worklog.generated && !recorded.has(worklog.id));

  const leaveKey = settings.leaveIssueKey.trim();
  const replaced = new Map<string, JiraWorklog>();
  for (const worklog of [...(input.absorbed ?? []), ...automatic]) {
    replaced.set(worklog.id, worklog);
  }
  const evidence = [
    ...(input.activity ?? []),
    ...[...replaced.values()].map((worklog): ActivityEvent => ({
      id: `jira:${worklog.id}`,
      issueKey: worklog.issueKey,
      at: worklog.started,
      kind: 'jira-worklog',
      label: worklog.comment ?? worklog.issueKey,
    })),
  ].filter((event) => inWeek(event.at) && event.issueKey !== '' && event.issueKey !== leaveKey);

  return {
    weekEnd,
    leave,
    fillable,
    recurring,
    unrecordedRecurring: unrecorded,
    generated: past.filter((worklog) => worklog.generated),
    fixed: others.filter((worklog) => worklog.started >= cutoff),
    automatic,
    evidence,
  };
}

/**
 * Everything counted as evidence of work this week: GitHub activity, the automatic worklogs still
 * in Jira, and those replaced by earlier syncs.
 */
export function weekEvidence(input: EngineInput): ActivityEvent[] {
  return classify(input).evidence;
}

/** The work day evidence counts toward: its own, else the nearest earlier one, else the next. */
function dayFor(at: Date, fillable: number[]): number | undefined {
  const weekday = isoWeekday(at);
  if (fillable.includes(weekday)) {
    return weekday;
  }
  const earlier = fillable.filter((day) => day < weekday);
  if (earlier.length > 0) {
    return earlier[earlier.length - 1];
  }
  return fillable.find((day) => day > weekday);
}

interface DayEvidence {
  weights: Map<string, number>;
  firstAt: Map<string, number>;
  events: ActivityEvent[];
}

function weighEvidence(evidence: ActivityEvent[], fillable: number[]): Map<number, DayEvidence> {
  const counts = new Map<number, Map<string, Map<ActivityKind, number>>>();
  const days = new Map<number, DayEvidence>(
    fillable.map((day) => [day, { weights: new Map(), firstAt: new Map(), events: [] }]),
  );
  for (const event of [...evidence].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const day = dayFor(event.at, fillable);
    if (day === undefined) {
      continue;
    }
    const byIssue = counts.get(day) ?? new Map<string, Map<ActivityKind, number>>();
    counts.set(day, byIssue);
    const byKind = byIssue.get(event.issueKey) ?? new Map<ActivityKind, number>();
    byIssue.set(event.issueKey, byKind);
    byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + (event.share ?? 1));
    const dayEvidence = days.get(day)!;
    dayEvidence.events.push(event);
    if (!dayEvidence.firstAt.has(event.issueKey)) {
      dayEvidence.firstAt.set(event.issueKey, event.at.getTime());
    }
  }
  for (const [day, byIssue] of counts) {
    for (const [issueKey, byKind] of byIssue) {
      let weight = 0;
      for (const [kind, count] of byKind) {
        const { weight: each, cap } = EVIDENCE_WEIGHTS[kind];
        weight += Math.min(count * each, cap);
      }
      days.get(day)!.weights.set(issueKey, weight);
    }
  }

  // Work on an issue rarely stops and starts: fill quiet days between two days with evidence.
  const issues = new Set([...days.values()].flatMap((day) => [...day.weights.keys()]));
  for (const issueKey of issues) {
    const active = fillable.filter((day) => (days.get(day)!.weights.get(issueKey) ?? 0) > 0);
    for (const day of fillable) {
      const weights = days.get(day)!.weights;
      if (day > active[0] && day < active[active.length - 1] && !weights.has(issueKey)) {
        weights.set(issueKey, BRIDGE_WEIGHT);
      }
    }
  }
  return days;
}

interface Participant {
  issueKey: string;
  quota: number;
  units: number;
  order: number;
  comment: string;
  source: 'allocated' | 'activity';
}

/** Largest remainder: floor every quota, then hand the blocks left to the largest fractions. */
function apportion(participants: Participant[], target: number): void {
  let assigned = 0;
  for (const participant of participants) {
    participant.units = Math.floor(participant.quota + 1e-9);
    assigned += participant.units;
  }
  const byFraction = [...participants].sort(
    (a, b) =>
      b.quota - Math.floor(b.quota + 1e-9) - (a.quota - Math.floor(a.quota + 1e-9)) ||
      a.issueKey.localeCompare(b.issueKey),
  );
  for (let i = 0; assigned < target && byFraction.length > 0; i++) {
    byFraction[i % byFraction.length].units++;
    assigned++;
  }
}

function describe(events: ActivityEvent[], issueKey: string): string {
  const own = events.filter((event) => event.issueKey === issueKey);
  // Pull request titles say more than Jira's automatic worklog comments.
  const preferred = own.filter((event) => event.kind !== 'jira-worklog');
  const labels = [...new Set((preferred.length > 0 ? preferred : own).map((event) => event.label))];
  const text = labels.join('; ');
  return text.length > MAX_COMMENT_LENGTH ? `${text.slice(0, MAX_COMMENT_LENGTH - 1)}…` : text;
}

/** Creations that fill each fillable day's free time from allocations and evidence. */
function fillDays(input: EngineInput, classified: Classified): WorklogCreation[] {
  const { weekStart, settings } = input;
  const { fillable, evidence, recurring, leave, fixed } = classified;
  const days = weighEvidence(evidence, fillable);
  const weekWeights = new Map<string, number>();
  for (const day of days.values()) {
    for (const [issueKey, weight] of day.weights) {
      weekWeights.set(issueKey, (weekWeights.get(issueKey) ?? 0) + weight);
    }
  }
  const placeholder = settings.placeholderIssueKey.trim();
  const totalPercentage = settings.allocations.reduce((sum, a) => sum + a.percentage, 0);
  const allocationScale = totalPercentage > 100 ? 100 / totalPercentage : 1;
  const activityShare = Math.max(0, 1 - (totalPercentage * allocationScale) / 100);
  const occupied: Interval[] = [
    ...recurring.map((event) => ({ start: event.start, end: event.end })),
    ...leave.intervals,
    ...fixed.map(worklogInterval),
  ];

  const creations: WorklogCreation[] = [];
  for (const day of fillable) {
    const gaps = freeGaps(daySlot(weekStart, day, settings), occupied);
    const units = gaps.reduce(
      (sum, gap) => sum + Math.floor(durationSeconds(gap) / BLOCK_SECONDS),
      0,
    );
    if (units === 0) {
      continue;
    }
    const today = days.get(day)!;
    let weights = today.weights;
    let comments = today.events;
    if (weights.size === 0) {
      weights = weekWeights;
      comments = evidence;
    }
    if (weights.size === 0 && placeholder !== '') {
      weights = new Map([[placeholder, 1]]);
    }
    const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);

    const participants: Participant[] = [...weights]
      .map(([issueKey, weight]) => ({
        issueKey,
        quota: (units * activityShare * weight) / totalWeight,
        units: 0,
        order: today.firstAt.get(issueKey) ?? Infinity,
        comment:
          describe(comments, issueKey) ||
          (issueKey === placeholder ? PLACEHOLDER_COMMENT : issueKey),
        source: 'activity' as const,
      }))
      .sort((a, b) => a.order - b.order || a.issueKey.localeCompare(b.issueKey));
    for (const allocation of settings.allocations) {
      participants.push({
        issueKey: allocation.issueKey,
        quota: (units * allocation.percentage * allocationScale) / 100,
        units: 0,
        order: Infinity,
        comment: allocation.summary,
        source: 'allocated',
      });
    }
    const allocatedQuota = participants
      .filter((participant) => participant.source === 'allocated')
      .reduce((sum, participant) => sum + participant.quota, 0);
    const hasActivity = weights.size > 0 && activityShare > 0;
    apportion(participants, hasActivity ? units : Math.floor(allocatedQuota + 1e-9));

    // Each participant's blocks run on from the last one's, split only where a gap ends.
    let index = 0;
    let left = participants[0]?.units ?? 0;
    for (const gap of gaps) {
      let cursor = gap.start.getTime();
      let room = Math.floor(durationSeconds(gap) / BLOCK_SECONDS);
      while (room > 0 && index < participants.length) {
        if (left === 0) {
          index++;
          left = participants[index]?.units ?? 0;
          continue;
        }
        const take = Math.min(left, room);
        const participant = participants[index];
        creations.push({
          issueKey: participant.issueKey,
          started: new Date(cursor).toISOString(),
          timeSpentSeconds: take * BLOCK_SECONDS,
          comment: participant.comment,
          source: participant.source,
        });
        cursor += take * BLOCK_SECONDS * 1000;
        room -= take;
        left -= take;
      }
    }
  }
  return creations;
}

/**
 * Activity mode: fill each working day from what was worked on, replacing the worklogs Jira added
 * automatically. Worklogs the app created stay only while the plan still wants them, so syncing
 * twice changes nothing.
 */
export function planFromActivity(input: EngineInput): ExecutionPlan {
  const classified = classify(input);
  const desired: WorklogCreation[] = [
    ...classified.unrecordedRecurring.map((event): WorklogCreation => ({
      issueKey: event.issueKey,
      started: event.start.toISOString(),
      timeSpentSeconds: event.timeSpentSeconds,
      comment: event.summary,
      source: 'recurring',
    })),
    ...fillDays(input, classified),
  ];

  const kept = new Set<string>();
  const creations: WorklogCreation[] = [...classified.leave.creations];
  for (const want of desired) {
    const existing = classified.generated.find(
      (worklog) =>
        !kept.has(worklog.id) &&
        worklog.issueKey === want.issueKey &&
        sameMinute(worklog.started, new Date(want.started)) &&
        worklog.timeSpentSeconds === want.timeSpentSeconds,
    );
    if (existing === undefined) {
      creations.push(want);
    } else {
      kept.add(existing.id);
    }
  }

  const deletions: WorklogDeletion[] = [
    ...classified.leave.deletions,
    ...classified.generated
      .filter((worklog) => !kept.has(worklog.id))
      .map((worklog) => ({
        worklogId: worklog.id,
        issueKey: worklog.issueKey,
        reason: 'stale-generated',
      })),
    ...classified.automatic.map((worklog) => ({
      worklogId: worklog.id,
      issueKey: worklog.issueKey,
      reason: 'replaced-by-activity',
    })),
  ];

  creations.sort((a, b) => a.started.localeCompare(b.started));
  return { deletions, creations, absorb: classified.automatic };
}
