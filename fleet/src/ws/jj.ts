/**
 * The jj the workspaces need, as one process per question: always `-R` a named workspace, never the
 * caller's cwd. A question that only reads passes `--ignore-working-copy`, so asking about a worker's
 * workspace while it works never snapshots its files under it.
 */
import { spawnSync } from "node:child_process";

/** What one jj run gave back. */
export interface JjRun {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `jj ARGS` against the workspace at `at`; `read` adds `--ignore-working-copy`. */
export function jj(at: string, args: readonly string[], read = false): JjRun {
  const flags = ["-R", at, "--color=never", "--no-pager", ...(read ? ["--ignore-working-copy"] : [])];
  const done = spawnSync("jj", [...flags, ...args], { encoding: "utf8", timeout: 60_000 });

  if (done.error !== undefined) return { ok: false, stdout: "", stderr: done.error.message };

  return { ok: done.status === 0, stdout: done.stdout, stderr: done.stderr };
}

/** The first line jj printed on stderr, for a refusal. */
export function why(run: JjRun): string {
  const line = run.stderr.split("\n").find((l) => l.trim() !== "");

  return line === undefined ? "jj failed" : line.trim();
}

/** One commit as the workspaces read it. */
export interface Change {
  readonly change: string;
  readonly short: string;
  readonly commit: string;
  readonly empty: boolean;
  readonly conflict: boolean;
  readonly divergent: boolean;
  readonly description: string;
}

const TEMPLATE =
  'change_id ++ "\\t" ++ change_id.shortest(8) ++ "\\t" ++ commit_id ++ "\\t" ++ empty ++ "\\t" ++ conflict ++ "\\t" ++ divergent ++ "\\t" ++ description.first_line() ++ "\\n"';

/** The commits `revset` names, newest first; undefined when jj refuses the revset. */
export function changes(at: string, revset: string, read = true): Change[] | undefined {
  const run = jj(at, ["log", "--no-graph", "-r", revset, "-T", TEMPLATE], read);

  if (!run.ok) return undefined;

  return run.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [change = "", short = "", commit = "", empty = "", conflict = "", divergent = "", ...description] = line.split("\t");

      return { change, short, commit, empty: empty === "true", conflict: conflict === "true", divergent: divergent === "true", description: description.join("\t") };
    });
}

/** The root of the workspace jj calls `name` in the repo at `at`, or undefined. */
export function workspaceRoot(at: string, name: string): string | undefined {
  const run = jj(at, ["workspace", "root", "--name", name], true);

  return run.ok ? run.stdout.trim() : undefined;
}

/** The names of the repo's workspaces. */
export function workspaceNames(at: string): string[] | undefined {
  const run = jj(at, ["workspace", "list", "-T", 'name ++ "\\n"'], true);

  return run.ok ? run.stdout.split("\n").filter((n) => n !== "") : undefined;
}

/** A revset string literal. */
export function literal(text: string): string {
  return JSON.stringify(text);
}

/** What a workspace holds that the stack does not: every commit reachable from the workspace's @, or
 * from another commit of the same change (the copy `workspace update-stale` keeps of a stale
 * workspace's unsnapshotted files), that is neither under the default workspace's @ nor immutable,
 * leaving out the empty commits with no description. */
export function unintegratedRevset(name: string, change: string): string {
  return `(::(${literal(name)}@ | change_id(${change})) ~ ::default@ ~ immutable()) ~ (empty() & description(exact:""))`;
}
