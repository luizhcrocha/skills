"""A deploy that never asked: the part of hooks/tstack-hook.py that reads a Bash command for a production deploy and refuses
one with no approval (fleet/SPEC.md, "A deploy that never asked").

It is no module of its own. The hook executes this file into its own namespace (`_deploys`), and only for a Bash call in a
session that serves a fleet (`fleet_deploy_gate` in the hook); SessionStart, Stop and a session of no fleet pay for none of
it. In a fleet every Bash call loads it: a script's text names the deploy, so any path can be one, and 98.6% of 25,611 Bash
commands in the local transcripts (2026-11-01) held a `/`, so a test of the command's words would spare almost none and could
drift from DEPLOYS. Python's bytecode in hooks/__pycache__ keeps that load near 1 ms of CPU (`_part_code`). The names this
file uses and does not define (`SHELLS`, `_simple_commands`, `_normal`, `Deny`, `re`, `os`, ...) are the hook's.

It is also a program, the matcher of a 24-hour kind grant: `python3 -I hooks/tstack-hook-deploy.py match`. Stdin is
`{command, cwd, env}`, stdout one JSON line, exit 0: `{kind: {action, repo: {main, origin|null}, bookmark?}, workspace,
scripts: [{path, sha256}]}`, or `{refused: reason}`. Any other mode exits 2. `action` is deploy or push, and `bookmark` comes with
a push; `main` is the realpath of the workspace's `.jj/repo`, which in a secondary workspace is a file holding the path to it;
`workspace` is the folder that holds `.jj`, past each `cd` the text names. `scripts` holds each shell script read and each config
bound, by the path named and by its realpath: the `-c` of a deploy or, with no `-c`, what wrangler 4.150.0 finds up from its cwd
(wrangler.json, then .jsonc, then .toml, and `.wrangler/deploy/config.json` with the config it names), and the `-f` of `secretspec run`.

The matcher is an allow-list. A call gets a kind only if every command in it, and in every script it runs, is on the list; a program
off it refuses wherever it stands, so `node x.js`, `make`, a recipe, a package script and another program's exec have no kind. The
kind is derived from the command, never given. The text holds one action, outside any `if`, and a check ahead of it may stop the
call, so a kind says what a call can do and not that it will. What cannot be read refuses, and so does a push whose bookmark is not a
fast-forward: `B@origin & ::B` is empty, read with --ignore-working-copy. A secret-named `$` refuses, but for the one mapping
fleet-ship/secretspec.toml asks of a command that needs its token: `CLOUDFLARE_API_TOKEN=$CF_WORKERS_EDIT_TOKEN` ahead of `wrangler
deploy` or `wrangler deployments status`, under `secretspec run`.

The hashes bind text, not the tree. A deploy ships what is built when it runs: the `main` and assets a config points at, and the
wrangler binary, are not hashed, nor is the secretspec.toml of a `secretspec run` with no `-f`. A variable exported before this call
(`CLOUDFLARE_ENV`) stays unseen.
"""

if "_simple_commands" not in globals():
    import importlib.util
    import os
    import sys
    _spec = importlib.util.spec_from_file_location(
        "tstack_hook", os.path.join(os.path.dirname(os.path.realpath(__file__)), "tstack-hook.py"))
    _hook = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_hook)
    sys.exit(_hook._deploys()["match_main"](sys.argv[1:], sys.stdin, sys.stdout))

# A production deploy in a fleet waits for its yes (fleet/SPEC.md, "A deploy that never asked"). Auto mode is no such step:
# on 10-31 it let `bash deploy-kit1.sh` through unrefused, and the deploy went out with no approval. fleet_moved_card stops a
# call whose card says no; this stops the call that never asked. It reads what a Bash command runs.
#
# The threat model is the grants' (the hook, above fleet_grant_alone): this is a guard against forgetting, not against a determined agent. It reads the
# command and each shell script the command runs, one level into a script's own `bash other.sh`, as `runsOf` finds them. When
# in doubt it lets a call pass, as a false refusal is the worse failure: the text of a script decides whenever it can be read,
# and a script's name decides only where its text cannot be known yet, at a path that holds an unresolved `$` or a file this
# call writes. What stays unseen: a word built at runtime, `eval`, an alias, a function that hides the word, a script past
# that one level, a script found by a glob or by a variable the text and the session do not hold, if it names no deploy, a
# recipe, a task or a node or python program that holds a deploy under another name, what `ssh` runs elsewhere, a here-document
# fed to a shell, a call or a script past DEPLOY_TEXT_MAX, and a push whose CI deploys.
#
# DEPLOYS is the whole list, one line per deploy as it is typed, found in the repos' justfiles, devenv tasks and
# package.json scripts, in session transcripts and in the ledgers' `[Production Deploy]` rows (2026-11-01). The first word is
# a program, found by its base name, and `run` after a package runner is dropped, so `npm run deploy` is `pnpm deploy`.
# `wrangler versions upload` is not here: a version serves no traffic until `versions deploy` sends it some.
DEPLOYS = (
    "wrangler deploy", "wrangler versions deploy", "wrangler triggers deploy", "wrangler rollback",
    "devenv tasks run fleet:deploy", "devenv tasks run case:deploy", "devenv tasks run case:deploy:release",
    "just deploy", "just redeploy", "just deploy-beta", "just deploy-alpha-ui",
    "pnpm deploy", "pnpm deploy:beta", "pnpm deploy:ui", "pnpm deploy:migrate",
    "pulumi up", "modal deploy", "fly deploy", "flyctl deploy", "systemctl restart fleet-host",
)
DEPLOY_TAILS = {}
for _deploy in DEPLOYS:
    DEPLOY_TAILS.setdefault(_deploy.split()[0], []).append(tuple(_deploy.split()[1:]))
SHELL_READS = frozenset(SHELLS | {".", "source"})  # SHELLS, and the words that read a file in the shell at hand
PACKAGE_RUNNERS = frozenset(("pnpm", "npm", "bun", "yarn"))
DEPLOY_READS = frozenset(("--dry-run", "--help", "-h", "--version", "--show", "--list"))  # a deploy's own flag that deploys nothing
# Words that only lead to the program they run, as permission.ts's LEADERS, with the runners of a package's binaries.
DEPLOY_LEADERS = frozenset(("time", "timeout", "nice", "nohup", "stdbuf", "command", "builtin", "noglob", "exec", "env", "sudo",
                            "xargs", "npx", "pnpx", "bunx", "devenv-run", "dlx", "x", "shell", "vp", *PACKAGE_RUNNERS))
DEPLOY_AFTER_DASHES = frozenset(("secretspec", "op", "dotenvx", "devenv", "nix", "fleet"))  # each runs what follows its `--`
# The flags that take a value, of a program that leads to another or runs a package's script; its other flags take none, so
# `xargs -0 grep` runs grep and `pnpm --filter deploy test` runs test. A program not here has both readings (_past_flags).
_RUNNER_VALUES = ("--filter", "-F", "-C", "--dir", "--cwd", "--prefix", "-w", "--workspace", "--loglevel", "--reporter")
DEPLOY_VALUE_FLAGS = {
    **dict.fromkeys(PACKAGE_RUNNERS, frozenset(_RUNNER_VALUES)),
    "npx": frozenset(("-p", "--package", "-c", "--call")), "pnpx": frozenset(("-p", "--package", "-c", "--call")),
    "bunx": frozenset(("-p", "--package")), "timeout": frozenset(("-k", "-s", "--kill-after", "--signal")),
    "nice": frozenset(("-n", "--adjustment")), "stdbuf": frozenset(("-i", "-o", "-e", "--input", "--output", "--error")),
    "env": frozenset(("-u", "-C", "-S", "--unset", "--chdir", "--split-string")),
    "time": frozenset(("-f", "-o", "--format", "--output")),
    "sudo": frozenset(("-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t", "--user", "--group", "--chdir")),
    "xargs": frozenset(("-I", "-n", "-P", "-L", "-s", "-E", "-d", "-a", "--replace", "--max-args", "--max-procs", "--max-lines",
                        "--max-chars", "--eof", "--delimiter", "--arg-file", "--process-slot-var")),
}
# A file of a language: not read as a shell's, whoever is given it, unless its own `#!` names a shell.
SOURCE_EXTENSIONS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".pl", ".lua", ".php")
DEPLOY_SCRIPT_READS = {"deploy-worker": frozenset(("--digest", "--release", "--preflight"))}  # its modes that stop before a deploy
DEPLOY_NAMED = ("deploy", "rollback")  # in the name of a script whose text cannot be known yet, what refuses it
DEPLOY_TEXT_MAX = 256 * 1024  # a command or a script past this is not read: every real one is a few KB
DEPLOY_PIECE_MAX = 64 * 1024
DEPLOY_NEST_MAX = 4  # `sh -c` inside `sh -c`
DEPLOY_RUNS_MAX = 64  # the commands one simple command is read for: a leader's flags are few
DEPLOY_HOPS = 2  # the script a command runs, and the one its own `bash other.sh` runs
DEPLOY_FILES_MAX = 16
DEPLOY_WORDS_MAX = 5  # the longest of DEPLOYS past its program, and a `run`
DEPLOY_WRITERS = frozenset(("tee", "cp", "mv", "install", "ln"))
ASK_BY_NAME = frozenset(("wrangler", "just", "pnpm", "npm", "bun"))  # the programs an ask holds with no script: _named_call
ASK_CANNOT_HOLD = re.compile(r"[^ -~]|[$`*|<\\]")  # whyNoRule's and whyNoAsk's characters, fleet/src/ledger/permission.ts
WRITTEN_RE = re.compile(r"""(?:^|[\s\d&])>{1,2}\|?\s*["']?([^\s"';|&<>]+)""")  # a redirection's target
ASSIGNMENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\+?=")
SHELL_NAME_RE = re.compile(r"\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})")

