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
import signal
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
        with open(path, "a", encoding="utf-8", errors="backslashreplace") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {text.rstrip()}\n")
    except (OSError, ValueError):
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


def user_manager_runs(run):
    """Whether this user's systemd user manager serves the runtime dir run: its own socket, systemd/private, is
    a socket and ours. A bus alone is not enough: dbus runs without systemd --user (a container, dbus-launch), and after
    `su` the runtime dir is another user's; there systemd-run fails before it starts the build, and the hook,
    which never waits on it, could not see that."""
    import stat
    try:
        private = (run / "systemd" / "private").stat()
    except OSError:
        return False
    return stat.S_ISSOCK(private.st_mode) and private.st_uid == os.getuid()


def tape_build(hook):
    """SessionStart: start `tape build --on-start` for the session's project and return without waiting
    (docs/design/tape.md, Phase 2). Only once tape is in use on the machine (its index.db, left by a first
    `tape build`) and for a cwd in a jj or git repo (memo's rule, tape's too), never for a worker or a headless
    run. tape owns the rest: `build_on_start = false` in tape.toml
    makes it a no-op, and the project's flock keeps it to one build at a time. The build runs in a session of its
    own, out of the hook's process group, and in a user scope of its own where systemd has one, out of the
    session's; it runs at nice 10, capped at 2G in that scope; its output goes nowhere, so nothing holds the
    hook's pipes.
    Right after it, the same way but in a scope of its own, it starts `memo-dream run`, the note proposer: that keeps
    its own pilot list and once-a-day rule and waits on the build's lock itself, so the hook only starts it."""
    if hook.is_worker or hook.headless:
        return None
    if not memo().tape_index(hook.env).exists() or memo().resolve_project(hook.cwd) is None:
        return None
    import shutil
    import subprocess
    run = Path(hook.env.get("XDG_RUNTIME_DIR") or "/nonexistent")
    scope = (run / "bus").exists() and user_manager_runs(run) and shutil.which("systemd-run", path=hook.env.get("PATH"))
    for script, *args in (("tape", "build", "--on-start"), ("memo-dream", "run")):
        argv = [sys.executable, str(ROOT / "scripts" / script), *args, "--cwd", hook.cwd]
        if scope:
            argv = ["systemd-run", "--user", "--scope", "--collect", "--quiet", "-p", "MemoryMax=2G", "--", *argv]
        subprocess.Popen(argv, env=dict(hook.env), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, preexec_fn=lambda: os.nice(10))
    return None


DREAM_LINE = "memo-dream: {n} candidate notes wait for Luiz (`{bin} pending`, from any directory)."


def memo_dream_pending(hook):
    """SessionStart: one line for a session that hosts a fleet when memo-dream's drafted notes wait for Luiz,
    counted over every project's unanswered batches. It reads the batch files memo-dream writes
    ($XDG_STATE_HOME/tstack/memo-dream/<owner>__<repo>/<date>.json) and nothing else: no model, no import."""
    if hook.is_worker or hook.headless or not hosted_fleets(hook):
        return None
    base = Path(hook.env.get("XDG_STATE_HOME") or Path(hook.env.get("HOME", "/tmp")) / ".local" / "state")
    n = 0
    for path in (base / "tstack" / "memo-dream").glob("*/????-??-??.json"):
        try:
            batch = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(batch, dict) and not batch.get("answer") and isinstance(batch.get("candidates"), list):
            n += len(batch["candidates"])
    return DREAM_LINE.format(n=n, bin=ROOT / "scripts" / "memo-dream") if n else None


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
- Coordinator mindset: delegate what a fresh window does as well, in the background; each subagent's role in docs/models.md sets its model and effort (Fable only for one decisive agent, never fan-out); you own their output.
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


class Block(str):
    """What a Stop handler returns to keep the turn going: the text becomes the block's reason."""


def read_ledger(d):
    """DIR/state.json as a dict, or None when it is missing or does not parse."""
    try:
        with open(os.path.join(d, "state.json"), "rb") as f:
            ledger = json.loads(f.read())
    except (OSError, ValueError):
        return None
    return ledger if isinstance(ledger, dict) else None


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


def blocked_program(text, worker):
    """An important `blocked` event for the fleet's host, of worker when the ledger knows the caller."""
    options = {"important": True, **({"agent": worker} if worker else {})}
    return fleet_program(f"event(\"blocked\", {_js(text)}, {_js(options)})")


def _js(value):
    """A value as a JS literal: JSON, ASCII-escaped so no line separator ends a string."""
    return json.dumps(value, ensure_ascii=True)


class Unapplied(RuntimeError):
    """The fleet ran the hook's program and did not apply an op of it (refused, or a clash)."""


class Unsure(RuntimeError):
    """fleet-run sent the program and no answer came back, nor for its resend: it may have landed."""


def fleet_run(hook, d, program):
    """Run a program against the moved fleet at d. Its outcome, completed or queued (a card waits for the link);
    RuntimeError when the service is down or the program failed (Unsure when it was sent and no answer came back), Unapplied when the fleet did not apply an op, and
    subprocess.TimeoutExpired past CLI_TIMEOUT_S. That is 25 s, and the client waits 120 s for the service: the client
    is the fleet repo's (apps/client/fleet-run.ts) and reads no timeout from its environment, so the hook kills it
    first, accepted. A program the service still runs after the kill may land: the caller treats it as not told."""
    import subprocess
    cli = fleet_run_cli(hook.env)
    # The client sends $FLEET_SESSION as the program's `from`: this hook's session, never one left in the environment.
    env = {**hook.env, "FLEET_DIR": d, **({"FLEET_SESSION": hook.session_id} if hook.session_id else {})}
    done = subprocess.run([cli], input=program, capture_output=True, text=True, env=env,
                          cwd=d, check=False, timeout=CLI_TIMEOUT_S)
    unknown = done.returncode == FLEET_RUN_UNKNOWN
    if unknown:
        # Sent, and no answer came back: the same program again under its id runs at most once (round H).
        sent = _json_object(done.stdout)
        if isinstance(sent.get("id"), str) and re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{26}", sent["id"]):
            done = subprocess.run([cli, "--id", sent["id"]], input=program, capture_output=True, text=True, env=env,
                                  cwd=d, check=False, timeout=CLI_TIMEOUT_S)
    if done.returncode not in (0, FLEET_RUN_QUEUED):
        raise (Unsure if unknown else RuntimeError)(f"{cli} exited {done.returncode}: {(done.stderr or done.stdout).strip()[:500]}")
    try:
        outcome = json.loads(done.stdout)
    except ValueError:
        raise RuntimeError(f"{cli} printed no outcome: {done.stdout.strip()[:300]}") from None
    results = outcome.get("ops") if isinstance(outcome, dict) else None
    unapplied = [r for r in results or [] if isinstance(r, dict) and r.get("_tag") not in ("applied", "duplicate")]
    if unapplied:
        raise Unapplied(f"{cli}: the fleet did not apply the hook's op: {json.dumps(unapplied[0])[:500]}")
    return outcome


def _moved_served_dirs(hook, dirs):
    """The ledgers' home folders this session served that have since moved to the cloud and are not among dirs: the
    cut-over's `fleet serve --stop` removes the registry entry and the folder is outside the scratchpad, so neither
    fleet_dirs nor served_by_session finds it, and a moved coordinator would end its turns deaf."""
    seen = {os.path.realpath(d) for d in dirs}
    return [d for d in _served_dirs(hook) if moved(d) and os.path.realpath(d) not in seen
            and os.path.isfile(os.path.join(d, "state.json"))]


def _one_line(text, size):
    flat = " ".join(str(text).split())
    return flat if len(flat) <= size else flat[:size] + "…"


CLI_TIMEOUT_S = 25


def _refused_worker(ledger, agent_id, env):
    """The worker row of the refused caller: the agents row whose task_id is the harness's agent id,
    else $FLEET_WORKER, else None (the session's main thread)."""
    agents = ledger.get("agents") if isinstance(ledger.get("agents"), list) else []
    for row in agents:
        if agent_id and isinstance(row, dict) and row.get("task_id") == agent_id and isinstance(row.get("id"), str):
            return row["id"]
    return env.get("FLEET_WORKER") or None


def _option(flag, value):
    """One option's argv words; a value the CLI's parser would read as a flag is joined to it."""
    value = str(value)
    return [f"{flag}={value}"] if value.startswith("-") and " " not in value else [flag, value]


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


def _shell_command(hook):
    """The command of a Bash or Monitor call: Monitor runs its command under Bash's permission rules."""
    tool_input = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    command = tool_input.get("command") if hook.input.get("tool_name") in ("Bash", "Monitor") else None
    return command if isinstance(command, str) else None


