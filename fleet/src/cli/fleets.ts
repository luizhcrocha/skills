/**
 * `fleet fleets …` (Python's `fleets.py` CLI): the fleets served on this machine, what waits on the user, one fleet, the manager,
 * a decision in full, the gate, background processes, orphaned test and dev processes (`orphans`, TypeScript only, so
 * not in the usage line the oracle pins), whose files a landing moves, and naming a fleet.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { listening, oneLine, type Listening } from "../chat/chat.ts";
import { cardHash } from "../ledger/card-address.ts";
import { linkKind } from "../ledger/links.ts";
import { firstLine } from "../chat/news.ts";
import { readChat } from "../chat/store.ts";
import { parseInstant } from "../clock.ts";
import { Refusal } from "../errors.ts";
import { exists, readText } from "../files.ts";
import { answeredAt, silentWorkers } from "../health.ts";
import { Out } from "../io.ts";
import { asArray, asNumber, asObject, asString, dumps, pyRepr, truthy, type Json, type JsonObject, type JsonOut } from "../json.ts";
import { decodeLedger } from "../ledger/model.ts";
import { find, number } from "../ledger/numbers.ts";
import { budgetOf, capBytes, cpuBudgetOf, cpusHeld, endOf, floorOf, floorRefusal, gateOf, holdText, memAvailable, memTotal, plain, roomOf, runCapOf, shortText, sizeText, waitsForMemory, type Ask, type Budget, type Day, type GateHolder, type Standing, type Waiting } from "../gate.ts";
import { gateRun, RUN_USAGE, runArgs } from "../gate-run.ts";
import { processes } from "../procs.ts";
import { stateOf, type Entry } from "../registry.ts";
import { activeAt, spentBy } from "../transcripts.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";
import { orphansCommand } from "./orphans.ts";

const USAGE =
  "usage: fleet fleets list | waiting | show FLEET | manager | decision FLEET ID | name DIR SESSION | gate [take FLEET|--as NAME WHAT | free TOKEN] | procs | whose FROM TO";

function fail(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "fleets", reason }));
}

function str(value: Json | undefined): string {
  return asString(value) ?? pyRepr(value);
}

function rows(state: JsonObject, key: string): JsonObject[] {
  return (asArray(state[key]) ?? []).flatMap((r) => {
    const o = asObject(r);

    return o === undefined ? [] : [o];
  });
}

/** `state` with its numbers given, as Python's `decisions.number` gives them on a copy. */
function numbered(state: JsonObject): JsonObject {
  const ledger = decodeLedger(state);

  if (ledger instanceof Refusal) return state;
  number(ledger);
  const refs = new Map((ledger.decisions ?? []).map((d) => [d.id, d.ref ?? null]));

  return {
    ...state,
    decisions: rows(state, "decisions").map((d) => ({ ...d, ref: d["ref"] ?? refs.get(str(d["id"])) ?? null })),
  };
}

/** A token count in three figures and a unit (`471k`, `3.95M`), rounded half up in integers so Python's mirror prints the same. */
export function tokenCount(n: number): string {
  const units: readonly (readonly [number, string])[] = [
    [1e3, "k"],
    [1e6, "M"],
    [1e9, "B"],
  ];

  if (n < 1000) return String(n);
  let u = units.findLastIndex(([size]) => size <= n);
  let places = 2;
  let q = 0;

  for (;;) {
    const [size] = units[u] ?? [1e3];
    q = Math.floor((2 * n * 10 ** places + size) / (2 * size));

    if (q < 1000) break;

    if (places > 0) places -= 1;
    else if (u < units.length - 1) [u, places] = [u + 1, 2];
    else break;
  }

  const digits = String(q);
  const figures = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;

  return `${figures}${units[u]?.[1] ?? ""}`;
}

const LIVE = ["running", "blocked", "queued"] as const;

const LABEL_WIDTH = 48;

/** A worker's lanes, each glob once: a lane given as `a/**,b/**` is two. */
function lanesOf(agent: JsonObject): string[] {
  const globs = (asArray(agent["lane"]) ?? []).flatMap((l) => str(l).split(",")).map((g) => g.trim());

  return [...new Set(globs.filter((g) => g !== ""))];
}

function isLive(agent: JsonObject): boolean {
  return LIVE.some((s) => agent["status"] === s);
}

interface AgentLine {
  readonly id: string;
  readonly status: string;
  readonly model: string;
  readonly label: string;
  readonly lanes: readonly string[];
  readonly silentSince: string | undefined;
}

interface LinkLine {
  readonly ref: string;
  readonly kind: string;
  readonly url: string;
  readonly title: string;
}

