import {WorkflowError,jsonValue,contentHash,schemaValid,validate} from './work-capabilities.js';
const ident=/^[a-z][a-z0-9_-]{1,80}$/;
export function reference(root,path){
  let value=root;for(const part of path.split('.')){if(!/^[a-zA-Z0-9_-]+$/.test(part)||['__proto__','prototype','constructor'].includes(part)||!value||typeof value!=='object'||!Object.hasOwn(value,part))throw new WorkflowError('invalid_recipe','Workflow reference is missing.');value=value[part];}return value;
}
export function bind(value,input,outputs){
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'$ref')){if(Object.keys(value).length!==1)throw new WorkflowError('invalid_recipe','A reference cannot have other fields.');return reference({input,steps:outputs},value.$ref);}
  if(Array.isArray(value))return value.map(v=>bind(v,input,outputs));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,bind(v,input,outputs)]));return value;
}
function schemaAt(schema,parts){let s=schema;for(const p of parts){if(s.type==='json')return s;if(s.type==='array'&&/^\d+$/.test(p)){s=s.items;continue;}if(s.type!=='object'||!Object.hasOwn(s.properties,p))throw new WorkflowError('invalid_recipe','Reference has no declared output field.');s=s.properties[p];}return s;}
function checkBinding(value,target,inputSchema,steps){
  if(value&&typeof value==='object'&&Object.hasOwn(value,'$ref')){
    if(Object.keys(value).length!==1||typeof value.$ref!=='string'||value.$ref.length>300)throw new WorkflowError('invalid_recipe','Invalid reference.');
    const [root,id,...parts]=value.$ref.split('.');let source;
    if(root==='input')source=schemaAt(inputSchema,[id,...parts].filter(x=>x!==undefined));
    else if(root==='steps'&&steps.has(id))source=schemaAt(steps.get(id),parts);
    else throw new WorkflowError('invalid_recipe','Only inputs and previous steps can be referenced.');
    if(target.type!=='json'&&source.type!=='json'&&source.type!==target.type&&!(target.type==='number'&&source.type==='integer'))throw new WorkflowError('invalid_recipe','Reference type does not match its target.');return;
  }
  if(target.type==='object'&&value&&typeof value==='object'&&!Array.isArray(value)){
    for(const k of target.required||[])if(!Object.hasOwn(value,k))throw new WorkflowError('invalid_recipe','Missing step input.');
    for(const [k,v] of Object.entries(value)){if(!Object.hasOwn(target.properties,k))throw new WorkflowError('invalid_recipe','Unknown step field.');checkBinding(v,target.properties[k],inputSchema,steps);}return;
  }
  if(target.type==='array'&&Array.isArray(value)){if(value.length>target.maxItems)throw new WorkflowError('invalid_recipe','Batch too large.');for(const v of value)checkBinding(v,target.items,inputSchema,steps);return;}
  validate(target,value);
}
export function validateRecipe(raw,registry){
  const recipe=jsonValue(raw,{maxBytes:128*1024}),allowed=['id','version','title','description','input','steps','result'];
  if(Object.keys(recipe).some(k=>!allowed.includes(k))||!ident.test(recipe.id)||!Number.isInteger(recipe.version)||recipe.version<1||typeof recipe.title!=='string'||!recipe.title.trim()||recipe.title.length>100||!Array.isArray(recipe.steps)||!recipe.steps.length||recipe.steps.length>32)throw new WorkflowError('invalid_recipe','Invalid recipe definition.');
  schemaValid(recipe.input);const known=new Map();
  for(const s of recipe.steps){if(!s||Object.keys(s).some(k=>!['id','capability','version','input'].includes(k))||!ident.test(s.id)||known.has(s.id))throw new WorkflowError('invalid_recipe','Invalid or duplicate step.');const c=registry.get(s.capability,s.version);checkBinding(s.input,c.input,recipe.input,known);known.set(s.id,c.output);}
  if(!known.has(recipe.result))throw new WorkflowError('invalid_recipe','Recipe result must select a step.');
  return {recipe,hash:contentHash(recipe)};
}
