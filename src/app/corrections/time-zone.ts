// Calendar dates and times in a named IANA time zone (e.g. Europe/London), independent of the
// machine's own zone. Jira shows a worklog on the day its `started` falls on in the user's profile
// time zone, so that is the zone corrections are planned in. A worklog started at 00:00 BST on
// 10 Jun is 23:00 UTC on 9 Jun: bucketing it by UTC (or by a machine set to UTC) moves it a day.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts['year'],
    month: parts['month'],
    day: parts['day'],
    hour: parts['hour'] === 24 ? 0 : parts['hour'],
    minute: parts['minute'],
    second: parts['second'],
  };
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** Throws unless `timeZone` is an IANA zone this runtime knows. */
export function assertTimeZone(timeZone: string): void {
  try {
    formatter(timeZone);
  } catch {
    throw new Error(`Unknown time zone "${timeZone}"`);
  }
}

/** The yyyy-mm-dd date of an instant in `timeZone`. */
export function dateKeyInZone(ms: number, timeZone: string): string {
  const { year, month, day } = zonedParts(ms, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The HH:mm wall-clock time of an instant in `timeZone`. */
export function timeInZone(ms: number, timeZone: string): string {
  const { hour, minute } = zonedParts(ms, timeZone);
  return `${pad(hour)}:${pad(minute)}`;
}

/** Minutes `timeZone` is ahead of UTC at an instant, e.g. 60 for BST. */
export function offsetMinutes(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
}

/** The instant a wall-clock time on a date happens in `timeZone`. */
export function zonedTimeToMs(dateKey: string, time: string, timeZone: string): number {
  const date = parseDateKey(dateKey);
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (match === null) {
    throw new Error(`Expected a time like 09:00, not "${time}"`);
  }
  const wall = Date.UTC(date.year, date.month - 1, date.day, Number(match[1]), Number(match[2]));
  // The offset at the guess can differ from the offset at the answer around a clock change, so
  // correct once more with the offset at the first answer.
  let ms = wall - offsetMinutes(wall, timeZone) * MINUTE_MS;
  ms = wall - offsetMinutes(ms, timeZone) * MINUTE_MS;
  return ms;
}

/** [start, end) of a calendar day in `timeZone`, as instants. */
export function dayWindow(dateKey: string, timeZone: string): { start: number; end: number } {
  return {
    start: zonedTimeToMs(dateKey, '00:00', timeZone),
    end: zonedTimeToMs(addDaysToKey(dateKey, 1), '00:00', timeZone),
  };
}

/**
 * An instant in the format Jira documents for `started`, yyyy-MM-dd'T'HH:mm:ss.SSSZ, written in
 * `timeZone` so it reads as the wall-clock time, e.g. 2026-06-10T13:45:00.000+0100.
 */
export function formatJiraStarted(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  const offset = offsetMinutes(ms, timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `.${pad(ms % 1000 < 0 ? 0 : ms % 1000, 3)}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

/**
 * Parses Jira's `started` (2026-06-10T09:00:00.000+0100, or with a colon in the offset, or a
 * trailing Z) without relying on the runtime's lenient Date parsing.
 */
export function parseJiraDateTime(value: string): number {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(
      value,
    );
  if (match === null) {
    throw new Error(`Unrecognised Jira date-time "${value}"`);
  }
  const [, y, mo, d, h, mi, s = '0', frac = '0', zone, sign, oh, om] = match;
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(frac.padEnd(3, '0')),
  );
  if (zone === 'Z') {
    return utc;
  }
  const offset = (Number(oh) * 60 + Number(om)) * (sign === '-' ? -1 : 1);
  return utc - offset * MINUTE_MS;
}

export function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) {
    throw new Error(`Expected a date like 2026-06-10, not "${dateKey}"`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`"${dateKey}" is not a real date`);
  }
  return { year, month, day };
}

export function addDaysToKey(dateKey: string, days: number): string {
  const { year, month, day } = parseDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Monday = 1 … Sunday = 7. */
export function isoWeekdayOfKey(dateKey: string): number {
  const { year, month, day } = parseDateKey(dateKey);
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

/** The Monday of the week a date falls in. */
export function mondayOfKey(dateKey: string): string {
  return addDaysToKey(dateKey, 1 - isoWeekdayOfKey(dateKey));
}

/** Every date from `from` to `to`, inclusive. */
export function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDaysToKey(date, 1)) {
    dates.push(date);
  }
  return dates;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Wed 10 Jun 2026". */
export function longDate(dateKey: string): string {
  const { year, month, day } = parseDateKey(dateKey);
  return `${WEEKDAYS[isoWeekdayOfKey(dateKey) - 1]} ${day} ${MONTHS[month - 1]} ${year}`;
}

/** "10 Jun". */
export function shortDate(dateKey: string): string {
  const { month, day } = parseDateKey(dateKey);
  return `${day} ${MONTHS[month - 1]}`;
}

export function weekdayName(dateKey: string): string {
  return WEEKDAYS[isoWeekdayOfKey(dateKey) - 1];
}
