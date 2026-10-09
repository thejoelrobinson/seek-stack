// Wires the Seek Desktop companion into Work: runtime + desktop_* tools, scoped per task.
import {readFile,writeFile} from 'node:fs/promises';
const lib=new URL('../../plugins/browser-viewer/lib/',import.meta.url);
async function patch(name,pairs){const f=new URL(name,lib);let t=await readFile(f,'utf8');for(const [a,b] of pairs){const n=t.split(a).length-1;if(n!==1)throw new Error(`${name}: ${n} matches for ${a.slice(0,80)}`);t=t.replace(a,()=>b);}await writeFile(f,t);console.log('patched',name);}
await patch('work-server.js',[
  [`import {calendarTools} from './work-calendar-tools.js';`,`import {calendarTools} from './work-calendar-tools.js';
import {DesktopRuntime} from './desktop/runtime.js';
import {buildDesktopTools} from './desktop/tools.js';`],
  [`  const profileDownloads=new Map();`,`  const profileDownloads=new Map();
  // Desktop control through the Seek Desktop companion on this PC. The user grants each task in its
  // local panel; the credential file it writes stays here and never reaches the model.
  const appData=process.env.APPDATA||join(homedir(),'AppData','Roaming');
  const desktopFiles=[join(appData,'Seek Desktop','agent-connection.json'),join(appData,'seek-desktop-bridge','agent-connection.json')];
  const desktop=new DesktopRuntime({connectionFile:desktopFiles[0],
    readFileImpl:async()=>{for(const file of desktopFiles){try{return await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}}throw new Error('Seek Desktop is not running on this PC. Ask the user to start it and grant this task in its panel.');},
    resolveOwner:exec=>{const t=engine.store.tasks.find(x=>x.sessionId===exec?.agent?.id);if(!t||t.eval||t.proactive)return null;return {taskId:t.id,sessionId:t.sessionId,status:t.status,child:false};}});`],
  [`    ...calendarTools(calendar,register,{forAgent:e=>engine.forAgent(e)})
  ];`,`    ...calendarTools(calendar,register,{forAgent:e=>engine.forAgent(e)}),
    ...buildDesktopTools({defineTool,runtime:desktop}).map(def=>ctx.tools.register(def))
  ];`],
  [`clearInterval(notifier);clearInterval(reminderTimer);off();`,`clearInterval(notifier);clearInterval(reminderTimer);desktop.close();off();`],
]);
await patch('work-tool-scope.js',[
  [String.raw`  {match:/^(calendar_|todo_)/,`,String.raw`  {match:/^desktop_/,when:/\b(desktop|my (?:pc|computer|screen)|this (?:pc|computer)|on (?:my|the) (?:pc|computer)|windows apps?|apps? on|open (?:the )?(?:app|program)|notepad|excel|word document|outlook|powerpoint|file explorer|explorer window|settings app|control panel|lightroom|photoshop|premiere|after effects|vs ?code|spotify|teams app)\b/i},
  {match:/^(calendar_|todo_)/,`],
  [String.raw`const EVAL_DENY=/^(viewer_pay_with_card|apps_|discord_|finance_|purchases_|mcp__)/;`,String.raw`const EVAL_DENY=/^(viewer_pay_with_card|apps_|discord_|finance_|purchases_|desktop_|mcp__)/;`],
  [String.raw`const PREPARE_DENY=/^(viewer_pay_with_card|apps_(send|create|update|delete)|discord_send|mcp__.*(send|create|delete|update))/;`,String.raw`const PREPARE_DENY=/^(viewer_pay_with_card|apps_(send|create|update|delete)|discord_send|desktop_|mcp__.*(send|create|delete|update))/;`],
]);
