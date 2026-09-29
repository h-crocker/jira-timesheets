import { TestBed } from '@angular/core/testing';
import type { ActivityIssueSummary, PercentageAllocation } from '../../models/domain';
import { ActivityPanelComponent } from './activity-panel';

const ALLOCATIONS: PercentageAllocation[] = [
  { id: 'activity-GWP-2070', issueKey: 'GWP-2070', summary: 'Rate limiting', percentage: 70 },
  { id: 'activity-GWP-100', issueKey: 'GWP-100', summary: 'General work', percentage: 30 },
];

const ISSUES: ActivityIssueSummary[] = [
  {
    issueKey: 'GWP-2070',
    summary: 'Rate limiting',
    percentage: 70,
    pullRequests: [{ name: 'acme/api#41', url: 'https://github.com/acme/api/pull/41', actions: 5 }],
    jiraWorklogs: 2,
  },
];

describe('ActivityPanelComponent', () => {
  function create(inputs: Record<string, unknown> = {}) {
    const fixture = TestBed.createComponent(ActivityPanelComponent);
    for (const [name, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(name, value);
    }
    fixture.detectChanges();
    return fixture;
  }

  const el = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement;

  it("says the week uses the usual allocations until it's filled, and emits fill", () => {
    const fixture = create();
    expect(el(fixture).textContent).toContain('This week uses your usual allocations.');
    const fills: unknown[] = [];
    fixture.componentInstance.fill.subscribe(() => fills.push(true));
    el(fixture).querySelector<HTMLButtonElement>('[data-testid="fill-from-activity"]')!.click();
    expect(fills).toHaveLength(1);

    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    expect(
      el(fixture).querySelector<HTMLButtonElement>('[data-testid="fill-from-activity"]')!.disabled,
    ).toBe(true);
  });

  it("lists the week's allocations with the evidence behind them, and emits clear", () => {
    const fixture = create({ weekAllocations: ALLOCATIONS, issues: ISSUES });
    const row = el(fixture).querySelector('[data-testid="week-allocation-GWP-2070"]')!;
    expect(row.querySelector('[data-testid="percentage"]')!.textContent).toBe('70%');
    const chips = Array.from(row.querySelectorAll('.chip')).map((chip) => chip.textContent?.trim());
    expect(chips).toEqual(['acme/api#41 · 5 actions', '2 automatic worklogs']);
    expect(row.querySelector('a')!.getAttribute('href')).toBe(
      'https://github.com/acme/api/pull/41',
    );
    const placeholder = el(fixture).querySelector('[data-testid="week-allocation-GWP-100"]')!;
    expect(placeholder.querySelector('.chip')).toBeNull();

    const clears: unknown[] = [];
    fixture.componentInstance.clear.subscribe(() => clears.push(true));
    el(fixture).querySelector<HTMLButtonElement>('[data-testid="clear-week-allocations"]')!.click();
    expect(clears).toHaveLength(1);
  });

  it('shows warnings and pull requests with no key', () => {
    const fixture = create({
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
    expect(el(fixture).querySelector('[data-testid="activity-warning"]')!.textContent).toContain(
      "GitHub isn't set up",
    );
    expect(
      el(fixture).querySelector('[data-testid="unkeyed-pull-request"]')!.textContent,
    ).toContain('Tidy CI config');
    expect(el(fixture).textContent).toContain('→ GWP-100');
  });
});
