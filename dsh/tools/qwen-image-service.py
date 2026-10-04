"""Loopback-only full-GPU runner for the Seek Qwen Image plugin.

The image model is a Q6 GGUF and the Qwen3-VL text encoder is Q4. They are
loaded wholly into the RTX 3090 by stable-diffusion.cpp. Seek starts the engine
only after the language model is released, then stops it before restoration.
"""
import base64
import json
import os
import math
import re
import subprocess
import struct
import tempfile
import time
import zlib
import signal
import shutil
from pathlib import Path
from threading import Lock, Event
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException, Request as HttpRequest, Response
from pydantic import BaseModel, Field

app = FastAPI(title="Seek Qwen Image runner")
ROOT = Path(os.getenv("SEEK_IMAGE_ENGINE_ROOT", str(Path.home() / ".dsh" / "image-engine"))).resolve()
MODELS = ROOT / "models"
ENGINE = ROOT / "sd-server.exe"
CLI_ENGINE = ROOT / "sd-cli.exe"
ENGINE_URL = os.getenv("SEEK_IMAGE_ENGINE_URL", "http://127.0.0.1:18811")
DIFFUSION = MODELS / "qwen_image_2.1-Q6_K.gguf"
TEXT_ENCODER = MODELS / "Qwen3VL-8B-Instruct-Q4_K_M.gguf"
VAE = MODELS / "vae" / "qwen_image_2.1_vae_bf16.safetensors"
generation_lock = Lock()
cancel_event = Event()
cancelled_jobs = set()
state_lock = Lock()
runner_state = None
durability_enabled = False
engine_process: Optional[subprocess.Popen] = None
engine_ready = False
progress_lock = Lock()
progress = None
sampling_reader = None
preview_reader = None
preview_cache = None
PREVIEW_INTERVAL = 4
PREVIEW_MAX_BYTES = 1024 * 1024
engine_log = ROOT / "engine.log"
engine_error_log = ROOT / "engine.err"
STATE_FILE = ROOT / "runner-state.json"


def process_identity(pid):
    """PID reuse cannot authorize stopping an unrelated process after a restart."""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
            kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x1000, False, pid)
            if not handle:
                return None
            try:
                path, length = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
                stamps = [wintypes.FILETIME() for _ in range(4)]
                if not kernel.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(length)) or not kernel.GetProcessTimes(handle, *(ctypes.byref(stamp) for stamp in stamps)):
                    return None
                return {"pid": pid, "image": str(Path(path.value).resolve()), "created": (stamps[0].dwHighDateTime << 32) | stamps[0].dwLowDateTime}
            finally:
                kernel.CloseHandle(handle)
        row = Path(f"/proc/{pid}/stat").read_text().split(")", 1)[1].split()
        return {"pid": pid, "image": str(Path(f"/proc/{pid}/exe").resolve()), "created": row[19]}
    except (OSError, ValueError):
        return None


def persist_runner_state(**changes):
    global runner_state
    with state_lock:
        runner_state = {**(runner_state or {"version": 1}), **changes}
        if not durability_enabled:
            return
        ROOT.mkdir(parents=True, exist_ok=True)
        temporary = STATE_FILE.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as journal:
            journal.write(json.dumps(runner_state, ensure_ascii=False))
            journal.flush()
            os.fsync(journal.fileno())
        if STATE_FILE.is_file():
            shutil.copy2(STATE_FILE, str(STATE_FILE) + ".bak")
        temporary.replace(STATE_FILE)


def register_engine(process):
    identity = process_identity(process.pid)
    if identity is None:
        # A process may finish before identity observation; never invent a lease.
        if process.poll() is None:
            process.terminate()
            raise RuntimeError("Could not verify the image engine process ownership.")
    persist_runner_state(engine=identity)


