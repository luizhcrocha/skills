#!/usr/bin/env python3
"""Record fleet events in the dashboard state and re-render, one command per event.

    state.py DIR init --project P --goal G [--now TEXT] [--role manager]
    state.py DIR set [--status S] [--now TEXT] [--goal G] [--workspaces isolated|shared]
    state.py DIR milestone ID --title T
    state.py DIR step ID [--milestone M --title T] [--status S] [--agent A]
                         [--before STEP | --after STEP] [--remove REASON]
    state.py DIR agent ID [--task T --skill S --model M --effort E --lane L... --milestone M]
                          [--status S] [--tokens N] [--duration-ms N] [--report R]
                          [--brief B] [--name N] [--step STEP] [--log TEXT] [--important]
                          [--task-id ID]   (tokens and duration then come from the worker's transcript)
    state.py DIR roadblock ID [--title T --detail D --severity S --needs N] [--agent A]
                              [--decision D] [--resolved | --open]
    state.py DIR decision ID [--kind K --title T --question Q --why W] [--blocking | --not-blocking]
                             [--option "KEY: label | consequence"]... [--same-options]
                             [--recommend R --reason WHY]
                             [--secret NAME] [--manual TEXT] [--body FILE | --no-body]
                             [--agent A] [--supersedes ID] [--log TEXT] [--asks user|manager]
                             [--decide ANSWER --resolution HOW | --withdraw REASON | --hold REASON | --unhold]
    state.py DIR event [--agent A] [--kind K] [--important] TEXT
    state.py DIR park [--agent A]... REASON
    state.py DIR keep ID [TEXT | --drop REASON]
    state.py DIR link ID --url U --title T [--kind dev|page] [--decision D] [--agent A] [--note N] | --drop REASON
    state.py DIR grill ID [--title T --why W --log TEXT] [--ask "TITLE | QUESTION | RECOMMENDATION | WHY"]... [--of Q]
                          [--option "Q1 a: label | consequence"]... [--body FILE | --no-body]
                          [--answer "Q3: ..."]... [--drop "Q4: why"]... [--revise "Q3: T | Q | R | W"]... [--reason "Q3: why"]... [--done SUMMARY]
    state.py DIR step next --milestone M --title T   (records the next free step id and prints it)
    state.py DIR show

Add --no-render anywhere to write state.json without rendering, -q to render without saying so.
Every command also warns (on stderr) when the user's chat messages wait unread, and when worker
rows still say running while the fleet is paused or done.

DIR holds state.json, the rendered index.html, and brief.md: what every worker
of the fleet reads before its task, written once from assets/brief.md and the
coordinator's to add to. A manager's DIR (init --role manager) also holds
standing.md: what holds for every fleet, the manager's to keep. Creating and updating use the same verb: an unknown
ID with the required fields creates the row, a known ID updates only the
fields given. Every command stamps timestamps, validates the result, and
renders index.html.
"""
import argparse
import contextlib
import io
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chat  # noqa: E402
import clock  # noqa: E402
import decisions  # noqa: E402
import lanes  # noqa: E402
import render_dashboard  # noqa: E402
import spend  # noqa: E402

STATUSES = sorted(render_dashboard.STATUSES)
AGENT_STATUSES = sorted(render_dashboard.AGENT_STATUSES)
STEP_STATUSES = sorted(render_dashboard.STEP_STATUSES)
WORKSPACE_MODES = sorted(render_dashboard.WORKSPACE_MODES)
# The plugin's fleet CLI, which every printed command names: this script is the TypeScript fleet's
# oracle (fleet/SPEC.md), and the commands it prints are the CLI's.
FLEET = Path(__file__).resolve().parents[4] / "fleet" / "bin" / "fleet"
SKILLS = ["implement", "diagnosing-bugs", "prototype", "research", "tdd", "none"]
MODELS = ["opus", "sonnet", "haiku", "fable"]
EFFORTS = ["low", "medium", "high", "xhigh", "max"]
# The role table, the one place its values live (fleet/src/ledger/roles.ts is its TypeScript twin, and the
# oracle's model reads this one): `pairs`, the efforts the policy approves on each model, in the order the
# warnings name them (any other model, or any other pair, is the user's to approve, case by case: L3);
# `kinds`, a new worker's model and effort by its skill when --model or --effort is not given ("" is any
# other skill; `advisor` is the TypeScript `fleet advisor`'s row, whose skill is none); `alone`, the effort a model given without --effort takes when its kind's is not among its pairs.
ROLES = {
    "pairs": {"opus": ["medium", "high"], "sonnet": ["low", "medium", "high"], "fable": ["high"], "haiku": ["low", "high"]},
    "kinds": {"research": ["sonnet", "medium"], "advisor": ["fable", "high"], "": ["opus", "high"]},
    "alone": {"opus": "high", "sonnet": "medium", "fable": "high", "haiku": "high"},
}
POLICY_MODELS = list(ROLES["pairs"])


def defaults(skill: str, model: str | None, effort: str | None) -> tuple[str, str]:
    """A new worker's model and effort: the ones given, else its kind's; a model given without an effort takes
    its kind's effort when the pair is in the policy, else the model's own (`alone`), else its kind's still."""
    kind_model, kind_effort = ROLES["kinds"].get(skill, ROLES["kinds"][""])
    if effort:
        return model or kind_model, effort
    if not model:
        return kind_model, kind_effort
    if kind_effort in ROLES["pairs"].get(model, []):
        return model, kind_effort
    return model, ROLES["alone"].get(model, kind_effort)


SEVERITIES = ["warning", "serious", "critical"]
NEEDS = ["user", "coordinator", "worker"]
KINDS = ["spawned", "reported", "blocked", "resolved", "asked", "decision", "note", "integrated"]


def now() -> str:
    return clock.stamp()


def fail(msg: str) -> None:
    sys.stderr.write(f"state: {msg}\n")
    sys.exit(1)


def find(rows: list, id_: str):
    """The row with this id, or else with this number (L2, written in capitals)."""
    return next((r for r in rows if r["id"] == id_), None) or \
        next((r for r in rows if r.get("ref") and r["ref"] == id_), None)


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
        "now": args.now or "Intake in progress.", "now_at": now(), "started": now(), "updated": now(),
        "roadmap": [], "agents": [], "roadblocks": [], "decisions": [], "events": [],
    }
    if args.role == "manager":  # the landing queue: one step per landing, the current one holds the turn
        state["roadmap"].append({"id": LANDINGS, "title": "Landings and deploys", "steps": []})
        return {"role": "manager", **state}
    return state


REF = re.compile(r"\b([DAISGLR]\d+)\b")
LANDINGS = "landings"


def closed_named(state: dict, text: str) -> list[str]:
    """The decisions a Now line names by number that are already closed: in this ledger ("A6"), and on a
    manager's, in a fleet's ("infra I2", "infra-coordinator I2")."""
    import copy
    own = copy.deepcopy(state)
    decisions.number(own)
    found = []
    ledgers = {"": own}
    if state.get("role") == "manager":
        import fleets
        for e in fleets.live():
            if e["role"] != "manager":
                theirs = fleets._read(Path(e["dir"]) / "state.json") or {}
                decisions.number(theirs)
                ledgers[e["id"]] = theirs
    for m in REF.finditer(text or ""):
        before = text[:m.start()].split()
        word = before[-1].lower().strip(",:;(") if before else ""
        fleet = next((f for f in ledgers if f and (word == f or word == f.split("-")[0])), "")
        d = decisions.find(ledgers[fleet], m.group(1))
        if d and d.get("status") != "open":
            found.append(f"{(fleet + ' ') if fleet else ''}{m.group(1)} ({d['title']}) is {d['status']}")
    return found


def cmd_set(state, args):
    for key in ("status", "now", "goal"):
        if getattr(args, key) is not None:
            state[key] = getattr(args, key)
    if args.workspaces is not None:  # how the workers share the repository: a jj workspace each, or one working copy
        state["workspace_mode"] = args.workspaces
    if args.now is not None:
        state["now_at"] = now()  # the page greys a now-line that has not been said again for a while
        for said in closed_named(state, args.now):
            sys.stderr.write(f"state: the Now line names {said}: check the decision's state before saying it waits on anyone.\n")
    return state


LIVE = ("running", "queued", "blocked")
# Words a report uses when the work did not finish: said to a coordinator that records it as done anyway.
UNFINISHED = re.compile(r"\b(refused|parked|not met|unmet|could(?:n't| not)|failed to|gave up|incomplete|unfinished|"
                        r"blocked on|waiting on|skipped|not done)\b", re.I)


