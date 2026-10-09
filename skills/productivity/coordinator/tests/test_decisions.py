"""The decisions seam: what waits on the user, through the state CLI and the rule for what an answer may be."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import decisions  # noqa: E402

STATE = str(SCRIPTS / "state.py")

# The registry of fleets is this machine's; the tests get one of their own.
os.environ["FLEET_HOME"] = tempfile.mkdtemp(prefix="fleet-home-")
os.environ["FLEET_DISCOVER"] = "0"

SCHEMA = ["d1", "--kind", "decision", "--title", "Invoice schema", "--question", "Migrate the invoice table or keep both shapes?",
          "--why", "invoice-gen cannot write usage lines until this is settled",
          "--option", "A: migrate now | one shape, a 20 minute lock on invoices",
          "--option", "B: keep both | no lock, two code paths until the next release",
          "--recommend", "A", "--reason", "the table is small and the second path costs every later change"]


class Fleet(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.ok("init", "--project", "p", "--goal", "g")
        self.ok("milestone", "m1", "--title", "M")
        self.ok("agent", "a1", "--task", "t", "--milestone", "m1", "--name", "invoice-gen")

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, STATE, str(self.root), *args, "--no-render"],
                              capture_output=True, text=True, timeout=20)

    def ok(self, *args: str) -> str:
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def refused(self, *args: str) -> str:
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertNotIn("Traceback", result.stderr)
        return result.stderr

    def state(self) -> dict:
        return json.loads((self.root / "state.json").read_text())

    def item(self, id_: str = "d1") -> dict:
        return next(d for d in self.state()["decisions"] if d["id"] == id_)


class OpenTest(Fleet):
    def test_a_new_item_is_open_with_its_four_fields_and_is_announced(self):
        self.ok("decision", *SCHEMA, "--blocking", "--agent", "a1")
        d = self.item()
        self.assertEqual((d["status"], d["kind"], d["blocking"], d["agent"], d["page"]), ("open", "decision", True, "a1", True))
        self.assertEqual(d["options"], [
            {"id": "A", "label": "migrate now", "consequence": "one shape, a 20 minute lock on invoices"},
            {"id": "B", "label": "keep both", "consequence": "no lock, two code paths until the next release"}])
        self.assertEqual((d["recommend"], d["revised"], d["closed"]), ("A", None, None))
        event = self.state()["events"][-1]
        self.assertEqual((event["kind"], event["decision"], event["agent"], event.get("important")), ("asked", "d1", "a1", True))
        self.assertIn("Migrate the invoice table", event["text"])

    def test_an_item_that_does_not_block_is_a_routine_event(self):
        self.ok("decision", *SCHEMA)
        self.assertFalse(self.item()["blocking"])
        self.assertNotIn("important", self.state()["events"][-1])

    def test_a_new_item_needs_its_fields(self):
        self.assertIn("--question", self.refused("decision", "d1", "--kind", "input", "--title", "T", "--why", "w"))
        self.assertIn("--why", self.refused("decision", "d1", "--kind", "input", "--title", "T", "--question", "q"))
        self.assertNotIn("decisions", {k for k, v in self.state().items() if v})

    def test_each_kind_needs_what_its_answer_control_shows(self):
        base = ["--title", "T", "--question", "q", "--why", "w"]
        self.assertIn("two options", self.refused("decision", "d1", "--kind", "decision", *base, "--option", "A: only one | c",
                                                  "--recommend", "A", "--reason", "r"))
        self.assertIn("--recommend", self.refused("decision", "d1", "--kind", "decision", *base, "--option", "A: x | c", "--option", "B: y | c"))
        self.assertIn("not one of the options", self.refused("decision", "d1", "--kind", "decision", *base, "--option", "A: x | c",
                                                             "--option", "B: y | c", "--recommend", "C", "--reason", "r"))
        self.assertIn("--secret", self.refused("decision", "d1", "--kind", "secret", *base))
        self.assertIn("--manual", self.refused("decision", "d1", "--kind", "secret", *base, "--secret", "NEO4J_PASSWORD"))
        self.assertIn("--manual", self.refused("decision", "d1", "--kind", "action", *base))
        self.ok("decision", "d1", "--kind", "input", *base)
        self.ok("decision", "d2", "--kind", "secret", *base, "--secret", "NEO4J_PASSWORD", "--manual", "secretspec set NEO4J_PASSWORD")
        self.ok("decision", "d3", "--kind", "action", *base, "--manual", "tailscale up")

    def test_a_manual_of_more_than_one_line_puts_its_commands_in_a_fence(self):
        base = ["--title", "T", "--question", "q", "--why", "w"]
        fix = ("state: --manual has 2 lines and no fence: put the commands in a fenced block (a line ```nu, the commands, a line ```),"
               " any prose outside it\n")
        self.assertEqual(self.refused("decision", "d1", "--kind", "action", *base, "--manual", "cd x\n\nmake"), fix)
        self.assertEqual(self.refused("decision", "d1", "--kind", "secret", *base, "--secret", "K", "--manual", "From the repo:\nsecretspec set K"), fix)
        self.assertEqual(self.state().get("decisions", []), [])
        self.ok("decision", "d1", "--kind", "action", *base, "--manual", "From the repo:\n\n```nu\ncd x\nmake\n```")
        self.ok("decision", "d2", "--kind", "action", *base, "--manual", "\n  tailscale up\n")
        self.assertEqual(self.refused("decision", "d2", "--manual", "cd x\nmake"), fix)
        self.assertEqual(self.item("d2")["manual"], "\n  tailscale up\n")

    def test_an_option_is_key_label_and_consequence(self):
        base = ["decision", "d1", "--kind", "decision", "--title", "T", "--question", "q", "--why", "w", "--recommend", "A", "--reason", "r"]
        self.assertIn("KEY: label | consequence", self.refused(*base, "--option", "A: no consequence", "--option", "B: y | c"))
        self.assertIn("KEY: label | consequence", self.refused(*base, "--option", "just words | c", "--option", "B: y | c"))
        self.assertIn("twice", self.refused(*base, "--option", "A: x | c", "--option", "A: y | c"))

    def test_an_id_is_a_token_and_an_agent_is_known(self):
        self.assertIn("letters", self.refused("decision", "d/1", *SCHEMA[1:]))
        self.assertIn("unknown agent", self.refused("decision", *SCHEMA, "--agent", "nobody"))


class ReviseTest(Fleet):
    def test_changing_an_open_item_stamps_revised_and_says_what_changed(self):
        self.ok("decision", *SCHEMA)
        self.ok("decision", "d1", "--why", "invoice-gen and the stripe adapter both wait", "--log", "the adapter now waits on this too")
        d = self.item()
        self.assertEqual(d["why"], "invoice-gen and the stripe adapter both wait")
        self.assertEqual(d["change"], "the adapter now waits on this too")
        self.assertIsNotNone(d["revised"])
        event = self.state()["events"][-1]
        self.assertEqual((event["kind"], event["decision"]), ("asked", "d1"))
        self.assertIn("the adapter now waits on this too", event["text"])
        self.assertNotIn("important", event)

    def test_a_revision_keeps_the_kind_consistent(self):
        self.ok("decision", *SCHEMA)
        self.assertIn("not one of the options", self.refused("decision", "d1", "--recommend", "Z"))
        self.assertIn("two options", self.refused("decision", "d1", "--option", "A: only | c"))

    def test_a_new_question_comes_with_its_options(self):
        self.ok("decision", *SCHEMA, "--blocking")
        said = self.refused("decision", "d1", "--question", "Approve deploys of this kind as a rule?", "--not-blocking")
        self.assertIn("--option", said)
        self.assertIn("--same-options", said)
        self.assertEqual(self.item()["question"], "Migrate the invoice table or keep both shapes?")
        self.ok("decision", "d1", "--question", "Approve deploys of this kind as a rule?", "--option", "yes: As a rule | no ask per deploy",
                "--option", "no: Ask each time | one decision per deploy", "--recommend", "yes", "--reason", "r")
        self.assertEqual([o["id"] for o in self.item()["options"]], ["yes", "no"])
        self.ok("decision", "d1", "--question", "Approve deploys of this kind, as a rule?", "--same-options")
        self.assertEqual([o["id"] for o in self.item()["options"]], ["yes", "no"])

    def test_only_a_choice_has_options_to_carry(self):
        self.ok("decision", "d2", "--kind", "input", "--title", "T", "--question", "q", "--why", "w")
        self.ok("decision", "d2", "--question", "another question")
        self.ok("decision", *SCHEMA)
        self.ok("decision", "d1", "--question", "Migrate the invoice table or keep both shapes?", "--why", "same question, new reason")

    def test_blocking_can_be_lifted(self):
        self.ok("decision", *SCHEMA, "--blocking")
        self.ok("decision", "d1", "--not-blocking", "--why", "the fleet proceeds on A until you say otherwise")
        self.assertFalse(self.item()["blocking"])

    def test_the_body_is_copied_beside_the_page_and_removed_on_request(self):
        source = self.root / "analysis.html"
        source.write_text("<table><tr><td>rows</td><td>1,204</td></tr></table>")
        self.ok("decision", *SCHEMA, "--body", str(source))
        self.assertTrue(self.item()["body"])
        self.assertEqual((self.root / "decisions" / "d1.html").read_text(), source.read_text())
        source.write_text("<p>new figures</p>")
        self.ok("decision", "d1", "--body", str(source), "--log", "figures as of 15:00")
        self.assertEqual((self.root / "decisions" / "d1.html").read_text(), "<p>new figures</p>")
        self.assertIsNotNone(self.item()["revised"])
        self.ok("decision", "d1", "--no-body")
        self.assertFalse(self.item()["body"])
        self.assertFalse((self.root / "decisions" / "d1.html").exists())
        self.assertIn("cannot read", self.refused("decision", "d1", "--body", str(self.root / "missing.html")))


class ReadableTest(Fleet):
    """A decision the user can read cold: the question is the ask alone, the rest goes in the body; an action's nu runs in nushell."""
    BASE = ["--why", "w", "--option", "A: yes | go", "--option", "B: no | stop", "--recommend", "A", "--reason", "r"]

    def run_without_nu(self, *args: str) -> subprocess.CompletedProcess:
        empty = tempfile.mkdtemp()
        return subprocess.run([sys.executable, STATE, str(self.root), *args, "--no-render"], capture_output=True, text=True,
                              timeout=20, env={**os.environ, "PATH": empty})

    def test_a_question_over_400_characters_is_refused_with_how_far_over(self):
        err = self.refused("decision", "d1", "--kind", "decision", "--title", "T", "--question", "x" * 401, *self.BASE)
        self.assertIn("--question is 401 characters, 1 over the 400 a question holds", err)
        self.assertIn("--body FILE", err)
        self.ok("decision", "d1", "--kind", "decision", "--title", "T", "--question", "x" * 400, *self.BASE)
        self.assertIn("1 over", self.refused("decision", "d1", "--question", "y" * 401, "--same-options"))

    def test_a_stored_long_question_still_takes_other_changes(self):
        self.ok("decision", "d1", "--kind", "decision", "--title", "T", "--question", "q?", *self.BASE)
        s = self.state()
        s["decisions"][0]["question"] = "x" * 1300
        (self.root / "state.json").write_text(json.dumps(s))
        self.ok("decision", "d1", "--why", "infra reviewed it", "--log", "infra reviewed it")
        self.assertEqual(len(self.item()["question"]), 1300)

    def test_hard_reading_is_warned_not_refused(self):
        r = self.run_cli("decision", "d1", "--kind", "decision", "--title", "T", "--question", "Re-read by sha1 and alias? " + "x" * 300,
                         "--why", "w" * 301, "--option", "A: yes | " + "c" * 161, "--option", "B: no | stop", "--recommend", "A", "--reason", "r")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("d1's question is 327 characters and it has no --body", r.stderr)
        self.assertIn("uses words the user may not know (sha1, alias)", r.stderr)
        self.assertIn("d1's why is 301 characters", r.stderr)
        self.assertIn("consequences over 160 characters: A (161)", r.stderr)
        r = self.run_cli("decision", "d1", "--question", "Ship it?", "--same-options")
        self.assertIn("d1 was asked again with new words and no --log", r.stderr)
        r = self.run_cli("decision", "d1", "--question", "Ship it now?", "--same-options", "--log", "now, not tonight")
        self.assertEqual(r.stderr, "")

    def test_a_revision_logs_only_the_fields_it_moved(self):
        self.ok("decision", "d1", "--kind", "decision", "--title", "T", "--question", "q?", *self.BASE)
        self.ok("decision", "d1", "--kind", "decision", "--title", "T", "--question", "q?", "--why", "w2", "--same-options")
        self.assertEqual(self.state()["events"][-1]["text"], "T changed: why")
        self.ok("decision", "d1", "--title", "T")
        self.assertEqual(self.state()["events"][-1]["text"], "T changed: nothing new (the same values given again)")

    def test_a_long_grilling_question_is_warned_not_refused(self):
        r = self.run_cli("grill", "g1", "--title", "T", "--ask", "t | " + "q" * 301 + " | r | w")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("g1's Q1 is 301 characters", r.stderr)
        r = self.run_cli("grill", "g1", "--revise", "Q1: t | short now? | r | w")
        self.assertNotIn("characters", r.stderr)

    def test_a_grilling_question_takes_options_and_recommends_one_by_id(self):
        self.ok("grill", "g1", "--title", "T", "--ask", "t | Where? | a | One store keeps it simple.",
                "--option", "Q1 a: Postgres | one place to undo", "--option", "Q1 b: Neo4j | quicker to query")
        q = self.item("g1")["questions"][0]
        self.assertEqual(q["options"], [{"id": "a", "label": "Postgres", "consequence": "one place to undo"},
                                        {"id": "b", "label": "Neo4j", "consequence": "quicker to query"}])
        err = self.refused("grill", "g1", "--revise", "Q1: t | Where? | (a) | w")
        self.assertIn("Q1's recommendation '(a)' is not one of its options (a, b)", err)
        self.ok("grill", "g1", "--ask", "t2 | Legacy? (a) yes; (b) no | (a) | w")
        self.assertNotIn("options", self.item("g1")["questions"][1])

    def test_a_grilling_takes_a_body_and_warns_on_a_reason_for_engineers(self):
        body = self.root / "context.html"
        body.write_text("<p>ctx</p>")
        r = self.run_cli("grill", "g1", "--title", "T", "--body", str(body),
                         "--ask", "t | q? | r | The store holds it (store.ts:5-9), per ADR-0020. " + "w" * 200)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("g1's Q1 reason is 249 characters", r.stderr)
        self.assertIn("g1's Q1 reason opens with sources (store.ts:5-9, ADR-0020)", r.stderr)
        self.assertTrue(self.item("g1")["body"])
        self.assertTrue((self.root / "decisions" / "g1.html").exists())
        self.ok("grill", "g1", "--no-body")
        self.assertEqual(self.state()["events"][-1]["text"], "T: the context changed")

    @unittest.skipUnless(shutil.which("nu"), "needs nu on PATH")
    def test_a_nu_block_that_does_not_parse_in_nushell_is_refused(self):
        base = ["--kind", "action", "--title", "T", "--question", "q", "--why", "w"]
        err = self.refused("decision", "a1", *base, "--manual", "Run:\n```nu\nfor f in *; do echo $f; done\n```")
        self.assertIn("--manual's nu block 1 does not parse in nushell (nu-check --debug: Missing argument to `in`.)", err)
        self.ok("decision", "a1", *base, "--manual", "Run:\n```nu\nls | where size > 1kb\n```\n```sh\ncd x && make\n```")

    def test_bash_in_a_nu_block_is_warned_without_nu(self):
        r = self.run_without_nu("decision", "a1", "--kind", "action", "--title", "T", "--question", "q", "--why", "w",
                                "--manual", "```nu\nexport FOO=1\ncd x && echo $(date)\n```")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("a1's manual has bash in a nu block (&&, export X=, $(...))", r.stderr)


