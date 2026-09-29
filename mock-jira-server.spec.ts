import * as http from 'node:http';
import server from './mock-jira-server';

const { startServer, stopServer } = server;

const baseUrl = (port: number) => `http://localhost:${port}`;

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

  it('GET worklogs returns Atlassian-compliant shape with seeded data', async () => {
    const response = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');

    const body = await response.json();
    expect(body.startAt).toBe(0);
    expect(body.maxResults).toBe(50);
    expect(body.total).toBe(2);
    expect(body.issuetype).toEqual({ name: 'Worklog' });
    expect(Array.isArray(body.worklogs)).toBe(true);
    expect(body.worklogs).toHaveLength(2);

    for (const worklog of body.worklogs) {
      expect(typeof worklog.id).toBe('string');
      expect(typeof worklog.started).toBe('string');
      expect(typeof worklog.timeSpentSeconds).toBe('number');
    }

    const startedDates = body.worklogs.map((worklog: { started: string }) => worklog.started);
    expect(startedDates).toContain('2026-09-28T09:00:00.000+0000');
    expect(startedDates).toContain('2026-09-29T09:00:00.000+0000');
  });

  it('POST creates a worklog and increments the total', async () => {
    const before = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`);
    const beforeBody = await before.json();

    const payload = {
      started: '2026-09-30T09:00:00.000Z',
      timeSpentSeconds: 3600,
      comment: 'Added via test',
    };
    const response = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(201);

    const created = await response.json();
    expect(typeof created.id).toBe('string');
    expect(created.started).toBe('2026-09-30T09:00:00.000+0000');
    expect(created.timeSpentSeconds).toBe(3600);
    expect(created.comment).toBe('Added via test');

    const after = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`);
    const afterBody = await after.json();
    expect(afterBody.total).toBe(beforeBody.total + 1);
    expect(afterBody.worklogs.map((worklog: { id: string }) => worklog.id)).toContain(created.id);
  });

  it('DELETE removes a worklog and 404s when deleted again', async () => {
    const list = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`);
    const listBody = await list.json();
    const worklogId = listBody.worklogs[0].id;

    const deleted = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog/${worklogId}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);

    const after = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`);
    const afterBody = await after.json();
    expect(afterBody.total).toBe(listBody.total - 1);
    expect(afterBody.worklogs.map((worklog: { id: string }) => worklog.id)).not.toContain(worklogId);

    const deletedAgain = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog/${worklogId}`, {
      method: 'DELETE',
    });
    expect(deletedAgain.status).toBe(404);
    const errorBody = await deletedAgain.json();
    expect(errorBody.errorMessages).toEqual(['Worklog not found']);
  });

  it('POST with an invalid body returns 400', async () => {
    const response = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ started: 'not-a-date', timeSpentSeconds: -5 }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(Array.isArray(body.errorMessages)).toBe(true);
    expect(body.errorMessages.length).toBeGreaterThan(0);
  });

  it('sends CORS headers and answers preflight requests', async () => {
    const preflight = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:4200', 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');

    const get = await fetch(`${base}/rest/api/2/issue/GWP-2070/worklog`);
    expect(get.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('unknown routes return 404', async () => {
    const response = await fetch(`${base}/rest/api/2/issue/GWP-2070/comments`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.errorMessages).toEqual(['Not found']);
  });
});
