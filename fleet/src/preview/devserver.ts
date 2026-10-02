/**
 * The dev servers a preview runs: which command (given, the ledger's, or the repository's `dev` script),
 * on which port and base, the one-time install a fresh workspace needs, and starting and stopping each as
 * a process group of its own that outlives the command that started it.
 *
 * Vite is told its base (`--base /f/<fleet>/preview/`), its port and its host, so every URL its page asks
 * for, the HMR socket included, is under the hub's path for it (evidence in the SPEC's Preview section).
 * Vite+ (`vp dev`) is Vite. A command that names neither `{port}` nor `{base}` and is not Vite runs as given,
 * with `PORT` set, at its own root: the hub then strips the prefix, which works for a server whose pages use
 * relative URLs only.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";

import { PreviewError } from "../errors.ts";
import { exists, makeDirs, readText } from "../files.ts";
import { asObject, asString, parseObject } from "../json.ts";
import { alive } from "../registry.ts";

/** The package manager a directory's lockfile names, npm when none does. */
export function packageManager(dir: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (exists(join(dir, "bun.lock")) || exists(join(dir, "bun.lockb"))) return "bun";

  if (exists(join(dir, "pnpm-lock.yaml"))) return "pnpm";

  if (exists(join(dir, "yarn.lock"))) return "yarn";

  return "npm";
}

/** The `scripts` of the directory's package.json; undefined when there is none. */
function scripts(dir: string): Readonly<Record<string, string>> | undefined {
  const text = readText(join(dir, "package.json"));
  const pkg = text === undefined ? undefined : Option.getOrUndefined(parseObject(text));

  if (pkg === undefined) return undefined;
  const table = asObject(pkg["scripts"]) ?? {};

  return Object.fromEntries(Object.entries(table).flatMap(([k, v]) => (asString(v) === undefined ? [] : [[k, asString(v) ?? ""]])));
}

/** A dev command, before its port and base are known. */
export interface Planned {
  readonly template: string;
  /** Where it came from, for the messages. */
  readonly from: "--cmd" | "the ledger" | "package.json";
}

/** The dev command for `dir`: `given`, else the ledger's, else `<pm> run dev` when package.json has a `dev`
 * script; why not otherwise. */
export function planCommand(dir: string, given: string | undefined, recorded: string | undefined): Planned | PreviewError {
  if (given !== undefined && given.trim() !== "") return { template: given, from: "--cmd" };

  if (recorded !== undefined && recorded.trim() !== "") return { template: recorded, from: "the ledger" };
  const table = scripts(dir);

  if (table === undefined) return new PreviewError({ reason: `no dev command: ${dir} has no package.json; give --cmd "<dev command>", or record one with \`fleet preview <dir> set --cmd "..."\`` });

  if (table["dev"] === undefined) {
    return new PreviewError({ reason: `no dev command: ${join(dir, "package.json")} has no \`dev\` script; give --cmd "<dev command>", or record one with \`fleet preview <dir> set --cmd "..."\`` });
  }


  return { template: `${packageManager(dir)} run dev`, from: "package.json" };
}

/** A Vite or Vite+ dev server started in a command: `vite` (bare, `dev` or `serve`), `vp dev`, `vite-plus dev`;
 * not their build, preview or other subcommands, and not bare `vp`, which prints its help. */
const VITE_DEV = /(?<![\w.-])(?:vite(?![\w.-])(?!\s+(?:build|preview|optimize)\b)|(?:vp|vite-plus)\s+dev\b)/;

/** A command that runs one package.json script: `<pm> [run] <script>`, `vp run <script>` or `vpr <script>`. */
const SCRIPT = /^\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?|vp\s+run\s+|vpr\s+)([\w:.-]+)\s*$/;

/** Whether a command starts a Vite (or Vite+) dev server: it runs one, or runs a package.json script that does. */
function runsVite(dir: string, command: string): boolean {
  if (VITE_DEV.test(command)) return true;
  const script = SCRIPT.exec(command)?.[1];
  const body = script === undefined ? undefined : scripts(dir)?.[script];

  return body !== undefined && VITE_DEV.test(body);
}

/** A dev command ready to run. */
export interface Ready {
  readonly cmd: string;
  /** The base the server serves under: the hub's path for it, or `/`. */
  readonly base: string;
}

/** The command that runs on `port` under `base`: `{port}` and `{base}` filled in; Vite told both (and to
 * listen on 127.0.0.1, where the hub reaches it); anything else run as it is, at its root. */
export function fill(dir: string, template: string, port: number, base: string): Ready {
  if (template.includes("{port}") || template.includes("{base}")) {
    return { cmd: template.replaceAll("{port}", String(port)).replaceAll("{base}", base), base: template.includes("{base}") ? base : "/" };
  }

  if (runsVite(dir, template)) {
    const separator = /^\s*npm\s/.test(template) && !/\s--(\s|$)/.test(template) ? " --" : "";

    return { cmd: `${template}${separator} --port ${port} --strictPort --host 127.0.0.1 --base ${base}`, base };
  }

  return { cmd: template, base: "/" };
}

/** The install a fresh workspace needs before its dev server runs, or undefined when it needs none: a
 * package.json with no node_modules beside it. A lockfile is installed as it is (`npm ci`, frozen), so the
 * install never changes a tracked file. */
