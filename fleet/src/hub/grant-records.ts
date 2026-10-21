/**
 * Where a session root's grant records live: the one place this is written down. The hub (this module), the plugin's
 * hook (hooks/tstack-hook.py `_records_dir`) and the office host (fleet-live apps/host/src/grants.ts) compute it the
 * same way, and fleet/test/grant-records.cases.json holds the cases all three must read the same.
 *
 * The records are the record of issued grants, `tstack-grants-issued.json`, and the record of take-backs,
 * `tstack-grants-ended.json` (grants.ts says what they hold). A root's are in
 *
 *     <home>/.claude/tstack-grants/<hash>/
 *
 * `<home>` is the user's home ($HOME), `<root>` the root's real path (the folder that holds the `.claude/` a grant
 * file is in, which a grant file's own checks make its realpath), with no trailing slash, and `<hash>` the SHA-256 of
 * that path's UTF-8 bytes, as 64 lowercase hex digits. With no home there are no records: reads find none, and a grant
 * is refused. No variable but $HOME moves them: a test gives the process a temporary $HOME.
 *
 * Why not in the root: they were in `<root>/.claude/hooks/`, and in a root that jj tracks them in (custom-mcp-servers,
 * coelhorocha/skills) a `jj workspace update-stale` put an older tree's copy back over them on 2026-10-21, and the hook
 * took back a grant the user had allowed ("this call's grant is on no record of the hub's grants"); a `jj new` onto a
 * commit without them deletes both. Why `~/.claude` and not `$XDG_STATE_HOME`: a grant record must sit where no agent
 * can write, since an agent that could edit one could rewrite a grant's `runs` and run an edited script, or move its
 * `at` past the 30 minutes. Claude Code's permission check guards every `.claude` folder, `~/.claude` included (its
 * writes are prompted or sent to the classifier, and allow rules do not pre-approve them:
 * code.claude.com/docs/en/permission-modes, "Protected paths"), and the sandbox denies writes to most of `~/.claude`
 * (code.claude.com/docs/en/sandboxing, "Protected paths"). `~/.local/state` is under neither.
 *
 * The lock stays where it was: every write of a record, and the import, is made under the settings lock beside the
 * root's grant files, `<root>/.claude/.settings.local.json.lock`, which the hub, the hook and the host all take.
 *
 * The import, once per root: the first reader or writer to find no records folder for a root makes it, with a copy,
 * byte for byte, of each record the root's tree holds at `<root>/.claude/hooks/<name>` that is a regular file (no
 * symlink, folder or FIFO), and none when `.claude` or its `hooks` is a symlink; of the record of take-backs, only
 * the take-backs of a grant on the tree's record of issued grants whose rule is in none of the root's grant files
 * (`endedToImport`). It holds the settings lock beside the root's grant files (below), which every writer of a
 * record takes, and looks again for the folder under it, so no writer sees the folder half made and a sweep or writer
 * that comes during an import waits for it; a caller that holds the lock already imports without taking it again.
 * Under the lock it copies the records into a fresh folder beside the target, makes the target with `mkdir` (one there
 * already, `EEXIST`, is another importer's: it stops), and links each copy in, keeping a record a writer put there
 * first. Never a rename of the whole folder: rename(2) replaces an empty folder, so a late importer could swap its
 * copy in over a writer's. With the lock not had in 2 s, or a root with no `.claude`, there is no record for now. From
 * then on the tree's copies are never read or written, but for the transition below: not one a later checkout puts
 * there, whose take-backs and grants are older than the folder's. The hook (`_record_at`) and the office host import
 * the same way. The hook warns when jj or git still tracks a tree's copy, and says how to stop tracking it.
 *
 * The transition, temporary (dropped at step grant-dual-drop, once every fleet reports a restart): a session that
 * started before this release runs the old hook, which reads only the tree's copies. This release writes none of them
 * at all: the hub, the hook and the host write a root's records in its folder alone, never in its tree, since the tree
 * is a folder any agent can write to, and Node has no rename relative to an open folder, so a `.claude/hooks` swapped
 * for a symlink between a check and the rename could replace the folder's record of issued grants or write into
 * another root's tree. So an old-hook session finds no grant issued since the release and refuses it as "on no record
 * of the hub's grants" until it restarts: fewer calls, and the release asks for every session to restart. The tree's
 * copies are only read: by the import, and by the union of take-backs. The hook lets no grant run that either record
 * of take-backs ends, the folder's or the tree's, which an old-hook session writes, so a grant one of those used
 * cannot run again in a new one. But a take-back on the tree's copy alone makes a rule standing in its file the
 * owner's, which no sweep takes, only while its rule is in none of the root's grant files, read under the lock: the
 * old hook takes the rule out before it puts the take-back on record, and the tree's copy is any checkout's or
 * agent's to write, so one whose rule is still there would make a one-time grant's rule lasting. So an owner's
 * identical rule put back after an old-hook take-back is taken at the grant's 30 minutes: fewer calls. An old-hook
 * session misses a take-back the new ones write, and takes an owner's identical rule put back after it at the grant's
 * 30 minutes: fewer calls again. The union only ever ends a grant: a checkout that rolls the tree's copy back takes no
 * take-back out of the folder's.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { asArray, asObject, asString, type Json, type JsonObject } from "../json.ts";
import { lockSettingsSync, parsed, releaseLock, Ungranted } from "./settings-file.ts";

/** The folder under `<home>/.claude` that holds a folder of records for each root. */
const RECORDS = "tstack-grants";

