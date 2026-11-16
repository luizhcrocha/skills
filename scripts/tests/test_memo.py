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
    @given(stores(), SLICES)
    def test_newest_word_for_word(self, recs, sl):
        view = memo.View(recs)
        if view.live:
            self.assertIn(memo.note_line(view.live[-1]), memo.select(view, SCOPE, sl).lines)

    def test_the_newest_note_under_a_summary_is_read_once_after_the_notes_after_it_retire(self):
        """newest.cfg of the model: two summaries side by side, then the newest note retired."""
        recs = [note(i, f"fact {i} " + "about the tile renderer " * 8) for i in range(1, 7)]
        recs.append(memo.Summary(uid(11), SCOPE, "s", "", 1, (uid(1), uid(2), uid(3)), (uid(1), uid(2))))
        recs.append(memo.Summary(uid(12), SCOPE, "s", "", 1, (uid(4), uid(5)), ()))
        recs.append(memo.Retirement(uid(13), SCOPE, "s", "", "status", (uid(6),)))
        view = memo.View(recs)
        for sl in (600, 1250, 1900, 6000):
            sec = memo.select(view, SCOPE, sl)
            self.assertIn(memo.note_line(view.by_id[uid(5)]), sec.lines, sl)
            self.assertFalse(any(ln.startswith("  (+2 notes") for ln in sec.lines), "the newest note is counted")

    @PROPS
    @given(stores(), SLICES)
    def test_kept_notes_stay(self, recs, sl):
        view = memo.View(recs)
        sec = memo.select(view, SCOPE, sl)
        if not sec.over:
            return
        read, counted = shown(view, sec)
        loose = sorted((x for x in view.cover() if isinstance(x, memo.Note)), key=lambda n: n.id, reverse=True)
        head, room = set(loose[:1]), sl // 4
        for n in loose:
            room -= len(memo.note_line(n).encode()) + 1
            if room < 0:
                break
            head.add(n)
        head = {n.id for n in head}
        own = {i for i in read if isinstance(view.by_id[i], memo.Note) and view.by_id[i] in loose}
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



