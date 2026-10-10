import {spawnSync} from 'node:child_process';
export const HELPER_ID='com.joelcrobinson.seek.desktop.input';
export function signHelper(env=process.env){
 if(process.platform!=='darwin')return;
 const identity=env.SEEK_MAC_SIGNING_IDENTITY||env.CSC_NAME;
 if(!identity)return;
 const result=spawnSync('/usr/bin/codesign',['--force','--sign',identity,'--identifier',HELPER_ID,...(env.SEEK_MAC_SIGNED_RELEASE==='1'?['--options','runtime','--timestamp']:['--timestamp=none']),'native/seek-input'],{stdio:'inherit'});
 if(result.error||result.status!==0)throw Error('Could not sign the native helper with the persistent certificate');
}