# One deploy a Bash command reaches: `piece`, the simple command of the call that reaches it, which is what an owner's rule
# is held against; `what`, the DEPLOYS entry, or "" when `unread`; `script`, the absolute path of the file of the call that
# holds it, or None when it stands in the call; `unread`, why a script named for a deploy cannot be read yet.
Deploying = namedtuple("Deploying", "piece what script unread")
# One read of a call: `env`, the variables the session holds; `files`, each script read, by its path; `written`, the name of
# each file the text read so far writes.
Reading = namedtuple("Reading", "env files written")


def _past_flags(args, i=0, takes=None):
    """Each index of `args` from `i` that their command or subcommand may stand at: past a duration (`timeout 60`) and past each
    flag, one of `takes` with its value, any other alone. With no `takes`, a flag's value is not known, and each reading
    stands: `wrangler -c x deploy` and `wrangler --keep-vars deploy` both reach `deploy`."""
    at, n = [], len(args)
    while i < n:
        word = args[i]
        if word.startswith("-"):
            i += 1
            if takes is not None:
                i += word in takes
                continue
            at.append(i)
            if i < n and not args[i].startswith("-"):
                i += 1
        elif word[:1].isdigit():
            i += 1
        else:
            break
    return [*at, min(i, n)]


def _deploy_at(run):
    """The DEPLOYS entry that `run`, a command from its program, is, or None: its words past the flags, whole, in order."""
    name = os.path.basename(run[0])
    runner = name in PACKAGE_RUNNERS
    tails = DEPLOY_TAILS.get("pnpm" if runner else name)
    args = run[1:]
    if tails is None or not DEPLOY_READS.isdisjoint(args):
        return None
    plain, before = [], []  # the words that are no flag; `before[k]`, how many of them stand ahead of args[k]
    for word in args:
        before.append(len(plain))
        if not word.startswith("-"):
            plain.append(word)
    before.append(len(plain))
    for at in dict.fromkeys(before[k] for k in _past_flags(args, takes=DEPLOY_VALUE_FLAGS.get(name))):
        words = plain[at:at + DEPLOY_WORDS_MAX]
        if runner and words[:1] in (["run"], ["run-script"]):
            words = words[1:]
        for tail in tails:
            if len(words) >= len(tail) and all(w in (t, f"{t}.service") or w.startswith(f"{t}@") for w, t in zip(words, tail)):
                return " ".join(("pnpm" if runner else name, *tail))
    return None


def _runs_of(words):
    """Each command `words` may run, as (words from its program, sure), `sure` when no flag's value could stand there: past the
    shell's leading words, a case's pattern and assignments, past a leader with its flags, and past the first `--` of a
    runner. Each index is visited once, so a long line of leaders ends."""
    runs, seen, todo, n = [], set(), [(0, True)], len(words)
    while todo and len(runs) < DEPLOY_RUNS_MAX:
        i, sure = todo.pop()
        while i < n and (words[i] in SHELL_LEADERS or words[i].endswith(")") or ASSIGNMENT_RE.match(words[i])):
            i += 1  # the last of these is a case's pattern
        if i >= n or i in seen:
            continue
        seen.add(i)
        runs.append((words[i:], sure))
        name = os.path.basename(words[i])
        if name == "direnv":  # `direnv exec DIR COMMAND`
            todo.append((i + 3, sure))
        elif name in DEPLOY_LEADERS:
            starts = _past_flags(words, i + 1, DEPLOY_VALUE_FLAGS.get(name))
            todo.extend((k, sure and len(starts) == 1) for k in starts)
        elif name in DEPLOY_AFTER_DASHES:
            ends = ("--", "--command", "-c") if name == "nix" else ("--",)
            todo.extend(next(([(k + 1, sure)] for k in range(i + 1, n) if words[k] in ends), []))
    return runs


def _without_substitutions(piece):
    """`piece` with what its `$( )` and backticks hold left out, but for a `pwd`, which is `$PWD`: _simple_commands lists each
    as a command of its own, and its words are none of this command's. A single-quoted word stays whole, as `sh -c` runs it."""
    if "$(" not in piece and "`" not in piece:
        return piece
    out, i, n = [], 0, len(piece)
    while i < n:
        if piece[i] == "\\":
            out.append(piece[i:i + 2])
            i += 2
        elif piece[i] == "'":
            j = piece.find("'", i + 1)
            j = n if j < 0 else j + 1
            out.append(piece[i:j])
            i = j
        elif piece.startswith("$(", i):
            depth, start, i = 1, i + 2, i + 2
            while i < n and depth:
                depth += (piece[i] == "(") - (piece[i] == ")")
                i += 1
            out.append("$PWD" if piece[start:i - 1].strip() == "pwd" else "$()")
        elif piece[i] == "`":
            j = piece.find("`", i + 1)
            start, i = i + 1, n if j < 0 else j + 1
            out.append("$PWD" if piece[start:i - 1].strip() == "pwd" else "$()")
        else:
            out.append(piece[i])
            i += 1
    return "".join(out)


def _piece_words(piece):
    """A simple command as words, with no redirection; None past DEPLOY_PIECE_MAX. Words that shlex cannot split (a `$'…'` it
    reads as an open quote) split on spaces."""
    import shlex
    if len(piece) > DEPLOY_PIECE_MAX:
        return None
    text = _without_redirections(_without_substitutions(piece)).replace("\\\n", "")
    try:
        return shlex.split(text)
    except ValueError:
        return text.split()


def _shell_words(run):
    """(the flags of a shell's command, the words past them): `-o` and `-O` each take the word after them, so `bash -euo
    pipefail -c` reaches its `-c`."""
    flags, i, n = [], 1, len(run)
    while i < n and run[i][:1] in ("-", "+") and len(run[i]) > 1:
        flags.append(run[i])
        i += 1
        if flags[-1] == "--":
            break
        if not flags[-1].startswith("--") and flags[-1][-1] in "oO":
            i += 1
    return [f for f in flags if not f.startswith("--")], run[i:]


def _shell_text(run):
    """The text of a shell's `-c`, or None when it runs no such text."""
    flags, rest = _shell_words(run)
    return rest[0] if rest and any("c" in f for f in flags) else None


def _script_word(run, sure):
    """The file `run` executes where its words name one, as permission.ts's scriptsOf: a shell's first word that is no flag,
    or a program given by a path where no flag's value could stand, but for one of DEPLOYS or a leader by its path, which
    _deploy_at and _runs_of read. None when it only reads (`bash -n`, a mode of DEPLOY_SCRIPT_READS). A node or python program
    is no shell text, and stays unread."""
    program = os.path.basename(run[0])
    word = None
    if program in SHELL_READS:
        flags, rest = _shell_words(run)
        if any("n" in f for f in flags):
            return None
        word = rest[0] if rest else None
    elif sure and "/" in run[0] and program not in DEPLOY_TAILS and program not in DEPLOY_LEADERS:
        word = run[0]
    if word is None or len(word.split()) > 1:
        return None
    return None if DEPLOY_SCRIPT_READS.get(os.path.basename(word), frozenset()).intersection(run[1:]) else word


def _expanded(word, names):
    """`word` with each `$NAME` and `${NAME}` the text assigned, and a leading `~`; a name it did not assign stays."""
    if word == "~" or word.startswith("~/"):
        word = names.get("HOME", "~") + word[1:]
    return SHELL_NAME_RE.sub(lambda m: names.get(m.group(1) or m.group(2), m.group(0)), word) if "$" in word else word


def _read_script(word, places):
    """(path, bytes) of the file `word` names, the first of `places` that has it; bytes None when none can be read. Up to
    one byte past the limit, opened as _regular_bytes opens: a FIFO, a device or a missing file is no read, and none hangs."""
    if any(c in word for c in "$`*?"):
        return word, None
    for place in ([""] if os.path.isabs(word) else places):
        path = os.path.realpath(os.path.join(place, word))
        data = _regular_bytes(path, head=DEPLOY_TEXT_MAX + 1)
        if data is not None:
            return path, data
    return os.path.join(places[0], word), None


def _names_deploy(text):
    lowered = text.lower()
    return any(word in lowered for word in DEPLOY_NAMED)


def _shebang_is_shell(line):
    """Whether a `#!` line runs a shell, by the exact name of its interpreter, past `env` with its flags and assignments."""
    words = line[2:].decode("utf-8", "replace").split()
    if words and os.path.basename(words[0]) == "env":
        words = [w for w in words[1:] if not w.startswith("-") and "=" not in w]
    return bool(words) and os.path.basename(words[0]) in SHELLS


