/**
 * The processes the preview starts and later stops (dev servers, their keepers, the updater), each recorded
 * with what proves it is still the same process: its pid, when it started (`/proc/PID/stat`; `ps -o lstart`
 * on the Mac), and, where a systemd user manager runs, the transient scope it runs in. A pid in
 * `preview.json` outlives its process (a reboot, a crash): before any signal its start time is read again,
 * and a pid that no longer has it is never signalled.
 *
 * A process in a scope is stopped by its scope (`systemctl --user stop`), which takes everything it
 * started, a double fork included; the scope's name is new for each start, so it never names another's.
 * Without a scope only the process's own tree is signalled, each pid while it is still the one first seen
 * (its children, and on Linux the members of the session it leads), never a process group, as
 * `stopTree` does for an orphan.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { readText } from "../files.ts";
import { childrenOf, processTable, treeOf, type ProcRow } from "../orphans.ts";
import { alive } from "../registry.ts";

/** A process the preview started. */
export interface Tracked {
  readonly pid: number;
  /** When it started, in epoch seconds; null for a record written before start times were kept. */
  readonly started: number | null;
  /** The systemd user scope it runs in (without `.scope`), or null. */
  readonly unit: string | null;
  /** How far, in seconds, its start time may be from `started`: 1, or more when `started` is only the
   * second its record was written (a record from before start times were kept). */
  readonly slack?: number;
}

const DARWIN = process.platform === "darwin";

const TICKS = 100;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Whether process `pid` runs: it exists and is not a zombie waiting for its parent to reap it (a dev
 * server stopped while the process that started it still runs). */
export function isRunning(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || !alive(pid)) return false;

  if (DARWIN) return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().startsWith("Z");
  const stat = readText(`/proc/${pid}/stat`);

  return stat === undefined || stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
}

/** `ps -o lstart=` (`Mon Oct 12 14:34:03 2026`, local time) in epoch seconds, or undefined. */
export function lstartOf(text: string): number | undefined {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text);
  const month = MONTHS.indexOf(m?.[1] ?? "");

  if (m === null || month < 0) return undefined;

  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime() / 1000;
}

/** When process `pid` started, in epoch seconds, or undefined when it is gone. On Linux the same figure the
 * process table (`orphans.ts`) gives. */
export function startedAt(pid: number): number | undefined {
  if (DARWIN) return lstartOf(spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout ?? "");
  const boot = Number(/^btime (\d+)/m.exec(readText("/proc/stat") ?? "")?.[1]);
  const stat = readText(`/proc/${pid}/stat`);

  if (stat === undefined || Number.isNaN(boot)) return undefined;
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);

  return Number.isNaN(ticks) ? undefined : boot + ticks / TICKS;
}

/** `pid`, just started (in `unit`, when given), with its start time read now. */
export function track(pid: number, unit: string | null): Tracked {
  return { pid, started: startedAt(pid) ?? null, unit };
}

/** Whether `t` still runs as the process recorded: the pid runs, is no zombie, and started when it did. A
 * record with no start time is no proof, and counts as gone. */
export function runs(t: Tracked | null): boolean {
  if (t === null || t.started === null || !isRunning(t.pid)) return false;
  const now = startedAt(t.pid);

  return now !== undefined && Math.abs(now - t.started) < (t.slack ?? 1);
}

/** Whether the preview starts its processes in systemd user scopes: on Linux, with `systemd-run` and a user
 * manager that answers, unless `FLEET_PREVIEW_SCOPE=0`. */
export function scopes(env: (name: string) => string | undefined): boolean {
  if (env("FLEET_PREVIEW_SCOPE") === "0" || process.platform !== "linux") return false;
  const path = env("PATH");
  const where = path === undefined ? {} : { PATH: path };

  if (Bun.which("systemd-run", where) === null || Bun.which("systemctl", where) === null) return false;
  const done = spawnSync("systemctl", ["--user", "show", "--property=Version"], { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: path } });

  return done.error === undefined && done.status === 0;
}

/** A new scope name for a process of the preview: `fleet-preview-<what>-<random>`. */
export function unitName(what: string): string {
  return `fleet-preview-${what.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60)}-${randomBytes(4).toString("hex")}`;
}

/** Seconds a scope's processes have between TERM and KILL when it is stopped. */
const SCOPE_GRACE_S = 3;

/** `argv` run in a new transient scope `unit` (systemd-run execs it there: the pid is the command's). */
export function inScope(unit: string, argv: readonly string[]): string[] {
  return ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--unit", unit, "-p", `TimeoutStopSec=${SCOPE_GRACE_S}`, "--", ...argv];
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // gone already, or not ours
  }
}

/** Whether `row` still runs as the same process in `table` (not a zombie, not a reused pid). */
function same(row: ProcRow, table: readonly ProcRow[]): boolean {
  const now = table.find((r) => r.pid === row.pid);

  return now !== undefined && Math.abs(now.started - row.started) < 1 && isRunning(row.pid);
}

/** The rows of `t`'s tree in `table`: it, its descendants, and on Linux the members of the session it leads
 * (a dev server is started as a session leader), each started no earlier than it. Empty when `t` is not the
 * process recorded. */
export function treeRows(t: Tracked, table: readonly ProcRow[]): ProcRow[] {
  const root = table.find((r) => r.pid === t.pid);

  if (root === undefined || t.started === null || Math.abs(root.started - t.started) >= (t.slack ?? 1)) return [];
  const kids = childrenOf(table);
  const pids = new Set(treeOf(root.pid, kids));

  for (const r of table) if (r.sid === root.pid && r.started >= root.started - 1) for (const p of treeOf(r.pid, kids)) pids.add(p);

  return table.filter((r) => pids.has(r.pid) && r.pid > 1);
}

/** TERM each of `rows`, then KILL what is still the same process after `graceMs`; whether all are gone. */
function stopRows(rows: readonly ProcRow[], graceMs: number, table: () => ProcRow[]): boolean {
  for (const r of rows) signal(r.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  let rest = rows.filter((r) => same(r, table()));

  while (rest.length > 0 && Date.now() < deadline) {
    Bun.sleepSync(50);
    const now = table();
    rest = rest.filter((r) => same(r, now));
  }

  for (const r of rest) signal(r.pid, "SIGKILL");

  if (rest.length > 0) Bun.sleepSync(100);
  const after = table();

  return rest.every((r) => !same(r, after));
}

/** `systemctl --user stop UNIT.scope`: everything left in the scope, TERM then KILL. */
function stopScope(unit: string, path: string | undefined): void {
  const env = { ...process.env };

  if (path !== undefined) env["PATH"] = path;
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore", timeout: (SCOPE_GRACE_S + 10) * 1000, env });
}

/**
 * Stop `t` and what it started, synchronously: by its scope when it has one (what is left of it too, after
 * its leader is gone), else its tree while it is still the process recorded. A pid that no longer started
 * when it did is never signalled. Whether nothing of it runs after.
 */
export function stopTracked(t: Tracked | null, options: { readonly graceMs?: number; readonly path?: string | undefined; readonly table?: () => ProcRow[] } = {}): boolean {
  if (t === null) return true;
  const table = options.table ?? (() => processTable());

  if (t.unit !== null) stopScope(t.unit, options.path);

  if (!runs(t)) return true;

  return stopRows(treeRows(t, table()), options.graceMs ?? 3000, table) && !runs(t);
}
