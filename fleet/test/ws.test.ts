/**
 * `fleet ws`: one jj workspace per worker, against throwaway jj repos. `add` makes it beside the repo and
 * records it; `list` says what each holds; `prune` deletes only what is recorded, known to jj as that
 * workspace, idle, and integrated, and refuses the rest by name.
 * Its hooks are ws-hooks.test.ts and its trash ws-trash.test.ts, files of their own so that bun_files.py runs them at
 * once, each within its per-file limit.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { FLEET, fleet, readJson } from "./support.ts";
import { base, dir, env, freshRepo, jj, lastEvent, makeTemplate, moreEnv, onFailingJj, repo, state, work, workspaces, ws } from "./ws-support.ts";

// Each test runs jj as a subprocess, up to 51 times (with the fleet CLI's own calls). 2026-10-16, 32 cores at load 48:
// 567 calls, median 48 ms, p90 299 ms, the slowest 1.1 s, and a test up to 3.9 s; bun's default 5 s failed 2 of 43 at
// load 15. 51 calls at 1.1 s each is 56 s.
setDefaultTimeout(60_000);

beforeAll(makeTemplate);

beforeEach(freshRepo);

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
    moreEnv({ FLEET_PORT_BASE: "6100" });
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

  test("a stack beside an empty @ is no edit of the worker's: it is listed beside, and never outside the lane", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "src/");
    ws("add", "a1", "--repo", repo);
    jj(repo, "new", "@-", "-m", "nobody: orphan");
    writeFileSync(join(repo, "orphan.txt"), "o\n");
    jj(repo, "new", "@-");
    const ran = ws("list");
    expect(ran.stdout).toMatch(/; nothing ahead of the stack; 1 change\(s\) beside its @: \w+ nobody: orphan\n/);
    expect(ran.stdout).not.toContain("outside its lane");
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

  /** What prune says for a workspace kept by only `line`, the one change beside its @. */
  function keptBeside(line: string): RegExp {
    return new RegExp(`^ws: kept a1: 1 change\\(s\\) beside its @, not in the stack: \\w+ ${line} \\(\`fleet ws trash --card\` lets it go; they stay in jj\\)\\n$`);
  }

  /** A done worker a1 with an empty workspace, and its folder. */
  function idle(): string {
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    ws("add", "a1", "--repo", repo);
    state("agent", "a1", "--status", "done");

    return join(base, "repo-a1");
  }

  /** A done worker a1 with the change "a1: reviewed" on its workspace's base, and its folder. */
  function reviewed(): string {
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    ws("add", "a1", "--repo", repo);
    const at = join(base, "repo-a1");
    work(at, "one.txt", "a1: reviewed");
    state("agent", "a1", "--status", "done");

    return at;
  }

  test("a stack beside the workspace's @ keeps it: a dry run, --apply, list and serve --stop's outlook all name it", () => {
    const at = reviewed();
    jj(at, "new", "@--"); // @ steps off the stack and is now its sibling: nothing under @ is ahead
    expect(jj(repo, "log", "--no-graph", "-r", '::"a1"@ & description(substring:"a1: reviewed")', "-T", "description")).toBe("");
    expect(ws("prune").stderr).toMatch(keptBeside("a1: reviewed"));
    const ran = ws("prune", "--apply");
    expect([ran.code, ran.stdout]).toEqual([1, "nothing to prune\n"]);
    expect(existsSync(at)).toBe(true);
    expect(workspaces().map((w) => w["status"])).toEqual(["active"]);
    expect(ws("list").stdout).toMatch(/; nothing ahead of the stack; 1 change\(s\) beside its @: \w+ a1: reviewed\n/);
    expect(fleet(["state", dir, "set", "--status", "done", "--no-render"], env).stderr).toMatch(/ws: prune keeps a1: 1 change\(s\) beside its @, not in the stack: \w+ a1: reviewed/);
  });

  test("a stack above the workspace's @ keeps it", () => {
    const at = reviewed();
    work(at, "two.txt", "a1: on top");
    jj(at, "edit", "@--"); // @ goes back to the first change, "a1: on top" sits above it
    expect(ws("prune", "--apply").stderr).toMatch(/^ws: kept a1: 1 change\(s\) not in the stack: \w+ a1: reviewed; 1 change\(s\) beside its @, not in the stack: \w+ a1: on top \(/);
    expect(existsSync(at)).toBe(true);
  });

  test("a sibling stack nothing else reaches keeps it, whoever made it", () => {
    const at = reviewed();
    jj(at, "new", "@--");
    jj(repo, "new", "@-", "-m", "nobody's");
    writeFileSync(join(repo, "three.txt"), "three\n");
    jj(repo, "new", "-r", "@-"); // the default workspace steps away: the stack is on no @ now
    expect(ws("prune", "--apply").stderr).toContain("2 change(s) beside its @, not in the stack");
    expect(existsSync(at)).toBe(true);
  });

  test("a stack another workspace's @ reaches is that workspace's: it keeps that one, not its sibling", () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "done");
    state("agent", "a2", "--task", "t", "--milestone", "m1", "--status", "done");
    ws("add", "a1", "--repo", repo);
    ws("add", "a2", "--repo", repo);
    const open = join(base, "repo-a2");
    work(open, "two.txt", "a2: two");
    const ran = ws("prune", "--apply");
    expect(ran.stderr).toMatch(/^ws: kept a2: 1 change\(s\) not in the stack: \w+ a2: two\n$/);
    expect(ran.stdout).toContain("pruned a1:");
    expect(existsSync(open)).toBe(true);
  });

  test("a sibling already in the stack holds nothing back", () => {
    const at = reviewed();
    jj(at, "new", "@--");
    jj(repo, "rebase", "-r", 'description(substring:"a1: reviewed")', "-B", "@");
    expect(ws("prune", "--apply").stdout).toContain("pruned a1:");
    expect(existsSync(at)).toBe(false);
  });

  test("a stack on the base keeps a workspace whose @ moved to a newer trunk: @'s parents no longer reach it", () => {
    const at = reviewed();
    work(repo, "trunk.txt", "trunk moved");
    jj(at, "new", 'description(substring:"trunk moved")');
    expect(ws("prune", "--apply").stderr).toMatch(keptBeside("a1: reviewed"));
    expect(existsSync(at)).toBe(true);
  });

  test("a stack off @'s grandparent keeps it after one more change landed on the way", () => {
    const at = reviewed();
    jj(at, "new", "@--");
    work(at, "x.txt", "a1: second");
    jj(repo, "new", 'description(substring:"a1: second")');
    expect(ws("prune", "--apply").stderr).toMatch(keptBeside("a1: reviewed"));
    expect(existsSync(at)).toBe(true);
  });

  test("a side branch off the middle of the stack keeps it once the main line landed", () => {
    const at = reviewed();
    work(at, "two.txt", "a1: two");
    jj(at, "new", 'description(substring:"a1: reviewed")', "-m", "a1: side");
    writeFileSync(join(at, "side.txt"), "s\n");
    jj(at, "new", 'description(substring:"a1: two")');
    jj(repo, "new", 'description(substring:"a1: two")');
    expect(ws("prune", "--apply").stderr).toMatch(keptBeside("a1: side"));
    expect(existsSync(at)).toBe(true);
  });

  test("a stack off @'s parent keeps it when @ left the line of its base altogether", () => {
    work(repo, "side.txt", "side");
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    ws("add", "a1", "--repo", repo, "-r", 'description(substring:"side")');
    const at = join(base, "repo-a1");
    jj(repo, "new", 'description(substring:"side")-');
    work(repo, "trunk.txt", "trunk moved");
    jj(at, "new", 'description(substring:"trunk moved")');
    work(at, "one.txt", "a1: reviewed");
    jj(at, "new", 'description(substring:"trunk moved")');
    state("agent", "a1", "--status", "done");
    expect(ws("prune", "--apply").stderr).toMatch(keptBeside("a1: reviewed"));
    expect(existsSync(at)).toBe(true);
  });

  test("a handover onto a newer trunk still counts the stack on the base the row had before", () => {
    const at = reviewed();
    work(repo, "trunk.txt", "trunk moved");
    state("agent", "b1", "--task", "t", "--milestone", "m1", "--status", "done");
    expect(ws("add", "b1", "--reuse", "a1", "-r", 'description(substring:"trunk moved")').code).toBe(0);
    expect(ws("prune", "--apply").stderr).toMatch(/^ws: kept a1: 1 change\(s\) beside its @, not in the stack: \w+ a1: reviewed \(/);
    expect(existsSync(at)).toBe(true);
  });

  /** The ledger with the row of workspace a1 changed by `edit`. */
  function rewriteRow(edit: (row: JsonObject) => JsonObject): void {
    const ledger = readJson(join(dir, "state.json"));
    const rows = workspaces().map((row) => (row["id"] === "a1" ? edit(row) : row));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...ledger, workspaces: rows }));
  }

  test.each([
    ["no base", ""],
    ["a base jj no longer has", "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"],
  ])("a row with %s keeps the workspace: what stands beside it cannot be told", (_case, gone) => {
    const at = idle();
    rewriteRow(({ base: _base, ...row }) => (gone === "" ? row : { ...row, base: gone }));
    const ran = ws("prune", "--apply");
    expect(ran.stderr).toBe(`ws: kept a1: the ledger records no base jj still has, so a stack beside it cannot be ruled out\n`);
    expect(ran.code).toBe(1);
    expect(existsSync(at)).toBe(true);
    expect(ws("list").stdout).toContain("; the ledger records no base jj still has");
  });

  test("a stopped preview's merge owns nothing: it goes, and the stack it alone reached keeps its worker's workspace", () => {
    const at = reviewed();
    const preview = join(base, "repo-preview");
    jj(repo, "workspace", "add", preview, "--name", "preview", "-r", "@-");
    jj(preview, "new", "@-", 'description(substring:"a1: reviewed")', "-m", "preview: merge");
    const ledger = readJson(join(dir, "state.json"));
    const row = { id: "preview", kind: "preview", agent: null, path: preview, repo, base: "x", added: "2026-01-05T09:00:00+00:00", status: "active" };
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...ledger, workspaces: [...workspaces(), row] }));
    jj(at, "new", "@--");
    const ran = ws("prune", "--apply");
    expect(ran.stderr).toMatch(keptBeside("a1: reviewed"));
    expect(ran.stdout).toContain("pruned preview:");
    expect(existsSync(at)).toBe(true);
    expect(jj(repo, "log", "--no-graph", "-r", 'description(substring:"preview: merge")', "-T", "description")).toBe("");
  });

  test("a workspace no ledger records owns nothing: the stack only it reaches keeps the worker's", () => {
    const at = reviewed();
    jj(at, "new", "@--");
    jj(repo, "workspace", "add", join(base, "repo-other"), "--name", "other", "-r", 'description(substring:"a1: reviewed")');
    expect(ws("prune", "--apply").stderr).toMatch(keptBeside("a1: reviewed"));
    expect(existsSync(at)).toBe(true);
  });

  test("a list that fails between the check and the move keeps the workspace: the folder never goes without its forget", () => {
    const at = idle();
    const ran = onFailingJj(1, "ws", dir, "prune", "--apply");
    expect(ran.stderr).toBe(`ws: kept a1: jj could not list the workspaces of ${repo}; nothing is moved or deleted\n`);
    expect(ran.code).toBe(1);
    expect(existsSync(at)).toBe(true);
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a1\ndefault\n");
  });

  test("a repo jj cannot read keeps a workspace whose folder is gone: not known is not nothing ahead", () => {
    const at = reviewed();
    Bun.spawnSync(["rm", "-rf", at]);
    const store = join(repo, ".jj");
    const aside = join(base, "jj-aside");
    Bun.spawnSync(["mv", store, aside]);
    const ran = ws("prune", "--apply");
    Bun.spawnSync(["mv", aside, store]);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toBe(`ws: kept a1: jj could not list the workspaces of ${repo}\n`);
    expect(workspaces().map((w) => w["status"])).toEqual(["active"]);
  });

  test("a recorded workspace whose repo is gone with it has nothing left to keep", () => {
    const at = reviewed();
    Bun.spawnSync(["rm", "-rf", at, repo]);
    expect(ws("prune", "--apply").code).toBe(0);
    expect(workspaces().map((w) => w["status"])).toEqual(["pruned"]);
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
