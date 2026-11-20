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
        cwd = data.get("cwd")
        self.cwd = cwd if isinstance(cwd, str) and os.path.isabs(cwd) else (env.get("CLAUDE_PROJECT_DIR") or os.getcwd())
        # Inside a subagent the input carries agent_id: that is a worker.
        self.is_worker = bool(data.get("agent_id")) or env.get("TSTACK_ROLE") == "worker"
        # `claude -p` and SDK runs: nobody reads a reminder, and the turn it adds
        # would replace the run's final result.
        self.headless = (env.get("CLAUDE_CODE_SESSION_ATTENDED") == "0"
                         or env.get("CLAUDE_CODE_ENTRYPOINT", "").startswith("sdk"))


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

def memo_start(hook):
    """SessionStart: the start read, from the local stores only: no git call, no network. Workers get none."""
    if hook.is_worker:
        return None
    return memo().start_text(hook.env, hook.cwd) or None


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
    hook's pipes."""
    if hook.is_worker or hook.headless:
        return None
    if not memo().tape_index(hook.env).exists() or memo().repo_key(hook.cwd) is None:
        return None
    import shutil
    import subprocess
    run = Path(hook.env.get("XDG_RUNTIME_DIR") or "/nonexistent")
    scope = (run / "bus").exists() and user_manager_runs(run) and shutil.which("systemd-run", path=hook.env.get("PATH"))
    argv = [sys.executable, str(ROOT / "scripts" / "tape"), "build", "--on-start", "--cwd", hook.cwd]
    if scope:
        argv = ["systemd-run", "--user", "--scope", "--collect", "--quiet", "-p", "MemoryMax=2G", "--", *argv]
    subprocess.Popen(argv, env=dict(hook.env), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True, preexec_fn=lambda: os.nice(10))
    return None


NOTIFY_S = 8  # under the 10 s hooks.json gives Stop and UserPromptSubmit


def _notified(hook):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", hook.session_id) or "unknown"
    return hook.data_dir / "sessions" / safe / "notified"


def _fleet(hook, *args):
    """Run `fleet` in the foreground: notify finds the Rex pane by walking up its parents to claude, so a detached
    child, reparented once the hook exits, would mark nothing. True when it exited 0."""
    import shutil
    import subprocess
    fleet = shutil.which("fleet", path=hook.env.get("PATH"))
    if not fleet:
        return False
    env = {**hook.env, "CLAUDE_CODE_SESSION_ID": hook.session_id} if hook.session_id else dict(hook.env)
    done = subprocess.run([fleet, *args], env=env, cwd=hook.cwd, stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=NOTIFY_S, check=False)
    return done.returncode == 0


def fleet_asks(hook):
    """True when the installed fleet plugin's own Stop hook flags a reply that ends asking: its
    hooks/ask-handlers.json says {"stop": true} (fleet fd2a6443). tstack then steps aside, so the pane gets one mark
    and the phone one push."""
    home = Path(hook.env.get("CLAUDE_CONFIG_DIR") or Path(hook.env.get("HOME", "/nonexistent")) / ".claude")
    try:
        installed = json.loads((home / "plugins" / "installed_plugins.json").read_text())
        for row in installed.get("plugins", {}).get("fleet@fleet", []):
            flags = json.loads((Path(row["installPath"]) / "hooks" / "ask-handlers.json").read_text())
            if flags.get("stop") is True:
                return True
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False
    return False


_FENCE = re.compile(r"^```.*?(?:^```[^\n]*$|\Z)", re.M | re.S)
_CODE_SPAN = re.compile(r"`[^`\n]*`")
_ENDS_ASKING = re.compile(r"\?[\s*_)\]\"']*$")