class Deny(str):
    """What a PreToolUse handler returns to refuse the call: the text becomes the denial's reason."""


class Allow(str):
    """What a PreToolUse handler returns to allow the call: only fleet_agent_grant, for an Agent call the office host granted
    once. Any other PreToolUse text decides nothing."""


class Note(str):
    """What a PreToolUse handler returns to tell Claude something beside the call's result (additionalContext): it
    decides nothing, so the permission check runs as it would have."""


def hosted_fleets(hook):
    """The fleets this session serves as their coordinator or manager: the one $FLEET_DIR names, else those of its
    scratchpad the registry records under this session. None for a worker launched as a process of its own, whose
    effort is its launch's; a subagent's call counts, since it runs in the session that serves."""
    if hook.env.get("FLEET_WORKER") or hook.env.get("TSTACK_ROLE") == "worker":
        return []
    dirs = fleet_dirs(hook)
    return dirs if hook.env.get("FLEET_DIR") else [d for d in dirs if served_by_session(hook, d)]


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


def _unwrap(words, once=False):
    """The command a wrapper runs: past assignments, env [-i] [K=V], timeout N, nice, command, exec, nohup,
    time, devenv-run and `nix shell|develop ... --command`; past one of them when `once`. (words, whether it reads its
    arguments from stdin)."""
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
        if once:
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
    read, asks land-check's turn (`fleet turn`, which finds the fleet by the session's process, else by $FLEET_DIR: a
    session with none set is given the folder of the moved fleet it serves, which no registry entry names). In a fleet
    whose machine serves a manager and that does not hold the turn, the push is denied; Luiz's approval to
    push answers whether it may land, the turn when. Outside a managed fleet, and for any other push, it says
    nothing. A manager moved to the cloud that could not be read denies too (`fleet turn` refuses, as its folder can
    be behind the turn just taken back). When the fleet CLI cannot run, the push goes through with a warning: a broken
    hub never blocks every push."""
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
    moved_dir = None if hook.env.get("FLEET_DIR") else next(iter(_moved_served_dirs(hook, [])), None)
    env = {**hook.env, "FLEET_DIR": moved_dir} if moved_dir else None
    turn = lc.landing_turn(cli, timeout=timeout, env=env)
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
    onto = f"onto {', '.join(sorted(landing))}" if landing else "(a push it could not read)"
    unclear_line = f" Also, {UNCLEAR}." if landing and unclear else ""
    if " does not hold" not in said:  # the manager's cloud could not be read and the folder alone says yes
        fleet = said.split(" cannot confirm", 1)[0] if " cannot confirm" in said else "this fleet"
        _log_denial(hook, lc, cli, moved_dir, f"Push gate: refused `{_one_line(command, 120)}`: {fleet} could not confirm "
                                   f"the landing turn {onto}")
        return Deny(f"{what}, and its landing turn could not be confirmed (fleet turn: {said}){'' if said.endswith('.') else '.'} "
                    f"Luiz's approval to push doesn't replace it, and nothing else lifts it.{unclear_line}")
    fleet = said.split(" does not hold", 1)[0]
    _log_denial(hook, lc, cli, moved_dir, f"Push gate: refused `{_one_line(command, 120)}`: {fleet} does not hold the landing "
                               f"turn {onto}")
    return Deny(f"{what}, and {fleet} doesn't hold the landing turn (fleet turn: {said}). Ask the manager for it as "
                f"that says, wait for its answer, and check with `{cli} turn` before pushing again. Luiz's approval "
                f"to push doesn't skip the queue: it answers whether this may land, the turn answers when.{unclear_line}")


# Luiz's rule (fleet decision D585, 2026-10-29): no commit he publishes carries an agent's attribution. Only real
# trailers count, so a description that quotes the rule in prose still pushes.
GENERATED_LINE = re.compile(r"^(?:\U0001f916 ?)?Generated with (?:\[Claude Code\]\([^)\s]*\)|Claude Code)\s*$")
JJ_PUSH_TARGET = re.compile(r"^\s*bookmark: \S+ \[(?:add to|move (?:forward|backward|sideways) from \S+ to) ([0-9a-f]+)\]",
                            re.M)
# Each call's own cap: the hook's 30 s are shared with land_turn_gate, and this guard only reads local state.
ATTRIBUTION_TIMEOUT_S = 3
JJ_TRAILERS = ('json(change_id.short()) ++ "\\t" ++ json(description) ++ "\\t[" '
               '++ trailers.map(|t| json(t.key()) ++ "," ++ json(t.value())).join(",") ++ "]\\n"')


def attribution_lines(description, trailers):
    """The attribution lines of a commit: a Claude-Session: trailer, a Co-Authored-By: trailer naming Claude (both
    from `trailers`, the (key, value) pairs jj or git parse out of its last paragraph), and a whole
    "Generated with Claude Code" line in its last two paragraphs."""
    found = [f"{key}: {value}" for key, value in trailers
             if key.lower() == "claude-session" or (key.lower() == "co-authored-by" and re.search(r"\bClaude\b", value))]
    paragraphs = re.split(r"\n[ \t]*\n", description.strip("\n"))
    return found + [line.rstrip() for p in paragraphs[-2:] for line in p.splitlines() if GENERATED_LINE.match(line)]


def _run_out(argv, cwd, stderr=False):
    """The command's stdout (and its stderr after it, with `stderr`), or None when it fails or hangs."""
    import subprocess
    try:
        r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=ATTRIBUTION_TIMEOUT_S,
                           env={**os.environ, "JJ_EDITOR": "true", "EDITOR": "true", "GIT_TERMINAL_PROMPT": "0"})
    except (OSError, subprocess.TimeoutExpired):
        return None
    return (r.stdout + (r.stderr if stderr else "")) if r.returncode == 0 else None


def _jj_pushed(push):
    """(change id, attribution lines) of each commit the jj push sends, from its dry run (local): every commit under a
    target that no bookmark of the remote holds yet. None when the hook cannot tell, and for a remote that holds no
    bookmark yet (a new fork), whose range would be the whole history."""
    repo = _jj_repo(push.args, push.cwd)
    said = _run_out(["jj", *push.args, "--dry-run"], push.cwd, stderr=True)
    if said is None or repo is None:
        return None
    remote = re.search(r"^Changes to push to (\S+):", said, re.M)
    targets = JJ_PUSH_TARGET.findall(said)
    if remote is None or not targets:
        return []
    held = f"remote_bookmarks(remote=exact:{json.dumps(remote.group(1))})"
    jj = ["jj", "-R", repo, "--ignore-working-copy", "log", "--no-graph"]
    if not _run_out([*jj, "-r", held, "--limit", "1", "-T", '"x"'], repo):
        return None
    log = _run_out([*jj, "-r", f"::({'|'.join(targets)}) ~ ::{held}", "-T", JJ_TRAILERS], repo)
    if log is None:
        return None
    out = []
    for line in log.splitlines():
        change, description, pairs = (json.loads(part) for part in line.split("\t", 2))
        out.append((change, attribution_lines(description, list(zip(pairs[::2], pairs[1::2])))))
    return out


def _git_sources(push, repo):
    """(the remote a `git push` writes to, the local revisions it sends), read from its words and the repo's config,
    without asking the remote; None when the hook cannot tell."""
    _, i, _ = _git_sub(push.args, push.cwd)
    positionals, every, args, j = [], False, push.args[i + 1:], 0
    while j < len(args):
        a = args[j]
        if a in ("-d", "--delete"):
            return "", []
        if a in ("--mirror", "--prune", "--repo") or a.startswith("--repo="):
            return None
        if a in ("--all", "--branches"):
            every = True
        elif a in GIT_PUSH_VALUED:
            j += 1
        elif not a.startswith("-"):
            positionals.append(a)
        j += 1

    def git(*argv):
        return (_run_out(["git", "-C", repo, *argv], repo) or "").strip() or None

    def config(key):
        return git("config", "--get", key)

    branch = git("symbolic-ref", "--short", "-q", "HEAD")
    remote = positionals[0] if positionals else (
        (config(f"branch.{branch}.pushRemote") or config(f"branch.{branch}.remote")) if branch else None
    ) or config("remote.pushDefault") or "origin"
    refspecs = positionals[1:]
    if every:
        return remote, ["--branches"]
    if not refspecs:
        if config(f"remote.{remote}.push") or config("push.default") in ("matching", "nothing"):
            return None
        return remote, ["HEAD"] if branch else []
    sources = []
    for spec in refspecs:
        src = spec.lstrip("+").partition(":")[0]
        if "*" in src or spec == "tag":
            return None
        if src:
            sources.append(src)
    return remote, sources


