// The steps around the planner, applier and verifier that talk to Jira: shared by the web app's
// Corrections view and the command line, so both read Jira the same way.

import type { CorrectionsClient } from './client-port';
import { correctionsRange, type CorrectionsSpec } from './corrections-file';
import { buildPlan } from './planner';
import { addDaysToKey, dayWindow } from './time-zone';
import type { LockedIssues, OwnWorklog, Plan } from './types';
import { verifyPlan, type VerifyResult } from './verify';

/** [start of `from`, end of `to`] in the zone, and the JQL dates a day either side. */
export function rangeWindow(from: string, to: string, timeZone: string) {
  return {
    startMs: dayWindow(from, timeZone).start,
    endMs: dayWindow(to, timeZone).end,
    // JQL dates are in the profile zone; a day either side, then `started` makes the exact cut.
    fromDate: addDaysToKey(from, -1),
    toDate: addDaysToKey(to, 1),
  };
}

/** Every issue the corrections change. */
export function issueKeysOf(spec: CorrectionsSpec): string[] {
  return [
    ...new Set([
      ...spec.days.flatMap((day) =>
        day.changes.flatMap((change) =>
          change.kind === 'set' ? [change.issueKey] : [change.fromIssueKey, change.toIssueKey],
        ),
      ),
      ...spec.commentRewrites.map((rewrite) => rewrite.issueKey),
    ]),
  ];
}

const PREFLIGHT_PERMISSIONS = [
  'WORK_ON_ISSUES',
  'EDIT_OWN_WORKLOGS',
  'DELETE_OWN_WORKLOGS',
  'EDIT_ISSUES',
];

/** Issues that look like they would refuse changes: missing permissions or a non-editable status. */
export async function preflight(
  client: CorrectionsClient,
  issueKeys: string[],
): Promise<LockedIssues> {
  const found: LockedIssues = {};
  for (const key of issueKeys) {
    try {
      const permissions = await client.myPermissions(key, PREFLIGHT_PERMISSIONS);
      const missing = ['WORK_ON_ISSUES', 'EDIT_OWN_WORKLOGS', 'DELETE_OWN_WORKLOGS'].filter(
        (permission) => !permissions[permission],
      );
      if (missing.length > 0) {
        found[key] = { reason: `you lack ${missing.join(', ')}`, source: 'pre-flight check' };
        continue;
      }
      // With edit permission but no editable fields, the issue is in a non-editable status.
      if (permissions['EDIT_ISSUES'] && (await client.editableFieldCount(key)) === 0) {
        found[key] = { reason: 'its workflow status is not editable', source: 'pre-flight check' };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      found[key] = {
        reason: `couldn't be checked: ${client.redact(message)}`,
        source: 'pre-flight check',
      };
    }
  }
  return found;
}

/**
 * Reads your worklogs and makes the plan for a corrections file. Read-only. Refuses when the file
 * names a time zone other than your Jira profile's, since days would be read differently.
 */
export async function planCorrections(
  client: CorrectionsClient,
  spec: CorrectionsSpec,
  options: { site: string; knownLocked: LockedIssues; skipPreflight?: boolean; now?: Date },
): Promise<Plan> {
  const me = await client.myself();
  if (spec.timeZone !== undefined && spec.timeZone !== me.timeZone) {
    throw new Error(
      `The corrections file is in ${spec.timeZone} but your Jira profile is in ${me.timeZone}. ` +
        'Days would be read differently from how Jira shows them; fix one before planning.',
    );
  }
  const range = correctionsRange(spec);
  const keys = issueKeysOf(spec);
  const { worklogs } = await client.ownWorklogs(
    me.accountId,
    me.timeZone,
    rangeWindow(range.from, range.to, me.timeZone),
    keys,
  );
  const lockedIssues: LockedIssues = {
    ...Object.fromEntries(
      Object.entries(spec.lockedIssues).map(([key, reason]) => [
        key,
        { reason, source: 'corrections file' },
      ]),
    ),
    ...options.knownLocked,
    ...(options.skipPreflight === true ? {} : await preflight(client, keys)),
  };
  return buildPlan(spec, worklogs, {
    accountId: me.accountId,
    timeZone: me.timeZone,
    site: options.site,
    lockedIssues,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** Your worklogs now on every day of a plan. */
export async function planDayWorklogs(
  client: CorrectionsClient,
  plan: Plan,
): Promise<OwnWorklog[]> {
  const dates = plan.days.map((day) => day.date).sort();
  const keys = [
    ...new Set(
      plan.days.flatMap((day) => [
        ...day.ops.map((op) => op.issueKey),
        ...day.before.worklogs.map((worklog) => worklog.issueKey),
      ]),
    ),
  ];
  const { worklogs } = await client.ownWorklogs(
    plan.accountId,
    plan.timeZone,
    rangeWindow(dates[0], dates[dates.length - 1], plan.timeZone),
    keys,
  );
  return worklogs;
}

/** Re-reads Jira and checks it against the plan; `notMade` are changes the apply log says failed. */
export async function verifyCorrections(
  client: CorrectionsClient,
  plan: Plan,
  notMade: Map<string, string> = new Map(),
): Promise<VerifyResult> {
  return verifyPlan(plan, await planDayWorklogs(client, plan), notMade);
}
