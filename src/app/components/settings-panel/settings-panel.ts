import { Component, input, output, signal } from '@angular/core';
import {
  type GithubCredentials,
  type JiraCredentials,
  LAST_WEEK_OF_MONTH,
  type PercentageAllocation,
  type RecurringSchedule,
  type ScheduleRepeat,
  type UserSettings,
} from '../../models/domain';

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKS_OF_MONTH: { value: number; label: string }[] = [
  { value: 1, label: '1st' },
  { value: 2, label: '2nd' },
  { value: 3, label: '3rd' },
  { value: 4, label: '4th' },
  { value: LAST_WEEK_OF_MONTH, label: 'last' },
];

/** A local yyyy-mm-dd date. */
function dateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The Monday of the week a yyyy-mm-dd date falls in, or null when it isn't a date. */
function mondayOf(key: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) {
    return null;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return dateKey(date);
}

/** Sep 28, from a yyyy-mm-dd date. */
function shortDate(key: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return match === null ? key : `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}`;
}

export type WorkHoursChange = Pick<
  UserSettings,
  'startTime' | 'hoursPerDay' | 'lunchMinutes' | 'workDays'
>;

export type ActivitySettingsChange = Pick<
  UserSettings,
  'leaveIssueKey' | 'placeholderIssueKey' | 'githubOrgs'
>;

@Component({
  selector: 'app-settings-panel',
  templateUrl: './settings-panel.html',
  styleUrl: './settings-panel.scss',
})
export class SettingsPanelComponent {
  settings = input.required<UserSettings>();
  credentials = input<JiraCredentials | null>(null);
  githubCredentials = input<GithubCredentials | null>(null);
  /** The allocations of the week on show, when it has its own; null when it uses the usual ones. */
  weekAllocations = input<PercentageAllocation[] | null>(null);
  /** The week on show, e.g. "Sep 28 – Oct 4". */
  weekLabel = input('');
  /** The Monday of the week on show, which a new fortnightly schedule starts from. */
  weekStart = input<Date | null>(null);
  /** What each of the week's allocations was filled from, by issue key. */
  allocationEvidence = input<Record<string, string>>({});
  /** Disables filling while the app is busy. */
  busy = input(false);

  workHoursChanged = output<WorkHoursChange>();
  allocationAdded = output<PercentageAllocation>();
  /** An allocation edited in place, with the same id. */
  allocationChanged = output<PercentageAllocation>();
  allocationRemoved = output<string>();
  /** The issue key prefixes whose allocations are scattered through the week. */
  spreadPrefixesChanged = output<string[]>();
  fillFromActivity = output<void>();
  useUsualAllocations = output<void>();
  scheduleAdded = output<RecurringSchedule>();
  scheduleRemoved = output<string>();
  credentialsChanged = output<JiraCredentials | null>();
  activitySettingsChanged = output<ActivitySettingsChange>();
  githubCredentialsChanged = output<GithubCredentials | null>();

  protected readonly weekdayNames = WEEKDAY_NAMES;
  protected readonly weeksOfMonth = WEEKS_OF_MONTH;

  protected readonly startTime = signal<string | null>(null);
  protected readonly hoursPerDay = signal<number | null>(null);
  protected readonly lunchMinutes = signal<number | null>(null);
  protected readonly workDays = signal<number[] | null>(null);

  protected readonly allocIssueKey = signal('');
  protected readonly allocSummary = signal('');
  protected readonly allocPercentage = signal(0);

  protected readonly schedIssueKey = signal('');
  protected readonly schedSummary = signal('');
  protected readonly schedWeekdays = signal<number[]>([]);
  protected readonly schedStartTime = signal('');
  protected readonly schedDurationHours = signal(0);
  protected readonly schedRepeat = signal<ScheduleRepeat>('weekly');
  /** A date in a week a new fortnightly schedule happens in; the week on show when blank. */
  protected readonly schedAnchorDate = signal('');
  protected readonly schedWeekOfMonth = signal(1);

  protected readonly leaveIssueKey = signal<string | null>(null);
  protected readonly placeholderIssueKey = signal<string | null>(null);
  protected readonly githubOrgs = signal<string | null>(null);

  protected readonly githubToken = signal<string | null>(null);
  protected readonly githubApiUrl = signal<string | null>(null);

  protected readonly credEmail = signal<string | null>(null);
  protected readonly credToken = signal<string | null>(null);
  protected readonly credHost = signal<string | null>(null);

  /** The allocations the week on show uses: its own, or the usual ones. */
  protected shownAllocations(): PercentageAllocation[] {
    return this.weekAllocations() ?? this.settings().allocations;
  }

  /** The prefixes as typed in the field, e.g. "MT, OPS". */
  protected spreadPrefixesText(): string {
    return this.settings().spreadPrefixes.join(', ');
  }

