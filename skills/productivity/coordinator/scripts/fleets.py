#!/usr/bin/env python3
"""The fleets being served on this machine: how a manager finds the coordinators, and they it.

    fleets.py list              every live fleet: its name, role, status, session, address, directory
                                and what it is doing, then its live agents, its links, the decisions
                                open in it and what it spent
    fleets.py waiting           what waits on the user, from every fleet's ledger: each open decision
                                for the user, since when, and an answer sent but not recorded yet
    fleets.py show FLEET        what one fleet is doing, from its ledger: now-line, live workers and
                                their last report, every lane in flight, open decisions and
                                roadblocks, latest events
    fleets.py manager           how to reach the manager; exits 1 when there is none
    fleets.py decision FLEET ID what a fleet asks, in full: the question, why, the options, the
                                recommendation, where its evidence and its page are
    fleets.py gate [take FLEET|--as NAME WHAT [--for MINUTES] [--wait SECONDS] | free TOKEN]
                                the machine's one gate slot: a heavy check (a test suite, a build)
                                runs only while its fleet, or a session --as itself, holds it; a take
                                while held refuses, the holder's own included, or with --wait waits;
                                it prints the token that frees it, and lapses after --for (60) minutes
    fleets.py procs             the background processes each fleet's session started, with their age
    fleets.py whose FROM TO     the files a landing moves, by owning fleet (the manager's DIR/owners)
    fleets.py name DIR SESSION  give the fleet its one name: the session's, which the registry, the
                                manager's page and chat, and SendMessage all use from then on
    fleets.py approval add --all|--fleets A,B --rule R --ref FLEET/DECISION[:Q<n>] [--by WHO]
                                one standing approval, from one answer of the user's, in every served
                                fleet's ledger (or those named), each under its next K; a fleet that
                                has one from the same --ref is skipped
    fleets.py approval revoke --ref FLEET/DECISION[:Q<n>] --reason R [--fleets A,B]
                                revoke the approvals from that answer in every fleet that has them

serve_dashboard.py registers a fleet when it starts serving DIR and forgets it on --stop; a fleet
whose server died is forgotten the next time anyone looks, its last entry kept under names/ until its
DIR, or its session (`claude respawn`: a new pid, the same session id), is served again and takes the
name back. A fleet is known by one name: its
project's (`acme-billing`) until `name` gives it its session's, which the manager's chat mentions it by. The registry is
$FLEET_HOME, or fleet-board under $XDG_STATE_HOME (~/.local/state).
"""
import fcntl
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clock  # noqa: E402

KEPT = {"user", "coordinator", "manager"}  # the names the chat keeps for itself


def fail(msg: str) -> None:
    sys.stderr.write(f"fleets: {msg}\n")
    sys.exit(1)


def home() -> Path:
    base = os.environ.get("FLEET_HOME")
    if base:
        return Path(base)
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "fleet-board"


