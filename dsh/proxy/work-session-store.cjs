const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const valid=value=>value?.version===1&&Number.isInteger(value.ownerVersion)&&Array.isArray(value.sessions)&&value.sessions.every(x=>typeof x.id==='string'&&['owner','partner'].includes(x.identity)&&Number.isSafeInteger(x.expiresAt));
class SessionStore {
  constructor(file,{secret,credentialsDigest,now=()=>Date.now()}={}){
    this.file=file;this.secret=secret;this.now=now;this.data={version:1,ownerVersion:0,credentialsDigest,sessions:[]};
    fs.mkdirSync(path.dirname(file),{recursive:true});
    let original;try{original=fs.readFileSync(file,'utf8');const value=JSON.parse(original);if(!valid(value))throw new Error('Invalid session store');this.data=value;}
    catch(error){if(error.code!=='ENOENT'){let parsed;try{parsed=JSON.parse(original);}catch{}if(parsed?.version>1)throw new Error('Session history uses a newer format; original files were preserved.');let backup;try{backup=JSON.parse(fs.readFileSync(file+'.bak','utf8'));}catch{}if(!valid(backup))throw new Error('Session history is unreadable; original files were preserved.');if(original!==undefined)fs.writeFileSync(file+'.corrupt-'+this.now(),original,{mode:0o600});this.data=backup;}}
    if(this.data.credentialsDigest&&this.data.credentialsDigest!==credentialsDigest){this.data.ownerVersion++;for(const session of this.data.sessions)if(session.identity==='owner')session.revokedAt=this.now();}
    this.data.credentialsDigest=credentialsDigest;this.save();
  }
  save(){const payload=JSON.stringify(this.data),temporary=this.file+'.tmp';let previous;try{previous=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{}if(valid(previous))fs.copyFileSync(this.file,this.file+'.bak');const fd=fs.openSync(temporary,'w',0o600);try{fs.writeFileSync(fd,payload);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,this.file);}
  id(token){return 'legacy-'+crypto.createHmac('sha256',this.secret).update(token).digest('hex').slice(0,32);}
  create(identity,expiresAt,details={}){const session={id:crypto.randomUUID(),identity,createdAt:this.now(),lastSeenAt:this.now(),expiresAt,label:String(details.label||details.userAgent||'Seek browser').replace(/[\r\n]/g,' ').slice(0,180)};this.data.sessions.push(session);this.save();return session.id;}
  accept({id,identity,expiresAt,version,token}){
    if(identity==='owner'&&version!==this.data.ownerVersion)return false;
    id||=this.id(token);let session=this.data.sessions.find(x=>x.id===id);
    if(!session){if(!id.startsWith('legacy-'))return false;session={id,identity,createdAt:this.now(),lastSeenAt:this.now(),expiresAt,label:'Existing Seek browser'};this.data.sessions.push(session);this.save();}
    if(session.identity!==identity||session.revokedAt||session.expiresAt<=this.now()||expiresAt!==session.expiresAt)return false;
    if(this.now()-session.lastSeenAt>300000){session.lastSeenAt=this.now();this.save();}return true;
  }
  revoke(id){const session=this.data.sessions.find(x=>x.id===id);if(!session)throw new Error('That device session does not exist.');session.revokedAt=this.now();this.save();return session;}
  revokeOthers(current){let count=0;for(const session of this.data.sessions)if(session.id!==current&&!session.revokedAt&&session.expiresAt>this.now()){session.revokedAt=this.now();count++;}this.save();return count;}
  revokeIdentity(identity){const ids=[];for(const session of this.data.sessions)if(session.identity===identity&&!session.revokedAt){session.revokedAt=this.now();ids.push(session.id);}this.save();return ids;}
  list(current){return this.data.sessions.filter(x=>!x.revokedAt&&x.expiresAt>this.now()).map(x=>({id:x.id,identity:x.identity,label:x.label,createdAt:x.createdAt,lastSeenAt:x.lastSeenAt,expiresAt:x.expiresAt,current:x.id===current}));}
}
module.exports={SessionStore};
