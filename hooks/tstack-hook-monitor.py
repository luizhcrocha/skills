"""Monitor only watches: the part of hooks/tstack-hook.py that reads a Monitor command for whether it is a watch
(fleet/SPEC.md, "Monitor only watches").

It is no module of its own. The hook executes this file into its own namespace (`_monitor`), and only for a Monitor
call in a session that works for a fleet (`fleet_monitor_watch` in the hook): every other call pays for none of it. So
the names this file uses and does not define (`grant_state_dirs`, `_simple_commands`, `_normal`, `_is_call`, `Deny`,
`ROOT`, `re`, `os`, ...) are the hook's.
"""

# Auto mode judges a Bash command with its classifier and does not judge a Monitor command: measured 2026-10-12 on
# Claude Code 2.1.296, a stand-in deploy refused 10 of 10 as a Bash call ran 4 of 4 through Monitor with no allow rule.
# So in a fleet an act the user never allowed could still happen, by going to Monitor first. The rule here is deny by
# default: a Monitor command passes only when every simple command it runs is the fleet CLI watching (FLEET_WATCHES) or
# one of the commands that only read, wait or print (WATCH_READS), with nothing the hook cannot read before it runs:
# no `$` expansion, no substitution, no subshell, no here-document, no brace expansion, no file written outside the
# temp folders. Whatever joins the commands (a pipe, `;`, `&&`, `||`, `&`, `while`/`until`/`if`) changes nothing: a
# list of commands that only read only reads. The one other way through is the user's yes: a command that a standing
# one-time grant names exactly (_watch_granted), which fleet_grant_alone then holds to one run.
# The command is split by the hook's own _simple_commands and stripped by its _normal (Claude Code's own
# normalisation: redirections, the safe environment names of SAFE_ENV_NAMES, timeout/nice/stdbuf/nohup/command, the
# first word's quotes). The lexer below adds what those two do not say: which characters of a word stood unquoted, and where a
# redirection writes. A piece the two read differently is no watch.
WATCH_MAX_CHARS = 4000  # a watch is a line or a short loop; a longer text is a script, and a script is run by Bash

# After `$`, the characters that make bash expand it (a name, a positional or special parameter, `${`, `$(`, `$[`).
# `$?` alone is let through: the last exit code, a number. Any other `$` is the character itself (`"error$"`).
WATCH_EXPANDS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_*@#!${([-")
WATCH_INPUTS = ("<", "<<<", "<&")  # a file or a string read: any
WATCH_OUTPUTS = (">", ">>", ">|", "&>", "&>>", ">&")  # a file written: a temp folder's, or a descriptor copied
WATCH_SINKS = ("/dev/null", "/dev/stdout", "/dev/stderr")
# Shell words that stand alone as a piece of a loop, a conditional or a group; the ones that lead a command (`while`,
# `until`, `if`, `do`, `then`, `!`, `{`) are _normal's SHELL_LEADERS. `for`, `case`, `select` and `function` are not
# here: they bind or match names, which a watch that expands nothing cannot use.
WATCH_ALONE = frozenset(("do", "then", "else", "done", "fi", "{", "}"))

# The fleet CLI's commands that watch, wait or read, as the words after its path; None is one word that is no option
# (the fleet's DIR); True when more words may follow. `fleets gate run -- COMMAND` runs a command and `gate free` ends
# another's hold: neither is here.
FLEET_WATCHES = (
    (("chat", None, "watch"), True),
    (("chat", None, "wait"), True),
    (("fleets", "gate", "take"), True),
    (("fleets", "gate"), False),
    (("turn",), True),
)

# curl reads a local server and nothing else: a GET with these options alone, to this machine. A GET to another host
# can be the act itself (a deploy hook that fires on GET), and auto mode judges it only as a Bash call. Everything
# curl has beyond these (a body, a method, an upload, a config file, an output file, `--next`, another scheme, a
# redirect followed with -L) is refused by not being listed.
CURL_PLAIN = "sSfkIiv"
CURL_LONG = frozenset(("--silent", "--show-error", "--fail", "--fail-with-body", "--insecure", "--head", "--include",
                       "--verbose"))