def _read(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


def role_of(state: dict | None) -> str:
    return "manager" if (state or {}).get("role") == "manager" else "coordinator"


def scratchpad_session(root) -> str | None:
    """The session whose scratchpad holds DIR (`…/<project>/<session>/scratchpad/<name>`), or None."""
    import spend
    transcript = spend.transcript_of(root)
    return transcript.stem if transcript else None


def _session_folder(session_id) -> Path | None:
    """The folder beside session SESSION_ID's transcript, in whichever project holds it, or None."""
    import spend
    return spend.session_folder(session_id)


def title_of(root, session_id=None) -> str | None:
    """The title (its /rename) session SESSION_ID, the one serving DIR, goes by, else the session's whose
    scratchpad holds DIR (a resumed session has a new id, its old scratchpad keeps the old title), or None
    when it has none."""
    import spend
    transcript = spend.transcript_of(root)
    for folder in (_session_folder(session_id), transcript.with_suffix("") if transcript else None):
        title = ((_read(folder / "custom-title.json") if folder else None) or {}).get("customTitle")
        if isinstance(title, str) and title.strip():
            return title.strip()
    return None


def live() -> list[dict]:
    """The fleets whose server is running, oldest first. One whose server died is forgotten here, and
    one whose session was renamed takes its new name here, so the registry never lags the session."""
    entries = []
    for path in sorted(home().glob("*.json")):
        entry = _read(path)
        if entry and _alive(entry.get("pid")) and isinstance(entry.get("dir"), str) and isinstance(entry.get("id"), str):
            entries.append(entry)
        else:
            if entry:
                _keep_name(entry)
            path.unlink(missing_ok=True)
    for i, entry in enumerate(entries):
        title = title_of(entry["dir"], entry.get("session_id"))
        if not title or title == entry.get("session"):
            continue
        new = entry["id"] if entry["role"] == "manager" else fleet_name(title)
        if not new or new in KEPT and entry["role"] != "manager" or any(e["id"] == new for e in entries if e is not entry):
            new = entry["id"]
        if new != entry["id"]:
            (home() / f"{entry['id']}.json").unlink(missing_ok=True)
        entries[i] = _write(_with_aliases({**entry, "id": new, "session": title}, aliases_after(entry, entry["id"], new)))
    return sorted(entries, key=lambda e: str(e.get("since", "")))


def known() -> list[dict]:
    """Every fleet the registry knows, served or not: the live ones (live(), which keeps a dead one's entry),
    then the kept entries of the fleets no longer served whose DIR none of them serves, by id. A fleet
    stopped with `serve --stop` is forgotten, so it is not among them."""
    entries = live()
    dirs = {e["dir"] for e in entries}
    ids = {e["id"] for e in entries}
    stopped = [e for _, e in _kept_names() if isinstance(e.get("dir"), str) and e["dir"] not in dirs and e["id"] not in ids]
    return entries + sorted(stopped, key=lambda e: e["id"])


def find(root) -> dict | None:
    root = str(Path(root).resolve())
    return next((e for e in live() if e["dir"] == root), None)


def _write(entry: dict) -> dict:
    home().mkdir(parents=True, exist_ok=True)
    path = home() / f"{entry['id']}.json"
    scratch = path.with_suffix(".tmp")
    scratch.write_text(json.dumps(entry, indent=2) + "\n", encoding="utf-8")
    scratch.replace(path)
    return entry


def _names() -> Path:
    return home() / "names"


def _keep_name(entry: dict) -> None:
    """Keep a forgotten fleet's entry, by its name and in place of any kept before for its DIR, so its DIR
    or its session served again gets its name back."""
    if not isinstance(entry.get("dir"), str) or not isinstance(entry.get("id"), str) or not entry["id"] or "/" in entry["id"]:
        return
    for old, kept in _kept_names():
        if kept.get("dir") == entry["dir"]:
            old.unlink(missing_ok=True)
    _names().mkdir(parents=True, exist_ok=True)
    path = _names() / f"{entry['id']}.json"
    scratch = path.with_suffix(".tmp")
    scratch.write_text(json.dumps(entry, indent=2) + "\n", encoding="utf-8")
    scratch.replace(path)


def _kept_names() -> list[tuple[Path, dict]]:
    found = []
    for path in sorted(_names().glob("*.json")):
        entry = _read(path)
        if entry and isinstance(entry.get("id"), str):
            found.append((path, entry))
    return found


def register(root, url: str, pid: int, session_id: str | None = None) -> dict:
    """Record that DIR is served at `url` by process `pid` for session SESSION_ID (else the session whose
    scratchpad holds DIR), and return the entry. A fleet that registers again keeps its name, aliases and
    session: from its own entry, else from its DIR's kept entry, else from its session's (a respawned session
    serving another DIR). A brand-new fleet is named after its session's title, else its project."""
    root = Path(root).resolve()
    state = _read(root / "state.json")
    # The fleet's own entry is read before the dead are forgotten: on a restart its server is the dead one.
    known = next((e for e in map(_read, sorted(home().glob("*.json"))) if e and e.get("dir") == str(root) and e.get("id")), None)
    role, others = role_of(state), [e for e in live() if e["dir"] != str(root)]
    taken = lambda n: not n or n in {e["id"] for e in others}  # noqa: E731
    kept = _kept_names()
    of_dir = next(((p, e) for p, e in kept if e.get("dir") == str(root)), None)
    session = session_id or scratchpad_session(root) or (known or (of_dir[1] if of_dir else {})).get("session_id") or None
    of_session = next(((p, e) for p, e in kept if session and e.get("session_id") == session and not taken(e["id"])), None)
    prior = known or (of_dir[1] if of_dir and not taken(of_dir[1]["id"]) else (of_session[1] if of_session else None))
    title = title_of(root, session)
    free = lambda n: not taken(n) and n not in KEPT  # noqa: E731
    if title and role != "manager" and free(fleet_name(title)):
        name = fleet_name(title)
    elif prior:
        # An entry named before session numbers were dropped (`3.ui-coordinator`) drops its number now.
        prior_session = prior.get("session")
        unnumbered_id = fleet_name(prior_session) if isinstance(prior_session, str) and role != "manager" else prior["id"]
        name = unnumbered_id if drops_number(prior["id"], unnumbered_id) and free(unnumbered_id) else prior["id"]
    else:
        base = "manager" if role == "manager" else slug(str((state or {}).get("project") or root.parent.name)) or "fleet"
        if role != "manager" and base in KEPT:
            base += "-fleet"
        name, n = base, 1
        while taken(name):
            n += 1
            name = f"{base}-{n}"
    if known and known["id"] != name:
        (home() / f"{known['id']}.json").unlink(missing_ok=True)
    for used in (of_dir, of_session if of_session and prior is of_session[1] else None):
        if used:
            used[0].unlink(missing_ok=True)
    return _write(_with_aliases({"id": name, "role": role, "dir": str(root), "url": url, "pid": pid,
                                 "session": title or (prior.get("session") if prior else None),
                                 "session_id": session,
                                 "since": known["since"] if known else clock.stamp()},
                                aliases_after(prior, prior["id"], name) if prior else []))


def unregister(root) -> None:
    root = str(Path(root).resolve())
    for path in home().glob("*.json"):
        if (_read(path) or {}).get("dir") == root:
            path.unlink(missing_ok=True)


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", text).strip("-.").lower()


def unnumbered(session: str) -> str:
    """A session's name without the number Claude Code puts before it on a restart: `3.ui-coordinator`
    is `ui-coordinator`."""
    return re.sub(r"^[0-9]+\.(?=[\s\S])", "", session, count=1)


def fleet_name(session: str) -> str:
    """The fleet name a session's name gives: its slug, without the session's number."""
    return slug(unnumbered(session))


def drops_number(old: str, new: str) -> bool:
    """Whether `new` is the id `old` without its session's number (`3.ui-coordinator` to `ui-coordinator`)."""
    return old != new and re.match(r"[0-9]+\.", old) is not None and unnumbered(old) == new


def aliases_after(entry: dict, old: str, new: str) -> list:
    """The aliases an entry keeps once its id goes from `old` to `new`: every rename keeps `old`, so its
    address still answers. The hub sends an alias's address on to the fleet's."""
    given = entry.get("aliases")
    kept = [a for a in given if isinstance(a, str) and a != new] if isinstance(given, list) else []
    if old and old != new and old not in kept:
        kept.append(old)
    return kept


def _with_aliases(entry: dict, aliases: list) -> dict:
    if aliases:
        return {**entry, "aliases": aliases}
    return {k: v for k, v in entry.items() if k != "aliases"}


def name(root, session: str) -> dict | str:
    """Give the fleet served from DIR its one name: the session's, which becomes its name in the
    registry, on the manager's page and in the manager's chat too. The entry, or why not."""
    entry = find(root)
    if not entry:
        return f"{root} is not being served; serve it with `fleet serve` first"
    new = "manager" if entry["role"] == "manager" else fleet_name(session)  # the manager's chat host keeps its name
    if not new or (new in KEPT and entry["role"] != "manager"):
        return f"'{session}' cannot name a fleet; the chat keeps {sorted(KEPT)} for itself"
    if any(e["id"] == new for e in live() if e["dir"] != entry["dir"]):
        return f"another fleet is already called '{new}'; pick another session name"
    if new != entry["id"]:
        (home() / f"{entry['id']}.json").unlink(missing_ok=True)
    return _write(_with_aliases({**entry, "id": new, "session": session}, aliases_after(entry, entry["id"], new)))


def manager() -> dict | None:
    return next((e for e in live() if e["role"] == "manager"), None)


def summary(entry: dict) -> dict:
    """A fleet as the manager's page and the manager read it: who it is, what it is doing, what waits
    in it, what its workers and its coordinator spent."""
    import chat, spend  # here, not above: a status line's capture loads this module and needs neither
    import decisions
    state = _read(Path(entry["dir"]) / "state.json")
    if state:
        decisions.number(state)
    rows = lambda key: [r for r in (state or {}).get(key, []) if isinstance(r, dict)]  # noqa: E731
    workers: dict[str, int] = {}
    for a in rows("agents"):
        workers[str(a.get("status"))] = workers.get(str(a.get("status")), 0) + 1
    running = [a for a in rows("agents") if a.get("status") in ("running", "blocked", "queued")]
    said = chat.read(entry["dir"])
    return {
        "id": entry["id"], "url": entry["url"], "session": entry.get("session"), "dir": entry["dir"],
        "name": entry["id"], "project": str((state or {}).get("project") or ""), "goal": str((state or {}).get("goal") or ""),
        "status": str(state["status"]) if state and state.get("status") else "unknown",
        "now": str((state or {}).get("now") or ""), "updated": (state or {}).get("updated"),
        "workers": workers, "tokens": sum(int(a.get("tokens") or 0) for a in rows("agents")),
        "spent": spend.of(entry["dir"]), "chat": chat.listening(entry["dir"]), "active": spend.active(entry["dir"], entry.get("session_id")),
        "now_at": (state or {}).get("now_at"),
        "lanes": sorted({str(lane) for a in running for lane in a.get("lane") or []}),
        "roadblocks": sum(1 for r in rows("roadblocks") if not r.get("resolved")),
        "index": _index(state or {}),
        "silent": silent_workers(entry["dir"], state or {}),
        "decisions": [{"id": d.get("id"), "ref": d.get("ref"), "kind": d.get("kind", "decision"), "title": d.get("title"), "question": d.get("question"),
                       "why": d.get("why"), "blocking": d.get("blocking") is True, "asks": d.get("asks") or "user",
                       "opened": d.get("opened"), "revised": d.get("revised"),
                       "answered": _answered_at(d, said), "said": _said_about(d, said),
                       **({"questions": _open_questions(d)} if d.get("kind") == "grill" else {}),
                       **({"held": d["held"], "held_at": d.get("held_at")} if d.get("held") else {})}
                      for d in rows("decisions") if d.get("status") == "open" and isinstance(d.get("id"), str)],
    }


SILENT_S = 20 * 60  # a running worker that has written nothing for this long is silent


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).astimezone().isoformat(timespec="seconds")


