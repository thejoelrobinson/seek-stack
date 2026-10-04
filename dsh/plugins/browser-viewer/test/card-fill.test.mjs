// Real Chrome: saved-card payment fills fields from the vault after one tap, never exposes card data.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController, buildTools} from '../lib/index.js';

const NUMBER='4242424242424242',CODE='123';
let frameTyped='';
const frameServer=createServer((req,res)=>{if(req.url.startsWith('/typed')){frameTyped=new URL(req.url,'http://x').searchParams.get('v')||'';res.end('ok');return;}res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>card</title><style>html,body{margin:0;height:100%}</style><input id="all" autocomplete="off" style="box-sizing:border-box;width:100%;height:100%;border:0" oninput="fetch('/typed?v='+encodeURIComponent(this.value))">`);});
await new Promise(r=>frameServer.listen(0,'127.0.0.1',r));
const frameOrigin=`http://localhost:${frameServer.address().port}`;
const checkout=`<!doctype html><title>Checkout · Payment</title><h1>Payment</h1><p>Order total: $48.50</p>
<form><label>Name on card<input id="name" autocomplete="cc-name"></label><label>Card number<input id="num" autocomplete="cc-number" inputmode="numeric"></label>
<label>Expiry<input id="exp" autocomplete="cc-exp" placeholder="MM / YY"></label><label>CVC<input id="cvc" autocomplete="cc-csc"></label><label>Note<input id="note" name="note"></label>
<button type="button" onclick="document.title='Order placed'">Place order</button></form>`;
const hosted=`<!doctype html><title>Checkout · Payment</title><h1>Pay</h1><p>Total: $12.00</p><iframe title="Secure card payment input frame" src="${frameOrigin}/card" style="width:340px;height:60px"></iframe>`;
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url.startsWith('/hosted')?hosted:checkout);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const c=new BrowserController({headless:true,windowWidth:1100,windowHeight:800,quality:50,intervalMs:400,browserOptions:{userDataDir:await mkdtemp(join(tmpdir(),'dsh-card-test-'))}});
let secretReads=0;
c.vault={unlocked:true,cardList:()=>[{id:'card1',name:'Everyday Visa',brand:'Visa',last4:'4242',expMonth:'7',expYear:'2029'}],cardSecret:async id=>{assert.equal(id,'card1');secretReads++;return {number:NUMBER,code:CODE,expMonth:'7',expYear:'2029',cardholderName:'Joel Robinson'};}};
const fills=[];c.onCardFill=e=>fills.push(e);
const tools=new Map(buildTools(c).map(t=>[t.name,t]));
const call=async(name,args={})=>{const tool=tools.get(name),result=await tool.execute(args,{agent:{id:'session-1'}});const text=tool.output.render(args,result)[0].text;assert.equal(text.includes(NUMBER)||text.includes('424242'),false,name+' output never contains the card number');return result;};
const value=id=>c.cdp.evaluate(c.activeTabId,`document.getElementById(${JSON.stringify(id)}).value`);
try{
  await call('viewer_start',{url:base+'/checkout'});
  // 1. First call: held for one tap, nothing filled, nothing read from the vault.
  let r=await call('viewer_pay_with_card');assert.equal(r.approvalRequired,true);assert.equal(secretReads,0);
  assert.match(c.approval.label,/\$48\.50/);assert.match(c.approval.label,/Visa ••4242/);assert.equal(await value('num'),'');
  await c.decide(c.approval,'approve','always');assert.equal(c.alwaysAllow.length,0,'payments can never be approved as "always"');
  // 2. After the tap: fields filled straight from the vault; the result carries no card data.
  r=await call('viewer_pay_with_card');
  assert.deepEqual(r.filled,['number','expiry','security code','name on card']);assert.equal(r.card,'Visa ••4242');assert.equal(r.amount,48.5);
  assert.equal((await value('num')).replace(/\D/g,''),NUMBER);assert.equal((await value('exp')).replace(/\D/g,''),'0729');assert.equal(await value('cvc'),CODE);assert.equal(await value('name'),'Joel Robinson');
  assert.equal(JSON.stringify(r).includes(NUMBER),false);assert.equal(fills.length,1);assert.equal(fills[0].last4,'4242');
  // 3. The grant was single-use: another fill asks again.
  r=await call('viewer_pay_with_card');assert.equal(r.approvalRequired,true,'a second fill needs a new tap');c.approval=null;
  // 4. Snapshots redact card fields; screenshots pause; the agent cannot type into card fields.
  const snap=await call('viewer_snapshot');const fields=snap.elements.filter(e=>['input'].includes(e.tag));
  assert.ok(fields.filter(e=>/Card number|CVC|Expiry|Name on card/.test(e.text)).every(e=>e.value==='[redacted]'),'card field values are redacted');
  assert.equal(fields.find(e=>/Note/.test(e.text)).value,'','ordinary fields still read normally');
  await assert.rejects(call('viewer_screenshot'),/Screenshots are paused/);
  await assert.rejects(call('viewer_fill',{ref:fields.find(e=>/Card number/.test(e.text)).ref,text:'1111'}),/viewer_pay_with_card/);
  await call('viewer_fill',{ref:fields.find(e=>/Note/.test(e.text)).ref,text:'Leave at door'});
  // 5. Hosted card iframe from another origin (Stripe-style single field): typed through real input.
  c.cardGuard=null;await call('viewer_navigate',{url:base+'/hosted'});await new Promise(r=>setTimeout(r,500));
  r=await call('viewer_pay_with_card');assert.equal(r.approvalRequired,true);assert.match(c.approval.label,/\$12\.00/);await c.decide(c.approval,'approve','once');
  r=await call('viewer_pay_with_card');assert.deepEqual(r.filled,['number','expiry','security code']);
  await new Promise(r=>setTimeout(r,400));assert.equal(frameTyped,NUMBER+'0729'+CODE,'the cross-origin card frame received number, expiry and code');
  console.log('PASS: saved-card payment: one tap (never "always"), vault-to-form fill in page fields and a cross-origin card iframe, single-use grant, redacted snapshots, paused screenshots, card fields blocked for the agent, no card data in any tool output.');
}finally{await c.stop?.().catch(()=>{});await c.close?.().catch(()=>{});server.close();frameServer.close();}
process.exit(0);
