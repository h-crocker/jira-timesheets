import type * as http from 'node:http';
import { TestBed } from '@angular/core/testing';
import mockGithub from '../../mock-github-server';
import mockServer from '../../mock-jira-server';
import { App, NOW, startOfWeek } from './app';
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
    credentials = {
      email: 'dev@example.com',
      apiToken: 'test-token',
      host: `http://localhost:${address.port}`,
    };
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
    expect(summaries.sort()).toEqual([
      'Code review',
      'Leave (morning)',
      'Logged on Done',
      'Logged on Done',
      'Support ticket',
      'Work on feature',
    ]);
    expect(fixture.componentInstance.worklogs().some((worklog) => worklog.generated)).toBe(false);
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
    expect(
      rows.every(
        (row) => row.querySelector('.source-badge')?.getAttribute('data-source') === 'recurring',
      ),
    ).toBe(true);
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
        id: 's',
        issueKey: 'GWP-100',
        summary: 'Standup',
        weekdays: [1],
        startTime: '09:00',
        durationSeconds: 900,
        enabled: true,
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
        id: 's',
        issueKey: 'GWP-100',
        summary: 'Standup',
        weekdays: [1],
        startTime: '09:00',
        durationSeconds: 900,
        enabled: true,
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
      id: 's',
      issueKey: 'GWP-CLASH',
      summary: 'Recurring',
      weekdays: [4],
      startTime: '10:30',
      durationSeconds: 1800,
      enabled: true,
    });
    await settle(fixture);
    return fixture;
  }

  it('recurring event overrides a clashing existing worklog (planned deletion)', async () => {
    const fixture = await withClash();

    expect(fixture.componentInstance.plan().deletions.map((d) => d.issueKey)).toEqual([
      'GWP-CLASH',
    ]);
    const thursday = rowsFor(fixture, 'GWP-CLASH', '[data-date="2026-10-01"]');
    expect(thursday.length).toBe(2);
    const [deleted, recurring] = thursday;
    // The worklog being replaced stays on show, struck through, until the sync deletes it.
    expect(deleted.getAttribute('data-pending-deletion')).toBe('true');
    expect(deleted.textContent).toContain('Existing entry');
    expect(recurring.getAttribute('data-pending-deletion')).toBeNull();
    expect(recurring.querySelector('.source-badge')?.getAttribute('data-source')).toBe('recurring');
    expect(recurring.textContent).toContain('Recurring');
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
        id: 's',
        issueKey: 'GWP-SYNC',
        summary: 'Sync test',
        weekdays: [4],
        startTime: '14:00',
        durationSeconds: 1800,
        enabled: true,
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
    expect(worklogs[0].generated).toBe(true);
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

  describe('filling allocations from activity', () => {
    const FRIDAY_EVENING = new Date(2026, 9, 2, 18);
    const FULL_DAY = 7.5 * 3600;
    const WEEK_KEY = '2026-09-28';
    let github: http.Server;
    let githubUrl: string;

    beforeAll(async () => {
      github = await mockGithub.startServer(0);
      const address = github.address();
      if (address === null || typeof address !== 'object') {
        throw new Error('mock GitHub server has no address');
      }
      githubUrl = `http://localhost:${address.port}`;
    });

    afterAll(async () => {
      await mockGithub.stopServer(github);
    });

    beforeEach(() => {
      mockGithub.resetMockGithub();
      TestBed.configureTestingModule({
        providers: [{ provide: NOW, useValue: () => FRIDAY_EVENING }],
      });
    });

    async function setUp(seed?: (settings: SettingsService) => void) {
      const fixture = await create((settings) => {
        settings.updateSettings({
          leaveIssueKey: 'HR-1',
          allocations: [{ id: 'u', issueKey: 'GWP-9', summary: 'Usual', percentage: 100 }],
        });
        seed?.(settings);
      });
      await settle(fixture);
      return fixture;
    }

    const withGithub = (settings: SettingsService) => {
      settings.setGithubCredentials({ token: 'token', apiUrl: githubUrl });
      settings.updateSettings({ placeholderIssueKey: 'GWP-100' });
    };

    async function fill(fixture: Awaited<ReturnType<typeof create>>) {
      q(fixture, 'fill-from-activity').click();
      await settle(fixture);
    }

    async function sync(fixture: Awaited<ReturnType<typeof create>>) {
      q(fixture, 'sync').click();
      await settle(fixture);
    }

    const weekAllocations = () => TestBed.inject(SettingsService).settings().weekAllocations;

    const nothingToSync = (fixture: Awaited<ReturnType<typeof create>>) => {
      expect(q(fixture, 'plan-summary').textContent).toContain('0 to create, 0 to delete');
      expect((q(fixture, 'sync') as HTMLButtonElement).disabled).toBe(true);
    };

    it('uses the usual allocations, and reads nothing from GitHub, until you press the button', async () => {
      const realFetch = globalThis.fetch;
      const urls: string[] = [];
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        urls.push(String(input));
        return realFetch(input, init);
      });
      let fixture: Awaited<ReturnType<typeof create>>;
      try {
        fixture = await setUp(withGithub);
      } finally {
        spy.mockRestore();
      }

      expect(urls.some((url) => url.startsWith(githubUrl))).toBe(false);
      expect(q(fixture, 'allocations-scope').textContent).toContain('Your usual allocations');
      expect(q(fixture, 'allocation-u').textContent).toContain('GWP-9');
      expect(root(fixture).querySelector('[data-testid="activity-panel"]')).toBeNull();
      const plan = fixture.componentInstance.plan();
      expect(new Set(plan.creations.map((creation) => creation.issueKey))).toEqual(
        new Set(['GWP-9']),
      );
      // Without the week's own allocations, automatic worklogs are kept as they are.
      expect(plan.deletions).toEqual([]);
    });

    it("fills the week's allocations from GitHub and Jira, then replaces the automatic worklogs", async () => {
      const fixture = await setUp(withGithub);
      await fill(fixture);
      const app = fixture.componentInstance;

      const allocations = weekAllocations()[WEEK_KEY];
      expect(Object.keys(weekAllocations())).toEqual([WEEK_KEY]);
      expect(allocations.map((allocation) => allocation.issueKey).sort()).toEqual([
        'GWP-100',
        'GWP-2070',
        'GWP-2080',
      ]);
      expect(allocations.reduce((sum, allocation) => sum + allocation.percentage, 0)).toBe(100);
      expect(allocations.find((a) => a.issueKey === 'GWP-2070')?.summary).toBe(
        'Rate limiting for the public API',
      );
      // The Allocations section now shows the week's allocations, with what each came from.
      expect(q(fixture, 'allocations-scope').textContent).toContain('Sep 28 – Oct 4 only');
      expect(root(fixture).querySelector('[data-testid="allocation-u"]')).toBeNull();
      const row = q(fixture, 'allocation-activity-GWP-2070');
      expect(row.textContent).toContain('Rate limiting for the public API');
      expect(row.textContent).toContain('acme/api#41');
      expect(row.textContent).toContain('automatic worklog');
      // Pull requests with no Jira key go to the placeholder ticket.
      const placeholder = q(fixture, 'allocation-activity-GWP-100').textContent;
      expect(placeholder).toContain('acme/tools#7');
      expect(placeholder).toContain('personal/dotfiles#3');
      // A pull request you only commented on is not your work.
      expect(q(fixture, 'settings-panel-allocations').textContent).not.toContain('acme/web#60');
      expect(q(fixture, 'status').textContent).toContain(
        'Filled the allocations for Sep 28 – Oct 4 from your activity.',
      );

      const plan = app.plan();
      expect(plan.deletions.map((deletion) => deletion.reason)).toEqual(
        Array(5).fill('replaced-by-activity'),
      );
      expect(new Set(plan.creations.map((creation) => creation.issueKey))).toEqual(
        new Set(['GWP-100', 'GWP-2070', 'GWP-2080']),
      );
      expect(plan.creations.every((creation) => creation.source === 'allocated')).toBe(true);

      await sync(fixture);
      expect(q(fixture, 'status').textContent).toMatch(/Synced: \d+ created, 5 deleted/);
      nothingToSync(fixture);
      const replaced = await TestBed.inject(JiraIntegrationService).fetchReplaced(WEEK);
      expect(replaced).toHaveLength(5);
      expect(app.worklogs().some((worklog) => worklog.comment === 'Leave (morning)')).toBe(true);

      // Filling again finds the replaced worklogs saved in Jira, so nothing changes.
      await fill(fixture);
      expect(weekAllocations()[WEEK_KEY]).toEqual(allocations);
      nothingToSync(fixture);
    });

    it('goes back to the usual allocations', async () => {
      const fixture = await setUp(withGithub);
      await fill(fixture);
      q(fixture, 'use-usual-allocations').click();
      await settle(fixture);

      expect(weekAllocations()).toEqual({});
      expect(q(fixture, 'allocations-scope').textContent).toContain('Your usual allocations');
      expect(q(fixture, 'allocation-u').textContent).toContain('GWP-9');
      expect(fixture.componentInstance.plan().deletions).toEqual([]);
    });

    it("edits the week's own allocations, not the usual ones, once the week has them", async () => {
      const fixture = await setUp(withGithub);
      await fill(fixture);
      const settings = TestBed.inject(SettingsService);
      const filled = weekAllocations()[WEEK_KEY];

      q(fixture, 'remove-allocation-activity-GWP-100').click();
      const type = (id: string, value: string) => {
        const field = q(fixture, id) as HTMLInputElement;
        field.value = value;
        field.dispatchEvent(new Event('input'));
      };
      type('alloc-issue-key', 'GWP-1999');
      type('alloc-summary', 'Design');
      type('alloc-percentage', '10');
      q(fixture, 'allocation-form').dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(fixture);

      expect(weekAllocations()[WEEK_KEY].map((allocation) => allocation.issueKey)).toEqual([
        ...filled.map((allocation) => allocation.issueKey).filter((key) => key !== 'GWP-100'),
        'GWP-1999',
      ]);
      expect(settings.settings().allocations.map((allocation) => allocation.issueKey)).toEqual([
        'GWP-9',
      ]);
      expect(q(fixture, 'allocation-activity-GWP-2070')).toBeTruthy();
    });

    it('fills from Jira alone without GitHub, and says so', async () => {
      const fixture = await setUp();
      await fill(fixture);
      expect(q(fixture, 'status').textContent).toContain("GitHub isn't set up");
      expect(
        weekAllocations()
          [WEEK_KEY].map((allocation) => allocation.issueKey)
          .sort(),
      ).toEqual(['GWP-2070', 'GWP-2080']);
    });

    it('reports a week with no activity and no placeholder ticket', async () => {
      const fixture = await setUp();
      q(fixture, 'next-week').click();
      await settle(fixture);
      await fill(fixture);
      expect(q(fixture, 'status').textContent).toContain('No activity found this week');
      expect(weekAllocations()).toEqual({});
    });

    it('fills with GET requests only, none of which fail', async () => {
      const fixture = await setUp(withGithub);
      const realFetch = globalThis.fetch;
      const requests: string[] = [];
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const response = await realFetch(input, init);
        requests.push(`${init?.method ?? 'GET'} ${response.status} ${String(input)}`);
        return response;
      });
      try {
        await fill(fixture);
      } finally {
        spy.mockRestore();
      }
      expect(requests.length).toBeGreaterThan(0);
      // Jira Cloud refused a POST from the browser with 403, and a 404 read as an error.
      expect(requests.filter((request) => !request.startsWith('GET 200 '))).toEqual([]);
    });

    it('loses no evidence when a sync fails part-way', async () => {
      const fixture = await setUp();
      await fill(fixture);
      const jira = TestBed.inject(JiraIntegrationService);
      const realDelete = jira.deleteWorklog.bind(jira);
      let calls = 0;
      const spy = vi.spyOn(jira, 'deleteWorklog').mockImplementation(async (issueKey, id) => {
        if (++calls === 2) {
          throw new Error('Network down');
        }
        return realDelete(issueKey, id);
      });

      await sync(fixture);
      spy.mockRestore();
      expect(q(fixture, 'status').textContent).toContain('Sync failed: Network down');
      expect(await jira.fetchReplaced(WEEK)).toHaveLength(5);
      const plan = fixture.componentInstance.plan();
      expect(plan.creations).toEqual([]);
      expect(plan.deletions.map((deletion) => deletion.reason)).toEqual(
        Array(4).fill('replaced-by-activity'),
      );

      await sync(fixture);
      expect(q(fixture, 'status').textContent).toContain('Synced: 0 created, 4 deleted');
      nothingToSync(fixture);
    });

    it('logs a day ticked as leave, remembers the tick through Jira, and removes it when unticked', async () => {
      const fixture = await setUp();
      const app = fixture.componentInstance;
      const tick = (weekday: number) =>
        root(fixture).querySelector<HTMLInputElement>(`[data-testid="leave-${weekday}"]`)!;
      expect(tick(4).checked).toBe(false);

      tick(4).click();
      fixture.detectChanges();
      expect(app.plan().creations.filter((creation) => creation.source === 'leave')).toEqual([
        {
          issueKey: 'HR-1',
          started: new Date(2026, 9, 1, 9).toISOString(),
          timeSpentSeconds: FULL_DAY,
          comment: 'Leave',
          source: 'leave',
        },
      ]);

      await sync(fixture);
      expect(tick(4).checked).toBe(true);
      nothingToSync(fixture);

      tick(4).click();
      fixture.detectChanges();
      expect(app.plan().deletions).toEqual([
        expect.objectContaining({ issueKey: 'HR-1', reason: 'stale-generated' }),
      ]);
    });
  });
});
