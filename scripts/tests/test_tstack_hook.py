"""Tests for hooks/tstack-hook.py, the plugin's one hook dispatcher, its launcher hooks/tstack-hook, and
hooks/hooks.json.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)

The rule under test above all: a hook never breaks a session. Whatever goes
wrong, the dispatcher exits 0 with nothing on stdout and logs to hook.log.
"""

import contextlib
import hashlib
import json
import os
import re
import resource
import select
import shlex
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / "hooks" / "tstack-hook"
SOURCE = HOOK.with_name("tstack-hook.py")  # the dispatcher's code, which the launcher HOOK loads
FLEET_SOURCE = HOOK.with_name("fleet-hook.py")  # the fleet half, which the dispatcher executes into itself
HOOKS_JSON = ROOT / "hooks" / "hooks.json"
MEMO = ROOT / "scripts" / "memo"
TUCA = ROOT / "bin" / "tuca-mode"
HEARTBEAT_ONLY = ("PostToolUseFailure", "SubagentStart", "SubagentStop")
# A hook run's CPU budget (assertCheap): its best of 7 runs, at most HOOK_CPU_RATIO times START's, a bare start with the
# dispatcher's imports, run in turn with it. The wall clock it replaced (150 ms) failed whenever the machine was loaded;
# CPU time moves less, but it moves (the hook's best 34 ms at load 25, up to 91 at load 60 to 110), and START moves
# with it. 2026-10-15, 32 cores, load 22 to 114, the four timed cases: 1.15x to 1.83x in 40 runs; with a 50 ms CPU burn
# planted in main(), 2.24x to 3.63x in 32. Without the launcher, compiling on every call: 120 to 152 ms at load 100.
# START runs the python3 the hook's own `#!/usr/bin/env python3` finds on the test env's PATH.
START = ["-c", "import collections, json, os, pathlib, re, sys, time, traceback"]
HOOK_CPU_RATIO = 2.1


def tool_use(name, **tool_input):
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": f"toolu_{name}", "name": name, "input": tool_input}]}}


def said(text):
    return {"type": "user", "message": {"role": "user", "content": text}}


class HookCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name).resolve()
        self.addCleanup(self._tmp.cleanup)
        self.data = self.tmp / "plugin-data"
        self.env = {
            "HOME": str(self.tmp / "home"),
            "PATH": os.environ.get("PATH", ""),
            "XDG_DATA_HOME": str(self.tmp / "data"),
            "XDG_CACHE_HOME": str(self.tmp / "cache"),
            "CLAUDE_PLUGIN_ROOT": str(ROOT),
            "CLAUDE_PLUGIN_DATA": str(self.data),
        }
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "remote", "add", "origin", "git@github.com:acme/hooked.git"], cwd=self.repo, check=True)
        self.transcript = self.tmp / "transcript.jsonl"
        self.transcript.write_text("")

    def hook(self, event, payload=None, raw=None, env=None):
        stdin = raw if raw is not None else json.dumps(payload or {})
        return subprocess.run([str(HOOK), event], input=stdin, capture_output=True, text=True,
                              env={**self.env, **(env or {})}, timeout=30)

    def assertCheap(self, label, event, payload):
        """The hook's best of 7 runs costs under HOOK_CPU_RATIO times the CPU of a bare start, the best of 7 runs of
        START taken in turn with them: CPU time of the process and the children it waited for, user plus system."""
        def cpu(run):
            before = resource.getrusage(resource.RUSAGE_CHILDREN)
            run()
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            return (after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime) * 1000
        python = shutil.which("python3", path=self.env["PATH"])
        hook, start = [], []
        for _ in range(7):
            start.append(cpu(lambda: subprocess.run([python, *START], capture_output=True, env=self.env, timeout=30)))
            hook.append(cpu(lambda: self.hook(event, payload)))
        ratio = min(hook) / min(start)
        print(f"\n  {label} hook: best {min(hook):.0f} ms CPU, {ratio:.2f}x a bare start's {min(start):.0f} ms",
              end="", file=sys.stderr)
        self.assertLess(ratio, HOOK_CPU_RATIO, f"{label} hook costs too much CPU at its best: {hook}; START {start}")

    def base(self, event, **extra):
        return {"session_id": "sess-1", "transcript_path": str(self.transcript), "cwd": str(self.repo),
                "hook_event_name": event, **extra}

    def transcribe(self, *entries):
        with open(self.transcript, "a") as f:
            for e in entries:
                f.write(json.dumps(e, separators=(",", ":")) + "\n")

    def memo(self, *args):
        return subprocess.run([sys.executable, str(MEMO), *args], cwd=self.repo, env={**os.environ, **self.env},
                              capture_output=True, text=True, check=True).stdout

    def log(self):
        path = self.data / "hook.log"
        return path.read_text() if path.exists() else ""

    def assertSilent(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")


class SessionStartTest(HookCase):
    def test_injects_the_wake_as_additional_context(self):
        self.memo("note", "decision", "hooks are one Python dispatcher")
        for source in ("startup", "resume", "clear", "compact"):
            r = self.hook("SessionStart", self.base("SessionStart", source=source))
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(set(out), {"hookSpecificOutput"})
            self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "SessionStart")
            context = out["hookSpecificOutput"]["additionalContext"]
            self.assertTrue(context.startswith("# memo"))
            self.assertIn("project:acme/hooked", context)
            self.assertEqual("hooks are one Python dispatcher" in context, source in ("startup", "resume"),
                             "a recent decision is in the brief wake, not after clear or compact")
            self.assertEqual("just compacted" in context, source == "compact")

    def test_a_worker_gets_no_wake(self):
        self.memo("note", "fact", "something")
        self.assertSilent(self.hook("SessionStart", self.base("SessionStart", source="startup", agent_id="a1")))
        self.assertSilent(self.hook("SessionStart", self.base("SessionStart", source="startup"),
                                    env={"TSTACK_ROLE": "worker"}))

    def test_cwd_falls_back_to_the_project_dir(self):
        self.memo("note", "gotcha", "found through CLAUDE_PROJECT_DIR")
        payload = self.base("SessionStart", source="startup")
        del payload["cwd"]
        r = self.hook("SessionStart", payload, env={"CLAUDE_PROJECT_DIR": str(self.repo)})
        self.assertIn("found through CLAUDE_PROJECT_DIR", r.stdout)


FAKE_TAPE = """import json, os, sys, time
time.sleep(float(os.environ.get("FAKE_TAPE_SLEEP", "0")))
with open(os.environ["FAKE_TAPE_LOG"], "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "nice": os.nice(0)}) + "\\n")
"""


