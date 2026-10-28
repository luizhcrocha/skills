/**
 * A moved team (fleet slice 3, decision 48): its folder holds cloud.json, its ledger is the cloud's export, and
 * the old CLI's writers refuse it, so a call the hook did not catch (a variable, a relative DIR, a script) cannot
 * write a ledger the export overwrites. Its readers stay.
 */
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { save } from "../src/cli/ws.ts";
import { stampOf } from "../src/clock.ts";
import { asArray, asObject, parseObject } from "../src/json.ts";
import { machineOf } from "../src/world.ts";
import { baseEnv, fleet, readJson, sleep, start, tmp, type Environment } from "./support.ts";

const SENTENCE = "this team records through programs: fleet-run";

let base: string;

let root: string;

let env: Environment;

beforeEach(() => {
  base = tmp();
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
    expect(ran.stderr.replaceAll(base, "<base>")).not.toMatch(/\bjj\b/u);
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

describe("a moved team is told the programs the owner-answer gate leaves it", () => {
  /** Run `state DIR args` on the folder before it moved, then mark it moved again. */
  function beforeMove(...args: string[]): void {
    rmSync(join(root, "cloud.json"));
    const ran = fleet(["state", root, ...args, "--no-render"], env);
    expect(ran.code, ran.stderr).toBe(0);
    writeFileSync(join(root, "cloud.json"), JSON.stringify({ fleet: "skills" }));
  }

  /** Grilling G1, keyed g-f819eec7 as the cloud keys a card, with both questions answered and recorded. */
  function grilled(): void {
    beforeMove("grill", "g-f819eec7", "--title", "Search", "--ask", "Seam | one or many? | one | less code", "--ask", "Tier | local first? | yes | it is faster");
    beforeMove("grill", "g-f819eec7", "--answer", "Q1: one", "--answer", "Q2: yes");
  }

  const GRILL_PROGRAM = 'one program on the stdin of `FLEET_DIR=<dir> fleet-run`: `grill.close("g-f819eec7", "grilling finished"); return records.apply(ops);`';

  test("the coordinator's watch names grill.close with the card's key, not decision.decide or the CLI's --decide", async () => {
    grilled();
    const watch = start(["chat", root, "watch", "--as", "coordinator", "--resume", "--once"], { ...env, FLEET_CHECK_S: "0.2" });
    const line = await watch.lines.next();
    watch.proc.kill();

    expect(line).toBe(`! G1 (Search): every question is answered and the grilling is still open. Close it now with ${GRILL_PROGRAM}.\n`);
  }, 20_000);

  test("`state DIR show` says the grilling's grill.close, not the CLI's --decide", () => {
    grilled();
    const shown = fleet(["state", root, "show"], env);

    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stderr).toContain(`state: every question of G1 (Search) is answered and the grilling is still open; close it before any other work with ${GRILL_PROGRAM}.`);
    expect(shown.stderr).not.toContain("--decide");
  });

  test("`state DIR show` answers the user's line that left a card open on the card, not with decision.decide or the CLI's --decide", () => {
    beforeMove("decision", "d-f819eec7", "--kind", "decision", "--title", "Schema", "--question", "Migrate?", "--why", "W", "--option", "A: a | x", "--option", "B: b | y", "--recommend", "A", "--reason", "R");
    const at = stampOf(new Date(Date.now() + 1000));
    writeFileSync(join(root, "chat.jsonl"), `${JSON.stringify({ id: 1, at, from: "user", to: ["coordinator"], text: "B", decision: "d-f819eec7" })}\n`);
    const shown = fleet(["state", root, "show"], env);

    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stderr).toContain(
      `state: #1 from the user on D1 (Schema) at ${at.slice(11, 16)} left it open: only the user's answer on the card records it. ` +
        "Answer #1 before any other work with one program on the stdin of `FLEET_DIR=<dir> fleet-run`: " +
        '`say("Answer on the card, please: D1.", { re: 1, decision: "d-f819eec7" }); return records.apply(ops);`, ' +
        "or, for a None of these, revise or withdraw D1.",
    );
    expect(shown.stderr).not.toContain("--decide");
    expect(shown.stderr).not.toContain("decision.decide");
  });

  /** Card D1, keyed d-f819eec7, open on the moved team. */
  function card(): void {
    beforeMove("decision", "d-f819eec7", "--kind", "decision", "--title", "Schema", "--question", "Migrate?", "--why", "W", "--option", "A: a | x", "--option", "B: b | y", "--recommend", "A", "--reason", "R");
  }

  /** Action A1, keyed a-f819eec7, open on the moved team. */
  function action(): void {
    beforeMove("decision", "a-f819eec7", "--kind", "action", "--title", "Migrate", "--why", "w", "--question", "Run it", "--manual", "```nu\n./migrate\n```", "--hand", "it needs his key");
  }

  /** Line `id` from the user on card `key`, as the cloud's export appends it, at `at`. */
  function said(id: number, text: string, key: string, at: string): void {
    appendFileSync(join(root, "chat.jsonl"), `${JSON.stringify({ id, at, from: "user", to: ["coordinator"], text, decision: key })}\n`);
  }

  /** The cloud's write of the user's answer to question `index` of the ledger's card `key`, at `at`, with its card left open. */
  function answerOnPage(key: string, index: number, answer: string, at: string, line: number): void {
    const state = readJson(join(root, "state.json"));

    const decisions = (asArray(state["decisions"]) ?? []).map((row) => {
      const d = asObject(row) ?? {};

      if (d["id"] !== key) return d;
      const questions = (asArray(d["questions"]) ?? []).map((q, i) => (i === index ? { ...asObject(q), status: "answered", answer, answered: at, answer_line: line } : q));

      return { ...d, questions };
    });

    writeFileSync(join(root, "state.json"), JSON.stringify({ ...state, decisions }));
  }

  /** `chat DIR wait ...keys`, started, and what it printed once it exited, or "waiting" when it did not within `ms`. */
  async function waited(keys: readonly string[], act: () => void, ms = 6000): Promise<string> {
    const { proc, lines } = start(["chat", root, "wait", ...keys], env);
    await sleep(1500);
    act();
    const code = await Promise.race([proc.exited, sleep(ms).then(() => "waiting" as const)]);

    if (code === "waiting") {
      proc.kill();

      return "waiting";
    }

    return lines.rest();
  }

  test("wait on a grilling whose question the user answered on the page says it is recorded and to re-arm, not to answer on the card", async () => {
    beforeMove("grill", "g-f819eec7", "--title", "Search", "--ask", "Seam | one or many? | one | less code", "--ask", "Tier | local first? | yes | it is faster");

    const out = await waited(["G1"], () => {
      const at = stampOf(new Date());
      answerOnPage("g-f819eec7", 0, "one", at, 1);
      said(1, "Q1: one", "g-f819eec7", at);
    });

    expect(out).toEndWith("-> the user's #1 on G1 is recorded on the card, which stays open: act on it, then re-arm wait G1\n");
    expect(out).not.toContain("Answer on the card");
  }, 20_000);

  test("wait on a grilling whose last question the user answered on the page says its grill.close", async () => {
    beforeMove("grill", "g-f819eec7", "--title", "Search", "--ask", "Seam | one or many? | one | less code", "--ask", "Tier | local first? | yes | it is faster");
    beforeMove("grill", "g-f819eec7", "--answer", "Q1: one");

    const out = await waited(["G1"], () => {
      const at = stampOf(new Date());
      answerOnPage("g-f819eec7", 1, "yes", at, 1);
      said(1, "Q2: yes", "g-f819eec7", at);
    });

    expect(out).toEndWith(`-> the user answered every question of G1 on the card: close it now with ${GRILL_PROGRAM.replace("<dir>", root)}, then answer #1 and act on it\n`);
    expect(out).not.toContain("Answer on the card");
  }, 20_000);

  test("wait on a grilling answered in full before it starts says its grill.close at once", () => {
    grilled();
    const ran = fleet(["chat", root, "wait", "G1"], env);

    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toBe(`-> the user answered every question of G1 on the card: close it now with ${GRILL_PROGRAM.replace("<dir>", root)}\n`);
  });

  test("wait re-armed after the on-card reply to the user's line waits, and `state DIR show` no longer asks for one", async () => {
    card();
    const at = stampOf(new Date(Date.now() + 1000));
    said(1, "B please", "d-f819eec7", at);
    appendFileSync(join(root, "chat.jsonl"), `${JSON.stringify({ id: 2, at, from: "coordinator", to: ["user"], text: "Answer on the card, please: D1.", re: 1, decision: "d-f819eec7" })}\n`);

    expect(await waited(["D1"], () => undefined, 1500)).toBe("waiting");
    const shown = fleet(["state", root, "show"], env);

    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stderr).not.toContain("#1 from the user");
  }, 20_000);

  test("a line still owed a reply is told by `state DIR show` once a reply answers another line", () => {
    card();
    const at = stampOf(new Date(Date.now() + 1000));
    said(1, "B please", "d-f819eec7", at);
    said(2, "or A", "d-f819eec7", at);
    appendFileSync(join(root, "chat.jsonl"), `${JSON.stringify({ id: 3, at, from: "coordinator", to: ["user"], text: "Answer on the card, please: D1.", re: 1, decision: "d-f819eec7" })}\n`);

    expect(fleet(["state", root, "show"], env).stderr).toContain("state: #2 from the user on D1 (Schema)");
  });

  const FAILED_PROGRAMS = (dir: string): string =>
    `one program on the stdin of \`FLEET_DIR=${dir} fleet-run\`: ` +
    '`decision.revise("a-f819eec7", { manual: "..." }, "what changed"); return records.apply(ops);`, or ' +
    '`decision.withdraw("a-f819eec7", "why"); return records.apply(ops);`';

  test("wait on an action that failed gives the programs that revise or withdraw it, not the CLI's --manual or --withdraw", async () => {
    action();
    const out = await waited(["A1"], () => said(1, "Failed: no key", "a-f819eec7", stampOf(new Date())));

    expect(out).toEndWith(`-> the user's step A1 failed, and it is not done: fix it and re-present it, or withdraw it, with ${FAILED_PROGRAMS(root)}; never decide it\n`);
    expect(out).not.toContain("--manual");
  }, 20_000);

  test("`state DIR show` on an action that failed gives the programs that revise or withdraw it, not the CLI's --manual or --withdraw", () => {
    action();
    said(1, "Failed: no key", "a-f819eec7", stampOf(new Date(Date.now() + 1000)));
    const shown = fleet(["state", root, "show"], env);

    expect(shown.stderr).toContain(`It is not done: fix what failed and re-present it, or withdraw it, with ${FAILED_PROGRAMS("<dir>")}; never decide it.`);
    expect(shown.stderr).not.toContain("--manual");
    expect(shown.stderr).not.toContain("--withdraw");
  });

  test("wait on a card withdrawn as the user wrote says it is withdrawn, not answered on the card", async () => {
    card();

    const out = await waited(["D1"], () => {
      const state = readJson(join(root, "state.json"));
      const decisions = (asArray(state["decisions"]) ?? []).map((d) => ({ ...asObject(d), status: "withdrawn", resolution: "not needed" }));
      writeFileSync(join(root, "state.json"), JSON.stringify({ ...state, decisions }));
      said(1, "B please", "d-f819eec7", stampOf(new Date()));
    });

    expect(out).toEndWith("D1 is already withdrawn: not needed\n");
    expect(out).not.toContain("answered D1 on the card");
  }, 20_000);
});
