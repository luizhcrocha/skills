/**
 * `fleet ws DIR …`: the jj workspaces a fleet's workers edit in, recorded in the ledger (`workspaces[]`).
 *
 * - `add NAME [-r BASE] [--agent ID] [--repo PATH]`: `jj workspace add <repo>-NAME -r BASE --name NAME`
 *   beside the repo's default workspace (the one `--repo`, else the cwd, is in); BASE defaults to `@-`
 *   there. Records the worker (`--agent`, else NAME), the path and the base change, and prints the path
 *   for the brief. It warns when an idle workspace already covers the worker's lane: that one is reused.
 * - `add WORKER --reuse WORKSPACE|WORKER [-r BASE]`: hands a recorded workspace whose worker is no longer
 *   at work to the next worker of its lane, on a fresh change (on BASE when given, else on what the last
 *   holder left), and records who held it before. Its setup (dependencies, a dev shell, build caches) stays.
 * - In a fleet whose workers share one working copy (`fleet state DIR set --workspaces shared`), `add` makes
 *   nothing: it prints the shared working copy (the repo's default workspace) for the brief; and
 *   `split WORKER -m MESSAGE` integrates a finished worker by splitting its lane's files out of that working
 *   copy's @ into one described change.
 * - `list`: each workspace's tip, whether it is empty or conflicted, what it holds that the stack (the
 *   default workspace's @) does not, and when its worker was last seen.
 * - `prune [--apply | --dry-run]`: forgets and deletes the workspaces whose worker is no longer live and
 *   whose changes are all in the stack (or empty, or abandoned); refuses the others, naming why. Only a
 *   directory recorded here, that jj knows as that workspace of that repo, is ever deleted. Without
 *   `--apply` it is a dry run: deletion reaches files jj never snapshotted (ignored ones), so it waits
 *   for a second, deliberate command.
 */
import { rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { stampOf } from "../clock.ts";
import { Refusal } from "../errors.ts";
import { exists, isDir, readText, resolvePath, writeText } from "../files.ts";
import { workerActivity } from "../heartbeat.ts";
import { Out } from "../io.ts";
import { asArray, asObject, asString, dumps, parseObject, type Json, type JsonObject, type JsonOut } from "../json.ts";
import { laneMatches, lanesMeet } from "../ledger/lanes.ts";
import { decodeLedger } from "../ledger/model.ts";
import { validate } from "../ledger/validate.ts";
import { cliLookups } from "../page/lookups.ts";
import { pageHtml, readTemplate, writePage } from "../page/render.ts";
import { view } from "../page/view.ts";
import { changes, jj, literal, unintegratedRevset, why, workspaceNames, workspaceRoot, type Change } from "../ws/jj.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";

const USAGE =
  "usage: fleet ws DIR add NAME [-r BASE] [--agent ID] [--repo PATH] | add WORKER --reuse WORKSPACE|WORKER [-r BASE] | " +
  "split WORKER -m MESSAGE [--repo PATH] | list | prune [--apply | --dry-run]";

const NAME = /^[A-Za-z0-9_.-]+$/;

/** A worker in one of these is still at work: its workspace stays. */
const LIVE = new Set(["running", "queued", "blocked"]);

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "ws", reason }));
}

/** The value after `flag` in `argv`, and `argv` without the two. */
function option(argv: readonly string[], ...flags: readonly string[]): readonly [string | undefined, string[]] {
  const at = argv.findIndex((a) => flags.includes(a));

  if (at < 0) return [undefined, [...argv]];

  return [argv[at + 1], [...argv.slice(0, at), ...argv.slice(at + 2)]];
}

/** A workspace as the ledger records it. */
interface Recorded {
  readonly id: string;
  readonly agent: string;
  readonly path: string;
  readonly repo: string;
  readonly base: string;
  readonly row: JsonObject;
}

