/**
 * `fleet fleets gate run FLEET|--as NAME [--wait SECONDS] [--for MINUTES] [--timeout SECONDS] [--mem SIZE|PERCENT] [--floor SIZE|PERCENT] [--cpus N] [--landing] -- COMMAND...`:
 * a test suite run through the gate, as one process tree that dies whole. Two numbers size it. Its estimate, memory
 * and CPUs, is its part of the gate's budgets and decides admission only (gate.ts): `--mem` and `--cpus` when given;
 * else the largest of the last 3 runs of the same command in this repository, whatever their end, times 1.25 (memory
 * 2G at least; CPUs its CPU seconds over its time, 2 at least); else $FLEET_GATE_MEMORY_MAX or a quarter of the RAM,
 * and 8 CPUs. A `--mem` below the command's measured peak (its last runs', else its family's) is raised to that peak,
 * no margin added, unless a killed run left that peak (OOM, or an exit of 128 plus a signal), and the run says so. It waits in the gate's queue up to `--wait` (also while MemAvailable, less its estimate and what the
 * holds' estimates still leave them, is under the floor, `--floor`, else $FLEET_GATE_MEMORY_FLOOR, else 8G), then runs
 * COMMAND in a transient systemd user scope under its ceiling, the same for every run: MemoryMax the whole budget
 * (half the RAM), no swap and OOMPolicy=continue (the kernel kills the hog, the suite sees it fail), a CPU weight, so
 * two runs share the cores evenly whatever each one's thread count, and a CPU quota, $FLEET_GATE_CPUS else half the
 * CPUs, which a pool sized by nproc or Node's CPU count reads, so a suite's tests keep their time beside other work.
 * The command gets $FLEET_GATE_RUN_CPUS, its quota (else the CPU budget) 8 at most, always the run's own, for a config
 * to size its pool by; the gate sets no tool's own worker variable.
 * Nothing kills a run for passing its estimate: only the ceiling and the kernel's OOM killer limit it, and its peak,
 * on its record, raises the next run's estimate. `--landing` marks the run on its hold and its record, nothing more. On
 * any end (exit, failure, `--timeout` or the hold's `--for` running out, a signal) it stops the scope, so every
 * process the command started dies with it (one that asked for an app scope of its own, as Chromium does, is taken
 * back into the run's while it runs, and killed when it got out after the last look), frees its hold, keeps one line
 * about the run (gate.ts's `runs.jsonl`: the wait, the time, the scope's memory peak, the machine's pressure at its
 * start and end and the most it reached between, logged only) and exits with the command's
 * code. A scope that still has processes after its stop keeps its hold, and the run says so. Where there is no
 * systemd user manager (the Mac), the command runs in a process group of its own, killed whole at its end, without a
 * memory cap, and it says so: it is then counted as the whole budget. A run never goes under a hold taken by hand,
 * its own name's included: it waits for that hold as for any other.
 *
 * The runner's own death is covered twice: the hold carries the runner's pid, so it lapses when the runner is
 * gone, and a small watchdog, outside the runner's process group, stops the scope (or kills the group) when the
 * runner dies without cleaning up (SIGKILL). */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";

import { stampOf } from "./clock.ts";
import { readText } from "./files.ts";
import { BEHIND_KEPT, type Behind, budgetOf, capBytes, cpuBudgetOf, cpusHere, DEFAULT_CAP, floorOf, floorRefusal, gateOf, holdText, LIGHT_CAP, LIGHT_S, memAvailable, memEstimate, memTotal, PEAK_MARGIN_TEXT, plain, pressureNow, scopeLives, shortText, sizeText, type GateHolder, type Memory, type Pressure, type RunRecord, type WaitedFor, type Waiting } from "./gate.ts";
import { ancestry } from "./procs.ts";
import type { Machine } from "./world.ts";

/** How long a run holds the slot when `--for` does not say; the command is stopped when it runs out. */
export const RUN_MINUTES = 60;

/** The weight of a run's scope among the user manager's units when $FLEET_GATE_CPU_WEIGHT does not say: systemd's
 * own default. The kernel shares the cores by weight only while they are contended, so a run alone loses nothing. */
const CPU_WEIGHT = 100;

/** How much a run is niced where its scope cannot have a CPU weight. */
const NICE = 5;

/** Seconds a hold outlasts its `--for`: the command is stopped at `--for` at the latest, and its stop (the grace,
 * the scope's own limit after the runner's, the scope's own grace) is over before the hold lapses. */
const HOLD_GRACE_S = 15;

/** How long the systemd user manager has to answer the probe for a scope; $FLEET_GATE_SCOPE_PROBE_MS (a test's) says otherwise. */
const SCOPE_PROBE_MS = 5000;

/** Seconds a stopped command has between SIGTERM and SIGKILL; $FLEET_GATE_STOP_GRACE_S (a test's) says otherwise. */
const STOP_GRACE_S = 5;

/** The whole number, above 0, that $`name` gives, else `fallback`. */
function wholeOr(env: (name: string) => string | undefined, name: string, fallback: number): number {
  const given = env(name)?.trim();

  return given !== undefined && /^[0-9]+$/.test(given) && Number(given) > 0 ? Number(given) : fallback;
}

/** The most CPUs $FLEET_GATE_RUN_CPUS gives a config's pool: case-analysis tuned vitest's maxWorkers to 8 (a worker holds
 * 0.6-1.3 GB), and 10-22's suites ran at that. */
const POOL_CPUS = 8;

/** How often a run samples the machine's pressure for the most it reached: the kernel updates its averages every 2 s.
 * $FLEET_GATE_PRESSURE_MS (a test's) says otherwise. */
const PRESSURE_MS = 2000;

/** The larger of each average `a` and `b` read. */
function higher(a: Pressure | undefined, b: Pressure | undefined): Pressure | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  const both: Pressure = { ...a };

  for (const resource of ["cpu", "memory", "io"] as const) {
    for (const kind of ["some", "full"] as const) {
      const key = `${resource}_${kind}` as const;
      const value = b[key];

      if (value !== undefined) both[key] = Math.max(value, a[key] ?? value);
    }
  }

  return both;
}

