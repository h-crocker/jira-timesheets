// Reads and checks a corrections file: the one-off list of changes to make to past worklogs.
// Everything is checked up front, so a typo stops the plan rather than changing the wrong thing.
// See corrections.example.json for the format.

import { addDaysToKey, assertTimeZone, parseDateKey } from './time-zone';

export interface SetChange {
  kind: 'set';
  issueKey: string;
  fromSeconds: number;
  toSeconds: number;
  /** Comment for the worklog the change creates or edits; the existing comment when missing. */
  comment?: string;
}

export interface MoveChange {
  kind: 'move';
  fromIssueKey: string;
  toIssueKey: string;
  seconds: number;
  /** What the target issue must have on the day before the move, when the file says. */
  toBeforeSeconds?: number;
  /** Comment for the moved time; the source worklog's comment when missing. */
  comment?: string;
}

export type Change = SetChange | MoveChange;

export interface DayCorrection {
  date: string;
  changes: Change[];
}

export interface CommentRewrite {
  issueKey: string;
  dates: string[];
  /** Matched against the whole comment, trimmed and ignoring case. */
  from: string;
  to: string;
}

export interface ProtectRule {
  issueKey: string;
  dates: string[];
  /** Case-insensitive regular expression; a matching comment protects the worklog on any date. */
  commentPattern?: string;
  reason: string;
}

export interface IssueTotalCheck {
  issueKey: string;
  seconds: number;
  label: string;
}

export interface DayTotalCheck {
  date: string;
  seconds: number;
  reason: string;
}

export interface CorrectionsSpec {
  name: string;
  timeZone?: string;
  expectedDaySeconds: number;
  maxDaySeconds: number;
  /** When a day has no freed time to put a new worklog in, it starts at this local time. */
  defaultStartTime: string;
  lockedIssues: Record<string, string>;
  protect: ProtectRule[];
  days: DayCorrection[];
  commentRewrites: CommentRewrite[];
  issueTotals: IssueTotalCheck[];
  dayTotals: DayTotalCheck[];
  /** The range checked for over and under hours, leave clashes and locked issues. */
  validate?: { from: string; to: string; leaveIssueKeys: string[] };
  /**
   * The sick-leave ticket. Changes to it are logged as one uninterrupted worklog per day at the end
   * of the day, after the other tickets' hours are adjusted.
   */
  sickLeave?: { issueKey: string };
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const QUARTER_HOUR = 900;

class SpecError extends Error {}

function fail(path: string, message: string): never {
  throw new SpecError(`${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function issueKey(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ISSUE_KEY.test(value.trim())) {
    fail(path, `expected an issue key like ABC-123, got ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function date(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail(path, `expected a date like 2026-06-10, got ${JSON.stringify(value)}`);
  }
  try {
    parseDateKey(value);
  } catch (error) {
    fail(path, (error as Error).message);
  }
  return value;
}

/** Dates and inclusive ranges ("2026-06-15..2026-06-19"), expanded and sorted. */
function dates(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail(path, 'expected a list of dates');
  }
  const result = new Set<string>();
  value.forEach((item, i) => {
    if (typeof item === 'string' && item.includes('..')) {
      const [from, to] = item.split('..');
      const start = date(from, `${path}[${i}]`);
      const end = date(to, `${path}[${i}]`);
      if (end < start) {
        fail(`${path}[${i}]`, 'range ends before it starts');
      }
      for (let day = start; day <= end; day = addDaysToKey(day, 1)) {
        result.add(day);
      }
    } else {
      result.add(date(item, `${path}[${i}]`));
    }
  });
  return [...result].sort();
}

/** Hours as whole seconds; only quarter hours, as Jira's UI and the table use. */
function hours(value: unknown, path: string, { positive = false } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(path, `expected a number of hours, got ${JSON.stringify(value)}`);
  }
  const seconds = Math.round(value * 3600);
  if (seconds % QUARTER_HOUR !== 0) {
    fail(path, `${value} is not a whole number of quarter hours`);
  }
  if (positive && seconds === 0) {
    fail(path, 'must be more than 0');
  }
  return seconds;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    fail(path, 'expected text');
  }
  return value;
}

