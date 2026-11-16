# memo v2: the sketch

The types, signatures and module map for `scripts/memo` and the hooks. No body is implemented. The data shapes are in [design.md](design.md). This file follows the `architect` skill's rationale template. One Decider compared the candidates under [Synthesis decision](#synthesis-decision). No arena of runners ran.

## Problem

memo must hold four kinds of store in place of two, read a fixed number of bytes at session start, and stop holding work. Five constraints of the existing system shape the sketch:

- `scripts/memo` is one Python file on the standard library. The SessionStart hook loads it as a module on every session start, inside a 10-second budget. The hook measured 42 ms in October.
- Notes stay out of every code history (Luiz, 2026-11-16). A repo's notes travel on a `memo` bookmark of the repository's remote, the machine, group and user notes on the `memo` bookmark of the dotfiles' remote, and no checkout has a note in its working tree.
- The dotfiles are a jj checkout on the admin machine and a plain git clone on the others, so the exchange cannot need jj.
- Nothing may ask Luiz to maintain notes (2026-11-16). No step, warning or report is addressed to him.
- An agent cannot pass a 1Password approval, so no fetch and no push can run unattended. Luiz's git also signs commits through 1Password.
- A session start lists file names and parses only new files. On 4,101 notes the names took 1.5 ms, a stat of each file 12 ms, and a read of each file 45 ms.
- About 4,900 notes and about 310 summaries exist in the old format, in six repositories and the global store, and their files must stay readable.

## Usage (caller's view)

A session in `luizhcrocha/skills` on cr-sede-pc. The repository is in the group `tooling`.

```text
$ memo doctor
user                         home/user                         1,840 of 3,000 bytes   61 notes, 4 summaries
machine:cr-sede-pc           home/machine/cr-sede-pc             412 of 1,900 bytes    2 notes
group:tooling                home/group/tooling                2,377 of 2,500 bytes   48 notes, 3 summaries
repo:luizhcrocha/skills      home/repo/luizhcrocha/skills      5,710 of 6,000 bytes  141 notes, 9 summaries
start read: 10,939 of 14,000 bytes
last 14 days: 31 notes, 0 refused for length, 1 look-alike pair, 2 notes that name a commit
repo:luizhcrocha/skills      4 notes wait for a sync, the oldest for 2 days
no finding
```

```text
$ memo note "statechart draws no chart above 500 states when every rule holds; split the config"
noted 01M8F3K2X9T4V7QH5N6R8W0YZA repo:luizhcrocha/skills

$ memo note --scope user "Luiz reads a design as a page first, then the files"
noted 01M8F3M7… user
memo: every session in every repo reads a user note.

$ memo note "The memo-v2 design landed as 4ccb1e90"
noted 01M8F3P1… repo:luizhcrocha/skills
memo: this names a commit, which reads as status. A note must still be true in a month and not be in
`jj log` already. If it is status: memo retire 01M8F3P1 "status"

$ memo note --scope repo:luizhcrocha/fleet "fleet 1.9.x has no `fleet council`; test `fleet council --help` first"
noted 01M8F3R4… repo:luizhcrocha/fleet
memo: sessions in luizhcrocha/fleet read this note after that store's next sync. This session does not.

$ memo note "A line of 300 characters …"
memo: 300 characters, 20 over the 280 limit; say the fact and the reason, drop the story.     (exit 2)
```

```text
$ memo supersede Q4KT23 "Commands handed to Luiz are nushell on every machine, the Mac included"
noted 01M8F4… user, superseding Q4KT23

$ memo retire 8YTTNS "an open thread, now D7 of the tstack fleet"
retired 8YTTNS repo:luizhcrocha/skills

$ memo summarize CMM3RN BFKX9K … --keep CMM3RN --keep ZBER2Z
summarized 11 notes as 01M8F5… [level 1, keeps 2] repo:luizhcrocha/skills

$ memo sync
luizhcrocha/skills           fetched 3 notes, pushed 4 notes to memo
luizhcrocha/dotfiles         fetched 0 notes, pushed 2 notes to memo     (user, machine:cr-sede-pc, group:tooling)

$ memo sync                  # offline, or nobody approved the key in 1Password
luizhcrocha/skills           no answer from origin in 20 seconds. 4 notes wait here for the next sync.     (exit 0)
```

