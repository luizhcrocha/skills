#!/usr/bin/env python3
"""Record fleet events in the dashboard state and re-render, one command per event.

    state.py DIR init --project P --goal G [--now TEXT] [--role manager]
    state.py DIR set [--status S] [--now TEXT] [--goal G]
    state.py DIR milestone ID --title T
    state.py DIR step ID [--milestone M --title T] [--status S] [--agent A]
    state.py DIR agent ID [--task T --skill S --model M --lane L... --milestone M]
                          [--status S] [--tokens N] [--duration-ms N] [--report R]
                          [--brief B] [--name N] [--step STEP] [--log TEXT] [--important]
    state.py DIR roadblock ID [--title T --detail D --severity S --needs N] [--agent A]
                              [--decision D] [--resolved | --open]
    state.py DIR decision ID [--kind K --title T --question Q --why W] [--blocking | --not-blocking]
                             [--option "KEY: label | consequence"]... [--recommend R --reason WHY]
                             [--secret NAME] [--manual TEXT] [--body FILE | --no-body]
                             [--agent A] [--supersedes ID] [--log TEXT] [--asks user|manager]
                             [--decide ANSWER --resolution HOW | --withdraw REASON]
    state.py DIR event [--agent A] [--kind K] [--important] TEXT
    state.py DIR show

Add --no-render anywhere to write state.json without rendering.

DIR holds state.json, the rendered index.html, and brief.md: what every worker
of the fleet reads before its task, written once from assets/brief.md and the
coordinator's to add to. A manager's DIR (init --role manager) also holds
standing.md: what holds for every fleet, the manager's to keep. Creating and updating use the same verb: an unknown
ID with the required fields creates the row, a known ID updates only the
fields given. Every command stamps timestamps, validates the result, and
renders index.html.
"""
import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decisions  # noqa: E402
import render_dashboard  # noqa: E402

STATUSES = sorted(render_dashboard.STATUSES)
AGENT_STATUSES = sorted(render_dashboard.AGENT_STATUSES)
STEP_STATUSES = sorted(render_dashboard.STEP_STATUSES)
SKILLS = ["implement", "diagnosing-bugs", "prototype", "research", "tdd", "none"]
MODELS = ["opus", "sonnet", "haiku", "fable"]
SEVERITIES = ["warning", "serious", "critical"]
NEEDS = ["user", "coordinator", "worker"]
KINDS = ["spawned", "reported", "blocked", "resolved", "asked", "decision", "note", "integrated"]


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def fail(msg: str) -> None:
    sys.stderr.write(f"state: {msg}\n")
    sys.exit(1)


def find(rows: list, id_: str):
    return next((r for r in rows if r["id"] == id_), None)


def known(state: dict, agent: str) -> bool:
    """Whether the ledger can name `agent`: one of its workers, or for a manager any fleet, since they come and go."""
    return state.get("role") == "manager" or find(state["agents"], agent) is not None


def require(args, fields: list[str], what: str) -> None:
    missing = [f for f in fields if getattr(args, f.replace("-", "_")) is None]
    if missing:
        fail(f"new {what} needs --{' --'.join(missing)}")


def log(state: dict, kind: str, text: str, agent: str | None = None, important: bool = False,
        decision: str | None = None) -> None:
    event = {"at": now(), "agent": agent, "kind": kind, "text": text}
    if important:
        event["important"] = True
    if decision:
        event["decision"] = decision
    state["events"].append(event)


def cmd_init(state, args):
    if state is not None:
        fail("state.json already exists; use `set` to change it")
    state = {
        "project": args.project, "goal": args.goal, "status": "running",
        "now": args.now or "Intake in progress.", "started": now(), "updated": now(),
        "roadmap": [], "agents": [], "roadblocks": [], "decisions": [], "events": [],
    }
    return {"role": "manager", **state} if args.role == "manager" else state


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
    if args.milestone is not None and not find(state["roadmap"], args.milestone):
        known = ", ".join(m["id"] for m in state["roadmap"]) or "none yet; record one with `milestone`"
        fail(f"unknown milestone '{args.milestone}' (the roadmap has: {known})")
    if a is None:
        require(args, ["task", "milestone"], "agent")
        a = {
            "id": args.id, "name": args.name or args.id, "task": args.task,
            "skill": args.skill or "none", "model": args.model or "opus",
            "status": args.status or "running", "lane": args.lane or [],
            "milestone": args.milestone, "tokens": 0, "duration_ms": 0, "rounds": 1,
            "started": now(), "updated": now(), "brief": args.brief or "", "report": "",
        }
        state["agents"].append(a)
        log(state, "spawned", args.log or f"Spawned on {a['model']} following {a['skill']}.", a["id"])
        if args.step:
            set_step(state, args.step, "current", a["id"])
        print(f"recorded {a['id']} ({a['name']}); its brief opens with: Read {Path(args.dir).resolve() / 'brief.md'} first; your id is {a['id']}.")
        return state
    if a["status"] == "done" and args.status == "running":  # sent back after its report
        a["rounds"] = a.get("rounds", 1) + 1
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


