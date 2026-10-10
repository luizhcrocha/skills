"""Standing approvals, notices, the advisor's view and reviewed events, through the state CLI: the user's
answer on the page is the only source of an approval, an act under one is recorded closed and told to the
fleets, and a choice that reaches the user without the advisor's view is warned."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
STATE = str(SCRIPTS / "state.py")
FLEETS = str(SCRIPTS / "fleets.py")

CHOICE = ["--kind", "decision", "--title", "Landing without asking", "--why", "most landings are routine",
          "--question", "May the fleet land a stack that passed the full gate and a review, and tell you after?",
          "--option", "A: yes | it lands and you read a notice", "--option", "B: no | every landing asks",
          "--recommend", "A", "--reason", "the gate and the review already judge it"]
NOTICE = ["--kind", "notice", "--under", "K1", "--title", "Landed the parser",
          "--question", "Pushed the parser stack to master.", "--undo", "jj revert the stack and push"]


class Fleet(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "c"
        self.home = Path(tmp.name) / "registry"
        self.env = {**os.environ, "FLEET_HOME": str(self.home), "FLEET_DISCOVER": "0"}
        self.ok("init", "--project", "acme billing", "--goal", "g")
        self.ok("milestone", "m1", "--title", "M")

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, STATE, str(self.root), *args, "--no-render"],
                              capture_output=True, text=True, timeout=20, env=self.env)

    def ok(self, *args: str) -> subprocess.CompletedProcess:
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def refused(self, *args: str) -> str:
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertNotIn("Traceback", result.stderr)
        return result.stderr

    def state(self) -> dict:
        return json.loads((self.root / "state.json").read_text())

    def answer(self, decision: str, n: int = 1) -> None:
        with open(self.root / "chat.jsonl", "a") as f:
            f.write(json.dumps({"id": n, "at": "2026-01-05T09:10:00+00:00", "from": "user", "author": "luiz@github",
                                "to": ["coordinator"], "text": "A: yes", "re": None, "decision": decision}) + "\n")

    def approved(self) -> None:
        self.ok("decision", "d1", *CHOICE)
        self.answer("d1")
        self.ok("decision", "d1", "--decide", "A", "--resolution", "answered on the page (#1)")
        self.ok("approval", "add", "K1", "--rule", "land a stack that passed the full gate and a review", "--by", "luiz", "--ref", "D1")


class ApprovalTest(Fleet):
    def test_an_approval_comes_only_from_the_users_answer_on_the_page(self):
        self.ok("decision", "d1", *CHOICE)
        self.assertIn("is open", self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "d1"))
        self.ok("decision", "d1", "--decide", "A", "--resolution", "said in the session")
        self.assertIn("no answer from the user", self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "d1"))
        self.ok("decision", "d2", "--title", "T", "--question", "Q?", "--decide", "yes", "--resolution", "said in the session")
        self.assertIn("not asked of the user on the page", self.refused("approval", "add", "K2", "--rule", "r", "--by", "luiz", "--ref", "d2"))
        self.ok("decision", "d3", *CHOICE, "--asks", "manager")
        self.answer("d3")
        self.ok("decision", "d3", "--decide", "A", "--resolution", "answered by the manager")
        self.assertIn("not asked of the user", self.refused("approval", "add", "K3", "--rule", "r", "--by", "luiz", "--ref", "d3"))
        self.assertNotIn("approvals", self.state())

    def test_an_approvals_id_is_k_and_a_number(self):
        self.ok("decision", "d1", *CHOICE)
        self.answer("d1")
        self.ok("decision", "d1", "--decide", "A", "--resolution", "answered on the page (#1)")
        self.assertIn("K and a number", self.refused("approval", "add", "A1", "--rule", "r", "--by", "luiz", "--ref", "d1"))

    def test_an_approval_keeps_where_it_came_from(self):
        self.approved()
        a = self.state()["approvals"][0]
        self.assertEqual({k: a[k] for k in ("id", "by", "ref", "message", "author", "status")},
                         {"id": "K1", "by": "luiz", "ref": "d1", "message": 1, "author": "luiz@github", "status": "active"})
        self.assertIn("already recorded", self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "d1"))
        self.assertIn("approval K1 active [0 notices]", self.ok("approval", "list").stdout)

    def test_a_revoked_approval_takes_no_more_notices(self):
        self.approved()
        self.assertIn("--reason", self.refused("approval", "revoke", "K1"))
        self.ok("approval", "revoke", "K1", "--reason", "revoked on the page (#3)")
        self.assertEqual(self.state()["approvals"][0]["status"], "revoked")
        self.assertIn("was revoked", self.refused("decision", "n1", *NOTICE))
        self.assertIn("already revoked", self.refused("approval", "revoke", "K1", "--reason", "again"))


class NoticeTest(Fleet):
    def serve_manager(self) -> None:
        self.home.mkdir(exist_ok=True)
        (self.home / "manager.json").write_text(json.dumps({"id": "manager", "role": "manager", "dir": str(self.root.parent / "m"),
                                                            "url": "http://box:7420/f/manager/", "pid": os.getpid(), "session": None}))

    def test_with_no_manager_a_notice_posts_no_news(self):
        self.approved()
        self.assertIn("no manager is served: no news item", self.ok("decision", "n1", *NOTICE).stdout)
        self.assertFalse((self.home / "news" / "news.jsonl").exists())

    def test_a_notice_closes_at_once_and_tells_the_manager(self):
        self.approved()
        self.serve_manager()
        out = self.ok("decision", "n1", *NOTICE).stdout
        self.assertIn("news #1 tells the manager", out)
        n = next(d for d in self.state()["decisions"] if d["id"] == "n1")
        self.assertEqual((n["kind"], n["status"], n["under"], n["answer"], n["resolution"], n["closed"] == n["opened"]),
                         ("notice", "decided", "K1", "done", "under K1", True))
        self.assertEqual(n["ref"], "N1")
        item = json.loads((self.home / "news" / "news.jsonl").read_text().splitlines()[0])
        self.assertEqual((item["from"], item["to"], item["kind"]), ("acme-billing", ["manager"], "fyi"))
        self.assertIn("Undo: jj revert the stack and push", item["text"])
        self.assertFalse(self.state()["events"][-1].get("important"))

    def test_a_notice_names_an_active_approval_and_asks_nothing(self):
        self.approved()
        self.assertIn("unknown approval 'K9'", self.refused("decision", "n1", *NOTICE[:2], "--under", "K9", *NOTICE[4:]))
        self.assertIn("--undo", self.refused("decision", "n1", *NOTICE[:-2]))
        self.assertIn("leave out --option, --recommend", self.refused("decision", "n1", *NOTICE, "--option", "A: a | b", "--recommend", "A"))
        self.assertIn("give --kind notice", self.refused("decision", "n1", *NOTICE[2:]))
        self.assertFalse((self.home / "news" / "news.jsonl").exists())


class AdvisedTest(Fleet):
    def input(self, id_: str, *more: str) -> subprocess.CompletedProcess:
        return self.ok("decision", id_, "--kind", "input", "--title", "T", "--question", "Which port?", "--why", "w", *more)

    def test_the_third_choice_of_a_day_with_no_advisor_is_warned(self):
        self.assertNotIn("--advised", self.input("d1").stderr)
        self.assertNotIn("--advised", self.input("d2").stderr)
        self.assertIn("d3 is choice 3 this fleet asks the user today, and no advisor runs", self.input("d3").stderr)
        self.assertNotIn("--advised", self.input("d4", "--advised", "none:it is a port, nothing to judge").stderr)

    def test_a_fleet_with_an_advisor_is_told_to_ask_it(self):
        self.ok("agent", "advisor", "--task", "t", "--milestone", "m1", "--model", "fable", "--status", "queued")
        self.assertIn("d1 asks the user with no --advised", self.input("d1").stderr)
        self.input("d2", "--advised", "Port 7420: the hub's")
        self.assertEqual(next(d for d in self.state()["decisions"] if d["id"] == "d2")["advised"], "Port 7420: the hub's")
        self.assertIn("--advised is the advisor's view", self.refused("decision", "d5", "--kind", "input", "--title", "T",
                                                                       "--question", "q", "--why", "w", "--advised", "none: "))


class ReviewedTest(Fleet):
    def test_a_reviewed_event_carries_its_findings_and_changes(self):
        self.ok("event", "--kind", "reviewed", "--findings", "2", "--changes", "kxyzabcd, lmnopqrs", "reviewed with tstack:review")
        e = self.state()["events"][-1]
        self.assertEqual((e["kind"], e["findings"], e["changes"]), ("reviewed", 2, ["kxyzabcd", "lmnopqrs"]))
        self.assertIn("--findings N", self.refused("event", "--kind", "reviewed", "r"))
        self.assertIn("go with --kind reviewed", self.refused("event", "--findings", "1", "a note"))


class FleetWideTest(Fleet):
    """One grilling on the manager's page answers a standing approval for every fleet."""
    GRILL = ["--title", "Standing approvals for every fleet",
             "--ask", "Landing | May a change land on master once it passed the full gate and the review rule? | yes | routine",
             "--ask", "Staging | May the fleet deploy to the staging targets you name? | a | routine",
             "--option", "Q2 a: yes | it deploys", "--option", "Q2 b: no | every deploy asks"]

    def setUp(self):
        super().setUp()
        self.manager = self.root.parent / "m"
        self.other = self.root.parent / "c2"
        self.at(self.manager, "init", "--project", "manager", "--goal", "g", "--role", "manager")
        self.at(self.other, "init", "--project", "infra", "--goal", "g")
        self.home.mkdir(exist_ok=True)
        for i, (name, root) in enumerate((("manager", self.manager), ("acme-billing", self.root), ("infra", self.other))):
            (self.home / f"{name}.json").write_text(json.dumps({
                "id": name, "role": "manager" if name == "manager" else "coordinator", "dir": str(root),
                "url": f"http://box:7420/f/{name}/", "pid": os.getpid(), "session": None, "since": f"2026-01-05T08:0{i}:00+00:00"}))
        self.at(self.manager, "grill", "g1", *self.GRILL)
        self.said(self.manager, {"id": 1, "from": "user", "author": "luiz@github", "text": "Q1: yes\nQ2: (b) no", "decision": "g1"})
        self.at(self.manager, "grill", "g1", "--answer", "Q1: yes", "--answer", "Q2: (b) no")
        self.at(self.manager, "grill", "g1", "--done", "landing yes, staging no")

    def at(self, root: Path, *args: str, code: int = 0) -> subprocess.CompletedProcess:
        result = subprocess.run([sys.executable, STATE, str(root), *args, "--no-render"], capture_output=True, text=True, timeout=20, env=self.env)
        self.assertEqual(result.returncode, code, result.stderr)
        return result

    def fleets(self, *args: str, code: int = 0) -> subprocess.CompletedProcess:
        result = subprocess.run([sys.executable, FLEETS, *args], capture_output=True, text=True, timeout=60, env=self.env)
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        return result

    def said(self, root: Path, message: dict) -> None:
        with open(root / "chat.jsonl", "a") as f:
            f.write(json.dumps({"at": "2026-01-05T09:10:00+00:00", "to": ["manager"], "re": None, **message}) + "\n")

    def approvals(self, root: Path) -> list[dict]:
        return json.loads((root / "state.json").read_text()).get("approvals", [])

    def test_a_question_answered_yes_in_another_fleet_gives_the_approval(self):
        self.ok("approval", "add", "K1", "--rule", "land", "--by", "luiz", "--ref", "manager/G1:Q1")
        a = self.approvals(self.root)[0]
        self.assertEqual({k: a.get(k) for k in ("ref", "question", "message", "author")},
                         {"ref": "manager/G1", "question": "q1", "message": 1, "author": "luiz@github"})
        self.assertIn("(from manager/G1:Q1 #1, by luiz", self.ok("approval", "list").stdout)
        self.assertNotIn("decision", self.state()["events"][-1])

    def test_a_question_answered_otherwise_is_refused_with_its_answer(self):
        self.assertIn("manager/G1:Q2 was answered '(b) no'", self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/G1:Q2"))
        self.assertIn("is a grilling: name the question", self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/G1"))
        self.assertIn("no fleet 'nowhere' is being served", self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "nowhere/G1:Q1"))
        self.assertNotIn("approvals", self.state())

    def test_an_answer_not_written_by_the_hub_is_refused(self):
        self.at(self.manager, "decision", "d1", *CHOICE)
        self.said(self.manager, {"id": 2, "from": "manager", "text": "Luiz said yes in the session", "decision": "d1"})
        self.at(self.manager, "decision", "d1", "--decide", "A", "--resolution", "relayed")
        self.assertIn("manager/D1 (Landing without asking) has no answer from the user in the chat",
                      self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/D1"))

    def test_every_fleet_takes_it_once(self):
        self.ok("approval", "add", "K1", "--rule", "an older one", "--by", "luiz", "--ref", "manager/G1:Q1")
        out = self.fleets("approval", "add", "--all", "--rule", "land", "--ref", "manager/G1:Q1").stdout.splitlines()
        self.assertEqual(out, ["manager: added K1", "acme-billing: skipped, K1 already comes from manager/G1:Q1 (active)", "infra: added K1"])
        again = self.fleets("approval", "add", "--all", "--rule", "land", "--ref", "manager/G1:Q1").stdout
        self.assertEqual(again.count("skipped"), 3)
        self.assertEqual([a["by"] for a in self.approvals(self.other)], ["luiz@github"])
        self.assertIn("was answered '(b) no'", self.fleets("approval", "add", "--fleets", "infra", "--rule", "r", "--ref", "manager/G1:Q2", code=1).stderr)
        self.assertEqual(len(self.approvals(self.other)), 1)

    def test_revoke_takes_it_back_everywhere(self):
        self.fleets("approval", "add", "--all", "--rule", "land", "--ref", "manager/G1:Q1")
        out = self.fleets("approval", "revoke", "--ref", "manager/G1:Q1", "--reason", "revoked on the page (#3)").stdout.splitlines()
        self.assertEqual(out, ["manager: revoked K1", "acme-billing: revoked K1", "infra: revoked K1"])
        for root in (self.manager, self.root, self.other):
            self.assertEqual([(a["status"], a["revoked_why"]) for a in self.approvals(root)], [("revoked", "revoked on the page (#3)")])
        self.assertEqual(self.fleets("approval", "revoke", "--ref", "manager/G1:Q1", "--reason", "again").stdout.count("none active"), 3)


if __name__ == "__main__":
    unittest.main()
