/**
 * `fleet preview DIR …`: the fleet's live UI preview, every worker's in-progress edits in one page before
 * any of it is integrated.
 *
 * - `start [--cmd C] [--port N] [--setup C] [--repo PATH]`: the combined preview. A jj workspace `preview`
 *   beside the repo (made once, recorded in the ledger as the fleet's preview, never a worker's) whose @ is
 *   the merge of the included workers' working copies on the stack; the repo's dev server started there in
 *   the background; and the updater, which keeps the merge and its files current every `FLEET_PREVIEW_S`
 *   seconds. The hub serves it at `/f/<fleet>/preview/`.
 * - `start --per-worker WORKER [--cmd C] [--port N] [--setup C]`: a dev server in that worker's own
 *   workspace, at `/f/<fleet>/preview/<worker>/`. No merge.
 * - `status`: the address, the workers and their commits, the conflicts, the dev servers' last error.
 * - `include WORKER` / `exclude WORKER`: take a worker into the merge, or out of it.
 * - `stop [--per-worker WORKER]`: stop the dev servers and the updater (or that worker's server). The
 *   workspace stays for the next start; `fleet ws DIR prune` removes it once nothing runs there.
 * - `set --cmd C [--setup C]`: the dev command (and install) the fleet's previews run, in the ledger.
 * - `updater`: the updater's loop, which `start` runs in the background.
 *
 * The command is `--cmd`, else the ledger's, else `<package manager> run dev` when package.json has a
 * `dev` script; `{port}` and `{base}` in it are filled in, and Vite is told its port, host and base.
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";

import { stampOf } from "../clock.ts";
import { PreviewError, Refusal } from "../errors.ts";
import { exists, isDir, readText, resolvePath } from "../files.ts";
import { Out } from "../io.ts";
import { asArray, asObject, asString, type Json, type JsonObject } from "../json.ts";
import { upAllSync } from "../page/probe.ts";
import { isRunning, lastError, freePort, logTail, planCommand, fill, runSetup, setupCommand, startDetached, startServer, stopGroup, tail } from "../preview/devserver.ts";
import { readCopies, stackOf } from "../preview/merge.ts";
import { logDir, readRecord, updateRecord, type DevServer, type PreviewRecord, type WorkerServer } from "../preview/record.ts";
import { candidates, everyMs, freshMemory, included, lookOnce, pick, runUpdater, standing } from "../preview/updater.ts";
import { jj, why, workspaceNames, workspaceRoot } from "../ws/jj.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";
import { belongs, event, load, save } from "./ws.ts";

const USAGE =
  "usage: fleet preview DIR start [--cmd C] [--port N] [--setup C] [--repo PATH] [--per-worker WORKER] | status | include WORKER | exclude WORKER | " +
  "stop [--per-worker WORKER] | set --cmd C [--setup C]";

/** The jj workspace the combined preview runs in. */
const PREVIEW = "preview";

/** The CLI's entry point: the updater runs it as its own process. */
const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));

/** The environment a preview's processes take from the command's own (a test's registry, its interval). */
const PASSED = ["FLEET_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "FLEET_PREVIEW_S", "FLEET_DISCOVER", "TZ"] as const;

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "preview", reason }));
}

/** The values after each of `flags` in `argv`, and what is left. */
function options(argv: readonly string[], flags: readonly string[]): readonly [Map<string, string>, string[]] | PreviewError {
  const found = new Map<string, string>();
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";

    if (!flags.includes(a)) {
      rest.push(a);
      continue;
    }

    const value = argv[i + 1];

    if (value === undefined) return new PreviewError({ reason: `${a} takes a value` });
    found.set(a, value);
    i += 1;
  }

  return [found, rest];
}

function passedEnv(machine: Machine): Record<string, string> {
  return Object.fromEntries(PASSED.flatMap((k) => (machine.env(k) === undefined ? [] : [[k, machine.env(k) ?? ""]])));
}

/** The ledger's `preview` entry: the dev command and install the fleet recorded. */
/** A dev command and its install, as given or recorded. */
interface Commands {
  readonly cmd: string | undefined;
  readonly setup: string | undefined;
}

