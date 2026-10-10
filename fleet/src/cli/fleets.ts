/**
 * `fleet fleets …` (Python's `fleets.py` CLI): the fleets served on this machine, what waits on the user, one fleet, the manager,
 * a decision in full, the gate, background processes, whose files a landing moves, and naming a fleet.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { listening, oneLine, type Listening } from "../chat/chat.ts";
import { linkKind } from "../ledger/links.ts";
import { firstLine } from "../chat/news.ts";
import { readChat } from "../chat/store.ts";
import { Refusal } from "../errors.ts";
import { exists, isDir, readText, resolvePath } from "../files.ts";
import { answeredAt, silentWorkers } from "../health.ts";
import { Out, recordingOut } from "../io.ts";
import { asArray, asNumber, asObject, asString, pyRepr, truthy, type Json, type JsonObject } from "../json.ts";
import { decodeLedger } from "../ledger/model.ts";
import { find, number } from "../ledger/numbers.ts";
import { processes } from "../procs.ts";
import { approvalSource, NoSource, parseSource, sameSource } from "../ledger/approvals.ts";
import { parseLedger, type Approval } from "../ledger/model.ts";
import { findDecision } from "../ledger/numbers.ts";
import { stateOf, type Entry, type GateHolder } from "../registry.ts";
import { stateCli } from "./state.ts";
import { activeAt, spentBy } from "../transcripts.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";

const USAGE =
  "usage: fleet fleets list | waiting | show FLEET | manager | decision FLEET ID | name DIR SESSION | gate [take FLEET|--as NAME WHAT | free TOKEN] | procs | whose FROM TO | approval add|revoke ...";

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
    status: raw !== undefined && truthy(raw["status"]) ? str(raw["status"]) : "unknown",
    session: e.session,
    active: activeAt(e.dir, machine.config),
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
        answeredAt: answeredAt(d, said),
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
    `${v.id}  (${v.role}, ${v.status})`,
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
    const entries = machine.registry.live();

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
    const entries = machine.registry.live();

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
        const at = answeredAt(d, said);

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
    const entry = machine.registry.live().find((e) => e.id === fleet);

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
      const at = answeredAt(d, said);

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
    const found = machine.registry.manager();

    if (found === undefined) return yield* fail("no manager is being served on this machine");
    out.out(`manager  session ${found.session ?? "(not named yet)"}  ${found.url}  ${found.dir}\n`);
    out.out(`    what holds for every fleet: ${join(found.dir, "standing.md")}\n`);
  });
}

function decision(machine: Machine, fleet: string, id: string): Effect.Effect<void, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const say = (line: string): void => out.out(`${line}\n`);
    const entry = machine.registry.live().find((e) => e.id === fleet);

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
    say(`    page: ${entry.url}#decision/${str(d["id"])}`);
  });
}

function heldText(held: JsonObject): string {
  const who = held["kind"] === "session" ? `${str(held["fleet"])} (no fleet)` : str(held["fleet"]);
  const until = truthy(held["until"]) ? `, until ${str(held["until"])}` : "";

  return `held by ${who} since ${str(held["since"])}${until}: ${str(held["what"])}`;
}

const GATE_USAGE = "usage: fleet fleets gate | gate take FLEET|--as NAME WHAT [--for MINUTES] [--wait SECONDS] | gate free TOKEN";

/** How long a hold lasts when `--for` does not say: a dead holder frees the slot after this. */
const HOLD_MINUTES = 60;

interface Take {
  readonly holder: GateHolder;
  readonly what: string;
  readonly minutes: number;
  readonly waitS: number;
}

