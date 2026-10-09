/**
 * The decisions seam (ported from the coordinator's tests/test_decisions.py): what waits on the user,
 * through the state CLI, and the rule for what an answer may be.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { messageOf, type Message } from "../src/chat/store.ts";
import { answeredAt } from "../src/health.ts";
import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { answerRefusal } from "../src/ledger/answers.ts";
import { baseEnv, fleet, readJson, tmp, type Environment, type Ran } from "./support.ts";

const SCHEMA = [
  "d1",
  "--kind",
  "decision",
  "--title",
  "Invoice schema",
  "--question",
  "Migrate the invoice table or keep both shapes?",
  "--why",
  "invoice-gen cannot write usage lines until this is settled",
  "--option",
  "A: migrate now | one shape, a 20 minute lock on invoices",
  "--option",
  "B: keep both | no lock, two code paths until the next release",
  "--recommend",
  "A",
  "--reason",
  "the table is small and the second path costs every later change",
];

let root: string;

let env: Environment;

function run(...args: string[]): Ran {
  return fleet(["state", root, ...args, "--no-render"], env);
}

function ok(...args: string[]): string {
  const result = run(...args);
  expect(result.code, result.stderr).toBe(0);

  return result.stdout;
}

function refused(...args: string[]): string {
  const result = run(...args);
  expect(result.code, result.stdout).toBe(1);
  expect(result.stderr).not.toContain("Traceback");

  return result.stderr;
}

function state(): JsonObject {
  return readJson(join(root, "state.json"));
}

function rows(key: string): JsonObject[] {
  return (asArray(state()[key]) ?? []).map((r) => asObject(r) ?? {});
}

function item(id = "d1"): JsonObject {
  return rows("decisions").find((d) => d["id"] === id) ?? {};
}

function lastEvent(): JsonObject {
  return rows("events").at(-1) ?? {};
}

beforeEach(() => {
  root = tmp();
  env = baseEnv(tmp());
  ok("init", "--project", "p", "--goal", "g");
  ok("milestone", "m1", "--title", "M");
  ok("agent", "a1", "--task", "t", "--milestone", "m1", "--name", "invoice-gen");
});

describe("open", () => {
  test("a new item is open with its four fields and is announced", () => {
    ok("decision", ...SCHEMA, "--blocking", "--agent", "a1");
    const d = item();
    expect([d["status"], d["kind"], d["blocking"], d["agent"], d["page"]]).toEqual(["open", "decision", true, "a1", true]);
    expect(d["options"]).toEqual([
      { id: "A", label: "migrate now", consequence: "one shape, a 20 minute lock on invoices" },
      { id: "B", label: "keep both", consequence: "no lock, two code paths until the next release" },
    ]);
    expect([d["recommend"], d["revised"], d["closed"]]).toEqual(["A", null, null]);
    const event = lastEvent();
    expect([event["kind"], event["decision"], event["agent"], event["important"]]).toEqual(["asked", "d1", "a1", true]);
    expect(String(event["text"])).toContain("Migrate the invoice table");
  });

  test("an item that does not block is a routine event", () => {
    ok("decision", ...SCHEMA);
    expect(item()["blocking"]).toBe(false);
    expect(lastEvent()).not.toHaveProperty("important");
  });

  test("a new item needs its fields", () => {
    expect(refused("decision", "d1", "--kind", "input", "--title", "T", "--why", "w")).toContain("--question");
    expect(refused("decision", "d1", "--kind", "input", "--title", "T", "--question", "q")).toContain("--why");
    expect(rows("decisions")).toEqual([]);
  });

  test("each kind needs what its answer control shows", () => {
    const base = ["--title", "T", "--question", "q", "--why", "w"];
    expect(refused("decision", "d1", "--kind", "decision", ...base, "--option", "A: only one | c", "--recommend", "A", "--reason", "r")).toContain(
      "two options",
    );
    expect(refused("decision", "d1", "--kind", "decision", ...base, "--option", "A: x | c", "--option", "B: y | c")).toContain("--recommend");
    expect(
      refused("decision", "d1", "--kind", "decision", ...base, "--option", "A: x | c", "--option", "B: y | c", "--recommend", "C", "--reason", "r"),
    ).toContain("not one of the options");
    expect(refused("decision", "d1", "--kind", "secret", ...base)).toContain("--secret");
    expect(refused("decision", "d1", "--kind", "secret", ...base, "--secret", "NEO4J_PASSWORD")).toContain("--manual");
    expect(refused("decision", "d1", "--kind", "action", ...base)).toContain("--manual");
    ok("decision", "d1", "--kind", "input", ...base);
    ok("decision", "d2", "--kind", "secret", ...base, "--secret", "NEO4J_PASSWORD", "--manual", "secretspec set NEO4J_PASSWORD");
    ok("decision", "d3", "--kind", "action", ...base, "--manual", "tailscale up");
  });

  test("a --manual of more than one line puts its commands in a fence", () => {
    const base = ["--title", "T", "--question", "q", "--why", "w"];
    const fix = "--manual has 2 lines and no fence: put the commands in a fenced block (a line ```nu, the commands, a line ```), any prose outside it\n";
    expect(refused("decision", "d1", "--kind", "action", ...base, "--manual", "cd x\n\nmake")).toBe(`state: ${fix}`);
    expect(refused("decision", "d1", "--kind", "secret", ...base, "--secret", "K", "--manual", "From the repo:\nsecretspec set K")).toBe(`state: ${fix}`);
    expect(rows("decisions")).toEqual([]);
    ok("decision", "d1", "--kind", "action", ...base, "--manual", "From the repo:\n\n```nu\ncd x\nmake\n```");
    ok("decision", "d2", "--kind", "action", ...base, "--manual", "\n  tailscale up\n");
    expect(refused("decision", "d2", "--manual", "cd x\nmake")).toBe(`state: ${fix}`);
    expect(item("d2")["manual"]).toBe("\n  tailscale up\n");
  });

  test("an option is key, label and consequence", () => {
    const base = ["decision", "d1", "--kind", "decision", "--title", "T", "--question", "q", "--why", "w", "--recommend", "A", "--reason", "r"];
    expect(refused(...base, "--option", "A: no consequence", "--option", "B: y | c")).toContain("KEY: label | consequence");
    expect(refused(...base, "--option", "just words | c", "--option", "B: y | c")).toContain("KEY: label | consequence");
    expect(refused(...base, "--option", "A: x | c", "--option", "A: y | c")).toContain("twice");
  });

  test("an id is a token and an agent is known", () => {
    expect(refused("decision", "d/1", ...SCHEMA.slice(1))).toContain("letters");
    expect(refused("decision", ...SCHEMA, "--agent", "nobody")).toContain("unknown agent");
  });
});

describe("revise", () => {
  test("changing an open item stamps revised and says what changed", () => {
    ok("decision", ...SCHEMA);
    ok("decision", "d1", "--why", "invoice-gen and the stripe adapter both wait", "--log", "the adapter now waits on this too");
    const d = item();
    expect(d["why"]).toBe("invoice-gen and the stripe adapter both wait");
    expect(d["change"]).toBe("the adapter now waits on this too");
    expect(d["revised"]).not.toBeNull();
    const event = lastEvent();
    expect([event["kind"], event["decision"]]).toEqual(["asked", "d1"]);
    expect(String(event["text"])).toContain("the adapter now waits on this too");
    expect(event).not.toHaveProperty("important");
  });

  test("a revision keeps the kind consistent", () => {
    ok("decision", ...SCHEMA);
    expect(refused("decision", "d1", "--recommend", "Z")).toContain("not one of the options");
    expect(refused("decision", "d1", "--option", "A: only | c")).toContain("two options");
  });

  test("a new question comes with its options", () => {
    ok("decision", ...SCHEMA, "--blocking");
    const said = refused("decision", "d1", "--question", "Approve deploys of this kind as a rule?", "--not-blocking");
    expect(said).toContain("--option");
    expect(said).toContain("--same-options");
    expect(item()["question"]).toBe("Migrate the invoice table or keep both shapes?");
    ok(
      "decision",
      "d1",
      "--question",
      "Approve deploys of this kind as a rule?",
      "--option",
      "yes: As a rule | no ask per deploy",
      "--option",
      "no: Ask each time | one decision per deploy",
      "--recommend",
      "yes",
      "--reason",
      "r",
    );
    const ids = (): unknown[] => (asArray(item()["options"]) ?? []).map((o) => asObject(o)?.["id"]);
    expect(ids()).toEqual(["yes", "no"]);
    ok("decision", "d1", "--question", "Approve deploys of this kind, as a rule?", "--same-options");
    expect(ids()).toEqual(["yes", "no"]);
  });

  test("only a choice has options to carry", () => {
    ok("decision", "d2", "--kind", "input", "--title", "T", "--question", "q", "--why", "w");
    ok("decision", "d2", "--question", "another question");
    ok("decision", ...SCHEMA);
    ok("decision", "d1", "--question", "Migrate the invoice table or keep both shapes?", "--why", "same question, new reason");
  });

  test("blocking can be lifted", () => {
    ok("decision", ...SCHEMA, "--blocking");
    ok("decision", "d1", "--not-blocking", "--why", "the fleet proceeds on A until you say otherwise");
    expect(item()["blocking"]).toBe(false);
  });

  test("the body is copied beside the page and removed on request", () => {
    const source = join(root, "analysis.html");
    writeFileSync(source, "<table><tr><td>rows</td><td>1,204</td></tr></table>");
    ok("decision", ...SCHEMA, "--body", source);
    expect(item()["body"]).toBe(true);
    expect(readFileSync(join(root, "decisions", "d1.html"), "utf8")).toBe(readFileSync(source, "utf8"));
    writeFileSync(source, "<p>new figures</p>");
    ok("decision", "d1", "--body", source, "--log", "figures as of 15:00");
    expect(readFileSync(join(root, "decisions", "d1.html"), "utf8")).toBe("<p>new figures</p>");
    expect(item()["revised"]).not.toBeNull();
    ok("decision", "d1", "--no-body");
    expect(item()["body"]).toBe(false);
    expect(existsSync(join(root, "decisions", "d1.html"))).toBe(false);
    expect(refused("decision", "d1", "--body", join(root, "missing.html"))).toContain("cannot read");
  });
});

describe("readable", () => {
  const BASE = ["--why", "w", "--option", "A: yes | go", "--option", "B: no | stop", "--recommend", "A", "--reason", "r"];
  const hasNu = Bun.which("nu") !== null;

  test("a question over 400 characters is refused with how far over", () => {
    const err = refused("decision", "d1", "--kind", "decision", "--title", "T", "--question", "x".repeat(401), ...BASE);
    expect(err).toContain("--question is 401 characters, 1 over the 400 a question holds");
    expect(err).toContain("--body FILE");
    ok("decision", "d1", "--kind", "decision", "--title", "T", "--question", "x".repeat(400), ...BASE);
    expect(refused("decision", "d1", "--question", "y".repeat(401), "--same-options")).toContain("1 over");
  });

  test("a stored long question still takes other changes", () => {
    ok("decision", "d1", "--kind", "decision", "--title", "T", "--question", "q?", ...BASE);
    const s = state();
    const decisions = (asArray(s["decisions"]) ?? []).map((r) => ({ ...asObject(r), question: "x".repeat(1300) }));
    writeFileSync(join(root, "state.json"), JSON.stringify({ ...s, decisions }));
    ok("decision", "d1", "--why", "infra reviewed it", "--log", "infra reviewed it");
    expect(String(item()["question"]).length).toBe(1300);
  });

  test("hard reading is warned, not refused", () => {
    let r = run("decision", "d1", "--kind", "decision", "--title", "T", "--question", "Re-read by sha1 and alias? " + "x".repeat(300), "--why", "w".repeat(301), "--option", "A: yes | " + "c".repeat(161), "--option", "B: no | stop", "--recommend", "A", "--reason", "r");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("d1's question is 327 characters and it has no --body");
    expect(r.stderr).toContain("uses words the user may not know (sha1, alias)");
    expect(r.stderr).toContain("d1's why is 301 characters");
    expect(r.stderr).toContain("consequences over 160 characters: A (161)");
    r = run("decision", "d1", "--question", "Ship it?", "--same-options");
    expect(r.stderr).toContain("d1 was asked again with new words and no --log");
    r = run("decision", "d1", "--question", "Ship it now?", "--same-options", "--log", "now, not tonight");
    expect(r.stderr).toBe("");
  });

  test("a revision logs only the fields it moved", () => {
    ok("decision", "d1", "--kind", "decision", "--title", "T", "--question", "q?", ...BASE);
    ok("decision", "d1", "--kind", "decision", "--title", "T", "--question", "q?", "--why", "w2", "--same-options");
    expect(lastEvent()["text"]).toBe("T changed: why");
    ok("decision", "d1", "--title", "T");
    expect(lastEvent()["text"]).toBe("T changed: nothing new (the same values given again)");
  });

  test("a long grilling question is warned, not refused", () => {
    let r = run("grill", "g1", "--title", "T", "--ask", "t | " + "q".repeat(301) + " | r | w");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("g1's Q1 is 301 characters");
    r = run("grill", "g1", "--revise", "Q1: t | short now? | r | w");
    expect(r.stderr).not.toContain("characters");
  });

  test("a long why is refused and a worker's id is warned", () => {
    const base = ["--kind", "decision", "--title", "T", "--option", "A: yes | go", "--option", "B: no | stop", "--recommend", "A", "--reason", "r"];
    expect(refused("decision", "d1", ...base, "--question", "q?", "--why", "w".repeat(401))).toContain("--why is 401 characters, 1 over the 400 a why holds");
    const r = run("decision", "d1", ...base, "--question", "May infra run the turn gate on a1's fixes, as G26 and p12 say?", "--why", "w".repeat(201), "--title", "invoice-gen's fixes");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("uses words the user may not know (turn gate)");
    expect(r.stderr).toContain("d1 names workers (invoice-gen, a1):");
    expect(r.stderr).toContain("d1's why is 201 characters");
  });

  test("an open grilling's title and why are revised with a log", () => {
    ok("grill", "g1", "--title", "Is the graph a projection, given the ontology's loop?", "--ask", "t | q? | r | w");
    ok("grill", "g1", "--title", "Where the legal terms live", "--log", "the title in plain words");
    expect([item("g1")["title"], item("g1")["change"]]).toEqual(["Where the legal terms live", "the title in plain words"]);
    expect(lastEvent()["text"]).toBe("Where the legal terms live: the title in plain words");
    ok("grill", "g1", "--why", "Nothing changes until you answer.");
    expect(lastEvent()["text"]).toBe("Where the legal terms live: the why changed");
    expect(refused("grill", "g1", "--title", "")).toContain("a grilling keeps a title");
  });

  test("parts or numbers with no picture are told they need one", () => {
    const base = ["--kind", "decision", "--title", "T", "--option", "A: yes | go", "--option", "B: no | stop", "--recommend", "A", "--reason", "r", "--why", "w"];
    expect(run("decision", "d1", ...base, "--question", "Should the terms move to the graph database?").stderr).toContain("d1 looks like it needs a visual (graph, database)");
    const picture = join(root, "picture.html");
    writeFileSync(picture, "<svg viewBox='0 0 1 1'></svg>");
    expect(run("decision", "d2", ...base, "--question", "Should the terms move to the graph database?", "--body", picture).stderr).not.toContain("needs a visual");
  });

  test("a past answer is named by its number", () => {
    const base = ["--kind", "decision", "--title", "T", "--option", "A: yes | go", "--option", "B: no | stop", "--recommend", "A", "--reason", "r"];
    expect(run("decision", "d1", ...base, "--question", "Block it, although you decided it stays read-only?", "--why", "w").stderr).toContain('d1 refers to what the user decided ("you decided") with no decision number');
    expect(run("decision", "d2", ...base, "--question", "Block it, although D18 (10-08) you decided keeps it read-only?", "--why", "w").stderr).not.toContain("refers to what the user decided");
  });

  test("a grilling question takes options and recommends one by id", () => {
    ok("grill", "g1", "--title", "T", "--ask", "t | Where? | a | One store keeps it simple.", "--option", "Q1 a: Postgres | one place to undo", "--option", "Q1 b: Neo4j | quicker to query");
    const questions = (asArray(item("g1")["questions"]) ?? []).map((q) => asObject(q) ?? {});
    expect(questions[0]?.["options"]).toEqual([
      { id: "a", label: "Postgres", consequence: "one place to undo" },
      { id: "b", label: "Neo4j", consequence: "quicker to query" },
    ]);
    expect(refused("grill", "g1", "--revise", "Q1: t | Where? | (a) | w")).toContain("Q1's recommendation '(a)' is not one of its options (a, b)");
    ok("grill", "g1", "--ask", "t2 | Legacy? (a) yes; (b) no | (a) | w");
    const legacy = asObject((asArray(item("g1")["questions"]) ?? [])[1]) ?? {};
    expect("options" in legacy).toBe(false);
  });

  test("a grilling takes a body and warns on a reason written for engineers", () => {
    const body = join(root, "context.html");
    writeFileSync(body, "<p>ctx</p>");
    const r = run("grill", "g1", "--title", "T", "--body", body, "--ask", "t | q? | r | The store holds it (store.ts:5-9), per ADR-0020. " + "w".repeat(200));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("g1's Q1 reason is 249 characters");
    expect(r.stderr).toContain("g1's Q1 reason opens with sources (store.ts:5-9, ADR-0020)");
    expect(item("g1")["body"]).toBe(true);
    expect(existsSync(join(root, "decisions", "g1.html"))).toBe(true);
    ok("grill", "g1", "--no-body");
    expect(lastEvent()["text"]).toBe("T: the context changed");
  });

  test.skipIf(!hasNu)("a nu block that does not parse in nushell is refused", () => {
    const base = ["--kind", "action", "--title", "T", "--question", "q", "--why", "w"];
    expect(refused("decision", "a1", ...base, "--manual", "Run:\n```nu\nfor f in *; do echo $f; done\n```")).toContain(
      "--manual's nu block 1 does not parse in nushell (nu-check --debug: Missing argument to `in`.)",
    );
    ok("decision", "a1", ...base, "--manual", "Run:\n```nu\nls | where size > 1kb\n```\n```sh\ncd x && make\n```");
  });

  test("bash in a nu block is warned without nu", () => {
    const path = process.env["PATH"];
    process.env["PATH"] = tmp();

    try {
      const r = run("decision", "a1", "--kind", "action", "--title", "T", "--question", "q", "--why", "w", "--manual", "```nu\nexport FOO=1\ncd x && echo $(date)\n```");
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain("a1's manual has bash in a nu block (&&, export X=, $(...))");
    } finally {
      process.env["PATH"] = path;
    }
  });
});

describe("close", () => {
  test("deciding records the answer and how it came", () => {
    ok("decision", ...SCHEMA);
    ok("decision", "d1", "--decide", "B: keep both", "--resolution", "answered on the page (#14)");
    const d = item();
    expect([d["status"], d["answer"], d["resolution"]]).toEqual(["decided", "B: keep both", "answered on the page (#14)"]);
    expect(d["closed"]).not.toBeNull();
    const event = lastEvent();
    expect([event["kind"], event["decision"]]).toEqual(["decision", "d1"]);
    expect(String(event["text"])).toContain("B: keep both");
  });

  test("deciding needs how and withdrawing needs why", () => {
    ok("decision", ...SCHEMA);
    expect(refused("decision", "d1", "--decide", "A")).toContain("--resolution");
    expect(item()["status"]).toBe("open");
    ok("decision", "d1", "--withdraw", "the worker found the answer in the migration notes");
    const d = item();
    expect([d["status"], d["resolution"], d["answer"]]).toEqual(["withdrawn", "the worker found the answer in the migration notes", null]);
    expect(lastEvent()["kind"]).toBe("resolved");
  });

  test("a closed item is not edited or closed again", () => {
    ok("decision", ...SCHEMA);
    ok("decision", "d1", "--decide", "A", "--resolution", "said in the session");

    for (const args of [["--why", "new"], ["--decide", "B", "--resolution", "x"], ["--withdraw", "moot"]]) {
      expect(refused("decision", "d1", ...args)).toContain("--supersedes d1");
    }

    expect(item()["answer"]).toBe("A");
  });

  test("a new item supersedes a closed one", () => {
    ok("decision", ...SCHEMA);
    expect(refused("decision", "d2", ...SCHEMA.slice(1), "--supersedes", "d1")).toContain("still open");
    ok("decision", "d1", "--decide", "A", "--resolution", "said in the session");
    ok("decision", "d2", ...SCHEMA.slice(1), "--supersedes", "d1");
    expect(item("d2")["supersedes"]).toBe("d1");
    expect(refused("decision", "d3", ...SCHEMA.slice(1), "--supersedes", "d9")).toContain("unknown decision");
  });

  test("a decision made elsewhere is recorded closed and has no page", () => {
    ok("decision", "d1", "--title", "Model for the rename sweep", "--question", "Haiku for the rename sweep?", "--decide", "yes", "--resolution", "said in the session");
    const d = item();
    expect([d["status"], d["kind"], d["page"], d["answer"]]).toEqual(["decided", "decision", false, "yes"]);
    expect(rows("events").filter((e) => e["decision"] === "d1").map((e) => e["kind"])).toEqual(["decision"]);
  });
});

describe("asks", () => {
  test("a decision asks the user unless it is put to the manager", () => {
    ok("decision", ...SCHEMA);
    expect(item()["asks"]).toBe("user");
  });

  test("one put to the manager does not call the user", () => {
    ok("decision", ...SCHEMA, "--blocking", "--asks", "manager");
    expect(item()["asks"]).toBe("manager");
    const event = lastEvent();
    expect(event["kind"]).toBe("asked");
    expect(event).not.toHaveProperty("important");
    expect(String(event["text"]).startsWith("For the manager: ")).toBe(true);
  });

  test("passing it to the user calls them", () => {
    ok("decision", ...SCHEMA, "--blocking", "--asks", "manager");
    ok("decision", "d1", "--asks", "user", "--log", "the manager passed it on: the choice is yours");
    const d = item();
    expect([d["asks"], d["change"]]).toEqual(["user", "the manager passed it on: the choice is yours"]);
    const event = lastEvent();
    expect([event["kind"], event["important"], event["decision"]]).toEqual(["asked", true, "d1"]);
  });
});

describe("roadblocks", () => {
  const ROADBLOCK = ["roadblock", "r1", "--title", "Schema undecided", "--detail", "invoice-gen is stopped", "--severity", "serious", "--needs", "user", "--agent", "a1"];

  test("a roadblock that needs the user names its decision", () => {
    expect(refused(...ROADBLOCK)).toContain("--decision");
    expect(refused(...ROADBLOCK, "--decision", "d1")).toContain("unknown decision");
    ok("decision", ...SCHEMA, "--blocking", "--agent", "a1");
    ok(...ROADBLOCK, "--decision", "d1");
    expect(rows("roadblocks")[0]?.["decision"]).toBe("d1");
    ok("roadblock", "r2", "--title", "T", "--detail", "D", "--severity", "warning", "--needs", "coordinator");
  });

  test("closing the decision clears its roadblocks and frees the worker", () => {
    ok("decision", ...SCHEMA, "--blocking", "--agent", "a1");
    ok(...ROADBLOCK, "--decision", "d1");
    expect(rows("agents")[0]?.["status"]).toBe("blocked");
    ok("decision", "d1", "--decide", "A", "--resolution", "answered on the page");
    expect(rows("roadblocks")[0]?.["resolved"]).toBe(true);
    expect(rows("agents")[0]?.["status"]).toBe("running");
  });

  test("a roadblock cannot hang on a closed decision", () => {
    ok("decision", ...SCHEMA);
    ok("decision", "d1", "--withdraw", "moot");
    expect(refused(...ROADBLOCK, "--decision", "d1")).toContain("withdrawn");
  });
});

describe("ledger", () => {
  test("show lists what waits and what was decided", () => {
    ok("decision", ...SCHEMA, "--blocking");
    ok("decision", "d2", "--kind", "input", "--title", "Rate limit", "--question", "q", "--why", "w");
    ok("decision", "d2", "--decide", "200 per minute", "--resolution", "said in the chat (#3)");
    const out = fleet(["state", root, "show"], env).stdout;
    expect(out).toContain("decision d1 OPEN, blocking [decision] Invoice schema");
    expect(out).toContain("decision d2 decided [input] Rate limit: 200 per minute");
  });

  test("a state from before decisions still renders", () => {
    const old = { ...state() };
    delete old["decisions"];
    writeFileSync(join(root, "state.json"), JSON.stringify(old));
    const result = fleet(["state", root, "set", "--now", "later"], env);
    expect(result.code, result.stderr).toBe(0);
    expect(state()["decisions"]).toEqual([]);
    expect(existsSync(join(root, "index.html"))).toBe(true);
  });

  test("a state whose decisions are malformed is refused", () => {
    ok("decision", ...SCHEMA);
    const good = readFileSync(join(root, "state.json"), "utf8");

    for (const [change, word] of [
      [{ status: "maybe" }, "status"],
      [{ kind: "poll" }, "kind"],
      [{ supersedes: "d9" }, "d9"],
    ] as const) {
      const ledger = JSON.parse(good);
      Object.assign(ledger.decisions[0], change);
      writeFileSync(join(root, "state.json"), JSON.stringify(ledger));
      expect(refused("set", "--now", "x")).toContain(word);
    }
  });
});

const ACTION = [
  "a1",
  "--kind",
  "action",
  "--title",
  "Run the role cut",
  "--question",
  "Run the pipeline role cut?",
  "--why",
  "the cut feeds the next milestone",
  "--manual",
  "just cut --roles",
];

/** The user answered, and the fleet must do something before the item can proceed: it holds it (off the
 * user's list, the answer counted as recorded) until it re-presents it with new words. */
