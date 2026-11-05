import type { JiraWorklog } from '../models/domain';
import { timesheetTable } from './timesheet-table';

const WEEK = new Date(2026, 8, 28); // Monday

function event(issueKey: string, day: number, hours: number, comment?: string): JiraWorklog {
  return {
    id: `${issueKey}-${day}-${hours}`,
    issueKey,
    started: new Date(2026, 8, 28 + day, 9),
    timeSpentSeconds: hours * 3600,
    generated: false,
    ...(comment === undefined ? {} : { comment }),
  };
}

describe('timesheetTable', () => {
  it('sums hours per issue and day, with totals, as Markdown', () => {
    const { text } = timesheetTable(
      [
        event('GWP-10', 0, 2, 'Standup'),
        event('GWP-10', 0, 1.5, 'Review'),
        event('GWP-2', 1, 7.5),
        event('GWP-10', 4, 0.25, 'Standup'),
      ],
      WEEK,
      'Sep 28 – Oct 4',
    );
    expect(text).toBe(
      [
        '**Timesheet: Sep 28 – Oct 4**',
        '',
        '| Issue | Description | Mon 28 Sep | Tue 29 Sep | Wed 30 Sep | Thu 1 Oct | Fri 2 Oct | Total |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        '| GWP-2 |  |  | 7.5 |  |  |  | 7.5 |',
        '| GWP-10 | Standup, Review | 3.5 |  |  |  | 0.25 | 3.75 |',
        '| **Total** |  | **3.5** | **7.5** |  |  | **0.25** | **11.25** |',
      ].join('\n'),
    );
  });

  it('leaves out worklogs outside the week', () => {
    const { text } = timesheetTable([event('GWP-1', 0, 1), event('GWP-3', 7, 2)], WEEK, 'w');
    expect(text).toContain('| GWP-1 |  | 1 |  |  |  |  | 1 |');
    expect(text).not.toContain('GWP-3');
  });

  it('shows a weekend day only when time is logged on it', () => {
    const { text } = timesheetTable([event('GWP-1', 6, 1)], WEEK, 'w');
    expect(text).toContain('Sun 4 Oct');
    expect(text).not.toContain('Sat 3 Oct');
  });

  it('builds an escaped HTML table', () => {
    const { html } = timesheetTable([event('GWP-1', 0, 1, 'a <b> & "c"')], WEEK, 'w');
    expect(html).toContain('<table');
    expect(html).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
    expect(html).not.toContain('<b>');
  });

  it('escapes pipes in Markdown cells', () => {
    const { text } = timesheetTable([event('GWP-1', 0, 1, 'x | y')], WEEK, 'w');
    expect(text).toContain('x \\| y');
  });
});
