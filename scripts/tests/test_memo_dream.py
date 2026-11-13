"""Tests for scripts/memo-dream, the note drafter and its judge, against synthetic transcripts and a fake `claude`.

Run: python3 -m unittest scripts/tests/test_memo_dream.py

No real transcript is read and no model is called: every fixture, every lesson and every "secret" is invented
here, and `claude` on PATH is a stand-in that logs its call and answers from FAKE_CLAUDE_ANSWER_<MODEL>, else
FAKE_CLAUDE_ANSWER. Notes are written to throwaway repos only.
"""

import contextlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "scripts" / "memo-dream"
MEMO = ROOT / "scripts" / "memo"
T0 = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)
DAY = timedelta(days=1)

sys.dont_write_bytecode = True
_loader = SourceFileLoader("memo_dream_under_test", str(SCRIPT))
dream = module_from_spec(spec_from_loader("memo_dream_under_test", _loader))
_loader.exec_module(dream)

FAKE_CLAUDE = r"""#!{python}
# A stand-in for `claude -p`: logs each call and answers with its model's answer file. No model is called.
import json, os, sys
stdin = sys.stdin.read()
model = sys.argv[sys.argv.index("--model") + 1]
with open(os.environ["FAKE_CLAUDE_LOG"], "a") as f:
    f.write(json.dumps({{"args": sys.argv[1:], "role": os.environ.get("TSTACK_ROLE"), "stdin": stdin,
                        "cwd": os.getcwd(), "model": model}}) + "\n")
path = os.environ.get("FAKE_CLAUDE_ANSWER_" + model.upper()) or os.environ["FAKE_CLAUDE_ANSWER"]
answer = open(path).read()
fail = answer.startswith("FAIL")
print(json.dumps({{"type": "result", "is_error": fail, "result": answer, "total_cost_usd": 0.01, "duration_ms": 9,
                  "modelUsage": {{f"claude-{{model}}-5": {{}}}}, "usage": {{"input_tokens": 40, "output_tokens": 20}}}}))
sys.exit(1 if fail else 0)
"""

FAKE_MEMO = r"""#!{python}
# A stand-in for scripts/memo: logs `memo note` and answers like it, or refuses when FAKE_MEMO_REFUSE is set.
import json, os, sys
with open(os.environ["FAKE_MEMO_LOG"], "a") as f:
    f.write(json.dumps({{"args": sys.argv[1:], "cwd": os.getcwd(), "role": os.environ.get("TSTACK_ROLE"),
                        "quiet": os.environ.get("MEMO_QUIET")}}) + "\n")
if os.environ.get("FAKE_MEMO_REFUSE"):
    print("memo: 9 pins and 9 open threads already", file=sys.stderr)
    sys.exit(2)
print("noted 01KA0000000000000000000000 [" + sys.argv[2] + "] project:x")
"""

ORIGIN = "git@github.com:coelhorocha/custom-mcp-servers.git"
LESSON = "the widget cache keys on the tenant id, so a test that shares tenants sees stale rows"
OVER = "x" * 281
FAKE_SECRET = "api_key = " + "Zq" * 10  # matches memo's SECRET_PATTERNS; invented, never a real key


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


class Writer:
    """One synthetic session's records, with uuids and a clock."""

    def __init__(self, session, cwd, t=T0):
        self.session, self.cwd, self.t, self.n = session, str(cwd), t, 0

    def _base(self, kind, minutes=1):
        self.t += timedelta(minutes=minutes)
        self.n += 1
        return {"type": kind, "timestamp": iso(self.t), "sessionId": self.session, "cwd": self.cwd,
                "uuid": f"{self.session}-{self.n:04d}", "isSidechain": False, "entrypoint": "cli"}

    def prompt(self, text):
        r = self._base("user")
        r.update(message={"role": "user", "content": text}, origin={"kind": "human"}, promptSource="typed")
        return r

    def reply(self, text):
        r = self._base("assistant")
        r["message"] = {"role": "assistant", "content": [{"type": "text", "text": text}]}
        return r

    def handback(self, report):
        """A worker's final report as the coordinator's transcript holds it: a meta user record from a peer."""
        r = self._base("user")
        body = "[Subagent hand-back] The report follows:\n" + "\n".join("  " + ln for ln in report.splitlines())
        r.update(isMeta=True, message={"role": "user", "content": f"Another Claude session sent a message:\n{body}"},
                 origin={"kind": "peer", "from": "a1", "body": body, "handback": True, "handbackReportText": report})
        return r


class DreamCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name).resolve()
        self.addCleanup(self._tmp.cleanup)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        fake = self.bin / "claude"
        fake.write_text(FAKE_CLAUDE.format(python=sys.executable))
        fake.chmod(0o755)
        self.calls_log, self.answer_file = self.tmp / "calls.jsonl", self.tmp / "answer.txt"
        self.judge_files = {m: self.tmp / f"judge-{m}.txt" for m in ("fable", "opus")}
        self.env = {
            "HOME": str(self.tmp / "home"),
            "XDG_DATA_HOME": str(self.tmp / "data"),
            "XDG_CONFIG_HOME": str(self.tmp / "config"),
            "XDG_STATE_HOME": str(self.tmp / "state"),
            "CLAUDE_CONFIG_DIR": str(self.tmp / "claude"),
            "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "FAKE_CLAUDE_LOG": str(self.calls_log),
            "FAKE_CLAUDE_ANSWER": str(self.answer_file),
            "FAKE_CLAUDE_ANSWER_FABLE": str(self.judge_files["fable"]),
            "FAKE_CLAUDE_ANSWER_OPUS": str(self.judge_files["opus"]),
        }
        (self.tmp / "config" / "tstack").mkdir(parents=True)
        self.tape_config('projects = "all"')
        self.repo = self.git_repo("custom-mcp-servers", ORIGIN)
        self.writer = Writer("s1", self.repo)
        self.transcript = self.tmp / "claude" / "projects" / "slug" / "s1.jsonl"
        self.states = self.tmp / "state" / "tstack" / "memo-dream" / "coelhorocha__custom-mcp-servers"
        self.turns = 0  # turns written so far: tape numbers them from 0, in order
        self.answer([])
        self.judge("no verdicts here")  # by default the judge settles nothing: the batch stays pending

    def git_repo(self, name, origin):
        path = self.tmp / "repos" / name
        path.mkdir(parents=True)
        subprocess.run(["git", "init", "-q"], cwd=path, check=True)
        subprocess.run(["git", "remote", "add", "origin", origin], cwd=path, check=True)
        return path

    def tape_config(self, *lines):
        (self.tmp / "config" / "tstack" / "tape.toml").write_text("\n".join(lines) + "\n")

    def answer(self, candidates):
        self.answer_file.write_text(candidates if isinstance(candidates, str) else json.dumps(candidates))

    def judge(self, verdicts, opus=None):
        """The judge's answer on Fable, and on Opus (the same unless given)."""
        for model, v in (("fable", verdicts), ("opus", verdicts if opus is None else opus)):
            self.judge_files[model].write_text(v if isinstance(v, str) else json.dumps(v))

    def write(self, *records):
        self.transcript.parent.mkdir(parents=True, exist_ok=True)
        with open(self.transcript, "a") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

    def session(self, *turns):
        """Turns of (prompt, reply[, worker report]); a last prompt closes them for tape."""
        self.turns += len(turns)
        for turn in turns:
            self.write(self.writer.prompt(turn[0]), self.writer.reply(turn[1]),
                       *(self.writer.handback(r) for r in turn[2:]))

    def dream(self, *args, now=None, cwd=None, env=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err):
            code = dream.main(list(args), env={**self.env, **(env or {})}, cwd=str(cwd or self.repo), out=out,
                              now=(now or self.writer.t + 2 * DAY).timestamp())
        return code, out.getvalue() + err.getvalue() if code else out.getvalue()

    def run_dream(self, now=None, **kw):
        code, out = self.dream("run", now=now, **kw)
        self.assertEqual(code, 0, out)
        return out

    def every_call(self):
        return [json.loads(ln) for ln in self.calls_log.read_text().splitlines()] if self.calls_log.exists() else []

    def calls(self):
        """The drafting calls."""
        return [c for c in self.every_call() if c["model"] == "sonnet"]

    def judge_calls(self):
        return [c for c in self.every_call() if c["model"] != "sonnet"]

    def batches(self):
        return sorted((json.loads(p.read_text()) for p in self.states.glob("????-??-??.json")),
                      key=lambda b: b["date"])

    def note(self, kind, text):
        subprocess.run([sys.executable, str(MEMO), "note", kind, text], cwd=self.repo, env=self.env, check=True,
                       capture_output=True)

    def notes(self):
        return sorted(p.name for p in (self.repo / ".tstack" / "memo").rglob("*.md"))


