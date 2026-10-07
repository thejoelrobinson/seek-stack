// The sidekick is the single source of the product's color identity.
const rgb=hex=>hex.replace('#','').match(/../g).map(x=>parseInt(x,16));
const hex=channels=>'#'+channels.map(x=>Math.round(x).toString(16).padStart(2,'0')).join('');
export const mix=(a,b,weight)=>hex(rgb(a).map((v,i)=>v*(1-weight)+rgb(b)[i]*weight));
const luminance=color=>rgb(color).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
export const contrast=(a,b)=>{const values=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (values[0]+.05)/(values[1]+.05);};
function readable(color,against,toward){let result=color;for(let i=0;i<40&&contrast(result,against)<4.8;i++)result=mix(result,toward,.08);return result;}
export function productPalette(palette,dark=false){
 const seed=palette.deep,base=dark?'#17151b':'#fbfaf7',surface=dark?mix('#232127',seed,.045):'#ffffff',ink=dark?'#f0edf3':'#28232d';
 const accent=readable(seed,dark?'#201d25':'#ffffff',dark?'#ffffff':'#211b28');
 const accentInk=readable(accent,mix(surface,seed,dark?.26:.17),dark?'#ffffff':'#211b28');
 return {'--bg':mix(base,seed,dark?.018:.008),'--surface':surface,'--surface-2':mix(surface,seed,dark?.07:.038),'--surface-3':mix(surface,seed,dark?.12:.075),'--raised':mix(surface,seed,dark?.12:.075),'--ink':ink,'--ink-2':dark?'#d2cbd9':'#514956','--muted':dark?'#b1a7b9':'#706676','--muted-2':dark?'#a498ae':'#817586','--line':mix(surface,seed,dark?.28:.19),'--line-strong':mix(surface,seed,dark?.44:.32),'--accent':accent,'--accent-ink':accentInk,'--accent-text':dark?'#201d25':'#ffffff','--accent-soft':mix(surface,seed,dark?.19:.1),'--accent-soft-2':mix(surface,seed,dark?.26:.17),'--brand-seed':seed,'--brand-mid':palette.mid,'--brand-hi':palette.hi,'--focus':accent,'--ok':dark?'#a1d9b7':'#3d7658','--ok-soft':dark?'#20362b':'#edf4ee','--warn':dark?'#edc47e':'#926124','--warn-soft':dark?'#3e3020':'#fff4e4','--bad':dark?'#efaaa7':'#ab4948','--bad-soft':dark?'#3d2628':'#fff0ef','--sh-1':dark?'0 1px 3px #0003':'0 1px 3px #30213a06','--sh-2':dark?'0 8px 30px #0005':'0 8px 30px #30213a0b','--sh-3':dark?'0 24px 70px #0008':'0 24px 70px #30213a20'};
}
let currentPalette=null;
export function applyProductPalette(palette){
 currentPalette=palette;const root=document.documentElement,dark=root.dataset.appearance==='dark'||root.dataset.appearance==='system'&&matchMedia('(prefers-color-scheme:dark)').matches;
 for(const [name,value]of Object.entries(productPalette(palette,dark)))root.style.setProperty(name,value);
 root.dataset.colorMode=dark?'dark':'light';document.querySelector('meta[name="theme-color"]')?.setAttribute('content',palette.deep);
}
export function refreshProductPalette(){if(currentPalette)applyProductPalette(currentPalette);}
