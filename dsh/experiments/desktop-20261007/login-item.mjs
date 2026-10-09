import {createRequire} from 'node:module';
const require=createRequire('C:/Users/Joel Robinson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const browser=await chromium.connectOverCDP('http://127.0.0.1:9333');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().endsWith('panel.html'));
await page.waitForFunction(()=>/Connected to/.test(document.querySelector('#link-body')?.textContent||''),null,{timeout:20000});
const box=page.locator('#link-body label.check', {hasText:'Start Seek Desktop with this computer'}).locator('input');
await page.waitForTimeout(500);if(!(await box.isChecked()))await box.check();await page.waitForTimeout(500);
console.log('version',await page.evaluate(()=>document.querySelector('#details')?.textContent.length>0),'| start with computer:',await box.isChecked(),'|',(await page.textContent('#link-body')).slice(0,90));
await browser.close();
