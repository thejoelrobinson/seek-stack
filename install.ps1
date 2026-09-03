<#
.SYNOPSIS
  One-shot installer for the seek-stack local coding agent.

.DESCRIPTION
  Installs and configures everything needed to run a fully local AI coding agent:
  llama.cpp + Qwen3.8-27B on your GPU, the DeepSeek Harness UI, a local SearXNG
  search index, and the two shims that make the harness behave.

  Safe to re-run. Every step checks whether it is already done and skips if so,
  so a failed install can be resumed by running it again.

  By default this installs a LOCALHOST-ONLY setup: nothing is exposed to the
  internet and no domain is needed. See docs/SETUP.md if you want remote access.

.PARAMETER InstallDir
  Where llama.cpp and the model go. Needs ~25 GB free. Default: your user folder.

.PARAMETER Hostname
  Only for internet exposure via a Cloudflare tunnel, e.g. "seek.example.com".
  Leave unset for a local-only install. Read docs/SETUP.md first.

.PARAMETER Quant
  Force a specific GGUF quant instead of letting VRAM decide, e.g. "UD-Q4_K_M".

.PARAMETER SkipModel
  Do not download the model (useful if you already have the GGUF).

.PARAMETER Yes
  Assume yes to prompts. For unattended installs.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -InstallDir D:\ai -Yes
#>

[CmdletBinding()]
param(
  [string]$InstallDir = $env:USERPROFILE,
  [string]$Hostname   = "",
  [string]$Quant      = "",
  [switch]$SkipModel,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"   # Invoke-WebRequest is ~10x faster without it

$RepoDir  = $PSScriptRoot
$SeekHome = "$env:USERPROFILE\.dsh"
$HF_REPO  = "unsloth/Qwen3.8-27B-GGUF"

# ---------------------------------------------------------------- helpers ----

$script:StepNo = 0
function Write-Step($msg) {
  $script:StepNo++
  Write-Host ""
  Write-Host ("[{0}] {1}" -f $script:StepNo, $msg) -ForegroundColor Cyan
}
function Write-Ok   ($msg) { Write-Host "    OK   $msg" -ForegroundColor Green }
function Write-Info ($msg) { Write-Host "         $msg" -ForegroundColor Gray }
function Write-Warn ($msg) { Write-Host "    WARN $msg" -ForegroundColor Yellow }
function Write-Fail ($msg) { Write-Host "    FAIL $msg" -ForegroundColor Red }

function Test-Cmd($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

function Confirm-Step($question, $defaultYes = $true) {
  if ($Yes) { return $true }
  $suffix = if ($defaultYes) { "[Y/n]" } else { "[y/N]" }
  $answer = Read-Host "         $question $suffix"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $defaultYes }
  return $answer -match '^(y|yes)$'
}

# curl.exe ships with Windows 10+ and resumes partial downloads; Invoke-WebRequest
# does not, which matters a great deal for a 19 GB file on a flaky connection.
function Get-File($url, $dest) {
  $dir = Split-Path $dest -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  & curl.exe -L --fail --retry 5 --retry-delay 5 -C - --progress-bar -o $dest $url
  if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE): $url" }
}

function Get-VramGB {
  if (-not (Test-Cmd nvidia-smi)) { return 0 }
  try {
    $mb = (& nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1).Trim()
    return [math]::Round([int]$mb / 1024, 1)
  } catch { return 0 }
}

function Get-DriverCuda {
  if (-not (Test-Cmd nvidia-smi)) { return "0.0" }
  # Newer drivers print "CUDA UMD Version: 13.4" in the header and mark the old
  # "CUDA Version" label deprecated; older ones print only the old label. Match
  # either, then fall back to the -q report. Getting this wrong is silent: it
  # just pins everyone to the older CUDA build.
  try {
    $head = (& nvidia-smi 2>$null | Out-String)
    if ($head -match 'CUDA(?:\s+UMD)?\s+Version:\s*([0-9]+\.[0-9]+)') { return $Matches[1] }
    $q = (& nvidia-smi -q 2>$null | Out-String)
    if ($q -match 'CUDA(?:\s+UMD)?\s+Version\s*:\s*([0-9]+\.[0-9]+)') { return $Matches[1] }
    return "0.0"
  } catch { return "0.0" }
}

