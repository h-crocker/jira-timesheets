// Applies an approved plan, one day at a time. Every change in the plan is either made or written
// down, with why, in the list of things that couldn't be changed; nothing is skipped silently.
//
// - Only days the plan marked ready are touched, and only if the plan id was approved.
// - Deletions need their own approval.
// - Every worklog on those days is backed up (raw JSON from Jira) before the first change.
// - Within a day, time comes off first. If Jira refuses to shorten or delete a worklog (a locked
//   ticket, a closed period, no permission), or the worklog changed since the plan, that is
//   recorded and the rest of the day still goes ahead: sick leave is added regardless, even if the
//   day then comes to more than its hours.
// - A move creates the new worklog first and only then shortens the source, so a refusal can
//   leave the day over (and recorded) but never loses time.
// - Edits never send `started`, so a worklog's start time and day can't move.
// - Re-running is safe: an edit already made or a worklog already deleted is skipped, a worklog the
//   plan creates carries a marker so it is never created twice, and refused changes are retried.
// - Only a failure that says nothing about the change itself (bad credentials, Jira unavailable, a
//   network fault) stops the run; run it again once that is fixed.
// - Refusals that read like a lock are recorded, so later plans warn about the ticket. Nothing
//   tries to get round a lock.

import type { CorrectionsClient } from './client-port';
import { JiraError, type RawWorklog } from './jira-rest-client';
import { addDaysToKey, dayWindow, parseJiraDateTime, timeInZone } from './time-zone';
import type { CreateOp, Op, OwnWorklog, Plan, PlannedDay } from './types';

export interface ApplyLogEntry {
  at: string;
  planId: string;
  date: string;
  opId?: string;
  kind?: Op['kind'];
  issueKey?: string;
  worklogId?: string;
  outcome:
    | 'applied'
    | 'already-applied'
    | 'conflict'
    | 'refused'
    | 'skipped'
    | 'error'
    | 'warning'
    | 'day-checked';
  detail: string;
}

export interface ApplyDeps {
  client: CorrectionsClient;
  /** Saves the backup and returns where; throwing stops the apply before any change. */
  backup(snapshot: { planId: string; takenAt: string; days: BackupDay[] }): Promise<string>;
  log(entry: ApplyLogEntry): void;
  /** Records an issue that refused a change, so later plans warn about it. */
  lockedIssue(issueKey: string, reason: string): void;
  now?: () => Date;
}

export interface BackupDay {
  date: string;
  worklogs: RawWorklog[];
}

export interface ApplyOptions {
  approvedPlanId: string;
  allowDeletions: boolean;
}

/** A change from the plan that wasn't made. */
export interface ApplyFailure {
  date: string;
  opId: string;
  issueKey: string;
  worklogId?: string;
  /** What the change was, e.g. "delete ABC-12 worklog 10073 (1.5h)". */
  action: string;
  kind: 'refused' | 'conflict' | 'skipped' | 'error';
  reason: string;
}

export interface ApplyResult {
  /** done: every change made. partial: finished, but some changes couldn't be made (see failures). */
  status: 'done' | 'partial' | 'stopped' | 'refused';
  message: string;
  backupPath?: string;
  outcomes: { date: string; opId: string; outcome: 'applied' | 'already-applied' }[];
  failures: ApplyFailure[];
  /** Each applied day's total afterwards, against the plan. */
  days: { date: string; totalSeconds: number; plannedSeconds: number }[];
  stoppedAt?: { date: string; opId?: string; reason: string };
}

/** A change that can't be made because Jira no longer looks as planned. */
class Conflict extends Error {}

/** A failure that stops the whole run: nothing about it is specific to one change. */
class Abort extends Error {}

const h = (seconds: number) => `${Math.round((seconds / 3600) * 100) / 100}h`;

/**
 * Order within a day: deletions and reductions, then comment-only edits, then additions (sick
 * leave, and what a move creates), then what has to wait for those: a move's source, and extra
 * sick-leave worklogs merged into the one kept.
 */
function rank(op: Op): number {
  if (op.kind !== 'create' && (op.requires ?? []).length > 0) {
    return 4;
  }
  if (op.kind === 'delete') {
    return 0;
  }
  if (op.kind === 'create') {
    return 3;
  }
  return op.after.seconds < op.before.seconds ? 1 : op.after.seconds === op.before.seconds ? 2 : 3;
}

