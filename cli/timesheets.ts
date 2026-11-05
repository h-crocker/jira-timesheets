// npm run timesheets -- <command>
//
//   plan <corrections.json> [--out plan.json] [--skip-preflight]   read-only dry run
//   apply <plan.json> --approve <planId> [--allow-deletions]       back up, then change Jira
//   verify <plan.json>                                              check Jira matches the plan
//   report --from <date> --to <date> [--format md|csv] [--out f]    weeks by ticket and day
//   validate --from <date> --to <date> [--leave LEAVE-1] [--hours 7.5] [--github]
//   locked [--remove <KEY>]                                         issues known to refuse changes
//
// State (plans, backups, logs, locked issues, config) lives in .timesheets/, which git ignores.
// Override with TIMESHEETS_DIR.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { applyPlan, type ApplyLogEntry } from '../src/app/corrections/apply';
import { correctionsRange, parseCorrections } from '../src/app/corrections/corrections-file';
import { fetchMergeTimes } from '../src/app/corrections/github-merges';
import { JiraError, JiraRestClient, redact } from '../src/app/corrections/jira-rest-client';
import { buildPlan } from '../src/app/corrections/planner';
import {
  renderApply,
  renderFindings,
  renderPlan,
  renderVerify,
  renderNotMade,
} from '../src/app/corrections/render';
import { reportCsv, reportMarkdown, weeklyReport } from '../src/app/corrections/report';
import { addDaysToKey, dayWindow, parseDateKey } from '../src/app/corrections/time-zone';
import type { LockedIssues, Plan } from '../src/app/corrections/types';
import { validateWorklogs } from '../src/app/corrections/validation';
import { verifyPlan } from '../src/app/corrections/verify';
import { githubToken, jiraCredentials, readConfig } from './credentials';

const STATE_DIR = resolve(process.env['TIMESHEETS_DIR'] ?? '.timesheets');
const LOCKED_FILE = join(STATE_DIR, 'locked-issues.json');
/** Every secret seen this run, so any error text can be scrubbed before it is shown. */
const secrets: string[] = [];

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      const next = argv[i + 1];
      if (inline !== undefined) {
        flags.set(name, inline);
      } else if (next !== undefined && !next.startsWith('--') && !BOOLEAN_FLAGS.has(name)) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** A path relative to here when it is under here, else absolute. */
function shown(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel.startsWith('..') ? path : rel;
}

const BOOLEAN_FLAGS = new Set(['allow-deletions', 'skip-preflight', 'github', 'help']);

