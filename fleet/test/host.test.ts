/**
 * Which session hosts a fleet, and whether it is there to be written to (src/host.ts): the entry's process
 * runs, is Claude Code, started when the entry says, and holds the socket named after it. The rules are tried
 * on machines of this test's own (a `Probe` that answers as the case says); what the machine itself says
 * (procs.ts `runningOf`, `holdsSocket`, `startedMsOf`) is tried on this process and on children of this test,
 * with sockets in a folder of its own. The write those rules guard is in wake.test.ts.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { isHost, liveHost, PROBE, presenceOf, reach, recordedHost, runs, type Host, type Presence, type Probe } from "../src/host.ts";
import type { JsonObject } from "../src/json.ts";
import { holdsSocket, runningOf, startedMsOf, startedOf, type Running } from "../src/procs.ts";
import type { Entry } from "../src/registry.ts";
import { baseEnv, machine, now, sleep, tmp } from "./support.ts";

const LINUX = process.platform === "linux";

/** A machine that says `running` of every process, and `holds` of every socket. */
const says = (running: Running, holds: boolean | "unknown" = true): Probe => ({ running: () => running, holds: () => holds, startedMs: () => undefined });

const CLAUDE: Running = { claude: true, started: "t" };

const HOST: Host = { pid: 4242, started: "t" };

/** A host of an entry served before the start was recorded. */
const LEGACY: Host = { pid: 4242, started: undefined };

const THERE: Presence = { is: "there" };

const gone = (why: string): Presence => ({ is: "gone", why });

const entry = (raw: JsonObject): Entry => ({ id: "p", role: "coordinator", dir: "/d", url: "u", session: null, since: "s", aliases: [], raw });

const servers: Server[] = [];

const children: Bun.Subprocess[] = [];

/** Listen on a Unix socket at `path`, in this process. */
function listen(path: string): Promise<void> {
  const server = createServer(() => {});
  servers.push(server);

  return new Promise((ready) => server.listen(path, ready));
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();

  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
});

describe("the host an entry names", () => {
  test("its pid, and when that process started", () => {
    expect(recordedHost(entry({ pid: 4242, started: "53465159" }))).toEqual({ pid: 4242, started: "53465159" });
    expect(recordedHost(entry({ pid: "4242", started: "Mon Oct 12 14:00:00 2026" }))).toEqual({ pid: 4242, started: "Mon Oct 12 14:00:00 2026" });
  });

  test("an entry served before the start was recorded names its pid alone", () => {
    expect(recordedHost(entry({ pid: 4242 }))).toEqual(LEGACY);
    expect(recordedHost(entry({ pid: 4242, started: null }))).toEqual(LEGACY);
    expect(recordedHost(entry({ pid: 4242, started: "" }))).toEqual(LEGACY);
  });

  test("an entry that names no process names no host", () => {
    for (const raw of [{}, { pid: null }, { pid: 0 }, { pid: 1 }, { pid: -7 }, { pid: "x" }, { started: "t" }]) expect(recordedHost(entry(raw))).toBeUndefined();
  });
});

