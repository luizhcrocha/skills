"""The golden traces: every traces/*.jsonl replayed now gives the results committed beside it.

On the Python oracle this is a self-diff: it proves the runner is deterministic and that the
scripts still do what the corpus recorded. With FLEET_ORACLE_IMPL (as for test_model.py) it is
stage 2's differential check against the recorded Python results, no Python scripts needed.
After an intended change of behaviour, `python3 fleet/oracle/run.py record fleet/oracle/traces/NAME.jsonl`
records the trace again; review the diff of its .expected.jsonl like code.
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

TRACES = sorted(p for p in (Path(__file__).resolve().parent / "traces").glob("*.jsonl") if not p.name.endswith(".expected.jsonl"))


def impl() -> tuple[dict | None, dict | None]:
    given = os.environ.get("FLEET_ORACLE_IMPL")
    if not given:
        return None, None
    table = json.loads(given)
    return {k: shlex.split(v) for k, v in table.items() if k != "subst"}, table.get("subst") or {}


def replayed(trace: Path) -> str | None:
    steps = run.read_lines(trace)
    got = json.loads(json.dumps(run.replay(steps, *impl()), ensure_ascii=False))
    found = run.divergence(run.read_lines(run.expected_of(trace)), got, run.split(steps)[1], names=("expected", "got"))
    return f"{trace.name}:\n{found}" if found else None


class CorpusTest(unittest.TestCase):
    def test_every_trace_has_its_expected_results(self):
        self.assertTrue(TRACES)
        missing = [t.name for t in TRACES if not run.expected_of(t).exists()]
        self.assertFalse(missing, "record them with run.py record")

    def test_every_trace_replays_to_its_expected_results(self):
        with ThreadPoolExecutor(max_workers=len(TRACES)) as pool:
            found = [f for f in pool.map(replayed, TRACES) if f]
        self.assertFalse(found, "\n\n".join(found))


class HermeticTest(unittest.TestCase):
    def test_a_link_on_a_listening_port_reads_up_whatever_the_host_listens_on(self):
        steps = [{"cli": "state", "argv": ["$DIR", "init", "--project", "p", "--goal", "g", "--no-render"]},
                 {"cli": "state", "argv": ["$DIR", "link", "review", "--url", f"https://box.ts.net:{run.LISTENING[0]}/", "--title", "T", "--kind", "page"]}]
        got = run.replay(steps, *impl())
        self.assertEqual(got[2]["exit"], 0, got[2])
        self.assertEqual([link["up"] for link in got[2]["changed"]["$DIR/index.html"]["state"]["links"]], [True])


if __name__ == "__main__":
    unittest.main()
