/**
 * The registry of the fleets on this machine (ported from the coordinator's tests/test_fleets.py): how a
 * manager finds the coordinators and they it, and the `fleets` CLI. The page's view of them
 * (`fleets.view`) is the hub's, stage 3; what it summarises is checked here through `fleets list`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readChat } from "../src/chat/store.ts";
import { parseInstant, stampOf } from "../src/clock.ts";
import { asArray, asNumber, asObject, asString, type JsonObject } from "../src/json.ts";
import { tokenCount } from "../src/cli/fleets.ts";
import { fleetsNamed } from "../src/cli/run.ts";
import { startedMsOf, startedOf } from "../src/procs.ts";
import type { Registry } from "../src/registry.ts";
import { baseEnv, fleet, FLEET, machine, now, readJson, tmp, type Environment, type Ran } from "./support.ts";

let base: string;

let env: Environment;

let registry: Registry;

function deadPid(): number {
  const done = Bun.spawnSync(["true"]);

  return done.pid;
}

function makeFleet(name: string, project: string, more: JsonObject = {}): string {
  const root = join(base, name, "coordinator");
  mkdirSync(root, { recursive: true });

  const body = {
    project,
    goal: `g of ${project}`,
    status: "running",
    now: `now of ${project}`,
    started: "2026-09-28T10:00:00+00:00",
    updated: "2026-09-28T11:00:00+00:00",
    roadmap: [],
    agents: [],
    roadblocks: [],
    decisions: [],
    events: [],
    ...more,
  };

  writeFileSync(join(root, "state.json"), JSON.stringify(body));

  return root;
}

function register(root: string, url: string, pid = process.pid): ReturnType<Registry["register"]> {
  return registry.register(root, url, pid, now());
}

function cli(...args: string[]): Ran {
  return fleet(["fleets", ...args], env);
}

beforeEach(() => {
  base = tmp();
  env = baseEnv(join(base, "registry"));
  registry = machine(env).registry;
});

describe("register", () => {
  test("a fleet is known by a name made from its project", () => {
    const root = makeFleet("a", "custom-mcp-servers/case-analysis");
    const entry = register(root, "https://box.ts.net:1/");
    expect([entry.id, entry.role, entry.url, entry.dir]).toEqual(["custom-mcp-servers-case-analysis", "coordinator", "https://box.ts.net:1/", root]);
    expect(registry.live().map((e) => e.id)).toEqual(["custom-mcp-servers-case-analysis"]);
  });

  test("two fleets of one project get names that differ", () => {
    const first = register(makeFleet("a", "billing"), "u1");
    const second = register(makeFleet("b", "billing"), "u2");
    expect([first.id, second.id]).toEqual(["billing", "billing-2"]);
  });

  test("a fleet that registers again keeps its name and its session", () => {
    const a = makeFleet("a", "billing");
    const b = makeFleet("b", "billing");
    register(a, "u1");
    register(b, "u2");
    registry.name(b, "Billing-Coordinator");
    const again = register(b, "u3");
    expect([again.id, again.session, again.url]).toEqual(["billing-coordinator", "Billing-Coordinator", "u3"]);
    expect(registry.live().length).toBe(2);
  });

  test("a fleet takes its session's name as its one name", () => {
    const a = makeFleet("a", "billing");
    const b = makeFleet("b", "infra");
    register(a, "u1");
    register(b, "u2");
    const named = registry.name(a, "Billing Coordinator");
    expect("why" in named ? named.why : named.id).toBe("billing-coordinator");
    expect(registry.live().map((e) => e.id).sort()).toEqual(["billing-coordinator", "infra"]);
    const taken = registry.name(b, "billing-coordinator");
    expect("why" in taken ? taken.why : "").toContain("already called");
    const kept = registry.name(b, "user");
    expect("why" in kept ? kept.why : "").toContain("keeps");
  });

  test("a name the chat keeps for itself is not given to a fleet", () => {
    for (const project of ["manager", "Coordinator", "user"]) {
      expect(register(makeFleet(project, project), "u").id).toBe(`${project.toLowerCase()}-fleet`);
    }
  });

  test("the manager is named manager", () => {
    const entry = register(makeFleet("m", "everything", { role: "manager" }), "u");
    expect([entry.id, entry.role]).toEqual(["manager", "manager"]);
  });

  test("a fleet whose server died is forgotten", () => {
    register(makeFleet("a", "gone"), "u", deadPid());
    register(makeFleet("b", "here"), "u");
    expect(registry.live().map((e) => e.id)).toEqual(["here"]);
    expect(readdirSync(join(base, "registry")).sort()).toEqual(["here.json", "names"]);
    expect(readdirSync(join(base, "registry", "names")).length).toBe(1);
  });

  test("unregister forgets the fleet", () => {
    const root = makeFleet("a", "billing");
    register(root, "u");
    registry.unregister(root);
    expect(registry.live()).toEqual([]);
    registry.unregister(root);
  });
});

describe("the manager", () => {
  test("the manager is found once one is live", () => {
    register(makeFleet("a", "billing"), "u");
    expect(registry.manager()).toBeUndefined();
    const m = makeFleet("m", "everything", { role: "manager" });
    register(m, "https://box.ts.net:9/");
    registry.name(m, "manager-session");
    const found = registry.manager();
    expect([found?.id, found?.url, found?.session, found?.dir]).toEqual(["manager", "https://box.ts.net:9/", "manager-session", m]);
  });

  test("list holds every coordinator with what waits in it", () => {
    const open = { id: "d1", kind: "decision", title: "Schema", question: "q", status: "open", blocking: true, opened: "2026-09-28T10:30:00+00:00" };
    const held = { id: "d2", kind: "input", title: "Rate", question: "q", status: "open", asks: "manager", opened: "2026-09-28T10:40:00+00:00" };
    const closed = { id: "d3", kind: "input", title: "Old", question: "q", status: "decided", opened: "x" };

    const a = makeFleet("a", "billing", {
      decisions: [open, held, closed],
      agents: [
        { id: "a1", name: "x", task: "t", status: "running", lane: ["src/billing/**"], milestone: "m1", tokens: 100 },
        { id: "a2", name: "y", task: "t", status: "done", lane: [], milestone: "m1", tokens: 50 },
      ],
      roadblocks: [{ id: "r1", title: "T", severity: "serious", needs: "user", since: "x", resolved: false }],
    });

    register(a, "https://box.ts.net:1/");
    registry.name(a, "billing-coordinator");
    register(makeFleet("m", "everything", { role: "manager" }), "https://box.ts.net:9/");
    const out = cli("list").stdout;
    expect(out).toContain(`billing-coordinator  (coordinator, running)\n  session  billing-coordinator\n  page     https://box.ts.net:1/\n  ledger   ${a}\n`);
    expect(out).toContain("  now      now of billing\n");
    expect(out).toContain("    a1  running  -  x  lanes: src/billing/**\n");
    expect(out).toContain("    D1  d1  decision  for the user     Schema  blocks work\n");
    expect(out).toContain("    I1  d2  input     for the manager  Rate\n");
    expect(out).not.toContain("Old");
    const shown = cli("show", "billing-coordinator").stdout;
    expect(shown).toContain("    a1 (x) running since");
    expect(shown).toContain("    roadblock r1 [needs user] T");
  });

  test("list shows a fleet's identity, then its live agents, its links and what waits, each section apart", () => {
    const lanes = ["src/billing/**", "src/invoices/**,src/ledger/**", "docs/billing.md"];

    const a = makeFleet("a", "billing", {
      roadmap: [{ id: "m1", title: "M", steps: [] }],
      agents: [
        { id: "a1", name: "writer", task: "t", model: "opus", status: "running", lane: lanes, milestone: "m1", tokens: 1_234_567 },
        { id: "b12", name: "b12", task: "Wire the invoices to the ledger and run the migration twice", model: "sonnet", status: "blocked", lane: [], milestone: "m1", tokens: 0 },
        { id: "a3", name: "finished", task: "t", model: "opus", status: "done", lane: ["src/done/**"], milestone: "m1", tokens: 9 },
        { id: "q4", name: "advisor", task: "t", model: "fable", status: "queued", lane: [], milestone: "m1" },
      ],
      links: [
        { id: "dev", url: "https://box.ts.net:5173/", title: "Billing dev server", kind: "dev", decision: null, agent: null, note: null, since: "x" },
        { id: "old", url: "https://box.ts.net:5300/", title: "Old review", kind: "page", decision: null, agent: null, note: null, since: "x" },
      ],
      decisions: [
        { id: "d1", kind: "decision", title: "Schema", question: "q", status: "open", blocking: true, opened: "2026-09-28T10:30:00+00:00" },
        { id: "d2", kind: "input", title: "Rate", question: "q", status: "open", asks: "manager", opened: "2026-09-28T10:40:00+00:00", held: "after the cost work", held_at: "2026-09-28T10:50:00+00:00" },
        { id: "d3", kind: "input", title: "Closed one", question: "q", status: "decided", opened: "x" },
      ],
    });

    const dropped = fleet(["state", a, "link", "old", "--drop", "the review is done", "--no-render"], env);
    expect(dropped.code).toBe(0);
    register(a, "https://box.ts.net:1/");
    registry.name(a, "billing-coordinator");

    expect(cli("list").stdout).toBe(
      [
        "billing-coordinator  (coordinator, running)",
        "  session  billing-coordinator",
        "  page     https://box.ts.net:1/",
        `  ledger   ${a}`,
        "  now      now of billing",
        "  chat     not read now",
        "",
        "  agents   1 running, 1 blocked, 1 queued",
        "    a1   running  opus    writer                                            lanes: src/billing/** +3",
        "    b12  blocked  sonnet  Wire the invoices to the ledger and run the mig…",
        "    q4   queued   fable   advisor",
        "  links    1",
        "    L1  preview  https://box.ts.net:5173/  Billing dev server",
        "  waiting  2",
        "    D1  d1  decision  for the user     Schema  blocks work",
        "    I1  d2  input     for the manager  Rate  held by the fleet: after the cost work",
        "",
      ].join("\n"),
    );

    const shown = cli("show", "billing-coordinator").stdout;

    for (const lane of ["src/billing/**", "src/invoices/**", "src/ledger/**", "docs/billing.md"]) expect(shown).toContain(`    lane ${lane}  a1\n`);
    expect(shown).not.toContain("src/done/**");
  });

  test("list puts one blank line between fleets and shows no empty section", () => {
    register(makeFleet("a", "billing"), "u1");
    register(makeFleet("b", "infra"), "u2");
    const out = cli("list").stdout;
    expect(out).toContain("  chat     not read now\n\ninfra  (coordinator, running)\n");
    expect(out).not.toContain("agents");
    expect(out).not.toContain("links");
    expect(out).not.toContain("waiting");
  });

  test("a fleet whose state cannot be read is shown as such", () => {
    const a = makeFleet("a", "billing");
    register(a, "u");
    writeFileSync(join(a, "state.json"), "{half");
    register(makeFleet("m", "everything", { role: "manager" }), "u9");
    expect(cli("list").stdout).toContain("billing  (coordinator, unknown)\n  session  (not named yet)\n  page     u\n");
  });
});

describe("token counts", () => {
  test("are three figures and a unit, rounded half up, moving up a unit when the figures run out", () => {
    const cases: [number, string][] = [
      [0, "0"],
      [999, "999"],
      [1000, "1.00k"],
      [12_250, "12.3k"],
      [471_173, "471k"],
      [999_950, "1.00M"],
      [3_954_399, "3.95M"],
      [246_709_089, "247M"],
      [3_055_406_540, "3.06B"],
    ];

    expect(cases.map(([n]) => tokenCount(n))).toEqual(cases.map(([, text]) => text));
  });
});

describe("the CLI", () => {
  // A call given a $TZ puts the process's zone back as it was: `bun test` runs in UTC with $TZ unset, and a deleted $TZ
  // is the machine's zone, so a later test file in the same process would print another zone's stamps.
  test("a call with its own $TZ leaves the process in the zone it had", () => {
    const zone = process.env["TZ"] ?? "UTC";
    const offset = new Date(0).getTimezoneOffset();
    expect(fleet(["fleets", "gate"], { ...env, TZ: "Asia/Kolkata" }).code).toBe(0);
    expect(process.env["TZ"]).toBe(zone);
    expect(new Date(0).getTimezoneOffset()).toBe(offset);
  });

  // A watch the test spawns prints `HH:MM` that the test computes in its own process: both must read one zone.
  test("a process spawned with the test's environment tells time in the test's zone, not the machine's", () => {
    const told = Bun.spawnSync([process.execPath, "-e", "console.log(new Date(0).getTimezoneOffset())"], { env, stdout: "pipe", stderr: "pipe" });
    expect(told.stdout.toString().trim()).toBe(String(new Date(0).getTimezoneOffset()));
  });

  test("list prints each fleet with how to reach it", () => {
    const a = makeFleet("a", "billing", { decisions: [{ id: "d1", kind: "input", title: "Rate", question: "q", status: "open", asks: "manager", opened: "x" }] });
    register(a, "https://box.ts.net:1/");
    expect(cli("name", a, "billing-coordinator").code).toBe(0);
    const out = cli("list").stdout;
    expect(out).toContain("billing-coordinator  (coordinator, running)\n  session  billing-coordinator\n");
    expect(out).toContain("  page     https://box.ts.net:1/\n");
    expect(out).toContain(`  ledger   ${a}\n`);
    expect(out).toContain("  now      now of billing\n");
    expect(out).toContain("    I1  d1  input  for the manager  Rate\n");
  });

  test("list says when there is none", () => {
    expect(cli("list").stdout).toBe("no fleet is being served on this machine\n");
  });

  test("manager prints how to reach it, or fails when there is none", () => {
    const none = cli("manager");
    expect([none.code, none.stdout]).toEqual([1, ""]);
    expect(none.stderr).toContain("no manager");
    const m = makeFleet("m", "everything", { role: "manager" });
    register(m, "https://box.ts.net:9/");
    registry.name(m, "manager-session");
    const found = cli("manager");
    expect(found.code).toBe(0);

    for (const word of ["session manager-session", "https://box.ts.net:9/", m, join(m, "standing.md")]) expect(found.stdout).toContain(word);
  });

  test("decision prints what a fleet asks in full", () => {
    const a = makeFleet("a", "billing", {
      decisions: [
        {
          id: "d7",
          kind: "decision",
          title: "Order of the two migrations",
          status: "open",
          asks: "manager",
          blocking: true,
          question: "Does the invoice migration run before or after the index rebuild?",
          why: "the fleet assumes after",
          options: [
            { id: "A", label: "After", consequence: "one lock window" },
            { id: "B", label: "Before", consequence: "two windows" },
          ],
          recommend: "A",
          reason: "one window is what the user asked for",
          body: true,
          agent: "a1",
          opened: "2026-09-28T10:00:00+00:00",
          ref: "D4",
        },
      ],
    });

    register(a, "https://box.ts.net:1/");
    const out = cli("decision", "billing", "d7").stdout;

    for (const line of [
      "billing d7 [decision, for the manager, blocks work] Order of the two migrations",
      "question: Does the invoice migration run before or after the index rebuild?",
      "why: the fleet assumes after",
      "A: After | one lock window",
      "B: Before | two windows",
      "recommended: A, one window is what the user asked for",
      `evidence: ${join(a, "decisions", "d7.html")}`,
      "page: https://box.ts.net:1/#decision/billing/d4-order-of-the-two-migrations",
    ]) {
      expect(out).toContain(line);
    }

    expect(cli("decision", "billing", "D4").stdout).toContain("page: https://box.ts.net:1/#decision/billing/d4-order-of-the-two-migrations");

    for (const [args, word] of [
      [["decision", "billing", "d9"], "no decision 'd9'"],
      [["decision", "nobody", "d7"], "no fleet 'nobody'"],
    ] as const) {
      const result = cli(...args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(word);
    }
  });

  test("waiting is what the ledgers say waits on the user", () => {
    expect(cli("waiting").stdout).toBe("no fleet is being served on this machine\n");
    const at = "2026-09-28T10:00:00+00:00";

    const infra = makeFleet("i", "infra", {
      decisions: [
        { id: "rerun", kind: "action", title: "Re-run CA1014", question: "q", status: "open", opened: at },
        { id: "upload", kind: "action", title: "Small test upload", question: "q", status: "open", asks: "manager", opened: at },
        { id: "key", kind: "secret", title: "Neon key", question: "q", status: "open", blocking: true, opened: at, revised: "2026-09-28T10:20:00+00:00" },
        { id: "later", kind: "decision", title: "Held", question: "q", status: "open", opened: at, held: "after the cost work", held_at: "2026-09-28T10:50:00+00:00" },
        { id: "old", kind: "input", title: "Old", question: "q", status: "decided", opened: at },
      ],
    });

    register(infra, "u1");
    register(makeFleet("m", "everything", { role: "manager" }), "u9");
    expect(cli("waiting").stdout).toBe("infra A1 [action] Re-run CA1014  since 2026-09-28 10:00\ninfra S1 [secret, blocks work] Neon key  since 2026-09-28 10:20\n");

    writeFileSync(
      join(infra, "chat.jsonl"),
      `${JSON.stringify({ id: 1, at: "2026-09-28T10:30:00+00:00", from: "user", to: ["coordinator"], text: "Re-run after the cost improvements work is done", re: null, decision: "rerun" })}\n`,
    );

    expect(cli("waiting").stdout).toContain(
      "infra A1 [action] Re-run CA1014  since 2026-09-28 10:00  ANSWERED at 10:30 (#1): Re-run after the cost improvements work is done; not recorded yet\n",
    );

    const state = readJson(join(infra, "state.json"));
    const rows = (asArray(state["decisions"]) ?? []).map((d) => ({ ...asObject(d), status: "decided" }));
    writeFileSync(join(infra, "state.json"), JSON.stringify({ ...state, decisions: rows }));
    expect(cli("waiting").stdout).toBe("nothing waits on the user\n");
  });

  test("name needs a served fleet", () => {
    const result = cli("name", makeFleet("a", "billing"), "x");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("serve");
  });

  test("anything else prints the usage and fails", () => {
    const result = cli("frob");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage: fleet fleets list");
  });
});

describe("session titles", () => {
  let config: string;
  let scratch: string;

  beforeEach(() => {
    config = tmp("claude-");
    scratch = tmp("tmp-");
    env = baseEnv(tmp("fleet-home-"), { CLAUDE_CONFIG_DIR: config });
    registry = machine(env).registry;
  });

  function title(project: string, sid: string, text: string): void {
    const d = join(config, "projects", project, sid);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "custom-title.json"), JSON.stringify({ customTitle: text }));
  }

  function session(project: string, sid: string, text?: string): string {
    const root = join(scratch, project, sid, "scratchpad", "coordinator");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "state.json"),
      JSON.stringify({ project: "case analysis", goal: "g", status: "running", now: "n", started: "x", roadmap: [], agents: [], roadblocks: [], events: [] }),
    );

    if (text !== undefined) title(project, sid, text);

    return root;
  }

  test("the title names the fleet and a rename follows", () => {
    const root = session("-home-x-repo", "s1", "infra-coordinator");
    expect(register(root, "u").id).toBe("infra-coordinator");
    title("-home-x-repo", "s1", "Infra Lead");
    expect(registry.live().map((e) => [e.id, e.session])).toEqual([["infra-lead", "Infra Lead"]]);
    expect(readdirSync(env["FLEET_HOME"] ?? "").filter((n) => n.endsWith(".json")).length).toBe(1);
    expect(register(root, "u2").id).toBe("infra-lead");
  });

  test("without a title the project names it", () => {
    expect(register(session("-home-x-repo", "s2"), "u").id).toBe("case-analysis");
  });
});

describe("the gate", () => {
  beforeEach(() => {
    for (const name of ["infra", "ui"]) {
      const root = join(base, name, "coordinator");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "state.json"), JSON.stringify({ project: name }));
      register(root, "u");
    }
  });

  test("one fleet holds the gate at a time", () => {
    expect(cli("gate").stdout).toBe("free\n");
    expect(cli("gate", "take", "infra", "live Neo4j suite").code).toBe(0);
    const refused = cli("gate", "take", "ui", "browser tests");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("held by infra");
    expect(registry.live().length).toBe(2);
    expect(cli("gate", "free", "ui").code).toBe(1);
    expect(cli("gate", "free", "infra").code).toBe(0);
    expect(cli("gate", "take", "ui", "browser tests").code).toBe(0);
  });

  /** `fleet fleets ARGS` at the instant `at`. */
  function cliAt(at: string, ...args: string[]): Ran {
    return fleet(["fleets", ...args], { ...env, FLEET_NOW: at, TZ: "UTC" });
  }

  /** The token a take printed. */
  function tokenOf(took: Ran): string {
    return /fleet fleets gate free (\S+)`/.exec(took.stdout)?.[1] ?? "";
  }

  test("a take while the slot is held refuses, by the fleet that holds it too", () => {
    expect(cliAt("2026-10-05T12:00:00+00:00", "gate", "take", "infra", "worker A: just test").code).toBe(0);
    const again = cliAt("2026-10-05T12:01:00+00:00", "gate", "take", "infra", "worker B: just test");
    expect(again.code).toBe(1);
    expect(again.stderr).toBe(
      "fleets: held by infra since 2026-10-05T12:00:00+00:00, until 2026-10-05T13:00:00+00:00: worker A: just test; take it when `fleet fleets gate` says free\n",
    );
    expect(cliAt("2026-10-05T12:01:00+00:00", "gate").stdout).toBe("held by infra since 2026-10-05T12:00:00+00:00, until 2026-10-05T13:00:00+00:00: worker A: just test\n");
  });

  test("a take prints the token that frees it, and a release frees only the hold it names", () => {
    const first = cliAt("2026-10-05T12:00:00+00:00", "gate", "take", "infra", "worker A: just test");
    expect(first.stdout).toMatch(/^infra holds the gate: worker A: just test\ntoken [0-9a-f]{8}, until 2026-10-05T13:00:00\+00:00: free it with `fleet fleets gate free [0-9a-f]{8}`\n$/);
    const a = tokenOf(first);
    expect(cliAt("2026-10-05T12:05:00+00:00", "gate", "free", a).stdout).toBe("free\n");
    const b = tokenOf(cliAt("2026-10-05T12:06:00+00:00", "gate", "take", "infra", "worker B: just test"));
    expect(b).not.toBe(a);
    const late = cliAt("2026-10-05T12:07:00+00:00", "gate", "free", a);
    expect(late.code).toBe(1);
    expect(late.stderr).toBe(`fleets: held by infra, not ${a}\n`);
    expect(cliAt("2026-10-05T12:07:00+00:00", "gate").stdout).toContain("worker B: just test");
    expect(cliAt("2026-10-05T12:08:00+00:00", "gate", "free", b).code).toBe(0);
  });

  test("a session that serves no fleet takes the slot under its own name", () => {
    const took = cliAt("2026-10-05T12:00:00+00:00", "gate", "take", "--as", "gate-slot-worker", "just test-changed");
    expect(took.code).toBe(0);
    expect(took.stdout.split("\n")[0]).toBe("gate-slot-worker holds the gate: just test-changed");
    expect(cliAt("2026-10-05T12:01:00+00:00", "gate").stdout).toBe(
      "held by gate-slot-worker (no fleet) since 2026-10-05T12:00:00+00:00, until 2026-10-05T13:00:00+00:00: just test-changed\n",
    );
    expect(cliAt("2026-10-05T12:01:00+00:00", "gate", "take", "ui", "browser tests").stderr).toContain("held by gate-slot-worker (no fleet)");
    expect(cliAt("2026-10-05T12:02:00+00:00", "gate", "free", tokenOf(took)).stdout).toBe("free\n");
  });

  test("a hold lapses at its until, so a dead holder does not lock the slot", () => {
    expect(cliAt("2026-10-05T12:00:00+00:00", "gate", "take", "--as", "w1", "suite", "--for", "10").code).toBe(0);
    expect(cliAt("2026-10-05T12:09:59+00:00", "gate").stdout).toContain("held by w1");
    expect(cliAt("2026-10-05T12:10:00+00:00", "gate").stdout).toBe("free\n");
    expect(cliAt("2026-10-05T12:10:00+00:00", "gate", "take", "ui", "browser tests").code).toBe(0);
  });

  test("the old release by the holder's name still frees its hold", () => {
    expect(cli("gate", "take", "infra", "suite").code).toBe(0);
    expect(cli("gate", "free", "infra").stdout).toBe("free\n");
  });

  // Judged by the state each round leaves (one winner, the hold it names), not by the clock: twenty CLI starts take
  // 2 s on an idle machine and past bun's default 5 s under load. The limit only catches a take that never exits.
  test("two takes at once: exactly one wins", async () => {
    for (let round = 0; round < 10; round += 1) {
      const takers = ["infra", "ui"].map((holder) =>
        Bun.spawn([FLEET, "fleets", "gate", "take", "--as", `${holder}-${round}`, "race"], { env, stdout: "pipe", stderr: "pipe" }),
      );

      const codes = await Promise.all(takers.map(async (p) => p.exited));
      expect(codes.filter((c) => c === 0).length).toBe(1);
      const winner = takers[codes.indexOf(0)];
      const said = winner === undefined ? "" : await new Response(winner.stdout).text();
      expect(said.split(" ")[0]).toBe(String(readJson(join(base, "registry", "gate", "gate.json"))["fleet"]));
      expect(cli("gate", "free", tokenOf({ code: 0, stdout: said, stderr: "" })).code).toBe(0);
    }
  }, 120_000);

  test("--wait takes the slot as soon as it is free", async () => {
    const held = tokenOf(cli("gate", "take", "infra", "suite"));
    const waiter = Bun.spawn([FLEET, "fleets", "gate", "take", "--as", "w2", "next suite", "--wait", "20"], { env, stdout: "pipe", stderr: "pipe" });
    Bun.sleepSync(1500);
    expect(cli("gate").stdout).toContain("held by infra");
    expect(cli("gate", "free", held).code).toBe(0);
    expect(await waiter.exited).toBe(0);
    expect(cli("gate").stdout).toContain("held by w2 (no fleet)");
    const timedOut = cli("gate", "take", "ui", "browser tests", "--wait", "1");
    expect(timedOut.code).toBe(1);
    expect(timedOut.stderr).toContain("held by w2 (no fleet)");
  });

  test("takes with --mem share the budget: two quarters of the RAM hold at once, and a third is refused with both", () => {
    const a = cliAt("2026-10-05T12:00:00+00:00", "gate", "take", "infra", "build A", "--mem", "25%");
    expect(a.code).toBe(0);
    expect(cliAt("2026-10-05T12:01:00+00:00", "gate", "take", "--as", "w1", "build B", "--mem", "25%", "--for", "30").code).toBe(0);

    for (const mem of [["--mem", "25%"], []]) {
      const refused = cliAt("2026-10-05T12:02:00+00:00", "gate", "take", "ui", "build C", ...mem);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(
        /^fleets: held by infra since 2026-10-05T12:00:00\+00:00, until 2026-10-05T13:00:00\+00:00, cap [\d.]+[MG]: build A; held by w1 \(no fleet\) since 2026-10-05T12:01:00\+00:00, until 2026-10-05T12:31:00\+00:00, cap [\d.]+[MG]: build B; take it when `fleet fleets gate` says free\n$/,
      );
    }

    const lines = cliAt("2026-10-05T12:02:00+00:00", "gate").stdout.split("\n");
    expect(lines[0]).toMatch(/^held by infra since \S+, until \S+, cap [\d.]+[MG]: build A$/);
    expect(lines[1]).toMatch(/^held by w1 \(no fleet\) since \S+, until \S+, cap [\d.]+[MG]: build B$/);
    // Takes by hand declare no CPUs: the CPU row beside the memory's is all free.
    expect(lines[2]).toMatch(/^budget ([\d.]+[MG]) \(50%\): \1 held, 0B free; CPUs (\d+): 0 held, \2 free$/);
    expect(lines.slice(3)).toEqual([""]);

    // An older fleet reads one hold there, by nobody it can free: held until the last hold's until.
    expect(readJson(join(base, "registry", "gate", "gate.json"))).toMatchObject({ kind: "session", since: "2026-10-05T12:00:00+00:00", until: "2026-10-05T13:00:00+00:00", v: 2 });
    expect(cliAt("2026-10-05T12:03:00+00:00", "gate", "free", "nobody").stderr).toBe("fleets: held by infra, w1, not nobody\n");
    expect(cliAt("2026-10-05T12:03:00+00:00", "gate", "free", tokenOf(a)).stdout).toBe("free\n");
    expect(cliAt("2026-10-05T12:04:00+00:00", "gate").stdout).toMatch(/^held by w1 \(no fleet\) .*\nbudget \S+ \(50%\): (\S+) held, \1 free; CPUs \d+: 0 held, .*\n$/);
    expect(cliAt("2026-10-05T12:04:00+00:00", "gate", "take", "ui", "build C", "--mem", "25%").code).toBe(0);
    expect(cliAt("2026-10-05T12:31:00+00:00", "gate").stdout).toMatch(/^held by ui since /);
  });

  test("a --mem over the budget or unreadable is refused, and $FLEET_GATE_MEMORY_BUDGET sets the budget", () => {
    expect(cli("gate", "take", "infra", "build", "--mem", "60%").stderr).toMatch(/^fleets: --mem 60% \(\S+\) is more than the budget of all holds together, 50% \(\S+\)\n$/);
    expect(cli("gate", "take", "infra", "build", "--mem", "lots").stderr).toBe("fleets: cannot read --mem 'lots': give a share of the RAM (25%) or a size (24G), 64M at least\n");
    expect(cli("gate", "take", "infra", "build", "--mem").stderr).toBe(
      "fleets: usage: fleet fleets gate | gate take FLEET|--as NAME WHAT [--for MINUTES] [--wait SECONDS] [--mem SIZE|PERCENT] [--floor SIZE|PERCENT] | gate free TOKEN\n",
    );
    expect(cli("gate").stdout).toBe("free\n");
    expect(fleet(["fleets", "gate", "take", "infra", "build", "--mem", "60%"], { ...env, FLEET_GATE_MEMORY_BUDGET: "75%" }).code).toBe(0);
    expect(JSON.parse(fleet(["fleets", "gate", "--json"], { ...env, FLEET_GATE_MEMORY_BUDGET: "2G" }).stdout)).toMatchObject({
      budget: { spec: "2G", bytes: 2 * 1024 ** 3 },
      holders: [{ name: "infra", kind: "fleet", what: "build" }],
      queue: [],
      day: null,
    });
  });

  // As two takes at once: thirty CLI starts, judged by the state each round leaves; the limit only catches a hang.
  test("six takes of a quarter at once: exactly two win, whatever the order", async () => {
    for (let round = 0; round < 5; round += 1) {
      const takers = Array.from({ length: 6 }, (_, i) =>
        Bun.spawn([FLEET, "fleets", "gate", "take", "--as", `t${String(i)}-${String(round)}`, "race", "--mem", "25%"], { env, stdout: "pipe", stderr: "pipe" }),
      );

      const codes = await Promise.all(takers.map(async (p) => p.exited));
      expect(codes.filter((c) => c === 0).length).toBe(2);
      const said = await Promise.all(takers.map(async (p) => new Response(p.stdout).text()));
      const tokens = said.flatMap((text) => /fleet fleets gate free (\S+)`/.exec(text)?.[1] ?? []);
      expect(tokens.length).toBe(2);

      for (const token of tokens) expect(cli("gate", "free", token).code).toBe(0);
      expect(cli("gate").stdout).toBe("free\n");
    }
  }, 120_000);

  describe("the memory available", () => {
    const GB = 1024 ** 3;

    /** A meminfo of the test's own whose MemAvailable is `available` bytes; the environment that reads it, with a
     * budget of 48G whatever the RAM of the machine running the test. */
    function withAvailable(available: number, more: Readonly<Environment> = {}): Environment {
      const path = join(base, "meminfo");
      writeFileSync(path, `MemTotal:       67108864 kB\nMemAvailable:   ${String(available / 1024)} kB\n`);

      return { ...env, FLEET_MEMINFO: path, FLEET_GATE_MEMORY_BUDGET: "48G", ...more };
    }

    test("a take goes ahead while MemAvailable less its part keeps 8G free", () => {
      const took = fleet(["fleets", "gate", "take", "infra", "build", "--mem", "16G"], withAvailable(24 * GB));
      expect(took.code).toBe(0);
      expect(took.stdout).toStartWith("infra holds the gate: build\n");
    });

    test("without --wait, a take below the floor is refused, naming MemAvailable, its part and the floor", () => {
      const refused = fleet(["fleets", "gate", "take", "infra", "build", "--mem", "16G"], withAvailable(20 * GB));
      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe(
        "fleets: not enough memory: 24.0G needed, 20.0G available (16.0G for this hold, 8.0G floor); take it when more memory is available (--wait queues for it), or with a smaller --mem\n",
      );
      expect(cli("gate").stdout).toBe("free\n");
    });

    // The 22:58 case: two suites asked seconds apart, before either used any memory, each read room for itself.
    test("two takes one after the other: the second counts the first's part, which nothing has used yet", () => {
      const at36 = withAvailable(36 * GB, { FLEET_GATE_MEMORY_BUDGET: "31.4G" });
      expect(fleet(["fleets", "gate", "take", "--as", "pipeline-a", "suite", "--mem", "15.7G"], at36).code).toBe(0);
      const second = fleet(["fleets", "gate", "take", "--as", "pipeline-b", "suite", "--mem", "15.7G"], at36);
      expect(second.code).toBe(1);
      expect(second.stderr).toMatch(/^fleets: held by pipeline-a \(no fleet\) since \S+, until \S+, cap 15\.7G: suite; /);
      expect(second.stderr).toEndWith(
        "; not enough memory: 39.4G needed, 36.0G available (15.7G held but not yet used, 15.7G for this hold, 8.0G floor); " +
          "take it when more memory is available (--wait queues for it), or with a smaller --mem\n",
      );
      expect(cli("gate").stdout).toStartWith("held by pipeline-a (no fleet)");
    });

    test("a take of the whole budget counts one run's cap, a quarter of the RAM, against the floor", () => {
      expect(fleet(["fleets", "gate", "take", "--as", "hand", "build"], withAvailable(36.5 * GB, { FLEET_GATE_MEMORY_BUDGET: "31.4G" })).code).toBe(0);
      expect(cli("gate", "free", "hand").code).toBe(0);
      const refused = fleet(["fleets", "gate", "take", "--as", "hand", "build"], withAvailable(23 * GB, { FLEET_GATE_MEMORY_BUDGET: "31.4G" }));
      expect(refused.stderr).toBe(
        "fleets: not enough memory: 24.0G needed, 23.0G available (16.0G for this hold, one run's cap, as it takes the whole budget, 8.0G floor); " +
          "take it when more memory is available (--wait queues for it), or with a smaller --mem\n",
      );
    });

    test("a take waiting only for memory keeps its place: a smaller take that fits waits behind it; the gate says it waits for the memory floor", async () => {
      const short = withAvailable(20 * GB);
      const big = Bun.spawn([FLEET, "fleets", "gate", "take", "--as", "big", "build", "--wait", "3"], { env: short, stdout: "pipe", stderr: "pipe" });
      const queued = (): JsonObject => asObject(JSON.parse(fleet(["fleets", "gate", "--json"], short).stdout)) ?? {};

      for (let tries = 0; tries < 100 && (asArray(queued()["queue"]) ?? []).length === 0; tries += 1) await Bun.sleep(100);
      expect(queued()).toMatchObject({ holders: [], queue: [{ place: 1, name: "big", for_memory: true }] });
      expect(fleet(["fleets", "gate"], short).stdout).toMatch(/^free\nqueue 1: big \(no fleet\), the whole budget, waiting for the memory floor \d+s: build\n$/);
      const small = fleet(["fleets", "gate", "take", "--as", "small", "lint", "--mem", "2G"], short);
      expect(small.code).toBe(1);
      expect(small.stderr).toContain("1 before it in the queue (big)");
      expect(await big.exited).toBe(1);
    });

    // A waiter that fitted both rows at its last ask, and now lacks CPUs beside the holds, waits for the gate, not for
    // the floor alone.
    test("a waiter is waiting for the memory floor only while it fits the CPU budget beside the holds as well", async () => {
      const sleepers = [Bun.spawn(["sleep", "300"]), Bun.spawn(["sleep", "300"])];
      const [runner, waiter] = sleepers.map((p) => p.pid);
      const since = new Date().toISOString();
      const until = new Date(Date.now() + 3600_000).toISOString();
      const dir = join(base, "registry", "gate");
      mkdirSync(dir, { recursive: true });
      const run = { fleet: "run", kind: "session", what: "gate run: suite", since, until, token: "0a1b2c3d", cap: 8 * GB, budget: 48 * GB, pid: runner, cpus: 8 };
      writeFileSync(join(dir, "gate.json"), JSON.stringify({ fleet: "run", kind: "session", what: "w", since, v: 2, until, holds: [run] }));
      writeFileSync(join(dir, "queue.json"), JSON.stringify({ waiters: [{ fleet: "late", kind: "session", what: "gate run: lint", since, until, pid: waiter, cap: 2 * GB, memory: true, cpus: 4 }] }));

      try {
        const at = (cpus: number): Environment => withAvailable(20 * GB, { FLEET_GATE_CPU_BUDGET: String(cpus) });
        const json = (cpus: number): JsonObject => asObject(JSON.parse(fleet(["fleets", "gate", "--json"], at(cpus)).stdout)) ?? {};
        expect(json(12)).toMatchObject({ cpu: { budget: 12, held: 8 }, queue: [{ name: "late", cpus: 4, for_memory: true }] });
        expect(fleet(["fleets", "gate"], at(12)).stdout).toContain("queue 1: late (no fleet), 2.0G, 4 CPUs, waiting for the memory floor ");
        expect(json(10)).toMatchObject({ queue: [{ name: "late", for_memory: false }] });
        expect(fleet(["fleets", "gate"], at(10)).stdout).toMatch(/\nqueue 1: late \(no fleet\), 2\.0G, 4 CPUs, waiting \d+s: gate run: lint\n/);
      } finally {
        for (const p of sleepers) p.kill("SIGKILL");
        await Promise.all(sleepers.map(async (p) => p.exited));
      }
    });

    test("--floor 50% is half the MemTotal of the same meminfo", () => {
      const path = join(base, "meminfo");
      writeFileSync(path, "MemTotal:       16777216 kB\nMemAvailable:   13631488 kB\n");
      expect(fleet(["fleets", "gate", "take", "--as", "pct", "x", "--mem", "4G", "--floor", "50%"], { ...env, FLEET_MEMINFO: path, FLEET_GATE_MEMORY_BUDGET: "8G" }).stderr).toBe("");
    });

    test("where MemAvailable cannot be read, --floor is ignored, and says so", () => {
      const took = fleet(["fleets", "gate", "take", "infra", "build", "--mem", "4G", "--floor", "4G"], env);
      expect(took.code).toBe(0);
      expect(took.stderr).toBe("fleets: no MemAvailable here (no /proc/meminfo): --floor is ignored, and only the budget counts\n");
    });

    test("--floor, else $FLEET_GATE_MEMORY_FLOOR, sets the floor, and 0 keeps nothing free", () => {
      expect(fleet(["fleets", "gate", "take", "infra", "a", "--mem", "16G", "--floor", "4G"], withAvailable(20 * GB)).code).toBe(0);
      expect(cli("gate", "free", "infra").code).toBe(0);
      expect(fleet(["fleets", "gate", "take", "ui", "b", "--mem", "16G"], withAvailable(20 * GB, { FLEET_GATE_MEMORY_FLOOR: "4G" })).code).toBe(0);
      expect(cli("gate", "free", "ui").code).toBe(0);
      expect(fleet(["fleets", "gate", "take", "infra", "c", "--mem", "16G", "--floor", "0"], withAvailable(16 * GB)).code).toBe(0);
      expect(cli("gate", "free", "infra").code).toBe(0);
      expect(fleet(["fleets", "gate", "take", "infra", "c", "--mem", "16G", "--floor", "0G"], withAvailable(16 * GB)).code).toBe(0);
      expect(fleet(["fleets", "gate", "take", "infra", "d", "--floor", "lots"], withAvailable(20 * GB)).stderr).toBe(
        "fleets: cannot read --floor 'lots': give a size (8G) or a share of the RAM (12%), 64M at least, or 0 to keep nothing free\n",
      );
      expect(fleet(["fleets", "gate", "take", "infra", "d"], withAvailable(20 * GB, { FLEET_GATE_MEMORY_FLOOR: "lots" })).stderr).toBe(
        "fleets: cannot read the floor $FLEET_GATE_MEMORY_FLOOR='lots': give a size (8G) or a share of the RAM (12%), 64M at least, or 0 to keep nothing free\n",
      );
    });

    test("with --wait, a take below the floor waits in the queue and takes once memory frees", async () => {
      const short = withAvailable(20 * GB);
      const waiter = Bun.spawn([FLEET, "fleets", "gate", "take", "--as", "w1", "suite", "--mem", "16G", "--wait", "20"], { env: short, stdout: "pipe", stderr: "pipe" });
      const queued = (): JsonObject => asObject(JSON.parse(fleet(["fleets", "gate", "--json"], short).stdout)) ?? {};

      for (let tries = 0; tries < 100 && (asArray(queued()["queue"]) ?? []).length === 0; tries += 1) await Bun.sleep(100);
      expect(queued()).toMatchObject({ holders: [], queue: [{ place: 1, name: "w1" }] });
      withAvailable(24 * GB);
      expect(await waiter.exited).toBe(0);
      expect(await new Response(waiter.stderr).text()).toBe("fleets: not enough memory: 24.0G needed, 20.0G available (16.0G for this hold, 8.0G floor); waiting up to 20s\n");
      expect(cli("gate").stdout).toStartWith("held by w1 (no fleet)");
    });

    test("with --wait, a take still below the floor when its wait ends is refused", () => {
      const refused = fleet(["fleets", "gate", "take", "infra", "build", "--mem", "16G", "--wait", "1"], withAvailable(20 * GB));
      expect(refused.code).toBe(1);
      expect(refused.stderr).toEndWith(
        "fleets: not enough memory: 24.0G needed, 20.0G available (16.0G for this hold, 8.0G floor); take it when more memory is available (--wait queues for it), or with a smaller --mem\n",
      );
      expect(JSON.parse(cli("gate", "--json").stdout)).toMatchObject({ holders: [], queue: [] });
    });
  });
});

