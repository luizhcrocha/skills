/**
 * `fleet ws`: one jj workspace per worker, against throwaway jj repos. `add` makes it beside the repo and
 * records it; `list` says what each holds; `prune` deletes only what is recorded, known to jj as that
 * workspace, idle, and integrated, and refuses the rest by name.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { baseEnv, FLEET, fleet, readJson, tmp, type Environment } from "./support.ts";

let base: string;

let repo: string;

let dir: string;

let env: Environment;

/** Run jj in `at`; its stdout. */
function jj(at: string, ...args: string[]): string {
  const done = Bun.spawnSync(["jj", "-R", at, "--color=never", ...args], { stdout: "pipe", stderr: "pipe" });

  if (done.exitCode !== 0) throw new Error(`jj ${args.join(" ")}: ${done.stderr.toString()}`);

  return done.stdout.toString();
}

function state(...args: string[]): void {
  const ran = fleet(["state", dir, ...args, "--no-render"], env);

  expect(ran.code).toBe(0);
}

function ws(...args: string[]): ReturnType<typeof fleet> {
  return fleet(["ws", dir, ...args], env);
}

function workspaces(): JsonObject[] {
  return (asArray(readJson(join(dir, "state.json"))["workspaces"]) ?? []).flatMap((w) => {
    const o = asObject(w);

    return o === undefined ? [] : [o];
  });
}

/** In the workspace at `at`: write `file`, describe the change, start a new one on top. */
function work(at: string, file: string, message: string): void {
  writeFileSync(join(at, file), `${message}\n`);
  jj(at, "describe", "-m", message);
  jj(at, "new");
}

beforeEach(() => {
  base = tmp("fleet-ws-");
  repo = join(base, "repo");
  Bun.spawnSync(["jj", "git", "init", repo], { stdout: "ignore", stderr: "ignore" });
  writeFileSync(join(repo, "README"), "base\n");
  jj(repo, "describe", "-m", "base");
  jj(repo, "new");
  dir = join(base, "fleet");
  env = baseEnv(join(base, "registry"), { FLEET_NOW: "2026-01-05T09:00:00+00:00", TZ: "UTC" });
  state("init", "--project", "p", "--goal", "g");
  state("milestone", "m1", "--title", "M");
});

describe("fleet ws add", () => {
  test("makes <repo>-<name> on the base, records it for the worker and prints the path", () => {
    const ran = ws("add", "a1", "--repo", repo);
    expect(ran.code).toBe(0);
    const path = join(base, "repo-a1");
    expect(ran.stdout).toContain(`workspace a1 for a1 at ${path}, on `);
    expect(ran.stdout).toContain(`your working copy is ${path}`);
    expect(existsSync(join(path, "README"))).toBe(true);
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a1\ndefault\n");
    const baseChange = jj(repo, "log", "--no-graph", "-r", "@-", "-T", "change_id").trim();
    expect(workspaces()).toEqual([{ id: "a1", agent: "a1", path, repo, base: baseChange, added: "2026-01-05T09:00:00+00:00", status: "active", port: 5300 }]);
    expect(jj(repo, "log", "--no-graph", "-r", "a1@-", "-T", "change_id").trim()).toBe(baseChange);
    const events = asArray(readJson(join(dir, "state.json"))["events"]) ?? [];
    expect(asObject(events.at(-1))?.["text"]).toContain(`Workspace a1 for a1 at ${path}`);
  });

  test("-r and --agent, and what it refuses", () => {
    expect(ws("add", "lane", "-r", "root()", "--agent", "a7", "--repo", repo).code).toBe(0);
    expect(workspaces()[0]?.["agent"]).toBe("a7");
    expect(workspaces()[0]?.["base"]).toBe("z".repeat(32));
    const again = ws("add", "lane", "--repo", repo);
    expect([again.code, again.stderr]).toEqual([1, `ws: workspace lane is already at ${join(base, "repo-lane")}\n`]);
    expect(ws("add", "b", "-r", "all()", "--repo", repo).stderr).toContain("-r all() names 4 commit(s)");
    expect(ws("add", "default", "--repo", repo).stderr).toContain("not 'default'");
    expect(ws("add", "x y", "--repo", repo).code).toBe(1);
    mkdirSync(join(base, "repo-taken"));
    expect(ws("add", "taken", "--repo", repo).stderr).toBe(`ws: ${join(base, "repo-taken")} already exists\n`);
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(ws("add", "c", "--repo", plain).stderr).toContain("is not in a jj repo");
    expect(fleet(["ws", join(base, "nowhere"), "list"], env).stderr).toContain("no state.json in");
    expect(workspaces().length).toBe(1);
  });
});

