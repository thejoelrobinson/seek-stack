$ErrorActionPreference='Stop'
$verification=Get-Content (Join-Path $PSScriptRoot 'validation\gemma-ssd-copy.json') -Raw | ConvertFrom-Json
if(!$verification.Verified -or $verification.Models.Count -ne 2){throw 'Gemma copies have not both been verified.'}
foreach($file in $verification.Models){if(!$file.Verified -or !$file.SourcePreserved -or $file.SourceSha256 -ne $file.DestinationSha256 -or (Get-Item -LiteralPath $file.Destination).Length -ne $file.Bytes){throw 'Invalid Gemma copy verification.'}}
function Assert-Idle {
 $state=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/state'
 $helper=Invoke-RestMethod 'http://127.0.0.1:3080/work/api/helper-status'
 $models=(Invoke-RestMethod 'http://127.0.0.1:3080/work/api/updates').health.models
 $busy=@($state.tasks | Where-Object {$_.status -in @('running','queued') -or ($_.status -eq 'waiting' -and ($_.goal.phase -ne 'paused' -or !$_.question -or $_.nativeRequest -or $_.handoff -or $_.approval))})
 if($busy.Count -or $helper.foregroundBusy -or $helper.active -or $helper.pending -or $models.active -or $models.recoveryRequired){throw 'Work is active; Gemma change deferred.'}
}
Assert-Idle
$preset='A:\llama.cpp\models.ini'
$before=[IO.File]::ReadAllText($preset)
$updated=$before
foreach($file in $verification.Models){
 if([regex]::Matches($updated,[regex]::Escape($file.Source)).Count -ne 1){throw 'Unexpected Gemma preset; refusing to replace it.'}
 $updated=$updated.Replace($file.Source,$file.Destination)
}
$routerBefore=(Get-NetTCPConnection -State Listen -LocalPort 18798).OwningProcess
$qwenBefore=Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object {$_.CommandLine -match '--alias qwen3\.8-27b'}
if(!$qwenBefore){throw 'Expected ready Qwen worker is missing.'}
Copy-Item -LiteralPath $preset -Destination (Join-Path $PSScriptRoot 'runtime-backup\models-before-gemma.ini') -Force
Assert-Idle
[IO.File]::WriteAllText($preset,$updated,[Text.UTF8Encoding]::new($false))
try {
 Invoke-RestMethod 'http://127.0.0.1:18798/models?reload=1' -TimeoutSec 30 | Out-Null
 $qwenAfter=Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object {$_.CommandLine -match '--alias qwen3\.8-27b'}
 if($qwenAfter.ProcessId -ne $qwenBefore.ProcessId -or (Get-NetTCPConnection -State Listen -LocalPort 18798).OwningProcess -ne $routerBefore){throw 'The unchanged Qwen worker or router restarted.'}
 $result=@{passed=$true;routerRestarted=$false;qwenWorkerRetained=$true;pathsChangedOnly=$true;originalsPreserved=$true;model='gemma-4-26b-a4b';files=@($verification.Models | Select-Object Bytes,DestinationSha256)}
 $result | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $PSScriptRoot 'validation\gemma-preset.json') -Encoding utf8
 $result | ConvertTo-Json -Depth 4 -Compress
} catch {
 [IO.File]::WriteAllText($preset,$before,[Text.UTF8Encoding]::new($false))
 try {Invoke-RestMethod 'http://127.0.0.1:18798/models?reload=1' -TimeoutSec 30 | Out-Null} catch {Write-Warning 'Prior preset restored; router needs checking.'}
 throw
}
