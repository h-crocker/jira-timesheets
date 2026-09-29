import { Component, computed, input, output } from '@angular/core';
import type {
  ActivityIssueSummary,
  PercentageAllocation,
  UnkeyedPullRequest,
} from '../../models/domain';

@Component({
  selector: 'app-activity-panel',
  templateUrl: './activity-panel.html',
  styleUrl: './activity-panel.scss',
})
export class ActivityPanelComponent {
  /** The week's own allocations, filled from activity, or null when it uses the usual ones. */
  weekAllocations = input<PercentageAllocation[] | null>(null);
  /** The evidence behind the last fill of this week, by issue. */
  issues = input<ActivityIssueSummary[]>([]);
  unkeyedPullRequests = input<UnkeyedPullRequest[]>([]);
  placeholderIssueKey = input('');
  warnings = input<string[]>([]);
  busy = input(false);

  fill = output<void>();
  clear = output<void>();

  protected readonly evidence = computed(
    () => new Map(this.issues().map((issue) => [issue.issueKey, issue])),
  );

  protected plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }
}
