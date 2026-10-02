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
 * `state.json` has one writer and no lock; this file is changed only under an exclusive `flock` on
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

/** A dev server the preview started. */
export interface DevServer {
  /** The command as it runs (`/bin/sh -c`), its port and base filled in. */
  readonly cmd: string;
  readonly port: number;
  /** Its process group's leader, while it runs. */
  readonly pid: number | null;
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
  /** The updater's pid, while it runs. */
  readonly updater: number | null;
  /** Workers the user took in although they are not running, and workers taken out. */
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** What the last merge held. */
  readonly merged: readonly Merged[];
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

function serverOf(value: Json | undefined): DevServer | null {
  const o = asObject(value);
  const cmd = asString(o?.["cmd"]);
  const port = asNumber(o?.["port"]);
  const path = asString(o?.["path"]);

  if (o === undefined || cmd === undefined || port === undefined || path === undefined) return null;

  return { cmd, port, pid: pidOf(o["pid"]), base: asString(o["base"]) ?? "/", path, log: asString(o["log"]) ?? "", started: asString(o["started"]) ?? "", public: portOf(o["public"]) };
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

  const conflicts = (asArray(o["conflicts"]) ?? []).flatMap((c) => {
    const row = asObject(c);
    const file = asString(row?.["path"]);

    return file === undefined ? [] : [{ path: file, workers: strings(row?.["workers"]) }];
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
    include: strings(o["include"]),
    exclude: strings(o["exclude"]),
    merged,
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
  return { cmd: s.cmd, port: s.port, pid: s.pid, base: s.base, path: s.path, log: s.log, started: s.started, public: s.public };
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
    include: [...r.include],
    exclude: [...r.exclude],
    merged: r.merged.map((m) => ({ id: m.id, workspace: m.workspace, commit: m.commit, change: m.change })),
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
