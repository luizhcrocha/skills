/**
 * The preview's idle sleep (D160), through `fleet preview` and the hub: a per-worker dev server no request
 * reaches for `FLEET_PREVIEW_IDLE_S` is stopped and recorded asleep; the next request through the hub gets
 * the "starting" page and wakes it, with the same command, port and environment; a server named in
 * `FLEET_PREVIEW_AWAKE` (by worker, by public port; 7501 by default) never sleeps; Vite's ping wakes nothing.
 *
 * And what the review of it found (D163): a pid is signalled only while it still has its recorded start
 * time; a keeper that is gone, a wake that fails, a server that crashes are said, not looped on; WebSocket
 * frames are use, Vite's pings are not; `stop` racing a wake and `serve --stop` leave nothing running.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { isPingFrame } from "../src/hub/preview-proxy.ts";
import type { ProcRow } from "../src/orphans.ts";
import { isRunning } from "../src/preview/devserver.ts";
import { readRecord, updateRecord, type WorkerServer } from "../src/preview/record.ts";
import { awakeNames, exempt, FAILED_LINES } from "../src/preview/sleep.ts";
import { lstartOf, runs, startedAt, treeRows } from "../src/preview/tracked.ts";
import { startHub, type Running } from "../src/hub/server.ts";
import { baseEnv, fleet, machine, sleep, spawnFleet, tmp, type Environment } from "./support.ts";

setDefaultTimeout(60_000);

const STUB = `${process.execPath} ${join(import.meta.dir, "stub-dev.ts")} {port} {base}`;

let base: string;

let dir: string;

let env: Environment;

let hub: Running | undefined;

let hubPort: number;

function jj(at: string, ...args: string[]): void {
  const done = Bun.spawnSync(["jj", "-R", at, "--color=never", ...args], { stdout: "pipe", stderr: "pipe" });

  if (done.exitCode !== 0) throw new Error(`jj ${args.join(" ")}: ${done.stderr.toString()}`);
}

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const got = probe.port ?? 0;
  void probe.stop(true);

  return got;
}

function a1(): WorkerServer {
  const w = readRecord(dir)?.workers.find((x) => x.worker === "a1");

  if (w === undefined) throw new Error("no preview of a1");

  return w;
}

async function until(ready: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(100);
  }
}

const viaHub = (path: string, headers: Record<string, string> = {}): Promise<Response> => fetch(`http://127.0.0.1:${hubPort}/f/shop/preview/a1/${path}`, { headers });

beforeEach(async () => {
  base = tmp("fleet-preview-sleep-");
  const repo = join(base, "repo");
  Bun.spawnSync(["jj", "git", "init", repo], { stdout: "ignore", stderr: "ignore" });
  writeFileSync(join(repo, "a.txt"), "base\n");
  jj(repo, "describe", "-m", "base");
  jj(repo, "new");
  dir = join(base, "fleet");
  const tailscale = join(base, "tailscale");
  writeFileSync(tailscale, "#!/bin/sh\nexit 1\n");
  chmodSync(tailscale, 0o755);
  env = baseEnv(join(base, "registry"), { TZ: "UTC", TAILSCALE: tailscale, FLEET_PREVIEW_S: "0.2", FLEET_PREVIEW_WAIT_S: "10", FLEET_PREVIEW_IDLE_S: "1.5" });

  for (const args of [["init", "--project", "shop", "--goal", "g"], ["milestone", "m1", "--title", "M"], ["agent", "a1", "--task", "t", "--milestone", "m1", "--lane", "a.txt"]]) {
    expect(fleet(["state", dir, ...args, "--no-render"], env).code).toBe(0);
  }

  expect(fleet(["ws", dir, "add", "a1", "--repo", repo], env).code).toBe(0);
  expect(fleet(["serve", dir, "--pid", String(process.pid)], env).code).toBe(0);
  hubPort = freePort();
  const started = await startHub({ port: hubPort, machine: machine(env), tailscale, peers: false, hosts: [], https: undefined }, () => {});

  if (started instanceof Error) throw started;
  hub = started;
});

afterEach(async () => {
  if (existsSync(join(dir, "preview.json"))) fleet(["preview", dir, "stop", "--all"], env);
  await hub?.stop();
});

describe("a dev server with no request", () => {
  test("is stopped by its process group after the idle time and recorded asleep; requests keep it awake", async () => {
    const ran = fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], env);
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    const first = a1();
    expect(isRunning(first.keeper)).toBe(true);
    expect(first.asleep).toBeNull();

    for (let i = 0; i < 6; i += 1) {
      expect((await viaHub("a.txt")).status).toBe(200);
      await sleep(400);
    }

    expect(a1().pid).toBe(first.pid);
    await until(() => a1().asleep !== null);
    expect(a1().pid).toBeNull();
    expect(isRunning(first.pid)).toBe(false);
    expect(fleet(["preview", dir, "status"], env).stdout).toContain("asleep, port");
  });
});

describe("the next request", () => {
  test("gets the starting page and wakes the server with the same command and port; then it is served", async () => {
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], env).code).toBe(0);
    const first = a1();
    await until(() => a1().asleep !== null);

    const page = await viaHub("index.html", { Accept: "text/html" });
    expect(page.status).toBe(503);
    expect(page.headers.get("Retry-After")).toBe("2");
    expect(await page.text()).toContain('http-equiv="refresh"');

    await until(() => a1().pid !== null && a1().asleep === null);
    const woken = a1();
    expect(woken.pid).not.toBe(first.pid);
    expect([woken.cmd, woken.port, woken.keeper]).toEqual([first.cmd, first.port, first.keeper]);
    let res = await viaHub("a.txt");

    for (let i = 0; res.status !== 200 && i < 50; i += 1) {
      await sleep(100);
      res = await viaHub("a.txt");
    }

    expect([res.status, await res.text()]).toEqual([200, "base\n"]);
  });

  test("wakes it in the environment `start` ran in", async () => {
    const cmd = `${process.execPath} ${join(import.meta.dir, "env-dev.ts")} {port} FLEET_TEST_SECRET`;
    const secret = { ...env, FLEET_TEST_SECRET: "from op run" };
    expect(spawnFleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", cmd], secret).code).toBe(0);
    await until(() => a1().asleep !== null);
    expect((await viaHub("")).status).toBe(503);
    await until(() => a1().pid !== null && a1().asleep === null);
    let res = await viaHub("");

    for (let i = 0; res.status !== 200 && i < 50; i += 1) {
      await sleep(100);
      res = await viaHub("");
    }

    expect(await res.text()).toBe("from op run");
  });

  test("Vite's ping is answered without waking it", async () => {
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], env).code).toBe(0);
    await until(() => a1().asleep !== null);
    expect((await viaHub("", { Accept: "text/x-vite-ping" })).status).toBe(503);
    await sleep(1500);
    expect(a1().pid).toBeNull();
  });

  test("stop stops the keeper too, and a stopped server is not woken", async () => {
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], env).code).toBe(0);
    const keeper = a1().keeper;
    await until(() => a1().asleep !== null);
    expect(fleet(["preview", dir, "stop", "--per-worker", "a1"], env).code).toBe(0);
    expect(isRunning(keeper)).toBe(false);
    expect((await viaHub("a.txt")).status).toBe(502);
  });
});

describe("the exemption", () => {
  test("a server named in FLEET_PREVIEW_AWAKE, by worker or public port, gets no keeper and never sleeps", async () => {
    const awake: Environment = { ...env, FLEET_PREVIEW_AWAKE: "7501, a1" };
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], awake).code).toBe(0);
    const w = a1();
    expect(w.keeper).toBeNull();
    await sleep(3000);
    expect(isRunning(a1().pid)).toBe(true);
    expect(a1().asleep).toBeNull();

    const read = (name: string): string | undefined => awake[name];
    expect(exempt(read, { public: 7501 }, "a2")).toBe(true);
    expect(exempt(read, { public: 7503 }, "a2")).toBe(false);
  });

  test("by default the main preview's port 7501 is exempt and the others are not; FLEET_PREVIEW_IDLE_S=0 turns sleep off", () => {
    const none = (): undefined => undefined;
    expect(awakeNames(none)).toEqual(["7501"]);
    expect(exempt(none, { public: 7501 }, undefined)).toBe(true);
    expect(exempt(none, { public: 7506 }, "a257")).toBe(false);
    expect(exempt(none, { public: null }, undefined)).toBe(false);
    const off = { ...env, FLEET_PREVIEW_IDLE_S: "0" };
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], off).code).toBe(0);
    expect(a1().keeper).toBeNull();
  });
});

/** A process of this test's own that a stale record names: `sleep 300`, killed by the test at its end. */
function victim(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
}

