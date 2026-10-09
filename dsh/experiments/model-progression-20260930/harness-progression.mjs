import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {writeFile,open,mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {CdpBrowser} from '../../plugins/browser-viewer/lib/cdp.js';
const root=fileURLToPath(new URL('.',import.meta.url)),home=join(root,'harness-home'),origin='http://127.0.0.1:3081';
const hold=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const create=hold(),restore=hold();let language='loaded',runnerProgress=null;
const fixture=createServer(async(req,res)=>{
 let input='';for await(const chunk of req)input+=chunk;const body=input?JSON.parse(input):{};
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(req.url==='/v1/models')return json({data:[{id:'qwen3.8-27b',status:{value:language}}]});
 if(req.url==='/models/unload'){language='unloaded';return json({});}
 if(req.url==='/models/load'){language='loading';await restore.promise;language='loaded';return json({});}
 if(req.url==='/health')return json({available:true,ready:true,loaded:runnerProgress?.phase==='creating',progress:runnerProgress});
 if(req.url==='/generate'){runnerProgress={id:body.id,phase:'loadingImage'};await create.promise;runnerProgress.phase='savingImage';await writeFile(join(body.outputDir,body.id+'.png'),Buffer.alloc(128,1));return json({file:body.id+'.png',width:body.width,height:body.height});}
 if(req.url==='/unload'){runnerProgress=null;return json({released:true});}
 return json({},404);
});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const fixtureOrigin='http://127.0.0.1:'+fixture.address().port;
const log=await open(join(home,'web.log'),'w'),err=await open(join(home,'web.err'),'w');
const child=spawn(process.execPath,['--import','./test/register-profile.mjs',join(homedir(),'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--host','127.0.0.1','--port','3081'],{cwd:resolve(root,'../../plugins/browser-viewer'),env:{...process.env,DSH_HOME:home,DSH_WORK_HOME:join(home,'work'),DSH_BROWSER_USER_DATA_DIR:join(home,'browser'),SEEK_MODEL_URL:fixtureOrigin,SEEK_IMAGE_URL:fixtureOrigin,DSH_DISABLE_TELEMETRY:'1'},stdio:['ignore',log.fd,err.fd],windowsHide:true});
const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-cordis-models-')),windowSize:'1440,1050'});
async function api(path,body){const r=await fetch(origin+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
async function until(fn,label){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await fn().catch(()=>false))return;await new Promise(r=>setTimeout(r,100));}throw new Error('Harness timeout: '+label);}
let generation,complete=false;
try{
 await until(()=>api('/work/api/updates').then(v=>v.health.models?.language.state==='ready'&&v.health.models.image.available===true),'Cordis model/image service');
 await ui.launch();const tab=await ui.newTab(origin+'/work');await until(()=>ui.evaluate(tab,"document.querySelector('#model-status')?.textContent.includes('Qwen 3.8')"),'ribbon');await ui.evaluate(tab,"document.querySelector('[data-view=images]').click();true");await until(()=>ui.evaluate(tab,"!!document.querySelector('#image-create')"),'image form');
 generation=await api('/qwen-image/api/start',{prompt:'Isolated model progression fixture.'});assert.equal(generation.accepted,true);
 await until(()=>api('/work/api/updates').then(v=>v.health.models.job?.phase==='loadingImage'),'loading image crosses plugin service');
 await until(()=>ui.evaluate(tab,"document.querySelector('.model-journey h3')?.textContent==='Loading Qwen Image 2.1'"),'SSE loading state');
 runnerProgress.phase='creating';await until(()=>ui.evaluate(tab,"document.querySelector('.model-journey h3')?.textContent==='Creating your image'"),'real runner health reaches UI');
 create.resolve();await until(()=>ui.evaluate(tab,"document.querySelector('.model-journey h3')?.textContent==='Bringing chat back'"),'restoration state');assert.equal(language,'loading');
 const status=await api('/work/api/updates');assert.equal(status.health.models.active,true);assert.equal(status.health.models.language.state,'loading');
 restore.resolve();await until(()=>api("/qwen-image/api/job?id="+generation.id).then(v=>v.job.phase==="complete"),"async job completion");await until(()=>ui.evaluate(tab,"document.querySelector('.model-journey h3')?.textContent==='Your image is ready'"),'confirmed completion');assert.equal(language,'loaded');
 const result={passed:true,kind:'isolated real DSH host with controlled router/runner',checks:['Cordis cross-plugin service','runner health stages','SSE while revision unchanged','image saved before restoration','active until chat ready','completion reaches browser']};await writeFile(join(root,'validation/harness-progression.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));complete=true;
}finally{create.resolve();restore.resolve();await ui.close();child.kill();await log.close();await err.close();fixture.closeAllConnections();await new Promise(r=>fixture.close(r));}
