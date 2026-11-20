"""architect's eval-round stages blind A/B pairs and keeps a change only when it wins."""

import importlib.machinery
import importlib.util
import json
import random
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "evals/architect/eval-round"
_loader = importlib.machinery.SourceFileLoader("eval_round", str(SCRIPT))
_spec = importlib.util.spec_from_loader("eval_round", _loader)
er = importlib.util.module_from_spec(_spec)
_loader.exec_module(er)


class EvalRound(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.round = Path(self.tmp.name) / "round"
        self.round.mkdir()
        (self.round / "round.json").write_text(json.dumps({"tasks": ["a", "b", "c"], "constraint": None}))
        (self.round / "tasks").mkdir()
        for t in ("a", "b", "c"):
            (self.round / "tasks" / f"{t}.md").write_text("Design it.\n")
            for arm in er.ARMS:
                d = self.round / "sketches" / f"{arm}-{t}"
                d.mkdir(parents=True)
                (d / "design.md").write_text(f"{arm} design\n")

    def tearDown(self):
        self.tmp.cleanup()

    def judge(self, scores):
        """scores: task -> (cand, base) given to each arm in every order."""
        for t, (cand, base) in scores.items():
            sides = json.loads((self.round / "judge" / t / "sides.json").read_text())
            for order, side in sides.items():
                a, b = (cand if side[x] == "cand" else base for x in "AB")
                pick = "A" if a >= b else "B"
                (self.round / "judge" / t / order / "judgement.md").write_text(f"OVERALL A={a} B={b} PICK={pick}\nwhy\n")

    def test_pair_puts_each_arm_on_both_sides_and_hides_names_from_the_judge(self):
        briefs = er.pair(self.round, random.Random(1))
        self.assertEqual(len(briefs), 6)
        sides = json.loads((self.round / "judge" / "a" / "sides.json").read_text())
        self.assertEqual(sides["order-1"]["A"], sides["order-2"]["B"])
        self.assertEqual((self.round / "judge" / "a" / "order-1" / "A" / "design.md").read_text(),
                         f"{sides['order-1']['A']} design\n")
        brief = briefs[0].read_text()
        self.assertNotIn("cand", brief)
        self.assertNotIn("base", brief)

    def test_a_change_that_wins_most_tasks_with_a_higher_total_is_kept(self):
        er.pair(self.round, random.Random(2))
        self.judge({"a": (8, 6), "b": (8, 7), "c": (6, 7)})
        rows, code = er.score(self.round)
        self.assertEqual(code, 0)
        self.assertEqual([r["winner"] for r in rows], ["cand", "cand", "base"])

    def test_winning_most_tasks_on_a_lower_total_is_not_kept(self):
        er.pair(self.round, random.Random(3))
        self.judge({"a": (7, 6), "b": (7, 6), "c": (3, 9)})
        self.assertEqual(er.score(self.round)[1], 1)

    def test_a_missing_judgement_is_incomplete(self):
        er.pair(self.round, random.Random(4))
        self.judge({"a": (8, 6), "b": (8, 6)})
        self.assertEqual(er.score(self.round)[1], 2)

    def test_stage_snapshots_both_arms_and_fills_every_brief(self):
        staged = Path(self.tmp.name) / "staged"
        cand = ROOT / "skills" / "engineering"
        briefs = er.stage(staged, "@", cand, ["config"], 2, ROOT)
        self.assertEqual(len(briefs), 2)
        for arm in er.ARMS:
            self.assertTrue((staged / "arms" / arm / "architect" / "SKILL.md").is_file())
            self.assertFalse((staged / "arms" / arm / "architect" / "evals").exists())
        self.assertIn("runner 2", briefs[0].read_text())
        self.assertIn(str(staged / "tasks" / "config.md"), briefs[0].read_text())


if __name__ == "__main__":
    unittest.main()