CURL_VALUED = frozenset(("-m", "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "-H",
                         "--header", "-A", "--user-agent", "-w", "--write-out", "-o", "--output"))
LOOPBACK = frozenset(("localhost", "127.0.0.1", "::1"))


class NotWatch(Exception):
    """Why a Monitor command is no watch: the words that end "this Monitor command is no watch: ..."."""


def _loopback(url, schemes, bare=None):
    """Whether `url` names this machine: a scheme of `schemes` (none given reads as `bare`), a host of LOOPBACK, no
    user part, and no character two URL parsers could read two ways."""
    from urllib.parse import urlsplit
    if not url or "\\" in url or any(not "!" <= c <= "~" for c in url):
        return False
    if "://" not in url:
        if bare is None:
            return False
        url = f"{bare}://{url}"
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 - a port that is no number raises here
    except ValueError:
        return False
    return parts.scheme in schemes and "@" not in parts.netloc and parts.hostname in LOOPBACK


def _watch_curl(names):
    """Why this curl is no read of a local server, or None."""
    i, urls = 0, []
    while i < len(names):
        word = names[i]
        valued, joined = None, None
        if word.startswith("--"):
            name, equals, value = word.partition("=")
            if name in CURL_VALUED:
                valued, joined = name, value if equals else None
            elif word not in CURL_LONG:
                return f"`curl {_one_line(word, 40)}` is not one of the options a watch's curl takes"
        elif word.startswith("-") and len(word) > 1:
            letters = word[1:]
            if f"-{letters[-1]}" in CURL_VALUED and all(c in CURL_PLAIN for c in letters[:-1]):
                valued = f"-{letters[-1]}"
            elif not all(c in CURL_PLAIN for c in letters):
                return (f"`curl {word}` is not one of the options a watch's curl takes (an option's value is a word "
                        "of its own)")
        else:
            urls.append(word)
        if valued is None:
            i += 1
            continue
        if joined is None and i + 1 >= len(names):
            return f"`curl {word}` has no value"
        value = names[i + 1] if joined is None else joined
        if valued in ("-o", "--output") and value != "/dev/null":
            return (f"`curl {valued}` to `{_one_line(value, 40)}` writes a file: a watch's curl writes to /dev/null or to "
                    "its output")
        if valued in ("-w", "--write-out") and (value.startswith("@") or "%output" in value):
            return f"`curl {valued}` with a format that reads or writes a file"
        i += 2 if joined is None else 1
    for url in urls:
        if not _loopback(url, ("http", "https"), bare="http"):
            return (f"`curl {_one_line(url, 60)}` is not a read of this machine (http or https to localhost, 127.0.0.1 "
                    "or [::1]): a request to another host is a Bash call, where auto mode judges it")
    return None


# date prints the clock, and sets it with `-s`/`--set` or with an operand that is no `+FORMAT` (`date 010100002020`).
# So its options are allowed by name, as curl's are: a long one in full, a short one in a cluster up to the first that
# takes a value.
DATE_PLAIN = "uR"
DATE_LONG = frozenset(("--utc", "--universal", "--rfc-email", "--iso-8601", "--debug", "--resolution"))
DATE_VALUED = frozenset(("-d", "--date", "-r", "--reference", "--rfc-3339"))


def _watch_date(names):
    """Why this date could set the clock, or None."""
    i = 0
    while i < len(names):
        word = names[i]
        i += 1
        if word.startswith("+"):
            continue
        known = len(word) > 1 and word.startswith("-")
        if word.startswith("--"):
            name, equals, _ = word.partition("=")
            if name in DATE_VALUED:
                i += 0 if equals else 1
            else:
                known = name in DATE_LONG and (not equals or name == "--iso-8601")
        elif known:
            for k, c in enumerate(word[1:], 1):
                if c == "I":  # -I[FMT]: what follows is its format
                    break
                if f"-{c}" in DATE_VALUED:  # its value is what follows, or the next word
                    i += 1 if k == len(word) - 1 else 0
                    break
                if c not in DATE_PLAIN:
                    known = False
                    break
        if not known:
            return (f"`date {_one_line(word, 40)}` can set the clock (`-s`, `--set`, an operand that is no `+FORMAT`): a "
                    "watch's date takes a `+FORMAT` and `-u`, `-R`, `-I`, `-d`/`--date`, `-r`/`--reference`, "
                    "`--iso-8601`, `--rfc-email`, `--rfc-3339`")
    return None


