#!/usr/bin/env python3
"""The decisions of DIR/state.json: what waits on the user, and what an answer to one may be.

A decision is one item of `decisions[]`: a question put to the user, open until the coordinator
records it as decided or withdraws it. state.py writes them (`state.py DIR decision ...`), the
dashboard server asks `answer_refusal` before it stores an answer given on the page, and
render_dashboard.py checks the rows with `validate`.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clock  # noqa: E402

KINDS = ["decision", "input", "secret", "action", "grill", "notice"]
CHOICE_KINDS = ("decision", "input", "grill")  # what asks the user to choose or give: what a standing approval may come from
APPROVAL_STATUSES = ["active", "revoked"]
QUESTION_STATUSES = ["open", "answered", "dropped"]
STATUSES = ["open", "decided", "withdrawn"]
ASKS = ["user", "manager"]
ID = re.compile(r"[A-Za-z0-9_.-]+")

_REFERENCE = re.compile(r"op://[^/\n]+/[^/\n]+/[^/\n]+(/[^/\n]+)?")
_VALUE_PREFIX = re.compile(r"sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abposr]-|AKIA|AIza|eyJ|-----BEGIN")
_NAME_MAX = 120
NOT_A_VALUE = ("that reads as the secret's value; give an op://vault/item/field reference or the name of the "
               "1Password item, never the value")


PREFIX = {"decision": "D", "action": "A", "input": "I", "secret": "S", "grill": "G", "notice": "N"}
ROW_PREFIX = {"links": "L", "roadblocks": "R"}


def find(state: dict, id_: str) -> dict | None:
    """The decision with this id, or else with this number (D3, written in capitals: ids are the
    coordinator's own words, often lower-case like d3, and an id always wins)."""
    rows = state.get("decisions", [])
    return next((d for d in rows if d.get("id") == id_), None) or \
        next((d for d in rows if d.get("ref") and d["ref"] == id_), None)


def _next(rows: list, prefix: str, row: dict) -> str:
    """The number `row` gets: `prefix` and 1 + the highest number given, skipping any that another row
    has as its id, since a lookup finds an id before a number."""
    taken = [int(r["ref"][len(prefix):]) for r in rows if re.fullmatch(prefix + r"\d+", str(r.get("ref", "")))]
    ids = {r.get("id") for r in rows if r is not row}
    n = max(taken, default=0) + 1
    while f"{prefix}{n}" in ids:
        n += 1
    return f"{prefix}{n}"


def number(state: dict) -> None:
    """Give each decision, link and roadblock without one its number: a letter for its kind (D a
    decision, A an action, I an input, S a secret, G a grilling, N a notice, L a link, R a roadblock) and the next
    free number for that letter, in the order they were opened, skipping a number that another row of
    the same list has as its id. A number, once given, stays."""
    rows = [d for d in state.get("decisions", []) if isinstance(d, dict)]
    for d in sorted((d for d in rows if not d.get("ref")), key=lambda d: clock.order(d.get("opened", ""))):
        d["ref"] = _next(rows, PREFIX.get(d.get("kind"), "D"), d)
    for key, prefix in ROW_PREFIX.items():
        items = [r for r in state.get(key, []) if isinstance(r, dict)]
        for r in items:
            if not r.get("ref"):
                r["ref"] = _next(items, prefix, r)


def recorded(d: dict, m: dict) -> bool:
    """Whether decision `d` has recorded the user's answer `m`: its own state changed at or after it. Closed
    (decided or withdrawn), it has recorded every answer; open, it has recorded one given before it was opened
    or last revised, one given until it was held (`held_at`, the fleet works on it first), and, on a grilling,
    one given before a question was answered or dropped. A reply in the chat records nothing: only the
    decision command does (D115 sat waiting two days behind a "Recorded B"). TypeScript's `answerRecorded`."""
    if d.get("status", "open") != "open":
        return True
    since = d.get("revised") or d.get("opened") or ""
    held = d.get("held_at") if d.get("held") else None
    if not clock.at_or_after(m["at"], since) or (held and clock.at_or_after(held, m["at"])):
        return True
    questions = d.get("questions") if isinstance(d.get("questions"), list) else []
    return any(isinstance(q, dict) and isinstance(q.get("answered"), str) and q["answered"]
               and clock.at_or_after(q["answered"], m["at"]) for q in questions)


def answered_at(d: dict, said: list[dict]) -> str | None:
    """When the user's latest answer to decision `d` that it has not recorded (`recorded`) was sent: the fleet
    has it and has not recorded it. None when there is none. TypeScript's `answeredAt`."""
    answers = [m for m in said if m.get("decision") == d.get("id") and m["from"] == "user" and not recorded(d, m)]
    return answers[-1]["at"] if answers else None


FAILED = "Failed:"  # how the page's answer to an action the user ran and that failed begins: "Failed: <what happened>"


def failed_answer(d: dict, said: list[dict]) -> dict | None:
    """The user's latest answer to the open action `d`, given since it last changed, when it says the step
    failed ("Failed: ..."); None otherwise. Neither a reply nor a hold settles it: the step is not done until
    the fleet revises it (the fix, re-presented) or withdraws it. TypeScript's `failedAnswer` (fleet/src/health.ts)."""
    if d.get("kind") != "action" or d.get("status") != "open":
        return None
    since = d.get("revised") or d.get("opened") or ""
    answers = [m for m in said if m.get("decision") == d.get("id") and m["from"] == "user" and clock.at_or_after(m["at"], since)]
    return answers[-1] if answers and str(answers[-1].get("text", "")).startswith(FAILED) else None


def failure_words(m: dict) -> str:
    """The first words of a failed answer: its note's first line, cut at 60 characters."""
    line = m["text"][len(FAILED):].strip().split("\n")[0].strip()
    return line[:60] + "…" if len(line) > 60 else line


def answered_grill(d: dict) -> bool:
    """Whether `d` is a grilling still open with no question left open: every question is answered (or
    dropped) and the fleet has yet to record it (`--decide` or `--withdraw`). Read from the ledger's question
    statuses, whatever the chat said since; `show`, the state warnings and the coordinator's watch say it
    from this. TypeScript's `answeredGrill` (fleet/src/health.ts)."""
    questions = d.get("questions") if isinstance(d.get("questions"), list) else []
    return d.get("kind") == "grill" and d.get("status") == "open" and not any(
        isinstance(q, dict) and q.get("status") == "open" for q in questions)


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
            for q in qs:
                options = q.get("options", [])
                if not isinstance(options, list) or not all(isinstance(o, dict) and all(isinstance(o.get(k), str) for k in ("id", "label", "consequence"))
                                                            for o in options):
                    fail(f"grilling {d['id']} has a question's option without id, label and consequence")
        ids.add(d["id"])
        if d.setdefault("asks", "user") not in ASKS:
            fail(f"decision {d['id']} asks '{d['asks']}', not one of {ASKS}")
        d.setdefault("blocking", False)
        d.setdefault("page", True)
        d.setdefault("body", False)
        for k in ("why", "recommend", "reason", "secret", "manual", "agent", "supersedes", "change", "step", "milestone",
                  "answer", "resolution", "revised", "closed"):
            d.setdefault(k, None)
        if d.get("held") is not None or d.get("held_at") is not None:
            if not isinstance(d.get("held"), str) or not d["held"] or not isinstance(d.get("held_at"), str):
                fail(f"decision {d['id']} is held without its reason and when (held, held_at)")
            if d["status"] != "open":
                fail(f"decision {d['id']} is {d['status']} and still held")
    for d in rows:
        if d["supersedes"] and d["supersedes"] not in ids:
            fail(f"decision {d['id']} supersedes unknown decision '{d['supersedes']}'")
    for r in state.get("roadblocks", []):
        if r.get("decision") and r["decision"] not in ids:
            fail(f"roadblock {r.get('id', '?')} points at unknown decision '{r['decision']}'")
    validate_approvals(state, ids, fail)


def validate_approvals(state: dict, ids: set, fail) -> None:
    """Check approvals[] (the standing approvals the user gave once) and the notices done under them."""
    if "approvals" not in state:
        approvals = set()
    else:
        rows = state["approvals"]
        if not isinstance(rows, list):
            fail("'approvals' should be list")
        approvals = set()
        for a in rows:
            if not isinstance(a, dict) or not all(isinstance(a.get(k), str) and a[k] for k in ("id", "rule", "by", "ref", "added", "status")):
                fail(f"approval {a.get('id', '?') if isinstance(a, dict) else '?'} needs id, rule, by, ref, added and status")
            if not re.fullmatch(r"K[0-9]+", a["id"]):
                fail(f"approval id {a['id']!r} should be K and a number")
            if a["id"] in approvals:
                fail(f"duplicate approval id '{a['id']}'")
            if a["status"] not in APPROVAL_STATUSES:
                fail(f"approval {a['id']} status '{a['status']}' not in {APPROVAL_STATUSES}")
            if a["ref"] not in ids:
                fail(f"approval {a['id']} comes from unknown decision '{a['ref']}'")
            approvals.add(a["id"])
    for d in state.get("decisions", []):
        if d["kind"] == "notice" and (not isinstance(d.get("under"), str) or d["under"] not in approvals):
            fail(f"notice {d['id']} is done under unknown approval '{d.get('under')}'")
        if d["kind"] == "notice" and not (isinstance(d.get("undo"), str) and d["undo"].strip()):
            fail(f"notice {d['id']} says no way to undo it (undo)")
