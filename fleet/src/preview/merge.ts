/**
 * The combined preview's merge, kept by jj: the preview workspace's @ is a merge whose parents are the
 * included workers' working-copy commits, and the stack's head when no worker already has it, so the
 * preview shows every worker's edits as they are now, on top of what is integrated. A worker that is no
 * longer at work is in it only while its changes are not in the stack (`untilIntegrated`).
 *
 * The merge the dev server is given is never conflicted: a worker whose workspace would conflict it is
 * left out (`LeftOut`), with the files and the workers it meets, and tried again when a commit moves.
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
 * 3. Otherwise the preview's @ is rebased in place (`rebase -r preview@ -d …`, its change kept) onto
 *    `heads(<each worker's workspace>@ | <the stack's revset>)`: names, which jj resolves in the operation
 *    that rebases. The look never names a commit id it read earlier as a destination: a worker's own jj
 *    command may have rewritten that commit since, and a rebase onto a hidden commit makes it visible
 *    again, a second copy of the worker's change that no workspace is at. The rebase writes no file, so it
 *    is also the trial: a merge jj marks conflicted is not kept (`fit`). The workers the last look left out
 *    are tried one at a time on top of the others; when the others conflict among themselves, every worker
 *    is, in `tryOrder`, so the worker that brought the conflict is the one left out. A worker whose own @
 *    is conflicted is left out untried. A stack that is itself conflicted fails the look: nothing merges
 *    clean on it.
 * 4. When the preview's @ is a commit its files on disk are not at yet, `workspace update-stale` writes
 *    the difference in place, so a dev server's hot reload picks it up. A file the preview's own directory
 *    had of its own (a dev server's output that no `.gitignore` names) is kept by jj in a divergent copy of
 *    the preview's change and dropped from the directory; that copy is abandoned, since nobody edits the
 *    preview. So is the copy jj keeps when a worker's own jj command and the look's rebase ran at once.
 * 5. Only a merge read clean reaches step 4. One gap is left: a worker's own jj command that snapshots a
 *    conflicting edit rebases the preview's @ under the look, between that read and the write. A merge
 *    found conflicted, before the write or after it, is fitted again at once, in the same look, at most
 *    `REFITS` times: the worker that moved is then out of the merge, and its commands no longer move the
 *    preview's @. After that, a merge still conflicted before its write leaves the files of the last clean
 *    merge in place; one whose markers were written is replaced by the stack alone, for one look, since
 *    no jj command writes an older merge's files without making hidden commits visible. Each file a
 *    conflicted write touched is read at the end: a look that leaves jj's markers in one says so.
 *
 * The preview's workspace is never snapshotted by these commands (`--ignore-working-copy`), so conflict
 * markers on its disk never become content.
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { PreviewError } from "../errors.ts";
import { isDir, readText } from "../files.ts";
import { asString, parseJson } from "../json.ts";
import { jj, literal, why } from "../ws/jj.ts";
import type { Conflict, LeftOut, Merged } from "./record.ts";

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

/** The default rule as a revset, the commit `stackOf` reads: jj resolves it in the operation that uses it. */
export const DEFAULT_STACK_REVSET = 'coalesce("default"@ ~ (empty() & description(exact:"") & ~merges()), "default"@-)';

/** The stack by name, for a jj command that changes history: `revset`, or the default rule when null. A
 * commit id read earlier is no name: its commit may be hidden by now. */
export function stackName(revset: string | null): string {
  return `(${revset ?? DEFAULT_STACK_REVSET})`;
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
  /** The workers left out, since taking them in would conflict the merge. */
  readonly left: readonly LeftOut[];
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
  /** The workers the merge of `key` leaves out. */
  left: readonly LeftOut[];
  /** The trials that conflicted, by `<the worker's commit> <the commits it was tried on> <stack>`: one whose
   * commits are all where they were is not rebased again to learn the same. */
  clashes: Map<string, readonly Conflict[]>;
}

/** A fresh memory: the first look rebuilds and writes the files. */
export function freshMemory(): Memory {
  return { key: "", synced: "", ahead: new Map(), left: [], clashes: new Map() };
}

