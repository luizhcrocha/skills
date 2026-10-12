/**
 * Processes on this machine, read from /proc: the background processes a fleet's session started (each
 * writes into the session's tasks/ directory), a process's parents, its working directory and command.
 * The Mac has no /proc: there the same facts come from `ps` and `lsof`.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { readText, resolvePath } from "./files.ts";

/** A background process a fleet's session started. */
export interface Proc {
  readonly pid: number;
  readonly started: number;
  readonly command: string;
}

const DARWIN = process.platform === "darwin";

/** The stdout of `program ARGS`, or "" when it cannot run. lsof exits 1 when it finds nothing. */
function run(program: string, args: readonly string[]): string {
  const done = spawnSync(program, args, { encoding: "utf8", timeout: 10000 });

  return done.error === undefined ? (done.stdout ?? "") : "";
}

/** `lsof -F pn` output: pid -> the names (paths, addresses) it has open, in order. */
export function lsofFiles(text: string): Map<number, string[]> {
  const files = new Map<number, string[]>();
  let pid: number | undefined;

  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));

      if (!files.has(pid)) files.set(pid, []);
    } else if (line.startsWith("n") && pid !== undefined) files.get(pid)?.push(line.slice(1));
  }

  return files;
}

/** `ps -o etime=` (`[[dd-]hh:]mm:ss`) in seconds, or NaN. */
export function elapsedOf(text: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());

  if (m === null) return Number.NaN;

  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

function darwinProcesses(tasks: string): Proc[] {
  const now = Date.now() / 1000;
  const found: Proc[] = [];

  for (const pid of lsofFiles(run("lsof", ["-n", "-F", "pn", "+D", tasks])).keys()) {
    const elapsed = elapsedOf(run("ps", ["-o", "etime=", "-p", String(pid)]));

    if (Number.isNaN(elapsed)) continue;
    const args = commandOf(pid);
    const wrapped = /eval '([^']*)'/.exec(args)?.[1];
    found.push({ pid, started: now - elapsed, command: wrapped ?? args });
  }

  return found.sort((a, b) => a.started - b.started);
}

export function processes(root: string): Proc[] {
  const tasks = join(dirname(dirname(resolvePath(root))), "tasks");

  if (DARWIN) return darwinProcesses(tasks);
  const boot = Number(/^btime (\d+)/m.exec(readText("/proc/stat") ?? "")?.[1]);

  if (Number.isNaN(boot)) return [];
  const tick = 100;
  const found: Proc[] = [];

  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let links: string[];

    try {
      links = readdirSync(join("/proc", name, "fd")).map((fd) => readlinkSync(join("/proc", name, "fd", fd)));
    } catch {
      continue;
    }

    if (!links.some((l) => l.startsWith(`${tasks}/`))) continue;

    try {
      const stat = (readText(join("/proc", name, "stat")) ?? "").split(")").at(-1)?.trim().split(/\s+/) ?? [];
      const args = readFileSync(join("/proc", name, "cmdline")).toString("utf8").replaceAll("\0", " ").trim();
      const wrapped = /eval '([^']*)'/.exec(args)?.[1];
      found.push({ pid: Number(name), started: boot + Number(stat[19]) / tick, command: wrapped ?? args });
    } catch {
      continue;
    }
  }

  return found.sort((a, b) => a.started - b.started);
}

/** `pid` and its parents, nearest first (at most 32). */
export function ancestry(pid: number): number[] {
  const chain: number[] = [];
  const parents = DARWIN ? parentsOf(run("ps", ["-A", "-o", "pid=,ppid="])) : undefined;
  let at = pid;

  while (at > 1 && chain.length < 32) {
    chain.push(at);
    const parent = parents !== undefined ? (parents.get(at) ?? Number.NaN) : Number((readText(join("/proc", String(at), "stat")) ?? "").split(")").at(-1)?.trim().split(/\s+/)[1]);

    if (!Number.isInteger(parent)) break;
    at = parent;
  }

  return chain;
}

/** The fields of /proc/PID/stat after the command's name (which may hold spaces and parentheses): the
 * state first, then the parent, the group, the session, the terminal; undefined when `pid` does not run. */
function statOf(pid: number): string[] | undefined {
  const text = readText(join("/proc", String(pid), "stat"));

  return text === undefined ? undefined : (text.split(")").at(-1)?.trim().split(/\s+/) ?? []);
}

/** One `ps` column of `pid` (`-o NAME=`), trimmed, in the C locale so a date reads the same to every reader;
 * "" when `pid` does not run. */