class WritesStayInTheirStore(CliCase):
    def notes_on_disk(self):
        return {str(f.relative_to(self.tmp)) for f in self.tmp.rglob("*.md")}

    def test_a_repo_scope_is_owner_and_name_or_a_local_store(self):
        self.run_memo("note", "seed so the widget store exists")
        before = self.notes_on_disk()
        for bad in ("repo:acme", "repo:..", "repo:../user", "repo:../../../outside", "repo:Acme/Widget",
                    "repo:acme/widget/", "repo:acme//widget", "repo:/no/such/store", "repo:/tmp/../etc"):
            code, _, err = self.run_memo("note", "--scope", bad, f"a fact for {bad}")
            self.assertEqual(code, 2, bad)
            self.assertIn("memo:", err)
        self.assertEqual(self.notes_on_disk(), before)
        self.assertEqual(memo.parse_target_scope(self.env, "repo:acme/widget"), memo.Scope("repo", "acme/widget"))
        for bad in ("repo:../..", "group:nope", "repo:Acme/Widget", "machine:other"):
            with self.assertRaises(memo.Refusal) as e:
                memo.parse_target_scope(self.env, bad)
            self.assertEqual(e.exception.reason, "usage")

    def test_a_correction_of_an_archived_note_lands_in_the_session_store(self):
        _, out, _ = self.run_memo("note", "archived fact about narinfo")
        ident = out.split()[1]
        root = self.tmp / "data/tstack/memo"
        archive = root / "archive/v1-2026-11-16/acme/widget"
        archive.mkdir(parents=True)
        (root / "home/repo/acme/widget/notes").rename(archive / "notes")
        self.run_memo("recall", "narinfo")
        code, out, err = self.run_memo("supersede", ident[-6:], "corrected fact about narinfo")
        self.assertEqual(code, 0, err)
        self.assertEqual(len(list(archive.rglob("*.md"))), 1, "the archive is read only")
        self.assertIn("corrected fact about narinfo", memo.start_text(self.env, str(self.repo)))
        code, _, err = self.run_memo("retire", ident[-6:], "status")
        self.assertEqual(code, 2)
        self.assertIn("archive", err)
        self.assertEqual(len(list(archive.rglob("*.md"))), 1)

    def test_a_correction_of_another_checkouts_legacy_note_never_writes_into_it(self):
        other = self.tmp / "other"
        legacy = other / ".tstack/memo/notes"
        legacy.mkdir(parents=True)
        sh(other, "git", "init", "-q")
        (legacy / f"{uid(5)}.md").write_text(
            f'+++\nid = "{uid(5)}"\nkind = "gotcha"\nscope = "project:{other}"\nby = "s"\nat = "t"\n+++\nlegacy port gotcha\n')
        memo.start_text(self.env, str(other))
        code, _, err = self.run_memo("supersede", uid(5)[-6:], "the legacy port is 9090")
        self.assertEqual(code, 0, err)
        self.assertEqual(len(list(legacy.iterdir())), 1)

    def test_a_ref_goes_through_the_secret_check(self):
        tok = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
        code, _, _ = self.run_memo("note", "the deploy key lives in 1Password", "--ref", tok)
        self.assertEqual(code, 2)
        self.assertFalse(any(tok in f.read_text() for f in self.tmp.rglob("*.md")))
        log = (self.tmp / "state/tstack/memo/refusals.log").read_text()
        self.assertIn("\tsecret\t", log)

    def test_import_checks_every_row_before_it_writes(self):
        tsv = self.tmp / "imp.tsv"
        tsv.write_text("date\ttext\tsources\n2026-01-05\tgood row\t\n2026-02-30\tbad row\t\n")
        code, _, err = self.run_memo("import", str(tsv))
        self.assertEqual(code, 2)
        self.assertIn("line 3", err)
        self.assertEqual(self.notes_on_disk(), set())
        code, _, err = self.run_memo("import", str(self.tmp / "missing.tsv"))
        self.assertEqual((code, "Traceback" in err), (2, False))

    def test_an_imported_note_is_dated_its_day_in_utc(self):
        tsv = self.tmp / "imp.tsv"
        tsv.write_text("date\ttext\tsources\n2026-01-05\tgood row\t\n")
        old = os.environ.get("TZ")
        os.environ["TZ"] = "Pacific/Kiritimati"
        time.tzset()
        try:
            code, out, err = self.run_memo("import", str(tsv))
        finally:
            if old is None:
                os.environ.pop("TZ")
            else:
                os.environ["TZ"] = old
            time.tzset()
        self.assertEqual(code, 0, err)
        self.assertEqual(memo.ulid_date(out.split()[1]), "2026-01-05")


class ReadsSurvive(CliCase):
    @unittest.skipIf(os.geteuid() == 0, "root reads a folder of mode 0")
    def test_an_unreadable_folder_of_one_store_leaves_the_rest_of_the_read(self):
        self.run_memo("note", "--scope", "user", "Luiz reads a design as a page first")
        self.run_memo("note", "the index is a cache of the files")
        bad = next((self.tmp / "data/tstack/memo/home/user/notes").iterdir())
        bad.chmod(0)
        self.addCleanup(bad.chmod, 0o755)
        memo._repo_cache.clear()
        self.assertIn("cache of the files", memo.start_text(self.env, str(self.repo)))
        code, out, err = self.run_memo("doctor")
        self.assertEqual(code, 0, err)
        self.assertIn("cannot be read", out)

    def test_reindex_drops_the_cached_sections(self):
        legacy = self.repo / ".tstack/memo/notes"
        legacy.mkdir(parents=True)
        f = legacy / f"{uid(5)}.md"
        f.write_text(f'+++\nid = "{uid(5)}"\nkind = "gotcha"\nscope = "project:acme/widget"\nby = "s"\nat = "t"\n+++\nthe port is 8080\n')
        self.assertIn("8080", memo.start_text(self.env, str(self.repo)))
        f.write_text(f.read_text().replace("8080", "9090"))
        self.assertEqual(self.run_memo("reindex")[0], 0)
        start = memo.start_text(self.env, str(self.repo))
        self.assertIn("9090", start)
        self.assertNotIn("8080", start)

    def test_the_cached_section_is_keyed_by_the_code_that_drew_it(self):
        store = memo.repo_store(self.env, "acme/widget")
        digest = memo.names_digest(store)
        with mock.patch.object(memo, "RENDER", memo.RENDER + 1):
            self.assertNotEqual(memo.names_digest(store), digest)



