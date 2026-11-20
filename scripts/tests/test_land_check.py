"""Tests for scripts/land-check, Land's verdict on a push, against throwaway jj
repos that push to a bare git remote.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CHECK = ROOT / "scripts" / "land-check"
HAVE_JJ = shutil.which("jj") is not None and shutil.which("git") is not None
ENV = {**os.environ, "JJ_EDITOR": "true", "EDITOR": "true", "JJ_USER": "Test", "JJ_EMAIL": "test@example.com",
       "JJ_CONFIG": "", "FLEET_HOME": tempfile.mkdtemp(prefix="land-check-registry-")}  # no fleet: the turn never applies
atexit.register(shutil.rmtree, ENV["FLEET_HOME"], True)

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


def jj(repo, *args, at=None):
    """jj in repo; `at` (an RFC 3339 time) stamps the commits it writes, as JJ_TIMESTAMP does."""
    env = {**ENV, "JJ_TIMESTAMP": at} if at else ENV
    r = subprocess.run(["jj", "--no-pager", "--color=never", *args], cwd=repo, env=env, capture_output=True,
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
                           (".tstack/reviews/abcd.tsv", None), (".tstack/memo/index.tsv", None),
                           ("scripts/tests/test_x.py", "tests"),
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

    def trunk(self, *commits, at=None):
        """Commits on master, pushed: (subject, {path: text}) each."""
        for subject, files in commits:
            for path, text in files.items():
                write(self.repo, path, text)
            jj(self.repo, "commit", "-m", subject, at=at)
        jj(self.repo, "bookmark", "set", "master", "-r", "@-", at=at)
        jj(self.repo, "git", "push", "--bookmark", "master", at=at)

    def change(self, subject, files, at=None):
        for path, text in files.items():
            write(self.repo, path, text)
        jj(self.repo, "commit", "-m", subject, at=at)

    def check(self, *args, home=None, cwd=None):
        """land-check's JSON; `home` is the fleet registry ($FLEET_HOME) whose gate it reads, `cwd` the workspace."""
        env = {**ENV, "FLEET_HOME": str(home)} if home else ENV
        r = subprocess.run([sys.executable, str(CHECK), "-R", str(cwd or self.repo), "-b", "master", *args],
                           capture_output=True, text=True, env=env)
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

    def test_a_description_with_a_line_separator_is_read_whole(self):
        self.trunk(("feat: a\u2028b\u2029c", {"a.ts": "a\n"}))
        self.change("feat: b\u2028c", {"b.ts": "b\n"})
        result = self.check()
        self.assertEqual([r["subject"] for r in result["stack"]], ["feat: b\u2028c"])
        self.assertEqual(result["verdict"], "push")

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
        self.change("test: b", {"tests/test_b.py": "b\n"})
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


class LinesTest(RepoCase):
    def test_a_diff_with_invalid_utf8_still_checks(self):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        (self.repo / "golden.bin").write_bytes(b"ok \xff\xfe not utf-8\n")
        self.change("feat: golden with invalid utf-8", {})
        self.assertEqual(self.check()["verdict"], "push")