export function describeOp(op: Op, timeZone: string): string {
  if (op.kind === 'create') {
    return `add ${op.issueKey} ${h(op.seconds)} at ${timeInZone(parseJiraDateTime(op.started), timeZone)}`;
  }
  if (op.kind === 'delete') {
    return `delete ${op.issueKey} worklog ${op.worklogId} (${h(op.before.seconds)})`;
  }
  const parts = [
    ...(op.after.seconds !== op.before.seconds
      ? [`${h(op.before.seconds)} → ${h(op.after.seconds)}`]
      : []),
    ...(op.after.comment !== op.before.comment ? [`comment → "${op.after.comment}"`] : []),
    ...(op.after.started !== undefined
      ? [`moved to ${timeInZone(parseJiraDateTime(op.after.started), timeZone)}`]
      : []),
  ];
  return `edit ${op.issueKey} worklog ${op.worklogId} ${parts.join(', ')}`;
}

export function hasMarker(worklog: OwnWorklog, plan: Plan, opId: string): boolean {
  return worklog.properties.some((property) => {
    const value = property.value as { planId?: unknown; opId?: unknown } | null;
    return (
      property.key === plan.markerKey &&
      value !== null &&
      typeof value === 'object' &&
      value.planId === plan.planId &&
      value.opId === opId
    );
  });
}

function dayIssueKeys(day: PlannedDay): string[] {
  return [
    ...new Set([
      ...day.ops.map((op) => op.issueKey),
      ...day.before.worklogs.map((worklog) => worklog.issueKey),
    ]),
  ];
}

async function fetchDay(
  client: CorrectionsClient,
  plan: Plan,
  day: PlannedDay,
): Promise<{ worklogs: OwnWorklog[]; raw: Map<string, RawWorklog> }> {
  const window = dayWindow(day.date, plan.timeZone);
  const result = await client.ownWorklogs(
    plan.accountId,
    plan.timeZone,
    {
      startMs: window.start,
      endMs: window.end,
      fromDate: addDaysToKey(day.date, -1),
      toDate: addDaysToKey(day.date, 1),
    },
    dayIssueKeys(day),
  );
  return {
    worklogs: result.worklogs.filter((worklog) => worklog.date === day.date),
    raw: result.raw,
  };
}

/** Worklogs this plan doesn't touch that have changed, gone or appeared since it was made. */
function dayDifferences(plan: Plan, day: PlannedDay, current: OwnWorklog[]): string[] {
  const touched = new Set(day.ops.flatMap((op) => (op.kind === 'create' ? [] : [op.worklogId])));
  const creates = day.ops.filter((op): op is CreateOp => op.kind === 'create');
  const differences: string[] = [];
  for (const before of day.before.worklogs) {
    if (touched.has(before.id)) {
      continue;
    }
    const now = current.find((worklog) => worklog.id === before.id);
    if (now === undefined) {
      differences.push(`${before.issueKey} worklog ${before.id} has gone since the plan was made`);
    } else if (now.seconds !== before.seconds || now.comment !== before.comment) {
      differences.push(
        `${before.issueKey} worklog ${before.id} has changed since the plan was made`,
      );
    }
  }
  for (const worklog of current) {
    const known = day.before.worklogs.some((before) => before.id === worklog.id);
    if (!known && !creates.some((op) => hasMarker(worklog, plan, op.opId))) {
      differences.push(
        `${worklog.issueKey} worklog ${worklog.id} (${h(worklog.seconds)}) was added since the plan was made`,
      );
    }
  }
  return differences;
}

/** Turns an error into a per-change failure, or throws Abort when it should stop the run. */
function classify(
  error: unknown,
  client: CorrectionsClient,
): { kind: ApplyFailure['kind']; reason: string; lockish: boolean } {
  if (error instanceof Conflict) {
    return { kind: 'conflict', reason: error.message, lockish: false };
  }
  if (error instanceof JiraError) {
    const reason = client.redact(error.message);
    // 401: the credentials are wrong; 5xx: Jira is struggling. Neither is about this change.
    if (error.status === 401 || error.status >= 500) {
      throw new Abort(reason);
    }
    return {
      kind: error.refused ? 'refused' : 'error',
      reason,
      lockish: error.refused && (error.looksLocked || error.status === 403),
    };
  }
  throw new Abort(client.redact(error instanceof Error ? error.message : String(error)));
}

