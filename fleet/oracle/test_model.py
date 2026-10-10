"""Model-based test of the fleet ledger (the testing ladder's rung 5).

A dumb in-memory model of the ledger (milestones and their steps, workers, decisions, roadblocks,
kept notes, links, the event count, the chat's messages) is driven by random command sequences
together with the real state and chat CLIs, through the oracle runner (run.py). After every step
the test checks the exit code the model predicts, that a refused command wrote nothing, that the
ledger's shape matches the model (a worker's model and effort among it), the warnings the model expects on stderr (a stale Now line, live
rows in a paused fleet, a chat nobody reads, a Now line naming a closed decision, lanes that meet, a
model or an effort outside the role table), the
refusal of lanes that meet in a fleet sharing one working copy (`set --workspaces shared`), `show` against
state.json, `inbox` against the model's open messages, and invariants that need no model: events
and chat only grow, numbers once given stay, a closed decision never changes.

    python3 -m unittest fleet/oracle/test_model.py          25 sequences x 60 steps, a fresh seed
    FLEET_MODEL_SEED=1234 python3 -m unittest ...           replay one sequence (the seed a failure prints)
    FLEET_MODEL_SEQS=200 FLEET_MODEL_STEPS=120 ...          a longer run
    FLEET_ORACLE_IMPL='{"state": "fleet state", ...}'       drive another implementation (stage 2)
    python3 fleet/oracle/test_model.py --export SEED [STEPS] a sequence as a trace, for the corpus

Where the Python code does something the SPEC calls accidental, the model follows it and says so
with `QUIRK(open-N)`, naming the entry in fleet/SPEC.md: the model pins today's behaviour, the SPEC
says which parts stage 2 may change.
"""
import copy
import json
import os
import random
import re
import shlex
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run  # noqa: E402

# The role table's values are read from the oracle, so a new table is one edit; the rules over it are the model's own.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "skills" / "productivity" / "coordinator" / "scripts"))
from state import ROLES  # noqa: E402

LIVE = {"running", "queued", "blocked"}
STALE_S = 30 * 60
ADVISOR_AFTER = 3  # choices asked of the user in a day after which a fleet with no advisor is told to start one
GRACE_S = 10 * 60
PREFIX = {"decision": "D", "action": "A", "input": "I", "secret": "S", "grill": "G"}
REF = re.compile(r"\b([DAISGLR]\d+)\b")
MENTION = re.compile(r"@([A-Za-z0-9_.-]+)")

MILESTONES = ["m1", "m2", "m3"]
STEPS = ["s1", "s2", "s3", "s4", "s5"]
AGENTS = ["a1", "a2", "a3", "A1"]              # A1 and a1 cannot both be: a mention could not tell them apart
NAMES = ["impl", "coordinator", "a2"]           # "coordinator" is the chat's; "a2" is another worker's id
DECISIONS = ["d1", "d2", "d3", "D1", "D2", "I1"]  # capitals are numbers when a row has them
ROADBLOCKS = ["r1", "r2", "R1"]
MODELS = ["opus", "sonnet", "haiku", "fable"]
POLICY_MODELS = tuple(ROLES["pairs"])  # L3: any other model is accepted with a warning
EFFORTS = ["low", "medium", "high", "xhigh", "max"]  # any pair outside ROLES["pairs"] is accepted with a warning
SKILLS = ["implement", "research", "none"]
KEPT = ["k1", "k2"]
LINKS = ["l1", "l2", "L1"]
# Lane entries, and which pairs meet (L7: some path matches both). A plain path covers what is under it; `*` stays
# in its segment. Each entry meets itself.
LANES = ["src/", "src/a.ts", "src/*.ts", "docs/", "lib/x.py"]
MEET = {frozenset(p) for p in [("src/", "src/a.ts"), ("src/", "src/*.ts"), ("src/a.ts", "src/*.ts")]}


def meet(x: str, y: str) -> bool:
    return x == y or frozenset((x, y)) in MEET
NOW_TEXTS = ["building", "waits on D1", "A1 next", "checking I1 and D2", "quiet"]


class Refused(Exception):
    """The model's prediction that the CLI refuses the command (exit 1)."""


