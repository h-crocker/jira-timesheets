// Turns a corrections file and your worklogs into a plan: for each day, exactly which worklogs
// would be edited, created or deleted, what the day adds up to before and after, and anything that
// stops the day. Nothing here talks to Jira; the plan is checked and approved before `apply`.
//
// When an issue has several worklogs on a day:
// - more time extends the latest-started one, or creates one when there are none;
// - less time shrinks worklogs from the latest-started back, deleting any it empties;
// - new worklogs start where the time they replace was freed, so the day still reads in order.
// Protected worklogs (annual leave) are never edited and don't count towards the hours compared.

import type {
  Change,
  CorrectionsSpec,
  MoveChange,
  ProtectRule,
  SetChange,
} from './corrections-file';
import { correctionsRange } from './corrections-file';
import {
  dateKeyInZone,
  formatJiraStarted,
  parseJiraDateTime,
  timeInZone,
  zonedTimeToMs,
} from './time-zone';
import {
  CORRECTION_MARKER_KEY,
  type CheckResult,
  type CreateOp,
  type DeleteOp,
  type LockedIssues,
  type Op,
  type OwnWorklog,
  type Plan,
  type PlannedDay,
  type UpdateOp,
} from './types';
import { validateWorklogs } from './validation';

export interface PlanContext {
  accountId: string;
  timeZone: string;
  site: string;
  /** Issues known to refuse changes: from the corrections file, earlier refusals and pre-flight. */
  lockedIssues: LockedIssues;
  /** Linked pull requests' merge times by issue, for validation; empty to skip the check. */
  mergedAt?: Map<string, { mergedAtMs: number; url: string }>;
  now?: Date;
}

interface FreedSlot {
  worklogId: string;
  startMs: number;
  seconds: number;
  comment: string;
}

/** Hours for display, e.g. 3.75. */
export function h(seconds: number): string {
  return `${Math.round((seconds / 3600) * 100) / 100}h`;
}

export function isProtected(worklog: OwnWorklog, rules: ProtectRule[]): ProtectRule | undefined {
  return rules.find(
    (rule) =>
      rule.issueKey === worklog.issueKey &&
      (rule.dates.includes(worklog.date) ||
        (rule.commentPattern !== undefined &&
          new RegExp(rule.commentPattern, 'i').test(worklog.comment))),
  );
}

function sumBy(worklogs: OwnWorklog[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const worklog of worklogs) {
    totals[worklog.issueKey] = (totals[worklog.issueKey] ?? 0) + worklog.seconds;
  }
  return totals;
}

function snapshot(worklog: OwnWorklog) {
  return {
    id: worklog.id,
    issueKey: worklog.issueKey,
    started: worklog.started,
    seconds: worklog.seconds,
    comment: worklog.comment,
  };
}

