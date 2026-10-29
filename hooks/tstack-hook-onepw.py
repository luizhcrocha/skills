"""1Password locked: the part of hooks/tstack-hook.py that reads a command for its use of 1Password, and detects, holds
and clears a lock (fleet/SPEC.md, "1Password locked").

It is no module of its own. The hook executes this file into its own namespace (`_onepw`), and only for a Bash call
that can matter here: its first word can be one of the tools, and a state is on disk or the output holds one of
1Password's failure texts (`onepw_hold`, `onepw_watch` in the hook). Every other call pays for none of it: the hook was
a script then, compiled from source on each call, and this part was most of what the feature added to that. So the names
this file uses and does not define (`fleet_dirs`, `fleet_now`, `_jj_sub`, `Deny`, `re`, `os`, ...) are the hook's.
"""

# 1Password locked (fleet/SPEC.md, "1Password locked"). A locked 1Password fails every agent that needs it, each on its
# own, and each retried and each fleet opened its own card. So the first such failure records it once for the machine
# (REGISTRY/onepw/locked.json), every fleet's page shows one card, and until it clears a command of that kind is denied in every
# fleet's session, while other work goes on. A lock is per kind: `ssh-agent` (SSH signing through the 1Password agent:
# jj and git on an SSH remote, ssh) and `op-desktop` (secrets read through the 1Password app: op, secretspec, and the
# bare gh and aws, shell aliases of `op plugin run`).
# The rules are narrow on purpose: a missed lock costs one more failing command, a false lock stops every fleet.
# - One classifier (onepw_use) reads a command for detection, hold and clear, and matches only a single simple command
#   whose first word is the bare tool: no list, pipeline, substitution, group or wrapper, which fail as before.
# - A lock needs a FAILED command of that kind whose output holds 1Password's own text where the tool itself puts it
#   (onepw_why): ssh's `sign_and_send_pubkey: signing failed ... from agent` at the start of a line (after jj's `git: `
#   too), and for `ssh` only when ssh itself failed to connect (exit 255: a remote command that ran is the remote's
#   business); op's `[ERROR] <date> <time> ...` line when the output is op's error lines alone and it is the last
#   (op asks the app before it runs a child, so a child's output is never op's own), or after secretspec's `Provider
#   operation failed: `. Git's "correct access rights" line is no signature: a missing remote, a permission error and
#   a network failure all print it. Nor is `account is not signed in`: `op whoami` says it with the app unlocked
#   (measured). An exit 0 never locks, whatever it prints.
# - A kind clears only by a command that read through it and exited 0 in the foreground, to its end: never secretspec
#   (it keeps a cache), gh or aws, `op run`, `jj git push` (with nothing to push it reaches no remote), a dry run, a
#   help page, or an `ssh` to a host the lock did not see fail.
# - A false lock is bounded: ONEPW_PROBE_S after a kind was locked, and after each window taken, the next held
#   command of that kind is let through, once (_onepw_window); what it does is read as any other command's.
# - A service-account or Connect token means op and secretspec never touch the app: no match at all.
# - A remote is SSH as git resolves it, read from the config files with no process: the repo's own (through a `gitdir:`
#   file, or a jj workspace's `.jj/repo` and `store/git_target`), and the user's and the system's for `insteadOf`
#   (Luiz's rewrites his https://github.com/ remotes to SSH).
# - A state file that does not read (ONEPW_BROKEN) is never a lock: it is set aside, with one line in onepw.log.
# The texts are the ones found in the session transcripts (2026-10-12): 16 results with ssh's `signing failed ... from
# agent: communication with agent failed`, 6 with `agent refused operation`; 29 `authorization prompt dismissed`, 17
# `authorization timeout` and 74 `connecting to desktop app` lines of op. 36 of those op lines came from a `cat`, a
# `tail` or a `grep` of a log, which is why the command itself must be one that uses 1Password.
Use = namedtuple("Use", "kind what host held clears")
ONEPW_KINDS = {"ssh-agent": "SSH through the 1Password agent (jj and git remotes, ssh)",
               "op-desktop": "secrets read through the 1Password app (op, secretspec, gh, aws)"}
ONEPW_FIRST = re.compile(r"""\s*(?:[A-Za-z_]\w*=(?:[^\s'"\\;&|<>()]|'[^']*'|"[^"\\]*")*[ \t]+)*"""
                         r"(jj|git|ssh|op|secretspec|gh|aws)(?=\s|$)")
ONEPW_ASSIGN = re.compile(r"[A-Za-z_]\w*=")
ONEPW_REDIRECT = re.compile(r"&>>?|>>?&?|>\||<&?|<>|<<<")
ONEPW_HOST = re.compile(r"[a-z0-9][a-z0-9._-]{0,252}")
ONEPW_LAPSE_S = 2 * 60 * 60
ONEPW_REOPEN_S = 10 * 60
ONEPW_PROBE_S = 15 * 60
ONEPW_SKEW_S = 60
ONEPW_HOSTS_MAX = 20
ONEPW_WAITING_MAX = 50
ONEPW_HELP = {"--help", "-h", "--version"}
ONEPW_SSH_ENV = ("GIT_SSH_COMMAND", "GIT_SSH", "GIT_DIR")
OP_VALUED = {"--account", "--config", "--encoding", "--format", "--session"}
OP_READS = {"read", "item", "document", "vault", "user", "group"}
OP_ASKS = {"run", "inject", "signin"}
SECRETSPEC_VALUED = {"-f", "--file", "-p", "--provider", "-P", "--profile", "-S", "--scope", "--reason", "--caller",
                     "--caller-version", "--caller-operation", "--caller-resource"}
SECRETSPEC_SUBS = {"run", "check", "get", "set", "import", "export"}
PLUGIN_VALUED = {"-R", "--repo", "--profile", "--region", "--output", "--endpoint-url", "--ca-bundle", "--color",
                 "--query", "--cli-read-timeout", "--cli-connect-timeout", "--cli-binary-format"}
