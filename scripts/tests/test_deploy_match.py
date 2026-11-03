"""The deploy part's `match` mode, as the host and `fleet state --call` run it: `python3 -I hooks/tstack-hook-deploy.py match`,
a real process over a real jj repo with two workspaces and a bare origin, under a temp HOME."""

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PART = Path(__file__).resolve().parents[2] / "hooks" / "tstack-hook-deploy.py"


class MatchCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.place = Path(os.path.realpath(tempfile.mkdtemp(prefix="deploy-match-")))
        cls.addClassCleanup(shutil.rmtree, cls.place, ignore_errors=True)
        cls.home = cls.place / "home"
        cls.home.mkdir()
        cls.env = {"PATH": os.environ["PATH"], "HOME": str(cls.home), "JJ_USER": "t", "JJ_EMAIL": "t@example.com", "TZ": "UTC"}
        cls.origin = cls.place / "origin.git"
        subprocess.run(["git", "init", "-q", "--bare", str(cls.origin)], check=True, env=cls.env)
        cls.main = cls.place / "fleet-ship"
        cls.other = cls.place / "other-repo"
        cls.jj_init(cls.other)
        cls.jj_init(cls.main)
        cls.jj(cls.main, "git", "remote", "add", "origin", str(cls.origin))
        (cls.main / "apps" / "page").mkdir(parents=True)
        (cls.main / "f").write_text("1\n")
        cls.jj(cls.main, "commit", "-m", "one")
        cls.jj(cls.main, "bookmark", "create", "land", "-r", "@-")
        (cls.main / "f").write_text("pushed\n")
        cls.jj(cls.main, "commit", "-m", "pushed, then rewritten")
        cls.jj(cls.main, "bookmark", "create", "rewritten", "-r", "@-")
        cls.jj(cls.main, "bookmark", "track", "land", "rewritten", "--remote", "origin")
        cls.jj(cls.main, "git", "push", "--bookmark", "land", "--bookmark", "rewritten")
        (cls.main / "f").write_text("2\n")
        cls.jj(cls.main, "commit", "-m", "two")
        cls.jj(cls.main, "bookmark", "set", "land", "-r", "@-")
        cls.jj(cls.main, "bookmark", "create", "fresh", "-r", "@-")
        cls.jj(cls.main, "new", "land@origin")
        (cls.main / "f").write_text("3\n")
        cls.jj(cls.main, "commit", "-m", "aside")
        cls.jj(cls.main, "bookmark", "set", "rewritten", "-r", "@-", "--allow-backwards")
        cls.second = cls.place / "fleet-ship-two"
        cls.jj(cls.main, "workspace", "add", str(cls.second), "--name", "two")
        (cls.second / "apps" / "page").mkdir(parents=True, exist_ok=True)
        cls.scratch = cls.place / "scratch"
        cls.scratch.mkdir()

    @classmethod
    def jj(cls, cwd, *args):
        subprocess.run(["jj", "-R", str(cwd), *args], check=True, env=cls.env, capture_output=True)

    @classmethod
    def jj_init(cls, path):
        path.mkdir()
        subprocess.run(["jj", "git", "init", str(path)], check=True, env=cls.env, capture_output=True)

    def script(self, text, name="generated.sh"):
        path = self.scratch / name
        path.write_text(text)
        path.chmod(0o755)
        return path

    def match(self, command, cwd=None, env=None):
        given = {"command": command, "cwd": str(cwd or self.main), "env": env or {"HOME": str(self.home)}}
        done = subprocess.run(["python3", "-I", str(PART), "match"], input=json.dumps(given), capture_output=True, text=True, env=self.env, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = done.stdout.splitlines()
        self.assertEqual(len(lines), 1, done.stdout)
        return json.loads(lines[0])

    def kind(self, command, **given):
        out = self.match(command, **given)
        self.assertIn("kind", out, f"{command}: {out}")
        return out

    def refused(self, command, because="", **given):
        out = self.match(command, **given)
        self.assertEqual(set(out), {"refused"}, f"{command}: {out}")
        self.assertIn(because, out["refused"], command)

    @property
    def repo(self):
        return {"main": str(self.main / ".jj" / "repo"), "origin": str(self.origin)}


class Repo(MatchCase):
    def test_a_deploy_from_either_workspace_is_the_same_kind(self):
        first = self.kind("wrangler deploy", cwd=self.main)
        second = self.kind("wrangler deploy", cwd=self.second)
        self.assertEqual(first["kind"], {"action": "deploy", "repo": self.repo})
        self.assertEqual(second["kind"], first["kind"])
        self.assertEqual((first["workspace"], second["workspace"]), (str(self.main), str(self.second)))

    def test_a_folder_inside_a_workspace_is_that_workspace(self):
        self.assertEqual(self.kind("wrangler deploy", cwd=self.second / "apps" / "page")["workspace"], str(self.second))

    def test_a_cd_moves_the_deploy_to_the_repo_it_names(self):
        self.assertEqual(self.kind(f"cd {self.second} && wrangler deploy", cwd=self.scratch)["kind"]["repo"], self.repo)
        self.assertEqual(self.kind(f"cd {self.main} && sh -c 'wrangler deploy'", cwd=self.scratch)["kind"]["repo"], self.repo)

    def test_another_repo_is_another_kind(self):
        other = self.kind("wrangler deploy", cwd=self.other)["kind"]
        self.assertEqual(other["repo"], {"main": str(self.other / ".jj" / "repo"), "origin": None})
        self.assertEqual(self.kind(f"cd {self.other} && wrangler deploy")["kind"]["repo"], other["repo"])

    def test_outside_any_workspace_there_is_no_kind(self):
        self.refused("wrangler deploy", "no jj workspace", cwd=self.scratch)

    def test_a_cd_it_cannot_follow_gives_no_kind(self):
        for command in ("cd $SOMEWHERE && wrangler deploy", "pushd /tmp; wrangler deploy", "cd; wrangler deploy", f"cd {self.place}/gone && wrangler deploy", "if cd /tmp; then wrangler deploy; fi"):
            self.refused(command)

    def test_a_cd_in_a_subshell_gives_no_kind(self):
        self.refused(f"(cd {self.other}); wrangler deploy")
        self.refused(f"(ls; cd {self.main}) ; wrangler deploy", cwd=self.other)


class Target(MatchCase):
    def test_each_redirect_gives_no_kind(self):
        for command in (
            "wrangler deploy --name other", "wrangler deploy --name=other", "wrangler --name other deploy",
            "wrangler deploy --config /elsewhere/x.toml", "wrangler deploy --config=/elsewhere/x.toml", "wrangler deploy -c ../x.toml", "wrangler deploy -c/elsewhere/x.toml",
            "wrangler deploy -c $SOMEWHERE/x.toml", "wrangler deploy -c ~/x.toml", "wrangler deploy -c", "wrangler deploy --dispatch-namespace other", "wrangler deploy --keep-vars other.ts",
            "secretspec run -- wrangler deploy --name other", "secretspec run -- sh -c 'wrangler deploy --env prod'", "CLOUDFLARE_ENV=prod wrangler deploy",
            "xargs wrangler deploy", "direnv exec /elsewhere wrangler deploy", "dotenvx run -- wrangler deploy", "sudo -u other wrangler deploy",
            "pulumi up --stack other", "fly deploy --app other", "just deploy other", "npm run deploy -- --env prod",
            "wrangler deploy --env prod", "wrangler deploy --env=prod", "wrangler deploy -e prod",
            "wrangler deploy --cwd /elsewhere", "wrangler deploy --route x/*", "wrangler deploy --domain x.dev", "wrangler deploy other.ts",
            "wrangler versions deploy --name other", "npx wrangler deploy --name other", "pnpm exec wrangler deploy -e prod",
            "env -C /elsewhere wrangler deploy", "env --chdir=/elsewhere wrangler deploy", "env -C /elsewhere sh -c 'wrangler deploy'",
            "pnpm -C /elsewhere deploy", "pnpm --filter other deploy", "pnpm --dir /elsewhere run deploy",
            "just --justfile /elsewhere/justfile deploy", "just -f /elsewhere/justfile deploy", "just -d /elsewhere deploy",
        ):
            self.refused(command, "redirect")

    def test_a_redirect_in_a_script_gives_no_kind(self):
        self.refused(f"bash {self.script('wrangler deploy --env prod\n')}", "redirect")

    def test_a_flag_that_only_changes_how_it_deploys_is_kept(self):
        self.assertEqual(self.kind("wrangler deploy --keep-vars --minify")["kind"]["action"], "deploy")

    def test_a_config_inside_the_workspace_is_kept(self):
        for command in (
            "wrangler deploy -c dist/server/wrangler.json --keep-vars", "wrangler deploy --config dist/x.toml", "wrangler deploy --config=x.toml", "wrangler deploy -cx.toml",
            f"wrangler deploy -c {self.main}/x.toml", "cd apps/page && wrangler deploy -c ../../x.toml",
        ):
            self.assertEqual(self.kind(command)["kind"]["action"], "deploy", command)

    def test_a_config_in_another_workspace_of_the_repo_gives_no_kind(self):
        self.refused(f"wrangler deploy -c {self.main}/x.toml", "redirect", cwd=self.second)

    def test_the_other_deploy_verbs(self):
        for command in ("wrangler versions deploy", "just deploy", "pnpm deploy", "npm run deploy", "devenv tasks run fleet:deploy", "pulumi up", "fly deploy"):
            self.assertEqual(self.kind(command)["kind"], {"action": "deploy", "repo": self.repo}, command)


class Never(MatchCase):
    WORDS = (
        "--force", "--force-with-lease", "--deleted", "--delete", "--allow-new", "--allow-empty", "--once",
        "rm -rf dist", "trash dist", "jj bookmark forget x", "jj abandon x", "wrangler rollback", "rollback.sh --now",
        "wrangler delete", "wrangler secret put X", "echo secret", "op read op://a/b/c", "secretspec get X", "secretspec set X", "secretspec check", "secretspec run -f x -- ls",
        "secretspec run --profile x -- ls", "secretspec run -- printenv", "secretspec run -- env", "printenv X", "echo $CLOUDFLARE_API_TOKEN", 'printf "%s" "${MY_SECRET}"', "cat .env", "cat apps/page/.dev.vars", "cat /proc/self/environ",
        "d1 execute db --command x", "wrangler d1 execute db --command x", "jj -R . abandon x",
        "git push -f origin x", "git push origin +x", "jj git push -f", "eval echo", "ssh box ls", "command eval echo",
        "node -e x", "node --eval x", "nodejs -p x", "python3 -c x", "python -Sc x", "perl -pe x", "ruby -e x", "bun -e x", "deno eval x", "uv run python -c x",
    )

    def test_each_in_the_command(self):
        for word in self.WORDS:
            self.refused(f"wrangler deploy; {word}", "never")

    def test_each_in_a_script_it_runs(self):
        for word in self.WORDS:
            self.refused(f"bash {self.script(f'wrangler deploy\n{word}\n')}", "never")

    def test_each_in_a_script_a_script_runs(self):
        inner = self.script("echo --force\n", "inner.sh")
        self.refused(f"bash {self.script(f'bash {inner}\nwrangler deploy\n')}", "never")

    def test_what_only_looks_like_one_stays_out(self):
        for text in ("[ -f dist/x ] || exit 1\nwrangler deploy\n", "docker run --rm x\nwrangler deploy\n", "cp -f a b\nwrangler deploy\n", "echo no-op done\nwrangler deploy\n", "echo evaluate; echo sshd\nwrangler deploy\n", "secretspec run -- ls\nwrangler deploy\n", "echo $HOME\nwrangler deploy\n", "python3 tool.py\nwrangler deploy\n"):
            self.assertEqual(self.kind(f"bash {self.script(text)}")["kind"]["action"], "deploy", text)

    def test_the_deploy_of_the_31st_as_it_was_written_is_a_kind(self):
        kit = "#!/bin/sh\nset -eu\nsecretspec run -- sh -c 'cd apps/page && wrangler deploy -c dist/server/wrangler.json --keep-vars'\n"
        path = self.script(kit)
        out = self.kind(f"bash {path}")
        self.assertEqual(out["kind"], {"action": "deploy", "repo": self.repo})
        self.assertEqual(out["scripts"], [{"path": str(path), "sha256": hashlib.sha256(kit.encode()).hexdigest()}])

    def test_the_same_deploy_outside_the_workspace_gets_no_kind(self):
        kit = "secretspec run -- sh -c 'cd apps/page && wrangler deploy -c ../../../elsewhere/wrangler.json --keep-vars'\n"
        self.refused(f"bash {self.script(kit)}", "redirect")

    def test_secretspec_leads_a_deploy_in_exactly_one_form(self):
        self.assertEqual(self.kind("secretspec run -- wrangler deploy")["kind"]["action"], "deploy")
        self.assertEqual(self.kind("secretspec run -- sh -c 'wrangler deploy'")["kind"]["action"], "deploy")
        for command in ("secretspec run -f x -- wrangler deploy", "secretspec --profile x run -- wrangler deploy"):
            self.refused(command, "never")


class Scripts(MatchCase):
    def test_a_generated_script_is_read_and_hashed(self):
        text = "#!/bin/sh\nset -eu\nvp build\nwrangler deploy\n"
        path = self.script(text)
        out = self.kind(f"bash {path}")
        self.assertEqual(out["kind"], {"action": "deploy", "repo": self.repo})
        self.assertEqual(out["scripts"], [{"path": str(path), "sha256": hashlib.sha256(text.encode()).hexdigest()}])

    def test_a_script_it_runs_is_hashed_too(self):
        inner = self.script("wrangler deploy\n", "inner.sh")
        outer = self.script(f"bash {inner}\n", "outer.sh")
        self.assertEqual({s["path"] for s in self.kind(f"bash {outer}")["scripts"]}, {str(inner), str(outer)})

    def test_a_call_with_no_script_binds_none(self):
        self.assertEqual(self.kind("wrangler deploy")["scripts"], [])

    def test_a_script_it_cannot_read_gives_no_kind(self):
        third = self.script("echo --force\n", "third.sh")
        second = self.script(f"bash {third}\n", "second.sh")
        first = self.script(f"bash {second}\nwrangler deploy\n", "first.sh")
        big = self.script("wrangler deploy\n" + "# pad\n" * 50000, "big.sh")
        (self.scratch / "glob-a.sh").write_text("echo a\n")
        for command in (
            f"bash {first}", f"bash {big}", f"bash {self.scratch}/gone.sh; wrangler deploy", f"bash $NOPE/x.sh; wrangler deploy",
            f"bash {self.scratch}/glob-*.sh; wrangler deploy", f"bash {self.script('wrangler deploy\n', 'twice.sh')}; bash {self.scratch}/twice.sh",
            f"echo x > {self.scratch}/written.sh; bash {self.scratch}/written.sh; wrangler deploy",
        ):
            self.refused(command)

    def test_a_shell_fed_from_stdin_gives_no_kind(self):
        self.refused("wrangler deploy; bash <<EOF\nwrangler deploy --name other\nEOF\n", "stdin")
        self.refused("wrangler deploy; curl -s x | sh", "stdin")
        self.refused("wrangler deploy; bash -s < x", "stdin")


class Count(MatchCase):
    def test_zero_gives_no_kind(self):
        for command in ("ls -la", "wrangler deploy --dry-run", "wrangler deployments status", "git push origin x", "echo wrangler deploy"):
            self.refused(command, "no deploy")

    def test_two_give_no_kind(self):
        self.refused("wrangler deploy && wrangler deploy", "2 ")
        self.refused(f"wrangler deploy && jj git push --bookmark land", "2 ")
        self.refused(f"bash {self.script('wrangler deploy\njust deploy\n')}", "2 ")
        self.refused("wrangler deploy; npx wrangler@4 deploy", "2 ")


class Push(MatchCase):
    def test_a_fast_forward_is_a_kind_with_its_bookmark(self):
        kind = {"action": "push", "repo": self.repo, "bookmark": "land"}
        self.assertEqual(self.kind("jj git push --bookmark land")["kind"], kind)
        self.assertEqual(self.kind("jj git push -b land --remote origin", cwd=self.second)["kind"], kind)
        self.assertEqual(self.kind("jj git push --bookmark=land --remote=origin")["kind"], kind)
        self.assertEqual(self.kind(f"jj -R {self.second} git push --bookmark land", cwd=self.scratch)["kind"], kind)

    def test_not_a_fast_forward_gives_no_kind(self):
        self.refused("jj git push --bookmark rewritten", "fast-forward")

    def test_a_bookmark_origin_does_not_have_gives_no_kind(self):
        self.refused("jj git push --bookmark fresh", "fast-forward")

    def test_any_other_form_gives_no_kind(self):
        for command in (
            "jj git push", "jj git push --all", "jj git push --tracked", "jj git push -c @", "jj git push -r @", "jj git push --bookmark land --remote other",
            "jj git push --bookmark land --bookmark fresh", "jj git push --bookmark 'glob:*'", "jj --ignore-immutable git push --bookmark land",
        ):
            self.refused(command)


class Restart(MatchCase):
    def test_one_service_exactly(self):
        self.assertEqual(self.kind("systemctl restart fleet-host")["kind"], {"action": "restart", "repo": self.repo, "service": "fleet-host"})
        self.assertEqual(self.kind("systemctl --user restart fleet-host.service")["kind"]["service"], "fleet-host")
        self.assertEqual(self.kind("sudo systemctl restart caddy")["kind"]["service"], "caddy")

    def test_any_other_form_gives_no_kind(self):
        for command in ("systemctl restart a b", "systemctl -H box restart a", "systemctl restart 'a*'"):
            self.refused(command)


class Hidden(MatchCase):
    """What the reader cannot see. Alone, a hidden deploy gets no kind. Beside a deploy it can see, what stays in ESCAPES gets the
    kind of the one it sees, and the hook's and the classifier's are the guards left on that path."""

    BURIED = (
        "python3 deploy.py", "node deploy.js", "W=wrangler; $W deploy", "f() { wrangler deploy; }; g", "function f { wrangler deploy; }; f",
    )
    ESCAPES = ("python3 other.py", "node other.js", "make other", "find . -exec wrangler deploy --name other \\;", "export CLOUDFLARE_ENV=prod", "awk 'BEGIN{system(\"wrangler deploy --name other\")}'")

    def test_alone_it_gets_no_kind(self):
        for command in self.BURIED:
            self.assertNotIn("kind", self.match(command), command)

    def test_beside_a_deploy_it_can_see_it_escapes(self):
        for hidden in self.ESCAPES:
            self.assertEqual(self.kind(f"wrangler deploy; {hidden}")["kind"]["action"], "deploy", hidden)

    def test_beside_a_deploy_it_can_see_what_it_can_tell_is_hidden_refuses(self):
        for hidden in ("W=wrangler; $W deploy --name other", "$(which wrangler) deploy --name other", "f() { rm -rf /; }; f", "alias x=y"):
            self.refused(f"wrangler deploy; {hidden}")

    def test_a_recipe_a_task_and_a_package_script_are_taken_by_name(self):
        (self.scratch / "justfile").write_text("deploy:\n\twrangler deploy --name other\n\trm -rf /\n")
        for command in ("just deploy", "pnpm deploy", "devenv tasks run fleet:deploy"):
            self.assertEqual(self.kind(command)["kind"]["action"], "deploy", command)

    def test_a_cd_that_may_not_run_is_taken_as_run(self):
        self.assertEqual(self.kind(f"false && cd {self.other}; wrangler deploy")["kind"]["repo"]["main"], str(self.other / ".jj" / "repo"))

    def test_a_program_by_path_is_not_read(self):
        program = self.script("#!/usr/bin/env node\nrun('wrangler deploy --name other')\n", "tool")
        self.assertEqual(self.kind(f"{program}; wrangler deploy")["kind"]["action"], "deploy")


class Input(MatchCase):
    def run_raw(self, text):
        return subprocess.run(["python3", "-I", str(PART), "match"], input=text, capture_output=True, text=True, env=self.env, check=False)

    def test_bad_input_is_a_refusal(self):
        for text in ("", "not json", "[]", '{"command": 1, "cwd": "/"}', '{"command": "ls"}', '{"command": "ls", "cwd": "relative"}'):
            done = self.run_raw(text)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(set(json.loads(done.stdout)), {"refused"}, text)

    def test_any_other_mode_is_a_usage_error(self):
        done = subprocess.run(["python3", "-I", str(PART)], input="", capture_output=True, text=True, env=self.env, check=False)
        self.assertEqual(done.returncode, 2)

    def test_the_session_variables_let_a_script_be_read(self):
        path = self.script("wrangler deploy\n")
        name = path.name
        out = self.kind(f"bash $CLAUDE_PROJECT_DIR/{name}", env={"CLAUDE_PROJECT_DIR": str(self.scratch)})
        self.assertEqual(out["scripts"][0]["path"], str(path))


if __name__ == "__main__":
    unittest.main()
