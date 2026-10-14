/**
 * The ledger's commands (Python's `state.py` handlers): one per event, create and update sharing a verb.
 * Each takes the ledger as read (a fresh copy it may change) and the command's arguments, prints what
 * the command says, and gives back the ledger to write (none for `show`) or a refusal. What it says is
 * printed only once the ledger it gives back is checked (open-2).
 */
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { readChat } from "../chat/store.ts";
import { stampOf } from "../clock.ts";
import type { Args } from "../cli/args.ts";
import { Refusal, stateRefusal } from "../errors.ts";
import { asArray, asObject, asString, parseJson, pyStr, type Json, type JsonObject } from "../json.ts";
import { FLEET_BIN, isDir, makeDirs, readOrWhy, readText, remove, resolvePath, writeBytes } from "../files.ts";
import { fleetOf, managerOf, post as postNews, TEXT_MAX } from "../news/news.ts";
import { allowedByUser, explainCommand, explained, failedAnswer, failureWords } from "../health.ts";
import { placeRoot, registeredSession } from "../hub/grants.ts";
import { pidOfEntry } from "../registry.ts";
import { workerFigures, workerTitle } from "../transcripts.ts";
import type { Machine } from "../world.ts";
import { isFormatted, manualBlocks } from "../../page/src/text.ts";
import { isMarkdownFile, markdownToHtml, markdownWarning } from "./body.ts";
import { dropKey, type Approval, type LedgerEvent, type Agent, type Choice, type Decision, type Ledger, type Milestone, type Question, type RefusalDraft, type RefusedCall, type Roadblock, type Step } from "./model.ts";
import { find, findDecision, highest, milestoneOfStep, misnumbered, nextStepId, PREFIX, readsAsNumber } from "./numbers.ts";
import { approvalNumber, nextDecisionRef, refusedFor, Unreachable } from "./shared-numbers.ts";
import { approvalSource, comesFrom, namesOf, NoSource, refOf, sameSource } from "./approvals.ts";
import { LINK_KINDS, linkKind, OLD_LINK_KINDS, type LinkKind } from "./links.ts";
import { ALLOW_ONCE, callsLine, callsOf, grantFileOf, isAsk, makeRefusedCall, permissionOptions, refusalRev } from "./permission.ts";
import { foldersOf, permissionWords, type RefusedBy, type Spawn } from "./permission-words.ts";
import { askedDraft, callerOf, draftCommands, draftLine, openDraft, partOfRefused, shown } from "./refusal-draft.ts";
import { roleDefaults, spawnLine } from "./roles.ts";
import { CHOICE_KINDS, DRAFT_KIND, ID, KINDS, nameRefusal } from "./validate.ts";
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
  /** Do `task` once the ledger is written (a notice's news item), printing the line it gives back: never for a refused command. */
  readonly after: (task: () => string | undefined) => void;
  /** Tell the fleet's host `text` once the ledger is written, as the hub tells it (chat/hub-line.ts `tellHost`):
   * in its chat while its watch runs, else in its session. Never for a refused command. `missed` runs when the
   * line reached neither, on the ledger the command gave back, which is then written once more. */
  readonly tell: (text: string, missed?: () => void) => void;
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
export const EVENT_KINDS = ["spawned", "reported", "blocked", "resolved", "asked", "decision", "note", "integrated", "reviewed"] as const;

/** A jj change id, as a `reviewed` event names one. */
const CHANGE_ID = /^[A-Za-z0-9]+$/u;

/** The choices asked of the user in a day after which a fleet with no advisor starts one. */
const ADVISOR_AFTER = 3;

/** An approval's id: K and a number; the other letters number decisions, links and roadblocks. */
const APPROVAL_ID = /^K[0-9]+$/u;

/** What `approval` does. */
const APPROVAL_ACTIONS = ["add", "list", "revoke"] as const;

/** The kinds `link --kind` takes: the five, and the two of links recorded before them. */
export const LINK_KIND_CHOICES = [...LINK_KINDS, ...OLD_LINK_KINDS] as const;

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

/** Whether worker `a`'s name was given by someone (the user, the coordinator, or before `name_by` was
 * recorded, any name but the id), so no session name replaces it. */
function namedBySomeone(a: Agent): boolean {
  return a.name_by === "user" || a.name_by === "coordinator" || (a.name_by === undefined && a.name !== a.id);
}

/** Name each worker row that names its task id and nobody named after what its session calls it (its
 * meta.json), on every write; a name a mention could not tell apart from another is passed over. */
export function nameFromSessions(machine: Machine, root: string, ledger: Ledger): void {
  const unnamed = ledger.agents.filter((a) => given(a.task_id) && !namedBySomeone(a));
  const folders = unnamed.length === 0 ? [] : machine.registry.sessionFolders(root);

  for (const a of unnamed) {
    const title = workerTitle(folders, a.task_id ?? "");

    if (title === undefined || title === a.name || nameRefusal(ledger, a.id, title) !== undefined) continue;
    a.name = title;
    a.name_by = "session";
  }
}

/** `link`: a place the user opens (a preview, a prototype, a doc, a tool, a service). */
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
    const purpose = run.args.str("for");
    const done = run.args.flag("done");
    const reopen = run.args.flag("reopen");

    if (item === undefined && (done || reopen)) return yield* refuse(`no link '${id}' to mark ${done ? "done" : "open again"}`);

    const named = given(title) ? workerIds([title], workersOf(ledger)) : [];

    if (named.length > 0) run.warn(workerWarning(`link ${id}'s title`, named));

    if (item === undefined) {
      if (!given(url) || !given(title)) return yield* refuse("a new link needs --url and --title");

      const fresh = {
        id,
        url,
        title,
        kind: given(kind) ? kind : linkKind(undefined, url, title),
        decision: decision ?? null,
        agent: agent ?? null,
        note: note ?? null,
        for: given(purpose) ? purpose : null,
        since: stamp(run),
      };

      if (!given(kind)) {
        run.warn(`state: link ${id} has no --kind: recorded as ${fresh.kind}. Say which it is: ${LINK_KINDS.join(", ")} (the preview is the fleet's one live app).`);
      }

      links.push(fresh);
      log(run, ledger, {
        kind: "note",
        text: `${KIND_WORDS[linkKind(fresh.kind, url, title)]} ${fresh.title}: ${fresh.url}`,
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

    if (purpose !== undefined) item.for = orNull(purpose);

    if (done) {
      item.done = stamp(run);
      log(run, ledger, { kind: "note", text: `Link ${id} (${item.title ?? "None"}) done`, agent: item.agent ?? null, decision: item.decision ?? null });
    }

    if (reopen && item.done !== undefined) {
      delete item.done;
      log(run, ledger, { kind: "note", text: `Link ${id} (${item.title ?? "None"}) open again`, agent: item.agent ?? null, decision: item.decision ?? null });
    }

    return ledger;
  });
}

/** How the log names a new link of each kind. */
const KIND_WORDS: Readonly<Record<LinkKind, string>> = { preview: "Preview", prototype: "Prototype", doc: "Doc", tool: "Tool", service: "Service" };

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
      const skillOf = given(args.str("skill")) ? (args.str("skill") ?? "none") : "none";

      const fresh: Agent = {
        id,
        name: given(args.str("name")) ? (args.str("name") ?? id) : id,
        task: args.str("task") ?? "",
        skill: skillOf,
        ...roleDefaults(skillOf, args.str("model"), args.str("effort")),
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

      if (given(args.str("name"))) fresh.name_by = "coordinator";
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
      run.say(spawnLine(fresh.id, fresh.skill, fresh.model, fresh.effort));

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

    if (given(name)) {
      a.name = name;
      a.name_by = "coordinator";
    } else if (name !== undefined) {
      a.name = a.id;
      delete a.name_by;
      dropKey(a, "name_by");
    }

    const task = args.str("task");

    if (task !== undefined) a.task = task;
    const skill = args.str("skill");

    if (skill !== undefined) a.skill = skill;
    const model = args.str("model");

    if (model !== undefined) a.model = model;
    const effort = args.str("effort");

    if (effort !== undefined) a.effort = effort;

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

/** The number of non-empty lines of a `--manual` that has more than one and no fence; 0 when it is fine. */
function unfencedLines(manual: string): number {
  if (manual.includes("```")) return 0;
  const lines = manual.split("\n").filter((l) => l.trim() !== "").length;

  return lines > 1 ? lines : 0;
}

/** A manual step longer than this, in characters, is a real step, not an approval asked in words. */
const APPROVAL_STEP_MAX = 120;

const APPROVAL_WORD = String.raw`["'\x60*“”‘’]*(?:go|go ahead|yes|y|no|n|ok|okay|approved?|confirm(?:ed)?|accept(?:ed)?|lgtm|done|proceed|ship it)["'\x60*“”‘’]*`;

/* A `--manual` that only asks the user to answer on the page: "Answer Go on this card", "reply yes", "approve this",
 * "confirm". A step that names a place outside the page ("click Yes in the console") or a command is not one. */
const APPROVAL_RE = new RegExp(
  String.raw`^(?:(?:please|just|then|now)\s+)*` +
    String.raw`(?:(?:answer|reply|respond|type|say|write|send|enter|click|press|hit|pick|choose|select)(?:\s+(?:with|in|by))?\s+(?:an?\s+)?${APPROVAL_WORD}` +
    String.raw`|(?:approve|confirm|accept|ok|okay|sign off(?:\s+on)?|green-?light)` +
    String.raw`(?:\s+(?:it|this|that|(?:the|this|my)\s+(?:plan|change|changes|step|card|decision|proposal|recommendation|option|merge|push|landing)))?)` +
    String.raw`(?:\s+(?:on|in|to|from|at)\s+(?:this|the)\s+(?:card|page|decision|dashboard|chat|item|question))?` +
    String.raw`(?:\s+(?:here|below|above))?` +
    String.raw`(?:\s+(?:to|so)\s+(?:start|begin|proceed|continue|go ahead|unblock|approve|confirm|let)\b[^.!?]*)?` +
    String.raw`(?:\s+when\s+(?:you(?:'re| are)\s+)?ready)?$`,
  "u",
);

/** True when a `--manual` only asks the user to answer, approve or confirm on the page: that is a decision. */
export function asksApproval(manual: string): boolean {
  if (manual.includes("```") || chars(manual.trim()) > APPROVAL_STEP_MAX) return false;

  const text = manual
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/u, "")
    .replace(/[.!:;,\s]+$/u, "");

  return APPROVAL_RE.test(text);
}

/** A fenced block of a `--manual`: its tag, lower-cased ("" when the fence names none), and its lines. */
type Fence = { readonly lang: string; readonly body: readonly string[] };

/**
 * A `--manual` as the page shows it. The page's own reader (`manualBlocks`, fleet/page/src/text.ts) is the one
 * reader of the format, so what is checked here is what Luiz sees: a fence the page does not read as one (tildes,
 * an indent of four or more, a backtick after the tag) is prose here too. `fences` are the blocks the page
 * renders as code; `lines` its prose, line by line, inline code as its text; `inline` that inline code; `bare`
 * the whole text when it has no backtick and its every line reads as a command, which the page shows as one nu
 * block (its lines are then in `lines` too, for a numbered step among them).
 */
function manualShown(manual: string) {
  const blocks = manualBlocks(manual);
  const plain = manual.replace(/\r\n?/gu, "\n").split("\n");

  if (blocks === null) return { fences: [], lines: plain, inline: [], bare: undefined };

  if (!isFormatted(manual)) return { fences: [], lines: plain, inline: [], bare: manual.trim() };
  const fences: Fence[] = blocks.flatMap((block) => (block.kind === "code" ? [{ lang: block.lang, body: block.text.split("\n") }] : []));
  const prose = blocks.flatMap((block) => (block.kind === "para" ? [block.spans] : []));

  return {
    fences,
    lines: prose.flatMap((spans) => spans.map((span) => span.text).join("").split("\n")),
    inline: prose.flatMap((spans) => spans.flatMap((span) => (span.kind === "code" ? [span.text] : []))),
    bare: undefined,
  };
}

/** How many lines of a fenced block are commands: neither blank nor a comment (a line that opens with `#`). */
function commandLines(fence: Fence): number {
  return fence.body.filter((line) => line.trim() !== "" && !line.trim().startsWith("#")).length;
}

