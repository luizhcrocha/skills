/**
 * What a fleet command reads besides its own DIR: the clock, the environment, the registry of this
 * machine's fleets and the session transcripts. Built once per command from the {@link Clock} and
 * {@link Env} services, so a test gives a command a pinned clock and a registry of its own.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Clock } from "./clock.ts";
import { Env } from "./io.ts";
import { Registry, registryPlace } from "./registry.ts";
import { configDir } from "./transcripts.ts";

/** The machine as one command sees it. */
export interface Machine {
  /** The instant now (FLEET_NOW, else the machine's clock). */
  readonly now: () => Date;
  /** An environment variable. */
  readonly env: (name: string) => string | undefined;
  /** This machine's fleets. */
  readonly registry: Registry;
  /** Where session transcripts are. */
  readonly config: string;
}

/** The machine a command runs on. */
export class World extends Context.Service<World, Machine>()("fleet/World") {}

/** The machine from a clock and an environment. */
export function machineOf(now: () => Date, env: (name: string) => string | undefined): Machine {
  const config = configDir(env);

  return { now, env, config, registry: new Registry(registryPlace(env, config)) };
}

/** The {@link World} from the {@link Clock} and {@link Env} services. */
export const worldLayer: Layer.Layer<World, never, Clock | Env> = Layer.effect(
  World,
  Effect.gen(function* () {
    const clock = yield* Clock;
    const env = yield* Env;

    return machineOf(clock.now, env.get);
  }),
);

/** Seconds since the epoch, now. */
export function secondsNow(machine: Machine): number {
  return machine.now().getTime() / 1000;
}
