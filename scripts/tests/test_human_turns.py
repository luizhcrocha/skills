"""automate-me's human-turns keeps the user's own words and drops harness noise."""

import importlib.machinery
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "skills/productivity/automate-me/scripts/human-turns"
_loader = importlib.machinery.SourceFileLoader("human_turns", str(SCRIPT))
_spec = importlib.util.spec_from_loader("human_turns", _loader)
ht = importlib.util.module_from_spec(_spec)
_loader.exec_module(ht)


def user(text, **extra):
    return {"type": "user", "sessionId": "s1", "timestamp": "2026-09-20T10:00:00Z", "cwd": "/r",
            "entrypoint": "cli", "message": {"role": "user", "content": text}, **extra}


def assistant(text):
    return {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


class HumanTurns(unittest.TestCase):
    def run_on(self, rows, *args):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            d = root / ht.slug("/r/proj")
            d.mkdir(parents=True)
            (d / "s1.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
            dirs = ht.project_dirs(["/r/proj"], False, root)
            return [t for p in ht.transcripts(dirs, False) for t in ht.turns(p, *args)]

    def test_keeps_typed_turns_with_the_reply_they_answer(self):
        out = self.run_on([assistant("I used git commit."), user("no, use jj describe")])
        self.assertEqual([(t["text"], t["prev"]) for t in out], [("no, use jj describe", "I used git commit.")])

    def test_drops_harness_noise(self):
        out = self.run_on([
            user("<system-reminder>x</system-reminder>real words"),
            user([{"type": "tool_result", "content": "ok"}]),
            user("meta", isMeta=True),
            user("summary", isCompactSummary=True),
            user("peer says hi", promptSource="system"),
            user("scripted", entrypoint="sdk-cli"),
            user("<local-command-stdout>ok</local-command-stdout>"),
        ])
        self.assertEqual([t["text"] for t in out], ["real words"])

    def test_command_turn_keeps_name_and_args(self):
        out = self.run_on([user("<command-name>/tuca-mode</command-name><command-args>fix it</command-args>")])
        self.assertEqual(out[0]["text"], "/tuca-mode fix it")

    def test_since_is_inclusive(self):
        out = self.run_on([user("old", timestamp="2026-09-01T00:00:00Z"), user("new")], "2026-09-20")
        self.assertEqual([t["text"] for t in out], ["new"])

    def test_slug_matches_claude_code(self):
        self.assertEqual(ht.slug("/home/u/.claude-mem/x"), "-home-u--claude-mem-x")


if __name__ == "__main__":
    unittest.main()