/** The records folder of the root whose real path is `root`, for the user whose home is `home`. */
export function recordsDir(home: string, root: string): string {
  return join(home, ".claude", RECORDS, createHash("sha256").update(root, "utf8").digest("hex"));
}

/** The tree's copy of record `name` of grant file `file`'s root, `<root>/.claude/hooks/<name>`: where the records sat
 * before, and where the import and the transition above read them. Only the old hook writes it. */
export function treeRecordOf(file: string, name: string): string {
  return join(dirname(file), "hooks", name);
}

/** Temporary, until step grant-dual-drop: the text of the tree's copy of record `name` of grant file `file`'s root
 * (`treeRecordOf`), as the host's `readTreeRecord` reads it: none unless `hooks` is a folder and the record a regular
 * file, neither a symlink (`regularBytes`). */
export function readTreeRecord(file: string, name: string): string | undefined {
  const tree = treeRecordOf(file, name);

  return isDir(dirname(tree)) ? regularBytes(tree)?.toString("utf8") : undefined;
}

/** The names of a root's records. */
export const ISSUED_RECORD = "tstack-grants-issued.json";

export const ENDED_RECORD = "tstack-grants-ended.json";

/** How `recordOf` imports. */
export interface ImportSeam {
  /** The caller holds the settings lock of the grant file already, so the import does not take it. */
  readonly locked?: boolean;
  /** A test's seam: runs once the importer made the folder, before the records move in. */
  readonly beforeMove?: () => void;
}

/** The record `name` of the root of grant file `file` (`<root>/.claude/<grant file>`), with the tree's records
 * imported first, under the settings lock, when the root has no records folder yet; none with no home, or when the
 * folder is not there and the root has no `.claude` or the lock cannot be had. */
export function recordOf(home: string | undefined, file: string, name: string, seam: ImportSeam = {}): string | undefined {
  if (home === undefined || home === "") return undefined;
  const claude = dirname(file);
  const dir = recordsDir(home, dirname(claude));

  if (exists(dir)) return join(dir, name);

  if (seam.locked === true) {
    importRoot(join(claude, "hooks"), dir, seam);

    return join(dir, name);
  }

  if (!isDir(claude)) return undefined;
  const lock = lockSettingsSync(file, SETTINGS_LOCK);

  if (lock === undefined) return undefined;

  try {
    if (!exists(dir)) importRoot(join(claude, "hooks"), dir, seam);
  } finally {
    releaseLock(lock);
  }

  return join(dir, name);
}

/** The lock the hub, the plugin's hook and the office host take around a write of a session root's grant files, its
 * grant records, and the import of those. */
export const SETTINGS_LOCK = ".settings.local.json.lock";

/** The files a grant is written to, in a root's `.claude/`. */
export const GRANT_FILES: readonly string[] = ["settings.local.json", "tstack-grants.json"];

/** Whether the grant file `file` may hold `rule`: in its allow list, or not readable as a JSON object. */
export function holdsRule(file: string, rule: string): boolean {
  const settings = parsed(file);

  if (settings instanceof Ungranted) return true;

  return asArray(asObject(settings["permissions"])?.["allow"])?.includes(rule) === true;
}

/** What names a grant on the records: its file, decision, rule, `at` and revision ("" for a file or revision it names
 * none of), as the hook's `_ended_key` does; none for an entry that lacks one of the decision, rule and `at`. */
