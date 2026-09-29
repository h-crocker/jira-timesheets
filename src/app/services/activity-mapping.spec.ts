import { candidateIssueKeys, findIssueKeys, mapPullRequests, plainTitle } from './activity-mapping';
import type { PullRequestActivity } from './github-integration.service';

function pull(overrides: Partial<PullRequestActivity> = {}): PullRequestActivity {
  return {
    repo: 'acme/api',
    number: 41,
    title: 'Add rate limiting',
    body: '',
    branch: 'main-work',
    url: 'https://github.com/acme/api/pull/41',
    actions: [],
    ...overrides,
  };
}

describe('findIssueKeys', () => {
  it('takes the key the title starts with, in any of the usual forms', () => {
    for (const title of [
      'GWP-2070 Add rate limiting',
      'GWP-2070: Add',
      '[GWP-2070] Add',
      'GWP-2070 - Add',
    ]) {
      expect(findIssueKeys(pull({ title, body: 'See GWP-1999' })), title).toEqual(['GWP-2070']);
    }
  });

  it('prefers the title over the description, and links over bare keys in the description', () => {
    expect(findIssueKeys(pull({ title: 'Add limits (GWP-1 GWP-2)', body: 'GWP-3' }))).toEqual([
      'GWP-1',
      'GWP-2',
    ]);
    expect(
      findIssueKeys(
        pull({
          body: 'Follows on from GWP-1999.\nJira: https://example.atlassian.net/browse/GWP-2070',
        }),
      ),
    ).toEqual(['GWP-2070']);
    expect(findIssueKeys(pull({ body: 'Follows on from GWP-1999.' }))).toEqual(['GWP-1999']);
  });

  it('falls back to the branch name, whatever its case', () => {
    expect(findIssueKeys(pull({ branch: 'feature/gwp-2070-rate-limit' }))).toEqual(['GWP-2070']);
    expect(findIssueKeys(pull())).toEqual([]);
  });

  it('skips keys that are not valid and looks further', () => {
    const valid = (key: string) => key.startsWith('GWP-');
    expect(findIssueKeys(pull({ title: 'UTF-8 names', body: 'GWP-7' }), valid)).toEqual(['GWP-7']);
    expect(findIssueKeys(pull({ title: 'UTF-8 for GWP-1' }), valid)).toEqual(['GWP-1']);
  });

  it('lists every key mentioned anywhere as a candidate', () => {
    expect(
      candidateIssueKeys(
        pull({ title: 'GWP-1 Add', body: 'See GWP-2 and /browse/GWP-3', branch: 'gwp-4' }),
      ),
    ).toEqual(['GWP-1', 'GWP-3', 'GWP-2', 'GWP-4']);
  });

  it('does not read a key out of a longer word', () => {
    expect(findIssueKeys(pull({ title: 'GWP-2070abc tidy' }))).toEqual([]);
  });
});

describe('plainTitle', () => {
  it('drops the leading key', () => {
    expect(plainTitle('GWP-2070: Add rate limiting')).toBe('Add rate limiting');
    expect(plainTitle('[GWP-2070] Add')).toBe('Add');
    expect(plainTitle('GWP-2070')).toBe('GWP-2070');
    expect(plainTitle('Tidy CI')).toBe('Tidy CI');
  });
});

describe('mapPullRequests', () => {
  const at = new Date(2026, 8, 29, 10);
  const actions: PullRequestActivity['actions'] = [
    { id: 'gh:acme/api#41:commit:abc', kind: 'commit', at },
    { id: 'gh:acme/api#41:review:7', kind: 'review', at },
  ];

  it('turns actions into evidence on the issue, labelled for worklog comments', () => {
    const { events, mapped } = mapPullRequests(
      [pull({ title: 'GWP-2070 Add rate limiting', actions })],
      new Set(['GWP-2070']),
      'GWP-100',
    );
    expect(events).toEqual([
      {
        id: 'gh:acme/api#41:commit:abc:GWP-2070',
        issueKey: 'GWP-2070',
        at,
        kind: 'commit',
        label: 'acme/api#41 Add rate limiting',
        url: 'https://github.com/acme/api/pull/41',
        share: 1,
      },
      expect.objectContaining({ kind: 'review', label: 'reviewed acme/api#41', share: 1 }),
    ]);
    expect(mapped[0]).toMatchObject({ issueKeys: ['GWP-2070'], unkeyed: false });
  });

  it('splits the weight between several valid keys and drops keys Jira does not know', () => {
    const { events } = mapPullRequests(
      [pull({ title: 'UTF-8 names for GWP-1 and GWP-2', actions: actions.slice(0, 1) })],
      new Set(['GWP-1', 'GWP-2']),
      '',
    );
    expect(events.map((entry) => [entry.issueKey, entry.share])).toEqual([
      ['GWP-1', 0.5],
      ['GWP-2', 0.5],
    ]);
  });

  it('sends pull requests without a valid key to the placeholder, or nowhere', () => {
    const unkeyed = pull({ title: 'Tidy CI', actions });
    const toPlaceholder = mapPullRequests([unkeyed], new Set(), 'GWP-100');
    expect(toPlaceholder.events.map((entry) => entry.issueKey)).toEqual(['GWP-100', 'GWP-100']);
    expect(toPlaceholder.mapped[0]).toMatchObject({ issueKeys: ['GWP-100'], unkeyed: true });

    const nowhere = mapPullRequests([unkeyed], new Set(), '');
    expect(nowhere.events).toEqual([]);
    expect(nowhere.mapped[0]).toMatchObject({ issueKeys: [], unkeyed: true });
  });
});