/** A short, stable hash (cyrb53) of a string, as hex. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

class DayBuilder {
  readonly problems: string[] = [];
  /** Things that may not go to plan, which don't stop the day: shown first in the dry run. */
  readonly warnings: string[] = [];
  readonly notes: string[] = [];
  /**
   * Worklogs only changed once other changes have been made: a move's source once its new
   * worklogs exist, and extra sick-leave worklogs once the one kept has all the time.
   */
  private readonly links: { dependentIds: string[]; prerequisites: Op[] }[] = [];
  /** Pending edits by worklog id; merged so one worklog gets at most one PUT. */
  private readonly updates = new Map<string, UpdateOp>();
  private readonly deletes = new Map<string, DeleteOp>();
  private readonly creates: CreateOp[] = [];
  /** Seconds each worklog will have, as changes are worked out. */
  private readonly remaining = new Map<string, number>();
  private readonly freed: FreedSlot[] = [];

  constructor(
    readonly date: string,
    readonly worklogs: OwnWorklog[],
    private readonly spec: CorrectionsSpec,
    private readonly context: PlanContext,
  ) {
    for (const worklog of worklogs) {
      this.remaining.set(worklog.id, worklog.seconds);
    }
  }

  /** The worklogs of an issue that may be changed, latest-started first. */
  private editable(issueKey: string): OwnWorklog[] {
    return this.worklogs
      .filter(
        (worklog) =>
          worklog.issueKey === issueKey &&
          isProtected(worklog, this.spec.protect) === undefined &&
          !this.deletes.has(worklog.id),
      )
      .sort((a, b) => b.startedMs - a.startedMs || b.id.localeCompare(a.id));
  }

  current(issueKey: string): number {
    return this.editable(issueKey).reduce((sum, worklog) => sum + worklog.seconds, 0);
  }

  checkLocked(issueKey: string): void {
    const locked = this.context.lockedIssues[issueKey];
    if (locked === undefined) {
      return;
    }
    if (locked.source === 'corrections file') {
      // Listed as never to be touched.
      this.problems.push(`${issueKey} is locked (${locked.reason}), so it can't be changed.`);
    } else {
      this.warnings.push(
        `${issueKey} looks locked (${locked.reason}). Its change is still tried; if Jira refuses it, ` +
          'that is logged and the rest of the day, sick leave included, still goes ahead.',
      );
    }
  }

  checkProtected(issueKey: string): void {
    const rule = this.spec.protect.find(
      (item) => item.issueKey === issueKey && item.dates.includes(this.date),
    );
    if (rule !== undefined) {
      this.problems.push(`${issueKey} is protected on this day (${rule.reason}).`);
    }
  }

  private setComment(worklog: OwnWorklog, comment: string | undefined, why: string): void {
    const existing = this.updates.get(worklog.id);
    const seconds = this.remaining.get(worklog.id) ?? worklog.seconds;
    const op: UpdateOp = existing ?? {
      kind: 'update',
      opId: '',
      issueKey: worklog.issueKey,
      worklogId: worklog.id,
      started: worklog.started,
      before: { seconds: worklog.seconds, comment: worklog.comment },
      after: { seconds, comment: worklog.comment },
      why,
    };
    op.after = { seconds, comment: comment ?? op.after.comment };
    if (existing !== undefined && !existing.why.includes(why)) {
      existing.why = `${existing.why}; ${why}`;
    }
    this.updates.set(worklog.id, op);
  }

  private resize(worklog: OwnWorklog, seconds: number, why: string, comment?: string): void {
    this.remaining.set(worklog.id, seconds);
    if (seconds === 0) {
      this.updates.delete(worklog.id);
      this.deletes.set(worklog.id, {
        kind: 'delete',
        opId: '',
        issueKey: worklog.issueKey,
        worklogId: worklog.id,
        started: worklog.started,
        before: { seconds: worklog.seconds, comment: worklog.comment },
        why,
      });
      return;
    }
    this.setComment(worklog, comment, why);
  }

  /** Takes `seconds` off an issue, latest-started worklog first; returns the time freed. */
  private reduce(issueKey: string, seconds: number, why: string, comment?: string): FreedSlot[] {
    const slots: FreedSlot[] = [];
    let left = seconds;
    for (const worklog of this.editable(issueKey)) {
      if (left === 0) {
        break;
      }
      const has = this.remaining.get(worklog.id) ?? worklog.seconds;
      const take = Math.min(has, left);
      left -= take;
      // The freed time is the end of the worklog.
      slots.push({
        worklogId: worklog.id,
        startMs: worklog.startedMs + (has - take) * 1000,
        seconds: take,
        comment: worklog.comment,
      });
      this.resize(worklog, has - take, why, has - take === 0 ? undefined : comment);
    }
    return slots.sort((a, b) => a.startMs - b.startMs);
  }

  private create(
    issueKey: string,
    startMs: number,
    seconds: number,
    comment: string,
    why: string,
  ): CreateOp {
    const started = formatJiraStarted(startMs, this.context.timeZone);
    if (dateKeyInZone(startMs, this.context.timeZone) !== this.date) {
      this.problems.push(
        `A new ${issueKey} worklog would start on ${dateKeyInZone(startMs, this.context.timeZone)}, not ${this.date}.`,
      );
    }
    const op: CreateOp = { kind: 'create', opId: '', issueKey, started, seconds, comment, why };
    this.creates.push(op);
    return op;
  }

  applySet(change: SetChange): void {
    this.checkLocked(change.issueKey);
    this.checkProtected(change.issueKey);
    const current = this.current(change.issueKey);
    if (current !== change.fromSeconds && current === change.toSeconds) {
      // Already corrected, e.g. by an apply that stopped part-way through the day.
      this.notes.push(`Already corrected: ${change.issueKey} is ${h(current)}.`);
      return;
    }
    if (current !== change.fromSeconds) {
      this.problems.push(
        `Jira has ${h(current)} on ${change.issueKey}, but the corrections file expects ${h(change.fromSeconds)}.`,
      );
      return;
    }
    const why = `${change.issueKey} ${h(change.fromSeconds)} → ${h(change.toSeconds)}`;
    const delta = change.toSeconds - change.fromSeconds;
    if (delta < 0) {
      this.freed.push(...this.reduce(change.issueKey, -delta, why, change.comment));
    } else if (delta > 0) {
      const [latest] = this.editable(change.issueKey);
      if (latest === undefined) {
        this.pendingCreates.push({ change, why });
      } else {
        this.resize(
          latest,
          (this.remaining.get(latest.id) ?? latest.seconds) + delta,
          why,
          change.comment,
        );
      }
    } else if (change.comment !== undefined) {
      for (const worklog of this.editable(change.issueKey)) {
        this.setComment(worklog, change.comment, why);
      }
    }
  }

  /** Creations wait until every reduction on the day is known, to start in freed time. */
  private readonly pendingCreates: { change: SetChange; why: string }[] = [];

  applyMove(change: MoveChange): void {
    this.checkLocked(change.fromIssueKey);
    this.checkLocked(change.toIssueKey);
    this.checkProtected(change.fromIssueKey);
    this.checkProtected(change.toIssueKey);
    // Time an earlier correction moved carries its marker; never move it twice.
    const moved = this.worklogs
      .filter(
        (worklog) =>
          worklog.issueKey === change.toIssueKey &&
          worklog.properties.some((property) => property.key === CORRECTION_MARKER_KEY),
      )
      .reduce((sum, worklog) => sum + worklog.seconds, 0);
    if (moved === change.seconds) {
      this.notes.push(
        `Already corrected: ${h(moved)} was moved to ${change.toIssueKey} by an earlier apply.`,
      );
      return;
    }
    if (moved > 0) {
      this.problems.push(
        `${h(moved)} was already moved to ${change.toIssueKey} by an earlier correction, not the ${h(change.seconds)} planned.`,
      );
      return;
    }
    const source = this.current(change.fromIssueKey);
    const target = this.current(change.toIssueKey);
    if (source < change.seconds) {
      this.problems.push(
        `Jira has only ${h(source)} on ${change.fromIssueKey}, so ${h(change.seconds)} can't be moved from it.`,
      );
      return;
    }
    if (change.toBeforeSeconds !== undefined && target !== change.toBeforeSeconds) {
      this.problems.push(
        `Jira has ${h(target)} on ${change.toIssueKey}, but the corrections file expects ${h(change.toBeforeSeconds)} before the move.`,
      );
      return;
    }
    const why = `move ${h(change.seconds)} ${change.fromIssueKey} → ${change.toIssueKey}`;
    if (change.comment === undefined) {
      this.notes.push(
        `Moved time keeps the ${change.fromIssueKey} worklog's comment on ${change.toIssueKey}; give the move a "comment" in the corrections file to use another.`,
      );
    }
    // The new worklogs are created first, and the source only reduced once they exist, so a
    // refusal can leave the day over (and logged) but never loses time.
    const slots = this.reduce(change.fromIssueKey, change.seconds, why);
    this.links.push({
      dependentIds: slots.map((slot) => slot.worklogId),
      prerequisites: slots.map((slot) =>
        this.create(
          change.toIssueKey,
          slot.startMs,
          slot.seconds,
          change.comment ?? slot.comment,
          why,
        ),
      ),
    });
  }

  /**
   * Sick leave as one uninterrupted worklog at the end of the day, fitted round what is left once
   * every other change on the day is worked out: it ends when the day's last worklog used to end,
   * reaching back as far as it needs, or starts when the remaining work ends if that would overlap
   * it. Work keeps its start times. Several sick worklogs become one: the latest is kept and moved,
   * and the others are deleted only once it holds all the time.
   */
  placeSickLeave(change: SetChange): void {
    if (change.toSeconds === 0 || change.toSeconds === change.fromSeconds) {
      this.applySet(change);
      return;
    }
    this.checkLocked(change.issueKey);
    this.checkProtected(change.issueKey);
    const current = this.current(change.issueKey);
    if (current !== change.fromSeconds && current === change.toSeconds) {
      this.notes.push(`Already corrected: ${change.issueKey} is ${h(current)}.`);
      return;
    }
    if (current !== change.fromSeconds) {
      this.problems.push(
        `Jira has ${h(current)} on ${change.issueKey}, but the corrections file expects ${h(change.fromSeconds)}.`,
      );
      return;
    }
    const zone = this.context.timeZone;
    const sick = this.editable(change.issueKey);
    const left = (worklog: OwnWorklog) => this.remaining.get(worklog.id) ?? worklog.seconds;
    const others = this.worklogs.filter(
      (worklog) => !sick.includes(worklog) && !this.deletes.has(worklog.id) && left(worklog) > 0,
    );
    const workEnd =
      others.length === 0 ? null : Math.max(...others.map((w) => w.startedMs + left(w) * 1000));
    const usualEnd =
      this.worklogs.length === 0
        ? zonedTimeToMs(this.date, this.spec.defaultStartTime, zone) + change.toSeconds * 1000
        : Math.max(...this.worklogs.map((w) => w.startedMs + w.seconds * 1000));
    let start = usualEnd - change.toSeconds * 1000;
    const end = () => timeInZone(start + change.toSeconds * 1000, zone);
    if (workEnd !== null && start < workEnd) {
      start = workEnd;
      this.notes.push(
        `Sick leave is one block, ${timeInZone(start, zone)}–${end()}: it starts when the remaining work ends, as ending at the usual ${timeInZone(usualEnd, zone)} would overlap work.`,
      );
    } else {
      this.notes.push(
        `Sick leave is one block, ${timeInZone(start, zone)}–${end()}, ending when the day used to end.`,
      );
    }
    if (dateKeyInZone(start, zone) !== this.date) {
      this.problems.push(
        `The sick-leave block would start on ${dateKeyInZone(start, zone)}, not ${this.date}.`,
      );
    }
    const why = `${change.issueKey} ${h(change.fromSeconds)} → ${h(change.toSeconds)}, one block at the end of the day`;
    const [keep, ...extras] = sick;
    if (keep === undefined) {
      this.create(change.issueKey, start, change.toSeconds, change.comment ?? '', why);
      return;
    }
    const update: UpdateOp = {
      kind: 'update',
      opId: '',
      issueKey: keep.issueKey,
      worklogId: keep.id,
      started: keep.started,
      before: { seconds: keep.seconds, comment: keep.comment },
      after: {
        seconds: change.toSeconds,
        comment: change.comment ?? keep.comment,
        ...(start === keep.startedMs ? {} : { started: formatJiraStarted(start, zone) }),
      },
      why,
    };
    this.updates.set(keep.id, update);
    this.remaining.set(keep.id, change.toSeconds);
    for (const extra of extras) {
      this.remaining.set(extra.id, 0);
      this.deletes.set(extra.id, {
        kind: 'delete',
        opId: '',
        issueKey: extra.issueKey,
        worklogId: extra.id,
        started: extra.started,
        before: { seconds: extra.seconds, comment: extra.comment },
        why: `merged into the one ${change.issueKey} worklog ${keep.id}`,
      });
    }
    if (extras.length > 0) {
      this.links.push({ dependentIds: extras.map((extra) => extra.id), prerequisites: [update] });
    }
  }

  placeCreates(): void {
    for (const { change, why } of this.pendingCreates) {
      // The largest stretch of freed time (the earliest of equals), e.g. where a deleted
      // worklog was, so sick leave lands in the afternoon it replaced.
      const slot = this.freed
        .sort((a, b) => b.seconds - a.seconds || a.startMs - b.startMs)
        .shift();
      const startMs =
        slot?.startMs ??
        zonedTimeToMs(this.date, this.spec.defaultStartTime, this.context.timeZone);
      if (slot === undefined) {
        this.notes.push(
          `New ${change.issueKey} worklog starts at ${this.spec.defaultStartTime}, as no time on the day was freed.`,
        );
      }
      this.create(change.issueKey, startMs, change.toSeconds, change.comment ?? '', why);
    }
  }

  rewriteComments(): void {
    for (const rewrite of this.spec.commentRewrites) {
      if (!rewrite.dates.includes(this.date)) {
        continue;
      }
      for (const worklog of this.worklogs.filter((item) => item.issueKey === rewrite.issueKey)) {
        const exact = worklog.comment.trim().toLowerCase() === rewrite.from.toLowerCase();
        if (!exact) {
          const words = rewrite.from
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
          const loose = worklog.comment.toLowerCase().replace(/[^a-z0-9]+/g, '');
          if (words.length > 0 && loose.includes(words.join(''))) {
            this.notes.push(
              `${worklog.issueKey} worklog ${worklog.id} says "${worklog.comment}", not just "${rewrite.from}", so its comment is left alone.`,
            );
          }
          continue;
        }
        if (isProtected(worklog, this.spec.protect) !== undefined) {
          this.problems.push(
            `${worklog.issueKey} worklog ${worklog.id} is protected, so its comment can't change.`,
          );
          continue;
        }
        this.checkLocked(worklog.issueKey);
        if (this.deletes.has(worklog.id)) {
          this.notes.push(
            `${worklog.issueKey} worklog ${worklog.id} is deleted, so its comment isn't rewritten.`,
          );
          continue;
        }
        this.setComment(worklog, rewrite.to, `"${rewrite.from}" comment rewrite`);
      }
    }
  }

  ops(): Op[] {
    const ops: Op[] = [
      ...this.deletes.values(),
      ...[...this.updates.values()].filter(
        (op) =>
          op.after.seconds !== op.before.seconds ||
          op.after.comment !== op.before.comment ||
          op.after.started !== undefined,
      ),
      ...this.creates,
    ];
    ops.forEach((op, i) => (op.opId = `${this.date}#${i + 1}`));
    for (const link of this.links) {
      for (const op of ops) {
        if (op.kind !== 'create' && link.dependentIds.includes(op.worklogId)) {
          op.requires = link.prerequisites.map((prerequisite) => prerequisite.opId);
        }
      }
    }
    return ops;
  }
}

