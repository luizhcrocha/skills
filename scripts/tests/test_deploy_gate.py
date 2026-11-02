"""fleet_deploy_gate (PreToolUse, Bash): in a session of a fleet, a production deploy with no approval is refused, whatever
auto mode says. Real files on disk, the real hook as a process; the classifier's table reads the hook's own function."""

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_tstack_hook as base  # noqa: E402

# The shape of the script auto mode let through on 10-31, cut to its lines that count: the deploy stands in a `sh -c` word
# behind secretspec, in a `$( )`, and `wrangler deployments status` is its read.
KIT = r"""#!/bin/sh
# Deploys the fleet page Worker, then reads wrangler deployments status until the new version serves 100%.
set -eu
W=/home/luizrocha/repos/luizhcrocha/fleet-ship
[ -z "$(cd $W && jj diff --summary)" ] || { echo "fleet-ship has local changes"; exit 1; }
secretspec run -f $W/secretspec.toml \
  --reason "coordinator: deploy the fleet page Worker, as Luiz chooses on its deploy card" \
  -- sh -c 'cd /x/apps/page && export CLOUDFLARE_API_TOKEN=$CF_WORKERS_EDIT_TOKEN
    out=$(node_modules/.bin/wrangler deploy -c dist/server/wrangler.json --keep-vars 2>&1) || { echo "$out"; exit 1; }
    for i in 1 2 3; do
      s=$(node_modules/.bin/wrangler deployments status -c dist/server/wrangler.json --json 2>/dev/null) || s=""
      sleep 10
    done'
"""
READS_ONLY = "#!/bin/sh\n# after wrangler deploy, this reads\nnode_modules/.bin/wrangler deployments status --json\necho 'wrangler deploy'\n"
NOW = "2026-01-05T09:05:00+00:00"
ASK_ID = "deploy-03900"  # the hook's clock at NOW, 1767603900 seconds, modulo 100000


class DeployGateCase(base.GrantCase):
    def setUp(self):
        super().setUp()
        self.project = self.settings.parent.parent
        self.env["CLAUDE_PROJECT_DIR"] = str(self.project)
        self.tasks = self.project / "tasks"
        self.tasks.mkdir()

    def script(self, name, text, folder=None):
        path = (folder or self.tasks) / name
        path.write_text(text)
        path.chmod(0o755)
        return path

    def before(self, command, payload=None, env=None, **extra):
        payload = payload or self.payload("PreToolUse", tool_name="Bash", tool_input={"command": command}, **extra)
        r = self.hook("PreToolUse", payload, env={"FLEET_NOW": NOW, "TZ": "UTC", **(env or {})})
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["hookSpecificOutput"] if r.stdout else None

    def refused(self, command, **extra):
        out = self.before(command, **extra)
        self.assertIsNotNone(out, command)
        self.assertEqual(out["permissionDecision"], "deny", command)
        return out["permissionDecisionReason"]

    def passes(self, command, **extra):
        self.assertIsNone(self.before(command, **extra), command)

    def ask(self, call, agent=""):
        fleet = f"{base.ROOT}/fleet/bin/fleet"
        return (f"{fleet} state {self.fleet} decision {ASK_ID} --kind permission --tool Bash --call {call}{agent} "
                f"--root {self.project} --title \"<the plain question>\" --why \"<what goes live, and what still runs on that repo>\" "
                "--recommend allow-once --reason \"<why this one is safe>\" --blocking")


