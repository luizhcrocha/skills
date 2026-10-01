/**
 * Heartbeats as the hub and the page read them: which worker a heartbeat file is, when each worker was
 * last seen (its heartbeat first, its transcript without one), and the silent-worker rule on top.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { silentWorkers } from "../src/health.ts";
import { readBeats, workerActivity, workerOf, type Beat } from "../src/heartbeat.ts";
import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { cliLookups } from "../src/page/lookups.ts";
import { view } from "../src/page/view.ts";
import { machineOf, type Machine } from "../src/world.ts";
import { baseEnv, fleet, tmp } from "./support.ts";

const NOW = Date.parse("2026-01-05T10:00:00Z");

let base: string;

let config: string;

let dir: string;

let machine: Machine;

const SESSION = "5e55";

let zone: string | undefined;

afterEach(() => {
  if (zone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = zone;
});

beforeEach(() => {
  zone = process.env["TZ"];
  process.env["TZ"] = "UTC";
  base = tmp("fleet-beat-");
  config = join(base, "config");
  // the fleet lives in its session's scratchpad, so its workers' transcripts can be found too
  dir = join(base, "tmp", "-proj", SESSION, "scratchpad", "coordinator");
  mkdirSync(join(dir, "heartbeats"), { recursive: true });

  const env = new Map([
    ["CLAUDE_CONFIG_DIR", config],
    ["FLEET_HOME", join(base, "registry")],
    ["FLEET_DISCOVER", "0"],
    ["HOME", base],
  ]);

  machine = machineOf(
    () => new Date(NOW),
    (name) => env.get(name),
  );
});

function beat(name: string, fields: JsonObject): void {
  writeFileSync(join(dir, "heartbeats", `${name}.json`), JSON.stringify({ session: SESSION, agent: null, worker: null, cwd: "/", workspace: null, path: null, tool: "Bash", event: "PostToolUse", at: "2026-01-05T09:58:00+00:00", ...fields }));
}

function ledger(more: JsonObject = {}): JsonObject {
  return {
    project: "p",
    goal: "g",
    status: "running",
    now: "n",
    started: "s",
    roadmap: [],
    roadblocks: [],
    events: [],
    agents: [
      { id: "a1", name: "one", task: "t", status: "running", lane: [], milestone: "m1", task_id: "t-a1" },
      { id: "a2", name: "two", task: "t", status: "running", lane: [], milestone: "m1" },
      { id: "a3", name: "three", task: "t", status: "blocked", lane: [], milestone: "m1" },
    ],
    ...more,
  };
}

/** A subagent transcript of this session whose first line gives the worker its id. */
function transcript(agent: string, worker: string, at: number): void {
  const folder = join(config, "projects", "-proj", SESSION, "subagents");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `agent-${agent}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ message: { content: `Read brief.md first; your id is ${worker}.` } })}\n`);
  utimesSync(path, at / 1000, at / 1000);
}

describe("which worker beat", () => {
  const plain: Beat = { session: SESSION, agent: null, worker: null, cwd: null, workspace: null, path: null, tool: null, event: null, stamp: "", at: 0, transcript: null, agentTranscript: null };
  const state = ledger({ workspaces: [{ id: "lane-b", agent: "a3", path: "/repos/p-lane-b", status: "active" }, { id: "old", agent: "a2", path: "/repos/p-old", status: "pruned" }] });
  const none = (): undefined => undefined;

  test("$FLEET_WORKER, then the task id, then the transcript's brief", () => {
    expect(workerOf({ ...plain, worker: "a2", agent: "t-a1" }, state, none)).toBe("a2");
    expect(workerOf({ ...plain, worker: "nobody", agent: "t-a1" }, state, none)).toBe("a1");
    expect(workerOf({ ...plain, agent: "x9", transcript: "/c/projects/-proj/5e55.jsonl" }, state, (p) => (p === "/c/projects/-proj/5e55/subagents/agent-x9.jsonl" ? "a2" : undefined))).toBe("a2");
    expect(workerOf({ ...plain, agent: "x9", agentTranscript: "/t/agent-x9.jsonl" }, state, (p) => (p === "/t/agent-x9.jsonl" ? "a3" : undefined))).toBe("a3");
  });

  test("the workspace fleet ws add made, by name, cwd or path; a workspace named after the worker", () => {
    expect(workerOf({ ...plain, workspace: "lane-b" }, state, none)).toBe("a3");
    expect(workerOf({ ...plain, cwd: "/repos/p-lane-b/src" }, state, none)).toBe("a3");
    expect(workerOf({ ...plain, cwd: "/repos/p", path: "/repos/p-lane-b/a.ts" }, state, none)).toBe("a3");
    expect(workerOf({ ...plain, cwd: "/repos/p-lane-bb" }, state, none)).toBeUndefined();
    expect(workerOf({ ...plain, cwd: "/repos/p-old" }, state, none)).toBeUndefined(); // pruned
    expect(workerOf({ ...plain, workspace: "a2" }, state, none)).toBe("a2");
    expect(workerOf({ ...plain, workspace: "default" }, state, none)).toBeUndefined(); // the coordinator itself
  });
});

