"""A deploy that never asked: the part of hooks/tstack-hook.py that reads a Bash command for a production deploy and refuses
one with no approval (fleet/SPEC.md, "A deploy that never asked").

It is no module of its own. The hook executes this file into its own namespace (`_deploys`), and only for a Bash call in a
session that serves a fleet (`fleet_deploy_gate` in the hook); SessionStart, Stop and a session of no fleet pay for none of
it. In a fleet every Bash call loads it: a script's text names the deploy, so any path can be one, and 98.6% of 25,611 Bash
commands in the local transcripts (2026-11-01) held a `/`, so a test of the command's words would spare almost none and could
drift from DEPLOYS. Python's bytecode in hooks/__pycache__ keeps that load near 1 ms of CPU (`_part_code`). The names this
file uses and does not define (`SHELLS`, `_simple_commands`, `_normal`, `Deny`, `re`, `os`, ...) are the hook's.

It is also a program, the matcher of a 24-hour kind grant: `python3 -I hooks/tstack-hook-deploy.py match`. Stdin is
`{command, cwd, env}`, stdout one JSON line, exit 0: `{kind: {action, repo: {main, origin|null}, bookmark?, service?}, workspace,
scripts: [{path, sha256}]}`, or `{refused: reason}`. Any other mode exits 2. `action` is deploy, push or restart; `main` is the
realpath of the workspace's `.jj/repo`, which in a secondary workspace is a file holding the path to it; `workspace` is the folder
that holds `.jj`, past each `cd` the text names; `scripts` is each shell file read, hashed. The kind is derived from the command,
never given. A command reaches exactly one action or has no kind. What cannot be read refuses, and so does a push whose bookmark
is not a fast-forward: `B@origin & ::B` is empty, read with --ignore-working-copy. The reader is text, so what still gets the kind
of the deploy beside it is a named program (`node x.js`, `python3 x.py`, `make`, a path to a binary), a recipe, task or package
script taken by name, another program's own exec (`find -exec`, awk's `system`), and a variable exported earlier (`export
CLOUDFLARE_ENV=x`). A `cd` behind `&&` or `||` is taken as run, so `false && cd other; wrangler deploy` gets other's kind.
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
DIR_MOVES = frozenset(("cd", "pushd", "popd", "chdir"))
SUBSHELL_CD = r"(?<![$\w])\([^()]*\bcd\b"

# One deploy a Bash command reaches: `piece`, the simple command of the call that reaches it, which is what an owner's rule
# is held against; `what`, the DEPLOYS entry, or "" when `unread`; `script`, the absolute path of the file of the call that
# holds it, or None when it stands in the call; `unread`, why a script named for a deploy cannot be read yet.
Deploying = namedtuple("Deploying", "piece what script unread")
# One read of a call: `env`, the variables the session holds; `files`, each script read, by its path; `written`, the name of
# each file the text read so far writes; `texts`, the bytes of each script read as shell text, by its path; `runs`, each ReadRun;
# `unseen`, why each thing the text runs was not read. The gate reads only the first three; the matcher (`match_main`), all.
Reading = namedtuple("Reading", "env files written texts runs unseen")
# One command of a text as read: `run`, its words from its program; `cwd`, where it runs; `leaders`, the words of its simple command
# ahead of its program.
ReadRun = namedtuple("ReadRun", "run cwd leaders")


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
    text = _without_redirections(_without_substitutions(piece)).replace("\\\n", " ")
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
    if name in reading.written:
        reading.unseen.append(f"{word} is written in this same call")
    if data is None or (by_shell and not shell):
        reading.unseen.append(f"{word} cannot be read as a script")
    if _names_deploy(name) and (shell or (data is None and not name.endswith(SOURCE_EXTENSIONS))):
        if name in reading.written:
            return [("", None, f"runs {word}, named for a deploy, and writes it in this same call")]
        if data is None and ("$" in where or "`" in where):
            return [("", None, f"runs {word}, named for a deploy, at a path known only when it runs")]
    # No flag of a script's makes it a read: `bash deploy-kit1.sh --help` deployed, as that script ignores its flags. The one
    # exception is deploy-worker's modes in DEPLOY_SCRIPT_READS, which _script_word has already read as no script.
    if not shell:
        return []
    if len(data) > DEPLOY_TEXT_MAX:
        reading.unseen.append(f"{word} is past {DEPLOY_TEXT_MAX} bytes")
        return []
    if path in reading.files:
        reading.unseen.append(f"{word} runs twice")
        return reading.files[path]
    if len(reading.files) >= DEPLOY_FILES_MAX:
        reading.unseen.append(f"{word} is past {DEPLOY_FILES_MAX} scripts")
        return []
    reading.files[path] = []
    reading.texts[path] = data
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
        reading.unseen.append(f"a text past {DEPLOY_TEXT_MAX} bytes")
        return []
    if "(" in text and re.search(SUBSHELL_CD, text):
        reading.unseen.append("a cd in a subshell")
    try:
        pieces = _simple_commands(text)
    except (ValueError, IndexError):
        pieces, hops = [p for line in text.split("\n") for p in _line_pieces(line)], DEPLOY_HOPS
        reading.unseen.append("a text that does not parse")
    out = []
    for piece in pieces:
        words = _piece_words(piece)
        if words is None:
            reading.unseen.append(f"a command past {DEPLOY_PIECE_MAX} bytes")
            continue
        if words and all(ASSIGNMENT_RE.match(w) for w in words):
            names.update((k, _expanded(v, names)) for k, v in (w.split("=", 1) for w in words))
        moved = words[:1] == ["cd"] and len(words) > 1 and "$" not in _expanded(words[1], names)
        if moved:
            places = (os.path.join(places[0], _expanded(words[1], names)), *places)
            names["PWD"] = places[0]
            if not os.path.isdir(places[0]):
                reading.unseen.append(f"a cd to {words[1]}, which is not there")
        reached = []
        runs = _runs_of(words)
        if len(runs) >= DEPLOY_RUNS_MAX:
            reading.unseen.append(f"a command past {DEPLOY_RUNS_MAX} leaders")
        for run, sure in runs:
            if os.path.basename(run[0]) in DIR_MOVES and not moved:
                reading.unseen.append(f"a move it cannot follow: {' '.join(run)}")
            reading.runs.append(ReadRun(run, places[0], tuple(words[:len(words) - len(run)])))
            what = _deploy_at(run)
            shell = _shell_text(run) if os.path.basename(run[0]) in SHELLS else None
            script = None if what or shell is not None else _script_word(run, sure)
            if what:
                reached.append((what, None, None))
            elif shell is not None and nest < DEPLOY_NEST_MAX:
                reached.extend(_text_deploys(shell, places, hops, names, reading, nest + 1))
            elif shell is not None:
                reading.unseen.append(f"a `sh -c` past {DEPLOY_NEST_MAX} levels")
            elif script and hops < DEPLOY_HOPS:
                reached.extend(_script_deploys(script, run, places, hops, names, reading))
            elif script:
                reading.unseen.append(f"{script} is past {DEPLOY_HOPS} scripts deep")
        reading.written.update(_written_by(piece, words, names))
        if reached:
            out.append((piece, reached))
    return out


def deploys_of(command, cwd, env):
    """Each deploy a Bash command run in `cwd` reaches (Deploying), the data fleet_deploy_gate decides on. `env` holds the
    variables of the session, whose values let `bash $CLAUDE_PROJECT_DIR/x.sh` be read."""
    seed = {**(env or {}), "PWD": cwd}
    return [Deploying(piece, what, script, unread)
            for piece, reached in _pieces_deploys(command, (cwd,), 0, dict(seed), Reading(seed, {}, set(), {}, [], []), 0)
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
NEVER_WORDS = frozenset(("--force", "--force-with-lease", "--force-if-includes", "--deleted", "--delete", "--allow-new",
                         "--allow-empty", "--once", "secret"))
NEVER_PROGRAMS = frozenset(("rm", "trash", "op", "eval", "ssh", "scp", "sftp", "printenv"))
NEVER_IN_ORDER = (("jj", "bookmark", "forget"), ("jj", "abandon"), ("wrangler", "delete"), ("wrangler", "secret"), ("d1", "execute"))
PRINTERS = frozenset(("echo", "printf", "print", "cat", "head", "tail", "less", "more", "bat", "strings", "xxd", "od", "base64"))
SECRET_NAME = r"(?i)\$\{?\w*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL)"
SECRET_FILE = r"(?:.*/)?(?:\.env|\.dev\.vars)(?:\..*)?|/proc/.*/environ"
ENV_DUMPS = frozenset(("set", "export", "declare", "typeset"))
_INLINE_NODE = r"-e|-p|-pe|--eval(?:=.*)?|--print(?:=.*)?"
_INLINE_SCRIPT = r"-[A-Za-z]*[eE]"
INLINE_FLAGS = {"node": _INLINE_NODE, "nodejs": _INLINE_NODE, "bun": _INLINE_NODE, "deno": "eval", "python": r"-[A-Za-z]*c",
                "perl": _INLINE_SCRIPT, "ruby": _INLINE_SCRIPT, "lua": "-e", "php": "-r"}
BARRED_LEADERS = frozenset(("xargs", "nix", "dotenvx", "devenv", "fleet", "direnv", "shell"))
# The flags a leader may keep; any other of its flags can move what it runs. A leader not here keeps all of its flags.
LEADER_KEEPS = {
    **dict.fromkeys(PACKAGE_RUNNERS, frozenset()), "sudo": frozenset(), "env": frozenset(("-u", "--unset")),
    **dict.fromkeys(("npx", "pnpx", "bunx"), frozenset(("-y", "--yes", "--no-install"))),
}
DEPLOY_ENV = r"(?:CLOUDFLARE|WRANGLER)_\w*="
WRANGLER_KEEPS = frozenset(("--keep-vars", "--minify", "--no-bundle", "--no-build", "--upload-source-maps", "--latest", "--strict",
                            "--yes", "-y"))
WRANGLER_KEEPS_VALUE = frozenset(("--tag", "--message", "--compatibility-date", "--old-asset-ttl", "--version-id", "--percentage"))
DEPLOY_KEEPS = {"pulumi": frozenset(("--yes", "-y", "--skip-preview")), "fly": frozenset(("--remote-only", "--local-only")),
                "flyctl": frozenset(("--remote-only", "--local-only"))}
JJ_NAME = r"[A-Za-z0-9][A-Za-z0-9._/-]*"
SERVICE = r"[A-Za-z0-9][A-Za-z0-9_.@-]*"
JJ_TIMEOUT = 15


def _in_order(words, wanted):
    """Whether `words` holds `wanted` in that order, the first by its base name, other words between them."""
    at = next((k for k, w in enumerate(words) if os.path.basename(w) == wanted[0]), None)
    if at is None:
        return False
    rest = iter(words[at + 1:])
    return all(w in rest for w in wanted[1:])


def _prints_secret(run, program):
    """Whether `run` prints what `secretspec run --` put in its environment, or a file that holds one."""
    args = run[1:]
    if program == "env" and all(w.startswith("-") or "=" in w for w in args):
        return True
    if program in ENV_DUMPS and (not args or args == ["-p"]):
        return True
    return program in PRINTERS and any(re.search(SECRET_NAME, w) or re.fullmatch(SECRET_FILE, w) for w in args)


def _never_of(seen):
    """Why one command is on the never-list, or None."""
    run, whole = seen.run, (*seen.leaders, *seen.run)
    program = os.path.basename(run[0])
    if program in NEVER_PROGRAMS or _prints_secret(run, program):
        return f"`{program}`"
    if program == "secretspec" and run[1:3] != ["run", "--"]:
        return "`secretspec` other than `secretspec run --`"
    for word in whole:
        if word.split("=", 1)[0] in NEVER_WORDS:
            return f"`{word}`"
        if " " not in word and "rollback" in os.path.basename(word):
            return f"`{word}`"
    for wanted in NEVER_IN_ORDER:
        if _in_order(whole, wanted):
            return f"`{' '.join(wanted)}`"
    if program in ("git", "jj") and "push" in run[1:] and any(re.fullmatch(r"-[A-Za-z]*f|\+.+", w) for w in run[1:]):
        return "a forced push"
    for k, word in enumerate(whole):
        flags = INLINE_FLAGS.get(re.sub(r"[\d.]+$", "", os.path.basename(word)))
        if flags is not None and any(re.fullmatch(flags, w) for w in whole[k + 1:]):
            return f"inline code for `{os.path.basename(word)}`"
    if program in SHELLS and not {"--version", "--help"}.intersection(run):
        flags, rest = _shell_words(run)
        reads = any("n" in f or "c" in f for f in flags)
        if not reads and (not rest or any("s" in f for f in flags)):
            return "a shell fed from stdin or a pipe"
    return None


def _hidden_of(seen):
    """Why one command hides what it runs from this reader, or None."""
    run, program = seen.run, os.path.basename(seen.run[0])
    if any(w.endswith("()") for w in seen.leaders) or program in ("function", "alias") or run[1:2] == ["()"]:
        return "a function or an alias"
    if "$" in run[0] and "/" not in run[0]:
        return f"a program known only when it runs: {run[0]}"
    if program in SHELLS:
        flags, rest = _shell_words(run)
        if rest and _shell_text(run) is None and _script_word(run, True) is None and not any("n" in f for f in flags):
            return f"a shell given {rest[0]}"
    return None


def _leader_redirect(leaders):
    """The word of a command's `leaders` that can move what it runs, or None."""
    program = None
    for word in leaders:
        name = os.path.basename(word)
        if name in BARRED_LEADERS or re.match(DEPLOY_ENV, word):
            return word
        if name in LEADER_KEEPS:
            program = name
        elif word.startswith("-") and program and word.split("=", 1)[0] not in LEADER_KEEPS[program]:
            return word
    return None


