# Benchmarks llama.cpp router settings for qwen3.8-27b with engine-bench.mjs (same prompts, 2 runs each).
# Backs up models.ini, applies each variant to the [qwen3.8-27b] section, restarts only Seek's router,
# and always restores the original preset and restarts at the end.
param([string[]]$Variants=@('base','n3','n4','ub1024','ub2048'))
$ErrorActionPreference='Stop'
$ini='A:\llama.cpp\models.ini';$exe='A:\llama.cpp\llama-server.exe';$bench=Join-Path $PSScriptRoot 'engine-bench.mjs'
$original=Get-Content $ini -Raw;Copy-Item $ini "$ini.sweep-backup" -Force
$defs=@{base=@{};n3=@{'spec-draft-n-max'='3'};n4=@{'spec-draft-n-max'='4'};ub1024=@{'ubatch-size'='1024'};ub2048=@{'ubatch-size'='2048'};'n3-ub1024'=@{'spec-draft-n-max'='3';'ubatch-size'='1024'};'n3-ub2048'=@{'spec-draft-n-max'='3';'ubatch-size'='2048'}}
function Set-Variant($set){
  $text=$original;$m=[regex]::Match($text,'(?ms)^\[qwen3\.8-27b\]\r?\n(.*?)(?=^\[|\z)')
  $body=$m.Groups[1].Value
  foreach($k in $set.Keys){if($body -match "(?m)^$([regex]::Escape($k))\s*="){$body=[regex]::Replace($body,"(?m)^$([regex]::Escape($k))\s*=.*$","$k = $($set[$k])")}else{$body=$body.TrimEnd()+"`r`n$k = $($set[$k])`r`n`r`n"}}
  Set-Content $ini ($text.Substring(0,$m.Groups[1].Index)+$body+$text.Substring($m.Groups[1].Index+$m.Groups[1].Length)) -NoNewline
}
function Restart-Router{
  Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.ExecutablePath -ieq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
  Start-Sleep 3
  Start-Process -FilePath $exe -ArgumentList '--models-preset',$ini,'--models-max','1','--host','127.0.0.1','--port','18798' -RedirectStandardOutput 'A:\llama.cpp\router.log' -RedirectStandardError 'A:\llama.cpp\router.log.err' -WindowStyle Hidden
  $deadline=(Get-Date).AddSeconds(180);do{Start-Sleep 3;try{$ok=(Invoke-WebRequest http://127.0.0.1:18798/v1/models -TimeoutSec 5 -UseBasicParsing).StatusCode -eq 200}catch{$ok=$false}}until($ok -or (Get-Date) -gt $deadline)
  if(!$ok){throw 'router did not come up'}
  $body='{"model":"qwen3.8-27b","messages":[{"role":"user","content":"hi"}],"max_tokens":8,"reasoning_effort":"low"}'
  Invoke-RestMethod http://127.0.0.1:18798/v1/chat/completions -Method Post -Body $body -ContentType application/json -TimeoutSec 300 | Out-Null
}
try{
  foreach($v in $Variants){
    Set-Variant $defs[$v];Restart-Router
    $vram=(nvidia-smi --query-gpu=memory.used --format=csv,noheader).Trim()
    $samples=[System.Collections.Generic.List[double]]::new()
    $job=Start-Job -ScriptBlock { 1..120 | ForEach-Object { (nvidia-smi --query-gpu=power.draw,utilization.gpu --format=csv,noheader,nounits); Start-Sleep -Milliseconds 500 } }
    foreach($i in 1,2){& node $bench "sweep-$v" | ForEach-Object { $_ }}
    $power=Receive-Job $job -Wait -AutoRemoveJob | ForEach-Object { [double](($_ -split ',')[0]) } | Where-Object { $_ -gt 150 }
    "VARIANT $v vram=$vram powerDuringGen p50=$(($power|Sort-Object)[[int]($power.Count/2)])W max=$(($power|Measure-Object -Maximum).Maximum)W"
  }
}finally{
  Set-Content $ini $original -NoNewline;Restart-Router;'restored original models.ini and router'
}
