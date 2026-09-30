"""Tests for scripts/janitor-audit, the mechanical audit behind /worktree-janitor,
against throwaway jj repos.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)

Each test builds the same messy @ (build_messy), plays a janitor by hand, good
or bad, and asks the audit for its verdict.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AUDIT = Path(__file__).resolve().parent.parent / "janitor-audit"
HAVE_JJ = shutil.which("jj") is not None
ENV = {**os.environ, "JJ_EDITOR": "true", "EDITOR": "true", "JJ_USER": "Test", "JJ_EMAIL": "test@example.com",
       "JJ_CONFIG": ""}


def jj(repo, *args):
    r = subprocess.run(["jj", "--no-pager", "--color=never", *args], cwd=repo, env=ENV,
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"jj {' '.join(args)}: {r.stderr}")
    return r.stdout


def write(repo, path, text):
    p = Path(repo) / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


HISTORY = [
    "feat(core): the core module",
    "fix(core): an empty input is an error",
    "docs: the readme says how to run it",
    "feat(core): a --verbose flag",
    "test(core): the parser round-trips",
]


def build_messy(repo):
    """A jj repo whose @ is messy, on a stack of one mutable commit above `master`:

        @     cli.py (new), docs/usage.md (new), a typo fix in util.py (a fixup for
              the commit below), and a conflict in config.txt
        A     feat(util): string helpers   (util.py, config.txt value=2)
        master  five prefixed commits (core.py, config.txt value=1)
    """
    repo = Path(repo)
    repo.mkdir(parents=True, exist_ok=True)
    jj(repo, "git", "init", "--colocate")
    write(repo, "config.txt", "name=demo\nvalue=1\n")
    for n, subject in enumerate(HISTORY):
        write(repo, "core.py", "".join(f"def step{i}():\n    return {i}\n\n" for i in range(n + 1)))
        jj(repo, "commit", "-m", subject)
    jj(repo, "bookmark", "create", "master", "-r", "@-")
    base = jj(repo, "log", "--no-graph", "-r", "@-", "-T", "change_id").strip()
    write(repo, "util.py", "def shout(s):\n    return s.uper()\n\n\ndef whisper(s):\n    return s.lower()\n")
    write(repo, "config.txt", "name=demo\nvalue=2\n")
    jj(repo, "describe", "-m", "feat(util): string helpers")
    stack = jj(repo, "log", "--no-graph", "-r", "@", "-T", "change_id").strip()
    jj(repo, "new", base)
    write(repo, "config.txt", "name=demo\nvalue=3\n")
    write(repo, "cli.py", "import sys\n\nprint(sys.argv)\n")
    write(repo, "docs/usage.md", "# Usage\n\nRun `python cli.py`.\n")
    jj(repo, "rebase", "-r", "@", "-d", stack)
    write(repo, "util.py", "def shout(s):\n    return s.upper()\n\n\ndef whisper(s):\n    return s.lower()\n")
    jj(repo, "status")
    return repo


def tidy(repo, resolve="name=demo\nvalue=3\n"):
    """What a good janitor does with build_messy's @."""
    jj(repo, "absorb", "--into", "master..@-", "util.py")
    write(repo, "config.txt", resolve)
    jj(repo, "split", "-m", "feat(config): value is 3", "config.txt")
    jj(repo, "split", "-m", "docs: usage", "docs/usage.md")
    jj(repo, "describe", "-m", "feat(cli): print the arguments")
    jj(repo, "new")


