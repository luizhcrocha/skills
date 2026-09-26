#!/usr/bin/env python3
"""Record fleet events in the dashboard state and re-render, one command per event.

    state.py DIR init --project P --goal G [--now TEXT]
    state.py DIR set [--status S] [--now TEXT] [--goal G]
    state.py DIR milestone ID --title T
    state.py DIR step ID [--milestone M --title T] [--status S] [--agent A]
    state.py DIR agent ID [--task T --skill S --model M --lane L... --milestone M]
                          [--status S] [--tokens N] [--duration-ms N] [--report R]
                          [--brief B] [--name N] [--step STEP] [--log TEXT] [--important]
    state.py DIR roadblock ID [--title T --detail D --severity S --needs N] [--agent A]
                              [--resolved | --open]
    state.py DIR event [--agent A] [--kind K] [--important] TEXT
    state.py DIR show

Add --no-render anywhere to write state.json without rendering.

DIR holds state.json and the rendered index.html. Creating and updating use
the same verb: an unknown ID with the required fields creates the row, a
known ID updates only the fields given. Every command stamps timestamps,
validates the result, and renders index.html.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_dashboard  # noqa: E402

STATUSES = sorted(render_dashboard.STATUSES)
AGENT_STATUSES = sorted(render_dashboard.AGENT_STATUSES)
STEP_STATUSES = sorted(render_dashboard.STEP_STATUSES)
SKILLS = ["implement", "diagnosing-bugs", "prototype", "research", "tdd", "none"]
MODELS = ["opus", "sonnet", "haiku", "fable"]
SEVERITIES = ["warning", "serious", "critical"]
NEEDS = ["user", "coordinator", "worker"]
KINDS = ["spawned", "reported", "blocked", "resolved", "decision", "note", "integrated"]


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def fail(msg: str) -> None:
    sys.stderr.write(f"state: {msg}\n")
    sys.exit(1)


def find(rows: list, id_: str):
    return next((r for r in rows if r["id"] == id_), None)


def require(args, fields: list[str], what: str) -> None:
    missing = [f for f in fields if getattr(args, f.replace("-", "_")) is None]
    if missing:
        fail(f"new {what} needs --{' --'.join(missing)}")


def log(state: dict, kind: str, text: str, agent: str | None = None, important: bool = False) -> None:
    event = {"at": now(), "agent": agent, "kind": kind, "text": text}
    if important:
        event["important"] = True
    state["events"].append(event)


def cmd_init(state, args):
    if state is not None:
        fail("state.json already exists; use `set` to change it")
    return {
        "project": args.project, "goal": args.goal, "status": "running",
        "now": args.now or "Intake in progress.", "started": now(), "updated": now(),
        "roadmap": [], "agents": [], "roadblocks": [], "events": [],
    }


def cmd_set(state, args):
    for key in ("status", "now", "goal"):
        if getattr(args, key) is not None:
            state[key] = getattr(args, key)
    return state


def cmd_milestone(state, args):
    m = find(state["roadmap"], args.id)
    if m is None:
        require(args, ["title"], "milestone")
        state["roadmap"].append({"id": args.id, "title": args.title, "steps": []})
    elif args.title:
        m["title"] = args.title
    return state


def set_step(state, step_id: str, status: str | None, agent: str | None) -> dict:
    for m in state["roadmap"]:
        s = find(m["steps"], step_id)
        if s:
            if status:
                s["status"] = status
            if agent is not None:
                s["agent"] = agent or None
            return s
    fail(f"unknown step '{step_id}'")


def cmd_step(state, args):
    exists = any(find(m["steps"], args.id) for m in state["roadmap"])
    if not exists:
        require(args, ["milestone", "title"], "step")
        m = find(state["roadmap"], args.milestone)
        if m is None:
            fail(f"unknown milestone '{args.milestone}'")
        m["steps"].append({"id": args.id, "title": args.title, "status": args.status or "pending", "agent": args.agent or None})
    else:
        set_step(state, args.id, args.status, args.agent)
    return state


def cmd_agent(state, args):
    a = find(state["agents"], args.id)
    if a is None:
        require(args, ["task", "milestone"], "agent")
        a = {
            "id": args.id, "name": args.name or args.id, "task": args.task,
            "skill": args.skill or "none", "model": args.model or "opus",
            "status": args.status or "running", "lane": args.lane or [],
            "milestone": args.milestone, "tokens": 0, "duration_ms": 0,
            "started": now(), "updated": now(), "brief": args.brief or "", "report": "",
        }
        state["agents"].append(a)
        log(state, "spawned", args.log or f"Spawned on {a['model']} following {a['skill']}.", a["id"])
        if args.step:
            set_step(state, args.step, "current", a["id"])
        return state
    for key in ("name", "task", "skill", "model", "status", "milestone", "brief", "report"):
        if getattr(args, key) is not None:
            a[key] = getattr(args, key)
    if args.lane is not None:
        a["lane"] = args.lane
    if args.tokens is not None:
        a["tokens"] = args.tokens
    if args.duration_ms is not None:
        a["duration_ms"] = args.duration_ms
    a["updated"] = now()
    if args.step:
        follow = {"running": "current", "done": "done", "blocked": "blocked"}.get(a["status"])
        set_step(state, args.step, follow, a["id"])
    if args.log:
        kind = {"blocked": "blocked", "done": "reported", "failed": "reported", "stopped": "note"}.get(a["status"], "note")
        log(state, kind, args.log, a["id"], args.important or a["status"] == "failed")
    return state


def cmd_roadblock(state, args):
    r = find(state["roadblocks"], args.id)
    if r is None:
        require(args, ["title", "detail", "severity", "needs"], "roadblock")
        state["roadblocks"].append({
            "id": args.id, "title": args.title, "detail": args.detail, "agent": args.agent or None,
            "severity": args.severity, "needs": args.needs, "since": now(), "resolved": False,
        })
        log(state, "blocked", f"{args.title}: {args.detail}", args.agent, args.important or args.needs == "user")
        if args.agent and find(state["agents"], args.agent):
            find(state["agents"], args.agent)["status"] = "blocked"
        return state
    for key in ("title", "detail", "severity", "needs", "agent"):
        if getattr(args, key) is not None:
            r[key] = getattr(args, key)
    if args.resolved:
        r["resolved"] = True
        log(state, "resolved", f"{r['title']} resolved.", r.get("agent"))
        a = r.get("agent") and find(state["agents"], r["agent"])
        if a and a["status"] == "blocked":
            a["status"] = "running"
    if args.open:
        r["resolved"] = False
    return state


def cmd_event(state, args):
    if args.agent and not find(state["agents"], args.agent):
        fail(f"unknown agent '{args.agent}'")
    log(state, args.kind or "note", args.text, args.agent, args.important)
    return state


def cmd_show(state, args):
    print(f"{state['project']} [{state['status']}] {state['now']}")
    for m in state["roadmap"]:
        done = sum(s["status"] == "done" for s in m["steps"])
        print(f"  {m['id']} {m['title']} ({done}/{len(m['steps'])})")
        for s in m["steps"]:
            print(f"    {s['id']:<6} {s['status']:<8} {s['title']}" + (f"  @{s['agent']}" if s.get("agent") else ""))
    for a in state["agents"]:
        print(f"  agent {a['id']:<16} {a['status']:<8} {a['skill']:<15} {a['model']:<6} {a['tokens']:>8} tok  lane={','.join(a['lane']) or '-'}")
    for r in state["roadblocks"]:
        print(f"  roadblock {r['id']} {'resolved' if r['resolved'] else 'OPEN'} [{r['severity']}, needs {r['needs']}] {r['title']}")
    print(f"  {len(state['events'])} events, updated {state['updated']}")
    return None


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dir", help="directory holding state.json and index.html")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init"); s.add_argument("--project", required=True); s.add_argument("--goal", required=True); s.add_argument("--now")
    s = sub.add_parser("set"); s.add_argument("--status", choices=STATUSES); s.add_argument("--now"); s.add_argument("--goal")
    s = sub.add_parser("milestone"); s.add_argument("id"); s.add_argument("--title")
    s = sub.add_parser("step"); s.add_argument("id"); s.add_argument("--milestone"); s.add_argument("--title")
    s.add_argument("--status", choices=STEP_STATUSES); s.add_argument("--agent", help="agent id, or '' to clear")
    s = sub.add_parser("agent"); s.add_argument("id")
    s.add_argument("--task"); s.add_argument("--skill", choices=SKILLS); s.add_argument("--model", choices=MODELS)
    s.add_argument("--lane", nargs="*", help="files or globs the worker may edit"); s.add_argument("--milestone")
    s.add_argument("--status", choices=AGENT_STATUSES); s.add_argument("--tokens", type=int); s.add_argument("--duration-ms", type=int)
    s.add_argument("--report"); s.add_argument("--brief"); s.add_argument("--name")
    s.add_argument("--step", help="step id to mark current on spawn, or to follow the agent's status on update")
    s.add_argument("--log", help="activity text to record with this change")
    s.add_argument("--important", action="store_true", help="the logged event needs the user's attention now")
    s = sub.add_parser("roadblock"); s.add_argument("id")
    s.add_argument("--title"); s.add_argument("--detail"); s.add_argument("--severity", choices=SEVERITIES)
    s.add_argument("--needs", choices=NEEDS); s.add_argument("--agent")
    g = s.add_mutually_exclusive_group(); g.add_argument("--resolved", action="store_true"); g.add_argument("--open", action="store_true")
    s.add_argument("--important", action="store_true", help="notify the user now (implied by --needs user)")
    s = sub.add_parser("event"); s.add_argument("text"); s.add_argument("--agent"); s.add_argument("--kind", choices=KINDS)
    s.add_argument("--important", action="store_true", help="the user should see this now: toast, sound, badge")
    sub.add_parser("show")
    return p


def main(argv: list[str]) -> None:
    no_render = "--no-render" in argv
    args = build_parser().parse_args([a for a in argv if a != "--no-render"])
    args.no_render = no_render
    root = Path(args.dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / "state.json"
    state = json.loads(path.read_text()) if path.exists() else None
    if state is None and args.cmd != "init":
        fail(f"no state.json in {root}; run `init` first")

    handler = globals()[f"cmd_{args.cmd}"]
    result = handler(state, args)
    if result is None:
        return
    result["updated"] = now()
    render_dashboard.validate(result)
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    if args.no_render:
        print(f"state.json updated ({args.cmd} {getattr(args, 'id', '')})".rstrip())
    else:
        render_dashboard.main([str(path), str(root / "index.html")])


if __name__ == "__main__":
    main(sys.argv[1:])
