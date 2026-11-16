"""Tests for scripts/memo-migrate, run through `memo migrate`, on v1 stores built in a temporary folder.

Run: just test-scripts
"""

import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "memo"


def load_memo():
    sys.dont_write_bytecode = True
    loader = SourceFileLoader("memo_for_migrate_test", str(SCRIPT))
    module = module_from_spec(spec_from_loader("memo_for_migrate_test", loader))
    loader.exec_module(module)
    return module


memo = load_memo()


def uid(n):
    return memo.encode_ulid(1_760_000_000_000 + n * 3_600_000, n)


def v1(base, n, text, scope, kind="fact", folder="notes"):
    path = base / folder / f"{uid(n)}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'+++\nid = "{uid(n)}"\nkind = "{kind}"\nscope = "{scope}"\nby = "s/interactive"\n'
                    f'at = "2026-10-01T00:00:00Z"\n+++\n{text}\n')
    return path


class MigrateCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.env = {"HOME": str(self.tmp / "home"), "XDG_DATA_HOME": str(self.tmp / "data"),
                    "XDG_CACHE_HOME": str(self.tmp / "cache"), "XDG_STATE_HOME": str(self.tmp / "state"),
                    "XDG_CONFIG_HOME": str(self.tmp / "cfg"), "PATH": os.environ.get("PATH", ""),
                    "CLAUDE_CODE_SESSION_ID": "sess-migrate"}
        cfg = self.tmp / "cfg" / "tstack"
        cfg.mkdir(parents=True)
        (cfg / "memo.toml").write_text('machine = "box"\n')
        (cfg / "groups.toml").write_text('[groups.tooling]\nabout = "t"\nrepos = ["acme/widget"]\n')
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "remote", "add", "origin", "git@github.com:acme/widget.git"], cwd=self.repo, check=True)
        memo._repo_cache.clear()
        self.old = self.repo / ".tstack" / "memo"
        self.glob = self.tmp / "data" / "tstack" / "memo" / "global"
        v1(self.old, 1, "the deploy reads the R2 bucket", "project:acme/widget")
        v1(self.old, 2, "finish the hook port", "project:acme/widget", kind="open")
        v1(self.old, 3, "an old pin about the cache", "project:acme/widget", kind="decision")
        v1(self.glob, 10, "Luiz reads a page first", "global", kind="preference")
        v1(self.glob, 11, "every tooling repo builds with one flake", "global")
        v1(self.glob, 12, "the box has 32 cores", "global")
        self.home = self.tmp / "data" / "tstack" / "memo" / "home"

    def migrate(self, *args, code=0, date="2026-11-16"):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err):
            got = memo.main(["migrate", *args, "--date", date], env=self.env, cwd=str(self.repo), out=out)
        self.assertEqual(got, code, err.getvalue() + out.getvalue())
        return out.getvalue() + err.getvalue()

    def tsv(self, *rows):
        path = self.tmp / "pass.tsv"
        path.write_text("id\taction\targument\n" + "".join("\t".join(r) + "\n" for r in rows))
        return str(path)

    def files(self):
        return sorted(str(p.relative_to(self.tmp)) for p in self.tmp.rglob("*") if p.is_file()
                      and "cache" not in p.parts and p.name != "pass.tsv")

    def start(self):
        memo._repo_cache.clear()
        return memo.start_text(self.env, str(self.repo))

    def recall(self, *terms):
        out = io.StringIO()
        memo.main(["recall", *terms], env=self.env, cwd=str(self.repo), out=out)
        return out.getvalue()

    def applied(self):
        return (self.tmp / "data/tstack/memo/archive/applied.tsv").read_text().splitlines()


