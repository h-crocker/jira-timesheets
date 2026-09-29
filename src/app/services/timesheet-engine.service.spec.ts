import { TimesheetEngineService } from './timesheet-engine.service';
import type { EngineInput, JiraWorklog, UserSettings, WorklogCreation } from '../models/domain';

function monday(): Date {
  return new Date(2026, 8, 28, 0, 0, 0, 0);
}

function at(dayOffset: number, hours: number, minutes = 0, seconds = 0): Date {
  const date = monday();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hours, minutes, seconds, 0);
  return date;
}

function defaultSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    startTime: '09:00',
    hoursPerDay: 7.5,
    workDays: [1, 2, 3, 4, 5],
    allocations: [],
    schedules: [],
    ...overrides,
  };
}

function worklog(id: string, started: Date, timeSpentSeconds: number, issueKey = 'GWP-2070'): JiraWorklog {
  return { id, issueKey, started, timeSpentSeconds, generated: false };
}

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return { weekStart: monday(), settings: defaultSettings(), worklogs: [], ...overrides };
}

interface Span {
  start: number;
  end: number;
}

function toSpans(creations: WorklogCreation[]): Span[] {
  return creations.map((creation) => {
    const start = new Date(creation.started).getTime();
    return { start, end: start + creation.timeSpentSeconds * 1000 };
  });
}

function expectNoOverlaps(spans: Span[], label: string): void {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].start, `${label}: span starting at ${new Date(sorted[i].start).toISOString()} overlaps the previous span`).toBeGreaterThanOrEqual(sorted[i - 1].end);
  }
}

function expectNoOverlapWithOccupied(creations: WorklogCreation[], occupied: Span[], label: string): void {
  expectNoOverlaps([...toSpans(creations), ...occupied], label);
}

