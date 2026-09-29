import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const http = require('node:http') as typeof import('node:http');

// A stand-in for the slice of the Jira Cloud REST API the app uses. Responses follow the Cloud
// shapes (v3 comments in Atlassian Document Format, account-id users, string `timeSpent`) so they
// pass jira.js's schemas, and requests are held to the same rules Jira documents.
//
// Deliberately sends no CORS headers: Jira Cloud doesn't either, so a page served from localhost
// can't call it directly. `npm start` relays requests through the dev server (see proxy.conf.mjs).

interface MockUser {
  accountId: string;
  emailAddress: string;
  displayName: string;
}

interface StoredWorklog {
  id: string;
  issueKey: string;
  authorId: string;
  started: Date;
  timeSpentSeconds: number;
  comment?: string;
  created: Date;
}

interface AdfNode {
  type?: unknown;
  text?: unknown;
  content?: unknown;
}

type ApiVersion = '2' | '3';

const DEV_USER: MockUser = {
  accountId: '5d1f0f3c8e1a2b0c7a9d0001',
  emailAddress: 'dev@example.com',
  displayName: 'Developer',
};

const COLLEAGUE: MockUser = {
  accountId: '5d1f0f3c8e1a2b0c7a9d0002',
  emailAddress: 'colleague@example.com',
  displayName: 'Colleague',
};

const DEFAULT_PORT = 3000;
// Page sizes when the caller doesn't ask for one.
const DEFAULT_WORKLOG_PAGE_SIZE = 5000;
const DEFAULT_SEARCH_PAGE_SIZE = 50;
// Jira documents `started` as yyyy-MM-dd'T'HH:mm:ss.SSSZ, e.g. 2026-09-28T09:00:00.000+0000.
const JIRA_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/;
const AVATAR = 'https://example.com/avatar.png';

let worklogIdCounter = 10001;
let userIdCounter = 100;
const issueIds = new Map<string, string>();
const worklogStore = new Map<string, StoredWorklog[]>();
const usersByEmail = new Map<string, MockUser>();
const usersById = new Map<string, MockUser>();
let activeServer: Server | null = null;

function issueIdFor(issueKey: string): string {
  let issueId = issueIds.get(issueKey);
  if (issueId === undefined) {
    issueId = String(10000 + issueIds.size);
    issueIds.set(issueKey, issueId);
  }
  return issueId;
}

function registerUser(user: MockUser): MockUser {
  usersByEmail.set(user.emailAddress.toLowerCase(), user);
  usersById.set(user.accountId, user);
  return user;
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

function toAdf(text: string): object {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line === '' ? [] : [{ type: 'text', text: line }],
    })),
  };
}

function adfText(node: unknown): string {
  if (node === null || typeof node !== 'object') {
    return '';
  }
  const { type, text, content } = node as AdfNode;
  if (type === 'text') {
    return typeof text === 'string' ? text : '';
  }
  const children = Array.isArray(content) ? content.map(adfText) : [];
  return children.join(type === 'doc' ? '\n' : '');
}

function isAdfDocument(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as AdfNode).type === 'doc' &&
    Array.isArray((value as AdfNode).content)
  );
}

function addWorklog(
  issueKey: string,
  author: MockUser,
  started: Date,
  timeSpentSeconds: number,
  comment?: string,
): StoredWorklog {
  issueIdFor(issueKey);
  const worklog: StoredWorklog = {
    id: String(worklogIdCounter++),
    issueKey,
    authorId: author.accountId,
    started,
    timeSpentSeconds,
    created: new Date(),
  };
  if (comment !== undefined) {
    worklog.comment = comment;
  }
  const worklogs = worklogStore.get(issueKey) ?? [];
  worklogs.push(worklog);
  worklogStore.set(issueKey, worklogs);
  return worklog;
}

