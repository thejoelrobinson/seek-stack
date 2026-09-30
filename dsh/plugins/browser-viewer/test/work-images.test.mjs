import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImageService} from '../../qwen-image/lib/image-service.js';

const root=await mkdtemp(join(tmpdir(),'dsh-images-'));let qwen='loaded',runnerLoaded=false;
const original=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
  const path=String(url),body=options.body?JSON.parse(options.body):{};
  if(path==='http://runner/health')return Response.json({available:true,ready:true,loaded:runnerLoaded});
  if(path==='http://router/v1/models')return Response.json({data:[{id:'qwen3.8-27b',status:{value:qwen}}]});
  if(path==='http://router/models/unload'){qwen='unloaded';return Response.json({success:true});}
  if(path==='http://router/models/load'){qwen='loaded';return Response.json({success:true});}
  if(path==='http://runner/generate'){
    await writeFile(join(body.outputDir,body.id+'.png'),Buffer.alloc(128, 1));
    runnerLoaded=true;return Response.json({file:body.id+'.png',width:body.width,height:body.height,seed:null});
  }
  if(path==='http://runner/unload'){runnerLoaded=false;return Response.json({released:true});}
  throw new Error('Unexpected fetch '+path);
};
try{
  const service=await new ImageService(root,{runnerUrl:'http://runner',routerUrl:'http://router'}).init();
  await assert.rejects(service.generate({prompt:''}),/Describe the image/);
  const image=await service.generate({prompt:'A tiny friendly robot, watercolor.',ratio:'portrait',steps:30});
  assert.equal(image.width,896);assert.equal(image.height,1152);assert.equal(qwen,'loaded','the language model is restored after generation');assert.equal(runnerLoaded,false,'runner releases image VRAM');
  assert.equal(service.history().items.length,1);assert.match(service.file(image.id),/\.png$/);
  await service.remove(image.id);assert.equal(service.history().items.length,0);
  console.log('PASS: image generation validates input, hands off GPU ownership, stores an image, and restores the coding model.');
}finally{globalThis.fetch=original;}
