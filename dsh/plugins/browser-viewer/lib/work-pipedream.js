import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
// MCP SDK v2, as shipped with DeepSeek Harness 0.2.
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {dpapi} from './work-finance.js';
import {previewResult} from './work-results.js';
import {executeTypedAction,TYPED_ACTIONS} from './work-connector-actions.js';

const APP=/^[a-z0-9][a-z0-9_-]{0,79}$/;
const READ=/^(?:[a-z0-9_]+[-_])?(?:get|list|search|find|fetch|retrieve|read|query|lookup|describe|inspect|check)[-_]/i;
const WRITE=/(?:^|[-_])(?:create|update|delete|remove|send|post|put|patch|publish|invite|add|edit|set|upsert|archive|submit|execute|transfer|trade)(?:[-_]|$)/i;
const readable=t=>!WRITE.test(t.name)&&t.annotations?.readOnlyHint!==false&&(t.annotations?.readOnlyHint===true||READ.test(t.name));
const safeError=(status)=>`Pipedream returned ${status}. Check the project credentials and connection status.`;

export class PipedreamConnection {
  constructor(root,log=console){this.root=join(root,'pipedream');this.log=log;this.config=null;this.token='';this.tokenUntil=0;this.accountCache=null;this.accountUntil=0;}
  async init(){
    await mkdir(this.root,{recursive:true});
    try{this.config=JSON.parse(await dpapi('unprotect',await readFile(join(this.root,'config.dpapi'),'utf8')));}
    catch(e){if(e.code!=='ENOENT')this.log.warn('Pipedream configuration could not be opened: '+e.message);}
    if(!this.config&&process.env.PIPEDREAM_CLIENT_ID&&process.env.PIPEDREAM_CLIENT_SECRET&&process.env.PIPEDREAM_PROJECT_ID)
      this.config={clientId:process.env.PIPEDREAM_CLIENT_ID,clientSecret:process.env.PIPEDREAM_CLIENT_SECRET,projectId:process.env.PIPEDREAM_PROJECT_ID,environment:process.env.PIPEDREAM_ENVIRONMENT==='production'?'production':'development'};
    return this;
  }
  get configured(){return !!(this.config?.clientId&&this.config?.clientSecret&&this.config?.projectId);}
  async configure(input){
    const {clientId,clientSecret,projectId,environment}=input||{};
    if(![clientId,clientSecret,projectId].every(x=>typeof x==='string'&&x.trim())||!['development','production'].includes(environment))throw new Error('Enter a Pipedream Connect client ID, client secret, project ID and environment.');
    const candidate={clientId:clientId.trim(),clientSecret:clientSecret.trim(),projectId:projectId.trim(),environment};
    const token=await this.auth(candidate);
    const query=new URLSearchParams({external_user_id:'seek-local-user',limit:'1'});
    const response=await fetch(`https://api.pipedream.com/v1/connect/${encodeURIComponent(candidate.projectId)}/accounts?${query}`,{headers:{Authorization:`Bearer ${token}`,'x-pd-environment':candidate.environment},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(safeError(response.status));
    const encrypted=await dpapi('protect',JSON.stringify(candidate));const tmp=join(this.root,'config.dpapi.tmp');
    await writeFile(tmp,encrypted,{mode:0o600});await rename(tmp,join(this.root,'config.dpapi'));
    this.config=candidate;this.token='';this.tokenUntil=0;this.accountCache=null;return this.status();
  }
  async auth(config=this.config){
    if(!config)throw new Error('Set up a Pipedream Connect project on this PC first.');
    const response=await fetch('https://api.pipedream.com/v1/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:config.clientId,client_secret:config.clientSecret}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(safeError(response.status));
    const data=await response.json();if(!data.access_token)throw new Error('Pipedream did not return an access token.');
    if(config===this.config){this.token=data.access_token;this.tokenUntil=Date.now()+Math.max(60,Number(data.expires_in)||3600)*1000-60000;}
    return data.access_token;
  }
  async accessToken(){if(this.token&&Date.now()<this.tokenUntil)return this.token;return this.auth();}
  async api(method,path,body){
    const token=await this.accessToken();
    const response=await fetch('https://api.pipedream.com'+path,{method,headers:{Authorization:`Bearer ${token}`,'x-pd-environment':this.config.environment,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(safeError(response.status));
    const raw=await response.text();return raw?JSON.parse(raw):{};
  }
  async disconnect(id){
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw new Error('Choose a linked account to disconnect.');
    const account=(await this.accounts(true)).find(a=>a.id===id);
    if(!account)throw new Error('That account is no longer linked.');
    await this.api('DELETE',`/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts/${encodeURIComponent(id)}`);
    this.accountCache=null;this.accountUntil=0;return {disconnected:account.name,status:await this.status(true)};
  }
  async accounts(fresh=false){
    if(!this.configured)throw new Error('Pipedream is not configured.');
    if(!fresh&&this.accountCache&&Date.now()<this.accountUntil)return this.accountCache;
    const rows=[];
    let after='';
    for(let page=0;page<10;page++){
      const query=new URLSearchParams({external_user_id:'seek-local-user',limit:'100'});
      if(after)query.set('after',after);
      const raw=await this.api('GET',`/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts?${query}`);
      const items=Array.isArray(raw)?raw:Array.isArray(raw.data)?raw.data:[];
      rows.push(...items);
      const next=raw.page_info?.end_cursor;
      if(!next||next===after||items.length<100)break;
      after=next;
    }
    this.accountCache=rows.map(a=>({id:a.id,app:a.app?.name_slug||a.app||'',name:a.app?.name||a.name||'Connected app',accountName:a.name||'',healthy:a.healthy!==false&&!a.dead}));
    this.accountUntil=Date.now()+30000;return this.accountCache;
  }
  async status(fresh=false){
    if(!this.configured)return {configured:false,connected:false,accounts:[],detail:'Set up a Pipedream Connect project to link more apps.'};
    try{const accounts=await this.accounts(fresh);return {configured:true,environment:this.config.environment,connected:accounts.some(a=>a.healthy),accounts,detail:`${this.config.environment==='production'?'Production':'Development'} · ${accounts.length} linked account${accounts.length===1?'':'s'} through Pipedream.`};}
    catch(e){return {configured:true,environment:this.config.environment,connected:false,accounts:[],detail:e.message};}
  }
  async search(query){
    if(typeof query!=='string'||query.trim().length<2)throw new Error('Search for an app name with at least two characters.');
    const params=new URLSearchParams({q:query.trim().slice(0,80),limit:'20',has_actions:'true'});
    const result=await this.api('GET',`/v1/connect/apps?${params}`);
    return {apps:(result.data||[]).map(a=>({slug:a.name_slug,name:a.name,description:String(a.description||'').slice(0,250),authType:a.auth_type})),total:result.page_info?.total_count||0};
  }
  async connectLink(app){
    if(!APP.test(app))throw new Error('Choose a valid app from the catalog.');
    const result=await this.api('POST',`/v1/connect/${encodeURIComponent(this.config.projectId)}/tokens`,{external_user_id:'seek-local-user'});
    if(!result.connect_link_url)throw new Error('Pipedream did not return a connection link.');
    const url=new URL(result.connect_link_url);
    if(url.protocol!=='https:'||url.hostname!=='pipedream.com')throw new Error('Pipedream returned an unexpected link.');
    url.searchParams.set('app',app);return {url:url.toString(),expiresAt:result.expires_at};
  }
  async mcp(app,fn,{accountId}={}){
    if(!APP.test(app))throw new Error('Choose a valid app slug.');
    const accounts=await this.accounts();if(!accounts.some(a=>a.app===app&&a.healthy&&(!accountId||a.id===accountId)))throw new Error(`Connect ${app} in Seek Connections first.`);
    const transport=new StreamableHTTPClientTransport(new URL('https://remote.mcp.pipedream.net/v3'),{requestInit:{headers:{Authorization:`Bearer ${await this.accessToken()}`,'x-pd-project-id':this.config.projectId,'x-pd-environment':this.config.environment,'x-pd-external-user-id':'seek-local-user','x-pd-app-slug':app,...(accountId?{'x-pd-account-id':accountId}:{})}}});
    const client=new Client({name:'seek-work',version:'1.0.0'});
    try{await client.connect(transport);return await fn(client);}
    finally{await client.close().catch(()=>{});}
  }
  async allTools(client){const tools=[],seen=new Set();let cursor;for(let page=0;page<10;page++){const result=await client.listTools(cursor?{cursor}:undefined,{cacheMode:'refresh'});tools.push(...(result.tools||[]));const next=result.nextCursor;if(!next)return tools;if(seen.has(next))throw new Error('The connected app repeated its tool cursor.');seen.add(next);cursor=next;}throw new Error('The connected app tool catalog is too large to inspect safely.');}
  async capabilities(){const accounts=await this.accounts();return {actions:Object.entries(TYPED_ACTIONS).map(([kind,definition])=>({kind,app:definition.app,accounts:accounts.filter(x=>x.app===definition.app&&x.healthy).map(x=>({id:x.id,name:x.accountName||x.name})),requiresVerification:true})),boundary:'OAuth remains in the host adapter; typed writes require durable task authority. Same-user host execution is not an OS sandbox.'};}
  async write(kind,input,context,options){return executeTypedAction(this,kind,input,context,options);}
  async tools(app,query=''){return this.mcp(app,async client=>{
    const result=await client.listTools(undefined,{cacheMode:'refresh'});const q=String(query||'').toLowerCase().slice(0,80);
    const matching=(result.tools||[]).filter(t=>!q||`${t.name} ${t.description||''}`.toLowerCase().includes(q));
    return {app,tools:matching.slice(0,20).map(t=>({name:t.name,description:String(t.description||'').slice(0,350),inputSchema:t.inputSchema,readable:readable(t)})),matching:matching.length,truncated:matching.length>20||!!result.nextCursor};
  });}
  async read(app,name,args,capture){
    if(typeof name!=='string'||!name||!args||typeof args!=='object'||Array.isArray(args))throw new Error('Specify an app tool and JSON object arguments.');
    return this.mcp(app,async client=>{
      const list=await client.listTools(undefined,{cacheMode:'refresh'});const tool=(list.tools||[]).find(t=>t.name===name);
      if(!tool)throw new Error('That tool was not found in the connected app.');
      if(!readable(tool))throw new Error('This action may change data. Use the browser approval flow for it.');
      const result=await client.callTool({name,arguments:args});
      if(result.isError)throw new Error('The connected app rejected this request.');
      return capture?capture({...result,app,tool:name}):{app,tool:name,...previewResult(result)};
    });
  }
}
