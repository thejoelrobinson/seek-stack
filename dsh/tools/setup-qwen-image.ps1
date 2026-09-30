param(
  [string]$EngineRoot = (Join-Path $env:USERPROFILE '.dsh\image-engine'),
  [string]$Python = ''
)
$ErrorActionPreference = 'Stop'

# One-time install for Seek's Qwen Image 2.1 all-GPU runner. The Q6 image
# weights and Q4 text encoder need a GPU with enough VRAM for both models.
$pythonExe = if ($Python) { $Python } else { (Get-Command python -ErrorAction Stop).Source }
& $pythonExe -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ is required"'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required.' }
$root = [System.IO.Path]::GetFullPath($EngineRoot)
$models = Join-Path $root 'models'
$venv = Join-Path $root '.venv'
$archive = Join-Path $root 'sd-cpp-cuda12.zip'
$cudaArchive = Join-Path $root 'cudart-sd-bin-win-cu12-x64.zip'
$engine = Join-Path $root 'sd-server.exe'
New-Item -ItemType Directory -Force -Path $root,$models | Out-Null

if (!(Test-Path -LiteralPath $engine)) {
  Invoke-WebRequest -Uri 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-929-3f8527a/sd-master-3f8527a-bin-win-cuda12-x64.zip' -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $root -Force
}
if (!(Test-Path -LiteralPath (Join-Path $root 'cudart64_12.dll'))) {
  Invoke-WebRequest -Uri 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-929-3f8527a/cudart-sd-bin-win-cu12-x64.zip' -OutFile $cudaArchive
  Expand-Archive -LiteralPath $cudaArchive -DestinationPath $root -Force
}
if (!(Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe'))) { & $pythonExe -m venv $venv }
$venvPython = Join-Path $venv 'Scripts\python.exe'
& $venvPython -m pip install --upgrade fastapi 'uvicorn[standard]' huggingface_hub

function Get-HfFile([string]$repository, [string]$filename) {
  & $venvPython -c 'from huggingface_hub import hf_hub_download; import sys; hf_hub_download(sys.argv[1], sys.argv[2], local_dir=sys.argv[3])' $repository $filename $models
}
Get-HfFile 'leejet/Qwen-Image-2.1-GGUF' 'qwen_image_2.1-Q6_K.gguf'
Get-HfFile 'Qwen/Qwen3-VL-8B-Instruct-GGUF' 'Qwen3VL-8B-Instruct-Q4_K_M.gguf'
Get-HfFile 'Comfy-Org/Qwen-Image-2.1' 'vae/qwen_image_2.1_vae_bf16.safetensors'

$listener = Get-NetTCPConnection -State Listen -LocalPort 18810 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18810/health' -TimeoutSec 3
    if ($health.ready) { Write-Host 'The Qwen Image runner is already running. Refresh Seek → Images.'; return }
  } catch {}
  throw "Port 18810 is in use by process $($listener.OwningProcess). Stop that service before starting the Qwen Image runner."
}
$env:SEEK_IMAGE_ENGINE_ROOT = $root
Start-Process -FilePath $venvPython -ArgumentList @('-m','uvicorn','qwen-image-service:app','--host','127.0.0.1','--port','18810') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'runner.log') -RedirectStandardError (Join-Path $root 'runner.err')
Write-Host 'The GPU Qwen Image runner is ready at http://127.0.0.1:18810. Refresh Seek → Images.'
