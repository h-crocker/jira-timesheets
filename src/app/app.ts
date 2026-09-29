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
  ActivityEvent,
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
import {
  type ActivityWeek,
  activityAllocations,
  weekEvidence,
} from './services/activity-allocations';
import { ActivityService, type WeekActivity } from './services/activity.service';
import { JiraIntegrationService } from './services/jira-integration.service';
import { leaveDayState } from './services/leave-planner';
import { weekKey } from './services/schedule-time';
import { SettingsService } from './services/settings.service';
import { TimesheetEngineService } from './services/timesheet-engine.service';

/** The current time; tests replace it to plan a week as of a fixed day. */
export const NOW = new InjectionToken<() => Date>('NOW', { factory: () => () => new Date() });

export type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'syncing' }
  | { kind: 'filling' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

/** What the last "Fill allocations from activity" found, to show how it got its numbers. */
interface Fill {
  week: string;
  activity: WeekActivity;
  evidence: ActivityEvent[];
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
  private readonly lastFill = signal<Fill | null>(null);
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
    leaveDays: this.leaveEnabled() ? this.leaveDays() : [],
  }));

  /** The week's own allocations, filled from activity, or null when it uses the usual ones. */
  readonly weekAllocations = computed(
    () => this.settings().weekAllocations[weekKey(this.currentWeek())] ?? null,
  );

  /** The last fill, if it was for the week on show. */
  private readonly fill = computed(() => {
    const fill = this.lastFill();
    return fill !== null && fill.week === weekKey(this.currentWeek()) ? fill : null;
  });

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

  /** The evidence behind each of the week's allocations, from the last fill. */
  readonly activityIssues = computed<ActivityIssueSummary[]>(() => {
    const fill = this.fill();
    if (fill === null) {
      return [];
    }
    const percentages = new Map(
      (this.weekAllocations() ?? []).map((allocation) => [
        allocation.issueKey,
        allocation.percentage,
      ]),
    );
    const issues = new Map<string, ActivityIssueSummary>();
    for (const event of fill.evidence) {
      let entry = issues.get(event.issueKey);
      if (entry === undefined) {
        entry = {
          issueKey: event.issueKey,
          summary: fill.activity.summaries.get(event.issueKey) ?? '',
          percentage: percentages.get(event.issueKey) ?? 0,
          pullRequests: [],
          jiraWorklogs: 0,
        };
        issues.set(event.issueKey, entry);
      }
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
    return [...issues.values()];
  });

  readonly unkeyedPullRequests = computed<UnkeyedPullRequest[]>(() =>
    (this.fill()?.activity.pulls ?? [])
      .filter((mapped) => mapped.unkeyed)
      .map(({ pull }) => ({
        name: `${pull.repo}#${pull.number}`,
        title: pull.title,
        url: pull.url,
      })),
  );

  readonly activityWarnings = computed<string[]>(() => {
    const fill = this.fill();
    if (fill === null) {
      return [];
    }
    const warnings = [...fill.activity.warnings];
    if (
      this.settings().placeholderIssueKey.trim() === '' &&
      this.unkeyedPullRequests().length > 0
    ) {
      warnings.push('Some pull requests have no Jira key. Set a placeholder ticket to log them.');
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
    return kind === 'loading' || kind === 'syncing' || kind === 'filling';
  });

  private readonly issueKeys = computed(() => {
    const settings = this.settings();
    const keys = new Set<string>([settings.leaveIssueKey, settings.placeholderIssueKey]);
    for (const schedule of settings.schedules) {
      keys.add(schedule.issueKey);
    }
    for (const allocation of [...settings.allocations, ...(this.weekAllocations() ?? [])]) {
      keys.add(allocation.issueKey);
    }
    return [...keys]
      .map((key) => key.trim())
      .filter((key) => key !== '')
      .sort()
      .join(',');
  });

  private loadRequest = 0;

  constructor() {
    effect(() => {
      const week = this.currentWeek();
      this.issueKeys();
      this.credentials();
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

  /**
   * Sets this week's allocations from what you worked on: your GitHub pull requests, Jira's
   * automatic worklogs, and those earlier syncs replaced.
   */
  async fillFromActivity(): Promise<void> {
    if (this.busy()) {
      return;
    }
    const week = this.currentWeek();
    const settings = this.settings();
    this.status.set({ kind: 'filling' });
    try {
      const [pulls, absorbed] = await Promise.all([
        this.activityService.fetchPullRequests(week, addDays(week, 7)),
        this.jira.fetchReplaced(week),
      ]);
      const jiraOnly: ActivityWeek = {
        weekStart: week,
        settings,
        worklogs: this.worklogs(),
        leaveDays: this.leaveEnabled() ? this.leaveDays() : [],
        activity: [],
        absorbed,
      };
      const activity = await this.activityService.toEvidence(
        pulls,
        settings.placeholderIssueKey,
        weekEvidence(jiraOnly).map((event) => event.issueKey),
      );
      const activityWeek = { ...jiraOnly, activity: activity.events };
      const allocations = activityAllocations(activityWeek, activity.summaries);
      this.lastFill.set({ week: weekKey(week), activity, evidence: weekEvidence(activityWeek) });
      if (allocations.length === 0) {
        this.status.set({
          kind: 'error',
          message: 'No activity found this week. Set a placeholder ticket to fill it anyway.',
        });
        return;
      }
      this.status.set({ kind: 'idle' });
      this.settingsService.setWeekAllocations(weekKey(week), allocations);
    } catch (error) {
      this.status.set({
        kind: 'error',
        message: `Could not fill allocations: ${errorMessage(error)}`,
      });
    }
  }

  /** Goes back to the usual allocations for the week on show. */
  clearWeekAllocations(): void {
    this.settingsService.clearWeekAllocations(weekKey(this.currentWeek()));
    this.lastFill.set(null);
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
    this.worklogs.set(await this.fetchWorklogs(week));
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
      const worklogs = await this.fetchWorklogs(week);
      if (request !== this.loadRequest) {
        return;
      }
      this.worklogs.set(worklogs);
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

  // The user's worklogs anywhere in Jira that week, plus the configured issues so that worklogs
  // this app just wrote show up before Jira's search index catches up.
  private fetchWorklogs(week: Date): Promise<JiraWorklog[]> {
    const keys = this.issueKeys();
    return this.jira.fetchMyWorklogs(week, addDays(week, 7), keys === '' ? [] : keys.split(','));
  }
}
