param([string]$SeekHome="$env:USERPROFILE\.dsh",[int]$IntervalSeconds=30,[switch]$Once,[switch]$DryRun)
$ErrorActionPreference='Stop'
$mutex=New-Object System.Threading.Mutex($false,'Local\SeekStackSupervisor')
if(-not $mutex.WaitOne(0)){exit 0}
$failures=@{web=0;router=0;proxy=0;image=0};$nextRepair=@{}
$cli=Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$pythonPath=(Get-Command python.exe -ErrorAction Stop).Source
$ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Get-Json([string]$Url){try{Invoke-RestMethod $Url -TimeoutSec 4}catch{$null}}
function Get-Owned([int]$Port,[string]$Pattern){
 $listener=Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
 if(!$listener){return $null}
 $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
 if($process.CommandLine -notmatch $Pattern){throw "Unrecognized listener on $Port; preserved."}
 $owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
 if($owner.ReturnValue -ne 0 -or $owner.Sid -ne $ownerSid){throw "Listener on $Port belongs to another identity; preserved."}
 $line=$process.CommandLine -replace '/','\';$valid=$false
 if($Port -eq 3080){$valid=$process.ExecutablePath -ieq $nodePath -and $line -match [Regex]::Escape($cli) -and $line -match '(?:^|\s)web(?:\s|$)' -and ($line -notmatch '--port(?:[ =]|$)' -or $line -match '--port[ =]+3080(?:\s|$)')}
 elseif($Port -eq 18799){$valid=$process.ExecutablePath -ieq $nodePath -and $line -match [Regex]::Escape((Join-Path $SeekHome 'proxy\server.js'))}
 elseif($Port -eq 18810){$valid=$process.ExecutablePath -iin @($pythonPath,(Join-Path $SeekHome 'image-engine\.venv\Scripts\python.exe')) -and $line -match '(?:^|\s)-m\s+uvicorn\s+qwen-image-service:app(?:\s|$)' -and $line -match '--port[ =]+18810(?:\s|$)' -and $line -match '--host[ =]+127\.0\.0\.1(?:\s|$)'}
 elseif($Port -eq 18798){$valid=$process.ExecutablePath -ieq 'A:\llama.cpp\llama-server.exe' -and $line -match '--models-preset\s+"?A:\\llama\.cpp\\models\.ini"?(?:\s|$)' -and $line -match '--port[ =]+18798(?:\s|$)'}
 if(!$valid){throw "Listener on $Port has an unexpected executable or script; preserved."}
 return $process
}
function Stop-Owned([object]$Process){
 if(!$Process){return}
 $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.ProcessId)" -ErrorAction SilentlyContinue
 if(!$current){return}
 $owner=Invoke-CimMethod -InputObject $current -MethodName GetOwnerSid
 if($current.CreationDate -ne $Process.CreationDate -or $current.ExecutablePath -ine $Process.ExecutablePath -or $current.CommandLine -cne $Process.CommandLine -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $ownerSid){throw 'Process identity changed before repair; preserved.'}
 Stop-Process -Id $current.ProcessId -ErrorAction Stop
 $deadline=(Get-Date).AddSeconds(10)
 while((Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
 if(Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue){throw 'Owned service did not stop.'}
}
function Repair([string]$Name){
 $env:DSH_HOME=$SeekHome;$env:DSH_WORK_HOME=Join-Path $SeekHome 'work';$env:DSH_BROWSER_USER_DATA_DIR=Join-Path $SeekHome 'browser\profile'
 $env:LOCAL_LLM_API_KEY=[Environment]::GetEnvironmentVariable('LOCAL_LLM_API_KEY','User')
 if($Name -eq 'web'){$p=Get-Owned 3080 'dsh[\\/].*bin\.js.*web';Stop-Owned $p;Start-Process $nodePath -ArgumentList ('"'+$cli+'"'),'web','--trusted-host','seek.joelcrobinson.com' -WindowStyle Hidden -RedirectStandardOutput (Join-Path $SeekHome 'web.log') -RedirectStandardError (Join-Path $SeekHome 'web.log.err') | Out-Null}
 elseif($Name -eq 'proxy'){
  $env:DSH_PROXY_USER=[Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User');$env:DSH_PROXY_PASS=[Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User')
  if(!$env:DSH_PROXY_USER -or !$env:DSH_PROXY_PASS){throw 'Proxy credentials unavailable.'}
  $p=Get-Owned 18799 '\.dsh[\\/]proxy[\\/]server\.js';Stop-Owned $p
  Start-Process $nodePath -ArgumentList ('"'+(Join-Path $SeekHome 'proxy\server.js')+'"') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $SeekHome 'proxy\proxy.log') -RedirectStandardError (Join-Path $SeekHome 'proxy\proxy.log.err') | Out-Null
 }
 elseif($Name -eq 'image'){$p=Get-Owned 18810 'uvicorn.*qwen-image-service:app.*18810';Stop-Owned $p;Start-Process (Join-Path $SeekHome 'image-engine\.venv\Scripts\python.exe') -ArgumentList '-m','uvicorn','qwen-image-service:app','--host','127.0.0.1','--port','18810' -WorkingDirectory (Join-Path $SeekHome 'tools') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $SeekHome 'image-engine\runner.log') -RedirectStandardError (Join-Path $SeekHome 'image-engine\runner.err') | Out-Null}
 elseif($Name -eq 'router'){
  $p=Get-Owned 18798 'llama-server\.exe.*--models-preset.*--port[ =]18798';Stop-Owned $p
  if(!(Test-Path -LiteralPath 'A:\llama.cpp\models.ini')){throw 'Router preset unavailable.'}
  # Keep the existing SSD preset. Health checks never warm a model.
  Start-Process 'A:\llama.cpp\llama-server.exe' -ArgumentList '--models-preset','A:\llama.cpp\models.ini','--models-max','1','--host','127.0.0.1','--port','18798' -WindowStyle Hidden -RedirectStandardOutput 'A:\llama.cpp\router.log' -RedirectStandardError 'A:\llama.cpp\router.log.err' | Out-Null
 }
}
try{
 do{
  $deployLock=Join-Path $SeekHome 'deployment.lock.json'
  if(Test-Path -LiteralPath $deployLock){try{$lock=Get-Content -LiteralPath $deployLock -Raw|ConvertFrom-Json;$locked=$lock.expiresAt -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}catch{$locked=$true};if($locked){if($Once){@{deployment=$true;repairs=@()}|ConvertTo-Json -Compress;break};Start-Sleep -Seconds $IntervalSeconds;continue}}
  $version=Get-Json 'http://127.0.0.1:3080/work/api/version';$router=Get-Json 'http://127.0.0.1:18798/v1/models';$image=Get-Json 'http://127.0.0.1:18810/health'
  try{$proxy=(Invoke-WebRequest 'http://127.0.0.1:18799/login' -TimeoutSec 4 -UseBasicParsing).StatusCode -eq 200}catch{$proxy=$_.Exception.Response.StatusCode.value__ -eq 401}
  $state=Get-Json 'http://127.0.0.1:3080/work/api/updates';$helpers=Get-Json 'http://127.0.0.1:3080/work/api/helper-status';$progress=Get-Json 'http://127.0.0.1:3080/qwen-image/api/status'
  # An image runner that is down cannot be busy; requiring it here meant a reboot (which does not start
# the runner) blocked every GPU repair, including the router. Work's own queue status still gates jobs.
$imageIdle=!$image -or (($image.busy -is [bool]) -and !$image.busy)
$idle=$state -and $helpers -and $progress -and $imageIdle -and !$helpers.foregroundBusy -and !$helpers.active -and !$helpers.pending -and !$progress.active -and !$progress.recoveryRequired -and !@($progress.queue|Where-Object {!$_.deferred}).Count -and !@($router.data|Where-Object {$_.status.value -in @('loading','unloading')}).Count -and !@($state.tasks|Where-Object {$_.status -in @('running','queued') -or $_.handoff -or $_.approval -or $_.nativeRequest}).Count
  $checks=@{web=[bool]$version.release;router=[bool]$router.data;image=[bool]$image.available;proxy=[bool]$proxy};$repairs=@();$errors=@()
  foreach($name in @('web','proxy','image','router')){
   if($checks[$name]){$failures[$name]=0;continue};$failures[$name]++
   # Web restarts reconcile durable work. GPU engines require a confirmed idle owner.
   if($failures[$name] -ge 3 -and ($name -in @('web','proxy') -or $idle) -and (!$nextRepair[$name] -or (Get-Date) -ge $nextRepair[$name])){
    $repairs+=$name;if(!$DryRun){try{Repair $name}catch{$errors+=$name+': '+$_.Exception.Message}}
    $nextRepair[$name]=(Get-Date).AddSeconds([Math]::Min(300,30*[Math]::Pow(2,[Math]::Min($failures[$name]-3,3))))
   }
  }
  $report=@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();checks=$checks;repairs=$repairs;errors=$errors;failures=$failures;idle=[bool]$idle;mode='interactive-user';unattendedBoot=$false;dryRun=[bool]$DryRun}
  if($DryRun){$report|ConvertTo-Json -Depth 4 -Compress}else{$path=Join-Path $SeekHome 'supervisor.json';[IO.File]::WriteAllText($path+'.tmp',($report|ConvertTo-Json -Depth 4 -Compress));Move-Item -LiteralPath ($path+'.tmp') -Destination $path -Force}
  if(!$Once){Start-Sleep -Seconds $IntervalSeconds}
 }while(!$Once)
}finally{$mutex.ReleaseMutex();$mutex.Dispose()}