/** How long a stopped scope's cgroup has to go, once `systemctl stop` has answered, before it is taken as still there. */
const SCOPE_GONE_MS = 1000;

/** The CPUs a run estimates with no earlier run to size it from, the least its runs give it, and the margin over them. */
const FIRST_CPUS = 8;

const LEAST_CPUS = 2;

const CPU_MARGIN = 1.25;

/** How long git or jj has to say where a run is. */
const VCS_MS = 5000;

/** What `gate run` was asked to do. */
export interface RunAsk {
  readonly name: string;
  readonly command: readonly string[];
  readonly waitS: number;
  readonly minutes: number;
  readonly mem: string | undefined;
  /** The memory it leaves free (`--floor`); undefined is $FLEET_GATE_MEMORY_FLOOR's, else the default. */
  readonly floor: string | undefined;
  /** Seconds the command may run before it is stopped; its hold's `--for` when not given. */
  readonly timeoutS: number;
  /** The CPUs it estimates (`--cpus`), for admission alone; undefined sizes them from its last runs. */
  readonly cpus: number | undefined;
  /** Whether it is marked a landing gate (`--landing`): on its hold and its record, nothing more. */
  readonly landing: boolean;
}

export const RUN_USAGE = "usage: fleet fleets gate run FLEET|--as NAME [--wait SECONDS] [--for MINUTES] [--timeout SECONDS] [--mem SIZE|PERCENT] [--floor SIZE|PERCENT] [--cpus N] [--landing] -- COMMAND...";

/** `gate run`'s arguments (after `run`), or undefined when they do not parse. */
export function runArgs(argv: readonly string[]): RunAsk | undefined {
  const at = argv.indexOf("--");

  if (at < 0 || at === argv.length - 1) return undefined;
  const own = argv.slice(0, at);
  const command = argv.slice(at + 1);
  const words: string[] = [];
  let as: string | undefined;
  let waitS = 0;
  let minutes = RUN_MINUTES;
  let mem: string | undefined;
  let floor: string | undefined;
  let timeoutS: number | undefined;
  let cpus: number | undefined;
  let landing = false;

  for (let i = 0; i < own.length; i += 1) {
    const word = own[i] ?? "";
    const value = own[i + 1];

    if (word === "--landing") {
      landing = true;
    } else if (word === "--as" || word === "--wait" || word === "--for" || word === "--mem" || word === "--floor" || word === "--timeout" || word === "--cpus") {
      if (value === undefined) return undefined;
      i += 1;

      if (word === "--as") as = value.trim();
      else if (word === "--cpus") cpus = /^[0-9]+$/.test(value) ? Number(value) : 0;
      else if (word === "--wait") waitS = /^[0-9]+$/.test(value) ? Number(value) : -1;
      else if (word === "--for") minutes = /^[0-9]+$/.test(value) ? Number(value) : 0;
      else if (word === "--timeout") timeoutS = /^[0-9]+$/.test(value) ? Number(value) : 0;
      else if (word === "--floor") floor = value.trim();
      else mem = value.trim();
    } else {
      words.push(word);
    }
  }

  if (waitS < 0 || minutes <= 0 || timeoutS === 0 || cpus === 0 || as === "" || mem === "" || floor === "") return undefined;
  const name = as ?? (words.length === 1 ? words[0] : undefined);

  if (name === undefined || (as !== undefined && words.length > 0) || words.length > 1) return undefined;

  return { name, command, waitS, minutes, mem, floor, timeoutS: Math.min(timeoutS ?? minutes * 60, minutes * 60), cpus, landing };
}

/** Whether a systemd user manager answers here, so a transient scope can hold the command: `why` says why not.
 * $FLEET_GATE_SCOPE=0 says no. A manager that does not answer in time (a loaded machine) is not one that is
 * absent, and `why` says which. `systemd` is the manager's version. */
export function scopeHere(env: (name: string) => string | undefined): { readonly scoped: true; readonly systemd: number } | { readonly scoped: false; readonly why: string } {
  if (env("FLEET_GATE_SCOPE") === "0") return { scoped: false, why: "$FLEET_GATE_SCOPE is 0" };

  if (process.platform !== "linux" || Bun.which("systemd-run") === null || Bun.which("systemctl") === null) return { scoped: false, why: "no systemd user manager here" };
  const probeMs = wholeOr(env, "FLEET_GATE_SCOPE_PROBE_MS", SCOPE_PROBE_MS);
  const done = spawnSync("systemctl", ["--user", "show", "--property=Version"], { encoding: "utf8", timeout: probeMs });

  if (done.error === undefined && done.status === 0) return { scoped: true, systemd: Number(/^Version=(\d+)/m.exec(done.stdout)?.[1] ?? 0) };

  return { scoped: false, why: done.error === undefined ? `systemctl --user failed (exit ${String(done.status)})` : `systemctl --user did not answer in ${String(probeMs / 1000)}s (${done.error.message})` };
}

/** Whether a transient scope can hold a command here. */
export function scopeAvailable(env: (name: string) => string | undefined): boolean {
  return scopeHere(env).scoped;
}

