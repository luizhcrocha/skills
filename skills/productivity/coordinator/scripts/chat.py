#!/usr/bin/env python3
"""The chat between the user (on the dashboard) and the fleet, stored in DIR/chat.jsonl.

    chat.py DIR say   --as WHO [--re N] [--decision D] TEXT
                                                 append a message from WHO; print the line written
    chat.py DIR inbox --as WHO                   the messages open for WHO, oldest first
    chat.py DIR watch --as WHO [--after N | --resume] [--all] [--once] [--fleets [--batch SECONDS]]
                                                 every message open for WHO with id > N, then each
                                                 new one as it lands; never exits on its own. --all
                                                 also streams every message from the user. --resume
                                                 takes N from the last line a watch as WHO printed;
                                                 --once exits after the first lines it prints.
                                                 While it runs, DIR/watch-WHO.pid says so: the page
                                                 shows whether the host reads the chat, and a
                                                 manager's watch also prints a `!` line for each
                                                 fleet where the user's messages wait unread, and a
                                                 coordinator's for each message a worker left
                                                 unanswered for FLEET_NUDGE_S (ten minutes).
                                                 --fleets (the manager's) also prints what the user
                                                 does on every other fleet's page: a message or an
                                                 answer, a decision opened for them, decided,
                                                 withdrawn or held. With --once, the first such line
                                                 waits --batch seconds (120) for more, then exits.
    chat.py DIR wait  DECISION...                wait for the user's answer to one of these decisions,
                                                 print it and exit: armed as a background command when
                                                 a decision is opened, it wakes the session at once
    chat.py DIR log   [--after N]                the whole conversation, oldest first

WHO is `coordinator` or an agent id or name from DIR/state.json; only the
dashboard server speaks as the user. In a manager's DIR the host is `manager`
and the coordinators being served are participants too, by their fleet's name. Every message prints as exactly one line,
flushed at once. The server imports this module,
so append, read, open_for and the mention rules are shared by both callers.
"""
import argparse
import fcntl
import json
import os
import re as regex
import signal
import sys
import time
from datetime import datetime
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))
import clock  # noqa: E402
import fleets  # noqa: E402

POLL_S = 0.3
FLEETS_S = float(os.environ.get("FLEET_CHECK_S", 30))  # how often a manager's watch looks at the other fleets' chats
READING_GRACE_S = 10 * 60  # a host whose watch ended, or who spoke, this recently still counts as reading
QUOTE_MAX = 2000  # characters of a selected excerpt a message carries
UNHEARD_S = float(os.environ.get("FLEET_UNHEARD_S", 120))  # how long the user's message waits unread before the manager is told
NUDGE_S = float(os.environ.get("FLEET_NUDGE_S", 10 * 60))  # how long a worker leaves a message unanswered before its coordinator forwards it


class ChatError(Exception):
    """A refused append or an unknown participant; the CLI exits 1 with it, the server answers 400."""


def now() -> str:
    return clock.stamp()


def fail(msg: str) -> None:
    sys.stderr.write(f"chat: {msg}\n")
    sys.exit(1)


def _log_path(root) -> Path:
    return Path(root) / "chat.jsonl"


def _parse(data: bytes) -> list[dict]:
    """The messages in complete lines of the store. A line that does not parse as a message is skipped,
    and bytes that are not UTF-8 are read with replacement, so one torn line never stops a reader."""
    messages = []
    for line in data.split(b"\n"):
        if not line.strip():
            continue
        try:
            m = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            continue
        if (isinstance(m, dict) and isinstance(m.get("id"), int) and isinstance(m.get("from"), str)
                and isinstance(m.get("to"), list) and isinstance(m.get("text"), str)):
            m.setdefault("re", None)
            m.setdefault("parts", [{"text": m["text"]}])
            messages.append(m)
    return messages


class Tail:
    """Reads the store incrementally: each read() returns the messages appended since the last one.

    It keeps a byte offset and consumes a line only once its newline is there (a line without one is an
    append still being written), so a caller polling it reads only what is new."""

    def __init__(self, root, after: int = 0):
        self.path, self.after, self.offset = _log_path(root), after, 0

    def read(self) -> list[dict]:
        try:
            size = os.stat(self.path).st_size
        except FileNotFoundError:
            return []
        if size < self.offset:  # the store was replaced
            self.offset = 0
        if size == self.offset:
            return []
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            chunk = f.read(size - self.offset)
        complete = chunk[:chunk.rfind(b"\n") + 1]
        self.offset += len(complete)
        messages = []
        for m in _parse(complete):
            if m["id"] > self.after:
                messages.append(m)
                self.after = m["id"]
        return messages


