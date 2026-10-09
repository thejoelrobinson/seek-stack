import {readFile,writeFile,cp,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url)),repo=resolve(here,'../../..'),source=join(repo,'dsh/plugins/browser-viewer'),candidate=join(here,'candidate/dsh/plugins/browser-viewer');
const replace=(text,old,next,name)=>{if(!text.includes(old)||text.indexOf(old)!==text.lastIndexOf(old))throw Error('Expected one match: '+name);return text.replace(old,next);};
const transformations={
 'work-assets.js':text=>replace(text,"Object.assign(WORK_FILES,{'/work/product.js':'work-product.js'});","Object.assign(WORK_FILES,{'/work/product.js':'work-product.js','/work/editorial.js':'work-editorial.js','/work/editorial.css':'work-editorial.css','/work/theme.js':'work-theme.js'});",'asset routes'),
 'work-buddy.js':text=>{
  text="import {applyProductPalette} from '/work/theme.js';\n"+text;
  return replace(text,'  const p = PALETTES[color];','  const p = PALETTES[color];\n  applyProductPalette(p);','product palette');
 },
 'work-client.js':text=>{
  text="import {homeGreeting,recentWork,syncEditorial,appearanceEditor} from '/work/editorial.js';\n"+text;
  text=replace(text,"  const t=current(),waiting=needsYou().length,home=view==='chat'&&!selected,main=$('#main');","  const t=current(),waiting=needsYou().length,home=view==='chat'&&!selected,main=$('#main');\n  syncEditorial({view,task:t});",'workspace sync');
  text=replace(text,"[state.settings.name,state.settings.look,state.ideas,state.headsUp,ideasBusy,wideHome()]","[state.settings.name,state.settings.look,state.ideas,state.headsUp,ideasBusy,wideHome(),state.tasks.map(x=>[x.id,x.title,x.status,x.activity,x.updatedAt,x.archived,x.artifacts?.length])]",'home revisions');
  text=replace(text,"if(slot&&view==='chat'&&!selected&&wideHome())","if(slot&&view==='chat'&&!selected)",'phone home composer');
  text=replace(text,'return `${headsUp}<section class="home-section">','return `${headsUp}${recentWork(state.tasks)}<section class="home-section">','recent work');
  const greeting=/<div class="home-greet"><div class="buddy-stage hero"[\s\S]*?<\/p><\/div><div class="composer-slot"/;
  if(!greeting.test(text))throw Error('Home greeting missing');text=text.replace(greeting,'${homeGreeting()}<div class="composer-slot"');
  text=replace(text,'<section class="memory"><form id="memory-form">','${appearanceEditor()}<section class="memory"><form id="memory-form">','appearance controls');
  return text;
 },
 'work.html':text=>{
  text=replace(text,'<link rel="stylesheet" href="/work/models.css">','<link rel="stylesheet" href="/work/models.css"><link rel="stylesheet" href="/work/editorial.css">','editorial stylesheet');
  text=replace(text,'<nav class="side-nav" aria-label="Workspace">','<nav class="side-nav" aria-label="Workspace"><button data-editorial-home aria-label="Home"><svg class="ic" aria-hidden="true"><use href="#i-chat"/></svg><span>Home</span></button>','home route');
  text=replace(text,'<div class="top-actions">','<div class="top-actions"><button id="editorial-search" aria-label="Search chats, files and memory" title="Search"><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg></button><button id="experience-layout" type="button" aria-label="Use Canvas layout">Canvas</button>','layout controls');
  return text;
 },
 'work-browser.js':text=>{
  text=replace(text,"  $('#bv-keys').hidden = !drive;","  $('#bv-keys').hidden = !drive || (mirrorWanted && !mirrorFallback && !mirrorRelay);",'native keyboard shelf');
  text=replace(text,'<div class="bv-stage" id="bv-stage">','<div class="bv-stage" id="bv-stage">','stage sentinel');
  text=replace(text,"  const quality=document.createElement('button');","  const tools=document.createElement('button');tools.id='bv-tools';tools.type='button';tools.dataset.bv='tools';tools.setAttribute('aria-label','Browser options: tabs and reload');tools.setAttribute('aria-expanded','false');tools.innerHTML=icon('more');$('#bv-nav').append(tools);\n  const quality=document.createElement('button');",'browser options');
  text=replace(text,"  else if (a === 'more')", "  else if(a==='tools'){const open=$('#bv-sheet').classList.toggle('tools-open');b.setAttribute('aria-expanded',String(open));requestAnimationFrame(fit);}\n  else if (a === 'more')",'browser options action');
  return text;
 }
};
// Preflight every surgical edit before touching shared source. Other chats' changes stay intact.
const pending=[];
for(const root of [candidate,source])for(const [name,transform]of Object.entries(transformations)){
 const path=join(root,'lib',name),before=await readFile(path,'utf8');pending.push({path,before,after:transform(before)});
}
await mkdir(join(here,'source-before'),{recursive:true});
for(const row of pending){if(row.path.startsWith(source))await writeFile(join(here,'source-before',row.path.split(/[\\/]/).at(-1)),row.before);await writeFile(row.path,row.after);}
for(const name of ['work-editorial.js','work-editorial.css','work-theme.js'])await cp(join(source,'lib',name),join(candidate,'lib',name));
for(const root of [candidate,source]){const file=join(root,'package.json'),pkg=JSON.parse(await readFile(file,'utf8'));pkg.version='0.6.0';await writeFile(file,JSON.stringify(pkg,null,2)+'\n');}
console.log('Editorial wired into the isolated release and shared source; existing edits preserved.');
