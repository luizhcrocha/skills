/**
 * `fleet ws`: one jj workspace per worker, against throwaway jj repos. `add` makes it beside the repo and
 * records it; `list` says what each holds; `prune` deletes only what is recorded, known to jj as that
 * workspace, idle, and integrated, and refuses the rest by name.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { wsId } from "../src/ws/hook.ts";
import { toTrash } from "../src/ws/trash.ts";
import { baseEnv, FLEET, fleet, fleetAsync, readJson, tmp, type Environment } from "./support.ts";

// Each test runs jj as a subprocess, up to 51 times (with the fleet CLI's own calls). 2026-10-16, 32 cores at load 48:
// 567 calls, median 48 ms, p90 299 ms, the slowest 1.1 s, and a test up to 3.9 s; bun's default 5 s failed 2 of 43 at
// load 15. 51 calls at 1.1 s each is 56 s.
setDefaultTimeout(60_000);

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

/** The repo each test starts from, made once: a jj repo holds no path of its own, so a copy is a repo of its own. */
let template: string;

beforeAll(() => {
  template = join(tmp("fleet-ws-template-"), "repo");
  Bun.spawnSync(["jj", "git", "init", template], { stdout: "ignore", stderr: "ignore" });
  writeFileSync(join(template, "README"), "base\n");
  jj(template, "describe", "-m", "base");
  jj(template, "new");
});