def _git_pushed(push):
    """(commit id, attribution lines) of each commit the git push sends, worked out locally: every commit under a
    pushed source that no remote-tracking ref holds. None when the hook cannot tell, and for a URL, a path or a remote
    with no tracking ref yet (a new fork)."""
    repo = _git_sub(push.args, push.cwd)[2]
    read = _git_sources(push, repo) if repo is not None else None
    if read is None:
        return None
    remote, sources = read
    if not sources:
        return []
    if any(c in remote for c in ":/") or remote.startswith(".") or not _run_out(
            ["git", "-C", repo, "for-each-ref", "--count=1", "--format=x", f"refs/remotes/{remote}/"], repo):
        return None
    log = _run_out(["git", "-C", repo, "log", "--format=%H%x00%B%x00%(trailers:only,unfold)%x01", *sources,
                    "--not", "--remotes", "--"], repo)
    if log is None:
        return None
    out = []
    for entry in log.split("\1"):
        commit, _, rest = entry.strip("\n").partition("\0")
        if commit:
            body, _, trailers = rest.partition("\0")
            pairs = [(k.strip(), v.strip()) for k, _, v in (t.partition(":") for t in trailers.splitlines()) if v]
            out.append((commit[:12], attribution_lines(body, pairs)))
    return out


def push_attribution(hook):
    """PreToolUse (Bash): a `jj git push` or `git push` that sends a commit whose description carries an
    attribution trailer is denied, naming each such change and how to re-describe it. A push the hook cannot read,
    or whose range it cannot work out, goes through: this guard never blocks a push by failing."""
    tool_input = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    command = tool_input.get("command") if hook.input.get("tool_name") == "Bash" else None
    if not isinstance(command, str) or not PUSH_IN_TEXT.search(command):
        return None
    found = {}
    try:
        for push in Reader().pushes(command, hook.cwd):
            if push.unclear or push.tool not in ("jj", "git"):
                continue
            for change, lines in (_jj_pushed if push.tool == "jj" else _git_pushed)(push) or []:
                if lines:
                    found.setdefault(change, lines)
    except Exception:  # noqa: BLE001 - a range it cannot work out lets the push through, unlike the other guards
        log(hook.data_dir, f"{hook.event} push_attribution let a push through\n{traceback.format_exc()}")
        return None
    if not found:
        return None
    listed = "; ".join(f"{change} ({_one_line(' | '.join(lines), 120)})" for change, lines in found.items())
    first = next(iter(found))
    return Deny(f"This push sends {len(found)} commit{'s' if len(found) > 1 else ''} whose description carries an "
                f"attribution trailer: {listed}. Luiz's rule (fleet decision D585): no commit carries a Claude-Session: "
                f"trailer, a Co-Authored-By: trailer naming Claude, or a \"Generated with Claude Code\" line. Re-describe "
                f"each without it "
                f"(`jj describe -r {first} -m \"<the message without it>\"`, and the same for the others), then push again.")


def _detached(hook, work):
    """Run work() in a process of its own that keeps none of the hook's pipes, and return at once. Claude Code reads a
    hook's output when the hook exits, so printing first and working on would not help: only an exit gets it read. A
    child it did not start and that holds no pipe of its is no part of the hook."""
    try:
        if os.fork():
            return
    except OSError as e:
        log(hook.data_dir, f"{hook.event} could not start a process of its own: {e}")
        return
    try:
        os.setsid()
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null, fd)
        work()
    except BaseException:  # noqa: BLE001 - nobody is left to tell
        log(hook.data_dir, f"{hook.event} detached work failed\n{traceback.format_exc()}")
    finally:
        os._exit(0)


def _log_denial(hook, lc, cli, given, text):
    """The denial as an important `blocked` event in the fleet's ledger (land-check's find_ledger: given, the moved
    fleet's folder the gate named, else $FLEET_DIR, else the served fleet among the session's processes; else the
    session's own fleet folder). The ledger is found here, as the session's processes are this one's parents, and
    written by a detached process: the write can take 50 s (two fleet-run calls of CLI_TIMEOUT_S), and past the hook's
    30 s Claude Code discards its output and runs the call, so a denial waiting on its log is a push let through."""
    found = lc.find_ledger(given)
    dirs = [str(found.parent)] if found else fleet_dirs(hook)[:1]
    if dirs:
        _detached(hook, lambda: _write_denial(hook, cli, dirs, text))


def _write_denial(hook, cli, dirs, text):
    import subprocess
    for d in dirs:
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
# `--lf`, `cargo test NAME`, `go test -run X`) is left alone; `.`, `./` and a `find -exec`'s `{}` name every file, a
# `--cov SRC` its coverage source, so neither scopes a run. Reading follows the push gate's: redirections, wrappers,
# `cd`, `-C`, `sh -c`; a test runner the hook cannot read (eval, xargs, a substitution) counts as a full suite. A script
# it reads is judged by the words of each test runner it names (SuiteReader._script_runs): one whose words it cannot
# read is a suite it cannot tell (unsure), and the deny says so rather than call it a full one.
Suite = namedtuple("Suite", "what unclear unsure", defaults=(False,))
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
STDERR_MOVED = re.compile(r"2(?:>>?|<>|<&)(?![ \t]*/dev/null\b)|\|&|&>|>&(?![ \t]*\d)|\bexec\b[^\n;|&]*[<>]")
# On a line with a stderr move, what lets the move take an echo on another line: a shell, eval, source or exec that
# runs code, a here-document, and (before the move, past any `${...}`) a block's closer.
MOVE_RUNS = re.compile(rf"(?<![\w.$-])(?:{'|'.join(sorted(SHELLS))}|eval|source|exec)(?![\w.-])|(?<![^\s;&|{{(])\.(?=\s)|<<")
MOVE_CLOSES = re.compile(r"[})]|\b(?:done|fi|esac)\b")
# A line's stages, the words of one, and what comes before a command's name (keywords, wrappers, the `$` of a `$(`).
MOVE_STAGE = re.compile(r"\|&|\|\|?|&&|;|\n|(?<![<>])&(?!>)|\(|\)|\{|\}")
MOVE_TARGET = re.compile(r"(?<![<>&\d])\d*(?:&>>?|>>?|>\||<>)(?!&)[ \t]*((?:\"[^\"]*\"|'[^']*'|[^\s;&|<>()])+)")
MOVE_TAKERS = SHELLS | {"eval", "source", ".", "exec", "xargs"}
MOVE_WORD = re.compile(r"(?:\"[^\"]*\"|'[^']*'|[^\s\"'])+")
MOVE_SKIPPED = {"!", "if", "then", "do", "while", "until", "elif", "else", "time", "command", "builtin", "env", "timeout",
                "nohup", "nice", "stdbuf", "setsid", "sudo", "$"}
# What may share a command line that moves the stderr of a script it runs and still leave the script's echoes out
# (_outer_carries): commands that only read, count or show what they are given, and tee into files. A sink's word that
# makes it run a program (rg --pre, sort --compress-program or a prefix of it, less +cmd) makes it no sink.
OUTER_SINKS = {"tail", "head", "grep", "egrep", "fgrep", "rg", "wc", "sort", "uniq", "cut", "cat", "less", "tee"}
SINK_RUNS = {"rg": re.compile(r"--pre"), "sort": re.compile(r"--co"), "less": re.compile(r"\+")}
FUNCTION_DEF = re.compile(r"([ \t]*)(?:function[ \t]+([\w:.-]+)(?:[ \t]*\(\))?|([\w:.-]+)[ \t]*\(\))")
# A script that runs the command it is given (`exec "$@"`) is a launcher: the line runs the launcher's arguments.
LAUNCHES_ARGS = re.compile(r"\$\{?[@*]\}?")
# Where a test runner a script names ends its words (SuiteReader._script_runs): a quote, an operator, a redirection.
SCRIPT_RUNNER_END = re.compile(r"[\n;&|()<>\"'`]")
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
PYTEST_OPTIONAL = {"--cov"}  # takes the word after it as its value unless that word is an option (pytest-cov's nargs="?")
PYTEST_SCOPES = {"-k", "--lf", "--last-failed"}
CARGO_TEST_VALUED = {"--manifest-path", "--features", "-F", "--target", "--target-dir", "-j", "--jobs", "--profile",
                     "--message-format", "--color", "--config", "-Z", "--test", "--bench", "--example", "--bin"}
JUST_VALUED = {"-f", "--justfile", "-d", "--working-directory", "--set", "--shell", "--shell-arg", "--dotenv-filename",
               "--dotenv-path", "--color", "--command-color", "--chooser", "--list-heading", "--list-prefix"}