describe("a dev-server port per worker", () => {
  test("each new workspace takes the next free port, from FLEET_PORT_BASE when it is set, and the brief names it", () => {
    state("agent", "a1", "--task", "T", "--milestone", "m1", "--lane", "src/a/**");
    expect(ws("add", "a1", "--repo", repo).stdout).toContain("its dev-server port is 5300");
    expect(ws("add", "a2", "--repo", repo).stdout).toContain("its dev-server port is 5301");
    expect(workspaces().map((w) => w["port"])).toEqual([5300, 5301]);
    const brief = fleet(["brief", dir, "a1"], env).stdout;
    expect(brief).toContain("Dev server: when you run one to check your work, run it on port 5300 and no other (Vite: `--port 5300 --strictPort`");
    env = { ...env, FLEET_PORT_BASE: "6100" };
    expect(ws("add", "a3", "--repo", repo).stdout).toContain("its dev-server port is 6100");
  });
});

describe("fleet ws list", () => {
  test("each workspace's tip, what it holds ahead of the stack, conflicts", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    ws("add", "a1", "--repo", repo);
    ws("add", "a2", "--repo", repo);
    const a1 = join(base, "repo-a1");
    work(a1, "one.txt", "a1: one");
    work(join(base, "repo-a2"), "README", "a2: rewrite");
    writeFileSync(join(repo, "README"), "stack\n");
    jj(repo, "describe", "-m", "stack: rewrite");
    jj(repo, "new");
    jj(repo, "rebase", "-s", "roots(::a2@ ~ ::default@)", "-d", "@-");
    const ran = ws("list");
    expect(ran.code).toBe(0);
    const lines = ran.stdout.split("\n");
    expect(lines[0]).toBe("workspaces, as each was last snapshotted:");
    expect(lines[1]).toBe(`  a1  worker a1 running  ${a1}`);
    expect(lines[2]).toMatch(/^ {4}@ \w+ \(empty\) \(no description\); 1 change\(s\) ahead of the stack: \w+ a1: one$/);
    expect(lines[3]).toBe(`  a2  worker a2 no row  ${join(base, "repo-a2")}`);
    expect(lines[4]).toMatch(/^ {4}@ \w+ .*, conflicted; 1 change\(s\) ahead of the stack: \w+ a2: rewrite$/);
  });

  test("nothing recorded", () => {
    expect(ws("list").stdout).toBe(`no workspace: \`fleet ws ${dir} add NAME\` makes one per worker\n`);
  });

  test("files a worker changed outside its lane are named", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "src/");
    ws("add", "a1", "--repo", repo);
    const a1 = join(base, "repo-a1");
    mkdirSync(join(a1, "src"));
    writeFileSync(join(a1, "src", "ok.ts"), "in the lane\n");
    work(a1, "README", "a1: strays");
    const ran = ws("list");
    expect(ran.stdout).toContain("    outside its lane (src/): README: stop it and handle these edits before anything else runs on them\n");
    expect(ran.stdout).not.toContain("src/ok.ts:");
  });
});

describe("a workspace for a worker the ledger has not recorded", () => {
  test("is made, with a warning: a worker is recorded before it is briefed and spawned", () => {
    const ran = ws("add", "a9", "--repo", repo);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toContain("ws: no worker row a9 yet: record it");
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    expect(ws("add", "a1", "--repo", repo).stderr).toBe("");
  });
});

/** Where two workers worked. */
interface Lanes {
  readonly done: string;
  readonly open: string;
}