# Weights are only part of the story: the KV cache and the MTP draft context also
# live in VRAM. Measured on a 24 GB card, Q5_K_XL at 64K ctx with a q8_0 KV cache
# sits at 22.9 GB -- so budget ~3.5 GB of non-weight VRAM at 64K, ~2 GB at 32K,
# ~1.3 GB at 16K. Every pairing below leaves room for that on top of the weights.
#
# Quality falls off a cliff below IQ4. At Q3 the agent starts mangling tool calls;
# at IQ2 it is a demo, not a working coding agent.
function Select-ModelProfile($vram) {
  if ($vram -ge 23) { return @{ Quant = "UD-Q5_K_XL"; Ctx = 65536; Size = "19.4 GiB"; Note = "reference configuration" } }
  if ($vram -ge 20) { return @{ Quant = "UD-Q4_K_XL"; Ctx = 65536; Size = "16.4 GiB"; Note = "slightly lossier weights, full context" } }
  if ($vram -ge 16) { return @{ Quant = "UD-IQ4_XS";  Ctx = 32768; Size = "13.3 GiB"; Note = "half context to fit the KV cache" } }
  if ($vram -ge 14) { return @{ Quant = "UD-Q3_K_XL"; Ctx = 16384; Size = "12.2 GiB"; Note = "quality drops noticeably at Q3" } }
  if ($vram -ge 12) { return @{ Quant = "UD-IQ3_XXS"; Ctx = 16384; Size = "10.2 GiB"; Note = "low quality; expect fumbled tool calls" } }
  if ($vram -ge 10) { return @{ Quant = "UD-IQ2_S";   Ctx = 8192;  Size = "7.8 GiB";  Note = "barely fits, and IQ2 quality is poor for agent work" } }
  # Below 10 GB no quant of a 27B is worth downloading: the ones that fit are
  # too degraded to drive tools reliably. The right move is a smaller MODEL, not
  # a worse quant -- the rest of this stack works with any OpenAI-compatible
  # endpoint, so only settings.yaml needs changing. See docs/HARDWARE.md.
  return @{ Quant = "UD-IQ2_S"; Ctx = 8192; Size = "7.8 GiB"; Unusable = $true
            Note = "a 27B will not fit in under 10 GB - use a smaller model instead" }
}

# ------------------------------------------------------------------ intro ----

Write-Host ""
Write-Host "  seek-stack installer" -ForegroundColor White
Write-Host "  A fully local AI coding agent. No API keys, no cloud inference." -ForegroundColor Gray
Write-Host ""

if ($PSVersionTable.PSVersion.Major -lt 5) { throw "PowerShell 5+ required (found $($PSVersionTable.PSVersion))." }
if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) { throw "This installer is Windows-only." }

# --------------------------------------------------------- 1. GPU + profile --

Write-Step "Checking your GPU"

$vram = Get-VramGB
if ($vram -eq 0) {
  Write-Warn "No NVIDIA GPU detected (nvidia-smi not found or failed)."
  Write-Info "This stack is built around a CUDA GPU. Running on CPU alone is possible"
  Write-Info "but so slow it is not usable as a coding agent."
  if (-not (Confirm-Step "Continue anyway?" $false)) { exit 1 }
} else {
  $gpuName = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1).Trim()
  Write-Ok "$gpuName with $vram GB VRAM (driver supports CUDA $(Get-DriverCuda))"
}

$modelProfile = Select-ModelProfile $vram
if ($Quant) { $modelProfile.Quant = $Quant; Write-Info "Quant overridden by -Quant: $Quant" }

Write-Info "Selected: $($modelProfile.Quant), $($modelProfile.Ctx) token context - $($modelProfile.Note)"

if ($modelProfile.Unusable -and -not $Quant) {
  Write-Host ""
  Write-Warn "$vram GB of VRAM is not enough to run a 27B model usefully."
  Write-Info "Every quant small enough to fit is too degraded to drive tools reliably,"
  Write-Info "so installing one would waste an 8 GB download on something that does not work."
  Write-Info ""
  Write-Info "Better: run a smaller model. Everything else in this stack is model-agnostic"
  Write-Info "- it speaks to any OpenAI-compatible endpoint, so only settings.yaml changes."
  Write-Info "docs\HARDWARE.md walks through it."
  Write-Host ""
  if (-not (Confirm-Step "Install anyway with a model that probably will not work well?" $false)) {
    Write-Info "Stopping. Nothing has been downloaded or changed."
    exit 1
  }
}

