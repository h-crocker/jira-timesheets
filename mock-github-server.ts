import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const http = require('node:http') as typeof import('node:http');

// A stand-in for the slice of the GitHub REST API the app reads: the signed-in user, pull request
// search, and a pull request's commits, reviews and comments. Responses follow GitHub's shapes and
// paginate with Link headers.
//
// Unlike Jira Cloud, GitHub sends CORS headers, so the app calls it directly; so does the mock.

interface Action {
  id: number;
  user: string;
  at: string;
}

interface Commit {
  sha: string;
  author: string;
  date: string;
}

interface Review extends Action {
  state: 'APPROVED' | 'COMMENTED' | 'CHANGES_REQUESTED' | 'PENDING';
}

interface Pull {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  branch: string;
  author: string;
  created: string;
  updated: string;
  merged: string | null;
  commits: Commit[];
  reviews: Review[];
  reviewComments: Action[];
  comments: Action[];
}

const DEFAULT_PORT = 3001;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const DEV_LOGIN = 'devuser';
const COLLEAGUE_LOGIN = 'colleague';

let pulls: Pull[] = [];
let activeServer: Server | null = null;

function seed(): Pull[] {
  return [
    {
      owner: 'acme',
      repo: 'api',
      number: 41,
      title: 'GWP-2070 Add rate limiting',
      body: 'Jira: https://example.atlassian.net/browse/GWP-2070\n\nFollows on from GWP-1999.',
      branch: 'feature/gwp-2070-rate-limit',
      author: DEV_LOGIN,
      created: '2026-09-28T10:00:00Z',
      updated: '2026-10-01T15:00:00Z',
      merged: '2026-10-01T15:00:00Z',
      commits: [
        { sha: 'a41c0001', author: DEV_LOGIN, date: '2026-09-28T11:00:00Z' },
        { sha: 'a41c0002', author: DEV_LOGIN, date: '2026-09-28T14:00:00Z' },
        { sha: 'a41c0003', author: DEV_LOGIN, date: '2026-09-29T10:30:00Z' },
        { sha: 'a41c0004', author: COLLEAGUE_LOGIN, date: '2026-09-30T12:00:00Z' },
        { sha: 'a41c0005', author: DEV_LOGIN, date: '2026-10-01T09:30:00Z' },
      ],
      reviews: [{ id: 4101, user: COLLEAGUE_LOGIN, at: '2026-10-01T14:00:00Z', state: 'APPROVED' }],
      reviewComments: [],
      comments: [],
    },
    {
      owner: 'acme',
      repo: 'web',
      number: 52,
      title: 'GWP-2080: fix login for SSO users',
      body: 'Fixes the redirect loop.',
      branch: 'fix/sso-login',
      author: COLLEAGUE_LOGIN,
      created: '2026-09-25T09:00:00Z',
      updated: '2026-09-29T09:00:00Z',
      merged: null,
      commits: [{ sha: 'b52c0001', author: COLLEAGUE_LOGIN, date: '2026-09-25T09:00:00Z' }],
      reviews: [{ id: 5201, user: DEV_LOGIN, at: '2026-09-29T08:40:00Z', state: 'COMMENTED' }],
      reviewComments: [{ id: 5202, user: DEV_LOGIN, at: '2026-09-29T08:35:00Z' }],
      comments: [],
    },
    {
      owner: 'acme',
      repo: 'tools',
      number: 7,
      title: 'Tidy CI config',
      body: 'No ticket for this one.',
      branch: 'chore/ci-tidy',
      author: DEV_LOGIN,
      created: '2026-09-30T13:00:00Z',
      updated: '2026-09-30T13:30:00Z',
      merged: null,
      commits: [{ sha: 'c7c00001', author: DEV_LOGIN, date: '2026-09-30T13:00:00Z' }],
      reviews: [],
      reviewComments: [],
      comments: [{ id: 701, user: DEV_LOGIN, at: '2026-09-30T13:30:00Z' }],
    },
    {
      owner: 'personal',
      repo: 'dotfiles',
      number: 3,
      title: 'Update shell aliases',
      body: '',
      branch: 'aliases',
      author: DEV_LOGIN,
      created: '2026-09-28T19:00:00Z',
      updated: '2026-09-28T19:00:00Z',
      merged: null,
      commits: [{ sha: 'd3c00001', author: DEV_LOGIN, date: '2026-09-28T19:00:00Z' }],
      reviews: [],
      reviewComments: [],
      comments: [],
    },
    {
      owner: 'acme',
      repo: 'api',
      number: 12,
      title: 'GWP-1500 Old work',
      body: '',
      branch: 'feature/gwp-1500',
      author: DEV_LOGIN,
      created: '2026-09-14T10:00:00Z',
      updated: '2026-09-15T10:00:00Z',
      merged: '2026-09-15T10:00:00Z',
      commits: [{ sha: 'e12c0001', author: DEV_LOGIN, date: '2026-09-14T10:00:00Z' }],
      reviews: [],
      reviewComments: [],
      comments: [],
    },
  ];
}