function psColumn(pid: number, column: string): string {
  const done = spawnSync("ps", ["-o", `${column}=`, "-p", String(pid)], { encoding: "utf8", timeout: 10000, env: { ...process.env, LC_ALL: "C" } });

  return done.error === undefined ? (done.stdout ?? "").trim() : "";
}

/** The parent of `pid`, or undefined when `pid` does not run. */
export function parentOf(pid: number): number | undefined {
  const parent = Number(DARWIN ? psColumn(pid, "ppid") || Number.NaN : statOf(pid)?.[1]);

  return Number.isInteger(parent) ? parent : undefined;
}

/** When `pid` started, as the system says it: the same text for the same process whoever reads it, and another
 * for a later process with the same pid. Linux: the start time in clock ticks since boot (/proc/PID/stat,
 * field 22); the Mac: `ps -o lstart=`. Undefined when `pid` does not run. The plugin's hook reads it the
 * same way (`_proc_started` in hooks/tstack-hook). */
export function startedOf(pid: number): string | undefined {
  const started = DARWIN ? psColumn(pid, "lstart") : (statOf(pid)?.[19] ?? "");

  return started === "" ? undefined : started;
}

/** Whether `pid` has a controlling terminal (/proc/PID/stat's tty_nr; on the Mac, `ps -o tty=`, `??` for
 * none). A background command of a Claude Code session has none; a command a person typed has one. */
export function hasTerminal(pid: number): boolean {
  if (DARWIN) {
    const tty = psColumn(pid, "tty");

    return tty !== "" && !tty.startsWith("?");
  }

  const tty = Number(statOf(pid)?.[4]);

  return Number.isInteger(tty) && tty !== 0;
}

/** `ps -o pid=,ppid=` output: pid -> parent pid. */
export function parentsOf(text: string): Map<number, number> {
  const parents = new Map<number, number>();

  for (const line of text.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);

    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid ?? 0, ppid ?? 0);
  }

  return parents;
}

/** The working directory of `pid`, or "". */
export function cwdOf(pid: number): string {
  if (DARWIN) return lsofFiles(run("lsof", ["-a", "-n", "-p", String(pid), "-d", "cwd", "-F", "pn"])).get(pid)?.[0] ?? "";

  try {
    return readlinkSync(join("/proc", String(pid), "cwd"));
  } catch {
    return "";
  }
}