class TapeBuildTest(HookCase):
    """tape_build: SessionStart starts `tape build --on-start` for the session's project, detached, and returns
    (docs/design/tape.md, Phase 2). The plugin root's scripts/tape is the seam: a fake one records its argv and its niceness."""

    def setUp(self):
        super().setUp()
        self.root = self.tmp / "plugin"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "scripts" / "memo").symlink_to(MEMO)
        (self.root / "scripts" / "tape").write_text(FAKE_TAPE)
        (self.root / "scripts" / "memo-dream").write_text(FAKE_TAPE.replace("FAKE_TAPE_LOG", "FAKE_DREAM_LOG"))
        self.runs = self.tmp / "tape-runs.jsonl"
        self.dreams = self.tmp / "dream-runs.jsonl"
        self.env.update(CLAUDE_PLUGIN_ROOT=str(self.root), FAKE_TAPE_LOG=str(self.runs), FAKE_DREAM_LOG=str(self.dreams))
        self.index = self.tmp / "data" / "tstack" / "tape" / "index.db"

    def tearDown(self):
        """The build and the proposer outlive the hook, and one still writing fails the temp folder's cleanup."""
        logs = (self.tmp / "tape-runs.jsonl", self.dreams)
        deadline = time.monotonic() + 20
        while any(log.exists() for log in logs) and not all(log.exists() for log in logs):
            if time.monotonic() > deadline:
                break
            time.sleep(0.05)
        super().tearDown()

    def tape_in_use(self):
        self.index.parent.mkdir(parents=True)
        self.index.write_bytes(b"")

    def wait_runs(self, n, timeout=20, key="argv"):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            lines = self.runs.read_text().splitlines() if self.runs.exists() else []
            if len(lines) >= n:
                return [json.loads(line)[key] for line in lines]
            time.sleep(0.05)
        self.fail(f"tape ran {self.runs.read_text() if self.runs.exists() else 'never'}, not {n} times")

    def test_it_starts_the_build_and_returns_before_it_ends(self):
        import signal
        self.tape_in_use()
        started = time.monotonic()
        p = subprocess.Popen([str(HOOK), "SessionStart"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, start_new_session=True,
                             env={**self.env, "FAKE_TAPE_SLEEP": "3"})
        out, err = p.communicate(json.dumps(self.base("SessionStart", source="startup")), timeout=30)
        took = time.monotonic() - started
        self.assertEqual(p.returncode, 0, err)
        self.assertLess(took, 2.5, "the hook waited on the build")
        self.assertFalse(self.runs.exists())
        try:
            os.killpg(p.pid, signal.SIGKILL)  # what is left of the hook's process group dies; the build is not in it
        except ProcessLookupError:
            pass
        self.assertEqual(self.wait_runs(1), [["build", "--on-start", "--cwd", str(self.repo)]])
        self.assertNotIn("tape_build failed", self.log())

    def test_the_note_proposer_starts_detached_beside_the_build(self):
        """memo-dream (the proposer) starts with the build, niced and out of the hook's process group like it; it
        waits on the build's lock itself and keeps its own pilot list and once-a-day rule, so the hook only starts it."""
        import signal
        self.tape_in_use()
        p = subprocess.Popen([str(HOOK), "SessionStart"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, start_new_session=True,
                             env={**self.env, "FAKE_TAPE_SLEEP": "3"})
        started = time.monotonic()
        out, err = p.communicate(json.dumps(self.base("SessionStart", source="startup")), timeout=30)
        self.assertEqual(p.returncode, 0, err)
        self.assertLess(time.monotonic() - started, 2.5, "the hook waited on the proposer")
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.runs = self.dreams
        self.assertEqual(self.wait_runs(1), [["run", "--cwd", str(self.repo)]])
        self.assertEqual(self.wait_runs(1, key="nice"), [min(os.nice(0) + 10, 19)])

    def test_no_proposer_without_tape_on_the_machine_nor_for_a_worker(self):
        self.hook("SessionStart", self.base("SessionStart", source="startup"))
        self.tape_in_use()
        self.hook("SessionStart", self.base("SessionStart", source="startup", agent_id="a1"))
        time.sleep(0.5)
        self.assertFalse(self.dreams.exists())

    def test_the_build_runs_niced_ten_below_the_session(self):
        self.tape_in_use()
        self.assertEqual(self.hook("SessionStart", self.base("SessionStart", source="startup")).returncode, 0)
        self.assertEqual(self.wait_runs(1, key="nice"), [min(os.nice(0) + 10, 19)])

    def test_no_build_without_tape_on_the_machine_nor_for_a_worker_or_a_headless_run(self):
        self.assertEqual(self.hook("SessionStart", self.base("SessionStart", source="startup")).returncode, 0)
        self.tape_in_use()
        self.hook("SessionStart", self.base("SessionStart", source="startup", agent_id="a1"))
        self.hook("SessionStart", self.base("SessionStart", source="startup"), env={"TSTACK_ROLE": "worker"})
        self.hook("SessionStart", self.base("SessionStart", source="startup"), env={"CLAUDE_CODE_ENTRYPOINT": "sdk-cli"})
        self.hook("SessionStart", self.base("SessionStart", source="startup"), env={"TSTACK_ROLE": "tape"})
        last = self.tmp / "last"
        last.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=last, check=True)
        self.hook("SessionStart", {**self.base("SessionStart", source="resume"), "cwd": str(last)})
        time.sleep(0.5)
        self.assertEqual(self.wait_runs(1), [["build", "--on-start", "--cwd", str(last)]])

    def test_no_build_for_a_session_in_no_jj_or_git_repo(self):
        self.tape_in_use()
        home = self.tmp / "home"
        home.mkdir()
        self.assertEqual(self.hook("SessionStart", {**self.base("SessionStart", source="startup"),
                                                    "cwd": str(home)}).returncode, 0)
        self.hook("SessionStart", self.base("SessionStart", source="startup"))
        self.assertEqual(self.wait_runs(1), [["build", "--on-start", "--cwd", str(self.repo)]])
        time.sleep(0.5)
        self.assertEqual(len(self.runs.read_text().splitlines()), 1, "a build started for a cwd in no repo")

    def fake_systemd_run(self, fails):
        """systemd-run on PATH: records its argv, then fails the way the real one does with no user manager
        behind the bus, or execs the command after `--` as `--scope` does."""
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        script = bin_dir / "systemd-run"
        script.write_text(f"#!{sys.executable}\nimport os, sys\n"
                          f"open({str(self.tmp / 'systemd-run.log')!r}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n"
                          + ("sys.exit('Failed to connect to user scope bus via local transport: No such file')\n" if fails
                             else "rest = sys.argv[sys.argv.index('--') + 1:]\nos.execvp(rest[0], rest)\n"))
        script.chmod(0o755)
        run = self.tmp / "run"
        run.mkdir()
        (run / "bus").write_bytes(b"")
        self.env.update(PATH=f"{bin_dir}{os.pathsep}{self.env['PATH']}", XDG_RUNTIME_DIR=str(run))
        return run

    def test_a_bus_with_no_user_manager_behind_it_still_gets_the_build(self):
        self.tape_in_use()
        self.fake_systemd_run(fails=True)  # a container, a dbus without systemd --user: the bus, no systemd/private
        self.assertEqual(self.hook("SessionStart", self.base("SessionStart", source="startup")).returncode, 0)
        self.assertEqual(self.wait_runs(1), [["build", "--on-start", "--cwd", str(self.repo)]])

    def user_manager_socket(self, run):
        """What systemd --user leaves in its runtime dir: systemd/private, a listening AF_UNIX socket."""
        import socket
        (run / "systemd").mkdir()
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(sock.close)
        sock.bind(str(run / "systemd" / "private"))
        sock.listen()

    def test_a_file_named_like_the_user_managers_socket_is_not_one(self):
        self.tape_in_use()
        run = self.fake_systemd_run(fails=True)
        (run / "systemd").mkdir()
        (run / "systemd" / "private").write_bytes(b"")
        self.assertEqual(self.hook("SessionStart", self.base("SessionStart", source="startup")).returncode, 0)
        self.assertEqual(self.wait_runs(1), [["build", "--on-start", "--cwd", str(self.repo)]])

    def test_the_build_runs_in_a_scope_where_the_user_manager_is_there(self):
        self.tape_in_use()
        run = self.fake_systemd_run(fails=False)
        self.user_manager_socket(run)
        self.assertEqual(self.hook("SessionStart", self.base("SessionStart", source="startup")).returncode, 0)
        self.assertEqual(self.wait_runs(1), [["build", "--on-start", "--cwd", str(self.repo)]])
        self.assertIn("--user --scope --collect --quiet -p MemoryMax=2G --", (self.tmp / "systemd-run.log").read_text())

    def test_tape_in_use_is_read_at_tapes_own_index_even_with_home_unset(self):
        """The hook reads tape's index path from memo's tape_index, the one tape's index_path is. With HOME unset
        both are under the account's home, as Path.home() finds it (the hook's own copy had /tmp)."""
        import pwd
        from importlib.machinery import SourceFileLoader
        from importlib.util import module_from_spec, spec_from_loader
        def load(name, path):
            loader = SourceFileLoader(name, str(path))
            module = module_from_spec(spec_from_loader(name, loader))
            loader.exec_module(module)
            return module
        memo, tape = load("memo_for_hook_test", MEMO), load("tape_for_hook_test", ROOT / "scripts" / "tape")
        env = {k: v for k, v in self.env.items() if k not in ("HOME", "XDG_DATA_HOME")}
        index = Path(pwd.getpwuid(os.getuid()).pw_dir) / ".local" / "share" / "tstack" / "tape" / "index.db"
        self.assertEqual(memo.tape_index(env), index)
        self.assertEqual(tape.index_path(env), index)
        self.assertEqual(memo.tape_index(self.env), self.index)

    def test_a_real_build_lands_the_sessions_turns(self):
        tape = ROOT / "scripts" / "tape"
        env = {**self.env, "CLAUDE_PLUGIN_ROOT": str(ROOT)}
        if os.environ.get("XDG_RUNTIME_DIR"):  # the user systemd scope, where this machine has one
            env["XDG_RUNTIME_DIR"] = os.environ["XDG_RUNTIME_DIR"]
        subprocess.run([sys.executable, str(tape), "build"], cwd=self.repo, env=env, capture_output=True, check=True)
        self.assertTrue(self.index.exists())
        records = []
        for n, (kind, text) in enumerate([("user", "tape this turn"), ("assistant", "done"), ("user", "next")]):
            r = {"type": kind, "timestamp": f"2026-10-01T09:0{n}:00.000Z", "sessionId": "s1", "cwd": str(self.repo),
                 "uuid": f"u{n}", "isSidechain": False, "entrypoint": "cli"}
            if kind == "user":
                r.update(message={"role": "user", "content": text}, origin={"kind": "human"}, promptSource="typed")
            else:
                r["message"] = {"role": "assistant", "content": [{"type": "text", "text": text}]}
            records.append(json.dumps(r))
        projects = self.tmp / "home" / ".claude" / "projects" / "any-slug"
        projects.mkdir(parents=True)
        (projects / "s1.jsonl").write_text("\n".join(records) + "\n")
        r = subprocess.run([str(HOOK), "SessionStart"], input=json.dumps(self.base("SessionStart", source="startup")),
                           capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        deadline = time.monotonic() + 20
        found = ""
        while time.monotonic() < deadline and "tape this turn" not in found:
            time.sleep(0.1)
            found = subprocess.run([sys.executable, str(tape), "search", "tape"], cwd=self.repo, env=env,
                                   capture_output=True, text=True).stdout
        self.assertIn("tape this turn", found)


@unittest.skipUnless(shutil.which("jj"), "jj is not installed")
class JJHintsTest(HookCase):
    def setUp(self):
        super().setUp()
        self.env["MEMO_QUIET"] = "1"
        self.jjrepo = self.tmp / "jjrepo"
        self.jjrepo.mkdir()
        subprocess.run(["jj", "git", "init", "--colocate"], cwd=self.jjrepo, check=True, capture_output=True)

    def context(self, cwd, **extra):
        r = self.hook("SessionStart", {**self.base("SessionStart", source="startup"), "cwd": str(cwd), **extra})
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"] if r.stdout else ""

    def hints(self, context):
        return context[context.index("# jj"):] if "# jj" in context else ""

    def test_a_jj_repo_gets_the_hints_from_any_subfolder(self):
        (self.jjrepo / "src" / "deep").mkdir(parents=True)
        for cwd in (self.jjrepo, self.jjrepo / "src" / "deep"):
            hints = self.hints(self.context(cwd))
            self.assertTrue(hints.startswith("# jj\n"))
            self.assertIn("detached git HEAD is normal", hints)
            self.assertIn("jj git push --bookmark <b>", hints)
            self.assertIn("jj rebase -b @ -d <b>@origin", hints)
            self.assertIn("land-check -b <b>", hints)
            self.assertIn("/tstack:worktree-janitor", hints)
            self.assertNotIn("secondary workspace;", hints)
            self.assertLessEqual(len(hints.splitlines()), 10)

    def test_a_secondary_workspace_names_the_main_one(self):
        second = self.tmp / "jjrepo-lane"
        subprocess.run(["jj", "workspace", "add", str(second), "--name", "lane"], cwd=self.jjrepo,
                       check=True, capture_output=True)
        self.assertTrue((second / ".jj" / "repo").is_file())
        hints = self.hints(self.context(second))
        self.assertIn(f"the main one is {self.jjrepo}", hints)

    def test_silent_outside_jj(self):
        self.assertEqual(self.hints(self.context(self.repo)), "")  # plain git
        plain = self.tmp / "plain"
        plain.mkdir()
        self.assertEqual(self.hints(self.context(plain)), "")
        half = self.tmp / "half"
        (half / ".jj").mkdir(parents=True)
        self.assertEqual(self.hints(self.context(half)), "")

    def test_workers_get_the_hints_and_memo_stays_first(self):
        self.assertIn("# jj", self.context(self.jjrepo, agent_id="w1"))
        self.env["MEMO_QUIET"] = ""
        context = self.context(self.jjrepo)
        self.assertTrue(context.startswith("# memo"), context[:80])
        self.assertIn("\n\n# jj\n", context)

    def test_the_hint_is_fast(self):
        (self.jjrepo / "a" / "b" / "c").mkdir(parents=True)
        payload = {**self.base("SessionStart", source="startup"), "cwd": str(self.jjrepo / "a" / "b" / "c")}
        self.hook("SessionStart", payload)
        self.assertCheap("SessionStart (jj hints)", "SessionStart", payload)


class TucaModeTest(HookCase):
    """The flag scripts/tuca-mode writes, and the SessionStart handler that re-injects the mode."""

    def flag(self, *args, env=None):
        r = subprocess.run([str(TUCA), *args], capture_output=True, text=True, env={**self.env, **(env or {})},
                           timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stderr, "")
        return r.stdout.strip()

    def context(self, source, **extra):
        r = self.hook("SessionStart", self.base("SessionStart", source=source, **extra))
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"] if r.stdout else ""

    def block(self, source, **extra):
        context = self.context(source, **extra)
        return context[context.index("# tuca-mode"):] if "# tuca-mode" in context else ""

    def test_on_status_off_round_trip(self):
        flag = self.data / "sessions" / "sess-1" / "tuca-mode"
        self.assertEqual(self.flag("status", "sess-1"), "tuca-mode: off for session sess-1")
        self.assertIn(f"(flag {flag})", self.flag("on", "sess-1"))
        self.assertTrue(flag.is_file())
        self.assertIn("(flag", self.flag("on", "sess-1"))  # idempotent
        self.assertEqual(self.flag("status", "sess-1"), "tuca-mode: on for session sess-1")
        self.assertEqual(self.flag("off", "sess-1"), "tuca-mode: off for session sess-1")
        self.assertFalse(flag.exists())
        self.assertEqual(self.flag("off", "sess-1"), "tuca-mode: already off for session sess-1")

    def test_data_flag_wins_over_the_environment(self):
        # The skill's `!` line runs without CLAUDE_PLUGIN_DATA in its environment, so it passes --data.
        other = self.tmp / "given"
        self.flag("on", "sess-1", "--data", str(other))
        self.assertTrue((other / "sessions" / "sess-1" / "tuca-mode").is_file())
        self.assertFalse((self.data / "sessions" / "sess-1").exists())
        env = {k: v for k, v in self.env.items() if k != "CLAUDE_PLUGIN_DATA"}
        r = subprocess.run([str(TUCA), "on", "sess-9"], capture_output=True, text=True,
                           env={**env, "XDG_STATE_HOME": str(self.tmp / "state")})
        self.assertIn(str(self.tmp / "state" / "tstack" / "sessions" / "sess-9"), r.stdout)

    def test_never_fails(self):
        blocker = self.tmp / "blocker"
        blocker.write_text("a file, not a folder")
        self.assertIn("the flag was not written", self.flag("on", "sess-1", "--data", str(blocker)))
        self.assertIn("no session id", self.flag("on", "${CLAUDE_SESSION_ID}"))
        self.assertTrue(self.flag().startswith("usage:"))
        self.assertTrue(self.flag("jump", "sess-1").startswith("usage:"))
        self.assertIn("tuca-mode:", self.flag("on", "../../etc/x"))
        self.assertTrue((self.data / "sessions" / ".._.._etc_x" / "tuca-mode").is_file())

    def test_reinjected_after_compact_and_resume_only_with_the_flag(self):
        for source in ("startup", "resume", "clear", "compact"):
            self.assertEqual(self.block(source), "", source)
        self.flag("on", "sess-1")
        for source in ("compact", "resume"):
            block = self.block(source)
            self.assertTrue(block.startswith("# tuca-mode is on\n"), block[:60])
            self.assertLessEqual(len(block.splitlines()), 15)
            self.assertIn(str(ROOT / "skills" / "engineering" / "tuca-mode" / "SKILL.md"), block)
            self.assertIn("copied verbatim", block)
            self.assertIn("only when `land-check` says it will not deploy", block)
            self.assertIn(f"{ROOT / 'bin' / 'tuca-mode'} off sess-1 --data {self.data}", block)
        for source in ("startup", "clear"):
            self.assertEqual(self.block(source), "", source)
        self.assertEqual(self.block("compact", session_id="sess-2"), "")
        self.flag("off", "sess-1")
        self.assertEqual(self.block("compact"), "")

    def test_workers_never_get_it(self):
        self.flag("on", "sess-1")
        self.assertEqual(self.block("compact", agent_id="w1"), "")
        self.assertSilent(self.hook("SessionStart", self.base("SessionStart", source="compact"),
                                    env={"TSTACK_ROLE": "worker"}))

    def test_it_follows_memo_and_jj(self):
        self.memo("note", "fact", "tuca order")
        self.flag("on", "sess-1")
        context = self.context("compact")
        self.assertTrue(context.startswith("# memo"))
        self.assertTrue(context.rstrip().split("\n\n")[-1].startswith("# tuca-mode is on"))

    def test_the_reinjection_is_fast(self):
        self.flag("on", "sess-1")
        payload = self.base("SessionStart", source="compact")
        self.hook("SessionStart", payload)
        self.assertCheap("SessionStart (tuca-mode)", "SessionStart", payload)


class StopTest(HookCase):
    def stop(self, env=None, **extra):
        return self.hook("Stop", self.base("Stop", stop_hook_active=False, **extra), env=env)

    def context(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "Stop")
        return out["hookSpecificOutput"]["additionalContext"]

    def test_real_work_without_a_note_is_reminded_once(self):
        self.transcribe(said("fix it"), tool_use("Read", file_path="a"), tool_use("Edit", file_path="a"))
        self.assertIn("memo note", self.context(self.stop()))
        self.transcribe(tool_use("Write", file_path="b"))
        self.assertSilent(self.stop())
        state = json.loads((self.data / "sessions" / "sess-1.memo.json").read_text())
        self.assertTrue(state["reminded"])

    def test_sessions_are_tracked_apart(self):
        self.transcribe(tool_use("MultiEdit", file_path="a"))
        self.context(self.stop())
        self.context(self.hook("Stop", {**self.base("Stop"), "session_id": "sess-2"}))

    def test_reading_is_not_work_and_the_scan_is_incremental(self):
        self.transcribe(tool_use("Read", file_path="a"), tool_use("Bash", command="jj log -r @"))
        self.assertSilent(self.stop())
        self.transcribe(tool_use("Bash", command="jj --no-pager describe -m 'feat: x'"))
        self.assertIn("memo note", self.context(self.stop()))

    def test_a_commit_counts_and_a_note_satisfies(self):
        for command in ("jj commit -m x", "git commit -qm x", "jj desc -r @- -m y"):
            self.transcript.write_text("")
            shutil.rmtree(self.data, ignore_errors=True)
            self.transcribe(tool_use("Bash", command=command))
            self.assertIn("memo note", self.context(self.stop()), command)
        self.transcript.write_text("")
        shutil.rmtree(self.data, ignore_errors=True)
        self.transcribe(tool_use("Edit", file_path="a"),
                        tool_use("Bash", command='/x/scripts/memo note gotcha "the index is a cache"'))
        self.assertSilent(self.stop())
        self.transcribe(tool_use("Edit", file_path="b"))
        self.assertSilent(self.stop())

    def test_quoted_tool_names_in_text_are_not_work(self):
        self.transcribe(said('the transcript says "name":"Edit" and tool_use'))
        self.assertSilent(self.stop())

    def test_skipped_for_workers_quiet_and_an_active_stop_hook(self):
        self.transcribe(tool_use("Edit", file_path="a"))
        self.assertSilent(self.stop(agent_id="worker-1"))
        self.assertSilent(self.hook("Stop", self.base("Stop"), env={"TSTACK_ROLE": "worker"}))
        self.assertSilent(self.hook("Stop", self.base("Stop"), env={"MEMO_QUIET": "1"}))
        self.assertSilent(self.hook("Stop", self.base("Stop", stop_hook_active=True)))
        self.assertSilent(self.hook("Stop", self.base("Stop"), env={"CLAUDE_CODE_SESSION_ATTENDED": "0"}))
        self.assertSilent(self.hook("Stop", self.base("Stop"), env={"CLAUDE_CODE_ENTRYPOINT": "sdk-cli"}))
        self.context(self.stop(env={"CLAUDE_CODE_SESSION_ATTENDED": "1", "CLAUDE_CODE_ENTRYPOINT": "cli"}))

    def test_a_half_written_last_line_waits_for_the_next_run(self):
        self.transcribe(tool_use("Read", file_path="a"))
        line = json.dumps(tool_use("Edit", file_path="a"), separators=(",", ":"))
        with open(self.transcript, "a") as f:
            f.write(line[:30])
        self.assertSilent(self.stop())
        with open(self.transcript, "a") as f:
            f.write(line[30:] + "\n")
        self.context(self.stop())


class PreCompactTest(HookCase):
    def test_prints_compaction_instructions_as_plain_text(self):
        r = self.hook("PreCompact", self.base("PreCompact", trigger="auto", custom_instructions=None))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Memo candidates", r.stdout)
        with self.assertRaises(ValueError):
            json.loads(r.stdout)
        self.assertSilent(self.hook("PreCompact", self.base("PreCompact", trigger="manual", agent_id="w")))


class NeverBreakTest(HookCase):
    """Whatever the input or the state of the machine: exit 0, nothing on stdout."""

    def test_bad_input(self):
        for raw in ("not json", "[1, 2]", "null", '{"session_id": ', "\x00\xff", '{"cwd": 7, "source": []}'):
            for event in ("SessionStart", "Stop", "PreCompact"):
                r = self.hook(event, raw=raw)
                self.assertEqual(r.returncode, 0, (event, raw, r.stderr))
                if not raw.startswith('{"cwd"'):  # an object of odd values is still answered
                    self.assertEqual(r.stdout, "", (event, raw))
        self.assertIn("dispatcher failed", self.log())

    def test_unknown_or_missing_event(self):
        self.assertSilent(self.hook("NoSuchEvent", self.base("NoSuchEvent")))
        r = subprocess.run([str(HOOK)], input="{}", capture_output=True, text=True, env=self.env)
        self.assertSilent(r)

    def test_a_failing_handler_is_logged_and_silent(self):
        broken = self.tmp / "broken-plugin"
        (broken / "scripts").mkdir(parents=True)
        (broken / "scripts" / "memo").write_text("raise RuntimeError('memo exploded')\n")
        r = self.hook("SessionStart", self.base("SessionStart", source="startup"),
                      env={"CLAUDE_PLUGIN_ROOT": str(broken)})
        self.assertSilent(r)
        self.assertIn("memo exploded", self.log())
        self.assertIn("SessionStart memo_wake failed", self.log())

    def test_a_missing_memo_script_is_silent(self):
        r = self.hook("SessionStart", self.base("SessionStart", source="startup"),
                      env={"CLAUDE_PLUGIN_ROOT": str(self.tmp / "nowhere")})
        self.assertSilent(r)

    def test_odd_transcripts(self):
        folder = self.tmp / "a-folder"
        folder.mkdir()
        garbage = self.tmp / "garbage.jsonl"
        garbage.write_bytes(os.urandom(4096) + b'\n{"type":"tool_use" broken\n' + b'"tool_use"\n[1]\n')
        for path in (str(folder), str(garbage), str(self.tmp / "missing.jsonl"), 42, None, ["x"]):
            r = self.hook("Stop", {**self.base("Stop"), "transcript_path": path})
            self.assertSilent(r)

    def test_an_unwritable_plugin_data_dir(self):
        blocker = self.tmp / "blocker"
        blocker.write_text("a file, not a folder")
        self.transcribe(tool_use("Edit", file_path="a"))
        r = self.hook("Stop", self.base("Stop"), env={"CLAUDE_PLUGIN_DATA": str(blocker / "sub")})
        self.assertSilent(r)

    def test_a_broken_memory_store_still_wakes_or_stays_silent(self):
        notes = self.repo / ".tstack" / "memo" / "notes"
        notes.mkdir(parents=True)
        (notes / "01ARZ3NDEKTSV4RRFFQ69G5FAV.md").write_text("+++\nnot toml at all ===\n+++\ntext\n")
        (self.repo / ".tstack" / "memo" / "config.toml").write_text("project_lines = [broken")
        r = self.hook("SessionStart", self.base("SessionStart", source="startup"))
        self.assertEqual(r.returncode, 0)
        self.assertIn("# memo", json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"])

    def test_headless_sessions_still_wake(self):
        r = self.hook("SessionStart", self.base("SessionStart", source="startup"),
                      env={"CLAUDE_CODE_SESSION_ATTENDED": "0", "CLAUDE_CODE_ENTRYPOINT": "sdk-cli"})
        self.assertIn("# memo", json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"])


def load_hook(onepw=True):
    """hooks/tstack-hook.py as a module, to time a handler without the interpreter's start-up; with its 1Password part
    (hooks/fleet-hook-onepw.py, which the hook reads only for a call that needs it) unless `onepw` is False."""
    from importlib.machinery import SourceFileLoader
    from importlib.util import module_from_spec, spec_from_loader
    loader = SourceFileLoader("tstack_hook_under_test", str(SOURCE))
    module = module_from_spec(spec_from_loader("tstack_hook_under_test", loader))
    loader.exec_module(module)
    if onepw:
        module._onepw()
    return module


class FleetCase(HookCase):
    """A coordinator's fleet in its scratchpad, for the listening rules (the Stop guard, the nudge)."""

    def setUp(self):
        super().setUp()
        self.env["MEMO_QUIET"] = "1"
        self.pad = self.tmp / "scratchpad"
        self.fleet = self.pad / "coordinator"
        self.fleet.mkdir(parents=True)
        self.ledger()
        self.fleet_cli = f"{ROOT}/fleet/bin/fleet"
        self.registry = self.tmp / "registry"
        self.registry.mkdir()
        self.env["FLEET_HOME"] = str(self.registry)
        self.register(self.fleet)

    def register(self, fleet, session="sess-1", id="p", **fields):
        """The hub's registry entry `fleet serve` writes for FLEET, served by SESSION. Its `pid` is the tests'
        own process, which is not Claude Code: the entry names no host session unless FIELDS give one."""
        (self.registry / f"{id}.json").write_text(json.dumps({
            "id": id, "role": "coordinator", "dir": str(fleet), "url": f"http://127.0.0.1:7420/f/{id}/",
            "pid": os.getpid(), "session": None, "session_id": session, "since": "2026-01-05T08:00:00+00:00",
            **fields}))

    def ledger(self, **fields):
        state = {"project": "p", "goal": "g", "status": "running", "now": "n", "started": "2026-01-05T08:00:00+00:00",
                 "roadmap": [], "agents": [], "roadblocks": [], "decisions": [], "events": [], **fields}
        (self.fleet / "state.json").write_text(json.dumps(state))

    def say(self, id, at, text="hi", frm="user", to=("coordinator",), re=None, **extra):
        with open(self.fleet / "chat.jsonl", "a") as f:
            f.write(json.dumps({"id": id, "at": at, "from": frm, "to": list(to), "text": text, "re": re,
                                "parts": [{"text": text}], **extra}) + "\n")

    def payload(self, event, **extra):
        return {**self.base(event), "scratchpad_dir": str(self.pad), **extra}

    def watch(self, fleet=None, role="coordinator", pid_file=True, once=True, owner=None):
        """A process whose command line is a chat watch's (`... chat DIR watch --as ROLE ... --once`). As a
        real watch does before it writes its pid file, it records who armed it: no session, as a watch a
        person types in a terminal, or OWNER (the record's `session` and `started`). So whether it counts
        never depends on who runs the tests (a terminal, an agent, a unit with neither a terminal nor a
        `claude` above it): the rule for a watch with no record reads the process tree, and is tried on
        trees of the tests' own (WatchOwnerTest), never on the real one."""
        fleet = fleet or self.fleet
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "chat", str(fleet), "watch",
                                 "--as", role, "--all", "--resume", *(["--once"] if once else [])])
        self.addCleanup(lambda: (proc.kill(), proc.wait()))
        session = owner or {"session": None, "started": None}
        (self.fleet / f"watch-{role}.owner.pid").write_text(json.dumps({"watch": proc.pid, **session}))
        if pid_file:
            (self.fleet / f"watch-{role}.pid").write_text(str(proc.pid))
        return proc


class TapeRoleTest(FleetCase):
    """TSTACK_ROLE=tape, a tape builder's own `claude -p` call: every handler of every event stays silent and
    writes nothing (no wake in the compaction prompt, no heartbeat, no state, no spawn)."""

    def files(self):
        return sorted(str(p.relative_to(self.tmp)) for p in self.tmp.rglob("*") if p.is_file())

    def every_event(self, env):
        self.memo("note", "decision", "a wake would carry this")
        self.env.pop("MEMO_QUIET")
        self.transcribe(said("edit it"), tool_use("Edit", file_path=str(self.repo / "a.py")))
        before = self.files()
        results = {}
        for event in json.loads(HOOKS_JSON.read_text())["hooks"]:
            payload = self.payload(event, source="startup", stop_hook_active=False, tool_name="Agent",
                                   tool_input={"subagent_type": "general-purpose", "prompt": "p"},
                                   tool_use_id="toolu_1", agent_id="ab12" if event.startswith("Subagent") else None)
            results[event] = self.hook(event, payload, env=env)
        return before, results

    def test_every_handler_is_silent_and_writes_nothing(self):
        before, results = self.every_event({"TSTACK_ROLE": "tape"})
        for event, r in results.items():
            self.assertSilent(r)
        self.assertEqual(self.files(), before, "a tape call's hooks wrote a file")
        self.assertFalse((self.fleet / "heartbeats").exists())

    def test_the_same_events_speak_without_the_role(self):
        before, results = self.every_event({})
        self.assertIn("a wake would carry this", results["SessionStart"].stdout)
        self.assertTrue((self.fleet / "heartbeats").is_dir(), "the control run beats")
        self.assertNotEqual(self.files(), before)


class DreamPendingTest(FleetCase):
    """memo_dream_pending: a coordinator's SessionStart says, in one line, how many drafted notes wait for Luiz."""

    def batch(self, key, date, n, answer=None):
        """A batch as memo-dream itself saves it, so the hook reads memo-dream's own layout."""
        from importlib.machinery import SourceFileLoader
        from importlib.util import module_from_spec, spec_from_loader
        loader = SourceFileLoader("dream_for_hook", str(ROOT / "scripts" / "memo-dream"))
        dream = module_from_spec(spec_from_loader("dream_for_hook", loader))
        loader.exec_module(dream)
        candidates = [{"kind": "fact", "text": f"t{k}", "turn": 0} for k in range(n)]
        dream.Batches(self.env, key).save({"project": key, "date": date, "made": 0, "turns": [0, 1], "answer": answer,
                                           "candidates": candidates})

    def lines(self, payload):
        result = self.hook("SessionStart", payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"] if result.stdout else ""
        return [l for l in text.splitlines() if l.startswith("memo-dream:")]

    def test_a_coordinator_hears_how_many_candidates_wait_across_projects(self):
        start = self.payload("SessionStart", source="startup")
        self.assertEqual(self.lines(start), [])
        self.batch("coelhorocha/custom-mcp-servers", "2026-10-01", 2)
        self.batch("acme/widget", "2026-10-02", 1)
        self.batch("acme/widget", "2026-10-01", 4, answer={"at": 0, "verdicts": ["drop"] * 4})
        self.assertEqual(self.lines(start), [
            f"memo-dream: 3 candidate notes wait for Luiz (`{ROOT}/scripts/memo-dream pending`, from any directory)."])

    def test_a_worker_and_a_session_hosting_no_fleet_hear_nothing(self):
        self.batch("coelhorocha/custom-mcp-servers", "2026-10-01", 2)
        self.assertEqual(self.lines(self.payload("SessionStart", source="startup", agent_id="a1")), [])
        self.assertEqual(self.lines({**self.base("SessionStart"), "source": "startup"}), [])



class PushParseTest(unittest.TestCase):
    """Reader.pushes: the pushes a shell line runs, where each runs, and whether the hook can read it."""

    def pushes(self, command, cwd="/w/home"):
        return [(p.tool, p.cwd, p.unclear) for p in load_hook().Reader().pushes(command, cwd)]

    def test_plain_pushes_are_read_through_cd_redirections_and_wrappers(self):
        for command, tool, cwd in (("cd ../app && jj git push -b master", "jj", "/w/app"),
                                   ("cd /r; jj -R sub git push --all", "jj", "/r"),
                                   ("jj git push -b master 2>&1", "jj", "/w/home"),
                                   ("jj git push -b master 2>&1 | tee /tmp/log", "jj", "/w/home"),
                                   ("git push origin master >/tmp/out </dev/null", "git", "/w/home"),
                                   ("git push origin master &>/dev/null", "git", "/w/home"),
                                   ("timeout 60 jj git push -b master", "jj", "/w/home"),
                                   ("timeout -s KILL 5m git push origin master", "git", "/w/home"),
                                   ("env -i PATH=/bin jj git push -b master", "jj", "/w/home"),
                                   ("/usr/bin/env FOO=1 git push origin master", "git", "/w/home"),
                                   ("nice -n 5 command git push origin master", "git", "/w/home"),
                                   ("bash -lc 'cd /r && jj git push'", "jj", "/r"),
                                   ("sh -c 'git push origin master'", "git", "/w/home"),
                                   ("nix shell nixpkgs#git --command git push origin master", "git", "/w/home"),
                                   ("devenv-run git push origin master", "git", "/w/home"),
                                   ("jj git -R /x push -b master", "jj", "/w/home")):
            with self.subTest(command=command):
                self.assertEqual(self.pushes(command), [(tool, cwd, False)])

    def test_a_push_the_hook_cannot_read_is_unclear(self):
        for command in ("for r in a b; do jj -R $r git push -b master; done",
                        "while true; do git push; done",
                        "if true; then git push origin master; fi",
                        "{ jj git push; }",
                        "(cd /x && jj git push)",
                        "x=$(git push origin master)",
                        'echo "$(jj git push)"',
                        "echo `git push`",
                        "eval 'jj git push -b master'",
                        "echo master | xargs jj git push -b",
                        "jj git push -b $BOOKMARK",
                        "cd $DIR && jj git push -b master"):
            with self.subTest(command=command):
                found = self.pushes(command)
                self.assertTrue(found, command)
                self.assertTrue(all(unclear for _, _, unclear in found), found)

    def test_what_is_not_a_push_is_left_alone(self):
        for command in ("jj git fetch && jj log", "echo push", "echo 'git push origin master'", "jj git push --dry-run -b master",
                        "git push -n origin master", "git log --grep push", "jj describe -m 'fix `jj git push` in the docs'",
                        "jj describe -m \"$(cat <<'EOF'\nhooks: why\n\ngit push origin master was not gated\nEOF\n)\"",
                        "git status # then git push", "unbalanced 'quote"):
            with self.subTest(command=command):
                self.assertEqual(self.pushes(command), [])

    def test_a_shell_script_that_pushes_is_unclear(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "land.sh").write_text("#!/bin/sh\nset -e\njj git push --bookmark master\n")
            Path(d, "tool").write_text("#!/usr/bin/env python3\n# `jj git push` is not run here\n")
            Path(d, "notes.sh").write_text("#!/bin/sh\necho jj will not push it\n")
            self.assertEqual(self.pushes("./land.sh", d), [("script", d, True)])
            self.assertEqual(self.pushes("bash land.sh --fast", d), [("script", d, True)])
            self.assertEqual(self.pushes("./tool && ./notes.sh", d), [])


@unittest.skipUnless(shutil.which("jj") and shutil.which("git") and shutil.which("bun"), "needs jj, git and bun")
class LandTurnGateTest(FleetCase):
    """land_turn_gate (PreToolUse, Bash): in a fleet under a manager, a push to the landing bookmark on the landing
    remote, or a push the hook cannot read, is denied until the manager gave the fleet the landing turn (`fleet
    turn`, found by this test's pid, which the registry entry carries). Any other push goes through without asking
    the fleet CLI, and so does any session outside a managed fleet."""

    JJ = {"JJ_USER": "Test", "JJ_EMAIL": "test@example.com", "JJ_CONFIG": ""}

    def setUp(self):
        super().setUp()
        self.env.update(self.JJ, XDG_CONFIG_HOME=str(self.tmp / "config"))  # where jj keeps a repo's config
        remote = self.tmp / "remote.git"
        fork = self.tmp / "fork.git"
        for bare in (remote, fork):
            subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
        self.work = self.tmp / "work"
        self.jj("git", "init", "--colocate", str(self.work), cwd=self.tmp)
        self.jj("git", "remote", "add", "origin", str(remote))
        self.jj("git", "remote", "add", "fork", str(fork))
        (self.work / "a").write_text("a\n")
        self.jj("commit", "-m", "a")
        self.jj("bookmark", "set", "master", "-r", "@-")
        self.jj("git", "push", "--bookmark", "master")
        (self.work / "b").write_text("b\n")
        self.jj("commit", "-m", "b")
        self.jj("bookmark", "set", "master", "-r", "@-")
        self.jj("bookmark", "set", "feat", "-r", "@-")
        self.jj("config", "set", "--repo", "aliases.ship", '["git", "push", "--bookmark", "master"]')
        self.jj("config", "set", "--repo", "aliases.p", '["git", "push"]')
        subprocess.run(["git", "-C", str(self.work), "config", "alias.pub", "push origin HEAD:refs/heads/master"], check=True)
        self.calls = self.tmp / "cli-calls"
        self.ledger = self.fleet / "state.json"
        self.detached = []
        self.addCleanup(self.logs_ended)

    def hook(self, event, payload=None, raw=None, env=None):
        """HookCase's, handing the hook the write end of a pipe: anything it leaves running keeps that end open, so the
        read end's EOF says the hook's detached work has ended. The temporary folder goes only after that."""
        read, write = os.pipe()
        self.detached.append(read)
        try:
            return subprocess.run([str(HOOK), event], input=raw if raw is not None else json.dumps(payload or {}),
                                  capture_output=True, text=True, env={**self.env, **(env or {})}, timeout=30,
                                  pass_fds=(write,))
        finally:
            os.close(write)

    def logs_ended(self):
        while self.detached:
            read = self.detached.pop()
            ended, _, _ = select.select([read], [], [], 60)
            os.close(read)
            self.assertTrue(ended, "a denial's log did not end")

    def jj(self, *args, cwd=None):
        subprocess.run(["jj", *args], cwd=cwd or self.work, env={**os.environ, **self.env}, check=True,
                       capture_output=True)

    def manager(self, *steps):
        d = self.tmp / "manager"
        d.mkdir(exist_ok=True)
        (d / "state.json").write_text(json.dumps({
            "project": "manager", "goal": "g", "status": "running", "now": "", "role": "manager",
            "started": "2026-01-05T08:00:00+00:00", "agents": [], "roadblocks": [], "decisions": [], "events": [],
            "roadmap": [{"id": "landings", "title": "Landings and deploys",
                         "steps": [{"id": i, "title": f"{a}: push", "status": s, "agent": a} for i, s, a in steps]}]}))
        (self.registry / "manager.json").write_text(json.dumps({
            "id": "manager", "role": "manager", "dir": str(d), "url": "http://127.0.0.1:7420/f/manager/",
            "pid": os.getpid(), "session": None, "since": "2026-01-05T07:00:00+00:00"}))

    def hung_cli(self):
        """A fleet CLI that records each start and never answers."""
        cli = self.tmp / "hung-fleet"
        cli.write_text(f"#!/bin/sh\necho \"$@\" >>{self.calls}\nexec sleep 30\n")
        cli.chmod(0o755)
        return {"TSTACK_FLEET_CLI": str(cli), "TSTACK_TURN_TIMEOUT_S": "1"}

    def push(self, command, cwd=None, env=None):
        payload = {**self.payload("PreToolUse"), "tool_name": "Bash", "tool_input": {"command": command},
                   "cwd": str(cwd or self.work)}
        r = self.hook("PreToolUse", payload, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def reason(self, r):
        self.assertTrue(r.stdout, f"not denied; stderr: {r.stderr}; log: {self.log()}")
        decision = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(decision["permissionDecision"], "deny")
        return decision["permissionDecisionReason"]

    def denied(self, r):
        """The denial's reason, once its log ended: the hook logs out of its own process, after it answered."""
        reason = self.reason(r)
        self.logs_ended()
        return reason

    def events(self):
        return [e for e in json.loads(self.ledger.read_text())["events"] if e.get("kind") == "blocked"]

    def held_log(self, name):
        """A stand-in that starts as the denial's log would and waits for `go` before it says so in `logged`: how long
        it holds the hook is how long a slow log would. `turn` answers at once, as a fleet without the turn."""
        go, logged = self.tmp / "go", self.tmp / "logged"
        stand_in = self.tmp / name
        stand_in.write_text(f"""#!/bin/sh
if [ "$1" = turn ]; then echo 'turn: p does not hold the landing turn (l1)' >&2; exit 1; fi
n=0
while [ ! -e {go} ] && [ $n -lt 1200 ]; do sleep 0.05; n=$((n + 1)); done
: >{logged}
""")
        stand_in.chmod(0o755)
        return stand_in, go, logged

    def assert_denied_before_the_log(self, env, go, logged):
        """The hook's answer is out, and the hook gone with its pipes closed (subprocess.run waits for both), while the
        log has not finished; the log then ends on its own."""
        started = time.monotonic()
        r = self.push("jj git push --bookmark master", env=env)
        took = time.monotonic() - started
        self.assertIn("doesn't hold the landing turn", self.reason(r))
        self.assertLess(took, 25, "the log held the hook's answer")
        self.assertFalse(logged.exists())
        go.touch()
        self.logs_ended()
        self.assertTrue(logged.exists())

    def test_a_slow_log_does_not_hold_the_denial(self):
        """Claude Code reads a hook's output when it exits, and past the hook's timeout discards it and runs the call:
        a denial held by its log is a push let through."""
        self.manager(("l1", "current", "infra"))
        cli, go, logged = self.held_log("slow-fleet")
        self.assert_denied_before_the_log({"TSTACK_FLEET_CLI": str(cli)}, go, logged)

    def test_a_slow_program_does_not_hold_a_moved_fleets_denial(self):
        MovedFleet.move(self)
        self.manager(("l1", "current", "infra"))
        cli, go, logged = self.held_log("slow-fleet")
        self.assert_denied_before_the_log({"TSTACK_FLEET_CLI": str(cli), "TSTACK_FLEET_RUN": str(cli)}, go, logged)

    @unittest.skipUnless(Path("/proc/self/fd").is_dir(), "reads the detached process's descriptors in /proc")
    def test_the_denials_log_holds_none_of_the_hooks_pipes(self):
        """Claude Code waits on the hook's stdout and stderr, and its stdin is one more pipe of the session's."""
        self.manager(("l1", "current", "infra"))
        seen = self.tmp / "descriptors"
        cli = self.tmp / "fleet-stand-in"
        cli.write_text(f"""#!/bin/sh
if [ "$1" = turn ]; then echo 'turn: p does not hold the landing turn (l1)' >&2; exit 1; fi
for fd in 0 1 2; do readlink /proc/$PPID/fd/$fd >>{seen}; done
""")
        cli.chmod(0o755)
        self.denied(self.push("jj git push --bookmark master", env={"TSTACK_FLEET_CLI": str(cli)}))
        self.assertEqual(seen.read_text().split(), ["/dev/null", "/dev/null", "/dev/null"])

    def test_a_fleet_found_only_by_the_sessions_process_gets_its_denial_logged(self):
        """Once the hook exits, the detached write has no session among its parents: the ledger is found before."""
        self.env["XDG_STATE_HOME"] = str(self.tmp / "state")
        home = self.tmp / "state" / "fleet" / "p"
        home.mkdir(parents=True)
        (home / "state.json").write_text((self.fleet / "state.json").read_text())
        (self.fleet / "state.json").unlink()
        self.ledger = home / "state.json"
        self.register(home)
        self.manager(("l1", "current", "infra"), ("l2", "pending", "p"))
        self.denied(self.push("jj git push --bookmark master"))
        [event] = self.events()
        self.assertIn("Push gate: refused `jj git push --bookmark master`", event["text"])

    def test_a_push_without_the_turn_is_denied_and_logged(self):
        self.manager(("l1", "current", "infra"), ("l2", "pending", "p"))
        reason = self.denied(self.push("jj git push --bookmark master"))
        self.assertIn("landing bookmark master", reason)
        self.assertIn("p doesn't hold the landing turn (fleet turn: p does not hold the landing turn (l1", reason)
        self.assertIn("yours, l2, waits in the queue", reason)
        self.assertIn("Luiz's approval to push doesn't skip the queue", reason)
        [event] = self.events()
        self.assertTrue(event.get("important"))
        self.assertIn("Push gate: refused `jj git push --bookmark master`", event["text"])

    def test_a_moved_fleets_push_denial_is_logged_through_fleet_run(self):
        MovedFleet.move(self)
        self.manager(("l1", "current", "infra"), ("l2", "pending", "p"))
        self.denied(self.push("jj git push --bookmark master"))
        self.assertEqual(self.events(), [])
        [run] = MovedFleet.programs(self)
        [op] = run["ops"]
        self.assertEqual((op["record"], op["set"]["kind"], op["set"]["important"]), ({"kind": "event"}, "blocked", True))
        self.assertIn("Push gate: refused `jj git push --bookmark master`", op["set"]["text"])

    def test_a_moved_fleet_whose_registry_entry_is_gone_still_waits_for_the_turn(self):
        """The cut-over's `fleet serve --stop` removes the fleet's registry entry, so `fleet turn` cannot find it by the
        session's process: the gate names the moved folder the session served in $FLEET_DIR."""
        self.env["XDG_STATE_HOME"] = str(self.tmp / "state")
        home = self.tmp / "state" / "fleet" / "p"
        home.mkdir(parents=True)
        (home / "state.json").write_text((self.fleet / "state.json").read_text())
        (self.fleet / "state.json").unlink()
        self.ledger = home / "state.json"
        self.register(home)
        self.manager(("l1", "current", "infra"), ("l2", "pending", "p"))
        self.denied(self.push("jj git push --bookmark master"))  # served: found by the session's process, remembered
        MovedFleet.move(self, home)
        (self.registry / "p.json").unlink()
        reason = self.denied(self.push("jj git push --bookmark master"))
        self.assertIn("p doesn't hold the landing turn (fleet turn: p does not hold the landing turn (l1", reason)
        [run] = MovedFleet.programs(self)
        self.assertEqual(run["dir"], str(home))
        self.manager(("l1", "done", "infra"), ("l2", "current", "p"))
        self.assertSilent(self.push("jj git push --bookmark master"))

    def moved_manager(self, status):
        """A manager moved to the cloud and present, whose folder gives landing l1, `status`, to fleet p."""
        d = self.registry.parent / "fleet" / "manager"
        d.mkdir(parents=True)
        (d / "state.json").write_text(json.dumps({
            "project": "manager", "goal": "g", "status": "running", "now": "", "role": "manager",
            "started": "2026-01-05T08:00:00+00:00", "agents": [], "roadblocks": [], "decisions": [], "events": [],
            "roadmap": [{"id": "landings", "title": "Landings and deploys",
                         "steps": [{"id": "l1", "title": "p: push", "status": status, "agent": "p"}]}]}))
        (d / "cloud.json").write_text(json.dumps({"fleet": "manager", "cloud": "https://fleet.example.dev",
                                                  "since": "2026-01-05T08:00:00Z", "host": "box"}))
        started = subprocess.run(["bun", "-e", f'import {{ startedOf }} from "{ROOT / "fleet" / "src" / "procs.ts"}"; '
                                               f'console.log(startedOf({os.getpid()}))'],
                                 capture_output=True, text=True, check=True).stdout.strip()
        (d / "wakes.json").write_text(json.dumps({"wakes": [], "owner": {"session": os.getpid(), "started": started}}))

    def fleet_run(self, body):
        """This machine's fleet-run, running `body`."""
        run = self.tmp / "fleet-run"
        run.write_text(f"#!/bin/sh\n{body}\n")
        run.chmod(0o755)
        self.env["TSTACK_FLEET_RUN"] = str(run)

    def test_a_failed_cloud_read_denies_a_push_the_folder_would_allow_and_says_why(self):
        """The manager took the turn back, and the folder that says p holds it can be behind the cloud."""
        self.moved_manager("current")
        for body, wait, why in (
                ("echo 'fleet-host is not running on this machine' >&2; exit 4", "10",
                 "fleet-run exited 4: fleet-host is not running on this machine"),
                ("""echo '{"id":"r","status":"queued","offline":{"since":"t","queued":3}}'; exit 3""", "10",
                 "the host's outbox holds it, 3 program(s) waiting with it"),
                ("""echo '{"id":"r","status":"paused"}'; exit 2""", "10", "fleet-run exited 2 (paused)"),
                ("exec sleep 30", "1", "fleet-run gave no answer in 1 s")):
            with self.subTest(why=why):
                self.fleet_run(body)
                reason = self.denied(self.push("jj git push --bookmark master", env={"FLEET_TURN_WAIT_S": wait}))
                self.assertIn("This push moves the landing bookmark master, and its landing turn could not be "
                              "confirmed (fleet turn: p cannot confirm the landing turn: the manager's ledger could "
                              f"not be read from the cloud ({why}", reason)
                self.assertIn("this machine must reach its host service and the cloud", reason)
                self.assertNotIn("doesn't hold", reason)
                self.assertIn("Push gate: refused `jj git push --bookmark master`: p could not confirm the landing "
                              "turn onto master", self.events()[-1]["text"])
        self.assertEqual(len(self.events()), 4)

    def test_a_failed_cloud_read_leaves_the_folders_no_standing(self):
        self.moved_manager("pending")
        self.fleet_run("exit 4")
        self.assertIn("p doesn't hold the landing turn (fleet turn: p does not hold the landing turn (no landing has "
                      "the turn; yours, l1, waits in the queue)", self.denied(self.push("jj git push --bookmark master")))

    def test_the_clouds_word_is_enough_when_the_read_works(self):
        self.moved_manager("pending")
        steps = '[{"id":"l1","title":"p: push","status":"current","agent":"p"}]'
        self.fleet_run(f"""echo '{{"status":"completed","result":[{{"record":{{"steps":{steps}}}}}]}}'""")
        self.assertSilent(self.push("jj git push --bookmark master"))

    def slow_stand_ins(self, dry_run="", turn="echo 'turn: p does not hold the landing turn (l1)' >&2; exit 1"):
        """The environment of a push whose jj dry run runs `dry_run` first and whose `fleet turn` runs `turn`."""
        bindir = self.tmp / "slow-bin"
        bindir.mkdir(exist_ok=True)
        (bindir / "jj").write_text(f"""#!/bin/sh
for a in "$@"; do if [ "$a" = --dry-run ]; then {dry_run or ':'}; break; fi; done
exec {shutil.which('jj')} "$@"
""")
        (bindir / "jj").chmod(0o755)
        cli = self.tmp / "slow-fleet"
        cli.write_text(f'#!/bin/sh\nif [ "$1" = turn ]; then {turn}; fi\n')
        cli.chmod(0o755)
        return {"PATH": f"{bindir}:{self.env['PATH']}", "TSTACK_FLEET_CLI": str(cli), "TSTACK_GUARD_DEADLINE_S": "2"}

    def test_a_guard_past_the_hooks_deadline_denies_the_call(self):
        """Past the hook's timeout in hooks.json Claude Code discards its output and runs the call, so the gate's own
        limits, each under it, must not add up to more: a slow dry run here, one for each push of a line in the field."""
        self.manager(("l1", "current", "infra"))
        env = self.slow_stand_ins(dry_run="exec sleep 30")
        started = time.monotonic()
        r = self.push("jj git push --bookmark master; jj git push --bookmark master", env=env)
        took = time.monotonic() - started
        self.assertTrue(self.reason(r).startswith("tstack guard land_turn_gate ran past the hook's deadline: denied."), r.stdout)
        self.assertLess(took, 10)

    def test_a_turn_cut_off_by_the_deadline_leaves_nothing_running(self):
        """`fleet turn` runs in a session of its own, so the hook's end does not stop it."""
        self.manager(("l1", "current", "infra"))
        pid = self.tmp / "turn.pid"
        env = self.slow_stand_ins(turn=f"echo $$ >{pid}; exec sleep 30")
        self.assertIn("ran past the hook's deadline", self.reason(self.push("jj git push --bookmark master", env=env)))
        turn = int(pid.read_text())
        for _ in range(100):
            try:
                os.kill(turn, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            os.kill(turn, signal.SIGKILL)
            self.fail("`fleet turn` outlived the hook")

    def test_only_a_pretooluse_guard_has_a_deadline(self):
        self.assertEqual(self.hook("PostToolUse", {**self.payload("PostToolUse"), "tool_name": "Bash"},
                                   env={"TSTACK_GUARD_DEADLINE_S": "0"}).stdout, "")
        self.assertNotIn("failed", self.log())

    def test_a_push_with_the_turn_is_allowed(self):
        self.manager(("l1", "done", "infra"), ("l2", "current", "p"))
        self.assertSilent(self.push("jj git push --bookmark master"))
        self.assertSilent(self.push("for r in a; do jj git push; done"))
        self.assertEqual(self.events(), [])

    def test_a_session_outside_a_managed_fleet_is_allowed(self):
        self.assertSilent(self.push("jj git push --bookmark master"))  # a fleet, no manager
        self.manager(("l1", "current", "infra"))
        (self.registry / "p.json").unlink()  # a manager, and this session serves no fleet
        self.assertSilent(self.push("jj git push --bookmark master"))
        self.assertSilent(self.push("eval 'jj git push'"))

    def test_a_fleet_cli_that_cannot_run_fails_open_with_a_warning(self):
        self.manager(("l1", "current", "infra"))
        r = self.push("jj git push --bookmark master", env={"TSTACK_FLEET_CLI": str(self.tmp / "no-fleet")})
        self.assertEqual(r.stdout, "")
        self.assertIn("could not be checked", r.stderr)
        self.assertEqual(self.events(), [])

    def test_a_hung_fleet_cli_is_started_for_a_landing_push_only(self):
        hung = self.hung_cli()
        for command in ("jj git push -b feat", "git push fork master", "git push --tags", "jj log"):
            self.assertSilent(self.push(command, env=hung))
        self.assertFalse(self.calls.exists())  # never asked
        started = time.monotonic()
        r = self.push("jj git push --bookmark master", env=hung)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(r.stdout, "")
        self.assertIn("could not be checked", r.stderr)
        self.assertEqual(self.calls.read_text().split(), ["turn"])

    def test_every_way_onto_the_landing_bookmark_is_gated(self):
        self.manager(("l1", "current", "infra"))
        elsewhere = self.tmp
        for command, cwd in ((f"cd {self.work} && jj git push -b master", elsewhere),
                             (f"cd {self.work}; jj git push", elsewhere),
                             (f"jj -R {self.work} git push --bookmark master", elsewhere),
                             ("jj git push -b master 2>&1", self.work),
                             ("jj git push -b master 2>&1 | tee push.log", self.work),
                             ("timeout 120 jj git push --bookmark master", self.work),
                             ("env -i PATH=\"$PATH\" git push origin master", self.work),
                             ("bash -lc 'jj git push --bookmark master'", self.work),
                             ("jj ship", self.work),
                             ("jj p -b master", self.work),
                             ("git pub", self.work),
                             ("git push origin HEAD:refs/heads/master", self.work),
                             (f"git -C {self.work} push origin HEAD:master", elsewhere),
                             ("git push origin master --tags", self.work),
                             ("jj git push --all", self.work)):
            with self.subTest(command=command):
                self.assertIn("landing bookmark master", self.denied(self.push(command, cwd=cwd)))
        self.assertEqual(len(self.events()), 15)

    def test_a_push_the_hook_cannot_read_is_denied_without_the_turn(self):
        self.manager(("l1", "current", "infra"))
        for command in ("for b in master; do jj git push -b $b; done", "echo master | xargs jj git push -b",
                        "eval 'git push origin master'", "jj git push -b $B", "(cd sub && jj git push)"):
            with self.subTest(command=command):
                reason = self.denied(self.push(command))
                self.assertIn("couldn't tell which bookmarks this push moves; run it as a plain "
                              "`jj git push --bookmark <b>` (or `git push origin <ref>`)", reason)
                self.assertIn("doesn't hold the landing turn", reason)

    def test_a_push_to_another_bookmark_remote_or_tags_is_allowed(self):
        self.manager(("l1", "current", "infra"))
        for command in ("jj git push -b feat", "jj p -b feat", "git push origin HEAD:refs/heads/feat", "jj git push -c @-",
                        "jj git push --remote fork -b master", "git push fork master", "git push --tags",
                        "git push origin --tags", "git push origin refs/tags/v1:refs/tags/v1",
                        "jj git push --dry-run -b master", "jj log -r master", "jj describe -m 'about `jj git push`'"):
            with self.subTest(command=command):
                self.assertSilent(self.push(command))
        self.assertEqual(self.events(), [])


@unittest.skipUnless(shutil.which("jj") and shutil.which("git"), "needs jj and git")
class PushAttributionTest(HookCase):
    """push_attribution (PreToolUse, Bash): a push is refused while a commit it sends carries an attribution trailer
    (Claude-Session:, a Co-Authored-By: naming Claude, "Generated with Claude Code"): Luiz's rule, fleet decision D585.
    Commits the remote has already are not read, and a push whose range the hook cannot work out goes through."""

    JJ = {"JJ_USER": "Test", "JJ_EMAIL": "test@example.com", "JJ_CONFIG": ""}

    def setUp(self):
        super().setUp()
        self.env.update(self.JJ, XDG_CONFIG_HOME=str(self.tmp / "config"))
        remote = self.tmp / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
        self.work = self.tmp / "work"
        self.jj("git", "init", "--colocate", str(self.work), cwd=self.tmp)
        self.jj("git", "remote", "add", "origin", str(remote))
        self.commit("a\n\nClaude-Session: https://claude.ai/code/session_old")
        self.jj("bookmark", "set", "master", "-r", "@-")
        self.jj("git", "push", "--bookmark", "master")

    def jj(self, *args, cwd=None):
        return subprocess.run(["jj", *args], cwd=cwd or self.work, env={**os.environ, **self.env}, check=True,
                              capture_output=True, text=True).stdout

    def commit(self, message):
        (self.work / f"f{len(list(self.work.iterdir()))}").write_text("x\n")
        self.jj("commit", "-m", message)
        self.jj("bookmark", "set", "master", "-r", "@-")
        return self.jj("log", "-r", "@-", "--no-graph", "-T", "change_id.short()")

    def push(self, command):
        payload = {**self.base("PreToolUse"), "tool_name": "Bash", "tool_input": {"command": command},
                   "cwd": str(self.work)}
        r = self.hook("PreToolUse", payload)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def denied(self, r):
        self.assertTrue(r.stdout, f"not denied; stderr: {r.stderr}; log: {self.log()}")
        decision = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(decision["permissionDecision"], "deny")
        return decision["permissionDecisionReason"]

    def test_a_trailer_in_the_pushed_range_is_refused_with_the_change_named(self):
        clean = self.commit("b")
        dirty = self.commit("c\n\nClaude-Session: https://claude.ai/code/session_x")
        reason = self.denied(self.push("jj git push --bookmark master"))
        self.assertIn(dirty, reason)
        self.assertNotIn(clean, reason)
        self.assertIn("Claude-Session:", reason)
        self.assertIn(f"jj describe -r {dirty}", reason)
        self.assertIn("D585", reason)

    def test_co_authored_by_claude_and_generated_with_are_refused(self):
        co = self.commit("b\n\nCo-Authored-By: Claude <noreply@anthropic.com>")
        gen = self.commit("c\n\n\U0001f916 Generated with [Claude Code](https://claude.com/claude-code)")
        reason = self.denied(self.push("jj git push -b master"))
        self.assertIn(co, reason)
        self.assertIn(gen, reason)

    def test_a_git_push_is_read_too(self):
        self.commit("b\n\nClaude-Session: https://claude.ai/code/session_x")
        commit = self.jj("log", "-r", "@-", "--no-graph", "-T", "commit_id.short(12)")
        reason = self.denied(self.push("git push origin master"))
        self.assertIn(commit, reason)
        self.assertIn("Claude-Session:", reason)

    def test_a_clean_range_another_coauthor_and_an_unreadable_push_go_through(self):
        self.commit("b\n\nCo-Authored-By: Ana <ana@example.com>")
        self.assertSilent(self.push("jj git push --bookmark master"))
        self.assertSilent(self.push("jj git push --bookmark nosuch"))
        self.assertSilent(self.push("jj git push --bookmark $B"))
        self.assertSilent(self.push("jj log"))

    def test_the_rule_quoted_in_prose_or_an_indented_block_goes_through(self):
        self.commit("b\n\nThe rule: never add a\nClaude-Session: line to a commit.")
        self.commit("c\n\nThe trailer it refuses:\n\n    Claude-Session: https://claude.ai/code/session_x")
        self.commit("d\n\nThis was generated with claude code's help.")
        self.commit('e\n\nDrop the "\U0001f916 Generated with [Claude Code](https://claude.com/claude-code)" line '
                    "from the PR template.")
        self.assertSilent(self.push("jj git push --bookmark master"))
        self.assertSilent(self.push("git push origin master"))

    def test_a_git_push_is_read_without_asking_the_remote(self):
        self.commit("b\n\nClaude-Session: https://claude.ai/code/session_x")
        commit = self.jj("log", "-r", "@-", "--no-graph", "-T", "commit_id.short(12)")
        subprocess.run(["git", "remote", "set-url", "origin", str(self.tmp / "gone.git")], cwd=self.work, check=True)
        for command in ("git push origin master", "git push origin HEAD:refs/heads/master",
                        "git push origin +master:master", "git -C . push origin master"):
            with self.subTest(command=command):
                self.assertIn(commit, self.denied(self.push(command)))
        self.assertSilent(self.push("git push origin :master"))

    def test_a_remote_with_no_bookmark_yet_goes_through(self):
        fork = self.tmp / "fork.git"
        subprocess.run(["git", "init", "-q", "--bare", str(fork)], check=True)
        self.jj("git", "remote", "add", "fork", str(fork))
        self.commit("b\n\nClaude-Session: https://claude.ai/code/session_x")
        self.assertSilent(self.push("jj git push --remote fork --bookmark master"))
        self.assertSilent(self.push("git push fork master"))


class AttributionLinesTest(unittest.TestCase):
    """attribution_lines: only real trailers and a whole "Generated with Claude Code" line near the end count."""

    @classmethod
    def setUpClass(cls):
        cls.lines = staticmethod(load_hook(onepw=False).attribution_lines)

    def test_trailers_naming_claude(self):
        self.assertEqual(self.lines("a", [("Claude-Session", "https://x"), ("Co-Authored-By", "Claude <n@a.com>"),
                                          ("Co-Authored-By", "Ana <ana@example.com>"), ("Signed-off-by", "Claude")]),
                         ["Claude-Session: https://x", "Co-Authored-By: Claude <n@a.com>"])

    def test_a_generated_line_counts_only_whole_near_the_end_and_as_written(self):
        gen = "\U0001f916 Generated with [Claude Code](https://claude.com/claude-code)"
        self.assertEqual(self.lines(f"a\n\n{gen}\n\nSigned-off-by: Ana", []), [gen])
        self.assertEqual(self.lines("a\n\nGenerated with Claude Code", []), ["Generated with Claude Code"])
        for body in (f"a\n\n{gen}\n\nb\n\nc", "a\n\ngenerated with Claude Code", f"a\n\n    {gen}",
                     f"a\n\nSee {gen} in the template."):
            with self.subTest(body=body):
                self.assertEqual(self.lines(body, []), [])


class SuiteParseTest(unittest.TestCase):
    """SuiteReader: which Bash lines run a repo's whole test suite (gated) and which a scoped run (left alone)."""

    def setUp(self):
        self.mod = load_hook()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.pkg = Path(self._tmp.name).resolve()
        (self.pkg / "package.json").write_text(json.dumps({"scripts": {
            "test": "vitest run", "test:workers": "vitest run --project workers", "test:one": "vitest run src/a.test.ts",
            "test:all": "pnpm run test:workers && pnpm run test:one", "build": "tsc -b", "check": "vp test"}}))
        (self.pkg / "app").mkdir()

    def suites(self, command, cwd=None):
        return [(s.what, s.unclear) for s in self.mod.SuiteReader().suites(command, str(cwd or self.pkg))]

    def test_whole_entry_points_are_full_suites(self):
        for command in ("pnpm test", "pnpm -r test", "pnpm --recursive run test", "pnpm --filter api test", "npm test",
                        "npm run test", "npm t", "yarn test", "vitest", "vitest run", "vitest -c vite.config.ts",
                        "vitest --project unit", "vp test", "vp test run", "just test", "just test --jobs 1", "bun test",
                        "just test-scripts", "just test-fleet", "just test-fleet-ts", "just test-page", "just test-coordinator",
                        "pytest", "pytest -x", "python3 -m pytest", "uv run pytest -q", "cargo test --lib",
                        "cargo test", "cargo test --workspace -p a", "cargo test -- --nocapture", "cargo nextest run",
                        "go test ./...", "go -C sub test ./...", "go test -v ./...",
                        "node --test", "npx vitest run", "pnpm exec vitest", "pnpm vitest run", "bunx vitest",
                        "python3 scripts/gates all", "./node_modules/.bin/vitest run"):
            with self.subTest(command=command):
                found = self.suites(command)
                self.assertTrue(found, command)
                self.assertFalse(any(unclear for _, unclear in found), found)

    def test_scoped_runs_are_not(self):
        for command in ("vitest run src/a.test.ts", "vitest src/a", "vitest --changed", "vitest --changed=HEAD~1",
                        "vitest related src/a.ts", "vitest run --dir packages/api", "vp test src/a.test.ts",
                        "pnpm test -- src/a.test.ts", "pnpm test src/a.test.ts", "npm run test -- --changed",
                        "just test-changed", "just test-coordinator-page", "just build-page", "bun test test/x.test.ts",
                        "bun test x", "bun test -t name", "vitest -t foo", "vitest run -t 'a b'", "vitest --testNamePattern=x",
                        "pnpm test -t parses", "npm test -- -t foo", "pytest -k foo", "pytest -kfoo", "pytest --lf",
                        "pytest --last-failed -x", "cargo test foo", "cargo test --lib foo", "cargo nextest run -E 'test(foo)'",
                        "cargo nextest run foo", "go test -run TestX ./...", "go test -run=TestX ./...",
                        "pytest tests/test_a.py", "pytest tests/", "pytest test_a.py -k b", "cargo test -p fleet",
                        "cargo test --package=fleet", "go test ./pkg/...", "go test ./pkg", "go test", "node --test a.test.mjs",
                        "python3 scripts/gates changed", "devenv-run vitest run src/a.test.ts", "pnpm build", "pnpm install",
                        "pnpm run build", "jj log", "echo pnpm test", "git commit -m 'make pnpm test pass'",
                        "systemd-run --user --scope -p MemoryMax=8G -- pnpm test", "vitest list", "cargo build"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])

    def test_wrappers_redirections_and_cd_are_read_through(self):
        for command in ("timeout 600 pnpm test", "env CI=1 pnpm test", "CI=1 pnpm test", "nice -n 5 pnpm test",
                        "devenv-run pnpm test", "nix develop -c pnpm test", "pnpm test 2>&1 | tail -40",
                        "pnpm test >/tmp/out 2>&1", "cd app && cd .. && pnpm test", "bash -c 'pnpm test'",
                        "sh -lc 'cd app; vitest run'", f"pnpm -C {self.pkg} test:workers", f"cd /nowhere; pnpm --dir {self.pkg} run test:workers"):
            with self.subTest(command=command):
                self.assertTrue(self.suites(command, cwd=self.pkg), command)

    def test_package_json_scripts_that_run_a_whole_suite_are_full(self):
        for command in ("pnpm test:workers", "pnpm run test:workers", "npm run test:workers", "yarn test:workers",
                        "bun run test:workers", "pnpm test:all", "pnpm check", "vp run test:workers"):
            with self.subTest(command=command):
                [(what, unclear)] = self.suites(command)
                self.assertFalse(unclear)
        for command in ("pnpm test:one", "npm run test:one", "pnpm build", "pnpm run build", "pnpm test:workers -- src/a.test.ts"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])
        self.assertIn("vitest run --project workers", self.suites("pnpm test:workers")[0][0])

    def test_an_unreadable_package_json_counts_a_test_named_script(self):
        (self.pkg / "package.json").write_text("{not json")
        self.assertTrue(self.suites("pnpm test:workers"))
        self.assertEqual(self.suites("pnpm build"), [])

    def test_a_runner_the_hook_cannot_read_is_unclear(self):
        (self.pkg / "ci.sh").write_text("#!/bin/sh\nset -e\npnpm test\n")
        (self.pkg / "lint.sh").write_text("#!/bin/sh\noxlint .\n")
        for command in ("eval 'pnpm test'", "x=$(vitest run)", "git diff --name-only | xargs vitest run", "./ci.sh",
                        "bash ci.sh", "source ci.sh", "unbalanced 'pytest"):
            with self.subTest(command=command):
                found = self.suites(command)
                self.assertTrue(found, command)
                self.assertTrue(all(unclear for _, unclear in found), found)
        self.assertEqual(self.suites("./lint.sh"), [])

    def shim(self, path, target):
        """A shell shim the way pnpm and nix write one: it names the package it runs, a test runner's name included."""
        shim = self.pkg / path
        shim.parent.mkdir(parents=True, exist_ok=True)
        shim.write_text(f'#!/bin/sh\nbasedir=$(dirname "$0")\n'
                        f'exec node "$basedir/../.pnpm/vite-plus@0.2.9_@vitest+browser@4.1.10/node_modules/{target}" "$@"\n')

    def test_a_runner_called_by_its_path_is_read_as_that_runner(self):
        self.shim("node_modules/.bin/vp", "vite-plus/bin/vp")
        self.shim("node_modules/.bin/vitest", "vitest/vitest.mjs")
        (self.pkg / ".venv" / "bin").mkdir(parents=True)
        (self.pkg / ".venv" / "pyvenv.cfg").write_text("home = /usr/bin\n")
        (self.pkg / ".venv" / "bin" / "pytest").write_text(
            '#! /nix/store/abc-bash-5.2/bin/bash -e\nexec -a "$0" "/nix/store/def-pytest/bin/.pytest-wrapped" "$@"\n')
        for command in ("node_modules/.bin/vp test --run --maxWorkers=8 src/mcp/identity.test.ts",
                        "./node_modules/.bin/vp test src/a.test.ts", "node_modules/.bin/vitest run src/a.test.ts",
                        "node_modules/.bin/vitest -t parses", ".venv/bin/pytest tests/test_a.py", ".venv/bin/pytest -k foo",
                        "node_modules/.bin/vp build"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])
        for command in ("node_modules/.bin/vp test --run", "node_modules/.bin/vitest run", ".venv/bin/pytest"):
            with self.subTest(command=command):
                found = self.suites(command)
                self.assertTrue(found, command)
                self.assertFalse(any(unclear for _, unclear in found), found)

    def test_a_script_by_its_path_that_runs_a_suite_is_still_unclear(self):
        for path, body in (("tools/check", "pnpm test"), ("go", "go test ./..."), ("scripts/gates", "pnpm test"),
                           ("bin/cargo", "cargo test"), ("bin/just", "just test"), ("tools/node", "node --test")):
            (self.pkg / path).parent.mkdir(parents=True, exist_ok=True)
            (self.pkg / path).write_text(f"#!/bin/sh\nset -e\n{body}\n")
        for command in ("tools/check", f"{self.pkg}/tools/check --fast", "./go test", "scripts/gates", "./bin/cargo",
                        "bin/just", "tools/node"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [(command, True)])

    # The worker's shots.sh (casos-work, 2026-10-20): one browser test file, through tasks/loopback, then copies its shots.
    SHOTS = ('round="$1"\nout=/tmp/pad/c65\nraw="$out/raw-$round"\nrm -rf "$raw"; mkdir -p "$raw"\ncd app || exit 1\n'
             'BROWSER_SHOTS="$raw" CR_BROWSER=1 ../../tasks/loopback node_modules/.bin/vp test --run --maxWorkers=2 '
             '--project=browser src/actions/pendencias.browser.test.tsx > "$out/test-$round.log" 2>&1\ncode=$?\n'
             'for w in 1440 390; do\n  a=$(find "$raw" -name "*approver-at-$w--light-*-1.png" | head -1)\n'
             '  [ -n "$a" ] && cp "$a" "$out/$round-$w.png" && echo "$round-$w.png <- $(basename "$a")"\ndone\n'
             'tail -6 "$out/test-$round.log"\necho "exit $code"\n')

    def test_a_script_whose_runners_each_name_their_files_is_no_suite(self):
        for command in self.scripts({
                "shots.sh": self.SHOTS,
                "two.sh": "vp test src/a.test.ts && pnpm test -- src/b.test.ts\n",
                "filtered.sh": "pytest tests/test_a.py -k b\nvitest run -t 'parses a line'\ncargo test parse\n",
                "continued.sh": "vp test --run \\\n  src/a.test.ts 2>&1 | tail -5\n",
                "string.sh": "watch 'vp test src/a.test.ts'\n"}):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])
        for command in ("./t/shots.sh after; cd app; CR_BROWSER=1 ../../tasks/loopback node_modules/.bin/vp test --run "
                        "--maxWorkers=2 --project=browser src/kit/uploads.browser.test.tsx 2>&1 | tail -5; "
                        "node_modules/.bin/vp check src/a.tsx 2>&1 | tail -5",
                        "bash -c './t/shots.sh after; vp test --run --project=browser src/kit/uploads.browser.test.tsx; "
                        "vp check src/a.tsx'", "source t/shots.sh after", f"{self.pkg}/t/shots.sh before"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])

    def test_a_script_runner_read_to_its_command_end_still_finds_the_whole_suite(self):
        for command in self.scripts({
                "redirected.sh": "vp test --run --project=browser 2>&1 | tail -5\n",
                "continued.sh": "vp test \\\n  --run\n",
                "logged.sh": 'vp test --run > "$out/log" 2>&1\n',
                "after_one.sh": "vp test src/a.test.ts; pnpm test\n",
                "commented.sh": "vp test # src/a.test.ts\n",
                "then.sh": "vp test; cp x src/a.test.ts\n",
                "piped.sh": "vp test | tee src/x.log\n",
                "subshell.sh": "(vp test) && ls src/\n",
                "background.sh": "vp test & echo src/a.test.ts\n",
                # A stray quote in a `<<\\EOF` body misleads each reading that leaves comments out: the `#` still ends it.
                "commented_after_heredoc.sh": "cat <<\\EOF\nit's\nEOF\nvp test # src/a.test.ts\n"}):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [(command, True)])

    def test_a_script_runner_whose_words_the_hook_cannot_read_is_one_it_cannot_tell(self):
        for command in self.scripts({"var.sh": "vp test $files\n", "arg.sh": 'cd app\nvp test --run "$1"\n',
                                     "escaped.sh": "vp test src/a\\ b.test.ts\n"}):
            with self.subTest(command=command):
                found = self.mod.SuiteReader().suites(command, str(self.pkg))
                self.assertEqual([(s.what, s.unclear, s.unsure) for s in found], [(command, True, True)])
        for command in ("source t/var.sh", ". t/arg.sh"):
            with self.subTest(command=command):
                found = self.mod.SuiteReader().suites(command, str(self.pkg))
                self.assertEqual([(s.what, s.unclear, s.unsure) for s in found], [(command, True, True)])
        found = self.mod.SuiteReader().suites("vp test 'src/a.test.ts", str(self.pkg))
        self.assertEqual([(s.unclear, s.unsure) for s in found], [(True, True)])
        list(self.scripts({"whole.sh": "vp test $files\npnpm test\n"}))
        self.assertEqual([s.unsure for s in self.mod.SuiteReader().suites("./t/whole.sh", str(self.pkg))], [False])

    # The review's probes (2026-10-20): each runs every test file, typed or in a script, and was read as naming some.
    WHOLE_BY_ITS_WORDS = ("pytest --cov src", "pytest --cov -n 4", "pytest .", "py.test ./", "vp test .",
                          "vitest run ./", "bun test .", "find src -name '*.test.ts' -exec vp test {} +",
                          "find . -name 'test_*.py' -exec pytest {} +")

    def test_a_coverage_source_a_dot_or_the_files_find_hands_over_name_no_test(self):
        for command in self.WHOLE_BY_ITS_WORDS:
            with self.subTest(command=command):
                found = self.suites(command)
                self.assertTrue(found, command)
                self.assertFalse(any(unclear for _, unclear in found), found)
        for command in self.scripts({f"whole{i}.sh": f"{c}\n" for i, c in enumerate(self.WHOLE_BY_ITS_WORDS)}):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [(command, True)])
        for command in ("pytest --cov src tests/test_a.py", "pytest --cov=src tests/", "pytest --cov -k parses",
                        "vp test ./src/a.test.ts", "find src -name '*.ts' -exec vp check {} +",
                        "find src -name 'a.test.ts' -exec vp test {} -t parses +", "find src -name '*.test.ts'"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])

    def test_a_launcher_is_read_for_the_command_it_is_given_not_for_its_comments(self):
        (self.pkg / "tasks").mkdir()
        (self.pkg / "tasks" / "loopback").write_text(
            '#!/usr/bin/env bash\n# Run a command with loopback as its only network: `tasks/loopback <command>`.\n'
            '# What a browser tier starts through (apps/casos: `pnpm test:browser`).\nset -euo pipefail\n'
            '[ $# -eq 0 ] && { echo "usage: tasks/loopback <command> [args...]" >&2; exit 2; }\n'
            'exec unshare --net --map-current-user sh -c \'ip link set lo up && exec "$@"\' sh "$@"\n')
        for command in ("tasks/loopback ip -brief address", "bash -n tasks/loopback", "sh -n ./tasks/loopback",
                        "tasks/loopback vp test src/a.test.ts", "tasks/loopback pnpm test -t parses"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])
        for command in ("tasks/loopback vp test", "tasks/loopback pnpm test", "./tasks/loopback env CI=1 vitest run"):
            with self.subTest(command=command):
                found = self.suites(command)
                self.assertTrue(found, command)
                self.assertFalse(any(unclear for _, unclear in found), found)

    def test_only_a_shell_whose_n_is_noexec_runs_nothing_under_it(self):
        (self.pkg / "ci.sh").write_text("#!/bin/sh\nvp test\n")
        for command in ("bash -n ci.sh", "sh -n ci.sh", "zsh -n ci.sh", "dash -n ci.sh", "ksh -n ci.sh", "fish -n ci.sh",
                        "fish --no-execute ci.sh"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])
        for command in ("nu -n -c 'vp test'", "nu -n -c 'pnpm test'", "nu -n ci.sh", "nu --no-config-file ci.sh",
                        "nu --commands 'vp test'", "nu -n --commands 'pnpm test'", "fish --command 'vp test'",
                        "fish --command='vp test'"):
            with self.subTest(command=command):
                self.assertTrue(self.suites(command), command)

    def test_a_hash_line_inside_a_quote_is_code_not_a_comment(self):
        (self.pkg / "tasks").mkdir()
        (self.pkg / "tasks" / "split").write_text("#!/bin/sh\nx='\n#'; vp test\n")
        (self.pkg / "tasks" / "dq").write_text('#!/bin/sh\nx="a\n# b"; pnpm test\n')
        (self.pkg / "tasks" / "launch").write_text(
            "#!/bin/sh\n# it's a launcher: `tasks/launch vp test` runs the suite\nexec \"$@\" # don't wrap it\n")
        for command in ("tasks/split", "tasks/dq"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [(command, True)])
        self.assertEqual(self.suites("tasks/launch ip -brief address"), [])
        self.assertEqual(self.suites("tasks/launch vp test"), [("tasks/launch vp test", False)])

    def test_a_quote_in_a_heredoc_body_or_a_joined_line_hides_no_suite(self):
        (self.pkg / "t").mkdir()
        scripts = {"hd_apos": "#!/bin/sh\ncat <<EOF\nDon't run this by hand.\nEOF\nsed 's/ #.*//' list.txt && pnpm test\n",
                   "hd_apos_echo": "#!/bin/sh\ncat <<'EOF'\nit's here\nEOF\necho 'x #'; vp test\n",
                   "hd_dq": '#!/bin/sh\ncat <<EOF\nsay "hi\nEOF\necho "a #"; vp test\n',
                   "joined": "#!/bin/sh\necho a\\\n#; vp test\n"}
        for name, body in scripts.items():
            (self.pkg / "t" / name).write_text(body)
            with self.subTest(command=f"t/{name}"):
                self.assertEqual(self.suites(f"t/{name}"), [(f"t/{name}", True)])

    def test_a_flipped_quote_state_does_not_hide_a_hash_line_inside_a_later_quote(self):
        (self.pkg / "t").mkdir()
        scripts = {"hd_then_quote": "#!/bin/sh\ncat <<EOF\nDon't run this by hand.\nEOF\nx='a\n#'; vp test\n",
                   "hd_dash_then_dq": '#!/bin/sh\ncat <<-"EOF"\n\tsay "hi\n\tEOF\nx="a\n#"; pnpm test\n',
                   "nested_dq": "#!/bin/sh\nx=\"$(echo \"it's\")\"\ny='a\n#'; vp test\n",
                   "dash_tab_only": "#!/bin/sh\ncat <<-EOF\n\t'\n  EOF\n\t'\nEOF\nx='a\n#'; vp test\n",
                   "arith_shift": "#!/bin/sh\nn=$((1<<x))\ns='\nx\n#'; vp test\n",
                   "dash_tab_strip": "#!/bin/sh\ncat <<-EOF\n  EOF\n'\nEOF\nx='a\n#'; vp test\n",
                   "arith_shift_after_nested": "#!/bin/sh\ny=\"$(echo \"it's\")\"\nn=$((1<<x))\ns='\nx\n#'; vp test\n",
                   "nested_dq_dq": '#!/bin/sh\nx="$(echo "it\'s")"\ny="a\n#"; pnpm test\n'}
        for name, body in scripts.items():
            (self.pkg / "t" / name).write_text(body)
            with self.subTest(command=f"t/{name}"):
                self.assertEqual(self.suites(f"t/{name}"), [(f"t/{name}", True)])
        (self.pkg / "t" / "hd_body").write_text("#!/bin/sh\nsh <<EOF\nit's\nx='\n#'; vp test\nEOF\n")
        self.assertEqual(self.suites("t/hd_body"), [("t/hd_body", True)])

    def scripts(self, scripts):
        """Writes each script under t/ and yields the two ways to run it, by a shell and by its path."""
        (self.pkg / "t").mkdir(exist_ok=True)
        for name, body in scripts.items():
            (self.pkg / "t" / name).write_text("#!/bin/sh\nset -e\n" + body)
            yield from (f"bash t/{name}", f"./t/{name}")

    def test_a_suite_named_only_in_what_a_script_echoes_or_comments_is_none(self):
        for command in self.scripts({
                "deploy.sh": '[ -f .tested ] || { echo "run pnpm test:postgres first" >&2; exit 1; }\nwrangler deploy\n',
                "printf.sh": "printf 'refused: run pnpm test before a deploy\\n' 1>&2\nexit 1\n",
                "stderr_first.sh": ">&2 echo 'run vitest run first' && exit 1\n",
                "comment.sh": "# then run pnpm test\nwrangler deploy\n",
                "devnull.sh": "rm -f .tested 2>/dev/null\necho 'run pnpm test first' >&2\n"}):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])

    def test_a_script_that_runs_a_suite_stays_one_wherever_the_command_sits(self):
        for command in self.scripts({
                "bare.sh": "pnpm test\n",
                "if.sh": "if pnpm test; then echo ok; fi\n",
                "and.sh": "pnpm build && pnpm test\n",
                "subst.sh": "out=$(pnpm test)\n",
                "subst_in_echo.sh": 'echo "result: $(pnpm test 2>&1)"\n',
                "backtick_in_echo.sh": 'echo "result: `pnpm test`"\n',
                "echo_to_sh.sh": "echo 'pnpm test' | sh\n",
                "printf_to_bash.sh": "printf 'pnpm test\\n' | bash\n",
                "echo_to_file.sh": "echo 'pnpm test' > x.sh\nsh x.sh\n",
                "eval_echo.sh": "eval \"$(echo 'pnpm test')\"\n",
                "echo_in_c.sh": "bash -c \"echo start; pnpm test\"\n",
                "printf_v.sh": "printf -v c 'pnpm test'\n$c\n",
                "echo_to_fd3.sh": "exec 3> >(sh)\necho 'pnpm test' >&3\n",
                "stdout_echo.sh": "echo 'run pnpm test first'\n",
                "fn_pipe.sh": "gen() { echo 'pnpm test'; }\ngen | sh\n",
                "fn_pipe_amp.sh": "gen() { echo 'pnpm test' >&2; }\ngen |& sh\n",
                "fn_procsub.sh": "gen() { echo 'pnpm test'; }\nsh <(gen)\n",
                "fn_source.sh": "gen() { echo 'pnpm test'; }\nsource <(gen)\n",
                "group_pipe.sh": "{ echo 'pnpm test'; } | sh\n",
                "group_file.sh": "{ echo 'pnpm test'; } > run.sh\nsh run.sh\n",
                "if_pipe.sh": "if true; then\n  echo 'pnpm test'\nfi | sh\n",
                "subshell_pipe.sh": "(\n  echo 'pnpm test'\n) | sh\n",
                "for_parallel.sh": "for p in a b; do echo \"pnpm test --filter $p\"; done | parallel\n",
                "for_xargs.sh": "for p in a b; do echo \"pnpm test --filter $p\"; done | xargs -P2 -I{} sh -c '{}'\n",
                "while_sh.sh": "while read -r p; do echo \"cargo test -p $p\"; done < crates.txt | sh\n",
                "subst_lines.sh": "x=$(\necho 'pnpm test'\n)\n$x\n",
                "eval_subst_lines.sh": "eval \"$(\necho 'pnpm test'\n)\"\n",
                "exec_file.sh": "exec > run.sh\necho 'pnpm test'\nsh run.sh\n",
                "stderr_group.sh": "{ echo 'pnpm test' >&2; } 2>&1 | sh\n",
                "stderr_fn_file.sh": "gen() { echo 'pnpm test' >&2; }\ngen 2> run.sh\nsh run.sh\n",
                "stderr_loop_file.sh": "for p in a; do echo \"pnpm test --filter $p\" >&2; done 2>run.sh\nsh run.sh\n",
                "stderr_both_file.sh": "{ echo 'pnpm test' >&2; } &> run.sh\nsh run.sh\n"}):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [(command, True)])

    def test_a_suite_in_a_string_or_here_document_that_something_runs_is_still_one(self):
        for command in self.scripts({
                "cmd_var.sh": 'cmd="pnpm test"\n$cmd\n',
                "eval_var.sh": "x='pnpm test'\neval \"$x\"\n",
                "watch.sh": 'watch "pnpm test"\n',
                "watchexec.sh": "watchexec -- 'pnpm test'\n",
                "nodemon.sh": "nodemon -x 'pnpm test'\n",
                "nix_shell.sh": "nix-shell --run 'pnpm test'\n",
                "devenv.sh": "devenv shell 'pnpm test'\n",
                "tmux.sh": "tmux new-session -d 'pnpm test'\n",
                "concurrently.sh": "concurrently 'pnpm build' 'pnpm test'\n",
                "parallel.sh": "parallel ::: 'pnpm test'\n",
                "herestring.sh": "bash <<< 'pnpm test'\n",
                "procsub.sh": "bash <(echo 'pnpm test')\n",
                "eval_dashes.sh": "eval -- 'pnpm test'\n",
                "trap.sh": "trap -- 'pnpm test' EXIT\n",
                "c_newline.sh": "bash -c \\\n'pnpm test'\n",
                "concatenated.sh": "sh -c 'cd app'\" && pnpm test\"\n",
                "bash_hd.sh": "bash <<EOF\npnpm test\nEOF\n",
                "sh_s_hd.sh": "sh -s <<'EOF'\ncd app\nvitest run\nEOF\n",
                "cat_pipe_sh.sh": "cat <<EOF | sh\npnpm test\nEOF\n",
                "write_then_run.sh": "cat > x.sh <<EOF\npnpm test\nEOF\nsh x.sh\n",
                "tee_then_run.sh": "tee x.sh >/dev/null <<'EOF'\npnpm test\nEOF\nchmod +x x.sh && ./x.sh\n",
                "read_then_eval.sh": "read -r -d '' c <<EOF || true\npnpm test\nEOF\neval \"$c\"\n",
                "eval_cat_hd.sh": 'eval "$(cat <<EOF\npnpm test\nEOF\n)"\n',
                "spaced_delim.sh": "cat << \"E F\"\nit's\nE F\npnpm test\necho 'done now'\n"}):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [(command, True)])

    # A deploy script's shape (P138): a hint echoed to stderr inside a loop, real stderr redirects on other lines that
    # take only an outside command's stderr, and comments naming `<sha12>`.
    DEPLOY_HEAD = ("# worker-deploy.<sha12>.sh   the deploy, from its read-only copy\n"
                   "redact() { sed -u -E 's#postgres://[^ ]*#postgres://REDACTED#g'; } # the filter\n"
                   "on_db() { DEPLOY_ATLAS_URL=\"$atlas_url\" \"$@\"; }\n"
                   "for tier in postgres graph; do\n"
                   "  test \"$(cat \".$tier-tier-passed\" 2>/dev/null)\" = \"$PIN\" || { echo \"refused: the $tier tier's "
                   "stamp is not $PIN. Run pnpm test:$tier at $PIN first\" >&2; exit 2; }\n"
                   "done\n"
                   "lt=\"$(psql -X -At \"${plain}&${LOCK}\" -c \"SHOW lock_timeout\" 2> \"$work/psql.err\")\" || {\n"
                   "  redact < \"$work/psql.err\" >&2; exit 2; }\n"
                   "if ! atlas migrate lint --dir \"$dir\" --latest \"${#pending[@]}\" 2>&1 | redact; then\n"
                   "  exit 1\n"
                   "fi\n"
                   "on_db atlas migrate apply --tx-mode file 1 > \"$log\" 2>&1 || rc=$?\n")

    def test_a_hint_echoed_to_stderr_names_no_suite_whatever_outside_commands_redirect(self):
        for command in self.scripts({
                "deploy.sh": self.DEPLOY_HEAD + "wrangler deploy\n",
                "sha12_comment.sh": "# install -m 0444 worker-deploy.sh worker-deploy.<sha12>.sh\n"
                                    "echo 'refused: run pnpm test first' >&2\nexit 2\n"}):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])

    def test_a_deploy_script_that_runs_or_hands_on_a_suite_stays_one(self):
        for command in self.scripts({
                "real.sh": self.DEPLOY_HEAD + "pnpm test\n",
                "real_tier.sh": self.DEPLOY_HEAD + "pnpm test:e2e\n",
                "echo_to_sh.sh": self.DEPLOY_HEAD + 'echo "pnpm test" | sh\n',
                "eval.sh": self.DEPLOY_HEAD + 'eval "pnpm test"\n',
                "subst_cmd.sh": self.DEPLOY_HEAD + "$(echo pnpm test)\n",
                "group_lines.sh": self.DEPLOY_HEAD + "{\n  echo 'pnpm test' >&2\n} 2>&1 | sh\n",
                "loop_lines.sh": self.DEPLOY_HEAD + "for p in a; do\n  echo \"pnpm test --filter $p\" >&2\ndone 2> run.sh\nsh run.sh\n",
                "fn_wrapped.sh": self.DEPLOY_HEAD + "hint() { echo 'pnpm test' >&2; }\nwarn() { hint; }\nwarn 2> run.sh\nsh run.sh\n",
                "fn_lines.sh": self.DEPLOY_HEAD + "hint() {\n  echo 'pnpm test' >&2\n}\nhint 2>&1 | sh\n",
                "exec_later.sh": self.DEPLOY_HEAD + "exec 2> run.sh\necho 'pnpm test' >&2\nsh run.sh\n",
                "shell_hd.sh": self.DEPLOY_HEAD + "bash 2>&1 <<EOF | sh\necho 'pnpm test' >&2\nEOF\n",
                "string_lines.sh": self.DEPLOY_HEAD + "x -c \"\necho 'pnpm test' >&2;\n\" 2>&1 | parallel\n",
                "continued.sh": self.DEPLOY_HEAD + "{ echo 'pnpm test' >&2; } \\\n  2> run.sh\nsh run.sh\n",
                "fn_var.sh": "hint() {\n  echo 'pnpm test' >&2\n}\nfn=hint\n$fn 2>&1 | xargs env\n",
                "fn_wrapper_args.sh": "hint() { echo 'pnpm test' >&2; }\nrun() {\n  \"$@\" 2>&1 | xargs env\n}\nrun hint\n",
                "fn_var_procsub.sh": "hint() {\n  echo 'pnpm test' >&2\n}\nf=hint\n\"$f\" 2> >(xargs env)\n",
                "fn_allman.sh": "hint()\n{\n  echo 'pnpm test' >&2\n}\nhint 2>&1 | parallel\n",
                "fn_paren_line.sh": "hint() {\nargs=(\n-x\n)\necho 'pnpm test' >&2\n}\nhint 2>&1 | parallel\n",
                "lt_dup.sh": "{\n  echo 'pnpm test' >&2\n} 2<&1 | sh\n",
                "read_write.sh": "{\n  echo 'pnpm test' >&2\n} 2<> run.sh\nsh run.sh\n",
                "lt_dup_spaced.sh": "{\n  echo 'pnpm test' >&2\n} 2<& 1 | sh\n",
                "lt_dup_var.sh": "fd=1\n{\n  echo 'pnpm test' >&2\n} 2<&$fd | sh\n"}):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [(command, True)])

    def test_a_hint_echoed_to_stderr_counts_when_the_command_running_the_script_moves_stderr(self):
        list(self.scripts({"hint.sh": "echo 'run pnpm test first' >&2\n"}))
        for command in ("bash t/hint.sh 2>&1 | sh", "./t/hint.sh 2>&1 | xargs env", "bash t/hint.sh 2> run.sh; bash run.sh",
                        "./t/hint.sh 2> run.sh && ./run.sh", 'bash t/hint.sh 2>&1 | "$SHELL"'):
            with self.subTest(command=command):
                self.assertNotEqual(self.suites(command), [])

    def test_a_hint_echoed_to_stderr_counts_when_anything_but_a_sink_shares_the_command_that_moves_its_stderr(self):
        list(self.scripts({"hint.sh": "echo 'run pnpm test first' >&2\n"}))
        for command in ("bash t/hint.sh 2>&1 | sh -s t/hint.sh", "bash t/hint.sh 2>&1 | bash /dev/stdin t/hint.sh",
                        'bash t/hint.sh 2>&1 | sh "t/hint.sh"', "bash t/hint.sh 2>&1 | sudo -u luiz sh",
                        "bash t/hint.sh 2>&1 | doas -u luiz sh", "bash t/hint.sh 2>&1 | env -u HOME sh",
                        "bash t/hint.sh 2>&1 | timeout -s KILL 30 sh", "bash t/hint.sh 2>&1 | stdbuf -o L sh",
                        "bash t/hint.sh 2>&1 | busybox sh", "bash t/hint.sh 2>&1 | parallel",
                        "bash t/hint.sh 2>&1 | python3 -c 'import os,sys; os.system(sys.stdin.read())'",
                        "bash t/hint.sh 2>&1 | ssh localhost", "bash t/hint.sh 2> h.txt; parallel < h.txt",
                        'bash t/hint.sh 2>&1 | tr \\" q | sh | tr q "x"', "bash t/hint.sh 2>> t/hint.sh",
                        "bash t/hint.sh 2>&1 | tee t/hint.sh", "bash t/hint.sh 2> h.txt; rg --pre sh x h.txt",
                        "bash t/hint.sh 2>&1 | sort --compress-program=sh",
                        'bash t/hint.sh 2>&1 | grep -v \\" >> t/hint.sh; grep -v \\" log',
                        'bash t/hint.sh 2>> "t/hint".sh', 'bash t/hint.sh 2>&1 | tee -a "t/hi"nt.sh',
                        "bash t/hint.sh 2<&1 | sh", "bash t/hint.sh 2<> run.sh; sh run.sh", "bash t/hint.sh 2<> t/hint.sh",
                        "bash t/hint.sh 2<& 1 | sh", 'bash t/hint.sh 2<&"1" | sh', "bash t/hint.sh 2<&\\1 | sh",
                        "fd=1; bash t/hint.sh 2<&$fd | sh", "bash t/hint.sh 2>> t/hi\\nt.sh",
                        "bash t/hint.sh 2>&1 | tee -a t/hi\\nt.sh", 'bash t/hint.sh 2>&1 | t"ee" -a "t/hi"nt.sh',
                        'bash "t/hi"nt.sh 2>> t/hint.sh', "bash t/hi\\nt.sh 2>> t/hint.sh",
                        'x="$(bash t/hint.sh 2>&1)"; $x',
                        "./t/hint.sh 2>&1 | sh", "{ bash t/hint.sh; } 2>&1 | sh", "(bash t/hint.sh) 2>&1 | sh",
                        "bash t/hint.sh 2> >(sh)", "bash t/hint.sh |& sh", "bash t/hint.sh 2>&1 | tee >(sh)"):
            with self.subTest(command=command):
                self.assertNotEqual(self.suites(command), [])

    def test_a_hint_echoed_to_stderr_names_no_suite_when_the_command_running_the_script_only_reads_its_stderr(self):
        list(self.scripts({"hint.sh": "echo 'run pnpm test first' >&2\n"}))
        for command in ("bash t/hint.sh 2>&1 | tail -5", "bash t/hint.sh > log 2>&1", "./t/hint.sh 2>&1 | grep -v x",
                        "bash t/hint.sh 2>&1 | tee log", "bash t/hint.sh 2>&1 | sort | uniq -c | head -3 > counts.txt",
                        "cat notes.txt | bash t/hint.sh 2>&1 | tail -5"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])

    def test_a_script_of_many_stderr_moves_is_read_in_well_under_the_hook_timeout(self):
        body = "".join(f'psql -c "select {i}" 2> "$work/e{i}"\n' for i in range(4000))
        list(self.scripts({"many.sh": body + "echo 'run pnpm test first' >&2\n"}))
        started = time.monotonic()
        self.assertEqual(self.suites("bash t/many.sh"), [])
        self.assertLess(time.monotonic() - started, 1)

    def test_a_launcher_keeps_what_the_hook_could_not_tell_of_its_command(self):
        (self.pkg / "tasks").mkdir()
        (self.pkg / "tasks" / "launch").write_text('#!/bin/sh\nexec "$@"\n')
        (self.pkg / "tools").mkdir()
        (self.pkg / "tools" / "check").write_text("#!/bin/sh\npnpm test\n")
        for command in ("tasks/launch tools/check", "tasks/launch eval vp test"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [(command, True)])

    def test_vp_exec_is_read_through_to_the_command_it_runs(self):
        for command in ("vp exec vitest run", "vp exec -F api vitest", "vp exec --filter=api pytest", "vp exec -r vitest"):
            with self.subTest(command=command):
                found = self.suites(command)
                self.assertTrue(found, command)
                self.assertFalse(any(unclear for _, unclear in found), found)
        for command in ("vp exec vitest run src/a.test.ts", "vp exec -F api vitest -t parses", "vp exec tsc -b", "vp exec"):
            with self.subTest(command=command):
                self.assertEqual(self.suites(command), [])
        self.assertTrue(self.suites("vp exec -c 'pnpm test'"))

    def test_runners_names_every_command_the_reader_reads_by_name(self):
        import ast
        tree = ast.parse(SOURCE.read_text())
        reader = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "SuiteReader")
        command = next(n for n in reader.body if isinstance(n, ast.FunctionDef) and n.name == "command")
        names = set()
        for node in ast.walk(command):
            if isinstance(node, ast.Compare) and isinstance(node.left, ast.Name) and node.left.id == "name":
                for right in node.comparators:
                    values = right.elts if isinstance(right, (ast.Tuple, ast.Set, ast.List)) else [right]
                    names |= {v.value for v in values if isinstance(v, ast.Constant) and isinstance(v.value, str)}
        self.assertTrue({"vp", "pytest", "pnpm", "go"} <= names, names)
        self.assertEqual(self.mod.RUNNERS, names)


