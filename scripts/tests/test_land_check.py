"""Tests for scripts/land-check, Land's verdict on a push, against throwaway jj
repos that push to a bare git remote.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CHECK = ROOT / "scripts" / "land-check"
HAVE_JJ = shutil.which("jj") is not None and shutil.which("git") is not None
ENV = {**os.environ, "JJ_EDITOR": "true", "EDITOR": "true", "JJ_USER": "Test", "JJ_EMAIL": "test@example.com",
       "JJ_CONFIG": ""}

sys.dont_write_bytecode = True
_loader = SourceFileLoader("land_check", str(CHECK))
lc = module_from_spec(spec_from_loader("land_check", _loader))
_loader.exec_module(lc)

DEPLOY = """\
name: Deploy
on:
  push:
    branches: [master]
{extra}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
  deploy:
    needs: test
    runs-on: ubuntu-latest
    environment: production  # the Cloudflare account
    steps:
      - uses: actions/checkout@v4
      - name: Publish
        run: |
          npx wrangler deploy
          echo "done # not a comment"
"""

TESTS_ONLY = """\
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: just test
"""


def jj(repo, *args):
    r = subprocess.run(["jj", "--no-pager", "--color=never", *args], cwd=repo, env=ENV, capture_output=True,
                       text=True)
    if r.returncode != 0:
        raise AssertionError(f"jj {' '.join(args)}: {r.stderr}")
    return r.stdout


def write(repo, path, text):
    p = Path(repo) / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


class YamlTest(unittest.TestCase):
    def test_a_deploy_workflow(self):
        data = lc.parse_yaml(DEPLOY.format(extra="    paths-ignore:\n      - 'docs/**'\n      - \"*.md\""))
        self.assertEqual(data["on"]["push"], {"branches": ["master"], "paths-ignore": ["docs/**", "*.md"]})
        self.assertEqual(list(data["jobs"]), ["test", "deploy"])
        steps = data["jobs"]["deploy"]["steps"]
        self.assertEqual(steps[0], {"uses": "actions/checkout@v4"})
        self.assertIn("wrangler deploy", steps[1]["run"])
        self.assertEqual(data["jobs"]["deploy"]["environment"], "production")
        self.assertEqual(lc.deploy_jobs(data, "master"), ["deploy"])

    def test_triggers_in_their_three_spellings(self):
        self.assertEqual(lc.triggers(lc.parse_yaml(TESTS_ONLY)["on"]), {"push": None, "pull_request": None})
        self.assertEqual(lc.triggers("push"), {"push": None})
        self.assertEqual(lc.deploy_jobs(lc.parse_yaml(TESTS_ONLY), "master"), [])

    def test_filters(self):
        self.assertTrue(lc.filtered(["docs/**"], "docs/a/b.md"))
        self.assertTrue(lc.filtered(["**.md"], "README.md"))
        self.assertTrue(lc.filtered(["*.md"], "README.md"))
        self.assertFalse(lc.filtered(["*.md"], "docs/x.md"))
        self.assertFalse(lc.filtered(["src/**", "!src/docs/**"], "src/docs/a"))
        self.assertTrue(lc.filtered(["release/**"], "release/1.2"))
        fires, why = lc.push_fires({"branches": ["main"]}, "master", ["a"])
        self.assertFalse(fires)
        self.assertIn("leave out master", why)
        self.assertFalse(lc.push_fires({"tags": ["v*"]}, "master", ["a"])[0])
        self.assertFalse(lc.push_fires({"paths": ["src/**"]}, "master", ["docs/a.md"])[0])
        self.assertTrue(lc.push_fires({"paths": ["src/**"]}, "master", ["docs/a.md", "src/x.ts"])[0])

    def test_a_job_limited_to_another_branch_is_not_a_deploy_here(self):
        data = lc.parse_yaml("on: push\njobs:\n  deploy:\n    if: github.ref == 'refs/heads/prod'\n"
                             "    steps:\n      - run: wrangler deploy\n")
        self.assertEqual(lc.deploy_jobs(data, "master"), [])
        self.assertEqual(lc.deploy_jobs(data, "prod"), ["deploy"])

    def test_what_counts_as_quiet(self):
        for path, kind in (("docs/x.md", "docs"), ("README.md", "docs"), (".tstack/memo/notes/a.md", "docs"),
                           (".tstack/memo/index.tsv", "memo"), ("scripts/tests/test_x.py", "tests"),
                           ("src/a.test.ts", "tests"), ("justfile", "tooling"), ("src/a.ts", None),
                           ("package.json", None)):
            self.assertEqual(lc.kind(path), kind, path)


@unittest.skipUnless(HAVE_JJ, "jj or git is not installed")
class RepoCase(unittest.TestCase):
    """A jj repo whose master is pushed to a bare remote, and a stack on top."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        subprocess.run(["git", "init", "-q", "--bare", str(self.tmp / "remote.git")], check=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        jj(self.repo, "git", "init", "--colocate")
        jj(self.repo, "git", "remote", "add", "origin", str(self.tmp / "remote.git"))

    def trunk(self, *commits):
        """Commits on master, pushed: (subject, {path: text}) each."""
        for subject, files in commits:
            for path, text in files.items():
                write(self.repo, path, text)
            jj(self.repo, "commit", "-m", subject)
        jj(self.repo, "bookmark", "set", "master", "-r", "@-")
        jj(self.repo, "git", "push", "--bookmark", "master")

    def change(self, subject, files):
        for path, text in files.items():
            write(self.repo, path, text)
        jj(self.repo, "commit", "-m", subject)

    def check(self, *args):
        r = subprocess.run([sys.executable, str(CHECK), "-R", str(self.repo), "-b", "master", *args],
                           capture_output=True, text=True, env=ENV)
        self.assertIn(r.returncode, (0, 1), r.stderr)
        result = json.loads(r.stdout)
        self.assertEqual(r.returncode == 0, result["verdict"] == "push")
        return result

    def said(self, result, text):
        self.assertTrue(any(text in r for r in result["reasons"]), f"no reason with {text!r}: {result['reasons']}")


