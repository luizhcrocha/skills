/**
 * The gate reaper's shell (reaper.ts is its core): the machine read into a {@link Snapshot}, the audit log and the
 * real signals. `$FLEET_REAPER_SNAPSHOT` hands a whole snapshot, as `$FLEET_MEMINFO` hands the memory, for a test's
 * table; only a read-only `gate hogs` reads it, and a kill refuses it.
 */
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { stampOf } from "./clock.ts";
import { exists, makeDirs, readText, writeText } from "./files.ts";
import { floorOf, memAvailable, memTotal, type Standing } from "./gate.ts";
import { withLockAt } from "./lock.ts";
import { isClaude, previewPids, processTable, REAL_STOP, recordsOf, sessionOf, workspaceOf, type ProcRow } from "./orphans.ts";
import { DEFAULTS, judge, resumedIn, type AuditLine, type AuditLog, type KillIo, type Report, type Snapshot } from "./reaper.ts";
import { sessionFolderOf } from "./transcripts.ts";
import type { Machine } from "./world.ts";

/** The audit log's lines kept, as the gate keeps its runs: it is cut when twice this long. */
const LINES_KEPT = 1000;

/** The audit log in `dir`: `reaper.jsonl`, written under `reaper.lock`, which is not the gate's. */
export function fileAuditLog(dir: string): AuditLog {
  const path = join(dir, "reaper.jsonl");

  const lines = (): string[] => (readText(path) ?? "").split("\n").filter((line) => line !== "");

  return {
    append: (line: AuditLine) => {
      makeDirs(dir);
      withLockAt(join(dir, "reaper.lock"), "a", () => {
        appendFileSync(path, `${JSON.stringify(line)}\n`);
        const all = lines();

        if (all.length > LINES_KEPT * 2) writeText(path, `${all.slice(-LINES_KEPT).join("\n")}\n`);
      });
    },
  };
}

/** The machine's real signals and table, recording to `log`. */
export function realKillIo(log: AuditLog): KillIo {
  return { ...REAL_STOP, record: log.append, now: () => stampOf(new Date()) };
}