def ask_flag(hook):
    """Stop: when the reply's last line asks the user something, mark the Rex pane blocked on a question and send the
    ntfy notice (`fleet notify`), so the session shows as waiting on Luiz without a dialog holding the agent
    (Luiz, 2026-11-17: the ask tool "is blocking all agents, stopping work"). The mark comes off on his next prompt."""
    if hook.is_worker or hook.headless or hook.input.get("stop_hook_active") or not hook.env.get("REX_BLOCK"):
        return None
    if fleet_asks(hook):
        return None
    text = _FENCE.sub("", str(hook.input.get("last_assistant_message") or "")).strip()
    last = _CODE_SPAN.sub("", text.splitlines()[-1]) if text else ""
    if last.lstrip().startswith((">", "#")) or not _ENDS_ASKING.search(last):
        return None
    words = re.sub(r"[*_`]", "", last).strip()
    title = f"{Path(hook.cwd).name}: waiting on you"
    # Marked first: notify writes the pane's mark before it posts to ntfy, so a notice that fails or times out
    # may still have marked the pane, and only this file sends the --clear that takes it off.
    mark = _notified(hook)
    mark.parent.mkdir(parents=True, exist_ok=True)
    mark.write_text(title + "\n")
    _fleet(hook, "notify", *_ask_flag(hook), title, words[:200])
    return None


def _ask_flag(hook):
    """`--ask` when this fleet's notify has it (agents' A9): the broker then pushes the phone for the question, and
    notify posts to ntfy only while the broker is down, so Luiz gets one push, not two."""
    import shutil
    import subprocess
    fleet = shutil.which("fleet", path=hook.env.get("PATH"))
    try:
        shown = subprocess.run([fleet, "notify", "--help"], env=dict(hook.env), capture_output=True, text=True,
                               timeout=2, check=False) if fleet else None
    except subprocess.TimeoutExpired:
        return ()
    return ("--ask",) if shown and "--ask" in shown.stdout + shown.stderr else ()


SUSPEND = (
    "Luiz asked you to suspend. Stop your background tasks (TaskStop), say in two lines where the work stands and "
    "where its state is written, then run `fleet suspend me --why \"<what you were on, and where to pick up>\"`: it "
    "frees this session's memory once the turn ends. Stopping the tasks alone is not suspending."
)
_SUSPEND = re.compile(r"\bsuspen\w*\s+(?:your\s*self|you|this\s+session)\b|\bfleet\s+suspend\s+me\b", re.I)


# A relayed agent report or task notification is not Luiz asking: an advisor's text naming `fleet suspend me`
# made the hint fire (2026-11-18).
_RELAYED = re.compile(r"<agent-message\b|<task-notification>|\[Subagent hand-back\]")
# Text Luiz pastes is another session's words, not his ask: a pasted reply "why didn't you suspend yourself" fired the
# hint twice on 2026-11-19. His own words around the paste still count.
_PASTED = re.compile(r"<pasted_content\b[^>]*>.*?</pasted_content\b[^>]*>", re.S)


def suspend_hint(hook):
    """UserPromptSubmit: "suspend yourself" means `fleet suspend me`; agents stopped their tasks and stayed up
    (Luiz, 2026-11-17: "agent's are not getting this")."""
    prompt = _PASTED.sub("", str(hook.input.get("prompt") or ""))
    if hook.is_worker or _RELAYED.search(prompt) or not _SUSPEND.search(prompt):
        return None
    return SUSPEND


def ask_clear(hook):
    """UserPromptSubmit: Luiz answered, so take out the blocked mark ask_flag set for this session."""
    mark = _notified(hook)
    if hook.is_worker or not mark.is_file():
        return None
    _fleet(hook, "notify", "--clear")
    mark.unlink(missing_ok=True)
    return None


SIDE_PANES_MAX = 8  # panes read per prompt; a tab holds a few
SIDE_PANES_BUDGET_S = 3  # every rex call of one prompt together, well under the 10 s hooks.json gives UserPromptSubmit
SIDE_PANES_HEAD = """\
# Panes beside you in this Rex tab (changed since your last turn)
{lines}
A pane Luiz opened beside you is part of the work. When your task touches what one runs (a server, a test run, a log), read it first (`rex-watch --check <id>`), wait on its running command (`rex-watch <id>`, run_in_background) rather than start a second copy, and say what you saw there."""


class _RexUnread(Exception):
    """A rex call failed, ran past the prompt's budget, or printed something that is not JSON: say nothing this turn."""


def _rex_json(hook, deadline, *args):
    import subprocess
    left = deadline - time.monotonic()
    if left <= 0:
        raise _RexUnread("budget spent")
    try:
        r = subprocess.run(["rex", *args], env=dict(hook.env), capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=left)
        if r.returncode != 0:
            raise _RexUnread(r.stderr.strip()[:200])
        out = json.loads(r.stdout)
    except (subprocess.TimeoutExpired, ValueError) as e:
        raise _RexUnread(str(e)[:200]) from None
    if not isinstance(out, dict):
        raise _RexUnread("not a JSON object")
    return out


