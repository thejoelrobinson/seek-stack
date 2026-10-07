// Append-only security activity log shared with the auth proxy (same JSONL file).
// Records what happened and through which channel, never secrets, usernames that
// failed to sign in, passwords, tokens or message text.
import {appendFile,readFile,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';

export const SECURITY_FILE='security-events.jsonl';
const MAX_BYTES=1024*1024;
const SAFE=/^[\w.:/@ -]{0,200}$/;
const FIELDS=new Set(['host','site','decision','scope','kind','where','count','attempts','current','identity','amount','last4','brand']);

const LABELS={
 'login.success':'Signed in','login.failed':'Sign-in failed','login.rate_limited':'Sign-in blocked after repeated failures','login.csrf_rejected':'Expired sign-in page rejected','logout':'Signed out',
 'session.revoked':'Device signed out','session.revoked_others':'Other devices signed out','partner.saved':'Partner login changed','partner.removed':'Partner access removed',
 'approval.decided':'Action decision','always_allow.revoked':'Always-allow permission removed','secret.blocked':'Password kept out of chat','secret.sent_anyway':'Password-like text sent after warning',
 'vault.login_saved':'Login saved to vault','vault.unlocked':'Vault unlocked','vault.locked':'Vault locked','site.signed_out':'Signed out of a site',
 'export.downloaded':'Workspace export downloaded','backup.recovery_key_exported':'Backup recovery key exported','apps.configured':'Connected-app credentials changed','apps.disconnected':'Connected account removed',
 'finance.configured':'Finance credentials changed','finance.disconnected':'Finance connection removed','card.filled':'Saved card entered at checkout','push.subscribed':'Notifications turned on for a device','push.unsubscribed':'Notifications turned off for a device',
 'caldav.failed':'Calendar sign-in failed','caldav.rate_limited':'Calendar sign-in blocked after repeated failures',
 'desktop.paired':'Computer paired','desktop.pair_failed':'Computer pairing code rejected','desktop.pair_rate_limited':'Computer pairing blocked after repeated failures','desktop.link_refused':'Computer connection refused'
};
export const securityLabel=type=>LABELS[type]||type;

function clean(detail){
 const out={};
 for(const [key,value] of Object.entries(detail||{})){
  if(value==null||!FIELDS.has(key))continue;
  if(typeof value==='number'||typeof value==='boolean')out[key]=value;
  else{const text=String(value).slice(0,200);if(SAFE.test(text))out[key]=text;}
 }
 return out;
}

export class SecurityLog {
 constructor(root){this.file=join(root,SECURITY_FILE);this.writing=Promise.resolve();}
 record(type,detail={},{local}={}){
  if(!LABELS[type])throw new Error('Unknown security event '+type);
  const line=JSON.stringify({at:Date.now(),source:'work',type,channel:local===undefined?undefined:local?'this PC':'remote',...clean(detail)})+'\n';
  // Serialized so rotation never interleaves with an append from this process.
  this.writing=this.writing.then(async()=>{try{if((await stat(this.file)).size>MAX_BYTES)await rename(this.file,this.file+'.1');}catch{}await appendFile(this.file,line,{mode:0o600});}).catch(()=>{});
  return this.writing;
 }
 async read(limit=100){
  limit=Math.min(500,Math.max(1,Number(limit)||100));
  const lines=[];for(const name of [this.file+'.1',this.file]){try{lines.push(...(await readFile(name,'utf8')).split('\n'));}catch{}}
  const events=[];for(const line of lines){if(!line.trim())continue;try{const e=JSON.parse(line);if(Number.isFinite(e.at)&&typeof e.type==='string')events.push({...e,label:securityLabel(e.type)});}catch{}}
  // Newest first; events in the same millisecond keep file order (later lines are newer).
  events.reverse().sort((a,b)=>b.at-a.at);
  const since=Date.now()-86400000;
  return {events:events.slice(0,limit),failedSignIns24h:events.filter(e=>e.at>=since&&['login.failed','login.rate_limited'].includes(e.type)).length};
 }
}