/** The numbers of a manual's numbered steps (`1.` or `1)` opening a line outside a fence), in the order written. */
function numberedSteps(manual: string): number[] {
  return manualShown(manual).lines.flatMap((line) => {
    const step = /^\s*(\d+)[.)]\s+\S/u.exec(line);

    return step === null ? [] : [Number(step[1])];
  });
}

const ACTION_TELLS =
  "An action tells the user exactly what to type or click, in order: the commands in a fenced block (a line ```nu, the commands, a line ```; one command goes in a fence too), " +
  'or numbered steps from 1 that each say what to type or click (1. In the Perf terminal, type `/exit`. 2. In the 1Password window, click "Approve".). ' +
  "If you cannot write that, you do not know the action yet";

/**
 * Why an action's `--manual` is refused: it says what must be done and not how. It passes with a fenced block
 * that holds at least one line that is no comment, or with a numbered list that starts at 1; nothing else, so
 * the check reads no language and looks nothing up on the machine it runs on. Measured 2026-10-12 on the
 * machine's fleets: of 138 actions, 75 had a fence, 5 numbered steps, and 58 neither; Luiz, on one of those:
 * "There's no action, nothing, just something that says something must be done, not how."
 */
export function actionManualRefusal(manual: string): string | undefined {
  if (manualShown(manual).fences.some((fence) => commandLines(fence) > 0) || numberedSteps(manual)[0] === 1) return undefined;

  return `--manual says what must be done, not how: it has no fenced block with a command in it and no numbered steps from 1. ${ACTION_TELLS}`;
}

const APPROVAL_REFUSAL =
  "--manual only asks the user to answer: an approval is a decision: " +
  "`fleet state <dir> decision ID --kind decision --option 'A: yes | what yes does' --option 'B: no | what no does' --recommend A --reason R`; " +
  "an action is for steps Luiz performs outside the page (a command to run, a click in a console, a key to plug in)";

/** What `d`'s kind shows has to be there; `manualGiven`: the `--manual` is this command's, or the row became this
 * kind in this command, so its format is checked (a row recorded before a rule stays as it is). */
function checkKind(d: Decision, manualGiven: boolean): Step$ {
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

  const numbered = d.kind === "action" && numberedSteps(d.manual ?? "").length > 0;
  const unfenced = (d.kind === "secret" || d.kind === "action") && manualGiven && !numbered ? unfencedLines(d.manual ?? "") : 0;

  if (unfenced > 0) {
    return refuse(`--manual has ${unfenced} lines and no fence: put the commands in a fenced block (a line \`\`\`nu, the commands, a line \`\`\`), any prose outside it`);
  }

  const shell = (d.kind === "secret" || d.kind === "action") && manualGiven ? shellRefusal(d.manual ?? "") : undefined;

  if (shell !== undefined) return refuse(shell);

  if (d.kind === "action" && manualGiven && asksApproval(d.manual ?? "")) return refuse(APPROVAL_REFUSAL);
  const vague = d.kind === "action" && manualGiven ? actionManualRefusal(d.manual ?? "") : undefined;

  if (vague !== undefined) return refuse(vague);

  if (d.kind === "action" && ((d.options ?? []).length > 0 || given(d.recommend ?? undefined))) {
    return refuse("an action is a step only the user takes, with no options to choose: a yes or no on what the fleet would do is a decision (--kind decision, with the options and --recommend)");
  }

  return Effect.void;
}

/** Characters: the ask alone, one or two sentences (fleet/SPEC.md, decision); 95% of the asks recorded fit. */
const QUESTION_MAX = 400;

/** A question this long with no body is warned about. */
const QUESTION_NEAR = 300;

/** An option's consequence over this is warned about: one sentence. */
const CONSEQUENCE_MAX = 160;

/** Characters as Python counts them: code points. */
const chars = (text: string): number => [...text].length;

/** A `--question` over QUESTION_MAX characters is refused: the plan, the settings and the numbers go in `--body`.
 * A permission's question, which the hook writes from the refused call, is not checked. */
function checkQuestion(question: string | undefined, kind: string | null | undefined): Step$ {
  if (question === undefined || kind === "permission" || chars(question) <= QUESTION_MAX) return Effect.void;
  const n = chars(question);

  return refuse(
    `--question is ${n} characters, ${n - QUESTION_MAX} over the ${QUESTION_MAX} a question holds: ` +
      "keep the ask, one or two plain sentences, and move the plan, the settings and the numbers into --body FILE " +
      "(an HTML fragment: In short, What you're deciding, The plan, Settings, Cost and risk, How to undo, " +
      "What happens after you answer)",
  );
}

/** A `--why` over this, in characters, is refused: one or two lines; the plan goes in `--body`. */
const WHY_REFUSED = 400;

/** A why over this is warned about: one line on why it needs the user, and what it blocks or assumes. */
const WHY_MAX = 200;

const JARGON = ["sha1", "sha256", "digest", "stage cache", "alias", "uuid", "idempotent", "upsert", "blob", "enum", "turn gate", "gold", "harness", "rubric", "jev"];

/** A word that may name a worker: letters, digits, '_' and '-', standing alone (b333, invoice-gen). */
const TOKEN_RE = /[A-Za-z0-9_-]+/gu;

/** The fleet's workers as the ledger records them: every agent row's id and name, lower-cased. */
function workersOf(ledger: Ledger): Set<string> {
  return new Set(ledger.agents.flatMap((a) => [a.id, a.name].flatMap((v) => (v ? [String(v).toLowerCase()] : []))));
}

/** A `--why` over WHY_REFUSED characters is refused: what the fleet does meanwhile, or why this needs the user, in
 * one or two lines; the plan goes in `--body`. A permission's is not checked. */
function checkWhy(why: string | undefined, kind: string | null | undefined): Step$ {
  if (why === undefined || kind === "permission" || chars(why) <= WHY_REFUSED) return Effect.void;
  const n = chars(why);

  return refuse(
    `--why is ${String(n)} characters, ${String(n - WHY_REFUSED)} over the ${String(WHY_REFUSED)} a why holds: say in one or two lines ` +
      "what the fleet does meanwhile, or why this needs the user, and move the plan, its parts and the cost into --body FILE",
  );
}

/** The workers' ids named in `texts`, each once, in the order found. */
function workerIds(texts: readonly string[], workers: ReadonlySet<string>): string[] {
  return [...new Set(texts.flatMap((t) => [...t.matchAll(TOKEN_RE)].flatMap((m) => (workers.has(m[0].toLowerCase()) ? [m[0]] : []))))];
}

function workerWarning(what: string, found: readonly string[]): string {
  return `state: ${what} names workers (${found.join(", ")}): say what the work is ("the fixes for the timeline questions in the Lavínia case"); a worker's id or name means nothing to the user.`;
}

const JARGON_RE = new RegExp(`\\b(${JARGON.map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})\\b`, "giu");