TEST_FILE = re.compile(r"(\.|_)(test|spec)\.[cm]?[jt]sx?$|^test_.*\.py$|_test\.py$|\.py$")
# The commands SuiteReader.command reads by name (pinned by a test). Called by the path of an installed runner's shim
# (_installed), its verdict stands: the shim's text names the runner, it is not a script to read for tests.
RUNNERS = {"npx", "bunx", "pnpx", "uvx", "uv", "poetry", "pipenv", "hatch", "pdm", "rye", "gates", "pnpm", "npm",
           "yarn", "bun", "vitest", "vp", "pytest", "py.test", "cargo", "go", "just", "node", "find"}
# Words where a runner's file arguments go that name no file of their own: the directory it runs in, and the `{}` that
# `find -exec` fills with every file it finds.
EVERY_FILE = {".", "./", "{}"}
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


def _file_args(pos):
    """The positionals that name files or tests: pos past EVERY_FILE and the `+` or `;` that ends a `find -exec` at `{}`."""
    return [p for i, p in enumerate(pos) if p not in EVERY_FILE and not (p in ("+", ";") and pos[i - 1:i] == ["{}"])]


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


def _uncommented(code, structured=True, outside=None):
    """Shell code with its comments left out: from a `#` that starts a word outside quotes to the end of its line.
    A here-document's body is copied as it is, with no quotes read in it; a `$(` ... `)` inside double quotes is a
    level of its own, where quotes start fresh. Unstructured, it reads quotes alone: no here-documents, no `$(` levels.
    Given a set as outside, it adds the offset of each line start that is outside any quote and here-document body."""
    out, quote, i, nested, heredocs = [], None, 0, [], []
    while i < len(code):
        c = code[i]
        if outside is not None and quote is None and code[i - 1:i] == "\n":
            outside.add(i)
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
    its echoes print. A body opens on its definition's line or, when nothing follows the `()`, on the next line that
    holds anything (`{` alone); it is that line when it closes what it opens, else it runs to the first line that
    starts with the opener's closer (`}` for `{`, `)` for `(`) indented no deeper than the definition."""
    bodies = []
    for i, line in enumerate(lines):
        if not (m := FUNCTION_DEF.match(line)):
            continue
        j, head = i, line[m.end():]
        if not head.strip():
            j = next((k for k in range(i + 1, len(lines)) if lines[k].strip()), i)
            head = lines[j] if j > i else head
        end = j
        if sum(map(head.count, "{(")) > sum(map(head.count, "})")):
            close = ")" if head.lstrip()[:1] == "(" else "}"
            end = next((k for k in range(j + 1, len(lines)) if lines[k].lstrip()[:1] == close
                        and len(lines[k]) - len(lines[k].lstrip()) <= len(m[1])), len(lines) - 1)
        bodies.append((m[2] or m[3], "\n".join(lines[i:end + 1])))
    found = set()
    while new := {name for name, body in bodies if name not in found and (TEST_IN_TEXT.search(body) or any(
            re.search(rf"(?<![\w.-]){re.escape(f)}(?![\w.-])", body) for f in found))}:
        found |= new
    return found


def _move_carries(line):
    """Whether a stage of a script's line (between `|`, `;`, `&&`, `(`, `{` and the like) runs what a stderr move on it
    could hand an echo's words to: a shell, eval, source, exec or xargs (MOVE_TAKERS), a command whose name is computed
    (`$fn`, `"$@"`, `${BASH:-sh}`, `` `cmd` ``), or a file the line writes (`2> run.sh; ./run.sh`). A stage's command
    is its first word past assignments, redirects, keywords and wrappers such as `env` or `timeout` and their options.
    No operator inside quotes splits a stage."""
    line = re.sub(r"""(?:"(?:[^"\\$`\n]|\\.|\$(?!\())*"|'[^'\n]*')""", lambda m: re.sub(r"[|&;(){}<>]", "_", m[0]),
                  re.sub(r"\$\{[^}\n]*\}", "$x", line))
    written = {t.strip("\"'").removeprefix("./") for t in MOVE_TARGET.findall(line)}
    for stage in MOVE_STAGE.split(line):
        rest = iter(MOVE_WORD.findall(stage))
        for word in rest:
            if (word in MOVE_SKIPPED or re.fullmatch(r"\w+(?:\[[^]]*\])?\+?=.*|-.*|\d[\w.]*", word, re.S)
                    or re.fullmatch(r"\d*(?:[<>]{1,2}|&>>?|[<>]&)", word) and next(rest, None) is not None
                    or re.fullmatch(r"\d*(?:[<>]{1,2}|&>>?|[<>]&)\S+", word)):
                continue
            name = word.strip("\"'")
            if re.search(r"[$`]", word) or os.path.basename(name) in MOVE_TAKERS or name.removeprefix("./") in written:
                return True
            break
    return False


def _outer_carries(text, segments, stage):
    """Whether a command line that moves stderr could hand on what the script run by its stage (an index into its
    _segments) echoes: unless every other stage is a sink (OUTER_SINKS) and no file it writes, by a redirect or tee,
    is named anywhere else in it (`2>> x.sh` into the running script, `2> h; sh < h`), it could. An escaped quote, a
    `$(`, a backtick or a process substitution anywhere in it, or a written name that is not a plain word (a quote, `$`,
    a glob, `~`), could too."""
    if re.search(r"\\[\"']|[<>$]\(|`", text):
        return True
    neutral = re.sub(r"""(?:"[^"\n]*"|'[^'\n]*')""", lambda m: re.sub(r"[|&;(){}<>]", "_", m[0]), text)
    written = MOVE_TARGET.findall(neutral)
    for part in MOVE_STAGE.split(neutral):
        words = MOVE_WORD.findall(part)
        tee = next((i for i, w in enumerate(words) if w.strip("\"'") == "tee"), len(words))
        written += [w for w in words[tee + 1:] if re.search("[\"']", w)]
    for k, (words, _) in enumerate(segments):
        if k == stage:
            continue
        if words[0] not in OUTER_SINKS or any(SINK_RUNS[words[0]].match(w) for w in words[1:] if words[0] in SINK_RUNS):
            return True
        if words[0] == "tee":
            written += [w for w in words[1:] if not w.startswith("-")]
    names = [os.path.basename(w) for w in written]
    plain = re.sub(r"[\"'\\]", "", text)
    return any(re.search(r"[$`*?[{~\"'\\]", n) or not n or len(re.findall(rf"(?<![\w.-]){re.escape(n)}(?![\w.-])", plain))
               > names.count(n) for n in names)


