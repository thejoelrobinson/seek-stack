# Default is a read-only preflight. Root explicitly runs -Apply after release checks.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$ExpectedRelease,
 [string]$SeekHome="$env:USERPROFILE\.dsh",
 [int]$ExpectedRouterPid=8700,
 [ValidateRange(20,90)][int]$RecoveryTimeoutSeconds=90,
 [string]$OutputPath,
 [switch]$Apply
)
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
if([string]::IsNullOrWhiteSpace($OutputPath)){$OutputPath=Join-Path (Split-Path -Parent $PSCommandPath) 'supervisor-recovery.json'}
$SeekHome=[IO.Path]::GetFullPath($SeekHome)
if($SeekHome -ine [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.dsh'))){throw 'Recovery drill requires the canonical same-user Seek home.'}
$node=(Get-Command node.exe).Source;$powershell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$supervisorPath=Join-Path $SeekHome 'supervise-seek.ps1';$proxyPath=Join-Path $SeekHome 'proxy\server.js'
$sourceSupervisor=Join-Path $PSScriptRoot '..\..\..\scheduled-task\supervise-seek-v2.ps1'
$fingerprintPath=Join-Path $PSScriptRoot 'recovery-fingerprint.mjs';$workRoot=Join-Path $SeekHome 'work'
$ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$origin='https://seek.joelcrobinson.com';$cookie=$env:SEEK_RECOVERY_COOKIE
$fast=$null;$baseline=$null;$before=$null;$proxyFaulted=$false;$supervisorChanged=$false;$manualFallback=$false;$failure=$null;$normalRestored=$false

function Field($Value,[string]$Name){if($null -eq $Value){return $null};$p=$Value.PSObject.Properties[$Name];if($p){return $p.Value};return $null}
function Json([string]$Path){try{Invoke-RestMethod ('http://127.0.0.1:'+$Path) -TimeoutSec 2}catch{throw 'A required read-only service health check failed.'}}
function Owner($Process){if(!$Process){throw 'Owned process is missing.'};$value=Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid;if($value.ReturnValue -ne 0 -or $value.Sid -ne $ownerSid){throw 'Process belongs to another identity; preserved.'}}
function Identity($Process){@{pid=[int]$Process.ProcessId;created=$Process.CreationDate.ToUniversalTime().ToString('o');executable=$Process.ExecutablePath}}
function Same($First,$Second){$Second -and $First.ProcessId -eq $Second.ProcessId -and $First.CreationDate -eq $Second.CreationDate -and $First.ExecutablePath -ieq $Second.ExecutablePath -and $First.CommandLine -ceq $Second.CommandLine}
function Listener([int]$Port,[switch]$Optional){
 $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue);if(!$listeners.Count){if($Optional){return $null};throw 'Required owned listener is missing.'}
 $ids=@($listeners.OwningProcess|Select-Object -Unique);if($ids.Count -ne 1){throw 'Ambiguous listener ownership; preserved.'}
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($ids[0])";Owner $p;$line=$p.CommandLine -replace '/','\';$valid=$false
 if($Port -eq 18799){$valid=$p.ExecutablePath -ieq $node -and $line -match ('(?:^|\s)"?'+[Regex]::Escape($proxyPath)+'"?(?:\s|$)')}
 elseif($Port -eq 3080){$cli=Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js';$valid=$p.ExecutablePath -ieq $node -and $line -match [Regex]::Escape($cli) -and $line -match '(?:^|\s)web(?:\s|$)' -and ($line -notmatch '--port(?:[ =]|$)' -or $line -match '--port[ =]+3080(?:\s|$)')}
 elseif($Port -eq 18798){$valid=$p.ExecutablePath -ieq 'A:\llama.cpp\llama-server.exe' -and $line -match '--models-preset\s+"?A:\\llama\.cpp\\models\.ini"?(?:\s|$)' -and $line -match '--port[ =]+18798(?:\s|$)'}
 elseif($Port -eq 18810){$valid=[IO.Path]::GetFileName($p.ExecutablePath) -ieq 'python.exe' -and $line -match '(?:^|\s)-m\s+uvicorn\s+qwen-image-service:app(?:\s|$)' -and $line -match '--port[ =]+18810(?:\s|$)' -and $line -match '--host[ =]+127\.0\.0\.1(?:\s|$)'}
 if(!$valid){throw 'Listener executable/script differs from the reviewed service; preserved.'};return $p
}
function Supervisors {
 $pattern='(?:^|\s)-File\s+"?'+[Regex]::Escape($supervisorPath)+'"?(?:\s|$)'
 $processes=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -match $pattern})
 foreach($p in $processes){Owner $p;if($p.ExecutablePath -ine $powershell){throw 'Unexpected supervisor executable; preserved.'}}
 return $processes
}
function Stop-Observed($Process){
 if(!$Process){return};$current=Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.ProcessId)" -ErrorAction SilentlyContinue
 if(!$current){return};Owner $current;if(!(Same $Process $current)){throw 'Process identity changed before stop; preserved.'}
 Stop-Process -Id $current.ProcessId -ErrorAction Stop
 $deadline=(Get-Date).AddSeconds(8);do{$now=Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.ProcessId)" -ErrorAction SilentlyContinue;if(!(Same $Process $now)){return};Start-Sleep -Milliseconds 100}while((Get-Date) -lt $deadline)
 throw 'Exact owned process did not stop.'
}
function Fingerprint {
 $value=& $node $fingerprintPath $workRoot
 if($LASTEXITCODE -ne 0){throw 'Read-only Work fingerprint failed.'};return (($value -join "`n")|ConvertFrom-Json)
}
function Fingerprint-Equal($A,$B){foreach($key in @('tasks','artifacts','images','outputFiles','workSHA256','artifactSHA256','gallerySHA256','outputSHA256')){if((Field $A $key) -cne (Field $B $key)){return $false}};return $true}
function Assert-Idle {
 if(Test-Path -LiteralPath (Join-Path $SeekHome 'deployment.lock.json')){throw 'Deployment lock is present; recovery drill deferred.'}
 $state=Json '3080/work/api/updates';$helpers=Json '3080/work/api/helper-status';$progress=Json '3080/qwen-image/api/status';$image=Json '18810/health';$router=Json '18798/v1/models';$version=Json '3080/work/api/version'
 if($version.release -cne $ExpectedRelease -or !$image.available -or !($image.busy -is [bool])){throw 'Exact release or explicit image health is unavailable.'}
 $blocked=@($state.tasks|Where-Object {$_.status -in @('running','queued','waiting') -or (Field $_ 'handoff') -or (Field $_ 'approval') -or (Field $_ 'nativeRequest')})
 $queue=@((Field $progress 'queue')|Where-Object {$null -ne $_ -and !(Field $_ 'deferred')})
 if($blocked.Count -or $helpers.foregroundBusy -or $helpers.active -or $helpers.pending -or $progress.active -or $progress.recoveryRequired -or $image.busy -or (Field $image 'loading') -or (Field $image 'lease') -or $queue.Count -or @($router.data|Where-Object {$_.status.value -in @('loading','unloading')}).Count){throw 'Work/helper/image/model activity is present; recovery drill deferred.'}
}
function Assert-Protected {
 foreach($port in @(3080,18798,18810)){if(!(Same $baseline[$port] (Listener $port))){throw 'Protected web/router/image process identity changed.'}}
 $version=Json '3080/work/api/version';$router=Json '18798/v1/models';$image=Json '18810/health'
 if($version.release -cne $ExpectedRelease -or !$router.data -or !$image.available -or $image.busy -or (Field $image 'loading') -or (Field $image 'lease')){throw 'Protected web/router/image health changed; fault drill aborted.'}
}
function Public-Version {
 try{$response=Invoke-WebRequest ($origin+'/work/api/version') -Headers @{Cookie=$cookie} -TimeoutSec 3 -MaximumRedirection 0 -UseBasicParsing;if($response.StatusCode -ne 200){throw 'Not authenticated.'};$version=$response.Content|ConvertFrom-Json;if($version.release -cne $ExpectedRelease){throw 'Wrong release.'};return $version}catch{throw 'Authenticated read-only public version/session check failed.'}
}
function Establish-Session {
 param([string]$AuthOrigin=$origin,[string]$User=[Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User'),[string]$Password=[Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User'))
 if(!$user -or !$password){throw 'Authenticated recovery cookie or user-scoped proxy credentials required.'}
 Add-Type -AssemblyName System.Net.Http
 $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false;$handler.CookieContainer=[Net.CookieContainer]::new()
 $client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(4);$client.DefaultRequestHeaders.Add('Origin',$AuthOrigin);$client.DefaultRequestHeaders.Add('Referer',$AuthOrigin+'/login?next=%2Fwork')
 $page=$null;$response=$null;$form=$null
 try{
  $page=$client.GetAsync($AuthOrigin+'/login?next=%2Fwork').GetAwaiter().GetResult()
  if([int]$page.StatusCode -ne 200){throw 'Sign-in page unavailable.'}
  $html=$page.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  if($html -notmatch 'name="csrf" value="([^"<>]+)"'){throw 'Sign-in page nonce unavailable.'}
  $values=[Collections.Generic.Dictionary[string,string]]::new();$values.Add('csrf',$Matches[1]);$values.Add('username',$user);$values.Add('password',$password);$values.Add('next','/work')
  $form=[Net.Http.FormUrlEncodedContent]::new($values);$response=$client.PostAsync($AuthOrigin+'/login',$form).GetAwaiter().GetResult()
  if([int]$response.StatusCode -ne 303 -or $response.Headers.Location.OriginalString -ne '/work'){throw 'Sign-in did not complete.'}
  $session=$handler.CookieContainer.GetCookies([Uri]$AuthOrigin)['dsh_auth'];if(!$session -or !$session.Value){throw 'Session cookie unavailable.'}
  return 'dsh_auth='+$session.Value
 }catch{throw 'CSRF-protected public session establishment failed.'}finally{if($page){$page.Dispose()};if($response){$response.Dispose()};if($form){$form.Dispose()};$client.Dispose();$handler.Dispose();$password=$null}
}
function Start-Supervisor([int]$Interval){
 $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$supervisorPath+'" -SeekHome "'+$SeekHome+'" -IntervalSeconds '+$Interval
 $started=Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru
 $deadline=(Get-Date).AddSeconds(12);do{$found=@(Supervisors);if($found.Count -eq 1 -and $found[0].ProcessId -eq $started.Id){return $found[0]};Start-Sleep -Milliseconds 100}while((Get-Date) -lt $deadline)
 throw 'Expected sole supervisor did not acquire its named-mutex run.'
}
function Fresh-Supervisor-Health($Process,[switch]$AllowBusy){
 $earliest=[DateTimeOffset]($Process.CreationDate.ToUniversalTime());$deadline=(Get-Date).AddSeconds(12)
 do{
  $health=$null;try{$health=Get-Content -LiteralPath (Join-Path $SeekHome 'supervisor.json') -Raw|ConvertFrom-Json}catch{}
  if($health -and $health.at -ge $earliest.ToUnixTimeMilliseconds() -and $health.at -ge [DateTimeOffset]::UtcNow.AddSeconds(-35).ToUnixTimeMilliseconds() -and ($AllowBusy -or $health.idle -eq $true) -and $health.checks.web -eq $true -and $health.checks.router -eq $true -and $health.checks.image -eq $true -and $health.checks.proxy -eq $true -and !@($health.errors).Count -and !@($health.repairs).Count){return}
  Start-Sleep -Milliseconds 100
 }while((Get-Date) -lt $deadline)
 throw 'A fresh healthy idle supervisor report was not observed; proxy fault deferred.'
}
function Restore-Proxy {
 if(Listener 18799 -Optional){return}
 $env:DSH_HOME=$SeekHome;$env:DSH_WORK_HOME=$workRoot;$env:DSH_PROXY_USER=[Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User');$env:DSH_PROXY_PASS=[Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User')
 if(!$env:DSH_PROXY_USER -or !$env:DSH_PROXY_PASS){throw 'User-scoped proxy credentials unavailable for fallback.'}
 Remove-Item Env:DSH_PROXY_LISTEN_PORT,Env:DSH_PROXY_TARGET_PORT -ErrorAction SilentlyContinue
 Start-Process -FilePath $node -ArgumentList ('"'+$proxyPath+'"') -WorkingDirectory (Join-Path $SeekHome 'proxy') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $SeekHome 'proxy\proxy.log') -RedirectStandardError (Join-Path $SeekHome 'proxy\proxy.log.err')|Out-Null
 $deadline=(Get-Date).AddSeconds(12);do{if(Listener 18799 -Optional){return};Start-Sleep -Milliseconds 100}while((Get-Date) -lt $deadline)
 throw 'Proxy fallback did not become available.'
}

