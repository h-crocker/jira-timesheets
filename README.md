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

The relay calls Jira as a server-side client: it sends its own user agent instead of the browser's, and
drops the browser's origin, cookies and `Sec-Fetch-*`/`Sec-CH-UA*` headers. Jira Cloud refuses writes that
look like they came from a browser with 403 "XSRF check failed", even with `X-Atlassian-Token: no-check`.

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
token. A 403 "XSRF check failed" when syncing means Jira saw a browser's request: restart `npm start`, as
the dev server only reads `proxy.conf.mjs` when it starts. Behind a TLS-inspecting corporate proxy, start the app with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

## How the week is filled

Each working day starts at **Start time** and has **Hours per day** of work, with a **Lunch** break (an
hour by default) after the first half: 7.5 hours from 09:00 is 09:00–12:45 and 13:45–17:30. Lunch isn't
counted in the hours; set it to 0 for no break. Anything logged on a day counts toward its hours, even over
lunch or after hours, so a day never adds up to more than its hours.

Recurring meetings and leave go in first, and your allocations share out the rest. A schedule can repeat
**every week**, **every other week** (from the week of a date you pick, the week on show by default) or
**monthly**, on the 1st, 2nd, 3rd, 4th or last of its ticked weekdays each month. Where two recurring events
overlap on a day, only one is logged: the longer, or of equally long ones the one further down the
**Schedules** list. The other neither appears nor takes any of the day's hours, so the allocations get the
time instead.

Allocations are logged in blocks, one after another in the order of the **Allocations** list, so the week
reads as one task followed by the next. Allocations on tickets that start with one of the prefixes in
**Scatter tickets starting with** (`MT` by default; several are separated by commas, and the match ignores
case) are instead scattered through the week, 15 to 30 minutes at a time, so a support ticket turns up a
little every day. The scattering is random but fixed for the week, so the preview and the sync agree and
syncing twice changes nothing. Time left unallocated is left empty at the end of each morning and afternoon.
To change an allocation's percentage, edit the number next to it in the **Allocations** section.

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
ones; other weeks are unaffected. While a week has its own allocations, adding, editing or removing one in the
section edits that week's list, and **Use my usual allocations** goes back.

A week with its own allocations **replaces** Jira's automatic worklogs: the plan deletes them (shown struck
through in the preview) and allocations fill the whole week. Before deleting them, the sync saves a copy in
a Jira user property on your account (`jira-timesheets.replaced.<Monday's date>`), so pressing the button
again later still counts them. Anything else you logged that isn't leave or a recurring meeting is treated
the same way. Weeks using your usual allocations keep the worklogs you or Jira logged as they are.

In every week, the app's own worklogs follow your allocations: change them, even after the week has been
synced, and the preview shows the worklogs being moved at once (the old ones struck through), so it always
shows what the sync will do. Syncing twice changes nothing. Allocations adding up to more than 100% share
the week in proportion (adding 20% to a week filled to 100% gives it 20 parts in 120), and ones adding up to
less leave the rest of each morning and afternoon empty; the **Allocations** section says which.

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

**Copy timesheet**: copies the week on show to the clipboard as a table, one row per issue with the hours
for each day and totals, as logged in Jira now; changes you have not synced yet are left out. It pastes as
a formatted table into Outlook,
Teams, Word, Excel or Confluence, and as a Markdown table into plain-text editors.

## Correcting past worklogs

For one-off fixes to weeks already logged (adding sick leave, moving time between tickets,
rewording comments), press **Corrections** in the header. Paste a corrections file (see below) and
press **Preview corrections**: this only reads Jira, using the credentials saved in the **Jira**
settings, and shows the dry run, day by day: each worklog that would be edited, created or deleted,
the hours before and after, and anything blocked or worth checking. If the dry run deletes
worklogs, tick that you approve them; then **Apply** downloads a backup of every worklog on those
days, makes the changes, and checks Jira against the plan. Changes Jira refuses are listed (and can
be downloaded with **Download log**); the rest still go ahead. Run it with `npm start`, like the rest
of the app. The pasted file is kept in this browser's storage between visits.

### From the command line

The same corrections can be run from a terminal. It talks to Jira directly from Node, so it needs
no dev server, but it needs the API token again:

```bash
npm run timesheets -- plan corrections/my-fixes.json             # read-only dry run
npm run timesheets -- apply <plan.json> --approve <planId> --allow-deletions
npm run timesheets -- verify <plan.json>
npm run timesheets -- report --from 2026-06-01 --to 2026-06-30 --format csv --out june.csv
npm run timesheets -- validate --from 2026-06-01 --to 2026-06-30 --leave LEAVE-1 [--github]
npm run timesheets -- locked                                       # tickets found to refuse changes
```

**Credentials.** Set `JIRA_HOST` (e.g. `https://your-site.atlassian.net`) and `JIRA_EMAIL`, or put
`host` and `email` in `.timesheets/config.json`. The API token comes from `JIRA_API_TOKEN`, the macOS
Keychain (`security add-generic-password -s jira-timesheets -a <email> -w`, which asks for it without
echoing), or a hidden prompt. The token is never written to disk, printed or logged, and is only sent
to `*.atlassian.net` or a local mock. To try it against the mock, run
`MOCK_SCENARIO=corrections-example npm run mock-server` (a made-up timesheet that
`corrections/example.json` applies to) with `JIRA_HOST=http://localhost:3000 JIRA_EMAIL=dev@example.com
JIRA_API_TOKEN=any`.

