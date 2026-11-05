import { Component, computed, input, linkedSignal, output } from '@angular/core';
import type { ApplyResult } from '../../corrections/apply';
import { dayRows, opLine } from '../../corrections/plan-view';
import { h } from '../../corrections/planner';
import { longDate, shortDate } from '../../corrections/time-zone';
import type { Finding, Plan, PlannedDay } from '../../corrections/types';
import type { VerifyResult } from '../../corrections/verify';

const STATUS_LABEL: Record<PlannedDay['status'], string> = {
  ready: 'Ready',
  blocked: 'Blocked',
  unchanged: 'No change',
};

const FINDING_LABEL: Record<Finding['kind'], string> = {
  'over-hours': 'Over the expected hours',
  'under-hours': 'Under the expected hours',
  'work-on-leave-day': 'Work logged on a leave day',
  'after-merge': 'Logged after the linked pull request merged',
  'locked-issue': 'Time on a locked issue',
  weekend: 'Logged on a non-working day',
};

/**
 * Paste a corrections file, preview the dry run, approve and apply it, and see what happened.
 * Display only: the App wires it to CorrectionsService.
 */
@Component({
  selector: 'app-corrections-panel',
  templateUrl: './corrections-panel.html',
  styleUrl: './corrections-panel.scss',
})
export class CorrectionsPanelComponent {
  draft = input('');
  /** Why the pasted file can't be used, or null. */
  parseError = input<string | null>(null);
  canPreview = input(false);
  /** Where corrections go, e.g. "https://acme.atlassian.net as you@acme.com". */
  target = input('');
  plan = input<Plan | null>(null);
  result = input<ApplyResult | null>(null);
  verify = input<VerifyResult | null>(null);
  busy = input(false);
  /** What is happening now, e.g. "Applying… 12 changes made". */
  progress = input('');
  error = input<string | null>(null);
  backupName = input<string | null>(null);

  draftChange = output<string>();
  preview = output<void>();
  /** Apply the plan on show; true when its deletions are approved. */
  apply = output<boolean>();
  downloadBackup = output<void>();
  downloadLog = output<void>();

  /** Deletions must be approved again for every new dry run. */
  protected readonly deletionsApproved = linkedSignal({
    source: () => this.plan()?.planId,
    computation: () => false,
  });

  protected readonly h = h;
  protected readonly longDate = longDate;
  protected readonly shortDate = shortDate;

  protected readonly days = computed(() => {
    const plan = this.plan();
    if (plan === null) {
      return [];
    }
    return plan.days.map((day) => ({
      day,
      label: longDate(day.date),
      status: STATUS_LABEL[day.status],
      rows: dayRows(day),
      ops: day.ops.map((op) => opLine(op, plan.timeZone)),
      // Open the days that need a look; the rest stay folded so the page reads quickly.
      open: day.status === 'blocked' || day.warnings.length > 0,
    }));
  });

  protected readonly summary = computed(() => {
    const plan = this.plan();
    if (plan === null) {
      return null;
    }
    const ready = plan.days.filter((day) => day.status === 'ready');
    const ops = ready.flatMap((day) => day.ops);
    return {
      ready: ready.length,
      blocked: plan.days.filter((day) => day.status === 'blocked'),
      warned: plan.days.filter((day) => day.status !== 'blocked' && day.warnings.length > 0),
      edits: ops.filter((op) => op.kind === 'update').length,
      creates: ops.filter((op) => op.kind === 'create').length,
      changes: ops.length,
      deletions: ready.flatMap((day) =>
        day.ops
          .filter((op) => op.kind === 'delete')
          .map((op) => ({ date: day.date, line: opLine(op, plan.timeZone) })),
      ),
    };
  });

  protected readonly findings = computed(() => {
    const findings = this.plan()?.findings ?? [];
    return [...new Set(findings.map((finding) => finding.kind))].map((kind) => ({
      label: FINDING_LABEL[kind],
      items: findings.filter((finding) => finding.kind === kind),
    }));
  });

  protected readonly canApply = computed(() => {
    const summary = this.summary();
    return (
      !this.busy() &&
      summary !== null &&
      summary.changes > 0 &&
      (summary.deletions.length === 0 || this.deletionsApproved())
    );
  });

  protected readonly resultTitle = computed(() => {
    switch (this.result()?.status) {
      case 'done':
        return 'Applied';
      case 'partial':
        return "Applied, except changes Jira wouldn't take";
      case 'stopped':
        return 'Stopped';
      case 'refused':
        return 'Not applied';
      default:
        return '';
    }
  });

  protected readonly offDays = computed(() =>
    (this.result()?.days ?? []).filter((day) => day.totalSeconds !== day.plannedSeconds),
  );

  protected onDraftInput(event: Event): void {
    this.draftChange.emit((event.target as HTMLTextAreaElement).value);
  }

  protected onApprove(event: Event): void {
    this.deletionsApproved.set((event.target as HTMLInputElement).checked);
  }

  protected onApply(): void {
    if (this.canApply()) {
      this.apply.emit(this.deletionsApproved());
    }
  }
}