The hook, the land playbook and the dotfiles call one function and one command:

```python
# hooks/tstack-hook.py
def memo_start(hook):
    """SessionStart: bring in the notes the dotfiles checkout holds, then print the start read."""
    return memo().start_text(hook.env, hook.cwd) or None
```

```text
# tuca-mode's land playbook, step 7, after `jj git push --bookmark <bookmark>` succeeds
memo sync
```

```sh
# dotfiles, bin/entropic-update, after the pull
memo_bin="$(command -v memo || true)"
if [ -z "$memo_bin" ]; then   # as bin/memo-dream-night finds the plugin today
  root="$(jq -r '.plugins["tstack@tstack"][0].installPath // empty' \
    "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json" 2>/dev/null || true)"
  [ -n "$root" ] && [ -x "$root/bin/memo" ] && memo_bin="$root/bin/memo"
fi
if [ -n "$memo_bin" ]; then
  "$memo_bin" sync --all || warn "memo sync failed: the notes stay local until the next update"
else
  info "no memo on this machine yet: the memo step is skipped"
fi
```

## Shape

### Records

```python
ScopeKind = Literal["repo", "machine", "group", "user"]

@dataclass(frozen=True)
class Scope:
    kind: ScopeKind
    name: str                      # "owner/repo" or a path; the machine's name; the group's name; "" for user

    def __str__(self) -> str: ...  # "repo:owner/repo", "machine:cr-sede-pc", "group:agent-tools", "user"

def parse_scope(text: str) -> Scope:
    """Parse a scope. In an old file, "project:<key>" is the repo scope and "global" is the user
    scope: the old global folder is read as the user store until the migration re-files it."""
    raise NotImplementedError

@dataclass(frozen=True)
class Note:
    id: str
    scope: Scope
    by: str
    at: str
    text: str                      # one line, at most 280 characters
    refs: tuple[str, ...] = ()
    supersedes: tuple[str, ...] = ()

@dataclass(frozen=True)
class Retirement:
    id: str
    scope: Scope
    by: str
    at: str
    reason: str
    retires: tuple[str, ...]       # at least one id: notes or summaries

@dataclass(frozen=True)
class Summary:
    id: str
    scope: Scope
    by: str
    at: str
    level: int                     # >= 1
    covers: tuple[str, ...]        # at least one id
    keeps: tuple[str, ...] | None  # None: an old rewritten summary, never in effect
    old_text: str = ""             # the rewritten line of an old summary, for zoom and recall

Record = Note | Retirement | Summary

def parse_record(folder: Literal["notes", "summaries", "retired"], content: str, expect_id: str) -> Record:
    """The folder says which record a file is. Old fields (`kind`, `pin`) are read and dropped.
    Raises ValueError on a file that is not a valid record of its folder."""
    raise NotImplementedError

def render_record(record: Record) -> str:
    raise NotImplementedError
```

The three record types replace one `Item` class with optional fields. A function that takes a `Note` cannot be handed a summary, and a summary without `keeps` cannot reach the start read, because `View` takes only summaries whose `keeps` is a tuple.

### Stores and the session