interface WaitingLine {
  readonly ref: string;
  readonly id: string;
  readonly kind: string;
  readonly asks: "user" | "manager";
  readonly title: string;
  readonly blocking: boolean;
  readonly answeredAt: string | undefined;
  readonly held: string | undefined;
}

/** One fleet as `fleets list` prints it: who it is, then its live agents, its links, what waits in it, what it spent. */
interface FleetView {
  readonly id: string;
  readonly role: string;
  readonly moved: boolean;
  readonly status: string;
  readonly session: string | null;
  readonly active: string | undefined;
  readonly url: string;
  readonly dir: string;
  readonly now: string;
  readonly chat: Listening;
  readonly agents: readonly AgentLine[];
  readonly links: readonly LinkLine[];
  readonly waiting: readonly WaitingLine[];
  readonly spent: { readonly workers: number; readonly written: number; readonly read: number } | undefined;
}

function labelOf(agent: JsonObject): string {
  const named = truthy(agent["name"]) && str(agent["name"]) !== str(agent["id"]);
  const text = oneLine(named ? agent["name"] : agent["task"]);

  return [...text].length > LABEL_WIDTH ? `${[...text].slice(0, LABEL_WIDTH - 1).join("")}\u2026` : text;
}

function fleetView(machine: Machine, e: Entry): FleetView {
  const raw = stateOf(e);
  const state = raw === undefined ? {} : numbered(raw);
  const agents = rows(state, "agents");
  const silent = new Map(silentWorkers(machine, e.dir, state).map((w) => [w.id, w.active.slice(11, 16)]));
  const said = readChat(e.dir);
  const spent = spentBy(e.dir, machine.config);

  return {
    id: e.id,
    role: e.role,
    moved: e.moved === true,
    status: raw !== undefined && truthy(raw["status"]) ? str(raw["status"]) : "unknown",
    session: e.session,
    active: activeAt(e.dir, machine.config, asString(e.raw["session_id"])),
    url: e.url,
    dir: e.dir,
    now: truthy(state["now"]) ? oneLine(state["now"]) : "",
    chat: listening(machine, e.dir),
    agents: agents.filter(isLive).map((a) => ({
      id: str(a["id"]),
      status: str(a["status"]),
      model: truthy(a["model"]) ? str(a["model"]) : "-",
      label: labelOf(a),
      lanes: lanesOf(a),
      silentSince: silent.get(str(a["id"])),
    })),
    links: rows(state, "links")
      .filter((l) => asString(l["url"]) !== undefined)
      .map((l) => ({
        ref: truthy(l["ref"]) ? str(l["ref"]) : str(l["id"]),
        kind: linkKind(asString(l["kind"]), str(l["url"]), asString(l["title"])) + (truthy(l["done"]) ? ", done" : ""),
        url: str(l["url"]),
        title: oneLine(l["title"]),
      })),
    waiting: rows(state, "decisions")
      .filter((d) => d["status"] === "open" && asString(d["id"]) !== undefined)
      .map((d) => ({
        ref: truthy(d["ref"]) ? str(d["ref"]) : "",
        id: str(d["id"]),
        kind: d["kind"] === undefined ? "decision" : str(d["kind"]),
        asks: d["asks"] === "manager" ? "manager" : "user",
        title: oneLine(d["title"]),
        blocking: d["blocking"] === true,
        answeredAt: answeredAt(d, said, e.moved === true),
        held: truthy(d["held"]) ? str(d["held"]) : undefined,
      })),
    spent:
      spent === undefined
        ? undefined
        : { workers: agents.reduce((sum, a) => sum + Math.trunc(asNumber(a["tokens"]) ?? 0), 0), written: spent.output, read: spent.input },
  };
}

/** `text` padded with spaces to `width` characters, counted as Python counts them. */
function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - [...text].length));
}

/** `table` as columns two spaces apart, the last column unpadded. */
function columns(table: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];

  for (const row of table) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, [...cell].length)));

  return table.map((row) => `    ${row.map((cell, i) => (i === row.length - 1 ? cell : pad(cell, widths[i] ?? 0))).join("  ")}`.trimEnd());
}

function agentLines(agents: readonly AgentLine[]): string[] {
  const counts = LIVE.flatMap((s) => {
    const n = agents.filter((a) => a.status === s).length;

    return n === 0 ? [] : [`${n} ${s}`];
  });

  const tails = agents.map((a) => {
    const [first, ...more] = a.lanes;
    const lanes = first === undefined ? [] : [`lanes: ${first}${more.length > 0 ? ` +${more.length}` : ""}`];

    return [...lanes, ...(a.silentSince === undefined ? [] : [`SILENT since ${a.silentSince}`])].join("  ");
  });

  return [`  agents   ${counts.join(", ")}`, ...columns(agents.map((a, i) => [a.id, a.status, a.model, a.label, tails[i] ?? ""]))];
}

