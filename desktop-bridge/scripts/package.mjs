import {build} from 'electron-builder';
const prepackaged=process.platform==='win32'?'dist/win-unpacked':process.platform==='darwin'?`dist/${process.arch==='arm64'?'mac-arm64':'mac'}/Seek Desktop.app`:'dist/linux-unpacked';
// Package the exact application that passed smoke tests, without recompiling or repacking it.
await build({prepackaged,publish:'never'});
