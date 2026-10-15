/**
 * The machine's numbers: decisions, links, roadblocks and approvals numbered from one counter per letter in
 * the registry (`ledger/shared-numbers.ts`), so a number names one item across the machine's fleets; a
 * ledger whose registry is unreachable numbers alone, and says so.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as Option from "effect/Option";

import { Refusal } from "../src/errors.ts";
import { asArray, asObject, asString, type JsonObject } from "../src/json.ts";
import { parseLedger } from "../src/ledger/model.ts";
import { numberOnMachine } from "../src/ledger/shared-numbers.ts";
import { holdExclusiveLock, LockFailed } from "../src/lock.ts";
import { baseEnv, FLEET, fleet, machine, readJson, tmp, type Environment, type Ran } from "./support.ts";

const CHOICE = ["--kind", "decision", "--title", "T", "--why", "w", "--question", "Q?", "--option", "A: yes | y", "--option", "B: no | n", "--recommend", "A", "--reason", "r", "--advised", "none:test"];

let base: string;

let home: string;

let env: Environment;

function at(dir: string, ...args: string[]): Ran {
  return fleet(["state", dir, ...args, "--no-render"], env);
}

function ok(dir: string, ...args: string[]): Ran {
  const result = at(dir, ...args);
  expect(result.code, result.stderr).toBe(0);

  return result;
}

function rows(dir: string, key: string): JsonObject[] {
  return (asArray(readJson(join(dir, "state.json"))[key]) ?? []).map((r) => asObject(r) ?? {});
}

function refs(dir: string, key = "decisions"): (string | undefined)[] {
  return rows(dir, key).map((r) => asString(r["ref"]));
}

/** `row` as an old ledger kept it, without a number. */
function unnumbered(row: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "ref"));
}

/** Serve `dir` as fleet `name` in the registry. */
function serve(name: string, dir: string, pid = process.pid): void {
  writeFileSync(join(home, `${name}.json`), JSON.stringify({ id: name, role: "coordinator", dir, url: `http://box/f/${name}/`, pid, session: null, since: "2026-01-05T08:00:00+00:00" }));
}

beforeEach(() => {
  base = tmp();
  home = join(base, "registry");
  mkdirSync(home);
  env = baseEnv(home);
  ok(join(base, "a"), "init", "--project", "a", "--goal", "g");
  ok(join(base, "b"), "init", "--project", "b", "--goal", "g");
  serve("a", join(base, "a"));
  serve("b", join(base, "b"));
});