class FastForwardTest(RepoCase):
    def test_a_stack_on_the_remote_tip_with_no_ci_pushes(self):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        self.change("feat: b", {"b.ts": "b\n"})
        self.change("docs: b", {"docs/b.md": "b\n"})
        result = self.check()
        self.assertTrue(result["ff"])
        self.assertEqual([r["subject"] for r in result["stack"]], ["feat: b", "docs: b"])
        self.assertEqual(result["head"]["subject"], "docs: b")
        self.assertEqual(result["files"], ["b.ts", "docs/b.md"])
        self.assertIs(result["deploys_on_push"], False)
        self.assertEqual(result["verdict"], "push")
        self.said(result, "no CI config")

    def test_a_stack_off_an_old_tip_stops(self):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        old = jj(self.repo, "log", "--no-graph", "-r", "master", "-T", "commit_id").strip()
        self.trunk(("feat: a2", {"a.ts": "a2\n"}))
        jj(self.repo, "new", old)
        self.change("feat: b", {"b.ts": "b\n"})
        result = self.check()
        self.assertFalse(result["ff"])
        self.assertEqual(result["verdict"], "stop")
        self.said(result, "rewrite remote history")

    def test_a_branchy_stack_with_a_merge_pushes(self):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        self.change("feat: b", {"b.ts": "b\n"})
        b = jj(self.repo, "log", "--no-graph", "-r", "@-", "-T", "change_id").strip()
        jj(self.repo, "new", "master")
        self.change("feat: c", {"c.ts": "c\n"})
        jj(self.repo, "new", b, "@-", "-m", "feat: b and c together")
        jj(self.repo, "new")
        result = self.check()
        self.assertTrue(result["ff"])
        self.assertEqual(len(result["stack"]), 3)
        self.assertTrue(result["stack"][-1]["merge"])
        self.assertEqual(result["verdict"], "push")

    def test_two_heads_stop_and_name_both(self):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        self.change("feat: b", {"b.ts": "b\n"})
        b = jj(self.repo, "log", "--no-graph", "-r", "@-", "-T", "change_id").strip()
        self.change("feat: c", {"c.ts": "c\n"})
        c = jj(self.repo, "log", "--no-graph", "-r", "@-", "-T", "change_id").strip()
        jj(self.repo, "new", b)
        self.change("feat: d", {"d.ts": "d\n"})
        jj(self.repo, "new", c)
        result = self.check()
        self.assertEqual(result["verdict"], "stop")
        self.assertEqual(sorted(h["subject"] for h in result["heads"]), ["feat: c", "feat: d"])
        self.said(result, "2 heads")
        self.assertEqual(self.check("--head", c)["verdict"], "push")

    def test_nothing_to_push(self):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        result = self.check()
        self.assertEqual(result["verdict"], "stop")
        self.said(result, "nothing to push")