describe("a fleet served again by a restarted session", () => {
  let config: string;
  let scratch: string;

  beforeEach(() => {
    config = tmp("claude-");
    scratch = tmp("tmp-");
    env = baseEnv(tmp("fleet-home-"), { CLAUDE_CONFIG_DIR: config });
    registry = machine(env).registry;
  });

  /** A process that lives until `end()`: the session a fleet lives as long as. */
  function session() {
    const proc = Bun.spawn(["sleep", "60"]);

    return {
      pid: proc.pid,
      end: async (): Promise<void> => {
        proc.kill();
        await proc.exited;
      },
    };
  }

  function title(project: string, sid: string, text: string): void {
    const d = join(config, "projects", project, sid);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "custom-title.json"), JSON.stringify({ customTitle: text }));
  }

  function scratchpad(project: string, sid: string): string {
    const root = join(scratch, project, sid, "scratchpad", "coordinator");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "state.json"), JSON.stringify({ project: "custom-mcp-servers" }));

    return root;
  }

  test("the entry records the session's id: the one given, else the scratchpad's", () => {
    expect(registry.register(makeFleet("a", "infra"), "u", process.pid, now(), "5579180b").raw["session_id"]).toBe("5579180b");
    expect(registry.register(scratchpad("-home-x-repo", "s1"), "u", process.pid, now()).raw["session_id"]).toBe("s1");
    expect(registry.register(makeFleet("b", "infra"), "u", process.pid, now()).raw["session_id"]).toBeNull();
  });

  test("fleet serve records the session it runs in", () => {
    const root = makeFleet("a", "infra");
    expect(fleet(["serve", root, "--pid", String(process.pid)], { ...env, CLAUDE_CODE_SESSION_ID: "5579180b", TAILSCALE: join(base, "none") }).code).toBe(0);
    expect(registry.find(root)?.raw["session_id"]).toBe("5579180b");
  });

  test("its dir served again from a new pid, with no title, keeps its name and aliases", async () => {
    const root = makeFleet("a", "custom-mcp-servers");
    const first = session();
    registry.register(root, "u", first.pid, now(), "5579180b");
    registry.name(root, "3.infra-coordinator");
    registry.name(root, "infra-coordinator (2)");
    await first.end();
    expect(registry.live()).toEqual([]);
    const again = registry.register(root, "u2", process.pid, now());
    expect([again.id, again.aliases, again.session]).toEqual(["infra-coordinator-2", ["custom-mcp-servers", "infra-coordinator"], "infra-coordinator (2)"]);
  });

  test("a new pid of the same session, serving another dir, keeps the name", async () => {
    const a = makeFleet("a", "custom-mcp-servers");
    const first = session();
    registry.register(a, "u", first.pid, now(), "5579180b");
    registry.name(a, "infra-coordinator (2)");
    await first.end();
    registry.live();
    const moved = registry.register(makeFleet("b", "custom-mcp-servers"), "u2", process.pid, now(), "5579180b");
    expect(moved.id).toBe("infra-coordinator-2");
    expect(registry.register(makeFleet("c", "custom-mcp-servers"), "u3", process.pid, now(), "another").id).toBe("custom-mcp-servers");
  });

  test("a kept name another fleet took meanwhile is not taken back", async () => {
    const a = makeFleet("a", "billing");
    const first = session();
    registry.register(a, "u", first.pid, now());
    await first.end();
    registry.live();
    registry.register(makeFleet("b", "billing"), "u", process.pid, now());
    expect(registry.register(a, "u2", process.pid, now()).id).toBe("billing-2");
  });

  test("a missing or empty title never renames; a real /rename does, and the old name stays an alias", () => {
    const root = scratchpad("-home-x-repo", "s1");
    expect(registry.register(root, "u", process.pid, now()).id).toBe("custom-mcp-servers");
    title("-home-x-repo", "s1", "  ");
    expect(registry.live().map((e) => e.id)).toEqual(["custom-mcp-servers"]);
    title("-home-x-repo", "s1", "Infra Coordinator 2");
    const renamed = registry.live()[0];
    expect([renamed?.id, renamed?.aliases]).toEqual(["infra-coordinator-2", ["custom-mcp-servers"]]);
    expect(fleetsNamed(registry.live(), "custom-mcp-servers").map((e) => e.id)).toEqual(["infra-coordinator-2"]);
  });

  test("a fleet outside any scratchpad follows its session's /rename, found by the session's id", () => {
    const root = makeFleet("a", "custom-mcp-servers");
    title("-home-x-repo", "5579180b", "Infra Coordinator");
    expect(registry.register(root, "u", process.pid, now(), "5579180b").id).toBe("infra-coordinator");
    title("-home-x-repo", "5579180b", "infra-coordinator (2)");
    const renamed = registry.live()[0];
    expect([renamed?.id, renamed?.session, renamed?.aliases]).toEqual(["infra-coordinator-2", "infra-coordinator (2)", ["infra-coordinator"]]);
  });

  /** Session `sid`'s transcript in `project`, last written at `at`. */
  function wrote(project: string, sid: string, at: string): string {
    const path = join(config, "projects", project, `${sid}.jsonl`);
    mkdirSync(join(config, "projects", project), { recursive: true });
    writeFileSync(path, "{}\n");
    utimesSync(path, new Date(at), new Date(at));

    return stampOf(new Date(at)).slice(0, 16).replace("T", " ");
  }

  test("a resumed session serving its dir again is the fleet's session: its last activity and title, not the scratchpad's", () => {
    const root = scratchpad("-home-x-repo", "s1");
    title("-home-x-repo", "s1", "Infra");
    const before = wrote("-home-x-repo", "s1", "2026-10-07T21:06:00Z");
    expect(registry.register(root, "u", process.pid, now(), "s1").id).toBe("infra");
    expect(cli("list").stdout).toContain(`session  Infra, last active ${before}`);
    title("-home-x-repo", "s2", "Infra Two");
    const after = wrote("-home-x-repo", "s2", "2026-10-10T10:50:00Z");
    const again = registry.register(root, "u", process.pid, now(), "s2");
    expect([again.id, again.session, again.raw["session_id"]]).toEqual(["infra-two", "Infra Two", "s2"]);
    expect(cli("list").stdout).toContain(`session  Infra Two, last active ${after}`);
  });

  test("fleets name run from another session renames only: the entry keeps the session serving it", () => {
    const root = scratchpad("-home-x-repo", "s1");
    title("-home-x-repo", "s1", "Alpha");
    const at = wrote("-home-x-repo", "s1", "2026-10-10T10:00:00Z");
    registry.register(root, "u", process.pid, now(), "s1");
    title("-home-y-other", "sB", "Bravo");
    wrote("-home-y-other", "sB", "2026-10-01T09:00:00Z");
    expect(fleet(["fleets", "name", root, "Alpha"], { ...env, CLAUDE_CODE_SESSION_ID: "sB" }).code).toBe(0);
    expect(registry.live().map((e) => [e.id, e.session, e.raw["session_id"]])).toEqual([["alpha", "Alpha", "s1"]]);
    expect(cli("list").stdout).toContain(`session  Alpha, last active ${at}`);
  });

  test("a resumed session with no title of its own keeps the scratchpad's title", () => {
    const root = scratchpad("-home-x-repo", "s1");
    title("-home-x-repo", "s1", "Infra");
    wrote("-home-x-repo", "s1", "2026-10-07T21:06:00Z");
    registry.register(root, "u", process.pid, now(), "s1");
    wrote("-home-x-repo", "s2", "2026-10-10T10:50:00Z");
    expect(registry.titleOf(root, "s2")).toEqual({ title: "Infra", given: true });
    const again = registry.register(root, "u", process.pid, now(), "s2");
    expect([again.id, again.session, again.raw["session_id"]]).toEqual(["infra", "Infra", "s2"]);
  });

  test("a recorded session whose transcript is not found reads the scratchpad's", () => {
    const root = scratchpad("-home-x-repo", "s1");
    const old = wrote("-home-x-repo", "s1", "2026-10-01T10:00:00Z");
    registry.register(root, "u", process.pid, now(), "s2");
    expect(cli("list").stdout).toContain(`last active ${old}`);
  });

  test("a brand-new dir with no title still gets its project's slug", async () => {
    const a = makeFleet("a", "infra");
    const first = session();
    registry.register(a, "u", first.pid, now(), "s-old");
    registry.name(a, "infra-coordinator");
    await first.end();
    registry.live();
    expect(registry.register(makeFleet("b", "custom-mcp-servers"), "u", process.pid, now(), "s-new").id).toBe("custom-mcp-servers");
  });
});

