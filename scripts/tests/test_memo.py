"""Tests for scripts/memo against throwaway jj and git repos.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)

The model-based test (ModelTest) drives seeded random sequences; a failure
prints its seed. MEMO_MODEL_RUNS=<n> runs more sequences, MEMO_MODEL_SEED=<s>
replays one.
"""

import contextlib
import io
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "memo"
HAVE_JJ = shutil.which("jj") is not None


def load_memo():
    sys.dont_write_bytecode = True
    loader = SourceFileLoader("memo_under_test", str(SCRIPT))
    module = module_from_spec(spec_from_loader("memo_under_test", loader))
    loader.exec_module(module)
    return module


memo = load_memo()


def sh(cwd, *args):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def init_repo(path, origin=None):
    """A repo at path: jj (colocated with git) when jj is installed, else git."""
    path.mkdir(parents=True, exist_ok=True)
    if HAVE_JJ:
        sh(path, "jj", "git", "init", "--colocate")
        if origin:
            sh(path, "jj", "git", "remote", "add", "origin", origin)
    else:
        sh(path, "git", "init", "-q")
        if origin:
            sh(path, "git", "remote", "add", "origin", origin)
    return path


class MemoCase(unittest.TestCase):
    ORIGIN = "git@github.com:Acme/Widget.git"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name).resolve()
        self.addCleanup(self._tmp.cleanup)
        self.env = {
            "HOME": str(self.tmp / "home"),
            "XDG_DATA_HOME": str(self.tmp / "data"),
            "XDG_CACHE_HOME": str(self.tmp / "cache"),
            "PATH": os.environ.get("PATH", ""),
            "CLAUDE_CODE_SESSION_ID": "sess-test",
        }
        self.repo = init_repo(self.tmp / "repo", self.ORIGIN)
        self.store = self.repo / ".tstack" / "memo"
        self.global_dir = self.tmp / "data" / "tstack" / "memo" / "global"
        memo._scope_cache.clear()

    def run_memo(self, *args, cwd=None, env=None):
        """Run in-process: (exit code, stdout, stderr)."""
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err):
            code = memo.main([str(a) for a in args], env={**self.env, **(env or {})},
                             cwd=str(cwd or self.repo), out=out)
        return code, out.getvalue(), err.getvalue()

    def ok(self, *args, **kw):
        code, out, err = self.run_memo(*args, **kw)
        self.assertEqual(code, 0, f"memo {args} failed: {out}{err}")
        return out

    def note(self, kind, text, *flags, **kw):
        """Write a note and return its id."""
        out = self.ok("note", kind, text, *flags, **kw)
        return out.split()[1]

    def wake(self, *flags, **kw):
        return self.ok("wake", *flags, **kw)

    def files(self, sub="notes", store=None):
        return sorted(p.name for p in ((store or self.store) / sub).glob("*.md"))

    def section(self, out, head):
        """The lines of out from the one starting with head through its indented lines."""
        lines = out.splitlines()
        start = next((n for n, ln in enumerate(lines) if ln.startswith(head)), None)
        self.assertIsNotNone(start, f"no line starts with {head!r}:\n{out}")
        end = next((n for n in range(start + 1, len(lines)) if not lines[n].startswith("  ")), len(lines))
        return lines[start:end]


class UlidTest(unittest.TestCase):
    def test_sortable_unique_and_well_formed(self):
        ids = [memo.new_ulid() for _ in range(2000)]
        self.assertEqual(len(set(ids)), len(ids))
        self.assertEqual(ids, sorted(ids), "ids of one process sort in creation order")
        self.assertTrue(all(memo._ULID_RE.match(i) for i in ids))
        self.assertLess(abs(memo.ulid_ms(ids[0]) - memo._now_ms()), 60_000)


class ScopeTest(MemoCase):
    def scope(self, cwd):
        memo._scope_cache.clear()
        lines = self.ok("scope", cwd=cwd).splitlines()
        return [tuple(ln.split("\t")) for ln in lines]

    def test_remote_is_normalized_to_owner_repo(self):
        for url, want in [
            ("git@github.com:Acme/Widget.git", "acme/widget"),
            ("https://github.com/acme/widget", "acme/widget"),
            ("https://github.com/acme/widget.git/", "acme/widget"),
            ("ssh://git@github.com/acme/widget.git", "acme/widget"),
            ("ssh://git@host:2222/group/sub/widget.git", "sub/widget"),
            ("github.com:acme/widget", "acme/widget"),
            ("/srv/git/widget.git", None),
            ("../widget", None),
            ("https://example.com/solo", None),
            ("", None),
            (None, None),
        ]:
            self.assertEqual(memo.normalize_remote(url), want, url)

    def test_project_scope_is_the_origin_remote(self):
        self.assertEqual(self.scope(self.repo)[0], ("project:acme/widget", str(self.store)))
        self.assertEqual(self.scope(self.repo)[1], ("global", str(self.global_dir)))

    def test_scope_is_the_repo_root_not_the_cwd(self):
        deep = self.repo / "a" / "b"
        deep.mkdir(parents=True)
        self.assertEqual(self.scope(deep)[0], ("project:acme/widget", str(self.store)))

    @unittest.skipUnless(HAVE_JJ, "needs jj")
    def test_root_agrees_with_jj_workspace_root(self):
        deep = self.repo / "x"
        deep.mkdir()
        self.assertEqual(str(memo.project_root(str(deep))[0]), sh(deep, "jj", "workspace", "root"))

    @unittest.skipUnless(HAVE_JJ, "needs jj")
    def test_secondary_jj_workspace_shares_the_main_repo_memory(self):
        second = self.tmp / "second"
        sh(self.repo, "jj", "workspace", "add", str(second))
        self.assertTrue((second / ".jj" / "repo").is_file(), "jj changed how a workspace points at its repo")
        self.assertEqual(self.scope(second), self.scope(self.repo))
        ident = self.note("fact", "written from the second workspace", cwd=second)
        self.assertEqual(self.files(), [f"{ident}.md"])
        self.assertFalse((second / ".tstack").exists())
        self.assertIn("written from the second workspace", self.wake(cwd=self.repo))

    def test_without_a_remote_the_key_is_the_main_repo_path(self):
        bare = init_repo(self.tmp / "norem")
        self.assertEqual(self.scope(bare)[0], (f"project:{bare}", str(bare / ".tstack" / "memo")))

    @unittest.skipUnless(HAVE_JJ, "needs jj")
    def test_jj_repo_that_is_not_colocated(self):
        repo = self.tmp / "plain"
        repo.mkdir()
        sh(repo, "jj", "git", "init", "--no-colocate")
        sh(repo, "jj", "git", "remote", "add", "origin", "https://example.com/Team/Thing.git")
        self.assertFalse((repo / ".git").exists())
        self.assertEqual(self.scope(repo)[0], ("project:team/thing", str(repo / ".tstack" / "memo")))

    def test_git_fallback_and_its_worktrees(self):
        repo = self.tmp / "gitonly"
        repo.mkdir()
        sh(repo, "git", "init", "-q")
        sh(repo, "git", "remote", "add", "origin", "https://github.com/acme/gitonly.git")
        sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c")
        want = ("project:acme/gitonly", str(repo / ".tstack" / "memo"))
        self.assertEqual(self.scope(repo)[0], want)
        tree = self.tmp / "tree"
        sh(repo, "git", "worktree", "add", "-q", str(tree))
        self.assertEqual(self.scope(tree)[0], want)

    def test_outside_any_repo_there_is_only_global(self):
        nowhere = self.tmp / "nowhere"
        nowhere.mkdir()
        self.assertEqual(self.scope(nowhere), [("global", str(self.global_dir))])
        out = self.ok("note", "fact", "a fact from nowhere", cwd=nowhere)
        self.assertIn("global", out)
        self.assertEqual(len(self.files(store=self.global_dir)), 1)
        self.assertFalse((nowhere / ".tstack").exists())
        self.assertIn("global only", self.wake(cwd=nowhere))