function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function requireDate(args: Args, name: string): string {
  const value = flag(args, name);
  if (value === undefined) {
    throw new Error(`--${name} <yyyy-mm-dd> is required`);
  }
  parseDateKey(value);
  return value;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writePrivate(path: string, content: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readLocked(): LockedIssues {
  return existsSync(LOCKED_FILE)
    ? (JSON.parse(readFileSync(LOCKED_FILE, 'utf8')) as LockedIssues)
    : {};
}

function recordLocked(issueKey: string, reason: string): void {
  const locked = readLocked();
  locked[issueKey] = {
    reason,
    detectedAt: new Date().toISOString(),
    source: 'refused by Jira during apply',
  };
  writePrivate(LOCKED_FILE, JSON.stringify(locked, null, 2) + '\n');
}

async function connect(): Promise<{ client: JiraRestClient; site: string }> {
  const config = readConfig(STATE_DIR);
  const credentials = await jiraCredentials(config);
  secrets.push(credentials.apiToken, btoa(`${credentials.email}:${credentials.apiToken}`));
  return {
    client: new JiraRestClient({
      baseUrl: credentials.host,
      email: credentials.email,
      apiToken: credentials.apiToken,
    }),
    site: credentials.host,
  };
}

function rangeWindow(from: string, to: string, timeZone: string) {
  return {
    startMs: dayWindow(from, timeZone).start,
    endMs: dayWindow(to, timeZone).end,
    // JQL dates are in the profile zone; a day either side, then `started` makes the exact cut.
    fromDate: addDaysToKey(from, -1),
    toDate: addDaysToKey(to, 1),
  };
}

const PREFLIGHT_PERMISSIONS = [
  'WORK_ON_ISSUES',
  'EDIT_OWN_WORKLOGS',
  'DELETE_OWN_WORKLOGS',
  'EDIT_ISSUES',
];

/** Issues that look like they would refuse changes: missing permissions or a non-editable status. */
async function preflight(client: JiraRestClient, issueKeys: string[]): Promise<LockedIssues> {
  const found: LockedIssues = {};
  for (const key of issueKeys) {
    try {
      const permissions = await client.myPermissions(key, PREFLIGHT_PERMISSIONS);
      const missing = ['WORK_ON_ISSUES', 'EDIT_OWN_WORKLOGS', 'DELETE_OWN_WORKLOGS'].filter(
        (p) => !permissions[p],
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

async function commandPlan(args: Args): Promise<number> {
  const file = args.positional[0];
  if (file === undefined) {
    throw new Error('Usage: plan <corrections.json> [--out plan.json]');
  }
  const spec = parseCorrections(JSON.parse(readFileSync(file, 'utf8')));
  const { client, site } = await connect();
  const me = await client.myself();
  if (spec.timeZone !== undefined && spec.timeZone !== me.timeZone) {
    throw new Error(
      `The corrections file is in ${spec.timeZone} but your Jira profile is in ${me.timeZone}. ` +
        'Days would be read differently from how Jira shows them; fix one before planning.',
    );
  }
  const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (machineZone !== me.timeZone) {
    console.error(
      `Note: this machine is in ${machineZone}; days are read in your Jira profile's zone, ${me.timeZone}.`,
    );
  }
  const range = correctionsRange(spec);
  const keys = [
    ...new Set(
      spec.days.flatMap((day) =>
        day.changes.flatMap((change) =>
          change.kind === 'set' ? [change.issueKey] : [change.fromIssueKey, change.toIssueKey],
        ),
      ),
    ),
    ...spec.commentRewrites.map((rewrite) => rewrite.issueKey),
  ];
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
    ...readLocked(),
    ...(args.flags.has('skip-preflight') ? {} : await preflight(client, [...new Set(keys)])),
  };
  const plan = buildPlan(spec, worklogs, {
    accountId: me.accountId,
    timeZone: me.timeZone,
    site,
    lockedIssues,
  });
  const out =
    flag(args, 'out') ??
    join(STATE_DIR, 'plans', `${basename(file).replace(/\.json$/, '')}-${plan.planId}.json`);
  writePrivate(out, JSON.stringify(plan, null, 2) + '\n');
  const markdown = renderPlan(plan, { planPath: shown(out) });
  writePrivate(out.replace(/\.json$/, '.md'), markdown + '\n');
  console.log(markdown);
  console.error(`\nPlan saved to ${shown(out)} (and .md). Nothing was changed in Jira.`);
  return plan.days.some((day) => day.status === 'blocked') ? 3 : 0;
}

function readPlan(path: string | undefined): Plan {
  if (path === undefined) {
    throw new Error('Give the plan file, e.g. .timesheets/plans/<name>-<planId>.json');
  }
  const plan = JSON.parse(readFileSync(path, 'utf8')) as Plan;
  if (plan.version !== 1 || typeof plan.planId !== 'string' || !Array.isArray(plan.days)) {
    throw new Error(`${path} is not a plan made by "plan"`);
  }
  return plan;
}

async function connectFor(plan: Plan): Promise<JiraRestClient> {
  const { client, site } = await connect();
  const me = await client.myself();
  if (site !== plan.site || me.accountId !== plan.accountId) {
    throw new Error('This plan was made for a different Jira site or account.');
  }
  if (me.timeZone !== plan.timeZone) {
    throw new Error(
      `Your Jira profile is now in ${me.timeZone}, but the plan was made in ${plan.timeZone}. Plan again.`,
    );
  }
  return client;
}

async function commandApply(args: Args): Promise<number> {
  const plan = readPlan(args.positional[0]);
  const approve = flag(args, 'approve');
  if (approve === undefined) {
    throw new Error(
      `Review the dry run, then approve it: apply <plan.json> --approve ${plan.planId}`,
    );
  }
  const client = await connectFor(plan);
  const logFile = join(STATE_DIR, 'logs', `${plan.planId}.jsonl`);
  const result = await applyPlan(
    plan,
    {
      client,
      backup: async (snapshot) => {
        const path = join(
          STATE_DIR,
          'backups',
          plan.planId,
          `${snapshot.takenAt.replace(/[:.]/g, '-')}.json`,
        );
        writePrivate(path, JSON.stringify(snapshot, null, 2) + '\n');
        return shown(path);
      },
      log: (entry: ApplyLogEntry) => {
        ensureDir(dirname(logFile));
        appendFileSync(
          logFile,
          JSON.stringify({ ...entry, detail: redact(entry.detail, secrets) }) + '\n',
          {
            mode: 0o600,
          },
        );
      },
      lockedIssue: recordLocked,
    },
    { approvedPlanId: approve, allowDeletions: args.flags.has('allow-deletions') },
  );
  console.log(renderApply(result));
  if (result.status !== 'refused') {
    console.error(`Log: ${shown(logFile)}`);
  }
  // The changes that couldn't be made, readable on their own, rewritten on each run.
  const notMadeFile = join(STATE_DIR, 'logs', `${plan.planId}-not-changed.md`);
  if (result.failures.length > 0) {
    writePrivate(
      notMadeFile,
      [
        `# Not changed: ${plan.name}`,
        '',
        `Plan ${plan.planId}, run ${new Date().toISOString()}`,
        '',
        ...renderNotMade(result),
      ].join('\n') + '\n',
    );
    console.error(`Couldn't be changed: ${shown(notMadeFile)}`);
  } else if (existsSync(notMadeFile)) {
    writePrivate(
      notMadeFile,
      `# Not changed: ${plan.name}\n\nEverything was changed on the latest run.\n`,
    );
  }
  return { done: 0, partial: 4, stopped: 1, refused: 2 }[result.status];
}

/** From the apply log: the changes whose latest attempt wasn't made, with why. */
function notMadeFromLog(planId: string): Map<string, string> {
  const logFile = join(STATE_DIR, 'logs', `${planId}.jsonl`);
  const latest = new Map<string, ApplyLogEntry>();
  if (existsSync(logFile)) {
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      const entry = JSON.parse(line) as ApplyLogEntry;
      if (entry.opId !== undefined && entry.opId !== '') {
        latest.set(entry.opId, entry);
      }
    }
  }
  return new Map(
    [...latest]
      .filter(([, entry]) => !['applied', 'already-applied'].includes(entry.outcome))
      .map(([opId, entry]) => [opId, entry.detail]),
  );
}

async function commandVerify(args: Args): Promise<number> {
  const plan = readPlan(args.positional[0]);
  const client = await connectFor(plan);
  const dates = plan.days.map((day) => day.date).sort();
  const keys = [
    ...new Set(
      plan.days.flatMap((day) => [
        ...day.ops.map((op) => op.issueKey),
        ...day.before.worklogs.map((w) => w.issueKey),
      ]),
    ),
  ];
  const { worklogs } = await client.ownWorklogs(
    plan.accountId,
    plan.timeZone,
    rangeWindow(dates[0], dates[dates.length - 1], plan.timeZone),
    keys,
  );
  const result = verifyPlan(plan, worklogs, notMadeFromLog(plan.planId));
  console.log(renderVerify(result));
  return result.ok ? 0 : 1;
}

async function fetchRange(from: string, to: string) {
  const { client } = await connect();
  const me = await client.myself();
  const { worklogs } = await client.ownWorklogs(
    me.accountId,
    me.timeZone,
    rangeWindow(from, to, me.timeZone),
  );
  return {
    client,
    me,
    worklogs: worklogs.filter((worklog) => worklog.date >= from && worklog.date <= to),
  };
}

async function commandReport(args: Args): Promise<number> {
  const from = requireDate(args, 'from');
  const to = requireDate(args, 'to');
  const format = flag(args, 'format') ?? 'md';
  if (format !== 'md' && format !== 'csv') {
    throw new Error('--format must be md or csv');
  }
  const { worklogs } = await fetchRange(from, to);
  const weeks = weeklyReport(worklogs, from, to);
  const text = format === 'csv' ? reportCsv(weeks) : reportMarkdown(weeks) + '\n';
  const out = flag(args, 'out');
  if (out === undefined) {
    process.stdout.write(text);
  } else {
    writePrivate(out, text);
    console.error(`Report saved to ${out}`);
  }
  return 0;
}

async function commandValidate(args: Args): Promise<number> {
  const from = requireDate(args, 'from');
  const to = requireDate(args, 'to');
  const hours = Number(flag(args, 'hours') ?? 7.5);
  const leave = (flag(args, 'leave') ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  const { me, worklogs } = await fetchRange(from, to);
  let mergedAt = new Map<string, { mergedAtMs: number; url: string }>();
  if (args.flags.has('github')) {
    const token = githubToken();
    if (token === undefined) {
      throw new Error('--github needs GITHUB_TOKEN or a Keychain item "jira-timesheets-github".');
    }
    secrets.push(token);
    const config = readConfig(STATE_DIR);
    mergedAt = await fetchMergeTimes(
      worklogs.map((worklog) => worklog.issueKey).filter((key) => !leave.includes(key)),
      {
        token,
        apiUrl: config.githubApiUrl ?? 'https://api.github.com',
        orgs: config.githubOrgs ?? [],
      },
    );
  } else {
    console.error('Skipping the "logged after merge" check; add --github to run it.');
  }
  const findings = validateWorklogs(worklogs, {
    from,
    to,
    timeZone: me.timeZone,
    expectedDaySeconds: Math.round(hours * 3600),
    leaveIssueKeys: leave,
    lockedIssues: readLocked(),
    mergedAt,
  });
  console.log(renderFindings(findings, `Validation ${from} to ${to}`).join('\n'));
  return findings.length === 0 ? 0 : 3;
}

function commandLocked(args: Args): number {
  const locked = readLocked();
  const remove = flag(args, 'remove');
  if (remove !== undefined) {
    delete locked[remove];
    writePrivate(LOCKED_FILE, JSON.stringify(locked, null, 2) + '\n');
    console.log(`Removed ${remove}.`);
    return 0;
  }
  const entries = Object.entries(locked);
  console.log(
    entries.length === 0
      ? 'No issues recorded as locked.'
      : entries
          .map(
            ([key, item]) =>
              `${key}: ${item.reason} (${item.source}${item.detectedAt ? `, ${item.detectedAt}` : ''})`,
          )
          .join('\n'),
  );
  return 0;
}

const USAGE = `npm run timesheets -- <command>

  plan <corrections.json> [--out plan.json] [--skip-preflight]   read-only dry run
  apply <plan.json> --approve <planId> [--allow-deletions]       back up, then change Jira
  verify <plan.json>                                              check Jira matches the plan
  report --from <date> --to <date> [--format md|csv] [--out f]    weeks by ticket and day
  validate --from <date> --to <date> [--leave LEAVE-1] [--hours 7.5] [--github]
  locked [--remove <KEY>]                                         issues known to refuse changes`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'plan':
      return commandPlan(args);
    case 'apply':
      return commandApply(args);
    case 'verify':
      return commandVerify(args);
    case 'report':
      return commandReport(args);
    case 'validate':
      return commandValidate(args);
    case 'locked':
      return commandLocked(args);
    default:
      console.log(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message =
      error instanceof JiraError || error instanceof Error ? error.message : String(error);
    console.error(`Error: ${redact(message, secrets)}`);
    process.exitCode = 1;
  },
);