class CloseTest(Fleet):
    def test_deciding_records_the_answer_and_how_it_came(self):
        self.ok("decision", *SCHEMA)
        self.ok("decision", "d1", "--decide", "B: keep both", "--resolution", "answered on the page (#14)")
        d = self.item()
        self.assertEqual((d["status"], d["answer"], d["resolution"]), ("decided", "B: keep both", "answered on the page (#14)"))
        self.assertIsNotNone(d["closed"])
        event = self.state()["events"][-1]
        self.assertEqual((event["kind"], event["decision"]), ("decision", "d1"))
        self.assertIn("B: keep both", event["text"])

    def test_deciding_needs_how_and_withdrawing_needs_why(self):
        self.ok("decision", *SCHEMA)
        self.assertIn("--resolution", self.refused("decision", "d1", "--decide", "A"))
        self.assertEqual(self.item()["status"], "open")
        self.ok("decision", "d1", "--withdraw", "the worker found the answer in the migration notes")
        d = self.item()
        self.assertEqual((d["status"], d["resolution"], d["answer"]), ("withdrawn", "the worker found the answer in the migration notes", None))
        self.assertEqual(self.state()["events"][-1]["kind"], "resolved")

    def test_a_closed_item_is_not_edited_or_closed_again(self):
        self.ok("decision", *SCHEMA)
        self.ok("decision", "d1", "--decide", "A", "--resolution", "said in the session")
        for args in (["--why", "new"], ["--decide", "B", "--resolution", "x"], ["--withdraw", "moot"]):
            self.assertIn("--supersedes d1", self.refused("decision", "d1", *args))
        self.assertEqual(self.item()["answer"], "A")

    def test_a_new_item_supersedes_a_closed_one(self):
        self.ok("decision", *SCHEMA)
        self.assertIn("still open", self.refused("decision", "d2", *SCHEMA[1:], "--supersedes", "d1"))
        self.ok("decision", "d1", "--decide", "A", "--resolution", "said in the session")
        self.ok("decision", "d2", *SCHEMA[1:], "--supersedes", "d1")
        self.assertEqual(self.item("d2")["supersedes"], "d1")
        self.assertIn("unknown decision", self.refused("decision", "d3", *SCHEMA[1:], "--supersedes", "d9"))

    def test_a_decision_made_elsewhere_is_recorded_closed_and_has_no_page(self):
        self.ok("decision", "d1", "--title", "Model for the rename sweep", "--question", "Haiku for the rename sweep?",
                "--decide", "yes", "--resolution", "said in the session")
        d = self.item()
        self.assertEqual((d["status"], d["kind"], d["page"], d["answer"]), ("decided", "decision", False, "yes"))
        self.assertEqual([e["kind"] for e in self.state()["events"] if e.get("decision") == "d1"], ["decision"])


