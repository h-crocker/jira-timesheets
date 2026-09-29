# Plan: fill the week from GitHub and Jira activity

## Status

All six phases are implemented. Where the code differs from the plan below:

- The organisation filter is `githubOrgs`.
- Finding a pull request's key skips keys Jira doesn't know and moves on to the next source, so a title
  starting `UTF-8 …` still finds the `GWP-1` later in it. Every key a pull request mentions is checked
  against Jira.
- In allocation mode, a worklog that clashes with leave is deleted (`overlap-with-leave`), the same way one
  that clashes with a recurring event is.
- In activity mode, worklogs on days after today are left as they are, and recurring meetings are not
  planned on those days. Leave can still be ticked on them.
- `npm run mock-server` starts both mocks (`mock-servers.ts`).
- A pull request you only commented on doesn't count: it needs to be yours, or have your commits or a
  review with a verdict (approve or request changes) that week. A review left only as inline comments
  counts as commenting.
- Keys are checked with one `GET /issue/{key}` per key (4 at a time), not `bulkFetchIssues`: Jira Cloud
  answered the bulk fetch POST from the browser with 403. If the check fails anyway, the week still
  loads and pull requests use the keys they name, with a warning. The week's user property is only read
  when the property-keys listing shows it exists, so a week never synced isn't a 404.

## Outcome

Filling in a timesheet should take a quick check and one click. Open the app and pick a week. The preview
already shows the week filled in from what you actually did:

1. **GitHub**: pull requests you opened, pushed commits to or reviewed that week.
2. **Jira**: the worklogs that Jira added under your account each time you finished a piece of work.

Each working day is split between the issues you worked on, in proportion to how much you did on each
one that day. Recurring meetings and fixed allocations stay as they are today. If you were on leave, tick
**On leave** on that day and the day is logged to the leave ticket. Then press **Sync week to Jira**.

The automatic worklogs are **replaced**: they count as evidence of what you worked on, then they are
deleted and the planned worklogs take their place. Leave you logged by hand is never touched. Syncing a
second time changes nothing.

Worked example for one day (7.5 h from 09:00, a 15-minute standup at 09:30):

| Evidence on Tuesday                                          | Issue    | Weight |
| ------------------------------------------------------------ | -------- | -----: |
| 4 commits on `acme/api#41` "GWP-2070 Add rate limiting"       | GWP-2070 |      4 |
| Review submitted on `acme/web#52` "GWP-2080: fix login"       | GWP-2080 |      3 |
| Automatic Jira worklog on GWP-2080 (1 m, "Done")              | GWP-2080 |      4 |

Free time is 7 h 15 m, or 29 blocks of 15 minutes. GWP-2070's exact share is 29 × 4/11 ≈ 10.55 blocks
and GWP-2080's is 29 × 7/11 ≈ 18.45. Rounding down gives 10 and 18, and the one block left over goes to the
larger fraction, GWP-2070. So GWP-2070 gets 11 blocks (2 h 45 m) and GWP-2080 gets 18 (4 h 30 m), which add
up to 29. GWP-2080's review came first that day, so it goes first. Result: GWP-2080 09:00–09:30 and
09:45–13:45, GWP-2070 13:45–16:30, and the 1-minute automatic worklog is deleted.

## What we build on, and what has to change

The current design fits this well: `TimesheetEngineService` is a pure function from settings and existing
worklogs to an `ExecutionPlan`, `App` is the only smart component, and the mock Jira server keeps the tests
honest. Five things in it work against the new feature:

- **Existing worklogs are kept as fixed time.** `computePlan` deletes only worklogs that clash with a
  recurring event and fills around the rest. The new mode needs to read them as evidence and replace them.
- **The app can't tell its own worklogs apart from Jira's automatic ones.** Both are under your account.
  The only link is a heuristic that matches recurring events by issue, start minute and duration. Once we
  delete worklogs we didn't create, we need a reliable way to know which ones the app created.
- **Deleting the evidence breaks idempotency.** After a sync the automatic worklogs are gone. If the next
  load can't see them, it computes a different week and churns. Whatever we delete has to be remembered.
- **Recurring events beat everything.** A worklog that clashes with a recurring event is deleted today,
  and leave would be too. Leave has to win instead: no meetings on a day off.
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
very chatty day or a commit-heavy style from swamping everything else. The durations of automatic
worklogs mean nothing, so each one counts as a fixed-weight signal whatever its length.

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
   `reviewed-by:<login>` or `commenter:<login>`. Add `org:<org>` for each organisation in the optional
   organisation filter. The search uses `updated:>=` rather than a closed date range: a PR you worked on last week but
   that someone touched yesterday still counts.
