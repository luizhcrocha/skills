#!/usr/bin/env python3
"""tstack's one hook dispatcher: `tstack-hook <Event>`, the hook JSON on stdin.

A handler is a small function `handler(hook) -> str | None` listed under its
event in HANDLERS; what the handlers of one event return is joined and emitted
in the shape that event takes (EMIT). A Stop handler that returns a Block
keeps the turn going instead (the block decision, its text the reason). To add
one, write the function and list it; a new event also goes in hooks.json
(async when nothing reads its output).

The rule that outranks the rest: a hook never breaks a session. Any error, in
a handler or in the dispatcher, is logged to ${CLAUDE_PLUGIN_DATA}/hook.log and
the process exits 0 having written nothing to stdout.
"""

import json
import os
import re
import sys
import time
import traceback
from collections import namedtuple
from pathlib import Path

ROOT = Path(os.environ.get("CLAUDE_PLUGIN_ROOT") or Path(__file__).resolve().parent.parent)
LOG_MAX = 512 * 1024


class Hook:
    """One invocation: the event, its input, and where this plugin keeps state."""

    def __init__(self, event, data, env):
        self.event = event
        self.input = data
        self.env = env
        state = env.get("XDG_STATE_HOME") or str(Path(env.get("HOME", "/tmp")) / ".local" / "state")
        self.data_dir = Path(env.get("CLAUDE_PLUGIN_DATA") or Path(state) / "tstack")
        self.session_id = str(data.get("session_id") or "")
        self._states = {}
        self._fleet_dirs = None
        self._grant_dirs = None
        self._served_dirs = None
        self._grant_state_dirs = None
        self._allows = {}
        self._ended = {}
        self._issued = {}
        self._grant_files = {}
        # Set once a PreToolUse handler has refused the call: fleet_grant_alone, the last one, then takes no grant for it.
        self.denied = False
        cwd = data.get("cwd")
        self.cwd = cwd if isinstance(cwd, str) and os.path.isabs(cwd) else (env.get("CLAUDE_PROJECT_DIR") or os.getcwd())
        # Inside a subagent the input carries agent_id: that is a worker.
        self.is_worker = bool(data.get("agent_id")) or env.get("TSTACK_ROLE") == "worker"
        self.quiet = env.get("MEMO_QUIET", "") not in ("", "0")
        # `claude -p` and SDK runs: nobody reads a reminder, and the turn it adds
        # would replace the run's final result.
        self.headless = (env.get("CLAUDE_CODE_SESSION_ATTENDED") == "0"
                         or env.get("CLAUDE_CODE_ENTRYPOINT", "").startswith("sdk"))

    def session_file(self, name):
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", self.session_id) or "unknown"
        return self.data_dir / "sessions" / f"{safe}.{name}.json"

    def load_state(self, name):
        """The session's state `name` (a dict, {} when missing or broken), read once per hook."""
        if name not in self._states:
            try:
                state = json.loads(self.session_file(name).read_text())
            except (OSError, ValueError):
                state = {}
            self._states[name] = state if isinstance(state, dict) else {}
        return self._states[name]

    def save_state(self, name, state):
        self._states[name] = state
        path = self.session_file(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}")
        tmp.write_text(json.dumps(state))
        os.replace(tmp, path)


def log(hook_dir, text):
    try:
        hook_dir.mkdir(parents=True, exist_ok=True)
        path = hook_dir / "hook.log"
        if path.exists() and path.stat().st_size > LOG_MAX:
            path.write_text(path.read_text(errors="replace")[-LOG_MAX // 2:])
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {text.rstrip()}\n")
    except OSError:
        pass


_memo = []


def memo():
    """scripts/memo as a module: one process per hook, not two."""
    if not _memo:
        from importlib.machinery import SourceFileLoader
        from importlib.util import module_from_spec, spec_from_loader
        loader = SourceFileLoader("tstack_memo", str(ROOT / "scripts" / "memo"))
        module = module_from_spec(spec_from_loader("tstack_memo", loader))
        loader.exec_module(module)
        _memo.append(module)
    return _memo[0]


# --- handlers ---------------------------------------------------------------

def memo_wake(hook):
    """SessionStart: the memory this repo's earlier sessions left. Workers do not wake."""
    if hook.is_worker:
        return None
    return memo().wake_text(hook.env, hook.cwd, str(hook.input.get("source") or "")) or None


NUDGE = (
    "memo: this session changed things and wrote no note. If it produced a decision and its why, "
    "a gotcha, a stated preference or a thread left unfinished that the next session would pay to "
    'rediscover, record it now: `memo note <decision|gotcha|preference|fact|open> "<one line>"` '
    "(skill: memo). If nothing is durable, carry on; this reminder is not repeated."
)
_EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
_DESCRIBED = re.compile(r"\b(?:jj\s+(?:--?[\w-]+(?:[= ]\S+)?\s+)*(?:describe|desc|commit)|git\s+commit)\b")
_NOTED = re.compile(r"\bmemo\b[^|;&\n]*?\b(note|supersede|open)\b")


def scan_transcript(path, offset):
    """What the transcript shows from offset on: (new offset, did real work, wrote a note)."""
    work = noted = False
    with open(path, "rb") as f:
        f.seek(offset)
        chunk = f.read()
    end = chunk.rfind(b"\n") + 1  # a line still being written is left for the next run
    for line in chunk[:end].splitlines():
        if b'"tool_use"' not in line:
            continue
        try:
            content = json.loads(line).get("message", {}).get("content")
        except (ValueError, AttributeError):
            continue
        for block in content if isinstance(content, list) else ():
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name, command = block.get("name"), str((block.get("input") or {}).get("command") or "")
            if name in _EDIT_TOOLS:
                work = True
            elif name == "Bash":
                work = work or bool(_DESCRIBED.search(command))
                noted = noted or bool(_NOTED.search(command))
    return offset + end, work, noted


def memo_nudge(hook):
    """Stop: once per session, when it did real work and wrote no note, say so.
    The context a Stop hook adds gives the agent one more turn to act on it."""
    if (hook.is_worker or hook.quiet or hook.headless or hook.input.get("stop_hook_active")
            or not hook.session_id):
        return None
    state = hook.load_state("memo")
    if state.get("reminded") or state.get("noted"):
        return None
    transcript = hook.input.get("transcript_path")
    if not transcript or not os.path.isfile(transcript):
        return None
    offset = state.get("offset", 0)
    if offset > os.path.getsize(transcript):
        offset = 0
    offset, work, noted = scan_transcript(transcript, offset)
    state = {"offset": offset, "work": bool(state.get("work") or work), "noted": noted}
    remind = state["work"] and not noted
    state["reminded"] = remind
    hook.save_state("memo", state)
    return NUDGE if remind else None


PRECOMPACT = (
    "If this conversation holds a durable decision and its reason, a gotcha, a stated user preference "
    "or an unfinished thread that was not recorded with `memo note`, list each as one line under a "
    "heading 'Memo candidates' in the summary, so it can be noted after the compaction."
)


def memo_precompact(hook):
    """PreCompact: what a hook prints here is added to the compaction instructions
    (it does not reach the agent), so ask the summary to carry what was not noted;
    the wake that follows a compaction tells the agent to note it."""
    if hook.is_worker or hook.quiet:
        return None
    return PRECOMPACT


JJ_HINTS = """\
# jj
This repo is jj, colocated with git; a detached git HEAD is normal here, leave it as it is.
- History goes through jj: `jj status/log/diff/describe/new/split/squash/rebase/abandon`. git checkout, stash, commit and reset stay unused: they fight jj's working copy.
- Publish to this repo's landing bookmark (its docs name it: master in most repos, `nix` in dotfiles): `jj git fetch`, `jj rebase -b @ -d <b>@origin`, then `land-check -b <b>` says whether the push may go (one that deploys waits for a yes); then `jj bookmark set <b> -r <head>` and `jj git push --bookmark <b>`.
- After a push, @ sits on a fresh empty commit. jj makes one itself when the push turns @ immutable (trunk); for any other bookmark, `jj log -r @` and `jj new` if @ is the pushed commit.
- One jj workspace per agent (`jj workspace add ../<repo>-<lane> -r <base> --name <lane>`); rebases, bookmark moves and pushes belong to whoever holds the landing turn.
- `gh` runs from the main workspace: a secondary workspace has no .git.{where}
- @ holding several unrelated edits, or about to land: run /tstack:worktree-janitor to shape it into a described stack."""


def jj_workspace(cwd):
    """(workspace root, main workspace root) of the jj repo holding cwd, or None.
    Plain file reads up the tree, no jj process, so the hook stays fast."""
    here = Path(cwd).resolve()
    for d in (here, *here.parents):
        repo = d / ".jj" / "repo"
        if repo.is_dir():
            return d, d
        if repo.is_file():  # a secondary workspace: the file points at the main .jj/repo
            target = Path(repo.read_text().strip())
            target = (target if target.is_absolute() else repo.parent / target).resolve()
            return d, target.parent.parent
        if (d / ".jj").is_dir():  # a .jj with no repo in it is half-made: say nothing
            return None
    return None


def jj_hints(hook):
    """SessionStart: how history works in a jj repo. Silent outside one."""
    found = jj_workspace(hook.cwd)
    if not found:
        return None
    root, main = found
    where = "" if root == main else f" This is a secondary workspace; the main one is {main}."
    return JJ_HINTS.format(where=where)


TUCA_MODE = """\
# tuca-mode is on
This session runs in /tstack:tuca-mode; the compaction or resume dropped its text, so read {skill} before the next real task.
- Each new request: a real task → match a playbook from that file's list, open a fresh todo list whose first items are the playbook's steps copied verbatim (a skipped step stays as `skip: <reason>`), then work it. A casual turn → just answer.
- Coordinator mindset: delegate what a fresh window does as well, in the background; each subagent's role in skills/productivity/coordinator/MODELS.md sets its model and effort (Fable only for one decisive agent, never fan-out); you own their output.
- Reversible work proceeds. A push goes without asking only when `land-check` says it will not deploy; force-push, deploys, deletion and messages to people wait for Luiz's yes.
- Read the leaf in {principles}/ for any principle you apply, and name the principles that shaped a decision.
- Replies: short declarative sentences; every claim carries its evidence or a label (measured, inferred, guess); link only what you produced or read.
- "stop tuca-mode" → run `{bin} off {session} --data {data}` and drop these rules."""


def tuca_mode(hook):
    """SessionStart after a compaction or resume: bring /tuca-mode back when its flag is set.
    The flag is written by scripts/tuca-mode when the skill loads."""
    if hook.is_worker or str(hook.input.get("source") or "") not in ("compact", "resume"):
        return None
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", hook.session_id) or "unknown"
    if not (hook.data_dir / "sessions" / safe / "tuca-mode").is_file():
        return None
    return TUCA_MODE.format(skill=ROOT / "skills" / "engineering" / "tuca-mode" / "SKILL.md",
                            principles=ROOT / "skills" / "engineering" / "principles",
                            bin=ROOT / "bin" / "tuca-mode", session=hook.session_id, data=hook.data_dir)


def fleet_dirs(hook):
    """The fleets this session works for (fleet/SPEC.md, Heartbeats): $FLEET_DIR when it names a
    ledger (a worker launched as its own process), else each folder of the session's scratchpad that
    holds a state.json (a coordinator's DIR is <scratchpad>/coordinator; its subagents share it).
    Looked up once per hook."""
    if hook._fleet_dirs is None:
        hook._fleet_dirs = _find_fleet_dirs(hook)
    return hook._fleet_dirs


def _find_fleet_dirs(hook):
    given = hook.env.get("FLEET_DIR")
    if given:
        return [given] if os.path.isfile(os.path.join(given, "state.json")) else []
    pad = hook.input.get("scratchpad_dir")
    if not isinstance(pad, str) or not os.path.isabs(pad):
        return []
    try:
        with os.scandir(pad) as entries:
            return [e.path for e in entries if e.is_dir() and os.path.isfile(os.path.join(e.path, "state.json"))]
    except OSError:
        return []


def _varint(data, i):
    value = shift = 0
    while True:
        byte = data[i]
        i += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, i


def jj_workspace_name(root):
    """The name jj gave the workspace at root: field 3 of .jj/working_copy/checkout (a protobuf
    message: operation id, workspace name), read without a jj process."""
    try:
        data = (root / ".jj" / "working_copy" / "checkout").read_bytes()
    except OSError:
        return None
    i = 0
    try:
        while i < len(data):
            key, i = _varint(data, i)
            if key & 7 != 2:  # every field of this message is length-delimited
                return None
            size, i = _varint(data, i)
            if key >> 3 == 3:
                return data[i:i + size].decode("utf-8", "replace")
            i += size
    except IndexError:  # a truncated file: no name
        pass
    return None


def fleet_stamp(env):
    """Now as the fleet stamps it (the coordinator's scripts/clock.py): $FLEET_NOW when it is set,
    in local time with its offset, to the second."""
    from datetime import datetime, timezone
    at = None
    if env.get("FLEET_NOW"):
        try:
            at = datetime.fromisoformat(env["FLEET_NOW"])
            at = at if at.tzinfo else at.replace(tzinfo=timezone.utc)
        except ValueError:
            at = None
    return (at or datetime.now(timezone.utc)).astimezone().isoformat(timespec="seconds")


def fleet_heartbeat(hook):
    """Every tool call, session start and stop, subagent start and stop: one small file per session
    (and per subagent) in DIR/heartbeats/, which the hub reads for a worker's last-seen and the
    silent-worker warning. A no-op outside a fleet; one atomic write per fleet, no process."""
    dirs = fleet_dirs(hook)
    if not dirs or not hook.session_id:
        return None
    data = hook.input

    def text(key):
        value = data.get(key)
        return value if isinstance(value, str) and value else None

    agent = text("agent_id")
    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    paths = (tool_input.get(k) for k in ("file_path", "notebook_path", "path"))
    path = next((p for p in paths if isinstance(p, str) and os.path.isabs(p)), None)
    found = jj_workspace(hook.cwd)
    beat = {
        "session": hook.session_id, "agent": agent, "agent_type": text("agent_type"),
        "worker": hook.env.get("FLEET_WORKER") or None, "cwd": hook.cwd,
        "workspace": jj_workspace_name(found[0]) if found else None, "path": path,
        "tool": text("tool_name"), "event": hook.event, "at": fleet_stamp(hook.env),
        "transcript": text("transcript_path"), "agent_transcript": text("agent_transcript_path"),
    }
    project = hook.env.get("CLAUDE_PROJECT_DIR")
    if project and os.path.isabs(project):
        beat["project"] = project
    name =re.sub(r"[^A-Za-z0-9_.-]", "_", hook.session_id + (f".{agent}" if agent else ""))
    for d in dirs:
        folder = Path(d) / "heartbeats"
        folder.mkdir(exist_ok=True)
        path = folder / f"{name}.json"
        if beat["tool"] is None:  # a start or a stop keeps the last tool the session ran
            try:
                last = json.loads(path.read_text()).get("tool")
                beat["tool"] = last if isinstance(last, str) else None
            except (OSError, ValueError, AttributeError):
                pass
        tmp = folder / f".{name}.{os.getpid()}"
        tmp.write_text(json.dumps(beat))
        os.replace(tmp, path)
    return None


class Block(str):
    """What a Stop handler returns to keep the turn going: the text becomes the block's reason."""


def fleet_worker(hook):
    """A worker of a fleet: a subagent (agent_id), TSTACK_ROLE=worker, or a process launched with
    FLEET_WORKER. The listening rules below are the coordinator's and the manager's only."""
    return hook.is_worker or bool(hook.env.get("FLEET_WORKER"))


def read_ledger(d):
    """DIR/state.json as a dict, or None when it is missing or does not parse."""
    try:
        with open(os.path.join(d, "state.json"), "rb") as f:
            ledger = json.loads(f.read())
    except (OSError, ValueError):
        return None
    return ledger if isinstance(ledger, dict) else None


def fleet_role(ledger):
    """The host of a fleet's chat (the ledger's role): manager, else coordinator."""
    return "manager" if isinstance(ledger, dict) and ledger.get("role") == "manager" else "coordinator"


def fleet_registry(env):
    """The hub's registry directory (fleets.py home()): $FLEET_HOME, else fleet-board under $XDG_STATE_HOME."""
    if env.get("FLEET_HOME"):
        return Path(env["FLEET_HOME"])
    return Path(env.get("XDG_STATE_HOME") or Path(env.get("HOME", "/tmp")) / ".local" / "state") / "fleet-board"


def served_by_session(hook, d):
    """Whether this machine's registry has an entry for the fleet at d whose session_id is this session's
    (`fleet serve` records it). A state.json the session merely holds, a ledger copied to read, is not one."""
    if not hook.session_id:
        return False
    real = os.path.realpath(d)
    try:
        entries = list(fleet_registry(hook.env).glob("*.json"))
    except OSError:
        return False
    for path in entries:
        try:
            entry = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(entry, dict) and entry.get("session_id") == hook.session_id \
                and isinstance(entry.get("dir"), str) and os.path.realpath(entry["dir"]) == real:
            return True
    return False


def grant_dirs(hook):
    """The fleets whose refused calls this session records and whose one-time grants its calls count against:
    fleet_dirs, and every fleet the registry records under this session (`fleet serve`), wherever its DIR is. A
    coordinator whose DIR is outside its scratchpad and that has no $FLEET_DIR is found only this way. Measured
    2026-10-12: one such fleet's ten one-time rules, granted since 10-03, were all still in its settings, and none
    of its refusals had opened an item. Looked up once per hook."""
    if hook._grant_dirs is None:
        dirs = list(fleet_dirs(hook))
        seen = {os.path.realpath(d) for d in dirs}
        for d in _served_dirs(hook):
            if os.path.realpath(d) not in seen and os.path.isfile(os.path.join(d, "state.json")):
                seen.add(os.path.realpath(d))
                dirs.append(d)
        hook._grant_dirs = dirs
    return hook._grant_dirs


def grant_state_dirs(hook):
    """The folders whose grants.jsonl this session's calls count against: grant_dirs, and each of the same places
    (the scratchpad's folders or $FLEET_DIR, the registry's entries of this session) that holds a grants.jsonl with no
    ledger beside it, so moving state.json away does not lift the grants. Looked up once per hook."""
    if hook._grant_state_dirs is None:
        dirs = list(grant_dirs(hook))
        seen = {os.path.realpath(d) for d in dirs}
        given = hook.env.get("FLEET_DIR")
        pad = hook.input.get("scratchpad_dir")
        places = [given] if given else []
        if not given and isinstance(pad, str) and os.path.isabs(pad):
            try:
                with os.scandir(pad) as entries:
                    places = [e.path for e in entries if e.is_dir()]
            except OSError:
                pass
        for d in places + _served_dirs(hook):
            if os.path.realpath(d) not in seen and os.path.lexists(os.path.join(d, "grants.jsonl")):
                seen.add(os.path.realpath(d))
                dirs.append(d)
        hook._grant_state_dirs = dirs
    return hook._grant_state_dirs


def fleet_ledger_home(env):
    """The fixed home of the fleets' ledgers (fleet slice 3; the Skills ledger is its `skills`): $XDG_STATE_HOME/fleet,
    else ~/.local/state/fleet."""
    return Path(env.get("XDG_STATE_HOME") or Path(env.get("HOME", "/tmp")) / ".local" / "state") / "fleet"


def _served_dirs(hook):
    """The DIR of each registry entry whose session_id is this session's, then each folder of the ledgers' home that
    the registry once gave this session and that has since moved (cloud.json): the cut-over's `fleet serve --stop`
    removes the entry, so the session remembers the home's folders it served. A folder is never taken by its name or
    its marker alone: a session writes to no fleet the registry did not give it. Looked up once per hook."""
    if hook._served_dirs is None:
        hook._served_dirs = _find_served_dirs(hook)
    return list(hook._served_dirs)


def _find_served_dirs(hook):
    found = _registry_dirs(hook)
    if not hook.session_id:
        return found
    home = os.path.realpath(fleet_ledger_home(hook.env))
    state = hook.load_state("ledger-home")
    known = [n for n in state.get("served") or [] if isinstance(n, str)] if isinstance(state.get("served"), list) else []
    served = {os.path.basename(r) for r in map(os.path.realpath, found) if os.path.dirname(r) == home}
    if not served <= set(known):
        known = sorted(set(known) | served)
        hook.save_state("ledger-home", {"served": known})
    seen = {os.path.realpath(d) for d in found}
    for name in known:
        d = os.path.join(home, name)
        if name not in ("", ".", "..") and "/" not in name and d not in seen and moved(d):
            found.append(d)
    return found


def _registry_dirs(hook):
    """The DIR of each registry entry whose session_id is this session's."""
    if not hook.session_id:
        return []
    try:
        entries = sorted(fleet_registry(hook.env).glob("*.json"))
    except OSError:
        return []
    found = []
    for path in entries:
        try:
            entry = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(entry, dict) and entry.get("session_id") == hook.session_id \
                and isinstance(entry.get("dir"), str) and os.path.isabs(entry["dir"]):
            found.append(entry["dir"])
    return found


def fleet_cli():
    return f"{ROOT}/fleet/bin/fleet"


# A moved team (fleet slice 3, decisions 46, 48, 51): the host service exports DIR/state.json and DIR/chat.jsonl from
# the cloud and marks the folder with DIR/cloud.json. Its ledger is written by programs, through `fleet-run` with the
# program on stdin and FLEET_DIR naming the folder (exit 0 completed, 2 error, 3 queued, 4 the service is not running,
# 5 sent with its outcome unknown: `--id <id>` sends it again); the old CLI only reads it, and refuses to write it.
MOVED_MARKER = "cloud.json"
MOVED_DENIAL = "this team records through programs: fleet-run"
FLEET_RUN_QUEUED = 3
FLEET_RUN_UNKNOWN = 5


def _json_object(text):
    try:
        value = json.loads(text)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def fleet_run_cli(env):
    return env.get("TSTACK_FLEET_RUN") or f"{ROOT}/fleet/bin/fleet-run"


def moved(d):
    """Whether the fleet at d records through programs: the host service's marker is in its folder."""
    return os.path.isfile(os.path.join(d, MOVED_MARKER))


def fleet_program(*calls):
    """A program of prelude calls (each a JS expression) that applies the ops they made."""
    return "".join(f"{c};\n" for c in calls) + "return records.apply(ops);\n"


def answer_program(decision_id, resolution, re=None):
    """The one-line program a nudge tells the coordinator to send: the card decided ("..." is its answer to fill in),
    and with re, a chat line answering the user's message #re."""
    said = f' say("...", {{ re: {int(re)} }});' if re is not None else ""
    return f'decision.decide({_js(decision_id)}, "...", {_js(resolution)});{said} return records.apply(ops);'


def blocked_program(text, worker):
    """An important `blocked` event for the fleet's host, of worker when the ledger knows the caller."""
    options = {"important": True, **({"agent": worker} if worker else {})}
    return fleet_program(f"event(\"blocked\", {_js(text)}, {_js(options)})")


def _js(value):
    """A value as a JS literal: JSON, ASCII-escaped so no line separator ends a string."""
    return json.dumps(value, ensure_ascii=True)


class Unapplied(RuntimeError):
    """The fleet ran the hook's program and did not apply an op of it (refused, or a clash)."""


def fleet_run(hook, d, program):
    """Run a program against the moved fleet at d. Its outcome, completed or queued (a card waits for the link);
    RuntimeError when the service is down or the program failed, Unapplied when the fleet did not apply an op, and
    subprocess.TimeoutExpired past CLI_TIMEOUT_S. That is 25 s, and the client waits 120 s for the service: the client
    is the fleet repo's (apps/client/fleet-run.ts) and reads no timeout from its environment, so the hook kills it
    first, accepted. A program the service still runs after the kill may land: the caller treats it as not told."""
    import subprocess
    cli = fleet_run_cli(hook.env)
    # The client sends $FLEET_SESSION as the program's `from`: this hook's session, never one left in the environment.
    env = {**hook.env, "FLEET_DIR": d, **({"FLEET_SESSION": hook.session_id} if hook.session_id else {})}
    done = subprocess.run([cli], input=program, capture_output=True, text=True, env=env,
                          cwd=d, check=False, timeout=CLI_TIMEOUT_S)
    if done.returncode == FLEET_RUN_UNKNOWN:
        # Sent, and no answer came back: the same program again under its id runs at most once (round H).
        sent = _json_object(done.stdout)
        if isinstance(sent.get("id"), str) and re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{26}", sent["id"]):
            done = subprocess.run([cli, "--id", sent["id"]], input=program, capture_output=True, text=True, env=env,
                                  cwd=d, check=False, timeout=CLI_TIMEOUT_S)
    if done.returncode not in (0, FLEET_RUN_QUEUED):
        raise RuntimeError(f"{cli} exited {done.returncode}: {(done.stderr or done.stdout).strip()[:500]}")
    try:
        outcome = json.loads(done.stdout)
    except ValueError:
        raise RuntimeError(f"{cli} printed no outcome: {done.stdout.strip()[:300]}") from None
    results = outcome.get("ops") if isinstance(outcome, dict) else None
    unapplied = [r for r in results or [] if isinstance(r, dict) and r.get("_tag") not in ("applied", "duplicate")]
    if unapplied:
        raise Unapplied(f"{cli}: the fleet did not apply the hook's op: {json.dumps(unapplied[0])[:500]}")
    return outcome


def fleet_moved_writes(hook):
    """PreToolUse (Bash): the old CLI's writers are refused for a moved fleet (decision 48): `fleet state DIR VERB`
    for every verb but `show`, `fleet chat DIR say`, `fleet ws DIR add|split|prune --apply` (each writes the
    workspaces row), `fleet preview DIR VERB` for every verb but `status`, and `fleet render DIR/state.json OUT` (it
    stamps the ledger), when DIR holds cloud.json. Its readers stay allowed (`state show`, `chat watch` and `wait`,
    `brief`, `turn`, `ws list`, a dry-run `ws prune`, `preview status`). A relative DIR is resolved against the line's own `cd`, else the
    session's cwd; a DIR named by a variable is not resolved here: the old CLI refuses that folder itself."""
    tool_input = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    command = tool_input.get("command") if hook.input.get("tool_name") == "Bash" else None
    if not isinstance(command, str) or "fleet" not in command.lower() or not re.search(r"state|say|ws|preview|render", command):
        return None
    for words, cwd in _moved_write_candidates(command, hook.cwd):
        for i in range(len(words) - 3):
            sub, d, verb = words[i + 1], words[i + 2], words[i + 3]
            if "fleet" not in os.path.basename(words[i]).lower():
                continue
            if not ((sub == "state" and verb != "show" and not verb.startswith("-")) or (sub == "chat" and verb == "say")
                    or (sub == "ws" and (verb in ("add", "split") or (verb == "prune" and "--apply" in words[i + 4:])))
                    or (sub == "preview" and verb != "status" and not verb.startswith("-")) or sub == "render"):
                continue
            path = os.path.expanduser(os.path.dirname(d) if sub == "render" else d)
            if not os.path.isabs(path):
                if cwd is None:
                    continue
                path = os.path.join(cwd, path)
            if moved(path):
                run = fleet_run_cli(hook.env)
                return Deny(f"{MOVED_DENIAL}. The fleet at {d} has moved to the cloud ({MOVED_MARKER}): its host service "
                            f"writes state.json and chat.jsonl, so `fleet {sub} … {verb}` is refused there; its reads (`state "
                            f"show`, `chat watch`) are not. Record with one program: `FLEET_DIR={d} {run} <<'EOF'` … `EOF`; `{run} --types` "
                            f"prints what a program calls, and the coordinator skill's PROGRAMS.md has the worked calls.")
    return None


def _moved_write_candidates(command, cwd):
    """Each simple command of the line as (words, the directory it runs in): `cd` and `pushd` move the directory for
    what follows; one inside a loop or group, `cd -`, or a target with a variable leaves it unknown (None). A word
    holding a shell command (`bash -c '...'`) is split into the same words, run where its segment runs."""
    import shlex
    try:
        segments = _segments(_strip_heredocs(command))
    except ValueError:
        try:
            return [(_tokens(shlex.split(command)), cwd)]
        except ValueError:
            return [(command.split(), cwd)]
    out = []
    for words, nesting in segments:
        words, _ = _unwrap(words)
        if not words:
            continue
        if os.path.basename(words[0]) in ("cd", "pushd"):
            target = words[1] if len(words) > 1 else "~"
            cwd = None if target == "-" or nesting > 0 else _path(cwd, target)
            continue
        out.append((_tokens(words), cwd))
    return out


def _tokens(args, depth=0):
    """A command line's words; a word holding a shell command (`bash -c '... eval ...'`) is split too."""
    import shlex
    out = []
    for a in args:
        if depth < 3 and any(c.isspace() for c in a):
            try:
                out.extend(_tokens(shlex.split(a), depth + 1))
                continue
            except ValueError:
                pass
        out.append(a)
    return out


def _is_watch(args, cwd, d, role, unresolved=True):
    """Whether this command line runs `fleet chat D watch --as ROLE --once` for the fleet at d. A watch
    without --once never exits, so as a background command it never wakes the session: not armed. A relative
    D with no cwd to resolve it is taken for d when `unresolved`."""
    words = _tokens(args)
    for i in range(len(words) - 2):
        if words[i] != "chat" or words[i + 2] != "watch":
            continue
        rest = words[i + 3:]
        as_role = any((w == "--as" and j + 1 < len(rest) and rest[j + 1].lower() == role)
                      or w.lower() == f"--as={role}" for j, w in enumerate(rest))
        if not as_role or "--once" not in rest:
            continue
        given = os.path.expanduser(words[i + 1])
        if not os.path.isabs(given):
            if not cwd:  # no way to resolve it: the pid file or the command named the fleet
                if unresolved:
                    return True
                continue
            given = os.path.join(cwd, given)
        if os.path.realpath(given) == os.path.realpath(d):
            return True
    return False


def _proc(pid):
    """(argv, cwd) of a live process, or None. /proc on Linux, `ps` elsewhere (no cwd)."""
    if os.path.isdir("/proc/self"):
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                args = f.read().decode("utf-8", "replace").split("\0")
        except OSError:
            return None
        try:
            cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            cwd = ""
        return [a for a in args if a], cwd
    import subprocess
    try:
        out = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True,
                             timeout=2).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return ([out], "") if out else None


def _all_procs():
    """Every process's (pid, argv, cwd), to find a watch that has not written its pid file yet."""
    if os.path.isdir("/proc/self"):
        me = os.getpid()
        for name in os.listdir("/proc"):
            if name.isdigit() and int(name) != me:
                found = _proc(int(name))
                if found:
                    yield int(name), found[0], found[1]
        return
    import subprocess
    try:
        out = subprocess.run(["ps", "-A", "-o", "pid=,command="], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return
    for line in out.splitlines():
        pid, _, command = line.strip().partition(" ")
        if pid.isdigit() and command.strip():
            yield int(pid), [command.strip()], ""


def _proc_stat(pid):
    """The fields of /proc/PID/stat after the command's name (the state first, then the parent, the group,
    the session, the terminal), or None when PID does not run."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()
    except (OSError, IndexError):
        return None


def _ps_column(pid, column):
    """One `ps` column of PID, stripped, in the C locale; "" when PID does not run."""
    import subprocess
    try:
        return subprocess.run(["ps", "-o", f"{column}=", "-p", str(pid)], capture_output=True, text=True, timeout=2,
                              env={**os.environ, "LC_ALL": "C"}).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


class ProcTree:
    """What the rule of whose a watch is reads of the machine's processes (fleet/src/chat/watchers.ts `Tree`,
    over procs.ts): /proc on Linux, `ps` on the Mac. A test gives a tree of its own."""
    linux = os.path.isdir("/proc/self")

    def parent(self, pid):
        """The parent of PID, or None when PID does not run."""
        text = (_proc_stat(pid) or [None, None])[1] if self.linux else _ps_column(pid, "ppid")
        return int(text) if text and text.isdigit() else None

    def started(self, pid):
        """When PID started, as procs.ts `startedOf` reads it (the two must give the same text): the start
        time in clock ticks since boot on Linux, `ps -o lstart=` on the Mac. None when PID does not run."""
        if self.linux:
            stat = _proc_stat(pid)
            return stat[19] if stat and len(stat) > 19 else None
        return _ps_column(pid, "lstart") or None

    def claude(self, pid):
        """Whether PID is a Claude Code process (procs.ts `isClaudeBinary`): it is named `claude`, or runs
        `claude/versions/<version>` (the native install, whose name is the version)."""
        if self.linux:
            try:
                with open(f"/proc/{pid}/comm") as f:
                    name = f.read().strip()
            except OSError:
                name = ""
            try:
                exe = os.readlink(f"/proc/{pid}/exe")
            except OSError:
                exe = ""
        else:
            exe = _ps_column(pid, "comm")
            name = os.path.basename(exe)
        return name == "claude" or re.search(r"/claude/versions/[^/]+$", exe) is not None

    def terminal(self, pid):
        """Whether PID has a controlling terminal."""
        if self.linux:
            stat = _proc_stat(pid)
            return bool(stat and len(stat) > 4 and stat[4].lstrip("-").isdigit() and int(stat[4]) != 0)
        tty = _ps_column(pid, "tty")
        return bool(tty) and not tty.startswith("?")


def _session_above(pid, tree):
    """The nearest Claude Code process above PID (at most 32 parents up): the session whose background
    command PID is, or None."""
    at, hops = tree.parent(pid), 0
    while at is not None and at > 1 and hops < 32:
        if tree.claude(at):
            return at if tree.started(at) is not None else None
        at, hops = tree.parent(at), hops + 1
    return None


def _watch_owner(d, role):
    """The session a running watch recorded when it began (`DIR/watch-ROLE.owner.pid`, written by
    fleet/src/chat/watchers.ts `recordOwner`): {watch, session, started}, or None."""
    try:
        with open(os.path.join(d, f"watch-{role}.owner.pid")) as f:
            owner = json.load(f)
    except (OSError, ValueError):
        return None
    return owner if isinstance(owner, dict) and isinstance(owner.get("watch"), int) else None


def _watch_orphaned(pid, owner, tree):
    """Whether the watch PID hears for nobody, because the session that armed it is gone. The rule is
    fleet/src/chat/watchers.ts `orphaned`, which `listening`, `fleet fleets list`, the hub's wake and the next
    watch's takeover keep: change the two together.
    - A watch that recorded its session (OWNER is its own record) is orphaned when that process no longer
      runs, or another has its pid (another start time); one that recorded none (armed by a person in a
      terminal) never is.
    - A watch with no record of its own (armed before the record existed, or this instant) is orphaned when
      it has no controlling terminal and no Claude Code process is above it.
    A watch whose session runs but is not the fleet's host is no watch either: `_watch_foreign`."""
    if owner is not None and owner.get("watch") == pid:
        session = owner.get("session")
        if not isinstance(session, int):
            return False
        started = tree.started(session)
        return started is None or (isinstance(owner.get("started"), str) and started != owner["started"])
    return not tree.terminal(pid) and _session_above(pid, tree) is None


def _fleet_host(env, d, tree):
    """The session that hosts the fleet at d, as (pid, started), when the registry names one that is there
    now (fleet/src/host.ts `liveHost`): the entry's `pid` runs, is Claude Code, and started when the entry's
    `started` says (None in an entry served before it was recorded, which is told by its pid alone). None
    when the fleet is not served, the entry names a process that is not Claude Code (`serve --pid` of
    something else), or another process has its pid. With none, no watch is foreign."""
    real = os.path.realpath(d)
    try:
        paths = sorted(p for p in fleet_registry(env).glob("*.json") if p.is_file())
    except OSError:
        return None
    for path in paths:
        try:
            entry = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) \
                or not isinstance(entry.get("dir"), str) or os.path.realpath(entry["dir"]) != real:
            continue
        pid = entry.get("pid")
        running = tree.started(pid) if isinstance(pid, int) and pid > 1 else None
        if running is None:
            continue
        recorded = entry.get("started") if isinstance(entry.get("started"), str) and entry["started"] else None
        if not tree.claude(pid) or (recorded is not None and recorded != running):
            return None
        return pid, recorded
    return None


