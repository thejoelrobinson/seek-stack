// Uses the host-local API; private snapshots and restored data stay outside the checkout.
import assert from 'node:assert/strict';
import {mkdir,writeFile,open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WorkBackups} from '../../plugins/browser-viewer/lib/work-backups.js';
const execute=promisify(execFile),run=process.argv.includes('--run'),base='http://127.0.0.1:3080';
const root=join(homedir(),'.dsh','work'),helper=fileURLToPath(new URL('./release-data.mjs',import.meta.url));
async function api(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});const value=await response.json();assert.ok(response.ok,value.error||'Backup API failed');return value;}
async function data(...args){const {stdout}=await execute(process.execPath,[helper,...args]);return JSON.parse(stdout);}
const version=await api('/work/api/version'),state=await api('/work/api/state'),images=await api('/qwen-image/api/status'),helpers=await api('/work/api/helper-status');
assert.equal(version.plugin,'0.5.0');assert.ok(!state.tasks.some(t=>['running','queued','waiting'].includes(t.status))&&!images.active&&!images.recoveryRequired&&!helpers.foregroundBusy&&!helpers.active&&!helpers.pending,'Backup validation waits for idle');
if(!run){console.log(JSON.stringify({mode:'read-only-plan',release:version.release,tasks:state.tasks.length,images:images.history,willCreateBackup:false}));process.exit(0);}
const directory=join(homedir(),'.dsh','browser','validation','backup-restore-'+Date.now());await mkdir(directory,{recursive:true});
const before=join(directory,'protected-inventory.json');await data('inventory',root,before);
const start=performance.now(),archive=await api('/work/api/backups/create',{}),captureMs=Math.round(performance.now()-start);
const handle=await open(archive.path,'r'),header=Buffer.alloc(8);try{await handle.read(header,0,8,0);}finally{await handle.close();}assert.equal(header.toString(),'SEEKBAK2');
const backups=await new WorkBackups(root).init(),destination=join(directory,'restored-work'),restored=await backups.restore(archive.path,destination);
assert.ok(restored.verified);assert.equal(restored.files,archive.files);assert.equal(restored.rawBytes,archive.rawBytes);
const compare=await data('compare-restored',before,destination,root);assert.ok(compare.verified);
await data('compare',before,root);
const status=await api('/work/api/backups');assert.ok(status.encrypted&&!status.error&&!status.active&&status.lastFile===archive.name);
const result={at:new Date().toISOString(),release:version.release,encrypted:true,format:2,archiveBytes:archive.bytes,rawBytes:archive.rawBytes,files:archive.files,captureMs,restored:true,restoredTaskCount:compare.taskCount,restoredImageCount:compare.imageCount,restoredArtifactCount:compare.artifactCount,allArchiveFileHashesVerified:true,liveDataPreserved:true};
await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({...result,privateValidationDirectory:directory}));
