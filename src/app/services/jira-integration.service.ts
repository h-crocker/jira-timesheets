import { Injectable, InjectionToken, inject } from '@angular/core';
import { createCloudClient, type CloudClient } from 'jira.js';
import type { Worklog } from 'jira.js/cloud';
import type { JiraWorklog } from '../models/domain';
import { SettingsService } from './settings.service';

const DEFAULT_HOST = 'http://localhost:3000';
const PAGE_SIZE = 50;
// ADF nodes whose children are inline text rather than blocks.
const INLINE_PARENTS = new Set<unknown>(['paragraph', 'heading', 'codeBlock']);

/**
 * Base URL of the dev-server relay to Jira (proxy.conf.mjs), or null to call Jira directly.
 * Browsers can't call Jira Cloud directly because it sends no CORS headers.
 */
export const JIRA_RELAY_URL = new InjectionToken<string | null>('JIRA_RELAY_URL', {
  factory: () => null,
});

function siteOrigin(host: string | undefined): string {
  const trimmed = host?.trim() ?? '';
  if (trimmed === '') {
    return DEFAULT_HOST;
  }
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
      .origin;
  } catch {
    return trimmed;
  }
}

/** Jira wants yyyy-MM-dd'T'HH:mm:ss.SSSZ (2026-09-28T09:00:00.000+0000), not a trailing "Z". */
function jiraDateTime(date: Date): string {
  return date.toISOString().replace(/Z$/, '+0000');
}

function jqlDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

@Injectable({ providedIn: 'root' })
export class JiraIntegrationService {
  private readonly relayUrl = inject(JIRA_RELAY_URL);
  private client: CloudClient | null = null;
  private clientKey: string | null = null;

  constructor(private readonly settingsService: SettingsService) {}

  /**
   * The current user's worklogs started in [from, to). Issues are found by searching for the
   * user's worklogs, plus `issueKeys`, since search results can lag behind worklogs just written.
   */
  async fetchMyWorklogs(from: Date, to: Date, issueKeys: string[] = []): Promise<JiraWorklog[]> {
    const client = this.getClient();
    const [{ accountId }, found] = await Promise.all([
      client.myself.getCurrentUser(),
      this.findIssuesWithMyWorklogs(from, to),
    ]);
    if (accountId === undefined) {
      throw new Error('Jira did not identify the current user');
    }
    const keys = [...new Set([...found, ...issueKeys])];
    const results = await Promise.all(
      keys.map((key) => this.fetchIssueWorklogs(key, from, to, accountId)),
    );
    return results.flat();
  }

  async createWorklog(
    issueKey: string,
    started: string,
    timeSpentSeconds: number,
    comment?: string,
  ): Promise<JiraWorklog> {
    const client = this.getClient();
    const created = await client.issueWorklogs.addWorklog({
      issueIdOrKey: issueKey,
      started: jiraDateTime(new Date(started)),
      timeSpentSeconds,
      ...(comment === undefined ? {} : { comment }),
    });
    return this.toJiraWorklog(issueKey, created);
  }

  async deleteWorklog(issueKey: string, worklogId: string): Promise<void> {
    const client = this.getClient();
    await client.issueWorklogs.deleteWorklog({ issueIdOrKey: issueKey, id: worklogId });
  }

  refreshClient(): void {
    this.client = null;
    this.clientKey = null;
  }

  private async findIssuesWithMyWorklogs(from: Date, to: Date): Promise<string[]> {
    const client = this.getClient();
    // JQL dates are days in the Jira profile's time zone, so search a day either side; the
    // `started` window in fetchIssueWorklogs makes the exact cut.
    const jql =
      `worklogAuthor = currentUser() AND worklogDate >= "${jqlDate(addDays(from, -1))}"` +
      ` AND worklogDate <= "${jqlDate(addDays(to, 1))}"`;
    const keys: string[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await client.issueSearch.searchAndReconsileIssuesUsingJql({
        jql,
        fields: ['summary'],
        maxResults: PAGE_SIZE,
        nextPageToken,
      });
      const issues = page.issues ?? [];
      for (const issue of issues) {
        if (issue.key !== undefined) {
          keys.push(issue.key);
        }
      }
      nextPageToken =
        page.isLast !== true && issues.length > 0 ? (page.nextPageToken ?? undefined) : undefined;
    } while (nextPageToken !== undefined);
    return keys;
  }

  private async fetchIssueWorklogs(
    issueKey: string,
    from: Date,
    to: Date,
    accountId: string,
  ): Promise<JiraWorklog[]> {
    const client = this.getClient();
    const worklogs: JiraWorklog[] = [];
    let startAt = 0;
    for (;;) {
      const page = await client.issueWorklogs.getIssueWorklog({
        issueIdOrKey: issueKey,
        startAt,
        maxResults: PAGE_SIZE,
        startedAfter: from.getTime(),
        startedBefore: to.getTime(),
      });
      const items = page.worklogs ?? [];
      for (const item of items) {
        // Issues are shared: colleagues' time must not count as ours, let alone be deleted.
        if (item.author?.accountId === accountId) {
          worklogs.push(this.toJiraWorklog(issueKey, item));
        }
      }
      const total = page.total ?? startAt + items.length;
      startAt += items.length;
      if (items.length === 0 || startAt >= total) {
        return worklogs;
      }
    }
  }

  private getClient(): CloudClient {
    const credentials = this.settingsService.credentials();
    const site = siteOrigin(credentials?.host);
    const key = credentials === null ? 'default' : `${site}\u0000${credentials.email}`;
    if (this.client !== null && this.clientKey === key) {
      return this.client;
    }
    this.client = createCloudClient({
      host: this.relayUrl ?? site,
      ...(this.relayUrl === null ? {} : { headers: { 'X-Jira-Host': site } }),
      ...(credentials === null
        ? {}
        : {
            auth: {
              type: 'basic' as const,
              email: credentials.email,
              apiToken: credentials.apiToken,
            },
          }),
    });
    this.clientKey = key;
    return this.client;
  }

  private toJiraWorklog(issueKey: string, worklog: Worklog): JiraWorklog {
    return {
      id: worklog.id ?? '',
      issueKey,
      started: worklog.started instanceof Date ? worklog.started : new Date(worklog.started ?? 0),
      timeSpentSeconds: worklog.timeSpentSeconds ?? 0,
      comment: this.extractComment(worklog.comment),
    };
  }

  private extractComment(comment: Worklog['comment']): string | undefined {
    if (comment === undefined) {
      return undefined;
    }
    if (typeof comment === 'string') {
      return comment;
    }
    const text = this.collectText(comment).trim();
    return text === '' ? undefined : text;
  }

  /** Plain text of an Atlassian Document Format node, with blocks on separate lines. */
  private collectText(node: unknown): string {
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
    const children = Array.isArray(content) ? content.map((child) => this.collectText(child)) : [];
    return children.join(INLINE_PARENTS.has(type) ? '' : '\n');
  }
}
