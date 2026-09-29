import type { JiraWorklog, UserSettings } from '../models/domain';
import { leaveDayState } from './leave-planner';
import { TimesheetEngineService } from './timesheet-engine.service';

const HOUR = 3600;
const FULL_DAY = 7.5 * HOUR;
/** Half the working day, either side of lunch: 09:00–12:45 and 13:45–17:30. */
const HALF_DAY = FULL_DAY / 2;
const MONDAY = new Date(2026, 8, 28);

function at(dayOffset: number, hours: number, minutes = 0): Date {
  return new Date(2026, 8, 28 + dayOffset, hours, minutes);
}

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    startTime: '09:00',
    hoursPerDay: 7.5,
    lunchMinutes: 60,
    workDays: [1, 2, 3, 4, 5],
    allocations: [],
    schedules: [],
    spreadPrefixes: [],
    weekAllocations: {},
    leaveIssueKey: 'HR-1',
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
  return { id, issueKey, started, timeSpentSeconds, generated };
}

describe('leaveDayState', () => {
  it('ticks days the app logged leave on and locks days taken up by leave logged by hand', () => {
    const state = leaveDayState(MONDAY, settings(), [
      worklog('ours', 'HR-1', at(1, 9), FULL_DAY, true),
      // Ends at 16:30, an hour before the working day does, but it is a whole day's leave.
      worklog('hand', 'HR-1', at(3, 9), FULL_DAY),
      worklog('half', 'HR-1', at(4, 9), 3 * HOUR),
      worklog('other', 'GWP-1', at(2, 9), FULL_DAY, true),
    ]);
    expect(state).toEqual({ ticked: [2], locked: [4] });
  });

  it('shows no leave without a leave ticket', () => {
    const state = leaveDayState(MONDAY, settings({ leaveIssueKey: '' }), [
      worklog('hand', 'HR-1', at(3, 9), FULL_DAY),
    ]);
    expect(state).toEqual({ ticked: [], locked: [] });
  });
});

describe('TimesheetEngineService leave in allocation mode', () => {
  const engine = new TimesheetEngineService();

  it('logs a marked day as leave and shares the other days between allocations', () => {
    const plan = engine.computePlan({
      weekStart: MONDAY,
      settings: settings({
        allocations: [{ id: 'a', issueKey: 'GWP-9', summary: 'Project', percentage: 100 }],
        schedules: [
          {
            id: 's',
            issueKey: 'GWP-1',
            summary: 'Standup',
            weekdays: [1, 2],
            startTime: '09:30',
            durationSeconds: 900,
            enabled: true,
          },
        ],
      }),
      worklogs: [worklog('clash', 'GWP-3', at(0, 11), HOUR)],
      leaveDays: [1],
    });

    const monday = plan.creations.filter((creation) => new Date(creation.started) < at(1, 0));
    expect(monday).toEqual([
      {
        issueKey: 'HR-1',
        started: at(0, 9).toISOString(),
        timeSpentSeconds: HALF_DAY,
        comment: 'Leave',
        source: 'leave',
      },
      {
        issueKey: 'HR-1',
        started: at(0, 13, 45).toISOString(),
        timeSpentSeconds: HALF_DAY,
        comment: 'Leave',
        source: 'leave',
      },
    ]);
    expect(plan.deletions).toEqual([
      { worklogId: 'clash', issueKey: 'GWP-3', reason: 'overlap-with-leave' },
    ]);
    const allocated = plan.creations
      .filter((creation) => creation.source === 'allocated')
      .reduce((sum, creation) => sum + creation.timeSpentSeconds, 0);
    // Four working days, less Tuesday's standup.
    expect(allocated).toBe(4 * FULL_DAY - 900);
  });

  it('keeps leave logged by hand even where a recurring event would clash with it', () => {
    const plan = engine.computePlan({
      weekStart: MONDAY,
      settings: settings({
        schedules: [
          {
            id: 's',
            issueKey: 'GWP-1',
            summary: 'Standup',
            weekdays: [1],
            startTime: '09:30',
            durationSeconds: 900,
            enabled: true,
          },
        ],
      }),
      worklogs: [worklog('hand', 'HR-1', at(0, 9), 2 * HOUR)],
    });
    expect(plan).toEqual({ deletions: [], creations: [], absorb: [] });
  });

  it('plans nothing more once the leave it planned is in Jira', () => {
    const plan = engine.computePlan({
      weekStart: MONDAY,
      settings: settings(),
      worklogs: [
        worklog('morning', 'HR-1', at(2, 9), HALF_DAY, true),
        worklog('afternoon', 'HR-1', at(2, 13, 45), HALF_DAY, true),
      ],
      leaveDays: [3],
    });
    expect(plan).toEqual({ deletions: [], creations: [], absorb: [] });
  });

  it('fills the rest of a day with leave around half a day logged by hand', () => {
    const plan = engine.computePlan({
      weekStart: MONDAY,
      settings: settings(),
      worklogs: [worklog('hand', 'HR-1', at(2, 9), 3 * HOUR)],
      leaveDays: [3],
    });
    expect(plan.creations.map((creation) => [creation.started, creation.timeSpentSeconds])).toEqual(
      [
        [at(2, 12).toISOString(), 0.75 * HOUR],
        [at(2, 13, 45).toISOString(), HALF_DAY],
      ],
    );
  });

  it('ignores marked days without a leave ticket', () => {
    const plan = engine.computePlan({
      weekStart: MONDAY,
      settings: settings({ leaveIssueKey: '' }),
      worklogs: [],
      leaveDays: [3],
    });
    expect(plan.creations).toEqual([]);
  });
});