describe('TimesheetEngineService', () => {
  const engine = new TimesheetEngineService();

  it('returns an empty plan for empty input', () => {
    expect(engine.computePlan(input())).toEqual({ deletions: [], creations: [] });
  });

  it('creates one occurrence per scheduled weekday with exact times', () => {
    const settings = defaultSettings({
      schedules: [
        {
          id: 's1',
          issueKey: 'GWP-1',
          summary: 'Standup',
          weekdays: [1, 3],
          startTime: '10:00',
          durationSeconds: 3600,
          enabled: true,
        },
      ],
    });

    const plan = engine.computePlan(input({ settings }));

    expect(plan.deletions).toEqual([]);
    expect(plan.creations).toEqual([
      { issueKey: 'GWP-1', started: at(0, 10).toISOString(), timeSpentSeconds: 3600, comment: 'Standup', source: 'recurring' },
      { issueKey: 'GWP-1', started: at(2, 10).toISOString(), timeSpentSeconds: 3600, comment: 'Standup', source: 'recurring' },
    ]);
  });

  it('flags a fully overlapping Jira worklog for deletion and keeps the recurring event', () => {
    const settings = defaultSettings({
      schedules: [
        {
          id: 's1',
          issueKey: 'GWP-1',
          summary: 'Standup',
          weekdays: [1],
          startTime: '10:30',
          durationSeconds: 3600,
          enabled: true,
        },
      ],
    });

    const plan = engine.computePlan(input({ settings, worklogs: [worklog('w1', at(0, 10), 3600)] }));

    expect(plan.deletions).toEqual([
      { worklogId: 'w1', issueKey: 'GWP-2070', reason: 'overlap-with-recurring' },
    ]);
    expect(plan.creations).toEqual([
      { issueKey: 'GWP-1', started: at(0, 10, 30).toISOString(), timeSpentSeconds: 3600, comment: 'Standup', source: 'recurring' },
    ]);
  });

  it('flags a partially overlapping Jira worklog for deletion', () => {
    const settings = defaultSettings({
      schedules: [
        {
          id: 's1',
          issueKey: 'GWP-1',
          summary: 'Review',
          weekdays: [1],
          startTime: '10:30',
          durationSeconds: 7200,
          enabled: true,
        },
      ],
    });

    const plan = engine.computePlan(input({ settings, worklogs: [worklog('w1', at(0, 10), 3600)] }));

    expect(plan.deletions).toEqual([
      { worklogId: 'w1', issueKey: 'GWP-2070', reason: 'overlap-with-recurring' },
    ]);
    expect(plan.creations).toEqual([
      { issueKey: 'GWP-1', started: at(0, 10, 30).toISOString(), timeSpentSeconds: 7200, comment: 'Review', source: 'recurring' },
    ]);
  });

  it('does not delete a worklog that only touches a recurring event endpoint', () => {
    const settings = defaultSettings({
      schedules: [
        {
          id: 's1',
          issueKey: 'GWP-1',
          summary: 'Standup',
          weekdays: [1],
          startTime: '10:00',
          durationSeconds: 3600,
          enabled: true,
        },
      ],
    });

    const plan = engine.computePlan(input({ settings, worklogs: [worklog('w1', at(0, 9), 3600)] }));

    expect(plan.deletions).toEqual([]);
    expect(plan.creations).toEqual([
      { issueKey: 'GWP-1', started: at(0, 10).toISOString(), timeSpentSeconds: 3600, comment: 'Standup', source: 'recurring' },
    ]);
  });

  it('distributes a 75% allocation chronologically over the remaining capacity', () => {
    const settings = defaultSettings({
      schedules: [
        {
          id: 's1',
          issueKey: 'GWP-1',
          summary: 'Review',
          weekdays: [3],
          startTime: '09:00',
          durationSeconds: 7200,
          enabled: true,
        },
      ],
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 75 }],
    });

    const plan = engine.computePlan(input({ settings, worklogs: [worklog('w1', at(0, 9), 10800)] }));

    expect(plan.deletions).toEqual([]);
    const allocationCreations = plan.creations.filter((creation) => creation.issueKey === 'GWP-9');
    const total = allocationCreations.reduce((sum, creation) => sum + creation.timeSpentSeconds, 0);
    expect(total).toBeLessThanOrEqual(87750);
    expect(total).toBe(87300);
    expect(allocationCreations).toEqual([
      { issueKey: 'GWP-9', started: at(0, 12).toISOString(), timeSpentSeconds: 16200, comment: 'Allocation', source: 'allocated' },
      { issueKey: 'GWP-9', started: at(1, 9).toISOString(), timeSpentSeconds: 27000, comment: 'Allocation', source: 'allocated' },
      { issueKey: 'GWP-9', started: at(2, 11).toISOString(), timeSpentSeconds: 19800, comment: 'Allocation', source: 'allocated' },
      { issueKey: 'GWP-9', started: at(3, 9).toISOString(), timeSpentSeconds: 24300, comment: 'Allocation', source: 'allocated' },
    ]);
    expectNoOverlapWithOccupied(
      plan.creations,
      [{ start: at(0, 9).getTime(), end: at(0, 12).getTime() }],
      '75% allocation',
    );
  });

  it('continues an allocation on the next day when a day gap is exhausted', () => {
    const settings = defaultSettings({
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });

    const plan = engine.computePlan(input({ settings }));

    expect(plan.creations).toEqual([
      { issueKey: 'GWP-9', started: at(0, 9).toISOString(), timeSpentSeconds: 27000, comment: 'Allocation', source: 'allocated' },
      { issueKey: 'GWP-9', started: at(1, 9).toISOString(), timeSpentSeconds: 27000, comment: 'Allocation', source: 'allocated' },
      { issueKey: 'GWP-9', started: at(2, 9).toISOString(), timeSpentSeconds: 27000, comment: 'Allocation', source: 'allocated' },
      { issueKey: 'GWP-9', started: at(3, 9).toISOString(), timeSpentSeconds: 27000, comment: 'Allocation', source: 'allocated' },
      { issueKey: 'GWP-9', started: at(4, 9).toISOString(), timeSpentSeconds: 27000, comment: 'Allocation', source: 'allocated' },
    ]);
    expectNoOverlaps(toSpans(plan.creations), '100% allocation');
  });

  it('creates no allocations when the week is exactly fully booked', () => {
    const settings = defaultSettings({
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });

    const plan = engine.computePlan(input({ settings, worklogs: [worklog('w1', at(0, 9), 135000)] }));

    expect(plan.deletions).toEqual([]);
    expect(plan.creations).toEqual([]);
  });

  it('creates no allocations when worklogs exceed the weekly capacity', () => {
    const settings = defaultSettings({
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });

    const plan = engine.computePlan(
      input({ settings, worklogs: [worklog('w1', at(0, 9), 70000), worklog('w2', at(1, 9), 70000)] }),
    );

    expect(plan.creations).toEqual([]);
  });

  it('rounds chunks down to 15-minute intervals and discards sub-interval remainders', () => {
    const settings = defaultSettings({
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });

    const plan = engine.computePlan(input({ settings, worklogs: [worklog('w1', at(0, 9), 10890)] }));

    expect(plan.creations[0]).toEqual({
      issueKey: 'GWP-9',
      started: at(0, 12, 1, 30).toISOString(),
      timeSpentSeconds: 15300,
      comment: 'Allocation',
      source: 'allocated',
    });
    const total = plan.creations.reduce((sum, creation) => sum + creation.timeSpentSeconds, 0);
    expect(total).toBe(123300);
    for (const creation of plan.creations) {
      expect(creation.timeSpentSeconds % 900).toBe(0);
    }
    expectNoOverlapWithOccupied(
      plan.creations,
      [{ start: at(0, 9).getTime(), end: at(0, 12, 1, 30).getTime() }],
      'rounded allocation',
    );
  });

  it('places multiple allocations sequentially without overlap', () => {
    const settings = defaultSettings({
      allocations: [
        { id: 'a1', issueKey: 'GWP-9', summary: 'First', percentage: 50 },
        { id: 'a2', issueKey: 'GWP-10', summary: 'Second', percentage: 30 },
      ],
    });

    const plan = engine.computePlan(input({ settings }));

    const first = plan.creations.filter((creation) => creation.issueKey === 'GWP-9');
    const second = plan.creations.filter((creation) => creation.issueKey === 'GWP-10');
    expect(first.map((creation) => creation.timeSpentSeconds)).toEqual([27000, 27000, 13500]);
    expect(second.map((creation) => creation.timeSpentSeconds)).toEqual([13500, 27000]);
    expect(second[0].started).toBe(at(2, 12, 45).toISOString());
    expectNoOverlaps(toSpans(plan.creations), 'multiple allocations');
  });

  it('ignores worklogs outside the target week', () => {
    const settings = defaultSettings({
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });

    const plan = engine.computePlan(
      input({
        settings,
        worklogs: [worklog('w-before', new Date(2026, 8, 27, 9, 0), 3600), worklog('w-after', new Date(2026, 9, 5, 9, 0), 3600)],
      }),
    );

    expect(plan.deletions).toEqual([]);
    const total = plan.creations.reduce((sum, creation) => sum + creation.timeSpentSeconds, 0);
    expect(total).toBe(135000);
  });

  it('ignores disabled schedules', () => {
    const settings = defaultSettings({
      schedules: [
        {
          id: 's1',
          issueKey: 'GWP-1',
          summary: 'Standup',
          weekdays: [1],
          startTime: '10:00',
          durationSeconds: 3600,
          enabled: false,
        },
      ],
    });

    expect(engine.computePlan(input({ settings }))).toEqual({ deletions: [], creations: [] });
  });

  it('keeps a worklog that already records a recurring event rather than re-creating it', () => {
    const settings = defaultSettings({
      schedules: [
        {
          id: 's1',
          issueKey: 'GWP-1',
          summary: 'Standup',
          weekdays: [1, 2],
          startTime: '10:00',
          durationSeconds: 900,
          enabled: true,
        },
      ],
    });

    const worklogs = [worklog('w1', at(0, 10), 900, 'GWP-1')];
    const plan = engine.computePlan(input({ settings, worklogs }));

    expect(plan.deletions).toEqual([]);
    expect(plan.creations).toEqual([
      {
        issueKey: 'GWP-1',
        started: at(1, 10).toISOString(),
        timeSpentSeconds: 900,
        comment: 'Standup',
        source: 'recurring',
      },
    ]);
  });

  it('still replaces a clashing worklog on the recurring issue whose times differ', () => {
    const settings = defaultSettings({
      schedules: [
        {
          id: 's1',
          issueKey: 'GWP-1',
          summary: 'Standup',
          weekdays: [1],
          startTime: '10:00',
          durationSeconds: 900,
          enabled: true,
        },
      ],
    });

    const worklogs = [worklog('w1', at(0, 10), 1800, 'GWP-1')];
    const plan = engine.computePlan(input({ settings, worklogs }));

    expect(plan.deletions).toEqual([
      { worklogId: 'w1', issueKey: 'GWP-1', reason: 'overlap-with-recurring' },
    ]);
    expect(plan.creations).toHaveLength(1);
  });

  it('plans nothing once its own plan has been applied', () => {
    const settings = defaultSettings({
      schedules: [
        {
          id: 's1',
          issueKey: 'GWP-1',
          summary: 'Standup',
          weekdays: [1, 3, 5],
          startTime: '09:30',
          durationSeconds: 900,
          enabled: true,
        },
      ],
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });
    const existing = [
      worklog('w1', at(0, 9, 15), 1800, 'GWP-1'),
      worklog('w2', at(1, 14), 3600, 'GWP-3'),
    ];

    const first = engine.computePlan(input({ settings, worklogs: existing }));
    const deleted = new Set(first.deletions.map((deletion) => deletion.worklogId));
    const synced = [
      ...existing.filter((entry) => !deleted.has(entry.id)),
      ...first.creations.map(({ issueKey, started, timeSpentSeconds }, index) =>
        worklog(`new-${index}`, new Date(started), timeSpentSeconds, issueKey),
      ),
    ];

    expect(first.deletions.map((deletion) => deletion.worklogId)).toEqual(['w1']);
    const second = engine.computePlan(input({ settings, worklogs: synced }));
    expect(second).toEqual({ deletions: [], creations: [] });
  });

  it('places an allocation that fits one day as a single chunk', () => {
    const settings = defaultSettings({
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 10 }],
    });

    const plan = engine.computePlan(input({ settings }));

    expect(plan.creations).toEqual([
      { issueKey: 'GWP-9', started: at(0, 9).toISOString(), timeSpentSeconds: 13500, comment: 'Allocation', source: 'allocated' },
    ]);
  });
});
