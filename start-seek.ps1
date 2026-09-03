# Bring up the seek.joelcrobinson.com stack (DeepSeek Harness + Qwen3.8-27B).
#
#   cloudflared -> 127.0.0.1:18799 (auth proxy) -> 127.0.0.1:3080 (dsh web)
#                                                        |
#                                    127.0.0.1:18800 (summarizer shim)
#                                                        |
#                                        127.0.0.1:18798 (llama-server)
#
# Idempotent: each service is started only if its port is not already listening,
# so running this twice is harmless. Registered as the "SeekHarness" scheduled
# task (at logon, 1 min delay); also fine to run by hand after a crash.

$ErrorActionPreference = "Stop"

$dshHome = "C:\Users\Joel Robinson\.dsh"
$log     = Join-Path $dshHome "autostart.log"

function Write-Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $log -Value $line
  Write-Host $line
}

function Test-Port($port) {
  $null -ne (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

Write-Log "=== seek stack startup ==="

# 1. llama-server (18798). Loading 18.8 GB off disk takes ~60s cold.
#
# NOTE: llama-server BINDS 18798 IMMEDIATELY and serves 503 {"Loading model"}
# until the weights are on the GPU, so Test-Port is NOT a liveness check here --
# a hung instance holds the port and looks fine. Health is the only truth.
#
# Observed 2026-08-21 (first boot after a PC restart): the process bound 18798,
# read 36 MB of the GGUF, then stalled forever -- 0 bytes/s of I/O, ~2s of CPU
# over 5 minutes, GPU untouched at 0%. A plain kill + restart loaded normally
# (GPU to 98% within seconds), so this is a boot-time race, most likely the
# NVIDIA driver not being ready when the task fires 1 min after logon. The old
# code just logged a WARN and carried on with a dead model, and because the
# skip-check was port-based, re-running this script by hand could not fix it.
function Test-LlamaHealthy {
  try { return (Invoke-WebRequest -Uri "http://127.0.0.1:18798/health" -TimeoutSec 5 -UseBasicParsing).StatusCode -eq 200 }
  catch { return $false }
}

if (Test-LlamaHealthy) {
  Write-Log "llama-server already healthy on 18798, skipping"
} else {
  $attempts = 2
  for ($try = 1; $try -le $attempts; $try++) {
    # Clear a hung/half-loaded instance; on try 1 this is usually a no-op.
    $stale = Get-Process llama-server -ErrorAction SilentlyContinue
    if ($stale) {
      Write-Log "killing stale llama-server (pid $($stale.Id -join ','))"
      $stale | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 5
    }

    Write-Log "starting llama-server (attempt $try/$attempts)..."
    & "A:\llama.cpp\serve-qwen38.ps1" | Out-Null

    # Health-gate dsh on the model being loadable, but don't block forever:
    # dsh connects lazily, so a slow model load is not fatal to the web UI.
    $deadline = (Get-Date).AddSeconds(240)
    do {
      Start-Sleep -Seconds 5
      $ok = Test-LlamaHealthy
    } while (-not $ok -and (Get-Date) -lt $deadline)

    if ($ok) { Write-Log "llama-server healthy on 18798 (attempt $try)"; break }
    Write-Log "WARN: llama-server not healthy within 240s on attempt $try (see A:\llama.cpp\qwen38-server.log.err)"
  }
  if (-not (Test-LlamaHealthy)) {
    Write-Log "ERROR: llama-server still unhealthy after $attempts attempts - the harness will load but have no model"
  }
}

# 2. Summarizer shim (18800). settings.yaml points local-llamacpp at THIS, not
#    18798 -- if it is not running, the harness cannot reach the model at all.
#    It rewrites only the compaction summarization call (identified by its
#    hard-coded 8192 cap) to disable thinking, because rc.7 lets that call spend
#    its whole budget reasoning and return a truncated summary.
if (Test-Port 18800) {
  Write-Log "summarizer shim already listening on 18800, skipping"
} else {
  Write-Log "starting summarizer shim..."
  Start-Process -FilePath "node.exe" `
    -ArgumentList ('"{0}"' -f (Join-Path $dshHome "proxy\summarizer-shim.js")) `
    -RedirectStandardOutput (Join-Path $dshHome "proxy\shim.log") `
    -RedirectStandardError  (Join-Path $dshHome "proxy\shim.err") `
    -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if (Test-Port 18800) { Write-Log "summarizer shim up on 18800" } else { Write-Log "WARN: shim did not bind 18800 - harness will have no model" }
}

# 2b. SearXNG search adapter (18802). Backs the harness `web_search` tool so it
#     needs no DEEPSEEK_API_KEY. Talks to the SearXNG container on 18801, which
#     Docker restarts on its own (restart: unless-stopped in ~/searxng), so only
#     this bare node process needs starting here.
#     If 18802 is down, web_search fails with WEB_PROVIDER_ERROR; everything
#     else in the harness keeps working.
if (Test-Port 18802) {
  Write-Log "search adapter already listening on 18802, skipping"
} else {
  Write-Log "starting searxng search adapter..."
  Start-Process -FilePath "node.exe" `
    -ArgumentList ('"{0}"' -f (Join-Path $dshHome "proxy\searxng-search-adapter.js")) `
    -RedirectStandardOutput (Join-Path $dshHome "proxy\search.out") `
    -RedirectStandardError  (Join-Path $dshHome "proxy\search.err") `
    -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if (Test-Port 18802) { Write-Log "search adapter up on 18802" } else { Write-Log "WARN: search adapter did not bind 18802 - web_search will fail" }
}

# Docker starts SearXNG itself; just report whether it is actually answering,
# since the adapter is useless without it and the failure is otherwise silent.
try {
  $sx = (Invoke-WebRequest -Uri "http://127.0.0.1:18801/" -TimeoutSec 5 -UseBasicParsing).StatusCode
} catch { $sx = 0 }
if ($sx -eq 200) { Write-Log "searxng healthy on 18801" }
else { Write-Log "WARN: searxng not answering on 18801 (docker not up yet?) - web_search will fail until it is" }

# 3. dsh web (3080). --trusted-host is required or its browser-trust fence
#    rejects everything arriving through the tunnel.
if (Test-Port 3080) {
  Write-Log "dsh web already listening on 3080, skipping"
} else {
  Write-Log "starting dsh web..."
  $env:DSH_HOME = $dshHome
  $webLog = Join-Path $dshHome "web.log"
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList '/c', ('dsh web --trusted-host seek.joelcrobinson.com > "{0}" 2>&1' -f $webLog) `
    -WindowStyle Hidden
  # A flat 10s wait was too short and reported a false failure: dsh web has
  # taken 20-40s to bind on every restart measured. Poll instead of guessing.
  $webDeadline = (Get-Date).AddSeconds(90)
  do { Start-Sleep -Seconds 3 } while (-not (Test-Port 3080) -and (Get-Date) -lt $webDeadline)
  if (Test-Port 3080) { Write-Log "dsh web up on 3080" } else { Write-Log "WARN: dsh web did not bind 3080 within 90s (see $webLog)" }
}

# 4. Basic-auth proxy (18799). Creds live in User-scope env vars, which are NOT
#    inherited by children of an already-running shell -- re-read them here.
if (Test-Port 18799) {
  Write-Log "auth proxy already listening on 18799, skipping"
} else {
  $env:DSH_PROXY_USER = [Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User')
  $env:DSH_PROXY_PASS = [Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User')
  if (-not $env:DSH_PROXY_USER -or -not $env:DSH_PROXY_PASS) {
    Write-Log "ERROR: DSH_PROXY_USER/DSH_PROXY_PASS missing - refusing to expose dsh unauthenticated"
  } else {
    Write-Log "starting auth proxy..."
    Start-Process -FilePath "node.exe" `
      -ArgumentList ('"{0}"' -f (Join-Path $dshHome "proxy\server.js")) `
      -RedirectStandardOutput (Join-Path $dshHome "proxy\proxy.log") `
      -RedirectStandardError  (Join-Path $dshHome "proxy\proxy.log.err") `
      -WindowStyle Hidden
    Start-Sleep -Seconds 3
    if (Test-Port 18799) { Write-Log "auth proxy up on 18799" } else { Write-Log "WARN: auth proxy did not bind 18799" }
  }
}

# 18798 is reported by HEALTH, not by port: the port binds before the model
# loads, so a port-based summary reported "True" for a server that had no model.
Write-Log "=== done: 18798(healthy)=$(Test-LlamaHealthy) 18800=$(Test-Port 18800) 18801=$(Test-Port 18801) 18802=$(Test-Port 18802) 3080=$(Test-Port 3080) 18799=$(Test-Port 18799) ==="
