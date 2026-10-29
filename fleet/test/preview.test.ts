/**
 * `fleet preview`: the combined preview of every worker's in-progress edits, against throwaway jj repos and
 * a stand-in dev server (stub-dev.ts). `start` merges the workers' working copies not yet in the stack in a
 * workspace of its own and starts the dev server and the updater; the updater takes a worker's next edit
 * without touching the worker's files; `include` and `exclude` change the merge; a done worker stays until
 * its changes are integrated; the stack is the default workspace's @ or the revset given. The servers'
 * stops, per-worker previews and root mode are in preview-servers.test.ts, the dev server itself in
 * preview-devserver.test.ts, the merge that is never served conflicted in preview-merge.test.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { readRecord, type PreviewRecord } from "../src/preview/record.ts";
import { isRunning as alive } from "../src/preview/devserver.ts";
import { baseEnv, fleet, readJson, sleep, tmp, type Environment } from "./support.ts";

/** The stand-in dev server, told its port and base as a Vite command would be. */
const STUB = `${process.execPath} ${join(import.meta.dir, "stub-dev.ts")} {port} {base}`;

/** jj, a dev server and the updater per test: seconds, not milliseconds. */
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

function preview(...args: string[]): ReturnType<typeof fleet> {
  return fleet(["preview", dir, ...args], env);
}

function record(): PreviewRecord {
  const got = readRecord(dir);

  if (got === undefined) throw new Error("no preview record");

  return got;
}

function workspaceRows(): JsonObject[] {
  return (asArray(readJson(join(dir, "state.json"))["workspaces"]) ?? []).flatMap((w) => {
    const o = asObject(w);

    return o === undefined ? [] : [o];
  });
}

/** Wait until `ready` holds (at most `ms`). */
async function until(ready: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(100);
  }
}

const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

const ws = (name: string): string => join(base, `repo-${name}`);

/** The commit `revset` names in the test repo, read without a snapshot. */
const commitOf = (revset: string): string => jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", revset, "-T", "commit_id").trim();

beforeEach(() => {
  base = tmp("fleet-preview-");
  repo = join(base, "repo");
  Bun.spawnSync(["jj", "git", "init", repo], { stdout: "ignore", stderr: "ignore" });

  for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repo, f), "base\n");
  jj(repo, "describe", "-m", "base");
  jj(repo, "new");
  dir = join(base, "fleet");
  env = baseEnv(join(base, "registry"), { TZ: "UTC", TAILSCALE: join(base, "no-tailscale"), FLEET_PREVIEW_S: "0.2", FLEET_PREVIEW_WAIT_S: "10" });
  state("init", "--project", "shop", "--goal", "g");
  state("milestone", "m1", "--title", "M");
  state("agent", "a1", "--task", "header", "--milestone", "m1", "--lane", "a.txt");
  state("agent", "a2", "--task", "footer", "--milestone", "m1", "--lane", "b.txt");
  expect(fleet(["ws", dir, "add", "a1", "--repo", repo], env).code).toBe(0);
  expect(fleet(["ws", dir, "add", "a2", "--repo", repo], env).code).toBe(0);
  expect(fleet(["serve", dir, "--pid", String(process.pid)], env).code).toBe(0);
});

afterEach(() => {
  if (existsSync(join(dir, "preview.json"))) preview("stop", "--all");
});

