// Render Seek's actual SVG character in an isolated browser. No live app or GPU.
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,stat} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {CdpBrowser} from '../../plugins/browser-viewer/lib/cdp.js';
import {WorkAssets} from '../../plugins/browser-viewer/lib/work-assets.js';

const root=dirname(fileURLToPath(import.meta.url)),output=join(root,'validation');
const frames=join(root,'runtime-backup','character-preview-frames');
const assets=await new WorkAssets().init();
const stages=[
  {phase:'loadingImage',label:'Switching to images',frames:20},
  {phase:'creating',label:'Creating your image',frames:30},
  {phase:'restoringChat',label:'Bringing chat back',frames:30}
];
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/work/buddy.css?v=${assets.release}">
<style>
html,body{margin:0;width:320px;height:230px;overflow:hidden;background:#faf9f6}
body{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#756486}
main{width:320px;height:230px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
#preview-character{--bs:128px!important;cursor:default}
#preview-label{font-size:12px;line-height:18px;font-weight:500;letter-spacing:.05px}
</style></head><body><main><span id="preview-character" class="buddy" data-buddy="studio"></span><span id="preview-label"></span></main>
<script type="module">
window.previewErrors=[];
window.addEventListener('error',event=>previewErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>previewErrors.push(String(event.reason)));
const models=await import('/work/models.js?v=${assets.release}');
window.setPreviewPhase=(phase,label)=>{
  models.updateModels({active:true,language:{name:'Qwen 3.8 · 27B',state:phase==='restoringChat'?'loading':'standby'},image:{name:'Qwen Image 2.1',state:phase==='creating'?'creating':'loading'},job:{id:'preview',phase,startedAt:Date.now(),phases:[]}});
  document.querySelector('#preview-label').textContent=label;
};
setPreviewPhase('loadingImage','Switching to images');
await import('/work/buddy.js?v=${assets.release}');
window.previewReady=true;
</script></body></html>`;
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://preview');
  if(url.pathname==='/preview'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
  if(!assets.serve(req,res,url)){res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-character-preview-')),windowSize:'320,230'});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let count=0;
try{
  await mkdir(frames,{recursive:true});await mkdir(output,{recursive:true});
  await ui.launch();const tab=await ui.newTab('about:blank');
  await ui.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]},ui.tabs.get(tab));
  await ui.navigate(tab,'http://127.0.0.1:'+server.address().port+'/preview');
  const deadline=Date.now()+5000;
  while(!await ui.evaluate(tab,'!!window.previewReady')){if(Date.now()>deadline)throw new Error('Character preview did not load');await wait(25);}
  // Restart the first pose after mounting so the preview includes the exchange.
  await ui.evaluate(tab,"setPreviewPhase('preparing','Switching to images');true");
  for(const stage of stages){
    await ui.evaluate(tab,`setPreviewPhase(${JSON.stringify(stage.phase)},${JSON.stringify(stage.label)});true`);
    await ui.evaluate(tab,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const started=performance.now();
    for(let frame=0;frame<stage.frames;frame++){
      const png=Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64');
      await writeFile(join(frames,String(count).padStart(4,'0')+'.png'),png);
      if(stage.phase==='creating'&&frame===16)await writeFile(join(output,'character-painter.png'),png);
      count++;
      const remaining=started+(frame+1)*100-performance.now();if(remaining>0)await wait(remaining);
    }
  }
  const errors=await ui.evaluate(tab,'previewErrors');if(errors.length)throw new Error(errors.join('; '));
}finally{
  await ui.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
const python=process.env.SEEK_PREVIEW_PYTHON||join(homedir(),'AppData','Local','Programs','Python','Python312','python.exe');
const result=spawnSync(python,['-c',`
from pathlib import Path
from PIL import Image
import sys
folder, destination = Path(sys.argv[1]), Path(sys.argv[2])
sources = [Image.open(path).convert('RGB') for path in sorted(folder.glob('*.png'))]
samples = sources[::5]
sheet = Image.new('RGB', (320 * 4, 230 * 4), '#faf9f6')
for index, source in enumerate(samples[:16]):
    sheet.paste(source, ((index % 4) * 320, (index // 4) * 230))
palette = sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
frames = [source.quantize(palette=palette, dither=Image.Dither.NONE) for source in sources]
frames[0].save(destination, save_all=True, append_images=frames[1:], duration=100, loop=0, disposal=2, optimize=False)
with Image.open(destination) as result:
    duration = 0
    for index in range(result.n_frames):
        result.seek(index)
        duration += result.info.get('duration', 0)
    assert result.size == (320, 230) and duration == 8000 and result.n_frames >= 60, (result.size, duration, result.n_frames)
    print(f'{result.n_frames} frames; {duration} ms; {result.size[0]} x {result.size[1]}')
`,frames,join(output,'character-preview.gif')],{encoding:'utf8',windowsHide:true});
if(result.status!==0)throw new Error(result.stderr||result.stdout||'GIF encoding failed');
const bytes=(await stat(join(output,'character-preview.gif'))).size;
console.log(JSON.stringify({release:assets.release,frames:count,durationMs:8000,width:320,height:230,bytes,gif:join(output,'character-preview.gif'),painter:join(output,'character-painter.png'),validation:result.stdout.trim()}));
