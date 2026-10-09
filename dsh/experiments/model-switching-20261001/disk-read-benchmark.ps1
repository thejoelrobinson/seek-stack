<#
Compare the first 512 MiB (or 1 GiB) of the original and verified SSD model.
This opens existing files for READ access only and bypasses the Windows file
cache. It does not flush caches, change model files, or touch GPU processes.
Run only after the copy/checksum operation and competing model loads finish.

Hardware/drive caches still apply; this measures sequential read throughput,
not the complete model-load time. Microsoft alignment requirements:
https://learn.microsoft.com/en-us/windows/win32/fileio/file-buffering
#>
[CmdletBinding()]
param(
    [string] $SourcePath = 'A:\models\qwen3.8\Qwen3.8-27B-UD-Q5_K_XL.gguf',
    [string] $SsdPath = (Join-Path $env:USERPROFILE '.dsh\models\qwen3.8\Qwen3.8-27B-UD-Q5_K_XL.gguf'),
    [ValidateSet(512, 1024)]
    [int] $ReadMiB = 512,
    [switch] $CompileOnly
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The unbuffered benchmark requires Windows.'
}

$benchmarkNativeSource = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

namespace SeekModelSwitching20261001 {
    public sealed class DiskReadResult {
        public string Path { get; set; }
        public long BytesRead { get; set; }
        public int ReadCalls { get; set; }
        public uint LogicalSectorBytes { get; set; }
        public uint BufferAlignmentBytes { get; set; }
        public double ElapsedSeconds { get; set; }
        public double MiBPerSecond { get; set; }
    }

    public static class UnbufferedDiskReader {
        private const uint GenericRead = 0x80000000;
        private const uint ShareReadWriteDelete = 0x00000007;
        private const uint OpenExisting = 3;
        private const uint NoBufferingNormal = 0x20000080;
        private const uint ReserveCommit = 0x00003000;
        private const uint PageReadWrite = 4;
        private const uint Release = 0x00008000;
        private const int FileStorageInfoClass = 16;
        private const uint BufferBytes = 4 * 1024 * 1024;

