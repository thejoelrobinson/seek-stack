# Cut Seek over from DeepSeek Harness 0.1.0-rc.7 to 0.2.0-rc.2.
# Holds the deployment lock (supervisor and start-seek.ps1 stand down), backs up configuration
# and Work data, stops only Seek's own harness/browser/shim, installs 0.2 and the three local
# plugins into the web profile, then restarts through the normal SeekHarness task.
$ErrorActionPreference='Stop'
$home_=$env:USERPROFILE;$seek="$home_\.dsh";$repo="$home_\seek-stack\dsh"
$cli="$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$backup="$seek\browser\backups\dsh-0.2-cutover-$stamp"
$lock="$seek\deployment.lock.json"
function Log($m){"$(Get-Date -Format HH:mm:ss) $m"}
function Owned($port){$c=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue;if($c){Get-CimInstance Win32_Process -Filter "ProcessId=$($c[0].OwningProcess)"}}

if(Test-Path $lock){throw 'A deployment lock already exists.'}
[IO.File]::WriteAllText($lock,(@{pid=$PID;release='dsh-0.2-cutover';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(25).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))
try{
  Log "backup -> $backup"
  New-Item -ItemType Directory -Force "$backup\profiles-web","$backup\proxy" | Out-Null
  foreach($f in 'settings.yaml','cordis.patch.yml'){Copy-Item "$seek\$f" $backup}
  Copy-Item "$seek\profiles\web\*" "$backup\profiles-web" -Recurse
  Copy-Item "$seek\proxy\summarizer-shim.js" "$backup\proxy"
  Copy-Item "$home_\start-seek.ps1" $backup
  (& node $cli --version 2>$null) | Set-Content "$backup\previous-dsh-version.txt"

  Log 'stopping dsh web, its browser and the summarizer shim'
  $web=Owned 3080;if($web -and $web.CommandLine -match [regex]::Escape($cli)){Stop-Process -Id $web.ProcessId -Force -Confirm:$false;Log "stopped web $($web.ProcessId)"}
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape("$seek\browser\profile") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
  $cand=Owned 3091;if($cand -and $cand.CommandLine -match 'dsh-next-cli'){Stop-Process -Id $cand.ProcessId -Force -Confirm:$false;Log 'stopped candidate'}
  $shim=Owned 18800;if($shim -and $shim.CommandLine -match 'summarizer-shim'){Stop-Process -Id $shim.ProcessId -Force -Confirm:$false;Log 'stopped shim'}
  Start-Sleep 3

  Log 'Work data snapshot (harness stopped)'
  robocopy "$seek\work" "$backup\work" /E /NFL /NDL /NJH /NJS /NP /XD backups | Out-Null

  Log 'installing @deepseek-ai/dsh@0.2.0-rc.2 globally'
  & npm install -g --no-fund --no-audit '@deepseek-ai/dsh@0.2.0-rc.2' 2>&1 | Select-Object -Last 3
  $v=(& node $cli --version 2>$null);Log "dsh now $v";if($v -notmatch '0\.2\.0'){throw "dsh version is $v after install"}

  # 0.1 resolved harness packages and plugins from this shared folder; 0.2 uses the CLI install
  # plus per-profile plugins. Keep it, renamed, so nothing resolves 0.1 packages.
  if(Test-Path "$seek\profiles\node_modules"){Rename-Item "$seek\profiles\node_modules" "node_modules.dsh-0.1-$stamp";Log 'renamed shared 0.1 node_modules'}

  $env:DSH_HOME=$seek
  foreach($p in 'browser-viewer','qwen-image','web-search-chrome-mcp'){
    $out=& node $cli plugin --profile web add "file:$($repo -replace '\\','/')/plugins/$p" 2>&1
    if(-not ($out -match 'Done')){$out|Select-Object -Last 8;throw "plugin install failed: $p"};Log "plugin $p installed"
  }

  Copy-Item "$repo\proxy\summarizer-shim.js" "$seek\proxy\summarizer-shim.js" -Force;Log 'shim updated'
}finally{
  Remove-Item $lock -Force -ErrorAction SilentlyContinue;Log 'lock released'
}
Log 'starting the stack (SeekHarness)'
$before=(Get-Content "$seek\autostart.log").Count
Start-ScheduledTask -TaskName SeekHarness
$deadline=(Get-Date).AddMinutes(6);do{Start-Sleep 5;$new=@(Get-Content "$seek\autostart.log" | Select-Object -Skip $before)}until(($new -match '=== done').Count -or (Get-Date) -gt $deadline)
Get-Content "$seek\autostart.log" -Tail 4
Log "backup kept at $backup"
