# Seek releases and updates

Push reviewed changes to `main`. Work regressions run on Windows. Desktop changes also build and smoke-test packaged Windows, universal Mac, and Linux apps. Bump `desktop-bridge/package.json` and its lockfile for each new companion release (`npm version patch --no-git-tag-version` in that directory).

The desktop release job waits for successful Work tests for the same commit and all three desktop builds. It creates an immutable `bridge-vX.Y.Z` preview with six installers, SHA256SUMS, and release.json recording the source commit and both CI runs. Reusing a version from a different commit fails instead of overwriting an installed release. PR builds never publish.

## Live app and download publication

Install the reviewed publisher on the Seek host:

```powershell
./scheduled-task/register-release-publisher.ps1 -Apply -StartNow
```

The publisher checks every five minutes while the host user is logged in. It runs under that user without a GitHub Actions runner or inbound listener. It only accepts successful main push checks in `thejoelrobinson/seek-stack` and uses an isolated Git snapshot rather than changing the working checkout.

App deployment uses the existing backup, idle checks, rollback, and health checks. Running work, approvals, desktop requests, and image activity defer a restart. Ordinary waiting questions are preserved. Dependency changes require an explicit deployment review. The publisher deploys the viewer and proxy, not GPU models or the Discord bridge.

Downloads change only after both recorded CI runs finish successfully, all platform jobs pass, the release tag matches the tested source, and every installer passes SHA-256 verification. All files are staged before an atomic manifest change. Previous installers and a manifest backup remain available for rollback.

The installed publisher source is copied into `.dsh/release-publisher/source`; changing it requires re-running the registration script. Logs are in `.dsh/release-publisher/publisher.log`, with per-commit deployment output in `.dsh/release-cache/deploy-<commit>.log`; the latest outcome is `.dsh/release-cache/status.json`. Scheduled task: `SeekReleasePublisher`. Disable it with `Disable-ScheduledTask -TaskName SeekReleasePublisher`. On accounts that cannot register tasks, registration falls back to an HKCU Run entry named `SeekReleasePublisher`; remove that entry and stop its `run.ps1 -Loop` process to disable the fallback.

## Companion updates

Seek Desktop checks GitHub for a newer installer at launch and every six hours. Its Updates section offers Check for updates and Download. The user installs the preview; this does not silently replace the running app. Platform selection and download origins are validated, and versions cannot downgrade.

Mac previews currently use ad-hoc signing. Developer ID signing and notarization require repository secrets `MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Final DMG and ZIP verification gates publication. Silent signed companion installation is a separate future step; the current release automates build, publication, live downloads, and update detection.

If a release fails, fix the failure and push again. If the version was already published, bump it before pushing. Do not edit published installer assets. The publisher leaves the live downloads intact on failed tests or integrity checks.
