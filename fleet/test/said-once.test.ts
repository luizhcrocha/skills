/**
 * The state warnings said once (fleet/src/ledger/said-once.ts): an informational line is said once per mark, again
 * when its mark changes or $FLEET_WARN_AGAIN_S after it was said; a line that asks for an act repeats on every
 * command; FLEET_WARN_AGAIN_S=0 says every line every time and keeps no file.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { baseEnv, fleet, readJson, tmp, type Environment } from "./support.ts";

let root: string;

let env: Environment;

/** 2026-01-05 at 09:00 UTC plus `min` minutes, as FLEET_NOW takes it. */
function at(min: number): string {
  return new Date(Date.UTC(2026, 0, 5, 9, min)).toISOString().replace(".000Z", "+00:00");
}

function stderrOf(min: number, args: readonly string[], more: Environment = {}): string {
  const ran = fleet(["state", root, ...args, "--no-render"], { ...env, FLEET_NOW: at(min), ...more });
  expect(ran.code, ran.stderr).toBe(0);

  return ran.stderr;
}

const STALE = "the page's Now line";

beforeEach(() => {
  const base = tmp();
  root = join(base, "coordinator");
  env = baseEnv(join(base, "registry"));
  stderrOf(0, ["init", "--project", "p", "--goal", "g"]);
  stderrOf(0, ["milestone", "m1", "--title", "M"]);
});

describe("an informational warning", () => {
  test("is said once, then again 30 minutes after it was said", () => {
    expect(stderrOf(31, ["event", "x"])).toContain(STALE);
    expect(stderrOf(32, ["event", "x"])).not.toContain(STALE);
    expect(stderrOf(60, ["event", "x"])).not.toContain(STALE);
    expect(stderrOf(62, ["event", "x"])).toContain(STALE);
    expect(Object.keys(readJson(join(root, "state-warnings.told")))).toContain("now");
  });

  test("is said again when its mark changes, however soon", () => {
    const later = { FLEET_WARN_AGAIN_S: "7200" };
    expect(stderrOf(31, ["event", "x"], later)).toContain(STALE);
    stderrOf(32, ["set", "--now", "Parsing the invoices."], later);
    expect(stderrOf(40, ["event", "x"], later)).not.toContain(STALE);
    // the new Now line goes stale: its age is not its mark, its words and stamp are
    expect(stderrOf(63, ["event", "x"], later)).toContain(STALE);
    expect(stderrOf(90, ["event", "x"], later)).not.toContain(STALE);
  });

  test("FLEET_WARN_AGAIN_S=0 says it on every command and keeps no file", () => {
    const always = { FLEET_WARN_AGAIN_S: "0" };
    expect(stderrOf(31, ["event", "x"], always)).toContain(STALE);
    expect(stderrOf(32, ["event", "x"], always)).toContain(STALE);
    expect(existsSync(join(root, "state-warnings.told"))).toBe(false);
  });
});

describe("a warning that asks for an act", () => {
  test("repeats on every command until it is done", () => {
    const stale = "still read as running/queued/blocked while the fleet is paused";
    stderrOf(1, ["set", "--now", "Working."]);
    stderrOf(1, ["agent", "a1", "--task", "t", "--milestone", "m1"]);
    expect(stderrOf(2, ["set", "--status", "paused"])).toContain(stale);
    expect(stderrOf(3, ["event", "x"])).toContain(stale);
    expect(stderrOf(4, ["event", "x"])).toContain(stale);
    stderrOf(5, ["park", "the user stopped"]);
    expect(stderrOf(6, ["event", "x"])).not.toContain(stale);
  });
});