function recordedCommand(raw: JsonObject): Commands {
  const entry = asObject(raw["preview"]);

  return { cmd: asString(entry?.["cmd"]), setup: asString(entry?.["setup"]) };
}

/** The ledger's row for the preview's workspace, when it has an active one. */
function previewRow(raw: JsonObject): JsonObject | undefined {
  return (asArray(raw["workspaces"]) ?? []).flatMap((w) => objectOf(w)).find((w) => w["kind"] === "preview" && w["status"] !== "pruned");
}

/** Whether a dev server runs. */
function running(server: DevServer | null): server is DevServer & { readonly pid: number } {
  return server !== null && server.pid !== null && isRunning(server.pid);
}

/** The fleet's address on the hub, and its name. */
function served(machine: Machine, root: string): { readonly fleet: string; readonly url: string } | undefined {
  const entry = machine.registry.find(root);

  return entry === undefined ? undefined : { fleet: entry.id, url: entry.url };
}

/** How a dev server came up: it answers, it is still starting, or its process is gone. */
type Came = "up" | "starting" | "exited";

/** Wait until something answers on the server's port (at most `seconds`), or its process is gone. */
function waitUp(server: DevServer, seconds: number): Came {
  const deadline = Date.now() + seconds * 1000;

  for (;;) {
    if (upAllSync([`http://127.0.0.1:${server.port}/`])[0] === true) return "up";

    if (!isRunning(server.pid)) return "exited";

    if (Date.now() >= deadline) return "starting";
    Bun.sleepSync(250);
  }
}

/** What `start` says after the server's own line: nothing when it answers; else why not, from what this
 * start appended to its log (from character `since`). */
function cameLine(came: Came, server: DevServer, root: string, since: number): string | undefined {
  if (came === "up") return undefined;

  if (came === "starting") return `preview: nothing answers on port ${server.port} yet; \`fleet preview ${root} status\` shows the dev server's log\n`;
  const log = (readText(server.log) ?? "").slice(since).slice(-65536);

  return `preview: the dev server exited before it answered on port ${server.port}; ${server.log} ${lastError(log) === null ? "ends" : "says"}:\n${indent(lastError(log) ?? tail(log, 8))}\n`;
}

/** The state on the server's line in `start`'s output. */
function cameNote(came: Came): string {
  return came === "up" ? "" : came === "starting" ? ", not answering yet" : ", exited at start";
}

/** A dev server for `dir`: installed when it needs it, its command planned, filled and started. */
function launch(
  machine: Machine,
  dir: string,
  base: string,
  log: string,
  given: Commands & { readonly port: string | undefined },
  recorded: Commands,
): DevServer | PreviewError {
  const planned = planCommand(dir, given.cmd, recorded.cmd);

  if (planned instanceof PreviewError) return planned;
  const port = given.port === undefined ? freePort() : Number(given.port);

  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return new PreviewError({ reason: "a port is a number from 1 to 65535" });

  if (given.port !== undefined && upAllSync([`http://127.0.0.1:${port}/`])[0] === true) return new PreviewError({ reason: `port ${port} is taken; give another, or leave --port out for a free one` });
  const setup = setupCommand(dir, given.setup ?? recorded.setup);

  if (setup !== undefined) {
    const failed = runSetup(dir, setup, log);

    if (failed !== undefined) return new PreviewError({ reason: failed });
  }

  const ready = fill(dir, planned.template, port, base);
  const pid = startServer(dir, ready.cmd, port, log, passedEnv(machine));

  if (pid instanceof PreviewError) return pid;

  return { cmd: ready.cmd, port, pid, base: ready.base, path: dir, log, started: stampOf(machine.now()) };
}

// -- start --------------------------------------------------------------------------------------

