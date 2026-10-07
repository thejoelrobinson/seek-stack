import {maskRegions} from './mirror-pixels.js';
import {CAPTURE_STALLED} from './cdp.js';
const box=q=>({x:Math.min(q[0],q[2],q[4],q[6]),y:Math.min(q[1],q[3],q[5],q[7]),w:Math.max(q[0],q[2],q[4],q[6])-Math.min(q[0],q[2],q[4],q[6]),h:Math.max(q[1],q[3],q[5],q[7])-Math.min(q[1],q[3],q[5],q[7])});
const intersect=(a,b)=>{const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.x+a.w,b.x+b.w),bottom=Math.min(a.y+a.h,b.y+b.h);return right>x&&bottom>y?{x,y,w:right-x,h:bottom-y}:null;};
const mapQuad=(q,g)=>g?q.flatMap((v,i)=>i%2?[]:(p=>[p.x,p.y])(g.point(v,q[i+1]))):q;
export async function captureIslands(m){
  const root=m.parent||m,metrics=(await root.call('Page.getLayoutMetrics')).cssVisualViewport,g=m.parent?await m.frameBridge.geometry(m):null;
  if(g&&!g.axis){root.off('islands');return;}
  const viewport=m.parent?{w:m.viewport.w,h:m.viewport.h}:{w:metrics.clientWidth,h:metrics.clientHeight},rects=[],globalRects=[];
  for(const id of m.visible){const n=m.nodes.get(id)?.node;if(!n)continue;const q=await m.quad(n).catch(()=>null);if(!q)continue;const full=box(q),local=intersect(full,{x:0,y:0,...viewport});if(!local||local.w<50||local.h<50)continue;const global=g?{x:g.q[0]+local.x*g.sx,y:g.q[1]+local.y*g.sy,w:local.w*g.sx,h:local.h*g.sy}:local,visible=intersect(global,{x:0,y:0,w:metrics.clientWidth,h:metrics.clientHeight});if(!visible)continue;const region=g?{x:(visible.x-g.q[0])/g.sx,y:(visible.y-g.q[1])/g.sy,w:visible.w/g.sx,h:visible.h/g.sy}:visible;rects.push({id,...region,full});globalRects.push(visible);}
  if(!rects.length||[...m.clients.keys()].every(ws=>ws.bufferedAmount>512*1024))return;
  const x=Math.min(...globalRects.map(r=>r.x)),y=Math.min(...globalRects.map(r=>r.y)),w=Math.max(...globalRects.map(r=>r.x+r.w))-x,h=Math.max(...globalRects.map(r=>r.y+r.h))-y,crop={x,y,w,h},sources=[root,...root.frameBridge?.children.values()||[]],hidden=[...new Set(sources.flatMap(s=>[...s.redactions,...s.secretValues.values()]))].filter(Boolean).flatMap(v=>[v,encodeURIComponent(v),JSON.stringify(v).slice(1,-1)]),secrets=[];
  for(const source of sources){if(!source.live||!source.ready)continue;const transform=source.parent?await source.frameBridge.geometry(source).catch(()=>null):null;if(source.parent&&(!transform||!intersect(box(transform.q),crop)))continue;const snap=await source.call('DOMSnapshot.captureSnapshot',{computedStyles:[]}),raw=new Map([...source.nodes.values()].map(r=>[r.node.backendNodeId,r]));
    for(const d of snap.documents)for(let i=0;i<d.layout.nodeIndex.length;i++){const at=d.layout.nodeIndex[i],text=snap.strings[d.layout.text[i]]||'',attrs=d.nodes.attributes[at]||[],sensitive=source.secretIds.has(d.nodes.backendNodeId[at])||hidden.some(v=>text.includes(v)||attrs.some(index=>(snap.strings[index]||'').includes(v)));if(!sensitive)continue;let r=raw.get(d.nodes.backendNodeId[at]);if(r?.node.nodeType===3)r=source.nodes.get(r.parent);if(!r)continue;const quad=await source.quad(r.node).catch(()=>null);if(quad)secrets.push(box(mapQuad(quad,transform)));if(secrets.length>100){secrets.length=0;secrets.push(crop);break;}}
  }
  const dpr=root.viewport.dpr||1,scale=Math.min(1,Math.sqrt(400_000/(w*h*dpr*dpr))),shot=await root.call('Page.captureScreenshot',{format:'png',clip:{x:metrics.pageX+x,y:metrics.pageY+y,width:w,height:h,scale},captureBeyondViewport:false}).catch(e=>{if(e.message!==CAPTURE_STALLED)throw e;return null;});
  // A stalled picture is skipped and the next one waits a moment; Native keeps working meanwhile.
  if(!shot){m.lastIslandAt=Date.now()+1000;return;}
  const {data}=shot,safe=maskRegions(Buffer.from(data,'base64'),crop,globalRects,secrets);if(safe.length>1024*1024)return;
  const localCrop=g?{x:(x-g.q[0])/g.sx,y:(y-g.q[1])/g.sy,w:w/g.sx,h:h/g.sy}:crop;m.broadcast({type:'mirror-islands',epoch:m.epoch,data:safe.toString('base64'),mime:'image/png',crop:localCrop,viewport,rects},false);
}
