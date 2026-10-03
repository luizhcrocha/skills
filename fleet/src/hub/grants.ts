/**
 * Permission grants (SPEC.md "Permission grants"): when the user answers a permission with allow-once, the
 * hub, not an agent (Claude Code's classifier refuses an agent that writes its own allow rule), adds the
 * row's exact rule to the session's `.claude/settings.local.json` (a Bash call) or `.claude/tstack-grants.json`
 * (an Agent call, which the plugin's PreToolUse hook lets through) and records the grant in
 * `DIR/grants.jsonl`, before the answer is stored. The plugin's hook removes the rule once the call has
 * run. The ledger is writable by every agent and the hub is not, so the row is trusted only as far as it
 * names a session of this fleet, or a worker's workspace of its work (granted at that session's root), and a
 * rule that lets that one call through.
 */
import { appendFileSync, mkdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { isDir, readText, resolvePath, strerror } from "../files.ts";
import * as Option from "effect/Option";

import { Refusal } from "../errors.ts";
import { asArray, asObject, asString, type Json, type JsonObject } from "../json.ts";
import { readBeats } from "../heartbeat.ts";
import { parseLedger, type Decision } from "../ledger/model.ts";
import { findDecision } from "../ledger/numbers.ts";
import { ALLOW_ONCE, grantFileOf, PERMISSION_TOOLS, ruleOf, whyNoRule } from "../ledger/permission.ts";
import { cwdOf } from "../procs.ts";
import { alive } from "../registry.ts";
import { jj } from "../ws/jj.ts";

/** An answer to a decision of the fleet in `dir`, about to be stored. */
export interface Answered {
  readonly dir: string;
  /** The decision's id or number, as the page sent it. */
  readonly decision: string;
  readonly text: string;
  /** The rule the page showed when the answer was given; a permission's allow-once grants that rule alone. */
  readonly rule: string | undefined;
  /** Who gave it: `tailnet:<login>` or `local` (policy.ts `grantor`). */
  readonly by: string;
  /** The stamp the grant records. */
  readonly at: string;
  /** Looks up the fleet's registered session as the OS shows it ({@link registeredSession}); called only for an
   * allow-once whose root no heartbeat names. */
  readonly registered: () => Registered | undefined;
}

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

/** Why a permission's allow-once cannot be granted. */
class Ungranted {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }
}

/** The trusted grant a permission row asks for. */
interface Asked {
  readonly id: string;
  readonly ref: string;
  readonly rule: string;
  readonly tool: string;
  /** The session root the rule goes into. */
  readonly root: string;
  /** The worker's workspace the row named, when the grant goes to its session's root instead. */
  readonly workspace: string | undefined;
  readonly agentId: string | null;
  /** What the answer says about the grant beside "granted". */
  readonly notes: readonly string[];
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