```python
@dataclass(frozen=True)
class Store:
    scope: Scope
    dir: Path                      # under home/, for every scope

    def path_of(self, folder: str, id: str) -> Path: ...   # <dir>/<folder>/<id[:4]>/<id>.md
    def names(self) -> frozenset[str]: ...                 # the relative paths of the record files. Listings
                                                            # only: no stat, no read. A file directly in a
                                                            # folder, as the old stores have it, counts too

@dataclass(frozen=True)
class Group:
    name: str
    about: str
    repos: frozenset[str]          # "owner/repo"

MAX_GROUPS = 2                     # the groups one repository reads

def load_groups(path: Path) -> dict[str, Group]:
    """$XDG_CONFIG_HOME/tstack/groups.toml, which home-manager installs. Never the file in the dotfiles
    checkout. A missing file is no groups. A file that does not parse is no groups and a `memo doctor`
    finding."""
    raise NotImplementedError

def groups_of(repo: str, groups: Mapping[str, Group]) -> tuple[tuple[Group, ...], tuple[Group, ...]]:
    """The groups a repository reads (the first MAX_GROUPS by name) and the groups left out, which the
    start read and `memo doctor` name."""
    raise NotImplementedError

HEADER, USER, MACHINE, GROUPS, REPO = 600, 3000, 1900, 2500, 6000     # bytes. Constants: no file sets them
TOTAL = HEADER + USER + MACHINE + GROUPS + REPO                        # 14,000

def slice_of(scope: Scope, groups_read: int) -> int: ...               # GROUPS // groups_read for a group

@dataclass(frozen=True)
class Local:
    """$XDG_CONFIG_HOME/tstack/memo.toml, which home-manager installs."""
    machine: str | None            # the flake's name for this machine. None without the file: never the host name
    home_remote: str | None        # the dotfiles' remote, whose memo bookmark carries the machine, group
                                   # and user stores. None without the file: those stores stay local

@dataclass(frozen=True)
class Remote:
    """One `memo` bookmark and the stores it carries. None for a repository with no origin."""
    url: str                       # the origin of the checkout, as written there, or Local.home_remote
    git_dir: Path                  # $XDG_STATE_HOME/tstack/memo/git/<owner>/<repo>.git. memo's own, bare
    stores: Mapping[str, Store]    # folder in the bookmark's tree -> local store. "" is the repo store.
                                   # The dotfiles' bookmark also has "user", "machine/<name>" and "group/<name>"

@dataclass(frozen=True)
class Session:
    role: str                      # "interactive", "coordinator", "manager", "worker", …
    stores: tuple[Store, ...]      # in start-read order: user, machine (if named), groups by name, repo
    repo: Store | None             # None outside a repository
    remote: Remote | None
    unread_groups: tuple[str, ...] # the groups over MAX_GROUPS
    local: Local

def resolve_session(env: Mapping[str, str], cwd: str) -> Session:
    """The repo store is found by the origin of the checkout that holds cwd, so every checkout and
    every jj workspace of one repository resolves to one store."""
    raise NotImplementedError
```

`resolve_session` records each repo store's origin beside memo's git directory, so `memo sync --all` and `--scope repo:<owner>/<name>` know every repository that has a store on this machine without a checkout at hand.

### The view and the selection

```python
class View:
    """One store's records: what is live, what is in effect, what stands for what."""

    def __init__(self, records: Iterable[Record]) -> None: ...

    live: list[Note]                         # by id, oldest first
    out: dict[str, str]                      # id taken out -> the id of the note or retirement that names it
    in_effect: list[Summary]

    def leaves(self, summary: Summary) -> list[Note]: ...   # the live notes it stands for
    def kept(self, summary: Summary) -> list[Note]: ...     # the live notes it keeps
    def cover(self) -> list[Note | Summary]: ...            # the coarsest lines for every live note
    def notes_with(self, word: str) -> int: ...             # how many notes of the store have the word

def hint_words(view: View, hidden: Sequence[Note], limit: int = 3) -> tuple[str, ...]:
    """The most distinctive words of the hidden notes, for a count line. Pure. Every word it returns
    is a word of some note in `hidden`."""
    raise NotImplementedError

@dataclass(frozen=True)
class Section:
    scope: Scope
    lines: tuple[str, ...]         # the heading first
    left_out: int                  # live notes behind the count line; 0 when the cover fits

def select(view: View, scope: Scope, slice_bytes: int) -> Section:
    """Pure. len("\n".join(lines).encode()) <= slice_bytes, for every view and every slice.
    Over the slice, the oldest notes outside a summary leave first, and a kept note leaves only when
    the kept notes alone do not fit."""
    raise NotImplementedError

def start_text(env: Mapping[str, str], cwd: str) -> str:
    """The start read: the header and one Section per store, from the local stores.
    Empty for a fleet worker. Never longer than TOTAL bytes: it asserts that.
    It lists file names and parses only the files the index lacks. It runs no git and no network call."""
    raise NotImplementedError
```

`select` is the deep module. Its interface is three arguments and one result. It hides the choice of the summaries in effect, the cost of a summary in lines, the opening of a summary when room is left, the order in which lines leave a store that is over its slice, and the count line with its words. It reads no clock, no index and no file, so the model in [model.md](model.md) describes it exactly, and a test can call it on any set of records.

