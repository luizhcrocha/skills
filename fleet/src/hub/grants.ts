/**
 * Permission grants (SPEC.md "Permission grants"): when the user answers a permission with allow-once, the
 * hub, not an agent (Claude Code's classifier refuses an agent that writes its own allow rule), adds the
 * row's exact rule (each of its rules, when it asks for several calls) to the session's
 * `.claude/settings.local.json` (a Bash call) or `.claude/tstack-grants.json` (an Agent call, which the
 * plugin's PreToolUse hook lets through) and records each grant in `DIR/grants.jsonl`, before the answer is
 * stored. The plugin's hook removes a rule once its call has run. The ledger is writable by every agent and
 * the hub is not, so the row is trusted only as far as it names a session of this fleet, or a worker's
 * workspace of its work (granted at that session's root), and rules that let exactly the calls the page
 * showed through, in the folder it showed: the answer carries both, and a row that moved since grants nothing.
 * An allow-kind answer grants exactly as allow-once does. A rule card's Add this rule appends its reviewed entry to
 * `autoMode.allow` of the user's settings instead (`addRuleAnswer`, user-settings.ts), and no take-back touches it.
 *
 * The threat model of the take-back, plainly: the hub, the hook and every agent run as one Unix user, and
 * `DIR/grants.jsonl` is a file any agent can write, so a `remove` line there is a record, never the proof that
 * a grant is over. What an agent cannot write is the record's place. Claude Code's permission check
 * protects all of `.claude/`, any file name, but for a few listed exceptions: writes are prompted, or in auto
 * mode routed to the classifier (which refused an agent writing its own allow rule as `[Self-Modification]`),
 * and allow rules do not pre-approve them (code.claude.com/docs/en/permission-modes, "Protected paths"). The
 * sandbox's write-deny is narrower: the settings files and the skills, agents, commands and hooks directories
 * (code.claude.com/docs/en/sandboxing, "Protected paths"). So each take-back, the hook's and this hub's, is put
 * on the root's record of take-backs, `tstack-grants-ended.json` (`ended`: decision, rule, granted: the grant
 * line's `at`, and at), in a place under both, as the rules themselves are (`~/.claude`, outside the root's tree:
 * grant-records.ts says where and why): a grant on that record is over whatever its
 * file holds, and a rule the owner adds after the take-back, byte-identical to the one once granted, is the
 * owner's (measured 2026-10-15: without the record, the chat watch's lasting rule went at the next sweep, the
 * hook's and then this hub's). A grant there is one grant line, not its decision: decision ids repeat (the
 * hook's `_permission_id` hashes the caller and the call; a revised decision keeps its id), so a later grant of
 * the same id and rule is not on record until it too is taken back. An agent that could forge a take-back there could as well write the lasting rule, so the record adds
 * nothing to what it can do. Which grants exist is kept the same way: as it grants, the hub first puts each grant
 * on the root's record of issued grants, `tstack-grants-issued.json` beside it (`issued`: decision, ref, rule,
 * file, at, n, of, rev, dir and the files its call runs, `runs`), then the rule in its file, then its line, then
 * ends the earlier grant of a rule granted anew (`why: superseded`), so a crash at any step leaves no rule that
 * nothing bounds. The newest entry of a file and rule is its grant, whether or not a line names it: grants.jsonl
 * is the fleet's log, a line names a root and grants nothing (measured on 83448844, which found grants from lines:
 * with the line deleted, a restarted hub never took the rule back). A line with no entry is taken back at the next
 * sweep. What stays, accepted: a forged `grant` line of a rule with no entry on record can make a sweep remove it,
 * the owner's included; that failure is fewer allowed calls.
 */
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { isDir, readText, resolvePath, strerror } from "../files.ts";
import * as Option from "effect/Option";

import { Refusal } from "../errors.ts";
import { asArray, asObject, asString, type Json, type JsonObject } from "../json.ts";
import { addsRule, RULE_KIND, whyNoRule } from "../ledger/rule-card.ts";
import { ENDED_RECORD, GRANT_FILES, holdsRule, ISSUED_RECORD, readTreeRecord, recordOf, SETTINGS_LOCK, treeRecordOf } from "./grant-records.ts";
import { lockSettings, lockSettingsSync, parsed, releaseLock, Ungranted, withRules, writeAtomic } from "./settings-file.ts";
import { addAutoModeRule, userSettingsFile } from "./user-settings.ts";
import { readBeats } from "../heartbeat.ts";
import { parseLedger, type Decision } from "../ledger/model.ts";
import { findDecision } from "../ledger/numbers.ts";
import { ALLOW_ONCE, allows, asksKind, callsOf, GRANT_TTL_MS, offersKind, permissionOptions, grantFileOf, isAsk, PERMISSION_TOOLS, readRun, refusalRev, ruleOf, rulesOf, runsOf, whyNoAsks, whyNoCalls } from "../ledger/permission.ts";
import { parseInstant } from "../clock.ts";
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
  /** Every rule the page showed, in order, for a permission that asks for several calls. */
  readonly rules: readonly string[] | undefined;
  /** The folder the page showed the grant going into (the row's root). */
  readonly root: string | undefined;
  /** The files the page showed the calls bound to (the row's `runs`); none when it showed none. */
  readonly runs: readonly string[] | undefined;
  /** Who gave it: `tailnet:<login>` or `local` (policy.ts `grantor`). */
  readonly by: string;
  /** The stamp the grant records. */
  readonly at: string;
  /** Looks up the fleet's registered session as the OS shows it ({@link registeredSession}); called only for an
   * allow-once whose root no heartbeat names. */
  readonly registered: () => Registered | undefined;
  /** The hub's HOME, whose user settings a rule card's Add this rule writes (user-settings.ts `userSettingsFile`). */
  readonly home: string | undefined;
  /** The rule card's entry as the page showed it; Add this rule writes it only when the row still holds it. */
  readonly ruleText?: string | undefined;
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