describe("the machine's numbers", () => {
  test("two fleets numbering at once never give one number twice", async () => {
    const dirs = [join(base, "a"), join(base, "b")];

    const runs = dirs.flatMap((dir) =>
      [1, 2, 3, 4].map((i) => Bun.spawn([FLEET, "state", dir, "decision", `d${String(i)}`, ...CHOICE, "--no-render"], { env, stdout: "pipe", stderr: "pipe" })),
    );

    // Each fleet's own ledger lock serializes its four; the two fleets race each other on the counter.
    for (const p of runs) expect(await p.exited).toBe(0);
    const all = dirs.flatMap((dir) => refs(dir));
    expect(all).toHaveLength(8);
    expect(new Set(all).size).toBe(8);
    expect([...all].sort()).toEqual(["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"]);
    expect(readJson(join(home, "numbers", "numbers.json"))).toEqual({ D: 8 });
  });

  test("each letter has its own counter, shared by every fleet", () => {
    ok(join(base, "a"), "decision", "d1", ...CHOICE);
    ok(join(base, "b"), "decision", "d1", ...CHOICE);
    ok(join(base, "b"), "decision", "a1", "--kind", "action", "--title", "T", "--why", "w", "--question", "Run it", "--manual", "```nu\ncd staging; ./migrate\n```", "--hand", "the migration asks for his hardware key");
    ok(join(base, "a"), "link", "l1", "--url", "https://example.com/", "--title", "T", "--kind", "page");
    ok(join(base, "b"), "link", "l1", "--url", "https://example.com/", "--title", "T", "--kind", "page");
    expect([refs(join(base, "a")), refs(join(base, "b"))]).toEqual([["D1"], ["D2", "A1"]]);
    expect([refs(join(base, "a"), "links"), refs(join(base, "b"), "links")]).toEqual([["L1"], ["L2"]]);
  });

  test("a new number starts above the highest of its letter in any fleet the registry names, served or kept", () => {
    const old = join(base, "old");
    mkdirSync(old);
    writeFileSync(join(old, "state.json"), JSON.stringify({ decisions: [{ id: "x", ref: "D40" }], links: [{ id: "y", ref: "L7" }], approvals: [{ id: "K9" }] }));
    mkdirSync(join(home, "names"));
    writeFileSync(join(home, "names", "old.json"), JSON.stringify({ id: "old", role: "coordinator", dir: old, url: "x", pid: 999999999, session: null }));
    // A dead fleet's entry is still read: its ledger's numbers are taken.
    const dead = join(base, "dead");
    mkdirSync(dead);
    writeFileSync(join(dead, "state.json"), JSON.stringify({ roadblocks: [{ id: "z", ref: "R12" }] }));
    serve("dead", dead, 999999999);

    ok(join(base, "a"), "decision", "d1", ...CHOICE);
    ok(join(base, "a"), "link", "l1", "--url", "https://example.com/", "--title", "T", "--kind", "page");
    ok(join(base, "a"), "roadblock", "r1", "--title", "T", "--detail", "d", "--severity", "warning", "--needs", "user", "--decision", "d1");
    expect([refs(join(base, "a")), refs(join(base, "a"), "links"), refs(join(base, "a"), "roadblocks")]).toEqual([["D41"], ["L8"], ["R13"]]);
    expect(readJson(join(home, "numbers", "numbers.json"))).toEqual({ D: 41, K: 9, L: 8, R: 13 });
  });

  test("the counter is never taken back: a number given and then gone is not given again", () => {
    ok(join(base, "a"), "decision", "d1", ...CHOICE);
    ok(join(base, "a"), "decision", "d2", ...CHOICE);
    // The ledger that held D1 and D2 is gone from the machine; the counter still remembers them.
    writeFileSync(join(home, "a.json"), "{}");
    ok(join(base, "b"), "decision", "d1", ...CHOICE);
    expect(refs(join(base, "b"))).toEqual(["D3"]);
  });

  test("old numbers keep their place and still name their decisions", () => {
    const dir = join(base, "a");
    ok(dir, "decision", "d1", ...CHOICE);
    ok(dir, "decision", "d2", ...CHOICE);
    ok(join(base, "b"), "decision", "d1", ...CHOICE);
    ok(dir, "decision", "d3", ...CHOICE);
    expect(refs(dir)).toEqual(["D1", "D2", "D4"]);
    expect(refs(join(base, "b"))).toEqual(["D3"]);
    ok(dir, "decision", "D2", "--decide", "A", "--resolution", "by its number");
    ok(dir, "decision", "D4", "--decide", "B", "--resolution", "a number above the gap");
    expect(rows(dir, "decisions").map((d) => [d["ref"], d["status"]])).toEqual([
      ["D1", "open"],
      ["D2", "decided"],
      ["D4", "decided"],
    ]);
    expect(at(dir, "approval", "add", "next", "--rule", "r", "--by", "luiz", "--ref", "D3").stderr).toContain("unknown decision 'D3'");
  });

  test("a number another fleet holds names nothing here, and FLEET/NUMBER names the one there", () => {
    ok(join(base, "a"), "decision", "d1", ...CHOICE);
    ok(join(base, "b"), "decision", "d1", ...CHOICE);
    expect(at(join(base, "a"), "approval", "add", "next", "--rule", "r", "--by", "luiz", "--ref", "D2").stderr).toContain("unknown decision 'D2'");
    expect(at(join(base, "a"), "approval", "add", "next", "--rule", "r", "--by", "luiz", "--ref", "a/D2").stderr).toContain("unknown decision 'D2' in a");
    expect(at(join(base, "a"), "approval", "add", "next", "--rule", "r", "--by", "luiz", "--ref", "b/D2").stderr).toContain("b/D2 (T) is open");
  });

  test("a new card's id that reads as another card's number is refused, and nothing is written", () => {
    const dir = join(base, "a");
    mkdirSync(join(home, "numbers"), { recursive: true });
    writeFileSync(join(home, "numbers", "numbers.json"), JSON.stringify({ D: 220 }));
    const before = readFileSync(join(dir, "state.json"), "utf8");
    const result = at(dir, "decision", "D217", ...CHOICE);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("D217 reads as a card number, and this card's number will be D221: use a word id (s3-tool), or D221");
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before);
    expect(readJson(join(home, "numbers", "numbers.json"))).toEqual({ D: 220 });
  });

  test("a new card's id equal to the number it will be given, or a word, is taken", () => {
    const dir = join(base, "a");
    mkdirSync(join(home, "numbers"), { recursive: true });
    writeFileSync(join(home, "numbers", "numbers.json"), JSON.stringify({ D: 220 }));
    ok(dir, "decision", "D221", ...CHOICE);
    ok(dir, "decision", "s3-tool", ...CHOICE);
    expect(rows(dir, "decisions").map((d) => [d["id"], d["ref"]])).toEqual([
      ["D221", "D221"],
      ["s3-tool", "D222"],
    ]);
  });

  test("a card already recorded under a number-shaped id is still changed and decided by it", () => {
    const dir = join(base, "a");
    mkdirSync(join(home, "numbers"), { recursive: true });
    writeFileSync(join(home, "numbers", "numbers.json"), JSON.stringify({ D: 220 }));
    ok(dir, "decision", "d1", ...CHOICE);
    // A card opened before the rule, under a hand-picked id that is not its number.
    const state = readJson(join(dir, "state.json"));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...state, decisions: rows(dir, "decisions").map((d) => ({ ...d, id: "D217" })) }));
    ok(dir, "decision", "D217", "--title", "T2");
    ok(dir, "decision", "D217", "--decide", "A", "--resolution", "said in the session");
    expect(rows(dir, "decisions").map((d) => [d["id"], d["ref"], d["title"], d["status"]])).toEqual([["D217", "D221", "T2", "decided"]]);
  });

  test("an old ledger's row under a number-like id and without a number is numbered on the next write, not refused", () => {
    const dir = join(base, "a");
    ok(dir, "decision", "d1", ...CHOICE);
    const old = rows(dir, "decisions").map((d) => ({ ...unnumbered(d), id: "D7" }));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...readJson(join(dir, "state.json")), decisions: old }));
    ok(dir, "event", "--kind", "note", "x");
    expect(rows(dir, "decisions").map((d) => [d["id"], d["ref"]])).toEqual([["D7", "D2"]]);
  });

  test("a number-like id is refused after the command's own checks, which say the real reason first", () => {
    const dir = join(base, "a");
    expect(at(dir, "decision", "D9", ...CHOICE, "--supersedes", "nope").stderr).toContain("unknown decision 'nope'");
    expect(at(dir, "decision", "D9", "--under", "K3", "--title", "T", "--question", "q", "--undo", "u").stderr).toContain("--under and --undo record a notice: give --kind notice");
    const withdrawn = at(dir, "decision", "D9", "--withdraw", "not needed");
    expect(withdrawn.code).not.toBe(0);
    expect(withdrawn.stderr).not.toContain("reads as a card number");
  });

  test("a notice under a number-like id is refused unless it is its own number, after the notice's own checks", () => {
    const a = join(base, "a");
    ok(a, "decision", "d1", ...CHOICE);
    writeFileSync(join(a, "chat.jsonl"), `${JSON.stringify({ id: 1, at: "2099-01-01T00:00:00+00:00", from: "user", author: "luiz@github", to: ["coordinator"], text: "A", re: null, decision: "d1" })}\n`);
    ok(a, "decision", "d1", "--decide", "A", "--resolution", "yes");
    ok(a, "approval", "add", "next", "--rule", "land", "--by", "luiz", "--ref", "D1");
    const notice = (id: string, under = "K1"): string[] => ["decision", id, "--kind", "notice", "--under", under, "--title", "T", "--question", "Landed the branch", "--undo", "revert it"];
    expect(at(a, ...notice("N7", "K9")).stderr).toContain("unknown approval 'K9'");
    expect(at(a, ...notice("N7")).stderr).toContain("N7 reads as a card number, and this card's number will be N1: use a word id (s3-tool), or N1");
    ok(a, ...notice("N1"));
    expect(rows(a, "decisions").map((d) => [d["id"], d["ref"]])).toEqual([
      ["d1", "D1"],
      ["N1", "N1"],
    ]);
  });

  test("a number another fleet takes between the check and the write refuses the write, and the counter keeps its number", () => {
    const a = join(base, "a");
    ok(a, "decision", "d1", ...CHOICE);
    // This write's check said D2, so the new row is D2; fleet b takes D2 before this write is numbered.
    const opened = { ...unnumbered(rows(a, "decisions")[0] ?? {}), id: "D2" };
    ok(join(base, "b"), "decision", "d1", ...CHOICE);
    const ledger = Option.getOrThrow(parseLedger(JSON.stringify({ ...readJson(join(a, "state.json")), decisions: [...rows(a, "decisions"), opened] })));

    if (ledger instanceof Refusal) throw new Error(ledger.message);
    expect(numberOnMachine(machine(env), a, ledger, new Set())).toMatchObject({ why: "D2 reads as a card number, and this card's number will be D3: use a word id (s3-tool), or D3" });
    expect(readJson(join(home, "numbers", "numbers.json"))).toEqual({ D: 2 });
  });

  test("approval add next takes the machine's next K, and the same source twice is refused", () => {
    const a = join(base, "a");
    // Another fleet's K4 from before the counter: its seed starts above it.
    const b = join(base, "b");
    writeFileSync(join(b, "state.json"), JSON.stringify({ ...readJson(join(b, "state.json")), approvals: [{ id: "K4", rule: "r", by: "luiz", ref: "x", added: "2026-01-05T09:00:00+00:00", status: "revoked" }] }));
    ok(a, "decision", "d1", ...CHOICE);
    writeFileSync(join(a, "chat.jsonl"), `${JSON.stringify({ id: 1, at: "2099-01-01T00:00:00+00:00", from: "user", author: "luiz@github", to: ["coordinator"], text: "A", re: null, decision: "d1" })}\n`);
    ok(a, "decision", "d1", "--decide", "A", "--resolution", "yes");
    expect(ok(a, "approval", "add", "next", "--rule", "land", "--by", "luiz", "--ref", "D1").stdout).toContain("recorded approval K5");
    expect(at(a, "approval", "add", "next", "--rule", "land", "--by", "luiz", "--ref", "D1").stderr).toContain("already backs approval K5");
  });
});

