// Same-prompt decode/prefill benchmark against a llama-server endpoint.
// Usage: node engine-bench.mjs <label> [baseUrl=http://127.0.0.1:18798] [model=qwen3.8-27b]
import {readFileSync,appendFileSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const [label='run',base='http://127.0.0.1:18798',model='qwen3.8-27b']=process.argv.slice(2);
const here=dirname(fileURLToPath(import.meta.url));
// ~24K tokens of real prose: the repo's own docs, repeated to length.
const docs=readdirSync(join(here,'..','best-in-class-audit-20261001')).filter(f=>f.endsWith('.md')).map(f=>readFileSync(join(here,'..','best-in-class-audit-20261001',f),'utf8')).join('\n\n');
let long='';while(long.length<95000)long+=docs+'\n\n';long=long.slice(0,95000);
const cases=[
 {name:'short-answer',messages:[{role:'user',content:'Explain in about 600 words how a home refrigerator moves heat out of the food compartment. Plain prose, no lists.'}],max:900},
 {name:'long-context',messages:[{role:'user',content:'Document:\n'+long+'\n\nSummarize the three most important unfinished items in this document in about 300 words.'}],max:600},
];
for(const c of cases){
  const nonce='Run '+Date.now()+'-'+Math.random().toString(36).slice(2)+'.\n';// defeats the prompt cache so prefill is measured
  const body={model,messages:[{role:'system',content:nonce+'You are a concise assistant.'},...c.messages],max_tokens:c.max,temperature:0.7,top_p:0.95,top_k:20,seed:42,reasoning_effort:'low',stream:false};
  const t0=Date.now();const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();const wall=(Date.now()-t0)/1000;
  if(!r.ok){console.log(c.name,'ERROR',JSON.stringify(j).slice(0,300));continue;}
  const t=j.timings||{};
  const row={label,case:c.name,promptTokens:t.prompt_n,prefillTokS:+(t.prompt_per_second||0).toFixed(1),genTokens:t.predicted_n,decodeTokS:+(t.predicted_per_second||0).toFixed(1),draftAccept:t.draft_n?+(t.draft_n_accepted/t.draft_n).toFixed(2):null,wallS:+wall.toFixed(1)};
  console.log(JSON.stringify(row));appendFileSync(join(here,'engine-bench.jsonl'),JSON.stringify({at:new Date().toISOString(),...row})+'\n');
}