def _is_host(host, pid, started):
    """Whether the process PID that started at STARTED is HOST (fleet/src/host.ts `isHost`)."""
    return host[0] == pid and (host[1] is None or started is None or host[1] == started)


def _watch_foreign(pid, owner, host, tree):
    """Whether the watch PID, a watch as the host's role, hears for someone who is not the fleet's host
    (fleet/src/chat/watchers.ts `foreign`: change the two together). HOST is the session the registry names
    (`_fleet_host`); the watch was armed by another session (a fork of the host, a second resume of its
    transcript) or by nobody's (a terminal), so its lines wake that one while the host hears nothing. With
    no HOST known, no watch is foreign. Whose the watch is: its own record, else the Claude Code process
    above it."""
    if host is None:
        return False
    if owner is not None and owner.get("watch") == pid:
        session = owner.get("session")
        if not isinstance(session, int):
            return True
        return not _is_host(host, session, owner["started"] if isinstance(owner.get("started"), str) else None)
    session = _session_above(pid, tree)
    return session is None or not _is_host(host, session, tree.started(session))


def watch_alive(d, role, tree=None, host=None):
    """Whether a chat watch as ROLE runs for the fleet at d, for a session that is there to hear it: the pid
    in DIR/watch-ROLE.pid is alive and is that watch (its command line, so a reused pid does not count);
    else, a watch just armed that has not written its pid file yet (Bun takes a moment to start), found
    among the running processes. A watch whose session is gone (`_watch_orphaned`) hears for nobody, and one
    armed by a session that is not HOST, the fleet's host when ROLE is the host's role (`_fleet_host`), wakes
    that session and not the host (`_watch_foreign`): neither counts, and the watch the guard asks for takes
    its place. The rule is fleet/src/chat/watchers.ts `liveWatch`."""
    tree = tree or ProcTree()
    owner = _watch_owner(d, role)

    def hears(watch):
        return not _watch_orphaned(watch, owner, tree) and not _watch_foreign(watch, owner, host, tree)

    try:
        with open(os.path.join(d, f"watch-{role}.pid")) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        pid = 0
    if pid > 0:
        found = _proc(pid)
        if found and _is_watch(found[0], found[1], d, role) and hears(pid):
            return True
    return any(_is_watch(args, cwd, d, role) and hears(other) for other, args, cwd in _all_procs())


def watch_command(d, role):
    return f"{fleet_cli()} chat {d} watch --as {role} --all --resume --once"


DEAF = ("Your chat watch isn't running, so the user's messages and answers go unheard. Arm it as a "
        "background command (`run_in_background: true`, `timeout: 3300000`): `{command}`.")
DEAF_MANAGER = (" While something you own or relay waits on the user (a decision you passed on, a question "
                "you asked them, a landing waiting on their go), add `--fleets` (manager SKILL.md, Waiting on "
                "the user).")
GUARD_AGAIN_S = 15
WAITING = "Your chat watch waits on the user's allow ({id}): do not arm it again."
REFUSAL_REMIND_S = 1800


def _watch_ran(d, role):
    """When a watch as ROLE last ran for the fleet at d, or None: the later of its pid file's mtime and its
    `.left` stamp, since a `--once` watch removes its pid file on exit and touches `.left` (chat.ts leftPath)."""
    times = []
    for name in (f"watch-{role}.pid", f"watch-{role}.left"):
        try:
            times.append(os.stat(os.path.join(d, name)).st_mtime)
        except OSError:
            pass
    return max(times, default=None)


def _watch_refused(ledger, d, role):
    """The id of the permission the fleet's watch command waits on, or None: an open refusal draft of it, or an open
    decision that put it to the user and has no answer yet, opened since the watch last began. A refused call is
    never retried, so a guard that asks for it again at every turn's end loops (measured 2026-10-15: a coordinator's
    watch, refused by auto mode, blocked each Stop). An answered decision lets the watch run; a draft or decision
    older than the watch's last run was left open by a watch armed another way; neither excuses a deaf turn."""
    ran = _watch_ran(d, role)

    def waits(tool, calls, root, opened):
        if ran is not None and not (isinstance(opened, (int, float)) and opened >= ran):
            return False
        root = root if isinstance(root, str) and os.path.isabs(root) else None
        return tool == "Bash" and any(isinstance(c, str) and _is_watch([c], root, d, role, unresolved=False) for c in calls)
    for row in ledger.get("decisions") if isinstance(ledger.get("decisions"), list) else []:
        open_ = isinstance(row, dict) and row.get("status") == "open" and row.get("answer") in (None, "")
        r = row.get("refusal") if open_ else None
        if isinstance(r, dict) and waits(r.get("tool"), [r.get("call"), *(r.get("more") or [])], r.get("root"),
                                         _instant(row.get("revised") or row.get("opened"))):
            return row.get("id")
    for row in ledger.get("refusals") if isinstance(ledger.get("refusals"), list) else []:
        if isinstance(row, dict) and row.get("status") == "open" and waits(row.get("tool"), [row.get("call")],
                                                                           row.get("root"), _instant(row.get("opened"))):
            return row.get("id")
    return None


def _moved_served_dirs(hook, dirs):
    """The ledgers' home folders this session served that have since moved to the cloud and are not among dirs: the
    cut-over's `fleet serve --stop` removes the registry entry and the folder is outside the scratchpad, so neither
    fleet_dirs nor served_by_session finds it, and a moved coordinator would end its turns deaf."""
    seen = {os.path.realpath(d) for d in dirs}
    return [d for d in _served_dirs(hook) if moved(d) and os.path.realpath(d) not in seen
            and os.path.isfile(os.path.join(d, "state.json"))]


def fleet_listen_guard(hook, tree=None):
    """Stop: a coordinator or manager does not end a turn deaf. When a fleet it hosts (running or blocked;
    a paused or done one is left alone) has no live chat watch as its role, the turn goes on with the
    command that arms it. It hosts the fleet $FLEET_DIR names, or one of its scratchpad's that the
    registry says this session serves. Never twice in a row: not when this stop already follows a stop hook's block
    (stop_hook_active), nor within GUARD_AGAIN_S of the last block.
    The watch must be the host's own: the host is the session the registry entry names (`_fleet_host`), and
    a watch another session armed counts as none (`_watch_foreign`). A session that is not that host (a
    `--fork-session` copy, a second `claude --resume` of its transcript: the Claude Code process above this
    hook is another one) is told nothing, since the watch would refuse it. With no live host known, or no
    Claude Code process above the hook, the fleet is guarded by the older rules."""
    if fleet_worker(hook) or hook.input.get("stop_hook_active"):
        return None
    dirs = fleet_dirs(hook)
    if not hook.env.get("FLEET_DIR"):
        dirs = [d for d in dirs if served_by_session(hook, d)]
        dirs += _moved_served_dirs(hook, dirs)
    if not dirs:
        return None
    state = hook.load_state("fleet-guard") if hook.session_id else {}
    last = state.get("blocked_at")
    if isinstance(last, (int, float)) and 0 <= time.time() - last < GUARD_AGAIN_S:
        return None
    tree = tree or ProcTree()
    now = time.time()
    try:
        remind = float(hook.env.get("FLEET_REFUSAL_REMIND_S") or REFUSAL_REMIND_S)
    except ValueError:
        remind = REFUSAL_REMIND_S
    told = state.get("told_waiting") if isinstance(state.get("told_waiting"), dict) else {}
    told = {k: v for k, v in told.items() if isinstance(v, (int, float))}
    lines, waiting = [], []
    for d in dirs:
        ledger = read_ledger(d)
        if ledger is None or ledger.get("status") in ("paused", "done"):
            continue
        role = fleet_role(ledger)
        host = _fleet_host(hook.env, d, tree)
        if host is not None:
            me = _session_above(os.getpid(), tree)
            if me is not None and not _is_host(host, me, tree.started(me)):
                continue
        if watch_alive(d, role, tree, host):
            continue
        refused = _watch_refused(ledger, d, role)
        if refused is not None:
            at = told.get(refused)
            if not isinstance(at, (int, float)):
                waiting.append(refused)
                continue
            if 0 <= now - at < remind:
                continue
            told[refused] = now  # the note has lapsed: block once, then quiet for another FLEET_REFUSAL_REMIND_S
        lines.append(DEAF.format(command=watch_command(d, role)) + (DEAF_MANAGER if role == "manager" else ""))
    if hook.session_id and (lines or waiting):
        told = {**told, **{i: now for i in waiting}}
        hook.save_state("fleet-guard", {**state, **({"blocked_at": now} if lines else {}),
                                        "told_waiting": dict(sorted(told.items(), key=lambda kv: kv[1])[-20:])})
    if lines:
        return Block("\n".join(lines))
    return "\n".join(WAITING.format(id=i) for i in waiting) or None


IDLE = "Work is queued and no lane is running: {items}. Start the independent ones now, or say why they wait ({how})."
IDLE_SHOWN = 3
# A kept item that opens with a follow-up marker is work still to do; one that only mentions a bug, or says what
# landed, is not.
FOLLOW_UP = re.compile(r"^\s*(?:follow[- ]?ups?|todo|backlog|queued)\b", re.I)
# A Now line that says why the work waits: on someone, a pause, a hold. Naming an open card or roadblock by its
# ref (D12, G33, R4) is a reason too (_gives_why).
WAITS_WHY = re.compile(r"\b(?:a?wait(?:s|ing|ed)?|until|paused?|on hold|blocked (?:on|by))\b", re.I)
REF = re.compile(r"\b[A-Z]\d+\b")
# fleet/src/health.ts SILENT_S: a worker not seen for this long is silent (silentWorkers).
SILENT_S = 20 * 60
REVIEW_SKILLS = ("review", "interrogate", "code-review")


def _no_lane(row):
    """Whether a running worker row is no lane of the queued work: the fleet's advisor (`fleet advisor`'s row), a
    reviewer (its skill, or the role in its name) or a watcher (MODELS.md's Watcher pair, haiku at low). A gate run is
    no row of the ledger (`fleet fleets gate run` is a background command), so it never counts as a lane; a worker
    spawned only to run one is a lane unless it is recorded on the Watcher pair."""
    skill = row.get("skill") if isinstance(row.get("skill"), str) else ""
    name = row.get("name") if isinstance(row.get("name"), str) else ""
    return (row.get("id") == "advisor" or skill.rsplit(":", 1)[-1] in REVIEW_SKILLS or _named("reviewer", name.lower())
            or (row.get("model") == "haiku" and row.get("effort") == "low"))


def _silent(hook, d, row, now):
    """Whether a running row's worker went silent: its heartbeat file, DIR/heartbeats/<session>.<task_id>.json as
    fleet_heartbeat names a subagent's, is older than SILENT_S. Stat only. A row with no task_id or no file, or a
    moved team's (the hook beats into the scratchpad's fleets, never a moved one's home folder), is not known silent."""
    task = row.get("task_id")
    if not isinstance(task, str) or not task or not hook.session_id or moved(d):
        return False
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{hook.session_id}.{task}")
    try:
        return now - os.stat(os.path.join(d, "heartbeats", f"{name}.json")).st_mtime > SILENT_S
    except OSError:
        return False


def _gives_why(ledger):
    """Whether the Now line says why the work waits: a wait word (WAITS_WHY), or the ref of an open card or an
    unresolved roadblock. An open card the line does not name is no reason: a blocking decision alone passes nothing."""
    now = str(ledger.get("now") or "")
    if WAITS_WHY.search(now):
        return True
    named = set(REF.findall(now))
    if not named:
        return False

    def refs(key, still_open):
        rows = ledger.get(key) if isinstance(ledger.get(key), list) else []
        return {r.get("ref") for r in rows if isinstance(r, dict) and still_open(r)}
    return bool(named & (refs("decisions", lambda r: r.get("status") == "open")
                         | refs("roadblocks", lambda r: not r.get("resolved"))))


def _queued_work(ledger):
    """(id, title) of the work a fleet's ledger holds waiting: its pending steps in roadmap order, its queued workers
    (the advisor's row aside), then its kept items that read as a follow-up."""
    def rows(value):
        return [r for r in value if isinstance(r, dict) and isinstance(r.get("id"), str)] if isinstance(value, list) else []
    steps = [(s["id"], s.get("title") or "") for m in rows(ledger.get("roadmap")) for s in rows(m.get("steps"))
             if s.get("status") == "pending"]
    queued = [(a["id"], a.get("task") or a.get("name") or "") for a in rows(ledger.get("agents"))
              if a.get("status") == "queued" and a["id"] != "advisor"]
    kept = [(k["id"], k.get("text") or "") for k in rows(ledger.get("kept"))
            if isinstance(k.get("text"), str) and FOLLOW_UP.search(k["text"])]
    return steps + queued + kept


def fleet_idle_guard(hook):
    """Stop: a coordinator does not end its turn idle while work waits. When a fleet it hosts (running or blocked) holds
    queued work (_queued_work) and runs no lane (every running worker is _no_lane), the turn goes on with the first
    IDLE_SHOWN items, unless the Now line says why they wait (_gives_why). A running worker gone silent (_silent) is
    no lane. Told once per state: the queued ids, the running ids (a silent one marked) and whether the Now line gave
    a reason are kept, and nothing is said again until one of them changes. The fleets are the listen guard's, a
    moved one's export among them; a moved team is told the program form of `set --now`. Reads and stats files
    only: no process is started."""
    if fleet_worker(hook) or hook.input.get("stop_hook_active"):
        return None
    dirs = fleet_dirs(hook)
    if not hook.env.get("FLEET_DIR"):
        dirs = [d for d in dirs if served_by_session(hook, d)]
        dirs += _moved_served_dirs(hook, dirs)
    if not dirs:
        return None
    state = hook.load_state("fleet-idle") if hook.session_id else {}
    told = state.get("told") if isinstance(state.get("told"), dict) else {}
    lines, seen, clock = [], dict(told), time.time()
    for d in dirs:
        ledger = read_ledger(d)
        if ledger is None or ledger.get("status") in ("paused", "done") or fleet_role(ledger) != "coordinator":
            continue
        work = _queued_work(ledger)
        agents = [a for a in ledger.get("agents") or [] if isinstance(a, dict) and a.get("status") == "running"]
        lanes = [a for a in agents if not _no_lane(a)]
        silent = {id(a) for a in lanes if _silent(hook, d, a, clock)}
        why = _gives_why(ledger)
        mark = " | ".join((" ".join(sorted(i for i, _ in work)),
                           " ".join(sorted(str(a.get("id")) + ("~silent" if id(a) in silent else "") for a in agents)),
                           "why" if why else ""))
        seen[d] = mark
        if told.get(d) == mark or not work or len(silent) < len(lanes) or why:
            continue
        items = ", ".join(f"{i} ({_one_line(t, 60)})" for i, t in work[:IDLE_SHOWN])
        more = len(work) - IDLE_SHOWN
        how = (f'one program on the stdin of `{fleet_run_cli(hook.env)}`: `set("now", "..."); return records.apply(ops);`'
               if moved(d) else f'`{fleet_cli()} state {d} set --now "..."`')
        lines.append(IDLE.format(items=items + (f", and {more} more" if more > 0 else ""), how=how))
    if hook.session_id and seen != told:
        hook.save_state("fleet-idle", {**state, "told": seen})
    return Block("\n".join(lines)) if lines else None


NEWS_LINE = "Fleet news: {count} unread for {fleet}, never a wake. Read them when convenient: `{cli} news read --as {fleet}`."


def _registry_fleet(hook, d):
    """The name the registry gives the fleet at d (fleet/SPEC.md, the news), without a process."""
    real = os.path.realpath(d)
    try:
        paths = sorted(p for p in fleet_registry(hook.env).glob("*.json") if p.is_file())
    except OSError:
        return None
    for path in paths:
        try:
            entry = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(entry, dict) and isinstance(entry.get("id"), str) and isinstance(entry.get("dir"), str) \
                and os.path.realpath(entry["dir"]) == real:
            return entry["id"]
    return None


def _news_unread(hook, fleet):
    """The ids of the machine's news (REGISTRY/news/news.jsonl) that `fleet` has not read: to all or to it,
    not its own, after its cursor (REGISTRY/news/read/<fleet>)."""
    folder = fleet_registry(hook.env) / "news"
    try:
        after = int((folder / "read" / fleet).read_text().strip())
    except (OSError, ValueError):
        after = 0
    try:
        raw = (folder / "news.jsonl").read_bytes().decode("utf-8", "replace")
    except OSError:
        return []
    ids = []
    for text in raw.split("\n"):
        try:
            item = json.loads(text) if text.strip() else None
        except ValueError:
            continue
        if not isinstance(item, dict) or not isinstance(item.get("id"), int) or isinstance(item.get("id"), bool) \
                or not isinstance(item.get("to"), list):
            continue
        if item["id"] > after and ("all" in item["to"] or fleet in item["to"]) and item.get("from") != fleet:
            ids.append(item["id"])
    return ids


def fleet_news(hook):
    """SessionStart and Stop: one short line naming the machine's unread news for each fleet this session
    hosts (the guard's membership), never a block: news never wakes anyone. A Stop says it once per new item
    (the session's `fleet-news` state keeps the last item told); a SessionStart says it whenever any is unread."""
    if fleet_worker(hook) or not (fleet_registry(hook.env) / "news" / "news.jsonl").is_file():
        return None
    dirs = fleet_dirs(hook)
    if not hook.env.get("FLEET_DIR"):
        dirs = [d for d in dirs if served_by_session(hook, d)]
    told = hook.load_state("fleet-news") if hook.session_id and hook.event == "Stop" else {}
    lines, seen = [], dict(told)
    for d in dirs:
        fleet = _registry_fleet(hook, d)
        ids = _news_unread(hook, fleet) if fleet else []
        if not ids:
            continue
        if hook.event == "Stop" and isinstance(told.get(fleet), int) and max(ids) <= told[fleet]:
            continue
        seen[fleet] = max(ids)
        lines.append(NEWS_LINE.format(count=len(ids), fleet=fleet, cli=fleet_cli()))
    if hook.event == "Stop" and hook.session_id and seen != told:
        hook.save_state("fleet-news", seen)
    return "\n".join(lines) or None


SAID_ONCE = ("You answered on the page ({where}). Said once: end this turn with one line naming where, e.g. "
             "'Answered {first} on the page.' Do not repeat the answer here.")
SAID_ONCE_CHARS = 200  # "Answered #42 on the page." and a short note of what comes next fit; an answer does not
SAID_ONCE_LINES = 2
SAID_ONCE_TAIL = 256 * 1024  # the turn is read from the transcript's end, the window doubled until it holds it
SAID_ONCE_MAX = 8 * 1024 * 1024  # a turn longer than this is let stop: never read a whole long transcript
# A `fleet chat DIR say --re M` line as the chat prints it: `#42 coordinator -> user, a1: text [re #41]`
# (fleet/src/chat/chat.ts renderLines). A news item (`#21 <stamp> skills -> all [release, kept]: text`),
# a `fleet tell` (`<fleet>: ...`) or a state event never ends in `[re #M]`.
_POSTED = re.compile(r"^#(\d+) \S+(?: \([^)]*\))? -> (.+?): .*\[re #(\d+)(?:, marks? [\d, ]+)?\]\s*$", re.M)


