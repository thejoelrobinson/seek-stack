import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {productPalette,contrast} from '../lib/work-theme.js';
const source=await readFile(new URL('../lib/work-buddy.js',import.meta.url),'utf8');
const palettes=runInNewContext('('+source.match(/export const PALETTES = (\{[\s\S]*?\n\});/)[1]+')');
test('every mascot color produces readable controls in light and dark appearance',()=>{
 for(const [name,seed]of Object.entries(palettes))for(const dark of [false,true]){
  const p=productPalette(seed,dark),label=name+' '+(dark?'dark':'light');
  assert.ok(contrast(p['--accent'],p['--accent-text'])>=4.5,label+' primary button');
  for(const surface of ['--bg','--surface','--surface-2','--surface-3','--accent-soft','--accent-soft-2']){
   assert.ok(contrast(p['--accent-ink'],p[surface])>=4.5,label+' accent on '+surface);
   assert.ok(contrast(p['--ink'],p[surface])>=4.5,label+' body text on '+surface);
  }
  assert.ok(contrast(p['--muted'],p['--bg'])>=4.5,label+' secondary text');
 }
});
test('all seven mascot choices create distinct product palettes from the actual rig',()=>{
 assert.equal(Object.keys(palettes).length,7);
 const themes=Object.values(palettes).map(p=>productPalette(p));
 assert.equal(new Set(themes.map(x=>x['--accent'])).size,7);
 for(let i=0;i<themes.length;i++)assert.equal(themes[i]['--brand-seed'],Object.values(palettes)[i].deep);
});
