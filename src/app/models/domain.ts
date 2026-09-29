export interface CalendarEvent {
  id: string;
  issueKey: string;
  summary: string;
  start: Date;
  end: Date;
  timeSpentSeconds: number;
  source: 'jira' | 'recurring' | 'allocated';
  worklogId?: string;
}

export interface RecurringSchedule {
  id: string;
  issueKey: string;
  summary: string;
  weekdays: number[];
  startTime: string;
  durationSeconds: number;
  enabled: boolean;
}

export interface PercentageAllocation {
  id: string;
  issueKey: string;
  summary: string;
  percentage: number;
}

export interface UserSettings {
  startTime: string;
  hoursPerDay: number;
  workDays: number[];
  allocations: PercentageAllocation[];
  schedules: RecurringSchedule[];
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

export interface EngineInput {
  weekStart: Date;
  settings: UserSettings;
  worklogs: JiraWorklog[];
}
