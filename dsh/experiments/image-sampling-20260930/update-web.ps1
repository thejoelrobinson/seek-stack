$ErrorActionPreference='Stop'
$repoRoot='C:\Users\Joel Robinson\seek-stack'
$runtimeRoot='C:\Users\Joel Robinson\.dsh'
$state=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/state'
$helpers=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/helper-status'
$images=Invoke-RestMethod 'http://127.0.0.1:3080/qwen-image/api/status'
if($helpers.foregroundBusy -or $helpers.active -or $images.active -or @($state.tasks | Where-Object {$_.status -in @('running','queued','waiting')}).Count){throw 'Active work prevents updating Work.'}
$runnerHealth=Invoke-RestMethod 'http://127.0.0.1:18810/health'
if($runnerHealth.loaded -or $runnerHealth.loading){throw 'An image engine is still in use.'}
$runnerPid=(Get-NetTCPConnection -State Listen -LocalPort 18810).OwningProcess
$runnerProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$runnerPid"
if($runnerProcess.Name -ne 'python.exe' -or $runnerProcess.CommandLine -notmatch 'uvicorn.+qwen-image-service:app.+18810'){throw 'Unexpected image runner; refusing to restart it.'}
$runnerParent=Get-CimInstance Win32_Process -Filter "ProcessId=$($runnerProcess.ParentProcessId)"
$webPid=(Get-NetTCPConnection -State Listen -LocalPort 3080).OwningProcess
$webProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$webPid"
if($webProcess.Name -ne 'node.exe' -or $webProcess.CommandLine -notmatch 'dsh.+bin\.js.*web'){throw 'Unexpected Work listener; refusing to stop it.'}
$chrome=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {$_.ParentProcessId -eq $webPid -and $_.CommandLine -match '\.dsh[\\/]browser[\\/]profile'}
if($chrome){
 $env:SEEK_BROWSER_PORT_FILE=Join-Path $runtimeRoot 'browser\profile\DevToolsActivePort'
 node (Join-Path $PSScriptRoot 'close-owned-browser.mjs')
 if($LASTEXITCODE -ne 0){throw 'Browser did not close cleanly.'}
}
Copy-Item -LiteralPath (Join-Path $runtimeRoot 'work\work.json'),(Join-Path $runtimeRoot 'settings.yaml') -Destination (Join-Path $PSScriptRoot 'runtime-backup')
$gallery=Invoke-WebRequest 'http://127.0.0.1:3080/qwen-image/api/history' -UseBasicParsing
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'runtime-backup\images.json'),$gallery.Content,[Text.UTF8Encoding]::new($false))
$helpers=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/helper-status'
$images=Invoke-RestMethod 'http://127.0.0.1:3080/qwen-image/api/status'
$state=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/state'
if($helpers.foregroundBusy -or $helpers.active -or $images.active -or @($state.tasks | Where-Object {$_.status -in @('running','queued','waiting')}).Count){throw 'Work became active; update deferred.'}
Stop-Process -Id $webPid
Stop-Process -Id $runnerPid
if($runnerParent.Name -eq 'python.exe' -and $runnerParent.CommandLine -match 'uvicorn.+qwen-image-service:app.+18810' -and (Get-Process -Id $runnerParent.ProcessId -ErrorAction SilentlyContinue)){Stop-Process -Id $runnerParent.ProcessId -ErrorAction SilentlyContinue}
foreach($plugin in @('browser-viewer','qwen-image')){
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
Write-Output "Updated Work PID $($web.Id). Router retained; sampling runner restarted."
$deadline=(Get-Date).AddSeconds(60)
do {
 Start-Sleep -Milliseconds 500
 try {$ready=(Invoke-RestMethod 'http://127.0.0.1:3080/work/api/version' -TimeoutSec 2).release} catch {$ready=$null}
} while(!$ready -and (Get-Date) -lt $deadline)
if(!$ready){throw 'Work did not become ready after update.'}
$health=Invoke-RestMethod 'http://127.0.0.1:18810/health' -TimeoutSec 5
if(!$health.available -or !$health.ready){throw 'Image runner did not become ready.'}
