<#
Copy the existing Gemma main and MTP weights to C: without modifying originals.
The copy uses a bounded 4 MiB buffer and hashes the source bytes while copying.
A separate SHA256 pass verifies the destination. Existing destinations are
checked for equality and are never overwritten. No router/config/GPU changes.
#>
[CmdletBinding()]
param(
    [string] $ValidationPath = (Join-Path $PSScriptRoot 'validation\gemma-ssd-copy.json'),
    [switch] $CompileOnly
)
$ErrorActionPreference = 'Stop'

$gemmaCopyNativeSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;

namespace SeekGemmaCopy20261001 {
    public sealed class CopyResult {
        public string Source { get; set; }
        public string Destination { get; set; }
        public long Bytes { get; set; }
        public string SourceSha256 { get; set; }
        public string DestinationSha256 { get; set; }
        public bool Copied { get; set; }
        public bool Verified { get; set; }
        public long CopyMilliseconds { get; set; }
        public long VerifyMilliseconds { get; set; }
        public DateTime LastWriteTimeUtc { get; set; }
        public bool SourcePreserved { get; set; }
        public bool TimestampsPreserved { get; set; }
    }

    public static class VerifiedCopy {
        private const int BufferSize = 4 * 1024 * 1024;
        private static string Hex(byte[] bytes) {
            return BitConverter.ToString(bytes).Replace("-", "");
        }
        private static string HashFile(string path) {
            using (SHA256 hash = SHA256.Create())
            using (FileStream input = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.Read, BufferSize, FileOptions.SequentialScan)) {
                return Hex(hash.ComputeHash(input));
            }
        }

        public static CopyResult Copy(string source, string destination, long expectedBytes) {
            source = Path.GetFullPath(source);
            destination = Path.GetFullPath(destination);
            if (String.Equals(source, destination, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Source and destination must differ.");
            FileInfo original = new FileInfo(source);
            if (!original.Exists || original.Length != expectedBytes)
                throw new IOException("Unexpected source length: " + source);
            DateTime created = original.CreationTimeUtc;
            DateTime written = original.LastWriteTimeUtc;
            DateTime accessed = original.LastAccessTimeUtc;
            string sourceHash;
            string destinationHash;
            bool copied = false;
            Stopwatch copyTime = new Stopwatch();
            Stopwatch verifyTime = new Stopwatch();

            if (File.Exists(destination)) {
                // Check both files first; never overwrite a different/unverified file.
                verifyTime.Start();
                sourceHash = HashFile(source);
                destinationHash = HashFile(destination);
                verifyTime.Stop();
                if (new FileInfo(destination).Length != expectedBytes || sourceHash != destinationHash)
                    throw new IOException("Existing destination differs; it was left unchanged: " + destination);
            } else {
                string temporary = destination + ".copying-" + Guid.NewGuid().ToString("N");
                bool ownsTemporary = false;
                try {
                    byte[] buffer = new byte[BufferSize];
                    long completed = 0;
                    copyTime.Start();
                    using (SHA256 hash = SHA256.Create())
                    using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read,
                        FileShare.Read, BufferSize, FileOptions.SequentialScan))
                    using (FileStream output = new FileStream(temporary, FileMode.CreateNew,
                        FileAccess.Write, FileShare.None, BufferSize, FileOptions.SequentialScan)) {
                        ownsTemporary = true;
                        int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                            output.Write(buffer, 0, count);
                            hash.TransformBlock(buffer, 0, count, buffer, 0);
                            completed += count;
                        }
                        hash.TransformFinalBlock(new byte[0], 0, 0);
                        sourceHash = Hex(hash.Hash);
                        output.Flush(true);
                    }
                    copyTime.Stop();
                    if (completed != expectedBytes || new FileInfo(temporary).Length != expectedBytes)
                        throw new IOException("Unexpected number of bytes copied.");

                    verifyTime.Start();
                    destinationHash = HashFile(temporary); // independent destination pass
                    verifyTime.Stop();
                    if (sourceHash != destinationHash)
                        throw new IOException("Independent destination SHA256 did not match.");
                    // Rename within C: does not copy/rewrite data. Move rejects an
                    // existing final destination if another actor creates it first.
                    File.Move(temporary, destination);
                    ownsTemporary = false;
                    copied = true;
                } finally {
                    // Delete only the unique temporary file created by this method.
                    if (ownsTemporary && File.Exists(temporary)) File.Delete(temporary);
                }
            }