/** The command line of `pid`, its arguments joined by spaces, or "". */
export function commandOf(pid: number): string {
  if (DARWIN) return run("ps", ["-o", "command=", "-p", String(pid)]).trim();

  try {
    return readFileSync(join("/proc", String(pid), "cmdline")).toString("utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
}

/** The binary `pid` runs (/proc/PID/exe; on the Mac, ps's comm, a path), or "". */
export function exeOf(pid: number): string {
  if (DARWIN) return run("ps", ["-o", "comm=", "-p", String(pid)]).trim();

  try {
    return readlinkSync(join("/proc", String(pid), "exe"));
  } catch {
    return "";
  }
}

/** Whether a process named `name` running `exe` is Claude Code: the native install runs `claude/versions/<version>`, so its name is the version. */
export function isClaudeBinary(name: string, exe: string): boolean {
  return name === "claude" || /\/claude\/versions\/[^/]+$/u.test(exe);
}

/** The short name of `pid` (/proc/PID/comm; on the Mac, the base name of ps's comm, a path), or "". */
export function nameOf(pid: number): string {
  if (DARWIN) {
    const comm = run("ps", ["-o", "comm=", "-p", String(pid)]).trim();

    return comm === "" ? "" : basename(comm);
  }

  return (readText(join("/proc", String(pid), "comm")) ?? "").trim();
}

/** What the machine says of a process that is to be written to: whether it is Claude Code and when it started
 * ({@link startedOf}'s text); `gone` when it does not run; `unknown` when the machine could not be asked (on
 * the Mac a `ps` that failed or timed out, which is not a process that is gone). */
export type Running = { readonly claude: boolean; readonly started: string } | "gone" | "unknown";

/** One `ps` column of `pid` in the C locale: its text, "" when `pid` does not run (ps exits 1 with nothing),
 * undefined when ps itself could not run, timed out or failed otherwise. */
function psAsked(pid: number, column: string): string | undefined {
  const done = spawnSync("ps", ["-o", `${column}=`, "-p", String(pid)], { encoding: "utf8", timeout: 10000, env: { ...process.env, LC_ALL: "C" } });

  if (done.error !== undefined || done.status === null || done.status > 1) return undefined;

  return (done.stdout ?? "").trim();
}

/** {@link Running} of `pid`: /proc on Linux, `ps` on the Mac. */
export function runningOf(pid: number): Running {
  if (DARWIN) {
    const started = psAsked(pid, "lstart");
    const comm = started === undefined || started === "" ? started : psAsked(pid, "comm");

    if (started === undefined || comm === undefined) return "unknown";

    return started === "" || comm === "" ? "gone" : { claude: isClaudeBinary(basename(comm), comm), started };
  }

  const started = statOf(pid)?.[19];

  return started === undefined || started === "" ? "gone" : { claude: isClaudeBinary(nameOf(pid), exeOf(pid)), started };
}

/** The bytes a Unix socket's address holds for its path on Linux (`sun_path`), the closing NUL included. */
const SUN_PATH = 108;

/** Whether `path` is a socket file. */
function isSocketFile(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

/** The Unix sockets bound to a path, as /proc/net/unix lists them (`Num RefCount Protocol Flags Type St Inode
 * Path`): each one's inode and the path as it was given to bind. Undefined when the file does not read. */
function boundSockets(): { readonly inode: string; readonly path: string }[] | undefined {
  const text = readText("/proc/net/unix");

  if (text === undefined) return undefined;

  return text.split("\n").flatMap((line) => {
    const fields = line.split(" ");
    const inode = fields[6];
    const path = fields.slice(7).join(" ");

    return inode !== undefined && path !== "" ? [{ inode, path }] : [];
  });
}

/**
 * Whether process `pid` holds the Unix socket bound at `path`: a socket file named after a pid says nothing of
 * who listens on it.
 *
 * Linux (measured 2026-10-12, Bun 1.4): the socket is among the files `pid` has open (/proc/PID/fd,
 * `socket:[inode]`), and /proc/net/unix lists that inode with the path it was bound to, which must be `path`.
 * Claude Code's own folder is short, so that is the whole rule there. A `path` longer than a socket address
 * holds ({@link SUN_PATH} bytes: a test's folder, a long `FLEET_CC_SOCKS`) cannot be bound as it is: Bun binds
 * it as `/proc/self/fd/<n>/<name>` and closes `<n>`, so the folder is not to be read back; then `path` must be
 * a socket file and the name the same. That one case is weaker: a process listening on the same name in
 * another long folder reads as holding this one. The Mac (read in lsof's manual, not measured): `lsof -a -p
 * PID -U -F pn` names it. `unknown` when the machine could not be asked.
 */
export function holdsSocket(pid: number, path: string): boolean | "unknown" {
  if (DARWIN) {
    const done = spawnSync("lsof", ["-a", "-n", "-p", String(pid), "-U", "-F", "pn"], { encoding: "utf8", timeout: 10000 });

    // lsof exits 1 when it lists nothing.
    if (done.error !== undefined || done.status === null || done.status > 1) return "unknown";

    return (lsofFiles(done.stdout ?? "").get(pid) ?? []).some((name) => name === path || name.startsWith(`${path} `));
  }

  const bound = boundSockets();

  if (bound === undefined) return "unknown";
  let open: string[];

  try {
    open = readdirSync(join("/proc", String(pid), "fd"));
  } catch (cause: unknown) {
    // SAFETY: node's fs errors carry a code; a process that is gone has no fd folder.
    return (cause as { readonly code?: string }).code === "ENOENT" ? false : "unknown";
  }

  const held = new Set(
    open.flatMap((fd) => {
      try {
        return /^socket:\[(\d+)\]$/u.exec(readlinkSync(join("/proc", String(pid), "fd", fd)))?.[1] ?? [];
      } catch {
        return [];
      }
    }),
  );

  const long = Buffer.byteLength(path) >= SUN_PATH && isSocketFile(path);

  return bound.some((b) => held.has(b.inode) && (b.path === path || (long && b.path.startsWith("/proc/self/fd/") && basename(b.path) === basename(path))));
}

/** When `pid` started, in ms since the epoch, to the second: boot time plus its start in clock ticks on Linux,
 * `ps -o lstart=` on the Mac. Undefined when `pid` does not run or the time does not read. */
export function startedMsOf(pid: number): number | undefined {
  if (DARWIN) {
    const at = Date.parse(psColumn(pid, "lstart"));

    return Number.isNaN(at) ? undefined : at;
  }

  const boot = Number(/^btime (\d+)/m.exec(readText("/proc/stat") ?? "")?.[1]);
  const ticks = Number(statOf(pid)?.[19]);

  return Number.isNaN(boot) || Number.isNaN(ticks) ? undefined : (boot + ticks / 100) * 1000;
}
