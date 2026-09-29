import { Injectable } from '@angular/core';
import type {
  CalendarEvent,
  EngineInput,
  ExecutionPlan,
  WorklogCreation,
  WorklogDeletion,
} from '../models/domain';

const ROUNDING_INTERVAL_SECONDS = 900;

interface Interval {
  start: Date;
  end: Date;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function timeOnDay(day: Date, time: string): Date {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  const result = new Date(day.getTime());
  result.setHours(hours, minutes, 0, 0);
  return result;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

function sameMinute(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / 60000) === Math.floor(b.getTime() / 60000);
}

function freeGaps(slot: Interval, occupied: Interval[]): Interval[] {
  const relevant = occupied
    .map((interval) => ({
      start: new Date(Math.max(interval.start.getTime(), slot.start.getTime())),
      end: new Date(Math.min(interval.end.getTime(), slot.end.getTime())),
    }))
    .filter((interval) => interval.start < interval.end)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const gaps: Interval[] = [];
  let cursor = slot.start;
  for (const interval of relevant) {
    if (interval.start > cursor) {
      gaps.push({ start: cursor, end: interval.start });
    }
    if (interval.end > cursor) {
      cursor = interval.end;
    }
  }
  if (cursor < slot.end) {
    gaps.push({ start: cursor, end: slot.end });
  }
  return gaps;
}

@Injectable({ providedIn: 'root' })
export class TimesheetEngineService {
  computePlan(input: EngineInput): ExecutionPlan {
    const { weekStart, settings, worklogs } = input;
    const weekEnd = addDays(weekStart, 7);

    const recurringEvents: CalendarEvent[] = [];
    for (const schedule of settings.schedules) {
      if (!schedule.enabled) {
        continue;
      }
      for (const weekday of schedule.weekdays) {
        if (!settings.workDays.includes(weekday)) {
          continue;
        }
        const start = timeOnDay(addDays(weekStart, weekday - 1), schedule.startTime);
        recurringEvents.push({
          id: `${schedule.id}-weekday-${weekday}`,
          issueKey: schedule.issueKey,
          summary: schedule.summary,
          start,
          end: new Date(start.getTime() + schedule.durationSeconds * 1000),
          timeSpentSeconds: schedule.durationSeconds,
          source: 'recurring',
        });
      }
    }

    const jiraEvents: CalendarEvent[] = worklogs
      .filter((worklog) => worklog.started >= weekStart && worklog.started < weekEnd)
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
    const recorded = new Set<string>();
    const unrecordedEvents = recurringEvents.filter((recurring) => {
      const record = jiraEvents.find(
        (jiraEvent) =>
          !recorded.has(jiraEvent.id) &&
          jiraEvent.issueKey === recurring.issueKey &&
          sameMinute(jiraEvent.start, recurring.start) &&
          jiraEvent.timeSpentSeconds === recurring.timeSpentSeconds,
      );
      if (record !== undefined) {
        recorded.add(record.id);
      }
      return record === undefined;
    });

    const deletions: WorklogDeletion[] = [];
    const keptJiraEvents: CalendarEvent[] = [];
    for (const jiraEvent of jiraEvents) {
      if (recorded.has(jiraEvent.id)) {
        continue;
      }
      const clashesWithRecurring = recurringEvents.some((recurring) => overlaps(recurring, jiraEvent));
      if (clashesWithRecurring) {
        deletions.push({
          worklogId: jiraEvent.worklogId ?? jiraEvent.id,
          issueKey: jiraEvent.issueKey,
          reason: 'overlap-with-recurring',
        });
      } else {
        keptJiraEvents.push(jiraEvent);
      }
    }

    const creations: WorklogCreation[] = unrecordedEvents.map((event) => ({
      issueKey: event.issueKey,
      started: event.start.toISOString(),
      timeSpentSeconds: event.timeSpentSeconds,
      comment: event.summary,
      source: 'recurring',
    }));

    const totalWeekCapacitySeconds = settings.workDays.length * settings.hoursPerDay * 3600;
    const occupiedSeconds =
      keptJiraEvents.reduce((sum, event) => sum + event.timeSpentSeconds, 0) +
      recurringEvents.reduce((sum, event) => sum + event.timeSpentSeconds, 0);
    const remaining = totalWeekCapacitySeconds - occupiedSeconds;

    if (remaining > 0) {
      const occupied: Interval[] = [
        ...keptJiraEvents.map((event) => ({ start: event.start, end: event.end })),
        ...recurringEvents.map((event) => ({ start: event.start, end: event.end })),
      ];

      const daySlots: Interval[] = settings.workDays
        .map((weekday) => {
          const start = timeOnDay(addDays(weekStart, weekday - 1), settings.startTime);
          return { start, end: new Date(start.getTime() + settings.hoursPerDay * 3600 * 1000) };
        })
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
            const gapLengthSeconds = (gap.end.getTime() - gap.start.getTime()) / 1000;
            const chunk = Math.min(allocationRemaining, gapLengthSeconds);
            const rounded = Math.floor(chunk / ROUNDING_INTERVAL_SECONDS) * ROUNDING_INTERVAL_SECONDS;
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
            occupied.push({ start: chunkStart, end: new Date(chunkStart.getTime() + rounded * 1000) });
            allocationRemaining -= rounded;
          }
        }
      }
    }

    creations.sort((a, b) => a.started.localeCompare(b.started));
    return { deletions, creations };
  }
}
