/**
 * Which processes are chat watches (Python's `chat.py` `_is_watch`, after the Stop hook's `watch_alive`):
 * a `--once` watch as WHO for DIR is told by its command line, so a pid reused by another program does
 * not count, and one whose pid file another watch removed is still found among the running processes.
 *
 * And whose each is (TypeScript only; the frozen twin does not read it): a watch's lines wake the session
 * that armed it, so a watch whose session is gone hears for nobody. It is orphaned ({@link orphaned}), and
 * then it is no live watch to `listening`, to `fleet fleets list`, to the hub's wake, or to the next watch,
 * which takes its place (watch.ts). The plugin's Stop guard keeps the same rule (`_watch_orphaned` in
 * hooks/tstack-hook): change the two together.
 *
 * And a watch as the host's role armed by a session that is not the fleet's host (host.ts: the session the
 * registry entry names) wakes a copy of the host, or a terminal, while the host hears nothing: it is
 * {@link foreign}, and counts as no watch exactly as an orphan does (`_watch_foreign` in the hook).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { readText, remove, resolvePath, writeText } from "../files.ts";
import { asNumber, asString, dumps, parseObject } from "../json.ts";
import { isHost, type Host } from "../host.ts";
import { exeOf, hasTerminal, isClaudeBinary, nameOf, parentOf, startedOf } from "../procs.ts";

import * as Option from "effect/Option";

/** A running process: its arguments, and its working directory ("" when unknown). */
interface Proc {
  readonly argv: readonly string[];
  readonly cwd: string;
}

const PROC = existsSync("/proc/self");

/** `pid`'s arguments and working directory from /proc on Linux, else `ps` (no cwd); undefined when it does
 * not run, or (`watches`) when its arguments have no `watch`, whose working directory is then not read. */
function processOf(pid: number, watches = false): Proc | undefined {
  if (PROC) {
    let raw: string;

    try {
      raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return undefined;
    }

    const argv = raw.split("\0").filter((a) => a !== "");

    if (argv.length === 0 || (watches && !argv.includes("watch"))) return undefined;
    let cwd = "";

    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // another user's process: its command line still names an absolute DIR
    }

    return { argv, cwd };
  }

  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  const line = ps.status === 0 ? ps.stdout.trim() : "";

  return line === "" ? undefined : { argv: line.split(/\s+/), cwd: "" };
}

/** Every running process but this one, with its pid. */
function processes(): { readonly pid: number; readonly proc: Proc }[] {
  if (PROC) {
    return readdirSync("/proc").flatMap((name) => {
      const pid = /^\d+$/.test(name) ? Number(name) : undefined;
      const proc = pid === undefined || pid === process.pid ? undefined : processOf(pid, true);

      return pid === undefined || proc === undefined ? [] : [{ pid, proc }];
    });
  }

  const ps = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", timeout: 3000 });

  return (ps.status === 0 ? ps.stdout : "").split("\n").flatMap((line) => {
    const [head, ...argv] = line.trim().split(/\s+/);
    const pid = Number(head);

    return Number.isInteger(pid) && pid !== process.pid && argv.length > 0 ? [{ pid, proc: { argv, cwd: "" } }] : [];
  });
}

/** Whether `proc` runs `fleet chat DIR watch --as WHO --once` (or `chat.py DIR watch ...`) for `root`. */
function isWatchOf(proc: Proc, root: string, who: string): boolean {
  const { argv } = proc;
  const role = who.toLowerCase();

  for (let i = 1; i + 1 < argv.length; i += 1) {
    const program = argv[i - 1] ?? "";

    if (argv[i + 1] !== "watch" || (program !== "chat" && basename(program) !== "chat.py")) continue;
    const given = argv[i] ?? "";

    if (!isAbsolute(given) && proc.cwd === "") continue;

    if (resolvePath(isAbsolute(given) ? given : join(proc.cwd, given)) !== root) continue;
    const rest = argv.slice(i + 2);
    const asWho = rest.some((w, j) => (w === "--as" && rest[j + 1]?.toLowerCase() === role) || w.toLowerCase() === `--as=${role}`);

    if (asWho && rest.includes("--once")) return true;
  }

  return false;
}

/** Whether `pid` runs a `--once` watch as `who` for the chat in `root`. */
export function isWatch(pid: number, root: string, who: string): boolean {
  const proc = processOf(pid);

  return proc !== undefined && isWatchOf(proc, resolvePath(root), who);
}

/** What the rule of whose a watch is reads of the machine's processes; a test gives a tree of its own. */
export interface Tree {
  /** The parent of `pid`, or undefined when `pid` does not run. */
  readonly parent: (pid: number) => number | undefined;
  /** When `pid` started (procs.ts `startedOf`), or undefined when it does not run. */
  readonly started: (pid: number) => string | undefined;
  /** Whether `pid` is a Claude Code process. */
  readonly claude: (pid: number) => boolean;
  /** Whether `pid` has a controlling terminal. */
  readonly terminal: (pid: number) => boolean;
}

/** This machine's processes. */
export const TREE: Tree = { parent: parentOf, started: startedOf, claude: (pid) => isClaudeBinary(nameOf(pid), exeOf(pid)), terminal: hasTerminal };

/** The session that armed a watch, as the watch recorded it when it began. */
export interface Owner {
  /** The watch's own pid: the record is of this watch and no other. */
  readonly watch: number;
  /** The Claude Code process it runs under, or null when none does (a person armed it in a terminal). */
  readonly session: number | null;
  /** When that process started, so a later process with its pid is not taken for it. */
  readonly started: string | null;
}