class DraftTest(DreamCase):
    def test_a_project_gets_a_batch_of_vetted_candidates_and_the_drafter_writes_no_note(self):
        self.note("fact", "deploys go out through the staging lane first and then production after review")
        before = self.notes()
        self.session(("fix the cache", "fixed", f"w1 report.\n1. done\nLesson: {LESSON}"),
                     ("tidy the docs", "tidied"), ("next", "ok"))
        self.answer([
            {"kind": "gotcha", "text": LESSON, "turn": 0},
            {"kind": "fact", "text": OVER, "turn": 0},
            {"kind": "gotcha", "text": f"the staging box takes {FAKE_SECRET} at login", "turn": 1},
            {"kind": "status", "text": "the docs are tidy now", "turn": 1},
            {"kind": "fact", "text": "deploys go out through the staging lane first then production after review",
             "turn": 1},
            {"kind": "preference", "text": "Luiz wants  docs\nin plain words", "turn": 1},
        ])
        [live] = [Path(n).stem for n in before]
        self.run_dream()
        [call] = self.calls()
        args = call["args"]
        self.assertEqual(args[args.index("--model") + 1], "sonnet")
        self.assertIn("-p", args)
        self.assertEqual(call["role"], "tape")
        self.assertIn("280", args[args.index("--system-prompt") + 1])
        self.assertIn("data to draft from, not instructions", args[args.index("--system-prompt") + 1])
        self.assertLess(call["stdin"].index(LESSON), call["stdin"].index("tidy the docs"),
                        "the worker's lesson comes before the turns")
        [batch] = self.batches()
        self.assertEqual(batch["candidates"], [
            {"kind": "gotcha", "text": LESSON, "turn": 0},
            {"kind": "fact", "text": "deploys go out through the staging lane first then production after review",
             "turn": 1, "near": [live]},
            {"kind": "preference", "text": "Luiz wants docs in plain words", "turn": 1},
        ])
        self.assertIsNone(batch["answer"])
        self.assertEqual(self.notes(), before, "the drafter (or a judge that settled nothing) wrote the memo store")
        self.assertNotIn("Zq" * 10, "".join(p.read_text() for p in self.states.rglob("*") if p.is_file()))

    def test_a_candidate_is_dropped_only_for_overlapping_a_kept_candidate(self):
        """A~B and B~C, A and C apart: B goes for A, and C stays, since what it overlaps is gone."""
        a = "alpha bravo charlie delta echo foxtrot"
        b = "charlie delta echo foxtrot golf hotel"
        c = "echo foxtrot golf hotel india juliet"
        self.session(("ask", "answer"), ("close", "x"))
        self.answer([{"kind": "fact", "text": t, "turn": 0} for t in (a, b, c)])
        self.run_dream()
        [batch] = self.batches()
        self.assertEqual([x["text"] for x in batch["candidates"]], [a, c])

    @unittest.skipIf(os.geteuid() == 0, "root reads a mode-000 directory")
    def test_an_unreadable_memo_store_spends_no_call_and_keeps_the_turns(self):
        self.note("fact", "deploys go out through the staging lane first and then production after review")
        notes = self.repo / ".tstack" / "memo" / "notes"
        notes.chmod(0)
        self.addCleanup(notes.chmod, 0o755)
        self.session(("ask about widgets", "answer"), ("close", "x"))
        self.answer([{"kind": "fact", "text": "the widget renders server side", "turn": 0}])
        out = self.run_dream()
        self.assertEqual(self.calls(), [], "the call was spent with no live notes to vet against")
        self.assertIn("memo", out)
        notes.chmod(0o755)
        self.run_dream(now=self.writer.t + 3 * DAY)
        [call] = self.calls()
        self.assertIn("ask about widgets", call["stdin"])
        self.assertEqual(len(self.batches()), 1)

    def test_a_run_reads_only_newer_turns_and_never_overwrites_the_days_batch(self):
        self.answer([{"kind": "fact", "text": "the widget renders server side", "turn": 0}])
        self.session(("first ask", "first answer"), ("second ask", "second answer"))
        now = self.writer.t + 2 * DAY
        self.run_dream(now=now)
        self.session(("third ask", "third answer"), ("fourth ask", "x"))
        out = self.run_dream(now=now + timedelta(minutes=5))
        self.assertEqual(len(self.calls()), 1, "a second batch the same day would overwrite the first")
        self.assertIn("exists already", out)
        self.run_dream(now=now + DAY)
        first, second = self.calls()
        self.assertIn("first ask", first["stdin"])
        self.assertNotIn("first ask", second["stdin"])
        self.assertIn("third ask", second["stdin"])

    def test_no_new_turns_makes_no_call(self):
        self.session(("only ask", "only answer"), ("close", "x"))
        self.run_dream()
        self.run_dream(now=self.writer.t + 5 * DAY)
        self.assertEqual(len(self.calls()), 1)

    def test_the_env_list_restricts_the_projects_and_unset_means_every_one(self):
        other = self.git_repo("widget", "git@github.com:acme/widget.git")
        self.writer = Writer("s2", other)
        self.transcript = self.tmp / "claude" / "projects" / "slug" / "s2.jsonl"
        self.session(("ask", "answer"), ("close", "x"))
        self.answer([{"kind": "fact", "text": "the widget renders server side", "turn": 0}])
        for listed in ("", "coelhorocha/custom-mcp-servers"):
            self.assertIn("MEMO_DREAM_PROJECTS", self.run_dream(cwd=other, env={"MEMO_DREAM_PROJECTS": listed}))
        self.assertEqual(self.calls(), [])
        self.run_dream(cwd=other, env={"MEMO_DREAM_PROJECTS": "Acme/Widget, coelhorocha/custom-mcp-servers"})
        self.assertEqual(len(self.calls()), 1)
        self.assertTrue((self.tmp / "state" / "tstack" / "memo-dream" / "acme__widget").is_dir())
        self.session(("more", "x"), ("close", "x"))
        self.run_dream(cwd=other, now=self.writer.t + 3 * DAY)
        self.assertEqual(len(self.calls()), 2, "unset, the list is every project tape allows")

    def test_the_drafter_sees_the_live_notes_with_their_ids_as_data(self):
        self.note("fact", "deploys go out through the staging lane first and then production after review")
        [name] = self.notes()
        self.session(("ask", "answer"), ("close", "x"))
        self.run_dream()
        [call] = self.calls()
        notes = call["stdin"][call["stdin"].index("<notes>"):call["stdin"].index("</notes>")]
        self.assertIn(f"{Path(name).stem} [fact] deploys go out through the staging lane", notes)
        self.assertLess(call["stdin"].index("</notes>"), call["stdin"].index("<turns>"))
        prompt = call["args"][call["args"].index("--system-prompt") + 1]
        self.assertIn("<notes>", prompt)
        self.assertIn("already says", prompt)

    def test_the_input_is_bounded(self):
        self.session(*((f"ask {k} " + "lorem " * 2000, "answer " * 2000) for k in range(60)), ("close", "x"))
        self.run_dream()
        [call] = self.calls()
        self.assertLessEqual(len(call["stdin"].encode()), dream.INPUT_MAX + 1024)
        self.assertIn("ask 59", call["stdin"], "the newest turns are the ones kept")

    def test_a_failed_call_keeps_the_turns_for_the_next_day(self):
        self.session(("ask", "answer"), ("close", "x"))
        self.answer("FAIL overloaded")
        self.run_dream()
        self.assertEqual(self.batches(), [])
        self.answer([{"kind": "fact", "text": "the widget renders server side", "turn": 0}])
        self.run_dream(now=self.writer.t + 3 * DAY)
        self.assertIn("ask", self.calls()[1]["stdin"])
        self.assertEqual(len(self.batches()), 1)


