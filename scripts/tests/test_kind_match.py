"""The kind matcher, by its command line: a real jj repo with two workspaces in a temp HOME."""

import hashlib
import json
import os
import re
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
        sha = hashlib.sha256(SCRIPT).hexdigest()
        path = f"{self.main}/tasks/grant/deploy-page.sh"
        self.assertEqual(self.match(self.call), {
            "kind": {"action": "deploy", "repo": {"main": str(self.main / ".jj" / "repo"), "origin": self.origin}, "task": "tasks/grant/deploy-page.sh", "sha256": sha, "text": SCRIPT.decode()},
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
        self.commit(self.main, SCRIPT + b"echo more\n", "deploy-page")
        after = self.kind(self.call)
        self.assertNotEqual(after["sha256"], before["sha256"])
        self.assertEqual(after["text"], (SCRIPT + b"echo more\n").decode())
        self.assertEqual({**after, "sha256": "", "text": ""}, {**before, "sha256": "", "text": ""})

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
        self.assertIn("no jj workspace", self.refused(self.task(self.home / "plain")))

    def test_a_symlinked_jj_folder_refuses(self):
        linked = self.home / "linked"
        (linked / "tasks" / "grant").mkdir(parents=True)
        (linked / "tasks" / "grant" / "deploy-page.sh").write_bytes(SCRIPT)
        (linked / ".jj").symlink_to(self.main / ".jj")
        self.assertIn("symlink", self.refused(self.task(linked)))

    def test_a_symlinked_jj_repo_refuses_in_a_listed_workspace(self):
        call = self.in_other()
        self.kind(call)
        (self.other / ".jj" / "repo").unlink()
        (self.other / ".jj" / "repo").symlink_to(self.main / ".jj" / "repo")
        self.assertIn("symlink", self.refused(call))


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
    def not_the_form(self, command):
        self.assertIn("exactly", self.refused(command), command)

    def test_the_commit_argument_has_one_form(self):
        for arg in (COMMIT[:-1], COMMIT + "0", COMMIT.upper(), "g" + COMMIT[1:], "HEAD", '""', f"{COMMIT} {COMMIT}"):
            with self.subTest(arg=arg):
                self.not_the_form(f"{self.call} {arg}")

    def test_anything_around_the_call_refuses(self):
        for form in ("{} x", "{} --force", "{} ;", "{} ; x", "{} && x", "{} || x", "{} | x", "{} & ", "{} > x", "{} 2>&1", "{}\nx", "{}\n", " {}", "{} ",
                     "x {}", "X=1 {}", "cd /; {}", "({})", "$({})", "`{}`", "time {}", "! {}", "{} #", "{} \\", "{}\\\n"):
            with self.subTest(form=form):
                self.not_the_form(form.format(self.call))

    def test_only_bash_runs_it_and_one_space_parts_the_words(self):
        path = self.call.removeprefix("bash ")
        for command in (path, f"sh {path}", f"/bin/bash {path}", f"bash -x {path}", f"bash  {path}", f"bash\t{path}", f"BASH {path}", f"source {path}"):
            with self.subTest(command=command):
                self.not_the_form(command)

    def test_a_character_outside_the_set_refuses(self):
        path = self.call.removeprefix("bash ")
        for piece in ("'", '"', "$", "`", "\\", "*", "?", "[", "~", "=", " ", "é", "\n", "\x00"):
            with self.subTest(piece=piece):
                self.not_the_form(f"bash {path.replace('/tasks/', f'{piece}/tasks/')}")
                self.not_the_form(f"bash {path.replace('deploy-page', f'deploy-pa{piece}ge')}")

    def test_only_a_normal_absolute_path_under_tasks_grant_passes(self):
        main, name = self.main, "deploy-page.sh"
        for path in (f"{main}/../main/tasks/grant/{name}", f"{main}/./tasks/grant/{name}", f"{main}//tasks/grant/{name}"):
            with self.subTest(path=path):
                self.assertIn("normal path", self.refused(f"bash {path}"))
        for path in (f"tasks/grant/{name}", f"./tasks/grant/{name}", f"{main}/tasks/grant/../grant/{name}", f"{main}/tasks//grant/{name}", f"{main}/tasks/grant/sub/{name}",
                     f"{main}/tasks/{name}", f"{main}/{name}", f"{main}/grant/{name}", f"{main}/tasks/grant/deploy-page", f"{main}/tasks/grant/deploy-page.bash", "/tasks/grant/" + name):
            with self.subTest(path=path):
                self.not_the_form(f"bash {path}")

    def test_a_name_must_say_deploy_or_push(self):
        for task in ("page", "deploy", "push", "deploy-", "push-", "deployment", "Deploy-page", "x-deploy-page", "restart-page", "-deploy-page", "..deploy-page"):
            with self.subTest(task=task):
                (self.main / "tasks" / "grant" / f"{task}.sh").write_bytes(SCRIPT)
                self.jj(self.main, "status")
                self.not_the_form(self.task(self.main, task))


class ScriptFileCase(KindMatchCase):
    def test_a_symlink_refuses_even_to_a_tracked_script(self):
        (self.main / "tasks" / "grant" / "deploy-link.sh").symlink_to(self.main / "tasks" / "grant" / "deploy-page.sh")
        self.jj(self.main, "commit", "-m", "a link")
        self.assertIn("regular file", self.refused(self.task(self.main, "deploy-link")))

    def test_a_symlinked_folder_on_the_way_refuses(self):
        (self.main / "tasks" / "grant").rename(self.main / "tasks" / "real")
        (self.main / "tasks" / "grant").symlink_to(self.main / "tasks" / "real")
        self.jj(self.main, "status")
        self.assertIn("symlink", self.refused(self.call))

    def test_a_workspace_named_through_a_symlink_refuses(self):
        (self.home / "link").symlink_to(self.main)
        self.assertIn("symlink", self.refused(self.task(self.home / "link")))

    def test_an_untracked_script_refuses(self):
        (self.main / "tasks" / "grant" / "deploy-new.sh").write_bytes(SCRIPT)
        self.assertIn("not committed", self.refused(self.task(self.main, "deploy-new")))

    def test_a_tracked_script_gone_from_the_folder_refuses(self):
        (self.main / "tasks" / "grant" / "deploy-page.sh").unlink()
        self.assertIn("regular file", self.refused(self.call))

    def test_a_fifo_or_a_folder_refuses_without_hanging(self):
        os.mkfifo(self.main / "tasks" / "grant" / "deploy-fifo.sh")
        (self.main / "tasks" / "grant" / "deploy-dir.sh").mkdir()
        self.assertIn("regular file", self.refused(self.task(self.main, "deploy-fifo")))
        self.assertIn("regular file", self.refused(self.task(self.main, "deploy-dir")))

    def test_the_first_line_is_one_of_three_shebangs_or_no_shebang(self):
        for index, line in enumerate((b"#!/bin/sh", b"#!/usr/bin/env bash", b"#!/bin/bash", b"set -e", b"", b"# a comment")):
            with self.subTest(line=line):
                self.kind(self.tracked(self.main, line + b"\nwrangler deploy\n", f"deploy-good{index}"))
        for index, line in enumerate((b"#!/bin/sh ", b"#!/bin/sh -e", b"#!/bin/sh\r", b"#! /bin/sh", b"#!/usr/bin/env -S bash -x", b"#!/usr/bin/python3", b"#!", b"#!/tmp/x")):
            with self.subTest(line=line):
                self.assertIn("first line", self.refused(self.tracked(self.main, line + b"\nwrangler deploy\n", f"deploy-bad{index}")))


class CommittedCase(KindMatchCase):
    def write(self, name, data=SCRIPT):
        path = self.main / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def test_a_script_only_snapshotted_refuses(self):
        self.write("tasks/grant/deploy-new.sh")
        self.jj(self.main, "status")
        self.assertIn("not committed", self.refused(self.task(self.main, "deploy-new")))

    def test_disk_bytes_that_match_no_commit_refuse(self):
        self.write("tasks/grant/deploy-page.sh", SCRIPT + b"echo more\n")
        self.assertIn("differs", self.refused(self.call))

    def test_a_script_gone_from_the_last_commit_refuses(self):
        (self.main / "tasks" / "grant" / "deploy-page.sh").unlink()
        self.jj(self.main, "commit", "-m", "gone")
        self.write("tasks/grant/deploy-page.sh")
        self.assertIn("not committed", self.refused(self.call))

    def test_an_empty_script_refuses(self):
        self.assertIn("empty", self.refused(self.tracked(self.main, b"", "deploy-empty")))

    def test_an_empty_change_on_top_passes(self):
        self.assertEqual(self.jj(self.main, "log", "--no-graph", "-r", "@", "-T", "empty"), "true")
        self.kind(self.call)

    def test_unrelated_work_in_the_change_on_top_passes(self):
        self.write("other.txt", b"work\n")
        self.jj(self.main, "status")
        self.kind(self.call)

    def test_a_script_unchanged_lower_in_a_stack_passes(self):
        self.write("other.txt", b"work\n")
        self.jj(self.main, "commit", "-m", "above the script")
        self.kind(self.call)

    def test_a_merge_fails_closed(self):
        self.write("other.txt", b"work\n")
        self.jj(self.main, "commit", "-m", "one side")
        side = self.jj(self.main, "log", "--no-graph", "-r", "@-", "-T", "change_id")
        self.jj(self.main, "new", "-r", "@--")
        self.write("another.txt", b"work\n")
        self.jj(self.main, "commit", "-m", "the other side")
        self.jj(self.main, "new", "-r", "@-", "-r", side)
        self.assertEqual(self.jj(self.main, "log", "--no-graph", "-r", "@-", "-T", '"x"'), "xx")
        self.assertIn("not committed", self.refused(self.call))


class ScriptTextCase(KindMatchCase):
    def script(self, data):
        self.count = getattr(self, "count", 0) + 1
        return self.tracked(self.main, data, f"deploy-text{self.count}")

    def test_the_text_is_the_scripts_bytes_as_utf8(self):
        data = "#!/bin/sh\n\techo olá\nwrangler deploy\n".encode()
        kind = self.kind(self.script(data))
        self.assertEqual(kind["text"].encode(), data)
        self.assertEqual(kind["sha256"], hashlib.sha256(data).hexdigest())

    def test_8_kib_passes_and_a_byte_more_refuses(self):
        line = b"#!/bin/sh\n"
        self.kind(self.script(line + b"#" * (8192 - len(line))))
        self.assertIn("8 KiB", self.refused(self.script(line + b"#" * (8193 - len(line)))))

    def test_bytes_that_are_not_utf8_refuse(self):
        self.assertIn("UTF-8", self.refused(self.script(b"#!/bin/sh\necho \xff\n")))

    def test_a_character_the_page_would_not_show_refuses(self):
        for name, piece in (("zero-width", "\u200b"), ("bidi override", "\u202e"), ("bidi isolate", "\u2066"), ("BOM", "\ufeff"), ("tag", "\U000e0001"),
                            ("carriage return", "\r"), ("bell", "\x07"), ("DEL", "\x7f"), ("C1", "\x85"), ("private use", "\ue000"), ("line separator", "\u2028"), ("paragraph separator", "\u2029")):
            with self.subTest(name=name):
                self.assertIn("invisible", self.refused(self.script(f"#!/bin/sh\necho a{piece}b\n".encode())))

    def test_what_reads_as_a_credential_refuses(self):
        for line in ("TOKEN=abc", "export CLOUDFLARE_API_KEY=abc", "curl -H 'Authorization: x'", "curl -H 'Bearer abc'", "echo ghp_abc", "echo AKIAABCDEFGHIJKL", "-----BEGIN KEY", "curl https://u:pw@host",
                     "op read op://Employee/x/y"):
            with self.subTest(line=line):
                self.assertIn("credential", self.refused(self.script(f"#!/bin/sh\n{line}\n".encode())))

    def test_a_name_set_from_a_variable_holds_no_credential_in_the_text(self):
        for line in ("CLOUDFLARE_API_TOKEN=$CF_WORKERS_EDIT_TOKEN wrangler deploy --keep-vars", 'export TOKEN="${CF_TOKEN}"'):
            with self.subTest(line=line):
                self.assertEqual(self.kind(self.script(f"#!/bin/sh\n{line}\n".encode()))["action"], "deploy")
        for line in ("TOKEN=$CF_TOKEN TOKEN=abc", 'TOKEN="abc$CF_TOKEN"', "TOKEN=$(cat secret-file)", "PASSWORD=$3cret", 'PASSWORD="$3cret"',
                     "SECRET=$hunter2", "API_KEY=$AKIAIOSFODNN7EXAMPLE"):
            with self.subTest(line=line):
                self.assertIn("credential", self.refused(self.script(f"#!/bin/sh\n{line}\n".encode())))

    def test_the_credential_check_is_the_hooks(self):
        def pattern(path, name):
            found = re.search(rf"^{name} = re\.compile\((.*?)\)$", path.read_text(), re.S | re.M)
            self.assertIsNotNone(found, f"{name} in {path}")
            return re.sub(r"\s+", " ", found.group(1))
        for name in ("SECRET_IN_CALL", "OP_REFERENCE"):
            with self.subTest(name=name):
                self.assertEqual(pattern(MATCHER, name), pattern(ROOT / "hooks" / "tstack-hook.py", name))


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
        self.assertIn("jj did not run", self.refused(self.call))

    def test_the_callers_jj_config_does_not_reach_jj(self):
        bad = self.home / "bad.toml"
        bad.write_text("this is not toml = = =\n")
        self.env["JJ_CONFIG"] = str(bad)
        self.kind(self.call)

    def test_only_path_and_home_reach_jj(self):
        real = subprocess.run(["sh", "-c", "command -v jj"], env=self.env, capture_output=True, text=True, check=True).stdout.strip()
        shim = self.home / "bin" / "jj"
        shim.parent.mkdir()
        shim.write_text(f'#!/bin/sh\nenv > "$HOME/jj-env"\nexec {real} "$@"\n')
        shim.chmod(0o755)
        self.env.update(PATH=f"{shim.parent}:{self.env['PATH']}", JJ_USER="planted", BASH_ENV="/planted", FLEET_DIR="/planted")
        self.kind(self.call)
        names = {line.split("=", 1)[0] for line in (self.home / "jj-env").read_text().splitlines()}
        self.assertEqual(names - {"PWD", "OLDPWD", "SHLVL", "_"}, {"PATH", "HOME"})


if __name__ == "__main__":
    unittest.main()