class SuiteGateTest(FleetCase):
    """suite_gate (PreToolUse, Bash): in a managed fleet's session a full suite runs through the gate slot (`fleet fleets
    gate run`): the call is denied with the command to run, never allowed or rewritten, so the permission check
    reviews the command Claude issues next. Outside a managed fleet, nothing changes but a hint on stderr."""

    def setUp(self):
        super().setUp()
        (self.repo / "package.json").write_text(json.dumps({"scripts": {"test:workers": "vitest run --project workers"}}))

    def manager(self):
        d = self.tmp / "manager"
        d.mkdir(exist_ok=True)
        (d / "state.json").write_text(json.dumps({"project": "manager", "role": "manager"}))
        (self.registry / "manager.json").write_text(json.dumps({
            "id": "manager", "role": "manager", "dir": str(d), "url": "http://127.0.0.1:7420/f/manager/",
            "pid": os.getpid(), "session": None, "since": "2026-01-05T07:00:00+00:00"}))

    def run_bash(self, command, env=None, **more):
        payload = {**self.payload("PreToolUse"), "tool_name": "Bash",
                   "tool_input": {"command": command, "description": "tests", **more}}
        r = self.hook("PreToolUse", payload, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def decision(self, r):
        self.assertTrue(r.stdout, f"no decision; stderr: {r.stderr}; log: {self.log()}")
        return json.loads(r.stdout)["hookSpecificOutput"]

    def gate_run(self, inner):
        return f"{self.fleet_cli} fleets gate run --as p --wait 1800 -- {inner}"

    def test_a_full_suite_is_denied_with_the_gate_run_to_issue(self):
        self.manager()
        for command, inner in (("pnpm test", "pnpm test"), ("pnpm test:workers", "pnpm test:workers"),
                               ("just test --jobs 2", "just test --jobs 2"),
                               ("pnpm test 2>&1 | tail -40", "bash -c 'pnpm test 2>&1 | tail -40'"),
                               ("cd app && vitest run", "bash -c 'cd app && vitest run'"),
                               ("CI=1 pnpm test", "bash -c 'CI=1 pnpm test'"),
                               ("pnpm test; rm -rf dist", "bash -c 'pnpm test; rm -rf dist'"),
                               ("pnpm test # ; rm -rf ~", "bash -c 'pnpm test # ; rm -rf ~'")):
            with self.subTest(command=command):
                d = self.decision(self.run_bash(command))
                self.assertEqual(d["permissionDecision"], "deny")
                self.assertNotIn("updatedInput", d)
                self.assertIn(f"Run it as: `{self.gate_run(inner)}`", d["permissionDecisionReason"])
                self.assertIn("in fleet p (this machine serves a manager) a full suite runs only through the gate slot",
                              d["permissionDecisionReason"])
                self.assertIn("except 75: the slot stayed held past --wait and the suite never ran; 124: the suite ran "
                              "past its time and was stopped", d["permissionDecisionReason"])

    def test_the_deny_names_the_review_check_a_landing_puts_in_front_and_runs_the_gate_alone(self):
        # Land step 5 runs `land-check --pre-gate -b B && fleet fleets gate run ...`. The hook can't tell a landing's
        # gate from any other full suite, and --pre-gate exits 1 on a stack with nothing to push, so the command to
        # issue stays the gate run alone and the chained one is named for a landing; that one passes untouched.
        self.manager()
        land_check = f"{ROOT}/bin/land-check"
        for command in ("just test", "pnpm test"):
            with self.subTest(command=command):
                reason = self.decision(self.run_bash(command))["permissionDecisionReason"]
                self.assertIn(f"Run it as: `{self.gate_run(command)}`", reason)
                self.assertIn(f"When this is a landing's full gate (Land step 5), put the review check in front of it: "
                              f"`{land_check} --pre-gate -b <bookmark> && {self.gate_run(command)}`, so a stack that "
                              f"needs a review the ledger does not record stops before the gate takes the slot. ",
                              reason)
                self.assertEqual(self.run_bash(f"{land_check} --pre-gate -b master && {self.gate_run(command)}").stdout,
                                 "")

    def test_a_line_the_hook_cannot_read_says_so(self):
        self.manager()
        for command in ("for i in 1 2; do pnpm test; done", "eval 'pnpm test'", "ls | xargs vitest run"):
            with self.subTest(command=command):
                d = self.decision(self.run_bash(command))
                self.assertEqual(d["permissionDecision"], "deny")
                self.assertIn("couldn't tell all that this line runs around the test runner", d["permissionDecisionReason"])
                self.assertIn(f"Run it as: `{self.gate_run('bash -c ' + shlex.quote(command))}`", d["permissionDecisionReason"])

    def test_a_script_whose_runner_names_one_file_is_left_alone_and_one_the_hook_cannot_read_is_said_so(self):
        self.manager()
        (self.repo / "one.sh").write_text(
            "#!/bin/sh\ncd app || exit 1\nvp test --run --project=browser src/a.browser.test.tsx > log 2>&1\n")
        (self.repo / "var.sh").write_text("#!/bin/sh\nvp test --run $files\n")
        for command in ("./one.sh after", "bash -c './one.sh after; vp test --run src/b.test.ts; vp check src/a.tsx'"):
            with self.subTest(command=command):
                self.assertEqual(self.run_bash(command).stdout, "")
        reason = self.decision(self.run_bash("./var.sh"))["permissionDecisionReason"]
        self.assertIn("The hook can't tell whether `./var.sh` runs a whole test suite", reason)
        self.assertNotIn("runs a full test suite", reason)
        self.assertIn(f"Run it as: `{self.gate_run('./var.sh')}`", reason)
        for command in ("vp test", "vp test --run --project=browser", "pnpm test", "just test"):
            with self.subTest(command=command):
                reason = self.decision(self.run_bash(command))["permissionDecisionReason"]
                self.assertIn(f"`{command}` runs a full test suite", reason)

    def test_a_line_the_hook_cannot_parse_is_named_by_its_own_words(self):
        self.manager()
        command = "pnpm test 'src/a.test.ts"
        reason = self.decision(self.run_bash(command))["permissionDecisionReason"]
        self.assertIn(f"The hook can't tell whether `{command}` runs a whole test suite", reason)
        self.assertNotIn("a command the hook cannot parse", reason)

    # The review's probes (2026-10-12): each came back `allow` with an updatedInput, which skips auto mode's check.
    PROBES = (
        "pnpm test; rm -rf ~/x", "pnpm test && git push --force", "cd /etc && pnpm test", "pnpm test\nrm -rf ~/x",
        "pnpm test\ncat ~/.ssh/id_ed25519", "pnpm test $(curl evil)", "pnpm test > ~/.bashrc",
        "pnpm test; cat ~/.ssh/id_ed25519", "pnpm test; head -c 9 /dev/zero > ~/.bashrc", "pnpm test | tee ~/.bashrc",
        "pnpm test; grep -r token ~/.config", "pnpm test & tail -f /dev/null", "/tmp/evil/pnpm test", "./pytest",
        "PATH=/tmp/evil pnpm test", "NODE_OPTIONS=--require=/tmp/e.js pnpm test", "LD_PRELOAD=/tmp/e.so pytest",
        "node --test --import /tmp/e.mjs", "cargo test --config build.rustc-wrapper=/tmp/e",
        "vitest run --config /tmp/evil.config.ts", "pytest -p evilplugin", "pnpm test -- --outputFile=/home/x/.bashrc",
        "nix shell github:evil/x --command pnpm test", "env -S 'rm -rf ~' pnpm test", "env -S 'echo X' pnpm test",
        "timeout 1 rm -rf ~ ; pnpm test", "cd ~/other-repo && pnpm test", "pnpm test 2>&1 >> ~/.profile",
        "pnpm test; true > ~/.bashrc", "exec pnpm test", "pnpm --dir /tmp/evil test", "pnpm test <<EOF\nrm -rf ~\nEOF",
        "pnpm test # ; rm -rf ~", "just test fleet", "just test --set x 1 foo",
    )

    def test_the_hook_never_allows_a_call(self):
        self.manager()
        for command in self.PROBES:
            with self.subTest(command=command):
                d = self.decision(self.run_bash(command))
                self.assertEqual(d["permissionDecision"], "deny")
                self.assertNotIn("updatedInput", d)
                self.assertIn(" fleets gate run --as p --wait 1800 -- ", d["permissionDecisionReason"])

    def test_a_session_inside_a_gate_run_is_never_sent_to_the_gate_again(self):
        self.manager()
        for command in ("just test", "pnpm test:workers", "bash -c 'pnpm test'"):
            with self.subTest(command=command):
                r = self.run_bash(command, env={"FLEET_GATE_RUN": "fleet-gate-0a1b2c3d-4242"})
                self.assertEqual(r.stdout.strip(), "", r.stdout)

    def test_scoped_probes_pass_untouched(self):
        self.manager()
        for command in ("vitest -t foo", "vitest run -t 'a b'", "pytest -k foo", "pytest --lf", "cargo test foo",
                        "go test -run TestX ./...", "pnpm test -t parses", "npm test -- -t foo", "just test-changed",
                        "cargo nextest run -E 'test(foo)'", "grep -r 'pnpm test' .", "echo pnpm test"):
            with self.subTest(command=command):
                self.assertEqual(self.run_bash(command).stdout, "")

    def test_the_slot_s_holder_is_named_when_it_is_held(self):
        self.manager()
        (self.registry / "gate").mkdir()
        (self.registry / "gate" / "gate.json").write_text(json.dumps({
            "fleet": "infra", "kind": "fleet", "what": "browser suite", "since": "2026-01-05T08:00:00+00:00",
            "until": "2999-01-01T00:00:00+00:00", "token": "abcd1234"}))
        d = self.decision(self.run_bash("pnpm test"))
        self.assertIn("The slot is held now (infra: browser suite), so it waits for it (up to 30 min)", d["permissionDecisionReason"])

    def test_a_hold_its_own_fleet_took_by_hand_is_named_with_the_free_the_run_waits_on(self):
        # A gate run never goes under a hold taken by hand, its own fleet's included: without the free it waits on it.
        self.manager()
        (self.registry / "gate").mkdir()
        hand = {"fleet": "p", "kind": "fleet", "what": "a build", "since": "2026-01-05T08:00:00+00:00",
                "until": "2999-01-01T00:00:00+00:00", "token": "abcd1234"}
        run = {"fleet": "p", "kind": "fleet", "what": "gate run: pnpm test", "since": "2026-01-05T08:00:00+00:00",
               "until": "2999-01-01T00:00:00+00:00", "token": "feed0001", "pid": os.getpid(), "cap": 8 * 2 ** 30}
        other = {**hand, "fleet": "infra", "token": "beef0002", "cap": 8 * 2 ** 30}
        summary = {"fleet": "p (8G) + infra (8G)", "kind": "session", "what": "two holds",
                   "since": "2026-01-05T08:00:00+00:00", "until": "2999-01-01T00:00:00+00:00", "v": 2}
        for held, freed in ((hand, "abcd1234"), ({**summary, "holds": [{**hand, "cap": 8 * 2 ** 30}, other]}, "abcd1234"),
                            ({**summary, "holds": [run, other]}, None), (other, None)):
            with self.subTest(held=held):
                (self.registry / "gate" / "gate.json").write_text(json.dumps(held))
                reason = self.decision(self.run_bash("pnpm test"))["permissionDecisionReason"]
                self.assertIn(f"Run it as: `{self.gate_run('pnpm test')}`", reason)
                if freed is None:
                    self.assertNotIn("fleets gate free", reason)
                else:
                    self.assertIn(f"Fleet p holds the slot by hand (token {freed}), and a gate run never runs under a "
                                  f"hold taken by hand, its own fleet's included: when that hold is this session's, "
                                  f"free it first with `{self.fleet_cli} fleets gate free {freed}`; else the run waits "
                                  f"for it like any other. ", reason)

    def test_a_landing_waiting_for_its_push_is_no_hold_by_hand_and_keeps_no_suite_out(self):
        # No pid, like a hold by hand, but its token is the lander's to free, and a run that is no landing passes it.
        self.manager()
        (self.registry / "gate").mkdir()
        pushing = {"fleet": "p", "kind": "fleet", "what": "gate run: just test", "since": "2026-01-05T08:00:00+00:00",
                   "until": "2999-01-01T00:00:00+00:00", "token": "abcd1234", "cap": 2 ** 26, "landing": True,
                   "pushing": True, "repo": "/r/p/.jj/repo"}
        summary = {"fleet": "p (64.0M)", "kind": "session", "what": "gate run: just test",
                   "since": "2026-01-05T08:00:00+00:00", "until": "2999-01-01T00:00:00+00:00", "v": 2, "holds": [pushing]}
        (self.registry / "gate" / "gate.json").write_text(json.dumps(summary))
        reason = self.decision(self.run_bash("pnpm test"))["permissionDecisionReason"]
        self.assertNotIn("fleets gate free", reason)
        self.assertNotIn("by hand", reason)
        self.assertNotIn("The slot is held now", reason)

    def test_a_gate_run_hold_whose_runner_is_gone_is_free(self):
        self.manager()
        (self.registry / "gate").mkdir()
        (self.registry / "gate" / "gate.json").write_text(json.dumps({
            "fleet": "w1", "kind": "session", "what": "gate run: just test", "since": "2026-01-05T08:00:00+00:00",
            "until": "2999-01-01T00:00:00+00:00", "token": "abcd1234", "pid": 2 ** 22 + 7}))
        d = self.decision(self.run_bash("pnpm test"))
        self.assertNotIn("The slot is held now", d["permissionDecisionReason"])

    def test_scoped_runs_and_gated_lines_pass(self):
        self.manager()
        for command in ("vitest run src/a.test.ts", "pnpm test -- src/a.test.ts", "just test-changed", "jj log",
                        f"{self.fleet_cli} fleets gate run --as p --wait 1800 -- pnpm test",
                        "fleet fleets gate take p 'just test' && just test",
                        "systemd-run --user --scope -p MemoryMax=8G -- pnpm test"):
            with self.subTest(command=command):
                r = self.run_bash(command)
                self.assertEqual(r.stdout, "", r.stdout)

    def test_outside_a_managed_fleet_only_a_hint_on_stderr(self):
        r = self.run_bash("pnpm test")  # a fleet, no manager
        self.assertEqual(r.stdout, "")
        self.assertIn("runs a whole test suite", r.stderr)
        self.assertIn("fleets gate run --as <name> -- <command>", r.stderr)
        r = self.run_bash("pnpm test", env={"CLAUDE_CODE_SESSION_ATTENDED": "0"})  # headless: nothing at all
        self.assertEqual((r.stdout, r.stderr), ("", ""))
        self.manager()
        (self.registry / "p.json").unlink()  # a manager, and this session serves no fleet
        r = self.run_bash("pnpm test")
        self.assertEqual(r.stdout, "")
        self.assertIn("runs a whole test suite", r.stderr)

    def test_outside_a_managed_fleet_a_runner_the_hook_cannot_read_is_hinted_as_one_it_cannot_tell(self):
        (self.repo / "var.sh").write_text("#!/bin/sh\nvp test --run $files\n")
        for command in ("./var.sh", "pnpm test 'src/a.test.ts"):
            with self.subTest(command=command):
                r = self.run_bash(command)
                self.assertEqual(r.stdout, "")
                self.assertIn(f"tstack: the hook can't tell whether `{command}` runs a whole test suite", r.stderr)
                self.assertNotIn(f"tstack: `{command}` runs", r.stderr)
                self.assertIn("fleets gate run --as <name> -- <command>", r.stderr)

    def test_a_dead_manager_does_not_manage(self):
        self.manager()
        entry = json.loads((self.registry / "manager.json").read_text())
        done = subprocess.run(["true"])
        entry["pid"] = 2 ** 22 + 7  # no such process
        (self.registry / "manager.json").write_text(json.dumps(entry))
        self.assertEqual(done.returncode, 0)
        self.assertEqual(self.run_bash("pnpm test").stdout, "")

    def test_the_fleet_is_found_by_fleet_dir_too(self):
        self.manager()
        other = self.tmp / "other"
        other.mkdir()
        (other / "state.json").write_text("{}")
        (self.registry / "ui.json").write_text(json.dumps({"id": "ui", "role": "coordinator", "dir": str(other),
                                                           "pid": os.getpid(), "since": "2026-01-05T09:00:00+00:00"}))
        d = self.decision(self.run_bash("pnpm test", env={"FLEET_DIR": str(other)}))
        self.assertIn("--as ui ", d["permissionDecisionReason"])


class PreToolUseDecisionTest(unittest.TestCase):
    """Only fleet_agent_grant's Allow allows a call: a gate's text (land_turn_gate, suite_gate, fleet_spawn_effort)
    denies, notes or says nothing, so auto mode's permission check is never skipped for a Bash command or a spawn."""

    def setUp(self):
        self.mod = load_hook()
        self.saved = self.mod.HANDLERS["PreToolUse"]
        self.addCleanup(lambda: self.mod.HANDLERS.__setitem__("PreToolUse", self.saved))

    def decide(self, *handlers):
        self.mod.HANDLERS["PreToolUse"] = list(handlers)
        out = self.mod.dispatch("PreToolUse", json.dumps({"tool_name": "Bash", "tool_input": {"command": "x"}}),
                                {"HOME": tempfile.gettempdir()})
        return json.loads(out)["hookSpecificOutput"]["permissionDecision"] if out else None

    def test_plain_text_decides_nothing(self):
        self.assertIsNone(self.decide(lambda hook: "tstack: a note"))

    def test_a_deny_wins_and_an_allow_comes_only_from_allow(self):
        self.assertEqual(self.decide(lambda hook: self.mod.Allow("granted")), "allow")
        self.assertEqual(self.decide(lambda hook: self.mod.Allow("granted"), lambda hook: self.mod.Deny("no")), "deny")

    def test_a_note_is_context_with_no_decision_and_a_deny_or_an_allow_drops_it(self):
        self.mod.HANDLERS["PreToolUse"] = [lambda hook: self.mod.Note("mind this")]
        out = json.loads(self.mod.dispatch("PreToolUse", "{}", {"HOME": tempfile.gettempdir()}))
        self.assertEqual(out, {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "mind this"}})
        self.assertEqual(self.decide(lambda hook: self.mod.Note("mind"), lambda hook: self.mod.Deny("no")), "deny")
        self.assertEqual(self.decide(lambda hook: self.mod.Note("mind"), lambda hook: self.mod.Allow("yes")), "allow")

    def test_a_guard_that_fails_denies_and_names_itself_and_the_error(self):
        """A guard's failure decided nothing, so the call it was there to refuse ran (a lone surrogate in a tree's
        record, review 4): every handler that can deny refuses the call when it fails."""
        def broken(hook):
            raise UnicodeEncodeError("utf-8", "\ud800", 0, 1, "surrogates not allowed")
        self.mod._shell_command = broken
        self.mod.HANDLERS["PreToolUse"] = [self.mod.fleet_grant_alone]
        out = self.mod.dispatch("PreToolUse", json.dumps({"tool_name": "Bash", "tool_input": {"command": "x"}}),
                                {"HOME": tempfile.gettempdir()})
        decided = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(decided["permissionDecision"], "deny")
        self.assertTrue(decided["permissionDecisionReason"].startswith(
            "tstack guard fleet_grant_alone failed (UnicodeEncodeError): denied"), decided)

    def test_a_guard_whose_error_carries_a_lone_surrogate_still_denies(self):
        """The failure's trace went to the log before the deny was made, and the log write itself raised on a lone
        surrogate in it (review 5): the hook then exited 1, a non-blocking error, and the call ran."""
        def broken(hook):
            raise ValueError("\ud800")
        self.mod._shell_command = broken
        self.mod.HANDLERS["PreToolUse"] = [self.mod.fleet_grant_alone]
        out = self.mod.dispatch("PreToolUse", json.dumps({"tool_name": "Bash", "tool_input": {"command": "x"}}),
                                {"HOME": tempfile.mkdtemp()})
        decided = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(decided["permissionDecision"], "deny")
        self.assertTrue(decided["permissionDecisionReason"].startswith(
            "tstack guard fleet_grant_alone failed (ValueError): denied"), decided)

    def test_a_handler_that_never_denies_passes_when_it_fails(self):
        def broken(hook):
            raise RuntimeError("a note that broke")
        self.assertIsNone(self.decide(broken))
        self.assertEqual(self.decide(broken, lambda hook: self.mod.Allow("granted")), "allow")
        self.assertEqual(set(self.saved) - self.mod.GUARDS,
                         {self.mod.fleet_agent_grant, self.mod.fleet_moved_card, self.mod.fleet_deploy_gate})

    def test_the_gates_return_only_a_deny(self):
        import inspect
        for gate in (self.mod.land_turn_gate, self.mod.push_attribution, self.mod.suite_gate):
            with self.subTest(gate=gate.__name__):
                returns = re.findall(r"^\s+return (.*)$", inspect.getsource(gate), re.M)
                self.assertTrue(returns)
                self.assertTrue(all(r == "None" or r.startswith("Deny(") for r in returns), returns)


