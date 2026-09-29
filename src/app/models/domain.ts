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
}

export interface ExecutionPlan {
  deletions: WorklogDeletion[];
  creations: WorklogCreation[];
}
