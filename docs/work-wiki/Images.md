# Images

The **Images** view provides optional local Qwen Image 2.1 generation. The main seek-stack install deploys its Work plugin, while the image engine and model weights need a separate one-time setup. The image runner was built for a CUDA GPU with enough VRAM to keep the active image weights on the GPU; the project configuration uses an RTX 3090.

## Set up the image runner

1. Open **Images** on the host PC and choose **Copy setup command**.
2. Run that command in PowerShell on the same PC. It installs the local runner, Python dependencies, and model files under `~/.dsh/image-engine` by default. Python 3.10 or newer is required. You can pass `-EngineRoot` to the setup script to use another location.
3. Return to **Images** and choose **Check again** after setup finishes.

The setup script is deployed at `~/.dsh/tools/setup-qwen-image.ps1`. The runner listens only on `127.0.0.1:18810`; its image engine uses `127.0.0.1:18811` while rendering.

## Create and manage images

1. Describe the subject, setting, and style in **Images**. You can also choose **Image** in the conversation composer.
2. Pick **Square**, **Portrait**, **Landscape**, **Wide**, or **Tall**. Choose **Fast**, **Balanced**, or **High** detail, and optionally request a transparent background.
3. Choose **Generate image**. Work renders one image at a time. It temporarily unloads the language model from the shared GPU and restores it when rendering finishes.
4. Use the gallery to download an image, reuse its prompt, or delete it.

Images and gallery metadata stay under `~/.dsh/work/images/` unless `DSH_WORK_HOME` is set. Image generation waits when a Work reply or task is already using the language model. If **Images** says the runner is offline, rerun the setup or check the runner logs under the configured image engine root.

Related: [Troubleshooting](https://github.com/thejoelrobinson/seek-stack/wiki/Troubleshooting)