class DeployRefusalTest(DeployGateCase):
    def test_the_script_of_the_31st_is_refused_and_told_the_ask(self):
        kit = self.script("deploy-kit1.sh", KIT)
        self.assertEqual(self.refused(f"bash {kit}"), (
            f"tstack: this command puts out a production deploy (`wrangler deploy`, in {kit}), and no approval stands for it. In a "
            "fleet a deploy runs only on the user's yes, whatever auto mode lets through. Ask with this command:\n\n"
            f"{self.ask(f"'bash {kit}'")}\n\n"
            "When its grant stands, run that call by itself, unchanged (coordinator skill, \"Ask for the permission before the call\")."))

    def test_a_deploy_found_by_name_is_asked_for_as_it_is(self):
        self.assertEqual(self.refused("wrangler deploy"), (
            "tstack: this command puts out a production deploy (`wrangler deploy`), and no approval stands for it. In a fleet a "
            "deploy runs only on the user's yes, whatever auto mode lets through. A command found by name is asked for as it is, "
            "and the card says its content is not bound. Ask with this command:\n\n"
            f"{self.ask("'wrangler deploy'")}\n\n"
            "When its grant stands, run that call by itself, unchanged (coordinator skill, \"Ask for the permission before the call\")."))
        self.assertIn(self.ask("'just deploy quip'"), self.refused("just deploy quip"))
        self.assertIn(self.ask("'cd /x && pnpm run deploy 2>&1'"), self.refused("cd /x && pnpm run deploy 2>&1"))

    def test_a_form_the_ask_cannot_hold_by_name_is_told_it_needs_a_script(self):
        for command in ("devenv tasks run fleet:deploy", "wrangler deploy | tail -3", "pnpm exec wrangler deploy", "CLOUDFLARE_API_TOKEN=x wrangler deploy",
                        "node_modules/.bin/wrangler deploy", "wrangler deploy --var A:$X"):
            with self.subTest(command=command):
                reason = self.refused(command)
                self.assertIn("put the command in a script at an absolute path, so the card can bind its file, then ask with this command:", reason)
                self.assertIn(self.ask(f"'bash {self.project}/tasks/deploy.sh'"), reason)

    def test_a_worker_sends_the_ask_to_its_coordinator(self):
        kit = self.script("deploy-kit1.sh", KIT)
        reason = self.refused(f"bash {kit}", agent_id="ab12cd34")
        self.assertIn("Send your coordinator this command to run, and stop there:", reason)
        self.assertIn(self.ask(f"'bash {kit}'", " --agent-id ab12cd34"), reason)
        direct = self.refused("wrangler deploy", agent_id="ab12cd34")
        self.assertIn("its content is not bound. Send your coordinator this command to run, and stop there:", direct)
        kept = self.refused("devenv tasks run fleet:deploy", agent_id="ab12cd34")
        self.assertIn("put the command in a script at an absolute path, so the card can bind its file, then send your coordinator", kept)

    def test_the_ask_keeps_the_arguments_of_the_call(self):
        kit = self.script("land.sh", KIT)
        for command, call in ((f"bash {kit} pipeline", f"'bash {kit} pipeline'"),
                              (f"bash {kit} pipeline --force 2>&1", f"'bash {kit} pipeline --force'"),
                              (f"timeout 60 bash {kit} 'two words'", f"\'bash {kit} \'\"\'\"\'two words\'\"\'\"\'\'"),
                              (f"cd {self.tasks} && ./land.sh a", f"'bash {kit} a'")):
            with self.subTest(command=command):
                self.assertIn(self.ask(call), self.refused(command))

    def test_arguments_no_card_can_hold_are_said_plainly(self):
        kit = self.script("land.sh", KIT)
        for command in (f"bash {kit} $X", f"bash {kit} 'a*'", f"sh -c 'bash {kit} pipeline'"):
            with self.subTest(command=command):
                reason = self.refused(command)
                self.assertIn("A card cannot hold this call as it stands", reason)
                self.assertIn("so it needs a script that takes no arguments: put the call in one, then ask with this command:", reason)
                self.assertIn(self.ask(f"'bash {self.project}/tasks/deploy.sh'"), reason)

    def test_each_printed_ask_is_one_the_cli_takes(self):
        kit = self.script("land.sh", KIT)
        for k, command in enumerate((f"bash {kit}", f"bash {kit} pipeline --force", "wrangler deploy", "just deploy quip", "pnpm run deploy", "devenv tasks run fleet:deploy")):
            with self.subTest(command=command):
                ask = next(line for line in self.refused(command).split("\n") if " decision " in line)
                if "tasks/deploy.sh" in ask:
                    self.script("deploy.sh", "#!/bin/sh\nwrangler deploy\n")
                done = subprocess.run(ask.replace(ASK_ID, f"deploy-{k}"), shell=True, capture_output=True, text=True, timeout=60,
                                      env={**os.environ, **self.env, "FLEET_NO_FORWARD": "1"})
                self.assertEqual(done.returncode, 0, done.stderr)

    def test_every_form_of_running_a_script_is_followed(self):
        kit = self.script("ship.sh", KIT)
        relative = kit.relative_to(self.project)
        for command in (f"bash {kit}", f"sh {kit}", f"{kit}", f"bash -eu {kit}", f". {kit}", f"source {kit}",
                        f"cd {self.tasks} && ./ship.sh", f"cd {self.tasks}; sh ship.sh", f"cd {self.project} && bash {relative} | tail -3",
                        f"timeout 60 bash {kit} 2>&1 | tee /tmp/log", f"(cd {self.tasks} && bash ship.sh)", f"ls; bash {kit}; ls"):
            with self.subTest(command=command):
                self.assertIn(f"(`wrangler deploy`, in {kit})", self.refused(command))

    def test_a_path_the_call_assigned_is_followed(self):
        kit = self.script("ship.sh", KIT)
        gate = self.script("gate-deploy-12b0.sh", READS_ONLY)
        for command in (f"S={self.tasks}; bash $S/ship.sh", f"S={self.tasks}\nbash ${{S}}/ship.sh > $S/log 2>&1", f"W={self.tasks}; cd $W && ./ship.sh",
                        f"P={self.project}; S=$P/tasks; sh $S/ship.sh", f"S={self.tasks}; bash -c 'bash $S/ship.sh'"):
            with self.subTest(command=command):
                self.assertIn(f"(`wrangler deploy`, in {kit})", self.refused(command))
        self.passes(f"S={self.tasks}; bash $S/{gate.name}")
        home = Path(self.env["HOME"])
        home.mkdir(exist_ok=True)
        self.script("ship.sh", KIT, home)
        self.assertIn("`wrangler deploy`", self.refused("bash ~/ship.sh"))
        self.assertIn("`wrangler deploy`", self.refused("bash $HOME/ship.sh"))

    def test_a_script_the_cwd_finds_is_followed(self):
        self.script("ship.sh", KIT, self.repo)
        self.assertIn("`wrangler deploy`", self.refused("./ship.sh", cwd=str(self.repo)))

    def test_a_symlinked_script_is_read_through_its_link(self):
        kit = self.script("ship.sh", KIT)
        link = self.tasks / "link.sh"
        link.symlink_to(kit)
        self.assertIn("`wrangler deploy`", self.refused(f"bash {link}"))

    def test_one_level_into_a_script_and_no_further(self):
        inner = self.script("inner.sh", KIT)
        outer = self.script("outer.sh", f"#!/bin/sh\necho start\nbash {inner}\n")
        self.assertIn(f"(`wrangler deploy`, in {outer})", self.refused(f"bash {outer}"))
        by_name = self.script("by-name.sh", "#!/bin/sh\nsh inner.sh\n")
        self.assertIn(f"in {by_name})", self.refused(f"bash {by_name}"))
        top = self.script("top.sh", f"#!/bin/sh\nbash {outer}\n")
        self.passes(f"bash {top}")

    def test_scripts_that_call_each_other_end(self):
        a = self.tasks / "a.sh"
        b = self.script("b.sh", f"#!/bin/sh\nbash {a}\n")
        self.script("a.sh", f"#!/bin/sh\nbash {b}\n")
        self.passes(f"bash {a}")

    def test_a_refused_call_takes_no_grant(self):
        self.write_settings({"permissions": {"allow": ["Bash(ls)", "Bash(just deploy)"]}})
        self.grant(rule="Bash(just deploy)")
        self.refused("wrangler deploy")
        self.assertFalse((self.fleet / "grants.taken").exists())