  /** How the allocations on show are logged, for the hint under the list. */
  protected allocationOrder(): { spread: string[]; blocks: string[] } {
    const prefixes = this.settings().spreadPrefixes.map((prefix) => prefix.trim().toUpperCase());
    const spread: string[] = [];
    const blocks: string[] = [];
    for (const allocation of this.shownAllocations()) {
      const key = allocation.issueKey.trim().toUpperCase();
      (prefixes.some((prefix) => prefix !== '' && key.startsWith(prefix)) ? spread : blocks).push(
        allocation.issueKey,
      );
    }
    return { spread, blocks };
  }

  /** What the allocations on show add up to, in percent. */
  protected allocationTotal(): number {
    const total = this.shownAllocations().reduce(
      (sum, allocation) => sum + allocation.percentage,
      0,
    );
    return Math.round(total * 100) / 100;
  }

  protected effectiveStartTime(): string {
    return this.startTime() ?? this.settings().startTime;
  }

  protected effectiveHoursPerDay(): number {
    return this.hoursPerDay() ?? this.settings().hoursPerDay;
  }

  protected effectiveLunchMinutes(): number {
    return this.lunchMinutes() ?? this.settings().lunchMinutes;
  }

  protected workDayChecked(day: number): boolean {
    return (this.workDays() ?? this.settings().workDays).includes(day);
  }

  protected scheduleWeekdayChecked(day: number): boolean {
    return this.schedWeekdays().includes(day);
  }

  protected onStartTimeInput(event: Event): void {
    this.startTime.set((event.target as HTMLInputElement).value);
  }

