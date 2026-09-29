# Plan: fill the week from GitHub and Jira activity

## Outcome

Open the app, pick a week, press **Sync week to Jira**. The app works out which Jira issues you worked on
that week from two sources:

1. **GitHub**: pull requests you opened, pushed commits to, reviewed or commented on that week.
2. **Jira**: the worklogs that Jira already added for you automatically each time you finished a piece of
   work.

It then fills each working day with worklogs on those issues, split in proportion to how much you did on
each one that day. Recurring meetings and fixed allocations stay as they are today. The automatic worklogs
are **replaced**: they count as evidence of what you worked on, then they are deleted and your planned
worklogs take their place. Syncing a second time changes nothing.

Worked example for one day (7.5 h from 09:00, a 15-minute standup at 09:30):

| Evidence on Tuesday                                  | Issue    | Weight |
| ---------------------------------------------------- | -------- | -----: |
| 4 commits on `acme/api#41` (branch `GWP-2070-rate-limit`) | GWP-2070 |      4 |
| Review submitted on `acme/web#52` "GWP-2080: fix login"   | GWP-2080 |      3 |
| Automatic Jira worklog on GWP-2080 (1 m, "Done")          | GWP-2080 |      4 |

Free time is 7 h 15 m, or 29 blocks of 15 minutes. GWP-2070's exact share is 29 × 4/11 ≈ 10.55 blocks
and GWP-2080's is 29 × 7/11 ≈ 18.45. Rounding down gives 10 and 18, and the one block left over goes to the
larger fraction, GWP-2070. So GWP-2070 gets 11 blocks (2 h 45 m) and GWP-2080 gets 18 (4 h 30 m), which add
up to 29. GWP-2080's review came first that day, so it goes first. Result: GWP-2080 09:00–09:30 and
09:45–13:45, GWP-2070 13:45–16:30, and the 1-minute automatic worklog is deleted.

## What we build on, and what has to change

The current design fits this well: `TimesheetEngineService` is a pure function from settings and existing
worklogs to an `ExecutionPlan`, `App` is the only smart component, and the mock Jira server keeps the tests
honest. Four things in it work against the new feature:

- **Existing worklogs are kept as fixed time.** `computePlan` deletes only worklogs that clash with a
  recurring event and fills around the rest. The new mode needs to read them as evidence and replace them.
- **The app can't tell its own worklogs apart from Jira's automatic ones.** The only link is a heuristic
  that matches recurring events by issue, start minute and duration. Once we delete worklogs we didn't
  create, we need a reliable way to know which ones the app created.
- **Deleting the evidence breaks idempotency.** After a sync the automatic worklogs are gone. If the next
  load can't see them, it computes a different week and churns. Whatever we delete has to be remembered.
- **Allocations are filled Monday-first across the week** (`remaining * percentage`, then greedy by day).
  Activity is tied to particular days, so the new mode splits each day on its own.

## Design

### 1. One evidence model

Everything that shows you worked on an issue becomes an `ActivityEvent`:

```ts
export interface ActivityEvent {
  id: string; // stable: 'gh:acme/api#41:commit:<sha>', 'jira:<worklogId>'
  issueKey: string;
  at: Date;
  kind: 'pr-opened' | 'commit' | 'review' | 'comment' | 'pr-merged' | 'jira-worklog';
  label: string; // 'acme/api#41 Add rate limiting', shown in the UI and used in worklog comments
  url?: string;
}
```

Weights are constants in the engine, so they are easy to test and tune. A cap per issue per day stops a
very chatty day or a commit-heavy style from swamping everything else.

| Signal                                      | Weight | Cap per issue per day |
| ------------------------------------------- | -----: | --------------------: |
| Automatic Jira worklog                      |      4 |                     — |
| PR opened by you                            |      3 |                     — |
| Review you submitted                        |      3 |                     6 |
| Commit you authored on the PR               |      1 |                     5 |
| Review or conversation comment              |      1 |                     3 |
| Your PR merged                              |      1 |                     — |

### 2. GitHub: which PRs, and what you did on them

A new `GithubIntegrationService` uses `fetch` directly. No new dependency is needed, and the mock is easy
to write. `api.github.com` sends CORS headers, so unlike Jira it doesn't need the dev-server relay. It
follows `Link: rel="next"` for pagination and keeps at most 4 requests in flight.

1. `GET /user` gives your login.
2. **Candidate PRs**: run three searches and merge the results by PR URL. Each search is
   `GET /search/issues?q=is:pr <who> updated:>=<weekStart − 1 day>`, where `<who>` is `author:<login>`,
   `reviewed-by:<login>` or `commenter:<login>`. Add `org:<owner>` for each owner in the optional owner
   filter. The search uses `updated:>=` rather than a closed date range: a PR you worked on last week but
   that someone touched yesterday still counts.
