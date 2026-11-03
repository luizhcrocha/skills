#!/usr/bin/env python3
"""The kind of a call, for a grant that lasts 24 hours. Stdlib only, run as `python3 -I hooks/tstack-kind-match.py`.

Stdin: {command, cwd, env}. Stdout, one JSON line, exit 0:
  {kind: {action, repo: {main, origin|null}, task, sha256}, workspace, scripts: [{path, sha256}]} or {refused: reason}.

A kind is a committed task script. The only call that has one is exactly `bash <absolute workspace>/tasks/grant/<name>.sh`,
with an optional single argument of 40 lowercase hex characters. <name> begins with deploy- or push-, which gives `action`.
Nothing else is read: arbitrary shell cannot be held to an allow-list, so this reads no shell at all.

`main` is the realpath of `.jj/repo` (a secondary workspace's is a pointer file), `origin` the remote without a URL's
userinfo, `task` the path under the workspace, `sha256` the script's content. The workspace must be one its repo lists, and
the script a regular file, no symlink on the way, tracked at that path in the workspace's last snapshot, with a first line
of #!/bin/sh, #!/usr/bin/env bash or #!/bin/bash, or no shebang. `cwd` plays no part, and a kind's fields do not depend on
the workspace, so one kind holds from every workspace of its repo.

A use of a live kind needs the same action, repo, task and sha256, so a changed script is a new card, and the owner approves
one script's text at a time. Force, deletion and the like need no list here: what the script does is what the owner read.

Threat model: a guard on the normal path, against an agent reaching past what the owner approved by mistake or haste. It does
not stop an agent that can write the kinds file, that edits what a script calls (`node_modules/.bin/wrangler`, a sourced
file, the repo's config) or that changes `jj` or `bash` on the host's PATH. Nor does this reading hold anything until the
run: `scripts` is what a one-time grant binds.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

CALL = re.compile(r"bash (/[A-Za-z0-9_./-]+)/(tasks/grant/(deploy|push)-[A-Za-z0-9_.-]+\.sh)(?: [0-9a-f]{40})?")
SHEBANGS = (b"#!/bin/sh", b"#!/usr/bin/env bash", b"#!/bin/bash")
USERINFO = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@")
JJ_SECONDS = 10


class Refused(Exception):
    pass


def _jj(workspace, env, *args):
    """A jj read that neither snapshots nor reads the caller's jj environment, its stdout or a refusal."""
    clean = {"PATH": os.environ.get("PATH", ""), "HOME": str(env.get("HOME") or os.environ.get("HOME", ""))}
    try:
        done = subprocess.run(["jj", "-R", workspace, "--ignore-working-copy", "--color", "never", *args], cwd=workspace, env=clean,
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=JJ_SECONDS, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise Refused(f"jj did not run: {error}") from error
    if done.returncode != 0:
        raise Refused(f"jj {args[0]} {args[1]} failed in {workspace}")
    return done.stdout


def _main_repo(workspace):
    path = os.path.join(workspace, ".jj", "repo")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as pointer:
            path = os.path.join(workspace, ".jj", pointer.read())
    if not os.path.isdir(path):
        raise Refused(f"{workspace} is no jj workspace")
    return os.path.realpath(path)


def _origin(workspace, env):
    for line in _jj(workspace, env, "git", "remote", "list").splitlines():
        words = line.split()
        if len(words) > 1 and words[0] == "origin":
            return USERINFO.sub(r"\1", words[1])
    return None


def _script_sha(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        raise Refused(f"{path} does not open as a regular file: {error.strerror}") from error
    with os.fdopen(fd, "rb") as script:
        if not stat.S_ISREG(os.fstat(script.fileno()).st_mode):
            raise Refused(f"{path} is not a regular file")
        data = script.read()
    first = data.split(b"\n", 1)[0]
    if first.startswith(b"#!") and first not in SHEBANGS:
        raise Refused(f"the first line of {path} is a shebang other than {b', '.join(SHEBANGS).decode()}")
    return hashlib.sha256(data).hexdigest()


def match(command, env):
    found = CALL.fullmatch(command)
    if not found:
        raise Refused("a kind is exactly `bash <absolute workspace>/tasks/grant/<deploy-|push-name>.sh`, with at most one 40-hex argument")
    workspace, task, action = found.groups()
    path = f"{workspace}/{task}"
    if ".." in path or os.path.normpath(path) != path:
        raise Refused(f"{path} is not a normal path")
    if os.path.realpath(os.path.dirname(path)) != os.path.dirname(path):
        raise Refused(f"{path} goes through a symlink")
    main = _main_repo(workspace)
    if workspace not in _jj(workspace, env, "workspace", "list", "-T", 'self.root() ++ "\n"').splitlines():
        raise Refused(f"{workspace} is no workspace its repo lists")
    sha = _script_sha(path)
    if task not in _jj(workspace, env, "file", "list", f'root-file:"{task}"').splitlines():
        raise Refused(f"{task} is not tracked in {workspace}")
    return {"kind": {"action": action, "repo": {"main": main, "origin": _origin(workspace, env)}, "task": task, "sha256": sha},
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