describe("a fleet has one host: fleet serve from another process", () => {
  const sessions: Bun.Subprocess[] = [];

  afterEach(async () => {
    for (const proc of sessions.splice(0)) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });

  /** A process of this test that lives until the test ends: a session a fleet may be served from (`--pid`). */
  function session(): Bun.Subprocess {
    const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    sessions.push(proc);

    return proc;
  }

  const serve = (root: string, pid: number, ...more: string[]): Ran => fleet(["serve", root, "--pid", String(pid), ...more], { ...env, CLAUDE_CODE_SESSION_ID: `sess-${String(pid)}`, TAILSCALE: join(base, "none") });

  /** Whether `ran` was refused for the fleet's host (a serve with no hub running says so on stderr too, and serves). */
  const refusedFor = (ran: Ran): boolean => ran.stderr.includes("is hosted by the session running as pid");

  const hostOf = (root: string): readonly [number | null, string | null, string | null] => {
    const raw = registry.find(root)?.raw;

    return [asNumber(raw?.["pid"]) ?? null, asString(raw?.["started"]) ?? null, asString(raw?.["session_id"]) ?? null];
  };

  /** The file the registry keeps `root`'s entry in. */
  function entryPath(root: string): string {
    const home = env["FLEET_HOME"] ?? "";
    const found = readdirSync(home).find((name) => name.endsWith(".json") && readJson(join(home, name))["dir"] === root);

    if (found === undefined) throw new Error(`${root} is not in the registry`);

    return join(home, found);
  }

  test("the entry carries when its process started", () => {
    const root = makeFleet("a", "infra");
    const first = session();
    const served = serve(root, first.pid);
    expect([served.code, refusedFor(served), served.stdout.includes("took over")]).toEqual([0, false, false]);
    expect(hostOf(root)).toEqual([first.pid, startedOf(first.pid) ?? "none", `sess-${String(first.pid)}`]);
    expect(registry.register(makeFleet("b", "infra"), "u", process.pid, now()).raw["started"]).toBe(startedOf(process.pid) ?? "none");
  });

  test("serving from a second process while the first runs is refused: it names the host's pid and --take-over, and the entry stays the host's", () => {
    const root = makeFleet("a", "infra");
    const [first, second] = [session(), session()];
    expect(serve(root, first.pid).code).toBe(0);
    const before = readFileSync(entryPath(root), "utf8");
    const refused = serve(root, second.pid);
    expect([refused.code === 0, refused.stdout]).toEqual([false, ""]);
    expect(refusedFor(refused)).toBe(true);
    expect(refused.stderr).toBe(
      `serve: ${root} is hosted by the session running as pid ${String(first.pid)} (infra, session sess-${String(first.pid)}), which is live: ` +
        `this process (pid ${String(second.pid)}) is a copy of it or another session, and the fleet's page, chat watch and wakes stay that session's. ` +
        `To move the fleet here, \`fleet serve ${root} --take-over\`, which is recorded in the fleet's ledger and chat and shown to the user on its page.\n`,
    );
    expect(readFileSync(entryPath(root), "utf8")).toBe(before);
    expect(hostOf(root)[0]).toBe(first.pid);
    // --stop is not serving: any session may take the fleet out.
    expect(serve(root, second.pid, "--stop").code).toBe(0);
    expect(registry.find(root)).toBeUndefined();
  });

  test("--take-over serves from the second process and is never silent: it prints whom it displaced, and records it in the ledger and in the chat, to the user", () => {
    const root = makeFleet("a", "infra");
    const [first, second] = [session(), session()];
    serve(root, first.pid);
    const url = registry.find(root)?.url ?? "";
    expect([readJson(join(root, "state.json"))["events"], existsSync(join(root, "chat.jsonl"))]).toEqual([[], false]);
    const taken = serve(root, second.pid, "--take-over");
    expect([taken.code, refusedFor(taken)]).toEqual([0, false]);
    expect(taken.stdout).toBe(
      `${url}\ntook over from the session running as pid ${String(first.pid)} (session sess-${String(first.pid)}): its chat watch stands down, and it is not woken for this fleet any more\n` +
        `recorded: an event in the fleet's ledger and #1 in its chat; the page shows it to the user until the host has read their next message\n`,
    );
    expect(hostOf(root)).toEqual([second.pid, startedOf(second.pid) ?? "none", `sess-${String(second.pid)}`]);
    expect(registry.live().map((e) => e.id)).toEqual(["infra"]);
    // Who displaced whom, with each process's pid and start, and when: the same facts in both places.
    const side = (pid: number): string => `session sess-${String(pid)} (pid ${String(pid)}, started ${stampOf(new Date(startedMsOf(pid) ?? 0))})`;
    const [said] = readChat(root);
    const at = asString(said?.at) ?? "";
    expect(parseInstant(at)).toBeDefined();
    expect([said?.id, said?.from, said?.to, said?.re]).toEqual([1, "fleet-hub", ["user"], null]);
    expect(said?.text).toBe(
      `[hub] This fleet's host changed at ${at}: ${side(second.pid)} took it over with \`fleet serve --take-over\` from ${side(first.pid)}, which was running. ` +
        `The page, the chat watch and the hub's wakes are the new session's now. If you did not ask for this, say so here.`,
    );
    const party = (pid: number): JsonObject => ({ pid, started: stampOf(new Date(startedMsOf(pid) ?? 0)), session: `sess-${String(pid)}` });
    expect(said?.stored["takeover"]).toEqual({ at, by: party(second.pid), from: party(first.pid) });
    expect(readJson(join(root, "state.json"))["events"]).toEqual([
      { at, agent: null, kind: "note", text: `Host changed: ${side(second.pid)} took the fleet over with \`fleet serve --take-over\` from ${side(first.pid)}, which was running.`, important: true },
    ]);
    // The displaced session is now the copy: it is refused in its turn.
    expect(serve(root, first.pid).stderr).toContain(`is hosted by the session running as pid ${String(second.pid)}`);
    expect(hostOf(root)[0]).toBe(second.pid);
  });

  test("serving again from the same process needs no flag, and --take-over with nobody to displace says nothing of it", () => {
    const root = makeFleet("a", "infra");
    const first = session();
    const once = serve(root, first.pid);
    const again = serve(root, first.pid);
    expect([again.code, again.stdout, again.stderr]).toEqual([0, once.stdout, once.stderr]);
    const flagged = serve(root, first.pid, "--take-over");
    expect([flagged.code, flagged.stdout, flagged.stderr]).toEqual([0, once.stdout, once.stderr]);
    expect(refusedFor(once)).toBe(false);
    const fresh = serve(makeFleet("b", "billing"), first.pid, "--take-over");
    expect([fresh.code, fresh.stdout.includes("took over")]).toEqual([0, false]);
    // Nobody was displaced: nothing is recorded.
    expect([readJson(join(root, "state.json"))["events"], existsSync(join(root, "chat.jsonl"))]).toEqual([[], false]);
  });

  test("a takeover whose ledger does not read still moves the fleet: the chat has the line, and the command says what is missing", () => {
    const root = makeFleet("a", "infra");
    const [first, second] = [session(), session()];
    serve(root, first.pid);
    writeFileSync(join(root, "state.json"), "{not a ledger");
    const taken = serve(root, second.pid, "--take-over");
    expect(taken.code).toBe(0);
    expect(taken.stdout).toContain("recorded: #1 in its chat; the page shows it to the user until the host has read their next message\n");
    expect(taken.stderr).toContain(`serve: the takeover is not recorded where it should be: the ledger did not take the event: no ledger reads in ${root}\n`);
    expect([hostOf(root)[0], readChat(root).map((x) => x.from)]).toEqual([second.pid, ["fleet-hub"]]);
  });

  test("once the first process ended, another serves with no flag", async () => {
    const root = makeFleet("a", "infra");
    const [first, second] = [session(), session()];
    serve(root, first.pid);
    first.kill("SIGKILL");
    await first.exited;
    const next = serve(root, second.pid);
    expect([next.code, refusedFor(next), next.stdout.includes("took over")]).toEqual([0, false, false]);
    expect(hostOf(root)).toEqual([second.pid, startedOf(second.pid) ?? "none", `sess-${String(second.pid)}`]);
  });

  test("a recorded process whose pid another process has now is gone: no flag; an entry with no recorded start goes by its pid", () => {
    const root = makeFleet("a", "infra");
    const [first, second] = [session(), session()];
    serve(root, first.pid);
    const path = entryPath(root);
    const entry = readJson(path);
    // The pid lives, and started at another time than the entry says: the session that served the fleet is gone.
    writeFileSync(path, JSON.stringify({ ...entry, started: `${startedOf(first.pid) ?? ""}0` }));
    const next = serve(root, second.pid);
    expect([next.code, refusedFor(next), next.stdout.includes("took over")]).toEqual([0, false, false]);
    expect(hostOf(root)[0]).toBe(second.pid);
    // Served before the start was recorded: the pid that lives is the host.
    const { started: _dropped, ...legacy } = readJson(path);
    writeFileSync(path, JSON.stringify(legacy));
    const refused = serve(root, first.pid);
    expect([refused.code === 0, refused.stderr.includes(`is hosted by the session running as pid ${String(second.pid)}`)]).toEqual([false, true]);
    expect(serve(root, first.pid, "--take-over").stdout).toContain(`took over from the session running as pid ${String(second.pid)}`);
    expect(hostOf(root)).toEqual([first.pid, startedOf(first.pid) ?? "none", `sess-${String(first.pid)}`]);
  });
});
