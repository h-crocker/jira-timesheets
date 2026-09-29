import { TestBed } from '@angular/core/testing';
import { ActivityService } from './activity.service';
import type { PullRequestActivity } from './github-integration.service';
import { JiraIntegrationService } from './jira-integration.service';

const PULL: PullRequestActivity = {
  repo: 'acme/api',
  number: 41,
  title: 'GWP-2070 Add rate limiting',
  body: '',
  branch: 'feature',
  url: 'https://github.com/acme/api/pull/41',
  actions: [{ id: 'gh:acme/api#41:commit:a', kind: 'commit', at: new Date(2026, 8, 29, 10) }],
};

describe('ActivityService', () => {
  function service(fetchIssueSummaries: (keys: string[]) => Promise<Map<string, string>>) {
    TestBed.configureTestingModule({
      providers: [{ provide: JiraIntegrationService, useValue: { fetchIssueSummaries } }],
    });
    return TestBed.inject(ActivityService);
  }

  it('maps pull requests to the keys Jira knows', async () => {
    const result = await service(
      async () => new Map([['GWP-100', 'General development']]),
    ).toEvidence({ pulls: [PULL], warnings: [] }, 'GWP-100', []);
    expect(result.events.map((event) => event.issueKey)).toEqual(['GWP-100']);
    expect(result.warnings).toEqual([]);
  });

  it('still loads the week when Jira keys cannot be checked, using the keys as named', async () => {
    const result = await service(() =>
      Promise.reject(new Error('Request failed: 403 Forbidden')),
    ).toEvidence({ pulls: [PULL], warnings: [] }, 'GWP-100', ['GWP-2080']);

    expect(result.events.map((event) => event.issueKey)).toEqual(['GWP-2070']);
    expect(result.warnings).toEqual([
      "Couldn't check the Jira keys pull requests name (Request failed: 403 Forbidden), so they're used as they are.",
    ]);
  });
});
