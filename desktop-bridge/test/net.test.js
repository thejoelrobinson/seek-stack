import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import net from 'node:net';
import {firstProxy,ConnectAgent,trustedCertificates,linkOptions} from '../src/net.js';
test('proxy specs from Chromium pick the first HTTP proxy, or direct',()=>{
  assert.deepEqual(firstProxy('PROXY proxy.corp:8080; DIRECT'),{host:'proxy.corp',port:8080,secure:false});
  assert.equal(firstProxy('DIRECT'),null);assert.equal(firstProxy('SOCKS5 s:1080; DIRECT'),null);
  assert.ok(trustedCertificates().length>=100);
});
test('links go through the proxy with CONNECT, and direct otherwise',async()=>{
  assert.equal((await linkOptions('wss://seek.example.com/x',{resolveProxy:async()=>'DIRECT'})).agent,undefined);
  const seen=[];const proxy=createServer();proxy.on('connect',(req,socket)=>{seen.push(req.url);socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');});
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  try{
    const opts=await linkOptions('wss://seek.example.com/work/desktop/link',{resolveProxy:async()=>`PROXY 127.0.0.1:${proxy.address().port}`});
    assert.ok(opts.agent instanceof ConnectAgent);
    const err=await new Promise(resolve=>opts.agent.createConnection({host:'seek.example.com',port:443,ca:opts.ca},e=>resolve(e)));
    assert.match(err.message,/refused the connection \(403\)/);assert.deepEqual(seen,['seek.example.com:443']);
  }finally{proxy.close();}
  void net;
});
