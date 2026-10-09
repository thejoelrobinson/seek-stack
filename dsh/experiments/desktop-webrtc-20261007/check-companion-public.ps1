$ErrorActionPreference='Stop'
$origin='https://seek.joelcrobinson.com'
$username=[Environment]::GetEnvironmentVariable('DSH_PROXY_USER','User')
$password=[Environment]::GetEnvironmentVariable('DSH_PROXY_PASS','User')
if(!$username -or !$password){throw 'Existing Seek sign-in credentials are unavailable'}
$handler=[Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect=$false
$handler.CookieContainer=[Net.CookieContainer]::new()
$client=[Net.Http.HttpClient]::new($handler)
$client.Timeout=[TimeSpan]::FromSeconds(20)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('Seek-Release-Check/0.4.0')
$client.DefaultRequestHeaders.Add('Origin',$origin)
$signedIn=$false
$stage='login-page'
try{
 $page=$client.GetAsync($origin+'/login').GetAwaiter().GetResult()
 $html=$page.Content.ReadAsStringAsync().GetAwaiter().GetResult()
 $csrf=[regex]::Match($html,'name="csrf" value="([^"]+)"').Groups[1].Value
 if(!$csrf){throw 'Seek login challenge unavailable'}
 $stage='sign-in'
 $fields=[Collections.Generic.Dictionary[string,string]]::new()
 $fields.Add('username',$username);$fields.Add('password',$password);$fields.Add('csrf',$csrf);$fields.Add('next','/work')
 $login=$client.PostAsync($origin+'/login',[Net.Http.FormUrlEncodedContent]::new($fields)).GetAwaiter().GetResult()
 if([int]$login.StatusCode -ne 303){throw 'Seek release check could not sign in'}
 $signedIn=$true
 $stage='protected-apis'
 $versionResponse=$client.GetAsync($origin+'/work/api/version').GetAwaiter().GetResult()
 $desktopResponse=$client.GetAsync($origin+'/work/api/desktop').GetAwaiter().GetResult()
 if(!$versionResponse.IsSuccessStatusCode -or !$desktopResponse.IsSuccessStatusCode){throw 'Protected public API failed'}
 $version=$versionResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
 $desktop=$desktopResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
 if($version.plugin -ne '0.8.1' -or $desktop.downloads.version -ne '0.5.1'){throw 'Public release version mismatch'}
 $stage='installer'
 $installerEntry=$desktop.downloads.files | Where-Object {$_.os -eq 'win32' -and $_.kind -eq 'installer'}
 if(!$installerEntry -or $installerEntry.size -lt 100000000){throw 'Verified Windows installer unavailable'}
 $download=$client.GetAsync($origin+'/work/downloads/'+[Uri]::EscapeDataString($installerEntry.name),[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
 try{
  if(!$download.IsSuccessStatusCode -or ($null -ne $download.Content.Headers.ContentLength -and $download.Content.Headers.ContentLength -ne $installerEntry.size)){throw 'Public installer response mismatch'}
  $stream=$download.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
  if($stream.ReadByte() -ne 77 -or $stream.ReadByte() -ne 90){throw 'Windows installer signature unavailable'}
  [pscustomobject]@{publicPlugin=$version.plugin;desktopDownloads=$desktop.downloads.version;installerAccessible=$true;windowsExecutableSignature=$true;relayConfigured=$desktop.relay.configured;proxyRelease=$version.proxyRelease} | ConvertTo-Json
 }finally{$download.Dispose()}
}catch{[pscustomobject]@{failedStage=$stage;errorType=$_.Exception.GetType().Name;loginStatus=if($login){[int]$login.StatusCode}else{$null};pageStatus=if($page){[int]$page.StatusCode}else{$null};downloadStatus=if($download){[int]$download.StatusCode}else{$null};downloadLength=if($download){$download.Content.Headers.ContentLength}else{$null}} | ConvertTo-Json;throw 'Public release verification failed; credential details withheld'}
finally{
 if($signedIn){try{$logout=$client.GetAsync($origin+'/logout').GetAwaiter().GetResult();$logout.Dispose()}catch{}}
 $client.Dispose();$handler.Dispose();$password=$null;$username=$null
}
