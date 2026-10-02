/**
 * The combined preview's merge, kept by jj: the preview workspace's @ is a merge whose parents are the
 * included workers' working-copy commits, and the stack's head when no worker already has it, so the
 * preview shows every worker's edits as they are now, on top of what is integrated. A worker that is no
 * longer at work is in it only while its changes are not in the stack (`untilIntegrated`).
 *
 * One look (`look`) does this, and nothing more when nothing changed:
 *
 * 1. Each included worker's workspace is snapshotted from outside (`jj -R <its path> util snapshot`): jj
 *    takes that workspace's own working-copy lock, records its files, and writes nothing to them, so the
 *    worker editing there sees no change. When its edits changed its commit, jj rebases the preview's @
 *    (a descendant) onto the new commit in the same operation.
 * 2. One read of every workspace's @ (`working_copies()`, without a snapshot) gives each worker's commit,
 *    the stack and the preview's @ with its parents. The stack is the commit the fleet's revset names
 *    (`fleet preview DIR set --stack`, or `start --stack`), resolved again at every look so a bookmark or
 *    `<workspace>@` is followed as it moves, and refused unless it names exactly one commit; without one,
 *    the default workspace's @, or its parent when that @ is empty and undescribed. A worker merged until integrated is dropped when its workspace is gone
 *    or no commit of `::<its @> ~ ::(<stack> | trunk())` changes a file: its work is in the stack, or
 *    landed on the trunk, where a coordinator that integrates by moving a bookmark puts it (asked once
 *    per commit, stack and trunk). When the commits are the ones of the last look, it stops here.
 * 3. Otherwise the parents are `heads(<workers' commits> | <stack>)` and, when the preview's @ has others,
 *    it is rebased onto them in place (`rebase -r preview@ -d …`, its change kept).
 * 4. When the preview's @ is a commit its files on disk are not at yet, `workspace update-stale` writes
 *    the difference in place, so a dev server's hot reload picks it up. A file the preview's own directory
 *    had of its own (a dev server's output that no `.gitignore` names) is kept by jj in a divergent copy of
 *    the preview's change and dropped from the directory; that copy is abandoned, since nobody edits the
 *    preview.
 * 5. A conflicted merge is not an error: jj records it in the commit and writes its markers. The files are
 *    read from the commit, and each is tied to the included workers whose changes ahead of the stack touch it.
 *
 * The preview's workspace is never snapshotted by these commands (`--ignore-working-copy`), so conflict
 * markers on its disk never become content.
 */
import { PreviewError } from "../errors.ts";
import { isDir } from "../files.ts";
import { jj, literal, why } from "../ws/jj.ts";
import type { Conflict, Merged } from "./record.ts";

/** A workspace's working-copy commit as one read gives it. */
export interface Copy {
  readonly names: readonly string[];
  readonly commit: string;
  readonly change: string;
  readonly parents: readonly string[];
  readonly empty: boolean;
  readonly described: boolean;
  readonly conflict: boolean;
  readonly divergent: boolean;
}

const COPIES =
  'working_copies ++ "\\t" ++ commit_id ++ "\\t" ++ change_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ empty ++ "\\t" ++ ' +
  'if(description, "described", "") ++ "\\t" ++ conflict ++ "\\t" ++ divergent ++ "\\n"';

/** Every workspace's @ in the repo at `repo`, by workspace name; why not, when jj cannot say. */
export function readCopies(repo: string): Map<string, Copy> | PreviewError {
  const run = jj(repo, ["log", "--no-graph", "-r", "working_copies()", "-T", COPIES], true);

  if (!run.ok) return new PreviewError({ reason: why(run) });
  const copies = new Map<string, Copy>();

  for (const line of run.stdout.split("\n")) {
    if (line === "") continue;
    const [names = "", commit = "", change = "", parents = "", empty = "", described = "", conflict = "", divergent = ""] = line.split("\t");

    const copy: Copy = {
      names: names.split(" ").flatMap((n) => (n.endsWith("@") ? [n.slice(0, -1)] : [])),
      commit,
      change,
      parents: parents === "" ? [] : parents.split(","),
      empty: empty === "true",
      described: described === "described",
      conflict: conflict === "true",
      divergent: divergent === "true",
    };

    for (const name of copy.names) copies.set(name, copy);
  }

  return copies;
}

/** The stack's head: the default workspace's @, or its one parent when that @ is empty and undescribed. */
export function stackOf(main: Copy): string {
  return main.empty && !main.described && main.parents.length === 1 ? (main.parents[0] ?? main.commit) : main.commit;
}