function parseChanges(day: Record<string, unknown>, path: string): Change[] {
  const changes: Change[] = [];
  const set = day['set'] ?? [];
  const move = day['move'] ?? [];
  if (!Array.isArray(set) || !Array.isArray(move)) {
    fail(path, '"set" and "move" must be lists');
  }
  set.forEach((item, i) => {
    const at = `${path}.set[${i}]`;
    if (!isRecord(item)) {
      fail(at, 'expected an object');
    }
    const change: SetChange = {
      kind: 'set',
      issueKey: issueKey(item['issueKey'], `${at}.issueKey`),
      fromSeconds: hours(item['from'], `${at}.from`),
      toSeconds: hours(item['to'], `${at}.to`),
    };
    const comment = optionalString(item['comment'], `${at}.comment`);
    if (comment !== undefined) {
      change.comment = comment;
    }
    if (change.fromSeconds === change.toSeconds && comment === undefined) {
      fail(at, 'from and to are the same, so there is nothing to change');
    }
    changes.push(change);
  });
  move.forEach((item, i) => {
    const at = `${path}.move[${i}]`;
    if (!isRecord(item)) {
      fail(at, 'expected an object');
    }
    const change: MoveChange = {
      kind: 'move',
      fromIssueKey: issueKey(item['from'], `${at}.from`),
      toIssueKey: issueKey(item['to'], `${at}.to`),
      seconds: hours(item['hours'], `${at}.hours`, { positive: true }),
    };
    if (change.fromIssueKey === change.toIssueKey) {
      fail(at, 'moves time to the same issue');
    }
    if (item['toBefore'] !== undefined) {
      change.toBeforeSeconds = hours(item['toBefore'], `${at}.toBefore`);
    }
    const comment = optionalString(item['comment'], `${at}.comment`);
    if (comment !== undefined) {
      change.comment = comment;
    }
    changes.push(change);
  });
  if (changes.length === 0) {
    fail(path, 'has no changes');
  }
  const touched = changes.flatMap((change) =>
    change.kind === 'set' ? [change.issueKey] : [change.fromIssueKey, change.toIssueKey],
  );
  const repeated = touched.find((key, i) => touched.indexOf(key) !== i);
  if (repeated !== undefined) {
    fail(path, `${repeated} appears in more than one change on the same day`);
  }
  return changes;
}