class SmallRules(CliCase):
    def test_an_id_tail_is_matched_as_written(self):
        self.run_memo("note", "a fact about the cache")
        code, _, err = self.run_memo("zoom", "%%%%")
        self.assertEqual(code, 2)
        self.assertIn("no note", err)

    def test_recall_needs_a_limit_of_one_or_more(self):
        self.assertEqual(self.run_memo("recall", "cache", "--limit", "0")[0], 2)

    def test_a_retired_or_corrected_note_is_not_retired_or_corrected_again(self):
        _, out, _ = self.run_memo("note", "the quota is 10 per day")
        ident = out.split()[1]
        self.assertEqual(self.run_memo("retire", ident, "status")[0], 0)
        self.assertEqual(self.run_memo("retire", ident, "status")[0], 2)
        self.assertEqual(self.run_memo("supersede", ident, "the quota is 20 per day")[0], 2)

    def test_keep_and_keep_none_together_are_refused(self):
        ids = [self.run_memo("note", f"fact {i} about the tile renderer")[1].split()[1] for i in range(3)]
        code, _, err = self.run_memo("summarize", ids[0], ids[1], "--keep", ids[0], "--keep-none")
        self.assertEqual(code, 2)
        self.assertIn("--keep-none", err)

    def test_a_group_note_needs_this_repository_in_the_group(self):
        self.configure()
        (self.tmp / "cfg/tstack/groups.toml").write_text(
            '[groups.tooling]\nrepos = ["acme/widget"]\n[groups.company]\nrepos = ["acme/other"]\n')
        code, _, err = self.run_memo("note", "--scope", "group:company", "a company fact")
        self.assertEqual(code, 2)
        self.assertIn("tooling", err)

    def test_names_match_whole(self):
        with self.assertRaises(ValueError):
            memo.parse_groups('[groups."tooling\\n"]\nrepos=["a/b"]\n')

    def test_a_byte_order_mark_is_read_past(self):
        r = memo.Note(uid(1), memo.Scope("user"), "s", "t", "x")
        self.assertEqual(memo.parse_record("notes", "\ufeff" + memo.render_record(r), r.id), r)

    def test_text_that_is_not_utf8_is_refused(self):
        code, _, err = self.run_memo("note", "bad byte \udcff here")
        self.assertEqual(code, 2)
        self.assertIn("UTF-8", err)

    def test_a_line_is_capped_in_bytes(self):
        code, _, _ = self.run_memo("note", "\U0001F600" * 280)
        self.assertEqual(code, 2)
        for face in ("\U0001F600", "\U0001F601", "\U0001F602"):
            self.assertEqual(self.run_memo("note", face * 210)[0], 0)
        view = memo.View(memo.Memo(self.env, str(self.repo)).view(memo.repo_store(self.env, "acme/widget")).notes)
        sl = memo.GROUPS // memo.MAX_GROUPS - memo.UNREAD_MAX - 1
        self.assertIn(memo.note_line(view.live[-1]), memo.select(view, memo.Scope("group", "a" * 30), sl).lines)

    def test_tasks_say_when_a_store_is_over_and_no_task_helps(self):
        self.run_memo("note", "\u00e9" * 279)
        self.run_memo("note", "\u00e9" * 278)
        m = memo.Memo(self.env, str(self.repo))
        store = m.session.repo
        with mock.patch.object(memo, "REPO", 900):
            out = io.StringIO()
            memo.cmd_tasks(m, None, out)
        m.index.close()
        self.assertNotIn("every store this session reads fits", out.getvalue())
        self.assertIn(str(store.scope), out.getvalue())

    def test_the_unread_groups_line_is_capped(self):
        self.configure()
        long = "z" + "-overflow" * 160
        (self.tmp / "cfg/tstack/groups.toml").write_text(
            f'[groups.a]\nrepos = ["acme/widget"]\n[groups.b]\nrepos = ["acme/widget"]\n'
            f'[groups.{long}]\nrepos = ["acme/widget"]\n')
        self.run_memo("note", "a widget fact")
        (line,) = [ln for ln in memo.start_text(self.env, str(self.repo)).splitlines() if "not read" in ln]
        self.assertLessEqual(len(line.encode()), memo.UNREAD_MAX)

    def test_local_keys_map_to_distinct_folders(self):
        env = {"XDG_DATA_HOME": "/d"}
        self.assertNotEqual(memo.repo_dir(env, "/home/x/a__b"), memo.repo_dir(env, "/home/x/a/b"))
        for key in ("/home/x/a__b", "/home/x/a/b", "/home/x/a_/b", "/home/x/_u"):
            self.assertEqual(memo.unflat(memo.repo_dir(env, key).name), key)

    def test_the_nearest_repository_holds_cwd(self):
        outer = self.tmp / "outer"
        (outer / ".jj").mkdir(parents=True)
        inner = outer / "vendor/lib"
        inner.mkdir(parents=True)
        sh(inner, "git", "init", "-q")
        sh(inner, "git", "remote", "add", "origin", "git@github.com:other/lib.git")
        self.assertEqual(memo.repo_key(str(inner)), "other/lib")

    def test_a_remote_in_capitals_loses_its_suffix(self):
        self.assertEqual(memo.normalize_remote("git@github.com:Owner/Repo.GIT"), "owner/repo")

    def test_an_open_thread_is_sent_to_its_owner(self):
        code, _, err = self.run_memo("note", "open", "finish the importer")
        self.assertEqual(code, 2)
        for owner in ("dossier", "fleet ledger", "issue"):
            self.assertIn(owner, err)

    def test_a_locked_index_is_not_deleted(self):
        self.run_memo("note", "a fact")
        index = memo.Index(self.env, timeout=0.1)
        held = memo.sqlite3.connect(index.path, isolation_level=None)
        held.execute("begin exclusive")
        self.addCleanup(held.close)
        with mock.patch.object(memo, "SCHEMA", memo.SCHEMA + 1), self.assertRaises(memo.sqlite3.OperationalError):
            index.open()
        held.rollback()
        self.assertTrue(index.path.exists())

    def test_hint_words_keep_names_with_digits(self):
        self.assertEqual(set(memo.hint_tokens("HTTP2 and SHA256 not 4ccb1e90 nor 01M7JKF73S1F05QBAD0VR28QBH")),
                         {"http2", "sha256"})

    def test_the_origin_file_is_written_once(self):
        self.run_memo("note", "a fact")
        origin = self.tmp / "state/tstack/memo/git/acme/widget.origin"
        before = origin.stat().st_mtime_ns
        time.sleep(0.01)
        memo.start_text(self.env, str(self.repo))
        self.assertEqual(origin.stat().st_mtime_ns, before)


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


