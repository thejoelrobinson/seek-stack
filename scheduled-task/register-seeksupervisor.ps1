param([string]$ScriptPath="$env:USERPROFILE\.dsh\supervise-seek.ps1",[switch]$StartNow)
$ErrorActionPreference='Stop'
$ScriptPath=[IO.Path]::GetFullPath($ScriptPath)
$expected=[IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.dsh\supervise-seek.ps1'))
if($ScriptPath -ine $expected -or !(Test-Path -LiteralPath $ScriptPath -PathType Leaf)){throw 'Supervisor registration requires the reviewed script in this user''s .dsh directory.'}
$tokens=$null;$errors=$null
[Management.Automation.Language.Parser]::ParseFile($ScriptPath,[ref]$tokens,[ref]$errors)|Out-Null
if($errors.Count){throw 'Supervisor script failed syntax validation.'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner=(Get-Acl -LiteralPath $ScriptPath).GetOwner([Security.Principal.SecurityIdentifier]).Value
if($owner -notin @($sid,'S-1-5-32-544')){throw 'Supervisor script has an unexpected owner; preserved.'}
$supervisorUser="$env:USERDOMAIN\$env:USERNAME"
$powershell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $ScriptPath
$mode='scheduled-task';$registrationError=$null
try{
 $existing=Get-ScheduledTask -TaskName 'SeekSupervisor' -ErrorAction SilentlyContinue
 if($existing -and $existing.Principal.UserId -notin @($supervisorUser,$sid,$env:USERNAME)){throw 'An existing supervisor task belongs to a different identity.'}
 $supervisorAction=New-ScheduledTaskAction -Execute $powershell -Argument $arguments
 $supervisorTrigger=New-ScheduledTaskTrigger -AtLogOn -User $supervisorUser;$supervisorTrigger.Delay='PT15S'
 $supervisorSettings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
 $supervisorPrincipal=New-ScheduledTaskPrincipal -UserId $supervisorUser -LogonType Interactive -RunLevel Limited
 Register-ScheduledTask -TaskName 'SeekSupervisor' -Action $supervisorAction -Trigger $supervisorTrigger -Settings $supervisorSettings -Principal $supervisorPrincipal -Description 'Checks owned Seek services without model warmups; waits for idle before GPU repairs.' -Force|Out-Null
}catch{
 # A limited account can use its own login startup without UAC or stored credentials.
 $registrationError=$_.Exception.Message;$mode='current-user-startup'
 $runPath='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run';$runValue='"'+$powershell+'" '+$arguments
 $existingRun=Get-ItemPropertyValue -LiteralPath $runPath -Name 'SeekSupervisor' -ErrorAction SilentlyContinue
 if($existingRun -and $existingRun -cne $runValue){throw 'A different SeekSupervisor startup entry exists; preserved.'}
 New-Item -Path $runPath -Force|Out-Null
 Set-ItemProperty -LiteralPath $runPath -Name 'SeekSupervisor' -Value $runValue -Type String
}
if($StartNow){Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden|Out-Null}
@{mode=$mode;interactiveUser=$supervisorUser;unattendedBoot=$false;started=[bool]$StartNow;taskRegistrationError=$registrationError}|ConvertTo-Json -Compress