def _is_shell_text(data, name, by_shell):
    """Whether the file `name` is shell text: its `#!` names a shell; or it is no file of a language (SOURCE_EXTENSIONS) and it
    is given to a shell or has no `#!` line, which runs it in one. A binary is not."""
    if b"\0" in data:
        return False
    line = data[:256].split(b"\n", 1)[0]
    shebang = line.startswith(b"#!")
    if shebang and _shebang_is_shell(line):
        return True
    return not name.endswith(SOURCE_EXTENSIONS) and (by_shell or not shebang)


def _script_deploys(word, run, places, hops, names, reading):
    """(what, script, unread) of each deploy the script `word` holds, its own path as `script`. Its text decides. Where the text
    is not known yet, as this call writes the file or its path holds an unresolved `$`, its name does, with no `script`. Any
    other file that cannot be read passes: a missing file cannot run."""
    where = _expanded(word, names)
    path, data = _read_script(where, places)
    name = os.path.basename(where)
    by_shell = os.path.basename(run[0]) in SHELL_READS
    shell = data is not None and _is_shell_text(data, name, by_shell)
    if _names_deploy(name) and (shell or (data is None and not name.endswith(SOURCE_EXTENSIONS))):
        if name in reading.written:
            return [("", None, f"runs {word}, named for a deploy, and writes it in this same call")]
        if data is None and ("$" in where or "`" in where):
            return [("", None, f"runs {word}, named for a deploy, at a path known only when it runs")]
    # No flag of a script's makes it a read: `bash deploy-kit1.sh --help` deployed, as that script ignores its flags. The one
    # exception is deploy-worker's modes in DEPLOY_SCRIPT_READS, which _script_word has already read as no script.
    if not shell or len(data) > DEPLOY_TEXT_MAX:
        return []
    if path in reading.files:
        return reading.files[path]
    if len(reading.files) >= DEPLOY_FILES_MAX:
        return []
    reading.files[path] = []
    inner = (*places, os.path.dirname(path)) if os.path.isabs(path) else places
    found = _text_deploys(data.decode("utf-8", "replace"), inner, hops + 1, {**reading.env, "PWD": places[0]}, reading)
    reading.files[path] = [(what, path, unread) for what, _, unread in found]
    return reading.files[path]


def _text_deploys(text, places, hops, names, reading, nest=0):
    """(what, script, unread) of each deploy a shell text reaches, for the piece of the call it stands in."""
    found = []
    for piece, reached in _pieces_deploys(text, places, hops, names, reading, nest):
        found.extend(reached)
    return found


def _line_pieces(line):
    try:
        return _simple_commands(line)
    except (ValueError, IndexError):
        return [line]


def _written_by(piece, words, names):
    """The name of each file a simple command writes: a redirection's target, the files of `tee` and the last word of `cp` and
    its like. Other writers stay unseen."""
    targets = WRITTEN_RE.findall(piece) if ">" in piece else []
    for run, _ in _runs_of(words):
        program = os.path.basename(run[0])
        if program == "tee":
            targets += [w for w in run[1:] if not w.startswith("-")]
        elif program in DEPLOY_WRITERS and len(run) > 1:
            targets.append(run[-1])
    return {os.path.basename(_expanded(target, names)) for target in targets}


def _pieces_deploys(text, places, hops, names, reading, nest):
    """(piece, [(what, script, unread)...]) of each simple command of a shell text that reaches a deploy. A `cd` to a path
    it names moves where a later relative script is looked for, whatever joins the two, and `S=/x` lets `bash $S/y.sh`
    be read: `names` holds the session's variables and what the text assigned. A text that does not parse is read
    line by line, following no file: _simple_commands refuses some real scripts, and a mention must stay a mention. A text
    past DEPLOY_TEXT_MAX, or a command past DEPLOY_PIECE_MAX, is not read."""
    if len(text) > DEPLOY_TEXT_MAX:
        return []
    try:
        pieces = _simple_commands(text)
    except (ValueError, IndexError):
        pieces, hops = [p for line in text.split("\n") for p in _line_pieces(line)], DEPLOY_HOPS
    out = []
    for piece in pieces:
        words = _piece_words(piece)
        if words is None:
            continue
        if words and all(ASSIGNMENT_RE.match(w) for w in words):
            names.update((k, _expanded(v, names)) for k, v in (w.split("=", 1) for w in words))
        moved = words[:1] == ["cd"] and len(words) > 1 and "$" not in _expanded(words[1], names)
        if moved:
            places = (os.path.join(places[0], _expanded(words[1], names)), *places)
            names["PWD"] = places[0]
        reached = []
        for run, sure in _runs_of(words):
            what = _deploy_at(run)
            shell = _shell_text(run) if os.path.basename(run[0]) in SHELLS else None
            script = None if what or shell is not None else _script_word(run, sure)
            if what:
                reached.append((what, None, None))
            elif shell is not None and nest < DEPLOY_NEST_MAX:
                reached.extend(_text_deploys(shell, places, hops, names, reading, nest + 1))
            elif script and hops < DEPLOY_HOPS:
                reached.extend(_script_deploys(script, run, places, hops, names, reading))
        reading.written.update(_written_by(piece, words, names))
        if reached:
            out.append((piece, reached))
    return out


def deploys_of(command, cwd, env):
    """Each deploy a Bash command run in `cwd` reaches (Deploying), the data fleet_deploy_gate decides on. `env` holds the
    variables of the session, whose values let `bash $CLAUDE_PROJECT_DIR/x.sh` be read."""
    seed = {**(env or {}), "PWD": cwd}
    return [Deploying(piece, what, script, unread)
            for piece, reached in _pieces_deploys(command, (cwd,), 0, dict(seed), Reading(seed, {}, set()), 0)
            for what, script, unread in reached]


def _rule_holds(call, text):
    """Whether an allow rule's call holds `text`: the text itself, `prefix:*`, or `*` anywhere, as Claude Code reads a rule. No
    regular expression: a rule is the owner's to write, and a command can be long."""
    parts = (f"{call[:-2]} *" if call.endswith(":*") else call).split("*")
    if len(parts) == 1:
        return text == call
    if parts[-1] == "" and len(parts) == 2 and text == parts[0].rstrip():
        return True
    if not text.startswith(parts[0]) or len(text) < len(parts[0]) + len(parts[-1]):
        return False
    at = len(parts[0])
    for part in parts[1:-1]:
        at = text.find(part, at)
        if at < 0:
            return False
        at += len(part)
    return at <= len(text) - len(parts[-1]) and text.endswith(parts[-1])


def _owner_rule(hook, grants, piece):
    """Whether the owner's settings allow `piece`: a Bash rule of the folder's settings or of ~/.claude/settings.json. A rule
    on the record of grants is a grant's, used or not, and the owner's only once its take-back made it theirs (_kept_of)."""
    root, home = _session_root(hook), hook.env.get("HOME")
    files = [os.path.join(root, ".claude", name) for name in (GRANT_FILES[0], "settings.json")] if root else []
    files += [os.path.join(home, ".claude", "settings.json")] if home else []
    grants_of = {g["rule"] for g in grants if not g["kept"]}
    text = _normal(piece)
    for file in files:
        for rule in _allow_of(hook, file) or ():
            call = _bash_call(rule)
            if call and rule not in grants_of and _rule_holds(call, text):
                return True
    return False


def _unapproved(hook, command, found):
    """Those of `found` nothing lets through. A standing one-time grant this call holds, which an allow-kind answer writes as
    allow-once does, lets them all through: fleet_grant_alone holds the exact call to one run, and refuses it inside more
    with its own words, which a refusal here would stand beside, asking for a second card. An owner's rule lets through the
    pieces it holds. Nothing else does: a card answered no writes neither."""
    grants = []
    for d in grant_state_dirs(hook):
        raw, _ = _read_grants(d)
        if raw is not None:  # fleet_grant_alone refuses on a record it cannot read
            grants += [g for g in _latest_grants(hook, raw) if _bash_call(g["rule"]) is not None]
    if any(g["issued"] is not None and _live(hook, g) and _holds_call(command, _bash_call(g["rule"])) for g in grants):
        return []
    return [deploy for deploy in found if not _owner_rule(hook, grants, deploy.piece)]


def _script_args(piece):
    """The words after the script the simple command `piece` runs, or None when it runs no script by itself (a `sh -c`)."""
    for run, sure in _runs_of(_piece_words(piece) or []):
        word = _script_word(run, sure)
        if word:
            return run[run.index(word) + 1:]
    return None


def _named_call(command, deploy):
    """`command` as an ask can hold it, a deploy found by name, or None: whyNoCommand of fleet/src/ledger/permission.ts holds the
    programs of ASK_BY_NAME run as they are, and no wrapper, path, assignment or character of ASK_CANNOT_HOLD."""
    program = (_piece_words(deploy.piece) or [""])[0]
    held = program in ASK_BY_NAME and ("pnpm" if program in PACKAGE_RUNNERS else program) == deploy.what.split()[0]
    return command if held and not ASK_CANNOT_HOLD.search(command) else None