function waitingLines(waiting: readonly WaitingLine[]): string[] {
  const table = waiting.map((d) => {
    const marks = [
      d.title,
      ...(d.blocking ? ["blocks work"] : []),
      ...(d.answeredAt === undefined ? [] : [`ANSWERED at ${d.answeredAt.slice(11, 16)}, not recorded`]),
      ...(d.held === undefined ? [] : [`held by the fleet: ${d.held}`]),
    ];

    return [d.ref, d.id, d.kind, `for the ${d.asks}`, marks.join("  ")];
  });

  return [`  waiting  ${waiting.length}`, ...columns(table)];
}

function render(v: FleetView): string[] {
  const identity = [
    `${v.id}  (${v.role}, ${v.status}${v.moved ? ", moved to the cloud" : ""})`,
    `  session  ${v.session ?? "(not named yet)"}${v.active === undefined ? "" : `, last active ${v.active.slice(0, 16).replace("T", " ")}`}`,
    `  page     ${v.url}`,
    `  ledger   ${v.dir}`,
    ...(v.now === "" ? [] : [`  now      ${v.now}`]),
    ...(v.chat.on ? [] : [`  chat     not read now${v.chat.unread > 0 ? `; ${v.chat.unread} message(s) from the user wait since #${v.chat.seen}` : ""}`]),
  ];

  const sections = [
    ...(v.agents.length === 0 ? [] : agentLines(v.agents)),
    ...(v.links.length === 0 ? [] : [`  links    ${v.links.length}`, ...columns(v.links.map((l) => [l.ref, l.kind, l.url, l.title]))]),
    ...(v.waiting.length === 0 ? [] : waitingLines(v.waiting)),
    ...(v.spent === undefined
      ? []
      : [`  tokens   workers ${tokenCount(v.spent.workers)}; ${v.role} ${tokenCount(v.spent.written)} written, ${tokenCount(v.spent.read)} read`]),
  ];

  return sections.length === 0 ? identity : [...identity, "", ...sections];
}

function list(machine: Machine): Effect.Effect<void, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const entries = machine.registry.shown();

    if (entries.length === 0) out.out("no fleet is being served on this machine\n");
    const blocks = entries.map((e) => render(fleetView(machine, e)).join("\n"));

    if (blocks.length > 0) out.out(`${blocks.join("\n\n")}\n`);
  });
}

/** What waits on the user, from every served fleet's ledger (the manager's own included): each open
 * decision for the user that its fleet does not hold, with since when, and the answer the user sent that
 * the fleet has not recorded yet. The one list: nothing else says what waits on the user. */
function waiting(machine: Machine): Effect.Effect<void, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const say = (line: string): void => out.out(`${line}\n`);
    const entries = machine.registry.shown();

    if (entries.length === 0) {
      say("no fleet is being served on this machine");

      return;
    }

    let found = 0;

    for (const e of entries) {
      const state = numbered(stateOf(e) ?? {});
      const said = readChat(e.dir);

      for (const d of rows(state, "decisions")) {
        const asks = truthy(d["asks"]) ? str(d["asks"]) : "user";

        if (asString(d["id"]) === undefined || d["status"] !== "open" || asks !== "user" || truthy(d["held"])) continue;
        found += 1;
        const marks = [truthy(d["kind"]) ? str(d["kind"]) : "decision", ...(d["blocking"] === true ? ["blocks work"] : [])].join(", ");
        const since = truthy(d["revised"]) ? str(d["revised"]) : truthy(d["opened"]) ? str(d["opened"]) : "";
        const ref = truthy(d["ref"]) ? str(d["ref"]) : str(d["id"]);
        let line = `${e.id} ${ref} [${marks}] ${oneLine(d["title"])}  since ${since.slice(0, 16).replace("T", " ")}`;
        const at = answeredAt(d, said, e.moved === true);

        if (at !== undefined) {
          const m = [...said].reverse().find((x) => x.decision !== undefined && pyRepr(x.decision) === pyRepr(d["id"]) && str(x.at) === at);
          line += `  ANSWERED at ${at.slice(11, 16)} (#${m?.id ?? "?"}): ${firstLine(m?.text ?? "")}; not recorded yet`;
        }

        say(line);
      }
    }

    if (found === 0) say("nothing waits on the user");
  });
}

