/**
 * The state CLI beyond decisions (ported from the coordinator's tests/test_state.py): what it tells a
 * coordinator that lost its context, and what it keeps for it. Through the CLI, as the Python tests.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { asArray, asObject, type Json, type JsonObject } from "../src/json.ts";
import { baseEnv, fleet, readJson, SKILL, spawnFleet, tmp, type Environment, type Ran } from "./support.ts";

/** A coordinator's DIR with milestones m1 and m2, run through the CLI with --no-render. */
class Fleet {
  readonly root: string;
  readonly env: Environment;

  constructor(root?: string) {
    const base = tmp();
    this.root = root ?? join(base, "coordinator");
    this.env = baseEnv(join(base, "registry"));
  }

  run(...args: string[]): Ran {
    return fleet(["state", this.root, ...args, "--no-render"], this.env);
  }

  ok(...args: string[]): string {
    const result = this.run(...args);
    expect(result.code, result.stderr).toBe(0);

    return result.stdout;
  }

  refused(...args: string[]): string {
    const result = this.run(...args);
    expect(result.code, result.stdout).toBe(1);
    expect(result.stderr).not.toContain("Traceback");

    return result.stderr;
  }

  state(): JsonObject {
    return readJson(join(this.root, "state.json"));
  }

  rows(key: string): JsonObject[] {
    return (asArray(this.state()[key]) ?? []).map((r) => asObject(r) ?? {});
  }

  setUp(): this {
    this.ok("init", "--project", "p", "--goal", "g");
    this.ok("milestone", "m1", "--title", "Usage records");
    this.ok("milestone", "m2", "--title", "Verify and ship");

    return this;
  }
}

function stepsOf(f: Fleet, milestone = "m1"): string[] {
  const m = f.rows("roadmap").find((x) => x["id"] === milestone);

  return (asArray(m?.["steps"]) ?? []).map((s) => String(asObject(s)?.["id"]));
}

function last(f: Fleet): JsonObject {
  return f.rows("events").at(-1) ?? {};
}

let f: Fleet;

describe("show", () => {
  beforeEach(() => {
    f = new Fleet().setUp();
  });

  test("show ends with the commands and the values they take", () => {
    const out = f.ok("show");

    for (const word of [
      "decision ID",
      "roadblock ID",
      "--severity warning|serious|critical",
      "--needs user|coordinator|worker",
      "--kind spawned|reported|blocked|resolved|asked|decision|note|integrated",
      "--status blocked|done|failed|queued|running|stopped",
      "--skill implement|diagnosing-bugs|prototype|research|tdd|none",
      "--model opus|sonnet|haiku|fable",
      "--effort low|medium|high|xhigh|max",
      "--kind decision|input|secret|action",
    ]) {
      expect(out).toContain(word);
    }
  });

  test("show lists the milestones by id", () => {
    const out = f.ok("show");
    expect(out).toContain("m1 Usage records (0/0)");
    expect(out).toContain("m2 Verify and ship (0/0)");
  });
});

