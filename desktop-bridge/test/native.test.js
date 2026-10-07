import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import {NativeInput} from '../src/native.js';import {platformCapabilities} from '../src/platform.js';
const child=()=>Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){this.killed=true;}});
test('late worker exit cannot cancel the replacement worker',async()=>{
 const children=[];const native=new NativeInput({platform:'win32',spawnImpl:()=>{const c=child();children.push(c);return c;}});
 const first=native.execute({kind:'probe'});native.stop();await assert.rejects(first,/cancelled/);
 const second=native.execute({kind:'probe'});children[0].emit('exit',1);children[1].stdout.write('{"ok":true}\n');assert.deepEqual(await second,{ok:true});native.stop();
});
test('native timeout terminates pending work',async()=>{
 const c=child(),native=new NativeInput({platform:'win32',timeoutMs:10,spawnImpl:()=>c});await assert.rejects(native.execute({kind:'probe'}),/timeout/);assert.equal(c.killed,true);assert.equal(native.worker,null);
});
test('platform capabilities do not promise Wayland or independent cursors',()=>{
 assert.equal(platformCapabilities({platform:'linux',env:{DISPLAY:':0',XDG_SESSION_TYPE:'wayland'},xdotool:true}).input,false);
 assert.equal(platformCapabilities({platform:'linux',env:{DISPLAY:':0'},xdotool:true}).input,true);
 assert.equal(platformCapabilities({platform:'darwin',accessibility:false,macHelper:true}).input,false);
 assert.equal(platformCapabilities({platform:'win32'}).independentCursor,false);
});
