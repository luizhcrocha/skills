"""Tests for scripts/gates' scope table: which suites a changed path runs.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import contextlib
import io
import os
import sys
import tempfile
import time
import unittest
from unittest import mock
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

sys.dont_write_bytecode = True
_loader = SourceFileLoader("gates", str(ROOT / "scripts" / "gates"))
gates = module_from_spec(spec_from_loader("gates", _loader))
_loader.exec_module(gates)


def suites(*paths):
    return list(gates.choose(list(paths)))


class Scope(unittest.TestCase):
    def test_fleet_source_runs_the_ts_fleet_and_the_oracle(self):
        self.assertEqual(suites("fleet/src/ledger/state.ts"), [*gates.FLEET_TS, "test-fleet"])

    def test_page_source_runs_the_page_suites_alone(self):
        self.assertEqual(suites("fleet/page/src/app.tsx", "skills/productivity/coordinator/assets/dashboard.html"),
                         ["test-page", "test-fleet", "test-coordinator-page"])

    def test_oracle_runs_against_both_fleets_without_the_ts_fleets_own_checks(self):
        self.assertEqual(suites("fleet/oracle/run.py"), [*gates.FLEET_TS[1:], "test-fleet"])

    def test_python_fleet_runs_its_tests_and_the_oracle(self):
        self.assertEqual(suites("skills/productivity/coordinator/scripts/state.py"), ["test-coordinator", "test-fleet"])

    def test_coordinator_suite_absorbs_page_mjs(self):
        self.assertEqual(suites("fleet/page/src/app.tsx", "skills/productivity/coordinator/tests/test_state.py"),
                         ["test-coordinator", "test-page"])

    def test_lint_runs_every_ts_suite(self):
        self.assertEqual(suites("lint/ts/tstack/rules/x.ts"), ["test-scripts", "test-fleet-ts-own", "test-page", "test-lint-ts"])

    def test_scripts_run_test_scripts(self):
        self.assertEqual(suites("scripts/land-check", "scripts/tests/test_gates.py"), ["test-scripts"])

    def test_prose_runs_validate_alone(self):
        self.assertEqual(suites("README.md", "fleet/SPEC.md", "docs/tstack-plan.md"), ["validate"])

    def test_skill_markdown_runs_the_link_and_sources_checks(self):
        self.assertEqual(suites("skills/engineering/lang-ts/SKILL.md"), ["test-scripts", "validate"])

    def test_agent_definitions_run_the_model_check(self):
        self.assertEqual(suites("agents/advisor.md"), ["test-scripts", "validate"])

    def test_worker_brief_template_runs_both_fleets(self):
        self.assertEqual(suites("skills/productivity/coordinator/assets/brief.md"),
                         ["test-coordinator", *gates.FLEET_TS, "test-fleet"])

    def test_unmatched_runs_everything(self):
        self.assertEqual(suites("justfile"), list(gates.EVERYTHING))
        self.assertEqual(suites("README.md", "upstreams.toml"), list(gates.EVERYTHING))

    def test_every_reason_names_its_path(self):
        why = gates.choose(["fleet/src/a.ts", "justfile"])
        self.assertTrue(all(any(r.startswith("fleet/src/a.ts") for r in why[s]) for s in (*gates.FLEET_TS, "test-fleet")))
        self.assertTrue(any("no pattern matches" in r for r in why["test-page"]))

    def test_full_gate_is_every_suite_once(self):
        self.assertEqual(sorted(gates.FULL), sorted(set(gates.SUITES) - {"test-coordinator-page", "validate"}))


if __name__ == "__main__":
    unittest.main()


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    stat = Path(f"/proc/{pid}/stat")
    return not stat.exists() or stat.read_text().rsplit(")", 1)[1].split()[0] != "Z"


class TimeLimit(unittest.TestCase):
    """A hung suite fails the gate at its limit, and nothing it started outlives it."""

    def fake_suite(self, tmp: Path) -> tuple[Path, Path]:
        pidfile = tmp / "child.pid"
        script = tmp / "suite.sh"
        script.write_text(f"#!/bin/sh\necho started\nsleep 300 &\necho $! > {pidfile}\nfor i in 1 2 3; do echo line $i; done\nwait\n")
        script.chmod(0o755)
        return script, pidfile

    def test_a_suite_past_its_limit_is_killed_with_its_process_group_and_its_output_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            script, pidfile = self.fake_suite(Path(tmp))
            started = time.monotonic()
            code, timed_out, secs, out = gates.run_limited([str(script)], 1, cwd=Path(tmp))
            self.assertTrue(timed_out)
            self.assertLess(time.monotonic() - started, 10)
            self.assertIn("line 3", out)
            child = int(pidfile.read_text())
            deadline = time.monotonic() + 5
            while _alive(child) and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertFalse(_alive(child), "the suite's background child is gone with its group")

    def test_a_timed_out_suite_gets_sigterm_first_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "cleaned"
            script = Path(tmp) / "suite.sh"
            script.write_text(f"#!/bin/sh\ntrap 'sleep 0.5; echo done > {marker}; exit 0' TERM\necho started\nwhile :; do sleep 0.1; done\n")
            script.chmod(0o755)
            code, timed_out, secs, _ = gates.run_limited([str(script)], 1, cwd=Path(tmp))
            self.assertTrue(timed_out)
            self.assertEqual(marker.read_text().strip(), "done", "its TERM handler ran to the end before any SIGKILL")
            self.assertLess(secs, 9)

    def test_a_suite_that_ignores_sigterm_is_killed_after_the_grace(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "suite.sh"
            script.write_text("#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 0.1; done\n")
            script.chmod(0o755)
            with mock.patch.object(gates, "TERM_GRACE", 1.0):
                started = time.monotonic()
                code, timed_out, secs, _ = gates.run_limited([str(script)], 1, cwd=Path(tmp))
            self.assertTrue(timed_out)
            self.assertGreaterEqual(secs, 1.9)
            self.assertLess(time.monotonic() - started, 6)

    def test_a_suite_inside_its_limit_keeps_its_exit_code(self):
        code, timed_out, _, out = gates.run_limited(["sh", "-c", "echo ok; exit 3"], 30)
        self.assertEqual((code, timed_out, out), (3, False, "ok\n"))

    def test_the_gate_reports_a_timeout_as_fail_with_the_seconds_and_the_last_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            script, _ = self.fake_suite(Path(tmp))
            (Path(tmp) / "justfile").write_text("hang:\n    ./suite.sh\n")
            with mock.patch.object(gates, "REPO", Path(tmp)):
                recipe, code, secs, out = gates._run("hang", 1)
            self.assertEqual((recipe, code), ("hang", gates.TIMED_OUT))
            self.assertIn("timed out after 1s", out)
            self.assertIn("line 3", out)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                gates._report(recipe, code, secs, out)
            self.assertIn("hang: FAIL (timed out after 1s)", buf.getvalue())

    def test_every_suite_has_a_limit(self):
        for recipe in (*gates.SUITES, *{d for deps in gates.SUITES.values() for d in deps}):
            self.assertIn(recipe, gates.LIMITS)
