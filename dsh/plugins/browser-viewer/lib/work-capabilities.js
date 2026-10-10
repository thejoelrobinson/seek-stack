import {createHash} from 'node:crypto';

export class WorkflowError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
const unsafe=new Set(['__proto__','prototype','constructor']);
export function jsonValue(value,{maxBytes=1024*1024}={}){
  const visit=(v,depth=0)=>{
    if(depth>20)throw new WorkflowError('invalid_input','JSON nesting exceeds 20 levels.');
    if(v===null||typeof v==='string'||typeof v==='boolean')return;
    if(typeof v==='number'&&Number.isFinite(v))return;
    if(Array.isArray(v)){if(v.length>5000)throw new WorkflowError('invalid_input','Array exceeds 5000 entries.');for(const x of v)visit(x,depth+1);return;}
    if(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v))){const keys=Object.keys(v);if(keys.length>200)throw new WorkflowError('invalid_input','Object exceeds 200 fields.');for(const k of keys){if(unsafe.has(k))throw new WorkflowError('invalid_input','Unsafe JSON field.');visit(v[k],depth+1);}return;}
    throw new WorkflowError('invalid_input','Only finite JSON values are supported.');
  };visit(value);
  const text=JSON.stringify(value);if(Buffer.byteLength(text)>maxBytes)throw new WorkflowError('invalid_input','JSON size limit exceeded.');return JSON.parse(text);
}
export function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export const contentHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export const objectSchema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const types=new Set(['object','array','string','number','integer','boolean','null','json']);
export function schemaValid(schema,depth=0){
  if(depth>16||!schema||typeof schema!=='object'||!types.has(schema.type))throw new WorkflowError('invalid_recipe','Unsupported schema.');
  const allowed=['type','properties','required','additionalProperties','items','enum','minimum','maximum','minLength','maxLength','maxItems','description'];
  if(Object.keys(schema).some(k=>!allowed.includes(k)))throw new WorkflowError('invalid_recipe','Unsupported schema keyword.');
  if(schema.type==='object'){
    if(!schema.properties||schema.additionalProperties!==false)throw new WorkflowError('invalid_recipe','Object schemas must declare fields and reject unknown fields.');
    if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.some(k=>!Object.hasOwn(schema.properties,k))))throw new WorkflowError('invalid_recipe','Invalid required fields.');
    for(const [k,s] of Object.entries(schema.properties)){if(unsafe.has(k))throw new WorkflowError('invalid_recipe','Unsafe schema field.');schemaValid(s,depth+1);}
  }
  if(schema.type==='array'){schemaValid(schema.items,depth+1);if(!Number.isInteger(schema.maxItems)||schema.maxItems<0||schema.maxItems>5000)throw new WorkflowError('invalid_recipe','Array schemas need a bounded maxItems.');}
  for(const k of ['minimum','maximum','minLength','maxLength','maxItems'])if(schema[k]!==undefined&&(!Number.isFinite(schema[k])||(['minLength','maxLength','maxItems'].includes(k)&&(!Number.isInteger(schema[k])||schema[k]<0))))throw new WorkflowError('invalid_recipe','Invalid schema bound.');
  if(schema.enum!==undefined&&(!Array.isArray(schema.enum)||!schema.enum.length||schema.enum.length>100))throw new WorkflowError('invalid_recipe','Invalid enum.');
  return schema;
}
export function validate(schema,value,path='input'){
  const fail=message=>{throw new WorkflowError('invalid_input',`${path}: ${message}`);};
  if(schema.enum&&!schema.enum.some(x=>canonical(x)===canonical(value)))fail('unsupported value');
  switch(schema.type){
    case 'json':jsonValue(value);break;
    case 'object':
      if(!value||Array.isArray(value)||typeof value!=='object')fail('must be an object');
      for(const k of schema.required||[])if(!Object.hasOwn(value,k))fail(`missing ${k}`);
      for(const k of Object.keys(value)){if(!Object.hasOwn(schema.properties,k)||unsafe.has(k))fail(`unknown field ${k}`);validate(schema.properties[k],value[k],path+'.'+k);}break;
    case 'array':if(!Array.isArray(value)||value.length>schema.maxItems)fail('invalid array size');value.forEach((v,i)=>validate(schema.items,v,`${path}[${i}]`));break;
    case 'string':if(typeof value!=='string'||value.length<(schema.minLength||0)||value.length>(schema.maxLength??20000))fail('invalid string');break;
    case 'integer':if(!Number.isSafeInteger(value))fail('must be a safe integer');
    case 'number':if(typeof value!=='number'||!Number.isFinite(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))fail('invalid number');break;
    case 'boolean':if(typeof value!=='boolean')fail('must be boolean');break;
    case 'null':if(value!==null)fail('must be null');break;
    default:fail('unsupported schema');
  }return value;
}
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export class CapabilityRegistry {
  constructor(){this.definitions=new Map();}
  register(definition){
    const d={timeoutMs:15000,resource:'data',...definition};
    if(!/^[a-z][a-z0-9_.-]{1,80}$/.test(d.name)||!Number.isInteger(d.version)||d.version<1||!['pure','read','write'].includes(d.effect)||typeof d.execute!=='function'||typeof d.verify!=='function'||!Number.isInteger(d.timeoutMs)||d.timeoutMs<1||d.timeoutMs>120000)throw new WorkflowError('invalid_recipe','Invalid capability definition.');
    if(d.effect==='write'&&(typeof d.reconcile!=='function'||typeof d.lockKey!=='function'))throw new WorkflowError('invalid_recipe','Write capabilities need reconciliation and a resource lock key.');
    schemaValid(d.input);schemaValid(d.output);const key=d.name+'@'+d.version;if(this.definitions.has(key))throw new WorkflowError('invalid_recipe','Capability version already registered.');
    this.definitions.set(key,freeze({...d,input:jsonValue(d.input),output:jsonValue(d.output)}));return this;
  }
  get(name,version){const d=this.definitions.get(name+'@'+version);if(!d)throw new WorkflowError('provider_changed','Capability version is unavailable.');return d;}
  list(){return [...this.definitions.values()].map(({name,version,effect,resource,input,output})=>({name,version,effect,resource,input,output}));}
  check(d,context){
    if(!context?.task||!['queued','running'].includes(context.task.status))throw new WorkflowError('policy_denied','An active Work task is required.');
    if(context.task.eval&&d.resource!=='data'&&!context.fixture)throw new WorkflowError('policy_denied','Evaluation cannot access real accounts.');
    if(context.task.proactive&&d.effect==='write')throw new WorkflowError('policy_denied','Preparation cannot make external changes.');
    if(d.effect==='write'&&typeof context.writeBroker!=='function')throw new WorkflowError('policy_denied','External writes require the authority broker.');
    context.guard?.(d);
  }
  async call(name,version,input,context){
    const d=this.get(name,version);this.check(d,context);validate(d.input,jsonValue(input));
    const abort=new AbortController();let timer;
    const parentAbort=()=>abort.abort(context.signal?.reason);context.signal?.addEventListener('abort',parentAbort,{once:true});
    try{
      if(context.signal?.aborted)throw new WorkflowError('cancelled','Workflow cancelled.');
      const execute=()=>d.execute(input,{...context,signal:abort.signal});
      const pending=d.effect==='write'?context.writeBroker(d,input,execute,context):execute();
      const output=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new WorkflowError(d.effect==='write'?'uncertain_write':'timeout','Capability deadline exceeded.'));abort.abort();},d.timeoutMs);}),new Promise((_,reject)=>{abort.signal.addEventListener('abort',()=>reject(new WorkflowError(d.effect==='write'?'uncertain_write':'cancelled','Execution interrupted.')),{once:true});})]);
      validate(d.output,jsonValue(output));
      if(!await d.verify(output,input,context))throw new WorkflowError('verification_failed','Capability output did not pass verification.');
      if(context.signal?.aborted)throw new WorkflowError(d.effect==='write'?'uncertain_write':'cancelled','Execution interrupted.');return output;
    }finally{clearTimeout(timer);context.signal?.removeEventListener('abort',parentAbort);}
  }
}
