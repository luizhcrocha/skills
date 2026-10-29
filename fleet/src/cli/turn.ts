/**
 * `fleet turn [DIR]`: whether this fleet holds the landing turn, read from the manager's landing queue
 * (its `landings` milestone: one step per landing, `--agent <fleet>`, the current one holds the turn).
 * Exit 0: the turn is this fleet's, or no manager is present (a fleet then lands on its own word), or the
 * session runs no fleet. Exit 1: a manager is present and the turn is not this fleet's. Without DIR the
 * fleet is the one the Claude Code session running the command serves (its registry entry's pid is
 * among the command's parents), else the one $FLEET_DIR names, so `land-check` asks it without being told
 * the fleet. DIR and $FLEET_DIR may name a team moved to the cloud (its folder holds cloud.json); the
 * plugin's push gate sets $FLEET_DIR to the moved folder its session serves.
 *
 * A manager moved to the cloud is read from its folder, which its host service exports from the cloud. It is
 * present while its ledger's status is running and a session of its runs (registry.ts `movedManagerAway`):
 * no registry entry of its goes away when it stops or its session closes, and then the turn is every fleet's.
 *
 * The turn the manager just gave reaches its folder a moment later. The handover waits for it only when the
 * host says how far its export is behind, a contract the host must still meet (it writes neither file
 * today): the cloud's seq after the last program it applied in `applied.json`, the seq the folder holds in
 * `exported.json`, both `{"seq": n}`. While the exported seq is missing or below the applied one the command
 * says so and waits, up to $FLEET_TURN_WAIT_S (10 s: the plugin's push gate gives this command 20 s inside a
 * 30 s hook, and fails open past them), then refuses naming the lag. A folder with no `applied.json` has no
 * apply to wait for, and is read as it stands.
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
import { movedTeam, readObject, type Entry } from "../registry.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";

const USAGE = "usage: fleet turn [DIR]";

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "turn", reason }));
}

/** How long the handover waits for a moved manager's export, by default. */
const WAIT_S = 10;

/** The fleet at `dir`: its entry when served, else the team moved to the cloud there. */
function fleetAt(machine: Machine, dir: string): Entry | undefined {
  return machine.registry.find(dir) ?? movedTeam(dir);
}

/** The fleet a command serves: DIR's ({@link fleetAt}), else the entry of the session among the command's parents,
 * else $FLEET_DIR's when it is no manager's. */
function fleetOf(machine: Machine, dir: string | undefined): Entry | undefined {
  if (dir !== undefined) return fleetAt(machine, dir);
  const chain = new Set(ancestry(process.pid));
  const mine = machine.registry.live().find((e) => e.role !== "manager" && chain.has(asNumber(e.raw["pid"]) ?? -1));
  const given = machine.env("FLEET_DIR")?.trim();

  if (mine !== undefined || given === undefined || given === "") return mine;
  const found = fleetAt(machine, resolvePath(given));

  return found?.role === "manager" ? undefined : found;
}

/** A moved manager's folder behind the cloud: the seq its export holds (undefined: none recorded) and the seq the
 * cloud applied last. */
interface Lag {
  readonly exported: number | undefined;
  readonly applied: number;
}

function seqIn(dir: string, name: string): number | undefined {
  return asNumber(readObject(join(dir, name))?.["seq"]);
}

/** How far the folder `dir` is behind the cloud, or undefined when it holds the last apply (or records none). */
function lagOf(dir: string): Lag | undefined {
  const applied = seqIn(dir, "applied.json");
  const exported = seqIn(dir, "exported.json");

  return applied === undefined || (exported !== undefined && exported >= applied) ? undefined : { exported, applied };
}

function lagWords(lag: Lag): string {
  return `exported seq ${lag.exported ?? "none"}, applied seq ${lag.applied}`;
}

/** Wait until the moved manager's folder holds the cloud's last apply, saying so once, or refuse after `waitS`. */
function caughtUp(manager: Entry, waitS: number): Effect.Effect<void, Refusal, Out> {
  return Effect.gen(function* () {
    const dir = manager.dir;
    const out = yield* Out;
    const first = lagOf(dir);

    if (first === undefined) return;
    out.out(`the manager's ledger here is behind the cloud (${lagWords(first)}): waiting up to ${waitS} s for its export\n`);
    const deadline = Date.now() + waitS * 1000;
    let lag: Lag | undefined = first;

    while (lag !== undefined && Date.now() < deadline) {
      yield* Effect.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
      lag = lagOf(dir);
    }

    if (lag === undefined) return;

    return yield* refuse(
      `the manager's ledger here is still behind the cloud after ${waitS} s (${lagWords(lag)}), so it cannot say whose turn it is. ` +
        `${dir} is written by the manager's host service: check it (\`systemctl --user status fleet-host@${manager.id}\`, its journal), then run \`fleet turn\` again`,
    );
  });
}

function waitOf(machine: Machine): number {
  const text = machine.env("FLEET_TURN_WAIT_S")?.trim();
  const given = text === undefined || text === "" ? Number.NaN : Number(text);

  return Number.isFinite(given) && given >= 0 ? given : WAIT_S;
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

    if (manager.moved === true) yield* caughtUp(manager, waitOf(machine));
    const raw: JsonObject = readObject(join(manager.dir, "state.json")) ?? {};
    const ledger = decodeLedger(raw);
    const queue = ledger instanceof Refusal ? [] : (ledger.roadmap.find((m) => m.id === LANDINGS)?.steps ?? []);
    const names = new Set([fleet.id, ...fleet.aliases].map((n) => n.toLowerCase()));
    const ours = (agent: string | null | undefined): boolean => agent != null && names.has(agent.toLowerCase());
    const mine = queue.find((s) => ours(s.agent) && s.status === "current");

    if (mine !== undefined) {
      out.out(`${fleet.id} holds the landing turn: ${mine.id} (${mine.title}). Land, then report the commit and the files that moved to the manager\n`);

      return 0;
    }

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
