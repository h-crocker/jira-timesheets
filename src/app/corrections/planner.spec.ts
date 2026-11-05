import { readFileSync } from 'node:fs';
import { parseCorrections, type CorrectionsSpec } from './corrections-file';
import { buildPlan, projectWorklogs } from './planner';
import { dateKeyInZone, parseJiraDateTime } from './time-zone';
import type { LockedIssues, OwnWorklog } from './types';

const ME = 'me-account';
const ZONE = 'Europe/London';
let nextId = 1;

/** One of my worklogs at a BST wall-clock time. */
function wl(
  date: string,
  time: string,
  issueKey: string,
  hours: number,
  comment = '',
  author = ME,
): OwnWorklog {
  const started = `${date}T${time}:00.000+0100`;
  const startedMs = parseJiraDateTime(started);
  return {
    id: String(nextId++),
    issueKey,
    started,
    startedMs,
    date: dateKeyInZone(startedMs, ZONE),
    seconds: Math.round(hours * 3600),
    comment,
    authorAccountId: author,
    properties: [],
  };
}

function spec(raw: Record<string, unknown>): CorrectionsSpec {
  return parseCorrections({ timeZone: ZONE, ...raw });
}

function plan(
  corrections: CorrectionsSpec,
  worklogs: OwnWorklog[],
  lockedIssues: LockedIssues = {},
) {
  return buildPlan(corrections, worklogs, {
    accountId: ME,
    timeZone: ZONE,
    site: 'http://localhost:3000',
    lockedIssues,
    now: new Date('2026-11-05T12:00:00Z'),
  });
}

