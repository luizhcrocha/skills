"""The state CLI beyond decisions: what it tells a coordinator that lost its context, and what it keeps for it."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
STATE = str(SKILL / "scripts" / "state.py")

# The registry of fleets is this machine's; the tests get one of their own.
os.environ["FLEET_HOME"] = tempfile.mkdtemp(prefix="fleet-home-")


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


class StepTest(Fleet):
    def setUp(self):
        super().setUp()
        for id_, title in [("l1", "billing: push master"), ("l0", "usage: the repair for 12 stale cases"), ("l2", "usage: deploy")]:
            self.ok("step", id_, "--milestone", "m1", "--title", title)

    def steps(self, milestone: str = "m1") -> list[tuple[str, str]]:
        return [(s["id"], s["title"]) for m in self.state()["roadmap"] if m["id"] == milestone for s in m["steps"]]

    def test_a_known_step_takes_a_new_title(self):
        self.ok("step", "l0", "--title", "usage: five case pass changes with migration 0081", "--status", "current")
        step = next(s for s in self.state()["roadmap"][0]["steps"] if s["id"] == "l0")
        self.assertEqual((step["title"], step["status"]), ("usage: five case pass changes with migration 0081", "current"))

    def test_steps_are_put_in_the_order_of_their_turn(self):
        self.ok("step", "l0", "--before", "l1")
        self.assertEqual([s[0] for s in self.steps()], ["l0", "l1", "l2"])
        self.ok("step", "l0", "--after", "l2")
        self.assertEqual([s[0] for s in self.steps()], ["l1", "l2", "l0"])
        self.ok("step", "l9", "--milestone", "m1", "--title", "infra: rebuild the index", "--before", "l2")
        self.assertEqual([s[0] for s in self.steps()], ["l1", "l9", "l2", "l0"])

    def test_a_place_is_among_the_steps_of_the_same_milestone(self):
        self.ok("step", "s1", "--milestone", "m2", "--title", "elsewhere")
        self.assertIn("is in m2", self.refused("step", "l0", "--before", "s1"))
        self.assertIn("unknown step 'l7'", self.refused("step", "l0", "--after", "l7"))
        self.assertIn("itself", self.refused("step", "l0", "--before", "l0"))
        self.assertEqual([s[0] for s in self.steps()], ["l1", "l0", "l2"])

    def test_a_step_stays_in_its_milestone(self):
        self.assertIn("stays in m1", self.refused("step", "l0", "--milestone", "m2"))
        self.ok("step", "l0", "--milestone", "m1", "--title", "same milestone, new words")

    def test_a_step_queued_in_error_is_removed_and_the_log_says_so(self):
        self.ok("step", "l2", "--remove", "queued twice: l0 is the same landing")
        self.assertEqual([s[0] for s in self.steps()], ["l1", "l0"])
        event = self.state()["events"][-1]
        self.assertEqual((event["kind"], event["text"]), ("note", "Step l2 removed (usage: deploy): queued twice: l0 is the same landing"))
        self.assertIn("unknown step 'l2'", self.refused("step", "l2", "--remove", "again"))


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


class ParkTest(Fleet):
    def test_park_stops_every_live_row_in_one_command_and_says_why(self):
        for a, status in [("a1", "running"), ("a2", "queued"), ("a3", "done")]:
            self.ok("agent", a, "--task", "t", "--milestone", "m1")
            self.ok("agent", a, "--status", status)
        self.ok("park", "Luiz paused the UI work")
        self.assertEqual([a["status"] for a in self.state()["agents"]], ["stopped", "stopped", "done"])
        self.assertEqual(self.state()["events"][-1]["text"], "Stopped a1, a2: Luiz paused the UI work")
        self.assertIn("no worker row is running", self.refused("park", "again"))

    def test_park_can_name_the_workers(self):
        for a in ("a1", "a2"):
            self.ok("agent", a, "--task", "t", "--milestone", "m1")
        self.ok("park", "--agent", "a2", "its lane was dropped")
        self.assertEqual([a["status"] for a in self.state()["agents"]], ["running", "stopped"])
        self.assertIn("unknown agent 'a9'", self.refused("park", "--agent", "a9", "x"))

    def test_a_paused_fleet_with_running_rows_is_warned_on_every_command(self):
        self.ok("agent", "a1", "--task", "t", "--milestone", "m1")
        said = self.run_cli("set", "--status", "paused")
        self.assertIn("a1 still read as running/queued/blocked while the fleet is paused", said.stderr)
        self.assertIn("park", said.stderr)
        self.ok("park", "paused")
        self.assertNotIn("still read as", self.run_cli("event", "x").stderr)

    def test_a_now_line_is_stamped_when_it_is_said(self):
        self.assertNotIn("now_at", self.state())
        self.ok("set", "--now", "l9 deploying")
        self.assertTrue(self.state()["now_at"])

    def test_a_note_command_points_at_event(self):
        self.assertIn("event --kind note TEXT", self.refused("note", "x"))


class MeasuredTest(unittest.TestCase):
    """A worker row that names its task id takes its tokens and duration from the worker's transcript."""

    def test_tokens_and_duration_come_from_the_workers_transcript(self):
        config, tmp = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        root = tmp / "-home-x" / "s1" / "scratchpad" / "coordinator"
        sub = config / "projects" / "-home-x" / "s1" / "subagents"
        sub.mkdir(parents=True)
        env = {**os.environ, "CLAUDE_CONFIG_DIR": str(config)}
        run = lambda *a: subprocess.run([sys.executable, STATE, str(root), *a, "--no-render"], capture_output=True, text=True, env=env, timeout=20)  # noqa: E731
        usage = lambda n: {"input_tokens": 10, "cache_read_input_tokens": n, "cache_creation_input_tokens": 5, "output_tokens": 100}  # noqa: E731
        lines = [{"timestamp": "2026-09-29T10:00:00.000Z", "message": {"id": "m1", "usage": usage(1000)}},
                 {"timestamp": "2026-09-29T10:02:30.000Z", "message": {"id": "m2", "usage": usage(5000)}}]
        (sub / "agent-abc123.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n")
        for args in (["init", "--project", "p", "--goal", "g"], ["milestone", "m1", "--title", "M"],
                     ["agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "abc123"]):
            self.assertEqual(run(*args).returncode, 0)
        a = json.loads((root / "state.json").read_text())["agents"][0]
        self.assertEqual((a["tokens"], a["duration_ms"]), (5115, 150000))
        self.assertEqual(run("agent", "a1", "--status", "done", "--tokens", "7").returncode, 0)
        self.assertEqual(json.loads((root / "state.json").read_text())["agents"][0]["tokens"], 7, "a figure given by hand stays")


class KeepAndNextTest(Fleet):
    def test_step_next_takes_the_number_after_the_highest(self):
        self.ok("step", "l16", "--milestone", "m1", "--title", "a")
        self.ok("step", "l3", "--milestone", "m2", "--title", "b")
        self.assertIn("recorded step l17", self.ok("step", "next", "--milestone", "m1", "--title", "c"))
        self.assertIn("recorded step l18", self.ok("step", "next", "--milestone", "m2", "--title", "d"))
        self.assertEqual([x["id"] for x in self.state()["roadmap"][0]["steps"]], ["l16", "l17"])

    def test_kept_items_are_shown_and_dropped_with_a_reason(self):
        self.ok("keep", "hunk-open", "pglite.worker.ts: hold the ENOENT rejection (a80's hunk)")
        self.assertIn("kept hunk-open: pglite.worker.ts", self.ok("show"))
        self.ok("keep", "hunk-open", "--drop", "landed in l3")
        self.assertEqual(self.state()["kept"], [])
        self.assertIn("landed in l3", self.state()["events"][-1]["text"])
        self.assertIn("nothing kept", self.refused("keep", "x", "--drop", "y"))


class ManagerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "manager"
        self.addCleanup(self._tmp.cleanup)

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, STATE, str(self.root), *args, "--no-render"], capture_output=True, text=True, timeout=20)

    def test_a_managers_ledger_says_so_and_holds_what_every_fleet_follows(self):
        result = self.run_cli("init", "--role", "manager", "--project", "this machine", "--goal", "land the billing work in order")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.root / "state.json").read_text())["role"], "manager")
        standing = (self.root / "standing.md").read_text()
        for heading in ["## What the user decided", "## Who owns what", "## Landings and deploys"]:
            self.assertIn(heading, standing)
        (self.root / "standing.md").write_text(standing + "\nNever export the infra token in a deploy shell.\n")
        self.assertEqual(self.run_cli("set", "--now", "x").returncode, 0)
        self.assertIn("Never export the infra token", (self.root / "standing.md").read_text())
        self.assertIn("this machine [running, manager]", self.run_cli("show").stdout)

    def test_a_managers_step_names_the_coordinator_whose_turn_it_is(self):
        self.run_cli("init", "--role", "manager", "--project", "this machine", "--goal", "g")
        self.run_cli("milestone", "landings", "--title", "Landings and deploys")
        step = self.run_cli("step", "l1", "--milestone", "landings", "--title", "infra: push master", "--agent", "infra", "--status", "current")
        self.assertEqual(step.returncode, 0, step.stderr)
        render = subprocess.run([sys.executable, STATE, str(self.root), "set", "--now", "infra has the turn"], capture_output=True, text=True)
        self.assertEqual(render.returncode, 0, render.stderr)

    def test_a_managers_events_and_decisions_name_a_fleet(self):
        self.run_cli("init", "--role", "manager", "--project", "this machine", "--goal", "g")
        for args in (["event", "--kind", "integrated", "--agent", "billing", "l2 landed as 1d5b1b1a"],
                     ["decision", "d1", "--kind", "action", "--title", "Deploy billing", "--question", "q", "--why", "w",
                      "--manual", "just deploy billing", "--agent", "billing"]):
            result = self.run_cli(*args)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_coordinators_step_names_one_of_its_workers(self):
        self.run_cli("init", "--project", "p", "--goal", "g")
        self.run_cli("milestone", "m1", "--title", "M")
        refused = self.run_cli("step", "s1", "--milestone", "m1", "--title", "T", "--agent", "nobody")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("unknown agent 'nobody'", refused.stderr)

    def test_a_coordinators_ledger_has_no_standing_file(self):
        self.run_cli("init", "--project", "p", "--goal", "g")
        self.assertFalse((self.root / "standing.md").exists())


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
