import {readFile, writeFile, copyFile, rename, stat, mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
const source = resolve(import.meta.dirname, '../../../desktop-bridge/dist/mac-preview-7e78983/verified/dist');
const target = join(process.env.USERPROFILE, '.dsh/work/downloads');
const manifestFile = join(target, 'manifest.json');
const previousText = await readFile(manifestFile, 'utf8');
const manifest = JSON.parse(previousText);
if (manifest.version !== '0.4.0' || manifest.files.filter(f => f.os === 'darwin').length !== 2) throw Error('Unexpected live download manifest');
async function digest(path) {
 const hash = createHash('sha256');
 for await (const chunk of createReadStream(path)) hash.update(chunk);
 return hash.digest('hex');
}
const files = [];
for (const kind of ['dmg', 'zip']) {
 const original = `seek-desktop-0.4.0-mac-universal.${kind}`;
 const name = `seek-desktop-0.4.0-mac-universal-preview-7e78983.${kind}`;
 const input = join(source, original), info = await stat(input), sha256 = await digest(input);
 if (info.size < 200000000) throw Error('Universal Mac artifact is unexpectedly small');
 const staged = join(target, name + '.staged');
 await copyFile(input, staged);
 if (await digest(staged) !== sha256) throw Error('Copied Mac artifact checksum mismatch');
 await rename(staged, join(target, name));
 files.push({name, os: 'darwin', kind, arch: 'universal', size: info.size, sha256, version: '0.4.0', ciRun: 37799719883, commit: '7e78983d7a2a0506e2d34d2d5ed6e3e521852e74', signing: 'adhoc', notarized: false});
 // The GitHub asset uses the same fresh filename as the live download URL.
 await copyFile(input, join(source, name));
}
const backup = join(process.env.USERPROFILE, '.dsh/browser/backups/mac-preview-' + Date.now());
await mkdir(backup, {recursive: true});
await writeFile(join(backup, 'downloads-manifest.json'), previousText);
manifest.files = manifest.files.map(f => f.os === 'darwin' ? files.find(x => x.kind === f.kind) : f);
manifest.published = Date.now();
manifest.macPreview = {ciRun: 37799719883, commit: '7e78983d7a2a0506e2d34d2d5ed6e3e521852e74', notarized: false};
await writeFile(manifestFile + '.staged', JSON.stringify(manifest, null, 2));
await rename(manifestFile + '.staged', manifestFile);
await writeFile(join(source, 'SHA256SUMS-MAC-PREVIEW-7e78983'), files.map(f => `${f.sha256}  ${f.name}`).join('\n') + '\n');
console.log(JSON.stringify({liveMacDownloadsUpdated: true, version: manifest.version, ciRun: 37799719883, notarized: false, files: files.map(({name, size, sha256}) => ({name, size, sha256})), backup}, null, 2));