describe('corrections planner', () => {
  beforeEach(() => (nextId = 1));

  it('moves a ticket to sick leave, starting where the deleted time was', () => {
    const corrections = spec({
      days: [
        {
          date: '2026-06-10',
          set: [
            { issueKey: 'LEAVE-1', from: 0, to: 3.75, comment: 'Sick leave' },
            { issueKey: 'APP-110', from: 3.5, to: 0 },
            { issueKey: 'OPS-7', from: 4, to: 3.75 },
          ],
        },
      ],
    });
    const result = plan(corrections, [
      wl('2026-06-10', '09:00', 'OPS-7', 4, 'Release prep'),
      wl('2026-06-10', '13:45', 'APP-110', 3.5, 'Payment retries'),
    ]);
    const [day] = result.days;
    expect(day.status).toBe('ready');
    expect(day.ops.map((op) => op.kind)).toEqual(['delete', 'update', 'create']);
    const create = day.ops[2];
    expect(create).toMatchObject({
      kind: 'create',
      issueKey: 'LEAVE-1',
      started: '2026-06-10T13:45:00.000+0100',
      seconds: 13500,
      comment: 'Sick leave',
    });
    expect(day.after.totalSeconds).toBe(27000);
  });

  it('blocks a day whose hours in Jira differ from the file, and changes nothing on it', () => {
    const corrections = spec({
      days: [
        {
          date: '2026-06-12',
          set: [
            { issueKey: 'LEAVE-1', from: 3.5, to: 3.75 },
            { issueKey: 'APP-110', from: 3, to: 2.75 },
          ],
        },
      ],
    });
    const result = plan(corrections, [
      wl('2026-06-12', '09:00', 'APP-110', 3.25),
      wl('2026-06-12', '13:45', 'LEAVE-1', 3.5),
      wl('2026-06-12', '12:00', 'OPS-7', 0.75),
    ]);
    expect(result.days[0].status).toBe('blocked');
    expect(result.days[0].problems.join(' ')).toContain('Jira has 3.25h on APP-110');
    expect(result.days[0].after.totalSeconds).toBe(result.days[0].before.totalSeconds);
  });

  it('applies the table even when a day would end off 7.5h, warning about it and never padding', () => {
    const over = spec({
      days: [{ date: '2026-06-12', set: [{ issueKey: 'LEAVE-1', from: 3.5, to: 3.75 }] }],
    });
    const worklogs = [
      wl('2026-06-12', '09:00', 'GWP-1', 4),
      wl('2026-06-12', '13:45', 'LEAVE-1', 3.5),
    ];
    const overDay = plan(over, worklogs).days[0];
    expect(overDay.status).toBe('ready');
    expect(overDay.warnings.join(' ')).toContain('7.75h, over 7.5h');

    const under = spec({
      days: [{ date: '2026-06-12', set: [{ issueKey: 'GWP-1', from: 4, to: 3.5 }] }],
    });
    const day = plan(under, worklogs).days[0];
    expect(day.status).toBe('ready');
    expect(day.warnings.join(' ')).toContain('Nothing is padded');
    expect(day.ops.some((op) => op.kind === 'create')).toBe(false);
  });

  it('takes time off the latest worklogs first, deleting any it empties', () => {
    const corrections = spec({
      expectedDayHours: 7.5,
      days: [
        {
          date: '2026-06-25',
          set: [
            { issueKey: 'LEAVE-1', from: 3, to: 3.75 },
            { issueKey: 'APP-171', from: 1.5, to: 0.75 },
          ],
        },
      ],
    });
    const early = wl('2026-06-25', '09:00', 'APP-171', 0.75, 'Refund API');
    const late = wl('2026-06-25', '12:00', 'APP-171', 0.75, 'Review fixes');
    const sick = wl('2026-06-25', '13:45', 'LEAVE-1', 3, 'Sick');
    const result = plan(corrections, [early, late, sick, wl('2026-06-25', '09:45', 'GWP-2', 3)]);
    const ops = result.days[0].ops;
    expect(ops.find((op) => op.kind === 'delete')).toMatchObject({ worklogId: late.id });
    expect(ops.find((op) => op.kind === 'update')).toMatchObject({
      worklogId: sick.id,
      after: { seconds: 13500, comment: 'Sick' },
    });
    expect(ops.some((op) => op.kind !== 'create' && op.worklogId === early.id)).toBe(false);
  });

  it('leaves annual leave on the same ticket alone and out of the hours compared', () => {
    const corrections = spec({
      protect: [
        {
          issueKey: 'LEAVE-1',
          dates: ['2026-06-15'],
          commentPattern: 'annual',
          reason: 'Annual leave',
        },
      ],
      days: [
        {
          date: '2026-06-26',
          set: [
            { issueKey: 'LEAVE-1', from: 3.25, to: 3.75, comment: 'Sick leave' },
            { issueKey: 'GWP-1', from: 1.75, to: 1.25 },
          ],
        },
      ],
    });
    const annual = wl('2026-06-26', '09:00', 'LEAVE-1', 2.5, 'Annual leave (morning)');
    const sick = wl('2026-06-26', '13:45', 'LEAVE-1', 3.25, 'Sick');
    const result = plan(corrections, [annual, sick, wl('2026-06-26', '11:30', 'GWP-1', 1.75)]);
    const day = result.days[0];
    expect(day.ops.some((op) => op.kind !== 'create' && op.worklogId === annual.id)).toBe(false);
    expect(day.notes.join(' ')).toContain('protected (Annual leave)');
    // 2.5 annual + 3.75 sick + 1.25 = 7.5
    expect(day.status).toBe('ready');
  });

  it('refuses a protected date outright', () => {
    const corrections = spec({
      protect: [{ issueKey: 'LEAVE-1', dates: ['2026-06-17..2026-06-22'], reason: 'Annual leave' }],
      days: [{ date: '2026-06-18', set: [{ issueKey: 'LEAVE-1', from: 7.5, to: 3.75 }] }],
    });
    expect(
      plan(corrections, [wl('2026-06-18', '00:00', 'LEAVE-1', 7.5)]).days[0].problems.join(' '),
    ).toContain('protected');
  });

  it('warns about a ticket found locked but still plans the day, so sick leave goes in', () => {
    const corrections = spec({
      days: [
        {
          date: '2026-07-16',
          set: [
            { issueKey: 'LEAVE-1', from: 3.25, to: 3.75 },
            { issueKey: 'APP-293', from: 1.25, to: 0.75 },
          ],
        },
      ],
    });
    const result = plan(
      corrections,
      [
        wl('2026-07-16', '09:00', 'APP-293', 1.25),
        wl('2026-07-16', '13:45', 'LEAVE-1', 3.25),
        wl('2026-07-16', '10:15', 'GWP-2', 3),
      ],
      {
        'APP-293': { reason: 'timesheet period closed', source: 'refused by Jira during apply' },
      },
    );
    expect(result.days[0].status).toBe('ready');
    expect(result.days[0].warnings.join(' ')).toContain('APP-293 looks locked');
    expect(result.days[0].ops.map((op) => op.issueKey).sort()).toEqual(['APP-293', 'LEAVE-1']);
  });

  it("won't let the file change an issue it lists as locked", () => {
    expect(() =>
      spec({
        lockedIssues: ['OPS-9'],
        days: [{ date: '2026-06-22', set: [{ issueKey: 'OPS-9', from: 0.75, to: 0 }] }],
      }),
    ).toThrow(/OPS-9, which is listed as locked/);
  });

  it('moves time between tickets, keeping what the target already had', () => {
    const corrections = spec({
      days: [
        {
          date: '2026-08-05',
          move: [{ from: 'APP-241', to: 'APP-380', hours: 2.75, toBefore: 3 }],
        },
      ],
    });
    const source = wl('2026-08-05', '09:15', 'APP-241', 4.25, 'Dashboard');
    const target = wl('2026-08-05', '14:30', 'APP-380', 3, 'Alerting');
    const result = plan(corrections, [wl('2026-08-05', '09:00', 'OPS-7', 0.25), source, target]);
    const ops = result.days[0].ops;
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      kind: 'update',
      worklogId: source.id,
      after: { seconds: 5400 },
      // The source is only shortened once the new worklog exists.
      requires: [ops[1].opId],
    });
    expect(ops[1]).toMatchObject({
      kind: 'create',
      issueKey: 'APP-380',
      started: '2026-08-05T10:45:00.000+0100',
      seconds: 9900,
    });
    expect(result.days[0].after.byIssue['APP-380']).toBe(20700);

    const wrongTarget = plan(corrections, [source, wl('2026-08-05', '14:30', 'APP-380', 2)]);
    expect(wrongTarget.days[0].status).toBe('blocked');
  });

  it('rewrites only comments that just say "stand-up", and only on the given days', () => {
    const corrections = spec({
      commentRewrites: [
        { issueKey: 'OPS-7', dates: ['2026-06-09'], from: 'stand-up', to: 'General project work' },
      ],
    });
    const exact = wl('2026-06-09', '09:00', 'OPS-7', 0.25, ' Stand-up ');
    const longer = wl('2026-06-09', '16:45', 'OPS-7', 0.75, 'Stand-up follow-ups');
    const otherDay = wl('2026-06-11', '09:00', 'OPS-7', 0.25, 'stand-up');
    const theirs = wl('2026-06-09', '09:00', 'OPS-7', 0.25, 'stand-up', 'colleague');
    const result = plan(corrections, [exact, longer, otherDay, theirs]);
    const ops = result.days.flatMap((day) => day.ops);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'update',
      worklogId: exact.id,
      after: { seconds: 900, comment: 'General project work' },
    });
    expect(result.days[0].notes.join(' ')).toContain('Stand-up follow-ups');
  });

  it('never plans changes to colleagues’ worklogs', () => {
    const corrections = spec({
      days: [
        {
          date: '2026-07-30',
          set: [
            { issueKey: 'APP-395', from: 3.75, to: 0 },
            { issueKey: 'LEAVE-1', from: 0, to: 3.75 },
          ],
        },
      ],
    });
    const result = plan(corrections, [
      wl('2026-07-30', '09:00', 'APP-380', 3.75),
      wl('2026-07-30', '13:45', 'APP-395', 3.75),
      wl('2026-07-30', '10:00', 'APP-395', 2, 'Pairing', 'colleague'),
    ]);
    expect(result.days[0].status).toBe('ready');
    expect(result.days[0].before.worklogs.every((worklog) => worklog.id !== '3')).toBe(true);
  });

  it('dates worklogs by the profile zone: midnight BST belongs to that day', () => {
    const corrections = spec({
      days: [
        {
          date: '2026-06-23',
          set: [
            { issueKey: 'LEAVE-1', from: 3.25, to: 3.75 },
            { issueKey: 'GWP-1', from: 2, to: 1.5 },
          ],
        },
      ],
    });
    const midnight = wl('2026-06-23', '00:00', 'LEAVE-1', 3.25);
    expect(new Date(midnight.startedMs).toISOString().slice(0, 10)).toBe('2026-06-22');
    const result = plan(corrections, [
      midnight,
      wl('2026-06-23', '09:00', 'GWP-1', 2),
      wl('2026-06-23', '11:00', 'GWP-2', 2.25),
    ]);
    expect(result.days[0].status).toBe('ready');
    // Edits never send `started`, so the start (and day) can't shift.
    expect(result.days[0].ops.find((op) => op.issueKey === 'LEAVE-1')).toMatchObject({
      kind: 'update',
      started: midnight.started,
    });
  });

  it('gives the same plan id for the same plan, and a new one when Jira differs', () => {
    const corrections = spec({
      days: [
        {
          date: '2026-06-12',
          set: [
            { issueKey: 'GWP-1', from: 7.5, to: 7.25 },
            { issueKey: 'LEAVE-1', from: 0, to: 0.25 },
          ],
        },
      ],
    });
    nextId = 1;
    const a = plan(corrections, [wl('2026-06-12', '09:00', 'GWP-1', 7.5)]);
    nextId = 1;
    const b = plan(corrections, [wl('2026-06-12', '09:00', 'GWP-1', 7.5)]);
    nextId = 1;
    const c = plan(corrections, [wl('2026-06-12', '09:00', 'GWP-1', 7.5, 'edited')]);
    expect(a.planId).toBe(b.planId);
    expect(a.planId).not.toBe(c.planId);
  });

  it('reads the real corrections file: the 14 days of the table, 28.75h of sick leave on them', () => {
    const raw = JSON.parse(readFileSync('corrections/example.json', 'utf8'));
    const corrections = parseCorrections(raw);
    expect(corrections.days.map((day) => day.date)).toEqual([
      '2026-06-10',
      '2026-07-10',
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
      '2026-07-20',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
      '2026-08-04',
      '2026-08-05',
    ]);
    expect(corrections.commentRewrites).toEqual([]);
    const sick = corrections.days.flatMap((day) =>
      day.changes.filter((change) => change.kind === 'set' && change.issueKey === 'LEAVE-1'),
    );
    expect(
      sick.reduce((sum, change) => sum + (change.kind === 'set' ? change.toSeconds : 0), 0),
    ).toBe(28.75 * 3600);
    expect(corrections.protect[0].dates).toContain('2026-07-06');
    expect(corrections.protect[0].dates).not.toContain('2026-07-30');
    // Each day's changes keep the hours it had, or bring an over-full day down.
    for (const day of corrections.days) {
      const delta = day.changes.reduce(
        (sum, change) => sum + (change.kind === 'set' ? change.toSeconds - change.fromSeconds : 0),
        0,
      );
      expect(delta).toBeLessThanOrEqual(0);
    }
  });

  it('projects the plan onto the worklogs for validation', () => {
    const worklogs = [wl('2026-06-12', '09:00', 'GWP-1', 7.5)];
    const projected = projectWorklogs(
      worklogs,
      [
        {
          kind: 'update',
          opId: 'x',
          issueKey: 'GWP-1',
          worklogId: worklogs[0].id,
          started: worklogs[0].started,
          before: { seconds: 27000, comment: '' },
          after: { seconds: 3600, comment: 'x' },
          why: '',
        },
      ],
      ZONE,
      ME,
    );
    expect(projected[0].seconds).toBe(3600);
  });
});

describe('corrections file', () => {
  it('rejects mistakes before anything is planned', () => {
    expect(() =>
      parseCorrections({
        days: [{ date: '2026-06-10', set: [{ issueKey: 'LEAVE-1', from: 0, to: 3.7 }] }],
      }),
    ).toThrow(/quarter hours/);
    expect(() =>
      parseCorrections({
        days: [{ date: '2026-02-30', set: [{ issueKey: 'LEAVE-1', from: 0, to: 1 }] }],
      }),
    ).toThrow(/not a real date/);
    expect(() =>
      parseCorrections({
        days: [{ date: '2026-06-10', set: [{ issueKey: 'mt45', from: 0, to: 1 }] }],
      }),
    ).toThrow(/issue key/);
    expect(() =>
      parseCorrections({
        days: [
          { date: '2026-06-10', set: [{ issueKey: 'LEAVE-1', from: 0, to: 1 }] },
          { date: '2026-06-10', set: [{ issueKey: 'MT-46', from: 0, to: 1 }] },
        ],
      }),
    ).toThrow(/listed twice/);
    expect(() => parseCorrections({ timeZone: 'Mars/Olympus', days: [] })).toThrow(/time zone/);
  });
});