def recover_runner_state():
    """Recover accepted work and stop only a verified orphan owned by this runner."""
    global runner_state, progress, cancelled_jobs
    if not STATE_FILE.is_file():
        return
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(state, dict) or state.get("version") != 1:
            raise ValueError("Invalid runner state")
    except (OSError, ValueError):
        STATE_FILE.replace(Path(str(STATE_FILE) + f".corrupt-{time.time_ns()}"))
        backup = Path(str(STATE_FILE) + ".bak")
        try:
            state = json.loads(backup.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
    runner_state = state
    cancelled_jobs = set(state.get("cancelledIds", []))
    identity = state.get("engine")
    if identity:
        observed = process_identity(identity.get("pid", -1))
        expected_images = {str(ENGINE.resolve()).casefold(), str(CLI_ENGINE.resolve()).casefold()}
        if observed == identity and observed["image"].casefold() in expected_images:
            os.kill(identity["pid"], signal.SIGTERM)
            deadline = time.monotonic() + 20
            while process_identity(identity["pid"]) == identity and time.monotonic() < deadline:
                time.sleep(0.1)
            if process_identity(identity["pid"]) == identity:
                raise RuntimeError("The previous owned image engine could not be stopped.")
    saved = state.get("progress")
    if saved:
        progress = {**saved, "phase": "interrupted", "phaseAt": int(time.time() * 1000), "error": "The image runner restarted. Seek will restore chat and recover any saved image."}
    persist_runner_state(engine=None, busy=False, progress=progress)


@app.on_event("startup")
def startup_recovery():
    global durability_enabled
    durability_enabled = True
    recover_runner_state()


class SamplingLogReader:
    """Read only newly emitted sampling records for one serialized request."""
    record = re.compile(rb"(?<!\d)(\d{1,3})\s*/\s*(\d{1,3})\s*-\s*(\d+(?:\.\d+)?)\s*(s/it|it/s)(?![a-z])")
    ansi = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")

    def __init__(self, job_id, total, paths):
        self.job_id, self.total = job_id, total
        self.offsets, self.tails, self.sample = {}, {}, None
        self.generation_started = False
        self.decode_finished = False
        for path in paths:
            try:
                self.offsets[path] = path.stat().st_size
            except OSError:
                self.offsets[path] = 0
            self.tails[path] = b""

    def read(self):
        for path, offset in list(self.offsets.items()):
            try:
                with path.open("rb") as stream:
                    if path.stat().st_size < offset:
                        offset, self.tails[path] = 0, b""
                    stream.seek(offset)
                    chunk = stream.read(65536)
                    self.offsets[path] = stream.tell()
            except OSError:
                continue
            if not chunk:
                continue
            data = self.ansi.sub(b"", self.tails[path] + chunk)
            self.tails[path] = data[-512:]
            # These engine records bracket loaded weights and final VAE decode.
            self.generation_started |= bool(re.search(rb"generate_image \d+x\d+", data))
            self.decode_finished |= b"decode_first_stage completed" in data
            for match in self.record.finditer(data):
                step, total = int(match[1]), int(match[2])
                if total != self.total or not 0 <= step <= total or self.sample and step <= self.sample["step"]:
                    continue
                rate = float(match[3])
                sample = {"step": step, "total": total, "updatedAt": int(time.time() * 1000)}
                if math.isfinite(rate) and rate > 0:
                    sample["secondsPerStep"] = rate if match[4] == b"s/it" else 1 / rate
                self.sample = sample
        return self.sample


def preview_png_dimensions(data):
    """Reject a partially overwritten preview without decoding it or using the GPU."""
    if not 33 <= len(data) <= PREVIEW_MAX_BYTES or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    position, dimensions, chunks = 8, None, 0
    while position + 12 <= len(data) and chunks < 64:
        length = struct.unpack_from(">I", data, position)[0]
        end = position + 12 + length
        if end > len(data):
            return None
        kind = data[position + 4:position + 8]
        content = data[position + 8:position + 8 + length]
        expected_crc = struct.unpack_from(">I", data, position + 8 + length)[0]
        if zlib.crc32(kind + content) & 0xffffffff != expected_crc:
            return None
        if chunks == 0:
            if kind != b"IHDR" or length != 13:
                return None
            width, height = struct.unpack_from(">II", content)
            if not 0 < width <= 512 or not 0 < height <= 512:
                return None
            dimensions = (width, height)
        if kind == b"IEND":
            return dimensions if length == 0 and end == len(data) else None
        position, chunks = end, chunks + 1
    return None


class PreviewFileReader:
    """One latest, small projected image; no history, image decode, or VAE work."""
    def __init__(self, job_id, total, path):
        self.job_id, self.total, self.path = job_id, total, path
        self.revision = 0

    def read(self, sample=None):
        global preview_cache
        # Native CLI numbers denoised previews from zero. Under the unchanged
        # default Euler sampler, index N is exactly step (N + 1) * interval.
        # Read the latest complete file even if stdout has not caught up yet.
        for index in range(self.total // PREVIEW_INTERVAL - 1, self.revision - 1, -1):
            path = self.path.with_name(self.path.name.replace("%03d", f"{index:03d}"))
            try:
                before = path.stat()
                if not 0 < before.st_size <= PREVIEW_MAX_BYTES:
                    continue
                with path.open("rb") as stream:
                    data = stream.read(PREVIEW_MAX_BYTES + 1)
                after = path.stat()
            except OSError:
                continue
            if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                continue
            dimensions = preview_png_dimensions(data)
            if not dimensions:
                continue
            self.revision = index + 1
            preview_cache = {"id": self.job_id, "data": data, "revision": self.revision,
                             "step": self.revision * PREVIEW_INTERVAL, "total": self.total,
                             "width": dimensions[0], "height": dimensions[1],
                             "updatedAt": int(time.time() * 1000)}
            for older in range(index):
                old_path = self.path.with_name(self.path.name.replace("%03d", f"{older:03d}"))
                try:
                    old_path.unlink(missing_ok=True)
                except OSError:
                    pass
            return


def begin_sampling(job):
    global sampling_reader
    with progress_lock:
        sampling_reader = SamplingLogReader(job.id, job.steps, [engine_log, engine_error_log])


def read_sampling():
    if progress and progress.get("phase") == "creating" and sampling_reader and sampling_reader.job_id == progress["id"]:
        sample = sampling_reader.read()
        if sample:
            progress["sampling"] = sample


def read_cli_progress():
    global engine_ready
    if not progress or not sampling_reader or sampling_reader.job_id != progress["id"]:
        return
    sample = sampling_reader.read()
    if progress["phase"] == "loadingImage" and sampling_reader.generation_started:
        engine_ready = True
        progress.update(phase="creating", phaseAt=int(time.time() * 1000))
        persist_runner_state(progress=dict(progress))
    if progress["phase"] == "creating" and sample:
        progress["sampling"] = sample
    if preview_reader and preview_reader.job_id == progress["id"]:
        preview_reader.read(sample)
        if preview_cache and preview_cache["id"] == progress["id"]:
            progress["preview"] = {key: value for key, value in preview_cache.items() if key not in ("id", "data")}
    if progress["phase"] == "creating" and sampling_reader.decode_finished:
        progress.update(phase="savingImage", phaseAt=int(time.time() * 1000))
        progress.pop("sampling", None)
        persist_runner_state(progress=dict(progress))


class Generation(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9-]{36}$")
    prompt: str = Field(min_length=1, max_length=6000)
    outputDir: str
    width: int = Field(ge=512, le=2048)
    height: int = Field(ge=512, le=2048)
    steps: int = Field(ge=4, le=40)
    transparent: bool = False
    seed: Optional[int] = None
    livePreview: bool = True


def set_phase(phase, job_id=None, error=None):
    global progress, sampling_reader, preview_reader, preview_cache
    with progress_lock:
        now = int(time.time() * 1000)
        if job_id is not None:
            progress = {"id": job_id, "startedAt": now}
            sampling_reader = None
            preview_reader = None
            preview_cache = None
        if progress is not None:
            progress.update(phase=phase, phaseAt=now)
            if phase != "creating":
                progress.pop("sampling", None)
                sampling_reader = None
            if phase in ("idle", "error", "cancelled", "interrupted"):
                progress.pop("preview", None)
                preview_reader = None
                preview_cache = None
            if error:
                progress["error"] = error
        snapshot = dict(progress) if progress else None
    persist_runner_state(progress=snapshot)


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
    global engine_process, engine_ready
    engine_ready = False
    process = engine_process
    engine_process = None
    if process is None or process.poll() is not None:
        persist_runner_state(engine=None)
        return
    process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)
    persist_runner_state(engine=None)


def start_engine():
    global engine_process, engine_ready
    if not installed():
        raise RuntimeError("The GPU Qwen Image engine is not installed. Run setup-qwen-image.ps1 first.")
    if engine_ready and engine_process is not None and engine_process.poll() is None:
        return
    engine_ready = False
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
    register_engine(engine_process)
    log.close()
    error_log.close()
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if cancel_event.is_set():
            stop_engine()
            raise RuntimeError("Image generation cancelled.")
        if engine_process.poll() is not None:
            engine_process = None
            tail = engine_error_log.read_text(encoding="utf-8", errors="replace")[-2000:] if engine_error_log.exists() else ""
            raise RuntimeError(f"The GPU image engine could not start. {tail}")
        try:
            request_json(f"{ENGINE_URL}/v1/models", timeout=3)
            engine_ready = True
            return
        except RuntimeError:
            time.sleep(1)
    stop_engine()
    raise RuntimeError("Timed out while loading the GPU image engine.")


def cli_generate(job, prompt, destination, preview_enabled=True):
    """Same inference settings as the server, with cheap native latent previews."""
    global engine_process, engine_ready, sampling_reader, preview_reader
    if not installed() or not CLI_ENGINE.is_file():
        raise RuntimeError("The GPU Qwen Image engine is not installed. Run setup-qwen-image.ps1 first.")
    stop_engine()
    scratch_root = ROOT / "previews"
    scratch_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"seek-{job.id}-", dir=scratch_root) as folder:
        scratch = Path(folder)
        prompt_file = scratch / "prompt.txt"
        prompt_file.write_text(prompt, encoding="utf-8")
        output = scratch / "result.png"
        command = [str(CLI_ENGINE), "--diffusion-model", str(DIFFUSION),
                   "--vae", str(VAE), "--llm", str(TEXT_ENCODER), "--backend", "cuda0",
                   "--params-backend", "cuda0", "--auto-fit", "off", "--eager-load",
                   "--fa", "--threads", "12", "--prompt-file", str(prompt_file),
                   "--width", str(job.width), "--height", str(job.height), "--steps", str(job.steps),
                   "--seed", str(job.seed if job.seed is not None else 42), "--batch-count", "1",
                   "--output", str(output)]
        if preview_enabled:
            command.extend(["--preview", "proj", "--preview-interval", str(PREVIEW_INTERVAL),
                            "--preview-path", str(scratch / "preview-%03d.png")])
        with progress_lock:
            sampling_reader = SamplingLogReader(job.id, job.steps, [engine_log, engine_error_log])
            preview_reader = PreviewFileReader(job.id, job.steps, scratch / "preview-%03d.png") if preview_enabled else None
        with engine_log.open("ab") as log, engine_error_log.open("ab") as error_log:
            engine_process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=error_log,
                                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        register_engine(engine_process)
        owned_process = engine_process
        deadline = time.monotonic() + 1080
        try:
            while owned_process.poll() is None:
                if cancel_event.is_set():
                    raise RuntimeError("Image generation cancelled.")
                with progress_lock:
                    read_cli_progress()
                if time.monotonic() >= deadline:
                    raise RuntimeError("Timed out while generating the GPU image.")
                time.sleep(0.25)
            with progress_lock:
                read_cli_progress()
            if cancel_event.is_set():
                raise RuntimeError("Image generation cancelled.")
            if owned_process.returncode != 0 or not output.is_file() or output.stat().st_size == 0:
                raise RuntimeError("The GPU image engine did not produce an image.")
            set_phase("savingImage")
            output.replace(destination)
        finally:
            stop_engine()
            with progress_lock:
                preview_reader = None


