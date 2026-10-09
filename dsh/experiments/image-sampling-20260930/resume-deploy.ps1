$ErrorActionPreference='Stop'
$repoRoot='C:/Users/Joel Robinson/seek-stack'
$runtimeRoot='C:/Users/Joel Robinson/.dsh'
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