/** Whether the systemd user manager may weigh its units' CPU: the kernel's cpu controller is delegated to it. */
function cpuDelegated(): boolean {
  const uid = String(process.getuid?.() ?? "");

  return (readText(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`) ?? "").split(/\s+/).includes("cpu");
}

/** The CPU weight a run's scope gets ($FLEET_GATE_CPU_WEIGHT, 1 to 10000, else {@link CPU_WEIGHT}), or undefined
 * when the scope cannot have one (the cpu controller is not delegated, or the weight is 0): the run is niced. */
function cpuWeight(env: (name: string) => string | undefined): number | undefined {
  const given = env("FLEET_GATE_CPU_WEIGHT")?.trim();
  const weight = given !== undefined && /^[0-9]+$/.test(given) ? Number(given) : CPU_WEIGHT;

  return weight >= 1 && weight <= 10000 && cpuDelegated() ? weight : undefined;
}

/** A run's CPU quota: the CPUs, undefined for none, and what the run's line says of it. */
interface CpuShare {
  readonly cpus: number | undefined;
  readonly said: string;
}

/** The CPUs a run's scope may use at once ($FLEET_GATE_CPUS, else half the machine's, 2 at least), as its CPUQuota,
 * and what the run's line says of it; `cpus` is undefined for no quota ($FLEET_GATE_CPUS is 0, the CPUs are at least
 * the machine's, or the cpu controller is not delegated). It is the ceiling, the same for every run whatever it
 * estimates. A pool sized from a CPU count that reads the quota (nproc, Node's os.availableParallelism(), which is
 * libuv's uv_available_parallelism, so vitest's default workers under Node; Rust's available_parallelism; Go's
 * GOMAXPROCS from 1.25) starts no more workers than the run may use, and a test's time stays its own beside other
 * work. A pool sized from os.cpus(), Bun's os.availableParallelism(), a config's maxWorkers or Playwright keeps its
 * size, and the quota only slows it. The machine's CPUs are os.cpus()'s, which no quota changes, so a run inside a
 * run's scope halves the machine's too. */
function cpuShare(env: (name: string) => string | undefined): CpuShare {
  const all = cpusHere();
  const given = env("FLEET_GATE_CPUS");
  const whole = given !== undefined && /^[0-9]+$/.test(given.trim());
  const share = whole ? Number(given.trim()) : Math.max(2, Math.floor(all / 2));
  const bad = given !== undefined && !whole ? `$FLEET_GATE_CPUS "${given}" is not a whole number of CPUs: half the CPUs taken` : undefined;

  if (share === 0) return { cpus: undefined, said: "" };

  if (!cpuDelegated()) return { cpus: undefined, said: `, no CPUQuota (the systemd user manager has no cpu controller)${bad === undefined ? "" : `, and ${bad}`}` };

  if (share >= all) {
    const why = whole ? `$FLEET_GATE_CPUS is ${String(share)}` : `half the CPUs, 2 at least, is ${String(share)}`;

    return { cpus: undefined, said: `, no CPUQuota (${why}, at least the machine's ${String(all)} CPUs${bad === undefined ? "" : `; ${bad}`})` };
  }

  const n = String(share);

  const reads = `nproc, Node's os.availableParallelism(), Rust's and Go's (1.25 on) count ${n}, so a pool they size starts ${n} workers; ` +
    "one sized by os.cpus(), Bun's os.availableParallelism(), a config's maxWorkers or Playwright keeps its size";

  return { cpus: share, said: `, CPUQuota=${String(share * 100)}% (${n} of ${String(all)} CPUs: ${reads})${bad === undefined ? "" : `; ${bad}`}` };
}

/** Where a run is: its repository (jj's store, `.jj/repo`, which every workspace of the repository shares, else git's
 * common directory), the workspace's root, and its commit (jj's `@-`, else git's HEAD), each absent where it cannot be
 * read. The repository keys a command's history, so a new workspace has its repository's. */
interface Where {
  readonly repo?: string | undefined;
  readonly workspace?: string | undefined;
  readonly commit?: string | undefined;
}

/** The jj store of the workspace whose root is `root`: its `.jj/repo` directory, or the one a later workspace's
 * `.jj/repo` file names (a path from its `.jj`). */
function jjStore(root: string): string | undefined {
  const dotJj = join(root, ".jj");
  const pointer = join(dotJj, "repo");

  try {
    return realpathSync(statSync(pointer).isDirectory() ? pointer : resolve(dotJj, readText(pointer)?.trim() ?? ""));
  } catch {
    return undefined;
  }
}

function whereRun(): Where {
  const read = (program: string, args: readonly string[]): string | undefined => {
    const done = spawnSync(program, args, { encoding: "utf8", timeout: VCS_MS, stdio: ["ignore", "pipe", "ignore"] });
    const out = done.error === undefined && done.status === 0 ? done.stdout.split("\n")[0]?.trim() : undefined;

    return out === "" ? undefined : out;
  };

  const real = (path: string | undefined): string | undefined => (path !== undefined && existsSync(path) ? realpathSync(path) : undefined);
  const jj = read("jj", ["root", "--ignore-working-copy", "--color", "never"]);

  if (jj !== undefined) {
    const commit = read("jj", ["log", "--ignore-working-copy", "--no-graph", "--color", "never", "-r", "@-", "-T", 'commit_id ++ "\\n"']);

    return { repo: jjStore(jj), workspace: jj, commit };
  }

  const git = read("git", ["rev-parse", "--show-toplevel"]);

  if (git === undefined) return {};

  return { repo: real(read("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"])), workspace: git, commit: read("git", ["rev-parse", "HEAD"]) };
}

/** The shell that runs the command inside the scope. On descriptor 3, which the command does not get, it tells the
 * runner its cgroup, and at the end the scope's memory peak and how many processes the cap killed, read before the
 * scope (gone with its last process) takes them with it. */
const IN_SCOPE = 'cg=/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup); echo "cgroup $cg" >&3; "$@" 3>&-; rc=$?; ' +
  'echo "peak $(cat "$cg/memory.peak" 2>/dev/null)" >&3; echo "oom_kill $(sed -n "s/^oom_kill //p" "$cg/memory.events" 2>/dev/null)" >&3; ' +
  'echo "cpu $(sed -n "s/^usage_usec //p" "$cg/cpu.stat" 2>/dev/null)" >&3; exit $rc';

/** What a scope did: its memory peak in bytes, how many processes its cap killed, and the CPU time it used in
 * microseconds, where known. */
interface ScopeMemory {
  readonly peak: number | undefined;
  readonly killed: number | undefined;
  readonly usec: number | undefined;
}

function count(text: string | undefined): number | undefined {
  return text !== undefined && /^[0-9]+$/.test(text.trim()) ? Number(text.trim()) : undefined;
}

/** The memory of the scope whose cgroup directory is `cgroup`, read from the kernel now. */
function memoryNow(cgroup: string | undefined): ScopeMemory {
  if (cgroup === undefined) return { peak: undefined, killed: undefined, usec: undefined };

  return {
    peak: count(readText(`${cgroup}/memory.peak`)),
    killed: count(/^oom_kill (\d+)$/m.exec(readText(`${cgroup}/memory.events`) ?? "")?.[1]),
    usec: count(/^usage_usec (\d+)$/m.exec(readText(`${cgroup}/cpu.stat`) ?? "")?.[1]),
  };
}

/** How often the runner looks for a process of the run that left its scope for an app scope. */
const SWEEP_MS = 250;

/** The variable that names the run's unit to every process the run starts: the runner knows its own process in an
 * app scope by it when no parent chain leads back (its launcher died), and a gate run inside the run its own. */
const RUN_MARK = "FLEET_GATE_RUN";

/** Whether a line of /proc/PID/cgroup (`0::/...`) is an app scope's: `app-<id>-<pid>.scope`, the scope a program
 * asks the user manager for so that a desktop portal can tell it apart (Chromium does, as
 * `app-org.chromium.Chromium-<pid>.scope`, however it was started). */
function appScope(group: string): boolean {
  return /\/app-[^/]+\.scope$/.test(group);
}

/** Whose a process in an app scope is. The run's (`own`, its scope's line of /proc/PID/cgroup; `unit`, its unit)
 * when its environment names the run's unit, or names none and the first of its ancestors outside an app scope is
 * in the run's scope; another's when it names another unit (a gate run inside the run), that ancestor is in another
 * scope, or it is an orphan (the user manager or init has it) whose environment names no unit; unknown, and asked
 * again at the next sweep, when a read fails. */
function whose(pid: number, own: string, unit: string): "ours" | "theirs" | "unknown" {
  const environ = readText(`/proc/${String(pid)}/environ`);
  const mark = environ?.split("\0").find((entry) => entry.startsWith(`${RUN_MARK}=`))?.slice(RUN_MARK.length + 1);

  if (mark !== undefined) return mark === unit ? "ours" : "theirs";

  for (const parent of ancestry(pid).slice(1)) {
    const group = readText(`/proc/${String(parent)}/cgroup`)?.trim();

    if (group === undefined) return "unknown";

    if (appScope(group)) continue;

    if (group === own) return "ours";

    return group.endsWith("/init.scope") && environ === undefined ? "unknown" : "theirs";
  }

  return environ === undefined ? "unknown" : "theirs";
}

/** What the sweeps did, by app scope: the pids taken back, killed, and refused (with the error). */
interface Swept {
  readonly taken: Map<string, Set<number>>;
  readonly killed: Map<string, Set<number>>;
  readonly failed: Map<string, { readonly pids: Set<number>; why: string }>;
}

function noted(by: Map<string, Set<number>>, scope: string, pid: number): void {
  by.set(scope, (by.get(scope) ?? new Set()).add(pid));
}

/** One look at the app scopes beside the run's scope (`own`, its cgroup directory): each process of the run there
 * (see {@link whose}), outside the run's cap, its memory peak and its stop, is written back into `own`, and its
 * scope, empty, goes; with `kill` (the run's scope has stopped) it is killed instead. A scope holding only others'
 * processes is put in `foreign` and not read again. A pid is moved or killed only while /proc still has it in that
 * app scope, read again just before (a pid reused since is another's). A write into a run's scope that has gone
 * (ENOENT) is left to the sweep after the stop. */
function sweepApps(own: string, unit: string, foreign: Set<string>, kill: boolean, swept: Swept): void {
  const slice = dirname(own);
  const ownGroup = `0::${own.slice("/sys/fs/cgroup".length)}`;
  let names: string[];

  try {
    names = readdirSync(slice);
  } catch {
    return;
  }

  for (const scope of names) {
    if (!/^app-.+\.scope$/.test(scope) || foreign.has(scope)) continue;
    const pids = (readText(join(slice, scope, "cgroup.procs")) ?? "").split("\n").filter((line) => /^\d+$/.test(line)).map(Number);
    const kinds = pids.map((pid) => ({ pid, kind: whose(pid, ownGroup, unit) }));

    if (pids.length > 0 && kinds.every(({ kind }) => kind === "theirs")) {
      foreign.add(scope);
      continue;
    }

    const group = `${dirname(ownGroup)}/${scope}`;

    for (const { pid } of kinds.filter(({ kind }) => kind === "ours")) {
      if (readText(`/proc/${String(pid)}/cgroup`)?.trim() !== group) continue;

      try {
        if (kill) process.kill(pid, "SIGKILL");
        else writeFileSync(join(own, "cgroup.procs"), String(pid));
        noted(kill ? swept.killed : swept.taken, scope, pid);
      } catch (cause: unknown) {
        // SAFETY: node's fs and process.kill errors carry an errno code.
        const code = (cause as NodeJS.ErrnoException).code ?? String(cause);

        if (code === "ESRCH" || (!kill && code === "ENOENT")) continue;
        const failed = swept.failed.get(scope) ?? { pids: new Set<number>(), why: code };
        failed.pids.add(pid);
        failed.why = code;
        swept.failed.set(scope, failed);
      }
    }
  }
}

/** The value `key` has in what {@link IN_SCOPE} wrote (`key value` a line). */
function told(piped: string, key: string): string | undefined {
  return new RegExp(`^${key} (.+)$`, "m").exec(piped)?.[1];
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // the group is gone
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);

    return true;
  } catch {
    return false;
  }
}

