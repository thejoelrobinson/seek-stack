// Snaps font sizes and weights in the feature stylesheets onto the Seek type scale.
// Sizes: 12 13 14 15 17 20 28 34. Weights: 400 500 600. Sub-9px glyph sizes are decoration and stay.
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
const lib=new URL('../../plugins/browser-viewer/lib/',import.meta.url),backup=new URL('./source-before/type/',import.meta.url);
const FILES=['work-finance.css','work-finance-v2.css','work-growth.css','work-dreaming.css','work-images.css','work-model.css'];
export const snapSize=px=>px<9?px:px<12.5?12:px<13.5?13:px<14.5?14:px<16?15:px<18.5?17:px<23.5?20:px<31?28:34;
export const snapWeight=w=>w<450?400:w<=550?500:600;
const size=v=>v.replace(/(\d+(?:\.\d+)?)px/g,(m,n)=>snapSize(Number(n))+'px');
await mkdir(backup,{recursive:true});
for(const file of FILES){
 await copyFile(new URL(file,lib),new URL(file,backup));
 let text=await readFile(new URL(file,lib),'utf8'),changes=0;
 const count=(a,b)=>{if(a!==b)changes++;return b;};
 text=text.replace(/font-size:([^;}]+)/g,(m,v)=>count(m,'font-size:'+(/clamp\(/.test(v)?v.replace(/clamp\(([^,]+),([^,]+),([^)]+)\)/,(c,a,mid,b)=>`clamp(${size(a)},${mid},${size(b)})`):size(v))));
 text=text.replace(/font-weight:\s*(\d{3})/g,(m,w)=>count(m,'font-weight:'+snapWeight(Number(w))));
 // font shorthand: "font:650 12px/1.4 ..." → snap its weight and size
 text=text.replace(/font:\s*(\d{3})\s+(\d+(?:\.\d+)?)px/g,(m,w,s)=>count(m,`font:${snapWeight(Number(w))} ${snapSize(Number(s))}px`));
 await writeFile(new URL(file,lib),text);console.log(file,changes,'changes');
}