function grantKey(file: Json | undefined, decision: Json | undefined, rule: Json | undefined, at: Json | undefined, rev: Json | undefined): string | undefined {
  const named = [asString(decision), asString(rule), asString(at)];

  return named.every((part) => part !== undefined) ? [asString(file) ?? "", ...named, asString(rev) ?? ""].join("\n") : undefined;
}

/** The `grantKey`s a take-back of a grant on the tree's record of issued grants, whose text is `text`, may carry: with
 * its file and revision, or without either, as master's and the old host's take-backs name neither. None when it is
 * not there or does not parse. */
function issuedKeys(text: string | undefined): ReadonlySet<string> {
  const record = parsed(ISSUED_RECORD, text);

  if (record instanceof Ungranted) return new Set();

  return new Set((asArray(record["issued"]) ?? []).flatMap((entry) => {
    const e = asObject(entry);
    const file = asString(e?.["file"]);

    if (e === undefined || file === undefined) return [];

    return [file, ""].flatMap((f) => [asString(e["rev"]) ?? "", ""].flatMap((rev) => grantKey(f, e["decision"], e["rule"], e["at"], rev) ?? []));
  }));
}

/** The tree's record of take-backs, whose text is `text`, as the import copies it, every other key kept: only the
 * take-backs of a grant on the tree's record of issued grants, whose text is `issued` (by `grantKey`, never one marked
 * `line`), whose rule is in none of the root's grant files in `claude`, read under the settings lock the import
 * holds. The tree's copy is any checkout's or agent's to write, and a take-back is written once its rule is out, so
 * one whose rule is still there is forged: imported, it made a one-time grant's rule the owner's, for good; and one of
 * no grant issued yet named a future grant, and ended it at birth with its rule the owner's. None when it does not
 * parse. */
function endedToImport(text: string, issued: string | undefined, claude: string): JsonObject | undefined {
  const record = parsed(ENDED_RECORD, text);

  if (record instanceof Ungranted) return undefined;
  const ended = asArray(record["ended"]);

  if (ended === undefined) return record;
  const keys = issuedKeys(issued);

  return {
    ...record,
    ended: ended.filter((entry) => {
      const e = asObject(entry);
      const rule = asString(e?.["rule"]);
      const key = e === undefined || e["line"] === true ? undefined : grantKey(e["file"], e["decision"], rule, e["granted"], e["rev"]);

      return rule !== undefined && key !== undefined && keys.has(key) && !GRANT_FILES.some((name) => holdsRule(join(claude, name), rule));
    }),
  };
}

/** The bytes of the regular file at `path`; none when it is not there, cannot be read or is anything else: opened
 * `O_NOFOLLOW`, and `O_NONBLOCK` so a FIFO swapped in after a check does not hang the open, then checked on the open
 * file (the hook's `_regular_bytes`). */
function regularBytes(path: string): Buffer | undefined {
  let fd: number;

  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }

  try {
    return fstatSync(fd).isFile() ? readFileSync(fd) : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);

    return true;
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function hasCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

/** Make `dir` with a copy of each record in the tree's `hooks` folder that is a regular file, of the record of
 * take-backs only what `endedToImport` keeps, unless another importer made it first; a record already in it is kept. */
function importRoot(hooks: string, dir: string, seam: ImportSeam): void {
  let fresh: string | undefined;

  try {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    fresh = mkdtempSync(`${dir}.import-`);
    const copied: string[] = [];

    const linked = isLink(dirname(hooks)) || isLink(hooks);
    const tree = new Map(linked ? [] : [ISSUED_RECORD, ENDED_RECORD].map((name) => [name, regularBytes(join(hooks, name))] as const));

    for (const [name, bytes] of tree) {
      if (bytes === undefined) continue;

      if (name === ENDED_RECORD) {
        const record = endedToImport(bytes.toString("utf8"), tree.get(ISSUED_RECORD)?.toString("utf8"), dirname(hooks));

        if (record === undefined) continue;
        writeFileSync(join(fresh, name), `${JSON.stringify(record, null, 2)}\n`);
      } else writeFileSync(join(fresh, name), bytes);
      copied.push(name);
    }

    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (cause: unknown) {
      if (hasCode(cause, "EEXIST")) return;
      throw cause;
    }

    seam.beforeMove?.();

    for (const name of copied) {
      try {
        linkSync(join(fresh, name), join(dir, name));
      } catch (cause: unknown) {
        if (!hasCode(cause, "EEXIST")) throw cause;
      }
    }
  } catch {
    // The folder or a copy cannot be made: a write of a record says why.
  } finally {
    if (fresh !== undefined) rmSync(fresh, { recursive: true, force: true });
  }
}
