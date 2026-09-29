import { TimesheetEngineService } from './timesheet-engine.service';
import type {
  EngineInput,
  ExecutionPlan,
  JiraWorklog,
  UserSettings,
  WorklogCreation,
} from '../models/domain';

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
    lunchMinutes: 60,
    workDays: [1, 2, 3, 4, 5],
    allocations: [],
    schedules: [],
    spreadPrefixes: [],
    weekAllocations: {},
    leaveIssueKey: '',
    placeholderIssueKey: '',
    githubOrgs: [],
    ...overrides,
  };
}

function worklog(id: string, started: Date, timeSpentSeconds: number, issueKey = 'GWP-2070'): JiraWorklog {
  return { id, issueKey, started, timeSpentSeconds, generated: false };
}

/** A worklog this app created. */
function ours(id: string, started: Date, timeSpentSeconds: number, issueKey: string): JiraWorklog {
  return { ...worklog(id, started, timeSpentSeconds, issueKey), generated: true };
}

let synced = 0;

/** The week's worklogs once `plan` has been synced. */
function applied(worklogs: JiraWorklog[], plan: ExecutionPlan): JiraWorklog[] {
  const deleted = new Set(plan.deletions.map((deletion) => deletion.worklogId));
  return [
    ...worklogs.filter((entry) => !deleted.has(entry.id)),
    ...plan.creations.map((creation) =>
      ours(`new-${synced++}`, new Date(creation.started), creation.timeSpentSeconds, creation.issueKey),
    ),
  ];
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

/** Each weekday's lunch hour, 12:45–13:45 for 7.5 hours from 09:00. */
function lunches(): Span[] {
  return [0, 1, 2, 3, 4].map((day) => ({ start: at(day, 12, 45).getTime(), end: at(day, 13, 45).getTime() }));
}

function seconds(creations: WorklogCreation[], issueKey: string): number {
  return creations
    .filter((creation) => creation.issueKey === issueKey)
    .reduce((sum, creation) => sum + creation.timeSpentSeconds, 0);
}

/** Whether the creation starts in the morning or the afternoon of day `day` (0 = Monday). */
function inHalf(creation: WorklogCreation, day: number, half: 'morning' | 'afternoon'): boolean {
  const start = new Date(creation.started);
  return half === 'morning'
    ? start >= at(day, 0) && start < at(day, 12, 45)
    : start >= at(day, 13, 45) && start < at(day + 1, 0);
}

function expectNoOverlapWithOccupied(creations: WorklogCreation[], occupied: Span[], label: string): void {
  expectNoOverlaps([...toSpans(creations), ...occupied], label);
}

describe('TimesheetEngineService', () => {
  const engine = new TimesheetEngineService();

  it('returns an empty plan for empty input', () => {
    expect(engine.computePlan(input())).toEqual({ deletions: [], creations: [], absorb: [] });
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

  it('spreads a 75% allocation over every morning and afternoon, around what is booked', () => {
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
    // 130 free blocks: 75% is 97.5, rounded down to 97.
    expect(seconds(plan.creations, 'GWP-9')).toBe(87300);
    expect(allocationCreations[0].started).toBe(at(0, 12).toISOString());
    for (const day of [0, 1, 2, 3, 4]) {
      for (const half of ['morning', 'afternoon'] as const) {
        expect(allocationCreations.some((creation) => inHalf(creation, day, half)), `day ${day} ${half}`).toBe(true);
      }
    }
    expectNoOverlapWithOccupied(
      plan.creations,
      [{ start: at(0, 9).getTime(), end: at(0, 12).getTime() }, ...lunches()],
      '75% allocation',
    );
  });

  it('fills each working day either side of an hour for lunch in the middle', () => {
    const settings = defaultSettings({
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });

    const plan = engine.computePlan(input({ settings }));

    // 7.5 hours from 09:00, with lunch after the first half: 09:00–12:45 and 13:45–17:30.
    expect(plan.creations).toEqual(
      [0, 1, 2, 3, 4].flatMap((day) => [
        { issueKey: 'GWP-9', started: at(day, 9).toISOString(), timeSpentSeconds: 13500, comment: 'Allocation', source: 'allocated' },
        { issueKey: 'GWP-9', started: at(day, 13, 45).toISOString(), timeSpentSeconds: 13500, comment: 'Allocation', source: 'allocated' },
      ]),
    );
    expectNoOverlaps(toSpans(plan.creations), '100% allocation');
  });

  it('moves lunch with the working hours, and leaves it out when there is none', () => {
    const allocations = [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }];
    const times = (settings: UserSettings) =>
      engine
        .computePlan(input({ settings }))
        .creations.map((creation) => [creation.started, creation.timeSpentSeconds]);

    expect(
      times(defaultSettings({ workDays: [1], startTime: '08:00', hoursPerDay: 8, lunchMinutes: 30, allocations })),
    ).toEqual([
      [at(0, 8).toISOString(), 4 * 3600],
      [at(0, 12, 30).toISOString(), 4 * 3600],
    ]);
    expect(times(defaultSettings({ workDays: [1], lunchMinutes: 0, allocations }))).toEqual([
      [at(0, 9).toISOString(), 27000],
    ]);
  });

  it('counts a meeting over lunch toward its day, which still adds up to its hours', () => {
    const settings = defaultSettings({
      workDays: [1],
      schedules: [
        { id: 's1', issueKey: 'GWP-1', summary: 'Lunch and learn', weekdays: [1], startTime: '12:30', durationSeconds: 3600, enabled: true },
      ],
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });

    const plan = engine.computePlan(input({ settings }));

    expect(plan.creations.map((creation) => [creation.issueKey, creation.started, creation.timeSpentSeconds])).toEqual([
      ['GWP-9', at(0, 9).toISOString(), 3.5 * 3600],
      ['GWP-1', at(0, 12, 30).toISOString(), 3600],
      ['GWP-9', at(0, 13, 45).toISOString(), 3 * 3600],
    ]);
  });

  it('fills nothing on a day taken up by time logged by hand, even where it runs past lunch', () => {
    const settings = defaultSettings({
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });

    // A day's worth from 09:00 ends at 16:30, an hour before the working day does.
    const plan = engine.computePlan(input({ settings, worklogs: [worklog('w1', at(4, 9), 27000)] }));

    expect(plan.creations.filter((creation) => new Date(creation.started) >= at(4, 0))).toEqual([]);
    expect(seconds(plan.creations, 'GWP-9')).toBe(4 * 27000);
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
      timeSpentSeconds: 1800,
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

  it('logs the allocations one after another in blocks, so one task follows another', () => {
    const settings = defaultSettings({
      allocations: [
        { id: 'a1', issueKey: 'GWP-9', summary: 'First', percentage: 50 },
        { id: 'a2', issueKey: 'GWP-10', summary: 'Second', percentage: 30 },
      ],
    });

    const plan = engine.computePlan(input({ settings }));

    // The first allocation takes the first 75 blocks of the week, the second the next 45, and the
    // 20% left over is left empty at the end of each morning and afternoon.
    expect([seconds(plan.creations, 'GWP-9'), seconds(plan.creations, 'GWP-10')]).toEqual([75 * 900, 45 * 900]);
    const keys = plan.creations.map((creation) => creation.issueKey);
    expect(keys.lastIndexOf('GWP-9')).toBeLessThan(keys.indexOf('GWP-10'));
    expect(plan.creations.slice(0, 3).map((creation) => [creation.issueKey, creation.started, creation.timeSpentSeconds])).toEqual([
      ['GWP-9', at(0, 9).toISOString(), 12 * 900],
      ['GWP-9', at(0, 13, 45).toISOString(), 12 * 900],
      ['GWP-9', at(1, 9).toISOString(), 12 * 900],
    ]);
    const ends = plan.creations.map((creation) => new Date(creation.started).getTime() + creation.timeSpentSeconds * 1000);
    expect(ends.some((end) => end === at(0, 12, 45).getTime() || end === at(0, 17, 30).getTime())).toBe(false);
    expectNoOverlaps(toSpans(plan.creations), 'multiple allocations');
  });

  it('scatters allocations on the configured prefixes through the week, and logs the rest in blocks', () => {
    const settings = defaultSettings({
      spreadPrefixes: ['mt'],
      schedules: [
        { id: 's1', issueKey: 'GWP-1', summary: 'Standup', weekdays: [1, 2, 3, 4, 5], startTime: '09:30', durationSeconds: 900, enabled: true },
      ],
      allocations: [
        { id: 'a1', issueKey: 'GWP-7', summary: 'Main', percentage: 40 },
        { id: 'a2', issueKey: 'GWP-8', summary: 'Second', percentage: 30 },
        { id: 'a3', issueKey: 'MT-9', summary: 'Support', percentage: 20 },
        { id: 'a4', issueKey: 'MT-10', summary: 'Small', percentage: 10 },
      ],
    });

    const plan = engine.computePlan(input({ settings }));

    // 145 free blocks: 58, 43, 29 and 14, and the block left over goes to the largest.
    expect(['GWP-7', 'GWP-8', 'MT-9', 'MT-10'].map((key) => seconds(plan.creations, key) / 900)).toEqual([59, 43, 29, 14]);
    // The MT tickets turn up every day, 15 to 30 minutes at a time (case doesn't matter).
    for (const key of ['MT-9', 'MT-10']) {
      const scattered = plan.creations.filter((creation) => creation.issueKey === key);
      expect(scattered.every((creation) => creation.timeSpentSeconds <= 1800), key).toBe(true);
      for (const day of [0, 1, 2, 3, 4]) {
        expect(scattered.some((creation) => inHalf(creation, day, 'morning') || inHalf(creation, day, 'afternoon')), `${key} day ${day}`).toBe(true);
      }
    }
    // The others are logged one after the other, GWP-7 first, around the scattered ones.
    const keys = plan.creations.filter((creation) => creation.source === 'allocated').map((creation) => creation.issueKey);
    expect(keys.lastIndexOf('GWP-7')).toBeLessThan(keys.indexOf('GWP-8'));
    expectNoOverlapWithOccupied(plan.creations, lunches(), 'scattered allocations');

    // The scattering is the same every time the week is planned, so syncing twice changes nothing,
    // but differs from week to week.
    expect(engine.computePlan(input({ settings }))).toEqual(plan);
    const synced = applied([], plan);
    expect(engine.computePlan(input({ settings, worklogs: synced }))).toEqual({ deletions: [], creations: [], absorb: [] });
    const nextWeek = engine.computePlan(input({ settings, weekStart: new Date(2026, 9, 5) }));
    const starts = (creations: WorklogCreation[]) =>
      creations.filter((creation) => creation.issueKey === 'MT-10').map((creation) => new Date(creation.started).getDay() * 24 + new Date(creation.started).getHours());
    expect(starts(nextWeek.creations)).not.toEqual(starts(plan.creations));
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

    expect(engine.computePlan(input({ settings }))).toEqual({ deletions: [], creations: [], absorb: [] });
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
    expect(second).toEqual({ deletions: [], creations: [], absorb: [] });
  });

  it('fills every free block: blocks left over by rounding go to the largest allocation', () => {
    const settings = defaultSettings({
      schedules: [
        { id: 's1', issueKey: 'GWP-1', summary: 'Standup', weekdays: [1, 2, 3, 4, 5], startTime: '09:30', durationSeconds: 900, enabled: true },
      ],
      allocations: [
        { id: 'a1', issueKey: 'GWP-7', summary: 'Rate limiting', percentage: 28 },
        { id: 'a2', issueKey: 'GWP-8', summary: 'SSO login', percentage: 49 },
        { id: 'a3', issueKey: 'GWP-9', summary: 'General', percentage: 23 },
      ],
    });

    const plan = engine.computePlan(input({ settings }));

    // 145 free blocks: 40.6, 71.05 and 33.35 round down to 40, 71 and 33, and the one left over
    // goes to the 49% allocation.
    const blocks = (issueKey: string) =>
      plan.creations
        .filter((creation) => creation.issueKey === issueKey)
        .reduce((sum, creation) => sum + creation.timeSpentSeconds, 0) / 900;
    expect([blocks('GWP-7'), blocks('GWP-8'), blocks('GWP-9')]).toEqual([40, 72, 33]);
    const last = plan.creations[plan.creations.length - 1];
    expect(new Date(new Date(last.started).getTime() + last.timeSpentSeconds * 1000)).toEqual(at(4, 17, 30));
    expectNoOverlaps(toSpans(plan.creations), 'leftover blocks');
  });

  it('gives leftover blocks to the first of equally large allocations, and leaves unallocated time empty', () => {
    const settings = defaultSettings({
      workDays: [1],
      allocations: [
        { id: 'a1', issueKey: 'GWP-7', summary: 'First', percentage: 45 },
        { id: 'a2', issueKey: 'GWP-8', summary: 'Second', percentage: 45 },
      ],
    });

    const plan = engine.computePlan(input({ settings }));

    // 30 blocks: 13.5 and 13.5 round down to 13 each; 90% of 30 is 27, so one block is left over.
    expect([seconds(plan.creations, 'GWP-7') / 900, seconds(plan.creations, 'GWP-8') / 900]).toEqual([14, 13]);
    // The other three blocks are left empty at the ends of the morning and the afternoon.
    const ends = plan.creations.map((creation) => new Date(creation.started).getTime() + creation.timeSpentSeconds * 1000);
    expect(ends.some((end) => end === at(0, 12, 45).getTime() || end === at(0, 17, 30).getTime())).toBe(false);
  });

  it('spreads a 10% allocation on its own through the week rather than logging it in one go', () => {
    const settings = defaultSettings({
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 10 }],
    });

    const plan = engine.computePlan(input({ settings }));

    // 15 blocks a week: 30 minutes each morning and 15 each afternoon.
    expect(plan.creations).toEqual(
      [0, 1, 2, 3, 4].flatMap((day) => [
        { issueKey: 'GWP-9', started: at(day, 9).toISOString(), timeSpentSeconds: 1800, comment: 'Allocation', source: 'allocated' },
        { issueKey: 'GWP-9', started: at(day, 13, 45).toISOString(), timeSpentSeconds: 900, comment: 'Allocation', source: 'allocated' },
      ]),
    );
  });

  it('shares the week in proportion when the allocations add up to more than 100%', () => {
    const settings = defaultSettings({
      workDays: [1],
      allocations: [
        { id: 'a1', issueKey: 'GWP-7', summary: 'First', percentage: 100 },
        { id: 'a2', issueKey: 'GWP-8', summary: 'Added', percentage: 50 },
      ],
    });

    const plan = engine.computePlan(input({ settings }));

    // 30 blocks shared 100:50, so the allocation added last still gets its third of the day.
    expect(plan.creations.map((creation) => [creation.issueKey, creation.timeSpentSeconds / 900])).toEqual([
      ['GWP-7', 15],
      ['GWP-7', 5],
      ['GWP-8', 10],
    ]);
  });

  it('keeps only the longest of overlapping recurring events, and frees the rest of the day', () => {
    const settings = defaultSettings({
      schedules: [
        { id: 's1', issueKey: 'GWP-1', summary: 'Standup', weekdays: [1, 2, 3, 4, 5], startTime: '09:30', durationSeconds: 900, enabled: true },
        { id: 's2', issueKey: 'GWP-2', summary: 'Planning', weekdays: [1], startTime: '09:00', durationSeconds: 7200, enabled: true },
      ],
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });

    const plan = engine.computePlan(input({ settings }));

    const recurring = plan.creations.filter((creation) => creation.source === 'recurring');
    expect(recurring.filter((creation) => new Date(creation.started) < at(1, 0))).toEqual([
      { issueKey: 'GWP-2', started: at(0, 9).toISOString(), timeSpentSeconds: 7200, comment: 'Planning', source: 'recurring' },
    ]);
    expect(seconds(plan.creations, 'GWP-1')).toBe(4 * 900);
    // Monday's standup is neither logged nor counted: the allocation fills the rest of the day.
    expect(seconds(plan.creations, 'GWP-9')).toBe(5 * 27000 - 7200 - 4 * 900);
    expect(plan.creations.find((creation) => creation.issueKey === 'GWP-9')?.started).toBe(at(0, 11).toISOString());
    expectNoOverlaps(toSpans(plan.creations), 'overlapping schedules');
  });

  it('keeps the later of two equally long overlapping recurring events', () => {
    const settings = defaultSettings({
      workDays: [1],
      schedules: [
        { id: 's1', issueKey: 'GWP-1', summary: 'Older', weekdays: [1], startTime: '10:00', durationSeconds: 3600, enabled: true },
        { id: 's2', issueKey: 'GWP-2', summary: 'Newer', weekdays: [1], startTime: '10:30', durationSeconds: 3600, enabled: true },
      ],
    });

    expect(engine.computePlan(input({ settings })).creations).toEqual([
      { issueKey: 'GWP-2', started: at(0, 10, 30).toISOString(), timeSpentSeconds: 3600, comment: 'Newer', source: 'recurring' },
    ]);
  });

  it('logs a fortnightly schedule every other week from its anchor week', () => {
    const schedule = { id: 's1', issueKey: 'GWP-1', summary: 'Sprint review', weekdays: [3], startTime: '14:00', durationSeconds: 3600, enabled: true };
    const weeks = (anchorWeek: string) =>
      [new Date(2026, 8, 28), new Date(2026, 9, 5), new Date(2026, 9, 12)].map(
        (weekStart) =>
          engine.computePlan(
            input({ weekStart, settings: defaultSettings({ schedules: [{ ...schedule, repeat: 'fortnightly', anchorWeek }] }) }),
          ).creations.length,
      );

    expect(weeks('2026-09-28')).toEqual([1, 0, 1]);
    expect(weeks('2026-09-14')).toEqual([1, 0, 1]);
    // Any date in the anchor week will do.
    expect(weeks('2026-10-08')).toEqual([0, 1, 0]);
    // Without a usable anchor, the schedule happens every week.
    expect(weeks('not a date')).toEqual([1, 1, 1]);
  });

  it('logs a monthly schedule on the given weekday of the month', () => {
    const schedule = { id: 's1', issueKey: 'GWP-1', summary: 'All hands', weekdays: [2], startTime: '11:00', durationSeconds: 3600, enabled: true };
    const weeks = (weekOfMonth: number) =>
      [new Date(2026, 8, 21), new Date(2026, 8, 28), new Date(2026, 9, 5)].map(
        (weekStart) =>
          engine.computePlan(
            input({ weekStart, settings: defaultSettings({ schedules: [{ ...schedule, repeat: 'monthly', weekOfMonth }] }) }),
          ).creations.map((creation) => creation.started),
      );

    // September 2026's Tuesdays are the 1st, 8th, 15th, 22nd and 29th; October's start on the 6th.
    expect(weeks(1)).toEqual([[], [], [new Date(2026, 9, 6, 11).toISOString()]]);
    expect(weeks(4)).toEqual([[new Date(2026, 8, 22, 11).toISOString()], [], []]);
    expect(weeks(-1)).toEqual([[], [new Date(2026, 8, 29, 11).toISOString()], []]);
  });

  it("re-plans its own worklogs when the allocations change after a sync, and keeps everyone else's", () => {
    const settings = defaultSettings({
      allocations: [{ id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 100 }],
    });
    const byHand = worklog('hand', at(1, 14), 3600, 'GWP-3');
    const synced = applied([byHand], engine.computePlan(input({ settings, worklogs: [byHand] })));
    expect(engine.computePlan(input({ settings, worklogs: synced }))).toEqual({ deletions: [], creations: [], absorb: [] });

    const changed = defaultSettings({
      allocations: [
        { id: 'a1', issueKey: 'GWP-9', summary: 'Allocation', percentage: 50 },
        { id: 'a2', issueKey: 'GWP-10', summary: 'New project', percentage: 50 },
      ],
    });
    const replan = engine.computePlan(input({ settings: changed, worklogs: synced }));

    // GWP-10 now takes its part of every morning and afternoon, so GWP-9's worklogs are re-planned.
    expect(replan.deletions.length).toBeGreaterThan(0);
    expect(new Set(replan.deletions.map((deletion) => deletion.reason))).toEqual(new Set(['stale-generated']));
    expect(replan.absorb).toEqual([]);
    const after = applied(synced, replan);
    const total = (issueKey: string) =>
      after.filter((entry) => entry.issueKey === issueKey).reduce((sum, entry) => sum + entry.timeSpentSeconds, 0);
    expect(after).toContainEqual(byHand);
    expect([total('GWP-9'), total('GWP-10')]).toEqual([73 * 900, 73 * 900]);
    expect(engine.computePlan(input({ settings: changed, worklogs: after }))).toEqual({ deletions: [], creations: [], absorb: [] });
  });

  describe('for a week with allocations filled from activity', () => {
    const weekAllocations = {
      '2026-09-28': [
        { id: 'a1', issueKey: 'GWP-7', summary: 'Rate limiting', percentage: 60 },
        { id: 'a2', issueKey: 'GWP-8', summary: 'SSO login', percentage: 40 },
      ],
    };
    const usual = [{ id: 'u', issueKey: 'GWP-9', summary: 'Usual', percentage: 100 }];

    it("uses the week's own allocations, and only for that week", () => {
      const settings = defaultSettings({ allocations: usual, weekAllocations });
      const thisWeek = engine.computePlan(input({ settings }));
      const nextWeek = engine.computePlan(input({ settings, weekStart: new Date(2026, 9, 5) }));

      const total = (issueKey: string) =>
        thisWeek.creations
          .filter((creation) => creation.issueKey === issueKey)
          .reduce((sum, creation) => sum + creation.timeSpentSeconds, 0);
      expect(total('GWP-7')).toBe(0.6 * 135000);
      expect(total('GWP-8')).toBe(0.4 * 135000);
      expect(total('GWP-9')).toBe(0);
      expect(new Set(nextWeek.creations.map((creation) => creation.issueKey))).toEqual(new Set(['GWP-9']));
    });

    it("replaces the automatic worklogs and keeps leave and recorded meetings", () => {
      const settings = defaultSettings({
        weekAllocations: { '2026-09-28': [{ id: 'a', issueKey: 'GWP-7', summary: 'All', percentage: 100 }] },
        leaveIssueKey: 'HR-1',
        schedules: [
          { id: 's', issueKey: 'GWP-1', summary: 'Standup', weekdays: [2], startTime: '09:30', durationSeconds: 900, enabled: true },
        ],
      });
      const automatic = worklog('auto', at(0, 15), 900, 'GWP-5');
      const plan = engine.computePlan(
        input({
          settings,
          worklogs: [
            automatic,
            worklog('leave', at(4, 9), 27000, 'HR-1'),
            worklog('standup', at(1, 9, 30), 900, 'GWP-1'),
          ],
        }),
      );

      expect(plan.deletions).toEqual([
        { worklogId: 'auto', issueKey: 'GWP-5', reason: 'replaced-by-activity' },
      ]);
      expect(plan.absorb).toEqual([automatic]);
      const allocated = plan.creations.reduce((sum, creation) => sum + creation.timeSpentSeconds, 0);
      // The whole week but Friday's leave and Tuesday's standup.
      expect(allocated).toBe(4 * 27000 - 900);
    });

    it('fills the whole week around meetings and leave, with no time lost to rounding', () => {
      const settings = defaultSettings({
        weekAllocations,
        leaveIssueKey: 'HR-1',
        schedules: [
          { id: 's', issueKey: 'GWP-1', summary: 'Standup', weekdays: [1, 2, 3, 4, 5], startTime: '09:30', durationSeconds: 900, enabled: true },
        ],
      });
      const plan = engine.computePlan(
        input({ settings, worklogs: [worklog('leave', at(4, 9), 13500, 'HR-1')] }),
      );
      const logged = plan.creations.reduce((sum, creation) => sum + creation.timeSpentSeconds, 0);
      // Every working minute but Friday morning's leave: four standups, the rest allocated.
      expect(logged).toBe(4 * (27000 - 900) + 13500 + 4 * 900);
      const last = plan.creations.at(-1)!;
      expect(new Date(last.started).getTime() + last.timeSpentSeconds * 1000).toBe(at(4, 17, 30).getTime());
    });

    it('plans nothing once synced, and re-plans only its own worklogs when the allocations change', () => {
      const settings = defaultSettings({ weekAllocations });
      const worklogs = [worklog('auto', at(0, 15), 900, 'GWP-5')];
      const first = engine.computePlan(input({ settings, worklogs }));
      const synced = applied(worklogs, first);

      expect(engine.computePlan(input({ settings, worklogs: synced }))).toEqual({
        deletions: [],
        creations: [],
        absorb: [],
      });

      const changed = defaultSettings({
        weekAllocations: { '2026-09-28': [{ id: 'a', issueKey: 'GWP-7', summary: 'All', percentage: 100 }] },
      });
      const replan = engine.computePlan(input({ settings: changed, worklogs: synced }));
      expect(new Set(replan.deletions.map((deletion) => deletion.reason))).toEqual(
        new Set(['stale-generated']),
      );
      expect(replan.absorb).toEqual([]);
      const after = applied(synced, replan);
      expect(after.every((entry) => entry.issueKey === 'GWP-7')).toBe(true);
      expect(after.reduce((sum, entry) => sum + entry.timeSpentSeconds, 0)).toBe(135000);
    });
  });
});
