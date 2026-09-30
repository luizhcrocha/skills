"""Tests for scripts/sync_upstream.py against throwaway git repos.

Run: mise run test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "sync_upstream.py"

BASE_SKILL = "line 1\nline 2\nline 3\nline 4\nline 5\n"


def git(cwd, *args):
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=cwd, check=True, capture_output=True, text=True,
    ).stdout.strip()


class SyncUpstreamTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.up = self.tmp / "upstream"
        self.local = self.tmp / "local"
        self.up.mkdir()
        self.local.mkdir()
        git(self.up, "init", "-q", "-b", "main")
        # Upstream keeps its plugin under pkg/, like cursor/plugins keeps pstack/.
        self.write_up("pkg/skills/tdd/SKILL.md", BASE_SKILL)
        self.write_up("pkg/skills/tdd/notes.md", "notes\n")
        self.write_up("pkg/skills/principle-a/SKILL.md", "principle a\n")
        self.write_up("pkg/skills/principle-b/SKILL.md", "principle b\n")
        self.write_up("pkg/skills/old/SKILL.md", "old\n")
        self.write_up("pkg/README.md", "readme\n")
        self.write_up("outside.md", "not in subdir\n")
        self.base = self.commit_up("base")

        # Local copy as merged from base: tdd renamed, principles bucketed.
        self.write_local("skills/eng/test-strategy/SKILL.md", BASE_SKILL)
        self.write_local("skills/eng/test-strategy/notes.md", "notes\n")
        self.write_local("skills/eng/principles/a.md", "principle a\n")
        self.write_local("skills/eng/principles/b.md", "principle b\n")
        self.manifest = self.local / "upstreams.toml"
        self.manifest.write_text(f"""\
[upstream.other]
url = "{self.up}"
base = "{self.base}"
map = []

