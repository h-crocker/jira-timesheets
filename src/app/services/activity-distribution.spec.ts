import type {
  ActivityEvent,
  EngineInput,
  ExecutionPlan,
  JiraWorklog,
  RecurringSchedule,
  UserSettings,
  WorklogCreation,
} from '../models/domain';
import { weekEvidence } from './activity-distribution';
import { TimesheetEngineService } from './timesheet-engine.service';

const HOUR = 3600;
const FULL_DAY = 7.5 * HOUR;

function at(dayOffset: number, hours: number, minutes = 0): Date {
  return new Date(2026, 8, 28 + dayOffset, hours, minutes);
}

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    startTime: '09:00',
    hoursPerDay: 7.5,
    workDays: [1, 2, 3, 4, 5],
    allocations: [],
    schedules: [],
    activityMode: true,
    leaveIssueKey: '',
    placeholderIssueKey: '',
    githubOrgs: [],
    ...overrides,
  };
}

function worklog(
  id: string,
  issueKey: string,
  started: Date,
  timeSpentSeconds: number,
  generated = false,
): JiraWorklog {
  return { id, issueKey, started, timeSpentSeconds, generated, comment: `Worklog ${id}` };
}

function event(
  id: string,
  issueKey: string,
  when: Date,
  kind: ActivityEvent['kind'] = 'commit',
  label = `acme/api#1 Work on ${issueKey}`,
): ActivityEvent {
  return { id, issueKey, at: when, kind, label };
}

function standup(weekdays: number[], startTime = '09:30'): RecurringSchedule {
  return {
    id: 's',
    issueKey: 'GWP-1',
    summary: 'Standup',
    weekdays,
    startTime,
    durationSeconds: 900,
    enabled: true,
  };
}

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return { weekStart: at(0, 0), settings: settings(), worklogs: [], ...overrides };
}

/** [issue, local start time, minutes] for each creation on one day. */
function day(plan: ExecutionPlan, dayOffset: number): Array<[string, string, number]> {
  return plan.creations
    .filter((creation) => new Date(creation.started).getDate() === at(dayOffset, 0).getDate())
    .map((creation) => {
      const start = new Date(creation.started);
      const time = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
      return [creation.issueKey, time, creation.timeSpentSeconds / 60];
    });
}

function secondsOn(creations: WorklogCreation[], issueKey: string): number {
  return creations
    .filter((creation) => creation.issueKey === issueKey)
    .reduce((sum, creation) => sum + creation.timeSpentSeconds, 0);
}

/** What Jira holds after syncing `plan`: deletions gone, creations added and marked as ours. */
function applied(worklogs: JiraWorklog[], plan: ExecutionPlan): JiraWorklog[] {
  const deleted = new Set(plan.deletions.map((deletion) => deletion.worklogId));
  return [
    ...worklogs.filter((entry) => !deleted.has(entry.id)),
    ...plan.creations.map((creation, index) =>
      worklog(
        `new-${index}`,
        creation.issueKey,
        new Date(creation.started),
        creation.timeSpentSeconds,
        true,
      ),
    ),
  ];
}

