/**
 * The machine's gate (`REGISTRY/gate/`): the heavy checks of every fleet share one memory budget. A hold takes a
 * part of the budget (its cap, in bytes) or all of it (a hold taken by hand, or one an older fleet wrote), and is
 * admitted when the caps of the holds plus its own fit the budget. Whoever does not fit waits in a queue and is
 * admitted in order of arrival: only the head of the queue may take, so a large ask is never passed by smaller
 * ones that would fit. A hold lapses at its `until`, a fleet's when the fleet is no longer served, a run's when
 * its runner is gone; a waiter leaves the queue when its process is gone or its own `--wait` has run out. Every
 * change runs under an exclusive `flock` of `gate.lock`, so two takers never both pass the budget.
 *
 * Three files: `gate.json` (the holds), `queue.json` (the waiters, in order), `runs.jsonl` (one line per finished
 * `gate run`). `gate.json` is read by older fleets too (a `gate run` in flight, a hub, the plugin's hook), which
 * know one hold, `{fleet, kind, what, since, until, token[, pid]}`. One hold of the whole budget taken by hand is
 * written in that form, unchanged. Anything else is written as a summary in that form, without a token (held, by
 * nobody an older fleet can join or free, until the last hold's `until`) that carries the holds in `holds`: an older
 * fleet reads the gate as held for as long as any hold lives.
 *
 * What keeps the memory within the budget whoever asks: each hold records the budget its taker read, and an ask is
 * admitted against the smallest of its own and the holds'; a run's hold lives as long as its runner, whatever the
 * registry says of its fleet, and only its runner frees it; a hold taken by hand is a run's for as long as a run
 * goes under it.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";

import { parseInstant, stampOf } from "./clock.ts";
import { exists, makeDirs, readText, remove, writeAtomic, writeText } from "./files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseObject, type Json, type JsonObject } from "./json.ts";
import { withExclusiveLock } from "./lock.ts";
import { startedOf } from "./procs.ts";
import { alive, pidOf, readObject, type Registry } from "./registry.ts";

import * as Option from "effect/Option";

/** The share of the RAM all holds together may take when $FLEET_GATE_MEMORY_BUDGET does not say. */
export const DEFAULT_BUDGET = "50%";

/** The share of the RAM one run may use when neither `--mem` nor $FLEET_GATE_MEMORY_MAX says: two fit the budget. */
export const DEFAULT_CAP = "25%";

/** Seconds a waiter stays in the queue past its own `--wait` before anyone may drop it (a stopped waiter). */
const WAIT_GRACE_S = 10;

/** The least memory a cap or a budget may be: under it nothing runs, and a share that rounds to no bytes is a mistake. */
export const MIN_CAP = 64 * 1024 ** 2;

/** How many lines `runs.jsonl` keeps: past twice this, the oldest are dropped. */
const RUNS_KEPT = 1000;

/** The machine's RAM in bytes: /proc/meminfo's MemTotal, else what the runtime says (the Mac). */
export function memTotal(): number {
  try {
    const kb = /^MemTotal:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];

    if (kb !== undefined) return Number(kb) * 1024;
  } catch {
    // not Linux
  }

  return totalmem();
}

const UNITS = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 } as const;

function unitScale(unit: string): number {
  return Object.entries(UNITS).find(([u]) => u === unit)?.[1] ?? 1;
}

/** The bytes `spec` names (`50%` of `total`, `24G`, `512M`, a byte count), or undefined when it does not parse or
 * names less than {@link MIN_CAP}. */
export function capBytes(spec: string, total: number | undefined): number | undefined {
  const share = /^(\d+(?:\.\d+)?)%$/.exec(spec);
  const size = /^(\d+(?:\.\d+)?)([KMGT]?)i?B?$/i.exec(spec);
  let bytes: number | undefined;

  if (share !== null) {
    const pct = Number(share[1]);

    bytes = total === undefined || pct <= 0 || pct > 100 ? undefined : Math.floor((total * pct) / 100);
  } else if (size !== null) {
    bytes = Math.floor(Number(size[1]) * unitScale((size[2] ?? "").toUpperCase()));
  }

  return bytes !== undefined && bytes >= MIN_CAP ? bytes : undefined;
}

