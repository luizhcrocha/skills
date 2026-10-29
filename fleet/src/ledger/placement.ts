/**
 * Where a permission row's root is recorded (ledger/commands.ts): at itself when it is a session root of the
 * fleet, at its session's root when it is a worker's workspace of the fleet's work. A subagent obeys only its
 * session root's `.claude/settings.local.json`, so a rule written in a worker's workspace never applies.
 */
import { basename, isAbsolute, join } from "node:path";

import { readText, resolvePath } from "../files.ts";
import { readBeats } from "../heartbeat.ts";
import { asArray, asObject, asString, type Json } from "../json.ts";
import { cwdOf } from "../procs.ts";
import { alive } from "../registry.ts";
import { jj } from "../ws/jj.ts";

/** The process the registry says the fleet lives as long as (`fleet serve DIR --pid`), and its working directory. */
export interface Registered {
  readonly pid: number;
  /** Read from the OS (`procs.ts` `cwdOf`), "" when it cannot be read. */
  readonly cwd: string;
}

/** The fleet's registered session, read from the OS: `pid` when that process lives, with its working directory
 * (`fleet serve` takes no pid of 1 or less, and pid 1 runs in `/`). */
export function registeredSession(pid: number | undefined): Registered | undefined {
  if (pid === undefined || pid <= 1 || !alive(pid)) return undefined;

  return { pid, cwd: cwdOf(pid) };
}

/** The fleet's registered session, looked up once. */
function once(lookup: () => Registered | undefined): () => Registered | undefined {
  let got: { readonly value: Registered | undefined } | undefined;

  return () => {
    got ??= { value: lookup() };

    return got.value;
  };
}

/**
 * Whether `at` (resolved) is a session root of the fleet in `dir`: the project or cwd of one of its heartbeats,
 * else the working directory of its registered session's live process. A worker's workspace is neither, so
 * a subagent's refused call is granted at its session's root, the one the hook records. Why not, when not.
 */
function whyNoSession(dir: string, at: string, lookup: () => Registered | undefined): string | undefined {
  const beats = new Set(readBeats(dir).flatMap((b) => [b.project, b.cwd].flatMap((p) => (p === null ? [] : [resolvePath(p)]))));

  if (beats.has(at)) return undefined;
  const registered = lookup();

  if (registered === undefined) return "no heartbeat names it, and no live session is registered for this fleet";

  if (registered.cwd !== "" && resolvePath(registered.cwd) === at) return undefined;

  return `no heartbeat names it, and the fleet's registered session ${String(registered.pid)} runs in ${registered.cwd === "" ? "a directory that cannot be read" : registered.cwd}`;
}

/** The fleet's session roots, resolved and sorted: each heartbeat's project (its cwd when it names none), and
 * the registered session's working directory. */
function sessionRoots(dir: string, lookup: () => Registered | undefined): string[] {
  const beats = readBeats(dir).flatMap((b) => {
    const p = b.project ?? b.cwd;

    return p === null ? [] : [resolvePath(p)];
  });

  const cwd = lookup()?.cwd ?? "";

  return [...new Set([...beats, ...(cwd === "" ? [] : [resolvePath(cwd)])])].sort();
}

/** The ledger's `workspaces[]` row whose path is `at`: its name and its repo (the default workspace's root). */
function listedWorkspace(dir: string, at: string): { readonly name: string; readonly repo: string | undefined } | undefined {
  let raw: Json;

  try {
    // SAFETY: JSON.parse returns JSON values only.
    raw = JSON.parse(readText(join(dir, "state.json")) ?? "null") as Json;
  } catch {
    return undefined;
  }

  for (const item of asArray(asObject(raw)?.["workspaces"]) ?? []) {
    const row = asObject(item);
    const path = asString(row?.["path"]);

    if (row === undefined || path === undefined || !isAbsolute(path) || row["status"] === "pruned" || resolvePath(path) !== at) continue;
    const repo = asString(row["repo"]);

    return { name: asString(row["id"]) ?? basename(at), repo: repo === undefined || !isAbsolute(repo) ? undefined : resolvePath(repo) };
  }

  return undefined;
}

/** The jj workspaces of the repo at `root`, by resolved root to name; empty when `root` is no jj workspace.
 * Read-only: `--ignore-working-copy` snapshots nothing. */
function jjWorkspaces(root: string): Map<string, string> {
  const run = jj(root, ["workspace", "list", "-T", 'name ++ "\\t" ++ self.root() ++ "\\n"'], true);

  if (!run.ok) return new Map();

  return new Map(
    run.stdout.split("\n").flatMap((line) => {
      const [name = "", path = ""] = line.split("\t");

      return name === "" || path === "" ? [] : [[resolvePath(path), name] as const];
    }),
  );
}

/** Where a permission's root is granted: at itself, a session root; at its session's root, a worker's workspace
 * of this fleet's work; nowhere, a workspace whose session root cannot be told or a folder outside the fleet. */
export type Placement =
  | { readonly kind: "session" }
  | { readonly kind: "workspace"; readonly root: string; readonly name: string }
  | { readonly kind: "untold"; readonly name: string; readonly roots: readonly string[] }
  | { readonly kind: "outside"; readonly why: string; readonly roots: readonly string[] };

/**
 * Where the root `at` (resolved) of a permission of the fleet in `dir` is granted. A subagent obeys only its
 * session root's `.claude/settings.local.json`, so a rule written in a worker's workspace never applies: a
 * workspace of this fleet's work (a `workspaces[]` row of its ledger by path, else a jj workspace of the same
 * repo as a session root) is granted at the session root whose repo holds it, or at the fleet's one session
 * root when the ledger lists it. The ledger is the agents', so this only ever moves a grant to a session root
 * the fleet's heartbeats or registered process already name.
 */
export function placeRoot(dir: string, at: string, lookup: () => Registered | undefined): Placement {
  const registered = once(lookup);
  const why = whyNoSession(dir, at, registered);

  if (why === undefined) return { kind: "session" };
  const roots = sessionRoots(dir, registered);
  const listed = listedWorkspace(dir, at);
  let owners = listed?.repo === undefined ? [] : roots.filter((r) => r === listed.repo);
  let name = listed?.name;

  if (owners.length !== 1) {
    const byJj = roots.flatMap((r) => {
      const n = jjWorkspaces(r).get(at);

      return n === undefined ? [] : [{ root: r, name: n }];
    });

    if (byJj.length > 0) {
      owners = byJj.map((o) => o.root);
      name ??= byJj[0]?.name;
    }
  }

  name ??= basename(at);

  if (listed === undefined && owners.length === 0) return { kind: "outside", why, roots };

  const [only] = owners.length === 1 ? owners : owners.length === 0 && roots.length === 1 ? roots : [];

  return only === undefined ? { kind: "untold", name, roots } : { kind: "workspace", root: only, name };
}
