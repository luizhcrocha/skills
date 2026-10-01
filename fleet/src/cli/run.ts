/**
 * One run of the `fleet` CLI over given seams: its arguments, its environment (FLEET_NOW stops its
 * clock) and where it prints. The process entry point gives it the process's own; tests give it theirs.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { advisorCli } from "../advisor/advisor.ts";
import { clockFrom } from "../clock.ts";
import { Env, Out } from "../io.ts";
import { World, worldLayer } from "../world.ts";
import { briefCli } from "./brief.ts";
import { chatCli } from "./chat.ts";
import { fleetsCli } from "./fleets.ts";
import { CONTROL_CLIS, controlCli } from "./hub.ts";
import { stateCli } from "./state.ts";
import { turnCli } from "./turn.ts";
import { wsCli } from "./ws.ts";

const USAGE = "usage: fleet {state,chat,fleets,ws,brief,turn,advisor,hub,serve,render,usage,spend,served} ...\n";

function dispatch(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  const [cli, ...rest] = argv;

  if (cli === "state") return stateCli(rest);

  if (cli === "chat") return chatCli(rest);

  if (cli === "fleets") return fleetsCli(rest);

  if (cli === "ws") return wsCli(rest);

  if (cli === "brief") return briefCli(rest);

  if (cli === "turn") return turnCli(rest);

  if (cli === "advisor") return advisorCli(rest);
  const control = CONTROL_CLIS.find((c) => c === cli);

  if (control !== undefined) return controlCli(control, rest);

  return Effect.gen(function* () {
    const out = yield* Out;

    out.err(`${USAGE}fleet: error: the first argument is state, chat, fleets, ws, brief, turn, advisor, hub, serve, render, usage, spend or served\n`);

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