/** The trusted grant a permission row asks for. */
interface Asked {
  readonly id: string;
  readonly ref: string;
  /** The exact rules to add, one per call, in the order asked. */
  readonly rules: readonly string[];
  /** The files the row says its calls are bound to (`runs`), as the page showed them. */
  readonly runs: readonly string[];
  /** The files the calls are bound to as the hub reads them now (`runsOf`). */
  readonly bound: readonly string[];
  /** What says which state of the row an answer was given to: its last change and what it asks for. */
  readonly rev: string;
  /** The root as the row has it, which the page showed. */
  readonly shown: string;
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

function askedOf(dir: string, d: Decision, registered: () => Registered | undefined): Asked | Ungranted {
  const r = d.refusal ?? undefined;

  if (r === undefined) return new Ungranted("the permission has no refused call to grant");

  if (d.status !== "open") return new Ungranted("the permission is no longer open");

  if (!PERMISSION_TOOLS.includes(r.tool)) return new Ungranted(`a grant is for ${PERMISSION_TOOLS.join(" or ")} alone, and this permission is for ${r.tool}`);
  const why = whyNoCalls(r.tool, callsOf(r)) ?? (r.tool === "Bash" && isAsk(r) ? whyNoAsks(callsOf(r)) : undefined);

  if (why !== undefined) return new Ungranted(`no grant: ${why}`);
  const exact = ruleOf(r.tool, r.call);

  if (r.rule !== exact) return new Ungranted(`the permission's rule ${r.rule} is not the exact rule for its call, ${exact}`);

  if (!isAbsolute(r.root)) return new Ungranted(`the permission's root ${r.root} is not an absolute path`);
  const at = resolvePath(r.root);

  if (!isDir(at)) return new Ungranted(`This permission's folder ${r.root} doesn't exist, so it can't be granted; ${AGAIN}.`);
  const placed = placeRoot(dir, at, registered);
  const refused = unplaced(r.root, placed);

  if (refused !== undefined) return new Ungranted(refused);
  const bound = r.tool === "Bash" ? runsOf(callsOf(r)) : [];
  const rev = `${d.revised ?? d.opened} ${refusalRev(r)}`;
  const base = { id: d.id, ref: d.ref ?? "", rules: rulesOf(r), runs: r.runs ?? [], bound, rev, shown: r.root, tool: r.tool, agentId: r.agent_id };

  // The resolved root: a grant file is its own realpath, or no grant file (`grantFile`) the hook or this hub bounds.
  if (placed.kind !== "workspace") return { ...base, root: at, workspace: undefined, notes: [] };
  const who = d.agent ?? "the worker";
  const moved = `This permission names ${placed.name}'s workspace ${r.root}; the hub granted it at the session root ${placed.root}, where ${who}'s session reads its permissions.`;

  return { ...base, root: placed.root, workspace: r.root, notes: [moved] };
}

/** Why the answer does not grant what the row now asks for: the page sends the rules and the folder it showed,
 * and a row an agent changed after the user read it (another command, one more, another folder) grants nothing. */
function movedSince(answered: Answered, asked: Asked): string | undefined {
  const [first = ""] = asked.rules;
  const again = "look at it again (reload the page)";

  if (answered.rule === undefined) return "the answer names no rule: the page sends the rule it showed, and only that rule is granted";

  if (answered.rule !== first) return `the page showed the rule ${answered.rule}, and the permission's rule is now ${first}: ${again}`;

  if (answered.root === undefined) return `the answer names no folder: the page sends the folder it showed, and the call is granted only there; ${again}`;

  if (answered.root !== asked.shown) return `the page showed the folder ${answered.root}, and the permission's folder is now ${asked.shown}: ${again}`;

  if (asked.rules.length === 1 && answered.rules === undefined) return undefined;
  const shown = answered.rules ?? [first];

  if (shown.length !== asked.rules.length || shown.some((rule, k) => rule !== asked.rules[k])) {
    return `the page showed ${String(shown.length)} ${shown.length === 1 ? "call" : "calls"}, and the permission now asks for ${String(asked.rules.length)}, or for other ones: ${again}`;
  }

  return undefined;
}

function alike(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, k) => item === b[k]);
}

/** Why the answer does not grant the files the calls run now: a call that runs a script by an absolute path is
 * bound to the file's content. The row records each file's sha256 when the permission is asked, the page shows
 * it and sends it back, and the hub hashes the files itself: a script edited after the card opened grants nothing. */
function filesMoved(answered: Answered, asked: Asked): string | undefined {
  if (!alike(asked.runs, asked.bound)) {
    const [odd = ""] = [...asked.runs.filter((entry) => !asked.bound.includes(entry)), ...asked.bound.filter((entry) => !asked.runs.includes(entry))];
    const path = readRun(odd)?.path;

    return `a file this permission's call runs changed after it was asked for${path === undefined ? "" : ` (${path})`}, so the yes would allow another file than the one shown: ask the coordinator to record the permission again`;
  }

  if (!alike(answered.runs ?? [], asked.bound)) return "the page showed other files than the ones the permission's calls run now: look at it again (reload the page)";

  return undefined;
}


