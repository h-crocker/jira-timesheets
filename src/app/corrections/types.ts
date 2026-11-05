// Types shared by the corrections planner, applier, verifier, validator and report. Everything in
// src/app/corrections is plain TypeScript with no Angular or Node dependency, so the web app and
// the command line (cli/timesheets.ts) can both use it.

/** One of your own worklogs, as read from Jira, placed on its day in the profile time zone. */
export interface OwnWorklog {
  id: string;
  issueKey: string;
  /** `started` exactly as Jira returned it. */
  started: string;
  /** `started` as epoch milliseconds. */
  startedMs: number;
  /** yyyy-mm-dd in the profile time zone: the day Jira shows the worklog on. */
  date: string;
  seconds: number;
  /** Plain text of the comment; '' when there is none. */
  comment: string;
  authorAccountId: string;
  properties: { key: string; value: unknown }[];
}

/** What a plan records about a worklog it saw, to check nothing changed before applying. */
export interface WorklogSnapshot {
  id: string;
  issueKey: string;
  started: string;
  seconds: number;
  comment: string;
}

export interface UpdateOp {
  kind: 'update';
  opId: string;
  issueKey: string;
  worklogId: string;
  started: string;
  before: { seconds: number; comment: string };
  /** `started` is only set when the worklog moves (sick leave going to the end of the day). */
  after: { seconds: number; comment: string; started?: string };
  why: string;
  /** Ops that must have succeeded first: a move only reduces its source once the new time exists. */
  requires?: string[];
}

export interface DeleteOp {
  kind: 'delete';
  opId: string;
  issueKey: string;
  worklogId: string;
  started: string;
  before: { seconds: number; comment: string };
  why: string;
  requires?: string[];
}

export interface CreateOp {
  kind: 'create';
  opId: string;
  issueKey: string;
  /** In Jira's format, written in the profile time zone. */
  started: string;
  seconds: number;
  comment: string;
  why: string;
}

export type Op = UpdateOp | DeleteOp | CreateOp;

export type DayStatus = 'ready' | 'blocked' | 'unchanged';

export interface PlannedDay {
  date: string;
  status: DayStatus;
  /** Why the day is blocked. A blocked day is shown but never applied. */
  problems: string[];
  /** Things that may not go to plan (a ticket that looks locked, a day off its hours). */
  warnings: string[];
  /** Things to review that don't block the day. */
  notes: string[];
  /** Hours per issue the corrections file expected before, for the issues it names. */
  expectedBefore: Record<string, number>;
  before: { worklogs: WorklogSnapshot[]; byIssue: Record<string, number>; totalSeconds: number };
  after: { byIssue: Record<string, number>; totalSeconds: number };
  ops: Op[];
}

export interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

export type FindingKind =
  'over-hours' | 'under-hours' | 'work-on-leave-day' | 'after-merge' | 'locked-issue' | 'weekend';

export interface Finding {
  date: string;
  kind: FindingKind;
  message: string;
  issueKey?: string;
  worklogIds?: string[];
}

export interface Plan {
  version: 1;
  /** Hash of what the plan does and the state it was planned from. `apply` asks for it. */
  planId: string;
  createdAt: string;
  name: string;
  /** Jira site origin. Not secret, but only ever compared, never printed by the plan. */
  site: string;
  accountId: string;
  timeZone: string;
  maxDaySeconds: number;
  expectedDaySeconds: number;
  /** Worklog property put on worklogs this plan creates, so a re-run never creates them twice. */
  markerKey: string;
  days: PlannedDay[];
  checks: CheckResult[];
  /** Totals `verify` recomputes from Jira, e.g. sick leave across the corrected days. */
  totalChecks: TotalCheck[];
  findings: Finding[];
}

export interface TotalCheck {
  label: string;
  issueKey: string;
  dates: string[];
  seconds: number;
  /** Protected worklogs on those days, which don't count (e.g. annual leave on the same issue). */
  excludeWorklogIds: string[];
}

/** Issues known to refuse worklog changes, with why. */
export type LockedIssues = Record<string, { reason: string; detectedAt?: string; source: string }>;

export const CORRECTION_MARKER_KEY = 'jira-timesheets.correction';
