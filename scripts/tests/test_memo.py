"""Tests for scripts/memo v2: the rules of docs/design/memo-v2/model.md as properties over random stores, and the
command line against throwaway git repos.

Run: just test-scripts (Hypothesis comes from `uv run --with hypothesis`, as the justfile runs it).
"""

import contextlib
import io
import os
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ProcessPoolExecutor
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
from unittest import mock

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

SCRIPT = Path(__file__).resolve().parent.parent / "memo"


def load_memo():
    sys.dont_write_bytecode = True
    loader = SourceFileLoader("memo_under_test", str(SCRIPT))
    module = module_from_spec(spec_from_loader("memo_under_test", loader))
    loader.exec_module(module)
    return module


memo = load_memo()
SCOPE = memo.Scope("repo", "acme/widget")
WORDS = ["cache", "deploy", "R2", "narinfo", "hook", "statechart", "PreCompact", "nushell", "flake", "ledger",
         "quota", "tile", "paging", "the", "a", "is", "über", "naïve"]


def uid(n):
    return memo.encode_ulid(1_760_000_000_000 + n * 3_600_000, n)


def note(n, text=None, supersedes=()):
    return memo.Note(uid(n), SCOPE, "s/interactive", "", text or f"note {n} about cache", (), tuple(supersedes))


@st.composite
def stores(draw, max_ops=60, base=0, prior=()):
    """A store built by a random run of the four things sessions do: write, summarize a task's group, supersede,
    retire. Summaries are written as `memo summarize` writes them, from next_task, so they are valid by
    construction; a stray overlapping summary stands for a second machine's."""
    recs, n = list(prior), base
    for _ in range(draw(st.integers(1, max_ops))):
        view = memo.View(recs)
        op = draw(st.sampled_from(["note"] * 6 + ["task", "task", "supersede", "retire", "stray"]))
        n += 1
        if op == "note" or not view.live:
            text = " ".join(draw(st.lists(st.sampled_from(WORDS), min_size=1, max_size=40)))[:280]
            recs.append(memo.Note(uid(n), SCOPE, "s", "", f"{text} {n}"))
        elif op == "task":
            slice_bytes = draw(st.sampled_from([1250, 1900, 3000, 6000]))
            t = memo.next_task(view, SCOPE, slice_bytes)
            if t:
                keep = draw(st.lists(st.sampled_from(t.offered), max_size=t.keep_limit, unique=True)) if t.offered else []
                recs.append(memo.Summary(uid(n), SCOPE, "s", "", t.level, tuple(sorted(x.id for x in t.items)),
                                         tuple(sorted(k.id for k in keep))))
        elif op == "supersede":
            old = draw(st.sampled_from(view.live))
            recs.append(memo.Note(uid(n), SCOPE, "s", "", f"corrected {n}", (), (old.id,)))
        elif op == "retire":
            pool = view.live + view.summaries
            recs.append(memo.Retirement(uid(n), SCOPE, "s", "", "why", (draw(st.sampled_from(pool)).id,)))
        else:
            ids = draw(st.lists(st.sampled_from([x.id for x in view.live]), min_size=2, max_size=12, unique=True)) \
                if len(view.live) >= 2 else []
            if ids:
                keep = draw(st.lists(st.sampled_from(ids), max_size=3, unique=True))
                recs.append(memo.Summary(uid(n), SCOPE, "s", "", 1, tuple(sorted(ids)), tuple(sorted(keep))))
    return recs


SLICES = st.sampled_from([600, 1250, 1900, 2500, 3000, 6000])
PROPS = settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow])


def shown(view, sec):
    """(notes read word for word, summaries shown) of a section."""
    read, counted = set(), []
    for i in sec.items:
        x = view.by_id[i]
        if isinstance(x, memo.Note):
            read.add(i)
        else:
            counted.append(x)
            read.update(k.id for k in view.kept(x))
    lines = {memo.note_line(view.by_id[i]) for i in read}
    assert lines <= set(sec.lines), "an item the section names is not printed"
    return read, counted


