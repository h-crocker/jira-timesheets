import { Component, computed, inject } from '@angular/core';
import { CorrectionsService } from '../../services/corrections.service';
import { CorrectionsPanelComponent } from '../corrections-panel/corrections-panel';

/**
 * The Corrections view, wired to CorrectionsService. The App loads it only when the view is
 * opened (`@defer`), so the planner and its dependencies stay out of the week view's bundle.
 */
@Component({
  selector: 'app-corrections-page',
  imports: [CorrectionsPanelComponent],
  template: `
    <app-corrections-panel
      [draft]="corrections.draft()"
      [parseError]="parseError()"
      [canPreview]="ready()"
      [target]="corrections.target()"
      [plan]="corrections.plan()"
      [result]="corrections.result()"
      [verify]="corrections.verify()"
      [busy]="corrections.busy()"
      [progress]="progress()"
      [error]="error()"
      [backupName]="corrections.backupName()"
      (draftChange)="corrections.setDraft($event)"
      (preview)="corrections.preview()"
      (apply)="corrections.apply($event)"
      (downloadBackup)="corrections.downloadBackup()"
      (downloadLog)="corrections.downloadLog()"
    />
  `,
})
export class CorrectionsPageComponent {
  protected readonly corrections = inject(CorrectionsService);

  /** What is happening now, for the progress line. */
  protected readonly progress = computed(() => {
    const status = this.corrections.status();
    switch (status.kind) {
      case 'previewing':
        return 'Reading your worklogs and making the dry run…';
      case 'applying':
        return `Applying… ${status.changes} change${status.changes === 1 ? '' : 's'} made so far (${status.date}).`;
      case 'verifying':
        return 'Checking Jira against the plan…';
      default:
        return '';
    }
  });

  protected readonly error = computed(() => {
    const status = this.corrections.status();
    return status.kind === 'error' ? status.message : null;
  });

  protected readonly parseError = computed(() => {
    const parsed = this.corrections.parsed();
    return parsed !== null && 'error' in parsed ? parsed.error : null;
  });

  protected readonly ready = computed(() => {
    const parsed = this.corrections.parsed();
    return parsed !== null && 'spec' in parsed;
  });
}