class PreGateTest(RepoCase):
    """`land-check --pre-gate` runs before the full gate takes the slot: it fails when there is no single head with
    work to push, so a 4 to 13 minute gate never runs on nothing. `--require-reviews`, which `fleet land` passes, is
    accepted and changes nothing: no stack needs a recorded review (Luiz, 2026-11-20)."""

    def pre_gate(self, *args):
        return subprocess.run([sys.executable, str(CHECK), "-R", str(self.repo), "-b", "master", "--pre-gate", *args],
                              capture_output=True, text=True, env=ENV)

    def test_a_big_stack_goes_to_the_gate_with_or_without_require_reviews(self):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        self.change("feat: auth", {"src/auth/b.ts": "".join(f"line {i}\n" for i in range(2001))})
        for args in ((), ("--require-reviews",)):
            with self.subTest(args=args):
                r = self.pre_gate(*args)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stderr, "")
                result = json.loads(r.stdout)
                self.assertNotIn("review", result)
                self.assertNotIn("reviews", result)

    def test_require_reviews_leaves_the_verdict_alone(self):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        self.change("feat: b", {"b.ts": "".join(f"line {i}\n" for i in range(400))})
        self.assertEqual(self.check("--require-reviews")["verdict"], "push")

    def test_work_with_two_heads_or_nothing_to_push_stops_before_the_gate(self):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        r = self.pre_gate()
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("land-check: --pre-gate: nothing to push", r.stderr)
        self.change("feat: b", {"b.ts": "b\n"})
        b = jj(self.repo, "log", "--no-graph", "-r", "@-", "-T", "change_id").strip()
        self.change("feat: c", {"c.ts": "c\n"})
        jj(self.repo, "new", b)
        self.change("feat: d", {"d.ts": "d\n"})
        r = self.pre_gate("--require-reviews")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("land-check: --pre-gate: the work has 2 heads", r.stderr)

    def test_it_never_rewrites_the_head(self):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        self.change("docs: b", {"b.md": "b\n"})
        r = self.pre_gate("--apply-skip-ci")
        self.assertEqual(r.returncode, 2)
        self.assertIn("not allowed with argument", r.stderr)


class FingerprintTest(RepoCase):
    """`land-check --fingerprint REV`, the patch fingerprint `fleet land` puts in its ticket: the same on any clone
    and across a rebase, changed by a fold."""

    def stack(self):
        """master, then one change; its change id."""
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        self.change("feat: b", {"b.ts": self.lines(30)})
        return jj(self.repo, "log", "--no-graph", "-r", "@-", "-T", "change_id.short(12)").strip()

    def lines(self, n):
        return "".join(f"line {i}\n" for i in range(n))

    def fold(self, change):
        """A nit fix squashed into change: one line of b.ts rewritten."""
        write(self.repo, "b.ts", self.lines(30).replace("line 7\n", "line seven\n"))
        jj(self.repo, "squash", "--into", change)

    def rebase(self, change):
        """master moves on (another file), and change is rebased onto it, content untouched."""
        jj(self.repo, "new", "master")
        write(self.repo, "c.ts", "c\n")
        jj(self.repo, "commit", "-m", "feat: c")
        jj(self.repo, "bookmark", "set", "master", "-r", "@-")
        jj(self.repo, "git", "push", "--bookmark", "master")
        jj(self.repo, "rebase", "-s", change, "-d", "master")
        jj(self.repo, "new", change)

    def fingerprint(self, change, cwd=None):
        r = subprocess.run([sys.executable, str(CHECK), "-R", str(cwd or self.repo), "--fingerprint", change],
                           capture_output=True, text=True, env=ENV)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def test_a_fresh_clone_reads_the_same_fingerprint(self):
        change = self.stack()
        patch = self.fingerprint(change)
        self.assertRegex(patch, r"^[0-9a-f]{16}$")
        jj(self.repo, "bookmark", "create", "feature", "-r", change)
        jj(self.repo, "git", "push", "--bookmark", "feature")
        clone = self.tmp / "clone"
        jj(self.tmp, "git", "clone", str(self.tmp / "remote.git"), str(clone))
        self.assertEqual(self.fingerprint(change, cwd=clone), patch)

    def test_a_binary_file_changed_changes_the_fingerprint(self):
        change = self.stack()
        write(self.repo, "logo.bin", "a\x00b")
        jj(self.repo, "squash", "--into", change)
        patch = self.fingerprint(change)
        write(self.repo, "logo.bin", "a\x00c")
        jj(self.repo, "squash", "--into", change)
        self.assertNotEqual(self.fingerprint(change), patch)

    def test_a_fingerprint_survives_a_rebase_and_a_fold_changes_it(self):
        change = self.stack()
        patch = self.fingerprint(change)
        self.rebase(change)
        self.assertEqual(self.fingerprint(change), patch)
        self.fold(change)
        self.assertNotEqual(self.fingerprint(change), patch)

    def test_a_revision_jj_cannot_read_exits_2(self):
        self.stack()
        r = subprocess.run([sys.executable, str(CHECK), "-R", str(self.repo), "--fingerprint", "nosuchrev"],
                           capture_output=True, text=True, env=ENV)
        self.assertEqual(r.returncode, 2)
        self.assertIn("jj cannot read nosuchrev", r.stderr)


