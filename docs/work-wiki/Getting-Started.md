# Getting started with Seek Work

## Install

Follow the repository's [install guide](https://github.com/thejoelrobinson/seek-stack#install). On Windows, extract the repository and double-click `install.cmd`. The installer deploys Work and the browser plugin with the rest of the harness.

If the harness is already installed and you only need to update the Work plugins, run this from the repository folder in PowerShell, then restart the web harness:

```powershell
powershell -ExecutionPolicy Bypass -File .\dsh\plugins\browser-viewer\install.ps1
```

The browser plugin needs Chrome and Node 22 or newer. The optional Images model has a [separate setup](https://github.com/thejoelrobinson/seek-stack/wiki/Images).

## Open the workspace

1. Start seek-stack and open `http://127.0.0.1:3080/work` on the host PC.
2. If you use the configured remote tunnel, open its Work URL and sign in through the Seek proxy. The tunnel must point to the authenticated proxy on port `18799`, not directly to port `3080`.
3. Choose **New conversation** and describe an outcome. Leave **Do the task** selected for a persistent task, or choose **Just chat** for a normal conversation.
4. Watch progress in the conversation or **Tasks**. When **Needs you** shows a question, approval, or browser handoff, respond there.

The computer must stay awake and the harness must keep running for background and scheduled work. Closing the browser tab does not stop an active task.

### Shared remote access

When the remote proxy is configured, the owner can visit `/family` on the same Seek hostname to create, rotate, or remove a partner login. A partner opens the same shared workspace and can see its chats, files, finance, connections, and browser sessions. Use a unique password and share it directly with that person, not in a Work conversation. Changing or removing the partner login invalidates the previous partner session.

## First task to try

> Find three useful references on a topic I choose. Save a short Markdown summary with links, and tell me what you verified.

The **Files** view lists output files that the task registers as deliverables. A task may ask for access or more detail before continuing; the app does not grant approvals automatically.

Next: [Tasks and conversations](https://github.com/thejoelrobinson/seek-stack/wiki/Tasks-and-Conversations) · [Browser and receipts](https://github.com/thejoelrobinson/seek-stack/wiki/Browser-and-Receipts)