# The shell evaluates some words of a test a second time, and then expands what the quotes kept from the lexer.
# Measured 2026-10-13 on bash 5.3.9, each ran `touch M`: `[[ 'a[$(touch M)]' -eq 0 ]]` (a side of a numeric comparison
# in `[[` is arithmetic, and arithmetic expands a subscript), `: 'a[$(touch M)]'; [[ _ -eq 0 ]]` (arithmetic reads a
# name's value as an expression, and `$_` is the last command's last word), `-v 'a[$(touch M)]'` in `[[`, `[` and
# `test`, and `printf -v 'a[$(touch M)]' x` (on zsh 5.9 too). So each side of a numeric comparison is a number or `$?`,
# and `-v` is refused in a test and in printf: a watch sets no variable to test or to fill.
TEST_NUMERIC = frozenset(("-eq", "-ne", "-lt", "-le", "-gt", "-ge"))
TEST_NUMBER_RE = re.compile(r"-?[0-9]+|\$\?")


def _watch_test(names):
    """Why the shell would evaluate a word of this test (`test`, `[`, `[[`) a second time, or None."""
    for i, word in enumerate(names):
        if word == "-v":
            return "a test with `-v` evaluates the name it tests, a subscript and what it holds included"
        if word in TEST_NUMERIC:
            sides = names[i - 1:i] + names[i + 1:i + 2]
            if len(sides) < 2 or not all(TEST_NUMBER_RE.fullmatch(side) for side in sides):
                return (f"a test evaluates each side of `{word}` as arithmetic, which can run a command: in a watch each "
                        "side is a number or `$?`")
    return None


def _watch_printf(names):
    """Why this printf would evaluate a name, or None."""
    if names and names[0].startswith("-v"):
        return "`printf -v` evaluates the name it fills, a subscript and what it holds included"
    return None