def _rex_watch():
    from importlib.machinery import SourceFileLoader
    from importlib.util import module_from_spec, spec_from_loader
    loader = SourceFileLoader("tstack_rex_watch", str(ROOT / "scripts" / "rex-watch"))
    module = module_from_spec(spec_from_loader("tstack_rex_watch", loader))
    loader.exec_module(module)
    return module


def side_panes(hook):
    """UserPromptSubmit: the other panes in this agent's Rex tab, one line each (what runs, where), told only when
    the set or a pane's state changed since the last prompt (Luiz, 2026-11-18: "agent's should be mindful of panels
    opened besides them"). Outside Rex, for workers and headless runs: nothing."""
    me = hook.env.get("REX_BLOCK") or ""
    if hook.is_worker or hook.headless or not me.startswith("block:"):
        return None
    import shutil
    if not shutil.which("rex", path=hook.env.get("PATH")):
        return None
    try:
        lines = _side_pane_lines(hook, me, time.monotonic() + SIDE_PANES_BUDGET_S)
    except _RexUnread:
        return None  # a pane's state unknown: the listing keeps its last value rather than tell a wrong one
    if lines is None:
        return None
    seen = _side_panes_seen(hook)
    now = "\n".join(lines)
    before = seen.read_text() if seen.is_file() else ""
    if now == before:
        return None
    seen.parent.mkdir(parents=True, exist_ok=True)
    seen.write_text(now)
    return SIDE_PANES_HEAD.format(lines=now or "- none now: the panes beside you closed")


def _side_panes_seen(hook):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", hook.session_id) or "unknown"
    return hook.data_dir / "sessions" / safe / "side-panes"


def side_panes_reset(hook):
    """SessionStart after a compaction or resume: the listing left the context with it, so the next prompt tells it
    again."""
    if str(hook.input.get("source") or "") in ("compact", "resume"):
        _side_panes_seen(hook).unlink(missing_ok=True)
    return None


def _side_pane_lines(hook, me, deadline):
    window = (_rex_json(hook, deadline, "block", "inspect", me, "--json").get("block") or {}).get("window_id")
    if not window:
        return None
    blocks = [b for b in _rex_json(hook, deadline, "block", "ls", "-w", window, "--json").get("blocks", [])
              if b.get("block_id") != me]
    watch = _rex_watch()
    lines = []
    for b in blocks[:SIDE_PANES_MAX]:
        bid, name = b["block_id"], b.get("label") or "pane"
        if not str(b.get("flavor", "")).startswith("com.superlogical.terminal"):
            lines.append(f"- {bid} ({name}): {b.get('flavor') or 'not a terminal'}")
            continue
        state = _rex_json(hook, deadline, "block", "call", "-b", bid, "process")
        fg = state.get("foreground")
        where = (fg or {}).get("cwd") or ""
        doing = f"running {watch.label(fg)}" if watch.busy(state) else "idle" if fg else "exited"
        lines.append(f"- {bid} ({name}): {doing}" + (f" in {where}" if where else ""))
    if len(blocks) > SIDE_PANES_MAX:
        lines.append(f"- and {len(blocks) - SIDE_PANES_MAX} more: rex block ls -w {window}")
    return lines


JJ_HINTS = """\
# jj
This repo is jj, colocated with git; a detached git HEAD is normal here, leave it as it is.
- History goes through jj: `jj status/log/diff/describe/new/split/squash/rebase/abandon`. git checkout, stash, commit and reset stay unused: they fight jj's working copy.
- Publish to this repo's landing bookmark (its docs name it: master): `jj git fetch`, `jj rebase -b @ -d <b>@origin`, then `land-check -b <b>` says whether the push may go (one that deploys waits for a yes); then `jj bookmark set <b> -r <head>` and `jj git push --bookmark <b>`.
- After a push, @ sits on a fresh empty commit. jj makes one itself when the push turns @ immutable (trunk); for any other bookmark, `jj log -r @` and `jj new` if @ is the pushed commit.
- One jj workspace per agent (`ws-add <lane> -r <base>`: <repos>/.ws/<repo>/<lane>); rebases, bookmark moves and pushes belong to whoever holds the landing turn.
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


class Block(str):
    """What a Stop handler returns to keep the turn going: the text becomes the block's reason."""