beforeEach(() => {
  base = tmp("fleet-ws-");
  repo = join(base, "repo");
  cpSync(template, repo, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
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
    expect(workspaces()).toEqual([{ id: "a1", ws_id: expect.stringMatching(/^repo-a1-[0-9a-f]{6}$/), agent: "a1", path, repo, base: baseChange, added: "2026-01-05T09:00:00+00:00", status: "active", port: 5300 }]);
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
    expect(ran.stdout).toBe(`would prune a1: forget the workspace and move ${done} to the trash; its changes are in the stack\ndry run, nothing moved: \`fleet ws ${dir} prune --apply\` does it\n`);
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
    expect(ran.stdout).toBe(`pruned a1: ${done} is in the trash, repo/a1@20260105T090000Z: \`fleet ws restore repo/a1@20260105T090000Z\` brings it back\n`);
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
    expect(ws("prune", "--apply").stdout).toContain(`pruned a2: ${open} is in the trash, repo/a2@20260105T090000Z`);
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

describe("the trash: a pruned workspace is moved, not deleted, until gc", () => {
  const ID = "repo/a1@20260105T090000Z";

  function trash(): string {
    return join(base, "registry", "trash");
  }

  /** A done worker a1 whose change is integrated, and whose workspace holds an ignored file and a scratch note. */
  function integrated(): string {
    writeFileSync(join(repo, ".gitignore"), ".dev.vars\nnotes/\n");
    jj(repo, "describe", "-m", "ignore");
    jj(repo, "new");
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    ws("add", "a1", "--repo", repo);
    const at = join(base, "repo-a1");
    work(at, "one.txt", "a1: one");
    writeFileSync(join(at, ".dev.vars"), "TOKEN=only here\n");
    mkdirSync(join(at, "notes"));
    writeFileSync(join(at, "notes", "scratch.md"), "half a thought\n");
    jj(repo, "rebase", "-r", "a1@-", "-B", "@");
    state("agent", "a1", "--status", "done");

    return at;
  }

  test("prune --apply moves the folder, ignored files and all, to the trash beside a note, and forgets the workspace", () => {
    const at = integrated();
    const tip = jj(repo, "log", "--no-graph", "-r", "a1@", "-T", 'commit_id ++ "|" ++ parents.map(|c| c.commit_id()).join(",")').split("|");
    const ran = ws("prune", "--apply");
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toBe(`pruned a1: ${at} is in the trash, ${ID}: \`fleet ws restore ${ID}\` brings it back\n`);
    expect(existsSync(at)).toBe(false);
    const entry = join(trash(), "repo", "a1@20260105T090000Z");
    expect(readFileSync(join(entry, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(readFileSync(join(entry, "notes", "scratch.md"), "utf8")).toBe("half a thought\n");
    expect(readJson(`${entry}.json`)).toEqual({
      repo,
      workspace: "a1",
      path: at,
      commit: tip[0] ?? "",
      parents: [tip[1] ?? ""],
      trashed: "2026-01-05T09:00:00+00:00",
      fleet: dir,
      why: "fleet ws prune --apply: its worker a1 is done and its changes are in the stack",
    });
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("default\n");
    expect(asObject(lastEvent())?.["text"]).toBe(`Workspace a1 pruned: its changes are in the stack; ${at} moved to the trash (${ID}).`);
  });

  test("restore brings the folder and its ignored files back to its old path, and jj knows it as the workspace again", () => {
    const at = integrated();
    const parent = jj(repo, "log", "--no-graph", "-r", "a1@-", "-T", "commit_id");
    expect(ws("prune", "--apply").code).toBe(0);
    const ran = fleet(["ws", "restore", ID], env);
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toBe(`restored ${ID} to ${at}: jj workspace a1 again, on ${parent.slice(0, 12)}\n`);
    expect(readFileSync(join(at, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(readFileSync(join(at, "notes", "scratch.md"), "utf8")).toBe("half a thought\n");
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a1\ndefault\n");
    expect(jj(repo, "workspace", "root", "--name", "a1").trim()).toBe(at);
    expect(jj(at, "log", "--no-graph", "-r", "@", "-T", 'parents.map(|c| c.commit_id()).join(",") ++ "|" ++ empty')).toBe(`${parent}|true`);
    expect(jj(at, "status")).toContain("The working copy has no changes.");
    expect(readdirSync(join(trash(), "repo"))).toEqual([]);
  });

  /** Rewrite the trashed a1's note with `parents`, as a hand-edited note or a parent jj lost would leave it. */
  function noteParents(parents: readonly string[]): void {
    const note = join(trash(), "repo", "a1@20260105T090000Z.json");
    writeFileSync(note, JSON.stringify({ ...readJson(note), parents }));
  }

  test("restore on a noted parent jj no longer has starts on the default workspace's parents, and says the parent is gone", () => {
    const at = integrated();
    expect(ws("prune", "--apply").code).toBe(0);
    noteParents(["0123456789abcdef0123456789abcdef01234567"]);
    const ran = fleet(["ws", "restore", ID], env);
    expect([ran.code, ran.stderr, ran.stdout]).toEqual([0, "", `restored ${ID} to ${at}: jj workspace a1 again, on the default workspace's parents (its noted parent 0123456789ab is gone)\n`]);
    expect(readFileSync(join(at, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a1\ndefault\n");
    expect(jj(repo, "workspace", "root", "--name", "a1").trim()).toBe(at);
    expect(jj(at, "log", "--no-graph", "-r", "@-", "-T", "commit_id")).toBe(jj(repo, "log", "--no-graph", "-r", "@-", "-T", "commit_id"));
    expect(readdirSync(join(trash(), "repo"))).toEqual([]);
  });

  test("a restore jj cannot add leaves no workspace behind and brings the folder back as plain files, with jj's error", () => {
    const at = integrated();
    expect(ws("prune", "--apply").code).toBe(0);
    noteParents(["x("]);
    const ran = fleet(["ws", "restore", ID], env);
    expect([ran.code, ran.stderr, ran.stdout]).toEqual([
      1,
      "",
      `restored ${ID} to ${at}, as plain files: jj could not add it as workspace a1 (Error: Failed to parse revset: Syntax error); its .jj is stale, so jj there fails until the folder is a workspace again\n`,
    ]);
    expect(readFileSync(join(at, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("default\n");
    expect(existsSync(`${at}-restored`)).toBe(false);
    expect(readdirSync(join(trash(), "repo"))).toEqual([]);
  });

  test("restore never deletes an old .jj that holds a repo's store, as a hand-written note pointing at a repo would leave", () => {
    const other = join(base, "other");
    Bun.spawnSync(["jj", "git", "init", other], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(other, "kept.txt"), "mine\n");
    const entry = join(trash(), "repo", "other@20260105T090000Z");
    mkdirSync(join(trash(), "repo"), { recursive: true });
    Bun.spawnSync(["mv", other, entry]);
    const at = join(base, "repo-other");
    writeFileSync(`${entry}.json`, JSON.stringify({ repo, workspace: "other", path: at, parents: [] }));
    const ran = fleet(["ws", "restore", "repo/other@20260105T090000Z"], env);
    expect([ran.code, ran.stderr, ran.stdout]).toEqual([
      1,
      "",
      `restored repo/other@20260105T090000Z to ${at}: jj workspace other again, on the default workspace's parents\nws: kept ${entry}.stale-jj: its repo is a directory, a repo's own store, so restore does not delete it\n`,
    ]);
    expect(existsSync(join(`${entry}.stale-jj`, "repo", "store"))).toBe(true);
    expect(readFileSync(join(at, "kept.txt"), "utf8")).toBe("mine\n");
  });

  test("restore to a path that is taken goes beside it, and says so", () => {
    const at = integrated();
    ws("prune", "--apply");
    mkdirSync(at);
    writeFileSync(join(at, "someone else's"), "x\n");
    const ran = fleet(["ws", "restore", ID], env);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain(`restored ${ID} to ${at}-restored (${at} is taken): jj workspace a1 again`);
    expect(readFileSync(join(`${at}-restored`, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(existsSync(join(at, "someone else's"))).toBe(true);
    expect(jj(repo, "workspace", "root", "--name", "a1").trim()).toBe(`${at}-restored`);
    expect(fleet(["ws", "restore", "repo/nothing@20260105T090000Z"], env).stderr).toContain("ws: no trash entry repo/nothing@20260105T090000Z");
  });

  test("trash lists each entry with its age, size and note; gc deletes only those past the age, and a dry run touches nothing", () => {
    integrated();
    ws("prune", "--apply");
    env = { ...env, FLEET_NOW: "2026-01-10T09:00:00+00:00" };
    state("agent", "a2", "--task", "t", "--milestone", "m1");
    ws("add", "a2", "--repo", repo);
    state("agent", "a2", "--status", "done");
    ws("prune", "--apply");
    env = { ...env, FLEET_NOW: "2026-01-13T10:00:00+00:00" };
    const listed = fleet(["ws", "trash"], env);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(new RegExp(`^${ID}  8d 1h  \\d+ KB  a1 of ${repo}, fleet ${dir}: fleet ws prune --apply: its worker a1 is done`, "m"));
    expect(listed.stdout).toMatch(/^repo\/a2@20260110T090000Z {2}3d 1h {2}\d+ KB {2}a2 of /m);

    const dry = fleet(["ws", "gc", "--dry-run"], env);
    expect([dry.code, dry.stdout]).toEqual([0, `would delete ${ID} (8d 1h old)\ndry run, nothing deleted; 1 entry younger than 7 days kept\n`]);
    expect(existsSync(join(trash(), "repo", "a1@20260105T090000Z"))).toBe(true);

    const gone = fleet(["ws", "gc"], env);
    expect([gone.code, gone.stdout]).toEqual([0, `deleted ${ID} (8d 1h old)\n1 entry younger than 7 days kept\n`]);
    expect(readdirSync(join(trash(), "repo")).sort()).toEqual(["a2@20260110T090000Z", "a2@20260110T090000Z.json"]);
    expect(fleet(["ws", "gc", "--older-than", "3"], env).stdout).toContain("deleted repo/a2@20260110T090000Z (3d 1h old)");
    expect(readdirSync(join(trash(), "repo"))).toEqual([]);
    expect(fleet(["ws", "gc", "--older-than", "x"], env).code).toBe(1);
  });

  test("a trash on another filesystem refuses the move and leaves the folder and no note", () => {
    // The shelf is `<trash>/<repo's basename>`: with the trash at / and a repo named proc, the shelf is /proc,
    // which exists (mkdir is a no-op) and is another filesystem than the temp dir.
    const path = join(base, "proc-w");
    mkdirSync(path);
    writeFileSync(join(path, ".dev.vars"), "SECRET\n");
    expect(statSync("/proc").dev).not.toBe(statSync(path).dev);
    const note = { repo: join(base, "proc"), workspace: "w", path, commit: null, parents: [], trashed: "", fleet: "", why: "" };
    expect(toTrash("/", note, new Date("2026-01-01T00:00:00Z"))).toEqual({ refused: `could not move ${path} to the trash (/ is on another filesystem, and the trash only renames); nothing is deleted` });
    expect(readFileSync(join(path, ".dev.vars"), "utf8")).toBe("SECRET\n");
    expect(existsSync("/proc/w@20260101T000000Z.json")).toBe(false);
  });

  test("gc goes by the stamp in an entry's name: an entry without one is kept and named, a note with no folder is named, a restore's stale .jj is no entry", () => {
    const shelf = join(trash(), "repo");

    const entry = (name: string, note?: string): void => {
      mkdirSync(join(shelf, name), { recursive: true });
      writeFileSync(join(shelf, name, "f"), "x");

      if (note !== undefined) writeFileSync(join(shelf, `${name}.json`), note);
    };

    entry("a@20260101T000000Z", JSON.stringify({ repo, workspace: "a", path: join(base, "repo-a") })); // exactly 7 days old
    entry("b@20251231T235959Z"); // 7 days and 1 s, no note
    entry("c@20251201T000000Z", "{not json");
    entry("f@20260107T120000Z", JSON.stringify({ repo, workspace: "f", path: join(base, "repo-f") })); // 12 hours old
    entry("d@20251201T000000Z.stale-jj"); // a restore that stopped half way left it
    entry("e");
    writeFileSync(join(shelf, "g@20251101T000000Z.json"), "{}");
    env = { ...env, FLEET_NOW: "2026-01-08T00:00:00+00:00" };
    const extras = `1 entry with no stamp in its name kept: repo/e\na note with no folder, kept: ${join(shelf, "g@20251101T000000Z.json")}\n`;

    expect(fleet(["ws", "trash"], env).stdout).not.toContain("stale-jj");
    const dry = fleet(["ws", "gc", "--older-than", "1", "--dry-run"], env);
    expect([dry.code, dry.stdout]).toEqual([
      0,
      `would delete repo/c@20251201T000000Z (38d 0h old)\nwould delete repo/b@20251231T235959Z (7d 0h old)\nwould delete repo/a@20260101T000000Z (7d 0h old)\ndry run, nothing deleted; 1 entry younger than 1 day kept\n${extras}`,
    ]);
    const gone = fleet(["ws", "gc"], env);
    expect([gone.code, gone.stdout]).toEqual([0, `deleted repo/c@20251201T000000Z (38d 0h old)\ndeleted repo/b@20251231T235959Z (7d 0h old)\n2 entries younger than 7 days kept\n${extras}`]);
    expect(readdirSync(shelf).sort()).toEqual(["a@20260101T000000Z", "a@20260101T000000Z.json", "d@20251201T000000Z.stale-jj", "e", "f@20260107T120000Z", "f@20260107T120000Z.json", "g@20251101T000000Z.json"]);
  });

  test("a trash the folder cannot be moved into refuses the prune for that workspace and keeps the folder", () => {
    const at = integrated();
    mkdirSync(join(trash(), "repo"), { recursive: true });
    chmodSync(join(trash(), "repo"), 0o555);
    const ran = ws("prune", "--apply");
    chmodSync(join(trash(), "repo"), 0o755);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(new RegExp(`^ws: kept a1: could not move ${at} to the trash \\(.*EACCES.*\\); nothing is deleted\\n$`));
    expect(readFileSync(join(at, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a1\ndefault\n");
    expect(workspaces()[0]?.["status"]).toBe("active");
    expect(readdirSync(join(trash(), "repo"))).toEqual([]);
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
    expect(ws("prune", "--apply").stdout).toContain(`pruned a1: ${at} is in the trash`);
    expect(existsSync(at)).toBe(false);
    expect(fleet(["state", dir, "event", "x", "--no-render"], env).stderr).not.toContain("still there");
    expect(jj(repo, "log", "--no-graph", "-r", "@-", "-T", "description")).toBe("a1: one\n");
  });
});

describe("the ws-add hook: the repo prepares each new workspace", () => {
  /** The repo's own hook, `.fleet/ws-add`, as this shell script, made executable. */
  function hook(script: string): string {
    const at = join(repo, ".fleet", "ws-add");
    mkdirSync(join(repo, ".fleet"), { recursive: true });
    writeFileSync(at, `#!/bin/sh\n${script}\n`);
    chmodSync(at, 0o755);

    return at;
  }

  /** `fleet ws DIR ARGS`, which waits on the hook it runs. */
  function wsHook(...args: string[]): Promise<ReturnType<typeof fleet>> {
    return fleetAsync(["ws", dir, ...args], env);
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);

      return true;
    } catch {
      return false;
    }
  }

  /** The workspace row's `hook`. */
  function ran(id: string): JsonObject | undefined {
    return asObject(workspaces().find((w) => w["id"] === id)?.["hook"]);
  }

  test("present: run in the new workspace with it and the main checkout, its output under a header, its exit recorded", async () => {
    writeFileSync(join(repo, ".gitignore"), ".prepared\n");
    jj(repo, "describe", "-m", "ignore");
    jj(repo, "new");
    hook('echo "preparing $1 from $2 in $(pwd -P)"; echo "a warning" >&2; touch "$1/.prepared"');
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    const made = await wsHook("add", "a1", "--repo", repo);
    const path = join(base, "repo-a1");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain(`--- .fleet/ws-add ${path} ${repo} (at most 100 s) ---\npreparing ${path} from ${repo} in ${path}\na warning\n--- .fleet/ws-add exited 0 in `);
    expect(made.stdout).toContain(`your working copy is ${path}`);
    expect(made.stderr).toBe("");
    expect(existsSync(join(path, ".prepared"))).toBe(true);
    expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add", exit: 0, at: "2026-01-05T09:00:00+00:00" });
    expect(ran("a1")?.["timed_out"]).toBeUndefined();
    expect(lastEvent()?.["text"]).toMatch(/^Workspace a1's hook ran: \.fleet\/ws-add exited 0 in [\d.]+ s\.$/);
  });

  test("absent: nothing runs and nothing is recorded", async () => {
    const made = await wsHook("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stdout).not.toContain("---");
    expect(made.stderr).not.toContain("hook");
    expect(ran("a1")).toBeUndefined();
  });

  test("failing: a warning, never a failure of ws add; the exit is recorded", async () => {
    hook('echo "no venv for you" >&2; exit 3');
    const made = await wsHook("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("no venv for you\n--- .fleet/ws-add exited 3 in ");
    expect(made.stderr).toMatch(/^ws: warning: \.fleet\/ws-add exited 3 in [\d.]+ s; workspace a1 is made, but not prepared: .*\(fix .*\.fleet\/ws-add, or run it by hand\)\n/);
    expect(existsSync(join(base, "repo-a1", "README"))).toBe(true);
    expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add", exit: 3 });
  });

  test("timing out: killed with everything it started after --hook-timeout, recorded as timed out", async () => {
    hook('sleep 30 & echo $! > "$1/.child"; echo started; sleep 30');
    const started = Date.now();
    const made = await wsHook("add", "a1", "--repo", repo, "--hook-timeout", "1");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("(at most 1 s) ---\nstarted\n--- .fleet/ws-add timed out after 1 s and was killed ---\n");
    expect(made.stderr).toContain("ws: warning: .fleet/ws-add timed out after 1 s and was killed; workspace a1 is made");
    expect(ran("a1")).toMatchObject({ exit: null, timed_out: true });
    const child = Number(readFileSync(join(base, "repo-a1", ".child"), "utf8"));
    expect(() => process.kill(child, 0)).toThrow();
    expect((await wsHook("add", "a2", "--repo", repo, "--hook-timeout", "soon")).stderr).toContain("--hook-timeout takes the seconds");
    expect((await wsHook("add", "a2", "--repo", repo, "--hook-timeout")).code).toBe(1);
  });

  test("a hook that ignores SIGTERM and never ends is killed with its group at the timeout, 2 s after the SIGTERM", async () => {
    hook('trap "" TERM; echo $$ > "$1/.pid"; echo started; while :; do sleep 1; done');
    const started = Date.now();
    const made = await wsHook("add", "a1", "--repo", repo, "--hook-timeout", "1");
    const took = Date.now() - started;
    const pid = Number(readFileSync(join(base, "repo-a1", ".pid"), "utf8"));
    expect(alive(pid)).toBe(false);
    expect(took).toBeGreaterThanOrEqual(2900);
    expect(took).toBeLessThan(8000);
    expect(made.stdout).toContain("started\n--- .fleet/ws-add timed out after 1 s and was killed ---\n");
    expect(ran("a1")).toMatchObject({ exit: null, timed_out: true });
  }, 20_000);

  test("a hook that ends by itself leaves nothing running: what it started in the background dies with its group", async () => {
    hook('sleep 300 & echo $! > "$1/.child"; echo started');
    const made = await wsHook("add", "a1", "--repo", repo, "--hook-timeout", "30");
    expect(made.stdout).toContain("--- .fleet/ws-add exited 0 in ");
    expect(alive(Number(readFileSync(join(base, "repo-a1", ".child"), "utf8")))).toBe(false);
  });

  test("a hook that ends by itself before its time is not recorded as timed out", async () => {
    hook("sleep 0.2");
    const made = await wsHook("add", "a1", "--repo", repo, "--hook-timeout", "5");
    expect(made.stdout).toContain("--- .fleet/ws-add exited 0 in ");
    expect(ran("a1")?.["timed_out"]).toBeUndefined();
  });

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    test(`${signal} to ws add during the hook stops the hook's group, removes its temp dir, records it, and ends ws add`, async () => {
      hook('echo $$ > "$1/.pid"; sleep 30 & echo $! > "$1/.child"; wait');
      const temp = join(base, "tmp");
      mkdirSync(temp);
      const child = Bun.spawn([FLEET, "ws", dir, "add", "a1", "--repo", repo], { env: { ...env, FLEET_NO_FORWARD: "1", TMPDIR: temp }, stdout: "pipe", stderr: "pipe" });
      const pidFile = join(base, "repo-a1", ".child");
      const until = Date.now() + 15_000;

      while (!(existsSync(pidFile) && /^\d+\n$/.test(readFileSync(pidFile, "utf8"))) && Date.now() < until) await Bun.sleep(50);
      expect(existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "no .child file after 15 s").toMatch(/^\d+\n$/);
      const pid = Number(readFileSync(join(base, "repo-a1", ".pid"), "utf8"));
      const sleeper = Number(readFileSync(pidFile, "utf8"));
      child.kill(signal);
      const code = await child.exited;
      const stdout = await new Response(child.stdout).text();
      const stopped = Date.now() + 5000;

      while ((alive(pid) || alive(sleeper)) && Date.now() < stopped) await Bun.sleep(50);
      expect(alive(pid)).toBe(false);
      expect(alive(sleeper)).toBe(false);
      expect(readdirSync(temp)).toEqual([]);
      expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add", exit: null, interrupted: signal });
      expect(stdout).toContain("--- .fleet/ws-add was stopped after ");
      expect(code).toBe(128 + osConstants.signals[signal]);
    }, 30_000);
  }

  test("a hook that cannot start (a #! line naming a missing interpreter) says why, and records exit null", async () => {
    const at = join(repo, ".fleet", "ws-add");
    mkdirSync(join(repo, ".fleet"), { recursive: true });
    writeFileSync(at, "#!/nonexistent/interp\necho hi\n");
    chmodSync(at, 0o755);
    const made = await wsHook("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stdout).not.toContain("undefined");
    expect(made.stdout).toMatch(/--- \.fleet\/ws-add could not start: .*ENOENT.* \(a missing program, or a #! line that names one\) ---\n/);
    expect(made.stderr).toContain("ws: warning: .fleet/ws-add could not start: ");
    expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add", exit: null });
    expect(String(ran("a1")?.["error"])).toContain("ENOENT");
  });

  test("a hook that leaves files in the workspace's @ is warned about, by name", async () => {
    hook('echo x > "$1/junk.txt"; mkdir -p "$1/cache"; echo y > "$1/cache/env"');
    const made = await wsHook("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stderr).toContain("ws: warning: .fleet/ws-add left files in workspace a1's @, which jj now tracks there: cache/env, junk.txt. A hook writes only ignored paths");
  });

  test("--reuse: run in the reused workspace, which is its source too", async () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "done");
    await wsHook("add", "a1", "--repo", repo);
    hook('echo "again $1 from $2"');
    state("agent", "b1", "--task", "t2", "--milestone", "m1");
    const made = await wsHook("add", "b1", "--reuse", "a1");
    const path = join(base, "repo-a1");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain(`again ${path} from ${path}\n--- .fleet/ws-add exited 0 in `);
    expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add", exit: 0 });
    expect(lastEvent()).toMatchObject({ agent: "b1", kind: "note" });
  });

  test("never run from outside the repo, nor when it is not executable", async () => {
    const elsewhere = join(base, "outside.sh");
    writeFileSync(elsewhere, `#!/bin/sh\ntouch "$1/.ran"\n`);
    chmodSync(elsewhere, 0o755);
    mkdirSync(join(repo, ".fleet"));
    symlinkSync(elsewhere, join(repo, ".fleet", "ws-add"));
    const made = await wsHook("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stderr).toContain(`ws: ${join(repo, ".fleet", "ws-add")} resolves outside the repo (${repo}): not run\n`);
    expect(existsSync(join(base, "repo-a1", ".ran"))).toBe(false);
    expect(ran("a1")).toBeUndefined();
    rmSync(join(repo, ".fleet", "ws-add"));
    writeFileSync(join(repo, ".fleet", "ws-add"), "#!/bin/sh\nexit 0\n");
    expect((await wsHook("add", "a2", "--repo", repo)).stderr).toContain("is not an executable file: not run");
  });

  describe("a devenv repo with no hook of its own: devenv-run --prepare", () => {
    let bin: string;

    beforeEach(() => {
      writeFileSync(join(repo, "devenv.nix"), "{ ... }: { }\n");
      jj(repo, "describe", "-m", "devenv");
      jj(repo, "new");
      bin = join(base, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "devenv-run"), '#!/bin/sh\necho "devenv-run $* in $(pwd -P)"\n');
      chmodSync(join(bin, "devenv-run"), 0o755);
    });

    test("runs in the new workspace when devenv-run is on PATH", async () => {
      env = { ...env, PATH: `${bin}:${env["PATH"] ?? ""}` };
      const made = await wsHook("add", "a1", "--repo", repo);
      const path = join(base, "repo-a1");
      expect(made.code).toBe(0);
      expect(made.stdout).toContain(`--- devenv-run --prepare (at most 100 s) ---\ndevenv-run --prepare in ${path}\n--- devenv-run --prepare exited 0 in `);
      expect(ran("a1")).toMatchObject({ command: "devenv-run --prepare", exit: 0 });
    });

    test("skipped with a one-line note when devenv-run is not on PATH", async () => {
      env = { ...env, PATH: join(base, "empty") };
      const made = await wsHook("add", "a1", "--repo", repo);
      expect(made.code).toBe(0);
      expect(made.stderr).toContain("ws: a devenv repo, and devenv-run is not on PATH: the workspace's devenv env is not prepared\n");
      expect(made.stdout).not.toContain("---");
      expect(ran("a1")).toBeUndefined();
    });

    test("the repo's own hook replaces it", async () => {
      env = { ...env, PATH: `${bin}:${env["PATH"] ?? ""}` };
      hook('echo "the repo\'s own"');
      const made = await wsHook("add", "a1", "--repo", repo);
      expect(made.stdout).toContain("the repo's own\n");
      expect(made.stdout).not.toContain("devenv-run");
      expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add" });
    });
  });
});

describe("lifecycle hooks: pre-add gates add, post-add only warns, pre-remove gates the move to the trash", () => {
  /** The repo's `.fleet/NAME`, as this shell script, made executable. */
  function hookFile(name: string, script: string): void {
    mkdirSync(join(repo, ".fleet"), { recursive: true });
    writeFileSync(join(repo, ".fleet", name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(repo, ".fleet", name), 0o755);
  }

  function wsAsync(...args: string[]): Promise<ReturnType<typeof fleet>> {
    return fleetAsync(["ws", dir, ...args], env);
  }

  function row(id: string): JsonObject | undefined {
    return workspaces().find((w) => w["id"] === id);
  }

  function names(): string {
    return jj(repo, "workspace", "list", "-T", 'name ++ "\\n"');
  }

  function trashed(): string[] {
    const at = join(base, "registry", "trash", "repo");

    return existsSync(at) ? readdirSync(at).sort() : [];
  }

  /** A log outside the repo the hooks append to, so they leave no file in a workspace. */
  function log(): string {
    return join(base, "hooks.log");
  }

  function logged(): string {
    return existsSync(log()) ? readFileSync(log(), "utf8") : "";
  }

  /** A shell line that runs `fleet ARGS` as a process of its own in this test's environment (a hook gets fleet's
   * caller's environment, not the test's), as a concurrent command would. */
  function fleetLine(...args: string[]): string {
    const unset = Object.keys(process.env).filter((k) => !(k in env)).map((k) => `-u ${k}`);
    const set = Object.entries(env).filter(([k, v]) => process.env[k] !== v).map(([k, v]) => `${k}='${v}'`);

    return `env ${[...unset, ...set].join(" ")} "${FLEET}" ${args.map((a) => `'${a}'`).join(" ")} >/dev/null 2>&1`;
  }

  /** The repo's pre-add check, which runs `line` the first time it runs and passes every time. */
  function preAddOnce(line: string): void {
    const marker = join(base, "pre-add-ran");
    hookFile("ws-pre-add", `[ -e "${marker}" ] || { touch "${marker}"; ${line}; }\nexit 0`);
  }

  /** a1 done, its workspace made; b1 recorded, to take it over. */
  async function handable(): Promise<string> {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "done");
    expect((await wsAsync("add", "a1", "--repo", repo)).code).toBe(0);
    state("agent", "b1", "--task", "t2", "--milestone", "m1");

    return jj(repo, "log", "--no-graph", "-r", "a1@", "-T", "change_id");
  }

  /** a1's workspace, its change in the stack, its worker done: prune's own rules let it go. `.stopped` is ignored. */
  async function integrated(): Promise<string> {
    writeFileSync(join(repo, ".gitignore"), ".stopped\n");
    jj(repo, "describe", "-m", "ignore");
    jj(repo, "new");
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    expect((await wsAsync("add", "a1", "--repo", repo)).code).toBe(0);
    const at = join(base, "repo-a1");
    work(at, "one.txt", "a1: one");
    jj(repo, "rebase", "-r", "a1@-", "-B", "@");
    state("agent", "a1", "--status", "done");

    return at;
  }

  test("pre-add refusing makes nothing: no folder, no jj workspace, no row, and post-add never runs", async () => {
    hookFile("ws-pre-add", 'echo "disk is full"; exit 4');
    hookFile("ws-add", `echo post >> "${log()}"`);
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    const path = join(base, "repo-a1");
    const made = await wsAsync("add", "a1", "--repo", repo);
    expect(made.code).toBe(1);
    expect(made.stdout).toContain(`--- .fleet/ws-pre-add ${path} ${repo} (at most 100 s) ---\ndisk is full\n--- .fleet/ws-pre-add exited 4 in `);
    expect(made.stderr).toMatch(/^ws: \.fleet\/ws-pre-add refused the add: \.fleet\/ws-pre-add exited 4 in [\d.]+ s; no workspace is made\n$/);
    expect(existsSync(path)).toBe(false);
    expect(names()).toBe("default\n");
    expect(workspaces()).toEqual([]);
    expect(logged()).toBe("");
    expect(lastEvent()?.["text"]).toMatch(/^Workspace a1 not added: \.fleet\/ws-pre-add exited 4 in [\d.]+ s\.$/);
  });

  test("pre-add passing, then post-add: once each, in that order, the check in the source and the hook in the workspace; both runs on the row", async () => {
    hookFile("ws-pre-add", `echo "pre $(pwd -P)" >> "${log()}"`);
    hookFile("ws-add", `echo "post $(pwd -P)" >> "${log()}"`);
    const made = await wsAsync("add", "a1", "--repo", repo);
    const path = join(base, "repo-a1");
    expect(made.code).toBe(0);
    expect(logged()).toBe(`pre ${repo}\npost ${path}\n`);
    expect(row("a1")?.["pre_add_hook"]).toMatchObject({ command: ".fleet/ws-pre-add", exit: 0, at: "2026-01-05T09:00:00+00:00" });
    expect(row("a1")?.["hook"]).toMatchObject({ command: ".fleet/ws-add", exit: 0 });
  });

  test("post-add failing after pre-add passed keeps the workspace: a warning, and add exits 0", async () => {
    hookFile("ws-pre-add", "exit 0");
    hookFile("ws-add", "exit 5");
    const made = await wsAsync("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stderr).toContain("ws: warning: .fleet/ws-add exited 5 in");
    expect(existsSync(join(base, "repo-a1", "README"))).toBe(true);
    expect(row("a1")).toMatchObject({ status: "active", hook: { exit: 5 }, pre_add_hook: { exit: 0 } });
  });

  test("pre-add refusing a --reuse hands nothing over: the workspace stays its last holder's, on the same change", async () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "done");
    expect((await wsAsync("add", "a1", "--repo", repo)).code).toBe(0);
    const path = join(base, "repo-a1");
    work(path, "one.txt", "a1: one");
    const tip = jj(repo, "log", "--no-graph", "-r", "a1@", "-T", "change_id");
    hookFile("ws-pre-add", `echo "pre $(pwd -P) $1 $2" >> "${log()}"; exit 1`);
    state("agent", "b1", "--task", "t2", "--milestone", "m1");
    const made = await wsAsync("add", "b1", "--reuse", "a1");
    expect(made.code).toBe(1);
    expect(made.stderr).toContain("ws: .fleet/ws-pre-add refused the add: .fleet/ws-pre-add exited 1 in");
    expect(logged()).toBe(`pre ${path} ${path} ${path}\n`);
    expect(row("a1")).toMatchObject({ agent: "a1", pre_add_hook: { exit: 1 } });
    expect(row("a1")?.["handovers"]).toBeUndefined();
    expect(jj(repo, "log", "--no-graph", "-r", "a1@", "-T", "change_id")).toBe(tip);
  });

  test("--reuse refuses when the workspace changed hands during the pre-add check: one handover, not two", async () => {
    await handable();
    preAddOnce(fleetLine("ws", dir, "add", "c1", "--reuse", "a1"));
    const made = await wsAsync("add", "b1", "--reuse", "a1");
    expect([made.code, made.stderr]).toEqual([1, "ws: workspace a1 changed hands during the pre-add check: it is c1's now; nothing is handed over\n"]);
    expect(row("a1")).toMatchObject({ agent: "c1", handovers: [{ from: "a1" }] });
    expect(asArray(row("a1")?.["handovers"])?.length).toBe(1);
  });

  test("--reuse refuses when the last holder went back to work during the pre-add check", async () => {
    const tip = await handable();
    preAddOnce(fleetLine("state", dir, "agent", "a1", "--status", "running", "--no-render"));
    const made = await wsAsync("add", "b1", "--reuse", "a1");
    expect([made.code, made.stderr]).toEqual([1, "ws: a1 is running again since the pre-add check began: workspace a1 stays a1's; nothing is handed over\n"]);
    expect(row("a1")?.["agent"]).toBe("a1");
    expect(row("a1")?.["handovers"]).toBeUndefined();
    expect(jj(repo, "log", "--no-graph", "-r", "a1@", "-T", "change_id")).toBe(tip);
  });

  test("--reuse refuses when the worker got a workspace of its own during the pre-add check", async () => {
    const tip = await handable();
    preAddOnce(fleetLine("ws", dir, "add", "b1", "--repo", repo));
    const made = await wsAsync("add", "b1", "--reuse", "a1");
    expect([made.code, made.stderr]).toEqual([1, `ws: b1 got workspace b1 (${join(base, "repo-b1")}) during the pre-add check; a worker holds one workspace: nothing is handed over\n`]);
    expect(row("a1")?.["agent"]).toBe("a1");
    expect(row("b1")?.["agent"]).toBe("b1");
    expect(jj(repo, "log", "--no-graph", "-r", "a1@", "-T", "change_id")).toBe(tip);
  });

  test("a fresh add refuses when its dev-server port was taken during the pre-add check, and makes nothing", async () => {
    preAddOnce(fleetLine("ws", dir, "add", "a2", "--repo", repo));
    const made = await wsAsync("add", "a1", "--repo", repo);
    expect([made.code, made.stderr]).toEqual([1, "ws: dev-server port 5300 was taken during the pre-add check (5301 is free now); no workspace is made: run add again\n"]);
    expect(existsSync(join(base, "repo-a1"))).toBe(false);
    expect(names()).toBe("a2\ndefault\n");
    expect(workspaces().map((w) => [w["id"], w["port"]])).toEqual([["a2", 5300]]);
  });

  test("a fresh add goes ahead when a lower port is freed during the pre-add check: only its own port being taken refuses", async () => {
    state("agent", "a2", "--task", "t", "--milestone", "m1");
    expect((await wsAsync("add", "a2", "--repo", repo)).code).toBe(0);
    state("agent", "a2", "--status", "done");
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    preAddOnce(fleetLine("ws", dir, "prune", "--apply"));
    const made = await wsAsync("add", "a1", "--repo", repo);
    expect([made.code, made.stderr]).toEqual([0, ""]);
    expect(names()).toBe("a1\ndefault\n");
    expect(workspaces().map((w) => [w["id"], w["status"], w["port"]])).toEqual([["a2", "pruned", 5300], ["a1", "active", 5301]]);
  });

  test("a pre-add check that is there but not executable refuses the add: a check that did not run never passes", async () => {
    mkdirSync(join(repo, ".fleet"));
    writeFileSync(join(repo, ".fleet", "ws-pre-add"), "#!/bin/sh\nexit 0\n");
    const made = await wsAsync("add", "a1", "--repo", repo);
    expect(made.code).toBe(1);
    expect(made.stderr).toContain("is not an executable file: not run (`chmod +x` it); no workspace is made");
    expect(existsSync(join(base, "repo-a1"))).toBe(false);
  });

  test("a pre-add check that runs out of time is killed and refuses the add", async () => {
    hookFile("ws-pre-add", "echo started; sleep 30");
    const started = Date.now();
    const made = await wsAsync("add", "a1", "--repo", repo, "--hook-timeout", "1");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(made.code).toBe(1);
    expect(made.stdout).toContain("(at most 1 s) ---\nstarted\n--- .fleet/ws-pre-add timed out after 1 s and was killed ---\n");
    expect(made.stderr).toContain("ws: .fleet/ws-pre-add refused the add: .fleet/ws-pre-add timed out after 1 s and was killed; no workspace is made");
    expect(existsSync(join(base, "repo-a1"))).toBe(false);
    expect(names()).toBe("default\n");
  });

  test("pre-remove failing keeps the workspace out of the trash: folder, jj workspace and row stay, and prune says why", async () => {
    const at = await integrated();
    hookFile("ws-pre-remove", 'echo "the dev server will not stop"; exit 2');
    const kept = await wsAsync("prune", "--apply");
    expect(kept.code).toBe(1);
    expect(kept.stdout).toContain(`--- .fleet/ws-pre-remove ${at} (at most 100 s) ---\nthe dev server will not stop\n--- .fleet/ws-pre-remove exited 2 in `);
    expect(kept.stderr).toMatch(/^ws: kept a1: \.fleet\/ws-pre-remove exited 2 in [\d.]+ s; nothing is moved or deleted\n$/);
    expect(existsSync(join(at, ".jj", "repo"))).toBe(true);
    expect(trashed()).toEqual([]);
    expect(names()).toBe("a1\ndefault\n");
    expect(row("a1")).toMatchObject({ status: "active", pre_remove_hook: { command: ".fleet/ws-pre-remove", exit: 2 } });
    expect(lastEvent()?.["text"]).toMatch(/^Workspace a1 kept: \.fleet\/ws-pre-remove exited 2 in [\d.]+ s\.$/);
    // fixed, it runs in the workspace before the folder moves: what it wrote there is in the trash
    hookFile("ws-pre-remove", 'touch "$(pwd -P)/.stopped"');
    const gone = await wsAsync("prune", "--apply");
    expect([gone.code, gone.stderr]).toEqual([0, ""]);
    expect(trashed()).toEqual(["a1@20260105T090000Z", "a1@20260105T090000Z.json"]);
    expect(existsSync(join(base, "registry", "trash", "repo", "a1@20260105T090000Z", ".stopped"))).toBe(true);
    expect(row("a1")).toMatchObject({ status: "pruned", pre_remove_hook: { exit: 0 } });
  });

  test("a pre-remove hook that leaves a change in the workspace keeps it: prune checks again after the hook", async () => {
    const at = await integrated();
    hookFile("ws-pre-remove", 'echo x > "$FLEET_WS_PATH/left.txt"');
    const kept = await wsAsync("prune", "--apply");
    expect(kept.code).toBe(1);
    expect(kept.stderr).toContain("ws: kept a1: after .fleet/ws-pre-remove, 1 change(s) not in the stack");
    expect(existsSync(join(at, "left.txt"))).toBe(true);
    expect(trashed()).toEqual([]);
  });

  test("a worker that went back to work during the pre-remove hook keeps its workspace: the check after the hook reads the ledger as it is now", async () => {
    const at = await integrated();
    hookFile("ws-pre-remove", fleetLine("state", dir, "agent", "a1", "--status", "running", "--no-render"));
    const kept = await wsAsync("prune", "--apply");
    expect(kept.code).toBe(1);
    expect(kept.stderr).toBe("ws: kept a1: after .fleet/ws-pre-remove, its worker a1 is running\n");
    expect(existsSync(join(at, ".jj", "repo"))).toBe(true);
    expect(trashed()).toEqual([]);
    expect(row("a1")).toMatchObject({ status: "active", pre_remove_hook: { exit: 0 } });
  });

  test("a workspace handed over during the pre-remove hook stays with its new worker: the check after the hook reads who holds it now", async () => {
    const at = await integrated();
    state("agent", "b1", "--task", "t2", "--milestone", "m1", "--status", "running");
    hookFile("ws-pre-remove", fleetLine("ws", dir, "add", "b1", "--reuse", "a1"));
    const kept = await wsAsync("prune", "--apply");
    expect(kept.code).toBe(1);
    expect(kept.stderr).toBe("ws: kept a1: after .fleet/ws-pre-remove, it was handed over to b1\n");
    expect(existsSync(join(at, ".jj", "repo"))).toBe(true);
    expect(names()).toBe("a1\ndefault\n");
    expect(trashed()).toEqual([]);
    expect(row("a1")).toMatchObject({ status: "active", agent: "b1", pre_remove_hook: { exit: 0 } });
  });

  test("a workspace with no hook of its own, handed over during an earlier workspace's pre-remove hook, stays with its new worker", async () => {
    const repoY = join(base, "repoy");
    Bun.spawnSync(["jj", "git", "init", repoY], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(repoY, "README"), "base\n");
    jj(repoY, "describe", "-m", "base");
    jj(repoY, "new");
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    state("agent", "a2", "--task", "t", "--milestone", "m1");
    expect((await wsAsync("add", "a1", "--repo", repo)).code).toBe(0);
    expect((await wsAsync("add", "a2", "--repo", repoY)).code).toBe(0);
    state("agent", "a1", "--status", "done");
    state("agent", "a2", "--status", "done");
    state("agent", "b1", "--task", "t2", "--milestone", "m1", "--status", "running");
    hookFile("ws-pre-remove", fleetLine("ws", dir, "add", "b1", "--reuse", "a2"));
    const ran = await wsAsync("prune", "--apply");
    expect(ran.code).toBe(1);
    expect(ran.stdout).toContain("pruned a1:");
    expect(ran.stderr).toBe("ws: kept a2: after a1's .fleet/ws-pre-remove, it was handed over to b1\n");
    expect(existsSync(join(base, "repoy-a2", ".jj", "repo"))).toBe(true);
    expect(jj(repoY, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a2\ndefault\n");
    expect(workspaces().map((w) => [w["id"], w["agent"], w["status"]])).toEqual([["a1", "a1", "pruned"], ["a2", "b1", "active"]]);
  });

  test("a pre-remove hook that runs out of time is killed and keeps the workspace; a dry run runs no hook", async () => {
    const at = await integrated();
    hookFile("ws-pre-remove", `echo ran >> "${log()}"; sleep 30`);
    expect((await wsAsync("prune")).code).toBe(0);
    expect(logged()).toBe("");
    expect((await wsAsync("prune", "--apply", "--hook-timeout", "soon")).stderr).toContain("--hook-timeout takes the seconds");
    const started = Date.now();
    const kept = await wsAsync("prune", "--apply", "--hook-timeout", "1");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(kept.code).toBe(1);
    expect(kept.stderr).toContain("ws: kept a1: .fleet/ws-pre-remove timed out after 1 s and was killed; nothing is moved or deleted");
    expect(existsSync(at)).toBe(true);
    expect(row("a1")).toMatchObject({ status: "active", pre_remove_hook: { exit: null, timed_out: true } });
  });

  test("--hook-timeout bounds all of prune's hooks together: a workspace whose hook gets no time left is kept, its hook not run", async () => {
    for (const id of ["a1", "a2", "a3"]) {
      state("agent", id, "--task", "t", "--milestone", "m1");
      expect((await wsAsync("add", id, "--repo", repo)).code).toBe(0);
      state("agent", id, "--status", "done");
    }

    hookFile("ws-pre-remove", `echo "$FLEET_WS_NAME" >> "${log()}"; [ "$FLEET_WS_NAME" != a2 ] || sleep 30`);
    const started = Date.now();
    const ran = await wsAsync("prune", "--apply", "--hook-timeout", "2");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(ran.code).toBe(1);
    expect(logged()).toBe("a1\na2\n");
    expect(ran.stdout).toContain("pruned a1:");
    expect(ran.stderr).toContain("ws: kept a2: .fleet/ws-pre-remove timed out after ");
    expect(ran.stderr).toContain("ws: kept a3: prune's hooks ran out of their 2 s (--hook-timeout) before its .fleet/ws-pre-remove ran; nothing is moved or deleted\n");
    expect(existsSync(join(base, "repo-a3"))).toBe(true);
    expect(row("a3")).toMatchObject({ status: "active" });
    expect(row("a3")?.["pre_remove_hook"]).toBeUndefined();
  });

  test("every hook gets the same environment, and the row records the workspace's stable id", async () => {
    const line = `echo "$FLEET_EVENT|$FLEET_WS_ID|$FLEET_WS_NAME|$FLEET_WS_PATH|$FLEET_WS_PORT|$FLEET_REPO|$FLEET_FLEET" >> "${log()}"`;
    hookFile("ws-pre-add", line);
    hookFile("ws-add", line);
    hookFile("ws-pre-remove", line);
    const at = await integrated();
    const id = row("a1")?.["ws_id"];
    expect(id).toMatch(/^repo-a1-[0-9a-f]{6}$/);
    expect((await wsAsync("prune", "--apply")).code).toBe(0);
    const tail = `${String(id)}|a1|${at}|5300|${repo}|${dir}`;
    expect(logged()).toBe(`pre-add|${tail}\npost-add|${tail}\npre-remove|${tail}\n`);
  });

  test("a workspace's id is <repo basename>-<name>-<6 hex of sha256 of the repo's real path, NUL, the name>, lower-cased, any other character than a-z, 0-9 or '-' made '-', no leading '-': a compose project name, and names of one spelling but case or punctuation never share one", () => {
    expect(wsId("/nonexistent/fleet-ws-id/Skills", "A1")).toBe("skills-a1-3a1ab7");
    expect(wsId("/nonexistent/fleet-ws-id/Skills", "a1")).toBe("skills-a1-c6af6f");
    expect(wsId("/nonexistent/fleet-ws-id/Skills", "a.1")).toBe("skills-a-1-a2e391");
    expect(wsId("/nonexistent/fleet-ws-id/Skills", "a_1")).toBe("skills-a-1-37ed5d");
    expect(wsId("/nonexistent/fleet-ws-id/.My.Repo", "a1")).toBe("my-repo-a1-49157e");
    const link = join(base, "link");
    symlinkSync(repo, link);
    expect(wsId(link, "a1")).toBe(wsId(repo, "a1"));
  });
});

describe("idle workspaces are pruned at the end of a fleet", () => {
  /** N workers, each with a workspace, done; a1's change integrated, a2's not. */
  function finished(n: number): void {
    for (let i = 1; i <= n; i += 1) {
      state("agent", `a${String(i)}`, "--task", "t", "--milestone", "m1");
      ws("add", `a${String(i)}`, "--repo", repo);
    }

    work(join(base, "repo-a1"), "one.txt", "a1: one");
    work(join(base, "repo-a2"), "two.txt", "a2: two");
    jj(repo, "rebase", "-r", "a1@-", "-B", "@");

    for (let i = 1; i <= n; i += 1) state("agent", `a${String(i)}`, "--status", i === n ? "stopped" : "done");
  }

  test("every state command warns past four idle workspaces, naming prune --apply; four, or live ones, do not", () => {
    finished(4);
    const four = fleet(["state", dir, "event", "x", "--no-render"], env);
    expect(four.stderr).not.toContain("idle workspaces");
    state("agent", "a5", "--task", "t", "--milestone", "m1");
    ws("add", "a5", "--repo", repo);
    expect(fleet(["state", dir, "event", "x", "--no-render"], env).stderr).not.toContain("idle workspaces");
    state("agent", "a5", "--status", "stopped");
    const five = fleet(["state", dir, "event", "x", "--no-render"], env);
    expect(five.stderr).toContain(
      "state: 5 idle workspaces (a1, a2, a3, a4, a5), more than 4: their workers are no longer at work. `fleet ws <dir> prune --apply` removes each whose changes are in the stack",
    );
    // one handed to a running worker is that worker's, not idle
    state("agent", "b1", "--task", "t", "--milestone", "m1");
    expect(ws("add", "b1", "--reuse", "a5").code).toBe(0);
    expect(fleet(["state", dir, "event", "x", "--no-render"], env).stderr).not.toContain("idle workspaces");
  });

  test("serve --stop and set --status done print what prune would remove, what it keeps and why, and the command", () => {
    finished(3);
    const stopped = fleet(["serve", dir, "--stop"], env);
    expect(stopped.code).toBe(0);
    const lines = stopped.stdout.split("\n");
    expect(lines[0]).toBe(`${dir} was not being served`);
    expect(lines[1]).toBe(`ws: prune would remove a1 (${join(base, "repo-a1")}), a3 (${join(base, "repo-a3")})`);
    expect(lines[2]).toMatch(/^ws: prune keeps a2: 1 change\(s\) not in the stack: \w+ a2: two$/);
    expect(lines[3]).toBe(`ws: \`fleet ws ${dir} prune --apply\` removes them`);
    expect([existsSync(join(base, "repo-a1")), existsSync(join(base, "repo-a3"))]).toEqual([true, true]);
    const done = fleet(["state", dir, "set", "--status", "done", "--no-render"], env);
    expect(done.stderr).toContain(`ws: prune would remove a1 (${join(base, "repo-a1")}), a3 (${join(base, "repo-a3")})\n`);
    expect(done.stderr).toContain(`ws: \`fleet ws ${dir} prune --apply\` removes them\n`);
    expect(fleet(["state", dir, "event", "x", "--no-render"], env).stderr).not.toContain("prune would remove");
  });

  test("a fleet with no workspace says nothing of prune", () => {
    expect(fleet(["serve", dir, "--stop"], env).stdout).toBe(`${dir} was not being served\n`);
  });
});

describe("fleet ws DIR trash NAME --card ID: one workspace prune keeps, trashed on a permission card for that exact call", () => {
  const trash = (): string => join(base, "registry", "trash");
  const names = (): string => jj(repo, "--ignore-working-copy", "workspace", "list", "-T", 'name ++ "\\n"');
  /** The command as the CLI prints it, which a permission card's call must be. */
  const call = (name: string, id: string): string => `fleet ws ${dir} trash ${name} --card ${id}`;

  const only = (name: string, id: string): string =>
    `only a permission card whose call is exactly \`${call(name, id)}\`, decided allow-once or allow-kind, moves a workspace prune keeps`;

  /** Luiz's answer on the page: the CLI lets no agent decide a permission allow-once, so the test writes it. */
  function answer(id: string, said: string): void {
    const raw = readJson(join(dir, "state.json"));
    const decisions = (asArray(raw["decisions"]) ?? []).map((d) => (asObject(d)?.["id"] === id ? { ...asObject(d), status: "decided", answer: said, resolution: "answered on the page" } : d));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...raw, decisions }));
  }

  /** Permission card `id` for Bash call `asked`, decided `said` (undefined: left open). */
  function permission(id: string, asked: string, said: string | undefined): void {
    state("decision", id, "--kind", "permission", "--tool", "Bash", "--call", asked, "--root", repo, "--title", "Trash a workspace?", "--why", "prune keeps it",
      "--recommend", "allow-once", "--reason", "throwaway work");

    if (said !== undefined) answer(id, said);
  }

  /** A done worker t1 whose workspace holds a THROWAWAY change and an empty described one: prune keeps it. */
  function throwaway() {
    state("agent", "t1", "--task", "t", "--milestone", "m1");
    ws("add", "t1", "--repo", repo);
    const at = join(base, "repo-t1");
    work(at, "proto.txt", "THROWAWAY: prototype of the page");
    jj(at, "describe", "-m", "THROWAWAY notes, empty");
    jj(at, "new");
    state("agent", "t1", "--status", "done");
    const commit = jj(repo, "log", "--no-graph", "-r", "description(substring:'THROWAWAY: prototype')", "-T", "commit_id");

    return { at, commit };
  }

  /** Nothing moved: folder, jj workspace and row as they were, no trash entry. */
  function untouched(at: string): void {
    expect(existsSync(join(at, "proto.txt"))).toBe(true);
    expect(names()).toBe("default\nt1\n");
    expect(workspaces().find((w) => w["id"] === "t1")?.["status"]).toBe("active");
    expect(existsSync(join(trash(), "repo")) ? readdirSync(join(trash(), "repo")) : []).toEqual([]);
  }

  test("moves the folder to the trash beside a note naming the card, forgets the workspace without snapshotting the main checkout, keeps its commits", () => {
    const { at, commit } = throwaway();
    expect(ws("prune", "--apply").stderr).toContain("ws: kept t1: 2 change(s) not in the stack");
    permission("d1", call("t1", "d1"), "allow-once");
    writeFileSync(join(repo, "unsnapshotted.txt"), "the main checkout's own edit\n");
    // a hand-made entry under the same stamp is never overwritten
    mkdirSync(join(trash(), "repo", "t1@20260105T090000Z"), { recursive: true });
    const ran = ws("trash", "t1", "--card", "d1");
    const id = "repo/t1@20260105T090000Z-2";
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toBe(`trashed t1 under card d1: ${at} is in the trash, ${id}: \`fleet ws restore ${id}\` brings it back\n`);
    expect(existsSync(at)).toBe(false);
    expect(readFileSync(join(trash(), id, "proto.txt"), "utf8")).toBe("THROWAWAY: prototype of the page\n");
    expect(readJson(join(trash(), `${id}.json`))).toMatchObject({ workspace: "t1", path: at, fleet: dir, card: "d1", why: "fleet ws trash t1 --card d1: its worker t1 is done and its changes are THROWAWAY or empty" });
    expect(names()).toBe("default\n");
    expect(jj(repo, "--ignore-working-copy", "log", "--no-graph", "-r", commit, "-T", "description")).toBe("THROWAWAY: prototype of the page\n");
    expect(jj(repo, "--ignore-working-copy", "log", "--no-graph", "-r", "default@", "-T", "empty")).toBe("true");
    expect(workspaces()[0]).toMatchObject({ id: "t1", status: "pruned", pruned: "2026-01-05T09:00:00+00:00", card: "d1" });
    expect(asObject(lastEvent())?.["text"]).toBe(`Workspace t1 trashed under card d1: its changes are THROWAWAY or empty; ${at} moved to the trash (${id}).`);
    expect(fleet(["ws", "restore", id], env).code).toBe(0);
    expect(readFileSync(join(at, "proto.txt"), "utf8")).toBe("THROWAWAY: prototype of the page\n");
  });

  test("allow-kind with only whitespace after it is a yes too", () => {
    const { at } = throwaway();
    permission("p-9a2b3c4d", call("t1", "p-9a2b3c4d"), "allow-kind \n");
    expect(ws("trash", "t1", "--card", "p-9a2b3c4d").code).toBe(0);
    expect(existsSync(at)).toBe(false);
  });

  // The review's probes (ws-trash-card-rv/probe.test.ts): each of these cards trashed t1, and none is a yes to it.
  const notYes: [string, () => void, string, () => string][] = [
    ["a decision decided A, where A means keep", () => state("decision", "k", "--kind", "decision", "--title", "Keep workspace t1 for the demo?", "--question", "Keep t1?", "--why", "w",
      "--option", "A: keep it | t1 stays for the demo", "--option", "B: trash it | it goes", "--decide", "A", "--resolution", "r"), "k", () => "card k is kind decision, not a permission"],
    ["a plain yes to another question about t1", () => state("decision", "q", "--title", "Should t1's prototype be shown Friday?", "--question", "Show t1 on Friday?", "--decide", "yes", "--resolution", "r"), "q", () => "card q is kind decision, not a permission"],
    ["a decision naming t1 in passing, decided A", () => state("decision", "n", "--kind", "decision", "--title", "Which lane gets the docs?", "--question", "Docs lane?", "--why", "t1 is done",
      "--option", "A: lane x | x does it", "--option", "B: lane y | y", "--decide", "A", "--resolution", "r"), "n", () => "card n is kind decision, not a permission"],
    ["an input answered ok", () => state("decision", "i", "--kind", "input", "--title", "Port for t1?", "--question", "Which port should t1 use?", "--decide", "ok", "--resolution", "r"), "i", () => "card i is kind input, not a permission"],
    ["an action answered yes", () => state("decision", "ac", "--kind", "action", "--title", "Log into t1's preview", "--question", "Please log in on t1", "--decide", "yes", "--resolution", "r"), "ac", () => "card ac is kind action, not a permission"],
    ["a permission allow-once for a read of t1", () => permission("p-1a2b3c4d", `jj -R ${repo} log -r t1@`, "allow-once"), "p-1a2b3c4d", () => `card p-1a2b3c4d asks for \`jj -R ${repo} log -r t1@\``],
    ["a permission allow-once with a qualifier, for another card's call", () => permission("p-2a2b3c4d", call("t1", "x"), "allow-once, but not t1"), "p-2a2b3c4d", () => `card p-2a2b3c4d asks for \`${call("t1", "x")}\``],
    ["a permission allow-kind for another card's call", () => permission("p-3a2b3c4d", call("t1", "x"), "allow-kind"), "p-3a2b3c4d", () => `card p-3a2b3c4d asks for \`${call("t1", "x")}\``],
  ];

  for (const [label, open, id, why] of notYes) {
    test(`refuses ${label}, moving nothing, and says to open a permission card for the exact call`, () => {
      const { at } = throwaway();
      open();
      const ran = ws("trash", "t1", "--card", id);
      expect([ran.code, ran.stderr]).toEqual([1, `ws: ${why()}: ${only("t1", id)}; open one for that call\n`]);
      untouched(at);
    });
  }

  test("refuses, moving nothing, unless the worker is idle, every change is THROWAWAY or empty, and the card is a standing allow on this very call", () => {
    const { at } = throwaway();

    const refused = (args: string[], why: string): void => {
      const ran = ws("trash", ...args);
      expect([ran.code, ran.stderr]).toEqual([1, `ws: ${why}\n`]);
      untouched(at);
    };

    const usage = (args: string[]): void => {
      expect(ws("trash", ...args).stderr).toStartWith("ws: usage: fleet ws DIR");
      untouched(at);
    };

    usage(["t1"]);
    usage(["t1", "--card"]);
    usage(["t1", "t2", "--card", "d1"]);
    usage(["t1", "--card", "d1", "--all"]);
    permission("open", call("t1", "open"), undefined);
    refused(["t1", "--card", "open"], `card open is open: ${only("t1", "open")}`);
    permission("no", call("t1", "no"), "deny");
    refused(["t1", "--card", "no"], `card no was decided "deny": ${only("t1", "no")}`);
    permission("vague", call("t1", "vague"), "allow-once, but keep the notes");
    refused(["t1", "--card", "vague"], `card vague was decided "allow-once, but keep the notes": ${only("t1", "vague")}`);
    permission("caps", call("t1", "caps"), "Allow-Once");
    refused(["t1", "--card", "caps"], `card caps was decided "Allow-Once": ${only("t1", "caps")}`);
    permission("other", call("t9", "other"), "allow-once");
    refused(["t1", "--card", "other"], `card other asks for \`${call("t9", "other")}\`: ${only("t1", "other")}; open one for that call`);
    permission("more", `${call("t1", "more")} --all`, "allow-once");
    refused(["t1", "--card", "more"], `card more asks for \`${call("t1", "more")} --all\`: ${only("t1", "more")}; open one for that call`);
    refused(["t1", "--card", "d9"], `no card d9 in this fleet's ledger: ${only("t1", "d9")}; open one for that call`);
    refused(["t1", "--card", "elsewhere/d1"], "a card ID is letters, digits and '-': \"elsewhere/d1\"");
    permission("gone", call("t1", "gone"), undefined);
    state("decision", "gone", "--withdraw", "moot");
    refused(["t1", "--card", "gone"], `card gone is withdrawn: ${only("t1", "gone")}`);
    permission("ok", call("t1", "ok"), "allow-once");
    state("decision", "later", "--kind", "input", "--title", "Keep t1 after all?", "--question", "q", "--why", "w", "--supersedes", "ok");
    refused(["t1", "--card", "ok"], `card ok is superseded by I1: ${only("t1", "ok")}`);
    permission("yes", call("t1", "yes"), "allow-once");
    refused(["default", "--card", "yes"], "never the default workspace, nor a main checkout");
    refused(["../t1", "--card", "yes"], "no active workspace ../t1 in this fleet's ledger: `fleet ws DIR list` names them");
    refused(["t2", "--card", "yes"], "no active workspace t2 in this fleet's ledger: `fleet ws DIR list` names them");
    state("agent", "t1", "--status", "running");
    refused(["t1", "--card", "yes"], "kept t1: its worker t1 is running");
    state("agent", "t1", "--status", "done");
    work(at, "real.txt", "feat: real work");
    const real = ws("trash", "t1", "--card", "yes");
    expect([real.code, real.stderr]).toEqual([1, expect.stringMatching(/^ws: kept t1: 1 change\(s\) neither THROWAWAY nor empty: \w+ feat: real work\n$/)]);
    expect(existsSync(at)).toBe(true);
  });

  test("refuses the workspace it runs in, and a row whose path is the main checkout", () => {
    const { at } = throwaway();
    permission("yes", call("t1", "yes"), "allow-once");
    const was = process.cwd();
    process.chdir(at);

    try {
      expect(ws("trash", "t1", "--card", "yes").stderr).toBe(`ws: ${at} holds this command's own working directory: run it from elsewhere\n`);
    } finally {
      process.chdir(was);
    }

    untouched(at);
    permission("main", call("main", "main"), "allow-once");
    const raw = readJson(join(dir, "state.json"));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...raw, workspaces: [...(asArray(raw["workspaces"]) ?? []), { id: "main", agent: "t1", path: repo, repo, status: "active" }] }));
    expect(ws("trash", "main", "--card", "main").stderr).toBe("ws: never the default workspace, nor a main checkout\n");
    expect(existsSync(join(repo, "README"))).toBe(true);
  });

  test("jj failing to forget brings the folder back and leaves no entry", () => {
    const { at } = throwaway();
    permission("yes", call("t1", "yes"), "allow-once");
    const ops = join(repo, ".jj", "repo", "op_heads", "heads");
    chmodSync(ops, 0o555);
    const ran = ws("trash", "t1", "--card", "yes");
    chmodSync(ops, 0o755);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toStartWith("ws: kept t1: ");
    untouched(at);
  });

  /** Workspace `name` of the repo, with a THROWAWAY change, forgotten and moved by hand into the trash as `entry`. */
  function byHand(name: string, entry: string): string {
    state("agent", name, "--task", "t", "--milestone", "m1");
    ws("add", name, "--repo", repo);
    const at = join(base, `repo-${name}`);
    work(at, "proto.txt", "THROWAWAY: proto");
    jj(repo, "workspace", "forget", name);
    mkdirSync(join(trash(), "repo"), { recursive: true });
    Bun.spawnSync(["mv", at, join(trash(), "repo", entry)]);

    return at;
  }

  test("--adopt gives an entry moved in by hand a note and a stamp under the workspace name its .jj records, so restore brings it back and gc ages it", () => {
    const at = byHand("c18", "c18-manual");
    expect(fleet(["ws", "restore", "repo/c18-manual"], env).stderr).toContain("has no readable note");
    expect(fleet(["ws", "trash", "--adopt", "repo/c18-manual", "--repo", repo, "--name", "c19"], env).stderr)
      .toBe("ws: trash entry repo/c18-manual is jj workspace c18 by its .jj/working_copy/checkout, not c19: leave --name out\n");
    const ran = fleet(["ws", "trash", "--adopt", "repo/c18-manual", "--repo", repo], env);
    const id = "repo/c18@20260105T090000Z";
    expect([ran.code, ran.stderr, ran.stdout]).toEqual([0, "", `adopted repo/c18-manual as ${id}: \`fleet ws restore ${id}\` brings it back, \`fleet ws gc\` deletes it after 7 days\n`]);
    expect(readJson(join(trash(), `${id}.json`))).toEqual({
      repo, workspace: "c18", path: at, commit: null, parents: [], trashed: "2026-01-05T09:00:00+00:00", fleet: "", why: "fleet ws trash --adopt: moved to the trash by hand, with no note",
    });
    expect(fleet(["ws", "trash", "--adopt", id, "--repo", repo], env).stderr).toBe(`ws: trash entry ${id} has a note already\n`);
    expect(fleet(["ws", "trash", "--adopt", "repo/nothing", "--repo", repo], env).stderr).toContain("ws: no trash entry repo/nothing in ");
    expect(fleet(["ws", "gc", "--dry-run"], { ...env, FLEET_NOW: "2026-01-13T09:00:00+00:00" }).stdout).toContain(`would delete ${id} (8d 0h old)`);
    expect(fleet(["ws", "restore", id], env).code).toBe(0);
    expect(readFileSync(join(at, "proto.txt"), "utf8")).toBe("THROWAWAY: proto\n");
    expect(names()).toBe("c18\ndefault\n");
  });

  test("--adopt of an entry whose .jj names no workspace takes --name, checked as add checks a name, and refuses without it", () => {
    byHand("c20", "x y");
    rmSync(join(trash(), "repo", "x y", ".jj", "working_copy", "checkout"));
    const adopt = (...more: string[]) => fleet(["ws", "trash", "--adopt", "repo/x y", "--repo", repo, ...more], env);
    expect(adopt().stderr).toBe("ws: trash entry repo/x y has no .jj/working_copy/checkout that names its workspace: give it with --name NAME\n");
    expect(adopt("--name", "x y").stderr).toBe("ws: a workspace name is letters, digits, '_', '.' or '-', and not 'default': \"x y\"\n");
    expect(adopt("--name", "default").code).toBe(1);
    expect(readdirSync(join(trash(), "repo"))).toEqual(["x y"]);
    const ran = adopt("--name", "c20");
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(readJson(join(trash(), "repo", "c20@20260105T090000Z.json"))).toMatchObject({ workspace: "c20", path: join(base, "repo-c20") });
  });

  test("--adopt of an entry whose .jj records a name add would refuse (../x1, a NUL, a space) reads it as no name and takes --name", () => {
    byHand("c21", "odd");
    const checkout = join(trash(), "repo", "odd", ".jj", "working_copy", "checkout");
    const adopt = (...more: string[]) => fleet(["ws", "trash", "--adopt", "repo/odd", "--repo", repo, ...more], env);

    for (const recorded of ["../x1", "a\0", "x y"]) {
      const bytes = Buffer.from(recorded);
      writeFileSync(checkout, Buffer.concat([Buffer.from([0x1a, bytes.length]), bytes]));
      expect(adopt().stderr).toBe("ws: trash entry repo/odd has no .jj/working_copy/checkout that names its workspace: give it with --name NAME\n");
    }

    const ran = adopt("--name", "c21");
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(readJson(join(trash(), "repo", "c21@20260105T090000Z.json"))).toMatchObject({ workspace: "c21", path: join(base, "repo-c21") });
  });
});
