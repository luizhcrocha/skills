/**
 * `fleet preview`: the combined preview of every worker's in-progress edits, against throwaway jj repos and
 * a stand-in dev server (stub-dev.ts). `start` merges the workers' working copies not yet in the stack in a
 * workspace of its own and starts the dev server and the updater; the updater takes a worker's next edit without touching
 * the worker's files; a conflict is recorded with the workers that touch the file; `include` and `exclude`
 * change the merge; `stop` stops what runs; `fleet ws prune` never deletes a live preview.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { view } from "../src/page/view.ts";
import { fill, lastError } from "../src/preview/devserver.ts";
import { readRecord, type PreviewRecord } from "../src/preview/record.ts";
import { isRunning as alive } from "../src/preview/devserver.ts";
import { SpendReader } from "../src/transcripts.ts";
import { baseEnv, fleet, machine, readJson, SKILL, sleep, spawnFleet, tmp, type Environment } from "./support.ts";

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
  if (existsSync(join(dir, "preview.json"))) preview("stop");
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
    expect(preview("start", "--cmd", STUB).stderr).toContain("is not being served");
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

  test("records a conflict between workers with the workers that touch the file, and keeps merging", async () => {
    writeFileSync(join(ws("a1"), "c.txt"), "c by a1\n");
    writeFileSync(join(ws("a2"), "c.txt"), "c by a2\n");
    writeFileSync(join(ws("a1"), "a.txt"), "header by a1\n");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    await until(() => record().conflicts.length > 0);

    expect(record().conflicts).toEqual([{ path: "c.txt", workers: ["a1", "a2"] }]);
    expect(read(join(ws("preview"), "c.txt"))).toContain("<<<<<<<");
    expect(read(join(ws("preview"), "a.txt"))).toBe("header by a1\n");
    expect(preview("status").stdout).toContain("conflicts: c.txt (a1, a2)");

    // a2 takes its edit back: the conflict goes at the next look.
    writeFileSync(join(ws("a2"), "c.txt"), "base\n");
    await until(() => record().conflicts.length === 0);
    expect(read(join(ws("preview"), "c.txt"))).toBe("c by a1\n");
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

describe("fleet preview stop, and prune", () => {
  test("stop stops the dev server and the updater and keeps the workspace for the next start", () => {
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    const { server, updater } = record();
    const out = preview("stop");
    expect(out.code).toBe(0);
    expect(alive(server?.pid ?? undefined)).toBe(false);
    expect(alive(updater ?? undefined)).toBe(false);
    expect(record().server?.pid).toBeNull();
    expect(record().updater).toBeNull();
    expect(existsSync(ws("preview"))).toBe(true);
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(workspaceRows().filter((w) => w["kind"] === "preview")).toHaveLength(1);
  });

  test("prune never deletes a live preview, and removes a stopped one with its merge", async () => {
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    const live = fleet(["ws", dir, "prune", "--apply"], env);
    expect(live.stderr).toContain("ws: kept preview: the fleet's preview is running (dev server pid");
    expect(existsSync(ws("preview"))).toBe(true);
    // Its updater alone keeps it too.
    const r = record();
    Bun.spawnSync(["kill", String(r.server?.pid ?? 0)]);
    await until(() => !alive(r.server?.pid));
    expect(fleet(["ws", dir, "prune", "--apply"], env).stderr).toContain("ws: kept preview: the fleet's preview is running (updater pid");

    preview("stop");
    const gone = fleet(["ws", dir, "prune", "--apply"], env);
    expect(gone.stdout).toContain(`pruned preview: ${ws("preview")} deleted`);
    expect(existsSync(ws("preview"))).toBe(false);
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a1\na2\ndefault\n");
    expect(jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "merges()", "-T", "commit_id")).toBe("");
    expect(existsSync(join(dir, "preview.json"))).toBe(false);
    expect(workspaceRows().find((w) => w["id"] === "preview")?.["status"]).toBe("pruned");
  });

  test("fleet ws hands no preview to a worker", () => {
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    state("agent", "b1", "--task", "t", "--milestone", "m1");
    expect(fleet(["ws", dir, "add", "b1", "--reuse", "preview"], env).stderr).toBe("ws: workspace preview is the fleet's preview (`fleet preview`), never a worker's\n");
  });
});

describe("a per-worker preview", () => {
  test("runs a dev server in that worker's own workspace under its own path, and stops alone", async () => {
    writeFileSync(join(ws("a1"), "a.txt"), "header by a1\n");
    const ran = preview("start", "--per-worker", "a1", "--cmd", STUB);
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toContain("/f/shop/preview/a1/\n");
    const w = record().workers.find((x) => x.worker === "a1");
    expect(w).toMatchObject({ path: ws("a1"), base: "/f/shop/preview/a1/" });
    const page = await fetch(`http://127.0.0.1:${w?.port ?? 0}/f/shop/preview/a1/a.txt`);
    expect(await page.text()).toBe("header by a1\n");
    expect(existsSync(ws("preview"))).toBe(false);

    expect(preview("stop", "--per-worker", "a1").code).toBe(0);
    expect(alive(w?.pid ?? undefined)).toBe(false);
    expect(preview("start", "--per-worker", "nobody", "--cmd", STUB).stderr).toContain("nobody has no active workspace");
  });
});

/** A tailscale that says this machine is box.example.ts.net at 127.0.0.2 (a loopback address a test can bind,
 * standing in for its tailnet address). */
