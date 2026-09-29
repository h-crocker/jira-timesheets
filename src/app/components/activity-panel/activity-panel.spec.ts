import { TestBed } from '@angular/core/testing';
import type { ActivityIssueSummary } from '../../models/domain';
import { ActivityPanelComponent } from './activity-panel';

const ISSUES: ActivityIssueSummary[] = [
  {
    issueKey: 'GWP-2070',
    summary: 'Rate limiting for the public API',
    plannedSeconds: 16 * 3600 + 45 * 60,
    pullRequests: [{ name: 'acme/api#41', url: 'https://github.com/acme/api/pull/41', actions: 5 }],
    jiraWorklogs: 2,
  },
  { issueKey: 'GWP-100', summary: '', plannedSeconds: 3600, pullRequests: [], jiraWorklogs: 0 },
];

describe('ActivityPanelComponent', () => {
  function create(inputs: Partial<Record<string, unknown>> = {}) {
    const fixture = TestBed.createComponent(ActivityPanelComponent);
    fixture.componentRef.setInput('issues', ISSUES);
    for (const [name, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(name, value);
    }
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('lists each issue with its planned time and evidence', () => {
    const el = create();
    const issue = el.querySelector('[data-testid="activity-GWP-2070"]')!;
    expect(issue.textContent).toContain('Rate limiting for the public API');
    expect(issue.querySelector('[data-testid="planned-hours"]')!.textContent).toBe('16h 45m');
    const chips = Array.from(issue.querySelectorAll('.chip')).map((chip) =>
      chip.textContent?.trim(),
    );
    expect(chips).toEqual(['acme/api#41 · 5 actions', '2 automatic worklogs']);
    expect(issue.querySelector('a')!.getAttribute('href')).toBe(
      'https://github.com/acme/api/pull/41',
    );
    expect(
      el.querySelector('[data-testid="activity-GWP-100"] [data-testid="planned-hours"]')!
        .textContent,
    ).toBe('1h');
  });

  it('shows warnings, an empty state and pull requests with no key', () => {
    const el = create({
      issues: [],
      warnings: ["GitHub isn't set up, so only Jira worklogs are used."],
      unkeyedPullRequests: [
        {
          name: 'acme/tools#7',
          title: 'Tidy CI config',
          url: 'https://github.com/acme/tools/pull/7',
        },
      ],
      placeholderIssueKey: 'GWP-100',
    });
    expect(el.querySelector('[data-testid="activity-warning"]')!.textContent).toContain(
      "GitHub isn't set up",
    );
    expect(el.textContent).toContain('No activity found this week.');
    expect(el.querySelector('[data-testid="unkeyed-pull-request"]')!.textContent).toContain(
      'Tidy CI config',
    );
    expect(el.textContent).toContain('→ GWP-100');
  });
});
