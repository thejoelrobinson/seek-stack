import {readFile,writeFile} from 'node:fs/promises';
const lib=new URL('../../plugins/browser-viewer/lib/',import.meta.url);
async function patch(name,from,to){const f=new URL(name,lib);let t=await readFile(f,'utf8');const n=t.split(from).length-1;if(n!==1)throw new Error(`${name}: ${n} matches`);await writeFile(f,t.replace(from,()=>to));console.log('patched',name);}
const discord=String.raw`  {match:/^discord_/,when:/\bdiscord\b/i},`;
await patch('work-tool-scope.js',discord,discord+'\n'+String.raw`  {match:/^(calendar_|todo_)/,when:/\b(calendars?|schedul\w*|events?|meetings?|appointments?|agenda|remind\w*|to-?dos?|due|deadlines?|tomorrow|today|tonight|this week|next week|weekend|birthdays?|anniversar\w*|plan(?:ning)? my|free time|busy|dinner|lunch|dentist|doctor|trip|vacation)\b/i},`);
await patch('work-tool-policy.js',String.raw`partner-login\.json|auth-sessions\.json)`,String.raw`partner-login\.json|auth-sessions\.json|caldav-devices\.json|calendar\.sqlite)`);
