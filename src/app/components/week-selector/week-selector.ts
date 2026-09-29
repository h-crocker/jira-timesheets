import { Component, computed, input, output } from '@angular/core';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

@Component({
  selector: 'app-week-selector',
  templateUrl: './week-selector.html',
  styleUrl: './week-selector.scss',
})
export class WeekSelectorComponent {
  currentWeek = input.required<Date>();
  prevWeek = output<Date>();
  nextWeek = output<Date>();

  protected readonly weekLabel = computed(() => {
    const start = this.currentWeek();
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const startText = `${MONTHS[start.getMonth()]} ${start.getDate()}`;
    const endText = `${MONTHS[end.getMonth()]} ${end.getDate()}`;
    return start.getFullYear() === end.getFullYear()
      ? `${startText} – ${endText}, ${start.getFullYear()}`
      : `${startText}, ${start.getFullYear()} – ${endText}, ${end.getFullYear()}`;
  });

  protected goPrev(): void {
    this.prevWeek.emit(this.shiftWeek(-7));
  }

  protected goNext(): void {
    this.nextWeek.emit(this.shiftWeek(7));
  }

  private shiftWeek(days: number): Date {
    const date = new Date(this.currentWeek());
    date.setDate(date.getDate() + days);
    return date;
  }
}