/** The preview's workspace: the recorded one, checked, else a new one at the stack; its row and path. */
function previewWorkspace(raw: JsonObject, repoGiven: string | undefined, machine: Machine): { readonly row: JsonObject; readonly made: boolean } | PreviewError {
  const no = (reason: string): PreviewError => new PreviewError({ reason });
  const row = previewRow(raw);

  if (row !== undefined) {
    const path = asString(row["path"]) ?? "";
    const repo = asString(row["repo"]) ?? "";

    if (!isDir(path) || !belongs(path, repo) || resolvePath(workspaceRoot(repo, asString(row["id"]) ?? PREVIEW) ?? "") !== resolvePath(path)) {
      return no(`${path} is no longer the preview's jj workspace of ${repo}; prune it (\`fleet ws <dir> prune\`) and start again`);
    }

    return { row, made: false };
  }

  const fromWorker = (asArray(raw["workspaces"]) ?? []).map((w) => asString(asObject(w)?.["repo"])).find((r) => r !== undefined);
  const where = repoGiven ?? fromWorker ?? process.cwd();
  const main = workspaceRoot(resolvePath(where), "default");

  if (main === undefined) return no(`${where} is not in a jj repo with a default workspace; give --repo PATH`);

  if ((workspaceNames(main) ?? []).includes(PREVIEW)) return no(`the repo already has a workspace called ${PREVIEW} that this fleet did not record; forget it (\`jj workspace forget ${PREVIEW}\`) or remove it first`);
  const path = join(dirname(main), `${basename(main)}-${PREVIEW}`);

  if (exists(path)) return no(`${path} already exists`);
  const copies = readCopies(main);
  const head = copies instanceof PreviewError ? undefined : copies.get("default");

  if (head === undefined) return no(`jj could not read the stack in ${main}`);
  const stack = stackOf(head);
  const made = jj(main, ["workspace", "add", path, "-r", stack, "--name", PREVIEW]);

  if (!made.ok) return no(why(made));
  const change = jj(main, ["log", "--no-graph", "-r", stack, "-T", "change_id"], true).stdout.trim();

  return { row: { id: PREVIEW, kind: "preview", agent: null, path, repo: main, base: change, added: stampOf(machine.now()), status: "active" }, made: true };
}

function startCombined(machine: Machine, root: string, raw: JsonObject, given: Map<string, string>): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (raw["workspace_mode"] === "shared") {
      return yield* refuse("this fleet's workers share one working copy (`set --workspaces shared`): every worker's edits are already in it, so a dev server run there shows them all");
    }

    const at = served(machine, root);

    if (at === undefined) return yield* refuse(`${root} is not being served: the preview is reached through the hub at /f/<fleet>/preview/; \`fleet serve ${root}\` first`);
    const before = readRecord(root);

    if (before !== undefined && running(before.server) && before.updater !== null && isRunning(before.updater)) {
      return yield* refuse(`the preview already runs at ${at.url}preview/ (dev server pid ${before.server.pid}, updater pid ${before.updater}): \`fleet preview ${root} status\`, or stop it first`);
    }

    const ws = previewWorkspace(raw, given.get("--repo"), machine);

    if (ws instanceof PreviewError) return yield* refuse(ws.reason);
    const path = asString(ws.row["path"]) ?? "";
    const repo = asString(ws.row["repo"]) ?? "";

    if (ws.made) {
      const fault = save(machine, root, raw, [...(asArray(raw["workspaces"]) ?? []), ws.row], [event(machine, raw, null, "note", `Workspace ${PREVIEW} for the fleet's preview at ${path}.`)]);

      if (fault !== undefined) return yield* Effect.fail(fault);
    }

    updateRecord(root, (now) => ({
      fleet: at.fleet,
      workspace: PREVIEW,
      path,
      repo,
      server: now?.server ?? null,
      updater: now?.updater ?? null,
      include: now?.include ?? [],
      exclude: now?.exclude ?? [],
      merged: now?.merged ?? [],
      stack: now?.stack ?? null,
      commit: now?.commit ?? null,
      conflicts: now?.conflicts ?? [],
      error: null,
      updated: now?.updated ?? null,
      workers: now?.workers ?? [],
    }));

    // The first merge before the dev server reads the files.
    const first = lookOnce(machine, root, freshMemory());
    let server = first?.server ?? null;

    const log = join(logDir(root), "combined.log");
    const since = (readText(log) ?? "").length;

    if (!running(server)) {
      const started = launch(machine, path, `/f/${at.fleet}/preview/`, log, { cmd: given.get("--cmd"), port: given.get("--port"), setup: given.get("--setup") }, recordedCommand(raw));

      if (started instanceof PreviewError) return yield* refuse(started.reason);
      server = started;
    }

    let updater = first?.updater ?? null;

    if (updater === null || !isRunning(updater)) {
      const pid = startDetached([process.execPath, MAIN, "preview", root, "updater"], root, join(logDir(root), "updater.log"), passedEnv(machine));

      if (pid instanceof PreviewError) {
        stopGroup(server.pid);

        return yield* refuse(pid.reason);
      }

      updater = pid;
    }

    const kept = server;
    const record = updateRecord(root, (now) => (now === undefined ? undefined : { ...now, server: kept, updater }));
    const came = waitUp(kept, Number(machine.env("FLEET_PREVIEW_WAIT_S") ?? 30));
    const workers = (record?.merged ?? []).map((m) => m.id);
    const address = `${at.url}preview/`;
    const fresh = readLedger(root) ?? raw;
    const text = `Preview started at ${address}: ${workers.length === 0 ? "no worker yet, the stack alone" : `workers ${workers.join(", ")} merged`} in workspace ${PREVIEW} (${path}), dev server on port ${kept.port}.`;
    const fault = save(machine, root, fresh, undefined, [event(machine, fresh, null, "note", text)]);

    if (fault !== undefined) return yield* Effect.fail(fault);
    out.out(`preview: ${address}\n`);
    out.out(`  dev server: ${kept.cmd} (pid ${kept.pid}, port ${kept.port}${cameNote(came)}), log ${kept.log}\n`);
    out.out(`  updater: pid ${updater}, every ${everyMs(machine) / 1000} s; merged: ${workers.length === 0 ? "the stack alone" : workers.join(", ")}\n`);

    const said = cameLine(came, kept, root, since);

    if (said !== undefined) out.err(said);

    if ((record?.conflicts.length ?? 0) > 0) out.err(`preview: the merge has conflicts: ${conflictLine(record?.conflicts ?? [])}\n`);

    return came === "exited" ? 1 : 0;
  });
}