class DeployTest(RepoCase):
    def test_a_push_that_deploys_asks(self):
        self.trunk(("ci: deploy", {".github/workflows/deploy.yml": DEPLOY.format(extra="")}))
        self.change("feat: b", {"src/b.ts": "b\n"})
        result = self.check()
        self.assertIs(result["deploys_on_push"], True)
        self.assertEqual(result["verdict"], "ask")
        self.said(result, ".github/workflows/deploy.yml deploys (deploy) on push to master")

    def test_paths_ignore_and_other_branches_keep_it_quiet(self):
        self.trunk(("ci: deploy", {".github/workflows/deploy.yml":
                                   DEPLOY.format(extra="    paths-ignore: ['docs/**']"),
                                   ".github/workflows/prod.yml": DEPLOY.replace("[master]", "[prod]").format(extra=""),
                                   ".github/workflows/ci.yml": TESTS_ONLY}))
        self.change("docs: b", {"docs/b.md": "b\n"})
        result = self.check()
        self.assertIs(result["deploys_on_push"], False)
        self.assertEqual(result["verdict"], "push")
        self.said(result, "paths-ignore")
        self.said(result, "leave out master")

    def test_a_workflow_run_chain_deploys(self):
        chained = ("name: Ship\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n"
                   "    branches: [master]\njobs:\n  ship:\n    steps:\n      - run: flyctl deploy\n")
        self.trunk(("ci: ship", {".github/workflows/ci.yml": TESTS_ONLY, ".github/workflows/ship.yml": chained}))
        self.change("feat: b", {"b.ts": "b\n"})
        result = self.check()
        self.assertIs(result["deploys_on_push"], True)
        self.said(result, "after CI")

    def test_a_platform_config_is_unknown_and_asks(self):
        self.trunk(("feat: worker", {"servers/api/wrangler.toml": "name = 'api'\n"}))
        self.change("docs: b", {"docs/b.md": "b\n"})
        result = self.check()
        self.assertEqual(result["deploys_on_push"], "unknown")
        self.assertEqual(result["verdict"], "ask")
        self.said(result, "servers/api/wrangler.toml")

    def test_docs_that_say_a_push_deploys_make_it_unknown(self):
        self.trunk(("docs: readme", {"README.md": "# x\n\nEvery push to master deploys the site.\n"}))
        self.change("feat: b", {"b.ts": "b\n"})
        result = self.check()
        self.assertEqual(result["deploys_on_push"], "unknown")
        self.said(result, "README.md: Every push to master deploys")


class SkipCiTest(RepoCase):
    def setUp(self):
        super().setUp()
        self.trunk(("ci: deploy", {".github/workflows/deploy.yml": DEPLOY.format(extra="")}),
                   ("docs: notes [skip ci]", {"docs/a.md": "a\n"}),
                   ("feat: a", {"src/a.ts": "a\n"}))

    def test_a_quiet_stack_in_a_skip_ci_repo_is_marked_and_pushes(self):
        self.change("docs: b", {"docs/b.md": "b\n"})
        self.change("test: b", {"tests/test_b.py": "b\n", ".tstack/memo/index.tsv": "x\n"})
        result = self.check()
        self.assertTrue(result["skip_ci_habit"])
        self.assertTrue(result["suggest_skip_ci"])
        self.assertEqual(result["verdict"], "ask")
        self.said(result, "1 of the last 3 trunk commits carry [skip ci]")
        self.said(result, "--apply-skip-ci would mark the head")
        applied = self.check("--apply-skip-ci")
        self.assertTrue(applied["skip_ci_applied"])
        self.assertTrue(applied["skip_ci_marked"])
        self.assertFalse(applied["suggest_skip_ci"])
        self.assertEqual(applied["head"]["subject"], "test: b [skip ci]")
        self.assertEqual(applied["stack"][0]["subject"], "docs: b")
        self.assertEqual(applied["verdict"], "push")
        self.assertTrue(any("[skip ci] on the head stops" in r for r in applied["reasons"]))
        again = self.check("--apply-skip-ci")
        self.assertNotIn("skip_ci_applied", again)
        self.assertEqual(again["head"]["subject"], "test: b [skip ci]")
        self.assertEqual(again["verdict"], "push")

    def test_the_marker_goes_on_the_subject_and_keeps_the_body(self):
        self.change("docs: b\n\nWhy it changed.\n\nClaude-Session: x", {"docs/b.md": "b\n"})
        self.check("--apply-skip-ci")
        description = jj(self.repo, "log", "--no-graph", "-r", "@-", "-T", "description")
        self.assertEqual(description, "docs: b [skip ci]\n\nWhy it changed.\n\nClaude-Session: x\n")

    def test_code_in_the_stack_gets_no_marker_and_asks(self):
        self.change("docs: b", {"docs/b.md": "b\n"})
        self.change("feat: c", {"src/c.ts": "c\n"})
        result = self.check("--apply-skip-ci")
        self.assertFalse(result["suggest_skip_ci"])
        self.assertNotIn("skip_ci_applied", result)
        self.assertEqual(result["verdict"], "ask")
        self.said(result, "src/c.ts")

    def test_the_bin_link(self):
        self.assertEqual((ROOT / "bin" / "land-check").resolve(), CHECK.resolve())
        self.assertTrue(os.access(CHECK, os.X_OK))


class NoHabitTest(RepoCase):
    def test_no_habit_no_marker_even_for_docs(self):
        self.trunk(("ci: deploy", {".github/workflows/deploy.yml": DEPLOY.format(extra="")}))
        self.change("docs: b", {"docs/b.md": "b\n"})
        result = self.check("--apply-skip-ci")
        self.assertFalse(result["skip_ci_habit"])
        self.assertFalse(result["suggest_skip_ci"])
        self.assertEqual(result["verdict"], "ask")


if __name__ == "__main__":
    unittest.main()