@unittest.skipUnless(HAVE_JJ, "jj is not installed")
class AuditCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = build_messy(Path(self._tmp.name) / "repo")
        self.op = self.audit("start", "--json")[1]["op"]

    def audit(self, *args):
        r = subprocess.run([sys.executable, str(AUDIT), "-R", str(self.repo), *args],
                           capture_output=True, text=True, env=ENV)
        self.assertIn(r.returncode, (0, 1), r.stderr)
        return r.returncode, json.loads(r.stdout) if "--json" in args else r.stdout

    def verdict(self, *extra):
        code, result = self.audit("check", "--op", self.op, "--json", *extra)
        self.assertEqual(code == 0, result["ok"])
        return result

    def assertFails(self, result, kind, text=""):
        hits = [f for f in result["fail"] if f.startswith(kind + ":") and text in f]
        self.assertTrue(hits, f"no {kind!r} failure mentioning {text!r} in {result['fail']}")


class StartTest(AuditCase):
    def test_start_names_the_op_the_scope_and_the_conflict(self):
        code, s = self.audit("start", "--json")
        self.assertEqual(code, 0)
        self.assertEqual([r["subject"] for r in s["revisions"]], ["", "feat(util): string helpers"])
        self.assertEqual(s["conflicted"], ["config.txt"])
        self.assertEqual(set(s["files"]), {"cli.py", "config.txt", "docs/usage.md", "util.py"})
        master = jj(self.repo, "log", "--no-graph", "-r", "master", "-T", "commit_id").strip()
        self.assertEqual(s["base"], [master])
        text = self.audit("start")[1]
        self.assertIn(f"op {s['op']}", text)
        self.assertIn("(conflict)", text)


class PassTest(AuditCase):
    def test_a_good_janitor_passes_and_its_resolution_is_shown(self):
        tidy(self.repo)
        result = self.verdict()
        self.assertTrue(result["ok"], result["fail"])
        stack = result["info"]["stack"]
        self.assertEqual([r["subject"] for r in stack], [
            "feat(util): string helpers", "feat(config): value is 3", "docs: usage",
            "feat(cli): print the arguments"])
        self.assertEqual(stack[0]["files"], ["config.txt", "util.py"])
        self.assertIn("config.txt", result["info"]["resolutions"])
        self.assertIn("-<<<<<<<", result["info"]["resolutions"]["config.txt"])
        text = self.audit("check", "--op", self.op)[1]
        self.assertTrue(text.startswith("PASS"))
        self.assertIn(f"undo: jj op restore {self.op}", text)

    def test_a_description_the_author_wrote_is_not_graded(self):
        jj(self.repo, "describe", "-r", "@-", "-m", "string helpers")
        self.op = self.audit("start", "--json")[1]["op"]
        jj(self.repo, "absorb", "--into", "master..@-", "util.py")
        write(self.repo, "config.txt", "name=demo\nvalue=3\n")
        jj(self.repo, "describe", "-m", "feat(cli): the cli, its usage and value 3")
        jj(self.repo, "new")
        result = self.verdict()
        self.assertTrue(result["ok"], result["fail"])

    def test_checks_run_on_every_new_revision(self):
        tidy(self.repo)
        result = self.verdict("--check", "test -f core.py")
        self.assertTrue(result["ok"], result["fail"])
        self.assertEqual(len(result["info"]["checks"]), 4)
        result = self.verdict("--check", "test -f cli.py")
        self.assertFails(result, "checks", "test -f cli.py")
        self.assertEqual([c["ok"] for c in result["info"]["checks"]], [False, False, False, True])


