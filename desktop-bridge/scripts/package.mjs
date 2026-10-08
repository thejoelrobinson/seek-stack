import {build} from 'electron-builder';
import {packagedPath} from './packaged-path.mjs';
import {assertMacReleaseCredentials, macNotarizationCredentials} from './mac-release.mjs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
assertMacReleaseCredentials();
const prepackaged = packagedPath();
// Package the exact application that passed smoke tests, without recompiling or repacking it.
await build({prepackaged,publish:'never'});
if (process.platform === 'darwin' && process.env.SEEK_MAC_SIGNED_RELEASE === '1') {
 const {version} = JSON.parse(await readFile('package.json', 'utf8'));
 const {notarize} = await import('@electron/notarize');
 await notarize({appPath: resolve(`dist/seek-desktop-${version}-mac-universal.dmg`), ...macNotarizationCredentials()});
}
