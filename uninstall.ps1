<#
.SYNOPSIS
  Removes the seek-stack install.

.DESCRIPTION
  Stops every service, removes the scheduled task and the SearXNG container, and
  optionally deletes the model and llama.cpp.

  Your conversations in ~/.dsh/sessions are kept unless you pass -Everything.

.PARAMETER Everything
  Also delete ~/.dsh entirely (including conversation history), the model file,
  and llama.cpp.

.PARAMETER Yes
  Assume yes to prompts.
#>

[CmdletBinding()]
param(
  [switch]$Everything,
  [switch]$Yes
)

$ErrorActionPreference = "Continue"

$SeekHome   = "$env:USERPROFILE\.dsh"
$configPath = Join-Path $SeekHome "seek.config.ps1"

function Confirm-Step($question, $defaultYes = $true) {
  if ($Yes) { return $true }
  $suffix = if ($defaultYes) { "[Y/n]" } else { "[y/N]" }
  $answer = Read-Host "$question $suffix"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $defaultYes }
  return $answer -match '^(y|yes)$'
}

Write-Host ""
Write-Host "  seek-stack uninstaller" -ForegroundColor White
Write-Host ""

# Read the config first so we know where the big files actually live.
$LlamaDir = $null; $ModelPath = $null
if (Test-Path $configPath) { . $configPath }

Write-Host "[1] Stopping services"
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
# Only kill the node processes belonging to this stack, never every node on the box.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'summarizer-shim|searxng-search-adapter|\.dsh\\proxy\\server' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'dsh web' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "    stopped"

Write-Host "[2] Removing the scheduled task"
if (Get-ScheduledTask -TaskName "SeekHarness" -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName "SeekHarness" -Confirm:$false
  Write-Host "    removed"
} else { Write-Host "    not registered" }

Write-Host "[3] Removing the SearXNG container"
$searxDir = Join-Path $env:USERPROFILE "searxng"
if (Test-Path (Join-Path $searxDir "docker-compose.yml")) {
  Push-Location $searxDir
  & docker compose down 2>&1 | Out-Null
  Pop-Location
  Write-Host "    removed"
} else { Write-Host "    not present" }

Write-Host "[4] Proxy credentials"
if (Confirm-Step "    Clear DSH_PROXY_USER / DSH_PROXY_PASS?") {
  [Environment]::SetEnvironmentVariable('DSH_PROXY_USER', $null, 'User')
  [Environment]::SetEnvironmentVariable('DSH_PROXY_PASS', $null, 'User')
  Write-Host "    cleared"
} else { Write-Host "    kept" }

if ($Everything) {
  Write-Host "[5] Deleting files"

  if ($ModelPath -and (Test-Path $ModelPath)) {
    $gb = [math]::Round((Get-Item $ModelPath).Length / 1GB, 1)
    if (Confirm-Step "    Delete the model ($gb GB)? You would have to re-download it." $false) {
      Remove-Item $ModelPath -Force
      Write-Host "    deleted"
    }
  }

  if ($LlamaDir -and (Test-Path $LlamaDir)) {
    if (Confirm-Step "    Delete llama.cpp at $LlamaDir?" $false) {
      Remove-Item $LlamaDir -Recurse -Force
      Write-Host "    deleted"
    }
  }

  if (Confirm-Step "    Delete $SeekHome, INCLUDING all conversation history?" $false) {
    Remove-Item $SeekHome -Recurse -Force
    Write-Host "    deleted"
  }

  Write-Host "    dsh itself is still installed. Remove it with: npm uninstall -g @deepseek-ai/dsh"
} else {
  Write-Host "[5] Keeping files"
  Write-Host "    Model, llama.cpp and $SeekHome left in place."
  Write-Host "    Re-run with -Everything to delete them too."
}

Write-Host ""
Write-Host "  Done." -ForegroundColor Green
Write-Host ""
