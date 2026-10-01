/**
 * The process seams every command reads and writes through: its output (stdout, stderr) and its
 * environment. The CLI provides the process's own; tests provide recording ones.
 */
import { writeSync } from "node:fs";

import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/** Where a command prints: whole lines, written at once, so a watch's line is flushed as it is printed. */
export class Out extends Context.Service<
  Out,
  {
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
  }
>()("fleet/Out") {}

/** The environment variables a command reads. */
export class Env extends Context.Service<Env, { readonly get: (name: string) => string | undefined }>()(
  "fleet/Env",
) {}

function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let at = 0;

  while (at < bytes.length) {
    at += writeSync(fd, bytes, at);
  }
}

/** The process's stdout and stderr, written synchronously. */
export const processOut: Layer.Layer<Out> = Layer.succeed(Out, {
  out: (text: string) => writeAll(1, text),
  err: (text: string) => writeAll(2, text),
});

/** The process's environment. */
export const processEnv: Layer.Layer<Env> = Layer.succeed(Env, { get: (name: string) => process.env[name] });

/** What a recording {@link Out} kept. */
export interface Recorded {
  readonly stdout: string[];
  readonly stderr: string[];
}

/** A recording {@link Out} and what it kept. */
export interface Recording {
  readonly layer: Layer.Layer<Out>;
  readonly recorded: Recorded;
}

/** An {@link Out} that keeps what is printed, for tests. */
export function recordingOut(): Recording {
  const recorded: Recorded = { stdout: [], stderr: [] };

  return {
    recorded,
    layer: Layer.succeed(Out, {
      out: (text: string) => {
        recorded.stdout.push(text);
      },
      err: (text: string) => {
        recorded.stderr.push(text);
      },
    }),
  };
}

/** An {@link Env} over a fixed table, for tests. */
export function envOf(table: Readonly<Record<string, string>>): Layer.Layer<Env> {
  return Layer.succeed(Env, { get: (name: string) => table[name] });
}