/** `text` on one line: each run of control characters and line separators is a space. A name or a label someone
 * gave never starts a line of its own in what the gate prints. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex -- the control characters are what is removed
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
}

/** `bytes` as people read it: `31.0G`. */
export function sizeText(bytes: number): string {
  for (const unit of ["T", "G", "M", "K"]) {
    const scale = unitScale(unit);

    if (bytes >= scale) return `${(bytes / scale).toFixed(1)}${unit}`;
  }

  return `${bytes}B`;
}

/** The memory all holds together may take. */
export interface Budget {
  /** As it was given: `50%`, `24G`. */
  readonly spec: string;
  readonly bytes: number;
}

/** The budget $FLEET_GATE_MEMORY_BUDGET names, else half the RAM; undefined when it does not parse. */
export function budgetOf(env: (name: string) => string | undefined): Budget | undefined {
  const given = env("FLEET_GATE_MEMORY_BUDGET")?.trim();
  const spec = given === undefined || given === "" ? DEFAULT_BUDGET : given;
  const bytes = capBytes(spec, memTotal());

  return bytes === undefined ? undefined : { spec, bytes };
}

/** Who takes the gate: a served fleet, or a session or worker by the name it gives (`--as`). */
export interface GateHolder {
  readonly name: string;
  readonly kind: "fleet" | "session";
}

/** One hold of the gate. */
export interface Hold extends GateHolder {
  readonly what: string;
  readonly since: string;
  readonly until: string | undefined;
  /** What `gate free` takes. */
  readonly token: string | undefined;
  /** Bytes of the budget it takes; undefined is all of it (taken by hand without `--mem`, by a run that has no
   * scope to cap it, or by an older fleet). */
  readonly cap: number | undefined;
  /** The budget's bytes as its taker read it; undefined when an older fleet took it. */
  readonly budget: number | undefined;
  /** The `gate run` that took it: the hold lives as long as that process (and its scope), and only it frees the hold. */
  readonly pid: number | undefined;
  /** The systemd user scope its run's command is in (`<unit>.scope`), when the run has one: the hold lives while
   * that scope does, though its runner is gone. */
  readonly unit: string | undefined;
  /** The `gate run` running under it, when it was taken by hand. */
  readonly runner: number | undefined;
  /** The systemd user scope that run's command is in, when it has one: the run goes for as long as the scope does. */
  readonly runnerUnit: string | undefined;
  /** The hold as gate.json has it. */
  readonly raw: JsonObject;
}

/** One process waiting for the gate. */
export interface Waiter extends GateHolder {
  readonly what: string;
  readonly cap: number | undefined;
  /** When it arrived. */
  readonly since: string;
  /** When its own `--wait` runs out, with a grace: past it, it is dropped. */
  readonly until: string;
  readonly pid: number;
  readonly started: string | undefined;
}

/** What a process asks of the gate. */
export interface Ask {
  readonly holder: GateHolder;
  readonly what: string;
  /** Seconds the hold lasts. */
  readonly seconds: number;
  /** Bytes of the budget it asks for; undefined is all of it. */
  readonly cap: number | undefined;
  /** The budget's bytes, as the asker reads it. */
  readonly budget: number;
  /** The process that asks, and waits. */
  readonly pid: number;
  /** Whether the hold lapses with that process (`gate run`), or stays until freed (`gate take`). */
  readonly runs: boolean;
  /** Seconds it is ready to wait; 0 never joins the queue. */
  readonly waitS: number;
}

/** Why an ask was not admitted: who holds, and who is before it in the queue. */
export interface Waiting {
  readonly holders: readonly Hold[];
  readonly ahead: readonly Waiter[];
}