3. **What you did, with timestamps**, fetched for each candidate PR:
   - `GET /repos/{o}/{r}/pulls/{n}` returns the branch name (`head.ref`), `created_at`, `merged_at` and the
     author.
   - `GET …/pulls/{n}/commits` returns commits where `author.login` is you, dated by `commit.author.date`.
     The author date is used rather than the committer date because a rebase rewrites the committer date.
   - `GET …/pulls/{n}/reviews` returns your reviews, dated by `submitted_at`.
   - `GET …/pulls/{n}/comments?since=` and `GET …/issues/{n}/comments?since=` return your comments.
4. Only actions inside `[weekStart, weekStart + 7 days)` are kept, turned into local time. The engine
   already works in local days.

For about 20 PRs this is roughly 100 core requests and 3 search requests. The limits are 5,000 core
requests an hour and 30 searches a minute. Per-PR results are cached in memory, keyed by `updated_at`, so
**Reload** stays cheap. If request counts ever become a problem, one GraphQL query can replace step 3.

### 3. From a PR to a Jira issue

A new pure module, `activity-mapping.ts`, reads Jira keys with `\b[A-Z][A-Z0-9_]+-\d+\b`. It checks
sources in priority order and stops at the first one that has any keys:

1. The branch name, upper-cased first because branches are often `feature/gwp-2070-…`.
2. The PR title.
3. The PR body.

If one source names several keys, the PR's weight is split evenly between them.

- **False positives** such as `UTF-8` or `SHA-256` are removed by the optional `jiraProjectKeys` setting
  (e.g. `GWP`). They are also removed by validation: the Jira service checks every key found with
  `issues.bulkFetchIssues({ issueIdsOrKeys, fields: ['summary'] })`, in batches of 100. Keys listed in
  `issueErrors` are dropped. The same call supplies issue summaries for the UI.
- **Overrides** come from `issueOverrides: Record<string, string>` in settings, keyed by `owner/repo#41`
  for one PR or `owner/repo` for a whole repo. An override beats any key found in the PR. The UI writes
  this map (see §8).
- **PRs with no issue** are listed in the UI as unmapped. They add no time until you map them.

### 4. Existing worklogs: sort them, learn from them, replace them

When activity mode is on, the engine puts each of your worklogs in the week into exactly one group:

| Group                   | How it's recognised                                            | What happens                             |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| **Generated**           | Has the `jira-timesheets` worklog property (see below)         | Kept if it matches the plan, else deleted |
| **Recorded recurring**  | Today's heuristic: same issue, start minute and duration        | Kept (covers worklogs from before the marker existed) |
| **Protected**           | Issue is in `protectedIssueKeys` (e.g. holiday or sick leave)   | Kept as fixed time, like today           |
| **Automatic / other**   | Everything else                                                | Becomes evidence, then deleted           |

**Ownership marker.** Every worklog the app creates, in either mode, is created with
`properties: [{ key: 'jira-timesheets', value: { generated: true, version: 1 } }]`. Worklogs are read back
with `getIssueWorklog({ …, expand: 'properties' })`, which sets a new `JiraWorklog.generated` flag. Because
the property travels with the worklog, the marker still works in another browser and after
`localStorage` is cleared.

Generated worklogs are never counted as evidence. If they were, each sync would feed on the one before
it.

### 5. Remembering what was replaced

Before deleting any automatic worklog, the app saves a copy of it (id, issue, `started`, duration and
comment) in a Jira **user property** on your own account: `jira-timesheets.replaced.<yyyy-mm-dd of Monday>`.
It uses `userProperties.getUserProperty` and `setUserProperty` with your `accountId`. Setting a property on
your own user needs only ordinary Jira access. The limit is 32 KB, which is plenty for a week.

When a week loads, the evidence is made of:

- the GitHub events;
- any automatic worklogs still in Jira;
- the copies saved in that week's property, de-duplicated by worklog id.

After a sync, the second load sees the same evidence and plans the same week. The diff finds every desired
worklog already present as a generated one, and the result is **Nothing to sync**. The saved copies also
make an **Undo** possible later: re-create the originals and delete the generated worklogs.

### 6. From evidence to a filled week

This logic goes in a new pure module, `activity-distribution.ts`. `TimesheetEngineService` calls it only
when `settings.activityMode` is on, so allocation mode keeps its current behaviour and its tests.

1. **Bucket evidence by local work day.** Events at the weekend count toward the Friday before them.
2. **Bridge gaps.** If an issue has evidence on Monday and Thursday, Tuesday and Wednesday get a small
   weight (1) for it. Work on a PR rarely stops and starts from one day to the next.
3. **Days with no evidence** use the whole week's weights. If the week has no evidence at all, the day's
   free time goes to `fallbackIssueKey` if you set one. Otherwise it is left empty and the UI shows a
   warning.