class LandingBookmarkTest(RepoCase):
    """landing_bookmarks: what the push gate (hooks/tstack-hook.py) reads as the landing bookmark."""

    def test_trunk_names_it(self):
        self.assertEqual(lc.landing_bookmarks(self.tmp), set())  # not a repo
        self.assertEqual(lc.landing_bookmarks(self.repo), {"main", "master", "trunk"})  # nothing says yet
        self.trunk(("a", {"a": "a\n"}))
        (self.repo / "sub").mkdir()
        self.assertEqual(lc.landing_bookmarks(self.repo / "sub"), {"master"})

    def test_the_docs_name_it_too(self):
        self.trunk(("a", {"a": "a\n"}))
        write(self.repo, "CLAUDE.md", "Publish: `jj bookmark set nix -r @-` then `jj git push --bookmark nix`.\n"
                                      "Never `jj bookmark set <bookmark>` by hand.\n")
        self.assertEqual(lc.landing_bookmarks(self.repo), {"master", "nix"})


class FleetCliTest(unittest.TestCase):
    """land-check finds the fleet CLI as bare `fleet` on PATH, else none, and says which."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()

    def on_path(self):
        cli = self.bin / "fleet"
        cli.write_text("#!/bin/sh\necho 'turn: from PATH'\n")
        cli.chmod(0o755)
        return cli

    def test_fleet_on_path_is_the_cli(self):
        cli = self.on_path()
        self.assertEqual(lc.fleet_cli(path=str(self.bin)), cli)

    def test_with_no_fleet_on_path_there_is_no_cli(self):
        self.assertIsNone(lc.fleet_cli(path=str(self.bin)))

    def test_the_turn_runs_the_cli_on_path(self):
        self.on_path()
        saved = os.environ["PATH"]
        self.addCleanup(os.environ.__setitem__, "PATH", saved)
        os.environ["PATH"] = f"{self.bin}:{saved}"
        self.assertEqual(lc.landing_turn(), (0, "turn: from PATH"))

    def test_with_no_cli_the_turn_is_none_and_never_raises(self):
        saved = os.environ["PATH"]
        self.addCleanup(os.environ.__setitem__, "PATH", saved)
        os.environ["PATH"] = str(self.bin)
        self.assertIsNone(lc.landing_turn())

    def test_the_json_names_the_cli_or_null(self):
        self.assertEqual(lc.with_fleet({"reasons": []}, None)["fleet_cli"], None)
        self.assertEqual(lc.with_fleet({"reasons": []}, Path("/x/fleet"))["fleet_cli"], "/x/fleet")


class FleetTimeoutTest(unittest.TestCase):
    """A `fleet turn` that does not answer in time is killed with its whole process group."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    @unittest.skipUnless(shutil.which("bun"), "landing_turn runs the CLI only where Bun is")
    def test_a_hung_cli_is_killed_with_its_children(self):
        pids = self.tmp / "pids"
        cli = self.tmp / "fleet"
        cli.write_text(f"#!/bin/sh\nsleep 30 &\necho $! >{pids}\nwait\n")
        cli.chmod(0o755)
        started = time.monotonic()
        self.assertIsNone(lc.landing_turn(cli, timeout=1))
        self.assertLess(time.monotonic() - started, 10)
        child = int(pids.read_text())
        for _ in range(50):
            if subprocess.run(["kill", "-0", str(child)], capture_output=True).returncode != 0:
                break
            time.sleep(0.1)
        else:
            self.fail(f"the CLI's child {child} outlived the timeout")


