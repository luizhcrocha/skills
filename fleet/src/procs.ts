/**
 * Processes on this machine, read from /proc: the background processes a fleet's session started (each
 * writes into the session's tasks/ directory), a process's parents, its working directory and command.
 * The Mac has no /proc: there the same facts come from `ps` and `lsof`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
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
