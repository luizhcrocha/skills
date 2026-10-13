/**
 * The preview's record, `DIR/preview.json`: where the combined preview's workspace is, the dev servers
 * (the combined one and each per-worker one) with their pids and ports, the stack's revset (as given to
 * `start`, and as the last merge resolved it), the public port each root-mode
 * preview was given (`ports.ts`), the updater's pid, which workers the user took in or out, and what the
 * last merge held (each worker's commit, the conflicts and which
 * workers touch each file, the updater's last failure).
 *
 * It is a file of its own, not a key of `state.json`, because it has three writers: the coordinator's
 * `fleet preview` commands, the updater (every few seconds) and the hub (the page's include and exclude).
 * `state.json` is locked only by `fleet state` and the hub's rename; this file is changed only under an exclusive `flock` on
 * `DIR/preview.lock`, and written whole through a rename, so a reader never sees half of it and no writer
 * loses another's change. The ledger records the preview's workspace (`workspaces[]`, `kind: "preview"`)
 * and its dev command (`preview.cmd`), both written by `fleet preview` alone.
 */
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";

import { exists, readText, writeAtomic } from "../files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseObject, type Json, type JsonObject, type JsonOut } from "../json.ts";
import { withExclusiveLock } from "../lock.ts";
import { argsOf, startedAt, type Tracked } from "./tracked.ts";

/** A dev server the preview started. */
export interface DevServer {
  /** The command as it runs (`/bin/sh -c`), its port and base filled in. */
  readonly cmd: string;
  readonly port: number;
  /** Its process (`sh -c` the command, a session's leader), while it runs. */
  readonly pid: number | null;
  /** When that process started, in epoch seconds (`tracked.ts`): what proves a pid is still it. */
  readonly pidStarted: number | null;
  /** The systemd user scope it runs in, or null (`tracked.ts`). */
  readonly unit: string | null;
  /** The path it serves under: `/f/<fleet>/preview/` (or `…/preview/<worker>/`) when it was told its base,
   * `/` when it runs at the root and the hub strips the prefix. */
  readonly base: string;
  /** The directory it runs in. */
  readonly path: string;
  /** Its stdout and stderr. */
  readonly log: string;
  readonly started: string;
  /** In root mode, the public port the hub serves it at, at the root of an origin of its own; else null. */
  readonly public: number | null;
  /** The keeper that puts it to sleep when idle and wakes it on a request (`sleep.ts`), or null when it never sleeps. */
  readonly keeper: number | null;
  readonly keeperStarted: number | null;
  readonly keeperUnit: string | null;
  /** When its keeper put it to sleep (its pid then null), or null while it is awake. */
  readonly asleep: string | null;
  /** Why its keeper gave up on it (it could not start, or it exited while it ran), or null. */
  readonly failed: Failure | null;
}

/** A dev server its keeper gave up on: when, why, and the last lines of its log then. */
export interface Failure {
  readonly at: string;
  readonly why: string;
  readonly log: string;
}

/** A per-worker preview: a dev server in that worker's own workspace. */
export interface WorkerServer extends DevServer {
  readonly worker: string;
}

/** A file the merge left conflicted, and the workers whose changes touch it. */
export interface Conflict {
  readonly path: string;
  readonly workers: readonly string[];
}

/** A worker the merge leaves out, at the commit it was tried at: taking its workspace in would conflict, and
 * the preview never serves a conflicted merge. It is tried again whenever a commit of the merge moves. */
export interface LeftOut {
  readonly id: string;
  readonly workspace: string;
  readonly commit: string;
  /** Whether its own @ is conflicted (a rebase it has not resolved): no merge that takes it is clean. */
  readonly own: boolean;
  /** The files that would be conflicted, each with the merged workers whose changes touch it (none: the stack). */
  readonly conflicts: readonly Conflict[];
}

/** A worker in the merge, at the commit it was merged at. */
export interface Merged {
  readonly id: string;
  readonly workspace: string;
  readonly commit: string;
  readonly change: string;
}