function show(machine: Machine, fleet: string): Effect.Effect<void, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const say = (line: string): void => out.out(`${line}\n`);
    const entry = machine.registry.shown().find((e) => e.id === fleet);

    if (entry === undefined) return yield* fail(`no fleet '${fleet}' is being served; \`fleet fleets list\` names the ones that are`);
    const state = numbered(stateOf(entry) ?? {});
    say(`${fleet}  ${state["status"] === undefined ? "unknown" : str(state["status"])}  ${entry.url}`);
    say(`    now: ${state["now"] === undefined ? "" : str(state["now"])}` + (truthy(state["now_at"]) ? `  (said ${str(state["now_at"])})` : ""));
    const heard = listening(machine, entry.dir);
    say(`    chat: ${heard.on ? "read" : "not read now"}` + (heard.unread > 0 ? `; ${heard.unread} from the user unread since #${heard.seen}` : ""));

    const silent = new Map(silentWorkers(machine, entry.dir, state).map((w) => [w.id, w]));

    for (const a of rows(state, "agents")) {
      if (a["status"] !== "running" && a["status"] !== "blocked" && a["status"] !== "queued") continue;
      const since = truthy(a["updated"]) ? a["updated"] : a["started"];
      say(`    ${str(a["id"])} (${str(a["name"])}) ${str(a["status"])} since ${str(since)}: ${str(a["task"])}`);
      const quiet = silent.get(str(a["id"]));

      if (quiet !== undefined) say(`        silent since ${quiet.active.slice(11, 16)}: check it before saying it runs`);

      if (truthy(a["report"])) say(`        last report: ${[...str(a["report"])].slice(0, 300).join("")}`);
    }

    const owners = new Map<string, string[]>();

    for (const a of rows(state, "agents").filter(isLive)) {
      for (const lane of lanesOf(a)) owners.set(lane, [...(owners.get(lane) ?? []), str(a["id"])]);
    }

    for (const lane of [...owners.keys()].sort()) say(`    lane ${lane}  ${(owners.get(lane) ?? []).join(", ")}`);

    const said = readChat(entry.dir);

    for (const d of rows(state, "decisions")) {
      if (d["status"] !== "open") continue;
      const asks = truthy(d["asks"]) ? str(d["asks"]) : "user";
      const ref = truthy(d["ref"]) ? str(d["ref"]) : "";
      say(`    decision ${ref} ${str(d["id"])} [${asks}${truthy(d["blocking"]) ? ", blocks work" : ""}] ${str(d["title"])}: ${str(d["question"])}`);

      if (truthy(d["held"])) say(`        held by the fleet since ${str(d["held_at"]).slice(11, 16)}: ${str(d["held"])}`);
      const at = answeredAt(d, said, entry.moved === true);

      if (at !== undefined) {
        const m = [...said].reverse().find((x) => x.decision !== undefined && pyRepr(x.decision) === pyRepr(d["id"]) && str(x.at) === at);
        say(`        ANSWERED by the user at ${at.slice(11, 16)} (#${m?.id ?? "?"}): ${[...(m?.text ?? "")].slice(0, 200).join("")}; not recorded yet`);
      }
    }

    for (const r of rows(state, "roadblocks")) {
      if (!truthy(r["resolved"])) say(`    roadblock ${str(r["id"])} [needs ${str(r["needs"])}] ${str(r["title"])}`);
    }

    for (const e of rows(state, "events").slice(-8)) {
      const at = e["at"] === undefined ? "" : str(e["at"]);
      say(`    ${at.slice(11, 16)} ${str(e["kind"])} ${truthy(e["agent"]) ? str(e["agent"]) : ""} ${str(e["text"])}`.replaceAll("  ", " "));
    }
  });
}

function manager(machine: Machine): Effect.Effect<void, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const { manager: found, away } = machine.registry.presentManager();

    if (found === undefined) {
      return yield* fail(away === undefined ? "no manager is being served on this machine" : `the manager moved to the cloud is not present (${away})`);
    }

    const session = found.session ?? (found.moved === true ? "(in its greeting)" : "(not named yet)");
    out.out(`manager  session ${session}  ${found.url}  ${found.dir}\n`);
    out.out(`    what holds for every fleet: ${join(found.dir, "standing.md")}\n`);
  });
}

