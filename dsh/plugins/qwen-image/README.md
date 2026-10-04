# Qwen Image 2.1 for DeepSeek Harness

This is a local DSH plugin. It exposes a loopback-only HTTP bridge for the
Work image studio and coordinates the shared GPU with the llama.cpp model
router. It runs one image at a time, releases image VRAM, then restores the
language model.

Image requests are journaled in `images/jobs.json` before acceptance and before
chat models are unloaded. The journal binds the job to its prior chat models.
Startup reattaches to an owned running request or reconciles its output, then
restores those models without submitting generation a second time. Runner
ownership is also saved to `image-engine/runner-state.json`; a restarted runner
can stop an orphan only after its PID, process creation identity and executable
match its saved lease. Unreadable stores are preserved beside valid backups.

`POST /qwen-image/api/start` returns a durable job ID promptly. Pass a stable
`requestId` to make retries idempotent; different payloads using the same ID are
rejected. Up to 20 waiting jobs can be queued, and foreground Work retains GPU
priority. `deferred:true` keeps a request queued until explicitly resumed. The
`cancel` and `defer` endpoints accept `{id}` and `{id,deferred}` respectively.
Cancellation is supported while waiting, loading and sampling; saving and chat
restoration finish safely. Both `status` and `history` expose the queue. Requests
remain queryable through `job?id=...` after a restart. All routes use Work's
trusted-host, same-origin and fetch-site fence.

Gallery records are never truncated to 100 entries. Unindexed output PNGs are
recovered on startup. Delete hides a record while keeping pixels and settings;
`undelete` restores it. Studio exposes removed records, an image inspector,
comparison, settings/seed reuse and prompt-based variations with parent links.
Reference-image editing and inpainting are not offered by this runner.

Studio keeps prompt/settings and uncertain request IDs across reloads. The actual
image dominates the surface, with a compact phase line and optional model details.
The existing toolbox/painter character follows authoritative handoff stages.
Sampling estimates use observed step rate; other phase estimates appear only
after three successful measured histories. No fabricated loading percentage is
shown. Live previews still use the native 64-pixel projection every four sampling
steps, with no extra inference/VAE decode, hidden-view suppression and coalescing.
Downloaded latest previews are preserved locally for restart recovery.

Isolated validation (no real GPU or production restart):

```
node --import ./test/register-profile.mjs --test test/image-reliability.test.mjs test/image-studio.test.mjs
python -m unittest discover -s dsh/tools -p 'test_qwen_image*.py'
```

Run the Node command from `dsh/plugins/browser-viewer`, and the Python command
from the repository root. Real generation duration/quality and the single-GPU
capacity remain hardware measurements; queueing does not provide simultaneous
chat inference while image weights own the GPU.

The runner uses stable-diffusion.cpp with Qwen Image 2.1 Q6 image weights and
a Q4 Qwen3-VL text encoder. All active image weights stay on the RTX 3090;
there is no layer-by-layer CPU offload. The Work plugin installer copies
the optional setup script to ~/.dsh/tools/setup-qwen-image.ps1. Run it from
PowerShell when the Images tab asks you to set up the model. Its engine files
default to ~/.dsh/image-engine; pass -EngineRoot to choose another drive.