def open_decision(state, id_: str) -> dict:
    d = decisions.find(state, id_)
    if d is None:
        fail(f"unknown decision '{id_}'")
    if d["status"] != "open":
        fail(decisions.closed_because(d))
    return d


def resolve(state, r: dict) -> None:
    r["resolved"] = True
    log(state, "resolved", f"{r['title']} resolved.", r.get("agent"))
    a = r.get("agent") and find(state["agents"], r["agent"])
    if a and a["status"] == "blocked":
        a["status"] = "running"


def cmd_roadblock(state, args):
    r = find(state["roadblocks"], args.id)
    if args.decision:
        open_decision(state, args.decision)
    if r is None:
        require(args, ["title", "detail", "severity", "needs"], "roadblock")
        if args.needs == "user" and not args.decision:
            fail("a roadblock that needs the user names what it asks: record the `decision` first, then pass --decision ID")
        state["roadblocks"].append({
            "id": args.id, "title": args.title, "detail": args.detail, "agent": args.agent or None,
            "severity": args.severity, "needs": args.needs, "decision": args.decision or None,
            "since": now(), "resolved": False,
        })
        log(state, "blocked", f"{args.title}: {args.detail}", args.agent, args.important or args.needs == "user", args.decision)
        if args.agent and find(state["agents"], args.agent):
            find(state["agents"], args.agent)["status"] = "blocked"
        return state
    for key in ("title", "detail", "severity", "needs", "agent", "decision"):
        if getattr(args, key) is not None:
            r[key] = getattr(args, key)
    if args.resolved:
        resolve(state, r)
    if args.open:
        r["resolved"] = False
    return state


def parse_options(texts: list[str]) -> list[dict]:
    """Each "KEY: label | consequence" as {"id", "label", "consequence"}."""
    options = []
    for text in texts:
        key, colon, rest = text.partition(":")
        label, bar, consequence = rest.partition("|")
        key, label, consequence = key.strip(), label.strip(), consequence.strip()
        if not (colon and bar and label and consequence and decisions.ID.fullmatch(key)):
            fail(f"an option reads \"KEY: label | consequence\", got {text!r}")
        if find(options, key):
            fail(f"option '{key}' is given twice")
        options.append({"id": key, "label": label, "consequence": consequence})
    return options


def check_kind(d: dict) -> None:
    """What each kind's answer control shows has to be there."""
    if d["kind"] == "decision":
        if len(d["options"]) < 2:
            fail("a decision needs at least two options (--option, once per option)")
        missing = [f for f in ("recommend", "reason") if not d[f]]
        if missing:
            fail(f"a decision carries the coordinator's recommendation: give --{' --'.join(missing)}")
        if not find(d["options"], d["recommend"]):
            fail(f"--recommend '{d['recommend']}' is not one of the options ({', '.join(o['id'] for o in d['options'])})")
    if d["kind"] == "secret" and not d["secret"]:
        fail("a secret names what the code expects: give --secret NAME (the key in secretspec.toml)")
    if d["kind"] in ("secret", "action") and not d["manual"]:
        fail(f"{'a secret' if d['kind'] == 'secret' else 'an action'} gives the manual route: give --manual with the steps or commands")