/** Your worklogs as they would be once `ops` are applied. */
export function projectWorklogs(
  worklogs: OwnWorklog[],
  ops: Op[],
  timeZone: string,
  accountId: string,
): OwnWorklog[] {
  const deleted = new Set(ops.filter((op) => op.kind === 'delete').map((op) => op.worklogId));
  const updates = new Map(
    ops.flatMap((op) => (op.kind === 'update' ? [[op.worklogId, op] as const] : [])),
  );
  const result = worklogs
    .filter((worklog) => !deleted.has(worklog.id))
    .map((worklog) => {
      const update = updates.get(worklog.id);
      if (update === undefined) {
        return worklog;
      }
      const moved = update.after.started;
      const startedMs = moved === undefined ? worklog.startedMs : parseJiraDateTime(moved);
      return {
        ...worklog,
        seconds: update.after.seconds,
        comment: update.after.comment,
        started: moved ?? worklog.started,
        startedMs,
        date: dateKeyInZone(startedMs, timeZone),
      };
    });
  for (const op of ops) {
    if (op.kind === 'create') {
      const startedMs = parseJiraDateTime(op.started);
      result.push({
        id: `new:${op.opId}`,
        issueKey: op.issueKey,
        started: op.started,
        startedMs,
        date: dateKeyInZone(startedMs, timeZone),
        seconds: op.seconds,
        comment: op.comment,
        authorAccountId: accountId,
        properties: [],
      });
    }
  }
  return result.sort((a, b) => a.startedMs - b.startedMs);
}