/** The one commit `revset` names in the repo at `repo`, read without a snapshot; why not, when it names
 * none, several, or jj cannot resolve it. */
export function resolveStack(repo: string, revset: string): string | PreviewError {
  const found = commits(repo, revset);

  if (found instanceof PreviewError) return new PreviewError({ reason: `the stack's revset ${revset} is not one jj resolves: ${found.reason}` });

  if (found.length === 0) return new PreviewError({ reason: `the stack's revset ${revset} names no commit` });

  if (found.length > 1) return new PreviewError({ reason: `the stack's revset ${revset} names ${found.length} commits, not one` });

  return found[0] ?? "";
}

/** A worker the merge takes, with its workspace. */
export interface Pick {
  readonly id: string;
  readonly workspace: string;
  readonly path: string;
  /** Taken only while its workspace exists and its @ has changes neither the stack nor trunk() has: a
   * worker no longer at work, whose last edits are what the user waits to see until they are integrated. */
  readonly untilIntegrated?: boolean;
}

/** What one look found and did. */
export interface Look {
  readonly merged: readonly Merged[];
  readonly stack: string | null;
  /** The revset the stack was resolved from, or null for the default workspace's @ rule. */
  readonly stackFrom: string | null;
  readonly commit: string | null;
  readonly conflicts: readonly Conflict[];
  /** What went wrong, or null; a worker whose workspace could not be snapshotted is named and still merged as last recorded. */
  readonly error: string | null;
  /** Whether the look stopped before it had a merge: the last good one stands. */
  readonly failed: boolean;
}

/** What a look keeps for the next one, in memory. */
export interface Memory {
  /** The commits the last merge was built from. */
  key: string;
  /** The preview's @ its files on disk were last written to. */
  synced: string;
  /** Whether a worker's @ has changes not yet integrated, by `<its commit> <stack> <trunk>`. */
  ahead: Map<string, boolean>;
}

/** A fresh memory: the first look rebuilds and writes the files. */
export function freshMemory(): Memory {
  return { key: "", synced: "", ahead: new Map() };
}

