import {
  Component,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type {
  ActivityIssueSummary,
  CalendarEvent,
  EngineInput,
  ExecutionPlan,
  GithubCredentials,
  JiraCredentials,
  JiraWorklog,
  PercentageAllocation,
  RecurringSchedule,
  UnkeyedPullRequest,
  UserSettings,
} from './models/domain';
import { ActivityPanelComponent } from './components/activity-panel/activity-panel';
import { CalendarGridComponent } from './components/calendar-grid/calendar-grid';
import {
  type ActivitySettingsChange,
  SettingsPanelComponent,
} from './components/settings-panel/settings-panel';
import { WeekSelectorComponent } from './components/week-selector/week-selector';
import { weekEvidence } from './services/activity-distribution';
import { ActivityService, NO_ACTIVITY, type WeekActivity } from './services/activity.service';
import { JiraIntegrationService } from './services/jira-integration.service';
import { leaveDayState } from './services/leave-planner';
import { SettingsService } from './services/settings.service';
import { TimesheetEngineService } from './services/timesheet-engine.service';

/** The current time; tests replace it to plan a week as of a fixed day. */
export const NOW = new InjectionToken<() => Date>('NOW', { factory: () => () => new Date() });

export type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'syncing' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

interface WeekData {
  worklogs: JiraWorklog[];
  absorbed: JiraWorklog[];
  activity: WeekActivity;
}

export function startOfWeek(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - offset);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function weekKey(week: Date): string {
  return String(week.getTime());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

@Component({
  selector: 'app-root',
  imports: [
    WeekSelectorComponent,
    SettingsPanelComponent,
    CalendarGridComponent,
    ActivityPanelComponent,
  ],
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly settingsService = inject(SettingsService);
  private readonly jira = inject(JiraIntegrationService);
  private readonly engine = inject(TimesheetEngineService);
  private readonly activityService = inject(ActivityService);
  private readonly now = inject(NOW);

  readonly currentWeek = signal(startOfWeek(this.now()));
  readonly settings = this.settingsService.settings;
  readonly credentials = this.settingsService.credentials;
  readonly githubCredentials = this.settingsService.githubCredentials;
  readonly worklogs = signal<JiraWorklog[]>([]);
  /** Automatic worklogs that earlier syncs of this week replaced. */
  readonly absorbed = signal<JiraWorklog[]>([]);
  readonly weekActivity = signal<WeekActivity>(NO_ACTIVITY);
  readonly status = signal<SyncStatus>({ kind: 'idle' });
  /** Leave ticks changed in the preview and not yet synced, by week. */
  private readonly leaveOverrides = signal<Record<string, number[]>>({});

  readonly leaveState = computed(() =>
    leaveDayState(this.currentWeek(), this.settings(), this.weekWorklogs()),
  );

  readonly leaveDays = computed(
    () => this.leaveOverrides()[weekKey(this.currentWeek())] ?? this.leaveState().ticked,
  );

  readonly leaveEnabled = computed(() => this.settings().leaveIssueKey.trim() !== '');

  private readonly engineInput = computed<EngineInput>(() => ({
    weekStart: this.currentWeek(),
    settings: this.settings(),
    worklogs: this.worklogs(),
    activity: this.weekActivity().events,
    absorbed: this.absorbed(),
    leaveDays: this.leaveEnabled() ? this.leaveDays() : [],
    now: this.now(),
  }));

  readonly plan = computed<ExecutionPlan>(() => this.engine.computePlan(this.engineInput()));

  private readonly weekWorklogs = computed(() => {
    const weekStart = this.currentWeek();
    const weekEnd = addDays(weekStart, 7);
    return this.worklogs().filter(
      (worklog) => worklog.started >= weekStart && worklog.started < weekEnd,
    );
  });

  readonly derivedCalendarEvents = computed<CalendarEvent[]>(() => {
    const plan = this.plan();
    const deleted = new Set(plan.deletions.map((deletion) => deletion.worklogId));
    const existing: CalendarEvent[] = this.weekWorklogs().map((worklog) => ({
      id: `jira-${worklog.id}`,
      issueKey: worklog.issueKey,
      summary: worklog.comment ?? worklog.issueKey,
      start: worklog.started,
      end: new Date(worklog.started.getTime() + worklog.timeSpentSeconds * 1000),
      timeSpentSeconds: worklog.timeSpentSeconds,
      source: 'jira' as const,
      worklogId: worklog.id,
      ...(deleted.has(worklog.id) ? { pendingDeletion: true } : {}),
    }));

    const planned: CalendarEvent[] = plan.creations.map((creation, index) => {
      const start = new Date(creation.started);
      return {
        id: `planned-${index}`,
        issueKey: creation.issueKey,
        summary: creation.comment ?? creation.issueKey,
        start,
        end: new Date(start.getTime() + creation.timeSpentSeconds * 1000),
        timeSpentSeconds: creation.timeSpentSeconds,
        source: creation.source,
      };
    });

    return [...existing, ...planned];
  });

  /** The issues the week's evidence points at, with the time each ends up with. */
  readonly activityIssues = computed<ActivityIssueSummary[]>(() => {
    if (!this.settings().activityMode) {
      return [];
    }
    const plan = this.plan();
    const deleted = new Set(plan.deletions.map((deletion) => deletion.worklogId));
    const seconds = new Map<string, number>();
    const addTime = (issueKey: string, time: number) =>
      seconds.set(issueKey, (seconds.get(issueKey) ?? 0) + time);
    for (const worklog of this.weekWorklogs()) {
      if (!deleted.has(worklog.id)) {
        addTime(worklog.issueKey, worklog.timeSpentSeconds);
      }
    }
    for (const creation of plan.creations) {
      addTime(creation.issueKey, creation.timeSpentSeconds);
    }

    const issues = new Map<string, ActivityIssueSummary>();
    const issue = (issueKey: string) => {
      let entry = issues.get(issueKey);
      if (entry === undefined) {
        entry = {
          issueKey,
          summary: this.weekActivity().summaries.get(issueKey) ?? '',
          plannedSeconds: seconds.get(issueKey) ?? 0,
          pullRequests: [],
          jiraWorklogs: 0,
        };
        issues.set(issueKey, entry);
      }
      return entry;
    };
    for (const event of weekEvidence(this.engineInput())) {
      const entry = issue(event.issueKey);
      if (event.kind === 'jira-worklog') {
        entry.jiraWorklogs++;
        continue;
      }
      const name = event.id.replace(/^gh:([^:]+):.*$/, '$1');
      const pull = entry.pullRequests.find((candidate) => candidate.name === name);
      if (pull === undefined) {
        entry.pullRequests.push({ name, url: event.url, actions: 1 });
      } else {
        pull.actions++;
      }
    }
    const placeholder = this.settings().placeholderIssueKey.trim();
    if (placeholder !== '' && (seconds.get(placeholder) ?? 0) > 0) {
      issue(placeholder);
    }
    return [...issues.values()].sort(
      (a, b) => b.plannedSeconds - a.plannedSeconds || a.issueKey.localeCompare(b.issueKey),
    );
  });

  readonly unkeyedPullRequests = computed<UnkeyedPullRequest[]>(() =>
    this.weekActivity()
      .pulls.filter((mapped) => mapped.unkeyed)
      .map(({ pull }) => ({
        name: `${pull.repo}#${pull.number}`,
        title: pull.title,
        url: pull.url,
      })),
  );

  readonly activityWarnings = computed<string[]>(() => {
    if (!this.settings().activityMode) {
      return [];
    }
    const warnings = [...this.weekActivity().warnings];
    const placeholder = this.settings().placeholderIssueKey.trim();
    if (placeholder === '' && this.unkeyedPullRequests().length > 0) {
      warnings.push('Some pull requests have no Jira key. Set a placeholder ticket to log them.');
    }
    if (placeholder === '' && this.activityIssues().length === 0) {
      warnings.push(
        'No activity found this week. Set a placeholder ticket to fill the week anyway.',
      );
    }
    return warnings;
  });

  readonly hasPendingChanges = computed(
    () => this.plan().creations.length > 0 || this.plan().deletions.length > 0,
  );

  readonly statusMessage = computed(() => {
    const status = this.status();
    return status.kind === 'success' || status.kind === 'error' ? status.message : '';
  });

  readonly busy = computed(() => {
    const kind = this.status().kind;
    return kind === 'loading' || kind === 'syncing';
  });

  private readonly issueKeys = computed(() => {
    const settings = this.settings();
    const keys = new Set<string>([settings.leaveIssueKey, settings.placeholderIssueKey]);
    for (const schedule of settings.schedules) {
      keys.add(schedule.issueKey);
    }
    for (const allocation of settings.allocations) {
      keys.add(allocation.issueKey);
    }
    return [...keys]
      .map((key) => key.trim())
      .filter((key) => key !== '')
      .sort()
      .join(',');
  });

  /** Everything that changes what a week load reads. */
  private readonly loadKey = computed(() => {
    const settings = this.settings();
    return JSON.stringify([
      this.issueKeys(),
      settings.activityMode,
      settings.placeholderIssueKey,
      settings.githubOrgs,
    ]);
  });

  private loadRequest = 0;

  constructor() {
    effect(() => {
      const week = this.currentWeek();
      this.loadKey();
      this.credentials();
      this.githubCredentials();
      untracked(() => void this.loadWeek(week));
    });
  }

  protected setWeek(week: Date): void {
    this.currentWeek.set(startOfWeek(week));
  }

  protected onWorkHoursChanged(
    change: Pick<UserSettings, 'startTime' | 'hoursPerDay' | 'workDays'>,
  ): void {
    this.settingsService.updateSettings(change);
  }

  protected onActivitySettingsChanged(change: ActivitySettingsChange): void {
    this.settingsService.updateSettings(change);
  }

  protected onAllocationAdded(allocation: PercentageAllocation): void {
    this.settingsService.addAllocation(allocation);
  }

  protected onAllocationRemoved(id: string): void {
    this.settingsService.removeAllocation(id);
  }

  protected onScheduleAdded(schedule: RecurringSchedule): void {
    this.settingsService.addSchedule(schedule);
  }

  protected onScheduleRemoved(id: string): void {
    this.settingsService.removeSchedule(id);
  }

  protected onCredentialsChanged(credentials: JiraCredentials | null): void {
    if (credentials === null) {
      this.settingsService.clearCredentials();
    } else {
      this.settingsService.setCredentials(credentials);
    }
    this.jira.refreshClient();
  }

  protected onGithubCredentialsChanged(credentials: GithubCredentials | null): void {
    if (credentials === null) {
      this.settingsService.clearGithubCredentials();
    } else {
      this.settingsService.setGithubCredentials(credentials);
    }
  }

  /** Ticks or unticks a day as leave in the preview; syncing logs it. */
  toggleLeave(weekday: number): void {
    if (!this.leaveEnabled() || this.leaveState().locked.includes(weekday)) {
      return;
    }
    const current = this.leaveDays();
    const next = current.includes(weekday)
      ? current.filter((day) => day !== weekday)
      : [...current, weekday].sort((a, b) => a - b);
    const key = weekKey(this.currentWeek());
    this.leaveOverrides.update((overrides) => ({ ...overrides, [key]: next }));
  }

  async reload(): Promise<void> {
    await this.loadWeek(this.currentWeek());
  }

  async syncWeek(): Promise<void> {
    if (this.busy()) {
      return;
    }
    const plan = this.plan();
    if (plan.creations.length === 0 && plan.deletions.length === 0) {
      this.status.set({ kind: 'success', message: 'Nothing to sync' });
      return;
    }
    const week = this.currentWeek();
    this.status.set({ kind: 'syncing' });
    try {
      // Remember what is replaced before touching anything, so its evidence outlives it.
      await this.jira.saveReplaced(week, plan.absorb);
      // Create before deleting: if a request fails part-way, Jira keeps extra time, not loses it.
      for (const creation of plan.creations) {
        await this.jira.createWorklog(
          creation.issueKey,
          creation.started,
          creation.timeSpentSeconds,
          creation.comment,
        );
      }
      for (const deletion of plan.deletions) {
        await this.jira.deleteWorklog(deletion.issueKey, deletion.worklogId);
      }
      await this.refreshJira(week);
      this.status.set({
        kind: 'success',
        message: `Synced: ${plan.creations.length} created, ${plan.deletions.length} deleted`,
      });
    } catch (error) {
      await this.refreshJira(week).catch(() => undefined);
      this.status.set({ kind: 'error', message: `Sync failed: ${errorMessage(error)}` });
    }
  }

  /** Reloads the week's worklogs after a sync; the leave ticks now live in Jira. */
  private async refreshJira(week: Date): Promise<void> {
    const [worklogs, absorbed] = await Promise.all([
      this.fetchWorklogs(week),
      this.settings().activityMode ? this.jira.fetchReplaced(week) : Promise.resolve([]),
    ]);
    this.worklogs.set(worklogs);
    this.absorbed.set(absorbed);
    this.leaveOverrides.update((overrides) => {
      const remaining = { ...overrides };
      delete remaining[weekKey(week)];
      return remaining;
    });
  }

  private async loadWeek(week: Date): Promise<void> {
    const request = ++this.loadRequest;
    this.status.set({ kind: 'loading' });
    try {
      const data = await this.fetchWeek(week);
      if (request !== this.loadRequest) {
        return;
      }
      this.worklogs.set(data.worklogs);
      this.absorbed.set(data.absorbed);
      this.weekActivity.set(data.activity);
      this.status.set({ kind: 'idle' });
    } catch (error) {
      if (request !== this.loadRequest) {
        return;
      }
      this.status.set({
        kind: 'error',
        message: `Could not load worklogs: ${errorMessage(error)}`,
      });
    }
  }

  private async fetchWeek(week: Date): Promise<WeekData> {
    const settings = this.settings();
    if (!settings.activityMode) {
      return { worklogs: await this.fetchWorklogs(week), absorbed: [], activity: NO_ACTIVITY };
    }
    const [worklogs, absorbed, pulls] = await Promise.all([
      this.fetchWorklogs(week),
      this.jira.fetchReplaced(week),
      this.activityService.fetchPullRequests(week, addDays(week, 7)),
    ]);
    const activity = await this.activityService.toEvidence(
      pulls,
      settings.placeholderIssueKey,
      [...worklogs, ...absorbed].map((worklog) => worklog.issueKey),
    );
    return { worklogs, absorbed, activity };
  }

  // The user's worklogs anywhere in Jira that week, plus the configured issues so that worklogs
  // this app just wrote show up before Jira's search index catches up.
  private fetchWorklogs(week: Date): Promise<JiraWorklog[]> {
    const keys = this.issueKeys();
    return this.jira.fetchMyWorklogs(week, addDays(week, 7), keys === '' ? [] : keys.split(','));
  }
}