3. **What you did, with timestamps**, fetched for each candidate PR:
   - `GET /repos/{o}/{r}/pulls/{n}` returns the title, description, branch name, `created_at`,
     `merged_at` and the author.
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

Your PR titles usually start with the Jira key, and the description usually links to the issue. A new
pure module, `activity-mapping.ts`, looks for keys with `\b[A-Z][A-Z0-9_]+-\d+\b` in this order. It stops
at the first source that has any keys:

1. The PR title: a leading key (`GWP-2070 …`, `GWP-2070: …`, `[GWP-2070] …`) first, then a key anywhere
   else in the title.
2. The description: Jira links (`…/browse/GWP-2070`) first, then bare keys.
3. The branch name, upper-cased first because branches are often `feature/gwp-2070-…`.

The title comes first so that a description mentioning related tickets ("follows on from GWP-1999") can't
pull time away from the PR's own issue. If one source names several keys, the PR's weight is split evenly
between them.

Every key found is checked with `issues.bulkFetchIssues({ issueIdsOrKeys, fields: ['summary'] })`, in
batches of 100. Keys that Jira lists in `issueErrors`, such as `UTF-8`, are dropped. The same call supplies
issue summaries for the UI.

**No key.** A PR with no valid key sends its activity to the **placeholder ticket**, your generic work
ticket, set as `placeholderIssueKey` in settings. The activity panel shows which PRs went there. If no
placeholder is set, those PRs add no time and the panel says so.

### 4. Existing worklogs: sort them, learn from them, replace them

When activity mode is on, the engine puts each of your worklogs in the week into exactly one group:

| Group                   | How it's recognised                                            | What happens                                          |
| ----------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| **Leave, by hand**      | On `leaveIssueKey`, no ownership marker                         | Always kept as fixed time. Never evidence             |
| **Leave, from the app** | On `leaveIssueKey`, with the marker                             | Kept while its day is marked as leave (§5)            |
| **Generated**           | Has the `jira-timesheets` worklog property (see below)          | Kept if it matches the plan, else deleted             |
| **Recorded recurring**  | Today's heuristic: same issue, start minute and duration         | Kept (covers worklogs from before the marker existed) |
| **Automatic**           | Everything else                                                 | Becomes evidence, then deleted                        |

**Ownership marker.** Every worklog the app creates, in either mode, is created with
`properties: [{ key: 'jira-timesheets', value: { generated: true, version: 1 } }]`. Worklogs are read back
with `getIssueWorklog({ …, expand: 'properties' })`, which sets a new `JiraWorklog.generated` flag. Because
the property travels with the worklog, the marker still works in another browser and after
`localStorage` is cleared.

Generated worklogs are never counted as evidence. If they were, each sync would feed on the one before
it.

The automatic worklogs are under your account, so the existing `worklogAuthor = currentUser()` search
already finds them. The *Delete own worklogs* permission is enough to replace them.

### 5. Leave

**Settings.** `leaveIssueKey` is the Jira ticket you log leave to. Worklogs on it are never evidence, and
the app never deletes leave you logged by hand.

**Marking a day in the preview.** Each day header in the calendar gets an **On leave** toggle. Ticking it
means "fill this day's working hours with leave":

- The app plans a leave worklog for every part of the day slot (`startTime` + `hoursPerDay`) not already
  covered by leave you logged by hand. The comment is "Leave".
- No recurring meetings, allocations or activity are planned that day.
- Unticking a day removes the leave worklogs the app created on it. Leave you logged by hand stays.

**Leave you logged by hand** is kept whether or not the day is ticked. Recurring meetings that clash with
it are dropped instead of logged, and the rest of the day is filled as usual. So half a day logged by hand
leaves the other half to be filled from activity.

**Where the ticks come from.** When a week loads, a day starts ticked if it has a leave worklog the app
created. If hand-logged leave already covers the whole working day, the day shows as ticked and locked,
since the app can't remove that leave. Ticks you change before syncing are held in memory for that week.
After a sync they live in Jira as leave worklogs, so a reload shows them and a second sync changes nothing.

**Evidence on a day you didn't work.** GitHub or Jira activity dated on a leave day or at the weekend
counts toward the nearest earlier working day, or the next one if there is none earlier. That quick fix
you pushed while on leave still counts, but it doesn't bring back a working day.

Leave works the same way whether activity mode is on or off. In allocation mode, leave days are taken out
of the week's working days before allocations are shared out.

### 6. Remembering what was replaced

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

### 7. From evidence to a filled week

This logic goes in a new pure module, `activity-distribution.ts`. `TimesheetEngineService` calls it only
when `settings.activityMode` is on, so allocation mode keeps its current behaviour and its tests (apart from
leave, §5).

1. **Bucket evidence by local working day.** Days off (weekends and leave days) are handled as described
   in §5.
