import {createRequire} from 'node:module';
const require=createRequire('C:/Users/Joel Robinson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const b=await chromium.launch({channel:'chrome',headless:true}),p=await b.newPage({viewport:{width:760,height:300}});
const css=`
.a{font-family:"Segoe UI Variable Text";font-size:13px}
.b{font-family:"Segoe UI Variable Text";font-size:13px;text-rendering:optimizeLegibility}
.c{font-family:"Segoe UI Variable Text";font-size:13px;font-feature-settings:"kern","calt"}
.d{font-family:"Segoe UI Variable Text";font-size:15px}
.e{font-family:"Segoe UI Variable Text";font-size:15px;text-rendering:optimizeLegibility;font-feature-settings:"kern","calt"}
.f{font-family:"Segoe UI Variable Display";font-size:15px}
.g{font-family:"Segoe UI";font-size:15px}
.h{font-family:"Segoe UI Variable Text";font-size:15px;-webkit-font-smoothing:antialiased}
.i{font-family:"Segoe UI Variable";font-size:15px}
.j{font-family:system-ui;font-size:15px}`;
await p.setContent(`<style>body{margin:10px}${css}</style>${[...'abcdefghij'].map(c=>`<div class="${c}">${c}: missing distinct item finish 114</div>`).join('')}`);
await p.screenshot({path:'after/fonttest.png'});await b.close();
