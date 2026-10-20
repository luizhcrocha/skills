/**
 * The workspace trash: where `fleet ws prune --apply` puts a workspace's folder instead of deleting it.
 *
 * A folder goes to `<trash>/<repo's basename>/<workspace>@<UTC stamp>` by one rename, beside a note
 * (`<entry>.json`: the repo, the workspace, its path, its last @ commit and that commit's parents, when,
 * which fleet, why). The trash is `$FLEET_TRASH`, else `$XDG_DATA_HOME/fleet/trash`, else
 * `~/.local/share/fleet/trash`. A rename never copies: a trash on another filesystem than the folder, or
 * a rename that fails, refuses, and the folder stays where it is; nothing here falls back to deleting.
 * {@link restore} moves an entry back and makes it a jj workspace again; {@link collect} (`fleet ws gc`)
 * is the only place an entry is deleted for good.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import * as Option from "effect/Option";

import { exists, isDir, readText, remove, writeText } from "../files.ts";
import { asArray, asObject, asString, dumps, parseObject, type JsonOut } from "../json.ts";
import { badWorkspaceName, jj, why, workspaceNames, type JjRun } from "./jj.ts";

/** What the trash keeps beside a folder, to say what it was and to put it back. */
export interface Note {
  /** The root of the repo's default workspace. */
  readonly repo: string;
  readonly workspace: string;
  /** Where the folder was. */
  readonly path: string;
  /** The workspace's @ when it went, or null when jj no longer knew it. */
  readonly commit: string | null;
  /** That commit's parents: a restored workspace starts on them, and its files on disk give back the rest. */
  readonly parents: readonly string[];
  readonly trashed: string;
  /** The fleet's directory. */
  readonly fleet: string;
  readonly why: string;
  /** The card whose yes moved it (`fleet ws DIR trash NAME --card ID`); absent for a prune. */
  readonly card?: string;
}

/** The trash's directory, from the environment. */
export function trashHome(env: (name: string) => string | undefined): string {
  const given = env("FLEET_TRASH");

  if (given !== undefined && given !== "") return given;
  const data = env("XDG_DATA_HOME");

  return join(data !== undefined && data !== "" ? data : join(env("HOME") ?? "", ".local", "share"), "fleet", "trash");
}