/** The commits `revset` names, newest first; why not, when jj refuses it. */
function commits(repo: string, revset: string): string[] | PreviewError {
  const run = jj(repo, ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"'], true);

  return run.ok ? run.stdout.split("\n").filter((c) => c !== "") : new PreviewError({ reason: why(run) });
}

/** Whether `commit` has a change not yet integrated: a commit of `::commit ~ (::stack | ::landed)` that
 * changes a file, `landed` being trunk()'s commit (true when jj cannot say, so a worker is shown rather
 * than hidden). Remembered per commit, stack and trunk once jj says. */
function ahead(repo: string, commit: string, stack: string, landed: string, memory: Memory): boolean {
  const key = `${commit} ${stack} ${landed}`;
  const known = memory.ahead.get(key);

  if (known !== undefined) return known;
  const run = jj(repo, ["log", "--no-graph", "-n", "1", "-r", `(::${commit} ~ ::(${stack} | ${landed})) ~ empty()`, "-T", "commit_id"], true);

  if (!run.ok) return true;
  const found = run.stdout.trim() !== "";

  if (memory.ahead.size > 1000) memory.ahead.clear();
  memory.ahead.set(key, found);

  return found;
}

/** The repository paths the commits of `revset` change. */
function touched(repo: string, revset: string): Set<string> {
  const run = jj(repo, ["log", "--no-graph", "-r", revset, "-T", 'self.diff().files().map(|f| f.path() ++ "\\n").join("")'], true);

  return new Set(run.ok ? run.stdout.split("\n").filter((p) => p !== "") : []);
}

/** The files the commit leaves conflicted, each with the picked workers whose changes ahead of the stack touch it. */
function conflictsOf(repo: string, commit: string, stack: string, picked: readonly Merged[]): Conflict[] {
  const run = jj(repo, ["log", "--no-graph", "-r", commit, "-T", 'self.conflicted_files().map(|f| f.path() ++ "\\n").join("")'], true);

  if (!run.ok) return [];
  const files = run.stdout.split("\n").filter((p) => p !== "");

  if (files.length === 0) return [];
  const byWorker = picked.map((m) => ({ id: m.id, files: touched(repo, `::${m.commit} ~ ::${stack}`) }));

  return files.map((path) => ({ path, workers: byWorker.flatMap((w) => (w.files.has(path) ? [w.id] : [])) }));
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** One look: snapshot the picked workers, rebuild the merge on the stack (`stackRevset`'s one commit, or the
 * default workspace's @ rule when null) when a commit moved, write the files when the preview's @ moved,
 * and read the conflicts. `memory` is updated in place. */
export function look(repo: string, previewName: string, previewPath: string, picked: readonly Pick[], memory: Memory, stackRevset: string | null): Look {
  const errors: string[] = [];

  for (const p of picked) {
    if (!isDir(p.path)) continue;
    const snap = jj(p.path, ["util", "snapshot"]);

    if (!snap.ok) errors.push(`${p.id}'s workspace was not snapshotted: ${why(snap)}`);
  }

  const failed = (reason: string): Look => ({ merged: [], stack: null, stackFrom: stackRevset, commit: null, conflicts: [], error: [...errors, reason].join("; "), failed: true });
  let copies = readCopies(repo);

  if (copies instanceof PreviewError) return failed(`jj could not read the workspaces: ${copies.reason}`);
  const main = copies.get("default");
  let preview = copies.get(previewName);

  if (preview === undefined) return failed(`jj no longer knows the preview's workspace ${previewName}`);
  let stack: string;

  if (stackRevset === null) {
    if (main === undefined) return failed(`the repo at ${repo} has no default workspace`);
    stack = stackOf(main);
  } else {
    const resolved = resolveStack(repo, stackRevset);

    if (resolved instanceof PreviewError) return failed(resolved.reason);
    stack = resolved;
  }

  const trunk = picked.some((p) => p.untilIntegrated === true) ? commits(repo, "trunk()") : [];
  const landed = trunk instanceof PreviewError ? stack : (trunk[0] ?? stack);

  const merged: Merged[] = picked.flatMap((p) => {
    const at = copies instanceof PreviewError ? undefined : copies.get(p.workspace);

    if (p.untilIntegrated === true && (!isDir(p.path) || at === undefined || !ahead(repo, at.commit, stack, landed, memory))) return [];

    if (at === undefined) {
      errors.push(`jj no longer knows ${p.id}'s workspace ${p.workspace}`);

      return [];
    }

    return [{ id: p.id, workspace: p.workspace, commit: at.commit, change: at.change }];
  });

  const key = [...merged.map((m) => m.commit), stack].join(" ");

  if (key !== memory.key) {
    const parents = commits(repo, `heads(${[...merged.map((m) => m.commit), stack].join(" | ")})`);

    if (parents instanceof PreviewError) return failed(`jj could not find the merge's parents: ${parents.reason}`);

    if (!sameSet(parents, preview.parents)) {
      const moved = jj(previewPath, ["--ignore-working-copy", "rebase", "-r", `${literal(previewName)}@`, ...parents.flatMap((p) => ["-d", p])]);

      if (!moved.ok) return failed(`jj could not rebuild the merge: ${why(moved)}`);
      copies = readCopies(repo);

      if (copies instanceof PreviewError) return failed(`jj could not read the workspaces: ${copies.reason}`);
      preview = copies.get(previewName);

      if (preview === undefined) return failed(`jj no longer knows the preview's workspace ${previewName}`);
    }

    memory.key = key;
  }

  if (preview.commit !== memory.synced || preview.divergent) {
    const wrote = jj(previewPath, ["workspace", "update-stale"]);

    if (!wrote.ok) return failed(`jj could not write the preview's files: ${why(wrote)}`);
    const after = readCopies(repo);
    const now = after instanceof PreviewError ? undefined : after.get(previewName);

    if (now === undefined) return failed("jj could not read the preview's @ after writing its files");

    if (now.divergent) {
      const dropped = jj(repo, ["--ignore-working-copy", "abandon", `change_id(${now.change}) ~ ${literal(previewName)}@`]);

      if (!dropped.ok) errors.push(`jj kept a divergent copy of the preview's change: ${why(dropped)}`);
      else errors.push("the preview's directory had files of its own (a dev server's output no .gitignore names?); jj kept them aside and they were dropped");
    }

    preview = now;
    memory.synced = now.commit;
  }

  const conflicts = preview.conflict ? conflictsOf(repo, preview.commit, stack, merged) : [];

  return { merged, stack, stackFrom: stackRevset, commit: preview.commit, conflicts, error: errors.length === 0 ? null : errors.join("; "), failed: false };
}