### Tasks and writes

```python
@dataclass(frozen=True)
class Task:
    level: int                     # the level of the summary the answer will write
    items: tuple[Note | Summary, ...]
    offered: tuple[Note, ...]      # the notes the answer may keep
    keep_limit: int
    # At level 2 and above, the task's text also tells the session to retire or supersede an
    # offered note that a later offered note contradicts, before it answers.

def next_task(view: View, slice_bytes: int) -> Task | None: ...
def all_tasks(view: View, slice_bytes: int) -> list[Task]: ...     # no two share an item

class Refusal(Exception):
    reason: Literal["length", "secret", "role", "usage"]           # there is no "space"

@dataclass(frozen=True)
class Advice:
    kind: Literal["look-alike", "status", "wide-scope", "other-repo"]
    text: str

def clean_text(text: str) -> str:
    """One line, at most 280 characters, no secret. Raises Refusal("length") or Refusal("secret")."""
    raise NotImplementedError

def write_note(session: Session, scope: Scope | None, text: str,
               refs: Sequence[str] = (), supersedes: Sequence[str] = ()) -> tuple[Note, bool, list[Advice]]:
    """Write a note, or find the live note of that store with the same text (the bool is False then).
    scope None is the repo's, and a usage Refusal outside a repository. A usage Refusal too for the
    machine scope without a machine name, and for another repository that has no store on this
    machine: that one names the groups the two repositories share."""
    raise NotImplementedError

def retire(session: Session, ids: Sequence[str], reason: str) -> Retirement: ...
def summarize(session: Session, ids: Sequence[str], keep: Sequence[str]) -> Summary:
    """keep must be notes among `offered` of the task these ids make. Refuses ids that overlap a
    summary in effect and names the next task."""
    raise NotImplementedError
```

`Refusal.reason` is a closed set without "space". [measures.md](measures.md) counts refusals by reason from a local log that `main` appends to.

### Exchange with a `memo` bookmark

```python
@dataclass(frozen=True)
class SyncResult:
    remote: str
    outcome: Literal["synced", "no-remote", "no-answer", "refused-3-times", "busy"]
    fetched: int                   # files written into the local store
    pushed: int                    # files added to the bookmark
    waiting: int                   # files the bookmark still lacks

def sync_bookmark(remote: Remote, machine: str | None, timeout_s: int = 20) -> SyncResult:
    """Fetch the bookmark, import by union into each of its stores, commit what the bookmark lacks,
    push without force, and repeat after a refused push, 3 times at most. Holds a lock file for the
    remote. Never raises for the network: every outcome but "synced" leaves the local stores whole
    and exits 0. Files copied in or out are written to a temporary name and renamed."""
    raise NotImplementedError

@dataclass(frozen=True)
class Waiting:
    count: int
    oldest_at: str                 # "" when count is 0

def waiting(remote: Remote) -> Waiting:
    """The record files that the last fetched bookmark lacks. No network."""
    raise NotImplementedError
```

`sync_bookmark` hides the git plumbing behind one call. The steps, each a plain git command against memo's own bare directory:

| Step | Command | Note |
| :-- | :-- | :-- |
| Fetch | `git fetch <url> +refs/heads/memo:refs/memo/remote` | A remote with no `memo` bookmark is the first push |
| Import | `git ls-tree -r --name-only`, then `git cat-file blob` for each path the store lacks | Temporary name, then rename |
| Tree | `git read-tree refs/memo/remote` into memo's own index, then `git add --ignore-removal` with the store as the work tree | The tree starts from the bookmark's, so no path can leave it |
| Commit | `git commit-tree --no-gpg-sign -p refs/memo/remote` | Unsigned: a signature is a second 1Password approval |
| Push | `git push <url> <commit>:refs/heads/memo` | Never `--force`. A refusal means another machine pushed: back to Fetch |

The checkout's `.git`, its hooks, its jj operation log and its working copy are never touched. A prototype of these five steps ran on 2026-11-16 against a local remote.

### The command line

