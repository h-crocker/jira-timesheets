import { Component, input } from '@angular/core';
import type { ActivityIssueSummary, UnkeyedPullRequest } from '../../models/domain';

@Component({
  selector: 'app-activity-panel',
  templateUrl: './activity-panel.html',
  styleUrl: './activity-panel.scss',
})
export class ActivityPanelComponent {
  issues = input.required<ActivityIssueSummary[]>();
  unkeyedPullRequests = input<UnkeyedPullRequest[]>([]);
  placeholderIssueKey = input('');
  warnings = input<string[]>([]);

  protected hours(seconds: number): string {
    const minutes = Math.round(seconds / 60);
    const whole = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${whole}h` : `${whole}h ${rest}m`;
  }

  protected plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }
}
