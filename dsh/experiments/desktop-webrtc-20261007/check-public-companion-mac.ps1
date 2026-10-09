$ErrorActionPreference = 'Stop'
$origin = 'https://seek.joelcrobinson.com'
$username = [Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User')
$password = [Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User')
if (!$username -or !$password) { throw 'Existing Seek sign-in credentials are unavailable' }
$handler = [Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
$handler.CookieContainer = [Net.CookieContainer]::new()
$client = [Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromMinutes(5)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('Seek-Mac-Download-Verification')
$client.DefaultRequestHeaders.Add('Origin',$origin)
$signedIn = $false
$stage = 'login'
try {
 $page = $client.GetAsync($origin+'/login').GetAwaiter().GetResult()
 $html = $page.Content.ReadAsStringAsync().GetAwaiter().GetResult()
 $csrf = [regex]::Match($html,'name="csrf" value="([^"]+)"').Groups[1].Value
 $page.Dispose()
 if (!$csrf) { throw 'Login challenge unavailable' }
 $fields = [Collections.Generic.Dictionary[string,string]]::new()
 $fields.Add('username',$username); $fields.Add('password',$password); $fields.Add('csrf',$csrf); $fields.Add('next','/work')
 $login = $client.PostAsync($origin+'/login',[Net.Http.FormUrlEncodedContent]::new($fields)).GetAwaiter().GetResult()
 if ([int]$login.StatusCode -ne 303) { throw 'Sign-in failed' }
 $login.Dispose(); $signedIn = $true
 $stage = 'manifest'
 $desktopResponse = $client.GetAsync($origin+'/work/api/desktop').GetAwaiter().GetResult()
 if (!$desktopResponse.IsSuccessStatusCode) { throw 'Public desktop API failed' }
 $desktop = $desktopResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
 $desktopResponse.Dispose()
 $macFiles = @($desktop.downloads.files | Where-Object os -eq 'darwin')
 if ($macFiles.Count -ne 2) { throw 'Mac downloads unavailable' }
 $verified = @()
 foreach ($entry in $macFiles) {
  if ($entry.name -notmatch '^seek-desktop-0\.5\.1-mac-universal\.(dmg|zip)$' -or $desktop.downloads.ciRun -ne 37851619104) { throw 'Public link still serves the old Mac installer' }
  $stage = 'download-' + $entry.kind
  $response = $client.GetAsync($origin+'/work/downloads/'+[Uri]::EscapeDataString($entry.name), [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  try {
   if (!$response.IsSuccessStatusCode -or ($null -ne $response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -ne $entry.size)) { throw 'Public Mac download response mismatch' }
   $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
   $hash = [Security.Cryptography.SHA256]::Create()
   try { $actual = [Convert]::ToHexString($hash.ComputeHash($stream)).ToLowerInvariant() } finally { $hash.Dispose(); $stream.Dispose() }
   if ($actual -ne $entry.sha256) { throw 'Public Mac download checksum mismatch' }
   $verified += [pscustomobject]@{kind=$entry.kind; name=$entry.name; status=[int]$response.StatusCode; sha256Verified=$true; bytes=$entry.size}
  } finally { $response.Dispose() }
 }
 [pscustomobject]@{publicMacLinksUpdated=$true; notarized=$false; files=$verified} | ConvertTo-Json -Depth 4
} catch {
 [pscustomobject]@{failedStage=$stage; responseStatus=if($response){[int]$response.StatusCode}else{$null}; responseLength=if($response){$response.Content.Headers.ContentLength}else{$null}; errorType=$_.Exception.GetType().Name} | ConvertTo-Json
 throw "Public Mac verification failed during $stage; sign-in details withheld"
} finally {
 if ($signedIn) { try { $logout=$client.GetAsync($origin+'/logout').GetAwaiter().GetResult(); $logout.Dispose() } catch {} }
 $client.Dispose(); $handler.Dispose(); $password=$null; $username=$null
}
