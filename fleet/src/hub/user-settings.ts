/**
 * The rule card's writer (Luiz's decision always-scope a, #115): a reviewed entry appended to `autoMode.allow` of the
 * user's settings, `$HOME/.claude/settings.json` resolved with realpath (on Luiz's machines a link into his dotfiles
 * checkout: the target is written, and the link stays), JSON indented by two spaces with a trailing newline, every
 * other key and entry in its order, an identical entry skipped. The lock is the one-time writer's discipline: a lock
 * directory beside the file, taken over when stale. No sweep and no hook ever takes such an entry back.
 */
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { readText, strerror } from "../files.ts";
import { asArray, asObject } from "../json.ts";
import { folderFor, lockSettings, parsed, releaseLock, settingsText, Ungranted, withAutoModeRule, writeAtomic } from "./settings-file.ts";

/** The lock beside the user's real settings file: the name the one-time writer and the fleet repo's office host
 * take beside any settings file, so the two hosts of one machine never write it at once. */
const USER_LOCK = ".settings.local.json.lock";

/**
 * The file a rule card's entry goes into: `home`/.claude/settings.json resolved with realpath, or that path
 * itself when nothing is there yet; or why there is none (no HOME, or a link to a file that is not there).
 */
export function userSettingsFile(home: string | undefined): string | Ungranted {
  if (home === undefined || !isAbsolute(home)) return new Ungranted("the hub has no HOME, so it cannot tell where the user's settings are");
  const file = join(home, ".claude", "settings.json");

  try {
    return realpathSync(file);
  } catch (cause: unknown) {
    try {
      lstatSync(file);
    } catch {
      return file;
    }

    return new Ungranted(`${file} cannot be resolved: ${strerror(cause)}`);
  }
}

/** Whether `autoMode.allow` of the user's settings `file` holds `rule`, read now; false when it cannot be read. */
export function holdsAutoModeRule(file: string, rule: string): boolean {
  const settings = parsed(file);

  if (settings instanceof Ungranted) return false;

  return asArray(asObject(settings["autoMode"])?.["allow"])?.includes(rule) === true;
}

/**
 * Add `rule` to `autoMode.allow` of the user's settings `file` under its lock (`withAutoModeRule`), then run
 * `record`: when it returns why it failed, the file is put back as it was, unless another writer changed it since
 * (Claude Code and an editor take no lock), and that is returned. The write itself is aborted when the file changed
 * between its read and the rename (`writeAtomic`). Whether the entry was added (false: it was there already, and
 * `record` still ran), or why nothing was. `beforeRename` is a test's seam.
 */
export async function addAutoModeRule(file: string, rule: string, record: () => Ungranted | undefined, beforeRename?: () => void): Promise<boolean | Ungranted> {
  const folder = folderFor(file);

  if (folder !== undefined) return folder;
  const lock = await lockSettings(file, USER_LOCK);

  if (lock instanceof Ungranted) return lock;

  try {
    const before = readText(file);
    const settings = parsed(file, before);

    if (settings instanceof Ungranted) return settings;
    const held = withAutoModeRule(file, settings, rule);

    if (held instanceof Ungranted) return held;
    const written = settingsText(held.next);

    try {
      if (held.added) writeAtomic(file, written, { text: before }, beforeRename);
    } catch (cause: unknown) {
      return new Ungranted(`could not add the rule to ${file}: ${strerror(cause)}`);
    }

    const failed = record();

    if (failed === undefined || !held.added) return failed ?? held.added;

    if (readText(file) !== written) return new Ungranted(`${failed.reason}; ${file} changed after the rule went in (Claude Code or an editor wrote it), so nothing was put back: take the rule out of autoMode.allow by hand if it is there`);

    try {
      if (before === undefined) rmSync(file, { force: true });
      else writeAtomic(file, before, { text: written });
    } catch (cause: unknown) {
      return new Ungranted(`${failed.reason}; and ${file} could not be put back: ${strerror(cause)}`);
    }

    return failed;
  } finally {
    releaseLock(lock);
  }
}
