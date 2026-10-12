/**
 * Whose a chat watch is (src/chat/watchers.ts): a watch whose session is gone hears for nobody, so it is no
 * live watch. The rule is tried on process trees of this test's own, in the shapes measured on Linux with
 * Claude Code 2.1.293 (2026-10-12): a watch armed as a background command is the child of a `zsh -c` wrapper
 * under `claude`, neither with a terminal; when the session dies the wrapper is given to pid 1. And a watch as
 * the host's role that another session armed, or none, hears for someone who is not the fleet's host (`foreign`):
 * it is no live watch either, once the registry names a host that is there. The takeover itself runs real
 * watches in chat.test.ts; the plugin's hook keeps the same rules (test_tstack_hook.py).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { foreign, liveWatch, orphaned, ownerPath, ownerWords, readOwner, sessionAbove, TREE, type Owner, type Tree } from "../src/chat/watchers.ts";
import type { Host } from "../src/host.ts";
import { hasTerminal, parentOf, startedOf } from "../src/procs.ts";
import { tmp } from "./support.ts";

/** A process of a fake tree. */
interface Fake {
  readonly parent: number;
  readonly started?: string;
  readonly claude?: boolean;
  readonly terminal?: boolean;
}

function treeOf(procs: Readonly<Record<number, Fake>>): Tree {
  return {
    parent: (pid) => procs[pid]?.parent,
    started: (pid) => (procs[pid] === undefined ? undefined : (procs[pid].started ?? `t${String(pid)}`)),
    claude: (pid) => procs[pid]?.claude === true,
    terminal: (pid) => procs[pid]?.terminal === true,
  };
}

const WATCH = 300;

/** A session's background command: `claude` (100) > `zsh -c` (200) > the watch (300), under a terminal's shell (50). */
const ARMED = { 50: { parent: 1, terminal: true }, 100: { parent: 50, claude: true, terminal: true }, 200: { parent: 100 }, 300: { parent: 200 } };

/** The same after the session died: the wrapper is given to pid 1. */
const ORPHAN = { 50: { parent: 1, terminal: true }, 200: { parent: 1 }, 300: { parent: 200 } };

/** A watch a person typed in a terminal: no Claude Code process above it, and a terminal. */
const TYPED = { 50: { parent: 1, terminal: true }, 300: { parent: 50, terminal: true } };

const owner = (session: number | null, started: string | null = session === null ? null : `t${String(session)}`): Owner => ({ watch: WATCH, session, started });

describe("the session above a watch", () => {
  test("the nearest Claude Code process, through the wrapper shell, with when it started", () => {
    expect(sessionAbove(WATCH, treeOf(ARMED))).toEqual({ pid: 100, started: "t100" });
    expect(sessionAbove(WATCH, treeOf(ORPHAN))).toBeUndefined();
    expect(sessionAbove(WATCH, treeOf(TYPED))).toBeUndefined();
    expect(sessionAbove(WATCH, treeOf({ 100: { parent: 1, claude: true }, 150: { parent: 100, claude: true }, 300: { parent: 150 } }))?.pid).toBe(150);
    expect(sessionAbove(999, treeOf(ARMED))).toBeUndefined();
  });

  test("a chain that never ends is walked 32 parents and no further", () => {
    expect(sessionAbove(2, treeOf({ 2: { parent: 3 }, 3: { parent: 2 } }))).toBeUndefined();
  });
});

describe("a watch whose session is gone", () => {
  test("one that recorded its session is orphaned when that process is gone, or another has its pid", () => {
    expect(orphaned(WATCH, owner(100), treeOf(ARMED))).toBe(false);
    expect(orphaned(WATCH, owner(100), treeOf(ORPHAN))).toBe(true);
    expect(orphaned(WATCH, owner(100, "t-earlier"), treeOf(ARMED))).toBe(true);
    // A session that lives is enough, wherever the watch hangs now.
    expect(orphaned(WATCH, owner(100), treeOf({ ...ORPHAN, 100: { parent: 50, claude: true } }))).toBe(false);
  });

  test("one that recorded no session, armed by a person in a terminal, is never orphaned", () => {
    expect(orphaned(WATCH, owner(null), treeOf(TYPED))).toBe(false);
    expect(orphaned(WATCH, owner(null), treeOf(ORPHAN))).toBe(false);
  });

  test("one with no record of its own goes by its tree: no terminal and no Claude Code process above it", () => {
    expect(orphaned(WATCH, undefined, treeOf(ARMED))).toBe(false);
    expect(orphaned(WATCH, undefined, treeOf(ORPHAN))).toBe(true);
    expect(orphaned(WATCH, undefined, treeOf(TYPED))).toBe(false);
    // Another watch's record says nothing of this one.
    expect(orphaned(WATCH, { watch: 301, session: 100, started: "t100" }, treeOf(ORPHAN))).toBe(true);
    expect(orphaned(WATCH, { watch: 301, session: null, started: null }, treeOf(ARMED))).toBe(false);
  });

  test("whose a held watch is, for the watch refused because of it: nothing to kill", () => {
    expect(ownerWords(WATCH, owner(100), treeOf(ARMED))).toBe("armed by the Claude Code session running as pid 100, which is live: its lines wake that session");
    expect(ownerWords(WATCH, undefined, treeOf(ARMED))).toBe("armed by the Claude Code session running as pid 100, which is live: its lines wake that session");
    expect(ownerWords(WATCH, owner(null), treeOf(TYPED))).toBe("armed outside a Claude Code session (in a terminal) and still running: its lines print there");
  });
});