describe("hold", () => {
  const answer = (text = "needs a code change first", at = "2999-01-01T00:00:00+00:00"): void => {
    writeFileSync(join(root, "chat.jsonl"), `${JSON.stringify({ id: 1, at, from: "user", to: ["coordinator"], text, re: null, decision: "a1" })}\n`);
  };

  const hold = (reason = "fix the role cut first"): void => {
    const result = fleet(["state", root, "decision", "A1", "--hold", reason, "--no-render"], { ...env, FLEET_NOW: "2999-01-01T00:01:00+00:00" });
    expect(result.code, result.stderr).toBe(0);
  };

  test("holding an answered item records the answer and logs why", () => {
    ok("decision", ...ACTION);
    answer();
    expect(run("event", "x").stderr).toContain("the user answered A1");
    hold();
    const d = item("a1");
    expect([d["status"], d["held"], Date.parse(String(d["held_at"]))]).toEqual(["open", "fix the role cut first", Date.parse("2999-01-01T00:01:00+00:00")]);
    const e = lastEvent();
    expect([e["kind"], e["text"], e["decision"], e["important"]]).toEqual(["note", "Run the role cut held by the fleet: fix the role cut first", "a1", undefined]);
    expect(run("event", "y").stderr).not.toContain("the user answered");
    expect(fleet(["state", root, "show"], env).stdout).toContain("decision a1 OPEN, held by the fleet (fix the role cut first) [action] Run the role cut");
  });

  test("an answer given after the hold is news again", () => {
    ok("decision", ...ACTION);
    answer();
    hold();
    answer("actually, run it now", "2999-01-01T00:02:00+00:00");
    expect(run("event", "x").stderr).toContain("the user answered A1");
  });

  test("unhold takes the hold back", () => {
    ok("decision", ...ACTION);
    expect(refused("decision", "a1", "--unhold")).toContain("is not held");
    hold();
    ok("decision", "a1", "--unhold");
    expect(item("a1")).not.toHaveProperty("held");
    expect(lastEvent()["text"]).toBe("Run the role cut no longer held by the fleet");
  });

  test("a revision that re-presents it clears the hold", () => {
    ok("decision", ...ACTION);
    hold();
    ok("decision", "a1", "--why", "it still feeds the next milestone");
    expect(item("a1")["held"]).toBe("fix the role cut first");
    ok("decision", "a1", "--manual", "just cut --roles --fixed", "--log", "the new command");
    expect(item("a1")).not.toHaveProperty("held");
    expect(item("a1")).not.toHaveProperty("held_at");
    expect([lastEvent()["kind"], item("a1")["change"]]).toEqual(["asked", "the new command"]);
    hold();
    ok("decision", "a1", "--question", "Run the fixed role cut?");
    expect(item("a1")).not.toHaveProperty("held");
  });

  test("closing clears the hold, and a closed item refuses one", () => {
    ok("decision", ...ACTION);
    hold();
    ok("decision", "a1", "--decide", "ran it", "--resolution", "said in the session");
    expect(item("a1")).not.toHaveProperty("held");
    expect(refused("decision", "a1", "--hold", "again")).toContain("is already decided");
    expect(refused("decision", "a1", "--unhold")).toContain("is already decided");
    ok("decision", ...SCHEMA);
    ok("decision", "d1", "--hold", "x");
    ok("decision", "d1", "--withdraw", "moot");
    expect(item("d1")).not.toHaveProperty("held");
  });

  test("a hold names an open item and a reason", () => {
    expect(refused("decision", "a9", "--hold", "x")).toContain("unknown decision 'a9'");
    ok("decision", ...ACTION);
    expect(refused("decision", "a1", "--hold", " ")).toContain("--hold says what the fleet does first");
    expect(run("decision", "a1", "--hold", "x", "--withdraw", "y").code).toBe(2);
  });

  test("a new grilling round clears the hold", () => {
    ok("grill", "g1", "--title", "Rules", "--ask", "t | q | r | w");
    ok("decision", "g1", "--hold", "reading the code first");
    expect(item("g1")["held"]).toBe("reading the code first");
    ok("grill", "g1", "--ask", "t2 | q2 | r2 | w2");
    expect(item("g1")).not.toHaveProperty("held");
  });

  test("a ledger held without its stamp, or closed and held, is refused", () => {
    ok("decision", ...ACTION);
    const good = readFileSync(join(root, "state.json"), "utf8");

    for (const [change, word] of [
      [{ held: "x" }, "held without"],
      [{ held: "x", held_at: "2026-01-01T00:00:00+00:00", status: "withdrawn" }, "still held"],
    ] as const) {
      const ledger = JSON.parse(good);
      Object.assign(ledger.decisions[0], change);
      writeFileSync(join(root, "state.json"), JSON.stringify(ledger));
      expect(refused("set", "--now", "x")).toContain(word);
    }
  });
});

