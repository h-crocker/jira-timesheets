import { Injectable } from '@angular/core';
import type {
  CalendarEvent,
  EngineInput,
  ExecutionPlan,
  JiraWorklog,
  PercentageAllocation,
  WorklogCreation,
  WorklogDeletion,
} from '../models/domain';
import { clashesWithLeave, planLeave } from './leave-planner';
import {
  BLOCK_SECONDS,
  type Interval,
  addDays,
  durationSeconds,
  freeWorkTime,
  matchRecorded,
  overlaps,
  recurringEvents,
  sameMinute,
  weekKey,
  workIntervals,
} from './schedule-time';

function toEvent(worklog: JiraWorklog): CalendarEvent {
  return {
    id: worklog.id,
    issueKey: worklog.issueKey,
    summary: worklog.comment ?? worklog.issueKey,
    start: worklog.started,
    end: new Date(worklog.started.getTime() + worklog.timeSpentSeconds * 1000),
    timeSpentSeconds: worklog.timeSpentSeconds,
    source: 'jira',
    worklogId: worklog.id,
  };
}

interface FreeGap {
  gap: Interval;
  blocks: number;
}

/**
 * The week's free working time as sessions: each morning and afternoon in order, with its free
 * gaps and the whole blocks each holds.
 */
function freeSessions(input: EngineInput, occupied: Interval[]): FreeGap[][] {
  const { weekStart, settings } = input;
  return [...new Set(settings.workDays)]
    .sort((a, b) => a - b)
    .flatMap((weekday) => {
      const free = freeWorkTime(weekStart, weekday, settings, occupied);
      return workIntervals(weekStart, weekday, settings).map((interval) =>
        free
          .filter((gap) => gap.start >= interval.start && gap.end <= interval.end)
          .map((gap) => ({ gap, blocks: Math.floor(durationSeconds(gap) / BLOCK_SECONDS) }))
          .filter(({ blocks }) => blocks > 0),
      );
    })
    .filter((session) => session.length > 0);
}

/** A 32-bit FNV-1a hash of `text`, to seed the week's scattering. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  }
  return value >>> 0;
}

/** A small seeded random number generator (mulberry32), giving numbers in [0, 1). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether an allocation on `issueKey` is scattered through the week rather than logged in a block. */
export function isSpread(issueKey: string, spreadPrefixes: string[]): boolean {
  const key = issueKey.trim().toUpperCase();
  return spreadPrefixes.some((prefix) => {
    const wanted = prefix.trim().toUpperCase();
    return wanted !== '' && key.startsWith(wanted);
  });
}

/** One free 15-minute block of the week. */
interface Slot {
  gap: Interval;
  /** Blocks from the start of the gap. */
  offset: number;
  session: number;
}

/**
 * Shares `remaining` seconds of free time between the allocations in 15-minute blocks. Each
 * allocation's share is rounded down to whole blocks and the blocks that rounding leaves over go
 * to the largest allocation, so allocations adding up to 100% fill every free block. Allocations
 * adding up to more than 100% share the week in proportion, so every one of them gets its part.
 * Time left unallocated is left empty at the end of each morning and afternoon, in proportion.
 *
 * Allocations on issues starting with one of `spreadPrefixes` are scattered through the week:
 * each of their blocks lands somewhere random in its own equal part of the week, so they turn up
 * a little at a time all week long. The scattering is seeded from `seed`, so the same week plans
 * the same way every time and syncing twice changes nothing. Every other allocation is logged in
 * one block in the order of the allocations, so one task follows another through the week.
 */