/** The record. */
export interface PreviewRecord {
  /** The fleet's name when the preview started: its base is `/f/<fleet>/preview/`. */
  readonly fleet: string;
  /** The jj workspace the combined preview runs in, its directory and the repo's default workspace. */
  readonly workspace: string;
  readonly path: string;
  readonly repo: string;
  /** The combined preview's dev server, while one was started. */
  readonly server: DevServer | null;
  /** The updater's pid, while it runs, and when it started. */
  readonly updater: number | null;
  readonly updaterStarted: number | null;
  /** Workers the user took in although they are not running, and workers taken out. */
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** What the last merge held. */
  readonly merged: readonly Merged[];
  /** The workers the last merge left out, since taking them in would conflict. */
  readonly left: readonly LeftOut[];
  readonly stack: string | null;
  /** The revset the last merge's stack was resolved from, or null for the default workspace's @ rule. */
  readonly stackFrom: string | null;
  /** The revset `start --stack` gave, for that start alone (over the ledger's `preview.stack`), or null. */
  readonly stackGiven: string | null;
  readonly commit: string | null;
  readonly conflicts: readonly Conflict[];
  /** Why the updater's last look failed, or null. */
  readonly error: string | null;
  /** When the merge last changed. */
  readonly updated: string | null;
  readonly workers: readonly WorkerServer[];
  /** The public port each preview was given in root mode, kept across its stops and starts. */
  readonly ports: PublicPorts;
}

/** The public ports given: the combined preview's, and each per-worker one's by worker. */
export interface PublicPorts {
  readonly combined: number | null;
  readonly workers: Readonly<Record<string, number>>;
}

/** A server's process as `tracked.ts` checks it. A record from before start times were kept (1.9.37) has
 * only the second the server was recorded started, which its process's start time is checked against. */
export function serverProc(s: DevServer): Tracked | null {
  if (s.pid === null) return null;

  if (s.pidStarted !== null) return { pid: s.pid, started: s.pidStarted, unit: s.unit };
  const stamp = Date.parse(s.started);

  return { pid: s.pid, started: Number.isNaN(stamp) ? null : stamp / 1000, unit: s.unit, slack: 3 };
}

/** A server's keeper as `tracked.ts` checks it. */
export function keeperProc(s: DevServer): Tracked | null {
  return s.keeper === null ? null : { pid: s.keeper, started: s.keeperStarted, unit: s.keeperUnit };
}

/** The updater as `tracked.ts` checks it. A record from before start times were kept (1.9.37) has no
 * `updater_started`, and its updater may run for days more: such a pid is proved by its command line instead
 * (a fleet's main script, then `preview DIR updater`, DIR's record being this one), and tracked from the
 * start time it has now. */
export function updaterProc(r: PreviewRecord): Tracked | null {
  if (r.updater === null) return null;

  if (r.updaterStarted !== null) return { pid: r.updater, started: r.updaterStarted, unit: null };

  return { pid: r.updater, started: isUpdaterOf(r.updater, r) ? (startedAt(r.updater) ?? null) : null, unit: null };
}

/** A fleet's main script as `start` gives it to Bun for the updater: an absolute `…/fleet/src/main.ts`, of
 * this version or of the one that started it. */
const FLEET_MAIN = /^\/.*\/fleet\/src\/main\.ts$/;

/** Whether process `pid` is the updater of the preview `r` records: it runs as `start` spawns it (`<bun>
 * <a fleet's main script> preview DIR updater`, nothing after), and DIR's record names the same preview
 * workspace and this pid. Another program that only ends with those three words is a stranger, and a
 * stranger is never signalled. */
function isUpdaterOf(pid: number, r: PreviewRecord): boolean {
  const [main, command, dir, last] = argsOf(pid).slice(-4);

  if (main === undefined || !FLEET_MAIN.test(main) || command !== "preview" || last !== "updater" || dir === undefined) return false;
  const theirs = readRecord(dir);

  return theirs !== undefined && theirs.updater === pid && theirs.fleet === r.fleet && theirs.path === r.path && theirs.repo === r.repo;
}

