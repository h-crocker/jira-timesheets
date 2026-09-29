# Jira Timesheets

Zoneless Angular 22 app that plans a week of Jira worklogs from recurring schedules and percentage
allocations, then syncs the plan to Jira (or to a local mock Jira server).

Requires Node.js >= 22.22.3 (the Angular CLI refuses older 22.x releases).

## Run

```bash
npm install
npm run mock-server   # Jira Cloud-style mock on http://localhost:3000 (seeded with worklogs this week)
npm start             # Angular app on http://localhost:4200
```

Jira Cloud sends no CORS headers, so a web page can't call it directly. `npm start` therefore relays the
app's Jira requests through the dev server (`proxy.conf.mjs`), which forwards them to
`https://<site>.atlassian.net` or a local mock and to nothing else. Always run the app with `npm start`: a
static `ng build` served elsewhere has no relay.

By default the app talks to the mock at `http://localhost:3000`. To use real Jira, enter your Atlassian
email, an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) and your site URL
(e.g. `https://your-site.atlassian.net`) in the **Jira** section of the settings panel. Credentials are kept
in `localStorage` and are only sent to Jira; use *Clear credentials* to go back to the mock.

For each week shown, the app loads **your own** worklogs from any issue (found by searching for
`worklogAuthor = currentUser()`), plus the issues named in your schedules and allocations. Colleagues'
worklogs on shared issues are never shown, counted or deleted.

To try the sync without touching real timesheets, use a free Atlassian Cloud developer site
(<https://go.atlassian.com/cloud-dev>) rather than your company's Jira.

If requests fail, the `npm start` terminal shows the relay's error. A 401 means Jira rejected the email or
token. Behind a TLS-inspecting corporate proxy, start the app with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

## Test / build

```bash
npm test -- --watch=false
npm run build
```

## Architecture

- `TimesheetEngineService`: pure function from settings + existing worklogs to an execution plan
  (deletions + creations); recurring events win over clashing worklogs, allocations fill the rest, and a
  worklog that already records a recurring event is left alone, so syncing twice changes nothing.
- `SettingsService` / `JiraIntegrationService`: `localStorage` persistence and the `jira.js` client, routed
  through the dev-server relay in the running app. Every worklog the app creates carries a
  `jira-timesheets` worklog property, so it can tell its own worklogs from ones logged by hand or added
  automatically by Jira.
- Display components (`week-selector`, `settings-panel`, `calendar-grid`) use only signal inputs and
  outputs, with no dependency injection. `App` is the single smart component.
- `mock-jira-server.ts` mirrors Jira Cloud where the app depends on it: v3 comments in Atlassian Document
  Format, account IDs, Jira's `started` date format, per-user worklogs, worklog properties (returned only
  with `expand=properties`), the JQL the app sends, and no CORS headers. Its tests check its responses against `jira.js`'s own schemas.
