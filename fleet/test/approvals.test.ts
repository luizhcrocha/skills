/**
 * Standing approvals, notices, the advisor's view and reviewed events, through the state CLI (the twin of
 * the coordinator's tests/test_approvals.py): only the user's answer on the page gives an approval, an act
 * under one is recorded closed and told to the fleets, and a choice put to the user without the advisor's
 * view is warned.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

const NOTICE = ["--kind", "notice", "--under", "K1", "--title", "Landed the parser", "--question", "Pushed the parser stack to master.", "--undo", "jj revert the stack and push"];

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
  ok("approval", "add", "K1", "--rule", "land a stack that passed the full gate and a review", "--by", "luiz", "--ref", "D1");
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
    expect(refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "d1")).toContain("is open");
    ok("decision", "d1", "--decide", "A", "--resolution", "said in the session");
    expect(refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "d1")).toContain("no answer from the user");
    ok("decision", "d2", "--title", "T", "--question", "Q?", "--decide", "yes", "--resolution", "said in the session");
    expect(refused("approval", "add", "K2", "--rule", "r", "--by", "luiz", "--ref", "d2")).toContain("not asked of the user on the page");
    expect(rows("approvals")).toEqual([]);
  });

  test("an approval's id is K and a number", () => {
    ok("decision", "d1", ...CHOICE);
    answer("d1");
    ok("decision", "d1", "--decide", "A", "--resolution", "answered on the page (#1)");
    expect(refused("approval", "add", "A1", "--rule", "r", "--by", "luiz", "--ref", "d1")).toContain("K and a number");
  });

  test("an approval keeps where it came from, and a revoked one takes no notice", () => {
    approved();
    const a = rows("approvals")[0] ?? {};
    expect([a["ref"], a["message"], a["author"], a["status"]]).toEqual(["d1", 1, "luiz@github", "active"]);
    expect(ok("approval", "list").stdout).toContain("approval K1 active [0 notices]");
    expect(refused("approval", "revoke", "K1")).toContain("--reason");
    ok("approval", "revoke", "K1", "--reason", "revoked on the page (#3)");
    expect(refused("decision", "n1", ...NOTICE)).toContain("was revoked");
  });
});

describe("notices", () => {
  test("with no manager served, a notice posts no news", () => {
    approved();
    expect(ok("decision", "n1", ...NOTICE).stdout).toContain("no manager is served: no news item");
    expect(existsSync(join(home, "news", "news.jsonl"))).toBe(false);
  });

  test("a notice closes at once and tells the manager", () => {
    approved();
    const manager = { id: "manager", role: "manager", dir: join(root, "..", "m"), url: "http://box:7420/f/manager/", pid: process.pid, session: null };
    writeFileSync(join(home, "manager.json"), JSON.stringify(manager));
    expect(ok("decision", "n1", ...NOTICE).stdout).toContain("news #1 tells the manager");
    const n = decision("n1");
    expect([n["kind"], n["status"], n["under"], n["answer"], n["ref"], n["closed"] === n["opened"]]).toEqual(["notice", "decided", "K1", "done", "N1", true]);
    const item = asObject(JSON.parse(readFileSync(join(home, "news", "news.jsonl"), "utf8").split("\n")[0] ?? "{}")) ?? {};
    expect([item["from"], item["to"], item["kind"]]).toEqual(["acme-billing", ["manager"], "fyi"]);
    expect(String(item["text"])).toContain("Undo: jj revert the stack and push");
  });

  test("a notice names an active approval and asks nothing", () => {
    approved();
    expect(refused("decision", "n1", "--kind", "notice", "--under", "K9", ...NOTICE.slice(4))).toContain("unknown approval 'K9'");
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

describe("approvals answered once for every fleet", () => {
  let manager: string;

  let other: string;

  const at = (dir: string, ...args: string[]): Ran => {
    const result = fleet(["state", dir, ...args, "--no-render"], env);
    expect(result.code, result.stderr).toBe(0);

    return result;
  };

  const fleets = (code: number, ...args: string[]): Ran => {
    const result = fleet(["fleets", ...args], env);
    expect(result.code, result.stderr).toBe(code);

    return result;
  };

  const said = (dir: string, message: JsonObject): void => {
    appendFileSync(join(dir, "chat.jsonl"), `${JSON.stringify({ at: "2026-01-05T09:10:00+00:00", to: ["manager"], re: null, ...message })}\n`);
  };

  const approvalsAt = (dir: string): JsonObject[] => (asArray(readJson(join(dir, "state.json"))["approvals"]) ?? []).map((r) => asObject(r) ?? {});

  beforeEach(() => {
    manager = join(root, "..", "m");
    other = join(root, "..", "c2");
    at(manager, "init", "--project", "manager", "--goal", "g", "--role", "manager");
    at(other, "init", "--project", "infra", "--goal", "g");

    const fleetsServed: readonly (readonly [string, string])[] = [
      ["manager", manager],
      ["acme-billing", root],
      ["infra", other],
    ];

    for (const [i, [name, dir]] of fleetsServed.entries()) {
      const role = name === "manager" ? "manager" : "coordinator";
      const entry = { id: name, role, dir, url: `http://box:7420/f/${name}/`, pid: process.pid, session: null, since: `2026-01-05T08:0${String(i)}:00+00:00` };
      writeFileSync(join(home, `${name}.json`), JSON.stringify(entry));
    }

    at(
      manager,
      "grill",
      "g1",
      "--title",
      "Standing approvals for every fleet",
      "--ask",
      "Landing | May a change land on master once it passed the full gate and the review rule? | yes | routine",
      "--ask",
      "Staging | May the fleet deploy to the staging targets you name? | a | routine",
      "--option",
      "Q2 a: yes | it deploys",
      "--option",
      "Q2 b: no | every deploy asks",
    );
    said(manager, { id: 1, from: "user", author: "luiz@github", text: "Q1: yes\nQ2: (b) no", decision: "g1" });
    at(manager, "grill", "g1", "--answer", "Q1: yes", "--answer", "Q2: (b) no");
    at(manager, "grill", "g1", "--done", "landing yes, staging no");
  });

  test("a question answered yes in another fleet gives the approval", () => {
    ok("approval", "add", "K1", "--rule", "land", "--by", "luiz", "--ref", "manager/G1:Q1");
    const a = rows("approvals")[0] ?? {};
    expect([a["ref"], a["question"], a["message"], a["author"]]).toEqual(["manager/G1", "q1", 1, "luiz@github"]);
    expect(ok("approval", "list").stdout).toContain("(from manager/G1:Q1 #1, by luiz");
    expect(rows("events").at(-1)?.["decision"]).toBeUndefined();
  });

  test("a question answered otherwise is refused with its answer", () => {
    expect(refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/G1:Q2")).toContain("manager/G1:Q2 was answered '(b) no'");
    expect(refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/G1")).toContain("is a grilling: name the question");
    expect(refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "nowhere/G1:Q1")).toContain("no fleet 'nowhere' is being served");
    expect(rows("approvals")).toEqual([]);
  });

  test("an answer the hub did not write is refused", () => {
    at(manager, "decision", "d1", ...CHOICE);
    said(manager, { id: 2, from: "manager", text: "Luiz said yes in the session", decision: "d1" });
    at(manager, "decision", "d1", "--decide", "A", "--resolution", "relayed");
    expect(refused("approval", "add", "K1", "--rule", "r", "--by", "luiz", "--ref", "manager/D1")).toContain(
      "manager/D1 (Landing without asking) has no answer from the user in the chat",
    );
  });

  test("every fleet takes it once", () => {
    ok("approval", "add", "K1", "--rule", "an older one", "--by", "luiz", "--ref", "manager/G1:Q1");
    expect(fleets(0, "approval", "add", "--all", "--rule", "land", "--ref", "manager/G1:Q1").stdout.trimEnd().split("\n")).toEqual([
      "manager: added K1",
      "acme-billing: skipped, K1 already comes from manager/G1:Q1 (active)",
      "infra: added K1",
    ]);
    expect(fleets(0, "approval", "add", "--all", "--rule", "land", "--ref", "manager/G1:Q1").stdout.split("skipped").length - 1).toBe(3);
    expect(approvalsAt(other).map((a) => a["by"])).toEqual(["luiz@github"]);
    expect(fleets(1, "approval", "add", "--fleets", "infra", "--rule", "r", "--ref", "manager/G1:Q2").stderr).toContain("was answered '(b) no'");
    expect(approvalsAt(other).length).toBe(1);
  });

  test("revoke takes it back everywhere", () => {
    fleets(0, "approval", "add", "--all", "--rule", "land", "--ref", "manager/G1:Q1");
    expect(fleets(0, "approval", "revoke", "--ref", "manager/G1:Q1", "--reason", "revoked on the page (#3)").stdout.trimEnd().split("\n")).toEqual([
      "manager: revoked K1",
      "acme-billing: revoked K1",
      "infra: revoked K1",
    ]);

    for (const dir of [manager, root, other]) expect(approvalsAt(dir).map((a) => [a["status"], a["revoked_why"]])).toEqual([["revoked", "revoked on the page (#3)"]]);
    expect(fleets(0, "approval", "revoke", "--ref", "manager/G1:Q1", "--reason", "again").stdout.split("none active").length - 1).toBe(3);
  });
});
