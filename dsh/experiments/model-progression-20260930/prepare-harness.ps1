$ErrorActionPreference='Stop'
$repoRoot='C:\Users\Joel Robinson\seek-stack'
$runtimeRoot='C:\Users\Joel Robinson\.dsh'
$testHome=Join-Path $PSScriptRoot 'harness-home'
New-Item -ItemType Directory -Force -Path (Join-Path $testHome 'profiles\web') | Out-Null
Copy-Item -LiteralPath (Join-Path $runtimeRoot 'settings.yaml'),(Join-Path $runtimeRoot 'cordis.patch.yml') -Destination $testHome -Force
Copy-Item -LiteralPath (Join-Path $runtimeRoot 'profiles\web\package.json'),(Join-Path $runtimeRoot 'profiles\web\cordis.yml') -Destination (Join-Path $testHome 'profiles\web') -Force
$patch=[IO.File]::ReadAllText((Join-Path $runtimeRoot 'profiles\web\cordis.patch.yml'))
$patch=$patch.Replace("'@deepseek-ai/dsh-browser-viewer'","'file:///C:/Users/Joel%20Robinson/seek-stack/dsh/plugins/browser-viewer/lib/index.js'")
$patch=$patch.Replace("'@deepseek-ai/dsh-qwen-image'","'file:///C:/Users/Joel%20Robinson/seek-stack/dsh/plugins/qwen-image/lib/index.js'")
[IO.File]::WriteAllText((Join-Path $testHome 'profiles\web\cordis.patch.yml'),$patch)
$modules=Join-Path $testHome 'profiles\node_modules'
if (!(Test-Path -LiteralPath $modules)) {New-Item -ItemType Junction -Path $modules -Target (Join-Path $runtimeRoot 'profiles\node_modules') | Out-Null}
Write-Output 'Isolated candidate harness prepared.'
