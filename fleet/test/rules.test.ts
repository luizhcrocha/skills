/**
 * The rules the skills used to ask a coordinator, a manager or a worker to remember, now kept by the CLI
 * (D13 stage 5, fleet/RULES.md): what it refuses, what it warns about, and what it composes. Through the
 * CLI, as every other test of the fleet.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { callRev } from "../src/ledger/permission.ts";
import { startedOf } from "../src/procs.ts";
import { baseEnv, fleet, fleetAsync, readJson, sleep, start, tmp, type Environment, type Ran } from "./support.ts";

let base: string;

let root: string;

let env: Environment;

const procs: Bun.Subprocess[] = [];

function run(...args: string[]): Ran {
  return fleet(["state", root, ...args, "--no-render"], env);
}

function ok(...args: string[]): Ran {
  const ran = run(...args);
  expect(ran.code, ran.stderr).toBe(0);

  return ran;
}

function refused(...args: string[]): Ran {
  const ran = run(...args);
  expect(ran.code, ran.stdout).toBe(1);

  return ran;
}

function rows(key: string, dir = root): JsonObject[] {
  return (asArray(readJson(join(dir, "state.json"))[key]) ?? []).map((r) => asObject(r) ?? {});
}

function steps(dir = root): JsonObject[] {
  return rows("roadmap", dir).flatMap((m) => (asArray(m["steps"]) ?? []).map((s) => asObject(s) ?? {}));
}

function userSays(id: number, at: string, text: string, decision: string): void {
  const line = JSON.stringify({ id, at, from: "user", to: ["coordinator"], text, re: null, decision });
  writeFileSync(join(root, "chat.jsonl"), `${line}\n`, { flag: "a" });
}

const CHOICE = ["--kind", "decision", "--title", "Schema", "--question", "Migrate?", "--why", "W", "--option", "A: a | x", "--option", "B: b | y", "--recommend", "A", "--reason", "R"];

beforeEach(() => {
  base = tmp("fleet-rules-");
  root = join(base, "coordinator");
  env = baseEnv(join(base, "registry"), { FLEET_NOW: "2026-01-05T09:00:00+00:00", TZ: "UTC" });
  ok("init", "--project", "p", "--goal", "g");
  ok("milestone", "m1", "--title", "M");
  ok("step", "s1", "--milestone", "m1", "--title", "the schema");
});

afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});

describe("a refused write says nothing but why (open-2)", () => {
  test("a new worker the final check refuses prints no `recorded` line", () => {
    ok("agent", "a1", "--task", "T", "--milestone", "m1");
    const ran = refused("agent", "a2", "--task", "T", "--milestone", "m1", "--name", "a1");
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toContain("render_dashboard:");
    expect(rows("agents").map((a) => a["id"])).toEqual(["a1"]);
  });
});

describe("a roadblock names a recorded worker (open-3)", () => {
  test("an unknown --agent is refused, on a new roadblock and on a change", () => {
    expect(refused("roadblock", "r1", "--title", "T", "--detail", "D", "--severity", "warning", "--needs", "worker", "--agent", "ghost").stderr).toBe(
      "state: unknown agent 'ghost'\n",
    );
    ok("roadblock", "r1", "--title", "T", "--detail", "D", "--severity", "warning", "--needs", "worker");
    expect(refused("roadblock", "r1", "--agent", "ghost").stderr).toBe("state: unknown agent 'ghost'\n");
  });
});

describe("park frees the parked workers' steps (open-5)", () => {
  test("a parked worker's current step goes back to pending and keeps its worker", () => {
    ok("agent", "a1", "--task", "T", "--milestone", "m1", "--step", "s1");
    expect(steps()[0]).toMatchObject({ status: "current", agent: "a1" });
    ok("park", "the session ends");
    expect(steps()[0]).toMatchObject({ status: "pending", agent: "a1" });
  });
});

describe("an answer on the page is recorded before other work", () => {
  test("every command warns until the decision is recorded, then stops", () => {
    ok("decision", "d1", ...CHOICE);
    userSays(1, "2026-01-05T09:05:00+00:00", "B", "d1");
    const warned = ok("event", "something else").stderr;
    expect(warned).toContain("state: the user answered D1 (Schema) as #1 at 09:05; record it before any other work: ");
    expect(warned).toContain('decision D1 --decide "..." --resolution "answer given on the page (#1)"');
    expect(ok("decision", "D1", "--decide", "B", "--resolution", "answered on the page (#1)").stderr).not.toContain("the user answered");
    expect(ok("event", "later").stderr).not.toContain("the user answered");
  });

  test("a reply in the chat does not record it: the warning stands until the decision command runs (D115)", () => {
    ok("decision", "d1", ...CHOICE);
    userSays(1, "2026-01-05T09:05:00+00:00", "B", "d1");
    const reply = JSON.stringify({ id: 2, at: "2026-01-05T09:06:00+00:00", from: "coordinator", to: ["user"], text: "Recorded B", re: 1 });
    writeFileSync(join(root, "chat.jsonl"), `${reply}\n`, { flag: "a" });
    expect(ok("event", "something else").stderr).toContain("state: the user answered D1 (Schema) as #1 at 09:05; record it before any other work: ");
    expect(ok("decision", "D1", "--decide", "B", "--resolution", "answered on the page (#1)").stderr).not.toContain("the user answered");
  });

  test("an answer from before the decision last changed is not one, compared as instants across offsets (open-13)", () => {
    ok("decision", "d1", ...CHOICE);
    // 09:30+01:00 is 08:30 UTC: before the decision was opened, though its text sorts after.
    userSays(1, "2026-01-05T09:30:00+01:00", "B", "d1");
    expect(ok("event", "x").stderr).not.toContain("the user answered");
  });
});

describe("a grilling with every question answered is recorded before other work", () => {
  const NAG = "state: every question of G1 (Search) is answered and the grilling is still open; record it before any other work: ";

  function coordinatorSays(id: number, at: string, text: string, re: number | null): void {
    const line = JSON.stringify({ id, at, from: "coordinator", to: ["user"], text, re, decision: "g1" });
    writeFileSync(join(root, "chat.jsonl"), `${line}\n`, { flag: "a" });
  }

  /** G1 with both questions answered on the page and recorded, the last answer replied to with a recap, then amendments. */
  function answered(title = "Search"): void {
    ok("grill", "g1", "--title", title, "--ask", "Seam | one or many? | one | less code", "--ask", "Tier | local first? | yes | it is faster");
    userSays(1, "2026-01-05T09:05:00+00:00", "Q1: one\nQ2: yes", "g1");
    ok("grill", "g1", "--answer", "Q1: one", "--answer", "Q2: yes");
    coordinatorSays(2, "2026-01-05T09:06:00+00:00", "That empties the tree. Say 'confirm' and I start.", 1);
    coordinatorSays(3, "2026-01-05T09:07:00+00:00", "The advisor's amendments, before you confirm: ...", null);
  }

  test("every command says so, whatever the chat said after the last answer, until it is decided", () => {
    answered();
    const warned = ok("event", "something else").stderr;
    expect(warned).toContain(NAG);
    expect(warned).toContain('decision G1 --decide "..." --resolution "grilling finished"');
    expect(warned).not.toContain("the user answered G1");
    expect(ok("decision", "G1", "--decide", "one seam, local first", "--resolution", "grilling finished").stderr).not.toContain("every question of G1");
    expect(ok("event", "later").stderr).not.toContain("every question of G1");
  });

  test("withdrawing it stops the warning too, and one with a question left is not warned about", () => {
    answered();
    ok("decision", "G1", "--withdraw", "moot");
    expect(ok("event", "x").stderr).not.toContain("every question of");
    ok("grill", "g2", "--title", "Dates", "--ask", "a | b | c | d", "--ask", "e | f | g | h");
    ok("grill", "g2", "--answer", "Q1: b");
    expect(ok("event", "y").stderr).not.toContain("every question of");
  });

  test("`show` reads it as answered and waiting to be recorded, then decided", () => {
    answered();
    expect(ok("show").stdout).toContain("  G1 decision g1 OPEN, answered, waiting to be recorded [grill] Search\n");
    ok("decision", "G1", "--decide", "one seam", "--resolution", "grilling finished");
    expect(ok("show").stdout).toContain("  G1 decision g1 decided [grill] Search: one seam\n");
  });

  test("the coordinator's watch names it once, and a watch after that stays quiet", async () => {
    answered();
    const watchEnv = { ...env, FLEET_NOW: "2026-01-05T09:10:00+00:00", FLEET_CHECK_S: "0.2" };
    const first = start(["chat", root, "watch", "--as", "coordinator", "--resume", "--once"], watchEnv);
    procs.push(first.proc);
    expect(await first.lines.next()).toBe(
      "! G1 (Search): every question is answered and the grilling is still open. Record it now: " +
        '`fleet state <dir> decision G1 --decide "..." --resolution "grilling finished"`, or withdraw it with its reason.\n',
    );
    expect(await first.proc.exited).toBe(0);
    const again = start(["chat", root, "watch", "--as", "coordinator", "--resume", "--once"], watchEnv);
    procs.push(again.proc);
    await Bun.sleep(1500);
    expect(again.proc.exitCode).toBeNull();
    again.proc.kill();
  }, 20_000);

  test("a title's bidi override or control character never reaches the watch's line", async () => {
    answered("Se\u202Earch\u2066");
    const watch = start(["chat", root, "watch", "--as", "coordinator", "--resume", "--once"], { ...env, FLEET_NOW: "2026-01-05T09:10:00+00:00", FLEET_CHECK_S: "0.2" });
    procs.push(watch.proc);
    expect(await watch.lines.next()).toStartWith("! G1 (Search): every question is answered");
    expect(await watch.proc.exited).toBe(0);
  }, 20_000);
});

