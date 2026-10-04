// Typed, allowlisted Pipedream actions. OAuth stays in the host adapter; callers
// cannot provide bearer tokens, endpoints, arbitrary tools, or extra parameters.
const email=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const string=(value,name,max=20000,optional=false)=>{if(optional&&value===undefined)return undefined;if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`Enter a valid ${name}.`);return value.trim();};
const addresses=(value,name='recipients')=>{if(value===undefined)return [];if(!Array.isArray(value)||value.length>20||value.some(x=>typeof x!=='string'||!email.test(x)))throw new Error('Use up to 20 valid '+name+'.');return [...new Set(value.map(x=>x.toLowerCase()))];};
const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)||/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
export const TYPED_ACTIONS={
  'email.send':{app:'gmail',write:'gmail-send-email',read:'gmail-get-thread',host:'mail.google.com'},
  'calendar.create':{app:'google_calendar',write:'google_calendar-create-event',read:'google_calendar-get-event',host:'calendar.google.com'},
  'document.create':{app:'google_docs',write:'google_docs-create-document',read:'google_docs-get-document',host:'docs.google.com'},
};
export function typedAction(kind,input={}){
  const definition=TYPED_ACTIONS[kind];if(!definition)throw new Error('This write action is not supported. Use email.send, calendar.create or document.create.');
  const accountId=input.accountId===undefined?undefined:string(input.accountId,'connected account ID',100),payload={};let args;
  if(kind==='email.send'){
    payload.to=addresses(input.to);if(!payload.to.length)throw new Error('Specify an email recipient.');payload.cc=addresses(input.cc);payload.bcc=addresses(input.bcc);payload.subject=string(input.subject,'subject',500);payload.body=string(input.body,'email body');
    args={to:payload.to,cc:payload.cc,bcc:payload.bcc,subject:payload.subject,body:payload.body,bodyType:'text'};
  }else if(kind==='calendar.create'){
    payload.title=string(input.title,'event title',500);payload.start=string(input.start,'start time',60);payload.end=string(input.end,'end time',60);
    if(!date(payload.start)||!date(payload.end)||!Number.isFinite(Date.parse(payload.start))||!Number.isFinite(Date.parse(payload.end))||Date.parse(payload.end)<=Date.parse(payload.start)||(payload.start.length<=10)!==(payload.end.length<=10))throw new Error('Use a valid start/end date or times with timezone offsets; the end must follow the start.');
    payload.calendarId=string(input.calendarId||'primary','calendar ID',500);payload.attendees=addresses(input.attendees,'attendee emails');payload.description=string(input.description,'description',10000,true);payload.location=string(input.location,'location',1000,true);
    args={calendarId:payload.calendarId,summary:payload.title,eventStartDate:payload.start,eventEndDate:payload.end,attendees:payload.attendees,description:payload.description,location:payload.location,sendUpdates:payload.attendees.length?'all':'none',addSelfAsAttendee:false};
  }else{
    payload.title=string(input.title,'document title',500);payload.content=string(input.content,'document content');payload.folderId=string(input.folderId,'folder ID',500,true);args={title:payload.title,content:payload.content,folderId:payload.folderId};
  }
  return {definition,args:Object.fromEntries(Object.entries(args).filter(([,v])=>v!==undefined)),intent:{kind,host:definition.host,account:accountId||'',target:kind==='email.send'?payload.to.join(', '):payload.title,payload},accountId};
}

