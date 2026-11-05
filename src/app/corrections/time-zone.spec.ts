import {
  addDaysToKey,
  dateKeyInZone,
  dayWindow,
  formatJiraStarted,
  isoWeekdayOfKey,
  parseJiraDateTime,
  zonedTimeToMs,
} from './time-zone';

const LONDON = 'Europe/London';

describe('time zones', () => {
  it('puts a worklog started at midnight BST on its own day, not the UTC day before', () => {
    const started = parseJiraDateTime('2026-06-23T00:00:00.000+0100');
    expect(new Date(started).toISOString()).toBe('2026-06-22T23:00:00.000Z');
    expect(dateKeyInZone(started, LONDON)).toBe('2026-06-23');
    expect(dateKeyInZone(started, 'Etc/UTC')).toBe('2026-06-22');
  });

  it('reads every form of Jira date-time the same', () => {
    const expected = Date.UTC(2026, 5, 10, 12, 45);
    expect(parseJiraDateTime('2026-06-10T13:45:00.000+0100')).toBe(expected);
    expect(parseJiraDateTime('2026-06-10T13:45:00.000+01:00')).toBe(expected);
    expect(parseJiraDateTime('2026-06-10T12:45:00.000+0000')).toBe(expected);
    expect(parseJiraDateTime('2026-06-10T12:45:00Z')).toBe(expected);
    expect(() => parseJiraDateTime('10 Jun 2026')).toThrow();
  });

  it('writes started in the profile zone with its offset', () => {
    const ms = zonedTimeToMs('2026-06-10', '13:45', LONDON);
    expect(formatJiraStarted(ms, LONDON)).toBe('2026-06-10T13:45:00.000+0100');
    expect(formatJiraStarted(zonedTimeToMs('2026-11-05', '09:00', LONDON), LONDON)).toBe(
      '2026-11-05T09:00:00.000+0000',
    );
    expect(
      formatJiraStarted(
        zonedTimeToMs('2026-06-10', '09:00', 'America/New_York'),
        'America/New_York',
      ),
    ).toBe('2026-06-10T09:00:00.000-0400');
  });

  it('has 23 and 25 hour days at the clock changes', () => {
    const spring = dayWindow('2026-03-29', LONDON);
    const autumn = dayWindow('2026-10-25', LONDON);
    expect((spring.end - spring.start) / 3_600_000).toBe(23);
    expect((autumn.end - autumn.start) / 3_600_000).toBe(25);
  });

  it('does date arithmetic on calendar dates', () => {
    expect(addDaysToKey('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDaysToKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(isoWeekdayOfKey('2026-06-10')).toBe(3);
    expect(isoWeekdayOfKey('2026-06-14')).toBe(7);
  });
});