/** Wait for the page a browser gets from a1's preview, until it is not the starting page. */
async function settledPage(): Promise<Response> {
  let page = await viaHub("", { Accept: "text/html" });

  for (let i = 0; page.status === 503 && i < 300; i += 1) {
    await sleep(100);
    page = await viaHub("", { Accept: "text/html" });
  }

  return page;
}

describe("a pid recorded with its start time", () => {
  test("is signalled by start and stop only while it still has that start time; a reused keeper pid is a stopped keeper to the hub", async () => {
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], env).code).toBe(0);
    expect(fleet(["preview", dir, "stop", "--per-worker", "a1"], env).code).toBe(0);
    const keeper = victim();
    const server = victim();
    await sleep(100);
    const was = (pid: number): number => (startedAt(pid) ?? 0) - 100;
    updateRecord(dir, (now) => (now === undefined ? undefined : { ...now, workers: now.workers.map((w) => ({ ...w, keeper: keeper.pid, keeperStarted: was(keeper.pid), pid: null, pidStarted: null, asleep: "2026-01-01T00:00:00+00:00" })) }));

    try {
      const page = await viaHub("", { Accept: "text/html" });
      const body = await page.text();
      expect(page.status).toBe(502);
      expect(body).toContain(`The keeper of a1&#39;s preview (pid ${keeper.pid}) has stopped`);
      expect(body).toContain(`fleet preview ${dir} start --per-worker a1`);
      expect(body).not.toContain("http-equiv");
      expect(fleet(["preview", dir, "status"], env).stdout).toContain("is gone, so nothing wakes it");

      expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], env).code).toBe(0);
      await sleep(300);
      expect(isRunning(keeper.pid)).toBe(true);
      const started = a1();
      expect(fleet(["preview", dir, "stop", "--per-worker", "a1"], env).code).toBe(0);
      expect([isRunning(started.pid), isRunning(started.keeper)]).toEqual([false, false]);

      updateRecord(dir, (now) => (now === undefined ? undefined : { ...now, workers: now.workers.map((w) => ({ ...w, keeper: keeper.pid, keeperStarted: was(keeper.pid), pid: server.pid, pidStarted: was(server.pid) })) }));
      expect(fleet(["preview", dir, "stop", "--per-worker", "a1"], env).code).toBe(0);
      await sleep(300);
      expect([isRunning(keeper.pid), isRunning(server.pid)]).toEqual([true, true]);

      // A record from before start times were kept proves nothing about a keeper, and a server only by the second it was recorded.
      updateRecord(dir, (now) => (now === undefined ? undefined : { ...now, workers: now.workers.map((w) => ({ ...w, keeper: keeper.pid, keeperStarted: null, pid: server.pid, pidStarted: null, started: "2026-01-01T00:00:00+00:00" })) }));
      expect(fleet(["preview", dir, "stop", "--per-worker", "a1"], env).code).toBe(0);
      await sleep(300);
      expect([isRunning(keeper.pid), isRunning(server.pid)]).toEqual([true, true]);
    } finally {
      keeper.kill();
      server.kill();
    }
  });

  test("runs, treeRows and lstartOf: the same process by its start time; its children and its session's members, never another's", () => {
    const now = startedAt(process.pid) ?? 0;
    expect(runs({ pid: process.pid, started: now, unit: null })).toBe(true);
    expect(runs({ pid: process.pid, started: now - 100, unit: null })).toBe(false);
    expect(runs({ pid: process.pid, started: null, unit: null })).toBe(false);

    const row = (pid: number, ppid: number, started: number, sid: number): ProcRow => ({ pid, ppid, started, sid, rss: 0, comm: "x", command: "x" });
    const table = [row(100, 1, 50, 100), row(101, 100, 51, 100), row(102, 1, 52, 100), row(103, 1, 53, 103), row(104, 103, 54, 103)];
    expect(treeRows({ pid: 100, started: 50, unit: null }, table).map((r) => r.pid)).toEqual([100, 101, 102]);
    expect(treeRows({ pid: 100, started: 40, unit: null }, table)).toEqual([]);
    expect(treeRows({ pid: 100, started: null, unit: null }, table)).toEqual([]);

    expect(lstartOf("Mon Oct 12 14:34:03 2026")).toBe(new Date(2026, 9, 12, 14, 34, 3).getTime() / 1000);
    expect(lstartOf("Tue Feb  3 09:05:00 2026")).toBe(new Date(2026, 1, 3, 9, 5, 0).getTime() / 1000);
    expect(lstartOf("not a time")).toBeUndefined();
  });
});

