/**
 * `fleet turn [DIR]`: whether this fleet holds the landing turn, read from the manager's landing queue
 * (its `landings` milestone: one step per landing, `--agent <fleet>`, the current one holds the turn).
 * Exit 0: the turn is this fleet's, or no manager is present (a fleet then lands on its own word), or the
 * session runs no fleet. Exit 1: a manager is present and the turn is not this fleet's, or only a folder that
 * can be behind the cloud says it is. Without DIR the
 * fleet is the one the Claude Code session running the command serves (its registry entry's pid is
 * among the command's parents), else the one $FLEET_DIR names, so `land-check` asks it without being told
 * the fleet. DIR and $FLEET_DIR may name a team moved to the cloud (its folder holds cloud.json); the
 * plugin's push gate sets $FLEET_DIR to the moved folder its session serves.
 *
 * A manager moved to the cloud is read from its folder, which the machine's host service exports from the cloud. It is
 * present while its ledger's status is running and a session of its runs (registry.ts `movedManagerAway`):
 * no registry entry of its goes away when it stops or its session closes, and then the turn is every fleet's.
 *
 * A moved manager's queue is read from the cloud, not its folder: the folder is the host's export and takes a moment
 * to follow, so the turn the manager just gave or took back would read wrong there. The read is one program, through
 * fleet-run, which only reads. It gets $FLEET_TURN_WAIT_S (10 s, at most 15: the plugin's push gate gives this command
 * 20 s inside a 30 s hook, and fails open past them). When it brings no queue (the host down, the link down, a backlog
 * in the host's outbox, no answer) the folder decides only a no: a folder that says this fleet holds the turn can be
 * the turn the manager just took back, so the command refuses and says why. A machine cut off from the cloud cannot
 * push anyway, and no flag lifts this: an agent could set one itself.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Refusal } from "../errors.ts";
import { resolvePath } from "../files.ts";
import { Out } from "../io.ts";
import { asArray, asNumber, asObject, asString, parseObject, type Json, type JsonObject } from "../json.ts";
import { LANDINGS } from "../ledger/commands.ts";
import { decodeLedger, type Step } from "../ledger/model.ts";
import { ancestry } from "../procs.ts";
import { movedTeam, readObject, type Entry } from "../registry.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";

export const USAGE = "usage: fleet turn [DIR]";

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "turn", reason }));
}

/** How long a moved manager's queue may take to read from the cloud, by default. */
const WAIT_S = 10;

/** The most it may take: the push gate kills this command at 20 s, and that fails open, so a read gives up first. */
const WAIT_MAX_S = 15;

/** The program that reads a moved manager's landing queue. */
const QUEUE_PROGRAM = `return records.read({ kind: "milestone", key: "${LANDINGS}" });\n`;

/** The program that takes a moved team's programs: $TSTACK_FLEET_RUN, else the shim beside this CLI. */
export function fleetRunBin(machine: Machine): string {
  return machine.env("TSTACK_FLEET_RUN") ?? join(import.meta.dir, "..", "..", "bin", "fleet-run");
}

/** The fleet at `dir`: its entry when served, else the team moved to the cloud there. */
function fleetAt(machine: Machine, dir: string): Entry | undefined {
  return machine.registry.find(dir) ?? movedTeam(dir);
}

/** The fleet a command serves: DIR's ({@link fleetAt}), else the entry of the session among the command's parents,
 * else $FLEET_DIR's when it is no manager's. */
export function fleetOf(machine: Machine, dir: string | undefined): Entry | undefined {
  if (dir !== undefined) return fleetAt(machine, dir);
  const chain = new Set(ancestry(process.pid));
  const mine = machine.registry.live().find((e) => e.role !== "manager" && chain.has(asNumber(e.raw["pid"]) ?? -1));
  const given = machine.env("FLEET_DIR")?.trim();

  if (mine !== undefined || given === undefined || given === "") return mine;
  const found = fleetAt(machine, resolvePath(given));

  return found?.role === "manager" ? undefined : found;
}

/** `value` as a step, when it reads as one. */
function stepOf(value: Json): Step | undefined {
  const row = asObject(value);
  const [id, title, status] = [asString(row?.["id"]), asString(row?.["title"]), asString(row?.["status"])];
  const agent = row?.["agent"] ?? null;

  if (id === undefined || title === undefined || status === undefined || (agent !== null && asString(agent) === undefined)) return undefined;

  return { id, title, status, agent: asString(agent) ?? null };
}

/** What reading a moved manager's queue from the cloud came to: the queue, or why not. */
type CloudRead = { readonly queue: readonly Step[]; readonly unread?: never } | { readonly queue?: never; readonly unread: string };

/** The steps of the rows a completed `records.read` printed, none for no row, or what was seen instead. */
function queueIn(text: string): CloudRead {
  const outcome = Option.getOrUndefined(parseObject(text));

  if (outcome === undefined) return { unread: "fleet-run printed no JSON" };

  if (outcome["status"] !== "completed") return { unread: `fleet-run answered status ${asString(outcome["status"]) ?? "none"}` };
  const rows = asArray(outcome["result"]);

  if (rows === undefined) return { unread: "fleet-run's completed answer holds no rows" };
  const steps = rows.flatMap((row) => asArray(asObject(asObject(row)?.["record"])?.["steps"]) ?? [null]).map(stepOf);

  return steps.every((step) => step !== undefined) ? { queue: steps } : { unread: "a landings step in fleet-run's answer does not read" };
}

