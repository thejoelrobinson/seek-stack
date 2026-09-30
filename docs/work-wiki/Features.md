# Work features

| Area | What it does | Setup or limit |
| --- | --- | --- |
| **Conversations** | Talk to Seek, hand off an outcome, attach files, and return to previous conversations. | **Do the task** persists through model turns; **Just chat** is conversational. |
| **Tasks** | Shows queued, running, paused, completed, and attention-needed work with progress and controls. | One Work task runs at a time because the model and browser are shared. |
| **Needs you** | Collects questions, approvals, and browser handoffs. | You decide whether to approve a pending action. |
| **Browser** | Streams a persistent Chrome profile that you and the agent can take turns controlling. | Sign-ins and human checks require your hands. |
| **Files** | Collects verified deliverables from task workspaces. | Up to five input files per new task, 8 MB each. |
| **Schedules** | Starts a task once, daily, or weekly. | The computer and harness must be running; missed work starts when they return. |
| **Images** | Generates local images with Qwen Image 2.1 and keeps a gallery. | Separate model and Python setup; one image at a time. |
| **Finance** | Shows Plaid-linked balances, transactions, budgets, holdings, and read-only agent summaries. | You supply Plaid credentials and link each institution. |
| **Connections** | Shows available app integrations, including optional Pipedream Connect and Discord. | Each external service needs its own credentials and consent. |
| **Ideas** | Suggests tasks based on past requests and saved preferences. | Review an idea before choosing **Do it**. |
| **Memory & preferences** | Stores editable preferences and reviews notes proposed by nightly reflection. | Preferences and conflicts need your review. |
| **Identity & access** | Changes the character's color and accessory; manages partner access, optional Bitwarden sign-in, site sessions, and device notifications. | Vault unlock is local-only; saved login fills and sensitive clicks still ask for approval. |

The animated character and agent panel show status, activity, approvals, upcoming work, and identity controls. **Developer view** returns to the underlying DeepSeek Harness UI. See [Identity and access](https://github.com/thejoelrobinson/seek-stack/wiki/Identity-and-Access) to customize the character and manage sign-ins.

Work runs on the configured local model and harness tools. Browser pages, model output, and third-party integrations can still be incomplete or require a decision from you. See the [task guide](https://github.com/thejoelrobinson/seek-stack/wiki/Tasks-and-Conversations) for the normal workflow.
