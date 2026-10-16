"""fleet/bin/fleet-run: the shim that runs the fleet repo's client (apps/client/fleet-run.ts) on Node."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SHIM = ROOT / "fleet" / "bin" / "fleet-run"
DOWN = "fleet-run: fleet-host is not running on this machine"

# A stand-in for the client: what it was given (its arguments, stdin, the session) on stdout, and the exit code a
# program's status sets ($CLIENT_EXIT).
CLIENT = """import { readFileSync } from "node:fs";
const program: string = readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), program, from: process.env["FLEET_SESSION"] ?? null }));
process.exitCode = Number(process.env["CLIENT_EXIT"] ?? 0);
"""


class FleetRunShimTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.env = {"HOME": str(self.home), "PATH": os.environ.get("PATH", "")}

    def client(self, repo):
        folder = repo / "apps" / "client"
        folder.mkdir(parents=True)
        (folder / "package.json").write_text(json.dumps({"type": "module"}))
        (folder / "fleet-run.ts").write_text(CLIENT)
        return folder / "fleet-run.ts"

    def run_shim(self, *args, stdin="", env=None):
        return subprocess.run([str(SHIM), *args], input=stdin, capture_output=True, text=True,
                              env={**self.env, **(env or {})}, timeout=60)

    def test_runs_the_client_in_fleet_repo_with_the_program_and_its_exit(self):
        repo = self.tmp / "fleet"
        self.client(repo)
        done = self.run_shim("--status", stdin="return 1;\n",
                             env={"FLEET_REPO": str(repo), "FLEET_SESSION": "sess-1", "CLIENT_EXIT": "3"})
        self.assertEqual(done.returncode, 3, done.stderr)
        self.assertEqual(json.loads(done.stdout), {"args": ["--status"], "program": "return 1;\n", "from": "sess-1"})

    def test_the_checkout_defaults_to_the_one_on_this_machine(self):
        self.client(self.home / "repos" / "luizhcrocha" / "fleet-live")
        done = self.run_shim(stdin="return 2;\n")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)["program"], "return 2;\n")

    def test_a_pinned_client_wins_over_the_checkout(self):
        """M4: a host whose install ships the client names it in FLEET_RUN_CLIENT; the checkout is the fallback."""
        pinned = self.client(self.tmp / "installed")
        (self.tmp / "checkout").mkdir()
        done = self.run_shim(stdin="return 3;\n", env={"FLEET_RUN_CLIENT": str(pinned), "FLEET_REPO": str(self.tmp / "checkout")})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)["program"], "return 3;\n")
        missing = self.run_shim(stdin="return 3;\n", env={"FLEET_RUN_CLIENT": str(self.tmp / "gone.ts")})
        self.assertEqual(missing.returncode, 4)
        self.assertIn("FLEET_RUN_CLIENT", missing.stderr)

    def test_a_relative_pinned_client_is_refused(self):
        """M4: the hook runs the shim from the dashboard folder, where a relative FLEET_RUN_CLIENT names another file;
        it is refused as a usage error even where the path resolves."""
        self.client(self.tmp / "installed")
        done = subprocess.run([str(SHIM)], input="return 3;\n", capture_output=True, text=True, cwd=self.tmp,
                              env={**self.env, "FLEET_RUN_CLIENT": "installed/apps/client/fleet-run.ts"}, timeout=60)
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertEqual(done.stdout, "")
        self.assertIn("FLEET_RUN_CLIENT", done.stderr)
        self.assertIn("absolute", done.stderr)

    def test_a_missing_client_is_the_service_down(self):
        done = self.run_shim(stdin="return 1;\n", env={"FLEET_REPO": str(self.tmp / "nowhere")})
        self.assertEqual(done.returncode, 4)
        self.assertEqual(done.stdout, "")
        first, second = done.stderr.splitlines()
        self.assertEqual(first, DOWN)
        self.assertIn(str(self.tmp / "nowhere" / "apps" / "client" / "fleet-run.ts"), second)
        self.assertIn("FLEET_REPO", second)

    def test_no_node_on_path_says_so(self):
        repo = self.tmp / "fleet"
        self.client(repo)
        empty = self.tmp / "empty"
        empty.mkdir()
        done = self.run_shim(stdin="return 1;\n", env={"FLEET_REPO": str(repo), "PATH": str(empty)})
        self.assertEqual(done.returncode, 127)
        self.assertIn("Node 24", done.stderr)


if __name__ == "__main__":
    unittest.main()