# The commands a watch may run, by their bare name (a path is no name: `./tail` is another program). A command with
# no entry of its own takes any argument: it prints, waits or reads, and has no option that writes a file, runs a
# program or changes a process. The others say what limits them:
#   subs     the subcommands that only read, each named right after the tool and its `globals` (options with no value)
#            and `valued` ones (options whose value is the next word): an option the hook does not know before the
#            subcommand could take the subcommand's place as its value, so it is refused;
#   no       options refused wherever they stand, because they write a file or run a program (_watch_flag);
#   check    a function that reads the arguments itself;
#   paths    its words that are no options are files or strings, so an unquoted pattern passes when it starts with a
#            letter, a digit, `/` or `.`: what it expands into starts the same way, and so is no option. For the
#            others any unquoted pattern is refused: its second match could stand where a subcommand or a URL does.
# Why each is here: the shell's own (`:`, true, false, test, `[`, `[[`, echo, printf, break, continue, exit, cd, sleep)
# make the loop; cat, head, tail, wc, grep, ls, stat, ps, pgrep and jq read a file or the process table and write to
# their output alone; date prints the clock; inotifywait waits on a file; journalctl and systemctl read a unit's log
# and state; jj, git and gh read history and CI, the subcommands a fleet polls; curl reads a local server. grep's
# refused options are ugrep's, which is the grep of a Claude Code shell (its `grep` function runs the bundled ugrep
# 7.8, and hands these options to the system's grep, which has none of them; measured: ugrep's `--filter` ran a
# command). Not here, by decision: awk and sed (`system()`, `w file`, `e`), sort and uniq (an output file), find and
# xargs (`-exec`, `-delete`), rg (`--pre`), tee, every interpreter (sh, bash, python, node), env, eval, source, exec,
# trap and alias.
WATCH_READS = {
    **dict.fromkeys((":", "true", "false", "echo", "break", "continue", "exit", "cd", "sleep",
                     "cat", "head", "tail", "wc", "ls", "stat", "ps", "jq"), {}),
    **dict.fromkeys(("test", "[", "[["), {"check": _watch_test, "paths": True}),
    "printf": {"check": _watch_printf},
    "date": {"check": _watch_date},
    "grep": {"no": ("--filter", "--pager", "--view", "--config", "---", "--save-config", "--format-open"), "paths": True},
    "pgrep": {"no": ("--signal",)},
    "inotifywait": {"no": ("-o", "--outfile", "-d", "--daemon", "-s", "--syslog")},
    "journalctl": {"no": ("--vacuum", "--rotate", "--flush", "--sync", "--relinquish", "--smart-relinquish",
                          "--setup-keys", "--update-catalog", "--cursor-file")},
    "systemctl": {"subs": (("status",), ("is-active",), ("is-failed",), ("show",)),
                  "globals": ("--user", "--system", "--no-pager", "-q", "--quiet", "-l", "--full"),
                  "valued": ("-n", "--lines", "-o", "--output", "-p", "--property", "-t", "--type", "--state")},
    "jj": {"subs": (("log",), ("st",), ("status",), ("op", "log"), ("operation", "log")),
           "globals": ("--ignore-working-copy", "--no-pager", "--quiet"),
           "valued": ("-R", "--repository", "--at-operation", "--at-op", "--color"),
           "no": ("--config", "--config-file", "--config-toml", "--tool")},
    "git": {"subs": (("log",), ("status",)),
            "globals": ("--no-pager", "--no-optional-locks"),
            "valued": ("-C", "--git-dir", "--work-tree"),
            "no": ("-c", "--config-env", "--exec-path", "--output", "--ext-diff")},
    "gh": {"subs": (("run", "view"), ("run", "list"), ("run", "watch"), ("pr", "view"), ("pr", "checks")),
           "no": ("-w", "--web")},
    "curl": {"check": _watch_curl},
}


def _watch_dollar(text, i, quoted):
    """A `$` at i: the text it stands for and the index after it, or NotWatch when bash would expand it."""
    after = text[i + 1:i + 2]
    if after == "?":
        return "$?", i + 2
    if after in WATCH_EXPANDS or (not quoted and after in ("'", '"')):
        raise NotWatch(f"`{_one_line(text[i:i + 12], 12)}` expands when it runs, so what runs is not what is read")
    return "$", i + 1


def _watch_word(text, i):
    """The shell word that starts at i, as (its value, whether a glob character stands unquoted in it, whether no part
    of it is quoted, the index after it). The index is i when no word starts there."""
    out, n = [], len(text)
    start, glob, brace, plain = i, False, False, True
    while i < n:
        c = text[i]
        if c in " \t\n<>&;|()":
            break
        if c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise NotWatch("it has an open quote")
            out.append(text[i + 1:j])
            i, plain = j + 1, False
        elif c == '"':
            i, plain = i + 1, False
            while True:
                if i >= n:
                    raise NotWatch("it has an open quote")
                c = text[i]
                if c == '"':
                    i += 1
                    break
                if c == "`":
                    raise NotWatch("it has a backtick substitution")
                if c == "\\" and text[i + 1:i + 2] in ("$", "`", '"', "\\"):
                    out.append(text[i + 1])
                    i += 2
                elif c == "$":
                    value, i = _watch_dollar(text, i, True)
                    out.append(value)
                else:
                    out.append(c)
                    i += 1
        elif c == "\\":
            if i + 1 >= n or text[i + 1] == "\n":
                raise NotWatch("it continues a line with a backslash")
            out.append(text[i + 1])
            i, plain = i + 2, False
        elif c == "`":
            raise NotWatch("it has a backtick substitution")
        elif c == "$":
            value, i = _watch_dollar(text, i, False)
            out.append(value)
        elif c == "#" and i == start:
            raise NotWatch("it has a `#` the hook cannot tell from a comment")
        else:
            glob = glob or c in "*?[]"
            brace = brace or c in "{}"
            out.append(c)
            i += 1
    word = "".join(out)
    if brace and word not in ("{", "}"):
        raise NotWatch(f"`{_one_line(word, 40)}` has an unquoted brace, which the shell can expand into other words: "
                       "quote it")
    return word, glob and word not in ("[", "]", "[[", "]]"), plain, i


