# Registers "SeekHarness" to run start-seek.ps1 at logon.
#
# At-logon, not at-boot, and deliberately so: a boot trigger running as you
# requires your account password stored in the task definition. The password-free
# alternative (running as SYSTEM) does not work here — the stack reads
# DSH_PROXY_USER/DSH_PROXY_PASS and DSH_HOME from the user profile, so SYSTEM
# would mean baking those credentials into a task definition readable by any
# admin on the box. The tradeoff: after an unattended reboot the stack stays down
# until someone logs in.

param(
  [string]$ScriptPath = "$env:USERPROFILE\start-seek.ps1"
)

$me = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $ScriptPath)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$trigger.Delay = "PT1M"   # let the network and the NVIDIA driver settle first

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
#              ExecutionTimeLimit 0 ^ so a slow 18.8 GB model load is never killed

$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName "SeekHarness" -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force `
  -Description "Starts the seek stack: llama-server 18798, summarizer shim 18800, search adapter 18802, dsh web 3080, auth proxy 18799."

Write-Host "Registered. Test it without waiting for a logon:"
Write-Host "  Start-ScheduledTask -TaskName SeekHarness"
Write-Host "  (Get-ScheduledTaskInfo -TaskName SeekHarness).LastTaskResult   # 0 = success"
