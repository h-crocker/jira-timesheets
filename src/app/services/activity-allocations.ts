import type {
  ActivityEvent,
  ActivityKind,
  JiraWorklog,
  PercentageAllocation,
  UserSettings,
} from '../models/domain';
import { clashesWithLeave, planLeave } from './leave-planner';
import { addDays, isoWeekday, matchRecorded, recurringEvents } from './schedule-time';

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
export const PLACEHOLDER_SUMMARY = 'General work';

export interface ActivityWeek {
  weekStart: Date;
  settings: UserSettings;
  worklogs: JiraWorklog[];
  /** Weekdays marked as leave, 1 = Monday. */
  leaveDays: number[];
  /** Evidence from GitHub. */
  activity: ActivityEvent[];
  /** Automatic worklogs that earlier syncs of the week replaced. */
  absorbed: JiraWorklog[];
}

function inWeek(weekStart: Date, at: Date): boolean {
  return at >= weekStart && at < addDays(weekStart, 7);
}

/**
 * The week's worklogs that Jira added automatically, or anything else you logged: every worklog
 * that isn't the app's own, isn't on the leave ticket and doesn't record a recurring meeting.
 * A week with allocations filled from activity replaces these when it syncs.
 */
export function automaticWorklogs(
  weekStart: Date,
  settings: UserSettings,
  worklogs: JiraWorklog[],
  leaveDays: number[],
): JiraWorklog[] {
  const week = worklogs.filter((worklog) => inWeek(weekStart, worklog.started));
  const leave = planLeave(weekStart, settings, week, leaveDays);
  const recurring = recurringEvents(weekStart, settings).filter(
    (event) => !clashesWithLeave(event, leave),
  );
  const others = week.filter((worklog) => !leave.handled.has(worklog.id));
  const { recorded } = matchRecorded(recurring, others);
  return others.filter((worklog) => !worklog.generated && !recorded.has(worklog.id));
}

/**
 * Everything counted as evidence of work in the week: GitHub activity, the automatic worklogs
 * still in Jira, and those replaced by earlier syncs. Nothing on the leave ticket.
 */
export function weekEvidence(week: ActivityWeek): ActivityEvent[] {
  const { weekStart, settings } = week;
  const replaced = new Map<string, JiraWorklog>();
  for (const worklog of [
    ...week.absorbed,
    ...automaticWorklogs(weekStart, settings, week.worklogs, week.leaveDays),
  ]) {
    replaced.set(worklog.id, worklog);
  }
  const leaveKey = settings.leaveIssueKey.trim();
  return [
    ...week.activity,
    ...[...replaced.values()].map((worklog): ActivityEvent => ({
      id: `jira:${worklog.id}`,
      issueKey: worklog.issueKey,
      at: worklog.started,
      kind: 'jira-worklog',
      label: worklog.comment ?? worklog.issueKey,
    })),
  ].filter(
    (event) => inWeek(weekStart, event.at) && event.issueKey !== '' && event.issueKey !== leaveKey,
  );
}

/** The working day evidence counts toward: its own, else the nearest earlier one, else the next. */
function dayFor(at: Date, days: number[]): number | undefined {
  const weekday = isoWeekday(at);
  if (days.includes(weekday)) {
    return weekday;
  }
  const earlier = days.filter((day) => day < weekday);
  return earlier.length > 0 ? earlier[earlier.length - 1] : days.find((day) => day > weekday);
}

/**
 * Each issue's weight for the week: per day, each kind of evidence counts up to its cap, and a
 * quiet day between two days with evidence for an issue counts as a little work on it.
 */
export function issueWeights(
  evidence: ActivityEvent[],
  workingDays: number[],
): Map<string, number> {
  // issue → day → kind → count
  const counts = new Map<string, Map<number, Map<ActivityKind, number>>>();
  for (const event of evidence) {
    const day = dayFor(event.at, workingDays);
    if (day === undefined) {
      continue;
    }
    const byDay = counts.get(event.issueKey) ?? new Map<number, Map<ActivityKind, number>>();
    counts.set(event.issueKey, byDay);
    const byKind = byDay.get(day) ?? new Map<ActivityKind, number>();
    byDay.set(day, byKind);
    byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + (event.share ?? 1));
  }

  const weights = new Map<string, number>();
  for (const [issueKey, byDay] of counts) {
    let weight = 0;
    for (const byKind of byDay.values()) {
      for (const [kind, count] of byKind) {
        weight += Math.min(count * EVIDENCE_WEIGHTS[kind].weight, EVIDENCE_WEIGHTS[kind].cap);
      }
    }
    const active = [...byDay.keys()].sort((a, b) => a - b);
    const bridged = workingDays.filter(
      (day) => day > active[0] && day < active[active.length - 1] && !byDay.has(day),
    ).length;
    weights.set(issueKey, weight + bridged * BRIDGE_WEIGHT);
  }
  return weights;
}

/** Whole percentages in proportion to `weights`, adding up to 100 (largest remainder). */
function toPercentages(weights: Map<string, number>): Map<string, number> {
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const shares = [...weights].map(([issueKey, weight]) => {
    const exact = (100 * weight) / total;
    return { issueKey, exact, whole: Math.floor(exact + 1e-9) };
  });
  let left = 100 - shares.reduce((sum, share) => sum + share.whole, 0);
  const byFraction = [...shares].sort(
    (a, b) => b.exact - b.whole - (a.exact - a.whole) || a.issueKey.localeCompare(b.issueKey),
  );
  for (const share of byFraction) {
    if (left <= 0) {
      break;
    }
    share.whole++;
    left--;
  }
  return new Map(shares.map((share) => [share.issueKey, share.whole]));
}

/**
 * The week's allocations, in proportion to the evidence for each issue. A week with no evidence
 * goes all to the placeholder ticket, or gets no allocations without one. Issues whose share
 * rounds to 0% are left out.
 */
export function activityAllocations(
  week: ActivityWeek,
  summaries: ReadonlyMap<string, string>,
): PercentageAllocation[] {
  const { weekStart, settings } = week;
  const leave = planLeave(
    weekStart,
    settings,
    week.worklogs.filter((worklog) => inWeek(weekStart, worklog.started)),
    week.leaveDays,
  );
  const workingDays = [...new Set(settings.workDays)]
    .filter((day) => !leave.offDays.has(day))
    .sort((a, b) => a - b);
  let weights = issueWeights(weekEvidence(week), workingDays);
  const placeholder = settings.placeholderIssueKey.trim();
  if (weights.size === 0 && placeholder !== '') {
    weights = new Map([[placeholder, 1]]);
  }
  if (weights.size === 0) {
    return [];
  }
  return [...toPercentages(weights)]
    .filter(([, percentage]) => percentage > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([issueKey, percentage]) => ({
      id: `activity-${issueKey}`,
      issueKey,
      summary:
        summaries.get(issueKey) ?? (issueKey === placeholder ? PLACEHOLDER_SUMMARY : issueKey),
      percentage,
    }));
}