class WhatCountsTest(DeployGateCase):
    def setUp(self):
        super().setUp()
        self.mod = base.load_hook(onepw=False)

    def reaches(self, command):
        return [d.what for d in self.mod.deploys_of(command, str(self.tasks), self.env)]

    def test_the_list_is_short_and_explicit(self):
        self.assertEqual(self.mod.DEPLOYS, (
            "wrangler deploy", "wrangler versions deploy", "wrangler triggers deploy", "wrangler rollback",
            "devenv tasks run fleet:deploy", "devenv tasks run case:deploy", "devenv tasks run case:deploy:release",
            "just deploy", "just redeploy", "just deploy-beta", "just deploy-alpha-ui",
            "pnpm deploy", "pnpm deploy:beta", "pnpm deploy:ui", "pnpm deploy:migrate",
            "pulumi up", "modal deploy", "fly deploy", "flyctl deploy", "systemctl restart fleet-host"))

    def test_each_real_shape_of_a_deploy(self):
        for command, what in (
                ("wrangler deploy", "wrangler deploy"),
                ("node_modules/.bin/wrangler deploy -c dist/server/wrangler.json --keep-vars 2>&1", "wrangler deploy"),
                ("wrangler -c dist/w.json deploy", "wrangler deploy"),
                ("npx wrangler deploy --env production", "wrangler deploy"),
                ("pnpm exec wrangler deploy", "wrangler deploy"),
                ("pnpm --filter casos exec wrangler deploy", "wrangler deploy"),
                ("devenv-run env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler deploy", "wrangler deploy"),
                ("CLOUDFLARE_API_TOKEN=x wrangler deploy", "wrangler deploy"),
                ("timeout 300 wrangler deploy", "wrangler deploy"),
                ("nice -n 5 wrangler deploy", "wrangler deploy"),
                ("secretspec run -f s.toml --reason 'a deploy' -- wrangler deploy", "wrangler deploy"),
                ("op run --env-file=.env -- wrangler deploy", "wrangler deploy"),
                ("fleet fleets gate run --as p --wait 60 -- wrangler deploy", "wrangler deploy"),
                ("/x/fleet/bin/fleet fleets gate run --as p -- wrangler deploy", "wrangler deploy"),
                ("sh -c 'cd x && wrangler deploy'", "wrangler deploy"),
                ("sh -c 'out=$(wrangler deploy 2>&1)'", "wrangler deploy"),
                ("A=$(date +%s) wrangler deploy", "wrangler deploy"),
                ("devenv-run just deploy-beta", "just deploy-beta"),
                ("bash -lc 'wrangler deploy'", "wrangler deploy"),
                ("echo $(wrangler deploy)", "wrangler deploy"),
                ("if true; then wrangler deploy; fi", "wrangler deploy"),
                ("wrangler versions deploy 1a2b@100 -y", "wrangler versions deploy"),
                ("pnpm exec wrangler triggers deploy 2>&1 | tail -8", "wrangler triggers deploy"),
                ("wrangler rollback 1a2b -y", "wrangler rollback"),
                ("devenv tasks run fleet:deploy", "devenv tasks run fleet:deploy"),
                ("cd /x && devenv tasks run --show-output fleet:deploy 2>&1 | grep Uploaded", "devenv tasks run fleet:deploy"),
                ("RELEASE=c56a timeout 300 devenv tasks run case:deploy:release", "devenv tasks run case:deploy:release"),
                ("devenv tasks run case:deploy", "devenv tasks run case:deploy"),
                ("just deploy quip --no-sync", "just deploy"),
                ("just --justfile /x/justfile deploy", "just deploy"),
                ("just redeploy", "just redeploy"),
                ("env -u CLOUDFLARE_API_TOKEN direnv exec /x just deploy-beta", "just deploy-beta"),
                ("just deploy-alpha-ui", "just deploy-alpha-ui"),
                ("pnpm deploy", "pnpm deploy"),
                ("pnpm run deploy 2>&1 | grep -E 'ok'", "pnpm deploy"),
                ("npm run deploy", "pnpm deploy"),
                ("bun run deploy", "pnpm deploy"),
                ("pnpm --filter casos deploy:beta", "pnpm deploy:beta"),
                ("pnpm --filter ./servers/case-analysis deploy:ui", "pnpm deploy:ui"),
                ("pnpm run deploy:migrate", "pnpm deploy:migrate"),
                ("pulumi up -C ./x -s org/p/prod -y", "pulumi up"),
                ("nix develop path:/x --command pulumi up -y --skip-preview", "pulumi up"),
                (".venv/bin/modal deploy gliner_app.py", "modal deploy"),
                ("nohup .venv/bin/modal deploy embed_vllm.py > log 2>&1 &", "modal deploy"),
                ("fly deploy", "fly deploy"),
                ("flyctl deploy --remote-only", "flyctl deploy"),
                ("systemctl --user restart fleet-host", "systemctl restart fleet-host"),
                ("systemctl --user restart fleet-host@manager", "systemctl restart fleet-host"),
                ("systemctl --user restart fleet-host.service", "systemctl restart fleet-host"),
                ("systemctl --user restart fleet-host@manager.service", "systemctl restart fleet-host"),
                ("bash -euo pipefail -c 'wrangler deploy'", "wrangler deploy"),
                ("bash -o pipefail -c 'wrangler deploy'", "wrangler deploy"),
                ("sh -eu -c 'just deploy'", "just deploy"),
                ("pnpm -F casos deploy", "pnpm deploy"),
                ("pnpm --filter deploy deploy", "pnpm deploy"),
                ("pnpm -r deploy", "pnpm deploy"),
                ("npm --prefix x run deploy", "pnpm deploy"),
                ("xargs -0 wrangler deploy", "wrangler deploy"),
                ("xargs -n 1 wrangler deploy", "wrangler deploy"),
                ("env -u A wrangler deploy", "wrangler deploy"),
                ("timeout -k 5 60 wrangler deploy", "wrangler deploy"),
                ("sudo -u luiz just deploy", "just deploy")):
            with self.subTest(command=command):
                self.assertEqual(self.reaches(command), [what])

    def test_a_read_or_a_mention_is_no_deploy(self):
        self.script("deploy.sh", KIT)
        for command in (
                "jj status", "jj log -r @", "git log --oneline", "ls", "pwd", "wrangler deployments status", "wrangler deployments list",
                "wrangler deploy --dry-run", "wrangler deploy --dry-run --outdir dist", "pnpm exec wrangler deploy --dry-run -c x",
                "timeout 300 pnpm exec wrangler deploy --dry-run", "wrangler --help", "wrangler deploy --help", "wrangler rollback --help",
                "wrangler -h", "wrangler --version", "wrangler versions list", "wrangler versions upload", "wrangler versions view 1a",
                "wrangler secret list", "wrangler dev", "wrangler types", "wrangler kv key get deploy", "just deploy --dry-run",
                "just deploy-check", "just --show deploy", "just --list deploy", "just test deploy", "just", "pnpm run deploy:e2e", "pnpm run build",
                "pnpm test deploy", "devenv tasks run case:deploy:precheck", "devenv tasks run --show-output case:deploy:precheck --input folder=/x",
                "devenv tasks run fleet:build", "pulumi preview --diff", "pulumi stack ls", "modal deploy --help", "modal app list",
                "fly status", "systemctl --user is-active fleet-host", "systemctl --user status fleet-host", "journalctl --user -u fleet-host",
                "echo wrangler deploy", "echo 'wrangler deploy'", "printf 'just deploy\\n'", "grep -n 'wrangler deploy' README.md",
                "grep wrangler deploy.log", "rg -- 'wrangler deploy' docs", "timeout 10 grep wrangler deploy", "env LC_ALL=C grep -aoE 'wrangler deploy' f",
                "jj describe -m 'fix(deploy): wrangler deploy keeps vars'", "git commit -m 'wrangler deploy'", "jj describe -m wrangler",
                "cat deploy.sh", "cat tasks/deploy.sh | head", "sed -n 1,5p deploy.sh", "ls deploy.sh", "head deploy.sh", "wc -l deploy.sh",
                "echo done # wrangler deploy", "cat > notes.md <<'EOF'\nwrangler deploy\nEOF",
                "/x/fleet/bin/fleet chat /x/skills watch --as coordinator --all --resume --once",
                "fleet state /x decision deploy-1 --kind permission --tool Bash --call 'bash /abs/deploy.sh' --root /x --title 'Deploy?' --blocking",
                "fleet fleets gate take --as p 'deploy repo' --mem 512M --for 10 --wait 600", "fleet fleets gate run --as p -- just test",
                "pgrep -a -f 'wrangler deploy'", "curl -s https://example.com/deploy",
                "tasks/deploy-worker --digest", "tasks/deploy-worker --release", "tasks/deploy-worker --preflight", "tasks/deploy-worker --dry-run",
                "devenv shell -- bash -c 'tasks/deploy-worker --digest 2>&1 | tail -2'", "timeout 60 tasks/deploy-worker --digest",
                "bash -n tasks/deploy.sh", "sh -n tasks/gold-run/deploy.sh", "bash -n tasks/deploy-w*r",
                "f=$(ls /x/deploy-card-b11.md 2>/dev/null); grep -n x $f | head -30", "F=$(ls tasks/deploy-worker) x",
                "xargs -r grep -n x tasks/deploy-worker", "env -i grep -n x tasks/deploy-worker", "pnpm --filter ./deploy-tools build",
                "bash /x/deploy-704567e1/tier.sh abc", "$M/src/wrangler.jsonc | grep x",
                "pnpm --filter deploy test", "pnpm -F deploy build", "pnpm --dir deploy test", "npm --prefix deploy test",
                "xargs -0 grep -l wrangler deploy", "xargs -r grep -n wrangler deploy", "xargs -n 1 echo just deploy",
                "env -u wrangler deploy", "timeout -s KILL 5 grep wrangler deploy"):
            with self.subTest(command=command):
                self.assertEqual(self.reaches(command), [])

    def test_a_script_that_only_reads_or_mentions_is_no_deploy(self):
        reads = self.script("deploy-status.sh", READS_ONLY)
        dry = self.script("deploy-check.sh", "#!/bin/sh\nwrangler deploy --dry-run\n")
        gate = self.script("gate-ship.sh", "#!/bin/sh\nfleet fleets gate run --as p --wait 600 -- just test\necho after the deploy\n")
        for path in (reads, dry, gate):
            with self.subTest(path=path):
                self.assertEqual(self.reaches(f"bash {path}"), [])

    def test_a_program_that_is_no_shell_script_is_not_read_as_one(self):
        node = self.script("tool", "#!/usr/bin/env node\n// run: wrangler deploy\nconsole.log('wrangler deploy');\n")
        binary = self.script("bin", "x")
        binary.write_bytes(b"\x7fELF\0\0wrangler deploy\n")
        self.assertEqual(self.reaches(f"{node}"), [])
        self.assertEqual(self.reaches(f"{binary}"), [])
        self.assertEqual(self.reaches(f"node {node}"), [])

    def test_a_source_file_a_runner_takes_is_not_read_as_a_shell(self):
        lines = "just deploy\nwrangler deploy\n"
        for name in ("probe.ts", "probe.tsx", "probe.js", "probe.mjs", "probe.py"):
            path = self.script(name, f"// a line in a template\n{lines}")
            for command in (f"bun ./{name}", f"bun ../tasks/{name}", f"pnpm exec ./{name}", f"./{name}", f"bun {path}"):
                with self.subTest(command=command):
                    self.assertEqual(self.reaches(command), [])

    def test_a_shebang_is_read_for_the_name_of_its_interpreter(self):
        lines = "just deploy\n"
        for line in ("#!/usr/bin/env node", "#!/usr/bin/env -S bun run", "#!/usr/local/shim/bun", "#!/home/rush/bin/python3"):
            with self.subTest(line=line):
                self.assertEqual(self.reaches(f"./{self.script('tool', f'{line}\n{lines}').name}"), [])
        for line in ("#!/bin/sh", "#! /bin/bash", "#!/usr/bin/env bash", "#!/usr/bin/env -S bash -eu", "#!/usr/bin/env -i zsh", "#!/nix/store/abc-bash/bin/bash -e", "#!/usr/bin/env nu", "#!/usr/bin/env fish"):
            with self.subTest(line=line):
                self.assertEqual(self.reaches(f"./{self.script('tool', f'{line}\n{lines}').name}"), ["just deploy"])

    def test_a_source_file_with_a_shells_shebang_is_a_shell_script(self):
        self.script("ship.ts", "#!/bin/sh\nwrangler deploy\n")
        self.script("ship.py", "#!/usr/bin/env bash\nwrangler deploy\n")
        for command in ("./ship.ts", "bash ship.ts", "bun ./ship.py"):
            with self.subTest(command=command):
                self.assertEqual(self.reaches(command), ["wrangler deploy"])

    def test_a_shell_option_with_a_value_hides_no_script(self):
        kit = self.script("ship.sh", KIT)
        for command in (f"bash -euo pipefail {kit}", f"bash -o pipefail {kit}", f"bash -O extglob {kit}", f"bash -- {kit}"):
            with self.subTest(command=command):
                self.assertEqual(self.reaches(command), ["wrangler deploy"])
        self.assertEqual(self.reaches(f"bash -o pipefail -n {kit}"), [])

    def test_a_deploy_is_found_past_a_function_a_case_and_an_array(self):
        for text, what in (("deploy() {\n  wrangler deploy\n}\ndeploy\n", "wrangler deploy"),
                           ('case "$1" in\n  a) wrangler deploy ;;\n  b) echo b ;;\nesac\n', "wrangler deploy"),
                           ('local cmd=(pulumi up -C "$d" -s "$s")\n"${cmd[@]}"\n', "pulumi up"),
                           ('(cd "$server_dir" && pnpm deploy)\n', "pnpm deploy")):
            with self.subTest(text=text):
                self.assertEqual(self.reaches(f"bash {self.script('s.sh', '#!/bin/bash\n' + text)}"), [what])


