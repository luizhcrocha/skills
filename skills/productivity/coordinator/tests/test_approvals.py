"""Standing approvals, notices, the advisor's view and reviewed events, through the state CLI: the user's
answer on the page is the only source of an approval, an act under one is recorded closed and told to the
fleets, and a choice that reaches the user without the advisor's view is warned."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
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
        self.assertIn("D1 backed approval K1, revoked (", self.refused("approval", "add", "K2", "--rule", "land again", "--by", "luiz", "--ref", "D1"))


class PlainYesTest(Fleet):
    """Only the user's own plain yes to that exact item grants."""

    def said(self, text: str, n: int = 1, decision: str = "d1") -> None:
        with open(self.root / "chat.jsonl", "a") as f:
            f.write(json.dumps({"id": n, "at": "2026-01-05T09:10:00+00:00", "from": "user", "author": "luiz@github",
                                "to": ["coordinator"], "text": text, "re": None, "decision": decision}) + "\n")

    def test_the_whole_answer_is_the_yes_and_a_qualifier_refuses(self):
        sys.path.insert(0, str(SCRIPTS))
        import decisions
        options = [{"id": "a", "label": "yes", "consequence": ""}]
        for text in ("yes", "Yes.", "OK!", "sim", "y", "approve", "approved", "(a)", "a: yes", "a yes",
                     "ok, as recommended (yes)", "as recommended", "a: yes (as recommended)"):
            self.assertTrue(decisions.approves({"answer": text, "options": options, "recommend": "yes"}), text)
        for text in ("yes, but never to prod", "Yes for staging only; no for prod", "approved?? no wait", "no",
                     "(a) but not on fridays", "yes?", "ok, as recommended (yes). Not on prod", ""):
            self.assertFalse(decisions.approves({"answer": text, "options": options, "recommend": "yes"}), text)
        self.assertIsNone(decisions.plain_answer("(a) but not on fridays", options))
        self.assertTrue(decisions.plain_yes("  YES!  "))

    def test_a_choice_decided_no_gives_none(self):
        self.ok("decision", "d1", *CHOICE)
        self.said("B: no")
        self.ok("decision", "d1", "--decide", "B", "--resolution", "answered on the page (#1)")
        why = self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "D1")
        self.assertIn("D1 (Landing without asking) was decided 'B', not a plain yes", why)
        self.assertIn("ask the user again for a plain yes or no", why)
        self.assertNotIn("approvals", self.state())

    def test_a_choice_decided_yes_needs_the_users_own_pick_of_that_option(self):
        self.ok("decision", "d1", *CHOICE)
        self.said("B: no")
        self.ok("decision", "d1", "--decide", "A", "--resolution", "answered on the page (#1)")
        self.assertIn("the user's own answer in the chat (#1) is 'B: no', not a plain yes",
                      self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "D1"))
        self.said("A: yes\nbut never to prod", 2)
        self.assertIn("(#2) is 'A: yes\\nbut never to prod'", self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "D1"))
        self.said("A: yes", 3)
        self.ok("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "D1")
        self.assertEqual(self.state()["approvals"][0]["message"], 3)

    def test_a_choice_decided_with_a_qualifier_gives_none(self):
        self.ok("decision", "d1", *CHOICE)
        self.said("A: yes")
        self.ok("decision", "d1", "--decide", "A: yes, but not on fridays", "--resolution", "answered on the page (#1)")
        self.assertIn("was decided 'A: yes, but not on fridays', not a plain yes",
                      self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "D1"))


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
            f.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "to": ["manager"], "re": None, **message}) + "\n")

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


    def grill2(self, q2_recommend: str = "yes") -> None:
        self.at(self.manager, "grill", "g2", "--title", "Prod", "--ask", "Landing | May it land? | yes | r",
                "--ask", f"Prod | May it deploy to prod? | {q2_recommend} | r")

    def close2(self) -> None:
        self.at(self.manager, "grill", "g2", "--answer", "Q1: yes", "--answer", "Q2: yes")
        self.at(self.manager, "grill", "g2", "--done", "x")

    def test_the_ledgers_yes_is_not_enough_the_users_own_answer_must_say_it(self):
        self.grill2("no")
        self.said(self.manager, {"id": 2, "from": "user", "author": "luiz@github", "text": "Q1: yes\nQ2: no", "decision": "g2"})
        self.close2()
        why = self.refused("approval", "add", "K1", "--rule", "deploy to prod", "--by", "luiz", "--ref", "manager/G2:Q2")
        self.assertIn("manager/G2:Q2: the user's own answer in the chat (#2) is 'no', not a plain yes", why)
        self.assertIn("ask the user again for a plain yes or no", why)
        self.ok("approval", "add", "K1", "--rule", "land", "--by", "luiz", "--ref", "manager/G2:Q1")
        self.assertEqual([(a["question"], a["message"]) for a in self.approvals(self.root)], [("q1", 2)])

    def test_a_message_that_does_not_answer_that_question_gives_none(self):
        self.grill2()
        self.said(self.manager, {"id": 2, "from": "user", "author": "luiz@github", "text": "Q1: yes", "decision": "g2"})
        self.close2()
        self.assertIn("manager/G2:Q2 has no answer from the user in the chat",
                      self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/G2:Q2"))
        self.said(self.manager, {"id": 3, "from": "user", "author": "luiz@github", "text": "Q2: yes, but never to prod", "decision": "g2"})
        self.assertIn("(#3) is 'yes, but never to prod', not a plain yes",
                      self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/G2:Q2"))

    def test_a_reply_to_the_message_that_asked_that_question_alone_answers_it(self):
        self.grill2()
        self.said(self.manager, {"id": 2, "from": "manager", "text": "Q2 again, plainly: may it deploy to prod?", "decision": "g2"})
        self.said(self.manager, {"id": 3, "from": "user", "author": "luiz@github", "text": "yes", "re": 2})
        self.close2()
        self.assertIn("manager/G2:Q1 has no answer from the user",
                      self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/G2:Q1"))
        self.ok("approval", "add", "K1", "--rule", "deploy to prod", "--by", "luiz", "--ref", "manager/G2:Q2")
        self.assertEqual(self.approvals(self.root)[0]["message"], 3)

    def test_a_question_answered_yes_grants_while_another_is_still_open(self):
        self.at(self.manager, "grill", "g2", "--title", "Prod", "--ask", "Landing | May it land? | yes | r",
                "--ask", "Prod | May it deploy to prod? | a | r", "--option", "Q2 a: yes | it deploys", "--option", "Q2 b: no | every deploy asks")
        self.said(self.manager, {"id": 2, "from": "user", "author": "luiz@github", "text": "Q2: a: yes", "decision": "g2"})
        self.at(self.manager, "grill", "g2", "--answer", "Q2: a: yes")
        why = self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/G2:Q1")
        self.assertIn("manager/G2:Q1 is open, not answered yet: a standing approval comes from a question the user answered", why)
        self.ok("approval", "add", "K1", "--rule", "deploy to prod", "--by", "luiz", "--ref", "manager/G2:Q2")
        self.assertEqual([(a["question"], a["message"]) for a in self.approvals(self.root)], [("q2", 2)])
        out = self.fleets("approval", "add", "--all", "--rule", "deploy to prod", "--ref", "manager/G2:Q2").stdout.splitlines()
        self.assertEqual(out, ["manager: added K1", "acme-billing: skipped, K1 already comes from manager/G2:Q2 (active)", "infra: added K1"])
        self.assertIn("manager/G2:Q1 is open, not answered yet",
                      self.fleets("approval", "add", "--all", "--rule", "r", "--ref", "manager/G2:Q1", code=1).stderr)

    G2 = ["--title", "Prod", "--ask", "Landing | May it land? | yes | r", "--ask", "Prod | May it deploy to prod? | yes | r"]

    def q2_yes(self) -> None:
        """Grilling g2 in the manager's ledger, its Q2 answered yes by the user on the page, Q1 still open."""
        self.at(self.manager, "grill", "g2", *self.G2)
        self.said(self.manager, {"id": 2, "from": "user", "author": "luiz@github", "text": "Q2: yes", "decision": "g2"})
        self.at(self.manager, "grill", "g2", "--answer", "Q2: yes")

    def test_an_approval_is_checked_again_at_use_a_later_no_refuses_the_notice(self):
        self.q2_yes()
        self.ok("approval", "add", "K1", "--rule", "deploy to prod", "--by", "luiz", "--ref", "manager/G2:Q2")
        self.said(self.manager, {"id": 3, "from": "user", "author": "luiz@github", "text": "Q2: no", "decision": "g2"})
        self.at(self.manager, "grill", "g2", "--answer", "Q2: no")
        why = self.refused("decision", "n1", *NOTICE)
        self.assertIn("approval K1 no longer stands: manager/G2:Q2 was answered 'no'", why)
        self.assertIn("approval revoke K1", why)
        self.assertEqual([d for d in self.state()["decisions"] if d["kind"] == "notice"], [])

    def test_a_source_fleet_no_longer_served_is_read_from_where_the_registry_kept_it(self):
        self.q2_yes()
        self.ok("approval", "add", "K1", "--rule", "deploy to prod", "--by", "luiz", "--ref", "manager/G2:Q2")
        (self.home / "manager.json").unlink()
        (self.home / "names").mkdir(exist_ok=True)
        (self.home / "names" / "manager.json").write_text(json.dumps({"id": "manager", "role": "manager", "dir": str(self.manager),
                                                                      "url": "x", "pid": 999999999, "session": None}))
        self.ok("decision", "n1", *NOTICE)
        (self.home / "names" / "manager.json").unlink()
        self.assertIn("approval K1 no longer stands: no fleet 'manager' is being served", self.refused("decision", "n2", *NOTICE))

    def test_a_question_answered_again_revised_or_dropped_revokes_the_approvals_it_gave_in_its_own_ledger(self):
        self.q2_yes()
        self.fleets("approval", "add", "--all", "--rule", "deploy to prod", "--ref", "manager/G2:Q2")
        self.said(self.manager, {"id": 3, "from": "user", "author": "luiz@github", "text": "Q2: no", "decision": "g2"})
        self.assertIn("revoked approval K1 (from manager/G2:Q2): G2:Q2 was answered again (no)",
                      self.at(self.manager, "grill", "g2", "--answer", "Q2: no").stdout)
        self.assertEqual([(a["status"], a["revoked_why"]) for a in self.approvals(self.manager)], [("revoked", "G2:Q2 was answered again (no)")])
        self.assertEqual([a["status"] for a in self.approvals(self.root)], ["active"])
        self.assertIn("approval K1 no longer stands", self.refused("decision", "n1", *NOTICE))
        self.at(self.root, "grill", "g3", *self.G2)
        with open(self.root / "chat.jsonl", "a") as f:
            f.write(json.dumps({"id": 9, "at": "2099-01-01T00:00:00+00:00", "from": "user", "author": "luiz@github", "to": ["coordinator"],
                                "text": "Q1: yes\nQ2: yes", "re": None, "decision": "g3"}) + "\n")
        self.at(self.root, "grill", "g3", "--answer", "Q1: yes", "--answer", "Q2: yes")
        self.ok("approval", "add", "K2", "--rule", "land", "--by", "luiz", "--ref", "G1:Q1")
        self.ok("approval", "add", "K3", "--rule", "deploy", "--by", "luiz", "--ref", "G1:Q2")
        self.assertIn("revoked approval K2 (from g3:Q1): G1:Q1 was revised",
                      self.at(self.root, "grill", "g3", "--revise", "Q1: Landing | May it land on Fridays? | yes | r").stdout)
        self.assertIn("revoked approval K3 (from g3:Q2): G1:Q2 was dropped (not needed)",
                      self.at(self.root, "grill", "g3", "--drop", "Q2: not needed").stdout)
        self.assertEqual([(a["id"], a["status"]) for a in self.approvals(self.root)], [("K1", "active"), ("K2", "revoked"), ("K3", "revoked")])

    def test_a_withdrawn_grilling_revokes_every_approval_it_gave_and_gives_none(self):
        self.q2_yes()
        self.fleets("approval", "add", "--fleets", "manager", "--rule", "deploy to prod", "--ref", "manager/G2:Q2")
        self.assertIn("revoked approval K1 (from manager/G2:Q2): G2 was withdrawn (plan dropped)",
                      self.at(self.manager, "decision", "g2", "--withdraw", "plan dropped").stdout)
        self.assertIn("manager/G2 (Prod) was withdrawn", self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/G2:Q2"))

    def test_a_superseded_grilling_gives_none(self):
        self.q2_yes()
        self.said(self.manager, {"id": 3, "from": "user", "author": "luiz@github", "text": "Q1: yes", "decision": "g2"})
        self.at(self.manager, "grill", "g2", "--answer", "Q1: yes", "--done", "both yes")
        self.at(self.manager, "decision", "d9", *CHOICE, "--supersedes", "g2")
        self.assertIn("manager/G2 (Prod) is superseded by D1",
                      self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/G2:Q2"))

    def test_the_users_words_count_only_from_when_the_question_was_last_asked(self):
        self.at(self.manager, "grill", "g2", *self.G2)
        self.said(self.manager, {"id": 2, "at": "2026-01-05T09:10:00+00:00", "from": "user", "author": "luiz@github", "text": "Q2: yes", "decision": "g2"})
        self.at(self.manager, "grill", "g2", "--revise", "Q2: Prod | May it deploy AND migrate prod DBs? | yes | r")
        self.at(self.manager, "grill", "g2", "--answer", "Q2: yes")
        self.assertIn("manager/G2:Q2 has no answer from the user in the chat since it was last asked",
                      self.refused("approval", "add", "K1", "--rule", "migrate", "--by", "luiz", "--ref", "manager/G2:Q2"))
        self.said(self.manager, {"id": 3, "from": "user", "author": "luiz@github", "text": "Q2: yes", "decision": "g2"})
        self.ok("approval", "add", "K1", "--rule", "migrate", "--by", "luiz", "--ref", "manager/G2:Q2")

    SECOND = "2026-01-05T09:30:00+00:00"  # every command and message of a test that sets it: a revise may share a second

    def asked(self, n: int) -> dict:
        g2 = next(d for d in json.loads((self.manager / "state.json").read_text())["decisions"] if d["id"] == "g2")
        return g2["questions"][n - 1]

    def revised_in_one_second(self) -> None:
        """G2 with its Q2 revised after the user's "Q2: yes" to the old Q2, all in one second, and answered yes."""
        self.env.update(FLEET_NOW=self.SECOND, TZ="UTC")
        self.at(self.manager, "grill", "g2", *self.G2)
        self.said(self.manager, {"id": 2, "at": self.SECOND, "from": "user", "author": "luiz@github", "text": "Q2: yes", "decision": "g2"})
        self.at(self.manager, "grill", "g2", "--revise", "Q2: Prod | May it deploy AND migrate prod DBs? | yes | r")
        self.at(self.manager, "grill", "g2", "--answer", "Q2: yes")

    def test_an_old_yes_in_the_same_second_as_the_revise_does_not_answer_the_revised_question(self):
        self.revised_in_one_second()
        self.assertEqual([self.asked(2)["asked"], self.asked(2)["asked_after"]], [self.SECOND, 2])
        self.assertIn("manager/G2:Q2 has no answer from the user in the chat since it was last asked",
                      self.refused("approval", "add", "K1", "--rule", "migrate", "--by", "luiz", "--ref", "manager/G2:Q2"))

    def test_a_yes_after_the_revise_answers_it_in_the_same_second_too(self):
        self.revised_in_one_second()
        self.said(self.manager, {"id": 3, "at": self.SECOND, "from": "user", "author": "luiz@github", "text": "Q2: yes", "decision": "g2"})
        self.ok("approval", "add", "K1", "--rule", "migrate", "--by", "luiz", "--ref", "manager/G2:Q2")
        self.assertEqual([(a["question"], a["message"]) for a in self.approvals(self.root)], [("q2", 3)])

    def test_a_question_recorded_without_asked_after_keeps_the_time_rule(self):
        self.revised_in_one_second()
        path = self.manager / "state.json"
        ledger = json.loads(path.read_text())
        for q in next(d for d in ledger["decisions"] if d["id"] == "g2")["questions"]:
            q.pop("asked_after", None)
        path.write_text(json.dumps(ledger))
        self.ok("approval", "add", "K1", "--rule", "migrate", "--by", "luiz", "--ref", "manager/G2:Q2")
        self.assertEqual([(a["question"], a["message"]) for a in self.approvals(self.root)], [("q2", 2)])

    def test_a_choice_still_open_gives_none(self):
        self.at(self.manager, "decision", "d1", *CHOICE)
        self.said(self.manager, {"id": 2, "from": "user", "author": "luiz@github", "text": "A: yes", "decision": "d1"})
        self.assertIn("manager/D1 (Landing without asking) is open: a standing approval comes from a decision the user decided",
                      self.refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/D1"))

    def stop(self, name: str, root: Path) -> None:
        (self.home / f"{name}.json").write_text(json.dumps({"id": name, "role": "coordinator", "dir": str(root), "url": "x",
                                                            "pid": 999999999, "session": None, "since": "2026-01-05T08:02:00+00:00"}))

    def test_revoke_reaches_a_fleet_that_is_not_served_now(self):
        self.fleets("approval", "add", "--all", "--rule", "land", "--ref", "manager/G1:Q1")
        self.stop("infra", self.other)
        out = self.fleets("approval", "revoke", "--ref", "manager/G1:Q1", "--reason", "revoked on the page (#3)").stdout.splitlines()
        self.assertEqual(out, ["manager: revoked K1", "acme-billing: revoked K1", "infra: revoked K1"])
        self.assertEqual([a["status"] for a in self.approvals(self.other)], ["revoked"])

    def test_revoke_names_the_fleet_it_could_not_reach_and_fails(self):
        self.fleets("approval", "add", "--all", "--rule", "land", "--ref", "manager/G1:Q1")
        self.stop("infra", self.other)
        (self.other / "state.json").unlink()
        r = self.fleets("approval", "revoke", "--ref", "manager/G1:Q1", "--reason", "revoked on the page (#3)", code=1)
        self.assertEqual(r.stdout.splitlines(), ["manager: revoked K1", "acme-billing: revoked K1",
                                                 f"infra: not reached, no ledger at {self.other / 'state.json'}"])
        self.assertIn("not reached: infra; the approval is still active there", r.stderr)

    def test_concurrent_adds_skip_what_another_just_added(self):
        runs = [subprocess.Popen([sys.executable, FLEETS, "approval", "add", "--all", "--rule", "land", "--ref", "manager/G1:Q1"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env) for _ in range(3)]
        for p in runs:
            out, err = p.communicate(timeout=60)
            self.assertEqual(p.returncode, 0, out + err)
            self.assertNotIn("refused", out)
        for root in (self.manager, self.root, self.other):
            self.assertEqual([a["id"] for a in self.approvals(root)], ["K1"])

if __name__ == "__main__":
    unittest.main()
