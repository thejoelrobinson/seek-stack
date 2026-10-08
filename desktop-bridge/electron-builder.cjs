const signedMacRelease = process.env.SEEK_MAC_SIGNED_RELEASE === '1';
module.exports = {
  appId: 'com.joelcrobinson.seek.desktop', productName: 'Seek Desktop',
  protocols: [{name:'Seek Desktop connection',schemes:['seek-desktop']}],
  directories: {output: 'dist'},
  // binary-data ships its own implementation under src/node_modules, rather than
  // npm dependencies. Electron's dependency collector otherwise omits these files.
  files: ['src/**', 'package.json',{
    from:'node_modules/@shinyoshiaki/binary-data/src/node_modules',
    to:'node_modules/@shinyoshiaki/binary-data/src/node_modules',filter:['**/*']
  }],
  asar: true, asarUnpack: ['src/windows.ps1','src/linux-accessibility.py'],
  artifactName: 'seek-desktop-${version}-${os}-${arch}.${ext}',
  win: {target: ['nsis', 'zip']}, nsis: {oneClick: false, allowToChangeInstallationDirectory: true},
  mac: {
    target: [{target: 'dmg', arch: ['universal']}, {target: 'zip', arch: ['universal']}],
    category: 'public.app-category.productivity',
    // Re-sign modified Electron bundles. Ad-hoc signatures are for CI/local previews only.
    identity: signedMacRelease ? undefined : '-',
    hardenedRuntime: signedMacRelease,
    notarize: signedMacRelease,
    binaries: ['Contents/Resources/native/seek-input'],
    strictVerify: true
  },
  dmg: {sign: signedMacRelease},
  linux: {target: ['AppImage', 'deb'], category: 'Utility', maintainer: 'Joel Robinson'},
  extraResources: process.platform === 'darwin' ? [{from: 'native/seek-input', to: 'native/seek-input'}] : [],
  publish: null
};