function decision(machine: Machine, fleet: string, id: string): Effect.Effect<void, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const say = (line: string): void => out.out(`${line}\n`);
    const entry = machine.registry.shown().find((e) => e.id === fleet);

    if (entry === undefined) return yield* fail(`no fleet '${fleet}' is being served; \`fleet fleets list\` names the ones that are`);
    const decisions = rows(stateOf(entry) ?? {}, "decisions").map((d) => ({ d, id: str(d["id"]), ref: asString(d["ref"]) ?? "" }));
    const d = find(decisions, id)?.d;

    if (d === undefined) return yield* fail(`no decision '${id}' in ${fleet}`);
    const open = d["status"] === "open";

    const marks = [
      d["kind"] === undefined ? "decision" : str(d["kind"]),
      open ? (d["asks"] === "manager" ? "for the manager" : "for the user") : str(d["status"]),
      ...(open && truthy(d["blocking"]) ? ["blocks work"] : []),
    ];

    say(`${fleet} ${id} [${marks.join(", ")}] ${str(d["title"])}`);
    say(`    question: ${str(d["question"])}`);

    for (const key of ["why", "secret", "manual", "change", "answer", "resolution"]) {
      if (truthy(d[key])) say(`    ${key}: ${str(d[key])}`);
    }

    for (const row of asArray(d["options"]) ?? []) {
      const o = asObject(row) ?? {};
      say(`    ${str(o["id"])}: ${str(o["label"])} | ${str(o["consequence"])}`);
    }

    if (truthy(d["recommend"])) say(`    recommended: ${str(d["recommend"])}` + (truthy(d["reason"]) ? `, ${str(d["reason"])}` : ""));

    if (truthy(d["agent"])) say(`    waits: ${str(d["agent"])}`);

    for (const m of readChat(entry.dir)) {
      if (m.decision !== undefined && pyRepr(m.decision) === pyRepr(d["id"]) && m.from === "user") {
        say(`    the user answered #${m.id} at ${str(m.at).slice(11, 16)}: ${[...m.text].slice(0, 200).join("")}`);
      }
    }

    if (truthy(d["body"])) say(`    evidence: ${join(entry.dir, "decisions", `${str(d["id"])}.html`)}`);

    // A moved team's page is the cloud's, which reads `#decision/<id>` until it ships the number-and-slug address.
    const hash = entry.moved === true
      ? `#decision/${encodeURIComponent(str(d["id"]))}`
      : cardHash({ id: str(d["id"]), ref: asString(d["ref"]), title: asString(d["title"]) }, entry.id);

    say(`    page: ${entry.url}${hash}`);
  });
}

// The usage lines are the oracle traces': `gate run` prints its own (RUN_USAGE), and `gate --json` is SPEC's. The Python
// twin's has no --mem or --floor (the traces' `gate-usage` normaliser).
const GATE_USAGE = "usage: fleet fleets gate | gate take FLEET|--as NAME WHAT [--for MINUTES] [--wait SECONDS] [--mem SIZE|PERCENT] [--floor SIZE|PERCENT] | gate free TOKEN";

/** How long a hold lasts when `--for` does not say: a dead holder frees its part of the gate after this. */
const HOLD_MINUTES = 60;

interface Take {
  readonly holder: GateHolder;
  readonly what: string;
  readonly minutes: number;
  readonly waitS: number;
  /** The part of the budget it asks for (`--mem`); undefined is all of it. */
  readonly mem: string | undefined;
  /** The memory it leaves free (`--floor`); undefined is $FLEET_GATE_MEMORY_FLOOR's, else the default. */
  readonly floor: string | undefined;
}

/** `gate take`'s arguments: `FLEET WHAT` or `--as NAME WHAT`, then `--for MINUTES`, `--wait SECONDS`, `--mem SIZE|PERCENT`
 * and `--floor SIZE|PERCENT`. */
function takeArgs(argv: readonly string[]): Take | undefined {
  const words: string[] = [];
  let as: string | undefined;
  let minutes = HOLD_MINUTES;
  let waitS = 0;
  let mem: string | undefined;
  let floor: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i] ?? "";
    const value = argv[i + 1];

    if (word === "--as" || word === "--for" || word === "--wait" || word === "--mem" || word === "--floor") {
      if (value === undefined) return undefined;
      i += 1;

      if (word === "--as") as = value.trim();
      else if (word === "--for") minutes = /^[0-9]+$/.test(value) ? Number(value) : 0;
      else if (word === "--wait") waitS = /^[0-9]+$/.test(value) ? Number(value) : -1;
      else if (word === "--floor") floor = value.trim();
      else mem = value.trim();
    } else {
      words.push(word);
    }
  }

  if (minutes <= 0 || waitS < 0 || as === "" || mem === "" || floor === "") return undefined;

  if (as !== undefined) return words.length === 1 ? { holder: { name: as, kind: "session" }, what: words[0] ?? "", minutes, waitS, mem, floor } : undefined;

  return words.length === 2 ? { holder: { name: words[0] ?? "", kind: "fleet" }, what: words[1] ?? "", minutes, waitS, mem, floor } : undefined;
}

/** Seconds from the stamp `since` to `now`. */
function secondsSince(since: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - (parseInstant(since) ?? now.getTime())) / 1000));
}

