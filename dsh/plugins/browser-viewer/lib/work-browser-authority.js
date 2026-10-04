import {actionFingerprint} from './work-authority.js';

// Resolve the actual control for mouse and keyboard before authorization. Page
// content describes a proposed action; it never supplies authorization.
export function browserActionScript(args={},key=''){
  return '('+function(args,key){
    const text=el=>String(el?.getAttribute?.('aria-label')||el?.innerText||el?.value||el?.title||el?.getAttribute?.('alt')||'').trim().replace(/\s+/g,' ').slice(0,1200);
    let el=args.ref?globalThis.__dshViewerRefs?.get(args.ref):Number.isFinite(args.x)&&Number.isFinite(args.y)?document.elementFromPoint(args.x,args.y):document.activeElement;
    if(args.ref&&(!el||!el.isConnected))throw new Error('Stale element reference. Take a fresh viewer_snapshot.');
    while(el?.shadowRoot){const inner=key?el.shadowRoot.activeElement:el.shadowRoot.elementFromPoint?.(args.x,args.y);if(!inner||inner===el)break;el=inner;}
    if(!el)return {unresolved:true,label:'Unidentified control',kind:'browser.unknown',host:location.host,url:location.href,title:document.title,payload:{key}};
    if(el.tagName==='IFRAME'||el.tagName==='CANVAS')return {unresolved:true,label:'Control inside '+el.tagName.toLowerCase(),kind:'browser.unknown',host:location.host,url:location.href,title:document.title,payload:{key,src:el.src||'',x:args.x,y:args.y}};
    let form=el.form||el.closest?.('form');
    const chord=/(?:Control|Ctrl|Meta|Command|Alt)\+/i.test(key),enter=/(?:^|\+)Enter$/i.test(key)||/^Alt\+S$/i.test(key),space=/^(?:Space| )$/i.test(key);
    const checkout=/checkout|payment|billing|place.?order|\/cart\b|\/buy\b/i.test(location.href+' '+document.title);
    const editable=['INPUT','TEXTAREA'].includes(el.tagName)||el.isContentEditable;
    if(key&&(!enter&&!space||editable&&el.tagName==='TEXTAREA'&&!chord||el.isContentEditable&&!chord))return {safe:true,label:'Keyboard editing',url:location.href};
    if(key&&enter&&editable&&form)el=form.querySelector('button[type="submit"],input[type="submit"],button:not([type])')||el;
    else if(key&&enter&&(chord||editable))el=Array.from((form||el.closest?.('[role="dialog"]')||document).querySelectorAll('button,[role="button"],input[type="submit"]')).find(x=>/\b(?:send|post|publish|submit|confirm|pay|order|complete|search)\b/i.test(text(x)))||el;
    else if(!key)el=el.closest?.('button,a,[role="button"],input[type="submit"],input[type="image"]')||el;
    form=el.form||el.closest?.('form')||form;
    const label=text(el)||String(el.getAttribute?.('aria-labelledby')||'').split(/\s+/).map(id=>text(document.getElementById(id))).join(' ').trim();
    const role=el.getAttribute?.('role')||'',buttonLike=['BUTTON','A'].includes(el.tagName)||role==='button'||['submit','button','image'].includes(el.type)||!!(key&&enter&&(form||chord||checkout));
    if(!buttonLike)return {safe:true,label:label||'Page control',url:location.href};
    const password=Array.from((form||document).querySelectorAll('input[type="password"]')).some(x=>x.getBoundingClientRect().width&&!x.value);
    const signIn=/\b(?:sign ?in|log ?in|continue|next|submit)\b/i.test(label)&&password;
    if(signIn)return {login:true,label,url:location.href};
    const controls=Array.from((form||el.closest('[role="dialog"]')||document).querySelectorAll('input,textarea,select,[contenteditable="true"]')).filter(x=>x.type!=='hidden'&&x.type!=='password'&&!/password|passphrase|secret|token|csrf|api.?key|card.?number|cvv|one.?time|otp/i.test((x.name||'')+' '+(x.id||'')+' '+(x.autocomplete||''))).filter(x=>x.getBoundingClientRect().width);
    if(controls.length>60)throw new Error('This form has too many fields to bind safely. Use viewer_handoff for its submission.');
    const fields=controls.map(x=>({name:x.name||x.id||x.getAttribute('aria-label')||x.type||'text',label:String(x.getAttribute('aria-label')||x.labels?.[0]?.innerText||'').trim(),type:x.type||x.tagName.toLowerCase(),...(['checkbox','radio'].includes(x.type)?{checked:x.checked}:{}),value:String(x.value??x.innerText??'')}));
    const fieldText=fields.map(x=>x.name+': '+x.value).join('\n'),near=text(form||el.closest('[role="dialog"]'));
    const harmless=/^(?:apply (?:coupon|promo(?:tion)? code)|show (?:items|details)|view (?:details|history)|(?:send|resend)(?: me)? (?:a |the )?(?:code|verification code|sign.?in link)|sign ?in|log ?in|search|filter|sort|next page|previous page|back|continue shopping|close|cancel|help|learn more)(?:\b|$)/i.test(label);
    let kind=/\b(?:delete|remove permanently|erase|destroy)\b/i.test(label)?'browser.delete':/\b(?:transfer|pay|donate)\b/i.test(label)?'browser.payment':/\b(?:buy|purchase|place (?:your |my )?order|complete.*(?:order|purchase|booking)|book now|reserve now|confirm.*(?:order|purchase|booking))\b/i.test(label)?'browser.purchase':/\b(?:send|post|publish|reply)\b/i.test(label)?'browser.send':/\bsubscribe\b/i.test(label)?'browser.subscribe':checkout&&/\b(?:submit|confirm|pay|order|complete)\b/i.test(label)?'browser.purchase':'';
    if(!kind&&harmless)return {safe:true,label,url:location.href};
    if(!kind&&el.tagName==='A'&&el.href&&/^https?:/i.test(el.href)&&!el.getAttribute('onclick'))return {safe:true,label,url:location.href};
    if(!kind&&label&&/^(?:continue|next|add to cart|save draft|edit|open|expand|collapse|select|choose|show|view|download|copy|reuse|preview)\b/i.test(label))return {safe:true,label,url:location.href};
    if(!kind&&checkout)kind='browser.unknown';
    if(!kind&&fields.some(x=>/recipient|\bto\b|email/i.test(x.name))&&fields.some(x=>/body|message|subject/i.test(x.name)))kind='browser.send';
    if(!kind&&label&&!form&&!key)return {safe:true,label,url:location.href};
    kind||='browser.unknown';
    const recipient=fields.filter(x=>/recipient|\bto\b|email/i.test(x.name)&&!/(?:\bcc\b|\bbcc\b)/i.test(x.name)).map(x=>x.value).join(', '),cc=fields.filter(x=>/\bcc\b/i.test(x.name)).map(x=>x.value).join(', '),bcc=fields.filter(x=>/\bbcc\b/i.test(x.name)).map(x=>x.value).join(', ');
    const amountMatch=/(?:total|amount|pay)\s*(?:due|:)?\s*([$€£])\s*([\d,]+(?:\.\d{1,2})?)/i.exec(near||document.body?.innerText||'');
    const amount=amountMatch?Number(amountMatch[2].replaceAll(',','')):undefined,currency=amountMatch?.[1];
    const target=kind==='browser.send'?recipient:fields.find(x=>/product|item|recipient|target/i.test(x.name))?.value||text(document.querySelector('main h1,h1'))||label;
    return {kind,label:label||'Submit current form',host:location.host,url:location.href,title:document.title,target,payload:{label,checkout,formAction:form?.action||'',method:form?.method||'',fields,recipients:recipient,cc,bcc,amount,currency,key:key||undefined,target:{tag:el.tagName,id:el.id||'',name:el.name||'',href:el.href||''}}};
  }.toString()+')('+JSON.stringify(args)+','+JSON.stringify(key)+')';
}

