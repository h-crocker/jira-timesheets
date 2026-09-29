import type * as http from 'node:http';
import { TestBed } from '@angular/core/testing';
import mockServer from '../../mock-jira-server';
import { App, startOfWeek } from './app';
import type { JiraCredentials } from './models/domain';
import { JiraIntegrationService } from './services/jira-integration.service';
import { SettingsService } from './services/settings.service';

const { startServer, stopServer, resetMockJira } = mockServer;

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
    resetMockJira();
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

  const rowsFor = (fixture: { nativeElement: unknown }, text: string, scope = '') =>
    Array.from(root(fixture).querySelectorAll(`${scope} .event-row`)).filter((row) =>
      row.textContent?.includes(text),
    );
  const pad = (value: number) => String(value).padStart(2, '0');

  async function settle(fixture: Awaited<ReturnType<typeof create>>) {
    for (let i = 0; i < 40; i++) {
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

  it("shows the user's existing Jira worklogs for the week with nothing configured", async () => {
    const fixture = await create();
    await settle(fixture);
    const summaries = Array.from(root(fixture).querySelectorAll('.event-row'))
      .filter((row) => row.querySelector('.source-badge')?.getAttribute('data-source') === 'jira')
      .map((row) => row.querySelector('.summary')?.textContent?.trim());
    expect(summaries.sort()).toEqual(['Code review', 'Support ticket', 'Work on feature']);
    expect(root(fixture).textContent).not.toContain("Colleague's pairing session");
    expect(q(fixture, 'plan-summary').textContent).toContain('0 to create, 0 to delete');
    expect((q(fixture, 'sync') as HTMLButtonElement).disabled).toBe(true);
  });

  it("never plans to delete a colleague's worklog on a shared issue", async () => {
    // A recurring event on top of the colleague's seeded GWP-2070 entry, in local time.
    const colleagueStart = new Date('2026-09-28T13:00:00Z');
    const fixture = await create((settings) =>
      settings.addSchedule({
        id: 's',
        issueKey: 'GWP-2070',
        summary: 'Workshop',
        weekdays: [colleagueStart.getDay()],
        startTime: `${pad(colleagueStart.getHours())}:${pad(colleagueStart.getMinutes())}`,
        durationSeconds: 3600,
        enabled: true,
      }),
    );
    await settle(fixture);
    const comments = fixture.componentInstance.worklogs().map((worklog) => worklog.comment);
    expect(comments).not.toContain("Colleague's pairing session");
    expect(fixture.componentInstance.plan().deletions).toEqual([]);
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
    const loggedSeconds = fixture.componentInstance
      .worklogs()
      .reduce((sum, worklog) => sum + worklog.timeSpentSeconds, 0);
    expect(loggedSeconds).toBeGreaterThan(0);
    expect(totalSeconds).toBe(5 * 7.5 * 3600 - loggedSeconds);
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

  it("loads the displayed week's worklogs when navigating", async () => {
    const fixture = await create();
    await settle(fixture);
    await TestBed.inject(JiraIntegrationService).createWorklog(
      'GWP-2070',
      new Date(2026, 9, 6, 11, 0).toISOString(),
      1800,
      'Next week work',
    );
    q(fixture, 'next-week').click();
    await settle(fixture);
    const tuesday = root(fixture).querySelector('[data-date="2026-10-06"]');
    expect(tuesday?.textContent).toContain('Next week work');
    expect(root(fixture).textContent).not.toContain('Code review');
  });

  it('removing a schedule via the panel clears it from the grid', async () => {
    const fixture = await create((settings) =>
      settings.addSchedule({
        id: 's', issueKey: 'GWP-100', summary: 'Standup', weekdays: [1], startTime: '09:00', durationSeconds: 900, enabled: true,
      }),
    );
    await settle(fixture);
    expect(rowsFor(fixture, 'GWP-100').length).toBe(1);
    q(fixture, 'remove-schedule-s').click();
    await settle(fixture);
    expect(rowsFor(fixture, 'GWP-100').length).toBe(0);
  });

  // Thursday, which has no seeded worklogs in any time zone.
  async function withClash() {
    const fixture = await create();
    await TestBed.inject(JiraIntegrationService).createWorklog(
      'GWP-CLASH',
      new Date(2026, 9, 1, 10, 0).toISOString(),
      3600,
      'Existing entry',
    );
    TestBed.inject(SettingsService).addSchedule({
      id: 's', issueKey: 'GWP-CLASH', summary: 'Recurring', weekdays: [4], startTime: '10:30', durationSeconds: 1800, enabled: true,
    });
    await settle(fixture);
    return fixture;
  }

  it('recurring event overrides a clashing existing worklog (planned deletion)', async () => {
    const fixture = await withClash();

    expect(fixture.componentInstance.plan().deletions.map((d) => d.issueKey)).toEqual(['GWP-CLASH']);
    const thursday = rowsFor(fixture, 'GWP-CLASH', '[data-date="2026-10-01"]');
    expect(thursday.length).toBe(1);
    const source = thursday[0].querySelector('.source-badge')?.getAttribute('data-source');
    expect(source).toBe('recurring');
    expect(thursday[0].textContent).toContain('Recurring');
  });

  it('creates the replacement before deleting the clashing worklog', async () => {
    const fixture = await withClash();
    const jira = TestBed.inject(JiraIntegrationService);
    const created = vi.spyOn(jira, 'createWorklog');
    const deleted = vi.spyOn(jira, 'deleteWorklog');

    q(fixture, 'sync').click();
    await settle(fixture);

    expect(q(fixture, 'status').textContent).toContain('Synced: 1 created, 1 deleted');
    expect(created.mock.invocationCallOrder[0]).toBeLessThan(deleted.mock.invocationCallOrder[0]);
    const comments = fixture.componentInstance.worklogs().map((worklog) => worklog.comment);
    expect(comments).not.toContain('Existing entry');
  });

  it('syncWeek pushes the plan to the mock, reloads, and leaves nothing to sync', async () => {
    const fixture = await create((settings) =>
      settings.addSchedule({
        id: 's', issueKey: 'GWP-SYNC', summary: 'Sync test', weekdays: [4], startTime: '14:00', durationSeconds: 1800, enabled: true,
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
    expect(q(fixture, 'plan-summary').textContent).toContain('0 to create, 0 to delete');
    expect((q(fixture, 'sync') as HTMLButtonElement).disabled).toBe(true);
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
