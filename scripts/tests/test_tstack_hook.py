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

    def watch(self, fleet=None, role="coordinator", pid_file=True):
        """A process whose command line is a chat watch's (`... chat DIR watch --as ROLE ...`)."""
        fleet = fleet or self.fleet
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "chat", str(fleet), "watch",
                                 "--as", role, "--all", "--resume", "--once"])
        self.addCleanup(lambda: (proc.kill(), proc.wait()))
        if pid_file:
            (self.fleet / f"watch-{role}.pid").write_text(str(proc.pid))
        return proc


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
                    self.assertLessEqual(h.get("timeout", 60), 10)
                    # what nobody reads runs in the background: a tool call never waits on a heartbeat
                    self.assertEqual(h.get("async", False), event in HEARTBEAT_ONLY, event)
        self.assertEqual(config["hooks"]["SessionStart"][0]["matcher"], "startup|resume|clear|compact")
        for event in (*HEARTBEAT_ONLY, "PostToolUse"):
            self.assertNotIn("matcher", config["hooks"][event][0])  # every tool
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