function recorded(raw: JsonObject): Recorded[] {
  return (asArray(raw["workspaces"]) ?? []).flatMap((item) => {
    const row = asObject(item);
    const id = asString(row?.["id"]);
    const path = asString(row?.["path"]);
    const repo = asString(row?.["repo"]);

    if (row === undefined || id === undefined || path === undefined || repo === undefined || row["status"] === "pruned") return [];

    return [{ id, agent: asString(row["agent"]) ?? id, path, repo, base: asString(row["base"]) ?? "", row }];
  });
}

function agentRow(raw: JsonObject, id: string): JsonObject | undefined {
  return (asArray(raw["agents"]) ?? []).map(asObject).find((a) => asString(a?.["id"]) === id);
}

/** A worker row's lane entries. */
function laneOf(row: JsonObject | undefined): string[] {
  return asArray(row?.["lane"])?.flatMap((e) => asString(e) ?? []) ?? [];
}

/** A worker's status, or undefined when the ledger has no row for it. */
function statusOf(raw: JsonObject, id: string): string | undefined {
  return asString(agentRow(raw, id)?.["status"]);
}

/** Whether the fleet's workers share one working copy (`fleet state DIR set --workspaces shared`). */
function shared(raw: JsonObject): boolean {
  return raw["workspace_mode"] === "shared";
}

/** The flags that take a value: one given last, with no value, is a usage error. */
const VALUED = new Set(["-r", "--revision", "--agent", "--repo", "--reuse", "-m", "--message"]);

/** The ledger in DIR as JSON, checked as every command checks it. */
function load(root: string): JsonObject | Refusal {
  const text = readText(join(root, "state.json"));

  if (text === undefined) return new Refusal({ speaker: "ws", reason: `no state.json in ${root}; run \`fleet state ${root} init\` first` });
  const raw = Option.getOrUndefined(parseObject(text));
  const ledger = raw === undefined ? new Refusal({ speaker: "ws", reason: `${root}/state.json is not a JSON object` }) : decodeLedger(raw);

  return ledger instanceof Refusal ? ledger : (raw ?? {});
}

/** Write the ledger with `workspaces` (when given) and these events, stamped, and render the page. */
function save(machine: Machine, root: string, raw: JsonObject, workspaces: readonly Json[] | undefined, events: readonly JsonObject[]): Refusal | undefined {
  const stamp = stampOf(machine.now());
  const kept: JsonObject = workspaces === undefined ? raw : { ...raw, workspaces: [...workspaces] };
  const next: JsonObject = { ...kept, events: [...(asArray(raw["events"]) ?? []), ...events], updated: stamp };

  const ledger = decodeLedger(next);
  const fault = ledger instanceof Refusal ? ledger : validate(ledger);

  if (fault !== undefined) return fault;
  // SAFETY: a JsonObject is a JsonOut: the same JSON, read-only.
  writeText(join(root, "state.json"), `${dumps(next as JsonOut, { indent: 2, ensureAscii: false })}\n`);
  const template = readTemplate();
  const html = template === undefined ? undefined : pageHtml(template, view(machine, cliLookups(), next, root), false);

  if (html !== undefined && !(html instanceof Error)) writePage(join(root, "index.html"), html);

  return undefined;
}

function event(machine: Machine, raw: JsonObject, agent: string, kind: string, text: string): JsonObject {
  return { at: stampOf(machine.now()), agent: agentRow(raw, agent) === undefined ? null : agent, kind, text };
}

function described(c: Change): string {
  return `${c.short}${c.empty ? " (empty)" : ""} ${c.description === "" ? "(no description)" : c.description}`;
}

// -- add ----------------------------------------------------------------------------------------

/** The line `add` prints for the brief. */
const BRIEF_LINE = (path: string): string =>
  `brief: your working copy is ${path}; edit, build and describe your changes there only. The coordinator rebases them onto the stack and prunes the workspace.\n`;

