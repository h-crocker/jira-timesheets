import { TestBed } from '@angular/core/testing';
import type { JiraCredentials, UserSettings } from '../../models/domain';
import { SettingsPanelComponent } from './settings-panel';

const SETTINGS: UserSettings = {
  startTime: '09:00',
  hoursPerDay: 7.5,
  workDays: [1, 2, 3, 4, 5],
  allocations: [{ id: 'a1', issueKey: 'GWP-2070', summary: 'Main work', percentage: 75 }],
  schedules: [
    { id: 's1', issueKey: 'GWP-1', summary: 'Standup', weekdays: [1, 3], startTime: '09:30', durationSeconds: 900, enabled: true },
  ],
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
    expect(q<HTMLInputElement>(fixture, 'workday-3').checked).toBe(true);
    expect(q(fixture, 'allocation-a1').textContent).toContain('GWP-2070');
    expect(q(fixture, 'allocation-a1').textContent).toContain('75%');
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
    q<HTMLInputElement>(fixture, 'workday-5').click();
    q(fixture, 'save-work-hours').click();

    expect(emitted).toEqual([{ startTime: '08:30', hoursPerDay: 8, workDays: [1, 2, 3, 4] }]);
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
      expect.objectContaining({ weekdays: [2, 4], startTime: '14:00', durationSeconds: 5400, enabled: true }),
    ]);
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
});
