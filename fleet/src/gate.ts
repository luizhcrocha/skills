/**
 * The machine's gate (`REGISTRY/gate/`): the heavy checks of every fleet share one memory budget.
 * A hold takes a part of the budget (its cap, in bytes: a run's estimate) or all of it (a hold
 * taken by hand, or one an older fleet wrote), and is admitted when the caps of the holds plus its
 * own fit the budget, and MemAvailable, less what the holds' caps allow them that their scopes do
 * not use yet and less its own cap, still leaves the floor free (`--floor`, else
 * $FLEET_GATE_MEMORY_FLOOR, else 8G): the budget counts the holds alone, and dev servers and
 * sessions use the same memory. Whoever does not fit waits in a queue and is admitted in order of
 * arrival: only the head of the queue may take, so a large ask is never passed by smaller ones
 * that would fit, a waiter that waits for the memory floor alone included (the holds that pass it
 * would keep it short of the floor). A hold lapses at its `until`, a fleet's when the fleet is no
 * longer served, a run's when its runner is gone; a waiter leaves the queue when its process is
 * gone or its own `--wait` has run out. Every change runs under an exclusive `flock` of
 * `gate.lock`, so two takers never both pass the budget.
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
 * registry says of its fleet, and only its runner frees it. A hold taken by hand is its taker's alone: no `gate run`
 * goes under it, its own name's included (that name is often a fleet's, shared by its sessions), and its token always
 * frees it. A `runner` mark an older fleet's run left on one keeps the hold live while that run goes.
 *
 * A second row beside memory, CPUs: a run declares the CPUs it estimates, and the CPUs of the holds plus its own stay
 * within the CPU budget (the machine's CPUs less 8, kept for agents, the hub and dev servers; $FLEET_GATE_CPU_BUDGET).
 * A run's part in both rows is its estimate (gate-run.ts), which decides admission only; what limits a run is its
 * scope's ceiling, the same for every run. A light run (an estimate of 4G at most, and each of its last runs 2 minutes
 * at most) passes the head of the queue only when the head would not be admitted even with every light hold gone, in
 * either row of the budget or by the memory floor: lights never keep a head out, since once they are what blocks it
 * they stop passing and drain.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { availableParallelism, cpus as cpuList, totalmem } from "node:os";
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

/** What MemAvailable, less the part an ask takes, must leave free when neither `--floor` nor $FLEET_GATE_MEMORY_FLOOR says. */
export const DEFAULT_FLOOR = "8G";

/** The least memory a cap or a budget may be: under it nothing runs, and a share that rounds to no bytes is a mistake. */
export const MIN_CAP = 64 * 1024 ** 2;

/** The CPUs the gate keeps out of its budget, for agents, the hub and dev servers, when $FLEET_GATE_CPU_BUDGET does not say. */
export const CPUS_KEPT = 8;

/** A light run's most: its estimate, and how long each of its last runs ran. */
export const LIGHT_CAP = 4 * 1024 ** 3;

export const LIGHT_S = 120;

/** The least estimate a run's peaks give it, the margin over the largest, and how many of its last runs count. */
const LEAST_CAP = 2 * 1024 ** 3;

const PEAK_MARGIN = 1.25;

/** {@link PEAK_MARGIN} in words, for the line that says where an estimate came from. */
export const PEAK_MARGIN_TEXT = `${String(Math.round((PEAK_MARGIN - 1) * 100))}%`;

const RUNS_MEASURED = 3;

const MIB = 1024 ** 2;