/** The user ran an action's commands and they failed: the page posts "Failed: <what happened>". The step is
 * not done: the fleet fixes it and re-presents it, or withdraws it; it is never recorded as decided. */
describe("a failed action", () => {
  const FAILED = "Failed: just: recipe `cut` not found\nerror: Justfile does not contain recipe `cut`.";

  const NAG = "state: the user ran A1 (Run the role cut) and it failed, #1 at 00:00: just: recipe `cut` not found. It is not done: ";

  const say = (...lines: { id: number; at: string; from: string; text: string; re?: number; decision?: string }[]): void => {
    writeFileSync(join(root, "chat.jsonl"), lines.map((m) => `${JSON.stringify({ to: m.from === "user" ? ["coordinator"] : ["user"], re: null, ...m })}\n`).join(""));
  };

  const failed = { id: 1, at: "2999-01-01T00:00:00+00:00", from: "user", text: FAILED, decision: "a1" };

  const later = (...args: string[]): Ran => fleet(["state", root, ...args, "--no-render"], { ...env, FLEET_NOW: "2999-01-01T00:05:00+00:00" });

  test("every command says it failed and how to go on, never to decide it", () => {
    ok("decision", ...ACTION);
    say(failed);
    const warned = run("event", "x").stderr;
    expect(warned).toContain(NAG);
    expect(warned).toContain('decision A1 --manual "..." --log "what changed"');
    expect(warned).toContain('--withdraw "why"');
    expect(warned).toContain("never --decide it");
    expect(warned).not.toContain("the user answered A1");
  });

  test("show names it failed, with the user's first words", () => {
    ok("decision", ...ACTION);
    say(failed);
    expect(fleet(["state", root, "show"], env).stdout).toContain("  A1 decision a1 OPEN, failed for the user (#1: just: recipe `cut` not found) [action] Run the role cut\n");
  });

  test("--decide is refused while it stands failed; --withdraw closes it", () => {
    ok("decision", ...ACTION);
    say(failed);
    const said = refused("decision", "A1", "--decide", "ran it", "--resolution", "answered on the page (#1)");
    expect(said).toContain("Run the role cut failed for the user (#1: just: recipe `cut` not found) and is not done");
    expect(said).toContain('--withdraw "why"');
    expect(item("a1")["status"]).toBe("open");
    ok("decision", "A1", "--withdraw", "the role cut moved to CI");
    expect(item("a1")["status"]).toBe("withdrawn");
    expect(run("event", "y").stderr).not.toContain("and it failed");
  });

  test("a reply does not settle it; a hold does until the next answer", () => {
    ok("decision", ...ACTION);
    say(failed, { id: 2, at: "2999-01-01T00:00:30+00:00", from: "coordinator", text: "looking", re: 1, decision: "a1" });
    expect(run("event", "x").stderr).toContain(NAG);
    expect(later("decision", "A1", "--hold", "fixing the recipe").code).toBe(0);
    expect(run("event", "y").stderr).not.toContain("and it failed");
    expect(fleet(["state", root, "show"], env).stdout).toContain("OPEN, held by the fleet (fixing the recipe), failed for the user (#1: just: recipe `cut` not found) [action]");
    expect(refused("decision", "A1", "--decide", "ran it", "--resolution", "x")).toContain("is not done");
  });

  test("a revision re-presents it, and its next answer is an ordinary one", () => {
    ok("decision", ...ACTION);
    say(failed);
    expect(later("decision", "A1", "--manual", "just cut-roles", "--log", "the recipe is cut-roles").code).toBe(0);
    expect(run("event", "x").stderr).not.toContain("and it failed");
    expect(fleet(["state", root, "show"], env).stdout).toContain("  A1 decision a1 OPEN [action] Run the role cut\n");
    say(failed, { id: 2, at: "2999-01-01T00:06:00+00:00", from: "user", text: "Done.", decision: "a1" });
    expect(run("event", "y").stderr).toContain("state: the user answered A1 (Run the role cut) as #2 at 00:06");
    ok("decision", "A1", "--decide", "ran it", "--resolution", "answered on the page (#2)");
  });

  test("Done after Failed is an ordinary answer; Failed on another kind is too", () => {
    ok("decision", ...ACTION);
    say(failed, { id: 2, at: "2999-01-01T00:01:00+00:00", from: "user", text: "Done.\nit worked on the second try", decision: "a1" });
    expect(run("event", "x").stderr).toContain("the user answered A1");
    ok("decision", ...SCHEMA);
    say({ ...failed, decision: "d1", text: "Failed: neither" });
    const warned = run("event", "y").stderr;
    expect(warned).toContain("the user answered D1");
    expect(warned).not.toContain("and it failed");
  });
});

