import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const canonical=value=>value===undefined?null:Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>!['__proto__','constructor','prototype'].includes(k)).map(k=>[k,canonical(value[k])])):value;
export const actionFingerprint=intent=>{const payload={...intent.payload};if(intent.kind?.startsWith('browser.')&&intent.kind!=='browser.unknown')delete payload.key;return createHash('sha256').update(JSON.stringify(canonical({kind:intent.kind,host:intent.host||'',url:intent.url||'',account:intent.account||'',target:intent.target||'',payload}))).digest('hex');};
const emails=text=>[...new Set(String(text||'').toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g)||[])];
const plainRequest=text=>String(text||'').split(/\r?\n/).filter(line=>!/^\s*(>|```)/.test(line)).join(' ').trim();
function authorizedRecipients(request,context){const allowed=emails(request),contacts=new Map();for(const contact of context.verifiedContacts||[]){if(contact?.verified!==true||typeof contact.name!=='string'||contact.name.trim().length<2)continue;const name=contact.name.trim().toLowerCase(),values=contacts.get(name)||new Set();for(const address of emails(contact.email))values.add(address);contacts.set(name,values);}for(const [name,values] of contacts){if(values.size!==1)continue;const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');if(new RegExp('\\b(?:to|cc|bcc|copy|email|mail|reply(?:\\s+to)?)\\s+'+escaped+'(?:$|[^a-z0-9])','i').test(request))allowed.push(...values);}return allowed;}
const REQUESTS={
  'email.send':/\b(?:send|email|reply|respond)\b/i,
  'calendar.create':/\b(?:create|add|schedule|book|put)\b.{0,100}\b(?:event|meeting|appointment|calendar)\b/i,
  'document.create':/\b(?:create|write|make|save|add)\b.{0,100}\b(?:document|doc|note|page|report)\b/i,
  'browser.purchase':/\b(?:buy|purchase|order|book|reserve)\b/i,
  'browser.send':/\b(?:send|email|reply|respond|post|publish)\b/i,
  'browser.delete':/\b(?:delete|remove|cancel)\b/i,
  'browser.payment':/\b(?:pay|transfer|donate)\b/i,
  'browser.subscribe':/\bsubscribe\b/i,
  'browser.unknown':/\b(?:click|press|submit)\b/i,
};
const NEGATIVE_VERBS={'email.send':'send|email|reply|respond','calendar.create':'create|add|schedule|book','document.create':'create|write|make|save','browser.purchase':'buy|purchase|order|book|reserve','browser.send':'send|email|reply|post|publish','browser.delete':'delete|remove|cancel','browser.payment':'pay|transfer|donate','browser.subscribe':'subscribe','browser.unknown':'click|press|submit'};
const requestEntries=context=>context.requests?.length?context.requests.map(x=>({...x,text:plainRequest(x.text)})):[{text:plainRequest(context.request||context.objective),id:context.requestId}];
function directiveFor(intent,context){const verb=REQUESTS[intent.kind];if(!verb)return null;const negative=new RegExp("\\b(?:do not|don't|never)\\s+(?:"+NEGATIVE_VERBS[intent.kind]+")\\b"+(/send$/.test(intent.kind)?'|\\b(?:only draft|draft only|without sending)\\b':''),'i');const directive=requestEntries(context).filter(x=>verb.test(x.text)||negative.test(x.text)).at(-1);return directive?{...directive,allowed:verb.test(directive.text)&&!negative.test(directive.text)}:null;}
const regexEscape=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function exactHumanField(field,request){
  const value=String(field.value??'');if(!value.trim())return true;
  if(['checkbox','radio'].includes(field.type))return false;
  const names=[...new Set([field.label,field.name].filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))];
  const content='(?:"([^"]*)"|\'([^\']*)\'|(.+?))',end='(?=[.,;]|$|\\s+(?:and|then|before|after|click|press|submit)\\b)';
  for(const name of names){const fieldName='["\'`]?'+regexEscape(name)+'["\'`]?(?:\\s+(?:field|input))?';
    const patterns=[new RegExp('\\b(?:enter|type|put)\\s+(?:exactly\\s+)?'+content+'\\s+in(?:to)?\\s+(?:the\\s+)?'+fieldName+end,'ig'),new RegExp('\\b(?:fill|set)\\s+(?:the\\s+)?'+fieldName+'\\s+(?:to|with|as)\\s+(?:exactly\\s+)?'+content+end,'ig'),new RegExp(fieldName+'\\s*[:=]\\s*'+content+end,'ig')];
    for(const pattern of patterns)for(const match of request.matchAll(pattern)){const specified=match[1]??match[2]??match[3]?.trim();if(specified===value)return true;}
  }
  return false;
}