def cmd_park(state, args):
    """Stop every worker row still live (or the ones named) in one command, with one reason: what a
    pause, a stop, or a worker that ended unseen leaves behind."""
    for a in args.agent or []:
        if not find(state["agents"], a):
            fail(f"unknown agent '{a}'")
    rows = [a for a in state["agents"] if a["status"] in LIVE and (not args.agent or a["id"] in args.agent)]
    if not rows:
        fail("no worker row is running, queued, or blocked" + (" among those named" if args.agent else ""))
    for a in rows:
        a["status"] = "stopped"
        a["updated"] = now()
    stopped = {a["id"] for a in rows}
    for m in state["roadmap"]:
        for st in m["steps"]:
            if st.get("status") == "current" and st.get("agent") in stopped:
                st["status"] = "pending"  # nobody works it now; the step keeps who last did
    log(state, "note", f"Stopped {', '.join(a['id'] for a in rows)}: {args.reason}")
    return state


def measure(root, state: dict) -> None:
    """Fill the tokens and duration of each worker row that names its task id, from the worker's own
    transcript, as long as it runs and once more after it ends. Figures given by hand stay."""
    for a in state["agents"]:
        if not a.get("task_id") or a.get("measured") == "by hand":
            continue
        got = spend.worker(root, a["task_id"])
        if got is None or (a.get("measured") == got["at"] and a["status"] not in LIVE):
            continue
        a["tokens"], a["duration_ms"], a["measured"] = got["tokens"], got["duration_ms"], got["at"]


LINK_KINDS = ["dev", "page"]


def cmd_link(state, args):
    """A place the user opens: a dev server (`dev`) or a page made for a purpose (`page`: a review, a
    lab, a report). The Links view lists them, up or down; one tied to a decision opens from its page."""
    links = state.setdefault("links", [])
    item = find(links, args.id)
    if args.drop is not None:
        if item is None:
            fail(f"no link '{args.id}'")
        links.remove(item)
        log(state, "note", f"Link {args.id} ({item['title']}) removed: {args.drop}")
        return state
    if args.decision:  # a number (D3) is kept as the id it names: the page looks decisions up by id
        args.decision = (decisions.find(state, args.decision) or fail(f"unknown decision '{args.decision}'"))["id"]
    if args.agent and not known(state, args.agent):
        fail(f"unknown agent '{args.agent}'")
    if item is None:
        if not args.url or not args.title:
            fail("a new link needs --url and --title")
        item = {"id": args.id, "url": args.url, "title": args.title, "kind": args.kind or "dev", "decision": args.decision,
                "agent": args.agent, "note": args.note, "since": now()}
        links.append(item)
        log(state, "note", f"{'Page' if item['kind'] == 'page' else 'Dev server'} {item['title']}: {item['url']}", args.agent,
            decision=args.decision)
    else:
        for key in ("url", "title", "kind", "decision", "agent", "note"):
            if getattr(args, key) is not None:
                item[key] = getattr(args, key) or None
    return state


def cmd_keep(state, args):
    """What must outlive a compaction and has no row elsewhere: a queued ask, a hunk outside any lane,
    a workspace and what it holds, where a worker stands. `show` prints them; the page lists them."""
    kept = state.setdefault("kept", [])
    item = find(kept, args.id)
    if args.drop is not None:
        if item is None:
            fail(f"nothing kept as '{args.id}'")
        kept.remove(item)
        log(state, "note", f"Dropped {args.id} ({item['text']}): {args.drop}")
        return state
    if not args.text:
        fail("keep needs TEXT: what must still be known after a compaction")
    if item is None:
        kept.append({"id": args.id, "text": args.text, "at": now()})
    else:
        item.update(text=args.text, at=now())
    return state


NOW_STALE_S = 30 * 60


def stale_now(state: dict, args) -> str | None:
    """What to say when the page's Now line has not been said again for NOW_STALE_S: the user reads it
    first, and a line that was true this morning misleads all day."""
    if not state or getattr(args, "now", None) is not None or args.cmd == "init":
        return None
    said = state.get("now_at")
    try:
        age = (clock.now() - datetime.fromisoformat(said)).total_seconds() if said else None
    except ValueError:
        age = None
    if age is not None and age < NOW_STALE_S:
        return None
    when = f"said {int(age // 60)} min ago" if age is not None else "never stamped"
    return (f"state: the page's Now line ({when}) reads: \"{str(state.get('now', ''))[:160]}\". If it is no longer what is "
            f"happening, say it again: `fleet state <dir> set --now \"...\"` (the same words also restamp it).")


def stale_rows(state: dict) -> str | None:
    """What to say when worker rows still read as live while the fleet itself is not."""
    if not state or state.get("status") not in ("paused", "done"):
        return None
    rows = [a["id"] for a in state.get("agents", []) if a.get("status") in LIVE]
    if not rows:
        return None
    return (f"state: {', '.join(rows)} still read as {'/'.join(LIVE)} while the fleet is {state['status']}; "
            f"if they are not working, `fleet state <dir> park \"why\"` stops their rows in one command.")


def unrecorded(root, state: dict) -> list[str]:
    """What to say for each answer the user gave on the page that the ledger has not recorded: the page
    shows it as sent and the fleet has not acted on it, so it is recorded before any other work. A grilling
    with every question answered is said so until it is decided or withdrawn, whatever the chat said after
    the last answer (a reply to it, a recap, amendments)."""
    if not state or not state.get("decisions"):
        return []
    import copy
    numbered = copy.deepcopy(state)
    decisions.number(numbered)
    said = chat.read(root)
    lines = []
    for d in numbered["decisions"]:
        if decisions.answered_grill(d):
            lines.append(f"state: every question of {d['ref']} ({d['title']}) is answered and the grilling is still open; record it before any other "
                         f"work: `fleet state <dir> decision {d['ref']} --decide \"...\" --resolution \"grilling finished\"`, or --withdraw \"why\".")
            continue
        failed = decisions.failed_answer(d, said)
        if failed:
            # held since it failed: the fleet says it works on the fix
            if not (d.get("held") and d.get("held_at") and clock.at_or_after(d["held_at"], failed["at"])):
                lines.append(f"state: the user ran {d['ref']} ({d['title']}) and it failed, #{failed['id']} at {str(failed['at'])[11:16]}: "
                             f"{decisions.failure_words(failed)}. It is not done: fix what failed and re-present it "
                             f"(`fleet state <dir> decision {d['ref']} --manual \"...\" --log \"what changed\"`), or `--withdraw \"why\"`; "
                             f"never --decide it. Answer #{failed['id']} with --re.")
            continue
        at = d.get("status") == "open" and decisions.answered_at(d, said)
        if not at:
            continue
        m = next(x for x in reversed(said) if x.get("decision") == d["id"] and x["from"] == "user" and x["at"] == at)
        lines.append(f"state: the user answered {d['ref']} ({d['title']}) as #{m['id']} at {str(at)[11:16]}; record it before any other "
                     f"work: `fleet state <dir> decision {d['ref']} --decide \"...\" --resolution \"answered on the page (#{m['id']})\"`, "
                     f"then answer #{m['id']} with --re.")
    return lines


def left_open(state: dict, args) -> str | None:
    """What to say when the fleet is set done with decisions still open: each is withdrawn with its reason,
    or named in the last message as left open on purpose."""
    if args.cmd != "set" or args.status != "done" or not state:
        return None
    still = [d.get("ref") or d["id"] for d in state.get("decisions", []) if d.get("status") == "open"]
    if not still:
        return None
    return (f"state: the fleet is done with {', '.join(still)} still open: withdraw each with its reason "
            f"(`decision ID --withdraw \"why\"`), or name it in your last message as left open on purpose.")


def starts_lane(args) -> bool:
    """Whether an `agent` command puts the worker's lane to work: only such a command is checked for lanes that meet."""
    return args.lane is not None or args.status == "running" or bool(args.task)


def lane_hits(state: dict, a: dict) -> list[str]:
    """Per running or blocked worker whose lane meets running worker `a`'s (L7): its id, status and the entries."""
    if a.get("status") != "running":
        return []
    hits = []
    for other in state["agents"]:
        if other is a or other.get("status") not in ("running", "blocked"):
            continue
        shared = sorted({x for x in a.get("lane") or [] for y in other.get("lane") or [] if lanes.meet(x, y)})
        if shared:
            hits.append(f"{other['id']}'s ({other['status']}: {', '.join(shared)})")
    return hits


def overlapping(state: dict, args) -> str | None:
    """What to say when a worker recorded as running shares files with another running or blocked worker's
    lane: two workers on the same files collide at integration, so the task waits or joins that queue. A fleet
    that shares one working copy refuses it instead (`shared_overlap`)."""
    if args.cmd != "agent" or not state or state.get("workspace_mode") == "shared" or not starts_lane(args):
        return None
    a = find(state["agents"], args.id)
    hits = lane_hits(state, a) if a else []
    if not hits:
        return None
    return (f"state: {a['id']}'s lane overlaps {'; '.join(hits)}. A task whose files overlap a running lane waits "
            f"(`--status queued`) or joins that worker's queue.")