describe("steps", () => {
  beforeEach(() => {
    f = new Fleet().setUp();

    for (const [id, title] of [
      ["l1", "billing: push master"],
      ["l0", "usage: the repair for 12 stale cases"],
      ["l2", "usage: deploy"],
    ] as const) {
      f.ok("step", id, "--milestone", "m1", "--title", title);
    }
  });

  test("a known step takes a new title", () => {
    f.ok("step", "l0", "--title", "usage: five case pass changes with migration 0081", "--status", "current");
    const step = (asArray(f.rows("roadmap")[0]?.["steps"]) ?? []).map((s) => asObject(s) ?? {}).find((s) => s["id"] === "l0");
    expect([step?.["title"], step?.["status"]]).toEqual(["usage: five case pass changes with migration 0081", "current"]);
  });

  test("steps are put in the order of their turn", () => {
    f.ok("step", "l0", "--before", "l1");
    expect(stepsOf(f)).toEqual(["l0", "l1", "l2"]);
    f.ok("step", "l0", "--after", "l2");
    expect(stepsOf(f)).toEqual(["l1", "l2", "l0"]);
    f.ok("step", "l9", "--milestone", "m1", "--title", "infra: rebuild the index", "--before", "l2");
    expect(stepsOf(f)).toEqual(["l1", "l9", "l2", "l0"]);
  });

  test("a place is among the steps of the same milestone", () => {
    f.ok("step", "s1", "--milestone", "m2", "--title", "elsewhere");
    expect(f.refused("step", "l0", "--before", "s1")).toContain("is in m2");
    expect(f.refused("step", "l0", "--after", "l7")).toContain("unknown step 'l7'");
    expect(f.refused("step", "l0", "--before", "l0")).toContain("itself");
    expect(stepsOf(f)).toEqual(["l1", "l0", "l2"]);
  });

  test("a step stays in its milestone", () => {
    expect(f.refused("step", "l0", "--milestone", "m2")).toContain("stays in m1");
    f.ok("step", "l0", "--milestone", "m1", "--title", "same milestone, new words");
  });

  test("a step queued in error is removed and the log says so", () => {
    f.ok("step", "l2", "--remove", "queued twice: l0 is the same landing");
    expect(stepsOf(f)).toEqual(["l1", "l0"]);
    const event = last(f);
    expect([event["kind"], event["text"]]).toEqual(["note", "Step l2 removed (usage: deploy): queued twice: l0 is the same landing"]);
    expect(f.refused("step", "l2", "--remove", "again")).toContain("unknown step 'l2'");
  });
});

describe("agents", () => {
  beforeEach(() => {
    f = new Fleet().setUp();
  });

  test("a worker on an unknown milestone is refused with the ones there are", () => {
    const said = f.refused("agent", "a1", "--task", "t", "--milestone", "m9");
    expect(said).toContain("unknown milestone 'm9'");
    expect(said).toContain("m1, m2");
    expect(f.rows("agents")).toEqual([]);
    f.ok("agent", "a1", "--task", "t", "--milestone", "m1");
    expect(f.refused("agent", "a1", "--milestone", "m9")).toContain("unknown milestone 'm9'");
  });

  test("recording a worker says the id its brief carries", () => {
    const out = f.ok("agent", "a1", "--task", "t", "--milestone", "m1", "--name", "invoice-gen");
    expect(out).toContain("recorded a1 (invoice-gen)");
    expect(out).toContain("your id is a1");
    expect(out).toContain(join(f.root, "brief.md"));
  });

  test("a name two workers share is refused naming the id first", () => {
    f.ok("agent", "a1", "--task", "t", "--milestone", "m1", "--name", "n1");
    f.ok("agent", "a2", "--task", "t", "--milestone", "m1", "--name", "n2");
    expect(f.refused("agent", "A1", "--task", "t", "--milestone", "m1", "--name", "n2")).toContain(
      "agent A1 is called 'a1', which is also agent a1",
    );
  });

  test("a worker sent back after its report starts a new round", () => {
    f.ok("agent", "a1", "--task", "t", "--milestone", "m1");
    expect(f.rows("agents")[0]?.["rounds"]).toBe(1);
    f.ok("agent", "a1", "--status", "done", "--tokens", "100");
    f.ok("agent", "a1", "--status", "running", "--log", "sent back: the probe found an open route");
    f.ok("agent", "a1", "--status", "running");
    f.ok("agent", "a1", "--status", "done", "--tokens", "180");
    f.ok("agent", "a1", "--status", "running");
    const a = f.rows("agents")[0] ?? {};
    expect([a["rounds"], a["tokens"]]).toEqual([3, 180]);
    expect(f.ok("show")).toContain("round 3");
  });
});

