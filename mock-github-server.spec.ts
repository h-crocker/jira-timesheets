import type * as http from 'node:http';
import server from './mock-github-server';

const { startServer, stopServer, resetMockGithub } = server;
const AUTH = { Authorization: 'Bearer any-token' };

describe('mock GitHub server', () => {
  let github: http.Server;
  let base: string;

  beforeAll(async () => {
    github = await startServer(0);
    const address = github.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('Server address is not available');
    }
    base = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    await stopServer(github);
  });

  beforeEach(() => resetMockGithub());

  const get = async (path: string, headers: Record<string, string> = AUTH) => {
    const response = await fetch(path.startsWith('http') ? path : `${base}${path}`, { headers });
    return { response, body: await response.json() };
  };

  const search = (q: string, extra = '') =>
    get(`/search/issues?q=${encodeURIComponent(q)}${extra}`);

  it('requires a token, like the GitHub API for private data', async () => {
    const { response, body } = await get('/user', {});
    expect(response.status).toBe(401);
    expect(body.message).toBe('Requires authentication');
    expect((await get('/user')).body.login).toBe('devuser');
  });

  it('sends CORS headers, unlike Jira Cloud', async () => {
    const preflight = await fetch(`${base}/user`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:4200', 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const { response } = await get('/user');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-expose-headers')).toContain('Link');
  });

  it('searches pull requests by author, reviewer, commenter, update date and organisation', async () => {
    const numbers = async (q: string) =>
      (await search(q)).body.items.map(
        (item: { repository_url: string; number: number }) =>
          `${item.repository_url.replace(/^.*\/repos\//, '')}#${item.number}`,
      );
    expect(await numbers('is:pr author:devuser updated:>=2026-09-27')).toEqual([
      'acme/api#41',
      'acme/tools#7',
      'personal/dotfiles#3',
    ]);
    expect(await numbers('is:pr reviewed-by:devuser updated:>=2026-09-27')).toEqual([
      'acme/web#52',
    ]);
    expect(await numbers('is:pr commenter:devuser updated:>=2026-09-27')).toEqual([
      'acme/tools#7',
      'acme/web#52',
    ]);
    expect(await numbers('is:pr author:devuser updated:>=2026-09-27 org:acme org:other')).toEqual([
      'acme/api#41',
      'acme/tools#7',
    ]);
    expect((await search('author:devuser')).response.status).toBe(422);
  });

  it('pages with Link headers', async () => {
    const first = await search('is:pr author:devuser', '&per_page=2');
    expect(first.body.total_count).toBe(4);
    expect(first.body.items).toHaveLength(2);
    const next = first.response.headers.get('link')?.match(/<([^>]+)>; rel="next"/)?.[1];
    expect(next).toBeDefined();
    const second = await get(next!);
    expect(second.body.items).toHaveLength(2);
    expect(second.response.headers.get('link')).not.toContain('rel="next"');
  });

  it('serves a pull request with its commits, reviews and comments', async () => {
    const pull = await get('/repos/acme/api/pulls/41');
    expect(pull.body).toMatchObject({
      number: 41,
      title: 'GWP-2070 Add rate limiting',
      head: { ref: 'feature/gwp-2070-rate-limit' },
      user: { login: 'devuser' },
      merged_at: '2026-10-01T15:00:00Z',
    });
    const commits = await get('/repos/acme/api/pulls/41/commits');
    expect(
      commits.body.map((commit: { author: { login: string } }) => commit.author.login),
    ).toContain('colleague');
    expect(commits.body[0].commit.author.date).toBe('2026-09-28T11:00:00Z');

    const reviews = await get('/repos/acme/web/pulls/52/reviews');
    expect(reviews.body).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ login: 'devuser' }),
        submitted_at: '2026-09-29T08:40:00Z',
      }),
    ]);
    const since = encodeURIComponent('2026-09-30T00:00:00Z');
    expect((await get(`/repos/acme/web/pulls/52/comments?since=${since}`)).body).toEqual([]);
    expect((await get('/repos/acme/tools/issues/7/comments')).body).toHaveLength(1);
    expect((await get('/repos/acme/api/pulls/999')).response.status).toBe(404);
  });
});
