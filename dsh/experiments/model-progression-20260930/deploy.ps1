$ErrorActionPreference='Stop'
$repoRoot='C:\Users\Joel Robinson\seek-stack'
$runtimeRoot='C:\Users\Joel Robinson\.dsh'
$state=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/state'
$helpers=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/helper-status'
$imageStatus=Invoke-RestMethod 'http://127.0.0.1:3080/qwen-image/api/status'
if ($helpers.foregroundBusy -or $helpers.active -or $imageStatus.active -or @($state.tasks | Where-Object {$_.status -in @('running','queued','waiting') -or $_.handoff -or $_.approval -or $_.nativeRequest}).Count) {throw 'Seek has active work; deployment deferred.'}
$runtimeBackup=Join-Path $PSScriptRoot 'runtime-backup'
$installedBackup=Join-Path $PSScriptRoot 'installed-backup'
New-Item -ItemType Directory -Force -Path $runtimeBackup,$installedBackup | Out-Null
Copy-Item -LiteralPath (Join-Path $runtimeRoot 'work\work.json'),(Join-Path $runtimeRoot 'settings.yaml') -Destination $runtimeBackup
foreach($plugin in @('browser-viewer','qwen-image')) {
 $installed=Join-Path $runtimeRoot ('profiles\node_modules\@deepseek-ai\dsh-'+$plugin)
 $backup=Join-Path $installedBackup $plugin
 New-Item -ItemType Directory -Force -Path $backup | Out-Null
 Copy-Item -LiteralPath (Join-Path $installed 'lib'),(Join-Path $installed 'package.json') -Destination $backup -Recurse
}
Copy-Item -LiteralPath (Join-Path $runtimeRoot 'tools\qwen-image-service.py') -Destination $installedBackup
$webPid=(Get-NetTCPConnection -State Listen -LocalPort 3080).OwningProcess
$webProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$webPid"
if ($webProcess.Name -ne 'node.exe' -or $webProcess.CommandLine -notmatch 'dsh.+bin\.js.*web') {throw 'Unexpected Work listener; refusing to stop it.'}
$chrome=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {$_.ParentProcessId -eq $webPid -and $_.CommandLine -match '\.dsh[\\/]browser[\\/]profile'}
if ($chrome) {
 $env:SEEK_BROWSER_PORT_FILE=Join-Path $runtimeRoot 'browser\profile\DevToolsActivePort'
 node (Join-Path $PSScriptRoot 'close-owned-browser.mjs')
 if ($LASTEXITCODE -ne 0) {throw 'Owned browser did not close cleanly.'}
}
if (Get-NetTCPConnection -State Listen -LocalPort 18810 -ErrorAction SilentlyContinue) {throw 'Unexpected running image service; restart explicitly before deploying.'}
Stop-Process -Id $webPid
foreach($plugin in @('browser-viewer','qwen-image')) {
 $source=Join-Path $repoRoot ('dsh\plugins\'+$plugin)
 $installed=Join-Path $runtimeRoot ('profiles\node_modules\@deepseek-ai\dsh-'+$plugin)
 Copy-Item -LiteralPath (Join-Path $source 'lib'),(Join-Path $source 'package.json') -Destination $installed -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'dsh\tools\qwen-image-service.py') -Destination (Join-Path $runtimeRoot 'tools\qwen-image-service.py') -Force
$runner=Start-Process -FilePath (Join-Path $runtimeRoot 'image-engine\.venv\Scripts\python.exe') -ArgumentList '-m','uvicorn','qwen-image-service:app','--host','127.0.0.1','--port','18810' -WorkingDirectory (Join-Path $runtimeRoot 'tools') -RedirectStandardOutput (Join-Path $runtimeRoot 'image-engine\runner.log') -RedirectStandardError (Join-Path $runtimeRoot 'image-engine\runner.err') -WindowStyle Hidden -PassThru
$env:DSH_HOME=$runtimeRoot
$env:DSH_WORK_HOME=Join-Path $runtimeRoot 'work'
$env:DSH_BROWSER_USER_DATA_DIR=Join-Path $runtimeRoot 'browser\profile'
$env:LOCAL_LLM_API_KEY=[Environment]::GetEnvironmentVariable('LOCAL_LLM_API_KEY','User')
$web=Start-Process -FilePath node -ArgumentList '"C:\Users\Joel Robinson\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"','web','--trusted-host','seek.joelcrobinson.com' -WorkingDirectory $repoRoot -RedirectStandardOutput (Join-Path $runtimeRoot 'web.log') -RedirectStandardError (Join-Path $runtimeRoot 'web.log.err') -WindowStyle Hidden -PassThru
Write-Output "Model progression deployed: Work PID $($web.Id), image runner PID $($runner.Id)."