describe("a watch as the host's role that is not the host's", () => {
  /** The fleet's host, as the registry names it: the session of {@link ARMED}. */
  const HOST: Host = { pid: 100, started: "t100" };

  /** A copy of the host (a fork, a second resume of its transcript): another `claude` (110) with a watch of its own. */
  const COPY = { ...ARMED, 110: { parent: 50, claude: true, terminal: true }, 200: { parent: 110 } };

  test("one that recorded its session is the host's when that session is the host, by pid and by start", () => {
    expect(foreign(WATCH, owner(100), HOST, treeOf(ARMED))).toBe(false);
    // Its own record says whose it is, wherever it hangs now and whatever runs above it.
    expect(foreign(WATCH, owner(100), HOST, treeOf(ORPHAN))).toBe(false);
    expect(foreign(WATCH, owner(100), HOST, treeOf(COPY))).toBe(false);
    expect(foreign(WATCH, owner(110), HOST, treeOf(COPY))).toBe(true);
    expect(foreign(WATCH, owner(110), HOST, treeOf(ARMED))).toBe(true);
    // Another process had the host's pid when it was armed.
    expect(foreign(WATCH, owner(100, "t-earlier"), HOST, treeOf(ARMED))).toBe(true);
  });

  test("one that recorded no session was armed in a terminal: it is nobody's the fleet knows", () => {
    expect(foreign(WATCH, owner(null), HOST, treeOf(TYPED))).toBe(true);
    expect(foreign(WATCH, owner(null), HOST, treeOf(ARMED))).toBe(true);
  });

  test("one with no record of its own goes by the Claude Code process above it: the host, another session, none", () => {
    expect(foreign(WATCH, undefined, HOST, treeOf(ARMED))).toBe(false);
    expect(foreign(WATCH, undefined, HOST, treeOf(COPY))).toBe(true);
    expect(foreign(WATCH, undefined, HOST, treeOf(TYPED))).toBe(true);
    expect(foreign(WATCH, undefined, HOST, treeOf(ORPHAN))).toBe(true);
    // Another watch's record says nothing of this one.
    expect(foreign(WATCH, { watch: 301, session: 110, started: "t110" }, HOST, treeOf(ARMED))).toBe(false);
    expect(foreign(WATCH, { watch: 301, session: 100, started: "t100" }, HOST, treeOf(COPY))).toBe(true);
  });

  test("a start that is not the host's is another process with its pid, in the record or above the watch", () => {
    const reused = treeOf({ ...ARMED, 100: { parent: 50, claude: true, terminal: true, started: "t-later" } });
    expect(foreign(WATCH, undefined, HOST, reused)).toBe(true);
    expect(foreign(WATCH, undefined, { pid: 100, started: "t-later" }, reused)).toBe(false);
    expect(foreign(WATCH, owner(100, "t-later"), HOST, treeOf(ARMED))).toBe(true);
    // A record with no start, and a host served before the start was recorded, are told by the pid alone.
    expect(foreign(WATCH, owner(100, null), HOST, treeOf(ARMED))).toBe(false);
    expect(foreign(WATCH, owner(100, "whenever"), { pid: 100, started: undefined }, treeOf(ARMED))).toBe(false);
    expect(foreign(WATCH, undefined, { pid: 100, started: undefined }, reused)).toBe(false);
    expect(foreign(WATCH, owner(110, "whenever"), { pid: 100, started: undefined }, treeOf(COPY))).toBe(true);
  });

  test("with no host known, no watch is foreign: the older rules hold", () => {
    for (const tree of [ARMED, COPY, TYPED, ORPHAN]) {
      for (const record of [undefined, owner(100), owner(110), owner(null), owner(100, "t-earlier")]) expect(foreign(WATCH, record, undefined, treeOf(tree))).toBe(false);
    }
  });
});