```text
memo start                                  the start read (was `memo wake`)
memo note "<line>" [--scope S] [--ref R]…   S: user, machine, group:<name>. Default: the repo
memo supersede ID… "<line>"
memo retire ID… "<why>"
memo summarize ID… (--keep ID… | --keep-none)
memo tasks                                  every pending compaction task of the stores read here
memo recall <words> [--live] [--limit N] [--all]
memo zoom ID
memo sync [--all]                           this repository's bookmark and the dotfiles' bookmark, or every
                                            bookmark with a store on this machine. Fetches and pushes: no
                                            hook calls it
memo doctor [--days N]                      the stores this session reads with their slices and use, the
                                            numbers of measures.md, and every finding
memo import <file.tsv> [--scope S] [--dry-run] · memo export · memo reindex
memo migrate <step> …                       one-time, migration.md
--cwd <dir>                                 on any subcommand, as today
```

`memo note gotcha "<line>"`, the old form with a kind, is a usage refusal that prints the new form.

### Module map

`scripts/memo` stays one file on the standard library, in these sections. Each is a module in the `codebase-design` sense: a small interface over what it hides.

| Section | Interface | Hides |
| :-- | :-- | :-- |
| records | `Note`, `Retirement`, `Summary`, `parse_record`, `render_record`, `new_ulid` | The file format, the old fields, the ULID |
| session | `resolve_session`, `Session`, `Store`, `Scope`, `load_groups`, `groups_of`, `Local`, `Remote`, `slice_of` | Where each store is, the repo key from the origin, the subfolder of a record, the two config files, the limit of two groups, the fixed slices |
| view | `View` | Supersede and retire, which summaries are in effect, the tree |
| read | `select`, `start_text`, `Section`, `hint_words` | The cover, the cost in bytes, opening a summary, what leaves a store over its slice, the count line and its words, the header |
| tasks | `next_task`, `all_tasks`, `Task` | Group size, the newest quarter that is never offered, the level rule |
| write | `write_note`, `retire`, `summarize`, `clean_text`, `Advice`, `Refusal` | The role check, the same-text check, the look-alike and status tests, the atomic write |
| bookmark | `sync_bookmark`, `waiting`, `SyncResult` | memo's git directory, the five git steps, the lock, the time limit, the retry after a refused push |
| index | `Index` | SQLite and FTS5, the word counts of each store, the check by file names, the fold of look-alikes in recall |
| cli | `main`, `build_parser` | Argument parsing, exit codes, the refusal log |

`hooks/tstack-hook.py` keeps `memo()` (the loader) and gains `memo_start`. The land playbook gains `memo sync` after its push. The dotfiles gain `memo.toml` and `groups.toml` through home-manager and the memo step in `bin/entropic-update`. They gain no folder of notes and no commit for memo.

### What is deleted

| Where | What goes | Why |
| :-- | :-- | :-- |
| `scripts/memo` | `KINDS`, the `kind` argument of `memo note`, `--kind` | No kinds |
| `scripts/memo` | `cmd_open`, `cmd_pin`, `--pin`, `--unpin`, `_check_room`, `_closing`, `STALE_DAYS` | No open threads, no pins, no cap |
| `scripts/memo` | `brief`, `title`, `RECENT_DAYS`, `TITLE_CHARS`, `POINTER`, `COMPACTED`, the `clear` and `compact` forms of `wake_text` | One start read, always inside the budget |
| `scripts/memo` | `DEFAULT_PROJECT_LINES`, `DEFAULT_GLOBAL_LINES`, `MIN_LINES`, the flat form of `render`, `global_store`, `--global` | Slices in bytes, four scopes |
| `scripts/memo` | `TASK_RULES` and the rewritten line of `memo summarize` | A summary quotes |
| `scripts/memo` | The lists that `_overlap_report` and `_landed_report` print in `memo doctor` | They become advice at write time, and two counts in `memo doctor` |
| `scripts/memo` | The store in `<main repo root>/.tstack/memo/`, and the stat of every file at each start | A repo store is in `home/`, and the index is checked by file names |
| Each repository's working tree | `.tstack/memo/`, once its files are in the local store and on the `memo` bookmark ([migration.md](migration.md)) | Notes stay out of the code history |
| `scripts/land-check` | The rules for a memo note among a stack's files (`.tstack/memo/`) | No stack holds a memo note |
| `hooks/tstack-hook.py` | `memo_nudge`, `NUDGE`, `_NOTED`, the `memo` hook state | No Stop nudge |
| `hooks/tstack-hook.py` | `memo_precompact` and its text | No PreCompact request |
| `hooks/hooks.json` | The `PreCompact` entry | It has no other handler |
| `hooks/tstack-hook.py` | `memo_dream_report`, `DREAM_KEPT`, `DREAM_STUCK` | memo-dream writes no notes |
| `scripts/memo-dream` (1,137 lines), `scripts/tests/test_memo_dream.py` (1,067 lines) | The whole script and its tests | The same |
| dotfiles, `modules/hosts/cr-sede-pc.nix` | The `memo-dream` service and timer, `bin/memo-dream-night` | The same |
| `docs/models.md` | "memo-dream's judge" in the Decider row | The same |