describe("a permission the hook opened is explained by the coordinator in the same turn", () => {
  const CALL = "cd /work/repo-a1 && uv run python vlmrun.py run";

  function opened(): void {
    ok("agent", "a1", "--task", "T", "--milestone", "m1", "--name", "the matcher");
    ok("decision", "p1", "--kind", "permission", "--title", "a1: Bash refused", "--question", "q", "--why", "w", "--tool", "Bash", "--call", CALL, "--cause", "[Real-World Transactions]", "--root", "/work/repo", "--agent-id", "x9", "--blocking");
  }

  test("the coordinator's watch asks for the explanation once, and a watch after that stays quiet", async () => {
    opened();
    const watchEnv = { ...env, FLEET_NOW: "2026-01-05T09:10:00+00:00", FLEET_CHECK_S: "0.2" };
    const first = start(["chat", root, "watch", "--as", "coordinator", "--resume", "--once"], watchEnv);
    procs.push(first.proc);
    const line = await first.lines.next();
    expect(line).toStartWith(
      "! P1 (Allow the matcher to run `python vlmrun.py run` in /work/repo-a1?): auto mode refused a worker's call, and the page waits for your explanation. Explain it now: " +
        `\`fleet state ${root} decision P1 --call ${callRev(`Bash(${CALL})`)} --why `,
    );
    expect(await first.proc.exited).toBe(0);
    const again = start(["chat", root, "watch", "--as", "coordinator", "--resume", "--once"], watchEnv);
    procs.push(again.proc);
    await Bun.sleep(1500);
    expect(again.proc.exitCode).toBeNull();
    again.proc.kill();
  }, 20_000);

  test("an explained permission, or one the user answered, asks for nothing", () => {
    opened();
    userSays(1, "2026-01-05T09:05:00+00:00", "deny: Deny", "p1");
    const warned = ok("event", "x").stderr;
    expect(warned).toContain("state: the user answered P1");
    expect(warned).not.toContain("is a call auto mode refused");
  });
});

