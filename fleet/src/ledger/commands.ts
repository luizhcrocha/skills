/**
 * The ledger's commands (Python's `state.py` handlers): one per event, create and update sharing a verb.
 * Each takes the ledger as read (a fresh copy it may change) and the command's arguments, prints what
 * the command says, and gives back the ledger to write (none for `show`) or a refusal. What it says is
 * printed only once the ledger it gives back is checked (open-2).
 */
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { stampOf } from "../clock.ts";
import type { Args } from "../cli/args.ts";
import { stateRefusal, type Refusal } from "../errors.ts";
import { pyStr } from "../json.ts";
import { FLEET_BIN, makeDirs, readOrWhy, remove, writeBytes } from "../files.ts";
import { workerFigures } from "../transcripts.ts";
import type { Machine } from "../world.ts";
import { dropKey, REFUSAL_KEYS, type LedgerEvent, type Agent, type Choice, type Decision, type Ledger, type Milestone, type Question, type Roadblock, type Step } from "./model.ts";
import { find, findDecision, milestoneOfStep, nextStepId } from "./numbers.ts";
import { makeRefusedCall, permissionOptions } from "./permission.ts";
import { ID, KINDS } from "./validate.ts";
import { closedNamed, isLive, sharedOverlap, UNFINISHED } from "./warnings.ts";

/** One run of one ledger command. */
export interface Run {
  readonly machine: Machine;
  /** The dashboard directory, resolved. */
  readonly root: string;
  readonly cmd: string;
  readonly args: Args;
  /** Print a line on stdout. */
  readonly say: (line: string) => void;
  /** Print a line on stderr. */
  readonly warn: (line: string) => void;
}

type Step$ = Effect.Effect<void, Refusal>;

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(stateRefusal(reason));
}

function stamp(run: Run): string {
  return stampOf(run.machine.now());
}