class CapTest(DreamCase):
    def db(self):
        return sqlite3.connect(self.tmp / "data" / "tstack" / "tape" / "coelhorocha__custom-mcp-servers" / "tape.db")

    def test_the_call_is_a_row_in_tapes_ledger(self):
        self.session(("ask", "answer"), ("close", "x"))
        self.run_dream()
        rows = self.db().execute("select kind, ok, model from calls where kind = 'dream'").fetchall()
        self.assertEqual(rows, [("dream", 1, "claude-sonnet-5")])

    def test_a_failed_calls_error_text_stays_out_of_the_ledger_the_output_and_the_batches(self):
        """The model's error may quote a turn; only the mapped code is written anywhere."""
        marker = "the vault phrase is periwinkle-octopus"
        for k, (answer, code) in enumerate(((f"FAIL overloaded: {marker}", "call failed"),
                                            (f"FAIL you hit your usage limit: {marker}", "usage limit"))):
            with self.subTest(code=code):
                self.session(("ask", "answer"), ("close", "x"))
                self.answer(answer)
                code_, out = self.dream("run", now=self.writer.t + (2 + 2 * k) * DAY)
                self.assertEqual(code_, 0, out)
                self.assertEqual(len(self.calls()), k + 1)
                self.assertNotIn("periwinkle", out)
                errors = [e for (e,) in self.db().execute("select error from calls where kind = 'dream'")]
                self.assertEqual(errors[-1], code)
                self.assertFalse(any("periwinkle" in str(e) for e in errors), errors)
                written = "".join(p.read_text() for p in self.states.rglob("*") if p.is_file())
                self.assertNotIn("periwinkle", written)

    def test_no_call_once_tapes_daily_cap_is_spent(self):
        self.tape_config('projects = "all"', "max_calls_per_day = 1")
        self.session(("ask", "answer"), ("close", "x"))
        self.run_dream()
        self.session(("more", "x"), ("close", "x"))
        now = self.writer.t + 3 * DAY
        con = self.db()
        con.execute("insert into calls (day, kind, ok) values (?, 'leaf', 1)", (dream.tape.today(now.timestamp()),))
        con.commit()
        out = self.run_dream(now=now)
        self.assertEqual(len(self.calls()), 1)
        self.assertIn("cap", out)