class FailTest(AuditCase):
    def test_doing_nothing_fails(self):
        result = self.verdict()
        self.assertFails(result, "stack", "still holds changes")
        self.assertFails(result, "stack", "still has conflicts")
        self.assertFalse(any(f.startswith("tree:") for f in result["fail"]))

    def test_a_content_edit_fails_the_tree(self):
        tidy(self.repo)
        jj(self.repo, "edit", "@-")
        write(self.repo, "cli.py", "print('edited')\n")
        jj(self.repo, "new")
        self.assertFails(self.verdict(), "tree", "cli.py")

    def test_a_moved_or_created_bookmark_fails(self):
        tidy(self.repo)
        jj(self.repo, "bookmark", "set", "master", "-r", "@-")
        self.assertFails(self.verdict(), "bookmarks", "master moved")
        jj(self.repo, "bookmark", "set", "master", "-r", "@-----", "--allow-backwards")
        jj(self.repo, "bookmark", "create", "feature", "-r", "@-")
        result = self.verdict()
        self.assertFails(result, "bookmarks", "feature was created")
        self.assertFalse(any("master" in f for f in result["fail"]), result["fail"])

    def test_rewriting_below_the_stack_fails(self):
        tidy(self.repo)
        jj(self.repo, "describe", "-r", "master", "-m", "feat(core): reworded", "--ignore-immutable")
        result = self.verdict()
        self.assertFails(result, "base", "no longer an ancestor")
        self.assertFails(result, "bookmarks", "master moved")

    def test_an_undescribed_or_empty_revision_fails(self):
        tidy(self.repo)
        jj(self.repo, "describe", "-r", "@-", "-m", "")
        jj(self.repo, "new", "-m", "chore: nothing")
        jj(self.repo, "new")
        result = self.verdict()
        self.assertFails(result, "stack", "has no description")
        self.assertFails(result, "stack", "is empty")

    def test_a_described_at_fails(self):
        tidy(self.repo)
        jj(self.repo, "describe", "-m", "feat: later")
        self.assertFails(self.verdict(), "stack", "is described")

    def test_a_subject_off_the_repo_style_fails(self):
        tidy(self.repo)
        jj(self.repo, "describe", "-r", "@-", "-m", "Print the arguments")
        self.assertFails(self.verdict(), "style", "lacks the `type(scope): ` prefix")
        jj(self.repo, "describe", "-r", "@-", "-m", "WIP: cli")
        self.assertFails(self.verdict(), "style", "placeholder")

    def test_a_stray_revision_fails(self):
        tidy(self.repo)
        top = jj(self.repo, "log", "--no-graph", "-r", "@-", "-T", "change_id").strip()
        jj(self.repo, "new", "master", "-m", "feat: stray")
        write(self.repo, "stray.txt", "x\n")
        jj(self.repo, "new", top)
        result = self.verdict()
        self.assertFails(result, "strays", "feat: stray")


class StyleTest(unittest.TestCase):
    def setUp(self):
        sys.dont_write_bytecode = True
        from importlib.machinery import SourceFileLoader
        from importlib.util import module_from_spec, spec_from_loader
        loader = SourceFileLoader("janitor_audit", str(AUDIT))
        self.m = module_from_spec(spec_from_loader("janitor_audit", loader))
        loader.exec_module(self.m)

    def test_prefixed_history(self):
        profile = self.m.style_profile(HISTORY)
        self.assertEqual(profile["prefixed"], 1.0)
        self.assertEqual(profile["types"], ["docs", "feat", "fix", "test"])
        self.assertEqual(self.m.style_findings("fix(cli): quote args", profile), ([], []))
        fails, _ = self.m.style_findings("Quote args", profile)
        self.assertTrue(fails)
        fails, notes = self.m.style_findings("perf(cli): faster", profile)
        self.assertEqual(fails, [])
        self.assertIn("type `perf`", notes[0])
        _, notes = self.m.style_findings("fix: x [skip ci]", profile)
        self.assertTrue(any("[skip ci]" in n for n in notes))

    def test_plain_history(self):
        profile = self.m.style_profile(["Add the parser", "Fix a crash on empty input", "Bump deps"])
        self.assertEqual(self.m.style_findings("Quote the arguments", profile), ([], []))
        fails, notes = self.m.style_findings("feat: quote", profile)
        self.assertEqual(fails, [])
        self.assertIn("prefixed", notes[0])
        self.assertTrue(self.m.style_findings("fixup! Add the parser", profile)[0])

    def test_no_history(self):
        self.assertEqual(self.m.style_findings("anything", self.m.style_profile([])), ([], []))


if __name__ == "__main__":
    unittest.main()