**The corrections file** (see `corrections/example.json`; your own files in `corrections/` are
git-ignored, as they describe your time off) lists, per day, each ticket's hours
before and after (`set`) or time to move between tickets (`move`), plus protected worklogs (e.g.
annual leave, by date or comment), tickets known to be locked, comment rewrites and totals to check. `sickLeave` names the
sick-leave ticket: on each day it changes, sick leave becomes one uninterrupted worklog at the end
of the day, fitted round the work once that has been cut. It ends when the day's last worklog used to
end, or starts when the remaining work ends if that would overlap it. Sick leave split over several
worklogs is merged into one (the extras are deleted once the one kept holds all the time).
Hours are quarter hours. Dates are days in your Jira profile's time zone, which is what Jira shows.

**`plan`** reads your worklogs and shows, for every day, each worklog it would edit, create or
delete, and the day's hours before and after. It changes nothing. The table is applied as written: a
day that wouldn't come to the expected hours, or a ticket that looks locked (no worklog permission, or
a non-editable workflow status), is flagged under **Check before approving** but still planned. Time
is never padded. A day is only **blocked**, and never applied, if Jira's hours on a ticket differ
from the file's "from" (the table no longer describes it), it touches a protected worklog, or it
changes a ticket the file lists as locked. When a ticket has several worklogs on a day, more time
extends the latest one, less time shrinks from the latest back (deleting any it empties), and new
worklogs start where the time they replace was freed. Plans are saved in `.timesheets/plans/`.

**`apply`** needs the plan id, and `--allow-deletions` when the plan deletes anything. It backs up
every worklog on the affected days (raw JSON from Jira) to `.timesheets/backups/` first, and edits
worklogs in place. Work worklogs keep their start times (`started` isn't sent); only sick leave is
moved, always on the same day. Every write sends
`adjustEstimate=leave` and `notifyUsers=false`. Every change is either made or recorded: if Jira
refuses to shorten or delete a worklog (a locked ticket, a closed period), or the worklog changed
since the plan, that is written to `.timesheets/logs/<planId>-not-changed.md` and the rest of the day
still goes ahead, so sick leave is added even if the day then comes to more than its hours. A move
creates the new worklog before shortening the old one, so a refusal never loses time. A sick-leave
worklog isn't added if one appeared on that ticket and day since the plan. Only failures that aren't
about one change (bad credentials, Jira unavailable, the network) stop the run. Running it again is
safe and retries what was refused: edits already made and deletions already done are skipped, and
new worklogs carry a `jira-timesheets.correction` property so they're never created twice. Refusals
that read like a lock (or are a 403) are recorded in `.timesheets/locked-issues.json`, and later
plans warn about the ticket. Exit codes: 0 done, 4 finished with changes not made, 1 stopped,
2 refused.

**`verify`** fetches the worklogs again and checks every day, every changed worklog and the plan's
totals, reporting changes the apply log says weren't made separately from anything unexpected.
**`report`** prints each week by ticket and day as Markdown or CSV. **`validate`** flags days over or
under the expected hours, work on leave days, time on locked tickets and, with `--github`
(`GITHUB_TOKEN` or a Keychain item `jira-timesheets-github`), time logged after an issue's pull
request merged.

`.timesheets/` is git-ignored: it holds your worklogs.

## Test / build

```bash
npm test -- --watch=false
npm run build
```

## Architecture

- `TimesheetEngineService`: pure function from settings and existing worklogs to an execution plan
  (creations, deletions, and the worklogs to remember before deleting). Recurring events (`schedule-time.ts`
  works out which weeks a fortnightly or monthly schedule falls in, and keeps the longest of any that
  overlap) win over clashing worklogs, leave (`leave-planner.ts`) wins over both, and allocations fill the
  rest in 15-minute blocks (any block left over by rounding goes to the largest allocation, so 100% fills
  every free block, and over 100% is shared in proportion). Unallocated blocks are taken from the end of each
  session, the mornings and afternoons either side of lunch, in Webster order so every session gives up its
  part. Scattered allocations (`spreadPrefixes`) then each pick one block at random, seeded from the week,
  in each equal part of what is left, and the other allocations take the remaining blocks in turn. The app's
  own worklogs are re-planned whenever the settings no longer produce them. A week with its own allocations
  replaces the automatic worklogs too. Either way, a second sync changes nothing.
- `activity-allocations.ts`: pure functions from a week's evidence to its allocations.
- `timesheet-table.ts`: pure function from the week's Jira worklogs to the HTML and Markdown tables
  **Copy timesheet** puts on the clipboard.
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
  with `expand=properties`), user properties, issue lookups, the JQL the app sends, no CORS
  headers, and refusing writes sent with a browser's user agent. Its tests check its responses against
  `jira.js`'s own schemas, and `proxy.conf.spec.ts` checks what the relay sends Jira.
- `src/app/corrections/`: the correction planner, applier, verifier, validation and report, as
  plain TypeScript with no Angular or Node dependency. `CorrectionsService` and the Corrections view
  (`corrections-page`, loaded only when opened, and the display-only `corrections-panel`) run them
  in the app through the relay; `cli/timesheets.ts` runs them from a terminal. Days are worked out in the Jira profile's time zone (`time-zone.ts`), not the
  machine's.
- `mock-github-server.ts` serves the GitHub endpoints the app reads, with Link-header pagination and CORS
  headers like GitHub's.
