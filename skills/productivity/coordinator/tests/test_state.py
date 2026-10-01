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
os.environ["FLEET_DISCOVER"] = "0"


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

    def test_a_name_two_workers_share_is_refused_naming_the_id_first(self):
        self.ok("agent", "a1", "--task", "t", "--milestone", "m1", "--name", "n1")
        self.ok("agent", "a2", "--task", "t", "--milestone", "m1", "--name", "n2")
        said = self.refused("agent", "A1", "--task", "t", "--milestone", "m1", "--name", "n2")
        self.assertIn("agent A1 is called 'a1', which is also agent a1", said, "the same words on every run, whatever the hash seed")

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

    def test_a_now_line_not_said_again_is_pointed_out(self):
        self.assertNotIn("Now line", self.run_cli("event", "x").stderr, "init says it")
        state = self.state(); del state["now_at"]; (self.root / "state.json").write_text(json.dumps(state))
        said = self.run_cli("event", "x")
        self.assertIn("the page's Now line (never stamped)", said.stderr)
        self.ok("set", "--now", "l9 deploying")
        self.assertNotIn("Now line", self.run_cli("event", "y").stderr)

    def test_a_now_line_is_stamped_when_it_is_said(self):
        state = self.state(); del state["now_at"]; (self.root / "state.json").write_text(json.dumps(state))
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


class GrillTest(Fleet):
    def test_a_grilling_is_asked_answered_followed_up_and_done(self):
        self.assertIn("--title", self.refused("grill", "g1", "--ask", "a | b | c | d"))
        self.assertIn("why", self.refused("grill", "g1", "--title", "T", "--ask", "a | b | c"), "a recommendation comes with its reason")
        self.ok("grill", "g1", "--title", "Tab", "--ask", "Where | tab or sidebar? | tab | a tab opens first on a phone", "--ask", "Secrets | how? | refs | a value never passes the page")
        d = self.state()["decisions"][0]
        self.assertEqual((d["kind"], d["question"], [q["id"] for q in d["questions"]]), ("grill", "2 questions to answer", ["q1", "q2"]))
        self.assertEqual(self.state()["events"][-1]["kind"], "asked")
        self.ok("grill", "g1", "--answer", "Q1: a sidebar", "--of", "q1", "--ask", "Side | left or right? | left | the chat is on the right")
        d = self.state()["decisions"][0]
        self.assertEqual([(q["id"], q["status"], q["of"]) for q in d["questions"]], [("q1", "answered", None), ("q2", "open", None), ("q3", "open", "q1")])
        self.assertTrue(d["revised"])
        self.assertEqual(d["questions"][0]["reason"], "a tab opens first on a phone")
        self.ok("grill", "g1", "--reason", "Q2: refs resolve where the code reads them")
        self.assertEqual(self.state()["decisions"][0]["questions"][1]["reason"], "refs resolve where the code reads them")
        self.assertIn("still open", self.refused("grill", "g1", "--done", "x"))
        self.assertIn("Q3:", self.refused("grill", "g1", "--answer", "left"))
        self.ok("grill", "g1", "--drop", "Q2: settled in the session", "--answer", "Q3: left", "--done", "a left sidebar")
        d = self.state()["decisions"][0]
        self.assertEqual((d["status"], d["answer"]), ("decided", "a left sidebar"))

    def test_a_grilling_is_not_opened_with_decision(self):
        self.assertIn("grill command", self.refused("decision", "g2", "--kind", "grill", "--title", "t", "--question", "q", "--why", "w"))


class LinkTest(Fleet):
    def test_links_are_recorded_tied_to_a_decision_and_dropped(self):
        self.assertIn("--url and --title", self.refused("link", "l1"))
        self.ok("link", "review", "--url", "https://box.ts.net:47843/", "--title", "Lab review", "--kind", "page")
        self.assertIn("unknown decision", self.refused("link", "review", "--decision", "d9"))
        self.ok("link", "review", "--note", "mark each hit")
        link = self.state()["links"][0]
        self.assertEqual((link["kind"], link["note"]), ("page", "mark each hit"))
        self.ok("link", "review", "--drop", "the review is done")
        self.assertEqual(self.state()["links"], [])