const STAMPED = /@(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z(?:-\d+)?$/;

function utcStamp(at: Date): string {
  return at.toISOString().replace(/\.\d+Z$/, "Z").replaceAll("-", "").replaceAll(":", "");
}

/** When the entry went to the trash, from the stamp in its name. */
function trashedAt(entry: string): Date | undefined {
  const m = STAMPED.exec(entry);

  return m === null ? undefined : new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

function failure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Why the trash did not do what was asked: nothing was moved, or the reason says where things are. */
export interface Refused {
  readonly refused: string;
}

/** An entry of the trash: `<repo's basename>/<workspace>@<stamp>`. */
export interface Trashed {
  readonly id: string;
  readonly folder: string;
}

/**
 * Move the folder at `note.path` into the trash, its note written first. The entry, or why it stays:
 * the trash is on another filesystem, or the note or the rename failed (then nothing was moved and no note
 * is left).
 */
export function toTrash(home: string, note: Note, now: Date): Trashed | Refused {
  const shelf = join(home, basename(note.repo));
  const refused = (reason: string): Refused => ({ refused: `could not move ${note.path} to the trash (${reason}); nothing is deleted` });

  try {
    mkdirSync(shelf, { recursive: true });

    if (statSync(shelf).dev !== statSync(note.path).dev) return refused(`${home} is on another filesystem, and the trash only renames`);
  } catch (cause) {
    return refused(failure(cause));
  }

  const stamp = utcStamp(now);
  let name = `${note.workspace}@${stamp}`;

  for (let n = 2; exists(join(shelf, name)) || exists(join(shelf, `${name}.json`)); n += 1) name = `${note.workspace}@${stamp}-${String(n)}`;
  const folder = join(shelf, name);

  try {
    const json: JsonOut = { repo: note.repo, workspace: note.workspace, path: note.path, commit: note.commit, parents: [...note.parents], trashed: note.trashed, fleet: note.fleet, why: note.why, card: note.card };
    writeText(`${folder}.json`, `${dumps(json, { indent: 2, ensureAscii: false })}\n`);
  } catch (cause) {
    return refused(failure(cause));
  }

  try {
    renameSync(note.path, folder);
  } catch (cause) {
    remove(`${folder}.json`);

    return refused(failure(cause));
  }

  return { id: `${basename(note.repo)}/${name}`, folder };
}

/** Put a folder {@link toTrash} just moved back where it was (its workspace could not be forgotten); why not. */
function untrash(trashed: Trashed, path: string): string | undefined {
  try {
    renameSync(trashed.folder, path);
    remove(`${trashed.folder}.json`);

    return undefined;
  } catch (cause) {
    return failure(cause);
  }
}

/**
 * Take a workspace out: its folder (when there is one) to the trash by {@link toTrash}, then, when jj still knows
 * it (`forget`), `jj workspace forget` run from the repo's default workspace with `--ignore-working-copy`, so the
 * main checkout is never snapshotted. When jj refuses the forget, the folder goes back where it was. The entry
 * (undefined when there was no folder), or why it stays.
 */
export function discard(home: string, note: Note, now: Date, forget: boolean): { readonly trashed: Trashed | undefined } | Refused {
  let trashed: Trashed | undefined;

  if (isDir(note.path)) {
    const moved = toTrash(home, note, now);

    if ("refused" in moved) return moved;
    trashed = moved;
  }

  if (forget) {
    const forgot = jj(note.repo, ["workspace", "forget", note.workspace], true);

    if (!forgot.ok) {
      const back = trashed === undefined ? undefined : untrash(trashed, note.path);

      return { refused: `${why(forgot)}${back === undefined ? "" : `; its folder stays in the trash, ${trashed?.id ?? ""} (${back})`}` };
    }
  }

  return { trashed };
}

/**
 * The workspace name jj wrote into `<folder>/.jj/working_copy/checkout`: a protobuf `Checkout` whose field 3 is
 * `workspace_name` (1 and 2 are the commit and operation ids). Undefined when the file is missing, is not that
 * message, or holds no name.
 */
export function checkoutName(folder: string): string | undefined {
  let bytes: Uint8Array;

  try {
    bytes = readFileSync(join(folder, ".jj", "working_copy", "checkout"));
  } catch {
    return undefined;
  }

  let at = 0;
  let name: string | undefined;

  const varint = (): number | undefined => {
    for (let value = 0, shift = 0; at < bytes.length && shift < 35; shift += 7) {
      const byte = bytes[at] ?? 0;
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;

      if ((byte & 0x80) === 0) return value;
    }

    return undefined;
  };

  while (at < bytes.length) {
    const key = varint();

    if (key === undefined) return undefined;
    const wire = key % 8;

    if (wire === 0) {
      if (varint() === undefined) return undefined;
    } else if (wire === 2) {
      const length = varint();

      if (length === undefined || at + length > bytes.length) return undefined;

      if (Math.floor(key / 8) === 3) {
        try {
          name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at, at + length));
        } catch {
          return undefined;
        }
      }

      at += length;
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4;
    } else {
      return undefined;
    }
  }

  return at === bytes.length && name !== "" ? name : undefined;
}

/**
 * `fleet ws trash --adopt ENTRY --repo REPO [--name NAME]`: give an entry moved into the trash by hand (no note,
 * no stamp) the note and stamp a prune writes, so {@link restore} can bring it back and {@link collect} ages it
 * from now. The workspace is the name jj recorded in the folder ({@link checkoutName}), unless
 * {@link badWorkspaceName} refuses it (`../x1`: then it is read as no name), else `given`, else the adopt is
 * refused: the entry's own name is whatever the hand chose (`c18-manual`), never read as the workspace's. `given`
 * passes {@link badWorkspaceName} too. Its old path is `<REPO>-<name>` beside REPO (where `fleet ws add`
 * makes one), its @ unknown: a restore starts it on the default workspace's parents and its files give back the rest.
 */
