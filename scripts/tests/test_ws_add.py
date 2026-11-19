"""ws-add puts every workspace of a repo in <repos>/.ws/<repo>/<slug>, from the main workspace or a secondary one."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "ws-add"
ENV = {**os.environ, "JJ_USER": "Test", "JJ_EMAIL": "test@example.com", "JJ_CONFIG": ""}


@unittest.skipUnless(shutil.which("jj"), "jj not installed")
class WsAdd(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        subprocess.run(["jj", "git", "init"], cwd=self.repo, env=ENV, check=True, capture_output=True)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def ws_add(self, *args, cwd):
        r = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=cwd, env=ENV, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return Path(r.stdout.strip())

    def test_a_workspace_lands_under_the_hidden_folder_beside_the_repo(self):
        path = self.ws_add("lane", "-r", "@", cwd=self.repo)
        self.assertEqual(path, self.tmp.resolve() / ".ws" / "repo" / "lane")
        self.assertTrue((path / ".jj").is_dir())
        listed = subprocess.run(["jj", "workspace", "list"], cwd=self.repo, env=ENV, capture_output=True, text=True).stdout
        self.assertIn("lane:", listed)

    def test_from_a_secondary_workspace_the_repo_is_still_the_main_one(self):
        first = self.ws_add("one", cwd=self.repo)
        self.assertEqual(self.ws_add("--path", "two", cwd=first), self.tmp.resolve() / ".ws" / "repo" / "two")

    def test_path_only_creates_nothing(self):
        path = self.ws_add("--path", "later", cwd=self.repo)
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
