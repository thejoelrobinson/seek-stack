[CmdletBinding()]
param(
 [string]$RepoRoot=(Split-Path -Parent $PSScriptRoot),
 [string]$SeekHome="$env:USERPROFILE\.dsh",
 [switch]$Apply,
 [switch]$StartNow
)
$ErrorActionPreference='Stop'
$RepoRoot=[IO.Path]::GetFullPath($RepoRoot)
$SeekHome=[IO.Path]::GetFullPath($SeekHome)
$node=(Get-Command node.exe -ErrorAction Stop).Source
$gh=(Get-Command gh.exe -ErrorAction Stop).Source
$powershell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$root=Join-Path $SeekHome 'release-publisher'
$files=@('dsh/tools/live-release.mjs','dsh/tools/release-policy.mjs','dsh/tools/release-process.mjs','desktop-bridge/scripts/release-files.mjs')
foreach($file in $files){if(!(Test-Path -LiteralPath (Join-Path $RepoRoot $file) -PathType Leaf)){throw "Missing reviewed publisher source: $file"}}
if(!$Apply){@{action='install-release-publisher';source=$RepoRoot;destination=$root;intervalMinutes=5;deployApp=$true;runAs=$env:USERNAME}|ConvertTo-Json;return}
New-Item -ItemType Directory -Path $root -Force|Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach($identity in @($sid,'S-1-5-18','S-1-5-32-544')){
 $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($identity)),[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
}
$currentAcl=Get-Acl -LiteralPath $root
$allowed=@($sid,'S-1-5-18','S-1-5-32-544')
$secure=$currentAcl.AreAccessRulesProtected -and $currentAcl.Access.Count -eq 3
foreach($entry in $currentAcl.Access){
 $identity=$entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
 if($identity -notin $allowed -or $entry.AccessControlType -ne 'Allow' -or $entry.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){$secure=$false}
}
if(!$secure){Set-Acl -LiteralPath $root -AclObject $acl}
foreach($file in $files){
 $target=Join-Path (Join-Path $root 'source') $file
 New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null
 Copy-Item -LiteralPath (Join-Path $RepoRoot $file) -Destination $target -Force
}
$utf8=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $root 'config.json'),(@{repoRoot=$RepoRoot;seekHome=$SeekHome;deployApp=$true;gh=$gh;powershell=$powershell;node=$node}|ConvertTo-Json),$utf8)
$runner=Join-Path $root 'run.ps1'
$code=@'
param([switch]$Loop)
$ErrorActionPreference='Stop'
$configPath=Join-Path $PSScriptRoot 'config.json'
$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
$log=Join-Path $PSScriptRoot 'publisher.log'
do {
 try {
  if((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5000000){Move-Item -LiteralPath $log -Destination ($log+'.previous') -Force}
  & $config.node (Join-Path $PSScriptRoot 'source/dsh/tools/live-release.mjs') $configPath 2>&1|Out-File -LiteralPath $log -Append -Encoding utf8
 }catch{($_.Exception.Message)|Out-File -LiteralPath $log -Append -Encoding utf8}
 if($Loop){Start-Sleep -Seconds 300}
}while($Loop)
'@
[IO.File]::WriteAllText($runner,$code,$utf8)
$user="$env:USERDOMAIN\$env:USERNAME"
$arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $runner
$mode='scheduled-task'
$existing=Get-ScheduledTask -TaskName 'SeekReleasePublisher' -ErrorAction SilentlyContinue
if($existing -and $existing.Principal.UserId -notin @($user,$sid,$env:USERNAME)){throw 'An existing release task belongs to another identity; preserved.'}
try {
 $action=New-ScheduledTaskAction -Execute $powershell -Argument $arguments
 $triggers=@((New-ScheduledTaskTrigger -AtLogOn -User $user),(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval ([TimeSpan]::FromMinutes(5))))
 $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::FromMinutes(45)) -MultipleInstances IgnoreNew
 $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
 Register-ScheduledTask -TaskName 'SeekReleasePublisher' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Publish tested Seek main commits and verified desktop downloads while Seek is idle.' -Force|Out-Null
 if($StartNow){Start-ScheduledTask -TaskName 'SeekReleasePublisher'}
}catch{
 if($_.Exception.Message -notmatch 'Access is denied|0x80070005'){throw}
 $mode='current-user-startup'
 $runPath='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
 $value='"'+$powershell+'" '+$arguments+' -Loop'
 $old=Get-ItemPropertyValue -LiteralPath $runPath -Name 'SeekReleasePublisher' -ErrorAction SilentlyContinue
 if($old -and $old -cne $value){throw 'A different publisher startup entry exists; preserved.'}
 New-Item -Path $runPath -Force|Out-Null
 Set-ItemProperty -LiteralPath $runPath -Name 'SeekReleasePublisher' -Value $value -Type String
 if($StartNow){Start-Process -FilePath $powershell -ArgumentList ($arguments+' -Loop') -WindowStyle Hidden|Out-Null}
}
@{mode=$mode;intervalMinutes=5;started=[bool]$StartNow;config=(Join-Path $root 'config.json');log=(Join-Path $root 'publisher.log')}|ConvertTo-Json -Compress
