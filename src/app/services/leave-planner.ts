import type { JiraWorklog, UserSettings, WorklogCreation, WorklogDeletion } from '../models/domain';
import {
  type Interval,
  daySlot,
  durationSeconds,
  freeGaps,
  isoWeekday,
  overlaps,
  sameMinute,
  worklogInterval,
} from './schedule-time';

export const LEAVE_COMMENT = 'Leave';

export interface LeavePlan {
  creations: WorklogCreation[];
  deletions: WorklogDeletion[];
  /** Leave that stays in Jira or is about to be logged. */
  intervals: Interval[];
  /** Leave logged by hand, which is never touched. */
  handLogged: Interval[];
  /** Weekdays with no working time left: marked as leave, or covered by hand-logged leave. */
  offDays: Set<number>;
  /** Ids of every leave worklog, all of which this plan accounts for. */
  handled: Set<string>;
}

export interface LeaveDayState {
  /** Weekdays the app has logged leave on. */
  ticked: number[];
  /** Weekdays whose working hours are all covered by leave logged by hand. */
  locked: number[];
}

function leaveWorklogs(settings: UserSettings, worklogs: JiraWorklog[]): JiraWorklog[] {
  const key = settings.leaveIssueKey.trim();
  return key === '' ? [] : worklogs.filter((worklog) => worklog.issueKey === key);
}

function lockedDays(weekStart: Date, settings: UserSettings, handLogged: Interval[]): number[] {
  return settings.workDays
    .filter((weekday) => freeGaps(daySlot(weekStart, weekday, settings), handLogged).length === 0)
    .sort((a, b) => a - b);
}

/** Which days the week preview shows as leave, read from the leave worklogs in Jira. */
export function leaveDayState(
  weekStart: Date,
  settings: UserSettings,
  worklogs: JiraWorklog[],
): LeaveDayState {
  const leave = leaveWorklogs(settings, worklogs);
  const handLogged = leave.filter((worklog) => !worklog.generated).map(worklogInterval);
  const locked = lockedDays(weekStart, settings, handLogged);
  const ticked = settings.workDays
    .filter((weekday) => {
      const slot = daySlot(weekStart, weekday, settings);
      return (
        !locked.includes(weekday) &&
        leave.some((worklog) => worklog.generated && overlaps(worklogInterval(worklog), slot))
      );
    })
    .sort((a, b) => a - b);
  return { ticked, locked };
}

/**
 * Leave for the week: every day in `leaveDays` is filled with leave around any leave logged by
 * hand, and leave the app logged on other days is removed. Leave logged by hand always stays.
 */
export function planLeave(
  weekStart: Date,
  settings: UserSettings,
  worklogs: JiraWorklog[],
  leaveDays: number[],
): LeavePlan {
  const leave = leaveWorklogs(settings, worklogs);
  const handLogged = leave.filter((worklog) => !worklog.generated).map(worklogInterval);
  const offDays = new Set(lockedDays(weekStart, settings, handLogged));
  const wanted: Interval[] = [];
  if (settings.leaveIssueKey.trim() !== '') {
    for (const weekday of settings.workDays) {
      if (!leaveDays.includes(weekday)) {
        continue;
      }
      offDays.add(weekday);
      for (const gap of freeGaps(daySlot(weekStart, weekday, settings), handLogged)) {
        const minutes = Math.floor(durationSeconds(gap) / 60);
        if (minutes > 0) {
          wanted.push({ start: gap.start, end: new Date(gap.start.getTime() + minutes * 60000) });
        }
      }
    }
  }

  const creations: WorklogCreation[] = [];
  const deletions: WorklogDeletion[] = [];
  const kept = new Set<string>();
  for (const interval of wanted) {
    const existing = leave.find(
      (worklog) =>
        worklog.generated &&
        !kept.has(worklog.id) &&
        sameMinute(worklog.started, interval.start) &&
        worklog.timeSpentSeconds === durationSeconds(interval),
    );
    if (existing === undefined) {
      creations.push({
        issueKey: settings.leaveIssueKey.trim(),
        started: interval.start.toISOString(),
        timeSpentSeconds: durationSeconds(interval),
        comment: LEAVE_COMMENT,
        source: 'leave',
      });
    } else {
      kept.add(existing.id);
    }
  }
  for (const worklog of leave) {
    if (worklog.generated && !kept.has(worklog.id)) {
      deletions.push({
        worklogId: worklog.id,
        issueKey: worklog.issueKey,
        reason: 'stale-generated',
      });
    }
  }

  return {
    creations,
    deletions,
    intervals: [...handLogged, ...wanted],
    handLogged,
    offDays,
    handled: new Set(leave.map((worklog) => worklog.id)),
  };
}

/** Recurring events are not logged on days off, nor over leave. */
export function clashesWithLeave(event: Interval, leave: LeavePlan): boolean {
  return (
    leave.offDays.has(isoWeekday(event.start)) ||
    leave.intervals.some((interval) => overlaps(interval, event))
  );
}