describe("a fleet set done says what it leaves open", () => {
  test("open decisions are named on `set --status done`", () => {
    ok("decision", "d1", ...CHOICE);
    const ran = ok("set", "--status", "done", "--now", "done");
    expect(ran.stderr).toContain("state: the fleet is done with D1 still open: withdraw each with its reason");
    ok("set", "--status", "running");
    ok("decision", "D1", "--withdraw", "moot");
    expect(ok("set", "--status", "done").stderr).not.toContain("still open");
  });
});

describe("lanes", () => {
  test("a running worker whose lane meets another running lane is warned about", () => {
    ok("agent", "a1", "--task", "T", "--milestone", "m1", "--lane", "src/usage/**");
    const ran = ok("agent", "a2", "--task", "T", "--milestone", "m1", "--lane", "src/usage/x.ts", "docs/");
    expect(ran.stderr).toContain("state: a2's lane overlaps a1's (running: src/usage/x.ts). A task whose files overlap a running lane waits");
    expect(ok("agent", "a3", "--task", "T", "--milestone", "m1", "--lane", "src/billing/").stderr).not.toContain("overlaps");
    expect(ok("agent", "a4", "--task", "T", "--milestone", "m1", "--lane", "src/usage/y.ts", "--status", "queued").stderr).not.toContain("overlaps");
  });

  test("lanes meet when some path matches both globs, not when their directories nest (L7)", () => {
    ok("agent", "a1", "--task", "T", "--milestone", "m1", "--lane", "src/*.ts");
    expect(ok("agent", "a2", "--task", "T", "--milestone", "m1", "--lane", "src/a/b.ts").stderr).not.toContain("overlaps");
    expect(ok("agent", "a3", "--task", "T", "--milestone", "m1", "--lane", "src/**").stderr).toContain(
      "state: a3's lane overlaps a1's (running: src/**); a2's (running: src/**).",
    );
    ok("agent", "a3", "--status", "queued");
    expect(ok("agent", "a4", "--task", "T", "--milestone", "m1", "--lane", "src/x.ts").stderr).toContain("a4's lane overlaps a1's (running: src/x.ts).");
  });
});

describe("models outside the policy (L3)", () => {
  test("haiku is in the policy; a model outside it, as a hand-written row has, is recorded with a warning", () => {
    const ran = ok("agent", "a1", "--task", "T", "--milestone", "m1", "--model", "haiku");
    expect(ran.stderr).not.toContain("policy");
    expect(rows("agents")[0]).toMatchObject({ model: "haiku", effort: "high" });
    expect(ok("agent", "a1", "--effort", "medium").stderr).toContain("on haiku at medium effort, outside the effort policy");
    expect(ok("agent", "a1", "--model", "sonnet").stderr).not.toContain("policy");
    expect(ok("agent", "a2", "--task", "T", "--milestone", "m1").stderr).not.toContain("model policy");

    const ledger = readJson(join(root, "state.json"));

    writeFileSync(join(root, "state.json"), JSON.stringify({ ...ledger, agents: rows("agents").map((a) => (a["id"] === "a1" ? { ...a, model: "gpt" } : a)) }));
    expect(ok("agent", "a1", "--effort", "high").stderr).toContain(
      "state: a1 is recorded on gpt, outside the model policy (opus, sonnet, fable, haiku): spawning it on gpt needs the user's OK.",
    );
  });
});