def _inside(path, folder):
    return path == folder or path.startswith(folder + os.sep)


def _wrangler_redirect(seen, what, workspace):
    """The word of a wrangler deploy that moves it off the Worker its folder's config names, or None. A config inside the same
    workspace stays in the kind, which covers the repo's Workers whole. A flag not known to keep the target refuses."""
    tail, plain = what.split()[1:], []
    args, i = seen.run[1:], 0
    while i < len(args):
        word = args[i]
        i += 1
        if not word.startswith("-"):
            plain.append(word)
            continue
        head, eq, value = word.partition("=")
        if head in ("-c", "--config") or (word.startswith("-c") and not word.startswith("--")):
            if not eq and head not in ("-c", "--config"):
                value = word[2:]
            elif not eq:
                value = args[i] if i < len(args) else ""
                i += 1
            where = os.path.realpath(os.path.join(seen.cwd, value))
            if not value or value[0] == "~" or "$" in value or "`" in value or not _inside(where, workspace):
                return f"{word} {value}".strip()
        elif head in WRANGLER_KEEPS_VALUE:
            i += not eq
        elif head not in WRANGLER_KEEPS:
            return word
    if tail == ["versions", "deploy"]:
        plain = [w for w in plain if "@" not in w]
    return None if plain == tail else " ".join(plain)


