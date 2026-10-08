import {resolve} from 'node:path';
export function packagedPath(platform = process.platform) {
 if (platform === 'darwin') return resolve('dist/mac-universal/Seek Desktop.app');
 if (platform === 'win32') return resolve('dist/win-unpacked');
 return resolve('dist/linux-unpacked');
}