def _deploy_refusal(hook, d, command, found):
    """The refusal of a deploy with no approval: the deploy, and the exact command that asks for it. A script whose text is not
    known yet has nothing a card could bind, so that refusal prints no ask: the CLI would refuse it."""
    import shlex
    first = next((f for f in found if f.unread and not f.script), None) or next((f for f in found if f.script), found[0])
    rule = "In a fleet a deploy runs only on the user's yes, whatever auto mode lets through."
    if first.unread and not first.script:
        return (f"tstack: this command {first.unread}, so it may put out a deploy, and no approval stands for it. {rule} Split the "
                "call: put the script at a path this hook can read, then run it by that path in a call of its own, and if it "
                "deploys the refusal prints the ask.")
    root = _session_root(hook) or hook.cwd
    if first.unread:
        what = f"{first.script} {first.unread}, so it may put out a deploy, and no approval stands for it"
    else:
        what = f"this command puts out a production deploy (`{first.what}`{f', in {first.script}' if first.script else ''}), " \
               "and no approval stands for it"
    step = "send your coordinator this command to run, and stop there" if fleet_worker(hook) else "ask with this command"
    call, how = None, step.capitalize()
    if first.script:
        args = _script_args(first.piece)
        if args is not None and not any(ASK_CANNOT_HOLD.search(arg) for arg in args):
            call = shlex.join(("bash", first.script, *args))
        else:
            how = ("A card cannot hold this call as it stands (a `sh -c`, or an argument with one of $ ` * | < \\\\ or a character "
                   f"past ASCII), so it needs a script that takes no arguments: put the call in one, then {step}")
    else:
        call = _named_call(command, first)
        how = (f"A command found by name is asked for as it is, and the card says its content is not bound. {how}" if call else
               f"A card holds this form only as a script: put the command in a script at an absolute path, so the card can bind "
               f"its file, then {step}")
    call = call or f"bash {os.path.join(root, 'tasks', 'deploy.sh')}"
    agent = hook.input.get("agent_id")
    ask = (f"{fleet_cli()} state {d} decision deploy-{int(fleet_now(hook.env)) % 100000:05d} --kind permission --tool Bash "
           f"--call {shlex.quote(call)}{f' --agent-id {agent}' if agent else ''} --root {root} --title \"<the plain question>\" "
           "--why \"<what goes live, and what still runs on that repo>\" --recommend allow-once "
           "--reason \"<why this one is safe>\" --blocking")
    return (f"tstack: {what}. {rule} {how}:\n\n{ask}\n\n"
            "When its grant stands, run that call by itself, unchanged (coordinator skill, \"Ask for the permission before the call\").")


def _deploy_gate(hook, command, dirs):
    """The decision of fleet_deploy_gate on a Bash command in a session of the fleets `dirs`: a call that reaches a deploy
    (DEPLOYS, deploys_of) and that nothing lets through is refused. A failure on a call that names no deploy denies nothing,
    and past that name it denies."""
    try:
        found = deploys_of(command, hook.cwd, hook.env)
        unapproved = _unapproved(hook, command, found) if found else []
        return Deny(_deploy_refusal(hook, dirs[0], command, unapproved)) if unapproved else None
    except Exception:
        log(hook.data_dir, f"{hook.event} fleet_deploy_gate failed\n{traceback.format_exc()}")
        if not _names_deploy(command):
            return None
        return Deny(f"tstack: this command names a deploy, and the check of it failed, so no approval can be told; the trace is in "
                    f"{hook.data_dir / 'hook.log'}.")


# What the matcher refuses wherever it stands, in the command or in a script it reads. A word is whole, so `--rm` and `no-op` are
# not `--force` and `op`.
SECRET_NAME = r"(?i)\$\{?\w*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL)"
SECRET_FILE = r"(?:.*/)?(?:\.env|\.dev\.vars)(?:\..*)?|/proc/.*/environ"
SET_FLAGS = frozenset(("-e", "-u", "-eu"))
GRAMMAR_SHELLS = frozenset(("sh", "bash", "dash"))
PIPE_INTO = frozenset(("grep", "head", "tail", "sed", "jq"))
NOT_PIPED = frozenset(("set", "[", "test", "sleep", "exit"))
NO_REDIRECT = frozenset(("set", "echo", "printf", "exit"))
SCRIPT_NAME = r"[a-z][a-z0-9_]*|[A-Z][0-9]?"  # a variable of a script: no name an exported one of a tool's would hold
AHEAD_OF_COMMAND = frozenset(("TZ", "LC_ALL", "LANG", "NO_COLOR", "FORCE_COLOR", "CI", "TERM"))
TOKEN_MAPPED = "CLOUDFLARE_API_TOKEN=$CF_WORKERS_EDIT_TOKEN"
TOKEN_MAPPING = ("CLOUDFLARE_API_TOKEN", [("lit", "", False), ("var", "CF_WORKERS_EDIT_TOKEN", False)])
WRITTEN_SUFFIXES = (".log", ".txt", ".out", ".err")
WRANGLER_DEPLOY_FLAGS = frozenset(("--keep-vars", "--minify", "--no-bundle", "--upload-source-maps", "--strict"))
WRANGLER_DEPLOY_VALUES = frozenset(("--tag", "--message", "--old-asset-ttl"))
WRANGLER_READS = (("deployments", "status"), ("versions", "list"))
WRANGLER_CONFIGS = ("wrangler.json", "wrangler.jsonc", "wrangler.toml")
WRANGLER_REDIRECT = ".wrangler/deploy/config.json"
JJ_READS = frozenset(("log", "diff", "status", "show"))
JJ_READ_FLAGS = frozenset(("--ignore-working-copy", "--no-pager", "--no-graph", "--reversed", "--summary", "-s", "--stat", "--git", "--name-only"))
JJ_READ_VALUES = frozenset(("-r", "--revisions", "--revision", "-T", "--template", "-n", "--limit", "--from", "--to", "--color"))
GREP_VALUES = frozenset(("-e", "-m", "-A", "-B", "-C"))
SED_PRINT = (r"(?:\d+(?:,\d+)?|\$|/(?:[^/\\\n]|\\.)*/)?p"
             r"|s/(?:[^/\\\n]|\\.)*/(?:[^/\\\n]|\\.)*/[gI\d]*p[gI\d]*")
JQ_BARRED = r"\benv\b|\$ENV|\binput_filename\b|\bimport\b|\binclude\b"
JJ_NAME = r"[A-Za-z0-9][A-Za-z0-9._/-]*"
JJ_REVISION = r"[A-Za-z0-9@][A-Za-z0-9._/@+-]*"
JJ_TIMEOUT = 15


class _NoKind(Exception):
    """Why a call gets no kind."""


class _Call:
    """What the reading of one call gathers, across every text it runs: `actions`, each (action, kind fields, start folder);
    `moves`, each `jj bookmark set` as (bookmark, revision, folder); `bound`, the sha256 of each script and config by path;
    `ran`, the realpath of each of them; `written`, the realpath of each file a redirection writes; `inside`, each (what, path)
    that must sit in the action's workspace; `reads`, each file a command reads."""

    def __init__(self, env):
        self.env, self.actions, self.moves, self.bound, self.ran, self.written = env, [], [], {}, set(), set()
        self.inside, self.reads, self.script_runs = [], [], 0

    def bind(self, named, real, data):
        import hashlib
        self.bound[named] = self.bound[real] = hashlib.sha256(data).hexdigest()
        self.ran.add(real)


class _Scope:
    """One shell as read: `cwd`, logical as the shell keeps it; `names`, each variable's literal value, None when only a run can
    tell; `assigned`, the names the text gave a value; `depth`, the `if`s around the command; `guarded`, whether this shell runs
    under an `if`; `secret`, whether `secretspec run` leads it; `hops` and `nest`, the scripts and `sh -c`s above it."""

    def __init__(self, cwd, env, hops=0, nest=0, guarded=False, secret=False):
        self.cwd, self.env, self.hops, self.nest, self.guarded, self.secret = cwd, env, hops, nest, guarded, secret
        self.names, self.assigned, self.depth = {**env, "PWD": cwd}, set(), 0

    def shell(self, hops=0, nest=0):
        """The scope of a shell this one starts: no variable of this text reaches it."""
        return _Scope(self.cwd, self.env, self.hops + hops, self.nest + nest, self.guarded or self.depth > 0, self.secret)

    def led(self):
        """This scope with `secretspec run` ahead of the command: the words still expand here."""
        scope = self.shell()
        scope.secret, scope.names, scope.assigned = True, self.names, self.assigned
        return scope

    def path(self, word):
        return os.path.realpath(os.path.join(self.cwd, word))


def _dollar(text, i, quoted):
    """The part the `$` at `i` starts, as (kind, value, quoted), and the index past it. A form that is not a plain name or a
    `$( )` refuses: arithmetic, `$'…'`, `${x:-y}`, `${!x}`, `$?`, `$1`, `$@`."""
    if text.startswith("$((", i):
        raise _NoKind("arithmetic")
    if text.startswith("$(", i):
        end = _substitution_end(text, i + 2)
        return ("sub", text[i + 2:end], quoted), end + 1
    named = SHELL_NAME_RE.match(text, i)
    if not named:
        raise _NoKind(f"the form {text[i:i + 3]!r}")
    return ("var", named[1] or named[2], quoted), named.end()


def _substitution_end(text, i):
    """The index of the `)` that closes the `$(` before `i`. A substitution holds one command, so anything nested refuses."""
    n, quote = len(text), None
    while i < n:
        c = text[i]
        if quote == "'":
            quote = None if c == "'" else quote
        elif c == "\\":
            i += 1
        elif c == "`" or text.startswith("$(", i) or (not quote and c == "("):
            raise _NoKind("a substitution inside a substitution")
        elif c == '"':
            quote = None if quote else c
        elif c == "'" and not quote:
            quote = c
        elif c == ")" and not quote:
            return i
        i += 1
    raise _NoKind("a substitution that does not close")


