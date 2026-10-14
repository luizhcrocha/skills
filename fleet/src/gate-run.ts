/**
 * `fleet fleets gate run FLEET|--as NAME [--wait SECONDS] [--for MINUTES] [--timeout SECONDS] [--mem SIZE] -- COMMAND...`:
 * a test suite run through the gate, as one process tree that dies whole. It takes its part of the gate's memory
 * budget (gate.ts: `--mem`, else $FLEET_GATE_MEMORY_MAX, else a quarter of the RAM, so two default runs fit the
 * budget at once), waiting in the gate's queue up to `--wait`, then runs COMMAND in a transient systemd user scope
 * capped at that memory, with no swap and OOMPolicy=continue (the kernel kills the hog, the suite sees it fail) and
 * a CPU weight, so two runs share the cores evenly whatever each one's thread count. On any end (exit, failure,
 * `--timeout` or the hold's `--for` running out, a signal) it stops the scope, so every process the command started
 * dies with it, frees its hold, keeps one line about the run (gate.ts's `runs.jsonl`: the wait, the time, the
 * scope's memory peak) and exits with the command's code. A scope that still has processes after its stop keeps its
 * hold, and the run says so. Where there is no systemd user manager (the Mac), the command runs in a process group
 * of its own, killed whole at its end, without a memory cap, and it says so: it is then counted as the whole budget.
 * A run never goes under a hold taken by hand, its own name's included: it waits for that hold as for any other.
 *
 * The runner's own death is covered twice: the hold carries the runner's pid, so it lapses when the runner is
 * gone, and a small watchdog, outside the runner's process group, stops the scope (or kills the group) when the
 * runner dies without cleaning up (SIGKILL). */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";

import { stampOf } from "./clock.ts";
import { readText } from "./files.ts";
import { budgetOf, capBytes, DEFAULT_CAP, gateOf, holdText, memTotal, plain, scopeLives, sizeText, type GateHolder, type RunRecord, type Waiting } from "./gate.ts";
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

/** How long the systemd user manager has to answer the probe for a scope. */
const SCOPE_PROBE_MS = 5000;

/** Seconds a stopped command has between SIGTERM and SIGKILL. */
const STOP_GRACE_S = 5;

/** How long a stopped scope's cgroup has to go, once `systemctl stop` has answered, before it is taken as still there. */
const SCOPE_GONE_MS = 1000;

/** What `gate run` was asked to do. */
export interface RunAsk {
  readonly name: string;
  readonly command: readonly string[];
  readonly waitS: number;
  readonly minutes: number;
  readonly mem: string | undefined;
  /** Seconds the command may run before it is stopped; its hold's `--for` when not given. */
  readonly timeoutS: number;
}

export const RUN_USAGE = "usage: fleet fleets gate run FLEET|--as NAME [--wait SECONDS] [--for MINUTES] [--timeout SECONDS] [--mem SIZE|PERCENT] -- COMMAND...";

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
  let timeoutS: number | undefined;

  for (let i = 0; i < own.length; i += 1) {
    const word = own[i] ?? "";
    const value = own[i + 1];

    if (word === "--as" || word === "--wait" || word === "--for" || word === "--mem" || word === "--timeout") {
      if (value === undefined) return undefined;
      i += 1;

      if (word === "--as") as = value.trim();
      else if (word === "--wait") waitS = /^[0-9]+$/.test(value) ? Number(value) : -1;
      else if (word === "--for") minutes = /^[0-9]+$/.test(value) ? Number(value) : 0;
      else if (word === "--timeout") timeoutS = /^[0-9]+$/.test(value) ? Number(value) : 0;
      else mem = value.trim();
    } else {
      words.push(word);
    }
  }

  if (waitS < 0 || minutes <= 0 || timeoutS === 0 || as === "" || mem === "") return undefined;
  const name = as ?? (words.length === 1 ? words[0] : undefined);

  if (name === undefined || (as !== undefined && words.length > 0) || words.length > 1) return undefined;

  return { name, command, waitS, minutes, mem, timeoutS: Math.min(timeoutS ?? minutes * 60, minutes * 60) };
}

/** Whether a systemd user manager answers here, so a transient scope can hold the command: `why` says why not.
 * $FLEET_GATE_SCOPE=0 says no. A manager that does not answer in time (a loaded machine) is not one that is
 * absent, and `why` says which. `systemd` is the manager's version. */