function resetMockGithub(): void {
  pulls = seed();
}

function user(base: string, login: string): object {
  return {
    login,
    id: login === DEV_LOGIN ? 1001 : 1002,
    type: 'User',
    url: `${base}/users/${login}`,
    html_url: `https://github.com/${login}`,
  };
}

function pullUrls(base: string, pull: Pull) {
  return {
    url: `${base}/repos/${pull.owner}/${pull.repo}/pulls/${pull.number}`,
    html_url: `https://github.com/${pull.owner}/${pull.repo}/pull/${pull.number}`,
    repository_url: `${base}/repos/${pull.owner}/${pull.repo}`,
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Link, X-RateLimit-Remaining',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendPage(
  res: ServerResponse,
  url: URL,
  items: unknown[],
  wrap?: (page: unknown[]) => unknown,
) {
  const perPage = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(url.searchParams.get('per_page')) || DEFAULT_PAGE_SIZE),
  );
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const link = (target: number) => {
    const next = new URL(url);
    next.searchParams.set('page', String(target));
    return next.toString();
  };
  const links = [
    ...(page < lastPage ? [`<${link(page + 1)}>; rel="next"`] : []),
    `<${link(lastPage)}>; rel="last"`,
  ];
  send(res, 200, wrap ? wrap(slice) : slice, { Link: links.join(', ') });
}

// The search qualifiers the app sends. Repeated org: qualifiers are alternatives, as on GitHub.
function parseSearch(q: string): ((pull: Pull) => boolean) | null {
  const predicates: Array<(pull: Pull) => boolean> = [];
  const orgs: string[] = [];
  let isPr = false;
  for (const term of q.trim().split(/\s+/)) {
    const [qualifier, value = ''] = term.split(/:(.*)/s);
    if (term === 'is:pr') {
      isPr = true;
    } else if (qualifier === 'author') {
      predicates.push((pull) => pull.author === value);
    } else if (qualifier === 'reviewed-by') {
      predicates.push((pull) => pull.reviews.some((review) => review.user === value));
    } else if (qualifier === 'commenter') {
      predicates.push((pull) =>
        [...pull.comments, ...pull.reviewComments].some((comment) => comment.user === value),
      );
    } else if (qualifier === 'updated' && /^>=\d{4}-\d{2}-\d{2}$/.test(value)) {
      const day = value.slice(2);
      predicates.push((pull) => pull.updated.slice(0, 10) >= day);
    } else if (qualifier === 'org') {
      orgs.push(value);
    } else {
      return null;
    }
  }
  if (!isPr) {
    return null;
  }
  if (orgs.length > 0) {
    predicates.push((pull) => orgs.includes(pull.owner));
  }
  return (pull) => predicates.every((predicate) => predicate(pull));
}