function add(machine: Machine, root: string, raw: JsonObject, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    if (VALUED.has(argv.at(-1) ?? "")) return yield* refuse(USAGE);
    const [baseGiven, a] = option(argv, "-r", "--revision");
    const [agentGiven, b] = option(a, "--agent");
    const [repoGiven, c] = option(b, "--repo");
    const [reuse, rest] = option(c, "--reuse");
    const name = rest[0];

    if (rest.length !== 1 || name === undefined) return yield* refuse(USAGE);

    if (shared(raw)) return yield* addShared(root, raw, agentGiven ?? name, repoGiven, baseGiven, reuse);

    if (reuse !== undefined) {
      if (agentGiven !== undefined || repoGiven !== undefined) return yield* refuse(`--reuse takes the worker as NAME, and the workspace knows its repo: ${USAGE}`);

      return yield* handOver(machine, root, raw, name, reuse, baseGiven);
    }

    return yield* addFresh(machine, root, raw, name, agentGiven ?? name, repoGiven, baseGiven ?? "@-");
  });
}

function addFresh(
  machine: Machine,
  root: string,
  raw: JsonObject,
  name: string,
  agent: string,
  repoGiven: string | undefined,
  base: string,
): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (!NAME.test(name) || name === "default") return yield* refuse(`a workspace name is letters, digits, '_', '.' or '-', and not 'default': ${JSON.stringify(name)}`);
    const main = workspaceRoot(resolvePath(repoGiven ?? process.cwd()), "default");

    if (main === undefined) return yield* refuse(`${repoGiven ?? process.cwd()} is not in a jj repo with a default workspace`);
    const held = recorded(raw).find((r) => r.id === name);

    if (held !== undefined) return yield* refuse(`workspace ${name} is already at ${held.path}`);

    if ((workspaceNames(main) ?? []).includes(name)) return yield* refuse(`the repo already has a workspace called ${name}; pick another name`);
    const path = join(dirname(main), `${basename(main)}-${name}`);

    if (exists(path)) return yield* refuse(`${path} already exists`);
    const at = changes(main, base, false);
    const from = at?.[0];

    if (at === undefined || from === undefined || at.length !== 1) return yield* refuse(`-r ${base} names ${at?.length ?? "no"} commit(s) in ${main}; give one`);
    const made = jj(main, ["workspace", "add", path, "-r", from.commit, "--name", name]);

    if (!made.ok) return yield* refuse(why(made));
    const stamp = stampOf(machine.now());
    const row: JsonObject = { id: name, agent, path, repo: main, base: from.change, added: stamp, status: "active" };
    const fault = save(machine, root, raw, [...(asArray(raw["workspaces"]) ?? []), row], [event(machine, raw, agent, "note", `Workspace ${name} for ${agent} at ${path}, on ${described(from)}.`)]);

    if (fault !== undefined) return yield* Effect.fail(fault);
    noRowYet(out, root, raw, agent);

    for (const idle of reusable(raw, agent)) {
      out.err(
        `ws: ${idle.agent}'s workspace ${idle.id} covers ${agent}'s lane and nobody works in it (${idle.agent} ${statusOf(raw, idle.agent) ?? "has no row"}): ` +
          `reuse it: \`fleet ws ${root} add ${agent} --reuse ${idle.id}\` keeps its setup; a fresh one is for parallel work that could meet, a risky experiment, or a comparison\n`,
      );
    }

    out.out(`workspace ${name} for ${agent} at ${path}, on ${described(from)}\n`);
    out.out(BRIEF_LINE(path));

    return 0;
  });
}

function noRowYet(out: Out["Service"], root: string, raw: JsonObject, agent: string): void {
  if (agentRow(raw, agent) !== undefined) return;
  out.err(`ws: no worker row ${agent} yet: record it (\`fleet state ${root} agent ${agent} --task T --milestone M ...\`) before you brief and spawn it\n`);
}

/** The recorded workspaces another worker of `worker`'s lane left idle: its holder is no longer at work, and
 * the holder's lane meets `worker`'s (L7). */
function reusable(raw: JsonObject, worker: string): Recorded[] {
  const lane = laneOf(agentRow(raw, worker));

  if (lane.length === 0) return [];

  return recorded(raw).filter((r) => {
    const status = statusOf(raw, r.agent);

    return r.agent !== worker && (status === undefined || !LIVE.has(status)) && laneOf(agentRow(raw, r.agent)).some((x) => lane.some((y) => lanesMeet(x, y)));
  });
}

