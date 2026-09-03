# Serve Qwen3.8-27B (UD-Q5_K_XL) for DeepSeek Harness
# Endpoint: http://127.0.0.1:18798/v1   Model id: qwen3.8-27b
$ErrorActionPreference = "Stop"

$exe   = "A:\llama.cpp\llama-server.exe"
$model = "A:\models\qwen3.8\Qwen3.8-27B-UD-Q5_K_XL.gguf"
$log   = "A:\llama.cpp\qwen38-server.log"

$svrArgs = @(
  "-m", $model
  "-a", "qwen3.8-27b"
  "-ngl", "99"              # all 65 layers on the 3090
  "-c", "65536"             # 64K context; q8_0 KV keeps it inside 24GB
  "--cache-type-k", "q8_0"
  "--cache-type-v", "q8_0"
  "-fa", "on"               # flash-attn required for quantized V cache
  "--jinja"                 # chat template -> tool calling + reasoning split
  # Qwen3.8 ships MTP (nextn) heads inside the GGUF. Without these llama.cpp
  # loads them and prints "unused tensor blk.*.nextn.* -- ignoring".
  "--spec-type", "draft-mtp"
  "--spec-draft-n-max", "2" # 24GB cards peak at 2; 3-4 is for bigger cards
  "--parallel", "1"         # >1 eats the speculative-decoding win
  # Server-side floor for any request that does NOT name an effort (session
  # titling, and anything bypassing the harness). The Qwen3.8 chat template's
  # own default is xhigh; measured 2214 completion tokens vs 575 at medium for
  # the same 170-char answer. Requests that DO name reasoning_effort still win,
  # which is what makes the harness model picker able to switch levels.
  "--reasoning-effort", "medium"

  # HARD cap on thinking. reasoning_effort alone is only a sentence injected
  # into the prompt asking the model to think less - it holds on easy turns and
  # is IGNORED on hard ones. Measured at effort=low: a trivial question used 215
  # completion tokens, but an open-ended "design a complete Catan
  # implementation" used 22,747 (20,233 chars of reasoning). Agent sessions were
  # still producing steps with ~18,900 reasoning tokens and NO tool call, which
  # is what kills a turn on max-tokens.
  # This flag is the enforcement (server-launch only - it is silently ignored as
  # a per-request body field; two runs with and without it came back
  # byte-identical). -1 = unrestricted (the default), 0 = no thinking, N>0 = cap.
  "--reasoning-budget", "4096"
  # NOTE THE EMBEDDED QUOTES. Start-Process -ArgumentList joins this array with
  # spaces and does NOT quote elements, so an unquoted value containing spaces
  # is split into separate argv entries -- llama-server then read "Reasoning" as
  # the message and died with `invalid argument: budget`. Every other arg here
  # is space-free, which is why this only bites the message.
  "--reasoning-budget-message", '"Reasoning budget reached. Commit to the best option so far and immediately emit the answer or the next tool call."'
  "--host", "127.0.0.1"
  "--port", "18798"
)

Start-Process -FilePath $exe -ArgumentList $svrArgs `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
  -WindowStyle Hidden

Write-Host "llama-server starting on http://127.0.0.1:18798 (log: $log)"