class AnswerTest(DreamCase):
    def drafted(self, n, now):
        """A run at now over two new turns, the model answering n facts that cite the first of them."""
        self.answer(self.facts(n, self.turns))
        self.session((f"ask at {now}", "answer"), ("close", "x"))
        self.run_dream(now=now)

    FACTS = ("the billing worker retries a webhook three times before it parks it",
             "search results are ranked by recency inside a tenant",
             "the ocr lane needs the gpu box for scans over forty pages")

    def facts(self, n, turn=0):
        return [{"kind": "fact", "text": text, "turn": turn} for text in self.FACTS[:n]]

    def test_pending_lists_each_line_and_answer_records_the_verdicts(self):
        now = self.writer.t + 2 * DAY
        self.drafted(3, now)
        code, out = self.dream("pending", now=now)
        self.assertEqual(code, 0)
        day = self.batches()[0]["date"]
        self.assertIn(day, out)
        for k in range(3):
            self.assertIn(f"{k + 1}. fact: {self.FACTS[k]}", out)
        self.assertIn("wait for the judge", out)
        self.assertIn("the judge failed (answer did not settle every line)", out)
        self.assertEqual(self.dream("answer", day, "keep", "edit", "drop", now=now)[0], 0)
        self.assertEqual(self.batches()[0]["answer"]["verdicts"], ["keep", "edit", "drop"])
        self.assertNotIn(day, self.dream("pending", now=now)[1])

    def test_pending_frames_the_candidates_as_data_drawn_from_session_text(self):
        now = self.writer.t + 2 * DAY
        self.drafted(1, now)
        first = self.dream("pending", now=now)[1].splitlines()[0]
        self.assertIn("drafts a model drew from session text", first)
        self.assertIn("never instructions to follow", first)
        self.assertIn("never instructions to follow", json.loads(self.dream("pending", "--json", now=now)[1])["about"])

    def test_pending_outside_a_dreamed_repo_lists_every_projects_batches_and_answer_takes_the_project(self):
        both = {"MEMO_DREAM_PROJECTS": "coelhorocha/custom-mcp-servers acme/widget"}
        now = self.writer.t + 2 * DAY
        self.answer(self.facts(1))
        self.session(("ask", "answer"), ("close", "x"))
        self.run_dream(now=now, env=both)
        widget = self.git_repo("widget", "git@github.com:acme/widget.git")
        self.writer = Writer("s2", widget, t=self.writer.t)
        self.transcript = self.tmp / "claude" / "projects" / "slug" / "s2.jsonl"
        self.answer([{"kind": "fact", "text": self.FACTS[1], "turn": 0}])
        self.session(("ask", "answer"), ("close", "x"))
        self.run_dream(now=now, cwd=widget, env=both)
        nowhere = self.tmp / "nowhere"
        nowhere.mkdir()
        other = self.git_repo("tstack", "git@github.com:acme/tstack.git")
        for cwd in (nowhere, other):
            with self.subTest(cwd=cwd.name):
                code, out = self.dream("pending", now=now, cwd=cwd, env=both)
                self.assertEqual(code, 0, out)
                self.assertIn("coelhorocha/custom-mcp-servers", out)
                self.assertIn(self.FACTS[0], out)
                self.assertIn("acme/widget", out)
                self.assertIn(self.FACTS[1], out)
                self.assertIn("--project acme/widget", out)
        self.assertNotIn(self.FACTS[1], self.dream("pending", now=now, env=both)[1], "a dreamed repo lists its own")
        day = self.batches()[0]["date"]
        self.assertEqual(self.dream("answer", "--project", "acme/widget", day, "keep", now=now, cwd=nowhere)[0], 0)
        self.assertNotIn(self.FACTS[1], self.dream("pending", now=now, cwd=nowhere, env=both)[1])
        self.assertIn(self.FACTS[0], self.dream("pending", now=now, cwd=nowhere, env=both)[1])

    def test_answer_refuses_a_wrong_count_or_an_unknown_verdict(self):
        now = self.writer.t + 2 * DAY
        self.drafted(2, now)
        day = self.batches()[0]["date"]
        self.assertNotEqual(self.dream("answer", day, "keep", now=now)[0], 0)
        self.assertNotEqual(self.dream("answer", day, "keep", "maybe", now=now)[0], 0)
        self.assertNotEqual(self.dream("answer", "2020-01-01", "keep", now=now)[0], 0)
        self.assertIsNone(self.batches()[0]["answer"])

    def test_pending_json_is_for_scripts(self):
        now = self.writer.t + 2 * DAY
        self.drafted(1, now)
        code, out = self.dream("pending", "--json", now=now)
        [project] = json.loads(out)["projects"]
        self.assertEqual(project["project"], "coelhorocha/custom-mcp-servers")
        [batch] = project["pending"]
        self.assertEqual(batch["candidates"][0]["text"], self.facts(1)[0]["text"])

    def test_a_batch_the_judge_failed_on_for_seven_days_stops_drafting(self):
        now = self.writer.t + 2 * DAY
        self.drafted(1, now)
        self.drafted(1, now + 6 * DAY)
        self.assertEqual(len(self.calls()), 2)
        later = now + 7 * DAY
        self.session(("ask", "x"), ("close", "x"))
        out = self.run_dream(now=later)
        self.assertEqual(len(self.calls()), 2)
        self.assertIn("7 days", out)
        self.assertIn("answer did not settle every line", out)
        self.dream("answer", self.batches()[0]["date"], "drop", now=later)
        self.run_dream(now=later + DAY)
        self.assertEqual(len(self.calls()), 3)

    def test_a_keep_rate_under_a_third_over_two_weeks_suggests_switching_off(self):
        now = self.writer.t + 2 * DAY
        self.drafted(3, now)
        self.dream("answer", self.batches()[0]["date"], "keep", "drop", "drop", now=now)
        self.assertNotIn("switch", self.dream("pending", now=now)[1], "1 of 3 is a third, not under it")
        self.drafted(1, now + DAY)
        self.dream("answer", self.batches()[1]["date"], "drop", now=now + DAY)
        out = self.dream("pending", now=now + DAY)[1]
        self.assertIn("1 of 4", out)
        self.assertIn("switch", out)
        self.assertNotIn("switch", self.dream("pending", now=now + 16 * DAY)[1], "the window is two weeks")


class VerdictParseTest(unittest.TestCase):
    """parse_verdicts: the judge's answer, one record per candidate or None."""

    CANDS = [{"kind": "fact", "text": "the billing worker retries a webhook three times", "turn": 0},
             {"kind": "gotcha", "text": "the ocr lane needs the gpu box for long scans", "turn": 1}]

    def parse(self, answer):
        return dream.parse_verdicts(answer if isinstance(answer, str) else json.dumps(answer), self.CANDS)

    def test_a_full_answer_gives_one_record_per_line_and_keep_takes_the_candidates_own_text(self):
        recs = self.parse("Here you go:\n" + json.dumps([
            {"line": 2, "verdict": "edit", "kind": "fact", "text": "the ocr lane needs  the gpu box for scans over "
             "forty pages", "reason": "checked\nocr/lane.py"},
            {"line": 1, "verdict": "keep", "kind": "fact", "text": "something else entirely", "reason": "true"}]))
        self.assertEqual(recs, [
            {"verdict": "keep", "kind": "fact", "text": self.CANDS[0]["text"], "reason": "true", "by": "judge"},
            {"verdict": "edit", "kind": "fact", "text": "the ocr lane needs the gpu box for scans over forty pages",
             "reason": "checked ocr/lane.py", "by": "judge"}])

    def test_an_answer_that_misses_doubles_or_misnames_a_line_settles_nothing(self):
        keep = {"verdict": "keep", "reason": "r"}
        for answer in ([{"line": 1, **keep}],
                       [{"line": 1, **keep}, {"line": 1, **keep}, {"line": 2, **keep}],
                       [{"line": 1, **keep}, {"line": 3, **keep}],
                       [{"line": 1, **keep}, {"line": 2, "verdict": "maybe"}],
                       [{"line": True, **keep}, {"line": 2, **keep}],
                       "not json", []):
            with self.subTest(answer=answer):
                self.assertIsNone(self.parse(answer))

    def test_an_edit_that_fails_memos_check_is_a_drop_and_one_that_changes_nothing_is_a_keep(self):
        recs = self.parse([{"line": 1, "verdict": "edit", "text": OVER, "reason": "shorter"},
                           {"line": 2, "verdict": "edit", "text": f"login takes {FAKE_SECRET}", "reason": "r"}])
        self.assertEqual([r["verdict"] for r in recs], ["drop", "drop"])
        self.assertIn("280", recs[0]["reason"])
        self.assertNotIn("Zq" * 10, json.dumps(recs))
        same = self.parse([{"line": 1, "verdict": "edit", "text": self.CANDS[0]["text"], "kind": "fact"},
                           {"line": 2, "verdict": "drop", "reason": "stale: ocr/lane.py has no gpu check"}])
        self.assertEqual([r["verdict"] for r in same], ["keep", "drop"])
        self.assertNotIn("text", same[1])

    def test_a_reason_that_looks_like_a_secret_is_withheld_and_a_long_one_is_clipped(self):
        recs = self.parse([{"line": 1, "verdict": "drop", "reason": f"the .env holds {FAKE_SECRET}"},
                           {"line": 2, "verdict": "drop", "reason": "y" * 900}])
        self.assertNotIn("Zq" * 10, recs[0]["reason"])
        self.assertLessEqual(len(recs[1]["reason"]), dream.REASON_MAX)


    TARGET = "01KA" + "0" * 21 + "7"

    def test_supersede_names_a_live_note_of_the_input_and_writes_the_corrected_line_or_the_candidates(self):
        recs = dream.parse_verdicts(json.dumps([
            {"line": 1, "verdict": "supersede", "target": self.TARGET.lower(), "kind": "fact",
             "text": "the billing worker retries a webhook  three times", "reason": "billing.py retries 3"},
            {"line": 2, "verdict": "supersede", "target": "01KA" + "0" * 21 + "8", "reason": "the note is old"}]),
            self.CANDS, {self.TARGET, "01KA" + "0" * 21 + "8"})
        self.assertEqual(recs, [
            {"verdict": "supersede", "target": self.TARGET, "kind": "fact",
             "text": "the billing worker retries a webhook three times", "reason": "billing.py retries 3",
             "by": "judge"},
            {"verdict": "supersede", "target": "01KA" + "0" * 21 + "8", "kind": "gotcha", "text": self.CANDS[1]["text"],
             "reason": "the note is old", "by": "judge"}])

    def test_a_supersede_of_a_note_not_in_the_input_twice_or_with_a_bad_line_is_a_drop(self):
        sup = {"verdict": "supersede", "kind": "fact", "reason": "r"}
        for answer, targets in (
                ([{"line": 1, **sup, "target": "01KA" + "9" * 22}, {"line": 2, **sup, "target": self.TARGET}], set()),
                ([{"line": 1, **sup}, {"line": 2, **sup, "target": 7}], {self.TARGET}),
                ([{"line": 1, **sup, "target": self.TARGET, "text": OVER}, {"line": 2, "verdict": "drop"}],
                 {self.TARGET})):
            with self.subTest(answer=answer):
                recs = dream.parse_verdicts(json.dumps(answer), self.CANDS, targets)
                self.assertEqual([r["verdict"] for r in recs], ["drop", "drop"])
                self.assertNotIn("target", recs[0])
        twice = dream.parse_verdicts(json.dumps([{"line": 1, **sup, "target": self.TARGET},
                                                 {"line": 2, **sup, "target": self.TARGET}]), self.CANDS, {self.TARGET})
        self.assertEqual([r["verdict"] for r in twice], ["supersede", "drop"])
        self.assertIn("line 1", twice[1]["reason"])

    def test_supersede_is_the_judges_alone(self):
        self.assertNotIn("supersede", dream.VERDICTS, "a manual `answer` writes no note, so it cannot supersede")


