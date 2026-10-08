export function macNotarizationCredentials(env = process.env) {
 if (env.APPLE_KEYCHAIN_PROFILE) return {keychainProfile: env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? {keychain: env.APPLE_KEYCHAIN} : {})};
 if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
  return {appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER};
 if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
  return {appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID};
 return null;
}
export function assertMacReleaseCredentials(env = process.env, platform = process.platform) {
 if (platform !== 'darwin') return;
 const tagged = /^refs\/tags\/bridge-v/.test(env.GITHUB_REF || '');
 if (tagged && env.SEEK_MAC_SIGNED_RELEASE !== '1')
  throw Error('Public Mac releases require Developer ID signing and notarization. Configure the Mac release credentials first.');
 if (env.SEEK_MAC_SIGNED_RELEASE === '1') {
  if (!env.CSC_LINK && !env.CSC_NAME && !env.CSC_KEYCHAIN)
   throw Error('Mac release signing requires a Developer ID Application certificate.');
  if (!macNotarizationCredentials(env))
   throw Error('Mac release notarization credentials are incomplete.');
 }
}
