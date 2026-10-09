$ErrorActionPreference='Stop'
$repoRoot='C:\Users\Joel Robinson\seek-stack'
$runtimeRoot='C:\Users\Joel Robinson\.dsh'
function Assert-Idle {
 $state=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/state'
 $helpers=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/helper-status'
 $models=(Invoke-RestMethod 'http://127.0.0.1:3080/work/api/updates').health.models
 $busyTasks=@($state.tasks | Where-Object {
  $_.status -in @('running','queued') -or ($_.status -eq 'waiting' -and
  ($_.goal.phase -ne 'paused' -or !$_.question -or $_.nativeRequest -or $_.handoff -or $_.approval))
 })
 if($helpers.foregroundBusy -or $helpers.active -or $helpers.pending -or $models.active -or $models.recoveryRequired -or $busyTasks.Count){throw 'Active work prevents updating Work.'}
 return $state
}
$state=Assert-Idle
$webPid=(Get-NetTCPConnection -State Listen -LocalPort 3080).OwningProcess
$webProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$webPid"
if($webProcess.Name -ne 'node.exe' -or $webProcess.CommandLine -notmatch 'dsh.+bin\.js.*web'){throw 'Unexpected Work listener; refusing to stop it.'}
$runnerBefore=Invoke-RestMethod 'http://127.0.0.1:18810/health'
$routerPid=(Get-NetTCPConnection -State Listen -LocalPort 18798).OwningProcess
$runnerPid=(Get-NetTCPConnection -State Listen -LocalPort 18810).OwningProcess
Copy-Item -LiteralPath (Join-Path $runtimeRoot 'work\work.json'),(Join-Path $runtimeRoot 'settings.yaml') -Destination (Join-Path $PSScriptRoot 'runtime-backup') -Force
$gallery=Invoke-WebRequest 'http://127.0.0.1:3080/qwen-image/api/history' -UseBasicParsing
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'runtime-backup\images.json'),$gallery.Content,[Text.UTF8Encoding]::new($false))
$chrome=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {$_.ParentProcessId -eq $webPid -and $_.CommandLine -match '\.dsh[\\/]browser[\\/]profile'}
if($chrome){
 $env:SEEK_BROWSER_PORT_FILE=Join-Path $runtimeRoot 'browser\profile\DevToolsActivePort'
 node (Join-Path $PSScriptRoot 'close-owned-browser.mjs')
 if($LASTEXITCODE -ne 0){throw 'Seek browser did not close cleanly.'}
}
$state=Assert-Idle
Stop-Process -Id $webPid
$source=Join-Path $repoRoot 'dsh\plugins\browser-viewer'
$installed=Join-Path $runtimeRoot 'profiles\node_modules\@deepseek-ai\dsh-browser-viewer'
Copy-Item -LiteralPath (Join-Path $source 'lib'),(Join-Path $source 'package.json') -Destination $installed -Recurse -Force
$env:DSH_HOME=$runtimeRoot
$env:DSH_WORK_HOME=Join-Path $runtimeRoot 'work'
$env:DSH_BROWSER_USER_DATA_DIR=Join-Path $runtimeRoot 'browser\profile'
$env:LOCAL_LLM_API_KEY=[Environment]::GetEnvironmentVariable('LOCAL_LLM_API_KEY','User')
$web=Start-Process -FilePath node -ArgumentList '"C:\Users\Joel Robinson\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"','web','--trusted-host','seek.joelcrobinson.com' -WorkingDirectory $repoRoot -RedirectStandardOutput (Join-Path $runtimeRoot 'web.log') -RedirectStandardError (Join-Path $runtimeRoot 'web.log.err') -WindowStyle Hidden -PassThru
$deadline=(Get-Date).AddSeconds(90)
do {
 Start-Sleep -Milliseconds 500
 try {$version=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/version' -TimeoutSec 2} catch {$version=$null}
} while((!$version -or $version.plugin -ne '0.4.7') -and (Get-Date) -lt $deadline)
if(!$version -or $version.plugin -ne '0.4.7'){throw 'Updated Work did not become ready.'}
if((Get-NetTCPConnection -State Listen -LocalPort 18798).OwningProcess -ne $routerPid -or (Get-NetTCPConnection -State Listen -LocalPort 18810).OwningProcess -ne $runnerPid){throw 'Router or image runner changed unexpectedly.'}
$result=@{passed=$true;workPid=$web.Id;routerRetained=$true;runnerRetained=$true;version=$version;waitingTasksPreserved=@($state.tasks | Where-Object status -eq 'waiting').Count}
$result | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $PSScriptRoot 'validation\deployment.json') -Encoding utf8
$result | ConvertTo-Json -Depth 4 -Compress