/** The estimate a measured peak gives a run: the peak times {@link PEAK_MARGIN}, in whole MiB, {@link LEAST_CAP} at least. */
export function memEstimate(peak: number): number {
  return Math.max(LEAST_CAP, Math.ceil((peak * PEAK_MARGIN) / MIB) * MIB);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** A last word that names a revision: a jj change id (8 to 32 of jj's letters, k to z), or a commit hash (7 to 40 hex
 * digits, one a letter at least: a number is no hash). */
const REVISION = /(?<=\s)(?:[k-z]{8,32}|(?=[0-9]*[a-f])[0-9a-f]{7,40})$/;

/** A command as its history knows it: a session's scratchpad (`.../<uuid>/scratchpad`), any other UUID in it and a last
 * word that names a revision are placeholders, so the same suite run from another session, or a landing gate given
 * the change it lands (`tasks/land-gate mznklkup`), is the same command. */
export function whatKey(what: string): string {
  return what.replace(/(?:\/[^/\s'"=]+)*\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/scratchpad(?=[/\s'"]|$)/gi, "<scratchpad>").replace(UUID, "<uuid>")
    .replace(REVISION, "<rev>");
}

/** A command's family, the same in every workspace of its repository: its {@link whatKey}, with the workspace's root,
 * where it names one, a placeholder (replaced first, so a root under a scratchpad is one too), so `bash <root>/gate-x.sh`
 * run in two workspaces is one family. */
export function familyOf(what: string, workspace: string | undefined): string {
  if (workspace === undefined || workspace === "" || workspace === "/") return whatKey(what);

  const root = workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return whatKey(what.replace(new RegExp(`(?<![^\\s'"=])${root}(?=[/\\s'"]|$)`, "g"), "<workspace>"));
}

/** How far back a run of the same family sizes a run with no history of its own: the day {@link Gate.day} counts. */
const DAY_MS = 24 * 3600 * 1000;

/** How many lines `runs.jsonl` keeps: past twice this, the oldest are dropped. */
const RUNS_KEPT = 1000;

/** Where a setting comes from: the process's environment, or a test's. */
export type Env = (name: string) => string | undefined;

/** The line `key` of /proc/meminfo, or of the file $FLEET_MEMINFO names (a test's), in bytes. */
function meminfo(key: "MemTotal" | "MemAvailable", env: Env): number | undefined {
  const kb = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(readText(env("FLEET_MEMINFO") ?? "/proc/meminfo") ?? "")?.[1];

  return kb === undefined ? undefined : Number(kb) * 1024;
}

/** The machine's RAM in bytes: MemTotal (of $FLEET_MEMINFO's file when `env` names one), else what the runtime says (the Mac). */
export function memTotal(env: Env = () => undefined): number {
  return meminfo("MemTotal", env) ?? totalmem();
}

/** MemAvailable in bytes: /proc/meminfo's, or that of the file $FLEET_MEMINFO names (a test's); undefined where it
 * cannot be read (the Mac), and then the gate counts its budget alone. */
export function memAvailable(env: Env): number | undefined {
  return meminfo("MemAvailable", env);
}

/** The machine's pressure stall averages over the last 10 s, in percent of wall time: a resource's `some` (a task
 * waited) and `full` (all non-idle tasks waited). Logged on a run's record, never gating. */
export type Pressure = Partial<Record<`${"cpu" | "memory" | "io"}_${"some" | "full"}`, number>>;

/** The avg10 of /proc/pressure's cpu, memory and io files (of `pressure/` under $FLEET_PROC_ROOT, a test's), a line
 * or a file it cannot read left out (a kernel's cpu file may have no `full` line; the system-wide one reads 0); undefined
 * when none reads (no PSI here, the Mac). */
export function pressureNow(env: Env): Pressure | undefined {
  const root = env("FLEET_PROC_ROOT") ?? "/proc";
  const read: Pressure = {};

  for (const resource of ["cpu", "memory", "io"] as const) {
    const text = readText(join(root, "pressure", resource)) ?? "";

    for (const kind of ["some", "full"] as const) {
      const avg = new RegExp(`^${kind} avg10=([0-9.]+)`, "m").exec(text)?.[1];

      if (avg !== undefined) read[`${resource}_${kind}`] = Number(avg);
    }
  }

  return Object.keys(read).length === 0 ? undefined : read;
}

/** The directory of the systemd user manager's transient scopes: $FLEET_CGROUP_ROOT (a test's), else this user's app.slice. */
function appSlice(env: Env): string {
  const uid = String(process.getuid?.() ?? "");

  return env("FLEET_CGROUP_ROOT") ?? `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;
}

/** The memory the scope `unit` uses beyond its file cache (memory.current less memory.stat's `file`, which MemAvailable
 * already counts as available); undefined while it has no cgroup (its run has not started, or is gone). */
function scopeUsed(unit: string, env: Env): number | undefined {
  const cgroup = join(appSlice(env), `${unit}.scope`);
  const current = Number.parseInt(readText(join(cgroup, "memory.current")) ?? "", 10);
  const file = Number(/^file (\d+)$/m.exec(readText(join(cgroup, "memory.stat")) ?? "")?.[1] ?? 0);

  return Number.isNaN(current) ? undefined : Math.max(0, current - file);
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

/** The memory an ask leaves free beside it, as given (`8G`, `12%`, `0`) and in bytes. */
export interface Floor {
  readonly spec: string;
  readonly bytes: number;
}

/** The floor `given` (`--floor`) names, else $FLEET_GATE_MEMORY_FLOOR, else {@link DEFAULT_FLOOR}: a size or a share of
 * the RAM, 64M at least, or 0 for none. Undefined when it does not parse. */
export function floorOf(given: string | undefined, env: Env): Floor | undefined {
  const set = env("FLEET_GATE_MEMORY_FLOOR")?.trim();
  const spec = given?.trim() ?? (set === undefined || set === "" ? DEFAULT_FLOOR : set);
  const zero = /^0+(?:\.0+)?(?:[KMGT]?i?B?|%)$/i.test(spec);
  // A share is of the MemTotal of the meminfo MemAvailable is read from.
  const bytes = zero ? 0 : capBytes(spec, memTotal(env));

  return bytes === undefined ? undefined : { spec, bytes };
}

/** The cap of one run when `--mem` does not say: $FLEET_GATE_MEMORY_MAX, else {@link DEFAULT_CAP} of the RAM, at most
 * `budget`. What an ask of the whole budget counts against the floor. */
export function runCapOf(env: Env, budget: number): number {
  const total = memTotal(env);

  return Math.min(capBytes(env("FLEET_GATE_MEMORY_MAX")?.trim() ?? DEFAULT_CAP, total) ?? capBytes(DEFAULT_CAP, total) ?? budget, budget);
}

/** The machine's CPUs, as os.cpus() counts them (no quota changes it). */
export function cpusHere(): number {
  return cpuList().length || availableParallelism();
}

/** The CPUs all holds together may declare: $FLEET_GATE_CPU_BUDGET (a whole number of CPUs), else the `all` CPUs
 * (the machine's) less {@link CPUS_KEPT} and half of them at least; undefined when $FLEET_GATE_CPU_BUDGET does not
 * parse. */
export function cpuBudgetOf(env: Env, all = cpusHere()): number | undefined {
  const given = env("FLEET_GATE_CPU_BUDGET")?.trim();

  if (given === undefined || given === "") return Math.max(Math.floor(all / 2), all - CPUS_KEPT, 1);

  return /^[0-9]+$/.test(given) && Number(given) > 0 ? Number(given) : undefined;
}

/** What an ask keeps free of the machine's memory. MemAvailable and the scopes' use are read under the gate's lock. */
export interface Memory {
  /** Bytes MemAvailable must keep beside what the ask and the holds may still take. */
  readonly floor: number;
  /** What an ask of the whole budget counts: one run's cap. Such a hold keeps every other hold out, so what the
   * machine must have is its own run's cap and the floor. */
  readonly whole: number;
  /** Where MemAvailable ($FLEET_MEMINFO) and the scopes' use ($FLEET_CGROUP_ROOT) are read. */
  readonly env: Env;
}

/** Why an ask does not fit the memory available: MemAvailable, less what the holds may still take (`unused`) and its
 * own part, is under the floor. */
export interface Short {
  readonly available: number;
  /** What the holds' caps allow them beyond what their scopes use now; a hold with no scope counts its whole cap. */
  readonly unused: number;
  /** The ask's own part: its cap, or one run's cap when it asks for the whole budget (`whole`). */
  readonly part: number;
  readonly whole: boolean;
  readonly floor: number;
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
  /** Bytes of the budget it takes, a run's estimate (not its scope's ceiling); undefined is all of it (taken by hand
   * without `--mem`, by a run that has no scope to cap it, or by an older fleet). */
  readonly cap: number | undefined;
  /** The budget's bytes as its taker read it; undefined when an older fleet took it. */
  readonly budget: number | undefined;
  /** The `gate run` that took it: the hold lives as long as that process (and its scope), and only it frees the hold. */
  readonly pid: number | undefined;
  /** The systemd user scope its run's command is in (`<unit>.scope`), when the run has one: the hold lives while
   * that scope does, though its runner is gone. */
  readonly unit: string | undefined;
  /** The `gate run` an older fleet ran under it, when it was taken by hand: that fleet's mark (`runner`). */
  readonly runner: number | undefined;
  /** The systemd user scope that run's command is in, when it has one: the run goes for as long as the scope does. */
  readonly runnerUnit: string | undefined;
  /** The CPUs its run estimated; undefined when it declared none (by hand, or an older fleet's run). */
  readonly cpus: number | undefined;
  /** Whether its run was marked a landing gate (`--landing`): recorded, nothing more. */
  readonly landing: boolean;
  /** Whether its run is light: a light waiter passes a head that would not fit even without the light holds. */
  readonly light: boolean;
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
  /** Whether at its last ask it fitted the budget and waited for memory alone. */
  readonly memory: boolean;
  readonly cpus: number | undefined;
  readonly landing: boolean;
  /** Whether it is light ({@link Ask}'s `light`). */
  readonly light: boolean;
  /** The limits it asked under, by which a light run judges it: the budget's bytes, the CPU budget and the floor it
   * read. A waiter an older fleet queued has none. */
  readonly budget: number | undefined;
  readonly cpuBudget: number | undefined;
  readonly floor: number | undefined;
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
  /** What it keeps free; undefined, or where MemAvailable cannot be read, only the budget counts. */
  readonly memory?: Memory | undefined;
  /** The CPUs it estimates; undefined declares none (a hold by hand). */
  readonly cpus?: number | undefined;
  /** The CPUs all holds together may declare; undefined counts memory alone. */
  readonly cpuBudget?: number | undefined;
  /** Whether it is marked a landing gate: recorded on its hold, nothing more. */
  readonly landing?: boolean | undefined;
  /** Whether it is light (an estimate of {@link LIGHT_CAP} at most, each of its last runs {@link LIGHT_S} at most): it
   * passes a head that would not fit even with every light hold gone. */
  readonly light?: boolean | undefined;
}

/** Why an ask was not admitted: who holds, who is before it in the queue, and the memory it lacks. */
export interface Waiting {
  readonly holders: readonly Hold[];
  readonly ahead: readonly Waiter[];
  /** Whether its part fits the budget beside the holds. */
  readonly fits: boolean;
  /** The rows it does not fit beside the holds: memory, CPU, or both; none when it fits. */
  readonly lacks: readonly Row[];
  /** Set when the memory available, less what the holds may still take and its part, is under the floor. */
  readonly short?: Short | undefined;
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

/** What an ask or a waiter asks: its bytes (undefined: the whole budget) and its CPUs. */
interface Part {
  readonly cap: number | undefined;
  readonly cpus?: number | undefined;
}

/** The bytes `holders` take of the budget: a hold of the whole budget is all of it. */
function memHeld(holders: readonly Hold[]): number {
  return holders.reduce((sum, h) => sum + (h.cap ?? Infinity), 0);
}

/** The CPUs `holders` declared. A run an older fleet started, with no CPUs on its hold, runs at the quota it had then,
 * half the CPUs; a hold by hand declares none. */
export function cpusHeld(holders: readonly Hold[]): number {
  const half = Math.max(2, Math.floor(cpusHere() / 2));

  return holders.reduce((sum, h) => sum + (h.cpus ?? (h.pid !== undefined && h.cap !== undefined ? half : 0)), 0);
}

/** A row of the budget: what an ask may not fit. */
export type Row = "memory" | "CPU";

/** The rows in which `part` does not fit beside `holders`: the memory budget `budget` and, given one, the CPU budget
 * `cpuBudget`. None: it fits. */
function lacksBeside(part: Part, budget: number, holders: readonly Hold[], cpuBudget?: number): Row[] {
  if (part.cap === undefined) return holders.length === 0 ? [] : ["memory"];
  const mem = memHeld(holders) + part.cap > roomOf(budget, holders);
  const cpu = cpuBudget !== undefined && cpusHeld(holders) + (part.cpus ?? 0) > cpuBudget;

  return [...(mem ? ["memory" as const] : []), ...(cpu ? ["CPU" as const] : [])];
}

/** Whether `part` fits every row of the budget beside `holders` ({@link lacksBeside}). */
function fitsBeside(part: Part, budget: number, holders: readonly Hold[], cpuBudget?: number): boolean {
  return lacksBeside(part, budget, holders, cpuBudget).length === 0;
}

/** Whether `waiter` waits for the memory floor alone: at its last ask, and still, its part fits both rows of the
 * budget, `budget` and `cpuBudget`, beside `holders`. What `fleet fleets gate` says of it; it keeps its place all the
 * same. */
export function waitsForMemory(waiter: Waiter, budget: number, holders: readonly Hold[], cpuBudget?: number): boolean {
  return waiter.memory && fitsBeside(waiter, budget, holders, cpuBudget);
}

/** What the scope of `hold` uses now, or undefined when it has none to read. */
function usedBy(hold: Hold, env: Env): number | undefined {
  return hold.unit === undefined ? undefined : scopeUsed(hold.unit, env);
}

/** Why `part` does not fit the memory available beside `holders`, or undefined when it does (or MemAvailable cannot be
 * read). It is a condition beside the budget: the budget counts the holds, this the memory others use too (dev servers,
 * sessions). A hold counts the larger of its estimate and what its scope uses now, never its ceiling; what it uses is
 * out of MemAvailable already, so it counts the part of its estimate not used yet: two runs asked seconds apart each
 * read MemAvailable before either used anything, and a run past its estimate counts what it uses. `gone` are holds
 * left out of `holders` to ask what the floor would say without them: what their scopes use comes back to
 * MemAvailable. */
function shortOf(part: Part, memory: Memory | undefined, holders: readonly Hold[], gone: readonly Hold[] = []): Short | undefined {
  const read = memory === undefined ? undefined : memAvailable(memory.env);

  if (memory === undefined || read === undefined) return undefined;
  const available = gone.reduce((sum, h) => sum + (usedBy(h, memory.env) ?? 0), read);

  const unused = holders.reduce((sum, h) => (h.cap === undefined ? sum : sum + Math.max(0, h.cap - (usedBy(h, memory.env) ?? 0))), 0);

  const own = part.cap ?? memory.whole;

  return available - unused - own >= memory.floor ? undefined : { available, unused, part: own, whole: part.cap === undefined, floor: memory.floor };
}

/** `short` in words, for `noun` (`this run`): `39.4G needed, 36.0G available (15.7G held but not yet used, 15.7G for
 * this run, 8.0G floor)`. */
export function shortText(short: Short, noun: string): string {
  const parts = [
    ...(short.unused > 0 ? [`${sizeText(short.unused)} held but not yet used`] : []),
    `${sizeText(short.part)} for ${noun}${short.whole ? ", one run's cap, as it takes the whole budget" : ""}`,
    `${sizeText(short.floor)} floor`,
  ];

  return `${sizeText(short.unused + short.part + short.floor)} needed, ${sizeText(short.available)} available (${parts.join(", ")})`;
}

/** What `fleet fleets gate take` and `gate run` say of a floor they cannot read: `given` is `--floor`'s value, if any. */
export function floorRefusal(given: string | undefined, env: Env): string {
  const what = given === undefined ? `the floor $FLEET_GATE_MEMORY_FLOOR='${env("FLEET_GATE_MEMORY_FLOOR") ?? ""}'` : `--floor '${given}'`;

  return `cannot read ${what}: give a size (8G) or a share of the RAM (12%), 64M at least, or 0 to keep nothing free`;
}

/** One finished `gate run`, a line of `runs.jsonl`. */
export interface RunRecord {
  /** When it ended. */
  readonly at: string;
  readonly name: string;
  readonly kind: "fleet" | "session";
  /** The whole command, quoted for a shell. */
  readonly what: string;
  /** Where its estimate came from (`--mem`'s `24G`, `last runs`, `its family's runs`, the default `25%`), and its ceiling in bytes: its
   * scope's MemoryMax, the budget (the whole budget for a run with no scope). */
  readonly asked: string;
  readonly cap: number;
  /** The memory it estimated, in bytes: its part of the budget. Older lines have none. */
  readonly estimate?: number | undefined;
  /** Seconds it waited for the gate. */
  readonly waited: number;
  /** Seconds the command ran; null when it gave up waiting and never ran. */
  readonly ran: number | null;
  readonly code: number;
  /** The most memory its scope held, in bytes; null where there was no scope. */
  readonly peak: number | null;
  /** How many processes of its scope an OOM killer killed (memory.events' oom_kill). */
  readonly killed: number;
  /** The repository it ran in (jj's store, `.jj/repo`, which every workspace of it shares, else git's common
   * directory), the workspace's root, and the commit: jj's `@-`, else git's HEAD. Older lines have none. */
  readonly repo?: string | undefined;
  readonly workspace?: string | undefined;
  readonly commit?: string | undefined;
  /** CPU seconds its scope used (cpu.stat's usage_usec); null where there was no scope. Older lines have none. */
  readonly cpu_s?: number | null | undefined;
  /** The CPUs it estimated, and whether it was marked a landing gate. Older lines have neither. */
  readonly cpus?: number | undefined;
  readonly landing?: boolean | undefined;
  /** The machine's pressure ({@link Pressure}) when the command started and when it ended, and the most each average
   * reached in between, sampled while it ran. None where /proc/pressure cannot be read, and older lines have none. */
  readonly psi_start?: Pressure | undefined;
  readonly psi_end?: Pressure | undefined;
  readonly psi_max?: Pressure | undefined;
}

/** What a command's last runs that ran in a scope did, whatever their end (a failed run's peak and a killed run's are
 * real peaks), at most {@link RUNS_MEASURED} of them: the largest memory peak and when that run ended, the longest
 * time, and the most CPUs used on average (CPU seconds over time; undefined where none kept its CPU seconds). */
export interface Measured {
  readonly peak: number;
  readonly at: string;
  readonly ran: number;
  readonly cores: number | undefined;
  readonly runs: number;
  /** How the run whose peak it is was killed ({@link killMark}); absent when it was not. */
  readonly killed?: string;
}

/** How a run's record says it was killed, as `{ killed }`: its scope's OOM kills, else an exit of 128 plus a signal's
 * number (137 for SIGKILL, 143 for SIGTERM, as a shell and `gate run` write a signal's end); nothing for any other end. */
function killMark(run: JsonObject): Pick<Measured, "killed"> {
  const oom = asNumber(run["killed"]) ?? 0;
  const code = asNumber(run["code"]);

  if (oom > 0) return { killed: `${String(oom)} process(es) killed for memory` };

  return code !== undefined && code > 128 ? { killed: `exit ${String(code)}` } : {};
}

/** A measured run's line: what {@link Measured} reads of it. */
interface Ran {
  readonly run: JsonObject;
  readonly peak: number;
  readonly ran: number;
  readonly at: string;
}

/** `runs`, newest first, in numbers: undefined for none. */
function measuredOf(runs: readonly Ran[]): Measured | undefined {
  const last = runs.slice(0, RUNS_MEASURED);
  const top = last.reduce<Ran | undefined>((max, r) => (max === undefined || r.peak > max.peak ? r : max), undefined);

  if (top === undefined) return undefined;

  const cores = last.flatMap((r) => {
    const cpuS = asNumber(r.run["cpu_s"]);

    return cpuS === undefined || r.ran <= 0 ? [] : [cpuS / r.ran];
  });

  return { peak: top.peak, at: top.at, ran: Math.max(...last.map((r) => r.ran)), cores: cores.length === 0 ? undefined : Math.max(...cores), runs: last.length, ...killMark(top.run) };
}

/** The largest peak of a family's runs in the last day in one repository, whatever their workspace: the run's end,
 * and the repository and workspace it ran in. */
export interface FamilyPeak {
  readonly command: string;
  readonly peak: number;
  readonly at: string;
  readonly repo: string;
  readonly workspace: string;
  /** How the run whose peak it is was killed; absent when it was not. */
  readonly killed?: string;
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
    cpus: asNumber(raw["cpus"]),
    landing: raw["landing"] === true,
    light: raw["light"] === true,
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
    memory: raw["memory"] === true,
    cpus: asNumber(raw["cpus"]),
    landing: raw["landing"] === true,
    light: raw["light"] === true,
    budget: asNumber(raw["budget"]),
    cpuBudget: asNumber(raw["cpu_budget"]),
    floor: asNumber(raw["floor"]),
  };
}

/** `raw` with `key` set to `value`, or `raw` itself when there is no value. */
function plus(raw: JsonObject, key: string, value: Json | undefined): JsonObject {
  return value === undefined ? raw : { ...raw, [key]: value };
}

function waiterJson(w: Waiter): JsonObject {
  const base = plus(plus(plus({ fleet: w.name, kind: w.kind, what: w.what, since: w.since, until: w.until, pid: w.pid }, "cap", w.cap), "started", w.started), "memory", w.memory || undefined);

  const kind = plus(plus(plus(base, "cpus", w.cpus), "landing", w.landing || undefined), "light", w.light || undefined);

  return plus(plus(plus(kind, "budget", w.budget), "cpu_budget", w.cpuBudget), "floor", w.floor);
}

/** Whether the process `pid` that started at `started` still runs: a later process with its pid is another. */
function running(pid: number, started: string | undefined): boolean {
  return alive(pid) && (started === undefined || startedOf(pid) === started);
}

/** Whether the transient scope `unit` of the systemd user manager still has processes: its cgroup is there. */
export function scopeLives(unit: string): boolean {
  return exists(join(appSlice(() => undefined), `${unit}.scope`));
}

/** Whether the `gate run` of an older fleet whose mark `hold`, one taken by hand, carries still goes: its runner is
 * that process still, or its scope is there. */
function runnerLives(hold: Hold): boolean {
  return (hold.runner !== undefined && running(hold.runner, asString(hold.raw["runner_started"]))) || (hold.runnerUnit !== undefined && scopeLives(hold.runnerUnit));
}

/** The hold of the run whose mark `hold`, one taken by hand, carries: the run's runner, its start and its scope, with
 * the part of the budget, the budget and the `until` of the hold it went under. Its taker's token frees `hold` while
 * the run still holds that memory, so this hold keeps it counted until the run ends; it lapses then (the older
 * fleet's runner frees by its mark, which this hold no longer carries). */
function runOf(hold: Hold): Hold {
  const { runner, runner_started: started, runner_unit: unit, ...rest } = hold.raw;

  return holdOf(plus(plus(plus(rest, "pid", runner), "started", started), "unit", unit));
}

/** The command that ends the run of `hold`, every process it started with it: its scope stopped by name when it has
 * one, else its runner killed while that pid is still the process that took the hold (a later process with its pid is
 * not). Undefined when there is nothing left to stop. */
export function endOf(hold: Hold): string | undefined {
  if (hold.unit !== undefined) return `systemctl --user stop ${hold.unit}.scope`;

  return hold.pid !== undefined && running(hold.pid, asString(hold.raw["started"])) ? `kill ${String(hold.pid)}` : undefined;
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
  const cap = hold.cap === undefined ? "" : `, ${hold.unit === undefined ? "cap" : "estimate"} ${sizeText(hold.cap)}`;
  const cpus = hold.cpus === undefined ? "" : `, ${String(hold.cpus)} CPUs`;

  return `held by ${who} since ${plain(hold.since)}${until}${cap}${cpus}${hold.landing ? ", a landing gate" : ""}: ${plain(hold.what)}`;
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

    // A fleet's hold taken by hand lapses with its fleet's entry, except while a run an older fleet's `gate run` marked
    // on it goes: that run still holds the hold's memory.
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

  /** `ask` takes its part of the budget when it is first in line (but for waiters a light run passes), fits
   * beside the holds and leaves the floor free: the hold it made. Else who is in its way; an ask ready to wait
   * (`waitS`) then has its place in the queue, kept across calls by its pid. */
  ask(ask: Ask, now: Date): { readonly took: Hold } | { readonly waiting: Waiting } {
    return this.locked(() => {
      const { holders, queue } = this.settled(now);
      const at = queue.findIndex((w) => w.pid === ask.pid);
      const lacks = lacksBeside(ask, ask.budget, holders, ask.cpuBudget);
      const fits = lacks.length === 0;
      const before = at < 0 ? queue : queue.slice(0, at);
      const heavy = holders.filter((h) => !h.light);
      const lights = holders.filter((h) => h.light);

      // Arrival order, a waiter short of the memory floor alone included: a run that passed it would hold memory it
      // waits for, and overlapping runs would keep it short for ever. A light run that fits passes only a waiter that
      // would not be admitted even with every light hold gone, its own included once it holds: not in the budget's
      // rows, or not by the floor. Once the lights are what keeps a waiter out they stop passing it, and drain in
      // minutes. A waiter is judged by the limits it asked under; one an older fleet queued, by this ask's.
      const blocks = (w: Waiter): boolean => {
        const own = w.budget === undefined ? ask : { budget: w.budget, cpuBudget: w.cpuBudget, memory: ask.memory === undefined || w.floor === undefined ? undefined : { ...ask.memory, floor: w.floor } };

        return fitsBeside(w, own.budget, heavy, own.cpuBudget) && shortOf(w, own.memory, heavy, lights) === undefined;
      };

      const ahead = ask.light === true && fits ? before.filter(blocks) : before;

      const short = shortOf(ask, ask.memory, holders);
      const memory = fits && short !== undefined;
      const since = stampOf(now);

      if (ahead.length === 0 && fits && short === undefined) {
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
          memory,
          cpus: ask.cpus,
          landing: ask.landing === true,
          light: ask.light === true,
          budget: ask.budget,
          cpuBudget: ask.cpuBudget,
          floor: ask.memory?.floor,
        };

        this.keepQueue([...queue, waiter]);
      } else if (at >= 0 && queue[at]?.memory !== memory) {
        this.keepQueue(queue.map((w, i) => (i === at ? { ...w, memory } : w)));
      }

      return { waiting: short === undefined ? { holders, ahead, fits, lacks } : { holders, ahead, fits, lacks, short } };
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

    return holdOf(plus(plus(plus(plus({ ...scoped, budget: ask.budget }, "cap", ask.cap), "cpus", ask.cpus), "landing", ask.landing === true ? true : undefined), "light", ask.light === true ? true : undefined));
  }

  /** The process `pid` gives up its place in the queue. */
  leave(pid: number, now: Date): void {
    this.locked(() => {
      const { queue } = this.settled(now);

      if (queue.some((w) => w.pid === pid)) this.keepQueue(queue.filter((w) => w.pid !== pid));
    });
  }

  /** Free the holds `key` names, by token or (as before tokens) by holder's name. A run's hold is freed only by
   * its runner (`runner`, its pid): the run still holds its memory, so the release is refused with the holds that
   * are `running`, to stop the run instead. A hold taken by hand is always freed; one an older fleet's run still goes
   * under is freed into that run's hold, so its memory stays counted until the run ends. Refused with the holders
   * (`held`) when none of the holds is `key`'s. */
  free(key: string, now: Date, runner?: number): { readonly freed: true } | { readonly held: readonly Hold[] } | { readonly running: readonly Hold[] } {
    return this.locked(() => {
      const { holders } = this.settled(now);
      const named = holders.filter((h) => h.token === key || plain(h.name) === plain(key));
      const going = named.filter((h) => h.pid !== undefined && h.pid !== runner);

      if (holders.length > 0 && named.length === 0) return { held: holders };

      if (named.length > 0 && going.length === named.length) return { running: going };

      this.keepHolds(holders.flatMap((h) => {
        if (!named.includes(h) || going.includes(h)) return [h];

        return h.pid === undefined && runnerLives(h) ? [runOf(h)] : [];
      }));

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

  /** The runs kept that ran in a scope, newest first, whatever their end: a peak and a time measured. */
  private measuredRuns(): Ran[] {
    return (readText(this.path("runs.jsonl")) ?? "").split("\n").flatMap((line) => {
      const run = Option.getOrUndefined(parseObject(line));
      const peak = asNumber(run?.["peak"]);
      const ran = asNumber(run?.["ran"]);
      const at = asString(run?.["at"]);

      return run === undefined || peak === undefined || ran === undefined || at === undefined ? [] : [{ run, peak, ran, at }];
    }).toReversed();
  }

  /** What the last runs of `what` (as {@link whatKey} keys it) in the repository `repo` did, or undefined when there
   * were none: older lines, which name no repository, are never one. */
  history(repo: string, what: string): Measured | undefined {
    const key = whatKey(what);

    return measuredOf(this.measuredRuns().filter((r) => r.run["repo"] === repo && whatKey(asString(r.run["what"]) ?? "") === key));
  }

  /** The largest peak of the runs of `what`'s family (as {@link familyOf} keys it, `what` run in `workspace`) that ended
   * in the day before `now` in the repository `repo`, in any of its workspaces; undefined when there were none. Never
   * another repository's: `just test` in a small one says nothing of a large one's. A line that names no workspace
   * (an older one) is none. */
  familyPeak(repo: string, what: string, workspace: string, now: Date): FamilyPeak | undefined {
    const command = familyOf(what, workspace);
    const from = now.getTime() - DAY_MS;

    return this.measuredRuns().reduce<FamilyPeak | undefined>((top, r) => {
      const ran = asString(r.run["workspace"]);
      const at = parseInstant(r.at);

      if (r.run["repo"] !== repo || ran === undefined || at === undefined || at < from || at > now.getTime()) return top;

      if (familyOf(asString(r.run["what"]) ?? "", ran) !== command || (top !== undefined && r.peak <= top.peak)) return top;

      return { command, peak: r.peak, at: r.at, repo, workspace: ran, ...killMark(r.run) };
    }, undefined);
  }

  /** The runs that ended in the day before `now`, in numbers; undefined when there were none. */
  day(now: Date): Day | undefined {
    const path = this.path("runs.jsonl");

    if (!exists(path)) return undefined;
    const from = now.getTime() - DAY_MS;

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
