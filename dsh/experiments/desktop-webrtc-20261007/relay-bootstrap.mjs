// Private, encrypted handoff from the browser's newly issued TURN key to the
// trusted local host. No credential is printed or written as plaintext.
import {generateKeyPairSync,privateDecrypt,createDecipheriv,constants} from 'node:crypto';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {DesktopRelay} from '../../plugins/browser-viewer/lib/work-desktop-relay.js';
import {dpapi} from '../../plugins/browser-viewer/lib/work-finance.js';

const dir=join(process.env.USERPROFILE,'.dsh/browser/backups/best-in-class-20261007-184611-105fd0ef/relay-bootstrap');
const privatePath=join(dir,'private-key.dpapi'),publicPath=join(dir,'public-key.pem'),payloadPath=join(dir,'credential.enc.json');
try{
 if(process.argv[2]==='prepare'){
  await mkdir(dir,{recursive:true});
  const pair=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{format:'pem',type:'spki'},privateKeyEncoding:{format:'pem',type:'pkcs8'}});
  await writeFile(privatePath,await dpapi('protect',pair.privateKey),{mode:0o600});
  await writeFile(publicPath,pair.publicKey,{mode:0o600});
  console.log(JSON.stringify({prepared:true,credentialStorage:'encrypted-only'}));
 }else if(process.argv[2]==='apply'){
  const input=JSON.parse(await readFile(payloadPath,'utf8'));
  if(input.version!==1)throw Error('Unknown handoff format');
  const privateKey=await dpapi('unprotect',await readFile(privatePath,'utf8'));
  const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(input.wrappedKey,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(input.nonce,'base64'));
  decipher.setAuthTag(Buffer.from(input.tag,'base64'));
  const credentials=JSON.parse(Buffer.concat([decipher.update(Buffer.from(input.data,'base64')),decipher.final()]).toString('utf8'));
  if(credentials.provider!=='cloudflare')throw Error('Unexpected provider');
  const relay=new DesktopRelay(join(process.env.USERPROFILE,'.dsh/work'),{protect:dpapi});
  const status=await relay.configure(credentials);
  console.log(JSON.stringify({saved:true,...status}));
  for(const path of [privatePath,publicPath,payloadPath])await unlink(path);
 }else if(process.argv[2]==='discard'){
  for(const path of [privatePath,publicPath,payloadPath])await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
  console.log(JSON.stringify({temporaryKeysRemoved:true}));
 }else throw Error('Choose prepare, apply, or discard');
}catch(error){console.error(JSON.stringify({saved:false,error:error.name,reason:'Relay bootstrap failed; credential details withheld'}));process.exitCode=1;}