class ScriptFlagTest(DeployGateCase):
    def test_a_flag_the_script_does_not_name_is_no_read(self):
        kit = self.script("deploy-kit1.sh", KIT)
        for flag in ("--help", "-h", "--dry-run", "--version", "--list", "--show"):
            with self.subTest(flag=flag):
                self.assertIn("(`wrangler deploy`", self.refused(f"bash {kit} {flag}"))
                self.assertIn("(`wrangler deploy`", self.refused(f"{kit} {flag}"))

    def test_a_flag_the_script_handles_is_no_read_either(self):
        for name, text in (("deploy-cases.sh", '#!/bin/sh\ncase "$1" in\n  --help) echo usage; exit ;;\nesac\nwrangler deploy\n'),
                           ("deploy-note.sh", "#!/bin/sh\n# supports --help\nwrangler deploy\n"),
                           ("deploy-echo.sh", "#!/bin/sh\necho try --help\nwrangler deploy\n")):
            with self.subTest(name=name):
                self.assertIn("(`wrangler deploy`", self.refused(f"bash {self.script(name, text)} --help"))

    def test_one_file_run_twice_is_held_to_each_call(self):
        kit = self.script("deploy-cases.sh", "#!/bin/sh\n[ \"$1\" = --help ] && exit\nwrangler deploy\n")
        self.assertIn("(`wrangler deploy`", self.refused(f"bash {kit} --help; bash {kit}"))


