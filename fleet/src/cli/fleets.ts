/**
 * `fleet fleets …` (Python's `fleets.py` CLI): the fleets served on this machine, what waits on the user, one fleet, the manager,
 * a decision in full, the gate, background processes, whose files a landing moves, and naming a fleet.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { listening, oneLine } from "../chat/chat.ts";
import { firstLine } from "../chat/news.ts";
import { readChat } from "../chat/store.ts";
import { Refusal } from "../errors.ts";
import { exists, readText } from "../files.ts";
import { answeredAt, silentWorkers } from "../health.ts";
import { Out } from "../io.ts";
import { asArray, asNumber, asObject, asString, pyRepr, truthy, type Json, type JsonObject } from "../json.ts";
import { decodeLedger } from "../ledger/model.ts";
import { find, number } from "../ledger/numbers.ts";
import { processes } from "../procs.ts";
import { stateOf, type GateHolder } from "../registry.ts";
import { activeAt, spentBy } from "../transcripts.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";

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

function commas(n: number): string {
  const [whole = "0", frac] = String(Math.abs(n)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${n < 0 ? "-" : ""}${grouped}${frac === undefined ? "" : `.${frac}`}`;
}

function list(machine: Machine): Effect.Effect<void, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const say = (line: string): void => out.out(`${line}\n`);
    const entries = machine.registry.live();

    if (entries.length === 0) say("no fleet is being served on this machine");

    for (const e of entries) {
      const raw = stateOf(e);
      const state = raw === undefined ? {} : numbered(raw);
      const status = raw !== undefined && truthy(raw["status"]) ? str(raw["status"]) : "unknown";
      say(`${e.id}  ${e.role}  session ${e.session ?? "(not named yet)"}  ${status}  ${e.url}  ${e.dir}`);
      const now = truthy(state["now"]) ? str(state["now"]) : "";

      if (now !== "") say(`    now: ${now}`);
      const agents = rows(state, "agents");

      const lanes = [
        ...new Set(
          agents
            .filter((a) => a["status"] === "running" || a["status"] === "blocked" || a["status"] === "queued")
            .flatMap((a) => (asArray(a["lane"]) ?? []).map((l) => str(l))),
        ),
      ].sort();

      if (lanes.length > 0) say(`    lanes in flight: ${lanes.join(", ")}`);
      const active = activeAt(e.dir, machine.config);

      if (active !== undefined) say(`    session last active ${active}`);

      for (const w of silentWorkers(machine, e.dir, state)) say(`    worker ${w.id} (${w.name}) silent since ${w.active.slice(11, 16)}`);
      const heard = listening(machine, e.dir);

      if (!heard.on) {
        say(
          "    chat: not read now" +
            (heard.unread > 0 ? `; ${heard.unread} message(s) from the user wait since #${heard.seen}` : ""),
        );
      }

      const spent = spentBy(e.dir, machine.config);

      if (spent !== undefined) {
        const tokens = agents.reduce((sum, a) => sum + Math.trunc(asNumber(a["tokens"]) ?? 0), 0);
        say(
          `    tokens: its workers ${commas(tokens)}; the ${e.role} itself ${commas(spent.output)} written, ${commas(spent.input)} read`,
        );
      }

      const said = readChat(e.dir);

      for (const d of rows(state, "decisions")) {
        if (d["status"] !== "open" || asString(d["id"]) === undefined) continue;
        const kind = d["kind"] === undefined ? "decision" : str(d["kind"]);

        const marks = [kind, d["asks"] === "manager" ? "for the manager" : "for the user", d["blocking"] === true ? "blocks work" : ""]
          .filter((m) => m !== "")
          .join(", ");

        const ref = truthy(d["ref"]) ? str(d["ref"]) : "";
        const answered = answeredAt(d, said);
        say(
          `    ${ref} ${str(d["id"])} [${marks}] ${str(d["title"])}`.replaceAll("     ", "    ") +
            (answered === undefined ? "" : `  ANSWERED at ${answered.slice(11, 16)}, not recorded`) +
            (truthy(d["held"]) ? `  held by the fleet: ${str(d["held"])}` : ""),
        );
      }
    }
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

function runCommand(machine: Machine, argv: readonly string[]): Effect.Effect<void, Refusal, Out> {
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

  return fail(USAGE);
}

/** Run `fleet fleets` with `argv` (after `fleets`); the exit code. */
export function fleetsCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* runCommand(machine, argv).pipe(Effect.as(0), Effect.catch(exitOf));
  });
}
