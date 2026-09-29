"""What a coordinator itself spent, read from its session's transcript."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import fleets  # noqa: E402
import spend  # noqa: E402

SESSION = "a61ed1b3-9b9b-409a-86d5-6176dc4d0cfc"
SLUG = "-home-luiz-repos-billing"


def said(id_: str, out: int, read: int = 0, write: int = 0, fresh: int = 0, **extra) -> str:
    return json.dumps({"type": "assistant", "isSidechain": False, **extra, "message": {"id": id_, "model": "claude-opus", "usage": {
        "input_tokens": fresh, "output_tokens": out, "cache_read_input_tokens": read, "cache_creation_input_tokens": write}}}) + "\n"


class Machine(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.root = base / "claude-1000" / SLUG / SESSION / "scratchpad" / "coordinator"
        self.root.mkdir(parents=True)
        self.transcript = base / "config" / "projects" / SLUG / f"{SESSION}.jsonl"
        self.transcript.parent.mkdir(parents=True)
        for key, value in {"CLAUDE_CONFIG_DIR": str(base / "config"), "FLEET_HOME": str(base / "registry")}.items():
            before = os.environ.get(key)
            os.environ[key] = value
            self.addCleanup(lambda k=key, b=before: os.environ.pop(k, None) if b is None else os.environ.__setitem__(k, b))
        spend.forget()

    def of(self) -> dict | None:
        return spend.of(self.root, wait=0)


class SpendTest(Machine):
    def test_a_session_spent_what_its_answers_used(self):
        self.transcript.write_text(said("m1", out=100, read=5000, write=300, fresh=2) + said("m2", out=50, read=6000))
        self.assertEqual(self.of(), {"output": 150, "input": 11302, "cached": 11000, "answers": 2})

    def test_an_answer_written_over_several_lines_counts_once_with_its_last_figures(self):
        self.transcript.write_text(said("m1", out=10, read=5000) + said("m1", out=80, read=5000) + said("m2", out=5, read=100))
        self.assertEqual(self.of(), {"output": 85, "input": 5100, "cached": 5100, "answers": 2})

    def test_only_the_sessions_own_answers_count(self):
        self.transcript.write_text(
            said("m1", out=100) + said("w1", out=900, isSidechain=True)
            + json.dumps({"type": "user", "message": {"content": 'the word "usage" in a prompt'}}) + "\n"
            + json.dumps({"type": "assistant", "message": {"id": "m3"}}) + "\n" + "not json\n")
        self.assertEqual(self.of(), {"output": 100, "input": 0, "cached": 0, "answers": 1})

    def test_what_is_appended_is_added_and_a_line_still_being_written_waits(self):
        self.transcript.write_text(said("m1", out=100))
        self.assertEqual(self.of()["output"], 100)
        with open(self.transcript, "a") as f:
            f.write(said("m2", out=40) + said("m3", out=7).rstrip("\n")[:30])
        self.assertEqual(self.of()["output"], 140)
        self.transcript.write_text(said("m1", out=100) + said("m2", out=40) + said("m3", out=7))
        self.assertEqual((self.of()["output"], self.of()["answers"]), (147, 3))

    def test_a_transcript_that_was_replaced_is_read_again_from_its_start(self):
        self.transcript.write_text(said("m1", out=100) + said("m2", out=40))
        self.assertEqual(self.of()["output"], 140)
        self.transcript.write_text(said("n1", out=9))
        self.assertEqual(self.of(), {"output": 9, "input": 0, "cached": 0, "answers": 1})

    def test_a_directory_that_is_no_sessions_scratchpad_has_none(self):
        self.assertIsNone(spend.of(Path(self._tmp.name) / "anywhere" / "coordinator", wait=0))
        self.assertIsNone(self.of(), "no transcript yet")

    def test_between_looks_the_file_is_left_alone(self):
        self.transcript.write_text(said("m1", out=100))
        self.assertEqual(spend.of(self.root, wait=60)["output"], 100)
        with open(self.transcript, "a") as f:
            f.write(said("m2", out=40))
        self.assertEqual(spend.of(self.root, wait=60)["output"], 100)
        self.assertEqual(spend.of(self.root, wait=0)["output"], 140)


class ViewTest(Machine):
    def test_a_fleets_page_is_sent_what_its_coordinator_spent_and_the_managers_what_each_did(self):
        self.transcript.write_text(said("m1", out=100, read=5000))
        state = {"project": "billing", "goal": "g", "status": "running", "now": "n", "agents": []}
        (self.root / "state.json").write_text(json.dumps(state))
        self.assertEqual(fleets.view(state, self.root)["spent"]["output"], 100)
        fleets.register(self.root, "https://box:1/", os.getpid())
        manager = Path(self._tmp.name) / "manager"
        manager.mkdir()
        view = fleets.view({"project": "m", "role": "manager"}, manager)
        self.assertEqual(view["coordinators"][0]["spent"], {"output": 100, "input": 5000, "cached": 5000, "answers": 1})
        self.assertIsNone(view["spent"], "the manager's own directory here is no session's scratchpad")


if __name__ == "__main__":
    unittest.main()