/** The gate at an instant. */
export interface Standing {
  readonly holders: readonly Hold[];
  readonly queue: readonly Waiter[];
}

/** The bytes all holds together may take when an asker reads the budget as `budget`: the smallest of it and of the
 * budgets the holders read. One caller that reads a larger budget cannot widen it beside the others. */
export function roomOf(budget: number, holders: readonly Hold[]): number {
  return Math.min(budget, ...holders.flatMap((h) => h.budget ?? []));
}

/** One finished `gate run`, a line of `runs.jsonl`. */
export interface RunRecord {
  /** When it ended. */
  readonly at: string;
  readonly name: string;
  readonly kind: "fleet" | "session";
  /** The command's first words. */
  readonly what: string;
  /** The cap it asked for, as given (`25%`, `24G`), and in bytes. */
  readonly asked: string;
  readonly cap: number;
  /** Seconds it waited for the gate. */
  readonly waited: number;
  /** Seconds the command ran; null when it gave up waiting and never ran. */
  readonly ran: number | null;
  readonly code: number;
  /** The most memory its scope held, in bytes; null where there was no scope. */
  readonly peak: number | null;
  /** How many processes the cap killed. */
  readonly killed: number;
}

/** The last day's runs in numbers. */
export interface Day {
  readonly runs: number;
  readonly gaveUp: number;
  readonly medianWait: number;
  readonly p90Wait: number;
  readonly maxPeak: number | undefined;
  /** Runs in which the cap killed a process. */
  readonly capped: number;
}

/** The scope `value` names. A unit's name is the gate's own (a token and a pid): anything else in the file names no scope. */
function unitOf(value: Json | undefined): string | undefined {
  const unit = asString(value);

  return unit !== undefined && /^fleet-gate-[0-9a-f]+-[0-9]+$/.test(unit) ? unit : undefined;
}

function holdOf(raw: JsonObject): Hold {
  return {
    name: asString(raw["fleet"]) ?? "",
    kind: raw["kind"] === "session" ? "session" : "fleet",
    what: asString(raw["what"]) ?? "",
    since: asString(raw["since"]) ?? "",
    until: asString(raw["until"]),
    token: asString(raw["token"]),
    cap: asNumber(raw["cap"]),
    budget: asNumber(raw["budget"]),
    pid: pidOf(raw["pid"]),
    unit: unitOf(raw["unit"]),
    runner: pidOf(raw["runner"]),
    runnerUnit: unitOf(raw["runner_unit"]),
    raw,
  };
}

function waiterOf(raw: JsonObject): Waiter | undefined {
  const name = asString(raw["fleet"]);
  const pid = pidOf(raw["pid"]);

  if (name === undefined || pid === undefined) return undefined;

  return {
    name,
    kind: raw["kind"] === "session" ? "session" : "fleet",
    what: asString(raw["what"]) ?? "",
    cap: asNumber(raw["cap"]),
    since: asString(raw["since"]) ?? "",
    until: asString(raw["until"]) ?? "",
    pid,
    started: asString(raw["started"]),
  };
}

/** `raw` with `key` set to `value`, or `raw` itself when there is no value. */
function plus(raw: JsonObject, key: string, value: Json | undefined): JsonObject {
  return value === undefined ? raw : { ...raw, [key]: value };
}

/** A hold taken by hand as it is with no run under it: `raw` without a runner's mark. */
function unmarked(raw: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "runner" && key !== "runner_started" && key !== "runner_unit"));
}

function waiterJson(w: Waiter): JsonObject {
  return plus(plus({ fleet: w.name, kind: w.kind, what: w.what, since: w.since, until: w.until, pid: w.pid }, "cap", w.cap), "started", w.started);
}

/** Whether the process `pid` that started at `started` still runs: a later process with its pid is another. */
function running(pid: number, started: string | undefined): boolean {
  return alive(pid) && (started === undefined || startedOf(pid) === started);
}

