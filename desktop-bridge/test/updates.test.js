import test from 'node:test';import assert from 'node:assert/strict';
import {availableUpdate,compareVersions,UpdateChecker} from '../src/updates.js';
const release=(version='0.5.2',suffix='mac-universal.dmg')=>({tag_name:'bridge-v'+version,draft:false,prerelease:true,assets:[{name:`seek-desktop-${version}-${suffix}`,browser_download_url:`https://github.com/thejoelrobinson/seek-stack/releases/download/bridge-v${version}/seek-desktop-${version}-${suffix}`,size:20000000}]});
test('updates select the newer platform installer from the fixed repository only',()=>{
 assert.equal(compareVersions('0.5.10','0.5.2'),1);assert.equal(availableUpdate([release()], '0.5.1','darwin','arm64').version,'0.5.2');
 for(const bad of [{...release(),draft:true},{...release(),tag_name:'bridge-v0.5.2-beta'},release('0.5.0'),{...release(),assets:[{...release().assets[0],browser_download_url:'https://example.com/app.dmg'}]}])assert.equal(availableUpdate([bad],'0.5.1','darwin','arm64'),null);
 assert.equal(availableUpdate([release()],'0.5.1','win32','x64'),null);assert.equal(availableUpdate([release()],'0.5.1','linux','arm64'),null);
});
test('checks coalesce, cache without downloads, and retry errors explicitly',async()=>{
 let calls=0,failed=false;const c=new UpdateChecker({version:'0.5.1',platform:'darwin',arch:'x64',now:()=>1000,fetch:async()=>{calls++;return {ok:!failed,text:async()=>JSON.stringify([release()])};}});
 const [a,b]=await Promise.all([c.check(),c.check()]);assert.equal(a.version,b.version);assert.equal(calls,1);await c.check();assert.equal(calls,1);
 failed=true;assert.equal((await c.check(true)).state,'error');failed=false;assert.equal((await c.check(true)).state,'available');
});
