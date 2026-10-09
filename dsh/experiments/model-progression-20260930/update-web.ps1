$ErrorActionPreference='Stop'
$repoRoot='C:\Users\Joel Robinson\seek-stack'
$runtimeRoot='C:\Users\Joel Robinson\.dsh'
$state=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/state'
$helpers=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/helper-status'
$images=Invoke-RestMethod 'http://127.0.0.1:3080/qwen-image/api/status'
if($helpers.foregroundBusy -or $helpers.active -or $images.active -or @($state.tasks | Where-Object {$_.status -in @('running','queued','waiting')}).Count){throw 'Active work prevents updating Work.'}
$webPid=(Get-NetTCPConnection -State Listen -LocalPort 3080).OwningProcess
$webProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$webPid"
if($webProcess.Name -ne 'node.exe' -or $webProcess.CommandLine -notmatch 'dsh.+bin\.js.*web'){throw 'Unexpected Work listener; refusing to stop it.'}
$chrome=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {$_.ParentProcessId -eq $webPid -and $_.CommandLine -match '\.dsh[\\/]browser[\\/]profile'}
if($chrome){
 $env:SEEK_BROWSER_PORT_FILE=Join-Path $runtimeRoot 'browser\profile\DevToolsActivePort'
 node (Join-Path $PSScriptRoot 'close-owned-browser.mjs')
 if($LASTEXITCODE -ne 0){throw 'Browser did not close cleanly.'}
}
Stop-Process -Id $webPid
foreach($plugin in @('browser-viewer','qwen-image')){
 $source=Join-Path $repoRoot ('dsh\plugins\'+$plugin)
 $installed=Join-Path $runtimeRoot ('profiles\node_modules\@deepseek-ai\dsh-'+$plugin)
 Copy-Item -LiteralPath (Join-Path $source 'lib'),(Join-Path $source 'package.json') -Destination $installed -Recurse -Force
}
$env:DSH_HOME=$runtimeRoot
$env:DSH_WORK_HOME=Join-Path $runtimeRoot 'work'
$env:DSH_BROWSER_USER_DATA_DIR=Join-Path $runtimeRoot 'browser\profile'
$env:LOCAL_LLM_API_KEY=[Environment]::GetEnvironmentVariable('LOCAL_LLM_API_KEY','User')
$web=Start-Process -FilePath node -ArgumentList '"C:\Users\Joel Robinson\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"','web','--trusted-host','seek.joelcrobinson.com' -WorkingDirectory $repoRoot -RedirectStandardOutput (Join-Path $runtimeRoot 'web.log') -RedirectStandardError (Join-Path $runtimeRoot 'web.log.err') -WindowStyle Hidden -PassThru
Write-Output "Updated Work PID $($web.Id). Router and image runner retained."
$deadline=(Get-Date).AddSeconds(60)
do {
 Start-Sleep -Milliseconds 500
 try {$ready=(Invoke-RestMethod 'http://127.0.0.1:3080/work/api/version' -TimeoutSec 2).release} catch {$ready=$null}
} while(!$ready -and (Get-Date) -lt $deadline)
if(!$ready){throw 'Work did not become ready after update.'}