if(!(Test-Path -LiteralPath $supervisorPath) -or (Get-FileHash -LiteralPath $supervisorPath).Hash -cne (Get-FileHash -LiteralPath $sourceSupervisor).Hash){throw 'Installed supervisor differs from the reviewed source.'}
Assert-Idle
if(!$cookie){$cookie=Establish-Session}
if($cookie -notmatch '^dsh_auth=[A-Za-z0-9_.-]+$'){throw 'Invalid recovery cookie format.'}
Assert-Idle;$baseline=@{3080=(Listener 3080);18798=(Listener 18798);18810=(Listener 18810);18799=(Listener 18799)}
if($ExpectedRouterPid -and $baseline[18798].ProcessId -ne $ExpectedRouterPid){throw 'Router baseline PID differs; drill deferred.'}
$original=@(Supervisors);if($original.Count -ne 1){throw 'Recovery drill requires exactly one reviewed supervisor.'};Fresh-Supervisor-Health $original[0]
$before=Fingerprint;Public-Version|Out-Null
if(!$Apply){@{mode='plan-only';ready=$true;release=$ExpectedRelease;recoveryTimeoutSeconds=$RecoveryTimeoutSeconds;supervisor=(Identity $original[0]);proxy=(Identity $baseline[18799]);preservedData=$before;noGpuActions=$true}|ConvertTo-Json -Depth 5;exit 0}
try{
 Assert-Idle;Assert-Protected;Stop-Observed $original[0];$supervisorChanged=$true;$fast=Start-Supervisor 5
 Fresh-Supervisor-Health $fast;Assert-Idle;Assert-Protected
 $start=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$proxyFaulted=$true;Stop-Observed $baseline[18799]
 $deadline=(Get-Date).AddSeconds($RecoveryTimeoutSeconds);$repaired=$null;$repairEvidence=$false
 do{
  if((Get-Date) -gt $deadline.AddSeconds(-10)){break}
  Assert-Protected
  $candidate=Listener 18799 -Optional
  if($candidate){if(Same $baseline[18799] $candidate){throw 'Original proxy unexpectedly remained alive.'};if($candidate.ParentProcessId -ne $fast.ProcessId){throw 'Recovered proxy was not launched by the drill supervisor.'};$repaired=$candidate;Public-Version|Out-Null;$repairEvidence=$true;break}
  Start-Sleep -Milliseconds 200
 }while((Get-Date) -lt $deadline)
 if(!$repairEvidence){throw 'Automatic proxy recovery timed out.'}
 $after=Fingerprint;if(!(Fingerprint-Equal $before $after)){throw 'Work/gallery/artifact/output hashes changed during the drill.'}
 $elapsed=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$start
}catch{$failure=$_.Exception.Message}finally{
 if($proxyFaulted){try{if(!(Listener 18799 -Optional)){$manualFallback=$true;Restore-Proxy}}catch{$failure='Proxy manual fallback needs review.'}}
 if($supervisorChanged){try{$owned=@(Supervisors);foreach($p in $owned){Stop-Observed $p};$normal=Start-Supervisor 30;Fresh-Supervisor-Health $normal -AllowBusy;$normalRestored=$true}catch{$failure='Normal supervisor cadence restoration needs review.'}}
}
$finalProtected=$false;$finalData=$false;$finalSession=$false
try{Assert-Protected;$finalProtected=$true;$finalData=Fingerprint-Equal $before (Fingerprint);Public-Version|Out-Null;$finalSession=$true}catch{if(!$failure){$failure='Final preservation/session validation failed.'}}
$result=@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();release=$ExpectedRelease;passed=(!$failure -and !$manualFallback -and $normalRestored -and $finalProtected -and $finalData -and $finalSession);automaticProxyRecovery=[bool](Get-Variable repairEvidence -ValueOnly -ErrorAction SilentlyContinue);recoveryMs=$(if(Get-Variable elapsed -ErrorAction SilentlyContinue){$elapsed}else{$null});manualProxyFallback=$manualFallback;normalSupervisorCadenceRestored=$normalRestored;protectedWebRouterImageUnchanged=$finalProtected;dataHashesUnchanged=$finalData;authenticatedSessionSurvived=$finalSession;before=$before;noGpuActions=$true;failure=$failure}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath),($result|ConvertTo-Json -Depth 6));$cookie=$null
$result|ConvertTo-Json -Depth 6
if(!$result.passed){throw 'Proxy recovery smoke did not pass; inspect the sanitized report.'}