class Snapshot(MigrateCase):
    def test_the_checkout_and_the_global_folder_are_copied_and_a_dry_run_writes_nothing(self):
        before = self.files()
        out = self.migrate("snapshot", "--dry-run")
        self.assertIn("acme__widget: 3 record files", out)
        self.assertIn("global: 3 record files", out)
        self.assertEqual(self.files(), before)
        self.migrate("snapshot")
        archive = self.tmp / "data/tstack/memo/archive/v1-2026-11-16"
        self.assertTrue((archive / "acme__widget/notes" / f"{uid(2)}.md").is_file())
        self.assertTrue((archive / "global/notes" / f"{uid(10)}.md").is_file())
        self.assertIn("copied 0 into", self.migrate("snapshot"))


class Apply(MigrateCase):
    def test_a_bad_row_writes_nothing_and_names_every_bad_line(self):
        self.migrate("snapshot")
        rows = self.tsv((uid(2)[-6:], "retire", "done in abc1234"), ("ZZZZZZ", "keep", ""),
                        (uid(1), "refile", "group:tooling"), (uid(3), "explode", "x"))
        before = self.files()
        out = self.migrate("apply", rows, code=2)
        self.assertIn("line 3:", out)
        self.assertIn("line 4:", out)
        self.assertIn("line 5:", out)
        self.assertNotIn("line 2:", out)
        self.assertEqual(self.files(), before)

    def test_each_action_has_its_end_and_a_second_run_applies_nothing(self):
        rows = self.tsv((uid(2), "retire", "unplaced"), (uid(3), "supersede", "the cache key is the file's digest"),
                        (uid(1), "keep", ""), (uid(10), "refile", "user"), (uid(11), "refile", "group:tooling"),
                        (uid(12), "refile", "machine:box"))
        self.migrate("snapshot")
        before = self.files()
        self.assertIn("would apply 6 rows of 6", self.migrate("apply", "--dry-run", rows))
        self.assertEqual(self.files(), before)
        self.migrate("apply", rows)
        text = self.start()
        self.assertNotIn("finish the hook port", text)
        self.assertNotIn("an old pin about the cache", text)
        self.assertIn("the cache key is the file's digest", text)
        group = self.home / "group/tooling/notes" / uid(11)[:4] / f"{uid(11)}.md"
        self.assertIn('scope = "group:tooling"', group.read_text())
        self.assertIn('kind = "fact"', group.read_text(), "only the scope line changes")
        self.assertFalse((self.glob / "notes" / f"{uid(11)}.md").exists())
        self.assertTrue((self.home / "machine/box/notes" / uid(12)[:4] / f"{uid(12)}.md").is_file())
        self.assertIn("## Group tooling\n", text)
        self.assertIn("every tooling repo builds with one flake", text.split("## Group tooling")[1])
        after = self.files()
        self.assertIn("applied 0 rows of 6 (6 applied before)", self.migrate("apply", rows))
        self.assertEqual(self.files(), after)

    def test_the_report_counts_each_end_and_lists_the_unplaced(self):
        self.migrate("snapshot")
        self.migrate("apply", self.tsv((uid(2), "retire", "unplaced"), (uid(3), "retire", "done in abc1234"),
                                       (uid(1), "keep", "")))
        out = self.migrate("report", "--dry-run")
        self.assertIn("| unplaced | 1 |", out)
        self.assertIn("| retired with a reason | 1 |", out)
        self.assertIn(f"- {uid(2)} in repo:acme/widget", out)
        self.migrate("report")
        self.assertTrue((self.tmp / "data/tstack/memo/archive/v1-2026-11-16/pass-report.md").is_file())