class HooksJsonTest(unittest.TestCase):
    def test_every_registered_event_is_dispatched(self):
        config = json.loads(HOOKS_JSON.read_text())
        self.assertEqual(set(config), {"hooks"})
        source = SOURCE.read_text()
        handled = set(re.findall(r'^\s+"(\w+)": \[', source.split("HANDLERS = {", 1)[1].split("}", 1)[0], re.M))
        self.assertEqual(set(config["hooks"]), handled)
        for event, groups in config["hooks"].items():
            for group in groups:
                for h in group["hooks"]:
                    self.assertEqual(h["type"], "command")
                    self.assertEqual(h["command"], f'"${{CLAUDE_PLUGIN_ROOT}}/hooks/tstack-hook" {event}')
                    # the refusal's handler and the push gate start the fleet CLI (Bun): they get the time a start takes
                    slow = event == "PermissionDenied" or group.get("matcher") == "Bash|Monitor"
                    self.assertLessEqual(h.get("timeout", 60), 30 if slow else 10)
                    # what nobody reads runs in the background: a tool call never waits on a heartbeat
                    self.assertEqual(h.get("async", False), event in (*HEARTBEAT_ONLY, "PermissionDenied"), event)
        self.assertEqual(config["hooks"]["SessionStart"][0]["matcher"], "startup|resume|clear|compact")
        for event in (*HEARTBEAT_ONLY, "PostToolUse"):
            self.assertNotIn("matcher", config["hooks"][event][0])  # every tool
        # a grant's spawn, and the push gate's Bash calls
        self.assertEqual([g["matcher"] for g in config["hooks"]["PreToolUse"]], ["Agent", "Bash|Monitor"])
        self.assertTrue(os.access(HOOK, os.X_OK))
        self.assertTrue(os.access(MEMO, os.X_OK))
        self.assertEqual((ROOT / "bin" / "memo").resolve(), MEMO.resolve())
        self.assertEqual(TUCA.resolve(), (ROOT / "scripts" / "tuca-mode").resolve())
        self.assertTrue(os.access(TUCA, os.X_OK))


