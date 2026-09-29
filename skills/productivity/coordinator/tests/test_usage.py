"""The plan's usage, as Claude Code hands it to a status line: captured on the way through, read by the manager's page."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import fleets  # noqa: E402
import usage  # noqa: E402

USAGE = str(SCRIPTS / "usage.py")
SOON, LATER = int(time.time()) + 3600, int(time.time()) + 5 * 86400


def status(five: dict | None = None, seven: dict | None = None, **rest) -> str:
    limits = {k: v for k, v in (("five_hour", five), ("seven_day", seven)) if v}
    return json.dumps({"session_id": "s", "model": {"display_name": "Opus"}, **({"rate_limits": limits} if limits else {}), **rest})


class Machine(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / "registry"
        self.addCleanup(self._tmp.cleanup)
        self._before = os.environ.get("FLEET_HOME")
        os.environ["FLEET_HOME"] = str(self.home)
        self.addCleanup(lambda: os.environ.pop("FLEET_HOME", None) if self._before is None else os.environ.__setitem__("FLEET_HOME", self._before))

    def capture(self, stdin: str, *command: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, USAGE, "capture", "--", *command], input=stdin, capture_output=True, text=True, timeout=20)


class CaptureTest(Machine):
    def test_the_status_line_runs_as_before_on_the_same_input(self):
        given = status({"used_percentage": 42.5, "resets_at": SOON}, {"used_percentage": 61, "resets_at": LATER})
        result = self.capture(given, sys.executable, "-c", "import sys, json; print('line for', json.load(sys.stdin)['model']['display_name'])")
        self.assertEqual((result.returncode, result.stdout), (0, "line for Opus\n"))

    def test_what_it_saw_is_kept_for_the_page(self):
        self.capture(status({"used_percentage": 42.5, "resets_at": SOON}, {"used_percentage": 61, "resets_at": LATER}), "true")
        read = usage.read()
        self.assertEqual((read["five_hour"]["used_percentage"], read["five_hour"]["resets_at"]), (42.5, SOON))
        self.assertEqual((read["seven_day"]["used_percentage"], read["seven_day"]["resets_at"]), (61, LATER))
        self.assertLessEqual(abs(read["five_hour"]["at"] - time.time()), 5)

    def test_the_status_lines_own_failure_and_output_pass_through(self):
        result = self.capture(status(), sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)")
        self.assertEqual((result.returncode, result.stderr), (3, "boom"))

    def test_input_that_is_not_json_or_has_no_limits_changes_nothing_and_breaks_nothing(self):
        self.capture(status({"used_percentage": 10, "resets_at": SOON}), "true")
        for given in ["", "not json", "[]", status(), json.dumps({"rate_limits": "soon"}), json.dumps({"rate_limits": {"five_hour": {"used_percentage": "many"}}})]:
            result = self.capture(given, sys.executable, "-c", "print('ok')")
            self.assertEqual((result.returncode, result.stdout), (0, "ok\n"), given)
        self.assertEqual(usage.read()["five_hour"]["used_percentage"], 10)

    def test_with_no_command_it_only_captures(self):
        result = subprocess.run([sys.executable, USAGE, "capture"], input=status({"used_percentage": 7, "resets_at": SOON}), capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.assertEqual(usage.read()["five_hour"]["used_percentage"], 7)


class FreshestTest(Machine):
    def test_an_idle_sessions_older_figure_does_not_replace_a_newer_one(self):
        self.capture(status({"used_percentage": 50, "resets_at": SOON}), "true")
        self.capture(status({"used_percentage": 35, "resets_at": SOON}), "true")
        self.assertEqual(usage.read()["five_hour"]["used_percentage"], 50, "within a window usage only grows")
        self.capture(status({"used_percentage": 58, "resets_at": SOON}), "true")
        self.assertEqual(usage.read()["five_hour"]["used_percentage"], 58)

    def test_a_new_window_replaces_the_one_before_it(self):
        self.capture(status({"used_percentage": 90, "resets_at": SOON}), "true")
        self.capture(status({"used_percentage": 3, "resets_at": SOON + 5 * 3600}), "true")
        self.assertEqual(usage.read()["five_hour"], {**usage.read()["five_hour"], "used_percentage": 3, "resets_at": SOON + 5 * 3600})
        self.capture(status({"used_percentage": 95, "resets_at": SOON}), "true")
        self.assertEqual(usage.read()["five_hour"]["used_percentage"], 3, "a figure of the window before is history")

    def test_a_window_the_input_leaves_out_is_kept(self):
        self.capture(status({"used_percentage": 50, "resets_at": SOON}, {"used_percentage": 61, "resets_at": LATER}), "true")
        self.capture(status({"used_percentage": 52, "resets_at": SOON}), "true")
        read = usage.read()
        self.assertEqual((read["five_hour"]["used_percentage"], read["seven_day"]["used_percentage"]), (52, 61))


class ReadTest(Machine):
    def test_nothing_captured_reads_as_none(self):
        self.assertIsNone(usage.read())
        (self.home / "usage").mkdir(parents=True)
        (self.home / "usage" / "reading.json").write_text("{half")
        self.assertIsNone(usage.read())

    def test_looking_for_fleets_leaves_the_reading_where_it_is(self):
        self.capture(status({"used_percentage": 42, "resets_at": SOON}), "true")
        self.assertEqual(fleets.live(), [])
        self.assertEqual(usage.read()["five_hour"]["used_percentage"], 42)

    def test_the_managers_page_is_sent_it_and_a_coordinators_is_not(self):
        self.capture(status({"used_percentage": 42, "resets_at": SOON}), "true")
        state = {"project": "p", "role": "manager"}
        self.assertEqual(fleets.view(state, self.home)["usage"]["five_hour"]["used_percentage"], 42)
        self.assertNotIn("usage", fleets.view({"project": "p"}, self.home))

    def test_the_cli_prints_what_it_holds(self):
        none = subprocess.run([sys.executable, USAGE, "show"], capture_output=True, text=True)
        self.assertEqual((none.returncode, none.stdout), (0, "no usage captured yet: the status line has not run through `usage.py capture`\n"))
        self.capture(status({"used_percentage": 42.5, "resets_at": SOON}, {"used_percentage": 61, "resets_at": LATER}), "true")
        out = subprocess.run([sys.executable, USAGE, "show"], capture_output=True, text=True).stdout
        self.assertIn("5-hour window: 42.5% used", out)
        self.assertIn("7-day window: 61% used", out)


if __name__ == "__main__":
    unittest.main()