SSH_VALUED = "BbcDEeFIiJLlmOoPpRSWw"
SSH_OWN_KEY = "FIiJOSW"
SSH_PLAIN_OPTIONS = {"batchmode", "connecttimeout", "connectionattempts", "loglevel", "requesttty",
                     "serveraliveinterval", "serveralivecountmax", "stricthostkeychecking", "userknownhostsfile"}
JJ_REMOTE_SUBS = {"push", "fetch", "clone"}
JJ_REMOTE_VALUED = JJ_VALUED | {"--remote", "-b", "--bookmark", "--branch", "-r", "--revision", "--revisions", "-c",
                                "--change", "--named", "-o", "--option", "--depth", "--fetch-tags"}
GIT_FETCH_VALUED = {"--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--negotiation-tip", "--refmap",
                    "--upload-pack", "-j", "--jobs", "-o", "--server-option", "--recurse-submodules-default",
                    "--filter"}
GIT_REMOTE_VALUED = {
    "push": GIT_PUSH_VALUED,
    "fetch": GIT_FETCH_VALUED,
    "pull": GIT_FETCH_VALUED | {"-s", "--strategy", "-X", "--strategy-option"},
    "clone": {"-b", "--branch", "-o", "--origin", "-u", "--upload-pack", "--template", "--reference",
              "--reference-if-able", "--separate-git-dir", "--depth", "--shallow-since", "--shallow-exclude", "-c",
              "--config", "-j", "--jobs", "--filter", "--server-option", "--bundle-uri", "--revision", "--ref-format"},
    "ls-remote": {"--upload-pack", "--exec", "--sort", "-o", "--server-option"},
}
GIT_HELP = {"--version", "-v", "--help", "-h", "--exec-path", "--html-path", "--man-path", "--info-path"}
GIT_OWN = {"-c", "--config-env", "--git-dir"}
GIT_CONFIG_SECTION = re.compile(r'\s*\[\s*([A-Za-z0-9.-]+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)')
GIT_CONFIG_KEY = re.compile(r"\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)")
SSH_SIGNING = re.compile(r"^(?:git: )?sign_and_send_pubkey: signing failed for [^\n]{0,300}? from agent: "
                         r"(?:communication with agent failed|agent refused operation)", re.M)
SSH_OWN_EXIT = 255
OP_LINE = re.compile(r"\[ERROR\] \d{4}/\d\d/\d\d \d\d:\d\d:\d\d ")
EXIT_LINE = re.compile(r"Exit code \d+")
OP_ERROR = re.compile(r"(?:^|Provider operation failed: )\[ERROR\] \d{4}/\d\d/\d\d \d\d:\d\d:\d\d [^\n]*?"
                      r"(authorization prompt dismissed|authorization timeout|"
                      r"connecting to desktop app: [^\n]{0,80}?(?:timed out|connection reset))", re.M)
ONEPW_WHY = {"signing": "SSH signing through 1Password failed", "dismissed": "the 1Password prompt was dismissed",
             "timeout": "the 1Password prompt timed out", "app": "the 1Password app did not answer"}
ONEPW_BROKEN = ("not JSON", "no kinds", "an unknown kind", "a kind's since", "a kind's cleared", "waiting", "told")
# The words of a hold lead with who tells the fleet. They once led with "Don't retry `{what}` before {next}", and a
# fleet summed that up as "I wait for that time" (Luiz, 2026-10-13): the refusal itself puts the fleet on the waiting
# list, `fleet onepw unlocked` tells it, and {next} is only when the hook lets one command through to test the lock.
ONEPW_HELD = ("1Password is locked for {kind}. {told} Do not poll and do not ask Luiz in chat: the lock was recorded "
              "for the machine at {at}, and he clears it by running `fleet onepw unlocked` in his terminal. A "
              "coordinator whose work waits on it asks him once, with an action card whose manual is that command in "
              "a ```nu block. Go on with work that needs no 1Password, or end the turn if nothing else is left. The "
              "hook lets one command of this kind through at {next}, from any fleet, to test the lock: that is its own "
              "test, not a time to wait for.")
ONEPW_SEEN = ("1Password is locked for {kind} ({why}). {told} Do not poll and do not ask Luiz in chat: the lock was "
              "recorded once for the machine at {at}, and he clears it by running `fleet onepw unlocked` in his "
              "terminal. A coordinator whose work waits on it asks him once, with an action card whose manual is that "
              "command in a ```nu block. Go on with work that needs no 1Password, or end the turn if nothing else is "
              "left.")
ONEPW_TOLD = ("This fleet is on the waiting list: it is told when Luiz says 1Password is unlocked, in its chat, "
              "or in its session when its watch is not running. Retry `{what}` then, not before.")
ONEPW_UNTOLD = ("This fleet is not in the registry, so it will not be told when 1Password is unlocked: check "
                "`{cli} onepw` before you retry `{what}`.")
ONEPW_UNKEPT = ("This fleet could not be put on the waiting list, so it will not be told when 1Password is unlocked: "
                "check `{cli} onepw` before you retry `{what}`.")


def _first_line(path):
    try:
        with open(path, "rb") as f:
            return f.read(4096).decode("utf-8", "replace").split("\n", 1)[0].strip()
    except OSError:
        return ""


