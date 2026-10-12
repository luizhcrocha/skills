/**
 * `fleet fleets gate run FLEET|--as NAME [--wait SECONDS] [--for MINUTES] [--timeout SECONDS] [--mem SIZE] -- COMMAND...`:
 * a full test suite run through the gate slot, as one process tree that dies whole. It takes the slot (waiting up
 * to `--wait`), runs COMMAND in a transient systemd user scope capped at `--mem` (default half the RAM, or
 * $FLEET_GATE_MEMORY_MAX), with no swap and OOMPolicy=continue (the kernel kills the hog, the suite sees it fail),
 * and on any end (exit, failure, `--timeout` or the hold's `--for` running out, a signal) stops the scope, so every
 * process the command started dies with it, frees the slot, and exits with the command's code. Where there is no
 * systemd user manager (the Mac), the command runs in a process group of its own, killed whole at its end, without
 * a memory cap, and it says so.
 *
 * The runner's own death is covered twice: the hold carries the runner's pid, so the slot lapses when the
 * runner is gone, and a small watchdog, outside the runner's process group, stops the scope (or kills the
 * group) when the runner dies without cleaning up (SIGKILL). */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { constants } from "node:os";

import type { JsonObject } from "./json.ts";
import { asString } from "./json.ts";
import type { GateHolder } from "./registry.ts";
import type { Machine } from "./world.ts";

/** How long a run holds the slot when `--for` does not say; the command is stopped when it runs out. */
export const RUN_MINUTES = 60;

/** The share of the RAM a run may use when neither `--mem` nor $FLEET_GATE_MEMORY_MAX says. */
export const DEFAULT_CAP = "50%";

/** Seconds a stopped command has between SIGTERM and SIGKILL. */
const STOP_GRACE_S = 5;

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

/** The machine's RAM in bytes (/proc/meminfo's MemTotal), or undefined off Linux. */
export function memTotal(): number | undefined {
  try {
    const kb = /^MemTotal:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];

    return kb === undefined ? undefined : Number(kb) * 1024;
  } catch {
    return undefined;
  }
}

const UNITS = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 } as const;

function unitScale(unit: string): number {
  return Object.entries(UNITS).find(([u]) => u === unit)?.[1] ?? 1;
}

/** The cap in bytes `spec` names (`50%` of `total`, `24G`, `512M`, a byte count), or undefined when it does not parse. */
export function capBytes(spec: string, total: number | undefined): number | undefined {
  const share = /^(\d+(?:\.\d+)?)%$/.exec(spec);

  if (share !== null) {
    const pct = Number(share[1]);

    return total === undefined || pct <= 0 || pct > 100 ? undefined : Math.floor((total * pct) / 100);
  }

  const size = /^(\d+(?:\.\d+)?)([KMGT]?)i?B?$/i.exec(spec);

  if (size === null) return undefined;
  const bytes = Math.floor(Number(size[1]) * unitScale((size[2] ?? "").toUpperCase()));

  return bytes > 0 ? bytes : undefined;
}

/** `bytes` as people read it: `31.0G`. */
export function sizeText(bytes: number): string {
  for (const unit of ["T", "G", "M", "K"]) {
    const scale = unitScale(unit);

    if (bytes >= scale) return `${(bytes / scale).toFixed(1)}${unit}`;
  }

  return `${bytes}B`;
}

/** Whether a systemd user manager answers here, so a transient scope can hold the command. $FLEET_GATE_SCOPE=0 says no. */
export function scopeAvailable(env: (name: string) => string | undefined): boolean {
  if (env("FLEET_GATE_SCOPE") === "0" || process.platform !== "linux") return false;

  if (Bun.which("systemd-run") === null || Bun.which("systemctl") === null) return false;
  const done = spawnSync("systemctl", ["--user", "show", "--property=Version"], { encoding: "utf8", timeout: 5000 });

  return done.error === undefined && done.status === 0;
}

/** The shell that runs the command inside the scope: it says when the cap killed something, read from the
 * scope's memory.events before the scope (gone with its last process) takes the count with it. */
function capped(cap: number): string {
  return 'ev=/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)/memory.events; "$@"; rc=$?; ' +
    'k=$(sed -n "s/^oom_kill //p" "$ev" 2>/dev/null); ' +
    `if [ "\${k:-0}" -gt 0 ]; then echo "gate run: the memory cap (MemoryMax=${sizeText(cap)}) killed $k process(es)" >&2; fi; exit $rc`;
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

/** The quoted words of a command, for the slot's `what` and the messages. */
function shown(command: readonly string[]): string {
  const text = command.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)).join(" ");

  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

const sleep = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/** Where a run says what it does: its stderr. */
export interface Say {
  (line: string): void;
}

/** Run `ask` through the slot; the exit code (the command's, 124 when its time ran out, 128+N on signal N, 75 when
 * the slot stayed held past `--wait` and nothing ran). One run per hold: under a hold its own name took by hand, a
 * run marks itself the hold's runner, and a second run waits for the first as for any other holder. */
