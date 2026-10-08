/**
 * `fleet advisor`: the fleet's advisor recorded as the worker row `advisor`, on the chat roster, kept out
 * of the silent rule, and restarted on Opus when Fable is unavailable. Through the CLI.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { silentWorkers } from "../src/health.ts";
import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { machineOf } from "../src/world.ts";
import { baseEnv, fleet, readJson, tmp, type Environment, type Ran } from "./support.ts";

let root: string;

let env: Environment;

function state(...args: string[]): Ran {
  const ran = fleet(["state", root, ...args, "--no-render"], env);
  expect(ran.code, ran.stderr).toBe(0);

  return ran;
}

function advisor(...args: string[]): Ran {
  return fleet(["advisor", root, ...args], env);
}

function row(): JsonObject | undefined {
  return (asArray(readJson(join(root, "state.json"))["agents"]) ?? []).map((r) => asObject(r) ?? {}).find((a) => a["id"] === "advisor");
}

function events(): string[] {
  return (asArray(readJson(join(root, "state.json"))["events"]) ?? []).map((e) => String(asObject(e)?.["text"]));
}

beforeEach(() => {
  const base = tmp("fleet-advisor-");
  root = join(base, "coordinator");
  env = baseEnv(join(base, "registry"), { FLEET_NOW: "2026-01-05T09:00:00+00:00", TZ: "UTC" });
  state("init", "--project", "p", "--goal", "g");
});

describe("starting the advisor", () => {
  test("records the row on Fable, queued, in the current step's milestone, and prints its prompt", () => {
    state("milestone", "m1", "--title", "One");
    state("milestone", "m2", "--title", "Two");
    state("step", "s1", "--milestone", "m2", "--title", "S", "--status", "current");
    const ran = advisor();

    expect(ran.code, ran.stderr).toBe(0);
    expect(row()).toMatchObject({ id: "advisor", model: "fable", effort: "high", status: "queued", skill: "none", milestone: "m2", lane: [] });
    expect(ran.stdout).toContain(`You are the advisor of the fleet in ${root}; your id on its chat is advisor.`);
    expect(ran.stdout).toContain(`say --as advisor "<asker> asked: <question> | <verdict> | <reason> | <confidence>"`);
    expect(ran.stderr).toContain('subagent_type "tstack:advisor", model: "fable", effort: "high", run_in_background');
    expect(ran.stdout).toContain("You run on fable at high effort.");
    expect(events()).toContain("Advisor started on fable.");
  });

  test("without a roadmap is refused", () => {
    const ran = advisor();

    expect(ran.code).toBe(1);
    expect(ran.stderr).toBe(`advisor: the roadmap of ${root} is empty: record it first, then start the advisor\n`);
    expect(row()).toBeUndefined();
  });

  test("on a model other than fable or opus is refused", () => {
    state("milestone", "m1", "--title", "One");
    const ran = advisor("--model", "sonnet");

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("the advisor runs on fable, or on opus when Fable is unavailable; not 'sonnet'");
  });
});

describe("once spawned", () => {
  beforeEach(() => {
    state("milestone", "m1", "--title", "One");
    expect(advisor().code).toBe(0);
  });

  test("the agentId is recorded and the line for brief.md is printed", () => {
    const ran = advisor("--task-id", "a0123456789abcdef");

    expect(ran.code, ran.stderr).toBe(0);
    expect(row()?.["task_id"]).toBe("a0123456789abcdef");
    expect(ran.stdout).toBe("advisor recorded on fable at high effort as a0123456789abcdef\n");
    expect(ran.stderr).toContain("SendMessage a0123456789abcdef your question");
  });

  test("the advisor speaks on the chat as itself, to the user", () => {
    const ran = fleet(["chat", root, "say", "--as", "advisor", "a1 asked: rename the seam? | yes | CONTEXT.md names it | high"], env);

    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain("#1 advisor -> user: a1 asked: rename the seam?");
  });

  test("restarting on Opus keeps the row, changes the model and logs why", () => {
    const ran = advisor("--model", "opus", "--log", "Fable unavailable: model not available");

    expect(ran.code, ran.stderr).toBe(0);
    expect(row()).toMatchObject({ model: "opus", effort: "high", status: "queued" });
    expect(ran.stdout).toContain("You run on opus at high effort.");
    expect(ran.stderr).toContain('model: "opus", effort: "high"');
    expect(ran.stderr).not.toContain("policy");
    expect(events()).toContain("Fable unavailable: model not available");
  });

  test("an advisor idle for an hour is not a silent worker; the same row running would be", () => {
    mkdirSync(join(root, "heartbeats"), { recursive: true });
    writeFileSync(join(root, "heartbeats", "s.advisor.json"), JSON.stringify({ session: "s", agent: null, worker: "advisor", cwd: "/", workspace: null, path: null, tool: "Bash", event: "PostToolUse", at: "2026-01-05T08:00:00+00:00" }));

    const machine = machineOf(
      () => new Date("2026-01-05T09:00:00Z"),
      (name) => env[name],
    );

    const ledger = (): JsonObject => readJson(join(root, "state.json"));

    expect(silentWorkers(machine, root, ledger())).toEqual([]);

    state("agent", "advisor", "--status", "running");
    expect(silentWorkers(machine, root, ledger()).map((w) => w.id)).toEqual(["advisor"]);
  });
});
