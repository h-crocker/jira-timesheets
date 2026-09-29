import { Injectable, inject } from '@angular/core';
import type { ActivityEvent } from '../models/domain';
import { type MappedPullRequest, candidateIssueKeys, mapPullRequests } from './activity-mapping';
import { GithubIntegrationService, type PullRequestActivity } from './github-integration.service';
import { JiraIntegrationService } from './jira-integration.service';

export interface PullRequestsResult {
  pulls: PullRequestActivity[];
  warnings: string[];
}

export interface WeekActivity {
  /** Evidence from GitHub, on valid Jira issues or the placeholder ticket. */
  events: ActivityEvent[];
  pulls: MappedPullRequest[];
  /** Summaries of the issues Jira knows, by key. */
  summaries: Map<string, string>;
  warnings: string[];
}

export const NO_ACTIVITY: WeekActivity = {
  events: [],
  pulls: [],
  summaries: new Map(),
  warnings: [],
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

@Injectable({ providedIn: 'root' })
export class ActivityService {
  private readonly github = inject(GithubIntegrationService);
  private readonly jira = inject(JiraIntegrationService);

  /** Your pull request activity in [from, to). GitHub failing is a warning, not an error. */
  async fetchPullRequests(from: Date, to: Date): Promise<PullRequestsResult> {
    if (!this.github.isConfigured()) {
      return { pulls: [], warnings: ["GitHub isn't set up, so only Jira worklogs are used."] };
    }
    try {
      return { pulls: await this.github.fetchMyPullRequestActivity(from, to), warnings: [] };
    } catch (error) {
      return {
        pulls: [],
        warnings: [
          `Couldn't read GitHub (${errorMessage(error)}), so only Jira worklogs are used.`,
        ],
      };
    }
  }

  /**
   * Checks the keys the pull requests name against Jira and turns their activity into evidence.
   * `otherKeys` are looked up too, so the summaries cover every issue on show.
   */
  async toEvidence(
    result: PullRequestsResult,
    placeholderIssueKey: string,
    otherKeys: string[],
  ): Promise<WeekActivity> {
    const placeholder = placeholderIssueKey.trim();
    const keys = [
      ...new Set([
        ...result.pulls.flatMap(candidateIssueKeys),
        ...otherKeys,
        ...(placeholder === '' ? [] : [placeholder]),
      ]),
    ];
    const warnings = [...result.warnings];
    let summaries = new Map<string, string>();
    let validKeys: ReadonlySet<string>;
    try {
      summaries = keys.length === 0 ? summaries : await this.jira.fetchIssueSummaries(keys);
      validKeys = new Set(summaries.keys());
      if (placeholder !== '' && !summaries.has(placeholder)) {
        warnings.push(`The placeholder ticket ${placeholder} doesn't exist in Jira.`);
      }
    } catch (error) {
      // Not knowing which keys exist mustn't stop the week loading: trust the keys as named.
      validKeys = new Set(keys);
      warnings.push(
        `Couldn't check the Jira keys pull requests name (${errorMessage(error)}), so they're used as they are.`,
      );
    }
    const { events, mapped } = mapPullRequests(result.pulls, validKeys, placeholder);
    return { events, pulls: mapped, summaries, warnings };
  }
}