class LatencyTest(HookCase):
    def test_hooks_stay_fast(self):
        for n in range(40):
            self.memo("note", "fact", f"latency fact {n}")
        self.transcribe(*[tool_use("Read", file_path=f"f{n}") for n in range(500)])
        for event in ("SessionStart", "Stop"):
            payload = self.base(event, source="startup")
            self.hook(event, payload)  # warm the index
            self.assertCheap(event, event, payload)


class LauncherTest(HookCase):
    """hooks/tstack-hook loads hooks/tstack-hook.py as a module, so Python keeps its bytecode in hooks/__pycache__."""

    def plugin(self, code=True):
        root = self.tmp / "plugin"
        (root / "hooks").mkdir(parents=True)
        shutil.copy(HOOK, root / "hooks" / "tstack-hook")
        if code:
            shutil.copy(SOURCE, root / "hooks" / "tstack-hook.py")
            shutil.copy(FLEET_SOURCE, root / "hooks" / "fleet-hook.py")
        return root

    def wake(self, root):
        self.memo("note", "gotcha", "the launcher ran it")
        return subprocess.run([str(root / "hooks" / "tstack-hook"), "SessionStart"], capture_output=True, text=True,
                              input=json.dumps(self.base("SessionStart", source="startup")), env=self.env, timeout=30)

    def test_the_bytecode_is_kept_next_to_the_code(self):
        root = self.plugin()
        self.assertIn("the launcher ran it", self.wake(root).stdout)
        self.assertEqual(sorted(p.name.split(".")[0] for p in (root / "hooks" / "__pycache__").iterdir()), ["fleet-hook", "tstack-hook"])

    @unittest.skipIf(os.geteuid() == 0, "root writes through a read-only folder")
    def test_a_read_only_plugin_compiles_as_before(self):
        root = self.plugin()
        (root / "hooks").chmod(0o555)
        self.addCleanup((root / "hooks").chmod, 0o755)
        r = self.wake(root)
        self.assertIn("the launcher ran it", r.stdout)
        self.assertEqual(r.stderr, "")
        self.assertFalse((root / "hooks" / "__pycache__").exists())

    def test_a_cut_short_bytecode_runs_from_source_and_is_rewritten(self):
        root = self.plugin()
        self.wake(root)
        (pyc,) = (root / "hooks" / "__pycache__").glob("tstack-hook.*")
        pyc.write_bytes(pyc.read_bytes()[:40])  # its header holds, its code is cut: marshal's EOFError
        for _ in range(2):
            r = self.wake(root)
            self.assertEqual((r.returncode, r.stderr), (0, ""))
            self.assertIn("the launcher ran it", r.stdout)
        self.assertGreater(pyc.stat().st_size, 40)
        self.assertEqual(self.log(), "")

    def test_a_launcher_without_its_code_logs_and_says_so(self):
        r = self.wake(self.plugin(code=False))
        self.assertEqual((r.returncode, r.stdout), (1, ""))  # 1: an error the user sees that blocks nothing; never 2
        self.assertEqual(r.stderr, f"tstack-hook: dispatcher failed to load, see {self.data / 'hook.log'}\n")
        self.assertIn("launcher failed to load the dispatcher", self.log())
        self.assertIn("tstack-hook.py", self.log())



