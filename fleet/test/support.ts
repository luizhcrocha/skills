/**
 * What the ported tests share: throwaway directories, the `fleet` binary run as a process (the CLI is
 * the test surface, as the Python tests ran the scripts), and a machine for the module interfaces.
 */
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Option from "effect/Option";

import { runFleetSync } from "../src/cli/run.ts";
import { stampOf } from "../src/clock.ts";
import { envOf, recordingOut } from "../src/io.ts";
import { asObject, parseJson, type JsonObject } from "../src/json.ts";
import { machineOf, type Machine } from "../src/world.ts";

/** The `fleet` executable. */
export const FLEET = fileURLToPath(new URL("../bin/fleet", import.meta.url));

/** The coordinator skill's directory (its templates and tests' fixtures). */
export const SKILL = realpathSync(fileURLToPath(new URL("../../skills/productivity/coordinator", import.meta.url)));

/** A fresh directory, resolved. */
export function tmp(prefix = "fleet-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** What a process gave back. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A process environment. */
export interface Environment {
  [name: string]: string;
}

/** The environment every test process runs in: its own registry, no discovery. */
export function baseEnv(home: string, more: Readonly<Environment> = {}): Environment {
  const env: Environment = {};

  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env["FLEET_NOW"];

  return { ...env, FLEET_HOME: home, FLEET_DISCOVER: "0", ...more };
}

/** Run `fleet ARGS` in this process, through the CLI's own interface, with `env` as its environment. */
export function fleet(args: readonly string[], env: Readonly<Environment>): Ran {
  const { layer, recorded } = recordingOut();
  const zone = process.env["TZ"];
  const wanted = env["TZ"] ?? zone;

  if (wanted !== undefined) process.env["TZ"] = wanted;
  const code = runFleetSync(args, envOf(env), layer, env["FLEET_NOW"]);

  if (zone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = zone;

  return { code, stdout: recorded.stdout.join(""), stderr: recorded.stderr.join("") };
}

/** Run `fleet ARGS` as its own process and wait for it. */
export function spawnFleet(args: readonly string[], env: Readonly<Environment>): Ran {
  const done = Bun.spawnSync([FLEET, ...args], { env, stdout: "pipe", stderr: "pipe" });

  return { code: done.exitCode ?? -1, stdout: done.stdout.toString(), stderr: done.stderr.toString() };
}

/** A machine over the real clock and `env` (then the process's environment), for module interfaces. */
export function machine(env: Readonly<Environment>): Machine {
  return machineOf(
    () => new Date(),
    (name) => env[name] ?? process.env[name],
  );
}

/** The stamp of now. */
export function now(): string {
  return stampOf(new Date());
}

/** The JSON object in `path`. */
export function readJson(path: string): JsonObject {
  return asObject(Option.getOrUndefined(parseJson(readFileSync(path, "utf8")))) ?? {};
}

/** The lines of a running process's stdout, one at a time, with a timeout. */
export class Lines {
  private buffer = "";
  private readonly chunks: { read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }> };
  private readonly decoder = new TextDecoder();
  private pending: Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }> | undefined;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.chunks = stream.getReader();
  }

  private ended = false;

  private async fill(ms: number): Promise<boolean> {
    if (this.ended) return false;
    this.pending ??= this.chunks.read();
    const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));
    const got = await Promise.race([this.pending, timer]);

    if (got === "timeout") return false;
    this.pending = undefined;

    if (got.done || got.value === undefined) {
      this.ended = true;

      return false;
    }

    this.buffer += this.decoder.decode(got.value, { stream: true });

    return true;
  }

  /** The next line, newline included; fails after `ms`. */
  async next(ms = 5000): Promise<string> {
    const deadline = Date.now() + ms;

    for (;;) {
      const at = this.buffer.indexOf("\n");

      if (at >= 0) {
        const line = this.buffer.slice(0, at + 1);
        this.buffer = this.buffer.slice(at + 1);

        return line;
      }

      const left = deadline - Date.now();

      if (left <= 0 || !(await this.fill(left))) throw new Error(`no line within ${ms} ms (have ${JSON.stringify(this.buffer)})`);
    }
  }

  /** Whether nothing more is printed for `ms`. */
  async quiet(ms = 800): Promise<boolean> {
    if (this.buffer.includes("\n")) return false;

    return !(await this.fill(ms)) && !this.buffer.includes("\n");
  }

  /** Everything still to come, until the stream ends. */
  async rest(): Promise<string> {
    while (await this.fill(10000)) {
      // keep reading
    }

    return this.buffer;
  }
}

/** A `fleet` process started in the background, and its stdout as lines. */
export interface Started {
  readonly proc: Bun.Subprocess<"ignore", "pipe", "inherit">;
  readonly lines: Lines;
}

/** Start `fleet ARGS` in the background; its stdout as lines. */
export function start(args: readonly string[], env: Readonly<Environment>): Started {
  const proc = Bun.spawn([FLEET, ...args], { env, stdout: "pipe", stderr: "inherit", stdin: "ignore" });

  return { proc, lines: new Lines(proc.stdout) };
}

/** Sleep `ms`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
