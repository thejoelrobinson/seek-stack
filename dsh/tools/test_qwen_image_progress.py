"""Sampling telemetry checks using temporary logs, without loading GPU weights."""
import base64
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("image_progress_runner", Path(__file__).with_name("qwen-image-service.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class SamplingTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.log = Path(self.folder.name, "engine.log")
        self.err = Path(self.folder.name, "engine.err")
        self.log.write_bytes(b"previous job 30/30 - 2.12s/it\r")
        self.reader = runner.SamplingLogReader("current", 30, [self.log, self.err])
        runner.progress = None
        runner.sampling_reader = None
        runner.engine_process = None
        runner.preview_reader = None
        runner.preview_cache = None
        legacy = patch.dict(runner.os.environ, {"SEEK_IMAGE_ENGINE_MODE": "server"})
        legacy.start()
        self.addCleanup(legacy.stop)
        no_gpu = patch.object(runner.subprocess, "Popen", side_effect=AssertionError("A fixture attempted to load GPU weights"))
        no_gpu.start()
        self.addCleanup(no_gpu.stop)

    def append(self, value, path=None):
        with (path or self.log).open("ab") as stream:
            stream.write(value)

    def test_old_records_are_excluded(self):
        self.assertIsNone(self.reader.read())
        self.append(b"\r1/30 - 2.12s/it\r")
        sample = self.reader.read()
        self.assertEqual((sample["step"], sample["total"]), (1, 30))
        self.assertEqual(sample["secondsPerStep"], 2.12)

    def test_fragmented_ansi_and_carriage_returns(self):
        self.append(b"\x1b[32m12/30 - 2.")
        self.assertIsNone(self.reader.read())
        self.append(b"34s/it\x1b[0m\r")
        self.assertEqual(self.reader.read()["step"], 12)

    def test_invalid_totals_and_regressions_are_ignored(self):
        self.append(b"4/30 - 2s/it\r31/30 - 2s/it\r5/40 - 2s/it\r3/30 - 2s/it\r")
        sample = self.reader.read()
        self.assertEqual(sample["step"], 4)
        self.append(b"4/30 - 8s/it\r")
        self.assertEqual(self.reader.read(), sample)

    def test_iterations_per_second_are_converted(self):
        self.append(b"2/30 - 0.5it/s\n", self.err)
        self.assertEqual(self.reader.read()["secondsPerStep"], 2)

    def test_missing_and_truncated_logs(self):
        self.err.unlink(missing_ok=True)
        self.log.write_bytes(b"2/30 - 2s/it\r")
        self.assertEqual(self.reader.read()["step"], 2)

    def test_reads_are_bounded(self):
        self.append(b"x" * 70000 + b"\r7/30 - 2s/it\n")
        self.assertIsNone(self.reader.read())
        self.assertEqual(self.reader.read()["step"], 7)
        self.assertLessEqual(len(self.reader.tails[self.log]), 512)

    def test_health_tracks_only_the_current_creating_job(self):
        runner.set_phase("creating", "current")
        runner.sampling_reader = self.reader
        self.append(b"5/30 - 2s/it\n")
        self.assertEqual(runner.health()["progress"]["sampling"]["step"], 5)
        runner.set_phase("restoringChat")
        self.assertNotIn("sampling", runner.health()["progress"])
        runner.set_phase("creating", "other")
        runner.sampling_reader = self.reader
        self.assertNotIn("sampling", runner.health()["progress"])

    def test_generate_scopes_log_offsets_before_engine_request(self):
        job = runner.Generation(id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", prompt="Telemetry fixture",
                                outputDir=self.folder.name, width=1024, height=1024, steps=30)
        def request(*args, **kwargs):
            self.assertNotIn("sampling", runner.health()["progress"])
            self.append(b"12/30 - 2.12s/it\r")
            sample = runner.health()["progress"]
            self.assertEqual(sample["sampling"]["step"], 12)
            self.assertGreaterEqual(sample["sampling"]["updatedAt"], sample["phaseAt"])
            self.assertNotIn("prompt", sample)
            return {"data": [{"b64_json": base64.b64encode(b"fixture-png").decode()}]}
        with patch.object(runner, "engine_log", self.log), patch.object(runner, "engine_error_log", self.err), \
             patch.object(runner, "start_engine"), patch.object(runner, "request_json", side_effect=request):
            runner.generate(job)
        self.assertEqual(runner.progress["phase"], "savingImage")
        self.assertNotIn("sampling", runner.progress)


if __name__ == "__main__":
    unittest.main(verbosity=2)