export function adopt(home: string, id: string, repo: string, given: string | undefined, now: Date, stamp: string): Trashed | Refused {
  const folder = join(home, id);
  const [shelf, name] = id.split("/");

  if (id.includes("..") || shelf === undefined || name === undefined || id.split("/").length !== 2 || name.endsWith(".json") || name.endsWith(STALE) || !isDir(folder)) {
    return { refused: `no trash entry ${id} in ${home}: \`fleet ws trash\` lists them` };
  }

  if (exists(`${folder}.json`)) return { refused: `trash entry ${id} has a note already` };

  if (!isDir(join(repo, ".jj", "repo"))) return { refused: `${repo} is no jj repo's default workspace: --repo names the repo the workspace was of` };

  if (basename(repo) !== shelf) return { refused: `trash entry ${id} is on shelf ${shelf}, and --repo ${repo} would shelve it under ${basename(repo)}` };
  const read = checkoutName(folder);
  const recorded = read === undefined || badWorkspaceName(read) !== undefined ? undefined : read;

  if (recorded !== undefined && given !== undefined && recorded !== given) {
    return { refused: `trash entry ${id} is jj workspace ${recorded} by its .jj/working_copy/checkout, not ${given}: leave --name out` };
  }

  const workspace = recorded ?? given;

  if (workspace === undefined) return { refused: `trash entry ${id} has no .jj/working_copy/checkout that names its workspace: give it with --name NAME` };
  const bad = badWorkspaceName(workspace);

  if (bad !== undefined) return { refused: bad };
  let entry = `${workspace}@${utcStamp(now)}`;

  for (let n = 2; exists(join(home, shelf, entry)) || exists(join(home, shelf, `${entry}.json`)); n += 1) entry = `${workspace}@${utcStamp(now)}-${String(n)}`;
  const target = join(home, shelf, entry);
  const json: JsonOut = { repo, workspace, path: `${repo}-${workspace}`, commit: null, parents: [], trashed: stamp, fleet: "", why: "fleet ws trash --adopt: moved to the trash by hand, with no note" };

  try {
    writeText(`${target}.json`, `${dumps(json, { indent: 2, ensureAscii: false })}\n`);
    renameSync(folder, target);
  } catch (cause) {
    remove(`${target}.json`);

    return { refused: `could not adopt ${id} (${failure(cause)}); it stays as it was` };
  }

  return { id: `${shelf}/${entry}`, folder: target };
}

function readNote(folder: string): Note | undefined {
  const raw = asObject(Option.getOrUndefined(parseObject(readText(`${folder}.json`) ?? "")));
  const repo = asString(raw?.["repo"]);
  const workspace = asString(raw?.["workspace"]);
  const path = asString(raw?.["path"]);

  if (raw === undefined || repo === undefined || workspace === undefined || path === undefined) return undefined;
  const given = asString(raw["card"]);
  const card = given === undefined ? {} : { card: given };

  return {
    repo,
    workspace,
    path,
    commit: asString(raw["commit"]) ?? null,
    parents: asArray(raw["parents"])?.flatMap((p) => asString(p) ?? []) ?? [],
    trashed: asString(raw["trashed"]) ?? "",
    fleet: asString(raw["fleet"]) ?? "",
    why: asString(raw["why"]) ?? "",
    ...card,
  };
}

/** The bytes under `path`, symlinks counted as themselves. */
function sizeOf(path: string): number {
  const st = lstatSync(path, { throwIfNoEntry: false });

  if (st === undefined) return 0;

  if (!st.isDirectory()) return st.size;
  let total = 0;

  for (const name of readdirSync(path)) total += sizeOf(join(path, name));

  return total;
}

/** An entry as `fleet ws trash` lists it. */
export interface Listed extends Trashed {
  readonly at: Date | undefined;
  readonly note: Note | undefined;
}

/** The suffix of a stale `.jj` a restore that stopped half way leaves beside the entry: not an entry. */
const STALE = ".stale-jj";

/** The notes of the trash with no folder beside them (a prune that stopped between the note and the rename). */
function lostNotes(home: string): string[] {
  return (isDir(home) ? readdirSync(home).sort() : []).flatMap((shelf) => {
    const at = join(home, shelf);

    return isDir(at) ? readdirSync(at).sort().flatMap((name) => (name.endsWith(".json") && !exists(join(at, name.slice(0, -".json".length))) ? [join(at, name)] : [])) : [];
  });
}

/** Every entry of the trash, oldest first. */
export function entries(home: string): Listed[] {
  const found: Listed[] = [];

  for (const shelf of isDir(home) ? readdirSync(home).sort() : []) {
    const at = join(home, shelf);

    if (!isDir(at)) continue;

    for (const name of readdirSync(at).sort()) {
      const folder = join(at, name);

      if (name.endsWith(".json") || name.endsWith(STALE) || !isDir(folder)) continue;
      found.push({ id: `${shelf}/${name}`, folder, at: trashedAt(name), note: readNote(folder) });
    }
  }

  return found.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
}