class SelectRules(unittest.TestCase):
    """model.md's rules for one store, in bytes, on random stores."""

    @PROPS
    @given(stores(), SLICES)
    def test_within_budget(self, recs, sl):
        sec = memo.select(memo.View(recs), SCOPE, sl)
        self.assertLessEqual(len(sec.text().encode()), sl)

    @PROPS
    @given(stores(), SLICES)
    def test_only_live_notes_word_for_word(self, recs, sl):
        view = memo.View(recs)
        live = {memo.note_line(n) for n in view.live}
        for line in memo.select(view, SCOPE, sl).lines[1:]:
            if line.startswith("- "):
                self.assertIn(line, live)

    @PROPS
    @given(stores(), SLICES)
    def test_never_twice_and_accounted(self, recs, sl):
        view = memo.View(recs)
        sec = memo.select(view, SCOPE, sl)
        read, counted = shown(view, sec)
        told = list(read)
        for s in counted:
            kept = {k.id for k in view.kept(s)}
            told += [n.id for n in view.leaves(s) if n.id not in kept]
        self.assertEqual(len(told), len(set(told)), "a live note is told twice")
        if not sec.over:
            self.assertEqual(set(told), view.live_ids, "a live note is neither read nor counted")
        else:
            self.assertEqual(len(view.live_ids) - len(set(told)), sec.left_out)

    @PROPS
    @given(stores(), st.sampled_from([1900, 2500, 3000, 6000]))
    def test_newest_word_for_word(self, recs, sl):
        view = memo.View(recs)
        free = [n for n in view.live if n.id not in view.covered_by]
        if free:
            self.assertIn(memo.note_line(free[-1]), memo.select(view, SCOPE, sl).lines)

    @PROPS
    @given(stores(), SLICES)
    def test_kept_notes_stay(self, recs, sl):
        view = memo.View(recs)
        sec = memo.select(view, SCOPE, sl)
        if not sec.over:
            return
        read, counted = shown(view, sec)
        lines = memo._Lines(view)
        loose = sorted((x for x in view.cover() if isinstance(x, memo.Note)), key=lambda n: n.id, reverse=True)
        over = memo.OVER_LINE.format(n=len(view.live))
        avail = sl - len(memo.heading(SCOPE).encode()) - len(over.encode()) - 1
        reserve = min(avail, max(sl // 4, lines.cost(loose[0]))) if loose else 0
        head = {n.id for n in memo._suffix(loose, reserve, lines.cost)}
        own = {i for i in read if i not in view.covered_by}
        if own - head:
            roots = {x.id for x in view.cover() if isinstance(x, memo.Summary)}
            self.assertLessEqual(roots, {s.id for s in counted})

    @PROPS
    @given(stores())
    def test_no_broken_summary_in_effect(self, recs):
        view = memo.View(recs)
        for s in view.in_effect:
            self.assertNotIn(s.id, view.out)
            for c in s.covers:
                r = view.by_id.get(c)
                if isinstance(r, memo.Summary):
                    self.assertNotIn(c, view.out)

    @PROPS
    @given(stores(), SLICES)
    def test_hint_words_come_from_hidden_notes(self, recs, sl):
        view = memo.View(recs)
        for s in view.in_effect:
            kept = {k.id for k in view.kept(s)}
            hidden = [n for n in view.leaves(s) if n.id not in kept]
            for w in memo.hint_words(view, hidden):
                self.assertTrue(any(w in memo.hint_tokens(n.text).values() for n in hidden), w)

    @PROPS
    @given(st.data(), SLICES)
    def test_union_of_two_stores_holds_every_rule_and_reads_alike(self, data, sl):
        """Two machines share some files, then each writes its own (summaries over the shared notes included);
        their union by file name is a valid store, and any order of the same files gives the same read."""
        shared = data.draw(stores(max_ops=30))
        a = data.draw(stores(max_ops=30, base=1000, prior=shared))
        b = data.draw(stores(max_ops=30, base=2000, prior=shared))
        union = list({r.id: r for r in a + b}.values())
        one = memo.select(memo.View(union), SCOPE, sl)
        two = memo.select(memo.View(list(reversed(union))), SCOPE, sl)
        self.assertEqual(one, two)
        self.assertLessEqual(len(one.text().encode()), sl)
        view = memo.View(union)
        read, counted = shown(view, one)
        told = list(read) + [n.id for s in counted for n in view.leaves(s) if n not in view.kept(s)]
        self.assertEqual(len(told), len(set(told)))

    @PROPS
    @given(stores(max_ops=120), st.sampled_from([1250, 1900, 3000, 6000]), st.randoms(use_true_random=False))
    def test_answering_every_task_brings_the_cover_inside(self, recs, sl, rnd):
        recs = list(recs)
        for i in range(400):
            view = memo.View(recs)
            t = memo.next_task(view, SCOPE, sl)
            if t is None:
                break
            keep = rnd.sample(list(t.offered), min(t.keep_limit, len(t.offered)))
            recs.append(memo.Summary(uid(10_000 + i), SCOPE, "s", "", t.level, tuple(sorted(x.id for x in t.items)),
                                     tuple(sorted(k.id for k in keep))))
        self.assertTrue(memo.fits(memo.View(recs), SCOPE, sl))


class RecordFiles(unittest.TestCase):
    def test_round_trip_of_each_record(self):
        for r in (memo.Note(uid(1), SCOPE, "s/x", "t", "a line", ("a.py",), (uid(0),)),
                  memo.Retirement(uid(2), memo.Scope("user"), "s", "t", "status", (uid(1),)),
                  memo.Summary(uid(3), memo.Scope("group", "tooling"), "s", "t", 2, (uid(1), uid(2)), (uid(1),))):
            self.assertEqual(memo.parse_record(memo.FOLDER_OF[type(r)], memo.render_record(r), r.id), r)

    def test_old_files_read_as_they_are(self):
        old_note = f'+++\nid = "{uid(1)}"\nkind = "open"\npin = true\nscope = "project:acme/widget"\nby = "s"\nat = "t"\n+++\nan open thread\n'
        n = memo.parse_record("notes", old_note, uid(1))
        self.assertEqual((n.scope, n.text), (SCOPE, "an open thread"))
        old_sum = f'+++\nid = "{uid(2)}"\nkind = "summary"\nscope = "global"\nlevel = 1\ncovers = ["{uid(1)}"]\n+++\nrewritten\n'
        s = memo.parse_record("summaries", old_sum, uid(2))
        self.assertEqual((s.keeps, s.old_text, s.scope), (None, "rewritten", memo.Scope("user")))
        self.assertEqual(memo.View([n, s]).in_effect, [], "an old summary is never in effect")

    def test_a_file_whose_name_is_not_its_id_is_refused(self):
        with self.assertRaises(ValueError):
            memo.parse_record("notes", memo.render_record(note(1)), uid(2))


class Groups(unittest.TestCase):
    def test_two_groups_at_most_by_name(self):
        gs = memo.parse_groups('[groups.b]\nrepos=["x/y"]\n[groups.a]\nrepos=["X/Y"]\n[groups.c]\nrepos=["x/y"]\n')
        read, out = memo.groups_of("x/y", gs)
        self.assertEqual(([g.name for g in read], [g.name for g in out]), (["a", "b"], ["c"]))
        self.assertEqual(memo.slice_of(memo.Scope("group", "a"), 2), 1250)

    def test_a_broken_file_is_no_groups(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "g.toml").write_text("[groups")
            self.assertEqual(memo.load_groups(Path(d) / "g.toml"), {})


def sh(cwd, *args):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class CliCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.env = {"HOME": str(self.tmp / "home"), "XDG_DATA_HOME": str(self.tmp / "data"),
                    "XDG_CACHE_HOME": str(self.tmp / "cache"), "XDG_STATE_HOME": str(self.tmp / "state"),
                    "XDG_CONFIG_HOME": str(self.tmp / "cfg"), "PATH": os.environ.get("PATH", ""),
                    "CLAUDE_CODE_SESSION_ID": "sess-test"}
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        sh(self.repo, "git", "init", "-q")
        sh(self.repo, "git", "remote", "add", "origin", "git@github.com:Acme/Widget.git")
        memo._repo_cache.clear()

    def configure(self, machine="box", groups=True):
        cfg = self.tmp / "cfg" / "tstack"
        cfg.mkdir(parents=True, exist_ok=True)
        (cfg / "memo.toml").write_text(f'machine = "{machine}"\nhome_remote = "git@github.com:me/dotfiles"\n')
        if groups:
            (cfg / "groups.toml").write_text('[groups.tooling]\nabout = "t"\nrepos = ["acme/widget", "acme/gadget"]\n')

    def run_memo(self, *args, env=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err):
            code = memo.main(list(args), env=env or self.env, cwd=str(self.repo), out=out)
        return code, out.getvalue(), err.getvalue()


class Writing(CliCase):
    def test_a_note_lands_in_the_home_store_in_its_subfolder(self):
        code, out, _ = self.run_memo("note", "the index is a cache of the files")
        self.assertEqual(code, 0, out)
        ident = out.split()[1]
        self.assertTrue((self.tmp / "data/tstack/memo/home/repo/acme/widget/notes" / ident[:4] / f"{ident}.md").is_file())
        self.assertFalse((self.repo / ".tstack").exists(), "no note in the working tree")
        self.assertEqual(self.run_memo("note", "the index is a cache of the files")[1].split()[:2], ["already", "noted"])

    def test_refusals_are_length_secret_role_and_usage_only(self):
        self.assertEqual(self.run_memo("note", "x" * 281)[0], 2)
        self.assertEqual(self.run_memo("note", "token: abcdefgh12345")[0], 2)
        self.assertEqual(self.run_memo("note", "fine", env={**self.env, "TSTACK_ROLE": "worker"})[0], 3)
        code, _, err = self.run_memo("note", "gotcha", "the old form")
        self.assertEqual(code, 2)
        self.assertIn('memo note "the old form"', err)
        log = (self.tmp / "state/tstack/memo/refusals.log").read_text().split("\n")
        self.assertEqual({row.split("\t")[2] for row in log if row}, {"length", "secret"})

    def test_no_write_is_refused_for_space(self):
        for i in range(120):
            self.assertEqual(self.run_memo("note", f"fact {i}: the tile renderer pages {i} overlays above the map")[0], 0)
        _, out, _ = self.run_memo("note", "one more fact about the widget quota")
        self.assertIn("memo task:", out)

    def test_scopes(self):
        self.assertEqual(self.run_memo("note", "--scope", "machine", "x")[0], 2, "no memo.toml, no machine scope")
        self.configure()
        _, out, _ = self.run_memo("note", "--scope", "user", "Luiz reads a design as a page first")
        self.assertIn("every session in every repo", out)
        _, out, _ = self.run_memo("note", "--scope", "group", "fleet state re-renders the page on every command")
        self.assertIn("group:tooling", out)
        code, _, err = self.run_memo("note", "--scope", "repo:acme/gadget", "x")
        self.assertEqual(code, 2)
        self.assertIn("tooling", err)
        (self.tmp / "data/tstack/memo/home/repo/acme/gadget").mkdir(parents=True)
        _, out, _ = self.run_memo("note", "--scope", "repo:acme/gadget", "gadget fact")
        self.assertIn("This session does not", out)
        start = memo.start_text(self.env, str(self.repo))
        self.assertIn("## Group tooling", start)
        self.assertNotIn("no machine scope", start)
        self.assertNotIn("gadget fact", start)

    def test_status_advice_and_retire_and_supersede(self):
        _, out, _ = self.run_memo("note", "The widget deploy landed as 4ccb1e90")
        self.assertIn("reads as status", out)
        ident = out.split()[1]
        self.assertEqual(self.run_memo("retire", ident[-6:], "status")[0], 0)
        self.assertNotIn("4ccb1e90", memo.start_text(self.env, str(self.repo)))
        _, out, _ = self.run_memo("recall", "widget", "deploy")
        self.assertIn("retired: status", out)
        _, out, _ = self.run_memo("note", "the quota is 10 per day")
        _, out2, _ = self.run_memo("supersede", out.split()[1], "the quota is 20 per day")
        self.assertIn("superseding", out2)
        start = memo.start_text(self.env, str(self.repo))
        self.assertIn("20 per day", start)
        self.assertNotIn("10 per day", start)

    def test_concurrent_writers_make_one_file_each_and_a_consistent_index(self):
        with ProcessPoolExecutor(8) as pool:
            codes = list(pool.map(_write_one, [(str(SCRIPT), self.env, str(self.repo), i) for i in range(24)]))
        self.assertEqual(codes, [0] * 24)
        names = memo.list_names(self.tmp / "data/tstack/memo/home/repo/acme/widget")
        self.assertEqual(len(names), 24)
        m = memo.Memo(self.env, str(self.repo))
        self.assertEqual(len(m.view(m.session.repo).live), 24)
        m.index.close()


def _write_one(args):
    script, env, cwd, i = args
    return subprocess.run([sys.executable, script, "--cwd", cwd, "note", f"parallel fact {i} {os.getpid()}"],
                          env=env, capture_output=True, check=False).returncode


class StartRead(CliCase):
    def test_legacy_stores_are_read_until_migrated(self):
        legacy = self.repo / ".tstack/memo/notes"
        legacy.mkdir(parents=True)
        (legacy / f"{uid(5)}.md").write_text(
            f'+++\nid = "{uid(5)}"\nkind = "gotcha"\nscope = "project:acme/widget"\nby = "s"\nat = "t"\n+++\nold gotcha\n')
        self.assertIn("old gotcha", memo.start_text(self.env, str(self.repo)))
        home = self.tmp / "data/tstack/memo/home/repo/acme/widget"
        home.mkdir(parents=True)
        (home / memo.MIGRATED).write_text("")
        self.assertNotIn("old gotcha", memo.start_text(self.env, str(self.repo)))

    def test_a_worker_reads_nothing(self):
        self.run_memo("note", "x marks the spot")
        self.assertEqual(memo.start_text({**self.env, "TSTACK_ROLE": "worker"}, str(self.repo)), "")

    def test_no_stat_of_a_record_and_no_process_at_start(self):
        store = self.tmp / "data/tstack/memo/home/repo/acme/widget"
        for i in range(4000):
            r = note(i, f"note {i} about {WORDS[i % len(WORDS)]} and {WORDS[(i * 7) % len(WORDS)]}")
            memo.atomic_write(memo.Store(SCOPE, store).path_of("notes", r.id), memo.render_record(r))
        memo.start_text(self.env, str(self.repo))
        real_stat = os.stat
        stats = []

        def counting_stat(path, *a, **k):
            if str(path).endswith(".md"):
                stats.append(path)
            return real_stat(path, *a, **k)

        def no_process(*a, **k):
            raise AssertionError("the start read started a process")

        with mock.patch("os.stat", counting_stat), mock.patch("subprocess.Popen", no_process), \
                mock.patch("subprocess.run", no_process):
            memo._repo_cache.clear()
            text = memo.start_text(self.env, str(self.repo))
        self.assertEqual(stats, [])
        self.assertLessEqual(len(text.encode()), memo.TOTAL)
        self.assertIn("not shown", text)

    @unittest.skipUnless(os.environ.get("MEMO_TIMING"), "MEMO_TIMING=1 times the start read on 42,000 notes")
    def test_time_on_42000_notes(self):
        store = self.tmp / "data/tstack/memo/home/repo/acme/widget"
        for i in range(42000):
            r = note(i, f"note {i} about {WORDS[i % len(WORDS)]} and {WORDS[(i * 7) % len(WORDS)]} in batch {i // 117}")
            p = memo.Store(SCOPE, store).path_of("notes", r.id)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(memo.render_record(r))
        memo.start_text(self.env, str(self.repo))
        runs = []
        for _ in range(5):
            memo._repo_cache.clear()
            t0 = time.perf_counter()
            memo.start_text(self.env, str(self.repo))
            runs.append((time.perf_counter() - t0) * 1000)
        print(f"\nstart read on 42,000 notes: {sorted(runs)} ms", file=sys.stderr)


if __name__ == "__main__":
    unittest.main()
