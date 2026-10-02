"""Tests for scripts/gates' scope table: which suites a changed path runs.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import sys
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

sys.dont_write_bytecode = True
_loader = SourceFileLoader("gates", str(ROOT / "scripts" / "gates"))
gates = module_from_spec(spec_from_loader("gates", _loader))
_loader.exec_module(gates)


def suites(*paths):
    return list(gates.choose(list(paths)))


class Scope(unittest.TestCase):
    def test_fleet_source_runs_the_ts_fleet_and_the_oracle(self):
        self.assertEqual(suites("fleet/src/ledger/state.ts"), ["test-fleet-ts", "test-fleet"])

    def test_page_source_runs_the_page_suites_alone(self):
        self.assertEqual(suites("fleet/page/src/app.tsx", "skills/productivity/coordinator/assets/dashboard.html"),
                         ["test-page", "test-fleet", "test-coordinator-page"])

    def test_python_fleet_runs_its_tests_and_the_oracle(self):
        self.assertEqual(suites("skills/productivity/coordinator/scripts/state.py"), ["test-coordinator", "test-fleet"])

    def test_coordinator_suite_absorbs_page_mjs(self):
        self.assertEqual(suites("fleet/page/src/app.tsx", "skills/productivity/coordinator/tests/test_state.py"),
                         ["test-page", "test-coordinator"])

    def test_lint_runs_every_ts_suite(self):
        self.assertEqual(suites("lint/ts/tstack/rules/x.ts"), ["test-fleet-ts", "test-page", "test-scripts", "test-lint-ts"])

    def test_scripts_run_test_scripts(self):
        self.assertEqual(suites("scripts/land-check", "scripts/tests/test_gates.py"), ["test-scripts"])

    def test_prose_runs_validate_alone(self):
        self.assertEqual(suites("README.md", "fleet/SPEC.md", "docs/tstack-plan.md"), ["validate"])

    def test_skill_markdown_runs_the_link_and_sources_checks(self):
        self.assertEqual(suites("skills/engineering/lang-ts/SKILL.md"), ["test-scripts", "validate"])

    def test_worker_brief_template_runs_both_fleets(self):
        self.assertEqual(suites("skills/productivity/coordinator/assets/brief.md"),
                         ["test-fleet-ts", "test-coordinator", "test-fleet"])

    def test_unmatched_runs_everything(self):
        self.assertEqual(suites("justfile"), list(gates.EVERYTHING))
        self.assertEqual(suites("README.md", "upstreams.toml"), list(gates.EVERYTHING))

    def test_every_reason_names_its_path(self):
        why = gates.choose(["fleet/src/a.ts", "justfile"])
        self.assertTrue(all(any(r.startswith("fleet/src/a.ts") for r in why[s]) for s in ("test-fleet-ts", "test-fleet")))
        self.assertTrue(any("no pattern matches" in r for r in why["test-page"]))

    def test_full_gate_is_every_suite_once(self):
        self.assertEqual(sorted(gates.FULL), sorted(set(gates.SUITES) - {"test-coordinator-page", "validate"}))


if __name__ == "__main__":
    unittest.main()
