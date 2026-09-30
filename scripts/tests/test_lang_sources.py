"""Tests for scripts/lang-sources, the lang-* skills' sources tables as JSON,
against a synthetic skills tree and the repo's own lang-* skills.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import datetime as dt
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "scripts" / "lang-sources"

sys.dont_write_bytecode = True
_loader = SourceFileLoader("lang_sources", str(SCRIPT))
ls = module_from_spec(spec_from_loader("lang_sources", _loader))
_loader.exec_module(ls)

FIXTURE = """\
# Sources

Intro text with a | pipe that is not a table.

| item | kind | version targeted | checked on | source URL |
|---|---|---|---|---|
| C23 | language | ISO/IEC 9899:2024 | 2026-09-30 | [WG14](https://www.open-std.org/jtc1/sc22/wg14/) |
| `GCC` | tool | 16.1 | 2026-06-01 | https://gcc.gnu.org/gcc-16/changes.html |
| clang-tidy | Tool | 21.1.0 | not yet | <https://releases.llvm.org/> |
| | tool | | | |

## Luiz's repos read

- ~/repos/example: nothing

## Open questions

| a | b |
|---|---|
| x | y |
"""

SKILL = '---\nname: lang-x\ndescription: x\npaths: ["**/*.x"]\n---\n'

REORDERED = """\
| Source URL | Checked on | Item | Version targeted | Kind |
| :-- | :-- | :-- | :-- | :-- |
| https://pypi.org/project/hypothesis/ | 2026-01-10 | Hypothesis | 6.140 | library |
"""


def tree(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp())
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return root


def run(*argv: str) -> tuple[int, list, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = ls.main(list(argv))
    return code, json.loads(out.getvalue()), err.getvalue()


class Parse(unittest.TestCase):
    def test_rows_of_the_first_sources_table(self):
        rows = ls.parse(FIXTURE)
        self.assertEqual([r["item"] for r in rows], ["C23", "GCC", "clang-tidy"])
        self.assertEqual(rows[0], {
            "item": "C23", "kind": "language", "version": "ISO/IEC 9899:2024",
            "checked_on": "2026-09-30", "url": "https://www.open-std.org/jtc1/sc22/wg14/",
        })
        self.assertEqual(rows[1]["url"], "https://gcc.gnu.org/gcc-16/changes.html")
        self.assertEqual(rows[2]["kind"], "tool")
        self.assertIsNone(rows[2]["checked_on"])
        self.assertEqual(rows[2]["url"], "https://releases.llvm.org/")

    def test_columns_matched_by_name_in_any_order(self):
        (row,) = ls.parse(REORDERED)
        self.assertEqual(row["item"], "Hypothesis")
        self.assertEqual(row["version"], "6.140")
        self.assertEqual(row["checked_on"], "2026-01-10")
        self.assertEqual(row["url"], "https://pypi.org/project/hypothesis/")

    def test_no_sources_table(self):
        self.assertIsNone(ls.parse("| a | b |\n|---|---|\n| 1 | 2 |\n"))
        self.assertIsNone(ls.parse("no tables here"))


class Cli(unittest.TestCase):
    def setUp(self):
        self.root = tree({
            "skills/engineering/lang-c/references/sources.md": FIXTURE,
            "skills/engineering/lang-py/references/sources.md": REORDERED,
            "skills/engineering/lang-c/SKILL.md": SKILL,
            "skills/engineering/lang-py/SKILL.md": SKILL,
            "skills/engineering/lang-empty/SKILL.md": SKILL,
            "skills/engineering/lang-refresh/SKILL.md": "---\nname: lang-refresh\ndescription: x\n---\n",
            "skills/engineering/other/references/sources.md": FIXTURE,
        })
        self.base = ("--root", str(self.root), "--today", "2026-09-30")

    def test_every_lang_skill_and_problems_on_stderr(self):
        code, rows, err = run(*self.base)
        self.assertEqual(code, 1)
        self.assertEqual({r["skill"] for r in rows}, {"lang-c", "lang-py"})
        self.assertEqual(len(rows), 4)
        self.assertIn("lang-empty: no references/sources.md", err)
        self.assertNotIn("lang-refresh", err)
        self.assertEqual(rows[0]["age_days"], 0)

    def test_skill_filter_accepts_short_name(self):
        code, rows, err = run(*self.base, "--skill", "py")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual([r["item"] for r in rows], ["Hypothesis"])

    def test_unknown_skill_is_a_problem(self):
        code, rows, err = run(*self.base, "--skill", "lang-cobol")
        self.assertEqual((code, rows), (1, []))
        self.assertIn("lang-cobol: no such skill", err)

    def test_stale_keeps_old_and_undated_rows(self):
        code, rows, _ = run(*self.base, "--skill", "c", "--skill", "py", "--stale", "90")
        self.assertEqual(code, 0)
        self.assertEqual([(r["skill"], r["item"]) for r in rows],
                         [("lang-c", "GCC"), ("lang-c", "clang-tidy"), ("lang-py", "Hypothesis")])
        self.assertEqual(rows[0]["age_days"], (dt.date(2026, 9, 30) - dt.date(2026, 6, 1)).days)

    def test_executable_prints_json(self):
        out = subprocess.run([sys.executable, str(SCRIPT), *self.base, "--skill", "c"],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(len(json.loads(out)), 3)


class RepoSkills(unittest.TestCase):
    def test_every_lang_skill_in_the_repo_has_a_parseable_table(self):
        rows, problems = ls.collect(ROOT, [], dt.date.today())
        self.assertEqual(problems, [])
        for r in rows:
            self.assertTrue(r["url"], f"{r['skill']}/{r['item']}: no URL")
            self.assertTrue(r["version"], f"{r['skill']}/{r['item']}: no version")
            self.assertTrue(r["checked_on"], f"{r['skill']}/{r['item']}: no checked on date")


if __name__ == "__main__":
    unittest.main()
