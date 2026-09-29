import { Component, computed, input, output } from '@angular/core';
import type { CalendarEvent } from '../../models/domain';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Hours always shown on the agenda, widened when events fall outside them. */
const DEFAULT_FIRST_HOUR = 8;
const DEFAULT_LAST_HOUR = 18;
/** Vertical size of one hour on the agenda. */
const HOUR_HEIGHT_REM = 3;
/** Minimum height so very short events stay readable. */
const MIN_EVENT_REM = 1.25;

interface DayColumn {
  day: Date;
  /** Monday = 1, as in `workDays`. */
  weekday: number;
  events: PositionedEvent[];
}

interface PositionedEvent {
  event: CalendarEvent;
  /** Offset from the top of the agenda, in rem. */
  top: number;
  /** Height proportional to the event's duration, in rem. */
  height: number;
}

@Component({
  selector: 'app-calendar-grid',
  templateUrl: './calendar-grid.html',
  styleUrl: './calendar-grid.scss',
})
export class CalendarGridComponent {
  events = input.required<CalendarEvent[]>();
  weekStart = input.required<Date>();
  /** Whether days can be marked as leave (a leave ticket is set). */
  leaveEnabled = input(false);
  leaveDays = input<number[]>([]);
  /** Days whose working hours are all covered by leave logged by hand. */
  lockedLeaveDays = input<number[]>([]);

  leaveToggled = output<number>();

  protected readonly hourHeightRem = HOUR_HEIGHT_REM;

  /** First and last (exclusive) hour of the visible agenda. */
  protected readonly hourRange = computed<{ first: number; last: number }>(() => {
    let first = DEFAULT_FIRST_HOUR;
    let last = DEFAULT_LAST_HOUR;
    for (const event of this.events()) {
      first = Math.min(first, event.start.getHours());
      const endHour = event.end.getHours() + (event.end.getMinutes() > 0 ? 1 : 0);
      last = Math.max(last, isSameDay(event.start, event.end) ? endHour : 24);
    }
    return { first, last };
  });

  protected readonly hours = computed<number[]>(() => {
    const { first, last } = this.hourRange();
    const hours: number[] = [];
    for (let hour = first; hour < last; hour++) hours.push(hour);
    return hours;
  });

  protected readonly agendaHeightRem = computed(() => this.hours().length * HOUR_HEIGHT_REM);

  protected readonly dayColumns = computed<DayColumn[]>(() => {
    const start = this.weekStart();
    const events = this.events();
    const { first, last } = this.hourRange();
    return [0, 1, 2, 3, 4].map(offset => {
      const day = new Date(start);
      day.setDate(day.getDate() + offset);
      return {
        day,
        weekday: offset + 1,
        events: events
          .filter(event => isSameDay(event.start, day))
          .sort((a, b) => a.start.getTime() - b.start.getTime())
          .map(event => position(event, first, last)),
      };
    });
  });

  protected weekdayName(day: Date): string {
    return WEEKDAYS[day.getDay()];
  }

  protected dateLabel(day: Date): string {
    return `${MONTHS[day.getMonth()]} ${day.getDate()}`;
  }

  protected dateKey(day: Date): string {
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(
      day.getDate(),
    ).padStart(2, '0')}`;
  }

  protected onLeave(weekday: number): boolean {
    return this.leaveDays().includes(weekday) || this.lockedLeaveDays().includes(weekday);
  }

  protected leaveLocked(weekday: number): boolean {
    return this.lockedLeaveDays().includes(weekday);
  }

  protected hourLabel(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
  }

  protected timeRange(event: CalendarEvent): string {
    return `${formatTime(event.start)}–${formatTime(event.end)}`;
  }
}

function position(event: CalendarEvent, firstHour: number, lastHour: number): PositionedEvent {
  const startHours = event.start.getHours() + event.start.getMinutes() / 60;
  const endHours = isSameDay(event.start, event.end)
    ? event.end.getHours() + event.end.getMinutes() / 60
    : lastHour;
  const top = (startHours - firstHour) * HOUR_HEIGHT_REM;
  const height = Math.max(MIN_EVENT_REM, (endHours - startHours) * HOUR_HEIGHT_REM);
  return { event, top, height };
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