class ApprovalTest(DeployGateCase):
    def test_a_standing_grant_for_the_exact_call_lets_it_through_for_one_run(self):
        kit = self.script("deploy-kit1.sh", KIT)
        rule = f"Bash(bash {kit})"
        self.write_settings({"permissions": {"allow": [rule]}})
        self.grant(rule=rule, at="2026-01-05T09:00:00+00:00")
        self.assertIsNone(self.before(f"bash {kit}"))
        self.assertTrue((self.fleet / "grants.taken").exists() or list(self.fleet.glob("grants.taken*")))
        self.assertIn("this call", self.refused(f"bash {kit}"))

    def test_an_allow_kind_answer_grants_as_allow_once_does(self):
        self.write_settings({"permissions": {"allow": ["Bash(just deploy)"]}})
        self.grant(decision="p-kind", rule="Bash(just deploy)")
        self.ledger(decisions=[{"id": "p-kind", "kind": "permission", "status": "decided", "answer": "allow-kind", "kind_requested": True}])
        self.assertIsNone(self.before("just deploy"))

    def test_a_grant_of_another_call_lets_nothing_through(self):
        self.write_settings({"permissions": {"allow": ["Bash(just deploy-beta)"]}})
        self.grant(rule="Bash(just deploy-beta)")
        self.assertIn("(`wrangler deploy`)", self.refused("wrangler deploy"))

    def test_a_grant_on_no_record_lets_nothing_through(self):
        self.write_settings({"permissions": {"allow": ["Bash(just deploy)"]}})
        self.grant(rule="Bash(just deploy)", issued=False)
        self.assertIn("(`just deploy`)", self.refused("just deploy"))

    def test_a_grant_already_used_is_no_owners_rule(self):
        self.write_settings({"permissions": {"allow": ["Bash(just deploy)"]}})
        self.grant(rule="Bash(just deploy)")
        self.assertIsNone(self.before("just deploy"))
        self.run_tool("just deploy", now=NOW)
        self.assertEqual(self.allow(), [])
        self.assertIn("(`just deploy`)", self.refused("just deploy"))

    def test_an_owners_rule_keeps_working(self):
        land = "/home/luizrocha/.local/state/infra-coordinator/land-deploy.sh"
        for rule, command in (("Bash(wrangler deploy)", "wrangler deploy"),
                              (f"Bash(bash {land} *)", f"bash {land} pipeline 2>&1"),
                              ("Bash(just deploy:*)", "just deploy quip"),
                              ("Bash(pnpm run deploy)", "cd /x && pnpm run deploy 2>&1 | tail -3")):
            with self.subTest(rule=rule):
                self.write_settings({"permissions": {"allow": [rule]}})
                self.assertIsNone(self.before(command))

    def test_an_owners_rule_in_the_shared_settings_and_at_home(self):
        (self.settings.parent / "settings.json").write_text(json.dumps({"permissions": {"allow": ["Bash(just deploy)"]}}))
        self.assertIsNone(self.before("just deploy"))
        home = Path(self.env["HOME"]) / ".claude"
        home.mkdir(parents=True, exist_ok=True)
        (home / "settings.json").write_text(json.dumps({"permissions": {"allow": ["Bash(pulumi up *)"]}}))
        self.assertIsNone(self.before("pulumi up -y"))

    def test_an_owners_rule_for_one_deploy_of_two_clears_neither(self):
        self.write_settings({"permissions": {"allow": ["Bash(just deploy)"]}})
        self.assertIn("(`wrangler deploy`)", self.refused("just deploy; wrangler deploy"))

    def test_a_rule_of_another_tool_or_a_broken_settings_file_clears_nothing(self):
        self.write_settings({"permissions": {"allow": ["Read(just deploy)", "Bash(just deploy-beta)"]}})
        self.assertIn("(`just deploy`)", self.refused("just deploy"))
        self.settings.write_text("{ not json")
        self.assertIn("(`just deploy`)", self.refused("just deploy"))

    def test_a_grant_held_inside_more_is_told_only_to_run_it_alone(self):
        kit = self.script("deploy-kit1.sh", KIT)
        for command, rule in ((f"bash {kit} 2>&1 | tail -3", f"Bash(bash {kit})"), ("cd /x && just deploy", "Bash(just deploy)")):
            with self.subTest(command=command):
                self.write_settings({"permissions": {"allow": [rule]}})
                self.grant(rule=rule, at="2026-01-05T09:00:00+00:00")
                reason = self.refused(command)
                self.assertIn("run it by itself", reason)
                self.assertNotIn("no approval stands", reason)
                self.assertNotIn(" decision ", reason)

    def test_a_list_of_then_calls_is_run_in_its_order(self):
        self.write_settings({"permissions": {"allow": ["Bash(just build)", "Bash(just deploy)"]}})
        self.grant(rule="Bash(just build)")
        self.grant(rule="Bash(just deploy)")
        reason = self.refused("just deploy")
        self.assertIn("just build", reason)
        self.assertNotIn("production deploy", reason)
        self.assertIsNone(self.before("just build"))
        self.run_tool("just build", now=NOW)
        self.assertIsNone(self.before("just deploy"))

    def test_a_card_answered_no_gives_no_way_through(self):
        self.ledger(decisions=[{"id": "p-no", "kind": "permission", "status": "decided", "answer": "deny",
                                "refusal": {"tool": "Bash", "call": "wrangler deploy", "rule": "Bash(wrangler deploy)"}}])
        self.assertIn("(`wrangler deploy`)", self.refused("wrangler deploy"))


