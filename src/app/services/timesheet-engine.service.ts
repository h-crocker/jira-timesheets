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
  daySlot,
  durationSeconds,
  freeGaps,
  matchRecorded,
  overlaps,
  recurringEvents,
  sameMinute,
  weekKey,
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

/** The week's free time in working hours, in order, each gap with the whole blocks it holds. */
function freeWeekGaps(
  input: EngineInput,
  occupied: Interval[],
): Array<{ gap: Interval; blocks: number }> {
  return input.settings.workDays
    .map((weekday) => daySlot(input.weekStart, weekday, input.settings))
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .flatMap((slot) => freeGaps(slot, occupied))
    .map((gap) => ({ gap, blocks: Math.floor(durationSeconds(gap) / BLOCK_SECONDS) }))
    .filter(({ blocks }) => blocks > 0);
}

/**
 * Shares `remaining` seconds of free time between the allocations in 15-minute blocks, in order
 * from the start of the week. Each allocation's share is rounded down to whole blocks and the
 * blocks that rounding leaves over go to the largest allocation, so allocations adding up to 100%
 * fill every free block.
 */
function fillAllocations(
  allocations: PercentageAllocation[],
  gaps: Array<{ gap: Interval; blocks: number }>,
  remaining: number,
): WorklogCreation[] {
  const available = Math.min(
    gaps.reduce((sum, { blocks }) => sum + blocks, 0),
    Math.floor(remaining / BLOCK_SECONDS),
  );
  const exact = allocations.map((allocation) => (available * allocation.percentage) / 100);
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

  const creations: WorklogCreation[] = [];
  let gapIndex = 0;
  let used = 0;
  allocations.forEach((allocation, index) => {
    let left = blocks[index];
    while (left > 0 && gapIndex < gaps.length) {
      const { gap, blocks: room } = gaps[gapIndex];
      const take = Math.min(left, room - used);
      creations.push({
        issueKey: allocation.issueKey,
        started: new Date(gap.start.getTime() + used * BLOCK_SECONDS * 1000).toISOString(),
        timeSpentSeconds: take * BLOCK_SECONDS,
        comment: allocation.summary,
        source: 'allocated',
      });
      left -= take;
      used += take;
      if (used === room) {
        gapIndex++;
        used = 0;
      }
    }
  });
  return creations;
}

@Injectable({ providedIn: 'root' })
export class TimesheetEngineService {
  /**
   * Recurring events win over clashing worklogs, leave wins over both, and allocations fill the
   * rest of the week.
   *
   * A week whose allocations were filled from activity (`settings.weekAllocations`) uses those and
   * replaces what Jira logged automatically: every worklog that isn't the app's own, leave or a
   * recorded recurring event is deleted, and the app's own worklogs stay only while the allocations
   * still produce them. Either way, syncing twice changes nothing.
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
      if (replacing && worklog.generated) {
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
      remaining > 0 ? fillAllocations(allocations, freeWeekGaps(input, occupied), remaining) : [];

    // When replacing, the app's own worklogs that match the fill stay; the rest go.
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