[upstream.demo]  # the one under test
url = "{self.up}"
subdir = "pkg"
base = "{self.base}"
units = ["skills/*"]
ignore = ["README.md"]
map = [
  {{ from = "skills/tdd", to = "skills/eng/test-strategy" }},
  {{ from = "skills/principle-*/SKILL.md", to = "skills/eng/principles/{{1}}.md" }},
]
""")

    def tearDown(self):
        self._tmp.cleanup()

    def write_up(self, path, text):
        p = self.up / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def write_local(self, path, text):
        p = self.local / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def read_local(self, path):
        return (self.local / path).read_text()

    def commit_up(self, msg):
        git(self.up, "add", "-A")
        git(self.up, "commit", "-q", "-m", msg)
        return git(self.up, "rev-parse", "HEAD")

    def run_sync(self, *args):
        p = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.local), "--upstream", "demo", *args],
            capture_output=True, text=True,
        )
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

    def recorded_base(self, name="demo"):
        return tomllib.loads(self.manifest.read_text())["upstream"][name]["base"]

    def test_in_sync_changes_nothing(self):
        out = self.run_sync()
        self.assertIn("added 0, updated 0, merged 0, conflicted 0, skipped 0", out)

    def test_add_new_file_in_mapped_dir(self):
        self.write_up("pkg/skills/tdd/extra.md", "extra\n")
        self.write_up("pkg/skills/principle-c/SKILL.md", "principle c\n")
        head = self.commit_up("add")
        out = self.run_sync()
        self.assertEqual(self.read_local("skills/eng/test-strategy/extra.md"), "extra\n")
        self.assertEqual(self.read_local("skills/eng/principles/c.md"), "principle c\n")
        self.assertIn("added 2,", out)
        self.assertEqual(self.recorded_base(), head)
        self.assertEqual(self.recorded_base("other"), self.base)  # other upstreams untouched

    def test_clean_update_when_local_untouched(self):
        self.write_up("pkg/skills/principle-a/SKILL.md", "principle a v2\n")
        self.commit_up("update")
        out = self.run_sync()
        self.assertEqual(self.read_local("skills/eng/principles/a.md"), "principle a v2\n")
        self.assertIn("Updated", out)

    def test_three_way_merge_keeps_local_edit(self):
        self.write_local("skills/eng/test-strategy/SKILL.md", BASE_SKILL.replace("line 1", "local 1"))
        self.write_up("pkg/skills/tdd/SKILL.md", BASE_SKILL.replace("line 5", "upstream 5"))
        head = self.commit_up("update")
        out = self.run_sync()
        merged = self.read_local("skills/eng/test-strategy/SKILL.md")
        self.assertIn("local 1", merged)
        self.assertIn("upstream 5", merged)
        self.assertNotIn("<<<<<<<", merged)
        self.assertIn("merged 1,", out)
        self.assertEqual(self.recorded_base(), head)

    def test_local_only_diff_is_kept(self):
        self.write_local("skills/eng/principles/b.md", "ours\n")
        self.write_up("pkg/skills/tdd/notes.md", "notes v2\n")  # something else moves
        self.commit_up("update")
        self.run_sync()
        self.assertEqual(self.read_local("skills/eng/principles/b.md"), "ours\n")

    def test_conflict_writes_markers_and_keeps_base(self):
        self.write_local("skills/eng/test-strategy/SKILL.md", BASE_SKILL.replace("line 3", "local 3"))
        self.write_up("pkg/skills/tdd/SKILL.md", BASE_SKILL.replace("line 3", "upstream 3"))
        self.commit_up("update")
        out = self.run_sync()
        text = self.read_local("skills/eng/test-strategy/SKILL.md")
        self.assertIn("<<<<<<< local", text)
        self.assertIn(">>>>>>> upstream", text)
        self.assertIn("CONFLICTED", out)
        self.assertEqual(self.recorded_base(), self.base)

    def test_no_base_skips_differing_file(self):
        text = self.manifest.read_text().replace(f'subdir = "pkg"\nbase = "{self.base}"', 'subdir = "pkg"\nbase = ""')
        self.manifest.write_text(text)
        self.write_local("skills/eng/principles/a.md", "ours\n")
        out = self.run_sync()
        self.assertEqual(self.read_local("skills/eng/principles/a.md"), "ours\n")
        self.assertIn("skipped 1", out)

    def test_never_deletes_and_reports_removed_upstream(self):
        (self.up / "pkg/skills/tdd/notes.md").unlink()
        self.commit_up("remove")
        out = self.run_sync()
        self.assertTrue((self.local / "skills/eng/test-strategy/notes.md").exists())
        self.assertIn("Removed upstream (kept locally):\n    skills/eng/test-strategy/notes.md", out)

    def test_unmapped_report(self):
        self.write_up("pkg/skills/brand-new/SKILL.md", "new\n")
        self.commit_up("new skill")
        listed = self.run_sync("--list-unmapped")
        self.assertIn("    skills/brand-new *\n", listed)
        self.assertIn("    skills/old\n", listed)
        self.assertNotIn("principle-a", listed)
        out = self.run_sync()
        # Only new unmapped units in the sync report, by name; ignored and
        # out-of-subdir content never shows.
        self.assertIn("New upstream, unmapped", out)
        self.assertIn("    skills/brand-new\n", out)
        self.assertNotIn("skills/old", out)
        self.assertNotIn("README.md", out)
        self.assertNotIn("outside.md", out)
        self.assertFalse((self.local / "skills/brand-new").exists())
        # After the sync moved the base, it is no longer new.
        self.assertIn("    skills/brand-new\n", self.run_sync("--list-unmapped"))

    def test_dry_run_changes_nothing(self):
        self.write_local("skills/eng/test-strategy/SKILL.md", BASE_SKILL.replace("line 3", "local 3"))
        self.write_up("pkg/skills/tdd/SKILL.md", BASE_SKILL.replace("line 3", "upstream 3"))
        self.write_up("pkg/skills/tdd/extra.md", "extra\n")
        self.write_up("pkg/skills/principle-a/SKILL.md", "principle a v2\n")
        self.commit_up("update")
        manifest_before = self.manifest.read_text()
        out = self.run_sync("--dry-run")
        self.assertIn("added 1, updated 1, merged 0, conflicted 1", out)
        self.assertNotIn("<<<<<<<", self.read_local("skills/eng/test-strategy/SKILL.md"))
        self.assertFalse((self.local / "skills/eng/test-strategy/extra.md").exists())
        self.assertEqual(self.read_local("skills/eng/principles/a.md"), "principle a\n")
        self.assertEqual(self.manifest.read_text(), manifest_before)

    def test_stale_mapping_reported(self):
        text = self.manifest.read_text().replace(
            "map = [\n", 'map = [\n  { from = "skills/gone", to = "skills/eng/gone" },\n'
        )
        self.manifest.write_text(text)
        out = self.run_sync()
        self.assertIn("Stale mappings (match nothing upstream):\n    skills/gone", out)


if __name__ == "__main__":
    unittest.main()