export async function authorizeBrowserAction(c,args,session,key=''){
  const tab=await c._activeTab(),intent=await c.cdp.evaluate(tab,browserActionScript(args,key));
  if(intent.safe)return {allowed:true,intent};
  if(intent.login)return {login:true,intent};
  let trustedContext;try{trustedContext=await c.authorizationForSession?.(session);}catch{}
  const context={sessionId:session,...trustedContext},fingerprint=actionFingerprint(intent);
  if(c.authority){
    let decision=await c.authority.authorize(intent,context);
    if(!decision.allowed&&!decision.duplicate&&!decision.rejected&&!decision.stale&&c.consumeGrant?.(session,intent.host,intent.label,fingerprint)){await c.authority.grant(decision.proposal.id);decision=await c.authority.authorize(intent,context);}
    if(decision.duplicate)return {halt:true,duplicate:true,needsVerification:decision.needsVerification,proposalId:decision.proposal.id,instruction:'This exact action was already attempted. Verify its result before attempting it again.'};
    if(decision.allowed)return {allowed:true,intent,context,proposalId:decision.proposal.id,fingerprint};
    await c.requestApproval({sessionId:session,action:key?'key':'click',label:intent.label,host:intent.host,url:intent.url,title:intent.title,intent,fingerprint,proposalId:decision.proposal.id,reason:decision.stale?'The reviewed action changed.':'This action needs authority.'});
  }else{
    if(c.consumeGrant(session,intent.host,intent.label,fingerprint))return {allowed:true,intent,fingerprint};
    await c.requestApproval({sessionId:session,action:key?'key':'click',label:intent.label,host:intent.host,url:intent.url,title:intent.title,intent,fingerprint});
  }
  return {halt:true,approvalRequired:true,instruction:`Held for authority: ${intent.label} on ${intent.host}. Existing task authorization and exact-action grants are reused. End this turn and wait for the user's decision.`};
}

export async function executeBrowserAction(c,decision,args,session,perform,key=''){
  if(!decision.allowed)return decision;
  if(decision.intent.safe)return perform();
  const current=await c.cdp.evaluate(await c._activeTab(),browserActionScript(args,key));
  if(actionFingerprint(current)!==decision.fingerprint)throw new Error('The action changed before execution. Take a fresh snapshot and review the changed action.');
  if(!c.authority)return perform();
  const result=await c.authority.execute(current,decision.context,perform,{verify:async()=>({verified:false,sourceUrl:current.url,detail:'Browser input dispatched. Inspect the resulting page to verify the external outcome.'})});
  return result.allowed?{...result.result,actionReceipt:{id:result.id,state:result.state}}:result;
}