def shared_overlap(state: dict, a: dict, args) -> None:
    """In a fleet whose workers share one working copy, refuse a running worker whose lane meets a live one's:
    there two workers on the same files overwrite each other's edits as they make them."""
    if state.get("workspace_mode") != "shared" or not starts_lane(args):
        return
    hits = lane_hits(state, a)
    if hits:
        fail(f"{a['id']}'s lane overlaps {'; '.join(hits)}, and this fleet's workers share one working copy (`set --workspaces shared`), "
             f"where two workers on the same files overwrite each other: record it `--status queued` until that worker is done, "
             f"or give the task to that worker.")


def off_policy(state: dict, args) -> str | None:
    """What to say when `agent` gives a model or an effort that leaves the worker outside the policy: accepted,
    and the user's to approve before it is spawned on it."""
    if args.cmd != "agent" or not state or not (args.model or args.effort):
        return None
    a = find(state["agents"], args.id)
    if a is None:
        return None
    model, effort = a.get("model") or "opus", a.get("effort")
    if model not in POLICY_MODELS:
        return (f"state: {args.id} is recorded on {model}, outside the model policy ({', '.join(POLICY_MODELS)}): "
                f"spawning it on {model} needs the user's OK.")
    if not effort or effort in ROLES["pairs"][model]:
        return None
    pairs = "; ".join(f"{m} {', '.join(e)}" for m, e in ROLES["pairs"].items())
    return (f"state: {args.id} is recorded on {model} at {effort} effort, outside the effort policy ({pairs}): "
            f"spawning it so needs the user's OK.")


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


def place(m: dict, step: dict, state, before: str | None, after: str | None) -> None:
    """Put `step` right before or after another step of its milestone: the steps read in the order of their turn."""
    other = before or after
    if other == step["id"]:
        fail(f"step {other} cannot be placed before or after itself")
    if not find(m["steps"], other):
        home = next((x for x in state["roadmap"] if find(x["steps"], other)), None)
        fail(f"step {other} is in {home['id']}, and {step['id']} is in {m['id']}" if home else f"unknown step '{other}'")
    m["steps"] = [s for s in m["steps"] if s is not step]
    at = next(i for i, s in enumerate(m["steps"]) if s["id"] == other)
    m["steps"].insert(at if before else at + 1, step)


def next_step_id(state: dict, milestone: str) -> str:
    """The next free step id for `milestone`: its steps' letters with the number after the highest
    that any step of the ledger with those letters has (l17 after l16), so two asks never collide."""
    m = find(state["roadmap"], milestone)
    letters = [re.match(r"[A-Za-z]+", x["id"]).group(0) for x in (m or {}).get("steps", []) if re.match(r"[A-Za-z]+\d+$", x["id"])]
    prefix = letters[-1] if letters else (re.match(r"[A-Za-z]", milestone) or re.match("", "")).group(0).lower() or "s"
    used = [int(x["id"][len(prefix):]) for mm in state["roadmap"] for x in mm["steps"] if re.fullmatch(prefix + r"\d+", x["id"])]
    return f"{prefix}{max(used, default=0) + 1}"


def cmd_step(state, args):
    if args.id == "next":
        require(args, ["milestone", "title"], "step")
        if not find(state["roadmap"], args.milestone):
            fail(f"unknown milestone '{args.milestone}'")
        args.id = next_step_id(state, args.milestone)
        print(f"recorded step {args.id}")
    m = next((x for x in state["roadmap"] if find(x["steps"], args.id)), None)
    if args.remove is not None:
        if m is None:
            fail(f"unknown step '{args.id}'")
        step = find(m["steps"], args.id)
        m["steps"].remove(step)
        log(state, "note", f"Step {args.id} removed ({step['title']}): {args.remove}", step.get("agent") if find(state["agents"], step.get("agent") or "") else None)
        return state
    if m is None:
        require(args, ["milestone", "title"], "step")
        m = find(state["roadmap"], args.milestone)
        if m is None:
            fail(f"unknown milestone '{args.milestone}'")
        step = {"id": args.id, "title": args.title, "status": args.status or "pending", "agent": args.agent or None}
        m["steps"].append(step)
    else:
        if args.milestone is not None and args.milestone != m["id"]:
            fail(f"step {args.id} stays in {m['id']}; remove it and record it in {args.milestone} to move it")
        step = set_step(state, args.id, args.status, args.agent)
        if args.title is not None:
            step["title"] = args.title
    if args.before or args.after:
        place(m, step, state, args.before, args.after)
    one_turn(state, m, step)
    return state


def one_turn(state: dict, m: dict, step: dict) -> None:
    """In a manager's landing queue one landing has the turn: another is made current only once the one
    that has it is done or given back."""
    if state.get("role") != "manager" or m["id"] != LANDINGS or step.get("status") != "current":
        return
    held = next((x for x in m["steps"] if x is not step and x.get("status") == "current"), None)
    if held:
        fail(f"{held['id']} ({held['title']}) has the turn: one landing at a time. Close it (`step {held['id']} --status done`) "
             f"or give it back (`step {held['id']} --status pending`) first")


def cmd_agent(state, args):
    a = find(state["agents"], args.id)
    if args.milestone is not None and not find(state["roadmap"], args.milestone):
        known = ", ".join(m["id"] for m in state["roadmap"]) or "none yet; record one with `milestone`"
        fail(f"unknown milestone '{args.milestone}' (the roadmap has: {known})")
    if a is None:
        if args.milestone is None:
            fail(f"new agent needs --milestone, one of {', '.join(m['id'] for m in state['roadmap']) or '(none yet: add one with `milestone`)'}")
        require(args, ["task", "milestone"], "agent")
        model, effort = defaults(args.skill or "none", args.model, args.effort)
        a = {
            "id": args.id, "name": args.name or args.id, "task": args.task,
            "skill": args.skill or "none", "model": model, "effort": effort,
            "status": args.status or "running", "lane": args.lane or [],
            "milestone": args.milestone, "tokens": 0, "duration_ms": 0, "rounds": 1,
            "started": now(), "updated": now(), "brief": args.brief or "", "report": "",
        }
        if args.task_id:
            a["task_id"] = args.task_id
        if args.name:
            a["name_by"] = "coordinator"
        state["agents"].append(a)
        log(state, "spawned", args.log or f"Spawned on {a['model']} following {a['skill']}.", a["id"])
        if args.step:
            set_step(state, args.step, "current", a["id"])
        shared_overlap(state, a, args)
        print(f"recorded {a['id']} ({a['name']}); its brief opens with: Read {Path(args.dir).resolve() / 'brief.md'} first; your id is {a['id']}.")
        return state
    if a["status"] == "done" and args.status == "running":  # sent back after its report
        a["rounds"] = a.get("rounds", 1) + 1
    if args.task_id:
        a["task_id"] = args.task_id
        a.pop("measured", None)
    if args.name:
        a["name"], a["name_by"] = args.name, "coordinator"
    elif args.name is not None:  # an empty name gives the row back to its id and its session's name
        a["name"] = a["id"]
        a.pop("name_by", None)
    for key in ("task", "skill", "model", "effort", "status", "milestone", "brief", "report"):
        if getattr(args, key) is not None:
            a[key] = getattr(args, key)
    if args.lane is not None:
        a["lane"] = args.lane
    if args.tokens is not None:
        a["tokens"] = args.tokens
    if args.duration_ms is not None:
        a["duration_ms"] = args.duration_ms
    if args.tokens is not None or args.duration_ms is not None:
        a["measured"] = "by hand"
    a["updated"] = now()
    unfinished = UNFINISHED.search(" ".join(filter(None, [a.get("report"), args.log]))) if a["status"] == "done" else None
    if unfinished and (args.status == "done" or args.report is not None):
        sys.stderr.write(f"state: {a['id']} is done, but its report reads as unfinished (\"{unfinished.group(0)}\"). Done means its "
                         f"completion criterion was met; one that ended short is `--status stopped` with the reason, or `blocked` "
                         f"with a roadblock when it waits on someone.\n")
    if args.step:
        follow = {"running": "current", "done": "done", "blocked": "blocked"}.get(a["status"])
        set_step(state, args.step, follow, a["id"])
    if args.log:
        kind = {"blocked": "blocked", "done": "reported", "failed": "reported", "stopped": "note"}.get(a["status"], "note")
        log(state, kind, args.log, a["id"], args.important or a["status"] == "failed")
    shared_overlap(state, a, args)
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
    if args.agent and not known(state, args.agent):
        fail(f"unknown agent '{args.agent}'")
    if args.decision:
        args.decision = open_decision(state, args.decision)["id"]  # a number (D3) is kept as the id it names
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
    if args.needs == "user" and not (args.decision if args.decision is not None else r.get("decision")):  # L8: as a new one does
        fail("a roadblock that needs the user names what it asks: record the `decision` first, then pass --decision ID")
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