function stopUnit(unit: string, graceS: number): void {
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore", timeout: (graceS + 10) * 1000 });
}

/** A watchdog outside the runner's group: when the runner (`runner`) is gone, it stops what it ran. */
function watchdog(runner: number, cleanup: string): ChildProcess | undefined {
  try {
    const child = spawn("/bin/sh", ["-c", `while kill -0 "$0" 2>/dev/null; do sleep 1; done; ${cleanup}`, String(runner)], {
      detached: true,
      stdio: "ignore",
    });

    child.unref();

    return child;
  } catch {
    return undefined;
  }
}

/** A command's words, quoted for a shell. */
function quoted(command: readonly string[]): string {
  return command.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)).join(" ");
}

/** A command at most `length` characters long, for the hold's `what`, the messages and the records. */
function shown(command: readonly string[], length = 160): string {
  const text = quoted(command);

  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

/** What a run waits for, the rows of its wait line: the budget's rows its estimate does not fit beside the holds,
 * MemAvailable under the floor, or, with neither, its turn. */
export function waitedFor(waiting: Pick<Waiting, "lacks" | "short">): WaitedFor[] {
  const rows: WaitedFor[] = [...waiting.lacks.map((row): WaitedFor => (row === "CPU" ? "cpu" : "memory")), ...(waiting.short === undefined ? [] : ["floor" as const])];

  return rows.length === 0 ? ["turn"] : rows;
}

/** Who a run waits behind: the holds, then the waiters before it, {@link BEHIND_KEPT} at most. */
export function behindOf(waiting: { readonly holders: readonly Ahead[]; readonly ahead: readonly Ahead[] }): Behind[] {
  return [...waiting.holders, ...waiting.ahead].slice(0, BEHIND_KEPT).map((a) => (a.landing ? { name: a.name, landing: true } : { name: a.name }));
}

/** A hold or a waiter, as {@link behindOf} reads it. */
interface Ahead {
  readonly name: string;
  readonly landing: boolean;
}

const WAITED_WORDS: Readonly<Record<WaitedFor, string>> = { memory: "memory", cpu: "CPU", floor: "the memory floor", turn: "its turn" };

/** Why a run waits, in words: who holds the gate, the memory it lacks, and its place in the queue. */
function waitText(waiting: Waiting): string {
  const short = waiting.short === undefined ? undefined : `not enough memory: ${shortText(waiting.short, "this run")}`;

  const held = waiting.holders.length > 0 ? `the gate is ${waiting.holders.map(holdText).join("; and ")}${short === undefined ? "" : `; ${short}`}`
    : short ?? "the gate is free, but others wait before it";

  const behind = waiting.ahead.length === 0 ? "" : `, behind ${waiting.ahead.map((w) => plain(w.name)).join(", ")}`;

  const reason = `waiting for ${waitedFor(waiting).map((row) => WAITED_WORDS[row]).join(" and ")}`;

  return `${reason}: ${held}; place ${String(waiting.ahead.length + 1)} in the queue${behind}`;
}

const sleep = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/** Where a run says what it does: its stderr. */
export interface Say {
  (line: string): void;
}

/** Run `ask` through the gate; the exit code (the command's, 124 when its time ran out, 128+N on signal N, 75 when
 * the gate, or the memory available, had no room for it within `--wait` and nothing ran, 2 when its cap, the budget
 * or the floor cannot be read or the cap is more than the budget). */
export async function gateRun(machine: Machine, ask: RunAsk, say: Say): Promise<number> {
  const gate = gateOf(machine.registry);
  const holder: GateHolder = { name: ask.name, kind: machine.registry.live().some((e) => e.id === ask.name) ? "fleet" : "session" };
  const what = `gate run: ${shown(ask.command)}`;
  const budget = budgetOf(machine.env);

  if (budget === undefined) {
    say(`gate run: cannot read the budget of all runs together, $FLEET_GATE_MEMORY_BUDGET='${machine.env("FLEET_GATE_MEMORY_BUDGET") ?? ""}': give a share of the RAM (50%) or a size (24G), 64M at least`);

    return 2;
  }

  const cpuBudget = cpuBudgetOf(machine.env);

  if (cpuBudget === undefined) {
    say(`gate run: cannot read the CPU budget of all runs together, $FLEET_GATE_CPU_BUDGET='${machine.env("FLEET_GATE_CPU_BUDGET") ?? ""}': give a whole number of CPUs`);

    return 2;
  }

  const where = whereRun();
  const command = quoted(ask.command);
  const last = where.repo === undefined ? undefined : gate.history(where.repo, command);
  const total = memTotal();
  // The estimate: --mem, else its last runs, else $FLEET_GATE_MEMORY_MAX (the operator's word), else its family's peak of
  // the day in this repository's other workspaces, else the default. A --mem below the measured peak (its last runs',
  // else its family's) is raised to that peak, unless a killed run left it.
  const given = ask.mem ?? (last !== undefined ? undefined : machine.env("FLEET_GATE_MEMORY_MAX"));

  const kin = (given !== undefined && ask.mem === undefined) || last !== undefined || where.repo === undefined || where.workspace === undefined ? undefined
    : gate.familyPeak(where.repo, command, where.workspace, machine.now());

  const peak = last?.peak ?? kin?.peak;
  const measured = given === undefined && peak !== undefined ? memEstimate(peak) : undefined;
  const spec = given ?? (measured === undefined ? DEFAULT_CAP : sizeText(measured));
  const read = measured ?? capBytes(spec, total);

  if (read === undefined) {
    say(`gate run: cannot read the memory estimate '${spec}': give a share of the RAM (25%) or a size (24G), 64M at least`);

    return 2;
  }

  // A peak a killed run left (a leak killed at the ceiling is the whole budget) raises nothing: no later run lowers it.
  const peakKilled = last !== undefined ? last.killed : kin?.killed;
  const below = ask.mem !== undefined && peak !== undefined && read < peak;
  const raised = below && peakKilled === undefined ? peak : undefined;
  const parsed = raised ?? read;

  // An estimate the gate makes, or raises, follows a smaller budget down; one someone gave is theirs to change.
  const estimate = given === undefined || raised !== undefined ? Math.min(parsed, budget.bytes) : parsed;

  if (below) {
    const claim = raised === undefined ? `, but that peak is a killed run's (${peakKilled ?? ""}): claiming ${sizeText(estimate)} as given`
      : `: claiming ${sizeText(estimate)}${estimate < raised ? ", the budget" : ""}`;

    say(`gate run: --mem ${ask.mem ?? ""} is below this command's measured peak ${sizeText(peak)}${claim}`);
  }

  if (estimate > budget.bytes) {
    say(`gate run: the memory estimate '${spec}' (${sizeText(parsed)}) is more than the budget of all runs together, ${budget.spec} (${sizeText(budget.bytes)}): ask for at most that`);

    return 2;
  }

  if (ask.cpus !== undefined && ask.cpus > cpuBudget) {
    say(`gate run: --cpus ${String(ask.cpus)} is more than the CPU budget of all runs together (${String(cpuBudget)}): ask for at most that`);

    return 2;
  }

  const fromRuns = last?.cores === undefined ? undefined : Math.max(LEAST_CPUS, Math.ceil(last.cores * CPU_MARGIN));
  const cpus = Math.min(ask.cpus ?? fromRuns ?? FIRST_CPUS, cpuBudget);
  const runs = last === undefined ? "" : last.runs === 1 ? "its last run" : `its last ${String(last.runs)} runs`;

  const kinPeak = kin === undefined ? "" : `the 24 h peak of '${kin.command}' in ${kin.workspace} (repository ${kin.repo}), ${sizeText(kin.peak)} at ${kin.at}`;
  const peakFrom = last !== undefined ? `the peak of ${runs} (${sizeText(last.peak)} at ${last.at})` : kinPeak;

  const keptFrom = last !== undefined ? `the peak of ${runs}, ${sizeText(last.peak)} at ${last.at}` : kinPeak;

  const memFrom = raised !== undefined ? `--mem ${ask.mem ?? ""} raised to ${peakFrom}` : below ? `--mem kept (${keptFrom}, is a killed run's: ${peakKilled ?? ""})` : ask.mem !== undefined ? "--mem" : last !== undefined ? `${runs} (${sizeText(last.peak)} peak at ${last.at})`
    : kin !== undefined ? `${kinPeak}, plus ${PEAK_MARGIN_TEXT}`
    : `${given === undefined ? "the default" : "$FLEET_GATE_MEMORY_MAX"} ${spec} (no earlier run)`;

  const cpuFrom = ask.cpus !== undefined ? "--cpus" : fromRuns !== undefined ? `${runs} (${last?.cores?.toFixed(1) ?? "?"} used on average)` : "the default (no earlier run)";
  const lowered = estimate < parsed ? `, lowered from ${sizeText(parsed)} to the budget` : "";
  const estimateSaid = `estimate ${sizeText(estimate)} from ${memFrom}${lowered} and ${String(cpus)} of the ${String(cpuBudget)} CPUs of all runs from ${cpuFrom}`;

  const floor = floorOf(ask.floor, machine.env);

  if (floor === undefined) {
    say(`gate run: ${floorRefusal(ask.floor, machine.env)}`);

    return 2;
  }

  if (ask.floor !== undefined && memAvailable(machine.env) === undefined) say("gate run: no MemAvailable here (no /proc/meminfo): --floor is ignored, and only the budget counts");

  // Asked before the gate is: a command no scope caps is counted as the whole budget, one run at a time.
  const scope = scopeHere(machine.env);
  const scoped = scope.scoped;
  let warned = scoped;

  // Said once, when the run asks the gate: without a scope it asks for the whole budget.
  const warn = (does: string): void => {
    if (!warned && !scope.scoped) say(`gate run: warning: ${scope.why}, so nothing caps the command's memory: ${does}`);
    warned = true;
  };

  const arrived = Date.now();
  const deadline = arrived + ask.waitS * 1000;
  const waited = (): number => Math.round((Date.now() - arrived) / 1000);

  const keep = (record: RunRecord): void => {
    try {
      gate.record(record);
    } catch (cause: unknown) {
      say(`gate run: could not keep this run's record: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  // The ceiling, the same for every run: the whole budget. The estimate only admits it.
  const cap = budget.bytes;
  const askedAs = !scoped ? "all (no scope)" : raised !== undefined ? `${spec} raised to the peak` : measured === undefined ? spec : last !== undefined ? "last runs" : "its family's runs";
  // Light: a small estimate, and every one of its last runs short. A first run is never light.
  const light = scoped && last !== undefined && last.ran <= LIGHT_S && estimate <= LIGHT_CAP;
  const marks = { repo: where.repo, workspace: where.workspace, commit: where.commit, estimate: scoped ? estimate : undefined, cpus, landing: ask.landing || undefined, light: light || undefined };
  // What it waited for over the whole wait, each once, and who was before it when it first waited.
  const waitedOn = new Set<WaitedFor>();
  let behind: Behind[] | undefined;
  const waitMarks = (): Pick<RunRecord, "waited_for" | "behind"> => ({ waited_for: waitedOn.size === 0 ? undefined : [...waitedOn], behind: behind?.length === 0 ? undefined : behind });
  const limitS = ask.timeoutS;
  let token: string | undefined;
  let unit = `fleet-gate-${randomBytes(4).toString("hex")}-${process.pid}`;
  let saidWait = false;
  let wasByHand = false;
  let wasShort = false;
  // The gate reads MemAvailable at each ask, under its lock: what others use (dev servers, sessions) comes and goes. A
  // run without a scope asks for the whole budget, and counts its own estimate against the floor.
  const memory: Memory = { floor: floor.bytes, whole: estimate, env: machine.env };

  for (;;) {
    const now = machine.now();

    // A hold taken by hand is its taker's alone, its own name's included: the run waits for it as any other.
    warn("this run asks for the whole budget, one run at a time");

    const result = gate.ask({
      holder, what, seconds: ask.minutes * 60 + HOLD_GRACE_S, cap: scoped ? estimate : undefined, budget: budget.bytes, pid: process.pid, runs: true, waitS: ask.waitS, memory,
      cpus: scoped ? cpus : undefined, cpuBudget, landing: ask.landing, light,
    }, now);

    if ("took" in result) {
      token = result.took.token;
      unit = result.took.unit ?? unit;
      const as = `${ask.landing ? " as a landing gate" : ""}${light ? ", a light run" : ""}`;
      say(`gate run: ${plain(ask.name)} holds the gate${as} (token ${token ?? "?"}, until ${result.took.until ?? "?"})${saidWait ? `, after ${String(waited())}s of waiting` : ""}`);
      break;
    }

    for (const row of waitedFor(result.waiting)) waitedOn.add(row);
    behind ??= behindOf(result.waiting);

    const byHand = result.waiting.holders.some((h) => h.pid === undefined && plain(h.name) === plain(ask.name));

    const byHandText = `${plain(ask.name)} holds the gate by hand, and a gate run never runs under a hold taken by hand: free it with its token first (\`fleet fleets gate free <token>\`)`;
    const why = waitText(result.waiting) + (byHand ? `; ${byHandText}` : "");

    // The first wait line says it; a hold by hand of its own name taken while it waits gets a line of its own.
    if (saidWait && byHand && !wasByHand) say(`gate run: ${byHandText}; still waiting`);
    wasByHand = byHand;

    // So does memory that runs short while it waits for a hold.
    if (saidWait && result.waiting.short !== undefined && !wasShort) say(`gate run: not enough memory: ${shortText(result.waiting.short, "this run")}; still waiting`);
    wasShort = result.waiting.short !== undefined;

    if (Date.now() >= deadline) {
      gate.leave(process.pid, machine.now());
      keep({ name: holder.name, kind: holder.kind, what: command, asked: askedAs, at: stampOf(machine.now()), cap, waited: waited(), ran: null, code: 75, peak: null, killed: 0, cpu_s: null, ...marks, ...waitMarks() });
      say(`gate run: ${why}; gave up after ${ask.waitS}s without running the command (exit 75). Run it again later, or with a longer --wait`);

      return 75;
    }

    if (!saidWait) {
      say(`gate run: ${why}; waiting up to ${ask.waitS}s`);
      saidWait = true;
    }

    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }

  const waitedS = waited();
  let freed = false;

  const free = (): void => {
    if (!freed) {
      if (token !== undefined) gate.free(token, machine.now(), process.pid);
    }

    freed = true;
  };

  const graceS = wholeOr(machine.env, "FLEET_GATE_STOP_GRACE_S", STOP_GRACE_S);
  const weight = scoped ? cpuWeight(machine.env) : undefined;
  const quota = scoped ? cpuShare(machine.env) : undefined;
  const inScope = ["/bin/sh", "-c", IN_SCOPE, "sh", ...ask.command];

  // RuntimeMaxSec: the scope stops itself a grace after the runner would have, so a scope whose runner and watchdog
  // were both killed does not hold its memory, counted by nobody, past the time the run was given.
  // systemd-run rewrites a scope's command as it does a unit's ExecStart (`$$` to `$`, `${VAR}` to its value; the
  // default from systemd 260 on): the command is the caller's, word for word. The option is systemd 254's.
  const asGiven = scope.scoped && scope.systemd >= 254 ? ["--expand-environment=no"] : [];

  const [program = "", ...args] = scoped
    ? ["systemd-run", "--user", "--scope", "--collect", "--quiet", ...asGiven, "--unit", unit, "-p", `MemoryMax=${cap}`, "-p", "MemorySwapMax=0", "-p", "OOMPolicy=continue",
      "-p", `TimeoutStopSec=${graceS}`, "-p", `RuntimeMaxSec=${limitS + graceS}`, ...(quota?.cpus === undefined ? [] : ["-p", `CPUQuota=${String(quota.cpus * 100)}%`]),
      ...(weight === undefined ? ["--", "nice", "-n", String(NICE)] : ["-p", `CPUWeight=${weight}`, "--"]), ...inScope]
    : [...ask.command];

  // $FLEET_GATE_RUN_CPUS, the gate's word to a config on its pool: the quota (else the CPU budget), 8 at most, always the
  // run's own. Not the estimate, which is measured under the pool it would size, so it would slide down run after run;
  // not $FLEET_GATE_CPUS, which a gate run inside this one reads as its quota. No tool's own variable: vitest 4.1.10
  // reads $VITEST_MAX_WORKERS over a project's fileParallelism: false, so a serial suite would race.
  const poolCpus = String(Math.min(POOL_CPUS, quota?.cpus ?? cpuBudget));
  const poolFrom = quota?.cpus === undefined ? `the CPU budget, ${String(POOL_CPUS)} at most: no CPU quota` : `its CPU quota, ${String(POOL_CPUS)} at most`;
  const workersSaid = `; FLEET_GATE_RUN_CPUS=${poolCpus} for a config to size its pool by (${poolFrom})`;

  if (scoped) {
    const share = budget.spec.endsWith("%") ? ` (the budget, ${budget.spec} of ${sizeText(total)} RAM)` : " (the budget)";
    const cpu = weight === undefined ? `nice ${NICE} (no CPU weight: the systemd user manager has no cpu controller, or $FLEET_GATE_CPU_WEIGHT is 0)` : `CPUWeight=${weight}`;
    say(`gate run: running in the systemd scope ${unit}.scope, ${estimateSaid}; MemoryMax=${sizeText(cap)}${share}, no swap, ${cpu}${quota?.said ?? ""}${workersSaid}: ${shown(ask.command)}`);
  } else {
    say(`gate run: running without a memory cap, in a process group of its own, killed whole at its end${workersSaid}: ${shown(ask.command)}`);
  }

  const started = Date.now();
  // The machine's pressure, logged on the record only: at the start, at the end, and the most it reached between.
  const psiStart = pressureNow(machine.env);
  let psiMax = psiStart;
  const sampler = psiStart === undefined ? undefined : setInterval(() => (psiMax = higher(psiMax, pressureNow(machine.env))), wholeOr(machine.env, "FLEET_GATE_PRESSURE_MS", PRESSURE_MS));
  const childEnv: NodeJS.ProcessEnv = { ...process.env, FLEET_GATE_RUN_CPUS: poolCpus };

  if (scoped) childEnv[RUN_MARK] = unit;
  let child: ChildProcess;

  try {
    child = spawn(program, args, { stdio: scoped ? ["inherit", "inherit", "inherit", "pipe"] : "inherit", detached: !scoped, env: childEnv });
  } catch (cause: unknown) {
    clearInterval(sampler);
    free();
    say(`gate run: ${program} could not start: ${cause instanceof Error ? cause.message : String(cause)}`);

    return 127;
  }

  const ended = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: string }>((resolve) => {
    child.once("error", (e) => resolve({ code: null, signal: null, error: e.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  // What the shell in the scope tells on descriptor 3 (IN_SCOPE).
  const pipe = scoped ? child.stdio[3] : undefined;
  let piped = "";

  const pipedWhole = new Promise<void>((resolve) => {
    if (pipe === undefined || pipe === null) {
      resolve();

      return;
    }

    pipe.on("data", (chunk: Buffer | string) => {
      piped += String(chunk);
    });
    pipe.once("close", () => resolve());
    pipe.once("error", () => resolve());
  });

  // What left the scope for an app scope is taken back while the run goes, and once more before its stop.
  const foreign = new Set<string>();
  const swept: Swept = { taken: new Map(), killed: new Map(), failed: new Map() };

  const sweep = (kill = false): void => {
    const own = told(piped, "cgroup");

    if (own !== undefined) sweepApps(own, unit, foreign, kill, swept);
  };

  const sweeper = scoped ? setInterval(() => sweep(), SWEEP_MS) : undefined;
  const pid = child.pid;

  const dog = pid === undefined ? undefined
    : watchdog(process.pid, scoped ? `systemctl --user stop ${unit}.scope >/dev/null 2>&1` : `kill -TERM -- -${pid} 2>/dev/null; i=0; while kill -0 -- -${pid} 2>/dev/null && [ $i -lt ${graceS * 10} ]; do sleep 0.1; i=$((i+1)); done; kill -KILL -- -${pid} 2>/dev/null`);

  let why: "timeout" | NodeJS.Signals | undefined;
  let stopping: Promise<void> | undefined;
  // A stopped scope's shell never tells its end: the runner reads the scope's memory before it stops it.
  let atStop: ScopeMemory = { peak: undefined, killed: undefined, usec: undefined };

  const stop = (reason: "timeout" | NodeJS.Signals): void => {
    if (why !== undefined || pid === undefined) return;
    why = reason;
    say(reason === "timeout" ? `gate run: still running after ${limitS}s: stopping it` : `gate run: ${reason}: stopping the command`);

    stopping = (async () => {
      if (scoped) {
        sweep();
        atStop = memoryNow(told(piped, "cgroup"));
        stopUnit(unit, graceS);

        return;
      }

      signalGroup(pid, "SIGTERM");
      const until = Date.now() + graceS * 1000;

      while (groupAlive(pid) && Date.now() < until) await sleep(50);
      signalGroup(pid, "SIGKILL");
    })();
  };

  const timer = setTimeout(() => stop("timeout"), limitS * 1000);
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  const handlers = signals.map((s) => [s, () => stop(s)] as const);

  for (const [s, handler] of handlers) process.on(s, handler);

  try {
    const end = await ended;
    clearTimeout(timer);
    clearInterval(sampler);
    const psiEnd = psiStart === undefined ? undefined : pressureNow(machine.env);
    psiMax = higher(psiMax, psiEnd);
    await stopping;

    // What the command left behind dies with it, what it left in an app scope too.
    if (scoped) {
      sweep();
      clearInterval(sweeper);
      stopUnit(unit, graceS);
    }
    else if (pid !== undefined) signalGroup(pid, "SIGKILL");

    // A scope whose stop failed or timed out still holds its memory: its hold stays, counted for as long as its
    // cgroup is there (gate.ts), and whoever reads this stops it by name.
    for (const end = Date.now() + SCOPE_GONE_MS; scoped && scopeLives(unit) && Date.now() < end; ) await sleep(50);
    const left = scoped && scopeLives(unit);

    // What left for an app scope after the last sweep, or once the run's scope had emptied, dies now.
    if (scoped) sweep(true);

    if (left) {
      freed = true;
      say(`gate run: the scope ${unit}.scope still has processes after its stop: its hold stays while it does. Stop it: \`systemctl --user stop ${unit}.scope\``);
    } else {
      free();
    }

    await Promise.race([pipedWhole, sleep(1000)]);
    const ranS = (Date.now() - started) / 1000;
    const secs = ranS.toFixed(1);
    const peak = count(told(piped, "peak")) ?? atStop.peak;
    const killed = count(told(piped, "oom_kill")) ?? atStop.killed ?? 0;
    const usec = count(told(piped, "cpu")) ?? atStop.usec;
    const slot = left ? "its hold stays while its scope does" : token === undefined ? "the hold stays its taker's" : "freed the gate";

    const listed = (by: Map<string, Set<number>>, word: string): string => [...by].map(([scope, pids]) => `${String(pids.size)} ${word} ${scope}`).join(", ");

    if (swept.taken.size > 0) say(`gate run: took back into the run's scope the processes of the run that had left it for an app scope (${listed(swept.taken, "from")}): the cap, the memory peak and the stop count them`);

    if (swept.killed.size > 0) say(`gate run: killed the processes of the run left in an app scope after its scope had stopped (${listed(swept.killed, "in")})`);

    for (const [scope, { pids, why }] of swept.failed) say(`gate run: could not take back ${String(pids.size)} from ${scope}: ${why}`);

    if (end.error !== undefined) {
      say(`gate run: ${program} could not run: ${end.error} (exit 127); ${slot}`);

      return 127;
    }

    const code = why === "timeout" ? 124
      : why !== undefined ? 128 + (constants.signals[why] ?? 15)
      : end.code ?? 128 + (end.signal === null ? 9 : (constants.signals[end.signal] ?? 9));

    // oom_kill counts the scope's processes the machine-wide OOM killer took too, not only those its ceiling did.
    if (killed > 0) say(`gate run: ${killed} process(es) of the run killed for memory: the run or the machine ran out (its ceiling MemoryMax=${sizeText(cap)} is the whole budget, ${budget.spec})`);

    const how = why === "timeout" ? `stopped at its ${limitS}s limit after ${secs}s (exit 124)`
      : why !== undefined ? `stopped on ${why} after ${secs}s (exit ${code})`
      : end.signal !== null ? `killed by ${end.signal} after ${secs}s (exit ${code})`
      : `exit ${code} after ${secs}s`;

    const cpuS = usec === undefined ? null : Math.round(usec / 1000) / 1000;
    keep({ name: holder.name, kind: holder.kind, what: command, asked: askedAs, at: stampOf(machine.now()), cap, waited: waitedS, ran: Math.round(ranS * 10) / 10, code, peak: peak ?? null, killed, cpu_s: cpuS, ...marks, ...waitMarks(), psi_start: psiStart, psi_end: psiEnd, psi_max: psiMax });
    say(`gate run: ${how}${peak === undefined ? "" : `, memory peak ${sizeText(peak)}`}; ${slot}`);

    return code;
  } finally {
    for (const [s, handler] of handlers) process.off(s, handler);

    if (dog?.pid !== undefined) {
      try {
        process.kill(-dog.pid, "SIGKILL");
      } catch {
        // gone already
      }
    }

    clearTimeout(timer);
    clearInterval(sweeper);
    clearInterval(sampler);
    free();
  }
}