const TAILNET_STATUS = JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.example.ts.net.", TailscaleIPs: ["127.0.0.2"], UserID: 1 }, User: { "1": { LoginName: "luiz@example.com" } }, Peer: {} });

/** A range of ports for the public ports, from a free one up. */
function portRange(): readonly [number, number] {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const lo = probe.port ?? 0;
  void probe.stop(true);

  return [lo, lo + 30];
}

describe("root mode", () => {
  test("set --root records it in the ledger beside the command, and --no-root takes it back", () => {
    expect(preview("set", "--cmd", STUB, "--root").code).toBe(0);
    expect(asObject(readJson(join(dir, "state.json"))["preview"])).toEqual({ cmd: STUB, root: true });
    const back = preview("set", "--no-root");
    expect([back.code, back.stderr]).toEqual([0, ""]);
    expect(asObject(readJson(join(dir, "state.json"))["preview"])).toEqual({ cmd: STUB });
  });

  test("start --root tells the dev server base / and gives the preview a public port of its own, stable across restarts", async () => {
    const [lo, hi] = portRange();
    env["FLEET_PREVIEW_PORTS"] = `${lo}-${hi}`;
    const inRange = (port: number | null | undefined): boolean => port !== null && port !== undefined && port >= lo && port <= hi;

    const ran = preview("start", "--root", "--cmd", STUB);
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    const first = record();
    expect(first.server?.base).toBe("/");
    expect(first.server?.cmd).toEndWith(` ${String(first.server?.port)} /`);
    const pub = first.server?.public ?? null;
    expect(inRange(pub)).toBe(true);
    expect(first.ports.combined).toBe(pub);
    expect(ran.stdout).toContain(`http://127.0.0.1:${String(pub)}/`);
    expect(await (await fetch(`http://127.0.0.1:${String(first.server?.port)}/a.txt`)).text()).toBe("base\n");

    expect(preview("stop").code).toBe(0);
    expect(preview("start", "--root", "--cmd", STUB).code).toBe(0);
    expect(record().server?.public).toBe(pub);
    expect(record().server?.port).not.toBe(first.server?.port ?? 0);

    const own = preview("start", "--per-worker", "a1", "--root", "--cmd", STUB);
    expect([own.code, own.stderr]).toEqual([0, ""]);
    const mine = record().workers.find((w) => w.worker === "a1")?.public ?? null;
    expect(inRange(mine)).toBe(true);
    expect(mine).not.toBe(pub);
    expect(record().ports.workers).toEqual({ a1: mine ?? 0 });
    expect(own.stdout).toContain(`http://127.0.0.1:${String(mine)}/`);
    expect(preview("stop", "--per-worker", "a1").code).toBe(0);
    expect(preview("start", "--per-worker", "a1", "--root", "--cmd", STUB).code).toBe(0);
    expect(record().workers.find((w) => w.worker === "a1")?.public).toBe(mine);
  });

  test("the ledger's root puts a start in root mode; without it a start is not, and has no public port", () => {
    env["FLEET_PREVIEW_PORTS"] = portRange().join("-");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(record().server).toMatchObject({ base: "/f/shop/preview/", public: null });
    expect(preview("stop").code).toBe(0);
    expect(preview("set", "--root").code).toBe(0);
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(record().server?.base).toBe("/");
    expect(record().server?.public).toBe(record().ports.combined);
    const lookups = { up: (urls: readonly string[]) => urls.map(() => false), discovered: () => [], spend: new SpendReader() };
    const shown = asObject(view(machine(env), lookups, readJson(join(dir, "state.json")), dir)["preview"]);
    expect(shown).toMatchObject({ public: record().server?.public ?? 0, public_error: null });
  });

  test("a port of the range already taken on this machine is skipped, and a range with none free is refused", () => {
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = taken.port ?? 0;

    try {
      env["FLEET_PREVIEW_PORTS"] = `${port}-${port + 20}`;
      expect(preview("start", "--root", "--cmd", STUB).code).toBe(0);
      expect(record().server?.public).not.toBe(port);
      expect(preview("stop").code).toBe(0);

      env["FLEET_PREVIEW_PORTS"] = `${port}-${port}`;
      const full = preview("start", "--per-worker", "a1", "--root", "--cmd", STUB);
      expect(full.code).not.toBe(0);
      expect(full.stderr).toContain(`no free port in FLEET_PREVIEW_PORTS (${port}-${port})`);
    } finally {
      void taken.stop(true);
    }
  });

  test("status gives the public address by the machine's tailnet name and address, in plain http", () => {
    const tailscale = join(base, "tailscale");
    writeFileSync(tailscale, `#!/bin/sh\ncase "$1 $2" in\n  "status --json") printf '%s' '${TAILNET_STATUS}' ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(tailscale, 0o755);
    env["TAILSCALE"] = tailscale;
    env["FLEET_PREVIEW_PORTS"] = portRange().join("-");
    expect(preview("start", "--root", "--cmd", STUB).code).toBe(0);
    const pub = String(record().server?.public);
    const status = preview("status").stdout;
    expect(status).toContain(`http://box.example.ts.net:${pub}/`);
    expect(status).toContain(`http://127.0.0.2:${pub}/`);
    expect(status).toContain("no secure context");
    expect(status).toContain("no hub runs");
  });
});

describe("the dev servers' environment", () => {
  test("every dev server the preview starts (combined, per-worker, root mode or not) inherits the environment `start` ran in, unchanged", async () => {
    const cmd = `${process.execPath} ${join(import.meta.dir, "env-dev.ts")} {port} FLEET_TEST_SECRET`;
    const secret = { ...env, FLEET_TEST_SECRET: "from secretspec run", FLEET_PREVIEW_PORTS: portRange().join("-") };
    const valueAt = async (port: number | undefined): Promise<string> => (await fetch(`http://127.0.0.1:${String(port ?? 0)}/`)).text();

    const combined = spawnFleet(["preview", dir, "start", "--cmd", cmd], secret);
    expect([combined.code, combined.stderr]).toEqual([0, ""]);
    expect(await valueAt(record().server?.port)).toBe("from secretspec run");

    const own = spawnFleet(["preview", dir, "start", "--per-worker", "a1", "--root", "--cmd", cmd], secret);
    expect([own.code, own.stderr]).toEqual([0, ""]);
    expect(await valueAt(record().workers.find((w) => w.worker === "a1")?.port)).toBe("from secretspec run");

    expect(spawnFleet(["preview", dir, "stop"], secret).code).toBe(0);
    expect(spawnFleet(["preview", dir, "start", "--root", "--cmd", cmd], secret).code).toBe(0);
    expect(await valueAt(record().server?.port)).toBe("from secretspec run");
  });
});

describe("the dev server", () => {
  const VITE = [
    "  VITE v8.3.2  ready in 154 ms",
    "7:50:38 PM [vite] (client) hmr update /src/Header.tsx",
    "7:51:06 PM [vite] Internal server error: Transform failed with 1 error:",
    "",
    "\u001b[31m[PARSE_ERROR] \u001b[0mEncountered diff marker",
    "   \u001b[38;5;246m╭─[\u001b[0m src/Header.tsx:2:1 ]",
    "  Plugin: vite:oxc",
    "      at transformWithOxc (file:///x/node.js:7581:19)",
    "7:51:06 PM [vite] (client) [console.error] [vite] Failed to reload /src/Header.tsx. (see errors above)",
  ];

  test("its last error is read from the burst's first line, without colours or stack frames, until it reloads a page", () => {
    expect(lastError(VITE.join("\n"))).toBe(
      [
        "7:51:06 PM [vite] Internal server error: Transform failed with 1 error:",
        "[PARSE_ERROR] Encountered diff marker",
        "   ╭─[ src/Header.tsx:2:1 ]",
        "  Plugin: vite:oxc",
        "7:51:06 PM [vite] (client) [console.error] [vite] Failed to reload /src/Header.tsx. (see errors above)",
      ].join("\n"),
    );
    expect(lastError([...VITE, "7:51:12 PM [vite] (client) hmr update /src/Header.tsx"].join("\n"))).toBeNull();
    expect(lastError(VITE.slice(0, 2).join("\n"))).toBeNull();
  });

  test("Vite is told its port, host and base; a command with placeholders gets them; anything else runs as given", () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "vite --open" } }));
    expect(fill(repo, "npm run dev", 5173, "/f/shop/preview/")).toEqual({ cmd: "npm run dev -- --port 5173 --strictPort --host 127.0.0.1 --base /f/shop/preview/", base: "/f/shop/preview/" });
    expect(fill(repo, "pnpm run dev", 5173, "/b/")).toEqual({ cmd: "pnpm run dev --port 5173 --strictPort --host 127.0.0.1 --base /b/", base: "/b/" });
    expect(fill(repo, "serve --port {port} --prefix {base}", 9, "/b/")).toEqual({ cmd: "serve --port 9 --prefix /b/", base: "/b/" });
    expect(fill(repo, "next dev -p {port}", 9, "/b/")).toEqual({ cmd: "next dev -p 9", base: "/" });
    expect(fill(repo, "python3 -m http.server", 9, "/b/")).toEqual({ cmd: "python3 -m http.server", base: "/" });
  });

  test("a Vite+ dev server (`vp dev`, `vite-plus dev`, a script or `vp run` task that runs one) is told its port, host and base; its other commands are not", () => {
    const told = (cmd: string): string => `${cmd} --port 9 --strictPort --host 127.0.0.1 --base /b/`;
    const ledger = "env CASOS_DEV=prod pnpm --filter casos exec vp dev";
    expect(fill(repo, ledger, 9, "/b/")).toEqual({ cmd: told(ledger), base: "/b/" });
    expect(fill(repo, "vp dev", 9, "/b/")).toEqual({ cmd: told("vp dev"), base: "/b/" });
    expect(fill(repo, "npx vite-plus dev", 9, "/b/")).toEqual({ cmd: told("npx vite-plus dev"), base: "/b/" });
    expect(fill(repo, "vite", 9, "/b/")).toEqual({ cmd: told("vite"), base: "/b/" });

    for (const other of ["vp build", "vp preview", "vp test", "vp check", "vp", "pnpm --filter casos exec vp build", "vite build", "vite preview", "cf-vite dev", "vp build --config vite.config.ts"]) {
      expect(fill(repo, other, 9, "/b/")).toEqual({ cmd: other, base: "/" });
    }

    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "vp dev --open", build: "vp build", start: "node dev/start.ts" } }));
    expect(fill(repo, "pnpm dev", 9, "/b/")).toEqual({ cmd: told("pnpm dev"), base: "/b/" });
    expect(fill(repo, "vp run dev", 9, "/b/")).toEqual({ cmd: told("vp run dev"), base: "/b/" });
    expect(fill(repo, "vpr dev", 9, "/b/")).toEqual({ cmd: told("vpr dev"), base: "/b/" });
    expect(fill(repo, "pnpm build", 9, "/b/")).toEqual({ cmd: "pnpm build", base: "/" });
    expect(fill(repo, "vpr start", 9, "/b/")).toEqual({ cmd: "vpr start", base: "/" });
  });

  test("start says so, with the log's last error, when the dev server dies before it answers", () => {
    const dies = `${process.execPath} -e 'console.error("error when starting dev server:\\nError: Port 24116 is already in use"); process.exit(1)'`;
    const ran = preview("start", "--cmd", dies);
    expect(ran.code).toBe(1);
    expect(ran.stdout).toContain("exited at start");
    expect(ran.stdout).not.toContain("not answering yet");
    expect(ran.stderr).toContain("preview: the dev server exited before it answered on port ");
    expect(ran.stderr).toContain("Error: Port 24116 is already in use");

    const worker = preview("start", "--per-worker", "a1", "--cmd", dies);
    expect(worker.code).toBe(1);
    expect(worker.stderr).toContain("Error: Port 24116 is already in use");
  });
});