def _watch_lex(text):
    """A simple command as (its words, each with whether a glob character stands unquoted in it and whether no part of
    it is quoted; the files its redirections write). NotWatch for anything that is decided when it runs, or that the
    hook cannot read."""
    words, writes = [], []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\n":
            i += 1
        elif c in "<>" or (c == "&" and text[i + 1:i + 2] == ">"):
            j = i
            while j < n and text[j] in "<>&|":
                j += 1
            op = text[i:j]
            while j < n and text[j] in " \t":
                j += 1
            target, glob, _, after = _watch_word(text, j)
            if after == j or op not in WATCH_INPUTS + WATCH_OUTPUTS:
                raise NotWatch(f"its redirection `{_one_line(text[i:after + 8], 24)}` is a here-document, a process "
                               "substitution or one the hook cannot read")
            if target.startswith(("/dev/tcp/", "/dev/udp/")):
                raise NotWatch(f"its redirection `{_one_line(target, 60)}` opens a network connection")
            if op in WATCH_OUTPUTS and not (op == ">&" and (target.isdigit() or target == "-")):
                if glob:
                    raise NotWatch(f"it writes to `{_one_line(target, 60)}`, a pattern")
                writes.append(target)
            i = after
        elif c in "&;|()":
            raise NotWatch("it has a subshell, a function or a group in parentheses" if c in "()" else
                           f"it has a `{c}` the hook cannot place")
        else:
            word, glob, plain, i = _watch_word(text, i)
            if plain and word.isdigit() and text[i:i + 1] in ("<", ">"):
                continue  # the descriptor of the redirection that follows
            words.append((word, glob, plain))
    return words, writes


def _watch_flag(word, no):
    """The option of `no` that `word` gives, or None. A long option counts when either name starts with the other
    (git and the GNU tools take a unique prefix, and `--vacuum` stands for its three); a short one when its letter is in
    the word's cluster (`-qo`, `-ofile`)."""
    if len(word) < 2 or word[0] != "-" or word == "--":
        return None
    if word.startswith("--"):
        name = word.split("=", 1)[0]
        return next((f for f in no if f.startswith("--") and (name.startswith(f) or f.startswith(name))), None)
    cluster = re.match(r"-([A-Za-z0-9]*)", word).group(1)
    return next((f for f in no if not f.startswith("--") and f[1] in cluster), None)


def _watch_reads(head, args):
    """NotWatch unless `head`, a name of WATCH_READS, only reads with these arguments."""
    spec = WATCH_READS[head]
    if not spec:
        return
    names = [word for word, _, _ in args]
    for word, glob, _ in args:
        if glob and not (spec.get("paths") and (word[0].isalnum() or word[0] in "/.")):
            raise NotWatch(f"an unquoted `*`, `?` or `[` among the words of `{head}` could expand into an option"
                           + (": quote it, or start the pattern with its folder (`./*.log`)" if spec.get("paths") else
                              " or one more argument: quote it"))
    if "check" in spec:
        why = spec["check"](names)
        if why:
            raise NotWatch(why)
        return
    for word in names:
        flag = _watch_flag(word, spec.get("no", ()))
        if flag:
            raise NotWatch(f"`{head}` with `{flag}` (`{_one_line(word, 40)}`) can write a file or run a program")
    subs = spec.get("subs")
    if not subs:
        return
    i = 0
    while i < len(names):
        word = names[i]
        if word in spec.get("globals", ()) or (word.startswith("--") and word.split("=", 1)[0] in spec.get("valued", ())
                                              and "=" in word):
            i += 1
        elif word in spec.get("valued", ()):
            i += 2
        else:
            break
    if not any(tuple(names[i:i + len(sub)]) == sub for sub in subs):
        raise NotWatch(f"`{_one_line(' '.join([head, *names[:i + 2]]), 60)}` is not a `{head}` command that only reads "
                       f"({', '.join(' '.join(sub) for sub in subs)}), named right after `{head}` and its global options")


