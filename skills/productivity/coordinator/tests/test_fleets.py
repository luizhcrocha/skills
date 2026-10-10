"""The registry of the fleets running on this machine: how a manager finds the coordinators, and they it."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
os.environ["FLEET_DISCOVER"] = "0"  # the machine's own servers are not the tests' to see
sys.path.insert(0, str(SCRIPTS))
import fleets  # noqa: E402

FLEETS = str(SCRIPTS / "fleets.py")


def dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


class Machine(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self._home = os.environ.get("FLEET_HOME")
        os.environ["FLEET_HOME"] = str(self.base / "registry")
        self.addCleanup(lambda: os.environ.pop("FLEET_HOME", None) if self._home is None else os.environ.__setitem__("FLEET_HOME", self._home))

    def fleet(self, name: str, project: str, role: str | None = None, **state) -> Path:
        root = self.base / name / "coordinator"
        root.mkdir(parents=True)
        body = {"project": project, "goal": "g of " + project, "status": "running", "now": "now of " + project,
                "started": "2026-09-28T10:00:00+00:00", "updated": "2026-09-28T11:00:00+00:00",
                "roadmap": [], "agents": [], "roadblocks": [], "decisions": [], "events": [], **state}
        if role:
            body["role"] = role
        (root / "state.json").write_text(json.dumps(body))
        return root

    def cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, FLEETS, *args], capture_output=True, text=True, timeout=20)


class RegisterTest(Machine):
    def test_a_fleet_is_known_by_a_name_made_from_its_project(self):
        root = self.fleet("a", "custom-mcp-servers/case-analysis")
        entry = fleets.register(root, "https://box.ts.net:1/", os.getpid())
        self.assertEqual((entry["id"], entry["role"], entry["url"], entry["dir"]),
                         ("custom-mcp-servers-case-analysis", "coordinator", "https://box.ts.net:1/", str(root)))
        self.assertEqual([f["id"] for f in fleets.live()], ["custom-mcp-servers-case-analysis"])

    def test_two_fleets_of_one_project_get_names_that_differ(self):
        first = fleets.register(self.fleet("a", "billing"), "u1", os.getpid())
        second = fleets.register(self.fleet("b", "billing"), "u2", os.getpid())
        self.assertEqual((first["id"], second["id"]), ("billing", "billing-2"))

    def test_a_fleet_that_registers_again_keeps_its_name_and_its_session(self):
        a, b = self.fleet("a", "billing"), self.fleet("b", "billing")
        fleets.register(a, "u1", os.getpid())
        fleets.register(b, "u2", os.getpid())
        fleets.name(b, "Billing-Coordinator")
        again = fleets.register(b, "u3", os.getpid())
        self.assertEqual((again["id"], again["session"], again["url"]), ("billing-coordinator", "Billing-Coordinator", "u3"))
        self.assertEqual(len(fleets.live()), 2)

    def test_a_fleet_takes_its_sessions_name_as_its_one_name(self):
        a, b = self.fleet("a", "billing"), self.fleet("b", "infra")
        fleets.register(a, "u1", os.getpid())
        fleets.register(b, "u2", os.getpid())
        self.assertEqual(fleets.name(a, "Billing Coordinator")["id"], "billing-coordinator")
        self.assertEqual(sorted(e["id"] for e in fleets.live()), ["billing-coordinator", "infra"])
        self.assertIn("already called", fleets.name(b, "billing-coordinator"))
        self.assertIn("keeps", fleets.name(b, "user"))

    def test_a_name_the_chat_keeps_for_itself_is_not_given_to_a_fleet(self):
        for project in ["manager", "Coordinator", "user"]:
            entry = fleets.register(self.fleet(project, project), "u", os.getpid())
            self.assertEqual(entry["id"], project.lower() + "-fleet")

    def test_the_manager_is_named_manager(self):
        entry = fleets.register(self.fleet("m", "everything", role="manager"), "u", os.getpid())
        self.assertEqual((entry["id"], entry["role"]), ("manager", "manager"))

    def test_a_fleet_whose_server_died_is_forgotten(self):
        fleets.register(self.fleet("a", "gone"), "u", dead_pid())
        fleets.register(self.fleet("b", "here"), "u", os.getpid())
        self.assertEqual([f["id"] for f in fleets.live()], ["here"])
        self.assertEqual(sorted(p.name for p in (self.base / "registry").iterdir()), ["here.json", "names"])
        self.assertEqual(len(list((self.base / "registry" / "names").iterdir())), 1, "its name is kept for its return")

    def test_unregister_forgets_the_fleet(self):
        root = self.fleet("a", "billing")
        fleets.register(root, "u", os.getpid())
        fleets.unregister(root)
        self.assertEqual(fleets.live(), [])
        fleets.unregister(root)


class ManagerTest(Machine):
    def test_the_manager_is_found_once_one_is_live(self):
        a = self.fleet("a", "billing")
        fleets.register(a, "u", os.getpid())
        self.assertIsNone(fleets.manager())
        m = self.fleet("m", "everything", role="manager")
        fleets.register(m, "https://box.ts.net:9/", os.getpid())
        fleets.name(m, "manager-session")
        found = fleets.manager()
        self.assertEqual((found["id"], found["url"], found["session"], found["dir"]), ("manager", "https://box.ts.net:9/", "manager-session", str(m)))

    def test_a_coordinators_view_names_its_manager(self):
        a = self.fleet("a", "billing")
        fleets.register(a, "u", os.getpid())
        state = json.loads((a / "state.json").read_text())
        self.assertNotIn("manager", fleets.view(state, a))
        m = self.fleet("m", "everything", role="manager")
        fleets.register(m, "https://box.ts.net:9/", os.getpid())
        self.assertEqual(fleets.view(state, a)["manager"], {"id": "manager", "url": "https://box.ts.net:9/", "session": None})
        self.assertNotIn("manager", state, "the view is a copy")

    def test_the_managers_view_holds_every_coordinator_with_what_waits_in_it(self):
        open_ = {"id": "d1", "kind": "decision", "title": "Schema", "question": "q", "status": "open", "blocking": True,
                 "opened": "2026-09-28T10:30:00+00:00"}
        held = {"id": "d2", "kind": "input", "title": "Rate", "question": "q", "status": "open", "asks": "manager",
                "opened": "2026-09-28T10:40:00+00:00"}
        closed = {"id": "d3", "kind": "input", "title": "Old", "question": "q", "status": "decided", "opened": "x"}
        a = self.fleet("a", "billing", decisions=[open_, held, closed],
                       agents=[{"id": "a1", "name": "x", "task": "t", "status": "running", "lane": ["src/billing/**"], "milestone": "m1", "tokens": 100},
                               {"id": "a2", "name": "y", "task": "t", "status": "done", "lane": [], "milestone": "m1", "tokens": 50}],
                       roadblocks=[{"id": "r1", "title": "T", "severity": "serious", "needs": "user", "since": "x", "resolved": False}])
        fleets.register(a, "https://box.ts.net:1/", os.getpid())
        fleets.name(a, "billing-coordinator")
        m = self.fleet("m", "everything", role="manager")
        fleets.register(m, "https://box.ts.net:9/", os.getpid())
        view = fleets.view(json.loads((m / "state.json").read_text()), m)
        self.assertEqual(len(view["coordinators"]), 1)
        c = view["coordinators"][0]
        self.assertEqual((c["id"], c["name"], c["goal"], c["status"], c["now"], c["url"], c["session"]),
                         ("billing-coordinator", "billing-coordinator", "g of billing", "running", "now of billing", "https://box.ts.net:1/", "billing-coordinator"))
        self.assertEqual((c["workers"], c["tokens"], c["roadblocks"]), ({"running": 1, "done": 1}, 150, 1))
        self.assertEqual(c["lanes"], ["src/billing/**"])
        self.assertEqual([(d["id"], d["asks"], d["blocking"]) for d in c["decisions"]], [("d1", "user", True), ("d2", "manager", False)])

    def test_the_managers_view_of_a_fleets_open_item_carries_the_fleets_chat_about_it_and_of_a_grilling_its_open_questions(self):
        at = "2026-10-02T13:57:11-05:00"

        def q(id_, status, of=None):
            return {"id": id_, "title": "T", "body": "B", "recommend": "R", "reason": "W", "of": of, "status": status,
                    "answer": "yes" if status == "answered" else None, "asked": at}

        def grill(id_, questions):
            return {"id": id_, "kind": "grill", "title": id_, "question": "q", "status": "open", "opened": at, "questions": questions}

        a = self.fleet("a", "ui", decisions=[
            grill("G3", [q("q1", "answered"), q("q2", "answered"), q("q3", "answered")]),
            grill("G4", [q("q1", "open"), q("q2", "open")]),
            grill("G5", [q("q1", "open")]),
            grill("G6", [q("q1", "open"), q("q2", "open", of="q1")]),
            {"id": "d1", "kind": "decision", "title": "Schema", "question": "q", "status": "open", "opened": at},
        ])

        def line(**m):
            return json.dumps({"to": ["coordinator"], "re": None, **m}) + "\n"

        (a / "chat.jsonl").write_text(
            line(id=1, at="2026-10-02T13:58:00-05:00", **{"from": "user"}, text="Q1: Yes, merge", decision="G5", author="luiz")
            + line(id=2, at="2026-10-02T13:59:00-05:00", **{"from": "user"}, text="Q1: Yes", decision="G6")
            + line(id=3, at="2026-10-02T14:00:00-05:00", **{"from": "coordinator"}, to=["user"], text="which merge?", re=2)
            + line(id=4, at="2026-10-02T14:01:00-05:00", **{"from": "user"}, text="a", decision="d1")
            + line(id=5, at="2026-10-02T14:02:00-05:00", **{"from": "coordinator"}, to=["user"], text="noted", re=4))
        fleets.register(a, "u1", os.getpid())
        m = self.fleet("m", "everything", role="manager")
        fleets.register(m, "u9", os.getpid())
        rows = {d["id"]: d for d in fleets.view(json.loads((m / "state.json").read_text()), m)["coordinators"][0]["decisions"]}

        def opened(id_, of=None):
            return {"id": id_, "of": of, "status": "open", "asked": at}

        def message(id_, when, sender, text, re, decision):
            return {"id": id_, "at": when, "from": sender, "to": ["coordinator" if sender == "user" else "user"], "text": text, "re": re, "decision": decision}

        self.assertEqual((rows["G3"]["questions"], rows["G3"]["said"]), ([], []))
        self.assertEqual((rows["G4"]["questions"], rows["G4"]["said"]), ([opened("q1"), opened("q2")], []))
        self.assertEqual((rows["G5"]["questions"], rows["G5"]["said"]),
                         ([opened("q1")], [message(1, "2026-10-02T13:58:00-05:00", "user", "Q1: Yes, merge", None, "G5")]))
        self.assertEqual(rows["G6"]["said"], [message(2, "2026-10-02T13:59:00-05:00", "user", "Q1: Yes", None, "G6"),
                                              message(3, "2026-10-02T14:00:00-05:00", "coordinator", "which merge?", 2, None)])
        self.assertEqual(rows["G6"]["questions"], [opened("q1"), opened("q2", of="q1")])
        self.assertEqual(rows["d1"]["said"], [message(4, "2026-10-02T14:01:00-05:00", "user", "a", None, "d1"),
                                              message(5, "2026-10-02T14:02:00-05:00", "coordinator", "noted", 4, None)])
        self.assertNotIn("questions", rows["d1"])

    def test_a_fleet_whose_state_cannot_be_read_is_shown_as_such(self):
        a = self.fleet("a", "billing")
        fleets.register(a, "u", os.getpid())
        (a / "state.json").write_text("{half")
        m = self.fleet("m", "everything", role="manager")
        fleets.register(m, "u9", os.getpid())
        c = fleets.view(json.loads((m / "state.json").read_text()), m)["coordinators"][0]
        self.assertEqual((c["id"], c["status"], c["decisions"]), ("billing", "unknown", []))


class CliTest(Machine):
    def test_list_prints_each_fleet_with_how_to_reach_it(self):
        a = self.fleet("a", "billing", decisions=[{"id": "d1", "kind": "input", "title": "Rate", "question": "q", "status": "open",
                                                   "asks": "manager", "opened": "x"}])
        fleets.register(a, "https://box.ts.net:1/", os.getpid())
        self.assertEqual(self.cli("name", str(a), "billing-coordinator").returncode, 0)
        out = self.cli("list").stdout
        self.assertIn("billing-coordinator  (coordinator, running)\n  session  billing-coordinator\n", out)
        self.assertIn("  page     https://box.ts.net:1/\n", out)
        self.assertIn(f"  ledger   {a}\n", out)
        self.assertIn("  now      now of billing\n", out)
        self.assertIn("    I1  d1  input  for the manager  Rate\n", out)

    def test_list_shows_identity_then_live_agents_links_and_what_waits_each_section_apart(self):
        lanes = ["src/billing/**", "src/invoices/**,src/ledger/**", "docs/billing.md"]
        a = self.fleet("a", "billing", roadmap=[{"id": "m1", "title": "M", "steps": []}], agents=[
            {"id": "a1", "name": "writer", "task": "t", "model": "opus", "status": "running", "lane": lanes, "milestone": "m1", "tokens": 1_234_567},
            {"id": "b12", "name": "b12", "task": "Wire the invoices to the ledger and run the migration twice", "model": "sonnet",
             "status": "blocked", "lane": [], "milestone": "m1", "tokens": 0},
            {"id": "a3", "name": "finished", "task": "t", "model": "opus", "status": "done", "lane": ["src/done/**"], "milestone": "m1", "tokens": 9},
            {"id": "q4", "name": "advisor", "task": "t", "model": "fable", "status": "queued", "lane": [], "milestone": "m1"},
        ], links=[
            {"id": "dev", "url": "https://box.ts.net:5173/", "title": "Billing dev server", "kind": "dev", "decision": None, "agent": None, "note": None, "since": "x"},
            {"id": "old", "url": "https://box.ts.net:5300/", "title": "Old review", "kind": "page", "decision": None, "agent": None, "note": None, "since": "x"},
        ], decisions=[
            {"id": "d1", "kind": "decision", "title": "Schema", "question": "q", "status": "open", "blocking": True, "opened": "2026-09-28T10:30:00+00:00"},
            {"id": "d2", "kind": "input", "title": "Rate", "question": "q", "status": "open", "asks": "manager", "opened": "2026-09-28T10:40:00+00:00",
             "held": "after the cost work", "held_at": "2026-09-28T10:50:00+00:00"},
            {"id": "d3", "kind": "input", "title": "Closed one", "question": "q", "status": "decided", "opened": "x"},
        ])
        dropped = subprocess.run([sys.executable, str(SCRIPTS / "state.py"), str(a), "link", "old", "--drop", "the review is done", "--no-render"],
                                 capture_output=True, text=True, timeout=20)
        self.assertEqual(dropped.returncode, 0, dropped.stderr)
        fleets.register(a, "https://box.ts.net:1/", os.getpid())
        fleets.name(a, "billing-coordinator")
        self.assertEqual(self.cli("list").stdout, "\n".join([
            "billing-coordinator  (coordinator, running)",
            "  session  billing-coordinator",
            "  page     https://box.ts.net:1/",
            f"  ledger   {a}",
            "  now      now of billing",
            "  chat     not read now",
            "",
            "  agents   1 running, 1 blocked, 1 queued",
            "    a1   running  opus    writer                                            lanes: src/billing/** +3",
            "    b12  blocked  sonnet  Wire the invoices to the ledger and run the mig\u2026",
            "    q4   queued   fable   advisor",
            "  links    1",
            "    L1  preview  https://box.ts.net:5173/  Billing dev server",
            "  waiting  2",
            "    D1  d1  decision  for the user     Schema  blocks work",
            "    I1  d2  input     for the manager  Rate  held by the fleet: after the cost work",
            "",
        ]))
        shown = self.cli("show", "billing-coordinator").stdout
        for lane in ["src/billing/**", "src/invoices/**", "src/ledger/**", "docs/billing.md"]:
            self.assertIn(f"    lane {lane}  a1\n", shown)
        self.assertNotIn("src/done/**", shown)

    def test_list_puts_one_blank_line_between_fleets_and_shows_no_empty_section(self):
        fleets.register(self.fleet("a", "billing"), "u1", os.getpid())
        fleets.register(self.fleet("b", "infra"), "u2", os.getpid())
        out = self.cli("list").stdout
        self.assertIn("  chat     not read now\n\ninfra  (coordinator, running)\n", out)
        for word in ("agents", "links", "waiting"):
            self.assertNotIn(word, out)

    def test_token_counts_are_three_figures_and_a_unit_rounded_half_up(self):
        cases = [(0, "0"), (999, "999"), (1000, "1.00k"), (12_250, "12.3k"), (471_173, "471k"), (999_950, "1.00M"),
                 (3_954_399, "3.95M"), (246_709_089, "247M"), (3_055_406_540, "3.06B")]
        self.assertEqual([fleets.token_count(n) for n, _ in cases], [text for _, text in cases])

    def test_list_says_when_there_is_none(self):
        self.assertEqual(self.cli("list").stdout, "no fleet is being served on this machine\n")

    def test_manager_prints_how_to_reach_it_or_fails_when_there_is_none(self):
        none = self.cli("manager")
        self.assertEqual((none.returncode, none.stdout), (1, ""))
        self.assertIn("no manager", none.stderr)
        m = self.fleet("m", "everything", role="manager")
        fleets.register(m, "https://box.ts.net:9/", os.getpid())
        fleets.name(m, "manager-session")
        found = self.cli("manager")
        self.assertEqual(found.returncode, 0)
        for word in ["session manager-session", "https://box.ts.net:9/", str(m), str(m / "standing.md")]:
            self.assertIn(word, found.stdout)

    def test_decision_prints_what_a_fleet_asks_in_full(self):
        a = self.fleet("a", "billing", decisions=[{
            "id": "d7", "kind": "decision", "title": "Order of the two migrations", "status": "open", "asks": "manager", "blocking": True,
            "question": "Does the invoice migration run before or after the index rebuild?", "why": "the fleet assumes after",
            "options": [{"id": "A", "label": "After", "consequence": "one lock window"}, {"id": "B", "label": "Before", "consequence": "two windows"}],
            "recommend": "A", "reason": "one window is what the user asked for", "body": True, "agent": "a1", "opened": "2026-09-28T10:00:00+00:00", "ref": "D4"}])
        fleets.register(a, "https://box.ts.net:1/", os.getpid())
        out = self.cli("decision", "billing", "d7").stdout
        for line in ["billing d7 [decision, for the manager, blocks work] Order of the two migrations",
                     "question: Does the invoice migration run before or after the index rebuild?",
                     "why: the fleet assumes after", "A: After | one lock window", "B: Before | two windows",
                     "recommended: A, one window is what the user asked for", f"evidence: {a / 'decisions' / 'd7.html'}",
                     "page: https://box.ts.net:1/#decision/d7"]:
            self.assertIn(line, out)
        self.assertIn("page: https://box.ts.net:1/#decision/d7", self.cli("decision", "billing", "D4").stdout, "a number leads to the id's page")
        for args, word in [(["decision", "billing", "d9"], "no decision 'd9'"), (["decision", "nobody", "d7"], "no fleet 'nobody'")]:
            result = self.cli(*args)
            self.assertEqual(result.returncode, 1)
            self.assertIn(word, result.stderr)

    def test_waiting_is_what_the_ledgers_say_waits_on_the_user(self):
        self.assertEqual(self.cli("waiting").stdout, "no fleet is being served on this machine\n")
        at = "2026-09-28T10:00:00+00:00"
        infra = self.fleet("i", "infra", decisions=[
            {"id": "rerun", "kind": "action", "title": "Re-run CA1014", "question": "q", "status": "open", "opened": at},
            {"id": "upload", "kind": "action", "title": "Small test upload", "question": "q", "status": "open", "asks": "manager", "opened": at},
            {"id": "key", "kind": "secret", "title": "Neon key", "question": "q", "status": "open", "blocking": True, "opened": at,
             "revised": "2026-09-28T10:20:00+00:00"},
            {"id": "later", "kind": "decision", "title": "Held", "question": "q", "status": "open", "opened": at, "held": "after the cost work"},
            {"id": "old", "kind": "input", "title": "Old", "question": "q", "status": "decided", "opened": at}])
        fleets.register(infra, "u1", os.getpid())
        m = self.fleet("m", "everything", role="manager")
        fleets.register(m, "u9", os.getpid())
        self.assertEqual(self.cli("waiting").stdout,
                         "infra A1 [action] Re-run CA1014  since 2026-09-28 10:00\n"
                         "infra S1 [secret, blocks work] Neon key  since 2026-09-28 10:20\n")
        (infra / "chat.jsonl").write_text(json.dumps({"id": 1, "at": "2026-09-28T10:30:00+00:00", "from": "user", "to": ["coordinator"],
                                                     "text": "Re-run after the cost improvements work is done", "re": None,
                                                     "decision": "rerun"}) + "\n")
        self.assertIn("infra A1 [action] Re-run CA1014  since 2026-09-28 10:00  ANSWERED at 10:30 (#1): "
                      "Re-run after the cost improvements work is done; not recorded yet\n", self.cli("waiting").stdout)
        state = json.loads((infra / "state.json").read_text())
        for d in state["decisions"]:
            d["status"] = "decided" if d["status"] == "open" else d["status"]
        (infra / "state.json").write_text(json.dumps(state))
        self.assertEqual(self.cli("waiting").stdout, "nothing waits on the user\n")

    def test_name_needs_a_served_fleet(self):
        result = self.cli("name", str(self.fleet("a", "billing")), "x")
        self.assertEqual(result.returncode, 1)
        self.assertIn("serve", result.stderr)


if __name__ == "__main__":
    unittest.main()


class SessionTitleTest(unittest.TestCase):
    """A fleet in a session's scratchpad is named after the session's title, and follows its renames."""

    def setUp(self):
        self.config = Path(tempfile.mkdtemp(prefix="claude-"))
        self.tmp = Path(tempfile.mkdtemp(prefix="tmp-"))
        os.environ["CLAUDE_CONFIG_DIR"] = str(self.config)
        os.environ["FLEET_HOME"] = tempfile.mkdtemp(prefix="fleet-home-")
        self.addCleanup(os.environ.pop, "CLAUDE_CONFIG_DIR", None)

    def session(self, project: str, sid: str, title: str | None) -> Path:
        root = self.tmp / project / sid / "scratchpad" / "coordinator"
        root.mkdir(parents=True)
        (root / "state.json").write_text(json.dumps({"project": "case analysis", "goal": "g", "status": "running", "now": "n",
                                                     "started": "x", "roadmap": [], "agents": [], "roadblocks": [], "events": []}))
        if title:
            self.title(project, sid, title)
        return root

    def title(self, project: str, sid: str, title: str) -> None:
        d = self.config / "projects" / project / sid
        d.mkdir(parents=True, exist_ok=True)
        (d / "custom-title.json").write_text(json.dumps({"customTitle": title}))

    def test_the_title_names_the_fleet_and_a_rename_follows(self):
        root = self.session("-home-x-repo", "s1", "infra-coordinator")
        self.assertEqual((fleets.register(root, "u", os.getpid())["id"]), "infra-coordinator")
        self.title("-home-x-repo", "s1", "Infra Lead")
        self.assertEqual([(e["id"], e["session"]) for e in fleets.live()], [("infra-lead", "Infra Lead")])
        self.assertEqual(len(list(Path(os.environ["FLEET_HOME"]).glob("*.json"))), 1)
        self.assertEqual(fleets.register(root, "u2", os.getpid())["id"], "infra-lead", "a restart keeps it")

    def test_without_a_title_the_project_names_it(self):
        root = self.session("-home-x-repo", "s2", None)
        self.assertEqual(fleets.register(root, "u", os.getpid())["id"], "case-analysis")


class GateTest(unittest.TestCase):
    def setUp(self):
        os.environ["FLEET_HOME"] = tempfile.mkdtemp(prefix="fleet-home-")
        self.base = Path(tempfile.mkdtemp())
        for name in ("infra", "ui"):
            root = self.base / name / "coordinator"
            root.mkdir(parents=True)
            (root / "state.json").write_text(json.dumps({"project": name}))
            fleets.register(root, "u", os.getpid())

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPTS / "fleets.py"), *args], capture_output=True, text=True, timeout=20)

    def test_one_fleet_holds_the_gate_at_a_time(self):
        self.assertEqual(self.cli("gate").stdout, "free\n")
        self.assertEqual(self.cli("gate", "take", "infra", "live Neo4j suite").returncode, 0)
        refused = self.cli("gate", "take", "ui", "browser tests")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("held by infra", refused.stderr)
        self.assertEqual(len(fleets.live()), 2, "the gate is not taken for a fleet")
        self.assertEqual(self.cli("gate", "free", "ui").returncode, 1)
        self.assertEqual(self.cli("gate", "free", "infra").returncode, 0)
        self.assertEqual(self.cli("gate", "take", "ui", "browser tests").returncode, 0)

    def at(self, stamp, *args):
        env = {**os.environ, "FLEET_NOW": stamp, "TZ": "UTC"}
        return subprocess.run([sys.executable, str(SCRIPTS / "fleets.py"), *args], capture_output=True, text=True, timeout=20, env=env)

    @staticmethod
    def token(took):
        return took.stdout.rsplit("gate free ", 1)[-1].rstrip("`\n")

    def test_a_take_while_held_refuses_by_the_holding_fleet_too(self):
        self.assertEqual(self.at("2026-10-05T12:00:00+00:00", "gate", "take", "infra", "worker A: just test").returncode, 0)
        again = self.at("2026-10-05T12:01:00+00:00", "gate", "take", "infra", "worker B: just test")
        self.assertEqual(again.returncode, 1)
        self.assertEqual(again.stderr, "fleets: held by infra since 2026-10-05T12:00:00+00:00, until 2026-10-05T13:00:00+00:00: worker A: just test; take it when `fleet fleets gate` says free\n")

    def test_a_release_frees_only_the_hold_its_token_names(self):
        first = self.at("2026-10-05T12:00:00+00:00", "gate", "take", "infra", "worker A: just test")
        self.assertRegex(first.stdout, r"^infra holds the gate: worker A: just test\ntoken [0-9a-f]{8}, until 2026-10-05T13:00:00\+00:00: free it with `fleet fleets gate free [0-9a-f]{8}`\n$")
        a = self.token(first)
        self.assertEqual(self.at("2026-10-05T12:05:00+00:00", "gate", "free", a).stdout, "free\n")
        b = self.token(self.at("2026-10-05T12:06:00+00:00", "gate", "take", "infra", "worker B: just test"))
        self.assertNotEqual(a, b)
        late = self.at("2026-10-05T12:07:00+00:00", "gate", "free", a)
        self.assertEqual((late.returncode, late.stderr), (1, f"fleets: held by infra, not {a}\n"))
        self.assertEqual(self.at("2026-10-05T12:08:00+00:00", "gate", "free", b).returncode, 0)

    def test_a_session_that_serves_no_fleet_takes_it_as_itself(self):
        took = self.at("2026-10-05T12:00:00+00:00", "gate", "take", "--as", "gate-slot-worker", "just test-changed")
        self.assertEqual(took.returncode, 0)
        self.assertEqual(self.at("2026-10-05T12:01:00+00:00", "gate").stdout,
                         "held by gate-slot-worker (no fleet) since 2026-10-05T12:00:00+00:00, until 2026-10-05T13:00:00+00:00: just test-changed\n")
        self.assertEqual(self.at("2026-10-05T12:02:00+00:00", "gate", "free", self.token(took)).stdout, "free\n")

    def test_a_hold_lapses_at_its_until(self):
        self.assertEqual(self.at("2026-10-05T12:00:00+00:00", "gate", "take", "--as", "w1", "suite", "--for", "10").returncode, 0)
        self.assertIn("held by w1", self.at("2026-10-05T12:09:59+00:00", "gate").stdout)
        self.assertEqual(self.at("2026-10-05T12:10:00+00:00", "gate").stdout, "free\n")

    def test_two_takes_at_once_one_wins(self):
        for n in range(5):
            procs = [subprocess.Popen([sys.executable, str(SCRIPTS / "fleets.py"), "gate", "take", "--as", f"{who}-{n}", "race"],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for who in ("a", "b")]
            outs = [(p.wait(timeout=20), p.stdout.read()) for p in procs]
            won = [out for code, out in outs if code == 0]
            self.assertEqual(len(won), 1)
            self.assertEqual(self.cli("gate", "free", self.token(subprocess.CompletedProcess([], 0, won[0], ""))).returncode, 0)


class NameTest(unittest.TestCase):
    """A fleet's name drops the number Claude Code puts before a restarted session's name."""

    def test_the_number_goes(self):
        self.assertEqual(fleets.unnumbered("3.ui-coordinator"), "ui-coordinator")
        self.assertEqual(fleets.unnumbered("ui-coordinator"), "ui-coordinator")
        self.assertEqual(fleets.unnumbered("3."), "3.")
        self.assertEqual(fleets.unnumbered("v2.ui"), "v2.ui")
        self.assertEqual(fleets.fleet_name("3.UI Coordinator"), "ui-coordinator")

    def test_the_old_id_is_kept_as_an_alias(self):
        self.assertTrue(fleets.drops_number("3.ui-coordinator", "ui-coordinator"))
        self.assertFalse(fleets.drops_number("ui-coordinator", "billing"))
        self.assertEqual(fleets.aliases_after({}, "3.ui-coordinator", "ui-coordinator"), ["3.ui-coordinator"])
        self.assertEqual(fleets.aliases_after({"aliases": ["2.ui-coordinator"]}, "3.ui-coordinator", "ui-coordinator"),
                         ["2.ui-coordinator", "3.ui-coordinator"])
        self.assertEqual(fleets.aliases_after({}, "billing", "invoices"), ["billing"], "every rename keeps the old address")
        self.assertEqual(fleets.aliases_after({"aliases": ["ui-coordinator"]}, "x", "ui-coordinator"), ["x"])


class RespawnTest(Machine):
    """A fleet served again by a restarted session (`claude respawn`: a new pid, the same session id) keeps its name."""

    def setUp(self):
        super().setUp()
        self.config = self.base / "claude"
        os.environ["CLAUDE_CONFIG_DIR"] = str(self.config)
        self.addCleanup(os.environ.pop, "CLAUDE_CONFIG_DIR", None)

    def session(self) -> subprocess.Popen:
        proc = subprocess.Popen(["sleep", "60"])
        self.addCleanup(proc.kill)
        return proc

    @staticmethod
    def end(proc: subprocess.Popen) -> None:
        proc.kill()
        proc.wait()

    def title(self, project: str, sid: str, text: str) -> None:
        d = self.config / "projects" / project / sid
        d.mkdir(parents=True, exist_ok=True)
        (d / "custom-title.json").write_text(json.dumps({"customTitle": text}))

    def scratchpad(self, project: str, sid: str) -> Path:
        root = self.base / "tmp" / project / sid / "scratchpad" / "coordinator"
        root.mkdir(parents=True)
        (root / "state.json").write_text(json.dumps({"project": "custom-mcp-servers"}))
        return root

    def wrote(self, project: str, sid: str, at: str) -> str:
        path = self.config / "projects" / project / f"{sid}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n")
        t = datetime.fromisoformat(at).timestamp()
        os.utime(path, (t, t))
        return datetime.fromtimestamp(t, timezone.utc).astimezone().isoformat(timespec="seconds")

    def test_a_resumed_session_serving_its_dir_again_is_the_fleets_session(self):
        root = self.scratchpad("-home-x-repo", "s1")
        self.title("-home-x-repo", "s1", "Infra")
        before = self.wrote("-home-x-repo", "s1", "2026-10-07T21:06:00+00:00")
        entry = fleets.register(root, "u", os.getpid(), "s1")
        self.assertEqual((entry["id"], fleets.summary(entry)["active"]), ("infra", before))
        self.title("-home-x-repo", "s2", "Infra Two")
        after = self.wrote("-home-x-repo", "s2", "2026-10-10T10:50:00+00:00")
        again = fleets.register(root, "u", os.getpid(), "s2")
        self.assertEqual((again["id"], again["session"], again["session_id"]), ("infra-two", "Infra Two", "s2"))
        self.assertEqual(fleets.summary(again)["active"], after)

    def test_fleets_name_from_another_session_renames_only(self):
        root = self.scratchpad("-home-x-repo", "s1")
        self.title("-home-x-repo", "s1", "Alpha")
        at = self.wrote("-home-x-repo", "s1", "2026-10-10T10:00:00+00:00")
        fleets.register(root, "u", os.getpid(), "s1")
        self.title("-home-y-other", "sB", "Bravo")
        self.wrote("-home-y-other", "sB", "2026-10-01T09:00:00+00:00")
        env = {**os.environ, "CLAUDE_CODE_SESSION_ID": "sB"}
        r = subprocess.run([sys.executable, FLEETS, "name", str(root), "Alpha"], capture_output=True, text=True, timeout=30, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([(e["id"], e["session"], e["session_id"]) for e in fleets.live()], [("alpha", "Alpha", "s1")])
        self.assertEqual(fleets.summary(fleets.live()[0])["active"], at)

    def test_a_resumed_session_with_no_title_of_its_own_keeps_the_scratchpads(self):
        root = self.scratchpad("-home-x-repo", "s1")
        self.title("-home-x-repo", "s1", "Infra")
        self.wrote("-home-x-repo", "s1", "2026-10-07T21:06:00+00:00")
        fleets.register(root, "u", os.getpid(), "s1")
        self.wrote("-home-x-repo", "s2", "2026-10-10T10:50:00+00:00")
        self.assertEqual(fleets.title_of(root, "s2"), "Infra")
        again = fleets.register(root, "u", os.getpid(), "s2")
        self.assertEqual((again["id"], again["session"], again["session_id"]), ("infra", "Infra", "s2"))

    def test_a_recorded_session_whose_transcript_is_not_found_reads_the_scratchpads(self):
        root = self.scratchpad("-home-x-repo", "s1")
        old = self.wrote("-home-x-repo", "s1", "2026-10-01T10:00:00+00:00")
        self.assertEqual(fleets.summary(fleets.register(root, "u", os.getpid(), "s2"))["active"], old)

    def test_the_entry_records_the_sessions_id(self):
        self.assertEqual(fleets.register(self.fleet("a", "infra"), "u", os.getpid(), "5579180b")["session_id"], "5579180b")
        self.assertEqual(fleets.register(self.scratchpad("-home-x-repo", "s1"), "u", os.getpid())["session_id"], "s1")
        self.assertIsNone(fleets.register(self.fleet("b", "infra"), "u", os.getpid())["session_id"])

    def test_its_dir_served_again_with_no_title_keeps_its_name_and_aliases(self):
        root = self.fleet("a", "custom-mcp-servers")
        first = self.session()
        fleets.register(root, "u", first.pid, "5579180b")
        fleets.name(root, "3.infra-coordinator")
        fleets.name(root, "infra-coordinator (2)")
        self.end(first)
        self.assertEqual(fleets.live(), [])
        again = fleets.register(root, "u2", os.getpid())
        self.assertEqual((again["id"], again.get("aliases"), again["session"]),
                         ("infra-coordinator-2", ["custom-mcp-servers", "infra-coordinator"], "infra-coordinator (2)"))

    def test_a_new_pid_of_the_same_session_serving_another_dir_keeps_the_name(self):
        a = self.fleet("a", "custom-mcp-servers")
        first = self.session()
        fleets.register(a, "u", first.pid, "5579180b")
        fleets.name(a, "infra-coordinator (2)")
        self.end(first)
        fleets.live()
        self.assertEqual(fleets.register(self.fleet("b", "custom-mcp-servers"), "u2", os.getpid(), "5579180b")["id"], "infra-coordinator-2")
        self.assertEqual(fleets.register(self.fleet("c", "custom-mcp-servers"), "u3", os.getpid(), "another")["id"], "custom-mcp-servers")

    def test_a_kept_name_another_fleet_took_meanwhile_is_not_taken_back(self):
        a = self.fleet("a", "billing")
        first = self.session()
        fleets.register(a, "u", first.pid)
        self.end(first)
        fleets.live()
        fleets.register(self.fleet("b", "billing"), "u", os.getpid())
        self.assertEqual(fleets.register(a, "u2", os.getpid())["id"], "billing-2")

    def test_no_title_never_renames_and_a_real_rename_keeps_the_old_name_as_an_alias(self):
        root = self.scratchpad("-home-x-repo", "s1")
        self.assertEqual(fleets.register(root, "u", os.getpid())["id"], "custom-mcp-servers")
        self.title("-home-x-repo", "s1", "  ")
        self.assertEqual([e["id"] for e in fleets.live()], ["custom-mcp-servers"])
        self.title("-home-x-repo", "s1", "Infra Coordinator 2")
        renamed = fleets.live()[0]
        self.assertEqual((renamed["id"], renamed.get("aliases")), ("infra-coordinator-2", ["custom-mcp-servers"]))

    def test_a_fleet_outside_any_scratchpad_follows_its_sessions_rename_by_the_sessions_id(self):
        root = self.fleet("a", "custom-mcp-servers")
        self.title("-home-x-repo", "5579180b", "Infra Coordinator")
        self.assertEqual(fleets.register(root, "u", os.getpid(), "5579180b")["id"], "infra-coordinator")
        self.title("-home-x-repo", "5579180b", "infra-coordinator (2)")
        renamed = fleets.live()[0]
        self.assertEqual((renamed["id"], renamed["session"], renamed.get("aliases")),
                         ("infra-coordinator-2", "infra-coordinator (2)", ["infra-coordinator"]))

    def test_a_brand_new_dir_with_no_title_still_gets_its_projects_slug(self):
        a = self.fleet("a", "infra")
        first = self.session()
        fleets.register(a, "u", first.pid, "s-old")
        fleets.name(a, "infra-coordinator")
        self.end(first)
        fleets.live()
        self.assertEqual(fleets.register(self.fleet("b", "custom-mcp-servers"), "u", os.getpid(), "s-new")["id"], "custom-mcp-servers")