def _git_dir(start, jj):
    """The git directory behind the repo `start` is in, found with no process, or None: the nearest `.git` upward, a
    directory or a file whose `gitdir:` is followed (a worktree's to its common directory). For jj a `.jj` there comes
    first: its `repo` (in a workspace, a file naming the main repo's `.jj/repo`), then that repo's `store/git_target`,
    a path relative to `store`."""
    d = start
    for _ in range(24):
        if jj and os.path.lexists(os.path.join(d, ".jj")):
            repo = os.path.join(d, ".jj", "repo")
            if os.path.isfile(repo):
                repo = os.path.normpath(os.path.join(d, ".jj", _first_line(repo)))
            target = _first_line(os.path.join(repo, "store", "git_target"))
            return os.path.normpath(os.path.join(repo, "store", target)) if target else None
        dot = os.path.join(d, ".git")
        if os.path.isdir(dot):
            return dot
        if os.path.isfile(dot):
            line = _first_line(dot)
            if not line.startswith("gitdir:"):
                return None
            gitdir = os.path.normpath(os.path.join(d, line[7:].strip()))
            common = _first_line(os.path.join(gitdir, "commondir"))
            return os.path.normpath(os.path.join(gitdir, common)) if common else gitdir
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up
    return None


def _git_config_file(path):
    """A git config file's settings as (section, subsection or None, key, value), section and key in lower case; None
    when the file does not read. An include is a setting like any other: nothing follows it."""
    try:
        with open(path, "rb") as f:
            text = f.read(SCRIPT_MAX).decode("utf-8", "replace")
    except OSError:
        return None
    out, section, name = [], None, None
    for line in text.split("\n"):
        head = GIT_CONFIG_SECTION.match(line)
        if head:
            section, line = head.group(1).lower(), head.group(3)
            name = re.sub(r"\\(.)", r"\1", head.group(2) or "") or None
        found = GIT_CONFIG_KEY.match(line) if section else None
        if found:
            value = found.group(2).strip()
            quoted = len(value) > 1 and value[0] == value[-1] == '"'
            out.append((section, name, found.group(1).lower(),
                        re.sub(r"\\(.)", r"\1", value[1:-1]) if quoted else re.sub(r"\s+[#;].*", "", value)))
    return out


def _git_user_configs(var):
    """The config files git reads beside a repo's own: the system's, then the user's ($GIT_CONFIG_GLOBAL alone when it
    is set, else $XDG_CONFIG_HOME/git/config and ~/.gitconfig)."""
    paths = [] if var("GIT_CONFIG_NOSYSTEM").lower() not in ("", "0", "false", "no", "off") else \
        [var("GIT_CONFIG_SYSTEM") or "/etc/gitconfig"]
    if var("GIT_CONFIG_GLOBAL"):
        return paths + [var("GIT_CONFIG_GLOBAL")]
    home = var("HOME")
    xdg = var("XDG_CONFIG_HOME") or (os.path.join(home, ".config") if home else "")
    return paths + [os.path.join(d, name) for d, name in ((xdg, "git/config"), (home, ".gitconfig")) if d]


def _git_rewritten(url, rewrites, push):
    """url as git rewrites it: the longest `insteadOf` prefix it starts with replaced by that setting's base, and for a
    push `pushInsteadOf` first."""
    for wanted in (("pushinsteadof", "insteadof") if push else ("insteadof",)):
        fits = [(prefix, base) for key, prefix, base in rewrites if key == wanted and prefix and url.startswith(prefix)]
        if fits:
            prefix, base = max(fits, key=lambda fit: len(fit[0]))
            return base + url[len(prefix):]
    return url


def _onepw_host(text):
    host = text.lower()
    return host if ONEPW_HOST.fullmatch(host) else None


def _ssh_url(url, cwd):
    """(whether a remote's URL goes over SSH, its host in lower case or None). SSH is `ssh://...` or the scp-like
    `[user@]host:path`: no `/` before the colon, no Windows drive, no path that exists. Any other scheme and a local
    path are not."""
    scheme = re.match(r"([A-Za-z][A-Za-z0-9+.-]*)://(?:[^/@]*@)?(\[[^\]]*\]|[^/:]*)", url)
    if scheme:
        ssh = scheme.group(1).lower() in ("ssh", "git+ssh", "ssh+git")
        return ssh, _onepw_host(scheme.group(2)) if ssh else None
    head, colon, _ = url.partition(":")
    if not colon or not head or "/" in head or len(head) == 1 or url.startswith(("~", ".")):
        return False, None
    if cwd is not None and os.path.lexists(os.path.join(cwd, url)):
        return False, None
    return True, _onepw_host(head.rpartition("@")[2])


def _over_ssh(found):
    """The (over SSH, host) of several URLs reached together: SSH when one is, with the host they share."""
    hosts = {host for ssh, host in found if ssh}
    return (True, hosts.pop() if len(hosts) == 1 else None) if hosts else (False, None)


def _onepw_remote(repo, jj, var, named=(), every=False, push=False, literal=False):
    """Whether the remote a jj or git operation reaches is over SSH: (True, its host or None), (False, None), or
    (None, None) when the hook cannot tell. `named` holds what the line names: URLs when `literal` (a clone's source),
    else remotes of the repo, where git also takes a URL or a path and jj a pattern; `every` is all the repo's
    remotes. With none named it is the remote the tool defaults to, which the repo's `origin` or its one remote
    answers only when every remote of the repo is of that kind (a branch may track another one). A URL is read as git
    rewrites it (`insteadOf`, `pushInsteadOf`), and for a push `pushurl` comes first. Unknown: no config that reads, a
    config with an include, a pattern, remotes of both kinds or several with no `origin` and none named."""
    settings, remotes, known = [], {}, literal
    for path in _git_user_configs(var):
        settings += _git_config_file(path) or []
    if not literal:
        gitdir = _git_dir(repo, jj) if repo else None
        own = _git_config_file(os.path.join(gitdir, "config")) if gitdir else None
        known = own is not None
        for section, name, key, value in own or []:
            if section == "remote" and name and key in ("url", "pushurl"):
                remotes.setdefault(name, {"url": [], "pushurl": []})[key].append(value)
        settings += own or []
    if any(section in ("include", "includeif") for section, _, _, _ in settings):
        return None, None
    rewrites = [(key, value, base) for section, base, key, value in settings
                if section == "url" and base and key in ("insteadof", "pushinsteadof")]

    def url(text, pushed):
        return _ssh_url(_git_rewritten(text, rewrites, pushed), repo)

    def remote(name):
        urls = remotes[name]
        if push and urls["pushurl"]:
            return [url(u, False) for u in urls["pushurl"]]
        return [url(u, push) for u in (urls["url"] if push else urls["url"][:1])]

    if every and not known:
        return None, None
    if named or every:
        found = []
        for name in (list(remotes) if every else named):
            if name in remotes:
                found += remote(name)
            elif literal or (not jj and re.search(r"[:/]", name)):
                found.append(url(name, push))
            elif not known or (jj and re.search(r"[*?\[\]{}:]", name)):
                return None, None
        return _over_ssh(found)
    if not known or (len(remotes) > 1 and "origin" not in remotes):
        return None, None
    each = [_over_ssh(remote(name)) for name in remotes]
    if len({ssh for ssh, _ in each}) > 1:
        return None, None
    return _over_ssh(each)


