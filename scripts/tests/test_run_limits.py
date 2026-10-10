"""Tests for scripts/run_limits.py: the worker cap the test runners read, $TSTACK_TEST_JOBS, a watch stopping a
command, and stop_live. The limit and the group kill are tested through gates (test_gates.Timeouts).

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import os
import signal
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import run_limits  # noqa: E402


class EnvJobs(unittest.TestCase):
    def test_unset_or_empty_is_none(self):
        with mock.patch.dict(os.environ, {"TSTACK_TEST_JOBS": ""}):
            self.assertIsNone(run_limits.env_jobs())
        with mock.patch.dict(os.environ, {}):
            os.environ.pop("TSTACK_TEST_JOBS", None)
            self.assertIsNone(run_limits.env_jobs())

    def test_a_number_is_a_count_of_at_least_one(self):
        for raw, want in (("6", 6), (" 2 ", 2), ("0", 1), ("-3", 1)):
            with mock.patch.dict(os.environ, {"TSTACK_TEST_JOBS": raw}):
                self.assertEqual(run_limits.env_jobs(), want, raw)

    def test_anything_else_says_what_it_got(self):
        with mock.patch.dict(os.environ, {"TSTACK_TEST_JOBS": "four"}), self.assertRaisesRegex(ValueError, "'four'"):
            run_limits.env_jobs()



class Stopping(unittest.TestCase):
    def test_a_watch_stops_the_command_with_its_reason(self):
        calls = []
        watch = lambda proc: calls.append(proc.pid) or ("enough" if len(calls) >= 2 else None)  # noqa: E731
        code, stopped, secs, out = run_limits.run_limited(["sh", "-c", "echo up; sleep 30"], 30, watch=watch, grace=0,
                                                          poll=0.1)
        self.assertEqual((stopped, out), ("enough", "up\n"))
        self.assertEqual(code, -signal.SIGKILL)
        self.assertLess(secs, 5)

    def test_stop_live_signals_every_running_command_and_starts_no_more(self):
        with mock.patch.object(run_limits, "_stopping", False):
            results = []
            run = lambda: results.append(run_limits.run_limited(["sh", "-c", "sleep 30"], 60))  # noqa: E731
            threads = [threading.Thread(target=run) for _ in range(2)]
            for t in threads:
                t.start()
            deadline = time.monotonic() + 10
            while len(run_limits._live) < 2 and time.monotonic() < deadline:
                time.sleep(0.02)
            started = time.monotonic()
            run_limits.stop_live(signal.SIGTERM, grace=1)
            for t in threads:
                t.join(10)
            self.assertLess(time.monotonic() - started, 5)
            self.assertEqual(sorted(code for code, *_ in results), [-signal.SIGTERM] * 2)
            code, *_ = run_limits.run_limited(["sh", "-c", "sleep 30"], 60)
            self.assertEqual(code, -signal.SIGKILL, "one started after is killed at once")


if __name__ == "__main__":
    unittest.main()
