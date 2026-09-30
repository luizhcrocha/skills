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
import shutil
import subprocess
import sys
import tempfile
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
        self.assertIn("superseded by", self.ok("recall", "8080"))

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

    def test_recall_all_reaches_other_repos_indexed_here(self):
        other = init_repo(self.tmp / "other", "git@github.com:acme/other.git")
        self.note("fact", "the other repo deploys on fridays", cwd=other)
        self.assertIn("nothing on", self.ok("recall", "fridays"))
        self.assertIn("project:acme/other", self.ok("recall", "fridays", "--all"))

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