describe("whether a session is there", () => {
  test("there: its process runs, is Claude Code, and started when the entry says", () => {
    expect(presenceOf(HOST, says(CLAUDE))).toEqual(THERE);
    // Whose its socket is, is not asked here.
    expect(presenceOf(HOST, says(CLAUDE, false))).toEqual(THERE);
  });

  test("each way it is gone, in words for the page", () => {
    expect(presenceOf(undefined, says(CLAUDE))).toEqual(gone("the registry names no process for it"));
    expect(presenceOf(HOST, says("gone"))).toEqual(gone("its process no longer runs"));
    expect(presenceOf(HOST, says({ claude: false, started: "t" }))).toEqual(gone("process 4242 is not Claude Code"));
    expect(presenceOf(HOST, says({ claude: true, started: "later" }))).toEqual(gone("another process has its pid (4242)"));
    // Not Claude Code is said before a start that differs: the pid went to some other program.
    expect(presenceOf(HOST, says({ claude: false, started: "later" }))).toEqual(gone("process 4242 is not Claude Code"));
  });

  test("a machine that did not answer is not a session gone", () => {
    expect(presenceOf(HOST, says("unknown"))).toEqual({ is: "unknown", why: "the machine did not say whether the session's process runs" });
    expect(presenceOf(LEGACY, says("unknown")).is).toBe("unknown");
  });

  test("an entry with no recorded start is told by its pid alone: any Claude Code process with it is there", () => {
    expect(presenceOf(LEGACY, says(CLAUDE))).toEqual(THERE);
    expect(presenceOf(LEGACY, says({ claude: true, started: "whenever" }))).toEqual(THERE);
    expect(presenceOf(LEGACY, says({ claude: false, started: "t" }))).toEqual(gone("process 4242 is not Claude Code"));
    expect(presenceOf(LEGACY, says("gone"))).toEqual(gone("its process no longer runs"));
  });

  test("the machine is asked about the entry's pid, and about no other", () => {
    const asked: number[] = [];

    const probe: Probe = { ...says(CLAUDE), running: (pid) => (asked.push(pid), pid === 4242 ? CLAUDE : "gone") };

    expect([presenceOf(HOST, probe).is, presenceOf({ pid: 7, started: "t" }, probe).is]).toEqual(["there", "gone"]);
    expect(asked).toEqual([4242, 7]);
  });
});

describe("whether a session can be written to", () => {
  let socket: string;

  const at = (): string => {
    socket = join(tmp("fleet-host-"), "4242.sock");
    writeFileSync(socket, "");

    return socket;
  };

  test("it is there, its socket exists, and the socket is its own", () => {
    expect(reach(HOST, at(), says(CLAUDE))).toEqual(THERE);
    expect(reach(LEGACY, at(), says({ claude: true, started: "whenever" }))).toEqual(THERE);
  });

  test("a session that is not there is not asked about its socket", () => {
    const asked: string[] = [];

    const never = (running: Running): Probe => ({ ...says(running), holds: (_pid, path) => (asked.push(path), true) });

    expect(reach(undefined, at(), never(CLAUDE))).toEqual(gone("the registry names no process for it"));
    expect(reach(HOST, at(), never("gone"))).toEqual(gone("its process no longer runs"));
    expect(reach(HOST, at(), never({ claude: false, started: "t" }))).toEqual(gone("process 4242 is not Claude Code"));
    expect(reach(HOST, at(), never({ claude: true, started: "later" }))).toEqual(gone("another process has its pid (4242)"));
    expect(reach(HOST, at(), never("unknown")).is).toBe("unknown");
    expect(asked).toEqual([]);
    expect(reach(HOST, at(), never(CLAUDE))).toEqual(THERE);
    expect(asked).toEqual([socket]);
  });

  test("no socket, and a socket that is another process's, are a session gone", () => {
    expect(reach(HOST, undefined, says(CLAUDE))).toEqual(gone("it has no socket"));
    expect(reach(HOST, join(tmp("fleet-host-"), "4242.sock"), says(CLAUDE))).toEqual(gone("it has no socket"));
    expect(reach(HOST, at(), says(CLAUDE, false))).toEqual(gone("the socket named after it is not its own"));
  });

  test("a machine that did not say whose the socket is, is not a session gone", () => {
    expect(reach(HOST, at(), says(CLAUDE, "unknown"))).toEqual({ is: "unknown", why: "the machine did not say whose the session's socket is" });
  });
});

describe("whether the process an entry names still runs, Claude Code or not", () => {
  test("the one with its pid started when the entry says", () => {
    expect(runs(HOST, says(CLAUDE))).toBe(true);
    expect(runs(HOST, says({ claude: false, started: "t" }))).toBe(true);
    expect(runs(HOST, says({ claude: true, started: "later" }))).toBe(false);
    expect(runs(HOST, says("gone"))).toBe(false);
  });

  test("with no recorded start, any process with its pid; and a machine that did not answer counts as running", () => {
    expect(runs(LEGACY, says({ claude: false, started: "whenever" }))).toBe(true);
    expect(runs(LEGACY, says("gone"))).toBe(false);
    expect(runs(HOST, says("unknown"))).toBe(true);
    expect(runs(LEGACY, says("unknown"))).toBe(true);
  });
});