def silent_workers(root, state: dict) -> list[dict]:
    """The workers of DIR the ledger says are running or blocked whose transcript has not moved for
    SILENT_S: [{id, name, active}], oldest silence first. One whose transcript is not found is left out."""
    import spend
    seen, now_t = spend.last_activity(root), clock.time()
    rows = []
    for a in state.get("agents", []):
        if isinstance(a, dict) and a.get("status") in ("running", "blocked") and a.get("id") in seen and now_t - seen[a["id"]] > SILENT_S:
            rows.append({"id": a["id"], "name": a.get("name") or a["id"], "active": _iso(seen[a["id"]])})
    return sorted(rows, key=lambda r: r["active"])


def _answered_at(d: dict, said: list[dict]) -> str | None:
    """When the user's answer to the open decision `d` was sent and not recorded (decisions.answered_at)."""
    import decisions
    return decisions.answered_at(d, said)


def _said_about(d: dict, said: list[dict]) -> list[dict]:
    """The fleet's chat about the open item `d`, which its page reads to tell whether it waits on the user: the
    user's messages tagged with it and the replies to them, each with what that rule reads."""
    answers = {m["id"] for m in said if m["from"] == "user" and m.get("decision") == d.get("id")}
    return [{"id": m["id"], "at": m.get("at"), "from": m["from"], "to": list(m["to"]), "text": m["text"], "re": m["re"],
             "decision": m.get("decision")}
            for m in said if m["id"] in answers or (m["from"] != "user" and isinstance(m["re"], (int, float)) and not isinstance(m["re"], bool) and m["re"] in answers)]


def _open_questions(d: dict) -> list[dict]:
    """A grilling's questions still open, with what its page reads to count those left to answer."""
    return [{"id": q.get("id"), "of": q.get("of"), "status": "open", "asked": q.get("asked")}
            for q in d.get("questions") or [] if isinstance(q, dict) and q.get("status") == "open"]


def _index(state: dict) -> list[dict]:
    """What the manager's search finds in a fleet: every decision (open or closed), roadblock, plan step
    and worker, each as {group, ref, title, sub, hint, hash}, the hash leading to it on the fleet's page."""
    one = lambda v: " ".join(str(v or "").split())[:200]  # noqa: E731
    rows = []
    for d in state.get("decisions", []):
        if isinstance(d, dict) and d.get("id"):
            rows.append({"group": "decisions", "ref": d.get("ref") or "", "title": one(d.get("title")),
                         "sub": one(d.get("question") if d.get("status") == "open" else d.get("answer") or d.get("resolution")),
                         "hint": str(d.get("status") or ""), "hash": "#decision/" + str(d["id"])})
    for r in state.get("roadblocks", []):
        if isinstance(r, dict):
            rows.append({"group": "roadblocks", "ref": r.get("ref") or "", "title": one(r.get("title")), "sub": one(r.get("detail")),
                         "hint": "resolved" if r.get("resolved") else "open", "hash": "#roadblocks"})
    for m in state.get("roadmap", []):
        for st in (m.get("steps") or []) if isinstance(m, dict) else []:
            if isinstance(st, dict):
                rows.append({"group": "plan", "ref": str(st.get("id") or ""), "title": one(st.get("title")), "sub": one(m.get("title")),
                             "hint": str(st.get("status") or ""), "hash": "#plan"})
    for a in state.get("agents", []):
        if isinstance(a, dict):
            rows.append({"group": "workers", "ref": str(a.get("id") or ""), "title": one(a.get("name")), "sub": one(a.get("task")),
                         "hint": str(a.get("status") or ""), "hash": "#agent-" + str(a.get("id") or "")})
    return rows