class NumberTest(Fleet):
    def test_each_kind_is_numbered_in_order_and_a_number_finds_its_row(self):
        opt = ["--option", "a: A | x", "--option", "b: B | y", "--recommend", "a", "--reason", "r"]
        self.ok("decision", "d-deploy", "--kind", "decision", "--title", "Deploy", "--question", "q", "--why", "w", *opt)
        self.ok("decision", "d-key", "--kind", "action", "--title", "Rotate", "--question", "q", "--why", "w", "--manual", "m")
        self.ok("decision", "d-when", "--kind", "decision", "--title", "When", "--question", "q", "--why", "w", *opt)
        self.ok("link", "rev", "--url", "https://b.ts.net:1/", "--title", "Review", "--kind", "page")
        self.assertEqual([d["ref"] for d in self.state()["decisions"]], ["D1", "A1", "D2"])
        self.assertEqual(self.state()["links"][0]["ref"], "L1")
        self.ok("decision", "D2", "--decide", "a: A", "--resolution", "answered on the page")
        self.assertEqual(self.state()["decisions"][2]["status"], "decided")
        self.ok("link", "L1", "--note", "mark each")
        self.assertIn("D1 decision d-deploy", self.ok("show"))

    def test_a_number_names_the_row_it_was_given_to(self):
        self.ok("decision", "x", "--kind", "input", "--title", "T", "--question", "q", "--why", "w")
        self.assertEqual(self.state()["decisions"][0]["ref"], "I1")
        self.ok("decision", "I1", "--title", "Renamed", "--log", "clearer")
        self.assertEqual([(d["id"], d["title"]) for d in self.state()["decisions"]], [("x", "Renamed")])
        self.ok("decision", "i1", "--kind", "input", "--title", "Lower", "--question", "q", "--why", "w")
        self.assertEqual([d["id"] for d in self.state()["decisions"]], ["x", "i1"], "a lower-case id is an id, not a number")


    def test_a_number_skips_an_id_that_reads_as_it(self):
        opt = ["--option", "a: A | x", "--option", "b: B | y", "--recommend", "a", "--reason", "r"]
        self.ok("decision", "D2", "--kind", "input", "--title", "T", "--question", "q", "--why", "w")
        self.ok("decision", "x", "--kind", "decision", "--title", "X", "--question", "q", "--why", "w", *opt)
        self.ok("decision", "y", "--kind", "decision", "--title", "Y", "--question", "q", "--why", "w", *opt)
        self.assertEqual([(d["id"], d["ref"]) for d in self.state()["decisions"]], [("D2", "I1"), ("x", "D1"), ("y", "D3")])

    def test_a_number_given_for_a_decision_is_kept_as_its_id(self):
        self.ok("decision", "key", "--kind", "input", "--title", "Key", "--question", "q", "--why", "w")
        self.ok("roadblock", "r1", "--title", "T", "--detail", "D", "--severity", "serious", "--needs", "user", "--decision", "I1")
        self.ok("link", "l1", "--url", "https://b.ts.net:1/", "--title", "Form", "--decision", "I1")
        self.ok("decision", "I1", "--decide", "given", "--resolution", "said in the session")
        self.ok("decision", "key2", "--kind", "input", "--title", "Key again", "--question", "q", "--why", "w", "--supersedes", "I1")
        state = self.state()
        self.assertEqual((state["roadblocks"][0]["decision"], state["links"][0]["decision"], state["decisions"][1]["supersedes"]),
                         ("key", "key", "key"))
        self.assertTrue(state["roadblocks"][0]["resolved"], "closing the decision clears the roadblock that waits on it")


class DoneTest(Fleet):
    def test_done_with_a_report_that_reads_unfinished_is_questioned(self):
        self.ok("agent", "a9", "--task", "t", "--milestone", "m1")
        said = self.run_cli("agent", "a9", "--status", "done", "--report", "Part A refused a 3rd time; parked.")
        self.assertEqual(said.returncode, 0)
        self.assertIn("reads as unfinished", said.stderr)
        self.ok("agent", "a8", "--task", "t", "--milestone", "m1")
        self.assertNotIn("unfinished", self.run_cli("agent", "a8", "--status", "done", "--report", "All 12 met; did not touch the API.").stderr)


class OriginTest(Fleet):
    def test_a_decision_is_tied_to_its_step_milestone_and_worker(self):
        self.ok("step", "l19", "--milestone", "m2", "--title", "Watchdog")
        self.ok("agent", "b41", "--task", "t", "--milestone", "m1")
        self.ok("decision", "d-a", "--kind", "action", "--title", "Unblock", "--question", "q", "--why", "w", "--manual", "m", "--step", "l19")
        self.ok("decision", "d-b", "--kind", "input", "--title", "Which", "--question", "q", "--why", "w", "--agent", "b41")
        d = {x["id"]: x for x in self.state()["decisions"]}
        self.assertEqual((d["d-a"]["step"], d["d-a"]["milestone"]), ("l19", "m2"))
        self.assertEqual((d["d-b"]["step"], d["d-b"]["milestone"]), (None, "m1"), "a worker implies its milestone")
        self.assertIn("unknown step", self.refused("decision", "d-a", "--step", "l99"))
        self.ok("grill", "g1", "--title", "T", "--ask", "a | b | c | d", "--step", "l19")
        self.assertEqual(self.state()["decisions"][-1]["step"], "l19")


class NowNamesTest(Fleet):
    def test_a_now_line_naming_a_closed_decision_is_questioned(self):
        self.ok("decision", "d-key", "--kind", "input", "--title", "Neon key", "--question", "q", "--why", "w")
        self.ok("decision", "I1", "--decide", "given", "--resolution", "answered on the page (#83)")
        said = self.run_cli("set", "--now", "Waits on Luiz: I1, the Neon key")
        self.assertIn("names I1 (Neon key) is decided", said.stderr)
        self.assertNotIn("names", self.run_cli("set", "--now", "Latency test running").stderr)


class ClockTest(Fleet):
    def test_fleet_now_stops_the_clock_for_stamps_and_ages(self):
        env = {**os.environ, "FLEET_NOW": "2026-01-02T09:00:00+00:00", "TZ": "UTC"}
        run = lambda *a: subprocess.run([sys.executable, STATE, str(self.root), *a, "--no-render"],  # noqa: E731
                                        capture_output=True, text=True, env=env, timeout=20)
        self.assertEqual(run("set", "--now", "x").returncode, 0)
        state = self.state()
        self.assertEqual((state["now_at"], state["updated"]), ("2026-01-02T09:00:00+00:00",) * 2)
        env["FLEET_NOW"] = "2026-01-02T09:45:00+00:00"
        self.assertIn("the page's Now line (said 45 min ago)", run("event", "y").stderr)


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
