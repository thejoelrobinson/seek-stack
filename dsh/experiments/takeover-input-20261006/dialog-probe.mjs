// Does CdpBrowser report page dialogs and file choosers through onDialog/onFileChooser?
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {CdpBrowser}=await import('file:///C:/Users/Joel%20Robinson/seek-stack/dsh/plugins/browser-viewer/lib/cdp.js');
const b=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-dialog-probe-'))});
await b.launch();const events=[];b.onDialog=(t,p)=>events.push(['dialog',p&&p.type,p&&p.message]);b.onFileChooser=(t,p)=>events.push(['file',p.mode]);
const tab=await b.newTab('data:text/html,<input type=file id=f><button id=b onclick="alert(42)">x</button>');const sid=b.tabs.get(tab);
b.onEvent(sid,'Page.javascriptDialogOpening',p=>events.push(['raw',p.type]));
await b.send('Runtime.evaluate',{expression:"setTimeout(()=>alert('hi'),50)"},sid);
await new Promise(r=>setTimeout(r,800));console.log(JSON.stringify(events));
await b.send('Page.handleJavaScriptDialog',{accept:true},sid).catch(e=>console.log('handle',e.message));
await new Promise(r=>setTimeout(r,300));console.log(JSON.stringify(events));
await b.close();
