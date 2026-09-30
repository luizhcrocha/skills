"""Tests for scripts/jj-hunk-pick, the non-interactive diff editor behind the
janitor's hunk-level splits: the editor on plain directories, then through jj.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PICK = ROOT / "scripts" / "jj-hunk-pick"
HAVE_JJ = shutil.which("jj") is not None
ENV = {**os.environ, "JJ_EDITOR": "true", "EDITOR": "true", "JJ_USER": "Test", "JJ_EMAIL": "test@example.com",
       "JJ_CONFIG": ""}

sys.dont_write_bytecode = True
_loader = SourceFileLoader("jj_hunk_pick", str(PICK))
hp = module_from_spec(spec_from_loader("jj_hunk_pick", _loader))
_loader.exec_module(hp)

BEFORE = "".join(f"line {i}\n" for i in range(1, 21))
AFTER = BEFORE.replace("line 3\n", "line three\n").replace("line 17\n", "line 17\nline 17b\n")


class EditorTest(unittest.TestCase):
    """The editor alone: jj's two directories, $right rewritten in place."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.left, self.right = Path(tmp.name) / "left", Path(tmp.name) / "right"
        self.left.mkdir()
        self.right.mkdir()
        (self.left / "f.txt").write_text(BEFORE)
        (self.right / "f.txt").write_text(AFTER)
        (self.left / "gone.txt").write_text("bye\n")
        (self.right / "new.txt").write_text("hello\n")
        (self.right / "JJ-INSTRUCTIONS").write_text("ignored\n")

    def edit(self, *picks):
        hp.edit(self.left, self.right, hp.parse_picks(picks))
        return {p: (self.right / p).read_text() for p in hp.tree(self.right)}

    def test_one_hunk_of_two(self):
        self.assertEqual(self.edit("f.txt:1"), {"f.txt": BEFORE.replace("line 3\n", "line three\n"),
                                                "gone.txt": "bye\n"})

    def test_the_other_hunk_by_line_range(self):
        out = self.edit("f.txt@18-18")
        self.assertEqual(out["f.txt"], BEFORE.replace("line 17\n", "line 17\nline 17b\n"))

    def test_whole_files_added_and_deleted(self):
        self.assertEqual(self.edit("f.txt", "new.txt", "gone.txt"), {"f.txt": AFTER, "new.txt": "hello\n"})

    def test_an_unpicked_file_goes_back_to_the_left(self):
        self.assertEqual(self.edit("new.txt"), {"f.txt": BEFORE, "gone.txt": "bye\n", "new.txt": "hello\n"})

    def test_bad_picks_fail_before_writing(self):
        for picks, text in ((["f.txt:3"], "no hunk 3"), (["nope.txt"], "not in this diff"),
                            (["new.txt:1"], "pick the whole file"), (["f.txt@40-50"], "no hunk touches"),
                            (["f.txt@9-2"], "backwards")):
            with self.assertRaises(hp.PickError) as caught:
                self.edit(*picks)
            self.assertIn(text, str(caught.exception))

    def test_a_pure_deletion_touches_the_lines_around_it(self):
        (self.right / "f.txt").write_text(BEFORE.replace("line 10\n", ""))
        self.assertEqual(self.edit("f.txt@10-10")["f.txt"], BEFORE.replace("line 10\n", ""))

    def test_the_mode_survives(self):
        os.chmod(self.right / "f.txt", 0o755)
        self.edit("f.txt:2")
        self.assertTrue(os.access(self.right / "f.txt", os.X_OK))


def jj(repo, *args):
    r = subprocess.run(["jj", "--no-pager", "--color=never", *args], cwd=repo, env=ENV, capture_output=True,
                       text=True)
    if r.returncode != 0:
        raise AssertionError(f"jj {' '.join(args)}: {r.stderr}")
    return r.stdout


@unittest.skipUnless(HAVE_JJ, "jj is not installed")
class ThroughJJTest(unittest.TestCase):
    """jj calls the editor: split and squash keep exactly the picked hunks."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name) / "repo"
        self.repo.mkdir()
        jj(self.repo, "git", "init", "--colocate")
        (self.repo / "f.txt").write_text(BEFORE)
        jj(self.repo, "commit", "-m", "base")
        (self.repo / "f.txt").write_text(AFTER)
        (self.repo / "other.txt").write_text("other\n")
        self.tree = jj(self.repo, "log", "--no-graph", "-r", "@", "-T", "commit_id").strip()

    def pick(self, *args):
        return subprocess.run([sys.executable, str(PICK), "-R", str(self.repo), *args], env=ENV,
                              capture_output=True, text=True)

    def test_list_numbers_the_hunks(self):
        r = self.pick("list")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("f.txt  (2 hunks)", r.stdout)
        self.assertIn("f.txt:1  -3,1 +3,1", r.stdout)
        self.assertIn("f.txt:2  -18,0 +18,1", r.stdout)
        self.assertIn("other.txt  (added: one hunk", r.stdout)

    def test_split_keeps_the_picked_hunk_below_and_the_tree_whole(self):
        r = self.pick("split", "-m", "fix: three", "f.txt:1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(jj(self.repo, "log", "--no-graph", "-r", "@-", "-T", "description").strip(), "fix: three")
        self.assertEqual(jj(self.repo, "file", "show", "-r", "@-", "f.txt"),
                         BEFORE.replace("line 3\n", "line three\n"))
        self.assertEqual(jj(self.repo, "diff", "--name-only", "-r", "@-").split(), ["f.txt"])
        self.assertEqual(jj(self.repo, "diff", "--name-only", "-r", "@").split(), ["f.txt", "other.txt"])
        self.assertEqual(jj(self.repo, "diff", "--from", self.tree, "--to", "@"), "")

    def test_squash_moves_only_the_picked_hunk(self):
        jj(self.repo, "new", "-m", "top")
        r = self.pick("squash", "--from", "@-", "--into", "@", "f.txt@18-18")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("line 17b", jj(self.repo, "diff", "--git", "-r", "@"))
        self.assertNotIn("line 17b", jj(self.repo, "diff", "--git", "-r", "@-"))
        self.assertIn("line three", jj(self.repo, "diff", "--git", "-r", "@-"))

    def test_a_bad_pick_leaves_the_repo_alone(self):
        ops = jj(self.repo, "op", "log", "--no-graph", "-T", 'id ++ "\\n"').split()
        for picks in (["f.txt:9"], ["missing.txt"]):
            r = self.pick("split", "-m", "x", *picks)
            self.assertNotEqual(r.returncode, 0)
        self.assertEqual(jj(self.repo, "op", "log", "--no-graph", "-T", 'id ++ "\\n"').split()[0], ops[0])

    def test_the_bin_link(self):
        self.assertEqual((ROOT / "bin" / "jj-hunk-pick").resolve(), PICK.resolve())
        self.assertTrue(os.access(PICK, os.X_OK))


if __name__ == "__main__":
    unittest.main()
