import './buddy.js';
const $=s=>document.querySelector(s),bridge=window.bridge;
let data={name:'Seek',look:{},tasks:[]},link={},local={},mode='chat',activeId='',busy=false,lastContent='';
const labels={chat:'CHAT',browser:'SEEK BROWSER',desktop:'THIS COMPUTER'};
const task=()=>data.tasks.find(t=>t.id===activeId);
const node=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const fail=e=>{$('#error').textContent=String(e.message||e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');$('#error').hidden=false;};
const run=async fn=>{if(busy)return;busy=true;document.body.dataset.busy='true';$('#error').hidden=true;render();try{await fn();}catch(e){fail(e);}finally{busy=false;document.body.dataset.busy='false';render();}};
const remember=t=>{data.tasks=[t,...data.tasks.filter(x=>x.id!==t.id)];activeId=t.id;lastContent='';};
function choose(value){mode=value;for(const b of $('.modes').children)b.setAttribute('aria-pressed',String(b.dataset.mode===mode));render();}
function render(){
 const t=task(),workingMode=t?.mode||mode,online=!!link.online,access=!!(local.capabilities?.input&&local.capabilities?.structuredObservation&&local.shortcutReady);
 $('#name').textContent=data.name||'Seek';$('#connection').textContent=online?'Connected to Seek':link.paired?'Reconnecting to Seek…':'Connect your sidekick';$('#connection').dataset.online=String(online);
 $('#connect').hidden=online;$('#connect').textContent=link.paired?'Check connection settings →':'Connect this computer to Seek →';
 $('.examples').hidden=!online;
 const computer=data.computers?.find(m=>m.id===$('#computer').value),remote=t?.remote||(!t&&!!computer);
 $('#scope').textContent=workingMode==='desktop'?(remote?`Seek will work on ${t?.computer||computer?.name||'your computer'}, without a local prompt.`:`Seek will use ${local.displays?.find(d=>d.id===local.selectedId)?.label||'your selected screen'}. You can stop it any time.`):workingMode==='browser'?'Seek works in its own browser. Open it to watch or take over.':'A conversation with your sidekick.';
 $('#computer').hidden=!!t||mode!=='desktop';
 $('#welcome').hidden=!!t;$('#conversation').hidden=!t;$('.modes').hidden=!!t;$('#input').disabled=!!(t?.needsFullApp||t?.needsBrowser);
 $('#send').textContent=t?(workingMode==='desktop'&&!remote&&local.state!=='agent'?'Reply & give control':'Send ↑'):mode==='desktop'?(remote?'Start remotely ↑':access?'Start on this computer ↑':'Enable desktop access →'):mode==='browser'?'Start in browser ↑':'Send ↑';
 $('#send').disabled=busy||!online;$('#input').placeholder=t?'Reply to Seek…':mode==='desktop'?'What should Seek do on this computer?':mode==='browser'?'What should Seek do in its browser?':'Ask Seek anything…';
 $('#stop').hidden=local.state!=='agent';$('#safety').textContent=local.state==='agent'?'Seek has control · Ctrl/⌘ + Alt + Shift + S to stop.':'Your chat travels over an encrypted connection.';
 if(!t)return;
 $('#where').textContent=t.remote?t.computer.toUpperCase():labels[t.mode]||'SEEK';$('#task-title').textContent=t.title;
 $('#progress').textContent=t.status==='queued'?'Your task is in the queue.':t.status==='running'?(t.activity||'Seek is working…'):t.status==='waiting'?'Waiting for your reply':t.status==='complete'?'Finished':t.status==='paused'?'Paused — you have control':t.status==='stopped'?'Stopped':t.error||t.status;
 const fingerprint=JSON.stringify([t.messages,t.question,t.artifacts,t.needsFullApp,t.needsBrowser]);
 if(fingerprint!==lastContent){
   const nearBottom=$('#scroll').scrollHeight-$('#scroll').scrollTop-$('#scroll').clientHeight<70;lastContent=fingerprint;
   $('#messages').replaceChildren(...(t.messages||[]).map(m=>{const article=node('article','','message '+m.role);article.append(node('span',m.role==='user'?'YOU':data.name||'Seek','author'),node('p',m.text));return article;}));
   for(const a of t.artifacts||[]){const b=node('button','↗ '+a.title,'artifact');b.onclick=()=>bridge.openTask(t.id).catch(fail);$('#messages').append(b);}
   $('#question').replaceChildren();$('#question').hidden=!t.question;
   if(t.question){$('#question').append(node('p',t.question.text));if(!t.needsFullApp&&!t.needsBrowser)for(const choice of t.question.choices){const b=node('button',choice);b.onclick=()=>sendReply(choice);$('#question').append(b);}else{const b=node('button',t.needsBrowser?'Open browser to continue ↗':'Review in Seek ↗');b.onclick=()=>bridge.openTask(t.id,t.needsBrowser).catch(fail);$('#question').append(b);}}
   if(nearBottom)requestAnimationFrame(()=>{$('#scroll').scrollTop=$('#scroll').scrollHeight;});
 }
 $('#continue').hidden=!['paused','stopped','error'].includes(t.status);$('#continue').textContent=t.mode==='desktop'&&!t.remote?'Continue on this computer':'Continue task';
 $('#pause').hidden=!['running','queued'].includes(t.status);$('#browser').hidden=t.mode!=='browser'&&!t.needsBrowser;
 $('#input').disabled=!!(t.needsFullApp||t.needsBrowser);if(t.needsFullApp||t.needsBrowser)$('#send').disabled=true;
}
async function sendReply(text){await run(async()=>{const t=task();if(!t)return;remember(await bridge.replyTask({id:t.id,text}));$('#input').value='';});}
$('#composer').onsubmit=e=>{e.preventDefault();if(!$('#input').value.trim())return;const t=task();if(t){void sendReply($('#input').value);return;}void run(async()=>{const computerId=$('#computer').value;if(mode==='desktop'&&!computerId&&!(local.capabilities?.input&&local.capabilities?.structuredObservation&&local.shortcutReady)){await bridge.openSettings();return;}const t=await bridge.submitTask({mode,text:$('#input').value,...(mode==='desktop'&&computerId?{computerId}:{})});remember(t);$('#input').value='';if(t.mode==='browser')await bridge.openTask(t.id,true);});};
$('#input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#composer').requestSubmit();}};
for(const b of document.querySelectorAll('.modes button'))b.onclick=()=>choose(b.dataset.mode);
for(const b of document.querySelectorAll('.examples button'))b.onclick=()=>{choose(b.dataset.mode);$('#input').value=b.dataset.text;$('#input').focus();};
$('#new').onclick=()=>{activeId='';void bridge.selectTask('').catch(fail);lastContent='';$('#input').disabled=false;$('#input').value='';$('#error').hidden=true;$('#recent').value='';render();$('#input').focus();};
$('#recent').onchange=e=>{activeId=e.target.value;lastContent='';void run(async()=>{const t=await bridge.selectTask(activeId);if(t)remember(t);});$('#scroll').scrollTop=0;};
$('#continue').onclick=()=>run(async()=>remember(await bridge.resumeTask(activeId)));
$('#pause').onclick=()=>run(async()=>remember(await bridge.pauseTask(activeId)));
$('#open').onclick=()=>bridge.openTask(activeId).catch(fail);$('#browser').onclick=()=>bridge.openTask(activeId,true).catch(fail);
$('#settings').onclick=$('#connect').onclick=()=>bridge.openSettings().catch(fail);$('#close').onclick=()=>bridge.hideCompanion();$('#stop').onclick=()=>bridge.stop().catch(fail);
document.onkeydown=e=>{if(e.key==='Escape')bridge.hideCompanion();};
bridge.onCompanion(value=>{data=value;window.SeekBuddy.setLook(data.look);$('#recent').replaceChildren(new Option('Recent conversations',''),...data.tasks.map(t=>new Option(t.title,t.id)));$('#recent').value=activeId;render();});
bridge.onCompanion(value=>{const selected=$('#computer').value;$('#computer').replaceChildren(new Option('This computer',''),...(value.computers||[]).map(m=>{const o=new Option(m.name+(m.online?'':' · offline'),m.id);o.disabled=!m.online||m.busy;return o;}));$('#computer').value=selected;render();});
$('#computer').onchange=render;
bridge.onState(s=>{local=s;window.SeekBuddy.hold(s.state==='agent'?'think':'idle',2000);render();});bridge.onLink(s=>{link=s;render();});bridge.onCompanionFocus(()=>$('#input').focus());
Promise.all([bridge.status(),bridge.linkStatus(),bridge.companionData()]).then(([s,l,d])=>{local=s;link=l;data=d;render();}).catch(fail);
