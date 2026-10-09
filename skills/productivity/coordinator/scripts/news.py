#!/usr/bin/env python3
"""The machine's news: what a session tells the fleets that wakes nobody (release notes, FYIs, rules).

    news.py post --from NAME [--to all|FLEET[,FLEET...]] [--kind release|fyi|rule] [--keep] TEXT
                                    append an item to REGISTRY/news/news.jsonl; print its line
    news.py read --as FLEET         the items FLEET has not read, oldest first; moves FLEET's cursor
    news.py list                    every item, oldest first

A reader sees an item addressed to `all` or to it, never its own. Nothing here wakes a session: a
coordinator learns of unread news from one line its chat watch prints when it wakes for a real
message, from every `fleet state` command, and from the plugin's SessionStart and Stop hooks. An item
says whether to save it: `--keep` marks a durable rule, the default is "do not save".
"""
import argparse
import fcntl
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clock  # noqa: E402
import fleets  # noqa: E402

KINDS = ("release", "fyi", "rule")
TEXT_MAX = 1000  # characters of one item: news is short; a long part goes in a file named by path
NAME = re.compile(r"^[A-Za-z0-9_.-]+$")
_LINE_BREAK = re.compile(r"\r\n|[\n\r\v\f\x1c\x1d\x1e\x85  ]")
_CONTROL = re.compile("[\x00-\x1f\x80-\x9f]")


class NewsError(Exception):
    """A refused post or reader; the CLI exits 1 with it."""


def folder() -> Path:
    return fleets.home() / "news"


def log_path() -> Path:
    return folder() / "news.jsonl"


def cursor_path(fleet: str) -> Path:
    return folder() / "read" / fleet


def _one_line(value) -> str:
    return _CONTROL.sub("", _LINE_BREAK.sub(" ⏎ ", str(value)).replace("\t", " "))


def _item(row) -> dict | None:
    if not isinstance(row, dict):
        return None
    ok = (isinstance(row.get("id"), int) and not isinstance(row.get("id"), bool) and isinstance(row.get("from"), str)
          and isinstance(row.get("to"), list) and isinstance(row.get("text"), str))
    return row if ok else None


def _parse(data: bytes) -> list[dict]:
    items = []
    for raw in data.decode("utf-8", "replace").split("\n"):
        if not raw.strip():
            continue
        try:
            row = _item(json.loads(raw))
        except ValueError:
            continue
        if row is not None:
            items.append(row)
    return items


def read_all() -> list[dict]:
    try:
        return _parse(log_path().read_bytes())
    except OSError:
        return []


def _name(value: str, what: str) -> str:
    value = value.strip()
    if not NAME.match(value):
        raise NewsError(f"{what} is a fleet's or a session's name ([A-Za-z0-9_.-]), not {value!r}")
    return value


def post(sender: str, to: str, kind: str, keep: bool, text: str) -> dict:
    sender = _name(sender, "--from")
    names = [n.strip() for n in to.split(",")]
    if names == ["all"]:
        recipients = ["all"]
    elif "all" in names:
        raise NewsError("--to is `all` or a list of fleets, not both")
    else:
        recipients = list(dict.fromkeys(_name(n, "--to") for n in names))
    if not text.strip():
        raise NewsError("the item has no text")
    if len(text) > TEXT_MAX:
        raise NewsError(f"an item is at most {TEXT_MAX} characters, and this one is {len(text)}: say it short, "
                        "and put the long part in a file and give its path")
    folder().mkdir(parents=True, exist_ok=True)
    with open(log_path(), "a+b") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        data = f.read()
        item = {"id": max((i["id"] for i in _parse(data)), default=0) + 1, "at": clock.stamp(), "from": sender,
                "to": recipients, "kind": kind, "keep": keep, "text": text.strip()}
        torn = data and not data.endswith(b"\n")
        f.write((b"\n" if torn else b"") + (json.dumps(item, ensure_ascii=False) + "\n").encode("utf-8"))
        f.flush()
    return item


