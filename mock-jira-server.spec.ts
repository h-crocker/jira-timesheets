import * as http from 'node:http';
import {
  DashboardUserSchema,
  PageOfWorklogsSchema,
  SearchAndReconcileResultsSchema,
  WorklogSchema,
} from 'jira.js/cloud';
import server from './mock-jira-server';

const { startServer, stopServer, resetMockJira } = server;

const baseUrl = (port: number) => `http://localhost:${port}`;
const basic = (email: string) => `Basic ${Buffer.from(`${email}:any-token`).toString('base64')}`;
const DEV = { Authorization: basic('dev@example.com') };
const COLLEAGUE = { Authorization: basic('colleague@example.com') };
const JSON_HEADERS = { ...DEV, 'Content-Type': 'application/json' };

describe('mock Jira server', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = await startServer(0);
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('Server address is not available');
    }
    base = baseUrl(address.port);
  });

  afterAll(async () => {
    await stopServer(server);
  });

  beforeEach(() => resetMockJira());

  const getJson = async (path: string, headers: Record<string, string> = DEV) => {
    const response = await fetch(`${base}${path}`, { headers });
    return { response, body: await response.json() };
  };

  it('GET v3 worklogs matches the Jira Cloud shape jira.js validates against', async () => {
    const { response, body } = await getJson('/rest/api/3/issue/GWP-2070/worklog');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(PageOfWorklogsSchema.safeParse(body).error).toBeUndefined();

    expect(body.total).toBe(3);
    const devWorklog = body.worklogs.find(
      (worklog: { started: string }) => worklog.started === '2026-09-28T09:00:00.000+0000',
    );
    expect(devWorklog.timeSpent).toBe('1h 30m');
    expect(devWorklog.author.accountId).toBe('5d1f0f3c8e1a2b0c7a9d0001');
    expect(devWorklog.comment).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Work on feature' }] }],
    });
    const authors = new Set(
      body.worklogs.map(
        (worklog: { author: { emailAddress: string } }) => worklog.author.emailAddress,
      ),
    );
    expect(authors).toEqual(new Set(['dev@example.com', 'colleague@example.com']));
  });

  it('GET v2 worklogs returns plain-text comments', async () => {
    const { body } = await getJson('/rest/api/2/issue/GWP-2070/worklog');
    expect(body.worklogs.map((worklog: { comment: string }) => worklog.comment)).toContain(
      'Code review',
    );
  });

  it('filters worklogs with startedAfter (inclusive) and startedBefore (exclusive)', async () => {
    const after = Date.parse('2026-09-28T09:00:00Z');
    const before = Date.parse('2026-09-29T09:00:00Z');
    const { body } = await getJson(
      `/rest/api/3/issue/GWP-2070/worklog?startedAfter=${after}&startedBefore=${before}`,
    );
    expect(body.total).toBe(2);
    expect(body.worklogs.map((worklog: { started: string }) => worklog.started).sort()).toEqual([
      '2026-09-28T09:00:00.000+0000',
      '2026-09-28T13:00:00.000+0000',
    ]);
  });

  it('POST v2 creates a worklog for the authenticated user', async () => {
    const response = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`, {
      method: 'POST',
      headers: { ...COLLEAGUE, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        started: '2026-09-30T09:00:00.000+0100',
        timeSpentSeconds: 3600,
        comment: 'Added via test',
      }),
    });
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.started).toBe('2026-09-30T08:00:00.000+0000');
    expect(created.comment).toBe('Added via test');
    expect(created.author.emailAddress).toBe('colleague@example.com');

    const { body } = await getJson(`/rest/api/3/issue/GWP-2070/worklog/${created.id}`);
    expect(WorklogSchema.safeParse(body).error).toBeUndefined();
    expect(body.comment.content[0].content[0].text).toBe('Added via test');
  });

  it("POST rejects a started date that isn't in Jira's format", async () => {
    const response = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ started: '2026-09-30T09:00:00.000Z', timeSpentSeconds: 3600 }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(Object.keys(body.errors)).toEqual(['started']);
  });

  it('POST v3 accepts only Atlassian Document Format comments', async () => {
    const post = (comment: unknown) =>
      fetch(`${base}/rest/api/3/issue/GWP-2070/worklog`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          started: '2026-09-30T09:00:00.000+0000',
          timeSpentSeconds: 900,
          comment,
        }),
      });
    expect((await post('plain text')).status).toBe(400);
    const accepted = await post({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ADF' }] }],
    });
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).comment.content[0].content[0].text).toBe('ADF');
  });

  it('POST with an invalid body returns 400 with Jira-style errors', async () => {
    const response = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ started: 'not-a-date', timeSpentSeconds: -5 }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.errorMessages).toEqual([]);
    expect(Object.keys(body.errors).sort()).toEqual(['started', 'timeSpentSeconds']);
  });

  it("DELETE removes the caller's own worklog but refuses someone else's", async () => {
    const { body } = await getJson('/rest/api/3/issue/GWP-2070/worklog');
    const mine = body.worklogs.find(
      (worklog: { author: { emailAddress: string } }) =>
        worklog.author.emailAddress === 'dev@example.com',
    );
    const theirs = body.worklogs.find(
      (worklog: { author: { emailAddress: string } }) =>
        worklog.author.emailAddress !== 'dev@example.com',
    );

    const refused = await fetch(`${base}/rest/api/3/issue/GWP-2070/worklog/${theirs.id}`, {
      method: 'DELETE',
      headers: DEV,
    });
    expect(refused.status).toBe(403);

    const deleted = await fetch(`${base}/rest/api/3/issue/GWP-2070/worklog/${mine.id}`, {
      method: 'DELETE',
      headers: DEV,
    });
    expect(deleted.status).toBe(204);
    const deletedAgain = await fetch(`${base}/rest/api/3/issue/GWP-2070/worklog/${mine.id}`, {
      method: 'DELETE',
      headers: DEV,
    });
    expect(deletedAgain.status).toBe(404);
    expect((await deletedAgain.json()).errorMessages).toEqual(['Worklog not found']);
  });

  it('GET myself identifies the caller from their Basic credentials', async () => {
    const colleague = await getJson('/rest/api/3/myself', COLLEAGUE);
    expect(DashboardUserSchema.safeParse(colleague.body).error).toBeUndefined();
    expect(colleague.body.accountId).toBe('5d1f0f3c8e1a2b0c7a9d0002');

    const anonymous = await getJson('/rest/api/3/myself', {});
    expect(anonymous.body.emailAddress).toBe('dev@example.com');

    const malformed = await fetch(`${base}/rest/api/3/myself`, {
      headers: { Authorization: 'Basic !!!' },
    });
    expect(malformed.status).toBe(401);
  });

  it("JQL search finds issues carrying the caller's worklogs in a date range", async () => {
    const jql = encodeURIComponent(
      'worklogAuthor = currentUser() AND worklogDate >= "2026-09-28" AND worklogDate <= "2026-10-04"',
    );
    const dev = await getJson(`/rest/api/3/search/jql?jql=${jql}&fields=summary`);
    expect(SearchAndReconcileResultsSchema.safeParse(dev.body).error).toBeUndefined();
    expect(dev.body.issues.map((issue: { key: string }) => issue.key)).toEqual([
      'GWP-2070',
      'GWP-2080',
    ]);
    expect(dev.body.isLast).toBe(true);

    const colleague = await getJson(`/rest/api/3/search/jql?jql=${jql}`, COLLEAGUE);
    expect(colleague.body.issues.map((issue: { key: string }) => issue.key)).toEqual(['GWP-2070']);

    const nextWeek = encodeURIComponent(
      'worklogAuthor = currentUser() AND worklogDate >= "2026-10-05"',
    );
    expect((await getJson(`/rest/api/3/search/jql?jql=${nextWeek}`)).body.issues).toEqual([]);
  });

  it('JQL search pages with nextPageToken and rejects JQL it does not understand', async () => {
    const response = await fetch(`${base}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ jql: 'worklogAuthor = currentUser()', maxResults: 1 }),
    });
    const first = await response.json();
    expect(first.issues.map((issue: { key: string }) => issue.key)).toEqual(['GWP-2070']);
    expect(first.isLast).toBe(false);
    const second = await getJson(
      `/rest/api/3/search/jql?jql=worklogAuthor%3DcurrentUser()&maxResults=1&nextPageToken=${first.nextPageToken}`,
    );
    expect(second.body.issues.map((issue: { key: string }) => issue.key)).toEqual(['GWP-2080']);
    expect(second.body.isLast).toBe(true);

    expect((await getJson('/rest/api/3/search/jql?jql=project%20%3D%20GWP')).response.status).toBe(
      400,
    );
  });

  it('sends no CORS headers, like Jira Cloud', async () => {
    const preflight = await fetch(`${base}/rest/api/3/issue/GWP-2070/worklog`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:4200', 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    const get = await fetch(`${base}/rest/api/3/issue/GWP-2070/worklog`, {
      headers: { Origin: 'http://localhost:4200' },
    });
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('unknown routes return 404', async () => {
    const { response, body } = await getJson('/rest/api/2/issue/GWP-2070/comments');
    expect(response.status).toBe(404);
    expect(body.errorMessages).toEqual(['Not found']);
  });
});