describe("last seen", () => {
  test("the newest heartbeat of each worker; a file that does not parse is skipped", () => {
    beat(`${SESSION}.t-a1`, { agent: "t-a1", tool: "Edit", at: "2026-01-05T09:50:00+00:00" });
    beat(`${SESSION}.x2`, { agent: "x2", worker: "a1", tool: "Read", at: "2026-01-05T09:55:00+00:00" });
    writeFileSync(join(dir, "heartbeats", "broken.json"), "{");
    writeFileSync(join(dir, "heartbeats", ".tmp.json"), "{}");
    expect(readBeats(dir).length).toBe(2);
    expect(workerActivity(dir, config, ledger()).get("a1")).toEqual({ at: Date.parse("2026-01-05T09:55:00Z") / 1000, by: "heartbeat", tool: "Read", event: "PostToolUse" });
  });

  test("the transcript stands in for a worker with no heartbeat, never over one", () => {
    transcript("x2", "a2", NOW - 60_000);
    transcript("t-a1", "a1", NOW - 60_000);
    beat(`${SESSION}.t-a1`, { agent: "t-a1", at: "2026-01-05T09:30:00+00:00" });
    const seen = workerActivity(dir, config, ledger());
    expect(seen.get("a1")?.by).toBe("heartbeat");
    expect(seen.get("a1")?.at).toBe(Date.parse("2026-01-05T09:30:00Z") / 1000);
    expect(seen.get("a2")).toEqual({ at: (NOW - 60_000) / 1000, by: "transcript", tool: null, event: null });
  });

  test("silence is twenty minutes without a tool call", () => {
    beat(`${SESSION}.t-a1`, { agent: "t-a1", at: "2026-01-05T09:39:59+00:00" }); // 20 min 1 s
    beat("w2", { worker: "a2", at: "2026-01-05T09:40:00+00:00" }); // exactly 20 min: not yet
    beat("w3", { worker: "a3", at: "2026-01-05T09:00:00+00:00" });
    const silent = silentWorkers(machine, dir, ledger()).map((w) => [w.id, w.active]);
    expect(silent).toEqual([
      ["a3", "2026-01-05T09:00:00+00:00"],
      ["a1", "2026-01-05T09:39:59+00:00"],
    ]);
    // a worker the ledger no longer runs is never silent
    expect(silentWorkers(machine, dir, ledger({ agents: [{ id: "a3", name: "x", task: "t", status: "done", lane: [], milestone: "m" }] }))).toEqual([]);
  });

  test("`fleets show` marks a silent worker under its row, so the manager checks it before saying it runs", () => {
    beat("w3", { worker: "a3", at: "2026-01-05T09:00:00+00:00" });
    beat("w2", { worker: "a2", at: "2026-01-05T09:58:00+00:00" });
    writeFileSync(join(dir, "state.json"), JSON.stringify(ledger({ agents: asArray(ledger()["agents"])?.slice(1) ?? [] })));
    mkdirSync(join(base, "registry"), { recursive: true });
    writeFileSync(join(base, "registry", "acme.json"), JSON.stringify({ id: "acme", role: "coordinator", dir, url: "http://box/f/acme/", pid: process.pid, session: null, since: "t" }));
    const env = baseEnv(join(base, "registry"), { CLAUDE_CONFIG_DIR: config, FLEET_NOW: "2026-01-05T10:00:00+00:00", TZ: "UTC" });
    const lines = fleet(["fleets", "show", "acme"], env).stdout.split("\n");
    const a3 = lines.findIndex((l) => l.startsWith("    a3 (three) blocked"));
    expect(lines[a3 + 1]).toBe("        silent since 09:00: check it before saying it runs");
    expect(lines.some((l) => l.startsWith("        silent") && lines[lines.indexOf(l) - 1]?.startsWith("    a2"))).toBe(false);
  });

  test("the page's view: active from the heartbeat, with what it last ran; none without one", () => {
    beat("w1", { worker: "a1", tool: "Edit", at: "2026-01-05T09:58:00+00:00" });
    const agents = (asArray(view(machine, cliLookups(), ledger(), dir)["agents"]) ?? []).map(asObject);
    expect(agents[0]).toMatchObject({ id: "a1", active: "2026-01-05T09:58:00+00:00", beat: { tool: "Edit", event: "PostToolUse" } });
    expect(agents[1]?.["active"]).toBeUndefined();
    expect(agents[1]?.["beat"]).toBeUndefined();
  });
});
