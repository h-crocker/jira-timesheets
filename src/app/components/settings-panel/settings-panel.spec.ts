import { TestBed } from '@angular/core/testing';
import type { JiraCredentials, RecurringSchedule, UserSettings } from '../../models/domain';
import { SettingsPanelComponent } from './settings-panel';

const SETTINGS: UserSettings = {
  startTime: '09:00',
  hoursPerDay: 7.5,
  lunchMinutes: 60,
  workDays: [1, 2, 3, 4, 5],
  allocations: [{ id: 'a1', issueKey: 'GWP-2070', summary: 'Main work', percentage: 75 }],
  schedules: [
    { id: 's1', issueKey: 'GWP-1', summary: 'Standup', weekdays: [1, 3], startTime: '09:30', durationSeconds: 900, enabled: true },
  ],
  spreadPrefixes: ['MT'],
  weekAllocations: {},
  leaveIssueKey: '',
  placeholderIssueKey: '',
  githubOrgs: [],
};

describe('SettingsPanelComponent', () => {
  function create(settings: UserSettings = SETTINGS, credentials: JiraCredentials | null = null) {
    const fixture = TestBed.createComponent(SettingsPanelComponent);
    fixture.componentRef.setInput('settings', settings);
    fixture.componentRef.setInput('credentials', credentials);
    fixture.detectChanges();
    return fixture;
  }

  function q<T extends HTMLElement = HTMLElement>(fixture: { nativeElement: unknown }, testId: string): T {
    return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`)!;
  }

  function type(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('renders work hours, allocations and schedules from inputs', () => {
    const fixture = create();
    expect(q<HTMLInputElement>(fixture, 'start-time').value).toBe('09:00');
    expect(q<HTMLInputElement>(fixture, 'hours-per-day').value).toBe('7.5');
    expect(q<HTMLInputElement>(fixture, 'lunch-minutes').value).toBe('60');
    expect(q<HTMLInputElement>(fixture, 'workday-3').checked).toBe(true);
    expect(q(fixture, 'allocation-a1').textContent).toContain('GWP-2070');
    expect(q<HTMLInputElement>(fixture, 'allocation-percentage-a1').value).toBe('75');
    expect(q(fixture, 'schedule-s1').textContent).toContain('Mon, Wed');
  });

  it('shows empty states', () => {
    const fixture = create({ ...SETTINGS, allocations: [], schedules: [] });
    const text = (fixture.nativeElement as HTMLElement).textContent;
    expect(text).toContain('No allocations');
    expect(text).toContain('No schedules');
  });

  it('emits workHoursChanged with edited values', () => {
    const fixture = create();
    const emitted: unknown[] = [];
    fixture.componentInstance.workHoursChanged.subscribe((v) => emitted.push(v));

    type(q<HTMLInputElement>(fixture, 'start-time'), '08:30');
    type(q<HTMLInputElement>(fixture, 'hours-per-day'), '8');
    type(q<HTMLInputElement>(fixture, 'lunch-minutes'), '30');
    q<HTMLInputElement>(fixture, 'workday-5').click();
    q(fixture, 'save-work-hours').click();

    expect(emitted).toEqual([
      { startTime: '08:30', hoursPerDay: 8, lunchMinutes: 30, workDays: [1, 2, 3, 4] },
    ]);
  });

  it('emits allocationRemoved and scheduleRemoved with ids', () => {
    const fixture = create();
    const allocations: string[] = [];
    const schedules: string[] = [];
    fixture.componentInstance.allocationRemoved.subscribe((v) => allocations.push(v));
    fixture.componentInstance.scheduleRemoved.subscribe((v) => schedules.push(v));

    q(fixture, 'remove-allocation-a1').click();
    q(fixture, 'remove-schedule-s1').click();

    expect(allocations).toEqual(['a1']);
    expect(schedules).toEqual(['s1']);
  });

  it("edits an allocation's percentage in place", () => {
    const fixture = create();
    const emitted: unknown[] = [];
    fixture.componentInstance.allocationChanged.subscribe((v) => emitted.push(v));
    const field = q<HTMLInputElement>(fixture, 'allocation-percentage-a1');
    const change = (value: string) => {
      field.value = value;
      field.dispatchEvent(new Event('change'));
    };

    change('40');
    expect(emitted).toEqual([{ id: 'a1', issueKey: 'GWP-2070', summary: 'Main work', percentage: 40 }]);

    // Blank, negative or unchanged: nothing is emitted, and a bad value is put back.
    change('');
    expect(field.value).toBe('75');
    change('-5');
    expect(field.value).toBe('75');
    change('75');
    expect(emitted).toHaveLength(1);
  });

  it('emits allocationAdded and resets the form', () => {
    const fixture = create();
    const emitted: { issueKey: string; summary: string; percentage: number; id: string }[] = [];
    fixture.componentInstance.allocationAdded.subscribe((v) => emitted.push(v));

    type(q<HTMLInputElement>(fixture, 'alloc-issue-key'), 'GWP-9');
    type(q<HTMLInputElement>(fixture, 'alloc-summary'), 'Extra');
    type(q<HTMLInputElement>(fixture, 'alloc-percentage'), '25');
    fixture.detectChanges();
    const submit = new Event('submit', { cancelable: true });
    q(fixture, 'allocation-form').dispatchEvent(submit);
    fixture.detectChanges();

    expect(submit.defaultPrevented).toBe(true);
    expect(emitted.length).toBe(1);
    expect(emitted[0]).toMatchObject({ issueKey: 'GWP-9', summary: 'Extra', percentage: 25 });
    expect(emitted[0].id).toBeTruthy();
    expect(q<HTMLInputElement>(fixture, 'alloc-issue-key').value).toBe('');
  });

  it('emits scheduleAdded with converted duration', () => {
    const fixture = create();
    const emitted: { weekdays: number[]; durationSeconds: number; startTime: string; enabled: boolean }[] = [];
    fixture.componentInstance.scheduleAdded.subscribe((v) => emitted.push(v));

    type(q<HTMLInputElement>(fixture, 'sched-issue-key'), 'GWP-3');
    type(q<HTMLInputElement>(fixture, 'sched-summary'), 'Retro');
    q<HTMLInputElement>(fixture, 'sched-weekday-2').click();
    q<HTMLInputElement>(fixture, 'sched-weekday-4').click();
    type(q<HTMLInputElement>(fixture, 'sched-start-time'), '14:00');
    type(q<HTMLInputElement>(fixture, 'sched-duration'), '1.5');
    q(fixture, 'schedule-form').dispatchEvent(new Event('submit', { cancelable: true }));

    expect(emitted).toEqual([
      expect.objectContaining({ weekdays: [2, 4], startTime: '14:00', durationSeconds: 5400, enabled: true, repeat: 'weekly' }),
    ]);
  });

  it('shows which allocations are scattered and which are logged in blocks', () => {
    const fixture = create({
      ...SETTINGS,
      allocations: [
        ...SETTINGS.allocations,
        { id: 'a2', issueKey: 'MT-5', summary: 'Support', percentage: 25 },
      ],
    });
    expect(q<HTMLInputElement>(fixture, 'spread-prefixes').value).toBe('MT');
    const order = q(fixture, 'allocations-order').textContent!.replace(/\s+/g, ' ');
    expect(order).toContain('Logged one after another in blocks: GWP-2070.');
    expect(order).toContain('Scattered through the week: MT-5.');
  });

  it('emits the scattered ticket prefixes when they change', () => {
    const fixture = create();
    const emitted: string[][] = [];
    fixture.componentInstance.spreadPrefixesChanged.subscribe((v) => emitted.push(v));
    const field = q<HTMLInputElement>(fixture, 'spread-prefixes');
    const change = (value: string) => {
      field.value = value;
      field.dispatchEvent(new Event('change'));
    };

    change('MT, ops  GWP-');
    change('MT');
    change('');

    expect(emitted).toEqual([['MT', 'ops', 'GWP-'], []]);
  });

  it('says how often each schedule repeats', () => {
    const fixture = create({
      ...SETTINGS,
      schedules: [
        ...SETTINGS.schedules,
        { id: 's2', issueKey: 'GWP-2', summary: 'Review', weekdays: [3], startTime: '14:00', durationSeconds: 3600, enabled: true, repeat: 'fortnightly', anchorWeek: '2026-09-28' },
        { id: 's3', issueKey: 'GWP-3', summary: 'All hands', weekdays: [2], startTime: '11:00', durationSeconds: 3600, enabled: true, repeat: 'monthly', weekOfMonth: -1 },
      ],
    });
    expect(q(fixture, 'schedule-s1').textContent).toContain('every week');
    expect(q(fixture, 'schedule-s2').textContent).toContain('every other week from Sep 28');
    expect(q(fixture, 'schedule-s3').textContent).toContain('last of the month');
  });

  it('emits a fortnightly schedule anchored to the week on show, or to the week of a chosen date', () => {
    const fixture = create();
    fixture.componentRef.setInput('weekStart', new Date(2026, 8, 28));
    fixture.detectChanges();
    const emitted: RecurringSchedule[] = [];
    fixture.componentInstance.scheduleAdded.subscribe((v) => emitted.push(v));
    const select = (id: string, value: string) => {
      const field = q<HTMLSelectElement>(fixture, id);
      field.value = value;
      field.dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };
    const submit = () => {
      q(fixture, 'schedule-form').dispatchEvent(new Event('submit', { cancelable: true }));
      fixture.detectChanges();
    };

    expect(q(fixture, 'sched-anchor-date')).toBeNull();
    select('sched-repeat', 'fortnightly');
    expect(q<HTMLInputElement>(fixture, 'sched-anchor-date').value).toBe('2026-09-28');
    q<HTMLInputElement>(fixture, 'sched-weekday-3').click();
    submit();

    select('sched-repeat', 'fortnightly');
    type(q<HTMLInputElement>(fixture, 'sched-anchor-date'), '2026-10-08');
    submit();

    expect(emitted.map((schedule) => [schedule.repeat, schedule.anchorWeek, schedule.weekOfMonth])).toEqual([
      ['fortnightly', '2026-09-28', undefined],
      ['fortnightly', '2026-10-05', undefined],
    ]);
    expect(emitted[0].weekdays).toEqual([3]);
    // The form goes back to weekly.
    expect(q<HTMLSelectElement>(fixture, 'sched-repeat').value).toBe('weekly');
  });

  it('emits a monthly schedule with the chosen week of the month', () => {
    const fixture = create();
    const emitted: RecurringSchedule[] = [];
    fixture.componentInstance.scheduleAdded.subscribe((v) => emitted.push(v));
    const select = (id: string, value: string) => {
      const field = q<HTMLSelectElement>(fixture, id);
      field.value = value;
      field.dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };

    select('sched-repeat', 'monthly');
    expect(q(fixture, 'sched-anchor-date')).toBeNull();
    select('sched-week-of-month', '-1');
    q(fixture, 'schedule-form').dispatchEvent(new Event('submit', { cancelable: true }));

    expect(emitted).toEqual([expect.objectContaining({ repeat: 'monthly', weekOfMonth: -1 })]);
    expect(emitted[0].anchorWeek).toBeUndefined();
  });

  it('prefills credentials and emits changes / clear', () => {
    const creds: JiraCredentials = { email: 'a@b.c', apiToken: 'tok', host: 'https://x.atlassian.net' };
    const fixture = create(SETTINGS, creds);
    const emitted: (JiraCredentials | null)[] = [];
    fixture.componentInstance.credentialsChanged.subscribe((v) => emitted.push(v));

    expect(q<HTMLInputElement>(fixture, 'cred-email').value).toBe('a@b.c');
    expect(q<HTMLInputElement>(fixture, 'cred-host').value).toBe('https://x.atlassian.net');

    type(q<HTMLInputElement>(fixture, 'cred-token'), 'new-token');
    q(fixture, 'credentials-form').dispatchEvent(new Event('submit', { cancelable: true }));
    q(fixture, 'clear-credentials').click();

    expect(emitted).toEqual([{ email: 'a@b.c', apiToken: 'new-token', host: 'https://x.atlassian.net' }, null]);
  });

  it('emits the activity settings', () => {
    const fixture = create({ ...SETTINGS, githubOrgs: ['acme'] });
    const emitted: unknown[] = [];
    fixture.componentInstance.activitySettingsChanged.subscribe((v) => emitted.push(v));

    expect(q<HTMLInputElement>(fixture, 'github-orgs').value).toBe('acme');
    type(q<HTMLInputElement>(fixture, 'leave-issue-key'), ' HR-1 ');
    type(q<HTMLInputElement>(fixture, 'placeholder-issue-key'), 'GWP-100');
    type(q<HTMLInputElement>(fixture, 'github-orgs'), 'acme, widgets  ');
    q(fixture, 'save-activity-settings').click();

    expect(emitted).toEqual([
      {
        leaveIssueKey: 'HR-1',
        placeholderIssueKey: 'GWP-100',
        githubOrgs: ['acme', 'widgets'],
      },
    ]);
  });

  it('emits the GitHub token, defaulting the API URL, and clears it', () => {
    const fixture = create();
    const emitted: unknown[] = [];
    fixture.componentInstance.githubCredentialsChanged.subscribe((v) => emitted.push(v));

    type(q<HTMLInputElement>(fixture, 'github-token'), 'gh-token');
    q(fixture, 'github-form').dispatchEvent(new Event('submit', { cancelable: true }));
    q(fixture, 'clear-github').click();

    expect(emitted).toEqual([{ token: 'gh-token', apiUrl: 'https://api.github.com' }, null]);
  });

  it("shows the week's own allocations, with what each came from, in place of the usual ones", () => {
    const fixture = create();
    fixture.componentRef.setInput('weekLabel', 'Sep 28 – Oct 4');
    fixture.detectChanges();
    expect(q(fixture, 'allocations-scope').textContent).toContain('Your usual allocations');
    expect(q(fixture, 'allocation-a1').textContent).toContain('GWP-2070');
    expect(q(fixture, 'fill-from-activity').textContent).toContain('Fill Sep 28 – Oct 4 from activity');
    expect(q(fixture, 'use-usual-allocations')).toBeNull();

    fixture.componentRef.setInput('weekAllocations', [
      { id: 'activity-GWP-8', issueKey: 'GWP-8', summary: 'SSO login', percentage: 100 },
    ]);
    fixture.componentRef.setInput('allocationEvidence', { 'GWP-8': 'acme/web#52 (2 actions)' });
    fixture.detectChanges();

    expect(q(fixture, 'allocations-scope').textContent).toContain('For Sep 28 – Oct 4 only');
    expect(q(fixture, 'allocation-a1')).toBeNull();
    const row = q(fixture, 'allocation-activity-GWP-8');
    expect(q<HTMLInputElement>(fixture, 'allocation-percentage-activity-GWP-8').value).toBe('100');
    expect(row.querySelector('[data-testid="allocation-evidence"]')!.textContent).toBe(
      'acme/web#52 (2 actions)',
    );
  });

  it("says what the allocations add up to when it isn't 100%", () => {
    const fixture = create();
    expect(q(fixture, 'allocations-total').textContent).toContain(
      'These add up to 75%, so part of the week is left empty.',
    );

    fixture.componentRef.setInput('weekAllocations', [
      { id: 'b1', issueKey: 'GWP-7', summary: 'Filled', percentage: 100 },
      { id: 'b2', issueKey: 'GWP-8', summary: 'Added', percentage: 20 },
    ]);
    fixture.detectChanges();
    expect(q(fixture, 'allocations-total').textContent).toContain(
      'These add up to 120%, so each gets its share of the week in proportion.',
    );

    fixture.componentRef.setInput('weekAllocations', [
      { id: 'c1', issueKey: 'GWP-7', summary: 'Third', percentage: 33.3 },
      { id: 'c2', issueKey: 'GWP-8', summary: 'Third', percentage: 33.3 },
      { id: 'c3', issueKey: 'GWP-9', summary: 'Third', percentage: 33.4 },
    ]);
    fixture.detectChanges();
    expect(q(fixture, 'allocations-total')).toBeNull();
  });

  it('emits fillFromActivity and useUsualAllocations, and disables filling while busy', () => {
    const fixture = create();
    fixture.componentRef.setInput('weekAllocations', []);
    fixture.detectChanges();
    const events: string[] = [];
    fixture.componentInstance.fillFromActivity.subscribe(() => events.push('fill'));
    fixture.componentInstance.useUsualAllocations.subscribe(() => events.push('usual'));

    q(fixture, 'fill-from-activity').click();
    q(fixture, 'use-usual-allocations').click();
    expect(events).toEqual(['fill', 'usual']);

    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    expect(q<HTMLButtonElement>(fixture, 'fill-from-activity').disabled).toBe(true);
  });
});
