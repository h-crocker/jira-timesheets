import type { ActivityEvent, JiraWorklog, UserSettings } from '../models/domain';
import {
  type ActivityWeek,
  activityAllocations,
  automaticWorklogs,
  issueWeights,
  weekEvidence,
} from './activity-allocations';

const MONDAY = new Date(2026, 8, 28);
const HOUR = 3600;

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
  timeSpentSeconds = 900,
  generated = false,
): JiraWorklog {
  return { id, issueKey, started, timeSpentSeconds, generated, comment: `Worklog ${id}` };
}

function event(
  id: string,
  issueKey: string,
  when: Date,
  kind: ActivityEvent['kind'] = 'commit',
): ActivityEvent {
  return { id, issueKey, at: when, kind, label: `acme/api#1 ${issueKey}` };
}

function week(overrides: Partial<ActivityWeek> = {}): ActivityWeek {
  return {
    weekStart: MONDAY,
    settings: settings(),
    worklogs: [],
    leaveDays: [],
    activity: [],
    absorbed: [],
    ...overrides,
  };
}

const ALL_DAYS = [1, 2, 3, 4, 5];

describe('automaticWorklogs', () => {
  it("is everything but the app's own worklogs, leave and recorded recurring meetings", () => {
    const standup = {
      id: 's',
      issueKey: 'GWP-1',
      summary: 'Standup',
      weekdays: [1],
      startTime: '09:30',
      durationSeconds: 900,
      enabled: true,
    };
    const automatic = automaticWorklogs(
      MONDAY,
      settings({ schedules: [standup] }),
      [
        worklog('auto', 'GWP-5', at(0, 15)),
        worklog('ours', 'GWP-6', at(1, 9), HOUR, true),
        worklog('leave', 'HR-1', at(2, 9), HOUR),
        worklog('standup', 'GWP-1', at(0, 9, 30)),
        worklog('next-week', 'GWP-5', at(7, 9)),
      ],
      [],
    );
    expect(automatic.map((entry) => entry.id)).toEqual(['auto']);
  });
});

describe('weekEvidence', () => {
  it('adds automatic and replaced worklogs to GitHub activity, once each, but not leave', () => {
    const evidence = weekEvidence(
      week({
        worklogs: [worklog('a', 'GWP-5', at(0, 10)), worklog('l', 'HR-1', at(1, 9), HOUR)],
        absorbed: [worklog('a', 'GWP-5', at(0, 10)), worklog('gone', 'GWP-6', at(2, 10))],
        activity: [event('e', 'GWP-7', at(3, 11)), event('late', 'GWP-7', at(9, 11))],
      }),
    );
    expect(evidence.map((entry) => entry.id).sort()).toEqual(['e', 'jira:a', 'jira:gone']);
  });
});

describe('issueWeights', () => {
  it('caps how much one kind of evidence adds per issue per day', () => {
    const weights = issueWeights(
      [
        ...Array.from({ length: 20 }, (_, i) => event(`c${i}`, 'GWP-1', at(0, 9, i))),
        event('opened', 'GWP-2', at(0, 12), 'pr-opened'),
      ],
      ALL_DAYS,
    );
    expect([...weights]).toEqual([
      ['GWP-1', 5],
      ['GWP-2', 3],
    ]);
  });

  it('counts quiet days between two days with evidence for an issue', () => {
    const weights = issueWeights(
      [event('mon', 'GWP-1', at(0, 10)), event('thu', 'GWP-1', at(3, 10))],
      ALL_DAYS,
    );
    // One commit on each of two days, plus Tuesday and Wednesday in between.
    expect(weights.get('GWP-1')).toBe(4);
  });

  it('counts evidence on a day off toward the working day before it', () => {
    const weights = issueWeights(
      Array.from({ length: 6 }, (_, i) => event(`sat${i}`, 'GWP-1', at(5, 10, i))),
      [1, 2, 3, 4],
    );
    // Six Saturday commits land on Thursday together, so the per-day cap of 5 still applies.
    expect(weights.get('GWP-1')).toBe(5);
  });

  it("splits a pull request's weight between the issues it names", () => {
    const weights = issueWeights(
      [
        { ...event('a', 'GWP-1', at(0, 10), 'pr-opened'), share: 0.5 },
        { ...event('b', 'GWP-2', at(0, 10), 'pr-opened'), share: 0.5 },
      ],
      ALL_DAYS,
    );
    expect([...weights]).toEqual([
      ['GWP-1', 1.5],
      ['GWP-2', 1.5],
    ]);
  });
});

describe('activityAllocations', () => {
  it('turns evidence into whole percentages that add up to 100, largest first', () => {
    const allocations = activityAllocations(
      week({
        worklogs: [worklog('a', 'GWP-5', at(0, 15))],
        activity: [
          event('c1', 'GWP-7', at(1, 10)),
          event('c2', 'GWP-7', at(1, 11)),
          event('r', 'GWP-8', at(2, 9), 'review'),
        ],
      }),
      new Map([['GWP-5', 'Login fails for SSO users']]),
    );
    // Weights 4 (automatic worklog), 2 (commits) and 3 (review) out of 9.
    expect(allocations).toEqual([
      {
        id: 'activity-GWP-5',
        issueKey: 'GWP-5',
        summary: 'Login fails for SSO users',
        percentage: 45,
      },
      { id: 'activity-GWP-8', issueKey: 'GWP-8', summary: 'GWP-8', percentage: 33 },
      { id: 'activity-GWP-7', issueKey: 'GWP-7', summary: 'GWP-7', percentage: 22 },
    ]);
  });

  it('gives a week with no evidence to the placeholder ticket, or nothing without one', () => {
    expect(
      activityAllocations(
        week({ settings: settings({ placeholderIssueKey: 'GWP-100' }) }),
        new Map(),
      ),
    ).toEqual([
      { id: 'activity-GWP-100', issueKey: 'GWP-100', summary: 'General work', percentage: 100 },
    ]);
    expect(activityAllocations(week(), new Map())).toEqual([]);
  });

  it('leaves out issues whose share rounds to nothing', () => {
    const allocations = activityAllocations(
      week({
        activity: [
          ...Array.from({ length: 150 }, (_, i) =>
            event(`o${i}`, 'GWP-1', at(i % 5, 9, i % 60), 'pr-opened'),
          ),
          { ...event('tiny', 'GWP-2', at(0, 12), 'comment'), share: 0.1 },
        ],
      }),
      new Map(),
    );
    expect(allocations.map((allocation) => [allocation.issueKey, allocation.percentage])).toEqual([
      ['GWP-1', 100],
    ]);
  });
});