def _fleet_clis(hook):
    """Every path the fleet CLI has on this machine, resolved: this plugin's, and the ones fleet/bin/fleet hands over
    to (the checkouts in $CLAUDE_CODE_PLUGIN_DIRS, the marketplace clone, each cached version). A session keeps the
    plugin folder it started with, and the CLI prints the newest one's path, so a session names more than one."""
    home = hook.env.get("HOME") or ""
    roots = [str(ROOT), *(hook.env.get("CLAUDE_CODE_PLUGIN_DIRS") or "").split(":")]
    if os.path.isabs(home):
        plugins = os.path.join(home, ".claude", "plugins")
        roots.append(os.path.join(plugins, "marketplaces", "tstack"))
        cache = os.path.join(plugins, "cache", "tstack", "tstack")
        try:
            roots += [os.path.join(cache, version) for version in os.listdir(cache)]
        except OSError:
            pass
    return {os.path.realpath(os.path.join(root, "fleet", "bin", "fleet")) for root in roots if os.path.isabs(root)}


def _watch_fleet(names):
    """NotWatch unless these words, after the fleet CLI's path, are one of its watch commands."""
    for pattern, more in FLEET_WATCHES:
        if len(names) >= len(pattern) and (more or len(names) == len(pattern)) \
                and all(word == want or (want is None and not word.startswith("-")) for want, word in zip(pattern, names)):
            return
    raise NotWatch(f"`fleet {_one_line(' '.join(names[:3]), 60)}` is not one of the fleet CLI's watch commands "
                   f"({_fleet_watches()})")


def _fleet_watches():
    return ", ".join(" ".join(word or "DIR" for word in pattern) for pattern, _ in FLEET_WATCHES)


def _watch_writes_to(hook, target):
    """NotWatch unless a redirection's file is a sink or sits in a temp folder (/tmp, $TMPDIR, the scratchpad), by its
    resolved path: a link there that leads elsewhere is elsewhere. A fleet's own folder (its ledger, its record of
    grants) and a `.claude` folder (the settings, where the allow rules are) are never a watch's to write, wherever
    they sit."""
    if target in WATCH_SINKS:
        return
    roots = ["/tmp", hook.env.get("TMPDIR"), hook.input.get("scratchpad_dir")]
    real = os.path.realpath(target) if os.path.isabs(target) else None
    if real is None or not any(isinstance(root, str) and os.path.isabs(root)
                               and real.startswith(os.path.realpath(root) + os.sep) for root in roots):
        raise NotWatch(f"it writes to `{_one_line(target, 60)}`: a watch writes only to its output, or to a file named "
                       "by its absolute path under /tmp or the scratchpad")
    if ".claude" in real.split(os.sep) or any(real.startswith(os.path.realpath(d) + os.sep)
                                               for d in grant_state_dirs(hook)):
        raise NotWatch(f"it writes to `{_one_line(target, 60)}`, in a fleet's own folder or a `.claude` folder")


def _watch_piece(hook, piece, clis):
    """NotWatch unless this simple command is the fleet CLI watching or a command of WATCH_READS that only reads."""
    raw, writes = _watch_lex(piece)
    for target in writes:
        _watch_writes_to(hook, target)
    words = _watch_lex(_normal(piece))[0]
    names = [word for word, _, _ in words]
    led = raw[:len(raw) - len(names)]  # what _normal took off the head: shell words, safe assignments, wrappers
    if names != [word for word, _, _ in raw[len(led):]] or not all(plain for _, _, plain in led):
        raise NotWatch(f"`{_one_line(piece, 60)}` reads two ways")
    if not names or (len(names) == 1 and names[0] in WATCH_ALONE):
        return
    head = names[0]
    path = os.path.expanduser(head)
    if os.path.isabs(path):
        if os.path.realpath(path) not in clis:
            raise NotWatch(f"`{_one_line(head, 80)}` is a program named by its path, and not this plugin's fleet CLI")
        _watch_fleet(names[1:])
    elif head in WATCH_READS:
        _watch_reads(head, words[1:])
    else:
        raise NotWatch(f"`{_one_line(head, 40)}` is not a command a watch runs")


