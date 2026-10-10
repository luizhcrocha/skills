"""Tests for scripts/bun_files.py: the files it finds, a wedged file killed and run again, its totals and exit code.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import contextlib
import io
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
sys.path.insert(0, str(ROOT / "scripts"))
import bun_files  # noqa: E402

# A stand-in for `bun test FILE`, driven by the file's first line: pass, fail, hang, wedge (a child that exits and
# is never reaped while the process spins, as Bun 1.4.2's spawnSync leaves it), "wedge-once", which wedges only on
# its first run, "fail-then-wedge-once", which fails a test and then wedges on its first run, "idle-zombies" (a
# zombie held while the process sleeps, as async children wait for the loop) and "stubborn", a hang that ignores
# SIGTERM, SIGINT and SIGHUP. Each run writes its pid to FILE.pid.
FAKE = textwrap.dedent("""\
    #!{python}
    import os, signal, subprocess, sys, time
    path = sys.argv[-1]
    open(path + ".pid", "w").write(str(os.getpid()))
    mode = open(path).readline().strip()
    if mode in ("wedge-once", "fail-then-wedge-once"):
        marker = path + ".ran"
        if os.path.exists(marker):
            mode = "pass"
        elif mode == "fail-then-wedge-once":
            print("(fail) a planted failure [0.10ms]", flush=True)
            mode = "wedge"
        else:
            mode = "wedge"
        open(marker, "w").close()
    if mode == "pass":
        print(" 3 pass\\n 0 fail"); sys.exit(0)
    if mode == "fail":
        print("(fail) a test\\n 2 pass\\n 1 fail"); sys.exit(1)
    if mode == "stubborn":
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
    child = None
    if mode in ("wedge", "idle-zombies"):
        child = subprocess.Popen(["true"])  # held and never waited for: a zombie (dropped, Popen.__del__ could reap it)
    print("started", flush=True)
    while True:
        if mode != "wedge":
            time.sleep(0.1)
    """)


class Runner(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        fake = self.tmp / "fake-bun"
        fake.write_text(FAKE.format(python=sys.executable))
        fake.chmod(0o755)
        (self.tmp / "test").mkdir()
        cwd = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, cwd)
        for patch in (mock.patch.object(bun_files, "BUN", (str(fake),)), mock.patch.object(bun_files, "WEDGE_S", 1.0),
                      mock.patch.object(bun_files, "save_cache", lambda _: None),
                      mock.patch.object(bun_files, "load_cache", lambda: {})):
            patch.start()
            self.addCleanup(patch.stop)

    def file(self, name: str, mode: str) -> None:
        (self.tmp / "test" / name).write_text(mode + "\n")

    def run_all(self, *args: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = bun_files.main(["-j", "4", *args])
        return code, out.getvalue()

    def test_it_finds_buns_test_files_only(self):
        for name in ("a.test.ts", "b_test.tsx", "c.spec.mjs", "d_spec.js", "helper.ts", "e.test.ts.snap"):
            self.file(name, "pass")
        (self.tmp / "test" / "node_modules").mkdir()
        self.file("node_modules/x.test.ts", "pass")
        self.assertEqual([Path(f).name for f in bun_files.files(Path("test"))], ["a.test.ts", "b_test.tsx", "c.spec.mjs", "d_spec.js"])

    def test_the_totals_add_up_and_a_failed_file_fails_the_run_with_its_output(self):
        self.file("a.test.ts", "pass")
        self.file("b.test.ts", "fail")
        code, out = self.run_all()
        self.assertEqual(code, 1)
        self.assertIn("5 pass, 1 fail, 0 skip across 2 files", out)
        self.assertIn("(fail) a test", out)
        self.assertIn("FAILED: test/b.test.ts (failed)", out)

    def test_a_wedged_file_is_killed_and_run_once_more(self):
        self.file("a.test.ts", "wedge-once")
        started = time.monotonic()
        code, out = self.run_all()
        self.assertEqual(code, 0, out)
        self.assertLess(time.monotonic() - started, 30)
        self.assertIn("test/a.test.ts: ok after a wedge", out)
        self.assertRegex(out, r"its child true \(\d+\) stayed a zombie for \d+s while it spun")
        self.assertIn("oven-sh/bun#34069", out)

    def test_a_failure_before_a_wedge_stays_a_failure_whatever_the_rerun_does(self):
        self.file("a.test.ts", "fail-then-wedge-once")
        code, out = self.run_all()
        self.assertEqual(code, 1, out)
        self.assertIn("test/a.test.ts: failed, then wedged; the rerun ok", out)
        self.assertIn("(fail) a planted failure", out, "the first run's output is shown")
        self.assertIn(" 3 pass", out, "and the rerun's")
        self.assertIn("FAILED: test/a.test.ts (failed, then wedged; the rerun ok)", out)

    def test_a_zombie_held_while_the_process_idles_is_not_a_wedge(self):
        self.file("a.test.ts", "idle-zombies")
        code, out = self.run_all("--timeout", "3")
        self.assertEqual(code, 1)
        self.assertIn("timed out: still running after 3s", out)
        self.assertNotIn("wedged", out)

    def test_a_file_that_wedges_twice_fails(self):
        self.file("a.test.ts", "wedge")
        code, out = self.run_all()
        self.assertEqual(code, 1)
        self.assertIn("FAILED: test/a.test.ts (wedged)", out)

    def test_a_hang_with_no_zombie_is_a_timeout_and_is_not_run_again(self):
        self.file("a.test.ts", "hang")
        code, out = self.run_all("--timeout", "2")
        self.assertEqual(code, 1)
        self.assertIn("timed out: still running after 2s", out)
        self.assertEqual(out.count("started"), 1)

    def start_runner(self, *args: str) -> subprocess.Popen:
        """bun_files.py as its own process group, as scripts/gates starts a suite, with the fake as `bun` on PATH."""
        (self.tmp / "bin").mkdir()
        (self.tmp / "bin" / "bun").symlink_to(self.tmp / "fake-bun")
        env = {**os.environ, "PATH": f"{self.tmp / 'bin'}:{os.environ['PATH']}", "XDG_CACHE_HOME": str(self.tmp / "cache")}
        proc = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "bun_files.py"), "-j", "4", *args], cwd=self.tmp,
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        self.addCleanup(proc.stdout.close)
        self.addCleanup(lambda: proc.poll() is None and os.killpg(proc.pid, signal.SIGKILL))
        return proc

    def bun_pids(self, names: list[str]) -> list[int]:
        """The fake buns' pids, once every one of `names` has started."""
        pids = [self.tmp / "test" / f"{name}.pid" for name in names]
        deadline = time.monotonic() + 20
        while not all(p.exists() and p.read_text() for p in pids) and time.monotonic() < deadline:
            time.sleep(0.05)
        return [int(p.read_text()) for p in pids]

    def assertGone(self, pids: list[int]) -> None:
        deadline = time.monotonic() + 5
        while any(map(_alive, pids)) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual([p for p in pids if _alive(p)], [], "a bun test outlived the runner")

    def test_sigterm_to_the_runners_group_leaves_no_bun_process(self):
        for name, mode in (("a.test.ts", "hang"), ("b.test.ts", "stubborn")):
            self.file(name, mode)
        runner = self.start_runner()
        pids = self.bun_pids(["a.test.ts", "b.test.ts"])
        os.killpg(runner.pid, signal.SIGTERM)  # scripts/gates' timeout
        self.assertEqual(runner.wait(timeout=10), 128 + signal.SIGTERM)
        self.assertGone(pids)

    def test_ctrl_c_stops_the_running_files_at_once(self):
        self.file("a.test.ts", "hang")
        self.file("b.test.ts", "stubborn")
        runner = self.start_runner("--timeout", "120")
        pids = self.bun_pids(["a.test.ts", "b.test.ts"])
        started = time.monotonic()
        os.kill(runner.pid, signal.SIGINT)  # a terminal's Ctrl-C reaches the runner's group, not the files' sessions
        self.assertEqual(runner.wait(timeout=10), 128 + signal.SIGINT)
        self.assertLess(time.monotonic() - started, bun_files.STOP_GRACE + 3, "not the file's --timeout")
        self.assertGone(pids)
        self.assertIn(b"SIGINT: stopping the files still running", runner.stdout.read())

    def test_the_jobs_cap_is_four(self):
        with mock.patch.dict(os.environ, {"TSTACK_TEST_JOBS": "9"}):
            self.assertEqual(bun_files.jobs(), 4)
        with mock.patch.dict(os.environ, {"TSTACK_TEST_JOBS": "2"}):
            self.assertEqual(bun_files.jobs(), 2)


def _alive(pid: int) -> bool:
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


if __name__ == "__main__":
    unittest.main()