/** Whether the transient scope `unit` of the systemd user manager still has processes: its cgroup is there. */
export function scopeLives(unit: string): boolean {
  const uid = String(process.getuid?.() ?? "");

  return exists(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}.scope`);
}

/** Whether a `gate run` goes under `hold`, one taken by hand: its runner is that process still, or its scope is there. */
function runnerLives(hold: Hold): boolean {
  return (hold.runner !== undefined && running(hold.runner, asString(hold.raw["runner_started"]))) || (hold.runnerUnit !== undefined && scopeLives(hold.runnerUnit));
}

/** The command that ends the run of `hold` (its own, or the one under a hold taken by hand), every process it
 * started with it: its scope stopped by name when it has one, else its runner killed while that pid is still the
 * process that took the hold (a later process with its pid is not). Undefined when there is nothing left to stop. */
export function endOf(hold: Hold): string | undefined {
  const unit = hold.unit ?? hold.runnerUnit;

  if (unit !== undefined) return `systemctl --user stop ${unit}.scope`;
  const pid = hold.pid ?? hold.runner;

  return pid !== undefined && running(pid, asString(hold.raw[hold.pid === undefined ? "runner_started" : "started"])) ? `kill ${String(pid)}` : undefined;
}

function short(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** `stamps` from the earliest to the latest. */
function inOrder(stamps: readonly string[]): string[] {
  return stamps.toSorted((a, b) => (parseInstant(a) ?? 0) - (parseInstant(b) ?? 0));
}

/** What gate.json holds for `holds` (one at least): the hold itself when it is one hold of the whole budget taken
 * by hand, as older fleets wrote it; else a summary in that form with the holds in `holds`. An older fleet reads the
 * summary as one hold by a session, with no runner to check, a name no hold has and no token (it frees by a token
 * that is the file's, so a summary with one could be freed whole while its runs live), until the last hold lapses:
 * held while any hold lives, and nothing it can join, free or take over. A run's hold is never written bare:
 * an older fleet drops a fleet's hold with its fleet, and a run lives as long as its runner. */
function fileOf(holds: readonly Hold[]): JsonObject {
  const [only] = holds;

  // Bare: taken by hand, or a run's hold an older fleet wrote (it records no budget) and will free by its own token.
  if (holds.length === 1 && only !== undefined && only.cap === undefined && (only.pid === undefined || only.budget === undefined)) return only.raw;
  const untils = holds.flatMap((h) => (h.until === undefined ? [] : [h.until]));

  const summary: JsonObject = {
    fleet: holds.map((h) => `${plain(h.name)} (${h.cap === undefined ? "all" : sizeText(h.cap)})`).join(" + "),
    kind: "session",
    what: holds.map((h) => plain(h.what)).join(" | "),
    since: inOrder(holds.map((h) => h.since))[0] ?? "",
    v: 2,
    holds: holds.map((h) => h.raw),
  };

  // A hold without an `until` never lapses by the clock, so neither does the summary.
  return untils.length === holds.length ? plus(summary, "until", inOrder(untils).at(-1)) : summary;
}

/** The value at share `p` of `sorted` (ascending), by nearest rank. */
function rank(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

/** `hold` in words: `held by ui (no fleet) since S, until U, cap 15.5G: what`. A hold of the whole budget names no cap. */
export function holdText(hold: Hold): string {
  const who = hold.kind === "session" ? `${plain(hold.name)} (no fleet)` : plain(hold.name);
  const until = hold.until === undefined || hold.until === "" ? "" : `, until ${plain(hold.until)}`;
  const cap = hold.cap === undefined ? "" : `, cap ${sizeText(hold.cap)}`;

  return `held by ${who} since ${plain(hold.since)}${until}${cap}: ${plain(hold.what)}`;
}

/** The gate of the machine whose registry is `registry`. */
export function gateOf(registry: Registry): Gate {
  return new Gate(join(registry.place.home, "gate"), () => registry.live().map((e) => e.id));
}

export class Gate {
  private readonly dir: string;

  private readonly served: () => readonly string[];

  /** The gate kept in `dir`; `served` names the fleets served now (a fleet's hold lapses with its fleet). */
  constructor(dir: string, served: () => readonly string[]) {
    this.dir = dir;
    this.served = served;
  }

  private path(name: "gate.json" | "queue.json" | "runs.jsonl" | "gate.lock"): string {
    return join(this.dir, name);
  }

  /** Run `body` under the gate's lock, so a take, a release, a queue change and a lapsed hold's removal never interleave. */
  private locked<T>(body: () => T): T {
    makeDirs(this.dir);
    const fd = openSync(this.path("gate.lock"), "a+");

    try {
      return withExclusiveLock(fd, body);
    } finally {
      closeSync(fd);
    }
  }

  private holdsRead(): Hold[] {
    const raw = readObject(this.path("gate.json"));

    if (raw === undefined) return [];

    const several = (asArray(raw["holds"]) ?? []).flatMap((h) => {
      const hold = asObject(h);

      return hold === undefined ? [] : [holdOf(hold)];
    });

    // A file whose `holds` this fleet cannot read is one hold of the whole budget: what its top says.
    return several.length > 0 ? several : [holdOf(raw)];
  }

  private queueRead(): Waiter[] {
    return (asArray(readObject(this.path("queue.json"))?.["waiters"]) ?? []).flatMap((w) => {
      const waiter = waiterOf(asObject(w) ?? {});

      return waiter === undefined ? [] : [waiter];
    });
  }

  private holding(hold: Hold, now: Date): boolean {
    const until = parseInstant(hold.until ?? "");

    if (until !== undefined && now.getTime() >= until) return false;

    // A run lives as long as its runner, and then as long as its scope: its fleet's entry may go or be renamed, its
    // runner and the watchdog may be killed, while the suite still holds its memory.
    if (hold.pid !== undefined) return running(hold.pid, asString(hold.raw["started"])) || (hold.unit !== undefined && scopeLives(hold.unit));

    // So does a hold taken by hand, for as long as a run goes under it.
    return hold.kind === "session" || runnerLives(hold) || this.served().includes(hold.name);
  }

  /** What the files say at `now`, and whether they keep a lapsed hold or a waiter that is gone. */
  private read(now: Date): Standing & { readonly lapsed: boolean } {
    const holds = this.holdsRead();
    const waiters = this.queueRead();
    const holders = holds.filter((h) => this.holding(h, now));

    const queue = waiters.filter((w) => {
      const until = parseInstant(w.until);

      return running(w.pid, w.started) && (until === undefined || now.getTime() < until);
    });

    return { holders, queue, lapsed: holders.length < holds.length || queue.length < waiters.length };
  }

  private keepHolds(holders: readonly Hold[]): void {
    if (holders.length === 0) remove(this.path("gate.json"));
    else writeAtomic(this.path("gate.json"), dumps(fileOf(holders)));
  }

  private keepQueue(queue: readonly Waiter[]): void {
    if (queue.length === 0) remove(this.path("queue.json"));
    else writeAtomic(this.path("queue.json"), dumps({ waiters: queue.map(waiterJson) }));
  }

  /** The gate at `now`, read under the lock, with what lapsed removed from the files. */
  private settled(now: Date): Standing {
    const found = this.read(now);

    if (found.lapsed) {
      this.keepHolds(found.holders);
      this.keepQueue(found.queue);
    }

    return found;
  }

  /** Who holds the gate at `now` and who waits, in order. What lapsed is removed. */
  standing(now: Date): Standing {
    const found = this.read(now);

    return found.lapsed ? this.locked(() => this.settled(now)) : found;
  }

  /** gate.json's content at `now` (one hold, or the summary of several), or undefined when the gate is free. */
  head(now: Date): JsonObject | undefined {
    const { holders } = this.standing(now);

    return holders.length === 0 ? undefined : fileOf(holders);
  }

  /** `ask` takes its part of the budget when it is first in line and fits beside the holds: the hold it made. Else
   * who is in its way; an ask ready to wait (`waitS`) then has its place in the queue, kept across calls by its pid. */
  ask(ask: Ask, now: Date): { readonly took: Hold } | { readonly waiting: Waiting } {
    return this.locked(() => {
      const { holders, queue } = this.settled(now);
      const at = queue.findIndex((w) => w.pid === ask.pid);
      const ahead = at < 0 ? queue : queue.slice(0, at);
      const used = holders.reduce((sum, h) => sum + (h.cap ?? Infinity), 0);
      const fits = ask.cap === undefined ? holders.length === 0 : used + ask.cap <= roomOf(ask.budget, holders);
      const since = stampOf(now);

      if (ahead.length === 0 && fits) {
        const made = this.made(ask, since, now, holders);

        this.keepHolds([...holders, made]);

        if (at >= 0) this.keepQueue(queue.filter((w) => w.pid !== ask.pid));

        return { took: made };
      }

      if (at < 0 && ask.waitS > 0) {
        const waiter: Waiter = {
          name: plain(ask.holder.name),
          kind: ask.holder.kind,
          what: plain(ask.what),
          cap: ask.cap,
          since,
          until: stampOf(new Date(now.getTime() + (ask.waitS + WAIT_GRACE_S) * 1000)),
          pid: ask.pid,
          started: startedOf(ask.pid),
        };

        this.keepQueue([...queue, waiter]);
      }

      return { waiting: { holders, ahead } };
    });
  }

  private made(ask: Ask, since: string, now: Date, holders: readonly Hold[]): Hold {
    const base = `${plain(ask.holder.name)}\n${plain(ask.what)}\n${since}`;
    let token = short(base);

    for (let n = 2; holders.some((h) => h.token === token); n += 1) token = short(`${base}\n${String(n)}`);

    const hold: JsonObject = {
      fleet: plain(ask.holder.name),
      kind: ask.holder.kind,
      what: plain(ask.what),
      since,
      until: stampOf(new Date(now.getTime() + ask.seconds * 1000)),
      token,
    };

    // One hold of the whole budget taken by hand stays the six keys every fleet has written; the rest say more.
    if (!ask.runs && ask.cap === undefined) return holdOf(hold);
    const run = ask.runs ? plus({ ...hold, pid: ask.pid }, "started", startedOf(ask.pid)) : hold;
    // A run with a cap is a run in a scope (without one it asks for the whole budget): the scope's name is the hold's.
    const scoped = ask.runs && ask.cap !== undefined ? { ...run, unit: `fleet-gate-${token}-${String(ask.pid)}` } : run;

    return holdOf(plus({ ...scoped, budget: ask.budget }, "cap", ask.cap));
  }

  /** The process `pid` gives up its place in the queue. */
  leave(pid: number, now: Date): void {
    this.locked(() => {
      const { queue } = this.settled(now);

      if (queue.some((w) => w.pid === pid)) this.keepQueue(queue.filter((w) => w.pid !== pid));
    });
  }

  /** `gate run` as `name` runs under a hold `name` took by hand, as runner `pid`: one run per hold. `joined` is that
   * hold; `busy` the hold whose run is still going; undefined when `name` holds nothing by hand that still lasts
   * `leastS` seconds (a run cannot outlive the hold it runs under). A dead runner's mark, or one whose pid a later
   * process has, is taken over once its scope is gone too. `unit` is the scope the run's command will be in: the
   * hold keeps it, so the run is counted while that scope lives, whatever becomes of its runner. */
  join(name: string, pid: number, now: Date, leastS: number, unit?: string): { readonly joined: Hold } | { readonly busy: Hold } | undefined {
    return this.locked(() => {
      const { holders } = this.settled(now);

      const mine = holders.filter((h) => {
        const until = parseInstant(h.until ?? "");

        return plain(h.name) === plain(name) && h.pid === undefined && (until === undefined || until - now.getTime() >= leastS * 1000);
      });

      const open = mine.find((h) => h.runner === pid || !runnerLives(h));
      const [busy] = mine;

      if (open === undefined) return busy === undefined ? undefined : { busy };
      const joined = holdOf(plus(plus({ ...unmarked(open.raw), runner: pid }, "runner_started", startedOf(pid)), "runner_unit", unit));

      this.keepHolds(holders.map((h) => (h === open ? joined : h)));

      return { joined };
    });
  }

  /** Runner `pid` leaves the hold it joined: the hold stays its taker's, open to the next run. */
  unjoin(pid: number, now: Date): void {
    this.locked(() => {
      const { holders } = this.settled(now);

      if (!holders.some((h) => h.runner === pid)) return;

      this.keepHolds(holders.map((h) => (h.runner === pid ? holdOf(unmarked(h.raw)) : h)));
    });
  }

  /** Free the holds `key` names, by token or (as before tokens) by holder's name. A run's hold is freed only by
   * its runner (`runner`, its pid), and a hold taken by hand by nobody while a run goes under it: the run still
   * holds its memory, so the release is refused with the holds that are `running`, to stop the run instead. Refused
   * with the holders (`held`) when none of the holds is `key`'s. */
  free(key: string, now: Date, runner?: number): { readonly freed: true } | { readonly held: readonly Hold[] } | { readonly running: readonly Hold[] } {
    return this.locked(() => {
      const { holders } = this.settled(now);
      const named = holders.filter((h) => h.token === key || plain(h.name) === plain(key));
      const going = named.filter((h) => (h.pid === undefined ? runnerLives(h) : h.pid !== runner));

      if (holders.length > 0 && named.length === 0) return { held: holders };

      if (named.length > 0 && going.length === named.length) return { running: going };

      this.keepHolds(holders.filter((h) => !named.includes(h) || going.includes(h)));

      return { freed: true };
    });
  }

  /** Keep `run` in `runs.jsonl`. */
  record(run: RunRecord): void {
    this.locked(() => {
      const path = this.path("runs.jsonl");

      appendFileSync(path, `${dumps({ ...run })}\n`, "utf8");
      const lines = (readText(path) ?? "").split("\n").filter((line) => line !== "");

      if (lines.length > RUNS_KEPT * 2) writeText(path, `${lines.slice(-RUNS_KEPT).join("\n")}\n`);
    });
  }

  /** The runs that ended in the day before `now`, in numbers; undefined when there were none. */
  day(now: Date): Day | undefined {
    const path = this.path("runs.jsonl");

    if (!exists(path)) return undefined;
    const from = now.getTime() - 24 * 3600 * 1000;

    const runs = (readText(path) ?? "").split("\n").flatMap((line) => {
      const run = Option.getOrUndefined(parseObject(line));
      const at = parseInstant(asString(run?.["at"]) ?? "");

      return run === undefined || at === undefined || at < from || at > now.getTime() ? [] : [run];
    });

    if (runs.length === 0) return undefined;
    const waits = runs.map((r) => asNumber(r["waited"]) ?? 0).toSorted((a, b) => a - b);
    const peaks = runs.flatMap((r) => asNumber(r["peak"]) ?? []);

    return {
      runs: runs.filter((r) => r["ran"] !== null).length,
      gaveUp: runs.filter((r) => r["ran"] === null).length,
      medianWait: rank(waits, 0.5),
      p90Wait: rank(waits, 0.9),
      maxPeak: peaks.length === 0 ? undefined : Math.max(...peaks),
      capped: runs.filter((r) => (asNumber(r["killed"]) ?? 0) > 0).length,
    };
  }
}
