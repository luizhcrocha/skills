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
        self.assertEqual(config["hooks"]["SessionStart"][0]["matcher"], "startup|resume|clear|compact")
        self.assertTrue(os.access(HOOK, os.X_OK))
        self.assertTrue(os.access(MEMO, os.X_OK))
        self.assertEqual((ROOT / "bin" / "memo").resolve(), MEMO.resolve())


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
