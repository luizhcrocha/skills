/** What ws.test.ts, ws-hooks.test.ts and ws-trash.test.ts share: a throwaway repo and fleet per test, and the CLI run on them. */
import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { baseEnv, FLEET, fleet, readJson, tmp, type Environment } from "./support.ts";

export let base: string;

export let repo: string;

export let dir: string;

export let env: Environment;

/** Add to this test's environment: a test file cannot assign an imported `env`. */
export function moreEnv(more: Readonly<Environment>): void {
  env = { ...env, ...more };
}

/** Run jj in `at`; its stdout. */
export function jj(at: string, ...args: string[]): string {
  const done = Bun.spawnSync(["jj", "-R", at, "--color=never", ...args], { stdout: "pipe", stderr: "pipe" });

  if (done.exitCode !== 0) throw new Error(`jj ${args.join(" ")}: ${done.stderr.toString()}`);

  return done.stdout.toString();
}

export function state(...args: string[]): void {
  const ran = fleet(["state", dir, ...args, "--no-render"], env);

  expect(ran.code).toBe(0);
}

export function ws(...args: string[]): ReturnType<typeof fleet> {
  return fleet(["ws", dir, ...args], env);
}

export function workspaces(): JsonObject[] {
  return (asArray(readJson(join(dir, "state.json"))["workspaces"]) ?? []).flatMap((w) => {
    const o = asObject(w);

    return o === undefined ? [] : [o];
  });
}

/** In the workspace at `at`: write `file`, describe the change, start a new one on top. */
export function work(at: string, file: string, message: string): void {
  writeFileSync(join(at, file), `${message}\n`);
  jj(at, "describe", "-m", message);
  jj(at, "new");
}

/** The fleet CLI as a process of its own, on a jj that fails `workspace list` after the first `passes` of them. */
export function onFailingJj(passes: number, ...args: string[]) {
  const real = Bun.which("jj");
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "jj"),
    `#!/bin/sh
case " $* " in
*" workspace list "*)
  n=$(cat "${join(base, "lists")}" 2>/dev/null || echo 0)
  echo $((n + 1)) >"${join(base, "lists")}"
  if [ "$n" -ge ${passes} ]; then echo "Error: the store is locked" >&2; exit 1; fi
  ;;
esac
exec "${real}" "$@"
`,
  );
  chmodSync(join(bin, "jj"), 0o755);

  const ran = Bun.spawnSync([FLEET, ...args], { env: { ...env, PATH: `${bin}:${env["PATH"] ?? ""}` }, stdout: "pipe", stderr: "pipe" });

  return { code: ran.exitCode, stderr: ran.stderr.toString() };
}

/** The repo each test starts from, made once: a jj repo holds no path of its own, so a copy is a repo of its own. */
let template: string;

/** The repo each test copies, for a beforeAll. */
export function makeTemplate(): void {
  template = join(tmp("fleet-ws-template-"), "repo");
  Bun.spawnSync(["jj", "git", "init", template], { stdout: "ignore", stderr: "ignore" });
  writeFileSync(join(template, "README"), "base\n");
  jj(template, "describe", "-m", "base");
  jj(template, "new");
}

/** A copy of the template and a fleet of the test's own, for a beforeEach. */
export function freshRepo(): void {
  base = tmp("fleet-ws-");
  repo = join(base, "repo");
  cpSync(template, repo, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  dir = join(base, "fleet");
  env = baseEnv(join(base, "registry"), { FLEET_NOW: "2026-01-05T09:00:00+00:00", TZ: "UTC" });
  state("init", "--project", "p", "--goal", "g");
  state("milestone", "m1", "--title", "M");
}

/** The ids of the agents, changes and events a test reads. */
export function lastEvent(): JsonObject | undefined {
  return asObject((asArray(readJson(join(dir, "state.json"))["events"]) ?? []).at(-1));
}