/** `value` as a list of one object, or none. */
function objectOf(value: Json): JsonObject[] {
  const o = asObject(value);

  return o === undefined ? [] : [o];
}

function readLedger(root: string): JsonObject | undefined {
  const raw = load(root);

  return raw instanceof Refusal ? undefined : raw;
}

function startPerWorker(machine: Machine, root: string, raw: JsonObject, worker: string, given: Map<string, string>): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const at = served(machine, root);

    if (at === undefined) return yield* refuse(`${root} is not being served: the preview is reached through the hub; \`fleet serve ${root}\` first`);
    const cand = candidates(raw).find((c) => c.id === worker || c.workspace === worker);

    if (cand === undefined) return yield* refuse(`${worker} has no active workspace in this fleet (\`fleet ws ${root} list\`)`);
    const before = readRecord(root)?.workers.find((w) => w.worker === cand.id) ?? null;

    if (running(before)) return yield* refuse(`${cand.id}'s preview already runs at ${at.url}preview/${cand.id}/ (pid ${before.pid}); stop it first`);
    const log = join(logDir(root), `${cand.id}.log`);
    const since = (readText(log) ?? "").length;
    const started = launch(machine, cand.path, `/f/${at.fleet}/preview/${cand.id}/`, log, { cmd: given.get("--cmd"), port: given.get("--port"), setup: given.get("--setup") }, recordedCommand(raw));

    if (started instanceof PreviewError) return yield* refuse(started.reason);
    const server: WorkerServer = { ...started, worker: cand.id };

    updateRecord(root, (now) => {
      const base: PreviewRecord = now ?? {
        fleet: at.fleet,
        workspace: PREVIEW,
        path: "",
        repo: "",
        server: null,
        updater: null,
        include: [],
        exclude: [],
        merged: [],
        stack: null,
        commit: null,
        conflicts: [],
        error: null,
        updated: null,
        workers: [],
      };

      return { ...base, workers: [...base.workers.filter((w) => w.worker !== cand.id), server] };
    });

    const came = waitUp(server, Number(machine.env("FLEET_PREVIEW_WAIT_S") ?? 30));
    const address = `${at.url}preview/${cand.id}/`;
    const fault = save(machine, root, raw, undefined, [event(machine, raw, cand.id, "note", `Preview of ${cand.id}'s workspace alone at ${address}, dev server on port ${server.port}.`)]);

    if (fault !== undefined) return yield* Effect.fail(fault);
    out.out(`preview of ${cand.id}: ${address}\n`);
    out.out(`  dev server: ${server.cmd} (pid ${server.pid}, port ${server.port}${cameNote(came)}) in ${cand.path}, log ${server.log}\n`);
    const said = cameLine(came, server, root, since);

    if (said !== undefined) out.err(said);

    return came === "exited" ? 1 : 0;
  });
}