class NoteTest(MemoCase):
    def test_a_note_is_one_small_file_with_a_toml_front_block(self):
        ident = self.note("decision", "Chose A over B because C", "--ref", "src/a.py", "--ref", "zzzkkk")
        content = (self.store / "notes" / f"{ident}.md").read_text()
        self.assertEqual(content.splitlines()[0], "+++")
        item = memo.parse_item(content, ident)
        self.assertEqual((item.kind, item.text, item.scope), ("decision", "Chose A over B because C", "project:acme/widget"))
        self.assertEqual(item.refs, ["src/a.py", "zzzkkk"])
        self.assertEqual(item.by, "sess-test/interactive")
        self.assertEqual(content, memo.render_item(item), "a file round-trips")
        self.assertFalse(list(self.store.rglob(".tmp-*")), "no temporary file is left behind")

    def test_text_is_kept_to_one_line(self):
        ident = self.note("fact", "two\nlines   and \"quotes\" and a \\ backslash")
        item = memo.parse_item((self.store / "notes" / f"{ident}.md").read_text(), ident)
        self.assertEqual(item.text, 'two lines and "quotes" and a \\ backslash')

    def test_refusals(self):
        for args, why in [
            (("note", "fact", "x" * 281), "characters"),
            (("note", "fact", "   "), "empty"),
            (("note", "fact", "the key is sk-abcdefghijklmnopqrstuvwxyz123456"), "secret"),
            (("note", "fact", "db password: hunter2hunter2"), "secret"),
            (("note", "fact", "x", "--supersedes", "NOPE99"), "no note"),
        ]:
            code, out, err = self.run_memo(*args)
            self.assertEqual(code, 2, args)
            self.assertIn(why, err)
        self.assertEqual(self.run_memo("note", "story", "x")[0], 2, "an unknown kind is a usage error")
        self.assertEqual(self.files(), [])

    def test_a_long_line_is_refused_with_how_far_over_it_is(self):
        code, _, err = self.run_memo("note", "fact", "y" * 312)
        self.assertEqual(code, 2)
        self.assertIn("312 characters, 32 over the 280 limit", err)
        self.assertIn("a memory is one line", err)
        self.assertEqual(self.run_memo("note", "fact", "y" * 280)[0], 0, "exactly at the limit is accepted")

    def test_a_worker_cannot_write_and_does_not_wake(self):
        ident = self.note("fact", "from the coordinator")
        worker = {"TSTACK_ROLE": "worker"}
        for args in [("note", "fact", "from a worker"), ("summarize", ident, ident, "x"),
                     ("pin", ident), ("supersede", ident, "x"), ("open", "a thread")]:
            code, out, err = self.run_memo(*args, env=worker)
            self.assertEqual(code, 3, args)
            self.assertIn("worker", err)
        self.assertEqual(self.files(), [f"{ident}.md"])
        self.assertEqual(self.wake(env=worker), "")
        self.assertIn("from the coordinator", self.ok("recall", "coordinator", env=worker), "a worker may read")

    def test_the_same_line_noted_again_is_not_written_twice(self):
        first = self.note("fact", "the retry wrote this line")
        self.assertEqual(self.ok("note", "fact", "the retry  wrote\nthis line"), f"already noted as {first}\n",
                         "the store holds text with its whitespace collapsed, so a retry compares that way")
        self.assertEqual(self.files(), [f"{first}.md"])
        out = self.ok("note", "fact", "the retry wrote this line", "--pin")
        self.assertIn(f"already noted as {first}", out)
        self.assertIn(f"memo pin {first}", out, "a pin asked on a retry is not dropped in silence")
        self.assertEqual(self.files(), [f"{first}.md"])
        written = lambda *args: self.ok("note", *args).startswith("noted ")  # noqa: E731
        self.assertTrue(written("fact", "The retry wrote this line"), "an exact match only")
        self.note("fact", "check whether the cache expires")
        self.assertTrue(written("open", "check whether the cache expires"), "a thread is not a fact")
        self.assertIn("## Open threads", self.wake())
        self.assertTrue(written("decision", "the retry wrote this line"), "the kind is matched exactly")
        self.note("fact", "the retry wrote this line", "--global")
        self.assertEqual(len(self.files(store=self.global_dir)), 1, "another store is another store")

    def test_a_line_folded_into_a_summary_may_be_noted_again_word_for_word(self):
        # The wake shows the summary in place of a plain note it covers, so a re-note is no retry: it puts the line
        # back. A pin or an open thread is shown whole under its summary too, so noting it again is still a retry.
        old = self.note("fact", "the cache expires after an hour")
        pinned = self.note("preference", "commands in nushell syntax", "--pin")
        thread = self.note("open", "does the cache survive a deploy")
        self.ok("summarize", old, self.note("fact", "the cache lives in R2"), pinned, thread, "where the cache lives")
        self.assertNotIn("the cache expires after an hour", self.wake())
        out = self.ok("note", "fact", "the cache expires after an hour")
        self.assertTrue(out.startswith("noted "), out)
        self.assertIn("the cache expires after an hour", self.wake())
        self.assertEqual(self.ok("note", "preference", "commands in nushell syntax", "--pin"),
                         f"already noted as {pinned}\n")
        self.assertEqual(self.ok("open", "does the cache survive a deploy"), f"already noted as {thread}\n")

    def test_a_retried_close_or_thread_is_not_written_twice(self):
        env = {"MEMO_PROJECT_LINES": "8"}
        threads = [self.note("open", f"thread {n}", env=env) for n in range(4)]
        self.assertEqual(self.ok("open", "thread 0", env=env), f"already noted as {threads[0]}\n",
                         "a retry at the cap is not refused")
        closed = self.ok("supersede", threads[1], "thread 1 done", env=env).split()[1]
        self.assertEqual(self.ok("supersede", threads[1], "thread 1 done", env=env), f"already noted as {closed}\n")
        other = self.ok("supersede", threads[2], "thread 1 done", env=env)
        self.assertTrue(other.startswith("noted "), "the same line closing another note still closes it")
        again = self.note("fact", "thread 0 notes")
        self.ok("supersede", again, "thread 0 notes, corrected")
        self.assertTrue(self.ok("note", "fact", "thread 0 notes").startswith("noted "),
                        "a superseded line may be noted anew")

    def test_global_notes_live_outside_the_repo(self):
        self.note("preference", "commands in nushell syntax", "--global")
        self.assertEqual(self.files(), [])
        self.assertEqual(len(self.files(store=self.global_dir)), 1)
        other = init_repo(self.tmp / "other")
        self.assertIn("commands in nushell syntax", self.wake(cwd=other))

    def test_role_is_recorded(self):
        ident = self.note("fact", "noted by a coordinator", env={"TSTACK_ROLE": "coordinator"})
        self.assertIn('by = "sess-test/coordinator"', (self.store / "notes" / f"{ident}.md").read_text())


class SupersedeTest(MemoCase):
    def test_wake_shows_only_the_newest(self):
        old = self.note("fact", "the port is 8080")
        out = self.ok("supersede", old[-6:], "the port is 9090")
        self.assertIn("superseding", out)
        wake = self.wake()
        self.assertIn("the port is 9090", wake)
        self.assertNotIn("the port is 8080", wake)
        self.assertEqual(len(self.files()), 2, "the old note stays on disk")
        self.assertIn("superseded by", self.ok("recall", "port"))

    def test_an_open_thread_is_closed_by_the_note_that_supersedes_it(self):
        thread = self.note("open", "migration half done")
        self.assertIn("migration half done", self.ok("open"))
        self.assertIn("## Open threads", self.wake())
        out = self.ok("supersede", thread, "migration finished, table dropped")
        self.assertIn("[fact]", out, "closing a thread does not open another")
        self.assertEqual(self.ok("open"), "")
        wake = self.wake()
        self.assertNotIn("## Open threads", wake)
        self.assertNotIn("migration half done", wake)

    def test_chains_and_note_flag(self):
        a = self.note("decision", "use sqlite")
        b = self.note("decision", "use postgres", "--supersedes", a)
        self.note("decision", "use sqlite after all", "--supersedes", b)
        wake = self.wake()
        self.assertNotIn("use sqlite (", wake)
        self.assertNotIn("use postgres", wake)
        self.assertIn("use sqlite after all", wake)

    def test_a_pin_is_carried_to_the_note_that_corrects_it(self):
        rule = self.note("preference", "never push", "--pin")
        self.ok("supersede", rule, "never push without asking")
        self.assertIn("pinned", self.ok("recall", "asking"))
        self.assertIn("## Pinned", self.wake())
        self.ok("supersede", self.files()[-1][:-3], "push freely", "--unpin")
        self.assertNotIn("## Pinned", self.wake())

    def test_ids_resolve_by_unique_tail(self):
        a = self.note("fact", "alpha")
        code, _, err = self.run_memo("zoom", "ZZZZZZ")
        self.assertEqual(code, 2)
        self.assertIn("no note", err)
        self.assertIn("alpha", self.ok("zoom", a[-6:].lower()))
        twin = memo.Item(id=a[:20] + ("0" if a[20] != "0" else "1") + a[21:], kind="fact", text="twin")
        self.assertTrue(memo._ULID_RE.match(twin.id))
        memo.atomic_write(self.store / "notes" / f"{twin.id}.md", memo.render_item(twin))
        code, _, err = self.run_memo("zoom", a[-4:])
        self.assertEqual(code, 2)
        self.assertIn("ambiguous", err)