4. **Never fill the future.** When planning the current week, days after `now` are left alone. `now` is a
   new engine input, so the engine stays pure.
5. **Free time each day** is the day slot (`startTime` + `hoursPerDay`) minus recurring events and
   protected worklogs, counted in 15-minute blocks.
6. **Share the blocks.** Each allocation keeps its percentage of each day, and activity weights split what
   is left. Blocks are shared out by largest remainder: take the floor of each exact share, then give the
   leftover blocks to the largest fractional parts, with ties broken by issue key. The day always adds up
   exactly, and no issue gets less than a whole block.
7. **Place the blocks.** Each issue's blocks go in one run, fitted into the free gaps with the existing
   `freeGaps` helper. Issues run in the order of their earliest evidence that day, with allocations last.
   A run that crosses a meeting is split into two worklogs.
8. **Comments** name the work, e.g. `acme/api#41 Add rate limiting; reviewed acme/web#52`, cut to 255
   characters. Comments are not part of the diff key, so rewording them never causes churn.
9. **Diff.** A desired worklog matches a generated one if the issue, start minute and duration are the
   same. Matches are kept. Generated worklogs with no match are deleted (`reason: 'stale-generated'`), and
   desired worklogs with no match are created. Automatic worklogs are deleted
   (`reason: 'replaced-by-activity'`) and returned in a new `plan.absorb` list.

Domain changes:

```ts
interface JiraWorklog { /* … */ generated: boolean }
interface WorklogCreation { /* … */ source: 'recurring' | 'allocated' | 'activity' }
interface CalendarEvent { /* … */ source: 'jira' | 'recurring' | 'allocated' | 'activity'; pendingDeletion?: boolean }
interface ExecutionPlan { deletions; creations; absorb: JiraWorklog[] }
interface EngineInput { weekStart; settings; worklogs; activity?: ActivityEvent[]; absorbed?: JiraWorklog[]; now?: Date }
interface UserSettings {
  /* existing */
  activityMode: boolean;
  protectedIssueKeys: string[];
  jiraProjectKeys: string[];
  fallbackIssueKey: string;
  githubOwners: string[];
  issueOverrides: Record<string, string>;
}
interface GithubCredentials { token: string; apiUrl: string } // default https://api.github.com
```

`WorklogCreation.source` also lets `App.derivedCalendarEvents` drop the second `computePlan` call it makes
today only to label recurring events.

### 7. Sync order

The rule is the same as today: if a sync fails part-way, Jira should be left with too much time, never
too little.

1. Merge `plan.absorb` into the week's user property. If this fails, stop before touching any worklog.
2. Create the new worklogs, with the ownership marker.
3. Delete the stale generated worklogs and the automatic ones.
4. Load the week again.

If step 3 fails part-way, the next load still sees the automatic worklogs that were left. They are
de-duplicated against the saved copies, so the plan picks up where the sync stopped.

### 8. UI

- **Settings panel.** A new **GitHub** section with the token, API URL and owner filter. The token is kept
  in `localStorage` under its own key, with a *Clear* button, the same way Jira credentials are handled.
  A new **Activity** section with:
  - a **Fill my week from activity** toggle;
  - the Jira project keys filter;
  - protected issue keys;
  - a fallback issue.
- **New `activity-panel` display component** (signal inputs and outputs only, like the others). For each
  detected issue it shows:
  - the key and summary;
  - the planned hours for the week;
  - a row of evidence chips, such as PR links with counts or "2 automatic worklogs".

  Below that it lists **Unmapped PRs**, each with an issue-key input that emits an `issueOverrides`
  change. It also shows warnings: GitHub not configured, rate limited, or keys that don't exist in Jira.
- **Calendar.** Add an `activity` badge. Show the worklogs about to be deleted struck through instead of
  hiding them, so you can see what will be replaced before you press Sync.
- **Loading.** `App` fetches GitHub activity, Jira worklogs and the week's saved copies in parallel, and
  reuses the existing `loadRequest` guard. If GitHub fails, planning still works from Jira evidence and a
  warning is shown. It doesn't block the whole page.

## Implementation phases

Each phase can ship and be tested on its own. Phase 2 is already useful without GitHub.

### Phase 1: Ownership marker (no change in behaviour)

- `domain.ts`: add `JiraWorklog.generated` and `WorklogCreation.source`.
- `jira-integration.service.ts`: create worklogs with the marker property, and read them with
  `expand: 'properties'`.
- `timesheet-engine.service.ts`: tag each creation with its `source`. `app.ts`: drop the second
  `computePlan` call.
- `mock-jira-server.ts`: store worklog properties, accept `properties` on POST and support
  `expand=properties` on GET. Check the responses against `jira.js` schemas, as the existing mock tests do.
