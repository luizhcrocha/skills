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
        self.config = Path(self._tmp.name) / "config"
        for name, value in (("FLEET_HOME", str(self.home)), ("CLAUDE_CONFIG_DIR", str(self.config))):
            before = os.environ.get(name)
            os.environ[name] = value
            self.addCleanup(lambda n=name, b=before: os.environ.pop(n, None) if b is None else os.environ.__setitem__(n, b))

    def capture(self, stdin: str, *command: str, config: Path | None = None) -> subprocess.CompletedProcess:
        env = {**os.environ, "CLAUDE_CONFIG_DIR": str(config or self.config)}
        return subprocess.run([sys.executable, USAGE, "capture", "--", *command], input=stdin, capture_output=True, text=True, timeout=20, env=env)

    def login(self, name: str, email: str) -> Path:
        """A config directory whose `.claude.json` says who is logged in, as Claude Code writes it."""
        config = Path(self._tmp.name) / name
        config.mkdir(parents=True, exist_ok=True)
        account = {"accountUuid": f"uuid-{name}", "emailAddress": email, "organizationUuid": f"org-{name}", "organizationName": f"{email}'s Organization"}
        (config / ".claude.json").write_text(json.dumps({"numStartups": 3, "oauthAccount": account, "projects": {}}))
        return config


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


class AccountsTest(Machine):
    def test_the_page_shows_the_account_that_worked_last_and_the_others_below(self):
        work, home = self.login("work", "work@example.com"), self.login("home", "home@example.com")
        self.capture(status({"used_percentage": 40, "resets_at": SOON}, {"used_percentage": 100, "resets_at": LATER}), "true", config=work)
        self.capture(status({"used_percentage": 12, "resets_at": SOON + 600}, {"used_percentage": 30, "resets_at": LATER + 600}), "true", config=home)
        read = usage.read()
        self.assertEqual((read["account"], read["five_hour"]["used_percentage"], read["seven_day"]["used_percentage"]), ("home@example.com", 12, 30),
                         "a window maxed on another account does not stick over the one in use")
        self.assertEqual([(o["account"], o["seven_day"]["used_percentage"]) for o in read["others"]], [("work@example.com", 100)])
        self.capture(status({"used_percentage": 41, "resets_at": SOON}, {"used_percentage": 100, "resets_at": LATER}), "true", config=work)
        time.sleep(1.1)
        self.capture(status({"used_percentage": 12, "resets_at": SOON + 600}, {"used_percentage": 30, "resets_at": LATER + 600}), "true", config=home)
        self.assertEqual(usage.read()["account"], "home@example.com", "the same figure again still says the account is the one working")

    def test_within_one_account_usage_only_grows(self):
        work = self.login("work", "work@example.com")
        self.capture(status(None, {"used_percentage": 30, "resets_at": LATER}), "true", config=work)
        self.capture(status(None, {"used_percentage": 20, "resets_at": LATER}), "true", config=work)
        self.assertEqual(usage.read()["seven_day"]["used_percentage"], 30)

    def test_the_file_before_accounts_reads_as_an_account_not_recorded(self):
        (self.home / "usage").mkdir(parents=True)
        (self.home / "usage" / "reading.json").write_text(json.dumps({
            "five_hour": {"used_percentage": 40, "resets_at": SOON, "at": SOON - 4000},
            "seven_day": {"used_percentage": 100, "resets_at": LATER, "at": SOON - 9000}}))
        read = usage.read()
        self.assertEqual((read["account"], read["seen"], read["five_hour"]["used_percentage"], read["seven_day"]["used_percentage"], read["others"]),
                         (None, SOON - 4000, 40, 100, []))
        self.capture(status({"used_percentage": 5, "resets_at": SOON + 600}, {"used_percentage": 30, "resets_at": LATER + 600}), "true", config=self.login("home", "home@example.com"))
        read = usage.read()
        self.assertEqual((read["account"], read["seven_day"]["used_percentage"]), ("home@example.com", 30))
        self.assertEqual([(o["account"], o["seven_day"]["used_percentage"]) for o in read["others"]], [(None, 100)])
        held = json.loads((self.home / "usage" / "reading.json").read_text())
        self.assertEqual(list(held), ["accounts"])
        self.assertEqual(held["accounts"]["unknown"]["seven_day"]["used_percentage"], 100)

    def test_a_session_with_no_login_is_an_account_not_recorded_and_an_unreadable_login_keeps_nothing(self):
        self.capture(status({"used_percentage": 9, "resets_at": SOON}), "true")
        self.assertEqual((usage.read()["account"], usage.read()["five_hour"]["used_percentage"]), (None, 9))
        broken = Path(self._tmp.name) / "broken"
        broken.mkdir()
        (broken / ".claude.json").write_text('{"oauthAccount": {"accountUu')
        result = self.capture(status({"used_percentage": 70, "resets_at": SOON}), sys.executable, "-c", "print('ok')", config=broken)
        self.assertEqual((result.returncode, result.stdout), (0, "ok\n"))
        self.assertEqual((usage.read()["five_hour"]["used_percentage"], usage.read()["others"]), (9, []))

    def test_another_account_whose_windows_all_reset_is_dropped(self):
        (self.home / "usage").mkdir(parents=True)
        past = int(time.time()) - 60
        (self.home / "usage" / "reading.json").write_text(json.dumps({"accounts": {"gone": {"email": "gone@example.com", "seen": past - 9000,
            "five_hour": {"used_percentage": 99, "resets_at": past, "at": past - 9000}}}}))
        self.capture(status({"used_percentage": 5, "resets_at": SOON}), "true", config=self.login("home", "home@example.com"))
        self.assertEqual(list(json.loads((self.home / "usage" / "reading.json").read_text())["accounts"]), ["uuid-home:org-home"])

    def test_the_cli_names_each_account(self):
        work, home = self.login("work", "work@example.com"), self.login("home", "home@example.com")
        self.capture(status(None, {"used_percentage": 100, "resets_at": LATER}), "true", config=work)
        self.capture(status(None, {"used_percentage": 30, "resets_at": LATER}), "true", config=home)
        out = subprocess.run([sys.executable, USAGE, "show"], capture_output=True, text=True).stdout.splitlines()
        self.assertEqual([out[0], out[1][:26], out[2], out[3][:27]],
                         ["home@example.com, the session that worked last:", "  7-day window: 30% used, ", "work@example.com:", "  7-day window: 100% used, "])


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
        self.assertEqual((none.returncode, none.stdout), (0, "no usage captured yet: the status line has not run through `fleet usage capture`\n"))
        self.capture(status({"used_percentage": 42.5, "resets_at": SOON}, {"used_percentage": 61, "resets_at": LATER}), "true")
        out = subprocess.run([sys.executable, USAGE, "show"], capture_output=True, text=True).stdout
        self.assertIn("5-hour window: 42.5% used", out)
        self.assertIn("7-day window: 61% used", out)


if __name__ == "__main__":
    unittest.main()