function resetMockJira(): void {
  worklogIdCounter = 10001;
  userIdCounter = 100;
  issueIds.clear();
  worklogStore.clear();
  usersByEmail.clear();
  usersById.clear();
  registerUser(DEV_USER);
  registerUser(COLLEAGUE);

  addWorklog('GWP-2070', DEV_USER, new Date('2026-09-28T09:00:00Z'), 5400, 'Work on feature');
  addWorklog('GWP-2070', DEV_USER, new Date('2026-09-29T09:00:00Z'), 7200, 'Code review');
  addWorklog(
    'GWP-2070',
    COLLEAGUE,
    new Date('2026-09-28T13:00:00Z'),
    10800,
    "Colleague's pairing session",
  );
  addWorklog('GWP-2080', DEV_USER, new Date('2026-09-30T14:00:00Z'), 3600, 'Support ticket');
}

function renderUser(base: string, version: ApiVersion, user: MockUser): object {
  return {
    self: `${base}/rest/api/${version}/user?accountId=${user.accountId}`,
    accountId: user.accountId,
    emailAddress: user.emailAddress,
    avatarUrls: { '48x48': AVATAR, '24x24': AVATAR, '16x16': AVATAR, '32x32': AVATAR },
    displayName: user.displayName,
    active: true,
    timeZone: 'Etc/UTC',
    accountType: 'atlassian',
  };
}

