# seek-stack configuration.
#
# install.ps1 generates a filled-in `seek.config.ps1` next to this file and both
# start-seek.ps1 and serve-qwen38.ps1 dot-source it. Edit that copy, not this one.
#
# Every path here is absolute. Nothing in this stack looks things up relative to
# the current directory, because it runs from a scheduled task whose working
# directory is not yours.

# --- Where things live -------------------------------------------------------

# Harness home. Holds proxy scripts, profiles, settings.yaml, sessions, logs.
$SeekHome  = "$env:USERPROFILE\.dsh"

# Directory containing llama-server.exe (and the CUDA runtime DLLs beside it).
$LlamaDir  = "$env:USERPROFILE\llama.cpp"

# The GGUF weights file.
$ModelPath = "$env:USERPROFILE\models\Qwen3.8-27B-UD-Q5_K_XL.gguf"

# --- Model serving -----------------------------------------------------------

# Model id the harness asks for. Must match `id:` in dsh/settings.yaml.
$ModelAlias = "qwen3.8-27b"

# Served context window. MUST match `contextWindow:` in dsh/settings.yaml --
# llama-server also advertises n_ctx_train (262144), and if the harness believes
# that instead it never compacts in time and requests die on overflow.
$ContextSize = 65536

# Layers to put on the GPU. 99 = all of them. Lower this only if the model does
# not fit in VRAM; every layer left on the CPU costs a large amount of speed.
$GpuLayers = 99

# Hard cap on thinking tokens, enforced server-side. -1 unrestricted, 0 none.
# reasoning_effort alone is only a prompt suggestion and is ignored on hard
# turns -- this is the flag that actually binds. See docs/TROUBLESHOOTING.md.
$ReasoningBudget = 4096

# Floor for requests that name no effort. low | medium | xhigh
$ReasoningEffort = "medium"

# --- Remote access (optional) ------------------------------------------------

# Leave EMPTY to run purely on localhost, which needs no domain and no tunnel.
#
# Set it to your hostname only if you are exposing this through a Cloudflare
# tunnel, e.g. "seek.example.com". dsh web needs it as --trusted-host or its
# browser-trust fence rejects every tunnelled request.
#
# READ docs/SETUP.md#exposing-it-to-the-internet FIRST. The harness has no
# authentication of its own and can run PowerShell; the auth proxy in front of
# it is the only thing standing between your machine and the internet.
$TrustedHost = ""

# --- Ports (all bind 127.0.0.1) ----------------------------------------------

$LlamaPort   = 18798   # llama-server
$ShimPort    = 18800   # summarizer shim -> llama-server
$SearxPort   = 18801   # SearXNG container
$AdapterPort = 18802   # search adapter -> SearXNG
$WebPort     = 3080    # dsh web
$ProxyPort   = 18799   # auth proxy -> dsh web (the tunnel's only target)
