/**
 * The registry of the fleets on this machine (ported from the coordinator's tests/test_fleets.py): how a
 * manager finds the coordinators and they it, and the `fleets` CLI. The page's view of them
 * (`fleets.view`) is the hub's, stage 3; what it summarises is checked here through `fleets list`.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import type { Registry } from "../src/registry.ts";
import { baseEnv, fleet, machine, now, readJson, tmp, type Environment, type Ran } from "./support.ts";

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
    expect(readdirSync(join(base, "registry")).sort()).toEqual(["here.json"]);
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
    expect(out).toContain(`billing-coordinator  coordinator  session billing-coordinator  running  https://box.ts.net:1/  ${a}`);
    expect(out).toContain("    now: now of billing");
    expect(out).toContain("    lanes in flight: src/billing/**");
    expect(out).toContain("    D1 d1 [decision, for the user, blocks work] Schema");
    expect(out).toContain("    I1 d2 [input, for the manager] Rate");
    expect(out).not.toContain("Old");
    const shown = cli("show", "billing-coordinator").stdout;
    expect(shown).toContain("    a1 (x) running since");
    expect(shown).toContain("    roadblock r1 [needs user] T");
  });

  test("a fleet whose state cannot be read is shown as such", () => {
    const a = makeFleet("a", "billing");
    register(a, "u");
    writeFileSync(join(a, "state.json"), "{half");
    register(makeFleet("m", "everything", { role: "manager" }), "u9");
    expect(cli("list").stdout).toContain("billing  coordinator  session (not named yet)  unknown  u");
  });
});

describe("the CLI", () => {
  test("list prints each fleet with how to reach it", () => {
    const a = makeFleet("a", "billing", { decisions: [{ id: "d1", kind: "input", title: "Rate", question: "q", status: "open", asks: "manager", opened: "x" }] });
    register(a, "https://box.ts.net:1/");
    expect(cli("name", a, "billing-coordinator").code).toBe(0);
    const out = cli("list").stdout;
    expect(out).toContain("billing-coordinator  coordinator  session billing-coordinator  running");
    expect(out).toContain("https://box.ts.net:1/");
    expect(out).toContain(a);
    expect(out).toContain("now of billing");
    expect(out).toContain("d1 [input, for the manager] Rate");
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
      "page: https://box.ts.net:1/#decision/d7",
    ]) {
      expect(out).toContain(line);
    }

    expect(cli("decision", "billing", "D4").stdout).toContain("page: https://box.ts.net:1/#decision/d7");

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
        { id: "later", kind: "decision", title: "Held", question: "q", status: "open", opened: at, held: "after the cost work" },
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
});