def view(state: dict, root) -> dict:
    """The state as the page shows it: a manager's with every coordinator being served and the plan's
    usage as the status line last saw it, a coordinator's with how to reach its manager when there
    is one. The state itself is left as it is."""
    import copy
    import chat, decisions, served, spend
    from urllib.parse import quote
    root = str(Path(root).resolve())
    state = copy.deepcopy(state)
    decisions.number(state)  # the numbers state.py gives on its next write, the same ones: the order is the ledger's
    state = {**state, "spent": spend.of(root), "chat": chat.listening(root)}
    seen = spend.last_activity(root)
    state["agents"] = [{**a, "active": _iso(seen[a["id"]])} if isinstance(a, dict) and a.get("id") in seen else a
                       for a in state.get("agents", [])]
    me = find(root)
    links = [{**link, "fleet": me["id"] if me else None} for link in served.links_of(state, root)]
    if role_of(state) == "manager":
        import usage  # here, not above: usage.py reads the registry's place from this module
        others = [e for e in live() if e["role"] != "manager" and e["dir"] != root]
        for e in others:
            theirs = _read(Path(e["dir"]) / "state.json") or {}
            decisions.number(theirs)
            links += [{**link, "fleet": e["id"]}
                      for link in served.links_of(theirs, str(Path(e["dir"]).resolve()), "f/" + quote(e["id"], safe="!*'()") + "/")]
        return {**state, "coordinators": [summary(e) for e in others], "usage": usage.read(), "gate": gate(),
                "links": links, "found": _unlisted(served.discovered(), links)}
    mine = [x for x in served.discovered() if me and x["fleet"] == me["id"]]
    found = manager()
    state = {**state, "links": links, "found": _unlisted(mine, links)}
    if not found:
        return state
    return {**state, "manager": {"id": found["id"], "url": found["url"], "session": found.get("session")},
            "fleet": me["id"] if me else None,
            "fleets": [e["id"] for e in live() if e["role"] != "manager"]}  # the switcher's: every page is one of the manager's


def _unlisted(found: list[dict], links: list[dict]) -> list[dict]:
    """What the machine serves that no link names: a served port whose address no link points at."""
    from urllib.parse import urlsplit
    ports = {urlsplit(link["url"]).port for link in links}
    return [x for x in found if x["port"] not in ports]


def token_count(n: int) -> str:
    """A token count in three figures and a unit (`471k`, `3.95M`), rounded half up in integers so the
    TypeScript fleet prints the same."""
    if n < 1000:
        return str(n)
    units = ((10**3, "k"), (10**6, "M"), (10**9, "B"))
    u = max(i for i, (size, _) in enumerate(units) if size <= n)
    places = 2
    while True:
        size = units[u][0]
        q = (2 * n * 10**places + size) // (2 * size)
        if q < 1000:
            break
        if places > 0:
            places -= 1
        elif u < len(units) - 1:
            u, places = u + 1, 2
        else:
            break
    digits = str(q)
    return (digits if places == 0 else f"{digits[:-places]}.{digits[-places:]}") + units[u][1]


LIVE = ("running", "blocked", "queued")
LABEL_WIDTH = 48


def lanes_of(agent: dict) -> list[str]:
    """A worker's lanes, each glob once: a lane given as `a/**,b/**` is two."""
    globs = (g.strip() for lane in agent.get("lane") or [] for g in str(lane).split(","))
    return list(dict.fromkeys(g for g in globs if g))


@dataclass(frozen=True, slots=True)
class AgentLine:
    id: str
    status: str
    model: str
    label: str
    lanes: list[str]
    silent_since: str | None


@dataclass(frozen=True, slots=True)
class LinkLine:
    ref: str
    kind: str
    url: str
    title: str


@dataclass(frozen=True, slots=True)
class WaitingLine:
    ref: str
    id: str
    kind: str
    asks: str
    title: str
    blocking: bool
    answered_at: str | None
    held: str | None


@dataclass(frozen=True, slots=True)
class FleetView:
    """One fleet as `fleets list` prints it: who it is, then its live agents, its links, what waits in it, what it spent."""
    id: str
    role: str
    status: str
    session: str | None
    active: str | None
    url: str
    dir: str
    now: str
    chat: dict
    agents: list[AgentLine]
    links: list[LinkLine]
    waiting: list[WaitingLine]
    spent: tuple[int, int, int] | None  # workers, written, read


def _label(agent: dict) -> str:
    import chat
    named = bool(agent.get("name")) and str(agent["name"]) != str(agent.get("id"))
    text = chat._one_line(agent["name"] if named else agent.get("task"))
    return text[:LABEL_WIDTH - 1] + "\u2026" if len(text) > LABEL_WIDTH else text


def fleet_view(entry: dict) -> FleetView:
    import chat, links
    s = summary(entry)
    state = _read(Path(entry["dir"]) / "state.json") or {}
    rows = lambda key: [r for r in state.get(key, []) if isinstance(r, dict)]  # noqa: E731
    silent = {w["id"]: w["active"][11:16] for w in s["silent"]}
    return FleetView(
        id=s["id"], role=entry["role"], status=s["status"], session=s["session"], active=s["active"], url=s["url"], dir=s["dir"],
        now=chat._one_line(s["now"]) if s["now"] else "", chat=s["chat"],
        agents=[AgentLine(id=str(a.get("id")), status=str(a["status"]), model=str(a["model"]) if a.get("model") else "-",
                          label=_label(a), lanes=lanes_of(a), silent_since=silent.get(str(a.get("id"))))
                for a in rows("agents") if a.get("status") in LIVE],
        links=[LinkLine(ref=str(link.get("ref") or link.get("id")), kind=links.kind_of(link.get("kind"), link["url"], link.get("title")) + (", done" if link.get("done") else ""), url=link["url"],
                        title=chat._one_line(link.get("title")))
               for link in rows("links") if isinstance(link.get("url"), str)],
        waiting=[WaitingLine(ref=str(d.get("ref") or ""), id=d["id"], kind=str(d["kind"]), asks="manager" if d["asks"] == "manager" else "user",
                             title=chat._one_line(d["title"]), blocking=d["blocking"], answered_at=d.get("answered"),
                             held=str(d["held"]) if d.get("held") else None)
                 for d in s["decisions"]],
        spent=(s["tokens"], s["spent"]["output"], s["spent"]["input"]) if s["spent"] else None,
    )


def _columns(table: list[list[str]]) -> list[str]:
    """`table` as columns two spaces apart, the last column unpadded."""
    widths = [max((len(row[i]) for row in table), default=0) for i in range(max((len(row) for row in table), default=0))]
    return [("    " + "  ".join(cell if i == len(row) - 1 else cell.ljust(widths[i]) for i, cell in enumerate(row))).rstrip()
            for row in table]


