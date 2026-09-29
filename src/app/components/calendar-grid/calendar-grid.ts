import { Component, computed, input, output } from '@angular/core';
import type { CalendarEvent } from '../../models/domain';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface DayColumn {
  day: Date;
  /** Monday = 1, as in `workDays`. */
  weekday: number;
  events: CalendarEvent[];
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

  protected readonly dayColumns = computed<DayColumn[]>(() => {
    const start = this.weekStart();
    const events = this.events();
    return [0, 1, 2, 3, 4].map(offset => {
      const day = new Date(start);
      day.setDate(day.getDate() + offset);
      return {
        day,
        weekday: offset + 1,
        events: events
          .filter(event => isSameDay(event.start, day))
          .sort((a, b) => a.start.getTime() - b.start.getTime()),
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

  protected timeRange(event: CalendarEvent): string {
    return `${formatTime(event.start)}–${formatTime(event.end)}`;
  }
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