/** Parses a corrections file's JSON, throwing on the first thing that is wrong with it. */
export function parseCorrections(raw: unknown): CorrectionsSpec {
  if (!isRecord(raw)) {
    fail('corrections', 'expected a JSON object');
  }
  const timeZone = optionalString(raw['timeZone'], 'timeZone');
  if (timeZone !== undefined) {
    assertTimeZone(timeZone);
  }
  const spec: CorrectionsSpec = {
    name: optionalString(raw['name'], 'name') ?? 'Corrections',
    ...(timeZone === undefined ? {} : { timeZone }),
    expectedDaySeconds: hours(raw['expectedDayHours'] ?? 7.5, 'expectedDayHours', {
      positive: true,
    }),
    maxDaySeconds: hours(raw['maxDayHours'] ?? 7.5, 'maxDayHours', { positive: true }),
    defaultStartTime: optionalString(raw['defaultStartTime'], 'defaultStartTime') ?? '09:00',
    lockedIssues: {},
    protect: [],
    days: [],
    commentRewrites: [],
    issueTotals: [],
    dayTotals: [],
  };
  if (!/^\d{2}:\d{2}$/.test(spec.defaultStartTime)) {
    fail('defaultStartTime', 'expected a time like 09:00');
  }

  const locked = raw['lockedIssues'] ?? {};
  if (Array.isArray(locked)) {
    locked.forEach((key, i) => {
      spec.lockedIssues[issueKey(key, `lockedIssues[${i}]`)] =
        'Listed as locked in the corrections file';
    });
  } else if (isRecord(locked)) {
    for (const [key, reason] of Object.entries(locked)) {
      spec.lockedIssues[issueKey(key, 'lockedIssues')] =
        optionalString(reason, `lockedIssues.${key}`) ?? 'Listed as locked';
    }
  } else {
    fail('lockedIssues', 'expected a list of issue keys or an object of key: reason');
  }

  const protect = raw['protect'] ?? [];
  if (!Array.isArray(protect)) {
    fail('protect', 'expected a list');
  }
  protect.forEach((item, i) => {
    const at = `protect[${i}]`;
    if (!isRecord(item)) {
      fail(at, 'expected an object');
    }
    const pattern = optionalString(item['commentPattern'], `${at}.commentPattern`);
    if (pattern !== undefined) {
      try {
        new RegExp(pattern, 'i');
      } catch {
        fail(`${at}.commentPattern`, 'is not a valid regular expression');
      }
    }
    const rule: ProtectRule = {
      issueKey: issueKey(item['issueKey'], `${at}.issueKey`),
      dates: item['dates'] === undefined ? [] : dates(item['dates'], `${at}.dates`),
      reason: optionalString(item['reason'], `${at}.reason`) ?? 'Protected',
    };
    if (pattern !== undefined) {
      rule.commentPattern = pattern;
    }
    if (rule.dates.length === 0 && rule.commentPattern === undefined) {
      fail(at, 'needs dates or a commentPattern');
    }
    spec.protect.push(rule);
  });

  const days = raw['days'] ?? [];
  if (!Array.isArray(days)) {
    fail('days', 'expected a list');
  }
  const seen = new Set<string>();
  days.forEach((item, i) => {
    const at = `days[${i}]`;
    if (!isRecord(item)) {
      fail(at, 'expected an object');
    }
    const day = date(item['date'], `${at}.date`);
    if (seen.has(day)) {
      fail(at, `${day} is listed twice`);
    }
    seen.add(day);
    spec.days.push({ date: day, changes: parseChanges(item, `${at} (${day})`) });
  });
  spec.days.sort((a, b) => a.date.localeCompare(b.date));

  const rewrites = raw['commentRewrites'] ?? [];
  if (!Array.isArray(rewrites)) {
    fail('commentRewrites', 'expected a list');
  }
  rewrites.forEach((item, i) => {
    const at = `commentRewrites[${i}]`;
    if (!isRecord(item)) {
      fail(at, 'expected an object');
    }
    const from = optionalString(item['from'], `${at}.from`);
    const to = optionalString(item['to'], `${at}.to`);
    if (from === undefined || from.trim() === '' || to === undefined || to.trim() === '') {
      fail(at, 'needs "from" and "to" comments');
    }
    spec.commentRewrites.push({
      issueKey: issueKey(item['issueKey'], `${at}.issueKey`),
      dates: dates(item['dates'], `${at}.dates`),
      from: from.trim(),
      to: to.trim(),
    });
  });

  const checks = raw['checks'] ?? {};
  if (!isRecord(checks)) {
    fail('checks', 'expected an object');
  }
  const issueTotals = checks['issueTotals'] ?? [];
  const dayTotals = checks['dayTotals'] ?? [];
  if (!Array.isArray(issueTotals) || !Array.isArray(dayTotals)) {
    fail('checks', '"issueTotals" and "dayTotals" must be lists');
  }
  issueTotals.forEach((item, i) => {
    const at = `checks.issueTotals[${i}]`;
    if (!isRecord(item)) {
      fail(at, 'expected an object');
    }
    const key = issueKey(item['issueKey'], `${at}.issueKey`);
    spec.issueTotals.push({
      issueKey: key,
      seconds: hours(item['hours'], `${at}.hours`),
      label: optionalString(item['label'], `${at}.label`) ?? key,
    });
  });
  dayTotals.forEach((item, i) => {
    const at = `checks.dayTotals[${i}]`;
    if (!isRecord(item)) {
      fail(at, 'expected an object');
    }
    spec.dayTotals.push({
      date: date(item['date'], `${at}.date`),
      seconds: hours(item['hours'], `${at}.hours`),
      reason: optionalString(item['reason'], `${at}.reason`) ?? '',
    });
  });

  const sickLeave = raw['sickLeave'];
  if (sickLeave !== undefined) {
    if (!isRecord(sickLeave)) {
      fail('sickLeave', 'expected an object like { "issueKey": "ABC-1" }');
    }
    spec.sickLeave = { issueKey: issueKey(sickLeave['issueKey'], 'sickLeave.issueKey') };
  }

  const validate = raw['validate'];
  if (validate !== undefined) {
    if (!isRecord(validate)) {
      fail('validate', 'expected an object');
    }
    const leave = validate['leaveIssueKeys'] ?? [];
    if (!Array.isArray(leave)) {
      fail('validate.leaveIssueKeys', 'expected a list');
    }
    spec.validate = {
      from: date(validate['from'], 'validate.from'),
      to: date(validate['to'], 'validate.to'),
      leaveIssueKeys: leave.map((key, i) => issueKey(key, `validate.leaveIssueKeys[${i}]`)),
    };
  }

  for (const day of spec.days) {
    for (const change of day.changes) {
      const keys =
        change.kind === 'set' ? [change.issueKey] : [change.fromIssueKey, change.toIssueKey];
      for (const key of keys) {
        if (key in spec.lockedIssues) {
          fail(`days (${day.date})`, `changes ${key}, which is listed as locked`);
        }
      }
    }
  }
  return spec;
}

/** The first and last date the corrections touch or check. */
export function correctionsRange(spec: CorrectionsSpec): { from: string; to: string } {
  const all = [
    ...spec.days.map((day) => day.date),
    ...spec.commentRewrites.flatMap((rewrite) => rewrite.dates),
    ...spec.dayTotals.map((check) => check.date),
    ...(spec.validate === undefined ? [] : [spec.validate.from, spec.validate.to]),
  ].sort();
  if (all.length === 0) {
    throw new SpecError('The corrections file has no days');
  }
  return { from: all[0], to: all[all.length - 1] };
}