def _agent_lines(agents: list[AgentLine]) -> list[str]:
    counts = [f"{n} {status}" for status in LIVE if (n := sum(1 for a in agents if a.status == status))]
    tails = ["  ".join(([f"lanes: {a.lanes[0]}" + (f" +{len(a.lanes) - 1}" if len(a.lanes) > 1 else "")] if a.lanes else [])
                       + ([f"SILENT since {a.silent_since}"] if a.silent_since is not None else []))
             for a in agents]
    return [f"  agents   {', '.join(counts)}", *_columns([[a.id, a.status, a.model, a.label, tail] for a, tail in zip(agents, tails)])]


def _waiting_lines(waiting: list[WaitingLine]) -> list[str]:
    table = [[d.ref, d.id, d.kind, f"for the {d.asks}",
              "  ".join([d.title] + (["blocks work"] if d.blocking else [])
                        + ([f"ANSWERED at {d.answered_at[11:16]}, not recorded"] if d.answered_at else [])
                        + ([f"held by the fleet: {d.held}"] if d.held is not None else []))]
             for d in waiting]
    return [f"  waiting  {len(waiting)}", *_columns(table)]


def render(v: FleetView) -> list[str]:
    identity = [
        f"{v.id}  ({v.role}, {v.status})",
        f"  session  {v.session or '(not named yet)'}" + (f", last active {v.active[:16].replace('T', ' ')}" if v.active else ""),
        f"  page     {v.url}",
        f"  ledger   {v.dir}",
        *([f"  now      {v.now}"] if v.now else []),
        *([] if v.chat["on"] else [f"  chat     not read now"
                                   + (f"; {v.chat['unread']} message(s) from the user wait since #{v.chat['seen']}" if v.chat["unread"] else "")]),
    ]
    sections = [
        *(_agent_lines(v.agents) if v.agents else []),
        *([f"  links    {len(v.links)}", *_columns([[link.ref, link.kind, link.url, link.title] for link in v.links])] if v.links else []),
        *(_waiting_lines(v.waiting) if v.waiting else []),
        *([f"  tokens   workers {token_count(v.spent[0])}; {v.role} {token_count(v.spent[1])} written, {token_count(v.spent[2])} read"]
          if v.spent else []),
    ]
    return [*identity, "", *sections] if sections else identity


def cmd_list() -> None:
    entries = live()
    if not entries:
        print("no fleet is being served on this machine")
        return
    print("\n\n".join("\n".join(render(fleet_view(e))) for e in entries))


def cmd_waiting() -> None:
    """What waits on the user, from every served fleet's ledger (the manager's own included): each open
    decision for the user that its fleet does not hold, with since when, and the answer the user sent
    that the fleet has not recorded yet. The one list: nothing else says what waits on the user."""
    import chat
    import decisions
    entries = live()
    if not entries:
        print("no fleet is being served on this machine")
        return
    found = 0
    for e in entries:
        state = _read(Path(e["dir"]) / "state.json") or {}
        decisions.number(state)
        said = chat.read(e["dir"])
        for d in state.get("decisions", []):
            if not isinstance(d, dict) or not isinstance(d.get("id"), str) or d.get("status") != "open" \
                    or (d.get("asks") or "user") != "user" or d.get("held"):
                continue
            found += 1
            marks = ", ".join([str(d.get("kind") or "decision")] + (["blocks work"] if d.get("blocking") is True else []))
            since = str(d.get("revised") or d.get("opened") or "")
            line = f"{e['id']} {d.get('ref') or d['id']} [{marks}] {chat._one_line(d.get('title'))}  since {since[:16].replace('T', ' ')}"
            at = _answered_at(d, said)
            if at:
                m = next(m for m in reversed(said) if m.get("decision") == d.get("id") and m["at"] == at)
                line += f"  ANSWERED at {at[11:16]} (#{m['id']}): {chat.first_line(m['text'])}; not recorded yet"
            print(line)
    if not found:
        print("nothing waits on the user")


def cmd_show(fleet: str) -> None:
    """What one fleet is doing, from its ledger alone: enough to answer "what is X doing" without asking X."""
    import chat
    entry = next((e for e in live() if e["id"] == fleet), None)
    if not entry:
        fail(f"no fleet '{fleet}' is being served; `fleet fleets list` names the ones that are")
    state = _read(Path(entry["dir"]) / "state.json") or {}
    import decisions
    decisions.number(state)
    rows = lambda key: [r for r in state.get(key, []) if isinstance(r, dict)]  # noqa: E731
    print(f"{fleet}  {state.get('status', 'unknown')}  {entry['url']}")
    print(f"    now: {state.get('now', '')}" + (f"  (said {state['now_at']})" if state.get("now_at") else ""))
    heard = chat.listening(entry["dir"])
    print(f"    chat: {'read' if heard['on'] else 'not read now'}" + (f"; {heard['unread']} from the user unread since #{heard['seen']}" if heard["unread"] else ""))
    silent = {w["id"]: w for w in silent_workers(entry["dir"], state)}
    for a in rows("agents"):
        if a.get("status") in ("running", "blocked", "queued"):
            print(f"    {a.get('id')} ({a.get('name')}) {a.get('status')} since {a.get('updated') or a.get('started')}: {a.get('task')}")
            if a.get("id") in silent:
                print(f"        silent since {silent[a['id']]['active'][11:16]}: check it before saying it runs")
            if a.get("report"):
                print(f"        last report: {str(a['report'])[:300]}")
    owners: dict[str, list[str]] = {}
    for a in rows("agents"):
        if a.get("status") in LIVE:
            for lane in lanes_of(a):
                owners.setdefault(lane, []).append(str(a.get("id")))
    for lane in sorted(owners):
        print(f"    lane {lane}  {', '.join(owners[lane])}")
    said = chat.read(entry["dir"])
    for d in rows("decisions"):
        if d.get("status") == "open":
            print(f"    decision {d.get('ref') or ''} {d.get('id')} [{d.get('asks') or 'user'}{', blocks work' if d.get('blocking') else ''}] {d.get('title')}: {d.get('question')}")
            if d.get("held"):
                print(f"        held by the fleet since {str(d.get('held_at'))[11:16]}: {d['held']}")
            at = _answered_at(d, said)
            if at:
                m = next(m for m in reversed(said) if m.get("decision") == d.get("id") and m["at"] == at)
                print(f"        ANSWERED by the user at {at[11:16]} (#{m['id']}): {m['text'][:200]}; not recorded yet")
    for r in rows("roadblocks"):
        if not r.get("resolved"):
            print(f"    roadblock {r.get('id')} [needs {r.get('needs')}] {r.get('title')}")
    for e in rows("events")[-8:]:
        print(f"    {e.get('at', '')[11:16]} {e.get('kind')} {e.get('agent') or ''} {e.get('text')}".replace("  ", " "))