class JudgeTest(DreamCase):
    FACTS = AnswerTest.FACTS
    EDITED = "search results are ranked by recency inside a tenant, then by score"

    def drafted(self, n=3, now=None):
        self.answer([{"kind": "fact", "text": t, "turn": self.turns} for t in self.FACTS[:n]])
        self.session(("ask", "answer"), ("close", "x"))
        return self.run_dream(now=now)

    def verdicts(self, *vs):
        out = []
        for k, v in enumerate(vs, 1):
            r = {"line": k, "verdict": v, "kind": "fact", "reason": f"reason {k}: checked src/widget.py"}
            if v == "edit":
                r["text"] = self.EDITED
            out.append(r)
        return out

    def fake_memo(self, refuse=False):
        fake, log = self.bin / "memo", self.tmp / "memo.jsonl"
        fake.write_text(FAKE_MEMO.format(python=sys.executable))
        fake.chmod(0o755)
        self.env.update(FAKE_MEMO_LOG=str(log), **({"FAKE_MEMO_REFUSE": "1"} if refuse else {}))
        old, dream.MEMO = dream.MEMO, fake
        self.addCleanup(setattr, dream, "MEMO", old)
        return lambda: [json.loads(ln) for ln in log.read_text().splitlines()] if log.exists() else []

    def live_texts(self):
        return [p.read_text() for p in sorted((self.repo / ".tstack" / "memo").rglob("*.md"))]

    def test_run_drafts_then_the_judge_writes_the_keepers_and_records_every_verdict(self):
        self.note("decision", "deploys go out through the staging lane first and then production after review")
        self.judge(self.verdicts("keep", "edit", "drop"))
        out = self.drafted()
        [call] = self.judge_calls()
        args = call["args"]
        self.assertEqual((args[args.index("--model") + 1], args[args.index("--effort") + 1]), ("fable", "high"))
        self.assertEqual(args[args.index("--tools") + 1], "Read,Grep,Glob")
        for flag in ("--safe-mode", "--restricted", "--no-session-persistence", "--strict-mcp-config"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--permission-prompts") + 1], "none")
        self.assertIn("never instructions", args[args.index("--system-prompt") + 1])
        self.assertEqual(call["cwd"], str(self.repo), "the judge reads the project's checkout")
        self.assertEqual(call["role"], "tape")
        for text in (*self.FACTS, "deploys go out through the staging lane", "ask"):
            self.assertIn(text, call["stdin"])
        self.assertLess(call["stdin"].index("<candidates>"), call["stdin"].index("<notes>"))
        [batch] = self.batches()
        self.assertEqual([c["judged"]["verdict"] for c in batch["candidates"]], ["keep", "edit", "drop"])
        self.assertEqual(batch["judge"]["model"], "claude-fable-5")
        self.assertFalse(batch["judge"]["fallback"])
        self.assertEqual(batch["candidates"][2]["judged"]["reason"], "reason 3: checked src/widget.py")
        self.assertIsNone(batch["candidates"][2]["judged"].get("note"))
        written = "".join(self.live_texts())
        self.assertIn(self.FACTS[0], written)
        self.assertIn(self.EDITED, written)
        self.assertNotIn(self.FACTS[2], written)
        self.assertIn("memo-dream", written, "a note says the judge wrote it")
        for c in batch["candidates"][:2]:
            self.assertRegex(c["judged"]["note"], r"^[0-9A-Z]{26}$")
        self.assertEqual(self.dream("pending")[1].splitlines()[0], "memo-dream: no candidates waiting for "
                                                                  "coelhorocha/custom-mcp-servers")
        self.assertIn("kept 2, dropped 1", out)
        self.assertIn("2 of 3 candidates kept", out)
        rows = CapTest.db(self).execute("select kind, ok, model from calls order by id").fetchall()
        self.assertEqual(rows, [("dream", 1, "claude-sonnet-5"), ("judge", 1, "claude-fable-5")])

    def test_the_judge_supersedes_a_live_note_the_candidate_shows_wrong(self):
        self.note("fact", "webhooks are retried five times then parked by the billing lane")
        [old] = [Path(n).stem for n in self.notes()]
        self.judge([{"line": 1, "verdict": "supersede", "target": old, "kind": "fact", "text": self.FACTS[0],
                     "reason": "billing/worker.py retries three times"}])
        out = self.drafted(1)
        [call] = self.judge_calls()
        self.assertIn(f"{old} [fact] webhooks are retried five times", call["stdin"])
        self.assertIn("supersede", call["args"][call["args"].index("--system-prompt") + 1])
        [batch] = self.batches()
        rec = batch["candidates"][0]["judged"]
        self.assertEqual((rec["verdict"], rec["target"]), ("supersede", old))
        self.assertRegex(rec["note"], r"^[0-9A-Z]{26}$")
        [new] = [t for t in self.live_texts() if self.FACTS[0] in t]
        self.assertIn(old, new, "the new note records the one it supersedes")
        self.assertIn("kept 1 (1 superseding a live note), dropped 0", out)
        log = self.dream("log")[1]
        self.assertIn(f"supersede [fact] {self.FACTS[0]} (note {rec['note']} superseding {old}", log)
        self.assertIn("1 of 1 candidates kept", log)

    def test_a_correction_worded_like_a_live_note_reaches_the_judge_flagged_and_supersedes_it(self):
        self.note("fact", "the billing worker retries a webhook five times before it parks it")
        [old] = [Path(n).stem for n in self.notes()]
        self.judge([{"line": 1, "verdict": "supersede", "target": old, "kind": "fact", "text": self.FACTS[0],
                     "reason": "billing/worker.py retries three times"}])
        self.drafted(1)
        [batch] = self.batches()
        self.assertEqual(batch["candidates"][0]["near"], [old])
        [call] = self.judge_calls()
        self.assertIn(f"1. [fact] {self.FACTS[0]} (from turn 0; near live note {old})", call["stdin"])
        self.assertIn("near live note", call["args"][call["args"].index("--system-prompt") + 1])
        rec = batch["candidates"][0]["judged"]
        self.assertEqual((rec["verdict"], rec["target"]), ("supersede", old))
        [new] = [t for t in self.live_texts() if self.FACTS[0] in t]
        self.assertIn(old, new)

    def test_supersede_runs_memo_supersede_in_the_checkout(self):
        memo_calls = self.fake_memo()
        target = "01KA" + "0" * 21 + "7"
        live = [dream.memo.Item(target, "fact", "webhooks are retried five times", scope="project:x")]
        self.judge([{"line": 1, "verdict": "supersede", "target": target, "kind": "decision", "text": self.EDITED,
                     "reason": "r"}])
        with mock.patch.object(dream, "live_notes", return_value=live):
            self.drafted(1)
        [call] = memo_calls()
        self.assertEqual(call["args"], ["supersede", "--kind", "decision", target, self.EDITED])
        self.assertEqual((call["cwd"], call["role"]), (str(self.repo), "memo-dream"))

    def test_a_global_note_is_shown_but_never_a_target(self):
        target = "01KA" + "0" * 21 + "7"
        live = [dream.memo.Item(target, "preference", "Luiz wants plain words", scope="global")]
        self.judge([{"line": 1, "verdict": "supersede", "target": target, "kind": "fact", "reason": "r"}])
        with mock.patch.object(dream, "live_notes", return_value=live):
            self.drafted(1)
        self.assertIn(f"{target} [preference] (global) Luiz wants plain words", self.judge_calls()[0]["stdin"])
        self.assertEqual(self.batches()[0]["candidates"][0]["judged"]["verdict"], "drop")
        self.assertEqual(self.notes(), [])

    def test_drop_writes_nothing_and_keep_runs_memo_note_in_the_checkout(self):
        memo_calls = self.fake_memo()
        self.judge(self.verdicts("drop", "drop"))
        self.drafted(2)
        self.assertEqual(memo_calls(), [])
        self.judge(self.verdicts("keep"))
        self.drafted(1, now=self.writer.t + 3 * DAY)
        [call] = memo_calls()
        self.assertEqual(call["args"], ["note", "fact", self.FACTS[0]])
        self.assertEqual(call["cwd"], str(self.repo))
        self.assertEqual((call["role"], call["quiet"]), ("memo-dream", "1"))
        self.assertEqual(self.batches()[1]["candidates"][0]["judged"]["note"], "01KA0000000000000000000000")

    def test_a_note_memo_refuses_is_settled_and_logged_as_not_written(self):
        self.fake_memo(refuse=True)
        self.judge(self.verdicts("keep"))
        self.drafted(1)
        [batch] = self.batches()
        rec = batch["candidates"][0]["judged"]
        self.assertIsNone(rec["note"])
        self.assertIn("open threads", rec["error"])
        self.assertIn("not written", self.dream("log")[1])

    def test_a_run_that_dies_while_writing_keepers_is_finished_by_the_next_without_a_new_verdict(self):
        """The verdicts are saved before any note is written: a retry writes what is missing from them, and memo
        answers a line it already holds with that note's id, so nothing is written twice."""
        class Died(Exception):
            pass

        real = dream.write_note

        def dies_after_the_second(env, repo, kind, text, target=None):
            noted = real(env, repo, kind, text, target)
            if text == self.EDITED:
                raise Died
            return noted

        self.judge(self.verdicts("keep", "edit", "keep"))
        with mock.patch.object(dream, "write_note", dies_after_the_second), self.assertRaises(Died):
            self.drafted()
        [batch] = self.batches()
        self.assertEqual([c["judged"]["verdict"] for c in batch["candidates"]], ["keep", "edit", "keep"])
        self.assertRegex(batch["candidates"][0]["judged"]["note"], r"^[0-9A-Z]{26}$")
        self.assertIsNone(batch["candidates"][1]["judged"].get("note"))
        self.assertFalse(dream.settled(batch))
        self.assertEqual(len(self.notes()), 2)
        self.judge(self.verdicts("drop", "drop", "drop"))
        code, out = self.dream("judge")
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.judge_calls()), 1, "the saved verdicts are not asked for again")
        [batch] = self.batches()
        self.assertTrue(dream.settled(batch))
        self.assertEqual([c["judged"]["verdict"] for c in batch["candidates"]], ["keep", "edit", "keep"])
        self.assertEqual(len(self.notes()), 3, "the edited line, written before the crash, is not written again")
        written = "".join(self.live_texts())
        self.assertEqual(written.count(self.EDITED), 1)
        self.assertIn(self.FACTS[2], written)
        self.assertIn("kept 3, dropped 0", out)

    def test_answer_refuses_while_a_run_holds_the_projects_lock(self):
        self.drafted(1)
        day = self.batches()[0]["date"]
        lock = dream.Batches(self.env, "coelhorocha/custom-mcp-servers").lock()
        self.addCleanup(lock.close)
        code, out = self.dream("answer", day, "keep")
        self.assertNotEqual(code, 0)
        self.assertIn("another run", out)
        self.assertIsNone(self.batches()[0]["answer"])
        lock.close()
        self.assertEqual(self.dream("answer", day, "keep")[0], 0)

    def test_an_answer_saved_during_the_judges_call_is_kept(self):
        """The judge re-reads the batch before it saves, so a verdict given meanwhile is not overwritten."""
        self.drafted(2)
        [batch] = self.batches()
        real = dream.tape.call_claude

        def answered_meanwhile(*args, **kw):
            dream.Batches(self.env, batch["project"]).save({**batch, "answer": {"at": 0, "verdicts": ["drop"] * 2}})
            return real(*args, **kw)

        self.judge(self.verdicts("keep", "keep"))
        with mock.patch.object(dream.tape, "call_claude", answered_meanwhile):
            code, out = self.dream("judge")
        self.assertEqual(code, 0, out)
        [batch] = self.batches()
        self.assertEqual(batch["answer"]["verdicts"], ["drop", "drop"])
        self.assertNotIn("judged", batch["candidates"][0])
        self.assertEqual(self.notes(), [])

    def test_a_model_error_on_fable_falls_back_to_opus_xhigh_and_the_batch_says_so(self):
        self.judge("FAIL overloaded", opus=self.verdicts("keep", "drop"))
        self.drafted(2)
        fable, opus = self.judge_calls()
        self.assertEqual(opus["args"][opus["args"].index("--model") + 1], "opus")
        self.assertEqual(opus["args"][opus["args"].index("--effort") + 1], "xhigh")
        [batch] = self.batches()
        self.assertEqual(batch["judge"]["model"], "claude-opus-5")
        self.assertTrue(batch["judge"]["fallback"])
        self.assertIn("(the fallback)", self.dream("log")[1])

    def test_a_judge_that_fails_leaves_the_batch_pending_and_the_next_run_settles_it(self):
        self.judge("FAIL overloaded: the vault phrase is periwinkle-octopus")
        self.drafted(2)
        [batch] = self.batches()
        self.assertEqual(batch["judge"]["failed"], "call failed")
        self.assertNotIn("judged", batch["candidates"][0])
        self.assertEqual(self.notes(), [])
        self.assertNotIn("periwinkle", "".join(p.read_text() for p in self.states.rglob("*") if p.is_file()))
        self.judge(self.verdicts("keep", "drop"))
        self.run_dream(now=self.writer.t + 3 * DAY)
        [batch] = self.batches()
        self.assertTrue(dream.settled(batch))
        self.assertNotIn("failed", batch["judge"])

    def test_an_answer_that_settles_no_line_costs_no_fallback_call(self):
        self.judge([{"line": 1, "verdict": "keep"}])
        self.drafted(2)
        self.assertEqual(len(self.judge_calls()), 1)
        self.assertEqual(self.batches()[0]["judge"]["failed"], "answer did not settle every line")

    def test_the_judge_counts_against_tapes_daily_cap(self):
        self.tape_config('projects = "all"', "max_calls_per_day = 1")
        self.judge(self.verdicts("keep"))
        out = self.drafted(1)
        self.assertEqual(self.judge_calls(), [])
        self.assertEqual(self.batches()[0]["judge"]["failed"], "daily cap reached")
        self.assertIn("could not settle", out)

    def test_judge_clears_old_unjudged_batches_of_every_project_from_anywhere(self):
        """A batch from before the judge (no `judge`, no `repo`) is settled in the checkout tape's index names."""
        self.drafted(2)
        [batch] = self.batches()
        del batch["judge"], batch["repo"]
        dream.Batches(self.env, "coelhorocha/custom-mcp-servers").save(batch)
        nowhere = self.tmp / "nowhere"
        nowhere.mkdir()
        self.judge(self.verdicts("keep", "edit"))
        code, out = self.dream("judge", cwd=nowhere)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.judge_calls()[-1]["cwd"], str(self.repo))
        self.assertTrue(dream.settled(self.batches()[0]))
        self.assertIn(self.EDITED, "".join(self.live_texts()))
        self.assertIn("no batch waits", self.dream("judge", cwd=nowhere)[1])

    def test_checkout_prefers_the_main_checkout_over_a_jj_workspace_listed_first(self):
        key = "acme/widget"
        ws, main = self.tmp / "widget-feature", self.tmp / "widget"
        ws.mkdir()
        (main / ".git").mkdir(parents=True)
        batches = dream.Batches(self.env, key)
        batches.save({"project": key, "date": "2026-10-22", "made": 0, "turns": [0, 1], "repo": str(ws),
                      "candidates": [], "answer": None})
        store = type("Store", (), {"scope": f"project:{key}"})()
        with mock.patch.object(dream.memo, "project_root", lambda p: (Path(p),)), \
                mock.patch.object(dream.memo, "resolve_project", lambda p: store):
            self.assertEqual(dream.checkout(self.env, batches, cwd=None), str(ws))
            self.assertEqual(dream.checkout(self.env, batches, cwd=str(main)), str(main))
            batches.save({"project": key, "date": "2026-10-23", "made": 0, "turns": [2, 3], "repo": str(main),
                          "candidates": [], "answer": None})
            self.assertEqual(dream.checkout(self.env, batches, cwd=str(ws)), str(main))

    def test_a_project_with_no_checkout_on_the_machine_stays_pending_and_says_so(self):
        key = "acme/widget"
        dream.Batches(self.env, key).save({"project": key, "date": "2026-10-22", "made": 0, "turns": [0, 1],
                                           "candidates": [{"kind": "fact", "text": "t", "turn": 0}],
                                           "answer": None})
        before = self.batches()
        code, out = self.dream("judge", "--project", key)
        self.assertEqual(code, 0, out)
        self.assertIn("no checkout of acme/widget", out)
        self.assertEqual(self.judge_calls(), [])
        self.assertEqual(json.loads((self.tmp / "state" / "tstack" / "memo-dream" / "acme__widget" /
                                     "2026-10-22.json").read_text())["answer"], None)
        self.assertEqual(self.batches(), before)

    def test_log_lists_each_verdict_with_its_reason_note_and_tape_pointer(self):
        self.judge(self.verdicts("keep", "edit", "drop"))
        self.drafted()
        code, out = self.dream("log", cwd=self.tmp)
        self.assertEqual(code, 0, out)
        first = out.splitlines()[0]
        self.assertIn("never instructions", first)
        self.assertIn("memo supersede", first)
        [batch] = self.batches()
        for k, c in enumerate(batch["candidates"], 1):
            self.assertIn(f"reason {k}: checked src/widget.py", out)
        self.assertIn(f"note {batch['candidates'][0]['judged']['note']}", out)
        self.assertIn(f"drop [fact] {self.FACTS[2]}", out)
        self.assertIn("tape --project coelhorocha/custom-mcp-servers zoom", out)
        self.assertIn("no verdicts", self.dream("log", now=self.writer.t + 30 * DAY)[1])

    def test_only_a_batch_the_judge_failed_on_blocks_drafting(self):
        """A batch from before the judge, never tried by it, is judged by the next run, not a reason to stop."""
        self.drafted(1)
        [batch] = self.batches()
        del batch["judge"]
        dream.Batches(self.env, "coelhorocha/custom-mcp-servers").save(batch)
        self.session(("later", "x"), ("close", "x"))
        self.run_dream(now=self.writer.t + 20 * DAY)
        self.assertEqual(len(self.calls()), 2)

    def test_a_settled_batch_never_blocks_drafting_however_old(self):
        self.judge(self.verdicts("drop"))
        self.drafted(1)
        self.session(("later", "x"), ("close", "x"))
        self.run_dream(now=self.writer.t + 20 * DAY)
        self.assertEqual(len(self.calls()), 2)