function fillAllocations(
  allocations: PercentageAllocation[],
  sessions: FreeGap[][],
  remaining: number,
  spreadPrefixes: string[],
  seed: string,
): WorklogCreation[] {
  const room = (session: FreeGap[]) => session.reduce((sum, { blocks }) => sum + blocks, 0);
  const available = Math.min(
    sessions.reduce((sum, session) => sum + room(session), 0),
    Math.floor(remaining / BLOCK_SECONDS),
  );
  const whole = Math.max(
    100,
    allocations.reduce((sum, allocation) => sum + allocation.percentage, 0),
  );
  const exact = allocations.map((allocation) => (available * allocation.percentage) / whole);
  const blocks = exact.map((share) => Math.floor(share + 1e-9));
  const total = Math.min(
    available,
    Math.floor(exact.reduce((sum, share) => sum + share, 0) + 1e-9),
  );
  if (allocations.length > 0) {
    const largest = allocations.reduce(
      (best, allocation, index) =>
        allocation.percentage > allocations[best].percentage ? index : best,
      0,
    );
    blocks[largest] += Math.max(0, total - blocks.reduce((sum, count) => sum + count, 0));
  }

  // The week's free blocks in order, then the ones left unallocated taken out: they are the end
  // of each morning and afternoon, each session giving up its part of them (Webster's method,
  // which keeps every stretch of the week close to its share).
  const slots: Slot[] = sessions
    .flatMap((session, index) =>
      session.flatMap(({ gap, blocks: count }) =>
        Array.from({ length: count }, (_, offset) => ({ gap, offset, session: index })),
      ),
    )
    .slice(0, available);
  const shares = [total, available - total];
  const order = shares
    .flatMap((count, owner) => Array.from({ length: count }, (_, given) => ({ owner, given })))
    .sort(
      (a, b) =>
        (2 * a.given + 1) * shares[b.owner] - (2 * b.given + 1) * shares[a.owner] ||
        a.owner - b.owner,
    );
  const timeline: Slot[] = [];
  let next = 0;
  sessions.forEach((session, index) => {
    const mine = slots.filter((slot) => slot.session === index);
    const empty = order.slice(next, next + mine.length).filter(({ owner }) => owner === 1).length;
    next += mine.length;
    timeline.push(...mine.slice(0, mine.length - empty));
  });

  // Scattered allocations pick their blocks first, each from its own part of the week; the rest
  // take what is left, one after another.
  const owners: (number | undefined)[] = timeline.map(() => undefined);
  const spread = allocations.map((allocation) => isSpread(allocation.issueKey, spreadPrefixes));
  const pick = random(hash(`${seed}|${allocations.map((allocation) => allocation.id).join(',')}`));
  const free = (from: number, to: number) => {
    const indexes: number[] = [];
    for (let index = from; index < to; index++) {
      if (owners[index] === undefined) {
        indexes.push(index);
      }
    }
    return indexes;
  };
  allocations.forEach((_, owner) => {
    const count = blocks[owner];
    if (!spread[owner] || count <= 0) {
      return;
    }
    for (let part = 0; part < count; part++) {
      const from = Math.floor((part * total) / count);
      const to = Math.floor(((part + 1) * total) / count);
      let candidates = free(from, to);
      if (candidates.length === 0) {
        const middle = (from + to) / 2;
        candidates = free(0, total).sort(
          (a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b,
        );
        candidates = candidates.slice(0, 1);
      }
      owners[candidates[Math.floor(pick() * candidates.length)]] = owner;
    }
  });
  let cursor = 0;
  allocations.forEach((_, owner) => {
    let left = spread[owner] ? 0 : blocks[owner];
    while (left > 0 && cursor < total) {
      if (owners[cursor] === undefined) {
        owners[cursor] = owner;
        left--;
      }
      cursor++;
    }
  });

  // Consecutive blocks of the same allocation in the same gap make one worklog.
  const creations: WorklogCreation[] = [];
  let run: { owner: number; gap: Interval; offset: number; blocks: number } | null = null;
  const flush = () => {
    if (run !== null) {
      const allocation = allocations[run.owner];
      creations.push({
        issueKey: allocation.issueKey,
        started: new Date(
          run.gap.start.getTime() + run.offset * BLOCK_SECONDS * 1000,
        ).toISOString(),
        timeSpentSeconds: run.blocks * BLOCK_SECONDS,
        comment: allocation.summary,
        source: 'allocated',
      });
    }
    run = null;
  };
  timeline.forEach((slot, index) => {
    const owner = owners[index];
    if (owner === undefined) {
      flush();
      return;
    }
    if (
      run !== null &&
      run.owner === owner &&
      run.gap === slot.gap &&
      run.offset + run.blocks === slot.offset
    ) {
      run.blocks++;
    } else {
      flush();
      run = { owner, gap: slot.gap, offset: slot.offset, blocks: 1 };
    }
  });
  flush();
  return creations;
}

@Injectable({ providedIn: 'root' })
export class TimesheetEngineService {
  /**
   * Recurring events win over clashing worklogs, leave wins over both, and allocations fill the
   * rest of the week. The app's own worklogs stay only while the settings still produce them, so a
   * change to the allocations shows in the plan even once the week has been synced.
   *
   * A week whose allocations were filled from activity (`settings.weekAllocations`) uses those and
   * replaces what Jira logged automatically: every worklog that isn't the app's own, leave or a
   * recorded recurring event is deleted. Either way, syncing twice changes nothing.
   */
  computePlan(input: EngineInput): ExecutionPlan {
    const { weekStart, settings } = input;
    const weekEnd = addDays(weekStart, 7);
    const ownAllocations = settings.weekAllocations[weekKey(weekStart)];
    const replacing = ownAllocations !== undefined;
    const allocations = ownAllocations ?? settings.allocations;
    const worklogs = input.worklogs.filter(
      (worklog) => worklog.started >= weekStart && worklog.started < weekEnd,
    );
    const leave = planLeave(weekStart, settings, worklogs, input.leaveDays ?? []);
    const recurringEventsThisWeek = recurringEvents(weekStart, settings).filter(
      (event) => !clashesWithLeave(event, leave),
    );
    const others = worklogs.filter((worklog) => !leave.handled.has(worklog.id));

    // A worklog that already records a recurring event (same issue, start and duration) satisfies
    // it, so syncing again neither deletes it nor logs the event twice.
    const { recorded, unrecorded } = matchRecorded(recurringEventsThisWeek, others);

    const deletions: WorklogDeletion[] = [...leave.deletions];
    const absorb: JiraWorklog[] = [];
    const replaceable: JiraWorklog[] = [];
    const keptJiraEvents: CalendarEvent[] = [];
    for (const worklog of others) {
      if (recorded.has(worklog.id)) {
        continue;
      }
      const jiraEvent = toEvent(worklog);
      if (worklog.generated) {
        replaceable.push(worklog);
      } else if (replacing) {
        deletions.push({
          worklogId: worklog.id,
          issueKey: worklog.issueKey,
          reason: 'replaced-by-activity',
        });
        absorb.push(worklog);
      } else if (recurringEventsThisWeek.some((recurring) => overlaps(recurring, jiraEvent))) {
        deletions.push({
          worklogId: worklog.id,
          issueKey: worklog.issueKey,
          reason: 'overlap-with-recurring',
        });
      } else if (leave.intervals.some((interval) => overlaps(interval, jiraEvent))) {
        deletions.push({
          worklogId: worklog.id,
          issueKey: worklog.issueKey,
          reason: 'overlap-with-leave',
        });
      } else {
        keptJiraEvents.push(jiraEvent);
      }
    }

    const creations: WorklogCreation[] = [
      ...leave.creations,
      ...unrecorded.map((event): WorklogCreation => ({
        issueKey: event.issueKey,
        started: event.start.toISOString(),
        timeSpentSeconds: event.timeSpentSeconds,
        comment: event.summary,
        source: 'recurring',
      })),
    ];

    const totalWeekCapacitySeconds = settings.workDays.length * settings.hoursPerDay * 3600;
    const occupied: Interval[] = [
      ...keptJiraEvents.map((event) => ({ start: event.start, end: event.end })),
      ...recurringEventsThisWeek.map((event) => ({ start: event.start, end: event.end })),
      ...leave.intervals,
    ];
    const occupiedSeconds = occupied.reduce((sum, interval) => sum + durationSeconds(interval), 0);
    const remaining = totalWeekCapacitySeconds - occupiedSeconds;

    const allocated =
      remaining > 0
        ? fillAllocations(
            allocations,
            freeSessions(input, occupied),
            remaining,
            settings.spreadPrefixes,
            weekKey(weekStart),
          )
        : [];

    // The app's own worklogs that match the fill stay; the rest go.
    const kept = new Set<string>();
    for (const want of allocated) {
      const existing = replaceable.find(
        (worklog) =>
          !kept.has(worklog.id) &&
          worklog.issueKey === want.issueKey &&
          sameMinute(worklog.started, new Date(want.started)) &&
          worklog.timeSpentSeconds === want.timeSpentSeconds,
      );
      if (existing === undefined) {
        creations.push(want);
      } else {
        kept.add(existing.id);
      }
    }
    for (const worklog of replaceable) {
      if (!kept.has(worklog.id)) {
        deletions.push({
          worklogId: worklog.id,
          issueKey: worklog.issueKey,
          reason: 'stale-generated',
        });
      }
    }

    creations.sort((a, b) => a.started.localeCompare(b.started));
    return { deletions, creations, absorb };
  }
}