describe("fleet preview start", () => {
  test("merges the running workers' working copies on the stack, records the workspace as the fleet's preview, and serves it", async () => {
    writeFileSync(join(ws("a1"), "a.txt"), "header by a1\n");
    writeFileSync(join(ws("a2"), "b.txt"), "footer by a2\n");
    const ran = preview("start", "--cmd", STUB);
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toContain("/f/shop/preview/\n");
    expect(ran.stdout).toContain("merged: a1, a2");

    const path = ws("preview");
    expect(read(join(path, "a.txt"))).toBe("header by a1\n");
    expect(read(join(path, "b.txt"))).toBe("footer by a2\n");
    const parents = jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "preview@-", "-T", 'commit_id ++ "\\n"').split("\n").filter(Boolean).sort();
    const workers = ["a1@", "a2@"].map((r) => jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", r, "-T", "commit_id").trim()).sort();
    expect(parents).toEqual(workers);

    expect(workspaceRows().find((w) => w["id"] === "preview")).toMatchObject({ kind: "preview", agent: null, path, repo, status: "active" });
    const r = record();
    expect(r.merged.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(r.conflicts).toEqual([]);
    expect(alive(r.server?.pid ?? undefined)).toBe(true);
    expect(alive(r.updater ?? undefined)).toBe(true);
    expect(r.server?.base).toBe("/f/shop/preview/");
    const page = await fetch(`http://127.0.0.1:${r.server?.port ?? 0}/f/shop/preview/a.txt`);
    expect(await page.text()).toBe("header by a1\n");

    const status = preview("status");
    expect(status.stdout).toContain("[x] a1 (running) at ");
    expect(status.stdout).toContain("[x] a2 (running) at ");
    expect(status.stdout).toContain("answering");
    expect(status.stdout).toContain(`  updater: pid ${String(r.updater)}, every 0.2 s\n`);
  });

  test("with no worker it sits on the stack, and with one on that worker's @", () => {
    state("agent", "a2", "--status", "done");
    const ran = preview("start", "--cmd", STUB);
    expect(ran.code).toBe(0);
    expect(jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "preview@-", "-T", "commit_id").trim()).toBe(jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "a1@", "-T", "commit_id").trim());
    preview("stop");
    state("agent", "a1", "--status", "done");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(record().merged).toEqual([]);
    expect(jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "preview@-", "-T", "description").trim()).toBe("base");
  });

  test("refuses an unserved fleet, a shared one, a running one, and a repo with no dev command", () => {
    expect(preview("start").stderr).toContain("has no package.json; give --cmd");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    const again = preview("start", "--cmd", STUB);
    expect([again.code, again.stderr]).toEqual([1, expect.stringContaining("preview: the preview already runs at ")]);
    preview("stop");
    expect(fleet(["serve", dir, "--stop"], env).code).toBe(0);
    expect(preview("start", "--cmd", STUB).stderr).toContain("has no preview here: the preview server");
    state("set", "--workspaces", "shared");
    expect(preview("start", "--cmd", STUB).stderr).toContain("share one working copy");
  });

  test("takes the command from the ledger when none is given", () => {
    expect(preview("set", "--cmd", STUB).code).toBe(0);
    expect(asObject(readJson(join(dir, "state.json"))["preview"])).toEqual({ cmd: STUB });
    expect(preview("start").code).toBe(0);
    expect(record().server?.cmd).toContain("stub-dev.ts");
  });
});

describe("the updater", () => {
  test("takes a worker's new edit into the preview and leaves the worker's files as they were", async () => {
    writeFileSync(join(ws("a1"), "a.txt"), "first\n");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    const change = jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "a1@", "-T", "change_id").trim();

    // The worker edits; nothing of jj runs in its workspace.
    writeFileSync(join(ws("a1"), "a.txt"), "second\n");
    const before = statSync(join(ws("a1"), "a.txt")).mtimeMs;
    const listing = readdirSync(ws("a1")).sort();
    const head = (): string => jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "a1@", "-T", "commit_id").trim();
    // The files are written before the look records what it merged.
    await until(() => read(join(ws("preview"), "a.txt")) === "second\n" && record().merged.find((m) => m.id === "a1")?.commit === head());

    expect(read(join(ws("a1"), "a.txt"))).toBe("second\n");
    expect(statSync(join(ws("a1"), "a.txt")).mtimeMs).toBe(before);
    expect(readdirSync(ws("a1")).sort()).toEqual(listing);
    expect(jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "a1@", "-T", "change_id").trim()).toBe(change);
    // The worker's own next jj command finds its workspace as it left it: not stale, its edit recorded.
    expect(jj(ws("a1"), "status")).toContain("repo-a1/a.txt");
  });
});

describe("include and exclude", () => {
  test("take a worker out of the merge and back, and a done worker in", async () => {
    writeFileSync(join(ws("a1"), "a.txt"), "header by a1\n");
    writeFileSync(join(ws("a2"), "b.txt"), "footer by a2\n");
    expect(preview("start", "--cmd", STUB).code).toBe(0);

    const out = preview("exclude", "a2");
    expect([out.code, out.stdout]).toEqual([0, "a2 is out of the preview from its next look (every 0.2 s)\n"]);
    // The files are written before the look records what it merged.
    await until(() => read(join(ws("preview"), "b.txt")) === "base\n" && record().merged.length === 1);
    expect(record().exclude).toEqual(["a2"]);
    expect(record().merged.map((m) => m.id)).toEqual(["a1"]);
    expect(preview("status").stdout).toContain("[ ] a2 (taken out)");

    expect(preview("include", "a2").code).toBe(0);
    await until(() => read(join(ws("preview"), "b.txt")) === "footer by a2\n");
    expect(record().exclude).toEqual([]);

    state("agent", "a1", "--status", "done");
    preview("exclude", "a1");
    await until(() => read(join(ws("preview"), "a.txt")) === "base\n");
    expect(preview("include", "a1").code).toBe(0);
    await until(() => read(join(ws("preview"), "a.txt")) === "header by a1\n");
    expect(preview("status").stdout).toContain("[x] a1 (taken in)");

    expect(preview("include", "nobody").stderr).toBe("preview: nobody has no active workspace in this fleet\n");
  });
});

