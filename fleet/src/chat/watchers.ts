/**
 * Which processes are chat watches (Python's `chat.py` `_is_watch`, after the Stop hook's `watch_alive`):
 * a `--once` watch as WHO for DIR is told by its command line, so a pid reused by another program does
 * not count, and one whose pid file another watch removed is still found among the running processes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { resolvePath } from "../files.ts";

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

/** The pid of a running `--once` watch as `who` for `root`: the one its pid file names, else one found
 * among the running processes (its pid file removed by another watch's exit, or not written yet). */
export function liveWatch(root: string, who: string, pidFile: number | undefined): number | undefined {
  const dir = resolvePath(root);

  if (pidFile !== undefined && pidFile > 0 && isWatch(pidFile, dir, who)) return pidFile;

  return processes().find(({ proc }) => isWatchOf(proc, dir, who))?.pid;
}
