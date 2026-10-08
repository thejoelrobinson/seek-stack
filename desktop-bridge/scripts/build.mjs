import {build, Platform, Arch} from 'electron-builder';
import {assertMacReleaseCredentials} from './mac-release.mjs';
assertMacReleaseCredentials();
await import('./native.mjs');
const directoryOnly = process.argv.includes('--dir');
// --dir alone defaults to the runner's CPU, regardless of configured installer targets.
const targets = process.platform === 'darwin'
 ? Platform.MAC.createTarget(directoryOnly ? 'dir' : null, Arch.universal)
 : directoryOnly ? Platform.current().createTarget('dir') : undefined;
await build({targets, publish: 'never'});