export function scopeHere(env: (name: string) => string | undefined): { readonly scoped: true; readonly systemd: number } | { readonly scoped: false; readonly why: string } {
  if (env("FLEET_GATE_SCOPE") === "0") return { scoped: false, why: "$FLEET_GATE_SCOPE is 0" };

  if (process.platform !== "linux" || Bun.which("systemd-run") === null || Bun.which("systemctl") === null) return { scoped: false, why: "no systemd user manager here" };
  const done = spawnSync("systemctl", ["--user", "show", "--property=Version"], { encoding: "utf8", timeout: SCOPE_PROBE_MS });

  if (done.error === undefined && done.status === 0) return { scoped: true, systemd: Number(/^Version=(\d+)/m.exec(done.stdout)?.[1] ?? 0) };

  return { scoped: false, why: done.error === undefined ? `systemctl --user failed (exit ${String(done.status)})` : `systemctl --user did not answer in ${String(SCOPE_PROBE_MS / 1000)}s (${done.error.message})` };
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

/** The shell that runs the command inside the scope. On descriptor 3, which the command does not get, it tells the
 * runner its cgroup, and at the end the scope's memory peak and how many processes the cap killed, read before the
 * scope (gone with its last process) takes them with it. */
const IN_SCOPE = 'cg=/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup); echo "cgroup $cg" >&3; "$@" 3>&-; rc=$?; ' +
  'echo "peak $(cat "$cg/memory.peak" 2>/dev/null)" >&3; echo "oom_kill $(sed -n "s/^oom_kill //p" "$cg/memory.events" 2>/dev/null)" >&3; exit $rc';

/** What a scope's memory did: its peak in bytes and how many processes its cap killed, where known. */
interface ScopeMemory {
  readonly peak: number | undefined;
  readonly killed: number | undefined;
}

function count(text: string | undefined): number | undefined {
  return text !== undefined && /^[0-9]+$/.test(text.trim()) ? Number(text.trim()) : undefined;
}

/** The memory of the scope whose cgroup directory is `cgroup`, read from the kernel now. */
function memoryNow(cgroup: string | undefined): ScopeMemory {
  if (cgroup === undefined) return { peak: undefined, killed: undefined };

  return { peak: count(readText(`${cgroup}/memory.peak`)), killed: count(/^oom_kill (\d+)$/m.exec(readText(`${cgroup}/memory.events`) ?? "")?.[1]) };
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

function stopUnit(unit: string): void {
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore", timeout: (STOP_GRACE_S + 10) * 1000 });
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

/** Why a run waits, in words: who holds the gate, and its place in the queue. */
function waitText(waiting: Waiting): string {
  const held = waiting.holders.length === 0 ? "the gate is free, but others wait before it" : `the gate is ${waiting.holders.map(holdText).join("; and ")}`;
  const behind = waiting.ahead.length === 0 ? "" : `, behind ${waiting.ahead.map((w) => plain(w.name)).join(", ")}`;

  return `${held}; place ${String(waiting.ahead.length + 1)} in the queue${behind}`;
}

const sleep = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/** Where a run says what it does: its stderr. */
export interface Say {
  (line: string): void;
}

/** Run `ask` through the gate; the exit code (the command's, 124 when its time ran out, 128+N on signal N, 75 when
 * the gate had no room for it within `--wait` and nothing ran, 2 when its cap or the budget cannot be read or the
 * cap is more than the budget). */
export async function gateRun(machine: Machine, ask: RunAsk, say: Say): Promise<number> {
  const gate = gateOf(machine.registry);
  const holder: GateHolder = { name: ask.name, kind: machine.registry.live().some((e) => e.id === ask.name) ? "fleet" : "session" };
  const what = `gate run: ${shown(ask.command)}`;
  const budget = budgetOf(machine.env);

  if (budget === undefined) {
    say(`gate run: cannot read the budget of all runs together, $FLEET_GATE_MEMORY_BUDGET='${machine.env("FLEET_GATE_MEMORY_BUDGET") ?? ""}': give a share of the RAM (50%) or a size (24G), 64M at least`);

    return 2;
  }

  const total = memTotal();
  const given = ask.mem ?? machine.env("FLEET_GATE_MEMORY_MAX");
  const spec = given ?? DEFAULT_CAP;
  const parsed = capBytes(spec, total);

  if (parsed === undefined) {
    say(`gate run: cannot read the memory cap '${spec}': give a share of the RAM (25%) or a size (24G), 64M at least`);

    return 2;
  }

  // The default follows a smaller budget down; a cap someone gave is theirs to change.
  const wanted = given === undefined ? Math.min(parsed, budget.bytes) : parsed;

  const over = (limit: number, whose: string): string =>
    `gate run: the memory cap '${spec}' (${sizeText(parsed)}) is more than ${whose} (${sizeText(limit)}): ask for at most that`;

  if (wanted > budget.bytes) {
    say(over(budget.bytes, `the budget of all runs together, ${budget.spec}`));

    return 2;
  }

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
  const first = shown(ask.command.slice(0, 6), 80);

  const keep = (record: RunRecord): void => {
    try {
      gate.record(record);
    } catch (cause: unknown) {
      say(`gate run: could not keep this run's record: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  const cap = scoped ? wanted : budget.bytes;
  const askedAs = scoped ? spec : "all (no scope)";
  const limitS = ask.timeoutS;
  let token: string | undefined;
  let unit = `fleet-gate-${randomBytes(4).toString("hex")}-${process.pid}`;
  let saidWait = false;
  let wasByHand = false;

  for (;;) {
    const now = machine.now();

    // A hold taken by hand is its taker's alone, its own name's included: the run waits for it as any other.
    warn("this run asks for the whole budget, one run at a time");
    const result = gate.ask({ holder, what, seconds: ask.minutes * 60 + HOLD_GRACE_S, cap: scoped ? wanted : undefined, budget: budget.bytes, pid: process.pid, runs: true, waitS: ask.waitS }, now);

    if ("took" in result) {
      token = result.took.token;
      unit = result.took.unit ?? unit;
      say(`gate run: ${plain(ask.name)} holds the gate (token ${token ?? "?"}, until ${result.took.until ?? "?"})${saidWait ? `, after ${String(waited())}s of waiting` : ""}`);
      break;
    }

    const byHand = result.waiting.holders.some((h) => h.pid === undefined && plain(h.name) === plain(ask.name));

    const byHandText = `${plain(ask.name)} holds the gate by hand, and a gate run never runs under a hold taken by hand: free it with its token first (\`fleet fleets gate free <token>\`)`;
    const why = waitText(result.waiting) + (byHand ? `; ${byHandText}` : "");

    // The first wait line says it; a hold by hand of its own name taken while it waits gets a line of its own.
    if (saidWait && byHand && !wasByHand) say(`gate run: ${byHandText}; still waiting`);
    wasByHand = byHand;

    if (Date.now() >= deadline) {
      gate.leave(process.pid, machine.now());
      keep({ name: holder.name, kind: holder.kind, what: first, asked: askedAs, at: stampOf(machine.now()), cap, waited: waited(), ran: null, code: 75, peak: null, killed: 0 });
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

  const weight = scoped ? cpuWeight(machine.env) : undefined;
  const inScope = ["/bin/sh", "-c", IN_SCOPE, "sh", ...ask.command];

  // RuntimeMaxSec: the scope stops itself a grace after the runner would have, so a scope whose runner and watchdog
  // were both killed does not hold its memory, counted by nobody, past the time the run was given.
  // systemd-run rewrites a scope's command as it does a unit's ExecStart (`$$` to `$`, `${VAR}` to its value; the
  // default from systemd 260 on): the command is the caller's, word for word. The option is systemd 254's.
  const asGiven = scope.scoped && scope.systemd >= 254 ? ["--expand-environment=no"] : [];

  const [program = "", ...args] = scoped
    ? ["systemd-run", "--user", "--scope", "--collect", "--quiet", ...asGiven, "--unit", unit, "-p", `MemoryMax=${cap}`, "-p", "MemorySwapMax=0", "-p", "OOMPolicy=continue",
      "-p", `TimeoutStopSec=${STOP_GRACE_S}`, "-p", `RuntimeMaxSec=${limitS + STOP_GRACE_S}`,
      ...(weight === undefined ? ["--", "nice", "-n", String(NICE)] : ["-p", `CPUWeight=${weight}`, "--"]), ...inScope]
    : [...ask.command];

  if (scoped) {
    const share = cap === parsed && spec.endsWith("%") ? ` (${spec} of ${sizeText(total)} RAM)` : "";
    const cpu = weight === undefined ? `nice ${NICE} (no CPU weight: the systemd user manager has no cpu controller, or $FLEET_GATE_CPU_WEIGHT is 0)` : `CPUWeight=${weight}`;
    say(`gate run: running in the systemd scope ${unit}.scope, MemoryMax=${sizeText(cap)}${share}, no swap, ${cpu}: ${shown(ask.command)}`);
  } else {
    say(`gate run: running without a memory cap, in a process group of its own, killed whole at its end: ${shown(ask.command)}`);
  }

  const started = Date.now();
  let child: ChildProcess;

  try {
    child = spawn(program, args, { stdio: scoped ? ["inherit", "inherit", "inherit", "pipe"] : "inherit", detached: !scoped, env: process.env });
  } catch (cause: unknown) {
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

  const pid = child.pid;

  const dog = pid === undefined ? undefined
    : watchdog(process.pid, scoped ? `systemctl --user stop ${unit}.scope >/dev/null 2>&1` : `kill -TERM -- -${pid} 2>/dev/null; i=0; while kill -0 -- -${pid} 2>/dev/null && [ $i -lt ${STOP_GRACE_S * 10} ]; do sleep 0.1; i=$((i+1)); done; kill -KILL -- -${pid} 2>/dev/null`);

  let why: "timeout" | NodeJS.Signals | undefined;
  let stopping: Promise<void> | undefined;
  // A stopped scope's shell never tells its end: the runner reads the scope's memory before it stops it.
  let atStop: ScopeMemory = { peak: undefined, killed: undefined };

  const stop = (reason: "timeout" | NodeJS.Signals): void => {
    if (why !== undefined || pid === undefined) return;
    why = reason;
    say(reason === "timeout" ? `gate run: still running after ${limitS}s: stopping it` : `gate run: ${reason}: stopping the command`);

    stopping = (async () => {
      if (scoped) {
        atStop = memoryNow(told(piped, "cgroup"));
        stopUnit(unit);

        return;
      }

      signalGroup(pid, "SIGTERM");
      const until = Date.now() + STOP_GRACE_S * 1000;

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
    await stopping;

    // What the command left behind dies with it.
    if (scoped) stopUnit(unit);
    else if (pid !== undefined) signalGroup(pid, "SIGKILL");

    // A scope whose stop failed or timed out still holds its memory: its hold stays, counted for as long as its
    // cgroup is there (gate.ts), and whoever reads this stops it by name.
    for (const end = Date.now() + SCOPE_GONE_MS; scoped && scopeLives(unit) && Date.now() < end; ) await sleep(50);
    const left = scoped && scopeLives(unit);

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
    const slot = left ? "its hold stays while its scope does" : token === undefined ? "the hold stays its taker's" : "freed the gate";

    if (end.error !== undefined) {
      say(`gate run: ${program} could not run: ${end.error} (exit 127); ${slot}`);

      return 127;
    }

    const code = why === "timeout" ? 124
      : why !== undefined ? 128 + (constants.signals[why] ?? 15)
      : end.code ?? 128 + (end.signal === null ? 9 : (constants.signals[end.signal] ?? 9));

    if (killed > 0) {
      const who = holder.kind === "fleet" ? quoted([ask.name]) : `--as ${quoted([ask.name])}`;
      const kept = `${ask.waitS > 0 ? ` --wait ${ask.waitS}` : ""}${ask.minutes === RUN_MINUTES ? "" : ` --for ${ask.minutes}`}${ask.timeoutS === ask.minutes * 60 ? "" : ` --timeout ${ask.timeoutS}`}`;

      const next = cap < budget.bytes ? `Run it again with the whole budget: \`fleet fleets gate run ${who}${kept} --mem ${budget.spec} -- ${quoted(ask.command)}\``
        : `It had the whole budget (${budget.spec}, ${sizeText(budget.bytes)}): the command needs fewer processes at once`;

      say(`gate run: the memory cap (MemoryMax=${sizeText(cap)}) killed ${killed} process(es). ${next}`);
    }

    const how = why === "timeout" ? `stopped at its ${limitS}s limit after ${secs}s (exit 124)`
      : why !== undefined ? `stopped on ${why} after ${secs}s (exit ${code})`
      : end.signal !== null ? `killed by ${end.signal} after ${secs}s (exit ${code})`
      : `exit ${code} after ${secs}s`;

    keep({ name: holder.name, kind: holder.kind, what: first, asked: askedAs, at: stampOf(machine.now()), cap, waited: waitedS, ran: Math.round(ranS * 10) / 10, code, peak: peak ?? null, killed });
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
    free();
  }
}
