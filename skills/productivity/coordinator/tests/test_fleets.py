"""The registry of the fleets running on this machine: how a manager finds the coordinators, and they it."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
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
        self.assertEqual(sorted(p.name for p in (self.base / "registry").iterdir()), ["here.json"])

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
        self.assertIn("billing-coordinator  coordinator  session billing-coordinator  running", out)
        self.assertIn("https://box.ts.net:1/", out)
        self.assertIn(str(a), out)
        self.assertIn("now of billing", out)
        self.assertIn("d1 [input, for the manager] Rate", out)

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
            "recommend": "A", "reason": "one window is what the user asked for", "body": True, "agent": "a1", "opened": "2026-09-28T10:00:00+00:00"}])
        fleets.register(a, "https://box.ts.net:1/", os.getpid())
        out = self.cli("decision", "billing", "d7").stdout
        for line in ["billing d7 [decision, for the manager, blocks work] Order of the two migrations",
                     "question: Does the invoice migration run before or after the index rebuild?",
                     "why: the fleet assumes after", "A: After | one lock window", "B: Before | two windows",
                     "recommended: A, one window is what the user asked for", f"evidence: {a / 'decisions' / 'd7.html'}",
                     "page: https://box.ts.net:1/#decision/d7"]:
            self.assertIn(line, out)
        for args, word in [(["decision", "billing", "d9"], "no decision 'd9'"), (["decision", "nobody", "d7"], "no fleet 'nobody'")]:
            result = self.cli(*args)
            self.assertEqual(result.returncode, 1)
            self.assertIn(word, result.stderr)

    def test_name_needs_a_served_fleet(self):
        result = self.cli("name", str(self.fleet("a", "billing")), "x")
        self.assertEqual(result.returncode, 1)
        self.assertIn("serve", result.stderr)


if __name__ == "__main__":
    unittest.main()