2. **Bridge gaps.** If an issue has evidence on Monday and Thursday, Tuesday and Wednesday get a small
   weight (1) for it. Work on a PR rarely stops and starts from one day to the next.
3. **Days with no evidence** use the whole week's weights. If the week has no evidence at all, every free
   block goes to the placeholder ticket. If no placeholder is set, the free time is left empty and the UI
   shows a warning.
4. **Never fill the future.** When planning the current week, days after `now` are left alone. `now` is a
   new engine input, so the engine stays pure.
5. **Free time each day** is the day slot minus leave you logged by hand and recurring events that don't
   clash with that leave, counted in 15-minute blocks. Days marked as leave have no free time.
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
interface WorklogCreation { /* … */ source: 'recurring' | 'allocated' | 'activity' | 'leave' }
interface CalendarEvent {
  /* … */
  source: 'jira' | 'recurring' | 'allocated' | 'activity' | 'leave';
  pendingDeletion?: boolean;
}
interface ExecutionPlan { deletions; creations; absorb: JiraWorklog[] }
interface EngineInput {
  weekStart; settings; worklogs;
  activity?: ActivityEvent[];
  absorbed?: JiraWorklog[];
  leaveDays?: number[]; // weekdays ticked as leave, 1 = Monday, same numbering as workDays
  now?: Date;
}
interface UserSettings {
  /* existing */
  activityMode: boolean;
  leaveIssueKey: string;
  placeholderIssueKey: string;
  githubOrgs: string[];
}
interface GithubCredentials { token: string; apiUrl: string } // default https://api.github.com
```

`WorklogCreation.source` also lets `App.derivedCalendarEvents` drop the second `computePlan` call it makes
today only to label recurring events.

### 8. Sync order

The rule is the same as today: if a sync fails part-way, Jira should be left with too much time, never
too little.

1. Merge `plan.absorb` into the week's user property. If this fails, stop before touching any worklog.
2. Create the new worklogs, with the ownership marker.
3. Delete the stale generated worklogs and the automatic ones.
4. Load the week again.

If step 3 fails part-way, the next load still sees the automatic worklogs that were left. They are
de-duplicated against the saved copies, so the plan picks up where the sync stopped.

### 9. UI

- **Settings panel.** A new **GitHub** section with the token, API URL and organisation filter. The token is kept
  in `localStorage` under its own key, with a *Clear* button, the same way Jira credentials are handled.
  A new **Activity** section with:
  - a **Fill my week from activity** toggle;
  - the leave ticket;
  - the placeholder ticket.
- **Calendar.**
  - An **On leave** toggle in each day header (§5).
  - `activity` and `leave` badges.
  - Worklogs about to be deleted are shown struck through instead of hidden, so you can see what will be
    replaced before you press Sync.
- **New `activity-panel` display component** (signal inputs and outputs only, like the others). It is
  read-only and shows for each detected issue:
  - the key and summary;
  - the planned hours for the week;
  - a row of evidence chips, such as PR links with counts or "2 automatic worklogs".

  It also lists the PRs that went to the placeholder ticket, and shows warnings: GitHub not configured,
  rate limited, or no placeholder set.
- **Loading.** `App` fetches GitHub activity, Jira worklogs and the week's saved copies in parallel, and
  reuses the existing `loadRequest` guard. If GitHub fails, planning still works from Jira evidence and a
  warning is shown. It doesn't block the whole page.

## Implementation phases

Each phase can ship and be tested on its own. Phase 2 is already useful without GitHub.

### Phase 1: Ownership marker (no change in behaviour)

- `domain.ts`: add `JiraWorklog.generated` and `WorklogCreation.source`.
- `jira-integration.service.ts`: create worklogs with the marker property, and read them with
  `expand: 'properties'`. `jira.js` sends a plain-text comment through API v2, which drops `properties`,
  so comments are sent as Atlassian Document Format instead.
- `timesheet-engine.service.ts`: tag each creation with its `source`. `app.ts`: drop the second
  `computePlan` call.
- `mock-jira-server.ts`: store worklog properties, accept `properties` on POST and support
  `expand=properties` on GET. Check the responses against `jira.js` schemas, as the existing mock tests do.
- Tests:
  - the marker survives a round trip through the mock;
  - worklogs created without it come back with `generated: false`;
  - every existing engine and app test still passes unchanged, apart from the added fields.

### Phase 2: Activity mode from Jira worklogs

- `settings.service.ts`: add `activityMode`, `leaveIssueKey` and `placeholderIssueKey`, with defaults.
  Invalid stored values are ignored, as `loadSettings` does now.
- `activity-distribution.ts` and engine changes:
  - sort worklogs into groups (§4), with leave you logged by hand kept and beating recurring events;
  - bucket, bridge and share (§7), using the placeholder when the week has no evidence;
  - diff, and return `plan.absorb`.
- `jira-integration.service.ts`: add `fetchReplaced(weekStart)` and `saveReplaced(weekStart, worklogs)`
  using user properties, and cache the `accountId`.
- `mock-jira-server.ts`:
  - `GET` and `PUT /rest/api/3/user/properties/{key}?accountId=`, returning 404 when the property is
    missing;
  - seed a few short automatic worklogs, e.g. 1 m with the comment "Logged on transition to Done";
  - seed a half day of leave logged by hand.
- `app.ts`: new sync order (§8). Settings fields. Struck-through deletions in the calendar.
- Engine tests:
  - automatic worklogs become evidence and are deleted;
  - generated worklogs are never evidence;
  - leave logged by hand is kept, and clashing recurring events are dropped;
  - largest-remainder blocks add up exactly to each day's free time;
  - bridging, empty days and the placeholder work as described;
  - future days are left alone;
  - allocations get their share of each day;
  - activity mode off gives exactly today's plans.
- App tests against the mock:
  - sync, then press Sync again and see **Nothing to sync**;
  - an automatic worklog that appears after a sync is replaced on the next one;
  - a failed delete doesn't lose evidence.

### Phase 3: Leave days in the preview

- `calendar-grid`: an **On leave** toggle per day, as an input and output (ticked, locked, changed).
- `app.ts`: per-week leave ticks held in memory, set up from Jira when the week loads (§5), and passed to
  the engine as `leaveDays`.
- Engine: ticked days get leave worklogs for their free slot and nothing else, the app's leave worklogs on
  unticked days are deleted, and evidence moves off days you didn't work.
- Tests:
  - ticking a day plans leave for the gaps around hand-logged leave, and nothing else that day;
  - unticking removes only the app's leave worklogs;
  - a day covered by hand-logged leave shows as locked;
  - sync, reload and sync again: the ticks come back and there is **Nothing to sync**;
  - leave works in allocation mode too.

### Phase 4: GitHub evidence

- `github-integration.service.ts` (§2) and `activity-mapping.ts` (§3).
- `jira-integration.service.ts`: `fetchIssueSummaries(keys)` via `bulkFetchIssues`.
- `settings.service.ts`: add GitHub credentials and `githubOrgs`.
- `mock-github-server.ts`, started with the Jira mock by `npm run mock-server`, on port 3001:
  - `/user`, `/search/issues`, and the pulls, commits, reviews and comments endpoints;
  - `Link` pagination and CORS headers, since GitHub sends them;
  - seed data:
    - a PR you wrote, titled `GWP-2070 Add rate limiting`, whose description links GWP-2070 and mentions
      GWP-1999;
    - a PR you reviewed, titled `GWP-2080: fix login`;
    - a PR with no key anywhere;
    - a colleague's commit on your PR, which must be ignored.
- Tests:
  - key extraction:
    - the leading title key wins over keys in the description;
    - description links win over bare keys;
    - lower-case branch names are read;
    - several keys split the weight;
    - invalid keys are dropped;
  - PRs with no key go to the placeholder, or add nothing when none is set;
  - the service against the mock: pagination, filtering to the week, actions by other people ignored;
  - app: PR activity shows up as planned `activity` worklogs.

### Phase 5: Activity panel

- The `activity-panel` component and how `App` wires it up (§9).
- Component tests in the style of `dumb-components.spec.ts`, and an app test that the panel matches the
  plan.

### Phase 6: Documentation

- `README.md`:
  - setting up a GitHub token (fine-grained, read-only access to *Pull requests* and *Metadata*,
    authorised for SSO if your org enforces it);
  - how activity mode decides what to log and what it replaces;
  - the leave and placeholder tickets.

## Decisions from your answers

- Automatic worklogs are under your account, so they can be found and deleted with the permissions you
  already have.
- Their durations are ignored. Each one is a fixed-weight signal on its day.
- Leave is logged to one ticket. Leave you logged by hand is never touched, and you can mark whole days as
  leave in the preview.
- Keys come from the PR title first, then the description, then the branch. PRs with no key go to a
  placeholder ticket set in settings.
- There is no scheduled or background sync. You open the app, check the week and press Sync.

## Remaining assumptions

1. **You use GitHub.com.** GitHub Enterprise Server works by changing the API URL, but it may need the
   dev-server relay if it doesn't send CORS headers.
2. **Allocations and activity work together.** Allocations take their percentage of each day, and activity
   fills the rest.
3. **The leave toggle marks whole days.** Half days you log by hand as today, and the app fills the rest of
   the day.

## Later

- **Undo a sync** using the copies saved in the week's user property (§6).
- **Commits pushed without a PR**, using the branch name to find the issue.
