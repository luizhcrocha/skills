/**
 * Where names come from: a worker's from the coordinator (`agent --name`), the user (the page), else its
 * subagent's meta.json (`name`, else the Agent tool's `description`); a fleet's from the page, its session's
 * /rename, the live session record Claude Code keeps (`sessions/<pid>.json`, a derived name included) or the
 * transcript's AI title. And the ledger's lock, which the CLI and the hub's rename both take.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { lockLedger } from "../src/ledger/store.ts";
import { renameAgent } from "../src/ledger/rename.ts";
import type { Registry } from "../src/registry.ts";
import { baseEnv, fleet, FLEET, machine, readJson, tmp, type Environment, type Ran } from "./support.ts";

const PROJECT = "-home-x-repo";

const SESSION = "s1";

let config: string;

let root: string;

let env: Environment;

/** The folder of the session whose scratchpad holds `root`, under `config`. */
function sessionFolder(): string {
  return join(config, "projects", PROJECT, SESSION);
}

/** Write subagent `taskId`'s meta.json. */
function meta(taskId: string, body: JsonObject): void {
  const sub = join(sessionFolder(), "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${taskId}.meta.json`), JSON.stringify(body));
}

function run(...args: string[]): Ran {
  return fleet(["state", root, ...args, "--no-render"], env);
}

function ok(...args: string[]): void {
  const ran = run(...args);
  expect([ran.code, ran.stderr]).toEqual([0, expect.any(String)]);
}

/** Worker `id`'s row. */
function row(id: string): JsonObject {
  return (asArray(readJson(join(root, "state.json"))["agents"]) ?? []).map((a) => asObject(a) ?? {}).find((a) => a["id"] === id) ?? {};
}

function named(id: string): readonly [unknown, unknown] {
  const a = row(id);

  return [a["name"], a["name_by"]];
}

beforeEach(() => {
  config = tmp("claude-");
  root = join(tmp("scratch-"), PROJECT, SESSION, "scratchpad", "coordinator");
  mkdirSync(root, { recursive: true });
  env = baseEnv(tmp("fleet-home-"), { CLAUDE_CONFIG_DIR: config });
  ok("init", "--project", "p", "--goal", "g");
  ok("milestone", "m1", "--title", "M");
});

describe("a worker's name", () => {
  test("a worker with no name given takes its subagent's description", () => {
    meta("t1", { agentType: "general-purpose", description: "Build agent and fleet naming" });
    ok("agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "t1");
    expect(named("a1")).toEqual(["Build agent and fleet naming", "session"]);
  });

  test("its meta.json name comes before its description", () => {
    meta("t1", { description: "/code-review nix", name: "reviewer" });
    ok("agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "t1");
    expect(named("a1")).toEqual(["reviewer", "session"]);
  });

  test("a session name follows the session until someone names the worker", () => {
    ok("agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "t1");
    expect(named("a1")).toEqual(["a1", undefined]);
    meta("t1", { description: "Map fleet naming" });
    ok("event", "tick");
    expect(named("a1")).toEqual(["Map fleet naming", "session"]);
    meta("t1", { description: "Map fleet naming, again" });
    ok("event", "tick");
    expect(named("a1")).toEqual(["Map fleet naming, again", "session"]);
  });

  test("the coordinator's --name is kept over the session's", () => {
    meta("t1", { description: "Map fleet naming" });
    ok("agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "t1", "--name", "mapper");
    expect(named("a1")).toEqual(["mapper", "coordinator"]);
    ok("agent", "a2", "--task", "t", "--milestone", "m1", "--task-id", "t2");
    ok("agent", "a2", "--name", "second");
    meta("t2", { description: "Something else" });
    ok("event", "tick");
    expect(named("a2")).toEqual(["second", "coordinator"]);
  });

  test("a session title change does not overwrite a name the user gave", () => {
    meta("t1", { description: "Map fleet naming" });
    ok("agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "t1", "--name", "mapper");
    expect(renameAgent(machine(env), root, "a1", "Naming map")).toEqual({ name: "Naming map", name_by: "user" });
    meta("t1", { description: "A new title", name: "renamed" });
    ok("event", "tick");
    ok("agent", "a1", "--report", "r");
    expect(named("a1")).toEqual(["Naming map", "user"]);
  });

  test("an empty name clears the user's and the worker goes back to its session's", () => {
    meta("t1", { description: "Map fleet naming" });
    ok("agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "t1");
    renameAgent(machine(env), root, "a1", "Naming map");
    expect(renameAgent(machine(env), root, "a1", "  ")).toEqual({ name: "Map fleet naming", name_by: "session" });
    expect(named("a1")).toEqual(["Map fleet naming", "session"]);
  });

  test("an empty --name puts the id back, and the session's name follows", () => {
    ok("agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "t1", "--name", "mapper");
    ok("agent", "a1", "--name", "");
    expect(named("a1")).toEqual(["a1", undefined]);
    meta("t1", { description: "Map fleet naming" });
    ok("event", "tick");
    expect(named("a1")).toEqual(["Map fleet naming", "session"]);
  });

  test("a session name another worker has, or a chat participant's, is not taken", () => {
    meta("t1", { name: "code-review" });
    meta("t2", { name: "Code-Review" });
    meta("t3", { name: "coordinator" });
    ok("agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "t1");
    ok("agent", "a2", "--task", "t", "--milestone", "m1", "--task-id", "t2");
    ok("agent", "a3", "--task", "t", "--milestone", "m1", "--task-id", "t3");
    expect([named("a1"), named("a2"), named("a3")]).toEqual([
      ["code-review", "session"],
      ["a2", undefined],
      ["a3", undefined],
    ]);
  });

  test("a fleet served outside its session's scratchpad finds its workers under its registered session", () => {
    const elsewhere = join(tmp("state-"), "fleet");
    mkdirSync(elsewhere, { recursive: true });
    expect(fleet(["state", elsewhere, "init", "--project", "q", "--goal", "g", "--no-render"], env).code).toBe(0);
    expect(fleet(["state", elsewhere, "milestone", "m1", "--title", "M", "--no-render"], env).code).toBe(0);
    machine(env).registry.register(elsewhere, "u", process.pid, "2026-10-06T10:00:00+00:00", SESSION);
    meta("t1", { description: "Fleet advisor: review ADR 0040" });
    expect(fleet(["state", elsewhere, "agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "t1", "--no-render"], env).code).toBe(0);
    const a = asObject(asArray(readJson(join(elsewhere, "state.json"))["agents"])?.[0]) ?? {};
    expect([a["name"], a["name_by"]]).toEqual(["Fleet advisor: review ADR 0040", "session"]);
  });

  test("a user's name that a mention could not tell apart is refused, and nothing is written", () => {
    ok("agent", "a1", "--task", "t", "--milestone", "m1");
    ok("agent", "a2", "--task", "t", "--milestone", "m1", "--name", "mapper");
    const refused = renameAgent(machine(env), root, "a1", "Mapper");
    expect("why" in refused ? refused.why : "").toContain("a mention could not tell them apart");
    expect(named("a1")).toEqual(["a1", undefined]);
    expect(renameAgent(machine(env), root, "zz", "x")).toEqual({ why: "no worker 'zz'" });
  });
});

describe("a fleet's name", () => {
  let registry: Registry;

  beforeEach(() => {
    registry = machine(env).registry;
  });

  /** Claude Code's live record of this test's process as session `sessionId`, named `name`. */
  function live(name: string, nameSource: string, sessionId = "sid-1"): void {
    mkdirSync(join(config, "sessions"), { recursive: true });
    writeFileSync(join(config, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, cwd: "/x", name, nameSource, nameSince: 1 }));
  }

  function title(text: string): void {
    mkdirSync(sessionFolder(), { recursive: true });
    writeFileSync(join(sessionFolder(), "custom-title.json"), JSON.stringify({ customTitle: text }));
  }

  function aiTitle(...titles: string[]): void {
    mkdirSync(join(config, "projects", PROJECT), { recursive: true });
    writeFileSync(join(config, "projects", PROJECT, `${SESSION}.jsonl`), titles.map((t) => `${JSON.stringify({ type: "ai-title", aiTitle: t, sessionId: SESSION })}\n`).join(""));
  }

  const register = (): readonly [string, string | null] => {
    const e = registry.register(root, "u", process.pid, "2026-10-06T10:00:00+00:00", "sid-1");

    return [e.id, e.session];
  };

  const now = (): (readonly [string, string | null])[] => registry.live().map((e) => [e.id, e.session] as const);

  test("a derived session name names the fleet", () => {
    live("custom-mcp-servers-df", "derived");
    expect(register()).toEqual(["custom-mcp-servers-df", "custom-mcp-servers-df"]);
  });

  test("a fleet served before its session had a name takes the derived one", () => {
    expect(register()).toEqual(["p", null]);
    live("custom-mcp-servers-df", "derived");
    expect(now()).toEqual([["custom-mcp-servers-df", "custom-mcp-servers-df"]]);
    expect(registry.live()[0]?.aliases).toEqual(["p"]);
  });

  test("another session's live record names nothing", () => {
    live("someone-else", "user", "sid-2");
    expect(register()).toEqual(["p", null]);
  });

  test("the /rename comes before the live record, and the live record before the AI title", () => {
    aiTitle("Old title", "Fleet naming work");
    expect(register()).toEqual(["fleet-naming-work", "Fleet naming work"]);
    live("Infra Lead", "user");
    expect(now()).toEqual([["infra-lead", "Infra Lead"]]);
    title("UI Coordinator");
    expect(now()).toEqual([["ui-coordinator", "UI Coordinator"]]);
  });

  test("a derived name does not undo a name the coordinator gave with `fleets name`", () => {
    register();
    registry.name(root, "billing-coordinator");
    live("custom-mcp-servers-df", "derived");
    aiTitle("Something else");
    expect(now()).toEqual([["billing-coordinator", "billing-coordinator"]]);
  });

  test("the page's name comes before every other, and an empty one gives the fleet back to them", () => {
    title("UI Coordinator");
    register();
    const renamed = registry.rename(root, "Checkout");
    expect("id" in renamed ? [renamed.id, renamed.session] : renamed).toEqual(["checkout", "Checkout"]);
    title("UI Lead");
    expect(now()).toEqual([["checkout", "Checkout"]]);
    expect(register()).toEqual(["checkout", "Checkout"]);
    const cleared = registry.rename(root, "");
    expect("id" in cleared ? [cleared.id, cleared.session] : cleared).toEqual(["ui-lead", "UI Lead"]);
    expect(registry.live()[0]?.aliases).toEqual(["ui-coordinator", "checkout"]);
  });

  test("a page name another fleet holds, or the chat keeps, is refused", () => {
    register();
    const other = join(tmp("scratch-"), "other", "coordinator");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "state.json"), JSON.stringify({ project: "billing" }));
    registry.register(other, "u", process.pid, "2026-10-06T10:00:00+00:00");
    expect(registry.rename(root, "Billing")).toEqual({ why: "another fleet is already called 'billing'; pick another name" });
    expect(registry.rename(root, "user")).toEqual({ why: "'user' cannot name a fleet; the chat keeps ['coordinator', 'manager', 'user'] for itself" });
    expect(now()).toContainEqual(["p", null]);
  });
});

describe("the ledger's lock", () => {
  test("a CLI write and a page rename that meet both land", async () => {
    ok("agent", "a1", "--task", "t", "--milestone", "m1");
    const before = await Bun.file(join(root, "state.json")).text();
    const release = lockLedger(root);

    expect(release).toBeDefined();

    // Both writers start while the lock is held: each must wait, and neither may lose the other's change.
    const cli = Bun.spawn([FLEET, "state", root, "agent", "a1", "--report", "found it", "--no-render"], { env, stdout: "pipe", stderr: "pipe" });

    const rename = `import { renameAgent } from ${JSON.stringify(join(import.meta.dir, "..", "src", "ledger", "rename.ts"))};
import { machineOf } from ${JSON.stringify(join(import.meta.dir, "..", "src", "world.ts"))};
const m = machineOf(() => new Date(), (name) => process.env[name]);
console.log(JSON.stringify(renameAgent(m, ${JSON.stringify(root)}, "a1", "Finder")));`;

    const page = Bun.spawn(["bun", "-e", rename], { env, stdout: "pipe", stderr: "pipe" });

    await Bun.sleep(700);
    expect(await Bun.file(join(root, "state.json")).text()).toBe(before);
    expect([cli.exitCode, page.exitCode]).toEqual([null, null]);
    release?.();

    expect(await cli.exited).toBe(0);
    expect(await page.exited).toBe(0);
    expect(await new Response(page.stdout).text()).toBe(`${JSON.stringify({ name: "Finder", name_by: "user" })}\n`);
    expect([row("a1")["report"], ...named("a1")]).toEqual(["found it", "Finder", "user"]);
  });
});