describe("park", () => {
  beforeEach(() => {
    f = new Fleet().setUp();
  });

  test("park stops every live row in one command and says why", () => {
    for (const [a, status] of [
      ["a1", "running"],
      ["a2", "queued"],
      ["a3", "done"],
    ] as const) {
      f.ok("agent", a, "--task", "t", "--milestone", "m1");
      f.ok("agent", a, "--status", status);
    }

    f.ok("park", "Luiz paused the UI work");
    expect(f.rows("agents").map((a) => a["status"])).toEqual(["stopped", "stopped", "done"]);
    expect(last(f)["text"]).toBe("Stopped a1, a2: Luiz paused the UI work");
    expect(f.refused("park", "again")).toContain("no worker row is running");
  });

  test("park can name the workers", () => {
    for (const a of ["a1", "a2"]) f.ok("agent", a, "--task", "t", "--milestone", "m1");
    f.ok("park", "--agent", "a2", "its lane was dropped");
    expect(f.rows("agents").map((a) => a["status"])).toEqual(["running", "stopped"]);
    expect(f.refused("park", "--agent", "a9", "x")).toContain("unknown agent 'a9'");
  });

  test("a paused fleet with running rows is warned on every command", () => {
    f.ok("agent", "a1", "--task", "t", "--milestone", "m1");
    const said = f.run("set", "--status", "paused");
    expect(said.stderr).toContain("a1 still read as running/queued/blocked while the fleet is paused");
    expect(said.stderr).toContain("park");
    f.ok("park", "paused");
    expect(f.run("event", "x").stderr).not.toContain("still read as");
  });

  test("a now line not said again is pointed out", () => {
    expect(f.run("event", "x").stderr).not.toContain("Now line");
    const state = { ...f.state() };
    delete state["now_at"];
    writeFileSync(join(f.root, "state.json"), JSON.stringify(state));
    expect(f.run("event", "x").stderr).toContain("the page's Now line (never stamped)");
    f.ok("set", "--now", "l9 deploying");
    expect(f.run("event", "y").stderr).not.toContain("Now line");
  });

  test("a now line is stamped when it is said", () => {
    const state = { ...f.state() };
    delete state["now_at"];
    writeFileSync(join(f.root, "state.json"), JSON.stringify(state));
    f.ok("set", "--now", "l9 deploying");
    expect(f.state()["now_at"]).toBeTruthy();
  });

  test("a note command points at event", () => {
    expect(f.refused("note", "x")).toContain("event --kind note TEXT");
  });
});

describe("measured", () => {
  test("tokens and duration come from the worker's transcript", () => {
    const config = tmp();
    const root = join(tmp(), "-home-x", "s1", "scratchpad", "coordinator");
    const sub = join(config, "projects", "-home-x", "s1", "subagents");
    mkdirSync(sub, { recursive: true });
    const env = baseEnv(tmp(), { CLAUDE_CONFIG_DIR: config });
    const usage = (n: number): Json => ({ input_tokens: 10, cache_read_input_tokens: n, cache_creation_input_tokens: 5, output_tokens: 100 });

    const lines = [
      { timestamp: "2026-09-29T10:00:00.000Z", message: { id: "m1", usage: usage(1000) } },
      { timestamp: "2026-09-29T10:02:30.000Z", message: { id: "m2", usage: usage(5000) } },
    ];

    writeFileSync(join(sub, "agent-abc123.jsonl"), `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`);
    const run = (...args: string[]): Ran => fleet(["state", root, ...args, "--no-render"], env);

    for (const args of [
      ["init", "--project", "p", "--goal", "g"],
      ["milestone", "m1", "--title", "M"],
      ["agent", "a1", "--task", "t", "--milestone", "m1", "--task-id", "abc123"],
    ]) {
      expect(run(...args).code).toBe(0);
    }

    const a = asObject(asArray(readJson(join(root, "state.json"))["agents"])?.[0]) ?? {};
    expect([a["tokens"], a["duration_ms"]]).toEqual([5115, 150000]);
    expect(run("agent", "a1", "--status", "done", "--tokens", "7").code).toBe(0);
    expect(asObject(asArray(readJson(join(root, "state.json"))["agents"])?.[0])?.["tokens"]).toBe(7);
  });
});

describe("keep and next", () => {
  beforeEach(() => {
    f = new Fleet().setUp();
  });

  test("step next takes the number after the highest", () => {
    f.ok("step", "l16", "--milestone", "m1", "--title", "a");
    f.ok("step", "l3", "--milestone", "m2", "--title", "b");
    expect(f.ok("step", "next", "--milestone", "m1", "--title", "c")).toContain("recorded step l17");
    expect(f.ok("step", "next", "--milestone", "m2", "--title", "d")).toContain("recorded step l18");
    expect(stepsOf(f)).toEqual(["l16", "l17"]);
  });

  test("kept items are shown and dropped with a reason", () => {
    f.ok("keep", "hunk-open", "pglite.worker.ts: hold the ENOENT rejection (a80's hunk)");
    expect(f.ok("show")).toContain("kept hunk-open: pglite.worker.ts");
    f.ok("keep", "hunk-open", "--drop", "landed in l3");
    expect(f.state()["kept"]).toEqual([]);
    expect(String(last(f)["text"])).toContain("landed in l3");
    expect(f.refused("keep", "x", "--drop", "y")).toContain("nothing kept");
  });
});

