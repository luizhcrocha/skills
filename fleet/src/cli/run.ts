/**
 * One run of the `fleet` CLI over given seams: its arguments, its environment (FLEET_NOW stops its
 * clock) and where it prints. The process entry point gives it the process's own; tests give it theirs.
 */
import { existsSync } from "node:fs";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { advisorCli } from "../advisor/advisor.ts";
import { clockFrom } from "../clock.ts";
import { Env, Out } from "../io.ts";
import { World, worldLayer, type Machine } from "../world.ts";
import { briefCli } from "./brief.ts";
import { chatCli } from "./chat.ts";
import { fleetsCli } from "./fleets.ts";
import { previewCli } from "./preview.ts";
import { CONTROL_CLIS, controlCli } from "./hub.ts";
import { stateCli } from "./state.ts";
import { turnCli } from "./turn.ts";
import { wsCli } from "./ws.ts";

const USAGE = "usage: fleet {ls,state,chat,fleets,ws,preview,brief,turn,advisor,hub,serve,render,usage,spend,served} ...\n";

/** The commands whose first argument is a fleet's directory. */
const DIR_CLIS: ReadonlySet<string> = new Set(["state", "chat", "ws", "preview", "brief", "turn", "advisor", "serve", "spend"]);

/** A name that fits several served fleets: say which. */
export interface Ambiguous {
  readonly name: string;
  readonly fits: readonly string[];
}

/**
 * A fleet named the way people say it: where a command takes a fleet's directory, a bare name (no `/`,
 * and no directory of that name here) is looked up among the fleets this machine serves. Its id on the
 * hub, an id it had before, or its session's name wins; else the one fleet whose id or session starts
 * with it, else the one that contains it (any case). `fleet preview ui start` is ui-coordinator's
 * directory when it is the only fit. Several fits are {@link Ambiguous}; no fit passes as given.
 */
export function withFleetDir(argv: readonly string[], machine: Machine): string[] | Ambiguous {
  const [cli, first, ...more] = argv;

  if (cli === undefined || first === undefined || !DIR_CLIS.has(cli) || first.includes("/") || first.startsWith("-") || existsSync(first)) return [...argv];
  const live = machine.registry.live();
  const exact = live.find((e) => e.id === first || e.aliases.includes(first) || e.session === first);

  if (exact !== undefined) return [cli, exact.dir, ...more];
  const said = first.toLowerCase();
  const names = (e: (typeof live)[number]): string[] => [e.id, e.session ?? ""].map((n) => n.toLowerCase());
  const starting = live.filter((e) => names(e).some((n) => n.startsWith(said)));
  const fits = starting.length > 0 ? starting : live.filter((e) => names(e).some((n) => n.includes(said)));

  if (fits.length === 1 && fits[0] !== undefined) return [cli, fits[0].dir, ...more];

  if (fits.length > 1) return { name: first, fits: fits.map((e) => e.id).sort() };

  return [...argv];
}

function dispatch(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;
    const out = yield* Out;
    const [cli, ...rest] = argv;

    // `fleet ls` and `fleet list`: the served fleets, as `fleet fleets list` prints them.
    if (cli === "ls" || cli === "list") return yield* fleetsCli(["list", ...rest]);
    const resolved = withFleetDir(argv, machine);

    if (!Array.isArray(resolved)) {
      out.err(`fleet: '${resolved.name}' fits ${resolved.fits.join(", ")}: give more of the name\n`);

      return 2;
    }

    return yield* route(resolved);
  });
}

function route(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  const [cli, ...rest] = argv;

  if (cli === "state") return stateCli(rest);

  if (cli === "chat") return chatCli(rest);

  if (cli === "fleets") return fleetsCli(rest);

  if (cli === "ws") return wsCli(rest);

  if (cli === "preview") return previewCli(rest);

  if (cli === "brief") return briefCli(rest);

  if (cli === "turn") return turnCli(rest);

  if (cli === "advisor") return advisorCli(rest);
  const control = CONTROL_CLIS.find((c) => c === cli);

  if (control !== undefined) return controlCli(control, rest);

  return Effect.gen(function* () {
    const out = yield* Out;

    out.err(`${USAGE}fleet: error: the first argument is state, chat, fleets, ws, preview, brief, turn, advisor, hub, serve, render, usage, spend or served\n`);

    return 2;
  });
}

/** Run `fleet ARGV` with this environment and output; its exit code. */
export function runFleet(argv: readonly string[], env: Layer.Layer<Env>, out: Layer.Layer<Out>, fixed: string | undefined): Promise<number> {
  const world = worldLayer.pipe(Layer.provide(Layer.mergeAll(clockFrom(fixed), env)));

  return Effect.runPromise(dispatch(argv).pipe(Effect.provide(Layer.mergeAll(world, out))));
}

/** {@link runFleet} for a command that never waits (all but `chat watch` and `chat wait`). */
export function runFleetSync(argv: readonly string[], env: Layer.Layer<Env>, out: Layer.Layer<Out>, fixed: string | undefined): number {
  const world = worldLayer.pipe(Layer.provide(Layer.mergeAll(clockFrom(fixed), env)));

  return Effect.runSync(dispatch(argv).pipe(Effect.provide(Layer.mergeAll(world, out))));
}
