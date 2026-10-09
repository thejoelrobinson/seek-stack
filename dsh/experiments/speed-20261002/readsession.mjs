import zlib from 'node:zlib';
import {readFileSync} from 'node:fs';
// Session logs are thousands of concatenated zstd frames (one per append).
export function readSession(file){
  const b=readFileSync(file),pos=[];
  for(let i=0;i<b.length-3;i++)if(b[i]===0x28&&b[i+1]===0xb5&&b[i+2]===0x2f&&b[i+3]===0xfd)pos.push(i);
  pos.push(b.length);
  const events=[];let start=0;
  for(let k=1;k<pos.length;k++){
    let text;try{text=zlib.zstdDecompressSync(b.subarray(pos[start],pos[k])).toString('utf8');}catch{continue;}
    start=k;
    for(const l of text.split('\n'))if(l.trim()){try{events.push(JSON.parse(l));}catch{}}
  }
  return events;
}
if(process.argv[1]?.endsWith('readsession.mjs')&&process.argv[2]){
  const events=readSession(process.argv[2]);
  const types={};for(const e of events){const k=e.type;types[k]=(types[k]||0)+1;}
  console.log(events.length,types);
  for(const e of events.slice(1,6))console.log(JSON.stringify(e).slice(0,500));
}