$ModelFile = "Qwen3.8-27B-$($modelProfile.Quant).gguf"
$ModelPath = Join-Path $InstallDir "models\$ModelFile"
$LlamaDir  = Join-Path $InstallDir "llama.cpp"

# ---------------------------------------------------------- 2. disk space ----

Write-Step "Checking disk space"

$driveLetter = (Split-Path $InstallDir -Qualifier).TrimEnd(':')
$free = [math]::Round((Get-PSDrive $driveLetter).Free / 1GB, 1)
$needed = if ($SkipModel) { 3 } else { [math]::Ceiling([double]($modelProfile.Size -replace ' GiB','') + 3) }
if ($free -lt $needed) { throw "Need ~$needed GB free on ${driveLetter}: but only $free GB available. Use -InstallDir to pick another drive." }
Write-Ok "$free GB free on ${driveLetter}: (need ~$needed GB)"

# -------------------------------------------------------- 3. prerequisites ---

Write-Step "Checking prerequisites"

$missing = @()
foreach ($dep in @(
  @{ Cmd = "node";   Name = "Node.js";        Winget = "OpenJS.NodeJS.LTS" },
  @{ Cmd = "npm";    Name = "npm";            Winget = "OpenJS.NodeJS.LTS" },
  @{ Cmd = "docker"; Name = "Docker Desktop"; Winget = "Docker.DockerDesktop" }
)) {
  if (Test-Cmd $dep.Cmd) { Write-Ok "$($dep.Name) found" } else { Write-Warn "$($dep.Name) missing"; $missing += $dep }
}

if ($missing.Count -gt 0) {
  if (-not (Test-Cmd winget)) { throw "Missing: $($missing.Name -join ', '). Install them and re-run." }
  if (Confirm-Step "Install the missing prerequisites with winget?") {
    foreach ($dep in ($missing | Sort-Object -Property Winget -Unique)) {
      Write-Info "installing $($dep.Name)..."
      & winget install --id $dep.Winget -e --accept-source-agreements --accept-package-agreements --silent
    }
    Write-Warn "Close and reopen PowerShell so the new PATH takes effect, then re-run this script."
    Write-Warn "If Docker Desktop was installed, start it once and let it finish setting up first."
    exit 0
  }
  throw "Cannot continue without: $($missing.Name -join ', ')"
}

# ------------------------------------------------------------ 4. llama.cpp ---

Write-Step "Installing llama.cpp (CUDA build)"

if (Test-Path (Join-Path $LlamaDir "llama-server.exe")) {
  Write-Ok "already present at $LlamaDir"
} else {
  # Pick the newest release that actually carries Windows CUDA assets -- some
  # tags are published with none at all.
  Write-Info "finding the latest release with Windows CUDA binaries..."
  $releases = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15" `
                -Headers @{ "User-Agent" = "seek-stack-installer" }
  $rel = $releases | Where-Object { $_.assets.name -match 'bin-win-cuda' } | Select-Object -First 1
  if (-not $rel) { throw "No llama.cpp release with Windows CUDA assets found." }

  # CUDA 13.3 builds need a recent driver; fall back to 12.4 otherwise.
  $cuda = if ([version](Get-DriverCuda) -ge [version]"13.3") { "13.3" } else { "12.4" }
  Write-Info "release $($rel.tag_name), CUDA $cuda"

  # Anchor on the "llama-" prefix. Both packages END in the same
  # "bin-win-cuda-<ver>-x64.zip", so a trailing-wildcard match happily returns
  # cudart-llama-bin-win-cuda-13.3-x64.zip as the binary and the extract then
  # fails with no llama-server.exe in it.
  $binAsset    = $rel.assets | Where-Object { $_.name -like "llama-*-bin-win-cuda-$cuda-x64.zip" } | Select-Object -First 1
  $cudartAsset = $rel.assets | Where-Object { $_.name -like "cudart-*-win-cuda-$cuda-x64.zip"   } | Select-Object -First 1
  if (-not $binAsset) { throw "No CUDA $cuda x64 build in release $($rel.tag_name)." }

  $tmp = Join-Path $env:TEMP "seek-llama"
  New-Item -ItemType Directory -Force -Path $tmp, $LlamaDir | Out-Null

  Write-Info "downloading $($binAsset.name)..."
  Get-File $binAsset.browser_download_url (Join-Path $tmp $binAsset.name)
  Expand-Archive -Path (Join-Path $tmp $binAsset.name) -DestinationPath $LlamaDir -Force

  if ($cudartAsset) {
    # The CUDA runtime DLLs must sit next to llama-server.exe or it fails to start.
    Write-Info "downloading $($cudartAsset.name) (CUDA runtime DLLs)..."
    Get-File $cudartAsset.browser_download_url (Join-Path $tmp $cudartAsset.name)
    Expand-Archive -Path (Join-Path $tmp $cudartAsset.name) -DestinationPath $LlamaDir -Force
  }

  # Some builds nest everything one level deep; flatten so paths stay predictable.
  $nested = Get-ChildItem $LlamaDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName "llama-server.exe") } | Select-Object -First 1
  if ($nested) {
    Get-ChildItem $nested.FullName | Move-Item -Destination $LlamaDir -Force
    Remove-Item $nested.FullName -Recurse -Force
  }

  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path (Join-Path $LlamaDir "llama-server.exe"))) { throw "llama-server.exe missing after extraction." }
  Write-Ok "installed to $LlamaDir"
}

