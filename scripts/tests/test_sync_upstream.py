"""Tests for scripts/sync_upstream.py against throwaway git repos.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
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

    def add_watch(self, extra=""):
        self.manifest.write_text(self.manifest.read_text() + f"""
[upstream.watched]
url = "{self.up}"
base = "{self.base}"
watch = true
{extra}""")

    def run_watch(self, *args, ok=True):
        p = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.local), "--upstream", "watched", *args],
            capture_output=True, text=True,
        )
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr)
        return p

    def test_watch_reports_commits_and_files_and_copies_nothing(self):
        self.add_watch()
        self.write_up("memo.py", "def wake(): pass\n")
        head = self.commit_up("wake gets a budget")
        before = sorted(p.relative_to(self.local).as_posix() for p in self.local.rglob("*") if p.is_file())
        out = self.run_watch("--diff").stdout
        self.assertIn("watch-only", out)
        self.assertIn("wake gets a budget", out)
        self.assertIn("memo.py", out)
        self.assertIn("+def wake(): pass", out)
        after = sorted(p.relative_to(self.local).as_posix() for p in self.local.rglob("*") if p.is_file())
        self.assertEqual(before, after)
        self.assertEqual(self.recorded_base("watched"), head)

    def test_watch_dry_run_keeps_base_and_quiet_when_nothing_new(self):
        self.add_watch()
        self.assertIn("nothing new since base", self.run_watch().stdout)
        self.write_up("memo.py", "x\n")
        self.commit_up("change")
        out = self.run_watch("--dry-run").stdout
        self.assertIn("base unchanged", out)
        self.assertEqual(self.recorded_base("watched"), self.base)

    def test_watch_refuses_a_map(self):
        self.add_watch('map = [{ from = "memo.py", to = "scripts/memo" }]\n')
        p = self.run_watch(ok=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("watch-only", p.stderr)

    # --- mirror, and per-entry modes ---

    TDD_MAP = '{ from = "skills/tdd", to = "skills/eng/test-strategy" }'

    def set_mode(self, mode):
        text = self.manifest.read_text().replace(self.TDD_MAP, self.TDD_MAP[:-2] + f', mode = "{mode}" }}')
        self.manifest.write_text(text)

    def tree(self):
        return {p.relative_to(self.local).as_posix(): p.read_bytes() for p in self.local.rglob("*") if p.is_file()}

    SKILL_MD = "skills/eng/test-strategy/SKILL.md"
    LINK = "Local changes (tstack): [local/test-strategy.md](../../../local/test-strategy.md)"

    def test_mirror_written_and_pruned(self):
        self.run_sync()
        self.assertEqual(self.read_local("upstream/demo/skills/tdd/SKILL.md"), BASE_SKILL)
        self.assertEqual(self.read_local("upstream/demo/skills/principle-a/SKILL.md"), "principle a\n")
        self.assertFalse((self.local / "upstream/demo/README.md").exists())  # unmapped: not mirrored
        self.assertFalse((self.local / "upstream/demo/skills/old").exists())
        (self.up / "pkg/skills/tdd/notes.md").unlink()
        self.commit_up("remove")
        self.run_sync()
        self.assertFalse((self.local / "upstream/demo/skills/tdd/notes.md").exists())
        self.assertTrue((self.local / "skills/eng/test-strategy/notes.md").exists())  # merge mode keeps it

    def test_overlay_overwrites_and_deletes_files_gone_upstream(self):
        self.set_mode("overlay")
        self.write_local(self.SKILL_MD, BASE_SKILL.replace("line 1", "local 1"))
        self.write_local("skills/eng/test-strategy/ours.md", "local only\n")
        self.write_local("skills/eng/principles/b.md", "ours\n")  # merge entry: kept
        (self.up / "pkg/skills/tdd/notes.md").unlink()
        self.write_up("pkg/skills/tdd/extra.md", "extra\n")
        self.write_up("pkg/skills/tdd/SKILL.md", BASE_SKILL.replace("line 5", "upstream 5"))
        head = self.commit_up("update")
        out = self.run_sync()
        self.assertEqual(self.read_local(self.SKILL_MD), BASE_SKILL.replace("line 5", "upstream 5"))
        self.assertEqual(self.read_local("skills/eng/test-strategy/extra.md"), "extra\n")
        self.assertFalse((self.local / "skills/eng/test-strategy/notes.md").exists())
        self.assertFalse((self.local / "skills/eng/test-strategy/ours.md").exists())
        self.assertEqual(self.read_local("skills/eng/principles/b.md"), "ours\n")
        self.assertIn("removed skills/eng/test-strategy/notes.md", out)
        self.assertNotIn("CONFLICTED", out)
        self.assertEqual(self.recorded_base(), head)

    UP_FM = """\
---
name: tdd
description: >
  Upstream: test first,
  always.
disable-model-invocation: true
argument-hint: "<x: y>"
---
# TDD

Use poteto-mode here, not grill-meister.
"""

    def overlay_with_frontmatter(self, local_md=None, names=None):
        self.set_mode("overlay")
        self.write_up("pkg/skills/tdd/SKILL.md", self.UP_FM)
        self.commit_up("frontmatter")
        if local_md is not None:
            self.write_local("local/test-strategy.md", local_md)
        if names is not None:
            self.write_local("local/NAMES.md", names)

    def test_frontmatter_override_and_removal(self):
        self.overlay_with_frontmatter(
            '---\nname: test-strategy\ndescription: "Ours: tests, first"\ndisable-model-invocation: ~\n---\n'
        )
        self.run_sync()
        self.assertEqual(self.read_local(self.SKILL_MD), """\
