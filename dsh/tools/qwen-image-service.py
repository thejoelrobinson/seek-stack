"""Loopback-only full-GPU runner for the Seek Qwen Image plugin.

The image model is a Q6 GGUF and the Qwen3-VL text encoder is Q4. They are
loaded wholly into the RTX 3090 by stable-diffusion.cpp. Seek starts the engine
only after the language model is released, then stops it before restoration.
"""
import base64
import json
import os
import subprocess
import time
from pathlib import Path
from threading import Lock
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Seek Qwen Image runner")
ROOT = Path(os.getenv("SEEK_IMAGE_ENGINE_ROOT", str(Path.home() / ".dsh" / "image-engine"))).resolve()
MODELS = ROOT / "models"
ENGINE = ROOT / "sd-server.exe"
ENGINE_URL = os.getenv("SEEK_IMAGE_ENGINE_URL", "http://127.0.0.1:18811")
DIFFUSION = MODELS / "qwen_image_2.1-Q6_K.gguf"
TEXT_ENCODER = MODELS / "Qwen3VL-8B-Instruct-Q4_K_M.gguf"
VAE = MODELS / "vae" / "qwen_image_2.1_vae_bf16.safetensors"
generation_lock = Lock()
engine_process: Optional[subprocess.Popen] = None
engine_log = ROOT / "engine.log"
engine_error_log = ROOT / "engine.err"


class Generation(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9-]{36}$")
    prompt: str = Field(min_length=1, max_length=6000)
    outputDir: str
    width: int = Field(ge=512, le=2048)
    height: int = Field(ge=512, le=2048)
    steps: int = Field(ge=4, le=40)
    transparent: bool = False
    seed: Optional[int] = None


def installed():
    return ENGINE.is_file() and DIFFUSION.is_file() and TEXT_ENCODER.is_file() and VAE.is_file()


def request_json(url: str, data=None, timeout=30):
    payload = None if data is None else json.dumps(data).encode("utf-8")
    request = Request(url, data=payload, headers={"Content-Type": "application/json"} if payload else {})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Image engine returned HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Image engine is unavailable: {error.reason}") from error


def stop_engine():
    global engine_process
    process = engine_process
    engine_process = None
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def start_engine():
    global engine_process
    if not installed():
        raise RuntimeError("The GPU Qwen Image engine is not installed. Run setup-qwen-image.ps1 first.")
    if engine_process is not None and engine_process.poll() is None:
        return
    ROOT.mkdir(parents=True, exist_ok=True)
    command = [
        str(ENGINE), "--listen-ip", "127.0.0.1", "--listen-port", "18811",
        "--diffusion-model", str(DIFFUSION), "--vae", str(VAE), "--llm", str(TEXT_ENCODER),
        "--backend", "cuda0", "--params-backend", "cuda0", "--auto-fit", "off",
        "--eager-load", "--fa", "--threads", "12",
    ]
    log = open(engine_log, "a", encoding="utf-8")
    error_log = open(engine_error_log, "a", encoding="utf-8")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    engine_process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=error_log, creationflags=flags)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if engine_process.poll() is not None:
            engine_process = None
            tail = engine_error_log.read_text(encoding="utf-8", errors="replace")[-2000:] if engine_error_log.exists() else ""
            raise RuntimeError(f"The GPU image engine could not start. {tail}")
        try:
            request_json(f"{ENGINE_URL}/v1/models", timeout=3)
            return
        except RuntimeError:
            time.sleep(1)
    stop_engine()
    raise RuntimeError("Timed out while loading the GPU image engine.")


@app.get("/health")
def health():
    running = engine_process is not None and engine_process.poll() is None
    return {"available": installed(), "ready": installed(), "loaded": running,
            "engine": "stable-diffusion.cpp CUDA / Qwen Image 2.1 Q6", "gpuResident": True}


@app.post("/generate")
def generate(job: Generation):
    target = Path(job.outputDir).resolve()
    target.mkdir(parents=True, exist_ok=True)
    destination = (target / f"{job.id}.png").resolve()
    if target not in destination.parents:
        raise HTTPException(400, "Invalid output path.")
    prompt = job.prompt.strip()
    if job.transparent:
        prompt = "This is an RGBA image with transparency. " + prompt + " The image has alpha channel and the background is transparent."
    with generation_lock:
        try:
            start_engine()
            body = {"prompt": prompt, "size": f"{job.width}x{job.height}", "n": 1, "output_format": "png"}
            if job.seed is not None:
                body["prompt"] += f' <sd_cpp_extra_args>{{"seed":{job.seed}}}</sd_cpp_extra_args>'
            result = request_json(f"{ENGINE_URL}/v1/images/generations", body, timeout=900)
            image_data = result.get("data", [{}])[0].get("b64_json")
            if not image_data:
                raise RuntimeError("The GPU image engine returned no image.")
            destination.write_bytes(base64.b64decode(image_data))
            return {"file": destination.name, "width": job.width, "height": job.height, "seed": job.seed}
        except RuntimeError as error:
            raise HTTPException(503, str(error)) from error


@app.post("/unload")
def unload():
    # Handoff waits for an in-flight image before VRAM is released.
    with generation_lock:
        stop_engine()
    return {"released": True}