/** An age as `8d 1h`, `5h 3m` or `12m`. */
export function age(from: Date | undefined, now: Date): string {
  if (from === undefined) return "?";
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60];

  if (d > 0) return `${String(d)}d ${String(h)}h`;

  return h > 0 ? `${String(h)}h ${String(m)}m` : `${String(m)}m`;
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.ceil(bytes / 1024))} KB`;

  return bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** `fleet ws trash`: each entry, its age, its size and its note. */
export function listing(home: string, now: Date): string[] {
  const all = entries(home);

  if (all.length === 0) return [`the trash at ${home} is empty`];

  return [
    `the trash at ${home}: ${String(all.length)} ${all.length === 1 ? "entry" : "entries"}; \`fleet ws restore ENTRY\` brings one back, \`fleet ws gc\` deletes those older than 7 days`,
    ...all.flatMap((e) => {
      const n = e.note;
      const head = `${e.id}  ${age(e.at, now)}  ${size(sizeOf(e.folder))}  `;

      if (n === undefined) return [`${head}no note`];

      return [`${head}${n.workspace} of ${n.repo}, fleet ${n.fleet}: ${n.why}`, `    was ${n.path}, its @ ${n.commit === null ? "unknown" : n.commit.slice(0, 12)}`];
    }),
  ];
}

/** The first of `base`, `base-restored`, `base-restored-2`, … that `taken` does not hold. */
function free(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) return base;
  let candidate = `${base}-restored`;

  for (let n = 2; taken(candidate); n += 1) candidate = `${base}-restored-${String(n)}`;

  return candidate;
}

/** Whether jj no longer has the noted parent: `present()` finds nothing. A revset jj refuses is not gone: the add says why. */
function isGone(repo: string, parent: string): boolean {
  const run = jj(repo, ["log", "--no-graph", "-r", `present(${parent})`, "-T", 'commit_id ++ "\\n"'], true);

  return run.ok && run.stdout.trim() === "";
}

/** jj's `Error:` line (a failed `workspace add` prints `Created workspace in ...` first), else its first line. */
function jjError(run: JjRun): string {
  return run.stderr.split("\n").find((l) => l.startsWith("Error:"))?.trim() ?? why(run);
}

