import {spawnSync} from 'node:child_process';
if(process.platform==='darwin'){
 const result=spawnSync('swiftc',['native/accessibility.swift','native/main.swift','-o','native/seek-input'],{stdio:'inherit'});
 if(result.error)throw result.error;process.exitCode=result.status??1;
}