function capText(cap: number | undefined): string {
  return cap === undefined ? "the whole budget" : sizeText(cap);
}

/** The CPU row in words, beside the memory's: `CPUs 24: 16 held, 8 free`. */
function cpuText(cpus: number, held: number): string {
  return `CPUs ${String(cpus)}: ${String(held)} held, ${String(Math.max(0, cpus - held))} free`;
}

/** `fleet fleets gate`: `free`, or a line per hold; then the budget, memory and CPUs, when a hold takes a part of it,
 * the queue in order, and the last day's runs in a line when there were any. */
function gateLines(standing: Standing, budget: Budget | undefined, cpus: number | undefined, day: Day | undefined, now: Date): string[] {
  const { holders, queue } = standing;
  // The room all holds share: the smallest budget any holder read, and this caller's.
  const room = budget === undefined ? undefined : roomOf(budget.bytes, holders);
  const held = holders.reduce((sum, h) => sum + (h.cap ?? room ?? 0), 0);

  return [
    ...(holders.length === 0 ? ["free"] : holders.map(holdText)),
    ...(budget !== undefined && room !== undefined && holders.some((h) => h.cap !== undefined)
      ? [`budget ${sizeText(room)}${room === budget.bytes ? ` (${budget.spec})` : ""}: ${sizeText(held)} held, ${sizeText(Math.max(0, room - held))} free` +
        `${cpus === undefined ? "" : `; ${cpuText(cpus, cpusHeld(holders))}`}`]
      : []),
    ...queue.map((w, i) => {
      const forMemory = room !== undefined && waitsForMemory(w, room, holders, cpus);
      const marks = `${w.cpus === undefined ? "" : `, ${String(w.cpus)} CPUs`}${w.landing ? ", a landing gate" : ""}${w.light ? ", light" : ""}`;

      return `queue ${String(i + 1)}: ${w.kind === "session" ? `${plain(w.name)} (no fleet)` : plain(w.name)}, ${capText(w.cap)}${marks}, waiting ${forMemory ? "for the memory floor " : ""}${String(secondsSince(w.since, now))}s: ${plain(w.what)}`;
    }),
    ...(day === undefined ? [] : [
      `last 24 h: ${String(day.runs)} runs, wait median ${String(day.medianWait)}s, p90 ${String(day.p90Wait)}s, memory peak max ${day.maxPeak === undefined ? "unknown" : sizeText(day.maxPeak)}` +
        `${day.gaveUp > 0 ? `, ${String(day.gaveUp)} gave up waiting` : ""}${day.capped > 0 ? `, ${String(day.capped)} hit the cap` : ""}`,
    ]),
  ];
}

/** `fleet fleets gate --json`: the same, for a page or a script. Sizes are bytes, waits seconds. */
function gateJson(standing: Standing, budget: Budget | undefined, cpus: number | undefined, day: Day | undefined, now: Date): JsonOut {
  return {
    budget: budget === undefined ? null : { spec: budget.spec, bytes: budget.bytes },
    cpu: cpus === undefined ? null : { budget: cpus, held: cpusHeld(standing.holders) },
    holders: standing.holders.map((h) => ({
      name: h.name, kind: h.kind, what: h.what, since: h.since, until: h.until ?? null, cap: h.cap ?? null, budget: h.budget ?? null, pid: h.pid ?? null, runner: h.runner ?? null,
      unit: h.unit ?? h.runnerUnit ?? null, cpus: h.cpus ?? null, landing: h.landing, light: h.light,
    })),
    queue: standing.queue.map((w, i) => ({
      place: i + 1, name: w.name, kind: w.kind, what: w.what, cap: w.cap ?? null, since: w.since, waited: secondsSince(w.since, now), pid: w.pid,
      cpus: w.cpus ?? null, landing: w.landing, light: w.light,
      for_memory: budget !== undefined && waitsForMemory(w, roomOf(budget.bytes, standing.holders), standing.holders, cpus),
    })),
    day: day === undefined ? null : { runs: day.runs, gave_up: day.gaveUp, median_wait: day.medianWait, p90_wait: day.p90Wait, max_peak: day.maxPeak ?? null, capped: day.capped },
  };
}

/** Why a take waits or is refused, in words: each hold, who is before it in the queue, and the memory it lacks; then
 * what to do. */
function waitingText(waiting: Waiting): string {
  const ahead = waiting.ahead.length === 0 ? [] : [`${String(waiting.ahead.length)} before it in the queue (${waiting.ahead.map((w) => plain(w.name)).join(", ")})`];
  const short = waiting.short === undefined ? [] : [`not enough memory: ${shortText(waiting.short, "this hold")}`];
  const gateToo = !waiting.fits || waiting.ahead.length > 0;

  const then = short.length === 0 ? "take it when `fleet fleets gate` says free"
    : gateToo ? "take it once the gate has room for it and more memory is available (--wait queues for both)"
    : "take it when more memory is available (--wait queues for it), or with a smaller --mem";

  return [...waiting.holders.map(holdText), ...ahead, ...short, then].join("; ");
}

