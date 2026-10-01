/**
 * How a CLI ends: a refusal is `<speaker>: <reason>` on stderr and exit 1, a usage error is the usage and
 * `<prog>: error: <reason>` on stderr and exit 2 (argparse's shape), help is the usage on stdout, exit 0.
 */
import * as Effect from "effect/Effect";

import { ChatError, Refusal, UsageError } from "../errors.ts";
import { Out } from "../io.ts";

/** Print `failure` as its CLI does and give its exit code. */
export function exitOf(failure: Refusal | UsageError | ChatError): Effect.Effect<number, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (failure instanceof UsageError) {
      out.err(`${failure.usage}${failure.prog}: error: ${failure.reason}\n`);

      return 2;
    }

    if (failure instanceof ChatError) {
      out.err(`chat: ${failure.reason}\n`);

      return 1;
    }

    out.err(`${failure.speaker}: ${failure.reason}\n`);

    return 1;
  });
}

/** Print the help text; exit 0. */
export function printUsage(text: string): Effect.Effect<number, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    out.out(`${text}\n`);

    return 0;
  });
}
