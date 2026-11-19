"""rex-watch waits on a pane's command through Rex's process_changed events, and returns at once on an idle pane.

A fake `rex` on PATH answers inspect, process and capture, and plays events in the shapes Rex 2026-11 sends.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "rex-watch"
BLOCK, OTHER, SESSION = "block:01-watched", "block:02-other", "session:01-s"
SHELL = {"pid": 10, "user_id": 1000, "name": "bash", "argv0": "bash"}
NU = {"pid": 10, "user_id": 1000, "name": "nu", "argv0": "nu"}
LOGIN = {"pid": 9, "user_id": 0, "name": "login", "argv0": "login"}
SLEEP = {"pid": 11, "user_id": 1000, "name": "coreutils", "argv0": "sleep"}

FAKE = r'''#!/usr/bin/env python3
import json, os, sys, time
args = [a for a in sys.argv[1:]]
spec = json.load(open(os.environ["FAKE_REX"]))
if args[:2] == ["block", "inspect"]:
    if args[2] != spec["block"]:
        sys.stderr.write("Error: block target not found\n"); sys.exit(1)
    print(json.dumps({"session_id": spec["session"]}))
elif args[:2] == ["block", "call"]:
    answers = spec["process"] if isinstance(spec["process"], list) else [spec["process"]]
    n_path = os.environ["FAKE_REX"] + ".calls"
    n = int(open(n_path).read()) if os.path.exists(n_path) else 0
    open(n_path, "w").write(str(n + 1))
    answer = answers[min(n, len(answers) - 1)]
    if answer is None:
        sys.stderr.write("Error: method failed\n"); sys.exit(1)
    print(json.dumps(answer))
elif args[0] == "capture":
    print("$ sleep 4\nslept-ok\n$")
elif args[0] == "events":
    for ev in spec["events"]:
        print(json.dumps(ev), flush=True)
    for _ in range(spec.get("noise", 0)):
        time.sleep(0.5)
        print(json.dumps(spec["noise_event"]), flush=True)
    if not spec.get("stream_ends"):
        time.sleep(30)
'''


def block_event(block, name, payload):
    return {"type": "session_event", "payload": {"session_id": SESSION, "event": {"type": "block_event", "payload": {
        "block_id": block, "creator_name": "com.superlogical.terminal", "name": name, "payload": payload}}}}


class RexWatch(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "rex").write_text(FAKE)
        (self.tmp / "rex").chmod(0o755)

    def run_watch(self, process, events, *args, block=BLOCK, stream_ends=False, noise=0):
        spec = self.tmp / "spec.json"
        spec.write_text(json.dumps({"block": BLOCK, "session": SESSION, "process": process, "events": events,
                                    "stream_ends": stream_ends, "noise": noise,
                                    "noise_event": block_event(OTHER, "title_changed", {})}))
        env = {**os.environ, "PATH": f"{self.tmp}:{os.environ['PATH']}", "FAKE_REX": str(spec)}
        return subprocess.run([sys.executable, str(SCRIPT), block, *args], env=env, capture_output=True, text=True,
                              timeout=10)

    def test_an_idle_pane_prints_its_screen_without_waiting(self):
        r = self.run_watch({"foreground": SHELL, "child": SHELL, "last_exit": None}, [])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("idle (program bash)", r.stdout)
        self.assertIn("slept-ok", r.stdout)

    def test_a_running_command_is_waited_on_until_the_shell_has_the_foreground_again(self):
        events = [
            block_event(OTHER, "process_changed", {"generation": 4, "foreground": SHELL}),
            block_event(BLOCK, "title_changed", {}),
            block_event(BLOCK, "process_changed", {"generation": 3, "foreground": SLEEP}),
            block_event(BLOCK, "process_changed", {"generation": 4, "foreground": SHELL}),
        ]
        r = self.run_watch({"foreground": SLEEP, "child": SHELL, "last_exit": None}, events)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("running sleep", r.stdout)
        self.assertIn(f"{BLOCK}: ended", r.stdout)

    def test_the_pane_program_exiting_ends_the_wait(self):
        r = self.run_watch({"foreground": SLEEP, "child": SLEEP, "last_exit": None},
                           [block_event(BLOCK, "child_exited", {"exit_code": 0})])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ended", r.stdout)

    def test_check_reports_a_running_command_and_returns(self):
        r = self.run_watch({"foreground": SLEEP, "child": SHELL, "last_exit": None}, [], "--check")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("running sleep", r.stdout)
        self.assertNotIn("ended", r.stdout)

    def test_a_macos_login_pane_is_idle_when_its_shell_has_the_foreground(self):
        r = self.run_watch({"foreground": NU, "child": LOGIN, "last_exit": None}, [])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("idle (program login)", r.stdout)

    def test_a_macos_login_pane_command_ends_when_nu_has_the_foreground_again(self):
        r = self.run_watch({"foreground": SLEEP, "child": LOGIN, "last_exit": None},
                           [block_event(BLOCK, "process_changed", {"generation": 5, "foreground": NU})])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ended", r.stdout)

    def test_a_shell_running_a_script_is_busy(self):
        r = self.run_watch({"foreground": {**NU, "script": "/repo/build.nu"}, "child": NU, "last_exit": None}, [],
                           "--check")
        self.assertIn("running /repo/build.nu", r.stdout)

    def test_a_command_that_ends_before_the_stream_subscribes_is_seen_by_the_one_recheck(self):
        r = self.run_watch([{"foreground": SLEEP, "child": NU, "last_exit": None},
                            {"foreground": NU, "child": NU, "last_exit": None}], [])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ended", r.stdout)

    def test_the_recheck_fires_while_other_panes_keep_sending_events(self):
        r = self.run_watch([{"foreground": SLEEP, "child": NU, "last_exit": None},
                            {"foreground": NU, "child": NU, "last_exit": None}], [], noise=16)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ended", r.stdout)

    def test_a_stream_that_ends_before_the_command_exits_3(self):
        r = self.run_watch({"foreground": SLEEP, "child": NU, "last_exit": None}, [], stream_ends=True)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("event stream ended before the command did", r.stdout)

    def test_a_failed_process_call_exits_2_rather_than_reading_idle(self):
        r = self.run_watch([None], [])
        self.assertEqual(r.returncode, 2)
        self.assertIn("cannot read the processes", r.stderr)

    def test_a_failed_recheck_exits_2(self):
        r = self.run_watch([{"foreground": SLEEP, "child": NU, "last_exit": None}, None], [])
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("cannot read its processes", r.stdout)

    def test_a_missing_block_exits_2(self):
        r = self.run_watch({}, [], block="block:gone")
        self.assertEqual(r.returncode, 2)
        self.assertIn("rex hosts", r.stderr)


if __name__ == "__main__":
    unittest.main()