def _one_line(text, size):
    flat = " ".join(str(text).split())
    return flat if len(flat) <= size else flat[:size] + "…"


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


class Note(str):
    """What a PreToolUse handler returns to tell Claude something beside the call's result (additionalContext): it
    decides nothing, so the permission check runs as it would have."""


# The push gate. It catches honest mistakes, not an adversary: a plain `jj git push` or `git push` is read
# exactly; one it cannot read (inside a loop, a subshell, a substitution, eval, xargs, a script, or with a
# variable in it) counts as unclear.
Push = namedtuple("Push", "tool args cwd unclear")
SHELLS = {"sh", "bash", "zsh", "dash", "nu", "fish", "ksh"}
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
SCRIPT_MAX = 256 * 1024


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


# Luiz's rule (fleet decision D585, 2026-10-29): no commit he publishes carries an agent's attribution. Only real
# trailers count, so a description that quotes the rule in prose still pushes.
GENERATED_LINE = re.compile(r"^(?:\U0001f916 ?)?Generated with (?:\[Claude Code\]\([^)\s]*\)|Claude Code)\s*$")
JJ_PUSH_TARGET = re.compile(r"^\s*bookmark: \S+ \[(?:add to|move (?:forward|backward|sideways) from \S+ to) ([0-9a-f]+)\]",
                            re.M)
# Each call's own cap: the hook's 30 s are shared with the other guards, and this guard only reads local state.
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


EFFORTS = ("low", "medium", "high", "xhigh", "max")


def _role_pairs():
    """`Role: Model effort` for each row of docs/models.md's role table."""
    rows = []
    try:
        for line in (ROOT / "docs" / "models.md").read_text().splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) >= 3 and line.startswith("| ") and cells[0] not in ("Role", ":--"):
                rows.append(f"{cells[0]}: {cells[2]}")
    except OSError:
        pass
    return "; ".join(rows)


def _defined_pair(kind):
    """True when a tstack agent definition's frontmatter carries both `model:` and `effort:`."""
    try:
        head = (ROOT / "agents" / f"{kind}.md").read_text().split("---")[1]
    except (OSError, IndexError):
        return False
    return bool(re.search(r"^model:", head, re.M) and re.search(r"^effort:", head, re.M))


def spawn_effort(hook):
    """PreToolUse (Agent): a spawn passes its role's `model` and `effort` from docs/models.md, since the Agent tool sets
    effort only when asked and a bare spawn inherits the session's. A fork inherits by design; a tstack definition
    whose frontmatter carries the pair passes bare; another plugin's agent is that plugin's to check."""
    args = hook.input.get("tool_input")
    if hook.input.get("tool_name") != "Agent" or not isinstance(args, dict):
        return None
    kind = str(args.get("subagent_type") or "")
    if kind == "fork" or (":" in kind and not kind.startswith("tstack:")):
        return None
    if kind.startswith("tstack:") and _defined_pair(kind.split(":", 1)[1]):
        return None
    effort = args.get("effort")
    if effort and effort not in EFFORTS:
        return Deny(f"tstack: effort `{effort}` is not one the Agent tool takes ({', '.join(EFFORTS)}).")
    if args.get("model") and effort:
        return None
    return Deny("tstack: this spawn names no " + " and no ".join(k for k in ("model", "effort") if not args.get(k))
                + ". Pick the agent's role in docs/models.md and pass both from its row, since a bare spawn runs at "
                f"the session's effort. Roles: {_role_pairs()}.")


