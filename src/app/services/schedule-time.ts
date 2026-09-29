import type { CalendarEvent, JiraWorklog, UserSettings } from '../models/domain';

/** Worklogs are planned in blocks of this many seconds. */
export const BLOCK_SECONDS = 900;

export interface Interval {
  start: Date;
  end: Date;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

export function timeOnDay(day: Date, time: string): Date {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  const result = new Date(day.getTime());
  result.setHours(hours, minutes, 0, 0);
  return result;
}

/** Monday = 1 … Sunday = 7, the numbering `workDays` and `weekdays` use. */
export function isoWeekday(date: Date): number {
  return ((date.getDay() + 6) % 7) + 1;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function sameMinute(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / 60000) === Math.floor(b.getTime() / 60000);
}

export function durationSeconds(interval: Interval): number {
  return (interval.end.getTime() - interval.start.getTime()) / 1000;
}

export function worklogInterval(worklog: JiraWorklog): Interval {
  return {
    start: worklog.started,
    end: new Date(worklog.started.getTime() + worklog.timeSpentSeconds * 1000),
  };
}

/** The working hours of one weekday of the week starting `weekStart`. */
export function daySlot(weekStart: Date, weekday: number, settings: UserSettings): Interval {
  const start = timeOnDay(addDays(weekStart, weekday - 1), settings.startTime);
  return { start, end: new Date(start.getTime() + settings.hoursPerDay * 3600 * 1000) };
}

/** The parts of `slot` that none of `occupied` covers, in order. */
export function freeGaps(slot: Interval, occupied: Interval[]): Interval[] {
  const relevant = occupied
    .map((interval) => ({
      start: new Date(Math.max(interval.start.getTime(), slot.start.getTime())),
      end: new Date(Math.min(interval.end.getTime(), slot.end.getTime())),
    }))
    .filter((interval) => interval.start < interval.end)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const gaps: Interval[] = [];
  let cursor = slot.start;
  for (const interval of relevant) {
    if (interval.start > cursor) {
      gaps.push({ start: cursor, end: interval.start });
    }
    if (interval.end > cursor) {
      cursor = interval.end;
    }
  }
  if (cursor < slot.end) {
    gaps.push({ start: cursor, end: slot.end });
  }
  return gaps;
}

/** One event per enabled schedule and scheduled work day of the week. */
export function recurringEvents(weekStart: Date, settings: UserSettings): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const schedule of settings.schedules) {
    if (!schedule.enabled) {
      continue;
    }
    for (const weekday of schedule.weekdays) {
      if (!settings.workDays.includes(weekday)) {
        continue;
      }
      const start = timeOnDay(addDays(weekStart, weekday - 1), schedule.startTime);
      events.push({
        id: `${schedule.id}-weekday-${weekday}`,
        issueKey: schedule.issueKey,
        summary: schedule.summary,
        start,
        end: new Date(start.getTime() + schedule.durationSeconds * 1000),
        timeSpentSeconds: schedule.durationSeconds,
        source: 'recurring',
      });
    }
  }
  return events;
}

/**
 * Splits recurring events into those some worklog already records (same issue, start minute and
 * duration) and those still to log. Each worklog records at most one event.
 */
export function matchRecorded(
  events: CalendarEvent[],
  worklogs: JiraWorklog[],
): { recorded: Set<string>; unrecorded: CalendarEvent[] } {
  const recorded = new Set<string>();
  const unrecorded = events.filter((event) => {
    const record = worklogs.find(
      (worklog) =>
        !recorded.has(worklog.id) &&
        worklog.issueKey === event.issueKey &&
        sameMinute(worklog.started, event.start) &&
        worklog.timeSpentSeconds === event.timeSpentSeconds,
    );
    if (record !== undefined) {
      recorded.add(record.id);
    }
    return record === undefined;
  });
  return { recorded, unrecorded };
}
