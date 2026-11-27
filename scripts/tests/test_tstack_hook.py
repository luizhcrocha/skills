"""Tests for hooks/tstack-hook.py, the plugin's one hook dispatcher, its launcher hooks/tstack-hook, and
hooks/hooks.json.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)

The rule under test above all: a hook never breaks a session. Whatever goes
wrong, the dispatcher exits 0 with nothing on stdout and logs to hook.log.
"""

import json
import os
import re
import resource
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / "hooks" / "tstack-hook"
SOURCE = HOOK.with_name("tstack-hook.py")  # the dispatcher's code, which the launcher HOOK loads
HOOKS_JSON = ROOT / "hooks" / "hooks.json"
MEMO = ROOT / "scripts" / "memo"
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
            "XDG_STATE_HOME": str(self.tmp / "state"),
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
    def test_injects_the_start_read_as_additional_context(self):
        self.memo("note", "hooks are one Python dispatcher")
        for source in ("startup", "resume", "clear", "compact"):
            r = self.hook("SessionStart", self.base("SessionStart", source=source))
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(set(out), {"hookSpecificOutput"})
            self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "SessionStart")
            context = out["hookSpecificOutput"]["additionalContext"]
            self.assertTrue(context.startswith("# memo"))
            self.assertIn("## Repo acme/hooked", context)
            self.assertIn("hooks are one Python dispatcher", context)

    def test_a_worker_gets_no_start_read(self):
        self.memo("note", "something")
        self.assertSilent(self.hook("SessionStart", self.base("SessionStart", source="startup", agent_id="a1")))
        self.assertSilent(self.hook("SessionStart", self.base("SessionStart", source="startup"),
                                    env={"TSTACK_ROLE": "worker"}))

    def test_cwd_falls_back_to_the_project_dir(self):
        self.memo("note", "found through CLAUDE_PROJECT_DIR")
        payload = self.base("SessionStart", source="startup")
        del payload["cwd"]
        r = self.hook("SessionStart", payload, env={"CLAUDE_PROJECT_DIR": str(self.repo)})
        self.assertIn("found through CLAUDE_PROJECT_DIR", r.stdout)

    def test_the_start_read_never_syncs_nor_starts_a_process(self):
        """A sync asks 1Password for the SSH key, so no hook may run one (design.md, Who syncs, and when)."""
        from unittest import mock
        self.memo("note", "read from the local store")
        hook = load_hook()
        calls = []

        def refuse(*args, **kwargs):
            calls.append(args)
            raise AssertionError("a sync or a process at session start")
        with (mock.patch.object(hook.memo(), "sync_bookmark", refuse), mock.patch("subprocess.run", refuse),
              mock.patch("subprocess.Popen", refuse)):
            out = hook.dispatch("SessionStart", json.dumps(self.base("SessionStart", source="startup")), self.env)
        self.assertEqual(calls, [])
        self.assertIn("read from the local store", out)

    def test_nothing_runs_before_a_compaction(self):
        self.assertNotIn("PreCompact", json.loads(HOOKS_JSON.read_text())["hooks"])
        self.assertSilent(self.hook("PreCompact", self.base("PreCompact", trigger="auto")))


class PeekRefreshTest(HookCase):
    """peek_refresh: SessionStart runs this release's `peek refresh`, detached, where peek has run. The plugin
    root's scripts/peek is the seam: a fake one records its argv."""

    def setUp(self):
        super().setUp()
        self.root = self.tmp / "plugin"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "scripts" / "memo").symlink_to(MEMO)
        self.runs = self.tmp / "peek-runs"
        (self.root / "scripts" / "peek").write_text(
            f"import sys\nopen({str(self.runs)!r}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n")
        self.env.update(CLAUDE_PLUGIN_ROOT=str(self.root))

    def start(self, **env):
        self.assertEqual(self.hook("SessionStart", self.base("SessionStart", source="startup"), env=env).returncode, 0)

    def test_it_refreshes_only_where_peek_has_run_and_never_for_a_worker_or_a_headless_run(self):
        self.start()
        pid = self.tmp / "state" / "tstack" / "peek" / "server.pid"
        pid.parent.mkdir(parents=True)
        pid.write_text("1234")
        self.start(TSTACK_ROLE="worker")
        self.start(CLAUDE_CODE_ENTRYPOINT="sdk-cli")
        self.start()
        deadline = time.monotonic() + 20
        while not self.runs.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        time.sleep(0.3)
        self.assertEqual(self.runs.read_text(), "refresh\n")
        self.assertNotIn("peek_refresh failed", self.log())


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
        self.runs = self.tmp / "tape-runs.jsonl"
        self.env.update(CLAUDE_PLUGIN_ROOT=str(self.root), FAKE_TAPE_LOG=str(self.runs))
        self.index = self.tmp / "data" / "tstack" / "tape" / "index.db"

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
        context = self.context(self.jjrepo)
        self.assertTrue(context.startswith("# memo"), context[:80])
        self.assertIn("\n\n# jj\n", context)

    def test_the_hint_is_fast(self):
        (self.jjrepo / "a" / "b" / "c").mkdir(parents=True)
        payload = {**self.base("SessionStart", source="startup"), "cwd": str(self.jjrepo / "a" / "b" / "c")}
        self.hook("SessionStart", payload)
        self.assertCheap("SessionStart (jj hints)", "SessionStart", payload)