describe("thinking effort and the role table", () => {
  test("a new worker takes its kind's model and effort", () => {
    const kinds = [["i1", "implement"], ["t1", "tdd"], ["p1", "prototype"], ["d1", "diagnosing-bugs"], ["r1", "research"], ["n1", "none"]];

    for (const [id, skill] of kinds) expect(ok("agent", id ?? "", "--task", "T", "--milestone", "m1", "--skill", skill ?? "").stderr).not.toContain("policy");
    expect(Object.fromEntries(rows("agents").map((a) => [a["id"], `${String(a["model"])} ${String(a["effort"])}`]))).toEqual({
      i1: "opus high", t1: "opus high", p1: "opus high", d1: "opus high", r1: "sonnet medium", n1: "opus high",
    });
    expect(Object.keys(rows("agents")[0] ?? {}).slice(0, 6)).toEqual(["id", "name", "task", "skill", "model", "effort"]);
  });

  test("a model given alone keeps its kind's effort when the pair is in the policy, else takes its own", () => {
    ok("agent", "a1", "--task", "T", "--milestone", "m1", "--skill", "research", "--model", "opus");
    ok("agent", "a2", "--task", "T", "--milestone", "m1", "--skill", "research", "--model", "fable");
    ok("agent", "a3", "--task", "T", "--milestone", "m1", "--skill", "research", "--model", "haiku");
    ok("agent", "a4", "--task", "T", "--milestone", "m1", "--skill", "research", "--effort", "low");
    expect(rows("agents").map((a) => `${String(a["model"])} ${String(a["effort"])}`)).toEqual(["opus medium", "fable high", "haiku high", "sonnet low"]);
  });

  test("a pair outside the table is recorded, with a warning that it is the user's to approve", () => {
    const ran = ok("agent", "a1", "--task", "T", "--milestone", "m1", "--effort", "low");
    expect(ran.stderr).toContain(
      "state: a1 is recorded on opus at low effort, outside the effort policy (opus medium, high, xhigh; sonnet low, medium, high, xhigh; fable high; haiku low, high, xhigh): spawning it so needs the user's OK.",
    );
    expect(rows("agents")[0]?.["effort"]).toBe("low");
    expect(ok("agent", "a1", "--model", "sonnet").stderr).not.toContain("policy");
    expect(ok("agent", "a1", "--effort", "max", "--model", "fable").stderr).toContain("at max effort");
    expect(ok("agent", "a1", "--model", "haiku", "--effort", "xhigh").stderr).not.toContain("policy");
    expect(ok("agent", "a1", "--model", "sonnet", "--effort", "xhigh").stderr).not.toContain("policy");
    expect(ok("agent", "a1", "--model", "opus", "--effort", "xhigh").stderr).not.toContain("policy");
    expect(ok("agent", "a1", "--model", "fable").stderr).toContain("on fable at xhigh effort");

    for (const model of ["opus", "sonnet", "haiku", "fable"]) expect(ok("agent", "a1", "--model", model, "--effort", "max").stderr).toContain(`on ${model} at max effort`);
    expect(ok("agent", "a1", "--status", "done").stderr).not.toContain("policy");
  });

  test("a row from before efforts reads as unset: show prints -, the brief names the effort its skill and model give", () => {
    ok("agent", "a1", "--task", "T", "--milestone", "m1");

    const ledger = readJson(join(root, "state.json"));

    const agents = (asArray(ledger["agents"]) ?? []).map((a) => {
      const { effort: _effort, ...rest } = asObject(a) ?? {};

      return rest;
    });

    writeFileSync(join(root, "state.json"), JSON.stringify({ ...ledger, agents }));
    expect(ok("show").stdout).toContain("  agent a1               running  none            opus   -             0 tok");
    const briefed = fleet(["brief", root, "a1"], env).stderr;

    expect(briefed).toContain('spawn a1 on model: "opus", effort: "high" (run_in_background)');
    expect(briefed.split("\n")[0]).toBe(`Spawn with model: "opus", effort: "high" (a1's Agent call takes both: a fleet refuses a spawn without effort).`);
    expect(ok("agent", "a1", "--model", "sonnet").stderr).not.toContain("policy");
    expect(rows("agents")[0]).not.toHaveProperty("effort");
    ok("agent", "a1", "--effort", "medium");
    expect(Object.keys(rows("agents")[0] ?? {}).at(-1)).toBe("effort");
  });
});

describe("a roadblock changed to need the user (L8)", () => {
  test("names its decision, as a new one does", () => {
    ok("roadblock", "r1", "--title", "T", "--detail", "D", "--severity", "warning", "--needs", "coordinator");
    const ran = refused("roadblock", "r1", "--needs", "user");
    expect(ran.stderr).toContain("a roadblock that needs the user names what it asks: record the `decision` first, then pass --decision ID");
    expect(rows("roadblocks")[0]?.["needs"]).toBe("coordinator");
    ok("decision", "d1", ...CHOICE);
    ok("roadblock", "r1", "--needs", "user", "--decision", "d1");
    expect(rows("roadblocks")[0]?.["needs"]).toBe("user");
    expect(ok("roadblock", "r1", "--needs", "user", "--title", "T2").code).toBe(0);
  });
});