# ---------------------------------------------------------------- 5. model ---

Write-Step "Downloading the model ($($modelProfile.Quant), $($modelProfile.Size))"

if ($SkipModel) {
  Write-Info "skipped (-SkipModel)"
} elseif (Test-Path $ModelPath) {
  $have = [math]::Round((Get-Item $ModelPath).Length / 1GB, 1)
  Write-Ok "already present ($have GB) at $ModelPath"
} else {
  Write-Info "This is a large download and can take a while. It resumes if interrupted -"
  Write-Info "just re-run this script."
  Get-File "https://huggingface.co/$HF_REPO/resolve/main/$ModelFile" $ModelPath
  Write-Ok "downloaded to $ModelPath"
}

# ----------------------------------------------------------------- 6. dsh ----

Write-Step "Installing the DeepSeek Harness"

if (Test-Cmd dsh) {
  Write-Ok "dsh already installed ($(& dsh --version 2>$null | Select-Object -First 1))"
} else {
  & npm install -g "@deepseek-ai/dsh"
  if ($LASTEXITCODE -ne 0) { throw "npm install -g @deepseek-ai/dsh failed" }
  Write-Ok "installed"
}

# -------------------------------------------------------------- 7. deploy ----

Write-Step "Deploying configuration"

New-Item -ItemType Directory -Force -Path `
  (Join-Path $SeekHome "proxy"), (Join-Path $SeekHome "profiles\web") | Out-Null

Copy-Item (Join-Path $RepoDir "dsh\proxy\*.js")                    (Join-Path $SeekHome "proxy")          -Force
Copy-Item (Join-Path $RepoDir "dsh\profiles\web\cordis.patch.yml") (Join-Path $SeekHome "profiles\web")   -Force
Copy-Item (Join-Path $RepoDir "llama.cpp\serve-qwen38.ps1")        $LlamaDir                              -Force

# settings.yaml carries the context window, and it MUST equal what llama-server
# actually serves. If VRAM forced a smaller context, rewrite it to match --
# otherwise the harness believes the larger number, never compacts in time, and
# requests die on overflow.
$settings = Get-Content (Join-Path $RepoDir "dsh\settings.yaml") -Raw
if ($modelProfile.Ctx -ne 65536) {
  $settings = $settings -replace 'contextWindow:\s*65536', "contextWindow: $($modelProfile.Ctx)"
  Write-Info "context window set to $($modelProfile.Ctx) to fit $vram GB of VRAM"
}
Set-Content -Path (Join-Path $SeekHome "settings.yaml") -Value $settings -Encoding UTF8

Write-Ok "harness config deployed to $SeekHome"

# -------------------------------------------------------------- 8. config ----

Write-Step "Writing seek.config.ps1"

$configPath = Join-Path $SeekHome "seek.config.ps1"
@"
# Generated by install.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm').
# Safe to edit by hand; re-running the installer will not overwrite it.

`$SeekHome  = "$SeekHome"
`$LlamaDir  = "$LlamaDir"
`$ModelPath = "$ModelPath"

`$ModelAlias      = "qwen3.8-27b"
`$ContextSize     = $($modelProfile.Ctx)
`$GpuLayers       = 99
`$ReasoningBudget = 4096
`$ReasoningEffort = "medium"

`$TrustedHost = "$Hostname"