  protected onHoursPerDayInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.hoursPerDay.set(Number.isFinite(value) ? value : 0);
  }

  protected onLunchMinutesInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.lunchMinutes.set(Number.isFinite(value) && value > 0 ? value : 0);
  }

  protected toggleWorkDay(day: number): void {
    const current = this.workDays() ?? this.settings().workDays;
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day].sort((a, b) => a - b);
    this.workDays.set(next);
  }

  protected saveWorkHours(): void {
    this.workHoursChanged.emit({
      startTime: this.effectiveStartTime(),
      hoursPerDay: this.effectiveHoursPerDay(),
      lunchMinutes: this.effectiveLunchMinutes(),
      workDays: this.workDays() ?? this.settings().workDays,
    });
  }

  protected onAllocIssueKeyInput(event: Event): void {
    this.allocIssueKey.set((event.target as HTMLInputElement).value);
  }

  protected onAllocSummaryInput(event: Event): void {
    this.allocSummary.set((event.target as HTMLInputElement).value);
  }

  protected onAllocPercentageInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.allocPercentage.set(Number.isFinite(value) ? value : 0);
  }

  protected addAllocation(event: Event): void {
    event.preventDefault();
    this.allocationAdded.emit({
      id: crypto.randomUUID(),
      issueKey: this.allocIssueKey(),
      summary: this.allocSummary(),
      percentage: this.allocPercentage(),
    });
    this.allocIssueKey.set('');
    this.allocSummary.set('');
    this.allocPercentage.set(0);
  }

  /** Emits the allocation with its new percentage; a blank or negative one puts the old one back. */
  protected changeAllocationPercentage(allocation: PercentageAllocation, event: Event): void {
    const field = event.target as HTMLInputElement;
    const percentage = Number(field.value);
    if (field.value.trim() === '' || !Number.isFinite(percentage) || percentage < 0) {
      field.value = String(allocation.percentage);
      return;
    }
    if (percentage !== allocation.percentage) {
      this.allocationChanged.emit({ ...allocation, percentage });
    }
  }

  protected removeAllocation(id: string): void {
    this.allocationRemoved.emit(id);
  }

  /** Emits the prefixes typed in the field, split on commas and spaces. */
  protected changeSpreadPrefixes(event: Event): void {
    const prefixes = (event.target as HTMLInputElement).value
      .split(/[\s,]+/)
      .filter((prefix) => prefix !== '');
    const current = this.settings().spreadPrefixes;
    if (prefixes.length !== current.length || prefixes.some((prefix, i) => prefix !== current[i])) {
      this.spreadPrefixesChanged.emit(prefixes);
    }
  }

  protected onSchedIssueKeyInput(event: Event): void {
    this.schedIssueKey.set((event.target as HTMLInputElement).value);
  }

  protected onSchedSummaryInput(event: Event): void {
    this.schedSummary.set((event.target as HTMLInputElement).value);
  }

  protected onSchedStartTimeInput(event: Event): void {
    this.schedStartTime.set((event.target as HTMLInputElement).value);
  }

  protected onSchedDurationInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.schedDurationHours.set(Number.isFinite(value) ? value : 0);
  }

  protected onSchedRepeatInput(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.schedRepeat.set(value === 'fortnightly' || value === 'monthly' ? value : 'weekly');
  }

  protected onSchedAnchorDateInput(event: Event): void {
    this.schedAnchorDate.set((event.target as HTMLInputElement).value);
  }

  protected onSchedWeekOfMonthInput(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    this.schedWeekOfMonth.set(WEEKS_OF_MONTH.some((week) => week.value === value) ? value : 1);
  }

  /** The date field's default for a fortnightly schedule: the Monday of the week on show. */
  protected effectiveSchedAnchorDate(): string {
    const start = this.weekStart();
    return this.schedAnchorDate() || (start === null ? dateKey(new Date()) : dateKey(start));
  }

  /** How often a schedule in the list happens, e.g. "every other week from Sep 28". */
  protected repeatLabel(schedule: RecurringSchedule): string {
    switch (schedule.repeat ?? 'weekly') {
      case 'weekly':
        return 'every week';
      case 'fortnightly':
        return schedule.anchorWeek === undefined
          ? 'every other week'
          : `every other week from ${shortDate(schedule.anchorWeek)}`;
      case 'monthly': {
        const week = WEEKS_OF_MONTH.find((item) => item.value === schedule.weekOfMonth);
        return `${week?.label ?? '1st'} of the month`;
      }
    }
  }

  protected toggleScheduleWeekday(day: number): void {
    const current = this.schedWeekdays();
    this.schedWeekdays.set(
      current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day].sort((a, b) => a - b),
    );
  }

  protected addSchedule(event: Event): void {
    event.preventDefault();
    const repeat = this.schedRepeat();
    this.scheduleAdded.emit({
      id: crypto.randomUUID(),
      issueKey: this.schedIssueKey(),
      summary: this.schedSummary(),
      weekdays: [...this.schedWeekdays()],
      startTime: this.schedStartTime(),
      durationSeconds: Math.round(this.schedDurationHours() * 3600),
      enabled: true,
      repeat,
      ...(repeat === 'fortnightly'
        ? { anchorWeek: mondayOf(this.effectiveSchedAnchorDate()) ?? undefined }
        : {}),
      ...(repeat === 'monthly' ? { weekOfMonth: this.schedWeekOfMonth() } : {}),
    });
    this.schedIssueKey.set('');
    this.schedSummary.set('');
    this.schedWeekdays.set([]);
    this.schedStartTime.set('');
    this.schedDurationHours.set(0);
    this.schedRepeat.set('weekly');
    this.schedAnchorDate.set('');
    this.schedWeekOfMonth.set(1);
  }

  protected removeSchedule(id: string): void {
    this.scheduleRemoved.emit(id);
  }

  protected effectiveLeaveIssueKey(): string {
    return this.leaveIssueKey() ?? this.settings().leaveIssueKey;
  }

  protected effectivePlaceholderIssueKey(): string {
    return this.placeholderIssueKey() ?? this.settings().placeholderIssueKey;
  }

  protected effectiveGithubOrgs(): string {
    return this.githubOrgs() ?? this.settings().githubOrgs.join(', ');
  }

  protected onLeaveIssueKeyInput(event: Event): void {
    this.leaveIssueKey.set((event.target as HTMLInputElement).value);
  }

  protected onPlaceholderIssueKeyInput(event: Event): void {
    this.placeholderIssueKey.set((event.target as HTMLInputElement).value);
  }

  protected onGithubOrgsInput(event: Event): void {
    this.githubOrgs.set((event.target as HTMLInputElement).value);
  }

  protected saveActivitySettings(): void {
    this.activitySettingsChanged.emit({
      leaveIssueKey: this.effectiveLeaveIssueKey().trim(),
      placeholderIssueKey: this.effectivePlaceholderIssueKey().trim(),
      githubOrgs: this.effectiveGithubOrgs()
        .split(/[\s,]+/)
        .filter((org) => org !== ''),
    });
  }

  protected onGithubTokenInput(event: Event): void {
    this.githubToken.set((event.target as HTMLInputElement).value);
  }

  protected onGithubApiUrlInput(event: Event): void {
    this.githubApiUrl.set((event.target as HTMLInputElement).value);
  }

  protected saveGithubCredentials(event: Event): void {
    event.preventDefault();
    const apiUrl = (this.githubApiUrl() ?? this.githubCredentials()?.apiUrl ?? '').trim();
    this.githubCredentialsChanged.emit({
      token: (this.githubToken() ?? this.githubCredentials()?.token ?? '').trim(),
      apiUrl: apiUrl === '' ? DEFAULT_GITHUB_API_URL : apiUrl,
    });
  }

  protected clearGithubCredentials(): void {
    this.githubToken.set(null);
    this.githubApiUrl.set(null);
    this.githubCredentialsChanged.emit(null);
  }

  protected onCredEmailInput(event: Event): void {
    this.credEmail.set((event.target as HTMLInputElement).value);
  }

  protected onCredTokenInput(event: Event): void {
    this.credToken.set((event.target as HTMLInputElement).value);
  }

  protected onCredHostInput(event: Event): void {
    this.credHost.set((event.target as HTMLInputElement).value);
  }

  protected saveCredentials(event: Event): void {
    event.preventDefault();
    this.credentialsChanged.emit({
      email: this.credEmail() ?? this.credentials()?.email ?? '',
      apiToken: this.credToken() ?? this.credentials()?.apiToken ?? '',
      host: this.credHost() ?? this.credentials()?.host ?? '',
    });
  }

  protected clearCredentials(): void {
    this.credentialsChanged.emit(null);
  }
}
