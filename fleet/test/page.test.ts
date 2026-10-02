/**
 * What the page is sent (ported from the coordinator's tests/test_fleets.py view tests, test_spend.py,
 * test_usage.py and test_served.py): the view of a coordinator's and a manager's ledger, what a
 * session spent read from its transcript, the plan's usage captured from the status line, and the
 * served ports no link names. The page's bytes themselves are pinned by the oracle's render traces.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { mentionedBy } from "../src/hub/served.ts";
import { asArray, asObject, type Json, type JsonObject } from "../src/json.ts";
import { cliLookups } from "../src/page/lookups.ts";
import { unlisted, view, type Found } from "../src/page/view.ts";
import { readObject, type Entry } from "../src/registry.ts";
import { SpendReader } from "../src/transcripts.ts";
import { readUsage } from "../src/usage.ts";
import { baseEnv, machine, spawnFleet, tmp, type Environment, type Ran } from "./support.ts";

const SESSION = "a61ed1b3-9b9b-409a-86d5-6176dc4d0cfc";

const SLUG = "-home-luiz-repos-billing";

let base: string;

let env: Environment;

beforeEach(() => {
  base = tmp("fleet-page-");
  env = baseEnv(join(base, "registry"), { CLAUDE_CONFIG_DIR: join(base, "config") });
});

function makeFleet(name: string, project: string, more: JsonObject = {}): string {
  const root = join(base, name, "coordinator");
  mkdirSync(root, { recursive: true });
  const body = { project, goal: `g of ${project}`, status: "running", now: `now of ${project}`, started: "x", roadmap: [], agents: [], roadblocks: [], decisions: [], events: [], ...more };
  writeFileSync(join(root, "state.json"), JSON.stringify(body));

  return root;
}

function register(root: string, url: string): Entry {
  return machine(env).registry.register(root, url, process.pid, "2026-09-28T10:00:00+00:00");
}

function viewOf(state: JsonObject, root: string): JsonObject {
  return view(machine(env), cliLookups(), state, root);
}

describe("the view", () => {
  test("a coordinator's view names its manager, and the view is a copy", () => {
    const a = makeFleet("a", "billing");
    register(a, "u");
    const state: JsonObject = { project: "billing", agents: [] };
    expect(viewOf(state, a)["manager"]).toBeUndefined();
    const m = makeFleet("m", "everything", { role: "manager" });
    register(m, "https://box.ts.net:9/");
    expect(viewOf(state, a)["manager"]).toEqual({ id: "manager", url: "https://box.ts.net:9/", session: null });
    expect(viewOf(state, a)["fleets"]).toEqual(["billing"]);
    expect(state["manager"]).toBeUndefined();
  });

  test("the manager's view holds every coordinator with what waits in it", () => {
    const decisions = [
      { id: "d1", kind: "decision", title: "Schema", question: "q", status: "open", blocking: true, opened: "2026-09-28T10:30:00+00:00" },
      { id: "d2", kind: "input", title: "Rate", question: "q", status: "open", asks: "manager", opened: "2026-09-28T10:40:00+00:00" },
      { id: "d3", kind: "input", title: "Old", question: "q", status: "decided", opened: "x" },
    ];

    const agents = [
      { id: "a1", name: "x", task: "t", status: "running", lane: ["src/billing/**"], milestone: "m1", tokens: 100 },
      { id: "a2", name: "y", task: "t", status: "done", lane: [], milestone: "m1", tokens: 50 },
    ];

    const roadblocks = [{ id: "r1", title: "T", severity: "serious", needs: "user", since: "x", resolved: false }];
    const a = makeFleet("a", "billing", { decisions, agents, roadblocks });
    register(a, "https://box.ts.net:1/");
    machine(env).registry.name(a, "billing-coordinator");
    const m = makeFleet("m", "everything", { role: "manager" });
    register(m, "https://box.ts.net:9/");
    const shown = viewOf({ project: "everything", role: "manager" }, m);
    const coordinators = asArray(shown["coordinators"]) ?? [];
    expect(coordinators.length).toBe(1);
    const c = asObject(coordinators[0]) ?? {};
    expect([c["id"], c["name"], c["goal"], c["status"], c["now"], c["url"], c["session"]]).toEqual([
      "billing-coordinator",
      "billing-coordinator",
      "g of billing",
      "running",
      "now of billing",
      "https://box.ts.net:1/",
      "billing-coordinator",
    ]);
    expect([c["workers"], c["tokens"], c["roadblocks"], c["lanes"]]).toEqual([{ running: 1, done: 1 }, 150, 1, ["src/billing/**"]]);
    expect((asArray(c["decisions"]) ?? []).map((d) => [asObject(d)?.["id"], asObject(d)?.["ref"], asObject(d)?.["asks"], asObject(d)?.["blocking"]])).toEqual([
      ["d1", "D1", "user", true],
      ["d2", "I1", "manager", false],
    ]);
    const index = (asArray(c["index"]) ?? []).map((r) => [asObject(r)?.["group"], asObject(r)?.["ref"], asObject(r)?.["hash"]]);
    expect(index).toContainEqual(["decisions", "I2", "#decision/d3"]);
    expect(index).toContainEqual(["roadblocks", "R1", "#roadblocks"]);
    expect(index).toContainEqual(["workers", "a1", "#agent-a1"]);
  });

  test("the manager's view of a fleet's open item carries the fleet's chat about it, and of a grilling its open questions", () => {
    const at = "2026-10-02T13:57:11-05:00";
    const q = (id: string, status: string): JsonObject => ({ id, title: "T", body: "B", recommend: "R", reason: "W", of: null, status, answer: status === "answered" ? "yes" : null, asked: at });
    const grill = (id: string, questions: JsonObject[]): JsonObject => ({ id, kind: "grill", title: id, question: "q", status: "open", opened: at, questions });

    const decisions = [
      grill("G3", [q("q1", "answered"), q("q2", "answered"), q("q3", "answered")]),
      grill("G4", [q("q1", "open"), q("q2", "open")]),
      grill("G5", [q("q1", "open")]),
      grill("G6", [q("q1", "open"), { ...q("q2", "open"), of: "q1" }]),
      { id: "d1", kind: "decision", title: "Schema", question: "q", status: "open", opened: at },
    ];

    const a = makeFleet("a", "ui", { decisions });
    const line = (m: JsonObject): string => `${JSON.stringify({ to: ["coordinator"], re: null, ...m })}\n`;
    writeFileSync(
      join(a, "chat.jsonl"),
      line({ id: 1, at: "2026-10-02T13:58:00-05:00", from: "user", text: "Q1: Yes, merge", decision: "G5", author: "luiz" }) +
        line({ id: 2, at: "2026-10-02T13:59:00-05:00", from: "user", text: "Q1: Yes", decision: "G6" }) +
        line({ id: 3, at: "2026-10-02T14:00:00-05:00", from: "coordinator", to: ["user"], text: "which merge?", re: 2 }) +
        line({ id: 4, at: "2026-10-02T14:01:00-05:00", from: "user", text: "a", decision: "d1" }) +
        line({ id: 5, at: "2026-10-02T14:02:00-05:00", from: "coordinator", to: ["user"], text: "noted", re: 4 }),
    );
    register(a, "u1");
    const m = makeFleet("m", "everything", { role: "manager" });
    register(m, "u9");
    const c = asObject(asArray(viewOf({ project: "m", role: "manager" }, m)["coordinators"])?.[0]) ?? {};
    const row = (id: string): JsonObject => asObject((asArray(c["decisions"]) ?? []).find((d) => asObject(d)?.["id"] === id)) ?? {};
    const open = (id: string, of: string | null = null): JsonObject => ({ id, of, status: "open", asked: at });
    const message = (id: number, when: string, from: string, text: string, re: number | null, decision: string | null): JsonObject => ({ id, at: when, from, to: [from === "user" ? "coordinator" : "user"], text, re, decision });

    expect([row("G3")["questions"], row("G3")["said"]]).toEqual([[], []]);
    expect([row("G4")["questions"], row("G4")["said"]]).toEqual([[open("q1"), open("q2")], []]);
    expect([row("G5")["questions"], row("G5")["said"]]).toEqual([[open("q1")], [message(1, "2026-10-02T13:58:00-05:00", "user", "Q1: Yes, merge", null, "G5")]]);
    expect(row("G6")["said"]).toEqual([message(2, "2026-10-02T13:59:00-05:00", "user", "Q1: Yes", null, "G6"), message(3, "2026-10-02T14:00:00-05:00", "coordinator", "which merge?", 2, null)]);
    expect(row("G6")["questions"]).toEqual([open("q1"), open("q2", "q1")]);
    expect(row("d1")["said"]).toEqual([message(4, "2026-10-02T14:01:00-05:00", "user", "a", null, "d1"), message(5, "2026-10-02T14:02:00-05:00", "coordinator", "noted", 4, null)]);
    expect(Object.keys(row("d1"))).not.toContain("questions");
  });

  test("a fleet whose state cannot be read is shown as such", () => {
    const a = makeFleet("a", "billing");
    register(a, "u");
    writeFileSync(join(a, "state.json"), "{half");
    const m = makeFleet("m", "everything", { role: "manager" });
    register(m, "u9");
    const c = asObject(asArray(viewOf({ project: "m", role: "manager" }, m)["coordinators"])?.[0]) ?? {};
    expect([c["id"], c["status"], c["decisions"]]).toEqual(["billing", "unknown", []]);
  });

  test("a link is shown up while something answers where it points", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });

    try {
      const a = makeFleet("a", "billing");

      const links = [
        { id: "l1", url: `http://localhost:${server.port}/`, title: "up", kind: "dev" },
        { id: "l2", url: "http://127.0.0.1:9/", title: "down", kind: "dev" },
      ];

      const shown = await new Promise<JsonObject>((resolve) => setTimeout(() => resolve(viewOf({ project: "p", links }, a)), 0));
      expect((asArray(shown["links"]) ?? []).map((l) => [asObject(l)?.["id"], asObject(l)?.["up"], asObject(l)?.["fleet"]])).toEqual([
        ["l1", true, null],
        ["l2", false, null],
      ]);
    } finally {
      void server.stop(true);
    }
  });

  test("unlisted leaves out what a link names", () => {
    const found = [{ port: 1, url: "https://b.ts.net:1/" }, { port: 2, url: "https://b.ts.net:2/" }].map(
      (x): Found => ({ ...x, target: "", pid: null, cwd: "", command: "", fleet: null, up: false }),
    );

    expect(unlisted(found, [{ url: "https://b.ts.net:2/x" }]).map((x) => x.port)).toEqual([1]);
  });
});

function said(id: string, out: number, figures: { read?: number; write?: number; fresh?: number; side?: boolean } = {}): string {
  return `${JSON.stringify({
    type: "assistant",
    isSidechain: figures.side ?? false,
    message: {
      id,
      model: "claude-opus",
      usage: { input_tokens: figures.fresh ?? 0, output_tokens: out, cache_read_input_tokens: figures.read ?? 0, cache_creation_input_tokens: figures.write ?? 0 },
    },
  })}\n`;
}

describe("what a session spent", () => {
  let root: string;
  let transcript: string;
  let reader: SpendReader;

  const of = (): JsonObject | undefined => {
    const spent = reader.of(root, join(base, "config"), 0);

    return spent === undefined ? undefined : { ...spent };
  };

  beforeEach(() => {
    root = join(base, "claude-1000", SLUG, SESSION, "scratchpad", "coordinator");
    mkdirSync(root, { recursive: true });
    transcript = join(base, "config", "projects", SLUG, `${SESSION}.jsonl`);
    mkdirSync(join(base, "config", "projects", SLUG), { recursive: true });
    reader = new SpendReader();
  });

  test("what its answers used", () => {
    writeFileSync(transcript, said("m1", 100, { read: 5000, write: 300, fresh: 2 }) + said("m2", 50, { read: 6000 }));
    expect(of()).toEqual({ output: 150, input: 11302, cached: 11000, answers: 2 });
  });

  test("an answer written over several lines counts once, with its last figures", () => {
    writeFileSync(transcript, said("m1", 10, { read: 5000 }) + said("m1", 80, { read: 5000 }) + said("m2", 5, { read: 100 }));
    expect(of()).toEqual({ output: 85, input: 5100, cached: 5100, answers: 2 });
  });

  test("only the session's own answers count", () => {
    writeFileSync(
      transcript,
      said("m1", 100) +
        said("w1", 900, { side: true }) +
        `${JSON.stringify({ type: "user", message: { content: 'the word "usage" in a prompt' } })}\n` +
        `${JSON.stringify({ type: "assistant", message: { id: "m3" } })}\nnot json\n`,
    );
    expect(of()).toEqual({ output: 100, input: 0, cached: 0, answers: 1 });
  });

  test("what is appended is added, and a line still being written waits", () => {
    writeFileSync(transcript, said("m1", 100));
    expect(of()?.["output"]).toBe(100);
    appendFileSync(transcript, said("m2", 40) + said("m3", 7).trimEnd().slice(0, 30));
    expect(of()?.["output"]).toBe(140);
    writeFileSync(transcript, said("m1", 100) + said("m2", 40) + said("m3", 7));
    expect([of()?.["output"], of()?.["answers"]]).toEqual([147, 3]);
  });

  test("a transcript that was replaced is read again from its start", () => {
    writeFileSync(transcript, said("m1", 100) + said("m2", 40));
    expect(of()?.["output"]).toBe(140);
    rmSync(transcript);
    writeFileSync(transcript, said("n1", 9));
    expect(of()).toEqual({ output: 9, input: 0, cached: 0, answers: 1 });
  });

  test("a directory that is no session's scratchpad has none", () => {
    expect(reader.of(join(base, "anywhere", "coordinator"), join(base, "config"), 0)).toBeUndefined();
    expect(of()).toBeUndefined();
  });

  test("between looks the file is left alone", () => {
    writeFileSync(transcript, said("m1", 100));
    expect(reader.of(root, join(base, "config"), 60)?.output).toBe(100);
    appendFileSync(transcript, said("m2", 40));
    expect(reader.of(root, join(base, "config"), 60)?.output).toBe(100);
    expect(reader.of(root, join(base, "config"), 0)?.output).toBe(140);
  });

  test("a fleet's page is sent what its coordinator spent, and the manager's what each did", () => {
    writeFileSync(transcript, said("m1", 100, { read: 5000 }));
    const state = { project: "billing", goal: "g", status: "running", now: "n", agents: [] };
    writeFileSync(join(root, "state.json"), JSON.stringify(state));
    expect(asObject(viewOf(state, root)["spent"])?.["output"]).toBe(100);
    register(root, "https://box:1/");
    const manager = join(base, "manager");
    mkdirSync(manager);
    const shown = viewOf({ project: "m", role: "manager" }, manager);
    expect(asObject(asArray(shown["coordinators"])?.[0])?.["spent"]).toEqual({ output: 100, input: 5000, cached: 5000, answers: 1 });
    expect(shown["spent"]).toBeNull();
  });

  test("the CLI says it", () => {
    writeFileSync(transcript, said("m1", 1000, { read: 5000, fresh: 1000 }));
    expect(spawnFleet(["spend", root], env).stdout).toBe("1,000 tokens written and 6,000 read (83% from the cache) in 1 answers\n");
  });
});

describe("the plan's usage", () => {
  const SOON = Math.trunc(Date.now() / 1000) + 3600;
  const LATER = Math.trunc(Date.now() / 1000) + 5 * 86400;
  const home = (): string => join(base, "registry");

  function status(five?: JsonObject, seven?: JsonObject, rest: JsonObject = {}): string {
    const limits = new Map<string, Json>();

    if (five !== undefined) limits.set("five_hour", five);

    if (seven !== undefined) limits.set("seven_day", seven);

    const line = new Map<string, Json>([
      ["session_id", "s"],
      ["model", { display_name: "Opus" }],
    ]);

    if (limits.size > 0) line.set("rate_limits", Object.fromEntries(limits));

    return JSON.stringify({ ...Object.fromEntries(line), ...rest });
  }

  function captureAs(config: string, stdin: string, ...command: string[]): Ran {
    const done = Bun.spawnSync([join(import.meta.dir, "..", "bin", "fleet"), "usage", "capture", "--", ...command], {
      env: { ...env, CLAUDE_CONFIG_DIR: config },
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });

    return { code: done.exitCode ?? -1, stdout: done.stdout.toString(), stderr: done.stderr.toString() };
  }

  function capture(stdin: string, ...command: string[]): Ran {
    return captureAs(join(base, "config"), stdin, ...command);
  }

  /** A config directory whose `.claude.json` says who is logged in, as Claude Code writes it. */
  function login(name: string, email: string): string {
    const config = join(base, name);
    mkdirSync(config, { recursive: true });
    const account = { accountUuid: `uuid-${name}`, emailAddress: email, organizationUuid: `org-${name}`, organizationName: `${email}'s Organization` };
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ numStartups: 3, oauthAccount: account, projects: {} }));

    return config;
  }

  const readingFile = (): string => join(home(), "usage", "reading.json");

  /** The page's reading and then each other account's: what `window` is at in each. */
  const percents = (held: JsonObject | undefined, window: string): Json[] =>
    [held, ...(asArray(held?.["others"]) ?? [])].map((r) => asObject(asObject(r)?.[window])?.["used_percentage"] ?? null);

  /** The page's reading and then each other account's: who each is. */
  const accounts = (held: JsonObject | undefined): Json[] =>
    [held, ...(asArray(held?.["others"]) ?? [])].map((r) => {
      const name = asObject(r)?.["account"];

      return name === undefined ? "absent" : name;
    });

  const used = (window: string): Json | undefined => asObject(readUsage(home())?.[window])?.["used_percentage"];

  test("the status line runs as before, on the same input", () => {
    const got = capture(status({ used_percentage: 42.5, resets_at: SOON }), "sh", "-c", "printf 'line for %s\\n' \"$(cat | grep -o Opus)\"");
    expect([got.code, got.stdout]).toEqual([0, "line for Opus\n"]);
  });

  test("what it saw is kept for the page", () => {
    capture(status({ used_percentage: 42.5, resets_at: SOON }, { used_percentage: 61, resets_at: LATER }), "true");
    const held = readUsage(home()) ?? {};
    expect([asObject(held["five_hour"])?.["used_percentage"], asObject(held["five_hour"])?.["resets_at"], asObject(held["seven_day"])?.["used_percentage"]]).toEqual([42.5, SOON, 61]);
  });

  test("the status line's own failure and output pass through", () => {
    const got = capture(status(), "sh", "-c", "printf boom >&2; exit 3");
    expect([got.code, got.stderr]).toEqual([3, "boom"]);
  });

  test("input that is not JSON, or has no limits, changes nothing and breaks nothing", () => {
    capture(status({ used_percentage: 10, resets_at: SOON }), "true");

    for (const given of ["", "not json", "[]", status(), JSON.stringify({ rate_limits: "soon" }), JSON.stringify({ rate_limits: { five_hour: { used_percentage: "many" } } })]) {
      expect(capture(given, "echo", "ok")).toEqual({ code: 0, stdout: "ok\n", stderr: "" });
    }

    expect(used("five_hour")).toBe(10);
  });

  test("an idle session's older figure does not replace a newer one; a new window does", () => {
    capture(status({ used_percentage: 50, resets_at: SOON }), "true");
    capture(status({ used_percentage: 35, resets_at: SOON }), "true");
    expect(used("five_hour")).toBe(50);
    capture(status({ used_percentage: 3, resets_at: SOON + 5 * 3600 }), "true");
    capture(status({ used_percentage: 95, resets_at: SOON }), "true");
    expect(used("five_hour")).toBe(3);
  });

  test("a window the input leaves out is kept", () => {
    capture(status({ used_percentage: 50, resets_at: SOON }, { used_percentage: 61, resets_at: LATER }), "true");
    capture(status({ used_percentage: 52, resets_at: SOON }), "true");
    expect([used("five_hour"), used("seven_day")]).toEqual([52, 61]);
  });

  test("nothing captured reads as none; the manager's page is sent it and a coordinator's is not", () => {
    expect(readUsage(home())).toBeUndefined();
    mkdirSync(join(home(), "usage"), { recursive: true });
    writeFileSync(join(home(), "usage", "reading.json"), "{half");
    expect(readUsage(home())).toBeUndefined();
    capture(status({ used_percentage: 42, resets_at: SOON }), "true");
    expect(asObject(asObject(viewOf({ project: "p", role: "manager" }, home())["usage"])?.["five_hour"])?.["used_percentage"]).toBe(42);
    expect(viewOf({ project: "p" }, home())["usage"]).toBeUndefined();
  });

  test("the page shows the account that worked last, and the others below it", () => {
    const work = login("work", "work@example.com");
    const away = login("home", "home@example.com");
    captureAs(work, status({ used_percentage: 40, resets_at: SOON }, { used_percentage: 100, resets_at: LATER }), "true");
    captureAs(away, status({ used_percentage: 12, resets_at: SOON + 600 }, { used_percentage: 30, resets_at: LATER + 600 }), "true");
    const held = readUsage(home());
    expect(accounts(held)).toEqual(["home@example.com", "work@example.com"]);
    expect(percents(held, "seven_day")).toEqual([30, 100]);
    expect(percents(held, "five_hour")).toEqual([12, 40]);
    captureAs(work, status({ used_percentage: 41, resets_at: SOON }, { used_percentage: 100, resets_at: LATER }), "true");
    expect(accounts(readUsage(home()))).toEqual(["work@example.com", "home@example.com"]);
  });

  test("within one account usage only grows", () => {
    const work = login("work", "work@example.com");
    captureAs(work, status(undefined, { used_percentage: 30, resets_at: LATER }), "true");
    captureAs(work, status(undefined, { used_percentage: 20, resets_at: LATER }), "true");
    expect(percents(readUsage(home()), "seven_day")).toEqual([30]);
  });

  test("the file before accounts reads as an account not recorded, and is kept as one", () => {
    mkdirSync(join(home(), "usage"), { recursive: true });
    const flat = { five_hour: { used_percentage: 40, resets_at: SOON, at: SOON - 4000 }, seven_day: { used_percentage: 100, resets_at: LATER, at: SOON - 9000 } };
    writeFileSync(readingFile(), JSON.stringify(flat));
    const held = readUsage(home());
    expect([held?.["account"], held?.["seen"], percents(held, "five_hour"), percents(held, "seven_day"), held?.["others"]]).toEqual([null, SOON - 4000, [40], [100], []]);
    captureAs(login("home", "home@example.com"), status({ used_percentage: 5, resets_at: SOON + 600 }, { used_percentage: 30, resets_at: LATER + 600 }), "true");
    const after = readUsage(home());
    expect([accounts(after), percents(after, "seven_day")]).toEqual([["home@example.com", null], [30, 100]]);
    const kept = readObject(readingFile());
    expect(Object.keys(kept ?? {})).toEqual(["accounts"]);
    expect(Object.keys(asObject(kept?.["accounts"]) ?? {})).toEqual(["uuid-home:org-home", "unknown"]);
  });

  test("a session with no login is an account not recorded; an unreadable login keeps nothing", () => {
    capture(status({ used_percentage: 9, resets_at: SOON }), "true");
    expect([accounts(readUsage(home())), percents(readUsage(home()), "five_hour")]).toEqual([[null], [9]]);
    const broken = join(base, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".claude.json"), '{"oauthAccount": {"accountUu');
    expect(captureAs(broken, status({ used_percentage: 70, resets_at: SOON }), "echo", "ok")).toEqual({ code: 0, stdout: "ok\n", stderr: "" });
    expect(percents(readUsage(home()), "five_hour")).toEqual([9]);
  });

  test("another account whose windows have all reset is dropped", () => {
    mkdirSync(join(home(), "usage"), { recursive: true });
    const past = Math.trunc(Date.now() / 1000) - 60;
    writeFileSync(readingFile(), JSON.stringify({ accounts: { gone: { email: "gone@example.com", seen: past - 9000, five_hour: { used_percentage: 99, resets_at: past, at: past - 9000 } } } }));
    captureAs(login("home", "home@example.com"), status({ used_percentage: 5, resets_at: SOON }), "true");
    expect(Object.keys(asObject(readObject(readingFile())?.["accounts"]) ?? {})).toEqual(["uuid-home:org-home"]);
  });

  test("the CLI names each account", () => {
    captureAs(login("work", "work@example.com"), status(undefined, { used_percentage: 100, resets_at: LATER }), "true");
    captureAs(login("home", "home@example.com"), status(undefined, { used_percentage: 30, resets_at: LATER }), "true");
    const out = spawnFleet(["usage", "show"], env).stdout.split("\n");
    expect([out[0], out[1]?.slice(0, 26), out[2], out[3]?.slice(0, 27)]).toEqual([
      "home@example.com, the session that worked last:",
      "  7-day window: 30% used, ",
      "work@example.com:",
      "  7-day window: 100% used, ",
    ]);
  });

  test("the CLI prints what it holds", () => {
    expect(spawnFleet(["usage", "show"], env).stdout).toBe("no usage captured yet: the status line has not run through `fleet usage capture`\n");
    capture(status({ used_percentage: 42.5, resets_at: SOON }, { used_percentage: 61, resets_at: LATER }), "true");
    const out = spawnFleet(["usage", "show"], env).stdout;
    expect(out).toContain("5-hour window: 42.5% used");
    expect(out).toContain("7-day window: 61% used");
  });
});

