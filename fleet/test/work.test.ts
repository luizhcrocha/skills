/**
 * `fleet work due` (fleet/src/cli/work.ts) and `state DIR show`'s `work:` warning, against a fleet-run stub: the
 * answers due as JSON, the count on `show` from a read kept a minute, and a host that does not answer in time or
 * fails leaving `show` silent.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { baseEnv, fleet, tmp, type Environment } from "./support.ts";

let base: string;

let root: string;

let env: Environment;

/** fleet-run answering `rows` (or failing with `exit`), counting its calls and keeping what it was sent; with `sleepS`,
 * one that answers nothing for that long (`exec`, as the real shim runs its client, so the kill reaches it). */
function host(rows: readonly unknown[], { exit = 0, sleepS = 0 } = {}): Environment {
  const bin = join(base, "fleet-run");
  writeFileSync(join(base, "run.answer"), JSON.stringify({ id: "r", status: "completed", result: rows }));
  writeFileSync(
    bin,
    `#!/bin/sh\necho x >>"${base}/run.calls"\nprintf '%s' "$FLEET_DIR" >"${base}/run.dir"\ncat >"${base}/run.program"\n${sleepS > 0 ? `exec sleep ${String(sleepS)}\n` : ""}cat "${base}/run.answer"\nexit ${String(exit)}\n`,
  );
  chmodSync(bin, 0o755);

  return { ...env, TSTACK_FLEET_RUN: bin };
}

function calls(): number {
  const path = join(base, "run.calls");

  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "").length : 0;
}

/** 2026-01-05 at 09:00 UTC plus `s` seconds. */
function at(s: number): string {
  return new Date(Date.UTC(2026, 0, 5, 9, 0, s)).toISOString().replace(".000Z", "+00:00");
}

const ROW = { tag: "work done k1@abc 2026-01-05T08:00:00Z", by: "User", title: "Parse" };

beforeEach(() => {
  base = tmp();
  root = join(base, "skills");
  env = { ...baseEnv(join(base, "registry")), FLEET_NOW: at(0) };
  expect(fleet(["state", root, "init", "--project", "p", "--goal", "g", "--no-render"], env).code).toBe(0);
  writeFileSync(join(root, "cloud.json"), JSON.stringify({ fleet: "skills" }));
});

describe("fleet work due", () => {
  test("prints the answers due as JSON, read through fleet-run with the team's id and its folder", () => {
    const ran = fleet(["work", "due", root], host([ROW, { ...ROW, title: "Ship" }]));
    expect(ran.code, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual([ROW, { ...ROW, title: "Ship" }]);
    expect(readFileSync(join(base, "run.program"), "utf8")).toContain('const team = "skills";');
    expect(readFileSync(join(base, "run.dir"), "utf8")).toBe(root);
  });

  test("prints [] when none is due", () => {
    expect(fleet(["work", "due", root], host([])).stdout).toBe("[]\n");
  });

  test("refuses when the read fails, and a folder that is no moved team", () => {
    const failed = fleet(["work", "due", root], host([], { exit: 3 }));
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("the work page's answers did not read");
    const plain = join(base, "plain");
    fleet(["state", plain, "init", "--project", "p", "--goal", "g", "--no-render"], env);
    const refused = fleet(["work", "due", plain], host([]));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("holds no cloud.json");
  });
});

describe("show's work warning", () => {
  test("counts the answers due, one in the singular", () => {
    expect(fleet(["state", root, "show"], host([ROW, ROW])).stderr).toContain("work: 2 answers due; fleet work due\n");
    expect(fleet(["state", root, "show"], { ...host([ROW]), FLEET_NOW: at(61) }).stderr).toContain("work: 1 answer due; fleet work due\n");
  });

  test("none due says nothing", () => {
    expect(fleet(["state", root, "show"], host([])).stderr).not.toContain("work:");
  });

  test("reuses the count read within a minute, and repeats it while it stands", () => {
    const due = host([ROW, ROW]);
    expect(fleet(["state", root, "show"], due).stderr).toContain("work: 2 answers due");
    expect(fleet(["state", root, "show"], { ...due, FLEET_NOW: at(59) }).stderr).toContain("work: 2 answers due");
    expect(calls()).toBe(1);
    expect(fleet(["state", root, "show"], { ...due, FLEET_NOW: at(60) }).stderr).toContain("work: 2 answers due");
    expect(calls()).toBe(2);
  });

  test("`work due` refreshes the count show reuses", () => {
    fleet(["work", "due", root], host([ROW]));
    expect(fleet(["state", root, "show"], host([ROW, ROW, ROW])).stderr).toContain("work: 1 answer due");
    expect(calls()).toBe(1);
  });

  test("a host that does not answer in 2 s leaves show silent and unheld", () => {
    const started = Date.now();
    const ran = fleet(["state", root, "show"], host([ROW], { sleepS: 6 }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).not.toContain("work:");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a failed read leaves show silent", () => {
    const ran = fleet(["state", root, "show"], host([ROW], { exit: 3 }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).not.toContain("work:");
  });
});