  return `no heartbeat names it, and the fleet's registered session ${String(registered.pid)} runs in ${registered.cwd === "" ? "a directory the hub cannot read" : registered.cwd}`;
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

const AGAIN = "ask the coordinator to record it again from its session";

/** Why a permission whose root is `root` (as the row has it) and placed so cannot be granted, in plain words. */
function unplaced(root: string, placed: Placement): string | undefined {
  if (placed.kind === "outside") {
    const of = placed.roots.length === 0 ? "a session root" : placed.roots.join(", ");

    return (
      `This permission's folder ${root} isn't part of this fleet's work, so it can't be granted here; ${AGAIN}. ` +
      `(Checked: it is no session root of this fleet (${placed.why}), no workspace in the ledger, and no jj workspace of ${of}.)`
    );
  }

  if (placed.kind !== "untold") return undefined;

  if (placed.roots.length === 0) {
    return `This permission names ${placed.name}'s workspace ${root}, and no session of this fleet is known to grant it at (no heartbeat, and no live registered session), so it can't be granted here; ${AGAIN}.`;
  }

  return (
    `This permission names ${placed.name}'s workspace ${root}, and none of this fleet's session roots (${placed.roots.join(", ")}) is the one its session reads its permissions from, ` +
    "so it can't be granted here; ask the coordinator to record it again with --root set to that session's root."
  );
}

const NO_AGENT_NOTE =
  "The permission names no subagent (agent_id null), so only the session's main thread running the call uses the grant up; " +
  "a subagent's run of it leaves the rule in place until it expires, 30 minutes after the grant.";

function askedOf(dir: string, d: Decision, registered: () => Registered | undefined): Asked | Ungranted {
  const r = d.refusal ?? undefined;

  if (r === undefined) return new Ungranted("the permission has no refused call to grant");

  if (d.status !== "open") return new Ungranted("the permission is no longer open");

  if (!PERMISSION_TOOLS.includes(r.tool)) return new Ungranted(`a grant is for ${PERMISSION_TOOLS.join(" or ")} alone, and this permission is for ${r.tool}`);
  const why = whyNoRule(r.tool, r.call);

  if (why !== undefined) return new Ungranted(`no grant: ${why}`);
  const exact = ruleOf(r.tool, r.call);

  if (r.rule !== exact) return new Ungranted(`the permission's rule ${r.rule} is not the exact rule for its call, ${exact}`);

  if (!isAbsolute(r.root)) return new Ungranted(`the permission's root ${r.root} is not an absolute path`);
  const at = resolvePath(r.root);

  if (!isDir(at)) return new Ungranted(`This permission's folder ${r.root} doesn't exist, so it can't be granted; ${AGAIN}.`);
  const placed = placeRoot(dir, at, registered);
  const refused = unplaced(r.root, placed);

  if (refused !== undefined) return new Ungranted(refused);
  const agentNote = r.agent_id === null ? [NO_AGENT_NOTE] : [];
  const base = { id: d.id, ref: d.ref ?? "", rule: r.rule, tool: r.tool, agentId: r.agent_id };

  if (placed.kind !== "workspace") return { ...base, root: r.root, workspace: undefined, notes: agentNote };
  const who = d.agent ?? "the worker";
  const moved = `This permission names ${placed.name}'s workspace ${r.root}; the hub granted it at the session root ${placed.root}, where ${who}'s session reads its permissions.`;

  return { ...base, root: placed.root, workspace: r.root, notes: [moved, ...agentNote] };
}

function parsed(file: string): JsonObject | Ungranted {
  const text = readText(file);

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

/** `settings` with `rule` added to `permissions.allow`, every other key and entry kept; undefined when the rule
 * is there already; or why it cannot hold it. */
function withRule(file: string, settings: JsonObject, rule: string): JsonObject | Ungranted | undefined {
  const permissions = settings["permissions"] === undefined ? {} : asObject(settings["permissions"]);

  if (permissions === undefined) return new Ungranted(`${file}: permissions is not an object`);
  const allow = permissions["allow"] === undefined ? [] : asArray(permissions["allow"]);

  if (allow === undefined) return new Ungranted(`${file}: permissions.allow is not a list`);

  if (allow.includes(rule)) return undefined;

  return { ...settings, permissions: { ...permissions, allow: [...allow, rule] } };
}

/** How long the hub waits for the settings lock, and the age past which a lock is a crashed holder's. */
const LOCK_WAIT_MS = 2000;

const LOCK_STALE_MS = 10_000;

function hasCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

/**
 * Take the lock the plugin's hook takes too around a settings file's read-modify-write: the directory
 * `.settings.local.json.lock` beside it, made atomically (Bun has no flock). One older than LOCK_STALE_MS is
 * taken over. The lock's path, or why it could not be had.
 */
async function lockSettings(file: string): Promise<string | Ungranted> {
  const lock = join(dirname(file), ".settings.local.json.lock");
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

function writeAtomic(file: string, text: string): void {
  const scratch = join(dirname(file), `.${process.pid}.settings.local.json.tmp`);
  writeFileSync(scratch, text, "utf8");
  renameSync(scratch, file);
}

/** What an answer to a decision does to its permission: refused (the answer is then refused and nothing is
 * stored), or let through, with what the answer says about the grant when there is something to say. */
export type GrantAnswer = { readonly refused: string } | { readonly granted: string | undefined };

const NOTHING: GrantAnswer = { granted: undefined };

/**
 * Grant the call a permission's allow-once answer lets through. Nothing is granted, and nothing said, for an
 * answer to another kind, one that is not allow-once, or a rule someone already put there.
 */
export async function grantAnswer(answered: Answered): Promise<GrantAnswer> {
  if (!answered.text.startsWith(ALLOW_ONCE)) return NOTHING;
  const ledger = Option.getOrUndefined(parseLedger(readText(join(answered.dir, "state.json")) ?? ""));

  if (ledger === undefined || ledger instanceof Refusal) return { refused: "the ledger cannot be read, so the permission cannot be checked" };
  const d = findDecision(ledger, answered.decision);

  if (d === undefined || d.kind !== "permission") return NOTHING;
  const asked = askedOf(answered.dir, d, answered.registered);

  if (asked instanceof Ungranted) return { refused: asked.reason };

  if (answered.rule !== asked.rule) {
    return {
      refused:
        answered.rule === undefined
          ? "the answer names no rule: the page sends the rule it showed, and only that rule is granted"
          : `the page showed the rule ${answered.rule}, and the permission's rule is now ${asked.rule}: look at it again`,
    };
  }

  const file = grantFileOf(asked.tool, asked.root);
  // The hook reads the Agent grants file at each spawn; Claude Code watches only a settings folder that existed at start.
  const reload = asked.tool === "Agent" || isDir(dirname(file)) ? "live" : "restart";

  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch (cause: unknown) {
    return { refused: `could not grant ${asked.rule} in ${file}: ${strerror(cause)}` };
  }

  const lock = await lockSettings(file);

  if (lock instanceof Ungranted) return { refused: lock.reason };

  try {
    const done = written(answered, asked, file, reload);

    if (done instanceof Ungranted) return { refused: done.reason };

    return done === "kept" || asked.notes.length === 0 ? NOTHING : { granted: asked.notes.join(" ") };
  } finally {
    rmdirSync(lock);
  }
}

/** The grant's read-modify-write of `file` and its line in grants.jsonl, under the settings lock: `kept` when
 * the rule was there already. */
function written(answered: Answered, asked: Asked, file: string, reload: string): Ungranted | "kept" | "granted" {
  const settings = parsed(file);

  if (settings instanceof Ungranted) return settings;
  const next = withRule(file, settings, asked.rule);

  if (next instanceof Ungranted) return next;

  // Someone put the rule there, and nobody but them takes it out: no grant, so the hook leaves it.
  if (next === undefined) return "kept";
  const before = readText(file);

  try {
    writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch (cause: unknown) {
    return new Ungranted(`could not grant ${asked.rule} in ${file}: ${strerror(cause)}`);
  }

  try {
    const grant = { op: "grant", decision: asked.id, ref: asked.ref, rule: asked.rule, agent_id: asked.agentId, file, at: answered.at, by: answered.by, reload };
    const line = asked.workspace === undefined ? grant : { ...grant, workspace: asked.workspace };
    appendFileSync(join(answered.dir, "grants.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
  } catch (cause: unknown) {
    // A rule with no grant line is one the hook would never remove: take it back.
    if (before === undefined) rmSync(file, { force: true });
    else writeAtomic(file, before);

    return new Ungranted(`could not record the grant in ${join(answered.dir, "grants.jsonl")}: ${strerror(cause)}`);
  }

  return "granted";
}
