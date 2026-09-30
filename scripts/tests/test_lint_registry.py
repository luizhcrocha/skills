"""Tests for scripts/lint-registry against synthetic registries and the repo's own.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import datetime as dt
import io
import sys
import tempfile
import tomllib
import unittest
from contextlib import redirect_stderr, redirect_stdout
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "scripts" / "lint-registry"

sys.dont_write_bytecode = True
_loader = SourceFileLoader("lint_registry", str(SCRIPT))
lr = module_from_spec(spec_from_loader("lint_registry", _loader))
_loader.exec_module(lr)

HEADER = "# the registry\n# second line\n\n"


def rule(**over):
    r = {
        "id": "ts/tstack/no-spy-on",
        "lang": "ts",
        "engine": "oxlint",
        "kind": "custom",
        "status": "proposed",
        "summary": "vi.spyOn in place of a seam",
        "where": "lint/ts/tstack/rules/no-spy-on.ts",
        "created": "2026-09-30",
        "last_hit": "",
        "evidence": ["repo:custom-mcp-servers src/emit.test.ts:24"],
        "history": [{"date": "2026-09-30", "status": "proposed", "note": "written"}],
        "runs": [],
    }
    r.update(over)
    return r


class Registry(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "lint/ts/tstack/rules").mkdir(parents=True)
        (self.root / "lint/ts/tstack/rules/no-spy-on.ts").write_text("rule\n")
        (self.root / "lint/py").mkdir()
        (self.root / "lint/py/ruff.toml").write_text("")

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, *rules):
        (self.root / "lint/registry.toml").write_text(lr.dump(HEADER, list(rules)))

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = lr.main(["--root", str(self.root), *args])
        return code, out.getvalue(), err.getvalue()

    def problems(self, *rules):
        self.write(*rules)
        return lr.validate(self.root, lr.load(self.root))

    def test_a_good_rule_is_valid_and_round_trips(self):
        self.write(rule())
        self.assertEqual(lr.validate(self.root, lr.load(self.root)), [])
        text = (self.root / "lint/registry.toml").read_text()
        self.assertTrue(text.startswith(HEADER))
        self.assertEqual(lr.dump(HEADER, lr.load(self.root)), text)

    def test_validate_names_each_problem(self):
        cases = {
            "lang 'java'": rule(lang="java"),
            "engine 'eslint'": rule(engine="eslint"),
            "id must start with ts/": rule(id="rust/no-spy-on"),
            "kind 'plugin'": rule(kind="plugin"),
            "status 'beta'": rule(status="beta"),
            "does not exist": rule(where="lint/ts/tstack/rules/gone.ts"),
            "no evidence": rule(evidence=[]),
            "needs a <source>: prefix": rule(evidence=["saw it once"]),
            "differs from the last history entry": rule(status="trial"),
            "not a legal step": rule(
                status="error",
                history=[
                    {"date": "2026-09-01", "status": "proposed", "note": "a"},
                    {"date": "2026-09-02", "status": "error", "note": "b"},
                ],
            ),
            "not in date order": rule(
                status="trial",
                history=[
                    {"date": "2026-09-02", "status": "proposed", "note": "a"},
                    {"date": "2026-09-01", "status": "trial", "note": "b"},
                ],
            ),
            "must be a count": rule(runs=[{"repo": "r", "date": "2026-09-30", "hits": -1, "false_positives": 0}]),
            "is not YYYY-MM-DD": rule(created="30/09/2026"),
        }
        for expected, bad in cases.items():
            with self.subTest(expected):
                found = self.problems(bad)
                self.assertTrue(any(expected in p for p in found), found)

    def test_duplicate_ids_are_refused(self):
        found = self.problems(rule(), rule())
        self.assertTrue(any("duplicate id" in p for p in found), found)

    def test_a_retired_rule_may_lose_its_file(self):
        retired = rule(
            status="retired",
            where="lint/ts/tstack/rules/gone.ts",
            history=[
                {"date": "2026-09-01", "status": "proposed", "note": "a"},
                {"date": "2026-09-02", "status": "retired", "note": "never fired"},
            ],
        )
        self.assertEqual(self.problems(retired), [])

    def test_record_keeps_one_run_per_repo_and_moves_last_hit(self):
        self.write(rule(status="trial", history=[
            {"date": "2026-09-01", "status": "proposed", "note": "a"},
            {"date": "2026-09-02", "status": "trial", "note": "b"},
        ]))
        self.assertEqual(self.run_cli("record", "ts/tstack/no-spy-on", "--repo", "~/a", "--hits", "3",
                                      "--false-positives", "1", "--date", "2026-09-10")[0], 0)
        self.assertEqual(self.run_cli("record", "ts/tstack/no-spy-on", "--repo", "~/b", "--hits", "0",
                                      "--false-positives", "0", "--date", "2026-09-11")[0], 0)
        self.assertEqual(self.run_cli("record", "ts/tstack/no-spy-on", "--repo", "~/a", "--hits", "2",
                                      "--false-positives", "2", "--date", "2026-09-12", "--note", "all console")[0], 0)
        r = lr.load(self.root)[0]
        self.assertEqual([x["repo"] for x in r["runs"]], ["~/b", "~/a"])
        self.assertEqual(r["runs"][1]["note"], "all console")
        self.assertEqual(r["last_hit"], "2026-09-10", "a run whose hits are all false positives is not a hit")
        self.assertEqual(lr.totals(r), {"repos": 2, "hits": 2, "false_positives": 2, "last_run": "2026-09-12"})

    def test_record_refuses_more_false_positives_than_hits(self):
        self.write(rule())
        code, _, err = self.run_cli("record", "ts/tstack/no-spy-on", "--repo", "r", "--hits", "1", "--false-positives", "2")
        self.assertEqual(code, 1)
        self.assertIn("at most hits", err)

    def test_set_status_follows_the_ladder(self):
        self.write(rule())
        self.assertEqual(self.run_cli("set-status", "ts/tstack/no-spy-on", "warn", "--note", "skip")[0], 1)
        for status in ("trial", "warn", "error", "warn", "retired", "proposed"):
            code, _, err = self.run_cli("set-status", "ts/tstack/no-spy-on", status, "--note", f"to {status}", "--date", "2026-09-30")
            self.assertEqual(code, 0, err)
        r = lr.load(self.root)[0]
        self.assertEqual(r["status"], "proposed")
        self.assertEqual([h["status"] for h in r["history"]],
                         ["proposed", "trial", "warn", "error", "warn", "retired", "proposed"])

    def test_add_writes_a_proposed_rule_and_refuses_an_invalid_one(self):
        self.write(rule())
        code, _, err = self.run_cli("add", "--id", "py/ruff-all", "--lang", "py", "--engine", "ruff", "--kind", "config",
                                    "--summary", "every rule", "--where", "lint/py/ruff.toml",
                                    "--evidence", "skill:lang-py gates", "--date", "2026-09-30")
        self.assertEqual(code, 0, err)
        added = lr.load(self.root)[1]
        self.assertEqual((added["status"], added["created"], added["history"][0]["status"]), ("proposed", "2026-09-30", "proposed"))
        code, _, err = self.run_cli("add", "--id", "py/other", "--lang", "py", "--engine", "clippy", "--kind", "config",
                                    "--summary", "x", "--where", "lint/py/ruff.toml", "--evidence", "skill:lang-py")
        self.assertEqual(code, 1)
        self.assertIn("refusing to write an invalid registry", err)
        self.assertEqual(len(lr.load(self.root)), 2)

    def test_stale_splits_silent_rules_from_unmeasured_ones(self):
        hist = lambda s: [{"date": "2026-01-01", "status": s, "note": "seed"}]
        run = lambda d, h: [{"repo": "r", "date": d, "hits": h, "false_positives": 0}]
        self.write(
            rule(id="ts/a", status="error", history=hist("error"), runs=run("2026-09-01", 0), last_hit="2026-03-01"),
            rule(id="ts/b", status="warn", history=hist("warn"), runs=run("2026-09-01", 4), last_hit="2026-09-01"),
            rule(id="ts/c", status="trial", history=hist("trial"), runs=run("2026-01-05", 1), last_hit="2026-01-05"),
            rule(id="ts/d", status="proposed", history=hist("proposed")),
            rule(id="ts/e", status="error", history=hist("error"), runs=run("2026-09-20", 0)),
        )
        silent, unmeasured = lr.stale(lr.load(self.root), 90, dt.date(2026, 9, 30))
        self.assertEqual([r["id"] for r in silent], ["ts/a", "ts/e"])
        self.assertEqual([r["id"] for r in unmeasured], ["ts/c"])

    def test_list_filters_by_status_and_lang(self):
        self.write(rule(), rule(id="py/ruff-all", lang="py", engine="ruff", kind="config", where="lint/py/ruff.toml"))
        _, out, _ = self.run_cli("list", "--lang", "py")
        self.assertIn("py/ruff-all", out)
        self.assertNotIn("no-spy-on", out)

    def test_unknown_id_fails(self):
        self.write(rule())
        self.assertEqual(self.run_cli("show", "ts/nope")[0], 1)


class RepoRegistry(unittest.TestCase):
    def test_the_repos_registry_is_valid(self):
        rules = lr.load(ROOT)
        self.assertEqual(lr.validate(ROOT, rules), [])
        tomllib.loads((ROOT / "lint/registry.toml").read_text())

    def test_every_custom_ts_rule_in_the_packs_is_registered(self):
        ids = {r["id"] for r in lr.load(ROOT)}
        for plugin, prefix in (("anti-slop/rules", "ts/anti-slop/"), ("anti-slop/effect/rules", "ts/anti-slop-effect/"),
                               ("tstack/rules", "ts/tstack/")):
            for f in (ROOT / "lint/ts" / plugin).glob("*.ts"):
                if f.name.endswith(".test.ts"):
                    continue
                with self.subTest(f.name):
                    self.assertIn(prefix + f.stem, ids)


if __name__ == "__main__":
    unittest.main()
