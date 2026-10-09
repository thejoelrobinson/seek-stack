# Validate parameter binding on native Windows PowerShell 5 without starting services.
$ErrorActionPreference='Stop'
$engine=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$directory=Split-Path -Parent $PSCommandPath
$checked=@()
foreach($name in @('deploy.ps1','recovery-smoke.ps1')) {
 $path=Join-Path $directory $name
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw "$name did not parse."}
 if($ast.ParamBlock.Extent.Text -match '\$PSScriptRoot|\$PSCommandPath'){throw "$name resolves script paths during parameter binding."}
 $text=[IO.File]::ReadAllText($path)
 if($name -eq 'deploy.ps1'){$initializationBoundary='$node=(Get-Command node.exe'} else {$initializationBoundary='if($SeekHome -ine'}
 $end=$text.IndexOf($initializationBoundary,[StringComparison]::Ordinal)
 if($end -lt 0){throw "$name initialization boundary was not found."}
 $fixture=Join-Path $directory ('.default-check-'+[Guid]::NewGuid().ToString('N')+'.ps1')
 try {
  $assert=$(if($name -eq 'deploy.ps1'){@'
$expected=[IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSCommandPath) '..\..\..'))
if($RepoRoot -ine $expected -or !(Test-Path -LiteralPath (Join-Path $RepoRoot 'dsh\plugins\browser-viewer\package.json'))){throw 'RepoRoot default is invalid.'}
'@}else{@'
$expected=Join-Path (Split-Path -Parent $PSCommandPath) 'supervisor-recovery.json'
if($OutputPath -ine $expected){throw 'OutputPath default is invalid.'}
'@})
  [IO.File]::WriteAllText($fixture,$text.Substring(0,$end)+"`r`n"+$assert+"`r`nWrite-Output 'default-ok'`r`n")
  $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$fixture)
  if($name -eq 'recovery-smoke.ps1'){$arguments+=@('-ExpectedRelease','parameter-default-test')}
  $output=@(& $engine @arguments 2>&1)
  if($LASTEXITCODE -ne 0 -or $output.Count -ne 1 -or $output[0] -ne 'default-ok'){throw "$name native PowerShell default failed."}
  $checked+=$name
 } finally {if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture -Force}}
}
@{passed=$true;nativePowerShell='5.1';checked=$checked;serviceMutations=$false}|ConvertTo-Json