class Model:
    def __init__(self):
        self.inited = False
        self.status, self.now, self.now_at, self.clock = "running", "", None, 0.0
        self.milestones: dict[str, list[str]] = {}
        self.steps: dict[str, dict] = {}
        self.agents: dict[str, dict] = {}
        self.decisions: dict[str, dict] = {}
        self.roadblocks: dict[str, dict] = {}
        self.kept: dict[str, str] | None = None
        self.links: dict[str, dict] | None = None
        self.events = 0
        self.messages: list[dict] = []
        self.mode: str | None = None  # `set --workspaces`: None until set, then "isolated" or "shared"

    # -- lookups ----------------------------------------------------------------------------------
    @staticmethod
    def find(rows: dict | None, key: str) -> str | None:
        """An id, else a number (`ref`), as state.py and decisions.py look rows up."""
        if not rows:
            return None
        if key in rows:
            return key
        return next((k for k, r in rows.items() if r.get("ref") == key), None)

    def milestone_of(self, step: str) -> str | None:
        return self.steps[step]["milestone"] if step in self.steps else None

    def log(self, n: int = 1) -> None:
        self.events += n

    # -- the state CLI ------------------------------------------------------------------------------
    def do(self, c: dict) -> None:
        getattr(self, "do_" + c["cmd"])(c)

    def do_init(self, c):
        if self.inited:
            raise Refused("state.json already exists")
        self.inited, self.now, self.now_at = True, "Intake in progress.", self.clock

    def do_note(self, c):
        raise Refused("there is no `note` command")

    def do_set(self, c):
        self.status = c.get("status", self.status)
        self.mode = c.get("workspaces", self.mode)
        if "now" in c:
            self.now, self.now_at = c["now"], self.clock

    def do_milestone(self, c):
        if c["id"] not in self.milestones:
            if "title" not in c:
                raise Refused("new milestone needs --title")
            self.milestones[c["id"]] = []

    def next_step_id(self, milestone: str) -> str:
        ids = self.milestones.get(milestone, [])
        letters = [re.match(r"[A-Za-z]+", x).group(0) for x in ids if re.match(r"[A-Za-z]+\d+$", x)]
        prefix = letters[-1] if letters else (milestone[0].lower() if milestone[:1].isalpha() else "s")
        used = [int(x[len(prefix):]) for x in self.steps if re.fullmatch(prefix + r"\d+", x)]
        return f"{prefix}{max(used, default=0) + 1}"

    def set_step(self, sid: str, status, agent) -> None:
        if sid not in self.steps:
            raise Refused(f"unknown step {sid}")
        if status:
            self.steps[sid]["status"] = status
        if agent is not None:
            self.steps[sid]["agent"] = agent or None

    def do_step(self, c):
        sid = c["id"]
        if sid == "next":
            if "milestone" not in c or "title" not in c:
                raise Refused("new step needs --milestone --title")
            if c["milestone"] not in self.milestones:
                raise Refused("unknown milestone")
            sid = self.next_step_id(c["milestone"])
            c["printed"] = f"recorded step {sid}"
        if "remove" in c:
            if sid not in self.steps:
                raise Refused("unknown step")
            self.milestones[self.steps[sid]["milestone"]].remove(sid)
            del self.steps[sid]
            self.log()
            return
        if sid not in self.steps:
            if "milestone" not in c or "title" not in c:
                raise Refused("new step needs --milestone --title")
            if c["milestone"] not in self.milestones:
                raise Refused("unknown milestone")
            self.steps[sid] = {"milestone": c["milestone"], "status": c.get("status") or "pending", "agent": c.get("agent") or None}
            self.milestones[c["milestone"]].append(sid)
        else:
            if "milestone" in c and c["milestone"] != self.steps[sid]["milestone"]:
                raise Refused("step stays in its milestone")
            self.set_step(sid, c.get("status"), c.get("agent"))
        other = c.get("before") or c.get("after")
        if other:
            m = self.steps[sid]["milestone"]
            if other == sid:
                raise Refused("before or after itself")
            if other not in self.milestones[m]:
                raise Refused("a place is among the steps of the same milestone")
            order = [x for x in self.milestones[m] if x != sid]
            at = order.index(other)
            order.insert(at if c.get("before") else at + 1, sid)
            self.milestones[m] = order

    def do_agent(self, c):
        aid = c["id"]
        a = self.agents.get(aid)
        if "milestone" in c and c["milestone"] not in self.milestones:
            raise Refused("unknown milestone")
        if a is None:
            if "milestone" not in c or "task" not in c:
                raise Refused("new agent needs --task --milestone")
            kind_model, kind_effort = ROLES["kinds"].get(c.get("skill", "none"), ROLES["kinds"][""])
            model = c.get("model", kind_model)
            if "effort" in c:
                effort = c["effort"]
            elif "model" not in c or kind_effort in ROLES["pairs"].get(model, []):
                effort = kind_effort
            else:  # a model given alone whose kind's effort is outside its pairs takes its own
                effort = ROLES["alone"].get(model, kind_effort)
            self.agents[aid] = {"name": c.get("name") or aid, "status": c.get("status") or "running",
                                "milestone": c["milestone"], "rounds": 1, "tokens": 0, "lane": list(c.get("lane", [])),
                                "model": model, "effort": effort}
            self.log()
            if c.get("step"):
                self.set_step(c["step"], "current", aid)
            self.refuse_shared_overlap(c, aid)
            c["printed"] = f"recorded {aid} ({self.agents[aid]['name']})"
            return
        if a["status"] == "done" and c.get("status") == "running":
            a["rounds"] += 1
        for key in ("name", "status", "milestone", "tokens", "model", "effort"):
            if key in c:
                a[key] = c[key]
        if "lane" in c:
            a["lane"] = list(c["lane"])
        if c.get("step"):
            follow = {"running": "current", "done": "done", "blocked": "blocked"}.get(a["status"])
            self.set_step(c["step"], follow, aid)
        if "log" in c:
            self.log()
        self.refuse_shared_overlap(c, aid)

    @staticmethod
    def starts_lane(c: dict) -> bool:
        """An `agent` command that gives a lane, a task or `--status running` is checked for lanes that meet."""
        return "lane" in c or c.get("status") == "running" or bool(c.get("task"))

    def lane_hits(self, aid: str) -> list[str]:
        """The running or blocked workers whose lane meets running worker `aid`'s."""
        a = self.agents[aid]
        if a["status"] != "running":
            return []
        return [k for k, o in self.agents.items()
                if k != aid and o["status"] in ("running", "blocked") and any(meet(x, y) for x in a["lane"] for y in o["lane"])]

    def refuse_shared_overlap(self, c: dict, aid: str) -> None:
        """A fleet that shares one working copy refuses a running worker whose lane meets a live one's."""
        if self.mode == "shared" and self.starts_lane(c) and self.lane_hits(aid):
            raise Refused("lanes meet in a shared working copy")

    def open_decision(self, key: str) -> str:
        did = self.find(self.decisions, key)
        if did is None or self.decisions[did]["status"] != "open":
            raise Refused("unknown or closed decision")
        return did

    def resolve(self, rid: str) -> None:
        r = self.roadblocks[rid]
        r["resolved"] = True
        self.log()
        a = self.agents.get(r["agent"]) if r["agent"] else None
        if a and a["status"] == "blocked":
            a["status"] = "running"

    def do_roadblock(self, c):
        rid = self.find(self.roadblocks, c["id"])
        if c.get("agent") and c["agent"] not in self.agents:
            raise Refused("unknown agent")  # open-3, fixed: --agent names a worker row, as everywhere else
        if c.get("decision"):
            c = {**c, "decision": self.open_decision(c["decision"])}  # a number is kept as the id it names
        if rid is None:
            if any(k not in c for k in ("title", "detail", "severity", "needs")):
                raise Refused("new roadblock needs its fields")
            if c["needs"] == "user" and not c.get("decision"):
                raise Refused("a roadblock that needs the user names its decision")
            self.roadblocks[c["id"]] = {"resolved": False, "agent": c.get("agent") or None, "decision": c.get("decision") or None}
            self.log()
            if c.get("agent"):
                self.agents[c["agent"]]["status"] = "blocked"
            return
        r = self.roadblocks[rid]
        if c.get("needs") == "user" and not (c["decision"] if "decision" in c else r["decision"]):
            raise Refused("changed to need the user, a roadblock names its decision (L8)")
        for key in ("agent", "decision"):
            if key in c:
                r[key] = c[key]
        if c.get("resolved"):
            self.resolve(rid)  # QUIRK(open-4): resolving a resolved roadblock logs again and unblocks its worker again
        if c.get("open"):
            r["resolved"] = False

    def check_kind(self, d: dict) -> None:
        if d["kind"] == "grill" and "questions" not in d:
            raise Refused("a grilling is asked with grill")
        if d["kind"] == "decision":
            if len(d["options"]) < 2 or not d.get("recommend") or not d.get("reason") or d["recommend"] not in d["options"]:
                raise Refused("a decision needs two options and a recommendation among them")
        if d["kind"] == "secret" and not d.get("secret"):
            raise Refused("a secret needs --secret")
        if d["kind"] in ("secret", "action") and not d.get("manual"):
            raise Refused("needs --manual")
        if d["kind"] == "action" and (d["options"] or d.get("recommend")):
            raise Refused("an action takes no options")

    def place(self, d: dict, c: dict) -> None:
        if c.get("step"):
            if c["step"] not in self.steps:
                raise Refused("unknown step")
            d["step"], d["milestone"] = c["step"], self.milestone_of(c["step"])
        if c.get("milestone"):
            if c["milestone"] not in self.milestones:
                raise Refused("unknown milestone")
            d["milestone"] = c["milestone"]
        if d.get("agent") and not d.get("milestone"):
            d["milestone"] = (self.agents.get(d["agent"]) or {}).get("milestone")

    def asked_today(self, new: dict) -> int:
        """The choices (decisions, inputs, grillings) asked of the user on the page today, `new` among them."""
        day = lambda t: int(t // 86400)  # noqa: E731  (the clock is POSIX seconds, and the oracle runs in UTC)
        rows = [d for d in self.decisions.values() if d is not new] + [new]
        return sum(1 for d in rows if d["kind"] in ("decision", "input", "grill") and d.get("page", True)
                   and day(d.get("opened", d["since"])) == day(self.clock))

    def close(self, did: str, status: str, answer) -> None:
        self.decisions[did].update(status=status, answer=answer)
        self.decisions[did].pop("held", None)  # closing ends a hold
        self.log()
        for rid, r in self.roadblocks.items():
            if r["decision"] == did and not r["resolved"]:
                self.resolve(rid)

    FIELDS = ("kind", "title", "question", "why", "recommend", "reason", "secret", "manual", "agent")

    def do_decision(self, c):
        did = self.find(self.decisions, c["id"])
        if "decide" in c and "resolution" not in c:
            raise Refused("--decide needs --resolution")
        if c.get("agent") and c["agent"] not in self.agents:
            raise Refused("unknown agent")
        d = self.decisions.get(did) if did else None
        if d is None and ("hold" in c or "unhold" in c):
            raise Refused("a hold names a known decision")
        if d is not None and d["status"] != "open":
            only_place = ("step" in c) and not any(k in c for k in self.FIELDS + ("options", "decide", "withdraw", "hold", "unhold"))
            if only_place:
                self.place(d, c)
                return
            raise Refused("a closed decision stays as it is")
        if d is None:
            if c.get("supersedes"):
                old = self.find(self.decisions, c["supersedes"])
                if old is None or self.decisions[old]["status"] == "open":
                    raise Refused("supersedes an unknown or open decision")
            elsewhere = "decide" in c
            needed = ("title", "question") if elsewhere else ("kind", "title", "question", "why")
            if any(k not in c for k in needed):
                raise Refused("new decision needs its fields")
            did = c["id"]
            d = {"kind": c.get("kind") or "decision", "status": "open", "answer": None, "step": None, "milestone": None,
                 "options": [o.split(":")[0] for o in c.get("options", [])], "agent": c.get("agent") or None,
                 **{k: c.get(k) for k in ("title", "question", "why", "recommend", "reason", "secret", "manual")}}
            self.place(d, c)
            if not elsewhere:
                self.check_kind(d)
                self.log()
            d["since"], d["opened"], d["page"] = self.clock, self.clock, not elsewhere
            if not elsewhere and d["kind"] in ("decision", "input") and self.asked_today(d) >= ADVISOR_AFTER:
                self.unadvised = did  # warned: a third choice in a day with no advisor's view, and no advisor running
            self.decisions[did] = d
        else:
            if c.get("supersedes"):
                raise Refused("--supersedes is given when the new decision is opened")
            if c.get("unhold") and not d.get("held"):
                raise Refused("--unhold takes back a --hold")
            if "question" in c and c["question"] != d["question"] and (c.get("kind") or d["kind"]) == "decision" \
                    and not c.get("options"):
                raise Refused("a new question comes with its options")
            changed = [k for k in self.FIELDS + ("step",) if k in c] + (["options"] if c.get("options") else [])
            for key in self.FIELDS:
                if key in c:
                    d[key] = c[key] or None
            if "step" in c:
                self.place(d, c)
            if c.get("options"):
                d["options"] = [o.split(":")[0] for o in c["options"]]
            self.check_kind(d)
            if any(k in changed for k in ("question", "options", "manual")) and not c.get("log") and "decide" not in c and "withdraw" not in c:
                self.reworded = did  # warned: a revision says what changed (--log)
            if changed:
                d["since"] = self.clock
                self.log()
                if any(k in changed for k in ("question", "options", "manual")):
                    d.pop("held", None)  # re-presented: back on the user's list
            if "hold" in c:
                d["held"], d["held_at"] = c["hold"], self.clock
                self.log()
            elif c.get("unhold"):
                d.pop("held", None)
                self.log()
        if "decide" in c:
            self.close(did, "decided", c["decide"])
        elif "withdraw" in c:
            self.close(did, "withdrawn", None)

    def do_grill(self, c):
        did = self.find(self.decisions, c["id"])
        d = self.decisions.get(did) if did else None
        created = d is None
        if d is not None and d["kind"] != "grill":
            raise Refused("not a grilling")
        if d is not None and d["status"] != "open":
            raise Refused("closed")
        if d is None:
            if not c.get("title") or not c.get("ask"):
                raise Refused("a new grilling needs --title and --ask")
            did = c["id"]
            d = {"kind": "grill", "status": "open", "answer": None, "step": None, "milestone": None, "options": [],
                 "agent": None, "questions": [], "title": c["title"], "question": "", "since": self.clock,
                 "opened": self.clock, "page": True}
            self.decisions[did] = d
        qs = d["questions"]
        for q in c.get("answer", []):
            n = int(q[1:])
            if not 1 <= n <= len(qs):
                raise Refused("no such question")
            qs[n - 1] = "answered"
            d["recorded"] = self.clock  # a question answered: the grilling has recorded the answers given until now
        qs += ["open"] * len(c.get("ask", []))
        if c.get("ask"):
            if not created:
                d["since"] = self.clock
            d.pop("held", None)  # a new round re-presents it
            self.log()
        if "done" in c:
            if "open" in qs:
                raise Refused("questions still open")
            self.close(did, "decided", c["done"])
        del created

    def do_event(self, c):
        if c.get("agent") and c["agent"] not in self.agents:
            raise Refused("unknown agent")
        self.log()

    def do_park(self, c):
        for a in c.get("agents", []):
            if a not in self.agents:
                raise Refused("unknown agent")
        rows = [k for k, a in self.agents.items() if a["status"] in LIVE and (not c.get("agents") or k in c["agents"])]
        if not rows:
            raise Refused("no worker row is live")
        for k in rows:
            self.agents[k]["status"] = "stopped"
        for st in self.steps.values():  # open-5, fixed: a parked worker's current step is nobody's now
            if st["status"] == "current" and st["agent"] in rows:
                st["status"] = "pending"
        self.log()

    def do_keep(self, c):
        self.kept = self.kept if self.kept is not None else {}
        if "drop" in c:
            if c["id"] not in self.kept:
                raise Refused("nothing kept")
            del self.kept[c["id"]]
            self.log()
            return
        if not c.get("text"):
            raise Refused("keep needs TEXT")
        self.kept[c["id"]] = c["text"]

    def do_link(self, c):
        self.links = self.links if self.links is not None else {}
        lid = self.find(self.links, c["id"])
        if "drop" in c:
            if lid is None:
                raise Refused("no link")
            del self.links[lid]
            self.log()
            return
        if c.get("decision"):
            if self.find(self.decisions, c["decision"]) is None:
                raise Refused("unknown decision")
            c = {**c, "decision": self.find(self.decisions, c["decision"])}  # a number is kept as the id it names
        if lid is None:
            if not c.get("url") or not c.get("title"):
                raise Refused("a new link needs --url and --title")
            self.links[c["id"]] = {"decision": c.get("decision")}
            self.log()
        elif "decision" in c:
            self.links[lid]["decision"] = c["decision"] or None

    def do_show(self, c):
        pass

    # -- what every write does after its command: numbers, then the checks -------------------------
    def number(self) -> None:
        for rows, prefix_of in ((self.decisions, lambda d: PREFIX.get(d["kind"], "D")), (self.roadblocks, lambda r: "R"),
                                (self.links or {}, lambda r: "L")):
            for k, r in rows.items():
                if not r.get("ref"):
                    p = prefix_of(r)
                    taken = [int(x["ref"][len(p):]) for x in rows.values() if re.fullmatch(p + r"\d+", x.get("ref") or "")]
                    n = max(taken, default=0) + 1
                    while f"{p}{n}" in rows and f"{p}{n}" != k:  # a number skips another row's id (open-1, fixed)
                        n += 1
                    r["ref"] = f"{p}{n}"

    def validate(self) -> None:
        taken = set()
        for aid, a in self.agents.items():
            for label in {aid.lower(), a["name"].lower()}:
                if label in ("user", "coordinator") or label in taken:
                    raise Refused("an agent's id or name is a chat participant or another agent's")
                taken.add(label)
        for s in self.steps.values():
            if s["agent"] and s["agent"] not in self.agents:
                raise Refused("a step points at an unknown agent")
        refs = {d["ref"]: k for k, d in self.decisions.items()}
        for k in self.decisions:
            if k in refs and refs[k] != k:
                raise Refused("a new decision's id is a number another decision already has")

    # -- the warnings every command but init prints on stderr ---------------------------------------
    def warnings(self, c: dict, before: "Model") -> dict:
        found = {}
        if c["cmd"] == "init":
            return found
        if before.deaf():  # the chat's check reads state.json as it was before the command
            found["deaf"] = "chat: the user wrote"
        if self.status in ("paused", "done"):
            live = [k for k, a in self.agents.items() if a["status"] in LIVE]
            if live:
                found["rows"] = f"state: {', '.join(live)} still read as"
        if not (c["cmd"] == "set" and "now" in c):
            age = self.clock - self.now_at if self.now_at is not None else None
            if age is None or age >= STALE_S:
                found["now"] = f"(said {int(age // 60)} min ago)" if age is not None else "(never stamped)"
        elif any(self.closed_ref(m) for m in REF.findall(c["now"])):
            found["names"] = "the Now line names"
        if any(self.answered_grill(d) for d in self.decisions.values()):
            found["grill"] = "state: every question of"
        if any(d["status"] == "open" and not self.answered_grill(d) and self.answered(k) for k, d in self.decisions.items()):
            found["answer"] = "state: the user answered"
        if c["cmd"] == "set" and c.get("status") == "done" and any(d["status"] == "open" for d in self.decisions.values()):
            found["open"] = "state: the fleet is done with"
        if c["cmd"] == "decision" and getattr(self, "reworded", None):
            found["reworded"] = f"state: {self.reworded} was asked again with new words and no --log"
        if c["cmd"] == "decision" and getattr(self, "unadvised", None):
            found["unadvised"] = f"state: {self.unadvised} is choice"
        if c["cmd"] == "agent" and ("model" in c or "effort" in c):
            a = self.agents[c["id"]]
            if a["model"] not in POLICY_MODELS:
                found["model"] = "outside the model policy"
            elif a["effort"] not in ROLES["pairs"][a["model"]]:
                found["model"] = f"on {a['model']} at {a['effort']} effort, outside the effort policy"
        if c["cmd"] == "agent" and self.mode != "shared" and self.starts_lane(c) and self.lane_hits(c["id"]):
            found["lanes"] = f"state: {c['id']}'s lane overlaps"
        return found

    @staticmethod
    def answered_grill(d: dict) -> bool:
        """A grilling still open with no question left open: answered, waiting to be recorded."""
        return d["kind"] == "grill" and d["status"] == "open" and "open" not in d.get("questions", [])

    def answered(self, did: str) -> bool:
        """The user answered decision `did` on the page after it last changed, after the fleet held it, and after
        a grilling's question was last answered. A reply to the answer records nothing."""
        d = self.decisions[did]
        held = d["held_at"] if d.get("held") else None
        recorded = d.get("recorded")
        return any(m["from"] == "user" and m.get("decision") == did and m["at"] >= d["since"] and (held is None or m["at"] > held)
                   and (recorded is None or m["at"] > recorded) for m in self.messages)

    def closed_ref(self, key: str) -> bool:
        did = self.find(self.decisions, key)
        return did is not None and self.decisions[did]["status"] != "open"

    # -- the chat -----------------------------------------------------------------------------------
    def deaf(self) -> bool:
        last = next((m for m in reversed(self.messages) if m["from"] == "coordinator"), None)
        if last and self.clock - last["at"] < GRACE_S:
            return False
        answered = {m["re"] for m in self.messages if m["from"] != "user" and m["re"] is not None}
        closed = {k for k, d in self.decisions.items() if d["status"] != "open"}
        return any(m["from"] == "user" and m["id"] not in answered and m.get("decision") not in closed for m in self.messages)

    def resolve_who(self, who: str) -> str | None:
        key = who.lower()
        if key == "coordinator":
            return key
        for field in ("id", "name"):
            for aid, a in self.agents.items():
                if (aid if field == "id" else a["name"]).lower() == key:
                    return aid
        return None

    def do_say(self, c):
        sender = None if c["as"] == "user" else self.resolve_who(c["as"])
        if sender is None:
            raise Refused("only the server speaks as the user, and an unknown participant is refused")
        named = []
        for token in MENTION.findall(c["text"]):
            who = self.resolve_who(token)
            if who is None and token.rstrip(".-"):
                who = self.resolve_who(token.rstrip(".-"))
            if who:
                named.append(who)
        if c.get("re") is not None:
            parent = next((m for m in self.messages if m["id"] == c["re"]), None)
            if parent is None:
                raise Refused("unknown message")
            named.append(parent["from"])
        to = ["user"]
        for who in named:
            if who != sender and who not in to:
                to.append(who)
        self.messages.append({"id": len(self.messages) + 1, "from": sender, "to": to, "re": c.get("re"), "at": self.clock})

    def do_user_says(self, c):
        self.messages.append({"id": len(self.messages) + 1, "from": "user", "to": ["coordinator"], "re": None,
                              "at": self.clock, "decision": c.get("decision")})

    def open_for(self, who: str) -> list[int]:
        who = "user" if who == "user" else self.resolve_who(who)
        if who is None:
            raise Refused("unknown participant")
        answered = {(m["re"], m["from"]) for m in self.messages}
        return [m["id"] for m in self.messages if who in m["to"] and (m["id"], who) not in answered]

    def do_inbox(self, c):
        c["expect_open"] = self.open_for(c["as"])

    # -- one step -----------------------------------------------------------------------------------
    def step(self, c: dict) -> tuple[int, dict]:
        """The exit code the CLI should give and the warnings it should print; the model moves on only when it succeeds."""
        if c.get("bad"):
            return 2, {}
        m = copy.deepcopy(self)
        try:
            m.do(c)
        except Refused:
            return 1, {}
        if c["cmd"] in ("say", "inbox", "user_says"):
            self.__dict__.update(m.__dict__)
            return 0, {}
        said = m.warnings(c, self)
        m.__dict__.pop("reworded", None)
        m.__dict__.pop("unadvised", None)
        if c["cmd"] == "show":
            return 0, said
        m.number()
        try:
            m.validate()
        except Refused:
            return 1, said
        self.__dict__.update(m.__dict__)
        return 0, said

    # -- the ledger's shape, as the model sees it ---------------------------------------------------
    def shape(self) -> dict:
        return {
            "status": self.status, "now": self.now, "workspace_mode": self.mode,
            "roadmap": [[mid, [[s, self.steps[s]["status"], self.steps[s]["agent"]] for s in steps]] for mid, steps in self.milestones.items()],
            "agents": [[k, a["status"], a["milestone"], a["rounds"], a["name"], a["tokens"], a["lane"], a["model"], a["effort"]]
                       for k, a in self.agents.items()],
            "decisions": [[k, d["kind"], d["status"], d["ref"], d["step"], d["milestone"], d["agent"], d.get("held")] for k, d in self.decisions.items()],
            "roadblocks": [[k, r["resolved"], r["ref"], r["agent"], r["decision"]] for k, r in self.roadblocks.items()],
            "kept": None if self.kept is None else [[k, v] for k, v in self.kept.items()],
            "links": None if self.links is None else [[k, r["ref"], r["decision"]] for k, r in self.links.items()],
            "events": self.events,
        }


def shape_of(state: dict) -> dict:
    return {
        "status": state["status"], "now": state["now"], "workspace_mode": state.get("workspace_mode"),
        "roadmap": [[m["id"], [[s["id"], s["status"], s["agent"]] for s in m["steps"]]] for m in state["roadmap"]],
        "agents": [[a["id"], a["status"], a["milestone"], a["rounds"], a["name"], a["tokens"], a["lane"], a["model"], a.get("effort")]
                   for a in state["agents"]],
        "decisions": [[d["id"], d["kind"], d["status"], d["ref"], d["step"], d["milestone"], d["agent"], d.get("held")] for d in state["decisions"]],
        "roadblocks": [[r["id"], r["resolved"], r["ref"], r["agent"], r["decision"]] for r in state["roadblocks"]],
        "kept": None if "kept" not in state else [[k["id"], k["text"]] for k in state["kept"]],
        "links": None if "links" not in state else [[x["id"], x["ref"], x["decision"]] for x in state["links"]],
        "events": len(state["events"]),
    }


# -- the generator ----------------------------------------------------------------------------------
def gen(rng: random.Random, m: Model) -> dict:
    """One command, valid more often than not, with ids drawn from small pools so they collide."""
    pick = rng.choice
    maybe = lambda p=0.5: rng.random() < p  # noqa: E731
    agent_ids = list(m.agents) or AGENTS
    step_ids = list(m.steps) or STEPS
    dec_ids = list(m.decisions) + DECISIONS
    choices = [("milestone", 3 if len(m.milestones) < 2 else 1), ("step", 8), ("agent", 8), ("set", 3), ("roadblock", 4),
               ("decision", 9), ("grill", 2), ("event", 2), ("park", 2), ("keep", 2), ("link", 2), ("show", 2),
               ("say", 4), ("inbox", 2), ("user_says", 2), ("odd", 1)]
    cmd = rng.choices([c for c, _ in choices], [w for _, w in choices])[0]
    if cmd == "odd":
        return pick([{"cmd": "note"}, {"cmd": "init"}, {"cmd": "set", "bad": True}])
    if cmd == "milestone":
        return {"cmd": "milestone", "id": pick(MILESTONES), **({"title": "M"} if maybe(0.85) else {})}
    if cmd == "set":
        c = {"cmd": "set"}
        if maybe(0.4):
            c["status"] = pick(["running", "paused", "blocked", "done"])
        if maybe(0.7):
            c["now"] = pick(NOW_TEXTS)
        if maybe(0.2):
            c["workspaces"] = pick(["shared", "isolated"])
        return c
    if cmd == "step":
        if maybe(0.15):
            return {"cmd": "step", "id": "next", "milestone": pick(MILESTONES), "title": "T"}
        c = {"cmd": "step", "id": pick(step_ids + STEPS)}
        if maybe(0.1):
            c["remove"] = "recorded in error"
            return c
        if c["id"] not in m.steps or maybe(0.2):
            c.update(milestone=pick(list(m.milestones) or MILESTONES) if maybe(0.9) else pick(MILESTONES), title="T")
        if maybe(0.4):
            c["status"] = pick(["done", "current", "pending", "blocked"])
        if maybe(0.25):
            c["agent"] = pick(agent_ids + ["", "ghost"])
        if maybe(0.2):
            c[pick(["before", "after"])] = pick(step_ids)
        return c
    if cmd == "agent":
        aid = pick(agent_ids + AGENTS)
        c = {"cmd": "agent", "id": aid}
        if maybe(0.15):
            c["model"] = pick(MODELS)
        if maybe(0.15):
            c["effort"] = pick(EFFORTS)
        if aid not in m.agents:
            if maybe(0.3):
                c["skill"] = pick(SKILLS)
            c.update(task="T", milestone=pick(list(m.milestones) or MILESTONES) if maybe(0.9) else "m9")
            if maybe(0.1):
                del c["task"]
            if maybe(0.1):
                c["name"] = pick(NAMES)
            if maybe(0.4):
                c["step"] = pick(step_ids)
            if maybe(0.6):
                c["lane"] = rng.sample(LANES, rng.choice([1, 1, 2]))
            return c
        c["status"] = pick(["running", "done", "blocked", "queued", "stopped", "failed"])
        if maybe(0.2):
            c["lane"] = rng.sample(LANES, rng.choice([1, 2]))
        if maybe(0.3):
            c["step"] = pick(step_ids)
        if maybe(0.3):
            c["log"] = "progress"
        if maybe(0.2):
            c["tokens"] = rng.randrange(1, 5000)
        if maybe(0.05):
            c["milestone"] = pick(MILESTONES)
        return c
    if cmd == "roadblock":
        rid = pick(list(m.roadblocks) + ROADBLOCKS)
        c = {"cmd": "roadblock", "id": rid}
        if Model.find(m.roadblocks, rid) is None or maybe(0.1):
            c.update(title="T", detail="D", severity=pick(["warning", "serious"]), needs=pick(["coordinator", "worker", "user"]))
            if maybe(0.7):
                c["agent"] = pick(agent_ids + ["ghost"])
            if c["needs"] == "user" and maybe(0.9) or maybe(0.2):  # L8: a user's roadblock with no decision is refused
                c["decision"] = pick(dec_ids)
            return c
        c[pick(["resolved", "open"])] = True
        return c
    if cmd == "decision":
        did = pick(dec_ids)
        exists = Model.find(m.decisions, did) is not None
        what = pick(["decide", "withdraw", "revise", "place", "hold", "hold", "unhold", "represent"]) if exists and maybe(0.8) \
            else pick(["open"] * 4 + ["elsewhere"] + (["hold"] if maybe(0.2) else []))
        c = {"cmd": "decision", "id": did}
        if what == "decide":
            c["decide"] = "B"
            if maybe(0.9):
                c["resolution"] = "answered on the page"
        elif what == "withdraw":
            c["withdraw"] = "no longer needed"
        elif what == "revise":
            c.update(why="the facts changed", log="what changed")
        elif what == "hold":
            c["hold"] = pick(["fix the code first", "the command was wrong"])
        elif what == "unhold":
            c["unhold"] = True
        elif what == "represent":
            c.update(manual="the fixed command", log="the new command")
        elif what == "place":
            c["step"] = pick(step_ids + ["s9"])
        elif what == "elsewhere":
            c.update(title="T", question="Q?", decide="yes", resolution="said in the session")
        else:
            kind = pick(["decision", "decision", "input", "action", "secret"])
            c.update(kind=kind, title="T", question=pick(["Q?", "Q2?"]), why="W")
            if kind == "decision":
                c["options"] = ["A: a | x", "B: b | y"] if maybe(0.9) else ["A: a | x"]
                c.update(recommend=pick(["A", "B"]) if maybe(0.9) else "C", reason="R")
            if kind in ("action", "secret") and maybe(0.9):
                c["manual"] = "by hand"
            if kind == "action" and maybe(0.1):
                c["options"] = ["yes: do it | done", "no: leave it | kept"]
                c.update(recommend="yes", reason="R")
            if kind == "secret" and maybe(0.9):
                c["secret"] = "KEY"
            if maybe(0.1):
                c["supersedes"] = pick(dec_ids)
        if maybe(0.15) and what in ("open", "revise"):
            c["agent"] = pick(agent_ids + ["ghost"])
        if maybe(0.15) and what == "open":
            c["step"] = pick(step_ids)
        return c
    if cmd == "grill":
        gid = pick(["g1", "g2", "d1"])
        c = {"cmd": "grill", "id": gid}
        did = Model.find(m.decisions, gid)
        n = len(m.decisions[did].get("questions", [])) if did else 0
        if did is None:
            c.update(title="T", ask=["t | q | r | w"] * rng.randint(1, 2))
        else:
            if n and maybe(0.7):
                c["answer"] = [f"Q{rng.randint(1, n + 1)}"]
            if maybe(0.3):
                c["ask"] = ["t | q | r | w"]
            if maybe(0.4):
                c["done"] = "agreed"
        return c
    if cmd == "event":
        return {"cmd": "event", "text": "x", **({"agent": pick(agent_ids + ["ghost"])} if maybe(0.4) else {})}
    if cmd == "park":
        return {"cmd": "park", **({"agents": [pick(agent_ids + ["ghost"])]} if maybe(0.3) else {})}
    if cmd == "keep":
        kid = pick(KEPT)
        if maybe(0.3):
            return {"cmd": "keep", "id": kid, "drop": "settled"}
        return {"cmd": "keep", "id": kid, **({"text": pick(["a hunk", "a workspace"])} if maybe(0.9) else {})}
    if cmd == "link":
        lid = pick(LINKS)
        if maybe(0.25):
            return {"cmd": "link", "id": lid, "drop": "stopped"}
        c = {"cmd": "link", "id": lid}
        if maybe(0.8):
            c.update(url="https://box.ts.net:1/", title="T", kind="preview")
        if maybe(0.3):
            c["decision"] = pick(dec_ids)
        return c
    if cmd == "say":
        who = pick(agent_ids * 2 + ["coordinator", "coordinator", "user", "ghost"])
        text = pick(["done", "@a1 over to you", "ask @coordinator.", "@A2 ping", "@ghost hi", "@impl, see this"])
        c = {"cmd": "say", "as": who, "text": text}
        if m.messages and maybe(0.5):
            c["re"] = pick([x["id"] for x in m.messages] + [999])
        return c
    if cmd == "inbox":
        return {"cmd": "inbox", "as": pick(agent_ids + ["coordinator", "user", "ghost"])}
    if cmd == "user_says":
        c = {"cmd": "user_says", "text": "are you there?"}
        if m.decisions and maybe(0.3):
            c["decision"] = pick(list(m.decisions))
        return c
    return {"cmd": "show"}


def to_step(c: dict, clock: str, render: bool, next_id: int) -> dict:
    """The trace step for a command."""
    cmd = c["cmd"]
    if cmd == "user_says":
        message = {"id": next_id, "at": clock, "from": "user", "to": ["coordinator"], "text": c["text"], "re": None}
        if c.get("decision"):
            message["decision"] = c["decision"]
        return {"fixture": "append", "path": "$DIR/chat.jsonl", "content": message, "clock": clock}
    if cmd in ("say", "inbox"):
        argv = ["$DIR", cmd, "--as", c["as"]]
        if cmd == "say":
            argv += (["--re", str(c["re"])] if c.get("re") is not None else []) + [c["text"]]
        return {"cli": "chat", "argv": argv, "clock": clock}
    argv = ["$DIR", cmd]
    if cmd == "init":
        argv += ["--project", "p", "--goal", "g"]
    elif cmd == "set" and c.get("bad"):
        argv += ["--status", "bogus"]
    elif cmd == "event":
        argv += ["x"] + (["--agent", c["agent"]] if "agent" in c else [])
    elif cmd == "park":
        for a in c.get("agents", []):
            argv += ["--agent", a]
        argv += ["paused"]
    elif cmd == "keep":
        argv += [c["id"]] + ([c["text"]] if "text" in c else []) + (["--drop", c["drop"]] if "drop" in c else [])
    elif cmd not in ("show", "note", "set"):
        argv += [c["id"]]
    flags = {"status", "now", "title", "milestone", "agent", "before", "after", "remove", "task", "name", "step", "log",
             "tokens", "model", "effort", "skill", "detail", "severity", "needs", "decision", "kind", "question", "why", "recommend", "reason",
             "secret", "manual", "supersedes", "decide", "resolution", "withdraw", "url", "done", "log", "hold", "workspaces"}
    if cmd not in ("event", "park", "keep"):
        for key, value in c.items():
            if key in flags:
                argv += ["--" + key, str(value)]
        for key in ("resolved", "open", "unhold"):
            if c.get(key):
                argv.append("--" + key)
        if cmd == "link" and "drop" in c:
            argv += ["--drop", c["drop"]]
        if "lane" in c:
            argv += ["--lane", *c["lane"]]
        for o in c.get("options", []):
            argv += ["--option", o]
        for q in c.get("ask", []):
            argv += ["--ask", q]
        for q in c.get("answer", []):
            argv += ["--answer", f"{q}: yes"]
    if not render:
        argv.append("--no-render")
    return {"cli": "state", "argv": argv, "clock": clock}


def stamp(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds")


START_T = datetime.fromisoformat(run.START).timestamp()


def sequence(seed: int, steps: int):
    """The seeded sequence: (command, step) pairs, with the model's predictions made as it goes."""
    rng, m, t = random.Random(seed), Model(), START_T
    opening = [{"cmd": "init"}, {"cmd": "milestone", "id": "m1", "title": "M"}]
    if rng.random() < 0.4:  # a fleet whose workers share one working copy from the start
        opening.append({"cmd": "set", "workspaces": "shared"})
    for i in range(steps):
        c = opening[i] if i < len(opening) else gen(rng, m)
        if i:
            t += rng.choice([0, 0, 30, 120, 300, 600, 900, 1500])
        m.clock = t
        step = to_step(c, stamp(t), render=rng.random() < 0.05, next_id=len(m.messages) + 1)
        yield c, step, m


# -- the checks -------------------------------------------------------------------------------------
class Divergence(AssertionError):
    pass


def check_step(c: dict, step: dict, expected: tuple[int, dict], got: dict, before: dict, after: dict, m: Model) -> None:
    code, said = expected

    def need(ok: bool, what: str):
        if not ok:
            raise Divergence(what)

    if "cli" in step:
        need(got["exit"] == code, f"exit {got['exit']}, the model expected {code}\nstderr: {got['stderr']}")
        need("Traceback" not in got["stderr"], f"a traceback:\n{got['stderr']}")
    old, new = before.get("$DIR/state.json"), after.get("$DIR/state.json")
    if "cli" in step and got["exit"] != 0:
        need(old == new, "a refused command changed state.json")
        need(before.get("$DIR/chat.jsonl") == after.get("$DIR/chat.jsonl"), "a refused command changed chat.jsonl")
    if step.get("cli") == "state" and (code == 0 or said):
        # On success stderr is the warnings and nothing else; a ledger the final check refuses prints them before its reason.
        lines = [x for x in got["stderr"].splitlines() if x]
        for key, text in said.items():
            need(any(text in x for x in lines), f"expected the {key} warning ({text!r}) on stderr:\n{got['stderr']}")
        unexpected = [x for x in lines if not any(t in x for t in said.values())
                      and not (code == 1 and x.startswith("render_dashboard: "))]
        need(not unexpected, f"stderr the model did not expect: {unexpected}\nexpected {said}")
    if new is None:
        return
    need(shape_of(new) == m.shape(), f"the ledger's shape differs from the model's:\n ledger {json.dumps(shape_of(new))}\n model  {json.dumps(m.shape())}")
    # invariants that need no model
    if old is not None:
        need(new["events"][:len(old["events"])] == old["events"], "the event log is append-only")
        was = {d["id"]: d for d in old["decisions"]}
        for d in new["decisions"]:
            p = was.get(d["id"])
            if p is None:
                continue
            need(p.get("ref") == d.get("ref"), f"decision {d['id']}'s number changed")
            if p["status"] != "open":
                same = {k: v for k, v in d.items() if k not in ("step", "milestone")}
                need(same == {k: v for k, v in p.items() if k not in ("step", "milestone")}, f"closed decision {d['id']} changed")
            else:
                need(d["status"] in ("open", "decided", "withdrawn"), f"decision {d['id']} went to {d['status']}")
        for key in ("roadblocks", "links"):
            refs = {r["id"]: r.get("ref") for r in old.get(key, [])}
            for r in new.get(key, []):
                need(refs.get(r["id"], r.get("ref")) == r.get("ref"), f"{key} {r['id']}'s number changed")
    milestones = {x["id"] for x in new["roadmap"]}
    agents = {a["id"] for a in new["agents"]}
    need(all(a["milestone"] in milestones for a in new["agents"]), "an agent names an unknown milestone")
    need(all(s["agent"] in agents for x in new["roadmap"] for s in x["steps"] if s["agent"]), "a step names an unknown agent")
    refs = [d["ref"] for d in new["decisions"]]
    need(len(refs) == len(set(refs)), "two decisions share a number")
    if step.get("cli") == "state" and got["exit"] == 0 and c["cmd"] != "show":
        need(new["updated"] == step["clock"], f"updated is {new['updated']}, the clock {step['clock']}")
    if c["cmd"] == "show" and got["exit"] == 0:
        out = got["stdout"].splitlines()
        shared = ", shared working copy" if new.get("workspace_mode") == "shared" else ""
        need(out[0] == f"{new['project']} [{new['status']}{shared}] {new['now']}", f"show's first line: {out[0]!r}")
        for x in new["roadmap"]:
            done = sum(s["status"] == "done" for s in x["steps"])
            need(f"  {x['id']} {x['title']} ({done}/{len(x['steps'])})" in out, f"show leaves out milestone {x['id']}")
        for a in new["agents"]:
            row = f"  agent {a['id']:<16} {a['status']:<8} {a['skill']:<15} {a['model']:<6} {a.get('effort') or '-':<6} "
            need(any(line.startswith(row) for line in out), f"show leaves out agent {a['id']}, or its model and effort")
        for d in new["decisions"]:
            need(any(f"{d['ref']} decision {d['id']} " in line for line in out), f"show leaves out decision {d['id']}")
        need(f"  {len(new['events'])} events, updated {new['updated']}" in out, "show's event count")
    if c.get("printed") and got["exit"] == 0:
        need(c["printed"] in got["stdout"], f"expected {c['printed']!r} in stdout: {got['stdout']!r}")
    if step.get("cli") == "state" and got["exit"] == 1:
        need(got["stdout"] == "", f"a refused command printed on stdout (open-2): {got['stdout']!r}")
    chat = after.get("$DIR/chat.jsonl") or []
    was_chat = before.get("$DIR/chat.jsonl") or []
    need(chat[:len(was_chat)] == was_chat, "the chat is append-only")
    need([[x["id"], x["from"], x["to"], x["re"]] for x in chat] == [[x["id"], x["from"], x["to"], x["re"]] for x in m.messages],
         f"the chat differs from the model's:\n chat  {chat}\n model {m.messages}")
    if c["cmd"] == "inbox" and got["exit"] == 0:
        printed = [int(x.split()[0][1:]) for x in got["stdout"].splitlines() if x.startswith("#")]
        need(printed == c["expect_open"], f"inbox printed {printed}, the model's open messages are {c['expect_open']}")


def impl() -> tuple[dict | None, dict | None]:
    given = os.environ.get("FLEET_ORACLE_IMPL")
    if not given:
        return None, None
    table = json.loads(given)
    return {k: shlex.split(v) for k, v in table.items() if k != "subst"}, table.get("subst") or {}


def drive(seed: int, steps: int) -> str | None:
    """Run one sequence; None when it held, else what diverged, with the seed and the trace to replay."""
    trace = [{"trace": 1, "name": f"model-{seed}", "seed": seed}]
    commands = []
    implementation, subst = impl()
    with run.Session(implementation, subst) as s:
        for i, (c, step, m) in enumerate(sequence(seed, steps), 1):
            trace.append(step)
            commands.append(c)
            before = dict(s.view)
            expected = m.step(c)
            got = s.apply(step)
            try:
                check_step(c, step, expected, got, before, s.view, m)
            except Divergence as exc:
                path = Path(tempfile.gettempdir()) / f"fleet-model-{seed}.jsonl"
                path.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in trace))
                return (f"seed {seed}, step {i}: {exc}\n  command: {c}\n  step: {json.dumps(step, ensure_ascii=False)}\n"
                        f"  replay: FLEET_MODEL_SEED={seed} FLEET_MODEL_STEPS={steps} python3 -m unittest fleet/oracle/test_model.py\n"
                        f"  trace:  {path} (python3 fleet/oracle/run.py run {path})")
    return None


