# Ships only the redesigned Work UI files to the live plugin, with a backup and a deploy lock,
# then restarts dsh web through the SeekHarness task. Refuses while Work is busy or locked.
$ErrorActionPreference = 'Stop'
$seek = "$env:USERPROFILE\.dsh"
$repo = "$env:USERPROFILE\seek-stack\dsh\plugins\browser-viewer\lib"
$live = "$seek\profiles\web\node_modules\@deepseek-ai\dsh-browser-viewer\lib"
$lock = "$seek\deployment.lock.json"
$files = 'work.html','work-client.js','work.css','work-product.js','work-buddy.css','work-model.css','work-dreaming-client.js','work-growth-client.js'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (Test-Path -LiteralPath $lock) { throw "A deployment lock exists ($lock); not touching live files." }
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
@{ created = (Get-Date).ToUniversalTime().ToString('o'); expiresAt = $now + 600000; release = "claude-shell-redesign-$stamp"; at = $now; pid = $PID } |
  ConvertTo-Json -Compress | Set-Content -LiteralPath $lock -Encoding utf8
try {
  $state = Invoke-RestMethod 'http://127.0.0.1:3080/work/api/state' -TimeoutSec 15
  $busy = @($state.tasks | Where-Object { $_.status -in 'running','queued','waiting','attention' -or $_.handoff -or $_.approval })
  if ($busy.Count) { throw ("Work is busy: " + (($busy | ForEach-Object { $_.status + ' ' + $_.title }) -join '; ')) }
  $before = (Invoke-RestMethod 'http://127.0.0.1:3080/work/api/version' -TimeoutSec 10).release

  $backup = "$seek\browser\backups\$stamp-claude-shell-redesign\lib"
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  foreach ($f in $files) { Copy-Item -LiteralPath "$live\$f" -Destination "$backup\$f" }
  foreach ($f in $files) {
    Copy-Item -LiteralPath "$repo\$f" -Destination "$live\$f.new"
    if ((Get-FileHash "$repo\$f").Hash -ne (Get-FileHash "$live\$f.new").Hash) { throw "Copy check failed for $f" }
    Move-Item -LiteralPath "$live\$f.new" -Destination "$live\$f" -Force
  }
  "backed up to $backup; copied $($files.Count) files"

  $owner = (Get-NetTCPConnection -LocalPort 3080 -State Listen).OwningProcess | Select-Object -First 1
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$owner"
  if ($proc.CommandLine -notmatch 'dsh\\lib\\bin\.js"?\s+web') { throw "Port 3080 owner is not dsh web: $($proc.CommandLine)" }
  Stop-Process -Id $owner -Force
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  Start-ScheduledTask -TaskName 'SeekHarness'
  "stopped dsh web $owner; started SeekHarness"

  $deadline = (Get-Date).AddSeconds(180); $after = $null
  while ((Get-Date) -lt $deadline) {
    try { $after = (Invoke-RestMethod 'http://127.0.0.1:3080/work/api/version' -TimeoutSec 5).release; if ($after) { break } } catch {}
    Start-Sleep -Seconds 2
  }
  if (!$after) { throw 'dsh web did not come back within 180 s; the backup is at ' + $backup }
  "release $before -> $after"
} finally {
  Remove-Item -LiteralPath $lock -ErrorAction SilentlyContinue
}
