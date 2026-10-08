"""Tests for scripts/tape against synthetic transcripts and throwaway git and jj repos.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)

No real transcript is read: every fixture is written here. The model-based test (ModelTest)
drives seeded random ingest sequences; a failure prints its seed. TAPE_MODEL_RUNS=<n> runs more
sequences, TAPE_MODEL_SEED=<s> replays one.
"""

import contextlib
import io
import json
import os
import random
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "scripts" / "tape"
HAVE_JJ = shutil.which("jj") is not None
T0 = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)
HOUR = 3600

sys.dont_write_bytecode = True
_loader = SourceFileLoader("tape_under_test", str(SCRIPT))
tape = module_from_spec(spec_from_loader("tape_under_test", _loader))
_loader.exec_module(tape)


def sh(cwd, *args):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def git_repo(path, origin):
    path.mkdir(parents=True, exist_ok=True)
    sh(path, "git", "init", "-q")
    sh(path, "git", "remote", "add", "origin", origin)
    return path


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


class Writer:
    """Records for one synthetic session, with uuids and a clock."""

    def __init__(self, session, cwd, t=T0, entrypoint="cli"):
        self.session, self.cwd, self.t, self.entrypoint, self.n = session, str(cwd), t, entrypoint, 0

    def _base(self, kind, minutes, cwd=None):
        self.t += timedelta(minutes=minutes)
        self.n += 1
        return {"type": kind, "timestamp": iso(self.t), "sessionId": self.session, "cwd": str(cwd or self.cwd),
                "uuid": f"{self.session}-{self.n:04d}", "isSidechain": False, "entrypoint": self.entrypoint}

    def prompt(self, text, minutes=1, cwd=None):
        r = self._base("user", minutes, cwd)
        r.update(message={"role": "user", "content": text}, origin={"kind": "human"}, promptSource="typed")
        return r

    def reply(self, text, minutes=1):
        r = self._base("assistant", minutes)
        r["message"] = {"role": "assistant", "content": [{"type": "text", "text": text}]}
        return r

    def edit(self, path, minutes=1):
        r = self._base("assistant", minutes)
        r["message"] = {"role": "assistant", "content": [
            {"type": "tool_use", "id": f"t{self.n}", "name": "Edit", "input": {"file_path": str(path)}}]}
        return r

    def error(self, text="Exit code 1 boom", minutes=1):
        r = self._base("user", minutes)
        r["message"] = {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t", "is_error": True, "content": text}]}
        return r

    def notification(self, summary="Agent finished", minutes=1):
        r = self._base("user", minutes)
        r.update(message={"role": "user", "content": f"<task-notification><summary>{summary}</summary></task-notification>"},
                 origin={"kind": "task-notification"})
        return r

    def meta(self, minutes=0):
        r = self._base("attachment", minutes)
        r["attachment"] = {"type": "skill_listing"}
        return r


def append(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    return path


class TapeCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name).resolve()
        self.addCleanup(self._tmp.cleanup)
        self.env = {
            "HOME": str(self.tmp / "home"),
            "XDG_DATA_HOME": str(self.tmp / "data"),
            "XDG_CONFIG_HOME": str(self.tmp / "config"),
            "CLAUDE_CONFIG_DIR": str(self.tmp / "claude"),
            "PATH": os.environ.get("PATH", ""),
        }
        (self.tmp / "config" / "tstack").mkdir(parents=True)
        self.config = self.tmp / "config" / "tstack" / "tape.toml"
        self.config.write_text('projects = "all"\n')
        self.repo = git_repo(self.tmp / "repos" / "widget", "git@github.com:Acme/Widget.git")
        self.other = git_repo(self.tmp / "repos" / "other", "git@github.com:Acme/Other.git")
        self.projects = self.tmp / "claude" / "projects"
        self.store = self.tmp / "data" / "tstack" / "tape" / "acme__widget"
        self.other_store = self.tmp / "data" / "tstack" / "tape" / "acme__other"
        tape._keys.clear()
        tape.memo._scope_cache.clear()

    def transcript(self, launch, session):
        return self.projects / tape.sessions.slug(launch) / f"{session}.jsonl"

    def run_tape(self, *args, now=None, cwd=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err):
            code = tape.main([str(a) for a in args], env=self.env, cwd=str(cwd or self.repo), out=out,
                             now=(now or T0 + timedelta(days=30)).timestamp())
        return code, out.getvalue(), err.getvalue()

    def ok(self, *args, **kw):
        code, out, err = self.run_tape(*args, **kw)
        self.assertEqual(code, 0, f"tape {args} failed: {out}{err}")
        return out

    def rows(self, store=None):
        db = (store or self.store) / "tape.db"
        if not db.exists():
            return []
        con = sqlite3.connect(db)
        try:
            return con.execute("select i, session, from_uuid, leaf, digest from turns order by i").fetchall()
        finally:
            con.close()

    def prompts(self, store=None):
        return [r[3].split(" U: ", 1)[1].split(" | ")[0] for r in self.rows(store)]


class LeafTest(unittest.TestCase):
    def test_fields_in_order(self):
        lines = ["2026-10-01 09:00 USER: fix the hook", "2026-10-01 09:01   TOOL Edit: /r/hooks/tstack-hook",
                 "2026-10-01 09:01   TOOL Edit: /r/hooks/tstack-hook", "2026-10-01 09:02   TOOL Write: /r/docs/a.md",
                 "2026-10-01 09:02   ERROR: Exit code 1", "2026-10-01 09:03 ASSISTANT: first",
                 "2026-10-01 09:04 ASSISTANT: Fixed the hook."]
        leaf = tape.make_leaf("abcdef123456", "2026-10-01T09:00:00Z", lines, "/r")
        self.assertEqual(leaf, "abcdef12 2026-10-01 09:00 U: fix the hook | edited hooks/tstack-hook, docs/a.md"
                               " | 1 errors | A: Fixed the hook.")

    def test_never_over_512_bytes(self):
        rnd = random.Random(7)
        alphabet = "abc ção 漢字 🙂 \t\n|"
        for _ in range(300):
            def text(n):
                return "".join(rnd.choice(alphabet) for _ in range(n))
            lines = [f"2026-10-01 09:00 USER: {text(rnd.randint(0, 3000))}"]
            lines += [f"2026-10-01 09:00   TOOL Edit: /r/{text(rnd.randint(1, 80))}" for _ in range(rnd.randint(0, 30))]
            lines += ["2026-10-01 09:00   ERROR: x"] * rnd.randint(0, 3)
            lines += [f"2026-10-01 09:00 ASSISTANT: {text(rnd.randint(0, 3000))}"]
            session = "s" * rnd.randint(0, 40)
            leaf = tape.make_leaf(session, "2026-10-01T09:00:00Z", lines, "/r")
            self.assertLessEqual(len(leaf.encode()), tape.LEAF_MAX)
            self.assertTrue(leaf.startswith(f"{(session or '?')[:8]} 2026-10-01 09:00 U: "), leaf[:40])

    def test_long_prompt_and_reply_share_the_room(self):
        lines = ["2026-10-01 09:00 USER: " + "p" * 2000, "2026-10-01 09:00 ASSISTANT: " + "r" * 2000]
        leaf = tape.make_leaf("abcdef12", "2026-10-01T09:00:00Z", lines)
        self.assertEqual(len(leaf.encode()), tape.LEAF_MAX)
        self.assertGreater(leaf.count("p"), 200)
        self.assertGreater(leaf.count("r"), 200)

    def test_digest_is_clipped_to_32k_prompt_first(self):
        lines = ["2026-10-01 09:00 USER: the ask"] + [f"2026-10-01 09:00 ASSISTANT: {n} " + "x" * 900 for n in range(100)]
        text = tape.clip_digest(lines)
        self.assertLessEqual(len(text.encode()), tape.DIGEST_MAX)
        self.assertTrue(text.startswith("2026-10-01 09:00 USER: the ask"))
        self.assertIn("lines clipped", text)
        self.assertIn("ASSISTANT: 99 ", text, "the tail is kept")
        self.assertIn("ASSISTANT: 0 ", text, "the head is kept")


class TurnFinishTest(TapeCase):
    def test_a_turn_ends_at_a_later_prompt_or_after_24h(self):
        w = Writer("s1", self.repo)
        f = append(self.transcript(self.repo, "s1"), [w.meta(), w.prompt("first ask"), w.reply("done one"),
                                                     w.prompt("second ask"), w.reply("done two")])
        last = w.t
        self.ok("build", now=last + timedelta(hours=1))
        self.assertEqual(self.prompts(), ["first ask"])
        self.assertIn("1 with an open turn", self.ok("status", now=last + timedelta(hours=1)))
        self.ok("build", now=last + timedelta(hours=23, minutes=59))
        self.assertEqual(self.prompts(), ["first ask"])
        self.ok("build", now=last + timedelta(hours=24))
        self.assertEqual(self.prompts(), ["first ask", "second ask"])

    def test_a_later_prompt_ends_a_turn_before_24h(self):
        w = Writer("s1", self.repo)
        f = append(self.transcript(self.repo, "s1"), [w.prompt("first ask"), w.reply("working")])
        self.ok("build", now=w.t + timedelta(minutes=5))
        self.assertEqual(self.prompts(), [])
        append(f, [w.reply("still working"), w.prompt("next")])
        self.ok("build", now=w.t + timedelta(minutes=5))
        self.assertEqual(self.prompts(), ["first ask"])
        self.assertIn("still working", self.rows()[0][3], "the reread turn keeps the records added since")

    def test_a_resumed_session_appends_to_the_same_file(self):
        w = Writer("s1", self.repo)
        f = append(self.transcript(self.repo, "s1"), [w.prompt("first ask"), w.reply("done")])
        self.ok("build", now=w.t + timedelta(hours=25))
        append(f, [w.notification("background job finished", minutes=26 * 60), w.reply("the job passed"),
                   w.prompt("resumed ask"), w.reply("ok")])
        self.ok("build", now=w.t + timedelta(hours=25))
        leaves = [r[3] for r in self.rows()]
        self.assertEqual(len(leaves), 3)
        self.assertIn("U: (no prompt) | A: the job passed", leaves[1])
        self.assertIn("U: resumed ask", leaves[2])


class IsolationTest(TapeCase):
    def test_only_this_projects_transcripts_land(self):
        w = Writer("mine", self.repo)
        append(self.transcript(self.repo, "mine"), [w.prompt("widget work"), w.reply("ok")])
        o = Writer("theirs", self.other)
        append(self.transcript(self.other, "theirs"), [o.prompt("client secret work"), o.reply("ok")])
        # a slug that names the widget repo, holding a session that ran in the other one: the slug is never trusted
        x = Writer("misfiled", self.other)
        append(self.transcript(self.repo, "misfiled"), [x.prompt("misfiled client work"), x.reply("ok")])
        sub = Writer("sub", self.repo)
        append(self.transcript(self.repo, "mine").with_suffix("") / "subagents" / "agent-a1.jsonl",
               [sub.prompt("subagent work"), sub.reply("ok")])
        h = Writer("headless", self.repo, entrypoint="sdk-cli")
        append(self.transcript(self.repo, "headless"), [h.prompt("headless work"), h.reply("ok")])
        out = self.ok("build")
        self.assertIn("tape: 2 projects", out)
        self.assertEqual(self.prompts(), ["widget work"])
        self.assertEqual(sorted(self.prompts(self.other_store)), ["client secret work", "misfiled client work"])
        status = self.ok("status")
        self.assertIn("1 headless (left out)", status)
        self.assertEqual(sorted(p.name for p in self.store.parent.iterdir()), ["acme__other", "acme__widget", "index.db"])

    def test_a_turn_run_in_another_project_is_skipped(self):
        w = Writer("s1", self.repo)
        append(self.transcript(self.repo, "s1"), [w.prompt("widget work"), w.reply("ok"),
                                                  w.prompt("over there", cwd=self.other), w.reply("ok"),
                                                  w.prompt("back home"), w.reply("ok")])
        self.ok("build")
        self.assertEqual(self.prompts(), ["widget work", "back home"])
        self.assertIn("1 turns skipped as run in another project", self.ok("status"))
        self.assertEqual(self.rows(self.other_store), [], "the other project's store gets no turn of this file")

    def test_a_subdirectory_is_the_same_project(self):
        deep = self.repo / "a" / "b"
        deep.mkdir(parents=True)
        w = Writer("deep", deep)
        append(self.transcript(deep, "deep"), [w.prompt("from below"), w.reply("ok")])
        self.ok("build")
        self.assertEqual(self.prompts(), ["from below"])

    def write_both(self):
        w, o = Writer("mine", self.repo), Writer("theirs", self.other)
        append(self.transcript(self.repo, "mine"), [w.prompt("widget work"), w.reply("ok")])
        append(self.transcript(self.other, "theirs"), [o.prompt("client work"), o.reply("ok")])

    def test_an_excluded_project_is_never_recorded(self):
        self.write_both()
        self.config.write_text('projects = "all"\nexclude = ["Acme/Other"]\n')
        out = self.ok("build")
        self.assertIn("tape: 1 projects", out)
        self.assertIn("1 projects excluded", out)
        self.assertFalse(self.other_store.exists())
        code, _, err = self.run_tape("--project", "acme/other", "build")
        self.assertEqual(code, tape.EXIT_REFUSED)
        self.assertIn("acme/other is excluded", err)
        code, _, err = self.run_tape("build", "--cwd", self.other)
        self.assertEqual(code, tape.EXIT_REFUSED)
        self.assertFalse(self.other_store.exists())

    def test_a_list_of_projects_still_works(self):
        self.write_both()
        self.config.write_text('projects = ["acme/widget"]\n')
        self.ok("build")
        self.assertEqual(self.prompts(), ["widget work"])
        self.assertFalse(self.other_store.exists())
        code, _, err = self.run_tape("--project", "acme/other", "build")
        self.assertEqual(code, tape.EXIT_REFUSED)
        self.assertIn("acme/other is not in `projects`", err)

    def test_build_with_a_project_builds_only_that_one(self):
        self.write_both()
        self.assertIn("tape: acme/other: +1 turns", self.ok("build", "--cwd", self.other))
        self.assertFalse(self.store.exists())
        self.ok("--project", "acme/widget", "build")
        self.assertEqual(self.prompts(), ["widget work"])

    def test_the_config_is_seeded_with_every_project(self):
        self.write_both()
        self.config.unlink()
        self.ok("build")
        self.assertIn('projects = "all"', self.config.read_text())
        self.assertIn("exclude = []", self.config.read_text())
        self.assertEqual(self.prompts(self.other_store), ["client work"])

    def test_a_session_outside_any_repo_gets_no_store(self):
        loose = self.tmp / "loose"
        loose.mkdir()
        w = Writer("loose", loose)
        append(self.transcript(loose, "loose"), [w.prompt("no repo here"), w.reply("ok")])
        out = self.ok("build")
        self.assertIn("tape: 0 projects", out)
        self.assertIn("1 interactive ones outside any repo (no store)", out)
        self.assertEqual([p.name for p in self.store.parent.iterdir()], ["index.db"])

    def test_a_repo_with_no_origin_is_keyed_by_its_path(self):
        bare = self.tmp / "repos" / "bare"
        bare.mkdir()
        sh(bare, "git", "init", "-q")
        w = Writer("bare", bare)
        append(self.transcript(bare, "bare"), [w.prompt("local only"), w.reply("ok")])
        self.ok("build")
        self.assertEqual(self.prompts(tape.store_dir(self.env, str(bare))), ["local only"])

    @unittest.skipUnless(HAVE_JJ, "jj is not installed")
    def test_every_jj_workspace_is_one_project(self):
        repo = self.tmp / "repos" / "gadget"
        repo.mkdir()
        sh(repo, "jj", "git", "init", "--colocate")
        sh(repo, "jj", "git", "remote", "add", "origin", "https://github.com/acme/gadget")
        lane = self.tmp / "repos" / "gadget-lane"
        sh(repo, "jj", "workspace", "add", str(lane))
        a, b = Writer("main", repo), Writer("lane", lane, t=T0 + timedelta(hours=1))
        append(self.transcript(repo, "main"), [a.prompt("in main"), a.reply("ok")])
        append(self.transcript(lane, "lane"), [b.prompt("in the lane"), b.reply("ok")])
        self.ok("build", cwd=lane)
        store = self.tmp / "data" / "tstack" / "tape" / "acme__gadget"
        self.assertEqual(self.prompts(store), ["in main", "in the lane"])


class StoreTest(TapeCase):
    def setUp(self):
        super().setUp()
        w = Writer("s1", self.repo)
        self.file = append(self.transcript(self.repo, "s1"), [
            w.prompt("rename the Haiku readers"), w.edit(self.repo / "MODELS.md"), w.error(),
            w.reply("Renamed them in MODELS.md."), w.prompt("now the tests"), w.reply("Tests pass.")])
        self.last = w.t

    def test_idempotent_and_rebuildable(self):
        self.ok("build")
        first = self.rows()
        self.ok("build")
        self.assertEqual(self.rows(), first, "a second build changes nothing")
        shutil.rmtree(self.store)
        self.ok("build")
        self.assertEqual(self.rows(), first, "a rebuild from scratch gives the same turns")

    def test_a_partial_last_line_waits(self):
        w = Writer("s2", self.repo, t=self.last)
        whole = json.dumps(w.prompt("half written")) + "\n"
        f = self.transcript(self.repo, "s2")
        f.write_text(whole[:20])
        self.ok("build")
        append(f, [])
        with open(f, "a") as fh:
            fh.write(whole[20:] + json.dumps(w.reply("ok")) + "\n")
        self.ok("build")
        self.assertIn("half written", self.prompts())
        self.assertEqual(len(self.rows()), 3)

    def test_store_is_private(self):
        self.ok("build")
        self.assertEqual(self.store.stat().st_mode & 0o777, 0o700)

    def test_view_search_zoom(self):
        self.ok("build")
        view = self.ok("view")
        self.assertIn('<tape project="acme/widget"', view)
        self.assertIn("0 s1 2026-10-01 09:01 U: rename the Haiku readers | edited MODELS.md | 1 errors"
                      " | A: Renamed them in MODELS.md.", view)
        small = self.ok("view", "--bytes", "200")
        self.assertLessEqual(len(small.rstrip("\n").encode()), 200)
        self.assertIn("(1 older turns", small)
        self.assertIn("1 s1 ", small)
        self.assertIn("0 s1", self.ok("search", "haiku"))
        self.assertIn("0 s1", self.ok("search", "MODELS.md"))
        code, out, _ = self.run_tape("search", "nowhere")
        self.assertEqual(code, 1)
        zoom = self.ok("zoom", "0")
        self.assertIn("TOOL Edit: ", zoom)
        self.assertIn("ERROR: Exit code 1 boom", zoom)
        raw = self.ok("zoom", "0", "--raw").splitlines()
        self.assertEqual([json.loads(r)["uuid"] for r in raw], [f"s1-{n:04d}" for n in range(1, 5)])

    def test_zoom_survives_the_transcript(self):
        self.ok("build")
        self.file.unlink()
        self.assertIn("rename the Haiku readers", self.ok("zoom", "0"))
        code, _, err = self.run_tape("zoom", "0", "--raw")
        self.assertEqual(code, 1)
        self.assertIn("is gone", err)
        self.assertIn("1 gone", self.ok("status"))

    def test_zoom_of_an_unknown_turn(self):
        self.ok("build")
        code, _, err = self.run_tape("zoom", "9")
        self.assertEqual(code, tape.EXIT_INVALID)
        self.assertIn("no turn 9 in acme/widget (turns 0..1)", err)

    def test_reading_before_any_build(self):
        code, _, err = self.run_tape("view")
        self.assertEqual(code, tape.EXIT_INVALID)
        self.assertIn("run `tape build`", err)

    def test_bin_link(self):
        self.assertEqual((ROOT / "bin" / "tape").resolve(), SCRIPT.resolve())


class ModelTest(TapeCase):
    """Random ingest sequences against a model of the turn rule. The model reads each transcript's
    complete records from where its last build stopped: a segment runs from a prompt to the next
    one (records before the first prompt are a segment of their own), and is finished when a later
    segment exists or 24 h passed since its last record. A finished segment with content is a turn.
    After every build: the store holds exactly the model's turns, one leaf each, ids 0..N-1, no
    leaf ever changes, and the view is the newest leaves within its budget."""

    STEPS = 40
    BUDGET = 2048

    @staticmethod
    def has_content(rec):
        if rec["type"] == "assistant":
            return True
        content = rec.get("message", {}).get("content")
        return rec["type"] == "user" and (isinstance(content, str) or any(b.get("is_error") for b in content))

    @staticmethod
    def is_prompt(rec):
        return rec["type"] == "user" and rec.get("origin", {}).get("kind") == "human"

    def run_sequence(self, seed):
        rnd = random.Random(seed)
        deep = self.repo / "sub"
        deep.mkdir(exist_ok=True)
        files = {
            "a": (self.transcript(self.repo, "a"), Writer("a", self.repo), True),
            "b": (self.transcript(deep, "b"), Writer("b", deep), True),
            "x": (self.transcript(self.repo, "x"), Writer("x", self.other), False),  # misfiled: another project
        }
        records = {k: [] for k in files}  # every record written, a half-written one included
        pending = {k: "" for k in files}  # the rest of a half-written line
        read_to = {k: 0 for k in files}  # the model's cursor: records consumed by finished segments
        want = set()  # the model's turns, by first uuid
        clock, now = T0, None
        seen = {}  # from_uuid -> (i, leaf), since the last rebuild

        def write(k, rec, partial=False):
            path = files[k][0]
            path.parent.mkdir(parents=True, exist_ok=True)
            line = json.dumps(rec) + "\n"
            with open(path, "a") as fh:
                fh.write(pending[k])
                cut = rnd.randint(1, len(line) - 1) if partial else len(line)
                fh.write(line[:cut])
                pending[k] = line[cut:]
            records[k].append(rec)

        def model_build(at):
            for k, (_, _, mine) in files.items():
                complete = records[k][:-1] if pending[k] else records[k]
                segs = []
                for n in range(read_to[k], len(complete)):
                    if self.is_prompt(complete[n]) or not segs:
                        segs.append([])
                    segs[-1].append(n)
                for j, seg in enumerate(segs):
                    last = datetime.fromisoformat(complete[seg[-1]]["timestamp"].replace("Z", "+00:00"))
                    if j == len(segs) - 1 and at - last < timedelta(hours=24):
                        break
                    read_to[k] = seg[-1] + 1
                    if mine and any(self.has_content(complete[n]) for n in seg):
                        want.add(complete[seg[0]]["uuid"])

        def check(at, step):
            con = sqlite3.connect(self.store / "tape.db")
            try:
                got = con.execute("select i, from_uuid, leaf from turns order by i").fetchall()
                view = tape.view_text(con, "acme/widget", self.BUDGET)
            finally:
                con.close()
            ctx = f"seed {seed} step {step}"
            self.assertEqual({u for _, u, _ in got}, want, ctx)
            self.assertEqual([i for i, _, _ in got], list(range(len(got))), ctx)
            for i, u, leaf in got:
                self.assertLessEqual(len(leaf.encode()), tape.LEAF_MAX, ctx)
                self.assertEqual(seen.setdefault(u, (i, leaf)), (i, leaf), f"{ctx}: a leaf changed")
            self.assertLessEqual(len(view.encode()), self.BUDGET, ctx)
            body = [ln for ln in view.splitlines()[1:-1] if not ln.startswith("(")]
            lines = [f"{i} {leaf}" for i, _, leaf in got]
            self.assertEqual(body, lines[len(lines) - len(body):], f"{ctx}: the view is the newest leaves")
            self.assertTrue(not got or body, f"{ctx}: the view shows at least the newest leaf")
            older = len(got) - len(body)
            self.assertEqual(f"({older} older turns" in view, older > 0, ctx)

        for k in files:
            write(k, files[k][1].prompt(f"start {k}"))
        for step in range(self.STEPS):
            action = rnd.choices(["record", "partial", "gap", "build", "rebuild"], [10, 1, 1, 3, 1])[0]
            if action in ("record", "partial", "gap"):
                k = rnd.choice(list(files))
                w = files[k][1]
                w.t = max(w.t, clock)
                if action == "gap":
                    w.t += timedelta(hours=rnd.randint(25, 60))
                kind = rnd.choice(["prompt", "prompt", "reply", "reply", "edit", "error", "notification", "meta"])
                rec = {"prompt": lambda: w.prompt(f"ask {step} {rnd.random():.3f}", minutes=rnd.randint(0, 90)),
                       "reply": lambda: w.reply(f"answer {step}", minutes=rnd.randint(0, 30)),
                       "edit": lambda: w.edit(self.repo / f"f{rnd.randint(0, 5)}.py"),
                       "error": lambda: w.error(),
                       "notification": lambda: w.notification(),
                       "meta": lambda: w.meta()}[kind]()
                write(k, rec, partial=action == "partial")
                clock = max(clock, w.t)
                continue
            now = max(now or clock, clock + timedelta(hours=rnd.choice([0, 0, 1, 12, 23, 24, 30])))
            clock = now
            if action == "rebuild" and self.store.exists():  # from scratch: the model starts over too
                shutil.rmtree(self.store)
                seen.clear()
                want.clear()
                read_to.update({k: 0 for k in files})
            self.ok("build", now=now)
            model_build(now)
            check(now, step)

    def test_random_sequences(self):
        if os.environ.get("TAPE_MODEL_SEED"):
            seeds = [int(os.environ["TAPE_MODEL_SEED"])]
        else:
            seeds = [random.randrange(1 << 30) for _ in range(int(os.environ.get("TAPE_MODEL_RUNS", "12")))]
        for seed in seeds:
            with self.subTest(seed=seed):
                for f in list(self.projects.glob("*")):
                    shutil.rmtree(f)
                if self.store.exists():
                    shutil.rmtree(self.store)
                tape._keys.clear()
                self.run_sequence(seed)


if __name__ == "__main__":
    unittest.main()