// -- status -------------------------------------------------------------------------------------

function conflictLine(conflicts: readonly { readonly path: string; readonly workers: readonly string[] }[]): string {
  return conflicts.map((c) => `${c.path} (${c.workers.length === 0 ? "the stack" : c.workers.join(", ")})`).join(", ");
}

function serverLine(s: DevServer): string {
  const on = running(s);
  const up = on && upAllSync([`http://127.0.0.1:${s.port}/`])[0] === true;

  return `${on ? `pid ${s.pid}` : "stopped"}, port ${s.port}${on ? (up ? ", answering" : ", not answering") : ""}: ${s.cmd}`;
}

function status(machine: Machine, root: string, raw: JsonObject): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const record = readRecord(root);

    if (record === undefined) {
      out.out(`no preview: \`fleet preview ${root} start\` makes one\n`);

      return 0;
    }

    const at = served(machine, root);
    const base = at === undefined ? `/f/${record.fleet}/` : at.url;
    const updater = record.updater !== null && isRunning(record.updater);

    if (record.path !== "") {
      out.out(`preview: ${base}preview/ (${running(record.server) ? "running" : "stopped"})\n`);
      out.out(`  workspace ${record.workspace} at ${record.path}, @ ${record.commit?.slice(0, 12) ?? "?"}${record.conflicts.length > 0 ? " (conflicted)" : ""}, merged ${record.updated ?? "never"}\n`);

      if (record.server !== null) out.out(`  dev server: ${serverLine(record.server)}\n`);
      out.out(`  updater: ${updater ? `pid ${record.updater}, every ${everyMs(machine) / 1000} s` : "not running"}\n`);
      const all = candidates(raw);

      for (const c of all) {
        const merged = record.merged.find((m) => m.id === c.id);
        out.out(`  ${included(c, record) ? "[x]" : "[ ]"} ${c.id} (${standing(c, record)})${merged === undefined ? "" : ` at ${merged.commit.slice(0, 12)} (change ${merged.change.slice(0, 8)})`}\n`);
      }

      if (all.length === 0) out.out("  no worker has a workspace: the preview shows the stack alone\n");

      if (record.conflicts.length > 0) out.out(`  conflicts: ${conflictLine(record.conflicts)}\n`);

      if (record.error !== null) out.out(`  updater's last error: ${record.error}\n`);
      const error = record.server === null ? null : lastError(logTail(record.server.log));

      if (error !== null) out.out(`  dev server's last error (${record.server?.log ?? ""}):\n${indent(error)}\n`);
      else if (record.server !== null && !running(record.server)) out.out(`  its log ends:\n${indent(tail(logTail(record.server.log), 8))}\n`);
    }

    for (const w of record.workers) {
      out.out(`preview of ${w.worker}: ${base}preview/${w.worker}/ (${running(w) ? "running" : "stopped"})\n`);
      out.out(`  dev server: ${serverLine(w)} in ${w.path}\n`);
      const error = lastError(logTail(w.log));

      if (error !== null) out.out(`  dev server's last error (${w.log}):\n${indent(error)}\n`);
    }

    return 0;
  });
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

// -- include, exclude, stop, set ----------------------------------------------------------------

function choose(machine: Machine, root: string, raw: JsonObject, worker: string | undefined, include: boolean): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (worker === undefined) return yield* refuse(USAGE);
    const done = pick(root, raw, worker, include);

    if (done instanceof PreviewError) return yield* refuse(done.reason);
    out.out(`${worker} ${include ? "is in" : "is out of"} the preview from its next look (every ${everyMs(machine) / 1000} s)\n`);

    return 0;
  });
}