/** What an answer to a decision does to its permission: refused (the answer is then refused and nothing is
 * stored), or let through, with what the answer says about the grant when there is something to say. */
export type GrantAnswer = { readonly refused: string } | { readonly granted: string | undefined };

const NOTHING: GrantAnswer = { granted: undefined };

/**
 * Grant the call a permission's allow-once or allow-kind answer lets through (the two grant alike), or add a rule
 * card's entry on its Add this rule (`addRuleAnswer`). Nothing is granted, and nothing said, for an answer to
 * another kind, one that allows nothing, or a rule someone already put there.
 */
export async function grantAnswer(answered: Answered): Promise<GrantAnswer> {
  const adds = addsRule(answered.text);

  if (!allows(answered.text) && !adds) return NOTHING;
  const ledger = Option.getOrUndefined(parseLedger(readText(join(answered.dir, "state.json")) ?? ""));

  if (ledger === undefined || ledger instanceof Refusal) return { refused: "the ledger cannot be read, so the permission cannot be checked" };
  const d = findDecision(ledger, answered.decision);

  if (adds && d?.kind === RULE_KIND) return addRuleAnswer(answered, d);

  if (adds || d === undefined || d.kind !== "permission") return NOTHING;
  const asked = askedOf(answered.dir, d, answered.registered);

  if (asked instanceof Ungranted) return { refused: asked.reason };
  const moved = movedSince(answered, asked) ?? filesMoved(answered, asked);

  if (moved !== undefined) return { refused: moved };
  const notes = asked.notes;
  const file = grantFileOf(asked.tool, asked.root);

  if (grantFile(file) === undefined) return { refused: `${file} is not its own path, or is a symlink, so no record of the grant for it could be trusted: nothing is granted. Make it a plain file in a plain .claude folder; ${AGAIN}.` };

  if (answered.home === undefined || answered.home === "") return { refused: "the hub has no HOME, so it has nowhere to keep the record of the grant: nothing is granted" };
  // The hook reads the Agent grants file at each spawn; Claude Code watches only a settings folder that existed at start.
  const reload = asked.tool === "Agent" || isDir(dirname(file)) ? "live" : "restart";

  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch (cause: unknown) {
    return { refused: `could not grant ${asked.rules.join(", ")} in ${file}: ${strerror(cause)}` };
  }

  const lock = await lockSettings(file, SETTINGS_LOCK);

  if (lock instanceof Ungranted) return { refused: lock.reason };

  try {
    const done = written(answered, asked, file, reload);

    if (done instanceof Ungranted) return { refused: done.reason };

    if (done === "again") return { granted: `${refOf(asked)} was already allowed once as it stands: one yes is one grant, so nothing more was granted. If its 30 minutes passed unused, the coordinator asks again.` };

    return done === "kept" || notes.length === 0 ? NOTHING : { granted: notes.join(" ") };
  } finally {
    releaseLock(lock);
  }
}

/** The grant's read-modify-write of `file` and its lines in grants.jsonl, one per rule added, under the settings
 * lock: `kept` when every rule was there already. All of a permission's rules go in with one write, or none. */