class Store(MigrateCase):
    def test_the_checkout_store_is_copied_home_and_read_no_more(self):
        self.migrate("snapshot")
        before = self.files()
        self.assertIn("would copy 3 of 3", self.migrate("store", "--dry-run"))
        self.assertEqual(self.files(), before)
        self.migrate("store")
        self.assertTrue((self.home / "repo/acme/widget" / memo.MIGRATED).is_file())
        self.assertTrue((self.home / "repo/acme/widget/notes" / uid(1)[:4] / f"{uid(1)}.md").is_file())
        (self.old / "notes" / f"{uid(1)}.md").write_text("+++\nbroken\n")
        self.assertIn("the deploy reads the R2 bucket", self.start())
        self.assertIn("copied 0 of 3", self.migrate("store"))

    def test_a_fresh_store_copies_only_what_the_pass_wrote(self):
        self.migrate("snapshot")
        self.migrate("apply", self.tsv((uid(3), "supersede", "the cache key is the file's digest"),
                                       (uid(2), "retire", "unplaced")))
        self.migrate("store", "--fresh")
        text = self.start()
        self.assertIn("the cache key is the file's digest", text)
        self.assertNotIn("the deploy reads the R2 bucket", text)

    def test_the_global_folder_is_closed_only_when_each_live_note_has_an_end(self):
        self.migrate("snapshot")
        self.assertIn("3 live notes", self.migrate("store", "--global", code=2))
        self.migrate("apply", self.tsv((uid(10), "refile", "user"), (uid(11), "retire", "unplaced"),
                                       (uid(12), "supersede", "the box has 32 cores and 128 GB")))
        self.migrate("store", "--global")
        self.assertTrue((self.home / "user" / memo.MIGRATED).is_file())
        text = self.start()
        self.assertIn("Luiz reads a page first", text)
        self.assertNotIn("every tooling repo", text)

    def test_a_global_note_another_machine_refiled_has_its_end_here(self):
        """Each machine has its own old global folder. A note the admin machine refiled reaches this one by sync."""
        group = self.home / "group/tooling/notes" / uid(11)[:4] / f"{uid(11)}.md"
        group.parent.mkdir(parents=True)
        group.write_text((self.glob / "notes" / f"{uid(11)}.md").read_text().replace('"global"', '"group:tooling"'))
        self.migrate("snapshot")
        self.migrate("apply", self.tsv((uid(10), "refile", "user"), (uid(12), "retire", "unplaced")))
        self.migrate("store", "--global")

    def test_a_global_note_another_machine_refiled_to_user_has_its_end_here(self):
        """The user store's own home folder counts too: a note refiled to user elsewhere is placed."""
        for n, scope in ((10, "user"), (11, "group:tooling")):
            path = self.home / scope.replace(":", "/") / "notes" / uid(n)[:4] / f"{uid(n)}.md"
            path.parent.mkdir(parents=True)
            path.write_text((self.glob / "notes" / f"{uid(n)}.md").read_text().replace('"global"', f'"{scope}"'))
        self.migrate("snapshot")
        self.migrate("apply", self.tsv((uid(12), "retire", "unplaced")))
        self.migrate("store", "--global")
        self.assertTrue((self.home / "user" / memo.MIGRATED).is_file())

    def test_a_checkout_without_a_v1_store_says_so_and_writes_nothing(self):
        shutil.rmtree(self.old)
        before = self.files()
        self.assertIn("no v1 store", self.migrate("store"))
        self.assertEqual(self.files(), before)


