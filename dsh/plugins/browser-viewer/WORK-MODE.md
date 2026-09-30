# Work mode (0.3.0)

Open `/work` on the DeepSeek web harness, or click **Work** in the developer UI.
This is a local personal-agent workspace inspired by Meta Muse's conversational
task handoff, visible background work, goals, questions and deliverables. It uses
your existing model and harness tools; no additional provider subscription is
required.

## Hand off a task

Describe the outcome in **Do the task** mode. The server creates a workspace and
session, sets a native DSH goal and continues through successive model turns until
the model verifies completion or needs input. Closing the tab does not stop work.
Use **Just chat** for a normal conversation without persistent goal continuation.
Use **New conversation** to hand off another independent task; replies inside a
conversation update that task. Each goal is capped at 32 continuation rounds.

Tasks, progress, conversations, user responses and files are saved on disk. On
restart, interrupted tasks are reloaded and resumed; user-paused tasks remain
paused. The durable index is `~/.dsh/work/work.json`, and each task's files are in
`~/.dsh/work/tasks/<task-id>/`. The full underlying session logs remain in DSH.

One Work task runs at a time because the model and browser are shared. Tasks queue
while another task is running or waiting for user input, and while a normal harness
session is running. This prevents two agents from changing the same browser page.
**Pause**, **Resume** and **Stop** are actual backend controls. Browser **Take over**
pauses the current Work task; **Resume agent** continues it.

## Files, memory and schedules

- Attach up to five files (8 MB each) to a new task. Files are copied into its workspace.
- The model registers verified output files as deliverables. **Files** gathers them
  across tasks; downloads are restricted to registered files inside each workspace.
  HTML previews run in a sandbox without access to the app's cookies or storage.
- **Memory & preferences** stores an editable agent name and user preferences.
  Preferences are supplied to new tasks. Passwords and API keys do not belong there.
- Schedule a task for a specific time, optionally repeating daily or weekly.
  Overdue scheduled tasks start after the harness returns online. A repeated task
  schedules its next occurrence after successful completion; a failed or paused
  occurrence does not silently create more copies.
- Completion and question alerts appear in the app. Browser notifications are
  opt-in; a service worker can deliver them while the page is closed on supported
  devices, provided the host and harness are online. Push requests carry no
  message payload; the service worker fetches details from Seek after delivery.

## Model interaction

`work_progress` updates the visible activity and plan. `work_artifact` registers an
existing workspace file. `work_ask` pauses a task for missing information or a user
decision. Native harness questions and tool approvals also appear as structured
cards. Answers are returned to the actual pending request; the app never
automatically grants permissions. Resume after a restart requests expired native
approvals again.

## Finance

The Finance workspace in `/work` connects multiple Plaid Items using Plaid Link.
It shows linked account balances, estimated net worth, month-to-date cash flow,
category spend, transaction search, local monthly budgets, recurring streams,
investment holdings and available liability details. Users can ask the Work agent questions
about this data; it has read-only `finance_overview`, `finance_transactions` and
`finance_refresh` tools. It cannot move money, trade, pay bills or modify bank
accounts.

Configure Plaid from the Finance workspace on the local Windows PC. App
credentials are encrypted with Windows DPAPI for the current user. Choose the
matching Plaid environment (`sandbox`, `development`, or `production`); sandbox
credentials create a sandbox connection and cannot link a real bank. Link
returns a public token to the local Work server, which exchanges it server-side.
The access token and cached finance data are also DPAPI-protected. Credentials
and tokens are never returned to the browser or model. Each connected institution
or login is stored as its own encrypted Plaid Item. **Add bank** and **Add
investments** create new Items without replacing existing connections. **Manage
accounts** opens Plaid Link update mode with account selection for an existing
Item; the user should keep every desired account selected. Plaid's Link
Customization in the Plaid Dashboard controls the account-selection view during
initial linking, and some OAuth banks present their own selection screen. A
Plaid connection owned by another application cannot be reused directly; link
the institution to Seek as its own Plaid Item. Disconnect revokes the selected
Item with Plaid and removes its local data. Disconnect all removes all Items,
the local transaction cache and budgets.

For monthly spending questions, `finance_spending_report` computes the complete
month and category totals inside the local Finance service. It returns a bounded
summary with source dates, transaction counts, separate currencies, pending
counts, and explicit treatment of transfers and loan payments. Do not add up
`finance_transactions` tool rows: that tool is capped and may be truncated.

Long Work conversations can lose details when DSH compacts model context. The
agent can save concise verified progress with `work_checkpoint` and recover it
with `work_recall`; exact data and calculations belong in files or deterministic
tools. Chat conversations that hit the model limit restart in a fresh DSH
session under the same Work task, up to two automatic retries. The Work task
keeps its visible messages and saved checkpoint. Goal-backed tasks require a
manual resume so a fresh context cannot accidentally repeat external actions.

Work mode now exposes `work_connections`, which reports active app integrations
from live tool registrations. The Connections screen shows the same availability.
Seek uses connected API/MCP tools before driving a browser when they cover a
request. Discord's existing bot token powers read-only server, channel and
message tools through Discord's API. The bot can only see servers and channels
where it has access; message bodies also depend on Discord's Message Content
intent. Finance remains connected through Plaid's API.

Pipedream Connect adds a searchable app catalog and managed account linking.
Configure a Pipedream Connect project from Seek → Connections on this PC; its
client secret is protected with Windows DPAPI. Search the catalog and use a
Connect Link to authorize each desired app. `apps_accounts`, `apps_tools`, and
`apps_read` discover linked accounts and call bounded read actions through
Pipedream's remote MCP server with short-lived developer tokens. Seek does not
register thousands of unused tool schemas in every model prompt. Actions
identified as writes stay on the existing browser approval path. No Pipedream
project or account is connected until its credentials and consent are supplied.

Gmail/Calendar MCP is
staged in `~/.dsh/cordis.patch.yml` and remains unavailable until Google OAuth
credentials and consent are supplied; the Connections screen reports that state.

Work mode uses the harness's existing tools and permission policies. It is not a
dedicated virtual machine, an operating-system sandbox or a replacement for the
model's judgment. Website restrictions, CAPTCHAs, missing credentials and model
limitations can still block tasks. The browser has its own persistent profile;
use **Watch browser → Take over** to sign in. No email/calendar account, phone
service or payment credential is fabricated or automatically connected.

The computer must remain awake and the harness must be running. This implementation
does not provide Muse's hosted infrastructure or its proprietary model.

## Checks

- `node test/work-engine.test.mjs`: durable recovery, quick reply ordering,
  final-state reconciliation, approval replies, upload validation and file boundaries.
- `node test/work.test.mjs`: real model task with the UI closed, browser form,
  attached input, verified output download, question/answer/resume, scheduled-task
  controls, request-origin fence, desktop and mobile UI screenshots. Run against an
  isolated web harness on port 3081 (or set `DSH_TEST_ORIGIN` explicitly).
- Existing browser and harness tests cover CDP input, tabs, streaming and takeover.

Reference: [Meta's Muse design walkthrough](https://introducing.muse.ai/).
