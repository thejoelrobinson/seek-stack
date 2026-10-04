// Shared browser behavior. Reads may be retried; writes require an application ID.
export async function request(path,body,{timeoutMs=15000,signal,retries=body?0:1,fetchImpl=globalThis.fetch}={}) {
  for(let attempt=0;;attempt++){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('Request timed out.')),timeoutMs);
    const abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{
      const res=await fetchImpl(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
      if(res.status===401){const error=new Error('Your sign-in expired. Sign in again to continue.');error.code='auth';throw error;}
      if(!res.headers.get('content-type')?.includes('application/json')){const error=new Error('Seek returned an unexpected response. Reload the app or sign in again.');error.code='protocol';throw error;}
      let data;try{data=await res.json();}catch(error){if(!controller.signal.aborted)error.code='protocol';throw error;}if(!res.ok){const error=new Error(data.error||`Request failed (${res.status}).`);error.code=data.code||'http';throw error;}return data;
    }catch(cause){
      const error=cause instanceof Error?cause:new Error(String(cause));
      if(controller.signal.aborted){error.code=signal?.aborted?'cancelled':'timeout';if(!signal?.aborted)error.message='Seek took too long to respond. Your draft is still here.';}
      else error.code??='offline';
      if(attempt>=retries||signal?.aborted||!['offline','timeout'].includes(error.code))throw error;
      await new Promise(resolve=>setTimeout(resolve,250*2**attempt+Math.random()*100));
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
}
const controlKey=(el,index)=>el.id?'id:'+el.id:el.name?'name:'+el.name:el.hasAttribute('data-fin-query')?'finance-query':el.hasAttribute('data-fin-filter')?'finance-filter':'index:'+index;
export function preserveHTML(root,html) {
  const controls=[...root.querySelectorAll('input,textarea,select')],active=document.activeElement,tabId=root.contains(active)&&active?.getAttribute('role')==='tab'?active.id:null;
  const values=new Map(root.__seekFormState||[]);for(const [index,el]of controls.entries())if(!['password','file'].includes(el.type))values.set(controlKey(el,index),{value:el.value,checked:el.checked,start:el.selectionStart,end:el.selectionEnd,focused:el===active});root.__seekFormState=values;
  const scroll=root.scrollTop,details=new Map([...root.querySelectorAll('details')].map(el=>[el.querySelector('summary')?.textContent,el.open]));
  root.innerHTML=html;
  [...root.querySelectorAll('input,textarea,select')].forEach((el,index)=>{const old=values.get(controlKey(el,index));if(!old)return;el.value=old.value;if('checked'in el)el.checked=old.checked;if(old.focused){el.focus({preventScroll:true});if(old.start!==null&&typeof el.setSelectionRange==='function')try{el.setSelectionRange(old.start,old.end);}catch{}}});
  for(const el of root.querySelectorAll('details')){const open=details.get(el.querySelector('summary')?.textContent);if(open!==undefined)el.open=open;}
  root.scrollTop=scroll;decorateTabs(root);if(tabId)document.getElementById(tabId)?.focus({preventScroll:true});
}
export function decorateTabs(root=document) {
  for(const group of root.querySelectorAll('[role="tablist"]')){
    const buttons=[...group.querySelectorAll('button')],prefix=group.dataset.tabs||'agent';
    const panel=document.getElementById(prefix==='finance'?'finance-panel':'ap-body');
    for(const [index,button]of buttons.entries()){
      const selected=button.classList.contains('active')||button.classList.contains('selected');button.setAttribute('role','tab');button.id=`${prefix}-tab-${index}`;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
      if(panel){button.setAttribute('aria-controls',panel.id);panel.setAttribute('role','tabpanel');panel.tabIndex=0;if(selected)panel.setAttribute('aria-labelledby',button.id);}
    }
  }
}
export function tabKey(event) {
  const button=event.target.closest('[role="tab"]'),group=button?.closest('[role="tablist"]');if(!group||!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;
  const tabs=[...group.querySelectorAll('[role="tab"]')],index=tabs.indexOf(button),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  event.preventDefault();const nextId=tabs[next].id;tabs[next].focus();tabs[next].click();document.getElementById(nextId)?.focus({preventScroll:true});
}
if(typeof document!=='undefined'){
  document.addEventListener('keydown',tabKey);
  const remember=event=>{const root=event.target.closest?.('#main'),el=event.target;if(!root||!el.matches('input,textarea,select')||['password','file'].includes(el.type))return;root.__seekFormState??=new Map();const index=[...root.querySelectorAll('input,textarea,select')].indexOf(el);root.__seekFormState.set(controlKey(el,index),{value:el.value,checked:el.checked,start:el.selectionStart,end:el.selectionEnd,focused:false});};
  document.addEventListener('input',remember);document.addEventListener('change',remember);
}