def _double_quoted(text, i):
    """The parts of the double-quoted text that starts at `i`, and the index past its closing quote."""
    parts, out, n = [], [], len(text)
    while i < n:
        c = text[i]
        if c == '"':
            parts.append(("lit", "".join(out), True))
            return parts, i + 1
        if c == "`":
            raise _NoKind("a backtick")
        if c == "\\" and i + 1 < n:
            following = text[i + 1]
            out.append(following if following in '$`"\\' else "" if following == "\n" else c + following)
            i += 2
        elif c == "$":
            parts.append(("lit", "".join(out), True))
            out = []
            part, i = _dollar(text, i, True)
            parts.append(part)
        else:
            out.append(c)
            i += 1
    raise _NoKind("a quote that does not close")


def _checked_word(parts):
    """`parts` as a word, when no part of it is a secret-named variable, a glob, a brace or a tilde."""
    shown = "".join("$" + value if kind == "var" else value if kind == "lit" else "" for kind, value, _ in parts)
    named = "".join("$" + value if kind == "var" else value.replace(TOKEN_MAPPED, "") if kind == "lit" else "" for kind, value, _ in parts)
    if re.search(SECRET_NAME, named) and _assignment_of(parts) != TOKEN_MAPPING:
        raise _NoKind(f"a secret-named variable in {shown[:80]!r}")
    for kind, value, quoted in parts:
        if kind == "lit" and not quoted:
            if re.search(r"[*?{}]", value) or (re.search(r"[\[\]]", value) and shown not in ("[", "]")):
                raise _NoKind(f"a glob or a brace in {shown[:80]!r}")
            if re.search(r"(?:^|[=:])~", value):
                raise _NoKind(f"a tilde in {shown[:80]!r}")
    return parts


def _lex_operator(text, i, parts, tokens):
    """The operator at `i`, added to `tokens` past the word it ends; the index past it. An `&`, a `<`, a `(`, a `;;`, `>>`, `>|`
    and every duplication but `2>&1` refuse here, whatever they hold."""
    c = text[i]
    fd = "1"
    if c == ">" and parts and len(parts) == 1 and parts[0][0] == "lit" and not parts[0][2] and parts[0][1].isdigit():
        fd, parts = parts[0][1], None
    if parts is not None:
        tokens.append(("word", _checked_word(parts)))
    if c == ">":
        if text.startswith(">&1", i) and fd == "2":
            tokens.append(("dup", fd))
            return i + 3
        if text[i + 1:i + 2] in (">", "|", "&", "("):
            raise _NoKind(f"the redirection {text[i:i + 2]}")
        tokens.append(("redirect", fd))
        return i + 1
    if text.startswith(("&&", "||"), i):
        tokens.append(("op", text[i:i + 2]))
        return i + 2
    if c == "&":
        raise _NoKind("a command in the background")
    if c == "<":
        raise _NoKind("a command fed from a file, a here-document or a process")
    if c in "()":
        raise _NoKind("a subshell or a function")
    if text.startswith((";;", "|&"), i):
        raise _NoKind(f"the operator {text[i:i + 2]}")
    tokens.append(("op", c))
    return i + 1


def _lex(text):
    """`text` as tokens: ("word", parts), ("op", `&&`, `||`, `|`, `;` or a newline), ("redirect", fd), ("dup", fd). A word's parts
    are (kind, value, quoted), kind lit, var or sub. What the grammar has no token for refuses."""
    tokens, parts, i, n = [], None, 0, len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            if i + 1 == n:
                raise _NoKind("a trailing backslash")
            if text[i + 1] != "\n":
                parts = [*(parts or []), ("lit", text[i + 1], True)]
            i += 2
        elif c == "'":
            end = text.find("'", i + 1)
            if end < 0:
                raise _NoKind("a quote that does not close")
            parts = [*(parts or []), ("lit", text[i + 1:end], True)]
            i = end + 1
        elif c == '"':
            held, i = _double_quoted(text, i + 1)
            parts = [*(parts or []), *held]
        elif c == "$":
            part, i = _dollar(text, i, False)
            parts = [*(parts or []), part]
        elif c == "`":
            raise _NoKind("a backtick")
        elif c in " \t":
            if parts is not None:
                tokens.append(("word", _checked_word(parts)))
            parts = None
            i += 1
        elif c in "\n;|&<>()":
            i = _lex_operator(text, i, parts, tokens)
            parts = None
        elif c == "#" and parts is None:
            i = text.find("\n", i) if "\n" in text[i:] else n
        else:
            start = i
            while i < n and text[i] not in " \t\n;|&<>()'\"$`\\":
                i += 1
            parts = [*(parts or []), ("lit", text[start:i], False)]
    if parts is not None:
        tokens.append(("word", _checked_word(parts)))
    return tokens


def _word_text(word, scope, shell_text=False):
    """(the word with the text's literal values in it, whether a `$` stays that only a run can tell). A substitution anywhere but
    a plain assignment refuses, and so does a variable the text never gave a value, when `secretspec run` leads the shell. Only
    a `sh -c` text, read as commands in its turn, may hold TOKEN_MAPPED."""
    out, live = [], False
    for kind, value, quoted in word:
        if kind == "sub":
            raise _NoKind("a command substitution outside an assignment")
        if kind == "lit":
            if TOKEN_MAPPED in value and not shell_text:
                raise _NoKind(f"{TOKEN_MAPPED} as a plain word")
            out.append(value)
            continue
        if re.search(SECRET_NAME, "$" + value):
            raise _NoKind(f"the secret-named ${value} in a word")
        if scope.secret and value != "PWD" and value not in scope.assigned:
            raise _NoKind(f"${value} under `secretspec run`, which the text never set")
        held = scope.names.get(value)
        if not isinstance(held, str):
            live = True
            out.append("$" + value)
        elif not quoted and re.search(r"[\s*?\[\]{}~]", held):
            raise _NoKind(f"${value} unquoted, which splits")
        else:
            out.append(held)
    return "".join(out), live


def _literal(word, scope, what, shell_text=False):
    """The text of a word that must hold no `$`."""
    text, live = _word_text(word, scope, shell_text)
    if live or "$" in (text.replace(TOKEN_MAPPED, "") if shell_text else text):
        raise _NoKind(f"{what} known only when it runs: {text}")
    return text


class _Tokens:
    def __init__(self, tokens):
        self.tokens, self.at = tokens, 0

    def peek(self):
        return self.tokens[self.at] if self.at < len(self.tokens) else None

    def advance(self):
        self.at += 1

    def op(self):
        """The operator here, if one is, or None."""
        token = self.peek()
        return token[1] if token and token[0] == "op" else None

    def reserved(self):
        """`if`, `then` or `fi` when the word here is that, unquoted."""
        token = self.peek()
        if token and token[0] == "word" and len(token[1]) == 1 and token[1][0][0] == "lit" and not token[1][0][2]:
            return token[1][0][1] if token[1][0][1] in ("if", "then", "fi") else None
        return None

    def simple(self):
        """The words and the redirections up to the next operator: each redirection (fd, target word, or None for `2>&1`)."""
        words, redirects = [], []
        while (token := self.peek()) and token[0] != "op":
            self.advance()
            if token[0] == "word":
                words.append(token[1])
            elif token[0] == "dup":
                redirects.append((token[1], None))
            else:
                target = self.peek()
                if not target or target[0] != "word":
                    raise _NoKind("a redirection with no target")
                self.advance()
                redirects.append((token[1], target[1]))
        return words, redirects


# Where one command stands in its text: `joined`, the `;`, `&&` or `||` ahead of its pipeline; `after_cd`, whether what that joins
# is an accepted cd; `stage`, its place in its pipeline; `piped`, whether a pipe touches it; `follows`, the operator past it.
_At = namedtuple("_At", "joined after_cd stage piped follows")


def _read_text(text, scope, call):
    """Reads `text` under the grammar, or raises why not."""
    if len(text) > DEPLOY_TEXT_MAX:
        raise _NoKind(f"a text past {DEPLOY_TEXT_MAX} bytes")
    _read_list(_Tokens(_lex(text)), scope, call, ())


def _read_list(tokens, scope, call, stops):
    """Reads commands up to the reserved word in `stops`, or to the end of the text when there is none."""
    joined, after_cd = ";", False
    while True:
        while tokens.op() in (";", "\n"):
            tokens.advance()
            joined, after_cd = ";", False
        if tokens.peek() is None:
            if stops:
                raise _NoKind("an `if` that does not close")
            return
        reserved = tokens.reserved()
        if reserved in stops:
            tokens.advance()
            return
        if reserved == "if":
            tokens.advance()
            scope.depth += 1
            _read_list(tokens, scope, call, ("then",))
            _read_list(tokens, scope, call, ("fi",))
            scope.depth -= 1
            after_cd, follows = False, tokens.op()
            if tokens.peek() and follows is None or follows == "|":
                raise _NoKind("an `if` piped or redirected")
        elif reserved:
            raise _NoKind(f"a stray `{reserved}`")
        else:
            after_cd, follows = _read_pipeline(tokens, scope, call, joined, after_cd)
        if follows in ("&&", "||"):
            tokens.advance()
            while tokens.op() == "\n":
                tokens.advance()
            joined = follows
        elif follows is not None and follows not in (";", "\n"):
            raise _NoKind(f"the operator {follows}")


