# Default is a read-only plan. Parent task runs -Apply only after candidate validation.
[CmdletBinding()]
param(
 [string]$RepoRoot,
 [string]$SeekHome="$env:USERPROFILE\.dsh",
 [string]$TrustedHost='seek.joelcrobinson.com',
 # 0 = no PID pin. A fixed PID broke after every reboot or router restart; the router is still
 # verified by executable path and owner, and deployment never stops it.
 [int]$ExpectedRouterPid=0,
 [string]$RouterPreset='A:\llama.cpp\models.ini',
 [string]$RollbackBackupPath,
 [string]$DesktopRuntimeRoot,
 [switch]$ViewerOnly,
 [switch]$IncludeProxy,
 [switch]$Apply,
 [switch]$RegisterSupervisor,
 # A task that is only waiting for the user's reply keeps its question across a restart. With this
 # switch such tasks do not hold a release back; a browser handoff, approval or native request in
 # flight, and running or queued work, still do.
 [switch]$AllowWaitingTasks
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2
if([string]::IsNullOrWhiteSpace($RepoRoot)){$RepoRoot=Join-Path (Split-Path -Parent $PSCommandPath) '..\..\..'}
$RepoRoot=[IO.Path]::GetFullPath($RepoRoot);$SeekHome=[IO.Path]::GetFullPath($SeekHome)
$node=(Get-Command node.exe -ErrorAction Stop).Source
$cli=Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$helper=Join-Path $PSScriptRoot 'release-data.mjs'
$workRoot=Join-Path $SeekHome 'work';$profile=Join-Path $SeekHome 'browser\profile'
$backups=Join-Path $SeekHome 'browser\backups';$lockPath=Join-Path $SeekHome 'deployment.lock.json'
$startup=Join-Path $env:USERPROFILE 'start-seek.ps1'
$releaseId='best-in-class-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)
$script:manifest=$null;$script:backup=$null;$script:stopped=$false;$script:proxyStopped=$false;$script:lockOwned=$false

function Under([string]$Base,[string]$Path){
 $full=[IO.Path]::GetFullPath($Path);$prefix=[IO.Path]::GetFullPath($Base).TrimEnd('\')+'\'
 if(!$full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Release path escaped its declared root.'}
 return $full
}
# A service that is still starting (the image runner takes minutes after a restart) refuses
# connections: wait for it. Any HTTP answer, including an expected 404, returns to the caller as before.
function Json([string]$Url){
 $deadline=(Get-Date).AddSeconds(90)
 while($true){
  try{return Invoke-RestMethod $Url -TimeoutSec 7}
  catch{if((Field $_.Exception 'Response') -or (Get-Date) -gt $deadline){throw};Start-Sleep -Seconds 3}
 }
}
function Field([object]$Value,[string]$Name){if($null -eq $Value){return $null};if($Value -is [Collections.IDictionary]){if($Value.Contains($Name)){return $Value[$Name]};return $null};$property=$Value.PSObject.Properties[$Name];if($property){return $property.Value};return $null}
function To-Record([object]$Value){
 if($Value -is [Management.Automation.PSCustomObject]){$record=@{};foreach($property in $Value.PSObject.Properties){$record[$property.Name]=To-Record $property.Value};return $record}
 if($Value -is [Array]){$array=@();foreach($item in $Value){$array+=,(To-Record $item)};return ,$array}
 return $Value
}
function Run-Data([string[]]$Arguments){
 $output=& $node $helper @Arguments
 if($LASTEXITCODE -ne 0){throw ('Release data verification failed: '+$Arguments[0])}
 return (($output -join "`n")|ConvertFrom-Json)
}
function Owner([object]$Process){
 $value=Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid
 if($value.ReturnValue -ne 0 -or $value.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Service listener belongs to another Windows identity; preserved.'}
}
function Owned-Console([object]$Child,[object]$Parent){
 if($Child.ExecutablePath -ine (Join-Path $env:WINDIR 'System32\conhost.exe') -or $Child.ParentProcessId -ne $Parent.ProcessId -or [Math]::Abs(($Child.CreationDate-$Parent.CreationDate).TotalSeconds) -gt 5){return $false}
 try{Owner $Child;return $true}catch{return $false}
}
function Listener([int]$Port,[string]$Kind,[switch]$Optional){
 $ports=@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
 if(!$ports.Count){if($Optional){return $null};throw "$Kind listener is missing on $Port."}
 $owners=@($ports.OwningProcess|Select-Object -Unique);if($owners.Count -ne 1){throw "Ambiguous listener ownership on $Port."}
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($owners[0])";Owner $p
 $line=(($p.CommandLine -replace '/','\') -replace '\\{2,}','\');$exe=[IO.Path]::GetFullPath($p.ExecutablePath)
 $valid=$false
 if($Kind -eq 'web'){$valid=$exe -ieq $node -and $line -match [Regex]::Escape($cli) -and $line -match '(?:^|\s)web(?:\s|$)' -and ($line -notmatch '--port(?:[ =]|$)' -or $line -match '--port[ =]+3080(?:\s|$)')}
 elseif($Kind -eq 'proxy'){$valid=$exe -ieq $node -and $line -match [Regex]::Escape((Join-Path $SeekHome 'proxy\server.js'))}
 elseif($Kind -eq 'image'){$valid=[IO.Path]::GetFileName($exe) -ieq 'python.exe' -and $line -match '(?:^|\s)-m\s+uvicorn\s+qwen-image-service:app(?:\s|$)' -and $line -match '--port[ =]+18810(?:\s|$)' -and $line -match '--host[ =]+127\.0\.0\.1(?:\s|$)'}
 elseif($Kind -eq 'router'){$valid=$exe -ieq 'A:\llama.cpp\llama-server.exe' -and $line -match [Regex]::Escape($RouterPreset) -and $line -match '--models-preset(?:\s|=)' -and $line -match '--port[ =]+18798(?:\s|$)'}
 if(!$valid){throw "Unrecognized $Kind process on $Port; preserved."}
 return $p
}
function Stop-Owned([object]$Process){
 if(!$Process){return}
 $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.ProcessId)" -ErrorAction SilentlyContinue
 if(!$current){return}
 if($current.CreationDate -ne $Process.CreationDate -or $current.ExecutablePath -ine $Process.ExecutablePath -or $current.CommandLine -cne $Process.CommandLine){throw 'Process identity changed before stop; preserved.'}
 Owner $current
 Stop-Process -Id $current.ProcessId -ErrorAction Stop
 $deadline=(Get-Date).AddSeconds(15)
 while((Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
 if(Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue){throw 'Owned process did not stop.'}
}
function Assert-Idle {
 $state=Json 'http://127.0.0.1:3080/work/api/state';$helpers=Json 'http://127.0.0.1:3080/work/api/helper-status'
 $images=Json 'http://127.0.0.1:3080/qwen-image/api/status';$runner=@{};if(!$ViewerOnly){$runner=Json 'http://127.0.0.1:18810/health'}
 try{$progress=Json 'http://127.0.0.1:3080/qwen-image/api/progress'}catch{if($_.Exception.Response.StatusCode.value__ -ne 404){throw};$progress=$images}
 $held=@('running','queued');if(-not $AllowWaitingTasks){$held+='waiting'}
 $blocking=@($state.tasks|Where-Object {$_.status -in $held -or (Field $_ 'handoff') -or (Field $_ 'approval') -or (Field $_ 'nativeRequest') -or (Field $_ 'desktopAsk')})
 $queue=Field $progress 'queue';$activeQueue=@($queue|Where-Object {$null -ne $_ -and !(Field $_ 'deferred')})
 $runnerChildren=@();if(!$ViewerOnly){$ownedRunner=Listener 18810 'image';$runnerChildren=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($ownedRunner.ProcessId)"|Where-Object {!(Owned-Console $_ $ownedRunner)})}
 if($blocking.Count -or $helpers.foregroundBusy -or $helpers.active -or $helpers.pending -or $images.active -or $images.recoveryRequired -or (Field $progress 'active') -or (Field $runner 'busy') -or (Field $runner 'loading') -or (Field $runner 'lease') -or $activeQueue.Count -or $runnerChildren.Count){throw 'Seek has active, queued, waiting, native, image or model work; deployment deferred.'}
 $router=Json 'http://127.0.0.1:18798/v1/models'
 if(@($router.data|Where-Object {$_.status.value -in @('loading','unloading')}).Count){throw 'Router is switching models; deployment deferred.'}
 return @{tasks=@($state.tasks).Count;images=[int]$images.history;loaded=@($router.data|Where-Object {$_.status.value -eq 'loaded'}|ForEach-Object {$_.id})}
}
function Private-Directory([string]$Path){
 New-Item -ItemType Directory -Path $Path -Force|Out-Null
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){
  $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $Path -AclObject $acl
}
function Save-Manifest {
 if(!$script:manifest){return}
 $path=Join-Path $script:backup 'manifest.json';$temporary=$path+'.tmp'
 [IO.File]::WriteAllText($temporary,($script:manifest|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
 Move-Item -LiteralPath $temporary -Destination $path -Force
}
function Atomic-Copy([string]$Source,[string]$Target){
 $Target=Under $SeekHome $Target
 New-Item -ItemType Directory -Path (Split-Path $Target -Parent) -Force|Out-Null
 $tmp=$Target+'.release-'+$releaseId+'.tmp';Copy-Item -LiteralPath $Source -Destination $tmp
 if((Get-FileHash -LiteralPath $Source).Hash -ne (Get-FileHash -LiteralPath $tmp).Hash){throw 'Staged release copy failed its hash check.'}
 Move-Item -LiteralPath $tmp -Destination $Target -Force
}
function Source-Files {
 $list=@()
 # DSH 0.2: local plugins live in the web profile's own node_modules (installed by `dsh plugin add`).
 foreach($plugin in @('browser-viewer','qwen-image','web-search-chrome-mcp')){
  if($ViewerOnly -and $plugin -ne 'browser-viewer'){continue}
  $source=Join-Path $RepoRoot ('dsh\plugins\'+$plugin);$target=Join-Path $SeekHome ('profiles\web\node_modules\@deepseek-ai\dsh-'+$plugin)
  foreach($directory in @('lib','skills')){if(Test-Path -LiteralPath (Join-Path $source $directory)){
   foreach($file in Get-ChildItem -LiteralPath (Join-Path $source $directory) -File -Recurse){$suffix=$file.FullName.Substring($source.Length).TrimStart('\');$list+=@{source=$file.FullName;target=(Under $SeekHome (Join-Path $target $suffix));hash=(Get-FileHash -LiteralPath $file.FullName).Hash;remove=$false}}
   if(Test-Path -LiteralPath (Join-Path $target $directory)){foreach($file in Get-ChildItem -LiteralPath (Join-Path $target $directory) -File -Recurse){$suffix=$file.FullName.Substring($target.Length).TrimStart('\');if(!(Test-Path -LiteralPath (Join-Path $source $suffix))){$list+=@{source=$null;target=(Under $SeekHome $file.FullName);hash=(Get-FileHash -LiteralPath $file.FullName).Hash;remove=$true}}}}
  }}
  foreach($name in @('package.json','README.md')){if(Test-Path -LiteralPath (Join-Path $source $name)){$file=Join-Path $source $name;$list+=@{source=$file;target=(Under $SeekHome (Join-Path $target $name));hash=(Get-FileHash -LiteralPath $file).Hash;remove=$false}}}
 }
 if(!$ViewerOnly){foreach($pair in @(@('dsh\tools\qwen-image-service.py','tools\qwen-image-service.py'),@('dsh\proxy\server.js','proxy\server.js'),@('dsh\proxy\work-session-store.cjs','proxy\work-session-store.cjs'),@('scheduled-task\supervise-seek-v2.ps1','supervise-seek.ps1'),@('scheduled-task\register-seeksupervisor.ps1','register-seeksupervisor.ps1'))){$file=Join-Path $RepoRoot $pair[0];$list+=@{source=$file;target=(Under $SeekHome (Join-Path $SeekHome $pair[1]));hash=(Get-FileHash -LiteralPath $file).Hash;remove=$false}}}
 elseif($IncludeProxy){foreach($pair in @(@('dsh\proxy\server.js','proxy\server.js'),@('dsh\proxy\work-session-store.cjs','proxy\work-session-store.cjs'))){$file=Join-Path $RepoRoot $pair[0];$list+=@{source=$file;target=(Under $SeekHome (Join-Path $SeekHome $pair[1]));hash=(Get-FileHash -LiteralPath $file).Hash;remove=$false}}}
 if($DesktopRuntimeRoot){
  $runtime=Under $RepoRoot ([IO.Path]::GetFullPath($DesktopRuntimeRoot));$pluginSource=Join-Path $RepoRoot 'dsh\plugins\browser-viewer';$pluginTarget=Join-Path $SeekHome 'profiles\web\node_modules\@deepseek-ai\dsh-browser-viewer'
  foreach($name in @('package.json','package-lock.json')){if((Get-FileHash -LiteralPath (Join-Path $runtime $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $pluginSource $name)).Hash){throw 'Staged desktop runtime differs from the tested plugin lockfile.'}}
  $lock=Join-Path $runtime 'package-lock.json';$list+=@{source=$lock;target=(Under $SeekHome (Join-Path $pluginTarget 'package-lock.json'));hash=(Get-FileHash -LiteralPath $lock).Hash;remove=$false;runtime=$true}
  foreach($file in Get-ChildItem -LiteralPath (Join-Path $runtime 'node_modules') -File -Recurse){$suffix=$file.FullName.Substring($runtime.Length).TrimStart('\');$list+=@{source=$file.FullName;target=(Under $SeekHome (Join-Path $pluginTarget $suffix));hash=(Get-FileHash -LiteralPath $file.FullName).Hash;remove=$false;runtime=$true}}
 }
 return $list
}
function Validate-Source([object[]]$Files){
 foreach($file in $Files){
  if($file.remove){continue}
  if($file.ContainsKey('runtime') -and $file.runtime){continue}
  if($file.source -match '\.(js|cjs|mjs)$'){& $node --check $file.source;if($LASTEXITCODE -ne 0){throw 'Source JavaScript syntax failed.'}}
  elseif($file.source -match '\.ps1$'){$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile($file.source,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw ('Source PowerShell syntax failed: '+$file.source)}}
 }
 if($ViewerOnly){return}
 & (Get-Command python.exe).Source -c "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())" (Join-Path $RepoRoot 'dsh\tools\qwen-image-service.py')
 if($LASTEXITCODE -ne 0){throw 'Source Python syntax failed.'}
}
function Backup-Code([object[]]$Files){
 $number=0;foreach($file in $Files){$name=('code\{0:D4}' -f $number++);$save=Join-Path $script:backup $name;$exists=Test-Path -LiteralPath $file.target
  if($exists){New-Item -ItemType Directory -Path (Split-Path $save -Parent) -Force|Out-Null;Copy-Item -LiteralPath $file.target -Destination $save}
  $script:manifest.files+=@{target=$file.target;backup=$name;existed=[bool]$exists;previousHash=$(if($exists){(Get-FileHash -LiteralPath $save).Hash}else{$null});installedHash=$file.hash}
 }
}
function Preserve-Configs {
 $sources=@((Join-Path $SeekHome 'settings.yaml'),(Join-Path $SeekHome 'cordis.patch.yml'),(Join-Path $SeekHome 'profiles\web\cordis.patch.yml'),(Join-Path $SeekHome 'seek.config.ps1'),(Join-Path $SeekHome 'proxy\.secret'),$RouterPreset,$startup,(Join-Path $SeekHome 'work\backups\key.dpapi'),(Join-Path $SeekHome 'work\backups\status.json'))
 $index=0;foreach($source in $sources){if(Test-Path -LiteralPath $source){$target=Join-Path $script:backup ('configs\'+$index++);New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force|Out-Null;Copy-Item -LiteralPath $source -Destination $target;$script:manifest.configs+=@{source=$source;backup=('configs\'+($index-1));hash=(Get-FileHash -LiteralPath $target).Hash}}}
}
function Patch-Startup {
 if($ViewerOnly){return}
 if(!(Test-Path -LiteralPath $startup)){return}
 $old=[IO.File]::ReadAllText($startup);$needle='$stale = Get-Process llama-server -ErrorAction SilentlyContinue'
 if(!$old.Contains($needle) -and !$old.Contains('# Seek owned router guard')){throw 'Startup router-kill text differs; inspect it before changing the live startup script.'}
 $replacement=@'
# Seek owned router guard: preserve foreign llama-server processes and reused PIDs.
    $stale = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object {
      $_.ExecutablePath -ieq 'A:\llama.cpp\llama-server.exe' -and
      $_.CommandLine -match '--models-preset\s+"?A:\\llama\.cpp\\models\.ini"?(?:\s|$)' -and
      $_.CommandLine -match '--port[ =]+18798(?:\s|$)' -and
      (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    } | ForEach-Object {
      $observed = $_
      $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($observed.ProcessId)"
      if ($current.CreationDate -eq $observed.CreationDate -and $current.ExecutablePath -ieq $observed.ExecutablePath -and $current.CommandLine -ceq $observed.CommandLine) {
        Get-Process -Id $current.ProcessId -ErrorAction Stop
      }
    })
'@
 $updated=$old.Replace($needle,$replacement.Trim())
 if(!$updated.Contains('# Seek deployment guard')){
  $anchor='$ErrorActionPreference = "Stop"'
  if(!$updated.Contains($anchor)){throw 'Actual startup preamble differs; inspect it before adding the deployment guard.'}
  $guard=@'
# Seek deployment guard: the release intentionally stops owned listeners.
$seekDeploymentLock = '__SEEK_HOME__\deployment.lock.json'
if (Test-Path -LiteralPath $seekDeploymentLock) {
  try {
    $seekReleaseLease = Get-Content -LiteralPath $seekDeploymentLock -Raw | ConvertFrom-Json
    if ($seekReleaseLease.expiresAt -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { return }
  } catch { return }
}
'@
  $guard=$guard.Replace('__SEEK_HOME__',$SeekHome.Replace("'","''"))
  $updated=$updated.Replace($anchor,($anchor+"`r`n"+$guard))
 }
 $tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseInput($updated,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw 'Patched startup script failed syntax validation.'}
 $tmp=Join-Path $script:backup 'startup-patched.ps1';[IO.File]::WriteAllText($tmp,$updated,[Text.UTF8Encoding]::new($false))
 # Startup is outside SeekHome and explicitly named by this release.
 $target=[IO.Path]::GetFullPath($startup);if($target -ine (Join-Path $env:USERPROFILE 'start-seek.ps1')){throw 'Unexpected startup path.'}
 Copy-Item -LiteralPath $tmp -Destination ($target+'.release.tmp');Move-Item -LiteralPath ($target+'.release.tmp') -Destination $target -Force
 $script:manifest.startupPatched=$true
}
function Close-OwnedBrowser([object]$Web){
 $chrome=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|Where-Object {$_.ParentProcessId -eq $Web.ProcessId -and $_.CommandLine -match [Regex]::Escape($profile)})
 if(!$chrome.Count){
  $other=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|Where-Object {$_.CommandLine -match [Regex]::Escape($profile)})
  if($other.Count){throw 'Browser profile is held by an unowned Chrome; preserved.'};return
 }
 if($chrome.Count -ne 1){throw 'Ambiguous owned Chrome root; preserved.'};Owner $chrome[0]
 Run-Data @('close-browser',$profile,(Join-Path $script:backup 'browser-tabs.json'))|Out-Null
 $deadline=(Get-Date).AddSeconds(15);while((Get-Process -Id $chrome[0].ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
 if(Get-Process -Id $chrome[0].ProcessId -ErrorAction SilentlyContinue){throw 'Browser still owns its profile; backup deferred.'}
}
function Supervisor-Processes {
 $path=Join-Path $SeekHome 'supervise-seek.ps1';$pattern='(?:^|\s)-File\s+"?'+[Regex]::Escape($path)+'"?(?:\s|$)'
 return @(Get-CimInstance Win32_Process|Where-Object {$_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -match $pattern})
}
function Start-Components([string]$Python){
 $env:DSH_HOME=$SeekHome;$env:DSH_WORK_HOME=$workRoot;$env:DSH_BROWSER_USER_DATA_DIR=$profile
 $env:LOCAL_LLM_API_KEY=[Environment]::GetEnvironmentVariable('LOCAL_LLM_API_KEY','User')
 $env:SEEK_IMAGE_ENGINE_ROOT=Join-Path $SeekHome 'image-engine'
 Remove-Item Env:DSH_PROXY_LISTEN_PORT,Env:DSH_PROXY_TARGET_PORT,Env:DSH_WORK_TEST_ROOT -ErrorAction SilentlyContinue
 if(!$ViewerOnly -and !(Listener 18810 'image' -Optional)){Start-Process -FilePath $Python -ArgumentList '-m','uvicorn','qwen-image-service:app','--host','127.0.0.1','--port','18810' -WorkingDirectory (Join-Path $SeekHome 'tools') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $SeekHome 'image-engine\runner.log') -RedirectStandardError (Join-Path $SeekHome 'image-engine\runner.err')|Out-Null}
 if(!(Listener 3080 'web' -Optional)){Start-Process -FilePath $node -ArgumentList ('"'+$cli+'"'),'web','--no-open','--trusted-host',$TrustedHost -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $SeekHome 'web.log') -RedirectStandardError (Join-Path $SeekHome 'web.log.err')|Out-Null}
}
function Start-Proxy {
 $env:DSH_PROXY_USER=[Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User');$env:DSH_PROXY_PASS=[Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User')
 if(!$env:DSH_PROXY_USER -or !$env:DSH_PROXY_PASS){throw 'User-scoped proxy credentials are unavailable; front door stays closed.'}
 if(!(Listener 18799 'proxy' -Optional)){Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $SeekHome 'proxy\server.js')+'"') -WorkingDirectory (Join-Path $SeekHome 'proxy') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $SeekHome 'proxy\proxy.log') -RedirectStandardError (Join-Path $SeekHome 'proxy\proxy.log.err')|Out-Null}
}
function Wait-Healthy([string]$ExpectedRelease){
 $deadline=(Get-Date).AddSeconds(100);$ready=$false
 do{try{$version=Json 'http://127.0.0.1:3080/work/api/version';$runner=@{available=$true};if(!$ViewerOnly){$runner=Json 'http://127.0.0.1:18810/health'};$ready=[bool]$version.release -and [bool]$runner.available -and (!$ExpectedRelease -or $version.release -eq $ExpectedRelease)}catch{$ready=$false};if(!$ready){Start-Sleep -Milliseconds 500}}while(!$ready -and (Get-Date) -lt $deadline)
 if(!$ready){throw 'Work or image runner did not become healthy with the expected release.'}
 Listener 3080 'web'|Out-Null;if(!$ViewerOnly){Listener 18810 'image'|Out-Null}
 return $version
}
function Router-Unchanged {
 $current=Listener 18798 'router'
 if($current.ProcessId -ne $script:manifest.router.pid -or $current.CreationDate.ToString('o') -ne $script:manifest.router.created -or (Get-FileHash -LiteralPath $RouterPreset).Hash -ne $script:manifest.router.presetHash){throw 'Router identity or SSD preset changed; no model commands were sent by this release.'}
 $loaded=@((Json 'http://127.0.0.1:18798/v1/models').data|Where-Object {$_.status.value -eq 'loaded'}|ForEach-Object {$_.id})
 if(($loaded|Sort-Object|ConvertTo-Json -Compress) -cne ($script:manifest.router.loaded|Sort-Object|ConvertTo-Json -Compress)){throw 'Loaded router model changed during release; inspect model ownership before opening the front door.'}
}
function Restore-Code {
 foreach($file in $script:manifest.files){$target=Under $SeekHome $file.target;$save=Under $script:backup (Join-Path $script:backup $file.backup)
  if($file.existed){if((Get-FileHash -LiteralPath $save).Hash -ne $file.previousHash){throw 'Rollback backup code hash failed.'};Atomic-Copy $save $target}
  elseif(Test-Path -LiteralPath $target){if((Get-FileHash -LiteralPath $target).Hash -ne $file.installedHash){throw 'New release file changed; preserve it for review.'};Remove-Item -LiteralPath $target}
 }
 # Keep the model-independent ownership/deployment guards during code rollback.
 # The exact original startup script remains in the private config backup.
}
function Rollback-Code([string]$Python,[string]$ProtectedInventory){
 Stop-Owned (Listener 18799 'proxy' -Optional);Stop-Owned (Listener 3080 'web' -Optional);if(!$ViewerOnly){Stop-Owned (Listener 18810 'image' -Optional)}
 Run-Data @('portable-rollback',$workRoot)|Out-Null
 Restore-Code;Start-Components $Python;Wait-Healthy ''|Out-Null
 Run-Data @('compare',$ProtectedInventory,$workRoot)|Out-Null;Router-Unchanged;Start-Proxy
 $script:manifest.phase='rolled-back-current-data-preserved';Save-Manifest
}

if(!(Test-Path -LiteralPath $cli) -or !(Test-Path -LiteralPath $helper)){throw 'Release prerequisites are missing.'}
$files=@();$expected=$null
if(!$RollbackBackupPath){$files=@(Source-Files);Validate-Source $files;$expected=Run-Data @('release',$RepoRoot)}
$gate=Assert-Idle;$web=Listener 3080 'web';$proxy=Listener 18799 'proxy';$image=$null;if(!$ViewerOnly){$image=Listener 18810 'image'};$router=Listener 18798 'router'
if($ExpectedRouterPid -and $router.ProcessId -ne $ExpectedRouterPid){throw 'Router PID differs from the reviewed release baseline; refresh the baseline first.'}
$python=$null;if($image){$python=$image.ExecutablePath;if(!(Test-Path -LiteralPath $python)){throw 'Owned runner Python executable is unavailable.'}}
# Uvicorn on Windows may have a venv launcher parent. Capture only the exact same-user invocation.
$imageParent=$null;$candidateParent=$null;if($image){$candidateParent=Get-CimInstance Win32_Process -Filter "ProcessId=$($image.ParentProcessId)" -ErrorAction SilentlyContinue}
if($candidateParent -and $candidateParent.ExecutablePath -ieq (Join-Path $SeekHome 'image-engine\.venv\Scripts\python.exe') -and $candidateParent.CommandLine -match '-m\s+uvicorn\s+qwen-image-service:app' -and $candidateParent.CommandLine -match '--port[ =]+18810(?:\s|$)'){
 Owner $candidateParent;$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($candidateParent.ProcessId)")
 $others=@($children|Where-Object {$_.ProcessId -ne $image.ProcessId -and !(Owned-Console $_ $candidateParent)})
 if($others.Count -or !@($children|Where-Object {$_.ProcessId -eq $image.ProcessId}).Count){throw 'Runner venv parent owns additional children; preserve it.'};$imageParent=$candidateParent;$python=$candidateParent.ExecutablePath
}
$summary=Run-Data @('inventory',$workRoot)
if(!$Apply){@{mode='plan-only';release=$expected;history=$summary;gate=$gate;routerPid=$router.ProcessId;python=$python;backupParent=$backups;supervisorRegistration=[bool]$RegisterSupervisor;rollback=$RollbackBackupPath;unattendedBoot=$false}|ConvertTo-Json -Depth 6;exit 0}
if(!(Test-Path -LiteralPath $startup)){throw 'Actual startup script is missing; inspect the operational baseline.'}
$mutex=New-Object Threading.Mutex($false,'Local\SeekStackDeployment')
if(!$mutex.WaitOne(0)){throw 'Another deployment owns the release lock.'}
try{
 if(Test-Path -LiteralPath $lockPath){throw 'An earlier deployment lock exists; inspect its manifest and owner before retrying.'}
 $lock=New-Object IO.FileStream($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes((@{pid=$PID;created=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o');release=$releaseId;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(20).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress));$lock.Write($bytes,0,$bytes.Length);$lock.Flush($true)}finally{$lock.Dispose()};$script:lockOwned=$true
 if($RollbackBackupPath){
  $script:backup=Under $backups $RollbackBackupPath;$script:manifest=To-Record (Get-Content -Raw -LiteralPath (Join-Path $script:backup 'manifest.json')|ConvertFrom-Json)
  $fresh=Join-Path $script:backup ('rollback-current-inventory-'+$releaseId+'.json');Run-Data @('inventory',$workRoot,$fresh)|Out-Null
  Rollback-Code $python $fresh
 }else{
  $script:backup=Under $backups (Join-Path $backups $releaseId);Private-Directory $script:backup
  $script:manifest=@{schema=1;release=$releaseId;phase='prepared';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();expected=$expected;files=@();configs=@();startupPatched=$false;router=@{pid=$router.ProcessId;created=$router.CreationDate.ToString('o');preset=$RouterPreset;presetHash=(Get-FileHash -LiteralPath $RouterPreset).Hash;loaded=$gate.loaded};python=$python;preflight=$summary}
  Backup-Code $files;Preserve-Configs;Save-Manifest
  Copy-Item -LiteralPath $PSCommandPath,$helper -Destination $script:backup
  $rollback='& '+"'"+(Join-Path $script:backup 'deploy.ps1').Replace("'","''")+"' -RepoRoot '"+$RepoRoot.Replace("'","''")+"' -SeekHome '"+$SeekHome.Replace("'","''")+"' -Apply -RollbackBackupPath '"+$script:backup.Replace("'","''")+"'"+$(if($ViewerOnly){' -ViewerOnly'}else{''})+$(if($IncludeProxy){' -IncludeProxy'}else{''})+"`n"
  [IO.File]::WriteAllText((Join-Path $script:backup 'rollback.ps1'),$rollback,[Text.UTF8Encoding]::new($false))
  Patch-Startup;Save-Manifest
  Assert-Idle|Out-Null;foreach($supervisor in Supervisor-Processes){Owner $supervisor;Stop-Owned $supervisor};Stop-Owned $proxy;$script:proxyStopped=$true
  Assert-Idle|Out-Null;Close-OwnedBrowser $web;Assert-Idle|Out-Null
  Stop-Owned $web;$script:stopped=$true;Stop-Owned $image;Stop-Owned $imageParent
  $protected=Join-Path $script:backup 'protected-inventory.json';$script:manifest.finalBaseline=Run-Data @('inventory',$workRoot,$protected)
  $script:manifest.workBackup=Run-Data @('snapshot',$workRoot,(Join-Path $script:backup 'work'),'exclude-backups')
  Run-Data @('verify-snapshot',(Join-Path $script:backup 'work'))|Out-Null
  if(Test-Path -LiteralPath $profile){$script:manifest.browserBackup=Run-Data @('snapshot',$profile,(Join-Path $script:backup 'browser-profile'));Run-Data @('verify-snapshot',(Join-Path $script:backup 'browser-profile'))|Out-Null}
  $script:manifest.phase='backed-up-and-stopped';Save-Manifest
  foreach($file in $files){if($file.remove){if((Get-FileHash -LiteralPath $file.target).Hash -ne $file.hash){throw 'Obsolete installed file changed; preserve it for review.'};Remove-Item -LiteralPath (Under $SeekHome $file.target)}else{if((Get-FileHash -LiteralPath $file.source).Hash -ne $file.hash){throw 'Source changed after validation; rebuild the release plan.'};Atomic-Copy $file.source $file.target}}
  Patch-Startup;$script:manifest.phase='installed';Save-Manifest
  Start-Components $python;$script:manifest.actualVersion=Wait-Healthy $expected.release
  $script:manifest.validation=Run-Data @('compare',$protected,$workRoot);Router-Unchanged
  Start-Proxy;$deadline=(Get-Date).AddSeconds(20)
  do{try{$ok=(Invoke-WebRequest 'http://127.0.0.1:18799/login' -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200}catch{$ok=$false};if(!$ok){Start-Sleep -Milliseconds 500}}while(!$ok -and (Get-Date) -lt $deadline)
  if(!$ok){throw 'Auth proxy did not become healthy.'};Listener 18799 'proxy'|Out-Null
  if($RegisterSupervisor){try{$registration=& (Join-Path $SeekHome 'register-seeksupervisor.ps1') -ScriptPath (Join-Path $SeekHome 'supervise-seek.ps1') -StartNow;$script:manifest.supervisorRegistration=$registration}catch{$script:manifest.supervisorError=$_.Exception.Message}}
  $script:manifest.phase='complete';Save-Manifest
  if($RegisterSupervisor -and !(Field $script:manifest 'supervisorError')){
   Remove-Item -LiteralPath (Under $SeekHome $lockPath);$script:lockOwned=$false
   $deadline=(Get-Date).AddSeconds(40);$health=$null;$running=@()
   do{$running=@(Supervisor-Processes);try{$health=Get-Content -LiteralPath (Join-Path $SeekHome 'supervisor.json') -Raw|ConvertFrom-Json}catch{$health=$null};if($running.Count -ne 1 -or !$health -or $health.at -lt $script:manifest.at){Start-Sleep -Milliseconds 500}}while(($running.Count -ne 1 -or !$health -or $health.at -lt $script:manifest.at) -and (Get-Date) -lt $deadline)
   if($running.Count -ne 1 -or !$health -or $health.at -lt $script:manifest.at){$script:manifest.supervisorError='Supervisor startup needs review; the validated app remains available.'}else{$script:manifest.supervisorHealth=$health}
   Save-Manifest
  }
 }
 @{phase=$script:manifest.phase;backup=$script:backup;release=$script:manifest.expected;history=$script:manifest.validation;routerPid=$script:manifest.router.pid;unattendedBoot=$false}|ConvertTo-Json -Depth 6
}catch{
 $reason=$_.Exception.Message
 if($script:manifest){$script:manifest.error=$reason;Save-Manifest}
 if($script:stopped -and !$RollbackBackupPath){
  try{Rollback-Code $python (Join-Path $script:backup 'protected-inventory.json')}catch{if($script:manifest){$script:manifest.phase='rollback-needs-review';$script:manifest.rollbackError=$_.Exception.Message;Save-Manifest};throw ('Release failed: '+$reason+'. Automatic rollback also needs review; the front door remains closed. Private manifest: '+$script:backup)}
 }elseif($script:proxyStopped){Start-Proxy}
 throw ('Release failed: '+$reason+'. Private backup: '+$script:backup)
}finally{
 if($script:lockOwned -and (!$script:manifest -or $script:manifest.phase -ne 'rollback-needs-review')){Remove-Item -LiteralPath (Under $SeekHome $lockPath) -ErrorAction SilentlyContinue}
 $mutex.ReleaseMutex();$mutex.Dispose()
}
