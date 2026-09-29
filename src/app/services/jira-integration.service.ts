import { Injectable } from '@angular/core';
import { createCloudClient, type CloudClient } from 'jira.js';
import type { Worklog } from 'jira.js/cloud';
import type { JiraWorklog } from '../models/domain';
import { SettingsService } from './settings.service';

const DEFAULT_HOST = 'http://localhost:3000';
const PAGE_SIZE = 50;

@Injectable({ providedIn: 'root' })
export class JiraIntegrationService {
  private client: CloudClient | null = null;
  private clientKey: string | null = null;

  constructor(private readonly settingsService: SettingsService) {}

  async fetchWorklogs(issueKey: string): Promise<JiraWorklog[]> {
    const client = this.getClient();
    const worklogs: JiraWorklog[] = [];
    let startAt = 0;
    for (;;) {
      const page = await client.issueWorklogs.getIssueWorklog({
        issueIdOrKey: issueKey,
        startAt,
        maxResults: PAGE_SIZE,
      });
      const items = page.worklogs ?? [];
      for (const item of items) {
        worklogs.push(this.toJiraWorklog(issueKey, item));
      }
      const total = page.total ?? worklogs.length;
      startAt += items.length;
      if (items.length === 0 || startAt >= total) {
        return worklogs;
      }
    }
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
      started: new Date(started),
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

  private getClient(): CloudClient {
    const credentials = this.settingsService.credentials();
    const key = credentials === null ? 'default' : `${credentials.host}\u0000${credentials.email}`;
    if (this.client !== null && this.clientKey === key) {
      return this.client;
    }
    const host =
      credentials !== null && credentials.host.trim() !== '' ? credentials.host : DEFAULT_HOST;
    this.client =
      credentials === null
        ? createCloudClient({ host })
        : createCloudClient({
            host,
            auth: { type: 'basic', email: credentials.email, apiToken: credentials.apiToken },
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
    const text = this.collectText(comment.content);
    return text === '' ? undefined : text;
  }

  private collectText(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.collectText(item)).join('');
    }
    if (value !== null && typeof value === 'object') {
      return Object.values(value).map((item) => this.collectText(item)).join('');
    }
    return '';
  }
}