/** `gate take`'s arguments: `FLEET WHAT` or `--as NAME WHAT`, then `--for MINUTES` and `--wait SECONDS`. */
function takeArgs(argv: readonly string[]): Take | undefined {
  const words: string[] = [];
  let as: string | undefined;
  let minutes = HOLD_MINUTES;
  let waitS = 0;

  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i] ?? "";
    const value = argv[i + 1];

    if (word === "--as" || word === "--for" || word === "--wait") {
      if (value === undefined) return undefined;
      i += 1;

      if (word === "--as") as = value.trim();
      else if (word === "--for") minutes = /^[0-9]+$/.test(value) ? Number(value) : 0;
      else waitS = /^[0-9]+$/.test(value) ? Number(value) : -1;
    } else {
      words.push(word);
    }
  }

  if (minutes <= 0 || waitS < 0 || as === "") return undefined;

  if (as !== undefined) return words.length === 1 ? { holder: { name: as, kind: "session" }, what: words[0] ?? "", minutes, waitS } : undefined;

  return words.length === 2 ? { holder: { name: words[0] ?? "", kind: "fleet" }, what: words[1] ?? "", minutes, waitS } : undefined;
}

function gate(machine: Machine, argv: readonly string[]): Effect.Effect<void, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const registry = machine.registry;
    const [what, key] = argv;

    if (argv.length === 0) {
      const held = registry.gate(machine.now());
      out.out(`${held === undefined ? "free" : heldText(held)}\n`);
    } else if (what === "take") {
      const take = takeArgs(argv.slice(1));

      if (take === undefined) return yield* fail(GATE_USAGE);

      if (take.holder.kind === "fleet" && !registry.live().some((e) => e.id === take.holder.name)) {
        return yield* fail(`no fleet '${take.holder.name}' is being served`);
      }

      const deadline = Date.now() + take.waitS * 1000;
      let result = registry.takeGate(take.holder, take.what, machine.now(), take.minutes);

      while ("held" in result && Date.now() < deadline) {
        Bun.sleepSync(Math.min(1000, Math.max(0, deadline - Date.now())));
        result = registry.takeGate(take.holder, take.what, machine.now(), take.minutes);
      }

      if ("held" in result) return yield* fail(`${heldText(result.held)}; take it when \`fleet fleets gate\` says free`);
      const token = str(result.took["token"]);
      out.out(`${take.holder.name} holds the gate: ${take.what}\n`);
      out.out(`token ${token}, until ${str(result.took["until"])}: free it with \`fleet fleets gate free ${token}\`\n`);
    } else if (what === "free" && key !== undefined && argv.length === 2) {
      const result = registry.freeGate(key, machine.now());

      if ("held" in result) return yield* fail(`held by ${str(result.held["fleet"])}, not ${key}`);
      out.out("free\n");
    } else {
      return yield* fail(GATE_USAGE);
    }
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

const APPROVAL_USAGE =
  "usage: fleet fleets approval add --all|--fleets A,B --rule R --ref FLEET/DECISION[:Q<n>] [--by WHO] | approval revoke --ref FLEET/DECISION[:Q<n>] --reason R [--fleets A,B]";

/** `approval add|revoke` and its flags. */
interface ApprovalArgs {
  readonly action: string;
  readonly all: boolean;
  readonly values: ReadonlyMap<string, string>;
}

function approvalArgs(argv: readonly string[]): ApprovalArgs | undefined {
  const [action] = argv;

  if (action !== "add" && action !== "revoke") return undefined;
  const values = new Map<string, string>();
  let all = false;

  for (let i = 1; i < argv.length; ) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1];

    if (flag === "--all") {
      all = true;
      i += 1;
    } else if (["--fleets", "--rule", "--ref", "--by", "--reason"].includes(flag) && value !== undefined) {
      values.set(flag.slice(2), value);
      i += 2;
    } else {
      return undefined;
    }
  }

  return { action, all, values };
}

/** The served fleets an approval goes to: every one, or those `names` lists (ids or aliases, comma-separated). */
function targets(machine: Machine, names: string | undefined): Effect.Effect<Entry[], Refusal> {
  return Effect.gen(function* () {
    const entries = machine.registry.live();

    if (names === undefined) return entries;
    const found: Entry[] = [];

    for (const n of new Set(names.split(",").map((x) => x.trim()).filter((x) => x !== ""))) {
      const e = entries.find((x) => x.id === n) ?? entries.find((x) => x.aliases.includes(n));

      if (e === undefined) return yield* fail(`no fleet '${n}' is being served; \`fleet fleets list\` names the ones that are`);

      if (!found.includes(e)) found.push(e);
    }

    if (found.length === 0) return yield* fail("--fleets names no fleet: --fleets A,B");

    return found;
  });
}

