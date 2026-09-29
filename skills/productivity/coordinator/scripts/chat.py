#!/usr/bin/env python3
"""The chat between the user (on the dashboard) and the fleet, stored in DIR/chat.jsonl.

    chat.py DIR say   --as WHO [--re N] [--decision D] TEXT
                                                 append a message from WHO; print the line written
    chat.py DIR inbox --as WHO                   the messages open for WHO, oldest first
    chat.py DIR watch --as WHO [--after N | --resume] [--all]
                                                 every message open for WHO with id > N, then each
                                                 new one as it lands; never exits on its own. --all
                                                 also streams every message from the user. --resume
                                                 takes N from the last line a watch as WHO printed.
    chat.py DIR log   [--after N]                the whole conversation, oldest first

WHO is `coordinator` or an agent id or name from DIR/state.json; only the
dashboard server speaks as the user. Every message prints as exactly one line,
flushed at once. The server imports this module,
so append, read, open_for and the mention rules are shared by both callers.
"""
import argparse
import fcntl
import json
import os
import re as regex
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


POLL_S = 0.3


class ChatError(Exception):
    """A refused append or an unknown participant; the CLI exits 1 with it, the server answers 400."""


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


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


def _agents(root) -> list[dict]:
    """The agents[] rows of DIR/state.json, whatever their status; none when there is no state yet."""
    try:
        rows = json.loads((Path(root) / "state.json").read_text(encoding="utf-8")).get("agents", [])
    except (OSError, ValueError, AttributeError):
        return []
    return [a for a in rows if isinstance(a, dict) and isinstance(a.get("id"), str)]


def _resolve(roster: list[dict], who: str) -> str | None:
    """The roster id `who` names, any case: `coordinator`, then agent ids, then agent names, each in
    state.json order, so an id always wins over another agent's name. None when nobody has it."""
    key = who.lower()
    if key == "coordinator":
        return "coordinator"
    for field in ("id", "name"):
        for a in roster:
            if str(a.get(field, a["id"])).lower() == key:
                return a["id"]
    return None


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
        raise ChatError("only the dashboard server speaks as the user; use --as coordinator or your agent id")
    found = _resolve(roster, who)
    if found is None:
        raise ChatError(f"unknown participant '{who}'; use coordinator or an agent id or name from state.json")
    return found


def address(root, sender: str, text: str, re: int | None = None, allow_user: bool = False) -> dict:
    """Who a message from `sender` would reach right now, and its text split into parts:
    {"from": id, "to": [...], "parts": [...]}. The one implementation of the rule; append stores it.

    Recipients are the resolved mentions and, when `re` is set, the sender of the message it answers: a
    user message goes to them, or to the coordinator when there are none; a fleet message goes to the
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
    return {"from": sender, "to": to or ["coordinator"], "parts": parts}


def append(root, sender: str, text: str, re: int | None = None, author: str | None = None,
           allow_user: bool = False, decision: str | None = None) -> dict:
    """Append a message from `sender` ("coordinator", or an agent id or name) and return it as stored,
    with the recipients and parts `address` resolves. Only the server passes allow_user=True, which lets
    `sender` be "user" and stores `author` on it. `decision` tags the message with the decision it is
    about (the user's answer to one, given on its page). Raises ChatError as `address` does, and for
    empty text or text that is not UTF-8."""
    resolved = address(root, sender, text, re, allow_user)  # the store only grows, so `re` stays valid
    if not text.strip():
        raise ChatError("the message has no text")
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        raise ChatError("the text is not valid UTF-8") from None
    with open(_log_path(root), "a+b") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        data = f.read()
        message = {"id": max((m["id"] for m in _parse(data)), default=0) + 1, "at": now(),
                   "from": resolved["from"], "to": resolved["to"], "text": text, "re": re,
                   "parts": resolved["parts"]}
        if author and message["from"] == "user":
            message["author"] = author
        if decision:
            message["decision"] = decision
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


def _render(root, messages: list[dict]) -> list[str]:
    """Each message as its one printed line: `#12 user (login) -> a1 (notes-impl) [d1]: text [re #9]`,
    the `[d1]` on a message about that decision."""
    names = {a["id"]: a.get("name", a["id"]) for a in _agents(root)}

    def label(id_: str, extra=None) -> str:
        extra = extra or names.get(id_, id_)
        return _one_line(id_ if extra == id_ else f"{id_} ({extra})")

    return [
        f"#{m['id']} {label(m['from'], m.get('author') if m['from'] == 'user' else None)}"
        f" -> {', '.join(map(label, m['to']))}"
        + (f" [{_one_line(m['decision'])}]" if m.get("decision") else "")
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


def cmd_watch(root, args) -> None:
    who = _participant(_agents(root), args.who, allow_user=False)
    cursor = _cursor(root, who)
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
        wanted |= {m["id"] for r in ("coordinator", *{a["id"] for a in _agents(root)})
                   for m in _open_among(messages, r) if m["from"] == "user"}
    show([m for m in messages if m["id"] > after and m["id"] in wanted])
    while True:
        time.sleep(POLL_S)
        show([m for m in tail.read() if who in m["to"] or (args.all and m["from"] == "user")])


def cmd_log(root, args) -> None:
    _show(root, read(root, args.after))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dir", help="the dashboard directory, holding state.json and chat.jsonl")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("say"); s.add_argument("--as", dest="who", required=True); s.add_argument("--re", type=int)
    s.add_argument("--decision", metavar="D", help="the decision this message is about"); s.add_argument("text")
    s = sub.add_parser("inbox"); s.add_argument("--as", dest="who", required=True)
    s = sub.add_parser("watch"); s.add_argument("--as", dest="who", required=True)
    s.add_argument("--after", type=int, default=0); s.add_argument("--all", action="store_true")
    s.add_argument("--resume", action="store_true", help="start after the last message a watch as WHO printed")
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
