import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import type {
  CalendarEvent,
  ExecutionPlan,
  JiraCredentials,
  JiraWorklog,
  PercentageAllocation,
  RecurringSchedule,
  UserSettings,
} from './models/domain';
import { CalendarGridComponent } from './components/calendar-grid/calendar-grid';
import { SettingsPanelComponent } from './components/settings-panel/settings-panel';
import { WeekSelectorComponent } from './components/week-selector/week-selector';
import { JiraIntegrationService } from './services/jira-integration.service';
import { SettingsService } from './services/settings.service';
import { TimesheetEngineService } from './services/timesheet-engine.service';

export type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'syncing' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

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
  imports: [WeekSelectorComponent, SettingsPanelComponent, CalendarGridComponent],
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly settingsService = inject(SettingsService);
  private readonly jira = inject(JiraIntegrationService);
  private readonly engine = inject(TimesheetEngineService);

  readonly currentWeek = signal(startOfWeek(new Date()));
  readonly settings = this.settingsService.settings;
  readonly credentials = this.settingsService.credentials;
  readonly worklogs = signal<JiraWorklog[]>([]);
  readonly status = signal<SyncStatus>({ kind: 'idle' });

  readonly plan = computed<ExecutionPlan>(() =>
    this.engine.computePlan({
      weekStart: this.currentWeek(),
      settings: this.settings(),
      worklogs: this.worklogs(),
    }),
  );

  readonly derivedCalendarEvents = computed<CalendarEvent[]>(() => {
    const weekStart = this.currentWeek();
    const weekEnd = addDays(weekStart, 7);
    const plan = this.plan();

    const deleted = new Set(plan.deletions.map((deletion) => deletion.worklogId));
    const existing: CalendarEvent[] = this.worklogs()
      .filter(
        (worklog) => worklog.started >= weekStart && worklog.started < weekEnd && !deleted.has(worklog.id),
      )
      .map((worklog) => ({
        id: `jira-${worklog.id}`,
        issueKey: worklog.issueKey,
        summary: worklog.comment ?? worklog.issueKey,
        start: worklog.started,
        end: new Date(worklog.started.getTime() + worklog.timeSpentSeconds * 1000),
        timeSpentSeconds: worklog.timeSpentSeconds,
        source: 'jira' as const,
        worklogId: worklog.id,
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
    const keys = new Set<string>();
    for (const schedule of settings.schedules) {
      keys.add(schedule.issueKey);
    }
    for (const allocation of settings.allocations) {
      keys.add(allocation.issueKey);
    }
    return [...keys].filter((key) => key.trim() !== '').sort().join(',');
  });

  private loadRequest = 0;

  constructor() {
    effect(() => {
      const week = this.currentWeek();
      const keys = this.issueKeys();
      this.credentials();
      untracked(() => void this.loadWorklogs(week, keys));
    });
  }

  protected setWeek(week: Date): void {
    this.currentWeek.set(startOfWeek(week));
  }

  protected onWorkHoursChanged(change: Pick<UserSettings, 'startTime' | 'hoursPerDay' | 'workDays'>): void {
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

  async reload(): Promise<void> {
    await this.loadWorklogs(this.currentWeek(), this.issueKeys());
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
    this.status.set({ kind: 'syncing' });
    try {
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
      const worklogs = await this.fetchAll(this.currentWeek(), this.issueKeys());
      this.worklogs.set(worklogs);
      this.status.set({
        kind: 'success',
        message: `Synced: ${plan.creations.length} created, ${plan.deletions.length} deleted`,
      });
    } catch (error) {
      this.status.set({ kind: 'error', message: `Sync failed: ${errorMessage(error)}` });
    }
  }

  private async loadWorklogs(week: Date, keys: string): Promise<void> {
    const request = ++this.loadRequest;
    this.status.set({ kind: 'loading' });
    try {
      const worklogs = await this.fetchAll(week, keys);
      if (request !== this.loadRequest) {
        return;
      }
      this.worklogs.set(worklogs);
      this.status.set({ kind: 'idle' });
    } catch (error) {
      if (request !== this.loadRequest) {
        return;
      }
      this.status.set({ kind: 'error', message: `Could not load worklogs: ${errorMessage(error)}` });
    }
  }

  // The user's worklogs anywhere in Jira that week, plus the configured issues so that worklogs
  // this app just wrote show up before Jira's search index catches up.
  private fetchAll(week: Date, keys: string): Promise<JiraWorklog[]> {
    return this.jira.fetchMyWorklogs(week, addDays(week, 7), keys === '' ? [] : keys.split(','));
  }
}