def line(item: dict) -> str:
    """One item as one printed line: `#3 2026-01-05 09:00 skills -> all [rule, keep]: text`."""
    at = str(item.get("at") or "")[:16].replace("T", " ")
    to = ", ".join(_one_line(t) for t in item["to"])
    save = "keep" if item.get("keep") is True else "do not save"
    return f"#{item['id']} {at} {_one_line(item['from'])} -> {to} [{_one_line(item.get('kind') or 'fyi')}, {save}]: {_one_line(item['text'])}"


def _cursor(fleet: str) -> int:
    try:
        return int(cursor_path(fleet).read_text().strip())
    except (OSError, ValueError):
        return 0


def for_reader(items: list[dict], fleet: str) -> list[dict]:
    """The items `fleet` reads: to all or to it, not its own."""
    return [i for i in items if ("all" in i["to"] or fleet in i["to"]) and i["from"] != fleet]


def unread(fleet: str) -> list[dict]:
    after = _cursor(fleet)
    return [i for i in for_reader(read_all(), fleet) if i["id"] > after]


def mark_read(fleet: str, items: list[dict]) -> None:
    last = max((i["id"] for i in items), default=0)
    if last > _cursor(fleet):
        cursor_path(fleet).parent.mkdir(parents=True, exist_ok=True)
        cursor_path(fleet).write_text(str(last))


def fleet_of(root) -> str | None:
    """The name the registry gives the fleet at `root`, read without touching the registry (no entry is
    pruned or renamed here): the first entry, by file name, whose dir is root."""
    real = os.path.realpath(root)
    try:
        paths = sorted(p for p in fleets.home().glob("*.json") if p.is_file())
    except OSError:
        return None
    for p in paths:
        try:
            entry = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(entry, dict) and isinstance(entry.get("dir"), str) and isinstance(entry.get("id"), str) \
                and os.path.realpath(entry["dir"]) == real:
            return entry["id"]
    return None


def manager_of() -> str | None:
    """The name of the manager the registry serves, read without touching the registry: the first entry, by file
    name, whose role is manager and whose process runs. None when there is none."""
    try:
        paths = sorted(p for p in fleets.home().glob("*.json") if p.is_file())
    except OSError:
        return None
    for p in paths:
        try:
            entry = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(entry, dict) and entry.get("role") == "manager" and isinstance(entry.get("id"), str) \
                and fleets._alive(entry.get("pid")):
            return entry["id"]
    return None


def unread_line(root) -> str | None:
    """The one line that tells the fleet at `root` of its unread news, or None: none, no news file, or a
    fleet the registry does not name."""
    if not log_path().is_file():
        return None
    fleet = fleet_of(root)
    if fleet is None:
        return None
    count = len(unread(fleet))
    if not count:
        return None
    return f"news: {count} unread for {fleet}, never a wake: `fleet news read --as {fleet}`"


def cmd_post(args) -> None:
    print(line(post(args.sender, args.to, args.kind, args.keep, args.text)), flush=True)


def cmd_read(args) -> None:
    fleet = _name(args.who, "--as")
    items = read_all()
    after = _cursor(fleet)
    fresh = [i for i in for_reader(items, fleet) if i["id"] > after]
    for i in fresh:
        print(line(i))
    if not fresh:
        print(f"no news for {fleet}")
    mark_read(fleet, items)


def cmd_list(args) -> None:
    items = read_all()
    for i in items:
        print(line(i))
    if not items:
        print("no news")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fleet news", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("post")
    s.add_argument("--from", dest="sender", required=True, metavar="NAME")
    s.add_argument("--to", default="all", metavar="all|FLEET[,FLEET...]")
    s.add_argument("--kind", choices=KINDS, default="fyi")
    s.add_argument("--keep", action="store_true", help="a durable rule: the reader saves it; the default is do not save")
    s.add_argument("text")
    s = sub.add_parser("read"); s.add_argument("--as", dest="who", required=True)
    sub.add_parser("list")
    return p


def main(argv: list[str]) -> None:
    args = build_parser().parse_args(argv)
    try:
        globals()[f"cmd_{args.cmd}"](args)
    except NewsError as exc:
        sys.stderr.write(f"news: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