def _sub(args, valued=()):
    """The first word of args that is no option (an option in `valued` takes the next word), with the words after it."""
    i = 0
    while i < len(args):
        if args[i] in valued:
            i += 2
        elif args[i].startswith("-"):
            i += 1
        else:
            return args[i], args[i + 1:]
    return None, []


def _option_values(args, flag):
    """Every value the option `flag` is given in args, as `flag VALUE` or `flag=VALUE`."""
    return [args[i + 1] for i, a in enumerate(args[:-1]) if a == flag] + \
        [a.split("=", 1)[1] for a in args if a.startswith(flag + "=")]


def _onepw_ssh_agent(what, reach, proves=True):
    """The use of a jj or git remote operation: none when the remote is not SSH; one that only shows a lock when the
    hook cannot tell; else held, and clearing when its exit 0 `proves` the remote was reached."""
    ssh, host = reach
    if ssh is False:
        return None
    return Use("ssh-agent", what, host, bool(ssh), bool(ssh) and proves)


def _onepw_jj(args, cwd, var):
    """`jj [global options] git push|fetch|clone` on an SSH remote: `--remote NAME`, else the default one; a clone's
    source is its first word. A push clears nothing: with nothing to push, jj exits 0 without reaching the remote."""
    sub, i, _ = _jj_sub(args, cwd)
    then, j, _ = _jj_sub(args[i + 1:], cwd) if sub == "git" else (None, 0, None)
    if then not in JJ_REMOTE_SUBS or (ONEPW_HELP | {"-V", "--dry-run"}) & set(args):
        return None
    rest, repo = args[i + j + 2:], _jj_repo(args, cwd)
    if then == "clone":
        source = _sub(rest, JJ_REMOTE_VALUED)[0]
        reach = _onepw_remote(cwd, True, var, [source], literal=True) if source else (None, None)
    else:
        named = _option_values(rest, "--remote")
        reach = _onepw_remote(repo, True, var, named, "--all-remotes" in rest, then == "push")
    return _onepw_ssh_agent(f"jj git {then}", reach, then != "push")


def _onepw_git(args, cwd, var):
    """`git [options] push|fetch|pull|clone|ls-remote` on an SSH remote: the remote, URL or path that is its first
    word (a push's `--repo` too), else the default one. Never a dry-run push or a line that reaches no remote
    (`--help`, `ls-remote --get-url`); a line whose options move the config out of the files (`-c`, `--git-dir`)
    only shows."""
    sub, i, repo = _git_sub(args, cwd)
    rest, given = args[i + 1:], {a.split("=", 1)[0] for a in args[:i]}
    if sub not in GIT_REMOTE_VALUED or {"--help", "-h", "--get-url"} & set(rest) or GIT_HELP & given:
        return None
    if sub == "push" and ("--dry-run" in rest or any(re.fullmatch(r"-[A-Za-z]*n[A-Za-z]*", a) for a in rest)):
        return None
    if GIT_OWN & given or "--multiple" in rest:
        return _onepw_ssh_agent(f"git {sub}", (None, None))
    first = _sub(rest, GIT_REMOTE_VALUED[sub])[0]
    named = [first] if first else _option_values(rest, "--repo") if sub == "push" else []
    every = sub in ("fetch", "pull") and "--all" in rest and not named
    return _onepw_ssh_agent(f"git {sub}", _onepw_remote(repo, False, var, named, every, sub == "push", sub == "clone"))


def _onepw_ssh(args):
    """`ssh [options] host [command...]`: the host is the first word that is no option nor an option's value, its
    `user@` dropped. It clears nothing when an option names a key, a config, a jump or a control socket of its own."""
    i, agent = 0, True
    while i < len(args) and args[i].startswith("-") and args[i] not in ("-", "--"):
        letters = args[i][1:]
        for j, letter in enumerate(letters):
            if letter in "VGQ":
                return None
            if letter in SSH_VALUED:
                value = letters[j + 1:]
                if not value:
                    i += 1
                    value = args[i] if i < len(args) else ""
                option = re.split(r"[\s=]", value.strip(), maxsplit=1)[0].lower()
                agent = agent and letter not in SSH_OWN_KEY and (letter != "o" or option in SSH_PLAIN_OPTIONS)
                break
        i += 1
    if i < len(args) and args[i] == "--":
        i += 1
    host = _onepw_host(args[i].rpartition("@")[2]) if i < len(args) else None
    return Use("ssh-agent", "ssh", host, True, agent) if host else None


