import { Injectable, signal } from '@angular/core';
import type {
  JiraCredentials,
  PercentageAllocation,
  RecurringSchedule,
  UserSettings,
} from '../models/domain';

const SETTINGS_KEY = 'jira-timesheets:settings';
const CREDENTIALS_KEY = 'jira-timesheets:credentials';

const DEFAULT_SETTINGS: UserSettings = {
  startTime: '09:00',
  hoursPerDay: 7.5,
  workDays: [1, 2, 3, 4, 5],
  allocations: [],
  schedules: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultSettings(): UserSettings {
  return {
    ...DEFAULT_SETTINGS,
    workDays: [...DEFAULT_SETTINGS.workDays],
    allocations: [],
    schedules: [],
  };
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  readonly settings = signal<UserSettings>(this.loadSettings());
  readonly credentials = signal<JiraCredentials | null>(this.loadCredentials());

  updateSettings(partial: Partial<UserSettings>): void {
    this.settings.update((current) => ({ ...current, ...partial }));
    this.persistSettings(this.settings());
  }

  setAllocations(allocations: PercentageAllocation[]): void {
    this.updateSettings({ allocations });
  }

  addAllocation(allocation: PercentageAllocation): void {
    this.settings.update((current) => ({
      ...current,
      allocations: [...current.allocations, allocation],
    }));
    this.persistSettings(this.settings());
  }

  removeAllocation(id: string): void {
    this.settings.update((current) => ({
      ...current,
      allocations: current.allocations.filter((item) => item.id !== id),
    }));
    this.persistSettings(this.settings());
  }

  setSchedules(schedules: RecurringSchedule[]): void {
    this.updateSettings({ schedules });
  }

  addSchedule(schedule: RecurringSchedule): void {
    this.settings.update((current) => ({
      ...current,
      schedules: [...current.schedules, schedule],
    }));
    this.persistSettings(this.settings());
  }

  removeSchedule(id: string): void {
    this.settings.update((current) => ({
      ...current,
      schedules: current.schedules.filter((item) => item.id !== id),
    }));
    this.persistSettings(this.settings());
  }

  setCredentials(credentials: JiraCredentials): void {
    this.credentials.set(credentials);
    this.persistCredentials(credentials);
  }

  clearCredentials(): void {
    this.credentials.set(null);
    localStorage.removeItem(CREDENTIALS_KEY);
  }

  private loadSettings(): UserSettings {
    const raw = this.readJson(SETTINGS_KEY);
    if (!isRecord(raw)) {
      return defaultSettings();
    }
    const settings = defaultSettings();
    if (typeof raw['startTime'] === 'string') {
      settings.startTime = raw['startTime'];
    }
    if (typeof raw['hoursPerDay'] === 'number' && Number.isFinite(raw['hoursPerDay'])) {
      settings.hoursPerDay = raw['hoursPerDay'];
    }
    if (Array.isArray(raw['workDays'])) {
      settings.workDays = raw['workDays'].filter(
        (value): value is number => typeof value === 'number' && Number.isInteger(value),
      );
    }
    if (Array.isArray(raw['allocations'])) {
      settings.allocations = raw['allocations'] as PercentageAllocation[];
    }
    if (Array.isArray(raw['schedules'])) {
      settings.schedules = raw['schedules'] as RecurringSchedule[];
    }
    return settings;
  }

  private loadCredentials(): JiraCredentials | null {
    const raw = this.readJson(CREDENTIALS_KEY);
    if (
      isRecord(raw) &&
      typeof raw['email'] === 'string' &&
      typeof raw['apiToken'] === 'string' &&
      typeof raw['host'] === 'string'
    ) {
      return { email: raw['email'], apiToken: raw['apiToken'], host: raw['host'] };
    }
    return null;
  }

  private readJson(key: string): unknown {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private persistSettings(settings: UserSettings): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  private persistCredentials(credentials: JiraCredentials): void {
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
  }
}
