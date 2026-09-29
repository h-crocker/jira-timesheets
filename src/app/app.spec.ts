import type * as http from 'node:http';
import { TestBed } from '@angular/core/testing';
import mockServer from '../../mock-jira-server';
import { App, startOfWeek } from './app';
import type { JiraCredentials } from './models/domain';
import { JiraIntegrationService } from './services/jira-integration.service';
import { SettingsService } from './services/settings.service';

const { startServer, stopServer } = mockServer;

const WEEK = new Date(2026, 8, 28); // Monday; the mock server seeds worklogs on this week

describe('startOfWeek', () => {
  it('returns the Monday for any day in the week', () => {
    expect(startOfWeek(new Date(2026, 8, 30, 15, 30))).toEqual(new Date(2026, 8, 28));
    expect(startOfWeek(new Date(2026, 9, 4))).toEqual(new Date(2026, 8, 28));
    expect(startOfWeek(new Date(2026, 8, 28))).toEqual(new Date(2026, 8, 28));
  });
});

describe('App (smart component)', () => {
  let server: http.Server;
  let credentials: JiraCredentials;

  beforeAll(async () => {
    server = await startServer(0);
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('mock server has no address');
    }
    credentials = { email: 'dev@example.com', apiToken: 'test-token', host: `http://localhost:${address.port}` };
  });

  afterAll(async () => {
    await stopServer(server);
  });

  beforeEach(() => {
    localStorage.clear();
  });

  async function create(seed?: (settings: SettingsService) => void) {
    const settings = TestBed.inject(SettingsService);
    settings.setCredentials(credentials);
    seed?.(settings);
    const fixture = TestBed.createComponent(App);
    fixture.componentInstance.currentWeek.set(WEEK);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const root = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement;
  const q = (fixture: { nativeElement: unknown }, testId: string) =>
    root(fixture).querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;

  async function settle(fixture: Awaited<ReturnType<typeof create>>) {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      fixture.detectChanges();
      if (!fixture.componentInstance.busy()) {
        break;
      }
    }
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('renders the three display components', async () => {
    const fixture = await create();
    expect(root(fixture).querySelector('app-week-selector')).toBeTruthy();
    expect(root(fixture).querySelector('app-calendar-grid')).toBeTruthy();
    expect(root(fixture).querySelector('app-settings-panel')).toBeTruthy();
    expect(q(fixture, 'week-label').textContent).toContain('Sep 28');
  });

  it('shows an empty grid and idle state without any configured issues', async () => {
    const fixture = await create();
    expect(root(fixture).querySelectorAll('.event-row').length).toBe(0);
    expect(q(fixture, 'plan-summary').textContent).toContain('0 to create, 0 to delete');
    expect((q(fixture, 'sync') as HTMLButtonElement).disabled).toBe(true);
  });

  it('loads existing Jira worklogs for configured issues into the grid', async () => {
    const fixture = await create((settings) =>
      settings.addAllocation({ id: 'a', issueKey: 'GWP-2070', summary: 'Main', percentage: 0 }),
    );
    await settle(fixture);
    const sources = Array.from(root(fixture).querySelectorAll('.source-badge')).map((n) => n.textContent?.trim());
    expect(sources.filter((source) => source === 'jira').length).toBe(2);
    expect(root(fixture).textContent).toContain('Work on feature');
  });

  it('adding a recurring schedule via the settings panel mutates the calendar grid', async () => {
    const fixture = await create();
    const q2 = (id: string) => q(fixture, id) as HTMLInputElement;
    const type = (id: string, value: string) => {
      q2(id).value = value;
      q2(id).dispatchEvent(new Event('input'));
    };

    type('sched-issue-key', 'GWP-100');
    type('sched-summary', 'Standup');
    q2('sched-weekday-1').click();
    q2('sched-weekday-3').click();
    type('sched-start-time', '09:30');
    type('sched-duration', '0.5');
    q(fixture, 'schedule-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(fixture);

    const rows = Array.from(root(fixture).querySelectorAll('.event-row')).filter((row) =>
      row.textContent?.includes('GWP-100'),
    );
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.querySelector('.source-badge')?.getAttribute('data-source') === 'recurring')).toBe(true);
    expect(q(fixture, 'plan-summary').textContent).toContain('2 to create');
    expect(TestBed.inject(SettingsService).settings().schedules.length).toBe(1);
  });

  it('percentage allocations fill the remaining capacity in the grid', async () => {
    const fixture = await create((settings) =>
      settings.addAllocation({ id: 'a', issueKey: 'GWP-200', summary: 'Project', percentage: 100 }),
    );
    await settle(fixture);
    const allocated = Array.from(root(fixture).querySelectorAll('.source-badge')).filter(
      (badge) => badge.getAttribute('data-source') === 'allocated',
    );
    expect(allocated.length).toBeGreaterThan(0);
    const totalSeconds = fixture.componentInstance
      .derivedCalendarEvents()
      .filter((event) => event.source === 'allocated')
      .reduce((sum, event) => sum + event.timeSpentSeconds, 0);
    expect(totalSeconds).toBe(5 * 7.5 * 3600);
  });

  it('week navigation changes the displayed week and events', async () => {
    const fixture = await create((settings) =>
      settings.addSchedule({
        id: 's', issueKey: 'GWP-100', summary: 'Standup', weekdays: [1], startTime: '09:00', durationSeconds: 900, enabled: true,
      }),
    );
    await settle(fixture);
    q(fixture, 'next-week').click();
    fixture.detectChanges();
    expect(q(fixture, 'week-label').textContent).toContain('Oct 5');
    expect(root(fixture).querySelector('[data-date="2026-10-05"] .event-row')).toBeTruthy();
    expect(root(fixture).querySelector('[data-date="2026-09-28"]')).toBeNull();
  });

  it('removing a schedule via the panel clears it from the grid', async () => {
    const fixture = await create((settings) =>
      settings.addSchedule({
        id: 's', issueKey: 'GWP-100', summary: 'Standup', weekdays: [1], startTime: '09:00', durationSeconds: 900, enabled: true,
      }),
    );
    await settle(fixture);
    expect(root(fixture).querySelectorAll('.event-row').length).toBe(1);
    q(fixture, 'remove-schedule-s').click();
    await settle(fixture);
    expect(root(fixture).querySelectorAll('.event-row').length).toBe(0);
  });

  it('recurring event overrides a clashing existing worklog (planned deletion)', async () => {
    const fixture = await create();
    await TestBed.inject(JiraIntegrationService).createWorklog(
      'GWP-CLASH',
      new Date(2026, 8, 28, 10, 0).toISOString(),
      3600,
      'Existing entry',
    );
    TestBed.inject(SettingsService).addSchedule({
      id: 's', issueKey: 'GWP-CLASH', summary: 'Recurring', weekdays: [1], startTime: '10:30', durationSeconds: 1800, enabled: true,
    });
    await settle(fixture);

    expect(fixture.componentInstance.plan().deletions.map((d) => d.issueKey)).toEqual(['GWP-CLASH']);
    const monday = Array.from(root(fixture).querySelectorAll('[data-date="2026-09-28"] .event-row'));
    expect(monday.length).toBe(1);
    expect(monday[0].querySelector('.source-badge')?.getAttribute('data-source')).toBe('recurring');
    expect(monday[0].textContent).toContain('Recurring');
  });

  it('syncWeek pushes the plan to the mock Jira server and reloads', async () => {
    const fixture = await create((settings) =>
      settings.addSchedule({
        id: 's', issueKey: 'GWP-SYNC', summary: 'Sync test', weekdays: [2], startTime: '14:00', durationSeconds: 1800, enabled: true,
      }),
    );
    await settle(fixture);
    expect((q(fixture, 'sync') as HTMLButtonElement).disabled).toBe(false);

    q(fixture, 'sync').click();
    await settle(fixture);

    expect(q(fixture, 'status').textContent).toContain('Synced: 1 created, 0 deleted');
    const worklogs = fixture.componentInstance.worklogs().filter((w) => w.issueKey === 'GWP-SYNC');
    expect(worklogs.length).toBe(1);
    expect(worklogs[0].timeSpentSeconds).toBe(1800);
  });

  it('shows an error when Jira cannot be reached', async () => {
    const fixture = await create((settings) => {
      settings.setCredentials({ ...credentials, host: 'http://localhost:1' });
      settings.addAllocation({ id: 'a', issueKey: 'GWP-2070', summary: 'Main', percentage: 50 });
    });
    await settle(fixture);
    expect(q(fixture, 'status').textContent).toContain('Could not load worklogs');
  });
});