describe("answers", () => {
  test("an open item takes an answer", () => {
    ok("decision", ...SCHEMA);
    expect(answerRefusal(root, "d1", "B: keep both")).toBeUndefined();
    expect(answerRefusal(root, "d1", "None of these: split the table instead")).toBeUndefined();
  });

  test("an unknown or closed item refuses with the reason", () => {
    expect(answerRefusal(root, "d1", "A")).toContain("unknown decision");
    ok("decision", ...SCHEMA);
    ok("decision", "d1", "--withdraw", "the worker found the answer in the migration notes");
    const said = answerRefusal(root, "d1", "A") ?? "";
    expect(said).toContain("withdrawn");
    expect(said).toContain("the worker found the answer in the migration notes");
  });

  test("a secret takes a reference or an item name and never a value", () => {
    ok("decision", "d1", "--kind", "secret", "--title", "Neo4j password", "--question", "Where is the Neo4j password?", "--why", "w", "--secret", "NEO4J_PASSWORD", "--manual", "secretspec set NEO4J_PASSWORD");

    for (const fine of [
      "op://Engineering/Neo4j Aura/password",
      "op://dev/abcdefghijklmnopqrstuvwxyz/section/credential",
      "Neo4j Aura (prod)",
      "NEO4J_PASSWORD in the Engineering vault",
      "Set by hand.",
    ]) {
      expect(answerRefusal(root, "d1", fine), fine).toBeUndefined();
    }

    for (const value of [
      "sk-ant-api03-Zk9xQ2",
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "xoxb-12345-abcdef",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
      "f3a9c1d27b6e4f0a8d5c2b1e9f7a6d3c",
      "AKIAIOSFODNN7EXAMPLE",
      "the password is hunter2hunter2hunter2",
      "-----BEGIN PRIVATE KEY-----",
      "x".repeat(300),
    ]) {
      expect(answerRefusal(root, "d1", value), value).toContain("never the value");
    }
  });

  test("other kinds take any text", () => {
    ok("decision", "d1", "--kind", "input", "--title", "T", "--question", "q", "--why", "w");
    expect(answerRefusal(root, "d1", "commit f3a9c1d27b6e4f0a8d5c2b1e9f7a6d3c is the one")).toBeUndefined();
  });
});