describe("a done worker", () => {
  test("stays in the merge while its changes are not in the stack, drops out once they are in it or on the trunk, and is out when taken out", async () => {
    writeFileSync(join(ws("a1"), "a.txt"), "header by a1\n");
    writeFileSync(join(ws("a2"), "b.txt"), "footer by a2\n");
    state("agent", "a1", "--status", "done");
    state("agent", "a2", "--status", "done");
    const ran = preview("start", "--cmd", STUB);
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toContain("merged: a1, a2");
    expect(read(join(ws("preview"), "a.txt"))).toBe("header by a1\n");
    expect(preview("status").stdout).toContain("[x] a1 (done, merged) at ");

    // a1's work lands: the stack (the default workspace's @, empty, on its parent) now has a1's commit.
    jj(repo, "new", "a1@");
    await until(() => record().merged.map((m) => m.id).join() === "a2");
    expect(read(join(ws("preview"), "a.txt"))).toBe("header by a1\n");
    const status = preview("status").stdout;
    expect(status).toContain("[ ] a1 (done, already in the stack)");
    expect(status).toContain("[x] a2 (done, merged) at ");

    // a2's work lands on the trunk (a bookmark the coordinator moves), not in the default workspace's @.
    jj(repo, "bookmark", "create", "main", "-r", "a2@");
    jj(repo, "config", "set", "--repo", 'revset-aliases."trunk()"', "main");
    await until(() => record().merged.length === 0);
    expect(preview("status").stdout).toContain("[ ] a2 (done, already in the stack)");

    // a2 starts a new change on what landed and edits: it is back until taken out.
    jj(ws("a2"), "new");
    writeFileSync(join(ws("a2"), "b.txt"), "footer by a2, again\n");
    // The updater writes the files (`workspace update-stale`) before it records the merge: wait for both.
    await until(() => read(join(ws("preview"), "b.txt")) === "footer by a2, again\n" && record().merged.length > 0);
    expect(record().merged.map((m) => m.id)).toEqual(["a2"]);
    expect(preview("exclude", "a2").code).toBe(0);
    await until(() => record().merged.length === 0 && read(join(ws("preview"), "b.txt")) === "base\n");
    expect(preview("status").stdout).toContain("[ ] a2 (taken out)");
  });
});

