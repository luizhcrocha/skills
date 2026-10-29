/**
 * The coordinator's watch names a step its worker left: current under a done worker, or open under a stopped or
 * failed one, once per worker change (watch.ts `strandedSteps`).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { strandedSteps } from "../src/chat/watch.ts";
import type { Json, JsonObject } from "../src/json.ts";
import { baseEnv, fleet, readJson, tmp } from "./support.ts";

let root: string;

beforeEach(() => {
  const base = tmp("fleet-stranded-");
  root = join(base, "coordinator");
  const env = baseEnv(join(base, "registry"), { FLEET_NOW: "2026-01-05T09:00:00+00:00", TZ: "UTC" });
  const ran = fleet(["state", root, "init", "--project", "p", "--goal", "g", "--no-render"], env);
  expect(ran.code, ran.stderr).toBe(0);
});

function worker(id: string, status: string, updated = "2026-01-05T09:00:00Z"): JsonObject {
  return { id, name: id, task: "t", status, lane: [], milestone: "m1", updated };
}

function team(steps: readonly JsonObject[], agents: readonly JsonObject[]): void {
  const state = { ...readJson(join(root, "state.json")), roadmap: [{ id: "m1", title: "Login", steps: [...steps] }], agents: [...agents] };

  writeFileSync(join(root, "state.json"), JSON.stringify(state));
}

const STEP_CLI = "`fleet state <dir> step s3 --milestone m1 --status done`";

const STEP_PROGRAM =
  'one program on the stdin of `FLEET_DIR=<dir> fleet-run`: `step("m1", "s3", "Session store", "done", "w2"); return records.apply(ops);`';

describe("strandedSteps", () => {
  test("a current step under a done worker is named once, with the old CLI's step command", () => {
    team([{ id: "s3", title: "Session store", status: "current", agent: "w2" }], [worker("w2", "done")]);
    const told = new Map<string, Json>();

    expect(strandedSteps(root, told)).toEqual([
      `! m1/s3 (Session store): its worker w2 is done and the step is still current. Close it now with ${STEP_CLI}, or hand it to another worker.`,
    ]);
    expect(strandedSteps(root, told)).toEqual([]);
  });

  test("a moved team is told the program", () => {
    writeFileSync(join(root, "cloud.json"), JSON.stringify({ fleet: "skills" }));
    team([{ id: "s3", title: "Session store", status: "current", agent: "w2" }], [worker("w2", "done")]);

    expect(strandedSteps(root, new Map())).toEqual([
      `! m1/s3 (Session store): its worker w2 is done and the step is still current. Close it now with ${STEP_PROGRAM}, or hand it to another worker.`,
    ]);
  });

  test("an open step under a stopped or failed worker is named, a pending one under a done worker is not", () => {
    team(
      [
        { id: "s1", title: "Form", status: "pending", agent: "w1" },
        { id: "s2", title: "Store", status: "current", agent: "w2" },
        { id: "s4", title: "Docs", status: "pending", agent: "w4" },
        { id: "s5", title: "Done already", status: "done", agent: "w2" },
      ],
      [worker("w1", "stopped"), worker("w2", "failed"), worker("w4", "done")],
    );
    const lines = strandedSteps(root, new Map());

    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("! m1/s1 (Form): its worker w1 stopped and the step is still pending. Retake it");
    expect(lines[0]).toContain("`fleet state <dir> step s1 --milestone m1 --status current --agent <new worker>`");
    expect(lines[1]).toStartWith("! m1/s2 (Store): its worker w2 failed and the step is still current.");
  });

  test("a moved team is told the programs that retake it or drop it", () => {
    writeFileSync(join(root, "cloud.json"), JSON.stringify({ fleet: "skills" }));
    team([{ id: "s3", title: "Session store", status: "current", agent: "w2" }], [worker("w2", "stopped")]);

    expect(strandedSteps(root, new Map())).toEqual([
      "! m1/s3 (Session store): its worker w2 stopped and the step is still current. Retake it with a fresh worker, or drop it and its changes: " +
        'one program on the stdin of `FLEET_DIR=<dir> fleet-run`: `step("m1", "s3", "Session store", "current", "<new worker>"); return records.apply(ops);`, ' +
        'or `step("m1", "s3", "Session store", "dropped", "w2"); return records.apply(ops);`.',
    ]);
  });

  test("a worker that changes again is named again", () => {
    team([{ id: "s3", title: "Session store", status: "current", agent: "w2" }], [worker("w2", "done")]);
    const told = new Map<string, Json>();
    strandedSteps(root, told);
    team([{ id: "s3", title: "Session store", status: "current", agent: "w2" }], [worker("w2", "done", "2026-01-05T10:00:00Z")]);

    expect(strandedSteps(root, told)).toHaveLength(1);
  });

  test("a running worker's step is not named", () => {
    team([{ id: "s3", title: "Session store", status: "current", agent: "w2" }], [worker("w2", "running")]);

    expect(strandedSteps(root, new Map())).toEqual([]);
  });
});
