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

/**
 * Shares `remaining` seconds of free time between the allocations in 15-minute blocks. Each
 * allocation's share is rounded down to whole blocks and the blocks that rounding leaves over go
 * to the largest allocation, so allocations adding up to 100% fill every free block. Allocations
 * adding up to more than 100% share the week in proportion, so every one of them gets its part.
 *
 * Every morning and afternoon gets its part of each allocation's share, one after the other in
 * the order of the allocations, so a 10% allocation is logged 15 to 30 minutes at a time all
 * through the week rather than in one go. Time left unallocated is spread the same way, at the
 * end of each morning and afternoon.
 */
function fillAllocations(
  allocations: PercentageAllocation[],
  sessions: FreeGap[][],
  remaining: number,
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

  // The week's blocks in the order Webster's method hands them out: the next goes to the share
  // with the most blocks per (2 × blocks given so far + 1), ties in allocation order. Any stretch
  // of this order holds close to each share's part of it, so cutting it into sessions spreads
  // every share evenly through the week. Unallocated time is the last share.
  const shares = [...blocks, available - total];
  const order = shares
    .flatMap((count, owner) =>
      Array.from({ length: Math.max(0, count) }, (_, given) => ({ owner, given })),
    )
    .sort(
      (a, b) =>
        (2 * a.given + 1) * shares[b.owner] - (2 * b.given + 1) * shares[a.owner] ||
        a.owner - b.owner,
    );

  const creations: WorklogCreation[] = [];
  let next = 0;
  for (const session of sessions) {
    const counts = shares.map(() => 0);
    for (const { owner } of order.slice(next, next + room(session))) {
      counts[owner]++;
    }
    next += room(session);

    let gapIndex = 0;
    let used = 0;
    counts.forEach((count, owner) => {
      let left = count;
      while (left > 0 && gapIndex < session.length) {
        const { gap, blocks: gapBlocks } = session[gapIndex];
        const take = Math.min(left, gapBlocks - used);
        const allocation = allocations[owner];
        if (allocation !== undefined) {
          creations.push({
            issueKey: allocation.issueKey,
            started: new Date(gap.start.getTime() + used * BLOCK_SECONDS * 1000).toISOString(),
            timeSpentSeconds: take * BLOCK_SECONDS,
            comment: allocation.summary,
            source: 'allocated',
          });
        }
        left -= take;
        used += take;
        if (used === gapBlocks) {
          gapIndex++;
          used = 0;
        }
      }
    });
  }
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
      remaining > 0 ? fillAllocations(allocations, freeSessions(input, occupied), remaining) : [];

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