class FreezeTest(RepoCase):
    """A landing gate of this repository, running or passed and waiting for its push, freezes the repository's other
    pushes: on 11-05 a 23-minute landing gate passed, but another lane pushed master during its run, and it gated
    again. The landing's own push goes. The holds are in the shape fleet/src/gate.ts writes them: `made()` for a
    running landing, `awaitPush()` for one that passed."""

    def setUp(self):
        super().setUp()
        self.home = self.tmp / "registry"
        (self.home / "gate").mkdir(parents=True)
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        self.change("feat: b", {"b.ts": "b\n"})
        self.runner = subprocess.Popen(["sleep", "600"])  # the other lane's `gate run`: alive, not an ancestor
        self.addCleanup(self.runner.wait)
        self.addCleanup(self.runner.kill)

    def store(self, workspace=None):
        return str((Path(workspace or self.repo) / ".jj" / "repo").resolve())

    def hold(self, **extra):
        """A running landing gate's hold, another workspace's unless `workspace` says."""
        now = datetime.now(timezone.utc)
        stamp = lambda minutes: (now + timedelta(minutes=minutes)).isoformat(timespec="seconds")
        pid = self.runner.pid
        held = {"fleet": "gerador", "kind": "fleet", "what": "just test", "since": stamp(-3), "until": stamp(20),
                "token": "1ee395cb", "pid": pid, "started": "123456", "unit": f"fleet-gate-1ee395cb-{pid}",
                "budget": 64 * 2 ** 30, "cap": 8 * 2 ** 30, "cpus": 16, "landing": True, "repo": self.store(),
                "workspace": str(self.tmp / "gerador"), "ends": stamp(9), **extra}
        return {k: v for k, v in held.items() if v is not None}

    def pushed(self, **extra):
        """The same landing passed, holding the landing turn for its push."""
        gone = {"pid", "started", "unit", "cpus", "light", "ends", "backfill"}
        later = (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat(timespec="seconds")
        kept = {k: v for k, v in self.hold().items() if k not in gone}
        held = {**kept, "cap": 64 * 2 ** 20, "until": later, "pushing": True, **extra}
        return {k: v for k, v in held.items() if v is not None}

    def gate(self, *holds, runs=()):
        (self.home / "gate" / "gate.json").write_text(json.dumps({"v": 2, "holds": list(holds)}))
        (self.home / "gate" / "runs.jsonl").write_text("".join(json.dumps(r) + "\n" for r in runs))

    def test_another_lanes_running_landing_gate_stops_the_push(self):
        ends = (datetime.now(timezone.utc) + timedelta(minutes=9)).astimezone()
        self.gate(self.hold(ends=ends.isoformat(timespec="seconds")))
        result = self.check(home=self.home)
        self.assertEqual(result["verdict"], "stop")
        self.assertEqual([(f["fleet"], f["pushing"]) for f in result["freeze"]], [("gerador", False)])
        self.said(result, f"gerador is running a landing gate of this repository (just test), expected to "
                          f"end by {ends.strftime('%H:%M')}")
        self.said(result, "Wait until it has pushed or ended")

    def test_another_lanes_passed_landing_holds_the_turn_for_its_push(self):
        self.gate(self.pushed())
        result = self.check(home=self.home)
        self.assertEqual(result["verdict"], "stop")
        self.said(result, "gerador's landing gate of this repository passed and holds the landing turn for its push")
        self.said(result, "--push-token")

    def test_a_lane_checking_during_its_own_background_landing_gate_is_not_frozen(self):
        self.gate(self.hold(workspace=str(self.repo)))
        result = self.check(home=self.home)
        self.assertEqual(result["verdict"], "push")
        self.assertNotIn("freeze", result)

    def test_the_landing_gates_own_push_goes(self):
        self.gate(self.pushed())
        self.assertEqual(self.check("--push-token", "1ee395cb", home=self.home)["verdict"], "push")
        self.gate(self.pushed(workspace=str(self.repo)))
        self.assertEqual(self.check(home=self.home)["verdict"], "push")
        own = {"name": "gerador", "what": "just test", "repo": self.store(), "workspace": str(self.repo),
               "landing": True, "push_token": "1ee395cb"}
        old = self.pushed(workspace=None)  # an older fleet's hold names no workspace: its run's line does
        self.gate(old, runs=[{"name": "x", "push_token": "0000aaaa", "workspace": "/elsewhere"}, own])
        result = self.check(home=self.home)
        self.assertEqual(result["verdict"], "push")
        self.assertNotIn("freeze", result)

    def test_a_landing_from_another_workspace_of_the_same_repository_stops(self):
        other = self.tmp / "other"
        jj(self.repo, "workspace", "add", "--name", "other", "-r", "@-", str(other))
        self.gate(self.pushed(workspace=str(self.repo)))
        self.assertEqual(self.check(home=self.home, cwd=other)["verdict"], "stop")
        self.gate(self.hold(workspace=str(self.repo)))
        self.assertEqual(self.check(home=self.home, cwd=other)["verdict"], "stop")

    def test_what_does_not_freeze(self):
        for holds in ([self.hold(repo="/elsewhere/.jj/repo")], [self.hold(landing=None, repo=None, workspace=None)],
                      [self.pushed(until="2026-01-05T10:00:00+00:00")], [self.hold(pid=2 ** 22 + 7)]):
            self.gate(*holds)
            self.assertEqual(self.check(home=self.home)["verdict"], "push", holds)
        (self.home / "gate" / "gate.json").write_text('{"fleet": "x", "what": "y", "since": "z", "until": "w"}')
        self.assertEqual(self.check(home=self.home)["verdict"], "push")
        (self.home / "gate" / "gate.json").write_text("not json")
        self.assertEqual(self.check(home=self.home)["verdict"], "push")
        (self.home / "gate" / "gate.json").unlink()
        self.assertEqual(self.check(home=self.home)["verdict"], "push")


class GateNeededTest(RepoCase):
    """A stack of docs alone fast-forwards without a gate run: nothing the gate runs reads it. Tests,
    tooling, and a Markdown file among code (a skill's SKILL.md, which tstack's validate reads) still need the gate."""

    def needed(self, files):
        self.trunk(("feat: a", {"a.ts": "a\n"}))
        self.change("docs: d", files)
        return self.check()["gate_needed"]

    def test_docs_need_no_gate(self):
        self.assertIs(self.needed({"README.md": "r\n", "CONTEXT.md": "c\n", "docs/adr/0003-x.md": "a\n",
                                   "docs/guide.md": "g\n", "adr/0001-y.md": "a\n"}), False)

    def test_what_a_gate_may_read_or_compile_is_not_gate_free(self):
        free = ["README.md", "CONTEXT.md", "LICENSE", "docs/guide.md", "docs/notes.txt", "docs/adr/0003-x.md",
                "doc/intro.md", "adr/0001-y.md", "adrs/0002-z.txt"]
        gated = ["skills/x/README.md", "skills/x/docs/a.md", "skills/x/adr/0001.md", "fleet/README.md",
                 "fleet/CONTEXT.md", "crates/core/README.md", "docs/page.mdx", "index.mdx", "docs/requirements.txt",
                 "docs/constraints.txt", "docs/conf.rst", ".tstack/hooks/pre.sh", ".tstack/reviews/abcd.tsv",
                 ".tstack/reviews/sub/abcd.tsv", ".tstack/config.toml", ".tstack/memo/notes/01M6.md",
                 ".tstack/memo/index.tsv", "requirements.txt",
                 "CMakeLists.txt", "docs/CMakeLists.txt", "notes.txt"]
        self.assertEqual([p for p in free if not lc.gate_free(p)], [])
        self.assertEqual([p for p in gated if lc.gate_free(p)], [])

    def test_a_markdown_file_among_code_needs_the_gate(self):
        self.assertIs(self.needed({"docs/a.md": "a\n", "skills/x/SKILL.md": "s\n"}), True)

    def test_tests_tooling_and_code_under_docs_need_the_gate(self):
        for files in ({"docs/a.md": "a\n", "scripts/tests/test_x.py": "t\n"}, {"justfile": "j\n"},
                      {"docs/build.ts": "b\n"}):
            with self.subTest(files=files):
                self.setUp()
                self.assertIs(self.needed(files), True)


if __name__ == "__main__":
    unittest.main()