describe("permission", () => {
  const CALL = "git push --force origin HEAD:main 2>&1";

  /** The command the plugin's hook runs for a refused call, with `more` after it. */
  function refusal(id: string, ...more: string[]): string[] {
    return [
      "decision",
      id,
      "--kind",
      "permission",
      "--title",
      "Force-push main",
      "--question",
      "Let a1's refused call run once?",
      "--why",
      "auto mode refused it",
      "--tool",
      "Bash",
      "--call",
      CALL,
      "--cause",
      "[Git Destructive]",
      "--root",
      "/work/repo",
      ...more,
    ];
  }

  test("a refused call opens a permission, numbered P, with the exact rule and the two options the CLI sets", () => {
    ok(...refusal("p-1a2b3c4d", "--agent-id", "agent-7f", "--agent", "a1", "--blocking"));
    const d = item("p-1a2b3c4d");
    expect([d["kind"], d["status"], d["ref"], d["agent"], d["blocking"], d["recommend"]]).toEqual(["permission", "open", "P1", "a1", true, null]);
    expect(d["refusal"]).toEqual({
      tool: "Bash",
      call: CALL,
      rule: `Bash(${CALL})`,
      cause: "[Git Destructive]",
      root: "/work/repo",
      agent_id: "agent-7f",
    });
    expect(d["options"]).toEqual([
      {
        id: "allow-once",
        label: "Allow this call once",
        consequence: `the hub adds Bash(${CALL}) to /work/repo/.claude/settings.local.json; the plugin hook removes it once the call has run, or at the first tool call of the session after 30 minutes`,
      },
      { id: "deny", label: "Deny", consequence: "the worker stays stopped; your note goes to it" },
    ]);
  });

  test("a refused Agent call opens a permission whose grant goes to the hook's grants file, not the settings", () => {
    const spawn = JSON.stringify({ description: "prod count", prompt: "SELECT 1;\nreport", subagent_type: "general-purpose" });
    const args = refusal("p1");
    args[args.indexOf("--tool") + 1] = "Agent";
    args[args.indexOf("--call") + 1] = spawn;
    ok(...args);
    const d = item("p1");
    expect(asObject(d["refusal"] ?? null)?.["rule"]).toBe(`Agent(${spawn})`);
    expect(asObject(asArray(d["options"])?.[0] ?? null)?.["consequence"]).toBe(
      `the hub adds Agent(${spawn}) to /work/repo/.claude/tstack-grants.json, where the plugin's PreToolUse hook lets this exact Agent call through (auto mode ignores Agent allow rules in the settings); the plugin hook removes it once the call has run, or at the first tool call of the session after 30 minutes`,
    );
    args[args.indexOf("--call") + 1] = "spawn a worker";
    expect(refused(...args.map((a) => (a === "p1" ? "p2" : a)))).toContain("JSON object");
  });

  test("a value that starts with a dash is given as --flag=value", () => {
    const args = refusal("p1").filter((a, i, all) => a !== "--call" && all[i - 1] !== "--call" && a !== "--cause" && all[i - 1] !== "--cause");
    ok(...args, "--call=-x is not a command but a value", "--cause=-[Odd]");
    const r = asObject(item("p1")["refusal"] ?? null);
    expect([r?.["call"], r?.["cause"], r?.["rule"]]).toEqual(["-x is not a command but a value", "-[Odd]", "Bash(-x is not a command but a value)"]);
  });

  test("the session's main thread has no agent id", () => {
    ok(...refusal("p1"));
    expect(asObject(item("p1")["refusal"] ?? null)?.["agent_id"]).toBeNull();
  });

  test("a call an exact rule cannot hold, a relative root, a tool other than Bash, or options of its own are refused", () => {
    const with_ = (flag: string, value: string): string[] => {
      const args = refusal("p1");
      args[args.indexOf(flag) + 1] = value;

      return args;
    };

    expect(refused(...with_("--call", "git push\nrm -rf /"))).toContain("newline");
    expect(refused(...with_("--call", "git push\rrm -rf /"))).toContain("newline");
    expect(refused(...with_("--call", "rm -rf build/*"))).toContain("*");
    expect(refused(...with_("--call", "printf 'a\\tb'"))).toContain("backslash");
    expect(refused(...with_("--root", "work/repo"))).toContain("absolute");
    expect(refused(...with_("--tool", "Edit"))).toContain("Bash and Agent");
    expect(refused(...refusal("p1", "--option", "a: x | y"))).toContain("--option");
    expect(refused(...refusal("p1", "--recommend", "allow-once", "--reason", "r"))).toContain("--recommend");
    expect(refused("decision", "p1", "--kind", "permission", "--title", "T", "--question", "q", "--why", "w")).toContain("--call");
    expect(refused("decision", "d1", "--kind", "input", "--title", "T", "--question", "q", "--why", "w", "--call", "ls")).toContain("permission");
    expect(rows("decisions")).toEqual([]);
  });

  describe("a worker's workspace given as the root", () => {
    let session: string;

    let ws: string;

    function beat(name: string, project: string): void {
      mkdirSync(join(root, "heartbeats"), { recursive: true });
      writeFileSync(join(root, "heartbeats", `${name}.json`), JSON.stringify({ session: name, at: "2026-01-01T00:00:00+00:00", cwd: project, project }));
    }

    function listed(repo: string): void {
      writeFileSync(join(root, "state.json"), JSON.stringify({ ...state(), workspaces: [{ id: "b155", agent: "a1", path: ws, repo, status: "active" }] }));
    }

    function at(args: string[], value: string): string[] {
      const copy = [...args];
      copy[copy.indexOf("--root") + 1] = value;

      return copy;
    }

    beforeEach(() => {
      session = tmp("fleet-session-");
      ws = tmp("fleet-ws-");
    });

    test("is recorded as the session root, where the subagent's session reads its permissions, and the CLI says so", () => {
      beat("s1", session);
      listed(session);
      const result = run(...at(refusal("p1", "--agent", "a1"), ws));
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain(`--root ${ws} is b155's workspace: recorded the session root ${session}, where the subagent's session reads its permissions`);
      const d = item("p1");
      expect(asObject(d["refusal"] ?? null)?.["root"]).toBe(session);
      expect(JSON.stringify(d["options"])).toContain(`${session}/.claude/settings.local.json`);
    });

    test("is refused when the session root cannot be told, naming what it should be", () => {
      const other = tmp("fleet-other-");
      beat("s1", session);
      beat("s2", other);
      listed(tmp("fleet-third-"));
      const roots = [session, other].sort().join(" or ");
      expect(refused(...at(refusal("p1"), ws))).toContain(
        `a permission's root is the session root (${roots}), where the subagent's session reads its permissions, not the worker's workspace ${ws}`,
      );
      expect(rows("decisions")).toEqual([]);
    });

    test("a session root, or a folder the fleet does not know, is kept as given", () => {
      beat("s1", session);
      listed(session);
      ok(...at(refusal("p1"), session));
      expect(asObject(item("p1")["refusal"] ?? null)?.["root"]).toBe(session);
      ok(...refusal("p2"));
      expect(asObject(item("p2")["refusal"] ?? null)?.["root"]).toBe("/work/repo");
    });
  });

  test("the same refusal again revises the open row, and it closes as any decision does", () => {
    ok(...refusal("p1", "--agent-id", "agent-7f"));
    ok(...refusal("p1", "--agent-id", "agent-7f"));
    expect(rows("decisions").length).toBe(1);
    expect(item("p1")["revised"]).not.toBeNull();
    ok("decision", "P1", "--decide", "allow-once: Allow this call once", "--resolution", "answered on the page (#3)");
    expect([item("p1")["status"], item("p1")["answer"]]).toEqual(["decided", "allow-once: Allow this call once"]);
  });
});