function written(answered: Answered, asked: Asked, file: string, reload: string): Ungranted | "kept" | "again" | "granted" {
  const record = join(answered.dir, "grants.jsonl");

  const recorded = grantLines(record).filter((line) => line["op"] === "grant");

  // One grant for each state of a permission: the same answer sent again (a second tap, a replayed request) grants
  // nothing. The root's record says so whatever grants.jsonl holds; a line says so of a grant from before the record.
  const onRecord = issuedEntries(answered.home, file, true);

  if (onRecord.some((e) => e.decision === asked.id && e.rev === asked.rev) || recorded.some((line) => line["decision"] === asked.id && line["rev"] === asked.rev)) return "again";
  const settings = parsed(file);

  if (settings instanceof Ungranted) return settings;
  const held = withRules(file, settings, asked.rules);

  if (held instanceof Ungranted) return held;

  // A rule someone put there is theirs, and nobody but them takes it out: no grant for it, so the hook leaves it.
  // One an earlier grant left there (its call cancelled, its 30 minutes not over: its newest entry on the root's
  // record not ended, or a line of it from before the record) is granted anew: the new entry is the grant the hook
  // counts, in its own turn and for its own 30 minutes, and the earlier one is superseded. One an earlier grant once
  // named, since taken back (on the root's record of take-backs), is the owner's again.
  const ended = endedIn(answered.home, file, true);
  const newest = newestEntries(onRecord);

  const standsOf = (rule: string): boolean => {
    const entry = newest.get(`${file}\n${rule}`);

    if (entry !== undefined) return !endedHas(ended, entry);

    return recorded.some((line) => {
      const named = { file, decision: asString(line["decision"]) ?? "", rule, at: asString(line["at"]) ?? "", rev: asString(line["rev"]) };

      return line["rule"] === rule && line["file"] === file && !endedHas(ended, named, true) && !lineEnded(ended, named);
    });
  };

  const granting = asked.rules.filter((rule) => held.added.includes(rule) || standsOf(rule));

  if (granting.length === 0) return "kept";
  const before = readText(file);

  const grants = granting.map((rule) => {
    const n = asked.rules.indexOf(rule) + 1;
    const runs = runsOfCall(asked, n);
    const bound = runs.length === 0 ? {} : { runs };
    const line = { op: "grant", decision: asked.id, ref: asked.ref, rule, agent_id: asked.agentId, file, at: answered.at, by: answered.by, reload, rev: asked.rev, n, of: asked.rules.length, ...bound };

    return {
      entry: { decision: asked.id, ref: asked.ref, rule, file, at: answered.at, n, of: asked.rules.length, rev: asked.rev, dir: answered.dir, ...bound },
      line: asked.workspace === undefined ? line : { ...line, workspace: asked.workspace },
    };
  });

  const issuedRecord = issuedFile(answered.home, file, true);

  if (issuedRecord === undefined) return new Ungranted("no HOME, so no record of the grant could be kept");
  const issuedBefore = readText(issuedRecord);
  const record0 = parsed(issuedRecord, issuedBefore);

  if (record0 instanceof Ungranted) return new Ungranted(`could not record the grant: ${record0.reason}`);

  const unrecord = (): void => {
    try {
      if (issuedBefore === undefined) rmSync(issuedRecord, { force: true });
      else writeAtomic(issuedRecord, issuedBefore);
    } catch {
      // An entry whose rule is not in its file grants nothing: the hook and the hub read no grant from it.
    }
  };

  // 1. The grant on its root's record, before the rule: a crash after it leaves an entry whose rule is not in its
  // file (a rule held already is now bounded by the newer entry), never a rule that nothing bounds.
  try {
    mkdirSync(dirname(issuedRecord), { recursive: true });
    const issuedNow = [...(asArray(record0["issued"]) ?? []), ...grants.map((g) => g.entry)].slice(-ISSUED_KEPT);

    writeAtomic(issuedRecord, `${JSON.stringify({ ...record0, issued: issuedNow }, null, 2)}\n`);
  } catch (cause: unknown) {
    return new Ungranted(`could not record the grant in ${issuedRecord}: ${strerror(cause)}`);
  }

  // 2. The rules. A crash after it leaves a grant on record with no line: the hook finds it on the record of its
  // session's root, and this hub through the fleet's heartbeats.
  try {
    if (held.added.length > 0) writeAtomic(file, `${JSON.stringify(held.next, null, 2)}\n`);
  } catch (cause: unknown) {
    unrecord();

    return new Ungranted(`could not grant ${held.added.join(", ")} in ${file}: ${strerror(cause)}`);
  }

  // 3. The line, the fleet's log of the grant.
  try {
    appendFileSync(record, `${grants.map((g) => JSON.stringify(g.line)).join("\n")}\n`, "utf8");

    for (const rule of granting) issued.set(`${file}\n${rule}`, { dir: answered.dir, decision: asked.id, file, rule, at: answered.at, rev: asked.rev, recorded: true });
  } catch (cause: unknown) {
    if (held.added.length > 0) {
      if (before === undefined) rmSync(file, { force: true });
      else writeAtomic(file, before);
    }

    unrecord();

    return new Ungranted(`could not record the grant in ${record}: ${strerror(cause)}`);
  }

  // 4. The earlier grants of a rule granted anew, ended as superseded: the newest entry of a rule is its grant
  // already, so a crash before this, or a record that cannot be written, leaves the same grants standing.
  supersede(answered.home, file, granting.flatMap((rule) => {
    const entry = newest.get(`${file}\n${rule}`);

    return entry === undefined || endedHas(ended, entry) || ended.imported.has(endedKey(entry.file, entry.decision, entry.rule, entry.at, entry.rev ?? "")) ? [] : [endedEntry(entry, answered.at, "superseded")];
  }));

  return "granted";
}

function refOf(asked: Asked): string {
  return asked.ref === "" ? "This permission" : asked.ref;
}

/** The files call `n` (from 1) of a permission is bound to, as the hub read them when it granted. */
function runsOfCall(asked: Asked, n: number): { readonly path: string; readonly sha256: string }[] {
  return asked.bound.flatMap((entry) => {
    const run = readRun(entry);

    return run?.n === n ? [{ path: run.path, sha256: run.sha256 }] : [];
  });
}

/**
 * The answer `text` to `decision` as the hub stores it: an allow-kind to a permission that does not offer it (its
 * opener held it to once, or an Agent spawn: `offersKind`) is the allow-once it grants, so the coordinator hears no
 * ask for a rule. Any other answer is as given.
 */
export function answerAsOffered(dir: string, decision: string, text: string): string {
  if (!asksKind(text)) return text;
  const ledger = Option.getOrUndefined(parseLedger(readText(join(dir, "state.json")) ?? ""));
  const d = ledger === undefined || ledger instanceof Refusal ? undefined : findDecision(ledger, decision);
  const r = d?.kind === "permission" ? d.refusal : undefined;

  if (r === undefined || r === null || offersKind(r)) return text;
  const once = permissionOptions(r).find((o) => o.id === ALLOW_ONCE);
  const rest = text.indexOf("\n");

  return `${ALLOW_ONCE}: ${once?.label ?? "Allow this call once"}${rest < 0 ? "" : text.slice(rest)}`;
}

/**
 * A rule card's Add this rule (Luiz's decision always-scope a, #115): the card's entry appended to `autoMode.allow` of
 * the user's settings, the real file behind `$HOME/.claude/settings.json`, with `"$defaults"` kept first and every
 * other entry kept, an identical entry skipped; and a line `{op: "rule", decision, file, sha256, at, by}` in the
 * fleet's grants.jsonl. The entry is the row's, and only while it is still the one the page showed. Nothing ever
 * removes an entry: Luiz edits his settings himself.
 */