def _read_pipeline(tokens, scope, call, joined, after_cd):
    """Reads one pipeline: (whether it was an accepted cd, the operator past it)."""
    stages = []
    while True:
        words, redirects = tokens.simple()
        if not words:
            raise _NoKind("a command with no words")
        stages.append((words, redirects))
        if tokens.op() != "|":
            break
        tokens.advance()
        while tokens.op() == "\n":
            tokens.advance()
    follows = tokens.op()
    moved = False
    for stage, (words, redirects) in enumerate(stages):
        at = _At(joined, after_cd, stage, len(stages) > 1, follows)
        moved = _read_simple(words, redirects, scope, call, at)
    return moved, follows


def _assignment_of(word):
    """(name, value parts) of an unquoted `NAME=...`, or None."""
    kind, value, quoted = word[0]
    named = re.match(r"([A-Za-z_][A-Za-z0-9_]*)=", value) if kind == "lit" and not quoted else None
    return (named[1], [("lit", value[named.end():], False), *word[1:]]) if named else None


def _assign(name, value, scope, call, joined):
    """A plain assignment: a literal, or the one `$(jj log …)` or `$(wrangler deployments status …)`."""
    if not re.fullmatch(SCRIPT_NAME, name) or name.endswith("_proxy"):
        raise _NoKind(f"an assignment to {name}")
    held = [part for part in value if part != ("lit", "", False)]
    if held and held[0][0] == "sub":
        if len(held) != 1:
            raise _NoKind(f"{name} holds more than one substitution")
        _read_substitution(held[0][1], scope, call)
        scope.names[name] = None
    else:
        text = _literal(value, scope, f"the value of {name}")
        scope.names[name] = text if scope.depth == 0 and joined == ";" else None
    scope.assigned.add(name)


def _read_substitution(inner, scope, call):
    tokens = _Tokens(_lex(inner))
    words, redirects = tokens.simple()
    if tokens.peek() is not None or not words:
        raise _NoKind(f"a substitution of more than one command: {inner[:80]}")
    program = _word_text(words[0], scope)[0]
    if program == "jj":
        _read_jj(words[1:], scope, call, reads_only=("log",))
    elif _is_wrangler(program):
        _read_wrangler(program, words[1:], scope, call, reads_only=(("deployments", "status"),))
    else:
        raise _NoKind(f"a substitution of {program}")
    _read_redirects(redirects, scope, call)


def _read_simple(words, redirects, scope, call, at):
    """Reads one simple command: whether it was an accepted cd."""
    words = list(words)
    ahead = []
    while words and (assigned := _assignment_of(words[0])):
        ahead.append(assigned)
        words.pop(0)
    if not words:
        if at.piped or redirects:
            raise _NoKind("an assignment piped or redirected")
        for name, value in ahead:
            _assign(name, value, scope, call, at.joined)
        return False
    for name, value in ahead:
        if (name, value) == TOKEN_MAPPING:
            _check_token_mapping(words, scope)
        elif name in AHEAD_OF_COMMAND:
            _literal(value, scope, f"the value of {name}")
        else:
            raise _NoKind(f"{name}= ahead of a command")
    return _read_command(words, redirects, scope, call, at)


def _check_token_mapping(words, scope):
    """TOKEN_MAPPING stands ahead of `wrangler deploy` or `wrangler deployments status`, under `secretspec run`."""
    program, *verb = [_word_text(word, scope)[0] for word in words[:3]]
    if not scope.secret or not _is_wrangler(program) or not (verb[:1] == ["deploy"] or verb == ["deployments", "status"]):
        raise _NoKind(f"the token mapped ahead of {' '.join((program, *verb))}, or with no `secretspec run` around it")


def _read_command(words, redirects, scope, call, at, led=False):
    """Reads one command by its program, its redirections last: whether it was an accepted cd."""
    program, live = _word_text(words[0], scope)
    if live or ("/" not in program and any(part[0] != "lit" for part in words[0])):
        raise _NoKind(f"a program known only when it runs: {program}")
    args = words[1:]
    if at.stage and program not in PIPE_INTO:
        raise _NoKind(f"a pipe into {program}")
    if at.piped and program in NOT_PIPED:
        raise _NoKind(f"{program} in a pipe")
    if redirects and program in NO_REDIRECT:
        raise _NoKind(f"{program} with a redirection")
    if led and not (program in ("jj", *GRAMMAR_SHELLS) or _is_wrangler(program) or "/" in program):
        raise _NoKind(f"`secretspec run` ahead of {program}")
    moved = False
    if program == "cd":
        if redirects:
            raise _NoKind("a cd with a redirection")
        moved = _read_cd(args, scope, call, at)
    elif program == "jj":
        _read_jj(args, scope, call)
    elif _is_wrangler(program):
        _read_wrangler(program, args, scope, call)
    elif program == "secretspec":
        _read_secretspec(args, redirects, scope, call, at)
    elif program in GRAMMAR_SHELLS:
        _read_shell(args, scope, call)
    elif program in _PLAIN_READS:
        _PLAIN_READS[program]([_word_text(word, scope) for word in args], scope, call, at)
    elif "/" in program:
        _read_script_file(program, False, scope, call, direct=True)
        if args:
            raise _NoKind(f"{program} given arguments")
    else:
        raise _NoKind(f"{program} is not on the allow-list")
    _read_redirects(redirects, scope, call)
    return moved


def _read_redirects(redirects, scope, call):
    """A redirection is `>/dev/null`, `2>/dev/null`, `2>&1`, or `>file` of a log in a temp folder, in no workspace."""
    for fd, word in redirects:
        if word is None:
            continue
        text, live = _word_text(word, scope)
        if text == "/dev/null" and not live:
            continue
        if fd != "1" or live or "$" in text:
            raise _NoKind(f"the redirection {fd}>{text}")
        where = scope.path(text)
        temp = any(_inside(where, folder) for folder in _temp_folders())
        if not temp or ".claude" in where.split(os.sep) or not where.endswith(WRITTEN_SUFFIXES) or _workspace_of(os.path.dirname(where)):
            raise _NoKind(f"the redirection >{text}")
        if os.access(where, os.X_OK):
            raise _NoKind(f"the redirection >{text}, which is a program")
        call.written.add(where)


def _temp_folders():
    return {os.path.realpath(folder) for folder in ("/tmp", os.environ.get("TMPDIR")) if folder}


def _read_cd(args, scope, call, at):
    """A cd is the first command of its text, past a `;`, or past another accepted cd with `&&`; at the top of its text, in no
    pipe, and with no `||` past it."""
    if scope.depth or at.piped or at.follows == "||" or at.joined == "||" or "CDPATH" in call.env:
        raise _NoKind("a cd that may not run or may not move this shell")
    if at.joined == "&&" and not at.after_cd:
        raise _NoKind("a cd behind a command that may fail")
    if len(args) != 1:
        raise _NoKind("a cd with no one folder")
    text = _literal(args[0], scope, "a cd")
    if text.startswith("-"):
        raise _NoKind(f"cd {text}")
    logical = os.path.normpath(os.path.join(scope.cwd, text))
    if not os.path.isdir(os.path.realpath(logical)):
        raise _NoKind(f"a cd to {text}, which is not there")
    scope.cwd = scope.names["PWD"] = logical
    return True


def _read_set(args, _scope, _call, _at):
    if len(args) != 1 or args[0][1] or args[0][0] not in SET_FLAGS:
        raise _NoKind(f"set {' '.join(word for word, _ in args)}")


def _read_test(args, _scope, _call, _at):
    return None


def _read_bracket(args, _scope, _call, _at):
    if not args or args[-1][0] != "]":
        raise _NoKind("a [ that does not close")


def _read_print(args, _scope, _call, _at):
    if args and args[0][0] == "-v":
        raise _NoKind("printf -v")


def _read_file(word, live, scope, call):
    if word == "-":
        return
    if live or "$" in word or re.fullmatch(SECRET_FILE, word):
        raise _NoKind(f"a read of {word}")
    call.reads.append(scope.path(word))


def _read_grep(args, scope, call, _at):
    pattern, i = False, 0
    while i < len(args):
        word, live = args[i]
        i += 1
        if word in GREP_VALUES:
            pattern = pattern or word == "-e"
            i += 1
        elif re.fullmatch(r"-[qEFvicnlowxs]+", word):
            continue
        elif word.startswith("-") and word != "-":
            raise _NoKind(f"grep {word}")
        elif pattern:
            _read_file(word, live, scope, call)
        else:
            pattern = True


def _read_sed(args, scope, call, _at):
    words = [word for word, _ in args]
    if words[:1] != ["-n"]:
        raise _NoKind("sed without -n")
    at = 2 if words[1:2] in (["-E"], ["-r"]) else 1
    if len(words) <= at or args[at][1] or not re.fullmatch(SED_PRINT, words[at]):
        raise _NoKind(f"sed -n {' '.join(words[1:])[:80]}")
    for word, live in args[at + 1:]:
        _read_file(word, live, scope, call)