export function providerObject(result){
  if(result?.isError)throw new Error('The connected app rejected this action.');
  const candidates=[result?.structuredContent,...(result?.content||[]).filter(x=>x.type==='text').map(x=>{try{return JSON.parse(x.text);}catch{return null;}}),result];
  for(const value of candidates){const obj=value?.result||value?.data||value?.output||value;if(obj&&typeof obj==='object'&&(obj.id||obj.documentId||obj.messages||obj.threadId||obj.textContent))return obj;}
  throw new Error('The provider did not return a usable receipt. Verify the outcome before retrying.');
}
const normalize=value=>String(value||'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[*_`#>]/g,'').replace(/\s+/g,' ').trim();
const docText=value=>!value||typeof value!=='object'?'':value.textRun?.content||Object.values(value).filter(x=>x&&typeof x==='object').map(x=>Array.isArray(x)?x.map(docText).join(''):docText(x)).join('');
const messageText=value=>{if(!value)return '';if(value.mimeType==='text/plain'&&value.body?.data)return Buffer.from(value.body.data,'base64url').toString('utf8');return (value.parts||[]).map(messageText).filter(Boolean).join('\n');};
export function connectorReceipt(kind,input,written,read){
  const id=written.id||written.documentId;
  if(typeof id!=='string'||!id)throw new Error('The provider did not return an action ID.');
  if(kind==='email.send'){
    const message=(read.messages||[]).find(x=>x.id===id);
    const headers=message?.payload?.headers||message?.headers||[],header=name=>headers.find(x=>String(x.name).toLowerCase()===name)?.value||'',recipients=name=>[...new Set((header(name).toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g)||[]))].sort(),sameRecipients=name=>JSON.stringify(recipients(name))===JSON.stringify([...(input[name]||[])].sort());
    const body=messageText(message?.payload).replace(/\r\n/g,'\n').trim(),verified=!!message&&(message.labelIds||[]).includes('SENT')&&['to','cc','bcc'].every(sameRecipients)&&header('subject')===input.subject&&body===String(input.body).replace(/\r\n/g,'\n').trim();
    return {verified,providerId:id,providerThreadId:written.threadId,sourceUrl:'https://mail.google.com/mail/u/0/#sent/'+(written.threadId||id),detail:verified?'Sent message recipients, subject and body verified in the provider thread.':'Provider returned a message ID; sent-message verification is incomplete.'};
  }
  if(kind==='calendar.create'){
    const same=(a,b)=>a===b||Number.isFinite(Date.parse(a))&&Date.parse(a)===Date.parse(b);
    const verified=read.id===id&&read.status!=='cancelled'&&read.summary===input.title&&same(read.start?.dateTime||read.start?.date,input.start)&&same(read.end?.dateTime||read.end?.date,input.end)&&input.attendees.every(address=>(read.attendees||[]).some(x=>x.email?.toLowerCase()===address));
    return {verified,providerId:id,sourceUrl:read.htmlLink||written.htmlLink,detail:verified?'Event title, times and attendees verified by reading the provider event.':'Provider returned an event ID; event fields do not yet match.'};
  }
  const body=read.textContent||docText(read.body||read.tabs),verified=(read.documentId||read.id)===id&&read.title===input.title&&normalize(body).includes(normalize(input.content));
  return {verified,providerId:id,sourceUrl:written.url||'https://docs.google.com/document/d/'+id+'/edit',detail:verified?'Document title and content verified by reading the provider document.':'Provider returned a document ID; content verification is incomplete.'};
}

export async function executeTypedAction(connection,kind,input,context,{authority}={}){
  if(!authority)throw new Error('The action authority broker is unavailable.');
  const prepared=typedAction(kind,input),accounts=(await connection.accounts()).filter(x=>x.app===prepared.definition.app&&x.healthy);
  const account=prepared.accountId?accounts.find(x=>x.id===prepared.accountId):accounts.length===1?accounts[0]:null;
  if(!account)throw new Error(accounts.length>1?'Choose which connected account should perform this action.':'Connect the required account in Seek Connections first.');
  prepared.intent.account=account.id;
  return connection.mcp(prepared.definition.app,async client=>{
    const tools=await connection.allTools(client),write=tools.find(x=>x.name===prepared.definition.write),read=tools.find(x=>x.name===prepared.definition.read);
    if(!write||!read)throw new Error('This account does not expose the required write and verification tools. Reconnect or use browser handoff.');
    for(const key of Object.keys(prepared.args))if(!write.inputSchema?.properties?.[key])throw new Error('The provider action schema changed. Refresh the connection before retrying.');
    const verify=async written=>{
      const args=kind==='email.send'?{threadId:written.threadId}:kind==='calendar.create'?{calendarId:prepared.intent.payload.calendarId,eventId:written.id}:{documentId:written.documentId};
      if(Object.values(args).some(value=>typeof value!=='string'||!value))return {verified:false,providerId:written.id||written.documentId,providerThreadId:written.threadId,detail:'The provider receipt is missing a verification ID.'};
      try{const observed=providerObject(await client.callTool({name:read.name,arguments:args}));return connectorReceipt(kind,prepared.intent.payload,written,observed);}
      catch{return {verified:false,providerId:written.id||written.documentId,providerThreadId:written.threadId,detail:'The write returned a provider receipt but verification could not finish. Check it before retrying.'};}
    };
    const result=await authority.execute(prepared.intent,context,async()=>{
      const result=await client.callTool({name:write.name,arguments:prepared.args});return providerObject(result);
    },{verify});
    if(result.duplicate&&result.proposal?.state==='observed'){
      const stored=JSON.parse(result.proposal.receipt||'null');
      if(stored?.providerId){const evidence=await verify({id:stored.providerId,documentId:stored.providerId,threadId:stored.providerThreadId});if(evidence.verified){await authority.confirm(result.proposal.id,evidence);return {allowed:true,duplicate:true,id:result.proposal.id,state:'verified',receipt:evidence};}}
    }
    return result;
  },{accountId:account.id});
}
