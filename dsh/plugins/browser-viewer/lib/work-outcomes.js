import {readFile,stat} from 'node:fs/promises';
import {extname} from 'node:path';
import {createHash} from 'node:crypto';
// "save it to count.txt", "write fib.py" — file names the request asks for. Names introduced as
// inputs ("the attached orders.csv", "read brief.txt") and framework names are not deliverables.
const DELIVERABLE=/(?<![\w./:\\-])([a-z0-9][\w.-]{0,80}\.(?:txt|md|json|csv|tsv|pdf|png|jpe?g|webp|svg|xlsx|docx|pptx|html?|py|js|ts|ps1|sh|ics|zip))(?![\w/\\-])/gi;
const READ_ONLY=/\b(attached|read|reads|reading|open|opening|using|use|from|input|inputs|given|provided|uploaded|see|review|summari[sz]e|analy[sz]e|in the)\b[^.;\n]{0,24}$/i;
const NOT_FILES=/^(node|next|vue|react|three|d3|chart|express|nuxt|deno|bun|angular|svelte|ember|backbone)\.js$/i;
export function namedDeliverables(objective,inputs=[]){
  const s=String(objective||''),names=new Set(),given=new Set(inputs.map(n=>String(n).replace(/^\d+-/,'').toLowerCase()));
  for(const m of s.matchAll(DELIVERABLE)){
    const name=m[1];
    if(given.has(name.toLowerCase())||NOT_FILES.test(name)||READ_ONLY.test(s.slice(Math.max(0,m.index-40),m.index)))continue;
    names.add(name);
  }
  return [...names].slice(0,8);
}
export function taskContract(objective,provided,inputs=[]){
  if(provided){
    if(!Array.isArray(provided.deliverables||[])||!Array.isArray(provided.checks||[])||!['answer','artifact','external'].includes(provided.kind||'answer')||(provided.deliverables||[]).length>20||(provided.checks||[]).length>30)throw new Error('Invalid outcome contract.');
    const deliverables=(provided.deliverables||[]).map(p=>{if(typeof p!=='string'||!p.trim()||p.length>500||/[\r\n:"<>|?*]/.test(p)||/^(?:[\\/]|[a-z]:)/i.test(p)||p.split(/[\\/]/).some(part=>part==='..'||part==='')||!/(?:\.[a-z0-9]{1,12}|(?:^|[\\/])(?:README|LICENSE|Dockerfile|Makefile|CHANGELOG))$/i.test(p))throw new Error('Deliverables must be exact relative file paths, such as result.txt. Put descriptions and browser outcomes in the outcome text; external actions use receipts.');return p;});
    const checks=(provided.checks||[]).map(c=>{if(!c||!['contains','json','sha256','min-bytes'].includes(c.kind)||typeof c.path!=='string'||!c.path||c.path.length>500||c.label!==undefined&&(typeof c.label!=='string'||c.label.length>200))throw new Error('Invalid outcome check.');if(c.kind==='contains'&&(typeof c.value!=='string'||c.value.length>20000)||c.kind==='sha256'&&!/^[a-f0-9]{64}$/i.test(c.value||'')||c.kind==='min-bytes'&&(!Number.isSafeInteger(c.value)||c.value<0)||c.kind==='json'&&c.key!==undefined&&(typeof c.key!=='string'||c.key.length>500))throw new Error('Invalid outcome check value.');return {...c};});
    return {outcome:String(provided.outcome||objective).slice(0,20000),kind:provided.kind||'answer',requiresArtifact:provided.requiresArtifact===true||provided.kind==='artifact',requiresExternal:provided.requiresExternal===true||provided.kind==='external',deliverables,checks};
  }
  const artifact=/\b(create|make|produce|generate|write|build|export|deliver)\b[\s\S]{0,100}\b(file|pdf|spreadsheet|xlsx|csv|document|report|presentation|slides|pptx|dashboard|website|artifact)\b/i.test(objective)||/\b(create|make|produce|generate|write|build|export|deliver)\b[\s\S]{0,100}\b[a-z0-9][a-z0-9._-]*\.(?:txt|md|json|csv|pdf|png|jpe?g|webp|xlsx|docx|pptx|html|zip)\b/i.test(objective);
  const external=/\b(send|publish|book|purchase|buy|submit|schedule|create|update)\b[\s\S]{0,70}\b(email|message|meeting|appointment|event|reservation|order|post)\b/i.test(objective)&&!/\b(draft|prepare|preview|do not send|don't send)\b/i.test(objective);
  const named=namedDeliverables(objective,inputs);
  return {outcome:objective,kind:external?'external':artifact||named.length?'artifact':'answer',requiresArtifact:artifact||named.length>0,requiresExternal:external,deliverables:named,checks:[]};
}
export async function inspectArtifact(full){
  const info=await stat(full);if(!info.isFile()||!info.size)throw new Error('The deliverable is empty or is not a regular file.');
  const data=await readFile(full),type=extname(full).toLowerCase();
  if(type==='.json')JSON.parse(data.toString('utf8'));
  if(type==='.pdf'&&!data.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('Invalid PDF header.');
  if(type==='.png'&&!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid PNG header.');
  if(['.xlsx','.docx','.pptx'].includes(type)&&data.subarray(0,2).toString()!=='PK')throw new Error('Invalid Office document archive.');
  return {bytes:info.size,type:type.slice(1)||'file',sha256:createHash('sha256').update(data).digest('hex'),modifiedAt:info.mtimeMs};
}
export function declaredContract(task,declaration={}){
  const base=task.userContract||taskContract(task.objective);
  return taskContract(task.objective,{...base,deliverables:[...new Set([...base.deliverables,...(declaration.deliverables||[])])],checks:[...base.checks,...(declaration.checks||[])]});
}
// Windows records workspace paths with backslashes; contracts usually use forward slashes.
const normalPath=p=>String(p).replace(/\\/g,'/').replace(/^\.\//,'').toLowerCase();
export const samePath=(a,b)=>!!a&&!!b&&normalPath(a)===normalPath(b);
export async function verifyOutcome(task,{file,receipts=[],register}={}){
  const contract=task.contract||taskContract(task.objective),checks=[],failures=[];
  const add=(label,ok,detail='')=>{checks.push({label,ok,detail});if(!ok)failures.push(label);};
  const artifacts=task.artifacts||[];
  for(const a of artifacts){try{const f=await file(task,a.path),actual=await inspectArtifact(f.full);add(a.title||a.path,true,'Nonempty '+actual.type+'; structure and hash checked');Object.assign(a,actual);}catch(e){add(a.title||a.path,false,e.message);}}
  for(const expected of contract.deliverables||[]){
    const label='Deliverable: '+String(expected);
    if(artifacts.some(a=>samePath(a.path,expected)||samePath(a.originalPath,expected)||samePath(a.title,expected))){add(label,true,'Recorded artifact');continue;}
    // The file exists but was never registered: register it here instead of sending the agent into a repair loop.
    if(register){try{await register(task,expected);add(label,true,'Found in the workspace and recorded');continue;}catch(e){add(label,false,`${expected} is not a nonempty file in the task workspace (${e.message}). Create it there; do not re-register other files.`);continue;}}
    add(label,false,`No recorded artifact matches ${expected}. Call work_artifact with that exact relative path.`);
  }
  // After the deliverables loop, which may have just recorded files found in the workspace.
  if(contract.requiresArtifact||contract.kind==='artifact')add('Requested deliverable exists',artifacts.length>0||(task.artifacts||[]).length>0);
  for(const c of contract.checks||[]){try{
    if(!['contains','json','sha256','min-bytes'].includes(c.kind)||typeof c.path!=='string')throw new Error('Unsupported outcome check.');
    const f=await file(task,c.path),data=await readFile(f.full);let ok=false;
    if(c.kind==='contains')ok=typeof c.value==='string'&&data.toString('utf8').includes(c.value);
    if(c.kind==='json'){const value=JSON.parse(data.toString('utf8'));ok=!c.key||Object.hasOwn(value,c.key);}
    if(c.kind==='sha256')ok=createHash('sha256').update(data).digest('hex')===c.value;
    if(c.kind==='min-bytes')ok=Number.isSafeInteger(c.value)&&c.value>=0&&data.length>=c.value;
    add(c.label||c.kind+' '+c.path,ok);
  }catch(e){add(c.label||c.kind||'Outcome check',false,e.message);}}
  if(contract.requiresExternal||contract.kind==='external')add('External action receipt',receipts.some(r=>r.taskId===task.id&&['verified','succeeded'].includes(r.state)));
  const answer=typeof task.result==='string'&&task.result.trim().length>0;
  if(!artifacts.length&&contract.kind==='answer')add('Answer received',answer);
  const status=failures.length?'needs-verification':contract.kind==='answer'&&!contract.checks?.length?'partial':'verified';
  return {status,summary:failures.length?'Required outcome evidence is missing.':status==='partial'?'Response received; content has not been independently verified.':'Declared deliverable and receipt checks passed.',checks,checkedAt:Date.now(),scope:'These checks verify declared evidence and file structure, not every factual statement.'};
}
