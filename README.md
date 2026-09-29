# Jira Timesheets

Zoneless Angular 22 app that fills a week of Jira worklogs, then syncs it to Jira (or to local mock
servers). It can fill the week from what you actually did, from your GitHub pull requests and the worklogs
Jira adds automatically, or from recurring schedules and percentage allocations.

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
in `localStorage` and are only sent to Jira; use *Clear credentials* to go back to the mock.

For each week shown, the app loads **your own** worklogs from any issue (found by searching for
`worklogAuthor = currentUser()`), plus the issues named in your settings. Colleagues' worklogs on shared
issues are never shown, counted or deleted.

To try the sync without touching real timesheets, use a free Atlassian Cloud developer site
(<https://go.atlassian.com/cloud-dev>) rather than your company's Jira.

If requests fail, the `npm start` terminal shows the relay's error. A 401 means Jira rejected the email or
token. Behind a TLS-inspecting corporate proxy, start the app with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

## Filling the week from your activity

Tick **Fill my week from activity** in the **Activity** section of the settings panel. The app then works
out what you worked on each day from:

- **GitHub**: pull requests you opened, committed to or reviewed (approved or requested changes) that
  week. Your comments on those add to them, but a pull request you only commented on doesn't count;
- **Jira**: the worklogs Jira added for you automatically, e.g. when an issue moved to Done.

Each working day (your hours, less recurring meetings and leave) is split into 15-minute blocks and shared
between the issues with evidence that day, weighted by how much you did on each. Allocations still take
their percentage of each day. Quiet days between two days on the same issue count as work on it; other
days with no evidence follow the week as a whole. Days after today are left alone.

The automatic worklogs are **replaced**: the plan deletes them (shown struck through in the preview) and
logs the planned worklogs instead. Before deleting them, the sync saves a copy in a Jira user property on
your account (`jira-timesheets.replaced.<Monday's date>`), so they still count as evidence later and
syncing twice changes nothing. Anything else the app didn't create is treated the same way, except leave.

**Jira keys** come from the pull request title (a leading key first), then Jira links and keys in the
description, then the branch name. Keys are checked against Jira. A pull request with no valid key goes to
the **placeholder ticket**, your generic work ticket, which also fills a week with no evidence at all.

**Leave**: set the **leave ticket**. Leave logged on it by hand is never touched, and meetings that clash
with it are not logged. Tick **On leave** on a day in the preview to fill that day with leave when you
sync; untick it to remove the leave the app logged.

**GitHub**: in the **GitHub** section, enter a
[fine-grained token](https://github.com/settings/personal-access-tokens) with read-only access to *Pull
requests* and *Metadata* on the repositories you work in (authorised for SSO if your organisation enforces
it). Leave the API URL empty for github.com, or use your GitHub Enterprise Server's `https://host/api/v3`.
To use the mock, enter any token and `http://localhost:3001`. Optionally limit the search to some
organisations. Without a token, only Jira's automatic worklogs are used.

## Test / build

```bash
npm test -- --watch=false
npm run build
```

## Architecture

- `TimesheetEngineService`: pure function from settings, existing worklogs and evidence to an execution
  plan (creations, deletions, and the worklogs to remember before deleting). In allocation mode, recurring
  events win over clashing worklogs, leave wins over both, and allocations fill the rest. Activity mode is
  in `activity-distribution.ts` and leave, used by both, in `leave-planner.ts`. Either way, a second sync
  changes nothing.
- `SettingsService` / `JiraIntegrationService`: `localStorage` persistence and the `jira.js` client, routed
  through the dev-server relay in the running app. Every worklog the app creates carries a
  `jira-timesheets` worklog property, so it can tell its own worklogs from ones logged by hand or added
  automatically by Jira.
- `GithubIntegrationService` / `ActivityService` / `activity-mapping.ts`: read your pull request activity
  from the GitHub REST API, find each pull request's Jira keys, check them against Jira and turn the
  activity into evidence.
- Display components (`week-selector`, `settings-panel`, `calendar-grid`, `activity-panel`) use only
  signal inputs and outputs, with no dependency injection. `App` is the single smart component.
- `mock-jira-server.ts` mirrors Jira Cloud where the app depends on it: v3 comments in Atlassian Document
  Format, account IDs, Jira's `started` date format, per-user worklogs, worklog properties (returned only
  with `expand=properties`), user properties, bulk issue fetch, the JQL the app sends, and no CORS
  headers. Its tests check its responses against `jira.js`'s own schemas.
- `mock-github-server.ts` serves the GitHub endpoints the app reads, with Link-header pagination and CORS
  headers like GitHub's.