class AskFlagTest(HookCase):
    """A reply ending on a question marks the Rex pane blocked through `fleet notify`; Luiz's next prompt clears it."""

    def setUp(self):
        super().setUp()
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        self.calls = self.tmp / "fleet.log"
        fleet = bin_dir / "fleet"
        fleet.write_text(f"#!{sys.executable}\nimport sys, json\n"
                         f"open({str(self.calls)!r}, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n")
        fleet.chmod(0o755)
        self.env.update(PATH=f"{bin_dir}{os.pathsep}{self.env['PATH']}", REX_BLOCK="block:1")

    def stop(self, text, env=None, **extra):
        return self.hook("Stop", self.base("Stop", stop_hook_active=False, last_assistant_message=text, **extra),
                         env=env)

    def ran(self):
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return [c for c in calls if "--help" not in c]

    def test_a_reply_ending_on_a_question_flags_the_pane_with_its_last_line(self):
        result = self.stop("Done: the gate passed.\n\n**Should I push it to master?**")
        self.assertSilent(result)
        self.assertEqual(self.ran(), [["notify", "repo: waiting on you", "Should I push it to master?"]])
        for text in ("Two options.\n\n- A\n- B\n\nWhich one do you want?",
                     "Run this, then tell me when it's done (did 1Password approve?)",
                     "Should I push it?\n\n```nu\njj git push --bookmark master\n```"):
            self.stop(text)
        self.assertEqual(len(self.ran()), 4)

    def test_the_next_prompt_clears_the_flag_once(self):
        self.stop("Should I push it?")
        self.assertSilent(self.hook("UserPromptSubmit", self.base("UserPromptSubmit", prompt="yes")))
        self.hook("UserPromptSubmit", self.base("UserPromptSubmit", prompt="and then?"))
        self.assertEqual([c[:2] for c in self.ran()], [["notify", "repo: waiting on you"], ["notify", "--clear"]])

    def test_a_failed_notice_is_still_cleared_since_the_pane_may_be_marked(self):
        fleet = self.tmp / "bin" / "fleet"
        fleet.write_text(fleet.read_text() + "sys.exit(1)\n")
        self.stop("Should I push it?")
        self.hook("UserPromptSubmit", self.base("UserPromptSubmit", prompt="yes"))
        self.assertEqual([c[:2] for c in self.ran()], [["notify", "repo: waiting on you"], ["notify", "--clear"]])

    def test_a_question_earlier_in_the_reply_or_in_code_is_not_one_for_the_user(self):
        for text in ("Why did it fail? The cache was stale.\n\nFixed and pushed.",
                     "Done.\n\n```nu\nls | where size > 1mb # big?\n```", "Done.\n\n```nu\nls # big?",
                     "Replaced each unwrap() with `?`", "He asked:\n\n> Should I push it?", "## Open questions?", ""):
            self.assertSilent(self.stop(text))
        self.assertSilent(self.hook("Stop", self.base("Stop", stop_hook_active=False)))
        self.hook("UserPromptSubmit", self.base("UserPromptSubmit", prompt="hi"))
        self.assertEqual(self.ran(), [])

    def test_a_notify_that_knows_ask_gets_it_so_the_broker_pushes_once(self):
        fleet = self.tmp / "bin" / "fleet"
        fleet.write_text(fleet.read_text() + "if '--help' in sys.argv: print('  --ask   a question: ntfy only when the broker is down')\n")
        self.stop("Should I push it?")
        self.assertEqual(self.ran(), [["notify", "--ask", "repo: waiting on you", "Should I push it?"]])

    def test_it_steps_aside_when_the_fleet_plugin_flags_asks_itself(self):
        plugin = self.tmp / "fleet-plugin"
        (plugin / "hooks").mkdir(parents=True)
        (plugin / "hooks" / "ask-handlers.json").write_text('{"v":1,"stop":true,"userPromptSubmit":true}')
        plugins = self.tmp / "home" / ".claude" / "plugins"
        plugins.mkdir(parents=True)
        (plugins / "installed_plugins.json").write_text(json.dumps(
            {"plugins": {"fleet@fleet": [{"scope": "user", "installPath": str(plugin)}]}}))
        self.stop("Should I push it?")
        self.assertEqual(self.ran(), [])
        (plugin / "hooks" / "ask-handlers.json").write_text('{"v":1,"stop":false}')
        self.stop("Should I push it?")
        self.assertEqual(len(self.ran()), 1)

    def test_skipped_for_workers_headless_runs_an_active_stop_hook_and_outside_rex(self):
        text = "Should I push it?"
        self.stop(text, agent_id="worker-1")
        self.stop(text, env={"TSTACK_ROLE": "worker"})
        self.stop(text, env={"CLAUDE_CODE_SESSION_ATTENDED": "0"})
        self.stop(text, env={"REX_BLOCK": ""})
        self.hook("Stop", self.base("Stop", stop_hook_active=True, last_assistant_message=text))
        self.assertEqual(self.ran(), [])


