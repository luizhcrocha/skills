"""ws-rm removes a landed workspace under <repos>/.ws/<repo>/ and refuses one that still holds work or is in use."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ADD = ROOT / "scripts" / "ws-add"
RM = ROOT / "scripts" / "ws-rm"
ENV = {**os.environ, "JJ_USER": "Test", "JJ_EMAIL": "test@example.com", "JJ_CONFIG": ""}


@unittest.skipUnless(shutil.which("jj"), "jj not installed")
class WsRm(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.jj("git", "init")
        (self.repo / "a").write_text("a\n")
        self.jj("commit", "-m", "base")
        self.jj("bookmark", "set", "master", "-r", "@-")
        self.jj("config", "set", "--repo", 'revset-aliases."trunk()"', "master")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def jj(self, *args, cwd=None):
        return subprocess.run(["jj", *args], cwd=cwd or self.repo, env=ENV, check=True, capture_output=True, text=True).stdout

    def add(self, name):
        r = subprocess.run([sys.executable, str(ADD), name, "-r", "master"], cwd=self.repo, env=ENV, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return Path(r.stdout.strip())

    def rm(self, name, cwd=None):
        return subprocess.run([sys.executable, str(RM), name], cwd=cwd or self.repo, env=ENV, capture_output=True, text=True)

    def listed(self):
        return self.jj("workspace", "list")

    def test_a_landed_workspace_is_forgotten_and_its_folder_deleted(self):
        path = self.add("lane")
        (path / "b").write_text("b\n")
        self.jj("commit", "-m", "work", cwd=path)
        self.jj("bookmark", "set", "master", "-r", "lane@-")
        r = self.rm("lane")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(path.exists())
        self.assertNotIn("lane:", self.listed())

    def test_a_copy_the_train_relanded_is_abandoned_with_its_workspace(self):
        path = self.add("lane")
        (path / "b").write_text("b\n")
        self.jj("commit", "-m", "work", cwd=path)
        original = self.jj("log", "--no-graph", "-r", "lane@-", "-T", "change_id", cwd=path)
        (self.repo / "c").write_text("c\n")
        self.jj("commit", "-m", "other")
        self.jj("bookmark", "set", "master", "-r", "@-")
        self.jj("duplicate", "lane@-", "-o", "master")
        self.jj("bookmark", "set", "master", "-r", 'children(master) & description(substring:"work")')
        r = self.rm("lane")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(path.exists())
        self.assertNotIn(original, self.jj("log", "--no-graph", "-r", "all()", "-T", 'change_id ++ "\\n"'))
        self.assertEqual(self.jj("log", "--no-graph", "-r", "heads(all()) ~ ::master ~ @", "-T", "change_id"), "")

    def test_unsnapshotted_edits_refuse(self):
        path = self.add("lane")
        (path / "b").write_text("unsaved\n")
        r = self.rm("lane")
        self.assertEqual(r.returncode, 1)
        self.assertIn("trunk() lacks", r.stderr)
        self.assertTrue((path / "b").exists())
        self.assertIn("lane:", self.listed())

    def test_an_unlanded_commit_refuses(self):
        path = self.add("lane")
        (path / "b").write_text("b\n")
        self.jj("commit", "-m", "work", cwd=path)
        r = self.rm("lane")
        self.assertEqual(r.returncode, 1)
        self.assertIn("work", r.stderr)
        self.assertTrue(path.exists())

    def test_a_process_inside_refuses(self):
        path = self.add("lane")
        sleeper = subprocess.Popen(["sleep", "30"], cwd=path)
        try:
            r = self.rm("lane")
        finally:
            sleeper.kill()
            sleeper.wait()
        self.assertEqual(r.returncode, 1)
        self.assertIn("processes work inside", r.stderr)
        self.assertTrue(path.exists())

    def test_default_and_landing_workspaces_refuse(self):
        for name in ("default", "deploy", "x-land"):
            r = self.rm(name)
            self.assertEqual(r.returncode, 1, name)
            self.assertIn("protected", r.stderr)

    def test_a_workspace_outside_the_ws_folder_refuses(self):
        outside = self.tmp / "repo-sibling"
        self.jj("workspace", "add", str(outside), "--name", "sibling", "-r", "master")
        r = self.rm("sibling")
        self.assertEqual(r.returncode, 1)
        self.assertIn("not a folder directly under", r.stderr)
        self.assertTrue(outside.exists())

    def test_a_rerun_after_the_forget_removes_the_orphan_folder(self):
        path = self.add("lane")
        self.jj("workspace", "forget", "lane")
        r = self.rm("lane")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(path.exists())
        self.assertEqual(self.rm("lane").returncode, 0)

    def test_runs_from_a_secondary_workspace(self):
        keep = self.add("keep")
        gone = self.add("gone")
        r = self.rm("gone", cwd=keep)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(gone.exists())


if __name__ == "__main__":
    unittest.main()