class AsksTest(Fleet):
    def test_a_decision_asks_the_user_unless_it_is_put_to_the_manager(self):
        self.ok("decision", *SCHEMA)
        self.assertEqual(self.item()["asks"], "user")

    def test_one_put_to_the_manager_does_not_call_the_user(self):
        self.ok("decision", *SCHEMA, "--blocking", "--asks", "manager")
        self.assertEqual(self.item()["asks"], "manager")
        event = self.state()["events"][-1]
        self.assertEqual(event["kind"], "asked")
        self.assertNotIn("important", event)
        self.assertTrue(event["text"].startswith("For the manager: "))

    def test_passing_it_to_the_user_calls_them(self):
        self.ok("decision", *SCHEMA, "--blocking", "--asks", "manager")
        self.ok("decision", "d1", "--asks", "user", "--log", "the manager passed it on: the choice is yours")
        d = self.item()
        self.assertEqual((d["asks"], d["change"]), ("user", "the manager passed it on: the choice is yours"))
        event = self.state()["events"][-1]
        self.assertEqual((event["kind"], event.get("important"), event["decision"]), ("asked", True, "d1"))


class RoadblockTest(Fleet):
    ROADBLOCK = ["roadblock", "r1", "--title", "Schema undecided", "--detail", "invoice-gen is stopped", "--severity", "serious",
                 "--needs", "user", "--agent", "a1"]

    def test_a_roadblock_that_needs_the_user_names_its_decision(self):
        self.assertIn("--decision", self.refused(*self.ROADBLOCK))
        self.assertIn("unknown decision", self.refused(*self.ROADBLOCK, "--decision", "d1"))
        self.ok("decision", *SCHEMA, "--blocking", "--agent", "a1")
        self.ok(*self.ROADBLOCK, "--decision", "d1")
        self.assertEqual(self.state()["roadblocks"][0]["decision"], "d1")
        self.ok("roadblock", "r2", "--title", "T", "--detail", "D", "--severity", "warning", "--needs", "coordinator")

    def test_closing_the_decision_clears_its_roadblocks_and_frees_the_worker(self):
        self.ok("decision", *SCHEMA, "--blocking", "--agent", "a1")
        self.ok(*self.ROADBLOCK, "--decision", "d1")
        self.assertEqual(self.state()["agents"][0]["status"], "blocked")
        self.ok("decision", "d1", "--decide", "A", "--resolution", "answered on the page")
        state = self.state()
        self.assertTrue(state["roadblocks"][0]["resolved"])
        self.assertEqual(state["agents"][0]["status"], "running")

    def test_a_roadblock_cannot_hang_on_a_closed_decision(self):
        self.ok("decision", *SCHEMA)
        self.ok("decision", "d1", "--withdraw", "moot")
        self.assertIn("withdrawn", self.refused(*self.ROADBLOCK, "--decision", "d1"))


