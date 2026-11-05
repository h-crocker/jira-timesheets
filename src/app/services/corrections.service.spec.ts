import type * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { TestBed } from '@angular/core/testing';
import mockServer from '../../../mock-jira-server';
import { CorrectionsService, DOWNLOAD_FILE } from './corrections.service';
import { SettingsService } from './settings.service';

const { startServer, stopServer, resetMockJira, lockIssue, writes } = mockServer;
const EXAMPLE = readFileSync('corrections/example.json', 'utf8');
const TOKEN = 'saved-browser-token-123';

describe('CorrectionsService', () => {
  let server: http.Server;
  let host: string;
  let downloads: { name: string; content: string }[];

  beforeAll(async () => {
    server = await startServer(0);
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('mock server has no address');
    }
    host = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    await stopServer(server);
  });

  beforeEach(() => {
    localStorage.clear();
    resetMockJira('corrections-example');
    downloads = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DOWNLOAD_FILE,
          useValue: (name: string, content: string) => {
            // The backup is saved before Jira is changed.
            if (name.includes('backup')) {
              expect(writes()).toEqual([]);
            }
            downloads.push({ name, content });
          },
        },
      ],
    });
  });

  function service(): CorrectionsService {
    TestBed.inject(SettingsService).setCredentials({
      email: 'dev@example.com',
      apiToken: TOKEN,
      host,
    });
    return TestBed.inject(CorrectionsService);
  }

  it('checks the pasted file and keeps it as a draft', () => {
    const corrections = service();
    corrections.setDraft('{ "days": [ { "date": "2026-02-30" } ] }');
    expect(corrections.parsed()).toEqual({ error: expect.stringContaining('not a real date') });
    corrections.setDraft(EXAMPLE);
    expect(corrections.parsed()).toEqual({
      spec: expect.objectContaining({ name: 'Example corrections' }),
    });
    expect(TestBed.inject(CorrectionsService).draft()).toBe(EXAMPLE);
    expect(corrections.target()).toBe(`${host} as dev@example.com`);
  });

  it('previews with the saved credentials, changing nothing', async () => {
    const corrections = service();
    corrections.setDraft(EXAMPLE);
    await corrections.preview();
    expect(corrections.status()).toEqual({ kind: 'idle' });
    const plan = corrections.plan();
    expect(plan?.timeZone).toBe('Europe/London');
    expect(plan?.days.filter((day) => day.status === 'ready')).toHaveLength(14);
    expect(writes()).toEqual([]);
  });

  it('applies only with the deletions approved, backing up first, then verifies', async () => {
    const corrections = service();
    corrections.setDraft(EXAMPLE);
    await corrections.preview();

    await corrections.apply(false);
    expect(corrections.result()?.status).toBe('refused');
    expect(corrections.status()).toEqual({
      kind: 'error',
      message: expect.stringContaining('deletes'),
    });
    expect(writes()).toEqual([]);

    await corrections.apply(true);
    expect(corrections.result()?.status).toBe('done');
    expect(corrections.verify()?.ok).toBe(true);
    expect(corrections.status()).toEqual({ kind: 'idle' });
    expect(downloads.map((file) => file.name)).toEqual([
      expect.stringMatching(/^jira-timesheets-backup-[0-9a-f]+-.*\.json$/),
    ]);
    expect(JSON.parse(downloads[0].content).days).toHaveLength(14);
    for (const write of writes()) {
      expect(write.query['adjustEstimate']).toBe('leave');
      expect(write.query['notifyUsers']).toBe('false');
    }

    corrections.downloadLog();
    expect(downloads[1].name).toMatch(/^jira-timesheets-log-/);
    expect(downloads.map((file) => file.content).join()).not.toContain(TOKEN);
  });

  it('adds the sick leave and lists what Jira refused, and warns about the ticket next time', async () => {
    const corrections = service();
    corrections.setDraft(EXAMPLE);
    await corrections.preview();
    lockIssue('APP-176', 'period');
    await corrections.apply(true);
    const result = corrections.result();
    expect(result?.status).toBe('partial');
    expect(result?.failures.map((failure) => failure.action)).toEqual([
      expect.stringContaining('delete APP-176'),
      expect.stringContaining('delete APP-176'),
      expect.stringContaining('delete APP-176'),
    ]);
    expect(corrections.verify()?.ok).toBe(true);

    await corrections.preview();
    const warned = corrections
      .plan()
      ?.days.filter((day) => day.warnings.join().includes('APP-176'));
    expect(warned?.length).toBeGreaterThan(0);
  });

  it('reports a problem instead of applying when the credentials changed since the dry run', async () => {
    const corrections = service();
    corrections.setDraft(EXAMPLE);
    await corrections.preview();
    TestBed.inject(SettingsService).setCredentials({
      email: 'dev@example.com',
      apiToken: TOKEN,
      host: 'https://other.atlassian.net',
    });
    await corrections.apply(true);
    expect(corrections.status()).toEqual({
      kind: 'error',
      message: expect.stringContaining('Preview again'),
    });
    expect(writes()).toEqual([]);
  });
});
