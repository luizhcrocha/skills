/**
 * A moved team (fleet slice 3, decision 48): its folder holds cloud.json, its ledger is the cloud's export, and
 * the old CLI's writers refuse it, so a call the hook did not catch (a variable, a relative DIR, a script) cannot
 * write a ledger the export overwrites. Its readers stay.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { save } from "../src/cli/ws.ts";
import { parseObject } from "../src/json.ts";
import { machineOf } from "../src/world.ts";
import { baseEnv, fleet, tmp, type Environment } from "./support.ts";

const SENTENCE = "this team records through programs: fleet-run";

let root: string;

let env: Environment;

beforeEach(() => {
  const base = tmp();
  root = join(base, "skills");
  env = baseEnv(join(base, "registry"));
  expect(fleet(["state", root, "init", "--project", "p", "--goal", "g", "--no-render"], env).code).toBe(0);
  expect(fleet(["state", root, "milestone", "m1", "--title", "M", "--no-render"], env).code).toBe(0);
  writeFileSync(join(root, "cloud.json"), JSON.stringify({ fleet: "skills" }));
});

describe("a folder holding cloud.json", () => {
  const writers: readonly (readonly string[])[] = [
    ["event", "--kind", "note", "a note"],
    ["set", "--now", "elsewhere"],
    ["step", "s1", "--milestone", "m1", "--title", "T"],
    ["decision", "D1", "--decide", "x"],
    ["init", "--project", "p", "--goal", "g"],
  ];

  for (const args of writers) {
    test(`refuses \`state DIR ${args[0] ?? ""}\` with decision 48's sentence and leaves state.json as it was`, () => {
      const before = readFileSync(join(root, "state.json"), "utf8");
      const ran = fleet(["state", root, ...args, "--no-render"], env);

      expect(ran.code).toBe(1);
      expect(ran.stderr).toContain(SENTENCE);
      expect(ran.stderr).toContain(join(root, "cloud.json"));
      expect(readFileSync(join(root, "state.json"), "utf8")).toBe(before);
    });
  }

  test("refuses `chat DIR say` and appends nothing to chat.jsonl", () => {
    const ran = fleet(["chat", root, "say", "--as", "coordinator", "hello"], env);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(SENTENCE);
    expect(fleet(["chat", root, "log"], env).stdout).not.toContain("hello");
  });

  const wsWriters: readonly (readonly string[])[] = [["add", "w3"], ["split", "w2", "-m", "w2: done"], ["prune", "--apply"]];

  for (const args of wsWriters) {
    test(`refuses \`ws DIR ${args[0] ?? ""}\` and leaves state.json as it was`, () => {
      const before = readFileSync(join(root, "state.json"), "utf8");
      const ran = fleet(["ws", root, ...args], env);

      expect(ran.code).toBe(1);
      expect(ran.stderr).toContain(SENTENCE);
      expect(readFileSync(join(root, "state.json"), "utf8")).toBe(before);
    });
  }

  test("still reads: `ws DIR list` and a dry-run `ws DIR prune`", () => {
    for (const args of [["list"], ["prune"]]) {
      const ran = fleet(["ws", root, ...args], env);

      expect(ran.stderr).not.toContain(SENTENCE);
    }
  });

  test("still reads: `state DIR show` and `chat DIR log`", () => {
    const shown = fleet(["state", root, "show"], env);
    const log = fleet(["chat", root, "log"], env);

    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("m1");
    expect(log.code, log.stderr).toBe(0);
  });

  test("a relative DIR is the same folder", () => {
    const here = process.cwd();
    process.chdir(join(root, ".."));
    const ran = fleet(["state", "skills", "event", "--kind", "note", "x", "--no-render"], env);
    process.chdir(here);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(SENTENCE);
  });

  test("refuses `preview DIR set` and leaves state.json as it was", () => {
    const before = readFileSync(join(root, "state.json"), "utf8");
    const ran = fleet(["preview", root, "set", "--cmd", "bun dev"], env);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(SENTENCE);
    expect(readFileSync(join(root, "state.json"), "utf8")).toBe(before);
  });

  test("refuses `preview DIR start` before it makes a workspace or starts a server; `preview DIR status` still reads", () => {
    const ran = fleet(["preview", root, "start", "--cmd", "bun dev"], env);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(SENTENCE);
    expect(ran.stderr).not.toContain("jj");
    expect(fleet(["preview", root, "status"], env).stderr).not.toContain(SENTENCE);
  });

  test("refuses `render DIR/state.json OUT` and leaves state.json as it was", () => {
    const before = readFileSync(join(root, "state.json"), "utf8");
    const ran = fleet(["render", join(root, "state.json"), join(root, "index.html")], env);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(SENTENCE);
    expect(readFileSync(join(root, "state.json"), "utf8")).toBe(before);
  });

  test("every writer that saves through ws's save() is refused there, the hook's report among them", () => {
    const path = join(root, "state.json");
    const before = readFileSync(path, "utf8");
    const raw = Option.getOrThrow(parseObject(before));
    const fault = save(machineOf(() => new Date("2026-10-14T12:00:00Z"), () => undefined), root, raw, undefined, []);

    expect(fault?.reason).toContain(SENTENCE);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
