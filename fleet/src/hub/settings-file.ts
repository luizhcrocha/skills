/**
 * The read-modify-write of a Claude Code settings file that both writers share (grants.ts for a one-time grant in
 * a session root's `.claude/`, user-settings.ts for a rule card's entry in the user's `autoMode.allow`): read it as a JSON
 * object, add the exact rules it lacks to `permissions.allow` with every other key and entry kept in order, under a
 * lock directory beside it (Bun has no flock; the plugin's hook takes the same one), written whole by a rename.
 */
import { chmodSync, mkdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** `settings` with the `rules` it lacks added to `permissions.allow`, every other key and entry kept, and those
 * rules (`added`; none when all are there already); or why it cannot hold them. */
export function withRules(file: string, settings: JsonObject, rules: readonly string[]): { readonly next: JsonObject; readonly added: readonly string[] } | Ungranted {
  const permissions = settings["permissions"] === undefined ? {} : asObject(settings["permissions"]);

  if (permissions === undefined) return new Ungranted(`${file}: permissions is not an object`);
  const allow = permissions["allow"] === undefined ? [] : asArray(permissions["allow"]);

  if (allow === undefined) return new Ungranted(`${file}: permissions.allow is not a list`);
  const added = rules.filter((rule) => !allow.includes(rule));

  return { next: { ...settings, permissions: { ...permissions, allow: [...allow, ...added] } }, added };
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

/** `lockSettings` for a caller that cannot wait asynchronously (the import of a root's grant records, grant-records.ts):
 * the same lock, waited for the same 2 s by sleeping. Its path, or none when it could not be had. */
export function lockSettingsSync(file: string, name: string): string | undefined {
  const lock = join(dirname(file), name);
  const deadline = performance.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      mkdirSync(lock);

      return lock;
    } catch (cause: unknown) {
      if (!hasCode(cause, "EEXIST")) return undefined;
    }

    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmdirSync(lock);
        continue;
      }
    } catch (cause: unknown) {
      if (hasCode(cause, "ENOENT")) continue;

      return undefined;
    }

    if (performance.now() >= deadline) return undefined;
    Bun.sleepSync(20);
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
 * Write `text` to `file` whole: a scratch file beside it, with the file's mode when it has one, renamed over it. With
 * `read` (the text the caller read the file as, undefined when there was none), the file is read again just before
 * the rename, and one another writer changed since (Claude Code and an editor take no lock) is left as it is: the
 * write throws and nothing is written. The scratch file never stays. `beforeRename` is a test's seam.
 */
export function writeAtomic(file: string, text: string, read?: { readonly text: string | undefined }, beforeRename?: () => void): void {
  const scratch = join(dirname(file), `.${String(process.pid)}.${basename(file)}.tmp`);

  try {
    writeFileSync(scratch, text, "utf8");

    try {
      chmodSync(scratch, statSync(file).mode & 0o7777);
    } catch {
      // A new file keeps the mode it was made with.
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
