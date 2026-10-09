"""Runner regression checks without starting an engine or loading GPU weights."""
import base64
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

source = Path(__file__).resolve().parents[2] / "tools" / "qwen-image-service.py"
spec = importlib.util.spec_from_file_location("seek_image_runner_test", source)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        runner.engine_process = None
        runner.engine_ready = False
        runner.progress = None
        runner.preview_reader = None
        runner.preview_cache = None
        legacy = patch.dict(runner.os.environ, {"SEEK_IMAGE_ENGINE_MODE": "server"})
        legacy.start()
        self.addCleanup(legacy.stop)
        no_gpu = patch.object(runner.subprocess, "Popen", side_effect=AssertionError("A fixture attempted to load GPU weights"))
        no_gpu.start()
        self.addCleanup(no_gpu.stop)

    def test_health_waits_for_model_readiness(self):
        runner.engine_process = Mock()
        runner.engine_process.poll.return_value = None
        with patch.object(runner, "installed", return_value=True):
            self.assertFalse(runner.health()["loaded"])
            self.assertTrue(runner.health()["loading"])
            runner.engine_ready = True
            self.assertTrue(runner.health()["loaded"])
            self.assertFalse(runner.health()["loading"])
            runner.engine_process.poll.return_value = 1
            self.assertFalse(runner.health()["loaded"])

    def test_real_stages_and_detail_setting(self):
        with tempfile.TemporaryDirectory() as output:
            job = runner.Generation(id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", prompt="Runner fixture",
                                    outputDir=output, width=1024, height=1024, steps=24, seed=42)
            phases, payloads = [], []
            original = runner.set_phase
            def observe(phase, *args, **kwargs):
                phases.append(phase)
                return original(phase, *args, **kwargs)
            def request(url, data, timeout):
                payloads.append(data)
                self.assertEqual(runner.progress["phase"], "creating")
                return {"data": [{"b64_json": base64.b64encode(b"fixture-png").decode()}]}
            with patch.object(runner, "start_engine"), patch.object(runner, "request_json", side_effect=request), \
                 patch.object(runner, "set_phase", side_effect=observe):
                result = runner.generate(job)
            self.assertEqual(phases, ["loadingImage", "creating", "savingImage"])
            self.assertEqual(Path(output, result["file"]).read_bytes(), b"fixture-png")
            extra = json.loads(payloads[0]["prompt"].split("<sd_cpp_extra_args>")[1].split("</sd_cpp_extra_args>")[0])
            self.assertEqual(extra["sample_params"]["sample_steps"], 24)
            self.assertEqual(extra["seed"], 42)
            self.assertNotIn("prompt", runner.progress)

    def test_failure_is_visible_and_keeps_job_identity(self):
        with tempfile.TemporaryDirectory() as output:
            job = runner.Generation(id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", prompt="Runner fixture",
                                    outputDir=output, width=1024, height=1024, steps=30)
            with patch.object(runner, "start_engine", side_effect=RuntimeError("Fixture loading failure")):
                with self.assertRaises(runner.HTTPException):
                    runner.generate(job)
            self.assertEqual(runner.progress["phase"], "error")
            self.assertEqual(runner.progress["id"], job.id)
            self.assertEqual(runner.progress["error"], "Fixture loading failure")

    def test_unload_releases_readiness_and_reports_idle(self):
        runner.set_phase("creating", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        runner.engine_ready = True
        self.assertTrue(runner.unload()["released"])
        self.assertFalse(runner.engine_ready)
        self.assertEqual(runner.progress["phase"], "idle")


if __name__ == "__main__":
    unittest.main(verbosity=2)
