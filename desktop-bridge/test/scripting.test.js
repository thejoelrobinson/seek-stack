import test from 'node:test';import assert from 'node:assert/strict';import {DesktopSession} from '../src/session.js';import {DesktopScripts} from '../src/scripting.js';
test('script authority is separate, session bound, and removed on takeover or task change',()=>{
 const session=new DesktopSession(),auth=session.grant('first');assert.throws(()=>session.checkScripts(auth),/approval/);
 session.allowScripts(auth);assert.doesNotThrow(()=>session.checkScripts(auth));session.revoke();const next=session.grant('second');assert.throws(()=>session.allowScripts(auth),/Stale/);assert.throws(()=>session.checkScripts(next),/approval/);
});
test('Windows scripts support Unicode, bounded output, explicit timeout and takeover', {skip:process.platform!=='win32'}, async()=>{
 const scripts=new DesktopScripts();const result=await scripts.run({language:'powershell',source:"[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output 'Fixture ✓'"});assert.equal(result.exitCode,0);assert.match(result.output.map(c=>c.text).join(''),/Fixture ✓/);
 const large=await scripts.run({language:'powershell',source:"Write-Output ('x'*40000)"});assert.equal(large.truncated,true);assert.ok(large.output.map(c=>c.text).join('').length<=24000);
 await assert.rejects(scripts.run({language:'powershell',source:'Start-Sleep 20',timeoutMs:100}),/timed out/);
 const flight=scripts.run({language:'powershell',source:'Start-Sleep 20'});scripts.stop();await assert.rejects(flight,/takeover/);
});
