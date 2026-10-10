import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMacReleaseCredentials, macNotarizationCredentials} from '../scripts/mac-release.mjs';
test('a tagged Mac release cannot silently skip signing or notarization', () => {
 const tagged = {GITHUB_REF: 'refs/tags/bridge-v0.4.1'};
 assert.throws(() => assertMacReleaseCredentials(tagged, 'darwin'), /require Developer ID/);
 assert.throws(() => assertMacReleaseCredentials({...tagged, SEEK_MAC_SIGNED_RELEASE: '1'}, 'darwin'), /certificate/);
 assert.throws(() => assertMacReleaseCredentials({...tagged, SEEK_MAC_SIGNED_RELEASE: '1', CSC_LINK: 'fixture'}, 'darwin'), /incomplete/);
 const ready = {...tagged, SEEK_MAC_SIGNED_RELEASE: '1', CSC_LINK: 'fixture', APPLE_ID: 'fixture', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'fixture'};
 assert.doesNotThrow(() => assertMacReleaseCredentials(ready, 'darwin'));
 assert.doesNotThrow(() => assertMacReleaseCredentials({}, 'darwin'));
 assert.doesNotThrow(() => assertMacReleaseCredentials(tagged, 'win32'));
 assert.doesNotThrow(() => assertMacReleaseCredentials({...tagged,SEEK_MAC_ALLOW_UNNOTARIZED_PREVIEW:'1'},'darwin'));
});
test('notarization accepts complete password, API key or keychain credentials only', () => {
 assert.equal(macNotarizationCredentials({APPLE_ID: 'fixture'}), null);
 assert.equal(macNotarizationCredentials({APPLE_API_KEY: 'fixture', APPLE_API_KEY_ID: 'fixture'}), null);
 assert.deepEqual(macNotarizationCredentials({APPLE_KEYCHAIN_PROFILE: 'fixture'}), {keychainProfile: 'fixture'});
 assert.deepEqual(macNotarizationCredentials({APPLE_API_KEY: 'key', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'issuer'}), {appleApiKey: 'key', appleApiKeyId: 'id', appleApiIssuer: 'issuer'});
});
test('personal signing is explicit, local only, and cannot masquerade as a Developer ID release',()=>{
 assert.doesNotThrow(()=>assertMacReleaseCredentials({SEEK_MAC_SIGNING_IDENTITY:'Seek Desktop Personal'},'darwin'));
 assert.throws(()=>assertMacReleaseCredentials({SEEK_MAC_SIGNING_IDENTITY:'Seek Desktop Personal',SEEK_MAC_SIGNED_RELEASE:'1'},'darwin'),/Choose personal/);
 assert.throws(()=>assertMacReleaseCredentials({SEEK_MAC_SIGNING_IDENTITY:'Seek Desktop Personal',GITHUB_REF:'refs/tags/bridge-v0.5.2'},'darwin'),/Personal certificates/);
});
test('PR previews permit ad-hoc bundle integrity signing but reject certificate credentials',()=>{
 const preview={GITHUB_EVENT_NAME:'pull_request',CSC_LINK:'',SEEK_MAC_SIGNED_RELEASE:'0'};assertMacReleaseCredentials(preview,'darwin');assert.equal(preview.CSC_FOR_PULL_REQUEST,'true');assert.equal(preview.CSC_IDENTITY_AUTO_DISCOVERY,'false');
 for(const secret of ['CSC_LINK','CSC_NAME','CSC_KEYCHAIN','SEEK_MAC_SIGNING_IDENTITY'])assert.throws(()=>assertMacReleaseCredentials({GITHUB_EVENT_NAME:'pull_request',[secret]:'fixture'},'darwin'),/withheld/);
});