export async function applyPlan(
  plan: Plan,
  deps: ApplyDeps,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const now = deps.now ?? (() => new Date());
  const outcomes: ApplyResult['outcomes'] = [];
  const failures: ApplyFailure[] = [];
  const dayTotals: ApplyResult['days'] = [];
  const empty = { outcomes, failures, days: dayTotals };
  if (options.approvedPlanId !== plan.planId) {
    return {
      status: 'refused',
      message: `This plan is ${plan.planId}; approve it with --approve ${plan.planId} after reviewing it.`,
      ...empty,
    };
  }
  const ready = plan.days.filter((day) => day.status === 'ready');
  if (ready.length === 0) {
    return { status: 'done', message: 'Nothing to apply: no day in the plan is ready.', ...empty };
  }
  const deletions = ready.flatMap((day) => day.ops.filter((op) => op.kind === 'delete'));
  if (deletions.length > 0 && !options.allowDeletions) {
    return {
      status: 'refused',
      message:
        `The plan deletes ${deletions.length} worklog(s): ` +
        deletions.map((op) => `${op.issueKey} ${op.worklogId}`).join(', ') +
        '. Approve the deletions with --allow-deletions.',
      ...empty,
    };
  }

  const log = (entry: Omit<ApplyLogEntry, 'at' | 'planId'>) =>
    deps.log({ at: now().toISOString(), planId: plan.planId, ...entry });

  let currentDay: PlannedDay | undefined;
  let currentOp: Op | undefined;
  let backupPath: string | undefined;
  try {
    // Back up every worklog on the days about to change, as Jira has them now.
    const backupDays: BackupDay[] = [];
    for (const day of ready) {
      currentDay = day;
      const { worklogs, raw } = await fetchDay(deps.client, plan, day);
      backupDays.push({
        date: day.date,
        worklogs: worklogs.flatMap((worklog) => {
          const item = raw.get(worklog.id);
          return item === undefined ? [] : [item];
        }),
      });
    }
    backupPath = await deps.backup({
      planId: plan.planId,
      takenAt: now().toISOString(),
      days: backupDays,
    });

    for (const day of ready) {
      currentDay = day;
      currentOp = undefined;
      const { worklogs: current } = await fetchDay(deps.client, plan, day);
      const differences = dayDifferences(plan, day, current);
      for (const difference of differences) {
        // Worth knowing, but each change below still checks its own worklog before it is made.
        log({ date: day.date, outcome: 'warning', detail: difference });
      }
      const ordered = [...day.ops].sort((a, b) => rank(a) - rank(b));
      const notMade = new Set<string>();
      for (const op of ordered) {
        currentOp = op;
        const base = {
          date: day.date,
          opId: op.opId,
          issueKey: op.issueKey,
          ...(op.kind === 'create' ? {} : { worklogId: op.worklogId }),
          action: describeOp(op, plan.timeZone),
        };
        const blockedBy =
          op.kind === 'create' ? [] : (op.requires ?? []).filter((id) => notMade.has(id));
        if (blockedBy.length > 0) {
          const reason = `not done because ${blockedBy.join(', ')} wasn't made, and doing it alone would lose time`;
          notMade.add(op.opId);
          failures.push({ ...base, kind: 'skipped', reason });
          log({ ...base, kind: op.kind, outcome: 'skipped', detail: reason });
          continue;
        }
        try {
          const added = current.find(
            (worklog) =>
              op.kind === 'create' &&
              worklog.issueKey === op.issueKey &&
              !day.before.worklogs.some((before) => before.id === worklog.id) &&
              !day.ops.some(
                (other) => other.kind === 'create' && hasMarker(worklog, plan, other.opId),
              ),
          );
          if (added !== undefined) {
            throw new Conflict(
              `${added.issueKey} worklog ${added.id} (${h(added.seconds)}) was added since the plan was made, ` +
                "so this one isn't added in case it is the same time; check that day",
            );
          }
          const outcome = await applyOp(deps.client, plan, op, current);
          outcomes.push({ date: day.date, opId: op.opId, outcome });
          log({ ...base, kind: op.kind, outcome, detail: op.why });
        } catch (error) {
          const { kind, reason, lockish } = classify(error, deps.client);
          notMade.add(op.opId);
          failures.push({ ...base, kind, reason });
          log({ ...base, kind: op.kind, outcome: kind, detail: reason });
          if (lockish) {
            deps.lockedIssue(op.issueKey, reason);
          }
        }
      }
      currentOp = undefined;

      const { worklogs: after } = await fetchDay(deps.client, plan, day);
      const total = after.reduce((sum, worklog) => sum + worklog.seconds, 0);
      dayTotals.push({
        date: day.date,
        totalSeconds: total,
        plannedSeconds: day.after.totalSeconds,
      });
      const explained = notMade.size > 0 || differences.length > 0;
      if (total !== day.after.totalSeconds && !explained) {
        const reason = `the day came to ${h(total)}, not the ${h(day.after.totalSeconds)} planned, though every change was made`;
        failures.push({
          date: day.date,
          opId: '',
          issueKey: '',
          action: 'day total',
          kind: 'conflict',
          reason,
        });
        log({ date: day.date, outcome: 'conflict', detail: reason });
      } else {
        log({
          date: day.date,
          outcome: 'day-checked',
          detail:
            `Day totals ${h(total)} (planned ${h(day.after.totalSeconds)})` +
            (notMade.size > 0 ? `; ${notMade.size} change(s) not made` : ''),
        });
      }
    }
  } catch (error) {
    if (!(error instanceof Abort)) {
      throw error;
    }
    const date = currentDay?.date ?? '';
    log({
      date,
      ...(currentOp
        ? { opId: currentOp.opId, kind: currentOp.kind, issueKey: currentOp.issueKey }
        : {}),
      outcome: 'error',
      detail: error.message,
    });
    return {
      status: 'stopped',
      message:
        `Stopped on ${date}${currentOp ? ` at ${currentOp.opId}` : ''}: ${error.message}. ` +
        'Nothing after this was tried; run apply again once it is fixed.',
      ...(backupPath === undefined ? {} : { backupPath }),
      ...empty,
      stoppedAt: { date, ...(currentOp ? { opId: currentOp.opId } : {}), reason: error.message },
    };
  }

  const applied = outcomes.filter((item) => item.outcome === 'applied').length;
  const already = outcomes.length - applied;
  return {
    status: failures.length === 0 ? 'done' : 'partial',
    message:
      `Made ${applied} change(s) on ${ready.length} day(s)` +
      (already > 0 ? `; ${already} were already done` : '') +
      (failures.length > 0 ? `; ${failures.length} couldn't be made (listed below)` : '') +
      '.',
    ...(backupPath === undefined ? {} : { backupPath }),
    ...empty,
  };
}