def unfenced_lines(manual: str) -> int:
    """The number of non-empty lines of a --manual that has more than one and no fence; 0 when it is fine."""
    if "```" in manual:
        return 0
    lines = len([line for line in manual.split("\n") if line.strip()])
    return lines if lines > 1 else 0


def check_kind(d: dict, manual_given: bool) -> None:
    """What each kind's answer control shows has to be there; manual_given: the --manual is this command's, so its format is checked."""
    if d["kind"] == "grill" and "questions" not in d:
        fail("a grilling is asked with the grill command: `grill ID --title T --ask \"TITLE | QUESTION | RECOMMENDATION | WHY\"`")
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
    unfenced = unfenced_lines(d["manual"]) if d["kind"] in ("secret", "action") and manual_given else 0
    if unfenced:
        fail(f"--manual has {unfenced} lines and no fence: put the commands in a fenced block (a line ```nu, the commands, a line ```),"
             " any prose outside it")
    if d["kind"] in ("secret", "action") and manual_given:
        check_nu(d["manual"] or "")
    if d["kind"] == "action" and (d["options"] or d["recommend"]):
        fail("an action is a step only the user takes, with no options to choose: a yes or no on what the fleet would do is a decision (--kind decision, with the options and --recommend)")


QUESTION_MAX = 400   # characters: the ask alone, one or two sentences (fleet/SPEC.md, decision); 95% of the asks recorded fit
QUESTION_NEAR = 300  # a question this long with no body is warned about
CONSEQUENCE_MAX = 160  # an option's consequence over this is warned about: one sentence


def check_question(question: str | None, kind: str | None) -> None:
    """A --question over QUESTION_MAX characters is refused: the plan, the settings and the numbers go in --body.
    A permission's question, which the hook writes from the refused call, is not checked."""
    if question is None or kind == "permission" or len(question) <= QUESTION_MAX:
        return
    fail(f"--question is {len(question)} characters, {len(question) - QUESTION_MAX} over the {QUESTION_MAX} a question holds: "
         "keep the ask, one or two plain sentences, and move the plan, the settings and the numbers into --body FILE "
         "(an HTML fragment: In short, What you're deciding, The plan, Settings, Cost and risk, How to undo, "
         "What happens after you answer)")


WHY_REFUSED = 400  # characters: a --why over this is refused; one or two lines, the plan goes in --body
WHY_MAX = 200  # a why over this is warned about: one line on why it needs the user, and what it blocks or assumes
JARGON = ("sha1", "sha256", "digest", "stage cache", "alias", "uuid", "idempotent", "upsert", "blob", "enum",
          "turn gate", "gold", "harness", "rubric", "jev")
# A word that may name a worker: letters, digits, '_' and '-', standing alone (b333, invoice-gen).
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]+")


def check_why(why: str | None, kind: str | None) -> None:
    """A --why over WHY_REFUSED characters is refused: what the fleet does meanwhile, or why this needs the user,
    in one or two lines; the plan goes in --body. A permission's is not checked."""
    if why is None or kind == "permission" or len(why) <= WHY_REFUSED:
        return
    fail(f"--why is {len(why)} characters, {len(why) - WHY_REFUSED} over the {WHY_REFUSED} a why holds: say in one or two lines "
         "what the fleet does meanwhile, or why this needs the user, and move the plan, its parts and the cost into --body FILE")


def workers_of(state: dict) -> set[str]:
    """The fleet's workers as the ledger records them: every agent row's id and name, lower-cased."""
    return {str(v).lower() for a in state.get("agents", []) for v in (a.get("id"), a.get("name")) if v}


def worker_ids(texts: list[str], workers: set[str]) -> list[str]:
    """The words of `texts` that are a worker's id or name in the ledger, each once, in the order found."""
    return list(dict.fromkeys(m for t in texts for m in TOKEN_RE.findall(t) if m.lower() in workers))


def worker_warning(what: str, found: list[str]) -> str:
    return (f"state: {what} names workers ({', '.join(found)}): say what the work is (\"the fixes for the timeline "
            "questions in the Lavínia case\"); a worker's id or name means nothing to the user.")
JARGON_RE = re.compile(r"\b(" + "|".join(re.escape(w) for w in JARGON) + r")\b", re.I)
BASHISMS = (("&&", re.compile(r"&&")), ("export X=", re.compile(r"^\s*export\s+\w+=", re.M)),
            ("$(...)", re.compile(r"\$\(")), ("2>&1", re.compile(r"2>&1")))
FENCE_OPEN = re.compile(r"^ {0,3}(`{3,})[ \t]*([^`\s]*)")


def nu_blocks(manual: str) -> list[str]:
    """The fenced blocks of a --manual tagged nu (or nushell), in order; an unclosed fence runs to the end."""
    out, lines, i = [], manual.split("\n"), 0
    while i < len(lines):
        m = FENCE_OPEN.match(lines[i])
        if not m:
            i += 1
            continue
        run, lang, body = m.group(1), m.group(2).lower(), []
        i += 1
        while i < len(lines) and not (lines[i].strip().startswith(run) and set(lines[i].strip()) == {"`"}):
            body.append(lines[i])
            i += 1
        i += 1
        if lang in ("nu", "nushell"):
            out.append("\n".join(body))
    return out