def _stderr_carried(text):
    """Whether a stderr move in the script, outside its whole-line comments, could take what an echo on any line
    prints to stderr: an exec, shell, eval, source or here-document on its line (MOVE_RUNS), a block's closer before
    it (MOVE_CLOSES), a stage that takes it (_move_carries), a call of a function that names a runner
    (_runner_functions), or a line that a `\\` continues or that starts inside a quote or a here-document. A move that
    takes only an outside command's stderr (`psql ... 2> err`, `lint 2>&1 | redact`) takes no echo's."""
    lines, start, functions, outside = text.split("\n"), 0, None, None
    for i, line in enumerate(lines):
        at, start = start, start + len(line) + 1
        if line.lstrip().startswith("#") or not (move := STDERR_MOVED.search(line)):
            continue
        if functions is None:
            functions, outside = _runner_functions(lines), {0}
            _uncommented(text, outside=outside)
        if (MOVE_RUNS.search(line) or MOVE_CLOSES.search(re.sub(r"\$\{[^}\n]*\}", "$x", line[:move.start()]))
                or _move_carries(line) or any(re.search(rf"(?<![\w.-]){re.escape(f)}(?![\w.-])", line) for f in functions)
                or (i and lines[i - 1].endswith("\\")) or at not in outside):
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

    def suites(self, command, cwd, unclear=False, depth=0, taken=False):
        """The suites a command line runs. taken: a command line around this one moves stderr where it could run what
        an echo prints (_outer_carries), so no script it runs has its echoes left out; a `$(` ... `)` in a line that
        moves stderr anywhere is taken, its output being the line's to use."""
        text = _strip_heredocs(command)
        moves = bool(STDERR_MOVED.search(text))
        out = []
        if depth < 4:
            for sub in _substitutions(text):
                out += self.suites(sub, cwd, True, depth + 1, taken or moves)
        try:
            segments = _segments(text)
        except ValueError:
            return out + ([Suite("a command the hook cannot parse", True, True)] if TEST_IN_TEXT.search(text) else [])

        def takes(stage):
            return taken or moves and _outer_carries(text, segments, stage)
        for stage, (words, nesting) in enumerate(segments):
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
                out += self.suites(" ".join(words[1:]), cwd, True, depth + 1, takes(stage))
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
                    out += self.suites(code, cwd, unclear or stdin, depth + 1, takes(stage))
                else:
                    files = [w for w in words[1:] if not w.startswith("-")]
                    runs = files and cwd and self._script_runs(
                        self._script_code(os.path.join(cwd, files[0]), True, takes(stage)), depth)
                    if runs:
                        out.append(Suite(" ".join(words), True, runs == "unsure"))
            elif name in ("source", ".") and len(words) > 1:
                runs = cwd and self._script_runs(self._script_code(os.path.join(cwd, words[1]), True, takes(stage)), depth)
                if runs:
                    out.append(Suite(" ".join(words), True, runs == "unsure"))
            else:
                found = self.command(words, cwd, depth)
                if found:
                    out.append(Suite(found, unclear or stdin or nesting > 0))
                elif ("/" in words[0] or words[0].endswith(SCRIPT_SUFFIXES)) and cwd \
                        and not ((name in RUNNERS or re.fullmatch(r"python[\d.]*", name))
                                 and _installed(_path(cwd, words[0]) or words[0])):
                    code = self._script_code(_path(cwd, words[0]) or "", taken=takes(stage))
                    runs = self._script_runs(code, depth)
                    if runs:
                        out.append(Suite(" ".join(words), True, runs == "unsure"))
                    elif code is not None and LAUNCHES_ARGS.search(code) and len(words) > 1 and depth < 4:
                        import shlex
                        inner = self.suites(shlex.join(words[1:]), cwd, False, depth + 1, takes(stage))
                        if inner:
                            out.append(Suite(" ".join(words), unclear or stdin or nesting > 0
                                             or any(s.unclear for s in inner)))
        return out

    @staticmethod
    def _script_code(path, by_shell=False, taken=False):
        """The code of the shell script at path, its comments left out, three times: with its whole-line comments
        left out; read for quotes (_uncommented), which copies here-document bodies as they are; and read for quotes
        alone, with no here-documents or `$(` levels. Each view can misread (a stray quote in a `<<\\EOF` body, a `<<`
        taken for a here-document), so a pattern found in any counts; the words a plain echo or printf prints are blanked
        in each (ECHOED) when it prints to stderr and no stderr move, in the script (_stderr_carried) or in the command
        line that runs it (taken), could take them, so a runner named only there, in every view, counts in none; the script is
        read for moves only when the blanking leaves no runner. None when it cannot be read or is no shell
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
        if taken or not TEST_IN_TEXT.search(code):
            return code
        blanked = ECHOED.sub(lambda m: m[1] + m[2] + (re.sub(r"\S", " ", m[3]) if ">&2" in m[2] + m[4] else m[3]), code)
        return code if TEST_IN_TEXT.search(blanked) or _stderr_carried(text) else blanked

    def _script_runs(self, code, depth):
        """What the test runners a script's code names run, each read by its own words: from its name up to a quote,
        an operator, a redirection or a comment. "full" when one is a whole suite by words that end its command;
        "unsure" when one is a whole suite by words a quote cuts short (`vp test "$1"`, `cmd="vp test"`), or runs
        what a word the hook cannot read names (a `$`, a backslash); else None: no runner, or each runs the files or
        tests it names, wherever it sits (a line, a string, an echo, a here-document). Read before the call runs, a
        script edited after the check runs as edited: the gate keeps a fleet's own suites from running at once, it
        is no lock against its sessions."""
        if code is None:
            return None
        code, runs = code.replace("\\\n", " "), None
        for m in TEST_IN_TEXT.finditer(code):
            end = SCRIPT_RUNNER_END.search(code, m.start())
            stop = code[end.start()] if end else "\n"
            words = code[m.start():end.start() if end else len(code)].split()
            words = words[:next((i for i, w in enumerate(words) if w.startswith("#")), len(words))]
            if stop in "<>" and words and re.fullmatch(r"\d+|\{\w+\}", words[-1]):
                words.pop()  # `2>&1`: the fd of a redirection, not a word
            if self.command(words, None, depth + 1):
                if stop not in "\"'`":
                    return "full"
                runs = "unsure"
            elif any("$" in w or "\\" in w for w in words):
                runs = "unsure"
        return runs

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
            args = [a for i, a in enumerate(args) if a not in PYTEST_FLAGS
                    and not (i and args[i - 1] in PYTEST_OPTIONAL and not a.startswith("-"))]
            pos, opts = _opts(args, PYTEST_VALUED - PYTEST_FLAGS)
            return None if _file_args(pos) or _filters(opts, PYTEST_SCOPES) else shown
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
        if name == "find":
            at = next((i for i, a in enumerate(args) if a in ("-exec", "-execdir", "-ok", "-okdir")), None)
            run = args[at + 1:] if at is not None else []
            run = run[:next((i for i, a in enumerate(run) if a == ";" or a == "+" and run[i - 1:i] == ["{}"]), len(run))]
            return self.command(run, cwd, depth) if run else None
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
        if _file_args(pos) or any(o == "--changed" or o.startswith("--changed=") or o == "--dir" or o.startswith("--dir=")
                              for o in opts):
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
            return None if _file_args(pos) or _filters(opts, {"-t", "--test-name-pattern"}) else shown
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
    holds = held.get("holds")
    if isinstance(holds, list) and holds and all(isinstance(h, dict) and h.get("pushing") for h in holds):
        return None  # landings waiting for their push keep out only their repositories' landings
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
    one, its own name's included, so a run of that name waits on them. A landing waiting for its push has no pid either,
    but it is no hold by hand: a run passes it, and only its lander should free it. gate.json is one hold, or with
    `v: 2` a summary that carries them in `holds`."""
    from datetime import datetime
    try:
        held = json.loads((fleet_registry(env) / "gate" / "gate.json").read_text())
    except (OSError, ValueError):
        return []
    holds = held.get("holds") if isinstance(held, dict) and isinstance(held.get("holds"), list) else [held]
    tokens = []
    for hold in holds:
        if not isinstance(hold, dict) or hold.get("pid") is not None or hold.get("pushing") \
                or hold.get("fleet") != name or not isinstance(hold.get("token"), str):
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
    # This session runs inside a gate run's scope ($FLEET_GATE_RUN names it): that run holds the slot.
    if hook.env.get("FLEET_GATE_RUN"):
        return None
    found = SuiteReader().suites(command, hook.cwd)
    if not found:
        return None
    sure = [s for s in found if not s.unsure]
    fleet = managed_fleet(hook)
    cli = hook.env.get("TSTACK_FLEET_CLI") or fleet_cli()
    if fleet is None:
        if not hook.headless:
            runs = (f"`{_one_line(sure[0].what, 80)}` runs a whole test suite" if sure else
                    f"the hook can't tell whether `{_one_line(command, 80)}` runs a whole test suite")
            sys.stderr.write(f"tstack: {runs}; `{cli} fleets gate run --as <name> -- <command>` queues it behind other "
                             f"suites and caps its memory.\n")
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
    # Named, never carried: the hook can't tell a landing's gate from another full suite, and --pre-gate stops one
    # with nothing to push.
    landing = (f"When this is a landing's full gate (Land step 5), put the review check in front of it: "
               f"`{shlex.quote(str(ROOT / 'bin' / 'land-check'))} --pre-gate -b <bookmark> && {wrapped}`, so a stack "
               f"that needs a review the ledger does not record stops before the gate takes the slot. ")
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
    if sure:
        unclear = (" The hook couldn't tell all that this line runs around the test runner."
                   if any(s.unclear for s in found) else "")
        lead = f"`{_one_line(sure[0].what, 80)}` runs a full test suite, and in"
    else:
        unclear = (" It names a test runner whose words the hook can't read (a variable, an escape, a line it can't "
                   "parse), so it goes through the gate as a suite would.")
        lead = f"The hook can't tell whether `{_one_line(command, 80)}` runs a whole test suite. In"
    return Deny(f"{lead} fleet {fleet} (this machine serves a manager) a "
                f"full suite runs only through the gate slot, in a memory-capped scope that dies whole.{unclear} Run "
                f"it as: `{wrapped}` (Bash timeout {SUITE_TIMEOUT_MS}, or run_in_background: it may queue behind "
                f"another suite). {landing}{slot}It exits with the suite's code, except 75: the slot stayed held past "
                f"--wait and the suite never ran; 124: the suite ran past its time and was stopped.")


def shutil_which(name):
    import shutil
    return shutil.which(name)