describe("a server that does not come up", () => {
  test("a wake that fails is tried 4 times, then recorded failed with its log; the page says so without reloading, and status says failed", async () => {
    const flag = join(base, "fail");
    const cmd = `test -f ${flag} && { echo boom-on-wake; exit 1; }; exec ${STUB}`;
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", cmd], env).code).toBe(0);
    await until(() => a1().asleep !== null);
    writeFileSync(flag, "");
    expect((await viaHub("", { Accept: "text/html" })).status).toBe(503);
    await until(() => a1().failed !== null, 30_000);

    const w = a1();
    expect([w.pid, w.keeper, w.asleep]).toEqual([null, null, null]);
    expect(w.failed?.why).toContain("it could not start (4 tries)");
    expect(w.failed?.log).toContain("boom-on-wake");
    expect((w.failed?.log ?? "").split("\n").length).toBeLessThanOrEqual(FAILED_LINES);
    expect(readFileSync(join(dir, "preview", "keeper-a1.log"), "utf8")).toContain("try 4 of 4 failed");

    const page = await viaHub("", { Accept: "text/html" });
    const body = await page.text();
    expect(page.status).toBe(502);
    expect(body).toContain("couldn&#39;t start");
    expect(body).toContain("boom-on-wake");
    expect(body).toContain(`fleet preview ${dir} start --per-worker a1`);
    expect(body).not.toContain("http-equiv");
    expect(page.headers.get("Retry-After")).toBeNull();

    const status = fleet(["preview", dir, "status"], env).stdout;
    expect(status).toContain("preview of a1:");
    expect(status).toContain("(failed)");
    expect(status).toContain("failed, port");
    expect(status).toContain("boom-on-wake");
    expect(status).not.toContain("sleeps after");

    // A new start clears it.
    rmFlag(flag);
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", cmd], env).code).toBe(0);
    expect(a1().failed).toBeNull();
  });

  test("a port taken while it sleeps ends in failed, never the starting page forever", async () => {
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], env).code).toBe(0);
    await until(() => a1().asleep !== null);
    const squat = Bun.serve({ hostname: "127.0.0.1", port: a1().port, fetch: () => new Response("squatter") });

    try {
      await viaHub("", { Accept: "text/html" });
      await until(() => a1().failed !== null, 30_000);
      const page = await settledPage();
      expect(page.status).toBe(502);
      expect(await page.text()).toContain("couldn&#39;t start");
    } finally {
      void squat.stop(true);
    }
  });

  test("a server that crashes while awake is recorded failed, not asleep", async () => {
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], env).code).toBe(0);
    const pid = a1().pid ?? 0;
    process.kill(pid, "SIGKILL");
    await until(() => a1().failed !== null);
    expect(a1().failed?.why).toBe("it exited while it ran");
    expect(a1().asleep).toBeNull();
    const status = fleet(["preview", dir, "status"], env).stdout;
    expect(status).toContain("failed, port");
    expect(status).not.toContain("sleeps after");
    expect(status).not.toContain("asleep");
  });
});

