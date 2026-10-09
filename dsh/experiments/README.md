# Seek experiment tools

This directory preserves the source for development experiments, integration probes,
UI checks, benchmarks, and deployment tooling. The dates identify the original
experiment; version numbers, release IDs, endpoints, and machine paths in older
scripts describe that experiment and may need updating before reuse.

The maintained application lives in `dsh/plugins/` and `desktop-bridge/`. These
scripts are not run automatically. Some connect to live services, submit tasks,
pair devices, or deploy files: inspect their configuration and behavior before
running them. Authenticated checks read credentials from the local environment or
existing protected storage.

Screenshots, reports, captured pages, logs, runtime homes, dependencies, and copied
source snapshots stay local. They can contain private account or conversation data.
Generate fresh evidence when repeating an experiment rather than relying on its
historical outputs.

The UI audits in `aaa-polish-20261006` accept an optional comma-separated
`SEEK_AUDIT_TASK_IDS` environment variable for conversation captures. They skip
conversation captures when it is absent. The receipt audit in
`browser-throughput-20260928/walmart-audit.mjs` accepts a local report directory as
its first argument, or through `SEEK_RECEIPT_TASK_DIR`.

The release preservation tools have isolated tests:

```powershell
node --test dsh/experiments/best-in-class-implementation-20261001/release-data.test.mjs dsh/experiments/best-in-class-implementation-20261001/recovery-smoke.test.mjs
pwsh -NoProfile -File dsh/experiments/best-in-class-implementation-20261001/operational-defaults.test.ps1
```