/** `add WORKER --reuse TARGET`: hand the workspace TARGET names (by its name, else by its worker) to
 * WORKER, on a fresh change, once its last holder is no longer at work. */
function handOver(machine: Machine, root: string, raw: JsonObject, worker: string, target: string, base: string | undefined): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const all = recorded(raw);
    const r = all.find((x) => x.id === target) ?? all.find((x) => x.agent === target);

    if (r === undefined) return yield* refuse(`no active workspace ${target}, by its name or its worker's: \`fleet ws ${root} list\` names them`);

    if (r.agent === worker) return yield* refuse(`workspace ${r.id} is already ${worker}'s`);
    const status = statusOf(raw, r.agent);

    if (status !== undefined && LIVE.has(status)) {
      return yield* refuse(`workspace ${r.id} is ${r.agent}'s, and ${r.agent} is ${status}: a workspace changes hands once its worker is done or stopped, never while it works there`);
    }

    const own = all.find((x) => x.agent === worker);

    if (own !== undefined) return yield* refuse(`${worker} already works in workspace ${own.id} (${own.path}); a worker holds one workspace`);

    if (!isDir(r.path) || !belongs(r.path, r.repo) || resolvePath(workspaceRoot(r.repo, r.id) ?? "") !== resolvePath(r.path)) {
      return yield* refuse(`${r.path} is no longer jj workspace ${r.id} of ${r.repo}: make ${worker} a fresh one`);
    }

    const failed = snapshot(r.path);

    if (failed !== undefined) return yield* refuse(`jj could not snapshot ${r.id}: ${failed}`);
    const tip = changes(r.repo, `${literal(r.id)}@`)?.[0];

    if (tip === undefined) return yield* refuse(`jj could not read workspace ${r.id}'s @`);

    if (base !== undefined) {
      const at = changes(r.repo, base, false);
      const onto = at?.[0];

      if (at === undefined || onto === undefined || at.length !== 1) return yield* refuse(`-r ${base} names ${at?.length ?? "no"} commit(s) in ${r.repo}; give one`);
      const moved = jj(r.path, ["new", onto.commit]);

      if (!moved.ok) return yield* refuse(why(moved));
    } else if (!tip.empty || tip.description !== "") {
      // The next worker never edits the last one's change: it starts a new one on top.
      const moved = jj(r.path, ["new"]);

      if (!moved.ok) return yield* refuse(why(moved));
    }

    const parent = changes(r.repo, `${literal(r.id)}@-`)?.[0];

    if (parent === undefined || changes(r.repo, `${literal(r.id)}@-`)?.length !== 1) return yield* refuse(`workspace ${r.id}'s @ has no single parent; give -r BASE`);
    const stamp = stampOf(machine.now());
    const handovers = [...(asArray(r.row["handovers"]) ?? []), { from: r.agent, at: stamp }];
    const workspaces = (asArray(raw["workspaces"]) ?? []).map((item) => (asObject(item) === r.row ? { ...r.row, agent: worker, base: parent.change, handovers } : item));
    const text = `Workspace ${r.id} handed from ${r.agent} (${status ?? "no row"}) to ${worker} at ${r.path}, on ${described(parent)}.`;
    const fault = save(machine, root, raw, workspaces, [event(machine, raw, worker, "note", text)]);

    if (fault !== undefined) return yield* Effect.fail(fault);
    noRowYet(out, root, raw, worker);
    out.out(`workspace ${r.id} for ${worker} at ${r.path}, reused from ${r.agent}, on ${described(parent)}\n`);
    out.out(BRIEF_LINE(r.path));

    return 0;
  });
}

/** `add` in a fleet whose workers share one working copy: no workspace is made; the worker is told the
 * shared one. */