def nu_parse_error(block: str) -> str | None:
    """Why `block` does not parse in nushell (`nu-check --debug`), or None when it parses or no nu is on PATH."""
    if not shutil.which("nu"):
        return None
    try:
        done = subprocess.run(["nu", "--no-config-file", "--stdin", "-c", "$in | nu-check --debug"], input=block,
                              capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode == 0:
        return None
    found = re.findall(r"Found : (.*)", done.stderr + done.stdout)
    return found[-1].strip() if found else "a parse error"


def check_nu(manual: str) -> None:
    """Each ```nu block of a --manual parses in nushell, when nu is on PATH: Luiz runs it in his shell."""
    for n, block in enumerate(nu_blocks(manual), 1):
        why = nu_parse_error(block)
        if why:
            fail(f"--manual's nu block {n} does not parse in nushell (nu-check --debug: {why}): "
                 "write it so it runs in Luiz's shell, or tag the block with the language it is in")


# What reads as needing a picture (coordinator SKILL.md, Decisions, the show-me triggers): parts that talk to each
# other, or three or more amounts to weigh; a body with an <svg>, a <table> or an <img> has one.
ARCHITECTURE_RE = re.compile(r"\b(database|graph|neo4j|postgres|pipeline|stored in|lives in|queue)s?\b", re.I)
AMOUNT_RE = re.compile(r"(?:US\$|R\$|\$|€)\s?\d[\d.,]*|\d+(?:[.,]\d+)?\s?%")
VISUAL_RE = re.compile(r"<(?:svg|table|img)\b", re.I)


# A past answer of the user's, referred to: it names its decision's number (D18) in the same sentence.
PAST_RE = re.compile(r"\b(you decided|you said|you chose|your rule|as decided|you approved)\b", re.I)
NUMBER_RE = re.compile(r"\b[DAIG]\d+\b")
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|\n+")


def unnamed_past_warning(what: str, texts: list[str], body: str) -> str | None:
    """The warning for `what` when a sentence of its words refers to what the user decided or said with no
    decision number in it."""
    found: list[str] = []
    for text in [*texts, re.sub(r"<[^>]*>", " ", body)]:
        for sentence in SENTENCE_RE.split(text):
            if not NUMBER_RE.search(sentence):
                found += [m.group(1).lower() for m in PAST_RE.finditer(sentence)]
    if not found:
        return None
    said = ", ".join(f'"{w}"' for w in dict.fromkeys(found))
    return (f"state: {what} refers to what the user decided ({said}) with no decision number: name it in the same sentence, "
            "its number, when, and what was chosen (\"D18, 10-08: Claude over MCP stays read-only until per-person login\"); "
            "the page links the number.")


def body_text(root: Path, d: dict) -> str:
    """The body `d` carries, as written to DIR/decisions/ID.html; "" when it has none."""
    if not d.get("body"):
        return ""
    try:
        return (root / "decisions" / f"{d['id']}.html").read_text(errors="replace")
    except OSError:
        return ""


def visual_warning(what: str, texts: list[str], body: str) -> str | None:
    """The show-me warning for `what` when its words name parts that talk to each other or carry three or more
    amounts to compare, and its body has no picture."""
    if VISUAL_RE.search(body):
        return None
    text = "\n".join([*texts, re.sub(r"<[^>]*>", " ", body)])
    words = list(dict.fromkeys(m.group(1).lower() for m in ARCHITECTURE_RE.finditer(text)))
    amounts = len(AMOUNT_RE.findall(text))
    said = ([", ".join(words)] if words else []) + ([f"{amounts} amounts to compare"] if amounts >= 3 else [])
    if not said:
        return None
    return (f"state: {what} looks like it needs a visual ({'; '.join(said)}): see coordinator SKILL.md #decisions "
            "(show-me triggers): a small inline SVG of the parts, a table of the numbers, in --body.")


def readability_warnings(d: dict, given: set, root: Path | None = None, workers: set | None = None) -> list[str]:
    """What the CLI says, without refusing, about a decision hard to read; `given`: the fields this command wrote."""
    if d["kind"] in ("permission", "grill"):
        return []
    out = []
    q = d.get("question") or ""
    if "question" in given and len(q) > QUESTION_NEAR and not d.get("body"):
        out.append(f"state: {d['id']}'s question is {len(q)} characters and it has no --body: say the ask in one or two "
                   "sentences and put the plan, the settings and the numbers in --body FILE.")
    words = sorted({w.lower() for w in JARGON_RE.findall(q)}, key=lambda w: JARGON.index(w))
    if "question" in given and words:
        out.append(f"state: {d['id']}'s question uses words the user may not know ({', '.join(words)}): "
                   "say what they mean in the domain's words, or leave them to the body.")
    found = worker_ids([d.get(k) or "" for k in ("title", "question", "reason") if k in given], workers or set())
    if found:
        out.append(worker_warning(d["id"], found))
    why = d.get("why") or ""
    if "why" in given and len(why) > WHY_MAX:
        out.append(f"state: {d['id']}'s why is {len(why)} characters: say in one line why it needs the user, and what it "
                   "blocks or assumes meanwhile; the rest goes in --body.")
    long = [o for o in d.get("options") or [] if len(o.get("consequence") or "") > CONSEQUENCE_MAX]
    if "option" in given and long:
        said = ", ".join(f"{o['id']} ({len(o['consequence'])})" for o in long)
        out.append(f"state: {d['id']}'s consequences over {CONSEQUENCE_MAX} characters: {said}. Say each in one sentence; "
                   "the detail goes in --body, and a setting the user may change on its own is its own option or decision.")
    if "manual" in given:
        nu = "\n".join(nu_blocks(d.get("manual") or ""))
        found = [name for name, pattern in BASHISMS if pattern.search(nu)]
        if found:
            out.append(f"state: {d['id']}'s manual has bash in a nu block ({', '.join(found)}): Luiz's shell is nushell "
                       "(`;` or `and`, `$env.X = ...`, `(...)`, `o+e>|`).")
    if given & {"question", "why", "body"} and root is not None:
        past = unnamed_past_warning(d["id"], [d.get("question") or "", d.get("why") or ""], body_text(root, d))
        if past:
            out.append(past)
    if d["kind"] == "decision" and given & {"question", "why", "body"} and root is not None:
        visual = visual_warning(d["id"], [d.get("question") or "", d.get("why") or ""], body_text(root, d))
        if visual:
            out.append(visual)
    return out


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


def unheld(d: dict) -> None:
    """The decision is no longer held by the fleet: re-presented, closed, or the hold taken back."""
    d.pop("held", None)
    d.pop("held_at", None)


def close(state, d: dict, status: str, answer: str | None, resolution: str) -> None:
    d.update(status=status, answer=answer, resolution=resolution, closed=now())
    unheld(d)
    if status == "decided":
        log(state, "decision", f"{d['title']}: {answer} ({resolution})", d["agent"], decision=d["id"])
    else:
        log(state, "resolved", f"{d['title']} withdrawn: {resolution}", d["agent"], decision=d["id"])
    for r in state["roadblocks"]:
        if r.get("decision") == d["id"] and not r["resolved"]:
            resolve(state, r)


FIELDS = ("kind", "title", "question", "why", "recommend", "reason", "secret", "manual", "agent", "step", "milestone")


def place_of(state: dict, d: dict, args) -> None:
    """Tie a decision to the work it came from: a step of the plan (which implies its milestone), a
    milestone, a worker (which implies its milestone). Refused when the step or milestone is unknown."""
    step = getattr(args, "step", None)
    milestone = getattr(args, "milestone", None)
    if step:
        m = next((x for x in state["roadmap"] if find(x["steps"], step)), None)
        if m is None:
            fail(f"unknown step '{step}'")
        d["step"], d["milestone"] = find(m["steps"], step)["id"], m["id"]
    if milestone:
        if not find(state["roadmap"], milestone):
            fail(f"unknown milestone '{milestone}' (the roadmap has: {', '.join(x['id'] for x in state['roadmap']) or 'none'})")
        d["milestone"] = milestone
    if d.get("agent") and not d.get("milestone"):
        a = find(state["agents"], d["agent"])
        d["milestone"] = (a or {}).get("milestone")


def cmd_decision(state, args):
    rows = state.setdefault("decisions", [])
    d = decisions.find(state, args.id)
    if args.decide is not None and not args.resolution:
        fail("--decide says what was chosen and --resolution how it came (\"answered on the page (#14)\", \"said in the session\")")
    if args.agent and not known(state, args.agent):
        fail(f"unknown agent '{args.agent}'")
    if d is None and (args.hold is not None or args.unhold):
        fail(f"unknown decision '{args.id}'")
    if d is not None and d["status"] != "open":
        only_place = (args.step is not None or args.milestone is not None) and not any(
            getattr(args, k) is not None for k in FIELDS if k not in ("step", "milestone")) and not args.option and not args.body \
            and args.decide is None and args.withdraw is None and args.hold is None and not args.unhold
        if only_place:  # where it came from is not what was decided: it can be said of a closed one too
            place_of(state, d, args)
            return state
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
            args.supersedes = old["id"]  # a number (D3) is kept as the id it names
        made_elsewhere = args.decide is not None
        require(args, ["title", "question"] if made_elsewhere else ["kind", "title", "question", "why"], "decision")
        check_question(args.question, args.kind or "decision")
        check_why(args.why, args.kind or "decision")
        d = {"id": args.id, "kind": args.kind or "decision", "title": args.title, "question": args.question,
             "why": args.why, "blocking": bool(args.blocking), "agent": args.agent or None,
             "options": parse_options(args.option or []), "recommend": args.recommend, "reason": args.reason,
             "secret": args.secret, "manual": args.manual, "body": False, "page": not made_elsewhere,
             "supersedes": args.supersedes, "status": "open", "answer": None, "resolution": None, "change": None,
             "asks": args.asks or "user", "opened": now(), "revised": None, "closed": None, "step": None, "milestone": None}
        place_of(state, d, args)
        if not made_elsewhere:
            check_kind(d, True)
            set_body(Path(args.dir).resolve(), d, args)
            for warning in readability_warnings(d, {k for k in ("question", "why", "manual", "title", "reason", "body") if getattr(args, k) is not None} | ({"option"} if args.option else set()),
                                                   Path(args.dir).resolve(), workers_of(state)):
                sys.stderr.write(warning + "\n")
            for_manager = d["asks"] == "manager"   # the manager looks first: the user is not called yet
            log(state, "asked", f"{'For the manager: ' if for_manager else ''}{d['title']}: {d['question']}", d["agent"],
                d["blocking"] and not for_manager, d["id"])
        rows.append(d)
        if not made_elsewhere:
            print(f"asked {d['id']}. Arm its answer's wake now, as a background command (run_in_background): "
                  f"`{FLEET} chat {Path(args.dir).resolve()} wait {d['id']}`: "
                  f"it exits with the user's answer the moment it is given.")
    else:
        if args.supersedes:
            fail("--supersedes is given when the new decision is opened")
        if args.unhold and not d.get("held"):
            fail(f"{d['title']} is not held: --unhold takes back a --hold")
        if args.hold is not None and not args.hold.strip():
            fail("--hold says what the fleet does first, before the item comes back to the user")
        asks_anew = args.question is not None and args.question != d["question"]
        if asks_anew and (args.kind or d["kind"]) == "decision" and not args.option and not args.same_options:
            fail("the question changed, and the options on the page would be the old question's: give them again "
                 "(--option, once per option, with --recommend and --reason), or pass --same-options when they still answer it")
        check_question(args.question, args.kind or d["kind"])
        check_why(args.why, args.kind or d["kind"])
        changed = [k for k in FIELDS if getattr(args, k) is not None] + [k for k in ("option", "body") if getattr(args, k)]
        before = {**{k: d.get(k) for k in FIELDS}, "option": d.get("options"), "blocking": d.get("blocking")}
        for key in FIELDS:
            if key in ("step", "milestone"):
                continue
            if getattr(args, key) is not None:
                d[key] = getattr(args, key) or None
        if args.step is not None or args.milestone is not None:
            place_of(state, d, args)
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
        check_kind(d, args.manual is not None)
        set_body(Path(args.dir).resolve(), d, args)
        for warning in readability_warnings(d, {k for k in ("question", "why", "manual", "title", "reason", "body") if getattr(args, k) is not None} | ({"option"} if args.option else set()),
                                                   Path(args.dir).resolve(), workers_of(state)):
            sys.stderr.write(warning + "\n")
        if any(k in changed for k in ("question", "option", "manual")) and not args.log and args.decide is None and args.withdraw is None:
            sys.stderr.write(f"state: {d['id']} was asked again with new words and no --log: say what changed in one line "
                             "(--log \"...\"); the page's history shows it, and the user should not have to compare two versions.\n")
        if changed:
            d["revised"], d["change"] = now(), args.log or None
            moved = [k for k in changed if k not in before or before[k] != (d.get("options") if k == "option" else d.get(k))]
            text = f"{d['title']} now asks you: {d['question']}" if passed_on else \
                f"{d['title']} changed: {args.log or ', '.join(moved) or 'nothing new (the same values given again)'}"
            log(state, "asked", text, d["agent"], passed_on and d["blocking"], d["id"])
            if any(k in changed for k in ("question", "option", "manual")):
                unheld(d)  # re-presented with new words: back on the user's list
        if args.hold is not None:
            d["held"], d["held_at"] = args.hold, now()
            log(state, "note", f"{d['title']} held by the fleet: {args.hold}", d["agent"], decision=d["id"])
        elif args.unhold:
            unheld(d)
            log(state, "note", f"{d['title']} no longer held by the fleet", d["agent"], decision=d["id"])
    failed = decisions.failed_answer(d, chat.read(Path(args.dir).resolve())) if args.decide is not None else None
    if failed:
        fail(f"{d['title']} failed for the user (#{failed['id']}: {decisions.failure_words(failed)}) and is not done: "
             "revise it with a fix and re-present it (--manual, --question), or --withdraw \"why\"")
    if args.decide is not None:
        close(state, d, "decided", args.decide, args.resolution)
    elif args.withdraw is not None:
        close(state, d, "withdrawn", None, args.withdraw)
    return state


def _q(text: str, what: str) -> tuple[str, str]:
    """ "Q3: rest" as ("q3", "rest")."""
    head, sep, rest = text.partition(":")
    if not sep or not re.fullmatch(r"[Qq]\d+", head.strip()):
        fail(f"{what} starts with the question's number: \"Q3: ...\"")
    return head.strip().lower(), rest.strip()


def _asked(text: str) -> tuple[str, str, str, str]:
    parts = [x.strip() for x in text.split("|")]
    if len(parts) != 4 or not all(parts):
        fail("--ask takes \"title | the question, with its choices and what each leads to | your recommended answer | "
             "why: the reason and the evidence for it, and what it costs or rules out\"")
    return parts[0], parts[1], parts[2], parts[3]


GRILL_REASON_MAX = 200  # characters: a grilling question's reason over this is warned about, one plain sentence
GRILL_OPTIONS_MAX = 4  # a grilling question with more options than this is warned about
# What reads as a source, not a reason: a path with a line (store.ts:5-9), an ADR, a decision's number (D27).
SOURCE_RE = re.compile(r"(?<![A-Za-z0-9_])(?:[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?|ADR[- ]?\d+|D\d+)(?![A-Za-z0-9_])")


def first_sentence(text: str) -> str:
    """`text` up to the first sentence end (., ! or ? and a space)."""
    return re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]


