from pathlib import Path
base=Path(__file__).resolve().parents[2]/'plugins'/'browser-viewer'/'lib'
p=base/'work-finance-client.js'
t=p.read_text(encoding='utf-8')
start=t.index('function transactions(){');end=t.index('function budgets(){',start)
section=t[start:end].replace('drillLoading||activityLoading&&!drill','activityLoading').replace('drillError||activityError&&!drill','activityError').replace('esc(drillError||activityError)','esc(activityError)').replace('list.length','totalCount').replace('cashExact(total)',"totalLabel||'—'")
t=t[:start]+section+t[end:]
t=t.replace("window.SeekFinance={render,refresh:()=>load(true)};", "window.SeekFinance={render,refresh:()=>load(true),activate:()=>load(false)};")
t=t.replace("load();setInterval(()=>{if(document.visibilityState==='visible')void load(false);},60000);", "setInterval(()=>{if(document.visibilityState==='visible'&&document.querySelector('nav [data-view=\"finance\"].active'))void load(false);},60000);")
t=t.replace("if(signature===sig&&root.querySelector('.finance'))return;", "if(signature===sig&&root.querySelector('.finance'))return;")
t=t.replace('budgetError,categoryStatus]);','budgetError,categoryStatus,transactionResult]);')
lines=t.splitlines()
for index,line in enumerate(lines):
    if line.startswith('  root.innerHTML=`<section class="finance">'):
        line=line.replace('root.innerHTML=','preserveHTML(root,').replace('class="fin-nav" role="tablist"','class="fin-nav" role="tablist" data-tabs="finance"')
        line=line.replace('</div>${!status.connected?setup()', '</div><div id="finance-panel">${!status.connected?setup()')
        assert line.endswith(';</section>`;') is False
        line=line.replace(":''}</section>`;", ":''}</div></section>`);")
        assert line.endswith('`);'),line[-100:]
        lines[index]=line+"\n  const search=root.querySelector('[data-fin-query]'),select=root.querySelector('[data-fin-filter]');if(search&&search.value!==query)search.value=query;if(select)select.value=filter;"
t='\n'.join(lines)+'\n'
t=t.replace("try{const params=new URLSearchParams({from,to});if(category)params.set('category',category);drillRows=await allTransactions(params);}", "try{await loadActivity(true);}")
t=t.replace("sig='';render();root.querySelector('.fin-v2-transactions')?.scrollIntoView", "sig='';void loadActivity(true);root.querySelector('.fin-v2-transactions')?.scrollIntoView")
t=t.replace("query=e.target.value;transactionPage=0;sig='';render();const i=root.querySelector('[data-fin-query]');i?.focus();i?.setSelectionRange(query.length,query.length);", "query=e.target.value;transactionPage=0;clearTimeout(searchTimer);searchTimer=setTimeout(()=>void loadActivity(true),200);")
t=t.replace("filter=e.target.value;transactionPage=0;sig='';render();", "filter=e.target.value;transactionPage=0;void loadActivity(true);")
t=t.replace("query=e.target.value;transactionPage=0;sig='';render();", "query=e.target.value;transactionPage=0;clearTimeout(searchTimer);void loadActivity(true);")
p.write_text(t,encoding='utf-8')

p=base/'work-images-client.js';t=p.read_text(encoding='utf-8')
t="import {request,preserveHTML} from '/work/runtime.js';\n"+t
start=t.index('const api=async');end=t.index('const toast=',start)
t=t[:start]+"const api=(path,body)=>request('/qwen-image/api/'+path,body,{timeoutMs:body&&path==='generate'?900000:15000});\n"+t[end:]
t=t.replace("let data=null,status=null,busy=false,sig='';","let data=null,status=null,busy=false,sig='',loading=false;")
t=t.replace("async function load(){try{", "async function load(){if(loading)return;loading=true;try{").replace("catch(error){status={available:false,error:error.message};}}", "catch(error){status={available:false,error:error.message};toast(error.message);}finally{loading=false;}}")
t=t.replace('main.innerHTML=`<section class="images">','preserveHTML(main,`<section class="images">').replace('${gallery()}`;}', '${gallery()}`);}')
t=t.replace('<img src="${item.url}"', '<img loading="lazy" decoding="async" src="${item.url}"')
t=t.replace("window.SeekImages={render,refresh:load};load();setInterval(()=>{if(document.visibilityState==='visible')void load();},10_000);", "window.SeekImages={render,refresh:load,activate:load};setInterval(()=>{if(document.visibilityState==='visible'&&document.querySelector('nav [data-view=\"images\"].active'))void load();},10_000);")
p.write_text(t,encoding='utf-8')