function gate(machine: Machine, argv: readonly string[]): Effect.Effect<void | number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const registry = machine.registry;
    const slot = gateOf(registry);
    const [what, key] = argv;

    if (what === "run") {
      const ask = runArgs(argv.slice(1));

      if (ask === undefined) return yield* fail(RUN_USAGE);

      return yield* Effect.promise(() => gateRun(machine, ask, (line) => out.err(`${line}\n`)));
    }

    if (argv.length === 0 || (argv.length === 1 && what === "--json")) {
      const now = machine.now();
      const standing = slot.standing(now);
      const budget = budgetOf(machine.env);
      const cpus = cpuBudgetOf(machine.env);
      const day = slot.day(now);

      out.out(what === "--json" ? `${dumps(gateJson(standing, budget, cpus, day, now))}\n` : `${gateLines(standing, budget, cpus, day, now).join("\n")}\n`);
    } else if (what === "take") {
      const take = takeArgs(argv.slice(1));

      if (take === undefined) return yield* fail(GATE_USAGE);

      if (take.holder.kind === "fleet" && !registry.live().some((e) => e.id === take.holder.name)) {
        return yield* fail(`no fleet '${take.holder.name}' is being served`);
      }

      const budget = budgetOf(machine.env);

      if (budget === undefined) return yield* fail(`cannot read the budget $FLEET_GATE_MEMORY_BUDGET='${machine.env("FLEET_GATE_MEMORY_BUDGET") ?? ""}': give a share of the RAM (50%) or a size (24G), 64M at least`);
      const cap = take.mem === undefined ? undefined : capBytes(take.mem, memTotal());

      if (take.mem !== undefined && cap === undefined) return yield* fail(`cannot read --mem '${take.mem}': give a share of the RAM (25%) or a size (24G), 64M at least`);

      if (cap !== undefined && cap > budget.bytes) {
        return yield* fail(`--mem ${take.mem ?? ""} (${sizeText(cap)}) is more than the budget of all holds together, ${budget.spec} (${sizeText(budget.bytes)})`);
      }

      const floor = floorOf(take.floor, machine.env);

      if (floor === undefined) return yield* fail(floorRefusal(take.floor, machine.env));

      if (take.floor !== undefined && memAvailable(machine.env) === undefined) out.err("fleets: no MemAvailable here (no /proc/meminfo): --floor is ignored, and only the budget counts\n");

      // The gate reads MemAvailable at each ask, under its lock: what others use (dev servers, sessions) comes and goes.
      const memory = { floor: floor.bytes, whole: runCapOf(machine.env, budget.bytes), env: machine.env };
      const ask: Ask = { holder: take.holder, what: take.what, seconds: take.minutes * 60, cap, budget: budget.bytes, pid: process.pid, runs: false, waitS: take.waitS, memory };
      const asked = (): ReturnType<typeof slot.ask> => slot.ask(ask, machine.now());

      const deadline = Date.now() + take.waitS * 1000;
      let result = asked();
      let saidShort = false;

      while ("waiting" in result && Date.now() < deadline) {
        if (!saidShort && result.waiting.short !== undefined) {
          out.err(`fleets: not enough memory: ${shortText(result.waiting.short, "this hold")}; waiting up to ${String(take.waitS)}s\n`);
          saidShort = true;
        }

        Bun.sleepSync(Math.min(1000, Math.max(0, deadline - Date.now())));
        result = asked();
      }

      if ("waiting" in result) {
        slot.leave(process.pid, machine.now());

        return yield* fail(waitingText(result.waiting));
      }

      const token = result.took.token ?? "";
      out.out(`${plain(take.holder.name)} holds the gate: ${plain(take.what)}\n`);
      out.out(`token ${token}, until ${result.took.until ?? ""}: free it with \`fleet fleets gate free ${token}\`\n`);
    } else if (what === "free" && key !== undefined && argv.length === 2) {
      const result = slot.free(key, machine.now());

      if ("held" in result) return yield* fail(`held by ${result.held.map((h) => plain(h.name)).join(", ")}, not ${key}`);

      if ("running" in result) {
        // The run still holds its memory: its hold goes when the run does. A scope is stopped by its name, whoever has
        // its runner's pid by now; a run without one by its runner.
        const ends = result.running.flatMap((h) => endOf(h) ?? []);

        return yield* fail(
          `${result.running.map((h) => `${plain(h.name)}'s gate run (pid ${String(h.pid)}) is still going: ${plain(h.what)}`).join("; ")}; ` +
            `a run's hold is freed when the run ends. ` +
            (ends.length === 0 ? "It is ending: ask again in a moment" : `To end it, with every process it started: \`${ends.join("; ")}\``),
        );
      }

      out.out("free\n");
    } else {
      return yield* fail(GATE_USAGE);
    }

    return undefined;
  });
}

