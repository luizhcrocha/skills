/**
 * `fleet ws`: one jj workspace per worker, against throwaway jj repos. `add` makes it beside the repo and
 * records it; `list` says what each holds; `prune` deletes only what is recorded, known to jj as that
 * workspace, idle, and integrated, and refuses the rest by name.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { baseEnv, fleet, readJson, tmp, type Environment } from "./support.ts";

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
    expect(workspaces()).toEqual([{ id: "a1", agent: "a1", path, repo, base: baseChange, added: "2026-01-05T09:00:00+00:00", status: "active" }]);
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
