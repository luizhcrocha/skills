"""Tests for recall's sessions.py against a throwaway Claude Code projects folder.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "skills" / "productivity" / "recall" / "scripts" / "sessions.py"

sys.dont_write_bytecode = True
_loader = SourceFileLoader("recall_sessions", str(SCRIPT))
rs = module_from_spec(spec_from_loader("recall_sessions", _loader))
_loader.exec_module(rs)


def record(kind, content=None, **extra):
    r = {"type": kind, "timestamp": "2026-09-30T10:00:00.000Z", "sessionId": "s", **extra}
    if content is not None:
        r["message"] = {"role": kind, "content": content}
    return r


def write(path, records, age_days=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records))
    t = time.time() - age_days * 86400
    os.utime(path, (t, t))
    return path


SESSION = [
    {"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-09-30T10:00:00.000Z"},
    record("user", "<local-command-caveat>Caveat</local-command-caveat>", isMeta=True, entrypoint="cli"),
    record("user", "<command-name>/tstack:recall</command-name>\n<command-message>recall</command-message>\n"
                   "<command-args>catch me up</command-args>", entrypoint="cli"),
    record("assistant", [{"type": "text", "text": "Reading the sessions."},
                         {"type": "tool_use", "id": "t1", "name": "Bash",
                          "input": {"command": "jj log", "description": "Show the log"}}]),
    record("user", [{"type": "tool_result", "tool_use_id": "t1", "content": "SECRET OUTPUT"}]),
    record("user", [{"type": "tool_result", "tool_use_id": "t2", "is_error": True, "content": "Exit code 1 boom"}]),
    record("user", "<task-notification><summary>Agent \"Mine batch 1\" finished</summary></task-notification>"),
    record("user", "fix the hook next"),
    {"type": "ai-title", "aiTitle": "Recall catch-up", "sessionId": "s"},
    {"type": "system", "subtype": "away_summary", "content": "Built the hook.", "timestamp": "2026-09-30T11:00:00Z"},
]


class Slug(unittest.TestCase):
    def test_every_non_alphanumeric_becomes_a_dash(self):
        self.assertEqual(rs.slug("/home/u/repos/a.b/skills-x"), "-home-u-repos-a-b-skills-x")
        self.assertEqual(rs.slug("/home/u/.config/jj"), "-home-u--config-jj")


class Sessions(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.base = self.tmp / "projects"
        self.repo = "/work/skills"
        self.ws = "/work/skills-lane"
        proj = self.base / rs.slug(self.repo)
        write(proj / "aaa.jsonl", SESSION, age_days=1)
        (proj / "aaa" / "subagents").mkdir(parents=True)
        write(proj / "aaa" / "subagents" / "agent-x.jsonl", SESSION)
        write(proj / "old.jsonl", SESSION, age_days=10)
        write(proj / "me.jsonl", SESSION)
        write(self.base / rs.slug(self.ws) / "bbb.jsonl",
              [record("user", "hello", entrypoint="sdk-cli")], age_days=0.5)
        write(self.base / rs.slug("/work/other") / "ccc.jsonl", SESSION)

    def test_lists_this_projects_workspaces_in_the_window_newest_first(self):
        rows = rs.sessions([self.repo, self.ws], days=7, exclude={"me"}, base=self.base)
        self.assertEqual([r["id"] for r in rows], ["bbb", "aaa"])

    def test_summary_fields(self):
        row = rs.summarize(self.base / rs.slug(self.repo) / "aaa.jsonl")
        self.assertEqual(row["kind"], "cli")
        self.assertEqual(row["title"], "Recall catch-up")
        self.assertEqual(row["first"], "/tstack:recall catch me up")
        self.assertEqual(row["prompts"], 3)
        self.assertEqual(row["subagents"], 1)
        bbb = rs.summarize(self.base / rs.slug(self.ws) / "bbb.jsonl")
        self.assertEqual(bbb["kind"], "headless")

    def test_digest_keeps_the_story_and_drops_tool_output(self):
        lines = list(rs.digest(self.base / rs.slug(self.repo) / "aaa.jsonl"))
        text = "\n".join(lines)
        self.assertIn("USER: /tstack:recall catch me up", text)
        self.assertIn("ASSISTANT: Reading the sessions.", text)
        self.assertIn("TOOL Bash: Show the log", text)
        self.assertIn("ERROR: Exit code 1 boom", text)
        self.assertIn('AGENT DONE: Agent "Mine batch 1" finished', text)
        self.assertIn("USER: fix the hook next", text)
        self.assertIn("AWAY SUMMARY: Built the hook.", text)
        self.assertNotIn("SECRET OUTPUT", text)
        self.assertNotIn("Caveat", text)

    def test_path_prefers_this_project_then_the_exact_id(self):
        self.assertEqual(rs.transcript_path("aaa", [self.repo], base=self.base),
                         self.base / rs.slug(self.repo) / "aaa.jsonl")
        self.assertEqual(rs.transcript_path("ccc", [self.repo], base=self.base),
                         self.base / rs.slug("/work/other") / "ccc.jsonl")
        self.assertIsNone(rs.transcript_path("zzz", [self.repo], base=self.base))

    def test_cli_list_outside_a_repo_uses_the_directory(self):
        cwd = self.tmp / "plain"
        cwd.mkdir()
        write(self.base / rs.slug(cwd.resolve()) / "ddd.jsonl", SESSION)
        env = {**os.environ, "CLAUDE_CONFIG_DIR": str(self.tmp)}
        out = subprocess.run([sys.executable, str(SCRIPT), "list", "--cwd", str(cwd)],
                             capture_output=True, text=True, env=env, cwd=cwd, check=True).stdout
        rows = [l.split("\t")[0] for l in out.splitlines()[2:]]
        self.assertEqual(rows, ["ddd"])


if __name__ == "__main__":
    unittest.main()