function addShared(
  root: string,
  raw: JsonObject,
  worker: string,
  repoGiven: string | undefined,
  base: string | undefined,
  reuse: string | undefined,
): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (reuse !== undefined || base !== undefined) {
      return yield* refuse(`this fleet's workers share one working copy (\`set --workspaces shared\`): there is no workspace to ${reuse === undefined ? "base elsewhere" : "hand over"}`);
    }

    const main = workspaceRoot(resolvePath(repoGiven ?? process.cwd()), "default");

    if (main === undefined) return yield* refuse(`${repoGiven ?? process.cwd()} is not in a jj repo with a default workspace`);
    noRowYet(out, root, raw, worker);
    out.out(`shared: ${worker} gets no workspace of its own: this fleet's workers share one working copy, ${main} (\`set --workspaces shared\`)\n`);
    out.out(
      `brief: your working copy is ${main}, shared with the fleet's other workers; edit only your lane there and move no history ` +
        "(no `jj new`, `edit`, `rebase`, `describe`): the coordinator splits the working copy by each worker's lane.\n",
    );

    return 0;
  });
}

// -- split --------------------------------------------------------------------------------------

/** `split WORKER -m MESSAGE`: in a shared fleet, the finished worker's lane files out of the shared working
 * copy's @, into one change described MESSAGE, below what is left. */
function split(machine: Machine, root: string, raw: JsonObject, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (VALUED.has(argv.at(-1) ?? "")) return yield* refuse(USAGE);
    const [message, a] = option(argv, "-m", "--message");
    const [repoGiven, rest] = option(a, "--repo");
    const worker = rest[0];

    if (rest.length !== 1 || worker === undefined || message === undefined || message.trim() === "") return yield* refuse(USAGE);

    if (!shared(raw)) {
      return yield* refuse("split integrates a fleet whose workers share one working copy; here each worker's changes are in its own workspace: rebase them onto the stack");
    }

    const row = agentRow(raw, worker);
    const status = asString(row?.["status"]);

    if (row === undefined) return yield* refuse(`no worker ${worker} in the ledger`);

    if (status !== undefined && LIVE.has(status)) return yield* refuse(`${worker} is ${status}: split its files out once it is done`);
    const lane = laneOf(row);

    if (lane.length === 0) return yield* refuse(`${worker} has no lane: no file of the working copy is its`);
    const main = workspaceRoot(resolvePath(repoGiven ?? process.cwd()), "default");

    if (main === undefined) return yield* refuse(`${repoGiven ?? process.cwd()} is not in a jj repo with a default workspace`);
    // A snapshot first: the files the workers wrote since the last jj command.
    const status$ = jj(main, ["status"]);

    if (!status$.ok) return yield* refuse(why(status$));
    const listed = jj(main, ["log", "--no-graph", "-r", "@", "-T", 'self.diff().files().map(|f| f.source().path() ++ "\\n" ++ f.path() ++ "\\n").join("")'], true);

    if (!listed.ok) return yield* refuse(why(listed));
    const mine = [...new Set(listed.stdout.split("\n").filter((p) => p !== "" && inLane(p, lane)))].sort();

    if (mine.length === 0) return yield* refuse(`nothing in the shared working copy's @ is in ${worker}'s lane (${lane.join(", ")})`);
    const cut = jj(main, ["--config", 'ui.editor="true"', "split", "-r", "@", "-m", message, ...mine.map((p) => `root-file:${literal(p)}`)]);

    if (!cut.ok) return yield* refuse(why(cut));
    const made = changes(main, "@-")?.[0];
    const said = made === undefined ? JSON.stringify(message) : described(made);

    const fault = save(machine, root, raw, undefined, [
      event(machine, raw, worker, "integrated", `Split ${worker}'s lane out of the shared working copy as ${said} (${mine.length} file(s)).`),
    ]);

    if (fault !== undefined) return yield* Effect.fail(fault);
    out.out(`split ${worker}: ${said}: ${mine.join(", ")}\n`);

    return 0;
  });
}

// -- list ---------------------------------------------------------------------------------------

function clock(seconds: number): string {
  return stampOf(new Date(seconds * 1000)).slice(11, 16);
}