def _gate_path() -> Path:
    return home() / "gate" / "gate.json"  # a directory of its own: live() treats every *.json here as a fleet


HOLD_MINUTES = 60  # how long a hold lasts when --for does not say: a dead holder frees the slot after this
GATE_USAGE = "usage: fleet fleets gate | gate take FLEET|--as NAME WHAT [--for MINUTES] [--wait SECONDS] | gate free TOKEN"


class _GateLock:
    """The gate's lock, REGISTRY/gate/gate.lock (the TypeScript fleet's too): a take, a release and a
    lapsed hold's removal never interleave."""

    def __enter__(self):
        _gate_path().parent.mkdir(parents=True, exist_ok=True)
        self.file = open(_gate_path().parent / "gate.lock", "a+")
        fcntl.flock(self.file, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        self.file.close()


def _live_hold(now: datetime) -> dict | None:
    """The hold in gate.json, or None when there is none or it has lapsed: at its until, or (a fleet's)
    when the fleet is no longer served."""
    held = _read(_gate_path())
    if not held:
        return None
    try:
        until = datetime.fromisoformat(held["until"]) if held.get("until") else None
    except (TypeError, ValueError):
        until = None
    if until is not None and now >= (until if until.tzinfo else until.replace(tzinfo=timezone.utc)):
        return None
    if held.get("kind") != "session" and not any(e["id"] == held.get("fleet") for e in live()):
        return None
    return held


def gate() -> dict | None:
    """Who holds the machine's gate slot (the one heavy check at a time: a test suite under load, a
    build), or None. A hold lapses at its until, and a fleet's when the fleet is no longer served; a
    lapsed hold is removed."""
    held = _live_hold(clock.now())
    if held is not None or not _gate_path().exists():
        return held
    with _GateLock():
        held = _live_hold(clock.now())
        if held is None:
            _gate_path().unlink(missing_ok=True)
        return held


def _held_text(held: dict) -> str:
    who = f"{held['fleet']} (no fleet)" if held.get("kind") == "session" else held["fleet"]
    until = f", until {held['until']}" if held.get("until") else ""
    return f"held by {who} since {held['since']}{until}: {held['what']}"


def _take(name: str, kind: str, what: str, minutes: int) -> tuple[dict | None, dict | None]:
    """(the hold made, None), or (None, the hold in the way): a take while held refuses, its own holder's too."""
    with _GateLock():
        now = clock.now()
        held = _live_hold(now)
        if held is not None:
            return None, held
        since = now.astimezone().isoformat(timespec="seconds")
        took = {"fleet": name, "kind": kind, "what": what, "since": since,
                "until": (now + timedelta(minutes=minutes)).astimezone().isoformat(timespec="seconds"),
                "token": hashlib.sha256(f"{name}\n{what}\n{since}".encode()).hexdigest()[:8]}
        scratch = _gate_path().with_suffix(".tmp")
        scratch.write_text(json.dumps(took))
        os.replace(scratch, _gate_path())
        return took, None


def _take_args(argv: list[str]) -> tuple[str, str, str, int, int] | None:
    """gate take's arguments, FLEET WHAT or --as NAME WHAT, then --for MINUTES, --wait SECONDS:
    (name, kind, what, minutes, wait), or None."""
    words, as_, minutes, wait = [], None, HOLD_MINUTES, 0
    i = 0
    while i < len(argv):
        if argv[i] in ("--as", "--for", "--wait"):
            if i + 1 >= len(argv):
                return None
            value = argv[i + 1]
            if argv[i] == "--as":
                as_ = value.strip()
            elif argv[i] == "--for":
                minutes = int(value) if re.fullmatch(r"[0-9]+", value) else 0
            else:
                wait = int(value) if re.fullmatch(r"[0-9]+", value) else -1
            i += 2
        else:
            words.append(argv[i])
            i += 1
    if minutes <= 0 or wait < 0 or as_ == "":
        return None
    if as_ is not None:
        return (as_, "session", words[0], minutes, wait) if len(words) == 1 else None
    return (words[0], "fleet", words[1], minutes, wait) if len(words) == 2 else None


def cmd_gate(argv: list[str]) -> None:
    """gate | gate take FLEET|--as NAME WHAT [--for MINUTES] [--wait SECONDS] | gate free TOKEN"""
    if not argv:
        held = gate()
        print(_held_text(held) if held else "free")
        return
    if argv[0] == "take":
        args = _take_args(argv[1:])
        if args is None:
            fail(GATE_USAGE)
        name, kind, what, minutes, wait = args
        if kind == "fleet" and not any(e["id"] == name for e in live()):
            fail(f"no fleet '{name}' is being served")
        deadline = time.monotonic() + wait
        took, held = _take(name, kind, what, minutes)
        while took is None and time.monotonic() < deadline:
            time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))
            took, held = _take(name, kind, what, minutes)
        if took is None:
            fail(f"{_held_text(held)}; take it when `fleet fleets gate` says free")
        print(f"{name} holds the gate: {what}")
        print(f"token {took['token']}, until {took['until']}: free it with `fleet fleets gate free {took['token']}`")
    elif argv[0] == "free" and len(argv) == 2:
        with _GateLock():
            held = _live_hold(clock.now())
            if held and argv[1] not in (held.get("token"), held.get("fleet")):
                fail(f"held by {held['fleet']}, not {argv[1]}")
            _gate_path().unlink(missing_ok=True)
        print("free")
    else:
        fail(GATE_USAGE)


def processes(root) -> list[dict]:
    """The background processes the session whose scratchpad holds DIR started and that still run:
    each writes its output into the session's tasks/ directory. Oldest first."""
    tasks = Path(root).resolve().parent.parent / "tasks"
    found, tick = [], os.sysconf("SC_CLK_TCK")
    try:
        boot = next(float(line.split()[1]) for line in open("/proc/stat") if line.startswith("btime"))
    except (OSError, StopIteration):
        return []
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            links = [os.readlink(f) for f in (proc / "fd").iterdir()]
        except OSError:
            continue
        if not any(link.startswith(str(tasks) + "/") for link in links):
            continue
        try:
            stat = (proc / "stat").read_text().rsplit(")", 1)[1].split()
            args = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
        except OSError:
            continue
        wrapped = re.search(r"eval '([^']*)'", args)  # the shell a session's Bash tool wraps a command in
        found.append({"pid": int(proc.name), "started": boot + int(stat[19]) / tick, "command": wrapped.group(1) if wrapped else args})
    return sorted(found, key=lambda x: x["started"])