# The rm guard. On 10-22 a fleet reviewer ran `rm -rf ~/.config/jj/repos/$(cat …)`: the `cat` failed, the operand came
# to ~/.config/jj/repos/, and every repo's jj config (about 720) was deleted; auto mode let it through. A recursive rm,
# find's -delete, or any rm find runs (find recurses even when its rm does not), is refused when an operand can expand
# to what nobody read (`$(`, a backtick, a variable with no `:?` guard; `~`, $HOME and $TMPDIR are read as the
# session's) or names `/`, a folder above HOME, HOME, a dot-folder of it or a folder at most two deep in ~/.config; a
# pattern over one of those, a pattern that climbs out of its folder with `..`, and a whole folder's pattern (`*`, `.*`,
# `{*,.*}`) of a folder anywhere inside a dot-folder of HOME, written absolute or read after the line's own `cd`, count
# too (`~/proj/build/*` passes). A trap's text is read as `sh -c`'s. A `cd` (or env -C, sudo -D) to a
# target that can expand to nothing leaves every relative operand after it unread; one the hook cannot read otherwise
# leaves a bare pattern unread. An rm that xargs or parallel feeds is refused: its operands are input nobody read.
# The split is _simple_commands' (see rm_guard for what it does not see).
RM_SENTENCE = "tstack: refused a recursive delete"
RM_FIX = ("To delete it, move it to the trash with `trash <path>` (or `gio trash <path>`), which can be undone; or resolve "
          "the path into a variable, check it is non-empty and the one you mean (ls it), then delete with the literal path.")
RM_GLOB = frozenset("*?[{")
RM_SUDO_VALUED = frozenset(("-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p",
                            "--prompt", "-R", "--chroot", "-T", "--command-timeout", "-U", "--other-user", "-r", "--role",
                            "-t", "--type"))
RM_EXECS = ("-exec", "-execdir", "-ok", "-okdir")
RM_WHOLE = re.compile(r"[*?.{},]*[*?][*?.{},]*")  # a last component that is only a pattern: every entry of its folder
RM_CLIMB = re.compile(r"(?:^|[/{,])\.\.(?:$|[/},])")  # a `..` component, in a path or a brace list
RM_FED = ("takes its operands from input nobody read before it runs (xargs' or parallel's): list the paths first and "
          "delete them by literal path, or move them to the trash with `trash <path>`")
RM_DEPTH = 3  # `bash -c '...'` inside `sh -c '...'`: a deeper one is not read
RM_WORD = re.compile(r"(?<![\w.-])(?:rm|find|xargs)(?![\w.-])")  # a command rm_guard reads has one of these words
RM_DELETES = re.compile(r"(?<![\w.-])(?:rm|-delete)(?![\w.-])")
RM_KNOWN = ("HOME", "TMPDIR")  # read as the session's value when it is an absolute path
RM_PARALLEL_VALUED = frozenset(("-j", "--jobs", "-P", "-S", "--sshlogin", "-N", "-n", "--max-args", "-L", "--max-lines",
                                "-d", "--delimiter", "-a", "--arg-file", "-I", "--joblog", "--tmpdir", "-E", "-C",
                                "--colsep"))
# Where a simple command runs: its folder (None when not known); why not known after a `cd` ("unread": its target can
# expand to nothing, which goes to HOME; "unknown": the hook cannot read it); whether a `cd` on the line moved it.
RmPlace = namedtuple("RmPlace", "cwd blind moved")


def rm_guard(hook):
    """PreToolUse (Bash, Monitor): a recursive delete whose operand can expand to what nobody read, or names `/`, a
    folder above HOME, HOME, a dot-folder of it or a folder two deep in ~/.config, is denied (the comment above). Any
    other call it says nothing on, and it never allows. When it fails, the call is denied (dispatch) only if the
    command holds an rm or -delete word; with none, nothing in it deletes, so the failure is logged and the call goes
    through.
    Not seen: an rm run by a script file, an alias or a function; a shell fed its script on stdin
    (`echo … | bash`, `bash <<< …`, a here-document as in `bash -s <<'EOF'`); `~-`, `$'…'` escapes, a bracket class as a whole folder's pattern (`[a-z]*`), a
    quoted command word (`r''m`), a backslash-newline before an operand at column 0; other deleters (python's
    shutil.rmtree, perl's rmtree, rsync --delete, mv, git clean). `~user` is read as that user's home folder. A `cd`
    inside a subshell moves the folder for the commands after the subshell too."""
    command = _shell_command(hook)
    if command is None or not RM_WORD.search(command):
        return None
    known = {}
    for name in RM_KNOWN:
        value = hook.env.get(name)
        if isinstance(value, str) and os.path.isabs(value):
            known[name] = os.path.normpath(value)
    try:
        problem = _rm_problem(command, RmPlace(hook.cwd, None, False), known)
    except Exception:
        if RM_DELETES.search(command):
            raise
        log(hook.data_dir, f"PreToolUse rm_guard failed, let through (no rm in the command)\n{traceback.format_exc()}")
        return None
    return Deny(f"{RM_SENTENCE}: {problem} {RM_FIX}") if problem else None


def _rm_problem(command, place, known, depth=0):
    """Why a simple command of `command` deletes what it should not, or None. `place` is where it starts (RmPlace)."""
    try:
        pieces = _simple_commands(command)
    except (ValueError, IndexError):  # bash runs no text that does not parse
        return None
    for piece in pieces:
        words, fed, chdirs = _rm_unwrapped(_rm_words(_without_redirections(piece)))
        if not words:
            continue
        head = os.path.basename(_rm_bare(words[0]))
        if head in ("cd", "pushd", "popd"):
            place = _rm_cd(head, words[1:], place, known)
            continue
        here = place
        for target in chdirs:
            here = _rm_moved(target, here, known)
        if head in SHELLS or head in ("eval", "trap"):
            script = _rm_script(words)
            problem = _rm_problem(script, here, known, depth + 1) if script and depth < RM_DEPTH else None
            if problem:
                return problem
            continue
        operands = _rm_operands(words)
        if operands is None:
            continue
        for operand in operands:
            why = _rm_why(operand, here, known)
            if why:
                return f"`{_one_line(piece, 120)}`: its operand `{operand}` {why}."
        if fed:
            return f"`{_one_line(piece, 120)}` {RM_FED}."
    return None


def _rm_cd(head, args, place, known):
    """Where a cd, pushd or popd with these words leaves the folder."""
    while args and _rm_bare(args[0]) in ("-L", "-P", "-e", "-@", "-n"):
        args = args[1:]
    if args and _rm_bare(args[0]) == "--":
        args = args[1:]
    if head == "popd" or (head == "pushd" and not args) or (args and re.fullmatch(r"[+-]\d*", _rm_bare(args[0]))):
        return RmPlace(None, "unknown", True)
    return _rm_moved(args[0] if args else "~", place, known)


def _rm_moved(target, place, known):
    """The place after a move to `target`, as written (a cd's word, env -C's or sudo -D's)."""
    text, _, why, bare = _rm_read(target, known, place.cwd)
    if why:
        return RmPlace(None, "unread" if bare else "unknown", True)
    if text == "":
        return RmPlace(None, "unread", True)
    path = _rm_path(text, place.cwd) if text is not None else None
    return RmPlace(path, None if path else place.blind or "unknown", True)


def _rm_script(words):
    """The text a shell's `-c`, `eval` or a `trap` runs, None when there is none: past a shell's options (`-o`/`-O`
    take a value) and a `--`; a trap's first operand when signals follow it (`trap - EXIT` and `trap EXIT` reset)."""
    head = os.path.basename(_rm_bare(words[0]))
    if head == "eval":
        return " ".join(_rm_bare(w) for w in words[1:])
    if head == "trap":
        args = _rm_past_options(words)
        return _rm_bare(args[0]) if len(args) > 1 and _rm_bare(args[0]) != "-" else None
    command, i = False, 1
    while i < len(words):
        bare = _rm_bare(words[i])
        if bare == "--":
            i += 1
            break
        if re.fullmatch(r"[-+][A-Za-z]+", bare):
            command = command or "c" in bare[1:]
            i += 2 if "o" in bare[1:] or "O" in bare[1:] else 1
        elif bare in ("--rcfile", "--init-file"):
            i += 2
        elif bare.startswith("--"):
            i += 1
        else:
            break
    return _rm_bare(words[i]) if command and i < len(words) else None


