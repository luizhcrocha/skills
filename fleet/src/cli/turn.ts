/**
 * `fleet turn [DIR]`: whether this fleet holds the landing turn, read from the manager's landing queue
 * (its `landings` milestone: one step per landing, `--agent <fleet>`, the current one holds the turn).
 * Exit 0: the turn is this fleet's, or no manager is served (a fleet then lands on its own word), or the
 * session runs no fleet. Exit 1: a manager is served and the turn is not this fleet's. Without DIR the
 * fleet is the one the Claude Code session running the command serves (its registry entry's pid is
 * among the command's parents), so `land-check` asks it without being told the fleet.
 */
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { Refusal } from "../errors.ts";
import { resolvePath } from "../files.ts";
import { Out } from "../io.ts";
import { asNumber, type JsonObject } from "../json.ts";
import { LANDINGS } from "../ledger/commands.ts";
import { decodeLedger } from "../ledger/model.ts";
import { ancestry } from "../procs.ts";
import { readObject, type Entry } from "../registry.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";

const USAGE = "usage: fleet turn [DIR]";

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "turn", reason }));
}

/** The fleet a command serves: DIR's entry, else the entry of the session among the command's parents. */
function fleetOf(machine: Machine, dir: string | undefined): Entry | undefined {
  if (dir !== undefined) return machine.registry.find(dir);
  const chain = new Set(ancestry(process.pid));

  return machine.registry.live().find((e) => e.role !== "manager" && chain.has(asNumber(e.raw["pid"]) ?? -1));
}

function run(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (argv.length > 1) return yield* refuse(USAGE);
    const dir = argv[0] === undefined ? undefined : resolvePath(argv[0]);
    const manager = machine.registry.manager();
    const fleet = fleetOf(machine, dir);

    if (manager === undefined) {
      out.out("no manager is served on this machine: the turn is yours; land on your own word\n");

      return 0;
    }

    if (fleet === undefined) {
      if (dir === undefined) {
        out.out("this session serves no fleet: no landing turn to take\n");

        return 0;
      }

      return yield* refuse(`${dir} is not served, so the manager cannot give it the turn: \`fleet serve ${dir}\`, then ask the manager for it`);
    }

    const raw: JsonObject = readObject(join(manager.dir, "state.json")) ?? {};
    const ledger = decodeLedger(raw);
    const queue = ledger instanceof Refusal ? [] : (ledger.roadmap.find((m) => m.id === LANDINGS)?.steps ?? []);
    const mine = queue.find((s) => s.agent === fleet.id && s.status === "current");

    if (mine !== undefined) {
      out.out(`${fleet.id} holds the landing turn: ${mine.id} (${mine.title}). Land, then report the commit and the files that moved to the manager\n`);

      return 0;
    }

    const held = queue.find((s) => s.status === "current");
    const queued = queue.find((s) => s.agent === fleet.id && s.status === "pending");

    const where = [
      held === undefined ? "no landing has the turn" : `${held.id} (${held.title}) has it, ${held.agent ?? "no fleet"}'s`,
      ...(queued === undefined ? [] : [`yours, ${queued.id}, waits in the queue`]),
    ].join("; ");

    return yield* refuse(
      `${fleet.id} does not hold the landing turn (${where}). Ask the manager for it (SendMessage ${manager.session ?? manager.id}): ` +
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
