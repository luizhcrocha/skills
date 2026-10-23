/** What gate-run.test.ts and gate-run-scope.test.ts share: a registry of the test's own, and the CLI run on it. */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asArray, asNumber, asObject, type JsonObject } from "../src/json.ts";
import { scopeAvailable } from "../src/gate-run.ts";
import { baseEnv, FLEET, tmp, type Environment } from "./support.ts";

export let home: string;

export let env: Environment;

export const SCOPE = scopeAvailable((name) => process.env[name]);

/** A registry of the test's own, for a beforeEach. */
export function freshRegistry(): void {
  home = join(tmp("fleet-gate-run-"), "registry");
  mkdirSync(home);
  // This checkout's fleet, whatever newer one the machine has (baseEnv drops the session's FLEET_GATE_* settings).
  env = baseEnv(home, { FLEET_NO_FORWARD: "1" });
}

export interface Done {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function gate(args: readonly string[], more: Readonly<Environment> = {}, cwd?: string): Done {
  const done = Bun.spawnSync([FLEET, "fleets", "gate", ...args], { env: { ...env, ...more }, stdout: "pipe", stderr: "pipe", cwd: cwd ?? process.cwd() });

  return { code: done.exitCode ?? -1, stdout: done.stdout.toString(), stderr: done.stderr.toString() };
}

export function holdFile(): string {
  return join(home, "gate", "gate.json");
}

/** `fleet fleets gate`'s first line: `free`, or the first hold. */
export function first(): string {
  return gate([]).stdout.split("\n")[0] ?? "";
}

/** The records of the runs, a line each. */
export function records(): JsonObject[] {
  return readFileSync(join(home, "gate", "runs.jsonl"), "utf8").trim().split("\n").map((line) => asObject(JSON.parse(line)) ?? {});
}

/** `fleet fleets gate --json`. */
export function standing() {
  const said = asObject(JSON.parse(gate(["--json"]).stdout)) ?? {};
  const rows = (key: string): JsonObject[] => (asArray(said[key]) ?? []).map((row) => asObject(row) ?? {});

  return { holders: rows("holders"), queue: rows("queue"), day: asObject(said["day"]) };
}

/** The budget's bytes, as `fleet fleets gate --json` says it. */
export function budgetBytes(): number {
  return asNumber(asObject(asObject(JSON.parse(gate(["--json"]).stdout))?.["budget"])?.["bytes"]) ?? 0;
}

/** The holds as gate.json keeps them. */
export function holds(): JsonObject[] {
  const kept = asObject(JSON.parse(readFileSync(holdFile(), "utf8"))) ?? {};
  const several = (asArray(kept["holds"]) ?? []).map((hold) => asObject(hold) ?? {});

  return several.length > 0 ? several : [kept];
}

/** A `gate run` left running, with what it said so far kept for the test's end. */
export function running(args: readonly string[], more: Readonly<Environment> = {}, cwd?: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([FLEET, "fleets", "gate", "run", ...args], { env: { ...env, ...more }, stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: cwd ?? process.cwd() });
}

export async function stopAll(runs: readonly Bun.Subprocess[]): Promise<void> {
  for (const run of runs) run.kill("SIGTERM");
  await Promise.all(runs.map(async (run) => run.exited));
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
}

export async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(50);
  }

  return check();
}

export function pidIn(path: string): number {
  return Number(readFileSync(path, "utf8").trim());
}

/** A command that starts a child and a grandchild in a session of its own (out of every process group), writes their pids, and sleeps. */
export function tree(dir: string): string[] {
  return ["sh", "-c", `sleep 300 & echo $! > ${dir}/child; setsid sleep 301 >/dev/null 2>&1 & echo $! > ${dir}/escaped; sleep 302 & echo $! > ${dir}/last; wait`];
}
