import { TestBed } from '@angular/core/testing';
import { WeekSelectorComponent } from './week-selector';

describe('WeekSelectorComponent', () => {
  function create(currentWeek: Date) {
    const fixture = TestBed.createComponent(WeekSelectorComponent);
    fixture.componentRef.setInput('currentWeek', currentWeek);
    fixture.detectChanges();
    return fixture;
  }

  function query(root: HTMLElement, testId: string): HTMLElement {
    return root.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
  }

  it('renders the week range label for a mid-year week', () => {
    const fixture = create(new Date(2026, 8, 28));
    expect(query(fixture.nativeElement, 'week-label').textContent?.trim()).toBe(
      'Sep 28 – Oct 4, 2026',
    );
  });

  it('renders the week range label across a year boundary', () => {
    const fixture = create(new Date(2026, 11, 28));
    expect(query(fixture.nativeElement, 'week-label').textContent?.trim()).toBe(
      'Dec 28, 2026 – Jan 3, 2027',
    );
  });

  it('updates the label when the input changes', () => {
    const fixture = create(new Date(2026, 8, 28));
    fixture.componentRef.setInput('currentWeek', new Date(2026, 9, 5));
    fixture.detectChanges();
    expect(query(fixture.nativeElement, 'week-label').textContent?.trim()).toBe(
      'Oct 5 – Oct 11, 2026',
    );
  });

  it('prev button emits currentWeek minus 7 days', () => {
    const fixture = create(new Date(2026, 8, 28));
    const emitted: Date[] = [];
    fixture.componentInstance.prevWeek.subscribe((value) => emitted.push(value));

    query(fixture.nativeElement, 'prev-week').click();

    expect(emitted).toEqual([new Date(2026, 8, 21)]);
  });

  it('next button emits currentWeek plus 7 days', () => {
    const fixture = create(new Date(2026, 8, 28));
    const emitted: Date[] = [];
    fixture.componentInstance.nextWeek.subscribe((value) => emitted.push(value));

    query(fixture.nativeElement, 'next-week').click();

    expect(emitted).toEqual([new Date(2026, 9, 5)]);
  });
});
