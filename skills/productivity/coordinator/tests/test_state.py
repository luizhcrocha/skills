"""The state CLI beyond decisions: what it tells a coordinator that lost its context, and what it keeps for it."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
STATE = str(SKILL / "scripts" / "state.py")


class Fleet(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "coordinator"
        self.addCleanup(self._tmp.cleanup)
        self.ok("init", "--project", "p", "--goal", "g")
        self.ok("milestone", "m1", "--title", "Usage records")
        self.ok("milestone", "m2", "--title", "Verify and ship")

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, STATE, str(self.root), *args, "--no-render"], capture_output=True, text=True, timeout=20)

    def ok(self, *args: str) -> str:
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def refused(self, *args: str) -> str:
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 1, result.stdout)
        return result.stderr

    def state(self) -> dict:
        return json.loads((self.root / "state.json").read_text())


class ShowTest(Fleet):
    def test_show_ends_with_the_commands_and_the_values_they_take(self):
        out = self.ok("show")
        for word in ["decision ID", "roadblock ID", "--severity warning|serious|critical", "--needs user|coordinator|worker",
                     "--kind spawned|reported|blocked|resolved|asked|decision|note|integrated",
                     "--status blocked|done|failed|queued|running|stopped", "--skill implement|diagnosing-bugs|prototype|research|tdd|none",
                     "--model opus|sonnet|haiku|fable", "--kind decision|input|secret|action"]:
            self.assertIn(word, out)

    def test_show_lists_the_milestones_by_id(self):
        out = self.ok("show")
        self.assertIn("m1 Usage records (0/0)", out)
        self.assertIn("m2 Verify and ship (0/0)", out)


class AgentTest(Fleet):
    def test_a_worker_on_an_unknown_milestone_is_refused_with_the_ones_there_are(self):
        said = self.refused("agent", "a1", "--task", "t", "--milestone", "m9")
        self.assertIn("unknown milestone 'm9'", said)
        self.assertIn("m1, m2", said)
        self.assertEqual(self.state()["agents"], [])
        self.ok("agent", "a1", "--task", "t", "--milestone", "m1")
        self.assertIn("unknown milestone 'm9'", self.refused("agent", "a1", "--milestone", "m9"))

    def test_recording_a_worker_says_the_id_its_brief_carries(self):
        out = self.ok("agent", "a1", "--task", "t", "--milestone", "m1", "--name", "invoice-gen")
        self.assertIn("recorded a1 (invoice-gen)", out)
        self.assertIn("your id is a1", out)
        self.assertIn(str(self.root / "brief.md"), out)

    def test_a_worker_sent_back_after_its_report_starts_a_new_round(self):
        self.ok("agent", "a1", "--task", "t", "--milestone", "m1")
        self.assertEqual(self.state()["agents"][0]["rounds"], 1)
        self.ok("agent", "a1", "--status", "done", "--tokens", "100")
        self.ok("agent", "a1", "--status", "running", "--log", "sent back: the probe found an open route")
        self.ok("agent", "a1", "--status", "running")
        self.ok("agent", "a1", "--status", "done", "--tokens", "180")
        self.ok("agent", "a1", "--status", "running")
        a = self.state()["agents"][0]
        self.assertEqual((a["rounds"], a["tokens"]), (3, 180))
        self.assertIn("round 3", self.ok("show"))


class BriefTest(Fleet):
    def test_the_shared_brief_is_written_once_with_this_fleets_paths(self):
        brief = (self.root / "brief.md").read_text()
        self.assertIn(str(SKILL / "scripts" / "chat.py"), brief)
        self.assertIn(str(self.root), brief)
        self.assertNotIn("{", brief)
        for heading in ["## Standards", "## Lane", "## Chat", "## Report", "## This fleet"]:
            self.assertIn(heading, brief)

    def test_what_the_coordinator_added_is_kept(self):
        path = self.root / "brief.md"
        path.write_text(path.read_text() + "\nThe dev server on :8787 stays up.\n")
        self.ok("set", "--now", "later")
        self.assertIn("The dev server on :8787 stays up.", path.read_text())

    def test_a_fleet_from_before_the_brief_gets_one(self):
        (self.root / "brief.md").unlink()
        self.ok("set", "--now", "later")
        self.assertTrue((self.root / "brief.md").exists())


if __name__ == "__main__":
    unittest.main()