// Only authoritative task requests are considered here. Page/app text is never authority.
// A broad autonomy preference alone does not authorize spending, sending, or deleting.
// Autonomous mode (the default): the task request is the authorization. Ordinary form controls
// just work; purchases, payments, messages, events and documents proceed when the request asks for
// that kind of action and does not forbid it. Still held: deletions, spending over the limit,
// unidentified controls inside checkout frames. Returns null to fall back to the careful rules.
export const DEFAULT_AUTONOMY=Object.freeze({mode:'autonomous',spendLimit:250});
export function autonomousAuthorization(intent,directive,autonomy){
  if(autonomy?.mode!=='autonomous')return null;
  if(intent.kind==='browser.delete')return null;
  if(intent.kind==='browser.unknown')return !(intent.unresolved&&intent.payload?.checkout);
  if(!directive?.allowed)return false;
  if(intent.kind==='browser.purchase'||intent.kind==='browser.payment'){const amount=Number(intent.payload?.amount),limit=Number(autonomy.spendLimit);return !(Number.isFinite(amount)&&Number.isFinite(limit)&&amount>limit);}
  return true;
}
export function explicitAuthorization(intent,context={}){
  const requests=requestEntries(context).map(x=>x.text),request=requests.join(' '),directive=directiveFor(intent,context);
  const autonomous=autonomousAuthorization(intent,directive,context.autonomy);if(autonomous!==null)return autonomous;
  if(!directive?.allowed)return false;
  if(intent.kind==='browser.unknown'){
    if(intent.unresolved||intent.payload?.checkout||Number.isFinite(intent.payload?.amount)||emails(JSON.stringify(intent.payload?.fields||[])).length)return false;
    const label=String(intent.payload?.label||intent.label||'').trim();if(!label||label.length>100)return false;
    const quoted=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');if(!new RegExp('\\b(?:click|press|submit)(?:\\s+(?:the|button))*\\s+'+quoted+'(?:$|[^a-z0-9])','i').test(directive.text.replace(/["'“”`]/g,'')))return false;
    const urls=directive.text.match(/https?:\/\/[^\s<>"')]+/g)||[];if(!urls.some(url=>{try{return new URL(url.replace(/[.,;!?]+$/g,'')).host===intent.host;}catch{return false;}}))return false;
    if(intent.payload?.formAction){try{const action=new URL(intent.payload.formAction,intent.url||'https://'+intent.host);if(!['http:','https:'].includes(action.protocol)||action.host!==intent.host)return false;}catch{return false;}}
    return (intent.payload?.fields||[]).every(f=>exactHumanField(f,directive.text));
  }
  const recipientRequest=[...requests].reverse().find(text=>authorizedRecipients(text,context).length)||request;
  if(['email.send','browser.send'].includes(intent.kind)){
    const recipients=emails(JSON.stringify([intent.payload?.to||intent.payload?.recipients||intent.target,intent.payload?.cc||[],intent.payload?.bcc||[]]));
    if(!recipients.length)return false;
    const allowed=authorizedRecipients(recipientRequest,context);return recipients.every(x=>allowed.includes(x));
  }
  if(intent.kind==='browser.purchase'||intent.kind==='browser.payment'){
    const budgetPattern=/\b(?:up to|under|less than|maximum|max|budget|at most)\s*([$€£])?\s*(\d+(?:\.\d{1,2})?)/i,budget=[...requests].reverse().map(text=>budgetPattern.exec(text)).find(Boolean),amount=Number(intent.payload?.amount);
    return !!budget&&(!intent.payload?.currency||intent.payload.currency===(budget[1]||'$'))&&Number.isFinite(amount)&&amount>=0&&amount<=Number(budget[2])&&!!intent.target&&request.toLowerCase().includes(String(intent.target).toLowerCase());
  }
  if(intent.kind==='calendar.create'){
    const attendees=emails(JSON.stringify(intent.payload?.attendees||[]));
    return attendees.every(x=>authorizedRecipients(recipientRequest,context).includes(x))&&!!intent.payload?.start&&!!intent.payload?.end;
  }
  if(intent.kind==='document.create')return true;
  return !!intent.target&&String(intent.target).length>2&&request.toLowerCase().includes(String(intent.target).toLowerCase());
}

export class WorkAuthority {
  constructor(root,{now=()=>Date.now()}={}){this.root=root;this.now=now;this.db=null;this.running=new Map();}
  async init(){
    await mkdir(this.root,{recursive:true});this.db=new DatabaseSync(join(this.root,'authority.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS authority_actions(id TEXT PRIMARY KEY, scope TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, intent TEXT NOT NULL, state TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, receipt TEXT, UNIQUE(scope,fingerprint));
      CREATE TABLE IF NOT EXISTS authority_grants(id TEXT PRIMARY KEY, scope TEXT NOT NULL, fingerprint TEXT NOT NULL, expires_at INTEGER, used_at INTEGER);
      CREATE INDEX IF NOT EXISTS authority_scope ON authority_actions(scope,created_at);`);
    this.db.prepare("UPDATE authority_actions SET state='uncertain',updated_at=? WHERE state='executing'").run(this.now());return this;
  }
  close(){this.db?.close();this.db=null;}
  async drain(){await Promise.allSettled([...this.running.values()]);}
  scope(context){if(!context.taskId&&!context.sessionId)throw new Error('An action needs a task or session owner.');return String(context.taskId||context.sessionId)+':'+String(context.requestId||context.requestAt||'initial');}
  row(id){return this.db.prepare('SELECT * FROM authority_actions WHERE id=?').get(id);}
  list({taskId,requestId,createdAfter,limit=50}={}){const conditions=[],args=[];if(taskId){if(requestId){conditions.push('scope=?');args.push(String(taskId)+':'+String(requestId));}else{conditions.push('substr(scope,1,?)=?');args.push(String(taskId).length+1,String(taskId)+':');}}if(Number.isFinite(createdAfter)){conditions.push('created_at>=?');args.push(createdAfter);}args.push(Math.min(100,Math.max(1,limit)));const rows=this.db.prepare('SELECT * FROM authority_actions'+(conditions.length?' WHERE '+conditions.join(' AND '):'')+' ORDER BY created_at DESC LIMIT ?').all(...args);return rows.map(row=>({id:row.id,scope:row.scope,kind:row.kind,state:row.state,source:row.source,createdAt:row.created_at,updatedAt:row.updated_at,receipt:row.receipt?JSON.parse(row.receipt):null}));}
  async propose(intent,context={}){
    if(!intent||typeof intent.kind!=='string'||JSON.stringify(intent).length>40000)throw new Error('Invalid or oversized action.');
    const directive=directiveFor(intent,context),scope=this.scope({...context,requestId:directive?.id||context.requestId}),fingerprint=actionFingerprint(intent),prior=this.db.prepare('SELECT * FROM authority_actions WHERE scope=? AND fingerprint=?').get(scope,fingerprint);
    if(prior)return {...prior,intent:JSON.parse(prior.intent),duplicate:['executing','uncertain','observed','verified'].includes(prior.state)};
    const id=randomUUID(),now=this.now();this.db.prepare('INSERT INTO authority_actions(id,scope,fingerprint,kind,intent,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,scope,fingerprint,intent.kind,JSON.stringify(canonical(intent)),'proposed',now,now);
    return {...this.row(id),intent};
  }
  async grant(id,{scope='once',expiresAt}={}){
    const row=this.row(id);if(!row)throw new Error('Action proposal no longer exists.');
    // Broad UI scope can reuse an exact payload; it never means arbitrary changed payloads.
    const grantScope=scope==='always'?'*':row.scope;
    this.db.prepare('INSERT INTO authority_grants(id,scope,fingerprint,expires_at) VALUES(?,?,?,?)').run(randomUUID(),grantScope,row.fingerprint,expiresAt??this.now()+24*3600000);
    this.db.prepare("UPDATE authority_actions SET state='authorized',source='user-grant',updated_at=? WHERE id=? AND state IN ('proposed','held','authorized')").run(this.now(),id);
    return {authorized:true,id,fingerprint:row.fingerprint};
  }
  async reject(id){this.db.prepare("UPDATE authority_actions SET state='rejected',updated_at=? WHERE id=?").run(this.now(),id);}
  async revokeGrants({fingerprint}={}){if(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))throw new Error('Choose an exact action grant to revoke.');const changes=this.db.prepare('DELETE FROM authority_grants WHERE fingerprint=?').run(fingerprint).changes;this.db.prepare("UPDATE authority_actions SET state='held',source=NULL,updated_at=? WHERE fingerprint=? AND source='user-grant' AND state='authorized'").run(this.now(),fingerprint);return {revoked:changes};}
  async authorize(intent,context={}){
    const proposal=await this.propose(intent,context);
    if(proposal.duplicate)return {allowed:false,duplicate:true,proposal,needsVerification:proposal.state!=='verified'};
    if(proposal.state==='rejected')return {allowed:false,rejected:true,proposal};
    const grant=this.db.prepare('SELECT * FROM authority_grants WHERE (scope=? OR scope=?) AND fingerprint=? AND used_at IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1').get(proposal.scope,'*',proposal.fingerprint,this.now());
    const reviewedOther=this.db.prepare("SELECT id FROM authority_actions WHERE scope=? AND kind=? AND fingerprint<>? AND source='user-grant' AND state IN ('authorized','executing','observed','uncertain') LIMIT 1").get(proposal.scope,intent.kind,proposal.fingerprint);
    // Careful mode: once the user reviewed one action of a kind, a different one needs review too.
    // Autonomous mode trusts the request, so a prior approval does not make later steps ask again.
    const explicit=(!reviewedOther||context.autonomy?.mode==='autonomous')&&explicitAuthorization(intent,context),allowed=!!grant||explicit||proposal.state==='authorized';
    if(allowed){const changed=this.db.prepare("UPDATE authority_actions SET state='authorized',source=?,updated_at=? WHERE id=? AND state IN ('proposed','held','authorized')").run(grant?'user-grant':proposal.source||'task-request',this.now(),proposal.id);if(changed.changes!==1){const row=this.row(proposal.id);return {allowed:false,duplicate:true,needsVerification:row.state!=='verified',proposal:{...row,intent}};}if(grant&&grant.scope!=='*')this.db.prepare('UPDATE authority_grants SET used_at=? WHERE id=?').run(this.now(),grant.id);}
    else this.db.prepare("UPDATE authority_actions SET state='held',updated_at=? WHERE id=?").run(this.now(),proposal.id);
    return {allowed,source:grant?'user-grant':explicit?'task-request':proposal.source,proposal,...(reviewedOther&&!allowed?{stale:true}: {})};
  }
  async execute(intent,context,perform,{verify}={}){
    const decision=await this.authorize(intent,context);if(!decision.allowed)return decision;
    const id=decision.proposal.id;if(this.running.has(id))return this.running.get(id);
    const promise=(async()=>{
      const claim=this.db.prepare("UPDATE authority_actions SET state='executing',updated_at=? WHERE id=? AND state='authorized'").run(this.now(),id);
      if(claim.changes!==1)return {allowed:false,duplicate:true,needsVerification:true,proposal:{...this.row(id),intent}};
      try{
        const result=await perform({id,idempotencyKey:id,fingerprint:decision.proposal.fingerprint});
        const evidence=verify?await verify(result):{verified:false,detail:'Action returned; outcome needs verification.'};
        const receipt={...evidence,observedAt:this.now()};
        this.db.prepare('UPDATE authority_actions SET state=?,receipt=?,updated_at=? WHERE id=?').run(evidence.verified?'verified':'observed',JSON.stringify(receipt),this.now(),id);
        return {allowed:true,id,state:evidence.verified?'verified':'observed',receipt,result};
      }catch(error){this.db.prepare("UPDATE authority_actions SET state='uncertain',receipt=?,updated_at=? WHERE id=?").run(JSON.stringify({verified:false,detail:'Action did not return a verified outcome.'}),this.now(),id);throw error;}
    })().finally(()=>this.running.delete(id));this.running.set(id,promise);return promise;
  }
  async confirm(id,evidence){const row=this.row(id);if(!row||!['uncertain','observed'].includes(row.state))throw new Error('This action does not need verification.');if(!evidence?.verified||!evidence.providerId&&!evidence.sourceUrl)throw new Error('A provider receipt ID or observed source URL is required.');this.db.prepare("UPDATE authority_actions SET state='verified',receipt=?,updated_at=? WHERE id=?").run(JSON.stringify({...evidence,observedAt:this.now()}),this.now(),id);return {id,state:'verified'};}
}