class WhoTest(DeployGateCase):
    def test_a_session_of_no_fleet_is_untouched(self):
        payload = self.base("PreToolUse", tool_name="Bash", tool_input={"command": "wrangler deploy"}, session_id="by-hand",
                            scratchpad_dir=str(self.tmp / "other-pad"))
        self.assertIsNone(self.before("", payload=payload))

    def test_a_session_by_hand_in_a_fleet_repo_stays_free(self):
        pad = self.tmp / "by-hand-pad"
        (pad / "copy").mkdir(parents=True)
        (pad / "copy" / "state.json").write_text((self.fleet / "state.json").read_text())
        payload = self.base("PreToolUse", tool_name="Bash", tool_input={"command": "wrangler deploy"}, session_id="by-hand",
                            scratchpad_dir=str(pad), cwd=str(self.project))
        self.assertIsNone(self.before("", payload=payload))

    def test_a_subagent_of_a_session_of_no_fleet_is_untouched(self):
        payload = self.base("PreToolUse", tool_name="Bash", tool_input={"command": "wrangler deploy"}, session_id="by-hand",
                            agent_id="ab12cd34")
        self.assertIsNone(self.before("", payload=payload))

    def test_a_worker_process_of_a_fleet_is_held(self):
        payload = self.base("PreToolUse", tool_name="Bash", tool_input={"command": "wrangler deploy"}, session_id="a-worker")
        self.assertIn("(`wrangler deploy`)", self.before("", payload=payload, env={"FLEET_DIR": str(self.fleet)})["permissionDecisionReason"])

    def test_a_moved_coordinator_is_held(self):
        (self.fleet / "cloud.json").write_text(json.dumps({"fleet": "p"}))
        self.assertIn("(`wrangler deploy`)", self.refused("wrangler deploy"))

    def test_a_moved_session_that_left_the_registry_is_held(self):
        home = self.tmp / "state" / "fleet" / "moved"
        home.mkdir(parents=True)
        (home / "state.json").write_text((self.fleet / "state.json").read_text())
        (home / "cloud.json").write_text(json.dumps({"fleet": "moved"}))
        env = {"XDG_STATE_HOME": str(self.tmp / "state")}
        self.register(home, id="moved")
        self.assertIsNone(self.before("jj status", env=env))  # the session remembers the home's folder it served
        (self.registry / "moved.json").unlink()
        (self.registry / "p.json").unlink()
        self.assertIn(str(home), self.before("wrangler deploy", env=env)["permissionDecisionReason"])

    def test_a_monitor_stays_the_watch_rules(self):
        payload = self.payload("PreToolUse", tool_name="Monitor", tool_input={"command": "wrangler deploy"})
        reason = self.before("", payload=payload)["permissionDecisionReason"]
        self.assertNotIn("production deploy", reason)

    def test_another_tool_is_untouched(self):
        payload = self.payload("PreToolUse", tool_name="Write", tool_input={"command": "wrangler deploy", "file_path": "/x"})
        self.assertIsNone(self.before("", payload=payload))