describe("grill", () => {
  beforeEach(() => {
    f = new Fleet().setUp();
  });

  test("a grilling is asked, answered, followed up and done", () => {
    expect(f.refused("grill", "g1", "--ask", "a | b | c | d")).toContain("--title");
    expect(f.refused("grill", "g1", "--title", "T", "--ask", "a | b | c")).toContain("why");
    f.ok(
      "grill",
      "g1",
      "--title",
      "Tab",
      "--ask",
      "Where | tab or sidebar? | tab | a tab opens first on a phone",
      "--ask",
      "Secrets | how? | refs | a value never passes the page",
    );
    let d = f.rows("decisions")[0] ?? {};
    const ids = (q: JsonObject): string[] => (asArray(q["questions"]) ?? []).map((x) => String(asObject(x)?.["id"]));
    expect([d["kind"], d["question"], ids(d)]).toEqual(["grill", "2 questions to answer", ["q1", "q2"]]);
    expect(last(f)["kind"]).toBe("asked");
    f.ok("grill", "g1", "--answer", "Q1: a sidebar", "--of", "q1", "--ask", "Side | left or right? | left | the chat is on the right");
    d = f.rows("decisions")[0] ?? {};
    const questions = (asArray(d["questions"]) ?? []).map((x) => asObject(x) ?? {});
    expect(questions.map((q) => [q["id"], q["status"], q["of"]])).toEqual([
      ["q1", "answered", null],
      ["q2", "open", null],
      ["q3", "open", "q1"],
    ]);
    expect(d["revised"]).toBeTruthy();
    expect(questions[0]?.["reason"]).toBe("a tab opens first on a phone");
    f.ok("grill", "g1", "--reason", "Q2: refs resolve where the code reads them");
    expect(asObject(asArray(f.rows("decisions")[0]?.["questions"])?.[1])?.["reason"]).toBe("refs resolve where the code reads them");
    expect(f.refused("grill", "g1", "--done", "x")).toContain("still open");
    expect(f.refused("grill", "g1", "--answer", "left")).toContain("Q3:");
    f.ok("grill", "g1", "--drop", "Q2: settled in the session", "--answer", "Q3: left", "--done", "a left sidebar");
    d = f.rows("decisions")[0] ?? {};
    expect([d["status"], d["answer"]]).toEqual(["decided", "a left sidebar"]);
  });

  test("a grilling is not opened with decision", () => {
    expect(f.refused("decision", "g2", "--kind", "grill", "--title", "t", "--question", "q", "--why", "w")).toContain("grill command");
  });
});