describe("the counter's own rules", () => {
  test("it is seeded once, when its file is missing: after that it is the source, with the ledger being written", () => {
    mkdirSync(join(home, "numbers"));
    writeFileSync(join(home, "numbers", "numbers.json"), JSON.stringify({ D: 5 }));
    const old = join(base, "old");
    mkdirSync(old);
    writeFileSync(join(old, "state.json"), JSON.stringify({ decisions: [{ id: "x", ref: "D40" }] }));
    serve("old", old, 999999999);
    ok(join(base, "a"), "decision", "d1", ...CHOICE);
    expect(refs(join(base, "a"))).toEqual(["D6"]);
  });

  test("an explicit K is kept as given and raises the counter past it; one source backs one active approval", () => {
    const a = join(base, "a");
    ok(a, "decision", "d1", ...CHOICE);
    ok(a, "decision", "d2", ...CHOICE);
    writeFileSync(join(a, "chat.jsonl"), [1, 2].map((i) => `${JSON.stringify({ id: i, at: "2099-01-01T00:00:00+00:00", from: "user", author: "luiz@github", to: ["coordinator"], text: "A", re: null, decision: `d${String(i)}` })}\n`).join(""));
    ok(a, "decision", "d1", "--decide", "A", "--resolution", "yes");
    ok(a, "decision", "d2", "--decide", "A", "--resolution", "yes");
    expect(ok(a, "approval", "add", "K40", "--rule", "land", "--by", "luiz", "--ref", "D1").stdout).toContain("recorded approval K40");
    expect(at(a, "approval", "add", "K41", "--rule", "land", "--by", "luiz", "--ref", "D1").stderr).toContain("already backs approval K40");
    expect(ok(a, "approval", "add", "next", "--rule", "deploy", "--by", "luiz", "--ref", "D2").stdout).toContain("recorded approval K41");
    expect(readJson(join(home, "numbers", "numbers.json"))["K"]).toBe(41);
  });

  test("a lock that cannot be taken fails loudly", () => {
    expect(() => holdExclusiveLock(987_654)).toThrow(LockFailed);
  });

  test("a fleet the hub's registry serves, numbering from another registry, is warned", () => {
    const user = join(base, "user");
    const usual = join(user, ".local", "state", "fleet-board");
    mkdirSync(usual, { recursive: true });
    const dir = join(base, "a");
    writeFileSync(join(usual, "a.json"), JSON.stringify({ id: "a", role: "coordinator", dir, url: "x", pid: process.pid, session: null }));
    rmSync(join(home, "a.json"));
    env = { ...env, HOME: user };
    delete env["XDG_STATE_HOME"];
    const r = ok(dir, "decision", "d1", ...CHOICE);
    expect(r.stderr).toContain(`this fleet is served from the registry at ${usual} but numbers from ${home}`);
    // Served from the registry it numbers from: no warning.
    expect(ok(join(base, "b"), "decision", "d1", ...CHOICE).stderr).not.toContain("served from the registry");
  });
});