/** What the last recorded look held: whom it merged, at which commit, and whom it left out. */
export interface Before {
  readonly merged: readonly { readonly id: string; readonly commit: string }[];
  readonly left: readonly { readonly id: string }[];
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

/** A jj template that prints each of `files` (a template expression: a list of files) as its repository
 * path in a JSON string, one a line: a path may hold a newline. */
function pathsTemplate(files: string): string {
  return `${files}.map(|f| stringify(f.path()).escape_json() ++ "\\n").join("")`;
}

/** The paths `pathsTemplate` printed. */
function pathsOf(stdout: string): string[] {
  return stdout.split("\n").flatMap((line) => asString(Option.getOrUndefined(parseJson(line))) ?? []);
}

/** The repository paths the commits of `revset` change. */
function touched(repo: string, revset: string): Set<string> {
  const run = jj(repo, ["log", "--no-graph", "-r", revset, "-T", pathsTemplate("self.diff().files()")], true);

  return new Set(run.ok ? pathsOf(run.stdout) : []);
}

/** The files the commit leaves conflicted, by repository path. */
function conflicted(repo: string, commit: string): string[] {
  const run = jj(repo, ["log", "--no-graph", "-r", commit, "-T", pathsTemplate("self.conflicted_files()")], true);

  return run.ok ? pathsOf(run.stdout) : [];
}

/** The files the commit leaves conflicted, each with the workers of `among` whose changes ahead of the
 * stack touch it (`paths` remembers what each worker's commit touches, for one look). */
function conflictsOf(repo: string, commit: string, stack: string, among: readonly Merged[], paths: Map<string, Set<string>> = new Map()): Conflict[] {
  const files = conflicted(repo, commit);

  if (files.length === 0) return [];

  const byWorker = among.map((m) => {
    const files$ = paths.get(m.commit) ?? touched(repo, `::${m.commit} ~ ::${stack}`);
    paths.set(m.commit, files$);

    return { id: m.id, files: files$ };
  });

  return files.map((path) => ({ path, workers: byWorker.flatMap((w) => (w.files.has(path) ? [w.id] : [])) }));
}

/** The preview's merge as jj holds it, between the steps of one look. */
interface Held {
  readonly repo: string;
  readonly previewName: string;
  readonly previewPath: string;
  /** The stack's commit as the look read it: for reads, never a rebase's destination. */
  readonly stack: string;
  /** The stack by name (`stackName`). */
  readonly stackNamed: string;
  /** Every workspace's @ and the preview's, as last read. */
  copies: ReadonlyMap<string, Copy>;
  preview: Copy;
  /** What the look has to say of the copies of the preview's change it met. */
  readonly notes: string[];
}

/** Read the workspaces again into `held`; the preview's @. A second copy of the preview's change is
 * abandoned at once, by the change's name: nobody edits the preview, so the copy is jj's (`aside` says
 * what it holds, when that is worth a line; the copy a rebase made at the same time as a worker's own
 * jj command is the look's own trial, and goes unsaid). */
function reread(held: Held, aside?: string): Copy | PreviewError {
  for (const again of [true, false]) {
    const copies = readCopies(held.repo);

    if (copies instanceof PreviewError) return new PreviewError({ reason: `jj could not read the workspaces: ${copies.reason}` });
    const preview = copies.get(held.previewName);

    if (preview === undefined) return new PreviewError({ reason: `jj no longer knows the preview's workspace ${held.previewName}` });
    held.copies = copies;
    held.preview = preview;

    if (!preview.divergent || !again) break;
    const dropped = jj(held.repo, ["--ignore-working-copy", "abandon", `change_id(${preview.change}) ~ ${literal(held.previewName)}@`]);

    if (!dropped.ok) held.notes.push(`jj kept a divergent copy of the preview's change: ${why(dropped)}`);
    else if (aside !== undefined) held.notes.push(aside);

    if (!dropped.ok) break;
  }

  return held.preview;
}

/** Put the preview's @ on the heads of the taken workers' @ and the stack, each by its name, and read it
 * again: whether jj marks that merge conflicted is `conflict`. jj resolves the names in the operation
 * that rebases, so no hidden commit is a destination; a merge already in place makes no operation. No
 * file is written. */
function place(held: Held, taken: readonly Merged[]): Copy | PreviewError {
  const parents = `heads(${[...taken.map((m) => `present(${literal(m.workspace)}@)`), held.stackNamed].join(" | ")})`;
  const moved = jj(held.previewPath, ["--ignore-working-copy", "rebase", "-r", `${literal(held.previewName)}@`, "-d", parents]);

  return moved.ok ? reread(held) : new PreviewError({ reason: `jj could not rebuild the merge: ${why(moved)}` });
}

/** Whether each of `workers` is at the commit the look read it at, as last read: what a trial then found
 * is true of those commits. */
function steady(held: Held, workers: readonly Merged[]): boolean {
  return workers.every((m) => held.copies.get(m.workspace)?.commit === m.commit);
}

/** Of the workers the last merge held at another commit than now, those whose commit then already changed
 * a file the merge `clashing` leaves conflicted: the file was theirs before the conflict came. None unless
 * two workers moved, since only then is there a tie to break. */
function holders(held: Held, clashing: Copy, pool: readonly Merged[], before: Before): ReadonlySet<string> {
  const was = (m: Merged): string | undefined => before.merged.find((b) => b.id === m.id && b.commit !== m.commit && b.commit !== "")?.commit;
  const moved = pool.filter((m) => was(m) !== undefined);

  if (moved.length < 2) return new Set();
  const files = conflicted(held.repo, clashing.commit);

  return new Set(
    moved.flatMap((m) => {
      const had = touched(held.repo, `::${was(m) ?? ""} ~ ::${held.stack}`);

      return files.some((f) => had.has(f)) ? [m.id] : [];
    }),
  );
}

/** The order the workers are tried in when the merge conflicts: those the last merge held at the commit
 * they are at now; those it held at another commit, the `holders` of a conflicted file before the others;
 * the new ones; then those it left out. Each group keeps the ledger's order. So of two workers that meet,
 * the one that moved last is the one left out, and of two that both moved, the one new to the file. */
function tryOrder(wanted: readonly Merged[], before: Before, holding: ReadonlySet<string>): Merged[] {
  const rank = (m: Merged): number => {
    if (before.left.some((l) => l.id === m.id)) return 4;
    const held = before.merged.find((b) => b.id === m.id);

    if (held === undefined) return 3;

    if (held.commit === m.commit) return 0;

    return holding.has(m.id) ? 1 : 2;
  };

  return [0, 1, 2, 3, 4].flatMap((r) => wanted.filter((m) => rank(m) === r));
}

/**
 * The largest merge of `wanted` on the stack that jj does not mark conflicted, left as the preview's @, and
 * the workers left out of it. A worker whose own @ is conflicted is left out untried. The others are placed
 * at once (without those the last look left out, which are then tried one at a time on top); when that
 * merge conflicts, every worker is tried one at a time in `tryOrder`. Why not, when jj fails or the stack is
 * itself conflicted.
 */
function fit(held: Held, wanted: readonly Merged[], before: Before, memory: Memory): readonly LeftOut[] | PreviewError {
  const paths = new Map<string, Set<string>>();
  const left = new Map<string, LeftOut>();

  const leave = (m: Merged, own: boolean, conflicts: readonly Conflict[]): void => {
    left.set(m.id, { id: m.id, workspace: m.workspace, commit: m.commit, own, conflicts });
  };

  for (const m of wanted) if (held.copies.get(m.workspace)?.conflict === true) leave(m, true, conflictsOf(held.repo, m.commit, held.stack, [], paths));
  const pool = wanted.filter((m) => !left.has(m.id));
  const suspects = pool.filter((m) => before.left.some((l) => l.id === m.id));
  const trusted = pool.filter((m) => !suspects.includes(m));
  const first = place(held, trusted);

  if (first instanceof PreviewError) return first;
  let taken: Merged[] = [...trusted];
  let rest: Merged[] = suspects;

  if (first.conflict) {
    const own = conflicted(held.repo, held.stack);

    if (own.length > 0) return new PreviewError({ reason: `the stack (${held.stack.slice(0, 12)}) is itself conflicted in ${listed(own.map(quoted))}: nothing merges clean on it, so the last good merge stands` });
    taken = [];
    rest = tryOrder(pool, before, holders(held, first, pool, before));
  }

  for (const m of rest) {
    const trial = [m.commit, ...taken.map((t) => t.commit), held.stack].join(" ");
    const known = memory.clashes.get(trial);

    if (known !== undefined) {
      leave(m, false, known);
      continue;
    }

    const tried = place(held, [...taken, m]);

    if (tried instanceof PreviewError) return tried;

    if (!tried.conflict) {
      taken.push(m);
      continue;
    }

    const clash = conflictsOf(held.repo, tried.commit, held.stack, taken, paths);

    if (memory.clashes.size > 200) memory.clashes.clear();

    if (steady(held, [...taken, m])) memory.clashes.set(trial, clash);
    leave(m, false, clash);
  }

  const last = place(held, taken);

  if (last instanceof PreviewError) return last;

  return wanted.flatMap((m) => left.get(m.id) ?? []);
}

/** A path as a line of text may hold it: a JSON string of at most 120 characters, so a newline or a quote
 * in a file's name stays inside the quotes. */
export function quoted(path: string): string {
  const whole = JSON.stringify(path);

  if (whole.length <= 120) return whole;
  let cut = path.slice(0, 118);

  while (JSON.stringify(cut).length > 119) cut = cut.slice(0, -1);

  return `${JSON.stringify(cut).slice(0, -1)}…"`;
}

/** At most five of `items`, and how many more. */
export function listed(items: readonly string[]): string {
  return items.length <= 5 ? items.join(", ") : `${items.slice(0, 5).join(", ")} and ${items.length - 5} more`;
}

/** How many times one look fits the merge again after finding it conflicted. */
export const REFITS = 2;

/** The lines jj writes around a conflict in a file. */
const MARKER = /^(?:<{7,}|>{7,}) conflict \d+ of \d+/im;

/** A merge found conflicted although `fit` left it clean: a worker's own jj command moved it since. */
interface Clash {
  readonly held: Held;
  /** The files it is conflicted in. */
  readonly paths: readonly string[];
  /** Whether its files were written, jj's markers in them. */
  readonly wrote: boolean;
}

/** Write the preview's files to its @ (`workspace update-stale`) and read it again: what was written. */
function write(held: Held, memory: Memory): Copy | PreviewError {
  const wrote = jj(held.previewPath, ["workspace", "update-stale"]);

  if (!wrote.ok) return new PreviewError({ reason: `jj could not write the preview's files: ${why(wrote)}` });
  const now = reread(held, "the preview's directory had files of its own (a dev server's output no .gitignore names?); jj kept them aside and they were dropped");

  if (now instanceof PreviewError) return new PreviewError({ reason: `jj could not read the preview's @ after writing its files: ${now.reason}` });
  memory.synced = now.commit;

  return now;
}

/** One look: snapshot the picked workers, rebuild the merge on the stack (`stackRevset`'s one commit, or the
 * default workspace's @ rule when null) when a commit moved, leaving out each worker that would conflict it
 * (`before`: what the last recorded look held, which says whom to try last), and write the files when the
 * preview's @ moved. A merge a worker's own jj command conflicted under the look is fitted again at once
 * (`REFITS`), so no look ends with jj's conflict markers in the files it wrote. `memory` is updated in place. */
export function look(
  repo: string,
  previewName: string,
  previewPath: string,
  picked: readonly Pick[],
  memory: Memory,
  stackRevset: string | null,
  before: Before = { merged: [], left: [] },
): Look {
  const notes: string[] = [];

  for (const p of picked) {
    if (!isDir(p.path)) continue;
    const snap = jj(p.path, ["util", "snapshot"]);

    if (!snap.ok) notes.push(`${p.id}'s workspace was not snapshotted: ${why(snap)}`);
  }

  const failed = (reason: string): Look => ({ merged: [], left: [], stack: null, stackFrom: stackRevset, commit: null, conflicts: [], error: reason, failed: true });

  const once = (): Look | Clash => {
    const copies = readCopies(repo);

    if (copies instanceof PreviewError) return failed(`jj could not read the workspaces: ${copies.reason}`);
    const main = copies.get("default");
    const at = copies.get(previewName);

    if (at === undefined) return failed(`jj no longer knows the preview's workspace ${previewName}`);
    let stack: string;

    if (stackRevset === null) {
      if (main === undefined) return failed(`the repo at ${repo} has no default workspace`);
      stack = stackOf(main);
    } else {
      const resolved = resolveStack(repo, stackRevset);

      if (resolved instanceof PreviewError) return failed(resolved.reason);
      stack = resolved;
    }

    const held: Held = { repo, previewName, previewPath, stack, stackNamed: stackName(stackRevset), copies, preview: at, notes };

    if (at.divergent) {
      const tidied = reread(held);

      if (tidied instanceof PreviewError) return failed(tidied.reason);
    }

    const trunk = picked.some((p) => p.untilIntegrated === true) ? commits(repo, "trunk()") : [];
    const landed = trunk instanceof PreviewError ? stack : (trunk[0] ?? stack);

    const wanted: Merged[] = picked.flatMap((p) => {
      const its = held.copies.get(p.workspace);

      if (p.untilIntegrated === true && (!isDir(p.path) || its === undefined || !ahead(repo, its.commit, stack, landed, memory))) return [];

      if (its === undefined) {
        notes.push(`jj no longer knows ${p.id}'s workspace ${p.workspace}`);

        return [];
      }

      return [{ id: p.id, workspace: p.workspace, commit: its.commit, change: its.change }];
    });

    const key = [...wanted.map((m) => m.commit), stack].join(" ");

    if (key !== memory.key) {
      const left = fit(held, wanted, before, memory);

      if (left instanceof PreviewError) return failed(left.reason);
      memory.key = key;
      memory.left = left;
    }

    if (held.preview.conflict) return { held, paths: conflicted(repo, held.preview.commit), wrote: false };

    if (held.preview.commit !== memory.synced) {
      const now = write(held, memory);

      if (now instanceof PreviewError) return failed(now.reason);

      if (now.conflict) return { held, paths: conflicted(repo, now.commit), wrote: true };
    }

    const merged = wanted.filter((m) => !memory.left.some((l) => l.id === m.id));

    return { merged, left: memory.left, stack, stackFrom: stackRevset, commit: held.preview.commit, conflicts: [], error: null, failed: false };
  };

  /** The files a write of this look left jj's markers in. */
  const marked = new Set<string>();

  const noted = (clash: Clash): void => {
    memory.key = "";

    if (clash.wrote) for (const p of clash.paths) marked.add(p);
  };

  /** The last resort once markers were written and every refit met another conflict: the stack alone,
   * which no worker's own jj command moves. */
  const alone = (held: Held): Look => {
    const placed = place(held, []);
    const now = placed instanceof PreviewError ? placed : write(held, memory);

    if (now instanceof PreviewError) return failed(now.reason);
    memory.left = [];
    notes.push(`the merge was conflicted the ${REFITS + 1} times its files were written (workers' own jj commands moved it): the preview serves the stack alone until the next look`);

    return { merged: [], left: [], stack: held.stack, stackFrom: stackRevset, commit: now.commit, conflicts: now.conflict ? conflictsOf(repo, now.commit, held.stack, []) : [], error: null, failed: false };
  };

  let round = once();

  for (let refits = 0; "held" in round && refits < REFITS; refits += 1) {
    noted(round);
    round = once();
  }

  if ("held" in round) {
    noted(round);
    round =
      marked.size > 0
        ? alone(round.held)
        : failed(`the merge was conflicted in ${listed(round.paths.map(quoted))} the ${REFITS + 1} times it was fitted (workers' own jj commands moved it), and no file was written: the last good merge stands until the next look`);
  }

  const still = [...marked].filter((p) => MARKER.test(readText(join(previewPath, p)) ?? ""));

  if (still.length > 0) {
    memory.key = "";
    memory.synced = "";
    notes.push(`the preview's files hold jj's conflict markers in ${listed(still.map(quoted))}: the next look writes them again`);
  }

  const said = [...new Set([...notes, ...(round.error === null ? [] : [round.error])])];

  return { ...round, error: said.length === 0 ? null : said.join("; ") };
}
