import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { parseCorrections } from '../../corrections/corrections-file';
import { buildPlan } from '../../corrections/planner';
import { dateKeyInZone, parseJiraDateTime } from '../../corrections/time-zone';
import type { OwnWorklog, Plan } from '../../corrections/types';
import { CorrectionsPanelComponent } from './corrections-panel';

const ZONE = 'Europe/London';
let id = 1;

function wl(date: string, time: string, issueKey: string, hours: number, comment = ''): OwnWorklog {
  const started = `${date}T${time}:00.000+0100`;
  const startedMs = parseJiraDateTime(started);
  return {
    id: String(id++),
    issueKey,
    started,
    startedMs,
    date: dateKeyInZone(startedMs, ZONE),
    seconds: Math.round(hours * 3600),
    comment,
    authorAccountId: 'me',
    properties: [],
  };
}

function plan(): Plan {
  const spec = parseCorrections({
    timeZone: ZONE,
    sickLeave: { issueKey: 'LEAVE-1' },
    days: [
      {
        date: '2026-07-30',
        set: [
          { issueKey: 'LEAVE-1', from: 0, to: 3.75, comment: 'Sick leave' },
          { issueKey: 'APP-395', from: 3.75, to: 0 },
        ],
      },
    ],
  });
  return buildPlan(
    spec,
    [
      wl('2026-07-30', '09:00', 'APP-380', 3.75, 'Alerting'),
      wl('2026-07-30', '13:45', 'APP-395', 3.75),
    ],
    { accountId: 'me', timeZone: ZONE, site: 'http://localhost:3000', lockedIssues: {} },
  );
}

describe('CorrectionsPanelComponent', () => {
  function create(inputs: Record<string, unknown>) {
    const fixture = TestBed.createComponent(CorrectionsPanelComponent);
    for (const [key, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(key, value);
    }
    fixture.detectChanges();
    return fixture;
  }
  const q = (fixture: { nativeElement: HTMLElement }, testId: string) =>
    fixture.nativeElement.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it('previews only a valid file', () => {
    const fixture = create({ draft: '{', parseError: 'Unexpected end of JSON', canPreview: false });
    expect(q(fixture, 'corrections-parse-error')?.textContent).toContain('Unexpected end of JSON');
    expect((q(fixture, 'corrections-preview') as HTMLButtonElement).disabled).toBe(true);

    const valid = create({
      draft: readFileSync('corrections/example.json', 'utf8'),
      canPreview: true,
    });
    const emitted: unknown[] = [];
    valid.componentInstance.preview.subscribe(() => emitted.push('preview'));
    q(valid, 'corrections-preview')?.click();
    expect(emitted).toEqual(['preview']);
  });

  it('shows the dry run, and applies only once the deletions are approved', () => {
    const fixture = create({ plan: plan(), canPreview: true });
    const text = fixture.nativeElement.textContent ?? '';
    expect(text).toContain('Thu 30 Jul 2026');
    expect(text).toContain('CREATE');
    expect(text).toContain('13:45–17:30');
    expect(q(fixture, 'corrections-apply')?.textContent).toContain('Apply 2 changes on 1 day');

    const apply = q(fixture, 'corrections-apply') as HTMLButtonElement;
    const emitted: boolean[] = [];
    fixture.componentInstance.apply.subscribe((value) => emitted.push(value));
    expect(apply.disabled).toBe(true);
    apply.click();
    expect(emitted).toEqual([]);

    (q(fixture, 'corrections-approve-deletions') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(apply.disabled).toBe(false);
    apply.click();
    expect(emitted).toEqual([true]);

    // A new dry run needs approving again.
    fixture.componentRef.setInput('plan', { ...plan(), planId: 'another' });
    fixture.detectChanges();
    expect((q(fixture, 'corrections-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the changes Jira wouldn't take after applying", () => {
    const fixture = create({
      plan: plan(),
      result: {
        status: 'partial',
        message: "Made 1 change(s) on 1 day(s); 1 couldn't be made (listed below).",
        backupPath: 'jira-timesheets-backup-x.json',
        outcomes: [],
        failures: [
          {
            date: '2026-07-30',
            opId: '2026-07-30#1',
            issueKey: 'APP-395',
            worklogId: '2',
            action: 'delete APP-395 worklog 2 (3.75h)',
            kind: 'refused',
            reason: 'Worklog cannot be changed because the timesheet period is closed.',
          },
        ],
        days: [{ date: '2026-07-30', totalSeconds: 11.25 * 3600, plannedSeconds: 7.5 * 3600 }],
      },
    });
    expect(q(fixture, 'corrections-result')?.textContent).toContain(
      "Applied, except changes Jira wouldn't take",
    );
    expect(q(fixture, 'corrections-failures')?.textContent).toContain('timesheet period is closed');
    expect(fixture.nativeElement.textContent).toContain('11.25h (planned 7.5h)');
  });
});