# The subagent cap (Luiz, 2026-11-20, after a token drain): a session runs at most AGENT_CAP subagents at once, and only
# Luiz raises that, with bin/agent-cap. Claude Code keeps a meta.json per subagent beside the session's transcript,
# <session>/subagents/agent-<id>.meta.json, written at the spawn and again when its state changes: `finished` once it
# completes, `stoppedByUser` or `sweptByStop` when it is stopped. Read 2026-11-20 on Claude Code 2.1.329: 2,912 of the
# 2,925 metas of the four days before carried `finished`; of the 13 left, two were running, the rest an agent stopped by
# a TaskStop, which marks no meta (its tool result says "Successfully stopped task: <id>" in the caller's transcript),
# or one its session's claude process left when it exited. A SubagentStart/SubagentStop ledger would leak the same two.
AGENT_CAP = 3
CAP_FILE = "agent-cap.json"
CAP_LOCK_S = 5
CAP_PENDING_S = 30  # a spawn allowed whose meta has not landed yet: the spawns of one message pass the hook first
CAP_STOPPED = b"Successfully stopped task: "
CAP_SELF_LIFT = re.compile(r"agent-cap\S*\s+allow\b|agent-cap\.json")
CAP_EDITS = ("Write", "Edit", "NotebookEdit")


def _session_state(hook):
    return hook.data_dir / "sessions" / (re.sub(r"[^A-Za-z0-9_.-]", "_", hook.session_id) or "unknown")


def _cap_limit(hook):
    path = _session_state(hook) / CAP_FILE
    try:
        limit = json.loads(path.read_text()).get("limit")
    except FileNotFoundError:
        return AGENT_CAP
    except (OSError, ValueError, AttributeError) as e:
        log(hook.data_dir, f"PreToolUse agent_cap read no limit from {path} ({e}), kept {AGENT_CAP}")
        return AGENT_CAP
    return limit if isinstance(limit, int) and limit >= AGENT_CAP else AGENT_CAP


def agent_cap(hook):
    """PreToolUse (Agent): a spawn that would make AGENT_CAP or more of the session's subagents run at once (the
    comment above) is denied, with a fleet:ask for Luiz to lift it. An agent's own Bash call that lifts it, or its edit
    of the file the lift writes, is denied. A count it cannot read lets the spawn through, logged: a hook bug never
    blocks work (it is in GUARDS for the self-lift check, which fails closed)."""
    name = hook.input.get("tool_name")
    args = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    command = _shell_command(hook)
    path = args.get("file_path") or args.get("notebook_path") if name in CAP_EDITS else None
    if (command and CAP_SELF_LIFT.search(command)) or (isinstance(path, str) and os.path.basename(path) == CAP_FILE):
        return Deny(f"tstack: an agent does not raise its own subagent cap; only Luiz does, running "
                    f"`{ROOT / 'bin' / 'agent-cap'} allow {hook.session_id or '<session-id>'} <n>` himself. Ask him in "
                    "a ```text fleet:ask fence.")
    if name != "Agent" or isinstance(spawn_effort(hook), Deny):  # a spawn refused anyway holds no place
        return None
    try:
        return _agent_cap(hook)
    except Exception:  # noqa: BLE001 - fail open
        log(hook.data_dir, f"PreToolUse agent_cap could not count the session's subagents; let the spawn through\n"
                           f"{traceback.format_exc()}")
        return None


def _agent_cap(hook):
    import fcntl
    transcript = hook.input.get("transcript_path")
    if not isinstance(transcript, str) or not transcript.endswith(".jsonl"):
        raise ValueError(f"no session transcript_path to find the subagents by: {transcript!r}")
    folder = Path(transcript[:-len(".jsonl")]) / "subagents"
    limit = _cap_limit(hook)
    state = _session_state(hook)
    state.mkdir(parents=True, exist_ok=True)
    with open(state / "agent-cap.lock", "a") as lock:
        give_up = time.monotonic() + CAP_LOCK_S  # the spawns of one message run their hooks at once
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > give_up:
                    raise TimeoutError(f"{lock.name} held past {CAP_LOCK_S} s") from None
                time.sleep(0.05)
        running, spawned = _cap_running(hook, folder)
        pending_path = state / "agent-cap-pending.json"
        try:
            pending = json.loads(pending_path.read_text())
        except (OSError, ValueError):
            pending = {}
        now = time.time()
        pending = {k: v for k, v in pending.items()
                   if k not in spawned and isinstance(v, (int, float)) and now - v < CAP_PENDING_S}
        if len(running) + len(pending) >= limit:
            running = _cap_alive(hook, Path(transcript), folder, running)
        count = len(running) + len(pending)
        if count >= limit:
            return Deny(_cap_ask(hook, count, limit))
        use = hook.input.get("tool_use_id")
        if use:  # its meta's toolUseId retires it
            pending[str(use)] = now
            tmp = pending_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(pending))
            os.replace(tmp, pending_path)
    return None