function renderWorklog(base: string, version: ApiVersion, worklog: StoredWorklog): object {
  const issueId = issueIdFor(worklog.issueKey);
  const author = renderUser(base, version, usersById.get(worklog.authorId) ?? DEV_USER);
  return {
    self: `${base}/rest/api/${version}/issue/${issueId}/worklog/${worklog.id}`,
    author,
    updateAuthor: author,
    ...(worklog.comment === undefined
      ? {}
      : { comment: version === '3' ? toAdf(worklog.comment) : worklog.comment }),
    created: formatAtlassianDate(worklog.created),
    updated: formatAtlassianDate(worklog.created),
    started: formatAtlassianDate(worklog.started),
    timeSpent: timeSpentString(worklog.timeSpentSeconds),
    timeSpentSeconds: worklog.timeSpentSeconds,
    id: worklog.id,
    issueId,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendErrors(
  res: ServerResponse,
  status: number,
  errorMessages: string[],
  errors: Record<string, string> = {},
): void {
  sendJson(res, status, { errorMessages, errors });
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = JSON.parse(await readBody(req));
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseNonNegativeInt(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

// Callers are identified by the email in their Basic credentials; any token is accepted and unknown
// emails become new users. Requests without credentials act as the dev user, so the app works before
// it's configured.
function authenticate(req: IncomingMessage): MockUser | null {
  const header = req.headers.authorization;
  if (header === undefined) {
    return DEV_USER;
  }
  const match = header.match(/^Basic\s+(\S+)$/i);
  if (match === null) {
    return null;
  }
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0 || separator === decoded.length - 1) {
    return null;
  }
  const email = decoded.slice(0, separator);
  return (
    usersByEmail.get(email.toLowerCase()) ??
    registerUser({
      accountId: `5d1f0f3c8e1a2b0c7a9d${String(userIdCounter++).padStart(4, '0')}`,
      emailAddress: email,
      displayName: email,
    })
  );
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// The mock understands just the JQL the app sends: `worklogAuthor = currentUser()` and
// `worklogDate` comparisons joined by AND. Like Jira, each clause is matched against any worklog on
// the issue, not necessarily the same one. Dates are compared in UTC.
function parseJql(jql: string, me: MockUser): ((worklogs: StoredWorklog[]) => boolean) | null {
  const clauses = jql.replace(/\s+ORDER\s+BY\s+.*$/i, '').split(/\s+AND\s+/i);
  const predicates: Array<(worklogs: StoredWorklog[]) => boolean> = [];
  for (const clause of clauses) {
    if (/^\s*worklogAuthor\s*=\s*currentUser\(\)\s*$/i.test(clause)) {
      predicates.push((worklogs) => worklogs.some((worklog) => worklog.authorId === me.accountId));
      continue;
    }
    const dateMatch = clause.match(
      /^\s*worklogDate\s*(>=|<=|>|<|=)\s*"?(\d{4}-\d{2}-\d{2})"?\s*$/i,
    );
    if (dateMatch === null) {
      return null;
    }
    const [, operator, day] = dateMatch;
    const compare = (worklogDay: string): boolean => {
      switch (operator) {
        case '>=':
          return worklogDay >= day;
        case '<=':
          return worklogDay <= day;
        case '>':
          return worklogDay > day;
        case '<':
          return worklogDay < day;
        default:
          return worklogDay === day;
      }
    };
    predicates.push((worklogs) => worklogs.some((worklog) => compare(utcDay(worklog.started))));
  }
  return (worklogs) => predicates.every((predicate) => predicate(worklogs));
}

async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  base: string,
  me: MockUser,
): Promise<void> {
  let jql: unknown;
  let nextPageToken: unknown;
  let maxResults: unknown;
  let fields: unknown;
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body === null) {
      sendErrors(res, 400, ['Request body must be a JSON object']);
      return;
    }
    ({ jql, nextPageToken, maxResults, fields } = body);
  } else {
    jql = url.searchParams.get('jql') ?? undefined;
    nextPageToken = url.searchParams.get('nextPageToken') ?? undefined;
    maxResults = parseNonNegativeInt(url.searchParams.get('maxResults'));
    fields = url.searchParams.getAll('fields').flatMap((value) => value.split(','));
  }

  const matches = typeof jql === 'string' ? parseJql(jql, me) : null;
  if (matches === null) {
    sendErrors(res, 400, [`The mock Jira server does not understand this JQL: ${String(jql)}`]);
    return;
  }
  const keys = [...worklogStore.entries()]
    .filter(([, worklogs]) => matches(worklogs))
    .map(([key]) => key)
    .sort();
  const offset = typeof nextPageToken === 'string' ? Number(nextPageToken) || 0 : 0;
  const pageSize =
    typeof maxResults === 'number' && maxResults > 0 ? maxResults : DEFAULT_SEARCH_PAGE_SIZE;
  const page = keys.slice(offset, offset + pageSize);
  const isLast = offset + pageSize >= keys.length;
  const wantsSummary = Array.isArray(fields) && fields.includes('summary');
  sendJson(res, 200, {
    issues: page.map((key) => ({
      expand: '',
      id: issueIdFor(key),
      self: `${base}/rest/api/3/issue/${issueIdFor(key)}`,
      key,
      fields: wantsSummary ? { summary: `Summary of ${key}` } : {},
    })),
    isLast,
    ...(isLast ? {} : { nextPageToken: String(offset + pageSize) }),
  });
}

async function handleWorklogs(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  base: string,
  me: MockUser,
  version: ApiVersion,
  issueKey: string,
  worklogId: string | undefined,
): Promise<void> {
  const method = req.method ?? 'GET';
  const worklogs = worklogStore.get(issueKey) ?? [];

  if (method === 'GET' && worklogId === undefined) {
    const startedAfter = parseNonNegativeInt(url.searchParams.get('startedAfter'));
    const startedBefore = parseNonNegativeInt(url.searchParams.get('startedBefore'));
    const matching = worklogs.filter(
      (worklog) =>
        (startedAfter === undefined || worklog.started.getTime() >= startedAfter) &&
        (startedBefore === undefined || worklog.started.getTime() < startedBefore),
    );
    const startAt = parseNonNegativeInt(url.searchParams.get('startAt')) ?? 0;
    const maxResults =
      parseNonNegativeInt(url.searchParams.get('maxResults')) ?? DEFAULT_WORKLOG_PAGE_SIZE;
    sendJson(res, 200, {
      startAt,
      maxResults,
      total: matching.length,
      worklogs: matching
        .slice(startAt, startAt + maxResults)
        .map((worklog) => renderWorklog(base, version, worklog)),
    });
    return;
  }

  if (method === 'POST' && worklogId === undefined) {
    const body = await readJsonBody(req);
    if (body === null) {
      sendErrors(res, 400, ['Request body must be a JSON object']);
      return;
    }
    const errors: Record<string, string> = {};
    const { started, timeSpentSeconds, comment } = body;
    if (
      typeof started !== 'string' ||
      !JIRA_DATE_TIME.test(started) ||
      Number.isNaN(Date.parse(started))
    ) {
      errors['started'] = "Expected yyyy-MM-dd'T'HH:mm:ss.SSSZ, e.g. 2026-09-28T09:00:00.000+0000";
    }
    if (
      typeof timeSpentSeconds !== 'number' ||
      !Number.isFinite(timeSpentSeconds) ||
      timeSpentSeconds <= 0
    ) {
      errors['timeSpentSeconds'] = 'Must be a positive number of seconds';
    }
    let text: string | undefined;
    if (comment !== undefined) {
      if (version === '2' && typeof comment === 'string') {
        text = comment;
      } else if (version === '3' && isAdfDocument(comment)) {
        text = adfText(comment);
      } else {
        errors['comment'] =
          version === '3' ? 'Must be an Atlassian Document Format document' : 'Must be a string';
      }
    }
    if (Object.keys(errors).length > 0) {
      sendErrors(res, 400, [], errors);
      return;
    }
    const created = addWorklog(
      issueKey,
      me,
      new Date(started as string),
      timeSpentSeconds as number,
      text,
    );
    sendJson(res, 201, renderWorklog(base, version, created));
    return;
  }

  const index = worklogs.findIndex((worklog) => worklog.id === worklogId);
  if ((method === 'GET' || method === 'DELETE') && index === -1) {
    sendErrors(res, 404, ['Worklog not found']);
    return;
  }

  if (method === 'GET') {
    sendJson(res, 200, renderWorklog(base, version, worklogs[index]));
    return;
  }

  if (method === 'DELETE') {
    // Most users hold "Delete own worklogs" but not "Delete all worklogs".
    if (worklogs[index].authorId !== me.accountId) {
      sendErrors(res, 403, ['You do not have the permission to delete this worklog.']);
      return;
    }
    worklogs.splice(index, 1);
    res.writeHead(204);
    res.end();
    return;
  }

  sendErrors(res, 404, ['Not found']);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const base = `http://${req.headers.host ?? 'localhost'}`;
  const url = new URL(req.url ?? '/', base);
  const me = authenticate(req);
  if (me === null) {
    sendErrors(res, 401, ['Client must be authenticated to access this resource.']);
    return;
  }

  const myself = url.pathname.match(/^\/rest\/api\/([23])\/myself$/);
  if (myself !== null && req.method === 'GET') {
    sendJson(res, 200, { ...renderUser(base, myself[1] as ApiVersion, me), locale: 'en_GB' });
    return;
  }

  if (
    url.pathname === '/rest/api/3/search/jql' &&
    (req.method === 'GET' || req.method === 'POST')
  ) {
    await handleSearch(req, res, url, base, me);
    return;
  }

  const worklog = url.pathname.match(
    /^\/rest\/api\/([23])\/issue\/([^/]+)\/worklog(?:\/([^/]+))?$/,
  );
  if (worklog !== null) {
    const worklogId = worklog[3] === undefined ? undefined : decodeURIComponent(worklog[3]);
    await handleWorklogs(
      req,
      res,
      url,
      base,
      me,
      worklog[1] as ApiVersion,
      decodeURIComponent(worklog[2]),
      worklogId,
    );
    return;
  }

  sendErrors(res, 404, ['Not found']);
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
      sendErrors(res, 500, ['Internal server error']);
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

resetMockJira();

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  startServer().then((server) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : resolvePort();
    console.log(`Mock Jira server listening on http://localhost:${port}`);
  });
}

export = { startServer, stopServer, resetMockJira };