            // Only a verified equal destination reaches this point; preserve
            // timestamps for a new copy or an already matching destination.
            File.SetCreationTimeUtc(destination, created);
            File.SetLastWriteTimeUtc(destination, written);
            File.SetLastAccessTimeUtc(destination, accessed);
            FileInfo final = new FileInfo(destination);
            original.Refresh();
            return new CopyResult {
                Source = source,
                Destination = destination,
                Bytes = final.Length,
                SourceSha256 = sourceHash,
                DestinationSha256 = destinationHash,
                Copied = copied,
                Verified = final.Length == expectedBytes && sourceHash == destinationHash,
                CopyMilliseconds = copyTime.ElapsedMilliseconds,
                VerifyMilliseconds = verifyTime.ElapsedMilliseconds,
                LastWriteTimeUtc = written,
                SourcePreserved = original.Exists && original.Length == expectedBytes && original.LastWriteTimeUtc == written,
                TimestampsPreserved = final.CreationTimeUtc == created && final.LastWriteTimeUtc == written && final.LastAccessTimeUtc == accessed
            };
        }
    }
}
'@

if (-not ('SeekGemmaCopy20261001.VerifiedCopy' -as [type])) {
    Add-Type -TypeDefinition $gemmaCopyNativeSource
}
if ($CompileOnly) {
    [pscustomobject]@{ Compiled = $true; ModelReadsPerformed = 0; ModelWritesPerformed = 0 } | ConvertTo-Json -Compress
    return
}

$gemmaSourceRoot = 'A:\models\gemma-4-26B-A4B'
$gemmaDestinationRoot = Join-Path $env:USERPROFILE '.dsh\models\gemma-4-26B-A4B'
$gemmaModels = @(
    @{ Name = 'gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf'; Bytes = 14249047104L }
    @{ Name = 'mtp-gemma-4-26B-A4B-it.gguf'; Bytes = 251939328L }
)
$gemmaFreeBefore = [IO.DriveInfo]::new('C:\').AvailableFreeSpace
if ($gemmaFreeBefore -lt 30GB) {
    throw 'At least 30 GiB free on C: is required before copying Gemma.'
}
foreach ($gemmaModel in $gemmaModels) {
    $gemmaSource = Get-Item -LiteralPath (Join-Path $gemmaSourceRoot $gemmaModel.Name)
    if ($gemmaSource.PSIsContainer -or $gemmaSource.Length -ne $gemmaModel.Bytes) {
        throw "Unexpected source file: $($gemmaModel.Name)"
    }
}
[IO.Directory]::CreateDirectory($gemmaDestinationRoot) | Out-Null
$gemmaResults = @()
foreach ($gemmaModel in $gemmaModels) {
    Write-Host "Copying and verifying $($gemmaModel.Name)"
    $gemmaResult = [SeekGemmaCopy20261001.VerifiedCopy]::Copy(
        (Join-Path $gemmaSourceRoot $gemmaModel.Name),
        (Join-Path $gemmaDestinationRoot $gemmaModel.Name),
        $gemmaModel.Bytes
    )
    if (-not $gemmaResult.Verified -or -not $gemmaResult.SourcePreserved) {
        throw "Copy verification failed: $($gemmaModel.Name)"
    }
    $gemmaResults += $gemmaResult
    Write-Host "Verified $($gemmaModel.Name): $($gemmaResult.Bytes) bytes"
}
$gemmaReport = [pscustomobject]@{
    Verified = (@($gemmaResults | Where-Object { -not $_.Verified }).Count -eq 0)
    CompletedAtUtc = [DateTime]::UtcNow.ToString('o')
    FreeBeforeBytes = $gemmaFreeBefore
    FreeAfterBytes = [IO.DriveInfo]::new('C:\').AvailableFreeSpace
    BufferBytes = 4MB
    RuntimeChanged = $false
    OriginalFilesPreserved = $true
    Models = $gemmaResults
}
$gemmaReport | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ValidationPath -Encoding utf8
$gemmaReport | ConvertTo-Json -Depth 5