class LedgerTest(Fleet):
    def test_show_lists_what_waits_and_what_was_decided(self):
        self.ok("decision", *SCHEMA, "--blocking")
        self.ok("decision", "d2", "--kind", "input", "--title", "Rate limit", "--question", "q", "--why", "w")
        self.ok("decision", "d2", "--decide", "200 per minute", "--resolution", "said in the chat (#3)")
        out = subprocess.run([sys.executable, STATE, str(self.root), "show"], capture_output=True, text=True).stdout
        self.assertIn("decision d1 OPEN, blocking [decision] Invoice schema", out)
        self.assertIn("decision d2 decided [input] Rate limit: 200 per minute", out)

    def test_a_state_from_before_decisions_still_renders(self):
        state = self.state()
        del state["decisions"]
        (self.root / "state.json").write_text(json.dumps(state))
        result = subprocess.run([sys.executable, STATE, str(self.root), "set", "--now", "later"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state()["decisions"], [])
        self.assertTrue((self.root / "index.html").exists())

    def test_a_state_whose_decisions_are_malformed_is_refused(self):
        self.ok("decision", *SCHEMA)
        good = (self.root / "state.json").read_text()
        for change, word in [({"status": "maybe"}, "status"), ({"kind": "poll"}, "kind"), ({"supersedes": "d9"}, "d9")]:
            state = json.loads(good)
            state["decisions"][0].update(change)
            (self.root / "state.json").write_text(json.dumps(state))
            self.assertIn(word, self.refused("set", "--now", "x"))


ACTION = ["a1", "--kind", "action", "--title", "Run the role cut", "--question", "Run the pipeline role cut?",
          "--why", "the cut feeds the next milestone", "--manual", "just cut --roles"]


class HoldTest(Fleet):
    """The user answered, and the fleet must do something before the item can proceed: it holds it (off the
    user's list, the answer counted as recorded) until it re-presents it with new words."""

    def answer(self, text: str = "needs a code change first", at: str = "2999-01-01T00:00:00+00:00") -> None:
        line = {"id": 1, "at": at, "from": "user", "to": ["coordinator"], "text": text, "re": None, "decision": "a1"}
        (self.root / "chat.jsonl").write_text(json.dumps(line) + "\n")

    def hold(self, reason: str = "fix the role cut first") -> None:
        os.environ["FLEET_NOW"] = "2999-01-01T00:01:00+00:00"
        try:
            self.ok("decision", "A1", "--hold", reason)
        finally:
            del os.environ["FLEET_NOW"]

    def test_holding_an_answered_item_records_the_answer_and_logs_why(self):
        self.ok("decision", *ACTION)
        self.answer()
        self.assertIn("the user answered A1", self.run_cli("event", "x").stderr)
        self.hold()
        d = self.item("a1")
        self.assertEqual((d["status"], d["held"]), ("open", "fix the role cut first"))
        self.assertEqual(datetime.fromisoformat(d["held_at"]), datetime.fromisoformat("2999-01-01T00:01:00+00:00"))
        event = self.state()["events"][-1]
        self.assertEqual((event["kind"], event["text"], event["decision"], event.get("important")),
                         ("note", "Run the role cut held by the fleet: fix the role cut first", "a1", None))
        self.assertNotIn("the user answered", self.run_cli("event", "y").stderr)
        show = subprocess.run([sys.executable, STATE, str(self.root), "show"], capture_output=True, text=True).stdout
        self.assertIn("decision a1 OPEN, held by the fleet (fix the role cut first) [action] Run the role cut", show)

    def test_an_answer_given_after_the_hold_is_news_again(self):
        self.ok("decision", *ACTION)
        self.answer()
        self.hold()
        self.answer("actually, run it now", at="2999-01-01T00:02:00+00:00")
        self.assertIn("the user answered A1", self.run_cli("event", "x").stderr)

    def test_unhold_takes_the_hold_back(self):
        self.ok("decision", *ACTION)
        self.assertIn("is not held", self.refused("decision", "a1", "--unhold"))
        self.hold()
        self.ok("decision", "a1", "--unhold")
        self.assertNotIn("held", self.item("a1"))
        self.assertEqual(self.state()["events"][-1]["text"], "Run the role cut no longer held by the fleet")

    def test_a_revision_that_re_presents_it_clears_the_hold(self):
        self.ok("decision", *ACTION)
        self.hold()
        self.ok("decision", "a1", "--why", "it still feeds the next milestone")
        self.assertEqual(self.item("a1")["held"], "fix the role cut first", "a revision of the why alone does not re-present it")
        self.ok("decision", "a1", "--manual", "just cut --roles --fixed", "--log", "the new command")
        self.assertNotIn("held", self.item("a1"))
        self.assertNotIn("held_at", self.item("a1"))
        self.assertEqual((self.state()["events"][-1]["kind"], self.item("a1")["change"]), ("asked", "the new command"))
        self.hold()
        self.ok("decision", "a1", "--question", "Run the fixed role cut?")
        self.assertNotIn("held", self.item("a1"))

    def test_closing_clears_the_hold_and_a_closed_item_refuses_one(self):
        self.ok("decision", *ACTION)
        self.hold()
        self.ok("decision", "a1", "--decide", "ran it", "--resolution", "said in the session")
        self.assertNotIn("held", self.item("a1"))
        self.assertIn("is already decided", self.refused("decision", "a1", "--hold", "again"))
        self.assertIn("is already decided", self.refused("decision", "a1", "--unhold"))
        self.ok("decision", *SCHEMA)
        self.ok("decision", "d1", "--hold", "x")
        self.ok("decision", "d1", "--withdraw", "moot")
        self.assertNotIn("held", self.item("d1"))

    def test_a_hold_names_an_open_item_and_a_reason(self):
        self.assertIn("unknown decision 'a9'", self.refused("decision", "a9", "--hold", "x"))
        self.ok("decision", *ACTION)
        self.assertIn("--hold says what the fleet does first", self.refused("decision", "a1", "--hold", " "))
        self.assertEqual(self.run_cli("decision", "a1", "--hold", "x", "--withdraw", "y").returncode, 2)

    def test_a_new_grilling_round_clears_the_hold(self):
        self.ok("grill", "g1", "--title", "Rules", "--ask", "t | q | r | w")
        self.ok("decision", "g1", "--hold", "reading the code first")
        self.assertEqual(self.item("g1")["held"], "reading the code first")
        self.ok("grill", "g1", "--ask", "t2 | q2 | r2 | w2")
        self.assertNotIn("held", self.item("g1"))

    def test_a_ledger_held_without_its_stamp_or_closed_and_held_is_refused(self):
        self.ok("decision", *ACTION)
        good = (self.root / "state.json").read_text()
        stamped = {"held": "x", "held_at": "2026-01-01T00:00:00+00:00", "status": "withdrawn"}
        for change, word in [({"held": "x"}, "held without"), (stamped, "still held")]:
            state = json.loads(good)
            state["decisions"][0].update(change)
            (self.root / "state.json").write_text(json.dumps(state))
            self.assertIn(word, self.refused("set", "--now", "x"))


class FailedTest(Fleet):
    """The user ran an action's commands and they failed: the page posts "Failed: <what happened>". The step is
    not done: the fleet fixes it and re-presents it, or withdraws it; it is never recorded as decided."""

    FAILED = "Failed: just: recipe `cut` not found\nerror: Justfile does not contain recipe `cut`."
    NAG = "state: the user ran A1 (Run the role cut) and it failed, #1 at 00:00: just: recipe `cut` not found. It is not done: "

    def say(self, *lines: dict) -> None:
        rows = [{"to": ["coordinator"] if m["from"] == "user" else ["user"], "re": None, **m} for m in lines]
        (self.root / "chat.jsonl").write_text("".join(json.dumps(m) + "\n" for m in rows))

    def failed(self, **change) -> dict:
        return {"id": 1, "at": "2999-01-01T00:00:00+00:00", "from": "user", "text": self.FAILED, "decision": "a1", **change}

    def later(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, STATE, str(self.root), *args, "--no-render"], capture_output=True, text=True, timeout=20,
                              env={**os.environ, "FLEET_NOW": "2999-01-01T00:05:00+00:00"})

    def show(self) -> str:
        return subprocess.run([sys.executable, STATE, str(self.root), "show"], capture_output=True, text=True).stdout

    def test_every_command_says_it_failed_and_how_to_go_on_never_to_decide_it(self):
        self.ok("decision", *ACTION)
        self.say(self.failed())
        warned = self.run_cli("event", "x").stderr
        self.assertIn(self.NAG, warned)
        self.assertIn('decision A1 --manual "..." --log "what changed"', warned)
        self.assertIn('--withdraw "why"', warned)
        self.assertIn("never --decide it", warned)
        self.assertNotIn("the user answered A1", warned)

    def test_show_names_it_failed_with_the_users_first_words(self):
        self.ok("decision", *ACTION)
        self.say(self.failed())
        self.assertIn("  A1 decision a1 OPEN, failed for the user (#1: just: recipe `cut` not found) [action] Run the role cut\n", self.show())

    def test_decide_is_refused_while_it_stands_failed_and_withdraw_closes_it(self):
        self.ok("decision", *ACTION)
        self.say(self.failed())
        said = self.refused("decision", "A1", "--decide", "ran it", "--resolution", "answered on the page (#1)")
        self.assertIn("Run the role cut failed for the user (#1: just: recipe `cut` not found) and is not done", said)
        self.assertIn('--withdraw "why"', said)
        self.assertEqual(self.item("a1")["status"], "open")
        self.ok("decision", "A1", "--withdraw", "the role cut moved to CI")
        self.assertEqual(self.item("a1")["status"], "withdrawn")
        self.assertNotIn("and it failed", self.run_cli("event", "y").stderr)

    def test_a_reply_does_not_settle_it_a_hold_does_until_the_next_answer(self):
        self.ok("decision", *ACTION)
        self.say(self.failed(), {"id": 2, "at": "2999-01-01T00:00:30+00:00", "from": "coordinator", "text": "looking", "re": 1, "decision": "a1"})
        self.assertIn(self.NAG, self.run_cli("event", "x").stderr)
        self.assertEqual(self.later("decision", "A1", "--hold", "fixing the recipe").returncode, 0)
        self.assertNotIn("and it failed", self.run_cli("event", "y").stderr)
        self.assertIn("OPEN, held by the fleet (fixing the recipe), failed for the user (#1: just: recipe `cut` not found) [action]", self.show())
        self.assertIn("is not done", self.refused("decision", "A1", "--decide", "ran it", "--resolution", "x"))

    def test_a_revision_re_presents_it_and_its_next_answer_is_an_ordinary_one(self):
        self.ok("decision", *ACTION)
        self.say(self.failed())
        self.assertEqual(self.later("decision", "A1", "--manual", "just cut-roles", "--log", "the recipe is cut-roles").returncode, 0)
        self.assertNotIn("and it failed", self.run_cli("event", "x").stderr)
        self.assertIn("  A1 decision a1 OPEN [action] Run the role cut\n", self.show())
        self.say(self.failed(), {"id": 2, "at": "2999-01-01T00:06:00+00:00", "from": "user", "text": "Done.", "decision": "a1"})
        self.assertIn("state: the user answered A1 (Run the role cut) as #2 at 00:06", self.run_cli("event", "y").stderr)
        self.ok("decision", "A1", "--decide", "ran it", "--resolution", "answered on the page (#2)")

    def test_done_after_failed_is_an_ordinary_answer_and_failed_on_another_kind_is_too(self):
        self.ok("decision", *ACTION)
        self.say(self.failed(), {"id": 2, "at": "2999-01-01T00:01:00+00:00", "from": "user", "text": "Done.\nit worked on the second try", "decision": "a1"})
        self.assertIn("the user answered A1", self.run_cli("event", "x").stderr)
        self.ok("decision", *SCHEMA)
        self.say(self.failed(decision="d1", text="Failed: neither"))
        warned = self.run_cli("event", "y").stderr
        self.assertIn("the user answered D1", warned)
        self.assertNotIn("and it failed", warned)