describe("a message a worker leaves unanswered (L1)", () => {
  const at = (minutes: number): string => `2026-01-05T09:${String(minutes).padStart(2, "0")}:00+00:00`;

  function watchAt(minutes: number) {
    const { proc, lines } = start(["chat", root, "watch", "--as", "coordinator", "--resume", "--once"], { ...env, FLEET_NOW: at(minutes), FLEET_CHECK_S: "0.2" });
    procs.push(proc);

    return { proc, next: () => lines.next() };
  }

  test("the coordinator's watch names it after ten minutes, once, and not once the worker answers", async () => {
    ok("agent", "a1", "--task", "T", "--milestone", "m1", "--name", "notes-impl");
    expect(fleet(["chat", root, "say", "--as", "coordinator", "@a1 rebase on main first"], env).code).toBe(0);

    const early = watchAt(9);
    await Bun.sleep(1500);
    expect(early.proc.exitCode).toBeNull();
    early.proc.kill();

    const due = watchAt(10);
    expect(await due.next()).toBe('! worker a1 (notes-impl) has not answered #1 from coordinator for 10 min: "@a1 rebase on main first". Forward it (SendMessage a1).\n');
    expect(await due.proc.exited).toBe(0);

    const told = watchAt(12);
    await Bun.sleep(1500);
    expect(told.proc.exitCode).toBeNull();
    told.proc.kill();

    expect(fleet(["chat", root, "say", "--as", "coordinator", "@a1 and run the tests"], env).code).toBe(0);
    expect(fleet(["chat", root, "say", "--as", "a1", "--re", "2", "on it"], { ...env, FLEET_NOW: at(5) }).code).toBe(0);
    const reply = watchAt(30);
    expect(await reply.next()).toBe("#3 a1 (notes-impl) -> user, coordinator: on it [re #2]\n");
    expect(await reply.proc.exited).toBe(0);
    const answered = watchAt(30);
    await Bun.sleep(1500);
    expect(answered.proc.exitCode).toBeNull();
    answered.proc.kill();
  }, 20_000);
});

describe("the landing queue of a manager", () => {
  let manager: string;

  function mgr(...args: string[]): Ran {
    return fleet(["state", manager, ...args, "--no-render"], env);
  }

  beforeEach(() => {
    manager = join(base, "manager");
    expect(mgr("init", "--role", "manager", "--project", "box", "--goal", "land").code).toBe(0);
  });

  test("init records the queue", () => {
    expect(rows("roadmap", manager)).toEqual([{ id: "landings", title: "Landings and deploys", steps: [] }]);
  });

  test("one landing has the turn: another is refused until it is done or given back", () => {
    expect(mgr("step", "l1", "--milestone", "landings", "--title", "infra: push", "--agent", "infra", "--status", "current").code).toBe(0);
    expect(mgr("step", "l2", "--milestone", "landings", "--title", "acme: push", "--agent", "acme").code).toBe(0);
    const ran = mgr("step", "l2", "--status", "current");
    expect(ran.code).toBe(1);
    expect(ran.stderr).toBe(
      "state: l1 (infra: push) has the turn: one landing at a time. Close it (`step l1 --status done`) or give it back (`step l1 --status pending`) first\n",
    );
    expect(mgr("step", "l1", "--status", "done").code).toBe(0);
    expect(mgr("step", "l2", "--status", "current").code).toBe(0);
  });
});

