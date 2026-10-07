import {spawnSync} from 'node:child_process';
import {rmSync} from 'node:fs';
// macOS: one universal helper (Apple silicon + Intel) so the universal app runs on every Mac.
if(process.platform==='darwin'){
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit'});if(r.error)throw r.error;if(r.status)process.exit(r.status);};
 const sources=['native/accessibility.swift','native/main.swift'];
 for(const [arch,target] of [['arm64','arm64-apple-macos12'],['x64','x86_64-apple-macos12']])run('swiftc',['-target',target,...sources,'-o',`native/seek-input-${arch}`]);
 run('lipo',['-create','native/seek-input-arm64','native/seek-input-x64','-output','native/seek-input']);
 for(const arch of ['arm64','x64'])rmSync(`native/seek-input-${arch}`,{force:true});
}