class NightTest(DreamCase):
    """`night`: the service's entry point, called often by a timer; it dreams once a night, once sessions are quiet."""

    NIGHT = datetime(2026, 12, 2, 3, 0)  # naive: local time, as the window is read
    FACT = [{"kind": "fact", "text": "the widget renders server side", "turn": 0}]

    def night(self, *args, at=None, idle=120, env=None):
        """`memo-dream night` at local time `at`, every transcript last written `idle` minutes before."""
        at = at or self.NIGHT
        for f in (self.tmp / "claude" / "projects").rglob("*.jsonl"):
            os.utime(f, (at.timestamp() - 60 * idle,) * 2)
        return self.dream("night", *args, now=at, env=env)

    def other(self, name, origin):
        """Later sessions go to a second project."""
        repo = self.git_repo(name, origin)
        self.writer = Writer(name, repo, t=self.writer.t)
        self.transcript = self.tmp / "claude" / "projects" / name / f"{name}.jsonl"
        self.turns = 0
        return repo

    def done(self):
        path = self.tmp / "state" / "tstack" / "memo-dream" / "night.json"
        return json.loads(path.read_text())["night"] if path.exists() else None

    def test_outside_the_window_it_does_nothing_and_says_why(self):
        self.session(("ask", "answer"), ("close", "x"))
        for at in (self.NIGHT.replace(hour=0, minute=59), self.NIGHT.replace(hour=7), self.NIGHT.replace(hour=14)):
            with self.subTest(at=at):
                code, out = self.night(at=at)
                self.assertEqual(code, 0, out)
                self.assertEqual(len(out.splitlines()), 1)
                self.assertIn("outside the night window 01:00-07:00", out)
        self.assertEqual(self.every_call(), [])
        self.assertIsNone(self.done())

    def test_it_dreams_once_a_night_and_the_next_night_reads_only_newer_turns(self):
        self.answer(self.FACT)
        self.session(("first ask", "answer"), ("close", "x"))
        code, out = self.night()
        self.assertEqual(code, 0, out)
        self.assertIn("coelhorocha/custom-mcp-servers: 1 candidates from turns 0-1", out)
        self.assertEqual(self.done(), "2026-12-02")
        self.session(("second ask", "answer"), ("close", "x"))
        code, out = self.night(at=self.NIGHT.replace(hour=5))
        self.assertEqual((code, len(out.splitlines())), (0, 1), out)
        self.assertIn("dreamed already", out)
        self.assertEqual(len(self.calls()), 1)
        self.night(at=self.NIGHT + DAY)
        first, second = self.calls()
        self.assertNotIn("first ask", second["stdin"])
        self.assertIn("second ask", second["stdin"])
        self.assertEqual(self.done(), "2026-12-03")

    def test_a_window_across_midnight_keys_the_night_by_the_day_it_started(self):
        self.session(("ask", "answer"), ("close", "x"))
        late = self.NIGHT.replace(hour=23, minute=30)
        code, out = self.night("--window", "22:00-06:00", "--last-call", "05:30", at=late)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.done(), "2026-12-02")
        out = self.night("--window", "22:00-06:00", "--last-call", "05:30", at=late + timedelta(hours=5))[1]
        self.assertIn("dreamed already", out)
        self.assertIn("outside", self.night("--window", "22:00-06:00", "--last-call", "05:30",
                                            at=late - timedelta(hours=2))[1])

    def test_busy_sessions_hold_it_until_last_call(self):
        self.session(("ask", "answer"), ("close", "x"))
        code, out = self.night(idle=10)
        self.assertEqual((code, len(out.splitlines())), (0, 1), out)
        self.assertIn("10 min ago", out)
        self.assertIn("45", out)
        self.assertEqual((self.calls(), self.done()), ([], None))
        self.assertIn("quiet", self.night("--quiet", "5", idle=10)[1])
        self.assertEqual(len(self.calls()), 1, "ten idle minutes are quiet enough for --quiet 5")
        self.session(("more", "x"), ("close", "x"))
        self.night(at=self.NIGHT + DAY + timedelta(hours=3, minutes=29), idle=1)
        self.assertEqual(len(self.calls()), 1)
        self.night(at=self.NIGHT + DAY + timedelta(hours=3, minutes=30), idle=1)
        self.assertEqual(len(self.calls()), 2, "at last call it dreams with sessions running")

    def test_force_skips_the_window_the_once_rule_and_quiet(self):
        self.session(("ask", "answer"), ("close", "x"))
        self.night()
        self.session(("more", "x"), ("close", "x"))
        code, out = self.night("--force", at=self.NIGHT.replace(hour=4), idle=0)
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.calls()), 2)
        self.night("--force", at=self.NIGHT.replace(hour=14), idle=0)
        self.assertEqual(len(self.calls()), 2, "no new turns, no call")

    def test_a_bad_window_or_last_call_is_refused(self):
        for args in (("--window", "25:00-07:00"), ("--window", "01:00"), ("--window", "03:00-03:00"),
                     ("--last-call", "08:00"), ("--quiet", "-1")):
            with self.subTest(args=args):
                code, out = self.night(*args)
                self.assertEqual(code, 2, out)
        self.assertEqual(self.every_call(), [])

    def test_every_project_tape_allows_is_dreamed_and_one_failure_stops_none(self):
        self.answer(self.FACT)
        self.session(("custom ask", "answer"), ("close", "x"))
        widget = self.other("widget", "git@github.com:acme/widget.git")
        self.session(("widget ask", "answer"), ("close", "x"))
        self.other("secret", "git@github.com:acme/secret.git")
        self.session(("secret ask", "answer"), ("close", "x"))
        self.tape_config('projects = "all"', 'exclude = ["acme/secret"]')
        real = dream.draft

        def widget_breaks(env, cwd, key, *rest):
            if key == "acme/widget":
                raise RuntimeError("the widget broke")
            return real(env, cwd, key, *rest)

        with mock.patch.object(dream, "draft", widget_breaks):
            code, out = self.night()
        self.assertEqual(code, 1, out)
        [call] = self.calls()
        self.assertIn("custom ask", call["stdin"])
        self.assertEqual(call["cwd"], str(self.repo))
        self.assertNotIn("secret ask", json.dumps(self.every_call()))
        lines = out.splitlines()
        self.assertTrue(any(ln.startswith("memo-dream: acme/widget: failed (RuntimeError") for ln in lines), out)
        self.assertTrue(any(ln.startswith("memo-dream: coelhorocha/custom-mcp-servers: 1 candidates") for ln in lines))
        self.assertNotIn("acme/secret", out)
        self.assertEqual(self.done(), "2026-12-02")
        code, out = self.night(at=self.NIGHT + DAY)
        self.assertEqual(code, 0, out)
        [_, call] = self.calls()
        self.assertEqual(call["cwd"], str(widget), "the failed project's turns wait for the next night")
        self.assertIn("widget ask", call["stdin"])
        self.assertIn("coelhorocha/custom-mcp-servers: no new turns", out)

    def test_the_env_list_restricts_the_night_to_its_projects(self):
        self.session(("custom ask", "answer"), ("close", "x"))
        self.other("widget", "git@github.com:acme/widget.git")
        self.session(("widget ask", "answer"), ("close", "x"))
        self.night(env={"MEMO_DREAM_PROJECTS": ""})
        self.assertEqual(self.calls(), [])
        self.night("--force", env={"MEMO_DREAM_PROJECTS": "acme/widget"})
        [call] = self.calls()
        self.assertIn("widget ask", call["stdin"])

    def test_it_judges_pending_batches_and_settles_them_at_night(self):
        self.answer(self.FACT)
        self.session(("ask", "answer"), ("close", "x"))
        self.night()
        self.assertEqual(self.batches()[0]["judge"]["failed"], "answer did not settle every line")
        self.judge([{"line": 1, "verdict": "keep", "kind": "fact", "reason": "r"}])
        code, out = self.night(at=self.NIGHT + DAY)
        self.assertEqual(code, 0, out)
        self.assertIn("no new turns", out)
        self.assertIn("the judge kept 1", out)
        self.assertEqual(len(self.calls()), 1)
        self.assertTrue(dream.settled(self.batches()[0]))


if __name__ == "__main__":
    unittest.main()
