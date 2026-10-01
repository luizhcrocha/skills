/**
 * `fleet ws DIR …`: one jj workspace per worker, recorded in the ledger (`workspaces[]`).
 *
 * - `add NAME [-r BASE] [--agent ID] [--repo PATH]`: `jj workspace add <repo>-NAME -r BASE --name NAME`
 *   beside the repo's default workspace (the one `--repo`, else the cwd, is in); BASE defaults to `@-`
 *   there. Records the worker (`--agent`, else NAME), the path and the base change, and prints the path
 *   for the brief.
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
import { decodeLedger } from "../ledger/model.ts";
import { validate } from "../ledger/validate.ts";
import { cliLookups } from "../page/lookups.ts";
import { pageHtml, readTemplate, writePage } from "../page/render.ts";
import { view } from "../page/view.ts";
import { changes, jj, literal, unintegratedRevset, why, workspaceNames, workspaceRoot, type Change } from "../ws/jj.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";

const USAGE = "usage: fleet ws DIR add NAME [-r BASE] [--agent ID] [--repo PATH] | list | prune [--apply | --dry-run]";

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

/** The ledger in DIR as JSON, checked as every command checks it. */
function load(root: string): JsonObject | Refusal {
  const text = readText(join(root, "state.json"));

  if (text === undefined) return new Refusal({ speaker: "ws", reason: `no state.json in ${root}; run \`fleet state ${root} init\` first` });
  const raw = Option.getOrUndefined(parseObject(text));
  const ledger = raw === undefined ? new Refusal({ speaker: "ws", reason: `${root}/state.json is not a JSON object` }) : decodeLedger(raw);

  return ledger instanceof Refusal ? ledger : (raw ?? {});
}

/** Write the ledger with `workspaces` and these events, stamped, and render the page. */
function save(machine: Machine, root: string, raw: JsonObject, workspaces: readonly Json[], events: readonly JsonObject[]): Refusal | undefined {
  const stamp = stampOf(machine.now());
  const next: JsonObject = { ...raw, workspaces: [...workspaces], events: [...(asArray(raw["events"]) ?? []), ...events], updated: stamp };
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

function add(machine: Machine, root: string, raw: JsonObject, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const [base = "@-", a] = option(argv, "-r", "--revision");
    const [agentGiven, b] = option(a, "--agent");
    const [repoGiven, rest] = option(b, "--repo");
    const name = rest[0];

    if (rest.length !== 1 || name === undefined) return yield* refuse(USAGE);

    if (!NAME.test(name) || name === "default") return yield* refuse(`a workspace name is letters, digits, '_', '.' or '-', and not 'default': ${JSON.stringify(name)}`);
    const agent = agentGiven ?? name;
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
    out.out(`workspace ${name} for ${agent} at ${path}, on ${described(from)}\n`);
    out.out(`brief: your working copy is ${path}; edit, build and describe your changes there only. The coordinator rebases them onto the stack and prunes the workspace.\n`);

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
    }

    return 0;
  });
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