describe("links", () => {
  beforeEach(() => {
    f = new Fleet().setUp();
  });

  test("links are recorded, tied to a decision and dropped", () => {
    expect(f.refused("link", "l1")).toContain("--url and --title");
    f.ok("link", "review", "--url", "https://box.ts.net:47843/", "--title", "Lab review", "--kind", "page");
    expect(f.refused("link", "review", "--decision", "d9")).toContain("unknown decision");
    f.ok("link", "review", "--note", "mark each hit");
    const link = f.rows("links")[0] ?? {};
    expect([link["kind"], link["note"]]).toEqual(["page", "mark each hit"]);
    f.ok("link", "review", "--drop", "the review is done");
    expect(f.state()["links"]).toEqual([]);
  });

  test("a link takes the kinds people recognise, what the user does there, and done", () => {
    f.ok("link", "map", "--url", "https://box.ts.net:7501/caso/CA1014/prototipo/mapa", "--title", "Map, round 14", "--kind", "prototype", "--for", "review and mark");
    let link = f.rows("links")[0] ?? {};
    expect([link["kind"], link["for"], link["done"]]).toEqual(["prototype", "review and mark", undefined]);
    f.ok("link", "map", "--done");
    expect(f.rows("links")[0]?.["done"]).toBeTruthy();
    expect(f.ok("show")).toContain("[prototype, done] Map, round 14");
    expect(asObject((asArray(f.state()["events"]) ?? []).at(-1))?.["text"]).toContain("Link map (Map, round 14) done");
    f.ok("link", "map", "--reopen");
    link = f.rows("links")[0] ?? {};
    expect(link["done"]).toBeUndefined();
    expect(f.refused("link", "gone", "--done")).toContain("no link 'gone' to mark done");
    expect(f.run("link", "map", "--kind", "lab").code).toBe(2);
  });

  test("a new link without a kind is given the one its address reads as, and the CLI says so", () => {
    const said = f.run("link", "a", "--url", "https://claude.ai/artifact/Pn", "--title", "Wrike design");
    expect([said.code, said.stderr.includes("has no --kind: recorded as doc")]).toEqual([0, true]);
    f.run("link", "b", "--url", "https://box.ts.net:5424/x", "--title", "Tarefas tab prototype (throwaway)");
    f.run("link", "c", "--url", "https://box.ts.net:24116/", "--title", "Beta dev build");
    expect(f.rows("links").map((l) => l["kind"])).toEqual(["doc", "prototype", "preview"]);
  });

  test("a link's title with a worker's id is warned", () => {
    f.ok("agent", "b286", "--task", "write the note", "--milestone", "m1");
    const said = f.run("link", "n", "--url", "file:///tmp/note.md", "--title", "Design note (b286)", "--kind", "doc");
    expect([said.code, said.stderr.includes("link n's title names workers (b286)")]).toEqual([0, true]);
    expect(f.run("link", "n", "--title", "Design note: judgements across cases").stderr).not.toContain("names workers");
  });
});

describe("numbers", () => {
  beforeEach(() => {
    f = new Fleet().setUp();
  });

  test("each kind is numbered in order and a number finds its row", () => {
    const opt = ["--option", "a: A | x", "--option", "b: B | y", "--recommend", "a", "--reason", "r"];
    f.ok("decision", "d-deploy", "--kind", "decision", "--title", "Deploy", "--question", "q", "--why", "w", ...opt);
    f.ok("decision", "d-key", "--kind", "action", "--title", "Rotate", "--question", "q", "--why", "w", "--manual", "m");
    f.ok("decision", "d-when", "--kind", "decision", "--title", "When", "--question", "q", "--why", "w", ...opt);
    f.ok("link", "rev", "--url", "https://b.ts.net:1/", "--title", "Review", "--kind", "page");
    expect(f.rows("decisions").map((d) => d["ref"])).toEqual(["D1", "A1", "D2"]);
    expect(f.rows("links")[0]?.["ref"]).toBe("L1");
    f.ok("decision", "D2", "--decide", "a: A", "--resolution", "answered on the page");
    expect(f.rows("decisions")[2]?.["status"]).toBe("decided");
    f.ok("link", "L1", "--note", "mark each");
    expect(f.ok("show")).toContain("D1 decision d-deploy");
  });

  test("a number names the row it was given to", () => {
    f.ok("decision", "x", "--kind", "input", "--title", "T", "--question", "q", "--why", "w");
    expect(f.rows("decisions")[0]?.["ref"]).toBe("I1");
    f.ok("decision", "I1", "--title", "Renamed", "--log", "clearer");
    expect(f.rows("decisions").map((d) => [d["id"], d["title"]])).toEqual([["x", "Renamed"]]);
    f.ok("decision", "i1", "--kind", "input", "--title", "Lower", "--question", "q", "--why", "w");
    expect(f.rows("decisions").map((d) => d["id"])).toEqual(["x", "i1"]);
  });

  test("a number skips an id that reads as it (open-1)", () => {
    const opt = ["--option", "a: A | x", "--option", "b: B | y", "--recommend", "a", "--reason", "r"];
    f.ok("decision", "D2", "--kind", "input", "--title", "T", "--question", "q", "--why", "w");
    f.ok("decision", "x", "--kind", "decision", "--title", "X", "--question", "q", "--why", "w", ...opt);
    f.ok("decision", "y", "--kind", "decision", "--title", "Y", "--question", "q", "--why", "w", ...opt);
    expect(f.rows("decisions").map((d) => [d["id"], d["ref"]])).toEqual([
      ["D2", "I1"],
      ["x", "D1"],
      ["y", "D3"],
    ]);
  });

  test("a number given for a decision is kept as its id", () => {
    f.ok("decision", "key", "--kind", "input", "--title", "Key", "--question", "q", "--why", "w");
    f.ok("roadblock", "r1", "--title", "T", "--detail", "D", "--severity", "serious", "--needs", "user", "--decision", "I1");
    f.ok("link", "l1", "--url", "https://b.ts.net:1/", "--title", "Form", "--decision", "I1");
    f.ok("decision", "I1", "--decide", "given", "--resolution", "said in the session");
    f.ok("decision", "key2", "--kind", "input", "--title", "Key again", "--question", "q", "--why", "w", "--supersedes", "I1");
    expect([f.rows("roadblocks")[0]?.["decision"], f.rows("links")[0]?.["decision"], f.rows("decisions")[1]?.["supersedes"]]).toEqual([
      "key",
      "key",
      "key",
    ]);
    expect(f.rows("roadblocks")[0]?.["resolved"]).toBe(true);
  });
});