        [StructLayout(LayoutKind.Sequential)]
        private struct FileStorageInfo {
            public uint LogicalBytesPerSector;
            public uint PhysicalBytesPerSectorForAtomicity;
            public uint PhysicalBytesPerSectorForPerformance;
            public uint FileSystemEffectivePhysicalBytesPerSectorForAtomicity;
            public uint Flags;
            public uint ByteOffsetForSectorAlignment;
            public uint ByteOffsetForPartitionAlignment;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(string path, uint access, uint sharing,
            IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileSizeEx(IntPtr file, out long size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleEx(IntPtr file,
            int informationClass, out FileStorageInfo info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(IntPtr file, IntPtr buffer, uint requested,
            out uint completed, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size,
            uint allocationType, uint protection);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool VirtualFree(IntPtr address, UIntPtr size, uint freeType);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        private static Win32Exception NativeError(string operation) {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }

        public static DiskReadResult Read(string path, long requestedBytes) {
            if (requestedBytes != 512L * 1024 * 1024 && requestedBytes != 1024L * 1024 * 1024)
                throw new ArgumentOutOfRangeException("requestedBytes", "Read exactly 512 MiB or 1 GiB.");
            string fullPath = System.IO.Path.GetFullPath(path);
            IntPtr file = new IntPtr(-1);
            IntPtr allocation = IntPtr.Zero;
            try {
                // OPEN_EXISTING + GENERIC_READ cannot create, truncate, or write a model.
                file = CreateFileW(fullPath, GenericRead, ShareReadWriteDelete,
                    IntPtr.Zero, OpenExisting, NoBufferingNormal, IntPtr.Zero);
                if (file == new IntPtr(-1)) throw NativeError("Open unbuffered read-only model: " + fullPath);
                long fileBytes;
                if (!GetFileSizeEx(file, out fileBytes)) throw NativeError("GetFileSizeEx");
                if (fileBytes < requestedBytes)
                    throw new IOException("Model is shorter than the requested benchmark range: " + fullPath);

                FileStorageInfo storage;
                if (!GetFileInformationByHandleEx(file, FileStorageInfoClass, out storage,
                    (uint)Marshal.SizeOf(typeof(FileStorageInfo))))
                    throw NativeError("Query sector alignment");
                uint alignment = Math.Max(storage.LogicalBytesPerSector,
                    Math.Max(storage.PhysicalBytesPerSectorForAtomicity,
                    Math.Max(storage.PhysicalBytesPerSectorForPerformance,
                        storage.FileSystemEffectivePhysicalBytesPerSectorForAtomicity)));
                if (storage.LogicalBytesPerSector == 0 || alignment == 0 ||
                    (alignment & (alignment - 1)) != 0 || alignment > BufferBytes ||
                    BufferBytes % alignment != 0 || requestedBytes % alignment != 0)
                    throw new IOException("Unsupported storage sector alignment; no reads performed.");

                // VirtualAlloc owns the reservation; align an interior address explicitly
                // to the physical sector size, including storage with sectors > 4 KiB.
                allocation = VirtualAlloc(IntPtr.Zero, new UIntPtr((ulong)BufferBytes + alignment),
                    ReserveCommit, PageReadWrite);
                if (allocation == IntPtr.Zero) throw NativeError("VirtualAlloc");
                ulong rawAddress = unchecked((ulong)allocation.ToInt64());
                ulong alignedAddress = (rawAddress + alignment - 1) & ~((ulong)alignment - 1);
                IntPtr buffer = new IntPtr(unchecked((long)alignedAddress));

                long completedBytes = 0;
                int readCalls = 0;
                Stopwatch elapsed = Stopwatch.StartNew();
                while (completedBytes < requestedBytes) {
                    uint requested = (uint)Math.Min((long)BufferBytes, requestedBytes - completedBytes);
                    uint completed;
                    if (!ReadFile(file, buffer, requested, out completed, IntPtr.Zero))
                        throw NativeError("Unbuffered ReadFile");
                    if (completed != requested)
                        throw new IOException("Unexpected short read; benchmark aborted.");
                    completedBytes += completed;
                    readCalls++;
                }
                elapsed.Stop();
                return new DiskReadResult {
                    Path = fullPath,
                    BytesRead = completedBytes,
                    ReadCalls = readCalls,
                    LogicalSectorBytes = storage.LogicalBytesPerSector,
                    BufferAlignmentBytes = alignment,
                    ElapsedSeconds = elapsed.Elapsed.TotalSeconds,
                    MiBPerSecond = completedBytes / (1024.0 * 1024.0) / elapsed.Elapsed.TotalSeconds
                };
            } finally {
                if (allocation != IntPtr.Zero) VirtualFree(allocation, UIntPtr.Zero, Release);
                if (file != new IntPtr(-1)) CloseHandle(file);
            }
        }
    }
}
'@

if (-not ('SeekModelSwitching20261001.UnbufferedDiskReader' -as [type])) {
    Add-Type -TypeDefinition $benchmarkNativeSource
}
if ($CompileOnly) {
    [pscustomobject]@{ Compiled = $true; ReadsPerformed = 0 } | ConvertTo-Json -Compress
    return
}

# Both existence/size checks happen before either timed read. Checksum validation
# of the SSD copy is intentionally the caller's responsibility.
foreach ($benchmarkPath in @($SourcePath, $SsdPath)) {
    $benchmarkFile = Get-Item -LiteralPath $benchmarkPath
    if ($benchmarkFile.PSIsContainer -or $benchmarkFile.Length -lt ([long]$ReadMiB * 1MB)) {
        throw "Benchmark input must be an existing file with at least $ReadMiB MiB: $benchmarkPath"
    }
}

$benchmarkResults = @(
    [SeekModelSwitching20261001.UnbufferedDiskReader]::Read($SourcePath, [long]$ReadMiB * 1MB)
    [SeekModelSwitching20261001.UnbufferedDiskReader]::Read($SsdPath, [long]$ReadMiB * 1MB)
)
[pscustomobject]@{
    Method = 'Windows FILE_FLAG_NO_BUFFERING, read-only, first contiguous file range'
    ReadMiBPerFile = $ReadMiB
    Results = $benchmarkResults
    SsdThroughputRatio = $benchmarkResults[1].MiBPerSecond / $benchmarkResults[0].MiBPerSecond
    Caveat = 'Bypasses Windows file cache; hardware cache and other disk activity can still affect timing.'
} | ConvertTo-Json -Depth 4