# A stand-in for fleet-run (fleet slice 3, decision 55): the program on stdin runs against the prelude's intents
# (lane (a)'s preludeSource, cut to the ones the hook calls) and a `records` that answers each op FAKE_RUN_TAG; the
# ops it made go to FAKE_RUN_LOG; FAKE_RUN_EXIT 3 answers queued, 4 is the host service down.
FAKE_RUN = """#!/usr/bin/env node
const fs = require("fs");
const program = fs.readFileSync(0, "utf8");
const ops = [];
const now = () => "2026-10-14T12:00:00Z";
const draft = (kind, key, set, extra) => {
  const op = { record: key === undefined ? { kind } : { kind, key }, ...extra };
  if (set !== undefined) op.set = set;
  ops.push(op);
  return op;
};
const decision = { open: (id, fields) => draft("decision", id, { status: "open", opened: now(), ...fields }) };
const event = (kind, text, options = {}) => draft("event", undefined, { at: now(), kind, text, ...options });
const tag = process.env.FAKE_RUN_TAG || "applied";
const records = { apply: (made) => made.map((op, i) => ({ _tag: op.record.kind === process.env.FAKE_RUN_REFUSE_KIND ? "refused" : tag, id: "op" + i, kind: op.record.kind,
  key: op.record.key ?? "e1", issue: "a refused op" })), read: () => [] };
const code = Number(process.env.FAKE_RUN_EXIT || 0);
if (code === 4) { process.stderr.write("fleet-host is not running on this machine\\n"); process.exit(4); }
const resent = process.argv.includes("--id");
if (code === 5 && !(resent && process.env.FAKE_RUN_RESENT_EXIT === "0")) {
  fs.appendFileSync(process.env.FAKE_RUN_LOG, JSON.stringify({ argv: process.argv.slice(2), dir: process.env.FLEET_DIR, unknown: true }) + "\\n");
  process.stdout.write(JSON.stringify({ id: "01K7C2Z9M4V8Q3R5T6W7X8Y9Z0", status: "unknown" }) + "\\n");
  process.exit(5);
}
const result = new Function("records", "ops", "decision", "event", program)(records, ops, decision, event);
fs.appendFileSync(process.env.FAKE_RUN_LOG, JSON.stringify({ argv: process.argv.slice(2), dir: process.env.FLEET_DIR,
  session: process.env.FLEET_SESSION ?? null, ops }) + "\\n");
const outcome = code === 3 ? { id: "01K", status: "queued", queued: { since: now() }, offline: { since: now(), queued: 1 } }
  : { id: "01K", status: "completed", result, ops: result };
process.stdout.write(JSON.stringify(outcome) + "\\n");
process.exit(code);
"""


