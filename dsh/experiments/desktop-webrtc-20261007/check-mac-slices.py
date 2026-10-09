from pathlib import Path
import struct
import zipfile
root = Path(__file__).resolve().parents[3] / 'desktop-bridge/dist/mac-preview-7e78983/verified/dist'
with zipfile.ZipFile(root / 'seek-desktop-0.4.0-mac-universal.zip') as bundle:
    for name in ['Contents/MacOS/Seek Desktop', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'Contents/Resources/native/seek-input']:
        with bundle.open('Seek Desktop.app/' + name) as binary:
            data = binary.read(128)
        magic, count = struct.unpack('>II', data[:8])
        assert magic in (0xCAFEBABE, 0xCAFEBABF), name + ' is not a universal Mach-O binary'
        stride = 20 if magic == 0xCAFEBABE else 32
        architectures = {struct.unpack('>I', data[8 + i * stride:12 + i * stride])[0] for i in range(count)}
        assert architectures == {0x01000007, 0x0100000C}, name + ' is missing Intel or Apple silicon'
        print(name + ': Intel + Apple silicon verified')
