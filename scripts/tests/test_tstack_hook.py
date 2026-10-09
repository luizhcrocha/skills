"""Tests for hooks/tstack-hook, the plugin's one hook dispatcher, and hooks/hooks.json.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)

The rule under test above all: a hook never breaks a session. Whatever goes
wrong, the dispatcher exits 0 with nothing on stdout and logs to hook.log.
"""

import json
import os
import re
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
        fleet = fleet or self.fleet_cli
        self.bash(f'{fleet} chat {self.fleet} say --as {role} --re {re} "{self.LONG}"',
                  f"#{n} {role} -> user [re #{re}]: {self.LONG}\n")

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
        self.bash(f"cd /tmp && fleet chat {self.fleet} say --as manager 'short' && echo ok",
                  f"#7 manager -> user: short\nok\n")
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
        is a session's first look (no offset kept) and something is due, so the ledger is read too."""
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
        times = []
        for _ in range(100):
            state.unlink(missing_ok=True)
            hook = module.Hook("PostToolUse", payload, env)
            started = time.perf_counter()
            out = module.fleet_chat_nudge(hook)
            times.append((time.perf_counter() - started) * 1000)
            self.assertIn(f"#{n + 1} from the user", out)
        steady = []
        for _ in range(100):  # the usual run: an offset kept, a line or two new
            saved = json.loads(state.read_text())
            saved["checked"] = 0
            state.write_text(json.dumps(saved))
            self.say(n + 2, "2026-01-05T08:59:00+00:00", frm="a1", to=("coordinator",))
            hook = module.Hook("PostToolUse", payload, env)
            started = time.perf_counter()
            module.fleet_chat_nudge(hook)
            steady.append((time.perf_counter() - started) * 1000)
        print(f"\n  chat nudge on 2,000 lines: first look median {statistics.median(times):.2f} ms, "
              f"then {statistics.median(steady):.2f} ms", end="", file=sys.stderr)
        self.assertLess(statistics.median(times), 2, times[:20])
        self.assertLess(statistics.median(steady), 2, steady[:20])
        quiet = module.Hook("PostToolUse", self.base("PostToolUse"), self.env)
        started = time.perf_counter()
        for _ in range(200):
            module.fleet_chat_nudge(quiet)
        self.assertLess((time.perf_counter() - started) * 1000 / 200, 0.5)  # outside a fleet: next to nothing


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
                    # the refusal's handler starts the fleet CLI (Bun): it gets the time a start takes
                    self.assertLessEqual(h.get("timeout", 60), 30 if event == "PermissionDenied" else 10)
                    # what nobody reads runs in the background: a tool call never waits on a heartbeat
                    self.assertEqual(h.get("async", False), event in (*HEARTBEAT_ONLY, "PermissionDenied"), event)
        self.assertEqual(config["hooks"]["SessionStart"][0]["matcher"], "startup|resume|clear|compact")
        for event in (*HEARTBEAT_ONLY, "PostToolUse"):
            self.assertNotIn("matcher", config["hooks"][event][0])  # every tool
        self.assertEqual(config["hooks"]["PreToolUse"][0]["matcher"], "Agent")  # a grant's spawn alone
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
