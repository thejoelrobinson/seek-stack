import {inflateSync,deflateSync} from 'node:zlib';
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc=b=>{let c=0xffffffff;for(const v of b)c=table[(c^v)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
function chunk(type,data){const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);out.writeUInt32BE(crc(out.subarray(4,out.length-4)),out.length-4);return out;}
export function encodePNG(w,h,rgba){const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=6;const scan=Buffer.alloc(h*(w*4+1));for(let y=0;y<h;y++)rgba.copy(scan,y*(w*4+1)+1,y*w*4,(y+1)*w*4);return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(scan,{level:3})),chunk('IEND',Buffer.alloc(0))]);}
export function decodePNG(png){let w,h,channels;const parts=[];for(let at=8;at+12<=png.length;){const len=png.readUInt32BE(at),type=png.toString('ascii',at+4,at+8),data=png.subarray(at+8,at+8+len);if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);channels=data[9]===2?3:data[9]===6?4:0;if(data[8]!==8||!channels||data[12]||w*h>2_000_000)throw new Error('Unsupported region bitmap');}if(type==='IDAT')parts.push(data);at+=len+12;}if(!w||!h)throw new Error('Missing bitmap');const stride=w*channels,scan=inflateSync(Buffer.concat(parts),{maxOutputLength:(stride+1)*h}),raw=Buffer.alloc(w*h*channels),rgba=Buffer.alloc(w*h*4);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<h;y++){const filter=scan[y*(stride+1)];if(filter>4)throw new Error('Unsupported bitmap filter');for(let x=0;x<stride;x++){const at=y*stride+x,a=x>=channels?raw[at-channels]:0,b=y?raw[at-stride]:0,c=y&&x>=channels?raw[at-stride-channels]:0;raw[at]=(scan[y*(stride+1)+1+x]+(filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):0))&255;}}for(let i=0;i<w*h;i++){raw.copy(rgba,i*4,i*channels,i*channels+3);rgba[i*4+3]=channels===4?raw[i*channels+3]:255;}return {w,h,rgba};
}
// No pixels outside the requested regions leave the host. Sensitive fields and
// reflected secret text are also removed, including gaps within a union capture.
export function maskRegions(png,crop,allowed,secrets){const {w,h,rgba}=decodePNG(png),out=Buffer.alloc(w*h*4),kx=w/crop.w,ky=h/crop.h;
  const box=r=>({x:Math.max(0,Math.floor((r.x-crop.x)*kx)),y:Math.max(0,Math.floor((r.y-crop.y)*ky)),right:Math.min(w,Math.ceil((r.x+r.w-crop.x)*kx)),bottom:Math.min(h,Math.ceil((r.y+r.h-crop.y)*ky))});
  for(const r of allowed.map(box))for(let y=r.y;y<r.bottom;y++)if(r.right>r.x)rgba.copy(out,(y*w+r.x)*4,(y*w+r.x)*4,(y*w+r.right)*4);
  for(const r of secrets.map(box))for(let y=r.y;y<r.bottom;y++)if(r.right>r.x)out.fill(0,(y*w+r.x)*4,(y*w+r.right)*4);return encodePNG(w,h,out);
}
