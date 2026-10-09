// Read-only audit probe: all browser operations are in-memory mocks.
import assert from 'node:assert/strict';
import {buildTools} from '../../plugins/browser-viewer/lib/agent-tools.js';

async function probe(name, args, {label='Send message', checkout=false}={}) {
  const observed={name,approvals:0,actions:0};
  const c={paused:false,running:false,enqueue:fn=>fn(),sendStatus(){},sendError(){},
    _refreshStatus:async()=>{},_activeTab:async()=>'mock-tab',settle:async()=>{},
    snapshot:async()=>({title:'Mock page',url:'https://audit.example/compose',elements:[],text:'',note:'',scroll:{},count:0}),
    consumeGrant:()=>false,requestApproval:async()=>{observed.approvals++;},
    click:async()=>{observed.actions++;},press:async()=>{observed.actions++;},
    cdp:{evaluate:async(_tab,expression)=>{
      if(expression==='location.href')return 'https://audit.example/compose';
      if(expression==='document.title')return 'Mock page';
      if(expression.includes('const buttonLike'))return {buttonLike:true,label};
      if(expression.includes('place.?order'))return checkout;
      return false;
    }}
  };
  const tool=buildTools(c).find(t=>t.name===name);
  await tool.execute(args,{agent:{id:'mock-session'}});
  return observed;
}
const results=[
  await probe('viewer_click',{ref:'mock-ref'}),
  await probe('viewer_click',{x:100,y:100}),
  await probe('viewer_click',{ref:'mock-ref'},{label:'Send message '+ 'x'.repeat(80)}),
  await probe('viewer_click',{ref:'mock-ref'},{label:''}),
  await probe('viewer_key',{key:'Enter'}),
  await probe('viewer_key',{key:'Control+Enter'},{checkout:true}),
];
assert.equal(results[0].approvals,1,'Positive control must request approval.');
assert.equal(results[0].actions,0,'Positive control must hold the mock action.');
for(const result of results.slice(1)){assert.equal(result.approvals,0);assert.equal(result.actions,1);}
process.stdout.write(JSON.stringify({scope:'Mock browser only; no network, real browser, external action, or app state mutation.',results},null,2)+'\n');
