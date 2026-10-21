"""The memo recall eval's scoring logic, on invented rows and notes.

Run: uv run --no-project python -m unittest discover -s scripts/tests -p test_memo_eval.py
"""

import sys
import unittest
from pathlib import Path
from typing import ClassVar

sys.path.insert(0, str(Path(__file__).resolve().parent))

from memo_eval import Run, cohen_kappa, parse_recall, percentile, score, ulid_ms  # noqa: E402 - importable only after the path insert above

# Invented note ids, each encoding a known instant (UTC).
A = "01M3VNBWG0AAAAAAAAAAAAAAAA"  # 2026-10-01T12:00:00Z = 1790856000000 ms
B = "01M45JY7T0BBBBBBBBBBBBBBBB"  # 2026-10-05T08:30:00Z = 1791189000000 ms
C = "01M4HHQZ0RCCCCCCCCCCCCCCCC"  # 2026-10-09T23:59:59Z = 1791590399000 ms
D = "01M5CC1T80DDDDDDDDDDDDDDDD"  # 2026-10-20T10:00:00Z, after every row's start below
E = "01M45JY7T0EEEEEEEEEEEEEEEE"  # same instant as B, in no pool

START = 1791590400000  # 2026-10-10T00:00:00Z, the rows' start: C is one second before it


def line(ulid, text="an invented note"):
    return f"{ulid} 2026-10-01 [gotcha] project:acme/widgets: {text}"


def hits(*ids):
    return "\n".join(line(i) for i in ids) + "\n"


def row(rid, pool, useful):
    return {"id": rid, "start_ms": START, "pool": list(pool), "useful": list(useful)}


class UlidTime(unittest.TestCase):
    def test_reads_the_instant_a_ulid_carries(self):
        self.assertEqual(ulid_ms(A), 1790856000000)
        self.assertEqual(ulid_ms(C), 1791590399000)

    def test_refuses_a_string_that_is_not_a_ulid(self):
        with self.assertRaises(ValueError):
            ulid_ms("01M3VNBWG0OOOOOOOOOOOOOOOO")


class ParseRecall(unittest.TestCase):
    def test_hits_in_the_order_printed(self):
        self.assertEqual(parse_recall(hits(B, A, C)), [B, A, C])

    def test_summary_and_flagged_lines_are_hits(self):
        out = (
            f"{A} 2026-10-01 [summary L1] project:acme/widgets: a summary\n"
            f"{B} 2026-10-05 [decision] project:acme/widgets: a note (pinned; in summary {A})\n"
        )
        self.assertEqual(parse_recall(out), [A, B])

    def test_nothing_fits_is_an_abstention(self):
        self.assertEqual(parse_recall("memo: nothing fits\n"), [])

    def test_masters_nothing_on_is_an_abstention(self):
        self.assertEqual(parse_recall("memo: nothing on 'widget frobs'\n"), [])

    def test_empty_output_is_an_abstention(self):
        self.assertEqual(parse_recall(""), [])

    def test_output_it_cannot_read_is_an_error_not_an_abstention(self):
        with self.assertRaises(ValueError):
            parse_recall('Traceback (most recent call last):\n  File "memo", line 1\n')


class Score(unittest.TestCase):
    gold: ClassVar[list[dict]] = [
        row("u1", pool=[A, B, C], useful=[A]),
        row("u2", pool=[A, B], useful=[B]),
        row("n1", pool=[A, C], useful=[]),
        row("n2", pool=[A, C], useful=[]),
    ]

    def runs(self):
        return {
            "u1": Run(hits(A, B, D), 0.10),  # D is after the start: neither hit nor miss
            "u2": Run("memo: nothing fits\n", 0.20),
            "n1": Run("memo: nothing fits\n", 0.30),
            "n2": Run(hits(C, E), 2.00),  # E is in no pool: unjudged, counted not useful
        }

    def test_precision_at_3_over_rows_with_a_useful_note(self):
        r = score(self.gold, self.runs())
        # u1: 1 useful of 2 slots left once D is cut = 0.5; u2 abstained = 0. Mean 0.25.
        self.assertAlmostEqual(r["p_at_3"], 0.25)
        self.assertEqual(r["answer_rows"], 2)

    def test_abstention_rates(self):
        r = score(self.gold, self.runs())
        self.assertAlmostEqual(r["correct_abstain"], 0.5)  # n1 of n1, n2
        self.assertAlmostEqual(r["false_abstain"], 0.5)  # u2 of u1, u2
        self.assertEqual(r["no_answer_rows"], 2)

    def test_counts_cut_and_unjudged_hits(self):
        r = score(self.gold, self.runs())
        self.assertEqual(r["future_hits_cut"], 1)
        self.assertEqual(r["unjudged_hits"], 1)

    def test_latency(self):
        r = score(self.gold, self.runs())
        self.assertAlmostEqual(r["max_s"], 2.0)
        self.assertAlmostEqual(r["p95_s"], 2.0)

    def test_a_row_whose_every_hit_is_cut_is_left_out_of_every_rate(self):
        gold = [
            row("u1", pool=[A], useful=[A]),
            row("u3", pool=[A], useful=[A]),
            row("n1", pool=[A], useful=[]),
            row("n3", pool=[A], useful=[]),
        ]
        runs = {
            "u1": Run(hits(A), 0.1),
            "u3": Run(hits(D), 0.1),
            "n1": Run("memo: nothing fits\n", 0.1),
            "n3": Run(hits(D), 0.1),
        }
        r = score(gold, runs)
        self.assertAlmostEqual(r["p_at_3"], 1 / 3)  # u1 alone: 1 useful in 3 slots
        self.assertAlmostEqual(r["false_abstain"], 0.0)  # u1 alone
        self.assertAlmostEqual(r["correct_abstain"], 1.0)  # n1 alone: n3 neither abstained nor answered
        self.assertEqual((r["answer_rows"], r["no_answer_rows"]), (1, 1))
        self.assertEqual(r["rows_all_cut"], 2)

    def test_only_the_first_three_hits_count(self):
        gold = [row("u1", pool=[A, B, C, E], useful=[E])]
        r = score(gold, {"u1": Run(hits(A, B, C, E), 0.1)})
        self.assertAlmostEqual(r["p_at_3"], 0.0)

    def test_a_row_with_no_run_is_an_error(self):
        with self.assertRaises(KeyError):
            score(self.gold, {"u1": Run(hits(A), 0.1)})


class Percentile(unittest.TestCase):
    def test_nearest_rank(self):
        values = [float(v) for v in range(20, 0, -1)]
        self.assertEqual(percentile(values, 95), 19.0)
        self.assertEqual(percentile(values, 100), 20.0)
        self.assertEqual(percentile([0.4], 95), 0.4)


class Kappa(unittest.TestCase):
    def test_worked_example(self):
        a = ["U", "U", "N", "N", "N", "N", "N", "N", "N", "N"]
        b = ["U", "N", "N", "N", "N", "N", "N", "N", "N", "U"]
        # observed 0.8; chance 0.2*0.2 + 0.8*0.8 = 0.68; (0.8-0.68)/(1-0.68) = 0.375
        self.assertAlmostEqual(cohen_kappa(a, b), 0.375)

    def test_total_disagreement_on_balanced_labels(self):
        self.assertAlmostEqual(cohen_kappa(["U", "N"], ["N", "U"]), -1.0)

    def test_lists_of_different_length_are_refused(self):
        with self.assertRaises(ValueError):
            cohen_kappa(["U"], ["U", "N"])


if __name__ == "__main__":
    unittest.main()
