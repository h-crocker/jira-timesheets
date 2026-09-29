import { Injectable } from '@angular/core';
import type {
  CalendarEvent,
  EngineInput,
  ExecutionPlan,
  WorklogCreation,
  WorklogDeletion,
} from '../models/domain';
import { planFromActivity } from './activity-distribution';
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
} from './schedule-time';

@Injectable({ providedIn: 'root' })
export class TimesheetEngineService {
  computePlan(input: EngineInput): ExecutionPlan {
    return input.settings.activityMode ? planFromActivity(input) : this.planFromAllocations(input);
  }

  /** Recurring events win over clashing worklogs, leave wins over both, allocations fill the rest. */
  private planFromAllocations(input: EngineInput): ExecutionPlan {
    const { weekStart, settings } = input;
    const weekEnd = addDays(weekStart, 7);
    const worklogs = input.worklogs.filter(
      (worklog) => worklog.started >= weekStart && worklog.started < weekEnd,
    );
    const leave = planLeave(weekStart, settings, worklogs, input.leaveDays ?? []);
    const recurringEventsThisWeek = recurringEvents(weekStart, settings).filter(
      (event) => !clashesWithLeave(event, leave),
    );

    const jiraEvents: CalendarEvent[] = worklogs
      .filter((worklog) => !leave.handled.has(worklog.id))
      .map((worklog) => ({
        id: worklog.id,
        issueKey: worklog.issueKey,
        summary: worklog.comment ?? worklog.issueKey,
        start: worklog.started,
        end: new Date(worklog.started.getTime() + worklog.timeSpentSeconds * 1000),
        timeSpentSeconds: worklog.timeSpentSeconds,
        source: 'jira' as const,
        worklogId: worklog.id,
      }));

    // A worklog that already records a recurring event (same issue, start and duration) satisfies
    // it, so syncing again neither deletes it nor logs the event twice.
    const { recorded, unrecorded } = matchRecorded(
      recurringEventsThisWeek,
      worklogs.filter((worklog) => !leave.handled.has(worklog.id)),
    );

    const deletions: WorklogDeletion[] = [...leave.deletions];
    const keptJiraEvents: CalendarEvent[] = [];
    for (const jiraEvent of jiraEvents) {
      if (recorded.has(jiraEvent.id)) {
        continue;
      }
      if (recurringEventsThisWeek.some((recurring) => overlaps(recurring, jiraEvent))) {
        deletions.push({
          worklogId: jiraEvent.worklogId ?? jiraEvent.id,
          issueKey: jiraEvent.issueKey,
          reason: 'overlap-with-recurring',
        });
      } else if (leave.intervals.some((interval) => overlaps(interval, jiraEvent))) {
        deletions.push({
          worklogId: jiraEvent.worklogId ?? jiraEvent.id,
          issueKey: jiraEvent.issueKey,
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

    if (remaining > 0) {
      const daySlots = settings.workDays
        .map((weekday) => daySlot(weekStart, weekday, settings))
        .sort((a, b) => a.start.getTime() - b.start.getTime());

      for (const allocation of settings.allocations) {
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
            creations.push({
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

    creations.sort((a, b) => a.started.localeCompare(b.started));
    return { deletions, creations, absorb: [] };
  }
}