def _deploy_redirect(seen, what, workspace):
    """The word that moves a deploy off the one its workspace names, or None: past the leaders, its words are the deploy's own."""
    name, tail = what.split()[0], what.split()[1:]
    if name == "wrangler":
        return _wrangler_redirect(seen, what, workspace)
    words = [w for w in seen.run[1:] if w not in DEPLOY_KEEPS.get(name, ())]
    if name == "pnpm" and words[:1] in (["run"], ["run-script"]):
        words = words[1:]
    return None if words == tail else " ".join(words)


def _push_of(seen):
    """(bookmark, the folder its `-R` names or None, why not): a push is `jj git push --bookmark B`, with at most `-R` ahead of
    `git` and `--remote origin` after it."""
    args, i, where = seen.run[1:], 0, None
    while i < len(args) and args[i] != "git":
        word = args[i]
        if word in ("-R", "--repository") and i + 1 < len(args):
            where = args[i + 1]
            i += 2
        elif word.startswith("--repository="):
            where = word.split("=", 1)[1]
            i += 1
        else:
            return None, None, f"a push with {word}"
    rest, bookmarks = args[i + 2:], []
    if args[i:i + 2] != ["git", "push"]:
        return None, None, "not `jj git push`"
    k = 0
    while k < len(rest):
        head, eq, value = rest[k].partition("=")
        k += 1
        if head not in ("--bookmark", "-b", "--remote"):
            return None, None, f"a push with {rest[k - 1]}"
        if not eq:
            value = rest[k] if k < len(rest) else ""
            k += 1
        if head == "--remote":
            if value != "origin":
                return None, None, f"a push to {value}"
        else:
            bookmarks.append(value)
    if len(bookmarks) != 1 or not re.fullmatch(JJ_NAME, bookmarks[0]):
        return None, None, f"a push of {' '.join(bookmarks) or 'no named bookmark'}"
    return bookmarks[0], where, None