class PinTest(MemoCase):
    def test_pin_and_unpin(self):
        ident = self.note("preference", "tabs, not spaces")
        self.assertNotIn("## Pinned", self.wake())
        self.ok("pin", ident)
        self.assertIn("## Pinned", self.wake())
        self.assertIn("pin = true", (self.store / "notes" / f"{ident}.md").read_text())
        self.ok("pin", ident, "--unpin")
        self.assertNotIn("## Pinned", self.wake())

    def test_pins_and_open_threads_may_take_half_the_budget(self):
        env = {"MEMO_PROJECT_LINES": "10"}
        for n in range(3):
            self.note("preference", f"rule {n}", "--pin", env=env)
        self.note("open", "thread 0", env=env)
        self.note("open", "thread 1", env=env)
        for args in [("note", "fact", "one too many", "--pin"), ("note", "open", "one too many"),
                     ("open", "one too many")]:
            code, _, err = self.run_memo(*args, env=env)
            self.assertEqual(code, 2, args)
            self.assertIn("pins", err)
        plain = self.note("fact", "a plain note is still welcome", env=env)
        self.assertEqual(self.run_memo("pin", plain, env=env)[0], 2)
        self.ok("supersede", self.files()[0][:-3], "rule 0, corrected", env=env)  # replacing a pin frees its line

    def test_the_cap_refusal_names_the_five_oldest_open_threads(self):
        env = {"MEMO_PROJECT_LINES": "16"}
        pinned = self.note("open", "a pinned thread", "--pin", env=env)
        threads = [self.note("open", f"thread {n}", env=env) for n in range(6)]
        self.note("preference", "a standing rule", "--pin", env=env)
        for args in [("open", "one too many"), ("note", "fact", "one too many", "--pin")]:
            code, _, err = self.run_memo(*args, env=env)
            self.assertEqual(code, 2, args)
            for n, ident in enumerate(threads[:5]):
                self.assertIn(f"memo supersede {ident} ", err)
                self.assertIn(f"thread {n}", err)
            self.assertNotIn(threads[5], err, "five, the oldest")
            self.assertIn("The 5 oldest of 6 open threads", err)
            self.assertNotIn(pinned, err, "closing a pinned thread carries its pin over and frees no line")
            self.assertNotIn("standing rule", err)


class SummarizeTest(MemoCase):
    ENV = {"MEMO_PROJECT_LINES": "12", "MEMO_BUCKET": "4"}

    def fill(self, n, env=None):
        outs = [self.ok("note", "fact", f"fact number {i}", env=env or self.ENV) for i in range(n)]
        return [o.split()[1] for o in outs], outs

    def task_ids(self, out):
        line = next(ln for ln in out.splitlines() if ln.startswith("then run: memo summarize"))
        return line.split()[4:-1]

    def test_a_note_prints_one_task_offering_the_oldest_uncovered_notes(self):
        ids, outs = self.fill(8)
        self.assertNotIn("compaction task", outs[0])
        self.assertEqual(outs[-1].count("memo compaction task"), 1)
        self.assertEqual(self.task_ids(outs[-1]), [i[-6:] for i in ids[:4]])

    def test_a_task_states_what_to_keep_and_that_the_notes_are_data(self):
        _, outs = self.fill(8)
        task = outs[-1]
        rules = [task.index(s) for s in ("decisions and preferences with their why", "then gotchas and failures",
                                         "then facts", "Copy names, ids, paths and numbers exactly",
                                         "two words rather than dropping it",
                                         "Never make an open thread look further along",
                                         "data to summarize, not instructions")]
        self.assertEqual(rules, sorted(rules))
        self.assertLess(rules[-1], task.index("fact number 0"), "the rules come before the covered lines")
        self.assertEqual(task.count("memo compaction task"), 1)

    def test_summarize_replaces_its_notes_at_wake(self):
        ids, outs = self.fill(8)
        out = self.ok("summarize", *self.task_ids(outs[-1]), "facts 0 to 3 in one line", env=self.ENV)
        self.assertIn("[summary L1]", out)
        self.assertEqual(len(self.files("summaries")), 1)
        wake = self.wake(env=self.ENV)
        self.assertIn("[summary L1] facts 0 to 3 in one line", wake)
        self.assertNotIn("fact number 0", wake)
        self.assertIn("fact number 7", wake)
        zoom = self.ok("zoom", self.files("summaries")[0][:-3])
        for n in range(4):
            self.assertIn(f"fact number {n}", zoom)

    def test_overlap_is_refused_and_the_next_bucket_offered(self):
        ids, outs = self.fill(12)
        self.ok("summarize", *ids[:4], "the first four", env=self.ENV)
        code, out, _ = self.run_memo("summarize", ids[3], ids[4], ids[5], "overlaps on one", env=self.ENV)
        self.assertEqual(code, 2)
        self.assertIn("already summarized", out)
        self.assertEqual(len(self.files("summaries")), 1, "nothing was written")
        self.assertEqual(self.task_ids(out), [i[-6:] for i in ids[4:8]], "the next bucket skips what is covered")

    def test_shape_is_checked(self):
        ids, _ = self.fill(6, env={})
        self.ok("summarize", ids[0], ids[1], "two notes")
        summary = self.files("summaries")[0][:-3]
        for args, why in [
            (("summarize", ids[2], "only one id"), "at least two"),
            (("summarize", ids[2], ids[2], "the same id twice"), "two distinct"),
            (("summarize", ids[2], summary, "a note and a summary"), "one level"),
            (("summarize", ids[2], ids[3], "x" * 300), "characters"),
            (("summarize", ids[2], "NOPE99", "unknown id"), "no note"),
        ]:
            code, _, err = self.run_memo(*args)
            self.assertEqual(code, 2, args)
            self.assertIn(why, err)
        self.assertEqual(len(self.files("summaries")), 1)
        code, _, err = self.run_memo("summarize", ids[2], ids[3], "x" * 300)
        self.assertIn("300 characters, 20 over the 280 limit; a summary is one line", err)

    def test_summaries_form_a_tree(self):
        ids, _ = self.fill(8, env={})
        self.ok("summarize", *ids[:4], "first half")
        self.ok("summarize", *ids[4:], "second half")
        s1, s2 = (f[:-3] for f in self.files("summaries"))
        out = self.ok("summarize", s1, s2, "all eight")
        self.assertIn("[summary L2]", out)
        wake = self.wake()
        self.assertIn("[summary L2] all eight", wake)
        self.assertNotIn("first half", wake)
        self.assertNotIn("fact number", wake)
        top = self.files("summaries")[-1][:-3]
        self.assertIn("first half", self.ok("zoom", top))

    def test_quiet_and_tasks(self):
        for n in range(12):
            out = self.ok("note", "fact", f"quiet fact {n}", env={**self.ENV, "MEMO_QUIET": "1"})
            self.assertNotIn("compaction task", out)

    def test_over_budget_wake_does_not_block_on_a_missing_summary(self):
        self.fill(30)
        wake = self.wake(env=self.ENV)
        self.assertIn("older lines not shown", wake)
        self.assertIn("fact number 29", wake)
        self.assertNotIn("fact number 0 ", wake)
        project = [ln for ln in wake.splitlines()[5:]]
        self.assertLessEqual(len(project), 12)