def _onepw_op(args):
    """`op` reading through the app. A read clears; `run`, `inject`, `signin` and `plugin run` ask the app and are
    held, but their exit 0 proves no read. `account`, `whoami` and the rest never ask it."""
    head = args[:args.index("--")] if "--" in args else args
    if (ONEPW_HELP | {"-v"}) & set(head):
        return None
    sub, rest = _sub(args, OP_VALUED)
    then = _sub(rest, OP_VALUED)[0]
    if sub in OP_READS and not (sub == "item" and then == "template"):
        return Use("op-desktop", f"op {sub}", None, True, True)
    if sub in OP_ASKS or (sub == "plugin" and then == "run"):
        return Use("op-desktop", "op plugin run" if sub == "plugin" else f"op {sub}", None, True, False)
    return None


def _onepw_secretspec(args, var):
    """`secretspec run|check|get|set|import|export`, unless the provider it names (`-p`, `--provider`, else
    $SECRETSPEC_PROVIDER) is not 1Password's app. It never clears: secretspec keeps a cache of what providers gave."""
    sub, rest = _sub(args, SECRETSPEC_VALUED)
    if sub not in SECRETSPEC_SUBS:
        return None
    own, i = args[:len(args) - len(rest)], 0
    while i < len(rest) and rest[i] != "--" and (sub != "run" or rest[i].startswith("-")):
        own += rest[i:i + 2] if rest[i] in SECRETSPEC_VALUED else rest[i:i + 1]
        i += 2 if rest[i] in SECRETSPEC_VALUED else 1
    if (ONEPW_HELP | {"-V"}) & set(own):
        return None
    given = [a[2:] for a in own if re.match(r"-p[^=]", a)] + _option_values(own, "-p")
    given += _option_values(own, "--provider")
    provider = given[-1] if given else var("SECRETSPEC_PROVIDER")
    if provider and provider != "onepassword" and not provider.startswith("onepassword:"):
        return None
    return Use("op-desktop", f"secretspec {sub}", None, True, False)


def _onepw_plugin(tool, args):
    """The bare `gh` or `aws`: on Luiz's machines the alias of `op plugin run --`, which asks the app before the tool
    runs. Held, and it clears nothing: the tool's exit 0 says nothing of what the plugin read. Its words name the
    subcommand only when nothing but options the hook knows stand before it, so they never hold an argument."""
    head = args[:args.index("--")] if "--" in args else args
    sub, rest = _sub(args, PLUGIN_VALUED)
    if sub in (None, "help", "version", "completion") or ONEPW_HELP & set(head) or (tool == "aws" and "help" in head):
        return None
    before = args[:len(args) - len(rest) - 1]
    named = re.fullmatch(r"[a-z][a-z0-9-]{0,30}", sub) and all(a in PLUGIN_VALUED for a in before[::2])
    return Use("op-desktop", f"{tool} {sub}" if named else tool, None, True, False)


