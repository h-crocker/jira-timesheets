// Checks Jira now matches an applied plan: every day's totals, each edited, deleted or created
// worklog, and the plan's totals (e.g. sick leave), from worklogs fetched afresh. Changes the apply
// log says couldn't be made are reported as such, not as surprises.

import { describeOp, hasMarker } from './apply';
import { parseJiraDateTime } from './time-zone';
import type { CreateOp, OwnWorklog, Plan } from './types';

export interface VerifyDay {
  date: string;
  /** ok: as planned. not-made: differs only by changes the log says couldn't be made. */
  status: 'ok' | 'not-made' | 'mismatch' | 'skipped';
  /** Differences nobody accounted for. */
  problems: string[];
  /** Changes the apply log says couldn't be made, with why. */
  notMade: string[];
  totalSeconds: number;
  plannedSeconds: number;
}

export interface VerifyResult {
  /** Nothing differs from the plan except changes the log says couldn't be made. */
  ok: boolean;
  days: VerifyDay[];
  totals: { label: string; ok: boolean; seconds: number; expectedSeconds: number }[];
}

const h = (seconds: number) => `${Math.round((seconds / 3600) * 100) / 100}h`;

/**
 * @param notMade The changes the apply log says couldn't be made, by op id, with why. Empty when
 * there is no log.
 */
export function verifyPlan(
  plan: Plan,
  worklogs: OwnWorklog[],
  notMade: Map<string, string> = new Map(),
): VerifyResult {
  const own = worklogs.filter((worklog) => worklog.authorAccountId === plan.accountId);
  const days: VerifyDay[] = plan.days.map((day) => {
    const current = own.filter((worklog) => worklog.date === day.date);
    const total = current.reduce((sum, worklog) => sum + worklog.seconds, 0);
    const base = { date: day.date, totalSeconds: total, plannedSeconds: day.after.totalSeconds };
    if (day.status === 'blocked') {
      return {
        ...base,
        status: 'skipped',
        problems: [],
        notMade: ['Blocked in the plan, so not applied'],
      };
    }
    const problems: string[] = [];
    const known: string[] = [];
    for (const op of day.ops) {
      const failed = notMade.get(op.opId);
      const issue = checkOp(plan, op, current);
      if (issue === null) {
        continue;
      }
      if (failed !== undefined) {
        known.push(`${describeOp(op, plan.timeZone)}: ${failed}`);
      } else {
        problems.push(`${op.opId}: ${issue}`);
      }
    }
    // Totals only mean something when every change was made.
    if (known.length === 0) {
      const totals: Record<string, number> = {};
      for (const worklog of current) {
        totals[worklog.issueKey] = (totals[worklog.issueKey] ?? 0) + worklog.seconds;
      }
      for (const key of new Set([...Object.keys(totals), ...Object.keys(day.after.byIssue)])) {
        if ((totals[key] ?? 0) !== (day.after.byIssue[key] ?? 0)) {
          problems.push(
            `${key} has ${h(totals[key] ?? 0)}, planned ${h(day.after.byIssue[key] ?? 0)}`,
          );
        }
      }
      if (total !== day.after.totalSeconds) {
        problems.push(`Day totals ${h(total)}, planned ${h(day.after.totalSeconds)}`);
      }
    }
    return {
      ...base,
      status: problems.length > 0 ? 'mismatch' : known.length > 0 ? 'not-made' : 'ok',
      problems,
      notMade: known,
    };
  });

  const totals = plan.totalChecks.map((check) => {
    const seconds = own
      .filter(
        (worklog) =>
          worklog.issueKey === check.issueKey &&
          check.dates.includes(worklog.date) &&
          !check.excludeWorklogIds.includes(worklog.id),
      )
      .reduce((sum, worklog) => sum + worklog.seconds, 0);
    return {
      label: check.label,
      ok: seconds === check.seconds,
      seconds,
      expectedSeconds: check.seconds,
    };
  });

  return {
    ok: days.every((day) => day.status !== 'mismatch') && totals.every((total) => total.ok),
    days,
    totals,
  };
}

/** What is wrong with one change in Jira now, or null when it is as planned. */
function checkOp(
  plan: Plan,
  op: Plan['days'][number]['ops'][number],
  current: OwnWorklog[],
): string | null {
  if (op.kind === 'create') {
    const created = current.filter((worklog) => hasMarker(worklog, plan, op.opId));
    if (created.length !== 1) {
      return `expected 1 new ${op.issueKey} worklog, found ${created.length}`;
    }
    return matchesCreate(created[0], op)
      ? null
      : `new ${op.issueKey} worklog ${created[0].id} isn't as planned`;
  }
  const worklog = current.find((item) => item.id === op.worklogId);
  if (op.kind === 'delete') {
    return worklog === undefined ? null : `${op.issueKey} worklog ${op.worklogId} still exists`;
  }
  if (worklog === undefined) {
    return `${op.issueKey} worklog ${op.worklogId} is missing`;
  }
  if (worklog.seconds !== op.after.seconds || worklog.comment !== op.after.comment) {
    return `${op.issueKey} worklog ${op.worklogId} is ${h(worklog.seconds)} "${worklog.comment}", planned ${h(op.after.seconds)} "${op.after.comment}"`;
  }
  if (worklog.startedMs !== parseJiraDateTime(op.started)) {
    return `${op.issueKey} worklog ${op.worklogId} start moved from ${op.started} to ${worklog.started}`;
  }
  return null;
}

function matchesCreate(worklog: OwnWorklog, op: CreateOp): boolean {
  return worklog.seconds === op.seconds && worklog.comment === op.comment.trim();
}