function list(machine: Machine, root: string, raw: JsonObject): Effect.Effect<number, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const all = recorded(raw);

    if (all.length === 0 && shared(raw)) {
      out.out(`no workspace: this fleet's workers share one working copy; \`fleet ws ${root} split WORKER -m MESSAGE\` integrates each\n`);

      return 0;
    }

    if (all.length === 0) {
      out.out(`no workspace: \`fleet ws ${root} add NAME\` makes one per worker\n`);

      return 0;
    }

    const seen = workerActivity(root, machine.config, raw);
    out.out("workspaces, as each was last snapshotted:\n");

    for (const r of all) {
      const row = agentRow(raw, r.agent);
      const status = row === undefined ? "no row" : (asString(row["status"]) ?? "?");
      const last = seen.get(r.agent);
      const when = last === undefined ? "" : `, seen ${clock(last.at)}${last.tool === null ? "" : ` (${last.tool})`}`;
      out.out(`  ${r.id}  worker ${r.agent} ${status}${when}  ${r.path}${isDir(r.path) ? "" : " (gone)"}\n`);
      const tip = changes(r.repo, `${literal(r.id)}@`)?.[0];

      if (tip === undefined) {
        out.out("    jj no longer knows this workspace\n");
        continue;
      }

      const ahead = changes(r.repo, unintegratedRevset(r.id, tip.change)) ?? [];
      const conflicted = tip.conflict || ahead.some((c) => c.conflict);
      const lead = ahead.length === 0 ? "nothing ahead of the stack" : `${ahead.length} change(s) ahead of the stack: ${ahead.map(described).join("; ")}`;
      out.out(`    @ ${described(tip)}${conflicted ? ", conflicted" : ""}; ${lead}\n`);
      const lane = asArray(row?.["lane"])?.flatMap((e) => asString(e) ?? []) ?? [];
      const strayed = lane.length === 0 || ahead.length === 0 ? [] : outsideLane(r.repo, unintegratedRevset(r.id, tip.change), lane);

      if (strayed.length > 0) {
        out.out(`    outside its lane (${lane.join(", ")}): ${strayed.join(", ")}: stop it and handle these edits before anything else runs on them\n`);
      }
    }

    return 0;
  });
}

/** Whether a repository path is in a lane: the entry itself, under it, or matched by it as a glob (the
 * lane's own glob rule, the one overlap is read by). */
export function inLane(path: string, lane: readonly string[]): boolean {
  return lane.some((entry) => laneMatches(path, entry));
}

/** The files the commits of `revset` touch that are in none of the lane's entries. */
function outsideLane(repo: string, revset: string, lane: readonly string[]): string[] {
  const touched = jj(repo, ["log", "--no-graph", "-r", revset, "-T", 'self.diff().files().map(|f| f.path() ++ "\\n").join("")'], true);

  if (!touched.ok) return [];

  return [...new Set(touched.stdout.split("\n").filter((p) => p !== "" && !inLane(p, lane)))].sort();
}

// -- prune --------------------------------------------------------------------------------------

/** Whether the directory at `path` is a secondary workspace of the repo whose default workspace is `repo`:
 * its `.jj/repo` is a file that points at the repo's store. */
function belongs(path: string, repo: string): boolean {
  const pointer = readText(join(path, ".jj", "repo"));

  if (pointer === undefined || isDir(join(path, ".jj", "repo"))) return false;
  const target = pointer.trim();
  const store = isAbsolute(target) ? target : resolve(join(path, ".jj"), target);

  return resolvePath(store) === resolvePath(join(repo, ".jj", "repo"));
}

/** Snapshot the workspace's files (a stale one is updated first, keeping its unsnapshotted files in a
 * copy of its change); why not, when that fails. */
function snapshot(path: string): string | undefined {
  const status = jj(path, ["status"]);

  if (status.ok) return undefined;

  if (!status.stderr.includes("stale")) return why(status);
  const update = jj(path, ["workspace", "update-stale"]);

  return update.ok ? undefined : why(update);
}

