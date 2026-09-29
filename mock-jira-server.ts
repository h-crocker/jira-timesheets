import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const http = require('node:http') as typeof import('node:http');

interface JiraUser {
  name: string;
  displayName: string;
  avatarUrl: string;
}

interface Worklog {
  id: string;
  issueId: string;
  timeSpentString: string;
  updateAuthor: JiraUser;
  updateDate: string;
  started: string;
  author: JiraUser;
  comment?: string;
  timeSpent: number;
  timeSpentSeconds: number;
}

const DEV_USER: JiraUser = {
  name: 'dev',
  displayName: 'Developer',
  avatarUrl: 'https://example.com/avatar.png',
};

const DEFAULT_PORT = 3000;
const DEFAULT_MAX_RESULTS = 50;

let worklogIdCounter = 10001;
const issueIds = new Map<string, string>();
const worklogStore = new Map<string, Worklog[]>();
let activeServer: Server | null = null;

function issueIdFor(issueKey: string): string {
  let issueId = issueIds.get(issueKey);
  if (issueId === undefined) {
    issueId = String(10000 + issueIds.size);
    issueIds.set(issueKey, issueId);
  }
  return issueId;
}

function formatAtlassianDate(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}` +
    `.${pad(date.getUTCMilliseconds(), 3)}+0000`
  );
}

function timeSpentString(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(' ');
}

function createWorklog(
  issueKey: string,
  started: Date,
  timeSpentSeconds: number,
  comment?: string,
): Worklog {
  const worklog: Worklog = {
    id: String(worklogIdCounter++),
    issueId: issueIdFor(issueKey),
    timeSpentString: timeSpentString(timeSpentSeconds),
    updateAuthor: DEV_USER,
    updateDate: formatAtlassianDate(new Date()),
    started: formatAtlassianDate(started),
    author: DEV_USER,
    timeSpent: timeSpentSeconds,
    timeSpentSeconds,
  };
  if (comment !== undefined) {
    worklog.comment = comment;
  }
  return worklog;
}

function seedWorklogs(): void {
  const seeds: Array<{ started: Date; timeSpentSeconds: number; comment: string }> = [
    { started: new Date('2026-09-28T09:00:00Z'), timeSpentSeconds: 5400, comment: 'Work on feature' },
    { started: new Date('2026-09-29T09:00:00Z'), timeSpentSeconds: 7200, comment: 'Code review' },
  ];
  worklogStore.set(
    'GWP-2070',
    seeds.map((seed) => createWorklog('GWP-2070', seed.started, seed.timeSpentSeconds, seed.comment)),
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseNonNegativeInt(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const match = parsedUrl.pathname.match(/^\/rest\/api\/[23]\/issue\/([^/]+)\/worklog(?:\/([^/]+))?$/);
  if (match === null) {
    sendJson(res, 404, { errorMessages: ['Not found'] });
    return;
  }

  const issueKey = decodeURIComponent(match[1]);
  const worklogId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
  const method = req.method ?? 'GET';

  if (method === 'GET' && worklogId === undefined) {
    const all = worklogStore.get(issueKey) ?? [];
    const startAt = parseNonNegativeInt(parsedUrl.searchParams.get('startAt')) ?? 0;
    const maxResults = parseNonNegativeInt(parsedUrl.searchParams.get('maxResults')) ?? DEFAULT_MAX_RESULTS;
    sendJson(res, 200, {
      startAt,
      maxResults,
      total: all.length,
      issuetype: { name: 'Worklog' },
      worklogs: all.slice(startAt, startAt + maxResults),
    });
    return;
  }

  if (method === 'GET' && worklogId !== undefined) {
    const worklogs = worklogStore.get(issueKey) ?? [];
    const worklog = worklogs.find((entry) => entry.id === worklogId);
    if (worklog === undefined) {
      sendJson(res, 404, { errorMessages: ['Worklog not found'] });
      return;
    }
    sendJson(res, 200, worklog);
    return;
  }

  if (method === 'POST' && worklogId === undefined) {
    let body: { started?: unknown; timeSpentSeconds?: unknown; comment?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { errorMessages: ['Request body must be valid JSON'] });
      return;
    }

    const errors: string[] = [];
    const startedValue = body.started;
    const startedValid =
      typeof startedValue === 'string' && startedValue.length > 0 && !Number.isNaN(Date.parse(startedValue));
    if (!startedValid) {
      errors.push("'started' must be a valid ISO 8601 date");
    }
    const timeSpentValue = body.timeSpentSeconds;
    const timeSpentValid =
      typeof timeSpentValue === 'number' && Number.isFinite(timeSpentValue) && timeSpentValue > 0;
    if (!timeSpentValid) {
      errors.push("'timeSpentSeconds' must be a positive number");
    }
    if (errors.length > 0) {
      sendJson(res, 400, { errorMessages: errors });
      return;
    }

    const comment = typeof body.comment === 'string' ? body.comment : undefined;
    const worklog = createWorklog(issueKey, new Date(startedValue as string), timeSpentValue as number, comment);
    const worklogs = worklogStore.get(issueKey) ?? [];
    worklogs.push(worklog);
    worklogStore.set(issueKey, worklogs);
    sendJson(res, 201, worklog);
    return;
  }

  if (method === 'DELETE' && worklogId !== undefined) {
    const worklogs = worklogStore.get(issueKey) ?? [];
    const index = worklogs.findIndex((worklog) => worklog.id === worklogId);
    if (index === -1) {
      sendJson(res, 404, { errorMessages: ['Worklog not found'] });
      return;
    }
    worklogs.splice(index, 1);
    worklogStore.set(issueKey, worklogs);
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 404, { errorMessages: ['Not found'] });
}

function resolvePort(port?: number): number {
  if (port !== undefined) {
    return port;
  }
  const envPort = Number(process.env['PORT']);
  return Number.isInteger(envPort) && envPort >= 0 ? envPort : DEFAULT_PORT;
}

function startServer(port?: number): Promise<Server> {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      sendJson(res, 500, { errorMessages: ['Internal server error'] });
    });
  });
  activeServer = server;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(resolvePort(port), () => resolve(server));
  });
}

function stopServer(server: Server = activeServer as Server): Promise<void> {
  activeServer = null;
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

seedWorklogs();

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  startServer().then((server) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : resolvePort();
    console.log(`Mock Jira server listening on http://localhost:${port}`);
  });
}

export = { startServer, stopServer };