function since(url: URL): (at: string) => boolean {
  const value = url.searchParams.get('since');
  return value === null ? () => true : (at) => Date.parse(at) >= Date.parse(value);
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const base = `http://${req.headers.host ?? 'localhost'}`;
  const url = new URL(req.url ?? '/', base);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Authorization, Accept, X-GitHub-Api-Version',
    });
    res.end();
    return;
  }
  if (!/^(Bearer|token) \S+$/.test(req.headers.authorization ?? '')) {
    send(res, 401, { message: 'Requires authentication', status: '401' });
    return;
  }
  if (req.method !== 'GET') {
    send(res, 404, { message: 'Not Found', status: '404' });
    return;
  }

  if (url.pathname === '/user') {
    send(res, 200, user(base, DEV_LOGIN));
    return;
  }

  if (url.pathname === '/search/issues') {
    const matches = parseSearch(url.searchParams.get('q') ?? '');
    if (matches === null) {
      send(res, 422, { message: 'Validation Failed', status: '422' });
      return;
    }
    const found = pulls
      .filter(matches)
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .map((pull) => ({
        ...pullUrls(base, pull),
        number: pull.number,
        title: pull.title,
        body: pull.body,
        user: user(base, pull.author),
        state: pull.merged === null ? 'open' : 'closed',
        created_at: pull.created,
        updated_at: pull.updated,
        pull_request: { url: pullUrls(base, pull).url, merged_at: pull.merged },
      }));
    sendPage(res, url, found, (items) => ({
      total_count: found.length,
      incomplete_results: false,
      items,
    }));
    return;
  }

  const route = url.pathname.match(
    /^\/repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)(?:\/(commits|reviews|comments))?$/,
  );
  const pull =
    route === null
      ? undefined
      : pulls.find(
          (candidate) =>
            candidate.owner === route[1] &&
            candidate.repo === route[2] &&
            candidate.number === Number(route[4]),
        );
  if (route === null || pull === undefined) {
    send(res, 404, { message: 'Not Found', status: '404' });
    return;
  }
  const [, , , kind, , part] = route;
  const after = since(url);

  if (kind === 'pulls' && part === undefined) {
    send(res, 200, {
      ...pullUrls(base, pull),
      number: pull.number,
      title: pull.title,
      body: pull.body === '' ? null : pull.body,
      user: user(base, pull.author),
      state: pull.merged === null ? 'open' : 'closed',
      created_at: pull.created,
      updated_at: pull.updated,
      merged_at: pull.merged,
      head: { ref: pull.branch, sha: pull.commits.at(-1)?.sha ?? '' },
      base: { ref: 'main' },
    });
  } else if (kind === 'pulls' && part === 'commits') {
    sendPage(
      res,
      url,
      pull.commits.map((commit) => ({
        sha: commit.sha,
        commit: {
          author: { name: commit.author, date: commit.date },
          committer: { name: commit.author, date: commit.date },
          message: `Commit ${commit.sha}`,
        },
        author: user(base, commit.author),
        committer: user(base, commit.author),
      })),
    );
  } else if (kind === 'pulls' && part === 'reviews') {
    sendPage(
      res,
      url,
      pull.reviews.map((review) => ({
        id: review.id,
        user: user(base, review.user),
        state: review.state,
        body: '',
        ...(review.state === 'PENDING' ? {} : { submitted_at: review.at }),
      })),
    );
  } else if (part === 'comments') {
    const comments = kind === 'pulls' ? pull.reviewComments : pull.comments;
    sendPage(
      res,
      url,
      comments
        .filter((comment) => after(comment.at))
        .map((comment) => ({
          id: comment.id,
          user: user(base, comment.user),
          body: 'Comment',
          created_at: comment.at,
          updated_at: comment.at,
        })),
    );
  } else {
    send(res, 404, { message: 'Not Found', status: '404' });
  }
}

function resolvePort(port?: number): number {
  if (port !== undefined) {
    return port;
  }
  const envPort = Number(process.env['GITHUB_PORT']);
  return Number.isInteger(envPort) && envPort >= 0 ? envPort : DEFAULT_PORT;
}

function startServer(port?: number): Promise<Server> {
  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch {
      send(res, 500, { message: 'Internal server error' });
    }
  });
  activeServer = server;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(resolvePort(port), () => resolve(server));
  });
}

function stopServer(server: Server = activeServer as Server): Promise<void> {
  activeServer = null;
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

resetMockGithub();

export = { startServer, stopServer, resetMockGithub, DEV_LOGIN };