class NameTest(DeployGateCase):
    """A script's name decides only where the file cannot be: its path is not known yet, or this call writes it."""

    SPLIT = "Split the call"

    def test_a_file_that_is_not_there_cannot_run_and_passes(self):
        self.script("deploy-env.sh.bak", "wrangler deploy\n")
        for command in ("./deploy-gone.sh", "source deploy-env.sh", ". deploy-env.sh", "bash undeploy-old.sh", f"bash {self.tasks}/deploy-x.sh",
                        f"sh {self.tasks}/rollback.sh", f"cd {self.tasks} && ./deploy-gone.sh"):
            with self.subTest(command=command):
                self.passes(command, cwd=str(self.tasks))

    def test_a_file_named_for_a_deploy_whose_text_holds_none_passes(self):
        status = self.script("deploy-status.sh", "#!/bin/sh\ncurl -s https://x.example/health\n")
        env = self.script("deploy-env.sh", "A=1\n")
        binary = self.script("deploy-bin", "x")
        binary.write_bytes(b"\x7fELF\0\0")
        for command in (f"bash {status}", f"source {env}", f". {env}", f"{binary}", 'bash "$CLAUDE_PROJECT_DIR/tasks/deploy-status.sh"',
                        "bash $CLAUDE_PROJECT_DIR/tasks/deploy-status.sh", "S=$(pwd); bash $S/deploy-status.sh", "S=`pwd`; bash $S/deploy-status.sh",
                        'S="$(pwd)"; bash "$S/deploy-status.sh"', "bash $PWD/deploy-status.sh", f"cd {self.project}; S=$(pwd)/tasks; bash $S/deploy-status.sh"):
            with self.subTest(command=command):
                self.passes(command, cwd=str(self.tasks))

    def test_a_file_that_cannot_be_read_passes(self):
        locked = self.script("deploy-locked.sh", "#!/bin/sh\nwrangler deploy\n")
        locked.chmod(0)
        (self.tasks / "deploy-dir").mkdir()
        huge = self.script("deploy-huge.sh", "#!/bin/sh\n" + "# padding\n" * 400000)
        for path in (locked, self.tasks / "deploy-dir", huge):
            with self.subTest(path=path):
                self.passes(f"bash {path}")

    def test_a_variable_of_the_session_finds_the_script(self):
        kit = self.script("ship.sh", KIT)
        outer = self.script("outer.sh", '#!/bin/sh\nbash "$CLAUDE_PROJECT_DIR/tasks/ship.sh"\n')
        for command, script in (('bash "$CLAUDE_PROJECT_DIR/tasks/ship.sh"', kit), ("bash ${CLAUDE_PROJECT_DIR}/tasks/ship.sh", kit),
                                ("S=$(pwd); bash $S/ship.sh", kit), (f"bash {outer}", outer)):
            with self.subTest(command=command):
                self.assertIn(f"(`wrangler deploy`, in {script})", self.refused(command, cwd=str(self.tasks)))

    def test_a_path_not_known_until_it_runs_refuses_by_name_and_says_to_split(self):
        for command in ("bash $D/deploy-kit1.sh", "$S/deploy-ship.sh > $S/log 2>&1", "D=$(mktemp -d); bash $D/deploy.sh", "bash `which x`/rollback.sh"):
            with self.subTest(command=command):
                reason = self.refused(command)
                self.assertIn(self.SPLIT, reason)
                self.assertNotIn(" decision ", reason)
        for command in ("bash $D/gate-ship.sh", "bash $D", "D=$(mktemp -d); bash $D/ship.sh"):
            with self.subTest(command=command):
                self.passes(command)

    def test_a_file_this_call_writes_refuses_by_name_and_says_to_split(self):
        for command in (f"cat > {self.tasks}/deploy-new.sh <<'EOF'\nwrangler deploy\nEOF\nbash {self.tasks}/deploy-new.sh",
                        "echo x > deploy-new.sh; bash deploy-new.sh", "echo x >> deploy-new.sh && ./deploy-new.sh",
                        "printf x | tee deploy-new.sh; sh deploy-new.sh", "cp /x/y deploy-new.sh && bash deploy-new.sh",
                        "mv /x/y ./deploy-new.sh; bash ./deploy-new.sh", "S=/x; echo y > $S/deploy-new.sh; bash $S/deploy-new.sh"):
            with self.subTest(command=command):
                reason = self.refused(command, cwd=str(self.tasks))
                self.assertIn(self.SPLIT, reason)
                self.assertNotIn(" decision ", reason)

    def test_a_file_on_disk_this_call_rewrites_is_held_to_the_write(self):
        status = self.script("deploy-status.sh", "#!/bin/sh\necho up\n")
        self.assertIn(self.SPLIT, self.refused(f"echo wrangler deploy > {status}; bash {status}"))

    def test_a_write_that_is_not_the_script_changes_nothing(self):
        status = self.script("deploy-status.sh", "#!/bin/sh\necho up\n")
        for command in (f"echo x > deploy.log; bash {status}", "echo x > deploy-new.sh; cat deploy-new.sh", "echo x > notes.sh; bash notes.sh",
                        "cat > probe-deploy.ts <<'EOF'\nx\nEOF\nbun ./probe-deploy.ts", "bash deploy-new.sh; echo x > deploy-new.sh"):
            with self.subTest(command=command):
                self.passes(command, cwd=str(self.tasks))


class FailureTest(DeployGateCase):
    def test_a_fifo_never_hangs(self):
        """On deploys_of in a process of its own with a time limit: land_turn_gate, ahead of this handler, blocks on a FIFO
        by itself until the guards' deadline."""
        for name in ("deploy-fifo.sh", "fifo.sh"):
            path = self.tasks / name
            os.mkfifo(path)
            read = ("import sys; sys.path.insert(0, sys.argv[1]); import test_tstack_hook as base; "
                    "mod = base.load_hook(onepw=False); print([d.what for d in mod.deploys_of(sys.argv[2], sys.argv[3], None)])")
            with self.subTest(name=name):
                done = subprocess.run([sys.executable, "-c", read, str(Path(__file__).parent), f"bash {path}", str(self.tasks)],
                                      capture_output=True, text=True, timeout=30, check=True)
                self.assertEqual(done.stdout.strip(), "[]")

    def test_an_unreadable_script_with_no_such_name_says_nothing(self):
        path = self.script("locked.sh", "#!/bin/sh\nwrangler deploy\n")
        path.chmod(0)
        self.passes(f"bash {path}")

    def test_a_command_that_does_not_parse(self):
        self.assertIn("(`wrangler deploy`)", self.refused("wrangler deploy 'open"))
        self.passes("echo 'open")

    def test_a_script_that_does_not_parse(self):
        named = self.script("named.sh", "#!/bin/sh\nwrangler deploy 'open\n")
        plain = self.script("plain.sh", "#!/bin/sh\necho 'open\n")
        self.assertIn(f"(`wrangler deploy`, in {named})", self.refused(f"bash {named}"))
        self.passes(f"bash {plain}")
        mention = self.script("mention.sh", "#!/bin/sh\necho 'open\necho wrangler deploy\n")
        self.passes(f"bash {mention}")

    def test_flags_past_flags_take_linear_time(self):
        """Each in a process of its own under a CPU limit the kernel holds, so a busy machine neither fails it nor hides it."""
        read = ("import resource, sys; resource.setrlimit(resource.RLIMIT_CPU, (4, 4)); sys.path.insert(0, sys.argv[1]); "
                "import test_tstack_hook as base; mod = base.load_hook(onepw=False); print(mod.deploys_of(sys.argv[2], '/nonexistent', None))")
        for command in ("wrangler " + "-x " * 20000, "wrangler " + "-x a " * 12000, "pnpm " + "-x " * 20000, "just " + "--a " * 15000 + "deploy --dry-run",
                        "env " + "-x " * 20000 + "wrangler " + "-y " * 500):
            with self.subTest(start=command[:20]):
                done = subprocess.run([sys.executable, "-c", read, str(Path(__file__).parent), command], capture_output=True, text=True, timeout=120)
                self.assertEqual(done.returncode, 0, done.stderr[-300:])

    def test_a_long_line_ends(self):
        for command in ("echo " + "a " * 200000, "timeout " * 20000 + "x", "timeout " * 7000 + "x", "'" + "a" * 400000 + "'",
                        "echo " + "'a' " * 100000, " ".join(["-x"] * 100000), "env " + "-x " * 50000 + "y"):
            with self.subTest(start=command[:20]):
                self.assertIsNone(self.before(command))

    def test_a_check_that_fails_denies_only_what_names_a_deploy(self):
        """A variable that holds a NUL gives a path the read cannot resolve: a real failure, and no other guard expands it."""
        reason = self.refused("S=/x/\0; bash $S/deploy.sh")
        self.assertIn("names a deploy, and the check of it failed", reason)
        self.assertIn("hook.log", reason)
        self.assertIn("fleet_deploy_gate failed", self.log())
        self.passes("S=/x/\0; bash $S/ship.sh")

    def test_it_stands_ahead_of_the_watch_and_the_grants(self):
        mod = base.load_hook(onepw=False)
        self.assertNotIn(mod.fleet_deploy_gate, mod.GUARDS)
        self.assertEqual(mod.HANDLERS["PreToolUse"][-3:], [mod.fleet_deploy_gate, mod.fleet_monitor_watch, mod.fleet_grant_alone])


