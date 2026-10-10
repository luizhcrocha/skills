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
sys.path.insert(0, str(ROOT / "scripts"))
import run_limits  # noqa: E402  the module gates takes run_limited from


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

    def test_the_shard_runner_runs_every_python_suite_it_shards(self):
        self.assertEqual(suites("scripts/unittest_shards.py"), ["test-scripts", "test-coordinator", *gates.FLEET_TS, "test-fleet"])

    def test_the_runners_shared_module_runs_every_suite_a_runner_runs(self):
        self.assertEqual(suites("scripts/run_limits.py"), ["test-scripts", "test-coordinator", *gates.FLEET_TS, "test-fleet"])

    def test_the_bun_file_runner_runs_the_ts_fleets_own_checks(self):
        self.assertEqual(suites("scripts/bun_files.py"), ["test-scripts", gates.FLEET_TS[0]])

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
            with mock.patch.object(run_limits, "TERM_GRACE", 1.0):
                started = time.monotonic()
                code, timed_out, secs, _ = gates.run_limited([str(script)], 1, cwd=Path(tmp))
            self.assertTrue(timed_out)
            self.assertGreaterEqual(secs, 1.9)
            self.assertLess(time.monotonic() - started, 6)

    def test_a_suite_inside_its_limit_keeps_its_exit_code(self):
        code, timed_out, _, out = gates.run_limited(["sh", "-c", "echo ok; exit 3"], 30)
        self.assertEqual((code, timed_out, out), (3, None, "ok\n"))

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


class Caps(unittest.TestCase):
    """The gate's caps: workers per suite, a suite's start held for memory, a TMPDIR of its own on tmpfs."""

    def test_workers_per_suite_are_an_eighth_of_the_cores_lowered_to_fit_half_the_memory(self):
        suites = list(gates.FULL)
        sharded = sum(2 if s in gates.NICE else 1 for s in suites if s in gates.SHARDED)
        with mock.patch.object(os, "cpu_count", return_value=32):
            self.assertEqual(gates.jobs_per_suite(suites, 10**6), 4)
            self.assertEqual(gates.jobs_per_suite(suites, 2 * 3 * gates.MB_PER_JOB * sharded), 3)
            self.assertEqual(gates.jobs_per_suite(suites, 100), 1, "never zero")
            self.assertEqual(gates.jobs_per_suite(suites, None), 4)

    def setUp(self):
        for patch in (mock.patch.object(gates, "_waiting_said", set()), mock.patch.object(gates, "_first_wait", {}),
                      mock.patch.object(gates, "mem_total_mb", return_value=64000)):
            patch.start()
            self.addCleanup(patch.stop)

    def test_a_suite_waits_while_memory_is_short(self):
        need = gates.MEM_MB["test-page"] + gates.RESERVE_MB
        old = time.monotonic() - gates.RAMP_S - 1
        with mock.patch.object(gates, "mem_available_mb", return_value=need - 1), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertTrue(gates._fits("test-page", []), "alone, it needs no reserve")
            self.assertFalse(gates._fits("test-page", [("test-scripts", old)]))
        self.assertIn("test-page waits for memory", out.getvalue())
        with mock.patch.object(gates, "mem_available_mb", return_value=need):
            self.assertTrue(gates._fits("test-page", [("test-scripts", old)]))
            self.assertFalse(gates._fits("test-page", [("test-scripts", time.monotonic())]),
                             "a suite started a moment ago still counts its estimate: it has not reached its peak")

    def test_the_first_suite_waits_for_its_peak_or_half_the_ram_then_starts_warned(self):
        peak = gates.MEM_MB["test-page"]
        with mock.patch.object(gates, "mem_available_mb", return_value=peak - 1), \
                mock.patch.object(gates, "FIRST_WAIT_S", 0.3), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertFalse(gates._fits("test-page", []))
            self.assertFalse(gates._fits("test-page", []))
            self.assertEqual(out.getvalue().count("test-page waits for memory"), 1, "said once")
            time.sleep(0.35)
            self.assertTrue(gates._fits("test-page", []), "after FIRST_WAIT_S it starts anyway")
        self.assertIn(f"gates: warning: test-page starts with {peak - 1} MB available, under the {peak} MB", out.getvalue())
        with mock.patch.object(gates, "mem_available_mb", return_value=peak), contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(gates._fits("test-page", []), "its peak is free")
        with mock.patch.object(gates, "mem_available_mb", return_value=peak // 2 + 1), \
                mock.patch.object(gates, "mem_total_mb", return_value=peak), contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(gates._fits("test-page", []), "half the RAM is free: its peak may never be")

    def test_the_sweep_removes_day_old_tmpdirs_of_gates_and_of_shard_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            names = ("tstack-gates-old", "tstack-tests-old", "tstack-gates-new", "tstack-tests-new", "other-old")
            for name in names:
                (root / name).mkdir()
                if name.endswith("old"):
                    day_ago = time.time() - 86400 - 60
                    os.utime(root / name, (day_ago, day_ago))
            with mock.patch.object(gates, "tmp_root", return_value=root):
                base = gates._tmp_base()
            self.assertEqual(sorted(p.name for p in root.iterdir() if p != base),
                             ["other-old", "tstack-gates-new", "tstack-tests-new"])

    def test_a_niced_suite_runs_at_that_priority(self):
        code, _, _, out = gates.run_limited(["sh", "-c", "cut -d' ' -f19 /proc/self/stat"], 30, nice=7)
        self.assertEqual((code, int(out) - os.nice(0)), (0, 7))

    def test_every_suite_has_a_memory_estimate(self):
        self.assertEqual(set(gates.MEM_MB), set(gates.SUITES))

    def test_each_suite_gets_its_own_tmpdir_and_the_cap_kept_only_when_it_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "root").mkdir()
            (tmp / "justfile").write_text(
                "good:\n    echo \"$TMPDIR $TSTACK_TEST_JOBS\" > seen-good; touch \"$TMPDIR/x\"\n"
                "bad:\n    echo \"$TMPDIR\" > seen-bad; touch \"$TMPDIR/x\"; exit 1\n")
            with mock.patch.object(gates, "REPO", tmp), mock.patch.object(gates, "SUITES", {"good": (), "bad": ()}), \
                    mock.patch.object(gates, "tmp_root", return_value=tmp / "root"), \
                    mock.patch.object(gates, "jobs_per_suite", return_value=3), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(gates.run(["good", "bad"], 2), 1)
            good_tmp, jobs = (tmp / "seen-good").read_text().split()
            bad_tmp = Path((tmp / "seen-bad").read_text().strip())
            self.assertEqual(jobs, "3")
            self.assertEqual(Path(good_tmp).parent, bad_tmp.parent)
            self.assertEqual(bad_tmp.parent.parent, tmp / "root")
            self.assertFalse(Path(good_tmp).exists(), "a passing suite's TMPDIR goes")
            self.assertTrue((bad_tmp / "x").exists(), "a failing suite's TMPDIR stays for its failure")
            self.assertIn(f"kept bad's TMPDIR, {bad_tmp}", out.getvalue())
            self.assertRegex(out.getvalue(), r"PASS  good .*\n  FAIL  bad ")