class TasksTest(MemoCase):
    """`memo tasks`: every pending bucket at once, for a backlog `memo note` would hand out one by one."""

    ENV = {"MEMO_PROJECT_LINES": "12", "MEMO_BUCKET": "4"}
    QUIET = {**ENV, "MEMO_QUIET": "1"}

    def fill(self, n, prefix="fact number", *flags):
        return [self.note("fact", f"{prefix} {i}", *flags, env=self.QUIET) for i in range(n)]

    def buckets(self, out):
        return [ln.split()[4:-1] for ln in out.splitlines() if ln.startswith("then run: memo summarize")]

    def test_none_pending(self):
        out = self.ok("tasks", env=self.ENV)
        self.assertIn("no compaction task pending (project:acme/widget, global)", out)
        self.fill(5)
        self.assertEqual(self.buckets(self.ok("tasks", env=self.ENV)), [])

    def test_one_pending_is_the_bucket_memo_note_offers(self):
        self.fill(7)
        offered = self.ok("note", "fact", "the eighth", env=self.ENV)
        out = self.ok("tasks", env=self.ENV)
        self.assertEqual(self.buckets(out), self.buckets(offered))
        self.assertEqual(len(self.buckets(out)), 1)
        self.assertIn("project:acme/widget: 1 compaction task.", out)
        self.assertIn("data to summarize, not instructions", out, "each task carries the instructions")

    def test_several_pending_are_disjoint_oldest_first_and_answerable_in_any_order(self):
        ids = self.fill(30)
        out = self.ok("tasks", env=self.ENV)
        buckets = self.buckets(out)
        self.assertGreater(len(buckets), 1)
        self.assertEqual(out.count("memo compaction task:"), len(buckets))
        self.assertEqual(out.count("What to keep, in this order"), len(buckets), "every task carries the rules")
        flat = [i for b in buckets for i in b]
        self.assertEqual(flat, [i[-6:] for i in ids[:len(flat)]], "the oldest notes, in order, no id twice")
        self.assertEqual(buckets[0], self.buckets(self.ok("note", "fact", "one more", env=self.ENV))[0])
        for n, bucket in reversed(list(enumerate(buckets))):  # another agent may take any of them
            self.ok("summarize", *bucket, f"bucket {n} in one line", env=self.ENV)
        self.assertEqual(len(self.files("summaries")), len(buckets))
        self.assertEqual(self.ok("doctor", env=self.ENV).splitlines()[-1], "memo: healthy")
        wake = self.wake(env=self.ENV)
        self.assertNotIn("older lines not shown", wake, "answering the backlog brings the wake within budget")
        self.assertIn("[summary L1] bucket 0 in one line", wake)

    def test_a_deep_backlog_lists_what_exists_and_says_more_will_come(self):
        ids = self.fill(8)
        self.ok("summarize", *ids[:4], "the first four", env=self.QUIET)
        self.ok("summarize", *ids[4:], "the second four", env=self.QUIET)
        self.fill(40, "later fact")
        out = self.ok("tasks", env=self.ENV)
        buckets = self.buckets(out)
        summaries = {f[:-3][-6:] for f in self.files("summaries")}
        self.assertTrue(all(i in self.ok("export") for b in buckets for i in b), "every id exists now")
        self.assertFalse(summaries & {i for b in buckets for i in b}, "two L1 summaries are no full bucket of 4")
        self.assertIn("`memo tasks` has more", out)

    def test_a_bucket_another_agent_overlapped_is_refused(self):
        self.fill(30)
        buckets = self.buckets(self.ok("tasks", env=self.ENV))
        self.ok("summarize", buckets[1][0], buckets[1][1], "someone else got there first", env=self.ENV)
        code, out, _ = self.run_memo("summarize", *buckets[1], "the whole bucket", env=self.ENV)
        self.assertEqual(code, 2)
        self.assertIn("already summarized", out)
        listed = [i for b in self.buckets(self.ok("tasks", env=self.ENV)) for i in b]
        self.assertNotIn(buckets[1][0], listed, "the next listing skips what is covered")
        self.assertIn(buckets[1][2], listed, "and still offers what is not")

    def test_both_stores_are_listed(self):
        env = {**self.ENV, "MEMO_GLOBAL_LINES": "8"}
        self.fill(30)
        self.fill(12, "global fact", "--global")
        out = self.ok("tasks", env=env)
        self.assertLess(out.index("# project:acme/widget:"), out.index("# global:"))
        g = out[out.index("# global:"):]
        self.assertIn("global fact 0", g)
        self.assertNotIn("fact number", g)

    def test_a_worker_and_a_quiet_session_get_none(self):
        self.fill(30)
        code, out, err = self.run_memo("tasks", env={**self.ENV, "TSTACK_ROLE": "worker"})
        self.assertEqual((code, out), (3, ""))
        self.assertIn("worker", err)
        code, out, err = self.run_memo("tasks", env=self.QUIET)
        self.assertEqual((code, out), (0, ""))
        self.assertIn("MEMO_QUIET", err)

    def test_the_help_lists_it(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(memo.main(["--help"], env=self.env, cwd=str(self.repo)), 0)
        self.assertIn("tasks", out.getvalue())
        self.assertIn("every pending compaction task", out.getvalue())


class WakeTest(MemoCase):
    def test_sections_in_order(self):
        self.note("fact", "a plain fact")
        self.note("preference", "a standing rule", "--pin")
        self.note("open", "an unfinished thread")
        self.note("fact", "a machine fact", "--global")
        wake = self.wake()
        lines = wake.splitlines()
        self.assertTrue(lines[0].startswith("# memo"))
        self.assertIn("project:acme/widget", lines[0])
        order = [wake.index(s) for s in ("memo note <", "## Pinned", "a standing rule", "## Open threads",
                                         "an unfinished thread", "## Notes", "a plain fact", "## Global",
                                         "a machine fact")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(next(i for i, ln in enumerate(lines) if ln.startswith("## ")), 5, "a five-line usage block")

    def test_empty_memory_still_says_how_to_note(self):
        wake = self.wake()
        self.assertEqual(len(wake.splitlines()), 5)
        self.assertIn("memo note <", wake)

    def test_a_compaction_rewake_asks_for_the_candidates(self):
        self.assertIn("just compacted", self.wake("--source", "compact"))
        self.assertNotIn("just compacted", self.wake("--source", "startup"))

    def test_budgets_come_from_env_or_the_config_file(self):
        for n in range(40):
            self.note("fact", f"project fact {n}", env={"MEMO_QUIET": "1"})
            self.note("fact", f"global fact {n}", "--global", env={"MEMO_QUIET": "1"})

        def sizes(wake):
            body = wake.splitlines()[5:]
            cut = next(i for i, ln in enumerate(body) if ln.startswith("## Global"))
            return cut, len(body) - cut

        self.assertEqual(sizes(self.wake()), (41, 20))
        self.assertEqual(sizes(self.wake(env={"MEMO_PROJECT_LINES": "15", "MEMO_GLOBAL_LINES": "9"})), (15, 9))
        (self.store / "config.toml").write_text("project_lines = 11\nglobal_lines = 10\n")
        self.assertEqual(sizes(self.wake()), (11, 10))
        self.assertEqual(sizes(self.wake(env={"MEMO_PROJECT_LINES": "30"})), (30, 10), "env wins over the file")


class ReadTest(MemoCase):
    def test_recall_searches_project_and_global(self):
        self.note("gotcha", "jj workspaces share one operation log")
        self.note("fact", "the laptop runs NixOS", "--global")
        self.assertIn("operation log", self.ok("recall", "workspaces"))
        self.assertIn("NixOS", self.ok("recall", "nixos laptop"))
        self.assertIn("operation log", self.ok("recall", "operat"), "a prefix is enough when nothing matches whole")
        self.assertIn("nothing on", self.ok("recall", "kubernetes"))
        self.assertIn("operation log", self.ok("recall", 'jj "AND (', "workspaces"), "odd characters are not a syntax error")

    def test_recall_keeps_worker_and_decision_ids_in_the_query(self):
        worker = self.note("fact", "the deploy runs in workspace a265")
        other = self.note("fact", "the deploy runs on fridays")
        out = self.ok("recall", "what did a265 deploy")
        self.assertTrue(out.startswith(worker), "a note can be about a worker's work")
        self.assertIn(other, out)
        self.assertIn(worker, self.ok("recall", "a265"))

    def test_a_word_the_query_repeats_weighs_more(self):
        deploy = self.note("fact", "the deploy runs nightly")
        fridays = self.note("fact", "the office closes on fridays")
        self.assertTrue(self.ok("recall", "deploy deploy deploy fridays").startswith(deploy))
        self.assertTrue(self.ok("recall", "deploy fridays fridays fridays").startswith(fridays))

    def test_recall_searches_stopwords(self):
        note = self.note("fact", "what is the cache for, and where is it")
        self.assertIn(note, self.ok("recall", "what is it for"))

    def one_topic_notes(self):
        """More topics than the floor lets one of them stand for, a note each: (topic words, note ids)."""
        words = [f"topic{n}word" for n in range(int(1 / memo.COVERAGE_FLOOR) + 1)]
        return words, [self.note("fact", f"the {w} runs on fridays") for w in words]

    def test_recall_says_nothing_fits_when_no_note_covers_enough_of_the_query(self):
        words, weak = self.one_topic_notes()
        out = self.ok("recall", *words, "--limit", "3")
        self.assertEqual(out.splitlines(), [f"memo: nothing on {' '.join(words)!r}; try `tape search <words>` (coordinator sessions only)"])
        self.assertFalse(any(i in out for i in weak))

    def test_the_or_try_never_pads_past_the_floor(self):
        words, weak = self.one_topic_notes()
        strong = self.note("fact", "notes on " + " ".join(words[:-1]))
        out = self.ok("recall", *words, "--limit", "3")
        self.assertEqual([ln.split()[0] for ln in out.splitlines()], [strong])
        self.assertFalse(any(i in out for i in weak))

    def test_a_query_word_no_note_has_does_not_count_against_coverage(self):
        deploy = self.note("fact", "the deploy runs on fridays")
        self.note("fact", "the cache lives under home")
        out = self.ok("recall", "deploy", *(f"zq{n}nothing" for n in range(int(1 / memo.COVERAGE_FLOOR) + 1)))
        self.assertIn(deploy, out)

    def test_stopwords_count_for_the_search_but_not_for_coverage(self):
        deploy = self.note("fact", "the deploy runs on fridays")
        chatter = self.note("fact", "what is it for, and where is the rest")
        out = self.ok("recall", "what", "is", "the", "rollout", "of", "deploy", "for")
        self.assertIn(deploy, out)
        self.assertNotIn(chatter, out, "a note that shares only stopwords with the query covers none of it")

    def test_a_query_whose_content_terms_no_note_has_finds_nothing_on_its_stopwords(self):
        self.note("fact", "what is it")
        out = self.ok("recall", "what", "is", "kubernetes")
        self.assertTrue(out.startswith("memo: nothing on 'what is kubernetes'"), out)

    def test_recall_searches_every_term_of_a_long_query(self):
        thirteenth = self.note("fact", "mike is the thirteenth word")
        out = self.ok("recall", "alfa bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike")
        self.assertIn(thirteenth, out)

    def test_recall_without_the_index_also_drops_bare_numbers(self):
        self.note("fact", "read straight from disk")
        blocked = self.tmp / "blocked"
        blocked.write_text("a file where the cache folder should be")
        self.assertIn("read straight from disk", self.ok("recall", "straight 42", env={"XDG_CACHE_HOME": str(blocked)}))

    def test_recall_does_not_search_bare_numbers(self):
        real = self.note("fact", "the deploy runs on fridays")
        noise = self.note("fact", "the port is 8080")
        out = self.ok("recall", "8080 deploy")
        self.assertIn(real, out)
        self.assertNotIn(noise, out)
        decision = self.note("decision", "D238 B is live")
        self.assertIn(decision, self.ok("recall", "D238 400"), "an id that mixes letters and digits is searched")

    def test_recall_drops_one_letter_words(self):
        real = self.note("fact", "the deploy runs on fridays")
        noise = self.note("fact", "sync stops soon")
        out = self.ok("recall", "deploy's x")
        self.assertIn(real, out)
        self.assertNotIn(noise, out, "the possessive s is not a prefix of every s word")

    def test_recall_of_a_query_with_no_word_left_finds_nothing(self):
        self.note("fact", "the port is 42 and the user's shell is nu")
        blocked = self.tmp / "blocked"
        blocked.write_text("a file where the cache folder should be")
        for env in ({}, {"XDG_CACHE_HOME": str(blocked)}):
            for query in ("42", "s"):
                out = self.ok("recall", query, env=env)
                self.assertTrue(out.startswith(f"memo: nothing on {query!r}"), f"{query!r} {env}: {out}")

    def test_a_note_whose_kind_is_the_query_word_does_not_outrank_one_that_says_it(self):
        about = self.note("fact", "the decision log lives under docs and is read at every planning meeting")
        self.note("decision", "ship on fridays")
        self.assertTrue(self.ok("recall", "decision").startswith(about))

    def test_recall_of_a_sentence_stays_fast_on_a_large_store(self):
        notes = self.global_dir / "notes"
        notes.mkdir(parents=True)
        rnd = random.Random(1)
        vocab = [f"s{w}{i}" for i in range(400) for w in ("ab", "et")]
        for _ in range(500):
            item = memo.Item(memo.new_ulid(), "fact", " ".join(rnd.choices(vocab, k=20)), scope="global")
            (notes / f"{item.id}.md").write_text(memo.render_item(item))
        self.ok("recall", "warm the index")
        start = time.perf_counter()
        out = self.ok("recall", "the case's past sab")
        took = time.perf_counter() - start
        self.assertIn("global:", out, "the partial word falls back to a prefix that matches")
        self.assertLess(took, 1.0, "the FTS match runs once, not once per indexed row (2.3 s before)")

    def test_recall_all_reaches_other_repos_indexed_here(self):
        other = init_repo(self.tmp / "other", "git@github.com:acme/other.git")
        self.note("fact", "the other repo deploys on fridays", cwd=other)
        self.assertIn("nothing on", self.ok("recall", "fridays"))
        self.assertIn("project:acme/other", self.ok("recall", "fridays", "--all"))

    def test_recall_live_drops_superseded_notes_before_the_limit(self):
        old = self.note("fact", "the port port port is 8080, the default")
        new = self.ok("supersede", old, "the port is 9090").split()[1]
        both = self.ok("recall", "port")
        self.assertIn(f"{old} ", both, "without --live a superseded hit is history, still shown")
        self.assertIn("superseded by", both)
        live = self.ok("recall", "port", "--live", "--limit", "1")
        self.assertIn(f"{new} ", live, "the limit counts live hits only")
        self.assertNotIn(old, live)
        self.assertIn("nothing on", self.ok("recall", "default", "--live"))

    def test_recall_live_reaches_other_repos_with_all(self):
        other = init_repo(self.tmp / "other", "git@github.com:acme/other.git")
        old = self.note("fact", "the other repo deploys on fridays", cwd=other)
        self.ok("supersede", old, "the other repo deploys on mondays", cwd=other)
        self.assertIn(old, self.ok("recall", "deploys", "--all"))
        live = self.ok("recall", "deploys", "--all", "--live")
        self.assertIn("mondays", live)
        self.assertNotIn("fridays", live)

    def test_cwd_is_accepted_before_or_after_the_subcommand(self):
        other = init_repo(self.tmp / "other", "git@github.com:acme/other.git")
        self.note("fact", "the other repo deploys on fridays", cwd=other)
        before = self.ok("--cwd", other, "export")
        after = self.ok("export", "--cwd", other)
        self.assertIn("deploys on fridays", before)
        self.assertEqual(before, after)
        self.assertNotIn("deploys on fridays", self.ok("export"))

    def test_export(self):
        a = self.note("fact", "first")
        self.ok("supersede", a, "second")
        rows = [json.loads(ln) for ln in self.ok("export", "--json").splitlines()]
        self.assertEqual([(r["text"], r["live"]) for r in rows], [("first", False), ("second", True)])
        self.assertIn("superseded by", self.ok("export"))

    def test_the_index_follows_the_files(self):
        ident = self.note("fact", "original wording")
        path = self.store / "notes" / f"{ident}.md"
        path.write_text(path.read_text().replace("original wording", "edited by hand, longer"))
        self.assertIn("edited by hand", self.ok("recall", "edited"))
        self.assertIn("edited by hand", self.wake())
        path.unlink()
        self.assertNotIn("edited by hand", self.wake())
        self.assertIn("nothing on", self.ok("recall", "edited"))

    def test_reindex_and_a_lost_or_corrupt_cache(self):
        self.note("fact", "survives the cache")
        db = self.tmp / "cache" / "tstack" / "memo.db"
        self.assertTrue(db.exists())
        self.assertIn("reindexed project:acme/widget: 1 items", self.ok("reindex"))
        shutil.rmtree(db.parent)
        self.assertIn("survives the cache", self.wake())
        for suffix in ("", "-wal", "-shm"):
            Path(str(db) + suffix).unlink(missing_ok=True)
        db.write_bytes(b"this is not a database" * 100)
        self.assertIn("survives the cache", self.wake())
        self.assertIn("survives the cache", self.ok("recall", "survives"))

    def test_an_unwritable_cache_falls_back_to_the_files(self):
        self.note("fact", "read straight from disk")
        blocked = self.tmp / "blocked"
        blocked.write_text("a file where the cache folder should be")
        env = {"XDG_CACHE_HOME": str(blocked)}
        self.assertIn("read straight from disk", self.wake(env=env))
        self.assertIn("read straight from disk", self.ok("recall", "straight", env=env))
        self.note("fact", "and still writable", env=env)

    def test_doctor(self):
        self.note("fact", "healthy")
        code, out, _ = self.run_memo("doctor")
        self.assertEqual(code, 0, out)
        self.assertIn("memo: healthy", out)
        (self.store / "notes" / "01ARZ3NDEKTSV4RRFFQ69G5FAV.md").write_text("no front block\n")
        code, out, _ = self.run_memo("doctor")
        self.assertEqual(code, 1)
        self.assertIn("FAIL every file parses", out)
        self.assertIn("healthy", self.wake(), "a bad file does not break the wake")

    def test_doctor_warns_on_open_threads_older_than_a_week(self):
        day = 86_400_000

        def aged(days, kind, text, **kw):
            item = memo.Item(id=memo.encode_ulid(memo._now_ms() - days * day, memo._rand80()), kind=kind,
                             text=text, scope="project:acme/widget", **kw)
            memo.atomic_write(self.store / "notes" / f"{item.id}.md", memo.render_item(item))
            return item.id

        stale = aged(8, "open", "the stale thread")
        pinned = aged(9, "open", "the stale pinned thread", pin=True)
        fresh = aged(6, "open", "the fresh thread")
        closed = aged(10, "open", "the closed thread")
        aged(9, "fact", "the closed thread is done", supersedes=[closed])
        aged(30, "fact", "an old fact")
        code, out, _ = self.run_memo("doctor")
        self.assertEqual(code, 0, "a stale thread is a warning, not a problem")
        self.assertIn("memo: healthy", out)
        warned = "\n".join(self.section(out, "warn 2 open threads older than 7 days"))
        self.assertIn(f'memo supersede {stale} "<outcome>"', warned)
        self.assertIn(f'memo supersede {pinned} "<outcome>"', warned)
        for ident in (fresh, closed):
            self.assertNotIn(ident, warned)
        self.assertNotIn("an old fact", warned)
        self.assertIn("the stale thread", self.wake(), "a stale thread is still shown at wake")


class DoctorReportTest(MemoCase):
    def put(self, kind, text, **kw):
        item = memo.Item(id=memo.new_ulid(), kind=kind, text=text, scope="project:acme/widget", **kw)
        memo.atomic_write(self.store / "notes" / f"{item.id}.md", memo.render_item(item))
        return item.id

    def doctor(self):
        code, out, _ = self.run_memo("doctor")
        self.assertEqual(code, 0, "the reports change nothing about health: " + out)
        self.assertIn("memo: healthy", out)
        return out

    def test_overlapping_live_notes_are_listed_highest_first(self):
        a = self.put("fact", "the build cache lives in ~/.cache/widget and survives a reboot")
        self.put("fact", "the gateway retries a request three times")
        b = self.put("gotcha", "the build cache lives in ~/.cache/widget and is wiped on reboot")
        c = self.put("fact", "deploys wait for the Friday freeze to lift")
        d = self.put("decision", "deploys wait for the Friday freeze to lift")
        old = self.put("fact", "the build cache lives in ~/.cache/widget and survives a reboot")
        self.put("fact", "the cache note was wrong", supersedes=[old])
        self.assertEqual(self.section(self.doctor(), "info 2 overlapping"), [
            "info 2 overlapping note pairs (Jaccard of their words >= 0.5), highest first. "
            "Shared words can't tell a duplicate from a contradiction: read both before superseding either.",
            f"  1.00 {c} deploys wait for the Friday freeze to lift",
            f"       {d} deploys wait for the Friday freeze to lift",
            f"  0.62 {a} the build cache lives in ~/.cache/widget and survives a reboot",
            f"       {b} the build cache lives in ~/.cache/widget and is wiped on reboot",
        ])

    def test_the_overlap_report_shows_twenty_pairs_and_counts_the_rest(self):
        for kind in ("fact", "gotcha", "decision", "preference", "open", "fact", "gotcha"):
            self.put(kind, "the release train leaves on Thursday")
        report = self.section(self.doctor(), "info 21 overlapping note pairs")
        self.assertEqual(len(report), 1 + 2 * 20 + 1)
        self.assertEqual(report[-1], "  1 more")

    def test_notes_naming_a_landed_hash_or_a_landing_word_are_listed_for_review(self):
        hashed = self.put("fact", "the retry fix is in e00b668 on master")
        landed = self.put("fact", "the gateway timeout change Landed on Tuesday")
        for text in ("the widget id is 1234567", "the facade wraps a decade of feedback", "python 3.12 is enough",
                     "note 01ARZ3NDEKTSV4RRFFQ69G5FAV covers it", "the host is 10.0.0.12 on the lab net",
                     "the man pages say nothing", "pin ruff to 0.6.9 until the config migrates; v1.2.0 broke it"):
            self.put("fact", text)
        old = self.put("fact", "deployed the old build")
        self.put("fact", "the old build is gone", supersedes=[old])
        self.assertEqual(self.section(self.doctor(), "info 2 notes"), [
            "info 2 notes carry a commit hash or a landing word. A review list, not a removal list: "
            "a hash is often a lesson's evidence; supersede a note only when its point is now in the code.",
            f"  {hashed} the retry fix is in e00b668 on master",
            f"  {landed} the gateway timeout change Landed on Tuesday",
        ])

    def test_the_overlap_index_finds_every_pair_the_all_pairs_loop_finds(self):
        vocab = "the a cache build deploy freeze widget gateway reboot lift wait retry pin note store".split()
        only = os.environ.get("MEMO_OVERLAP_SEED")
        for seed in [int(only)] if only else range(200):
            rng = random.Random(seed)
            notes = [memo.Item(id=memo.encode_ulid(n, 0), kind="fact",
                               text=" ".join(rng.choices(vocab, k=rng.randint(0, 9))))
                     for n in range(rng.randint(2, 14))]
            floor = rng.choice([0.3, 0.5, 0.7, 1.0])
            want = []
            for i, a in enumerate(notes):
                for b in notes[i + 1:]:
                    sa, sb = set(a.text.split()), set(b.text.split())
                    if sa and sb and len(sa & sb) >= floor * len(sa | sb):
                        want.append((a.id, b.id))
            got = [(a.id, b.id) for _, a, b in memo.overlapping(notes, floor)]
            self.assertEqual(sorted(got), sorted(want), f"seed {seed} (replay: MEMO_OVERLAP_SEED={seed})")

    def test_a_pair_at_exactly_the_floor_is_found_when_the_floor_is_not_exact_in_binary(self):
        words = [f"w{i}" for i in range(100)]
        notes = [memo.Item(id=memo.encode_ulid(n, 0), kind="fact", text=" ".join(ws))
                 for n, ws in enumerate([words, words[:55]])]
        self.assertEqual([round(j, 2) for j, _, _ in memo.overlapping(notes, 0.55)], [0.55])


class ImportTest(MemoCase):
    HEADER = "date\tkind\tpin\ttext\tsources\n"

    def tsv(self, *rows, name="notes.tsv", comment="# repo: /somewhere\n"):
        path = self.tmp / name
        path.write_text(comment + self.HEADER + "".join("\t".join(r) + "\n" for r in rows))
        return path

    def items(self, store=None):
        store = store or self.store
        return [memo.parse_item(p.read_text(), p.stem) for p in sorted((store / "notes").glob("*.md"))]

    ROWS = [
        ("2026-08-26", "decision", "", "Skills ship through the plugin, not skills.sh", "obs:1281,sum:45"),
        ("2026-05-02", "preference", "yes", "Commands for Luiz are nushell", "sum:12"),
        ("2026-07-25", "gotcha", "", "Second on the 25th in file order", "obs:6627"),
        ("2026-07-25", "open", "", "First? no: file order within a day is kept", ""),
    ]

    def test_notes_keep_their_dates_and_sort_by_history(self):
        self.note("fact", "written today")
        out = self.ok("import", self.tsv(*self.ROWS))
        self.assertIn("4 imported, 0 already present", out)
        self.assertNotIn("then run: memo summarize", out)
        items = self.items()
        self.assertEqual([i.at for i in items],
                         ["2026-05-02T12:00:00Z", "2026-07-25T12:00:00Z", "2026-07-25T12:00:00Z",
                          "2026-08-26T12:00:00Z", items[-1].at])
        self.assertEqual(items[-1].text, "written today", "imported history sorts before today's notes")
        self.assertEqual([memo.ulid_date(i.id) for i in items[:4]], ["2026-05-02", "2026-07-25", "2026-07-25", "2026-08-26"])
        self.assertEqual(memo.ulid_ms(items[0].id) % 86_400_000, 12 * 3_600_000, "noon UTC")
        self.assertEqual(items[1].text, "Second on the 25th in file order", "file order within a day")
        self.assertEqual(items[3].refs, ["claude-mem:obs:1281", "claude-mem:sum:45"])
        self.assertTrue(items[0].pin)
        wake = self.wake()
        self.assertIn("## Pinned", wake)
        self.assertIn("## Open threads", wake)
        self.assertLess(wake.index("Skills ship through"), wake.index("written today"))

    def test_reimport_writes_nothing_new(self):
        path = self.tsv(*self.ROWS)
        self.ok("import", path)
        before = sorted(p.name for p in self.store.rglob("*.md"))
        out = self.ok("import", path)
        self.assertIn("0 imported, 4 already present", out)
        self.assertEqual(sorted(p.name for p in self.store.rglob("*.md")), before)
        grown = self.tsv(*self.ROWS, ("2026-09-01", "fact", "", "one more line", ""), name="grown.tsv")
        self.assertIn("1 imported, 4 already present", self.ok("import", grown))

    def test_every_bad_line_is_reported_and_nothing_imported(self):
        path = self.tsv(
            ("2026-01-01", "fact", "", "a good line", "obs:1"),
            ("2026-13-01", "fact", "", "month thirteen", ""),
            ("2026-1-5", "story", "maybe", "three problems", ""),
            ("2026-01-02", "fact", "", "a tab\tinside", ""),
            ("2026-01-03", "fact", "", "x" * 281, ""),
            ("2026-01-04", "fact", "", "token: abcdefghijklmnop", ""),
            ("2026-01-05", "fact", "", "odd sources", "obs 1"),
            ("2026-01-01", "fact", "", "a good line", "sum:2"),
            ("2026-01-06", "fact", "", "  ", ""),
        )
        code, out, err = self.run_memo("import", path)
        self.assertEqual(code, 2)
        for line, why in [(4, "is not YYYY-MM-DD"), (5, "kind 'story'"), (5, "pin 'maybe'"), (6, "a tab inside"),
                          (7, "281 characters, 1 over the 280 limit"), (8, "secret"), (9, "sources obs 1"), (10, "same date and text as line 3"),
                          (11, "empty")]:
            self.assertRegex(err, rf"line {line}: .*{re.escape(why)}")
        self.assertIn("8 bad line(s)", err)
        self.assertNotIn("line 3:", err)
        self.assertFalse(self.store.exists(), "nothing was written")

    def test_header_is_required(self):
        path = self.tmp / "noheader.tsv"
        path.write_text("2026-01-01\tfact\t\ttext\t\n")
        code, _, err = self.run_memo("import", path)
        self.assertEqual(code, 2)
        self.assertIn("header", err)
        path.write_text("# only a comment\n")
        self.assertIn("no header", self.run_memo("import", path)[2])
        self.assertEqual(self.run_memo("import", self.tmp / "missing.tsv")[0], 2)

    def test_dry_run_writes_nothing_and_counts_the_wake(self):
        code, out, _ = self.run_memo("import", self.tsv(*self.ROWS), "--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual(out.count("would write "), 4)
        self.assertIn("4 to import", out)
        self.assertIn("wake would be 12 lines here, 7 of them for project:acme/widget (budget 120)", out)
        self.assertFalse(self.store.exists())
        self.assertEqual(len(self.wake().splitlines()), 5)
        self.ok("import", self.tsv(*self.ROWS))
        self.assertEqual(len(self.wake().splitlines()), 12, "the dry run counted the wake right")

    def test_pins_and_threads_past_half_the_budget_are_refused_with_the_count(self):
        env = {"MEMO_PROJECT_LINES": "10"}
        self.note("preference", "an existing rule", "--pin", env=env)
        rows = [(f"2026-02-0{n}", "open" if n % 2 else "preference", "" if n % 2 else "yes", f"item {n}", "")
                for n in range(1, 6)]
        code, _, err = self.run_memo("import", self.tsv(*rows), env=env)
        self.assertEqual(code, 2)
        self.assertIn("5 pins and open threads", err)
        self.assertIn("plus the 1 already", err)
        self.assertIn("make 6", err)
        self.assertEqual(len(self.files()), 1)
        self.ok("import", self.tsv(*rows[:4]), env=env)

    def test_over_budget_says_how_many_summaries_are_needed(self):
        env = {"MEMO_PROJECT_LINES": "20", "MEMO_BUCKET": "4"}
        rows = [(f"2026-03-{n:02d}", "fact", "", f"imported fact {n}", "") for n in range(1, 31)]
        out = self.ok("import", self.tsv(*rows), env=env)
        self.assertRegex(out, r"needs about \d+ summaries of 4 items: 30 lines of notes for 19 lines of room")
        self.assertNotIn("then run: memo summarize", out, "an import hands out no task")
        self.assertEqual(len(self.files("summaries")), 0, "nothing is summarized automatically")
        self.assertIn("compaction task", self.ok("note", "fact", "the next note hands out a task", env=env))

    def test_global_and_cwd(self):
        nowhere = self.tmp / "nowhere"
        nowhere.mkdir()
        out = self.ok("import", self.tsv(*self.ROWS), "--global", cwd=nowhere)
        self.assertIn("global: 4 imported", out)
        self.assertEqual(len(self.items(self.global_dir)), 4)
        self.assertFalse(self.store.exists())
        self.ok("import", self.tsv(*self.ROWS[:1]), "--cwd", self.repo, cwd=nowhere)
        self.assertEqual([i.text for i in self.items()], [self.ROWS[0][3]])

    def test_a_worker_may_dry_run_but_not_import(self):
        worker = {"TSTACK_ROLE": "worker"}
        self.assertEqual(self.run_memo("import", self.tsv(*self.ROWS), "--dry-run", env=worker)[0], 0)
        self.assertEqual(self.run_memo("import", self.tsv(*self.ROWS), env=worker)[0], 3)
        self.assertFalse(self.store.exists())


class TwoMachinesTest(MemoCase):
    """Two copies of a store, written apart, merged by copying files (what a jj or git merge does)."""

    ENV = {"MEMO_PROJECT_LINES": "14", "MEMO_BUCKET": "4", "MEMO_QUIET": "1"}

    def merge(self, a, b):
        for src, dst in ((a, b), (b, a)):
            shutil.copytree(src / ".tstack", dst / ".tstack", dirs_exist_ok=True)

    def test_interleaved_notes_and_overlapping_summaries_stay_correct(self):
        a = self.repo
        b = init_repo(self.tmp / "machine-b", self.ORIGIN)
        shared = [self.note("fact", f"shared {n}", env=self.ENV) for n in range(6)]
        self.merge(a, b)

        # Apart: each machine notes, corrects and summarizes on its own.
        a_ids, b_ids = [], []
        for n in range(4):  # interleaved in time
            a_ids.append(self.note("fact", f"from a {n}", cwd=a, env=self.ENV))
            b_ids.append(self.note("fact", f"from b {n}", cwd=b, env=self.ENV))
        self.ok("supersede", shared[5], "shared 5, corrected on a", cwd=a, env=self.ENV)
        thread = self.note("open", "thread opened on b", cwd=b, env=self.ENV)
        self.ok("summarize", *shared[:4], "a summarized shared 0-3", cwd=a, env=self.ENV)
        self.ok("summarize", *shared[:5], "b summarized shared 0-4", cwd=b, env=self.ENV)
        self.ok("summarize", *b_ids[:2], "b summarized its first two", cwd=b, env=self.ENV)

        self.merge(a, b)
        wake_a, wake_b = self.wake(cwd=a, env=self.ENV), self.wake(cwd=b, env=self.ENV)
        self.assertEqual(wake_a, wake_b, "both machines read the same memory after the merge")
        self.assertEqual(self.files(store=a / ".tstack/memo"), self.files(store=b / ".tstack/memo"))
        self.assertEqual(len(self.files("summaries")), 3, "overlapping summaries are both kept")

        self.assertIn("b summarized shared 0-4", wake_a, "the summary covering more is the one in effect")
        self.assertNotIn("a summarized shared 0-3", wake_a)
        self.assertIn("b summarized its first two", wake_a)
        self.assertIn("thread opened on b", wake_a)
        self.assertIn("shared 5, corrected on a", wake_a)
        self.assertNotRegex(wake_a, r"shared 5 \(", "the superseded note is gone on both")
        for n in range(5):
            self.assertNotIn(f"] shared {n} (", wake_a)
        for n in range(4):
            self.assertIn(f"from a {n}", wake_a)
        self.assertNotIn("from b 0", wake_a)
        self.assertIn("from b 3", wake_a)
        order = [wake_a.index(f"from {m} {n}") for n in (2, 3) for m in "ab"]
        self.assertEqual(order, sorted(order), "notes of two machines interleave by time")

        for machine in (a, b):
            code, out, _ = self.run_memo("doctor", cwd=machine, env=self.ENV)
            self.assertEqual(code, 0, out)
            self.assertIn("1 overlapping summaries kept but not in effect", out)

        # After the merge a summary of the ids the losing summary covered is refused,
        # and the next bucket offered holds only what no summary covers.
        code, out, _ = self.run_memo("summarize", shared[0], shared[1], "again", cwd=a,
                                     env={**self.ENV, "MEMO_QUIET": ""})
        self.assertEqual(code, 2)
        self.assertIn("already summarized", out)
        self.ok("supersede", thread, "thread closed on a", cwd=a, env=self.ENV)
        self.merge(a, b)
        self.assertNotIn("thread opened on b", self.wake(cwd=b, env=self.ENV))


class ConcurrencyTest(MemoCase):
    def test_processes_noting_at_once_each_land_and_the_index_agrees(self):
        n = 16
        env = {**os.environ, **self.env, "MEMO_QUIET": "1"}

        def one(i):
            return subprocess.run([sys.executable, str(SCRIPT), "note", "fact", f"concurrent note {i}"],
                                  cwd=self.repo, env=env, capture_output=True, text=True)

        with ThreadPoolExecutor(n) as pool:
            results = list(pool.map(one, range(n)))
        for r in results:
            self.assertEqual(r.returncode, 0, r.stderr)
        ids = [r.stdout.split()[1] for r in results]
        self.assertEqual(len(set(ids)), n)
        self.assertEqual(self.files(), sorted(f"{i}.md" for i in ids))
        done = subprocess.run([sys.executable, str(SCRIPT), "doctor"], cwd=self.repo, env=env,
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn(f"index matches the files ({n} indexed, {n} on disk)", done.stdout)
        rows = self.ok("export", "--json").splitlines()
        self.assertEqual(sorted(json.loads(r)["text"] for r in rows), sorted(f"concurrent note {i}" for i in range(n)))
        self.assertEqual(len(self.ok("recall", "concurrent", "--limit", "50").splitlines()), n)

    def test_readers_and_writers_together(self):
        env = {**os.environ, **self.env, "MEMO_QUIET": "1"}

        def one(i):
            args = ["note", "fact", f"mixed {i}"] if i % 2 else ["wake"]
            return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=self.repo, env=env,
                                  capture_output=True, text=True)

        with ThreadPoolExecutor(12) as pool:
            results = list(pool.map(one, range(24)))
        self.assertEqual([r.returncode for r in results], [0] * 24, [r.stderr for r in results if r.returncode])
        self.assertEqual(len(self.files()), 12)
        for i in range(1, 24, 2):
            self.assertIn(f"mixed {i} ", self.wake())


class ModelTest(MemoCase):
    """Rung 5: random sequences of note, supersede, pin, summarize and wake against a
    trivial in-memory model. Every wake must stay within budget, show no superseded
    note, show every pin and open thread, and read the same after a reindex."""

    RUNS = int(os.environ.get("MEMO_MODEL_RUNS", "25"))
    STEPS = 70
    P_LINES, G_LINES, BUCKET = 16, 8, 4

    def setUp(self):
        super().setUp()
        self.real_clock, self.real_rand = memo._now_ms, memo._rand80
        self.addCleanup(self.restore)

    def restore(self):
        memo._now_ms, memo._rand80 = self.real_clock, self.real_rand
        memo._last_ulid[:] = [0, 0]

    def test_random_sequences(self):
        only = os.environ.get("MEMO_MODEL_SEED")
        seeds = [int(only)] if only else range(self.RUNS)
        for seed in seeds:
            log = []
            try:
                self.sequence(seed, log)
            except Exception as e:
                raise AssertionError(
                    f"model-based test failed with seed {seed} after {len(log)} steps "
                    f"(replay: MEMO_MODEL_SEED={seed}): {e}\n" + "\n".join(log[-12:])) from e

    def sequence(self, seed, log):
        rng = random.Random(seed)
        tick = [1_800_000_000_000]

        def clock():
            tick[0] += rng.choice((0, 1, 1, 7, 86_400_000))  # same millisecond, soon after, a day later
            return tick[0]

        memo._now_ms, memo._rand80 = clock, lambda: rng.getrandbits(80)
        memo._last_ulid[:] = [0, 0]
        for d in (self.repo / ".tstack", self.tmp / "data", self.tmp / "cache"):
            shutil.rmtree(d, ignore_errors=True)
        env = {"MEMO_PROJECT_LINES": str(self.P_LINES), "MEMO_GLOBAL_LINES": str(self.G_LINES),
               "MEMO_BUCKET": str(self.BUCKET)}
        # The model: per store, the notes (kind, pin, dead) and which ids a summary covers.
        model = {g: {"notes": {}, "covered": set(), "summaries": {}, "task": None} for g in (False, True)}
        counter = [0]

        def text():
            counter[0] += 1
            return f"t{counter[0]}x " + " ".join(rng.choice(("alpha", "beta", "gamma", "delta")) for _ in range(3))

        def run(*args):
            code, out, err = self.run_memo(*args, env=env)
            log.append(f"  memo {' '.join(map(str, args))} -> {code} {(out + err).strip().splitlines()[:1]}")
            return code, out, err

        def held(m):  # lines that pins and open threads hold at wake
            return sum(1 for n in m["notes"].values() if not n["dead"] and (n["pin"] or n["kind"] == "open"))

        def cap(g):
            return (self.G_LINES if g else self.P_LINES) // 2

        def wrote(g, out, kind, pin, body, supersedes=()):
            m = model[g]
            ident = out.split()[1]
            for old in supersedes:
                m["notes"][old]["dead"] = True
            m["notes"][ident] = {"kind": kind, "pin": pin, "dead": False, "text": body}
            task = [ln for ln in out.splitlines() if ln.startswith("then run: memo summarize")]
            m["task"] = task[0].split()[4:-1] if task else None
            self.assertLessEqual(out.count("memo compaction task"), 1)
            return ident

        def op_note():
            g = rng.random() < 0.2
            kind = rng.choice(("decision", "gotcha", "preference", "fact", "fact", "open"))
            pin = rng.random() < 0.12
            body = text()
            args = ["note", kind, body] + (["--pin"] if pin else []) + (["--global"] if g else [])
            code, out, _ = run(*args)
            if (pin or kind == "open") and held(model[g]) + 1 > cap(g):
                self.assertEqual(code, 2, "pins and open threads past half the budget are refused")
            else:
                self.assertEqual(code, 0)
                wrote(g, out, kind, pin, body)

        def op_supersede():
            g = rng.random() < 0.2
            m = model[g]
            if not m["notes"]:
                return
            old = rng.choice(sorted(m["notes"]))
            was = m["notes"][old]
            body = text()
            kind = "fact" if was["kind"] == "open" else was["kind"]
            code, out, _ = run("supersede", old, body)
            frees = not was["dead"] and (was["pin"] or was["kind"] == "open")
            if was["pin"] and not frees and held(m) + 1 > cap(g):
                self.assertEqual(code, 2, "a second correction of a dead pin is a new pin")
            else:
                self.assertEqual(code, 0, "replacing a live note never needs more room than it held")
                wrote(g, out, kind, was["pin"], body, [old])

        def op_pin():
            g = rng.random() < 0.2
            m = model[g]
            if not m["notes"]:
                return
            ident = rng.choice(sorted(m["notes"]))
            n = m["notes"][ident]
            unpin = rng.random() < 0.4
            code, _, _ = run("pin", ident, *(["--unpin"] if unpin else []))
            grows = not unpin and not n["pin"] and not n["dead"] and n["kind"] != "open"
            if grows and held(m) + 1 > cap(g):
                self.assertEqual(code, 2)
            else:
                self.assertEqual(code, 0)
                n["pin"] = not unpin

        def op_summarize():
            g = rng.random() < 0.2
            m = model[g]
            if m["task"] and rng.random() < 0.7:  # answer the task memo offered
                ids = m["task"]
                full = [next(k for k in list(m["notes"]) + list(m["summaries"]) if k.endswith(i)) for i in ids]
            else:  # or summarize at will, overlaps included
                level = rng.choice((0, 0, 1))
                pool = sorted(m["notes"]) if level == 0 else sorted(k for k, v in m["summaries"].items() if v == 1)
                if len(pool) < 2:
                    return
                full = rng.sample(pool, rng.randint(2, min(5, len(pool))))
            m["task"] = None
            code, out, _ = run("summarize", *full, text())
            if any(i in m["covered"] for i in full):
                self.assertEqual(code, 2, "an overlapping summary is refused")
                self.assertIn("already summarized", out)
            else:
                self.assertEqual(code, 0)
                m["covered"].update(full)
                m["summaries"][out.split()[4]] = 1 + (m["summaries"].get(full[0], 0))

        def op_wake():
            code, wake, _ = run("wake")
            self.assertEqual(code, 0)
            body = wake.splitlines()[5:]
            cut = next((i for i, ln in enumerate(body) if ln.startswith("## Global")), len(body))
            sections = {False: body[:cut], True: body[cut:]}
            self.assertLessEqual(len(sections[False]), self.P_LINES, "the project section is within its budget")
            self.assertLessEqual(len(sections[True]), self.G_LINES, "the global section is within its budget")
            for g, m in model.items():
                shown = "\n".join(sections[g])
                for ident, n in m["notes"].items():
                    marker = n["text"].split()[0] + " "
                    if n["dead"]:
                        self.assertNotIn(marker, shown, f"superseded note {ident} is shown")
                    elif n["pin"] or n["kind"] == "open":
                        self.assertIn(marker, shown, f"pin or open thread {ident} is missing")
                live = [n for n in m["notes"].values() if not n["dead"]]
                if not m["summaries"] and len(live) + 3 <= (self.G_LINES if g else self.P_LINES):
                    for n in live:
                        self.assertIn(n["text"], shown, "with room to spare every live note is shown")
            for how in ("reindex", "drop"):
                if how == "reindex":
                    self.assertEqual(run("reindex")[0], 0)
                else:
                    shutil.rmtree(self.tmp / "cache", ignore_errors=True)
                self.assertEqual(run("wake")[1], wake, f"the wake changed across a {how} of the index")

        ops = [op_note] * 8 + [op_supersede] * 3 + [op_pin] * 2 + [op_summarize] * 4 + [op_wake] * 2
        for _ in range(self.STEPS):
            rng.choice(ops)()
        op_wake()
        code, out, _ = run("doctor")
        self.assertEqual(code, 0, out)


if __name__ == "__main__":
    unittest.main()