def _rm_words(text):
    """A simple command's words as written, quotes and expansions kept: split at blanks outside quotes, `$( )`, `${ }`
    and backticks."""
    words, start, stack, i, n = [], None, [], 0, len(text)
    while i < n:
        c = text[i]
        top = stack[-1] if stack else None
        if top == "'":
            if c == "'":
                stack.pop()
            i += 1
            continue
        if c == "\\":
            start = i if start is None else start
            i += 2
            continue
        if not stack and c in " \t\n":
            if start is not None:
                words.append(text[start:i])
                start = None
            i += 1
            continue
        start = i if start is None else start
        if top == c and c in "\")}`":
            stack.pop()
        elif c == "'" and top != '"':
            stack.append("'")
        elif c in "\"`":
            stack.append(c)
        elif text.startswith("$(", i) or text.startswith("${", i):
            stack.append(")" if text[i + 1] == "(" else "}")
            i += 1
        elif c == "(" and top == ")":
            stack.append(")")
        i += 1
    if start is not None:
        words.append(text[start:])
    return words


def _rm_bare(word):
    """A word without its quotes and backslashes; as written when it does not read as one word."""
    import shlex
    try:
        parts = shlex.split(word)
    except ValueError:
        return word
    return parts[0] if len(parts) == 1 else word


def _rm_past_options(words, valued=()):
    """The words after a command's options and a `--`; an option in `valued` takes the word after it."""
    i = 1
    while i < len(words):
        bare = _rm_bare(words[i])
        if bare == "--":
            return words[i + 1:]
        if bare in valued:
            i += 2
        elif bare.startswith("-") and len(bare) > 1:
            i += 1
        else:
            break
    return words[i:]


def _rm_option(words, names):
    """The value of the first of these options among `words` (`-c X`, `--command X`, `--command=X`), or None."""
    for k, word in enumerate(words[1:], 1):
        bare = _rm_bare(word)
        if bare in names and k + 1 < len(words):
            return words[k + 1]
        for name in names:
            if name.startswith("--") and bare.startswith(name + "="):
                return bare[len(name) + 1:]
    return None


def _rm_unwrapped(words):
    """The command past the shell words that lead to it (`{`, `if`, `then`...) and its wrappers: sudo, doas, stdbuf,
    env, nice, ionice, setsid, command, exec, builtin, busybox, flock, su, parallel, and _unwrap's (timeout, nohup,
    time, xargs, ...); `flock -c` and `su -c` run their text as `sh -c`. (words, whether xargs or parallel feeds it its
    input, the folders env -C and sudo -D move it to, as written.)"""
    fed, chdirs = False, []
    while words:
        head = os.path.basename(_rm_bare(words[0]))
        if words[0] in SHELL_LEADERS:
            words = words[1:]
        elif head in ("sudo", "doas", "stdbuf"):
            i = 1
            while i < len(words) and words[i].startswith("-"):
                if words[i] == "--":
                    i += 1
                    break
                if head == "sudo" and words[i] in ("-D", "--chdir") and i + 1 < len(words):
                    chdirs.append(words[i + 1])
                elif head == "sudo" and words[i].startswith("--chdir="):
                    chdirs.append(words[i][len("--chdir="):])
                i += 2 if head != "stdbuf" and words[i] in RM_SUDO_VALUED else 1
            words = words[i:]
        elif head == "env":
            words = _rm_env(words, chdirs)
        elif head == "nice":
            words = _rm_past_options(words, ("-n", "--adjustment"))
        elif head == "ionice":
            if any(_rm_bare(w) in ("-p", "-P", "-u", "--pid", "--pgid", "--uid") for w in words[1:]):
                return [], fed, chdirs
            words = _rm_past_options(words, ("-c", "-n", "--class", "--classdata"))
        elif head in ("setsid", "command", "exec", "builtin"):
            words = _rm_past_options(words, ("-a",))
        elif head == "busybox":
            words = words[1:]
        elif head in ("flock", "su"):
            script = _rm_option(words, ("-c", "--command"))
            if script is not None:
                words = ["sh", "-c", script]
            elif head == "flock":
                words = _rm_past_options(words, ("-w", "--wait", "--timeout", "-E", "--conflict-exit-code"))[1:]
            else:
                return [], fed, chdirs
        elif head == "parallel":
            body = _rm_past_options(words, RM_PARALLEL_VALUED)
            options = [_rm_bare(w) for w in words[1:len(words) - len(body)]]
            seps = [k for k, w in enumerate(body) if _rm_bare(w) in (":::", ":::+", "::::", "::::+")]
            fed = fed or not seps or any(_rm_bare(body[k]).startswith("::::") for k in seps) or any(
                w in ("-a", "--arg-file") or w.startswith("--arg-file=") for w in options)
            command = body[:seps[0]] if seps else body
            args = [w for w in body[seps[0]:] if _rm_bare(w) not in (":::", ":::+", "::::", "::::+")] if seps else []
            words = [w for w in command if not re.fullmatch(r"\{[^}\s]*\}", _rm_bare(w))] + args
        else:
            if head == "xargs":
                fed = True
            inner, _ = _unwrap(words, once=True)
            if inner == words:
                return words, fed, chdirs
            words = inner
    return words, fed, chdirs


def _rm_env(words, chdirs):
    """The command env runs, past its options and assignments; its -C folder goes to `chdirs`, and -S's text is split
    into the words it stands for."""
    i = 1
    while i < len(words):
        bare = _rm_bare(words[i])
        if bare == "--":
            return words[i + 1:]
        if bare in ("-C", "--chdir") and i + 1 < len(words):
            chdirs.append(words[i + 1])
            i += 2
        elif bare.startswith("--chdir=") or (bare.startswith("-C") and len(bare) > 2):
            given = words[i] if words[i].startswith(("--chdir=", "-C")) else bare
            chdirs.append(given.split("=", 1)[1] if given.startswith("--") else given[2:])
            i += 1
        elif bare in ("-S", "--split-string") and i + 1 < len(words):
            return _rm_words(_rm_bare(words[i + 1])) + words[i + 2:]
        elif bare in ("-u", "--unset"):
            i += 2
        elif (bare.startswith("-") and len(bare) > 1) or re.match(r"[A-Za-z_]\w*=", bare):
            i += 1
        else:
            break
    return words[i:]


def _rm_operands(words):
    """What a recursive delete names: an rm's operands, find's starting points when it runs -delete, any rm, or a shell
    whose text holds one (with a recursive rm's own operands but `{}`); None for any other command, and for an rm that
    is not recursive."""
    if not words:
        return None
    head = os.path.basename(_rm_bare(words[0]))
    if head == "rm":
        recursive, operands, options = False, [], True
        for word in words[1:]:
            bare = _rm_bare(word)
            if options and bare == "--":
                options = False
            elif options and bare.startswith("--"):
                name = bare.split("=", 1)[0]
                recursive = recursive or (len(name) > 2 and "--recursive".startswith(name))
            elif options and bare.startswith("-") and len(bare) > 1:
                recursive = recursive or "r" in bare or "R" in bare
            else:
                operands.append(word)
        return operands if recursive else None
    if head != "find":
        return None
    i = 1
    while i < len(words) and _rm_bare(words[i]) in ("-H", "-L", "-P", "-D") or (
            i < len(words) and _rm_bare(words[i]).startswith("-O")):
        i += 2 if _rm_bare(words[i]) == "-D" else 1
    paths = []
    while i < len(words) and not _rm_bare(words[i]).startswith(("-", "(", "!", ")")):
        paths.append(words[i])
        i += 1
    expression = [_rm_bare(w) for w in words[i:]]
    deletes, more = "-delete" in expression, []
    for k, word in enumerate(expression):
        if word not in RM_EXECS:
            continue
        end = next((j for j in range(k + 1, len(expression)) if expression[j] in (";", "+")), len(expression))
        inner = _rm_unwrapped(words[i + k + 1:i + end])[0]
        if not inner:
            continue
        head = os.path.basename(_rm_bare(inner[0]))
        if head == "rm":
            deletes = True
            more += [w for w in _rm_operands(inner) or () if _rm_bare(w) != "{}"]
        elif head in SHELLS and RM_DELETES.search(_rm_script(inner) or ""):
            deletes = True
    return (paths or ["."]) + more if deletes else None