export async function gateRun(machine: Machine, ask: RunAsk, say: Say): Promise<number> {
  const registry = machine.registry;
  const holder: GateHolder = { name: ask.name, kind: registry.live().some((e) => e.id === ask.name) ? "fleet" : "session" };
  const what = `gate run: ${shown(ask.command)}`;
  const deadline = Date.now() + ask.waitS * 1000;
  let token: string | undefined;
  let joined = false;
  let saidWait = false;

  for (;;) {
    const result = registry.takeGate(holder, what, machine.now(), ask.minutes, process.pid);

    if ("took" in result) {
      token = asString(result.took["token"]);
      say(`gate run: ${ask.name} holds the gate (token ${token ?? "?"}, until ${asString(result.took["until"]) ?? "?"})`);
      break;
    }

    let held: JsonObject = result.held;
    let busy = false;

    // A hold its own name took by hand covers one run at a time: a second run under it waits like any other.
    if (held["fleet"] === ask.name && held["pid"] === undefined) {
      const join = registry.joinGate(ask.name, process.pid, machine.now());

      if ("joined" in join) {
        joined = true;
        say(`gate run: ${ask.name} already holds the gate (${asString(held["what"]) ?? ""}); running under that hold, which its taker frees`);
        break;
      }

      if (join.held === undefined) continue;
      held = join.held;
      busy = held["fleet"] === ask.name && held["pid"] === undefined;
    }

    const who = busy ? `${ask.name}'s hold already has a gate run (pid ${String(held["runner"])})` : `the gate is held by ${asString(held["fleet"]) ?? "?"}`;

    if (Date.now() >= deadline) {
      say(`gate run: ${who} since ${asString(held["since"]) ?? "?"}: ${asString(held["what"]) ?? ""}; ` +
        `gave up after ${ask.waitS}s without running the command (exit 75). Run it again later, or with a longer --wait`);

      return 75;
    }

    if (!saidWait) {
      say(`gate run: ${who}: ${asString(held["what"]) ?? ""}; waiting up to ${ask.waitS}s`);
      saidWait = true;
    }

    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }

  let freed = false;

  const free = (): void => {
    if (!freed) {
      if (token !== undefined) registry.freeGate(token, machine.now());
      else if (joined) registry.leaveGate(process.pid, machine.now());
    }

    freed = true;
  };

  const scoped = scopeAvailable(machine.env);
  const total = memTotal();
  const spec = ask.mem ?? machine.env("FLEET_GATE_MEMORY_MAX") ?? DEFAULT_CAP;
  const cap = capBytes(spec, total);

  if (scoped && cap === undefined) {
    free();
    say(`gate run: cannot read the memory cap '${spec}': give a share of the RAM (50%) or a size (24G)`);

    return 2;
  }

  const unit = `fleet-gate-${token ?? randomBytes(4).toString("hex")}-${process.pid}`;

  const [program = "", ...args] = scoped
    ? ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--unit", unit, "-p", `MemoryMax=${cap ?? 0}`, "-p", "MemorySwapMax=0", "-p", "OOMPolicy=continue",
      "-p", `TimeoutStopSec=${STOP_GRACE_S}`, "--", "/bin/sh", "-c", capped(cap ?? 0), "sh", ...ask.command]
    : [...ask.command];

  if (scoped) {
    const share = total === undefined || !spec.endsWith("%") ? "" : ` (${spec} of ${sizeText(total)} RAM)`;
    say(`gate run: running in the systemd scope ${unit}.scope, MemoryMax=${sizeText(cap ?? 0)}${share}, no swap: ${shown(ask.command)}`);
  } else {
    say(`gate run: warning: no systemd user manager here, so no memory cap: the command runs in a process group of its own, killed whole at its end: ${shown(ask.command)}`);
  }

  const started = Date.now();
  let child: ChildProcess;

  try {
    child = spawn(program, args, { stdio: "inherit", detached: !scoped, env: process.env });
  } catch (cause: unknown) {
    free();
    say(`gate run: ${program} could not start: ${cause instanceof Error ? cause.message : String(cause)}`);

    return 127;
  }

  const ended = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: string }>((resolve) => {
    child.once("error", (e) => resolve({ code: null, signal: null, error: e.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const pid = child.pid;

  const dog = pid === undefined ? undefined
    : watchdog(process.pid, scoped ? `systemctl --user stop ${unit}.scope >/dev/null 2>&1` : `kill -TERM -- -${pid} 2>/dev/null; i=0; while kill -0 -- -${pid} 2>/dev/null && [ $i -lt ${STOP_GRACE_S * 10} ]; do sleep 0.1; i=$((i+1)); done; kill -KILL -- -${pid} 2>/dev/null`);

  let why: "timeout" | NodeJS.Signals | undefined;
  let stopping: Promise<void> | undefined;

  const stop = (reason: "timeout" | NodeJS.Signals): void => {
    if (why !== undefined || pid === undefined) return;
    why = reason;
    say(reason === "timeout" ? `gate run: still running after ${ask.timeoutS}s: stopping it` : `gate run: ${reason}: stopping the command`);

    stopping = (async () => {
      if (scoped) {
        stopUnit(unit);

        return;
      }

      signalGroup(pid, "SIGTERM");
      const until = Date.now() + STOP_GRACE_S * 1000;

      while (groupAlive(pid) && Date.now() < until) await sleep(50);
      signalGroup(pid, "SIGKILL");
    })();
  };

  const timer = setTimeout(() => stop("timeout"), ask.timeoutS * 1000);
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

    free();
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    const slot = token === undefined ? "the hold stays its taker's" : "freed the gate";

    if (end.error !== undefined) {
      say(`gate run: ${program} could not run: ${end.error} (exit 127); ${slot}`);

      return 127;
    }

    const code = why === "timeout" ? 124
      : why !== undefined ? 128 + (constants.signals[why] ?? 15)
      : end.code ?? 128 + (end.signal === null ? 9 : (constants.signals[end.signal] ?? 9));

    const how = why === "timeout" ? `stopped at its ${ask.timeoutS}s limit after ${secs}s (exit 124)`
      : why !== undefined ? `stopped on ${why} after ${secs}s (exit ${code})`
      : end.signal !== null ? `killed by ${end.signal} after ${secs}s (exit ${code})`
      : `exit ${code} after ${secs}s`;

    say(`gate run: ${how}; ${slot}`);

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