def _action_of(seen):
    """(action, what) of one command: `deploy` and its DEPLOYS entry, `push` or `restart`; None when it is none of them."""
    name = os.path.basename(seen.run[0])
    args = seen.run[1:]
    if name == "systemctl":
        return ("restart", None) if "restart" in args else None
    if name == "jj":
        return ("push", None) if _in_order(seen.run, ("jj", "git", "push")) else None
    what = _deploy_at([name.split("@", 1)[0], *args])
    return ("deploy", what) if what else None


def _service_of(seen):
    """The one service of `systemctl [--user] restart SERVICE`, or None."""
    words = [w for w in seen.run[1:] if w != "--user"]
    if len(words) != 2 or words[0] != "restart" or not re.fullmatch(SERVICE, words[1]):
        return None
    return words[1].removesuffix(".service")


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


def _fast_forward(workspace, bookmark):
    held = _jj(workspace, "log", "--no-graph", "-T", 'commit_id ++ "\\n"', "-r", f'"{bookmark}"@origin & ::"{bookmark}"')
    return bool(held and held.strip())


def _match(command, cwd, env):
    """The output of `match` for a call: see the head of this file."""
    import hashlib
    seed = {**env, "PWD": cwd}
    reading = Reading(seed, {}, set(), {}, [], [])
    _pieces_deploys(command, (cwd,), 0, dict(seed), reading, 0)
    for seen in reading.runs:
        why = _never_of(seen)
        if why:
            return {"refused": f"never: {why}"}
    hidden = [why for why in map(_hidden_of, reading.runs) if why]
    if reading.unseen or hidden:
        return {"refused": f"not read: {(reading.unseen + hidden)[0]}"}
    for seen in reading.runs:
        if os.path.basename(seen.run[0]) in SHELLS or (seen.leaders and _script_word(seen.run, True)):
            word = _leader_redirect(seen.leaders)
            if word:
                return {"refused": f"redirect: {word}"}
    acting = [(seen, *action) for seen, action in ((s, _action_of(s)) for s in reading.runs) if action]
    if not acting:
        return {"refused": "no deploy, push or restart in this call"}
    if len(acting) > 1:
        return {"refused": f"{len(acting)} actions in one call"}
    (seen, action, what), = acting
    word = _leader_redirect(seen.leaders)
    if word:
        return {"refused": f"redirect: {word}"}
    extra, start = {}, seen.cwd
    if action == "push":
        bookmark, where, why = _push_of(seen)
        if why:
            return {"refused": why}
        extra, start = {"bookmark": bookmark}, os.path.join(seen.cwd, where) if where else seen.cwd
    elif action == "restart":
        service = _service_of(seen)
        if service is None:
            return {"refused": f"a restart is one service exactly: {' '.join(seen.run)}"}
        extra = {"service": service}
    workspace = _workspace_of(start)
    main = workspace and _repo_main(workspace)
    if not main:
        return {"refused": f"no jj workspace at {start}"}
    if action == "deploy":
        word = _deploy_redirect(seen, what, workspace)
        if word:
            return {"refused": f"redirect: {word}"}
    origin, told = _origin_of(workspace)
    if not told:
        return {"refused": f"jj cannot read the repo at {workspace}"}
    if action == "push" and not _fast_forward(workspace, extra["bookmark"]):
        return {"refused": f"{extra['bookmark']} is not a fast-forward of {extra['bookmark']}@origin"}
    return {"kind": {"action": action, "repo": {"main": main, "origin": origin}, **extra}, "workspace": workspace,
            "scripts": [{"path": path, "sha256": hashlib.sha256(data).hexdigest()} for path, data in reading.texts.items()]}


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
