# Jira Timesheets

Zoneless Angular 22 app that plans a week of Jira worklogs from recurring schedules and percentage
allocations, then syncs the plan to Jira (or to a local mock Jira server).

Requires Node.js >= 22.22.3 (the Angular CLI refuses older 22.x releases).

## Run

```bash
npm install
npm run mock-server   # Atlassian-style mock Jira on http://localhost:3000 (seeded with GWP-2070 worklogs)
npm start             # Angular app on http://localhost:4200
```

Jira Cloud sends no CORS headers, so a web page can't call it directly. `npm start` therefore relays the
app's Jira requests through the dev server (`proxy.conf.mjs`), which forwards them to
`https://<site>.atlassian.net` or a local mock and to nothing else. Always run the app with `npm start`: a
static `ng build` served elsewhere has no relay.

By default the app talks to `http://localhost:3000`. To use real Jira, enter your Atlassian email,
API token and site URL (e.g. `https://your-site.atlassian.net`) in the **Jira** section of the settings
panel. Credentials are kept in `localStorage` only; use *Clear credentials* to go back to the mock.

If requests fail, the `npm start` terminal shows the relay's error. A 401 means Jira rejected the email or
token. Behind a TLS-inspecting corporate proxy, start the app with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

## Test / build

```bash
npm test -- --watch=false
npm run build
```

## Architecture

- `TimesheetEngineService`: pure function from settings + existing worklogs to an execution plan
  (deletions + creations); recurring events win over clashing worklogs, allocations fill the rest.
- `SettingsService` / `JiraIntegrationService`: `localStorage` persistence and the `jira.js` client.
- Display components (`week-selector`, `settings-panel`, `calendar-grid`) use only signal inputs and
  outputs, with no dependency injection. `App` is the single smart component.
