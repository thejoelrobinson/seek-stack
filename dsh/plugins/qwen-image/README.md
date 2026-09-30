# Qwen Image 2.1 for DeepSeek Harness

This is a local DSH plugin. It exposes a loopback-only HTTP bridge for the
Work image studio and coordinates the shared GPU with the llama.cpp model
router. It runs one image at a time, releases image VRAM, then restores the
language model.

The runner uses stable-diffusion.cpp with Qwen Image 2.1 Q6 image weights and
a Q4 Qwen3-VL text encoder. All active image weights stay on the RTX 3090;
there is no layer-by-layer CPU offload. The Work plugin installer copies
the optional setup script to ~/.dsh/tools/setup-qwen-image.ps1. Run it from
PowerShell when the Images tab asks you to set up the model. Its engine files
default to ~/.dsh/image-engine; pass -EngineRoot to choose another drive.