def _is_prompt(entry):
    """Whether a transcript entry starts a turn: a user entry carrying text, not only tool results."""
    if entry.get("type") != "user" or entry.get("isSidechain"):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    return isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "text" for b in content)


def _current_turn(path):
    """(key, entries) of the transcript from the last prompt on, or None when no prompt is found in the
    last SAID_ONCE_MAX bytes. The key (the prompt's uuid, else its byte offset) names the turn."""
    size = os.path.getsize(path)
    window = SAID_ONCE_TAIL
    while True:
        start = max(0, size - window)
        with open(path, "rb") as f:
            f.seek(start)
            chunk = f.read(size - start)
        if start > 0:  # the first line is cut: skip it
            cut = chunk.find(b"\n") + 1
            chunk, start = chunk[cut:], start + cut
        entries, at = [], start
        for line in chunk.splitlines(keepends=True):
            offset, at = at, at + len(line)
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict):
                entries.append((offset, entry))
        prompts = [i for i, (_, e) in enumerate(entries) if _is_prompt(e)]
        if prompts:
            offset, prompt = entries[prompts[-1]]
            return str(prompt.get("uuid") or offset), [e for _, e in entries[prompts[-1]:]]
        if start == 0 or window >= SAID_ONCE_MAX:
            return None
        window *= 2


def _is_say(command):
    """Whether a shell command runs `fleet chat DIR say ... --re N` (the CLI by any path, or a variable naming
    it): a reply. A say with no --re answers nobody's message."""
    import shlex
    try:
        words = _tokens(shlex.split(command))
    except ValueError:
        return False
    return any(words[i] == "chat" and words[i + 2] == "say" and "fleet" in os.path.basename(words[i - 1]).lower()
               and any(w == "--re" or w.startswith("--re=") for w in words[i + 3:])
               for i in range(1, len(words) - 2))


def _from_user(dirs, ids):
    """Which of the message numbers `ids` are the user's own messages, in the chats of the fleets `dirs`."""
    found = set()
    for d in dirs:
        try:
            with open(os.path.join(d, "chat.jsonl"), "rb") as f:
                for line in f:
                    if b'"user"' not in line:
                        continue
                    try:
                        m = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(m, dict) and m.get("from") == "user" and m.get("id") in ids:
                        found.add(m["id"])
        except OSError:
            continue
    return found


def _blocks(entry, kind):
    content = (entry.get("message") or {}).get("content")
    return [b for b in content if isinstance(b, dict) and b.get("type") == kind] if isinstance(content, list) else []


def _result_text(block):
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text") or "") for b in content if isinstance(b, dict))
    return ""


def fleet_said_once(hook):
    """Stop: a coordinator or manager that answered the user on the page this turn (a `fleet chat DIR say
    --re M` whose output shows the message written to the user, M being one of the user's own messages)
    ends the turn with one line naming where, not the answer again. A news post, a `fleet tell`, a state
    event, or a message that answers no message of the user's is not an answer on the page. A final text over SAID_ONCE_LINES lines or SAID_ONCE_CHARS characters is blocked, once per
    turn: never on a stop that follows a stop hook's block (stop_hook_active), nor twice for one prompt."""
    if fleet_worker(hook) or hook.input.get("stop_hook_active"):
        return None
    if not any(read_ledger(d) is not None for d in fleet_dirs(hook)):
        return None
    path = hook.input.get("transcript_path")
    if not isinstance(path, str) or not os.path.isfile(path):
        return None
    turn = _current_turn(path)
    if turn is None:
        return None
    key, entries = turn
    state = hook.load_state("said-once") if hook.session_id else {}
    if state.get("turn") == key:
        return None
    says = [b.get("id") for e in entries if e.get("type") == "assistant" for b in _blocks(e, "tool_use")
            if b.get("name") == "Bash" and _is_say(str((b.get("input") or {}).get("command") or ""))]
    replies = []
    for e in entries:
        for b in _blocks(e, "tool_result"):
            if b.get("tool_use_id") in says and not b.get("is_error"):
                replies += [(int(n), int(m)) for n, to, m in _POSTED.findall(_result_text(b))
                            if re.search(r"(?:^|, )user\b", to)]
    if not replies:
        return None
    asked = _from_user(fleet_dirs(hook), {m for _, m in replies})
    posted = [f"#{n}" for n, m in replies if m in asked]
    if not posted:
        return None
    final = hook.input.get("last_assistant_message")
    if final is None:
        texts = [b for e in entries if e.get("type") == "assistant" for b in _blocks(e, "text")]
        final = str(texts[-1].get("text") or "") if texts else ""
    if not isinstance(final, str):
        return None
    final = final.strip()
    if len(final) <= SAID_ONCE_CHARS and len([x for x in final.splitlines() if x.strip()]) <= SAID_ONCE_LINES:
        return None
    if hook.session_id:
        hook.save_state("said-once", {"turn": key})
    return Block(SAID_ONCE.format(where=", ".join(dict.fromkeys(posted)), first=posted[-1]))


NUDGE_EVERY_S = 60
NUDGE_TAIL = 64 * 1024  # a session's first look reads this much of the chat's end, not all of it
NUDGE_SHOWN = 3


def fleet_now(env):
    """Now on the fleet's clock, in epoch seconds: $FLEET_NOW when set (scripts/clock.py), else the machine's."""
    return _instant(env.get("FLEET_NOW")) or time.time()


def _instant(text):
    """An ISO 8601 stamp in epoch seconds (no offset reads as UTC), or None."""
    from datetime import datetime, timezone
    if not isinstance(text, str) or not text:
        return None
    try:
        at = datetime.fromisoformat(text)
    except ValueError:
        return None
    return (at if at.tzinfo else at.replace(tzinfo=timezone.utc)).timestamp()


def _one_line(text, size):
    flat = " ".join(str(text).split())
    return flat if len(flat) <= size else flat[:size] + "…"


def _chat_since(path, offset):
    """(new offset, messages) of DIR/chat.jsonl after a byte offset: whole lines only (a torn last line
    waits for the next look). With no offset yet, only the file's last NUDGE_TAIL bytes are read. A chat
    that shrank, or was rewritten whole so that the offset no longer ends a line (a moved fleet's export),
    is read again from its tail."""
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        fresh = not isinstance(offset, int) or offset < 0 or offset > size
        if not fresh and offset > 0:
            f.seek(offset - 1)
            fresh = f.read(1) != b"\n"
        start = max(0, size - NUDGE_TAIL) if fresh else offset
        f.seek(start)
        chunk = f.read()
    if fresh and start > 0:  # the first line is cut: skip it
        cut = chunk.find(b"\n") + 1
        chunk, start = chunk[cut:], start + cut
    end = chunk.rfind(b"\n") + 1
    messages = []
    for line in chunk[:end].splitlines():
        # Only the user's messages and replies (re) matter here: skip the rest unparsed.
        if b'"user"' not in line and (b'"re": null' in line or b'"re":null' in line):
            continue
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if (isinstance(m, dict) and isinstance(m.get("id"), int) and isinstance(m.get("from"), str)
                and isinstance(m.get("to"), list) and isinstance(m.get("text"), str)):
            messages.append(m)
    return start + end, messages, fresh


def _answered_grill(d):
    """Whether ledger row `d` is a grilling still open with no question left open: every question answered
    and not recorded. The fleet's rule (fleet/src/health.ts `answeredGrill`, decisions.py `answered_grill`)."""
    questions = d.get("questions") if isinstance(d.get("questions"), list) else []
    return d.get("kind") == "grill" and d.get("status") == "open" and not any(
        isinstance(q, dict) and q.get("status") == "open" for q in questions)


