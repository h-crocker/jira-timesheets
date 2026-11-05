// Plans, apply results and verification as Markdown, for the terminal and for a file to review.

import type { ApplyResult } from './apply';
import { h, timeSpan } from './planner';
import { longDate, parseJiraDateTime, shortDate } from './time-zone';
import type { Finding, Op, Plan, PlannedDay } from './types';
import type { VerifyResult } from './verify';

const STATUS: Record<PlannedDay['status'], string> = {
  ready: 'READY',
  blocked: 'BLOCKED',
  unchanged: 'NO CHANGE',
};

const KIND_LABEL: Record<Finding['kind'], string> = {
  'over-hours': 'Over the expected hours',
  'under-hours': 'Under the expected hours',
  'work-on-leave-day': 'Work logged on a leave day',
  'after-merge': 'Logged after the linked pull request merged',
  'locked-issue': 'Time on a locked issue',
  weekend: 'Logged on a non-working day',
};

function quote(text: string): string {
  return text === '' ? '(no comment)' : `"${text.replace(/\n/g, ' / ')}"`;
}

function describeOp(op: Op, timeZone: string): string {
  const after =
    op.kind !== 'create' && op.requires !== undefined && op.requires.length > 0
      ? ` (only once ${op.requires.join(', ')} is made, so time is never lost)`
      : '';
  return describeOpBody(op, timeZone) + after;
}

function describeOpBody(op: Op, timeZone: string): string {
  if (op.kind === 'create') {
    const start = parseJiraDateTime(op.started);
    return `**CREATE** ${op.issueKey} · ${timeSpan(start, op.seconds, timeZone)} · ${h(op.seconds)} · ${quote(op.comment)} — ${op.why}`;
  }
  const start = parseJiraDateTime(op.started);
  if (op.kind === 'delete') {
    return `**DELETE** ${op.issueKey} worklog ${op.worklogId} · ${timeSpan(start, op.before.seconds, timeZone)} · ${h(op.before.seconds)} · ${quote(op.before.comment)} — ${op.why}`;
  }
  const newStart = op.after.started === undefined ? start : parseJiraDateTime(op.after.started);
  const parts: string[] = [];
  if (op.after.started !== undefined) {
    parts.push(
      `${timeSpan(start, op.before.seconds, timeZone)} → **${timeSpan(newStart, op.after.seconds, timeZone)}** (moved, same day)`,
    );
  } else {
    parts.push(`starts ${timeSpan(start, op.before.seconds, timeZone).split('–')[0]} (unchanged)`);
  }
  if (op.after.seconds !== op.before.seconds) {
    parts.push(
      `${h(op.before.seconds)} → ${h(op.after.seconds)}` +
        (op.after.started === undefined
          ? ` (ends ${timeSpan(start, op.after.seconds, timeZone).split('–')[1]})`
          : ''),
    );
  } else {
    parts.push(h(op.before.seconds));
  }
  if (op.after.comment !== op.before.comment) {
    parts.push(`comment ${quote(op.before.comment)} → ${quote(op.after.comment)}`);
  } else {
    parts.push(quote(op.before.comment));
  }
  return `**EDIT** ${op.issueKey} worklog ${op.worklogId} · ${parts.join(' · ')} — ${op.why}`;
}

