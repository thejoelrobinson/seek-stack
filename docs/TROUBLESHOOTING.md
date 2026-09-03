# Troubleshooting

Start here: **`%USERPROFILE%\.dsh\autostart.log`**. Its last line summarises every
service, and most problems are visible in it before you look anywhere else.

```
=== done: llama(healthy)=True shim=True searxng=True adapter=True web=True proxy=False ===
```

---

## Nothing loads at all

**The UI never appears at http://127.0.0.1:3080**

`dsh web` takes 20–40 seconds to bind on a cold start — longer than feels right.
Wait a full minute before concluding anything. If it still is not up, check
`%USERPROFILE%\.dsh\web.log`.

**Everything says False in the log**

The stack is not running. Start it:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\start-seek.ps1"
```

---

## The model

**"No model available" or every message errors**

Check the summarizer shim first. `settings.yaml` points the harness at port
**18800 (the shim)**, not directly at llama-server — so if the shim is not
running, the harness has no model at all, even though llama-server is perfectly
healthy. This is the single most confusing failure in the stack.

```powershell
# Should print 18800 and 18798
Get-NetTCPConnection -State Listen -LocalPort 18800,18798 | Select-Object LocalPort
```

**llama-server looks up but does not answer**

A port check is not a health check here. `llama-server` **binds its port
immediately** and returns `503 {"Loading model"}` until the weights are on the
GPU, so a hung instance holds the port and looks fine.

```powershell
curl.exe -s -o NUL -w "%{http_code}\n" http://127.0.0.1:18798/health
```

`200` is healthy. `503` means still loading — normal for the first 60 seconds.
`503` for more than five minutes means it has hung.

There is a known boot-time hang: on the first startup after a PC restart, the
process binds the port, reads about 36 MB of the model, and then stalls forever
at 0 bytes/s with the GPU completely idle. It is most likely the NVIDIA driver
not being ready when the scheduled task fires a minute after login. The fix is a
kill and restart, which `start-seek.ps1` now does automatically once:

```powershell
Get-Process llama-server | Stop-Process -Force
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\start-seek.ps1"
```

**Out of memory / CUDA errors on startup**

The model is too big for your card. Check `A:\...\llama.cpp\qwen38-server.log.err`
for the real error, then either lower `$ContextSize` in
`%USERPROFILE%\.dsh\seek.config.ps1` or reinstall with a smaller quant:

```powershell
.\install.ps1 -Quant UD-IQ4_XS
```

Lowering the context is the cheaper fix and costs you less quality than dropping
a quant level. If you change `$ContextSize`, **you must also change
`contextWindow:` in `%USERPROFILE%\.dsh\settings.yaml` to match** — see below.

---

## It thinks forever and never answers

This model reasons before answering, and left alone it will happily spend an
entire response budget thinking and never produce an answer or a tool call.

Two settings control it, and only one of them actually binds:

- **`$ReasoningEffort`** (`low`/`medium`/`xhigh`) is only a *suggestion* injected
  into the prompt. It works on easy questions and is ignored on hard ones — the
  exact turns where it matters. Measured at `low`: a trivial question used 215
  tokens, while "design a complete Catan implementation" used 22,747.
- **`$ReasoningBudget`** is a hard cap enforced by the server. This is the one
  that works. It is set to 4096 by default.

Once the budget binds, effort stops affecting reasoning length at all: the same
prompt produced 10,712 characters of reasoning at `low` and 10,659 at `xhigh` —
a 0.5% difference, where unbudgeted they differ tenfold.

If turns are still dying, lower `$ReasoningBudget` in `seek.config.ps1` and
restart. Setting it to `0` disables thinking entirely.

> **Do not tune this with short prompts.** A quick question will make any setting
> look like a huge win and tell you nothing about real work.

---

## Conversations break after a while

**Errors about max tokens after a long chat**

The context window in `seek.config.ps1` and the one in `settings.yaml` must
agree. llama-server advertises *both* the window it actually serves and the
model's much larger training window (262144). If `settings.yaml` does not pin
`contextWindow`, the harness believes the training figure, never compacts in
time, and requests die on overflow.

```powershell
# These two numbers MUST be the same
Select-String -Path "$env:USERPROFILE\.dsh\seek.config.ps1" -Pattern 'ContextSize'
Select-String -Path "$env:USERPROFILE\.dsh\settings.yaml"   -Pattern 'contextWindow'
```

**Never add a `compaction-basic:` block to `settings.yaml.`** It is silently
ignored today, but if it ever becomes live, changing the summarizer's token cap
would stop `summarizer-shim.js` matching it — the shim identifies that one call
*by* its 8192 cap — and would silently re-enable reasoning on every compaction.

---

## Web search

**`WEB_PROVIDER_ERROR` when it tries to search**

Either the adapter or the SearXNG container is down. Everything else keeps
working when search fails.

```powershell
curl.exe -s -o NUL -w "searxng %{http_code}\n" http://127.0.0.1:18801/
docker ps --filter name=searxng
docker start searxng          # if it is stopped
```

Search activity is logged to `%USERPROFILE%\.dsh\proxy\search.log`.

---

## Remote access

**502 from your domain**

The tunnel is up but the stack is down. This is the normal symptom of a machine
that rebooted without the stack restarting. Run `start-seek.ps1`.

**401 from your domain**

**That is success.** It is the auth proxy asking you to log in.

**It asks for the password over and over**

That was a real bug and is fixed — browsers do not attach saved passwords to
WebSocket connections, so every reconnect re-prompted. The proxy now issues a
signed 30-day cookie on first login. If it still happens, your browser is
blocking cookies for the site.

**Forgot the password**

```powershell
[Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User')
[Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User')
```

To change it, set both, then restart the stack.

**"Add workspace" button is missing, or picking a folder fails with 403**

The directory picker defaults to a native Windows dialog, which opens on the
host's desktop and cannot work over a tunnel. The profile patch in
`~/.dsh/profiles/web/cordis.patch.yml` swaps it for the in-app browser. Confirm
that file is in place, and note it must insert **both** the host and client
rows — with only the host row you get the capability but no UI, and the button
silently disappears rather than erroring.

---

## Autostart

**It does not come up after a reboot**

The task runs **at logon**, not at boot, so nothing starts until someone actually
logs in. That is deliberate: a boot-triggered task would need your Windows
password stored in the task definition.

```powershell
Get-ScheduledTask -TaskName SeekHarness
(Get-ScheduledTaskInfo -TaskName SeekHarness).LastTaskResult   # 0 = success
Start-ScheduledTask -TaskName SeekHarness                      # run it now
```

---

## Installer

**"running scripts is disabled on this system"**

Use the documented invocation, which allows just this run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

**It installed Node or Docker and then told me to restart PowerShell**

Windows only exposes newly installed programs to *new* terminals. Close it, open
a fresh PowerShell, run the installer again. It picks up where it stopped.

**The download died partway**

Run the installer again. Downloads resume rather than restarting.

**Docker errors during install**

Docker Desktop must be running, not just installed. Start it from the Start menu,
wait for the whale icon to settle, then re-run. Only web search depends on it —
you can proceed without it and fix search later.