/** Where the record is. */
export function recordPath(root: string): string {
  return join(root, "preview.json");
}

/** The directory of the preview's logs. Under the hub, `/f/<fleet>/preview/…` is the proxy, so nothing in it is served. */
export function logDir(root: string): string {
  return join(root, "preview");
}

function strings(value: Json | undefined): string[] {
  return (asArray(value) ?? []).flatMap((v) => asString(v) ?? []);
}

function pidOf(value: Json | undefined): number | null {
  const n = asNumber(value);

  return n !== undefined && Number.isInteger(n) && n > 1 ? n : null;
}

function portOf(value: Json | undefined): number | null {
  const n = asNumber(value);

  return n !== undefined && Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function portsOf(value: Json | undefined): PublicPorts {
  const o = asObject(value);

  const workers = Object.entries(asObject(o?.["workers"]) ?? {}).flatMap(([worker, port]) => {
    const n = portOf(port);

    return n === null ? [] : [[worker, n] as const];
  });

  return { combined: portOf(o?.["combined"]), workers: Object.fromEntries(workers) };
}

function startOf(value: Json | undefined): number | null {
  const n = asNumber(value);

  return n !== undefined && Number.isFinite(n) && n > 0 ? n : null;
}

function failureOf(value: Json | undefined): Failure | null {
  const o = asObject(value);
  const at = asString(o?.["at"]);

  return o === undefined || at === undefined ? null : { at, why: asString(o["why"]) ?? "", log: asString(o["log"]) ?? "" };
}

function serverOf(value: Json | undefined): DevServer | null {
  const o = asObject(value);
  const cmd = asString(o?.["cmd"]);
  const port = asNumber(o?.["port"]);
  const path = asString(o?.["path"]);

  if (o === undefined || cmd === undefined || port === undefined || path === undefined) return null;

  return {
    cmd,
    port,
    pid: pidOf(o["pid"]),
    pidStarted: startOf(o["pid_started"]),
    unit: asString(o["unit"]) ?? null,
    base: asString(o["base"]) ?? "/",
    path,
    log: asString(o["log"]) ?? "",
    started: asString(o["started"]) ?? "",
    public: portOf(o["public"]),
    keeper: pidOf(o["keeper"]),
    keeperStarted: startOf(o["keeper_started"]),
    keeperUnit: asString(o["keeper_unit"]) ?? null,
    asleep: asString(o["asleep"]) ?? null,
    failed: failureOf(o["failed"]),
  };
}

function conflictsOf(value: Json | undefined): Conflict[] {
  return (asArray(value) ?? []).flatMap((c) => {
    const row = asObject(c);
    const file = asString(row?.["path"]);

    return file === undefined ? [] : [{ path: file, workers: strings(row?.["workers"]) }];
  });
}

/** The record as `text` holds it; undefined when it is not one. */
export function parseRecord(text: string): PreviewRecord | undefined {
  const o = Option.getOrUndefined(parseObject(text));
  const fleet = asString(o?.["fleet"]);
  const workspace = asString(o?.["workspace"]);
  const path = asString(o?.["path"]);
  const repo = asString(o?.["repo"]);

  if (o === undefined || fleet === undefined || workspace === undefined || path === undefined || repo === undefined) return undefined;

  const merged = (asArray(o["merged"]) ?? []).flatMap((m) => {
    const row = asObject(m);
    const id = asString(row?.["id"]);

    return row === undefined || id === undefined
      ? []
      : [{ id, workspace: asString(row["workspace"]) ?? id, commit: asString(row["commit"]) ?? "", change: asString(row["change"]) ?? "" }];
  });

  const conflicts = conflictsOf(o["conflicts"]);

  const left = (asArray(o["left_out"]) ?? []).flatMap((l) => {
    const row = asObject(l);
    const id = asString(row?.["id"]);

    return row === undefined || id === undefined
      ? []
      : [{ id, workspace: asString(row["workspace"]) ?? id, commit: asString(row["commit"]) ?? "", own: row["own"] === true, conflicts: conflictsOf(row["conflicts"]) }];
  });

  const workers = (asArray(o["workers"]) ?? []).flatMap((w) => {
    const server = serverOf(w);
    const worker = asString(asObject(w)?.["worker"]);

    return server === null || worker === undefined ? [] : [{ ...server, worker }];
  });

  return {
    fleet,
    workspace,
    path,
    repo,
    server: serverOf(o["server"]),
    updater: pidOf(o["updater"]),
    updaterStarted: startOf(o["updater_started"]),
    include: strings(o["include"]),
    exclude: strings(o["exclude"]),
    merged,
    left,
    stack: asString(o["stack"]) ?? null,
    stackFrom: asString(o["stack_from"]) ?? null,
    stackGiven: asString(o["stack_given"]) ?? null,
    commit: asString(o["commit"]) ?? null,
    conflicts,
    error: asString(o["error"]) ?? null,
    updated: asString(o["updated"]) ?? null,
    workers,
    ports: portsOf(o["ports"]),
  };
}

/** The record in DIR, or undefined when there is none. */
export function readRecord(root: string): PreviewRecord | undefined {
  const text = readText(recordPath(root));

  return text === undefined ? undefined : parseRecord(text);
}

function serverJson(s: DevServer): JsonObject {
  return {
    cmd: s.cmd,
    port: s.port,
    pid: s.pid,
    pid_started: s.pidStarted,
    unit: s.unit,
    base: s.base,
    path: s.path,
    log: s.log,
    started: s.started,
    public: s.public,
    keeper: s.keeper,
    keeper_started: s.keeperStarted,
    keeper_unit: s.keeperUnit,
    asleep: s.asleep,
    failed: s.failed === null ? null : { at: s.failed.at, why: s.failed.why, log: s.failed.log },
  };
}

/** The record as JSON. */
export function recordJson(r: PreviewRecord): JsonObject {
  return {
    fleet: r.fleet,
    workspace: r.workspace,
    path: r.path,
    repo: r.repo,
    server: r.server === null ? null : serverJson(r.server),
    updater: r.updater,
    updater_started: r.updaterStarted,
    include: [...r.include],
    exclude: [...r.exclude],
    merged: r.merged.map((m) => ({ id: m.id, workspace: m.workspace, commit: m.commit, change: m.change })),
    left_out: r.left.map((l) => ({ id: l.id, workspace: l.workspace, commit: l.commit, own: l.own, conflicts: l.conflicts.map((c) => ({ path: c.path, workers: [...c.workers] })) })),
    stack: r.stack,
    stack_from: r.stackFrom,
    stack_given: r.stackGiven,
    commit: r.commit,
    conflicts: r.conflicts.map((c) => ({ path: c.path, workers: [...c.workers] })),
    error: r.error,
    updated: r.updated,
    workers: r.workers.map((w) => ({ worker: w.worker, ...serverJson(w) })),
    ports: { combined: r.ports.combined, workers: { ...r.ports.workers } },
  };
}

/**
 * Change the record under the lock: `change` is given the record as it is now (undefined when there is
 * none) and returns the next one, or undefined to leave it as it is. Returns what is recorded after.
 */
export function updateRecord(root: string, change: (now: PreviewRecord | undefined) => PreviewRecord | undefined): PreviewRecord | undefined {
  const fd = openSync(join(root, "preview.lock"), "a");

  try {
    return withExclusiveLock(fd, () => {
      const now = readRecord(root);
      const next = change(now);

      if (next === undefined) return now;
      // SAFETY: a JsonObject is a JsonOut: the same JSON, read-only.
      writeAtomic(recordPath(root), `${dumps(recordJson(next) as JsonOut, { indent: 2, ensureAscii: false })}\n`);

      return next;
    });
  } finally {
    closeSync(fd);
  }
}

/** Whether DIR has a preview record. */
export function hasRecord(root: string): boolean {
  return exists(recordPath(root));
}