def cmd_procs() -> None:
    now = datetime.now(timezone.utc).timestamp()
    for e in live():
        rows = processes(e["dir"])
        print(f"{e['id']}: {len(rows)} background process(es)")
        for r in rows:
            hours = (now - r["started"]) / 3600
            print(f"    {r['pid']}  {hours:.1f} h  {r['command'][:160]}")


def cmd_whose(argv: list[str]) -> None:
    """whose FROM TO: the files a landing moves (jj diff in the working directory), by the fleet that
    owns them, from the manager's DIR/owners: one `FLEET GLOB` per line, the first match wins."""
    import fnmatch
    import subprocess
    if len(argv) != 2:
        fail("usage: fleet fleets whose FROM TO   (run in the repository; owners from the manager's DIR/owners)")
    found = manager()
    owners_file = Path(found["dir"]) / "owners" if found else None
    if not owners_file or not owners_file.exists():
        fail("no owners file: the manager writes DIR/owners, one `FLEET GLOB` per line (`infra servers/case-analysis/**`)")
    rules = [line.split(None, 1) for line in owners_file.read_text().splitlines() if line.strip() and not line.startswith("#")]
    diff = subprocess.run(["jj", "diff", "--from", argv[0], "--to", argv[1], "--summary"], capture_output=True, text=True)
    if diff.returncode:
        fail(diff.stderr.strip() or "jj diff failed")
    by: dict[str, list[str]] = {}
    for line in diff.stdout.splitlines():
        path = line.split(None, 1)[-1].strip()
        owner = next((fleet for fleet, glob in rules if fnmatch.fnmatch(path, glob.strip())), "unowned")
        by.setdefault(owner, []).append(path)
    for owner, paths in sorted(by.items()):
        print(f"{owner}: {len(paths)} file(s)")
        for path in paths:
            print(f"    {path}")


def cmd_manager() -> None:
    found = manager()
    if not found:
        fail("no manager is being served on this machine")
    print(f"manager  session {found.get('session') or '(not named yet)'}  {found['url']}  {found['dir']}")
    print(f"    what holds for every fleet: {Path(found['dir']) / 'standing.md'}")


def cmd_decision(fleet: str, id_: str) -> None:
    entry = next((e for e in live() if e["id"] == fleet), None)
    if not entry:
        fail(f"no fleet '{fleet}' is being served; `fleet fleets list` names the ones that are")
    rows = (_read(Path(entry["dir"]) / "state.json") or {}).get("decisions", [])
    import decisions
    d = decisions.find({"decisions": [r for r in rows if isinstance(r, dict)]}, id_)
    if not d:
        fail(f"no decision '{id_}' in {fleet}")
    open_ = d.get("status") == "open"
    marks = [str(d.get("kind", "decision")), ("for the manager" if d.get("asks") == "manager" else "for the user") if open_ else str(d.get("status"))]
    print(f"{fleet} {id_} [{', '.join(marks + (['blocks work'] if open_ and d.get('blocking') else []))}] {d.get('title')}")
    print(f"    question: {d.get('question')}")
    for key in ("why", "secret", "manual", "change", "answer", "resolution"):
        if d.get(key):
            print(f"    {key}: {d[key]}")
    for o in d.get("options") or []:
        print(f"    {o.get('id')}: {o.get('label')} | {o.get('consequence')}")
    if d.get("recommend"):
        print(f"    recommended: {d['recommend']}" + (f", {d['reason']}" if d.get("reason") else ""))
    if d.get("agent"):
        print(f"    waits: {d['agent']}")
    import chat
    for m in chat.read(entry["dir"]):
        if m.get("decision") == d.get("id") and m["from"] == "user":
            print(f"    the user answered #{m['id']} at {m['at'][11:16]}: {m['text'][:200]}")
    if d.get("body"):
        print(f"    evidence: {Path(entry['dir']) / 'decisions' / (d['id'] + '.html')}")
    print(f"    page: {entry['url']}#decision/{d['id']}")  # the page finds a decision by its id, not its number


APPROVAL_USAGE = ("usage: fleet fleets approval add --all|--fleets A,B --rule R --ref FLEET/DECISION[:Q<n>] [--by WHO]"
                  " | approval revoke --ref FLEET/DECISION[:Q<n>] --reason R [--fleets A,B]")