Text that changes with it: the memo skill (rewritten), the land playbook (step 7 gains `memo sync`, and step 8 loses "memo notes written during the work land with it"), the recall skill (`memo open` in Catch-up step 5 becomes `fleet waiting` and the dossiers), tuca-mode's `pause-safely` playbook (an `open` thread naming the resume point becomes the handoff document), `session-pickup` ("the memo wake and its open threads"), the `how`, `why` and `reflect` skills (a note "of kind"), both README entries for memo, and the status line of [memo.md](../memo.md).

### Tests

The store is a state machine, so `select`, `View` and the tasks get a model-based test, as memo has today. The properties are the rules of [model.md](model.md), on stores of random records:

- A section never exceeds its slice, and `start_text` never exceeds the total.
- In a store over its slice, a note outside a summary is read beyond the newest quarter only when every summary of the cover is shown.
- Every word of a count line is a word of a note that the summary hides.
- Every line read word for word is the text of a live note file.
- No live note is stood for twice. A note is left out only behind a count line.
- The newest live note of a store is read word for word.
- For any two random stores A and B, the union of their files satisfies all of the above, and `select` gives the same result on both machines after the exchange.
- After every offered task is answered, the cover fits the slice.
- Random writes never raise a `Refusal` whose reason is outside length, secret, role and usage.
- N processes that write at once produce N files and a consistent index.

The bookmark sync gets tests against a bare repository in a temporary folder, with two local stores as two machines:

- After each machine syncs twice, both stores and the bookmark hold the union of the files.
- A push built on an old fetch is refused, and the next sync gets through without force.
- No sync removes or changes a path of the bookmark, including after a local file is deleted by hand.
- A remote that does not answer leaves the store as it was, and the command exits 0 inside its time limit.
- The dotfiles' bookmark carries four kinds of store in one tree, and each file lands in its own store on the other machine.
- The hook module never calls `sync_bookmark`, and `start_text` starts no process. The test replaces `subprocess` with a function that fails.
- `start_text` on a store of 4,000 files makes no `stat` call for a record file.

## Synthesis decision

Three whole shapes were compared.

**A. Stores in checkouts, read in place.** Every scope's store is a folder in a checkout: the repository's own, and the dotfiles' `memo/` for the other three. It is the smallest change: the store type stays as it is and nothing is copied. It lost twice. A session in repository X would read files in the working copy of the dotfiles, which other agents move. The `flake.lock` incident of 2026-11-06 is that failure. And Luiz decided on 2026-11-16 that a repository's notes stay out of its working tree and its code history.

**B. A local home and a union exchange.** The base. Every store is a local folder under `home/`. A repo store exchanges files with the `memo` bookmark of its remote, and the machine, group and user stores exchange files with the `memo` bookmark of the dotfiles' remote. It keeps reads free of version control, it works the same on a jj checkout and a git clone, and its merge rule is one sentence.

**C. One local database with a scope field.** All notes of a machine in one SQLite store, exported per scope. It would make recall and re-filing trivial. It lost because a store of files with unique names merges by union with no code, on a bookmark or in a folder, and a database does not. The database would also be a second source of truth beside the files that travel.

From A the sketch keeps nothing for the repo store, after Luiz's decision. From C it keeps one index over every store for `memo recall`.

For the summaries, two shapes were compared after the faithfulness check: a summary that rewrites and a summary that quotes ([ADR 0007](../../adr/0007-summaries-quote-notes.md)). Luiz chose the second and added the words on the count line. `Summary.keeps` being `None` for an old summary keeps the first readable without a second format.

