/**
 * Idle sleep for the preview's dev servers (D160): a dev server no request reached for `FLEET_PREVIEW_IDLE_S`
 * seconds (1800) is stopped, and started again, with the same command, port and environment, on the next
 * request. A Vite dev server and its workerd grow without bound while they run (3.5 GB after 54 hours), and
 * a fleet's idle per-worker previews held about 11 GB.
 *
 * The hub sees the requests and the WebSocket frames (not Vite's pings): it writes the time of the last one
 * to `DIR/preview/<worker|combined>.seen`. The keeper (`fleet preview DIR keeper [--per-worker WORKER]`), one
 * per sleeping-capable server, started detached by `start` and so holding the environment `start` ran in
 * (secrets from `op run` or secretspec, never written anywhere), reads that file every tick: idle past the
 * limit, it stops the server (its scope, or its tree after checking its start time: `tracked.ts`) and records
 * it `asleep`; a request after that, it starts the server again. While the server is asleep or not yet
 * answering, the hub answers a "starting" page that reloads itself.
 *
 * A start that does not come up (the command exits, the port is taken, nothing answers in two minutes) is
 * tried again after 1, 2 and 4 s; after the fourth try, or when the server exits while it runs, the keeper
 * records it `failed`, with the last 30 lines of its log, and ends: the hub then answers a page that says
 * so and how to start it again, and no longer reloads.
 *
 * A server named in `FLEET_PREVIEW_AWAKE` (its public port, its worker, or `combined`; default `7501`, the
 * main preview) gets no keeper and never sleeps. `FLEET_PREVIEW_IDLE_S=0` turns the sleep off.
 */
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stampOf } from "../clock.ts";
import { PreviewError } from "../errors.ts";
import { makeDirs } from "../files.ts";
import type { Machine } from "../world.ts";
import { upAll } from "../page/probe.ts";
import { plainTail, startServer } from "./devserver.ts";
import { keeperProc, logDir, readRecord, serverProc, updateRecord, type DevServer, type PreviewRecord } from "./record.ts";
import { runs, scopes, stopTracked, unitName, type Tracked } from "./tracked.ts";

type Env = (name: string) => string | undefined;

/** The default idle time before a dev server sleeps: 30 minutes. */
export const DEFAULT_IDLE_S = 1800;

/** The servers that never sleep by default: the main preview's public port. */
export const DEFAULT_AWAKE = "7501";

