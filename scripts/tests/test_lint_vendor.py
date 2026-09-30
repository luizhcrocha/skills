"""Tests for scripts/lint-vendor against a throwaway tstack source and target repos.

Run: just test-scripts  (or python3 -m unittest discover -s scripts/tests)
"""

import io
import os
import subprocess
import sys
import tempfile
import tomllib
import unittest
from contextlib import redirect_stderr, redirect_stdout
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "scripts" / "lint-vendor"

sys.dont_write_bytecode = True
_loader = SourceFileLoader("lint_vendor", str(SCRIPT))
lv = module_from_spec(spec_from_loader("lint_vendor", _loader))
sys.modules["lint_vendor"] = lv
_loader.exec_module(lv)

RUFF = 'line-length = 88\n\n[lint]\nselect = ["ALL"]\nignore = [\n  "D",\n  "COM812",\n]\n'
RULE = "export const a = 1;\n\nexport const b = 2;\n\nexport const c = 3;\n"
REGISTRY = """\
[[rule]]
id = "ts/anti-slop/a"
lang = "ts"
engine = "oxlint"
kind = "custom"
status = "error"
summary = "a"
where = "lint/ts/anti-slop/rules/a.ts"
created = "2026-09-30"
evidence = ["upstream:x"]
history = [{ date = "2026-09-30", status = "error", note = "seed" }]

[[rule]]
id = "ts/tstack/b"
lang = "ts"
engine = "oxlint"
kind = "custom"
status = "trial"
summary = "b"
where = "lint/ts/tstack/index.ts"
created = "2026-09-30"
evidence = ["repo:x"]
history = [{ date = "2026-09-30", status = "trial", note = "seed" }]
"""