def _option(text: str) -> tuple[str, dict]:
    """ "Q1 a: label | consequence" as ("q1", {"id", "label", "consequence"})."""
    head, colon, rest = text.partition(":")
    m = re.fullmatch(r"\s*([Qq]\d+)\s+(\S+)\s*", head)
    label, bar, consequence = rest.partition("|")
    label, consequence = label.strip(), consequence.strip()
    if not (colon and m and bar and label and consequence and decisions.ID.fullmatch(m.group(2))):
        fail(f"--option reads \"Q1 a: label | consequence\", got {text!r}")
    return m.group(1).lower(), {"id": m.group(2), "label": label, "consequence": consequence}


def grill_warnings(d: dict, q: dict, asked: bool, reason: bool, options: bool, workers: set) -> list[str]:
    """What the CLI says, without refusing, about a grilling question hard to read: a worker's id in its
    title, question or reason (those this command wrote), its reason long or opening with a source, its
    options (when written) long or too many."""
    out, qid, why = [], q["id"].upper(), q.get("reason") or ""
    found = worker_ids([q.get(k) or "" for k in ("title", "body") if asked] + ([why] if reason else []), workers)
    if found:
        out.append(worker_warning(f"{d['id']}'s {qid}", found))
    if reason and len(why) > GRILL_REASON_MAX:
        out.append(f"state: {d['id']}'s {qid} reason is {len(why)} characters: say the trade-off in one plain sentence "
                   f"(over {GRILL_REASON_MAX} is hard to read on a phone); the evidence goes in --body.")
    found = list(dict.fromkeys(SOURCE_RE.findall(first_sentence(why)))) if reason else []
    if found:
        out.append(f"state: {d['id']}'s {qid} reason opens with sources ({', '.join(found)}): say the trade-off in plain "
                   "words first; files, lines, ADRs and decision numbers go after it, or in --body.")
    opts = (q.get("options") or []) if options else []
    long = [o for o in opts if len(o["consequence"]) > CONSEQUENCE_MAX]
    if long:
        said = ", ".join(f"{o['id']} ({len(o['consequence'])})" for o in long)
        out.append(f"state: {d['id']}'s {qid} consequences over {CONSEQUENCE_MAX} characters: {said}. Say each in one line; "
                   "the detail goes in --body.")
    if len(opts) > GRILL_OPTIONS_MAX:
        out.append(f"state: {d['id']}'s {qid} has {len(opts)} options: give 2 to {GRILL_OPTIONS_MAX}; a choice the user "
                   "makes on its own is a question of its own.")
    return out


