/**
 * The file system as the fleet uses it: whole files read as text (absent when they cannot be read),
 * written whole, and paths resolved as Python's `Path.resolve()` does (symlinks followed, the missing
 * tail kept). Every failure the fleet tolerates is a value here, never a throw.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The coordinator skill's directory: the templates (assets/) brief.md and the page are made from. */
export const SKILL_DIR = resolvePath(fileURLToPath(new URL("../../skills/productivity/coordinator", import.meta.url)));

/** This CLI's own path, `<plugin>/fleet/bin/fleet`, as every printed command names it. */
export const FLEET_BIN = join(resolve(SKILL_DIR, "..", "..", ".."), "fleet", "bin", "fleet");

/**
 * Every path the fleet CLI has on this machine, resolved: this plugin's ({@link FLEET_BIN}), and the ones
 * fleet/bin/fleet hands over to (the checkouts in $CLAUDE_CODE_PLUGIN_DIRS, the marketplace clone, each cached
 * version). A session keeps the plugin folder it started with, and the CLI prints the newest one's path, so a session
 * names more than one. The hook's `_fleet_clis` (hooks/tstack-hook-monitor.py) is the same set.
 */
export function fleetClis(env: (name: string) => string | undefined): ReadonlySet<string> {
  const home = env("HOME") ?? "";
  const roots = [resolve(FLEET_BIN, "..", "..", ".."), ...(env("CLAUDE_CODE_PLUGIN_DIRS") ?? "").split(":")];

  if (isAbsolute(home)) {
    const plugins = join(home, ".claude", "plugins");
    const cache = join(plugins, "cache", "tstack", "tstack");
    roots.push(join(plugins, "marketplaces", "tstack"));

    try {
      roots.push(...readdirSync(cache).map((version) => join(cache, version)));
    } catch {
      // no cached version
    }
  }

  return new Set(roots.flatMap((root) => (isAbsolute(root) ? [resolvePath(join(root, "fleet", "bin", "fleet"))] : [])));
}

/** Whether `program`, the first word of a command, runs the fleet CLI: a bare `fleet` (found on PATH), or an
 * absolute path that resolves to one of {@link fleetClis}, one shell word of path characters (`/x;/<plugin>/...`
 * runs /x first) with no `.`, `..` or empty component: resolving drops `/s/..` before it follows the link s, the
 * kernel follows s first, so `/link/../fleet/bin/fleet` can resolve to the CLI and run another file. Another file
 * named `fleet`, wherever it sits, does not. */
export function isFleetCli(program: string, env: (name: string) => string | undefined): boolean {
  if (program === "fleet") return true;

  if (!/^\/[\w./+@-]+$/u.test(program) || program.slice(1).split("/").some((part) => part === "" || part === "." || part === "..")) return false;

  return fleetClis(env).has(resolvePath(program));
}

/** The marker a moved team's folder holds (fleet slice 3): the host service exports state.json and chat.jsonl from
 * the cloud into it, and its ledger is written by programs through fleet-run. */
export const MOVED_MARKER = "cloud.json";

/** Whether the team whose folder is `root` has moved to the cloud: the folder holds {@link MOVED_MARKER}. */
export function isMoved(root: string): boolean {
  return existsSync(join(root, MOVED_MARKER));
}

/** Why the old CLI may not write the ledger at `root`, when its folder holds {@link MOVED_MARKER} (decision 48):
 * the export would overwrite the write, and the cloud would never hear of it. */
export function movedRefusal(root: string): string | undefined {
  if (!isMoved(root)) return undefined;

  return `this team records through programs: fleet-run. ${join(root, MOVED_MARKER)} says this fleet has moved to the cloud: its host service writes state.json and chat.jsonl here, so the old CLI only reads them. Record with one program on the stdin of fleet-run (the coordinator skill's PROGRAMS.md)`;
}

/** `path` made absolute with its symlinks followed, as far as it exists. */
export function resolvePath(path: string): string {
  const absolute = resolve(path);

  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);

    return parent === absolute ? absolute : join(resolvePath(parent), basename(absolute));
  }
}

/** The bytes of `path`, or undefined when it cannot be read. */
export function readBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

/** The text of `path` (UTF-8, bad bytes replaced), or undefined when it cannot be read. */
export function readText(path: string): string | undefined {
  return readBytes(path)?.toString("utf8");
}

/** Write `text` to `path` (UTF-8). */
export function writeText(path: string, text: string): void {
  writeFileSync(path, text, "utf8");
}

/** Write `text` to `path` through a `.tmp` beside it and a rename, so no reader sees half of it. */
export function writeAtomic(path: string, text: string): void {
  const scratch = path.replace(/\.json$/, "") + ".tmp";
  writeFileSync(scratch, text, "utf8");
  renameSync(scratch, path);
}

/** Make `path` and its parents. */
export function makeDirs(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Make `path` a 0700 directory (its parents as `makeDirs` does): the hub's state dir, which holds its page and Stop
 * tokens. One already there is set to 0700 too; a symlink there is left as it is, never followed to chmod another. */
export function makePrivateDir(path: string): void {
  makeDirs(dirname(path));
  mkdirSync(path, { recursive: true, mode: 0o700 });

  if (lstatSync(path).isDirectory()) chmodSync(path, 0o700);
}

/** Remove `path` when it is there. */
export function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // missing_ok: already gone
  }
}

/** Whether `path` exists. */
export function exists(path: string): boolean {
  return existsSync(path);
}

/** The mtime of `path` in seconds since the epoch, or undefined when it cannot be read. */
export function mtimeOf(path: string): number | undefined {
  try {
    const ns = statSync(path, { bigint: true }).mtimeNs;

    // As CPython's st_mtime: seconds plus nanoseconds * 1e-9, in one double.
    return Number(ns / 1_000_000_000n) + Number(ns % 1_000_000_000n) * 1e-9;
  } catch {
    return undefined;
  }
}

/** Whether `path` is a directory. */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The names in directory `path`, sorted; none when it cannot be read. */
export function listDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

const STRERROR = new Map(Object.entries({
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory",
  ELOOP: "Too many levels of symbolic links",
  ENAMETOOLONG: "File name too long",
}));

/** Why an operation failed, in the words of C's `strerror` (as Python's `exc.strerror` reports it). */
export function strerror(cause: unknown): string {
  const code = cause instanceof Error && "code" in cause ? String(cause.code) : "";

  return STRERROR.get(code) ?? (cause instanceof Error ? cause.message : String(cause));
}

/** The bytes of `path`, or why it cannot be read, in the words of C's `strerror` (as Python reports it). */
export function readOrWhy(path: string): Buffer | { readonly why: string } {
  try {
    return readFileSync(path);
  } catch (cause: unknown) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : "";

    return { why: STRERROR.get(code) ?? (cause instanceof Error ? cause.message : String(cause)) };
  }
}

/** Write `bytes` to `path`. */
export function writeBytes(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes);
}
