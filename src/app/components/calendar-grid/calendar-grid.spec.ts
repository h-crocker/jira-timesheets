import { TestBed } from '@angular/core/testing';
import type { CalendarEvent } from '../../models/domain';
import { CalendarGridComponent } from './calendar-grid';

const WEEK_START = new Date(2026, 8, 28); // Monday

function event(id: string, dayOffset: number, hour: number, hours: number, source: CalendarEvent['source']): CalendarEvent {
  const start = new Date(2026, 8, 28 + dayOffset, hour, 0);
  return {
    id,
    issueKey: `GWP-${id}`,
    summary: `Summary ${id}`,
    start,
    end: new Date(start.getTime() + hours * 3600 * 1000),
    timeSpentSeconds: hours * 3600,
    source,
  };
}

describe('CalendarGridComponent', () => {
  function create(events: CalendarEvent[]) {
    const fixture = TestBed.createComponent(CalendarGridComponent);
    fixture.componentRef.setInput('events', events);
    fixture.componentRef.setInput('weekStart', WEEK_START);
    fixture.detectChanges();
    return fixture;
  }

  function root(fixture: { nativeElement: unknown }): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders five day columns Monday to Friday', () => {
    const el = root(create([]));
    const days = Array.from(el.querySelectorAll('[data-testid="weekday"]')).map((n) => n.textContent?.trim());
    expect(days).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    const dates = Array.from(el.querySelectorAll('[data-testid="date-label"]')).map((n) => n.textContent?.trim());
    expect(dates).toEqual(['Sep 28', 'Sep 29', 'Sep 30', 'Oct 1', 'Oct 2']);
  });

  it('shows an empty state for days without events', () => {
    const el = root(create([event('1', 0, 9, 1, 'jira')]));
    expect(el.querySelectorAll('[data-testid="empty-state"]').length).toBe(4);
  });

  it('places events in the correct day column, sorted chronologically', () => {
    const el = root(create([event('b', 1, 13, 1, 'recurring'), event('a', 1, 9, 2, 'allocated'), event('c', 0, 10, 1, 'jira')]));
    const tuesday = el.querySelector('[data-date="2026-09-29"]')!;
    const ids = Array.from(tuesday.querySelectorAll('.event-row')).map((n) => n.getAttribute('data-testid'));
    expect(ids).toEqual(['event-a', 'event-b']);
    const monday = el.querySelector('[data-date="2026-09-28"]')!;
    expect(monday.querySelectorAll('.event-row').length).toBe(1);
  });

  it('renders time range, issue key, summary and source for an event', () => {
    const el = root(create([event('x', 2, 9, 1.5, 'allocated')]));
    const row = el.querySelector('[data-testid="event-x"]')!;
    expect(row.querySelector('.time-range')!.textContent).toBe('09:00–10:30');
    expect(row.querySelector('.issue-key')!.textContent).toBe('GWP-x');
    expect(row.querySelector('.summary')!.textContent).toBe('Summary x');
    expect(row.querySelector('.source-badge')!.getAttribute('data-source')).toBe('allocated');
  });

  it('re-renders when the events input changes', () => {
    const fixture = create([]);
    fixture.componentRef.setInput('events', [event('1', 4, 9, 1, 'jira')]);
    fixture.detectChanges();
    expect(root(fixture).querySelectorAll('.event-row').length).toBe(1);
  });

  it('shows worklogs about to be deleted struck through', () => {
    const el = root(create([{ ...event('gone', 0, 9, 1, 'jira'), pendingDeletion: true }]));
    const row = el.querySelector('[data-testid="event-gone"]')!;
    expect(row.classList).toContain('pending-deletion');
    expect(row.getAttribute('data-pending-deletion')).toBe('true');
  });

  it('offers leave ticks only when leave can be logged', () => {
    const fixture = create([]);
    expect(root(fixture).querySelector('[data-testid="leave-1"]')).toBeNull();

    fixture.componentRef.setInput('leaveEnabled', true);
    fixture.componentRef.setInput('leaveDays', [2]);
    fixture.componentRef.setInput('lockedLeaveDays', [5]);
    fixture.detectChanges();
    const tick = (weekday: number) =>
      root(fixture).querySelector<HTMLInputElement>(`[data-testid="leave-${weekday}"]`)!;
    expect([1, 2, 3, 4, 5].map((weekday) => tick(weekday).checked)).toEqual([false, true, false, false, true]);
    expect(tick(5).disabled).toBe(true);

    const toggled: number[] = [];
    fixture.componentInstance.leaveToggled.subscribe((weekday) => toggled.push(weekday));
    tick(3).click();
    expect(toggled).toEqual([3]);
  });
});