def _rm_why(operand, place, known):
    """Why a recursive delete run at `place` may not take this operand, or None."""
    home = known.get("HOME")
    user = re.match(r"~([A-Za-z_][\w.-]*)(?=/|$)", operand)
    theirs = _rm_user_home(user.group(1)) if user else None
    if theirs and theirs != home:
        why = _rm_why("~" + operand[user.end():], place, {**known, "HOME": theirs})
        if why:
            return why
    text, glob, why, _ = _rm_read(operand, known, place.cwd)
    if why or text is None:
        return why
    relative = not text.startswith("/")
    if relative and place.blind == "unread":
        return ("is read in the folder of a `cd` whose target can expand to nothing: unquoted and empty, it leaves a "
                "bare `cd`, which goes to the home folder")
    if glob is not None:
        if RM_CLIMB.search(text[glob:]):
            return "climbs out of its folder with `..` after a pattern, to a folder nobody read"
        cut = text.rfind("/", 0, glob)
        before = text[:cut] if cut >= 0 else ""
        whole = RM_WHOLE.fullmatch(text[cut + 1:])
        folder = _rm_path(before or ("/" if cut == 0 else "."), place.cwd)
        if folder is None:
            if place.blind and whole and relative and all(s in ("", ".", "..") for s in before.split("/")):
                return "is a pattern for every entry of the folder a `cd` went to, which the hook cannot read"
            return None
        named = _rm_protected(folder, home)
        if named:
            return f"is a pattern over {_rm_shown(folder, home)}, which matches what lies in it"
        dotted = home and folder.startswith(home + "/.") and (not relative or place.moved)
        if dotted and whole:
            return f"is a pattern for every entry of {_rm_shown(folder, home)}, which empties the folder"
        return None
    path = _rm_path(text, place.cwd)
    named = _rm_protected(path, home) if path else None
    return f"names {_rm_shown(path, home)}, {named}" if named else None


def _rm_user_home(name):
    try:
        import pwd
        return os.path.normpath(pwd.getpwnam(name).pw_dir)
    except (ImportError, KeyError):
        return None


def _rm_read(word, known, cwd=None):
    """What an operand stands for: (its text with `~`, `~+`, `~user` and the known variables put in, where its first
    unquoted pattern character stands or None, why it can expand to what nobody read or None, whether that expansion
    lies outside double quotes, where an empty one leaves no word at all). The text is None when a guarded variable
    (`${VAR:?}`) or a `~+` with no known folder stands in it: what it holds is not known, and an empty guarded one
    stops the command."""
    out, glob, quote, i, n = [], None, None, 0, len(word)
    readable = True
    tilde = re.match(r"~([^/]*)", word)
    if tilde:
        name = tilde.group(1)
        base = known.get("HOME") if name == "" else cwd if name == "+" else (
            _rm_user_home(name) if re.fullmatch(r"[A-Za-z_][\w.-]*", name) else None)
        if base:
            out.extend(base)
            i = tilde.end()
        elif name == "+":
            return None, None, None, False
    while i < n:
        c = word[i]
        if quote == "'":
            if c == "'":
                quote = None
            else:
                out.append(c)
            i += 1
        elif c == "\\":
            if quote == '"' and word[i + 1:i + 2] not in ("$", "`", '"', "\\"):
                out.append(c)
            out.extend(word[i + 1:i + 2])
            i += 2
        elif c == "'" and quote is None:
            quote, i = "'", i + 1
        elif c == '"':
            quote, i = (None if quote else '"'), i + 1
        elif c == "`":
            return None, None, ("holds a command substitution in backticks, which can print nothing and leave only the "
                                "path around it"), quote is None
        elif c == "$":
            rest = word[i + 1:]
            name = re.match(r"[A-Za-z_]\w*", rest)
            if rest.startswith("("):
                return None, None, ("holds a command substitution (`$(`), which can print nothing and leave only the "
                                    "path around it: on 10-22 `rm -rf ~/.config/jj/repos/$(cat …)` deleted every repo's "
                                    "jj config that way"), quote is None
            if rest.startswith("{"):
                end = word.find("}", i)
                inner = word[i + 2:end] if end >= 0 else rest[1:]
                var = re.match(r"[A-Za-z_]\w*", inner)
                modifier = inner[var.end():] if var else ""
                if var and var.group() in known and (not modifier or modifier[:2] in (":?", ":-", ":=")):
                    out.extend(known[var.group()])
                elif var and modifier[:2] == ":?" and end >= 0:
                    readable = False
                else:
                    return None, None, _rm_unguarded(var.group() if var else inner), quote is None
                i = end + 1 if end >= 0 else n
            elif name:
                if name.group() not in known:
                    return None, None, _rm_unguarded(name.group()), quote is None
                out.extend(known[name.group()])
                i += 1 + name.end()
            elif rest[:1] and (rest[0].isdigit() or rest[0] in "@*#?$!-"):
                return None, None, _rm_unguarded(rest[0]), quote is None
            elif rest[:1] in ("'", '"') and quote is None:  # $'...' and $"..." are quotes
                i += 1
            else:
                out.append(c)
                i += 1
        else:
            if quote is None and c in RM_GLOB and glob is None:
                glob = len(out)
            out.append(c)
            i += 1
    return ("".join(out) if readable else None), glob, None, False


def _rm_unguarded(name):
    return (f"holds `${name}`, a variable with no `:?` guard: empty or unset, it leaves only the path around it "
            f"(`${{{name}:?}}` stops the command instead)")


def _rm_path(text, cwd):
    """A path's normal form, relative to `cwd`; None when it is relative and the folder is not known."""
    if not text:
        return None
    if not text.startswith("/"):
        if not cwd:
            return None
        text = os.path.join(cwd, text)
    path = os.path.normpath(text)
    return "/" + path.lstrip("/") if path.startswith("//") else path


def _rm_protected(path, home):
    """What a protected folder is, or None: `/`, a folder above the home folder, the home folder, a dot-folder of it,
    a folder at most two deep in ~/.config."""
    if path == "/":
        return "the whole filesystem"
    if not home:
        return None
    if path == home:
        return "the home folder"
    if home.startswith(path.rstrip("/") + "/"):
        return "a folder above the home folder, which holds it"
    parent, name = os.path.split(path)
    if parent == home and name.startswith("."):
        return "a dot-folder of the home folder"
    config = os.path.join(home, ".config")
    if parent == config:
        return "a folder of ~/.config, one tool's whole configuration"
    if os.path.dirname(parent) == config:
        return ("a folder two deep in ~/.config, a whole part of one tool's configuration (on 10-22 "
                "~/.config/jj/repos was emptied)")
    return None


def _rm_shown(path, home):
    return "~" + path[len(home):] if home and (path == home or path.startswith(home + "/")) else path


HANDLERS = {
    "SessionStart": [memo_wake, jj_hints, tuca_mode, memo_dream_pending, tape_build],
    "Stop": [memo_nudge],
    "PreCompact": [memo_precompact],
    "PreToolUse": [land_turn_gate, push_attribution, suite_gate, rm_guard],
}

GUARDS = frozenset({land_turn_gate, push_attribution, suite_gate, rm_guard})

# Past the 30 s hooks.json gives a Bash PreToolUse hook, Claude Code discards its output and runs the call, so a deny
# must be out before them. Each guard's calls have their own limits, which can add up to more (two pushes in a command).
GUARD_DEADLINE_S = 27


class GuardDeadline(BaseException):
    """A guard ran past the deadline. Not an Exception: a guard's own broad `except` must not swallow it and run on."""


def _alarm(signum, frame):
    raise GuardDeadline


def _guard(handler, hook, started):
    """handler(hook), raising GuardDeadline inside it once the deadline counted from `started` passes."""
    left = started + float(hook.env.get("TSTACK_GUARD_DEADLINE_S") or GUARD_DEADLINE_S) - time.monotonic()
    if left <= 0:
        raise GuardDeadline
    signal.signal(signal.SIGALRM, _alarm)
    signal.setitimer(signal.ITIMER_REAL, left)
    try:
        return handler(hook)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


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
    "UserPromptSubmit": _context,
}


def dispatch(event, raw, env):
    """The text to print for this event, or "" for nothing. On Stop, a handler's Block turns the whole
    output into the block decision, whose reason (every handler's text) Claude reads as it goes on. On
    PreToolUse, a handler's Deny refuses the call, with the Deny texts alone as the reason; else an Allow (an Agent
    call the office host granted) allows it; else a Note is context beside the call's result, with no decision; any other
    text decides nothing. A PreToolUse handler that can deny (GUARDS) and fails, or runs past GUARD_DEADLINE_S counted
    from here, denies the call, naming itself and the error, and no handler runs after a deadline; any other handler
    that fails is logged and decides nothing.
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
    started = time.monotonic()
    late = False
    for handler in HANDLERS.get(event, ()):
        guard = event == "PreToolUse" and handler in GUARDS
        try:
            text = _guard(handler, hook, started) if guard else handler(hook)
        except (Exception, GuardDeadline) as e:  # one handler failing does not take the others down
            log(hook.data_dir, f"{event} {handler.__name__} failed\n{traceback.format_exc()}")
            if not guard:
                continue
            late = isinstance(e, GuardDeadline)
            how = "ran past the hook's deadline" if late else f"failed ({type(e).__name__})"
            text = Deny(f"tstack guard {handler.__name__} {how}: denied. A guard that cannot "
                        f"decide a call refuses it; the trace is in {hook.data_dir / 'hook.log'}.")
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
        if late:
            break
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