---
name: test-strategy
description: "Ours: tests, first"
argument-hint: "<x: y>"
---
# TDD

Use poteto-mode here, not grill-meister.
""")  # no body, no NAMES.md: no generated line

    NAMES = """\
# Names

| upstream | ours |
|---|---|
| `poteto-mode` | `tstack:tuca-mode` |
| grill-me | tstack:grilling |
"""

    def test_generated_line_with_local_body(self):
        self.overlay_with_frontmatter("---\nname: test-strategy\n---\n\nWe test first.\n")
        self.run_sync()
        text = self.read_local(self.SKILL_MD)
        self.assertTrue(text.startswith("---\nname: test-strategy\ndescription: >\n  Upstream"), text)
        self.assertTrue(text.endswith("not grill-meister.\n\n" + self.LINK + "\n"), text)

    def test_generated_line_with_names(self):
        self.overlay_with_frontmatter("We test first.\n", self.NAMES)
        self.run_sync()
        text = self.read_local(self.SKILL_MD)
        self.assertTrue(text.startswith(self.UP_FM), text)  # no frontmatter in local: upstream's kept
        self.assertTrue(text.endswith(
            "\n\n" + self.LINK + " · Names here: poteto-mode → tstack:tuca-mode\n"
        ), text)  # grill-me only occurs inside grill-meister: no match

    def test_generated_line_names_only_without_local_body(self):
        self.overlay_with_frontmatter(names=self.NAMES)
        self.run_sync()
        self.assertTrue(self.read_local(self.SKILL_MD).endswith(
            "grill-meister.\n\nNames here: poteto-mode → tstack:tuca-mode\n"
        ))

    def test_overlay_strip_cuts_matches_from_every_md_but_not_the_mirror(self):
        self.set_mode("overlay")
        self.manifest.write_text(self.manifest.read_text().replace(
            'ignore = ["README.md"]',
            'ignore = ["README.md"]\nstrip = [\'(?ms)^## Hello\\n.*?^Done\\.\\n\', \' Taught by Ann\\.\']'))
        skill = "# T\n\n## Hello\n\n> I'm ready.\n\nDone.\n\nRule one. Taught by Ann.\n"
        self.write_up("pkg/skills/tdd/SKILL.md", skill)
        self.write_up("pkg/skills/tdd/notes.md", "Taught by Ann. Notes. Taught by Ann.\n")
        self.commit_up("greeting")
        self.run_sync()
        self.assertEqual(self.read_local(self.SKILL_MD), "# T\n\nRule one.\n")
        self.assertEqual(self.read_local("skills/eng/test-strategy/notes.md"), "Taught by Ann. Notes.\n")
        self.assertEqual(self.read_local("upstream/demo/skills/tdd/SKILL.md"), skill)
        before = self.tree()
        self.run_sync()
        self.assertEqual(self.tree(), before)

    def test_overlay_rerun_is_idempotent(self):
        self.overlay_with_frontmatter("---\nname: test-strategy\nx: ~\n---\nWe test first.\n", self.NAMES)
        self.run_sync()
        before = self.tree()
        out = self.run_sync()
        self.assertEqual(self.tree(), before)
        self.assertNotIn("Overlaid", out)
        self.assertNotIn("Post-processed", out)

    def test_mirror_mode_leaves_target_untouched(self):
        self.set_mode("mirror")
        self.write_local(self.SKILL_MD, "ours\n")
        self.write_up("pkg/skills/tdd/SKILL.md", BASE_SKILL.replace("line 5", "upstream 5"))
        self.write_up("pkg/skills/tdd/extra.md", "extra\n")
        head = self.commit_up("update")
        self.run_sync()
        self.assertEqual(self.read_local(self.SKILL_MD), "ours\n")
        self.assertFalse((self.local / "skills/eng/test-strategy/extra.md").exists())
        self.assertEqual(self.read_local("upstream/demo/skills/tdd/extra.md"), "extra\n")
        self.assertEqual(self.read_local("upstream/demo/skills/tdd/SKILL.md"), BASE_SKILL.replace("line 5", "upstream 5"))
        self.assertEqual(self.recorded_base(), head)

    def test_overlay_dry_run_writes_nothing_and_reports(self):
        self.overlay_with_frontmatter("We test first.\n")
        (self.up / "pkg/skills/tdd/notes.md").unlink()
        self.commit_up("remove")
        before = self.tree()
        out = self.run_sync("--dry-run")
        self.assertEqual(self.tree(), before)
        self.assertIn("Mirrored to upstream/demo/", out)
        self.assertIn("    added upstream/demo/skills/tdd/SKILL.md", out)
        self.assertIn("    updated skills/eng/test-strategy/SKILL.md", out)
        self.assertIn("    removed skills/eng/test-strategy/notes.md", out)
        self.assertIn("Post-processed", out)
        self.assertIn("    skills/eng/test-strategy/SKILL.md (local line)", out)

    def test_unknown_mode_is_refused(self):
        self.set_mode("bogus")
        p = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.local), "--upstream", "demo"],
            capture_output=True, text=True,
        )
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("mode", p.stderr)


if __name__ == "__main__":
    unittest.main()