def _onepw_words(text):
    """The words of a single simple command with its redirections dropped, or None for anything else: a list, a
    pipeline, a background job, a group, a here-document, a comment, or quoting that does not read."""
    import shlex
    lex = shlex.shlex(text, posix=True, punctuation_chars="();&|<>\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""
    words, drop = [], False
    try:
        for token in lex:
            if token and all(c in "();&|<>\n" for c in token):
                if drop or not ONEPW_REDIRECT.fullmatch(token):
                    return None
                if words and words[-1].isdigit():
                    words.pop()
                drop = True
            elif drop:
                drop = False
            elif token.startswith("#"):
                return None
            else:
                words.append(token)
    except ValueError:
        return None
    return None if drop else words


def onepw_use(command, cwd, env):
    """How a Bash command uses 1Password, or None: THE one reading for detection, hold and clear. It matches a single
    simple command whose first word is the bare tool (`jj`, `git`, `ssh`, `op`, `secretspec`, `gh`, `aws`), after
    `VAR=value` assignments and around redirections; never a list, a pipeline, a substitution, a group, a wrapper
    (`sh -c`, `timeout`, `env`, `devenv`), a path to the tool, or a line with `$` or a backtick in it. The use is its
    kind, the tool's words (never an argument), the SSH host when known, whether it is held while the kind is locked,
    and whether its exit 0 clears the kind; every use may show a lock. For `ssh` the last two hold only for a host the
    lock saw fail (_onepw_bound). With a service-account or Connect token, in the session's environment or assigned
    on the line, op and secretspec are no use at all; and where the line or the environment takes SSH out of the
    agent's hands (`GIT_SSH_COMMAND`, an assigned `SSH_AUTH_SOCK`), a jj, git or ssh use only shows."""
    first = ONEPW_FIRST.match(command)
    text = command.strip()
    if not first or "\n" in text or "$" in text or "`" in text:
        return None
    words, inline = _onepw_words(text), {}
    while words and ONEPW_ASSIGN.match(words[0]):
        name, _, value = words.pop(0).partition("=")
        inline[name] = value
    if not words or words[0] != first.group(1):
        return None
    tool, args = words[0], words[1:]

    def var(name):
        return inline[name] if name in inline else env.get(name) or ""

    if tool in ("op", "secretspec"):
        if var("OP_SERVICE_ACCOUNT_TOKEN") or (var("OP_CONNECT_HOST") and var("OP_CONNECT_TOKEN")):
            return None
        return _onepw_op(args) if tool == "op" else _onepw_secretspec(args, var)
    if tool in ("gh", "aws"):
        return _onepw_plugin(tool, args)
    use = _onepw_ssh(args) if tool == "ssh" else (_onepw_jj if tool == "jj" else _onepw_git)(args, cwd, var)
    own = any(name.startswith(("GIT_", "SSH_")) for name in inline) or \
        (tool != "ssh" and any(var(name) for name in ONEPW_SSH_ENV))
    return use._replace(held=False, clears=False) if use and own else use


def _onepw_text(kind, text):
    """Whether an output holds the failure text of this kind anywhere 1Password's tools may put it."""
    return bool((SSH_SIGNING if kind == "ssh-agent" else OP_ERROR).search(text))


def onepw_why(use, text, code=None):
    """Which 1Password failure the output of a failed command shows (a key of ONEPW_WHY), or None: the text of the
    use's kind, where the tool itself puts it. ssh's signing line stands at the start of a line (after jj's `git: `
    too); for `ssh`, only when its exit code is ssh's own (255): any other is the remote command's, whose output is
    the remote's business. secretspec puts op's line after `Provider operation failed: `. op, and gh and aws through
    it, ask the app before they run anything: the output is then op's error lines alone, the last one the failure,
    so a line a child printed, or one that stands before another error, is not op's own."""
    if use.kind == "ssh-agent":
        own = use.what != "ssh" or code == SSH_OWN_EXIT
        return "signing" if own and SSH_SIGNING.search(text) else None
    if use.what.startswith("secretspec"):
        found = next((m for m in OP_ERROR.finditer(text) if not m.group(0).startswith("[")), None)
    else:
        lines = [line for line in text.splitlines() if line.strip()]
        lines = lines[1:] if lines and EXIT_LINE.fullmatch(lines[0].strip()) else lines
        found = OP_ERROR.match(lines[-1]) if lines and all(OP_LINE.match(line) for line in lines) else None
    if not found:
        return None
    said = found.group(1)
    return "dismissed" if "dismissed" in said else "timeout" if said == "authorization timeout" else "app"


def _onepw_dir(env):
    return fleet_registry(env) / "onepw"


def _onepw_parse(text, now):
    """locked.json's text as (the state, None), or (None, why it is broken: one of ONEPW_BROKEN). What is tolerated is
    dropped: a waiting row that is no object or of no kind, a host that is none, a stamp of `again`, `lapsed`, `probe`
    or `told` that does not parse."""
    try:
        raw = json.loads(text)
    except (ValueError, RecursionError):
        return None, "not JSON"
    if not isinstance(raw, dict):
        return None, "not JSON"
    if not isinstance(raw.get("kinds"), dict):
        return None, "no kinds"
    if any(kind not in ONEPW_KINDS for kind in raw["kinds"]):
        return None, "an unknown kind"
    kinds = {}
    for kind, entry in raw["kinds"].items():
        since = _instant(entry.get("since")) if isinstance(entry, dict) else None
        if since is None or since > now + ONEPW_SKEW_S:
            return None, "a kind's since"
        cleared = entry.get("cleared")
        if cleared and not (isinstance(cleared, dict) and _instant(cleared.get("at")) is not None):
            return None, "a kind's cleared"
        entry = {k: v for k, v in entry.items() if k not in ("again", "lapsed", "probe") or _instant(v) is not None}
        hosts = entry.pop("hosts", None)
        hosts = [h for h in hosts if isinstance(h, str) and ONEPW_HOST.fullmatch(h)] if isinstance(hosts, list) else []
        kinds[kind] = {**entry, "hosts": hosts[:ONEPW_HOSTS_MAX]} if hosts else entry
    if "waiting" in raw and not isinstance(raw["waiting"], list):
        return None, "waiting"
    if "told" in raw and not isinstance(raw["told"], dict):
        return None, "told"
    state = {**raw, "v": 2, "kinds": kinds,
             "waiting": [w for w in raw.get("waiting", []) if isinstance(w, dict) and isinstance(w.get("kind"), str)
                         and w["kind"] in ONEPW_KINDS]}
    if "told" in raw:
        state["told"] = {d: at for d, at in raw["told"].items() if _instant(at) is not None}
    return state, None


def _onepw_read(env):
    """REGISTRY/onepw/locked.json as (the state, None); (None, None) when there is no file to read; (None, the reason)
    when it is broken. A broken file is never a lock."""
    try:
        text = (_onepw_dir(env) / "locked.json").read_text(encoding="utf-8")
    except OSError:
        return None, None
    except ValueError:
        return None, "not JSON"
    return _onepw_parse(text, fleet_now(env))


def _onepw_lapse(env):
    try:
        lapse = float(env.get("FLEET_ONEPW_LAPSE_S") or ONEPW_LAPSE_S)
    except ValueError:
        return ONEPW_LAPSE_S
    return lapse if lapse == lapse else ONEPW_LAPSE_S


def _onepw_status(entry, env):
    """A kind at now: `cleared` when its `cleared` is not empty, else `lapsed` once it is older than the lapse
    ($FLEET_ONEPW_LAPSE_S, 2 h), else `locked`. A cleared or lapsed kind holds nothing; `fleet onepw unlocked` settles it."""
    if entry.get("cleared"):
        return "cleared"
    return "lapsed" if max(0.0, fleet_now(env) - _instant(entry["since"])) >= _onepw_lapse(env) else "locked"


def onepw_locked(env, state):
    """The kinds that are locked now, each with its entry of the state."""
    kinds = (state or {}).get("kinds", {})
    return {kind: entry for kind, entry in kinds.items() if _onepw_status(entry, env) == "locked"}


def _onepw_bound(use, entry):
    """Whether a kind's lock binds this use: an `ssh` only to a host the lock saw fail through the agent, since an SSH
    connection with a key of its own never touches 1Password."""
    return entry is not None and (use.what != "ssh" or use.host in entry.get("hosts", ()))


def _onepw_update(hook, change):
    """Under the lock: a state that does not read is set aside as locked.json.broken, with one log line; then
    change(state or None) -> (the state to write or None to leave it, a log line or None) runs."""
    import fcntl
    folder = _onepw_dir(hook.env)
    folder.mkdir(parents=True, exist_ok=True)
    with open(folder / "onepw.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state, broken = _onepw_read(hook.env)
        lines = []
        if broken:
            os.replace(folder / "locked.json", folder / "locked.json.broken")
            lines.append(f"set aside: the state did not read ({broken})")
        state, line = change(state)
        if state is not None:
            tmp = folder / f".locked.json.{os.getpid()}"
            tmp.write_text(json.dumps(state, indent=2) + "\n")
            os.replace(tmp, folder / "locked.json")
        if lines or line:
            with open(folder / "onepw.log", "a", encoding="utf-8") as f:
                f.write("".join(f"{fleet_stamp(hook.env)} {said}\n" for said in [*lines, line] if said))
    return state


def _onepw_aside(hook):
    try:
        _onepw_update(hook, lambda state: (None, None))
    except OSError as e:
        log(hook.data_dir, f"{hook.event} onepw: could not set the state aside: {e}")


def _onepw_word(text):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", text)[:64]


def _onepw_rows(hook, use, seen):
    """One waiting row per fleet of the registry this session works for; a session whose fleet is in no registry gets
    one row with no dir (nobody to tell)."""
    at = fleet_stamp(hook.env)
    served = [(d, _registry_fleet(hook, d)) for d in fleet_dirs(hook)]
    rows = []
    for d, fleet in [(d, fleet) for d, fleet in served if fleet] or [(None, None)]:
        worker = _refused_worker(read_ledger(d) or {}, hook.input.get("agent_id"), hook.env) if d else None
        rows.append({"dir": os.path.realpath(d) if d else None, "fleet": fleet, "session": hook.session_id or None,
                     "worker": worker, "kind": use.kind, "what": use.what, "at": at, "seen": seen})
    return rows


def _onepw_key(row):
    return json.dumps([row.get("dir"), row.get("kind")])


def _onepw_add(state, rows):
    """The state with one row more for each fleet DIR and kind of `rows` it did not hold yet, while there is room
    (ONEPW_WAITING_MAX), and those rows. A fleet is told once per hold, so one row per kind is all it needs: the cap
    counts fleets, never one fleet's commands."""
    known, new = {_onepw_key(w) for w in state["waiting"]}, []
    for row in rows:
        if _onepw_key(row) not in known and len(state["waiting"]) + len(new) < ONEPW_WAITING_MAX:
            known.add(_onepw_key(row))
            new.append(row)
    return {**state, "waiting": state["waiting"] + new}, new


def _onepw_where(rows):
    return _onepw_word(rows[0]["fleet"]) if rows[0]["fleet"] else "a session"


def _onepw_told(rows, state, what):
    """The second sentence of a denial and of a note: who tells this fleet, and so when it retries `what`. Nobody when
    it is in no registry, or when `state` holds no row of it for this kind (no room was left, or the row could not be
    written)."""
    if not rows[0]["dir"]:
        return ONEPW_UNTOLD.format(cli=fleet_cli(), what=what)
    kept = {_onepw_key(w) for w in (state or {}).get("waiting", ())}
    return (ONEPW_TOLD if _onepw_key(rows[0]) in kept else ONEPW_UNKEPT).format(cli=fleet_cli(), what=what)


def _onepw_clock(at):
    return time.strftime("%H:%M", time.localtime(at)) if at is not None else "an unknown time"


def _onepw_window(entry, now):
    """When a locked kind's next probe window opens, in epoch seconds: ONEPW_PROBE_S after the latest of its `since`,
    its `again` (a failure reopened it) and its `probe` (the last window taken). A stamp ahead of now counts as now."""
    return max(min(now, _instant(entry.get(key)) or 0) for key in ("since", "again", "probe")) + ONEPW_PROBE_S


def _bash(hook):
    """This call's Bash command when its first word is a tool that uses 1Password, after any assignments, else None:
    the hook's _onepw_command let it in on its first word alone."""
    command = _onepw_command(hook)
    return command if command is not None and ONEPW_FIRST.match(command) else None


def _bash_failed(hook, response):
    """Whether the Bash call failed: the failure event, or a response that says so (an error flag, an exit code that
    is not 0)."""
    if hook.event == "PostToolUseFailure" or response.get("is_error") is True or response.get("isError") is True:
        return True
    codes = [response.get(k) for k in ("exit_code", "exitCode", "returnCode", "code")]
    return any(isinstance(c, int) and not isinstance(c, bool) and c != 0 for c in codes)


def _bash_exit(hook, response):
    """The Bash call's exit code, or None when the event does not say: the response's, else the `Exit code N` a
    failure's error opens with."""
    for key in ("exit_code", "exitCode", "returnCode", "code"):
        if isinstance(response.get(key), int) and not isinstance(response.get(key), bool):
            return response[key]
    error = hook.input.get("error")
    found = re.match(r"\s*Exit code (\d+)\b", error) if isinstance(error, str) else None
    return int(found.group(1)) if found else None


def _onepw_hold(hook):
    """PreToolUse (Bash): while a kind of 1Password use is locked, a command of that kind is denied in a fleet's
    session and its workers, and its fleet is added to those `fleet onepw unlocked` tells. Once the kind's probe
    window is open (_onepw_window), the next such command that no other gate refused takes it under the state's lock
    and is let through: one of however many arrive together, so a lock that is no longer true ends by a command that
    succeeds (_onepw_watch). A kind that cleared between the read and the lock denies nothing. Nothing else is held,
    and a state that does not read holds nothing: it is set aside."""
    command = _bash(hook)
    if command is None:
        return None
    state, broken = _onepw_read(hook.env)
    if state is None and not broken:
        return None
    use = onepw_use(command, hook.cwd, hook.env)
    if use is None:
        return None
    if broken:
        return _onepw_aside(hook)
    entry = onepw_locked(hook.env, state).get(use.kind)
    if not use.held or not _onepw_bound(use, entry) or not fleet_dirs(hook):
        return None
    rows, now, seen = _onepw_rows(hook, use, "held"), fleet_now(hook.env), {"entry": entry, "state": state}

    def change(state):
        entry = onepw_locked(hook.env, state).get(use.kind)
        seen.update(entry=entry if _onepw_bound(use, entry) else None, state=state)
        if seen["entry"] is None:
            return None, None
        if now >= _onepw_window(entry, now) and not hook.denied:
            seen["entry"] = None
            probed = {**entry, "probe": fleet_stamp(hook.env)}
            return ({**state, "kinds": {**state["kinds"], use.kind: probed}},
                    f"probe: {use.what} in {_onepw_where(rows)} is let through to test {use.kind}")
        state, new = _onepw_add(state, rows)
        seen["state"] = state
        return (state, f"held: {use.what} in {_onepw_where(rows)}") if new else (None, None)

    try:
        _onepw_update(hook, change)
    except OSError as e:  # the denial stands on what was read; the row is lost, and no window is taken
        seen.update(entry=entry, state=state)
        log(hook.data_dir, f"{hook.event} onepw_hold: could not record the hold: {e}")
    held = seen["entry"]
    if held is None:  # it cleared or lapsed since the read, or this call took the probe window
        return None
    since = _instant(held["since"])
    opens = max(now, min(_onepw_window(held, now), since + _onepw_lapse(hook.env)))
    return Deny(ONEPW_HELD.format(kind=ONEPW_KINDS[use.kind], at=_onepw_clock(since), next=_onepw_clock(opens),
                                  told=_onepw_told(rows, seen["state"], use.what)))


def _onepw_record(hook, use, why):
    """A failure of 1Password's own, seen in a fleet's session: the kind's lock is joined while it is locked, reopened
    as the same lock (its `since` kept, `again` set) when it was cleared less than ONEPW_REOPEN_S ago, else recorded
    anew. The entry and the state after it, and the session's rows."""
    rows, now, stamp = _onepw_rows(hook, use, "failed"), fleet_now(hook.env), fleet_stamp(hook.env)
    where, seen = _onepw_where(rows), {}

    def record(state):
        state = state or {"v": 2, "kinds": {}, "waiting": []}
        entry = state["kinds"].get(use.kind)
        status = _onepw_status(entry, hook.env) if entry else None
        reopens = status == "cleared" and now - _instant(entry["cleared"]["at"]) < ONEPW_REOPEN_S \
            and now - _instant(entry["since"]) < _onepw_lapse(hook.env)
        if status == "locked":
            entry, line = dict(entry), f"another waits: {use.kind} in {where}"
        elif reopens:
            entry = {**{k: v for k, v in entry.items() if k not in ("cleared", "lapsed")}, "again": stamp}
            line = f"still locked: {use.kind} failed again in {where}"
        else:
            entry, line = {"since": stamp, "why": ONEPW_WHY[why]}, f"locked: {ONEPW_WHY[why]} ({use.kind} in {where})"
        hosts = entry.get("hosts", [])
        hosted = use.host is not None and use.host not in hosts and len(hosts) < ONEPW_HOSTS_MAX
        if hosted:
            entry["hosts"] = [*hosts, use.host]
        state, new = _onepw_add({**state, "kinds": {**state["kinds"], use.kind: entry}}, rows)
        seen.update(entry=entry, state=state)
        if status == "locked" and not new:
            return (state, None) if hosted else (None, None)
        return state, line

    _onepw_update(hook, record)
    return seen["entry"], seen["state"], rows


def _onepw_watch(hook):
    """PostToolUse and PostToolUseFailure (Bash). A FAILED command that uses 1Password and whose output holds
    1Password's own text for its kind, where the tool itself puts it (onepw_why), records that kind's lock once for
    the machine, or joins it (a fleet's session only; the session is told on PostToolUse, the one of the two whose
    output is read). A command that read through a locked kind and exited 0, in the foreground and to its end, with
    none of that text in its output, clears that kind alone, in any session: the command a probe window let through
    is read as any other."""
    command = _bash(hook)
    if command is None:
        return None
    response = hook.input.get("tool_response") if isinstance(hook.input.get("tool_response"), dict) else {}
    if response.get("interrupted") or hook.input.get("is_interrupt"):
        return None
    if _bash_failed(hook, response):
        text = _bash_output(hook.input)
        if not (SSH_SIGNING.search(text) or OP_ERROR.search(text)):
            return None
        use = onepw_use(command, hook.cwd, hook.env)
        why = onepw_why(use, text, _bash_exit(hook, response)) if use else None
        if why is None or not fleet_dirs(hook):
            return None
        entry, state, rows = _onepw_record(hook, use, why)
        if hook.event != "PostToolUse":
            return None
        return ONEPW_SEEN.format(kind=ONEPW_KINDS[use.kind], why=ONEPW_WHY[why],
                                 at=_onepw_clock(_instant(entry["since"])), told=_onepw_told(rows, state, use.what))
    background = hook.input["tool_input"].get("run_in_background") or "backgroundTaskId" in response
    if hook.event != "PostToolUse" or not response or background:
        return None
    state, broken = _onepw_read(hook.env)
    if state is None and not broken:
        return None
    use = onepw_use(command, hook.cwd, hook.env)
    if use is None:
        return None
    if broken:
        return _onepw_aside(hook)
    if not use.clears or not _onepw_bound(use, onepw_locked(hook.env, state).get(use.kind)):
        return None
    if _onepw_text(use.kind, _bash_output(hook.input)):  # it got through another way: ssh fell back to a key of its own
        return None

    def clear(state):
        entry = onepw_locked(hook.env, state).get(use.kind)
        if not _onepw_bound(use, entry):
            return None, None
        cleared = {**entry, "cleared": {"at": fleet_stamp(hook.env), "by": "command", "note": use.what}}
        return ({**state, "kinds": {**state["kinds"], use.kind: cleared}},
                f"cleared: {use.kind} by a command ({use.what}) in session {_onepw_word(hook.session_id) or 'unknown'}")

    _onepw_update(hook, clear)
    return None
