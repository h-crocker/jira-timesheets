// A timesheet report: each week as one row per ticket and a column per day, with totals, as
// Markdown (to paste or read) or CSV (for a spreadsheet). Days are in the profile time zone.

import { addDaysToKey, dateRange, mondayOfKey, shortDate, weekdayName } from './time-zone';
import type { OwnWorklog } from './types';

export interface ReportRow {
  issueKey: string;
  /** Distinct comments, in the order first seen. */
  comments: string[];
  /** Seconds per day of the week, Monday first. */
  seconds: number[];
  total: number;
}

export interface ReportWeek {
  /** The Monday. */
  weekStart: string;
  /** The week's seven dates, Monday first. */
  dates: string[];
  rows: ReportRow[];
  dayTotals: number[];
  total: number;
}

export function weeklyReport(worklogs: OwnWorklog[], from: string, to: string): ReportWeek[] {
  const weeks: ReportWeek[] = [];
  for (let monday = mondayOfKey(from); monday <= to; monday = addDaysToKey(monday, 7)) {
    const dates = dateRange(monday, addDaysToKey(monday, 6));
    const rows = new Map<string, ReportRow>();
    for (const worklog of worklogs) {
      const day = dates.indexOf(worklog.date);
      if (day === -1 || worklog.date < from || worklog.date > to) {
        continue;
      }
      const row = rows.get(worklog.issueKey) ?? {
        issueKey: worklog.issueKey,
        comments: [],
        seconds: [0, 0, 0, 0, 0, 0, 0],
        total: 0,
      };
      rows.set(worklog.issueKey, row);
      row.seconds[day] += worklog.seconds;
      row.total += worklog.seconds;
      const comment = worklog.comment.trim();
      if (comment !== '' && !row.comments.includes(comment)) {
        row.comments.push(comment);
      }
    }
    const sorted = [...rows.values()].sort((a, b) =>
      a.issueKey.localeCompare(b.issueKey, undefined, { numeric: true }),
    );
    const dayTotals = [0, 1, 2, 3, 4, 5, 6].map((day) =>
      sorted.reduce((sum, row) => sum + row.seconds[day], 0),
    );
    weeks.push({
      weekStart: monday,
      dates,
      rows: sorted,
      dayTotals,
      total: dayTotals.reduce((sum, seconds) => sum + seconds, 0),
    });
  }
  return weeks;
}

/** Decimal hours, e.g. 5400 → "1.5"; blank for none. */
export function hoursCell(seconds: number): string {
  return seconds === 0 ? '' : String(Math.round((seconds / 3600) * 100) / 100);
}

/** Weekend columns only when something is logged on them. */
function shownDays(week: ReportWeek): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((day) => day < 5 || week.dayTotals[day] > 0);
}

export function reportMarkdown(weeks: ReportWeek[]): string {
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const line = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return weeks
    .map((week) => {
      const days = shownDays(week);
      const header = [
        'Issue',
        'Description',
        ...days.map((day) => `${weekdayName(week.dates[day])} ${shortDate(week.dates[day])}`),
        'Total',
      ];
      const lines = [
        `### Week of ${shortDate(week.weekStart)} ${week.weekStart.slice(0, 4)}`,
        '',
        line(header),
        line(header.map((_, i) => (i < 2 ? '---' : '---:'))),
        ...week.rows.map((row) =>
          line([
            row.issueKey,
            row.comments.join(', '),
            ...days.map((day) => hoursCell(row.seconds[day])),
            hoursCell(row.total),
          ]),
        ),
        line([
          '**Total**',
          '',
          ...days.map((day) =>
            week.dayTotals[day] === 0 ? '' : `**${hoursCell(week.dayTotals[day])}**`,
          ),
          `**${hoursCell(week.total) || '0'}**`,
        ]),
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) || /^[=+\-@]/.test(value)
    ? // Quote, and keep spreadsheets from reading a leading = + - @ as a formula.
      `"${(/^[=+\-@]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`
    : value;
}

/** One row per week and ticket, with a fixed Mon–Sun column layout so weeks stack. */
export function reportCsv(weeks: ReportWeek[]): string {
  const header = [
    'Week starting',
    'Issue',
    'Description',
    'Mon',
    'Tue',
    'Wed',
    'Thu',
    'Fri',
    'Sat',
    'Sun',
    'Total',
  ];
  const rows = weeks.flatMap((week) => [
    ...week.rows.map((row) => [
      week.weekStart,
      row.issueKey,
      row.comments.join('; '),
      ...row.seconds.map(hoursCell),
      hoursCell(row.total),
    ]),
    [week.weekStart, 'Total', '', ...week.dayTotals.map(hoursCell), hoursCell(week.total)],
  ]);
  return [header, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\n') + '\n';
}
