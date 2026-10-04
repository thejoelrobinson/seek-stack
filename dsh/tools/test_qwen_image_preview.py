"""Live preview isolation and process checks, without loading GPU weights."""
import importlib.util
import base64
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("image_preview_runner", Path(__file__).with_name("qwen-image-service.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def png(width=2, height=2, color=128):
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    pixels = (b"\x00" + bytes([color, 64, 192, 255]) * width) * height
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.file = self.root / "preview.png"
        self.log, self.err = self.root / "engine.log", self.root / "engine.err"
        self.log.write_bytes(b"old generation 20/20 - 1s/it\r")
        self.err.write_bytes(b"")
        self.id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        runner.engine_process = None
        runner.engine_ready = False
        runner.progress = None
        runner.sampling_reader = None
        runner.preview_reader = None
        runner.preview_cache = None
        no_gpu = patch.object(runner.subprocess, "Popen", side_effect=AssertionError("A fixture attempted to load GPU weights"))
        no_gpu.start()
        self.addCleanup(no_gpu.stop)
        no_server = patch.object(runner, "start_engine", side_effect=AssertionError("A fixture attempted to start the engine"))
        no_server.start()
        self.addCleanup(no_server.stop)

    def sample(self, step=4):
        return {"step": step, "total": 8, "updatedAt": 1234}

    def request(self, etag=None):
        headers = [] if etag is None else [(b"if-none-match", etag.encode())]
        return runner.HttpRequest({"type": "http", "headers": headers})

    def cached(self):
        runner.set_phase("creating", self.id)
        reader = runner.PreviewFileReader(self.id, 8, self.root / "preview-%03d.png")
        (self.root / "preview-000.png").write_bytes(png())
        reader.read(self.sample())
        return reader

    def test_complete_bounded_png_only(self):
        image = png()
        self.assertEqual(runner.preview_png_dimensions(image), (2, 2))
        for invalid in (image[:-1], image + b"extra", image[:40] + b"bad crc" + image[47:],
                        png(width=513), b"x" * (runner.PREVIEW_MAX_BYTES + 1)):
            self.assertIsNone(runner.preview_png_dimensions(invalid))

    def test_partial_overwrite_keeps_previous_valid_preview(self):
        reader = self.cached()
        first = dict(runner.preview_cache)
        (self.root / "preview-001.png").write_bytes(png(color=240)[:-12])
        reader.read(self.sample(8))
        self.assertEqual(runner.preview_cache, first)
        (self.root / "preview-001.png").write_bytes(png(color=240))
        reader.read(self.sample(8))
        self.assertEqual(runner.preview_cache["revision"], 2)
        self.assertEqual(runner.preview_cache["step"], 8)
        self.assertNotEqual(runner.preview_cache["data"], first["data"])
        self.assertFalse((self.root / "preview-000.png").exists())

    def test_duplicate_file_and_unsampled_steps_do_no_extra_read(self):
        reader = self.cached()
        first = dict(runner.preview_cache)
        with patch.object(Path, "open", side_effect=AssertionError("Repeated file was read")):
            reader.read(self.sample(8))
        self.assertEqual(runner.preview_cache, first)

    def test_preview_step_comes_from_callback_index_before_log_catches_up(self):
        reader = self.cached()
        (self.root / "preview-001.png").write_bytes(png(color=240))
        reader.read(self.sample(7))
        self.assertEqual(runner.preview_cache["step"], 8)
        self.assertEqual(runner.preview_cache["revision"], 2)

    def test_preview_endpoint_is_owned_conditional_and_not_cached(self):
        self.cached()
        result = runner.image_preview(self.id, self.request())
        self.assertEqual(result.body, png())
        self.assertEqual(result.headers["cache-control"], "no-store")
        self.assertEqual(result.headers["content-type"], "image/png")
        unchanged = runner.image_preview(self.id, self.request(result.headers["etag"]))
        self.assertEqual(unchanged.status_code, 304)
        self.assertEqual(unchanged.body, b"")
        with self.assertRaises(runner.HTTPException) as error:
            runner.image_preview("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", self.request())
        self.assertEqual(error.exception.status_code, 404)

    def test_new_job_error_and_unload_erase_preview(self):
        for phase in ("error", "idle"):
            self.cached()
            runner.set_phase(phase)
            self.assertIsNone(runner.preview_cache)
            with self.assertRaises(runner.HTTPException):
                runner.image_preview(self.id, self.request())
        self.cached()
        runner.set_phase("loadingImage", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
        self.assertIsNone(runner.preview_cache)
        self.cached()
        runner.unload()
        self.assertIsNone(runner.preview_cache)

    def run_cli(self, enabled):
        job = runner.Generation(id=self.id, prompt="Fixture with spaces and\na newline", outputDir=str(self.root),
                                width=1024, height=768, steps=8, seed=93, livePreview=enabled)
        destination = self.root / ("on.png" if enabled else "off.png")
        command, phases = [], []
        owner = self

        class Process:
            returncode = 0
            tick = 0

            def poll(self):
                self.tick += 1
                if self.tick == 1:
                    with owner.log.open("ab") as stream:
                        stream.write(b"[INFO] generate_image 1024x768\n")
                    return None
                if self.tick == 2:
                    with owner.log.open("ab") as stream:
                        stream.write(b"\r4/8 - 2.12s/it\r")
                    if enabled:
                        Path(command[command.index("--preview-path") + 1].replace("%03d", "000")).write_bytes(png())
                    return None
                if self.tick == 3:
                    with owner.log.open("ab") as stream:
                        stream.write(b"\r8/8 - 2.1s/it\rdecode_first_stage completed, taking 1s\n")
                    Path(command[command.index("--output") + 1]).write_bytes(png(16, 16))
                return 0

        def launch(args, **kwargs):
            command.extend(args)
            prompt = Path(args[args.index("--prompt-file") + 1])
            self.assertEqual(prompt.read_text(encoding="utf-8"), job.prompt)
            self.assertNotIn(job.prompt, args)
            return Process()

        def observe_sleep(_):
            phases.append(dict(runner.progress))

        runner.set_phase("loadingImage", self.id)
        with patch.object(runner, "ROOT", self.root), patch.object(runner, "engine_log", self.log), \
             patch.object(runner, "engine_error_log", self.err), patch.object(runner, "installed", return_value=True), \
             patch.object(runner, "CLI_ENGINE", self.file), patch.object(runner.subprocess, "Popen", side_effect=launch), \
             patch.object(runner, "register_engine"), patch.object(runner.time, "sleep", side_effect=observe_sleep):
            self.file.touch()
            runner.cli_generate(job, job.prompt, destination, enabled)
        self.assertEqual(destination.read_bytes(), png(16, 16))
        self.assertEqual(runner.progress["phase"], "savingImage")
        self.assertEqual(list((self.root / "previews").iterdir()), [])
        self.assertIsNone(runner.engine_process)
        self.assertFalse(runner.engine_ready)
        self.assertEqual([state["phase"] for state in phases], ["creating", "creating"])
        self.assertEqual(phases[1]["sampling"]["step"], 4)
        return command, phases

    def test_cli_projection_uses_same_settings_and_cleans_private_files(self):
        command, phases = self.run_cli(True)
        self.assertEqual(command[command.index("--preview") + 1], "proj")
        self.assertEqual(command[command.index("--preview-interval") + 1], "4")
        for option, value in (("--backend", "cuda0"), ("--params-backend", "cuda0"), ("--auto-fit", "off"),
                              ("--width", "1024"), ("--height", "768"), ("--steps", "8"), ("--seed", "93")):
            self.assertEqual(command[command.index(option) + 1], value)
        self.assertNotIn("--disable-image-metadata", command)
        self.assertNotIn("--taesd", command)
        self.assertEqual(phases[1]["preview"]["step"], 4)
        self.assertNotIn("data", phases[1]["preview"])
        self.assertEqual(runner.image_preview(self.id, self.request()).body, png())

    def test_preview_disabled_uses_cli_without_projection(self):
        command, phases = self.run_cli(False)
        self.assertNotIn("--preview", command)
        self.assertNotIn("--preview-path", command)
        self.assertIsNone(runner.preview_cache)
        self.assertNotIn("preview", phases[1])

    def test_cli_failure_cleanup_and_error_are_visible(self):
        job = runner.Generation(id=self.id, prompt="Failure fixture", outputDir=str(self.root),
                                width=1024, height=1024, steps=8)
        self.cached()
        self.file.touch()
        def fail(*args):
            raise RuntimeError("Fixture CLI failed")
        with patch.dict(runner.os.environ, {"SEEK_IMAGE_ENGINE_MODE": "cli"}), \
             patch.object(runner, "CLI_ENGINE", self.file), patch.object(runner, "cli_generate", side_effect=fail):
            with self.assertRaises(runner.HTTPException):
                runner.generate(job)
        self.assertEqual(runner.progress["phase"], "error")
        self.assertIsNone(runner.preview_cache)
        self.assertNotIn("preview", runner.progress)

    def test_generate_reports_actual_cli_default_seed_and_forwards_toggle(self):
        self.file.touch()
        job = runner.Generation(id=self.id, prompt="Default seed fixture", outputDir=str(self.root),
                                width=1024, height=1024, steps=8, livePreview=False)
        with patch.dict(runner.os.environ, {"SEEK_IMAGE_ENGINE_MODE": "cli"}), \
             patch.object(runner, "CLI_ENGINE", self.file), patch.object(runner, "cli_generate") as generate:
            result = runner.generate(job)
        self.assertEqual(result["seed"], 42)
        self.assertFalse(generate.call_args.args[-1])

    def test_literal_lora_and_embedded_args_retain_compatibility_server(self):
        self.file.touch()
        for prompt in ("Text saying <lora:literal:1>", "Fixture <sd_cpp_extra_args>{}</sd_cpp_extra_args>"):
            job = runner.Generation(id=self.id, prompt=prompt, outputDir=str(self.root),
                                    width=1024, height=1024, steps=8)
            with patch.dict(runner.os.environ, {"SEEK_IMAGE_ENGINE_MODE": "cli"}), \
                 patch.object(runner, "CLI_ENGINE", self.file), patch.object(runner, "cli_generate") as cli, \
                 patch.object(runner, "start_engine"), patch.object(runner, "request_json", 
                   return_value={"data": [{"b64_json": base64.b64encode(png()).decode()}]}) as server:
                runner.generate(job)
            cli.assert_not_called()
            self.assertIn(prompt, server.call_args.args[1]["prompt"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