describe("fleet ws prune", () => {
  /** Two finished workers' workspaces: a1's change integrated, a2's not. */
  function twoWorkers(): Lanes {
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    state("agent", "a2", "--task", "t", "--milestone", "m1");
    ws("add", "a1", "--repo", repo);
    ws("add", "a2", "--repo", repo);
    const done = join(base, "repo-a1");
    const open = join(base, "repo-a2");
    work(done, "one.txt", "a1: one");
    work(open, "two.txt", "a2: two");
    // integrate a1's change: before the default workspace's @
    jj(repo, "rebase", "-r", "a1@-", "-B", "@");
    state("agent", "a1", "--status", "done");
    state("agent", "a2", "--status", "done");

    return { done, open };
  }

  test("a dry run by default: says what would go and what stays, deletes nothing", () => {
    const { done, open } = twoWorkers();
    const ran = ws("prune");
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe(`would prune a1: forget the workspace and delete ${done}; its changes are in the stack\ndry run, nothing deleted: \`fleet ws ${dir} prune --apply\` does it\n`);
    expect(ran.stderr).toMatch(/^ws: kept a2: 1 change\(s\) not in the stack: \w+ a2: two\n$/);
    expect([existsSync(done), existsSync(open)]).toEqual([true, true]);
    expect(workspaces().map((w) => w["status"])).toEqual(["active", "active"]);
    expect(ws("prune", "--dry-run").stdout).toContain("would prune a1");
    expect(ws("prune", "--apply", "--dry-run").code).toBe(1);
  });

  test("--apply deletes the integrated one and refuses the unintegrated one, naming its change", () => {
    const { done, open } = twoWorkers();
    const ran = ws("prune", "--apply");
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe(`pruned a1: ${done} deleted\n`);
    expect(ran.stderr).toContain("ws: kept a2: 1 change(s) not in the stack");
    expect([existsSync(done), existsSync(open)]).toEqual([false, true]);
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a2\ndefault\n");
    expect(jj(repo, "log", "--no-graph", "-r", "description(substring:'a1: one') & ::@", "-T", "description")).toBe("a1: one\n");
    expect(workspaces().map((w) => [w["id"], w["status"], w["pruned"] ?? null])).toEqual([
      ["a1", "pruned", "2026-01-05T09:00:00+00:00"],
      ["a2", "active", null],
    ]);
    const events = asArray(readJson(join(dir, "state.json"))["events"]) ?? [];
    expect(asObject(events.at(-1))).toMatchObject({ agent: "a1", kind: "integrated" });
    expect(ws("list").stdout).not.toContain("a1");
    // integrate a2 too, then it goes
    jj(repo, "rebase", "-r", "a2@-", "-B", "@");
    expect(ws("prune", "--apply").stdout).toBe(`pruned a2: ${open} deleted\n`);
    expect(existsSync(open)).toBe(false);
  });

  test("a live worker's workspace stays, even when empty", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    ws("add", "a1", "--repo", repo);
    const ran = ws("prune", "--apply");
    expect([ran.code, ran.stderr]).toEqual([1, "ws: kept a1: its worker a1 is running\n"]);
    expect(existsSync(join(base, "repo-a1"))).toBe(true);
    state("agent", "a1", "--status", "done");
    expect(ws("prune", "--apply").code).toBe(0);
    expect(existsSync(join(base, "repo-a1"))).toBe(false);
  });

  test("files never snapshotted in a stale workspace keep it, as a change not in the stack", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "done");
    ws("add", "a1", "--repo", repo);
    const at = join(base, "repo-a1");
    work(at, "one.txt", "a1: one");
    jj(repo, "rebase", "-r", "a1@-", "-B", "@"); // a1's workspace is stale now
    writeFileSync(join(at, "late.txt"), "written after the last snapshot\n");
    const ran = ws("prune", "--apply");
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/^ws: kept a1: 1 change\(s\) not in the stack: \w+ \(no description\)\n$/);
    // updating the stale workspace moved the file into a copy of its change: kept in jj, and the workspace stays
    expect(jj(repo, "log", "--no-graph", "-r", 'files(root:"late.txt")', "-T", 'description ++ "|"')).toBe("|");
    expect(existsSync(join(at, "README"))).toBe(true);
  });

  test("never touches a directory it did not record, or one that is not that workspace", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "done");
    const byHand = join(base, "repo-byhand");
    jj(repo, "workspace", "add", byHand, "--name", "byhand");
    ws("add", "a1", "--repo", repo);
    // the recorded directory is replaced by something else: a folder that is no workspace
    const at = join(base, "repo-a1");
    jj(repo, "workspace", "forget", "a1");
    Bun.spawnSync(["rm", "-rf", at]);
    mkdirSync(at);
    writeFileSync(join(at, "precious"), "not jj's\n");
    const ran = ws("prune", "--apply");
    expect(ran.stderr).toBe(`ws: kept a1: ${at} is not jj workspace a1 of ${repo}; nothing there is touched\n`);
    expect(existsSync(join(at, "precious"))).toBe(true);
    expect(existsSync(join(byHand, "README"))).toBe(true);
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("byhand\ndefault\n");
  });

  test("a recorded workspace whose directory is gone is forgotten", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "done");
    ws("add", "a1", "--repo", repo);
    Bun.spawnSync(["rm", "-rf", join(base, "repo-a1")]);
    expect(ws("prune", "--apply").code).toBe(0);
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("default\n");
    expect(workspaces()[0]?.["status"]).toBe("pruned");
  });
});