describe('TimesheetEngineService in activity mode', () => {
  const engine = new TimesheetEngineService();

  it("fills the plan's worked example day exactly", () => {
    const plan = engine.computePlan(
      input({
        settings: settings({ workDays: [2], schedules: [standup([2])] }),
        worklogs: [worklog('auto', 'GWP-2080', at(1, 15), 60)],
        activity: [
          ...[10, 11, 12, 13].map((hour) => event(`c${hour}`, 'GWP-2070', at(1, hour))),
          event('r', 'GWP-2080', at(1, 8, 40), 'review', 'reviewed acme/web#52'),
        ],
      }),
    );

    // 29 free blocks: 29 × 4/11 ≈ 10.55 and 29 × 7/11 ≈ 18.45 round to 11 and 18.
    expect(day(plan, 1)).toEqual([
      ['GWP-2080', '09:00', 30],
      ['GWP-1', '09:30', 15],
      ['GWP-2080', '09:45', 240],
      ['GWP-2070', '13:45', 165],
    ]);
    expect(plan.deletions).toEqual([
      { worklogId: 'auto', issueKey: 'GWP-2080', reason: 'replaced-by-activity' },
    ]);
    expect(plan.absorb.map((entry) => entry.id)).toEqual(['auto']);
    expect(plan.creations.map((creation) => creation.source)).toEqual([
      'activity',
      'recurring',
      'activity',
      'activity',
    ]);
  });

  it('turns automatic worklogs into evidence and replaces them', () => {
    const worklogs = [worklog('a', 'GWP-5', at(0, 10), 900), worklog('b', 'GWP-6', at(0, 15), 900)];
    const plan = engine.computePlan(input({ worklogs }));

    expect(plan.deletions.map((deletion) => [deletion.worklogId, deletion.reason])).toEqual([
      ['a', 'replaced-by-activity'],
      ['b', 'replaced-by-activity'],
    ]);
    expect(plan.absorb).toEqual(worklogs);
    expect(day(plan, 0)).toEqual([
      ['GWP-5', '09:00', 225],
      ['GWP-6', '12:45', 225],
    ]);
    // Days without evidence share the whole week's weights.
    expect(secondsOn(plan.creations, 'GWP-5') + secondsOn(plan.creations, 'GWP-6')).toBe(
      5 * FULL_DAY,
    );
  });

  it('prefers pull request titles to automatic worklog comments in worklog comments', () => {
    const plan = engine.computePlan(
      input({
        settings: settings({ workDays: [1] }),
        worklogs: [worklog('a', 'GWP-5', at(0, 10), 900)],
        activity: [event('e', 'GWP-5', at(0, 11), 'commit', 'acme/api#9 Faster search')],
      }),
    );
    expect(plan.creations.map((creation) => creation.comment)).toEqual([
      'acme/api#9 Faster search',
    ]);
  });

  it('never counts its own worklogs as evidence, and keeps those it still wants', () => {
    const base = input({
      settings: settings({ schedules: [standup([1, 3])] }),
      worklogs: [worklog('a', 'GWP-5', at(0, 10), 900), worklog('b', 'GWP-6', at(2, 10), 900)],
      activity: [event('e', 'GWP-7', at(3, 11))],
    });
    const first = engine.computePlan(base);
    const second = engine.computePlan({
      ...base,
      worklogs: applied(base.worklogs, first),
      absorbed: first.absorb,
    });

    expect(first.creations.length).toBeGreaterThan(0);
    expect(second).toEqual({ deletions: [], creations: [], absorb: [] });
  });

  it('deletes a worklog of its own that the plan no longer wants', () => {
    const plan = engine.computePlan(
      input({
        settings: settings({ workDays: [1] }),
        worklogs: [worklog('old', 'GWP-9', at(0, 9), HOUR, true)],
        activity: [event('e', 'GWP-5', at(0, 11))],
      }),
    );
    expect(plan.deletions).toEqual([
      { worklogId: 'old', issueKey: 'GWP-9', reason: 'stale-generated' },
    ]);
    expect(plan.absorb).toEqual([]);
    expect(day(plan, 0)).toEqual([['GWP-5', '09:00', 450]]);
  });

  it('still counts worklogs replaced by earlier syncs', () => {
    const plan = engine.computePlan(input({ absorbed: [worklog('gone', 'GWP-7', at(2, 10), 60)] }));
    expect(plan.deletions).toEqual([]);
    expect(plan.absorb).toEqual([]);
    expect(secondsOn(plan.creations, 'GWP-7')).toBe(5 * FULL_DAY);
  });

  it('keeps a worklog that already records a recurring event', () => {
    const plan = engine.computePlan(
      input({
        settings: settings({ workDays: [1], schedules: [standup([1])] }),
        worklogs: [worklog('standup', 'GWP-1', at(0, 9, 30), 900)],
        activity: [event('e', 'GWP-5', at(0, 11))],
      }),
    );
    expect(plan.deletions).toEqual([]);
    expect(day(plan, 0)).toEqual([
      ['GWP-5', '09:00', 30],
      ['GWP-5', '09:45', 405],
    ]);
  });

  it('bridges quiet days between two days with evidence for an issue', () => {
    const plan = engine.computePlan(
      input({
        activity: [
          event('mon', 'GWP-1', at(0, 10)),
          event('tue', 'GWP-2', at(1, 10), 'pr-opened'),
          event('thu', 'GWP-1', at(3, 10)),
        ],
      }),
    );
    // Tuesday: GWP-2 weighs 3 and the bridged GWP-1 weighs 1, so 30 blocks split 22.5 / 7.5.
    expect(
      secondsOn(
        plan.creations.filter((c) => onDay(c, 1)),
        'GWP-1',
      ),
    ).toBe(8 * 900);
    expect(
      secondsOn(
        plan.creations.filter((c) => onDay(c, 1)),
        'GWP-2',
      ),
    ).toBe(22 * 900);
    // Wednesday has only the bridge.
    expect(day(plan, 2)).toEqual([['GWP-1', '09:00', 450]]);
  });

  it('caps how much one kind of evidence can add per issue per day', () => {
    const plan = engine.computePlan(
      input({
        settings: settings({ workDays: [1] }),
        activity: [
          ...Array.from({ length: 20 }, (_, i) => event(`c${i}`, 'GWP-1', at(0, 9, i))),
          event('opened', 'GWP-2', at(0, 12), 'pr-opened'),
        ],
      }),
    );
    // Twenty commits count as 5, against 3 for opening a pull request: 30 × 5/8 = 18.75.
    expect(day(plan, 0)).toEqual([
      ['GWP-1', '09:00', 285],
      ['GWP-2', '13:45', 165],
    ]);
  });

  it('fills a week with no evidence from the placeholder ticket, or not at all', () => {
    const withPlaceholder = engine.computePlan(
      input({ settings: settings({ placeholderIssueKey: 'GWP-100' }) }),
    );
    expect(secondsOn(withPlaceholder.creations, 'GWP-100')).toBe(5 * FULL_DAY);
    expect(withPlaceholder.creations[0].comment).toBe('General work');

    expect(engine.computePlan(input()).creations).toEqual([]);
  });

  it('gives allocations their share of each day and activity the rest', () => {
    const plan = engine.computePlan(
      input({
        settings: settings({
          workDays: [1],
          allocations: [{ id: 'a', issueKey: 'GWP-9', summary: 'Support rota', percentage: 20 }],
        }),
        activity: [event('e', 'GWP-5', at(0, 11))],
      }),
    );
    expect(day(plan, 0)).toEqual([
      ['GWP-5', '09:00', 360],
      ['GWP-9', '15:00', 90],
    ]);
    expect(plan.creations.map((creation) => creation.source)).toEqual(['activity', 'allocated']);
  });

  it('leaves days after today alone', () => {
    const plan = engine.computePlan(
      input({
        settings: settings({ schedules: [standup([1, 2, 3, 4, 5])] }),
        worklogs: [worklog('future', 'GWP-9', at(3, 9), HOUR, true)],
        activity: [event('e', 'GWP-5', at(0, 11))],
        now: at(2, 12),
      }),
    );
    expect(day(plan, 2).length).toBeGreaterThan(0);
    expect(day(plan, 3)).toEqual([]);
    expect(day(plan, 4)).toEqual([]);
    expect(plan.deletions).toEqual([]);
  });

  it('counts weekend evidence toward the Friday before', () => {
    const plan = engine.computePlan(
      input({
        activity: [event('mon', 'GWP-1', at(0, 10)), event('sat', 'GWP-2', at(5, 10))],
      }),
    );
    expect(day(plan, 4)).toEqual([['GWP-2', '09:00', 450]]);
    expect(day(plan, 0)).toEqual([['GWP-1', '09:00', 450]]);
  });

  describe('with leave', () => {
    const leaveSettings = (overrides: Partial<UserSettings> = {}) =>
      settings({ leaveIssueKey: 'HR-1', schedules: [standup([1, 3])], ...overrides });

    it('keeps leave logged by hand, drops meetings that clash with it, and fills the rest', () => {
      const plan = engine.computePlan(
        input({
          settings: leaveSettings({ workDays: [1] }),
          worklogs: [worklog('leave', 'HR-1', at(0, 9), 3.75 * HOUR)],
          activity: [event('e', 'GWP-5', at(0, 14))],
        }),
      );
      expect(plan.deletions).toEqual([]);
      expect(plan.absorb).toEqual([]);
      expect(day(plan, 0)).toEqual([['GWP-5', '12:45', 225]]);
    });

    it('fills a day marked as leave around leave logged by hand, and nothing else', () => {
      const plan = engine.computePlan(
        input({
          settings: leaveSettings(),
          worklogs: [worklog('hand', 'HR-1', at(2, 9), HOUR)],
          activity: [event('e', 'GWP-5', at(2, 11))],
          leaveDays: [3],
        }),
      );
      expect(day(plan, 2)).toEqual([['HR-1', '10:00', 390]]);
      expect(plan.creations.find((creation) => creation.issueKey === 'HR-1')).toMatchObject({
        comment: 'Leave',
        source: 'leave',
      });
      // Wednesday's evidence counts toward Tuesday instead.
      expect(day(plan, 1)).toEqual([['GWP-5', '09:00', 450]]);
    });

    it('removes leave it logged on a day no longer marked, but never leave logged by hand', () => {
      const plan = engine.computePlan(
        input({
          settings: leaveSettings(),
          worklogs: [
            worklog('ours', 'HR-1', at(3, 9), FULL_DAY, true),
            worklog('hand', 'HR-1', at(4, 9), FULL_DAY),
          ],
          activity: [event('e', 'GWP-5', at(0, 11))],
        }),
      );
      expect(plan.deletions).toEqual([
        { worklogId: 'ours', issueKey: 'HR-1', reason: 'stale-generated' },
      ]);
      expect(day(plan, 3).map(([issueKey]) => issueKey)).toEqual(['GWP-5']);
      expect(day(plan, 4)).toEqual([]);
    });

    it('plans nothing once a week with leave has been synced', () => {
      const base = input({
        settings: leaveSettings({ placeholderIssueKey: 'GWP-100' }),
        worklogs: [
          worklog('hand', 'HR-1', at(0, 9), 2 * HOUR),
          worklog('a', 'GWP-5', at(1, 10), 60),
        ],
        activity: [event('e', 'GWP-6', at(3, 11))],
        leaveDays: [5],
      });
      const first = engine.computePlan(base);
      const second = engine.computePlan({
        ...base,
        worklogs: applied(base.worklogs, first),
        absorbed: first.absorb,
      });
      expect(second).toEqual({ deletions: [], creations: [], absorb: [] });
    });
  });

  it('reports the evidence it used, including replaced worklogs, but not leave', () => {
    const evidence = weekEvidence(
      input({
        settings: settings({ leaveIssueKey: 'HR-1' }),
        worklogs: [worklog('a', 'GWP-5', at(0, 10), 60), worklog('l', 'HR-1', at(1, 9), HOUR)],
        absorbed: [worklog('gone', 'GWP-6', at(2, 10), 60)],
        activity: [event('e', 'GWP-7', at(3, 11)), event('late', 'GWP-7', at(9, 11))],
      }),
    );
    expect(evidence.map((entry) => entry.id).sort()).toEqual(['e', 'jira:a', 'jira:gone']);
  });
});

function onDay(creation: WorklogCreation, dayOffset: number): boolean {
  return new Date(creation.started).getDate() === at(dayOffset, 0).getDate();
}