def watch_problem(hook, command):
    """Why this Monitor command is no watch, or None when it is one. A text the hook's own code fails on is no watch
    either: what cannot be read is not run unjudged."""
    if len(command) > WATCH_MAX_CHARS:
        return f"it is {len(command)} characters long, and a watch is a line or a short loop (at most {WATCH_MAX_CHARS})"
    if any((c < " " and c not in "\n\t") or c == "\x7f" for c in command):
        return "it holds a control character"
    try:
        clis = _fleet_clis(hook)
        for piece in _simple_commands(command):
            _watch_piece(hook, piece, clis)
    except NotWatch as e:
        return str(e)
    except (ValueError, IndexError) as e:
        return f"it does not parse as a shell command ({e})"
    except Exception:  # a text this code fails on is denied, and the failure logged
        log(hook.data_dir, f"{hook.event} fleet_monitor_watch could not read a command\n{traceback.format_exc()}")
        return "the hook could not read it"
    return None


def _watch_granted(hook, command):
    """Whether a one-time grant names this command exactly and its rule is in this session root's settings.local.json,
    read now. The record of grants alone lifts nothing: an agent can write it, and Claude Code keeps an agent from
    writing that settings file. fleet_grant_alone, which runs next, holds the call to one run, in its turn, within its
    30 minutes."""
    project = hook.env.get("CLAUDE_PROJECT_DIR")
    root = project if project and os.path.isabs(project) else hook.cwd
    settings = os.path.realpath(os.path.join(root, ".claude", "settings.local.json"))
    for d in grant_state_dirs(hook):
        raw, _ = _read_grants(d)
        for grant in _latest_grants(hook, raw or b""):
            call = _bash_call(grant["rule"])
            if call is None or grant["issued"] is None or os.path.realpath(grant["file"]) != settings or not _is_call(command, call):
                continue
            allow = _allow_of(hook, grant["file"])
            if allow is not None and grant["rule"] in allow:
                return True
    return False


def monitor_denial(hook):
    """The denial of a Monitor call that is no watch, in a session that works for a fleet; None for a watch, for a
    command the user allowed once, and for a call with neither a command nor a WebSocket."""
    tool_input = hook.input.get("tool_input") if isinstance(hook.input.get("tool_input"), dict) else {}
    command, ws = tool_input.get("command"), tool_input.get("ws")
    why = None
    if isinstance(command, str) and command.strip() and not _watch_granted(hook, command):
        why = watch_problem(hook, command)
    if why is None and ws is not None:
        url = ws.get("url") if isinstance(ws, dict) else None
        if not isinstance(url, str) or not _loopback(url, ("ws", "wss")):
            why = ("its WebSocket is not on this machine (ws or wss to localhost, 127.0.0.1 or [::1]): opening a "
                   "connection to another host is a request auto mode would judge as a Bash call")
    if why is None:
        return None
    return Deny(
        f"tstack: this Monitor command is no watch: {why}. In a fleet's session the Monitor tool only watches, because "
        "auto mode judges a Bash command and does not judge a Monitor one. Run this as a Bash call instead "
        "(`run_in_background: true` for a long one: its exit wakes you), where it is judged as any other call. When it "
        "needs the user's yes, ask for a permission first (coordinator skill, \"Ask for the permission before the "
        "call\"; a worker says `blocked:` to its coordinator): a call the user allowed once passes here too. A watch "
        f"runs only the fleet CLI's {_fleet_watches()}, and these commands: {', '.join(sorted(WATCH_READS))}; joined by "
        "pipes, `;`, `&&`, `||`, `while`, `until` or `if`, with no `$` expansion, no substitution, and no file written "
        "outside /tmp and the scratchpad.")
