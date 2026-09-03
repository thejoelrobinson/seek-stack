# Bring up the seek stack.
#
#   [tunnel] -> 18799 auth proxy -> 3080 dsh web
#                                        |
#                        18800 summarizer shim -> 18798 llama-server
#                                        |
#                        18802 search adapter  -> 18801 SearXNG (docker)
#
# Idempotent: each service is started only if it is not already up, so running
# this twice is harmless and it is the right thing to run by hand after a crash.
# Registered as the "SeekHarness" scheduled task (at logon, 1 min delay).
#
# All paths and ports come from seek.config.ps1.

param(
  [string]$ConfigPath = $(if ($env:SEEK_CONFIG) { $env:SEEK_CONFIG } else { "$env:USERPROFILE\.dsh\seek.config.ps1" })
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ConfigPath)) {
  throw "Config not found at $ConfigPath. Run install.ps1 first, or pass -ConfigPath."
}
. $ConfigPath

$log = Join-Path $SeekHome "autostart.log"

function Write-Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $log -Value $line
  Write-Host $line
}

function Test-Port($port) {
  $null -ne (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

function Test-Http($url) {
  try { return (Invoke-WebRequest -Uri $url -TimeoutSec 5 -UseBasicParsing).StatusCode -eq 200 }
  catch { return $false }
}

Write-Log "=== seek stack startup ==="

# 1. llama-server. Loading ~19 GB off disk takes ~60s cold.
#
# NOTE: llama-server BINDS ITS PORT IMMEDIATELY and serves 503 {"Loading model"}
# until the weights are on the GPU, so Test-Port is NOT a liveness check here --
# a hung instance holds the port and looks fine. Health is the only truth.
#
# Observed on a first boot after a PC restart: the process bound the port, read
# 36 MB of the GGUF, then stalled forever -- 0 bytes/s of I/O, ~2s of CPU over
# 5 minutes, GPU untouched at 0%. A plain kill + restart loaded normally, so this
# is a boot-time race, most likely the NVIDIA driver not being ready when the
# task fires 1 min after logon. Hence: health-check, and kill + retry once.
function Test-LlamaHealthy { Test-Http "http://127.0.0.1:$LlamaPort/health" }

if (Test-LlamaHealthy) {
  Write-Log "llama-server already healthy on $LlamaPort, skipping"
} else {
  $attempts = 2
  for ($try = 1; $try -le $attempts; $try++) {
    $stale = Get-Process llama-server -ErrorAction SilentlyContinue
    if ($stale) {
      Write-Log "killing stale llama-server (pid $($stale.Id -join ','))"
      $stale | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 5
    }

    Write-Log "starting llama-server (attempt $try/$attempts)..."
    & (Join-Path $LlamaDir "serve-qwen38.ps1") -ConfigPath $ConfigPath | Out-Null

    $deadline = (Get-Date).AddSeconds(240)
    do {
      Start-Sleep -Seconds 5
      $ok = Test-LlamaHealthy
    } while (-not $ok -and (Get-Date) -lt $deadline)

    if ($ok) { Write-Log "llama-server healthy on $LlamaPort (attempt $try)"; break }
    Write-Log "WARN: llama-server not healthy within 240s on attempt $try (see $LlamaDir\qwen38-server.log.err)"
  }
  if (-not (Test-LlamaHealthy)) {
    Write-Log "ERROR: llama-server still unhealthy after $attempts attempts - the harness will load but have no model"
  }
}

# 2. Summarizer shim. settings.yaml points local-llamacpp at THIS, not directly
#    at llama-server -- if it is not running, the harness cannot reach the model
#    at all. It rewrites only the compaction summarization call (identified by
#    its hard-coded 8192 cap) to disable thinking, because rc.7 lets that call
#    spend its whole budget reasoning and return a truncated summary.
if (Test-Port $ShimPort) {
  Write-Log "summarizer shim already listening on $ShimPort, skipping"
} else {
  Write-Log "starting summarizer shim..."
  Start-Process -FilePath "node.exe" `
    -ArgumentList ('"{0}"' -f (Join-Path $SeekHome "proxy\summarizer-shim.js")) `
    -RedirectStandardOutput (Join-Path $SeekHome "proxy\shim.log") `
    -RedirectStandardError  (Join-Path $SeekHome "proxy\shim.err") `
    -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if (Test-Port $ShimPort) { Write-Log "summarizer shim up on $ShimPort" }
  else { Write-Log "WARN: shim did not bind $ShimPort - harness will have no model" }
}

# 3. SearXNG search adapter. Backs the harness web_search tool so it needs no
#    paid API key. Docker restarts the SearXNG container itself, so only this
#    bare node process needs starting here. If it is down, web_search fails with
#    WEB_PROVIDER_ERROR; everything else in the harness keeps working.
if (Test-Port $AdapterPort) {
  Write-Log "search adapter already listening on $AdapterPort, skipping"
} else {
  Write-Log "starting searxng search adapter..."
  Start-Process -FilePath "node.exe" `
    -ArgumentList ('"{0}"' -f (Join-Path $SeekHome "proxy\searxng-search-adapter.js")) `
    -RedirectStandardOutput (Join-Path $SeekHome "proxy\search.out") `
    -RedirectStandardError  (Join-Path $SeekHome "proxy\search.err") `
    -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if (Test-Port $AdapterPort) { Write-Log "search adapter up on $AdapterPort" }
  else { Write-Log "WARN: search adapter did not bind $AdapterPort - web_search will fail" }
}

# Docker starts SearXNG itself; just report whether it is actually answering,
# since the adapter is useless without it and the failure is otherwise silent.
if (Test-Http "http://127.0.0.1:$SearxPort/") { Write-Log "searxng healthy on $SearxPort" }
else { Write-Log "WARN: searxng not answering on $SearxPort (docker not up yet?) - web_search will fail until it is" }

# 4. dsh web. --trusted-host is required when tunnelled, or its browser-trust
#    fence rejects every request that did not come from localhost.
if (Test-Port $WebPort) {
  Write-Log "dsh web already listening on $WebPort, skipping"
} else {
  Write-Log "starting dsh web..."
  $env:DSH_HOME = $SeekHome
  $webLog = Join-Path $SeekHome "web.log"
  $dshCmd = if ($TrustedHost) { "dsh web --trusted-host $TrustedHost" } else { "dsh web" }
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList '/c', ('{0} > "{1}" 2>&1' -f $dshCmd, $webLog) `
    -WindowStyle Hidden
  # A flat 10s wait was too short and reported a false failure: dsh web has
  # taken 20-40s to bind on every restart measured. Poll instead of guessing.
  $webDeadline = (Get-Date).AddSeconds(90)
  do { Start-Sleep -Seconds 3 } while (-not (Test-Port $WebPort) -and (Get-Date) -lt $webDeadline)
  if (Test-Port $WebPort) { Write-Log "dsh web up on $WebPort" }
  else { Write-Log "WARN: dsh web did not bind $WebPort within 90s (see $webLog)" }
}

# 5. Basic-auth proxy. ONLY started when a TrustedHost is configured -- with no
#    tunnel there is nothing to protect and the harness is already localhost-only.
#    Creds live in User-scope env vars, which are NOT inherited by children of an
#    already-running shell, so re-read them here.
if (-not $TrustedHost) {
  Write-Log "no TrustedHost configured - local-only mode, auth proxy not started"
} elseif (Test-Port $ProxyPort) {
  Write-Log "auth proxy already listening on $ProxyPort, skipping"
} else {
  $env:DSH_PROXY_USER = [Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User')
  $env:DSH_PROXY_PASS = [Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User')
  if (-not $env:DSH_PROXY_USER -or -not $env:DSH_PROXY_PASS) {
    Write-Log "ERROR: DSH_PROXY_USER/DSH_PROXY_PASS missing - refusing to expose dsh unauthenticated"
  } else {
    Write-Log "starting auth proxy..."
    Start-Process -FilePath "node.exe" `
      -ArgumentList ('"{0}"' -f (Join-Path $SeekHome "proxy\server.js")) `
      -RedirectStandardOutput (Join-Path $SeekHome "proxy\proxy.log") `
      -RedirectStandardError  (Join-Path $SeekHome "proxy\proxy.log.err") `
      -WindowStyle Hidden
    Start-Sleep -Seconds 3
    if (Test-Port $ProxyPort) { Write-Log "auth proxy up on $ProxyPort" }
    else { Write-Log "WARN: auth proxy did not bind $ProxyPort" }
  }
}

# llama-server is reported by HEALTH, not by port: the port binds before the
# model loads, so a port-based summary reported "True" for a server with no model.
Write-Log ("=== done: llama(healthy)={0} shim={1} searxng={2} adapter={3} web={4} proxy={5} ===" -f `
  (Test-LlamaHealthy), (Test-Port $ShimPort), (Test-Port $SearxPort), `
  (Test-Port $AdapterPort), (Test-Port $WebPort), (Test-Port $ProxyPort))

if (-not $TrustedHost) {
  Write-Log "Open http://127.0.0.1:$WebPort in your browser."
}
