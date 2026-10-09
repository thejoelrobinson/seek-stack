$ErrorActionPreference='Stop'
$projectRoot='C:\Users\Joel Robinson\seek-stack'
$releaseRoot=Join-Path $projectRoot 'dsh\experiments\seek-improvements-20260930'
$seekRuntime='C:\Users\Joel Robinson\.dsh'
$pluginSource=Join-Path $projectRoot 'dsh\plugins\browser-viewer'
$pluginInstalled=Join-Path $seekRuntime 'profiles\node_modules\@deepseek-ai\dsh-browser-viewer'
$state=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/state'
$busy=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/helper-status'
if ($busy.foregroundBusy -or @($state.tasks | Where-Object {$_.status -in @('running','queued','waiting') -or $_.handoff -or $_.approval -or $_.nativeRequest}).Count) { throw 'Seek has active work. Deployment deferred.' }
$runtimeBackup=Join-Path $releaseRoot 'runtime-backup'
New-Item -ItemType Directory -Force -Path $runtimeBackup | Out-Null
Copy-Item -LiteralPath (Join-Path $seekRuntime 'work\work.json') -Destination (Join-Path $runtimeBackup 'work.json')
Copy-Item -LiteralPath (Join-Path $seekRuntime 'settings.yaml') -Destination (Join-Path $runtimeBackup 'settings.yaml')
$webPid=(Get-NetTCPConnection -State Listen -LocalPort 3080).OwningProcess
$proxyPid=(Get-NetTCPConnection -State Listen -LocalPort 18799).OwningProcess
# Close only Seek's owned headless browser, allowing its profile to flush.
$chrome=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {$_.ParentProcessId -eq $webPid -and $_.CommandLine -match '\.dsh[\\/]browser[\\/]profile'}
if ($chrome) {
  $env:SEEK_BROWSER_PORT_FILE=Join-Path $seekRuntime 'browser\profile\DevToolsActivePort'
  node (Join-Path $releaseRoot 'close-owned-browser.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Could not close the owned browser cleanly.' }
}
Stop-Process -Id $webPid
Copy-Item -LiteralPath (Join-Path $pluginSource 'lib'),(Join-Path $pluginSource 'skills'),(Join-Path $pluginSource 'package.json') -Destination $pluginInstalled -Recurse -Force
$env:DSH_HOME=$seekRuntime
$env:DSH_WORK_HOME=Join-Path $seekRuntime 'work'
$env:DSH_BROWSER_USER_DATA_DIR=Join-Path $seekRuntime 'browser\profile'
$env:LOCAL_LLM_API_KEY=[Environment]::GetEnvironmentVariable('LOCAL_LLM_API_KEY','User')
$web=Start-Process -FilePath node -ArgumentList '"C:\Users\Joel Robinson\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"','web','--trusted-host','seek.joelcrobinson.com' -WorkingDirectory $projectRoot -RedirectStandardOutput (Join-Path $seekRuntime 'web.log') -RedirectStandardError (Join-Path $seekRuntime 'web.log.err') -WindowStyle Hidden -PassThru
Write-Output "Work candidate started: PID $($web.Id)"
Stop-Process -Id $proxyPid
Copy-Item -LiteralPath (Join-Path $releaseRoot 'proxy-candidate.cjs') -Destination (Join-Path $seekRuntime 'proxy\server.js')
$env:DSH_PROXY_USER=[Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User')
$env:DSH_PROXY_PASS=[Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User')
if (!$env:DSH_PROXY_USER -or !$env:DSH_PROXY_PASS) { throw 'Proxy credentials unavailable.' }
$proxy=Start-Process -FilePath node -ArgumentList ('"'+(Join-Path $seekRuntime 'proxy\server.js')+'"') -RedirectStandardOutput (Join-Path $seekRuntime 'proxy\proxy.log') -RedirectStandardError (Join-Path $seekRuntime 'proxy\proxy.log.err') -WindowStyle Hidden -PassThru
Write-Output "Versioned auth proxy started: PID $($proxy.Id)"
