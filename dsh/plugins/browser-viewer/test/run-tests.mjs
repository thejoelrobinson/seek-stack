import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const suites=['markdown','page-outline','purchases','receipt-batch','work-performance','work-model-integration','work-engine','extras','work-images','reliability','assets','ui-regression','model-progression','buddy-model-animation','image-sampling','image-preview','model-switching','work-foundations','work-product','work-product-ui','image-reliability','image-studio','authority','connector-actions','proxy-auth','browser-authority','tool-policy','library-search','branch','progress','security-log','finance-answers','outcome-paths','tool-scope','autonomy','summarizer-shim','effort','reflection','memory','growth','fastpath'];
suites.push('mirror','editorial-theme','calendar-ical','calendar-store','calendar-caldav','calendar-proxy','desktop-link','desktop-proxy','desktop-relay');
const child=spawn(process.execPath,['--import','./test/register-profile.mjs','--test',...suites.map(x=>'test/'+x+'.test.mjs')],{cwd:root,stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