/** The fleet the registry knows by `name` (its id, else an alias), served or not. */
function knownFleet(entries: readonly Entry[], name: string): Entry | undefined {
  return entries.find((x) => x.id === name) ?? entries.find((x) => x.aliases.includes(name));
}

/** The fleets a revoke reaches: every fleet the registry knows whose DIR is there, served or stopped
 * (`Registry.known`), or those `names` lists. */
function revokeTargets(machine: Machine, names: string | undefined): Effect.Effect<Entry[], Refusal> {
  return Effect.gen(function* () {
    const entries = machine.registry.known();

    if (names === undefined) return entries.filter((e) => isDir(e.dir));
    const found: Entry[] = [];

    for (const n of new Set(names.split(",").map((x) => x.trim()).filter((x) => x !== ""))) {
      const e = knownFleet(entries, n);

      if (e === undefined) return yield* fail(`no fleet '${n}' is known to the registry; \`fleet fleets list\` names the ones served`);

      if (!found.includes(e)) found.push(e);
    }

    if (found.length === 0) return yield* fail("--fleets names no fleet: --fleets A,B");

    return found;
  });
}

/** One state command on the fleet at `dir` (its page rendered quietly): whether it took, and its refusal. */
function stateOn(dir: string, ...argv: string[]): Effect.Effect<readonly [boolean, string], never, World> {
  return Effect.gen(function* () {
    const recording = recordingOut();
    const code = yield* stateCli([dir, ...argv, "-q"]).pipe(Effect.provide(recording.layer));
    const said = recording.recorded.stderr.join("").split("\n").filter((x) => x.trim() !== "");
    const last = said.at(-1);

    return [code === 0, last === undefined ? `exit ${String(code)}` : last.replace(/^state: /u, "")] as const;
  });
}

/** The approvals of the ledger at `dir`. */
function approvalsAt(dir: string): Approval[] | undefined {
  const ledger = Option.getOrUndefined(parseLedger(readText(join(dir, "state.json")) ?? ""));

  return ledger === undefined || ledger instanceof Refusal ? undefined : (ledger.approvals ?? []);
}

/** `approval add` the same standing approval to every served fleet (or those listed), or `approval revoke` it
 * everywhere: one line per fleet; a refusal by any fleet fails the command after the others are done. */