/** The ids of the agents, changes and events a test reads. */
function lastEvent(): JsonObject | undefined {
  return asObject((asArray(readJson(join(dir, "state.json"))["events"]) ?? []).at(-1));
}

describe("fleet ws add --reuse: the next worker of a lane takes over its workspace", () => {
  test("a done worker's workspace is handed over: the row names the new worker, the handover is recorded, and it starts on a new change", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "src/");
    ws("add", "a1", "--repo", repo);
    const at = join(base, "repo-a1");
    mkdirSync(join(at, "src"));
    writeFileSync(join(at, "src", "x.ts"), "a1's\n");
    jj(at, "describe", "-m", "a1: x");
    // left described, with no `jj new` on top: the next worker must not amend it
    state("agent", "a1", "--status", "done");
    state("agent", "b1", "--task", "t2", "--milestone", "m1", "--lane", "src/");
    const ran = ws("add", "b1", "--reuse", "a1");
    expect(ran.code).toBe(0);
    expect(ran.stdout).toMatch(new RegExp(`^workspace a1 for b1 at ${at}, reused from a1, on \\w+ a1: x\\n`));
    expect(ran.stdout).toContain(`brief: your working copy is ${at};`);
    const [row] = workspaces();
    expect(row).toMatchObject({ id: "a1", agent: "b1", path: at, status: "active", handovers: [{ from: "a1", at: "2026-01-05T09:00:00+00:00" }] });
    expect(row?.["base"]).toBe(jj(repo, "log", "--no-graph", "-r", "description(exact:'a1: x\n')", "-T", "change_id").trim());
    // b1's @ is a new, empty change on top of what a1 left
    expect(jj(repo, "log", "--no-graph", "-r", "a1@", "-T", 'empty ++ "|" ++ description')).toBe("true|");
    expect(lastEvent()).toMatchObject({ agent: "b1", kind: "note" });
    expect(lastEvent()?.["text"]).toMatch(/^Workspace a1 handed from a1 \(done\) to b1 at /);
    // its brief names the workspace, and who had it
    const brief = fleet(["brief", dir, "b1"], env);
    expect(brief.stdout).toContain(`Workspace: ${at}, yours alone.`);
    expect(brief.stdout).toContain("It was a1's before you: what a1 left is under your @");
    expect(brief.stderr).not.toContain("no workspace");
    expect(fleet(["brief", dir, "a1"], env).stdout).not.toContain("Workspace:");
    // a1 being done no longer warns: the workspace is b1's now, and b1 runs
    const quiet = fleet(["state", dir, "event", "x", "--no-render"], env);
    expect(quiet.stderr).not.toContain("still there");
  });

  test("by its worker's id, and on -r BASE", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "stopped");
    ws("add", "lane-a", "--agent", "a1", "--repo", repo);
    state("agent", "b1", "--task", "t2", "--milestone", "m1");
    expect(ws("add", "b1", "--reuse", "a1", "-r", "root()").code).toBe(0);
    expect(workspaces()[0]).toMatchObject({ id: "lane-a", agent: "b1", base: "z".repeat(32) });
    expect(jj(repo, "log", "--no-graph", "-r", '"lane-a"@-', "-T", "change_id").trim()).toBe("z".repeat(32));
  });

  test("refused while its worker still works there, and what else it refuses", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    state("agent", "b1", "--task", "t2", "--milestone", "m1", "--status", "queued");
    ws("add", "a1", "--repo", repo);
    const running = ws("add", "b1", "--reuse", "a1");
    expect([running.code, running.stderr]).toEqual([
      1,
      "ws: workspace a1 is a1's, and a1 is running: a workspace changes hands once its worker is done or stopped, never while it works there\n",
    ]);
    state("agent", "a1", "--status", "blocked");
    expect(ws("add", "b1", "--reuse", "a1").stderr).toContain("a1 is blocked");
    expect(workspaces()[0]?.["agent"]).toBe("a1");
    expect(ws("add", "b1", "--reuse", "nope").stderr).toContain("ws: no active workspace nope");
    expect(ws("add", "a1", "--reuse", "a1").stderr).toBe("ws: workspace a1 is already a1's\n");
    expect(ws("add", "b1", "--reuse", "a1", "--repo", repo).stderr).toContain("--reuse takes the worker as NAME");
    expect(ws("add", "b1", "--reuse").code).toBe(1);
    state("agent", "a1", "--status", "done");
    ws("add", "b1", "--repo", repo);
    expect(ws("add", "b1", "--reuse", "a1").stderr).toContain("b1 already works in workspace b1");
  });

  test("a fresh workspace for a lane an idle workspace covers is made, with the warning that suggests reuse", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "src/**");
    ws("add", "a1", "--repo", repo);
    state("agent", "c1", "--task", "elsewhere", "--milestone", "m1", "--lane", "docs/");
    expect(ws("add", "c1", "--repo", repo).stderr).toBe("");
    state("agent", "b1", "--task", "t2", "--milestone", "m1", "--lane", "src/x.ts");
    // a1 still runs: nobody may take its workspace, so nothing is suggested
    expect(ws("add", "b1", "--repo", repo).stderr).toBe("");
    state("agent", "a1", "--status", "done");
    state("agent", "b2", "--task", "t3", "--milestone", "m1", "--lane", "src/y.ts");
    const ran = ws("add", "b2", "--repo", repo);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toBe(
      `ws: a1's workspace a1 covers b2's lane and nobody works in it (a1 done): reuse it: \`fleet ws ${dir} add b2 --reuse a1\` keeps its setup; ` +
        "a fresh one is for parallel work that could meet, a risky experiment, or a comparison\n",
    );
    expect(existsSync(join(base, "repo-b2"))).toBe(true);
  });
});

