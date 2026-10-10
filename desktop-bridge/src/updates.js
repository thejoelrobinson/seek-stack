const repo='thejoelrobinson/seek-stack';
export function compareVersions(a,b){
 const parse=v=>{if(!/^\d+\.\d+\.\d+$/.test(v))throw Error('Invalid release version');return v.split('.').map(Number);};
 const x=parse(a),y=parse(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);return 0;
}
export function availableUpdate(releases,current,platform,arch){
 const suffix=platform==='darwin'?'mac-universal.dmg':platform==='win32'&&arch==='x64'?'win-x64.exe':platform==='linux'&&arch==='x64'?'linux-x86_64.AppImage':null;
 if(!suffix)return null;
 const rows=releases.filter(r=>!r.draft&&/^bridge-v\d+\.\d+\.\d+$/.test(r.tag_name)).sort((a,b)=>compareVersions(b.tag_name.slice(8),a.tag_name.slice(8)));
 for(const r of rows){const version=r.tag_name.slice(8);if(compareVersions(version,current)<=0)continue;
  const name=`seek-desktop-${version}-${suffix}`,url=`https://github.com/${repo}/releases/download/bridge-v${version}/${name}`;
  if(r.assets?.some(a=>a.name===name&&a.browser_download_url===url&&Number(a.size)>10000000))return {version,url,preview:!!r.prerelease};
 }return null;
}
export class UpdateChecker{
 constructor({version,platform,arch,fetch,onChange=()=>{},now=()=>Date.now()}){Object.assign(this,{version,platform,arch,fetch,onChange,now});this.last=0;this.state={state:'unchecked',current:version};this.flight=null;}
 emit(state){this.state={current:this.version,...state};this.onChange(this.state);return this.state;}
 check(force=false){if(this.flight)return this.flight;if(!force&&this.last&&this.now()-this.last<6*3600000)return Promise.resolve(this.state);
  this.emit({state:'checking'});this.flight=Promise.resolve().then(async()=>{try{
   const response=await this.fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('Updates could not be checked. Try again later.');const body=await response.text();if(body.length>1000000)throw Error('Update response is too large.');const releases=JSON.parse(body);if(!Array.isArray(releases))throw Error('Invalid release response.');
   const update=availableUpdate(releases,this.version,this.platform,this.arch);return this.emit(update?{state:'available',...update}:{state:'current'});
  }catch(error){return this.emit({state:'error',error:error.message});}finally{this.last=this.now();this.flight=null;}});return this.flight;
 }
}