def fleet_chat_nudge(hook):
    """PostToolUse: a coordinator or manager busy mid-turn hears its chat. At most once per NUDGE_EVERY_S
    per session, it reads the fleet's chat.jsonl from where it last stopped, and tells the session of each
    message from the user to its role left unread (after the watch's cursor) and unanswered, and of each
    answer to an open decision left unrecorded, for FLEET_NUDGE_MIN minutes (3) on the fleet's clock: only
    the decision's own state records it (decisions.py `recorded`), never a reply in the chat. An answer to a
    grilling that leaves every question answered is told once, as the grilling to record. Each message is
    told once. No process;
    the ledger is read only when something is due."""
    if fleet_worker(hook) or not hook.session_id:
        return None
    now = fleet_now(hook.env)
    state = hook.load_state("fleet-nudge")
    checked = state.get("checked")
    if isinstance(checked, (int, float)) and 0 <= now - checked < NUDGE_EVERY_S:
        return None
    dirs = fleet_dirs(hook)
    if not hook.env.get("FLEET_DIR"):
        dirs = dirs + _moved_served_dirs(hook, dirs)
    if not dirs:
        return None
    try:
        wait_s = float(hook.env.get("FLEET_NUDGE_MIN") or 3) * 60
    except ValueError:
        wait_s = 180.0
    fleets = state.get("fleets") if isinstance(state.get("fleets"), dict) else {}
    lines = []
    for d in dirs:
        seen = fleets.get(d) if isinstance(fleets.get(d), dict) else {}
        try:
            offset, messages, fresh = _chat_since(os.path.join(d, "chat.jsonl"), seen.get("offset"))
        except OSError:
            continue
        pending = {} if fresh or not isinstance(seen.get("pending"), dict) else seen["pending"]
        told = seen.get("told") if isinstance(seen.get("told"), list) else []
        for m in messages:
            if m["from"] == "user":
                if m["id"] not in told:
                    pending[str(m["id"])] = {"at": m.get("at"), "to": m["to"], "text": _one_line(m["text"], 80),
                                             "decision": m.get("decision")}
            elif isinstance(m.get("re"), int):
                answer = pending.get(str(m["re"]))
                # A reply to an answer to a decision does not record it: only the decision's own state does.
                if not (isinstance(answer, dict) and answer.get("decision")):
                    pending.pop(str(m["re"]), None)
        due = {k: p for k, p in pending.items() if not isinstance(p, dict)
               or (_instant(p.get("at")) is not None and now - _instant(p["at"]) >= wait_s)}
        if due:
            ledger = read_ledger(d) or {}
            role = fleet_role(ledger)
            try:
                with open(os.path.join(d, f"watch-{role}.cursor")) as f:
                    cursor = int(f.read().strip())
            except (OSError, ValueError):
                cursor = 0
            listed = ledger.get("decisions") if isinstance(ledger.get("decisions"), list) else []
            decisions = {x["id"]: x for x in listed if isinstance(x, dict) and isinstance(x.get("id"), str)}
            for k in sorted(due, key=lambda k: int(k) if k.isdigit() else 0):
                p = pending.pop(k)
                if not isinstance(p, dict) or not k.isdigit():
                    continue
                minutes = int((now - _instant(p["at"])) // 60)
                said = p.get("text") or ""
                if p.get("decision"):
                    dec = decisions.get(p["decision"]) if isinstance(p["decision"], str) else None
                    if not dec or dec.get("status") != "open":
                        continue
                    ref = dec.get("ref") or dec.get("id")
                    # A moved team records with a program; decide() names the card by its key, the row's id.
                    run = f"one program on the stdin of `{fleet_run_cli(hook.env)}`: "
                    if _answered_grill(dec):
                        how = (f'with {run}`{answer_program(dec.get("id"), "grilling finished")}`.' if moved(d) else
                               f'(`{fleet_cli()} state {d} decision {ref} --decide "..." --resolution "grilling finished"`).')
                        lines.append(
                            f'Fleet: {ref} ({_one_line(dec.get("title") or "", 60)}): every question is answered and the '
                            f'grilling is still open, not recorded for {minutes} min. Record it now {how}')
                        told.append(int(k))
                        continue
                    since = _instant(dec.get("revised") or dec.get("opened"))
                    if since is not None and _instant(p["at"]) < since:
                        continue  # an answer to the question before it was revised
                    if dec.get("held") and (_instant(dec.get("held_at")) or 0) >= _instant(p["at"]):
                        continue  # held after this answer: the fleet works on it first
                    questions = dec.get("questions") if isinstance(dec.get("questions"), list) else []
                    if any(isinstance(q, dict) and (_instant(q.get("answered")) or 0) >= _instant(p["at"]) for q in questions):
                        continue  # a grilling's question answered or dropped after it: recorded
                    how = (f'Record it and answer #{k} in {run}`{answer_program(dec.get("id"), f"answered on the page (#{k})", int(k))}`.'
                           if moved(d) else
                           f'Record it now (`{fleet_cli()} state {d} decision {ref} --decide "..." --resolution '
                           f'"answered on the page (#{k})"`), then answer #{k} with --re.')
                    lines.append(
                        f'Fleet: #{k} from the user answers {ref} ({_one_line(dec.get("title") or "", 60)}), '
                        f'not recorded for {minutes} min: "{said}". {how}')
                else:
                    to = p.get("to") if isinstance(p.get("to"), list) else []
                    if (to and role not in to) or int(k) <= cursor:
                        continue
                    lines.append(
                        f'Fleet: #{k} from the user, unread for {minutes} min: "{said}". Read the chat now '
                        f"(`{fleet_cli()} chat {d} inbox --as {role}`) and answer or record it.")
                told.append(int(k))
        fleets[d] = {"offset": offset, "pending": dict(list(pending.items())[-500:]), "told": told[-200:]}
    hook.save_state("fleet-nudge", {**state, "checked": now, "fleets": fleets})
    if not lines:
        return None
    more = len(lines) - NUDGE_SHOWN
    return "\n".join(lines[:NUDGE_SHOWN] + ([f"Fleet: and {more} more."] if more > 0 else []))


CLI_TIMEOUT_S = 25
GRANT_TTL_S = 30 * 60
SETTINGS_LOCK_WAIT_S = 2.0
SETTINGS_LOCK_STALE_S = 10.0
SETTINGS_LOCK_SHARED_WITH_HUB = ".settings.local.json.lock"
# tstack's own file beside the settings, <root>/.claude/tstack-grants.json (permission.ts's grantFileOf names it too),
# holds the Agent grants (`permissions.allow`): auto mode drops Agent allow rules from the settings, so the hub writes
# an Agent grant here instead and fleet_agent_grant lets the exact spawn through.
# The record of take-backs, <root>/.claude/hooks/tstack-grants-ended.json: `ended`, the grants taken back,
# `{decision, rule, granted, at}` each (`granted`: the grant line's `at`), newest last, the newest ENDED_KEPT kept. A
# grant on it is over whatever its file holds, so a rule the owner adds after the take-back, byte-identical to the
# one once granted, is the owner's and no sweep removes it (measured 2026-10-15: the chat watch's lasting rule went at
# the next sweep, twice). A grant is one grant line, not its decision: decision ids repeat (_permission_id hashes the
# caller and the call; a revised decision keeps its id), so a later grant of the same id and rule is not on record
# until it too is taken back.
# The threat model, plainly: the hub, the hook and every agent run as one Unix user, and grants.jsonl is in the
# fleet's DIR, a file any agent can write, so a `remove` line there is a record, never the proof. What an agent
# cannot write is the record's place. Claude Code's permission check protects all of `.claude/`, any file name, but
# for a few listed exceptions (worktrees, plans, agent memory): writes are prompted, routed to the classifier in auto
# mode (which refused an agent writing its own allow rule as `[Self-Modification]`), and allow rules do not
# pre-approve them (code.claude.com/docs/en/permission-modes, "Protected paths"). The sandbox's write-deny is
# narrower: the settings files and the skills, agents, commands and hooks directories (code.claude.com/docs/en/
# sandboxing, "Protected paths"), so the record sits in `.claude/hooks/`, under both, as the allow rules do: an agent
# that could forge a take-back there could as well write the lasting rule, so the record adds nothing to what it can
# do. The same goes for which grants exist: when the hub grants, it first puts each grant on the root's record of
# issued grants, <root>/.claude/hooks/tstack-grants-issued.json: `issued`, `{decision, ref, rule, file, at, n, of, rev,
# dir[, runs]}` each, newest last, the newest 4096 kept (grants.ts ISSUED_KEPT). The newest entry of a file and rule is
# its grant, standing while its rule is in its file and it is not on the record of take-backs; its `at` (the 30
# minutes), `runs` (the sha256 of each file its call runs), `n` (its turn) and `ref` are the entry's. grants.jsonl is
# the log: a line names a root to read, and a deleted line hides no grant (measured on 83448844, which found grants
# from lines: with the line deleted an edited bound script ran, ran again, and `A; A` passed). A line with no entry
# grants nothing: it is expired at once, and the sweep takes its rule back. A take-back's `why` is on the record of
# take-backs, so a list's turn is read from the records: each earlier call must have ended `used` (_out_of_turn).
# What stays, accepted: a forged `grant` line of a rule with no entry on record can make the sweep remove it, the
# owner's included; that failure is fewer allowed calls.
AGENT_GRANTS = "tstack-grants.json"
ENDED_RECORD = "tstack-grants-ended.json"
ISSUED_RECORD = "tstack-grants-issued.json"
GRANT_FILES = ("settings.local.json", AGENT_GRANTS)
ENDED_KEPT = 4096

Refused = namedtuple("Refused", "tool call spawn kept agent_id reason root")

# What a refusal draft keeps of a refused call: a Bash command past it is no call a permission can hold (2,000
# characters), and another tool's input (a Write's whole file) is the host's to read in the session, not the ledger's.
CALL_KEPT = 4000


def _statuses(ledger, key):
    listed = ledger.get(key) if isinstance(ledger.get(key), list) else []
    return {x["id"]: x.get("status") for x in listed if isinstance(x, dict) and isinstance(x.get("id"), str)}


def _permission_id(ledger, agent_id, call):
    """The refusal's id: p-<8 hex of sha1(caller, call)>, so a second refusal of the same call by the same caller
    is its open draft, or the open decision that asked it, again; when that is closed (the decision decided or
    withdrawn, the draft dropped), the first of -2, -3 ... absent or open. A decision and the draft it came from
    share the id, and the decision's status is the one that counts."""
    import hashlib
    base = "p-" + hashlib.sha1(f"{agent_id or 'main'}\n{call}".encode()).hexdigest()[:8]
    decisions, drafts = _statuses(ledger, "decisions"), _statuses(ledger, "refusals")
    n = 1
    while True:
        candidate = base if n == 1 else f"{base}-{n}"
        if decisions.get(candidate, drafts.get(candidate, "open")) == "open":
            return candidate
        n += 1


def _refused_worker(ledger, agent_id, env):
    """The worker row of the refused caller: the agents row whose task_id is the harness's agent id,
    else $FLEET_WORKER, else None (the session's main thread)."""
    agents = ledger.get("agents") if isinstance(ledger.get("agents"), list) else []
    for row in agents:
        if agent_id and isinstance(row, dict) and row.get("task_id") == agent_id and isinstance(row.get("id"), str):
            return row["id"]
    return env.get("FLEET_WORKER") or None


def _agent_call(tool_input):
    """An Agent call as a grant names it: its input as compact JSON, keys sorted."""
    return json.dumps(tool_input, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _option(flag, value):
    """One option's argv words; a value the CLI's parser would read as a flag is joined to it."""
    value = str(value)
    return [f"{flag}={value}"] if value.startswith("-") and " " not in value else [flag, value]


# A refusal that says nothing about the call: the classifier model was unavailable, and the harness tells Claude to
# repeat the identical call once ("This is not a judgement against Artifact. Repeat the identical Artifact call once
# now"). The repeat usually runs, so the first such refusal of a call opens nothing; the same call refused again within
# TRANSIENT_AGAIN_S opens the item as any refusal does. Measured 2026-10-12: two Artifact calls refused so, each of
# which ran on its repeat, had opened two actions for the user.
# Only the reason's opening counts: the fixed text the hooks reference gives for the outage, `Classifier unavailable`,
# or that sentence. A verdict (`[Data Exfiltration] ...`) whose prose happens to hold those words is a verdict.
TRANSIENT = re.compile(r"\s*(?:Classifier unavailable\b|This is not a judge?ment against\b)", re.I)
TRANSIENT_AGAIN_S = 10 * 60
TRANSIENT_STATE = "transient-refusals"


def _call_of(tool, tool_input):
    """A tool call as a refusal names it: a Bash command, an Agent call's compact input, else the tool and its input."""
    command = tool_input.get("command") if tool == "Bash" else None
    if isinstance(command, str):
        return command
    if tool == "Agent" and tool_input:
        return _agent_call(tool_input)
    return f"{tool}\n{json.dumps(tool_input, sort_keys=True)}"


def _refusal_key(agent_id, call):
    import hashlib
    return hashlib.sha1(f"{agent_id or 'main'}\n{call}".encode()).hexdigest()[:16]


def _transient_dir(hook):
    """Where a session remembers its transient refusals: one file per caller and call, its content the instant. One
    file each, so parallel refusals (PermissionDenied runs async, a batch of calls at once) never write over each other."""
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", hook.session_id) or "unknown"
    return hook.data_dir / "sessions" / f"{safe}.{TRANSIENT_STATE}"


def _remembered_at(path):
    try:
        return float(path.read_text())
    except (OSError, ValueError):
        return None


def _remember(path, now):
    tmp = path.with_name(f".{path.name}.{os.getpid()}")
    tmp.write_text(repr(now))
    os.replace(tmp, path)


def _first_transient(hook, agent_id, call, reason):
    """Whether this refusal is a transient one seen for the first time: it is then remembered, by caller and call, and
    opens nothing. A second one of the same call within TRANSIENT_AGAIN_S is a real refusal. When the memory cannot be
    kept or read, it is not a first one: the item opens, since a refusal shown twice costs less than one never shown."""
    if not hook.session_id or not TRANSIENT.match(reason):
        return False
    now = fleet_now(hook.env)
    folder = _transient_dir(hook)
    path = folder / _refusal_key(agent_id, call)
    try:
        for attempt in (1, 2):
            folder.mkdir(parents=True, exist_ok=True)
            try:
                with open(path, "x", encoding="utf-8") as f:  # atomic: of two refusals at once, one is the first
                    f.write(repr(now))
                break
            except FileNotFoundError:  # the folder went with the last call that ran, between the two lines above
                if attempt == 2:
                    raise
            except FileExistsError:
                at = _remembered_at(path)
                lapsed = at is not None and now - at >= TRANSIENT_AGAIN_S
                _remember(path, now)
                return lapsed
        for other in folder.iterdir():  # what lapsed goes, so the folder holds ten minutes of refusals at most
            at = None if other.name.startswith(".") else _remembered_at(other)
            if at is not None and now - at >= TRANSIENT_AGAIN_S:  # a hook that began after this one wrote a later instant
                other.unlink(missing_ok=True)
        return True
    except OSError as e:
        log(hook.data_dir, f"{hook.event} fleet_permission_denied: the transient refusals of this session cannot be kept "
                           f"({e}); opening the item")
        return False


def fleet_refusal_forgotten(hook):
    """PostToolUse: a call that ran is no longer a refusal waiting for its repeat, so the next transient refusal of the
    same call is a first one again. One stat when the session remembers none."""
    if not hook.session_id:
        return None
    folder = _transient_dir(hook)
    if not folder.is_dir():
        return None
    data = hook.input
    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    agent_id = data.get("agent_id") if isinstance(data.get("agent_id"), str) and data.get("agent_id") else None
    try:
        (folder / _refusal_key(agent_id, _call_of(data.get("tool_name"), tool_input))).unlink()
    except OSError:
        return None
    try:
        folder.rmdir()
    except OSError:  # it still remembers others
        pass
    return None


REFUSAL_NOTES = "refusal-notes"
REFUSAL_NOTE_S = 30 * 60
# What a refused worker reads beside its next tool call. The last sentence is for a worker whose brief says to
# report "blocked" and then end with its report: one refused call does not end the work that needs none.
REFUSAL_NOTE = ("Fleet: auto mode refused {what}. {heard}. The {host} decides whether the user is asked, and nothing was "
                "asked yet. Do not repeat or reword {it}, and take no other route to the same act. Report `blocked: <what "
                "you needed it for>` to the {host} (SendMessage), then go on with the work that does not need it. For a "
                "refused call this replaces your brief's \"then end with your report\": end with your report when "
                "nothing else is left.")


def _refusal_notes(hook):
    """Where a session keeps what it owes a refused caller: one file per caller and draft, the notes it reads at its
    next tool call. PermissionDenied reads only `retry` from a hook, so the denial's own text cannot say it."""
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", hook.session_id) or "unknown"
    return hook.data_dir / "sessions" / f"{safe}.{REFUSAL_NOTES}"


def _noted_caller(hook, agent_id):
    """Whose note a refusal is: a subagent by the harness's id; `main` for a worker that runs as its own session
    ($FLEET_WORKER); None for a host's main thread, which hears the host's line itself."""
    if isinstance(agent_id, str) and agent_id:
        return agent_id
    return "main" if hook.env.get("FLEET_WORKER") else None


def _owe_note(hook, r, d, draft_id, told):
    """Remember the note for the caller whose call was refused: one file per draft, so two refusals at once (the
    event runs async) both stay owed. `told` is whether the CLI reached the host with its line."""
    caller = _noted_caller(hook, r.agent_id)
    if not caller or not hook.session_id:
        return
    folder = _refusal_notes(hook)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{_refusal_key(caller, '')}.{re.sub(r'[^A-Za-z0-9_.-]', '_', draft_id)}"
        tmp = path.with_name(f".{path.name}.{os.getpid()}")
        tmp.write_text(json.dumps({"at": fleet_now(hook.env), "tool": r.tool, "reason": _one_line(r.reason, 120),
                                   "id": draft_id, "host": fleet_role(read_ledger(d)), "told": bool(told)}))
        os.replace(tmp, path)
    except OSError as e:
        log(hook.data_dir, f"{hook.event} fleet_permission_denied: the note for the refused worker cannot be kept ({e})")


def _listed(ids):
    return f"refusal draft {ids[0]}" if len(ids) == 1 else f"refusal drafts {', '.join(ids)}"


def _refusal_note(notes):
    """The one note for every draft still owed to a caller: one call by its tool and reason, several by their ids
    alone. It says the host was told only of the drafts the CLI did tell it of."""
    host = "manager" if notes[-1].get("host") == "manager" else "coordinator"
    ids = [_one_line(n.get("id") or "", 60) for n in notes]
    heard = [i for i, n in zip(ids, notes) if n.get("told") is not False]
    unheard = [i for i in ids if i not in heard]
    one = len(notes) == 1
    later = f"the {host} will see {'it' if len(unheard) == 1 else 'them'} at its next state command or watch"
    if not unheard:
        heard_words = f"The plugin's hook told the {host} at once, as {_listed(ids)}"
    elif not heard:
        heard_words = f"{'It is' if one else 'They are'} {_listed(ids)}: the plugin's hook could not tell the {host} at once, and {later}"
    else:
        heard_words = (f"The plugin's hook told the {host} at once of {_listed(heard)}; of {_listed(unheard)} it could "
                       f"not, and {later}")
    what = (f"your {_one_line(notes[0].get('tool') or 'tool', 80)} call ({_one_line(notes[0].get('reason') or '', 120)})"
            if one else f"{len(notes)} of your calls")
    return REFUSAL_NOTE.format(what=what, heard=heard_words, host=host, it="the call" if one else "them")


def fleet_refusal_note(hook):
    """PostToolUse: a caller whose call auto mode refused reads, beside the result of its next tool call, what
    happened to the refusal: its host was told (or will see it), nothing was asked of the user, it reports `blocked:`
    and goes on. Every draft still owed to it is in the one note. Told once; one stat when the session owes none."""
    caller = _noted_caller(hook, hook.input.get("agent_id"))
    if not hook.session_id or not caller:
        return None
    folder = _refusal_notes(hook)
    if not folder.is_dir():
        return None
    prefix = f"{_refusal_key(caller, '')}."
    notes = []
    try:
        owed = sorted(p for p in folder.iterdir() if p.name.startswith(prefix))
    except OSError:
        return None
    for path in owed:
        taken = path.with_name(f".{path.name}.read.{os.getpid()}")
        try:
            os.replace(path, taken)  # atomic: of two tool calls that end at once, one reads the note
            note = json.loads(taken.read_text())
            taken.unlink()
        except (OSError, ValueError):
            continue
        if isinstance(note, dict) and isinstance(note.get("at"), (int, float)) \
                and fleet_now(hook.env) - note["at"] < REFUSAL_NOTE_S:
            notes.append(note)
    try:
        folder.rmdir()
    except OSError:  # it still owes others
        pass
    if not notes:
        return None
    return _refusal_note(sorted(notes, key=lambda n: n["at"]))


def fleet_permission_denied(hook):
    """PermissionDenied: a call auto mode refused is recorded in every fleet of the session. A Bash command and a
    call of any other tool become a refusal draft for the fleet's host (fleet/SPEC.md, Permission grants): the CLI
    records it and tells the host at once, and nothing is opened for the user until the host asks in its own words.
    An Agent spawn opens its permission as before: the user allows that exact spawn once from the page."""
    dirs = grant_dirs(hook)
    if not dirs:
        return None
    data = hook.input
    tool = data.get("tool_name") if isinstance(data.get("tool_name"), str) else "a tool"
    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    agent_id = data.get("agent_id") if isinstance(data.get("agent_id"), str) and data.get("agent_id") else None
    reason = data.get("reason") if isinstance(data.get("reason"), str) and data.get("reason").strip() else "no reason given"
    project = hook.env.get("CLAUDE_PROJECT_DIR")
    root = project if project and os.path.isabs(project) else hook.cwd
    call = _call_of(tool, tool_input)
    if _first_transient(hook, agent_id, call, reason):
        log(hook.data_dir, f"{hook.event} fleet_permission_denied: a transient refusal of {tool} ({_one_line(reason, 120)}); "
                           f"nothing opened unless the same call is refused again")
        return None
    spawn = tool == "Agent" and bool(tool_input)
    if spawn or (tool == "Bash" and isinstance(tool_input.get("command"), str)):
        kept = call
    else:
        kept = json.dumps(tool_input, sort_keys=True, ensure_ascii=False)
    if not spawn and len(kept) > CALL_KEPT:
        kept = f"{kept[:CALL_KEPT]}… ({len(kept) - CALL_KEPT} more characters, cut by the hook)"
    refused = Refused(tool, call, spawn, kept, agent_id, reason, root)
    for d in dirs:
        try:
            _open_refusal(hook, d, refused)
        except Exception:  # one fleet failing does not keep the item from the others
            log(hook.data_dir, f"{hook.event} fleet_permission_denied failed for {d}\n{traceback.format_exc()}")
    return None


def _open_refusal(hook, d, r):
    import subprocess
    cli = hook.env.get("TSTACK_FLEET_CLI") or fleet_cli()
    ledger = read_ledger(d) or {}
    worker = _refused_worker(ledger, r.agent_id, hook.env)
    refusal_id = _permission_id(ledger, r.agent_id, r.call)
    if moved(d):
        return _open_refusal_program(hook, d, r, ledger, worker, refusal_id)
    # The words are the CLI's (a spawn's title, from its input) or the host's (a draft has none): the hook writes none.
    argv = [cli, "state", d, "decision", refusal_id, *_option("--kind", "permission" if r.spawn else "refusal"),
            *_option("--tool", r.tool if re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", r.tool) else "unnamed"),
            *_option("--call", r.kept or "{}"), *_option("--cause", r.reason), *_option("--root", r.root)]
    if r.spawn:
        argv.append("--blocking")
    if r.agent_id:
        argv += _option("--agent-id", r.agent_id)
    if worker:
        argv += _option("--agent", worker)
    done = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, env=dict(hook.env), check=False,
                          timeout=CLI_TIMEOUT_S)
    if done.returncode:
        raise RuntimeError(f"{cli} state exited {done.returncode}: {(done.stderr or done.stdout).strip()}")
    untold = "could not tell the " in done.stderr
    if untold:
        log(hook.data_dir, f"{hook.event} fleet_permission_denied: {refusal_id} is in {d}'s ledger, and {done.stderr.strip()}")
    if not r.spawn and done.stdout.startswith(f"drafted {refusal_id}:"):
        _owe_note(hook, r, d, refusal_id, told=not untold)


def _open_refusal_program(hook, d, r, ledger, worker, refusal_id):
    """A refusal on a moved fleet, as one program (decision 51, revised for H1, narrowed by review s3fix). The mirror
    has no refusal drafts, so the hook asks the user itself: a permission card with the exact call, its rule and its
    root, which the host needs to apply an allow-once grant. Narrowed against decision 51: only a Bash call an exact
    rule can hold (the old CLI's whyNoRule) and an Agent spawn get a card. Another tool's call (WebFetch, Write…)
    gets none, since Claude Code matches no `Tool(<json>)` rule and the grant would never let it through: the user
    allows it in the terminal. A call no card can hold, one that may carry a credential (whose text and cause stay
    out of the cloud), or a card the fleet refused, is an important `blocked` event for the host instead; nothing is
    asked of the user for it, and the host hears of it from the ledger, not a chat line, so the refused worker's note
    says the host was not told at once. When fleet-run cannot take the refusal at all (it exits 2, 4 or 5 twice,
    outlasts CLI_TIMEOUT_S, or cannot be started), the note is owed the same way, and the failure is raised for the log."""
    import subprocess
    host = fleet_role(ledger)
    if _statuses(ledger, "decisions").get(refusal_id) == "open":
        return
    try:
        card = refusal_card_program(refusal_id, r, worker, host)
        if card is not None:
            try:
                fleet_run(hook, d, card)
                return
            except Unapplied as e:
                log(hook.data_dir, f"{hook.event} fleet_permission_denied: {refusal_id}'s card was not applied, so the "
                                   f"host is told with a blocked event: {e}")
        fleet_run(hook, d, blocked_program(refusal_blocked_text(refusal_id, r, worker, host, card is not None), worker))
    except (RuntimeError, subprocess.TimeoutExpired, OSError):
        _owe_note(hook, r, d, refusal_id, told=False)
        raise
    _owe_note(hook, r, d, refusal_id, told=False)


CARD_CALL_MAX = 2000  # the CLI's MAX_CALL_CHARS (fleet/src/ledger/permission.ts): a longer call is no rule a grant holds
# The cloud's RECORD_LIMIT_BYTES is 256 KiB (fleet repo, packages/ledger/src/wire.ts), and a spawn's card holds its
# input twice (call and rule): a larger one is answered 413, so it is a blocked event instead.
SPAWN_CARD_MAX_BYTES = 120 * 1024
BLOCKED_CALL_MAX = 300  # a blocked event names the call by its start: the host reads it whole from the worker
# A call that may carry a credential (N2): its text never goes to the cloud. Over-matching costs a card, not a secret.
# A header (Bearer, Authorization:, X-Api-Key:), a key named like one (`token=`, `AWS_SECRET_ACCESS_KEY=`, `pass: x`),
# a vendor token's prefix, an AWS key id, a PEM block, a URL's userinfo (`https://u:pw@host`), a password flag
# (`--password x`, `curl -u admin:pw`, `mysql -ppw`, `sshpass -p`, `docker login -p`), npm's `_authToken`.
SECRET_IN_CALL = re.compile(r"\bBearer\s|\bAuthorization:|\bAKIA[0-9A-Z]{12}|-----BEGIN|_authToken\b"
                            r"|[\w-]*(?:api[_-]?key|token|secret|access[_-]?key|password|passwd|pwd|authtoken)[\w-]*\s*[:=]"
                            r"|\b(?:sk-|ghp_|gho_|ghs_|github_pat_|glpat-|npm_|xox[abposr]-)[A-Za-z0-9]"
                            r"|://[^/\s:@]+:[^/\s@]+@|--pass(?:word)?\b|\s-u\s*\S+:\S"
                            r"|\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;&|\n]*\s-p\S"
                            r"|\b(?:sshpass|docker\s+login)\b[^;&|\n]*\s-p\b", re.I)
# A 1Password reference read by a Bash call (`op read op://…`). A spawn's prompt or a tool's input may name one
# without reading it, and a reference is no secret: there it costs no card.
OP_REFERENCE = re.compile(r"op://")


def _carries_secret(r):
    """Whether a refusal may carry a credential: auto mode named it a Credential one, or its call or its cause holds
    what reads as one (SECRET_IN_CALL), or it is a Bash call reading a 1Password reference."""
    return bool(re.search(r"credential", r.reason, re.I) or any(SECRET_IN_CALL.search(t) for t in (r.call, r.kept, r.reason))
                or (r.tool == "Bash" and OP_REFERENCE.search(r.call)))


def why_no_rule(tool, call):
    """Why no exact rule can let tool's call through and be read by the user as what runs, or None when one can: the
    old CLI's whyNoRule (fleet/src/ledger/permission.ts), in its words. An Agent call is its input as a JSON object;
    for Bash a newline ends a rule, a `*` is a wildcard, a backslash an escape, no exact rule clears a pipe, a
    character outside printable ASCII imitates another, a space at either end is trimmed, and a call past
    CARD_CALL_MAX is not read whole."""
    if tool == "Agent":
        try:
            return None if isinstance(json.loads(call), dict) else "an Agent call is its tool input, a JSON object"
        except ValueError:
            return "an Agent call is its tool input, a JSON object"
    if not call.strip():
        return "the call is empty"
    if "\n" in call or "\r" in call:
        return "the call has a newline, which an exact allow rule cannot hold"
    if "*" in call:
        return "the call has a *, which an allow rule reads as a wildcard"
    if "\\" in call:
        return "the call has a backslash, which an allow rule reads as an escape"
    if "|" in call:
        return "the call has a |, and no exact allow rule clears a piped command"
    odd = next((i for i, c in enumerate(call) if c < " " or c > "~"), None)
    if odd is not None:
        return (f"the call has a character outside printable ASCII at position {odd + 1} (U+{ord(call[odd]):04X}), "
                "which the user cannot tell from a plain one on the card")
    if call != call.strip():
        return "the call starts or ends with a space, which is no part of the command"
    if len(call) > CARD_CALL_MAX:
        return (f"the call is {len(call)} characters, and a permission's call is at most {CARD_CALL_MAX}, so the user "
                "reads it whole")
    return None


def _why_no_card(r):
    """Why the hook opens no card for a refused call on a moved fleet, or None when it opens one."""
    if _carries_secret(r):
        return "the call may carry a credential"
    if r.spawn:
        size = len(r.call.encode())
        if size > SPAWN_CARD_MAX_BYTES:
            return f"the spawn's input is {size} bytes, more than one card of the cloud holds"
        return why_no_rule("Agent", r.call)
    if r.tool != "Bash":
        return (f"Claude Code matches no allow rule of a {_one_line(r.tool, 60)} call's input, so a card's grant would "
                "never let it through: the user allows it in the terminal")
    return why_no_rule("Bash", r.call)


def refusal_card_program(refusal_id, r, worker, host):
    """The program that opens a refused call's permission card under refusal_id, or None when no card can hold the
    call (_why_no_card): the whole call is its rule."""
    if _why_no_card(r) is not None:
        return None
    card = _spawn_card(r, worker, host) if r.spawn else _call_card(r, worker, host)
    return fleet_program(f"decision.open({_js(refusal_id)}, {_js(card)})")


def refusal_blocked_text(refusal_id, r, worker, host, carded=False):
    """The `blocked` event's text for a refusal no card holds (carded: the fleet refused the card the hook sent). A
    call that may carry a credential is named by its tool and refusal id alone; a Bash call or a spawn by its first
    BLOCKED_CALL_MAX characters; another tool's by its file_path or url alone (_named_target)."""
    tool = r.tool if re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", r.tool) else "unnamed"
    who = worker or f"the {host}"
    if _carries_secret(r):
        return (f"Auto mode refused a {tool} call of {who}: refusal {refusal_id}. It may carry a credential, so the "
                f"hook records neither the call nor its cause, and opens no card. Nothing was asked of the user: the "
                f"{host} asks the worker what it needed, and the user allows it in the terminal or not at all.")
    why = "the fleet did not apply its card" if carded else _why_no_card(r)
    kept = (r.kept or "{}") if r.spawn or r.tool == "Bash" else _named_target(r.call)
    if len(kept) > BLOCKED_CALL_MAX:
        kept = f"{kept[:BLOCKED_CALL_MAX]}… ({len(kept) - BLOCKED_CALL_MAX} more characters, cut by the hook)"
    return (f"Auto mode refused a {tool} call of {who} ({_one_line(r.reason, 120)}): refusal {refusal_id}. No card "
            f"was opened: {why}. Nothing was asked of the user: the {host} asks the worker for a form an exact rule "
            f"can hold, words a permission card itself, or drops it. The call, from {r.root}: {kept}")


def _named_target(call):
    """What a blocked event names of another tool's call: its file_path or its url (userinfo, query and fragment
    dropped: a presigned or SAS URL signs in its query), never the rest of its input (a Write's content, a WebFetch's prompt), which stays the host's to read in the session."""
    from urllib.parse import urlsplit, urlunsplit
    _, _, given = call.partition("\n")
    try:
        tool_input = json.loads(given)
    except ValueError:
        return "(its input is not recorded)"
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    path, url = tool_input.get("file_path"), tool_input.get("url")
    if isinstance(path, str) and path:
        return path
    if isinstance(url, str) and url:
        try:
            parts = urlsplit(url)
            return urlunsplit(parts._replace(netloc=parts.netloc.rpartition("@")[2], query="", fragment=""))
        except ValueError:
            return "(a url that does not parse)"
    return "(its input is not recorded)"


def _who(r, worker, host):
    """Who a card names as the caller, as the CLI's whoRefused does: the worker, else a subagent the ledger does not
    know as "a worker", else the host's main thread."""
    return worker or ("a worker" if r.agent_id else f"the {host}")


def _refusal_of(r, call):
    """A permission card's refused call: the exact call, its rule, the cause, and the root it ran in (round A's
    RefusedCall keeps call and root in the cloud)."""
    return {"tool": r.tool, "call": call, "rule": f"{r.tool}({call})", "cause": r.reason, "root": r.root,
            "agent_id": r.agent_id}


def _allow_options(what):
    return [{"id": "allow-once", "label": "Allow this call once",
             "consequence": f"the worker {what}, once, and nothing like it after: the one-time grant goes once it is "
                            "used, or after 30 minutes"},
            {"id": "deny", "label": "Deny", "consequence": "the worker stays stopped; your note goes to it"}]


def _call_card(r, worker, host):
    """A refused Bash command's permission card, in the CLI's words where they are short to give (permissionWords): a
    one-line command shows whole in the title, a compound one by its parts. Only for a call an exact rule can hold
    (refusal_card_program checks)."""
    call = r.call
    who = _who(r, worker, host)
    try:
        parts = len(_segments(call))
    except ValueError:
        parts = 2
    if parts <= 1 and not re.search(r"[;&<>`]|\$\(", call):
        gist = _one_line(call, 100)
        cut = "" if gist == call else " (cut, see the exact call)"
        title = f"Allow {who} to run `{gist}`{cut}?"
        question = f"Let {who} run this exact call once? It runs `{gist}`{cut}."
    else:
        count = f"{max(parts, 1)} {'part' if parts == 1 else 'parts'}"
        title = f"Allow {who} to run a compound command ({count})?"
        question = (f"Let {who} run this exact call once? It is a compound command of {count}: read the exact call "
                    "in full below before you answer.")
    return {"kind": "permission", "title": title, "question": question,
            "why": f"Auto mode stopped this call: {r.reason}. Only you can let it through.",
            "blocking": True, "agent": worker, "options": _allow_options("runs exactly the call shown above"),
            "refusal": _refusal_of(r, call)}


def _spawn_card(r, worker, host):
    """A refused spawn's permission card, worded as the CLI words one (permission-words.ts, permissionOptions)."""
    try:
        spawn = json.loads(r.call)
    except ValueError:
        spawn = {}
    spawn = spawn if isinstance(spawn, dict) else {}
    kind = _one_line(spawn.get("subagent_type") or "general-purpose", 40)
    said = _one_line(spawn.get("description") or "", 60)
    who = _who(r, worker, host)
    described = f", described by {'the worker' if worker or r.agent_id else who} as “{said}”" if said else ""
    a = "an" if kind[:1].lower() in "aeiou" else "a"
    return {"kind": "permission", "title": f"Allow {who} to start {a} {kind} agent{described}?",
            "question": f"Let {who} start this exact {kind} agent once? Read its input in full below before you answer.",
            "why": f"Auto mode stopped this call: {r.reason}. Only you can let it through.",
            "blocking": True, "agent": worker, "options": _allow_options("starts exactly the agent shown above"),
            "refusal": _refusal_of(r, r.call)}


def _grant_file(value, seen=None):
    """A grant's file, when it is one the hook may rewrite: an absolute <root>/.claude/settings.local.json, or
    <root>/.claude/tstack-grants.json for an Agent grant, whose folder is its own realpath, and where neither the file,
    .claude/hooks nor a record in it is a symlink. Else nothing there is read, taken back or written (review 3: a
    symlinked .claude/hooks, or a `<link>/..` the hub's join reads by its text, sent a take-back onto another root's
    record). `seen` caches the answer by path."""
    if seen is not None and value in seen:
        return seen[value]
    file = None
    if isinstance(value, str) and value.startswith("/"):
        folder, name = os.path.split(value)
        hooks = os.path.join(folder, "hooks")
        if (name in GRANT_FILES and os.path.basename(folder) == ".claude" and os.path.realpath(folder) == folder
                and not any(os.path.islink(p) for p in (value, hooks, os.path.join(hooks, ENDED_RECORD),
                                                        os.path.join(hooks, ISSUED_RECORD)))):
            file = value
    if seen is not None and isinstance(value, str):
        seen[value] = file
    return file


GRANT_STATE_MAX_BYTES = 8 * 1024 * 1024
GRANTS_TAKEN = "grants.taken"


def _read_grants(d):
    """A fleet's grants.jsonl as (bytes, None), empty when it has none; (None, why) when it is there and cannot be
    read, or is larger than a record of grants ever is: the caller then fails closed."""
    path = os.path.join(d, "grants.jsonl")
    try:
        if os.path.getsize(path) > GRANT_STATE_MAX_BYTES:
            return None, f"{path} is larger than {GRANT_STATE_MAX_BYTES // (1024 * 1024)} MB"
        with open(path, "rb") as f:
            return f.read(), None
    except FileNotFoundError:
        return b"", None
    except OSError as e:
        return None, f"{path} cannot be read ({e.strerror})"


def _session_root(hook):
    """The session's root: $CLAUDE_PROJECT_DIR, else its cwd; None when neither is an absolute path."""
    project = hook.env.get("CLAUDE_PROJECT_DIR")
    root = project if project and os.path.isabs(project) else hook.cwd
    return root if isinstance(root, str) and os.path.isabs(root) else None


def _grant_lines(raw, seen=None):
    """The (file, line) of each line of a grants.jsonl that reads as a grant or remove of a grant file, in order."""
    lines, seen = [], {} if seen is None else seen
    for line in raw[:raw.rfind(b"\n") + 1].splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or not isinstance(entry.get("decision"), str) or not isinstance(entry.get("rule"), str):
            continue
        # A line that names the user's settings.json (where a rule card's entry goes) is one _grant_file never takes:
        # nothing here takes it back. A line that says `lasting` of a session's grant file is the one-time grant it is.
        file = _grant_file(entry.get("file"), seen)
        if file is not None:
            lines.append((file, entry))
    return lines


def _recorded_grant(entry, ended):
    """A grant as the hook reads it, from its entry on the record of issued grants: `turn` its `n`, `over` whether
    it is on the record of take-backs, `ended` the why recorded there (None while it stands)."""
    why = _ended_why(ended, entry)
    return {"op": "grant", "decision": entry["decision"], "rule": entry["rule"], "file": entry["file"], "at": entry["at"],
            "rev": entry.get("rev") if isinstance(entry.get("rev"), str) else None,
            "ref": entry.get("ref") if isinstance(entry.get("ref"), str) else None, "runs": entry.get("runs"),
            "turn": entry["n"] if isinstance(entry.get("n"), int) else 1, "over": why is not None,
            "ended": why, "issued": entry}


def _latest_grants(hook, raw):
    """The grant of each (file, rule): the newest entry of it on the record of issued grants of the session's root
    and of each root a grants.jsonl line names (an earlier entry of the same rule is superseded, ended or not). The
    record is the hub's, in `.claude/hooks/`, where no agent writes; grants.jsonl is the fleet's log, which any agent
    can write, so a line found nothing and hides nothing: a grant whose line was deleted still stands, and is held
    to its bounds. A record holds only the grants of its own root (_read_issued), and the session root's is read
    first: no entry of a root a line names replaces one of the session's (review 2: one did, from a folder the agent
    made, with a later `at` and no `runs`). A line names a root to read, and a line of a (file, rule) that has no entry on record is kept as a
    grant on no record (`issued` None), which grants nothing and is taken back at once: a grant of a hub that wrote
    no record, or a forged line, whose failure is fewer allowed calls; its take-back is marked `line` (_line_ended).
    Each grant has `over` (on the root's record of take-backs, _ended_of), `ended` (the why recorded there), `turn` (its `n`), and `runs` and `ref`, all from
    the record, never from a line."""
    lines = _grant_lines(raw, hook._grant_files)
    root = _session_root(hook)
    if root and ("root", root) not in hook._grant_files:
        hook._grant_files[("root", root)] = _grant_file(os.path.join(os.path.realpath(root), ".claude", GRANT_FILES[0]),
                                                        hook._grant_files)
    own = hook._grant_files.get(("root", root)) if root else None
    places = {}
    for file in ([own] if own else []) + [f for f, _ in lines]:
        places.setdefault(os.path.dirname(file), file)
    latest = {}
    for place in places.values():
        newest = {(entry["file"], entry["rule"]): entry for entry in _issued_of(hook, place)}
        for key, entry in newest.items():
            if key not in latest:
                latest[key] = _recorded_grant(entry, _ended_of(hook, entry["file"]))
    for file, entry in lines:
        key = (file, entry["rule"])
        if entry.get("op") != "grant" or (key in latest and latest[key]["issued"] is not None):
            continue
        ended = _ended_of(hook, file)
        over = _ended_why(ended, dict(entry, file=file), line=True) is not None or _line_ended(ended, dict(entry, file=file))
        if key not in latest or not over:
            latest[key] = dict(entry, file=file, ref=entry.get("ref") if isinstance(entry.get("ref"), str) else None,
                               ended=None, turn=1, over=over, issued=None, runs=None)
    return list(latest.values())


def _read_allow(file):
    try:
        with open(file, encoding="utf-8") as f:
            settings = json.load(f)
    except FileNotFoundError:
        return frozenset()
    except (OSError, ValueError):
        return None
    permissions = settings.get("permissions") if isinstance(settings, dict) else None
    allow = permissions.get("allow") if isinstance(permissions, dict) else None
    return frozenset(r for r in allow if isinstance(r, str)) if isinstance(allow, list) else frozenset()


def _allow_of(hook, file):
    """A settings file's allow rules, read once per hook: none when the file is not there; None when it cannot be
    read or does not parse, and then every grant written to it is taken to stand."""
    if file not in hook._allows:
        hook._allows[file] = _read_allow(file)
    return hook._allows[file]


def _record_file(file):
    """The record of take-backs for a grant file: the root's .claude/hooks/tstack-grants-ended.json."""
    return os.path.join(os.path.dirname(file), "hooks", ENDED_RECORD)


def _ended_key(grant):
    """What names one grant on the record of take-backs: its grant file (a grant file is its own realpath:
    _grant_file), decision, rule, the `at` of its grant and its `rev`, the permission's revision (None when it names
    none). The file, as a take-back written beside one file named no file and ended another's grant (review 3). `at`
    is to the second, and one decision answered twice in one second under two revisions is two grants: without the
    rev, superseding the first ended the second at birth (review 2), and its rule stayed for good."""
    granted, rev = grant.get("at"), grant.get("rev")
    return (grant["file"], grant["decision"], grant["rule"], granted if isinstance(granted, str) else "",
            rev if isinstance(rev, str) and rev else None)


def _ended_entry(grant, at, why, line=False):
    """The take-back of `grant` as the record of take-backs holds it, stamped `at`; `line` for a line on no record of
    issued grants (_line_ended), whose take-back ends no issued grant."""
    file, decision, rule, granted, rev = _ended_key(grant)
    return {"file": file, "decision": decision, "rule": rule, "granted": granted, **({"rev": rev} if rev else {}),
            **({"line": True} if line else {}), "at": at, "why": why}


def _ended_in(record):
    """Each take-back in a record's `ended` by its _ended_key, to its `why` (`used`, `revoked`, `expired`, or
    `superseded`: the hub granted the rule anew; "" for an entry that names none). The file and rev are None for an
    entry that names none: master's hook and hub write neither (_ended_why). An entry marked `line` is keyed apart,
    behind "line" (_line_ended), and no lookup of an issued grant's take-back reads it."""
    ended = record.get("ended") if isinstance(record, dict) else None
    if not isinstance(ended, list):
        return {}
    return {(("line",) if e.get("line") is True else ()) +
            (e["file"] if isinstance(e.get("file"), str) and e["file"] else None, e["decision"], e["rule"], e["granted"],
             e["rev"] if isinstance(e.get("rev"), str) and e["rev"] else None):
            e["why"] if isinstance(e.get("why"), str) else "" for e in ended
            if isinstance(e, dict) and all(isinstance(e.get(k), str) for k in ("decision", "rule", "granted"))}


def _ended_why(ended, grant, line=False):
    """The why of `grant`'s take-back in `ended` (_ended_in), None when it has none: an entry naming its file and its
    rev. For a grant on no record of issued grants (`line`) alone, an entry with no file or no rev matches on the rest:
    master's take-backs carry neither, and a session runs master's hook until it restarts, so a grant of master's era
    its hook took back would be taken back again. Never for a recorded grant: master's writers check no symlink, so a
    forged line in a session on master's hook put such an entry on a real root's record, and it ended the real grant
    for good (review 4, finding 1). A recorded grant master's hook took back, whose rule the owner put back by hand,
    goes once more during the skew: fewer calls."""
    file, decision, rule, granted, rev = _ended_key(grant)
    for f in ((file, None) if line else (file,)):
        for r in ((rev, None) if rev and line else (rev,)):
            why = ended.get((f, decision, rule, granted, r))
            if why is not None:
                return why
    return None


def _line_ended(ended, line):
    """Whether `ended` (_ended_in) holds the take-back of a line on no record of issued grants: an entry marked `line`
    with its file, decision, rule, `at` and rev, all of them. Such an entry ends no issued grant, under any key: a
    line's fields are any agent's to copy from a real grant's (review 3, finding 1). Without it nothing marked a line
    over, and a rule the owner added that is identical to one went at every sweep (round 4; the 2026-10-15 incident)."""
    return ("line",) + _ended_key(line) in ended


def _read_ended(file):
    """The take-backs on record beside `file` (_ended_in); none when the record is not there, cannot be read or does
    not parse (the sweep then errs toward fewer allowed calls, as everywhere)."""
    try:
        with open(_record_file(file), encoding="utf-8") as f:
            return _ended_in(json.load(f))
    except (OSError, ValueError):
        return {}


def _ended_of(hook, file):
    """The take-backs on record for a grant file's root, read once per hook."""
    root = os.path.dirname(file)
    if root not in hook._ended:
        hook._ended[root] = _read_ended(file)
    return hook._ended[root]


def _issued_file(file):
    """The record of issued grants for a grant file: the root's .claude/hooks/tstack-grants-issued.json."""
    return os.path.join(os.path.dirname(file), "hooks", ISSUED_RECORD)


def _read_issued(file):
    """The grants the hub put on record beside `file`, oldest first, each naming a grant file of the record's own root:
    its realpath in that root's .claude/ (an entry naming another root's file is no grant; the hub writes none). None
    when the record is not there, cannot be read or does not parse (a grant on it then stands on no record: fewer
    allowed calls). A full record (4096 entries with two `runs` each, 3.0 MB) costs about 30 ms to read (measured
    2026-10-16), once in each hook of a Bash, Monitor or Agent call: no other tool reads it."""
    try:
        with open(_issued_file(file), encoding="utf-8") as f:
            record = json.load(f)
    except (OSError, ValueError):
        return []
    issued = record.get("issued") if isinstance(record, dict) else None
    own, seen = os.path.dirname(file), {}

    def of_own_root(name):
        return _grant_file(name, seen) is not None and os.path.dirname(name) == own

    return [e for e in (issued if isinstance(issued, list) else [])
            if isinstance(e, dict) and all(isinstance(e.get(k), str) for k in ("file", "decision", "rule", "at"))
            and of_own_root(e["file"])]


def _issued_of(hook, file):
    """The grants on record for a grant file's root, read once per hook."""
    root = os.path.dirname(file)
    if root not in hook._issued:
        hook._issued[root] = _read_issued(file)
    return hook._issued[root]


def _issued_at(grant):
    """When the hub issued the grant, from its entry on the record of issued grants; None when it is on none."""
    issued = grant.get("issued")
    return _instant(issued.get("at")) if isinstance(issued, dict) else None


def _stands(hook, grant):
    """Whether the grant's rule is still in its file."""
    allow = _allow_of(hook, grant["file"])
    return allow is None or grant["rule"] in allow


def _live(hook, grant):
    """Whether the grant stands: its rule in its file, and no take-back of it on record. A rule in the file past a
    take-back on record is the owner's, whoever wrote it there, and no grant."""
    return not grant["over"] and _stands(hook, grant)


def _bash_call(rule):
    """The command a `Bash(<call>)` rule names, or None for another tool's rule."""
    return rule[5:-1] if rule.startswith("Bash(") and rule.endswith(")") else None


HEREDOC_RE = re.compile(r"""<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.+-]+))""")
SHELL_LEADERS = ("{", "!", "if", "then", "else", "elif", "do", "while", "until")


def _after_heredoc(text, i, word, tabs):
    while True:
        j = text.find("\n", i)
        line = text[i:] if j < 0 else text[i:j]
        if (line.lstrip("\t") if tabs else line) == word:
            return len(text) if j < 0 else j + 1
        if j < 0:
            raise ValueError("a here-document with no end")
        i = j + 1


def _simple_commands(text):
    """The simple commands a bash command runs, each as its text: split on `;`, `&&`, `||`, `&`, `|` and newlines
    outside quotes, with what a subshell, `$( )`, backticks or `<( )` holds split the same way (it runs too) and
    listed before the command it sits in. A here-document's body and a comment are no commands. ValueError when the
    text does not parse (an open quote, a group or here-document that never ends)."""
    out = []
    n = len(text)

    def quoted(i):
        i += 1
        while i < n:
            c = text[i]
            if c == "\\":
                i += 2
            elif c == '"':
                return i + 1
            elif c == "`":
                i = scan(i + 1, "`")
            elif text.startswith("$(", i):
                i = scan(i + 2, ")")
            else:
                i += 1
        raise ValueError("an open double quote")

    def scan(i, close):
        start = i
        heredocs = []
        escaped = -1  # the index after the last backslash escape: a `#` there is in a word, not a comment

        def cut(j):
            piece = text[start:j].strip()
            if piece:
                out.append(piece)

        while i < n:
            c = text[i]
            if c == close:
                cut(i)
                return i + 1
            if c == "\\":
                i += 2
                escaped = i
            elif c == "'":
                j = text.find("'", i + 1)
                if j < 0:
                    raise ValueError("an open single quote")
                i = j + 1
            elif c == '"':
                i = quoted(i)
            elif c == "`":
                i = scan(i + 1, "`")
            elif c == "(":
                i = scan(i + 1, ")")
            elif c == "#" and i != escaped and (i == 0 or text[i - 1] in " \t\n;&|("):
                cut(i)
                j = text.find("\n", i)
                i = start = n if j < 0 else j
            elif text.startswith("<<<", i):
                i += 3
            elif text.startswith("<<", i) and HEREDOC_RE.match(text, i):
                m = HEREDOC_RE.match(text, i)
                heredocs.append((next(g for g in m.groups()[1:] if g is not None), m.group(1) == "-"))
                i = m.end()
            elif c == "\n":
                cut(i)
                i += 1
                for word, tabs in heredocs:
                    i = _after_heredoc(text, i, word, tabs)
                heredocs = []
                start = i
            elif c == ";":
                cut(i)
                while i < n and text[i] == ";":
                    i += 1
                start = i
            elif c == "|":
                cut(i)
                i += 2 if text[i + 1:i + 2] in ("|", "&") else 1
                start = i
            elif c == "&" and not (text[i - 1:i] in ("<", ">") and i > 0) and text[i + 1:i + 2] != ">":
                cut(i)
                i += 2 if text[i + 1:i + 2] == "&" else 1
                start = i
            else:
                i += 1
        if close is not None:
            raise ValueError(f"no closing {close}")
        cut(n)
        return n

    scan(0, None)
    return out


# What Claude Code 2.1.296 does to a command before it compares it with an exact Bash rule, read from its source and
# measured headless on 51 variants of one stand-in command (2026-10-12): it trims the ends, removes redirections, and
# then, until nothing changes, strips a leading assignment of one of these names (no other), strips these wrappers,
# and removes the quotes and backslashes of the first word alone. Two spaces for one, a quoted argument, `env A`,
# `exec A`, `sudo A`, `FOO=1 A` and `./A` were not cleared by the rule for A.
SAFE_ENV_NAMES = frozenset(
    "GOEXPERIMENT GOOS GOARCH CGO_ENABLED GO111MODULE RUST_BACKTRACE RUST_LOG NODE_ENV PYTHONUNBUFFERED "
    "PYTHONDONTWRITEBYTECODE PYTEST_DISABLE_PLUGIN_AUTOLOAD PYTEST_DEBUG ANTHROPIC_API_KEY LANG LANGUAGE LC_ALL LC_CTYPE "
    "LC_TIME CHARSET TERM COLORTERM NO_COLOR FORCE_COLOR TZ LS_COLORS LSCOLORS GREP_COLOR GREP_COLORS GCC_COLORS TIME_STYLE "
    "BLOCK_SIZE BLOCKSIZE COLUMNS LINES CLICOLOR CLICOLOR_FORCE CI DEBIAN_FRONTEND GIT_TERMINAL_PROMPT".split())
SAFE_ENV_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=[A-Za-z0-9_./:-]+[ \t]+")
WRAPPER_RES = tuple(re.compile(pattern) for pattern in (
    r"timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=\S+|-v|-[ks][ \t]+\S+)[ \t]+)*"
    r"(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+",
    r"time[ \t]+(?:--[ \t]+)?",
    r"nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?",
    r"stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?",
    r"nohup[ \t]+(?:--[ \t]+)?",
    r"command[ \t]+(?:-p[ \t]+)?(?:--[ \t]+)?",
    r"builtin[ \t]+(?:--[ \t]+)?",
    r"noglob[ \t]+",
))


def _without_redirections(piece):
    """A simple command without its redirections (`2>&1`, `> file`, `>>file`, `&> file`, `< file`): each with the
    file descriptor before it and the word after it."""
    out = []
    i, n = 0, len(piece)
    while i < n:
        c = piece[i]
        if c == "\\":
            out.append(piece[i:i + 2])
            i += 2
        elif c == "'":
            j = piece.find("'", i + 1)
            j = n - 1 if j < 0 else j
            out.append(piece[i:j + 1])
            i = j + 1
        elif c == '"':
            j = i + 1
            while j < n and piece[j] != '"':
                j += 2 if piece[j] == "\\" else 1
            out.append(piece[i:j + 1])
            i = j + 1
        elif c in "<>" and piece[i + 1:i + 2] != "(":
            k = len(out)
            while k > 0 and len(out[k - 1]) == 1 and out[k - 1].isdigit():
                k -= 1
            if k == 0 or out[k - 1] in (" ", "\t"):
                del out[k:]
            elif out[-1] == "&":
                out.pop()
            while i < n and piece[i] in "<>&|-":
                i += 1
            while i < n and piece[i] in " \t":
                i += 1
            while i < n and piece[i] not in " \t":
                if piece[i] == "\\":
                    i += 2
                elif piece[i] in "'\"":
                    j = piece.find(piece[i], i + 1)
                    i = n if j < 0 else j + 1
                else:
                    i += 1
            if out and out[-1] in (" ", "\t"):
                while i < n and piece[i] in " \t":
                    i += 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _first_word_bare(text):
    """`text` with the quotes and backslashes of its first word removed; unchanged when a quote there is open."""
    token = text.split(None, 1)[0] if text.strip() else ""
    out = []
    i, n = 0, len(token)
    while i < n:
        c = token[i]
        if c == "'":
            j = token.find("'", i + 1)
            if j < 0:
                return text
            out.append(token[i + 1:j])
            i = j + 1
        elif c == '"':
            j = i + 1
            while j < n and token[j] != '"':
                if token[j] == "\\" and token[j + 1:j + 2] in ("$", "`", '"', "\\"):
                    j += 1
                out.append(token[j])
                j += 1
            if j >= n:
                return text
            i = j + 1
        elif c == "\\":
            if i + 1 >= n:
                return text
            out.append(token[i + 1])
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out) + text[len(token):] if text.startswith(token) else text


def _normal(piece):
    """A simple command as Claude Code compares it with an exact rule (the comment above), and, beyond that, without
    the shell words that only lead to it (`{`, `!`, `if`, `then`, `do`...): what follows them runs all the same."""
    text = _without_redirections(piece).strip()
    while True:
        words = text.split(None, 1)
        if len(words) == 2 and words[0] in SHELL_LEADERS:
            text = words[1]
            continue
        env = SAFE_ENV_RE.match(text)
        if env and env.group(1) in SAFE_ENV_NAMES:
            text = text[env.end():]
            continue
        wrapped = next((m for m in (w.match(text) for w in WRAPPER_RES) if m and m.end() < len(text)), None)
        if wrapped:
            text = text[wrapped.end():]
            continue
        bare = _first_word_bare(text)
        if bare == text:
            return text
        text = bare


def _pieces(text, _memo={}):
    """A command's simple commands, each as a rule is matched against it; None when the text does not parse."""
    if text not in _memo:
        try:
            _memo[text] = [p for p in (_normal(piece) for piece in _simple_commands(text)) if p and p != "}"]
        except (ValueError, IndexError):
            _memo[text] = None
    return _memo[text]


def _is_call(command, call):
    """Whether `command` is the granted `call` and nothing more: the same text, or the same simple commands in the
    same order (what Claude Code's rule matcher takes for the same command)."""
    if command == call:
        return True
    mine, granted = _pieces(command), _pieces(call)
    return bool(granted) and mine == granted


def _holds_call(command, call):
    """Whether `command` runs the granted `call` in command position: the call's simple commands, in order, among
    its own. `grep "just deploy" README` and `just deploy-check` do not hold `just deploy`. A command that does not
    parse holds a call its text holds."""
    mine, granted = _pieces(command), _pieces(call)
    if mine is None or not granted:
        return bool(call) and call in command
    return any(mine[k:k + len(granted)] == granted for k in range(len(mine) - len(granted) + 1))


def _spent(standing, used):
    """The standing grants the call that ran uses up: the grant of that call, whoever in the fleet's sessions ran it
    (the rule let any of them through); else each grant whose call the command holds inside more, which never runs
    past fleet_grant_alone, and ends the grant all the same if it did."""
    if used is None:
        return []
    tool, text = used
    if tool != "Bash":
        return [g for g in standing if g["rule"] == text]
    bash = [g for g in standing if _bash_call(g["rule"]) is not None]
    exact = [g for g in bash if _is_call(text, _bash_call(g["rule"]))]
    return exact or [g for g in bash if _holds_call(text, _bash_call(g["rule"]))]


def _list_of(grant):
    """What says two grants came from one answer to one permission: the calls of a list (its decision, `at` and rev)."""
    _, decision, _, at, rev = _ended_key(grant)
    return decision, at, rev


def _due_grants(hook, raw, used, now, failed=False, void=None):
    """(grant, why) for each standing grant to end now: `used` (its call ran), `revoked` (a call of its list failed,
    or the list is `void`: a list is a sequence, and what comes after a failure was allowed for another state of
    things), `expired` (30 minutes after the `at` on the hub's record of issued grants, or on no such record)."""
    standing = [g for g in _latest_grants(hook, raw) if _live(hook, g)]
    spent = _spent(standing, used)
    lost = {_list_of(g) for g in spent if failed} | ({void} if void else set())
    due = []
    for grant in standing:
        at = _issued_at(grant)
        if any(grant is g for g in spent):
            due.append((grant, "used"))
        elif _list_of(grant) in lost:
            due.append((grant, "revoked"))
        elif at is None or now - at >= GRANT_TTL_S:
            due.append((grant, "expired"))
    return due


def _lock_settings(file):
    lock = os.path.join(os.path.dirname(file), SETTINGS_LOCK_SHARED_WITH_HUB)
    deadline = time.monotonic() + SETTINGS_LOCK_WAIT_S
    while True:
        try:
            os.mkdir(lock)
            return lock
        except FileExistsError:
            pass
        try:
            if time.time() - os.stat(lock).st_mtime > SETTINGS_LOCK_STALE_S:
                os.rmdir(lock)
                continue
        except FileNotFoundError:
            continue
        if time.monotonic() >= deadline:
            raise TimeoutError(f"{lock} is held")
        time.sleep(0.02)


def _take_back(file, rule, ended):
    """_take_back_locked under the settings lock: what it could not record, None when nothing."""
    try:
        lock = _lock_settings(file)
    except FileNotFoundError:
        return None
    try:
        return _take_back_locked(file, rule, ended)
    finally:
        os.rmdir(lock)


def _loaded(file):
    """A JSON file's object; None when the file is not there. ValueError, naming the file, when it does not parse."""
    try:
        with open(file, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        return None
    try:
        return json.loads(text)
    except ValueError as e:
        raise ValueError(f"{file} does not parse: {e}") from None


def _write_json(file, value):
    tmp = os.path.join(os.path.dirname(file), f".{os.path.basename(file)}.{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, file)


def _with_ended(record, ended):
    kept = record.get("ended") if isinstance(record.get("ended"), list) else []
    record["ended"] = (kept + [ended])[-ENDED_KEPT:]


def _take_back_locked(file, rule, ended):
    """Take `rule` out of `file`, then put the grant on the root's record of take-backs (`ended`: its decision, rule,
    granted and the stamp). A grant already on the record, read again under the lock, is over: the rule there is the
    owner's, and stays. The settings first: a record that cannot be written leaves fewer allowed calls, never more;
    one that does not parse is left as it is (the hub's expireGrants), and what was not recorded is returned. A file
    that is no grant file now (_grant_file: a symlink made since the sweep read it) is left, and nothing written."""
    if _grant_file(file) != file:
        return None
    settings = _loaded(file)
    permissions = settings.get("permissions") if isinstance(settings, dict) else None
    allow = permissions.get("allow") if isinstance(permissions, dict) else None
    if not isinstance(allow, list) or rule not in allow:
        return None
    record_file = _record_file(file)
    try:
        record = _loaded(record_file)
    except ValueError as e:
        record, unrecorded = None, f"{e}: the take-back of {ended['decision']} is not on record"
    else:
        record, unrecorded = record if isinstance(record, dict) else {}, None
        named, taken = {**ended, "at": ended["granted"]}, _ended_in(record)
        line = ended.get("line") is True
        if _ended_why(taken, named, line=line) is not None or (line and _line_ended(taken, named)):
            return None
    permissions["allow"] = [r for r in allow if r != rule]
    _write_json(file, settings)
    if record is not None:
        _with_ended(record, ended)
        os.makedirs(os.path.dirname(record_file), exist_ok=True)
        _write_json(record_file, record)
    return unrecorded


def _shell_command(hook):
    """The command of a Bash or Monitor call: Monitor runs its command under Bash's permission rules."""
    tool_input = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    command = tool_input.get("command") if hook.input.get("tool_name") in ("Bash", "Monitor") else None
    return command if isinstance(command, str) else None


GRANT_TOOLS = ("Bash", "Monitor", "Agent")


def fleet_grant_sweep(hook):
    """PostToolUse and PostToolUseFailure of a Bash, Monitor or Agent call: end each standing grant that is due
    (_due_grants). A rule of these tools' is all a grant writes, and no other tool's call is let through by one, so
    another tool's call reads no record (a full one costs ~30 ms to read: measured, 2026-10-16); an expired grant
    then waits for the next call of these tools in its root, which refuses it before it runs (fleet_grant_alone,
    fleet_agent_grant), or for the hub's timer."""
    if hook.input.get("tool_name") not in GRANT_TOOLS:
        return None
    dirs = grant_state_dirs(hook)
    if not dirs:
        return None
    tool_input = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    command = _shell_command(hook)
    used = ("Bash", command) if command is not None else None
    if hook.input.get("tool_name") == "Agent" and tool_input:
        used = ("Agent", f"Agent({_agent_call(tool_input)})")
    now = fleet_now(hook.env)
    failed = hook.event == "PostToolUseFailure"
    for d in dirs:
        raw, unread = _read_grants(d)
        if raw is None:
            log(hook.data_dir, f"{hook.event} fleet_grant_sweep: {unread}; its grants are left to the hub's timer")
        elif _due_grants(hook, raw, used, now, failed):
            _close_due_grants_exclusively(hook, d, used, now, failed)
    return None


def _close_due_grants_exclusively(hook, d, used, now, failed=False, void=None):
    import fcntl
    with open(os.path.join(d, "grants.jsonl"), "a+b") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        raw = f.read(GRANT_STATE_MAX_BYTES + 1)
        if len(raw) > GRANT_STATE_MAX_BYTES:
            return
        hook._allows.clear()
        hook._ended.clear()
        hook._issued.clear()
        hook._grant_files.clear()
        lead = b"\n" if raw and not raw.endswith(b"\n") else b""
        for grant, why in _due_grants(hook, raw, used, now, failed, void):
            at = fleet_stamp(hook.env)
            try:
                # A grant on no record of issued grants was never issued: its take-back is marked `line`, and ends no
                # issued grant (review 3: one with a line's decision, `at` and rev ended the real grant they were
                # copied from), so a rule the owner adds again is not taken at the next sweep.
                ended = _ended_entry(grant, at, why, line=grant["issued"] is None)
                unrecorded = _take_back(grant["file"], grant["rule"], ended)
            except Exception:  # this grant stays open for the next call; the others go on
                log(hook.data_dir, f"{hook.event} fleet_grant_sweep failed for {grant['decision']}\n"
                                   f"{traceback.format_exc()}")
                continue
            if unrecorded:
                log(hook.data_dir, f"{hook.event} fleet_grant_sweep: {unrecorded}")
            removal = {"op": "remove", "decision": grant["decision"], "rule": grant["rule"], "file": grant["file"],
                       "at": at, "why": why}
            f.write(lead + json.dumps(removal, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
            f.flush()
            lead = b""
            try:
                os.unlink(_taken_path(d, grant))
            except OSError:
                pass
        hook._allows.clear()
        hook._ended.clear()
        hook._issued.clear()
        hook._grant_files.clear()


def fleet_agent_grant(hook):
    """PreToolUse (Agent): auto mode drops Agent allow rules from the settings, and a PreToolUse allow is
    what clears a classifier refusal of a spawn (measured). A spawn whose exact rule the hub granted in the
    session root's .claude/tstack-grants.json is allowed; the sweep takes the rule back once it ran or
    expired. Needs no fleet: the file holds only what the hub granted."""
    if hook.input.get("tool_name") != "Agent" or not isinstance(hook.input.get("tool_input"), dict):
        return None
    tool_input = hook.input["tool_input"]
    if not tool_input:
        return None
    project = hook.env.get("CLAUDE_PROJECT_DIR")
    root = project if project and os.path.isabs(project) else hook.cwd
    if not isinstance(root, str) or not os.path.isabs(root):
        return None
    try:
        with open(os.path.join(root, ".claude", AGENT_GRANTS), encoding="utf-8") as f:
            granted = json.load(f)
    except (OSError, ValueError):
        return None
    permissions = granted.get("permissions") if isinstance(granted, dict) else None
    allow = permissions.get("allow") if isinstance(permissions, dict) else None
    rule = f"Agent({_agent_call(tool_input)})"
    if not isinstance(allow, list) or rule not in allow:
        return None
    # The rule alone is no grant: it is one while the hub's entry of it on the root's record stands, within its 30
    # minutes and its list's turn, whatever grants.jsonl holds.
    file = os.path.realpath(os.path.join(root, ".claude", AGENT_GRANTS))
    grants = [g for g in _latest_grants(hook, b"") if g["rule"] == rule and os.path.realpath(g["file"]) == file]
    at = _issued_at(grants[0]) if grants else None
    if (at is None or fleet_now(hook.env) - at >= GRANT_TTL_S or not _live(hook, grants[0])
            or _out_of_turn(hook, grants[0], grants)):
        return None
    return Allow("tstack: the user allowed this exact Agent call once, on the fleet page (a permission grant).")


def _taken_path(d, grant):
    import hashlib
    key = "\0".join(str(grant.get(k)) for k in ("decision", "rule", "file", "at"))
    return os.path.join(d, GRANTS_TAKEN, hashlib.sha256(key.encode()).hexdigest()[:32])


def _take(hook, d, grant):
    """Mark the grant taken by this call, before it runs: the file is created exclusively, so of two calls that
    reach PreToolUse before either has finished, one takes it. None when this call has it; else why not."""
    path = _taken_path(d, grant)
    mine = hook.input.get("tool_use_id") if isinstance(hook.input.get("tool_use_id"), str) else ""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        try:
            with open(path, encoding="utf-8") as f:
                if mine and f.read().strip() == mine:
                    return None
        except OSError:
            pass
        return "another call already took this grant: one yes is one run"
    except OSError as e:
        return f"the grant could not be marked as taken in {os.path.dirname(path)} ({e.strerror}), so it cannot be told from a second run"
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(mine + "\n")
    return None


def _moved_file(grant):
    """Why a file the grant binds is no longer the one the user allowed (the hub put each one's sha256 on the record of
    issued grants when it granted: _latest_grants takes `runs` from there); None when every one is, or it binds none."""
    import hashlib
    runs = grant.get("runs")
    for run in runs if isinstance(runs, list) else []:
        path, sha = (run.get("path"), run.get("sha256")) if isinstance(run, dict) else (None, None)
        if not isinstance(path, str) or not isinstance(sha, str):
            return "its record of the file it runs does not read"
        digest = hashlib.sha256()
        try:
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    digest.update(chunk)
        except OSError as e:
            return f"the file it runs, {path}, cannot be read ({e.strerror})"
        if digest.hexdigest() != sha:
            return f"the file it runs, {path}, changed after the user allowed it"
    return None


ASK_AGAIN = ("Ask the user again with a new permission for it (coordinator skill, \"Ask for the permission before the "
             "call\"), and run nothing of it until that one is allowed.")


def _alone_by_settings(hook, command, unread):
    """With no readable record of grants, every exact Bash rule of the session's settings.local.json is taken for a
    one-time grant: a longer command that holds one is refused."""
    project = hook.env.get("CLAUDE_PROJECT_DIR")
    root = project if project and os.path.isabs(project) else hook.cwd
    file = os.path.join(root, ".claude", "settings.local.json")
    for rule in sorted(_allow_of(hook, file) or ()):
        call = _bash_call(rule)
        if call and "*" not in call and not _is_call(command, call) and _holds_call(command, call):
            return Deny(f"tstack: this fleet's record of one-time grants cannot be read ({unread}), so every exact Bash rule "
                        f"in {file} is taken for a one-time grant, and this command holds one inside more: `{call}`. Run that "
                        "call by itself, as a Bash call of its own, and put the record back as it was.")
    return None


def _alone_by_grants(hook, d, raw, command, now):
    grants = [g for g in _latest_grants(hook, raw) if _bash_call(g["rule"]) is not None]
    standing = [g for g in grants if _live(hook, g)]
    mine = [g for g in standing if _is_call(command, _bash_call(g["rule"]))]
    if not mine:
        for grant in standing:
            call = _bash_call(grant["rule"])
            if _holds_call(command, call):
                return Deny(f"tstack: this command holds a call the user allowed once ({grant.get('ref') or grant['decision']}): "
                            f"`{call}`. A one-time grant is for that call alone, byte for byte, as a Bash call of its own: "
                            "run it by itself, and anything else in a call of its own. Inside a longer command it would "
                            "run on the grant without using it up.")
        for grant in grants:
            if grant["ended"] == "revoked" and not _stands(hook, grant) and _is_call(command, _bash_call(grant["rule"])):
                return Deny(f"tstack: this call was allowed once as part of a list ({grant.get('ref') or grant['decision']}), and a "
                            f"call of that list failed or ended without running, or a file it runs changed, so what was left "
                            f"of it is no longer allowed. {ASK_AGAIN}")
        return None
    # Each grant of the call is held to its bounds, not the first: a line can name a file and record of any folder.
    for grant in mine:
        denial = _alone_denial(hook, d, grant, grants, now)
        if denial:
            return denial
    if hook.denied:
        return None
    for grant in mine:
        taken = _take(hook, d, grant)
        if taken:
            return Deny(f"tstack: the user allowed this call once ({grant.get('ref') or grant['decision']}), and {taken}. {ASK_AGAIN}")
    return None


def _earlier_calls(hook, grant):
    """The entries on record of the calls before `grant`'s in its list: of its root, its decision and `at`, a lower
    `n` (its own rule's entries aside); in their order."""
    entry = grant["issued"]
    if entry is None:
        return []
    return sorted((e for e in _issued_of(hook, grant["file"]) if _list_of(e) == _list_of(entry)
                   and (e["file"], e["rule"]) != (grant["file"], grant["rule"]) and isinstance(e.get("n"), int)
                   and e["n"] < grant["turn"]), key=lambda e: e["n"])


def _out_of_turn(hook, grant, grants):
    """(earlier entry, why) when `grant` may not run yet: `waits` while an earlier call of its list still stands, and
    `void` when one ended other than by running (revoked, expired, superseded) or stopped standing with no ending on
    record (its rule taken out of its file): a list is a sequence, and what follows a call that never ran was allowed
    for another state of things. Read from the records, so no line, forged or deleted, moves a call's turn."""
    newest = {(g["file"], g["rule"]): g for g in grants}
    for entry in _earlier_calls(hook, grant):
        why = _ended_why(_ended_of(hook, entry["file"]), entry)
        if why == "used":
            continue
        g = newest.get((entry["file"], entry["rule"]))
        if why is None and g is not None and g["issued"] is not None and _ended_key(g["issued"]) == _ended_key(entry) and _stands(hook, g):
            return entry, "waits"
        return entry, "void"
    return None


def _alone_denial(hook, d, grant, grants, now):
    """Why the granted call may not run on `grant` now: it is on no record of the hub's grants, or 30 minutes old (the
    grant is then taken back), out of its list's turn (the list void when an earlier call of it never ran), or a
    file it binds moved (the grant and its list revoked)."""
    ref = grant.get("ref") or grant["decision"]
    at = _issued_at(grant)
    if at is None or now - at >= GRANT_TTL_S:
        try:
            _close_due_grants_exclusively(hook, d, None, now)
        except Exception:  # the hub's timer or the next sweep takes the rule back; the call is refused all the same
            log(hook.data_dir, f"{hook.event} fleet_grant_alone could not close {ref}\n{traceback.format_exc()}")
        if grant["issued"] is None:
            return Deny(f"tstack: this call's grant is on no record of the hub's grants ({_issued_file(grant['file'])}): "
                        f"a line in grants.jsonl alone grants nothing, so its rule is taken back. {ASK_AGAIN}")
        return Deny(f"tstack: the user allowed this call once ({ref}), and a one-time grant lasts {GRANT_TTL_S // 60} minutes: "
                    f"this one is over. {ASK_AGAIN}")
    turn = _out_of_turn(hook, grant, grants)
    if turn and turn[1] == "waits":
        return Deny(f"tstack: this is call {grant['turn']} of the list the user allowed ({ref}), and call "
                    f"{turn[0]['n']} has not run: `{_bash_call(turn[0]['rule']) or turn[0]['rule']}`. The list is a "
                    "sequence: run that one first, as a Bash call of its own.")
    if turn:
        try:
            _close_due_grants_exclusively(hook, d, None, now, void=_list_of(grant))
        except Exception:
            log(hook.data_dir, f"{hook.event} fleet_grant_alone could not revoke {ref}\n{traceback.format_exc()}")
        return Deny(f"tstack: this is call {grant['turn']} of the list the user allowed ({ref}), and call {turn[0]['n']} "
                    f"(`{_bash_call(turn[0]['rule']) or turn[0]['rule']}`) ended without running, so what was left of "
                    f"the list is no longer allowed. {ASK_AGAIN}")
    moved = _moved_file(grant)
    if moved:
        try:
            _close_due_grants_exclusively(hook, d, None, now, void=_list_of(grant))
        except Exception:
            log(hook.data_dir, f"{hook.event} fleet_grant_alone could not revoke {ref}\n{traceback.format_exc()}")
        return Deny(f"tstack: the user allowed this call once ({ref}), and {moved}: the grant was for the file as it was, "
                    f"so it is gone (with what was left of its list). {ASK_AGAIN}")
    return None


def fleet_grant_alone(hook):
    """PreToolUse (Bash, Monitor), last of its handlers: a one-time grant is for its call alone, once. Claude Code
    lets a compound command through when each of its parts has an allow rule (measured on 2.1.296: with one rule for
    A, `A; A` ran A twice, and two rules let `A; B` and `A | B` through), so a command that runs a granted call inside
    more would run on the grant, more than once or beside what the user never read as one call: refused while the
    rule stands. The call itself is refused when its grant is on no record of the hub's grants or over 30 minutes old
    by that record, when an earlier call of its list has not run, when a file it binds changed, and when another call
    took the grant first; else it is marked taken and left to the permission check, where its rule lets it through. A record of grants that cannot be read fails
    closed (_alone_by_settings). This handler never allows."""
    command = _shell_command(hook)
    if command is None:
        return None
    now = fleet_now(hook.env)
    dirs = grant_state_dirs(hook)
    if not dirs:
        return _alone_without_fleet(hook, command)
    for d in dirs:
        raw, unread = _read_grants(d)
        denial = _alone_by_settings(hook, command, unread) if raw is None else _alone_by_grants(hook, d, raw, command, now)
        if denial:
            return denial
    return None


def _alone_without_fleet(hook, command):
    """A session that works for no fleet has no record to mark a grant taken in: a command that runs a call of a
    standing grant on its root's record is refused, so the grant is held to its bounds wherever the call comes from
    (a fleet's record of grants deleted, or another session in the same root). A grant past its 30 minutes by the
    record is taken back at any Bash or Monitor call, its take-back on the root's record (`expired`): with no fleet
    there is no log to add a line to, and the hub's timer cannot find a root that no line or heartbeat names (review
    2: such a root kept the rule). One within its 30 minutes is only refused: a fleet's session may still run it."""
    now, denial = fleet_now(hook.env), None
    for grant in _latest_grants(hook, b""):
        call = _bash_call(grant["rule"])
        if not call or grant["issued"] is None or not _live(hook, grant):
            continue
        ref, runs = grant["ref"] or grant["decision"], _is_call(command, call) or _holds_call(command, call)
        at = _issued_at(grant)
        if at is None or now - at >= GRANT_TTL_S:
            try:
                unrecorded = _take_back(grant["file"], grant["rule"], _ended_entry(grant, fleet_stamp(hook.env), "expired"))
            except Exception:  # refused all the same; the next call tries again
                log(hook.data_dir, f"{hook.event} fleet_grant_alone could not take back {ref}\n{traceback.format_exc()}")
            else:
                if unrecorded:
                    log(hook.data_dir, f"{hook.event} fleet_grant_alone: {unrecorded}")
            if runs and denial is None:
                denial = Deny(f"tstack: the user allowed this call once ({ref}), and a one-time grant lasts "
                              f"{GRANT_TTL_S // 60} minutes: this one is over. {ASK_AGAIN}")
        elif runs and denial is None:
            denial = Deny(f"tstack: this command runs a call the user allowed once ({ref}): `{call}`, and this session "
                          "works for no fleet whose record could hold it to one run. Run it from the fleet's own session.")
    hook._allows.clear()
    return denial


def fleet_monitor_watch(hook):
    """PreToolUse (Monitor): in a session that works for a fleet, the Monitor tool only watches. Auto mode judges a
    Bash command and does not judge a Monitor one (measured on 2.1.296: a stand-in deploy refused 10 of 10 as a Bash
    call ran 4 of 4 through Monitor with no rule), so an act could go to Monitor first and never be judged. A Monitor
    command is denied unless every command it runs is the fleet CLI watching or one that only reads, waits or prints,
    or a standing one-time grant names it exactly (hooks/tstack-hook-monitor.py, read only for such a call). Outside a
    fleet, and for every other tool, it says nothing. It never allows a call."""
    if hook.input.get("tool_name") != "Monitor" or not grant_state_dirs(hook):
        return None
    return _monitor()["monitor_denial"](hook)


class Deny(str):
    """What a PreToolUse handler returns to refuse the call: the text becomes the denial's reason."""


class Allow(str):
    """What a PreToolUse handler returns to allow the call: only fleet_agent_grant, for an Agent call the hub granted
    once. Any other PreToolUse text decides nothing."""


class Note(str):
    """What a PreToolUse handler returns to tell Claude something beside the call's result (additionalContext): it
    decides nothing, so the permission check runs as it would have."""


# The spawn gate. A coordinator's and a manager's session run at low effort (MODELS.md), and an Agent call without
# `effort` inherits the session's: a worker spawned bare runs at low, whatever its role (measured 2026-10-12: 29 of 31
# spawns in one fleet passed none). So in a session that serves a fleet a spawn names its model and its effort, or the
# definition it spawns does. The pair to pass comes from the ledger's row when the call is that worker's brief, else
# from MODELS.md's table, the one place the pairs are written. $CLAUDE_CODE_EFFORT_LEVEL outranks both the call's
# effort and a definition's (Claude Code's sub-agents doc, "Choose an effort level"): a session that sets it is told.
EFFORTS = ("low", "medium", "high", "xhigh", "max")
MODELS_MD = ROOT / "skills" / "productivity" / "coordinator" / "MODELS.md"
ROLE_PAIR = re.compile(r"\b(Fable|Opus|Sonnet|Haiku) (low|medium|high|xhigh|max)\b")
SESSION_ROLES = ("Coordinator", "Manager")  # a session's own effort is its launch's, never a spawn's
TYPE_ROLES = {"Explore": "Researcher"}
BRIEF_ID = re.compile(r"\byour id is ([A-Za-z0-9][\w.-]*?)\.?(?=[\s,;:\"']|$)")  # the line `fleet brief` opens with
FRONTMATTER_MAX = 256 * 1024
EFFORT_ENV = "CLAUDE_CODE_EFFORT_LEVEL"


def role_pairs():
    """MODELS.md's role table: role -> (model, effort), the row's first pair. {} when it cannot be read."""
    try:
        lines = MODELS_MD.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return {}
    start = next((i for i, line in enumerate(lines) if line.startswith("| Role |")), None)
    if start is None:
        return {}
    pairs = {}
    for line in lines[start + 2:]:
        if not line.startswith("|"):
            break
        cells = [c.strip() for c in line.strip("|").split("|")]
        found = ROLE_PAIR.search(" | ".join(cells[1:]))
        if found and cells[0]:
            pairs[cells[0]] = (found.group(1).lower(), found.group(2))
    return pairs


def _frontmatter(path):
    """A markdown file's top-level frontmatter keys, {} without one. A byte order mark and blank lines before the
    opening `---` are passed over; a value loses its quotes and a trailing comment."""
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as f:
            lines = f.read(FRONTMATTER_MAX).splitlines()
    except OSError:
        return {}
    first = next((i for i, line in enumerate(lines) if line.strip()), None)
    if first is None or lines[first].strip() != "---":
        return {}
    keys = {}
    for line in lines[first + 1:]:
        if line.strip() == "---":
            return keys
        found = re.match(r"^([A-Za-z_-]+):\s*(.*)$", line)
        if found:
            value = found.group(2).strip()
            quoted = re.match(r"^([\"'])(.*?)\1(?:\s+#.*)?$", value)
            keys[found.group(1)] = quoted.group(2) if quoted else re.sub(r"\s+#.*$", "", value)
    return {}


def _plugin_roots(hook, plugin):
    """Where plugin `plugin` is installed: this plugin's own root, else each install path the user's
    installed_plugins.json records for it."""
    try:
        own = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text()).get("name")
    except (OSError, ValueError, AttributeError):
        own = None
    if plugin == (own or "tstack"):
        return [ROOT]
    config = Path(hook.env.get("CLAUDE_CONFIG_DIR") or Path(hook.env.get("HOME", "/tmp")) / ".claude")
    try:
        installed = json.loads((config / "plugins" / "installed_plugins.json").read_text()).get("plugins")
    except (OSError, ValueError, AttributeError):
        return []
    roots = []
    for key, installs in installed.items() if isinstance(installed, dict) else ():
        if key.split("@", 1)[0] != plugin or not isinstance(installs, list):
            continue
        roots += [Path(i["installPath"]) for i in installs if isinstance(i, dict) and isinstance(i.get("installPath"), str)]
    return roots


def agent_definition(hook, kind):
    """The frontmatter of the agent definition a `subagent_type` names, {} when none is found: `<plugin>:<name>` is
    agents/<name>.md of that plugin, a bare name a definition of the project's or the user's .claude/agents."""
    if not isinstance(kind, str) or not kind or len(kind) > 200 or "/" in kind or kind.startswith("."):
        return {}
    if ":" in kind:
        plugin, name = kind.split(":", 1)[0], kind.rsplit(":", 1)[1]
        folders = [root / "agents" for root in _plugin_roots(hook, plugin)]
    else:
        name = kind
        project = hook.env.get("CLAUDE_PROJECT_DIR")
        config = Path(hook.env.get("CLAUDE_CONFIG_DIR") or Path(hook.env.get("HOME", "/tmp")) / ".claude")
        folders = [Path(p) / ".claude" / "agents" for p in (project, hook.cwd) if isinstance(p, str) and os.path.isabs(p)]
        folders.append(config / "agents")
    for folder in folders:
        try:
            files = sorted(folder.rglob("*.md"))
        except OSError:
            continue
        for file in files:
            keys = _frontmatter(file)
            if (keys.get("name") or file.stem) == name:
                return keys
    return {}


def hosted_fleets(hook):
    """The fleets this session serves as their coordinator or manager: the one $FLEET_DIR names, else those of its
    scratchpad the registry records under this session. None for a worker launched as a process of its own, whose
    effort is its launch's; a subagent's call counts, since it runs in the session that serves."""
    if hook.env.get("FLEET_WORKER") or hook.env.get("TSTACK_ROLE") == "worker":
        return []
    dirs = fleet_dirs(hook)
    return dirs if hook.env.get("FLEET_DIR") else [d for d in dirs if served_by_session(hook, d)]


def _named(word, text):
    return bool(re.search(rf"(?<![\w-]){re.escape(word)}(?![\w-])", text))


def _briefed_row(dirs, prompt):
    """(DIR, row) of the worker an Agent call spawns, or None: the ledger row whose id the prompt's first line gives,
    as `fleet brief` opens a brief (`Read DIR/brief.md first; your id is a1.`). A worker named anywhere else is not
    taken for the one spawned: a sweep that says "ask the advisor" is not the advisor."""
    opening = BRIEF_ID.search(next((line for line in prompt.splitlines() if line.strip()), ""))
    if not opening:
        return None
    for d in dirs:
        agents = (read_ledger(d) or {}).get("agents")
        for row in agents if isinstance(agents, list) else ():
            if isinstance(row, dict) and row.get("id") == opening.group(1):
                return d, row
    return None


def _role_of(kind, description, pairs):
    """The MODELS.md role an Agent call plays, and what says so: the only role its description names, else its
    subagent_type's. (None, None) when neither says; a role the prompt mentions in passing is not the spawn's."""
    found = [r for r in pairs if r not in SESSION_ROLES and _named(r, description)]
    if len(found) == 1:
        return found[0], "its description names the role"
    if isinstance(kind, str) and TYPE_ROLES.get(kind) in pairs:
        return TYPE_ROLES[kind], f"subagent_type {kind}"
    return None, None


def _pair_to_pass(dirs, tool_input):
    """The sentence of a denial that names the model and effort to pass, from the best source there is: the ledger's
    row of the briefed worker, else the role the call names, else MODELS.md's table."""
    def text(key):
        value = tool_input.get(key)
        return value if isinstance(value, str) else ""

    briefed = _briefed_row(dirs, text("prompt"))
    if briefed is not None:
        d, row = briefed
        model = row["model"] if isinstance(row.get("model"), str) and row["model"] else "opus"
        if row.get("effort") in EFFORTS:
            return f'Pass model: "{model}", effort: "{row["effort"]}": the pair the fleet\'s ledger records for {row["id"]}.'
        # a row from before efforts were recorded: the fleet CLI (roles.ts) is the one place that works its effort out
        return (f'Pass model: "{model}" and the effort `{fleet_cli()} brief {d} {row["id"]}` prints on its first line: '
                f'the ledger\'s row for {row["id"]} records no effort.')
    pairs = role_pairs()
    role, why = _role_of(tool_input.get("subagent_type"), text("description"), pairs)
    if role:
        return f'Pass model: "{pairs[role][0]}", effort: "{pairs[role][1]}": the {role} pair of MODELS.md ({why}).'
    by_pair = {}
    for name, pair in pairs.items():
        if name not in SESSION_ROLES:
            by_pair.setdefault(pair, []).append(name)
    table = ", ".join(f"{'/'.join(names)} {model} {effort}" for (model, effort), names in by_pair.items())
    return (f"Pass effort: per MODELS.md ({table or MODELS_MD}), and the model beside it; `{fleet_cli()} brief <dir> <id>` "
            f"prints a recorded worker's pair.")


def _spawn_problem(hook, tool_input):
    """(what is wrong with an Agent call's model and effort, or None; the effort it will be spawned at, or None)."""
    given = {k: tool_input[k].strip() if isinstance(tool_input.get(k), str) else "" for k in ("model", "effort")}
    kind = tool_input.get("subagent_type")
    definition = agent_definition(hook, kind) if not (given["model"] and given["effort"]) else {}
    levels = ", ".join(EFFORTS)
    if given["effort"] and tool_input["effort"] not in EFFORTS:
        said = json.dumps(tool_input["effort"][:40], ensure_ascii=False)
        return f"effort: {said} is not a level the Agent tool takes ({levels}).", None
    defined = definition.get("effort") or ""
    if not given["effort"] and defined and defined not in EFFORTS:
        return (f'The definition of {_one_line(str(kind), 60)} names effort: "{_one_line(defined, 40)}", which is not a '
                f"level ({levels}), and this Agent call names none."), None
    missing = [k for k in ("model", "effort") if not given[k] and not definition.get(k)]
    if not missing:
        return None, given["effort"] or defined
    level = hook.input.get("effort").get("level") if isinstance(hook.input.get("effort"), dict) else None
    effort = f"{level} effort" if isinstance(level, str) and level else "effort (low, for a coordinator)"
    if missing == ["effort"]:
        why = f"A spawn without an effort inherits this session's {effort}, whatever the worker's role."
    elif missing == ["model"]:
        why = "A spawn without a model runs on its agent type's default or this session's model, whatever the worker's role."
    else:
        why = f"A spawn without them inherits this session's model and its {effort}, whatever the worker's role."
    return f"This Agent call names no {' and no '.join(missing)}. {why}", None


def fleet_spawn_effort(hook):
    """PreToolUse (Agent): in a session that serves a fleet, a spawn carries both `model` and `effort`, or is denied
    with the pair to pass. A definition whose frontmatter carries them (tstack:advisor, tstack:reader) passes without
    the parameters, and so does a fork, which inherits by design. An effort the tool does not take is denied, the
    call's or the definition's; `max`, which no role uses, is noted, and so is $CLAUDE_CODE_EFFORT_LEVEL in the
    session's environment, which outranks every spawn's effort. Outside a fleet it says nothing. It never allows a
    call."""
    tool_input = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    if hook.input.get("tool_name") != "Agent" or not tool_input or tool_input.get("subagent_type") == "fork":
        return None
    dirs = hosted_fleets(hook)
    if not dirs:
        return None
    forced = hook.env.get(EFFORT_ENV, "").strip()
    overridden = (f"tstack: {EFFORT_ENV}={_one_line(forced, 20)} is set in this session's environment, and it takes "
                  f"precedence over the effort an Agent call passes and over a definition's `effort:`, so this worker "
                  f"runs at it whatever its role. The session's own effort belongs in the `effortLevel` setting "
                  f"(.claude/settings.local.json), never in that variable: tell Luiz to move it and restart the "
                  f"session.") if forced else ""
    problem, effort = _spawn_problem(hook, tool_input)
    if problem:
        return Deny(f"{problem} In a fleet (this session serves one) a spawn passes both `model` and `effort`. "
                    f"{_pair_to_pass(dirs, tool_input)} Issue the call again with them."
                    + (f"\n\n{overridden}" if overridden else ""))
    notes = [overridden] if overridden else []
    if effort == "max":
        notes.append("tstack: this spawn runs at max effort, which no role of MODELS.md uses (never max: the first token "
                     "takes minutes and the result is no better than xhigh). Take the role's pair unless Luiz asked for max.")
    return Note("\n\n".join(notes)) if notes else None


# The push gate. It catches honest mistakes, not an adversary: a plain `jj git push` or `git push` is read
# exactly; one it cannot read (inside a loop, a subshell, a substitution, eval, xargs, a script, or with a
# variable in it) counts as unclear, which a fleet without the landing turn may not run.
Push = namedtuple("Push", "tool args cwd unclear")
SHELLS = {"sh", "bash", "zsh", "dash", "nu", "fish", "ksh"}
NOEXEC_SHELLS = SHELLS - {"nu"}  # their -n reads a script and runs nothing; nu's -n is --no-config-file
OPENERS = {"for", "while", "until", "if", "case", "select", "function", "{"}
CLOSERS = {"done", "fi", "esac", "}"}
JJ_VALUED = {"-R", "--repository", "--at-operation", "--at-op", "--color", "--config", "--config-file", "--config-toml"}
JJ_BUILTINS = {
    "abandon", "absorb", "bisect", "bookmark", "commit", "config", "debug", "describe", "diff", "diffedit", "duplicate",
    "edit", "evolog", "file", "fix", "gerrit", "git", "help", "interdiff", "log", "metaedit", "new", "next", "operation",
    "op", "parallelize", "prev", "rebase", "redo", "resolve", "restore", "revert", "root", "run", "show", "sign",
    "simplify-parents", "sparse", "split", "squash", "status", "tag", "undo", "unsign", "util", "version", "workspace"}
GIT_VALUED = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"}
GIT_BUILTINS = {
    "add", "am", "apply", "archive", "bisect", "blame", "branch", "cat-file", "checkout", "cherry-pick", "clean",
    "clone", "commit", "config", "describe", "diff", "fetch", "for-each-ref", "format-patch", "fsck", "gc", "grep",
    "help", "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mv", "notes", "pull", "push",
    "rebase", "reflog", "remote", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show",
    "show-ref", "sparse-checkout", "stash", "status", "submodule", "switch", "symbolic-ref", "tag", "update-ref",
    "version", "worktree"}
GIT_PUSH_VALUED = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}
PUSH_IN_TEXT = re.compile(r"\bjj\b[^\n;&|#]*?\bgit\s+push\b|\bgit(?:\s+-[Cc]\s+\S+|\s+-\S+)*\s+push\b")
SCRIPT_SUFFIXES = (".sh", ".bash", ".zsh", ".nu", ".fish")
UNCLEAR = ("couldn't tell which bookmarks this push moves; run it as a plain `jj git push --bookmark <b>` "
           "(or `git push origin <ref>`)")
SCRIPT_MAX = 256 * 1024
TURN_TIMEOUT_S = 20


HEREDOC_OPEN = re.compile(r"<<(-?)\s*(['\"]?)([A-Za-z_]\w*)\2")


def _strip_heredocs(text):
    """The text without its here-documents' bodies: their words are data, not commands."""
    lines, out, i = text.split("\n"), [], 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        for dash, _, word in HEREDOC_OPEN.findall(line):
            while i < len(lines) and (lines[i].strip() if dash else lines[i]) != word:
                i += 1
            i += 1
    return "\n".join(out)


def _segments(text):
    """A shell line's simple commands as (words, nesting) pairs: split at ; & | and newlines, redirections
    dropped (`2>&1`, `>file`, `<file`), nesting counting the loops, conditionals, groups and subshells it is in."""
    import shlex
    lex = shlex.shlex(text, posix=True, punctuation_chars="();&|<>\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""
    out, words, depth, drop, comment, cases = [], [], 0, False, False, 0
    for token in lex:
        if comment and token != "\n":
            continue
        comment = False
        if token.startswith("#"):
            comment = True
            continue
        if token and all(c in "();&|<>\n" for c in token):
            if "<" in token or ">" in token:
                if words and words[-1].isdigit():
                    words.pop()
                drop = True
                token = re.sub(r"&?[<>]+&?", "", token)
                if not token:
                    continue
            if words:
                out.append((words, depth))
            words = []
            if not cases:  # a case's patterns close with ")" too
                depth = max(0, depth + token.count("(") - token.count(")"))
            continue
        if drop:
            drop = False
            continue
        if not words and token in OPENERS | CLOSERS | {"do", "then", "else", "elif", "!"}:
            depth = depth + 1 if token in OPENERS else max(0, depth - 1) if token in CLOSERS else depth
            cases += (token == "case") - (token == "esac" and cases > 0)
            continue
        words.append(token)
    if words:
        out.append((words, depth))
    return out


def _substitutions(text):
    """The commands inside the line's $(...) and backticks, outside single quotes."""
    out, i, quote = [], 0, None
    while i < len(text):
        c = text[i]
        if quote == "'":
            quote = None if c == "'" else quote
        elif c == "\\":
            i += 1
        elif c == "'" and quote is None:
            quote = "'"
        elif c == '"':
            quote = None if quote == '"' else '"'
        elif c == "`":
            j = text.find("`", i + 1)
            j = len(text) if j == -1 else j
            out.append(text[i + 1:j])
            i = j
        elif text.startswith("$(", i):
            depth, j = 0, i + 1
            while j < len(text):
                depth += {"(": 1, ")": -1}.get(text[j], 0)
                if depth == 0:
                    break
                j += 1
            out.append(text[i + 2:j])
            i = j
        i += 1
    return out


def _path(cwd, given):
    if cwd is None or "$" in given or "`" in given:
        return None
    return os.path.normpath(os.path.join(cwd, os.path.expanduser(given)))


def _unwrap(words):
    """The command a wrapper runs: past assignments, env [-i] [K=V], timeout N, nice, command, exec, nohup,
    time, devenv-run and `nix shell|develop ... --command`. (words, whether it reads its arguments from stdin)."""
    stdin = False
    while words:
        head = os.path.basename(words[0])
        if re.match(r"^[A-Za-z_]\w*=", words[0]):
            words = words[1:]
        elif head == "env":
            i = 1
            while i < len(words) and (words[i].startswith("-") or "=" in words[i]):
                i += 2 if words[i] in ("-u", "--unset", "-C", "--chdir", "-S") else 1
            words = words[i:]
        elif head == "timeout":
            i = 1
            while i < len(words) and words[i].startswith("-"):
                i += 2 if words[i] in ("-s", "-k", "--signal", "--kill-after") else 1
            words = words[i + 1:]
        elif head == "nice":
            words = words[3:] if len(words) > 1 and words[1] == "-n" else words[1:]
        elif head in ("command", "exec", "nohup", "time", "builtin"):
            words = [w for i, w in enumerate(words[1:]) if not (i == 0 and w in ("-p", "-v"))]
        elif head == "devenv-run":
            words = [w for w in words[1:] if w not in ("--refresh", "--")]
        elif head == "nix" and any(w in ("--command", "-c") for w in words):
            i = next(i for i, w in enumerate(words) if w in ("--command", "-c"))
            words = words[i + 1:]
        elif head == "xargs":
            i = 1
            while i < len(words) and words[i].startswith("-"):
                i += 2 if words[i] in ("-n", "-I", "-L", "-P", "-d", "-a", "-E", "-s") else 1
            words, stdin = words[i:], True
        else:
            break
    return words, stdin


def _script_pushes(path, by_shell=False):
    """Whether the shell script at path runs a push (any file when a shell runs it, else a .sh-like file or one
    whose #! names a shell)."""
    try:
        with open(path, "rb") as f:
            text = f.read(SCRIPT_MAX).decode("utf-8", "replace")
    except OSError:
        return False
    first = text.split("\n", 1)[0]
    shell = by_shell or path.endswith(SCRIPT_SUFFIXES) or (
        first.startswith("#!") and any(re.search(rf"\b{s}\b", first) for s in SHELLS))
    return shell and bool(PUSH_IN_TEXT.search(text))


class Reader:
    """Reads a Bash command for the pushes it runs. Aliases are looked up once per name and repo."""

    def __init__(self):
        self.aliases = {}

    def pushes(self, command, cwd, unclear=False, depth=0):
        """Every `jj git push` and `git push` the line runs, each with the directory it runs in and whether it
        is unclear: `cd` moves the directory for what follows, `sh -c '...'` and aliases are read too."""
        text = _strip_heredocs(command)
        out = []
        if depth < 4:
            for sub in _substitutions(text):
                out += self.pushes(sub, cwd, True, depth + 1)
        try:
            segments = _segments(text)
        except ValueError:
            return out + ([Push("sh", [], cwd, True)] if PUSH_IN_TEXT.search(text) else [])
        for words, nesting in segments:
            inner = unclear or nesting > 0
            words, stdin = _unwrap(words)
            if not words:
                continue
            inner = inner or stdin
            name = os.path.basename(words[0])
            if name in ("cd", "pushd"):
                target = words[1] if len(words) > 1 else "~"
                cwd = None if target == "-" or nesting > 0 else _path(cwd, target)
            elif name == "eval" and depth < 4:
                out += self.pushes(" ".join(words[1:]), cwd, True, depth + 1)
            elif name in SHELLS and depth < 4:
                flag = next((i for i, w in enumerate(words[1:], 1) if re.fullmatch(r"-[a-z]*c[a-z]*", w)), None)
                if flag is not None and flag + 1 < len(words):
                    out += self.pushes(words[flag + 1], cwd, inner, depth + 1)
                else:
                    files = [w for w in words[1:] if not w.startswith("-")]
                    if files and cwd and _script_pushes(os.path.join(cwd, files[0]), by_shell=True):
                        out.append(Push("script", words, cwd, True))
            elif name in ("source", ".") and len(words) > 1:
                if cwd and _script_pushes(os.path.join(cwd, words[1]), by_shell=True):
                    out.append(Push("script", words, cwd, True))
            elif name in ("jj", "git"):
                out += self.tool(name, words[1:], cwd, inner, depth)
            elif ("/" in words[0] or words[0].endswith(SCRIPT_SUFFIXES)) and cwd and _script_pushes(_path(cwd, words[0]) or ""):
                out.append(Push("script", words, cwd, True))
        return out

    def tool(self, name, args, cwd, unclear, depth):
        sub, i, repo = (_jj_sub if name == "jj" else _git_sub)(args, cwd)
        if sub is None:
            return []
        if name == "jj" and sub == "git" and _jj_sub(args[i + 1:], cwd)[0] == "push":
            return [Push("jj", args, cwd, unclear or _vague(args, repo))] if "--dry-run" not in args else []
        if name == "git" and sub == "push":
            rest = args[i + 1:]
            return [] if "-n" in rest or "--dry-run" in rest else [Push("git", args, cwd, unclear or _vague(args, repo))]
        builtins = JJ_BUILTINS if name == "jj" else GIT_BUILTINS
        if sub in builtins or sub.startswith("-") or depth >= 4 or repo is None:
            return []
        expansion = self.alias(name, sub, repo)
        if expansion is None:
            return []
        if isinstance(expansion, str):  # a git alias run by the shell: `!...`
            return [Push("alias", args, cwd, True)] if PUSH_IN_TEXT.search("git " + expansion) or "push" in expansion else []
        if expansion[:2] == ["util", "exec"]:
            return [Push("alias", args, cwd, True)] if any("push" in w for w in expansion) else []
        return self.tool(name, args[:i] + expansion + args[i + 1:], cwd, unclear, depth + 1)

    def alias(self, name, sub, repo):
        """A jj alias as its word list, a git alias as its words (or its text when it is `!shell`), else None."""
        key = (name, sub, repo)
        if key not in self.aliases:
            self.aliases[key] = _lookup_alias(name, sub, repo)
        return self.aliases[key]


def _lookup_alias(name, sub, repo):
    import shlex
    import subprocess
    import tomllib
    argv = ["jj", "config", "get", f"aliases.{sub}"] if name == "jj" else ["git", "config", "--get", f"alias.{sub}"]
    try:
        r = subprocess.run(argv, cwd=repo, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0 or not r.stdout.strip():
        return None
    if name == "jj":
        try:
            value = tomllib.loads("v = " + r.stdout.strip())["v"]
        except (tomllib.TOMLDecodeError, KeyError):
            return None
        return [str(w) for w in value] if isinstance(value, list) else None
    text = r.stdout.strip()
    if text.startswith("!"):
        return text[1:]
    try:
        return shlex.split(text)
    except ValueError:
        return text


def _jj_sub(args, cwd):
    """(the subcommand, its index, the repo directory) of a jj command line."""
    repo, i = cwd, 0
    while i < len(args):
        a = args[i]
        if a in JJ_VALUED:
            if a in ("-R", "--repository") and i + 1 < len(args):
                repo = _path(cwd, args[i + 1])
            i += 2
            continue
        if a.startswith("--repository="):
            repo = _path(cwd, a.split("=", 1)[1])
        elif a.startswith("-R") and len(a) > 2:
            repo = _path(cwd, a[2:])
        elif not a.startswith("-"):
            return a, i, repo
        i += 1
    return None, i, repo


def _jj_repo(args, cwd):
    """The repo a jj command line names with -R or --repository anywhere in it, else cwd."""
    repo = cwd
    for i, a in enumerate(args):
        if a in ("-R", "--repository") and i + 1 < len(args):
            repo = _path(cwd, args[i + 1])
        elif a.startswith("--repository="):
            repo = _path(cwd, a.split("=", 1)[1])
        elif a.startswith("-R") and len(a) > 2:
            repo = _path(cwd, a[2:])
    return repo


def _git_sub(args, cwd):
    repo, i = cwd, 0
    while i < len(args) and args[i].startswith("-"):
        if args[i] == "-C" and i + 1 < len(args):
            repo = _path(repo, args[i + 1])
        i += 2 if args[i] in GIT_VALUED else 1
    return (args[i] if i < len(args) else None), i, repo


def _vague(args, repo):
    """A push whose words or repo the hook cannot read as written: a variable, a substitution, an unknown dir."""
    return repo is None or any("$" in a or "`" in a for a in args)


def _git_branch(repo, ref="HEAD"):
    import subprocess
    try:
        r = subprocess.run(["git", "-C", repo, "symbolic-ref", "--short", "-q", ref], capture_output=True, text=True,
                           timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() or None


def _git_config(repo, key):
    import subprocess
    try:
        r = subprocess.run(["git", "-C", repo, "config", "--get", key], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() or None


def _git_targets(push, remote_wanted):
    """(the branches a `git push` writes on the landing remote, or None when it cannot tell). Another remote,
    and tags alone, write none there."""
    _, i, repo = _git_sub(push.args, push.cwd)
    positionals, every, tags, args, j = [], False, False, push.args[i + 1:], 0
    while j < len(args):
        a = args[j]
        if a in ("--all", "--mirror", "--branches"):
            every = True
        elif a == "--tags":
            tags = True
        elif a in GIT_PUSH_VALUED:
            j += 1
        elif a.startswith("--repo="):
            positionals.insert(0, a.split("=", 1)[1])
        elif not a.startswith("-"):
            positionals.append(a)
        j += 1
    branch = _git_branch(repo)
    remote = positionals[0] if positionals else (
        (_git_config(repo, f"branch.{branch}.pushRemote") or _git_config(repo, f"branch.{branch}.remote")) if branch else None
    ) or _git_config(repo, "remote.pushDefault") or remote_wanted
    if ":" in remote or "/" in remote or remote.startswith("."):
        return None  # a URL or a path: which remote it is, the hook cannot say
    if remote != remote_wanted:
        return set()
    if every:
        return {"*"}
    refspecs = positionals[1:]
    if not refspecs:
        if tags:
            return set()
        if _git_config(repo, f"remote.{remote}.push"):
            return None
        return {branch} if branch else set()  # detached: git refuses to push
    out = set()
    for spec in refspecs:
        src, colon, dst = spec.lstrip("+").partition(":")
        target = dst if colon else (branch if src == "HEAD" else src)
        if not target or (target.startswith("refs/") and not target.startswith("refs/heads/")):
            continue
        out.add(target.removeprefix("refs/heads/"))
    return out


def _jj_targets(push, remote_wanted):
    """(the bookmarks a `jj git push` moves on the landing remote, or None when it cannot tell), from jj's own
    dry run of the same command; when that fails, its --remote and literal --bookmark names, and --all."""
    import subprocess
    args = push.args
    try:
        r = subprocess.run(["jj", *args, "--dry-run"], cwd=push.cwd, capture_output=True, text=True,
                           timeout=TURN_TIMEOUT_S, env={**os.environ, "JJ_EDITOR": "true", "EDITOR": "true"})
        said = r.stdout + r.stderr
        if r.returncode == 0:
            remote = re.search(r"^Changes to push to (\S+):", said, re.M)
            if remote is None:
                return set()  # nothing to push
            return set(re.findall(r"^\s*bookmark: (\S+) \[", said, re.M)) if remote.group(1) == remote_wanted else set()
    except (OSError, subprocess.TimeoutExpired):
        pass
    remote, names, every = remote_wanted, set(), False
    for i, a in enumerate(args):
        value = args[i + 1] if i + 1 < len(args) else ""
        if a == "--remote":
            remote = value
        elif a.startswith("--remote="):
            remote = a.split("=", 1)[1]
        elif a == "--all":
            every = True
        elif a in ("-b", "--bookmark"):
            names.add(value)
        elif a.startswith("--bookmark="):
            names.add(a.split("=", 1)[1])
    if remote != remote_wanted:
        return set()
    if every:
        return {"*"}
    names = {re.sub(r"^(exact|glob|substring|regex)(-i)?:", "", n) for n in names}
    return names or None


def _land_check():
    from importlib.machinery import SourceFileLoader
    from importlib.util import module_from_spec, spec_from_loader
    loader = SourceFileLoader("land_check", str(ROOT / "scripts" / "land-check"))
    module = module_from_spec(spec_from_loader("land_check", loader))
    loader.exec_module(module)
    return module


def _onto_landing(lc, push):
    """The landing bookmarks this push moves on the landing remote (land-check's), or None when unclear."""
    import fnmatch
    if push.unclear or push.tool not in ("jj", "git"):
        return None
    repo = _jj_repo(push.args, push.cwd) if push.tool == "jj" else _git_sub(push.args, push.cwd)[2]
    if repo is None:
        return None
    targets = (_git_targets if push.tool == "git" else _jj_targets)(push, lc.LANDING_REMOTE)
    if not targets:
        return targets
    landing = lc.landing_bookmarks(repo)
    return sorted(b for b in landing if any(fnmatch.fnmatchcase(b, t) for t in targets))


def land_turn_gate(hook):
    """PreToolUse (Bash): a push to the repo's landing bookmark waits for the landing turn. The hook first works
    out what the command pushes; only a push onto a landing bookmark on the landing remote, or one it cannot
    read, asks land-check's turn (`fleet turn`, which finds the fleet by the session's process). In a fleet
    whose machine serves a manager and that does not hold the turn, the push is denied; Luiz's approval to
    push answers whether it may land, the turn when. Outside a managed fleet, and for any other push, it says
    nothing. When the fleet CLI cannot run, the push goes through with a warning: a broken hub never blocks
    every push."""
    tool_input = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    command = tool_input.get("command") if hook.input.get("tool_name") == "Bash" else None
    if not isinstance(command, str):
        return None
    pushes = Reader().pushes(command, hook.cwd)
    if not pushes:
        return None
    lc = _land_check()
    landing, unclear = set(), False
    for push in pushes:
        moved = _onto_landing(lc, push)
        unclear = unclear or moved is None
        landing.update(moved or [])
    if not landing and not unclear:
        return None
    cli = hook.env.get("TSTACK_FLEET_CLI") or fleet_cli()
    timeout = float(hook.env.get("TSTACK_TURN_TIMEOUT_S") or TURN_TIMEOUT_S)
    turn = lc.landing_turn(cli, timeout=timeout)
    if turn is not None and turn[0] == 0:
        return None
    what = (f"This push moves the landing bookmark {', '.join(sorted(landing))}" if landing
            else f"The hook {UNCLEAR}")
    if turn is None or turn[0] != 1 or not turn[1].startswith("turn: "):
        why = "the fleet CLI could not run" if turn is None else f"`fleet turn` exited {turn[0]}: {turn[1][:300]}"
        sys.stderr.write(f"tstack: {what}, and its landing turn could not be checked ({why}); letting it through.\n")
        log(hook.data_dir, f"{hook.event} land_turn_gate failed open: {why}")
        return None
    said = turn[1].removeprefix("turn: ")
    fleet = said.split(" does not hold", 1)[0] if " does not hold" in said else "this fleet"
    onto = f"onto {', '.join(sorted(landing))}" if landing else "(a push it could not read)"
    _log_denial(hook, lc, cli, f"Push gate: refused `{_one_line(command, 120)}`: {fleet} does not hold the landing "
                               f"turn {onto}")
    unclear_line = f" Also, {UNCLEAR}." if landing and unclear else ""
    return Deny(f"{what}, and {fleet} doesn't hold the landing turn (fleet turn: {said}). Ask the manager for it as "
                f"that says, wait for its answer, and check with `{cli} turn` before pushing again. Luiz's approval "
                f"to push doesn't skip the queue: it answers whether this may land, the turn answers when.{unclear_line}")


def _log_denial(hook, lc, cli, text):
    """The denial as an important `blocked` event in the fleet's ledger (land-check's find_ledger: $FLEET_DIR,
    else the served fleet among the session's processes; else the session's own fleet folder)."""
    import subprocess
    found = lc.find_ledger(None)
    for d in [str(found.parent)] if found else fleet_dirs(hook)[:1]:
        worker = _refused_worker(read_ledger(d) or {}, hook.input.get("agent_id"), hook.env)
        if moved(d):
            try:
                fleet_run(hook, d, blocked_program(text, worker))
            except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
                log(hook.data_dir, f"{hook.event} land_turn_gate: fleet-run failed: {e}")
            continue
        argv = [cli, "state", d, "event", "--kind", "blocked", "--important",
                *(_option("--agent", worker) if worker else []), text]
        try:
            done = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, env=dict(hook.env),
                                  timeout=CLI_TIMEOUT_S, check=False)
            if done.returncode:
                log(hook.data_dir, f"{hook.event} land_turn_gate: {cli} state exited {done.returncode}: "
                                   f"{(done.stderr or done.stdout).strip()}")
        except (OSError, subprocess.TimeoutExpired) as e:
            log(hook.data_dir, f"{hook.event} land_turn_gate: {cli} state failed: {e}")


# The suite gate. A repo's whole test suite (`pnpm test`, `vitest run`, `just test`, `pytest`, ...) spikes memory; a
# fleet's workers running several at once ran the machine out of it. In a managed fleet's session such a command runs
# only through the gate slot, in a memory-capped scope that dies whole (`fleet fleets gate run`): the hook denies the
# call and names that command, so Claude issues it and the permission check reviews it as any other. The hook never
# allows or rewrites a call. A scoped run (a path, `--changed`, `related`, one package, a name filter: `-t`, `-k`,
# `--lf`, `cargo test NAME`, `go test -run X`) is left alone. Reading follows the push gate's: redirections, wrappers,
# `cd`, `-C`, `sh -c`; a test runner the hook cannot read (a script, eval, xargs, a substitution) counts as a full suite.
Suite = namedtuple("Suite", "what unclear")
SUITE_WAIT_S = 1800
SUITE_TIMEOUT_MS = 600000  # the Bash tool's most: a run may queue behind another suite
# `just` recipes that run a full suite, by name: tstack's `test` (every suite) and its per-suite recipes (justfile).
# Any other recipe, `test-changed` and `test-coordinator-page` (one file) included, is left alone.
JUST_FULL_SUITES = {"test", "test-scripts", "test-lint-ts", "test-coordinator", "test-fleet", "test-fleet-ts",
                    "test-fleet-ts-own", "test-fleet-ts-oracle", "test-page"}
# Options that narrow a run to the tests a name matches: passed to a package's `test` script, they make it scoped.
NAME_FILTERS = {"-t", "--testNamePattern", "--test-name-pattern", "-k", "--lf", "--last-failed"}
TEST_IN_TEXT = re.compile(r"\b(?:(?:pnpm|npm|yarn|bun)\s+(?:-\S+\s+)*(?:run\s+)?test\b|vitest\b|vp\s+test\b|pytest\b|py\.test\b"
                          r"|cargo\s+(?:test|nextest)\b|go\s+test\b|just\s+test\b|node\s+--test\b)")
# A plain `echo` or `printf` (no `printf -v`), its words holding no `$(` or backtick, with its own `>&2` or `1>&2`:
# its words go to stderr, which no outer `|` or `>` takes, so a test runner they name runs nothing. Not in a script
# with a stderr move (STDERR_MOVED, anywhere but /dev/null) that could take them after all (_stderr_carried).
ECHOED = re.compile(r"(^|;|&&|\|\||\{|\b(?:then|do|else)\b)([ \t]*(?:1?>&2[ \t]+)?(?:echo|printf(?![ \t]+-v)))"
                    r"((?:[ \t]+(?:'[^'\n]*'|\"(?:[^\"\\`$\n]|\\.|\$(?!\())*\"|[^\s'\"`;&|<>()$\\]|\$(?!\()|\\.)+)+)"
                    r"(?=((?:[ \t]+1?>&2)*)[ \t]*(?:$|;|&&|\|\||\}))", re.M)
STDERR_MOVED = re.compile(r"2>>?(?![ \t]*/dev/null\b)|\|&|&>|>&(?![ \t]*\d)|\bexec\b[^\n;|&]*[<>]")
# On a line with a stderr move, what lets the move take an echo on another line: a shell, eval, source or exec that
# runs code, a here-document, and (before the move, past any `${...}`) a block's closer.
MOVE_RUNS = re.compile(rf"(?<![\w.$-])(?:{'|'.join(sorted(SHELLS))}|eval|source|exec)(?![\w.-])|(?<![^\s;&|{{(])\.(?=\s)|<<")
MOVE_CLOSES = re.compile(r"[})]|\b(?:done|fi|esac)\b")
FUNCTION_DEF = re.compile(r"([ \t]*)(?:function[ \t]+([\w:.-]+)(?:[ \t]*\(\))?|([\w:.-]+)[ \t]*\(\))")
# A script that runs the command it is given (`exec "$@"`) is a launcher: the line runs the launcher's arguments.
LAUNCHES_ARGS = re.compile(r"\$\{?[@*]\}?")
PM_TEST = {"test", "t", "tst"}
PM_RUN = {"run", "run-script", "rum", "urn"}
PNPM_VALUED = {"-C", "--dir", "--filter", "-F", "--reporter", "--loglevel", "--workspace-concurrency", "--filter-prod",
               "--test-pattern", "--changed-files-ignore-pattern"}
NPM_VALUED = {"--prefix", "-w", "--workspace", "--loglevel", "--userconfig"}
YARN_VALUED = {"--cwd"}
BUN_VALUED = {"--cwd", "--config", "-c", "--preload", "-r", "--filter", "-F"}
VITEST_VALUED = {"-t", "--testNamePattern", "-c", "--config", "-r", "--root", "--project", "--reporter", "--pool",
                 "--shard", "--environment", "--outputFile", "--maxWorkers", "--minWorkers", "--mode", "--exclude",
                 "--bail", "--retry", "--testTimeout", "--hookTimeout", "--sequence.seed", "--inspect-brk",
                 "--coverage.provider", "--coverage.reporter", "--silent", "--logHeapUsage"}
VITEST_BOOLEAN_VALUED = {"--silent", "--logHeapUsage"}  # take a value only as --flag=value
BUN_TEST_VALUED = {"-t", "--test-name-pattern", "--timeout", "--preload", "--rerun-each", "--coverage-reporter",
                   "--coverage-dir", "--reporter", "--reporter-outfile", "--max-concurrency", "--seed", "--parallel"}
PYTEST_VALUED = {"-k", "-m", "-p", "-c", "-o", "-n", "-W", "-r", "--rootdir", "--maxfail", "--durations", "--tb",
                 "--junitxml", "--junit-xml", "--ignore", "--ignore-glob", "--deselect", "--confcutdir", "--basetemp",
                 "--log-level", "--timeout", "--dist", "--cov-report", "--color", "--import-mode", "-x"}
PYTEST_FLAGS = {"-x"}  # -x is a flag, not valued
PYTEST_SCOPES = {"-k", "--lf", "--last-failed"}
CARGO_TEST_VALUED = {"--manifest-path", "--features", "-F", "--target", "--target-dir", "-j", "--jobs", "--profile",
                     "--message-format", "--color", "--config", "-Z", "--test", "--bench", "--example", "--bin"}
JUST_VALUED = {"-f", "--justfile", "-d", "--working-directory", "--set", "--shell", "--shell-arg", "--dotenv-filename",
               "--dotenv-path", "--color", "--command-color", "--chooser", "--list-heading", "--list-prefix"}
TEST_FILE = re.compile(r"(\.|_)(test|spec)\.[cm]?[jt]sx?$|^test_.*\.py$|_test\.py$|\.py$")
# The commands SuiteReader.command reads by name (pinned by a test). Called by the path of an installed runner's shim
# (_installed), its verdict stands: the shim's text names the runner, it is not a script to read for tests.
RUNNERS = {"npx", "bunx", "pnpx", "uvx", "uv", "poetry", "pipenv", "hatch", "pdm", "rye", "gates", "pnpm", "npm",
           "yarn", "bun", "vitest", "vp", "pytest", "py.test", "cargo", "go", "just", "node"}
VP_EXEC_VALUED = {"-F", "--filter", "--resume-from"}


def _installed(path):
    """Whether path is where a package manager puts a runner: under node_modules, in /nix/store, or in a venv's bin."""
    p = Path(path)
    return "node_modules" in p.parts or os.path.realpath(path).startswith("/nix/store/") \
        or (p.parent.name == "bin" and (p.parent.parent / "pyvenv.cfg").is_file())


def _opts(args, valued):
    """(positionals, options) of args: a `--flag value` pair in valued counts as one option; `--` ends the options."""
    pos, opts, i = [], [], 0
    while i < len(args):
        a = args[i]
        if a == "--":
            pos += args[i + 1:]
            break
        if a.startswith("-") and a != "-":
            opts.append(a)
            if a in valued and "=" not in a and i + 1 < len(args):
                opts.append(args[i + 1])
                i += 1
        else:
            pos.append(a)
        i += 1
    return pos, opts


def _filters(opts, flags):
    """Whether opts hold one of flags, as `-t x`, `--flag=x` or `-tx`."""
    return any(o in flags or o.split("=", 1)[0] in flags or (o[:2] in flags and len(o) > 2 and not o.startswith("--"))
               for o in opts)


def _value(args, *flags):
    """The value args give the first of flags (`-C dir`, `--dir=dir`), else None."""
    for i, a in enumerate(args):
        for f in flags:
            if a == f and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(f + "=") and f.startswith("--"):
                return a.split("=", 1)[1]
    return None


def _scripts(cwd):
    """The "scripts" of the package.json in cwd: a dict, {} when it has none, None when it cannot be read."""
    if cwd is None:
        return None
    try:
        data = json.loads(Path(cwd, "package.json").read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return None
    scripts = data.get("scripts") if isinstance(data, dict) else None
    return {k: v for k, v in scripts.items() if isinstance(v, str)} if isinstance(scripts, dict) else {}


def _uncommented(code, structured=True):
    """Shell code with its comments left out: from a `#` that starts a word outside quotes to the end of its line.
    A here-document's body is copied as it is, with no quotes read in it; a `$(` ... `)` inside double quotes is a
    level of its own, where quotes start fresh. Unstructured, it reads quotes alone: no here-documents, no `$(` levels."""
    out, quote, i, nested, heredocs = [], None, 0, [], []
    while i < len(code):
        c = code[i]
        if quote == "'":
            quote = None if c == "'" else quote
        elif c == "\\":
            out.append(code[i:i + 2])
            i += 2
            continue
        elif structured and quote == '"' and c == "$" and code[i + 1:i + 2] == "(":
            nested.append([quote, 1])
            quote = None
            out.append("$(")
            i += 2
            continue
        elif quote:
            quote = None if c == quote[-1] else quote
        elif structured and c == "\n" and heredocs:
            out.append(c)
            i += 1
            for dash, word in heredocs:
                while i < len(code):
                    end = code.find("\n", i)
                    end = len(code) if end < 0 else end
                    line = code[i:end]
                    out.append(code[i:end + 1])
                    i = end + 1
                    if (line.lstrip("\t") if dash else line) == word:
                        break
            heredocs = []
            continue
        elif structured and nested and c in "()":
            nested[-1][1] += 1 if c == "(" else -1
            if nested[-1][1] == 0:
                quote = nested.pop()[0]
        elif c == "$" and code[i + 1:i + 2] == "'":
            quote, c, i = "$'", "$'", i + 1
        elif c in "'\"":
            quote = c
        elif (structured and c == "<" and code[i - 1:i] != "<" and not _in_arithmetic(code, i)
              and (found := HEREDOC_OPEN.match(code, i))):
            heredocs.append((bool(found.group(1)), found.group(3)))
            out.append(found.group(0))
            i = found.end()
            continue
        elif c == "#" and _word_starts(code, i):
            end = code.find("\n", i)
            i = len(code) if end < 0 else end
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _runner_functions(lines):
    """The script's functions whose body names a test runner, or calls one that does: a call of one can move what
    its echoes print. A body runs from its definition to the first `}` or `)` line indented no deeper, or is the
    definition's line when that closes what it opens."""
    bodies = []
    for i, line in enumerate(lines):
        if not (m := FUNCTION_DEF.match(line)):
            continue
        end = i
        if sum(map(line.count, "{(")) > sum(map(line.count, "})")):
            end = next((j for j in range(i + 1, len(lines)) if lines[j].lstrip()[:1] in ("}", ")")
                        and len(lines[j]) - len(lines[j].lstrip()) <= len(m[1])), len(lines) - 1)
        bodies.append((m[2] or m[3], "\n".join(lines[i:end + 1])))
    found = set()
    while new := {name for name, body in bodies if name not in found and (TEST_IN_TEXT.search(body) or any(
            re.search(rf"(?<![\w.-]){re.escape(f)}(?![\w.-])", body) for f in found))}:
        found |= new
    return found


def _stderr_carried(text):
    """Whether a stderr move in the script, outside its whole-line comments, could take what an echo on any line
    prints to stderr: an exec, shell, eval, source or here-document on its line (MOVE_RUNS), a block's closer before
    it (MOVE_CLOSES), a call of a function that names a runner (_runner_functions), or a line that a `\\` continues or
    that starts inside a quote or a here-document. A move that takes only an outside command's stderr
    (`psql ... 2> err`, `lint 2>&1 | redact`) takes no echo's."""
    lines, start, functions = text.split("\n"), 0, None
    for i, line in enumerate(lines):
        at, start = start, start + len(line) + 1
        if line.lstrip().startswith("#") or not (move := STDERR_MOVED.search(line)):
            continue
        if functions is None:
            functions = _runner_functions(lines)
        if (MOVE_RUNS.search(line) or MOVE_CLOSES.search(re.sub(r"\$\{[^}\n]*\}", "$x", line[:move.start()]))
                or any(re.search(rf"(?<![\w.-]){re.escape(f)}(?![\w.-])", line) for f in functions)
                or (i and lines[i - 1].endswith("\\")) or _uncommented(text[:at] + "#").endswith("#")):
            return True
    return False


def _in_arithmetic(code, i):
    """Whether code[i] is inside a `((` ... `))` on its line: `$((1<<x))` shifts, it opens no here-document."""
    head = code[code.rfind("\n", 0, i) + 1:i]
    return head.count("((") > head.count("))")


def _word_starts(code, i):
    """Whether code[i] starts a word: the line start or a blank or operator before it, past any `\\` + newline,
    which joins the two lines into one."""
    while code[i - 2:i] == "\\\n":
        i -= 2
    return i == 0 or code[i - 1] in " \t\n;&|()"


class SuiteReader:
    """Reads a Bash command for the full test suites it runs."""

    def suites(self, command, cwd, unclear=False, depth=0):
        text = _strip_heredocs(command)
        out = []
        if depth < 4:
            for sub in _substitutions(text):
                out += self.suites(sub, cwd, True, depth + 1)
        try:
            segments = _segments(text)
        except ValueError:
            return out + ([Suite("a command the hook cannot parse", True)] if TEST_IN_TEXT.search(text) else [])
        for words, nesting in segments:
            words, stdin = _unwrap(words)
            if not words:
                continue
            name = os.path.basename(words[0])
            if name in ("cd", "pushd"):
                target = words[1] if len(words) > 1 else "~"
                cwd = None if target == "-" or nesting > 0 else _path(cwd, target)
            elif name == "systemd-run" and "--scope" in words:
                continue  # already in a scope of its own
            elif name == "eval" and depth < 4:
                out += self.suites(" ".join(words[1:]), cwd, True, depth + 1)
            elif name in NOEXEC_SHELLS and any(re.fullmatch(r"-[a-zA-Z]*n[a-zA-Z]*|--no-execute", w) for w in
                                               words[1:next((i for i, w in enumerate(words) if i and not w.startswith("-")),
                                                            len(words))]):
                continue  # `bash -n FILE` reads it for syntax and runs nothing
            elif name in SHELLS and depth < 4:
                flag = next((i for i, w in enumerate(words[1:], 1) if re.fullmatch(r"-[a-z]*c[a-z]*|--commands?(?:=.*)?",
                                                                                   w, re.S)), None)
                code = (words[flag].split("=", 1)[1] if flag is not None and "=" in words[flag]
                        else words[flag + 1] if flag is not None and flag + 1 < len(words) else None)
                if code is not None:
                    out += self.suites(code, cwd, unclear or stdin, depth + 1)
                else:
                    files = [w for w in words[1:] if not w.startswith("-")]
                    if files and cwd and self._script_tests(os.path.join(cwd, files[0]), True):
                        out.append(Suite(" ".join(words), True))
            elif name in ("source", ".") and len(words) > 1:
                if cwd and self._script_tests(os.path.join(cwd, words[1]), True):
                    out.append(Suite(" ".join(words), True))
            else:
                found = self.command(words, cwd, depth)
                if found:
                    out.append(Suite(found, unclear or stdin or nesting > 0))
                elif ("/" in words[0] or words[0].endswith(SCRIPT_SUFFIXES)) and cwd \
                        and not ((name in RUNNERS or re.fullmatch(r"python[\d.]*", name))
                                 and _installed(_path(cwd, words[0]) or words[0])):
                    code = self._script_code(_path(cwd, words[0]) or "")
                    if code is not None and TEST_IN_TEXT.search(code):
                        out.append(Suite(" ".join(words), True))
                    elif code is not None and LAUNCHES_ARGS.search(code) and len(words) > 1 and depth < 4:
                        import shlex
                        inner = self.suites(shlex.join(words[1:]), cwd, False, depth + 1)
                        if inner:
                            out.append(Suite(" ".join(words), unclear or stdin or nesting > 0
                                             or any(s.unclear for s in inner)))
        return out

    @staticmethod
    def _script_code(path, by_shell=False):
        """The code of the shell script at path, its comments left out, three times: with its whole-line comments
        left out; read for quotes (_uncommented), which copies here-document bodies as they are; and read for quotes
        alone, with no here-documents or `$(` levels. Each view can misread (a stray quote in a `<<\\EOF` body, a `<<`
        taken for a here-document), so a pattern found in any counts; the words a plain echo or printf prints are blanked
        in each (ECHOED) when it prints to stderr and no stderr move could take them (_stderr_carried), so a runner named
        only there, in every view, counts in none. None when it cannot be read or is no shell
        script (any file is when a shell runs it, else a .sh-like file or one whose #! names a shell)."""
        try:
            with open(path, "rb") as f:
                text = f.read(SCRIPT_MAX).decode("utf-8", "replace")
        except OSError:
            return None
        first = text.split("\n", 1)[0]
        shell = by_shell or path.endswith(SCRIPT_SUFFIXES) or (
            first.startswith("#!") and any(re.search(rf"\b{s}\b", first) for s in SHELLS))
        if not shell:
            return None
        code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#")) + "\n" + _uncommented(text) + "\n" + _uncommented(text, False)
        if _stderr_carried(text):
            return code
        return ECHOED.sub(lambda m: m[1] + m[2] + (re.sub(r"\S", " ", m[3]) if ">&2" in m[2] + m[4] else m[3]), code)

    @classmethod
    def _script_tests(cls, path, by_shell=False):
        code = cls._script_code(path, by_shell)
        return code is not None and bool(TEST_IN_TEXT.search(code))

    def command(self, words, cwd, depth=0):
        """The full suite one simple command runs, as the words to name it by, else None."""
        name, args = os.path.basename(words[0]), words[1:]
        shown = " ".join(words[:4])
        if name in ("npx", "bunx", "pnpx", "uvx"):
            pos = [a for a in args if not a.startswith("-")]
            return self.command(args[args.index(pos[0]):], cwd, depth) if pos else None
        if name in ("uv", "poetry", "pipenv", "hatch", "pdm", "rye") and args[:1] == ["run"]:
            rest = [a for a in args[1:] if not a.startswith("-")]
            return self.command(args[args.index(rest[0], 1):], cwd, depth) if rest else None
        if re.fullmatch(r"python[\d.]*", name) and len(args) >= 2 and args[0] == "-m":
            return self.command([args[1], *args[2:]], cwd, depth)
        if re.fullmatch(r"python[\d.]*", name) and args and os.path.basename(args[0]) == "gates" and args[1:2] == ["all"]:
            return shown
        if name == "gates" and args[:1] == ["all"]:
            return shown
        if name in ("pnpm", "npm", "yarn", "bun"):
            return self._package_manager(name, args, cwd, depth, shown)
        if name == "vitest":
            return self._vitest(args, shown)
        if name == "vp":
            pos = [a for a in args if not a.startswith("-")]
            if pos[:1] == ["test"]:
                return self._vitest(args[args.index("test") + 1:], shown)
            if pos[:1] == ["run"] and len(pos) > 1:
                return self._script(pos[1], args[args.index(pos[1]) + 1:], cwd, depth, shown, recursive=False)
            if pos[:1] == ["exec"]:
                rest, i = args[args.index("exec") + 1:], 0
                while i < len(rest) and rest[i].startswith("-") and rest[i] != "--":
                    i += 2 if rest[i] in VP_EXEC_VALUED else 1
                shell = any(a in ("-c", "--shell-mode") for a in rest[:i])
                rest = rest[i + 1:] if rest[i:i + 1] == ["--"] else rest[i:]
                if shell and depth < 4:
                    return shown if self.suites(" ".join(rest), cwd, False, depth + 1) else None
                return self.command(rest, cwd, depth) if rest else None
            return None
        if name in ("pytest", "py.test"):
            pos, opts = _opts([a for a in args if a not in PYTEST_FLAGS], PYTEST_VALUED - PYTEST_FLAGS)
            return None if pos or _filters(opts, PYTEST_SCOPES) else shown
        if name == "cargo":
            own = args[:args.index("--")] if "--" in args else args
            pos, opts = _opts(own, CARGO_TEST_VALUED | {"-p", "--package", "--exclude", "-E", "--filter-expr"})
            sub = pos[:1]
            if sub == ["test"] or (sub == ["nextest"] and pos[1:2] == ["run"]):
                named = pos[1:] if sub == ["test"] else pos[2:]  # `cargo test NAME`, `cargo nextest run NAME`
                if named or _filters(opts, {"-E", "--filter-expr"}):
                    return None
                return None if any(o in ("-p", "--package") or o.startswith("--package=") for o in opts) and \
                    "--workspace" not in opts else shown
            return None
        if name == "go":
            i = 0
            while i < len(args) and args[i].startswith("-"):
                i += 2 if args[i] == "-C" else 1
            if args[i:i + 1] != ["test"]:
                return None
            rest = args[i + 1:]
            if any(re.fullmatch(r"--?run(=.*)?", a) for a in rest):
                return None  # `go test -run X ./...`: the tests X names
            pos = [a for a in rest if not a.startswith("-")]
            return shown if any(p in ("./...", "...") for p in pos) else None
        if name == "just":
            pos, _ = _opts(args, JUST_VALUED)
            return shown if pos[:1] and pos[0] in JUST_FULL_SUITES else None
        if name in ("node", "bun") and "--test" in args:
            pos, _ = _opts(args, {"--test-name-pattern", "--test-reporter", "--test-reporter-destination",
                                  "--test-concurrency", "--test-shard", "--import", "--require", "-r"})
            return None if pos else shown
        return None

    def _vitest(self, args, shown):
        pos, opts = _opts(args, VITEST_VALUED - VITEST_BOOLEAN_VALUED)
        if pos[:1] in (["related"], ["list"], ["bench"], ["init"]):
            return None
        if pos[:1] in (["run"], ["watch"], ["dev"]):
            pos = pos[1:]
        if pos or any(o == "--changed" or o.startswith("--changed=") or o == "--dir" or o.startswith("--dir=") for o in opts):
            return None
        return None if _filters(opts, {"-t", "--testNamePattern"}) else shown

    def _package_manager(self, name, args, cwd, depth, shown):
        valued = {"pnpm": PNPM_VALUED, "npm": NPM_VALUED, "yarn": YARN_VALUED, "bun": BUN_VALUED}[name]
        at = _value(args, "-C", "--dir") if name == "pnpm" else _value(args, "--prefix") if name == "npm" else \
            _value(args, "--cwd")
        here = _path(cwd, at) if at is not None and cwd is not None else (None if at is not None else cwd)
        recursive = any(a in ("-r", "--recursive", "-ws", "--workspaces") or a.startswith("--filter")
                        or a in ("-F", "-w", "--workspace") for a in args)
        i = 0
        while i < len(args) and args[i].startswith("-"):
            i += 2 if args[i] in valued and "=" not in args[i] else 1
        if i >= len(args):
            return None
        sub, rest = args[i], args[i + 1:]
        if name == "bun" and sub == "test":
            pos, opts = _opts(rest, BUN_TEST_VALUED)
            return None if pos or _filters(opts, {"-t", "--test-name-pattern"}) else shown
        if name == "bun" and sub == "x":
            return self.command(rest, here, depth) if rest else None
        if sub in ("exec", "dlx") or (name == "npm" and sub in ("exec", "x")):
            rest = rest[rest.index("--") + 1:] if "--" in rest else rest
            pos = [a for a in rest if not a.startswith("-")]
            return self.command(rest[rest.index(pos[0]):], here, depth) if pos else None
        if sub in PM_TEST:
            return self._script("test", rest, here, depth, shown, recursive)
        if sub in PM_RUN:
            pos = [a for a in rest if not a.startswith("-")]
            if not pos:
                return None
            return self._script(pos[0], rest[rest.index(pos[0]) + 1:], here, depth, shown, recursive)
        if name in ("npm",):
            return None  # npm runs only its own commands: `npm run X`
        scripts = _scripts(here)
        if (scripts is not None and sub in scripts) or (scripts is None and sub.startswith("test")):
            return self._script(sub, rest, here, depth, shown, recursive)
        if name in ("pnpm", "yarn") and sub in ("vitest", "jest", "pytest"):
            return self.command([sub, *rest], here, depth)
        return None

    def _script(self, script, rest, cwd, depth, shown, recursive):
        """Whether `<pm> run SCRIPT REST` runs a full suite: `test` is the repo's whole test entry point unless REST
        names a path; any other script, when its body runs one (read from package.json, with REST appended)."""
        passed = rest[rest.index("--") + 1:] if "--" in rest else rest
        if any(("/" in a or TEST_FILE.search(a)) and not a.startswith("-") for a in passed) \
                or any(a == "--changed" or a.startswith("--changed=") or a == "related" for a in passed) \
                or _filters(passed, NAME_FILTERS):
            return None
        if script == "test":
            return shown
        scripts = _scripts(cwd)
        if scripts is None:
            return shown if script.startswith("test") else None  # unreadable: a test-named script counts
        body = scripts.get(script)
        if body is None:
            return shown if recursive and script.startswith("test") else None
        if depth >= 4:
            return shown if script.startswith("test") else None
        inner = self.suites(" ".join([body, *passed]), cwd, False, depth + 1)
        return f"{shown} (`{_one_line(body, 80)}`)" if inner else None


def managed_fleet(hook):
    """The fleet this session serves when this machine serves a manager, else None: the live registry entry for
    $FLEET_DIR, else the coordinator whose session process is among this hook's parents (as `fleet turn` finds it),
    else the one recorded with this session's id (the manager's own too), else the one whose dir is a fleet folder of
    the session's scratchpad."""
    live = []
    try:
        paths = list(fleet_registry(hook.env).glob("*.json"))
    except OSError:
        return None
    for path in paths:
        try:
            entry = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not isinstance(entry.get("dir"), str):
            continue
        try:
            pid = int(entry.get("pid"))
            os.kill(pid, 0)
        except (TypeError, ValueError, ProcessLookupError, PermissionError, OverflowError):
            continue
        live.append({**entry, "pid": pid})
    if not any(e.get("role") == "manager" for e in live):
        return None

    def real(p):
        return os.path.realpath(p)

    given = hook.env.get("FLEET_DIR")
    if given:
        found = [e for e in live if real(e["dir"]) == real(given)]
        if found:
            return found[0]["id"]
    mine = set(_ancestors())
    for e in live:
        if e["pid"] in mine and e.get("role") != "manager":  # as `fleet turn` finds it
            return e["id"]
    for e in live:
        if hook.session_id and e.get("session_id") == hook.session_id:
            return e["id"]
    dirs = {real(d) for d in fleet_dirs(hook)}
    return next((e["id"] for e in live if real(e["dir"]) in dirs), None)


def _ancestors():
    """This process's parents, nearest first (/proc on Linux, `ps` elsewhere)."""
    pid, out = os.getppid(), []
    parents = None
    if not os.path.isdir("/proc/self"):
        import subprocess
        try:
            text = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, timeout=3).stdout
        except (OSError, subprocess.SubprocessError):
            return out
        parents = {}
        for line in text.splitlines():
            bits = line.split()
            if len(bits) == 2 and all(b.isdigit() for b in bits):
                parents[int(bits[0])] = int(bits[1])
    while pid > 1 and len(out) < 64:
        out.append(pid)
        if parents is not None:
            pid = parents.get(pid, 0)
            continue
        try:
            stat = Path(f"/proc/{pid}/stat").read_text()
            pid = int(stat.rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return out


def _gate_hold(env):
    """Who holds the gate slot, as `fleet fleets gate` would say it, or None when it is free (or unreadable)."""
    from datetime import datetime
    try:
        held = json.loads((fleet_registry(env) / "gate" / "gate.json").read_text())
        until = datetime.fromisoformat(held["until"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    now = datetime.now(until.tzinfo) if until.tzinfo else datetime.now()
    if now >= until:
        return None
    if held.get("pid") is not None:  # `gate run`'s hold lapses with its runner
        try:
            os.kill(int(held["pid"]), 0)
        except PermissionError:
            pass
        except (OSError, TypeError, ValueError, OverflowError):
            return None
    return f"{held.get('fleet')}: {held.get('what')}"


def _hand_tokens(env, name):
    """The tokens of the holds `name` took by hand (`gate take`) that have not lapsed: a `gate run` never goes under
    one, its own name's included, so a run of that name waits on them. gate.json is one hold, or with `v: 2` a summary
    that carries them in `holds`."""
    from datetime import datetime
    try:
        held = json.loads((fleet_registry(env) / "gate" / "gate.json").read_text())
    except (OSError, ValueError):
        return []
    holds = held.get("holds") if isinstance(held, dict) and isinstance(held.get("holds"), list) else [held]
    tokens = []
    for hold in holds:
        if not isinstance(hold, dict) or hold.get("pid") is not None or hold.get("fleet") != name \
                or not isinstance(hold.get("token"), str):
            continue
        try:
            until = datetime.fromisoformat(hold["until"])
        except (KeyError, TypeError, ValueError):
            continue
        if (datetime.now(until.tzinfo) if until.tzinfo else datetime.now()) < until:
            tokens.append(hold["token"])
    return tokens


def suite_gate(hook):
    """PreToolUse (Bash): a full test suite in a managed fleet's session runs through the gate slot, in a memory-capped
    scope (`fleet fleets gate run`). The call is denied with the exact command to run instead, so Claude issues it and
    the permission check reviews it like any other call: the hook never allows or rewrites one. Outside a managed
    fleet nothing changes: an interactive session gets a hint on stderr."""
    import shlex
    tool_input = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    command = tool_input.get("command") if hook.input.get("tool_name") == "Bash" else None
    if not isinstance(command, str) or re.search(r"\bfleets\s+gate\s+(?:run|take)\b", command):
        return None
    found = SuiteReader().suites(command, hook.cwd)
    if not found:
        return None
    what = found[0].what
    fleet = managed_fleet(hook)
    cli = hook.env.get("TSTACK_FLEET_CLI") or fleet_cli()
    if fleet is None:
        if not hook.headless:
            sys.stderr.write(f"tstack: `{_one_line(what, 80)}` runs a whole test suite; "
                             f"`{cli} fleets gate run --as <name> -- <command>` queues it behind other suites and caps "
                             f"its memory.\n")
        return None
    words = None
    try:
        words = shlex.split(command)
    except ValueError:
        pass
    simple = words and not re.search(r"[;&|<>()$`\n\\#]", command) and not re.match(r"^[A-Za-z_]\w*=", words[0]) \
        and os.path.basename(words[0]) not in ("cd", "pushd", "eval", "source", ".")
    inner = command.strip() if simple else f"{'bash' if shutil_which('bash') else 'sh'} -c {shlex.quote(command)}"
    wrapped = f"{shlex.quote(cli)} fleets gate run --as {shlex.quote(fleet)} --wait {SUITE_WAIT_S} -- {inner}"
    held = _gate_hold(hook.env)
    slot = (f"The slot is held now ({_one_line(held, 120)}), so it waits for it (up to {SUITE_WAIT_S // 60} min). "
            if held else "")
    tokens = _hand_tokens(hook.env, fleet)
    if tokens:
        # Not refused on the name alone: a fleet's sessions share it, and the hold may be another session's.
        frees = "; ".join(f"{shlex.quote(cli)} fleets gate free {t}" for t in tokens)
        slot += (f"Fleet {fleet} holds the slot by hand (token {', '.join(tokens)}), and a gate run never runs under a "
                 f"hold taken by hand, its own fleet's included: when that hold is this session's, free it first with "
                 f"`{frees}`; else the run waits for it like any other. ")
    unclear = (" The hook couldn't tell all that this line runs around the test runner." if any(s.unclear for s in found)
               else "")
    return Deny(f"`{_one_line(what, 80)}` runs a full test suite, and in fleet {fleet} (this machine serves a manager) a "
                f"full suite runs only through the gate slot, in a memory-capped scope that dies whole.{unclear} Run "
                f"it as: `{wrapped}` (Bash timeout {SUITE_TIMEOUT_MS}, or run_in_background: it may queue behind "
                f"another suite). {slot}It exits with the suite's code, except 75: the slot stayed held past --wait "
                f"and the suite never ran; 124: the suite ran past its time and was stopped.")


def shutil_which(name):
    import shutil
    return shutil.which(name)


# 1Password locked (fleet/SPEC.md, "1Password locked"): a failed command that shows 1Password is locked records it once
# for the machine, and until it clears a command of that kind is denied in every fleet's session. The code is
# hooks/tstack-hook-onepw.py, executed into this module only for a call that can matter to it (_onepw): a part is
# compiled from source each time a call reads it (only this module's bytecode is cached), so what a call does not need
# it should not carry. The two handlers below end every other call at a test of its first word, then of a file's
# existence or two fixed strings.
ONEPW_TOOLS = frozenset(("jj", "git", "ssh", "op", "secretspec", "gh", "aws"))
ONEPW_TEXTS = ("sign_and_send_pubkey: signing failed", "[ERROR] ")


# The hook's parts: files beside it that it executes into this module only for a call that needs them, each known as
# read by a name it defines.
PARTS = {"onepw_use": "tstack-hook-onepw.py", "monitor_denial": "tstack-hook-monitor.py"}


def _part(defines):
    """This module's namespace with the part that defines this name in it, read from its file the first time."""
    names = globals()
    if defines not in names:
        path = Path(__file__).resolve().with_name(PARTS[defines])
        exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), names)
    return names


def _onepw():
    """This module's namespace with the 1Password part in it."""
    return _part("onepw_use")


def _monitor():
    """This module's namespace with the Monitor part in it (fleet_monitor_watch)."""
    return _part("monitor_denial")


def __getattr__(name):
    """A name of a part asked of this module from outside, by a test or a script that loads the hook: the parts not
    read yet are read first. Inside the hook nothing comes here: its handlers read their part themselves."""
    if name.startswith("__") or all(defines in globals() for defines in PARTS):
        raise AttributeError(name)
    for defines in PARTS:
        if name in _part(defines):
            return globals()[name]
    raise AttributeError(name)


def _onepw_command(hook):
    """This call's Bash command when its first word can be a tool that uses 1Password, or an assignment before one,
    else None: the cheap test every other call ends at, with no regular expression and no file read."""
    tool_input = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    command = tool_input.get("command") if hook.input.get("tool_name") == "Bash" else None
    first = command.split(None, 1)[:1] if isinstance(command, str) else []
    return command if first and (first[0] in ONEPW_TOOLS or "=" in first[0]) else None


def _onepw_state(env):
    """Whether a state is on disk (REGISTRY/onepw/locked.json), one that reads or not: without one nothing is held and
    nothing can clear."""
    return os.path.exists(fleet_registry(env) / "onepw" / "locked.json")


def _bash_output(data):
    """Everything a Bash call printed, as the event carries it: tool_response's text fields, or the failure's error."""
    parts = []
    for key in ("tool_response", "error"):
        value = data.get(key)
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, dict):
            parts += [v for k, v in value.items() if isinstance(v, str) and k in ("stdout", "stderr", "output", "error")]
    return "\n".join(parts)


def onepw_hold(hook):
    """PreToolUse (Bash): the hold of a command that uses a locked kind of 1Password (_onepw_hold in the part), asked
    only when the first word can be such a tool and a state is on disk."""
    if _onepw_command(hook) is None or not _onepw_state(hook.env):
        return None
    return _onepw()["_onepw_hold"](hook)


def onepw_watch(hook):
    """PostToolUse and PostToolUseFailure (Bash): the detection and the clear of a lock (_onepw_watch in the part),
    asked only when the first word can be such a tool, and a state is on disk (a clear, a join) or the output holds
    a text 1Password's failures all hold (a new lock)."""
    if _onepw_command(hook) is None:
        return None
    if not _onepw_state(hook.env) and not any(text in _bash_output(hook.input) for text in ONEPW_TEXTS):
        return None
    return _onepw()["_onepw_watch"](hook)


HANDLERS = {
    "SessionStart": [memo_wake, jj_hints, tuca_mode, fleet_news, fleet_heartbeat],
    "Stop": [memo_nudge, fleet_listen_guard, fleet_idle_guard, fleet_said_once, fleet_news, fleet_heartbeat],
    "PreCompact": [memo_precompact],
    "PreToolUse": [fleet_agent_grant, fleet_spawn_effort, fleet_moved_writes, land_turn_gate, suite_gate, onepw_hold, fleet_monitor_watch,
                   fleet_grant_alone],
    "PostToolUse": [fleet_heartbeat, fleet_grant_sweep, fleet_refusal_forgotten, fleet_refusal_note, fleet_chat_nudge, onepw_watch],
    "PostToolUseFailure": [fleet_heartbeat, fleet_grant_sweep, onepw_watch],
    "PermissionDenied": [fleet_permission_denied],
    "SubagentStart": [fleet_heartbeat],
    "SubagentStop": [fleet_heartbeat],
}


def _context(event, text):
    return json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}})


def _decide(event, decision, text):
    return json.dumps({"hookSpecificOutput": {"hookEventName": event, "permissionDecision": decision,
                                              "permissionDecisionReason": text}})


EMIT = {
    "PreToolUse": None,  # dispatch decides: a Deny refuses, an Allow allows, a Note is context, nothing else speaks
    "SessionStart": _context,
    "Stop": _context,
    "PreCompact": lambda event, text: text,
    "PostToolUse": _context,
}


def dispatch(event, raw, env):
    """The text to print for this event, or "" for nothing. On Stop, a handler's Block turns the whole
    output into the block decision, whose reason (every handler's text) Claude reads as it goes on. On
    PreToolUse, a handler's Deny refuses the call, with the Deny texts alone as the reason; else an Allow (an Agent
    call the hub granted) allows it; else a Note is context beside the call's result, with no decision; any other
    text decides nothing.
    Under TSTACK_ROLE=tape (a tape builder's own `claude -p` call) no handler runs: no wake lands in the
    compaction prompt, and nothing is written or spawned (docs/design/tape.md, section 4)."""
    if env.get("TSTACK_ROLE") == "tape":
        return ""
    data = json.loads(raw) if raw.strip() else {}
    if not isinstance(data, dict):
        raise ValueError("hook input is not a JSON object")
    hook = Hook(event, data, env)
    parts, denials, allows, notes = [], [], [], []
    blocked = False
    for handler in HANDLERS.get(event, ()):
        try:
            text = handler(hook)
        except Exception:  # one handler failing does not take the others down
            log(hook.data_dir, f"{event} {handler.__name__} failed\n{traceback.format_exc()}")
            continue
        if text and text.strip():
            parts.append(text.strip())
            blocked = blocked or isinstance(text, Block)
            if isinstance(text, Deny):
                denials.append(text.strip())
                hook.denied = True
            if isinstance(text, Allow):
                allows.append(text.strip())
            if isinstance(text, Note):
                notes.append(text.strip())
    if not parts or event not in EMIT:
        return ""
    if denials and event == "PreToolUse":
        return _decide(event, "deny", "\n\n".join(denials))
    if event == "PreToolUse":
        if allows:
            return _decide(event, "allow", "\n\n".join(allows))
        return _context(event, "\n\n".join(notes)) if notes else ""
    if blocked and event == "Stop":
        return json.dumps({"decision": "block", "reason": "\n\n".join(parts)})
    return EMIT[event](event, "\n\n".join(parts))


def main(argv, stdin, stdout, env):
    started = time.perf_counter()
    event = argv[1] if len(argv) > 1 else ""
    data_dir = Path(env.get("CLAUDE_PLUGIN_DATA") or Path(env.get("XDG_STATE_HOME")
                    or Path(env.get("HOME", "/tmp")) / ".local" / "state") / "tstack")
    try:
        out = dispatch(event, "" if stdin.isatty() else stdin.read(), env)
        if out:
            stdout.write(out + "\n")
            stdout.flush()
        if env.get("TSTACK_HOOK_DEBUG"):
            log(data_dir, f"{event} ok {(time.perf_counter() - started) * 1000:.0f} ms, {len(out)} chars")
    except BaseException:  # noqa: BLE001 - never break a session
        log(data_dir, f"{event} dispatcher failed\n{traceback.format_exc()}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv, sys.stdin, sys.stdout, os.environ))