async function addRuleAnswer(answered: Answered, d: Decision): Promise<GrantAnswer> {
  const rule = d.rule ?? "";
  const ref = d.ref ?? d.id;

  if (d.status !== "open") return { refused: `${ref} is ${d.status}: nothing is added` };
  const bad = whyNoRule(rule);

  if (bad !== undefined) return { refused: `${ref}'s rule cannot be added: ${bad}` };

  if (answered.ruleText !== rule) return { refused: `the page showed another rule than the one ${ref} holds now: reload the page, read it, and answer again` };
  const file = userSettingsFile(answered.home);

  if (file instanceof Ungranted) return { refused: `could not add ${ref}'s rule: ${file.reason}` };
  const record = join(answered.dir, "grants.jsonl");
  const sha256 = createHash("sha256").update(rule, "utf8").digest("hex");

  const added = await addAutoModeRule(file, rule, () => {
    try {
      appendFileSync(record, `${JSON.stringify({ op: "rule", decision: d.id, file, sha256, at: answered.at, by: answered.by })}\n`, "utf8");

      return undefined;
    } catch (cause: unknown) {
      return new Ungranted(`could not record the rule in ${record}: ${strerror(cause)}`);
    }
  });

  if (added instanceof Ungranted) return { refused: added.reason };
  const kept = added ? "" : " It was there already: nothing was added.";

  return { granted: `Added to your settings: every session reads it at once. It sits in your dotfiles checkout: commit and push it from there.${kept}` };
}

/** The lines of a grants.jsonl that read as JSON objects, in order; none when the file is not there. */
function grantLines(record: string): JsonObject[] {
  return (readText(record) ?? "").split("\n").flatMap((line) => {
    try {
      // SAFETY: JSON.parse returns JSON values only.
      const row = asObject(JSON.parse(line) as Json);

      return row === undefined ? [] : [row];
    } catch {
      return [];
    }
  });
}

/** A grant the hub may take back: where it is recorded, and the rule in its file. */
interface Issued {
  readonly dir: string;
  readonly decision: string;
  readonly file: string;
  readonly rule: string;
  /** The grant line's `at`, which names it on the records. */
  readonly at: string;
  /** The permission's revision it was granted under, which names it on the records with `at`. */
  readonly rev: string | undefined;
  /** Whether the grant is on its root's record of issued grants (`issuedEntries`), so its `at` is the hub's. */
  readonly recorded: boolean;
}

/** The grants this hub wrote and has not seen end, by file and rule. Held in memory, so the hub's own removal
 * at 30 minutes does not rest on grants.jsonl, which every agent can write. */
const issued = new Map<string, Issued>();

/** A grant's file, when it is one a grant is written to: an absolute `<root>/.claude/settings.local.json` or
 * `<root>/.claude/tstack-grants.json` whose folder is its own realpath, and that is no symlink (the hook's
 * `_grant_file`). Else nothing there is read, taken back or written (review 3): `join` reads a `<link>/..` by its
 * text where the filesystem follows the link. A symlinked `.claude/hooks` once sent a take-back onto another root's
 * record; the records are kept by the root's real path outside its tree now (grant-records.ts), so it reaches none.
 * `seen` caches the answer by path. */
function grantFile(value: Json | undefined, seen?: Map<string, string | undefined>): string | undefined {
  const file = asString(value);

  if (file === undefined) return undefined;

  if (seen?.has(file) === true) return seen.get(file);
  const folder = dirname(file);

  const ok = isAbsolute(file) && basename(folder) === ".claude" && GRANT_FILES.includes(basename(file)) && resolvePath(folder) === folder && !isSymlink(file);

  seen?.set(file, ok ? file : undefined);

  return ok ? file : undefined;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}


/** The record of take-backs for a grant file's root (grant-records.ts); the hook's `_record_file`. None with no home. */
function recordFile(home: string | undefined, file: string, locked: boolean): string | undefined {
  return recordOf(home, file, ENDED_RECORD, { locked });
}

/** A grant as the record of take-backs names it. */
interface Named {
  readonly file: string;
  readonly decision: string;
  readonly rule: string;
  readonly at: string;
  readonly rev: string | undefined;
}

/** What names one grant on the record of take-backs: its grant file (its own realpath: `grantFile`), decision, rule,
 * the `at` of its grant and its revision (the hook's `_ended_key`); "" for a file or revision an entry names none of.
 * The file, as a take-back written beside one file named no file and ended another's grant (review 3). `at` is to
 * the second: one decision answered twice in one second under two revisions is two grants, and without the revision
 * the supersede of the first ended the second as it was born (review 2). */
function endedKey(file: string, decision: string, rule: string, granted: string, rev: string): string {
  return [file, decision, rule, granted, rev].join("\n");
}

/** Whether `ended` (`endedIn`) holds the take-back of `grant` (the hook's `_ended_why`): an entry naming its file
 * and its revision. For a grant on no record of issued grants (`line`) alone, an entry with no file or no revision
 * matches on the rest: master's take-backs carry neither, and a session runs master's hook until it restarts, so a
 * grant of master's era its hook took back would be taken back again. Never for a recorded grant: master's writers
 * check no symlink, so a forged line in a session on master's hook put such an entry on a real root's record, and it
 * ended the real grant for good (review 4, finding 1). A recorded grant master's hook took back, whose rule the owner
 * put back by hand, goes once more during the skew: fewer calls. */
function endedHas(ended: Ended, grant: Named, line = false): boolean {
  const rev = grant.rev ?? "";
  const revs = line && rev !== "" ? [rev, ""] : [rev];

  return (line ? [grant.file, ""] : [grant.file]).some((file) => revs.some((r) => ended.taken.has(endedKey(file, grant.decision, grant.rule, grant.at, r))));
}

