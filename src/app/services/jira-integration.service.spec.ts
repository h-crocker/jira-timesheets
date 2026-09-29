import type * as http from 'node:http';
import { TestBed } from '@angular/core/testing';
import mockServer from '../../../mock-jira-server';
import { JIRA_RELAY_URL, JiraIntegrationService } from './jira-integration.service';
import { SettingsService } from './settings.service';

const { startServer, stopServer, resetMockJira } = mockServer;

const MONDAY = new Date(2026, 8, 28); // the mock seeds worklogs in this week
const NEXT_MONDAY = new Date(2026, 9, 5);

describe('JiraIntegrationService', () => {
  let server: http.Server;
  let host: string;

  beforeAll(async () => {
    server = await startServer(0);
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('mock server has no address');
    }
    host = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    await stopServer(server);
  });

  beforeEach(() => {
    localStorage.clear();
    resetMockJira();
  });

  function service(email = 'dev@example.com'): JiraIntegrationService {
    TestBed.inject(SettingsService).setCredentials({ email, apiToken: 'token', host });
    return TestBed.inject(JiraIntegrationService);
  }

  it("finds the user's worklogs for the week on any issue, and only theirs", async () => {
    const mine = await service().fetchMyWorklogs(MONDAY, NEXT_MONDAY);
    expect(mine.map((worklog) => `${worklog.issueKey} ${worklog.comment}`).sort()).toEqual([
      'GWP-2070 Code review',
      'GWP-2070 Logged on Done',
      'GWP-2070 Work on feature',
      'GWP-2080 Logged on Done',
      'GWP-2080 Support ticket',
      'HR-1 Leave (morning)',
    ]);

    const theirs = await service('colleague@example.com').fetchMyWorklogs(MONDAY, NEXT_MONDAY);
    expect(theirs.map((worklog) => worklog.comment)).toEqual(["Colleague's pairing session"]);
  });

  it('returns nothing outside the requested window', async () => {
    expect(await service().fetchMyWorklogs(new Date(2026, 8, 21), MONDAY)).toEqual([]);
  });

  it("creates worklogs with Jira's date format and reads them back", async () => {
    const bodies: string[] = [];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST') {
        bodies.push(String(init.body));
      }
      return realFetch(input, init);
    });
    try {
      const created = await service().createWorklog(
        'GWP-3000',
        '2026-10-01T13:15:00.000Z',
        900,
        'Planning',
      );
      expect(created.started.toISOString()).toBe('2026-10-01T13:15:00.000Z');
      expect(created.comment).toBe('Planning');
      expect(JSON.parse(bodies[0]).started).toBe('2026-10-01T13:15:00.000+0000');
    } finally {
      spy.mockRestore();
    }
  });

  it('marks the worklogs it creates, and reads the mark back', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST') {
        requests.push({ url: String(input), body: String(init.body) });
      }
      return realFetch(input, init);
    });
    const created = await service()
      .createWorklog('GWP-3000', '2026-10-01T13:15:00.000Z', 900, 'Plan')
      .finally(() => spy.mockRestore());
    expect(created.generated).toBe(true);
    expect(requests[0].url).toContain('/rest/api/3/issue/GWP-3000/worklog');
    expect(JSON.parse(requests[0].body).properties).toEqual([
      { key: 'jira-timesheets', value: { generated: true, version: 1 } },
    ]);

    const worklogs = await service().fetchMyWorklogs(MONDAY, NEXT_MONDAY);
    expect(worklogs.filter((worklog) => worklog.generated).map((worklog) => worklog.id)).toEqual([
      created.id,
    ]);
    // The seeded worklogs were logged some other way.
    expect(worklogs.filter((worklog) => !worklog.generated)).toHaveLength(6);
  });

  it('remembers the worklogs it replaced, per week, merging what it adds', async () => {
    const jira = service();
    expect(await jira.fetchReplaced(MONDAY)).toEqual([]);

    const first = {
      id: '1',
      issueKey: 'GWP-2080',
      started: new Date('2026-09-29T15:00:00Z'),
      timeSpentSeconds: 900,
      comment: 'Logged on Done',
      generated: false,
    };
    const { comment: _, ...second } = { ...first, id: '2' };
    await jira.saveReplaced(MONDAY, [first]);
    await jira.saveReplaced(MONDAY, [first, second]);

    expect(await jira.fetchReplaced(MONDAY)).toEqual([first, second]);
    expect(await jira.fetchReplaced(NEXT_MONDAY)).toEqual([]);
    // Another user's copies are their own.
    expect(await service('colleague@example.com').fetchReplaced(MONDAY)).toEqual([]);
  });

  it('looks up the summaries of issues that exist, leaving out keys Jira does not know', async () => {
    const summaries = await service().fetchIssueSummaries([
      'GWP-2070',
      'UTF-8',
      'GWP-2070',
      'HR-1',
    ]);
    expect([...summaries]).toEqual([
      ['GWP-2070', 'Rate limiting for the public API'],
      ['HR-1', 'Annual leave'],
    ]);
  });

  it('reads Atlassian Document Format comments as plain text', async () => {
    await fetch(`${host}/rest/api/3/issue/GWP-3000/worklog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        started: '2026-10-01T10:00:00.000+0000',
        timeSpentSeconds: 900,
        comment: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Sprint ' },
                { type: 'text', text: 'planning' },
              ],
            },
            { type: 'paragraph', content: [{ type: 'text', text: 'Notes' }] },
          ],
        },
      }),
    });
    const worklogs = await service().fetchMyWorklogs(MONDAY, NEXT_MONDAY);
    expect(worklogs.find((worklog) => worklog.issueKey === 'GWP-3000')?.comment).toBe(
      'Sprint planning\nNotes',
    );
  });

  describe('routing', () => {
    let requests: Array<{ url: string; headers: Record<string, string> }>;
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      requests = [];
      spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        requests.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
        const body = url.includes('/myself') ? { accountId: 'me' } : { issues: [], isLast: true };
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        });
      });
    });

    afterEach(() => spy.mockRestore());

    function useSite(site: string): JiraIntegrationService {
      TestBed.inject(SettingsService).setCredentials({
        email: 'me@example.com',
        apiToken: 'token',
        host: site,
      });
      return TestBed.inject(JiraIntegrationService);
    }

    it('goes through the relay, naming the Jira site in X-Jira-Host', async () => {
      TestBed.configureTestingModule({
        providers: [{ provide: JIRA_RELAY_URL, useValue: 'http://localhost:4200/jira-relay' }],
      });
      await useSite('https://example-site.atlassian.net/jira/your-work').fetchMyWorklogs(
        MONDAY,
        NEXT_MONDAY,
      );

      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.url.startsWith('http://localhost:4200/jira-relay/rest/api/3/')).toBe(true);
        expect(request.headers['X-Jira-Host']).toBe('https://example-site.atlassian.net');
        expect(request.headers['Authorization']).toMatch(/^Basic /);
      }
    });

    it('calls the site directly without a relay, adding a missing https://', async () => {
      await useSite('example-site.atlassian.net').fetchMyWorklogs(MONDAY, NEXT_MONDAY);

      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.url.startsWith('https://example-site.atlassian.net/rest/api/3/')).toBe(true);
        expect(request.headers['X-Jira-Host']).toBeUndefined();
      }
    });
  });
});
