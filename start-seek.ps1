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

# 1. llama.cpp router. Serves every configured model from a generated
#    models.ini and keeps only ONE resident (--models-max 1, LRU eviction), so
#    whichever model you pick in the harness gets the whole GPU.
#
# NOTE: in router mode the port answers /health 200 as soon as the router BINDS,
# before any weights are loaded -- health alone no longer proves the GPU path
# works. The warmup POST below is the real liveness check: it forces the default
# model to load and surfaces the boot-time race seen on a first boot after a PC
# restart (the process bound the port, read 36 MB of the GGUF, then stalled
# forever -- 0 bytes/s of I/O, GPU untouched at 0%; a kill + restart loaded
# normally, most likely the NVIDIA driver not being ready when the task fires
# 1 min after logon). Hence: warmup gate, and kill + retry once.

function Test-RouterUp { Test-Http "http://127.0.0.1:$LlamaPort/v1/models" }

function Invoke-Warmup {
  try {
    $body = @{ model = $ModelAlias; max_tokens = 1; messages = @(@{ role = "user"; content = "hi" }) } | ConvertTo-Json -Depth 5
    return (Invoke-WebRequest -Uri "http://127.0.0.1:$LlamaPort/v1/chat/completions" `
              -Method Post -Body $body -ContentType "application/json" `
              -TimeoutSec 300 -UseBasicParsing).StatusCode -eq 200
  } catch { return $false }
}

# The healthy path deliberately does NOT warm. This task repeats every 15 minutes
# to self-heal, and a warmup names ONE model -- with --models-max 1 that would
# evict whichever model you are actually using and reload it, every cycle.
# Answering /v1/models is enough to prove the router is alive; the warmup only
# runs on the start path, where nothing is loaded yet anyway.
if (Test-RouterUp) {
  Write-Log "router already healthy on $LlamaPort"
} else {
  $attempts = 2
  for ($try = 1; $try -le $attempts; $try++) {
    $stale = Get-Process llama-server -ErrorAction SilentlyContinue
    if ($stale) {
      Write-Log "killing stale llama-server (pid $($stale.Id -join ','))"
      $stale | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 5
    }

    Write-Log "starting llama.cpp router (attempt $try/$attempts)..."
    & (Join-Path $LlamaDir "serve-router.ps1") -ConfigPath $ConfigPath | Out-Null

    # 60s was not enough from cold: observed the router failing to answer within
    # 60s on BOTH attempts after a reboot, leaving the stack modelless until
    # someone noticed. Loading llama-server.exe and its CUDA DLLs cold, with a
    # virus scanner in the path, can take minutes.
    $deadline = (Get-Date).AddSeconds(180)
    do { Start-Sleep -Seconds 3 } while (-not (Test-RouterUp) -and (Get-Date) -lt $deadline)
    if (-not (Test-RouterUp)) {
      Write-Log "WARN: router did not answer /v1/models within 60s on attempt $try (see $LlamaDir\router.log.err)"
      continue
    }

    Write-Log "router up; warming $ModelAlias onto the GPU (cold load of ~19 GB takes ~60s)..."
    if (Invoke-Warmup) { Write-Log "router healthy on $LlamaPort ($ModelAlias loaded)"; break }
    Write-Log "WARN: warmup failed on attempt $try (see $LlamaDir\router.log.err)"
  }
  if (-not (Test-RouterUp)) {
    Write-Log "ERROR: router still not answering after $attempts attempts - the harness will load but have no model"
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
  (Test-RouterUp), (Test-Port $ShimPort), (Test-Port $SearxPort), `
  (Test-Port $AdapterPort), (Test-Port $WebPort), (Test-Port $ProxyPort))

if (-not $TrustedHost) {
  Write-Log "Open http://127.0.0.1:$WebPort in your browser."
}
