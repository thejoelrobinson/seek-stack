import {validateReleaseFiles} from '../../desktop-bridge/scripts/release-files.mjs';
export const RELEASE_REPO='thejoelrobinson/seek-stack';
export function verifiedRun(run,{sha,workflow}){
 return run?.head_sha===sha&&run.head_branch==='main'&&run.event==='push'&&run.status==='completed'&&run.conclusion==='success'&&run.path==='.github/workflows/'+workflow;
}
export function verifiedManifest(manifest){
 if(manifest?.schema!==1||!Number.isSafeInteger(manifest.ciRun)||manifest.ciRun<1||!Number.isSafeInteger(manifest.workRun)||manifest.workRun<1)throw Error('Invalid release CI provenance');
 return {...manifest,files:validateReleaseFiles([manifest],manifest)};
}
export function sourceOnMain(compare){return ['ahead','identical'].includes(compare?.status);}
export function activeWork(state){return !Array.isArray(state?.tasks)||state.tasks.some(t=>!t.archived&&(['running','queued','attention'].includes(t.status)||t.approval||t.handoff||t.nativeRequest||t.desktopAsk));}