- Tests:
  - the marker survives a round trip through the mock;
  - worklogs created by someone else come back with `generated: false`;
  - every existing engine and app test still passes unchanged, apart from the added fields.

### Phase 2: Activity mode from Jira worklogs

- `settings.service.ts`: add `activityMode`, `protectedIssueKeys` and `fallbackIssueKey`, with defaults.
  Invalid stored values are ignored, as `loadSettings` does now.
- `activity-distribution.ts` and engine changes: sort worklogs into groups (§4), bucket, bridge and share
  (§6), diff, and return `plan.absorb`.
- `jira-integration.service.ts`: add `fetchReplaced(weekStart)` and `saveReplaced(weekStart, worklogs)`
  using user properties, and cache the `accountId`.
- `mock-jira-server.ts`:
  - `GET` and `PUT /rest/api/3/user/properties/{key}?accountId=`, returning 404 when the property is
    missing;
  - seed a few short automatic worklogs, e.g. 1 m with the comment "Logged on transition to Done".
- `app.ts`: new sync order (§7). Settings toggles. Struck-through deletions in the calendar.
- Engine tests:
  - automatic worklogs become evidence and are deleted;
  - generated worklogs are never evidence;
  - protected issues are kept;
  - recurring events are still respected;
  - largest-remainder blocks add up exactly to each day's free time;
  - bridging and empty days work as described;
  - future days are left alone;
  - allocations get their share of each day;
  - activity mode off gives exactly today's plans.
- App tests against the mock:
  - sync, then press Sync again and see **Nothing to sync**;
  - an automatic worklog that appears after a sync is replaced on the next one;
  - a failed delete doesn't lose evidence.

### Phase 3: GitHub evidence

- `github-integration.service.ts` (§2) and `activity-mapping.ts` (§3).
- `jira-integration.service.ts`: `fetchIssueSummaries(keys)` via `bulkFetchIssues`.
- `settings.service.ts`: add GitHub credentials, `jiraProjectKeys`, `githubOwners` and `issueOverrides`.
- `mock-github-server.ts`, started with the Jira mock by `npm run mock-server`, on port 3001:
  - `/user`, `/search/issues`, and the pulls, commits, reviews and comments endpoints;
  - `Link` pagination and CORS headers, since GitHub sends them;
  - seed data: one PR you wrote on branch `feature/GWP-2070-…`, one you reviewed titled `GWP-2080: …`,
    one with no key, and one colleague's commit on your PR, which must be ignored.
- Tests:
  - key extraction: priority order, lower-case branches, project filter, several keys, overrides;
  - the service against the mock: pagination, filtering to the week, actions by other people ignored;
  - app: PR activity shows up as planned `activity` worklogs.

### Phase 4: Activity panel and mapping

- The `activity-panel` component and how `App` wires it up.
- Mapping an unmapped PR updates the plan straight away.
- Component tests in the style of `dumb-components.spec.ts`, and an app test for mapping a PR.

### Phase 5: Documentation

- `README.md`: setting up a GitHub token (fine-grained, read-only access to *Pull requests* and
  *Metadata*, authorised for SSO if your org enforces it), how activity mode decides and replaces, and
  what protected issues are for.

## Assumptions to confirm

These are the defaults the plan uses. Tell me if any are wrong and I'll adjust before starting.

1. **The automatic worklogs are authored by your own Jira account.** Today the app finds worklogs with
   `worklogAuthor = currentUser()` and ignores any worklog whose author isn't you. If a Jira Automation rule
   logs them as "Automation for Jira", the app won't see them at all. Deleting them would then also need
   the *Delete all worklogs* permission. The fix would be a setting that lists extra author account ids to
   treat as yours.
2. **The duration of an automatic worklog means nothing.** Each one counts as a fixed-weight signal on its
   day. If the durations are real (for example, time spent In Progress), the weight could use the duration
   instead.
3. **The only worklogs you add by hand are for things like leave.** Those issues go in
   `protectedIssueKeys`. Anything else that isn't recurring or generated gets replaced.
4. **You use GitHub.com.** GitHub Enterprise Server works by changing the API URL, but it may need the
   dev-server relay if it doesn't send CORS headers.
5. **Branch names or PR titles usually contain the Jira key.** If they don't, overrides and the fallback
   issue cover the gaps.
6. **Allocations and activity work together.** Allocations take their percentage of each day, and activity
   fills the rest.

## Later

- **Run it without opening the app.** The engine is pure and `jira.js` runs in Node, so a
  `npm run sync-week` command could run on a schedule every Friday afternoon, for example from cron or a
  scheduled GitHub Action. That removes the need to remember to do timesheets at all.
- **Undo a sync** using the copies saved in the week's user property (§5).
- **Commits pushed without a PR**, using the branch name to find the issue.
