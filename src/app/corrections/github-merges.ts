// When each issue's linked pull requests last merged, from GitHub's search API, so validation can
// flag time logged on an issue after its work merged. Read-only; needs a token with read access.

export interface MergeOptions {
  token: string;
  /** REST API base, e.g. https://api.github.com. */
  apiUrl: string;
  /** Only search these organisations; all you can see when empty. */
  orgs: string[];
  fetch?: typeof fetch;
}

interface SearchItem {
  title?: string;
  body?: string | null;
  html_url?: string;
  pull_request?: { merged_at?: string | null };
}

/** The latest merge time of a merged pull request naming each issue key, where there is one. */
export async function fetchMergeTimes(
  issueKeys: string[],
  options: MergeOptions,
): Promise<Map<string, { mergedAtMs: number; url: string }>> {
  const fetchImpl = options.fetch ?? fetch;
  const result = new Map<string, { mergedAtMs: number; url: string }>();
  const base = options.apiUrl.replace(/\/+$/, '');
  // One search per issue, one at a time: the search API allows 30 requests a minute.
  for (const key of [...new Set(issueKeys)].sort()) {
    const query = [
      `"${key}"`,
      'is:pr',
      'is:merged',
      ...options.orgs.map((org) => `org:${org}`),
    ].join(' ');
    const url = `${base}/search/issues?q=${encodeURIComponent(query)}&per_page=30`;
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub search for ${key} failed with ${response.status}`);
    }
    const page = (await response.json()) as { items?: SearchItem[] };
    const pattern = new RegExp(`\\b${key.replace(/[-]/g, '\\-')}\\b`, 'i');
    for (const item of page.items ?? []) {
      const mergedAt = item.pull_request?.merged_at;
      if (
        typeof mergedAt !== 'string' ||
        !pattern.test(`${item.title ?? ''}\n${item.body ?? ''}`)
      ) {
        continue;
      }
      const mergedAtMs = Date.parse(mergedAt);
      const current = result.get(key);
      if (current === undefined || mergedAtMs > current.mergedAtMs) {
        result.set(key, { mergedAtMs, url: item.html_url ?? '' });
      }
    }
  }
  return result;
}