def _cap_running(hook, folder):
    """{agent id: (meta, mtime)} of the metas in `folder` with no end state, and every meta's toolUseId."""
    running, spawned = {}, set()
    try:
        entries = list(os.scandir(folder))
    except FileNotFoundError:
        return running, spawned
    for entry in entries:
        if not (entry.name.startswith("agent-") and entry.name.endswith(".meta.json")):
            continue
        try:
            meta = json.loads(Path(entry.path).read_text())
            mtime = entry.stat().st_mtime
        except (OSError, ValueError) as e:
            log(hook.data_dir, f"PreToolUse agent_cap skipped {entry.path}: {e}")
            continue
        if not isinstance(meta, dict):
            continue
        spawned.add(str(meta.get("toolUseId")))
        if not (meta.get("finished") or meta.get("stoppedByUser") or meta.get("sweptByStop")):
            running[entry.name[len("agent-"):-len(".meta.json")]] = (meta, mtime)
    return running, spawned


def _cap_alive(hook, transcript, folder, running):
    """`running` without the agents a TaskStop stopped (its result in the session's transcript, or in the transcript
    of the agent that spawned it) and those whose meta is older than this session's claude process. Read only at the
    cap: the session's transcript runs to tens of MB."""
    callers = {transcript} | {folder / f"agent-{m.get('parentAgentId')}.jsonl"
                              for m, _ in running.values() if m.get("parentAgentId")}
    stopped = set()
    for path in callers:
        try:
            text = path.read_bytes()
        except OSError:
            continue
        stopped |= {a for a in running if CAP_STOPPED + a.encode() in text}
    started = _claude_started(hook)
    return {a: v for a, v in running.items() if a not in stopped and (started is None or v[1] >= started - 2)}


def _claude_started(hook):
    """When the claude process this hook runs under started (epoch seconds, to the second), or None when no ancestor
    is claude. `ps`, which Linux and macOS share."""
    import subprocess
    pid = os.getppid()
    for _ in range(8):
        if pid <= 1:
            return None
        out = subprocess.run(["ps", "-o", "ppid=", "-o", "lstart=", "-o", "comm=", "-p", str(pid)], capture_output=True,
                             text=True, env={**hook.env, "LC_ALL": "C"}, timeout=3).stdout.split()
        if len(out) < 7:
            return None
        if os.path.basename(" ".join(out[6:])) == "claude":
            return time.mktime(time.strptime(" ".join(out[1:6]), "%a %b %d %H:%M:%S %Y"))
        pid = int(out[0])
    return None


def _cap_ask(hook, count, limit):
    sid = hook.session_id or "<session-id>"
    lift = f"{ROOT / 'bin' / 'agent-cap'} allow {sid}"
    return (f"tstack: {count} subagents running in this session; its cap is {limit} (Luiz, 2026-11-20: at most "
            f"{AGENT_CAP} at once). Wait for one to finish, or ask Luiz with this fence in your reply:\n\n"
            f"```text fleet:ask header=Agents\nThis session runs {count} subagents, its cap is {limit}. "
            f"Allow more?\n- Allow 2 more: you run `{lift} 2`\n- No: I wait for one to finish\n```\n\n"
            f"Only Luiz lifts it, running `{lift} <n>` from his terminal or his inbox; only Luiz can: the hook "
            "refuses that command from an agent.")


# The context wall (Luiz, 2026-11-20): a subagent past WALL_TOKENS of context hands off instead of working on; a fresh
# agent continues from its handoff. Its context is the last assistant message's usage in its own transcript, which
# Claude Code keeps at <session>/subagents/agent-<agent_id>.jsonl (the hook's transcript_path is the session's).
# docs/models.md's 150k is the early nudge; a session's main thread restarts by tuca-mode's line 7.
WALL_TOKENS = 200_000
WALL_TAIL = 1024 * 1024
WALL_TEXT = ("tstack: past 200k context: write your handoff (tstack:handoff) to /tmp and report; a fresh agent "
             "continues from it. Only a handoff-*.md under $TMPDIR or /tmp, the handoff skill, ToolSearch, "
             "SubagentHandback, SendMessage to the agent that spawned you and TaskStop of yourself still run.")
WALL_FREE = ("SubagentHandback", "ToolSearch")