/** Whether `ended` holds the take-back of a line on no record of issued grants (the hook's `_line_ended`): an entry
 * marked `line` with its file, decision, rule, at and revision, all of them. Such an entry ends no issued grant, under
 * any key: a line's fields are any agent's to copy from a real grant's (review 3, finding 1). Without it nothing marked
 * a line over, and a rule the owner added that is identical to one went at every sweep (round 4; 2026-10-15). */
function lineEnded(ended: Ended, line: Named): boolean {
  return ended.lines.has(endedKey(line.file, line.decision, line.rule, line.at, line.rev ?? ""));
}

/** The take-back of a grant as the record of take-backs holds it; `line` for a line on no record (`lineEnded`). */
function endedEntry(grant: Named, at: string, why: string, line = false): JsonObject {
  const base = { file: grant.file, decision: grant.decision, rule: grant.rule, granted: grant.at };
  const named: JsonObject = grant.rev === undefined || grant.rev === "" ? base : { ...base, rev: grant.rev };

  return line ? { ...named, line: true, at, why } : { ...named, at, why };
}

/** The newest ENDED_KEPT take-backs are kept on the record. */
const ENDED_KEPT = 4096;

/** How far ahead of now a grant's `at` may be and still be a hub's own stamp (the hook's GRANT_SKEW_S): one further
 * ahead is forged, never comes to its 30 minutes, and is over. */
const GRANT_SKEW_MS = 5 * 60_000;

/** The record of the grants issued for a grant file's root (grant-records.ts); the hook's `_issued_file`. The one
 * place a grant's `at`, `runs` and `n` are read from. None with no home. */
function issuedFile(home: string | undefined, file: string, locked: boolean): string | undefined {
  return recordOf(home, file, ISSUED_RECORD, { locked });
}

/** The record at `record` (`parsed`); none when there is no record (no home). */
function parsedRecord(record: string | undefined): JsonObject | Ungranted {
  return record === undefined ? {} : parsed(record);
}

/** The newest ISSUED_KEPT grants are kept on the record of issued grants. */
const ISSUED_KEPT = 4096;

/** A grant on its root's record of issued grants, as the hub wrote it. */
interface Entry {
  readonly decision: string;
  readonly rule: string;
  readonly file: string;
  readonly at: string;
  readonly rev: string | undefined;
  readonly dir: string | undefined;
  /** Copied from the tree by the import (grant-records.ts). */
  readonly imported: boolean;
}

/** The grants on record for `file`'s root, oldest first, each naming a grant file of that root: its realpath in
 * the root's `.claude/` (the hook's `_read_issued`). An entry naming another root's file is no grant: the hub writes
 * none, and a line names any folder's record (review 2: one from a folder an agent made replaced the session root's
 * entry, with a later `at`). None when the record is not there, cannot be read or does not parse (a grant on it then
 * stands on no record: fewer allowed calls). */
function issuedEntries(home: string | undefined, file: string, locked: boolean): Entry[] {
  const record = parsedRecord(issuedFile(home, file, locked));
  const issued = record instanceof Ungranted ? undefined : asArray(record["issued"]);
  const own = dirname(file);
  const seen = new Map<string, string | undefined>();

  return (issued ?? []).flatMap((item) => {
    const entry = asObject(item);
    const [decision, rule, at] = (["decision", "rule", "at"] as const).map((key) => asString(entry?.[key]));
    const of = grantFile(entry?.["file"], seen);

    if (decision === undefined || rule === undefined || at === undefined || of === undefined || dirname(of) !== own) return [];

    return [{ decision, rule, file: of, at, rev: asString(entry?.["rev"]), dir: asString(entry?.["dir"]), imported: entry?.["imported"] === true }];
  });
}

/** The newest entry of each file and rule: an earlier grant of a rule granted anew is superseded, ended or not. */
function newestEntries(entries: readonly Entry[]): Map<string, Entry> {
  return new Map(entries.map((e) => [`${e.file}\n${e.rule}`, e]));
}

/** Put `ended` on the record of take-backs of `file`'s root, under the settings lock the caller holds. */
function supersede(home: string | undefined, file: string, ended: readonly JsonObject[]): void {
  const record = recordFile(home, file, true);

  if (ended.length === 0 || record === undefined) return;

  try {
    const held = parsed(record);

    if (held instanceof Ungranted) return;
    mkdirSync(dirname(record), { recursive: true });
    writeAtomic(record, `${JSON.stringify(ended.reduce(withEnded, held), null, 2)}\n`);
  } catch {
    // The newer entry is the rule's grant all the same.
  }
}

/** The take-backs on record for a root, by `endedKey`: `taken` of issued grants, `lines` of lines on no record (an
 * entry marked `line`), apart so that no lookup of an issued grant's take-back reads a line's, and `imported` those the
 * import copied from the tree, which end their grant and make no rule the owner's. */
interface Ended {
  readonly taken: ReadonlySet<string>;
  readonly lines: ReadonlySet<string>;
  readonly imported: ReadonlySet<string>;
}

/** The take-backs on record for `file`; none when the record is not there, cannot be read or does not parse (a
 * sweep then errs toward fewer allowed calls, as everywhere). Temporary, until step grant-dual-drop: with those on
 * the tree's copy (`readTreeRecord`), where a session on the old hook puts its take-backs, that `rulesGone` keeps;
 * the union only ever ends a grant (grant-records.ts, "The transition"). `locked`: the caller holds the settings
 * lock. */