function approval(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out | World> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const say = (line: string): void => out.out(`${line}\n`);
    const given = approvalArgs(argv);

    if (given === undefined) return yield* fail(APPROVAL_USAGE);
    const ref = given.values.get("ref") ?? "";
    const parsed = parseSource(ref);

    if (parsed?.fleet === undefined) return yield* fail("--ref names the decision and the fleet whose ledger holds it: FLEET/DECISION[:Q<n>] (manager/G5:Q1)");
    const { question } = parsed;
    let refused = false;

    if (given.action === "add") {
      if (!given.all && !given.values.has("fleets")) return yield* fail("approval add goes to every served fleet (--all) or to those named (--fleets A,B)");
      const rule = given.values.get("rule") ?? "";

      if (rule.trim() === "") return yield* fail("approval add needs --rule: what the approval covers, in the user's words");
      const src = approvalSource(machine, "", undefined, ref);

      if (src instanceof NoSource) return yield* fail(src.why);
      const by = (given.values.get("by") ?? "").trim() || (src.author ?? "user");

      for (const e of yield* targets(machine, given.values.get("fleets"))) {
        const rows = approvalsAt(e.dir);

        if (rows === undefined) {
          say(`${e.id}: refused, no ledger at ${join(e.dir, "state.json")}`);
          refused = true;
          continue;
        }

        const local = resolvePath(e.dir) === resolvePath(src.dir) ? src.id : undefined;
        const had = rows.find((a) => sameSource(a, src.ref, question, local));

        if (had !== undefined) {
          say(`${e.id}: skipped, ${had.id} already comes from ${src.label} (${had.status})`);
          continue;
        }

        const k = `K${String(Math.max(0, ...rows.flatMap((a) => (/^K[0-9]+$/u.test(a.id) ? [Number(a.id.slice(1))] : []))) + 1)}`;
        const [took, why] = yield* stateOn(e.dir, "approval", "add", k, "--rule", rule, "--by", by, "--ref", ref);
        const raced = took ? undefined : (approvalsAt(e.dir) ?? []).find((a) => sameSource(a, src.ref, question, local));

        if (raced !== undefined) say(`${e.id}: skipped, ${raced.id} already comes from ${src.label} (${raced.status})`);
        else say(took ? `${e.id}: added ${k}` : `${e.id}: refused, ${why}`);
        refused ||= !took && raced === undefined;
      }
    } else {
      const reason = given.values.get("reason") ?? "";

      if (reason.trim() === "") return yield* fail('approval revoke needs --reason: why, or where the user said it ("revoked on the page (#21)")');

      if (given.values.has("rule") || given.values.has("by")) return yield* fail(APPROVAL_USAGE);
      const reached = yield* revokeTargets(machine, given.values.get("fleets"));
      const source = knownFleet(machine.registry.known(), parsed.fleet);
      const ledger = source === undefined ? undefined : Option.getOrUndefined(parseLedger(readText(join(source.dir, "state.json")) ?? ""));
      const d = ledger === undefined || ledger instanceof Refusal ? undefined : findDecision(ledger, parsed.key);
      const canonical = source !== undefined && d !== undefined ? `${source.id}/${d.ref !== undefined && d.ref !== "" ? d.ref : d.id}` : undefined;
      const refs = [`${parsed.fleet}/${parsed.key}`, ...(canonical === undefined ? [] : [canonical])];
      const label = (canonical ?? `${parsed.fleet}/${parsed.key}`) + (question === undefined ? "" : `:${question.toUpperCase()}`);

      const unreached: string[] = [];

      for (const e of reached) {
        const local = d !== undefined && source !== undefined && resolvePath(e.dir) === resolvePath(source.dir) ? d.id : undefined;
        const rows = approvalsAt(e.dir);

        if (rows === undefined) {
          say(`${e.id}: not reached, no ledger at ${join(e.dir, "state.json")}`);
          unreached.push(e.id);
          continue;
        }

        const mine = rows.filter((a) => a.status === "active" && refs.some((r) => sameSource(a, r, question, local)));

        if (mine.length === 0) say(`${e.id}: none active from ${label}`);

        for (const a of mine) {
          const [took, why] = yield* stateOn(e.dir, "approval", "revoke", a.id, "--reason", reason);
          say(took ? `${e.id}: revoked ${a.id}` : `${e.id}: not reached, ${why}`);

          if (!took && !unreached.includes(e.id)) unreached.push(e.id);
        }
      }

      if (unreached.length > 0) {
        out.err(`fleets: not reached: ${unreached.join(", ")}; the approval is still active there\n`);
        refused = true;
      }
    }

    return refused ? 1 : 0;
  });
}

function runCommand(machine: Machine, argv: readonly string[]): Effect.Effect<void | number, Refusal, Out | World> {
  const [cmd, a = "", b = ""] = argv;

  if (argv.length === 1 && cmd === "list") return list(machine);

  if (argv.length === 1 && cmd === "manager") return manager(machine);

  if (argv.length === 1 && cmd === "waiting") return waiting(machine);

  if (cmd === "gate") return gate(machine, argv.slice(1));

  if (argv.length === 1 && cmd === "procs") return procs(machine);

  if (cmd === "whose") return whose(machine, argv.slice(1));

  if (argv.length === 2 && cmd === "show") return show(machine, a);

  if (argv.length === 3 && cmd === "decision") return decision(machine, a, b);

  if (argv.length === 3 && cmd === "name") return name(machine, a, b);

  if (cmd === "approval") return approval(machine, argv.slice(1));

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
