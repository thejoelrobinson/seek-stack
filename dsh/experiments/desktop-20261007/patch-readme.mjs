import {readFile,writeFile} from 'node:fs/promises';
const f=new URL('../../../desktop-bridge/README.md',import.meta.url);let t=await readFile(f,'utf8');
const lines=t.split('\n');
const i3=lines.findIndex(l=>l.startsWith('Unified Electron companion'));
lines[i3]='Unified Electron companion with a task-bound local agent API, pairing with a Seek server, and the Seek host adapter. Install it on any Windows, Mac or Linux computer, pair it in Seek (Settings › Computers), and Seek can use that computer\'s apps for a task once you allow it.';
const iRem=lines.findIndex(l=>l==='## Remaining rollout work'),iDeploy=lines.findIndex(l=>l.startsWith('- Deploy the opt-in Seek tool adapter'));
lines[iDeploy]='- WebRTC screen streaming so a person can watch or take over a paired computer from the phone (control by text observations already works remotely).';
lines.splice(iRem,0,`## Pairing and remote control

In Seek, open Settings › Computers and create a pairing code (single use, ten minutes). In the companion, enter the Seek address and the code. The companion receives its own device key (stored encrypted with the OS keychain/DPAPI through Electron safeStorage; Seek keeps only a scrypt hash) and keeps one outbound WebSocket to \`/work/desktop/link\`. Nothing listens on the network: the local API stays loopback-only, and Seek's requests over the link are relayed to it, so sessions, leases, Stop and the takeover shortcut apply unchanged. Only \`/status\`, \`/heartbeat\`, \`/observe\`, \`/action\` and \`/stop\` are relayed.

A task gets a computer only after the person allows it: Seek asks "Allow on <computer>?" in the task, the Inbox and Discord, and the companion shows the same request with Allow and Not now. Answering in Seek works only for computers that opted in when pairing ("Let me approve Seek from my phone"); the setting can be changed in the companion at any time. Removing a computer in Seek closes its link at once. The proxy accepts the pairing call without a session (the code is the credential, rate-limited) and the link only with a device key, never the browser cookie.

`);
await writeFile(f,lines.join('\n'));console.log('README updated');
const w=new URL('../../../.github/workflows/desktop-bridge.yml',import.meta.url);let y=await readFile(w,'utf8');
y=y.replace('Windows selected-window fill/invoke support background operation. Wayland control and remote pairing remain unfinished.','Windows selected-window fill/invoke support background operation. Pair with Seek in Settings › Computers. Wayland control and screen streaming remain unfinished.');
await writeFile(w,y);console.log('workflow notes updated',y.includes('Settings › Computers'));
