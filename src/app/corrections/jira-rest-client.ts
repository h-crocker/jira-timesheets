// A small Jira Cloud REST v3 client for the corrections commands. It calls Jira directly (from
// Node, where there is no CORS), so it never runs in the browser. It sends every worklog write
// with adjustEstimate=leave, so remaining estimates stay as they are, and notifyUsers=false, so
// watchers aren't emailed. It never sends overrideEditableFlag: a locked issue stays locked.
//
// Errors carry Jira's status and messages but never the request headers, and everything is passed
// through `redact`, so the API token can't end up in output or logs.

import { mapLimited } from '../services/map-limited';
import { dateKeyInZone, parseJiraDateTime } from './time-zone';
import type { OwnWorklog } from './types';

export const WRITE_PARAMS = { adjustEstimate: 'leave', notifyUsers: 'false' } as const;
const PAGE_SIZE = 50;
const MAX_IN_FLIGHT = 4;
const MAX_RETRIES = 4;
// ADF nodes whose children are inline text rather than blocks.
const INLINE_PARENTS = new Set<unknown>(['paragraph', 'heading', 'codeBlock']);

export interface JiraRestOptions {
  /** Site origin, e.g. https://your-site.atlassian.net, or the mock at http://localhost:3000. */
  baseUrl: string;
  email: string;
  apiToken: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface JiraMyself {
  accountId: string;
  displayName: string;
  timeZone: string;
}

/** A worklog as Jira returns it; kept whole for backups. */
export type RawWorklog = Record<string, unknown>;

export class JiraError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly errorMessages: string[],
    readonly errors: Record<string, string>,
  ) {
    const detail = [...errorMessages, ...Object.entries(errors).map(([k, v]) => `${k}: ${v}`)];
    super(`${method} ${path} → ${status}${detail.length > 0 ? `: ${detail.join('; ')}` : ''}`);
    this.name = 'JiraError';
  }

  /** Jira refused the change (as opposed to a network fault or a bug in the request). */
  get refused(): boolean {
    return this.status === 400 || this.status === 403 || this.status === 409 || this.status === 423;
  }

  /** The refusal reads like a locked issue or a closed timesheet period. */
  get looksLocked(): boolean {
    return (
      this.status === 423 ||
      (this.refused &&
        /not editable|non-editable|locked|closed|period|cannot (be )?(edit|modif|chang)|can't (edit|log)|read-only/i.test(
          this.message,
        ))
    );
  }
}

/** Replaces every secret in `text` with [REDACTED]. */
export function redact(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
}

/** Plain text as an Atlassian Document Format document, one paragraph per line. */
export function toAdf(text: string): object {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line === '' ? [] : [{ type: 'text', text: line }],
    })),
  };
}

/** Plain text of a v3 (ADF) or v2 (string) comment, with blocks on separate lines. */
export function commentText(comment: unknown): string {
  if (comment === undefined || comment === null) {
    return '';
  }
  if (typeof comment === 'string') {
    return comment.trim();
  }
  const collect = (node: unknown): string => {
    if (node === null || typeof node !== 'object') {
      return '';
    }
    const { type, text, content } = node as { type?: unknown; text?: unknown; content?: unknown };
    if (type === 'text') {
      return typeof text === 'string' ? text : '';
    }
    if (type === 'hardBreak') {
      return '\n';
    }
    const children = Array.isArray(content) ? content.map(collect) : [];
    return children.join(INLINE_PARENTS.has(type) ? '' : '\n');
  };
  return collect(comment).trim();
}

/** A raw worklog as an OwnWorklog, dated in `timeZone`. */
export function toOwnWorklog(issueKey: string, raw: RawWorklog, timeZone: string): OwnWorklog {
  const started = String(raw['started'] ?? '');
  const startedMs = parseJiraDateTime(started);
  const author = raw['author'] as { accountId?: unknown } | undefined;
  const properties = Array.isArray(raw['properties'])
    ? (raw['properties'] as { key: string; value: unknown }[])
    : [];
  return {
    id: String(raw['id'] ?? ''),
    issueKey,
    started,
    startedMs,
    date: dateKeyInZone(startedMs, timeZone),
    seconds: Number(raw['timeSpentSeconds'] ?? 0),
    comment: commentText(raw['comment']),
    authorAccountId: typeof author?.accountId === 'string' ? author.accountId : '',
    properties,
  };
}

