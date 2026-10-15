/**
 * A moved team (fleet slice 3, decision 48): its folder holds cloud.json, its ledger is the cloud's export, and
 * the old CLI's writers refuse it, so a call the hook did not catch (a variable, a relative DIR, a script) cannot
 * write a ledger the export overwrites. Its readers stay.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { save } from "../src/cli/ws.ts";
import { parseObject } from "../src/json.ts";
import { machineOf } from "../src/world.ts";
import { baseEnv, fleet, sleep, start, tmp, type Environment } from "./support.ts";

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

describe("the coordinator's --once watch on a moved team", () => {
  /** Lines in the old chat store's shape (`re` and `parts` written out, a hub's `origin`), as the folder held them before the move. */
  function before(count: number): string {
    return Array.from({ length: count }, (_, i) => `${JSON.stringify({ id: i + 1, at: "2026-10-15T08:00:00+00:00", from: "coordinator", to: ["user"], text: `m${i + 1}`, re: null, parts: [{ text: `m${i + 1}` }], origin: "http://127.0.0.1:7420" })}\n`).join("");
  }

  /** The same lines as the host's export writes them (chatFileText: one compact line, no default fields). */
  function exported(count: number): string {
    return Array.from({ length: count }, (_, i) => `${JSON.stringify({ id: i + 1, at: "2026-10-15T08:00:00+00:00", from: "coordinator", to: ["user"], text: `m${i + 1}` })}\n`).join("");
  }

  async function woken(write: () => void): Promise<string> {
    writeFileSync(join(root, "chat.jsonl"), before(104));
    writeFileSync(join(root, "watch-coordinator.cursor"), "104");
    const { proc, lines } = start(["chat", root, "watch", "--as", "coordinator", "--all", "--resume", "--once"], env);
    await sleep(800);
    expect(proc.exitCode).toBeNull();
    write();
    const done = await Promise.race([proc.exited, sleep(5000).then(() => "still waiting" as const)]);

    if (done === "still waiting") proc.kill();
    expect(done).toBe(0);

    return lines.rest();
  }

  test("wakes on the user's answer the export appends", async () => {
    const answer = { id: 105, from: "user", to: ["coordinator"], text: "go ahead", decision: "s4-smoke" };

    expect(await woken(() => writeFileSync(join(root, "chat.jsonl"), `${JSON.stringify(answer)}\n`, { flag: "a" }))).toContain("#105 user -> coordinator [s4-smoke]: go ahead");
  });

  test("wakes on the user's answer when the export rewrites chat.jsonl whole, longer than the watch had read", async () => {
    // export.ts rewrites the file in place when its last line is not the fleet's: the lines before the answer get
    // shorter, the answer is long, and the file ends past the offset the watch had read to.
    const shrunk = before(104).length - exported(104).length;
    const answer = { id: 105, from: "user", to: ["coordinator"], text: `go ahead ${"x".repeat(shrunk)}`, decision: "s4-smoke" };

    expect(await woken(() => writeFileSync(join(root, "chat.jsonl"), `${exported(104)}${JSON.stringify(answer)}\n`))).toContain("#105 user -> coordinator [s4-smoke]: go ahead");
  });
});

describe("a permission on a moved team", () => {
  /** A permission the hook opened before the move, with no recommendation, as the cloud's export keeps it. */
  function openedBeforeMove(): void {
    rmSync(join(root, "cloud.json"));
    const opened = fleet(["state", root, "decision", "p1", "--kind", "permission", "--title", "t", "--question", "q", "--why", "w", "--tool", "Bash", "--call", "make deploy", "--cause", "[Real-World Transactions]", "--root", root, "--blocking", "--no-render"], env);
    expect(opened.code, opened.stderr).toBe(0);
    writeFileSync(join(root, "cloud.json"), JSON.stringify({ fleet: "skills" }));
  }

  test("the coordinator's --once watch asks for no explanation, which a program could not give", async () => {
    openedBeforeMove();
    const watch = start(["chat", root, "watch", "--as", "coordinator", "--resume", "--once"], { ...env, FLEET_CHECK_S: "0.2" });
    await sleep(1500);
    const exited = watch.proc.exitCode;
    watch.proc.kill();

    expect(exited).toBeNull();
  }, 20_000);

  test("`state DIR show` names no `--recommend` command, which the CLI refuses there", () => {
    openedBeforeMove();
    const shown = fleet(["state", root, "show"], env);

    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stderr).not.toContain("explain it now");
    expect(shown.stderr).not.toContain("--recommend");
  });
});