describe("whether a process is the host", () => {
  test("its pid, and its start when both are known", () => {
    expect(isHost(HOST, 4242, "t")).toBe(true);
    expect(isHost(HOST, 4242, "later")).toBe(false);
    expect(isHost(HOST, 4243, "t")).toBe(false);
    expect(isHost(HOST, 4242, null)).toBe(true);
    expect(isHost(HOST, 4242, undefined)).toBe(true);
    expect(isHost(LEGACY, 4242, "whenever")).toBe(true);
    expect(isHost(LEGACY, 4243, null)).toBe(false);
  });
});

describe("the session that hosts a served fleet now", () => {
  test("the one the registry names, only while it is there", () => {
    const base = tmp("fleet-host-");
    const root = join(base, "p", "coordinator");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "state.json"), JSON.stringify({ project: "p", status: "running" }));
    const { registry } = machine(baseEnv(join(base, "registry")));
    expect(liveHost(registry, root, says(CLAUDE))).toBeUndefined();
    const served = registry.register(root, "u", process.pid, now());
    const started = startedOf(process.pid) ?? "";
    expect(served.raw["started"]).toBe(started);
    expect(liveHost(registry, root, says({ claude: true, started }))).toEqual({ pid: process.pid, started });
    // Each way it is not there, and a machine that did not answer: no host is known, and the older rules hold.
    expect(liveHost(registry, root, says({ claude: false, started }))).toBeUndefined();
    expect(liveHost(registry, root, says({ claude: true, started: `${started}0` }))).toBeUndefined();
    expect(liveHost(registry, root, says("gone"))).toBeUndefined();
    expect(liveHost(registry, root, says("unknown"))).toBeUndefined();
    // Whose its socket is, is the write's question, not this one's.
    expect(liveHost(registry, root, says({ claude: true, started }, false))?.pid).toBe(process.pid);
    expect(liveHost(registry, join(base, "elsewhere"), says({ claude: true, started }))).toBeUndefined();

    // This machine, unfaked: the entry names this test's process, which is not Claude Code.
    if (LINUX) expect(liveHost(registry, root)).toBeUndefined();
    registry.unregister(root);
    expect(liveHost(registry, root, says({ claude: true, started }))).toBeUndefined();
  });

  test("an entry served before the start was recorded hosts by its pid alone", () => {
    const base = tmp("fleet-host-");
    const root = join(base, "p", "coordinator");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(base, "registry"), { recursive: true });
    writeFileSync(join(root, "state.json"), JSON.stringify({ project: "p", status: "running" }));
    writeFileSync(join(base, "registry", "p.json"), JSON.stringify({ id: "p", role: "coordinator", dir: root, url: "u", pid: process.pid, session: null, since: now() }));
    const { registry } = machine(baseEnv(join(base, "registry")));
    expect(liveHost(registry, root, says({ claude: true, started: "whenever" }))).toEqual({ pid: process.pid, started: undefined });
    expect(liveHost(registry, root, says({ claude: false, started: "whenever" }))).toBeUndefined();
  });
});