describe("done", () => {
  test("done with a report that reads unfinished is questioned", () => {
    f = new Fleet().setUp();
    f.ok("agent", "a9", "--task", "t", "--milestone", "m1");
    const said = f.run("agent", "a9", "--status", "done", "--report", "Part A refused a 3rd time; parked.");
    expect(said.code).toBe(0);
    expect(said.stderr).toContain("reads as unfinished");
    f.ok("agent", "a8", "--task", "t", "--milestone", "m1");
    expect(f.run("agent", "a8", "--status", "done", "--report", "All 12 met; did not touch the API.").stderr).not.toContain("unfinished");
  });
});

describe("origin", () => {
  test("a decision is tied to its step, milestone and worker", () => {
    f = new Fleet().setUp();
    f.ok("step", "l19", "--milestone", "m2", "--title", "Watchdog");
    f.ok("agent", "b41", "--task", "t", "--milestone", "m1");
    f.ok("decision", "d-a", "--kind", "action", "--title", "Unblock", "--question", "q", "--why", "w", "--manual", "m", "--step", "l19");
    f.ok("decision", "d-b", "--kind", "input", "--title", "Which", "--question", "q", "--why", "w", "--agent", "b41");
    const d = new Map(f.rows("decisions").map((x) => [x["id"], x]));
    expect([d.get("d-a")?.["step"], d.get("d-a")?.["milestone"]]).toEqual(["l19", "m2"]);
    expect([d.get("d-b")?.["step"], d.get("d-b")?.["milestone"]]).toEqual([null, "m1"]);
    expect(f.refused("decision", "d-a", "--step", "l99")).toContain("unknown step");
    f.ok("grill", "g1", "--title", "T", "--ask", "a | b | c | d", "--step", "l19");
    expect(f.rows("decisions").at(-1)?.["step"]).toBe("l19");
  });
});

describe("now names", () => {
  test("a now line naming a closed decision is questioned", () => {
    f = new Fleet().setUp();
    f.ok("decision", "d-key", "--kind", "input", "--title", "Neon key", "--question", "q", "--why", "w");
    f.ok("decision", "I1", "--decide", "given", "--resolution", "answered on the page (#83)");
    expect(f.run("set", "--now", "Waits on Luiz: I1, the Neon key").stderr).toContain("names I1 (Neon key) is decided");
    expect(f.run("set", "--now", "Latency test running").stderr).not.toContain("names");
  });
});

describe("clock", () => {
  test("FLEET_NOW stops the clock for stamps and ages", () => {
    f = new Fleet().setUp();
    const env = { ...f.env, FLEET_NOW: "2026-01-02T09:00:00+00:00", TZ: "UTC" };
    const run = (...args: string[]): Ran => spawnFleet(["state", f.root, ...args, "--no-render"], env);
    expect(run("set", "--now", "x").code).toBe(0);
    const state = f.state();
    expect([state["now_at"], state["updated"]]).toEqual(["2026-01-02T09:00:00+00:00", "2026-01-02T09:00:00+00:00"]);
    env.FLEET_NOW = "2026-01-02T09:45:00+00:00";
    expect(run("event", "y").stderr).toContain("the page's Now line (said 45 min ago)");
  });
});