function endedIn(home: string | undefined, file: string, locked: boolean): Ended {
  const record = parsedRecord(recordFile(home, file, locked));
  const ours = takeBacks(record);
  const text = readTreeRecord(file, ENDED_RECORD);
  const known = new Set(ours.map((t) => `${t.line}\n${t.key}`));
  const theirs = takeBacks(text === undefined ? {} : parsed(treeRecordOf(file, ENDED_RECORD), text)).filter((t) => !known.has(`${t.line}\n${t.key}`));
  const taken = new Set<string>();
  const lines = new Set<string>();
  const imported = new Set<string>();

  for (const t of [...ours, ...rulesGone(file, theirs, locked)]) (t.imported ? imported : t.line ? lines : taken).add(t.key);

  return { taken, lines, imported };
}

/** A take-back as `endedIn` reads it: its `endedKey`, whether it is a line's or the import's, and its rule. */
interface TakeBack {
  readonly key: string;
  readonly line: boolean;
  readonly imported: boolean;
  readonly rule: string;
}

function takeBacks(record: JsonObject | Ungranted): TakeBack[] {
  return (record instanceof Ungranted ? [] : (asArray(record["ended"]) ?? [])).flatMap((entry) => {
    const [file, decision, rule, granted, rev] = (["file", "decision", "rule", "granted", "rev"] as const).map((key) => asString(asObject(entry)?.[key]));

    return decision !== undefined && rule !== undefined && granted !== undefined ? [{ key: endedKey(file ?? "", decision, rule, granted, rev ?? ""), line: asObject(entry)?.["line"] === true, imported: asObject(entry)?.["imported"] === true, rule }] : [];
  });
}

/** Temporary, until step grant-dual-drop: of the tree's take-backs the folder's record lacks, those whose rule is in
 * none of the root's grant files, read under the settings lock (taken here unless the caller holds it): the old hook
 * takes the rule out before it puts its take-back on record, and the tree's copy is any checkout's or agent's to
 * write, so one whose rule is still there ends nothing, and its grant keeps its bounds; else a forged take-back of a
 * one-time grant made its rule the owner's, for good. None when the lock is not had or a grant file does not parse. */
function rulesGone(file: string, tree: readonly TakeBack[], locked: boolean): readonly TakeBack[] {
  if (tree.length === 0) return [];
  const lock = locked ? undefined : lockSettingsSync(file, SETTINGS_LOCK);

  if (!locked && lock === undefined) return [];

  try {
    return tree.filter((t) => !GRANT_FILES.some((name) => holdsRule(join(dirname(file), name), t.rule)));
  } finally {
    if (lock !== undefined) releaseLock(lock);
  }
}

/** `record` with the take-back `ended` appended, the newest ENDED_KEPT kept, every other key as it was. */
function withEnded(record: JsonObject, ended: JsonObject): JsonObject {
  return { ...record, ended: [...(asArray(record["ended"]) ?? []), ended].slice(-ENDED_KEPT) };
}

/** Whether grant line `line`, on no record, came after `entry`, on record, by `at` (the hook's `_later`); a line whose
 * `at` does not read is later: it then hides the entry's grant, which is fewer allowed calls. */
function later(line: Named, entry: Named): boolean {
  const [at, then] = [parseInstant(line.at), parseInstant(entry.at)];

  return at === undefined || then === undefined || at >= then;
}

/** The grant of each file and rule: the newest entry of it on the record of issued grants of each root that the
 * grants.jsonl of `dirs`, their heartbeats (each session's project, else its cwd) or this hub's memory name, left
 * out when it is on its root's record of take-backs (`endedIn`: over, whatever the file holds). grants.jsonl is the
 * fleet's log, any agent's to write: a line names a root and grants nothing, and a deleted one hides no grant whose
 * root another source names. A line is the grant of its own entry (by `endedKey`), never of an earlier entry of its
 * rule (the hook's `_latest_grants`): a line with no entry is a grant on no record (`recorded` false), which is taken
 * back at once: a grant of a hub that wrote no record (the host's), or a forged line; its take-back is marked `line`
 * (`lineEnded`). Such a line replaces the rule's grant on record when that grant is over and the line came after it
 * (`later`), or the entry is one the import copied from the tree, any agent's to write (grant-records.ts); else it
 * hides nothing, so no forged line moves a standing grant. Hidden behind a grant the hook took back, a second
 * allow-once of its rule kept its rule past every sweep. A `remove` line ends nothing here. */
