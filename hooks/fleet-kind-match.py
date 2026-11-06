#!/usr/bin/env python3
"""The kind of a call, for a grant that lasts 24 hours. Stdlib only, run as `python3 -I hooks/fleet-kind-match.py`.

Stdin: {command, cwd, env}. Stdout, one JSON line, exit 0:
  {kind: {action, repo: {main, origin|null}, task, sha256, text[, oneoff: true]}, workspace, scripts: [{path, sha256}]} or {refused: reason}.

A kind is a committed task script, or a one-off one. The only calls that have one are exactly `bash <absolute workspace>/tasks/grant/<name>.sh`
(committed) or else `bash <absolute path>/<name>.sh` (one-off), each with an optional single argument of 40 lowercase hex characters.
A committed <name> begins with deploy- or push-, which gives `action`. Nothing else is read: arbitrary shell cannot be held to an
allow-list, so this reads no shell at all.

A one-off script is read here at the ask and held after the tap by a copy, which only its call names (the host writes it to
~/.claude/tstack-grants/copies/<team>/<action>.sh, outside these roots, so a hook reads that path with script_path).
It is a regular file, no symlink on the way, under a root the caller trusts: the fleet's state dir
(`$HOME/.local/state/fleet`, `repo` {main: that dir, origin: null}) or the call's root workspace (`env.CLAUDE_PROJECT_DIR`, which
must be one its repo lists, `repo` as a committed kind's). It need not be committed. Its `action` is <name> with a trailing
`-<digits>` run number dropped (`deploy-window-4` is `deploy-window`), and must begin with deploy- or push-; `task` is its path
under the root, `workspace` the root, and `oneoff` is true. Its text passes the same rules as a committed script's, and uses no
`$0`, `${0`, `${@:0`, `${*:0`, `BASH_ARGV0` or `BASH_SOURCE`: the host runs a copy in a folder an agent can write, so a sibling found that way is a
file the owner never read. Quoting does not excuse them: `eval` runs single-quoted text, so awk's `$0` is refused too, and such a call gets a plain card.

`main` is the realpath of `.jj/repo` (a secondary workspace's is a pointer file; neither it nor `.jj` may be a symlink),
`origin` the remote without a URL's userinfo, `task` the path under the workspace, `sha256` the script's content and `text`
that content as UTF-8, which the owner reads on the card. The workspace must be one its repo lists, and the script a regular
file, no symlink on the way, whose bytes are the bytes at that path in `@-`, with a first line of #!/bin/sh,
#!/usr/bin/env bash or #!/bin/bash, or no shebang. `@-` must be one commit, so a merge `@` has no kind. `cwd` plays no part,
and a kind's fields do not depend on the workspace, so one kind holds from every workspace of its repo.

Cards go to the cloud and the owner reads them, so a script has no kind when its text is over 8 KiB, is not UTF-8, holds a
character the page would not show as itself (rule-card.ts's INVISIBLE), or reads as a credential (fleet-hook.py's
SECRET_IN_CALL and OP_REFERENCE, kept equal by test_kind_match, read after NAME=$UPPER_CASE loses its NAME=). Such a call gets a plain card.

A use of a live committed kind needs the same action, repo, task and sha256; a one-off's use names its copy, whose bytes must hash
to its sha256, and a new file of its action and bytes is told that copy. So a changed script is a new card, and the owner approves
one script's text at a time. Force, deletion and the like need no list here: what the script does is what the owner read.

Threat model: a guard on the normal path, against an agent reaching past what the owner approved by mistake or haste. It does
not stop an agent that can write the kinds file, or that edits what a script calls (`node_modules/.bin/wrangler`, a sourced
file, the repo's config). The call runs in the session, so `bash` resolves on the session's PATH, not the host's, and the
session's environment reaches it: `BASH_ENV` and the like are no part of a kind. An agent that changes `jj` on this process's
PATH is not stopped either.
`origin` can be set by an agent, so the card names `main` too. Nor does this reading hold anything until the run: `scripts`
is what a one-time grant binds.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import unicodedata

CALL = re.compile(r"bash (/[A-Za-z0-9_./-]+)/(tasks/grant/(deploy|push)-[A-Za-z0-9_.-]+\.sh)(?: [0-9a-f]{40})?")
ONE_OFF = re.compile(r"bash (/[A-Za-z0-9_./-]+\.sh)(?: [0-9a-f]{40})?")
ONE_OFF_ACTION = re.compile(r"(?:deploy|push)-[A-Za-z0-9_.-]*[A-Za-z_.][A-Za-z0-9_.-]*")
RUN_NUMBER = re.compile(r"-[0-9]+$")
MORE_THAN_ONE = re.compile(r"[|;&<>\n`]|\$\(")
FORM = ("a kind is exactly `bash <absolute workspace>/tasks/grant/<deploy-|push-name>.sh`, or `bash <absolute path>/<deploy-|push-name>.sh` "
        "under the fleet's state dir or the call's root workspace, with at most one 40-hex argument")
SHEBANGS = (b"#!/bin/sh", b"#!/usr/bin/env bash", b"#!/bin/bash")
USERINFO = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@")
JJ_SECONDS = 10
TEXT_MAX_BYTES = 8 * 1024
INVISIBLE = frozenset(("Cc", "Cf", "Co", "Cs", "Zl", "Zp"))
SECRET_IN_CALL = re.compile(r"\bBearer\s|\bAuthorization:|\bAKIA[0-9A-Z]{12}|-----BEGIN|_authToken\b"
                            r"|[\w-]*(?:api[_-]?key|token|secret|access[_-]?key|password|passwd|pwd|authtoken)[\w-]*\s*[:=]"
                            r"|\b(?:sk-|ghp_|gho_|ghs_|github_pat_|glpat-|npm_|xox[abposr]-)[A-Za-z0-9]"
                            r"|://[^/\s:@]+:[^/\s@]+@|--pass(?:word)?\b|\s-u\s*\S+:\S"
                            r"|\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;&|\n]*\s-p\S"
                            r"|\b(?:sshpass|docker\s+login)\b[^;&|\n]*\s-p\b", re.I)
OP_REFERENCE = re.compile(r"op://")
FINDS_ITSELF = re.compile(r"\$0|\$\{0|\$\{[@*]:\s*0|BASH_ARGV0|BASH_SOURCE")
SET_FROM_A_VARIABLE = re.compile(r"""[\w-]+=("?\$\{?[A-Z_][A-Z0-9_]*\}?"?)(?=\s|$)""", re.M)


class Refused(Exception):
    pass


def _jj(workspace, env, *args, text=True):
    """A jj read that neither snapshots nor reads the caller's jj environment, its stdout (bytes when not `text`) or a refusal."""
    clean = {"PATH": os.environ.get("PATH", ""), "HOME": str(env.get("HOME") or os.environ.get("HOME", ""))}
    try:
        done = subprocess.run(["jj", "-R", workspace, "--ignore-working-copy", "--color", "never", *args], cwd=workspace, env=clean,
                              stdin=subprocess.DEVNULL, capture_output=True, text=text, timeout=JJ_SECONDS, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise Refused(f"jj did not run: {error}") from error
    if done.returncode != 0:
        raise Refused(f"jj {args[0]} {args[1]} failed in {workspace}")
    return done.stdout


def _main_repo(workspace):
    dot = os.path.join(workspace, ".jj")
    path = os.path.join(dot, "repo")
    if os.path.islink(dot) or os.path.islink(path):
        raise Refused(f"{dot} or its repo is a symlink")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as pointer:
            path = os.path.join(dot, pointer.read())
    if not os.path.isdir(path):
        raise Refused(f"{workspace} is no jj workspace")
    return os.path.realpath(path)


def _origin(workspace, env):
    for line in _jj(workspace, env, "git", "remote", "list").splitlines():
        words = line.split()
        if len(words) > 1 and words[0] == "origin":
            return USERINFO.sub(r"\1", words[1])
    return None


def _script_bytes(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        raise Refused(f"{path} does not open as a regular file: {error.strerror}") from error
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refused(f"{path} is not a regular file")
    with os.fdopen(fd, "rb") as script:
        data = script.read()
    first = data.split(b"\n", 1)[0]
    if first.startswith(b"#!") and first not in SHEBANGS:
        raise Refused(f"the first line of {path} is a shebang other than {b', '.join(SHEBANGS).decode()}")
    return data


def _card_text(path, data):
    """The script as the text a card carries, or a refusal: the owner must be able to read all of it, and the cloud may hold it."""
    if len(data) > TEXT_MAX_BYTES:
        raise Refused(f"{path} is over 8 KiB, too long to read on a card")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise Refused(f"{path} is not UTF-8") from error
    if any(c not in "\n\t" and unicodedata.category(c) in INVISIBLE for c in text):
        raise Refused(f"{path} holds an invisible character (a control, zero-width, bidi, tag or private-use one)")
    if SECRET_IN_CALL.search(SET_FROM_A_VARIABLE.sub(r"\1", text)) or OP_REFERENCE.search(text):
        raise Refused(f"{path} reads as if it holds a credential, and a card goes to the cloud")
    return text


def _check_committed(workspace, env, task, data):
    """That the script's bytes on disk are its bytes in @-: a merge @ has no one @-, and jj refuses a path @- does not hold."""
    try:
        committed = _jj(workspace, env, "file", "show", "-r", "@-", f'root-file:"{task}"', text=False)
    except Refused as error:
        raise Refused(f"{task} is not committed at @- of {workspace} (a merge @ has no one @-): commit it and ask again") from error
    if not committed:
        raise Refused(f"{task} is empty or no file at @- of {workspace}")
    if hashlib.sha256(committed).digest() != hashlib.sha256(data).digest():
        raise Refused(f"{task} on disk differs from @- of {workspace}: commit it and ask again")


def _not_the_form(command):
    """The form refusal, naming what broke it where one thing plainly did."""
    if MORE_THAN_ONE.search(command):
        return Refused(f"the call is more than one command (a pipe, `;`, `&`, a redirect, a newline or a substitution): {FORM}")
    if not command.startswith("bash /"):
        return Refused(f"the call is not `bash` and an absolute script path: {FORM}")
    return Refused(FORM)


def _root_repo(env):
    """The main repo of the call's root workspace, when its repo lists that workspace; else None."""
    root = env.get("CLAUDE_PROJECT_DIR")
    if not isinstance(root, str) or not root.startswith("/") or os.path.normpath(root) != root or os.path.realpath(root) != root:
        return None
    try:
        main = _main_repo(root)
        listed = _jj(root, env, "workspace", "list", "-T", 'self.root() ++ "\n"').splitlines()
    except Refused:
        return None
    return main if root in listed else None


def _one_off(path, env):
    name = os.path.basename(path)[:-len(".sh")]
    action = RUN_NUMBER.sub("", name)
    if not ONE_OFF_ACTION.fullmatch(action):
        raise Refused(f"{name}, its run number dropped, does not begin with deploy- or push-: {FORM}")
    if ".." in path or os.path.normpath(path) != path:
        raise Refused(f"{path} is not a normal path: {FORM}")
    home = env.get("HOME")
    state = os.path.join(home, ".local", "state", "fleet") if isinstance(home, str) and home.startswith("/") else None
    root = env.get("CLAUDE_PROJECT_DIR")
    if state is not None and path.startswith(state + "/"):
        workspace, repo = state, {"main": state, "origin": None}
    elif isinstance(root, str) and path.startswith(root + "/") and (main := _root_repo(env)) is not None:
        workspace, repo = root, {"main": main, "origin": _origin(root, env)}
    else:
        raise Refused(f"{path} is under no root the caller trusts (the fleet's state dir, or the call's root workspace that its repo lists): {FORM}")
    if os.path.realpath(os.path.dirname(path)) != os.path.dirname(path):
        raise Refused(f"{path} goes through a symlink")
    data = _script_bytes(path)
    text = _card_text(path, data)
    if FINDS_ITSELF.search(text):
        raise Refused(f"{path} finds its own path ($0, ${{0, ${{@:0, BASH_ARGV0 or BASH_SOURCE), and its kind runs a copy of it in another folder: write absolute paths instead")
    sha = hashlib.sha256(data).hexdigest()
    return {"kind": {"action": action, "repo": repo, "task": path[len(workspace) + 1:], "sha256": sha, "text": text, "oneoff": True},
            "workspace": workspace, "scripts": [{"path": path, "sha256": sha}]}


def script_path(command):
    """The script a call of either form runs, whether or not it has a kind; else None. Every committed call has the one-off form."""
    found = ONE_OFF.fullmatch(command)
    return found.group(1) if found else None


def match(command, env):
    found = CALL.fullmatch(command)
    if not found:
        path = script_path(command)
        if path is None:
            raise _not_the_form(command)
        return _one_off(path, env)
    workspace, task, action = found.groups()
    path = f"{workspace}/{task}"
    if ".." in path or os.path.normpath(path) != path:
        raise Refused(f"{path} is not a normal path")
    if os.path.realpath(os.path.dirname(path)) != os.path.dirname(path):
        raise Refused(f"{path} goes through a symlink")
    main = _main_repo(workspace)
    if workspace not in _jj(workspace, env, "workspace", "list", "-T", 'self.root() ++ "\n"').splitlines():
        raise Refused(f"{workspace} is no workspace its repo lists")
    data = _script_bytes(path)
    text = _card_text(path, data)
    _check_committed(workspace, env, task, data)
    sha = hashlib.sha256(data).hexdigest()
    return {"kind": {"action": action, "repo": {"main": main, "origin": _origin(workspace, env)}, "task": task, "sha256": sha, "text": text},
            "workspace": workspace, "scripts": [{"path": path, "sha256": sha}]}


def main():
    try:
        data = json.loads(sys.stdin.read())
        command = data["command"]
        if not isinstance(command, str):
            raise Refused("command is not a string")
        env = data.get("env")
        said = match(command, env if isinstance(env, dict) else {})
    except Refused as refusal:
        said = {"refused": str(refusal)}
    except Exception as error:
        said = {"refused": f"the matcher failed: {type(error).__name__}"}
    print(json.dumps(said))


if __name__ == "__main__":
    main()
