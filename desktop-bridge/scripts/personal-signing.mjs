// One persistent local code-signing identity for the owner's Mac. No Apple membership required.
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
if(process.platform!=='darwin')throw Error('Run signing:setup on the Mac that builds Seek Desktop');
const name='Seek Desktop Personal';
function run(program,args,env=process.env){const r=spawnSync(program,args,{encoding:'utf8',env});if(r.error||r.status!==0)throw Error(`${program} failed. Check Keychain access and try again.`);return r.stdout.trim();}
const identities=run('/usr/bin/security',['find-identity','-v','-p','codesigning']);
if(identities.includes('"'+name+'"'))console.log('Existing persistent identity is ready: '+name);
else {
 const directory=await mkdtemp(join(tmpdir(),'seek-signing-'));
 try{
  const key=join(directory,'identity.key'),cert=join(directory,'identity.pem'),bundle=join(directory,'identity.p12'),config=join(directory,'openssl.cnf');
  await writeFile(config,'[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=signing\n[subject]\nCN=Seek Desktop Personal\n[signing]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n',{mode:0o600});
  const keychain=run('/usr/bin/security',['default-keychain','-d','user']).replace(/^"|"$/g,'');
  const existing=spawnSync('/usr/bin/security',['find-certificate','-c',name,'-p',keychain],{encoding:'utf8'});
  if(existing.status===0&&existing.stdout.includes('BEGIN CERTIFICATE'))await writeFile(cert,existing.stdout,{mode:0o600});
  else {
   run('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','3650','-config',config,'-keyout',key,'-out',cert]);
   const password=randomBytes(32).toString('hex');
   run('/usr/bin/openssl',['pkcs12','-export','-inkey',key,'-in',cert,'-name',name,'-out',bundle,'-passout','env:SEEK_PERSONAL_CERT_PASSWORD'],{...process.env,SEEK_PERSONAL_CERT_PASSWORD:password});
   run('/usr/bin/security',['import',bundle,'-k',keychain,'-P',password,'-T','/usr/bin/codesign']);
  }
  run('/usr/bin/security',['add-trusted-cert','-r','trustRoot','-p','codeSign','-k',keychain,cert]);
  if(!run('/usr/bin/security',['find-identity','-v','-p','codesigning']).includes('"'+name+'"'))throw Error('Open Keychain Access and trust Seek Desktop Personal for Code Signing, then run signing:setup again.');
  console.log('Persistent personal code-signing certificate installed in your Keychain (10-year validity). Keep this identity for future builds.');
 }finally{await rm(directory,{recursive:true,force:true});}
}
console.log('Build with: SEEK_MAC_SIGNING_IDENTITY="Seek Desktop Personal" npm run build');