class ModelTest(unittest.TestCase):
    def test_the_ledger_follows_the_model_over_random_sequences(self):
        steps = int(os.environ.get("FLEET_MODEL_STEPS", 60))
        if os.environ.get("FLEET_MODEL_SEED"):
            seeds = [int(os.environ["FLEET_MODEL_SEED"])]
        else:
            base = random.SystemRandom().randrange(1, 10**9)
            seeds = [base + i for i in range(int(os.environ.get("FLEET_MODEL_SEQS", 25)))]
        with ThreadPoolExecutor(max_workers=run.workers(16)) as pool:
            failures = [f for f in pool.map(lambda sd: drive(sd, steps), seeds) if f]
        self.assertFalse(failures, f"{len(failures)} of {len(seeds)} sequences diverged (seeds {seeds[0]}..{seeds[-1]}):\n\n"
                         + "\n\n".join(failures[:3]))


def export(seed: int, steps: int) -> None:
    """Print the sequence of `seed` as a trace."""
    print(json.dumps({"trace": 1, "name": f"model-{seed}", "about": f"test_model.py's random sequence, seed {seed}, {steps} steps",
                      "seed": seed}, ensure_ascii=False))
    for c, step, m in sequence(seed, steps):
        m.step(c)
        print(json.dumps(step, ensure_ascii=False))


if __name__ == "__main__":
    if sys.argv[1:2] == ["--export"]:
        export(int(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 60)
    else:
        unittest.main()
