param([string]$SeekHome="$env:USERPROFILE\.dsh",[string]$StartScript="$env:USERPROFILE\start-seek.ps1",[int]$IntervalSeconds=30)
$ErrorActionPreference='Stop'
$supervisorMutex = New-Object System.Threading.Mutex($false,'Local\SeekStackSupervisor')
if (-not $supervisorMutex.WaitOne(0)) { exit 0 }
$supervisorRepair=$null
$supervisorFailures=0
$supervisorNextRepair=Get-Date
$supervisorStatePath=Join-Path $SeekHome 'supervisor.json'
function Test-SeekHttp([string]$Url) { try { (Invoke-WebRequest -Uri $Url -TimeoutSec 4 -UseBasicParsing).StatusCode -eq 200 } catch { $false } }
try {
  while ($true) {
    $supervisorChecks=@{web=(Test-SeekHttp 'http://127.0.0.1:3080/work/api/version');router=(Test-SeekHttp 'http://127.0.0.1:18798/v1/models');proxy=(Test-SeekHttp 'http://127.0.0.1:18799/login');image=(Test-SeekHttp 'http://127.0.0.1:18810/health')}
    if ($supervisorRepair -and $supervisorRepair.HasExited) { $supervisorFailures = if ($supervisorRepair.ExitCode -eq 0) { 0 } else { $supervisorFailures+1 }; $supervisorRepair=$null; $supervisorNextRepair=(Get-Date).AddSeconds([Math]::Min(300,30*[Math]::Pow(2,$supervisorFailures))) }
    $supervisorGpuBusy=$false
    try { $supervisorGpuBusy=[bool](Invoke-RestMethod 'http://127.0.0.1:18810/health' -TimeoutSec 3).busy } catch {}
    if (-not $supervisorRepair -and -not $supervisorGpuBusy -and (Get-Date) -ge $supervisorNextRepair -and @($supervisorChecks.Values | Where-Object { -not $_ }).Count -gt 0) {
      if (-not (Test-Path -LiteralPath $StartScript)) { throw 'Owned startup script is unavailable.' }
      $supervisorRepair=Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$StartScript+'"') -WindowStyle Hidden -PassThru
    }
    $supervisorState=@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();checks=$supervisorChecks;repairing=[bool]$supervisorRepair;gpuBusy=$supervisorGpuBusy;failures=$supervisorFailures;mode='interactive-user';unattendedBoot=$false} | ConvertTo-Json -Depth 4 -Compress
    [IO.File]::WriteAllText($supervisorStatePath+'.tmp',$supervisorState)
    Move-Item -LiteralPath ($supervisorStatePath+'.tmp') -Destination $supervisorStatePath -Force
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally { $supervisorMutex.ReleaseMutex(); $supervisorMutex.Dispose() }
