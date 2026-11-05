// Checks a range of your worklogs for things a timesheet reviewer would query: days over or under
// the expected hours, work logged on a leave day, time logged on an issue after its linked pull
// request merged, and time on issues known to be locked. It only reports; it never changes time.

import { dateKeyInZone, dateRange, isoWeekdayOfKey, shortDate } from './time-zone';
import type { Finding, LockedIssues, OwnWorklog } from './types';

export interface ValidationOptions {
  from: string;
  to: string;
  timeZone: string;
  expectedDaySeconds: number;
  /** Weekdays you work, Monday = 1. Monday to Friday when missing. */
  workDays?: number[];
  /** Issues leave is logged to. A day whose leave covers the expected hours is a leave day. */
  leaveIssueKeys: string[];
  /** Dates known to be leave, whatever is logged. */
  leaveDates?: Set<string>;
  lockedIssues: LockedIssues;
  /** The latest merge of each issue's linked pull requests. */
  mergedAt: Map<string, { mergedAtMs: number; url: string }>;
}

const hours = (seconds: number) => `${Math.round((seconds / 3600) * 100) / 100}h`;

export function validateWorklogs(worklogs: OwnWorklog[], options: ValidationOptions): Finding[] {
  const findings: Finding[] = [];
  const workDays = options.workDays ?? [1, 2, 3, 4, 5];
  const leaveKeys = new Set(options.leaveIssueKeys);
  const byDate = new Map<string, OwnWorklog[]>();
  for (const worklog of worklogs) {
    if (worklog.date >= options.from && worklog.date <= options.to) {
      byDate.set(worklog.date, [...(byDate.get(worklog.date) ?? []), worklog]);
    }
  }

  for (const date of dateRange(options.from, options.to)) {
    const day = byDate.get(date) ?? [];
    const total = day.reduce((sum, worklog) => sum + worklog.seconds, 0);
    const working = workDays.includes(isoWeekdayOfKey(date));
    const leave = day.filter((worklog) => leaveKeys.has(worklog.issueKey));
    const leaveSeconds = leave.reduce((sum, worklog) => sum + worklog.seconds, 0);
    const lockedHere = day.filter(
      (worklog) => options.lockedIssues[worklog.issueKey] !== undefined,
    );

    if (!working && total > 0) {
      findings.push({
        date,
        kind: 'weekend',
        message: `${hours(total)} logged on a non-working day`,
        worklogIds: day.map((worklog) => worklog.id),
      });
    }
    if (total > options.expectedDaySeconds) {
      const why =
        lockedHere.length > 0
          ? ` (includes ${lockedHere.map((w) => `${w.issueKey} ${hours(w.seconds)}`).join(', ')} on a locked issue)`
          : '';
      findings.push({
        date,
        kind: 'over-hours',
        message: `${hours(total)} logged, over the expected ${hours(options.expectedDaySeconds)}${why}`,
      });
    } else if (working && total < options.expectedDaySeconds) {
      findings.push({
        date,
        kind: 'under-hours',
        message:
          total === 0
            ? `nothing logged (expected ${hours(options.expectedDaySeconds)})`
            : `${hours(total)} logged, under the expected ${hours(options.expectedDaySeconds)}`,
      });
    }

    const leaveDay =
      options.leaveDates?.has(date) === true ||
      (leaveSeconds >= options.expectedDaySeconds && leaveSeconds > 0);
    const work = day.filter((worklog) => !leaveKeys.has(worklog.issueKey));
    if (leaveDay && work.length > 0) {
      findings.push({
        date,
        kind: 'work-on-leave-day',
        message: `leave day, but ${work.map((w) => `${w.issueKey} ${hours(w.seconds)}`).join(', ')} is logged`,
        worklogIds: work.map((worklog) => worklog.id),
      });
    }

    for (const worklog of lockedHere) {
      findings.push({
        date,
        kind: 'locked-issue',
        issueKey: worklog.issueKey,
        message: `${worklog.issueKey} ${hours(worklog.seconds)} is on a locked issue (${options.lockedIssues[worklog.issueKey].reason}); it can't be edited`,
        worklogIds: [worklog.id],
      });
    }
  }

  for (const worklog of worklogs) {
    if (worklog.date < options.from || worklog.date > options.to) {
      continue;
    }
    const merged = options.mergedAt.get(worklog.issueKey);
    // Same-day time is fine: a merge in the afternoon follows a morning's work.
    if (merged !== undefined && worklog.startedMs > merged.mergedAtMs) {
      const mergeDate = dateKeyInZone(merged.mergedAtMs, options.timeZone);
      if (worklog.date > mergeDate) {
        findings.push({
          date: worklog.date,
          kind: 'after-merge',
          issueKey: worklog.issueKey,
          message: `${worklog.issueKey} ${hours(worklog.seconds)} logged after its pull request merged on ${shortDate(mergeDate)} (${merged.url})`,
          worklogIds: [worklog.id],
        });
      }
    }
  }

  return findings.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}
