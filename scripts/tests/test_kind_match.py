"""The kind matcher, by its command line: a real jj repo with two workspaces in a temp HOME."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MATCHER = ROOT / "hooks" / "tstack-kind-match.py"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
SCRIPT = b"#!/bin/sh\nwrangler deploy --force\n"


class KindMatchCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(os.path.realpath(temp.name))
        self.env = {"PATH": os.environ["PATH"], "HOME": str(self.home)}
        self.main = self.repo("main")
        self.other = self.home / "w2"
        self.jj(self.main, "workspace", "add", "--name", "w2", "-r", "default@-", str(self.other))
        self.call = self.task(self.main)
        self.origin = "git@github.com:o/fleet.git"

    def jj(self, where, *args):
        return subprocess.run(["jj", "-R", str(where), *args], env=self.env, capture_output=True, text=True, check=True).stdout

    def repo(self, name, script=SCRIPT, task="deploy-page"):
        where = self.home / name
        subprocess.run(["jj", "git", "init", str(where)], env=self.env, capture_output=True, check=True)
        self.jj(where, "git", "remote", "add", "origin", "git@github.com:o/fleet.git")
        self.commit(where, script, task)
        return where

    def commit(self, where, script, task):
        path = where / "tasks" / "grant" / f"{task}.sh"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(script)
        self.jj(where, "commit", "-m", "add a task")

    def task(self, where, task="deploy-page"):
        return f"bash {where}/tasks/grant/{task}.sh"

    def in_other(self, call=None):
        self.jj(self.other, "new", "default@-")
        return call or self.task(self.other)

    def match(self, command, cwd="/nowhere"):
        done = subprocess.run(["python3", "-I", str(MATCHER)], input=json.dumps({"command": command, "cwd": cwd, "env": {"HOME": str(self.home)}}),
                              env=self.env, capture_output=True, text=True, cwd=self.home, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.count("\n"), 1)
        return json.loads(done.stdout)

    def refused(self, command):
        said = self.match(command)
        self.assertEqual(list(said), ["refused"], command)
        self.assertTrue(said["refused"])
        return said["refused"]

    def kind(self, command):
        said = self.match(command)
        self.assertNotIn("refused", said, command)
        return said["kind"]

    def tracked(self, where, script, task):
        self.commit(where, script, task)
        return self.task(where, task)


class AcceptCase(KindMatchCase):
    def test_a_task_call_gives_its_kind_workspace_and_script(self):
        import hashlib
        sha = hashlib.sha256(SCRIPT).hexdigest()
        path = f"{self.main}/tasks/grant/deploy-page.sh"
        self.assertEqual(self.match(self.call), {
            "kind": {"action": "deploy", "repo": {"main": str(self.main / ".jj" / "repo"), "origin": self.origin}, "task": "tasks/grant/deploy-page.sh", "sha256": sha},
            "workspace": str(self.main),
            "scripts": [{"path": path, "sha256": sha}],
        })

    def test_two_workspaces_of_one_repo_are_one_kind(self):
        call = self.in_other()
        said = self.match(call)
        self.assertEqual(said["kind"], self.kind(self.call))
        self.assertEqual(said["workspace"], str(self.other))
        self.assertEqual(said["scripts"][0]["path"], f"{self.other}/tasks/grant/deploy-page.sh")

    def test_cwd_plays_no_part(self):
        self.assertEqual(self.match(self.call, cwd=str(self.other)), self.match(self.call, cwd="/"))

    def test_a_commit_argument_does_not_change_the_kind(self):
        self.assertEqual(self.kind(f"{self.call} {COMMIT}"), self.kind(self.call))

    def test_a_push_script_is_a_push_kind(self):
        kind = self.kind(self.tracked(self.main, b"jj git push --bookmark master\n", "push-master"))
        self.assertEqual((kind["action"], kind["task"]), ("push", "tasks/grant/push-master.sh"))


class ThatRepoCase(KindMatchCase):
    def test_another_repo_with_the_same_script_is_another_kind(self):
        theirs = self.repo("theirs")
        self.assertNotEqual(self.kind(self.task(theirs))["repo"]["main"], self.kind(self.call)["repo"]["main"])

    def test_an_edited_script_has_another_sha(self):
        before = self.kind(self.call)
        (self.main / "tasks" / "grant" / "deploy-page.sh").write_bytes(SCRIPT + b"echo more\n")
        after = self.kind(self.call)
        self.assertNotEqual(after["sha256"], before["sha256"])
        self.assertEqual({**after, "sha256": ""}, {**before, "sha256": ""})

    def test_a_forged_workspace_refuses(self):
        forged = self.home / "forged"
        (forged / "tasks" / "grant").mkdir(parents=True)
        (forged / ".jj").mkdir()
        (forged / ".jj" / "repo").write_text(str(self.main / ".jj" / "repo"))
        (forged / ".jj" / "working_copy").mkdir()
        for name in os.listdir(self.main / ".jj" / "working_copy"):
            (forged / ".jj" / "working_copy" / name).write_bytes((self.main / ".jj" / "working_copy" / name).read_bytes())
        (forged / "tasks" / "grant" / "deploy-page.sh").write_bytes(SCRIPT)
        self.assertIn("lists", self.refused(self.task(forged)))

    def test_a_folder_that_is_no_repo_refuses(self):
        plain = self.home / "plain" / "tasks" / "grant"
        plain.mkdir(parents=True)
        (plain / "deploy-page.sh").write_bytes(SCRIPT)
        self.refused(self.task(self.home / "plain"))


class OriginCase(KindMatchCase):
    def origin_is(self, url):
        self.jj(self.main, "git", "remote", "set-url", "origin", url)
        return self.kind(self.call)["repo"]["origin"]

    def test_userinfo_is_stripped_from_a_url(self):
        self.assertEqual(self.origin_is("https://u:hunter2@github.com/o/fleet.git"), "https://github.com/o/fleet.git")
        self.assertEqual(self.origin_is("ssh://git@github.com/o/fleet.git"), "ssh://github.com/o/fleet.git")

    def test_a_scp_form_is_kept(self):
        self.assertEqual(self.origin_is("git@github.com:o/fleet.git"), "git@github.com:o/fleet.git")

    def test_no_origin_is_null(self):
        self.jj(self.main, "git", "remote", "remove", "origin")
        self.assertIsNone(self.kind(self.call)["repo"]["origin"])


class CallFormCase(KindMatchCase):
    def test_the_commit_argument_has_one_form(self):
        for arg in (COMMIT[:-1], COMMIT + "0", COMMIT.upper(), "g" + COMMIT[1:], "HEAD", '""', f"{COMMIT} {COMMIT}"):
            with self.subTest(arg=arg):
                self.refused(f"{self.call} {arg}")

    def test_anything_around_the_call_refuses(self):
        for form in ("{} x", "{} --force", "{} ;", "{} ; x", "{} && x", "{} || x", "{} | x", "{} & ", "{} > x", "{} 2>&1", "{}\nx", "{}\n", " {}", "{} ",
                     "x {}", "X=1 {}", "cd /; {}", "({})", "$({})", "`{}`", "time {}", "! {}", "{} #", "{} \\", "{}\\\n"):
            with self.subTest(form=form):
                self.refused(form.format(self.call))

    def test_only_bash_runs_it_and_one_space_parts_the_words(self):
        path = self.call.removeprefix("bash ")
        for command in (path, f"sh {path}", f"/bin/bash {path}", f"bash -x {path}", f"bash  {path}", f"bash\t{path}", f"BASH {path}", f"source {path}"):
            with self.subTest(command=command):
                self.refused(command)

    def test_a_character_outside_the_set_refuses(self):
        path = self.call.removeprefix("bash ")
        for piece in ("'", '"', "$", "`", "\\", "*", "?", "[", "~", " ", "é", "\n", "\x00"):
            with self.subTest(piece=piece):
                self.refused(f"bash {path.replace('/tasks/', f'{piece}/tasks/')}")
                self.refused(f"bash {path.replace('deploy-page', f'deploy-pa{piece}ge')}")

    def test_only_a_normal_absolute_path_under_tasks_grant_passes(self):
        main, name = self.main, "deploy-page.sh"
        for path in (f"tasks/grant/{name}", f"./tasks/grant/{name}", f"{main}/tasks/grant/../grant/{name}", f"{main}/../main/tasks/grant/{name}",
                     f"{main}/./tasks/grant/{name}", f"{main}//tasks/grant/{name}", f"{main}/tasks//grant/{name}", f"{main}/tasks/grant/sub/{name}",
                     f"{main}/tasks/{name}", f"{main}/{name}", f"{main}/grant/{name}", f"{main}/tasks/grant/deploy-page", f"{main}/tasks/grant/deploy-page.bash", "/tasks/grant/" + name):
            with self.subTest(path=path):
                self.refused(f"bash {path}")

    def test_a_name_must_say_deploy_or_push(self):
        for task in ("page", "deploy", "push", "deploy-", "push-", "deployment", "Deploy-page", "x-deploy-page", "restart-page", "-deploy-page", "..deploy-page"):
            with self.subTest(task=task):
                (self.main / "tasks" / "grant" / f"{task}.sh").write_bytes(SCRIPT)
                self.jj(self.main, "status")
                self.refused(self.task(self.main, task))


class ScriptFileCase(KindMatchCase):
    def test_a_symlink_refuses_even_to_a_tracked_script(self):
        (self.main / "tasks" / "grant" / "deploy-link.sh").symlink_to(self.main / "tasks" / "grant" / "deploy-page.sh")
        self.jj(self.main, "status")
        self.refused(self.task(self.main, "deploy-link"))

    def test_a_symlinked_folder_on_the_way_refuses(self):
        (self.main / "tasks" / "grant").rename(self.main / "tasks" / "real")
        (self.main / "tasks" / "grant").symlink_to(self.main / "tasks" / "real")
        self.jj(self.main, "status")
        self.refused(self.call)

    def test_a_workspace_named_through_a_symlink_refuses(self):
        (self.home / "link").symlink_to(self.main)
        self.refused(self.task(self.home / "link"))

    def test_an_untracked_script_refuses(self):
        (self.main / "tasks" / "grant" / "deploy-new.sh").write_bytes(SCRIPT)
        self.assertIn("tracked", self.refused(self.task(self.main, "deploy-new")))

    def test_a_tracked_script_gone_from_the_folder_refuses(self):
        (self.main / "tasks" / "grant" / "deploy-page.sh").unlink()
        self.refused(self.call)

    def test_a_fifo_or_a_folder_refuses_without_hanging(self):
        os.mkfifo(self.main / "tasks" / "grant" / "deploy-fifo.sh")
        (self.main / "tasks" / "grant" / "deploy-dir.sh").mkdir()
        self.refused(self.task(self.main, "deploy-fifo"))
        self.refused(self.task(self.main, "deploy-dir"))

    def test_the_first_line_is_one_of_three_shebangs_or_no_shebang(self):
        for index, line in enumerate((b"#!/bin/sh", b"#!/usr/bin/env bash", b"#!/bin/bash", b"set -e", b"", b"# a comment")):
            with self.subTest(line=line):
                self.kind(self.tracked(self.main, line + b"\nwrangler deploy\n", f"deploy-good{index}"))
        for index, line in enumerate((b"#!/bin/sh ", b"#!/bin/sh -e", b"#!/bin/sh\r", b"#! /bin/sh", b"#!/usr/bin/env -S bash -x", b"#!/usr/bin/python3", b"#!", b"#!/tmp/x")):
            with self.subTest(line=line):
                self.assertIn("first line", self.refused(self.tracked(self.main, line + b"\nwrangler deploy\n", f"deploy-bad{index}")))


class InputCase(KindMatchCase):
    def raw(self, text):
        done = subprocess.run(["python3", "-I", str(MATCHER)], input=text, env=self.env, capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_input_that_does_not_read_refuses(self):
        for text in ("", "{", "[]", "3", '{"command": 3}', '{"cwd": "/"}'):
            with self.subTest(text=text):
                self.assertIn("refused", self.raw(text))

    def test_jj_missing_refuses(self):
        self.env = {"PATH": str(self.home), "HOME": str(self.home)}
        (self.home / "python3").symlink_to(subprocess.run(["sh", "-c", "command -v python3"], capture_output=True, text=True, check=True).stdout.strip())
        self.refused(self.call)


if __name__ == "__main__":
    unittest.main()