describe("served ports", () => {
  test("the first to write a port's full address started it", async () => {
    const fleetOf = (id: string, sid: string, lines: readonly (readonly [string, string])[], role = "coordinator"): Entry => {
      const path = join(base, "config", "projects", "-home-x", `${sid}.jsonl`);
      mkdirSync(join(base, "config", "projects", "-home-x"), { recursive: true });
      writeFileSync(path, lines.map(([at, text]) => `${JSON.stringify({ timestamp: at, text })}\n`).join(""));
      const dir = `/tmp/x/-home-x/${sid}/scratchpad/coordinator`;

      return { id, role, dir, url: "", session: null, since: "", aliases: [], raw: {} };
    };

    const infra = fleetOf("infra", "s1", [["2026-09-29T10:00:00Z", "serving on https://box.ts.net:5555/"]]);

    const manager = fleetOf("manager", "s2", [
      ["2026-09-29T09:00:00Z", "port 5555 is busy"],
      ["2026-09-29T11:00:00Z", "infra's review: https://box.ts.net:5555/"],
    ], "manager");

    const ui = fleetOf("ui", "s3", [["2026-09-29T12:00:00Z", "see 127.0.0.1:5555"]]);
    const config = join(base, "config");
    expect(await mentionedBy(5555, 42, [manager, ui, infra], config)).toBe("infra");
    expect(await mentionedBy(6666, 43, [manager, ui, infra], config)).toBeUndefined();
  });
});