`$LlamaPort   = 18798
`$ShimPort    = 18800
`$SearxPort   = 18801
`$AdapterPort = 18802
`$WebPort     = 3080
`$ProxyPort   = 18799
"@ | Set-Content -Path $configPath -Encoding UTF8

Write-Ok $configPath

# ------------------------------------------------------------- 9. searxng ----

Write-Step "Setting up SearXNG (local web search)"

$searxDir = Join-Path $env:USERPROFILE "searxng"
New-Item -ItemType Directory -Force -Path $searxDir | Out-Null
Copy-Item (Join-Path $RepoDir "searxng\docker-compose.yml") $searxDir -Force

$searxSettings = Join-Path $searxDir "settings.yml"
if (Test-Path $searxSettings) {
  Write-Ok "settings.yml already exists, keeping your secret_key"
} else {
  # A fresh random secret per install. Never ship or reuse one.
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ''
  (Get-Content (Join-Path $RepoDir "searxng\settings.yml") -Raw) `
    -replace 'secret_key:\s*"[^"]*"', "secret_key: `"$secret`"" |
    Set-Content -Path $searxSettings -Encoding UTF8
  Write-Ok "generated a fresh secret_key"
}

try {
  Push-Location $searxDir
  & docker compose up -d 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Ok "SearXNG container started on 127.0.0.1:18801" }
  else { Write-Warn "docker compose failed - is Docker Desktop running? web_search will not work until it is." }
} catch {
  Write-Warn "could not start SearXNG: $($_.Exception.Message)"
} finally { Pop-Location }

# ---------------------------------------------------- 10. remote (optional) --

if ($Hostname) {
  Write-Step "Configuring remote access for $Hostname"

  $u = [Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User')
  $p = [Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User')
  if ($u -and $p) {
    Write-Ok "DSH_PROXY_USER / DSH_PROXY_PASS already set"
  } else {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $genPass = [Convert]::ToBase64String($bytes).TrimEnd('=') -replace '[+/]',''
    [Environment]::SetEnvironmentVariable('DSH_PROXY_USER', 'seek', 'User')
    [Environment]::SetEnvironmentVariable('DSH_PROXY_PASS', $genPass, 'User')
    Write-Ok "generated login credentials:"
    Write-Host ""
    Write-Host "           username: seek"           -ForegroundColor Yellow
    Write-Host "           password: $genPass"       -ForegroundColor Yellow
    Write-Host ""
    Write-Warn "WRITE THESE DOWN NOW. This is the only thing between your machine"
    Write-Warn "and the internet - the agent can run PowerShell on this PC."
  }
  Write-Info "Next: point a Cloudflare tunnel at http://localhost:18799"
  Write-Info "See docs/SETUP.md#exposing-it-to-the-internet"
}

# ----------------------------------------------------------- 11. autostart ---

Write-Step "Autostart at logon"

$startScript = Join-Path $SeekHome "start-seek.ps1"
Copy-Item (Join-Path $RepoDir "start-seek.ps1") $startScript -Force

if (Get-ScheduledTask -TaskName "SeekHarness" -ErrorAction SilentlyContinue) {
  Write-Ok "SeekHarness task already registered"
} elseif (Confirm-Step "Start the stack automatically when you log in?") {
  & (Join-Path $RepoDir "scheduled-task\register-seekharness.ps1") -ScriptPath $startScript | Out-Null
  Write-Ok "registered"
} else {
  Write-Info "skipped - start it by hand with: $startScript"
}

# --------------------------------------------------------------- 12. start ---

Write-Step "Starting the stack"

if (Confirm-Step "Start it now? (first model load takes ~60s)") {
  & $startScript -ConfigPath $configPath
} else {
  Write-Info "skipped"
}

# -------------------------------------------------------------- all done -----

Write-Host ""
Write-Host "  Done." -ForegroundColor Green
Write-Host ""
if ($Hostname) {
  Write-Host "  Local:  http://127.0.0.1:3080"
  Write-Host "  Remote: https://$Hostname  (once your tunnel is up)"
} else {
  Write-Host "  Open http://127.0.0.1:3080 in your browser."
}
Write-Host ""
Write-Host "  Start it again any time:  $startScript"
Write-Host "  Logs:                     $SeekHome\autostart.log"
Write-Host "  Guide:                    docs\SETUP.md"
Write-Host "  Something broken?         docs\TROUBLESHOOTING.md"
Write-Host ""
