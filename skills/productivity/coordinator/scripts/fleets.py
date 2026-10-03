#!/usr/bin/env python3
"""The fleets being served on this machine: how a manager finds the coordinators, and they it.

    fleets.py list              every live fleet: its name, role, session, status, address, directory,
                                what it is doing, and the decisions open in it
    fleets.py waiting           what waits on the user, from every fleet's ledger: each open decision
                                for the user, since when, and an answer sent but not recorded yet
    fleets.py show FLEET        what one fleet is doing, from its ledger: now-line, live workers and
                                their last report, open decisions and roadblocks, latest events
    fleets.py manager           how to reach the manager; exits 1 when there is none
    fleets.py decision FLEET ID what a fleet asks, in full: the question, why, the options, the
                                recommendation, where its evidence and its page are
    fleets.py gate [take FLEET WHAT | free FLEET]
                                the machine's one gate slot: a heavy check (a test suite, a build)
                                runs only while its fleet holds it
    fleets.py procs             the background processes each fleet's session started, with their age
    fleets.py whose FROM TO     the files a landing moves, by owning fleet (the manager's DIR/owners)
    fleets.py name DIR SESSION  give the fleet its one name: the session's, which the registry, the
                                manager's page and chat, and SendMessage all use from then on

serve_dashboard.py registers a fleet when it starts serving DIR and forgets it on --stop; a fleet
whose server died is forgotten the next time anyone looks, its last entry kept under names/ until its
DIR, or its session (`claude respawn`: a new pid, the same session id), is served again and takes the
name back. A fleet is known by one name: its
project's (`acme-billing`) until `name` gives it its session's, which the manager's chat mentions it by. The registry is
$FLEET_HOME, or fleet-board under $XDG_STATE_HOME (~/.local/state).
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
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
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", session_id):
        return None
    projects = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
    try:
        found = sorted(p / session_id for p in projects.iterdir())
    except OSError:
        return None
    return next((f for f in found if f.is_dir()), None)


def title_of(root, session_id=None) -> str | None:
    """The title (its /rename) the session whose scratchpad holds DIR goes by, else session SESSION_ID's,
    or None when it has none."""
    import spend
    transcript = spend.transcript_of(root)
    folder = transcript.with_suffix("") if transcript else _session_folder(session_id)
    value = _read(folder / "custom-title.json") if folder else None
    title = (value or {}).get("customTitle")
    return title.strip() if isinstance(title, str) and title.strip() else None


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
        "spent": spend.of(entry["dir"]), "chat": chat.listening(entry["dir"]), "active": spend.active(entry["dir"]),
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
    root = str(Path(root).resolve())
    state = copy.deepcopy(state)
    decisions.number(state)  # the numbers state.py gives on its next write, the same ones: the order is the ledger's
    state = {**state, "spent": spend.of(root), "chat": chat.listening(root)}
    seen = spend.last_activity(root)
    state["agents"] = [{**a, "active": _iso(seen[a["id"]])} if isinstance(a, dict) and a.get("id") in seen else a
                       for a in state.get("agents", [])]
    me = find(root)
    links = [{**link, "fleet": me["id"] if me else None} for link in served.links_of(state)]
    if role_of(state) == "manager":
        import usage  # here, not above: usage.py reads the registry's place from this module
        others = [e for e in live() if e["role"] != "manager" and e["dir"] != root]
        for e in others:
            theirs = _read(Path(e["dir"]) / "state.json") or {}
            decisions.number(theirs)
            links += [{**link, "fleet": e["id"]} for link in served.links_of(theirs)]
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


def cmd_list() -> None:
    entries = live()
    if not entries:
        print("no fleet is being served on this machine")
    for e in entries:
        s = summary(e)
        print(f"{s['id']}  {e['role']}  session {s['session'] or '(not named yet)'}  {s['status']}  {s['url']}  {s['dir']}")
        if s["now"]:
            print(f"    now: {s['now']}")
        if s["lanes"]:
            print(f"    lanes in flight: {', '.join(s['lanes'])}")
        if s["active"]:
            print(f"    session last active {s['active']}")
        for w in s["silent"]:
            print(f"    worker {w['id']} ({w['name']}) silent since {w['active'][11:16]}")
        if not s["chat"]["on"]:
            print(f"    chat: not read now" + (f"; {s['chat']['unread']} message(s) from the user wait since #{s['chat']['seen']}" if s["chat"]["unread"] else ""))
        if s["spent"]:
            print(f"    tokens: its workers {s['tokens']:,}; the {e['role']} itself {s['spent']['output']:,} written, {s['spent']['input']:,} read")
        for d in s["decisions"]:
            marks = ", ".join(filter(None, [d["kind"], "for the manager" if d["asks"] == "manager" else "for the user", "blocks work" if d["blocking"] else ""]))
            print(f"    {d.get('ref') or ''} {d['id']} [{marks}] {d['title']}".replace("     ", "    ")
                  + (f"  ANSWERED at {d['answered'][11:16]}, not recorded" if d.get("answered") else "")
                  + (f"  held by the fleet: {d['held']}" if d.get("held") else ""))


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


def gate() -> dict | None:
    """Who holds the machine's gate slot (the one heavy check at a time: a test suite under load, a
    build), or None. A hold whose fleet is no longer served is forgotten."""
    held = _read(_gate_path())
    if held and any(e["id"] == held.get("fleet") for e in live()):
        return held
    _gate_path().unlink(missing_ok=True)
    return None


def cmd_gate(argv: list[str]) -> None:
    """gate | gate take FLEET WHAT | gate free FLEET"""
    held = gate()
    if not argv:
        print(f"held by {held['fleet']} since {held['since']}: {held['what']}" if held else "free")
        return
    if argv[0] == "take" and len(argv) == 3:
        if held and held["fleet"] != argv[1]:
            fail(f"held by {held['fleet']} since {held['since']}: {held['what']}; take it when `fleet fleets gate` says free")
        if not any(e["id"] == argv[1] for e in live()):
            fail(f"no fleet '{argv[1]}' is being served")
        _gate_path().parent.mkdir(parents=True, exist_ok=True)
        _gate_path().write_text(json.dumps({"fleet": argv[1], "what": argv[2], "since": clock.stamp()}))
        print(f"{argv[1]} holds the gate: {argv[2]}")
    elif argv[0] == "free" and len(argv) == 2:
        if held and held["fleet"] != argv[1]:
            fail(f"held by {held['fleet']}, not {argv[1]}")
        _gate_path().unlink(missing_ok=True)
        print("free")
    else:
        fail("usage: fleet fleets gate | gate take FLEET WHAT | gate free FLEET")


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
    elif len(argv) == 3 and argv[0] == "name":
        entry = name(argv[1], argv[2])
        if isinstance(entry, str):
            fail(entry)
        print(f"this fleet is {entry['id']}, the session {entry['session']}: use that one name everywhere")
    else:
        fail("usage: fleet fleets list | waiting | show FLEET | manager | decision FLEET ID | name DIR SESSION | gate [take FLEET WHAT | free FLEET] | procs | whose FROM TO")


if __name__ == "__main__":
    main(sys.argv[1:])