/** Why a fleet-run that exited `code` brought no queue. A `queued` answer is the host's outbox: offline, or online
 * behind programs not yet drained, which the answer does not tell apart; `waiting` counts this read too. */
export function failedRun(code: number | null, stdout: string, stderr: string): string {
  const outcome = Option.getOrUndefined(parseObject(stdout));
  const status = asString(outcome?.["status"]);

  if (status === "queued") {
    const waiting = asNumber(asObject(outcome?.["offline"])?.["queued"]);

    return `the host's outbox holds it${waiting === undefined ? "" : `, ${waiting} program(s) waiting with it`}: the link to the cloud is down, or they have not drained yet`;
  }

  const said = stderr.split("\n").find((l) => l.trim() !== "")?.trim();

  return `fleet-run exited ${code ?? "on a signal"}${status === undefined ? "" : ` (${status})`}${said === undefined ? "" : `: ${said}`}`;
}

/** The moved manager's landing queue as the cloud holds it. */
function cloudQueue(machine: Machine, manager: Entry, waitS: number): CloudRead {
  const bin = fleetRunBin(machine);
  // SIGKILL: spawnSync waits for the child, so one that ignores TERM would run the command past the gate's limit.
  const done = spawnSync(bin, [], { input: QUEUE_PROGRAM, encoding: "utf8", env: { ...process.env, FLEET_DIR: manager.dir }, timeout: Math.ceil(waitS * 1000), killSignal: "SIGKILL" });

  if (done.error !== undefined) return { unread: "code" in done.error && done.error.code === "ETIMEDOUT" ? `fleet-run gave no answer in ${waitS} s` : `fleet-run did not run: ${done.error.message}` };

  return done.status === 0 ? queueIn(done.stdout) : { unread: failedRun(done.status, done.stdout, done.stderr) };
}

/** The landing queue in the manager's folder. */
function folderQueue(manager: Entry): readonly Step[] {
  const raw: JsonObject = readObject(join(manager.dir, "state.json")) ?? {};
  const ledger = decodeLedger(raw);

  return ledger instanceof Refusal ? [] : (ledger.roadmap.find((m) => m.id === LANDINGS)?.steps ?? []);
}

function waitOf(machine: Machine): number {
  const text = machine.env("FLEET_TURN_WAIT_S")?.trim();
  const given = text === undefined || text === "" ? Number.NaN : Number(text);

  return Number.isFinite(given) && given > 0 ? Math.min(given, WAIT_MAX_S) : WAIT_S;
}

function run(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (argv.length > 1) return yield* refuse(USAGE);
    const dir = argv[0] === undefined ? undefined : resolvePath(argv[0]);
    const { manager, away } = machine.registry.presentManager();
    const fleet = fleetOf(machine, dir);

    if (manager === undefined) {
      out.out(
        away === undefined
          ? "no manager is served on this machine: the turn is yours; land on your own word\n"
          : `the manager moved to the cloud is not present (${away}): the turn is yours; land on your own word\n`,
      );

      return 0;
    }

    if (fleet === undefined) {
      if (dir === undefined) {
        out.out("this session serves no fleet: no landing turn to take\n");

        return 0;
      }

      return yield* refuse(`${dir} is not served, so the manager cannot give it the turn: \`fleet serve ${dir}\`, then ask the manager for it`);
    }

    const cloud = manager.moved === true ? cloudQueue(machine, manager, waitOf(machine)) : undefined;
    const queue = cloud?.queue ?? folderQueue(manager);
    const names = new Set([fleet.id, ...fleet.aliases].map((n) => n.toLowerCase()));
    const ours = (agent: string | null | undefined): boolean => agent != null && names.has(agent.toLowerCase());
    const mine = queue.find((s) => ours(s.agent) && s.status === "current");

    if (mine !== undefined && cloud?.unread !== undefined) {
      return yield* refuse(
        `${fleet.id} cannot confirm the landing turn: the manager's ledger could not be read from the cloud (${cloud.unread}), and its folder here, which can be behind the cloud, says ${mine.id} (${mine.title}) has it. ` +
          `A landing needs the cloud's word, so this machine must reach its host service and the cloud (\`FLEET_DIR=${manager.dir} fleet-run --status\` says how they stand; \`systemctl --user status fleet-host\` and \`journalctl --user -u fleet-host -g 'fleet-host: ${manager.id}:' -n 50 --no-pager\` show the service and the manager's lines in its journal): try again once it does`,
      );
    }

    if (mine !== undefined) {
      out.out(`${fleet.id} holds the landing turn: ${mine.id} (${mine.title}). Land, then report the commit and the files that moved to the manager\n`);

      return 0;
    }

    if (cloud?.unread !== undefined) out.out(`the manager's ledger could not be read from the cloud (${cloud.unread}): reading its folder here, which can be behind it\n`);
    const held = queue.find((s) => s.status === "current");
    const queued = queue.find((s) => ours(s.agent) && s.status === "pending");

    const where = [
      held === undefined ? "no landing has the turn" : `${held.id} (${held.title}) has it, ${held.agent ?? "no fleet"}'s`,
      ...(queued === undefined ? [] : [`yours, ${queued.id}, waits in the queue`]),
    ].join("; ");

    return yield* refuse(
      `${fleet.id} does not hold the landing turn (${where}). Ask the manager for it (SendMessage ${manager.session ?? "the session its greeting named"}): ` +
        "what, which files, from which workspace, which checks are green; prepare meanwhile, and land when it gives you the turn",
    );
  });
}

/** Run `fleet turn` with `argv` (after `turn`); the exit code. */
export function turnCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv).pipe(Effect.catch(exitOf));
  });
}