/** Why `r` must stay, or undefined when it may go. */
function keepBecause(raw: JsonObject, r: Recorded): string | undefined {
  const row = agentRow(raw, r.agent);
  const status = asString(row?.["status"]);

  if (status !== undefined && LIVE.has(status)) return `its worker ${r.agent} is ${status}`;
  const known = (workspaceNames(r.repo) ?? []).includes(r.id);

  if (isDir(r.path)) {
    const at = known ? workspaceRoot(r.repo, r.id) : undefined;

    if (at === undefined || resolvePath(at) !== resolvePath(r.path) || !belongs(r.path, r.repo) || resolvePath(r.path) === resolvePath(r.repo)) {
      return `${r.path} is not jj workspace ${r.id} of ${r.repo}; nothing there is touched`;
    }

    const failed = snapshot(r.path);

    if (failed !== undefined) return `jj could not snapshot it: ${failed}`;
  }

  if (!known) return undefined;
  const tip = changes(r.repo, `${literal(r.id)}@`)?.[0];
  const ahead = tip === undefined ? undefined : changes(r.repo, unintegratedRevset(r.id, tip.change));

  if (ahead === undefined) return "jj could not say what it holds";

  if (ahead.length > 0) return `${ahead.length} change(s) not in the stack: ${ahead.map(described).join("; ")}`;

  return undefined;
}

function prune(machine: Machine, root: string, raw: JsonObject, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const apply = argv.includes("--apply");

    if (argv.some((a) => a !== "--apply" && a !== "--dry-run") || (apply && argv.includes("--dry-run"))) return yield* refuse(USAGE);
    const going: Recorded[] = [];
    let kept = 0;

    for (const r of recorded(raw)) {
      const because = keepBecause(raw, r);

      if (because === undefined) {
        going.push(r);
        continue;
      }

      kept += 1;
      out.err(`ws: kept ${r.id}: ${because}\n`);
    }

    if (!apply) {
      for (const r of going) out.out(`would prune ${r.id}: forget the workspace and delete ${r.path}; its changes are in the stack\n`);
      out.out(going.length === 0 ? "nothing to prune\n" : `dry run, nothing deleted: \`fleet ws ${root} prune --apply\` does it\n`);

      return kept > 0 ? 1 : 0;
    }

    const stamp = stampOf(machine.now());
    const events: JsonObject[] = [];
    const gone = new Set<string>();

    for (const r of going) {
      if ((workspaceNames(r.repo) ?? []).includes(r.id)) {
        const forgot = jj(r.repo, ["workspace", "forget", r.id]);

        if (!forgot.ok) {
          kept += 1;
          out.err(`ws: kept ${r.id}: ${why(forgot)}\n`);
          continue;
        }
      }

      if (isDir(r.path)) rmSync(r.path, { recursive: true, force: true });
      gone.add(r.id);
      events.push(event(machine, raw, r.agent, "integrated", `Workspace ${r.id} pruned: its changes are in the stack; ${r.path} deleted.`));
      out.out(`pruned ${r.id}: ${r.path} deleted\n`);
    }

    if (gone.size === 0) {
      out.out("nothing to prune\n");

      return kept > 0 ? 1 : 0;
    }

    const workspaces = (asArray(raw["workspaces"]) ?? []).map((item) => {
      const row = asObject(item);
      const id = asString(row?.["id"]);

      return row !== undefined && id !== undefined && gone.has(id) && row["status"] !== "pruned" ? { ...row, status: "pruned", pruned: stamp } : item;
    });

    const fault = save(machine, root, raw, workspaces, events);

    if (fault !== undefined) return yield* Effect.fail(fault);

    return kept > 0 ? 1 : 0;
  });
}

function run(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const [dir, command, ...rest] = argv;

    if (dir === undefined || command === undefined) return yield* refuse(USAGE);
    const root = resolvePath(dir);
    const raw = load(root);

    if (raw instanceof Refusal) return yield* Effect.fail(raw);

    if (command === "add") return yield* add(machine, root, raw, rest);

    if (command === "list" && rest.length === 0) return yield* list(machine, root, raw);

    if (command === "prune") return yield* prune(machine, root, raw, rest);

    if (command === "split") return yield* split(machine, root, raw, rest);

    return yield* refuse(USAGE);
  });
}

/** Run `fleet ws` with `argv` (after `ws`); the exit code. */
export function wsCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv).pipe(Effect.catch(exitOf));
  });
}