describe("fleet turn", () => {
  function serve(name: string, dir: string, role: string): void {
    mkdirSync(join(base, "registry"), { recursive: true });
    writeFileSync(
      join(base, "registry", `${name}.json`),
      JSON.stringify({ id: name, role, dir, url: "http://box:7420/", pid: process.pid, session: `${name}-session`, since: "2026-01-05T09:00:00+00:00" }),
    );
  }

  test("without a manager the turn is the fleet's", () => {
    const ran = fleet(["turn", root], env);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("no manager is served on this machine");
  });

  test("with a manager, only the fleet whose landing is current holds it; without DIR it finds the session's fleet", () => {
    const manager = join(base, "manager");
    expect(fleet(["state", manager, "init", "--role", "manager", "--project", "box", "--goal", "land", "--no-render"], env).code).toBe(0);
    serve("manager", manager, "manager");
    serve("acme", root, "coordinator");
    fleet(["state", manager, "step", "l1", "--milestone", "landings", "--title", "infra: push", "--agent", "infra", "--status", "current", "--no-render"], env);
    fleet(["state", manager, "step", "l2", "--milestone", "landings", "--title", "acme: push", "--agent", "acme", "--no-render"], env);
    const waiting = fleet(["turn", root], env);
    expect(waiting.code).toBe(1);
    expect(waiting.stderr).toContain("turn: acme does not hold the landing turn (l1 (infra: push) has it, infra's; yours, l2, waits in the queue)");
    expect(waiting.stderr).toContain("SendMessage manager-session");
    fleet(["state", manager, "step", "l1", "--status", "done", "--no-render"], env);
    fleet(["state", manager, "step", "l2", "--status", "current", "--no-render"], env);
    const holds = fleet(["turn"], env);
    expect(holds.code).toBe(0);
    expect(holds.stdout).toContain("acme holds the landing turn: l2 (acme: push)");
  });

  test("a landing recorded under the fleet's name in another case is still the fleet's", () => {
    const manager = join(base, "manager");
    expect(fleet(["state", manager, "init", "--role", "manager", "--project", "box", "--goal", "land", "--no-render"], env).code).toBe(0);
    serve("manager", manager, "manager");
    serve("acme", root, "coordinator");
    fleet(["state", manager, "step", "l1", "--milestone", "landings", "--title", "Acme: push", "--agent", "Acme", "--status", "current", "--no-render"], env);
    const holds = fleet(["turn", root], env);
    expect(holds.code).toBe(0);
    expect(holds.stdout).toContain("acme holds the landing turn: l1 (Acme: push)");
  });

  describe("with the manager moved to the cloud", () => {
    let manager: string;

    /** The seqs the host must record beside its exported state.json, a contract it does not meet yet (turn.ts): what
     * the cloud applied last, what the folder holds. */
    function seqs(applied: number, exported?: number): void {
      writeFileSync(join(manager, "applied.json"), JSON.stringify({ seq: applied }));

      if (exported !== undefined) writeFileSync(join(manager, "exported.json"), JSON.stringify({ seq: exported }));
    }

    beforeEach(() => {
      manager = join(base, "fleet", "manager");
      expect(fleet(["state", manager, "init", "--role", "manager", "--project", "box", "--goal", "land", "--no-render"], env).code).toBe(0);
      fleet(["state", manager, "step", "l1", "--milestone", "landings", "--title", "acme: push", "--agent", "acme", "--status", "current", "--no-render"], env);
      writeFileSync(join(manager, "cloud.json"), JSON.stringify({ fleet: "manager", cloud: "https://fleet.example.dev", since: "2026-01-05T08:00:00Z", host: "box" }));
      owner(process.pid, startedOf(process.pid) ?? "");
      serve("acme", root, "coordinator");
    });

    /** The office host's wake record of the manager's folder: the session process that last armed its watch. */
    function owner(session: number, started: string): void {
      writeFileSync(join(manager, "wakes.json"), JSON.stringify({ wakes: [], owner: { session, started } }));
    }

    /** Landing l1 of the manager's exported ledger with `status`, as the host would export it. */
    function landing(status: string): void {
      const state = readJson(join(manager, "state.json"));

      const roadmap = (asArray(state["roadmap"]) ?? []).map((m) => {
        const milestone = asObject(m) ?? {};
        const steps = (asArray(milestone["steps"]) ?? []).map((st) => ({ ...asObject(st), status }));

        return { ...milestone, steps };
      });

      writeFileSync(join(manager, "state.json"), JSON.stringify({ ...state, roadmap }));
    }

    /** The fleet `acme` moved to the cloud too: its folder, with no registry entry. */
    function movedAcme(): string {
      const acme = join(base, "fleet", "acme");
      mkdirSync(acme, { recursive: true });
      writeFileSync(join(acme, "state.json"), JSON.stringify({ project: "acme", role: "coordinator" }));
      writeFileSync(join(acme, "cloud.json"), JSON.stringify({ fleet: "acme" }));
      rmSync(join(base, "registry", "acme.json"));

      return acme;
    }

    test("the turn is read from the manager's exported ledger", () => {
      const holds = fleet(["turn", root], env);
      expect(holds.code, holds.stderr).toBe(0);
      expect(holds.stdout).toBe("acme holds the landing turn: l1 (acme: push). Land, then report the commit and the files that moved to the manager\n");
    });

    test("a manager whose ledger is not running is not present: the turn is the fleet's", () => {
      const state = readJson(join(manager, "state.json"));
      writeFileSync(join(manager, "state.json"), JSON.stringify({ ...state, status: "done" }));
      const ran = fleet(["turn", root], env);
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).toBe("the manager moved to the cloud is not present (its ledger is done): the turn is yours; land on your own word\n");
    });

    test("a running manager whose session closed is not present: the turn is the fleet's", () => {
      landing("pending");
      const gone = Bun.spawnSync(["true"]).pid;
      owner(gone, "1");
      const ran = fleet(["turn", root], env);
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).toBe("the manager moved to the cloud is not present (no session of its runs): the turn is yours; land on your own word\n");
      owner(process.pid, "0");
      expect(fleet(["turn", root], env).stdout).toContain("no session of its runs");
      rmSync(join(manager, "wakes.json"));
      expect(fleet(["turn", root], env).stdout).toContain("no session of its runs");
      expect(fleet(["fleets", "manager"], env).stderr).toContain("the manager moved to the cloud is not present (no session of its runs)");
    });

    test("a running manager whose watch records its live session is present", () => {
      rmSync(join(manager, "wakes.json"));
      writeFileSync(join(manager, "watch-manager.owner.pid"), JSON.stringify({ watch: 1, session: process.pid, started: startedOf(process.pid) }));
      const holds = fleet(["turn", root], env);
      expect(holds.code, holds.stderr).toBe(0);
      expect(holds.stdout).toContain("acme holds the landing turn: l1 (acme: push)");
      landing("pending");
      const none = fleet(["turn", root], env);
      expect(none.code).toBe(1);
      expect(none.stderr).toContain("acme does not hold the landing turn (no landing has the turn; yours, l1, waits in the queue). Ask the manager for it (SendMessage the session its greeting named)");
    });

    test("a fleet that moved too is found by its folder", () => {
      const holds = fleet(["turn", movedAcme()], env);
      expect(holds.code, holds.stderr).toBe(0);
      expect(holds.stdout).toContain("acme holds the landing turn: l1 (acme: push)");
    });

    test("without DIR, a moved fleet's session is found by $FLEET_DIR", () => {
      const acme = movedAcme();
      const lost = fleet(["turn"], env);
      expect(lost.stdout).toBe("this session serves no fleet: no landing turn to take\n");
      landing("pending");
      const waits = fleet(["turn"], { ...env, FLEET_DIR: acme });
      expect(waits.code).toBe(1);
      expect(waits.stderr).toContain("turn: acme does not hold the landing turn (no landing has the turn; yours, l1, waits in the queue)");
      landing("current");
      const holds = fleet(["turn"], { ...env, FLEET_DIR: acme });
      expect(holds.code, holds.stderr).toBe(0);
      expect(holds.stdout).toContain("acme holds the landing turn: l1 (acme: push)");
      expect(fleet(["turn"], { ...env, FLEET_DIR: manager }).stdout).toBe("this session serves no fleet: no landing turn to take\n");
    });

    test("an export at the cloud's last applied seq gives the turn at once", () => {
      seqs(9, 9);
      const holds = fleet(["turn", root], env);
      expect(holds.code, holds.stderr).toBe(0);
      expect(holds.stdout).toBe("acme holds the landing turn: l1 (acme: push). Land, then report the commit and the files that moved to the manager\n");
    });

    test("an export behind the cloud's last apply is waited for, then the turn is given", async () => {
      seqs(9, 7);
      const started = Date.now();
      const turn = fleetAsync(["turn", root], { ...env, FLEET_TURN_WAIT_S: "10" });
      await sleep(400);
      seqs(9, 9);
      const holds = await turn;
      expect(holds.code, holds.stderr).toBe(0);
      expect(holds.stdout).toContain("the manager's ledger here is behind the cloud (exported seq 7, applied seq 9): waiting up to 10 s for its export\n");
      expect(holds.stdout).toContain("acme holds the landing turn: l1 (acme: push)");
      expect(Date.now() - started).toBeLessThan(5000);
    }, 15_000);

    test("an export that stays behind is refused once the wait ends, naming the lag", async () => {
      seqs(9);
      const started = Date.now();
      const refused = await fleetAsync(["turn", root], { ...env, FLEET_TURN_WAIT_S: "1" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("the manager's ledger here is behind the cloud (exported seq none, applied seq 9): waiting up to 1 s for its export\n");
      expect(refused.stderr).toStartWith("turn: the manager's ledger here is still behind the cloud after 1 s (exported seq none, applied seq 9)");
      expect(refused.stderr).toContain("fleet-host@manager");
    }, 15_000);
  });
});