function given(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** The worker skills. */
export const SKILLS = ["implement", "diagnosing-bugs", "prototype", "research", "tdd", "none"] as const;

/** The worker models. */
export const MODELS = ["opus", "sonnet", "haiku", "fable"] as const;

/** A roadblock's severities. */
export const SEVERITIES = ["warning", "serious", "critical"] as const;

/** Who a roadblock needs. */
export const NEEDS = ["user", "coordinator", "worker"] as const;

/** The kinds of event. */
export const EVENT_KINDS = ["spawned", "reported", "blocked", "resolved", "asked", "decision", "note", "integrated"] as const;

/** The kinds of link. */
export const LINK_KINDS = ["dev", "page"] as const;

function log(
  run: Run,
  ledger: Ledger,
  event: {
    readonly kind: string;
    readonly text: string;
    readonly agent?: string | null | undefined;
    readonly important?: boolean;
    readonly decision?: string | null | undefined;
  },
): void {
  const entry: LedgerEvent = { at: stamp(run), agent: event.agent ?? null, kind: event.kind, text: event.text };

  if (event.important === true) entry.important = true;

  if (given(event.decision ?? undefined)) entry.decision = event.decision ?? null;

  ledger.events.push(entry);
}

function known(ledger: Ledger, agent: string): boolean {
  return ledger.role === "manager" || find(ledger.agents, agent) !== undefined;
}

function require(run: Run, fields: readonly string[], what: string): Step$ {
  const missing = fields.filter((f) => run.args.str(f.replace(/-/g, "_")) === undefined);

  return missing.length > 0 ? refuse(`new ${what} needs --${missing.join(" --")}`) : Effect.void;
}

function milestoneIds(ledger: Ledger): string {
  return ledger.roadmap.map((m) => m.id).join(", ");
}

// -- init, set ------------------------------------------------------------------------------------

/** A manager's landing queue: one step per landing, in the order of the turns; the current one has the turn. */
export const LANDINGS = "landings";

/** `init`: a new ledger. */
export function init(already: boolean, run: Run): Effect.Effect<Ledger, Refusal> {
  if (already) return refuse("state.json already exists; use `set` to change it");
  const now = stamp(run);

  const base: Ledger = {
    project: run.args.str("project") ?? "",
    goal: run.args.str("goal") ?? "",
    status: "running",
    now: given(run.args.str("now")) ? (run.args.str("now") ?? "") : "Intake in progress.",
    now_at: now,
    started: now,
    updated: now,
    roadmap: [],
    agents: [],
    roadblocks: [],
    decisions: [],
    events: [],
  };

  if (run.args.str("role") !== "manager") return Effect.succeed(base);
  base.roadmap.push({ id: LANDINGS, title: "Landings and deploys", steps: [] });

  // A manager's ledger says so first, as Python writes it.
  return Effect.succeed({ role: "manager", ...base });
}

/** `set`: the fleet's status, Now line, goal, or how its workers share the repository (`--workspaces`). */
export function set(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  const status = run.args.str("status");
  const now = run.args.str("now");
  const goal = run.args.str("goal");
  const workspaces = run.args.str("workspaces");

  if (status !== undefined) ledger.status = status;

  if (now !== undefined) ledger.now = now;

  if (goal !== undefined) ledger.goal = goal;

  if (workspaces !== undefined) ledger.workspace_mode = workspaces;

  if (now !== undefined) {
    ledger.now_at = stamp(run);

    for (const said of closedNamed(run.machine, ledger, now)) {
      run.warn(`state: the Now line names ${said}: check the decision's state before saying it waits on anyone.`);
    }
  }

  return Effect.succeed(ledger);
}

// -- park, keep, link -----------------------------------------------------------------------------

/** `park`: stop every live worker row, or the ones named, with one reason. */
export function park(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  const named = run.args.list("agent") ?? [];

  for (const a of named) {
    if (find(ledger.agents, a) === undefined) return refuse(`unknown agent '${a}'`);
  }

  const rows = ledger.agents.filter((a) => isLive(a.status) && (named.length === 0 || named.includes(a.id)));

  if (rows.length === 0) {
    return refuse(`no worker row is running, queued, or blocked${named.length > 0 ? " among those named" : ""}`);
  }

  for (const a of rows) {
    a.status = "stopped";
    a.updated = stamp(run);
  }

  // A parked worker's current step is nobody's now; it keeps who last worked it (open-5).
  const stopped = new Set(rows.map((a) => a.id));

  for (const m of ledger.roadmap) {
    for (const s of m.steps) if (s.status === "current" && stopped.has(s.agent ?? "")) s.status = "pending";
  }

  log(run, ledger, { kind: "note", text: `Stopped ${rows.map((a) => a.id).join(", ")}: ${run.args.str("reason") ?? ""}` });

  return Effect.succeed(ledger);
}

/** Fill each worker row that names its task id with its transcript's figures, while it runs and once after. */
export function measure(machine: Machine, root: string, ledger: Ledger): void {
  for (const a of ledger.agents) {
    if (!given(a.task_id) || a.measured === "by hand") continue;
    const got = workerFigures(root, machine.config, a.task_id);

    if (got === undefined || (a.measured === got.at && !isLive(a.status))) continue;
    a.tokens = got.tokens;
    a.duration_ms = got.duration_ms;
    a.measured = got.at;
  }
}

/** `link`: a dev server or a purpose-built page. */
export function link(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  return Effect.gen(function* () {
    ledger.links ??= [];
    const links = ledger.links;
    const id = run.args.str("id") ?? "";
    const item = find(links, id);
    const drop = run.args.str("drop");

    if (drop !== undefined) {
      if (item === undefined) return yield* refuse(`no link '${id}'`);
      links.splice(links.indexOf(item), 1);
      log(run, ledger, { kind: "note", text: `Link ${id} (${item.title ?? "None"}) removed: ${drop}` });

      return ledger;
    }

    let decision = run.args.str("decision");

    if (given(decision)) {
      const d = findDecision(ledger, decision);

      if (d === undefined) return yield* refuse(`unknown decision '${decision}'`);
      decision = d.id;
    }

    const agent = run.args.str("agent");

    if (given(agent) && !known(ledger, agent)) return yield* refuse(`unknown agent '${agent}'`);
    const url = run.args.str("url");
    const title = run.args.str("title");
    const kind = run.args.str("kind");
    const note = run.args.str("note");

    if (item === undefined) {
      if (!given(url) || !given(title)) return yield* refuse("a new link needs --url and --title");

      const fresh = {
        id,
        url,
        title,
        kind: given(kind) ? kind : "dev",
        decision: decision ?? null,
        agent: agent ?? null,
        note: note ?? null,
        since: stamp(run),
      };

      links.push(fresh);
      log(run, ledger, {
        kind: "note",
        text: `${fresh.kind === "page" ? "Page" : "Dev server"} ${fresh.title ?? "None"}: ${fresh.url ?? "None"}`,
        agent: agent ?? null,
        decision,
      });

      return ledger;
    }

    // An emptied field is stored as null, as Python's `or None` stores it (open-7).
    const orNull = (value: string): string | null => (value === "" ? null : value);

    if (url !== undefined) item.url = orNull(url);

    if (title !== undefined) item.title = orNull(title);

    if (kind !== undefined) item.kind = kind;

    if (decision !== undefined) item.decision = orNull(decision);

    if (agent !== undefined) item.agent = orNull(agent);

    if (note !== undefined) item.note = orNull(note);

    return ledger;
  });
}

/** `keep`: what must outlive a compaction. */
export function keep(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  ledger.kept ??= [];
  const kept = ledger.kept;
  const id = run.args.str("id") ?? "";
  const item = find(kept, id);
  const drop = run.args.str("drop");

  if (drop !== undefined) {
    if (item === undefined) return refuse(`nothing kept as '${id}'`);
    kept.splice(kept.indexOf(item), 1);
    log(run, ledger, { kind: "note", text: `Dropped ${id} (${item.text}): ${drop}` });

    return Effect.succeed(ledger);
  }

  const text = run.args.str("text");

  if (!given(text)) return refuse("keep needs TEXT: what must still be known after a compaction");

  if (item === undefined) kept.push({ id, text, at: stamp(run) });
  else {
    item.text = text;
    item.at = stamp(run);
  }

  return Effect.succeed(ledger);
}

// -- milestones and steps -------------------------------------------------------------------------

/** `milestone`: a new milestone, or a new title. */
export function milestone(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  return Effect.gen(function* () {
    const id = run.args.str("id") ?? "";
    const title = run.args.str("title");
    const m = find(ledger.roadmap, id);

    if (m === undefined) {
      yield* require(run, ["title"], "milestone");
      ledger.roadmap.push({ id, title: title ?? "", steps: [] });
    } else if (given(title)) {
      m.title = title;
    }

    return ledger;
  });
}

function setStep(ledger: Ledger, id: string, status: string | undefined, agent: string | undefined): Effect.Effect<Step, Refusal> {
  for (const m of ledger.roadmap) {
    const s = find(m.steps, id);

    if (s !== undefined) {
      if (given(status)) s.status = status;

      if (agent !== undefined) s.agent = agent === "" ? null : agent;

      return Effect.succeed(s);
    }
  }

  return refuse(`unknown step '${id}'`);
}

function place(ledger: Ledger, m: Milestone, step: Step, before: string | undefined, after: string | undefined): Step$ {
  const other = given(before) ? before : (after ?? "");

  if (other === step.id) return refuse(`step ${other} cannot be placed before or after itself`);

  if (find(m.steps, other) === undefined) {
    const home = milestoneOfStep(ledger, other);

    return refuse(home === undefined ? `unknown step '${other}'` : `step ${other} is in ${home.id}, and ${step.id} is in ${m.id}`);
  }

  m.steps = m.steps.filter((s) => s !== step);
  const at = m.steps.findIndex((s) => s.id === other);
  m.steps.splice(given(before) ? at : at + 1, 0, step);

  return Effect.void;
}

/** `step`: a new step, a change to one, its place, or its removal; `step next` takes the next free id. */
export function step(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  return Effect.gen(function* () {
    const args = run.args;
    let id = args.str("id") ?? "";
    const milestoneId = args.str("milestone");

    if (id === "next") {
      yield* require(run, ["milestone", "title"], "step");

      if (find(ledger.roadmap, milestoneId ?? "") === undefined) return yield* refuse(`unknown milestone '${milestoneId ?? ""}'`);
      id = nextStepId(ledger, milestoneId ?? "");
      run.say(`recorded step ${id}`);
    }

    let m = milestoneOfStep(ledger, id);
    const remove = args.str("remove");

    if (remove !== undefined) {
      if (m === undefined) return yield* refuse(`unknown step '${id}'`);
      const gone = find(m.steps, id);

      if (gone === undefined) return yield* refuse(`unknown step '${id}'`);
      m.steps.splice(m.steps.indexOf(gone), 1);
      const agent = gone.agent ?? "";
      log(run, ledger, {
        kind: "note",
        text: `Step ${id} removed (${gone.title}): ${remove}`,
        agent: find(ledger.agents, agent) === undefined ? null : agent,
      });

      return ledger;
    }

    let target: Step;

    if (m === undefined) {
      yield* require(run, ["milestone", "title"], "step");
      m = find(ledger.roadmap, milestoneId ?? "");

      if (m === undefined) return yield* refuse(`unknown milestone '${milestoneId ?? ""}'`);
      const status = args.str("status");
      const agent = args.str("agent");
      target = { id, title: args.str("title") ?? "", status: given(status) ? status : "pending", agent: given(agent) ? agent : null };
      m.steps.push(target);
    } else {
      if (milestoneId !== undefined && milestoneId !== m.id) {
        return yield* refuse(`step ${id} stays in ${m.id}; remove it and record it in ${milestoneId} to move it`);
      }

      target = yield* setStep(ledger, id, args.str("status"), args.str("agent"));
      const title = args.str("title");

      if (title !== undefined) target.title = title;
    }

    const before = args.str("before");
    const after = args.str("after");

    if (given(before) || given(after)) yield* place(ledger, m, target, before, after);
    yield* oneTurn(ledger, m, target);

    return ledger;
  });
}

/** In a manager's landing queue one landing has the turn: another is made current only once the one that
 * has it is done or given back. */
function oneTurn(ledger: Ledger, m: Milestone, target: Step): Step$ {
  if (ledger.role !== "manager" || m.id !== LANDINGS || target.status !== "current") return Effect.void;
  const held = m.steps.find((s) => s !== target && s.status === "current");

  if (held === undefined) return Effect.void;

  return refuse(
    `${held.id} (${held.title}) has the turn: one landing at a time. Close it (\`step ${held.id} --status done\`) ` +
      `or give it back (\`step ${held.id} --status pending\`) first`,
  );
}

// -- workers --------------------------------------------------------------------------------------

/** `agent`: a new worker row, or a change to one. */
export function agent(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  return Effect.gen(function* () {
    const args = run.args;
    const id = args.str("id") ?? "";
    const a = find(ledger.agents, id);
    const milestoneId = args.str("milestone");

    if (milestoneId !== undefined && find(ledger.roadmap, milestoneId) === undefined) {
      const ids = milestoneIds(ledger);

      return yield* refuse(
        `unknown milestone '${milestoneId}' (the roadmap has: ${ids === "" ? "none yet; record one with `milestone`" : ids})`,
      );
    }

    const logText = args.str("log");

    if (a === undefined) {
      if (milestoneId === undefined) {
        const ids = milestoneIds(ledger);

        return yield* refuse(`new agent needs --milestone, one of ${ids === "" ? "(none yet: add one with `milestone`)" : ids}`);
      }

      yield* require(run, ["task", "milestone"], "agent");
      const now = stamp(run);

      const fresh: Agent = {
        id,
        name: given(args.str("name")) ? (args.str("name") ?? id) : id,
        task: args.str("task") ?? "",
        skill: given(args.str("skill")) ? (args.str("skill") ?? "none") : "none",
        model: given(args.str("model")) ? (args.str("model") ?? "opus") : "opus",
        status: given(args.str("status")) ? (args.str("status") ?? "running") : "running",
        lane: [...(args.list("lane") ?? [])],
        milestone: milestoneId,
        tokens: 0,
        duration_ms: 0,
        rounds: 1,
        started: now,
        updated: now,
        brief: args.str("brief") ?? "",
        report: "",
      };

      const taskId = args.str("task_id");

      if (given(taskId)) fresh.task_id = taskId;
      ledger.agents.push(fresh);
      log(run, ledger, {
        kind: "spawned",
        text: given(logText) ? logText : `Spawned on ${fresh.model ?? "opus"} following ${fresh.skill ?? "none"}.`,
        agent: fresh.id,
      });
      const stepId = args.str("step");

      if (given(stepId)) yield* setStep(ledger, stepId, "current", fresh.id);
      yield* refuseSharedOverlap(ledger, fresh.id, args);
      run.say(
        `recorded ${fresh.id} (${fresh.name}); its brief opens with: Read ${join(run.root, "brief.md")} first; your id is ${fresh.id}.`,
      );

      return ledger;
    }

    const status = args.str("status");

    if (a.status === "done" && status === "running") a.rounds = (a.rounds ?? 1) + 1;
    const taskId = args.str("task_id");

    if (given(taskId)) {
      a.task_id = taskId;
      delete a.measured;
      dropKey(a, "measured");
    }

    const name = args.str("name");

    if (name !== undefined) a.name = name;
    const task = args.str("task");

    if (task !== undefined) a.task = task;
    const skill = args.str("skill");

    if (skill !== undefined) a.skill = skill;
    const model = args.str("model");

    if (model !== undefined) a.model = model;

    if (status !== undefined) a.status = status;

    if (milestoneId !== undefined) a.milestone = milestoneId;
    const brief = args.str("brief");

    if (brief !== undefined) a.brief = brief;
    const report = args.str("report");

    if (report !== undefined) a.report = report;
    const lane = args.list("lane");

    if (lane !== undefined) a.lane = [...lane];
    const tokens = args.int("tokens");
    const duration = args.int("duration_ms");

    if (tokens !== undefined) a.tokens = tokens;

    if (duration !== undefined) a.duration_ms = duration;

    if (tokens !== undefined || duration !== undefined) a.measured = "by hand";
    a.updated = stamp(run);
    const said = [a.report, logText].filter((x): x is string => given(x)).join(" ");
    const unfinished = a.status === "done" ? UNFINISHED.exec(said) : null;

    if (unfinished !== null && (status === "done" || report !== undefined)) {
      run.warn(
        `state: ${a.id} is done, but its report reads as unfinished ("${unfinished[0]}"). Done means its ` +
          "completion criterion was met; one that ended short is `--status stopped` with the reason, or `blocked` " +
          "with a roadblock when it waits on someone.",
      );
    }

    const stepId = args.str("step");

    if (given(stepId)) {
      const follow = new Map([
        ["running", "current"],
        ["done", "done"],
        ["blocked", "blocked"],
      ]);

      yield* setStep(ledger, stepId, follow.get(a.status), a.id);
    }

    if (given(logText)) {
      const kinds = new Map([
        ["blocked", "blocked"],
        ["done", "reported"],
        ["failed", "reported"],
        ["stopped", "note"],
      ]);

      log(run, ledger, {
        kind: kinds.get(a.status) ?? "note",
        text: logText,
        agent: a.id,
        important: args.flag("important") || a.status === "failed",
      });
    }

    yield* refuseSharedOverlap(ledger, a.id, args);

    return ledger;
  });
}

/** Whether an `agent` command puts the worker's lane to work: it gives `--lane`, `--task` or `--status running`.
 * Only such a command is checked for lanes that meet (the warning, and the refusal in a shared fleet). */
export function startsLane(args: Args): boolean {
  return args.list("lane") !== undefined || args.str("status") === "running" || (args.str("task") ?? "") !== "";
}

/** In a fleet that shares one working copy, a running worker whose lane meets another live worker's is
 * refused: there, two workers on the same files overwrite each other's edits as they make them. */
function refuseSharedOverlap(ledger: Ledger, id: string, args: Args): Step$ {
  const reason = startsLane(args) ? sharedOverlap(ledger, id) : undefined;

  return reason === undefined ? Effect.void : refuse(reason);
}

// -- roadblocks -----------------------------------------------------------------------------------

/** Why a closed decision or roadblock takes no more edits. */
export function closedBecause(item: { readonly title: string | null; readonly status: string; readonly resolution?: string | null | undefined }): string {
  return `${item.title ?? "None"} is already ${item.status}: ${given(item.resolution ?? undefined) ? item.resolution : "no reason recorded"}`;
}

function openDecision(ledger: Ledger, id: string): Effect.Effect<Decision, Refusal> {
  const d = findDecision(ledger, id);

  if (d === undefined) return refuse(`unknown decision '${id}'`);

  if (d.status !== "open") return refuse(closedBecause(d));

  return Effect.succeed(d);
}

function resolve(run: Run, ledger: Ledger, r: Roadblock): void {
  r.resolved = true;
  log(run, ledger, { kind: "resolved", text: `${r.title} resolved.`, agent: r.agent ?? null });
  const a = given(r.agent ?? undefined) ? find(ledger.agents, r.agent ?? "") : undefined;

  if (a !== undefined && a.status === "blocked") a.status = "running";
}

/** `roadblock`: a new roadblock, a change to one, resolving or reopening it. */
export function roadblock(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  return Effect.gen(function* () {
    const args = run.args;
    const id = args.str("id") ?? "";
    const r = find(ledger.roadblocks, id);
    const agent = args.str("agent");

    // open-3: a roadblock's worker is a worker row, as every other --agent is.
    if (given(agent) && !known(ledger, agent)) return yield* refuse(`unknown agent '${agent}'`);
    let decision = args.str("decision");

    if (given(decision)) decision = (yield* openDecision(ledger, decision)).id;

    if (r === undefined) {
      yield* require(run, ["title", "detail", "severity", "needs"], "roadblock");
      const needs = args.str("needs") ?? "";

      if (needs === "user" && !given(decision)) {
        return yield* refuse("a roadblock that needs the user names what it asks: record the `decision` first, then pass --decision ID");
      }

      const title = args.str("title") ?? "";
      const detail = args.str("detail") ?? "";
      ledger.roadblocks.push({
        id,
        title,
        detail,
        agent: given(agent) ? agent : null,
        severity: args.str("severity") ?? "",
        needs,
        decision: given(decision) ? decision : null,
        since: stamp(run),
        resolved: false,
      });
      log(run, ledger, {
        kind: "blocked",
        text: `${title}: ${detail}`,
        agent: agent ?? null,
        important: args.flag("important") || needs === "user",
        decision,
      });
      const worker = given(agent) ? find(ledger.agents, agent) : undefined;

      if (worker !== undefined) worker.status = "blocked";

      return ledger;
    }

    const needsNow = args.str("needs");

    // L8: changed to need the user, a roadblock names its decision, as a new one does.
    if (needsNow === "user" && !given(decision !== undefined ? decision : (r.decision ?? undefined))) {
      return yield* refuse("a roadblock that needs the user names what it asks: record the `decision` first, then pass --decision ID");
    }

    const title = args.str("title");

    if (title !== undefined) r.title = title;
    const detail = args.str("detail");

    if (detail !== undefined) r.detail = detail;
    const severity = args.str("severity");

    if (severity !== undefined) r.severity = severity;

    if (needsNow !== undefined) r.needs = needsNow;

    if (agent !== undefined) r.agent = agent;

    if (decision !== undefined) r.decision = decision;

    if (args.flag("resolved")) resolve(run, ledger, r);

    if (args.flag("open")) r.resolved = false;

    return ledger;
  });
}

// -- decisions ------------------------------------------------------------------------------------

function parseOptions(texts: readonly string[]): Effect.Effect<Choice[], Refusal> {
  const options: Choice[] = [];

  for (const text of texts) {
    const colon = text.indexOf(":");
    const rest = colon >= 0 ? text.slice(colon + 1) : "";
    const bar = rest.indexOf("|");
    const key = (colon >= 0 ? text.slice(0, colon) : text).trim();
    const label = (bar >= 0 ? rest.slice(0, bar) : rest).trim();
    const consequence = (bar >= 0 ? rest.slice(bar + 1) : "").trim();

    if (colon < 0 || bar < 0 || label === "" || consequence === "" || !ID.test(key)) {
      return refuse(`an option reads "KEY: label | consequence", got ${pyStr(text)}`);
    }

    if (find(options, key) !== undefined) return refuse(`option '${key}' is given twice`);
    options.push({ id: key, label, consequence });
  }

  return Effect.succeed(options);
}

function checkKind(d: Decision): Step$ {
  if (d.kind === "grill" && d.questions === undefined) {
    return refuse('a grilling is asked with the grill command: `grill ID --title T --ask "TITLE | QUESTION | RECOMMENDATION | WHY"`');
  }

  if (d.kind === "decision") {
    const options = d.options ?? [];

    if (options.length < 2) return refuse("a decision needs at least two options (--option, once per option)");
    const missing = (["recommend", "reason"] as const).filter((f) => !given(d[f] ?? undefined));

    if (missing.length > 0) return refuse(`a decision carries the coordinator's recommendation: give --${missing.join(" --")}`);

    if (find(options, d.recommend ?? "") === undefined) {
      return refuse(`--recommend '${d.recommend ?? "None"}' is not one of the options (${options.map((o) => o.id).join(", ")})`);
    }
  }

  if (d.kind === "secret" && !given(d.secret ?? undefined)) {
    return refuse("a secret names what the code expects: give --secret NAME (the key in secretspec.toml)");
  }

  if ((d.kind === "secret" || d.kind === "action") && !given(d.manual ?? undefined)) {
    return refuse(`${d.kind === "secret" ? "a secret" : "an action"} gives the manual route: give --manual with the steps or commands`);
  }

  if (d.kind === "action" && ((d.options ?? []).length > 0 || given(d.recommend ?? undefined))) {
    return refuse("an action is a step only the user takes, with no options to choose: a yes or no on what the fleet would do is a decision (--kind decision, with the options and --recommend)");
  }

  return Effect.void;
}

const REFUSAL_FLAGS = ["tool", "call", "cause", "root", "agent_id"] as const;

/** A permission's refused call from the flags given, over the one it had, with the two options that follow
 * from it; whether it changed. Any other kind takes none of these flags. */
function setRefusal(run: Run, d: Decision): Effect.Effect<boolean, Refusal> {
  return Effect.gen(function* () {
    const args = run.args;
    const named = REFUSAL_FLAGS.filter((k) => args.str(k) !== undefined);

    if (d.kind !== "permission") {
      if (named.length === 0) return false;

      return yield* refuse(`--${named.map((k) => k.replace("_", "-")).join(", --")} name the refused call of a permission (--kind permission)`);
    }

    if ((args.list("option") ?? []).length > 0) return yield* refuse("a permission's options are allow-once and deny, which the CLI sets: --option is not taken");

    if (args.str("recommend") !== undefined) return yield* refuse("a permission is the user's call alone: --recommend is not taken");
    const before = d.refusal ?? undefined;

    if (named.length === 0 && before !== undefined) return false;
    const tool = args.str("tool") ?? before?.tool;
    const call = args.str("call") ?? before?.call;
    const cause = args.str("cause") ?? before?.cause;
    const root = args.str("root") ?? before?.root;

    if (tool === undefined || call === undefined || cause === undefined || root === undefined) {
      return yield* refuse("a permission names the refused call: give --tool, --call, --cause and --root (and --agent-id for a subagent's call)");
    }

    const agentId = args.str("agent_id");
    const refusal = yield* makeRefusedCall({ tool, call, cause, root, agentId: agentId === undefined ? (before?.agent_id ?? null) : given(agentId) ? agentId : null });
    d.refusal = refusal;
    d.options = permissionOptions(refusal);

    return before === undefined || REFUSAL_KEYS.some((k) => before[k] !== refusal[k]);
  });
}

function setBody(run: Run, d: Decision): Step$ {
  const target = join(run.root, "decisions", `${d.id}.html`);

  if (run.args.flag("no_body")) {
    remove(target);
    d.body = false;

    return Effect.void;
  }

  const source = run.args.str("body");

  if (!given(source)) return Effect.void;
  const content = readOrWhy(source);

  if ("why" in content) return refuse(`cannot read the body ${source}: ${content.why}`);
  makeDirs(join(run.root, "decisions"));
  writeBytes(target, content);
  d.body = true;

  return Effect.void;
}

/** The decision is no longer held by the fleet: re-presented, closed, or the hold taken back. */
function unheld(d: Decision): void {
  delete d.held;
  delete d.held_at;
  dropKey(d, "held");
  dropKey(d, "held_at");
}

function isHeld(d: Decision): boolean {
  return given(d.held ?? undefined);
}

function close(run: Run, ledger: Ledger, d: Decision, outcome: { readonly status: string; readonly answer: string | null; readonly resolution: string }): void {
  d.status = outcome.status;
  d.answer = outcome.answer;
  d.resolution = outcome.resolution;
  d.closed = stamp(run);
  unheld(d);

  if (outcome.status === "decided") {
    log(run, ledger, { kind: "decision", text: `${d.title ?? "None"}: ${outcome.answer ?? "None"} (${outcome.resolution})`, agent: d.agent ?? null, decision: d.id });
  } else {
    log(run, ledger, { kind: "resolved", text: `${d.title ?? "None"} withdrawn: ${outcome.resolution}`, agent: d.agent ?? null, decision: d.id });
  }

  for (const r of ledger.roadblocks) {
    if (r.decision === d.id && !r.resolved) resolve(run, ledger, r);
  }
}

const FIELDS = ["kind", "title", "question", "why", "recommend", "reason", "secret", "manual", "agent", "step", "milestone"] as const;

function placeOf(ledger: Ledger, d: Decision, run: Run): Step$ {
  const stepId = run.args.str("step");
  const milestoneId = run.args.str("milestone");

  if (given(stepId)) {
    const m = milestoneOfStep(ledger, stepId);

    if (m === undefined) return refuse(`unknown step '${stepId}'`);
    d.step = find(m.steps, stepId)?.id ?? stepId;
    d.milestone = m.id;
  }

  if (given(milestoneId)) {
    if (find(ledger.roadmap, milestoneId) === undefined) {
      const ids = milestoneIds(ledger);

      return refuse(`unknown milestone '${milestoneId}' (the roadmap has: ${ids === "" ? "none" : ids})`);
    }

    d.milestone = milestoneId;
  }

  if (given(d.agent ?? undefined) && !given(d.milestone ?? undefined)) {
    d.milestone = find(ledger.agents, d.agent ?? "")?.milestone ?? null;
  }

  return Effect.void;
}

function waitHint(run: Run, id: string): string {
  return `\`${FLEET_BIN} chat ${run.root} wait ${id}\``;
}

/** `decision`: open, revise, place, decide or withdraw a decision; one decided elsewhere is recorded closed. */
export function decision(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  return Effect.gen(function* () {
    const args = run.args;
    ledger.decisions ??= [];
    const rows = ledger.decisions;
    const id = args.str("id") ?? "";
    let d = findDecision(ledger, id);
    const decide = args.str("decide");
    const withdraw = args.str("withdraw");
    const resolution = args.str("resolution");
    const hold = args.str("hold");
    const unhold = args.flag("unhold");

    if (decide !== undefined && !given(resolution)) {
      return yield* refuse('--decide says what was chosen and --resolution how it came ("answered on the page (#14)", "said in the session")');
    }

    const agent = args.str("agent");

    if (given(agent) && !known(ledger, agent)) return yield* refuse(`unknown agent '${agent}'`);
    const options = args.list("option");
    const body = args.str("body");

    if (d === undefined && (hold !== undefined || unhold)) return yield* refuse(`unknown decision '${id}'`);

    if (d !== undefined && d.status !== "open") {
      const onlyPlace =
        (args.str("step") !== undefined || args.str("milestone") !== undefined) &&
        !FIELDS.some((k) => k !== "step" && k !== "milestone" && args.str(k) !== undefined) &&
        (options === undefined || options.length === 0) &&
        !given(body) &&
        decide === undefined &&
        withdraw === undefined &&
        hold === undefined &&
        !unhold;

      if (onlyPlace) {
        yield* placeOf(ledger, d, run);

        return ledger;
      }

      return yield* refuse(`${closedBecause(d)}. A closed decision stays as it is; open a new one with --supersedes ${d.id}`);
    }

    let supersedes = args.str("supersedes");

    if (d === undefined) {
      if (!ID.test(id)) return yield* refuse(`decision id ${pyStr(id)} should be letters, digits, '_', '.', or '-'`);

      if (given(supersedes)) {
        const old = findDecision(ledger, supersedes);

        if (old === undefined) return yield* refuse(`unknown decision '${supersedes}'`);

        if (old.status === "open") return yield* refuse(`${old.title ?? "None"} is still open; change it instead of superseding it`);
        supersedes = old.id;
      }

      const elsewhere = decide !== undefined;
      yield* require(run, elsewhere ? ["title", "question"] : ["kind", "title", "question", "why"], "decision");
      const kind = args.str("kind");

      const fresh: Decision = {
        id,
        kind: given(kind) ? kind : "decision",
        title: args.str("title") ?? "",
        question: args.str("question") ?? "",
        why: args.str("why") ?? null,
        blocking: args.flag("blocking"),
        agent: given(agent) ? agent : null,
        options: yield* parseOptions(options ?? []),
        recommend: args.str("recommend") ?? null,
        reason: args.str("reason") ?? null,
        secret: args.str("secret") ?? null,
        manual: args.str("manual") ?? null,
        body: false,
        page: !elsewhere,
        supersedes: supersedes ?? null,
        status: "open",
        answer: null,
        resolution: null,
        change: null,
        asks: given(args.str("asks")) ? (args.str("asks") ?? "user") : "user",
        opened: stamp(run),
        revised: null,
        closed: null,
        step: null,
        milestone: null,
      };

      yield* placeOf(ledger, fresh, run);

      yield* setRefusal(run, fresh);

      if (!elsewhere) {
        yield* checkKind(fresh);
        yield* setBody(run, fresh);
        const forManager = fresh.asks === "manager";
        log(run, ledger, {
          kind: "asked",
          text: `${forManager ? "For the manager: " : ""}${fresh.title ?? "None"}: ${fresh.question ?? "None"}`,
          agent: fresh.agent ?? null,
          important: (fresh.blocking ?? false) && !forManager,
          decision: fresh.id,
        });
      }

      rows.push(fresh);

      if (!elsewhere) {
        run.say(
          `asked ${fresh.id}. Arm its answer's wake now, as a background command (run_in_background): ` +
            `${waitHint(run, fresh.id)}: it exits with the user's answer the moment it is given.`,
        );
      }

      d = fresh;
    } else {
      if (given(supersedes)) return yield* refuse("--supersedes is given when the new decision is opened");

      if (unhold && !isHeld(d)) return yield* refuse(`${d.title ?? "None"} is not held: --unhold takes back a --hold`);

      if (hold !== undefined && hold.trim() === "") return yield* refuse("--hold says what the fleet does first, before the item comes back to the user");
      const question = args.str("question");
      const asksAnew = question !== undefined && question !== d.question;
      const kindNow = given(args.str("kind")) ? args.str("kind") : d.kind;

      if (asksAnew && kindNow === "decision" && (options === undefined || options.length === 0) && !args.flag("same_options")) {
        return yield* refuse(
          "the question changed, and the options on the page would be the old question's: give them again " +
            "(--option, once per option, with --recommend and --reason), or pass --same-options when they still answer it",
        );
      }

      const changed: string[] = FIELDS.filter((k) => args.str(k) !== undefined);

      if (options !== undefined && options.length > 0) changed.push("option");

      if (given(body)) changed.push("body");
      const row = d;

      for (const key of FIELDS) {
        if (key === "step" || key === "milestone") continue;
        const value = args.str(key);

        if (value === undefined) continue;

        // An emptied field is stored as null, as Python's `or None` stores it (open-7); kind takes no
        // empty value (its choices refuse it).
        if (key === "kind") row[key] = value;
        else row[key] = value === "" ? null : value;
      }

      if (args.str("step") !== undefined || args.str("milestone") !== undefined) yield* placeOf(ledger, row, run);

      if (options !== undefined && options.length > 0) row.options = yield* parseOptions(options);

      if (args.flag("blocking") || args.flag("not_blocking")) {
        row.blocking = args.flag("blocking");
        changed.push("blocking");
      }

      if (args.flag("no_body")) changed.push("body");
      const asks = args.str("asks");
      const passedOn = asks === "user" && row.asks === "manager";

      if (given(asks) && asks !== (row.asks ?? "user")) {
        row.asks = asks;
        changed.push("asks");
      }

      if (yield* setRefusal(run, row)) changed.push("refusal");
      yield* checkKind(row);
      yield* setBody(run, row);

      if (changed.length > 0) {
        const logText = args.str("log");
        row.revised = stamp(run);
        row.change = given(logText) ? logText : null;
        log(run, ledger, {
          kind: "asked",
          text: passedOn ? `${row.title ?? "None"} now asks you: ${row.question ?? "None"}` : `${row.title ?? "None"} changed: ${given(logText) ? logText : changed.join(", ")}`,
          agent: row.agent ?? null,
          important: passedOn && row.blocking === true,
          decision: row.id,
        });

        // Re-presented with new words: back on the user's list.
        if (["question", "option", "manual", "refusal"].some((k) => changed.includes(k))) unheld(row);
      }

      if (hold !== undefined) {
        row.held = hold;
        row.held_at = stamp(run);
        log(run, ledger, { kind: "note", text: `${row.title ?? "None"} held by the fleet: ${hold}`, agent: row.agent ?? null, decision: row.id });
      } else if (unhold) {
        unheld(row);
        log(run, ledger, { kind: "note", text: `${row.title ?? "None"} no longer held by the fleet`, agent: row.agent ?? null, decision: row.id });
      }
    }

    if (decide !== undefined) close(run, ledger, d, { status: "decided", answer: decide, resolution: resolution ?? "" });
    else if (withdraw !== undefined) close(run, ledger, d, { status: "withdrawn", answer: null, resolution: withdraw });

    return ledger;
  });
}

// -- grillings ------------------------------------------------------------------------------------

function questionOf(text: string, what: string): Effect.Effect<readonly [string, string], Refusal> {
  const colon = text.indexOf(":");
  const head = (colon >= 0 ? text.slice(0, colon) : text).trim();

  if (colon < 0 || !/^[Qq]\d+$/.test(head)) return refuse(`${what} starts with the question's number: "Q3: ..."`);

  return Effect.succeed([head.toLowerCase(), text.slice(colon + 1).trim()] as const);
}

function asked(text: string): Effect.Effect<readonly [string, string, string, string], Refusal> {
  const parts = text.split("|").map((x) => x.trim());
  const [title = "", body = "", recommend = "", why = ""] = parts;

  if (parts.length !== 4 || parts.some((x) => x === "")) {
    return refuse(
      '--ask takes "title | the question, with its choices and what each leads to | your recommended answer | ' +
        'why: the reason and the evidence for it, and what it costs or rules out"',
    );
  }

  return Effect.succeed([title, body, recommend, why] as const);
}

/** `grill`: a round of numbered questions, answered one by one on the page, until none is open. */
export function grill(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  return Effect.gen(function* () {
    const args = run.args;
    const id = args.str("id") ?? "";
    let d = findDecision(ledger, id);
    const created = d === undefined;

    if (d !== undefined && d.kind !== "grill") return yield* refuse(`${id} is a ${d.kind}, not a grilling`);

    if (d !== undefined && d.status !== "open") return yield* refuse(closedBecause(d));
    const asks = args.list("ask") ?? [];

    if (d === undefined) {
      if (!ID.test(id)) return yield* refuse(`grilling id ${pyStr(id)} should be letters, digits, '_', '.', or '-'`);

      if (!given(args.str("title")) || asks.length === 0) {
        return yield* refuse("a new grilling needs --title and its first round (--ask, once per question)");
      }

      const agent = args.str("agent");

      const fresh: Decision = {
        id,
        kind: "grill",
        title: args.str("title") ?? "",
        question: "",
        why: args.str("why") ?? null,
        blocking: args.flag("blocking"),
        agent: given(agent) ? agent : null,
        options: [],
        recommend: null,
        reason: null,
        secret: null,
        manual: null,
        body: false,
        page: true,
        supersedes: null,
        status: "open",
        answer: null,
        resolution: null,
        change: null,
        asks: "user",
        opened: stamp(run),
        revised: null,
        closed: null,
        questions: [],
        step: null,
        milestone: null,
      };

      if (given(agent) && !known(ledger, agent)) return yield* refuse(`unknown agent '${agent}'`);
      ledger.decisions ??= [];
      ledger.decisions.push(fresh);
      d = fresh;
    }

    const row = d;

    if (given(args.str("step")) || given(args.str("milestone")) || (created && given(row.agent ?? undefined))) {
      yield* placeOf(ledger, row, run);
    }

    row.questions ??= [];
    const qs = row.questions;
    const byId = new Map(qs.map((q) => [q.id, q]));
    const of = args.str("of");

    if (given(of) && !byId.has(of.toLowerCase())) return yield* refuse(`--of ${of}: no such question in ${row.id}`);

    const lookup = (qid: string): Effect.Effect<Question, Refusal> => {
      const q = byId.get(qid);

      return q === undefined ? refuse(`no question ${qid.toUpperCase()} in ${row.id}`) : Effect.succeed(q);
    };

    for (const text of args.list("answer") ?? []) {
      const [qid, answer] = yield* questionOf(text, "--answer");
      const q = yield* lookup(qid);
      Object.assign(q, { status: "answered", answer, answered: stamp(run) });
    }

    for (const text of args.list("drop") ?? []) {
      const [qid, reason] = yield* questionOf(text, "--drop");
      const q = yield* lookup(qid);
      Object.assign(q, { status: "dropped", answer: null, dropped: reason, answered: stamp(run) });
    }

    const revisions = args.list("revise") ?? [];

    for (const text of revisions) {
      const [qid, rest] = yield* questionOf(text, "--revise");
      const q = yield* lookup(qid);
      const [title, body, recommend, why] = yield* asked(rest);
      Object.assign(q, { title, body, recommend, reason: why, status: "open", answer: null, asked: stamp(run) });
    }

    const reasons = args.list("reason") ?? [];

    for (const text of reasons) {
      const [qid, why] = yield* questionOf(text, "--reason");
      const q = byId.get(qid);

      if (q === undefined || why === "") {
        return yield* refuse(`--reason "Q3: why": no question ${qid.toUpperCase()} in ${row.id}, or no reason given`);
      }

      q.reason = why;
    }

    const added: Question[] = [];

    for (const text of asks) {
      const [title, body, recommend, why] = yield* asked(text);

      const q: Question = {
        id: `q${qs.length + 1}`,
        title,
        body,
        recommend,
        reason: why,
        of: given(of) ? of.toLowerCase() : null,
        status: "open",
        answer: null,
        asked: stamp(run),
      };

      qs.push(q);
      added.push(q);
    }

    const open = qs.filter((q) => q.status === "open");
    row.question = open.length > 0 ? `${open.length} question${open.length === 1 ? "" : "s"} to answer` : "Every question is answered";

    if (added.length > 0 && created) {
      run.say(
        `asked ${row.id}. Arm its answers' wake now, as a background command (run_in_background): ` +
          `${waitHint(run, row.id)}; arm it again after each round.`,
      );
    }

    if (added.length > 0 || revisions.length > 0 || reasons.length > 0) {
      if (!created) row.revised = stamp(run);

      // A new round re-presents it.
      if (added.length > 0 || revisions.length > 0) unheld(row);

      const words =
        added.length > 0
          ? `${added.length} new question${added.length === 1 ? "" : "s"}`
          : revisions.length > 0
            ? "a question revised"
            : "reasons added";

      log(run, ledger, { kind: "asked", text: `${row.title ?? "None"}: ${words}`, agent: row.agent ?? null, important: row.blocking === true, decision: row.id });
    }

    const done = args.str("done");

    if (done !== undefined) {
      if (open.length > 0) {
        return yield* refuse(`${open.map((q) => q.id.toUpperCase()).join(", ")} still open: answer them, drop them, or ask what is left`);
      }

      close(run, ledger, row, { status: "decided", answer: done, resolution: "grilling finished" });
    }

    return ledger;
  });
}

/** `event`: one entry of the log. */
export function event(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  const agent = run.args.str("agent");

  if (given(agent) && !known(ledger, agent)) return refuse(`unknown agent '${agent}'`);
  const kind = run.args.str("kind");
  log(run, ledger, {
    kind: given(kind) ? kind : "note",
    text: run.args.str("text") ?? "",
    agent: agent ?? null,
    important: run.args.flag("important"),
  });

  return Effect.succeed(ledger);
}

/** The kinds a decision may be opened as with `decision` (a grilling is opened with `grill`). */
export const DECISION_KINDS = KINDS;