function stop(machine: Machine, root: string, raw: JsonObject, worker: string | undefined): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const record = readRecord(root);

    if (record === undefined) return yield* refuse("there is no preview to stop");

    if (worker !== undefined) {
      const w = record.workers.find((x) => x.worker === worker);

      if (w === undefined) return yield* refuse(`no preview of ${worker}: \`fleet preview ${root} status\` lists them`);
      stopGroup(w.pid);
      updateRecord(root, (now) => (now === undefined ? undefined : { ...now, workers: now.workers.map((x) => (x.worker === worker ? { ...x, pid: null } : x)) }));
      out.out(`stopped ${worker}'s preview (port ${w.port})\n`);

      return 0;
    }

    // The updater first, so it does not look again while the servers go.
    updateRecord(root, (now) => (now === undefined ? undefined : { ...now, updater: null }));
    stopGroup(record.updater);
    stopGroup(record.server?.pid ?? null);

    for (const w of record.workers) stopGroup(w.pid);

    updateRecord(root, (now) =>
      now === undefined ? undefined : { ...now, updater: null, server: now.server === null ? null : { ...now.server, pid: null }, workers: now.workers.map((x) => ({ ...x, pid: null })) },
    );

    const fault = save(machine, root, raw, undefined, [event(machine, raw, null, "note", `Preview stopped; its workspace stays at ${record.path || "(none)"} for the next start.`)]);

    if (fault !== undefined) return yield* Effect.fail(fault);
    out.out(`stopped the preview: dev server${record.workers.length > 0 ? "s" : ""} and updater; workspace ${record.workspace} stays at ${record.path} (\`fleet ws ${root} prune\` removes it)\n`);

    return 0;
  });
}

function setCommand(machine: Machine, root: string, raw: JsonObject, given: Map<string, string>, rest: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const cmd = given.get("--cmd");
    const setup = given.get("--setup");

    if (rest.length > 0 || (cmd === undefined && setup === undefined)) return yield* refuse(USAGE);
    const before = asObject(raw["preview"]) ?? {};
    const given$ = [["cmd", cmd] as const, ["setup", setup] as const].flatMap(([key, value]) => (value === undefined ? [] : [[key, value] as const]));
    const entry: JsonObject = Object.fromEntries([...Object.entries(before), ...given$]);
    const fault = save(machine, root, { ...raw, preview: entry }, undefined, []);

    if (fault !== undefined) return yield* Effect.fail(fault);
    out.out(`the fleet's previews run ${asString(entry["cmd"]) ?? "the repo's dev script"}${asString(entry["setup"]) === undefined ? "" : `, after ${asString(entry["setup"]) ?? ""}`}\n`);

    return 0;
  });
}

// -- dispatch -----------------------------------------------------------------------------------

function run(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const [dir, command, ...args] = argv;

    if (dir === undefined || command === undefined) return yield* refuse(USAGE);
    const root = resolvePath(dir);
    const raw = load(root);

    if (raw instanceof Refusal) return yield* refuse(raw.reason);
    const parsed = options(args, ["--cmd", "--port", "--setup", "--repo", "--per-worker"]);

    if (parsed instanceof PreviewError) return yield* refuse(`${parsed.reason}: ${USAGE}`);
    const [given, rest] = parsed;
    const worker = given.get("--per-worker");

    if (command === "start" && rest.length === 0) return yield* worker === undefined ? startCombined(machine, root, raw, given) : startPerWorker(machine, root, raw, worker, given);

    if (command === "status" && args.length === 0) return yield* status(machine, root, raw);

    if ((command === "include" || command === "exclude") && args.length === 1) return yield* choose(machine, root, raw, args[0], command === "include");

    if (command === "stop" && rest.length === 0 && [...given.keys()].every((k) => k === "--per-worker")) return yield* stop(machine, root, raw, worker);

    if (command === "set") return yield* setCommand(machine, root, raw, given, rest);

    return yield* refuse(USAGE);
  });
}

/** Run `fleet preview` with `argv` (after `preview`); the exit code. `updater` runs the loop until stopped. */
export function previewCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;
    const [dir, command, ...rest] = argv;

    if (dir !== undefined && command === "updater" && rest.length === 0) {
      const root = resolvePath(dir);

      return yield* Effect.promise(() => runUpdater(machine, root));
    }

    return yield* run(machine, argv).pipe(Effect.catch(exitOf));
  });
}