class Safety(MigrateCase):
    def test_no_step_writes_before_the_snapshot(self):
        before = self.files()
        for args in (("apply", self.tsv((uid(2), "retire", "done in abc1234"))), ("store",), ("store", "--fresh"),
                     ("store", "--global"), ("apply", self.tsv((uid(11), "refile", "group:tooling")))):
            out = self.migrate(*args, code=2)
            self.assertIn("memo migrate snapshot", out, args)
            self.assertNotIn("applied", out, args)
        self.assertEqual(self.files(), before)

    def test_a_fresh_store_leaves_the_old_notes_to_recall(self):
        self.migrate("snapshot")
        self.migrate("store", "--fresh")
        self.assertNotIn("the deploy reads the R2 bucket", self.start())
        self.assertIn("the deploy reads the R2 bucket", self.recall("R2", "bucket"))

    def test_a_refile_to_a_scope_memo_would_not_read_is_refused(self):
        self.migrate("snapshot")
        before = self.files()
        for scope in ("repo:../..", "repo:../../../../escaped", "repo:Acme/Widget", "repo:acme", "repo:acme/widget/",
                      "group:toolng", "machine:other", "repo:"):
            out = self.migrate("apply", self.tsv((uid(11), "refile", scope)), code=2)
            self.assertIn("line 2:", out, scope)
        self.assertEqual(self.files(), before)

    def test_a_refile_keeps_the_old_file_until_the_new_one_is_written(self):
        self.migrate("snapshot")

        def fail(path, content):
            raise OSError("disk full")
        with mock.patch.object(memo, "atomic_write", fail), self.assertRaises(OSError):
            self.migrate("apply", self.tsv((uid(11), "refile", "group:tooling")))
        self.assertTrue((self.glob / "notes" / f"{uid(11)}.md").is_file())
        self.assertFalse(list(self.home.rglob(f"{uid(11)}.md")))

    def test_a_second_run_on_another_day_applies_nothing(self):
        self.migrate("snapshot")
        rows = self.tsv((uid(3), "supersede", "the cache key is the file's digest"), (uid(2), "retire", "done"),
                        (uid(11), "refile", "group:tooling"))
        self.migrate("apply", rows)
        after = self.files()
        self.assertIn("applied 0 rows of 3 (3 applied before)", self.migrate("apply", rows, date="2026-11-17"))
        self.assertEqual(self.files(), after)
        self.assertEqual(self.start().count("the cache key is the file's digest"), 1)

    def test_a_run_cut_short_before_its_log_line_resumes(self):
        self.migrate("snapshot")
        rows = self.tsv((uid(10), "refile", "user"), (uid(2), "retire", "done"),
                        (uid(3), "supersede", "the cache key is the file's digest"))
        self.migrate("apply", rows)
        log = self.tmp / "data/tstack/memo/archive/applied.tsv"
        log.write_text("")
        after = self.files()
        self.assertIn("applied 0 rows of 3 (3 applied before)", self.migrate("apply", rows))
        self.assertEqual(sorted(ln.split("\t")[0] for ln in self.applied()), sorted([uid(10), uid(2), uid(3)]))
        self.assertEqual(self.files(), after)

    def test_a_dry_run_writes_not_even_the_index(self):
        self.migrate("snapshot")
        self.migrate("apply", "--dry-run", self.tsv((uid(2), "retire", "done"), (uid(11), "refile", "group:tooling")))
        self.assertFalse((self.tmp / "cache").exists())

    def test_a_quoted_unplaced_reason_is_unplaced(self):
        self.migrate("snapshot")
        self.migrate("apply", self.tsv((uid(2), "retire", '"Unplaced": no owner')))
        self.assertIn(f"- {uid(2)} in repo:acme/widget", self.migrate("report", "--dry-run"))


if __name__ == "__main__":
    unittest.main()


class AlreadyOut(MigrateCase):
    def setUp(self):
        super().setUp()
        self.migrate("snapshot")

    def files_now(self):
        return sorted(str(p.relative_to(self.home)) for p in self.home.rglob("*.md"))

    def test_a_supersede_row_for_a_note_a_session_retired_refuses_before_any_write(self):
        self.assertEqual(memo.main(["retire", uid(2), "done in abc1234"], env=self.env, cwd=str(self.repo),
                                   out=io.StringIO()), 0)
        before = self.files_now()
        rows = self.tsv((uid(1), "retire", "the deploy moved"), (uid(2), "supersede", "the hook port is done"))
        self.assertIn("already retired or corrected", self.migrate("apply", rows, code=2))
        self.assertEqual(self.files_now(), before)

    def test_a_retire_row_for_a_note_a_session_superseded_counts_as_done(self):
        self.assertEqual(memo.main(["supersede", uid(3), "the cache key is the digest"], env=self.env,
                                   cwd=str(self.repo), out=io.StringIO()), 0)
        rows = self.tsv((uid(1), "retire", "the deploy moved"), (uid(3), "retire", "old pin"))
        self.migrate("apply", rows)
        self.assertIn("applied 0 rows", self.migrate("apply", rows))