For the bookmark, three ways to reach it were compared.

| Way | What it exposes | Why it lost or won |
| :-- | :-- | :-- |
| The checkout's own `.git`, with a ref outside `refs/heads` | A pre-push hook of the checkout runs on memo's push (one of the six repositories installs hooks through husky). An agent's jj workspace holds no `.git`, so memo must find the main one. A note for another repository needs a path to that repository's checkout | Lost |
| A jj workspace for the bookmark | A working copy of the notes in a second folder, and jj operations for each sync in the repository's operation log. The machines that hold the dotfiles as a plain git clone have no jj | Lost |
| **memo's own bare git directory for each store** | A second small object store, and the origin's URL recorded once | Won. A sync touches no checkout, so a checkout that is mid-rebase, a stale workspace and a missing checkout are all the same case |

## Tradeoffs accepted

- We accept two copies of each store (the local home and the bookmark) in exchange for reads that never depend on the state of a checkout or of the network.
- We accept that a note reaches other machines only after a landing or an `entropic-update` on both, in exchange for memo making no fetch and no push that Luiz does not stand behind.
- We accept that a repository's notes appear in no diff and no pull request, so nobody reviews them with the code, in exchange for a code history, a code search and a review without them.
- We accept a second git object store for each remote, in exchange for a sync that cannot disturb a checkout.
- We accept summaries that compress about 3 times at each level, where a rewritten line compressed 16 times, in exchange for a start read that cannot state what no note states.
- We accept that `scripts/memo` stays one file of about 1,700 lines, in exchange for a hook that loads one module with no install step.
- We accept fixed slices that leave bytes unused in a quiet scope, in exchange for a session start that costs the same every day.
- We accept that a note taken out by `supersedes` or `retires` can never come back, in exchange for a merge rule with no order: files only add.
- We accept that an open thread the migration cannot place is retired as "unplaced" with nobody asked, in exchange for a switch that needs no time from Luiz. `memo recall` still finds it, and a report file lists it.

## Alternatives considered

- **A saved view updated at each write**, as tape keeps `view.json`. It makes the read cheaper to compute. It exposes per-machine state that two machines cannot merge, and the selection would stop being a function of the files.
- **A budget in lines**, as today. The interface is simpler to explain. It does not bound bytes, which is the target.
- **Scope as a field in one repo-local store**, with user and group notes copied into every repo that reads them. It needs no dotfiles. It makes every user note a file in every repository.
- **Git notes** (`refs/notes/*`) in place of a bookmark. They attach text to commits of the code, and a memo note is about no commit. A default fetch does not bring them.
- **A sync in the SessionStart hook.** It would make every machine current at each start. It stalls on the 1Password approval that no agent can give, and it puts the network in a hook with a 10-second budget.

## Open questions and risks

- `fleet waiting` does not list designers' gates and questions. memo v2 does not wait for it, and until it does, a paused designer's questions are in its dossier only.
- The migration's pass finds a thread's owner from the session id in the note's `by` field. How each fleet's ledger and tape record that id was not checked for this design.
- Does the approval that Luiz gives for the landing push cover memo's push a moment later, from another program in the same session? 1Password decides that, and one landing on the real remote answers it. If the answer is no, the sync leaves the land playbook, because a second click is work for Luiz, and notes travel with `entropic-update` only.
- `memo sync --all` in `entropic-update` makes one fetch for each remote that has a store on the machine. tape records 22 projects on the admin machine. At about a second each, four at a time, that is about 6 seconds added to the update.
- A repository whose origin changes gets a new key. Its local store, its git directory and its line in `groups.toml` then name the old one. Should `memo doctor` only warn, or should a group accept several names for one repository?
- Is 600 bytes enough for a header that states the rule and five commands? The example in design.md is 455 bytes.
- The group size and the keep limit come from the simulation in [measures.md](measures.md), not from use. Luiz kept 12 and a quarter. The measure at day 14 says whether real sessions answer such tasks well.
- The words of a count line come from a word count, so they can be common words of one burst of work. The needle test's third session shows whether they help a session decide to zoom.

## Next implementation step

Write `select` and `View` against the model-based test, on the old stores' files, before any command changes.
