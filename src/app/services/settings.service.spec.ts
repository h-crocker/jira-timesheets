import { SettingsService } from './settings.service';
import type { PercentageAllocation, RecurringSchedule } from '../models/domain';

const SETTINGS_KEY = 'jira-timesheets:settings';
const CREDENTIALS_KEY = 'jira-timesheets:credentials';

const DEFAULTS = {
  startTime: '09:00',
  hoursPerDay: 7.5,
  workDays: [1, 2, 3, 4, 5],
  allocations: [],
  schedules: [],
  weekAllocations: {},
  leaveIssueKey: '',
  placeholderIssueKey: '',
  githubOrgs: [],
};

const ALLOCATION: PercentageAllocation = {
  id: 'activity-GWP-1',
  issueKey: 'GWP-1',
  summary: 'Work',
  percentage: 100,
};

describe('SettingsService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts with default settings and no credentials', () => {
    const service = new SettingsService();
    expect(service.settings()).toEqual(DEFAULTS);
    expect(service.credentials()).toBeNull();
  });

  it('loads persisted settings and credentials on construction', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ startTime: '08:30', hoursPerDay: 8, workDays: [1, 2], allocations: [], schedules: [] }),
    );
    localStorage.setItem(
      CREDENTIALS_KEY,
      JSON.stringify({ email: 'dev@example.com', apiToken: 'token-123', host: 'https://example.atlassian.net' }),
    );

    const service = new SettingsService();
    expect(service.settings()).toEqual({
      ...DEFAULTS,
      startTime: '08:30',
      hoursPerDay: 8,
      workDays: [1, 2],
    });
    expect(service.credentials()).toEqual({
      email: 'dev@example.com',
      apiToken: 'token-123',
      host: 'https://example.atlassian.net',
    });
  });

  it('falls back to defaults when stored JSON is corrupt', () => {
    localStorage.setItem(SETTINGS_KEY, '{corrupt-json');
    localStorage.setItem(CREDENTIALS_KEY, 'not-json-at-all');

    const service = new SettingsService();
    expect(service.settings()).toEqual(DEFAULTS);
    expect(service.credentials()).toBeNull();
  });

  it('falls back to defaults when stored settings are not an object', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify([1, 2, 3]));
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify('just-a-string'));

    const service = new SettingsService();
    expect(service.settings()).toEqual(DEFAULTS);
    expect(service.credentials()).toBeNull();
  });

  it('updateSettings merges the partial and persists it', () => {
    const service = new SettingsService();
    service.updateSettings({ startTime: '10:00', workDays: [1, 2, 3] });

    expect(service.settings().startTime).toBe('10:00');
    expect(service.settings().workDays).toEqual([1, 2, 3]);
    expect(service.settings().hoursPerDay).toBe(7.5);
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '');
    expect(stored.startTime).toBe('10:00');
    expect(stored.workDays).toEqual([1, 2, 3]);
  });

  it('allocation mutators update the signal and localStorage', () => {
    const service = new SettingsService();
    const allocation: PercentageAllocation = {
      id: 'a1',
      issueKey: 'GWP-1',
      summary: 'Allocation one',
      percentage: 50,
    };

    service.addAllocation(allocation);
    expect(service.settings().allocations).toEqual([allocation]);

    service.setAllocations([]);
    expect(service.settings().allocations).toEqual([]);

    service.addAllocation(allocation);
    service.removeAllocation('a1');
    expect(service.settings().allocations).toEqual([]);

    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '');
    expect(stored.allocations).toEqual([]);
  });

  it('schedule mutators update the signal and localStorage', () => {
    const service = new SettingsService();
    const schedule: RecurringSchedule = {
      id: 's1',
      issueKey: 'GWP-2',
      summary: 'Standup',
      weekdays: [1, 3],
      startTime: '09:00',
      durationSeconds: 1800,
      enabled: true,
    };

    service.addSchedule(schedule);
    expect(service.settings().schedules).toEqual([schedule]);

    service.setSchedules([]);
    expect(service.settings().schedules).toEqual([]);

    service.addSchedule(schedule);
    service.removeSchedule('s1');
    expect(service.settings().schedules).toEqual([]);

    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '');
    expect(stored.schedules).toEqual([]);
  });

  it('setCredentials persists and clearCredentials removes', () => {
    const service = new SettingsService();
    const credentials = {
      email: 'dev@example.com',
      apiToken: 'secret-token',
      host: 'https://example.atlassian.net',
    };

    service.setCredentials(credentials);
    expect(service.credentials()).toEqual(credentials);
    expect(JSON.parse(localStorage.getItem(CREDENTIALS_KEY) ?? '')).toEqual(credentials);

    service.clearCredentials();
    expect(service.credentials()).toBeNull();
    expect(localStorage.getItem(CREDENTIALS_KEY)).toBeNull();
  });

  it('loads the activity settings, ignoring values of the wrong type', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        leaveIssueKey: 'HR-1',
        placeholderIssueKey: 42,
        githubOrgs: ['acme', 7],
        weekAllocations: { '2026-09-28': [ALLOCATION], '2026-10-05': 'nope' },
      }),
    );
    expect(new SettingsService().settings()).toEqual({
      ...DEFAULTS,
      leaveIssueKey: 'HR-1',
      githubOrgs: ['acme'],
      weekAllocations: { '2026-09-28': [ALLOCATION] },
    });
  });

  it("sets and clears one week's allocations, leaving the others", () => {
    const service = new SettingsService();
    service.setWeekAllocations('2026-09-28', [ALLOCATION]);
    service.setWeekAllocations('2026-10-05', []);
    service.clearWeekAllocations('2026-10-05');

    expect(service.settings().weekAllocations).toEqual({ '2026-09-28': [ALLOCATION] });
    expect(new SettingsService().settings().weekAllocations).toEqual({
      '2026-09-28': [ALLOCATION],
    });
    expect(service.settings().allocations).toEqual([]);
  });

  it('keeps the GitHub token apart from the Jira credentials', () => {
    const service = new SettingsService();
    expect(service.githubCredentials()).toBeNull();

    service.setGithubCredentials({ token: 'gh-token', apiUrl: 'https://api.github.com' });
    expect(new SettingsService().githubCredentials()).toEqual({
      token: 'gh-token',
      apiUrl: 'https://api.github.com',
    });
    expect(localStorage.getItem(CREDENTIALS_KEY)).toBeNull();

    service.clearGithubCredentials();
    expect(service.githubCredentials()).toBeNull();
    expect(new SettingsService().githubCredentials()).toBeNull();
  });
});