describe("this machine's answers", () => {
  /** A child of this test that listens on `path` and waits to be stopped, once the socket is there. */
  async function listener(path: string): Promise<number> {
    const script = 'require("node:net").createServer(() => {}).listen(process.argv[1])';
    const child = Bun.spawn([process.execPath, "-e", script, path], { stdout: "ignore", stderr: "inherit", stdin: "ignore" });
    children.push(child);

    for (let tries = 0; tries < 200 && !existsSync(path); tries += 1) await sleep(25);
    expect(existsSync(path)).toBe(true);

    return child.pid;
  }

  test.skipIf(!LINUX)("a process that runs: whether it is Claude Code, and when it started", () => {
    const mine = runningOf(process.pid);
    expect(mine).toEqual({ claude: false, started: startedOf(process.pid) ?? "" });
    expect(runningOf(process.pid)).toEqual(mine);
    expect(PROBE.running(process.pid)).toEqual(mine);
    const ms = startedMsOf(process.pid) ?? 0;
    // To the second, and before now: this process started in the last hour.
    expect([ms <= Date.now(), ms > Date.now() - 3600_000]).toEqual([true, true]);
    expect(PROBE.startedMs(process.pid)).toBe(ms);
  });

  test("a process that does not run is gone, and started at no time", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const was = runningOf(child.pid);
    expect(was).toMatchObject({ claude: false });
    child.kill("SIGKILL");
    await child.exited;
    expect(runningOf(child.pid)).toBe("gone");
    expect(startedMsOf(child.pid)).toBeUndefined();
    expect(presenceOf({ pid: child.pid, started: was === "gone" || was === "unknown" ? "" : was.started })).toEqual(gone("its process no longer runs"));
    expect(holdsSocket(child.pid, join(tmp("fleet-host-"), `${String(child.pid)}.sock`))).toBe(false);
  });

  test.skipIf(!LINUX)("this process holds a socket it listens on, and none it does not", async () => {
    const dir = tmp("fleet-host-");
    const path = join(dir, `${String(process.pid)}.sock`);
    expect(holdsSocket(process.pid, path)).toBe(false);
    await listen(path);
    expect(holdsSocket(process.pid, path)).toBe(true);
    expect(PROBE.holds(process.pid, path)).toBe(true);
    // The same name in another folder, and another name in the same one, are other sockets.
    expect(holdsSocket(process.pid, join(tmp("fleet-host-"), `${String(process.pid)}.sock`))).toBe(false);
    expect(holdsSocket(process.pid, join(dir, "1.sock"))).toBe(false);
  });

  test.skipIf(!LINUX)("a socket at a path longer than a socket address holds (108 bytes) is held too", async () => {
    const dir = join(tmp("fleet-host-"), "a-folder-whose-name-is-long".repeat(4));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${String(process.pid)}.sock`);
    expect(Buffer.byteLength(path)).toBeGreaterThan(108);
    await listen(path);
    expect(existsSync(path)).toBe(true);
    expect(holdsSocket(process.pid, path)).toBe(true);
    expect(holdsSocket(process.pid, join(dir, "1.sock"))).toBe(false);
    // The name alone is not the socket: a short path of that name is compared whole, and a file is no socket.
    const short = join(tmp("fh-"), `${String(process.pid)}.sock`);
    expect(Buffer.byteLength(short)).toBeLessThan(108);
    writeFileSync(short, "");
    expect(holdsSocket(process.pid, short)).toBe(false);
    const elsewhere = join(tmp("fleet-host-"), "another-folder-whose-name-is-long".repeat(4));
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, `${String(process.pid)}.sock`), "");
    expect(holdsSocket(process.pid, join(elsewhere, `${String(process.pid)}.sock`))).toBe(false);
  });

  test.skipIf(!LINUX)("a socket another process listens on is that process's, whatever pid its name carries", async () => {
    const path = join(tmp("fleet-host-"), `${String(process.pid)}.sock`);
    const other = await listener(path);
    expect(holdsSocket(process.pid, path)).toBe(false);
    expect(holdsSocket(other, path)).toBe(true);
    // The whole check, on this machine: the socket is there, and it is not the session's own.
    const started = startedOf(process.pid) ?? "";
    const claude: Probe = { ...PROBE, running: () => ({ claude: true, started }) };
    expect(reach({ pid: process.pid, started }, path, claude)).toEqual(gone("the socket named after it is not its own"));
    expect(reach({ pid: other, started: undefined }, path, claude)).toEqual(THERE);
  });

  test.skipIf(!LINUX)("a plain file named after a pid is no socket anyone holds", () => {
    const path = join(tmp("fleet-host-"), `${String(process.pid)}.sock`);
    writeFileSync(path, "");
    expect(holdsSocket(process.pid, path)).toBe(false);
    const started = startedOf(process.pid) ?? "";
    expect(reach({ pid: process.pid, started }, path, { ...PROBE, running: () => ({ claude: true, started }) })).toEqual(gone("the socket named after it is not its own"));
  });
});