def _read_head(args, scope, call, _at):
    i = 0
    while i < len(args):
        word, live = args[i]
        i += 1
        if word in ("-n", "-c"):
            if i == len(args) or not re.fullmatch(r"\+?\d+", args[i][0]):
                raise _NoKind(f"head or tail {word}")
            i += 1
        elif re.fullmatch(r"-\d+|-q|-n\+?\d+", word):
            continue
        elif word.startswith("-") and word != "-":
            raise _NoKind(f"head or tail {word}")
        else:
            _read_file(word, live, scope, call)


def _read_sleep(args, _scope, _call, _at):
    if len(args) != 1 or not re.fullmatch(r"\d+(?:\.\d+)?", args[0][0]):
        raise _NoKind("a sleep of no plain number")


def _read_date(args, _scope, _call, _at):
    for word, live in args:
        if live or not re.fullmatch(r"-u|-I\w*|\+[^$]*", word):
            raise _NoKind(f"date {word}")


def _read_exit(args, _scope, _call, _at):
    if len(args) > 1 or (args and not re.fullmatch(r"\d+", args[0][0])):
        raise _NoKind("an exit of no plain number")


def _read_jq(args, _scope, _call, at):
    if not at.stage:
        raise _NoKind("a jq that is not fed by a pipe")
    program, i = None, 0
    while i < len(args):
        word, live = args[i]
        i += 1
        if word == "--arg":
            i += 2
        elif re.fullmatch(r"-[recSj]+", word):
            continue
        elif program is not None or word.startswith("-") or live or re.search(JQ_BARRED, word):
            raise _NoKind(f"jq {word[:80]}")
        else:
            program = word
    if program is None:
        raise _NoKind("a jq with no filter")


_PLAIN_READS = {"set": _read_set, "[": _read_bracket, "test": _read_test, "echo": _read_print, "printf": _read_print, "grep": _read_grep,
                "sed": _read_sed, "head": _read_head, "tail": _read_head, "sleep": _read_sleep, "date": _read_date, "exit": _read_exit,
                "jq": _read_jq}


def _jj_target(word, scope):
    """The folder of a `-R`: its literal values in, and a workspace there."""
    text = _literal(word, scope, "a -R")
    where = scope.path(text)
    if not os.path.isdir(os.path.join(where, ".jj")):
        raise _NoKind(f"-R {text}: no workspace there")
    return where


def _read_jj(args, scope, call, reads_only=None):
    """A jj is a read in JJ_READS, the push, or the bookmark set beside it; every other verb refuses."""
    target, plain, i = None, True, 0
    while i < len(args):
        word = _word_text(args[i], scope)[0]
        if word in ("-R", "--repository") and i + 1 < len(args):
            target = _jj_target(args[i + 1], scope)
            i += 2
        elif word.startswith("--repository="):
            target = _jj_target([("lit", word.split("=", 1)[1], True)], scope)
            i += 1
        elif word in ("--ignore-working-copy", "--no-pager"):
            plain = False
            i += 1
        else:
            break
    rest = [_word_text(word, scope) for word in args[i:]]
    verb = [word for word, _ in rest[:2]]
    if verb and verb[0] in (reads_only or JJ_READS):
        _read_jj_read(rest[1:], verb[0])
    elif reads_only or verb not in (["git", "push"], ["bookmark", "set"]):
        raise _NoKind(f"jj {' '.join(verb)} is not on the allow-list")
    elif not plain:
        raise _NoKind(f"jj {' '.join(verb)} with a flag ahead of it")
    elif verb[0] == "git":
        _read_push(rest[2:], target, scope, call)
    else:
        _read_move(rest[2:], target, scope, call)


def _read_jj_read(args, verb):
    i = 0
    while i < len(args):
        word = args[i][0]
        i += 1
        head, eq, _ = word.partition("=")
        if head in JJ_READ_VALUES:
            i += not eq
        elif word.startswith("-") and word not in JJ_READ_FLAGS:
            raise _NoKind(f"jj {verb} {word}")


def _act(action, scope, call, start, **fields):
    if scope.depth or scope.guarded:
        raise _NoKind(f"a {action} under an `if`")
    call.actions.append((action, fields, start))


def _read_push(args, target, scope, call):
    bookmarks, i = [], 0
    while i < len(args):
        head, eq, value = args[i][0].partition("=")
        live = args[i][1]
        i += 1
        if head not in ("--bookmark", "-b", "--remote"):
            raise _NoKind(f"a push with {args[i - 1][0]}")
        if not eq:
            value, live = args[i] if i < len(args) else ("", False)
            i += 1
        if live:
            raise _NoKind(f"a push with {value}, known only when it runs")
        if head != "--remote":
            bookmarks.append(value)
        elif value != "origin":
            raise _NoKind(f"a push to {value}")
    if len(bookmarks) != 1 or not re.fullmatch(JJ_NAME, bookmarks[0]):
        raise _NoKind(f"a push of {' '.join(bookmarks) or 'no named bookmark'}")
    _act("push", scope, call, target or scope.path("."), bookmark=bookmarks[0])


def _read_move(args, target, scope, call):
    """`jj bookmark set B -r X`, ahead of the push of that B."""
    words = [word for word, _ in args]
    if len(words) != 3 or words[1] != "-r" or any(live for _, live in args):
        raise _NoKind(f"jj bookmark set {' '.join(words)}")
    if not re.fullmatch(JJ_NAME, words[0]) or not re.fullmatch(JJ_REVISION, words[2]):
        raise _NoKind(f"jj bookmark set {' '.join(words)}")
    if scope.depth or scope.guarded or call.actions or call.moves:
        raise _NoKind("a bookmark set under an `if`, past the push, or twice")
    call.moves.append((words[0], words[2], target or scope.path(".")))


def _is_wrangler(program):
    return program == "wrangler" or ((program == "node_modules/.bin/wrangler" or program.endswith("/node_modules/.bin/wrangler"))
                                     and ".." not in program.split("/"))


def _read_wrangler(program, args, scope, call, reads_only=WRANGLER_READS):
    """A wrangler is the one deploy, whose flags come from `wrangler deploy --help` (4.150.0) and hold `--keep-vars`, as the help
    says vars are deleted without it, or a read in `reads_only`; any other run of it refuses."""
    words = [_word_text(word, scope) for word in args]
    verb = tuple(word for word, _ in words[:2])
    if "/" in program:
        call.inside.append(("wrangler", os.path.join(os.path.dirname(scope.path(program)), "wrangler")))
    if verb in reads_only:
        flags, config = _wrangler_flags(words[2:], frozenset(("--json",)), frozenset())
        if config:
            _read_config(*config, scope, call, bind=False)
        return
    if verb[:1] != ("deploy",) or reads_only != WRANGLER_READS:
        raise _NoKind(f"wrangler {' '.join(verb)} is not on the allow-list")
    flags, config = _wrangler_flags(words[1:], WRANGLER_DEPLOY_FLAGS, WRANGLER_DEPLOY_VALUES)
    if "--keep-vars" not in flags:
        raise _NoKind("a wrangler deploy with no --keep-vars, which deletes the vars")
    if config:
        _read_config(*config, scope, call, bind=True)
    else:
        _read_implicit_config(scope, call)
    _act("deploy", scope, call, scope.path("."))


def _wrangler_flags(words, flags, values):
    """(the flags held, the (word, live) of the config or None); a word off these lists refuses."""
    held, config, i = set(), None, 0
    while i < len(words):
        word, live = words[i]
        i += 1
        head, eq, value = word.partition("=")
        glued = word.startswith("-c") and not word.startswith("--") and head != "-c"
        if glued:
            config = (word[2:], live)
        elif head in ("-c", "--config"):
            config = (value, live) if eq else words[i] if i < len(words) else ("", False)
            i += not eq
        elif head in flags and not eq and not live:
            held.add(head)
        elif head in values and not live:
            if not eq:
                if i == len(words) or words[i][1]:
                    raise _NoKind(f"wrangler {word} with no plain value")
                i += 1
        else:
            raise _NoKind(f"wrangler {word} is not on the allow-list")
    return held, config


def _read_config(word, live, scope, call, bind):
    if not word or live or "$" in word or word[0] == "~" or re.fullmatch(SECRET_FILE, word):
        raise _NoKind(f"the config {word}")
    real = scope.path(word)
    call.inside.append(("config", real))
    call.ran.add(real)
    if bind:
        data = _regular_bytes(real)
        if data is None:
            raise _NoKind(f"the config {word} cannot be read")
        call.bind(os.path.normpath(os.path.join(scope.cwd, word)), real, data)


def _found_up(name, start):
    """The nearest `name` from the folder `start` up to the root, as wrangler's find-up looks: a path, or None."""
    while True:
        path = os.path.join(start, name)
        if os.path.isfile(path):
            return path
        if start == os.path.dirname(start):
            return None
        start = os.path.dirname(start)


def _bind_file(real, what, call):
    data = _regular_bytes(real)
    if data is None:
        raise _NoKind(f"the {what} {real} cannot be read")
    call.inside.append((what, real))
    call.bind(real, real, data)
    return data


def _read_implicit_config(scope, call):
    """What a deploy with no `-c` reads, as findWranglerConfig does in wrangler 4.150.0: each name is looked for up the whole tree
    before the next, and a `.wrangler/deploy/config.json` up the tree redirects to the config it names."""
    start = scope.path(".")
    user = next(filter(None, (_found_up(name, start) for name in WRANGLER_CONFIGS)), None)
    if user:
        _bind_file(os.path.realpath(user), "config", call)
    redirect = _found_up(WRANGLER_REDIRECT, start)
    if redirect:
        real = os.path.realpath(redirect)
        try:
            named = json.loads(_bind_file(real, "config", call))["configPath"]
            target = os.path.join(os.path.dirname(redirect), named)
        except (ValueError, KeyError, TypeError) as e:
            raise _NoKind(f"the redirect {redirect} does not read") from e
        _bind_file(os.path.realpath(target), "config", call)