describe("the live watch of a fleet's host", () => {
  const watches: Bun.Subprocess[] = [];

  afterEach(async () => {
    for (const watch of watches.splice(0)) {
      watch.kill("SIGKILL");
      await watch.exited;
    }
  });

  /** A process of this test whose command line is a `--once` watch's as the coordinator of `root`. */
  function watching(root: string): number {
    const proc = Bun.spawn(["python3", "-c", "import time; time.sleep(60)", "chat", root, "watch", "--as", "coordinator", "--all", "--resume", "--once"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    watches.push(proc);

    return proc.pid;
  }

  /** The watch's record: armed by `session`, which started at `t<session>`. */
  function record(root: string, watch: number, session: number | null): void {
    writeFileSync(ownerPath(root, "coordinator"), JSON.stringify({ watch, session, started: session === null ? null : `t${String(session)}` }));
  }

  /** Two sessions that live, the host (100) and a copy of it (110); the watch itself is found on this machine. */
  const SESSIONS = treeOf({ 100: { parent: 1, claude: true }, 110: { parent: 1, claude: true } });

  const HOST: Host = { pid: 100, started: "t100" };

  test("the host's own watch is live; one a copy of the host armed, or a terminal, is not, by its pid file or among the processes", () => {
    const root = tmp();
    const pid = watching(root);
    record(root, pid, 100);
    expect(liveWatch(root, "coordinator", pid, SESSIONS, HOST)).toBe(pid);
    expect(liveWatch(root, "coordinator", undefined, SESSIONS, HOST)).toBe(pid);
    record(root, pid, 110);
    expect(liveWatch(root, "coordinator", pid, SESSIONS, HOST)).toBeUndefined();
    expect(liveWatch(root, "coordinator", undefined, SESSIONS, HOST)).toBeUndefined();
    // Once the fleet is moved to that session (`fleet serve --take-over`), the watch is its host's.
    expect(liveWatch(root, "coordinator", pid, SESSIONS, { pid: 110, started: "t110" })).toBe(pid);
    record(root, pid, null);
    expect(liveWatch(root, "coordinator", pid, SESSIONS, HOST)).toBeUndefined();
  });

  test("with no host known a watch is live whoever armed it, unless its session is gone", () => {
    const root = tmp();
    const pid = watching(root);

    for (const session of [100, 110, null]) {
      record(root, pid, session);
      expect(liveWatch(root, "coordinator", pid, SESSIONS)).toBe(pid);
      expect(liveWatch(root, "coordinator", pid, SESSIONS, undefined)).toBe(pid);
    }

    record(root, pid, 120);
    expect(liveWatch(root, "coordinator", pid, SESSIONS)).toBeUndefined();
    // Gone is gone, host or not: the host's own orphan hears for nobody.
    expect(liveWatch(root, "coordinator", pid, SESSIONS, { pid: 120, started: "t120" })).toBeUndefined();
  });

  test("a watch as another role, or for another fleet, is not the one asked about", () => {
    const root = tmp();
    const pid = watching(root);
    record(root, pid, 100);
    expect(liveWatch(root, "manager", pid, SESSIONS, HOST)).toBeUndefined();
    expect(liveWatch(tmp(), "coordinator", pid, SESSIONS, HOST)).toBeUndefined();
    expect(liveWatch(root, "coordinator", process.pid, SESSIONS, HOST)).toBe(pid);
  });
});

describe("the record beside the pid file", () => {
  test("it is read as written, and one that does not read is no record", () => {
    const root = tmp();
    mkdirSync(root, { recursive: true });
    expect(ownerPath(root, "coordinator")).toBe(join(root, "watch-coordinator.owner.pid"));
    expect(readOwner(root, "coordinator")).toBeUndefined();
    writeFileSync(ownerPath(root, "coordinator"), '{"watch": 300, "session": 100, "started": "52856946"}\n');
    expect(readOwner(root, "coordinator")).toEqual({ watch: 300, session: 100, started: "52856946" });
    writeFileSync(ownerPath(root, "coordinator"), '{"watch": 300, "session": null, "started": null}\n');
    expect(readOwner(root, "coordinator")).toEqual({ watch: 300, session: null, started: null });
    writeFileSync(ownerPath(root, "coordinator"), "300");
    expect(readOwner(root, "coordinator")).toBeUndefined();
    expect(readFileSync(ownerPath(root, "coordinator"), "utf8")).toBe("300");
  });
});

describe("this machine's processes", () => {
  test("a process's parent and start are read, and a process that does not run has neither", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });

    try {
      expect(parentOf(child.pid)).toBe(process.pid);
      const started = startedOf(child.pid);
      expect(started).toMatch(/\S/u);
      expect(startedOf(child.pid)).toBe(started);
      expect(TREE.claude(child.pid)).toBe(false);
      expect(hasTerminal(child.pid)).toBe(hasTerminal(process.pid));
    } finally {
      child.kill();
      await child.exited;
    }

    expect([parentOf(child.pid), startedOf(child.pid), hasTerminal(child.pid)]).toEqual([undefined, undefined, false]);
  });
});