export function buildPlan(
  spec: CorrectionsSpec,
  worklogs: OwnWorklog[],
  context: PlanContext,
): Plan {
  const { timeZone, accountId } = context;
  const own = worklogs.filter((worklog) => worklog.authorAccountId === accountId);
  const onDay = (date: string) => own.filter((worklog) => worklog.date === date);
  const days: PlannedDay[] = [];

  const correctionDates = new Set(spec.days.map((day) => day.date));
  const rewriteDates = new Set(spec.commentRewrites.flatMap((rewrite) => rewrite.dates));
  const allDates = [...new Set([...correctionDates, ...rewriteDates])].sort();

  for (const date of allDates) {
    const dayWorklogs = onDay(date);
    const builder = new DayBuilder(date, dayWorklogs, spec, context);
    const correction = spec.days.find((day) => day.date === date);
    const changes: Change[] = correction?.changes ?? [];
    const expectedBefore: Record<string, number> = {};
    // Sick leave goes last, so it fits round the day as the other changes leave it.
    const isSick = (change: Change) =>
      change.kind === 'set' && change.issueKey === spec.sickLeave?.issueKey;
    for (const change of [...changes.filter((c) => !isSick(c)), ...changes.filter(isSick)]) {
      if (change.kind === 'set') {
        expectedBefore[change.issueKey] = change.fromSeconds;
        if (isSick(change)) {
          builder.placeSickLeave(change);
        } else {
          builder.applySet(change);
        }
      } else {
        builder.applyMove(change);
      }
    }
    builder.placeCreates();
    builder.rewriteComments();
    const ops = builder.ops();

    for (const worklog of dayWorklogs) {
      const rule = isProtected(worklog, spec.protect);
      if (rule !== undefined) {
        builder.notes.push(
          `${worklog.issueKey} ${h(worklog.seconds)} (worklog ${worklog.id}, "${worklog.comment}") is protected (${rule.reason}) and left alone.`,
        );
      }
      if (context.lockedIssues[worklog.issueKey] !== undefined) {
        builder.notes.push(
          `${worklog.issueKey} ${h(worklog.seconds)} is on a locked issue and left alone.`,
        );
      }
    }

    const beforeByIssue = sumBy(dayWorklogs);
    const beforeTotal = dayWorklogs.reduce((sum, worklog) => sum + worklog.seconds, 0);
    const projected = projectWorklogs(dayWorklogs, ops, timeZone, accountId);
    const afterByIssue = sumBy(projected);
    const afterTotal = projected.reduce((sum, worklog) => sum + worklog.seconds, 0);

    const changesTime = ops.some(
      (op) => op.kind !== 'update' || op.after.seconds !== op.before.seconds,
    );
    // The table is applied as written, so a day that won't come to the expected hours is
    // flagged for review rather than stopped. Nothing is ever padded to make it up.
    if (builder.problems.length === 0 && changesTime) {
      if (afterTotal > spec.maxDaySeconds) {
        builder.warnings.push(
          `Even if every change succeeds, the day will total ${h(afterTotal)}, over ${h(spec.maxDaySeconds)}.`,
        );
      } else if (afterTotal !== spec.expectedDaySeconds) {
        builder.warnings.push(
          `Even if every change succeeds, the day will total ${h(afterTotal)}, not ${h(spec.expectedDaySeconds)}. Nothing is padded to make it up.`,
        );
      }
    }
    for (const op of ops) {
      if (op.kind !== 'create') {
        const worklog = dayWorklogs.find((item) => item.id === op.worklogId);
        if (worklog === undefined || worklog.authorAccountId !== accountId) {
          builder.problems.push(`Worklog ${op.worklogId} isn't yours, so it can't be changed.`);
        }
      }
    }

    days.push({
      date,
      status: builder.problems.length > 0 ? 'blocked' : ops.length === 0 ? 'unchanged' : 'ready',
      problems: [...new Set(builder.problems)],
      warnings: [...new Set(builder.warnings)],
      notes: [...new Set(builder.notes)],
      expectedBefore,
      before: {
        worklogs: dayWorklogs.map(snapshot),
        byIssue: beforeByIssue,
        totalSeconds: beforeTotal,
      },
      after:
        builder.problems.length > 0
          ? { byIssue: beforeByIssue, totalSeconds: beforeTotal }
          : { byIssue: afterByIssue, totalSeconds: afterTotal },
      ops,
    });
  }

  // Days the file says to check but not change, e.g. one held over by a locked issue.
  for (const check of spec.dayTotals) {
    if (days.some((day) => day.date === check.date)) {
      continue;
    }
    const dayWorklogs = onDay(check.date);
    const total = dayWorklogs.reduce((sum, worklog) => sum + worklog.seconds, 0);
    days.push({
      date: check.date,
      status: 'unchanged',
      problems: [],
      warnings: [],
      notes: [
        ...(check.reason === '' ? [] : [check.reason]),
        ...dayWorklogs
          .filter((worklog) => context.lockedIssues[worklog.issueKey] !== undefined)
          .map(
            (worklog) =>
              `${worklog.issueKey} ${h(worklog.seconds)} is on a locked issue and left alone.`,
          ),
      ],
      expectedBefore: {},
      before: {
        worklogs: dayWorklogs.map(snapshot),
        byIssue: sumBy(dayWorklogs),
        totalSeconds: total,
      },
      after: { byIssue: sumBy(dayWorklogs), totalSeconds: total },
      ops: [],
    });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));

  const readyOps = days.filter((day) => day.status === 'ready').flatMap((day) => day.ops);
  const checks: CheckResult[] = [];
  for (const total of spec.issueTotals) {
    let planned = 0;
    let ifApplied = 0;
    const blocked: string[] = [];
    for (const correction of spec.days) {
      const change = correction.changes.find(
        (item): item is SetChange => item.kind === 'set' && item.issueKey === total.issueKey,
      );
      if (change === undefined) {
        continue;
      }
      const day = days.find((item) => item.date === correction.date);
      planned += change.toSeconds;
      if (day?.status === 'ready') {
        ifApplied += change.toSeconds;
      } else {
        const builder = new DayBuilder(correction.date, onDay(correction.date), spec, context);
        ifApplied += builder.current(total.issueKey);
        if (day?.status === 'blocked') {
          blocked.push(correction.date);
        }
      }
    }
    checks.push({
      label: `${total.label} total`,
      ok: ifApplied === total.seconds,
      detail:
        `${h(ifApplied)} after applying the ready days (expected ${h(total.seconds)}, ` +
        `${Math.round((ifApplied / spec.expectedDaySeconds) * 100) / 100} days); ` +
        `${h(planned)} if every day applied` +
        (blocked.length > 0 ? `; blocked: ${blocked.join(', ')}` : ''),
    });
  }
  for (const check of spec.dayTotals) {
    const day = days.find((item) => item.date === check.date);
    const total = day?.after.totalSeconds ?? 0;
    checks.push({
      label: `${check.date} total`,
      ok: total === check.seconds,
      detail: `${h(total)} (expected ${h(check.seconds)})${check.reason === '' ? '' : `: ${check.reason}`}`,
    });
  }
  const totalChecks = spec.issueTotals.map((total) => {
    const dates = spec.days
      .filter((day) => day.changes.some((c) => c.kind === 'set' && c.issueKey === total.issueKey))
      .map((day) => day.date);
    return {
      label: total.label,
      issueKey: total.issueKey,
      dates,
      seconds: total.seconds,
      excludeWorklogIds: own
        .filter(
          (worklog) =>
            worklog.issueKey === total.issueKey &&
            dates.includes(worklog.date) &&
            isProtected(worklog, spec.protect) !== undefined,
        )
        .map((worklog) => worklog.id),
    };
  });
  const changedDays = days.filter(
    (day) =>
      day.status === 'ready' &&
      day.ops.some((op) => op.kind !== 'update' || op.after.seconds !== op.before.seconds),
  );
  checks.push({
    label: 'Changed days total the expected hours',
    ok: changedDays.every((day) => day.after.totalSeconds === spec.expectedDaySeconds),
    detail: `${changedDays.length} days change time; each comes to ${h(spec.expectedDaySeconds)}`,
  });

  const range = spec.validate ?? { ...correctionsRange(spec), leaveIssueKeys: [] };
  const projected = projectWorklogs(own, readyOps, timeZone, accountId);
  const findings = validateWorklogs(projected, {
    from: range.from,
    to: range.to,
    timeZone,
    expectedDaySeconds: spec.expectedDaySeconds,
    leaveIssueKeys: range.leaveIssueKeys,
    leaveDates: new Set(spec.protect.flatMap((rule) => rule.dates)),
    lockedIssues: context.lockedIssues,
    mergedAt: context.mergedAt ?? new Map(),
  });

  const identity = JSON.stringify({
    accountId,
    timeZone,
    site: context.site,
    days: days.map((day) => ({
      date: day.date,
      status: day.status,
      before: day.before.worklogs,
      ops: day.ops,
    })),
  });
  return {
    version: 1,
    planId: hashText(identity),
    createdAt: (context.now ?? new Date()).toISOString(),
    name: spec.name,
    site: context.site,
    accountId,
    timeZone,
    maxDaySeconds: spec.maxDaySeconds,
    expectedDaySeconds: spec.expectedDaySeconds,
    markerKey: CORRECTION_MARKER_KEY,
    days,
    checks,
    totalChecks,
    findings,
  };
}

/** "13:45–17:30" for a worklog-shaped thing, in the plan's zone. */
export function timeSpan(startedMs: number, seconds: number, timeZone: string): string {
  return `${timeInZone(startedMs, timeZone)}–${timeInZone(startedMs + seconds * 1000, timeZone)}`;
}