def _read_secretspec(args, redirects, scope, call, at):
    """`secretspec run [-f FILE] [--reason TEXT] -- COMMAND`, read as that command under the same grammar."""
    if not args or _word_text(args[0], scope)[0] != "run":
        raise _NoKind("`secretspec` other than `secretspec run`")
    i = 1
    while i < len(args) and (flag := _word_text(args[i], scope)[0]) != "--":
        value, live = _word_text(args[i + 1], scope) if i + 1 < len(args) else ("", True)
        if flag not in ("-f", "--reason") or live:
            raise _NoKind(f"secretspec run {flag}")
        if flag == "-f":
            _bind_file(scope.path(value), "secretspec file", call)
        i += 2
    if i + 1 >= len(args):
        raise _NoKind("`secretspec run` with no `--` and command")
    _read_command(args[i + 1:], [], scope.led(), call, at, led=True)


def _read_shell(args, scope, call):
    """`sh [-e|-u|-eu] -c TEXT`, TEXT read as commands, or `sh [-e|-u|-eu] SCRIPT`. A shell fed from anything else refuses."""
    words = list(args)
    while words and _word_text(words[0], scope)[0] in SET_FLAGS:
        words.pop(0)
    if words and _word_text(words[0], scope)[0] == "-c":
        if len(words) != 2:
            raise _NoKind("a `sh -c` with no one text")
        if scope.nest >= DEPLOY_NEST_MAX:
            raise _NoKind(f"a `sh -c` past {DEPLOY_NEST_MAX} levels")
        _read_text(_literal(words[1], scope, "a `sh -c` text", shell_text=True), scope.shell(nest=1), call)
    elif len(words) == 1:
        _read_script_file(*_word_text(words[0], scope), scope, call, direct=False)
    else:
        raise _NoKind("a shell given no one script")


def _read_script_file(word, live, scope, call, direct):
    """A script is a regular file of shell text, read under the same grammar and bound by the path the call names and its realpath."""
    if live or "$" in word:
        raise _NoKind(f"a script known only when it runs: {word}")
    if scope.hops >= DEPLOY_HOPS:
        raise _NoKind(f"{word} is past {DEPLOY_HOPS} scripts deep")
    call.script_runs += 1
    if call.script_runs > DEPLOY_FILES_MAX:
        raise _NoKind(f"past {DEPLOY_FILES_MAX} scripts")
    real = scope.path(word)
    data = _regular_bytes(real)
    if data is None or len(data) > DEPLOY_TEXT_MAX or b"\0" in data:
        raise _NoKind(f"{word} cannot be read as a script")
    if direct:
        shebang = data.split(b"\n", 1)[0].decode("utf-8", "replace")
        if not re.fullmatch(r"#!\s*(?:/usr/bin/env\s+|\S*/)(?:sh|bash|dash)\b.*", shebang):
            raise _NoKind(f"{word} is no shell script")
    call.bind(os.path.normpath(os.path.join(scope.cwd, word)), real, data)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise _NoKind(f"{word} cannot be read as a script") from None
    _read_text(text, scope.shell(hops=1), call)


def _inside(path, folder):
    return path == folder or path.startswith(folder + os.sep)


def _workspace_of(start):
    """The folder at or above `start` that holds `.jj`, or None."""
    here = os.path.realpath(start)
    while True:
        if os.path.isdir(os.path.join(here, ".jj")):
            return here
        up = os.path.dirname(here)
        if up == here:
            return None
        here = up


def _repo_main(workspace):
    """The realpath of a workspace's `.jj/repo`, past the pointer file a secondary workspace holds there, or None."""
    dot = os.path.join(workspace, ".jj")
    repo = os.path.join(dot, "repo")
    if os.path.isfile(repo):
        data = _regular_bytes(repo, head=4096)
        if data is None:
            return None
        repo = os.path.join(dot, data.decode("utf-8", "replace").strip())
    return os.path.realpath(repo) if os.path.isdir(repo) else None


def _jj(workspace, *args):
    """What a read-only jj prints for `workspace`, or None when it fails: it snapshots nothing."""
    import subprocess
    try:
        done = subprocess.run(["jj", "-R", workspace, "--ignore-working-copy", "--color", "never", *args], capture_output=True,
                              text=True, timeout=JJ_TIMEOUT, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def _origin_of(workspace):
    """(the origin remote's URL or None, whether jj could tell)."""
    listed = _jj(workspace, "git", "remote", "list")
    if listed is None:
        return None, False
    for line in listed.splitlines():
        name, _, url = line.partition(" ")
        if name == "origin":
            return url.strip(), True
    return None, True


def _is_one_commit(workspace, revision):
    held = _jj(workspace, "log", "--no-graph", "-T", 'commit_id ++ "\\n"', "-r", revision)
    return bool(held) and len(held.splitlines()) == 1


def _fast_forward(workspace, bookmark, revision=None):
    """Whether `B@origin & ::X` holds a commit, X the bookmark itself or the revision a `jj bookmark set` names."""
    at = f"({revision})" if revision else f'"{bookmark}"'
    held = _jj(workspace, "log", "--no-graph", "-T", 'commit_id ++ "\\n"', "-r", f'"{bookmark}"@origin & ::{at}')
    return bool(held and held.strip())


def _is_listed_workspace(workspace):
    """Whether the repo lists `workspace` as its own, so a copied `.jj` names no repo it was not added to."""
    listed = _jj(workspace, "workspace", "list", "-T", 'self.root() ++ "\\n"')
    return bool(listed) and workspace in {os.path.realpath(line) for line in listed.splitlines() if line}


def _kind_of(command, cwd, env):
    """The output of `match` for a call that the grammar reads whole; raises why not."""
    if not os.path.isdir(cwd):
        raise _NoKind(f"{cwd} is not there")
    call = _Call(env)
    _read_text(command, _Scope(cwd, env), call)
    if not call.actions:
        raise _NoKind("no deploy or push in this call")
    if len(call.actions) > 1:
        raise _NoKind(f"{len(call.actions)} actions in one call")
    (action, fields, start), = call.actions
    if call.moves and action != "push":
        raise _NoKind("a bookmark set with no push")
    if call.written & call.ran:
        raise _NoKind(f"a run of what this call writes: {sorted(call.written & call.ran)[0]}")
    workspace = _workspace_of(start)
    main = workspace and _repo_main(workspace)
    if not main:
        raise _NoKind(f"no jj workspace at {start}")
    for what, path in call.inside:
        if not _inside(path, workspace):
            raise _NoKind(f"the {what} {path} is outside the workspace")
    temp = _temp_folders()
    for path in call.reads:
        if re.fullmatch(SECRET_FILE, path) or not any(_inside(path, folder) for folder in (workspace, *temp)):
            raise _NoKind(f"a read of {path}")
    origin, told = _origin_of(workspace)
    if not told or not _is_listed_workspace(workspace):
        raise _NoKind(f"jj cannot read {workspace} as a workspace of its repo")
    if action == "push":
        _prove_push(fields["bookmark"], call.moves, workspace)
    return {"kind": {"action": action, "repo": {"main": main, "origin": origin}, **fields}, "workspace": workspace,
            "scripts": [{"path": path, "sha256": sha} for path, sha in call.bound.items()]}


def _prove_push(bookmark, moves, workspace):
    """The push's bookmark, and the revision a `jj bookmark set` beside it names, each hold `B@origin`."""
    for moved, revision, where in moves:
        if moved != bookmark or _workspace_of(where) != workspace:
            raise _NoKind(f"a bookmark set of {moved} beside the push of {bookmark}")
        if not _is_one_commit(workspace, revision) or not _fast_forward(workspace, bookmark, revision):
            raise _NoKind(f"{revision} is not a fast-forward of {bookmark}@origin")
    if not _fast_forward(workspace, bookmark):
        raise _NoKind(f"{bookmark} is not a fast-forward of {bookmark}@origin")


def _match(command, cwd, env):
    """The output of `match` for a call: see the head of this file."""
    try:
        return _kind_of(command, cwd, env)
    except _NoKind as why:
        return {"refused": str(why)}


def match_main(argv, stdin, stdout):
    """The program: see the head of this file."""
    if argv != ["match"]:
        print("usage: tstack-hook-deploy.py match < {command, cwd, env}", file=sys.stderr)
        return 2
    try:
        given = json.loads(stdin.read())
        command, cwd, env = given["command"], given["cwd"], given.get("env", {})
        if not (isinstance(command, str) and isinstance(cwd, str) and os.path.isabs(cwd) and isinstance(env, dict)):
            raise ValueError("command and an absolute cwd are strings, env an object")
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        out = {"refused": f"bad input: {e}"}
    else:
        try:
            out = _match(command, cwd, env)
        except Exception as e:  # noqa: BLE001 - a matcher that fails grants nothing
            out = {"refused": f"the matcher failed: {type(e).__name__}: {e}"}
    stdout.write(json.dumps(out) + "\n")
    return 0
