module.exports = {
  appId: 'com.joelcrobinson.seek.desktop', productName: 'Seek Desktop',
  directories: {output: 'dist'}, files: ['src/**', 'package.json'], asar: true, asarUnpack: ['src/windows.ps1','src/linux-accessibility.py'],
  artifactName: 'seek-desktop-${version}-${os}-${arch}.${ext}',
  win: {target: ['nsis', 'zip']}, nsis: {oneClick: false, allowToChangeInstallationDirectory: true},
  mac: {target: [{target: 'dmg', arch: ['universal']}, {target: 'zip', arch: ['universal']}], category: 'public.app-category.productivity'},
  linux: {target: ['AppImage', 'deb'], category: 'Utility', maintainer: 'Joel Robinson'},
  extraResources: process.platform === 'darwin' ? [{from: 'native/seek-input', to: 'native/seek-input'}] : [],
  publish: null
};
