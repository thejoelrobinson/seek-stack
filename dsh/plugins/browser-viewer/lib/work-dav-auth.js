// Device passwords for CalDAV. Apple Calendar and Reminders sign in with HTTP Basic, which the
// cookie login can't serve, so each phone or Mac gets its own generated password that works only
// for /work/dav and can be revoked on its own. Only scrypt hashes are stored; the proxy reads
// the same file (seek-stack/dsh/proxy/server.js) to check them.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';

export const DAV_USER='seek';
export const DAV_SCRYPT={N:16384,r:8,p:1};
const ALPHABET='abcdefghijkmnpqrstuvwxyz23456789';
/** 20 characters in four groups (~100 bits), easy to type on a phone if needed. */
export function generatePassword(){const bytes=randomBytes(20);let s='';for(let i=0;i<20;i++){s+=ALPHABET[bytes[i]%ALPHABET.length];if(i%5===4&&i<19)s+='-';}return s;}
export const hashPassword=(password,salt)=>scryptSync(password,salt,32,DAV_SCRYPT).toString('hex');

export class DavDevices{
  constructor(root){this.root=root;this.file=join(root,'caldav-devices.json');}
  async read(){try{const data=JSON.parse(await readFile(this.file,'utf8'));return Array.isArray(data.devices)?data:{version:1,devices:[]};}catch(e){if(e.code==='ENOENT')return {version:1,devices:[]};throw e;}}
  async write(data){await mkdir(this.root,{recursive:true});const tmp=this.file+'.tmp';await writeFile(tmp,JSON.stringify(data),{mode:0o600});await rename(tmp,this.file);}
  async list(){return (await this.read()).devices.map(({id,name,created})=>({id,name,created}));}
  /** Creates a device and returns its password once; it is never stored or shown again. */
  async create(name){
    const label=String(name||'').trim().slice(0,60)||'Apple device';
    const data=await this.read();if(data.devices.length>=20)throw new Error('Remove a device before adding another (20 at most).');
    const password=generatePassword(),salt=randomBytes(16);
    const device={id:randomUUID(),name:label,created:Date.now(),salt:salt.toString('hex'),hash:hashPassword(password,salt)};
    data.devices.push(device);await this.write(data);
    return {id:device.id,name:label,created:device.created,username:DAV_USER,password};
  }
  async revoke(id){const data=await this.read();const before=data.devices.length;data.devices=data.devices.filter(d=>d.id!==id);if(data.devices.length===before)throw new Error('That device is already removed.');await this.write(data);return {removed:true};}
}

const xml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
/**
 * A configuration profile that adds the CalDAV account on iPhone, iPad or Mac in one tap.
 * Calendar shows the "Seek" calendar and Reminders the "Seek To-dos" list from this account.
 */
export function mobileconfig({host,password,deviceName}){
  const id=randomUUID().toUpperCase(),payload=randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>CalDAVAccountDescription</key><string>Seek</string>
<key>CalDAVHostName</key><string>${xml(host)}</string>
<key>CalDAVPort</key><integer>443</integer>
<key>CalDAVPrincipalURL</key><string>/work/dav/principal/</string>
<key>CalDAVUseSSL</key><true/>
<key>CalDAVUsername</key><string>${DAV_USER}</string>
<key>CalDAVPassword</key><string>${xml(password)}</string>
<key>PayloadDescription</key><string>Your shared calendar and to-dos with Seek</string>
<key>PayloadDisplayName</key><string>Seek Calendar &amp; To-dos</string>
<key>PayloadIdentifier</key><string>com.seek.caldav.${payload}</string>
<key>PayloadType</key><string>com.apple.caldav.account</string>
<key>PayloadUUID</key><string>${payload}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></array>
<key>PayloadDescription</key><string>Adds the Seek calendar to Calendar and the Seek To-dos list to Reminders on ${xml(deviceName)}. Remove it any time in Settings › General › VPN &amp; Device Management.</string>
<key>PayloadDisplayName</key><string>Seek Calendar &amp; To-dos</string>
<key>PayloadIdentifier</key><string>com.seek.calendar.${id}</string>
<key>PayloadOrganization</key><string>Seek</string>
<key>PayloadRemovalDisallowed</key><false/>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>${id}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>
`;
}
