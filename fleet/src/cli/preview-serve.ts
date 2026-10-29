/**
 * `fleet preview serve [--port N] [--https PORT]`: the workers' previews served without the hub
 * (`hub/preview-server.ts`), at the hub's port and paths; it stands by while a hub runs. Runs until SIGTERM or
 * SIGINT, as `fleet hub` does.
 */
import * as Effect from "effect/Effect";

import { Refusal } from "../errors.ts";
import { DEFAULT_PORT } from "../hub/server.ts";
import { startPreviewServer } from "../hub/preview-server.ts";
import { tailscaleBin } from "../hub/tailnet.ts";
import { Out } from "../io.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";

/** The verbs of `fleet preview` that take no fleet's directory. */
export const SERVER_VERBS: ReadonlySet<string> = new Set(["serve"]);

const USAGE = "usage: fleet preview serve [--port N] [--https PORT]";

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "preview", reason }));
}

/** The value after `flag` in `argv`, and `argv` without the two. */
function option(argv: readonly string[], flag: string): readonly [string | undefined, string[]] {
  const at = argv.indexOf(flag);

  if (at < 0) return [undefined, [...argv]];

  return [argv[at + 1], [...argv.slice(0, at), ...argv.slice(at + 2)]];
}

function portOf(text: string | undefined): number | undefined {
  const port = Number(text);

  return text !== undefined && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

function serve(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const [portText, afterPort] = option(argv, "--port");
    const [httpsText, rest] = option(afterPort, "--https");

    if (rest.length > 0) return yield* refuse(USAGE);
    const port = portOf(portText ?? machine.env("FLEET_HUB_PORT") ?? String(DEFAULT_PORT));
    const https = httpsText === undefined ? undefined : portOf(httpsText);

    if (port === undefined || (httpsText !== undefined && https === undefined)) return yield* refuse("a port is a number from 1 to 65535");
    const log = (line: string): void => out.err(`preview serve: ${line}\n`);
    const running = yield* Effect.promise(() => startPreviewServer({ port, machine, tailscale: tailscaleBin(machine.env), https }, log));

    if (running instanceof Error) return yield* refuse(running.message);

    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          process.once("SIGTERM", () => resolve());
          process.once("SIGINT", () => resolve());
        }),
    );
    yield* Effect.promise(() => running.stop());
    log("stopped");

    return 0;
  });
}

/** Run `fleet preview <verb> …` for a verb of {@link SERVER_VERBS}. */
export function previewServerCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;
    const [verb, ...rest] = argv;
    const run = verb === "serve" ? serve(machine, rest) : refuse(USAGE);

    return yield* run.pipe(Effect.catch(exitOf));
  });
}