def _approval_args(argv: list[str]) -> dict | None:
    """`approval add|revoke` and its flags, or None when they do not read."""
    if not argv or argv[0] not in ("add", "revoke"):
        return None
    given: dict = {"action": argv[0], "all": False}
    i = 1
    while i < len(argv):
        if argv[i] == "--all":
            given["all"] = True
            i += 1
        elif argv[i] in ("--fleets", "--rule", "--ref", "--by", "--reason") and i + 1 < len(argv):
            given[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            return None
    return given


def _targets(names: str | None) -> list[dict]:
    """The served fleets an approval goes to: every one, or those `names` lists (ids or aliases, comma-separated)."""
    entries = live()
    if names is None:
        return entries
    found = []
    for n in dict.fromkeys(x.strip() for x in names.split(",") if x.strip()):
        e = next((e for e in entries if e["id"] == n), None) or \
            next((e for e in entries if isinstance(e.get("aliases"), list) and n in e["aliases"]), None)
        if e is None:
            fail(f"no fleet '{n}' is being served; `fleet fleets list` names the ones that are")
        if e not in found:
            found.append(e)
    if not found:
        fail("--fleets names no fleet: --fleets A,B")
    return found


def _known_fleet(entries: list[dict], name: str) -> dict | None:
    """The fleet the registry knows by `name` (its id, else an alias), served or not."""
    return next((e for e in entries if e["id"] == name), None) or \
        next((e for e in entries if isinstance(e.get("aliases"), list) and name in e["aliases"]), None)


def _revoke_targets(names: str | None) -> list[dict]:
    """The fleets a revoke reaches: every fleet the registry knows whose DIR is there, served or stopped
    (known()), or those `names` lists."""
    entries = known()
    if names is None:
        return [e for e in entries if Path(e["dir"]).is_dir()]
    found = []
    for n in dict.fromkeys(x.strip() for x in names.split(",") if x.strip()):
        e = _known_fleet(entries, n)
        if e is None:
            fail(f"no fleet '{n}' is known to the registry; `fleet fleets list` names the ones served")
        if e not in found:
            found.append(e)
    if not found:
        fail("--fleets names no fleet: --fleets A,B")
    return found


def _state(root: str, *argv: str) -> tuple[bool, str]:
    """Run one state command on the fleet at `root` (rendering its page quietly): whether it took, and its refusal."""
    import subprocess
    done = subprocess.run([sys.executable, str(Path(__file__).resolve().parent / "state.py"), root, *argv, "-q"],
                          capture_output=True, text=True)
    said = [x for x in done.stderr.splitlines() if x.strip()]
    return done.returncode == 0, (said[-1].removeprefix("state: ") if said else f"exit {done.returncode}")


def cmd_approval(argv: list[str]) -> None:
    """`approval add` the same standing approval to every served fleet (or those listed), or `approval revoke`
    it everywhere: one line per fleet; exit 1 when a fleet refused."""
    import decisions
    given = _approval_args(argv)
    if given is None:
        fail(APPROVAL_USAGE)
    ref = given.get("ref")
    parsed = decisions.SOURCE.fullmatch(ref or "")
    if not parsed or parsed[1] is None:
        fail("--ref names the decision and the fleet whose ledger holds it: FLEET/DECISION[:Q<n>] (manager/G5:Q1)")
    question = f"q{int(parsed[3])}" if parsed[3] else None
    refused = False
    if given["action"] == "add":
        if not given["all"] and given.get("fleets") is None:
            fail("approval add goes to every served fleet (--all) or to those named (--fleets A,B)")
        if not (given.get("rule") or "").strip():
            fail("approval add needs --rule: what the approval covers, in the user's words")
        src = decisions.approval_source(None, None, ref)
        if isinstance(src, str):
            fail(src)
        by = (given.get("by") or "").strip() or src["author"] or "user"
        for e in _targets(given.get("fleets")):
            state = _read(Path(e["dir"]) / "state.json")
            if state is None:
                print(f"{e['id']}: refused, no ledger at {Path(e['dir']) / 'state.json'}")
                refused = True
                continue
            local = src["id"] if Path(e["dir"]).resolve() == Path(src["dir"]).resolve() else None
            rows = [a for a in state.get("approvals") or [] if isinstance(a, dict)]
            had = next((a for a in rows if decisions.same_source(a, src["ref"], question, local)), None)
            if had:
                print(f"{e['id']}: skipped, {had.get('id')} already comes from {src['label']} ({had.get('status')})")
                continue
            k = "K" + str(max((int(a["id"][1:]) for a in rows if re.fullmatch(r"K[0-9]+", str(a.get("id")))), default=0) + 1)
            took, why = _state(e["dir"], "approval", "add", k, "--rule", given["rule"], "--by", by, "--ref", ref)
            raced = None if took else next((a for a in ((_read(Path(e["dir"]) / "state.json") or {}).get("approvals") or [])
                                            if isinstance(a, dict) and decisions.same_source(a, src["ref"], question, local)), None)
            if raced:
                print(f"{e['id']}: skipped, {raced.get('id')} already comes from {src['label']} ({raced.get('status')})")
            else:
                print(f"{e['id']}: added {k}" if took else f"{e['id']}: refused, {why}")
            refused = refused or (not took and raced is None)
    else:
        if not (given.get("reason") or "").strip():
            fail("approval revoke needs --reason: why, or where the user said it (\"revoked on the page (#21)\")")
        if given.get("rule") or given.get("by"):
            fail(APPROVAL_USAGE)
        reached = _revoke_targets(given.get("fleets"))
        source = _known_fleet(known(), parsed[1])
        state = _read(Path(source["dir"]) / "state.json") if source else None
        d = decisions.find(state, parsed[2]) if isinstance(state, dict) and isinstance(state.get("decisions"), list) else None
        refs = {f"{parsed[1]}/{parsed[2]}"} | ({f"{source['id']}/{d.get('ref') or d['id']}"} if d else set())
        label = (f"{source['id']}/{d.get('ref') or d['id']}" if d else f"{parsed[1]}/{parsed[2]}") + (f":{question.upper()}" if question else "")
        unreached = []
        for e in reached:
            state = _read(Path(e["dir"]) / "state.json")
            if state is None:
                print(f"{e['id']}: not reached, no ledger at {Path(e['dir']) / 'state.json'}")
                unreached.append(e["id"])
                continue
            rows = [a for a in state.get("approvals") or [] if isinstance(a, dict)]
            local = d["id"] if d and Path(e["dir"]).resolve() == Path(source["dir"]).resolve() else None
            mine = [a for a in rows if a.get("status") == "active" and any(decisions.same_source(a, r, question, local) for r in refs)]
            if not mine:
                print(f"{e['id']}: none active from {label}")
            for a in mine:
                took, why = _state(e["dir"], "approval", "revoke", str(a["id"]), "--reason", given["reason"])
                print(f"{e['id']}: revoked {a['id']}" if took else f"{e['id']}: not reached, {why}")
                if not took and e["id"] not in unreached:
                    unreached.append(e["id"])
        if unreached:
            sys.stdout.flush()
            print(f"fleets: not reached: {', '.join(unreached)}; the approval is still active there", file=sys.stderr)
            refused = True
    if refused:
        sys.exit(1)


def main(argv: list[str]) -> None:
    if argv == ["list"]:
        cmd_list()
    elif argv == ["manager"]:
        cmd_manager()
    elif argv == ["waiting"]:
        cmd_waiting()
    elif argv and argv[0] == "gate":
        cmd_gate(argv[1:])
    elif argv == ["procs"]:
        cmd_procs()
    elif argv and argv[0] == "whose":
        cmd_whose(argv[1:])
    elif len(argv) == 2 and argv[0] == "show":
        cmd_show(argv[1])
    elif len(argv) == 3 and argv[0] == "decision":
        cmd_decision(argv[1], argv[2])
    elif argv and argv[0] == "approval":
        cmd_approval(argv[1:])
    elif len(argv) == 3 and argv[0] == "name":
        entry = name(argv[1], argv[2])
        if isinstance(entry, str):
            fail(entry)
        print(f"this fleet is {entry['id']}, the session {entry['session']}: use that one name everywhere")
    else:
        fail("usage: fleet fleets list | waiting | show FLEET | manager | decision FLEET ID | name DIR SESSION | gate [take FLEET|--as NAME WHAT | free TOKEN] | procs | whose FROM TO | approval add|revoke ...")


if __name__ == "__main__":
    main(sys.argv[1:])
