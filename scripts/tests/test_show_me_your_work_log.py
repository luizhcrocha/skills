"""Tests for show-me-your-work's log.sh (pstack's, verbatim): header once, one
clean row per call, formula-leading cells quoted.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
LOG = ROOT / "skills" / "productivity" / "show-me-your-work" / "scripts" / "log.sh"
TEMPLATE = LOG.parent.parent / "references" / "decision-log-template.tsv"


def log(logfile, *cells):
    return subprocess.run([str(LOG), str(logfile), *cells], capture_output=True, text=True)


class LogSh(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.logfile = Path(tmp.name) / "audit" / "run.tsv"

    def test_header_once_then_rows(self):
        self.assertEqual(log(self.logfile, "frame", "counted", "size first", "jj abc", "ok").returncode, 0)
        self.assertEqual(log(self.logfile, "harness", "baseline", "compare", "b/", "saved").returncode, 0)
        lines = self.logfile.read_text().splitlines()
        self.assertEqual(lines[0], TEMPLATE.read_text().strip())
        self.assertEqual(len(lines), 3)
        ts, *rest = lines[2].split("\t")
        self.assertRegex(ts, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(rest, ["harness", "baseline", "compare", "b/", "saved"])

    def test_cells_stay_on_one_line_and_formulas_are_quoted(self):
        log(self.logfile, "p\thase", "line one\nline two", "=HYPERLINK(1)", "@evil", "-1")
        row = self.logfile.read_text().splitlines()[1].split("\t")
        self.assertEqual(len(row), 6)
        self.assertEqual(row[1:], ["p hase", "line one line two", "'=HYPERLINK(1)", "'@evil", "'-1"])

    def test_wrong_arity_is_refused(self):
        out = log(self.logfile, "only", "three", "cells")
        self.assertEqual(out.returncode, 1)
        self.assertIn("usage", out.stderr)
        self.assertFalse(self.logfile.exists())


if __name__ == "__main__":
    unittest.main()