def cmd_grill(state, args):
    """A grilling: a round of numbered questions, each with its recommendation, answered one by one on
    the page. Questions are added round by round (follow-ups under what they follow), answered as
    the answers come, dropped when they stop mattering, and the grilling is done when none is open."""
    d = decisions.find(state, args.id)
    created = d is None
    if d is not None and d["kind"] != "grill":
        fail(f"{args.id} is a {d['kind']}, not a grilling")
    if d is not None and d["status"] != "open":
        fail(decisions.closed_because(d))
    check_why(args.why, "grill")
    renamed = []  # what of the grilling itself this command moved: its title, its why
    if d is not None:
        if args.title is not None and not args.title.strip():
            fail("--title is empty: a grilling keeps a title")
        for key in ("title", "why"):
            value = getattr(args, key)
            if value is not None and value != d.get(key):
                d[key] = value or None
                renamed.append(key)
    if d is None:
        if not decisions.ID.fullmatch(args.id):
            fail(f"grilling id {args.id!r} should be letters, digits, '_', '.', or '-'")
        if not args.title or not args.ask:
            fail("a new grilling needs --title and its first round (--ask, once per question)")
        d = {"id": args.id, "kind": "grill", "title": args.title, "question": "", "why": args.why, "blocking": bool(args.blocking),
             "agent": args.agent or None, "options": [], "recommend": None, "reason": None, "secret": None, "manual": None,
             "body": False, "page": True, "supersedes": None, "status": "open", "answer": None, "resolution": None,
             "change": None, "asks": "user", "opened": now(), "revised": None, "closed": None, "questions": [],
             "step": None, "milestone": None}
        if args.agent and not known(state, args.agent):
            fail(f"unknown agent '{args.agent}'")
        state.setdefault("decisions", []).append(d)
    if args.step or args.milestone or (created and d.get("agent")):
        place_of(state, d, args)
    qs = d["questions"]
    byid = {q["id"]: q for q in qs}
    if args.of and args.of.lower() not in byid:
        fail(f"--of {args.of}: no such question in {d['id']}")
    for text in args.answer or []:
        qid, answer = _q(text, "--answer")
        if qid not in byid:
            fail(f"no question {qid.upper()} in {d['id']}")
        byid[qid].update(status="answered", answer=answer, answered=now())
    for text in args.drop or []:
        qid, reason = _q(text, "--drop")
        if qid not in byid:
            fail(f"no question {qid.upper()} in {d['id']}")
        byid[qid].update(status="dropped", answer=None, dropped=reason, answered=now())
    long_asks = []  # (Q id, characters) of a question asked or revised over QUESTION_NEAR: warned once the round is taken
    for text in args.revise or []:
        qid, rest = _q(text, "--revise")
        if qid not in byid:
            fail(f"no question {qid.upper()} in {d['id']}")
        title, body, rec, why = _asked(rest)
        if len(body) > QUESTION_NEAR:
            long_asks.append((qid, len(body)))
        byid[qid].update(title=title, body=body, recommend=rec, reason=why, status="open", answer=None, asked=now())
    for text in args.reason or []:
        qid, why = _q(text, "--reason")
        if qid not in byid or not why:
            fail(f"--reason \"Q3: why\": no question {qid.upper()} in {d['id']}, or no reason given")
        byid[qid]["reason"] = why
    new = []
    for text in args.ask or []:
        title, body, rec, why = _asked(text)
        q = {"id": f"q{len(qs) + 1}", "title": title, "body": body, "recommend": rec, "reason": why, "of": args.of.lower() if args.of else None,
             "status": "open", "answer": None, "asked": now()}
        qs.append(q)
        new.append(q)
        if len(body) > QUESTION_NEAR:
            long_asks.append((q["id"], len(body)))
    byid = {q["id"]: q for q in qs}  # the new questions too
    given_options: dict[str, list[dict]] = {}
    for text in args.option or []:
        qid, option = _option(text)
        if qid not in byid:
            fail(f"--option {qid.upper()}: no question {qid.upper()} in {d['id']}")
        if byid[qid]["status"] != "open":
            fail(f"--option {qid.upper()}: {qid.upper()} is {byid[qid]['status']}; options are for an open question")
        if find(given_options.setdefault(qid, []), option["id"]):
            fail(f"{qid.upper()}'s option '{option['id']}' is given twice")
        given_options[qid].append(option)
    for qid, options in given_options.items():
        if len(options) < 2:
            fail(f"{qid.upper()} has one option: give at least two (--option \"{qid.upper()} a: label | consequence\", once per option)")
        byid[qid]["options"] = options
    asked_now = {q["id"] for q in new} | {_q(t, "--revise")[0] for t in args.revise or []}
    for q in qs:
        if (q["id"] in asked_now or q["id"] in given_options) and q.get("options") and not find(q["options"], q.get("recommend") or ""):
            fail(f"{q['id'].upper()}'s recommendation {q.get('recommend')!r} is not one of its options "
                 f"({', '.join(o['id'] for o in q['options'])}): recommend by the option's id")
    set_body(Path(args.dir).resolve(), d, args)
    open_ = [q for q in qs if q["status"] == "open"]
    d["question"] = f"{len(open_)} question{'s' if len(open_) != 1 else ''} to answer" if open_ else "Every question is answered"
    for qid, n in long_asks:
        sys.stderr.write(f"state: {d['id']}'s {qid.upper()} is {n} characters: ask it in one plain sentence, its choices "
                         "as --option; the evidence goes in --body.\n")
    reasoned = asked_now | {_q(t, "--reason")[0] for t in args.reason or []}
    for q in qs:
        for warning in grill_warnings(d, q, q["id"] in asked_now, q["id"] in reasoned, q["id"] in asked_now or q["id"] in given_options, workers_of(state)):
            sys.stderr.write(warning + "\n")
    if asked_now or args.why is not None or args.body:
        past = unnamed_past_warning(d["id"], [d.get("why") or "", *(t for q in qs if q["id"] in asked_now for t in (q.get("body") or "", q.get("reason") or ""))],
                                    body_text(Path(args.dir).resolve(), d))
        if past:
            sys.stderr.write(past + "\n")
        visual = visual_warning(d["id"], [d.get("why") or "", *(q.get("body") or "" for q in qs if q["id"] in asked_now)],
                                body_text(Path(args.dir).resolve(), d))
        if visual:
            sys.stderr.write(visual + "\n")
    if new and created:
        print(f"asked {d['id']}. Arm its answers' wake now, as a background command (run_in_background): "
              f"`{FLEET} chat {Path(args.dir).resolve()} wait {d['id']}`; arm it again after each round.")
    context = bool(args.body or args.no_body)
    if new or args.revise or args.reason or given_options or context or renamed:
        if not created:
            d["revised"] = now()  # the page shows the round as new since the viewer last looked
            d["change"] = args.log or None
        if new or args.revise:
            unheld(d)  # a new round re-presents it
        moved = ", ".join(f"the {k} changed" for k in (*renamed, *(["context"] if context else [])))
        words = f"{len(new)} new question{'s' if len(new) != 1 else ''}" if new else "a question revised" if args.revise else \
            "options given" if given_options else "reasons added" if args.reason else moved
        log(state, "asked", f"{d['title']}: {args.log or words}", d["agent"], d["blocking"], d["id"])
    if args.done is not None:
        if open_:
            fail(f"{', '.join(q['id'].upper() for q in open_)} still open: answer them, drop them, or ask what is left")
        close(state, d, "decided", args.done, "grilling finished")
    return state


def cmd_event(state, args):
    if args.agent and not known(state, args.agent):
        fail(f"unknown agent '{args.agent}'")
    log(state, args.kind or "note", args.text, args.agent, args.important)
    return state


CHEATSHEET = f"""
commands (fleet state DIR <command>; an unknown ID creates the row, a known ID changes the fields given):
  set [--status {"|".join(STATUSES)}] [--now TEXT] [--goal G] [--workspaces {"|".join(WORKSPACE_MODES)}]
  milestone ID --title T
  step ID --milestone M --title T [--status {"|".join(STEP_STATUSES)}] [--agent A]
        [--before STEP | --after STEP] [--remove REASON]
  agent ID --task T --milestone M [--name N] [--skill {"|".join(SKILLS)}] [--model {"|".join(MODELS)}]
        [--effort {"|".join(EFFORTS)}] [--lane PATH...] [--step S] [--brief B] [--status {"|".join(AGENT_STATUSES)}]
        [--task-id ID | --tokens N --duration-ms N] [--report R] [--log TEXT] [--important]
  roadblock ID --title T --detail D --severity {"|".join(SEVERITIES)} --needs {"|".join(NEEDS)} [--agent A]
        [--decision D] [--resolved | --open]
  decision ID --kind {"|".join(decisions.KINDS)} --title T --question Q --why W [--blocking | --not-blocking]
        [--option "KEY: label | consequence"]... [--same-options] [--recommend R --reason WHY] [--secret NAME] [--manual TEXT]
        [--body FILE | --no-body] [--agent A] [--supersedes ID] [--log TEXT] [--asks {"|".join(decisions.ASKS)}]
        [--decide ANSWER --resolution HOW | --withdraw REASON | --hold REASON | --unhold]
        --manual: its commands in a fenced block (```nu), any prose outside it; one bare command line needs none
        --question: the ask alone, up to 400 characters; a plan, settings or numbers go in --body (SKILL.md, Decisions)
  event [--kind {"|".join(KINDS)}] [--agent A] [--important] TEXT   (a note is `event --kind note TEXT`)
  park [--agent A]... REASON     stop every live worker row (or those named) in one command
  keep ID [TEXT | --drop REASON] what must outlive a compaction: a queued ask, a hunk, a workspace
  link ID --url U --title T [--kind dev|page] [--decision D] [--note N] | --drop R   a dev server or a purpose-built page
  grill ID --title T --ask "TITLE | QUESTION | RECOMMENDATION | WHY"... [--of Q]   a grilling round, answered on the page
        [--option "Q1 a: label | consequence"]... (RECOMMENDATION is then an option's id) [--body FILE | --no-body]
        [--title T] [--why W] [--log TEXT] on an open grilling: its title, why or context revised, --log saying what changed
        [--answer "Q3: ..."] [--drop "Q4: why"] [--revise "Q3: T | Q | R | W"] [--reason "Q3: why"] [--done SUMMARY]
  step next --milestone M --title T   the next free step id, printed
  show
  --no-render on any command writes state.json without rendering; -q renders without saying so"""


