// Where the command line gets its Jira (and optional GitHub) credentials. The site and email are
// not secret and live in .timesheets/config.json or JIRA_HOST / JIRA_EMAIL. The API token is read,
// in order, from JIRA_API_TOKEN, the macOS Keychain (service "jira-timesheets"), or a prompt that
// doesn't echo. It is never written to disk, printed or logged.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEYCHAIN_SERVICE = 'jira-timesheets';
const GITHUB_KEYCHAIN_SERVICE = 'jira-timesheets-github';
/** Same rule as the dev-server relay: Jira Cloud, or a local mock. */
const ALLOWED_SITE =
  /^(?:https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/i;

export interface CliConfig {
  host?: string;
  email?: string;
  githubApiUrl?: string;
  githubOrgs?: string[];
}

export interface JiraCredentials {
  host: string;
  email: string;
  apiToken: string;
}

export function readConfig(stateDir: string): CliConfig {
  const path = join(stateDir, 'config.json');
  if (!existsSync(path)) {
    return {};
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if ('apiToken' in raw || 'token' in raw) {
    throw new Error(
      `${path} must not hold a token. Remove it and use the Keychain or JIRA_API_TOKEN.`,
    );
  }
  return raw as CliConfig;
}

function siteOrigin(host: string): string {
  const trimmed = host.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  return url.origin;
}

function keychain(service: string, account: string | undefined): string | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }
  try {
    const args = [
      'find-generic-password',
      '-s',
      service,
      ...(account ? ['-a', account] : []),
      '-w',
    ];
    const value = execFileSync('security', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return value.replace(/\r?\n$/, '') || undefined;
  } catch {
    return undefined;
  }
}

/** The account the Keychain item was saved under, when no email is configured. */
function keychainAccount(service: string): string | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', service], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return /"acct"<blob>="([^"]*)"/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

/** Asks for a secret on the terminal without echoing it. */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error(
        'No Jira API token. Set JIRA_API_TOKEN, add it to the Keychain, or run in a terminal to be asked.',
      ),
    );
  }
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

export async function jiraCredentials(config: CliConfig): Promise<JiraCredentials> {
  const hostSetting = process.env['JIRA_HOST'] ?? config.host;
  if (hostSetting === undefined || hostSetting.trim() === '') {
    throw new Error(
      'No Jira site. Set JIRA_HOST (e.g. https://your-site.atlassian.net) or "host" in .timesheets/config.json.',
    );
  }
  const host = siteOrigin(hostSetting);
  if (!ALLOWED_SITE.test(host)) {
    throw new Error(
      `Refusing to send credentials to ${host}: only https://<site>.atlassian.net or a local mock.`,
    );
  }
  const email = process.env['JIRA_EMAIL'] ?? config.email ?? keychainAccount(KEYCHAIN_SERVICE);
  if (email === undefined || email.trim() === '') {
    throw new Error('No Atlassian email. Set JIRA_EMAIL or "email" in .timesheets/config.json.');
  }
  const apiToken =
    process.env['JIRA_API_TOKEN'] ??
    keychain(KEYCHAIN_SERVICE, email) ??
    (await promptHidden(`Jira API token for ${email} (not shown): `));
  if (apiToken === '') {
    throw new Error('Empty Jira API token');
  }
  return { host, email: email.trim(), apiToken };
}

export function githubToken(): string | undefined {
  return process.env['GITHUB_TOKEN'] ?? keychain(GITHUB_KEYCHAIN_SERVICE, undefined);
}
