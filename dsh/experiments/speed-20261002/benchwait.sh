#!/bin/sh
# Usage: benchwait.sh <taskId> <outputFile>
id="$1"; out="$2"
for i in $(seq 1 90); do
  s=$(curl -s "http://127.0.0.1:3080/work/api/task?id=$id" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d);console.log(t.status)})")
  case "$s" in complete|attention|stopped|waiting) break;; esac
  sleep 10
done
echo "status: $s"
[ -n "$out" ] && cat "/c/Users/Joel Robinson/.dsh/work/tasks/$id/$out" 2>/dev/null
cd "$(dirname "$0")"
f=$(find "/c/Users/Joel Robinson/.dsh/sessions" -path "*$id*" -name "*.zstd" | head -1)
node --input-type=module -e "
import {readSession} from './readsession.mjs';
const ev=readSession(process.argv[1]);const t=ev.filter(e=>e.time).map(e=>e.time);
const calls=ev.filter(e=>e.type==='tool/call');const reason=ev.filter(e=>e.type==='reasoning-chunks').reduce((a,e)=>a+e.data.texts.join('').length,0);
const sig=new Map();for(const c of calls){const k=c.data.name+c.data.arguments;sig.set(k,(sig.get(k)||0)+1);}
console.log(JSON.stringify({wallS:Math.round((Math.max(...t)-Math.min(...t))/1000),steps:ev.filter(e=>e.type==='step/start').length,calls:calls.length,dupes:[...sig.values()].reduce((a,n)=>a+n-1,0),compactions:ev.filter(e=>e.type==='compaction/start').length,reasoningChars:reason}));
console.log(calls.map(c=>c.data.name).join(' > '));" "$f"