const BASHISMS: readonly (readonly [string, RegExp])[] = [
  ["&&", /&&/u],
  ["export X=", /^\s*export\s+\w+=/mu],
  ["$(...)", /\$\(/u],
  ["2>&1", /2>&1/u],
];

/** The bash constructs of {@link BASHISMS} found in `text`, by name, in the list's order. */
function bashisms(text: string): string[] {
  return BASHISMS.flatMap(([name, pattern]) => (pattern.test(text) ? [name] : []));
}

/** The tags of a block Luiz runs in his shell. */
const NU_TAGS: ReadonlySet<string> = new Set(["nu", "nushell"]);

/**
 * The tags of a block that is no command: what Luiz pastes into a file, a form or another program's prompt, or
 * reads, never what he types at his shell. A settings file's content (json, jsonc for Claude's and VS Code's
 * settings, toml, yaml, yml, ini), words for a form or the output to expect (text, txt, markdown, md), an edit to
 * read (diff), and a statement for a database's own console (sql, cypher). Any other tag is refused: a tag the
 * list does not know (python, ts) may be a command as well as not, and `text` holds what is neither.
 */
const DATA_TAGS = ["json", "jsonc", "toml", "yaml", "yml", "ini", "text", "txt", "markdown", "md", "diff", "sql", "cypher"];

/** The data tags that hold words, where a command can hide: a bash construct in one is warned. The others hold a
 * format of their own, in which one is at home (a settings rule `Bash(a && b)`, a `&&` in SQL). */
const WORD_TAGS = ["text", "txt", "markdown", "md"];

/** Nushell's form for each bash construct of {@link BASHISMS}, as a refusal says them. `;` alone for `&&`: nu's
 * `and` is a boolean operator, and chains no commands. */
const NU_FORMS = "(`;` for `&&`, `$env.X = ...` for `export X=...`, `(cmd)` for `$(cmd)`, `o+e>|` for `2>&1 |`)";

/** `nu-check --debug` on `block`: whether it ran (not with no nu on PATH, a failure to start or a timeout),
 * its exit status and what it printed. */
function nuRun(block: string) {
  const done = spawnSync("nu", ["--no-config-file", "--stdin", "-c", "$in | nu-check --debug"], { input: block, encoding: "utf8", timeout: 20_000 });

  return { ran: done.error === undefined && done.status !== null, parses: done.status === 0, said: `${done.stderr}${done.stdout}` };
}

/** nu's error for a `source` or `use` whose file is not where the check runs: no parse error of the block's. */
const FILE_ABSENT = /nu::parser::(?:sourced_file_not_found|module_not_found)/u;

/** A `source` or `source-env` statement: the keyword and ONE path token, so what follows stays for nu to judge. */
const SOURCES = /(^|[;\n{(|])([ \t]*)(?:export[ \t]+)?source(?:-env)?[ \t]+(?:"[^"\n]*"|'[^'\n]*'|[^\s;|&]+)/gu;

/** A `use` or `overlay use` statement, up to its `;`, `|`, `&` or line end (`use a.nu *` takes the rest). */
const USES = /(^|[;\n{(|])([ \t]*)(?:export[ \t]+)?(?:use|overlay[ \t]+use)[ \t]+[^;\n|&]*/gu;

/**
 * What nushell says of `block`: whether the check ran, and why the block does not parse when it ran and does
 * not. nu resolves a `source` or `use` as it parses, in the directory of the CLI and not the one Luiz runs the
 * block in, and reports the absent file in place of any later error. So when its error is that one (by its
 * code, {@link FILE_ABSENT}), the block is checked again with those statements replaced by `null`: the second
 * verdict stands, and an absent file again (a path the replacement did not reach) passes.
 */
function nuCheck(block: string) {
  const first = nuRun(block);
  const again = first.ran && !first.parses && FILE_ABSENT.test(first.said) ? nuRun(block.replace(SOURCES, "$1$2null").replace(USES, "$1$2null")) : first;

  if (!again.ran || again.parses || FILE_ABSENT.test(again.said)) return { ran: again.ran, why: undefined };
  const found = [...again.said.matchAll(/Found : (.*)/gu)];

  return { ran: true, why: found.length > 0 ? (found.at(-1)?.[1] ?? "").trim() : "a parse error" };
}

/**
 * Why a secret's or action's `--manual` is refused for the shell its commands are in: Luiz runs them in
 * nushell (Luiz, 2026-10-13, on an action that gave him a bash line: "i use nushell... you already know this").
 * Read as the page shows it ({@link manualShown}), in this order:
 *  - a fenced block that holds a command is tagged nu (or nushell), or as what it is when it is no command
 *    ({@link DATA_TAGS}); one tagged for another shell, with another tag or with none is refused;
 *  - with no fenced block that holds a command, a bash construct anywhere in the text is refused, in backticks
 *    or not, and a text the page shows as one nu block (no backtick, every line a command) parses in nushell;
 *  - a nu block parses in nushell; where nu cannot judge it (not on PATH, a timeout), a known bash construct
 *    in it is refused instead.
 */
function shellRefusal(manual: string): string | undefined {
  const { fences, lines, inline, bare } = manualShown(manual);

  for (const [k, fence] of fences.entries()) {
    if (NU_TAGS.has(fence.lang) || DATA_TAGS.includes(fence.lang) || commandLines(fence) === 0) continue;
    const first = bashisms(fence.body.join("\n"))[0];

    return (
      `--manual's fenced block ${String(k + 1)} ${fence.lang === "" ? "has no tag" : `is tagged \`${fence.lang}\``}${first === undefined ? "" : ` and has \`${first}\``}: ` +
      `Luiz's shell is nushell, so write the commands in a \`\`\`nu block ${NU_FORMS}. ` +
      `A block that is no command for his shell takes the tag of what it is, one of ${DATA_TAGS.join(", ")}`
    );
  }

  if (!fences.some((fence) => NU_TAGS.has(fence.lang) && commandLines(fence) > 0)) {
    const loose = bashisms([...lines, ...inline].join("\n"))[0];

    if (loose !== undefined) return `--manual has \`${loose}\` and no fenced block that holds a command: Luiz's shell is nushell, so write the commands in a \`\`\`nu block ${NU_FORMS}`;
    const why = bare === undefined ? undefined : nuCheck(bare).why;

    if (why !== undefined) {
      return (
        `--manual has no fence and reads as a command, so the page shows it as one nushell block, and it does not parse in nushell (nu-check --debug: ${why}): ` +
        `write a command in a \`\`\`nu block so it runs in Luiz's shell ${NU_FORMS}, or steps that are sentences (a capital to open each, a period to end it)`
      );
    }
  }

  for (const [k, fence] of fences.filter((f) => NU_TAGS.has(f.lang)).entries()) {
    const block = fence.body.join("\n");
    const said = nuCheck(block);
    const found = said.ran ? [] : bashisms(block);

    if (said.why !== undefined) return `--manual's nu block ${String(k + 1)} does not parse in nushell (nu-check --debug: ${said.why}): write it so it runs in Luiz's shell ${NU_FORMS}`;

    if (found.length > 0) return `--manual's nu block ${String(k + 1)} has bash in it (${found.join(", ")}), and nu did not run here to parse it (not on PATH, or timed out): write it so it runs in Luiz's shell ${NU_FORMS}`;
  }

  return undefined;
}

/* What reads as needing a picture (coordinator SKILL.md, Decisions, the show-me triggers): parts that talk to each
 * other, or three or more amounts to weigh; a body with an <svg>, a <table> or an <img> has one. */
const ARCHITECTURE_RE = /\b(database|graph|neo4j|postgres|pipeline|stored in|lives in|queue)s?\b/giu;

const AMOUNT_RE = /(?:US\$|R\$|\$|€)\s?\d[\d.,]*|\d+(?:[.,]\d+)?\s?%/gu;

const VISUAL_RE = /<(?:svg|table|img)\b/iu;

/* A past answer of the user's, referred to: it names its decision's number (D18) in the same sentence. */
const PAST_RE = /\b(you decided|you said|you chose|your rule|as decided|you approved)\b/giu;

const NUMBER_RE = /\b[DAIG]\d+\b/iu;

const SENTENCE_RE = /(?<=[.!?])\s+|\n+/u;

/** The warning for `what` when a sentence of its words refers to what the user decided or said with no decision number in it. */
function unnamedPastWarning(what: string, texts: readonly string[], body: string): string | undefined {
  const found: string[] = [];

  for (const text of [...texts, body.replace(/<[^>]*>/gu, " ")]) {
    for (const sentence of text.split(SENTENCE_RE)) {
      if (!NUMBER_RE.test(sentence)) found.push(...[...sentence.matchAll(PAST_RE)].map((m) => (m[1] ?? "").toLowerCase()));
    }
  }

  if (found.length === 0) return undefined;
  const said = [...new Set(found)].map((w) => `"${w}"`).join(", ");

  return (
    `state: ${what} refers to what the user decided (${said}) with no decision number: name it in the same sentence, ` +
    'its number, when, and what was chosen ("D18, 10-08: Claude over MCP stays read-only until per-person login"); ' +
    "the page links the number."
  );
}

/** The body `d` carries, as written to DIR/decisions/ID.html; "" when it has none. */
function bodyText(root: string, d: Decision): string {
  return d.body === true ? (readText(join(root, "decisions", `${d.id}.html`)) ?? "") : "";
}

/** The show-me warning for `what` when its words name parts that talk to each other or carry three or more amounts
 * to compare, and its body has no picture. */
function visualWarning(what: string, texts: readonly string[], body: string): string | undefined {
  if (VISUAL_RE.test(body)) return undefined;
  const text = [...texts, body.replace(/<[^>]*>/gu, " ")].join("\n");
  const words = [...new Set([...text.matchAll(ARCHITECTURE_RE)].map((m) => (m[1] ?? "").toLowerCase()))];
  const amounts = [...text.matchAll(AMOUNT_RE)].length;
  const said = [...(words.length > 0 ? [words.join(", ")] : []), ...(amounts >= 3 ? [`${String(amounts)} amounts to compare`] : [])];

  if (said.length === 0) return undefined;

  return (
    `state: ${what} looks like it needs a visual (${said.join("; ")}): see coordinator SKILL.md #decisions ` +
    "(show-me triggers): a small inline SVG of the parts, a table of the numbers, in --body."
  );
}

/** What the CLI says, without refusing, about a decision hard to read; `fields`: the fields this command wrote. */
function readabilityWarnings(d: Decision, fields: ReadonlySet<string>, root?: string, workers: ReadonlySet<string> = new Set()): string[] {
  if (d.kind === "grill" || d.kind === "notice") return [];
  const out: string[] = [];
  const q = d.question ?? "";

  if (fields.has("question") && chars(q) > QUESTION_NEAR && d.body !== true) {
    out.push(`state: ${d.id}'s question is ${chars(q)} characters and it has no --body: say the ask in one or two sentences and put the plan, the settings and the numbers in --body FILE.`);
  }

  const words = [...new Set([...q.matchAll(JARGON_RE)].map((x) => (x[1] ?? "").toLowerCase()))].sort((a, b) => JARGON.indexOf(a) - JARGON.indexOf(b));

  if (fields.has("question") && words.length > 0) {
    out.push(`state: ${d.id}'s question uses words the user may not know (${words.join(", ")}): say what they mean in the domain's words, or leave them to the body.`);
  }

  const named = workerIds((["title", "question", "reason"] as const).flatMap((k) => (fields.has(k) ? [d[k] ?? ""] : [])), workers);

  if (named.length > 0) out.push(workerWarning(d.id, named));

  const why = d.why ?? "";

  if (fields.has("why") && chars(why) > WHY_MAX) {
    out.push(`state: ${d.id}'s why is ${chars(why)} characters: say in one line why it needs the user, and what it blocks or assumes meanwhile; the rest goes in --body.`);
  }

  const long = (d.options ?? []).filter((o) => chars(o.consequence ?? "") > CONSEQUENCE_MAX);

  if (fields.has("option") && long.length > 0) {
    const said = long.map((o) => `${o.id} (${chars(o.consequence ?? "")})`).join(", ");
    out.push(
      `state: ${d.id}'s consequences over ${CONSEQUENCE_MAX} characters: ${said}. Say each in one sentence; ` +
        "the detail goes in --body, and a setting the user may change on its own is its own option or decision.",
    );
  }

  if (fields.has("manual")) {
    const { lines, fences, inline } = manualShown(d.manual ?? "");
    const nushell = "Luiz's shell is nushell (`;`, `$env.X = ...`, `(...)`, `o+e>|`).";
    const inNu = bashisms(fences.flatMap((fence) => (NU_TAGS.has(fence.lang) ? fence.body : [])).join("\n"));
    const outside = bashisms([...lines, ...inline].join("\n"));

    if (inNu.length > 0) out.push(`state: ${d.id}'s manual has bash in a nu block (${inNu.join(", ")}): ${nushell}`);

    if (outside.length > 0) out.push(`state: ${d.id}'s manual has bash outside its fenced blocks (${outside.join(", ")}): ${nushell}`);

    for (const fence of fences.filter((f) => WORD_TAGS.includes(f.lang))) {
      const found = bashisms(fence.body.join("\n"));

      if (found.length > 0) out.push(`state: ${d.id}'s manual has bash in a ${fence.lang} block (${found.join(", ")}): a command for Luiz goes in a \`\`\`nu block. ${nushell}`);
    }
  }

  if (root !== undefined && ["question", "why", "body"].some((k) => fields.has(k))) {
    const past = unnamedPastWarning(d.id, [d.question ?? "", d.why ?? ""], bodyText(root, d));

    if (past !== undefined) out.push(past);
  }

  if (root !== undefined && d.kind === "decision" && ["question", "why", "body"].some((k) => fields.has(k))) {
    const visual = visualWarning(d.id, [d.question ?? "", d.why ?? ""], bodyText(root, d));

    if (visual !== undefined) out.push(visual);
  }

  return out;
}

/** A decision's revisable values, each as JSON, to tell which a revision moved. */
function snapshot(d: Decision): Map<string, string> {
  const out = new Map<string, string>(FIELDS.map((k) => [k, JSON.stringify(d[k] ?? null)]));
  out.set("option", JSON.stringify(d.options ?? null));
  out.set("blocking", JSON.stringify(d.blocking ?? null));

  return out;
}

/** The fields of `changed` whose value moved since `before`, as the revision's event lists them; one with no value kept (body, asks, refusal) counts as moved. */
function movedFields(changed: readonly string[], before: ReadonlyMap<string, string>, d: Decision): string {
  const after = snapshot(d);

  return changed.filter((k) => !before.has(k) || before.get(k) !== after.get(k)).join(", ");
}

/** The fields of the decision a command wrote, for its warnings. */
function writtenFields(args: Args): Set<string> {
  const out = new Set(["question", "why", "manual", "title", "reason", "body"].filter((k) => args.str(k) !== undefined));

  if ((args.list("option") ?? []).length > 0) out.add("option");

  return out;
}

const REFUSAL_FLAGS = ["tool", "call", "cause", "root", "agent_id"] as const;

/** Whether this command is the harness's record of a refused call (the hook's): it names the tool, cause or
 * root of the call. The coordinator explains a permission without these, `--call` naming alone the revision of
 * the call it explains (`callGuard`). */
function harnessWrites(args: Args): boolean {
  return REFUSAL_FLAGS.some((k) => k !== "call" && args.str(k) !== undefined);
}

/**
 * Whether this command asks for a permission before its call ran: it names the call's tool or root and no
 * cause, on a new row or on one asked so. An ask's title, why and recommendation are the coordinator's, given
 * with the call in one command; its question is still written from the call, so it never says less than it.
 * A row the host worded from a refusal draft (`worded`) is revised the same way: its words are the host's too.
 */
function asksAhead(args: Args, before: RefusedCall | undefined, worded = false): boolean {
  return harnessWrites(args) && args.str("cause") === undefined && (before === undefined || isAsk(before) || worded);
}

/** The fields an explanation of a permission writes, each bound to the call it was written for. */
const EXPLAINING = ["why", "recommend", "reason", "body"] as const;

/**
 * An explanation of a permission is for one call: `--call` names that call's revision (permission.ts
 * `callRev`, which the explain hint prints), and one written for a call the hook has since replaced is
 * refused, quoting the call it would land on.
 */
function callGuard(run: Run, d: Decision): Step$ {
  const r = d.refusal ?? undefined;

  if (d.kind !== "permission" || r === undefined || harnessWrites(run.args)) return Effect.void;
  const writes = EXPLAINING.filter((k) => run.args.str(k) !== undefined);

  if (writes.length === 0 && !run.args.flag("no_body")) return Effect.void;
  const rev = refusalRev(r);
  const named = run.args.str("call");
  const now = `${d.ref ?? d.id}'s call is now: ${callsLine(r)} (revision ${rev})`;

  if (named === undefined) return refuse(`an explanation of a permission names the call it explains, as --call ${rev}: ${now}. Read it, then explain this call`);

  if (named !== rev) return refuse(`--call ${named} is not the call this permission asks about any more: ${now}. Read it, then explain this call with --call ${rev}`);

  return Effect.void;
}

/** The ledger's `workspaces[]` paths, resolved, to the agent each is for. */
function workspaceAgents(root: string): Map<string, string> {
  const out = new Map<string, string>();
  let raw: Json;

  try {
    // SAFETY: JSON.parse returns JSON values only.
    raw = JSON.parse(readText(join(root, "state.json")) ?? "null") as Json;
  } catch {
    return out;
  }

  for (const item of asArray(asObject(raw)?.["workspaces"]) ?? []) {
    const row = asObject(item);
    const path = asString(row?.["path"]);
    const agent = asString(row?.["agent"]) ?? asString(row?.["id"]);

    if (path !== undefined && agent !== undefined && isAbsolute(path)) out.set(resolvePath(path), agent);
  }

  return out;
}

/**
 * The worker a permission's call came from, as the ledger has it: the row the hook named (`--agent`), the row
 * whose `task_id` is the harness's agent id, else the worker whose workspace the call changes into (a
 * `workspaces[]` row, or `<session root>-<worker id>` beside the session root, as the fleet names them).
 */
function refusedBy(run: Run, ledger: Ledger, d: Decision): RefusedBy | undefined {
  const r = d.refusal ?? undefined;
  const rowOf = (id: string | null | undefined): Agent | undefined => (given(id ?? undefined) ? ledger.agents.find((a) => a.id === id) : undefined);
  let row = rowOf(d.agent) ?? (r?.agent_id ? ledger.agents.find((a) => a.task_id === r.agent_id) : undefined);

  if (row === undefined && r !== undefined && r.tool === "Bash") {
    const listed = workspaceAgents(run.root);
    const sessionBase = basename(r.root.replace(/\/+$/u, ""));

    for (const folder of foldersOf(r.call).filter((f) => isAbsolute(f))) {
      const at = resolvePath(folder);
      const byName = dirname(at) === dirname(resolvePath(r.root)) && basename(at).startsWith(`${sessionBase}-`) ? basename(at).slice(sessionBase.length + 1) : undefined;
      row = rowOf(listed.get(at)) ?? rowOf(byName);

      if (row !== undefined) break;
    }
  }

  // A row with no name of its own is named by its id in the fleet: never the harness's agent id, and never "a worker" for a row the ledger has.
  return row === undefined ? undefined : { name: row.name.trim() === "" ? row.id : row.name, lane: row.lane };
}

/** A refused Agent call's type and description, from its input (a JSON object the CLI checked). */
function spawnOf(call: string): Spawn {
  let input: JsonObject | undefined;

  try {
    // SAFETY: JSON.parse returns JSON values only.
    input = asObject(JSON.parse(call) as Json);
  } catch {
    input = undefined;
  }

  const description = asString(input?.["description"]) ?? (asString(input?.["prompt"]) ?? "").split("\n")[0] ?? "";

  return { type: asString(input?.["subagent_type"]) ?? "general-purpose", description };
}

/** Write a permission's title, question and why from its call, and say whether they moved. Of an ask, and of a
 * row the host worded from a refusal draft (`worded`), the question alone: its title and why are the host's. */
function writePermissionWords(run: Run, ledger: Ledger, d: Decision, worded = false): string[] {
  if (d.refusal === undefined || d.refusal === null) return [];
  const words = permissionWords(d.refusal, refusedBy(run, ledger, d), ledger.role === "manager" ? "manager" : "coordinator", spawnOf(d.refusal.call));
  const written = isAsk(d.refusal) || worded ? (["question"] as const) : (["title", "question", "why"] as const);
  const moved = written.filter((k) => d[k] !== words[k]);

  for (const k of moved) d[k] = words[k];

  return moved;
}

/** Drop a permission's explanation: its call changed, so what the coordinator wrote was about another call. */
function dropExplanation(run: Run, d: Decision): void {
  d.recommend = null;
  d.reason = null;

  if (d.body === true) {
    remove(join(run.root, "decisions", `${d.id}.html`));
    d.body = false;
  }
}

/** The explanation the coordinator gives a permission: a recommendation of one of its two options, with its
 * reason; the first one also with the why and the body (what the call does, why the worker needs it, the cost
 * and risk, what a denial means). */
function checkExplanation(run: Run, d: Decision, wasExplained: boolean): Step$ {
  if (d.kind !== "permission" || !given(d.recommend ?? undefined)) return Effect.void;
  const ids = (d.options ?? []).map((o) => o.id);

  if (!ids.includes(d.recommend ?? "")) return refuse(`--recommend '${d.recommend ?? "None"}' is not one of a permission's options (${ids.join(", ")})`);

  const missing = [
    ...(given(d.reason ?? undefined) ? [] : ["--reason"]),
    ...(wasExplained || run.args.str("why") !== undefined ? [] : ["--why"]),
    ...(wasExplained || d.body === true ? [] : ["--body FILE"]),
  ];

  if (missing.length > 0) {
    return refuse(
      `a permission's explanation also gives ${missing.join(", ")}: the why in one or two plain lines, and in the body what the call does, ` +
        "why the worker needs it, its cost and risk (money, time, data, outside systems) and what a denial means",
    );
  }

  return Effect.void;
}

/**
 * The root a permission records for `root` (absolute): the session root, where a subagent's session reads its
 * permissions. A worker's workspace of this fleet's work (hub/grants.ts `placeRoot`) is recorded as its
 * session's root, said on stderr, or refused when that root cannot be told; any other folder is kept as given
 * (the hook gives `$CLAUDE_PROJECT_DIR`, and the hub checks the root again when the answer comes).
 */
function sessionRootOf(run: Run, root: string): Effect.Effect<string, Refusal> {
  const at = resolvePath(root);

  if (!isDir(at)) return Effect.succeed(root);

  const placed = placeRoot(run.root, at, () => {
    const entry = run.machine.registry.find(run.root);

    return registeredSession(entry === undefined ? undefined : pidOfEntry(entry));
  });

  if (placed.kind === "workspace") {
    run.warn(`state: --root ${root} is ${placed.name}'s workspace: recorded the session root ${placed.root}, where the subagent's session reads its permissions.`);

    return Effect.succeed(placed.root);
  }

  if (placed.kind !== "untold") return Effect.succeed(root);
  const roots = placed.roots.length === 0 ? "the session's $CLAUDE_PROJECT_DIR; no heartbeat or live registered session of this fleet names one" : placed.roots.join(" or ");

  return refuse(`a permission's root is the session root (${roots}), where the subagent's session reads its permissions, not the worker's workspace ${root}`);
}

/** Whether two refusals name the same calls for the same caller, in the same root, for the same cause. */
function sameRefusal(a: RefusedCall, b: RefusedCall): boolean {
  const same = (["tool", "call", "rule", "cause", "root", "agent_id"] as const).every((k) => a[k] === b[k]);
  const alike = (x: readonly string[], y: readonly string[]): boolean => x.length === y.length && x.every((item, k) => item === y[k]);

  // The files too: a script that changed since the user was asked is another thing to allow.
  return same && alike(a.more ?? [], b.more ?? []) && alike(a.runs ?? [], b.runs ?? []);
}

/** A permission's call from the flags given, over the one it had, with the two options that follow from it;
 * whether it changed. Without `--cause` on a new row it is an ask (`asksAhead`), which may carry further calls
 * (`--then`, once each). Any other kind takes none of these flags. A row worded from a refusal draft (`draft`)
 * carries the classifier's reason only while every command it asks for is one the classifier saw refused
 * (`partOfRefused`): beside any other command the reason would be about a call the user is not asked for,
 * so the row carries none and reads as asked before running. */
function setRefusal(run: Run, d: Decision, draft?: RefusalDraft, worded = false): Effect.Effect<boolean, Refusal> {
  return Effect.gen(function* () {
    const args = run.args;
    const before = d.refusal ?? undefined;
    const then = args.list("then") ?? [];
    // On a recorded call, `--call` alone names the revision an explanation is for (`callGuard`).
    const named: string[] = REFUSAL_FLAGS.filter((k) => args.str(k) !== undefined && !(k === "call" && before !== undefined && !harnessWrites(args)));

    if (then.length > 0) named.push("then");

    if (d.kind !== "permission") {
      if (named.length === 0) return false;

      return yield* refuse(`--${named.map((k) => k.replace("_", "-")).join(", --")} name the call of a permission (--kind permission)`);
    }

    if ((args.list("option") ?? []).length > 0) return yield* refuse("a permission's options are allow-once and deny, which the CLI sets: --option is not taken");
    const ask = asksAhead(args, before, worded) || (draft !== undefined && args.str("cause") === undefined);

    if (args.str("recommend") !== undefined && named.length > 0 && !ask) {
      return yield* refuse("the refused call's record takes no recommendation: explain the permission on its open row, without --tool, --call, --cause and --root");
    }

    if (then.length > 0 && (!ask || args.str("call") === undefined)) {
      return yield* refuse("--then gives the further calls of a permission asked before they ran: give it with --tool Bash, --call (the first call) and --root, and no --cause");
    }

    if (named.length === 0 && before !== undefined) return false;
    const tool = args.str("tool") ?? before?.tool;
    const call = args.str("call") ?? before?.call;
    // A new first call brings its own list; the same command again without --call keeps the calls it had.
    const more = args.str("call") === undefined ? (before?.more ?? []) : then;
    // A draft's cause is the classifier's reason the hook recorded, and it stays with the commands it was about.
    const ofDraft = draft === undefined || call === undefined ? undefined : args.str("call") === undefined && before !== undefined ? before.cause : partOfRefused(draft, [call, ...more]) ? draft.cause : "";
    const cause = args.str("cause") ?? ofDraft ?? before?.cause ?? (ask ? "" : undefined);
    const root = args.str("root") ?? before?.root ?? draft?.root;

    if (tool === undefined || call === undefined || cause === undefined || root === undefined) {
      return yield* refuse(
        "a permission names its call: give --tool, --call and --root, with --cause (the classifier's reason) for a call auto mode refused, " +
          "or none for a call asked before it runs (and --agent-id for a subagent's call)",
      );
    }

    const agentId = args.str("agent_id");
    const made = yield* makeRefusedCall({ tool, call, cause, root, more, ahead: ask, agentId: agentId === undefined ? (before?.agent_id ?? draft?.agent_id ?? null) : given(agentId) ? agentId : null });
    const refusal = { ...made, root: yield* sessionRootOf(run, made.root) };
    d.refusal = refusal;
    d.options = permissionOptions(refusal);

    if (draft !== undefined && args.str("cause") === undefined && isAsk(refusal) && (before === undefined || !isAsk(before))) {
      run.say(
        `${d.ref ?? d.id} asks for a command that is not one of the commands of the call auto mode refused (refusal draft ${draft.id}): ` +
          "its card says it was asked before running and shows no classifier's reason, which was about the other call.",
      );
    }

    return before === undefined || !sameRefusal(before, refusal);
  });
}

/** What an ask carries from its first command: the coordinator's recommendation, so the user never sees it as
 * "waiting for the coordinator to explain". */
function checkAsk(d: Decision, worded = false): Step$ {
  if (d.refusal === undefined || d.refusal === null || !(isAsk(d.refusal) || worded) || given(d.recommend ?? undefined)) return Effect.void;

  return refuse(
    `a permission ${worded ? "you word from a refusal draft" : "asked before its call ran"} carries your recommendation: give --recommend allow-once|deny and --reason, ` +
      "with --title (the plain question), --why and, for what the user needs to judge it (cost, risk, what a no means), --body FILE",
  );
}

/** What the fleet does once a permission's answer is recorded: the exact calls to run, or that it stays stopped. */
function afterAnswer(d: Decision, answer: string): string | undefined {
  const r = d.refusal ?? undefined;

  if (d.kind !== "permission" || r === undefined) return undefined;
  const ref = d.ref ?? d.id;

  if (!answer.trim().toLowerCase().startsWith(ALLOW_ONCE)) {
    return `${ref} was not allowed: the call stays stopped. Act on the user's note; no other route to the same act (another worker, a reworded command, an action that asks the user to run it).`;
  }

  const who = given(d.agent ?? undefined) ? ` Resume ${d.agent ?? ""} (SendMessage) with exactly this.` : "";

  if (r.tool === "Agent") return `${ref} is allowed once: start exactly this agent again, with the same input, no field added or changed.${who}`;
  const calls = callsOf(r);

  const what =
    calls.length === 1
      ? `run exactly this call now, byte for byte, as a Bash call of its own:\n  ${r.call}`
      : `run exactly these ${String(calls.length)} calls now, in this order, each byte for byte as a Bash call of its own:\n${calls.map((call, k) => `  ${String(k + 1)}. ${call}`).join("\n")}`;

  return (
    `${ref} is allowed once: ${what}\n` +
    `Each grant is an exact rule in ${grantFileOf(r.tool, r.root)}: it goes when its call ran, pass or fail, or 30 minutes after the answer, and the next run asks again. ` +
    "A call that differs by one character has no grant, and the plugin's hook refuses a longer command that holds a granted call, a second run, a call out of its turn, " +
    `and a call whose script changed since the user allowed it.${calls.length === 1 ? "" : " The list is a sequence: a call that fails takes the rest of the list with it, and you ask again for what is left."}${who}`
  );
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
  const text = content.toString("utf8");
  const warning = markdownWarning(source, text);

  if (warning !== undefined) run.warn(warning);
  makeDirs(join(run.root, "decisions"));
  writeBytes(target, isMarkdownFile(source) ? Buffer.from(markdownToHtml(text), "utf8") : content);
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

/** Revoke every active approval of this ledger that came from decision `d` (from its question `question`, or
 * from any of it), saying `why`: the user's answer it rests on moved, so what it covered asks them again. One
 * line per approval revoked. Another fleet's copy (`fleets approval add`) is refused at use instead. */
function revokeFrom(run: Run, ledger: Ledger, d: Decision, question: string | undefined, why: string): void {
  const names = namesOf(run.machine, run.root);

  for (const a of ledger.approvals ?? []) {
    if (a.status !== "active" || !comesFrom(a, d, names, question)) continue;
    a.status = "revoked";
    a.revoked = stamp(run);
    a.revoked_why = why;
    log(run, ledger, { kind: "decision", text: `Standing approval ${a.id} revoked: ${why}`, decision: a.ref.includes("/") ? undefined : a.ref });
    run.say(`revoked approval ${a.id} (from ${refOf(a)}): ${why}; what it covered asks the user again.`);
  }
}

const FIELDS = ["kind", "title", "question", "why", "recommend", "reason", "secret", "manual", "agent", "step", "milestone", "advised"] as const;

/** The words a permission's record of its call writes: the CLI's, from the call, never the hook's. */
const WORDS: ReadonlySet<string> = new Set(["title", "question", "why"]);

const ASK_QUESTION =
  "a permission's question is written from its call, so it never says less than the call does: --question cannot be set; " +
  "the plain question goes in --title, and what the user needs to judge it in --why and --body";

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

/** --advised is the advisor's view in one line, or none:<why no advisor was asked>. */
function checkAdvised(advised: string | undefined): Step$ {
  if (advised === undefined) return Effect.void;
  const view = advised.trim();

  return view === "" || (view.toLowerCase().startsWith("none:") && view.slice(5).trim() === "")
    ? refuse("--advised is the advisor's view in one line, or none:<why no advisor was asked>")
    : Effect.void;
}

/** The warning for a choice put to the user with no advisor's view: the fleet has an advisor that was not asked,
 * or has asked the user ADVISOR_AFTER choices today and runs none. */
function unadvised(run: Run, ledger: Ledger, d: Decision): string | undefined {
  if ((d.kind !== "decision" && d.kind !== "input") || (d.asks ?? "user") !== "user" || d.status !== "open" || given(d.advised ?? undefined)) return undefined;

  if (ledger.agents.some((a) => a.id === "advisor" && isLive(a.status))) {
    return (
      `state: ${d.id} asks the user with no --advised: ask the fleet's advisor first (SendMessage), then give ` +
      `its view in one line (--advised "..."), or --advised none:<why not>; the page shows it under the recommendation.`
    );
  }

  const today = stamp(run).slice(0, 10);
  const rows = ledger.decisions ?? [];

  const asked = [...rows, ...(rows.includes(d) ? [] : [d])].filter(
    (x) => CHOICE_KINDS.some((k) => k === x.kind) && (x.asks ?? "user") === "user" && x.page !== false && x.opened.slice(0, 10) === today,
  );

  if (asked.length < ADVISOR_AFTER) return undefined;

  return (
    `state: ${d.id} is choice ${asked.length} this fleet asks the user today, and no advisor runs: start one ` +
    `(\`${FLEET_BIN} advisor ${run.root}\`) and ask it first, then give its view (--advised "..."), or --advised none:<why not>.`
  );
}

/** The name this fleet posts news under: the registry's, else its project's, in a name's letters. */
function newsSender(run: Run, ledger: Ledger): string {
  const registered = fleetOf(run.machine, run.root);

  if (registered !== undefined) return registered;
  const slug = ledger.project.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");

  return slug === "" ? "fleet" : slug;
}

/** The manager's news of an act done under a standing approval, posted once the ledger holds it; none when no
 * manager is served (the fleet's own page shows the notice). */
function postNotice(run: Run, ledger: Ledger, d: Decision, a: Approval): string | undefined {
  const manager = managerOf(run.machine);
  const sender = newsSender(run, ledger);

  if (manager === undefined || manager === sender) return "no manager is served: no news item (the fleet's page lists the notice).";
  const full = `${sender} did under standing approval ${a.id} (${a.rule}): ${d.title ?? "None"}. ${d.question ?? "None"} Undo: ${d.undo ?? ""}`;
  const text = [...full].length <= TEXT_MAX ? full : `${[...full].slice(0, TEXT_MAX - 1).join("")}…`;
  const item = postNews(run.machine, { from: sender, to: manager, kind: "fyi", keep: false, text });

  return item instanceof Refusal ? undefined : `news #${item.id} tells the manager (fyi).`;
}

/** `decision ID --kind notice --under A`: an act done under a standing approval, recorded closed at once. */
function notice(ledger: Ledger, run: Run, known: Decision | undefined): Effect.Effect<Ledger, Refusal> {
  return Effect.gen(function* () {
    const args = run.args;
    const id = args.str("id") ?? "";

    if (known !== undefined) {
      return yield* refuse(
        `${known.id} is already a ${known.kind}: a notice is recorded once, under a new id ` +
          '(`decision ID --kind notice --under APPROVAL --title T --question "what was done" --undo "how to undo it"`)',
      );
    }

    if (args.str("kind") !== "notice") return yield* refuse("--under and --undo record a notice: give --kind notice");

    if (!ID.test(id)) return yield* refuse(`decision id ${pyStr(id)} should be letters, digits, '_', '.', or '-'`);

    const extra = (["option", "recommend", "reason", "secret", "manual", "supersedes", "decide", "withdraw", "hold", "advised"] as const).flatMap((k) =>
      (k === "option" ? (args.list("option") ?? []).length > 0 : given(args.str(k))) ? [`--${k}`] : [],
    );

    if (args.str("asks") === "manager") extra.push("--asks manager");

    if (args.flag("blocking")) extra.push("--blocking");

    if (extra.length > 0) return yield* refuse(`a notice reports what was done under a standing approval and asks nothing: leave out ${extra.join(", ")}`);
    yield* require(run, ["title", "question", "under", "undo"], "notice");
    const under = args.str("under") ?? "";
    const a = find(ledger.approvals, under);

    if (a === undefined) {
      return yield* refuse(`unknown approval '${under}': \`approval list\` shows the standing approvals; an act no approval covers is asked (a decision)`);
    }

    if (a.status !== "active") {
      return yield* refuse(`approval ${a.id} was revoked ${a.revoked ?? "None"}: ${a.revoked_why ?? "None"}. What it covered asks the user again: open a decision`);
    }

    const still = approvalSource(run.machine, run.root, ledger, refOf(a), true);

    if (still instanceof NoSource) {
      return yield* refuse(
        `approval ${a.id} no longer stands: ${still.why}. What it covered asks the user again: ` +
          `revoke it (approval revoke ${a.id} --reason "...") and open a decision`,
      );
    }

    const undo = args.str("undo") ?? "";

    if (undo.trim() === "") return yield* refuse("--undo says how to undo what was done; an act that cannot be undone is not routine: ask the user (a decision)");
    yield* checkQuestion(args.str("question"), "notice");
    yield* checkWhy(args.str("why"), "notice");
    yield* checkNumberId(run, ledger, id, "notice");
    const at = stamp(run);
    const agent = args.str("agent");

    const d: Decision = {
      id,
      kind: "notice",
      title: args.str("title") ?? "",
      question: args.str("question") ?? "",
      why: args.str("why") ?? null,
      blocking: false,
      agent: given(agent) ? agent : null,
      options: [],
      recommend: null,
      reason: null,
      secret: null,
      manual: null,
      body: false,
      page: true,
      supersedes: null,
      status: "decided",
      answer: "done",
      resolution: `under ${a.id}`,
      change: null,
      asks: "user",
      opened: at,
      revised: null,
      closed: at,
      step: null,
      milestone: null,
      under: a.id,
      undo,
    };

    yield* placeOf(ledger, d, run);
    yield* setBody(run, d);
    (ledger.decisions ??= []).push(d);
    log(run, ledger, { kind: "decision", text: `Done under ${a.id} (${a.rule}): ${d.title ?? "None"}: ${d.question ?? "None"}`, agent: d.agent ?? null, decision: d.id });
    run.say(`recorded ${d.id}, done under ${a.id} and closed: the page lists it under Done under your approvals, with its undo.`);
    run.after(() => postNotice(run, ledger, d, a));

    return ledger;
  });
}

/** What a tool's name may hold, as the harness gives it (`Bash`, `Write`, `mcp__server__tool`). */
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,120}$/u;

/**
 * `decision ID --kind refusal --tool T --call C --cause WHY --root ROOT [--agent-id AID] [--agent W]`: the
 * plugin's hook's record of a call auto mode refused. It opens no decision: the call becomes a draft in
 * `refusals`, for the fleet's host, who is told at once in one fixed line and asks the user in its own words
 * under the same id, or drops it. The same refusal again, while its draft or the decision that asked it is
 * open, records nothing and tells no one twice.
 */
function draftRefusal(ledger: Ledger, run: Run, known: Decision | undefined, old?: Recorded): Effect.Effect<Ledger, Refusal> {
  return Effect.gen(function* () {
    const args = run.args;
    const id = old?.id ?? args.str("id") ?? "";

    if (known !== undefined) {
      if (known.status !== "open") return yield* refuse(`${closedBecause(known)}. A refusal of the same call again is recorded under a new id`);
      run.say(`${known.ref ?? known.id} is open and already asks about this call: nothing was recorded.`);

      return ledger;
    }

    const before = (ledger.refusals ?? []).find((r) => r.id === id);

    if (before?.status === "open") {
      run.say(`refusal draft ${id} is open already: nothing was recorded, and its host ${before.told === false ? "will see it at its next state command or watch" : "was told when it opened"}.`);

      return ledger;
    }

    if (before !== undefined) return yield* refuse(`refusal draft ${id} is already ${before.status}: ${before.resolution ?? "no reason recorded"}. A refusal of the same call again is recorded under a new id`);

    if (!ID.test(id)) return yield* refuse(`decision id ${pyStr(id)} should be letters, digits, '_', '.', or '-'`);

    if (old === undefined) yield* require(run, ["tool", "call", "cause", "root"], "refusal draft");
    const tool = old?.tool ?? args.str("tool") ?? "";
    const call = old?.call ?? args.str("call") ?? "";
    const root = old?.root ?? args.str("root") ?? "";

    if (!TOOL_NAME.test(tool)) return yield* refuse(`--tool is the tool's name as the harness gives it (letters, digits, '_', '.', ':' or '-'), got ${pyStr(tool)}`);

    if (call.trim() === "") return yield* refuse("--call is the refused call: a Bash command as the harness saw it, or the tool's input as JSON");

    if (!isAbsolute(root)) return yield* refuse(`--root is the session's project directory, an absolute path, got ${root}`);
    const agentId = old === undefined ? args.str("agent_id") : old.agentId;
    const named = old === undefined ? args.str("agent") : old.agent;
    const row = (given(named) ? ledger.agents.find((a) => a.id === named) : undefined) ?? (given(agentId) ? ledger.agents.find((a) => a.task_id === agentId) : undefined);

    const draft: RefusalDraft = {
      id,
      tool,
      call,
      cause: old?.cause ?? args.str("cause") ?? "",
      root,
      agent_id: given(agentId) ? (agentId ?? null) : null,
      agent: row?.id ?? null,
      opened: stamp(run),
      status: "open",
    };

    (ledger.refusals ??= []).push(draft);
    const who = callerOf(ledger, draft);
    const host = ledger.role === "manager" ? "manager" : "coordinator";
    log(run, ledger, { kind: "note", text: `Auto mode refused a ${tool} call of ${who} (${shown(draft.cause, 120)}): refusal draft ${id}, for the ${host} to word or drop. Nothing was asked of the user.`, agent: draft.agent ?? null });
    run.say(`drafted ${id}: ${who}'s ${tool} call, for the ${host}. Nothing was asked of the user.`);
    // A line that reaches neither the host's chat nor its session leaves the draft untold: its next watch or
    // state command says the line, once.
    run.tell(draftLine(FLEET_BIN, run.root, ledger, draft), () => {
      draft.told = false;
    });

    return ledger;
  });
}

/** What a record of a refused call gives, read from the words of a hook that wrote them as a card's. */
interface Recorded {
  readonly id: string;
  readonly tool: string;
  readonly call: string;
  readonly cause: string;
  readonly root: string;
  readonly agentId: string | undefined;
  readonly agent: string | undefined;
}

/** The id the plugin's hook gives a refused call (`_permission_id`): `p-<8 hex of sha1(caller, call)>`, then
 * `-2`, `-3` and on. */
const HOOK_ID = /^(p-[0-9a-f]{8})(?:-([1-9][0-9]*))?$/u;

/** The words the hook wrote for a refused call before refusal drafts (tstack 1.9.44 and before), each a fixed
 * form: the title `<who>: <tool> refused, <call>`, the why, and the manual of a Bash call no rule could hold
 * or of another tool's call, its text in a fence. */
const OLD_TITLE = /^(.{1,200}?): ([A-Za-z0-9_.:-]{1,120}) refused, /su;

const OLD_WHY = /^Auto mode's classifier refused it \((.*)\), and only you can let it through\.$/su;

const OLD_BASH = /^Run it yourself in bash, in the project \((\/[^\n]*)\):\n\n(`{3,})bash\n(.*)\n\2$/su;

const OLD_OTHER = /^The ([A-Za-z0-9_.:-]{1,120}) call as the harness saw it, for you to make yourself:\n\n(`{3,})json\n(.*)\n\2$/su;

const OLD_MANUAL = /^(?:Run it yourself in bash, in the project \(|The [A-Za-z0-9_.:-]{1,120} call as the harness saw it, for you to make yourself:)/u;

/** JSON on one line, as the hook records another tool's input now; text that is no JSON as it is. */
function compactJson(text: string): string {
  return Option.match(parseJson(text), { onNone: () => text, onSome: (value) => JSON.stringify(value) });
}

/**
 * The refused call in a command of the hook's from before refusal drafts, which a session keeps sending until
 * it restarts: undefined for any other command. Matched, all of: a new id of the hook's own form
 * ({@link HOOK_ID}); a call of any tool but Agent (a refused spawn opens its permission as before); and one of
 *  - `--kind action` with the hook's fixed title, why and manual ({@link OLD_TITLE}, {@link OLD_WHY}, and
 *    {@link OLD_BASH} or {@link OLD_OTHER}): the call is the manual's fenced text, the root the one the manual
 *    names (for another tool's call, the hook's own `CLAUDE_PROJECT_DIR`, without which it is not matched);
 *  - `--kind permission` with `--tool`, `--call`, `--cause` and `--root`, whose `--title` and `--why` are
 *    absent or in the hook's fixed forms, and no `--recommend`, `--reason` or `--body`: a card the host words
 *    names no cause, and a title or a why of its own is no form of the hook's.
 * A host's own action has a manual and a title of its own words, so it is never one of these.
 */
function oldHookRecord(run: Run): Recorded | undefined {
  const args = run.args;
  const id = args.str("id") ?? "";
  const kind = args.str("kind");

  if (!HOOK_ID.test(id) || (kind !== "permission" && kind !== "action")) return undefined;
  const title = OLD_TITLE.exec(args.str("title") ?? "");
  const why = OLD_WHY.exec(args.str("why") ?? "");
  const agent = args.str("agent");

  if (kind === "permission") {
    const [tool, call, cause, root] = [args.str("tool"), args.str("call"), args.str("cause"), args.str("root")];
    const hosts = (args.str("title") !== undefined && title?.[2] !== tool) || (args.str("why") !== undefined && why === null) || ["recommend", "reason", "body"].some((k) => args.str(k) !== undefined);

    return tool === undefined || tool === "Agent" || call === undefined || cause === undefined || root === undefined || hosts ? undefined : { id, tool, call, cause, root, agentId: args.str("agent_id"), agent };
  }

  if (title === null || why === null) return undefined;
  const manual = args.str("manual") ?? "";
  const agentId = /^subagent ([A-Za-z0-9_.:-]{1,120})$/u.exec(title[1] ?? "")?.[1];
  const bash = OLD_BASH.exec(manual);

  if (bash !== null) return title[2] === "Bash" ? { id, tool: "Bash", call: bash[3] ?? "", cause: why[1] ?? "", root: bash[1] ?? "", agentId, agent } : undefined;
  const other = OLD_OTHER.exec(manual);
  const project = run.machine.env("CLAUDE_PROJECT_DIR");

  if (other === null || other[1] !== title[2] || project === undefined || !isAbsolute(project)) return undefined;

  return { id, tool: other[1] ?? "", call: compactJson(other[3] ?? ""), cause: why[1] ?? "", root: project, agentId, agent };
}

/** Whether a `decision` command is the plugin's hook's record of a refused call, in any form it has had: the
 * host's own commands never name a cause, and its manuals never open as the hook's did. */
export function hooksRecord(args: Args): boolean {
  return args.str("kind") === DRAFT_KIND || args.str("cause") !== undefined || OLD_MANUAL.test(args.str("manual") ?? "");
}

/** The id a record takes when the one the hook gave is a draft already closed: the hook's own rule
 * (`_permission_id`), the first of ID, ID-2, ID-3 and on whose decision, else whose draft, is absent or open. A
 * hook from before drafts reads the decisions alone, so it gives a dropped draft's id again. */
function freeHookId(ledger: Ledger, id: string): string {
  const found = HOOK_ID.exec(id);
  const base = found?.[1] ?? id;

  for (let n = Number(found?.[2] ?? "1"); ; n += 1) {
    const candidate = n === 1 ? base : `${base}-${String(n)}`;
    const status = findDecision(ledger, candidate)?.status ?? (ledger.refusals ?? []).find((r) => r.id === candidate)?.status ?? "open";

    if (status === "open") return candidate;
  }
}

/** `decision ID --withdraw WHY` on a refusal draft: the host drops it, with why (not needed, done another way). */
function dropDraft(ledger: Ledger, run: Run, draft: RefusalDraft, why: string): Effect.Effect<Ledger, Refusal> {
  if (why.trim() === "") return refuse(`--withdraw says why refusal draft ${draft.id} is dropped (not needed, done another way)`);
  draft.status = "dropped";
  draft.closed = stamp(run);
  draft.resolution = why;
  log(run, ledger, { kind: "resolved", text: `Refusal draft ${draft.id} (${callerOf(ledger, draft)}'s ${draft.tool} call) dropped: ${why}`, agent: draft.agent ?? null });
  run.say(`dropped refusal draft ${draft.id}: nothing was asked of the user.`);

  return Effect.succeed(ledger);
}

/** A new decision's id that reads as an item number (D217) is taken only when it is the number this card is
 * given: a page links a decision by its id, and D217 there names another fleet's card. Read early, so nothing
 * of the command is done; `numberOnMachine` checks again where the number is taken. */
function checkNumberId(run: Run, ledger: Ledger, id: string, kind: string): Effect.Effect<void, Refusal> {
  return Effect.gen(function* () {
    if (!readsAsNumber(id)) return;
    const ref = nextDecisionRef(run.machine, ledger, PREFIX.get(kind) ?? "D");

    if (ref instanceof Unreachable) return yield* refuse(refusedFor(ref));

    if (ref !== id) return yield* refuse(misnumbered(id, ref));
  });
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

    if (args.str("kind") === DRAFT_KIND) return yield* draftRefusal(ledger, run, d);
    // A session still running the hook from before refusal drafts sends its card: the same record, so a draft.
    const old = d === undefined ? oldHookRecord(run) : undefined;

    if (old !== undefined) {
      const free = freeHookId(ledger, old.id);

      return yield* draftRefusal(ledger, run, findDecision(ledger, free), { ...old, id: free });
    }

    const agent = args.str("agent");

    if (given(agent) && !known(ledger, agent)) return yield* refuse(`unknown agent '${agent}'`);
    const options = args.list("option");
    const body = args.str("body");
    // A refusal draft of this id: the host words it under the same id (below), or drops it.
    const drafted = d === undefined ? openDraft(ledger, id) : undefined;

    if (drafted !== undefined && withdraw !== undefined) return yield* dropDraft(ledger, run, drafted, withdraw);
    // A dropped draft stays dropped: a decision under its id would read as its answer, and the hook's next
    // refusal of the same call takes the next id.
    const dropped = d === undefined ? (ledger.refusals ?? []).find((r) => r.id === id && r.status === "dropped") : undefined;

    if (dropped !== undefined) return yield* refuse(`refusal draft ${id} was dropped (${dropped.resolution ?? "no reason recorded"}): it stays closed. Ask with a new id`);

    if (drafted !== undefined && (decide !== undefined || hold !== undefined || unhold)) {
      const { ask, drop } = draftCommands(FLEET_BIN, run.root, drafted);

      return yield* refuse(`${id} is a refusal draft: nothing was asked of the user yet, so there is no answer to record or hold. Ask it in your words (${ask}), or drop it (${drop})`);
    }

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

    if (args.str("kind") === "notice" || args.str("under") !== undefined || args.str("undo") !== undefined) return yield* notice(ledger, run, d);
    yield* checkAdvised(args.str("advised"));

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
      const kind = args.str("kind");

      if (drafted !== undefined && kind === "permission" && args.str("cause") !== undefined) {
        return yield* refuse(`${id} is a refusal draft, and its cause is the classifier's reason the hook recorded: leave out --cause, and give the call, the title, the why and your recommendation`);
      }

      // Worded from a draft, a permission is the host's as an ask is: its title, why and recommendation in this command.
      const worded = drafted !== undefined && kind === "permission";
      const ask = kind === "permission" && (worded || asksAhead(args, undefined));

      if (ask && args.str("question") !== undefined) return yield* refuse(ASK_QUESTION);
      // A permission's title, question and why are written from its call (below); an ask's title and why are the coordinator's.
      yield* require(run, elsewhere ? ["title", "question"] : ask ? ["kind", "title", "why"] : kind === "permission" ? ["kind"] : ["kind", "title", "question", "why"], "decision");
      yield* checkQuestion(args.str("question"), given(kind) ? kind : "decision");
      yield* checkWhy(args.str("why"), ask ? "decision" : given(kind) ? kind : "decision");
      yield* checkNumberId(run, ledger, id, given(kind) ? kind : "decision");

      const fresh: Decision = {
        id,
        kind: given(kind) ? kind : "decision",
        title: args.str("title") ?? "",
        question: args.str("question") ?? "",
        why: args.str("why") ?? null,
        blocking: args.flag("blocking"),
        agent: given(agent) ? agent : (drafted?.agent ?? null),
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

      const advised = args.str("advised");

      if (advised !== undefined) fresh.advised = advised;

      yield* placeOf(ledger, fresh, run);

      yield* setRefusal(run, fresh, worded ? drafted : undefined);
      const harness = fresh.kind === "permission" && (worded || harnessWrites(args));

      if (harness) writePermissionWords(run, ledger, fresh, worded);

      if (!elsewhere) {
        yield* checkKind(fresh, true);
        yield* setBody(run, fresh);

        if (ask) {
          yield* checkAsk(fresh, worded);
          yield* checkExplanation(run, fresh, true);
        }

        if (!harness || ask) for (const warning of readabilityWarnings(fresh, writtenFields(args), run.root, workersOf(ledger))) run.warn(warning);
        const advice = unadvised(run, ledger, fresh);

        if (advice !== undefined) run.warn(advice);
        const forManager = fresh.asks === "manager";
        // The classifier's reason was about another call than the one asked for: the record keeps it, the card does not.
        const elseRefused = worded && drafted !== undefined && fresh.refusal !== undefined && fresh.refusal !== null && isAsk(fresh.refusal);
        log(run, ledger, {
          kind: "asked",
          text:
            `${forManager ? "For the manager: " : ""}${fresh.title ?? "None"}: ${fresh.question ?? "None"}` +
            (elseRefused ? ` (worded from refusal draft ${drafted.id}; it asks for a command the refused call did not hold, and of that call auto mode said: ${shown(drafted.cause, 240)})` : ""),
          agent: fresh.agent ?? null,
          important: (fresh.blocking ?? false) && !forManager,
          decision: fresh.id,
        });
      }

      rows.push(fresh);

      if (drafted !== undefined) {
        drafted.status = "asked";
        drafted.closed = stamp(run);
        drafted.resolution = `asked as ${fresh.kind === "permission" ? "a permission" : `a${/^[aeiou]/u.test(fresh.kind) ? "n" : ""} ${fresh.kind}`} of the same id`;
      }

      if (!elsewhere) {
        run.say(
          `asked ${fresh.id}. Arm its answer's wake now, as a background command (run_in_background): ` +
            `${waitHint(run, fresh.id)}: it exits with the user's answer the moment it is given.` +
            (explained(fresh) ? "" : ` Then explain it, this turn: ${explainCommand(FLEET_BIN, run.root, fresh.ref ?? fresh.id, refusalRev(fresh.refusal))}.`) +
            (ask ? " Run nothing of it until the user allows it; recording that answer (--decide) prints the exact call to run." : ""),
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

      // The hook's record of the same refusal again leaves the coordinator's words as they are; its own words
      // (title, question, why) are the CLI's to write from the call.
      const harness = kindNow === "permission" && harnessWrites(args);
      // A permission the host worded from a refusal draft keeps the classifier's cause, and its words stay the host's.
      const from = d.kind === "permission" && d.refusal !== undefined && d.refusal !== null ? askedDraft(ledger, d.id) : undefined;
      const worded = from !== undefined;
      const ask = harness && asksAhead(args, d.refusal ?? undefined, worded);
      const askedRow = d.kind === "permission" && d.refusal !== undefined && d.refusal !== null && (isAsk(d.refusal) || worded);
      const checkedAs = kindNow === "permission" && (!harness || ask) ? "decision" : kindNow;
      const wasExplained = explained(d);

      if (ask || (askedRow && !harness)) {
        if (args.str("question") !== undefined) return yield* refuse(ASK_QUESTION);
      } else if (d.kind === "permission" && !harness) {
        const set = (["title", "question"] as const).filter((k) => args.str(k) !== undefined);

        if (set.length > 0) {
          return yield* refuse(
            `a permission's title and question are written from its call, so they never say less than it does: --${set.join(" and --")} cannot be set; explain it with --why and --body`,
          );
        }
      }

      // The words this command does not write: the hook's own, and of an ask the question alone.
      const unwritten: ReadonlySet<string> = !harness ? new Set() : ask ? new Set(["question"]) : WORDS;

      yield* callGuard(run, d);
      yield* checkQuestion(question, checkedAs);
      yield* checkWhy(args.str("why"), checkedAs);

      const current = d;
      const changed: string[] = FIELDS.filter((k) => args.str(k) !== undefined && !unwritten.has(k) && !(harness && args.str(k) === (current[k] ?? "")));
      const before = snapshot(d);

      if (options !== undefined && options.length > 0) changed.push("option");

      if (given(body)) changed.push("body");
      const row = d;
      const kindBefore = d.kind;

      for (const key of FIELDS) {
        if (key === "step" || key === "milestone" || unwritten.has(key)) continue;
        const value = args.str(key);

        if (value === undefined) continue;

        // An emptied field is stored as null, as Python's `or None` stores it (open-7); kind takes no
        // empty value (its choices refuse it).
        if (key === "kind") row[key] = value;
        else row[key] = value === "" ? null : value;
      }

      if (args.str("step") !== undefined || args.str("milestone") !== undefined) yield* placeOf(ledger, row, run);

      if (options !== undefined && options.length > 0) row.options = yield* parseOptions(options);

      if ((args.flag("blocking") || args.flag("not_blocking")) && !(harness && row.blocking === args.flag("blocking"))) {
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

      if (yield* setRefusal(run, row, from, worded)) {
        changed.push("refusal");

        // The hook's new call drops what the coordinator wrote about the old one; an ask's own command carries its words.
        if (harness && !ask && explained(row)) {
          dropExplanation(run, row);
          changed.push("recommend");
        }
      }

      if (harness && (ask || !explained(row))) changed.push(...writePermissionWords(run, ledger, row, ask && worded));
      yield* checkKind(row, args.str("manual") !== undefined || row.kind !== kindBefore);
      yield* setBody(run, row);

      if (ask) yield* checkAsk(row, worded);
      yield* checkExplanation(run, row, wasExplained || ask);

      if (!harness || ask) for (const warning of readabilityWarnings(row, writtenFields(args), run.root, workersOf(ledger))) run.warn(warning);
      const advice = passedOn ? unadvised(run, ledger, row) : undefined;

      if (advice !== undefined) run.warn(advice);

      if (["question", "option", "manual"].some((k) => changed.includes(k)) && !given(args.str("log")) && decide === undefined && withdraw === undefined) {
        run.warn(`state: ${row.id} was asked again with new words and no --log: say what changed in one line (--log "..."); the page's history shows it, and the user should not have to compare two versions.`);
      }

      if (changed.length > 0) {
        const logText = args.str("log");
        row.revised = stamp(run);
        row.change = given(logText) ? logText : null;
        log(run, ledger, {
          kind: "asked",
          text: passedOn ? `${row.title ?? "None"} now asks you: ${row.question ?? "None"}` : `${row.title ?? "None"} changed: ${given(logText) ? logText : movedFields(changed, before, row) || "nothing new (the same values given again)"}`,
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

    const said = decide === undefined ? [] : readChat(run.root);
    const failed = decide === undefined ? undefined : failedAnswer(d, said);

    if (failed !== undefined) {
      return yield* refuse(
        `${d.title ?? "None"} failed for the user (#${failed.id}: ${failureWords(failed)}) and is not done: ` +
          'revise it with a fix and re-present it (--manual, --question), or --withdraw "why"',
      );
    }

    if (decide !== undefined && d.kind === "permission" && decide.trim().toLowerCase().startsWith(ALLOW_ONCE) && !allowedByUser(d, said)) {
      return yield* refuse(
        `${d.ref ?? d.id} has no allow-once answer from the user since it last changed: only their answer on the fleet page grants the call, ` +
          `and --decide records an answer, it gives none. Wait for it (\`fleet chat ${run.root} wait ${d.id}\`) and run nothing of it until then; ` +
          'or --withdraw "why" when the call is no longer needed',
      );
    }

    if (decide !== undefined) {
      close(run, ledger, d, { status: "decided", answer: decide, resolution: resolution ?? "" });
      const next = afterAnswer(d, decide);

      if (next !== undefined) run.say(next);
    } else if (withdraw !== undefined) {
      close(run, ledger, d, { status: "withdrawn", answer: null, resolution: withdraw });
      revokeFrom(run, ledger, d, undefined, `${d.ref ?? d.id} was withdrawn (${withdraw})`);
    }

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

/** A grilling question's reason over this, in characters, is warned about: one plain sentence. */
const GRILL_REASON_MAX = 200;

/** A grilling question with more options than this is warned about. */
const GRILL_OPTIONS_MAX = 4;

/** What reads as a source, not a reason: a path with a line (store.ts:5-9), an ADR, a decision's number (D27). */
const SOURCE_RE = /(?<![A-Za-z0-9_])(?:[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?|ADR[- ]?\d+|D\d+)(?![A-Za-z0-9_])/gu;

/** `text` up to the first sentence end (., ! or ? and a space). */
function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s/u)[0] ?? "";
}

/** "Q1 a: label | consequence" as ["q1", the option]. */
function optionOf(text: string): Effect.Effect<readonly [string, Choice], Refusal> {
  const colon = text.indexOf(":");
  const head = /^\s*([Qq]\d+)\s+(\S+)\s*$/u.exec(colon >= 0 ? text.slice(0, colon) : "");
  const rest = colon >= 0 ? text.slice(colon + 1) : "";
  const bar = rest.indexOf("|");
  const label = (bar >= 0 ? rest.slice(0, bar) : rest).trim();
  const consequence = bar >= 0 ? rest.slice(bar + 1).trim() : "";
  const key = head?.[2] ?? "";

  if (head === null || bar < 0 || label === "" || consequence === "" || !ID.test(key)) {
    return refuse(`--option reads "Q1 a: label | consequence", got ${pyStr(text)}`);
  }

  return Effect.succeed([(head[1] ?? "").toLowerCase(), { id: key, label, consequence }] as const);
}

/** What the CLI says, without refusing, about a grilling question hard to read: its reason (when this command
 * wrote it) long or opening with a source, its options (when written) long or too many. */
function grillWarnings(d: Decision, q: Question, asked: boolean, reason: boolean, options: boolean, workers: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const qid = q.id.toUpperCase();
  const why = q.reason ?? "";
  const named = workerIds([...(asked ? [q.title, q.body ?? ""] : []), ...(reason ? [why] : [])], workers);

  if (named.length > 0) out.push(workerWarning(`${d.id}'s ${qid}`, named));

  if (reason && chars(why) > GRILL_REASON_MAX) {
    out.push(
      `state: ${d.id}'s ${qid} reason is ${String(chars(why))} characters: say the trade-off in one plain sentence ` +
        `(over ${String(GRILL_REASON_MAX)} is hard to read on a phone); the evidence goes in --body.`,
    );
  }

  const found = reason ? [...new Set([...firstSentence(why).matchAll(SOURCE_RE)].map((m) => m[0]))] : [];

  if (found.length > 0) {
    out.push(
      `state: ${d.id}'s ${qid} reason opens with sources (${found.join(", ")}): say the trade-off in plain ` +
        "words first; files, lines, ADRs and decision numbers go after it, or in --body.",
    );
  }

  const opts = options ? (q.options ?? []) : [];
  const long = opts.filter((o) => chars(o.consequence) > CONSEQUENCE_MAX);

  if (long.length > 0) {
    const said = long.map((o) => `${o.id} (${String(chars(o.consequence))})`).join(", ");
    out.push(`state: ${d.id}'s ${qid} consequences over ${String(CONSEQUENCE_MAX)} characters: ${said}. Say each in one line; the detail goes in --body.`);
  }

  if (opts.length > GRILL_OPTIONS_MAX) {
    out.push(
      `state: ${d.id}'s ${qid} has ${String(opts.length)} options: give 2 to ${String(GRILL_OPTIONS_MAX)}; a choice the user ` +
        "makes on its own is a question of its own.",
    );
  }

  return out;
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
    yield* checkWhy(args.str("why"), "grill");
    const asks = args.list("ask") ?? [];
    /* What of the grilling itself this command moved: its title, its why. */
    const renamed: string[] = [];

    if (d !== undefined) {
      const title = args.str("title");

      if (title !== undefined && title.trim() === "") return yield* refuse("--title is empty: a grilling keeps a title");

      for (const key of ["title", "why"] as const) {
        const value = args.str(key);

        if (value !== undefined && value !== (d[key] ?? null)) {
          d[key] = value === "" ? null : value;
          renamed.push(key);
        }
      }
    }

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
      revokeFrom(run, ledger, row, qid, `${row.ref ?? row.id}:${qid.toUpperCase()} was answered again (${answer})`);
    }

    for (const text of args.list("drop") ?? []) {
      const [qid, reason] = yield* questionOf(text, "--drop");
      const q = yield* lookup(qid);
      Object.assign(q, { status: "dropped", answer: null, dropped: reason, answered: stamp(run) });
      revokeFrom(run, ledger, row, qid, `${row.ref ?? row.id}:${qid.toUpperCase()} was dropped (${reason})`);
    }

    const revisions = args.list("revise") ?? [];
    /* The chat's last message id now: the user's words answer a question asked or revised here only after it. */
    const chatAt = asks.length + revisions.length === 0 ? 0 : readChat(run.root).reduce((last, m) => Math.max(last, m.id), 0);
    /* A question asked or revised over QUESTION_NEAR, as [Q id, characters]: warned once the round is taken. */
    const longAsks: [string, number][] = [];

    const revisedIds: string[] = [];

    for (const text of revisions) {
      const [qid, rest] = yield* questionOf(text, "--revise");
      revisedIds.push(qid);
      const q = yield* lookup(qid);
      const [title, body, recommend, why] = yield* asked(rest);

      if (chars(body) > QUESTION_NEAR) longAsks.push([qid, chars(body)]);
      Object.assign(q, { title, body, recommend, reason: why, status: "open", answer: null, asked: stamp(run), asked_after: chatAt });
      revokeFrom(run, ledger, row, qid, `${row.ref ?? row.id}:${qid.toUpperCase()} was revised`);
    }

    const reasons = args.list("reason") ?? [];

    const reasonedIds: string[] = [];

    for (const text of reasons) {
      const [qid, why] = yield* questionOf(text, "--reason");
      reasonedIds.push(qid);
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
        asked_after: chatAt,
      };

      qs.push(q);
      added.push(q);

      if (chars(body) > QUESTION_NEAR) longAsks.push([q.id, chars(body)]);
    }

    for (const q of added) byId.set(q.id, q);
    const givenOptions = new Map<string, Choice[]>();

    for (const text of args.list("option") ?? []) {
      const [qid, option] = yield* optionOf(text);
      const q = byId.get(qid);

      if (q === undefined) return yield* refuse(`--option ${qid.toUpperCase()}: no question ${qid.toUpperCase()} in ${row.id}`);

      if (q.status !== "open") return yield* refuse(`--option ${qid.toUpperCase()}: ${qid.toUpperCase()} is ${q.status}; options are for an open question`);
      const list = givenOptions.get(qid) ?? [];

      if (list.some((o) => o.id === option.id)) return yield* refuse(`${qid.toUpperCase()}'s option '${option.id}' is given twice`);
      list.push(option);
      givenOptions.set(qid, list);
    }

    for (const [qid, options] of givenOptions) {
      if (options.length < 2) {
        return yield* refuse(`${qid.toUpperCase()} has one option: give at least two (--option "${qid.toUpperCase()} a: label | consequence", once per option)`);
      }

      const q = byId.get(qid);

      if (q !== undefined) q.options = options;
    }

    const askedNow = new Set([...added.map((q) => q.id), ...revisedIds]);

    for (const q of qs) {
      const options = q.options ?? [];

      if ((askedNow.has(q.id) || givenOptions.has(q.id)) && options.length > 0 && !options.some((o) => o.id === (q.recommend ?? ""))) {
        return yield* refuse(
          `${q.id.toUpperCase()}'s recommendation ${pyStr(q.recommend ?? "None")} is not one of its options ` +
            `(${options.map((o) => o.id).join(", ")}): recommend by the option's id`,
        );
      }
    }

    yield* setBody(run, row);
    const open = qs.filter((q) => q.status === "open");
    row.question = open.length > 0 ? `${open.length} question${open.length === 1 ? "" : "s"} to answer` : "Every question is answered";

    for (const [qid, n] of longAsks) {
      run.warn(`state: ${row.id}'s ${qid.toUpperCase()} is ${String(n)} characters: ask it in one plain sentence, its choices as --option; the evidence goes in --body.`);
    }

    const reasoned = new Set([...askedNow, ...reasonedIds]);

    for (const q of qs) {
      for (const warning of grillWarnings(row, q, askedNow.has(q.id), reasoned.has(q.id), askedNow.has(q.id) || givenOptions.has(q.id), workersOf(ledger))) run.warn(warning);
    }

    if (askedNow.size > 0 || args.str("why") !== undefined || given(args.str("body"))) {
      const asked = qs.flatMap((q) => (askedNow.has(q.id) ? [q.body ?? "", q.reason ?? ""] : []));
      const past = unnamedPastWarning(row.id, [row.why ?? "", ...asked], bodyText(run.root, row));

      if (past !== undefined) run.warn(past);
      const visual = visualWarning(row.id, [row.why ?? "", ...qs.flatMap((q) => (askedNow.has(q.id) ? [q.body ?? ""] : []))], bodyText(run.root, row));

      if (visual !== undefined) run.warn(visual);
    }

    if (added.length > 0 && created) {
      run.say(
        `asked ${row.id}. Arm its answers' wake now, as a background command (run_in_background): ` +
          `${waitHint(run, row.id)}; arm it again after each round.`,
      );
    }

    const context = given(args.str("body")) || args.flag("no_body");

    if (added.length > 0 || revisions.length > 0 || reasons.length > 0 || givenOptions.size > 0 || context || renamed.length > 0) {
      if (!created) {
        row.revised = stamp(run);
        row.change = args.str("log") || null;
      }

      // A new round re-presents it.
      if (added.length > 0 || revisions.length > 0) unheld(row);

      const words =
        added.length > 0
          ? `${added.length} new question${added.length === 1 ? "" : "s"}`
          : revisions.length > 0
            ? "a question revised"
            : givenOptions.size > 0
              ? "options given"
              : reasons.length > 0
                ? "reasons added"
                : [...renamed, ...(context ? ["context"] : [])].map((k) => `the ${k} changed`).join(", ");

      log(run, ledger, { kind: "asked", text: `${row.title ?? "None"}: ${args.str("log") || words}`, agent: row.agent ?? null, important: row.blocking === true, decision: row.id });
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
  const findings = run.args.int("findings");
  const changesText = run.args.str("changes");
  const changes = (changesText ?? "").split(/[\s,]+/u).filter((c) => c !== "");

  if (kind === "reviewed") {
    if (findings === undefined || changes.length === 0) {
      return refuse(
        'a reviewed event says what the review found and of which changes: --findings N (0 when it found nothing) ' +
          'and --changes "<change id>,..." (jj\'s change ids of the stack it read; land-check looks them up)',
      );
    }

    if (findings < 0) return refuse("--findings counts what the review found: 0 or more");
    const bad = changes.filter((c) => !CHANGE_ID.test(c));

    if (bad.length > 0) return refuse(`--changes names jj change ids (letters and digits), not ${bad.join(", ")}`);
  } else if (findings !== undefined || changesText !== undefined) {
    return refuse("--findings and --changes go with --kind reviewed");
  }

  log(run, ledger, {
    kind: given(kind) ? kind : "note",
    text: run.args.str("text") ?? "",
    agent: agent ?? null,
    important: run.args.flag("important"),
  });

  const last = ledger.events.at(-1);

  if (kind === "reviewed" && last !== undefined) {
    last.findings = findings ?? 0;
    last.changes = changes;
  }

  return Effect.succeed(ledger);
}

/** One standing approval as `approval list` and `show` print it. */
export function approvalLine(ledger: Ledger, a: Approval): string {
  const d = a.ref.includes("/") ? undefined : findDecision(ledger, a.ref);
  const done = (ledger.decisions ?? []).filter((x) => x.kind === "notice" && x.under === a.id).length;
  const status = a.status === "active" ? "active" : `revoked ${a.revoked ?? "None"}: ${a.revoked_why ?? "None"}`;
  const from = (d?.ref !== undefined && d.ref !== "" ? d.ref : a.ref) + (a.question === undefined ? "" : `:${a.question.toUpperCase()}`);

  return `  approval ${a.id} ${status} [${done} notice${done === 1 ? "" : "s"}] ${a.rule} (from ${from} #${a.message === undefined ? "None" : String(a.message)}, by ${a.by}, ${a.added})`;
}

/** The lines `approval list` prints. */
export function approvalLines(ledger: Ledger): string[] {
  const rows = ledger.approvals ?? [];

  return rows.length === 0
    ? ["no standing approvals: `approval add ID --rule R --by WHO --ref DECISION` records one from a decision the user answered on the page"]
    : rows.map((a) => approvalLine(ledger, a));
}

/** Why `approval ACTION` is refused before it reads the ledger, if it is. */
export function approvalAction(action: string): Refusal | undefined {
  return APPROVAL_ACTIONS.some((x) => x === action) ? undefined : stateRefusal(`approval ${pyStr(action)} is not one of ${APPROVAL_ACTIONS.join(", ")}`);
}

/** `approval add|revoke`: a standing approval recorded from a decision the user answered on the page, or revoked. */
export function approval(ledger: Ledger, run: Run): Effect.Effect<Ledger, Refusal> {
  return Effect.gen(function* () {
    const args = run.args;
    const action = args.str("action") ?? "";
    const refused = approvalAction(action);

    if (refused !== undefined) return yield* Effect.fail(refused);
    let id = args.str("id");

    if (!given(id)) return yield* refuse(`approval ${action} names the approval: \`approval ${action} ID ...\``);
    const rows = (ledger.approvals ??= []);
    const a = find(rows, id);

    if (action === "revoke") {
      if (a === undefined) return yield* refuse(`unknown approval '${id}'`);

      if (a.status === "revoked") return yield* refuse(`approval ${a.id} is already revoked (${a.revoked ?? "None"}): ${a.revoked_why ?? "None"}`);
      const reason = args.str("reason") ?? "";

      if (reason.trim() === "") return yield* refuse('--reason says why, or where the user said it ("revoked on the page (#21)")');
      a.status = "revoked";
      a.revoked = stamp(run);
      a.revoked_why = reason;
      log(run, ledger, { kind: "decision", text: `Standing approval ${a.id} revoked: ${reason}`, decision: a.ref.includes("/") ? undefined : a.ref });
      run.say(`revoked approval ${a.id}: what it covered asks the user again.`);

      return ledger;
    }

    if (a !== undefined) return yield* refuse(`approval ${a.id} is already recorded (${a.status}): revoke it, or record the new rule under a new id`);

    if (id !== "next" && !APPROVAL_ID.test(id)) {
      return yield* refuse(`an approval's id is K and a number (K1, K2, ...), not ${pyStr(id)}: the other letters number decisions, links and roadblocks`);
    }

    yield* require(run, ["rule", "by", "ref"], "approval");
    const rule = args.str("rule") ?? "";
    const by = args.str("by") ?? "";

    if (rule.trim() === "" || by.trim() === "") return yield* refuse("--rule says what the approval covers, in the user's words, and --by who gave it");
    const src = approvalSource(run.machine, run.root, ledger, args.str("ref") ?? "");

    if (src instanceof NoSource) return yield* refuse(src.why);
    const local = resolvePath(src.dir) === resolvePath(run.root) ? src.id : undefined;
    const spent = rows.find((x) => x.status === "revoked" && sameSource(x, src.ref, src.question, local));

    if (spent !== undefined) {
      return yield* refuse(`${src.label} backed approval ${spent.id}, revoked (${spent.revoked ?? "None"}): a revoked approval's answer gives no new one; ask the user again`);
    }

    const standing = rows.find((x) => x.status === "active" && sameSource(x, src.ref, src.question, local));

    // One source backs one active approval: two `fleets approval add` at once, the second skips the first's.
    if (standing !== undefined) return yield* refuse(`${src.label} already backs approval ${standing.id} (active)`);
    const taken = approvalNumber(run.machine, run.root, id, highest(rows.map((x) => x.id), "K"));

    if (taken instanceof Unreachable) return yield* refuse(refusedFor(taken));

    for (const warning of taken.warnings) run.warn(warning);
    id = `K${String(taken.value)}`;

    const row: Approval = { id, rule, by, ref: src.ref, message: src.message, added: stamp(run), status: "active" };

    if (src.question !== undefined) row.question = src.question;

    if (src.author !== undefined) row.author = src.author;
    rows.push(row);
    log(run, ledger, { kind: "decision", text: `Standing approval ${id} from ${src.label} (#${String(src.message)}): ${rule}`, decision: src.decision });
    run.say(
      `recorded approval ${id}. An act it covers is recorded, not asked: \`decision ID --kind notice --under ${id} ` +
        '--title T --question "what was done" --undo "how to undo it"`',
    );

    return ledger;
  });
}

/** The kinds a decision may be opened as with `decision` (a grilling is opened with `grill`). */
export const DECISION_KINDS = KINDS;
