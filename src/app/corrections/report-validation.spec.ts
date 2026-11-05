import { reportCsv, reportMarkdown, weeklyReport } from './report';
import { redact } from './jira-rest-client';
import { fetchMergeTimes } from './github-merges';
import { dateKeyInZone, parseJiraDateTime } from './time-zone';
import type { OwnWorklog } from './types';
import { validateWorklogs } from './validation';

const ZONE = 'Europe/London';
let id = 1;

function wl(date: string, time: string, issueKey: string, hours: number, comment = ''): OwnWorklog {
  const started = `${date}T${time}:00.000+0100`;
  const startedMs = parseJiraDateTime(started);
  return {
    id: String(id++),
    issueKey,
    started,
    startedMs,
    date: dateKeyInZone(startedMs, ZONE),
    seconds: Math.round(hours * 3600),
    comment,
    authorAccountId: 'me',
    properties: [],
  };
}

describe('weekly report', () => {
  const worklogs = [
    wl('2026-06-22', '00:00', 'LEAVE-1', 7.5, 'Annual leave'),
    wl('2026-06-22', '10:00', 'OPS-9', 0.75, 'Incident, "follow-up"'),
    wl('2026-06-23', '00:00', 'LEAVE-1', 3.25, 'Sick leave'),
    wl('2026-06-23', '09:00', 'APP-171', 4.25, '=SUM(A1)'),
    wl('2026-06-29', '09:00', 'APP-171', 7.5),
  ];

  it('shows each week by ticket and day, in the profile zone', () => {
    const weeks = weeklyReport(worklogs, '2026-06-22', '2026-07-03');
    expect(weeks.map((week) => week.weekStart)).toEqual(['2026-06-22', '2026-06-29']);
    const mt45 = weeks[0].rows.find((row) => row.issueKey === 'LEAVE-1');
    // Midnight BST on the 18th is on Tuesday, not Monday.
    expect(mt45?.seconds.slice(0, 2)).toEqual([27000, 11700]);
    expect(weeks[0].dayTotals.slice(0, 2)).toEqual([29700, 27000]);
  });

  it('exports Markdown and CSV, quoting text safely', () => {
    const weeks = weeklyReport(worklogs, '2026-06-22', '2026-07-03');
    const markdown = reportMarkdown(weeks);
    expect(markdown).toContain('| OPS-9 | Incident, "follow-up" | 0.75 |');
    expect(markdown).toContain('**8.25**');
    const csv = reportCsv(weeks).split('\n');
    expect(csv[0]).toBe('Week starting,Issue,Description,Mon,Tue,Wed,Thu,Fri,Sat,Sun,Total');
    expect(csv).toContain('2026-06-22,OPS-9,"Incident, ""follow-up""",0.75,,,,,,,0.75');
    // A comment that looks like a formula isn't run by a spreadsheet.
    expect(csv.find((line) => line.includes('APP-171'))).toContain(`"'=SUM(A1)"`);
  });
});

describe('validation', () => {
  it('flags over and under days, work on leave days, locked tickets and work after merge', () => {
    const worklogs = [
      wl('2026-06-22', '00:00', 'LEAVE-1', 7.5, 'Annual leave'),
      wl('2026-06-22', '10:00', 'OPS-9', 0.75),
      wl('2026-06-23', '09:00', 'GWP-1', 7),
      wl('2026-06-24', '09:00', 'GWP-1', 7.5),
      wl('2026-06-25', '09:00', 'GWP-2', 7.5),
      wl('2026-06-27', '10:00', 'GWP-2', 1),
    ];
    const findings = validateWorklogs(worklogs, {
      from: '2026-06-22',
      to: '2026-06-27',
      timeZone: ZONE,
      expectedDaySeconds: 27000,
      leaveIssueKeys: ['LEAVE-1'],
      lockedIssues: { 'OPS-9': { reason: 'Locked', source: 'test' } },
      mergedAt: new Map([
        [
          'GWP-1',
          {
            mergedAtMs: Date.parse('2026-06-23T15:00:00Z'),
            url: 'https://github.com/acme/api/pull/1',
          },
        ],
      ]),
    });
    const kinds = findings.map((finding) => `${finding.date} ${finding.kind}`);
    expect(kinds).toEqual([
      '2026-06-22 locked-issue',
      '2026-06-22 over-hours',
      '2026-06-22 work-on-leave-day',
      '2026-06-23 under-hours',
      '2026-06-24 after-merge',
      '2026-06-26 under-hours',
      '2026-06-27 weekend',
    ]);
    expect(findings[1].message).toContain('OPS-9 0.75h on a locked issue');
  });
});

describe('secrets', () => {
  it('redacts the token in both forms', () => {
    const basic = btoa('dev@example.com:secret-token');
    expect(redact(`token secret-token, header Basic ${basic}`, ['secret-token', basic])).toBe(
      'token [REDACTED], header Basic [REDACTED]',
    );
  });
});

describe('GitHub merge times', () => {
  it('takes the latest merge of pull requests that name the issue', async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(decodeURIComponent(String(url)));
      return new Response(
        JSON.stringify({
          items: [
            {
              title: 'GWP-1 first part',
              html_url: 'u1',
              pull_request: { merged_at: '2026-06-15T10:00:00Z' },
            },
            {
              title: 'Fix',
              body: 'Closes GWP-1',
              html_url: 'u2',
              pull_request: { merged_at: '2026-06-17T10:00:00Z' },
            },
            {
              title: 'GWP-10 unrelated',
              html_url: 'u3',
              pull_request: { merged_at: '2026-07-07T10:00:00Z' },
            },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const merges = await fetchMergeTimes(['GWP-1'], {
      token: 't',
      apiUrl: 'https://api.github.com',
      orgs: ['acme'],
      fetch: fake,
    });
    expect(merges.get('GWP-1')).toEqual({
      mergedAtMs: Date.parse('2026-06-17T10:00:00Z'),
      url: 'u2',
    });
    expect(seen[0]).toContain('"GWP-1" is:pr is:merged org:acme');
  });
});

describe('Jira client', () => {
  it('waits and retries when Jira rate-limits, and keeps the token out of errors', async () => {
    const { JiraRestClient } = await import('./jira-rest-client');
    const statuses = [429, 429, 200];
    const waits: number[] = [];
    const fake = (async () => {
      const status = statuses.shift() ?? 500;
      return new Response(
        status === 200 ? '{"accountId":"a","displayName":"d","timeZone":"Europe/London"}' : '',
        {
          status,
          headers: status === 429 ? { 'Retry-After': '3' } : {},
        },
      );
    }) as unknown as typeof fetch;
    const client = new JiraRestClient({
      baseUrl: 'http://localhost:1',
      email: 'dev@example.com',
      apiToken: 'secret-token',
      fetch: fake,
      sleep: async (ms) => void waits.push(ms),
    });
    expect((await client.myself()).timeZone).toBe('Europe/London');
    expect(waits).toEqual([3000, 3000]);

    const echo = (async () =>
      new Response('{"errorMessages":["bad token secret-token"]}', {
        status: 401,
      })) as unknown as typeof fetch;
    const leaky = new JiraRestClient({
      baseUrl: 'http://localhost:1',
      email: 'dev@example.com',
      apiToken: 'secret-token',
      fetch: echo,
    });
    await expect(leaky.myself()).rejects.toThrow('bad token [REDACTED]');
  });
});