def read(root, after: int = 0) -> list[dict]:
    """Every message with id > after, oldest first."""
    return Tail(root, after).read()


def _state(root) -> dict:
    try:
        state = json.loads((Path(root) / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def host(root) -> str:
    """Who runs the chat of DIR and gets what is addressed to nobody: `manager` in a manager's, else `coordinator`."""
    return fleets.role_of(_state(root))


def _agents(root) -> list[dict]:
    """Who can be written to beside the host: the agents[] rows of DIR/state.json, whatever their
    status, and in a manager's DIR the coordinators being served, each under its fleet's name."""
    state = _state(root)
    rows = state.get("agents", [])
    roster = [a for a in rows if isinstance(a, dict) and isinstance(a.get("id"), str)] if isinstance(rows, list) else []
    if fleets.role_of(state) == "manager":
        roster += [{"id": c["id"], "name": c["id"]} for c in fleets.view(state, root)["coordinators"]]
    return [{"id": "", "host": fleets.role_of(state)}] + roster


def _resolve(roster: list[dict], who: str) -> str | None:
    """The roster id `who` names, any case: the host, then agent ids, then agent names, each in
    state.json order, so an id always wins over another agent's name. None when nobody has it."""
    key = who.lower()
    if key == _host_of(roster):
        return key
    for field in ("id", "name"):
        for a in _members(roster):
            if str(a.get(field, a["id"])).lower() == key:
                return a["id"]
    return None


def _host_of(roster: list[dict]) -> str:
    return next((a["host"] for a in roster if "host" in a), "coordinator")


def _members(roster: list[dict]) -> list[dict]:
    return [a for a in roster if "host" not in a]


_MENTION = regex.compile(r"@([A-Za-z0-9_.-]+)")


def _parts(roster: list[dict], text: str) -> list[dict]:
    """`text` split into plain parts and resolved mention parts ({"text", "mention": id}), which join back
    into `text` exactly. A token that names nobody is tried again without its trailing dots and dashes,
    so "@a1." ends a sentence (the "." goes to the next plain part) while "@x-" still matches in full.
    An unresolved token stays inside a plain part."""
    parts, plain, at = [], "", 0
    for match in _MENTION.finditer(text):
        token = match.group(1)
        who = _resolve(roster, token)
        if who is None:
            token = token.rstrip(".-")
            who = _resolve(roster, token) if token else None
        if who is None:
            continue
        plain += text[at:match.start()]
        if plain:
            parts.append({"text": plain})
        parts.append({"text": "@" + token, "mention": who})
        plain, at = "", match.start() + 1 + len(token)
    plain += text[at:]
    return parts + ([{"text": plain}] if plain else [])


def _participant(roster: list[dict], who: str, allow_user: bool) -> str:
    """The id of `who`: a roster member named by id or name, or "user" when the caller allows it.
    Raises ChatError for anyone else."""
    if who == "user":
        if allow_user:
            return who
        raise ChatError(f"only the dashboard server speaks as the user; use --as {_host_of(roster)} or your own id")
    found = _resolve(roster, who)
    if found is None:
        ids = [a["id"] for a in _members(roster)]
        known = f"the last ids it has are {', '.join(ids[-5:])}" if ids else "it has no worker yet"
        raise ChatError(f"unknown participant '{who}': no worker row by that id or name in this DIR's state.json "
                        f"({known}). Check DIR is your fleet's dashboard directory (your brief names it), and that "
                        f"the coordinator recorded you (`fleet state DIR agent {who} ...`) before you started; else use --as {_host_of(roster)}")
    return found


def address(root, sender: str, text: str, re: int | None = None, allow_user: bool = False) -> dict:
    """Who a message from `sender` would reach right now, and its text split into parts:
    {"from": id, "to": [...], "parts": [...]}. The one implementation of the rule; append stores it.

    Recipients are the resolved mentions and, when `re` is set, the sender of the message it answers: a
    user message goes to them, or to the host when there are none; a fleet message goes to the
    user plus them. A sender is never its own recipient. Only the server passes allow_user=True. Raises
    ChatError for an unknown sender or `re`; empty text is answered (no parts), not refused."""
    roster = _agents(root)
    sender = _participant(roster, sender, allow_user)
    parts = _parts(roster, text)
    named = [p["mention"] for p in parts if "mention" in p]
    if re is not None:
        answered = next((m for m in read(root) if m["id"] == re), None)
        if answered is None:
            raise ChatError(f"unknown message #{re}")
        named.append(answered["from"])
    to = [] if sender == "user" else ["user"]
    for who in named:
        if who != sender and who not in to:
            to.append(who)
    return {"from": sender, "to": to or [_host_of(roster)], "parts": parts}


def append(root, sender: str, text: str, re: int | None = None, author: str | None = None,
           allow_user: bool = False, decision: str | None = None, quote: dict | None = None,
           side: int | str | None = None) -> dict:
    """Append a message from `sender` ("coordinator", or an agent id or name) and return it as stored,
    with the recipients and parts `address` resolves. Only the server passes allow_user=True, which lets
    `sender` be "user" and stores `author` on it. `decision` tags the message with the decision it is
    about (the user's answer to one, given on its page). `quote` is the excerpt the message is about,
    {"text", "from"}, the text the user selected on the page and where. `side` puts it in a side chat:
    "new" opens one (its id is the message's own), a number continues that one, and a reply to a
    message in a side chat stays in it. Raises ChatError as `address` does, for empty text or text that
    is not UTF-8, and for a quote or side that is not one."""
    resolved = address(root, sender, text, re, allow_user)  # the store only grows, so `re` stays valid
    if not text.strip():
        raise ChatError("the message has no text")
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        raise ChatError("the text is not valid UTF-8") from None
    if quote is not None:
        if not isinstance(quote, dict) or not isinstance(quote.get("text"), str) or not quote["text"].strip():
            raise ChatError("a quote is the selected text, with where it was")
        quote = {"text": quote["text"].strip()[:QUOTE_MAX], "from": str(quote.get("from") or "")[:200]}
    with open(_log_path(root), "a+b") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        data = f.read()
        known = _parse(data)
        next_id = max((m["id"] for m in known), default=0) + 1
        parent = next((m for m in known if m["id"] == re), None) if re is not None else None
        if side == "new":
            side = next_id
        elif side is not None:
            if not isinstance(side, int) or isinstance(side, bool) or not any(m.get("side") == side for m in known):
                raise ChatError(f"no side chat #{side}")
        elif parent and parent.get("side"):
            side = parent["side"]
        message = {"id": next_id, "at": now(),
                   "from": resolved["from"], "to": resolved["to"], "text": text, "re": re,
                   "parts": resolved["parts"]}
        if author and message["from"] == "user":
            message["author"] = author
        if decision:
            message["decision"] = decision
        if quote:
            message["quote"] = quote
        if side:
            message["side"] = side
        torn = data and not data.endswith(b"\n")
        f.write((b"\n" if torn else b"") + (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        f.flush()
    return message


def _open_among(messages: list[dict], who: str) -> list[dict]:
    """The messages addressed to `who` that `who` has not answered (a message of theirs with `re` = its id)."""
    answered = {(m["re"], m["from"]) for m in messages}
    return [m for m in messages if who in m["to"] and (m["id"], who) not in answered]


def open_for(root, who: str, after: int = 0) -> list[dict]:
    """The messages with id > after addressed to `who` that `who` has not answered yet, oldest first."""
    who = _participant(_agents(root), who, allow_user=True)
    return [m for m in _open_among(read(root), who) if m["id"] > after]


_LINE_BREAK = regex.compile("\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]")
_CONTROL = regex.compile("[\x00-\x1f\x80-\x9f]")


def _one_line(value) -> str:
    """`value` as text that can never print as more than one line: breaks become ⏎, a tab a space, controls are dropped."""
    return _CONTROL.sub("", _LINE_BREAK.sub(" \u23ce ", str(value)).replace("\t", " "))


def handed_over(m: dict) -> set:
    """The coordinators the hub delivered this message to, into their own chats (`delivered`, on a message the
    user wrote on the manager's page): each answers it there, so the manager does not forward it."""
    rows = m.get("delivered")
    return {r["fleet"] for r in rows if isinstance(r, dict) and isinstance(r.get("fleet"), str)} if isinstance(rows, list) else set()


def _waits_here(m: dict) -> bool:
    """Whether a recipient of `m` has it only in this chat: one the hub did not deliver it to."""
    handed = handed_over(m)
    return any(r not in handed for r in m["to"])


def _from_manager(m: dict) -> bool:
    """A message the hub delivered from the manager's page (`via` the manager)."""
    return isinstance(m.get("via"), dict) and m["via"].get("fleet") == "manager"


def _marks(m: dict) -> str:
    """` [delivered to infra #7]` on a message the hub delivered, ` [via manager #12]` on its copy and on an
    answer mirrored back."""
    out = ""
    rows = [r for r in m.get("delivered") or [] if isinstance(r, dict) and r.get("fleet") is not None] \
        if isinstance(m.get("delivered"), list) else []
    if rows:
        out += " [delivered to " + ", ".join(f"{_one_line(r['fleet'])} #{_one_line(r.get('id'))}" for r in rows) + "]"
    if isinstance(m.get("via"), dict) and m["via"].get("fleet") is not None:
        out += f" [via {_one_line(m['via']['fleet'])} #{_one_line(m['via'].get('id'))}]"
    return out


def _render(root, messages: list[dict]) -> list[str]:
    """Each message as its one printed line: `#12 user (login) -> a1 (notes-impl) [d1]: text [re #9]`,
    the `[d1]` on a message about that decision."""
    names = {a["id"]: a.get("name", a["id"]) for a in _members(_agents(root))}
    refs = {d.get("id"): d.get("ref") for d in _state(root).get("decisions", []) if isinstance(d, dict) and d.get("ref")}

    def label(id_: str, extra=None) -> str:
        extra = extra or names.get(id_, id_)
        return _one_line(id_ if extra == id_ else f"{id_} ({extra})")

    return [
        f"#{m['id']} {label(m['from'], m.get('author') if m['from'] == 'user' else None)}"
        f" -> {', '.join(map(label, m['to']))}"
        + (f" [{_one_line((refs.get(m['decision']) + ' ') if refs.get(m['decision']) else '')}{_one_line(m['decision'])}]" if m.get("decision") else "")
        + (f" [side chat #{m['side']}]" if m.get("side") else "")
        + _marks(m)
        + (f" (quoting{' ' + _one_line(m['quote']['from']) if m['quote'].get('from') else ''}: \"{_one_line(m['quote']['text'])}\")" if isinstance(m.get("quote"), dict) and isinstance(m["quote"].get("text"), str) else "")
        + f": {_one_line(m['text'])}"
        + (f" [re #{_one_line(m['re'])}]" if m["re"] is not None else "")
        for m in messages
    ]


def _show(root, messages: list[dict]) -> None:
    for line in _render(root, messages):
        print(line, flush=True)


def cmd_say(root, args) -> None:
    _show(root, [append(root, args.who, args.text, args.re, decision=args.decision)])


def cmd_inbox(root, args) -> None:
    _show(root, open_for(root, args.who))


def _cursor(root, who: str) -> Path:
    """Where a watch as `who` keeps the id of the last message it printed."""
    return Path(root) / f"watch-{who}.cursor"


def _left(root, who: str) -> Path:
    """Touched when a watch as `who` ends: a host woken by its watch is still reading until it arms the next."""
    return Path(root) / f"watch-{who}.left"


def _pulse(root, who: str) -> Path:
    """Where a running watch as `who` keeps its process id, so the page and the manager can tell it listens."""
    return Path(root) / f"watch-{who}.pid"


def listening(root) -> dict:
    """Whether the host of DIR reads its chat now, and how far it has read: {"on", "seen", "unread",
    "since"}. `on` is a live watch; `seen` the last message a watch printed; `unread` the messages from
    the user after it, `since` when the oldest of them was sent."""
    who = host(root)
    try:
        pid = int(_pulse(root, who).read_text())
        os.kill(pid, 0)
        on = True
    except (OSError, ValueError):
        on = False
    if not on:  # between a `--once` watch that woke it and the next, a host is still reading: allow for the gap
        try:
            on = clock.time() - _left(root, who).stat().st_mtime < READING_GRACE_S
        except OSError:
            pass
        if not on:
            last = next((m for m in reversed(read(root)) if m["from"] == who), None)
            try:
                on = bool(last) and clock.time() - datetime.fromisoformat(last["at"]).timestamp() < READING_GRACE_S
            except ValueError:
                pass
    try:
        seen = int(_cursor(root, who).read_text())
    except (OSError, ValueError):
        seen = 0
    messages = read(root)
    answered = {m["re"] for m in messages if m["from"] != "user" and m["re"] is not None}
    state = _state(root)
    closed = {d.get("id") for d in state.get("decisions", []) if isinstance(d, dict) and d.get("status") != "open"}
    # Unread is what still waits: a message someone answered, or an answer to a decision since closed, does not.
    # So does one the hub delivered to every coordinator it names: each reads it in its own chat.
    unread = [m for m in messages if m["id"] > seen and m["from"] == "user" and m["id"] not in answered
              and not (m.get("decision") and m["decision"] in closed) and _waits_here(m)]
    return {"on": on, "seen": seen, "unread": len(unread), "since": unread[0]["at"] if unread else None}


def deaf_warning(root) -> str | None:
    """What the host must be told when the user writes to a chat nobody reads, or None."""
    heard = listening(root)
    if heard["on"] or not heard["unread"]:
        return None
    who = host(root)
    return (f"chat: the user wrote {heard['unread']} message(s) since #{heard['seen']} that no watch has read. "
            f"Arm `fleet chat {root} watch --as {who} --all --resume --once` as a background command; it prints them first.")


def _unrecorded(e: dict, told: dict) -> list[str]:
    """The `!` lines for answers the user gave in fleet `e` that its coordinator has had for UNHEARD_S and
    not recorded, each told once."""
    import copy
    import decisions
    state = copy.deepcopy(_state(e["dir"]))
    decisions.number(state)
    said, lines = read(e["dir"]), []
    for d in state.get("decisions", []):
        if not isinstance(d, dict) or d.get("status") != "open":
            continue
        at = fleets._answered_at(d, said)
        mark = f"answer:{d.get('id')}:{at}"
        if not at or told.get(mark):
            continue
        try:
            waited = clock.time() - datetime.fromisoformat(at).timestamp()
        except ValueError:
            continue
        if waited < UNHEARD_S:
            continue
        told[mark] = True
        m = next(m for m in reversed(said) if m.get("decision") == d.get("id") and m["at"] == at)
        lines.append(f"! {e['id']} has not recorded the user's answer to {d.get('ref') or d.get('id')} ({_one_line(d.get('title'))}), "
                     f"given at {at[11:16]} as #{m['id']}: \"{_one_line(m['text'])[:120]}\". SendMessage its session "
                     f"({e.get('session') or e['id']}) to record it: `fleet state <dir> decision {d.get('ref') or d.get('id')} --decide ...`.")
    return lines


def _silent(root, fleet: str | None, told: dict) -> list[str]:
    """The `!` lines for the running workers of DIR silent for fleets.SILENT_S, each silence told once."""
    lines = []
    for w in fleets.silent_workers(root, _state(root)):
        mark = f"silent:{fleet or ''}:{w['id']}:{w['active']}"
        if told.get(mark):
            continue
        told[mark] = True
        where = f"{fleet}'s worker" if fleet else "worker"
        lines.append(f"! {where} {w['id']} ({_one_line(w['name'])}) has written nothing since {w['active'][11:16]} though the ledger says it runs. "
                     + (f"SendMessage {fleet} to check it." if fleet else f"Ask it where it stands (SendMessage {w['id']}), or park it with the reason."))
    return lines


def _nudges(root, told: dict) -> list[str]:
    """The `!` lines for messages to the workers of DIR that the addressee has not answered (no `--re` from
    it) for NUDGE_S: workers read their inbox at checkpoints, and only a message left this long is
    forwarded by SendMessage (L1). Each told once."""
    messages, lines = read(root), []
    for w in _members(_agents(root)):
        for m in _open_among(messages, w["id"]):
            mark = f"nudge:{m['id']}:{w['id']}"
            if m["from"] == w["id"] or told.get(mark):
                continue
            try:
                waited = clock.time() - datetime.fromisoformat(str(m.get("at"))).timestamp()
            except ValueError:
                continue
            if waited < NUDGE_S:
                continue
            told[mark] = True
            name = w.get("name", w["id"])
            who = w["id"] if name == w["id"] else f"{w['id']} ({_one_line(name)})"
            lines.append(f"! worker {who} has not answered #{m['id']} from {_one_line(m['from'])} for {int(waited // 60)} min: "
                         f"\"{_one_line(m['text'])[:120]}\". Forward it (SendMessage {w['id']}).")
    return lines


def _own_silent(root) -> list[str]:
    """For a coordinator's watch: its own silent workers, and the messages its workers left unanswered for
    NUDGE_S, each told once across watches (kept in DIR)."""
    told_path = Path(root) / "watch-coordinator.told"
    try:
        told = json.loads(told_path.read_text())
    except (OSError, ValueError):
        told = {}
    lines = _silent(root, None, told) + _nudges(root, told)
    if lines:
        told_path.write_text(json.dumps(told))
    return lines


def _fleets_unheard(me: str) -> list[str]:
    """For a manager's watch: one line per fleet whose coordinator does not read its chat while the user's
    messages wait there more than UNHEARD_S. Each set of waiting messages is told once, across watches:
    what was told is kept in the manager's DIR."""
    told_path = Path(me) / "watch-manager.told"
    try:
        told = json.loads(told_path.read_text())
    except (OSError, ValueError):
        told = {}
    lines = []
    for e in fleets.live():
        if e["role"] == "manager" or e["dir"] == me:
            continue
        lines += _unrecorded(e, told)
        lines += _silent(e["dir"], e["id"], told)
        heard = listening(e["dir"])
        mark = f"{heard['seen']}:{heard['unread']}:{heard['since']}"
        if heard["on"] or not heard["unread"] or told.get(e["id"]) == mark:
            continue
        try:
            waited = clock.time() - datetime.fromisoformat(heard["since"]).timestamp()
        except (TypeError, ValueError):
            waited = UNHEARD_S
        if waited < UNHEARD_S:
            continue
        told[e["id"]] = mark
        import spend
        active = spend.active(e["dir"])
        gone = ""
        try:
            if active and clock.time() - datetime.fromisoformat(active).timestamp() > 1800:
                gone = f" Its session last wrote at {active[:16].replace('T', ' ')}; it may be gone."
        except ValueError:
            pass
        lines.append(f"! {e['id']} does not read its chat: {heard['unread']} message(s) from the user since "
                     f"#{heard['seen']}, the oldest at {heard['since'][11:16]}. SendMessage its session "
                     f"({e.get('session') or e['id']}) to arm its watch; `fleet chat {e['dir']} log --after {heard['seen']}` shows them." + gone)
    if lines:
        told_path.write_text(json.dumps(told))
    return lines


_BREAKS = "\n\r\v\f\x1c\x1d\x1e\x85  "
FIRST_LINE_MAX = 200  # characters of a message's first line a fleet's news line carries


def first_line(value) -> str:
    """The first line of `value` that has text, as one printed line of at most FIRST_LINE_MAX characters,
    with ` …` when there is more."""
    text = str(value).lstrip(" \t" + _BREAKS)
    cut = next((i for i, c in enumerate(text) if c in _BREAKS), len(text))
    line, more = _one_line(text[:cut]).strip(" "), any(c not in _BREAKS and c not in " \t" for c in text[cut:])
    if len(line) > FIRST_LINE_MAX:
        line, more = line[:FIRST_LINE_MAX].rstrip(" "), True
    return line + (" …" if more else "")


def _mark(d: dict) -> str:
    """Where a decision stands, as the manager's watch compares it: `open:<who looks first>`, `held`, or its status."""
    if d.get("status") == "open":
        return "held" if d.get("held") else "open:" + str(d.get("asks") or "user")
    return str(d.get("status"))


def _news_of(fleet: str, d: dict, mark: str) -> str | None:
    """The line for a decision of `fleet` that now stands at `mark`, or None when that is not news for the manager."""
    head = f"{fleet} {d.get('ref') or d['id']}"
    title = _one_line(d.get("title"))
    if mark == "open:user":
        return f"{head} opened for you: {title}" + (" (blocks work)" if d.get("blocking") is True else "")
    if mark == "held":
        said = first_line(d["held"]) if isinstance(d.get("held"), str) else ""
    elif mark == "decided":
        said = first_line(d.get("answer") or d.get("resolution") or "")
    elif mark == "withdrawn":
        said = first_line(d.get("resolution") or "")
    else:
        return None
    return f"{head} {mark}: {title}" + (f": {said}" if said else "")


class FleetNews:
    """What the user did on the other fleets' pages, for a manager's watch: each message from the user (an
    answer to a decision or not), each decision opened for the user, and each one decided, withdrawn or held.

    Cursors are per fleet, kept by its directory (a fleet keeps it through a rename) in
    DIR/watch-manager.fleets.json: the last message id read and where each decision stood. A fleet seen for the
    first time is read from then on; with `resume` the cursors of the last watch are taken up, so nothing is
    missed or told twice."""

    def __init__(self, me, resume: bool):
        self.me, self.path = str(me), Path(me) / "watch-manager.fleets.json"
        self.seen: dict[str, dict] = {}
        if resume:
            try:
                rows = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                rows = []
            for r in rows if isinstance(rows, list) else []:
                if isinstance(r, dict) and isinstance(r.get("dir"), str) and isinstance(r.get("chat"), int) \
                        and isinstance(r.get("decisions"), dict):
                    self.seen[r["dir"]] = r
        self.tails: dict[str, Tail] = {}
        self.states: dict[str, tuple] = {}
        self.saved = None

    def _decisions(self, root: str) -> list[dict]:
        """The decisions of `root`'s ledger with their numbers, read again only when the file changed."""
        import copy
        import decisions
        try:
            st = os.stat(Path(root) / "state.json")
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            key = None
        held = self.states.get(root)
        if held and held[0] == key:
            return held[1]
        state = copy.deepcopy(_state(root))
        decisions.number(state)
        rows = [d for d in state.get("decisions", []) if isinstance(d, dict) and isinstance(d.get("id"), str)]
        self.states[root] = (key, rows)
        return rows

    def read(self) -> list[str]:
        """The news since the last read, one line each, fleet by fleet (messages, then decisions)."""
        lines = []
        for e in fleets.live():
            root = e["dir"]
            if e["role"] == "manager" or root == self.me:
                continue
            rows = self._decisions(root)
            before = self.seen.get(root)
            if root not in self.tails:
                self.tails[root] = Tail(root, before["chat"] if before else 0)
            said = self.tails[root].read()
            last = max([before["chat"] if before else 0] + [m["id"] for m in said])
            marks = {d["id"]: _mark(d) for d in rows}
            self.seen[root] = {"fleet": e["id"], "dir": root, "chat": last, "decisions": marks}
            if before is None:
                continue  # first seen: from now on
            for m in said:
                if m["from"] != "user" or _from_manager(m):
                    continue  # a message the hub delivered from the manager's page is the manager's own news
                if m.get("decision"):
                    d = next((d for d in rows if d["id"] == m["decision"]), None) or \
                        next((d for d in rows if d.get("ref") and d["ref"] == m["decision"]), None)
                    what = f"{d.get('ref') or d['id']} {_one_line(d.get('title'))}" if d else _one_line(m["decision"])
                    lines.append(f"{e['id']}: you answered {what}: {first_line(m['text'])}")
                else:
                    lines.append(f"{e['id']}: you wrote to {_one_line(', '.join(map(str, m['to'])))}: {first_line(m['text'])}")
            for d in rows:
                if before["decisions"].get(d["id"]) != marks[d["id"]]:
                    line = _news_of(e["id"], d, marks[d["id"]])
                    if line:
                        lines.append(line)
        return lines

    def save(self) -> None:
        text = json.dumps(list(self.seen.values()), ensure_ascii=False)
        if text != self.saved:
            self.path.write_text(text + "\n", encoding="utf-8")
            self.saved = text


def cmd_watch(root, args) -> None:
    who = _participant(_agents(root), args.who, allow_user=False)
    if args.fleets and who != "manager":
        raise ChatError("--fleets is the manager's: only a watch `--as manager` follows the other fleets' pages")
    cursor = _cursor(root, who)
    pulse = _pulse(root, who)
    pulse.write_text(str(os.getpid()))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        _watch(root, args, who, cursor)
    finally:
        try:
            if pulse.read_text() == str(os.getpid()):
                pulse.unlink()
        except OSError:
            pass
        try:
            _left(root, who).touch()
            os.utime(_left(root, who), (clock.time(), clock.time()))  # its age is read against the same clock
        except OSError:
            pass


def _watch(root, args, who: str, cursor: Path) -> None:
    after = args.after
    if args.resume:
        try:
            after = max(after, int(cursor.read_text()))
        except (OSError, ValueError):
            pass

    def show(messages: list[dict]) -> None:
        _show(root, messages)
        if messages:
            cursor.write_text(str(messages[-1]["id"]))

    tail = Tail(root)
    messages = tail.read()
    wanted = {m["id"] for m in _open_among(messages, who)}
    if args.all:
        wanted |= {m["id"] for r in (host(root), *{a["id"] for a in _members(_agents(root))})
                   for m in _open_among(messages, r) if m["from"] == "user" and r not in handed_over(m)}
    first = [m for m in messages if m["id"] > after and m["id"] in wanted]
    show(first)
    news = FleetNews(root, args.resume) if args.fleets else None

    def tell() -> list[str]:
        told = news.read() if news else []
        for line in told:
            print(line, flush=True)
        if news:
            news.save()
        return told

    # The other fleets' news comes in batches: the first opens a window of --batch seconds, and the watch
    # tells all that lands in it before it exits, so one wake covers a burst of the user's actions.
    window = time.monotonic() + args.batch if tell() else None
    if args.once and first:
        return
    checked = 0.0
    while True:
        if args.once and window is not None and time.monotonic() >= window:
            return
        time.sleep(POLL_S)
        new = [m for m in tail.read() if who in m["to"] or (args.all and m["from"] == "user" and _waits_here(m))]
        show(new)
        if tell() and window is None:
            window = time.monotonic() + args.batch
        lines = []
        if who in ("manager", "coordinator") and time.monotonic() - checked >= FLEETS_S:
            checked = time.monotonic()
            lines = _fleets_unheard(str(root)) if who == "manager" else _own_silent(root)
            for line in lines:
                print(line, flush=True)
        if args.once and (new or lines):
            return


def cmd_wait(root, args) -> None:
    """Wait for the user's answer to any of these decisions (ids or numbers), print it and exit: the
    subscription a coordinator arms when it asks, so it knows at once, whatever its chat watch is doing.
    An answer given already and not recorded prints at once; one closed meanwhile ends the wait too."""
    import decisions
    state = _state(root)
    decisions.number(state)
    wanted = {}
    for key in args.decision:
        d = decisions.find(state, key)
        if d is None:
            fail(f"no decision '{key}' in {root}")
        if d.get("status") != "open":
            print(f"{d.get('ref') or d['id']} is already {d['status']}: {d.get('answer') or d.get('resolution')}", flush=True)
            return
        wanted[d["id"]] = d
    tail = Tail(root)
    first = True
    while True:
        messages = tail.read() if not first else read(root)
        for m in messages:
            d = wanted.get(m.get("decision"))
            if d and m["from"] == "user" and (not first or clock.at_or_after(m["at"], d.get("revised") or d.get("opened") or "")
                                               and not (d.get("held") and clock.at_or_after(d.get("held_at") or "", m["at"]))):
                if first and any(r.get("re") == m["id"] and r["from"] != "user" for r in messages):
                    continue  # answered already, and replied to: not news
                _show(root, [m])
                print(f"-> the user answered {d.get('ref') or d['id']}: record it first, `fleet state {root} decision {d.get('ref') or d['id']} --decide ...`", flush=True)
                return
        if first:
            tail = Tail(root, max((m["id"] for m in messages), default=0))
            first = False
        if _closed_meanwhile(root, wanted):
            return
        time.sleep(POLL_S)


def _closed_meanwhile(root, wanted: dict) -> bool:
    """A decision waited on that was closed while `wait` waited (withdrawn, or decided without an answer on
    the page): said as `wait` says it of one closed before, so the wait ends instead of hanging."""
    import decisions
    state = _state(root)
    for did in wanted:
        d = decisions.find(state, did) if state.get("decisions") else None
        if d is not None and d.get("status") != "open":
            decisions.number(state)
            print(f"{d.get('ref') or did} is already {d['status']}: {d.get('answer') or d.get('resolution')}", flush=True)
            return True
    return False


def cmd_log(root, args) -> None:
    _show(root, read(root, args.after))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fleet chat", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dir", help="the dashboard directory, holding state.json and chat.jsonl")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("say"); s.add_argument("--as", dest="who", required=True); s.add_argument("--re", type=int)
    s.add_argument("--decision", metavar="D", help="the decision this message is about"); s.add_argument("text")
    s = sub.add_parser("inbox"); s.add_argument("--as", dest="who", required=True)
    s = sub.add_parser("wait"); s.add_argument("decision", nargs="+", help="decision ids or numbers (A6) to wait on")
    s = sub.add_parser("watch"); s.add_argument("--as", dest="who", required=True)
    s.add_argument("--after", type=int, default=0); s.add_argument("--all", action="store_true")
    s.add_argument("--resume", action="store_true", help="start after the last message a watch as WHO printed")
    s.add_argument("--once", action="store_true", help="exit after the first batch it prints: a background task that wakes its session only when there is news")
    s.add_argument("--fleets", action="store_true", help="a manager's: also what the user does on every other fleet's page")
    s.add_argument("--batch", type=int, default=120, metavar="SECONDS",
                   help="with --fleets --once: how long the first news of the other fleets waits for more before the watch exits")
    s = sub.add_parser("log"); s.add_argument("--after", type=int, default=0)
    return p


def main(argv: list[str]) -> None:
    args = build_parser().parse_args(argv)
    root = Path(args.dir).resolve()
    try:
        globals()[f"cmd_{args.cmd}"](root, args)
    except ChatError as exc:
        fail(str(exc))
    except (KeyboardInterrupt, BrokenPipeError):
        sys.exit(0)


if __name__ == "__main__":
    main(sys.argv[1:])