/** Whether the `.jj` at `dotJj` holds a repo's store (its `repo` a directory), not a workspace's pointer to one. */
function holdsStore(dotJj: string): boolean {
  return lstatSync(join(dotJj, "repo"), { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Undo a `jj workspace add` that failed half way: jj registers the workspace and writes `path/.jj` before it checks the revisions. */
function unadd(repo: string, name: string, path: string): void {
  jj(repo, ["workspace", "forget", name]);
  const made = join(path, ".jj");

  if (isDir(made) && !holdsStore(made)) rmSync(made, { recursive: true, force: true });

  if (isDir(path) && readdirSync(path).length === 0) rmdirSync(path);
}

/** What {@link restore} did: the lines to print, and whether jj has the workspace again. */
export interface Restored {
  readonly lines: readonly string[];
  readonly ok: boolean;
}

/**
 * Move the entry's folder back to its old path (or beside it, when that is taken) and make it jj's
 * workspace again. jj adds a workspace only in an empty directory, so the workspace is added there on the
 * noted @'s parents with no files (`--sparse-patterns empty`), its fresh `.jj` swapped into the folder in
 * place of the stale one, the folder renamed in, and `jj sparse reset` run: a file already on disk is
 * never overwritten (jj skips it as a conflicting change), and the next snapshot takes what the folder
 * holds beyond the parents into the new @. A noted parent jj no longer has is dropped. When jj cannot add
 * it, the workspace it registered is forgotten and the folder still comes back, as plain files, and the
 * lines say so. An old `.jj` that holds a repo's store is never deleted.
 */
export function restore(home: string, id: string): Restored | Refused {
  const folder = join(home, id);

  if (id.includes("..") || id.split("/").length !== 2 || !isDir(folder)) return { refused: `no trash entry ${id} in ${home}: \`fleet ws trash\` lists them` };
  const note = readNote(folder);

  if (note === undefined) return { refused: `trash entry ${id} has no readable note (${folder}.json): move ${folder} back by hand` };
  const path = free(note.path, exists);
  const where = path === note.path ? path : `${path} (${note.path} is taken)`;
  const names = workspaceNames(note.repo);
  const name = names === undefined ? note.workspace : free(note.workspace, (n) => names.includes(n));
  const gone = names === undefined ? [] : note.parents.filter((p) => isGone(note.repo, p));
  const parents = note.parents.filter((p) => !gone.includes(p));
  const added = names === undefined ? undefined : jj(note.repo, ["workspace", "add", path, "--name", name, ...parents.flatMap((p) => ["-r", p]), "--sparse-patterns", "empty"]);

  if (added === undefined || !added.ok) {
    const reason = added === undefined ? `no jj repo at ${note.repo}` : jjError(added);

    if (added !== undefined) unadd(note.repo, name, path);

    try {
      renameSync(folder, path);
    } catch (cause) {
      return { refused: `jj could not add workspace ${name} (${reason}), and ${folder} could not be moved back (${failure(cause)}); it stays in the trash` };
    }

    remove(`${folder}.json`);

    return { ok: false, lines: [`restored ${id} to ${where}, as plain files: jj could not add it as workspace ${name} (${reason}); its .jj is stale, so jj there fails until the folder is a workspace again`] };
  }

  const stale = `${folder}${STALE}`;

  try {
    if (exists(join(folder, ".jj"))) renameSync(join(folder, ".jj"), stale);
    renameSync(join(path, ".jj"), join(folder, ".jj"));
    rmdirSync(path);
    renameSync(folder, path);
  } catch (cause) {
    return { refused: `restoring ${id} stopped half way (${failure(cause)}): jj workspace ${name} is at ${path}, the folder at ${folder}, its old .jj at ${stale}` };
  }

  const store = holdsStore(stale);

  if (!store) rmSync(stale, { recursive: true, force: true });
  remove(`${folder}.json`);
  const reset = jj(path, ["sparse", "reset"]);
  const renamed = name === note.workspace ? "" : ` (${note.workspace} is taken)`;
  const on = parents.map((p) => p.slice(0, 12)).join(", ");
  const lost = gone.map((p) => p.slice(0, 12)).join(", ");
  const missing = gone.length === 0 ? "" : ` (its noted ${gone.length === 1 ? `parent ${lost} is` : `parents ${lost} are`} gone)`;
  const lines = [`restored ${id} to ${where}: jj workspace ${name}${renamed} again, on ${on === "" ? "the default workspace's parents" : on}${missing}`];

  const warnings = [
    ...(reset.ok ? [] : [`ws: \`jj sparse reset\` failed there (${why(reset)}): run it in ${path} to bring back the files jj tracks`]),
    ...(store ? [`ws: kept ${stale}: its repo is a directory, a repo's own store, so restore does not delete it`] : []),
  ];

  return { ok: warnings.length === 0, lines: [...lines, ...warnings] };
}

/** What {@link collect} did, as lines. */
export function collect(home: string, now: Date, days: number, dry: boolean): string[] {
  const lines: string[] = [];
  const unstamped: string[] = [];
  let kept = 0;

  for (const e of entries(home)) {
    if (e.at === undefined) {
      unstamped.push(e.id);
      continue;
    }

    if (now.getTime() - e.at.getTime() <= days * 86_400_000) {
      kept += 1;
      continue;
    }

    if (!dry) {
      rmSync(e.folder, { recursive: true, force: true });
      remove(`${e.folder}.json`);
    }

    lines.push(`${dry ? "would delete" : "deleted"} ${e.id} (${age(e.at, now)} old)`);
  }

  const keptLine = kept === 0 ? "" : `${String(kept)} ${kept === 1 ? "entry" : "entries"} younger than ${String(days)} ${days === 1 ? "day" : "days"} kept`;
  const lost = lostNotes(home);

  if (dry) lines.push(`dry run, nothing deleted${keptLine === "" ? "" : `; ${keptLine}`}`);
  else if (keptLine !== "") lines.push(keptLine);

  if (unstamped.length > 0) lines.push(`${String(unstamped.length)} ${unstamped.length === 1 ? "entry with no stamp in its name" : "entries with no stamp in their names"} kept: ${unstamped.join(", ")}`);

  for (const note of lost) lines.push(`a note with no folder, kept: ${note}`);

  if (lines.length === 0) lines.push(`the trash at ${home} is empty`);

  return lines;
}
