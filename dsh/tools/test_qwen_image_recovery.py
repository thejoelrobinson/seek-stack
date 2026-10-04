"""Journal and cancellation fault fixtures; never starts or stops real engines."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("image_recovery_runner", Path(__file__).with_name("qwen-image-service.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        for name, value in (("ROOT", self.root), ("STATE_FILE", self.root / "runner-state.json"),
                            ("durability_enabled", True), ("runner_state", None), ("progress", None),
                            ("cancelled_jobs", set()), ("engine_process", None), ("preview_reader", None)):
            control = patch.object(runner, name, value)
            control.start()
            self.addCleanup(control.stop)
        runner.cancel_event.clear()
        self.addCleanup(runner.cancel_event.clear)
        for name in ("Popen",):
            guard = patch.object(runner.subprocess, name, side_effect=AssertionError("Real engine launch forbidden"))
            guard.start()
            self.addCleanup(guard.stop)
        guard = patch.object(runner.os, "kill", side_effect=AssertionError("Real process termination forbidden"))
        guard.start()
        self.addCleanup(guard.stop)
        self.id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

    def write_state(self, **values):
        runner.STATE_FILE.write_text(json.dumps({"version": 1, **values}), encoding="utf-8")

    def test_every_phase_is_durable_without_preview_pixels(self):
        for phase in ("loadingImage", "creating", "savingImage", "releasingImage", "idle"):
            runner.set_phase(phase, self.id)
            saved = json.loads(runner.STATE_FILE.read_text())
            self.assertEqual(saved["progress"]["phase"], phase)
            self.assertEqual(saved["progress"]["id"], self.id)
            self.assertNotIn("data", saved["progress"])
        self.assertTrue(Path(str(runner.STATE_FILE) + ".bak").is_file())

    def test_verified_owned_orphan_is_stopped_before_recovery(self):
        identity = {"pid": 12345, "image": str(runner.CLI_ENGINE.resolve()), "created": 9}
        self.write_state(engine=identity, busy=True, progress={"id": self.id, "phase": "creating"})
        with patch.object(runner, "process_identity", side_effect=[identity, None, None]), \
             patch.object(runner.os, "kill") as kill:
            runner.recover_runner_state()
        kill.assert_called_once_with(12345, runner.signal.SIGTERM)
        self.assertEqual(runner.progress["phase"], "interrupted")
        self.assertFalse(runner.runner_state["busy"])
        self.assertIsNone(runner.runner_state["engine"])

    def test_reused_pid_and_foreign_executable_are_never_stopped(self):
        identity = {"pid": 12345, "image": str(runner.CLI_ENGINE.resolve()), "created": 9}
        for observed in ({**identity, "created": 10}, {**identity, "image": "foreign.exe"}, None):
            self.write_state(engine=identity, progress={"id": self.id, "phase": "loadingImage"})
            with patch.object(runner, "process_identity", return_value=observed):
                runner.recover_runner_state()
            self.assertIsNone(runner.runner_state["engine"])

    def test_corrupt_original_is_preserved_and_valid_backup_recovered(self):
        self.write_state(progress={"id": self.id, "phase": "creating"})
        Path(str(runner.STATE_FILE) + ".bak").write_bytes(runner.STATE_FILE.read_bytes())
        runner.STATE_FILE.write_text("broken journal", encoding="utf-8")
        runner.recover_runner_state()
        preserved = list(self.root.glob("runner-state.json.corrupt-*"))
        self.assertEqual(len(preserved), 1)
        self.assertEqual(preserved[0].read_text(), "broken journal")
        self.assertEqual(runner.progress["id"], self.id)

    def test_cancellation_before_engine_acceptance_survives_reload(self):
        result = runner.cancel_generation(runner.Cancellation(id=self.id))
        self.assertTrue(result["beforeStart"])
        runner.cancelled_jobs.clear()
        runner.recover_runner_state()
        self.assertIn(self.id, runner.cancelled_jobs)
        job = runner.Generation(id=self.id, prompt="Cancelled fixture", outputDir=str(self.root), width=1024, height=1024, steps=30)
        with patch.object(runner, "start_engine", side_effect=AssertionError("Cancelled work cannot launch")):
            with self.assertRaises(runner.HTTPException):
                runner.generate(job)
        self.assertEqual(runner.progress["phase"], "cancelled")

    def test_wrong_owner_cancel_cannot_interrupt_a_live_job(self):
        runner.progress = {"id": self.id, "phase": "creating"}
        runner.generation_lock.acquire()
        try:
            with self.assertRaises(runner.HTTPException) as error:
                runner.cancel_generation(runner.Cancellation(id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"))
            self.assertEqual(error.exception.status_code, 409)
            self.assertFalse(runner.cancel_event.is_set())
        finally:
            runner.generation_lock.release()

    def test_active_cli_cancel_sets_event_without_racing_process_handle(self):
        runner.progress = {"id": self.id, "phase": "creating"}
        runner.preview_reader = Mock()
        runner.generation_lock.acquire()
        try:
            with patch.object(runner, "stop_engine", side_effect=AssertionError("CLI observes its event itself")):
                result = runner.cancel_generation(runner.Cancellation(id=self.id))
            self.assertTrue(result["accepted"])
            self.assertTrue(runner.cancel_event.is_set())
        finally:
            runner.generation_lock.release()

    def test_unattested_process_cannot_be_claimed(self):
        process = Mock(pid=12345)
        process.poll.return_value = None
        with patch.object(runner, "process_identity", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "ownership"):
                runner.register_engine(process)
        process.terminate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
