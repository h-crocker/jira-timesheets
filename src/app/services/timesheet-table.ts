import type { JiraWorklog } from '../models/domain';
import { addDays, isoWeekday, startOfDay } from './schedule-time';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface TimesheetTable {
  /** For rich paste targets: Outlook, Teams, Word, Excel, Confluence. */
  html: string;
  /** A Markdown table, for plain-text paste targets. */
  text: string;
}

interface Row {
  issueKey: string;
  description: string;
  /** Seconds by day of the week, Monday first. */
  seconds: number[];
  total: number;
}

/**
 * The week's timesheet as logged in Jira, as a table: one row per issue, a column per day, and
 * totals. Weekends only appear when time is logged on them.
 */
export function timesheetTable(
  worklogs: JiraWorklog[],
  weekStart: Date,
  weekLabel: string,
): TimesheetTable {
  const monday = startOfDay(weekStart);
  const sunday = addDays(monday, 7);
  const rowsByIssue = new Map<string, Row & { summaries: Set<string> }>();
  for (const worklog of worklogs) {
    if (worklog.started < monday || worklog.started >= sunday) {
      continue;
    }
    const row = rowsByIssue.get(worklog.issueKey) ?? {
      issueKey: worklog.issueKey,
      description: '',
      seconds: [0, 0, 0, 0, 0, 0, 0],
      total: 0,
      summaries: new Set<string>(),
    };
    rowsByIssue.set(worklog.issueKey, row);
    row.seconds[isoWeekday(worklog.started) - 1] += worklog.timeSpentSeconds;
    row.total += worklog.timeSpentSeconds;
    const summary = (worklog.comment ?? '').trim();
    if (summary !== '' && summary !== worklog.issueKey) {
      row.summaries.add(summary);
    }
  }
  const rows: Row[] = [...rowsByIssue.values()]
    .map(({ summaries, ...row }) => ({ ...row, description: [...summaries].join(', ') }))
    .sort((a, b) => a.issueKey.localeCompare(b.issueKey, undefined, { numeric: true }));

  const dayTotals = DAY_NAMES.map((_, day) => rows.reduce((sum, row) => sum + row.seconds[day], 0));
  const days = DAY_NAMES.map((_, day) => day).filter((day) => day < 5 || dayTotals[day] > 0);
  const total = dayTotals.reduce((sum, seconds) => sum + seconds, 0);

  const dayHeadings = days.map((day) => {
    const date = addDays(monday, day);
    return `${DAY_NAMES[day]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  });
  const header = ['Issue', 'Description', ...dayHeadings, 'Total'];
  const body = rows.map((row) => [
    row.issueKey,
    row.description,
    ...days.map((day) => hours(row.seconds[day])),
    hours(row.total),
  ]);
  const footer = ['Total', '', ...days.map((day) => hours(dayTotals[day])), hours(total)];

  return {
    html: toHtml(`Timesheet: ${weekLabel}`, header, body, footer),
    text: toMarkdown(`Timesheet: ${weekLabel}`, header, body, footer),
  };
}

/** Decimal hours, e.g. 5400 → "1.5"; blank for none. */
function hours(seconds: number): string {
  return seconds === 0 ? '' : String(Math.round((seconds / 3600) * 100) / 100);
}

function toMarkdown(title: string, header: string[], body: string[][], footer: string[]): string {
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const line = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
  // Hour columns are right-aligned.
  const align = header.map((_, i) => (i < 2 ? '---' : '---:'));
  return [
    `**${title}**`,
    '',
    line(header),
    line(align),
    ...body.map(line),
    line(footer.map((value) => (value === '' ? value : `**${value}**`))),
  ].join('\n');
}

function toHtml(title: string, header: string[], body: string[][], footer: string[]): string {
  const border = 'border:1px solid #9aa5b1;padding:4px 8px;';
  const style = (i: number, extra = '') =>
    `${border}${i < 2 ? 'text-align:left;' : 'text-align:right;'}${extra}`;
  const row = (cells: string[], tag: 'th' | 'td', extra = '') =>
    `<tr>${cells.map((value, i) => `<${tag} style="${style(i, extra)}">${escapeHtml(value)}</${tag}>`).join('')}</tr>`;
  return [
    `<p><strong>${escapeHtml(title)}</strong></p>`,
    '<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:10pt;">',
    `<thead>${row(header, 'th', 'background:#eef2f7;')}</thead>`,
    `<tbody>${body.map((cells) => row(cells, 'td')).join('')}</tbody>`,
    `<tfoot>${row(footer, 'th', 'background:#eef2f7;')}</tfoot>`,
    '</table>',
  ].join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