describe("a fleet whose workers share one working copy (set --workspaces shared)", () => {
  beforeEach(() => {
    state("set", "--workspaces", "shared");
  });

  test("ws add makes no workspace: it names the shared working copy", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "src/");
    const ran = ws("add", "a1", "--repo", repo);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain(`shared: a1 gets no workspace of its own: this fleet's workers share one working copy, ${repo}`);
    expect(ran.stdout).toContain(`brief: your working copy is ${repo}, shared with the fleet's other workers;`);
    expect(existsSync(join(base, "repo-a1"))).toBe(false);
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("default\n");
    expect(readJson(join(dir, "state.json"))["workspaces"]).toBeUndefined();
    expect(ws("add", "a1", "--reuse", "x").stderr).toContain("there is no workspace to hand over");
    expect(ws("list").stdout).toContain("this fleet's workers share one working copy");
  });

  test("the brief gives the shared working copy's rules: no history moves, nothing described, the coordinator splits by lane", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "src/");
    state("agent", "r1", "--task", "read", "--milestone", "m1");
    const ran = Bun.spawnSync([FLEET, "brief", dir, "a1"], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    const out = ran.stdout.toString();
    expect(out).toContain(`Workspace: ${repo}, the fleet's one working copy, shared with the other workers as they work.`);
    expect(out).toContain("Move no history and describe nothing: no `jj new`, `jj edit`, `jj rebase`, `jj describe`");
    expect(out).toContain("The coordinator splits the working copy by each worker's lane paths into one described change per worker");
    expect(out).not.toContain("yours alone");
    expect(ran.stderr.toString()).not.toContain("no workspace");
    // a worker with no lane edits nothing: no workspace line
    expect(fleet(["brief", dir, "r1"], env).stdout).not.toContain("Workspace:");
  });

  test("a running worker whose lane meets another live one's is refused, not warned", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "src/**");
    const refused = fleet(["state", dir, "agent", "a2", "--task", "t", "--milestone", "m1", "--lane", "src/x.ts", "--no-render"], env);
    expect([refused.code, refused.stdout]).toEqual([1, ""]);
    expect(refused.stderr).toContain("state: a2's lane overlaps a1's (running: src/x.ts), and this fleet's workers share one working copy");
    state("agent", "a2", "--task", "t", "--milestone", "m1", "--lane", "src/x.ts", "--status", "queued");
    expect(fleet(["state", dir, "agent", "a2", "--status", "running", "--no-render"], env).code).toBe(1);
    state("agent", "a1", "--status", "done");
    expect(fleet(["state", dir, "agent", "a2", "--status", "running", "--no-render"], env).code).toBe(0);
  });

  test("integrating is a jj split per worker: each lane's files become one described change", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "src/");
    state("agent", "a2", "--task", "t", "--milestone", "m1", "--lane", "docs/*.md");
    // both write into the one working copy at once
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "src", "a.ts"), "a1\n");
    writeFileSync(join(repo, "docs", "b.md"), "a2\n");
    writeFileSync(join(repo, "stray.txt"), "nobody's\n");
    const early = ws("split", "a1", "-m", "a1: the parser", "--repo", repo);
    expect([early.code, early.stderr]).toEqual([1, "ws: a1 is running: split its files out once it is done\n"]);
    state("agent", "a1", "--status", "done");
    state("agent", "a2", "--status", "done");
    const one = ws("split", "a1", "-m", "a1: the parser", "--repo", repo);
    expect(one.code).toBe(0);
    expect(one.stdout).toMatch(/^split a1: \w+ a1: the parser: src\/a\.ts\n$/);
    expect(lastEvent()).toMatchObject({ agent: "a1", kind: "integrated" });
    expect(ws("split", "a2", "-m", "a2: the docs", "--repo", repo).code).toBe(0);
    const files = 'description.first_line() ++ ":" ++ self.diff().files().map(|f| f.path()).join(",") ++ "\\n"';
    expect(jj(repo, "log", "--no-graph", "-r", "@-- | @- | @", "-T", files)).toBe(":stray.txt\na2: the docs:docs/b.md\na1: the parser:src/a.ts\n");
    expect(ws("split", "a1", "-m", "again", "--repo", repo).stderr).toBe("ws: nothing in the shared working copy's @ is in a1's lane (src/)\n");
    expect(readJson(join(dir, "state.json"))["workspaces"]).toBeUndefined();
  });

  test("split is a shared fleet's: an isolated one integrates by rebasing", () => {
    state("set", "--workspaces", "isolated");
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "src/", "--status", "done");
    expect(ws("split", "a1", "-m", "x", "--repo", repo).stderr).toContain("split integrates a fleet whose workers share one working copy");
    expect(ws("split", "a1", "--repo", repo).code).toBe(1);
  });
});

describe("prune is part of integrating", () => {
  test("after the worker's change is rebased into the stack and it is done, prune --apply removes its workspace and the warning stops", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "one.txt");
    ws("add", "a1", "--repo", repo);
    const at = join(base, "repo-a1");
    work(at, "one.txt", "a1: one");
    // Integrate: rebase its changes under the coordinator's @, the gates pass, mark it done.
    jj(repo, "rebase", "-r", "(::a1@ ~ ::@) ~ a1@", "-B", "@");
    const done = fleet(["state", dir, "agent", "a1", "--status", "done", "--no-render"], env);
    expect(done.stderr).toContain("then prune it (`fleet ws <dir> prune`, a dry run, then --apply), or hand it to the next worker of its lane (`fleet ws <dir> add <next> --reuse a1`)");
    expect(ws("prune", "--apply").stdout).toBe(`pruned a1: ${at} deleted\n`);
    expect(existsSync(at)).toBe(false);
    expect(fleet(["state", dir, "event", "x", "--no-render"], env).stderr).not.toContain("still there");
    expect(jj(repo, "log", "--no-graph", "-r", "@-", "-T", "description")).toBe("a1: one\n");
  });
});
