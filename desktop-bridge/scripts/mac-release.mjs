export function macNotarizationCredentials(env = process.env) {
 if (env.APPLE_KEYCHAIN_PROFILE) return {keychainProfile: env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? {keychain: env.APPLE_KEYCHAIN} : {})};
 if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
  return {appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER};
 if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
  return {appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID};
 return null;
}
export function assertMacReleaseCredentials(env = process.env, platform = process.platform) {
 // GitHub represents missing optional secrets as empty strings; builder otherwise imports an empty certificate.
 if (env.CSC_LINK === '') delete env.CSC_LINK;
 if (platform !== 'darwin') return;
 if(env.GITHUB_EVENT_NAME==='pull_request'){
  // electron-builder otherwise skips even '-' ad-hoc signatures on PRs, leaving a modified
  // universal bundle unsigned. Only permit this override without any certificate credentials.
  if(env.SEEK_MAC_SIGNED_RELEASE==='1'||env.SEEK_MAC_SIGNING_IDENTITY||env.CSC_LINK||env.CSC_NAME||env.CSC_KEYCHAIN)
   throw Error('Pull-request Mac builds may use ad-hoc signatures only; signing credentials must be withheld.');
  env.CSC_FOR_PULL_REQUEST='true';env.CSC_IDENTITY_AUTO_DISCOVERY='false';
 }
 const tagged = /^refs\/tags\/bridge-v/.test(env.GITHUB_REF || '');
 if(env.SEEK_MAC_SIGNING_IDENTITY&&tagged)throw Error('Personal certificates are for your own Mac builds; tagged public downloads need the preview or Developer ID release path.');
 if(env.SEEK_MAC_SIGNING_IDENTITY&&env.SEEK_MAC_SIGNED_RELEASE==='1')throw Error('Choose personal signing or a Developer ID release, not both.');
 if (tagged && env.SEEK_MAC_SIGNED_RELEASE !== '1' && env.SEEK_MAC_ALLOW_UNNOTARIZED_PREVIEW !== '1')
  throw Error('Public Mac releases require Developer ID signing and notarization. Configure the Mac release credentials first.');
 if (env.SEEK_MAC_SIGNED_RELEASE === '1') {
  if (!env.CSC_LINK && !env.CSC_NAME && !env.CSC_KEYCHAIN)
   throw Error('Mac release signing requires a Developer ID Application certificate.');
  if (!macNotarizationCredentials(env))
   throw Error('Mac release notarization credentials are incomplete.');
 }
}
