"""Tests for scripts/unittest_shards.py: the units it cuts, its totals and exit codes, its caps and its TMPDIR.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
RUNNER = ROOT / "scripts" / "unittest_shards.py"
sys.path.insert(0, str(ROOT / "scripts"))
import unittest_shards as shards  # noqa: E402


def write(d: Path, name: str, body: str) -> None:
    (d / name).write_text(textwrap.dedent(body))


class Suite(unittest.TestCase):
    """A throwaway test directory, run through the runner as a subprocess."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.dir = self.tmp / "tests"
        self.dir.mkdir()

    def run_shards(self, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
        base = {k: v for k, v in os.environ.items() if k not in ("TSTACK_TEST_JOBS", "TMPDIR")}
        return subprocess.run([sys.executable, str(RUNNER), "-s", str(self.dir), "-p", "test_*.py", *args],
                              capture_output=True, text=True, timeout=120,
                              env={**base, "XDG_CACHE_HOME": str(self.tmp / "cache"), **(env or {})})


# Five tests built by load_tests, each holding its parameter on the instance; the one with 3 fails. Loaded by id, the
# five would be five copies of Param.test_it with param 0, and all would pass.
PARAMETRIZED = """\
    import unittest
    class Param(unittest.TestCase):
        def __init__(self, methodName="test_it", param=0):
            super().__init__(methodName)
            self.param = param
        def test_it(self):
            self.assertNotEqual(self.param, 3, "the planted failure: param 3")
    def load_tests(loader, tests, pattern):
        return unittest.TestSuite(Param("test_it", i) for i in range(5))
    """


class Units(Suite):
    def test_a_big_class_is_cut_in_chunks_and_a_class_with_a_fixture_stays_whole(self):
        many = "\n".join(f"    def test_{i}(self): pass" for i in range(20))
        write(self.dir, "test_big.py", f"import unittest\nclass Big(unittest.TestCase):\n{many}\n")
        write(self.dir, "test_fixed.py", f"import unittest\nclass Fixed(unittest.TestCase):\n"
                                         f"    @classmethod\n    def setUpClass(cls): pass\n{many}\n")
        saved = list(sys.path)
        self.addCleanup(lambda: (sys.path.__setitem__(slice(None), saved), sys.modules.pop("test_big", None),
                                 sys.modules.pop("test_fixed", None)))
        plan, broken = shards.units(str(self.dir), "test_*.py")
        names = sorted(u.name for u in plan)
        self.assertEqual(names, ["test_big.Big[1/3]", "test_big.Big[2/3]", "test_big.Big[3/3]", "test_fixed.Fixed"])
        self.assertEqual(sum(len(u.ids) for u in plan), 40, "every test is in one unit")
        self.assertEqual(sum(u.tests for u in plan), 40)
        self.assertEqual(len({i for u in plan for i in u.ids}), 40)
        self.assertEqual(broken, [])

    def test_a_module_with_load_tests_is_one_unit_loaded_whole(self):
        write(self.dir, "test_param.py", PARAMETRIZED)
        many = "\n".join(f"    def test_{i}(self): pass" for i in range(20))
        write(self.dir, "test_big.py", f"import unittest\nclass Big(unittest.TestCase):\n{many}\n")
        saved = list(sys.path)
        self.addCleanup(lambda: (sys.path.__setitem__(slice(None), saved), sys.modules.pop("test_param", None),
                                 sys.modules.pop("test_big", None)))
        plan, _ = shards.units(str(self.dir), "test_*.py")
        self.assertIn(shards.Unit("test_param", ["test_param"], 5), plan)
        self.assertEqual(sorted(u.name for u in plan if u.name.startswith("test_big")),
                         ["test_big.Big[1/3]", "test_big.Big[2/3]", "test_big.Big[3/3]"], "the others are cut as before")

    def test_every_test_runs_once_and_the_totals_read_as_unittests(self):
        write(self.dir, "test_a.py", """\
            import unittest
            class A(unittest.TestCase):
                def test_1(self): pass
                @unittest.skip("not here")
                def test_2(self): pass
            class B(unittest.TestCase):
                def test_3(self): pass
            """)
        done = self.run_shards("-j", "2")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("Ran 3 tests in ", done.stdout)
        self.assertIn("OK (skipped=1)", done.stdout)
        self.assertIn("3 tests in 2 units, 2 at a time", done.stdout)


class Failures(Suite):
    def test_a_failure_prints_its_unit_whole_with_a_rerun_line_and_exits_1(self):
        write(self.dir, "test_f.py", """\
            import unittest
            class Good(unittest.TestCase):
                def test_ok(self): pass
            class Bad(unittest.TestCase):
                def test_no(self): self.assertEqual(1, 2, "the planted failure")
            """)
        done = self.run_shards()
        self.assertEqual(done.returncode, 1)
        self.assertIn("--- test_f.Bad: FAIL", done.stdout)
        self.assertIn("the planted failure", done.stdout)
        self.assertIn("python3 -m unittest -v test_f.Bad", done.stdout)
        self.assertIn("FAILED (failures=1)", done.stdout)
        self.assertNotIn("test_ok", done.stdout, "a passing unit's output stays out without -v")

    def test_an_import_error_fails_the_run(self):
        write(self.dir, "test_broken.py", "import no_such_module_anywhere\n")
        write(self.dir, "test_fine.py", "import unittest\nclass T(unittest.TestCase):\n    def test_x(self): pass\n")
        done = self.run_shards()
        self.assertEqual(done.returncode, 1)
        self.assertIn("no_such_module_anywhere", done.stdout)
        self.assertIn("errors=1", done.stdout)

    def test_a_worker_that_dies_counts_as_an_error(self):
        write(self.dir, "test_die.py", "import os, unittest\nclass T(unittest.TestCase):\n    def test_x(self): os._exit(3)\n")
        done = self.run_shards()
        self.assertEqual(done.returncode, 1)
        self.assertIn("--- test_die.T: FAIL", done.stdout)

    def test_a_failing_case_built_by_load_tests_fails_the_run(self):
        write(self.dir, "test_param.py", PARAMETRIZED)
        done = self.run_shards()
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("the planted failure: param 3", done.stdout)
        self.assertIn("Ran 5 tests in ", done.stdout)
        self.assertIn("FAILED (failures=1)", done.stdout)
        self.assertIn("python3 -m unittest -v test_param", done.stdout)

    def test_an_unexpected_success_fails_the_run_and_is_counted_once(self):
        write(self.dir, "test_u.py", """\
            import unittest
            class T(unittest.TestCase):
                @unittest.expectedFailure
                def test_x(self): pass
            """)
        done = self.run_shards()
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("--- test_u.T: FAIL", done.stdout)
        summary = done.stdout.rsplit("-" * 70, 1)[1]  # the worker printed its own FAILED line above
        self.assertIn("FAILED (unexpected successes=1)", summary, "no extra error for it")

    def test_no_tests_exits_5_as_unittest_does(self):
        self.assertEqual(self.run_shards().returncode, 5)


class Environment(Suite):
    def test_the_tests_get_a_tmpdir_of_their_own_that_goes_with_the_run(self):
        out = self.tmp / "seen"
        write(self.dir, "test_t.py", f"""\
            import os, tempfile, unittest
            class T(unittest.TestCase):
                def test_x(self):
                    open({str(out)!r}, "w").write(tempfile.gettempdir())
            """)
        done = self.run_shards()
        self.assertEqual(done.returncode, 0, done.stdout)
        seen = Path(out.read_text())
        if shards.tmp_root() is not None:
            self.assertEqual(seen.parent, shards.tmp_root())
            self.assertFalse(seen.exists(), "removed after the run")

    def test_its_tmpdir_goes_when_the_run_is_terminated(self):
        if shards.tmp_root() is None:
            self.skipTest("no tmpfs to take a TMPDIR on")
        seen = self.tmp / "seen"
        write(self.dir, "test_t.py", f"""\
            import tempfile, time, unittest
            class T(unittest.TestCase):
                def test_x(self):
                    open({str(seen)!r}, "w").write(tempfile.gettempdir())
                    time.sleep(60)
            """)
        for to_group in (False, True):  # the runner alone (its handler kills the worker), then gates' kill of the group
            with self.subTest(to_group=to_group):
                seen.unlink(missing_ok=True)
                base = {k: v for k, v in os.environ.items() if k not in ("TSTACK_TEST_JOBS", "TMPDIR")}
                proc = subprocess.Popen([sys.executable, str(RUNNER), "-s", str(self.dir), "-p", "test_*.py"],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                                        env={**base, "XDG_CACHE_HOME": str(self.tmp / "cache")})
                self.addCleanup(lambda p=proc: p.poll() is None and os.killpg(p.pid, signal.SIGKILL))
                deadline = time.monotonic() + 30
                while not (seen.exists() and seen.read_text()) and time.monotonic() < deadline:
                    time.sleep(0.05)
                tmp = Path(seen.read_text())
                self.assertTrue(tmp.is_dir())
                (os.killpg if to_group else os.kill)(proc.pid, signal.SIGTERM)
                self.assertEqual(proc.wait(timeout=10), 128 + signal.SIGTERM)
                self.assertFalse(tmp.exists(), f"{tmp} was left behind")

    def test_a_tmpdir_already_set_is_kept(self):
        out = self.tmp / "seen"
        write(self.dir, "test_t.py", f"""\
            import tempfile, unittest
            class T(unittest.TestCase):
                def test_x(self):
                    open({str(out)!r}, "w").write(tempfile.gettempdir())
            """)
        self.assertEqual(self.run_shards(env={"TMPDIR": str(self.tmp)}).returncode, 0)
        self.assertEqual(out.read_text(), str(self.tmp))

    def test_the_jobs_env_sets_the_workers(self):
        write(self.dir, "test_t.py", "import unittest\nclass T(unittest.TestCase):\n    def test_x(self): pass\n")
        self.assertIn("1 units, 3 at a time", self.run_shards(env={"TSTACK_TEST_JOBS": "3"}).stdout)


class Caps(unittest.TestCase):
    def test_jobs_are_a_quarter_of_the_cores_capped_by_memory(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TSTACK_TEST_JOBS", None)
            with mock.patch.object(os, "cpu_count", return_value=32), mock.patch.object(shards, "mem_available_mb", return_value=64000):
                self.assertEqual(shards.jobs(), 8)
            with mock.patch.object(os, "cpu_count", return_value=32), mock.patch.object(shards, "mem_available_mb", return_value=3 * shards.MB_PER_JOB):
                self.assertEqual(shards.jobs(), 3)
            with mock.patch.object(os, "cpu_count", return_value=32), mock.patch.object(shards, "mem_available_mb", return_value=10):
                self.assertEqual(shards.jobs(), 1, "never zero")
        with mock.patch.dict(os.environ, {"TSTACK_TEST_JOBS": "5"}):
            self.assertEqual(shards.jobs(), 5)


if __name__ == "__main__":
    unittest.main()
