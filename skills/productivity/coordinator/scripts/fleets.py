#!/usr/bin/env python3
"""The fleets being served on this machine: how a manager finds the coordinators, and they it.

    fleets.py list              every live fleet: its name, role, session, status, address, directory,
                                what it is doing, and the decisions open in it
    fleets.py manager           how to reach the manager; exits 1 when there is none
    fleets.py decision FLEET ID what a fleet asks, in full: the question, why, the options, the
                                recommendation, where its evidence and its page are
    fleets.py name DIR SESSION  record the session name other sessions message this fleet by

serve_dashboard.py registers a fleet when it starts serving DIR and forgets it on --stop; a fleet
whose server died is forgotten the next time anyone looks. A fleet is known by a name made from its
project (`acme-billing`), which is also the name the manager's chat mentions it by. The registry is
$FLEET_HOME, or fleet-board under $XDG_STATE_HOME (~/.local/state).
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

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


def live() -> list[dict]:
    """The fleets whose server is running, oldest first. One whose server died is forgotten here."""
    entries = []
    for path in sorted(home().glob("*.json")):
        entry = _read(path)
        if entry and _alive(entry.get("pid")) and isinstance(entry.get("dir"), str) and isinstance(entry.get("id"), str):
            entries.append(entry)
        else:
            path.unlink(missing_ok=True)
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


def register(root, url: str, pid: int) -> dict:
    """Record that DIR is served at `url` by process `pid`, and return the entry. A fleet that
    registers again keeps its name and its session."""
    root = Path(root).resolve()
    state = _read(root / "state.json")
    # The fleet's own entry is read before the dead are forgotten: on a restart its server is the dead one.
    known = next((e for e in map(_read, sorted(home().glob("*.json"))) if e and e.get("dir") == str(root) and e.get("id")), None)
    role, others = role_of(state), [e for e in live() if e["dir"] != str(root)]
    if known:
        name = known["id"]
    else:
        base = "manager" if role == "manager" else re.sub(r"[^A-Za-z0-9_.-]+", "-", str((state or {}).get("project") or root.parent.name)).strip("-.").lower() or "fleet"
        if role != "manager" and base in KEPT:
            base += "-fleet"
        taken, name, n = {e["id"] for e in others}, base, 1
        while name in taken:
            n += 1
            name = f"{base}-{n}"
    return _write({"id": name, "role": role, "dir": str(root), "url": url, "pid": pid,
                   "session": known.get("session") if known else None,
                   "since": known["since"] if known else datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")})


def unregister(root) -> None:
    root = str(Path(root).resolve())
    for path in home().glob("*.json"):
        if (_read(path) or {}).get("dir") == root:
            path.unlink(missing_ok=True)


def name(root, session: str) -> dict | None:
    """Record the session name of the fleet served from DIR; None when DIR is not being served."""
    entry = find(root)
    return _write({**entry, "session": session}) if entry else None


def manager() -> dict | None:
    return next((e for e in live() if e["role"] == "manager"), None)


def summary(entry: dict) -> dict:
    """A fleet as the manager's page and the manager read it: who it is, what it is doing, what waits in it."""
    state = _read(Path(entry["dir"]) / "state.json")
    rows = lambda key: [r for r in (state or {}).get(key, []) if isinstance(r, dict)]  # noqa: E731
    workers: dict[str, int] = {}
    for a in rows("agents"):
        workers[str(a.get("status"))] = workers.get(str(a.get("status")), 0) + 1
    running = [a for a in rows("agents") if a.get("status") in ("running", "blocked", "queued")]
    return {
        "id": entry["id"], "url": entry["url"], "session": entry.get("session"), "dir": entry["dir"],
        "name": str((state or {}).get("project") or entry["id"]), "goal": str((state or {}).get("goal") or ""),
        "status": str(state["status"]) if state and state.get("status") else "unknown",
        "now": str((state or {}).get("now") or ""), "updated": (state or {}).get("updated"),
        "workers": workers, "tokens": sum(int(a.get("tokens") or 0) for a in rows("agents")),
        "lanes": sorted({str(lane) for a in running for lane in a.get("lane") or []}),
        "roadblocks": sum(1 for r in rows("roadblocks") if not r.get("resolved")),
        "decisions": [{"id": d.get("id"), "kind": d.get("kind", "decision"), "title": d.get("title"), "question": d.get("question"),
                       "why": d.get("why"), "blocking": d.get("blocking") is True, "asks": d.get("asks") or "user",
                       "opened": d.get("opened"), "revised": d.get("revised")}
                      for d in rows("decisions") if d.get("status") == "open" and isinstance(d.get("id"), str)],
    }


def view(state: dict, root) -> dict:
    """The state as the page shows it: a manager's with every coordinator being served and the plan's
    usage as the status line last saw it, a coordinator's with how to reach its manager when there
    is one. The state itself is left as it is."""
    root = str(Path(root).resolve())
    if role_of(state) == "manager":
        import usage  # here, not above: usage.py reads the registry's place from this module
        return {**state, "coordinators": [summary(e) for e in live() if e["role"] != "manager" and e["dir"] != root],
                "usage": usage.read()}
    found = manager()
    return {**state, "manager": {"id": found["id"], "url": found["url"], "session": found.get("session")}} if found else dict(state)


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
        for d in s["decisions"]:
            marks = ", ".join(filter(None, [d["kind"], "for the manager" if d["asks"] == "manager" else "for the user", "blocks work" if d["blocking"] else ""]))
            print(f"    {d['id']} [{marks}] {d['title']}")


def cmd_manager() -> None:
    found = manager()
    if not found:
        fail("no manager is being served on this machine")
    print(f"manager  session {found.get('session') or '(not named yet)'}  {found['url']}  {found['dir']}")
    print(f"    what holds for every fleet: {Path(found['dir']) / 'standing.md'}")


def cmd_decision(fleet: str, id_: str) -> None:
    entry = next((e for e in live() if e["id"] == fleet), None)
    if not entry:
        fail(f"no fleet '{fleet}' is being served; `fleets.py list` names the ones that are")
    rows = (_read(Path(entry["dir"]) / "state.json") or {}).get("decisions", [])
    d = next((r for r in rows if isinstance(r, dict) and r.get("id") == id_), None)
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
    if d.get("body"):
        print(f"    evidence: {Path(entry['dir']) / 'decisions' / (id_ + '.html')}")
    print(f"    page: {entry['url']}#decision/{id_}")


def main(argv: list[str]) -> None:
    if argv == ["list"]:
        cmd_list()
    elif argv == ["manager"]:
        cmd_manager()
    elif len(argv) == 3 and argv[0] == "decision":
        cmd_decision(argv[1], argv[2])
    elif len(argv) == 3 and argv[0] == "name":
        if name(argv[1], argv[2]) is None:
            fail(f"{argv[1]} is not being served; start it with serve_dashboard.py first")
        print(f"this fleet's session is {argv[2]}")
    else:
        fail("usage: fleets.py list | manager | decision FLEET ID | name DIR SESSION")


if __name__ == "__main__":
    main(sys.argv[1:])