def git(cwd, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
                          cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class LintVendor(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.src = tmp / "tstack"
        self.repo = tmp / "repo"
        self.cache = tmp / "cache"
        os.environ["TSTACK_LINT_CACHE"] = str(self.cache)
        for path, text in {
            "lint/py/ruff.toml": RUFF,
            "lint/ts/anti-slop/index.ts": "export default {};\n",
            "lint/ts/anti-slop/rules/a.ts": RULE,
            "lint/ts/anti-slop/rules/a.test.ts": "test\n",
            "lint/ts/tstack/index.ts": "export default {};\n",
            "lint/registry.toml": REGISTRY,
        }.items():
            self.write_src(path, text)
        git(self.src, "init", "-q", "-b", "main")
        self.commit_src("pack")
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "README.md").write_text("repo\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "init")
        self.head = git(self.repo, "rev-parse", "HEAD")

    def tearDown(self):
        os.environ.pop("TSTACK_LINT_CACHE", None)
        self._tmp.cleanup()

    def write_src(self, path, text):
        p = self.src / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit_src(self, msg):
        git(self.src, "add", "-A")
        git(self.src, "commit", "-q", "-m", msg)

    def vendor(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = lv.main(["--source", str(self.src), "--repo", str(self.repo), *args])
        return code, out.getvalue() + err.getvalue()

    def manifest(self):
        return tomllib.loads((self.repo / lv.MANIFEST).read_text())

    def text(self, path):
        return (self.repo / path).read_text()

    def test_add_copies_the_pack_records_bases_and_prints_the_wiring(self):
        code, out = self.vendor("add", "py", "ts")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.text("tools/lint/tstack/py/ruff.toml"), RUFF)
        self.assertEqual(self.text("tools/oxlint/anti-slop/rules/a.ts"), RULE)
        self.assertTrue((self.repo / "tools/oxlint/tstack/index.ts").exists())
        self.assertFalse((self.repo / "tools/oxlint/anti-slop/rules/a.test.ts").exists(), "tests stay in tstack")
        m = self.manifest()
        self.assertEqual(m["langs"], ["ts", "py"])
        files = {f["path"]: f for f in m["file"]}
        self.assertEqual(files["tools/lint/tstack/py/ruff.toml"]["from"], "lint/py/ruff.toml")
        self.assertEqual(files["tools/lint/tstack/py/ruff.toml"]["base"], lv.blob_id(RUFF.encode()))
        self.assertIn('extend = "tools/lint/tstack/py/ruff.toml"', out)
        self.assertIn('"anti-slop/a": "error"', out)
        self.assertNotIn("tstack/b", out, "trial rules stay off")
        self.assertIn('specifier: "./tools/oxlint/anti-slop/index.ts"', out)

    def test_nothing_is_committed_in_the_target(self):
        self.vendor("add", "py")
        (self.src / "lint/py/ruff.toml").write_text(RUFF + "# more\n")
        self.vendor("update")
        self.vendor("remove")
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), self.head)
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")

    def test_update_fast_forwards_an_unedited_file(self):
        self.vendor("add", "py")
        new = RUFF.replace("88", "100")
        self.write_src("lint/py/ruff.toml", new)
        self.commit_src("wider")
        code, out = self.vendor("update")
        self.assertEqual(code, 0, out)
        self.assertIn("Updated", out)
        self.assertEqual(self.text("tools/lint/tstack/py/ruff.toml"), new)
        self.assertEqual(self.manifest()["file"][0]["base"], lv.blob_id(new.encode()))

    def test_update_keeps_the_repos_edit_when_tstack_did_not_change(self):
        self.vendor("add", "py")
        edited = RUFF.replace('"COM812",\n', '"COM812",\n  "T20",\n')
        (self.repo / "tools/lint/tstack/py/ruff.toml").write_text(edited)
        code, out = self.vendor("update")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.text("tools/lint/tstack/py/ruff.toml"), edited)
        self.assertEqual(self.vendor("status")[1].count("edited"), 1)

    def test_update_merges_both_sides_three_way(self):
        self.vendor("add", "ts")
        local = RULE.replace("export const a = 1;", "export const a = 10;")
        (self.repo / "tools/oxlint/anti-slop/rules/a.ts").write_text(local)
        self.write_src("lint/ts/anti-slop/rules/a.ts", RULE.replace("export const c = 3;", "export const c = 30;"))
        self.commit_src("c")
        code, out = self.vendor("update")
        self.assertEqual(code, 0, out)
        self.assertIn("Merged", out)
        self.assertEqual(self.text("tools/oxlint/anti-slop/rules/a.ts"),
                         "export const a = 10;\n\nexport const b = 2;\n\nexport const c = 30;\n")

    def test_a_clash_leaves_markers_keeps_the_base_and_fails(self):
        self.vendor("add", "ts")
        old_base = self.manifest()["file"]
        (self.repo / "tools/oxlint/anti-slop/rules/a.ts").write_text(RULE.replace("b = 2", "b = 20"))
        self.write_src("lint/ts/anti-slop/rules/a.ts", RULE.replace("b = 2", "b = 200"))
        self.commit_src("b")
        code, out = self.vendor("update")
        self.assertEqual(code, 1)
        self.assertIn("CONFLICTED", out)
        text = self.text("tools/oxlint/anti-slop/rules/a.ts")
        self.assertIn("<<<<<<< repo", text)
        self.assertIn(">>>>>>> tstack", text)
        self.assertEqual(self.manifest()["file"], old_base)
        (self.repo / "tools/oxlint/anti-slop/rules/a.ts").write_text(RULE.replace("b = 2", "b = 200"))
        self.assertEqual(self.vendor("update")[0], 0, "resolved in tstack's favour: clean on the rerun")

    def test_the_base_comes_back_from_the_cache_without_git(self):
        self.vendor("add", "py")
        subprocess.run(["rm", "-rf", str(self.src / ".git")], check=True)
        (self.repo / "tools/lint/tstack/py/ruff.toml").write_text(RUFF.replace("88", "90"))
        self.write_src("lint/py/ruff.toml", RUFF + '\n[format]\nquote-style = "double"\n')
        code, out = self.vendor("update")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.text("tools/lint/tstack/py/ruff.toml"),
                         RUFF.replace("88", "90") + '\n[format]\nquote-style = "double"\n')

    def test_an_unrecoverable_base_is_skipped_not_overwritten(self):
        self.vendor("add", "py")
        subprocess.run(["rm", "-rf", str(self.src / ".git"), str(self.cache)], check=True)
        (self.repo / "tools/lint/tstack/py/ruff.toml").write_text("mine\n")
        self.write_src("lint/py/ruff.toml", "theirs\n")
        code, out = self.vendor("update")
        self.assertEqual(code, 1)
        self.assertIn("not recoverable", out)
        self.assertEqual(self.text("tools/lint/tstack/py/ruff.toml"), "mine\n")

    def test_new_files_arrive_gone_files_stay_and_deletions_stick(self):
        self.vendor("add", "ts")
        (self.repo / "tools/oxlint/tstack/index.ts").unlink()
        self.write_src("lint/ts/tstack/rules/new.ts", "new\n")
        (self.src / "lint/ts/anti-slop/rules/a.ts").unlink()
        self.commit_src("reshuffle")
        code, out = self.vendor("update")
        self.assertEqual(code, 0, out)
        self.assertTrue((self.repo / "tools/oxlint/tstack/rules/new.ts").exists())
        self.assertIn("Gone from the pack", out)
        self.assertTrue((self.repo / "tools/oxlint/anti-slop/rules/a.ts").exists())
        self.assertIn("Deleted in the repo", out)
        self.assertFalse((self.repo / "tools/oxlint/tstack/index.ts").exists())
        paths = {f["path"] for f in self.manifest()["file"]}
        self.assertNotIn("tools/oxlint/anti-slop/rules/a.ts", paths)

    def test_an_existing_copy_is_recorded_when_identical_and_adopted_only_on_request(self):
        target = self.repo / "tools/oxlint/anti-slop"
        (target / "rules").mkdir(parents=True)
        (target / "index.ts").write_text("export default {};\n")
        (target / "rules/a.ts").write_text(RULE + "// local\n")
        code, out = self.vendor("add", "ts")
        self.assertEqual(code, 1)
        self.assertIn("identical", out)
        self.assertIn("not vendored by lint-vendor", out)
        self.assertNotIn("tools/oxlint/anti-slop/rules/a.ts", {f["path"] for f in self.manifest()["file"]})
        code, out = self.vendor("add", "ts", "--adopt")
        self.assertEqual(code, 0, out)
        self.assertIn("Adopted", out)
        self.assertEqual(self.text("tools/oxlint/anti-slop/rules/a.ts"), RULE + "// local\n")
        self.write_src("lint/ts/anti-slop/rules/a.ts", "// head\n" + RULE)
        self.commit_src("head")
        self.assertEqual(self.vendor("update")[0], 0)
        self.assertEqual(self.text("tools/oxlint/anti-slop/rules/a.ts"), "// head\n" + RULE + "// local\n")

    def test_remove_deletes_unedited_files_and_keeps_edited_ones(self):
        self.vendor("add", "py", "ts")
        (self.repo / "tools/oxlint/anti-slop/rules/a.ts").write_text("mine\n")
        code, out = self.vendor("remove", "ts")
        self.assertEqual(code, 0, out)
        self.assertTrue((self.repo / "tools/oxlint/anti-slop/rules/a.ts").exists())
        self.assertFalse((self.repo / "tools/oxlint/tstack").exists())
        self.assertEqual(self.manifest()["langs"], ["py"])
        self.vendor("remove")
        self.assertFalse((self.repo / lv.MANIFEST).exists())

    def test_an_update_with_nothing_new_leaves_the_manifest_alone(self):
        self.vendor("add", "py")
        before = (self.repo / lv.MANIFEST).read_text()
        (self.repo / lv.MANIFEST).write_text(before.replace('updated = "', 'updated = "x'))
        self.vendor("update")
        self.assertIn('updated = "x', (self.repo / lv.MANIFEST).read_text())

    def test_detect_finds_languages_by_their_markers(self):
        for path, text in {
            "web/package.json": '{"devDependencies": {"typescript": "7"}}',
            "crates/x/Cargo.toml": "",
            "flake.nix": "{}",
            "svc/go.mod": "module x",
            "node_modules/y/pyproject.toml": "",
        }.items():
            p = self.repo / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
        self.assertEqual(lv.detect(self.repo), ["ts", "rust", "go", "nix"])
        code, out = self.vendor("add", "auto")
        self.assertEqual(code, 1, "the fixture tstack has no rust, go or nix pack")
        self.assertIn("no pack lint/rust", out)

    def test_unknown_language_is_refused(self):
        code, out = self.vendor("add", "java")
        self.assertEqual(code, 1)
        self.assertIn("unknown language", out)


class RealPacks(unittest.TestCase):
    def test_every_language_has_a_pack_with_files(self):
        for lang in lv.LANGS:
            with self.subTest(lang):
                files = lv.pack_files(ROOT, lang)
                self.assertTrue(files)
                self.assertFalse([f for f in files if f.endswith(".test.ts")])


if __name__ == "__main__":
    unittest.main()