function latestGrants(dirs: readonly string[], home: string | undefined): Issued[] {
  const latest = new Map<string, Issued>();
  const endedOf = new Map<string, Ended>();

  const isEnded = (grant: Named, line = false): boolean => {
    const root = dirname(grant.file);
    const ended = endedOf.get(root) ?? endedIn(home, grant.file, false);

    endedOf.set(root, ended);

    return endedHas(ended, grant, line) || (line && lineEnded(ended, grant));
  };

  const roots = new Map<string, { readonly file: string; readonly dir: string }>();
  const seen = new Map<string, string | undefined>();

  const name = (file: string, dir: string): void => {
    if (grantFile(file, seen) !== undefined && !roots.has(dirname(file))) roots.set(dirname(file), { file, dir });
  };

  const lines = dirs.flatMap((dir) =>
    grantLines(join(dir, "grants.jsonl")).flatMap((line) => {
      const [decision, rule, file, at, rev] = [asString(line["decision"]), asString(line["rule"]), grantFile(line["file"], seen), asString(line["at"]) ?? "", asString(line["rev"])];

      // A rule line (a rule card's Add this rule) names the user's settings.json, which grantFile never takes, so no
      // sweep takes it back; a line that says `lasting` of a session's grant file is the one-time grant it is.
      if (line["op"] !== "grant" || decision === undefined || rule === undefined || file === undefined) return [];
      name(file, dir);

      return [{ dir, decision, file, rule, at, rev, recorded: false }];
    }),
  );

  for (const dir of dirs) {
    for (const beat of readBeats(dir)) {
      const root = beat.project ?? beat.cwd;

      if (root !== null && isAbsolute(root)) for (const file of GRANT_FILES) name(join(resolvePath(root), ".claude", file), dir);
    }
  }

  for (const grant of issued.values()) name(grant.file, grant.dir);

  const onRecord = new Map<string, { readonly entry: Entry; readonly over: boolean }>();
  const paired = new Set<string>();

  for (const { file, dir } of roots.values()) {
    const entries = issuedEntries(home, file, false);

    for (const e of entries) paired.add(endedKey(e.file, e.decision, e.rule, e.at, e.rev ?? ""));

    for (const [key, entry] of newestEntries(entries)) {
      // A record holds its own root's grants alone (`issuedEntries`); the first record to name a grant keeps it.
      if (onRecord.has(key)) continue;
      const over = isEnded(entry);
      onRecord.set(key, { entry, over });

      if (!over) latest.set(key, { dir: entry.dir ?? dir, decision: entry.decision, file: entry.file, rule: entry.rule, at: entry.at, rev: entry.rev, recorded: true });
    }
  }

  for (const line of lines) {
    const key = `${line.file}\n${line.rule}`;

    if (paired.has(endedKey(line.file, line.decision, line.rule, line.at, line.rev ?? ""))) continue;
    const held = onRecord.get(key);

    if (held !== undefined && !held.entry.imported && !(held.over && later(line, held.entry))) continue;

    if (!isEnded(line, true)) latest.set(key, line);
    else if (latest.get(key)?.recorded === true) latest.delete(key);
  }

  for (const [key, grant] of issued) if (isEnded(grant, !grant.recorded)) issued.delete(key);

  return [...latest.values()];
}

/**
 * Take back every grant older than 30 minutes whose rule is still in its file (SPEC.md "Permission grants",
 * Removal): the hub's own end of a one-time grant, for a rule the hook never removed because its session made no
 * call, runs without this fleet, or had its record of grants edited. It reads the grants of the fleets in `dirs`
 * (so a restarted hub takes up what an earlier one granted) and the ones this process wrote. A grant's age is
 * the `at` on its root's record of issued grants; one on no record, with no readable stamp, or with one more than
 * GRANT_SKEW_MS ahead of `now`, is expired. What it
 * took back, as `rule in file`.
 */
export async function expireGrants(dirs: readonly string[], now: Date, stamp: string, home: string | undefined): Promise<string[]> {
  const taken: string[] = [];

  for (const grant of latestGrants(dirs, home)) {
    const at = parseInstant(grant.at);
    const key = `${grant.file}\n${grant.rule}`;

    if (grant.recorded && at !== undefined && now.getTime() - at < GRANT_TTL_MS && at - now.getTime() <= GRANT_SKEW_MS) continue;

    if (!holdsRule(grant.file, grant.rule)) {
      issued.delete(key);
      continue;
    }

    const lock = await lockSettings(grant.file, SETTINGS_LOCK);

    if (lock instanceof Ungranted) continue;

    try {
      // A file that is no grant file now (a symlink made since it was read) is left, and nothing is written.
      if (grantFile(grant.file) !== grant.file) continue;
      const settings = parsed(grant.file);
      const permissions = settings instanceof Ungranted ? undefined : asObject(settings["permissions"]);
      const allow = asArray(permissions?.["allow"]);

      if (settings instanceof Ungranted || permissions === undefined || allow === undefined || !allow.includes(grant.rule)) continue;
      const record = recordFile(home, grant.file, true);
      const held = parsedRecord(record);

      // The record read again under the lock (the hook's `_take_back_locked`): a grant the hook took back since is
      // over, and the rule there now is the owner's.
      const ended = endedIn(home, grant.file, true);

      if (endedHas(ended, grant, !grant.recorded) || (!grant.recorded && lineEnded(ended, grant))) {
        issued.delete(key);
        continue;
      }

      // The settings first, so a record that cannot be written leaves fewer allowed calls, never more; one that
      // does not parse is left as it is.
      writeAtomic(grant.file, `${JSON.stringify({ ...settings, permissions: { ...permissions, allow: allow.filter((rule) => rule !== grant.rule) } }, null, 2)}\n`);

      // A grant on no record of issued grants was never issued: its take-back is marked line, and ends no issued
      // grant (review 3: one with a line's decision, `at` and rev ended the real grant they were copied from), so a
      // rule the owner adds again is not taken at the next sweep.
      if (record !== undefined && !(held instanceof Ungranted)) {
        mkdirSync(dirname(record), { recursive: true });
        writeAtomic(record, `${JSON.stringify(withEnded(held, endedEntry(grant, stamp, "expired", !grant.recorded)), null, 2)}\n`);
      }

      issued.delete(key);
      taken.push(`${grant.rule} in ${grant.file}`);

      try {
        appendFileSync(join(grant.dir, "grants.jsonl"), `${JSON.stringify({ op: "remove", decision: grant.decision, rule: grant.rule, file: grant.file, at: stamp, why: "expired", by: "hub" })}\n`, "utf8");
      } catch {
        // The rule is gone, which is what ends the grant; the line is its record.
      }
    } catch {
      // A file that cannot be written now is tried again at the next sweep.
    } finally {
      releaseLock(lock);
    }
  }

  return taken;
}