async function applyOp(
  client: CorrectionsClient,
  plan: Plan,
  op: Op,
  current: OwnWorklog[],
): Promise<'applied' | 'already-applied'> {
  if (op.kind === 'create') {
    if (current.some((worklog) => hasMarker(worklog, plan, op.opId))) {
      return 'already-applied';
    }
    await client.addWorklog(op.issueKey, {
      started: op.started,
      seconds: op.seconds,
      comment: op.comment,
      properties: [{ key: plan.markerKey, value: { planId: plan.planId, opId: op.opId } }],
    });
    return 'applied';
  }
  const worklog = current.find((item) => item.id === op.worklogId);
  if (op.kind === 'delete') {
    if (worklog === undefined) {
      return 'already-applied';
    }
    if (worklog.seconds !== op.before.seconds || worklog.comment !== op.before.comment) {
      throw new Conflict(
        `${op.issueKey} worklog ${op.worklogId} is now ${h(worklog.seconds)} "${worklog.comment}", not as planned, so it isn't deleted`,
      );
    }
    await client.deleteWorklog(op.issueKey, op.worklogId);
    return 'applied';
  }
  if (worklog === undefined) {
    throw new Conflict(`${op.issueKey} worklog ${op.worklogId} has gone, so it can't be edited`);
  }
  const plannedStart = parseJiraDateTime(op.after.started ?? op.started);
  if (
    worklog.seconds === op.after.seconds &&
    worklog.comment === op.after.comment &&
    worklog.startedMs === plannedStart
  ) {
    return 'already-applied';
  }
  if (
    worklog.seconds !== op.before.seconds ||
    worklog.comment !== op.before.comment ||
    worklog.startedMs !== parseJiraDateTime(op.started)
  ) {
    throw new Conflict(
      `${op.issueKey} worklog ${op.worklogId} is now ${h(worklog.seconds)} "${worklog.comment}" from ${worklog.started}, not as planned, so it isn't edited`,
    );
  }
  await client.updateWorklog(op.issueKey, op.worklogId, {
    ...(op.after.seconds === op.before.seconds ? {} : { seconds: op.after.seconds }),
    ...(op.after.comment === op.before.comment ? {} : { comment: op.after.comment }),
    ...(op.after.started === undefined ? {} : { started: op.after.started }),
  });
  return 'applied';
}