export class JiraRestClient {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly secrets: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: JiraRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const basic = btoa(`${options.email}:${options.apiToken}`);
    this.authorization = `Basic ${basic}`;
    this.secrets = [options.apiToken, basic];
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Removes the token, in either form, from text about to be shown or logged. */
  redact(text: string): string {
    return redact(text, this.secrets);
  }

  myself(): Promise<JiraMyself> {
    return this.request<JiraMyself>('GET', '/rest/api/3/myself');
  }

  /** Keys of issues matching `jql`, following every page. */
  async searchIssueKeys(jql: string): Promise<string[]> {
    const keys: string[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<{
        issues?: { key?: string }[];
        isLast?: boolean;
        nextPageToken?: string;
      }>('GET', '/rest/api/3/search/jql', {
        jql,
        fields: 'summary',
        maxResults: String(PAGE_SIZE),
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      });
      const issues = page.issues ?? [];
      keys.push(...issues.flatMap((issue) => (issue.key === undefined ? [] : [issue.key])));
      nextPageToken =
        page.isLast !== true && issues.length > 0 ? (page.nextPageToken ?? undefined) : undefined;
    } while (nextPageToken !== undefined);
    return keys;
  }

  /** Every worklog on an issue started in [startedAfter, startedBefore), by anyone. */
  async issueWorklogs(
    issueKey: string,
    startedAfter: number,
    startedBefore: number,
  ): Promise<RawWorklog[]> {
    const worklogs: RawWorklog[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.request<{ worklogs?: RawWorklog[]; total?: number }>(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`,
        {
          startAt: String(startAt),
          maxResults: String(PAGE_SIZE),
          startedAfter: String(startedAfter),
          startedBefore: String(startedBefore),
          expand: 'properties',
        },
      );
      const items = page.worklogs ?? [];
      worklogs.push(...items);
      startAt += items.length;
      if (items.length === 0 || startAt >= (page.total ?? startAt)) {
        return worklogs;
      }
    }
  }

  /**
   * Your own worklogs started in [startMs, endMs), on any issue: issues are found by searching for
   * your worklogs a day either side (JQL dates are in the profile zone), plus `extraKeys`, since the
   * search index can lag behind worklogs just written. Raw worklogs are returned alongside.
   */
  async ownWorklogs(
    accountId: string,
    timeZone: string,
    window: { startMs: number; endMs: number; fromDate: string; toDate: string },
    extraKeys: string[] = [],
  ): Promise<{ worklogs: OwnWorklog[]; raw: Map<string, RawWorklog> }> {
    const jql =
      `worklogAuthor = currentUser() AND worklogDate >= "${window.fromDate}"` +
      ` AND worklogDate <= "${window.toDate}"`;
    const keys = [...new Set([...(await this.searchIssueKeys(jql)), ...extraKeys])].sort();
    const perIssue = await mapLimited(keys, MAX_IN_FLIGHT, async (key) => {
      try {
        return { key, worklogs: await this.issueWorklogs(key, window.startMs, window.endMs) };
      } catch (error) {
        // An extra key that doesn't exist (or you can't see) has no worklogs of yours.
        if (error instanceof JiraError && error.status === 404 && extraKeys.includes(key)) {
          return { key, worklogs: [] };
        }
        throw error;
      }
    });
    const worklogs: OwnWorklog[] = [];
    const raw = new Map<string, RawWorklog>();
    for (const { key, worklogs: items } of perIssue) {
      for (const item of items) {
        const worklog = toOwnWorklog(key, item, timeZone);
        if (worklog.authorAccountId === accountId) {
          worklogs.push(worklog);
          raw.set(worklog.id, item);
        }
      }
    }
    worklogs.sort((a, b) => a.startedMs - b.startedMs || a.id.localeCompare(b.id));
    return { worklogs, raw };
  }

  /** One worklog, or null when it no longer exists. */
  async getWorklog(issueKey: string, worklogId: string): Promise<RawWorklog | null> {
    try {
      return await this.request<RawWorklog>(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}`,
        { expand: 'properties' },
      );
    } catch (error) {
      if (error instanceof JiraError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Changes a worklog's time and/or comment. `started` is never sent, so Jira keeps the start time
   * (and so the day) exactly as it was.
   */
  updateWorklog(
    issueKey: string,
    worklogId: string,
    change: { seconds?: number; comment?: string },
  ): Promise<RawWorklog> {
    return this.request<RawWorklog>(
      'PUT',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}`,
      { ...WRITE_PARAMS, expand: 'properties' },
      {
        ...(change.seconds === undefined ? {} : { timeSpentSeconds: change.seconds }),
        ...(change.comment === undefined ? {} : { comment: toAdf(change.comment) }),
      },
    );
  }

  async deleteWorklog(issueKey: string, worklogId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}`,
      { ...WRITE_PARAMS },
    );
  }

  addWorklog(
    issueKey: string,
    worklog: {
      started: string;
      seconds: number;
      comment: string;
      properties: { key: string; value: unknown }[];
    },
  ): Promise<RawWorklog> {
    return this.request<RawWorklog>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`,
      { ...WRITE_PARAMS, expand: 'properties' },
      {
        started: worklog.started,
        timeSpentSeconds: worklog.seconds,
        ...(worklog.comment === '' ? {} : { comment: toAdf(worklog.comment) }),
        properties: worklog.properties,
      },
    );
  }

  /** Which of `permissions` you hold on an issue. */
  async myPermissions(issueKey: string, permissions: string[]): Promise<Record<string, boolean>> {
    const result = await this.request<{
      permissions?: Record<string, { havePermission?: boolean }>;
    }>('GET', '/rest/api/3/mypermissions', {
      issueKey,
      permissions: permissions.join(','),
    });
    return Object.fromEntries(
      permissions.map((key) => [key, result.permissions?.[key]?.havePermission === true]),
    );
  }

  /** How many fields you could edit on the issue now; 0 in a non-editable workflow status. */
  async editableFieldCount(issueKey: string): Promise<number> {
    const result = await this.request<{ fields?: Record<string, unknown> }>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/editmeta`,
    );
    return Object.keys(result.fields ?? {}).length;
  }

  private async send(method: string, path: string, url: URL, body: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.authorization,
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check',
          'User-Agent': 'jira-timesheets-cli',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(
        this.redact(`${method} ${path} failed: ${error instanceof Error ? error.message : error}`),
      );
    }
  }

  private async request<T>(
    method: string,
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await this.send(method, path, url, body);
      // Jira Cloud rate-limits busy clients. A 429 means the request wasn't processed, so it is
      // safe to send again, even a write.
      if (response.status !== 429 || attempt >= MAX_RETRIES) {
        break;
      }
      const retryAfter = Number(response.headers.get('Retry-After'));
      await this.sleep(
        (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      let errorMessages: string[] = [];
      let errors: Record<string, string> = {};
      try {
        const parsed = JSON.parse(text) as { errorMessages?: unknown; errors?: unknown };
        errorMessages = Array.isArray(parsed.errorMessages)
          ? parsed.errorMessages.map((m) => this.redact(String(m)))
          : [];
        errors =
          parsed.errors !== null && typeof parsed.errors === 'object'
            ? Object.fromEntries(
                Object.entries(parsed.errors as Record<string, unknown>).map(([k, v]) => [
                  k,
                  this.redact(String(v)),
                ]),
              )
            : {};
      } catch {
        if (text.trim() !== '') {
          errorMessages = [this.redact(text.trim().slice(0, 300))];
        }
      }
      throw new JiraError(method, path, response.status, errorMessages, errors);
    }
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }
}
