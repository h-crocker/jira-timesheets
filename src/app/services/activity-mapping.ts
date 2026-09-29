import type { ActivityEvent } from '../models/domain';
import type { PullRequestActivity } from './github-integration.service';

const KEY = '[A-Z][A-Z0-9_]+-\\d+';
const LEADING_KEY = new RegExp(`^\\s*\\[?(${KEY})\\]?(?![A-Za-z0-9-])[\\s:–—-]*`);
const BROWSE_LINK = new RegExp(`/browse/(${KEY})\\b`, 'g');
const ANY_KEY = new RegExp(`\\b${KEY}\\b`, 'g');

function unique(keys: string[]): string[] {
  return [...new Set(keys)];
}

function allKeys(text: string, pattern: RegExp): string[] {
  return unique([...text.matchAll(pattern)].map((match) => match[1] ?? match[0]));
}

type PullText = Pick<PullRequestActivity, 'title' | 'body' | 'branch'>;

/** Where a pull request names Jira keys, most telling first. */
function keySources(pull: PullText): string[][] {
  const leading = pull.title.match(LEADING_KEY);
  return [
    leading === null ? [] : [leading[1]],
    allKeys(pull.title, ANY_KEY),
    allKeys(pull.body, BROWSE_LINK),
    allKeys(pull.body, ANY_KEY),
    allKeys(pull.branch.toUpperCase(), ANY_KEY),
  ];
}

/**
 * The Jira keys a pull request is about, from the first place that names any valid ones:
 *
 * 1. the title: a leading key (`GWP-1 …`, `GWP-1: …`, `[GWP-1] …`), else any key in it;
 * 2. the description: keys in Jira links (`…/browse/GWP-1`), else any key in it;
 * 3. the branch name, upper-cased.
 *
 * The title comes first so a description mentioning related tickets can't take over.
 */
export function findIssueKeys(
  pull: PullText,
  isValid: (key: string) => boolean = () => true,
): string[] {
  for (const keys of keySources(pull)) {
    const valid = keys.filter(isValid);
    if (valid.length > 0) {
      return valid;
    }
  }
  return [];
}

/** Every key a pull request mentions anywhere, for checking against Jira. */
export function candidateIssueKeys(pull: PullText): string[] {
  return unique(keySources(pull).flat());
}

/** The pull request title without the Jira key it starts with. */
export function plainTitle(title: string): string {
  return title.replace(LEADING_KEY, '').trim() || title.trim();
}

export interface MappedPullRequest {
  pull: PullRequestActivity;
  /** Issues its work goes to: its own valid keys, or the placeholder. Empty if neither. */
  issueKeys: string[];
  /** Whether it had no valid Jira key and went to the placeholder ticket (or nowhere). */
  unkeyed: boolean;
}

/**
 * Turns pull request activity into evidence. A pull request naming several valid issues splits
 * its weight between them; one with none goes to the placeholder ticket, if there is one.
 */
export function mapPullRequests(
  pulls: PullRequestActivity[],
  validKeys: ReadonlySet<string>,
  placeholderIssueKey: string,
): { events: ActivityEvent[]; mapped: MappedPullRequest[] } {
  const placeholder = placeholderIssueKey.trim();
  const events: ActivityEvent[] = [];
  const mapped: MappedPullRequest[] = [];
  for (const pull of pulls) {
    const keys = findIssueKeys(pull, (key) => validKeys.has(key));
    const unkeyed = keys.length === 0;
    const issueKeys = unkeyed ? (placeholder === '' ? [] : [placeholder]) : keys;
    mapped.push({ pull, issueKeys, unkeyed });
    const name = `${pull.repo}#${pull.number}`;
    for (const action of pull.actions) {
      const reviewing = action.kind === 'review' || action.kind === 'comment';
      for (const issueKey of issueKeys) {
        events.push({
          id: `${action.id}:${issueKey}`,
          issueKey,
          at: action.at,
          kind: action.kind,
          label: reviewing ? `reviewed ${name}` : `${name} ${plainTitle(pull.title)}`,
          url: pull.url,
          share: 1 / issueKeys.length,
        });
      }
    }
  }
  return { events, mapped };
}
