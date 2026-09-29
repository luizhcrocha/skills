#!/usr/bin/env python3
"""The fleets being served on this machine: how a manager finds the coordinators, and they it.

    fleets.py list              every live fleet: its name, role, session, status, address, directory,
                                what it is doing, and the decisions open in it
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
whose server died is forgotten the next time anyone looks. A fleet is known by one name: its
project's (`acme-billing`) until `name` gives it its session's, which the manager's chat mentions it by. The registry is
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


def title_of(root) -> str | None:
    """The title the session whose scratchpad holds DIR goes by (its /rename), or None when it has none."""
    import spend
    transcript = spend.transcript_of(root)
    value = _read(transcript.with_suffix("") / "custom-title.json") if transcript else None
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
            path.unlink(missing_ok=True)
    for i, entry in enumerate(entries):
        title = title_of(entry["dir"])
        if not title or title == entry.get("session"):
            continue
        new = entry["id"] if entry["role"] == "manager" else slug(title)
        if not new or new in KEPT and entry["role"] != "manager" or any(e["id"] == new for e in entries if e is not entry):
            new = entry["id"]
        if new != entry["id"]:
            (home() / f"{entry['id']}.json").unlink(missing_ok=True)
        entries[i] = _write({**entry, "id": new, "session": title})
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
    title = title_of(root)
    if title and role != "manager" and slug(title) and slug(title) not in KEPT and slug(title) not in {e["id"] for e in others}:
        name = slug(title)
    elif known:
        name = known["id"]
    else:
        base = "manager" if role == "manager" else slug(str((state or {}).get("project") or root.parent.name)) or "fleet"
        if role != "manager" and base in KEPT:
            base += "-fleet"
        taken, name, n = {e["id"] for e in others}, base, 1
        while name in taken:
            n += 1
            name = f"{base}-{n}"
    if known and known["id"] != name:
        (home() / f"{known['id']}.json").unlink(missing_ok=True)
    return _write({"id": name, "role": role, "dir": str(root), "url": url, "pid": pid,
                   "session": title or (known.get("session") if known else None),
                   "since": known["since"] if known else datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")})


def unregister(root) -> None:
    root = str(Path(root).resolve())
    for path in home().glob("*.json"):
        if (_read(path) or {}).get("dir") == root:
            path.unlink(missing_ok=True)


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", text).strip("-.").lower()


def name(root, session: str) -> dict | str:
    """Give the fleet served from DIR its one name: the session's, which becomes its name in the
    registry, on the manager's page and in the manager's chat too. The entry, or why not."""
    entry = find(root)
    if not entry:
        return f"{root} is not being served; start it with serve_dashboard.py first"
    new = "manager" if entry["role"] == "manager" else slug(session)  # the manager's chat host keeps its name
    if not new or (new in KEPT and entry["role"] != "manager"):
        return f"'{session}' cannot name a fleet; the chat keeps {sorted(KEPT)} for itself"
    if any(e["id"] == new for e in live() if e["dir"] != entry["dir"]):
        return f"another fleet is already called '{new}'; pick another session name"
    if new != entry["id"]:
        (home() / f"{entry['id']}.json").unlink(missing_ok=True)
    return _write({**entry, "id": new, "session": session})


def manager() -> dict | None:
    return next((e for e in live() if e["role"] == "manager"), None)


def summary(entry: dict) -> dict:
    """A fleet as the manager's page and the manager read it: who it is, what it is doing, what waits
    in it, what its workers and its coordinator spent."""
    import chat, spend  # here, not above: a status line's capture loads this module and needs neither
    state = _read(Path(entry["dir"]) / "state.json")
    rows = lambda key: [r for r in (state or {}).get(key, []) if isinstance(r, dict)]  # noqa: E731
    workers: dict[str, int] = {}
    for a in rows("agents"):
        workers[str(a.get("status"))] = workers.get(str(a.get("status")), 0) + 1
    running = [a for a in rows("agents") if a.get("status") in ("running", "blocked", "queued")]
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
        "decisions": [{"id": d.get("id"), "kind": d.get("kind", "decision"), "title": d.get("title"), "question": d.get("question"),
                       "why": d.get("why"), "blocking": d.get("blocking") is True, "asks": d.get("asks") or "user",
                       "opened": d.get("opened"), "revised": d.get("revised")}
                      for d in rows("decisions") if d.get("status") == "open" and isinstance(d.get("id"), str)],
    }


def view(state: dict, root) -> dict:
    """The state as the page shows it: a manager's with every coordinator being served and the plan's
    usage as the status line last saw it, a coordinator's with how to reach its manager when there
    is one. The state itself is left as it is."""
    import chat, spend
    root = str(Path(root).resolve())
    state = {**state, "spent": spend.of(root), "chat": chat.listening(root)}
    if role_of(state) == "manager":
        import usage  # here, not above: usage.py reads the registry's place from this module
        return {**state, "coordinators": [summary(e) for e in live() if e["role"] != "manager" and e["dir"] != root],
                "usage": usage.read(), "gate": gate()}
    found = manager()
    return {**state, "manager": {"id": found["id"], "url": found["url"], "session": found.get("session")}} if found else state


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
        if not s["chat"]["on"]:
            print(f"    chat: not read now" + (f"; {s['chat']['unread']} message(s) from the user wait since #{s['chat']['seen']}" if s["chat"]["unread"] else ""))
        if s["spent"]:
            print(f"    tokens: its workers {s['tokens']:,}; the {e['role']} itself {s['spent']['output']:,} written, {s['spent']['input']:,} read")
        for d in s["decisions"]:
            marks = ", ".join(filter(None, [d["kind"], "for the manager" if d["asks"] == "manager" else "for the user", "blocks work" if d["blocking"] else ""]))
            print(f"    {d['id']} [{marks}] {d['title']}")


def cmd_show(fleet: str) -> None:
    """What one fleet is doing, from its ledger alone: enough to answer "what is X doing" without asking X."""
    import chat
    entry = next((e for e in live() if e["id"] == fleet), None)
    if not entry:
        fail(f"no fleet '{fleet}' is being served; `fleets.py list` names the ones that are")
    state = _read(Path(entry["dir"]) / "state.json") or {}
    rows = lambda key: [r for r in state.get(key, []) if isinstance(r, dict)]  # noqa: E731
    print(f"{fleet}  {state.get('status', 'unknown')}  {entry['url']}")
    print(f"    now: {state.get('now', '')}" + (f"  (said {state['now_at']})" if state.get("now_at") else ""))
    heard = chat.listening(entry["dir"])
    print(f"    chat: {'read' if heard['on'] else 'not read now'}" + (f"; {heard['unread']} from the user unread since #{heard['seen']}" if heard["unread"] else ""))
    for a in rows("agents"):
        if a.get("status") in ("running", "blocked", "queued"):
            print(f"    {a.get('id')} ({a.get('name')}) {a.get('status')} since {a.get('updated') or a.get('started')}: {a.get('task')}")
            if a.get("report"):
                print(f"        last report: {str(a['report'])[:300]}")
    for d in rows("decisions"):
        if d.get("status") == "open":
            print(f"    decision {d.get('id')} [{d.get('asks') or 'user'}{', blocks work' if d.get('blocking') else ''}] {d.get('title')}: {d.get('question')}")
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
            fail(f"held by {held['fleet']} since {held['since']}: {held['what']}; take it when `fleets.py gate` says free")
        if not any(e["id"] == argv[1] for e in live()):
            fail(f"no fleet '{argv[1]}' is being served")
        _gate_path().parent.mkdir(parents=True, exist_ok=True)
        _gate_path().write_text(json.dumps({"fleet": argv[1], "what": argv[2], "since": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")}))
        print(f"{argv[1]} holds the gate: {argv[2]}")
    elif argv[0] == "free" and len(argv) == 2:
        if held and held["fleet"] != argv[1]:
            fail(f"held by {held['fleet']}, not {argv[1]}")
        _gate_path().unlink(missing_ok=True)
        print("free")
    else:
        fail("usage: fleets.py gate | gate take FLEET WHAT | gate free FLEET")


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
        fail("usage: fleets.py whose FROM TO   (run in the repository; owners from the manager's DIR/owners)")
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
        fail("usage: fleets.py list | show FLEET | manager | decision FLEET ID | name DIR SESSION | gate [take FLEET WHAT | free FLEET] | procs | whose FROM TO")


if __name__ == "__main__":
    main(sys.argv[1:])
