// plan → apply → verify end to end, against the mock Jira seeded with a copy of the June–August 2026
// timesheet. Nothing here calls a real Jira.
import type * as http from 'node:http';
import { readFileSync } from 'node:fs';
import mockServer from '../../../mock-jira-server';
import { applyPlan, type ApplyDeps, type ApplyLogEntry, type ApplyResult } from './apply';
import { parseCorrections, type CorrectionsSpec } from './corrections-file';
import { JiraRestClient } from './jira-rest-client';
import { buildPlan } from './planner';
import { addDaysToKey, dayWindow } from './time-zone';
import type { LockedIssues, OwnWorklog, Plan } from './types';
import { verifyPlan } from './verify';

const { startServer, stopServer, resetMockJira, lockIssue, unlockAll, writes } = mockServer;
const TOKEN = 'mock-api-token-1234';
const H = 3600;
const MT52_LOCKED: LockedIssues = { 'OPS-9': { reason: 'Locked', source: 'corrections file' } };

describe('corrections against the mock Jira', () => {
  let server: http.Server;
  let host: string;
  let client: JiraRestClient;
  let spec: CorrectionsSpec;

  beforeAll(async () => {
    server = await startServer(0);
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('mock server has no address');
    }
    host = `http://localhost:${address.port}`;
    spec = parseCorrections(JSON.parse(readFileSync('corrections/example.json', 'utf8')));
  });

  afterAll(async () => {
    await stopServer(server);
  });

  beforeEach(() => {
    resetMockJira('corrections-example');
    client = new JiraRestClient({ baseUrl: host, email: 'dev@example.com', apiToken: TOKEN });
  });

  async function worklogsBetween(from: string, to: string): Promise<OwnWorklog[]> {
    const me = await client.myself();
    const { worklogs } = await client.ownWorklogs(
      me.accountId,
      me.timeZone,
      {
        startMs: dayWindow(from, me.timeZone).start,
        endMs: dayWindow(to, me.timeZone).end,
        fromDate: addDaysToKey(from, -1),
        toDate: addDaysToKey(to, 1),
      },
      ['LEAVE-1', 'APP-380'],
    );
    return worklogs;
  }

  async function makePlan(lockedIssues: LockedIssues = MT52_LOCKED): Promise<Plan> {
    const me = await client.myself();
    return buildPlan(spec, await worklogsBetween('2026-06-08', '2026-08-05'), {
      accountId: me.accountId,
      timeZone: me.timeZone,
      site: host,
      lockedIssues,
    });
  }

  function deps(overrides: Partial<ApplyDeps> = {}) {
    const log: ApplyLogEntry[] = [];
    const locked: [string, string][] = [];
    const backups: unknown[] = [];
    const writesAtStart = writes().length;
    const value: ApplyDeps = {
      client,
      backup: async (snapshot) => {
        // The backup is taken before any write.
        expect(writes()).toHaveLength(writesAtStart);
        backups.push(snapshot);
        return 'backup.json';
      },
      log: (entry) => log.push(entry),
      lockedIssue: (key, reason) => locked.push([key, reason]),
      ...overrides,
    };
    return { value, log, locked, backups };
  }

  function apply(plan: Plan, run = deps()): Promise<ApplyResult> {
    return applyPlan(plan, run.value, { approvedPlanId: plan.planId, allowDeletions: true });
  }

  /** Hours per issue on a day, now, plus the day's total. */
  async function day(date: string): Promise<Record<string, number>> {
    const totals: Record<string, number> = { total: 0 };
    for (const worklog of (await worklogsBetween(date, date)).filter((w) => w.date === date)) {
      totals[worklog.issueKey] = (totals[worklog.issueKey] ?? 0) + worklog.seconds / H;
      totals['total'] += worklog.seconds / H;
    }
    return totals;
  }

  async function verifyNow(plan: Plan, notMade: Map<string, string> = new Map()) {
    const dates = plan.days.map((item) => item.date).sort();
    return verifyPlan(plan, await worklogsBetween(dates[0], dates[dates.length - 1]), notMade);
  }

  const notMadeOf = (result: ApplyResult) =>
    new Map(result.failures.map((failure) => [failure.opId, failure.reason]));

  it('plans every row of the table as ready, in the profile time zone', async () => {
    const plan = await makePlan();
    expect(plan.timeZone).toBe('Europe/London');
    expect(plan.days.filter((d) => d.status === 'blocked').map((d) => d.problems)).toEqual([]);
    expect(plan.days.filter((d) => d.status === 'ready').map((d) => d.date)).toEqual(
      spec.days.map((d) => d.date),
    );
    expect(plan.days.flatMap((d) => d.warnings)).toEqual([]);
    expect(plan.checks.every((check) => check.ok)).toBe(true);
    // 22 Jun is reported, not changed.
    const aug17 = plan.days.find((d) => d.date === '2026-06-22');
    expect(aug17).toMatchObject({ status: 'unchanged', ops: [] });
    expect(aug17?.before.totalSeconds).toBe(8.25 * H);
    const ops = plan.days.flatMap((d) => d.ops);
    expect(ops.some((op) => op.issueKey === 'OPS-9')).toBe(false);
    expect(ops.some((op) => op.kind !== 'create' && /annual/i.test(op.before.comment))).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('needs the plan id, and separate approval for deletions', async () => {
    const plan = await makePlan();
    const { value } = deps();
    const wrongId = await applyPlan(plan, value, { approvedPlanId: 'nope', allowDeletions: true });
    expect(wrongId.status).toBe('refused');
    const noDeletes = await applyPlan(plan, value, {
      approvedPlanId: plan.planId,
      allowDeletions: false,
    });
    expect(noDeletes.status).toBe('refused');
    expect(noDeletes.message).toContain('--allow-deletions');
    expect(writes()).toEqual([]);
  });

  it('makes exactly the changes in the table, verifies, and changes nothing when run again', async () => {
    const plan = await makePlan();
    const run = deps();
    const result = await apply(plan, run);
    expect(result.failures).toEqual([]);
    expect(result.status).toBe('done');
    expect(run.backups).toHaveLength(1);

    for (const write of writes()) {
      expect(write.query['adjustEstimate']).toBe('leave');
      expect(write.query['notifyUsers']).toBe('false');
      expect(write.query['overrideEditableFlag']).toBeUndefined();
      expect(write.issueKey).not.toBe('OPS-9');
    }

    // Each row of the table, as it now stands in Jira.
    const expected: Record<string, Record<string, number>> = {
      '2026-06-10': { 'LEAVE-1': 3.5, 'APP-110': 0 },
      '2026-07-10': { 'APP-293': 2 },
      '2026-07-15': { 'APP-293': 1.75 },
      '2026-07-16': { 'APP-293': 0.5 },
      '2026-07-17': { 'APP-293': 1.5 },
      '2026-07-20': { 'LEAVE-1': 4.75, 'APP-176': 0 },
      '2026-07-22': { 'LEAVE-1': 5.25, 'APP-176': 0 },
      '2026-07-23': { 'LEAVE-1': 4, 'APP-176': 0 },
      '2026-07-24': { 'APP-241': 1.5 },
      '2026-07-29': { 'LEAVE-1': 3.75, 'APP-395': 0.5 },
      '2026-07-30': { 'LEAVE-1': 3.75, 'APP-395': 0 },
      '2026-07-31': { 'LEAVE-1': 3.75, 'APP-395': 0.75 },
      '2026-08-04': { 'APP-241': 0, 'APP-380': 5.25 },
      '2026-08-05': { 'APP-241': 1.5, 'APP-380': 5.75 },
    };
    for (const [date, issues] of Object.entries(expected)) {
      const now = await day(date);
      for (const [issue, hours] of Object.entries(issues)) {
        expect(`${date} ${issue} ${now[issue] ?? 0}`).toBe(`${date} ${issue} ${hours}`);
      }
      expect(`${date} total ${now['total']}`).toBe(`${date} total 7.5`);
    }
    // Days the table doesn't list are untouched.
    expect(await day('2026-06-12')).toMatchObject({ 'LEAVE-1': 3.5, total: 7.5 });
    expect(await day('2026-06-22')).toMatchObject({ 'OPS-9': 0.75, total: 8.25 });

    const verified = await verifyNow(plan);
    expect(verified.days.filter((d) => d.status !== 'ok')).toEqual([]);
    expect(verified.totals).toEqual([
      {
        label: 'Sick leave on the days changed',
        ok: true,
        seconds: 28.75 * H,
        expectedSeconds: 28.75 * H,
      },
    ]);
    expect(verified.ok).toBe(true);

    const writesBefore = writes().length;
    const again = await apply(plan);
    expect(again.status).toBe('done');
    expect(again.outcomes.every((item) => item.outcome === 'already-applied')).toBe(true);
    expect(writes()).toHaveLength(writesBefore);

    // Planning again finds nothing left to do.
    const replanned = await makePlan();
    expect(replanned.days.flatMap((d) => d.ops)).toEqual([]);
    expect(replanned.days.filter((d) => d.status === 'blocked')).toEqual([]);
  });

  it('keeps edited worklogs on their start time, including one at midnight BST', async () => {
    await apply(await makePlan());
    const sick = (await worklogsBetween('2026-07-22', '2026-07-22')).find(
      (w) => w.issueKey === 'LEAVE-1',
    );
    expect(sick).toMatchObject({
      date: '2026-07-22',
      started: '2026-07-22T00:00:00.000+0100',
      seconds: 5.25 * H,
      comment: 'Sick leave',
    });
  });

  it('still adds the sick leave when a ticket refuses to be deleted, and logs what was not deleted', async () => {
    const plan = await makePlan();
    // A closed timesheet period: nothing shows it until a write is refused.
    lockIssue('APP-176', 'period');
    const run = deps();
    const result = await apply(plan, run);

    expect(result.status).toBe('partial');
    expect(result.failures.map((f) => `${f.date} ${f.kind} ${f.action}`)).toEqual([
      expect.stringMatching(/^2026-07-20 refused delete APP-176 worklog \d+ \(1\.5h\)$/),
      expect.stringMatching(/^2026-07-22 refused delete APP-176 worklog \d+ \(2h\)$/),
      expect.stringMatching(/^2026-07-23 refused delete APP-176 worklog \d+ \(0\.5h\)$/),
    ]);
    expect(result.failures[0].reason).toContain('timesheet period is closed');
    // Sick leave went in anyway, so those days are over 7.5h.
    expect(await day('2026-07-20')).toMatchObject({ 'LEAVE-1': 4.75, 'APP-176': 1.5, total: 9 });
    expect(await day('2026-07-22')).toMatchObject({ 'LEAVE-1': 5.25, 'APP-176': 2, total: 9.5 });
    expect(await day('2026-07-23')).toMatchObject({ 'LEAVE-1': 4, 'APP-176': 0.5, total: 8 });
    // Everything else in the table was still done.
    expect(await day('2026-07-31')).toMatchObject({ 'LEAVE-1': 3.75, 'APP-395': 0.75, total: 7.5 });
    expect(run.locked.map(([key]) => key)).toContain('APP-176');
    expect(run.log.filter((entry) => entry.outcome === 'refused')).toHaveLength(3);
    expect(JSON.stringify([result, run.log])).not.toContain(TOKEN);

    // Verify accounts for exactly those three, and nothing else.
    const verified = await verifyNow(plan, notMadeOf(result));
    expect(verified.ok).toBe(true);
    expect(verified.days.filter((d) => d.status === 'not-made').map((d) => d.date)).toEqual([
      '2026-07-20',
      '2026-07-22',
      '2026-07-23',
    ]);
    // Without the log, the same state is a failure.
    expect((await verifyNow(plan)).ok).toBe(false);

    // Once the ticket is unlocked, running apply again finishes the job.
    unlockAll();
    const again = await apply(plan);
    expect(again.status).toBe('done');
    expect(await day('2026-07-20')).toMatchObject({ 'LEAVE-1': 4.75, total: 7.5 });
    expect((await verifyNow(plan)).ok).toBe(true);
  });

  it('never loses time on a move: the new worklog is made first, the old one only shortened after', async () => {
    const plan = await makePlan();
    lockIssue('APP-380', 'period');
    const result = await apply(plan);
    expect(result.status).toBe('partial');
    expect(result.failures.map((f) => `${f.date} ${f.kind}`)).toEqual([
      '2026-08-04 refused',
      '2026-08-04 refused',
      '2026-08-04 skipped',
      '2026-08-04 skipped',
      '2026-08-05 refused',
      '2026-08-05 skipped',
    ]);
    expect(await day('2026-08-04')).toMatchObject({ 'APP-241': 5.25, total: 7.5 });
    expect(await day('2026-08-05')).toMatchObject({
      'APP-241': 4.25,
      'APP-380': 3,
      total: 7.5,
    });
  });

  it('when the source of a move refuses, keeps the moved time and logs the over-full day', async () => {
    const plan = await makePlan();
    lockIssue('APP-241', 'period');
    const result = await apply(plan);
    expect(result.failures.map((f) => `${f.date} ${f.kind}`)).toEqual([
      '2026-07-24 refused',
      '2026-08-04 refused',
      '2026-08-04 refused',
      '2026-08-05 refused',
    ]);
    expect(await day('2026-08-04')).toMatchObject({
      'APP-241': 5.25,
      'APP-380': 5.25,
      total: 12.75,
    });
    expect(result.days.find((d) => d.date === '2026-08-04')).toEqual({
      date: '2026-08-04',
      totalSeconds: 12.75 * H,
      plannedSeconds: 7.5 * H,
    });
  });

  it('records a worklog changed since the plan, and still adds the sick leave', async () => {
    const plan = await makePlan();
    const target = plan.days
      .find((d) => d.date === '2026-07-30')
      ?.ops.find((op) => op.kind === 'delete');
    if (target === undefined || target.kind !== 'delete') {
      throw new Error('expected a deletion on 30 Jul');
    }
    await client.updateWorklog(target.issueKey, target.worklogId, { seconds: 3 * H });
    const result = await apply(plan);
    expect(result.failures).toEqual([
      expect.objectContaining({
        date: '2026-07-30',
        kind: 'conflict',
        worklogId: target.worklogId,
      }),
    ]);
    expect(await day('2026-07-30')).toMatchObject({
      'LEAVE-1': 3.75,
      'APP-395': 3,
      'APP-380': 3.75,
      total: 10.5,
    });
  });

  it("doesn't add a second sick-leave worklog if one appeared since the plan", async () => {
    const plan = await makePlan();
    await client.addWorklog('LEAVE-1', {
      started: '2026-07-29T13:45:00.000+0100',
      seconds: 3.75 * H,
      comment: 'Sick leave (added by hand)',
      properties: [],
    });
    const result = await apply(plan);
    expect(result.failures).toEqual([
      expect.objectContaining({ date: '2026-07-29', kind: 'conflict', issueKey: 'LEAVE-1' }),
    ]);
    expect(await day('2026-07-29')).toMatchObject({ 'LEAVE-1': 3.75 });
  });

  it('stops only on failures that are not about one change, and picks up where it left off', async () => {
    const plan = await makePlan();
    let writesUntilFailure = 3;
    const flaky = new JiraRestClient({
      baseUrl: host,
      email: 'dev@example.com',
      apiToken: TOKEN,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method !== undefined && init.method !== 'GET' && --writesUntilFailure === 0) {
          return new Response('{"errorMessages":["Service unavailable"]}', { status: 503 });
        }
        return fetch(input, init);
      }) as typeof fetch,
    });
    const stopped = await apply(plan, deps({ client: flaky }));
    expect(stopped.status).toBe('stopped');
    expect(stopped.message).toContain('503');
    const resumed = await apply(plan);
    expect(resumed.status).toBe('done');
    expect((await verifyNow(plan)).ok).toBe(true);
  });

  it('flags a ticket in a non-editable status before anything is applied', async () => {
    lockIssue('APP-176', 'status');
    expect(await client.editableFieldCount('APP-176')).toBe(0);
    expect(await client.editableFieldCount('APP-293')).toBeGreaterThan(0);
  });
});