class AnsweredAtTest(Fleet):
    """Only the decision's own state records the user's answer (decided, withdrawn, held, revised, a grilling's
    question answered), never a reply in the chat. TypeScript's `answeredAt` tests (fleet/test/decisions.test.ts)."""

    D115 = {"id": "d115", "ref": "D115", "kind": "decision", "status": "open", "opened": "2026-10-05T09:00:00+00:00", "revised": None}
    # Infra's D115: the user answered (#608), the coordinator replied "Recorded B" (#609, re 608) and never ran --decide.
    CHAT = [{"id": 608, "at": "2026-10-07T14:00:00+00:00", "from": "user", "to": ["coordinator"], "text": "B", "re": None, "decision": "d115"},
            {"id": 609, "at": "2026-10-07T14:01:00+00:00", "from": "coordinator", "to": ["user"], "text": "Recorded B", "re": 608}]

    def test_an_answer_the_coordinator_replied_to_with_no_change_to_the_decision_is_not_recorded(self):
        self.assertEqual(decisions.answered_at(self.D115, self.CHAT), "2026-10-07T14:00:00+00:00")

    def test_revised_held_or_closed_at_or_after_the_answer_it_is_recorded(self):
        for change in ({"revised": "2026-10-07T14:05:00+00:00"}, {"held": "the migration first", "held_at": "2026-10-07T14:00:00+00:00"},
                       {"status": "decided", "closed": "2026-10-07T14:05:00+00:00"}, {"status": "withdrawn"}):
            self.assertIsNone(decisions.answered_at({**self.D115, **change}, self.CHAT), change)

    def test_held_before_the_answer_it_is_not(self):
        held = {**self.D115, "held": "the migration first", "held_at": "2026-10-07T13:00:00+00:00"}
        self.assertEqual(decisions.answered_at(held, self.CHAT), "2026-10-07T14:00:00+00:00")

    def test_a_grilling_records_an_answer_by_answering_or_dropping_a_question_at_or_after_it(self):
        def question(answered, id_="q1"):
            return {"id": id_, "title": "T", "status": "open" if answered is None else "answered", "answered": answered}
        g = {**self.D115, "kind": "grill", "questions": [question(None), question(None, "q2")]}
        self.assertEqual(decisions.answered_at(g, self.CHAT), "2026-10-07T14:00:00+00:00")
        self.assertIsNone(decisions.answered_at({**g, "questions": [question("2026-10-07T14:02:00+00:00"), question(None, "q2")]}, self.CHAT))
        self.assertEqual(decisions.answered_at({**g, "questions": [question("2026-10-07T13:00:00+00:00"), question(None, "q2")]}, self.CHAT),
                         "2026-10-07T14:00:00+00:00")

    def test_a_reply_in_the_chat_does_not_record_it_the_warning_stands_until_the_decision_command_runs(self):
        self.ok("decision", *SCHEMA)
        said = [{"id": 1, "at": "2999-01-01T00:00:00+00:00", "from": "user", "to": ["coordinator"], "text": "B", "re": None, "decision": "d1"},
                {"id": 2, "at": "2999-01-01T00:01:00+00:00", "from": "coordinator", "to": ["user"], "text": "Recorded B", "re": 1}]
        (self.root / "chat.jsonl").write_text("".join(json.dumps(m) + "\n" for m in said))
        self.assertIn("state: the user answered D1 (Invoice schema) as #1 at 00:00; record it before any other work: ", self.run_cli("event", "x").stderr)
        self.ok("decision", "D1", "--decide", "B: keep both", "--resolution", "answered on the page (#1)")
        self.assertNotIn("the user answered", self.run_cli("event", "y").stderr)


