import { Injectable } from '@angular/core';
import type {
  CalendarEvent,
  EngineInput,
  ExecutionPlan,
  JiraWorklog,
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

    const allocated: WorklogCreation[] = [];
    if (remaining > 0) {
      const daySlots = settings.workDays
        .map((weekday) => daySlot(weekStart, weekday, settings))
        .sort((a, b) => a.start.getTime() - b.start.getTime());

      for (const allocation of allocations) {
        let allocationRemaining = remaining * (allocation.percentage / 100);
        for (const slot of daySlots) {
          if (allocationRemaining <= 0) {
            break;
          }
          for (const gap of freeGaps(slot, occupied)) {
            if (allocationRemaining <= 0) {
              break;
            }
            const chunk = Math.min(allocationRemaining, durationSeconds(gap));
            const rounded = Math.floor(chunk / BLOCK_SECONDS) * BLOCK_SECONDS;
            if (rounded <= 0) {
              continue;
            }
            const chunkStart = gap.start;
            allocated.push({
              issueKey: allocation.issueKey,
              started: chunkStart.toISOString(),
              timeSpentSeconds: rounded,
              comment: allocation.summary,
              source: 'allocated',
            });
            occupied.push({
              start: chunkStart,
              end: new Date(chunkStart.getTime() + rounded * 1000),
            });
            allocationRemaining -= rounded;
          }
        }
      }
    }

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