describe("an explicit stack", () => {
  const devloop = (): string => ws("devloop");

  /** The default workspace's @ holds the user's own uncommitted edit of c.txt, which a1's edit conflicts
   * with; a `devloop` workspace holds a clean stack on the base (d.txt). */
  beforeEach(() => {
    writeFileSync(join(repo, "c.txt"), "luiz's own work\n");
    jj(repo, "describe", "-m", "luiz's work in progress");
    jj(repo, "workspace", "add", devloop(), "--name", "devloop", "-r", "@-");
    writeFileSync(join(devloop(), "d.txt"), "integrated\n");
    jj(devloop(), "describe", "-m", "the dev stack");
    writeFileSync(join(ws("a1"), "c.txt"), "c by a1\n");
  });

  test("without one, the default workspace's @ is the stack, and the worker that conflicts with it is left out", () => {
    const ran = preview("start", "--cmd", STUB);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toBe(`preview: a1 is left out of the merge: its edits conflict with the stack in "c.txt"; the preview serves the merge without it (\`fleet preview ${dir} status\`)\n`);
    expect(record().stack).toBe(commitOf("default@"));
    expect(read(join(ws("preview"), "c.txt"))).toBe("luiz's own work\n");
    expect(preview("status").stdout).toContain("  stack: the default workspace's @ (");
  });

  test("set --stack devloop@ merges the workers onto devloop's commit, clean, and follows it as it moves", async () => {
    const set = preview("set", "--stack", "devloop@");
    expect([set.code, set.stderr]).toEqual([0, ""]);
    expect(set.stdout).toContain(`the combined preview's stack is devloop@ (now ${commitOf("devloop@").slice(0, 12)})`);
    expect(asObject(readJson(join(dir, "state.json"))["preview"])).toEqual({ stack: "devloop@" });

    const ran = preview("start", "--cmd", STUB);
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    const parents = jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "preview@-", "-T", 'commit_id ++ "\\n"').split("\n").filter(Boolean).sort();
    expect(parents).toEqual([commitOf("a1@"), commitOf("a2@"), commitOf("devloop@")].sort());
    expect(record()).toMatchObject({ stack: commitOf("devloop@"), conflicts: [], error: null });
    expect(read(join(ws("preview"), "c.txt"))).toBe("c by a1\n");
    expect(read(join(ws("preview"), "d.txt"))).toBe("integrated\n");
    expect(preview("status").stdout).toContain(`  stack: devloop@ (${commitOf("devloop@").slice(0, 12)})\n`);

    // The coordinator integrates more into devloop: the merge follows.
    writeFileSync(join(devloop(), "e.txt"), "more\n");
    jj(devloop(), "util", "snapshot");
    await until(() => read(join(ws("preview"), "e.txt")) === "more\n" && record().stack === commitOf("devloop@"));
    expect(record().conflicts).toEqual([]);
  });

  test("a revset naming no commit, two, or none jj knows is refused in status, and the last good merge is kept", async () => {
    expect(preview("set", "--stack", "devloop@").code).toBe(0);
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    const good = record();
    expect(good.merged.map((m) => m.id)).toEqual(["a1", "a2"]);

    for (const [revset, reason] of [
      ["none()", "the stack's revset none() names no commit"],
      ["devloop@ | default@", "the stack's revset devloop@ | default@ names 2 commits, not one"],
      ["nobody@", "the stack's revset nobody@ is not one jj resolves: "],
    ] as const) {
      expect(preview("set", "--stack", revset).code).toBe(0);
      await until(() => record().error?.includes(reason) === true);
      expect(record()).toMatchObject({ merged: good.merged, stack: good.stack, commit: good.commit, conflicts: [] });
      expect(preview("status").stdout).toContain(`updater's last error: ${reason}`);
    }

    expect(read(join(ws("preview"), "d.txt"))).toBe("integrated\n");

    // Cleared, the default rule is back, and a1, whose edit conflicts with that stack, is left out.
    const cleared = preview("set", "--stack", "");
    expect([cleared.code, cleared.stdout]).toEqual([0, "the combined preview's stack is the default workspace's @ (or its parent when that @ is empty and undescribed)\n"]);
    expect(asObject(readJson(join(dir, "state.json"))["preview"])).toEqual({});
    await until(() => record().stack === commitOf("default@") && record().error === null);
    await until(() => record().left.length > 0);
    expect(record().left.map((l) => [l.id, l.conflicts])).toEqual([["a1", [{ path: "c.txt", workers: [] }]]]);
    expect(record().conflicts).toEqual([]);

    expect(preview("set", "--stack", "devloop@").code).toBe(0);
    expect(preview("set", "--no-stack").code).toBe(0);
    expect(asObject(readJson(join(dir, "state.json"))["preview"])).toEqual({});
    expect(preview("set", "--stack", "x", "--no-stack").code).not.toBe(0);
  });

  test("start --stack gives the base for that start alone, over the ledger's", () => {
    expect(preview("set", "--stack", "default@").code).toBe(0);
    const ran = preview("start", "--stack", "devloop@", "--cmd", STUB);
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(record().stack).toBe(commitOf("devloop@"));
    expect(preview("status").stdout).toContain("  stack: devloop@ (");
    expect(preview("stop").code).toBe(0);
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(record().stack).toBe(commitOf("default@"));
    expect(preview("start", "--per-worker", "a1", "--stack", "devloop@", "--cmd", STUB).code).not.toBe(0);
  });

  test("a done worker whose changes are in devloop@ counts as already in the stack", async () => {
    state("agent", "a1", "--status", "done");
    expect(preview("set", "--stack", "devloop@").code).toBe(0);
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(record().merged.map((m) => m.id)).toEqual(["a1", "a2"]);

    // The coordinator integrates a1's work into devloop.
    jj(devloop(), "new", "devloop@", "a1@", "-m", "integrate a1");
    await until(() => record().merged.map((m) => m.id).join() === "a2");
    expect(preview("status").stdout).toContain("[ ] a1 (done, already in the stack)");
    expect(read(join(ws("preview"), "c.txt"))).toBe("c by a1\n");
    expect(record().conflicts).toEqual([]);
  });
});
