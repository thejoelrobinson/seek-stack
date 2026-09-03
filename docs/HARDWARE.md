# Hardware and model choice

## What the installer picks for you

The model has to fit in VRAM alongside its KV cache — the memory holding the
conversation. Bigger context means a bigger cache, so the installer trades the
two off against each other.

Measured on a 24 GB card: the reference setup sits at **22.9 GB of 24**, with
19.4 GB of that being weights and the remaining ~3.5 GB the KV cache, the MTP
draft context, and overhead.

| VRAM | Quant | Context | Weights | Total | Quality |
|---|---|---|---|---|---|
| 23 GB+ | `UD-Q5_K_XL` | 65,536 | 19.4 GB | 22.9 GB | Reference |
| 20 GB+ | `UD-Q4_K_XL` | 65,536 | 16.4 GB | 19.9 GB | Very good |
| 16 GB+ | `UD-IQ4_XS` | 32,768 | 13.3 GB | 15.3 GB | Good |
| 14 GB+ | `UD-Q3_K_XL` | 16,384 | 12.2 GB | 13.5 GB | Noticeably worse |
| 12 GB+ | `UD-IQ3_XXS` | 16,384 | 10.2 GB | 11.5 GB | Fumbles tool calls |
| 10 GB+ | `UD-IQ2_S` | 8,192 | 7.8 GB | 8.8 GB | Poor |
| Under 10 GB | — | — | — | — | Installer stops you |

Override it if you know better:

```powershell
.\install.ps1 -Quant UD-Q4_K_M
```

### Quality falls off faster than size

Going from Q5 to Q4 costs little. Below IQ4 it degrades quickly, and the first
thing to break is not prose — it is **tool calling**. A Q3 model writes
plausible-looking text while mangling the structured output the agent needs to
actually edit files or run commands, which shows up as an agent that talks about
what it would do instead of doing it.

If you are on 12 GB or less, a smaller model at a higher quant will serve you far
better than a 27B squeezed into IQ2.

---

## Running a different model

Nothing in this stack is tied to Qwen3.8. The harness, the auth proxy, the
summarizer shim, and the search adapter all speak plain OpenAI-compatible HTTP,
so swapping the model is a config change.

**1.** Get a GGUF that fits your card — an 8B model at Q5 is a good fit for 8–12 GB.

**2.** Point `seek.config.ps1` at it:

```powershell
$ModelPath   = "$env:USERPROFILE\models\your-model.gguf"
$ModelAlias  = "your-model"
$ContextSize = 32768
```

**3.** Match `%USERPROFILE%\.dsh\settings.yaml` — the `id:` must equal
`$ModelAlias`, and `contextWindow:` must equal `$ContextSize`:

```yaml
models:
  - id: your-model
    contextWindow: 32768
    maxTokens: 8192
```

**4.** Restart with `start-seek.ps1`.

### Things that are Qwen3.8-specific

Two flags in `serve-qwen38.ps1` will not apply to other models and should be
removed if you switch:

- `--spec-type draft-mtp` — Qwen3.8 ships MTP draft heads inside the GGUF. On a
  model without them this does nothing useful.
- `--reasoning-budget` / `--reasoning-effort` — only meaningful for a model that
  reasons before answering.

The `thinkingFormat: deepseek` line in `settings.yaml` is also specific: it is
the only dialect that puts `reasoning_effort` on the wire as a top-level field
where llama.cpp will forward it into the chat template. On a non-reasoning model
it is harmless but pointless.

---

## Speed

On the reference 24 GB setup, generation runs at about **50 tokens/second**.

The single biggest factor after fitting in VRAM is **MTP speculative decoding**.
Qwen3.8 ships draft heads inside the GGUF, and without `--spec-type draft-mtp`
llama.cpp loads them, prints `unused tensor blk.*.nextn.* -- ignoring`, and
throws away roughly a third of your speed: **36.0 → 53.8 tokens/second**, for
only 637 MB of extra VRAM.

`--spec-draft-n-max 2` is the tuned value for a 24 GB card. Raising it to 3 was
measurably *worse* — 44.9 t/s, with draft acceptance collapsing from 61.7% to
41.7%, because it drafts more tokens while accepting the same absolute number and
burns the rest.

**If any layer does not fit on the GPU, speed collapses.** Partial CPU offload
costs far more than a quant level does. Always prefer a smaller quant that fits
entirely in VRAM over a larger one that spills.