function procs(machine: Machine): Effect.Effect<void, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const now = Date.now() / 1000;

    for (const e of machine.registry.live()) {
      const found = processes(e.dir);
      out.out(`${e.id}: ${found.length} background process(es)\n`);

      for (const p of found) out.out(`    ${p.pid}  ${((now - p.started) / 3600).toFixed(1)} h  ${[...p.command].slice(0, 160).join("")}\n`);
    }
  });
}

/** Python's `fnmatch.fnmatch` on a POSIX path: `*` matches across `/`. */
export function globMatches(path: string, glob: string): boolean {
  let pattern = "";

  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? "";

    if (c === "*") pattern += ".*";
    else if (c === "?") pattern += ".";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 2);

      if (close < 0) pattern += "\\[";
      else {
        let set = glob.slice(i + 1, close);

        if (set.startsWith("!")) set = `^${set.slice(1)}`;
        pattern += `[${set.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else pattern += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }

  return new RegExp(`^(?:${pattern})$`, "s").test(path);
}

function whose(machine: Machine, argv: readonly string[]): Effect.Effect<void, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (argv.length !== 2) return yield* fail("usage: fleet fleets whose FROM TO   (run in the repository; owners from the manager's DIR/owners)");
    const found = machine.registry.manager();
    const ownersFile = found === undefined ? undefined : join(found.dir, "owners");

    if (ownersFile === undefined || !exists(ownersFile)) {
      return yield* fail("no owners file: the manager writes DIR/owners, one `FLEET GLOB` per line (`infra servers/case-analysis/**`)");
    }

    const rules = (readText(ownersFile) ?? "")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !line.startsWith("#"))
      .map((line) => line.trim().split(/\s+(.*)/s));

    const diff = spawnSync("jj", ["diff", "--from", argv[0] ?? "", "--to", argv[1] ?? "", "--summary"], { encoding: "utf8" });

    if (diff.status !== 0) return yield* fail(diff.stderr.trim() === "" ? "jj diff failed" : diff.stderr.trim());
    const by = new Map<string, string[]>();

    for (const line of diff.stdout.split("\n")) {
      if (line === "") continue;
      const path = (line.trim().split(/\s+(.*)/s)[1] ?? line).trim();
      const owner = rules.find(([, glob]) => glob !== undefined && globMatches(path, glob.trim()))?.[0] ?? "unowned";
      by.set(owner, [...(by.get(owner) ?? []), path]);
    }

    for (const owner of [...by.keys()].sort()) {
      const paths = by.get(owner) ?? [];
      out.out(`${owner}: ${paths.length} file(s)\n`);

      for (const path of paths) out.out(`    ${path}\n`);
    }
  });
}

function name(machine: Machine, dir: string, session: string): Effect.Effect<void, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const entry = machine.registry.name(dir, session);

    if ("why" in entry) return yield* fail(entry.why);
    out.out(`this fleet is ${entry.id}, the session ${entry.session ?? "None"}: use that one name everywhere\n`);
  });
}

function runCommand(machine: Machine, argv: readonly string[]): Effect.Effect<void | number, Refusal, Out | World> {
  const [cmd, a = "", b = ""] = argv;

  if (argv.length === 1 && cmd === "list") return list(machine);

  if (argv.length === 1 && cmd === "manager") return manager(machine);

  if (argv.length === 1 && cmd === "waiting") return waiting(machine);

  if (cmd === "gate") return gate(machine, argv.slice(1));

  if (argv.length === 1 && cmd === "procs") return procs(machine);

  if (argv.length === 1 && cmd === "orphans") return orphansCommand(machine);

  if (cmd === "whose") return whose(machine, argv.slice(1));

  if (argv.length === 2 && cmd === "show") return show(machine, a);

  if (argv.length === 3 && cmd === "decision") return decision(machine, a, b);

  if (argv.length === 3 && cmd === "name") return name(machine, a, b);

  return fail(USAGE);
}

/** Run `fleet fleets` with `argv` (after `fleets`); the exit code. */
export function fleetsCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* runCommand(machine, argv).pipe(
      Effect.map((code) => code ?? 0),
      Effect.catch(exitOf),
    );
  });
}