describe("manager", () => {
  let m: Fleet;

  beforeEach(() => {
    m = new Fleet(join(tmp(), "manager"));
  });

  test("a manager's ledger says so and holds what every fleet follows", () => {
    const result = m.run("init", "--role", "manager", "--project", "this machine", "--goal", "land the billing work in order");
    expect(result.code, result.stderr).toBe(0);
    expect(m.state()["role"]).toBe("manager");
    const standing = readFileSync(join(m.root, "standing.md"), "utf8");

    for (const heading of ["## What the user decided", "## Who owns what", "## Landings and deploys"]) expect(standing).toContain(heading);
    writeFileSync(join(m.root, "standing.md"), `${standing}\nNever export the infra token in a deploy shell.\n`);
    expect(m.run("set", "--now", "x").code).toBe(0);
    expect(readFileSync(join(m.root, "standing.md"), "utf8")).toContain("Never export the infra token");
    expect(m.run("show").stdout).toContain("this machine [running, manager]");
  });

  test("a manager's step names the coordinator whose turn it is", () => {
    m.run("init", "--role", "manager", "--project", "this machine", "--goal", "g");
    m.run("milestone", "landings", "--title", "Landings and deploys");
    const step = m.run("step", "l1", "--milestone", "landings", "--title", "infra: push master", "--agent", "infra", "--status", "current");
    expect(step.code, step.stderr).toBe(0);
    const render = fleet(["state", m.root, "set", "--now", "infra has the turn"], m.env);
    expect(render.code, render.stderr).toBe(0);
    expect(existsSync(join(m.root, "index.html"))).toBe(true);
  });

  test("a manager's events and decisions name a fleet", () => {
    m.run("init", "--role", "manager", "--project", "this machine", "--goal", "g");

    for (const args of [
      ["event", "--kind", "integrated", "--agent", "billing", "l2 landed as 1d5b1b1a"],
      ["decision", "d1", "--kind", "action", "--title", "Deploy billing", "--question", "q", "--why", "w", "--manual", "just deploy billing", "--agent", "billing"],
    ]) {
      const result = m.run(...args);
      expect(result.code, result.stderr).toBe(0);
    }
  });

  test("a coordinator's step names one of its workers", () => {
    m.run("init", "--project", "p", "--goal", "g");
    m.run("milestone", "m1", "--title", "M");
    const refused = m.run("step", "s1", "--milestone", "m1", "--title", "T", "--agent", "nobody");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("unknown agent 'nobody'");
  });

  test("a coordinator's ledger has no standing file", () => {
    m.run("init", "--project", "p", "--goal", "g");
    expect(existsSync(join(m.root, "standing.md"))).toBe(false);
  });
});

describe("brief", () => {
  beforeEach(() => {
    f = new Fleet().setUp();
  });

  test("the shared brief is written once with this fleet's paths", () => {
    const brief = readFileSync(join(f.root, "brief.md"), "utf8");
    expect(brief).toContain(`${join(SKILL, "..", "..", "..", "fleet", "bin", "fleet")} chat ${f.root} inbox`);
    expect(brief).not.toContain("python3");
    expect(brief).toContain(f.root);
    expect(brief).not.toContain("{");

    for (const heading of ["## Standards", "## Lane", "## Chat", "## Report", "## This fleet"]) expect(brief).toContain(heading);
  });

  test("what the coordinator added is kept", () => {
    const path = join(f.root, "brief.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nThe dev server on :8787 stays up.\n`);
    f.ok("set", "--now", "later");
    expect(readFileSync(path, "utf8")).toContain("The dev server on :8787 stays up.");
  });

  test("a fleet from before the brief gets one", () => {
    unlinkSync(join(f.root, "brief.md"));
    f.ok("set", "--now", "later");
    expect(existsSync(join(f.root, "brief.md"))).toBe(true);
  });
});