def cmd_show(state, args):
    role = ", manager" if state.get("role") == "manager" else ""
    shared = ", shared working copy" if state.get("workspace_mode") == "shared" else ""
    print(f"{state['project']} [{state['status']}{role}{shared}] {state['now']}")
    for m in state["roadmap"]:
        done = sum(s["status"] == "done" for s in m["steps"])
        print(f"  {m['id']} {m['title']} ({done}/{len(m['steps'])})")
        for s in m["steps"]:
            print(f"    {s['id']:<6} {s['status']:<8} {s['title']}" + (f"  @{s['agent']}" if s.get("agent") else ""))
    for a in state["agents"]:
        rounds = f"  round {a['rounds']}" if a.get("rounds", 1) > 1 else ""
        print(f"  agent {a['id']:<16} {a['status']:<8} {a['skill']:<15} {a['model']:<6} {a.get('effort') or '-':<6} {a['tokens']:>8} tok  lane={','.join(a['lane']) or '-'}{rounds}")
    for r in state["roadblocks"]:
        print(f"  {r.get('ref', '')} roadblock {r['id']} {'resolved' if r['resolved'] else 'OPEN'} [{r['severity']}, needs {r['needs']}] {r['title']}")
    said = chat.read(Path(args.dir).resolve())  # the chat tells an action the user answered as failed
    for d in state.get("decisions", []):
        status = ("OPEN, blocking" if d.get("blocking") else "OPEN") if d["status"] == "open" else d["status"]
        if d["status"] == "open" and d.get("asks") == "manager":
            status += ", with the manager"
        if d["status"] == "open" and d.get("held"):
            status += f", held by the fleet ({d['held']})"
        if decisions.answered_grill(d):
            status += ", answered, waiting to be recorded"
        failed = decisions.failed_answer(d, said)
        if failed:
            status += f", failed for the user (#{failed['id']}: {decisions.failure_words(failed)})"
        outcome = d.get("answer") or d.get("resolution")
        print(f"  {d.get('ref', '')} decision {d['id']} {status} [{d['kind']}] {d['title']}" + (f": {outcome}" if outcome else ""))
    for link in state.get("links", []):
        print(f"  {link.get('ref', '')} link {link['id']} [{link['kind']}] {link['title']}: {link['url']}")
    for k in state.get("kept", []):
        print(f"  kept {k['id']}: {k['text']}")
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
        path.write_text(template.replace("{fleet}", str(FLEET)).replace("{skill_dir}", str(skill)).replace("{dashboard_dir}", str(root)))
    standing = root / "standing.md"
    if state.get("role") == "manager" and not standing.exists():
        standing.write_text((skill / "assets" / "standing.md").read_text())


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fleet state", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dir", help="directory holding state.json and index.html")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init"); s.add_argument("--project", required=True); s.add_argument("--goal", required=True); s.add_argument("--now")
    s.add_argument("--role", choices=["coordinator", "manager"], help="manager: this ledger is the manager's, over every coordinator on the machine")
    s = sub.add_parser("set"); s.add_argument("--status", choices=STATUSES); s.add_argument("--now"); s.add_argument("--goal")
    s.add_argument("--workspaces", choices=WORKSPACE_MODES, help="isolated: a jj workspace per worker (the default); shared: one working copy, lanes disjoint")
    s = sub.add_parser("milestone"); s.add_argument("id"); s.add_argument("--title")
    s = sub.add_parser("step"); s.add_argument("id"); s.add_argument("--milestone"); s.add_argument("--title")
    s.add_argument("--status", choices=STEP_STATUSES); s.add_argument("--agent", help="agent id, or '' to clear")
    g = s.add_mutually_exclusive_group(); g.add_argument("--before", metavar="STEP"); g.add_argument("--after", metavar="STEP")
    g.add_argument("--remove", metavar="REASON", help="take out a step recorded in error; the log keeps the reason")
    s = sub.add_parser("agent"); s.add_argument("id")
    s.add_argument("--task"); s.add_argument("--skill", choices=SKILLS); s.add_argument("--model", choices=MODELS)
    s.add_argument("--effort", choices=EFFORTS, help="the thinking effort to spawn it at; with --model, defaults by its skill")
    s.add_argument("--lane", nargs="*", help="files or globs the worker may edit"); s.add_argument("--milestone")
    s.add_argument("--status", choices=AGENT_STATUSES); s.add_argument("--tokens", type=int); s.add_argument("--duration-ms", type=int)
    s.add_argument("--task-id", help="the id the Agent tool gave the worker: its tokens and duration are then read from its own transcript")
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
    s.add_argument("--same-options", action="store_true", help="with a new --question: the options still answer it")
    s.add_argument("--recommend", help="the option's KEY, or the value you would give"); s.add_argument("--reason")
    s.add_argument("--secret", metavar="NAME", help="the name the code expects, as in secretspec.toml")
    s.add_argument("--manual", help="the route the user can take by hand: its commands in a fenced block (```nu), any prose outside it;"
                   " one bare command line needs none")
    g = s.add_mutually_exclusive_group(); g.add_argument("--body", metavar="FILE", help="an HTML fragment with the evidence, copied to DIR/decisions/ID.html")
    g.add_argument("--no-body", action="store_true")
    s.add_argument("--agent", help="the worker that waits on it"); s.add_argument("--supersedes", metavar="ID")
    s.add_argument("--step", help="the step of the plan it came from (implies its milestone)")
    s.add_argument("--milestone", help="the milestone it came from, when no one step")
    s.add_argument("--log", help="what changed, shown to the user on the page")
    s.add_argument("--asks", choices=decisions.ASKS, help="who looks at it first: the user, or the manager when there is one")
    g = s.add_mutually_exclusive_group(); g.add_argument("--decide", metavar="ANSWER"); g.add_argument("--withdraw", metavar="REASON")
    g.add_argument("--hold", metavar="REASON", help="the user answered and the fleet works on it first: off the user's list until revised")
    g.add_argument("--unhold", action="store_true", help="take back a --hold")
    s.add_argument("--resolution", metavar="HOW", help="with --decide: how the answer came")
    s = sub.add_parser("event"); s.add_argument("text"); s.add_argument("--agent"); s.add_argument("--kind", choices=KINDS)
    s.add_argument("--important", action="store_true", help="the user should see this now: toast, sound, badge")
    s = sub.add_parser("grill"); s.add_argument("id"); s.add_argument("--title"); s.add_argument("--why")
    s.add_argument("--ask", action="append", metavar='"TITLE | QUESTION | RECOMMENDATION | WHY"', help="a question of this round (repeatable)")
    s.add_argument("--reason", action="append", metavar='"Q3: WHY"', help="the reason for a question's recommendation, given afterwards")
    s.add_argument("--of", metavar="Q", help="the questions asked here follow up on this one")
    s.add_argument("--answer", action="append", metavar='"Q3: ANSWER"'); s.add_argument("--drop", action="append", metavar='"Q4: WHY"')
    s.add_argument("--revise", action="append", metavar='"Q3: TITLE | QUESTION | RECOMMENDATION | WHY"')
    s.add_argument("--option", action="append", metavar='"Q1 a: label | consequence"',
                   help="an option of a question asked or open, once per option; given for a question, replaces its options")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--body", metavar="FILE", help="an HTML fragment with the context every question shares, copied to DIR/decisions/ID.html")
    g.add_argument("--no-body", action="store_true")
    s.add_argument("--blocking", action="store_true"); s.add_argument("--agent")
    s.add_argument("--step", help="the step of the plan it came from"); s.add_argument("--milestone")
    s.add_argument("--done", metavar="SUMMARY", help="every question is settled: what was agreed")
    s.add_argument("--log", help="what changed, shown to the user on the page")
    s = sub.add_parser("link"); s.add_argument("id"); s.add_argument("--url"); s.add_argument("--title")
    s.add_argument("--kind", choices=LINK_KINDS, help="dev: a dev server; page: a page made for a purpose")
    s.add_argument("--decision", help="the decision it serves: its page links here"); s.add_argument("--agent")
    s.add_argument("--note", help="what to do there"); s.add_argument("--drop", metavar="REASON")
    s = sub.add_parser("keep"); s.add_argument("id"); s.add_argument("text", nargs="?")
    s.add_argument("--drop", metavar="REASON", help="it no longer needs keeping")
    s = sub.add_parser("park"); s.add_argument("reason"); s.add_argument("--agent", action="append", help="only this worker (repeatable)")
    sub.add_parser("show")
    return p


def main(argv: list[str]) -> None:
    if len(argv) > 1 and argv[1] == "note":
        fail("there is no `note` command: a note is `event --kind note TEXT`")
    no_render, quiet = "--no-render" in argv, "-q" in argv
    args = build_parser().parse_args([a for a in argv if a not in ("--no-render", "-q")])
    args.no_render = no_render
    root = Path(args.dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / "state.json"
    state = json.loads(path.read_text()) if path.exists() else None
    if state is None and args.cmd != "init":
        fail(f"no state.json in {root}; run `init` first")

    handler = globals()[f"cmd_{args.cmd}"]
    said = io.StringIO()  # what the command says waits until the ledger is checked: a refused write says nothing (open-2)
    with contextlib.redirect_stdout(said):
        result = handler(state, args)
    seen = result or state
    for warning in (chat.deaf_warning(root) if args.cmd != "init" else None, stale_rows(seen), stale_now(seen, args),
                    *(unrecorded(root, seen) if args.cmd != "init" else []), left_open(seen, args), overlapping(seen, args), off_policy(seen, args)):
        if warning:
            sys.stderr.write(warning + "\n")
    if result is None:
        sys.stdout.write(said.getvalue())
        return
    measure(root, result)
    decisions.number(result)
    result["updated"] = now()
    render_dashboard.validate(result)
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    sys.stdout.write(said.getvalue())
    ensure_brief(root, result)
    if args.no_render:
        print(f"state.json updated ({args.cmd} {getattr(args, 'id', '')})".rstrip())
    elif quiet:
        with contextlib.redirect_stdout(io.StringIO()):
            render_dashboard.main([str(path), str(root / "index.html")])
    else:
        render_dashboard.main([str(path), str(root / "index.html")])


if __name__ == "__main__":
    main(sys.argv[1:])
