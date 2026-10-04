import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,realpath,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {LibrarySearch,artifactText,excerpt} from '../lib/work-library-search.js';

test('Library content search reads recorded text artifacts only, strips markup and refreshes on change',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'seek-library-'));
 await writeFile(join(cwd,'notes.md'),'# Trip\nRemember the passport and the charger.');
 await writeFile(join(cwd,'page.html'),'<style>.passport{}</style><p>Gate <b>B12</b> boards at noon</p><script>passport()</script>');
 await writeFile(join(cwd,'photo.png'),'passport');
 await writeFile(join(cwd,'unlisted.md'),'passport secret');
 const engine={store:{tasks:[{id:'t1',artifacts:[{id:'a',path:'notes.md'},{id:'b',path:'page.html'},{id:'c',path:'photo.png'},{id:'d',path:'../escape.md'}]}]},
  async file(t,path){const base=await realpath(cwd),full=await realpath(resolve(cwd,path));const rel=relative(base,full);if(rel.startsWith('..'))throw new Error('outside');return {full,path:rel};}};
 const search=new LibrarySearch(engine);
 assert.deepEqual((await search.search('passport')).hits.map(h=>h.id),['a'],'binary, unlisted and escaping paths are never read');
 assert.deepEqual((await search.search('gate b12')).hits.map(h=>h.id),['b']);
 assert.equal((await search.search('passport()')).hits.length,0,'script bodies are not indexed');
 assert.equal((await search.search('x')).hits.length,0,'single characters do not scan');
 await new Promise(r=>setTimeout(r,20));await writeFile(join(cwd,'notes.md'),'Updated: bring sunscreen.');
 assert.equal((await search.search('passport')).hits.length,0);assert.equal((await search.search('sunscreen')).hits[0].id,'a');
 assert.equal(artifactText('<p>a&amp;b</p>','.html'),'a&b');
 assert.equal(excerpt('x'.repeat(400)+'needle'+'y'.repeat(400),'needle').length<=182,true);
});