class AnswerTest(Fleet):
    def refusal(self, id_: str, text: str):
        return decisions.answer_refusal(self.root, id_, text)

    def test_an_open_item_takes_an_answer(self):
        self.ok("decision", *SCHEMA)
        self.assertIsNone(self.refusal("d1", "B: keep both"))
        self.assertIsNone(self.refusal("d1", "None of these: split the table instead"))

    def test_an_unknown_or_closed_item_refuses_with_the_reason(self):
        self.assertIn("unknown decision", self.refusal("d1", "A"))
        self.ok("decision", *SCHEMA)
        self.ok("decision", "d1", "--withdraw", "the worker found the answer in the migration notes")
        said = self.refusal("d1", "A")
        self.assertIn("withdrawn", said)
        self.assertIn("the worker found the answer in the migration notes", said)

    def test_a_secret_takes_a_reference_or_an_item_name_and_never_a_value(self):
        self.ok("decision", "d1", "--kind", "secret", "--title", "Neo4j password", "--question", "Where is the Neo4j password?", "--why", "w",
                "--secret", "NEO4J_PASSWORD", "--manual", "secretspec set NEO4J_PASSWORD")
        for fine in ["op://Engineering/Neo4j Aura/password", "op://dev/abcdefghijklmnopqrstuvwxyz/section/credential",
                     "Neo4j Aura (prod)", "NEO4J_PASSWORD in the Engineering vault", "Set by hand."]:
            self.assertIsNone(self.refusal("d1", fine), fine)
        for value in ["sk-ant-api03-Zk9xQ2", "ghp_16C7e42F292c6912E7710c838347Ae178B4a", "xoxb-12345-abcdef",
                      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "f3a9c1d27b6e4f0a8d5c2b1e9f7a6d3c", "AKIAIOSFODNN7EXAMPLE",
                      "the password is hunter2hunter2hunter2", "-----BEGIN PRIVATE KEY-----", "x" * 300]:
            self.assertIn("never the value", self.refusal("d1", value), value)

    def test_other_kinds_take_any_text(self):
        self.ok("decision", "d1", "--kind", "input", "--title", "T", "--question", "q", "--why", "w")
        self.assertIsNone(self.refusal("d1", "commit f3a9c1d27b6e4f0a8d5c2b1e9f7a6d3c is the one"))


if __name__ == "__main__":
    unittest.main()
