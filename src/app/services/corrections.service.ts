import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { applyPlan, type ApplyLogEntry, type ApplyResult } from '../corrections/apply';
import { parseCorrections, type CorrectionsSpec } from '../corrections/corrections-file';
import { JiraRestClient } from '../corrections/jira-rest-client';
import { renderApply } from '../corrections/render';
import { planCorrections, verifyCorrections } from '../corrections/session';
import type { LockedIssues, Plan } from '../corrections/types';
import type { VerifyResult } from '../corrections/verify';
import { JIRA_RELAY_URL, siteOrigin } from './jira-integration.service';
import { SettingsService } from './settings.service';

const DRAFT_KEY = 'jira-timesheets:corrections:draft';
const LOCKED_KEY = 'jira-timesheets:corrections:locked';
const LOG_PREFIX = 'jira-timesheets:corrections:log:';
const BACKUP_PREFIX = 'jira-timesheets:corrections:backup:';

/** Saves a file to the browser's downloads; tests replace it. */
export const DOWNLOAD_FILE = new InjectionToken<
  (name: string, content: string, type: string) => void
>('DOWNLOAD_FILE', {
  factory: () => (name, content, type) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
});

export type CorrectionsStatus =
  | { kind: 'idle' }
  | { kind: 'previewing' }
  | { kind: 'applying'; date: string; changes: number }
  | { kind: 'verifying' }
  | { kind: 'error'; message: string };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the downloads still hold the backup and log.
  }
}

/**
 * The Corrections view: plans a pasted corrections file against your own worklogs, read through
 * the dev-server relay with the Jira credentials saved in Settings, and applies it once approved.
 * The same planner, applier and verifier as `npm run timesheets` (src/app/corrections).
 */
@Injectable({ providedIn: 'root' })
export class CorrectionsService {
  private readonly settingsService = inject(SettingsService);
  private readonly relayUrl = inject(JIRA_RELAY_URL);
  private readonly download = inject(DOWNLOAD_FILE);

  readonly draft = signal<string>(readJson<string>(DRAFT_KEY, ''));
  readonly plan = signal<Plan | null>(null);
  readonly result = signal<ApplyResult | null>(null);
  readonly verify = signal<VerifyResult | null>(null);
  readonly status = signal<CorrectionsStatus>({ kind: 'idle' });
  /** The name of the last backup downloaded. */
  readonly backupName = signal<string | null>(null);

  readonly busy = computed(() => {
    const kind = this.status().kind;
    return kind === 'previewing' || kind === 'applying' || kind === 'verifying';
  });

