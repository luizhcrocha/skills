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
APPROVES = ("yes", "approve", "approved")  # the first word of a grilling question's answer that gives a standing approval
QUESTION_STATUSES = ["open", "answered", "dropped"]
STATUSES = ["open", "decided", "withdrawn"]
ASKS = ["user", "manager"]
ID = re.compile(r"[A-Za-z0-9_.-]+")
# Where a standing approval comes from: a decision of this fleet, or FLEET/DECISION in another's, and :Q<n> a grilling's question.
SOURCE = re.compile(r"(?:([A-Za-z0-9_.-]+)/)?([A-Za-z0-9_.-]+)(?::[Qq]([0-9]+))?")
_ELSEWHERE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")

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
            if "/" in a["ref"] and not _ELSEWHERE.fullmatch(a["ref"]):
                fail(f"approval {a['id']} comes from {a['ref']!r}: another fleet's decision is FLEET/DECISION")
            if "/" not in a["ref"] and a["ref"] not in ids:
                fail(f"approval {a['id']} comes from unknown decision '{a['ref']}'")
            if "question" in a and not (isinstance(a["question"], str) and re.fullmatch(r"q[0-9]+", a["question"])):
                fail(f"approval {a['id']}'s question {a['question']!r} should be q and a number")
            approvals.add(a["id"])
    for d in state.get("decisions", []):
        if d["kind"] == "notice" and (not isinstance(d.get("under"), str) or d["under"] not in approvals):
            fail(f"notice {d['id']} is done under unknown approval '{d.get('under')}'")
        if d["kind"] == "notice" and not (isinstance(d.get("undo"), str) and d["undo"].strip()):
            fail(f"notice {d['id']} says no way to undo it (undo)")


def served(name: str) -> dict | None:
    """The registry's live entry for the fleet called `name` (its id, else one of its aliases), read without
    touching the registry; None when no fleet of that name is served."""
    import fleets
    try:
        paths = sorted(p for p in fleets.home().glob("*.json") if p.is_file())
    except OSError:
        return None
    entries = [e for e in (fleets._read(p) for p in paths)
               if e and isinstance(e.get("id"), str) and isinstance(e.get("dir"), str) and fleets._alive(e.get("pid"))]
    return next((e for e in entries if e["id"] == name), None) or \
        next((e for e in entries if isinstance(e.get("aliases"), list) and name in e["aliases"]), None)


def approves(q: dict) -> bool:
    """Whether a grilling question was answered yes or approve: its answer's first word, after an option's key
    (`(a)`, `a:`) is read as that option's label and "as recommended" as its recommendation."""
    text = str(q.get("answer") or "").strip()
    if text.lower().startswith("as recommended"):
        text = str(q.get("recommend") or "")
    head = re.match(r"\(?([A-Za-z0-9]+)\)?:?(?=\s|$)", text)
    option = next((o for o in q.get("options") or [] if head and str(o.get("id", "")).lower() == head[1].lower()), None)
    if option:
        text = str(option.get("label") or "")
    word = re.match(r"[^A-Za-z]*([A-Za-z]+)", text)
    return bool(word) and word[1].lower() in APPROVES


def approval_source(state: dict | None, root, text: str) -> dict | str:
    """Where `approval add --ref TEXT` comes from, checked as a standing approval needs it: a decided choice,
    input or grilling asked of the user on the page, with the user's message tagged with it in that fleet's
    chat (the hub's, the only writer as the user), in this fleet's ledger or, as FLEET/DECISION, in a served
    fleet's; a grilling's by one question (:Q<n>) answered yes or approve. The row's fields, or why not."""
    import chat
    parsed = SOURCE.fullmatch(text or "")
    if not parsed:
        return f"--ref reads [FLEET/]DECISION[:Q<n>] (D7, manager/G5:Q1), got {text!r}"
    fleet, key, n = parsed[1], parsed[2], parsed[3]
    question = f"q{int(n)}" if n else None
    entry = None
    if fleet is not None:
        entry = served(fleet)
        if entry is None:
            return f"no fleet '{fleet}' is being served: --ref FLEET/DECISION names a decision in a fleet `fleet fleets list` names"
        try:
            state = json.loads((Path(entry["dir"]) / "state.json").read_text())
        except (OSError, ValueError):
            state = None
        if not isinstance(state, dict) or not isinstance(state.get("decisions"), list):
            return f"fleet '{entry['id']}' has no ledger at {Path(entry['dir']) / 'state.json'}"
        root = entry["dir"]
    d = find(state, key)
    if d is None:
        return f"unknown decision '{key}'" + (f" in {entry['id']}" if entry else "")
    label = (f"{entry['id']}/" if entry else "") + (d.get("ref") or d["id"])
    name = f"{label} ({d.get('title')})"
    if question and d.get("kind") != "grill":
        return f"{name} is a {d.get('kind')}, not a grilling: :{question.upper()} names a grilling's question"
    if not question and d.get("kind") == "grill":
        return f"{name} is a grilling: name the question the user answered yes or approve ({label}:Q1)"
    if d["status"] != "decided":
        return f"{name} is {d['status']}: a standing approval comes from a decision the user decided"
    if d["kind"] not in CHOICE_KINDS or d.get("asks", "user") != "user" or not d.get("page", True):
        return (f"{name} was not asked of the user on the page: only the user's own answer there gives a standing approval; "
                "ask them with a decision that names the rule")
    if question:
        q = next((x for x in d.get("questions") or [] if x.get("id") == question), None)
        if q is None:
            return f"{name} has no question {question.upper()}"
        label = f"{label}:{question.upper()}"
        if q.get("status") != "answered":
            return f"{label} is {q.get('status')}: a standing approval comes from a question the user answered yes or approve"
        if not approves(q):
            return (f"{label} was answered {q.get('answer')!r}: a standing approval comes from a question answered yes or "
                    "approve; ask it again, one rule to a question")
    answers = [m for m in chat.read(Path(root).resolve()) if m.get("decision") == d["id"] and m.get("from") == "user"]
    if not answers:
        return f"{name} has no answer from the user in the chat: only the user's own answer on the page gives a standing approval"
    m = answers[-1]
    return {"ref": f"{entry['id']}/{d.get('ref') or d['id']}" if entry else d["id"], "question": question,
            "message": m["id"], "author": m["author"] if isinstance(m.get("author"), str) and m["author"] else None,
            "label": label, "decision": None if entry else d["id"], "id": d["id"], "dir": entry["dir"] if entry else None}


def same_source(a: dict, ref: str, question: str | None, local: str | None = None) -> bool:
    """Whether approval row `a` comes from `ref` (FLEET/DECISION) and `question`; `local`, in the source fleet's
    own ledger, is the decision's id there, which an approval added without FLEET/ names."""
    return (a.get("ref") == ref or (local is not None and a.get("ref") == local)) and a.get("question") == question
