/**
 * The read-modify-write of a Claude Code settings file (user-settings.ts, for a rule card's entry in the user's
 * `autoMode.allow`): read it as a JSON object, add the entry with every other key and entry kept in order, under a
 * lock directory beside it (Bun has no flock; the plugin's hook takes the same one), written whole by a rename.
 */
import { closeSync, constants, fchmodSync, mkdirSync, openSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { readText, strerror } from "../files.ts";
import { asArray, asObject, type Json, type JsonObject } from "../json.ts";

/** Why a grant cannot be written. */
export class Ungranted {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }
}

/** The settings in `file` as a JSON object; none when the file is not there; or why it cannot be read as one. `text`
 * is the file's text when the caller read it already (undefined: no file). */
export function parsed(file: string, text: string | undefined = readText(file)): JsonObject | Ungranted {
  if (text === undefined) return {};
  let value: Json;

  try {
    // SAFETY: JSON.parse returns JSON values only.
    value = JSON.parse(text) as Json;
  } catch (cause: unknown) {
    return new Ungranted(`${file} does not parse: ${strerror(cause)}`);
  }

  return asObject(value) ?? new Ungranted(`${file} is not a JSON object`);
}

/** The entry of `autoMode.allow` that keeps Claude Code's own allow rules: a list made here starts with it. */
const DEFAULTS = "$defaults";

/** `settings` with `rule` appended to `autoMode.allow`, every other key and entry kept (`"$defaults"` stays where it
 * is, first in Luiz's settings), and whether it was added (false: an identical entry is there); or why it cannot
 * hold it. A settings with no `autoMode.allow` gets `["$defaults", rule]`, so the defaults stay on. */
export function withAutoModeRule(file: string, settings: JsonObject, rule: string): { readonly next: JsonObject; readonly added: boolean } | Ungranted {
  const autoMode = settings["autoMode"] === undefined ? {} : asObject(settings["autoMode"]);

  if (autoMode === undefined) return new Ungranted(`${file}: autoMode is not an object`);
  const allow = autoMode["allow"] === undefined ? [DEFAULTS] : asArray(autoMode["allow"]);

  if (allow === undefined) return new Ungranted(`${file}: autoMode.allow is not a list`);

  if (allow.includes(rule)) return { next: settings, added: false };

  return { next: { ...settings, autoMode: { ...autoMode, allow: [...allow, rule] } }, added: true };
}

/** How long a writer waits for the settings lock, and the age past which a lock is a crashed holder's. */
const LOCK_WAIT_MS = 2000;

const LOCK_STALE_MS = 10_000;

function hasCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

/**
 * Take the lock around a settings file's read-modify-write: the directory `name` beside it, made atomically. One
 * older than LOCK_STALE_MS is taken over. The lock's path, or why it could not be had.
 */
export async function lockSettings(file: string, name: string): Promise<string | Ungranted> {
  const lock = join(dirname(file), name);
  const deadline = performance.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      mkdirSync(lock);

      return lock;
    } catch (cause: unknown) {
      if (!hasCode(cause, "EEXIST")) return new Ungranted(`could not lock ${file}: ${strerror(cause)}`);
    }

    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmdirSync(lock);
        continue;
      }
    } catch (cause: unknown) {
      if (hasCode(cause, "ENOENT")) continue;

      return new Ungranted(`could not lock ${file}: ${strerror(cause)}`);
    }

    if (performance.now() >= deadline) return new Ungranted(`${lock} is held: another grant or the plugin hook is writing ${file}; answer again`);
    await sleep(20);
  }
}

/** Let go of a lock `lockSettings` gave: one another writer already took over as stale and removed is let go of too. */
export function releaseLock(lock: string): void {
  try {
    rmdirSync(lock);
  } catch (cause: unknown) {
    if (!hasCode(cause, "ENOENT")) throw cause;
  }
}

/**
 * Write `text` to `file` whole: a scratch file beside it, with the file's mode when it has one, renamed over it. The
 * scratch file is made fresh, whatever was at its name removed first and the new one opened `O_EXCL` and
 * `O_NOFOLLOW`, so nothing planted there (a symlink, a FIFO) is written through or hangs the write. With
 * `read` (the text the caller read the file as, undefined when there was none), the file is read again just before
 * the rename, and one another writer changed since (Claude Code and an editor take no lock) is left as it is: the
 * write throws and nothing is written. The scratch file never stays. `beforeRename` is a test's seam.
 */
export function writeAtomic(file: string, text: string, read?: { readonly text: string | undefined }, beforeRename?: () => void): void {
  const scratch = join(dirname(file), `.${String(process.pid)}.${basename(file)}.tmp`);

  try {
    rmSync(scratch, { force: true });
    const fd = openSync(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);

    try {
      writeFileSync(fd, text, "utf8");

      try {
        fchmodSync(fd, statSync(file).mode & 0o7777);
      } catch {
        // A new file keeps the mode it was made with.
      }
    } finally {
      closeSync(fd);
    }

    beforeRename?.();

    if (read !== undefined && readText(file) !== read.text) throw new Error(`${file} changed since it was read (Claude Code or an editor wrote it): answer again`);
    renameSync(scratch, file);
  } finally {
    rmSync(scratch, { force: true });
  }
}

/** `settings` as a settings file holds it: JSON indented by two spaces, with a trailing newline. */
export function settingsText(settings: JsonObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Make the folder `file` goes into; why not, when it cannot be made. */
export function folderFor(file: string): Ungranted | undefined {
  try {
    mkdirSync(dirname(file), { recursive: true });

    return undefined;
  } catch (cause: unknown) {
    return new Ungranted(`could not make ${dirname(file)}: ${strerror(cause)}`);
  }
}
