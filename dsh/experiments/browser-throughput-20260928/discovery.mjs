import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {PlaywrightCrawler} from '@crawlee/playwright';
import {Configuration,log} from '@crawlee/core';
const hits=[],found=[];
const server=createServer((req,res)=>{const u=new URL(req.url,'http://fixture');hits.push(u.pathname+u.search);if(u.pathname==='/robots.txt'){res.end('User-agent: *\nDisallow: /private\n');return;}res.setHeader('Content-Type','text/html');const n=Number(u.searchParams.get('page')||1);res.end(`<title>Catalog ${n}</title><main data-page="${n}">Record ${n}</main><a href="/catalog?page=${n}&utm_source=repeat#top">Duplicate</a><a href="/catalog?page=1">First</a>${n<3?`<a rel="next" href="/catalog?page=${n+1}">Next</a>`:''}<a href="/private">Private</a><a href="https://out-of-scope.invalid/">Outside scope</a>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
log.setLevel(log.LEVELS.ERROR);
try{
 const crawler=new PlaywrightCrawler({maxConcurrency:2,minConcurrency:2,maxRequestsPerCrawl:8,maxCrawlDepth:3,maxRequestRetries:0,maxSessionRotations:0,useSessionPool:false,retryOnBlocked:false,respectRobotsTxtFile:true,browserPoolOptions:{useFingerprints:false},launchContext:{useIncognitoPages:true,launchOptions:{channel:'chrome',headless:true}},async requestHandler({page,request,enqueueLinks}){found.push({url:request.url,page:Number(await page.locator('main').getAttribute('data-page'))});await enqueueLinks({strategy:'same-origin',transformRequestFunction:r=>{const u=new URL(r.url);if(u.pathname!=='/catalog')return false;u.hash='';u.searchParams.delete('utm_source');r.url=u.href;r.uniqueKey=u.href;return r;}});}},new Configuration({persistStorage:false,purgeOnStart:true}));
 await crawler.run([base+'/catalog?page=1']);
 assert.deepEqual(found.map(r=>r.page).sort(),[1,2,3]);assert.equal(hits.filter(x=>x.startsWith('/catalog')).length,3);assert.ok(!hits.some(x=>x.startsWith('/private')));
 const result={found,hits,allThreePages:true,noDuplicateFetches:true,inScopeOnly:true};await writeFile(new URL('./results/discovery.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