describe("a registry that cannot be reached", () => {
  let locked: string | undefined;

  afterEach(() => {
    if (locked !== undefined) chmodSync(locked, 0o755);
    locked = undefined;
  });

  test("a standalone fleet (no registry on this machine) numbers from its own ledger and is warned once", () => {
    env = baseEnv(home, { XDG_STATE_HOME: join(base, "no-state") });
    delete env["FLEET_HOME"];
    const dir = join(base, "lone");
    ok(dir, "init", "--project", "lone", "--goal", "g");
    const r = ok(dir, "decision", "d1", ...CHOICE);
    expect(refs(dir)).toEqual(["D1"]);
    expect(r.stderr.split("numbered from this ledger alone").length - 1).toBe(1);
    expect(r.stderr).toContain(`no fleet registry at ${join(base, "no-state", "fleet-board")}`);
    // A write that numbers nothing says nothing of it.
    expect(ok(dir, "event", "--kind", "note", "x").stderr).not.toContain("numbered from this ledger alone");
  });

  test("a standalone fleet refuses a link under another number-like id where it is numbered, and nothing is written", () => {
    env = baseEnv(home, { XDG_STATE_HOME: join(base, "no-state") });
    delete env["FLEET_HOME"];
    const dir = join(base, "lone");
    ok(dir, "init", "--project", "lone", "--goal", "g");
    const before = readFileSync(join(dir, "state.json"), "utf8");
    const link = (id: string): string[] => ["link", id, "--url", "https://example.com/", "--title", "T", "--kind", "page"];
    expect(at(dir, ...link("L5")).stderr).toContain("L5 reads as a card number, and this card's number will be L1: use a word id (s3-tool), or L1");
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before);
    ok(dir, ...link("L1"));
    expect(refs(dir, "links")).toEqual(["L1"]);
  });

  test("a registry FLEET_HOME names is made when missing, never skipped", () => {
    env = baseEnv(join(base, "named"));
    const dir = join(base, "fresh");
    ok(dir, "init", "--project", "fresh", "--goal", "g");
    const r = ok(dir, "decision", "d1", ...CHOICE);
    expect(r.stderr).not.toContain("numbered from this ledger alone");
    expect(readJson(join(base, "named", "numbers", "numbers.json"))).toEqual({ D: 1 });
  });

  test("a registry whose counter cannot be written refuses the write: nothing is numbered, nothing written", () => {
    ok(join(base, "a"), "decision", "d1", ...CHOICE);
    const before = readFileSync(join(base, "a", "state.json"), "utf8");
    // The lock still opens; the counter cannot be written, so the number taken under it is let go.
    chmodSync(join(home, "numbers"), 0o555);
    locked = join(home, "numbers");
    const r = at(join(base, "a"), "decision", "d2", ...CHOICE);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`cannot write the number counter ${join(home, "numbers", "numbers.json")}`);
    expect(r.stderr).toContain("nothing was written, so no number repeats another fleet's");
    expect(readFileSync(join(base, "a", "state.json"), "utf8")).toBe(before);
    expect(readJson(join(home, "numbers", "numbers.json"))).toEqual({ D: 1 });
  });

  test("a registry whose counter cannot be locked refuses the write too", () => {
    ok(join(base, "a"), "decision", "d1", ...CHOICE);
    chmodSync(join(home, "numbers", "numbers.lock"), 0o000);
    locked = join(home, "numbers", "numbers.lock");
    const r = at(join(base, "a"), "decision", "d2", ...CHOICE);
    expect([r.code, refs(join(base, "a"))]).toEqual([1, ["D1"]]);
    expect(r.stderr).toContain("cannot open the number counter's lock");
  });
});