function dayTable(day: PlannedDay): string[] {
  const issues = [
    ...new Set([
      ...Object.keys(day.before.byIssue),
      ...Object.keys(day.after.byIssue),
      ...Object.keys(day.expectedBefore),
    ]),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const rows = issues.map((key) => {
    const expected = day.expectedBefore[key];
    const now = day.before.byIssue[key] ?? 0;
    const after = day.after.byIssue[key] ?? 0;
    const mismatch = expected !== undefined && expected !== now ? ' ⚠' : '';
    return `| ${key} | ${expected === undefined ? '' : h(expected)} | ${h(now)}${mismatch} | ${after === now ? '' : h(after)} |`;
  });
  return [
    '| Issue | File expects | Jira now | After |',
    '| --- | ---: | ---: | ---: |',
    ...rows,
    `| **Day total** | | **${h(day.before.totalSeconds)}** | **${h(day.after.totalSeconds)}** |`,
  ];
}

export function renderPlan(plan: Plan, options: { planPath?: string } = {}): string {
  const ready = plan.days.filter((day) => day.status === 'ready');
  const blocked = plan.days.filter((day) => day.status === 'blocked');
  const readyOps = ready.flatMap((day) => day.ops);
  const count = (kind: Op['kind']) => readyOps.filter((op) => op.kind === kind).length;
  const deletions = ready.flatMap((day) =>
    day.ops
      .filter((op) => op.kind === 'delete')
      .sort((a, b) => parseJiraDateTime(a.started) - parseJiraDateTime(b.started))
      .map((op) => ({ day, op })),
  );
  const lines: string[] = [
    `# Dry run: ${plan.name}`,
    '',
    `Plan \`${plan.planId}\` · time zone ${plan.timeZone} · made ${plan.createdAt}`,
    '',
    '**Nothing has been changed in Jira.**',
    '',
    '## Summary',
    '',
    `- ${ready.length} day(s) ready, ${blocked.length} blocked, ${plan.days.length - ready.length - blocked.length} unchanged`,
    `- Ready changes: ${count('update')} edit(s), ${count('delete')} deletion(s), ${count('create')} new worklog(s)`,
    `- Writes use adjustEstimate=leave and notifyUsers=false. Work worklogs keep their start times; only sick leave is moved, on the same day, to end the day as one block`,
    ...plan.checks.map((check) => `- ${check.ok ? '✅' : '❌'} ${check.label}: ${check.detail}`),
    '- If Jira refuses to shorten or delete a worklog, apply records it and carries on: sick leave is still added, even if the day then comes to more than its hours',
    '',
  ];
  const warned = plan.days.filter((day) => day.status !== 'blocked' && day.warnings.length > 0);
  if (warned.length > 0) {
    lines.push('## Check before approving', '');
    for (const day of warned) {
      lines.push(`- **${longDate(day.date)}**: ${day.warnings.join(' ')}`);
    }
    lines.push('');
  }
  if (blocked.length > 0) {
    lines.push('## Blocked days (shown, never applied)', '');
    for (const day of blocked) {
      lines.push(`- **${longDate(day.date)}**: ${day.problems.join(' ')}`);
    }
    lines.push('');
  }
  if (deletions.length > 0) {
    lines.push(
      '## Deletions that need your approval',
      '',
      '| Date | Issue | Worklog | Time | Hours | Comment |',
      '| --- | --- | --- | --- | ---: | --- |',
      ...deletions.map(({ day, op }) =>
        op.kind === 'delete'
          ? `| ${shortDate(day.date)} | ${op.issueKey} | ${op.worklogId} | ${timeSpan(parseJiraDateTime(op.started), op.before.seconds, plan.timeZone)} | ${h(op.before.seconds)} | ${quote(op.before.comment)} |`
          : '',
      ),
      '',
    );
  }
  lines.push('## Days', '');
  for (const day of plan.days) {
    lines.push(
      `### ${longDate(day.date)} — ${STATUS[day.status]} · ${h(day.before.totalSeconds)} → ${h(day.after.totalSeconds)}`,
      '',
      ...dayTable(day),
      '',
    );
    if (day.problems.length > 0) {
      lines.push(...day.problems.map((problem) => `- ⛔ ${problem}`), '');
    }
    if (day.warnings.length > 0) {
      lines.push(...day.warnings.map((warning) => `- ⚠️ ${warning}`), '');
    }
    if (day.ops.length > 0) {
      lines.push(
        day.status === 'blocked' ? 'Would have changed (not applied):' : 'Changes:',
        '',
        ...day.ops.map((op) => `- \`${op.opId}\` ${describeOp(op, plan.timeZone)}`),
        '',
      );
    }
    if (day.before.worklogs.length > 0) {
      lines.push(
        '<details><summary>Worklogs in Jira now</summary>',
        '',
        ...day.before.worklogs
          .slice()
          .sort((a, b) => parseJiraDateTime(a.started) - parseJiraDateTime(b.started))
          .map(
            (worklog) =>
              `- ${worklog.issueKey} worklog ${worklog.id} · ${timeSpan(parseJiraDateTime(worklog.started), worklog.seconds, plan.timeZone)} · ${h(worklog.seconds)} · ${quote(worklog.comment)}`,
          ),
        '',
        '</details>',
        '',
      );
    }
    if (day.notes.length > 0) {
      lines.push(...day.notes.map((note) => `- ℹ️ ${note}`), '');
    }
  }
  lines.push(...renderFindings(plan.findings, 'Validation after the ready changes'));
  if (options.planPath !== undefined) {
    const allowDeletions = deletions.length > 0 ? ' --allow-deletions' : '';
    lines.push(
      '## To apply',
      '',
      'Only after reviewing everything above:',
      '',
      '```bash',
      `npm run timesheets -- apply ${options.planPath} --approve ${plan.planId}${allowDeletions}`,
      `npm run timesheets -- verify ${options.planPath}`,
      '```',
      '',
    );
  }
  return lines.join('\n');
}

export function renderFindings(findings: Finding[], title: string): string[] {
  if (findings.length === 0) {
    return [`## ${title}`, '', 'No problems found.', ''];
  }
  const lines = [`## ${title}`, ''];
  const kinds = [...new Set(findings.map((finding) => finding.kind))];
  for (const kind of kinds) {
    const items = findings.filter((finding) => finding.kind === kind);
    lines.push(`**${KIND_LABEL[kind]}** (${items.length})`, '');
    lines.push(...items.map((finding) => `- ${longDate(finding.date)}: ${finding.message}`), '');
  }
  return lines;
}

export function renderApply(result: ApplyResult): string {
  const lines = [`# Apply: ${result.status.toUpperCase()}`, '', result.message, ''];
  if (result.backupPath !== undefined) {
    lines.push(`Backup: \`${result.backupPath}\``, '');
  }
  lines.push(...renderNotMade(result));
  const off = result.days.filter((day) => day.totalSeconds !== day.plannedSeconds);
  if (off.length > 0) {
    lines.push(
      '## Days not at their planned hours',
      '',
      ...off.map(
        (day) =>
          `- ${longDate(day.date)}: ${h(day.totalSeconds)} (planned ${h(day.plannedSeconds)})`,
      ),
      '',
    );
  }
  if (result.outcomes.length > 0) {
    lines.push(
      '<details><summary>Every change</summary>',
      '',
      ...result.outcomes.map((item) => `- ${item.opId}: ${item.outcome}`),
      '',
      '</details>',
      '',
    );
  }
  if (result.stoppedAt !== undefined) {
    lines.push(
      `**Stopped on ${longDate(result.stoppedAt.date)}${result.stoppedAt.opId ? ` at ${result.stoppedAt.opId}` : ''}.** Nothing after this was tried; run apply again once it is fixed.`,
      '',
      `> ${result.stoppedAt.reason}`,
      '',
    );
  }
  return lines.join('\n');
}

/** The changes that couldn't be made, as a table: the "couldn't change" log. */
export function renderNotMade(result: ApplyResult): string[] {
  if (result.failures.length === 0) {
    return [];
  }
  return [
    `## Couldn't be changed (${result.failures.length})`,
    '',
    '| Date | Change | Why |',
    '| --- | --- | --- |',
    ...result.failures.map(
      (failure) =>
        `| ${shortDate(failure.date)} | ${failure.action.replace(/\|/g, '\\|')} | ${failure.reason.replace(/\|/g, '\\|')} |`,
    ),
    '',
  ];
}

export function renderVerify(result: VerifyResult): string {
  const notMade = result.days.some((day) => day.status === 'not-made');
  const lines = [
    `# Verify: ${result.ok ? (notMade ? 'PASS, except changes logged as not made' : 'PASS') : 'FAIL'}`,
    '',
  ];
  const marks = { ok: '✅', 'not-made': '⚠️', mismatch: '❌', skipped: '⏭️' } as const;
  for (const day of result.days) {
    const detail = [...day.problems, ...day.notMade.map((item) => `not made: ${item}`)];
    lines.push(
      `- ${marks[day.status]} ${longDate(day.date)} · ${h(day.totalSeconds)}` +
        (day.totalSeconds !== day.plannedSeconds ? ` (planned ${h(day.plannedSeconds)})` : '') +
        (detail.length > 0 ? ` — ${detail.join('; ')}` : ''),
    );
  }
  lines.push('');
  for (const total of result.totals) {
    lines.push(
      `- ${total.ok ? '✅' : '❌'} ${total.label}: ${h(total.seconds)} (expected ${h(total.expectedSeconds)})`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
