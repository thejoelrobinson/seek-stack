$ErrorActionPreference='Stop'
$repo='C:\Users\Joel Robinson\seek-stack'
$live='C:\Users\Joel Robinson\.dsh'
$candidate=Join-Path $live ('browser\validation\candidate-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
if(Get-NetTCPConnection -State Listen -LocalPort 3081 -ErrorAction SilentlyContinue){throw 'Candidate port is occupied.'}
New-Item -ItemType Directory -Path $candidate,(Join-Path $candidate 'profiles\web') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $live 'settings.yaml') -Destination $candidate
Copy-Item -LiteralPath (Join-Path $live 'profiles\web\cordis.patch.yml') -Destination (Join-Path $candidate 'profiles\web')
New-Item -ItemType Junction -Path (Join-Path $candidate 'profiles\node_modules') -Target (Join-Path $live 'profiles\node_modules') | Out-Null
foreach($patchPath in @('cordis.patch.yml','profiles\web\cordis.patch.yml')){
 $patch=[IO.File]::ReadAllText((Join-Path $live $patchPath))
 foreach($plugin in @('browser-viewer','qwen-image')){
  $entry=[Uri]::new((Join-Path $repo ('dsh\plugins\'+$plugin+'\lib\index.js'))).AbsoluteUri
  $patch=$patch.Replace('@deepseek-ai/dsh-'+$plugin,$entry)
 }
 [IO.File]::WriteAllText((Join-Path $candidate $patchPath),$patch,[Text.UTF8Encoding]::new($false))
}
$env:DSH_HOME=$candidate
$env:DSH_WORK_HOME=Join-Path $candidate 'work'
$env:DSH_BROWSER_USER_DATA_DIR=Join-Path $candidate 'browser\profile'
$env:LOCAL_LLM_API_KEY=[Environment]::GetEnvironmentVariable('LOCAL_LLM_API_KEY','User')
$loader=[Uri]::new((Join-Path $repo 'dsh\plugins\browser-viewer\test\register-profile.mjs')).AbsoluteUri
$web=Start-Process -FilePath node -ArgumentList '--import',$loader,'"C:\Users\Joel Robinson\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"','web','--port','3081' -WorkingDirectory $repo -RedirectStandardOutput (Join-Path $candidate 'web.log') -RedirectStandardError (Join-Path $candidate 'web.err') -WindowStyle Hidden -PassThru
$until=(Get-Date).AddSeconds(60)
do{Start-Sleep -Milliseconds 500;try{$ready=Invoke-RestMethod 'http://127.0.0.1:3081/work/api/version' -TimeoutSec 2}catch{$ready=$null}}while($ready.plugin -ne '0.5.0' -and (Get-Date) -lt $until)
if($ready.plugin -ne '0.5.0'){throw ('Candidate failed; inspect private logs at '+$candidate)}
@{pid=$web.Id;home=$candidate;version=$ready} | ConvertTo-Json -Depth 4
