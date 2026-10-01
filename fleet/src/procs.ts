/**
 * Processes on this machine, read from /proc: the background processes a fleet's session started (each
 * writes into the session's tasks/ directory), a process's parents, its working directory and command.
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { readText, resolvePath } from "./files.ts";

/** A background process a fleet's session started. */
export interface Proc {
  readonly pid: number;
  readonly started: number;
  readonly command: string;
}

export function processes(root: string): Proc[] {
  const tasks = join(dirname(dirname(resolvePath(root))), "tasks");
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
  let at = pid;

  while (at > 1 && chain.length < 32) {
    chain.push(at);
    const parent = Number((readText(join("/proc", String(at), "stat")) ?? "").split(")").at(-1)?.trim().split(/\s+/)[1]);

    if (!Number.isInteger(parent)) break;
    at = parent;
  }

  return chain;
}

/** The working directory of `pid`, or "". */
export function cwdOf(pid: number): string {
  try {
    return readlinkSync(join("/proc", String(pid), "cwd"));
  } catch {
    return "";
  }
}

/** The command line of `pid`, its arguments joined by spaces, or "". */
export function commandOf(pid: number): string {
  try {
    return readFileSync(join("/proc", String(pid), "cmdline")).toString("utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
}

/** The short name of `pid` (/proc/PID/comm), or "". */
export function nameOf(pid: number): string {
  return (readText(join("/proc", String(pid), "comm")) ?? "").trim();
}
