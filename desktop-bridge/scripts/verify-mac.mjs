import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
if (process.platform !== 'darwin') throw Error('Mac artifact verification requires macOS.');
const inspect = process.argv.includes('--inspect');
const signed = process.env.SEEK_MAC_SIGNED_RELEASE === '1';
const personal = process.env.SEEK_MAC_SIGNING_IDENTITY;
function command(program, args, required = true, env = process.env) {
 const result = spawnSync(program, args, {encoding: 'utf8', env, timeout: 180000});
 const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
 console.log(`${program} ${args.join(' ')}\n${output}`);
 if (required && (result.error || result.status !== 0)) throw Error(`${program} failed (${result.status}): ${output}`);
 return {ok: !result.error && result.status === 0, output};
}
function verifyApp(app) {
 const integrity = command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], !inspect);
 const identity = command('codesign', ['--display', '--verbose=4', app], !inspect);
 for (const file of ['Contents/MacOS/Seek Desktop', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'Contents/Resources/native/seek-input']) {
  const binary = join(app, file);
  command('codesign', ['--verify', '--strict', '--verbose=2', binary], !inspect);
  const {output} = command('lipo', ['-archs', binary], !inspect);
  if (!inspect && (!output.split(/\s+/).includes('arm64') || !output.split(/\s+/).includes('x86_64')))
   throw Error(`Universal release is missing a Mac architecture: ${file}`);
 }
 const assessment = command('spctl', ['--assess', '--type', 'execute', '--verbose=4', app], signed && !inspect);
 if (!inspect) {
  if (signed) {
   if (!identity.output.includes('Authority=Developer ID Application:')) throw Error('Mac release lacks a Developer ID Application signature.');
   if (!assessment.output.includes('source=Notarized Developer ID')) throw Error('Gatekeeper did not recognize an Apple-notarized release.');
   command('xcrun', ['stapler', 'validate', app]);
  } else if(personal){if(!identity.output.includes('Authority='+personal))throw Error('Personal Mac build lacks the selected persistent identity.');}
  else if (!identity.output.includes('Signature=adhoc')) throw Error('Local Mac preview lacks a valid ad-hoc signature.');
  console.log(signed ? 'MAC RELEASE: signature, universal binaries and Gatekeeper accepted.' : 'MAC PREVIEW ONLY: valid signature and universal binaries; NOT notarized for public distribution.');
 }
 return {integrity: integrity.ok, gatekeeper: assessment.ok};
}
const {version} = JSON.parse(await readFile('package.json', 'utf8'));
const argument = process.argv.indexOf('--dmg');
const dmg = resolve(argument >= 0 ? process.argv[argument + 1] : `dist/seek-desktop-${version}-mac-universal.dmg`);
const work = await mkdtemp(join(tmpdir(), 'seek-mac-release-'));
const mount = join(work, 'mount');
let mounted = false;
try {
 command('hdiutil', ['verify', dmg]);
 await mkdir(mount);
 command('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]);
 mounted = true;
 verifyApp(join(mount, 'Seek Desktop.app'));
 if (!inspect) {
  const copied = join(work, 'dmg-install', 'Seek Desktop.app');
  command('ditto', [join(mount, 'Seek Desktop.app'), copied]);
  command('xattr', ['-w', 'com.apple.quarantine', `0083;${Math.floor(Date.now()/1000).toString(16)};Seek artifact verification;`, copied]);
  verifyApp(copied);
  command(process.execPath, ['scripts/smoke.mjs', '--packaged'], true, {...process.env, SEEK_MAC_SMOKE_APP: copied});
  if (signed) command('xcrun', ['stapler', 'validate', dmg]);
  const zipApp = join(work, 'zip-install', 'Seek Desktop.app');
  command('ditto', ['-x', '-k', resolve(`dist/seek-desktop-${version}-mac-universal.zip`), join(work, 'zip-install')]);
  command('xattr', ['-w', 'com.apple.quarantine', `0083;${Math.floor(Date.now()/1000).toString(16)};Seek artifact verification;`, zipApp]);
  verifyApp(zipApp);
  command(process.execPath, ['scripts/smoke.mjs', '--packaged'], true, {...process.env, SEEK_MAC_SMOKE_APP: zipApp});
 }
} finally {
 if (mounted) command('hdiutil', ['detach', mount]);
 await rm(work, {recursive: true, force: true});
}