class PartTest(DeployGateCase):
    """hooks/tstack-hook-deploy.py, the launcher and its bytecode, on a copy of the plugin's hooks."""

    PART = "tstack-hook-deploy.py"

    def plugin(self, *leave_out):
        hooks = self.tmp / "plugin" / "hooks"
        shutil.copytree(base.HOOK.parent, hooks, ignore=shutil.ignore_patterns("__pycache__", *leave_out))
        return hooks

    def run_hook(self, hooks, event, payload):
        return subprocess.run([str(hooks / "tstack-hook"), event], input=json.dumps(payload), capture_output=True, text=True,
                              env={**self.env, "FLEET_NOW": NOW, "TZ": "UTC"}, timeout=30)

    def bash(self, hooks, command):
        return self.run_hook(hooks, "PreToolUse", self.payload("PreToolUse", tool_name="Bash", tool_input={"command": command}))

    def kept(self, hooks):
        return sorted(p.name.split(".")[0] for p in (hooks / "__pycache__").iterdir())

    def test_only_a_bash_call_of_a_fleet_loads_the_part(self):
        hooks = self.plugin()
        self.run_hook(hooks, "SessionStart", self.base("SessionStart", source="startup"))
        self.run_hook(hooks, "Stop", self.base("Stop"))
        alone = self.base("PreToolUse", tool_name="Bash", tool_input={"command": "wrangler deploy"}, session_id="by-hand")
        self.assertEqual(self.run_hook(hooks, "PreToolUse", alone).stdout, "")
        write = self.payload("PreToolUse", tool_name="Write", tool_input={"command": "wrangler deploy", "file_path": "/x"})
        self.assertEqual(self.run_hook(hooks, "PreToolUse", write).stdout, "")
        self.assertEqual(self.kept(hooks), ["tstack-hook"])
        self.assertEqual(self.bash(hooks, "ls").stdout, "")
        self.assertEqual(self.kept(hooks), ["tstack-hook", "tstack-hook-deploy"])

    def test_the_kept_bytecode_is_what_runs_the_part(self):
        hooks = self.plugin()
        self.assertIn("(`wrangler deploy`)", self.bash(hooks, "wrangler deploy").stdout)
        (pyc,) = (hooks / "__pycache__").glob("tstack-hook-deploy.*")
        kept = pyc.stat().st_mtime_ns
        self.assertIn("(`wrangler deploy`)", self.bash(hooks, "wrangler deploy").stdout)
        self.assertEqual(pyc.stat().st_mtime_ns, kept)

    def test_a_cut_short_bytecode_runs_from_source_and_is_rewritten(self):
        hooks = self.plugin()
        self.bash(hooks, "ls")
        (pyc,) = (hooks / "__pycache__").glob("tstack-hook-deploy.*")
        pyc.write_bytes(pyc.read_bytes()[:40])  # its header holds, its code is cut: marshal's EOFError
        for _ in range(2):
            r = self.bash(hooks, "wrangler deploy")
            self.assertEqual((r.returncode, r.stderr), (0, ""))
            self.assertIn("(`wrangler deploy`)", r.stdout)
        self.assertGreater(pyc.stat().st_size, 40)
        self.assertNotIn("fleet_deploy_gate failed", self.log())

    @unittest.skipIf(os.geteuid() == 0, "root writes through a read-only folder")
    def test_a_read_only_plugin_compiles_the_part_each_time(self):
        hooks = self.plugin()
        hooks.chmod(0o555)
        self.addCleanup(hooks.chmod, 0o755)
        r = self.bash(hooks, "wrangler deploy")
        self.assertEqual((r.returncode, r.stderr), (0, ""))
        self.assertIn("(`wrangler deploy`)", r.stdout)
        self.assertFalse((hooks / "__pycache__").exists())

    def test_a_part_that_does_not_load_blocks_nothing(self):
        for name, breaks in (("missing", lambda path: path.unlink()), ("broken", lambda path: path.write_text("def (\n")),
                             ("failing", lambda path: path.write_text("raise RuntimeError('a part that failed')\n"))):
            with self.subTest(name=name):
                hooks = self.plugin()
                breaks(hooks / self.PART)
                for command in ("ls", "wrangler deploy"):
                    r = self.bash(hooks, command)
                    self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""), command)
                self.assertIn("PreToolUse fleet_deploy_gate failed", self.log())
                shutil.rmtree(hooks.parent)
                (self.data / "hook.log").unlink()

    def test_the_part_never_allows_and_keeps_the_hooks_shells(self):
        self.assertNotIn("Allow", base.HOOK.with_name(self.PART).read_text())
        mod = base.load_hook(onepw=False)
        self.assertNotIn("deploys_of", vars(mod))
        shells = mod.SHELLS
        self.assertEqual(mod.SHELL_READS, shells | {".", "source"})  # the attribute reads the part
        self.assertIs(mod.SHELLS, shells)
        self.assertIn("deploys_of", vars(mod))


if __name__ == "__main__":
    unittest.main()
