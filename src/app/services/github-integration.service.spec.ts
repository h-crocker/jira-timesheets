import type * as http from 'node:http';
import { TestBed } from '@angular/core/testing';
import mockGithub from '../../../mock-github-server';
import { GithubIntegrationService } from './github-integration.service';
import { SettingsService } from './settings.service';

const { startServer, stopServer, resetMockGithub } = mockGithub;

const MONDAY = new Date(2026, 8, 28);
const NEXT_MONDAY = new Date(2026, 9, 5);

describe('GithubIntegrationService', () => {
  let server: http.Server;
  let apiUrl: string;

  beforeAll(async () => {
    server = await startServer(0);
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('mock server has no address');
    }
    apiUrl = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    await stopServer(server);
  });

  beforeEach(() => {
    localStorage.clear();
    resetMockGithub();
  });

  function service(orgs: string[] = []): GithubIntegrationService {
    const settings = TestBed.inject(SettingsService);
    settings.setGithubCredentials({ token: 'token', apiUrl });
    settings.updateSettings({ githubOrgs: orgs });
    return TestBed.inject(GithubIntegrationService);
  }

  const describePulls = (
    pulls: Awaited<ReturnType<GithubIntegrationService['fetchMyPullRequestActivity']>>,
  ) =>
    Object.fromEntries(
      pulls.map((pull) => [
        `${pull.repo}#${pull.number}`,
        pull.actions.map((action) => `${action.kind} ${action.at.toISOString()}`),
      ]),
    );

  it("finds what you did on pull requests during the week, and nothing of anyone else's", async () => {
    const pulls = await service().fetchMyPullRequestActivity(MONDAY, NEXT_MONDAY);
    const found = describePulls(pulls);

    expect(Object.keys(found).sort()).toEqual([
      'acme/api#41',
      'acme/tools#7',
      'acme/web#52',
      'personal/dotfiles#3',
    ]);
    expect(found['acme/api#41']).toEqual([
      'pr-opened 2026-09-28T10:00:00.000Z',
      'commit 2026-09-28T11:00:00.000Z',
      'commit 2026-09-28T14:00:00.000Z',
      'commit 2026-09-29T10:30:00.000Z',
      'commit 2026-10-01T09:30:00.000Z',
      'pr-merged 2026-10-01T15:00:00.000Z',
    ]);
    expect(found['acme/web#52']).toEqual([
      'comment 2026-09-29T08:35:00.000Z',
      'review 2026-09-29T08:40:00.000Z',
    ]);
    const api = pulls.find((pull) => pull.number === 41)!;
    expect(api).toMatchObject({
      title: 'GWP-2070 Add rate limiting',
      branch: 'feature/gwp-2070-rate-limit',
      url: 'https://github.com/acme/api/pull/41',
    });
    expect(api.body).toContain('/browse/GWP-2070');
  });

  it('leaves out pull requests you only commented on', async () => {
    const pulls = await service().fetchMyPullRequestActivity(MONDAY, NEXT_MONDAY);
    expect(pulls.map((pull) => `${pull.repo}#${pull.number}`)).not.toContain('acme/web#60');
  });

  it('counts a review with no verdict as commenting', async () => {
    const realFetch = globalThis.fetch;
    // devuser's approval on acme/web#52, turned into a review left only as comments.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      if (!String(input).includes('/pulls/52/reviews')) {
        return response;
      }
      const reviews = (await response.json()) as Array<{ state: string }>;
      return new Response(
        JSON.stringify(reviews.map((review) => ({ ...review, state: 'COMMENTED' }))),
        { headers: response.headers },
      );
    });
    try {
      const pulls = await service().fetchMyPullRequestActivity(MONDAY, NEXT_MONDAY);
      expect(pulls.map((pull) => `${pull.repo}#${pull.number}`)).not.toContain('acme/web#52');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps your own pull request even when you only commented on it that week', async () => {
    const pulls = await service().fetchMyPullRequestActivity(
      new Date(2026, 8, 30, 13, 15),
      new Date(2026, 8, 30, 14),
    );
    expect(Object.keys(describePulls(pulls))).toEqual(['acme/tools#7']);
    expect(pulls[0].actions.map((action) => action.kind)).toEqual(['comment']);
  });

  it('leaves out actions outside the week', async () => {
    const pulls = await service().fetchMyPullRequestActivity(
      new Date(2026, 8, 30),
      new Date(2026, 9, 1),
    );
    expect(Object.keys(describePulls(pulls))).toEqual(['acme/tools#7']);
  });

  it('keeps to the organisations in settings', async () => {
    const pulls = await service(['acme']).fetchMyPullRequestActivity(MONDAY, NEXT_MONDAY);
    expect(pulls.map((pull) => pull.repo)).not.toContain('personal/dotfiles');
  });

  it('follows pagination and sends the token', async () => {
    const realFetch = globalThis.fetch;
    const requests: Array<{ url: string; auth: string | null }> = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      requests.push({
        url: String(input),
        auth: new Headers(init?.headers).get('Authorization'),
      });
      return realFetch(input, init);
    });
    try {
      await service().fetchMyPullRequestActivity(MONDAY, NEXT_MONDAY);
    } finally {
      spy.mockRestore();
    }
    expect(requests.every((request) => request.auth === 'Bearer token')).toBe(true);
    expect(requests.some((request) => request.url.includes('/search/issues'))).toBe(true);
  });

  it('reports GitHub errors with their message', async () => {
    TestBed.inject(SettingsService).setGithubCredentials({
      token: 'token',
      apiUrl: `${apiUrl}/nope`,
    });
    await expect(
      TestBed.inject(GithubIntegrationService).fetchMyPullRequestActivity(MONDAY, NEXT_MONDAY),
    ).rejects.toThrow('GitHub request failed: 404 Not Found');
  });
});
