# Files and schedules

## Attach input files

In a new conversation, use the paperclip beside the composer before sending the request. A new task accepts up to five files, 8 MB each. Work copies them into that task's workspace, so tell Seek which files matter and what output you want.

Example:

> Compare the two attached proposals. Save a Markdown table of price, scope, and exclusions, and cite the relevant page for each difference.

## Find output files

Seek registers finished workspace files as deliverables. Open **Files** to see outputs across tasks and download them. If a task says it created a file but nothing appears there, ask it to register the file as a deliverable. HTML previews are sandboxed from the app's cookies and storage.

Task state lives under `~/.dsh/work/`; individual workspaces are under `~/.dsh/work/tasks/<task-id>/`. The app's **Files** view only serves registered files inside a task workspace.

## Schedule a task

1. Start a new conversation and choose **Do the task**.
2. Write the request, then choose **Schedule** beside the composer.
3. Pick a start time and **One time**, **Every day**, or **Every week**.
4. Save the schedule and send the task. Check **Upcoming** in the agent panel or **Tasks** to follow it.

The PC and harness must be running. If the scheduled time passes while they are offline, an overdue task starts after the harness returns. A repeated task schedules its next occurrence after successful completion; a failed or paused occurrence does not silently create more copies.

Browser notifications are optional. On supported devices, a service worker can notify you even when the Work tab is closed, while the host and harness remain online. Set this up under **Memory & preferences → Notifications on this device**; see [Identity and access](https://github.com/thejoelrobinson/seek-stack/wiki/Identity-and-Access). Completion and question alerts also appear inside Work.

Related: [Tasks and conversations](https://github.com/thejoelrobinson/seek-stack/wiki/Tasks-and-Conversations) · [Troubleshooting](https://github.com/thejoelrobinson/seek-stack/wiki/Troubleshooting)
