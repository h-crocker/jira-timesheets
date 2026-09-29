# Jira Timesheets

Zoneless Angular 22 app that fills a week of Jira worklogs, then syncs it to Jira (or to local mock
servers), from recurring schedules and percentage allocations. A button sets a week's allocations from what
you actually did: your GitHub pull requests and the worklogs Jira adds automatically.

Requires Node.js >= 22.22.3 (the Angular CLI refuses older 22.x releases).

## Run

```bash
npm install
npm run mock-server   # mock Jira Cloud on http://localhost:3000 and mock GitHub on :3001, seeded this week
npm start             # Angular app on http://localhost:4200
```

Jira Cloud sends no CORS headers, so a web page can't call it directly. `npm start` therefore relays the
app's Jira requests through the dev server (`proxy.conf.mjs`), which forwards them to
`https://<site>.atlassian.net` or a local mock and to nothing else. Always run the app with `npm start`: a
static `ng build` served elsewhere has no relay. GitHub does send CORS headers, so the app calls it
directly.

By default the app talks to the mock at `http://localhost:3000`. To use real Jira, enter your Atlassian
email, an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) and your site URL
(e.g. `https://your-site.atlassian.net`) in the **Jira** section of the settings panel. Credentials are kept
in `localStorage` and are only sent to Jira; use _Clear credentials_ to go back to the mock.

For each week shown, the app loads **your own** worklogs from any issue (found by searching for
`worklogAuthor = currentUser()`), plus the issues named in your settings. Colleagues' worklogs on shared
issues are never shown, counted or deleted.

To try the sync without touching real timesheets, use a free Atlassian Cloud developer site
(<https://go.atlassian.com/cloud-dev>) rather than your company's Jira.

If requests fail, the `npm start` terminal shows the relay's error. A 401 means Jira rejected the email or
token. Behind a TLS-inspecting corporate proxy, start the app with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

## Filling allocations from your activity

In the **Allocations** section, **Fill … from activity** sets the allocations for the week on screen from
what you worked on that week:

- **GitHub**: pull requests you opened, committed to or reviewed (approved or requested changes). Your
  comments on those add to them, but a pull request you only commented on doesn't count.
- **Jira**: the worklogs Jira added for you automatically, e.g. when an issue moved to Done.

Each kind of evidence has a weight, capped per issue per day, and a quiet day between two days on the same
issue counts as a little work on it. The weights become whole percentages that add up to 100, and they fill
the **Allocations** section for that week, each with a line saying what it came from (pull requests with no
Jira key show under the placeholder ticket). The week then uses those allocations instead of your usual
ones; other weeks are unaffected. While a week has its own allocations, adding or removing one in the
section edits that week's list, and **Use my usual allocations** goes back.

A week with its own allocations **replaces** Jira's automatic worklogs: the plan deletes them (shown struck
through in the preview) and allocations fill the whole week. Before deleting them, the sync saves a copy in
a Jira user property on your account (`jira-timesheets.replaced.<Monday's date>`), so pressing the button
again later still counts them. Anything else you logged that isn't leave or a recurring meeting is treated
the same way. The app's own worklogs are re-planned if the week's allocations change, and syncing twice
changes nothing. Weeks using your usual allocations keep existing worklogs as they are.

**Jira keys** come from the pull request title (a leading key first), then Jira links and keys in the
description, then the branch name. Keys are checked against Jira. A pull request with no valid key goes to
the **placeholder ticket**, your generic work ticket, which also takes a week with no evidence at all.

**Leave**: set the **leave ticket**. Leave logged on it by hand is never touched, and meetings that clash
with it are not logged. Tick **On leave** on a day in the preview to fill that day with leave when you
sync; untick it to remove the leave the app logged.

**GitHub**: in the **GitHub** section, enter a
[fine-grained token](https://github.com/settings/personal-access-tokens) with read-only access to _Pull
requests_ and _Metadata_ on the repositories you work in (authorised for SSO if your organisation enforces
it). Leave the API URL empty for github.com, or use your GitHub Enterprise Server's `https://host/api/v3`.
To use the mock, enter any token and `http://localhost:3001`. Optionally limit the search to some
organisations. GitHub is only read when you press the button; without a token, only Jira's automatic
worklogs are used.

## Test / build

```bash
npm test -- --watch=false
npm run build
```

## Architecture

- `TimesheetEngineService`: pure function from settings and existing worklogs to an execution plan
  (creations, deletions, and the worklogs to remember before deleting). Recurring events win over clashing
  worklogs, leave (`leave-planner.ts`) wins over both, and allocations fill the rest in 15-minute blocks
  (any block left over by rounding goes to the largest allocation, so 100% fills every free block). A week with its own
  allocations replaces the automatic worklogs instead. Either way, a second sync changes nothing.
- `activity-allocations.ts`: pure functions from a week's evidence to its allocations.
- `SettingsService` / `JiraIntegrationService`: `localStorage` persistence and the `jira.js` client, routed
  through the dev-server relay in the running app. Every worklog the app creates carries a
  `jira-timesheets` worklog property, so it can tell its own worklogs from ones logged by hand or added
  automatically by Jira.
- `GithubIntegrationService` / `ActivityService` / `activity-mapping.ts`: read your pull request activity
  from the GitHub REST API, find each pull request's Jira keys, check them against Jira and turn the
  activity into evidence.
- Display components (`week-selector`, `settings-panel`, `calendar-grid`) use only
  signal inputs and outputs, with no dependency injection. `App` is the single smart component.
- `mock-jira-server.ts` mirrors Jira Cloud where the app depends on it: v3 comments in Atlassian Document
  Format, account IDs, Jira's `started` date format, per-user worklogs, worklog properties (returned only
  with `expand=properties`), user properties, issue lookups, the JQL the app sends, and no CORS
  headers. Its tests check its responses against `jira.js`'s own schemas.
- `mock-github-server.ts` serves the GitHub endpoints the app reads, with Link-header pagination and CORS
  headers like GitHub's.
