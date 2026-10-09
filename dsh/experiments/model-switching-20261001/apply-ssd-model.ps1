$ErrorActionPreference='Stop'
$sourceModel='A:\models\qwen3.8\Qwen3.8-27B-UD-Q5_K_XL.gguf'
$ssdModel='C:\Users\Joel Robinson\.dsh\models\qwen3.8\Qwen3.8-27B-UD-Q5_K_XL.gguf'
$preset='A:\llama.cpp\models.ini'
$verification=Get-Content (Join-Path $PSScriptRoot 'validation\ssd-copy.json') -Raw | ConvertFrom-Json
if(!$verification.verified -or (Get-Item -LiteralPath $ssdModel).Length -ne $verification.bytes){throw 'SSD model has not been verified.'}
$state=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/state'
$helpers=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/helper-status'
$models=(Invoke-RestMethod 'http://127.0.0.1:3080/work/api/updates').health.models
# An ordinary question with a paused goal is idle. Preserve it; do not cancel it.
$busyTasks=@($state.tasks | Where-Object {
 $_.status -in @('running','queued') -or ($_.status -eq 'waiting' -and
 ($_.goal.phase -ne 'paused' -or !$_.question -or $_.nativeRequest -or $_.handoff -or $_.approval))
})
if($helpers.foregroundBusy -or $helpers.active -or $helpers.pending -or $models.active -or $models.recoveryRequired -or $busyTasks.Count){throw 'Active work prevents changing the model path.'}
$router=Invoke-RestMethod 'http://127.0.0.1:18798/v1/models'
if(@($router.data | Where-Object {$_.status.value -in @('loading','unloading')}).Count){throw 'A model is already switching.'}
$before=[IO.File]::ReadAllText($preset)
$oldLine='model = '+$sourceModel
if(@([regex]::Matches($before,[regex]::Escape($oldLine))).Count -ne 1){throw 'Unexpected Qwen preset; refusing to change it.'}
$updated=$before.Replace($oldLine,'model = '+$ssdModel)
Copy-Item -LiteralPath $preset -Destination (Join-Path $PSScriptRoot 'runtime-backup\models.ini') -Force
$helpers=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/helper-status'
if($helpers.foregroundBusy -or $helpers.active -or $helpers.pending){throw 'Inference became active; model change deferred.'}
[IO.File]::WriteAllText($preset,$updated,[Text.UTF8Encoding]::new($false))
$timer=[Diagnostics.Stopwatch]::StartNew()
try {
 Invoke-RestMethod 'http://127.0.0.1:18798/models?reload=1' -TimeoutSec 30 | Out-Null
 $model=(Invoke-RestMethod 'http://127.0.0.1:18798/v1/models').data | Where-Object id -eq 'qwen3.8-27b'
 if($model.status.value -notin @('loaded','loading')){Invoke-RestMethod 'http://127.0.0.1:18798/models/load' -Method Post -ContentType 'application/json' -Body '{"model":"qwen3.8-27b"}' -TimeoutSec 20 | Out-Null}
 $loadStart=$timer.ElapsedMilliseconds
 do {
  Start-Sleep -Milliseconds 250
  $model=(Invoke-RestMethod 'http://127.0.0.1:18798/v1/models' -TimeoutSec 5).data | Where-Object id -eq 'qwen3.8-27b'
  if($timer.Elapsed.TotalSeconds -gt 300){throw 'SSD model did not become ready.'}
 } while($model.status.value -ne 'loaded')
 $worker=Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object {$_.CommandLine -match '--alias qwen3\.8-27b' -and $_.CommandLine.Contains($ssdModel)}
 if(!$worker){throw 'Ready Qwen worker is not using the verified SSD copy.'}
 $result=@{passed=$true;routerRestarted=$false;pathChangedOnly=$true;model='qwen3.8-27b';reloadAndLoadMs=$timer.ElapsedMilliseconds;loadMs=$timer.ElapsedMilliseconds-$loadStart;weightsSha256=$verification.sha256;sourcePreserved=(Test-Path -LiteralPath $sourceModel);workerPid=$worker.ProcessId}
 $result | ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot 'validation\ssd-model-reload.json') -Encoding utf8
 $result | ConvertTo-Json -Compress
} catch {
 # Restore and reconcile the previous preset if the verified copy cannot load.
 [IO.File]::WriteAllText($preset,$before,[Text.UTF8Encoding]::new($false))
 try {
  Invoke-RestMethod 'http://127.0.0.1:18798/models?reload=1' -TimeoutSec 30 | Out-Null
  $model=(Invoke-RestMethod 'http://127.0.0.1:18798/v1/models').data | Where-Object id -eq 'qwen3.8-27b'
  if($model.status.value -notin @('loaded','loading')){Invoke-RestMethod 'http://127.0.0.1:18798/models/load' -Method Post -ContentType 'application/json' -Body '{"model":"qwen3.8-27b"}' -TimeoutSec 20 | Out-Null}
 } catch {Write-Warning 'Previous preset restored; router recovery needs checking.'}
 throw
}