class Bookmark(unittest.TestCase):
    """memo sync against bare repositories in a temporary folder, with two machines' stores (design.md, Every store
    travels on a `memo` bookmark)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        for key in ("acme/widget", "me/dotfiles"):
            sh(self.tmp, "git", "init", "-q", "--bare", str(self.tmp / "remotes" / f"{key}.git"))
        self.envs, self.repos = {}, {}
        for name in ("box", "mac"):
            self.machine(name)
        memo._repo_cache.clear()

    def url(self, key):
        return f"file://{self.tmp / 'remotes' / key}.git"

    def machine(self, name, origin=None):
        root = self.tmp / name
        env = {"HOME": str(root / "home"), "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
               "XDG_STATE_HOME": str(root / "state"), "XDG_CONFIG_HOME": str(root / "cfg"),
               "PATH": os.environ.get("PATH", ""), "CLAUDE_CODE_SESSION_ID": f"sess-{name}"}
        cfg = root / "cfg" / "tstack"
        cfg.mkdir(parents=True)
        (cfg / "memo.toml").write_text(f'machine = "{name}"\nhome_remote = "{self.url("me/dotfiles")}"\n')
        (cfg / "groups.toml").write_text('[groups.tooling]\nabout = "t"\nrepos = ["acme/widget", "me/dotfiles"]\n')
        for key in ("acme/widget", "me/dotfiles"):
            repo = root / "src" / key
            repo.mkdir(parents=True)
            sh(repo, "git", "init", "-q")
            sh(repo, "git", "remote", "add", "origin", origin or self.url(key))
        self.envs[name], self.repos[name] = env, root / "src"

    def memo(self, name, *args, repo="acme/widget"):
        out = io.StringIO()
        with contextlib.redirect_stderr(io.StringIO()) as err:
            code = memo.main(list(args), env=self.envs[name], cwd=str(self.repos[name] / repo), out=out)
        self.assertEqual(code, 0, err.getvalue())
        return out.getvalue()

    def home(self, name):
        return Path(self.envs[name]["XDG_DATA_HOME"]) / "tstack" / "memo" / "home"

    def files(self, name):
        home = self.home(name)
        return {str(p.relative_to(home)) for p in home.rglob("*.md")}

    def bookmark(self, key):
        git = ["git", "--git-dir", str(self.tmp / "remotes" / f"{key}.git")]
        return set(sh(self.tmp, *git, "ls-tree", "-r", "--name-only", "memo").split())

    def blob(self, key, path):
        return sh(self.tmp, "git", "--git-dir", str(self.tmp / "remotes" / f"{key}.git"), "show", f"memo:{path}")

    def seed_remote(self, key, files):
        """Make refs/heads/memo on the remote hold exactly these {path: text} files."""
        git = ["git", "--git-dir", str(self.tmp / "remotes" / f"{key}.git")]
        env = {**os.environ, "GIT_INDEX_FILE": str(self.tmp / "seed-index")}

        def run(*args, stdin=None):
            return subprocess.run(git + list(args), input=stdin, capture_output=True, text=True, env=env,
                                  check=True).stdout.strip()

        for path, text in files.items():
            run("update-index", "--add", "--cacheinfo", f"100644,{run('hash-object', '-w', '--stdin', stdin=text)},{path}")
        commit = run("-c", "user.name=x", "-c", "user.email=x@x", "commit-tree", run("write-tree"), "-m", "seed")
        run("update-ref", "refs/heads/memo", commit)

    def test_a_remote_file_where_a_record_needs_a_folder_stops_that_store_and_drops_no_path(self):
        self.memo("box", "note", "a note whose folder is a file on the bookmark")
        (rel,) = [p for p in self.files("box") if p.startswith("repo/acme/widget/")]
        folder = rel.removeprefix("repo/acme/widget/").rsplit("/", 1)[0]
        self.seed_remote("acme/widget", {folder: "a file the bookmark already holds\n", "README": "x\n"})
        before = self.bookmark("acme/widget")
        out = self.memo("box", "sync")
        self.assertEqual(self.bookmark("acme/widget"), before)
        self.assertIn(folder, out)
        self.assertIn(folder, self.memo("box", "doctor"))

    def test_a_ref_lock_left_by_a_killed_fetch_is_cleared(self):
        self.memo("box", "note", "first")
        self.memo("box", "sync")
        git_dir = Path(self.envs["box"]["XDG_STATE_HOME"]) / "tstack/memo/git/acme/widget.git"
        (git_dir / "refs/memo/remote.lock").write_text("")
        self.memo("mac", "note", "mac note")
        self.memo("mac", "sync")
        self.assertIn("fetched 1 file", self.memo("box", "sync"))

    def test_the_pushed_bytes_are_the_files_bytes(self):
        config = self.tmp / "gitconfig"
        config.write_text("[core]\n\tautocrlf = input\n")
        for name in ("box", "mac"):
            self.envs[name]["GIT_CONFIG_GLOBAL"] = str(config)
        self.memo("box", "note", "crlf")
        (rel,) = [p for p in self.files("box") if p.startswith("repo/acme/widget/")]
        f = self.home("box") / rel
        f.write_bytes(f.read_bytes().replace(b"\n", b"\r\n"))
        self.memo("box", "sync")
        self.memo("mac", "sync")
        self.assertEqual((self.home("mac") / rel).read_bytes(), f.read_bytes())

    def test_a_callers_git_repository_variables_do_not_reach_the_sync(self):
        self.memo("box", "note", "a note")
        self.envs["box"].update(GIT_WORK_TREE=str(self.tmp), GIT_INDEX_FILE=str(self.tmp / "stray-index"),
                                GIT_DIR=str(self.tmp / "nowhere"))
        self.assertIn("pushed 1 file", self.memo("box", "sync"))

    def test_two_machines_that_sync_twice_hold_the_union(self):
        self.memo("box", "note", "the box writes the first repo note")
        self.memo("box", "note", "--scope", "user", "Luiz reads a page first")
        self.memo("mac", "note", "the mac writes another repo note")
        self.memo("mac", "note", "--scope", "group", "both repos ship from one flake")
        self.memo("mac", "note", "--scope", "machine", "the mac has no systemd")
        for _ in range(2):
            for name in ("box", "mac"):
                self.memo(name, "sync")
        self.assertEqual(self.files("box"), self.files("mac"))
        self.assertEqual(len(self.files("box")), 5)
        widget = {p.removeprefix("repo/acme/widget/") for p in self.files("box") if p.startswith("repo/acme/widget/")}
        self.assertEqual(self.bookmark("acme/widget"), widget)
        self.assertEqual(len(self.bookmark("me/dotfiles")), 3)
        self.assertIn("the mac writes another repo note", memo.start_text(self.envs["box"],
                                                                         str(self.repos["box"] / "acme/widget")))

    def test_a_push_on_an_old_fetch_is_refused_and_the_next_try_gets_through_without_force(self):
        self.memo("box", "note", "the box is second to push")
        self.memo("mac", "note", "the mac pushes while the box builds its commit")
        real, raced = memo._push, []

        def race(env, remote, commit, timeout_s):
            if not raced and remote.key == "acme/widget":
                raced.append(commit)
                self.memo("mac", "sync")
            return real(env, remote, commit, timeout_s)

        remote = memo.Memo(self.envs["box"], str(self.repos["box"] / "acme/widget")).session.remote
        res = memo.sync_bookmark(remote, self.envs["box"], "box", push=race)
        self.assertEqual((res.outcome, res.pushed), ("synced", 1))
        git = ["git", "--git-dir", str(self.tmp / "remotes" / "acme/widget.git")]
        head = sh(self.tmp, *git, "rev-parse", "memo")
        self.assertNotEqual(head, raced[0], "the commit built on the old fetch never landed")
        self.assertEqual(len(sh(self.tmp, *git, "rev-list", "memo").split()), 2, "the box's commit is on the mac's")
        self.assertEqual(len(self.bookmark("acme/widget")), 2)

    def test_no_sync_removes_or_changes_a_path_of_the_bookmark(self):
        self.memo("box", "note", "a note deleted by hand comes back")
        self.memo("box", "sync")
        (path,) = self.bookmark("acme/widget")
        local = self.home("box") / "repo/acme/widget" / path
        before = self.blob("acme/widget", path)
        local.unlink()
        self.memo("box", "note", "a second note")
        self.memo("box", "sync")
        self.assertTrue(local.is_file())
        self.assertEqual(len(self.bookmark("acme/widget")), 2)
        local.write_text("edited by hand")
        self.memo("box", "note", "a third note")
        self.memo("box", "sync")
        self.assertEqual(self.blob("acme/widget", path), before)
        self.assertEqual(local.read_text(), "edited by hand", "the local file stays")

    def test_a_remote_that_does_not_answer_leaves_the_store_and_exits_zero_in_time(self):
        self.machine("far", origin="ssh://memo-test.invalid/acme/widget.git")
        ssh = self.tmp / "silent-ssh"
        ssh.write_text("#!/bin/sh\nexec sleep 30\n")
        ssh.chmod(0o755)
        self.envs["far"].update(GIT_SSH_COMMAND=str(ssh))
        self.memo("far", "note", "this note waits for the next sync")
        before = self.files("far")
        started = time.monotonic()
        remote = memo.Memo(self.envs["far"], str(self.repos["far"] / "acme/widget")).session.remote
        out = memo.sync_line(memo.sync_bookmark(remote, self.envs["far"], "far", timeout_s=1), remote.url)
        self.assertLess(time.monotonic() - started, 10)
        self.assertIn("no answer in 1 seconds. 1 file waits here for the next sync.", out)
        self.assertEqual(self.files("far"), before)
        self.assertIn("1 file waits for a sync", self.memo("far", "doctor"))

    def test_the_dotfiles_bookmark_carries_four_kinds_of_store_and_each_file_lands_in_its_own(self):
        self.memo("box", "note", "--scope", "user", "a user note")
        self.memo("box", "note", "--scope", "machine", "a machine note")
        self.memo("box", "note", "--scope", "group", "a group note")
        self.memo("box", "note", "a dotfiles note", repo="me/dotfiles")
        self.memo("box", "sync", repo="me/dotfiles")
        self.assertEqual({p.split("/")[0] for p in self.bookmark("me/dotfiles")},
                         {"user", "machine", "group", "notes"})
        self.memo("mac", "sync", repo="me/dotfiles")
        kinds = {p.split("/notes/")[0] for p in self.files("mac")}
        self.assertEqual(kinds, {"user", "machine/box", "group/tooling", "repo/me/dotfiles"})
        self.assertEqual(self.files("box"), self.files("mac"))

    def test_sync_all_takes_every_repository_with_a_store_and_doctor_counts_what_waits(self):
        self.memo("box", "note", "a widget note")
        self.assertIn("1 file waits for a sync", self.memo("box", "doctor"))
        plain = self.tmp / "plain"
        plain.mkdir()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(memo.main(["sync", "--all"], env=self.envs["box"], cwd=str(plain), out=io.StringIO()), 0)
        self.assertEqual(len(self.bookmark("acme/widget")), 1)
        self.assertNotIn("for a sync", self.memo("box", "doctor"))

    def test_a_store_with_no_remote_stays_local_and_a_worker_does_not_sync(self):
        self.machine("lone", origin="")
        sh(self.repos["lone"] / "acme/widget", "git", "remote", "remove", "origin")
        (Path(self.envs["lone"]["XDG_CONFIG_HOME"]) / "tstack" / "memo.toml").write_text('machine = "lone"\n')
        self.memo("lone", "note", "a note with nowhere to go")
        out = self.memo("lone", "sync")
        self.assertIn("no remote", out)
        self.assertIn("no home_remote", out)
        self.assertIn("exists on this machine only", self.memo("lone", "doctor"))
        with contextlib.redirect_stderr(io.StringIO()):
            code = memo.main(["sync"], env={**self.envs["box"], "TSTACK_ROLE": "worker"},
                             cwd=str(self.repos["box"] / "acme/widget"), out=io.StringIO())
        self.assertEqual(code, memo.EXIT_ROLE)


if __name__ == "__main__":
    unittest.main()
