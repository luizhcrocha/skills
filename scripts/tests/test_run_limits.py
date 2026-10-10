"""Tests for scripts/run_limits.py: the worker cap the test runners read, $TSTACK_TEST_JOBS.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import os
import sys
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


if __name__ == "__main__":
    unittest.main()
