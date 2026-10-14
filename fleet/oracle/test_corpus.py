"""The golden traces: every traces/*.jsonl replayed now gives the results committed beside it.

The traces are recorded from the TypeScript fleet (ADR 0003). With FLEET_ORACLE_IMPL naming it
(`just test-fleet-ts-oracle`) this is a self-diff: it proves the runner is deterministic and that the
fleet still does what the corpus recorded. Without it, it replays on the frozen Python twin and checks
that it still behaves as the TypeScript fleet did, until the twin is deleted; a trace whose header has `twin`
(why the twin differs: a behaviour TypeScript changed on purpose since, and `normalise`, what run.py's
TWIN_NORMALISERS hide on both sides) is compared on the twin with that difference hidden, and, with `until`
(a step number), only on the steps before it: from that step on the twin's ledger is another. After an intended change
of behaviour, `just record-traces fleet/oracle/traces/NAME.jsonl` records the trace again from the
TypeScript fleet; review the diff of its .expected.jsonl like code.
"""
import json
import os
import shlex
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run  # noqa: E402

TRACES = run.traces()


def impl() -> tuple[dict | None, dict | None]:
    given = os.environ.get("FLEET_ORACLE_IMPL")
    if not given:
        return None, None
    table = json.loads(given)
    return {k: shlex.split(v) for k, v in table.items() if k != "subst"}, table.get("subst") or {}


def twin_of(trace: Path) -> dict:
    """The header's `twin`: why the frozen Python twin differs on `trace` (a behaviour the TypeScript fleet changed
    on purpose after the twin froze, ADR 0003) and what is normalised away, on both sides, before a replay on the
    twin is compared. Empty when the twin must match as recorded."""
    header, _ = run.split(run.read_lines(trace))
    return header.get("twin") or {}


def replayed(trace: Path) -> str | None:
    steps = run.read_lines(trace)
    got = json.loads(json.dumps(run.replay(steps, *impl()), ensure_ascii=False))
    expected = run.read_lines(run.expected_of(trace))
    normalise = [] if impl()[0] is not None else twin_of(trace).get("normalise", [])
    until = None if impl()[0] is not None else twin_of(trace).get("until")
    if until is not None:
        expected, got = ([r for r in rs if "results" in r or r.get("step", 0) < until] for rs in (expected, got))
    found = run.divergence(run.twin_view(expected, normalise), run.twin_view(got, normalise), run.split(steps)[1], names=("expected", "got"))
    return f"{trace.name}:\n{found}" if found else None


class CorpusTest(unittest.TestCase):
    def test_every_trace_has_its_expected_results(self):
        self.assertTrue(TRACES)
        missing = [t.name for t in TRACES if not run.expected_of(t).exists()]
        self.assertFalse(missing, "record them with `just record-traces`")

    def test_every_trace_replays_to_its_expected_results(self):
        with ThreadPoolExecutor(max_workers=run.workers(len(TRACES))) as pool:
            found = [f for f in pool.map(replayed, TRACES) if f]
        self.assertFalse(found, "\n\n".join(found))

    def test_a_twin_difference_says_why_and_names_known_normalisers(self):
        for trace in TRACES:
            twin = twin_of(trace)
            if not twin:
                continue
            self.assertTrue(str(twin.get("why", "")).strip(), f"{trace.name}: `twin.why` says why the Python twin differs")
            self.assertTrue(twin.get("normalise"), f"{trace.name}: `twin.normalise` names what is hidden")
            self.assertLessEqual(set(twin["normalise"]), set(run.TWIN_NORMALISERS), f"{trace.name}: an unknown normaliser")
            until = twin.get("until")
            self.assertTrue(until is None or (isinstance(until, int) and until > 1), f"{trace.name}: `twin.until` is a step number")

    def test_hiding_numbers_keeps_every_other_difference(self):
        hide = run.TWIN_NORMALISERS["numbers"]
        self.assertEqual(hide({"D12": ["added K3", "L1 x1 AD4 D7a"]}), {"D#": ["added K#", "L# x1 AD4 D7a"]})
        self.assertNotEqual(hide({"stdout": "added K3 to infra"}), hide({"stdout": "added K3 to acme"}))


    def test_hiding_the_spawn_hint_keeps_every_other_line(self):
        hide = run.TWIN_NORMALISERS["spawn-hint"]
        said = 'recorded a1 (a1); its brief opens with: x\nSpawn with model: "opus", effort: "high" (a1\'s Agent call).\n'
        self.assertEqual(hide({"step": 3, "stdout": said, "stderr": "Spawn with model: kept\n"}),
                         {"step": 3, "stdout": "recorded a1 (a1); its brief opens with: x\n", "stderr": "Spawn with model: kept\n"})
        self.assertNotEqual(hide({"stdout": said}), hide({"stdout": said.replace("recorded a1", "recorded a2")}))
        self.assertEqual(hide({"results": 4}), {"results": 4})

    def test_every_trace_that_records_a_worker_hides_the_spawn_hint_on_the_twin(self):
        for trace in TRACES:
            said = run.expected_of(trace).read_text(encoding="utf-8")
            if "Spawn with model: " in said:
                self.assertIn("spawn-hint", twin_of(trace).get("normalise", []), trace.name)


class HermeticTest(unittest.TestCase):
    def test_a_link_on_a_listening_port_reads_up_whatever_the_host_listens_on(self):
        steps = [{"cli": "state", "argv": ["$DIR", "init", "--project", "p", "--goal", "g", "--no-render"]},
                 {"cli": "state", "argv": ["$DIR", "link", "review", "--url", f"https://box.ts.net:{run.LISTENING[0]}/", "--title", "T", "--kind", "page"]}]
        got = run.replay(steps, *impl())
        self.assertEqual(got[2]["exit"], 0, got[2])
        self.assertEqual([link["up"] for link in got[2]["changed"]["$DIR/index.html"]["state"]["links"]], [True])


if __name__ == "__main__":
    unittest.main()
