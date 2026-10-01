/**
 * The file system as the fleet uses it: whole files read as text (absent when they cannot be read),
 * written whole, and paths resolved as Python's `Path.resolve()` does (symlinks followed, the missing
 * tail kept). Every failure the fleet tolerates is a value here, never a throw.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The coordinator skill's directory: the templates (assets/) and the Python scripts the printed
 * commands name, during the migration (open-12). */
export const SKILL_DIR = resolvePath(fileURLToPath(new URL("../../skills/productivity/coordinator", import.meta.url)));

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
