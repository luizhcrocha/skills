#!/usr/bin/env python3
"""The decisions of DIR/state.json: what waits on the user, and what an answer to one may be.

A decision is one item of `decisions[]`: a question put to the user, open until the coordinator
records it as decided or withdraws it. state.py writes them (`state.py DIR decision ...`), the
dashboard server asks `answer_refusal` before it stores an answer given on the page, and
render_dashboard.py checks the rows with `validate`.
"""
import json
import re
from pathlib import Path

KINDS = ["decision", "input", "secret", "action", "grill"]
QUESTION_STATUSES = ["open", "answered", "dropped"]
STATUSES = ["open", "decided", "withdrawn"]
ASKS = ["user", "manager"]
ID = re.compile(r"[A-Za-z0-9_.-]+")

_REFERENCE = re.compile(r"op://[^/\n]+/[^/\n]+/[^/\n]+(/[^/\n]+)?")
_VALUE_PREFIX = re.compile(r"sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abposr]-|AKIA|AIza|eyJ|-----BEGIN")
_NAME_MAX = 120
NOT_A_VALUE = ("that reads as the secret's value; give an op://vault/item/field reference or the name of the "
               "1Password item, never the value")


PREFIX = {"decision": "D", "action": "A", "input": "I", "secret": "S", "grill": "G"}
ROW_PREFIX = {"links": "L", "roadblocks": "R"}


def find(state: dict, id_: str) -> dict | None:
    """The decision with this id, or else with this number (D3, written in capitals: ids are the
    coordinator's own words, often lower-case like d3, and an id always wins)."""
    rows = state.get("decisions", [])
    return next((d for d in rows if d.get("id") == id_), None) or \
        next((d for d in rows if d.get("ref") and d["ref"] == id_), None)


def _next(rows: list, prefix: str) -> int:
    taken = [int(r["ref"][len(prefix):]) for r in rows if re.fullmatch(prefix + r"\d+", str(r.get("ref", "")))]
    return max(taken, default=0) + 1


def number(state: dict) -> None:
    """Give each decision, link and roadblock without one its number: a letter for its kind (D a
    decision, A an action, I an input, S a secret, G a grilling, L a link, R a roadblock) and the next
    free number for that letter, in the order they were opened. A number, once given, stays."""
    rows = [d for d in state.get("decisions", []) if isinstance(d, dict)]
    for d in sorted((d for d in rows if not d.get("ref")), key=lambda d: str(d.get("opened", ""))):
        prefix = PREFIX.get(d.get("kind"), "D")
        d["ref"] = f"{prefix}{_next(rows, prefix)}"
    for key, prefix in ROW_PREFIX.items():
        items = [r for r in state.get(key, []) if isinstance(r, dict)]
        for r in items:
            if not r.get("ref"):
                r["ref"] = f"{prefix}{_next(items, prefix)}"


def closed_because(item: dict) -> str:
    """Why an item takes no more answers or edits, in words for the user."""
    return f"{item['title']} is already {item['status']}: {item.get('resolution') or 'no reason recorded'}"


def reads_as_a_value(text: str) -> bool:
    """Whether `text` could be a secret's value rather than a pointer to it: a known token prefix, a
    long word mixing letters and digits, or more text than a name needs."""
    if len(text) > _NAME_MAX:
        return True
    for word in text.split():
        if _VALUE_PREFIX.match(word.lstrip("\"'`(")):
            return True
        if len(word) >= 20 and re.search(r"[A-Za-z]", word) and re.search(r"\d", word):
            return True
    return False


def answer_refusal(root, id_: str, text: str) -> str | None:
    """Why the answer `text` to decision `id_` is refused, or None when the chat may store it. An
    unknown or closed item refuses with its reason, so an answer to a page that went stale is told
    why. A secret takes a reference or an item name: the value itself never reaches the chat."""
    try:
        state = json.loads((Path(root) / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    item = find(state, id_) if isinstance(state, dict) else None
    if item is None:
        return f"unknown decision '{id_}'"
    if item.get("status") != "open":
        return closed_because(item)
    if item.get("kind") == "secret":
        answer = text.strip()
        if not _REFERENCE.fullmatch(answer) and reads_as_a_value(answer):
            return NOT_A_VALUE
    return None


def validate(state: dict, fail) -> None:
    """Check decisions[] and the roadblocks that point at it; `fail(message)` reports the first fault."""
    rows = state.setdefault("decisions", [])
    if not isinstance(rows, list):
        fail("'decisions' should be list")
    ids = set()
    for d in rows:
        for k in ("id", "kind", "title", "question", "status", "opened"):
            if k not in d:
                fail(f"decision {d.get('id', '?')} is missing '{k}'")
        if not ID.fullmatch(str(d["id"])):
            fail(f"decision id {d['id']!r} should be letters, digits, '_', '.', or '-'")
        if d["id"] in ids:
            fail(f"duplicate decision id '{d['id']}'")
        if any(o is not d and o.get("ref") == d["id"] for o in rows):
            fail(f"decision id '{d['id']}' is another decision's number; pick another id")
        if d["kind"] not in KINDS:
            fail(f"decision {d['id']} kind '{d['kind']}' not in {KINDS}")
        if d["status"] not in STATUSES:
            fail(f"decision {d['id']} status '{d['status']}' not in {STATUSES}")
        for o in d.setdefault("options", []):
            if not isinstance(o, dict) or not all(isinstance(o.get(k), str) for k in ("id", "label", "consequence")):
                fail(f"decision {d['id']} has an option without id, label and consequence")
        if d["kind"] == "grill":
            qs = d.setdefault("questions", [])
            if not isinstance(qs, list) or not all(isinstance(q, dict) and isinstance(q.get("id"), str) and isinstance(q.get("title"), str)
                                                    and q.get("status") in QUESTION_STATUSES for q in qs):
                fail(f"grilling {d['id']} has a question without id, title, or a status in {QUESTION_STATUSES}")
        ids.add(d["id"])
        if d.setdefault("asks", "user") not in ASKS:
            fail(f"decision {d['id']} asks '{d['asks']}', not one of {ASKS}")
        d.setdefault("blocking", False)
        d.setdefault("page", True)
        d.setdefault("body", False)
        for k in ("why", "recommend", "reason", "secret", "manual", "agent", "supersedes", "change",
                  "answer", "resolution", "revised", "closed"):
            d.setdefault(k, None)
    for d in rows:
        if d["supersedes"] and d["supersedes"] not in ids:
            fail(f"decision {d['id']} supersedes unknown decision '{d['supersedes']}'")
    for r in state.get("roadblocks", []):
        if r.get("decision") and r["decision"] not in ids:
            fail(f"roadblock {r.get('id', '?')} points at unknown decision '{r['decision']}'")
