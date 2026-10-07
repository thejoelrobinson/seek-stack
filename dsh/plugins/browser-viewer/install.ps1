param([string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'))
$ErrorActionPreference = 'Stop'
$destination = Join-Path $DshHome 'profiles\node_modules\@deepseek-ai\dsh-browser-viewer'
$qwenSource = Join-Path (Split-Path -Parent $PSScriptRoot) 'qwen-image'
$qwenDestination = Join-Path $DshHome 'profiles\node_modules\@deepseek-ai\dsh-qwen-image'
$toolsSource = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'tools'
$toolsDestination = Join-Path $DshHome 'tools'
$profilePatch = Join-Path $DshHome 'profiles\web\cordis.patch.yml'
if (Test-Path -LiteralPath $destination) {
  $backup = Join-Path $DshHome ('browser\backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  Copy-Item -LiteralPath $destination -Destination $backup -Recurse
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($item in @('lib','skills','test','package.json','package-lock.json','README.md')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $item) -Destination $destination -Recurse -Force
}
# The WebRTC transport has runtime dependencies. Install the locked production
# tree alongside the copied plugin; harness-provided packages still resolve above it.
& npm ci --omit=dev --ignore-scripts --prefix $destination
if ($LASTEXITCODE -ne 0) { throw 'Seek Work runtime dependency installation failed; restore the code backup before restarting.' }
if (Test-Path -LiteralPath $qwenDestination) {
  $backup = Join-Path $DshHome ('browser\backups\qwen-image-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  Copy-Item -LiteralPath $qwenDestination -Destination $backup -Recurse
}
New-Item -ItemType Directory -Path $qwenDestination,$toolsDestination -Force | Out-Null
foreach ($item in @('lib','package.json','README.md')) {
  Copy-Item -LiteralPath (Join-Path $qwenSource $item) -Destination $qwenDestination -Recurse -Force
}
foreach ($item in @('setup-qwen-image.ps1','qwen-image-service.py')) {
  Copy-Item -LiteralPath (Join-Path $toolsSource $item) -Destination $toolsDestination -Force
}
$patch = if (Test-Path -LiteralPath $profilePatch) { Get-Content -LiteralPath $profilePatch -Raw } else { '' }
if ($patch -notmatch '@deepseek-ai/dsh-browser-viewer') {
  New-Item -ItemType Directory -Path (Split-Path $profilePatch) -Force | Out-Null
  Add-Content -LiteralPath $profilePatch -Encoding utf8 -Value "`n- insert:`n    - id: browser-viewer`n      name: '@deepseek-ai/dsh-browser-viewer'"
}
if ($patch -notmatch '@deepseek-ai/dsh-qwen-image') {
  $entry = @'

- insert:
    - id: qwen-image
      name: '@deepseek-ai/dsh-qwen-image'
'@
  Add-Content -LiteralPath $profilePatch -Encoding utf8 -Value $entry
}
Write-Output "Installed Seek Work plugins at $destination and $qwenDestination. Restart the web harness and refresh the page."
