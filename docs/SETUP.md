# Setup guide

This walks you from a fresh Windows PC to a working local AI coding agent.

**What you are installing:** a coding assistant that runs entirely on your own
machine. The model runs on your GPU, web search runs in a local container, and
your code never leaves your computer. There is no API key and no monthly bill.

**Time:** about 15 minutes of clicking, plus a large download that runs in the
background. The model is 8–20 GB depending on your graphics card.

---

## 1. Check you can run it

You need an **NVIDIA graphics card**. The installer reads your VRAM and picks a
model size to match:

| Your VRAM | What you get | Honest assessment |
|---|---|---|
| 24 GB (3090, 4090, 5090) | Best quality, 64K context | The reference setup |
| 20 GB | Slightly lossier, 64K context | Very good |
| 16 GB (4080, 5080) | Half context | Good |
| 12–14 GB (3060 12GB, 4070) | Quarter context, lower quality | Usable, occasionally fumbles |
| 10–12 GB | Poor quality | Works, but frustrating |
| Under 10 GB | Installer stops you | See [HARDWARE.md](HARDWARE.md) |

You also need roughly **25 GB of free disk space** and a 64-bit Windows 10 or 11.

Do not worry about installing Node, Docker, or llama.cpp yourself — the installer
handles those.

---

## 2. Get the files

Download this repository (green **Code** button → **Download ZIP**), then unzip
it somewhere convenient like `C:\Users\you\seek-stack`.

If you have git:

```powershell
git clone https://github.com/thejoelrobinson/seek-stack.git
cd seek-stack
```

---

## 3. Run the installer

Open **PowerShell** (press Start, type PowerShell, hit Enter) and run:

```powershell
cd C:\Users\you\seek-stack
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

> **Why `-ExecutionPolicy Bypass`?** Windows blocks downloaded scripts by
> default. This allows this one script for this one run. It does not change any
> system setting.

The installer walks through twelve steps and tells you what it is doing at each
one. It will:

1. Read your GPU and pick a model size
2. Check you have enough disk space
3. Install Node.js and Docker if missing (asks first)
4. Download llama.cpp with CUDA support
5. Download the model — **this is the long one**
6. Install the DeepSeek Harness
7. Copy configuration into place
8. Write your `seek.config.ps1`
9. Start the local search container
10. Set up remote access (only if you asked for it)
11. Offer to start everything at login
12. Start it up

**If it stops partway**, just run it again. Every step checks whether it is
already done, and the model download resumes where it left off.

### If it asks you to reopen PowerShell

That happens when it installed Node or Docker — Windows only picks up new
programs in *new* terminal windows. Close PowerShell, open a fresh one, and run
the installer again. If it installed Docker Desktop, start Docker once from the
Start menu and let it finish setting itself up first.

---

## 4. Use it

Open **http://127.0.0.1:3080** in your browser.

The first message takes a moment while the model warms up. After that you have a
coding agent that can read and write files, run commands, and search the web.

To start it again later:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\start-seek.ps1"
```

If you said yes to autostart, it comes up by itself about a minute after you log
in, and you can skip that entirely.

---

## 5. Check it is actually working

```powershell
# The UI
curl.exe -s -o NUL -w "%{http_code}\n" http://127.0.0.1:3080

# The model - should say 200
curl.exe -s -o NUL -w "%{http_code}\n" http://127.0.0.1:18798/health
```

The log of the last startup is at `%USERPROFILE%\.dsh\autostart.log`, and its
final line summarises every service. Anything unexpected is covered in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Exposing it to the internet

**Read this whole section before doing it.** By default nothing is exposed —
the agent listens only on your own machine, which needs no domain and carries no
risk from outside.

Exposing it is a genuinely different situation. **The harness has no login of
its own, and the agent can run PowerShell commands on your PC.** Anyone who
reaches it can do anything you can do on that machine. The auth proxy in this
repo is the only thing preventing that, so:

- Never point a tunnel at port `3080`. Point it at `18799`, the auth proxy.
- Never disable the proxy "just to test something".
- Use a long random password. The installer generates one for you.

You will need a domain on Cloudflare and a Cloudflare tunnel.

**1.** Install `cloudflared` and log in:

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create seek
```

**2.** Re-run the installer with your hostname. It generates a username and
password and prints them once — write them down:

```powershell
.\install.ps1 -Hostname seek.example.com
```

**3.** Add the ingress rule from [`../cloudflared/ingress-snippet.yml`](../cloudflared/ingress-snippet.yml)
to `%USERPROFILE%\.cloudflared\config.yml`, pointing at **`http://localhost:18799`**.

**4.** Route DNS and restart the service (needs admin):

```powershell
cloudflared tunnel route dns seek seek.example.com
Restart-Service Cloudflared -Force
```

**5.** Visit your hostname. A **401 login prompt means it is working.** A **502
means the tunnel is up but the stack is not** — run `start-seek.ps1`.

You will be asked to log in once, then a signed cookie keeps you in for 30 days.

---

## Turning it off

Stop everything for now:

```powershell
Get-Process llama-server,node -ErrorAction SilentlyContinue | Stop-Process -Force
docker stop searxng
```

Remove it entirely, including the model:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```