describe("answeredAt: only the decision's own state records an answer, never a reply in the chat", () => {
  const D115: JsonObject = { id: "d115", ref: "D115", kind: "decision", status: "open", opened: "2026-10-05T09:00:00+00:00", revised: null };

  const say = (id: number, at: string, from: string, more: JsonObject = {}): Message => {
    const m = messageOf({ id, at, from, to: [from === "user" ? "coordinator" : "user"], text: from === "user" ? "B" : "Recorded B", re: null, ...more });

    if (m === undefined) throw new Error("a message the fixture wrote");

    return m;
  };

  // Infra's D115: the user answered (#608), the coordinator replied "Recorded B" (#609, re 608) and never ran --decide.
  const chat = [say(608, "2026-10-07T14:00:00+00:00", "user", { decision: "d115" }), say(609, "2026-10-07T14:01:00+00:00", "coordinator", { re: 608 })];

  test("an answer the coordinator replied to, with no change to the decision, is not recorded", () => {
    expect(answeredAt(D115, chat)).toBe("2026-10-07T14:00:00+00:00");
  });

  test("revised, held or closed at or after the answer, it is recorded", () => {
    expect(answeredAt({ ...D115, revised: "2026-10-07T14:05:00+00:00" }, chat)).toBeUndefined();
    expect(answeredAt({ ...D115, held: "the migration first", held_at: "2026-10-07T14:00:00+00:00" }, chat)).toBeUndefined();
    expect(answeredAt({ ...D115, status: "decided", closed: "2026-10-07T14:05:00+00:00" }, chat)).toBeUndefined();
    expect(answeredAt({ ...D115, status: "withdrawn" }, chat)).toBeUndefined();
  });

  test("held before the answer, it is not", () => {
    expect(answeredAt({ ...D115, held: "the migration first", held_at: "2026-10-07T13:00:00+00:00" }, chat)).toBe("2026-10-07T14:00:00+00:00");
  });

  test("a grilling records an answer by answering or dropping a question at or after it", () => {
    const question = (answered: string | null): JsonObject => ({ id: "q1", title: "T", status: answered === null ? "open" : "answered", answered });
    const g = { ...D115, kind: "grill", questions: [question(null), { ...question(null), id: "q2" }] };
    expect(answeredAt(g, chat)).toBe("2026-10-07T14:00:00+00:00");
    expect(answeredAt({ ...g, questions: [question("2026-10-07T14:02:00+00:00"), { ...question(null), id: "q2" }] }, chat)).toBeUndefined();
    expect(answeredAt({ ...g, questions: [question("2026-10-07T13:00:00+00:00"), { ...question(null), id: "q2" }] }, chat)).toBe("2026-10-07T14:00:00+00:00");
  });
});