def set_body(root: Path, d: dict, args) -> None:
    target = root / "decisions" / f"{d['id']}.html"
    if args.no_body:
        target.unlink(missing_ok=True)
        d["body"] = False
    elif args.body:
        try:
            content = Path(args.body).read_bytes()
        except OSError as exc:
            fail(f"cannot read the body {args.body}: {exc.strerror or exc}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        d["body"] = True


def close(state, d: dict, status: str, answer: str | None, resolution: str) -> None:
    d.update(status=status, answer=answer, resolution=resolution, closed=now())
    if status == "decided":
        log(state, "decision", f"{d['title']}: {answer} ({resolution})", d["agent"], decision=d["id"])
    else:
        log(state, "resolved", f"{d['title']} withdrawn: {resolution}", d["agent"], decision=d["id"])
    for r in state["roadblocks"]:
        if r.get("decision") == d["id"] and not r["resolved"]:
            resolve(state, r)


FIELDS = ("kind", "title", "question", "why", "recommend", "reason", "secret", "manual", "agent")


def cmd_decision(state, args):
    rows = state.setdefault("decisions", [])
    d = decisions.find(state, args.id)
    if args.decide is not None and not args.resolution:
        fail("--decide says what was chosen and --resolution how it came (\"answered on the page (#14)\", \"said in the session\")")
    if args.agent and not known(state, args.agent):
        fail(f"unknown agent '{args.agent}'")
    if d is not None and d["status"] != "open":
        fail(f"{decisions.closed_because(d)}. A closed decision stays as it is; open a new one with --supersedes {d['id']}")
    if d is None:
        if not decisions.ID.fullmatch(args.id):
            fail(f"decision id {args.id!r} should be letters, digits, '_', '.', or '-'")
        if args.supersedes:
            old = decisions.find(state, args.supersedes)
            if old is None:
                fail(f"unknown decision '{args.supersedes}'")
            if old["status"] == "open":
                fail(f"{old['title']} is still open; change it instead of superseding it")
        made_elsewhere = args.decide is not None
        require(args, ["title", "question"] if made_elsewhere else ["kind", "title", "question", "why"], "decision")
        d = {"id": args.id, "kind": args.kind or "decision", "title": args.title, "question": args.question,
             "why": args.why, "blocking": bool(args.blocking), "agent": args.agent or None,
             "options": parse_options(args.option or []), "recommend": args.recommend, "reason": args.reason,
             "secret": args.secret, "manual": args.manual, "body": False, "page": not made_elsewhere,
             "supersedes": args.supersedes, "status": "open", "answer": None, "resolution": None, "change": None,
             "asks": args.asks or "user", "opened": now(), "revised": None, "closed": None}
        if not made_elsewhere:
            check_kind(d)
            set_body(Path(args.dir).resolve(), d, args)
            for_manager = d["asks"] == "manager"   # the manager looks first: the user is not called yet
            log(state, "asked", f"{'For the manager: ' if for_manager else ''}{d['title']}: {d['question']}", d["agent"],
                d["blocking"] and not for_manager, d["id"])
        rows.append(d)
    else:
        if args.supersedes:
            fail("--supersedes is given when the new decision is opened")
        changed = [k for k in FIELDS if getattr(args, k) is not None] + [k for k in ("option", "body") if getattr(args, k)]
        for key in FIELDS:
            if getattr(args, key) is not None:
                d[key] = getattr(args, key) or None
        if args.option:
            d["options"] = parse_options(args.option)
        if args.blocking or args.not_blocking:
            d["blocking"] = bool(args.blocking)
            changed.append("blocking")
        if args.no_body:
            changed.append("body")
        passed_on = args.asks == "user" and d.get("asks") == "manager"
        if args.asks and args.asks != d.get("asks", "user"):
            d["asks"] = args.asks
            changed.append("asks")
        check_kind(d)
        set_body(Path(args.dir).resolve(), d, args)
        if changed:
            d["revised"], d["change"] = now(), args.log or None
            text = f"{d['title']} now asks you: {d['question']}" if passed_on else f"{d['title']} changed: {args.log or ', '.join(changed)}"
            log(state, "asked", text, d["agent"], passed_on and d["blocking"], d["id"])
    if args.decide is not None:
        close(state, d, "decided", args.decide, args.resolution)
    elif args.withdraw is not None:
        close(state, d, "withdrawn", None, args.withdraw)
    return state


def cmd_event(state, args):
    if args.agent and not known(state, args.agent):
        fail(f"unknown agent '{args.agent}'")
    log(state, args.kind or "note", args.text, args.agent, args.important)
    return state


CHEATSHEET = f"""
commands (state.py DIR <command>; an unknown ID creates the row, a known ID changes the fields given):
  set [--status {"|".join(STATUSES)}] [--now TEXT] [--goal G]
  milestone ID --title T
  step ID --milestone M --title T [--status {"|".join(STEP_STATUSES)}] [--agent A]
  agent ID --task T --milestone M [--name N] [--skill {"|".join(SKILLS)}] [--model {"|".join(MODELS)}]
        [--lane PATH...] [--step S] [--brief B] [--status {"|".join(AGENT_STATUSES)}]
        [--tokens N --duration-ms N] [--report R] [--log TEXT] [--important]
  roadblock ID --title T --detail D --severity {"|".join(SEVERITIES)} --needs {"|".join(NEEDS)} [--agent A]
        [--decision D] [--resolved | --open]
  decision ID --kind {"|".join(decisions.KINDS)} --title T --question Q --why W [--blocking | --not-blocking]
        [--option "KEY: label | consequence"]... [--recommend R --reason WHY] [--secret NAME] [--manual TEXT]
        [--body FILE | --no-body] [--agent A] [--supersedes ID] [--log TEXT] [--asks {"|".join(decisions.ASKS)}]
        [--decide ANSWER --resolution HOW | --withdraw REASON]
  event [--kind {"|".join(KINDS)}] [--agent A] [--important] TEXT
  show
  --no-render on any command writes state.json without rendering"""


def cmd_show(state, args):
    role = ", manager" if state.get("role") == "manager" else ""
    print(f"{state['project']} [{state['status']}{role}] {state['now']}")
    for m in state["roadmap"]:
        done = sum(s["status"] == "done" for s in m["steps"])
        print(f"  {m['id']} {m['title']} ({done}/{len(m['steps'])})")
        for s in m["steps"]:
            print(f"    {s['id']:<6} {s['status']:<8} {s['title']}" + (f"  @{s['agent']}" if s.get("agent") else ""))
    for a in state["agents"]:
        rounds = f"  round {a['rounds']}" if a.get("rounds", 1) > 1 else ""
        print(f"  agent {a['id']:<16} {a['status']:<8} {a['skill']:<15} {a['model']:<6} {a['tokens']:>8} tok  lane={','.join(a['lane']) or '-'}{rounds}")
    for r in state["roadblocks"]:
        print(f"  roadblock {r['id']} {'resolved' if r['resolved'] else 'OPEN'} [{r['severity']}, needs {r['needs']}] {r['title']}")
    for d in state.get("decisions", []):
        status = ("OPEN, blocking" if d.get("blocking") else "OPEN") if d["status"] == "open" else d["status"]
        if d["status"] == "open" and d.get("asks") == "manager":
            status += ", with the manager"
        outcome = d.get("answer") or d.get("resolution")
        print(f"  decision {d['id']} {status} [{d['kind']}] {d['title']}" + (f": {outcome}" if outcome else ""))
    print(f"  {len(state['events'])} events, updated {state['updated']}")
    print(CHEATSHEET)
    return None


def ensure_brief(root: Path, state: dict) -> None:
    """DIR/brief.md from assets/brief.md with this fleet's paths, and for a manager DIR/standing.md,
    each unless it is there: what was added to them stays."""
    skill = Path(__file__).resolve().parent.parent
    path = root / "brief.md"
    if not path.exists():
        template = (skill / "assets" / "brief.md").read_text()
        path.write_text(template.replace("{skill_dir}", str(skill)).replace("{dashboard_dir}", str(root)))
    standing = root / "standing.md"
    if state.get("role") == "manager" and not standing.exists():
        standing.write_text((skill / "assets" / "standing.md").read_text())


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dir", help="directory holding state.json and index.html")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init"); s.add_argument("--project", required=True); s.add_argument("--goal", required=True); s.add_argument("--now")
    s.add_argument("--role", choices=["coordinator", "manager"], help="manager: this ledger is the manager's, over every coordinator on the machine")
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
    s.add_argument("--decision", help="the decision this roadblock waits on; required with --needs user")
    g = s.add_mutually_exclusive_group(); g.add_argument("--resolved", action="store_true"); g.add_argument("--open", action="store_true")
    s.add_argument("--important", action="store_true", help="notify the user now (implied by --needs user)")
    s = sub.add_parser("decision"); s.add_argument("id")
    s.add_argument("--kind", choices=decisions.KINDS); s.add_argument("--title"); s.add_argument("--question")
    s.add_argument("--why", help="what it blocks, or the assumption the fleet runs on until it is answered")
    g = s.add_mutually_exclusive_group(); g.add_argument("--blocking", action="store_true"); g.add_argument("--not-blocking", action="store_true")
    s.add_argument("--option", action="append", metavar="\"KEY: label | consequence\"", help="once per option; given again, replaces them all")
    s.add_argument("--recommend", help="the option's KEY, or the value you would give"); s.add_argument("--reason")
    s.add_argument("--secret", metavar="NAME", help="the name the code expects, as in secretspec.toml")
    s.add_argument("--manual", help="the route the user can take by hand: steps or commands, shown verbatim")
    g = s.add_mutually_exclusive_group(); g.add_argument("--body", metavar="FILE", help="an HTML fragment with the evidence, copied to DIR/decisions/ID.html")
    g.add_argument("--no-body", action="store_true")
    s.add_argument("--agent", help="the worker that waits on it"); s.add_argument("--supersedes", metavar="ID")
    s.add_argument("--log", help="what changed, shown to the user on the page")
    s.add_argument("--asks", choices=decisions.ASKS, help="who looks at it first: the user, or the manager when there is one")
    g = s.add_mutually_exclusive_group(); g.add_argument("--decide", metavar="ANSWER"); g.add_argument("--withdraw", metavar="REASON")
    s.add_argument("--resolution", metavar="HOW", help="with --decide: how the answer came")
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
    ensure_brief(root, result)
    if args.no_render:
        print(f"state.json updated ({args.cmd} {getattr(args, 'id', '')})".rstrip())
    else:
        render_dashboard.main([str(path), str(root / "index.html")])


if __name__ == "__main__":
    main(sys.argv[1:])
