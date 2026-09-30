# Tasks and conversations

## Choose a mode

Select **New conversation**, write what you want, and use the mode selector beside the composer:

- **Do the task** creates a persistent goal. Seek works through successive turns, reports activity, and stops when it has a result or needs you. Use this for research, file creation, browsing, or a multi-step job.
- **Just chat** gives a normal conversation without persistent goal continuation. Use it for questions or brainstorming.

Replies within a conversation update that task. Start a new conversation for independent work. Attach source files before sending if the task needs them. A goal has a limit of 32 continuation rounds; ask for a narrower follow-up if it reaches that limit.

## Follow or control work

Open the conversation for messages and activity, **Tasks** for the queue, and **Needs you** for pending questions or approvals. The character's panel also has **Approvals**, **Activity**, and **Upcoming** tabs. Seek can keep working after you close the page as long as the PC and harness stay on.

Use **Pause** to hold a task, **Resume** to continue it, or **Stop** to end it. A task may pause to ask a question, request a tool approval, or hand you the browser. Answer the actual card in **Needs you**; putting an approval in chat does not replace the pending control. Browser **Take over** pauses agent browser actions until you select **Resume agent**.

Only one Work task runs at once. Other Work tasks wait in the queue when the shared model or browser is busy, including when a normal developer session is running.

## Make requests easy to verify

State the outcome, where to look, and what counts as complete. For example:

> Read the three attached invoices, make a CSV with vendor, date, and total, flag any unclear values, and give me the CSV in Files.

For a website task, name the site and scope. Seek should verify what the page actually says and flag missing or uncertain data. For purchases, sends, deletions, and other hard-to-undo actions, expect a separate approval step.

## After a restart

Work restores saved conversations and interrupted tasks. A user-paused task stays paused. Native approvals that expired must be requested again. A long chat may resume in a fresh underlying model session while its visible Work conversation persists; a goal-backed task needs manual resume before a fresh context can repeat external actions.

Related: [Files and schedules](https://github.com/thejoelrobinson/seek-stack/wiki/Files-and-Schedules) · [Browser and receipts](https://github.com/thejoelrobinson/seek-stack/wiki/Browser-and-Receipts)