export function setupCommand(dir: string, given: string | undefined): string | undefined {
  if (given !== undefined && given.trim() !== "") return given;

  if (!exists(join(dir, "package.json")) || exists(join(dir, "node_modules"))) return undefined;

  switch (packageManager(dir)) {
    case "bun":
      return "bun install --frozen-lockfile";
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "npm":
      return exists(join(dir, "package-lock.json")) ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
  }
}

/** Run the install in `dir`, its output appended to `log`; why not, when it fails. */
export function runSetup(dir: string, command: string, log: string): string | undefined {
  makeDirs(join(log, ".."));
  const fd = openSync(log, "a");

  try {
    const done = spawnSync("/bin/sh", ["-c", command], { cwd: dir, stdio: ["ignore", fd, fd], timeout: 15 * 60_000, env: { ...process.env, CI: "1" } });

    if (done.error !== undefined) return `${command} could not run: ${done.error.message}`;

    return done.status === 0 ? undefined : `${command} exited ${done.status ?? "on a signal"}; its output is in ${log}:\n${tail(readText(log) ?? "", 15)}`;
  } finally {
    closeSync(fd);
  }
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  void probe.stop(true);

  return port;
}

/** Start `cmd` in `dir` as a process group of its own, detached, its output appended to `log`; its pid. */
export function startServer(dir: string, cmd: string, port: number, log: string, env: Readonly<Record<string, string>>): number | PreviewError {
  makeDirs(join(log, ".."));
  const fd = openSync(log, "a");

  try {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ...env, PORT: String(port), BROWSER: "none", NO_COLOR: "1", FORCE_COLOR: "0" },
    });

    child.unref();

    return child.pid ?? new PreviewError({ reason: `${cmd} could not start` });
  } finally {
    closeSync(fd);
  }
}

/** Start a detached process (the updater) with `argv`, its output appended to `log`; its pid. */
export function startDetached(argv: readonly string[], cwd: string, log: string, env: Readonly<Record<string, string>>): number | PreviewError {
  makeDirs(join(log, ".."));
  const fd = openSync(log, "a");
  const [program = "", ...args] = argv;

  try {
    const child = spawn(program, args, { cwd, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...env } });
    child.unref();

    return child.pid ?? new PreviewError({ reason: `${program} could not start` });
  } finally {
    closeSync(fd);
  }
}

/** Whether process `pid` runs: it exists and is not a zombie waiting for its parent to reap it (a dev
 * server stopped while the process that started it still runs). */
export function isRunning(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || !alive(pid)) return false;

  if (process.platform === "darwin") return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().startsWith("Z");
  const stat = readText(`/proc/${pid}/stat`);

  return stat === undefined || stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
}

/** Stop the process group `pid` leads (TERM, then KILL after `graceMs`); whether it is gone. */
export function stopGroup(pid: number | null, graceMs = 3000): boolean {
  if (pid === null || !isRunning(pid)) return true;

  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pid, name);
    } catch {
      try {
        process.kill(pid, name);
      } catch {
        // already gone
      }
    }
  };

  signal("SIGTERM");
  const deadline = Date.now() + graceMs;

  while (isRunning(pid) && Date.now() < deadline) Bun.sleepSync(50);

  if (isRunning(pid)) {
    signal("SIGKILL");
    Bun.sleepSync(100);
  }

  return !isRunning(pid);
}

/** The last 64 KiB of a log, as text ("" when there is none). */
export function logTail(path: string): string {
  const text = readText(path) ?? "";

  return text.length > 65536 ? text.slice(-65536) : text;
}

/** The last `n` lines of `text`. */
export function tail(text: string, n: number): string {
  return text.split("\n").filter((l, i, all) => l !== "" || i < all.length - 1).slice(-n).join("\n");
}

// oxlint-disable-next-line no-control-regex -- terminal colour codes are control characters by definition.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

const ERROR = /\b(?:error|failed to|cannot find|could not|unexpected token|is not defined)\b|✘|\[plugin:/i;

const RECOVERED = /\bhmr update\b|\bpage reload\b|\bready in\b|\bcompiled\b.*\bsuccessfully\b/i;

/** A log line that says when (Vite's `7:51:06 PM [vite] …`, a bracketed or ISO time). */
const STAMPED = /^\s*(?:\d{1,2}:\d{2}:\d{2}|\[\d|\d{4}-\d{2}-\d{2}T)/;

/** A stack frame or a line of box drawing: noise in an error's first lines. */
const NOISE = /^\s*(?:at\s|[│╭╰─┬\s]*$)/;

/**
 * The dev server's last error in its log: the burst of lines that holds the last line reading as an error
 * (from the first error line after the last line that said when and was no error, so Vite's "Internal server
 * error" and its parse error come before its "see errors above"), without stack frames and box drawing, at
 * most ten lines; null when there is none, or when the server has reloaded or updated a page since.
 */
export function lastError(log: string): string | null {
  const lines = log.replace(ANSI, "").split("\n").slice(-400);
  const last = lines.findLastIndex((l) => ERROR.test(l));

  if (last < 0 || lines.slice(last + 1).some((l) => RECOVERED.test(l))) return null;
  const calm = lines.slice(0, last).findLastIndex((l) => STAMPED.test(l) && !ERROR.test(l));
  const first = lines.findIndex((l, i) => i > calm && i >= last - 60 && ERROR.test(l));

  return lines
    .slice(first, last + 1)
    .filter((l) => l.trim() !== "" && !NOISE.test(l))
    .slice(0, 10)
    .join("\n")
    .trimEnd();
}
