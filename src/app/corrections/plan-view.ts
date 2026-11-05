// How a plan reads: each change as one line, and each day as a small table. Shared by the
// Markdown dry run and the web app's Corrections view, so both describe a change the same way.

import { h, timeSpan } from './planner';
import { parseJiraDateTime } from './time-zone';
import type { Op, PlannedDay } from './types';

export interface OpLine {
  opId: string;
  label: 'CREATE' | 'DELETE' | 'EDIT';
  issueKey: string;
  /** What changes, e.g. "worklog 10075 · 13:45–17:15 → 13:15–18:00 (moved, same day) · 3.5h → 4.75h". */
  text: string;
  why: string;
  /** For changes that wait on others: which, and why. */
  waits?: string;
}

export interface DayRow {
  issueKey: string;
  /** What the corrections file says Jira has, for the issues it names. */
  expected?: number;
  now: number;
  after: number;
  /** Jira doesn't have what the file expects. */
  mismatch: boolean;
}

export function quote(text: string): string {
  return text === '' ? '(no comment)' : `"${text.replace(/\n/g, ' / ')}"`;
}

export function opLine(op: Op, timeZone: string): OpLine {
  const base = { opId: op.opId, issueKey: op.issueKey, why: op.why };
  const waits =
    op.kind !== 'create' && op.requires !== undefined && op.requires.length > 0
      ? { waits: `only once ${op.requires.join(', ')} is made, so time is never lost` }
      : {};
  const start = parseJiraDateTime(op.started);
  if (op.kind === 'create') {
    return {
      ...base,
      label: 'CREATE',
      text: `${timeSpan(start, op.seconds, timeZone)} · ${h(op.seconds)} · ${quote(op.comment)}`,
    };
  }
  if (op.kind === 'delete') {
    return {
      ...base,
      ...waits,
      label: 'DELETE',
      text: `worklog ${op.worklogId} · ${timeSpan(start, op.before.seconds, timeZone)} · ${h(op.before.seconds)} · ${quote(op.before.comment)}`,
    };
  }
  const parts = [`worklog ${op.worklogId}`];
  if (op.after.started !== undefined) {
    const moved = parseJiraDateTime(op.after.started);
    parts.push(
      `${timeSpan(start, op.before.seconds, timeZone)} → ${timeSpan(moved, op.after.seconds, timeZone)} (moved, same day)`,
    );
  } else {
    parts.push(`starts ${timeSpan(start, op.before.seconds, timeZone).split('–')[0]} (unchanged)`);
  }
  if (op.after.seconds !== op.before.seconds) {
    parts.push(
      `${h(op.before.seconds)} → ${h(op.after.seconds)}` +
        (op.after.started === undefined
          ? ` (ends ${timeSpan(start, op.after.seconds, timeZone).split('–')[1]})`
          : ''),
    );
  } else {
    parts.push(h(op.before.seconds));
  }
  parts.push(
    op.after.comment !== op.before.comment
      ? `comment ${quote(op.before.comment)} → ${quote(op.after.comment)}`
      : quote(op.before.comment),
  );
  return { ...base, ...waits, label: 'EDIT', text: parts.join(' · ') };
}

export function dayRows(day: PlannedDay): DayRow[] {
  return [
    ...new Set([
      ...Object.keys(day.before.byIssue),
      ...Object.keys(day.after.byIssue),
      ...Object.keys(day.expectedBefore),
    ]),
  ]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((issueKey) => {
      const expected = day.expectedBefore[issueKey];
      const now = day.before.byIssue[issueKey] ?? 0;
      return {
        issueKey,
        ...(expected === undefined ? {} : { expected }),
        now,
        after: day.after.byIssue[issueKey] ?? 0,
        mismatch: expected !== undefined && expected !== now,
      };
    });
}
