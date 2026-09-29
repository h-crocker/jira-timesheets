import { Injectable, inject } from '@angular/core';
import type { ActivityKind } from '../models/domain';
import { SettingsService } from './settings.service';

const PAGE_SIZE = 100;
const MAX_IN_FLIGHT = 4;
const SEARCHES = ['author', 'reviewed-by', 'commenter'] as const;

/** Something you did on a pull request, and when. */
export interface PullRequestAction {
  id: string;
  kind: Exclude<ActivityKind, 'jira-worklog'>;
  at: Date;
}

/** A pull request you worked on during the week, with what you did on it. */
export interface PullRequestActivity {
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  body: string;
  branch: string;
  url: string;
  actions: PullRequestAction[];
}

interface SearchItem {
  number: number;
  repository_url: string;
  updated_at: string;
}

interface PullRequest {
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  merged_at: string | null;
  user: { login: string } | null;
  head: { ref: string };
}

interface Commit {
  sha: string;
  author: { login: string } | null;
  commit: { author: { date: string } | null };
}

interface Review {
  id: number;
  user: { login: string } | null;
  submitted_at?: string | null;
}

interface Comment {
  id: number;
  user: { login: string } | null;
  created_at: string;
}

function dayBefore(date: Date): string {
  const day = new Date(date);
  day.setDate(day.getDate() - 1);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function nextLink(header: string | null): string | null {
  const match = header?.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

/** Runs `task` over `items` with at most `limit` running at once, keeping the order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

@Injectable({ providedIn: 'root' })
export class GithubIntegrationService {
  private readonly settingsService = inject(SettingsService);
  private readonly cache = new Map<string, PullRequestActivity>();

  /** Whether a GitHub token has been set. */
  isConfigured(): boolean {
    return this.settingsService.githubCredentials() !== null;
  }

  /**
   * Pull requests you opened, reviewed or commented on that were updated since the day before
   * `from`, with what you did on each in [from, to). Pull requests you did nothing on in that
   * window are left out.
   */
  async fetchMyPullRequestActivity(from: Date, to: Date): Promise<PullRequestActivity[]> {
    const { login } = await this.request<{ login: string }>('/user');
    const orgs = this.settingsService
      .settings()
      .githubOrgs.map((org) => org.trim())
      .filter((org) => org !== '');
    const found = new Map<string, SearchItem>();
    for (const who of SEARCHES) {
      const query = [
        'is:pr',
        `${who}:${login}`,
        `updated:>=${dayBefore(from)}`,
        ...orgs.map((org) => `org:${org}`),
      ].join(' ');
      const items = await this.paginate<SearchItem>(
        `/search/issues?q=${encodeURIComponent(query)}&per_page=${PAGE_SIZE}`,
        (page) => (page as { items: SearchItem[] }).items,
      );
      for (const item of items) {
        found.set(`${item.repository_url}#${item.number}`, item);
      }
    }
    const pulls = await mapLimited([...found.values()], MAX_IN_FLIGHT, (item) =>
      this.pullRequestActivity(item, login, from, to),
    );
    return pulls.filter((pull) => pull.actions.length > 0);
  }

  private async pullRequestActivity(
    item: SearchItem,
    login: string,
    from: Date,
    to: Date,
  ): Promise<PullRequestActivity> {
    const repo = item.repository_url.replace(/^.*\/repos\//, '');
    const cacheKey = `${repo}#${item.number}|${item.updated_at}|${from.getTime()}|${to.getTime()}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const base = `/repos/${repo}`;
    const since = from.toISOString();
    const [pull, commits, reviews, reviewComments, comments] = await Promise.all([
      this.request<PullRequest>(`${base}/pulls/${item.number}`),
      this.paginate<Commit>(`${base}/pulls/${item.number}/commits?per_page=${PAGE_SIZE}`),
      this.paginate<Review>(`${base}/pulls/${item.number}/reviews?per_page=${PAGE_SIZE}`),
      this.paginate<Comment>(
        `${base}/pulls/${item.number}/comments?since=${since}&per_page=${PAGE_SIZE}`,
      ),
      this.paginate<Comment>(
        `${base}/issues/${item.number}/comments?since=${since}&per_page=${PAGE_SIZE}`,
      ),
    ]);

    const id = `gh:${repo}#${item.number}`;
    const actions: PullRequestAction[] = [];
    const add = (kind: PullRequestAction['kind'], key: string, at: string | null | undefined) => {
      const date = at ? new Date(at) : null;
      if (date !== null && date >= from && date < to) {
        actions.push({ id: `${id}:${kind}:${key}`, kind, at: date });
      }
    };
    if (pull.user?.login === login) {
      add('pr-opened', 'opened', pull.created_at);
      add('pr-merged', 'merged', pull.merged_at);
    }
    for (const commit of commits) {
      // The author date: a rebase rewrites the committer date.
      if (commit.author?.login === login) {
        add('commit', commit.sha, commit.commit.author?.date);
      }
    }
    for (const review of reviews) {
      if (review.user?.login === login) {
        add('review', String(review.id), review.submitted_at);
      }
    }
    for (const comment of [...reviewComments, ...comments]) {
      if (comment.user?.login === login) {
        add('comment', String(comment.id), comment.created_at);
      }
    }

    const activity: PullRequestActivity = {
      repo,
      number: item.number,
      title: pull.title,
      body: pull.body ?? '',
      branch: pull.head.ref,
      url: pull.html_url,
      actions: actions.sort((a, b) => a.at.getTime() - b.at.getTime()),
    };
    this.cache.set(cacheKey, activity);
    return activity;
  }

  private async paginate<T>(
    path: string,
    itemsOf: (page: unknown) => T[] = (page) => page as T[],
  ): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = path;
    while (url !== null) {
      const response = await this.fetch(url);
      items.push(...itemsOf(await response.json()));
      url = nextLink(response.headers.get('link'));
    }
    return items;
  }

  private async request<T>(path: string): Promise<T> {
    return (await (await this.fetch(path)).json()) as T;
  }

  private async fetch(pathOrUrl: string): Promise<Response> {
    const credentials = this.settingsService.githubCredentials();
    if (credentials === null) {
      throw new Error('GitHub is not set up');
    }
    const base = credentials.apiUrl.trim().replace(/\/+$/, '');
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${base}${pathOrUrl}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${credentials.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        message = ((await response.json()) as { message?: string }).message ?? message;
      } catch {
        // Not JSON; keep the status text.
      }
      throw new Error(`GitHub request failed: ${response.status} ${message}`);
    }
    return response;
  }
}