class MovedFleet:
    """A fleet folder the host service exports from the cloud: cloud.json beside state.json, and fleet-run faked."""

    def move(self, folder=None):
        ((folder or self.fleet) / "cloud.json").write_text(json.dumps({"fleet": "p", "cloud": "https://fleet.example",
                                                           "since": "2026-10-14T12:00:00Z", "host": "office"}))
        self.runs = self.tmp / "fleet-run-calls.jsonl"
        run = self.tmp / "fleet-run"
        run.write_text(FAKE_RUN)
        run.chmod(0o755)
        self.env.update({"TSTACK_FLEET_RUN": str(run), "FAKE_RUN_LOG": str(self.runs)})

    def programs(self):
        return [json.loads(line) for line in self.runs.read_text().splitlines()] if self.runs.exists() else []



class RmGuardTest(HookCase):
    """rm_guard (PreToolUse, Bash and Monitor): a recursive rm whose operand can expand to what nobody read, or that
    names the home folder, a dot-folder in it, a folder of ~/.config or `/`, is refused. On 10-22 a reviewer ran
    `rm -rf ~/.config/jj/repos/$(cat …)`, the `cat` failed, and every repo's jj config went. The tests feed the hook
    JSON only: no rm runs."""

    SENTENCE = "tstack: refused a recursive delete"

    def call(self, command, tool="Bash", env=None):
        payload = {**self.base("PreToolUse"), "tool_name": tool, "tool_input": {"command": command}}
        r = self.hook("PreToolUse", payload, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def decision(self, command, tool="Bash", env=None):
        out = self.call(command, tool, env)
        return json.loads(out).get("hookSpecificOutput", {}) if out.strip() else {}

    def assertRefused(self, command, operand, tool="Bash", env=None):
        decision = self.decision(command, tool, env)
        self.assertEqual(decision.get("permissionDecision"), "deny", command)
        reason = decision["permissionDecisionReason"]
        self.assertIn(self.SENTENCE, reason, command)
        self.assertIn(f"`{operand}`", reason, command)
        self.assertIn("trash <path>", reason, command)
        self.assertIn("ls it", reason, command)

    def assertFed(self, command):
        reason = self.decision(command).get("permissionDecisionReason", "")
        self.assertIn(self.SENTENCE, reason, command)
        self.assertIn("xargs", reason, command)
        self.assertIn("list the paths first", reason, command)
        self.assertIn("trash <path>", reason, command)

    def assertAllowed(self, command, env=None):
        self.assertNotEqual(self.decision(command, env=env).get("permissionDecision"), "deny", command)

    def test_the_incident_command_is_refused(self):
        self.assertRefused("rm -rf ~/.config/jj/repos/$(cat /tmp/x)", "~/.config/jj/repos/$(cat /tmp/x)")

    def test_an_operand_that_expands_unguarded_is_refused(self):
        for command, operand in (('rm -rf "$DIR"/', '"$DIR"/'), ("rm -rf ${D}/x", "${D}/x"),
                                 ("rm -rf `pwd`/x", "`pwd`/x"), ("rm -rf ${D:-/tmp}/x", "${D:-/tmp}/x")):
            with self.subTest(command):
                self.assertRefused(command, operand)

    def test_an_operand_that_names_a_protected_folder_is_refused(self):
        for command, operand in (("rm -fr ~/.config", "~/.config"), ("rm -r ~/.ssh/", "~/.ssh/"), ("rm -rf ~", "~"),
                                 ("rm -rf $HOME/", "$HOME/"), ("rm -rf /", "/"), ("rm -Rf ~/.config/jj", "~/.config/jj"),
                                 ("rm -rfv ~/./.local/../.config/", "~/./.local/../.config/"),
                                 ("rm --recursive ~/.config/*", "~/.config/*"), ("cd ~ && rm -rf .ssh", ".ssh")):
            with self.subTest(command):
                self.assertRefused(command, operand)

    def test_rm_through_a_wrapper_or_find_is_refused(self):
        for command, operand in (("sudo rm -rf ~/.local", "~/.local"), ("find ~/.config -delete", "~/.config"),
                                 ("sudo -u root nice -n 5 timeout 10 rm -rf ~/.ssh", "~/.ssh"),
                                 ("env FOO=1 command rm -rf /", "/"), ("echo x | xargs rm -rf ~/.config", "~/.config"),
                                 ("find ~ -name x -exec rm -rf {} +", "~"), ("bash -c 'rm -rf ~/.ssh'", "~/.ssh"),
                                 ("ls; (cd /tmp && rm -rf $X)", "$X")):
            with self.subTest(command):
                self.assertRefused(command, operand)

    def test_a_whole_folder_glob_over_home_or_inside_a_dot_folder_of_it_is_refused(self):
        for operand in ("~/.config/jj/repos/*", "~/.ssh/*", "~/.config/jj/repos/abc123/*", "$HOME/.local/share/x/**",
                        "~/.cache/pip/*.*", "~/.local/x/{*,.*}", "~/*", "~/.*", "/*"):
            with self.subTest(operand):
                self.assertRefused(f"rm -rf {operand}", operand)

    def test_a_whole_folder_glob_in_a_plain_folder_under_home_is_allowed(self):
        """Only home, a folder above it, `/` and the inside of home's dot-folders hold what a whole-folder glob must
        not empty; a project's build folder is the glob's everyday use."""
        for command in ("cd ~/proj && rm -rf build/*", "rm -rf ~/proj/*", "rm -rf ~/proj/build/*", "rm -rf ./build/*",
                        "rm -rf $HOME/proj/build/**", "rm -rf ~/proj/{*,.*}", "cd ~/proj/build && rm -rf ./*"):
            with self.subTest(command):
                self.assertAllowed(command)

    def test_xargs_feeding_rm_its_operands_is_refused(self):
        for command in ("find . -name x | xargs rm -rf", "find . -print0 | xargs -0 rm -rf",
                        "ls | xargs -I{} rm -r {}", "cat list | xargs sudo rm -Rf --"):
            with self.subTest(command):
                self.assertFed(command)

    def test_xargs_feeding_rm_after_written_operands_is_refused(self):
        for command in ("echo ~/.ssh | xargs rm -rf /tmp/a", "xargs rm -rf /tmp/a < /dev/null"):
            with self.subTest(command):
                self.assertFed(command)

    def test_a_monitor_call_is_read_the_same(self):
        self.assertRefused("rm -rf ~/.config/jj/repos/$(cat /tmp/x)", "~/.config/jj/repos/$(cat /tmp/x)", tool="Monitor")

    def test_a_literal_or_guarded_operand_and_a_plain_rm_are_allowed(self):
        for command in ("rm -rf ./build", "rm -rf /tmp/claude-1000/x", "rm -rf ~/.config/jj/repos/abc123",
                        'rm -rf "${DIR:?}/build"', "rm file.txt", "rm -f ~/.config/x.json", "rm -f $X",
                        "find /tmp/x -name '*.o' -delete", "grep -r 'rm -rf ~' docs", "echo 'rm -rf /'",
                        "rm -rf '$HOME'x", "rm -rf ~/repos/x/.git", "rm -rf ./build/*", "rm -rf /tmp/x/*",
                        "rm -rf ~/proj/*.log", "ls | xargs rm -f", "ls | xargs echo rm -rf"):
            with self.subTest(command):
                self.assertAllowed(command)

    def test_a_cd_to_a_folder_nobody_read_refuses_a_relative_delete_after_it(self):
        """Unquoted and empty, the target leaves a bare `cd`, which goes to the home folder."""
        for command, operand in (("cd $(cat /tmp/x); rm -rf *", "*"), ("cd $D && rm -rf *", "*"),
                                 ("cd `cat /tmp/x` && rm -rf build", "build"), ('cd "" && rm -rf build', "build"),
                                 ("cd $D/sub && rm -rf ./x", "./x")):
            with self.subTest(command):
                self.assertRefused(command, operand)

    def test_a_cd_the_hook_cannot_read_refuses_a_bare_glob_after_it(self):
        for command, operand in (('cd "$D" && rm -rf *', "*"), ('cd "$(cat /tmp/x)" && rm -rf .*', ".*"),
                                 ('cd "${D:?}" && rm -rf ./*', "./*"), ("cd - && rm -rf *", "*")):
            with self.subTest(command):
                self.assertRefused(command, operand)

    def test_a_quoted_cd_nobody_read_leaves_a_literal_delete_alone(self):
        for command in ('cd "$(mktemp -d)" && rm -rf x', 'cd "$D" && rm -rf build', "cd $D && rm -rf /tmp/x",
                        'cd "$D" && rm -rf build/*.o'):
            with self.subTest(command):
                self.assertAllowed(command)

    def test_a_folder_above_home_is_refused(self):
        for command, operand in (("rm -rf /home", "/home"), ("rm -rf ~/..", "~/.."), ("rm -rf /home/*", "/home/*"),
                                 ("rm -rf /home/", "/home/"), ("rm -rf /ho*", "/ho*")):
            with self.subTest(command):
                self.assertRefused(command, operand, env={"HOME": "/home/u"})

    def test_a_whole_folder_glob_after_the_lines_own_cd_is_refused(self):
        for command, operand in (("cd ~/.config/jj/repos && rm -rf *", "*"), ("cd ~; rm -rf .*", ".*"),
                                 ("cd; rm -rf *", "*"), ("cd ~/.local/share/x && rm -rf ./*", "./*"),
                                 ("cd ~/.ssh && rm -rf build/*", "build/*")):
            with self.subTest(command):
                self.assertRefused(command, operand)

    def test_the_config_tree_two_folders_deep_is_refused(self):
        for command, operand in (("rm -rf ~/.config/jj/repos/", "~/.config/jj/repos/"),
                                 ("rm -rf $HOME/.config/jj/repos", "$HOME/.config/jj/repos"),
                                 ("rm -rf ~/.config/gh/hosts/../../jj/repos", "~/.config/gh/hosts/../../jj/repos"),
                                 ("rm -rf ~/.config/jj/repos/abc*", "~/.config/jj/repos/abc*"),
                                 ("rm -rf ~/.config/nvim/lazy", "~/.config/nvim/lazy")):
            with self.subTest(command):
                self.assertRefused(command, operand)

    def test_a_literal_folder_three_deep_in_the_config_tree_is_allowed(self):
        for command in ("rm -rf ~/.config/jj/repos/abc123", "rm -rf ~/.config/nvim/lua/plugins",
                        "cd ~/.config/jj/repos && rm -rf abc123"):
            with self.subTest(command):
                self.assertAllowed(command)

    def test_a_find_exec_of_a_wrapper_with_no_command_is_let_through(self):
        for command in (r"find . -name x.rm -exec nohup \;", r"find . -name x.rm -exec env \;"):
            with self.subTest(command):
                self.assertAllowed(command)

    DEEP = "$(" * 1200 + "x" + ")" * 1200  # past Python's recursion limit: rm_guard fails on it

    def test_a_command_with_no_rm_find_or_xargs_word_is_not_read(self):
        for command in ("terraform", "git log --format=%H", "npm run format", "confirm", "perm", "x.rm"):
            with self.subTest(command):
                self.assertNotEqual(self.decision(f"{command} {self.DEEP}").get("permissionDecision"), "deny")

    def test_a_failure_with_no_delete_in_the_command_lets_it_through_and_logs_it(self):
        self.assertNotEqual(self.decision(f"find . {self.DEEP}").get("permissionDecision"), "deny")
        self.assertIn("rm_guard failed", self.log())

    def test_a_failure_with_an_rm_in_the_command_denies_it(self):
        decision = self.decision(f"rm -rf {self.DEEP}")
        self.assertEqual(decision.get("permissionDecision"), "deny")
        self.assertIn("rm_guard failed", decision["permissionDecisionReason"])

    def test_find_deletes_through_any_rm_it_runs_or_a_shell_running_one(self):
        for command, operand in (("find ~/.ssh -type f -exec rm -f {} +", "~/.ssh"),
                                 ("find ~/.config -exec sh -c 'rm -rf \"$1\"' _ {} \;", "~/.config"),
                                 ("find ~/.ssh -execdir sudo rm {} \;", "~/.ssh")):
            with self.subTest(command):
                self.assertRefused(command, operand)

    def test_a_shell_with_options_before_its_script_is_read(self):
        for command in ("bash -euo pipefail -c 'rm -rf ~/.ssh'", "bash -c -- 'rm -rf ~/.ssh'",
                        "bash --norc -O extglob -c 'rm -rf ~/.ssh'"):
            with self.subTest(command):
                self.assertRefused(command, "~/.ssh")

    def test_more_wrappers_are_read(self):
        for command, operand in (("nice -5 rm -rf ~/.ssh", "~/.ssh"), ("nice -n5 rm -rf ~/.ssh", "~/.ssh"),
                                 ("command -- rm -rf ~/.ssh", "~/.ssh"), ("ionice -c3 rm -rf ~/.ssh", "~/.ssh"),
                                 ("ionice -c 2 -n 7 rm -rf ~/.ssh", "~/.ssh"), ("setsid -f rm -rf ~/.ssh", "~/.ssh"),
                                 ("flock /tmp/l rm -rf ~/.ssh", "~/.ssh"),
                                 ("flock -w 5 /tmp/l -c 'rm -rf ~/.ssh'", "~/.ssh"),
                                 ("busybox rm -rf ~/.ssh", "~/.ssh"), ("parallel rm -rf ::: ~/.ssh", "~/.ssh"),
                                 ("parallel -j4 rm -rf {} ::: /tmp/a ~/.ssh", "~/.ssh"),
                                 ("su -c 'rm -rf ~/.ssh'", "~/.ssh"), ("su - root --command='rm -rf ~/.ssh'", "~/.ssh"),
                                 ("env -C ~ rm -rf .ssh", ".ssh"), ("env --chdir=$HOME rm -rf .ssh", ".ssh"),
                                 ("sudo -D ~ rm -rf .ssh", ".ssh")):
            with self.subTest(command):
                self.assertRefused(command, operand)

    def test_nested_wrappers_are_peeled_one_at_a_time(self):
        for command in ("timeout 5 nice -5 rm -rf ~/.ssh", "time command -- rm -rf ~/.ssh",
                        "nohup timeout 5 ionice -c3 rm -rf ~/.ssh", "FOO=1 time env -C / nice -n5 rm -rf ~/.ssh"):
            with self.subTest(command):
                self.assertRefused(command, "~/.ssh")

    def test_a_trap_runs_its_text_as_a_shell_would(self):
        self.assertRefused("""trap 'rm -rf "$dir"/*' EXIT""", '"$dir"/*')
        self.assertRefused("trap -- 'rm -rf ~/.ssh' EXIT INT", "~/.ssh")
        for command in ("""trap 'rm -rf "${dir:?}"/*' EXIT""", "trap - EXIT", "trap -p", "trap 'rm -rf ./build' EXIT"):
            with self.subTest(command):
                self.assertAllowed(command)

    def test_parallel_feeding_rm_from_its_input_is_refused(self):
        for command in ("ls | parallel rm -rf", "parallel rm -rf :::: list"):
            with self.subTest(command):
                self.assertFed(command)

    def test_tilde_forms_and_a_climb_after_a_pattern_are_read(self):
        for command, operand, env in (("rm -rf ~root/.ssh", "~root/.ssh", None),
                                      ("cd ~ && rm -rf ~+/.ssh", "~+/.ssh", None),
                                      ("rm -rf ~/proj/{x,../.ssh}", "~/proj/{x,../.ssh}", None),
                                      ("rm -rf /home/u/proj/*/../../.ssh", "/home/u/proj/*/../../.ssh",
                                       {"HOME": "/home/u"})):
            with self.subTest(command):
                self.assertRefused(command, operand, env=env)

    def test_everyday_cleanups_are_allowed(self):
        for command in ("rm -rf node_modules", 'rm -rf "${dir:?}/build"', "rm -rf /tmp/claude-1000/sess/scratchpad/x",
                        "rm -rf ../skills-ws-a", "jj workspace forget ws-a && rm -rf ../ws-a",
                        "git worktree remove ../wt && rm -rf ../wt", "rm -rf ~/repos/skills-wt", "rm -rf ~/.cache/pip",
                        "find . -name node_modules -prune -exec rm -rf {} +", "find . -name '*.pyc' -delete",
                        "find . -name '*.pyc' -exec rm -f {} +", 'cd "$(mktemp -d)" && rm -rf x',
                        "cd build && rm -rf ./x", "cd /tmp/x && rm -rf *", "bash -euo pipefail -c 'rm -rf ./build'",
                        "nice -5 rm -rf ./build", "env -C /tmp rm -rf x"):
            with self.subTest(command):
                self.assertAllowed(command)

    def test_a_tmpdir_the_session_set_is_read_as_its_folder(self):
        env = {"TMPDIR": "/tmp/claude-1000"}
        for command in ('rm -rf "$TMPDIR/x"', 'rm -rf "${TMPDIR}/x"', "rm -rf $TMPDIR/x/*"):
            with self.subTest(command):
                self.assertAllowed(command, env=env)
        self.assertRefused('rm -rf "$TMPDIR/x"', '"$TMPDIR/x"')


if __name__ == "__main__":
    unittest.main()