/** Where a running `--once` watch as `who` records the session that armed it, beside its pid file. Named
 * `.pid` as that one is: it is of the processes running now, and the oracle leaves such files out. */
export function ownerPath(root: string, who: string): string {
  return join(root, `watch-${who}.owner.pid`);
}

/** The nearest Claude Code process above `pid` (at most 32 parents up), with when it started: the session
 * whose background command `pid` is. Undefined when there is none. Measured on Linux, Claude Code 2.1.293:
 * a watch armed as a background command is the child of a `zsh -c` wrapper, itself the child of `claude`. */
export function sessionAbove(pid: number, tree: Tree = TREE): { readonly pid: number; readonly started: string } | undefined {
  let at = tree.parent(pid);

  for (let hops = 0; at !== undefined && at > 1 && hops < 32; hops += 1) {
    if (tree.claude(at)) {
      const started = tree.started(at);

      return started === undefined ? undefined : { pid: at, started };
    }

    at = tree.parent(at);
  }

  return undefined;
}

/** Record whose this watch is (the process's own), before its pid file names it; the record. */
export function recordOwner(root: string, who: string, tree: Tree = TREE): Owner {
  const session = sessionAbove(process.pid, tree);
  const owner: Owner = { watch: process.pid, session: session?.pid ?? null, started: session?.started ?? null };

  writeText(ownerPath(root, who), `${dumps({ ...owner })}\n`);

  return owner;
}

/** Drop this watch's record, when it is still its own. */
export function forgetOwner(root: string, who: string): void {
  if (readOwner(root, who)?.watch === process.pid) remove(ownerPath(root, who));
}

/** The record beside the pid file, or undefined when there is none or it does not read. */
export function readOwner(root: string, who: string): Owner | undefined {
  const raw = Option.getOrUndefined(parseObject(readText(ownerPath(root, who)) ?? ""));
  const watch = asNumber(raw?.["watch"]);

  if (raw === undefined || watch === undefined) return undefined;

  return { watch, session: asNumber(raw["session"]) ?? null, started: asString(raw["started"]) ?? null };
}

/**
 * Whether the watch `pid` hears for nobody: the session that armed it is gone.
 *
 * - A watch that recorded its session (`owner` is its own record) is orphaned when that process no longer
 *   runs, or another one has its pid (another start time). One that recorded none was armed by a person in a
 *   terminal, and is never orphaned.
 * - A watch with no record of its own (armed before the record existed, or this instant) is orphaned when
 *   it has no controlling terminal and no Claude Code process is above it. Measured on Linux, 2026-10-12:
 *   when the session dies, the watch's wrapper shell is given to pid 1, and neither had a terminal; a
 *   watch a person typed in a terminal has one, so it is not read as orphaned though no session is above it.
 */
export function orphaned(pid: number, owner: Owner | undefined, tree: Tree = TREE): boolean {
  if (owner !== undefined && owner.watch === pid) {
    if (owner.session === null) return false;
    const started = tree.started(owner.session);

    return started === undefined || (owner.started !== null && started !== owner.started);
  }

  return !tree.terminal(pid) && sessionAbove(pid, tree) === undefined;
}

/**
 * Whether the watch `pid`, a watch as the host's role, hears for someone who is not the fleet's host: `host`
 * is the session the registry names (host.ts `liveHost`), and the watch was armed by another session (a fork
 * of the host, a second resume of its transcript) or by nobody's (a terminal). Its lines wake that one, and
 * the cursor it moves is the host's: the host would never see what it printed. With no `host` known, no
 * watch is foreign. Whose the watch is: its own record, else the Claude Code process above it.
 */
export function foreign(pid: number, owner: Owner | undefined, host: Host | undefined, tree: Tree = TREE): boolean {
  if (host === undefined) return false;

  if (owner !== undefined && owner.watch === pid) return owner.session === null || !isHost(host, owner.session, owner.started);
  const session = sessionAbove(pid, tree);

  return session === undefined || !isHost(host, session.pid, session.started);
}

/** Whose the watch `pid` is, in words, for the watch that is refused because of it. */
export function ownerWords(pid: number, owner: Owner | undefined, tree: Tree = TREE): string {
  const session = owner !== undefined && owner.watch === pid ? owner.session : (sessionAbove(pid, tree)?.pid ?? null);

  return session === null
    ? "armed outside a Claude Code session (in a terminal) and still running: its lines print there"
    : `armed by the Claude Code session running as pid ${String(session)}, which is live: its lines wake that session`;
}

/** The pid of a running `--once` watch as `who` for `root` whose session is not gone: the one its pid file
 * names, else one found among the running processes (its pid file removed by another watch's exit, or not
 * written yet). An orphaned watch ({@link orphaned}) is not one; nor, when `who` is the fleet's host and
 * `host` its session, is a watch another session armed ({@link foreign}). */
export function liveWatch(root: string, who: string, pidFile: number | undefined, tree: Tree = TREE, host: Host | undefined = undefined): number | undefined {
  const dir = resolvePath(root);
  const owner = readOwner(dir, who);
  const hears = (pid: number): boolean => !orphaned(pid, owner, tree) && !foreign(pid, owner, host, tree);

  if (pidFile !== undefined && pidFile > 0 && isWatch(pidFile, dir, who) && hears(pidFile)) return pidFile;

  return processes().find(({ pid, proc }) => isWatchOf(proc, dir, who) && hears(pid))?.pid;
}
