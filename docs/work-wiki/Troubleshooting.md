# Troubleshooting Seek Work

| Symptom | What to check |
| --- | --- |
| `/work` is missing after an update | Run the [Work plugin installer](https://github.com/thejoelrobinson/seek-stack/wiki/Getting-Started) from the repository folder, restart the web harness, and refresh the page. |
| Task is queued | Another Work task or developer session may be using the shared model or browser. Open **Tasks** and **Needs you** to see whether something is waiting for you. |
| Task stopped for a question or approval | Open **Needs you** and answer the specific card. A chat message does not answer a pending tool approval. |
| Browser is waiting at login or verification | Open **Browser**, choose **Take over**, complete the step yourself, and choose **Resume agent**. |
| Receipt has `needs_review` | Check the order's displayed items, quantities, discounts, delivery groups, and total. The batch excludes unverified orders from its subtotal. |
| File is not in **Files** | Ask the task to save the output in its workspace and register it as a deliverable. |
| Scheduled work did not start at the chosen time | Keep the PC awake and the harness running. Overdue work starts when the harness comes back; check **Upcoming** and **Tasks**. |
| Finance shows no real accounts | Check the Plaid environment. `sandbox` cannot link a real bank. Link each institution to Seek, then refresh. |
| Images says the runner is offline | Run the command shown in **Images** on the host PC. Check Python 3.10+, GPU capacity, and `~/.dsh/image-engine/runner.err`. Then choose **Check again**. |
| Image generation says the model is busy | Let the current Work task or reply finish, then retry. The language and image models share the GPU. |
| Remote site shows a sign-in page repeatedly | Check that browser cookies are allowed for your Seek hostname. The proxy uses a signed session cookie. |
| Remote site returns 502 | The tunnel is reachable but the local stack is down. Run `start-seek.ps1` and consult `~/.dsh/autostart.log`. |

For stack setup, model, tunnel, and search issues, use the repository's [main troubleshooting guide](https://github.com/thejoelrobinson/seek-stack/blob/main/docs/TROUBLESHOOTING.md). For Work task state, local data lives under `~/.dsh/work/`; browser batch files live under `~/.dsh/browser/`.