def context_wall(hook):
    """PreToolUse (every tool): a subagent whose context is past WALL_TOKENS (the comment above) is refused every call
    but its handoff and its report. A context it cannot read lets the call through, logged."""
    agent = hook.input.get("agent_id")
    if not isinstance(agent, str) or not agent:
        return None
    try:
        tokens, meta = _wall_context(hook, agent)
    except Exception:  # noqa: BLE001 - fail open
        log(hook.data_dir, f"PreToolUse context_wall read no context for agent {agent}; let the call through\n"
                           f"{traceback.format_exc()}")
        return None
    if tokens <= WALL_TOKENS or _wall_allows(hook, agent, meta):
        return None
    return Deny(WALL_TEXT)


def _wall_context(hook, agent):
    """The agent's context in tokens, from its transcript's last assistant usage, and its meta ({} when none)."""
    transcript = hook.input.get("transcript_path")
    if not isinstance(transcript, str) or not transcript.endswith(".jsonl"):
        raise ValueError(f"no session transcript_path to find the agent's by: {transcript!r}")
    folder = Path(transcript[:-len(".jsonl")]) / "subagents"
    if Path(transcript).parent.name == "subagents":  # already the agent's own
        folder = Path(transcript).parent
    with open(folder / f"agent-{agent}.jsonl", "rb") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - WALL_TAIL))
        lines = f.read().splitlines()
    for line in reversed(lines):
        if b'"assistant"' not in line or b'"usage"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        usage = entry.get("message", {}).get("usage") if entry.get("type") == "assistant" else None
        if isinstance(usage, dict):
            tokens = sum(int(usage.get(k) or 0) for k in
                         ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
            try:
                meta = json.loads((folder / f"agent-{agent}.meta.json").read_text())
            except (OSError, ValueError):
                meta = {}
            return tokens, meta if isinstance(meta, dict) else {}
    raise ValueError(f"no assistant usage in the last {WALL_TAIL} bytes of agent-{agent}.jsonl")


def _wall_allows(hook, agent, meta):
    """The calls a subagent past the wall still makes: its handoff, and its report to whoever spawned it."""
    name = hook.input.get("tool_name")
    args = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    if name in WALL_FREE:
        return True
    if name == "Skill":
        return str(args.get("skill") or "").split(":")[-1] == "handoff"
    if name == "SendMessage":
        return args.get("to") in {"main", meta.get("parentAgentId") or "main"}
    if name == "TaskStop":
        return args.get("task_id") == agent
    if name in ("Write", "Edit"):
        path = args.get("file_path")
        if not isinstance(path, str) or not os.path.isabs(path) or "handoff" not in os.path.basename(path).lower():
            return False
        real = os.path.realpath(path)
        roots = {os.path.realpath(r) for r in (hook.env.get("TMPDIR"), "/tmp") if r}
        return any(real.startswith(r.rstrip("/") + "/") for r in roots)
    return False


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
    "SessionStart": [memo_start, jj_hints, tape_build, side_panes_reset],
    "Stop": [ask_flag],
    "UserPromptSubmit": [ask_clear, suspend_hint, side_panes],
    "PreToolUse": [context_wall, push_attribution, rm_guard, spawn_effort, agent_cap],
}

GUARDS = frozenset({context_wall, push_attribution, rm_guard, spawn_effort, agent_cap})

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
    "PreToolUse": None,  # dispatch decides: a Deny refuses, a Note is context, nothing else speaks; tstack never allows
    "SessionStart": _context,
    "Stop": _context,
    "PostToolUse": _context,
    "UserPromptSubmit": _context,
}


def dispatch(event, raw, env):
    """The text to print for this event, or "" for nothing. On Stop, a handler's Block turns the whole
    output into the block decision, whose reason (every handler's text) Claude reads as it goes on. On
    PreToolUse, a handler's Deny refuses the call, with the Deny texts alone as the reason; else a Note is context
    beside the call's result, with no decision (tstack never allows a call); any other
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
    parts, denials, notes = [], [], []
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
            if isinstance(text, Note):
                notes.append(text.strip())
        if late:
            break
    if not parts or event not in EMIT:
        return ""
    if denials and event == "PreToolUse":
        return _decide(event, "deny", "\n\n".join(denials))
    if event == "PreToolUse":
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