describe("the ledger", () => {
  test("the preview's keys (its workspace row, the dev command) survive a write by the Python oracle", () => {
    expect(preview("set", "--cmd", STUB).code).toBe(0);
    expect(preview("start").code).toBe(0);
    const before = readJson(join(dir, "state.json"));
    const done = Bun.spawnSync(["python3", join(SKILL, "scripts", "state.py"), dir, "set", "--now", "previewing", "--no-render"], { env, stdout: "pipe", stderr: "pipe" });
    expect([done.exitCode, done.stderr.toString()]).toEqual([0, ""]);
    const after = readJson(join(dir, "state.json"));
    expect(after["preview"]).toEqual(before["preview"]);
    expect(after["workspaces"]).toEqual(before["workspaces"]);
    expect(after["now"]).toBe("previewing");
  });
});

describe("the page's view", () => {
  test("has the preview only when the fleet has one: address, workers, conflicts", async () => {
    const m = machine(env);
    const lookups = { up: (urls: readonly string[]) => urls.map(() => false), discovered: () => [], spend: new SpendReader() };
    const shown = (): JsonObject => view(m, lookups, readJson(join(dir, "state.json")), dir);
    expect("preview" in shown()).toBe(false);

    writeFileSync(join(ws("a1"), "c.txt"), "c by a1\n");
    writeFileSync(join(ws("a2"), "c.txt"), "c by a2\n");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    await until(() => record().conflicts.length > 0);
    const p = asObject(shown()["preview"]);
    expect(p).toMatchObject({ url: "preview/", running: true, updater: true, conflicts: [{ path: "c.txt", workers: ["a1", "a2"] }] });
    expect(String(p?.["address"])).toEndWith("/f/shop/preview/");
    expect(asArray(p?.["workers"])?.map((w) => asObject(w)?.["id"])).toEqual(["a1", "a2"]);
    expect(asObject(asArray(p?.["workers"])?.[0])).toMatchObject({ id: "a1", included: true, status: "running" });
  });
});
