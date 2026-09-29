export interface CalendarEvent {
  id: string;
  issueKey: string;
  summary: string;
  start: Date;
  end: Date;
  timeSpentSeconds: number;
  source: 'jira' | 'recurring' | 'allocated' | 'leave';
  worklogId?: string;
  /** An existing worklog the plan deletes. */
  pendingDeletion?: boolean;
}

/** How often a schedule repeats. */
export type ScheduleRepeat = 'weekly' | 'fortnightly' | 'monthly';

/** The last such weekday of the month, as a `weekOfMonth`. */
export const LAST_WEEK_OF_MONTH = -1;

export interface RecurringSchedule {
  id: string;
  issueKey: string;
  summary: string;
  weekdays: number[];
  startTime: string;
  durationSeconds: number;
  enabled: boolean;
  /** Weekly when missing, as in settings saved before schedules could repeat less often. */
  repeat?: ScheduleRepeat;
  /** Fortnightly only: the Monday (yyyy-mm-dd) of a week the schedule happens in. */
  anchorWeek?: string;
  /**
   * Monthly only: which of each weekday in the month the schedule happens on, 1 to 4 for the
   * first to fourth, or `LAST_WEEK_OF_MONTH` for the last.
   */
  weekOfMonth?: number;
}

export interface PercentageAllocation {
  id: string;
  issueKey: string;
  summary: string;
  percentage: number;
}

export interface UserSettings {
  startTime: string;
  /** Working hours per day, not counting lunch. */
  hoursPerDay: number;
  /** The lunch break in the middle of each working day; 0 for none. */
  lunchMinutes: number;
  workDays: number[];
  allocations: PercentageAllocation[];
  schedules: RecurringSchedule[];
  /**
   * Allocations on issues whose key starts with one of these are scattered through the week;
   * every other allocation is logged in one block, so one task follows another.
   */
  spreadPrefixes: string[];
  /**
   * Allocations filled from a week's activity, by the week's Monday (yyyy-mm-dd). A week listed here
   * uses them instead of `allocations`, and its sync replaces the worklogs Jira added automatically.
   */
  weekAllocations: Record<string, PercentageAllocation[]>;
  /** The ticket leave is logged to. Worklogs on it are never replaced. */
  leaveIssueKey: string;
  /** Generic work ticket for pull requests with no Jira key, and weeks with no activity. */
  placeholderIssueKey: string;
  /** Only look at pull requests in these GitHub organisations; empty means all. */
  githubOrgs: string[];
}

export interface GithubCredentials {
  token: string;
  /** REST API base, e.g. https://api.github.com. */
  apiUrl: string;
}

export interface JiraCredentials {
  email: string;
  apiToken: string;
  host: string;
}

export interface WorklogDeletion {
  worklogId: string;
  issueKey: string;
  reason: string;
}

export interface WorklogCreation {
  issueKey: string;
  started: string;
  timeSpentSeconds: number;
  comment?: string;
  /** The part of the plan that asked for this worklog. */
  source: Exclude<CalendarEvent['source'], 'jira'>;
}

export interface ExecutionPlan {
  deletions: WorklogDeletion[];
  creations: WorklogCreation[];
  /** Worklogs being replaced, to be remembered as evidence before they are deleted. */
  absorb: JiraWorklog[];
}

export interface JiraWorklog {
  id: string;
  issueKey: string;
  started: Date;
  timeSpentSeconds: number;
  comment?: string;
  /** Created by this app, as opposed to logged by hand or added automatically by Jira. */
  generated: boolean;
}

export type ActivityKind =
  'pr-opened' | 'commit' | 'review' | 'comment' | 'pr-merged' | 'jira-worklog';

/** Something that shows work on an issue at a point in time. */
export interface ActivityEvent {
  /** Stable, e.g. 'gh:acme/api#41:commit:<sha>' or 'jira:<worklogId>'. */
  id: string;
  issueKey: string;
  at: Date;
  kind: ActivityKind;
  /** Shown in the UI and used in worklog comments, e.g. 'acme/api#41 Add rate limiting'. */
  label: string;
  url?: string;
  /** Fraction of the event's weight, when one pull request names several issues. Defaults to 1. */
  share?: number;
}

export interface EngineInput {
  weekStart: Date;
  settings: UserSettings;
  worklogs: JiraWorklog[];
  /** Weekdays marked as leave, 1 = Monday, as in `workDays`. */
  leaveDays?: number[];
}