class SuspendHintTest(HookCase):
    def prompt(self, text, **extra):
        return self.hook("UserPromptSubmit", self.base("UserPromptSubmit", prompt=text, **extra))

    def test_a_suspend_request_points_at_fleet_suspend_me(self):
        for text in ("suspend yourself. we deal with this later", "suspens yourself with fleet suspend",
                     "please Suspend yourself", "ok, fleet suspend me now"):
            result = self.prompt(text)
            context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
            self.assertIn("fleet suspend me", context)

    def test_other_prompts_and_workers_get_nothing(self):
        for text in ("why did the suspend fail?", "fleet suspend gocli", "resume the work"):
            self.assertSilent(self.prompt(text))
        self.assertSilent(self.prompt("suspend yourself", agent_id="w1"))

    def test_a_relayed_agent_report_naming_suspend_gets_nothing(self):
        for text in (
            'Another Claude session sent a message:\n<agent-message from="a1">\n  [Subagent hand-back] then run `fleet suspend me --why "x"`',
            "<task-notification>\nsuspend yourself\n</task-notification>",
            # fleet's broker mail woke fleet-28 with handoff-waits' ask quoting `fleet suspend me` (2026-11-21).
            "Another Claude session sent a message:\nfleet broker: mail through=m4309 for fleet-28\nask m4309 from "
            "handoff-waits:\n  My last turn ran 'fleet suspend me' and then ended with a question.",
            '<cross-session-message from="uds:/run/user/1000/cc-socks/1.sock" from-name="x">\nsuspend yourself\n'
            "</cross-session-message>",
        ):
            self.assertSilent(self.prompt(text))

    def test_pasted_text_naming_suspend_gets_nothing_but_his_own_words_count(self):
        paste = '<pasted_content id="7628">\n❯ why didn\'t you suspend yourself\n</pasted_content id="7628">'
        self.assertSilent(self.prompt("agents are struggling with suspend orders\n\n" + paste))
        context = json.loads(self.prompt(paste + "\nok, suspend yourself").stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("fleet suspend me", context)


FAKE_REX = r"""#!/usr/bin/env python3
import json, os, sys, time
spec = json.load(open(os.environ["FAKE_REX_SPEC"]))
opts, panes = spec.get("_", {}), {k: v for k, v in spec.items() if k != "_"}
a = sys.argv[1:]
verb = a[1] if len(a) > 1 else ""
if opts.get("hang") == verb:
    time.sleep(8)
if opts.get("fail") == verb:
    sys.exit(1)
if opts.get("garbage") == verb:
    print("not json"); sys.exit(0)
if a[:2] == ["block", "inspect"]:
    print(json.dumps({"session_id": "session:s", "block": {"block_id": a[2], "window_id": "window:w"}}))
elif a[:2] == ["block", "ls"]:
    flavors = opts.get("flavors", {})
    print(json.dumps({"blocks": [{"block_id": b, "label": "shell",
                                  "flavor": flavors.get(b, "com.superlogical.terminal.shell")}
                                 for b in ["block:me", *panes]]}))
elif a[:2] == ["block", "call"]:
    print(json.dumps(panes[a[3]]))
"""


class SidePanesTest(HookCase):
    NU = {"pid": 10, "user_id": 1000, "name": "nu", "argv0": "nu", "cwd": "/repo"}
    DEV = {"pid": 11, "user_id": 1000, "name": "node", "argv0": "npm", "cwd": "/repo"}

    def setUp(self):
        super().setUp()
        bin_dir = self.tmp / "fakebin"
        bin_dir.mkdir()
        (bin_dir / "rex").write_text(FAKE_REX)
        (bin_dir / "rex").chmod(0o755)
        self.spec = self.tmp / "rex-spec.json"
        self.rex_env = {"PATH": f"{bin_dir}:{self.env['PATH']}", "REX_BLOCK": "block:me", "FAKE_REX_SPEC": str(self.spec)}

    def prompt(self, panes, **extra):
        self.spec.write_text(json.dumps(panes))
        r = self.hook("UserPromptSubmit", self.base("UserPromptSubmit", prompt="go on", **extra), env=self.rex_env)
        return json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"] if r.stdout.strip() else None

    def test_a_pane_beside_the_agent_is_named_once_then_again_when_it_changes(self):
        idle = {"block:dev": {"foreground": self.NU, "child": self.NU, "last_exit": None}}
        first = self.prompt(idle)
        self.assertIn("block:dev (shell): idle in /repo", first)
        self.assertIn("rex-watch --check", first)
        self.assertIsNone(self.prompt(idle))
        running = {"block:dev": {"foreground": self.DEV, "child": self.NU, "last_exit": None}}
        self.assertIn("block:dev (shell): running npm in /repo", self.prompt(running))
        self.assertIn("none now", self.prompt({}))
        self.assertIsNone(self.prompt({}))

    def test_a_rex_that_fails_hangs_or_prints_garbage_says_nothing_and_keeps_the_last_listing(self):
        idle = {"block:dev": {"foreground": self.NU, "child": self.NU, "last_exit": None}}
        self.assertIsNotNone(self.prompt(idle))
        for broken in ({"fail": "ls"}, {"fail": "call"}, {"garbage": "inspect"}, {"garbage": "call"}):
            self.assertIsNone(self.prompt({**idle, "_": broken}), broken)
        started = time.monotonic()
        self.assertIsNone(self.prompt({**idle, "_": {"hang": "call"}}))
        self.assertLess(time.monotonic() - started, 7)
        self.assertIsNone(self.prompt(idle))  # the last listing still stands: nothing changed

    def test_a_pane_that_is_not_a_terminal_is_named_without_a_process_call(self):
        out = self.prompt({"block:web": {}, "_": {"flavors": {"block:web": "com.superlogical.browser"}}})
        self.assertIn("block:web (shell): com.superlogical.browser", out)

    def test_past_eight_panes_the_rest_are_counted(self):
        idle = {"foreground": self.NU, "child": self.NU, "last_exit": None}
        out = self.prompt({f"block:p{i}": idle for i in range(10)})
        self.assertEqual(out.count(": idle in /repo"), 8)
        self.assertIn("and 2 more: rex block ls -w window:w", out)

    def test_a_compaction_tells_the_listing_again(self):
        idle = {"block:dev": {"foreground": self.NU, "child": self.NU, "last_exit": None}}
        self.assertIsNotNone(self.prompt(idle))
        self.assertIsNone(self.prompt(idle))
        self.hook("SessionStart", self.base("SessionStart", source="compact"))
        self.assertIn("block:dev", self.prompt(idle))

    def test_the_agent_own_pane_is_left_out(self):
        self.assertIsNone(self.prompt({}))

    def test_workers_and_sessions_outside_rex_get_nothing(self):
        panes = {"block:dev": {"foreground": self.NU, "child": self.NU, "last_exit": None}}
        self.assertIsNone(self.prompt(panes, agent_id="w1"))
        self.spec.write_text(json.dumps(panes))
        r = self.hook("UserPromptSubmit", self.base("UserPromptSubmit", prompt="go on"),
                      env={**self.rex_env, "REX_BLOCK": ""})
        self.assertSilent(r)


class NeverBreakTest(HookCase):
    """Whatever the input or the state of the machine: exit 0, nothing on stdout."""

    def test_bad_input(self):
        for raw in ("not json", "[1, 2]", "null", '{"session_id": ', "\x00\xff", '{"cwd": 7, "source": []}'):
            for event in ("SessionStart", "Stop"):
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
        self.assertIn("SessionStart memo_start failed", self.log())

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

    def test_a_broken_memory_store_still_reads_or_stays_silent(self):
        notes = self.repo / ".tstack" / "memo" / "notes"
        notes.mkdir(parents=True)
        (notes / "01ARZ3NDEKTSV4RRFFQ69G5FAV.md").write_text("+++\nnot toml at all ===\n+++\ntext\n")
        (self.repo / ".tstack" / "memo" / "config.toml").write_text("project_lines = [broken")
        r = self.hook("SessionStart", self.base("SessionStart", source="startup"))
        self.assertEqual(r.returncode, 0)
        self.assertIn("# memo", json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"])

    def test_headless_sessions_still_get_the_start_read(self):
        r = self.hook("SessionStart", self.base("SessionStart", source="startup"),
                      env={"CLAUDE_CODE_SESSION_ATTENDED": "0", "CLAUDE_CODE_ENTRYPOINT": "sdk-cli"})
        self.assertIn("# memo", json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"])


def load_hook():
    """hooks/tstack-hook.py as a module, to time a handler without the interpreter's start-up."""
    from importlib.machinery import SourceFileLoader
    from importlib.util import module_from_spec, spec_from_loader
    loader = SourceFileLoader("tstack_hook_under_test", str(SOURCE))
    module = module_from_spec(spec_from_loader("tstack_hook_under_test", loader))
    loader.exec_module(module)
    return module


class TapeRoleTest(HookCase):
    """TSTACK_ROLE=tape, a tape builder's own `claude -p` call: every handler of every event stays silent and
    writes nothing (no start read in the compaction prompt, no state)."""

    def files(self):
        """Every file under the test's tmp with its size and mtime, so a write to an existing file (the memo
        index, memo-v2.db) counts as well as a new one."""
        return sorted((str(p.relative_to(self.tmp)), p.stat().st_size, p.stat().st_mtime_ns)
                      for p in self.tmp.rglob("*") if p.is_file())

    def every_event(self, env):
        self.memo("note", "a start read would carry this")
        self.transcribe(said("edit it"), tool_use("Edit", file_path=str(self.repo / "a.py")))
        before = self.files()
        results = {}
        for event in json.loads(HOOKS_JSON.read_text())["hooks"]:
            payload = self.base(event, source="startup", stop_hook_active=False, tool_name="Agent",
                                tool_input={"subagent_type": "general-purpose", "prompt": "p"},
                                tool_use_id="toolu_1", agent_id="ab12" if event.startswith("Subagent") else None)
            results[event] = self.hook(event, payload, env=env)
        return before, results

    def test_every_handler_is_silent_and_writes_nothing(self):
        before, results = self.every_event({"TSTACK_ROLE": "tape"})
        for event, r in results.items():
            self.assertSilent(r)
        self.assertEqual(self.files(), before, "a tape call's hooks wrote a file")

    def test_the_same_events_speak_without_the_role(self):
        before, results = self.every_event({})
        self.assertIn("a start read would carry this", results["SessionStart"].stdout)
        self.assertNotEqual(self.files(), before)


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
        cls.lines = staticmethod(load_hook().attribution_lines)

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


class PreToolUseDecisionTest(unittest.TestCase):
    """tstack never allows a call: a gate's text (push_attribution)
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

    def test_a_deny_refuses_and_nothing_allows(self):
        self.assertEqual(self.decide(lambda hook: self.mod.Deny("no")), "deny")
        self.assertFalse(hasattr(self.mod, "Allow"))

    def test_a_note_is_context_with_no_decision_and_a_deny_drops_it(self):
        self.mod.HANDLERS["PreToolUse"] = [lambda hook: self.mod.Note("mind this")]
        out = json.loads(self.mod.dispatch("PreToolUse", "{}", {"HOME": tempfile.gettempdir()}))
        self.assertEqual(out, {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "mind this"}})
        self.assertEqual(self.decide(lambda hook: self.mod.Note("mind"), lambda hook: self.mod.Deny("no")), "deny")

    def test_a_guard_that_fails_denies_and_names_itself_and_the_error(self):
        """A guard's failure decided nothing, so the call it was there to refuse ran (a lone surrogate in a tree's
        record, review 4): every handler that can deny refuses the call when it fails."""
        def broken(hook):
            raise UnicodeEncodeError("utf-8", "\ud800", 0, 1, "surrogates not allowed")
        self.mod._shell_command = broken
        self.mod.HANDLERS["PreToolUse"] = [self.mod.rm_guard]
        out = self.mod.dispatch("PreToolUse", json.dumps({"tool_name": "Bash", "tool_input": {"command": "x"}}),
                                {"HOME": tempfile.gettempdir()})
        decided = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(decided["permissionDecision"], "deny")
        self.assertTrue(decided["permissionDecisionReason"].startswith(
            "tstack guard rm_guard failed (UnicodeEncodeError): denied"), decided)

    def test_a_guard_whose_error_carries_a_lone_surrogate_still_denies(self):
        """The failure's trace went to the log before the deny was made, and the log write itself raised on a lone
        surrogate in it (review 5): the hook then exited 1, a non-blocking error, and the call ran."""
        def broken(hook):
            raise ValueError("\ud800")
        self.mod._shell_command = broken
        self.mod.HANDLERS["PreToolUse"] = [self.mod.rm_guard]
        out = self.mod.dispatch("PreToolUse", json.dumps({"tool_name": "Bash", "tool_input": {"command": "x"}}),
                                {"HOME": tempfile.mkdtemp()})
        decided = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(decided["permissionDecision"], "deny")
        self.assertTrue(decided["permissionDecisionReason"].startswith(
            "tstack guard rm_guard failed (ValueError): denied"), decided)

    def test_a_handler_that_never_denies_passes_when_it_fails(self):
        def broken(hook):
            raise RuntimeError("a note that broke")
        self.assertIsNone(self.decide(broken))
        self.assertEqual(self.decide(broken, lambda hook: self.mod.Deny("no")), "deny")
        self.assertEqual(set(self.saved) - self.mod.GUARDS, set())

    def test_the_gates_return_only_a_deny(self):
        import inspect
        for gate in (self.mod.push_attribution,):
            with self.subTest(gate=gate.__name__):
                returns = re.findall(r"^\s+return (.*)$", inspect.getsource(gate), re.M)
                self.assertTrue(returns)
                self.assertTrue(all(r == "None" or r.startswith("Deny(") for r in returns), returns)


class SpawnEffortTest(HookCase):
    """spawn_effort (PreToolUse, Agent): a spawn passes its role's `model` and `effort` (docs/models.md), because the
    Agent tool sets effort only when asked and a bare spawn inherits the session's. On 2026-11-20 two Implementers
    went out with no effort from a session whose rules said Opus high."""

    def decision(self, **tool_input):
        payload = {**self.base("PreToolUse"), "tool_name": "Agent", "tool_input": tool_input}
        r = self.hook("PreToolUse", payload)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout).get("hookSpecificOutput", {}) if r.stdout.strip() else {}

    def test_a_spawn_without_model_or_effort_is_denied_with_the_table(self):
        for given in ({"model": "opus"}, {"effort": "high"}, {}):
            with self.subTest(given):
                d = self.decision(description="cut", prompt="p", subagent_type="general-purpose", **given)
                self.assertEqual(d.get("permissionDecision"), "deny")
                self.assertIn("docs/models.md", d["permissionDecisionReason"])
                self.assertIn("Implementer", d["permissionDecisionReason"])

    def test_an_effort_the_tool_does_not_take_is_denied(self):
        d = self.decision(description="x", prompt="p", model="opus", effort="ultra")
        self.assertEqual(d.get("permissionDecision"), "deny")
        self.assertIn("`ultra`", d["permissionDecisionReason"])

    def test_a_pair_no_row_names_is_denied_with_the_table(self):
        for model, effort in (("haiku", "medium"), ("fable", "low"), ("opus", "max")):
            with self.subTest(model=model, effort=effort):
                d = self.decision(description="x", prompt="p", subagent_type="general-purpose", model=model,
                                  effort=effort)
                self.assertEqual(d.get("permissionDecision"), "deny")
                self.assertIn(f"{model} {effort}", d["permissionDecisionReason"])
                self.assertIn("Implementer: tested-fix", d["permissionDecisionReason"])

    def test_every_pair_a_row_names_passes(self):
        for model, effort in (("opus", "medium"), ("sonnet", "medium"), ("haiku", "high"), ("fable", "high"),
                              ("opus", "xhigh")):
            with self.subTest(model=model, effort=effort):
                self.assertEqual(self.decision(description="x", prompt="p", subagent_type="general-purpose",
                                               model=model, effort=effort), {})

    def test_a_spawn_with_its_pair_a_fork_or_a_definition_that_carries_it_passes(self):
        for given in ({"subagent_type": "general-purpose", "model": "opus", "effort": "high"},
                      {"subagent_type": "fork"}, {"subagent_type": "tstack:reader"},
                      {"subagent_type": "fleet:advisor"}):
            with self.subTest(given):
                self.assertEqual(self.decision(description="x", prompt="p", **given), {})


AGENT_CAP = ROOT / "bin" / "agent-cap"


class AgentCapTest(HookCase):
    """agent_cap (PreToolUse, Agent): a session runs at most 3 subagents at once; a spawn past that is denied until
    Luiz lifts it with bin/agent-cap (Luiz, 2026-11-20, after a token drain). Running: a meta.json beside the session's
    transcript (<session>/subagents/agent-<id>.meta.json) with none of finished, stoppedByUser or sweptByStop, not
    stopped by a TaskStop, and written since the session's claude process started."""

    def setUp(self):
        super().setUp()
        self.subagents = self.tmp / "transcript" / "subagents"
        self.subagents.mkdir(parents=True)

    def agent(self, agent_id, **meta):
        (self.subagents / f"agent-{agent_id}.meta.json").write_text(json.dumps(
            {"agentType": "general-purpose", "toolUseId": f"toolu_{agent_id}", "requestShape": "background", **meta}))
        (self.subagents / f"agent-{agent_id}.jsonl").write_text("")

    def call(self, tool_name, tool_input, tool_use_id="toolu_new", **extra):
        payload = {**self.base("PreToolUse"), "tool_name": tool_name, "tool_input": tool_input,
                   "tool_use_id": tool_use_id, **extra}
        r = self.hook("PreToolUse", payload)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout).get("hookSpecificOutput", {}) if r.stdout.strip() else {}

    def spawn(self, tool_use_id="toolu_new", **extra):
        return self.call("Agent", {"description": "x", "prompt": "p", "subagent_type": "general-purpose",
                                   "model": "opus", "effort": "high"}, tool_use_id, **extra)

    def lift(self, *args):
        return subprocess.run([str(AGENT_CAP), *args], capture_output=True, text=True, env=self.env, timeout=30)

    def test_under_the_cap_a_spawn_passes(self):
        self.agent("a1")
        self.agent("a2")
        self.agent("done1", finished=True)
        self.agent("done2", stoppedByUser=True)
        self.agent("done3", sweptByStop=True)
        self.assertEqual(self.spawn(), {})

    def test_at_or_over_the_cap_a_spawn_is_denied_with_the_ask(self):
        for n in (3, 5):
            with self.subTest(running=n):
                for i in range(n):
                    self.agent(f"r{i}")
                d = self.spawn()
                self.assertEqual(d.get("permissionDecision"), "deny")
                why = d["permissionDecisionReason"]
                self.assertIn(f"{n} subagents running", why)
                self.assertIn("```text fleet:ask", why)
                self.assertIn("bin/agent-cap allow sess-1", why)
                self.assertIn("only Luiz", why)

    def test_a_spawn_from_a_subagent_counts_the_whole_session(self):
        for i in range(3):
            self.agent(f"r{i}")
        self.assertEqual(self.spawn(agent_id="r0", agent_type="general-purpose").get("permissionDecision"), "deny")

    def test_a_task_stopped_agent_does_not_count(self):
        for i in range(3):
            self.agent(f"r{i}")
        self.transcribe({"type": "user", "message": {"role": "user", "content": [
            {"tool_use_id": "toolu_x", "type": "tool_result",
             "content": '{"message":"Successfully stopped task: r1 (cut)","task_id":"r1"}'}]}})
        self.assertEqual(self.spawn(), {})

    def test_a_nested_agent_stopped_by_its_parent_does_not_count(self):
        self.agent("p1")
        self.agent("r1", parentAgentId="p1")
        self.agent("r2")
        (self.subagents / "agent-p1.jsonl").write_text('{"content":"Successfully stopped task: r1 (x)"}\n')
        self.assertEqual(self.spawn(), {})

    def test_spawns_in_one_message_count_each_other_before_their_metas_exist(self):
        self.agent("a1")
        self.agent("a2")
        self.assertEqual(self.spawn("toolu_p1"), {})
        self.assertEqual(self.spawn("toolu_p2").get("permissionDecision"), "deny")
        self.agent("p1", toolUseId="toolu_p1")  # the first spawn's meta lands: it counts once, not twice
        self.assertIn("3 subagents running", self.spawn("toolu_p3")["permissionDecisionReason"])
        (self.subagents / "agent-p1.meta.json").write_text(json.dumps({"toolUseId": "toolu_p1", "finished": True}))
        self.assertEqual(self.spawn("toolu_p4"), {})

    def test_agents_older_than_the_claude_process_do_not_count(self):
        """A session resumed in a new process: the agents its old process left unfinished are dead."""
        for i in range(3):
            self.agent(f"r{i}")
        old = time.time() - 3600
        for i in range(2):
            os.utime(self.subagents / f"agent-r{i}.meta.json", (old, old))
        claude = self.tmp / "bin" / "claude"
        claude.parent.mkdir()
        claude.symlink_to(Path(shutil.which("bash", path=self.env["PATH"])).resolve())  # a binary: its comm is claude
        payload = {**self.base("PreToolUse"), "tool_name": "Agent", "tool_use_id": "toolu_new", "tool_input": {
            "description": "x", "prompt": "p", "subagent_type": "general-purpose", "model": "opus", "effort": "high"}}
        r = subprocess.run([str(claude), "-c", f"'{HOOK}' PreToolUse; exit $?"], input=json.dumps(payload),
                           capture_output=True, text=True, env=self.env, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")

    def test_luiz_lifts_the_cap_for_one_session(self):
        for i in range(3):
            self.agent(f"r{i}")
        r = self.lift("allow", "sess-1", "2")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("5", r.stdout)
        self.assertEqual(self.spawn(), {})
        self.agent("r3", toolUseId="toolu_new")
        self.agent("r4")
        self.assertIn("5 subagents running", self.spawn("toolu_more")["permissionDecisionReason"])
        self.assertEqual(self.spawn("toolu_other", session_id="sess-2").get("permissionDecision"), "deny")
        self.assertEqual(self.lift("allow", "sess-1", "1").returncode, 0)
        self.assertEqual(self.spawn("toolu_new2"), {})

    def test_the_lift_takes_a_session_and_a_positive_count(self):
        for args in ((), ("allow",), ("allow", "sess-1"), ("allow", "sess-1", "0"), ("allow", "sess-1", "x"),
                     ("allow", "../up", "1"), ("raise", "sess-1", "1")):
            with self.subTest(args):
                self.assertNotEqual(self.lift(*args).returncode, 0)

    def test_an_agent_cannot_lift_its_own_cap(self):
        for command in ("bin/agent-cap allow sess-1 5", "~/repos/tstack/scripts/agent-cap  allow sess-1 1",
                        f"echo '{{\"limit\": 9}}' > {self.data}/sessions/sess-1/agent-cap.json"):
            with self.subTest(command):
                d = self.call("Bash", {"command": command})
                self.assertEqual(d.get("permissionDecision"), "deny")
                self.assertIn("only Luiz", d["permissionDecisionReason"])
        d = self.call("Write", {"file_path": str(self.data / "sessions" / "sess-1" / "agent-cap.json"), "content": "{}"})
        self.assertEqual(d.get("permissionDecision"), "deny")
        self.assertEqual(self.call("Bash", {"command": "cat bin/agent-cap"}), {})

    def test_a_count_it_cannot_read_lets_the_spawn_through_and_says_why(self):
        for i in range(3):
            self.agent(f"r{i}")
        self.assertEqual(self.spawn(transcript_path=None), {})
        self.assertIn("agent_cap", self.log())
        shutil.rmtree(self.subagents)
        self.subagents.write_text("not a folder")
        self.assertEqual(self.spawn(), {})
        self.assertIn("NotADirectoryError", self.log())


class ContextWallTest(HookCase):
    """context_wall (PreToolUse, every tool): a subagent past 200k tokens of context may only write its handoff to the
    temp dir and report back (Luiz, 2026-11-20). Its context: the last assistant message's usage in its own transcript,
    <session>/subagents/agent-<id>.jsonl. A session's main thread is tuca-mode's line 7's to restart."""

    def setUp(self):
        super().setUp()
        self.subagents = self.tmp / "transcript" / "subagents"
        self.subagents.mkdir(parents=True)
        self.tmpdir = self.tmp / "tmpdir"
        self.tmpdir.mkdir()
        self.env["TMPDIR"] = str(self.tmpdir)

    def context(self, tokens, agent="a1", **meta):
        line = {"type": "assistant", "agentId": agent, "message": {"role": "assistant", "content": [], "usage": {
            "input_tokens": 10, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": tokens - 1010,
            "output_tokens": 500}}}
        (self.subagents / f"agent-{agent}.jsonl").write_text(
            json.dumps(said("go")) + "\n" + json.dumps(line) + "\n" + json.dumps({"type": "api-request"}) + "\n")
        (self.subagents / f"agent-{agent}.meta.json").write_text(json.dumps({"toolUseId": "toolu_x", **meta}))

    def call(self, tool_name, tool_input, agent="a1"):
        payload = {**self.base("PreToolUse"), "tool_name": tool_name, "tool_input": tool_input}
        if agent:
            payload.update(agent_id=agent, agent_type="general-purpose")
        r = self.hook("PreToolUse", payload)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout).get("hookSpecificOutput", {}) if r.stdout.strip() else {}

    def test_under_the_wall_a_subagent_works(self):
        self.context(150_000)
        self.assertEqual(self.call("Bash", {"command": "ls"}), {})
        self.assertEqual(self.call("Read", {"file_path": str(self.repo / "x")}), {})

    def test_past_the_wall_a_subagent_is_refused_its_work(self):
        self.context(210_000)
        for tool, args in (("Bash", {"command": "ls"}), ("Read", {"file_path": str(self.repo / "x")}),
                           ("Edit", {"file_path": str(self.repo / "x"), "old_string": "a", "new_string": "b"}),
                           ("Write", {"file_path": str(ROOT / "handoff.md"), "content": "x"}),
                           ("Write", {"file_path": f"{self.tmpdir}{'/..' * 12}/etc/handoff.md", "content": "x"}),
                           ("Write", {"file_path": "/tmp/notes.md", "content": "x"}),
                           ("Agent", {"description": "x", "prompt": "p", "model": "opus", "effort": "high"}),
                           ("SendMessage", {"to": "someone-else", "message": "x"}),
                           ("TaskStop", {"task_id": "a2"})):
            with self.subTest(tool, **args):
                d = self.call(tool, args)
                self.assertEqual(d.get("permissionDecision"), "deny")
                self.assertIn("past 200k context: write your handoff (tstack:handoff) to /tmp and report; a fresh "
                              "agent continues from it", d["permissionDecisionReason"])

    def test_past_the_wall_the_handoff_and_the_report_pass(self):
        self.context(210_000)
        for tool, args in (("Write", {"file_path": str(self.tmpdir / "handoff-cap.md"), "content": "x"}),
                           ("Write", {"file_path": "/tmp/handoff-cap.md", "content": "x"}),
                           ("Edit", {"file_path": "/tmp/handoff-cap.md", "old_string": "a", "new_string": "b"}),
                           ("Skill", {"skill": "tstack:handoff"}),
                           ("ToolSearch", {"query": "select:SendMessage"}),
                           ("SubagentHandback", {"message": "report"}),
                           ("SendMessage", {"to": "main", "message": "report"}),
                           ("TaskStop", {"task_id": "a1"})):
            with self.subTest(tool, **args):
                self.assertEqual(self.call(tool, args), {})

    def test_a_nested_subagent_reports_to_the_agent_that_spawned_it(self):
        self.context(210_000, parentAgentId="p1")
        self.assertEqual(self.call("SendMessage", {"to": "p1", "message": "report"}), {})

    def test_the_main_session_is_untouched(self):
        self.transcribe({"type": "assistant", "message": {"role": "assistant", "content": [], "usage": {
            "input_tokens": 10, "cache_read_input_tokens": 300_000, "cache_creation_input_tokens": 0}}})
        self.context(300_000)
        self.assertEqual(self.call("Bash", {"command": "ls"}, agent=None), {})

    def test_a_context_it_cannot_read_lets_the_call_through_and_says_why(self):
        self.assertEqual(self.call("Bash", {"command": "ls"}, agent="gone"), {})
        self.assertIn("context_wall", self.log())
        (self.subagents / "agent-a1.jsonl").write_text('{"type": "assistant", "message": {"usage": "lots"}}\n{oops\n')
        self.assertEqual(self.call("Bash", {"command": "ls"}), {})


class LangSkillTest(HookCase):
    """lang_skill (PreToolUse, Edit/Write/MultiEdit): an edit of a file in a language with a lang-* skill is
    denied until the agent making it has loaded the skill, in its own transcript: a parent's skill is not a
    subagent's (Luiz, 2026-11-22: 29% of 532 subagents editing Go had loaded lang-go)."""

    def setUp(self):
        super().setUp()
        self.subagents = self.tmp / "transcript" / "subagents"
        self.subagents.mkdir(parents=True)

    def edit(self, path, tool="Edit", agent=None):
        payload = {**self.base("PreToolUse"), "tool_name": tool, "tool_input": {"file_path": path}}
        if agent:
            payload["agent_id"] = agent
        return self.hook("PreToolUse", payload)

    def denied(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "deny")
        return out["permissionDecisionReason"]

    def test_an_edit_before_the_skill_is_denied_naming_it(self):
        self.assertIn("tstack:lang-go", self.denied(self.edit("/r/main.go")))

    def test_each_language_names_its_own_skill(self):
        for path, skill in (("a.py", "lang-py"), ("a.nix", "lang-nix"), ("a.nu", "lang-nu"), ("a.rs", "lang-rust"),
                            ("a.tsx", "lang-ts"), ("a.c", "lang-c"), ("a.hpp", "lang-cpp"), ("a.zig", "lang-zig"),
                            ("a.swift", "lang-swift"), ("a.cs", "lang-cs")):
            with self.subTest(path=path):
                self.assertIn(f"tstack:{skill}", self.denied(self.edit(f"/r/{path}")))

    def test_a_header_takes_the_c_or_the_cpp_skill(self):
        reason = self.denied(self.edit("/r/a.h"))
        self.assertIn("tstack:lang-c or tstack:lang-cpp", reason)
        self.transcribe(tool_use("Skill", skill="tstack:lang-cpp"))
        self.assertSilent(self.edit("/r/a.h"))

    def test_other_files_and_tools_pass(self):
        for path in ("/r/README.md", "/r/a.json", "/r/Makefile", "/r/go"):
            with self.subTest(path=path):
                self.assertSilent(self.edit(path))
        payload = {**self.base("PreToolUse"), "tool_name": "Read", "tool_input": {"file_path": "/r/main.go"}}
        self.assertSilent(self.hook("PreToolUse", payload))

    def test_text_that_only_names_the_skill_is_no_load(self):
        skill = "/p/skills/engineering/lang-go/SKILL.md"
        self.transcribe(tool_use("Agent", prompt=f"Go rules: {skill}"),
                        {"type": "user", "message": {"role": "user", "content": [
                            {"type": "tool_result", "tool_use_id": "t", "content": f"see {skill} and <command-name>/tstack:lang-go</command-name>"}]}},
                        {"type": "user", "message": {"role": "user", "content": f"read {skill}"}})
        self.denied(self.edit("/r/main.go"))

    def test_a_shell_read_through_a_glob_counts(self):
        self.transcribe(tool_use("Bash", command="cat /p/skills/*/lang-go/SKILL.md"))
        self.assertSilent(self.edit("/r/main.go"))

    def test_the_deny_names_the_skill_file_to_read(self):
        self.assertIn("skills/engineering/lang-go/SKILL.md", self.denied(self.edit("/r/main.go")))

    def test_every_edit_tool_is_covered(self):
        for tool in ("Edit", "Write", "MultiEdit"):
            with self.subTest(tool=tool):
                self.denied(self.edit("/r/main.go", tool=tool))

    def test_a_skill_call_lets_the_edit_through_with_or_without_the_plugin_prefix(self):
        for name in ("tstack:lang-go", "lang-go"):
            with self.subTest(name=name):
                self.transcript.write_text("")
                self.transcribe(tool_use("Skill", skill=name))
                self.assertSilent(self.edit("/r/main.go"))

    def test_reading_the_skill_file_or_typing_its_command_counts(self):
        self.transcribe(tool_use("Read", file_path="/home/x/.claude/plugins/cache/tstack/skills/engineering/lang-go/SKILL.md"))
        self.assertSilent(self.edit("/r/main.go"))
        self.transcript.write_text("")
        self.transcribe({"type": "user", "message": {"role": "user", "content":
                         "<command-name>/tstack:lang-go</command-name>"}})
        self.assertSilent(self.edit("/r/main.go"))

    def test_another_language_s_skill_does_not_count(self):
        self.transcribe(tool_use("Skill", skill="tstack:lang-py"))
        self.denied(self.edit("/r/main.go"))
        self.assertSilent(self.edit("/r/a.py"))

    def test_the_skill_list_in_a_system_reminder_does_not_count(self):
        self.transcribe({"type": "user", "message": {"role": "user", "content":
                         "- tstack:lang-go: Go rules and taste. Use for any Go code. skills/engineering/lang-go"}})
        self.denied(self.edit("/r/main.go"))

    def test_a_subagent_reads_its_own_transcript_not_its_parent_s(self):
        self.transcribe(tool_use("Skill", skill="tstack:lang-go"))
        (self.subagents / "agent-a1.jsonl").write_text(json.dumps(said("go")) + "\n")
        self.denied(self.edit("/r/main.go", agent="a1"))
        (self.subagents / "agent-a1.jsonl").write_text(json.dumps(tool_use("Skill", skill="lang-go")) + "\n")
        self.assertSilent(self.edit("/r/main.go", agent="a1"))

    def test_a_transcript_it_cannot_read_lets_the_edit_through_and_is_logged(self):
        self.assertSilent(self.edit("/r/main.go", agent="no-such-agent"))
        self.assertIn("lang_skill", self.log())
        payload = {"session_id": "s", "cwd": str(self.repo), "tool_name": "Edit", "tool_input": {"file_path": "/r/a.go"}}
        self.assertSilent(self.hook("PreToolUse", payload))


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
                    self.assertLessEqual(h.get("timeout", 60), 30 if group.get("matcher") == "*" else 10)
                    self.assertFalse(h.get("async", False), event)
        self.assertEqual(config["hooks"]["SessionStart"][0]["matcher"], "startup|resume|clear|compact")
        self.assertEqual([g["matcher"] for g in config["hooks"]["PreToolUse"]], ["*"])
        self.assertEqual([h.get("onFailure") for g in config["hooks"]["PreToolUse"] for h in g["hooks"]], ["block"])
        self.assertTrue(os.access(HOOK, os.X_OK))
        self.assertTrue(os.access(MEMO, os.X_OK))
        self.assertEqual((ROOT / "bin" / "memo").resolve(), MEMO.resolve())


class LatencyTest(HookCase):
    def test_hooks_stay_fast(self):
        for n in range(40):
            self.memo("note", f"latency fact {n}")
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
        return root

    def wake(self, root):
        self.memo("note", "the launcher ran it")
        return subprocess.run([str(root / "hooks" / "tstack-hook"), "SessionStart"], capture_output=True, text=True,
                              input=json.dumps(self.base("SessionStart", source="startup")), env=self.env, timeout=30)

    def test_the_bytecode_is_kept_next_to_the_code(self):
        root = self.plugin()
        self.assertIn("the launcher ran it", self.wake(root).stdout)
        self.assertEqual(sorted(p.name.split(".")[0] for p in (root / "hooks" / "__pycache__").iterdir()), ["tstack-hook"])

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