  /** The pasted file, checked; an error message when it isn't valid. */
  readonly parsed = computed<{ spec: CorrectionsSpec } | { error: string } | null>(() => {
    const text = this.draft().trim();
    if (text === '') {
      return null;
    }
    try {
      return { spec: parseCorrections(JSON.parse(text)) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  /** Where corrections go: your Jira site, or the local mock when no credentials are saved. */
  readonly target = computed(() => {
    const credentials = this.settingsService.credentials();
    return credentials === null
      ? 'the local mock Jira (no credentials saved)'
      : `${siteOrigin(credentials.host)} as ${credentials.email}`;
  });

  setDraft(text: string): void {
    this.draft.set(text);
    writeJson(DRAFT_KEY, text);
  }

  /** Reads Jira and makes the dry run. Changes nothing in Jira. */
  async preview(): Promise<void> {
    const parsed = this.parsed();
    if (this.busy() || parsed === null || 'error' in parsed) {
      return;
    }
    this.status.set({ kind: 'previewing' });
    this.result.set(null);
    this.verify.set(null);
    const { client, site } = this.connect();
    try {
      this.plan.set(
        await planCorrections(client, parsed.spec, {
          site,
          knownLocked: readJson<LockedIssues>(LOCKED_KEY, {}),
        }),
      );
      this.status.set({ kind: 'idle' });
    } catch (error) {
      this.plan.set(null);
      this.fail(client, 'Could not make the dry run', error);
    }
  }

  /**
   * Applies the dry run on show: downloads a backup of every worklog on the days it changes, makes
   * the changes, then checks Jira against the plan. Changes Jira refuses are listed, not retried.
   */
  async apply(allowDeletions: boolean): Promise<void> {
    const plan = this.plan();
    if (this.busy() || plan === null) {
      return;
    }
    const { client, site } = this.connect();
    if (site !== plan.site) {
      this.status.set({
        kind: 'error',
        message: 'Your Jira credentials changed since the dry run. Preview again before applying.',
      });
      return;
    }
    const logKey = LOG_PREFIX + plan.planId;
    const log = readJson<ApplyLogEntry[]>(logKey, []);
    let changes = 0;
    this.status.set({ kind: 'applying', date: plan.days[0]?.date ?? '', changes });
    try {
      const result = await applyPlan(
        plan,
        {
          client,
          backup: async (snapshot) => {
            const name = `jira-timesheets-backup-${plan.planId}-${snapshot.takenAt.replace(/[:.]/g, '-')}.json`;
            const content = JSON.stringify(snapshot, null, 2);
            // Throwing here stops the apply before anything changes.
            this.download(name, content, 'application/json');
            writeJson(BACKUP_PREFIX + plan.planId, snapshot);
            this.backupName.set(name);
            return name;
          },
          log: (entry) => {
            log.push(entry);
            writeJson(logKey, log);
            if (entry.outcome === 'applied') {
              changes++;
            }
            this.status.set({ kind: 'applying', date: entry.date, changes });
          },
          lockedIssue: (issueKey, reason) => {
            const locked = readJson<LockedIssues>(LOCKED_KEY, {});
            locked[issueKey] = {
              reason,
              detectedAt: new Date().toISOString(),
              source: 'refused by Jira during apply',
            };
            writeJson(LOCKED_KEY, locked);
          },
        },
        { approvedPlanId: plan.planId, allowDeletions },
      );
      this.result.set(result);
      if (result.status === 'refused') {
        this.status.set({ kind: 'error', message: result.message });
        return;
      }
      this.status.set({ kind: 'verifying' });
      this.verify.set(
        await verifyCorrections(
          client,
          plan,
          new Map(result.failures.map((failure) => [failure.opId, failure.reason])),
        ),
      );
      this.status.set({ kind: 'idle' });
    } catch (error) {
      this.fail(client, 'Applying stopped', error);
    }
  }

  /** The run's report and every log line, as a Markdown file. */
  downloadLog(): void {
    const plan = this.plan();
    const result = this.result();
    if (plan === null || result === null) {
      return;
    }
    const log = readJson<ApplyLogEntry[]>(LOG_PREFIX + plan.planId, []);
    this.download(
      `jira-timesheets-log-${plan.planId}.md`,
      [
        renderApply(result),
        '## Log',
        '',
        '```',
        ...log.map((entry) => JSON.stringify(entry)),
        '```',
        '',
      ].join('\n'),
      'text/markdown',
    );
  }

  /** The backup taken before the last apply, again. */
  downloadBackup(): void {
    const plan = this.plan();
    const backup = plan === null ? null : readJson<unknown>(BACKUP_PREFIX + plan.planId, null);
    if (plan !== null && backup !== null) {
      this.download(
        this.backupName() ?? `jira-timesheets-backup-${plan.planId}.json`,
        JSON.stringify(backup, null, 2),
        'application/json',
      );
    }
  }

  private connect(): { client: JiraRestClient; site: string } {
    const credentials = this.settingsService.credentials();
    const site = siteOrigin(credentials?.host);
    return {
      site,
      client: new JiraRestClient({
        baseUrl: this.relayUrl ?? site,
        email: credentials?.email ?? '',
        apiToken: credentials?.apiToken ?? '',
        headers: this.relayUrl === null ? {} : { 'X-Jira-Host': site },
        userAgent: null,
      }),
    };
  }

  private fail(client: JiraRestClient, what: string, error: unknown): void {
    const message = client.redact(error instanceof Error ? error.message : String(error));
    this.status.set({ kind: 'error', message: `${what}: ${message}` });
  }
}
