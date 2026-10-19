/**
 * `fleet preview`, its servers: `stop` stops what runs and never signals a pid that is no longer the
 * process recorded, `fleet ws prune` never deletes a live preview, a per-worker preview runs in that
 * worker's own workspace, and root mode gives a preview a public port of its own. Against throwaway jj
 * repos and a stand-in dev server (stub-dev.ts), as preview.test.ts.
 */
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { view } from "../src/page/view.ts";
import { readRecord, updateRecord, type PreviewRecord } from "../src/preview/record.ts";
import { startedAt } from "../src/preview/tracked.ts";
import { isRunning as alive } from "../src/preview/devserver.ts";
import { SpendReader } from "../src/transcripts.ts";
import { baseEnv, fleet, machine, readJson, sleep, tmp, type Environment } from "./support.ts";

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
  if (existsSync(join(dir, "preview.json"))) preview("stop", "--all");
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

  test("start and stop never signal a recorded pid that no longer has its recorded start time (a reboot, a reused pid)", async () => {
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(preview("stop").code).toBe(0);
    const others = [0, 1, 2].map(() => Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" }));
    await sleep(100);
    const [server, keeper, updater] = others.map((p) => [p.pid, (startedAt(p.pid) ?? 0) - 100] as const);

    const stale = (): void => {
      updateRecord(dir, (now) =>
        now === undefined || now.server === null
          ? undefined
          : {
              ...now,
              updater: updater?.[0] ?? null,
              updaterStarted: updater?.[1] ?? null,
              server: { ...now.server, pid: server?.[0] ?? null, pidStarted: server?.[1] ?? null, keeper: keeper?.[0] ?? null, keeperStarted: keeper?.[1] ?? null, asleep: null },
            },
      );
    };

    try {
      stale();
      expect(preview("start", "--cmd", STUB).code).toBe(0);
      expect(record().server?.pid).not.toBe(server?.[0]);
      expect(preview("stop").code).toBe(0);
      stale();
      expect(preview("stop").code).toBe(0);
      await sleep(300);
      expect(others.map((p) => alive(p.pid))).toEqual([true, true, true]);
    } finally {
      for (const p of others) p.kill();
    }
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
    // Its keeper wakes nothing after a crash: it records the server failed and ends.
    await until(() => (record().server?.failed ?? null) !== null);
    expect(fleet(["ws", dir, "prune", "--apply"], env).stderr).toContain("ws: kept preview: the fleet's preview is running (updater pid");

    preview("stop");
    const gone = fleet(["ws", dir, "prune", "--apply"], env);
    expect(gone.stdout).toContain(`pruned preview: ${ws("preview")} is in the trash, `);
    expect(existsSync(ws("preview"))).toBe(false);
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a1\na2\ndefault\n");
    expect(jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "merges()", "-T", "commit_id")).toBe("");
    expect(existsSync(join(dir, "preview.json"))).toBe(false);
    expect(workspaceRows().find((w) => w["id"] === "preview")?.["status"]).toBe("pruned");
  });

  test("plain stop leaves the per-worker previews running; stop --all stops them too", () => {
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(preview("start", "--per-worker", "a1", "--cmd", STUB).code).toBe(0);
    const { server, updater } = record();
    const own = record().workers.find((w) => w.worker === "a1")?.pid ?? undefined;

    const out = preview("stop");
    expect([out.code, out.stderr]).toEqual([0, ""]);
    expect(out.stdout).toContain("a1's preview still runs (`stop --all` stops it too)");
    expect(alive(server?.pid ?? undefined)).toBe(false);
    expect(alive(updater ?? undefined)).toBe(false);
    expect(alive(own)).toBe(true);
    expect(record().workers.find((w) => w.worker === "a1")?.pid).toBe(own ?? 0);

    expect(preview("stop", "--all", "--per-worker", "a1").code).not.toBe(0);
    expect(preview("stop", "--all").code).toBe(0);
    expect(alive(own)).toBe(false);
    expect(record().workers.find((w) => w.worker === "a1")?.pid).toBeNull();
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
    expect(ran.stdout).toContain(`public: port ${String(pub)}, no https address: this machine has no MagicDNS name (is Tailscale running?)`);
    expect(ran.stdout).not.toContain(`http://127.0.0.1:${String(pub)}/`);
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
    expect(own.stdout).toContain(`public: port ${String(mine)}, no https address`);
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
    expect(shown).toMatchObject({ public: record().server?.public ?? 0, public_url: null, public_error: null });
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

  test("status gives the public address in https by the machine's MagicDNS name alone, never by its address", () => {
    const tailscale = join(base, "tailscale");
    writeFileSync(tailscale, `#!/bin/sh\ncase "$1 $2" in\n  "status --json") printf '%s' '${TAILNET_STATUS}' ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(tailscale, 0o755);
    env["TAILSCALE"] = tailscale;
    env["FLEET_PREVIEW_PORTS"] = portRange().join("-");
    expect(preview("start", "--root", "--cmd", STUB).code).toBe(0);
    const pub = String(record().server?.public);
    const status = preview("status").stdout;
    expect(status).toContain(`public: https://box.example.ts.net:${pub}/; no hub runs`);
    expect(status).not.toContain("127.0.0.2");
    expect(status).not.toMatch(new RegExp(`http://[^ ]*:${pub}/`));
    expect(status).not.toContain("secure context");
  });
});
