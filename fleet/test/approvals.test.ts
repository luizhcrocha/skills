/**
 * Standing approvals, notices, the advisor's view and reviewed events, through the state CLI (the twin of
 * the coordinator's tests/test_approvals.py): only the user's answer on the page gives an approval, an act
 * under one is recorded closed and told to the fleets, and a choice put to the user without the advisor's
 * view is warned.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { baseEnv, fleet, readJson, tmp, type Environment, type Ran } from "./support.ts";

const CHOICE = [
  "--kind",
  "decision",
  "--title",
  "Landing without asking",
  "--why",
  "most landings are routine",
  "--question",
  "May the fleet land a stack that passed the full gate and a review, and tell you after?",
  "--option",
  "A: yes | it lands and you read a notice",
  "--option",
  "B: no | every landing asks",
  "--recommend",
  "A",
  "--reason",
  "the gate and the review already judge it",
];

const NOTICE = ["--kind", "notice", "--under", "A1", "--title", "Landed the parser", "--question", "Pushed the parser stack to master.", "--undo", "jj revert the stack and push"];

let root: string;

let home: string;

let env: Environment;

function run(...args: string[]): Ran {
  return fleet(["state", root, ...args, "--no-render"], env);
}

function ok(...args: string[]): Ran {
  const result = run(...args);
  expect(result.code, result.stderr).toBe(0);

  return result;
}

function refused(...args: string[]): string {
  const result = run(...args);
  expect(result.code, result.stdout).toBe(1);

  return result.stderr;
}

function rows(key: string): JsonObject[] {
  return (asArray(readJson(join(root, "state.json"))[key]) ?? []).map((r) => asObject(r) ?? {});
}

function decision(id: string): JsonObject {
  return rows("decisions").find((d) => d["id"] === id) ?? {};
}

function answer(id: string): void {
  const message = { id: 1, at: "2026-01-05T09:10:00+00:00", from: "user", author: "luiz@github", to: ["coordinator"], text: "A: yes", re: null, decision: id };
  appendFileSync(join(root, "chat.jsonl"), `${JSON.stringify(message)}\n`);
}

function approved(): void {
  ok("decision", "d1", ...CHOICE);
  answer("d1");
  ok("decision", "d1", "--decide", "A", "--resolution", "answered on the page (#1)");
  ok("approval", "add", "A1", "--rule", "land a stack that passed the full gate and a review", "--by", "luiz", "--ref", "D1");
}

beforeEach(() => {
  root = join(tmp(), "c");
  home = tmp();
  env = baseEnv(home);
  ok("init", "--project", "acme billing", "--goal", "g");
  ok("milestone", "m1", "--title", "M");
});

describe("approvals", () => {
  test("an approval comes only from the user's answer on the page", () => {
    ok("decision", "d1", ...CHOICE);
    expect(refused("approval", "add", "A1", "--rule", "r", "--by", "luiz", "--ref", "d1")).toContain("is open");
    ok("decision", "d1", "--decide", "A", "--resolution", "said in the session");
    expect(refused("approval", "add", "A1", "--rule", "r", "--by", "luiz", "--ref", "d1")).toContain("no answer from the user");
    ok("decision", "d2", "--title", "T", "--question", "Q?", "--decide", "yes", "--resolution", "said in the session");
    expect(refused("approval", "add", "A2", "--rule", "r", "--by", "luiz", "--ref", "d2")).toContain("not asked of the user on the page");
    expect(rows("approvals")).toEqual([]);
  });

  test("an approval keeps where it came from, and a revoked one takes no notice", () => {
    approved();
    const a = rows("approvals")[0] ?? {};
    expect([a["ref"], a["message"], a["author"], a["status"]]).toEqual(["d1", 1, "luiz@github", "active"]);
    expect(ok("approval", "list").stdout).toContain("approval A1 active [0 notices]");
    expect(refused("approval", "revoke", "A1")).toContain("--reason");
    ok("approval", "revoke", "A1", "--reason", "revoked on the page (#3)");
    expect(refused("decision", "n1", ...NOTICE)).toContain("was revoked");
  });
});

describe("notices", () => {
  test("a notice closes at once and tells the fleets", () => {
    approved();
    expect(ok("decision", "n1", ...NOTICE).stdout).toContain("news #1 tells the fleets");
    const n = decision("n1");
    expect([n["kind"], n["status"], n["under"], n["answer"], n["ref"], n["closed"] === n["opened"]]).toEqual(["notice", "decided", "A1", "done", "N1", true]);
    const item = asObject(JSON.parse(readFileSync(join(home, "news", "news.jsonl"), "utf8").split("\n")[0] ?? "{}")) ?? {};
    expect([item["from"], item["kind"]]).toEqual(["acme-billing", "fyi"]);
    expect(String(item["text"])).toContain("Undo: jj revert the stack and push");
  });

  test("a notice names an active approval and asks nothing", () => {
    approved();
    expect(refused("decision", "n1", "--kind", "notice", "--under", "A9", ...NOTICE.slice(4))).toContain("unknown approval 'A9'");
    expect(refused("decision", "n1", ...NOTICE.slice(0, -2))).toContain("--undo");
    expect(refused("decision", "n1", ...NOTICE, "--option", "A: a | b", "--recommend", "A")).toContain("leave out --option, --recommend");
    expect(refused("decision", "n1", ...NOTICE.slice(2))).toContain("give --kind notice");
    expect(existsSync(join(home, "news", "news.jsonl"))).toBe(false);
  });
});

describe("the advisor's view", () => {
  const input = (id: string, ...more: string[]): Ran => ok("decision", id, "--kind", "input", "--title", "T", "--question", "Which port?", "--why", "w", ...more);

  test("the third choice of a day with no advisor is warned", () => {
    expect(input("d1").stderr).not.toContain("--advised");
    expect(input("d2").stderr).not.toContain("--advised");
    expect(input("d3").stderr).toContain("d3 is choice 3 this fleet asks the user today, and no advisor runs");
    expect(input("d4", "--advised", "none:it is a port").stderr).not.toContain("--advised");
  });

  test("a fleet with an advisor is told to ask it", () => {
    ok("agent", "advisor", "--task", "t", "--milestone", "m1", "--model", "fable", "--status", "queued");
    expect(input("d1").stderr).toContain("d1 asks the user with no --advised");
    input("d2", "--advised", "Port 7420: the hub's");
    expect(decision("d2")["advised"]).toBe("Port 7420: the hub's");
    expect(refused("decision", "d5", "--kind", "input", "--title", "T", "--question", "q", "--why", "w", "--advised", "none: ")).toContain("--advised is the advisor's view");
  });
});

describe("reviewed events", () => {
  test("a reviewed event carries its findings and changes", () => {
    ok("event", "--kind", "reviewed", "--findings", "2", "--changes", "kxyzabcd, lmnopqrs", "reviewed with tstack:review");
    const e = rows("events").at(-1) ?? {};
    expect([e["kind"], e["findings"], e["changes"]]).toEqual(["reviewed", 2, ["kxyzabcd", "lmnopqrs"]]);
    expect(refused("event", "--kind", "reviewed", "r")).toContain("--findings N");
    expect(refused("event", "--findings", "1", "a note")).toContain("go with --kind reviewed");
  });
});