describe("fleet brief", () => {
  test("composes the worker's brief from its row, and refuses a worker the ledger does not have", () => {
    ok("agent", "a1", "--task", "write the schema", "--milestone", "m1", "--skill", "implement", "--lane", "src/a.ts", "--step", "s1", "--brief", "done when x.test.ts passes", "--model", "sonnet");
    const ran = fleet(["brief", root, "a1"], env);
    expect(ran.code).toBe(0);
    const lines = ran.stdout.split("\n");
    expect(lines[0]).toBe(`Read ${join(root, "brief.md")} first; your id is a1.`);
    expect(lines).toContain("Task: write the schema");
    expect(lines).toContain("Done when: x.test.ts passes");
    expect(ran.stdout).toMatch(/Skill: read \S+\/skills\/engineering\/implement\/SKILL\.md with the Read tool and follow it/);
    expect(lines).toContain("Lane: src/a.ts. You edit these; everything else is read-only.");
    expect(lines).toContain("Step: s1 (the schema), in milestone m1 (M).");
    expect(ran.stderr).toContain(`brief: a1 has a lane and no workspace: \`fleet ws ${root} add a1\``);
    expect(ran.stderr).toContain('spawn a1 on model: "sonnet", effort: "high" (run_in_background)');
    // the first line it prints: the Agent call's parameters, on stderr so the brief on stdout still opens with its own
    expect(ran.stderr.split("\n")[0]).toBe(`Spawn with model: "sonnet", effort: "high" (a1's Agent call takes both: a fleet refuses a spawn without effort).`);
    const missing = fleet(["brief", root, "a9"], env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("brief: no worker 'a9'");
    expect(missing.stderr).not.toContain("Spawn with");
  });

  test("a model-invoked skill is named for the Skill tool, and a recorded workspace is the worker's", () => {
    ok("agent", "a2", "--task", "tests first", "--milestone", "m1", "--skill", "tdd", "--lane", "src/");
    const state = readJson(join(root, "state.json"));
    writeFileSync(join(root, "state.json"), JSON.stringify({ ...state, workspaces: [{ id: "a2", agent: "a2", path: "/repo-a2", repo: "/repo", base: "x", added: "t", status: "active" }] }));
    const ran = fleet(["brief", root, "a2"], env);
    expect(ran.stdout).toContain('Skill: call the Skill tool with "tstack:tdd" and follow it.');
    expect(ran.stdout).toContain("Workspace: /repo-a2, yours alone. Work there only");
    expect(ran.stdout).toContain("End with your changes described there (`jj describe`, `jj split` by intent, `jj new` on top)");
    expect(ran.stderr).toContain("a2 has no completion criterion");
    expect(ran.stderr).not.toContain("no workspace");
  });
});

describe("fleet brief recalls memo notes for the coordinator", () => {
  const HEADING =
    "brief: memo recall on the task, candidates for you to paste into the brief if they fit; they are not facts (recall rarely abstains), and the worker sees none of them:";

  /** A stand-in `memo`: the program, and the arguments it was last run with. */
  interface StubMemo {
    readonly program: string;
    readonly args: () => string[];
  }

  /** A stand-in `memo` that keeps its arguments, one a line, beside itself and runs `body`. */
  function stubMemo(body: string): StubMemo {
    const dir = join(base, "memo-stub");
    mkdirSync(dir, { recursive: true });
    const program = join(dir, "memo");
    writeFileSync(program, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${join(dir, "args")}"\n${body}\n`, { mode: 0o755 });

    return { program, args: () => readFileSync(join(dir, "args"), "utf8").split("\n").slice(0, -1) };
  }

  function worker(task: string): void {
    ok("agent", "a3", "--task", task, "--milestone", "m1", "--skill", "tdd", "--lane", "src/", "--brief", "done when brief.test.ts passes");
    const state = readJson(join(root, "state.json"));
    writeFileSync(join(root, "state.json"), JSON.stringify({ ...state, workspaces: [{ id: "a3", agent: "a3", path: "/repo-a3", repo: "/the-repo", base: "x", added: "t", status: "active" }] }));
  }

  test("up to three hits go on stderr under a heading that calls them candidates, never into the brief", () => {
    const memo = stubMemo("echo '01AAA 2026-10-21 [gotcha] project:p: one hit'\necho '01BBB 2026-10-21 [fact] project:p: two hit'");
    worker("--all the recall words");
    const ran = fleet(["brief", root, "a3"], { ...env, FLEET_MEMO: memo.program });
    expect(ran.code).toBe(0);
    // the fleet's repo as memo's project, its live notes only, three at most, and the task's words after `--`, so a flag-like word stays a word
    expect(memo.args()).toEqual(["recall", "--cwd", "/the-repo", "--live", "--limit", "3", "--", "--all the recall words brief.test.ts passes"]);
    const lines = ran.stderr.split("\n");
    const at = lines.indexOf(HEADING);
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 3)).toEqual(["  01AAA 2026-10-21 [gotcha] project:p: one hit", "  01BBB 2026-10-21 [fact] project:p: two hit"]);
    expect(ran.stdout).not.toContain("one hit");
    expect(ran.stdout).not.toContain("memo");
  });

  test("with no hit the block is memo's nothing line", () => {
    const memo = stubMemo("echo \"memo: nothing on 'zz'; try \\`tape search <words>\\` (coordinator sessions only)\"");
    worker("zz");
    const ran = fleet(["brief", root, "a3"], { ...env, FLEET_MEMO: memo.program });
    const lines = ran.stderr.split("\n");
    expect(lines[lines.indexOf(HEADING) + 1]).toBe("  memo: nothing on 'zz'; try `tape search <words>` (coordinator sessions only)");
  });

  test("a missing memo, a failing one or a slow one costs the brief one skip line", () => {
    worker("anything");
    const missing = fleet(["brief", root, "a3"], env);
    expect(missing.code).toBe(0);
    expect(missing.stdout).toContain("Task: anything");
    expect(missing.stderr).not.toContain(HEADING);
    expect(missing.stderr).toContain(`brief: no memo notes recalled: ${join(base, "registry", "no-memo")} did not run (ENOENT)`);
    const failing = fleet(["brief", root, "a3"], { ...env, FLEET_MEMO: stubMemo("echo boom >&2; exit 3").program });
    expect(failing.stderr).toContain("brief: no memo notes recalled: memo recall exited 3");
    expect(failing.stderr).not.toContain(HEADING);
    const started = Date.now();
    const slow = fleet(["brief", root, "a3"], { ...env, FLEET_MEMO: stubMemo("exec sleep 10").program });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(slow.code).toBe(0);
    expect(slow.stderr).toContain("brief: no memo notes recalled: memo recall took over 2 s");
  });
});