@app.get("/health")
def health():
    process = engine_process
    running = process is not None and process.poll() is None
    with progress_lock:
        if preview_reader:
            read_cli_progress()
        else:
            read_sampling()
        current_progress = dict(progress) if progress else None
    return {"available": installed(), "ready": installed(), "loaded": running and engine_ready,
            "loading": running and not engine_ready, "progress": current_progress,
            "busy": generation_lock.locked(), "cancelSupported": True,
            "engine": "stable-diffusion.cpp CUDA / Qwen Image 2.1 Q6", "gpuResident": True}


@app.get("/preview")
def image_preview(id: str, request: HttpRequest):
    with progress_lock:
        if preview_reader:
            read_cli_progress()
        cached = preview_cache if progress and progress["id"] == id else None
        if not cached or cached["id"] != id or progress["phase"] not in ("creating", "savingImage"):
            raise HTTPException(404, "No live preview is available for this image.")
        etag = f'"{id}-{cached["revision"]}"'
        headers = {"Cache-Control": "no-store", "ETag": etag,
                   "X-Preview-Revision": str(cached["revision"])}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)
        return Response(content=cached["data"], media_type="image/png", headers=headers)


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
        cancel_event.clear()
        try:
            if job.id in cancelled_jobs:
                cancel_event.set()
                set_phase("cancelled", job.id, "Image generation cancelled before engine start.")
                raise RuntimeError("Image generation cancelled before engine start.")
            persist_runner_state(busy=True, request=job.model_dump() if hasattr(job, "model_dump") else job.dict())
            set_phase("loadingImage", job.id)
            # The compatibility server treats LoRA tags literally and supports
            # prompt-embedded native args. Keep its existing semantics for those
            # uncommon prompts; CLI resolves tags before loading a model.
            compatibility_prompt = "<lora:" in prompt or "<sd_cpp_extra_args>" in prompt
            if os.getenv("SEEK_IMAGE_ENGINE_MODE", "cli") != "server" and CLI_ENGINE.is_file() and not compatibility_prompt:
                cli_generate(job, prompt, destination, job.livePreview)
                return {"file": destination.name, "width": job.width, "height": job.height,
                        "seed": job.seed if job.seed is not None else 42}
            start_engine()
            set_phase("creating")
            body = {"prompt": prompt, "size": f"{job.width}x{job.height}", "n": 1, "output_format": "png"}
            extra = {"sample_params": {"sample_steps": job.steps}}
            if job.seed is not None:
                extra["seed"] = job.seed
            body["prompt"] += " <sd_cpp_extra_args>" + json.dumps(extra) + "</sd_cpp_extra_args>"
            begin_sampling(job)
            result = request_json(f"{ENGINE_URL}/v1/images/generations", body, timeout=900)
            if cancel_event.is_set():
                raise RuntimeError("Image generation cancelled.")
            image_data = result.get("data", [{}])[0].get("b64_json")
            if not image_data:
                raise RuntimeError("The GPU image engine returned no image.")
            set_phase("savingImage")
            destination.write_bytes(base64.b64decode(image_data))
            return {"file": destination.name, "width": job.width, "height": job.height, "seed": job.seed}
        except Exception as error:
            set_phase("cancelled" if cancel_event.is_set() else "error", error=str(error))
            raise HTTPException(503, str(error)) from error
        finally:
            persist_runner_state(busy=False)


class Cancellation(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9-]{36}$")


@app.post("/cancel")
def cancel_generation(request: Cancellation):
    with progress_lock:
        if not progress or progress["id"] != request.id:
            if generation_lock.locked():
                raise HTTPException(409, "This image job does not own the engine.")
            cancelled_jobs.add(request.id)
            persist_runner_state(cancelledIds=sorted(cancelled_jobs))
            return {"accepted": True, "id": request.id, "beforeStart": True}
        if not generation_lock.locked() or progress["phase"] in ("savingImage", "idle", "error", "cancelled"):
            raise HTTPException(409, "The image is already finishing or has finished.")
        cancel_event.set()
        cancelled_jobs.add(request.id)
    persist_runner_state(cancelRequested=True, cancelledIds=sorted(cancelled_jobs))
    # CLI checks this event every 250 ms. Server HTTP is blocking, so stop only
    # this runner's currently owned process to interrupt that request.
    if preview_reader is None:
        stop_engine()
    return {"accepted": True, "id": request.id}


@app.post("/unload")
def unload():
    # Handoff waits for an in-flight image before VRAM is released.
    with generation_lock:
        set_phase("releasingImage")
        stop_engine()
        set_phase("idle")
    return {"released": True}
