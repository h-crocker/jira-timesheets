import {
  type CalendarEvent,
  type JiraWorklog,
  LAST_WEEK_OF_MONTH,
  type RecurringSchedule,
  type UserSettings,
} from '../models/domain';

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

/**
 * The lunch break of one weekday of the week starting `weekStart`: `lunchMinutes` after half the
 * day's working hours, rounded to a 15-minute block. Null when there is no lunch break.
 */
export function lunchBreak(
  weekStart: Date,
  weekday: number,
  settings: UserSettings,
): Interval | null {
  if (settings.lunchMinutes <= 0 || settings.hoursPerDay <= 0) {
    return null;
  }
  const dayStart = timeOnDay(addDays(weekStart, weekday - 1), settings.startTime);
  const morningSeconds =
    Math.round((settings.hoursPerDay * 3600) / 2 / BLOCK_SECONDS) * BLOCK_SECONDS;
  const start = new Date(dayStart.getTime() + morningSeconds * 1000);
  return { start, end: new Date(start.getTime() + settings.lunchMinutes * 60000) };
}

/** One weekday's working day, from its start time to its end, lunch included. */
export function daySlot(weekStart: Date, weekday: number, settings: UserSettings): Interval {
  const start = timeOnDay(addDays(weekStart, weekday - 1), settings.startTime);
  const lunch = lunchBreak(weekStart, weekday, settings);
  const seconds = settings.hoursPerDay * 3600 + (lunch === null ? 0 : durationSeconds(lunch));
  return { start, end: new Date(start.getTime() + seconds * 1000) };
}

/** One weekday's working hours: its working day either side of the lunch break. */
export function workIntervals(
  weekStart: Date,
  weekday: number,
  settings: UserSettings,
): Interval[] {
  const lunch = lunchBreak(weekStart, weekday, settings);
  return freeGaps(daySlot(weekStart, weekday, settings), lunch === null ? [] : [lunch]);
}

/**
 * One weekday's free working time: the parts of its working hours that none of `occupied`
 * covers, from the start of the day, adding up to no more than the day's hours less everything
 * in `occupied` that starts that day. Time logged over lunch or outside working hours still
 * counts toward the day, so the day never adds up to more than its hours.
 */
export function freeWorkTime(
  weekStart: Date,
  weekday: number,
  settings: UserSettings,
  occupied: Interval[],
): Interval[] {
  const day = addDays(weekStart, weekday - 1);
  let left =
    settings.hoursPerDay * 3600 -
    occupied
      .filter((interval) => startOfDay(interval.start).getTime() === startOfDay(day).getTime())
      .reduce((sum, interval) => sum + durationSeconds(interval), 0);
  const free: Interval[] = [];
  for (const interval of workIntervals(weekStart, weekday, settings)) {
    for (const gap of freeGaps(interval, occupied)) {
      if (left <= 0) {
        return free;
      }
      const seconds = Math.min(durationSeconds(gap), left);
      free.push({ start: gap.start, end: new Date(gap.start.getTime() + seconds * 1000) });
      left -= seconds;
    }
  }
  return free;
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

/** A yyyy-mm-dd date as a local midnight, or null when it isn't one. */
export function parseDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) {
    return null;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The Monday of the week `date` falls in, at local midnight. */
export function startOfWeek(date: Date): Date {
  return addDays(startOfDay(date), 1 - isoWeekday(date));
}

/**
 * Which of its weekday in the month `date` is: 1 for the first Monday, Tuesday, …, up to 5, and
 * `LAST_WEEK_OF_MONTH` when it is the last one; a fourth that is also the last counts as both.
 */
function weekOfMonthMatches(date: Date, weekOfMonth: number): boolean {
  if (weekOfMonth === LAST_WEEK_OF_MONTH) {
    return addDays(date, 7).getMonth() !== date.getMonth();
  }
  return Math.ceil(date.getDate() / 7) === weekOfMonth;
}

/** Whether the schedule happens on `day`, which is one of its weekdays. */
export function scheduleOccursOn(schedule: RecurringSchedule, day: Date): boolean {
  switch (schedule.repeat ?? 'weekly') {
    case 'weekly':
      return true;
    case 'fortnightly': {
      const anchor = parseDateKey(schedule.anchorWeek ?? '');
      if (anchor === null) {
        return true;
      }
      const weeks = Math.round(
        (startOfWeek(day).getTime() - startOfWeek(anchor).getTime()) / (7 * 24 * 3600 * 1000),
      );
      return weeks % 2 === 0;
    }
    case 'monthly':
      return weekOfMonthMatches(day, schedule.weekOfMonth ?? 1);
  }
}

/**
 * One event per enabled schedule and scheduled work day of the week it happens in: every week,
 * every other week from its anchor week, or on the given weekday of the month. Where two events
 * overlap, only one is kept: the longer, or of equally long ones the one whose schedule comes
 * later in the list. The other is neither logged nor counted against the week's time.
 */
export function recurringEvents(weekStart: Date, settings: UserSettings): CalendarEvent[] {
  const events: (CalendarEvent & { rank: number })[] = [];
  settings.schedules.forEach((schedule, rank) => {
    if (!schedule.enabled) {
      return;
    }
    for (const weekday of schedule.weekdays) {
      if (!settings.workDays.includes(weekday)) {
        continue;
      }
      const day = addDays(weekStart, weekday - 1);
      if (!scheduleOccursOn(schedule, day)) {
        continue;
      }
      const start = timeOnDay(day, schedule.startTime);
      events.push({
        id: `${schedule.id}-weekday-${weekday}`,
        issueKey: schedule.issueKey,
        summary: schedule.summary,
        start,
        end: new Date(start.getTime() + schedule.durationSeconds * 1000),
        timeSpentSeconds: schedule.durationSeconds,
        source: 'recurring',
        rank,
      });
    }
  });

  const kept: CalendarEvent[] = [];
  for (const { rank: _rank, ...event } of [...events].sort(
    (a, b) => b.timeSpentSeconds - a.timeSpentSeconds || b.rank - a.rank,
  )) {
    if (!kept.some((other) => overlaps(other, event))) {
      kept.push(event);
    }
  }
  return kept.sort((a, b) => a.start.getTime() - b.start.getTime());
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

/** A week's key in settings and Jira properties: its Monday as a local yyyy-mm-dd date. */
export function weekKey(weekStart: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${weekStart.getFullYear()}-${pad(weekStart.getMonth() + 1)}-${pad(weekStart.getDate())}`;
}