describe("a done worker's workspace is pruned", () => {
  function withWorkspace(): void {
    const state = readJson(join(root, "state.json"));
    writeFileSync(join(root, "state.json"), JSON.stringify({ ...state, workspaces: [{ id: "a1", agent: "a1", path: "/repo-a1", repo: "/repo", base: "x", added: "t", status: "active" }] }));
  }

  test("every command says so while it is there, and a fleet set done names it", () => {
    ok("agent", "a1", "--task", "T", "--milestone", "m1");
    withWorkspace();
    expect(ok("event", "x").stderr).not.toContain("still there");
    const done = ok("agent", "a1", "--status", "done");
    // The warning names both ways out: prune it once integrated, or hand it to the next worker of the lane.
    expect(done.stderr).toContain(
      "state: a1's workspace a1 still there though its worker is done: bring its changes into the stack, then prune it " +
        "(`fleet ws <dir> prune`, a dry run, then --apply), or hand it to the next worker of its lane (`fleet ws <dir> add <next> --reuse a1`).",
    );
    expect(ok("set", "--status", "done").stderr).toContain("state: the fleet is done with workspace(s) a1 not pruned");
  });
});

describe("chat wait ends when the decision closes without an answer (open-21)", () => {
  test("a withdrawal while it waits ends the wait with how it closed", async () => {
    ok("decision", "d1", ...CHOICE);
    const { proc, lines } = start(["chat", root, "wait", "d1"], env);
    procs.push(proc);
    expect(await lines.quiet(600)).toBe(true);
    ok("decision", "d1", "--withdraw", "the worker found it in the ADR");
    expect(await lines.next(5000)).toBe("D1 is already withdrawn: the worker found it in the ADR\n");
    expect(await proc.exited).toBe(0);
  });
});