function cgroupNow(pid: number): string | undefined {
  try {
    return /^0::(.*)$/m.exec(readFileSync(`/proc/${String(pid)}/cgroup`, "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/** A sched file's `se.exec_start`: the scheduler's clock, in ms, when that task last ran. */
function execStart(path: string): number | undefined {
  try {
    const found = /^se\.exec_start\s*:\s*([\d.]+)$/m.exec(readFileSync(path, "utf8"))?.[1];

    return found === undefined ? undefined : Number(found);
  } catch {
    return undefined;
  }
}

/** Seconds since any thread of `pid` last ran, against `clock`, the scheduler's clock now; undefined with no reading. */
function idleNow(pid: number, clock: number): number | undefined {
  try {
    const ran = readdirSync(`/proc/${String(pid)}/task`).flatMap((task) => execStart(`/proc/${String(pid)}/task/${task}/sched`) ?? []);

    return ran.length === 0 ? undefined : Math.max(0, (clock - Math.max(...ran)) / 1000);
  } catch {
    return undefined;
  }
}

/** The process's VmSwap in kB; undefined with no reading. */
function swapNow(pid: number): number | undefined {
  try {
    const found = /^VmSwap:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${String(pid)}/status`, "utf8"))?.[1];

    return found === undefined ? undefined : Number(found);
  } catch {
    return undefined;
  }
}

/** The holds' units, each to its holder's name. */
function gateUnitsOf(standing: Standing): Map<string, string> {
  return new Map(standing.holders.flatMap((h) => (h.unit === undefined ? [] : [[h.unit, h.name] as const])));
}

/** Read the machine: every process with its environment, cgroup and idleness, the sessions alive and their
 * transcripts, the gate as `standing` has it. */
export function realSnapshot(machine: Machine, standing: Standing): Snapshot {
  const rows = processTable((basic) => new Set(basic.map((r) => r.pid)));
  const clock = execStart("/proc/self/sched");
  const resumed = rows.filter(isClaude).flatMap((r) => resumedIn(r.command) ?? []);
  const recordOf = recordsOf(rows, machine.config);
  const home = machine.env("HOME");
  const liveWorkspaces = new Set(rows.filter(isClaude).flatMap((r) => (r.cwd === undefined ? [] : [workspaceOf(r.cwd) ?? r.cwd])).filter((w) => w !== "/" && w !== home));

  const transcriptAt = new Map(
    [...new Set(rows.flatMap((r) => sessionOf(r) ?? []))].flatMap((id) => {
      const folder = sessionFolderOf(machine.config, id);
      const path = folder === undefined ? undefined : `${folder}.jsonl`;

      return path === undefined || !exists(path) ? [] : [[id, statSync(path).mtimeMs / 1000] as const];
    }),
  );

  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const mine = new Set<number>();

  for (let at: ProcRow | undefined = byPid.get(process.pid); at !== undefined && !mine.has(at.pid); at = byPid.get(at.ppid)) mine.add(at.pid);

  const exempt = new Set([...previewPids(machine.registry.known()), ...mine, ...[...standing.holders, ...standing.queue].flatMap((h) => h.pid ?? [])]);

  return {
    rows,
    cgroupOf: new Map(rows.flatMap((r) => {
      const cg = cgroupNow(r.pid);

      return cg === undefined ? [] : [[r.pid, cg] as const];
    })),
    swapOf: new Map(rows.flatMap((r) => {
      const swap = swapNow(r.pid);

      return swap === undefined ? [] : [[r.pid, swap] as const];
    })),
    idleOf: new Map(clock === undefined ? [] : rows.flatMap((r) => {
      const idle = idleNow(r.pid, clock);

      return idle === undefined ? [] : [[r.pid, idle] as const];
    })),
    liveSessions: new Set([...recordOf.values(), ...resumed]),
    liveWorkspaces,
    recordOf,
    transcriptAt,
    gateUnits: gateUnitsOf(standing),
    exempt,
    meminfo: { available: memAvailable(machine.env) ?? 0, total: memTotal(machine.env) },
    now: machine.now().getTime() / 1000,
  };
}

/** The JSON of `$FLEET_REAPER_SNAPSHOT`: a snapshot's fields, maps as pairs, what is missing empty. */
function handedSnapshot(path: string, standing: Standing): Snapshot {
  // SAFETY: the file is a test's handed snapshot, written in this shape; a real run never sets the variable.
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    readonly rows: readonly ProcRow[];
    readonly cgroupOf?: readonly (readonly [number, string])[];
    readonly swapOf?: readonly (readonly [number, number])[];
    readonly idleOf?: readonly (readonly [number, number])[];
    readonly liveSessions?: readonly string[];
    readonly liveWorkspaces?: readonly string[];
    readonly recordOf?: readonly (readonly [number, string])[];
    readonly transcriptAt?: readonly (readonly [string, number])[];
    readonly exempt?: readonly number[];
    readonly meminfo: { readonly available: number; readonly total: number };
    readonly now: number;
  };

  return {
    rows: raw.rows,
    cgroupOf: new Map(raw.cgroupOf ?? []),
    swapOf: new Map(raw.swapOf ?? []),
    idleOf: new Map(raw.idleOf ?? []),
    liveSessions: new Set(raw.liveSessions ?? []),
    liveWorkspaces: new Set(raw.liveWorkspaces ?? []),
    recordOf: new Map(raw.recordOf ?? []),
    transcriptAt: new Map(raw.transcriptAt ?? []),
    gateUnits: gateUnitsOf(standing),
    exempt: new Set(raw.exempt ?? []),
    meminfo: raw.meminfo,
    now: raw.now,
  };
}

/** The file `$FLEET_REAPER_SNAPSHOT` hands, if it hands one. */
export function handedPath(machine: Machine): string | undefined {
  const handed = machine.env("FLEET_REAPER_SNAPSHOT");

  return handed === "" ? undefined : handed;
}

/** What a read-only report works from: the snapshot handed, else the machine's. A kill and a waiter never read
 * a handed table: they call {@link realSnapshot}, or refuse. */
export function snapshotToRead(machine: Machine, standing: Standing): Snapshot {
  const handed = handedPath(machine);

  return handed === undefined ? realSnapshot(machine, standing) : handedSnapshot(handed, standing);
}

/** The floor a report prints: `$FLEET_GATE_MEMORY_FLOOR`'s, else the default; 0 when it does not parse. */
export function reportFloor(machine: Machine): number {
  return floorOf(undefined, machine.env)?.bytes ?? 0;
}

/** A read-only report of the machine, for a waiter: no audit line, no signal. */
export function reportNow(machine: Machine, standing: Standing): Report {
  return judge(realSnapshot(machine, standing), DEFAULTS, reportFloor(machine));
}