function rmFlag(path: string): void {
  Bun.spawnSync(["rm", "-f", path]);
}

describe("WebSocket traffic", () => {
  test("frames either way keep a server awake; Vite's pings do not, and the socket is closed cleanly when it sleeps", async () => {
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], env).code).toBe(0);
    const first = a1().pid;
    const socket = new WebSocket(`ws://127.0.0.1:${hubPort}/f/shop/preview/a1/`, ["vite-hmr"]);
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });

    for (let i = 0; i < 12; i += 1) {
      socket.send(`hello ${i}`);
      await sleep(300);
    }

    expect([a1().pid, a1().asleep]).toEqual([first, null]);

    const pinging = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}');
    }, 200);

    try {
      await until(() => a1().asleep !== null);
      const end = await closed;
      expect([end.wasClean, end.code]).toEqual([true, 1001]);
    } finally {
      clearInterval(pinging);
    }

    expect(isPingFrame('{"type":"ping"}')).toBe(true);
    expect(isPingFrame('{ "type": "ping" }')).toBe(true);
    expect(isPingFrame('{"type":"update","updates":[]}')).toBe(false);
    expect(isPingFrame(new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("stopping", () => {
  test("stop racing a wake leaves no server the keeper started", async () => {
    const pids = join(base, "pids");
    const cmd = `echo $$ >> ${pids}; exec ${STUB}`;

    for (const wait of [0, 150, 400]) {
      expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", cmd], env).code).toBe(0);
      await until(() => a1().asleep !== null);
      await viaHub("", { Accept: "text/html" });
      await sleep(wait);
      expect(fleet(["preview", dir, "stop", "--per-worker", "a1"], env).code).toBe(0);
      await sleep(600);
      const started = readFileSync(pids, "utf8").trim().split("\n").map(Number);
      expect(started.filter((pid) => isRunning(pid))).toEqual([]);
    }
  });

  test("fleet serve --stop stops the fleet's keepers and the servers they keep", async () => {
    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], env).code).toBe(0);
    const { pid, keeper } = a1();
    const ran = fleet(["serve", dir, "--stop"], env);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("stopped the previews that sleep when idle, with their keepers: a1");
    expect([isRunning(pid), isRunning(keeper)]).toEqual([false, false]);
    expect([a1().pid, a1().keeper]).toEqual([null, null]);
  });

  test("in a systemd user scope where there is one: the server and its keeper each in a scope of their own, stopped by it", () => {
    const bin = join(base, "bin");
    const scopes = join(base, "scopes");
    mkdirSync(bin);
    mkdirSync(scopes);
    writeFileSync(join(bin, "systemd-run"), `#!/bin/sh\nwhile [ "$1" != "--" ]; do [ "$1" = --unit ] && unit=$2; shift; done; shift\necho $$ > ${scopes}/$unit\nexec "$@"\n`);
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh\n[ "$2" = show ] && exit 0\nu=\${3%.scope}; echo "stop $u" >> ${scopes}/log\nkill -TERM -- -$(cat ${scopes}/$u) 2>/dev/null; sleep 0.3; exit 0\n`);
    chmodSync(join(bin, "systemd-run"), 0o755);
    chmodSync(join(bin, "systemctl"), 0o755);
    const scoped: Environment = { ...env, FLEET_PREVIEW_SCOPE: "1", PATH: `${bin}:${env["PATH"] ?? ""}` };

    expect(fleet(["preview", dir, "start", "--per-worker", "a1", "--cmd", STUB], scoped).code).toBe(0);
    const w = a1();
    expect(w.unit).toMatch(/^fleet-preview-a1-[0-9a-f]{8}$/);
    expect(w.keeperUnit).toMatch(/^fleet-preview-keeper-a1-[0-9a-f]{8}$/);
    expect(readFileSync(join(scopes, w.unit ?? ""), "utf8").trim()).toBe(String(w.pid));
    expect(fleet(["preview", dir, "stop", "--per-worker", "a1"], scoped).code).toBe(0);
    expect(readFileSync(join(scopes, "log"), "utf8")).toContain(`stop ${w.keeperUnit ?? ""}\nstop ${w.unit ?? ""}\n`);
    expect([isRunning(w.pid), isRunning(w.keeper)]).toEqual([false, false]);
  });
});
