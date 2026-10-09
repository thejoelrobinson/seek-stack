$ErrorActionPreference = 'Stop'
$sourceRoot = Join-Path $PSScriptRoot '../../../desktop-bridge/dist/mac-preview-7e78983'
$sourceRoot = [IO.Path]::GetFullPath($sourceRoot)
$artifact = gh api repos/thejoelrobinson/seek-stack/actions/artifacts/11560600498 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $artifact.expired -or $artifact.name -ne 'bridge-macOS-ARM64') { throw 'Expected tested Mac artifact is unavailable' }
New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
$archive = Join-Path $sourceRoot 'artifact.zip'
$stage = 'download'
$token = $null
$client = $null
try {
 if (!(Test-Path -LiteralPath $archive)) {
  $token = gh auth token
  if ($LASTEXITCODE -ne 0 -or !$token) { throw 'GitHub authentication unavailable' }
  $client = [Net.Http.HttpClient]::new()
  $client.Timeout = [TimeSpan]::FromMinutes(5)
  $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token.Trim())
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('Seek-Mac-Preview-Verifier')
  $response = $client.GetAsync('https://api.github.com/repos/thejoelrobinson/seek-stack/actions/artifacts/11560600498/zip', [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  try {
   if (!$response.IsSuccessStatusCode) { throw 'Artifact request failed' }
   $output = [IO.File]::Create($archive + '.partial')
   try { $response.Content.CopyToAsync($output).GetAwaiter().GetResult() } finally { $output.Dispose() }
  } finally { $response.Dispose() }
  Move-Item -LiteralPath ($archive + '.partial') -Destination $archive
 }
 $stage = 'checksum'
 $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
 if ('sha256:' + $actual -ne $artifact.digest) { throw 'Artifact checksum mismatch' }
 $stage = 'extract'
 Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $sourceRoot 'verified') -Force
 [pscustomobject]@{artifact=$artifact.name; ciRun=37799719883; archiveSha256Verified=$true; destination=$sourceRoot} | ConvertTo-Json
} catch {
 throw "Mac artifact verification failed during $stage; authentication details withheld"
} finally {
 if ($client) { $client.Dispose() }
 $token = $null
}