/** How long a server may go without a request before it sleeps, in ms; null when sleep is off. */
export function idleMs(env: Env): number | null {
  const given = env("FLEET_PREVIEW_IDLE_S");
  const seconds = given === undefined || given.trim() === "" ? DEFAULT_IDLE_S : Number(given);

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** The names of the servers that never sleep: public ports, worker ids, `combined`. */
export function awakeNames(env: Env): readonly string[] {
  return (env("FLEET_PREVIEW_AWAKE") ?? DEFAULT_AWAKE).split(/[\s,]+/).filter((n) => n !== "");
}

/** Whether a server (`worker` undefined for the combined preview) is exempt from sleep. */
export function exempt(env: Env, server: Pick<DevServer, "public">, worker: string | undefined): boolean {
  const names = awakeNames(env);

  return names.includes(worker ?? "combined") || (server.public !== null && names.includes(String(server.public)));
}

/** Whether a server sleeps when idle: sleep is on and it is not exempt. */
export function sleeps(env: Env, server: Pick<DevServer, "public">, worker: string | undefined): boolean {
  return idleMs(env) !== null && !exempt(env, server, worker);
}

/** Where the hub writes the time of the last request to a server. */
export function seenPath(root: string, worker: string | undefined): string {
  return join(logDir(root), `${worker ?? "combined"}.seen`);
}

/** Record a request to a server now (the hub). */
export function noteRequest(root: string, worker: string | undefined): void {
  try {
    makeDirs(logDir(root));
    writeFileSync(seenPath(root, worker), `${Date.now()}\n`);
  } catch {
    // a request is answered whether or not it could be noted
  }
}

/** When the last request to a server was noted, in ms since the epoch; 0 when never. */
export function lastSeen(root: string, worker: string | undefined): number {
  try {
    return statSync(seenPath(root, worker)).mtimeMs;
  } catch {
    return 0;
  }
}

/** The server a keeper keeps. */
export function serverOf(record: PreviewRecord | undefined, worker: string | undefined): DevServer | null {
  if (record === undefined) return null;

  return worker === undefined ? record.server : (record.workers.find((w) => w.worker === worker) ?? null);
}

/** `record` with the server a keeper keeps (`worker` undefined: the combined preview's) replaced by `server`. */
function withServer(record: PreviewRecord, worker: string | undefined, server: DevServer): PreviewRecord {
  if (worker === undefined) return { ...record, server };

  return { ...record, workers: record.workers.map((w) => (w.worker === worker ? { ...w, ...server, worker } : w)) };
}

/** Change a server in the record, when `ok` holds for it as it is then; what is recorded after. */
function changeServer(root: string, worker: string | undefined, change: (s: DevServer) => DevServer, ok: (s: DevServer) => boolean = () => true): DevServer | null {
  const after = updateRecord(root, (now) => {
    const s = serverOf(now, worker);

    return now === undefined || s === null || !ok(s) ? undefined : withServer(now, worker, change(s));
  });

  return serverOf(after, worker);
}

/** Whether a server has a running keeper that will wake it or is waking it: its keeper still runs as the
 * process recorded (`tracked.ts`), not a pid reused since. */
export function kept(server: DevServer | null): boolean {
  return server !== null && runs(keeperProc(server));
}

/** Whether a server is asleep: put to sleep by its keeper, which still runs and wakes it on a request. */
export function asleep(server: DevServer | null): boolean {
  return server !== null && server.asleep !== null && kept(server);
}

/**
 * Where a server stands: `running` (its process is the one recorded), `asleep` or `waking` (its keeper runs
 * and has it asleep, or is starting it), `failed` (its keeper gave up on it), `unkept` (it had a keeper,
 * which is gone: nothing will start it again), `stopped`.
 */
export type ServerStanding = "running" | "asleep" | "waking" | "failed" | "unkept" | "stopped";

export function serverStanding(s: DevServer): ServerStanding {
  if (runs(serverProc(s))) return "running";

  if (s.failed !== null) return "failed";

  if (s.keeper === null) return "stopped";

  if (!kept(s)) return "unkept";

  return s.asleep !== null ? "asleep" : "waking";
}

/** The command that starts a server again. */
export function restartCommand(root: string, worker: string | undefined, s: Pick<DevServer, "public">): string {
  return `fleet preview ${root} start${worker === undefined ? "" : ` --per-worker ${worker}`}${s.public === null ? "" : " --root"}`;
}

/**
 * Stop a server and its keeper; what the record held for it after its keeper was taken off, or null when
 * there is none. The keeper first: once the record no longer names it, it starts nothing (it starts a server
 * only under the record's lock, while the record names it), so the server the record names after is the
 * last one, and it is stopped too. Neither is signalled unless it still runs as the process recorded.
 */
export function stopServer(root: string, worker: string | undefined, path: string | undefined): DevServer | null {
  const before = serverOf(readRecord(root), worker);

  if (before === null) return null;
  const unkept = changeServer(root, worker, (s) => ({ ...s, keeper: null, keeperStarted: null, keeperUnit: null })) ?? before;
  stopTracked(keeperProc(before), { path });
  stopTracked(serverProc(unkept), { path });
  changeServer(root, worker, (s) => ({ ...s, pid: null, pidStarted: null, unit: null, keeper: null, keeperStarted: null, keeperUnit: null, asleep: null, failed: null }));

  return unkept;
}

/** Stop every server of the preview in DIR that has a keeper, with its keeper (`fleet serve --stop`): no
 * request reaches them any more, so none would wake. The names of those stopped (`combined`, workers). */
export function stopKept(root: string, path: string | undefined): string[] {
  const record = readRecord(root);

  if (record === undefined) return [];
  const servers: (readonly [string | undefined, DevServer | null])[] = [[undefined, record.server], ...record.workers.map((w) => [w.worker, w] as const)];

  return servers.flatMap(([worker, s]) => {
    if (s === null || s.keeper === null) return [];
    stopServer(root, worker, path);

    return [worker ?? "combined"];
  });
}

/** How many times a keeper starts a server that does not come up before it gives up: the first try and 3 more. */
export const WAKE_TRIES = 4;

/** The wait before each try after the first, in ms. */
const BACKOFF_MS = [1000, 2000, 4000] as const;

/** How long a started server may run without answering before its try counts as failed. */
const WAKE_LIMIT_MS = 120_000;

/** How many lines of its log a failed server's record keeps. */
export const FAILED_LINES = 30;

/** A wake in progress: tries made, when the last began, when the next is due (null while one runs), and why
 * the last failed. */
interface Wake {
  readonly tries: number;
  readonly since: number;
  readonly next: number | null;
  readonly why: string;
}

/**
 * The keeper's loop for one server (`worker` undefined: the combined preview's), until the record no
 * longer names this process as its keeper (`stop`, a new start), or it gives up on the server. Each tick: a
 * running server whose last request (or start, or wake) is older than the idle limit is stopped and recorded
 * asleep; an asleep server with a request since is started again with its recorded command, port and log, in
 * this process's environment, which is `start`'s, and tried again (at most {@link WAKE_TRIES} times in all)
 * while it does not come up. A server that cannot start, or that exits while it runs, is recorded `failed`
 * with the end of its log, and the keeper ends.
 */
export async function runKeeper(machine: Machine, root: string, worker: string | undefined): Promise<number> {
  const me = process.pid;
  const idle = idleMs(machine.env) ?? DEFAULT_IDLE_S * 1000;
  const tick = Math.min(1000, Math.max(50, idle / 4));
  const name = worker ?? "combined";
  const path = machine.env("PATH");
  const scoped = scopes(machine.env);
  const say = (line: string): void => void process.stdout.write(`${stampOf(machine.now())} ${name}: ${line}\n`);
  const mine = (s: DevServer): boolean => s.keeper === me;
  let stopping = false;

  // A signal ends the loop between ticks, never between starting a server and recording it.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      stopping = true;
    });
  }

  for (let waited = 0; serverOf(readRecord(root), worker)?.keeper !== me; waited += 100) {
    if (waited > 10_000) return 1;
    await Bun.sleep(100);
  }

  const failedTry = (wake: Wake, why: string): Wake => {
    const tries = wake.tries + 1;
    const wait = BACKOFF_MS[tries - 1];
    const next = tries < WAKE_TRIES && wait !== undefined ? Date.now() + wait : null;
    say(`try ${tries} of ${WAKE_TRIES} failed: ${why}${next === null ? "" : `; again in ${(wait ?? 0) / 1000} s`}`);

    return { tries, since: wake.since, next, why };
  };

  const fail = (server: DevServer, why: string): number => {
    const log = plainTail(server.log, FAILED_LINES);
    stopTracked(serverProc(server), { path });
    const failed = { at: stampOf(machine.now()), why, log };
    changeServer(root, worker, (s) => ({ ...s, pid: null, pidStarted: null, unit: null, asleep: null, keeper: null, keeperStarted: null, keeperUnit: null, failed }), mine);
    say(`gave up: ${why}; \`${restartCommand(root, worker, server)}\` starts it again`);

    return 0;
  };

  /** Start the server again under the record's lock, while the record names this keeper; "gone" when it does not. */
  const startAgain = (): Tracked | PreviewError | "gone" => {
    const tried: (Tracked | PreviewError)[] = [];

    changeServer(
      root,
      worker,
      (s) => {
        const started = startServer(s.path, s.cmd, s.port, s.log, {}, scoped ? unitName(name) : null);
        tried.push(started);

        return started instanceof PreviewError ? s : { ...s, pid: started.pid, pidStarted: started.started, unit: started.unit, asleep: null, started: stampOf(machine.now()) };
      },
      mine,
    );

    return tried[0] ?? "gone";
  };

  let active = Date.now();
  let slept = 0;
  let wake: Wake | undefined;

  while (!stopping) {
    const server = serverOf(readRecord(root), worker);

    if (server === null || server.keeper !== me) return 0;
    const proc = serverProc(server);
    const up = runs(proc);
    const seen = lastSeen(root, worker);

    if (wake === undefined && server.asleep !== null && seen > slept) wake = { tries: 0, since: Date.now(), next: Date.now(), why: "" };

    if (wake !== undefined) {
      if (wake.next === null) {
        if (!up) {
          stopTracked(proc, { path });
          wake = failedTry(wake, `it exited before it answered on port ${server.port}`);
        } else if ((await upAll([`http://127.0.0.1:${server.port}/`]))[0] === true) {
          say(`woken by a request: pid ${server.pid ?? "?"} on port ${server.port}`);
          wake = undefined;
          active = Date.now();
        } else if (Date.now() - wake.since >= WAKE_LIMIT_MS) {
          stopTracked(proc, { path });
          wake = failedTry(wake, `nothing answered on port ${server.port} in ${WAKE_LIMIT_MS / 1000} s`);
        }
      }

      if (wake !== undefined && wake.next === null && wake.tries >= WAKE_TRIES) return fail(server, `it could not start (${WAKE_TRIES} tries); the last: ${wake.why}`);

      if (wake !== undefined && wake.next !== null && Date.now() >= wake.next) {
        const started = startAgain();

        if (started === "gone") return 0;

        if (started instanceof PreviewError) wake = failedTry(wake, started.reason);
        else {
          say(`starting it: pid ${started.pid} on port ${server.port} (try ${wake.tries + 1} of ${WAKE_TRIES})`);
          wake = { ...wake, since: Date.now(), next: null };
        }

        if (wake.next === null && wake.tries >= WAKE_TRIES) return fail(server, `it could not start (${WAKE_TRIES} tries); the last: ${wake.why}`);
      }
    } else if (server.asleep === null) {
      if (!up) return fail(server, "it exited while it ran");
      active = Math.max(active, seen);

      if (Date.now() - active >= idle) {
        if (stopTracked(proc, { path })) {
          slept = Date.now();
          changeServer(root, worker, (s) => ({ ...s, pid: null, pidStarted: null, unit: null, asleep: stampOf(machine.now()) }), mine);
          say(`asleep after ${Math.round((slept - active) / 1000)} s with no request (pid ${server.pid ?? "?"} stopped)`);
        } else say(`could not stop pid ${server.pid ?? "?"} to sleep; trying again`);
      }
    }

    await Bun.sleep(tick);
  }

  return 0;
}
