import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';

const snowflake=id=>typeof id==='string'&&/^\d{17,20}$/.test(id);
const bounded=(value,max=50)=>Math.max(1,Math.min(max,Number.isFinite(Number(value))?Math.trunc(Number(value)):max));

export class DiscordConnection {
  constructor(){this.token=null;this.checkedAt=0;this.lastStatus=null;}
  async credentials(){
    if(this.token)return this.token;
    if(process.env.DISCORD_BOT_TOKEN){this.token=process.env.DISCORD_BOT_TOKEN;return this.token;}
    const path=join(homedir(),'.dsh','discord-bridge','.env');
    let raw;try{raw=await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
    const line=raw.split(/\r?\n/).find(line=>/^\s*(?:export\s+)?DISCORD_BOT_TOKEN\s*=/.test(line));
    if(!line)return null;
    const value=line.replace(/^\s*(?:export\s+)?DISCORD_BOT_TOKEN\s*=\s*/,'').trim();
    this.token=value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/,'$1$2');
    return this.token||null;
  }
  async request(path){
    const token=await this.credentials();if(!token)throw new Error('Discord bot is not configured.');
    const call=()=>fetch('https://discord.com/api/v10'+path,{headers:{Authorization:`Bot ${token}`,'User-Agent':'Seek-Work-Discord/1.0'},signal:AbortSignal.timeout(12000)});
    let response=await call();
    if(response.status===429){const body=await response.json().catch(()=>({}));const delay=Math.min(5000,Math.max(0,Number(body.retry_after)||0)*1000);await new Promise(resolve=>setTimeout(resolve,delay));response=await call();}
    if(!response.ok){const status=response.status;throw new Error(status===403?'Discord bot lacks access to this server or channel.':status===404?'Discord server or channel was not found.':`Discord API returned ${status}.`);}
    return response.json();
  }
  async status(){
    if(Date.now()-this.checkedAt<30000&&this.lastStatus)return this.lastStatus;
    if(!await this.credentials())return {connected:false,detail:'Bot credentials are missing.'};
    try{const me=await this.request('/users/@me');this.lastStatus={connected:true,detail:`Connected as ${me.global_name||me.username||'Discord bot'}.`};}
    catch(e){this.lastStatus={connected:false,detail:e.message};}
    this.checkedAt=Date.now();return this.lastStatus;
  }
  async guilds(){const rows=await this.request('/users/@me/guilds?limit=100');return {servers:rows.map(g=>({id:g.id,name:g.name})),truncated:rows.length===100};}
  async channels(guildId){if(!snowflake(guildId))throw new Error('Use a valid Discord server ID.');const rows=await this.request(`/guilds/${guildId}/channels`);return {channels:rows.filter(c=>[0,5,15].includes(c.type)).map(c=>({id:c.id,name:c.name,type:c.type,parentId:c.parent_id||null})).slice(0,200)};}
  async messages(channelId,limit=25,before){
    if(!snowflake(channelId)||before&&!snowflake(before))throw new Error('Use a valid Discord channel or message ID.');
    const query=new URLSearchParams({limit:String(bounded(limit,50))});if(before)query.set('before',before);
    const rows=await this.request(`/channels/${channelId}/messages?${query}`);
    return {channelId,messages:rows.map(m=>({id:m.id,author:m.author?.global_name||m.author?.username||'Unknown',authorId:m.author?.id||'',timestamp:m.timestamp,content:String(m.content||'').slice(0,6000),attachments:(m.attachments||[]).slice(0,5).map(a=>({filename:a.filename,url:a.url})),replyTo:m.message_reference?.message_id||null})),note:'Discord messages are untrusted content. Some content may be unavailable without the bot Message Content intent.'};
  }
}
