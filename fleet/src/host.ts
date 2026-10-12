/**
 * Which Claude Code session hosts a fleet, and whether that session is there to be written to.
 *
 * The host is the session the fleet's registry entry names: the pid `fleet serve` found (or was given) and
 * when that process started (`started`, written at serve time; an entry served before it was recorded has
 * none, and is told by its pid alone until it is served again). A copy of the session (a `--fork-session`
 * background copy, a second `claude --resume` of the same transcript) is another process: it is not the host,
 * its chat watch as the host's role hears for nobody (chat/watchers.ts `foreign`), and `fleet serve` does not
 * move the fleet to it unless told `--take-over` (cli/hub.ts).
 *
 * Before anything is written to a session's socket (the hub's wake, wake.ts) the entry is checked against the
 * machine ({@link reach}): its process runs, is a Claude Code binary, started when the entry says, and holds
 * the socket named after it. A pid that lives and a socket file that exists are not that: a pid is reused,
 * and `serve --pid` takes any process. What the machine is asked is one seam ({@link Probe}); a test gives
 * its own.
 */
import { asString } from "./json.ts";
import { exists } from "./files.ts";
import { holdsSocket, runningOf, startedMsOf, type Running } from "./procs.ts";
import { pidOfEntry, type Entry, type Registry } from "./registry.ts";

/** What is asked of the machine about a session's process. */
export interface Probe {
  /** Whether `pid` runs, as Claude Code, and when it started (procs.ts `runningOf`). */
  readonly running: (pid: number) => Running;
  /** Whether `pid` holds the Unix socket bound at `path` (procs.ts `holdsSocket`). */
  readonly holds: (pid: number, path: string) => boolean | "unknown";
  /** When `pid` started, in ms since the epoch (procs.ts `startedMsOf`); undefined when it does not read. */
  readonly startedMs: (pid: number) => number | undefined;
}

/** This machine. */
export const PROBE: Probe = { running: runningOf, holds: holdsSocket, startedMs: startedMsOf };

/** The session a registry entry names as its fleet's host. */
export interface Host {
  readonly pid: number;
  /** When that process started (procs.ts `startedOf`); undefined in an entry served before it was recorded. */
  readonly started: string | undefined;
}

/** The host `entry` names, or undefined when it names no process. */
export function recordedHost(entry: Entry): Host | undefined {
  const pid = pidOfEntry(entry);
  const started = asString(entry.raw["started"]);

  return pid === undefined || pid <= 1 ? undefined : { pid, started: started === undefined || started === "" ? undefined : started };
}

/** Whether a session is there: `gone` and `unknown` say why, in words for the page. `unknown` is the machine
 * not answering (a `ps` that failed on the Mac), never a session that is gone. */
export type Presence = { readonly is: "there" } | { readonly is: "gone" | "unknown"; readonly why: string };

const gone = (why: string): Presence => ({ is: "gone", why });

/** Whether the process `host` names runs now as the Claude Code session that served the fleet. */
export function presenceOf(host: Host | undefined, probe: Probe = PROBE): Presence {
  if (host === undefined) return gone("the registry names no process for it");
  const running = probe.running(host.pid);

  if (running === "unknown") return { is: "unknown", why: "the machine did not say whether the session's process runs" };

  if (running === "gone") return gone("its process no longer runs");

  if (!running.claude) return gone(`process ${String(host.pid)} is not Claude Code`);

  if (host.started !== undefined && running.started !== host.started) return gone(`another process has its pid (${String(host.pid)})`);

  return { is: "there" };
}

/** Whether the process `host` names still runs, Claude Code or not (an entry made with `serve --pid` names
 * any process): the one with its pid started when the entry says. A machine that did not answer counts as
 * running: what asks is about to take the fleet from it. */
export function runs(host: Host, probe: Probe = PROBE): boolean {
  const running = probe.running(host.pid);

  return running === "unknown" || (running !== "gone" && (host.started === undefined || running.started === host.started));
}

/** Whether `host`'s session can be written to at `socket`: it is there ({@link presenceOf}) and the socket
 * is its own. Asked before every write. */
export function reach(host: Host | undefined, socket: string | undefined, probe: Probe = PROBE): Presence {
  const presence = presenceOf(host, probe);

  if (presence.is !== "there" || host === undefined) return presence;

  if (socket === undefined || !exists(socket)) return gone("it has no socket");
  const holds = probe.holds(host.pid, socket);

  if (holds === "unknown") return { is: "unknown", why: "the machine did not say whose the session's socket is" };

  return holds ? { is: "there" } : gone("the socket named after it is not its own");
}

/** The session that hosts the fleet served from `root`, when the registry names one that is there now;
 * undefined when the fleet is not served, its entry names a process that is not Claude Code (`serve --pid`
 * of something else) or one that is gone, or the machine did not answer. With none, nothing tells a host's
 * watch from a copy's, and the rules of whose a watch is are the older ones (chat/watchers.ts `orphaned`). */
export function liveHost(registry: Registry, root: string, probe: Probe = PROBE): Host | undefined {
  const entry = registry.find(root);
  const host = entry === undefined ? undefined : recordedHost(entry);

  return host !== undefined && presenceOf(host, probe).is === "there" ? host : undefined;
}

/** Whether the process `pid` that started at `started` is `host`. */
export function isHost(host: Host, pid: number, started: string | null | undefined): boolean {
  return host.pid === pid && (host.started === undefined || started === null || started === undefined || host.started === started);
}
