import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe as describeOrphan, fleetOfCwd, isInteractive, isShellRun, isTestOrDev, liveSessionsOf, minAgeOf, orphansIn, processTable, programNames, psTable, stopOrphan, stopTree, type BeatOf, type ProcRow } from "../src/orphans.ts";
import type { Entry } from "../src/registry.ts";
import { tmp } from "./support.ts";

const NOW = 1_800_000_000;

const HOURS = 3600;

function row(pid: number, ppid: number, command: string, more: Partial<ProcRow> = {}): ProcRow {
  const comm = more.comm ?? (command.split(" ")[0] ?? "").split("/").at(-1) ?? "";

  return { pid, ppid, started: NOW - 5 * HOURS, rss: 1000, comm, command, ...more };
}

function entry(id: string, dir: string, raw: Record<string, string> = {}): Entry {
  return { id, dir, role: "coordinator", url: "", session: null, since: "", aliases: [], raw: { id, dir, ...raw } };
}

const INIT = row(1, 0, "/sbin/init", { comm: "systemd" });

const USER_MANAGER = row(900, 1, "/lib/systemd/systemd --user", { comm: "systemd" });

/** A Bash tool's background job left behind: zsh -c → pnpm → vitest, adopted by PID 1. */
const JOB = [
  row(100, 1, "/bin/zsh -c source /tmp/snap.sh && eval 'pnpm test' < /dev/null", { comm: "zsh", rss: 4000, session: "s-1", cwd: "/repo/ws-a/pkg" }),
  row(101, 100, "node /nix/store/x-pnpm/bin/pnpm test", { comm: "node", rss: 100_000 }),
  row(102, 101, "node /repo/ws-a/node_modules/vitest/vitest.mjs run", { comm: "node", rss: 900_000 }),
  row(103, 102, "node /repo/ws-a/node_modules/vitest/dist/workers/forks.js", { comm: "node", rss: 2_000_000 }),
];

/** Luiz's own dev server in a terminal: ghostty → nu (interactive) → pnpm dev. */
const TERMINAL = [
  row(200, 900, "/usr/bin/ghostty", { comm: "ghostty" }),
  row(201, 200, "/usr/bin/nu", { comm: "nu" }),
  row(202, 201, "node /nix/store/x-pnpm/bin/pnpm dev", { comm: "node" }),
];

/** A live session's background job: claude → zsh -c → bun test. */
const LIVE = [
  row(300, 900, "/home/l/.local/share/claude/versions/2.1.300 --resume", { comm: "2.1.300", exe: "/home/l/.local/share/claude/versions/2.1.300" }),
  row(301, 300, "/bin/zsh -c bun test", { comm: "zsh" }),
  row(302, 301, "bun test", { comm: "bun" }),
];

describe("what counts as a test or dev process", () => {
  test("suites, package managers and headless browsers do; an editor or a plain sleep does not", () => {
    const yes = [
      "node /x/node_modules/vitest/vitest.mjs run",
      "vitest",
      "bun test --timeout 5000",
      "node --test test/*.test.mjs",
      "python3 -m pytest -q",
      "/usr/bin/pytest tests",
      "node /nix/store/x/bin/pnpm -r test",
      "vp test",
      "/nix/store/x-chromium/libexec/chromium/chromium --no-sandbox --headless=new about:blank",
      "python3 scripts/bun_files.py",
      "python3 /repo/scripts/gates all",
    ];

    const no = ["nvim src/a.ts", "sleep 600", "bun run build", "node server.js", "chromium https://example.com", "vpn-up",
      "nvim node_modules/vitest/dist/index.js", "nvim scripts/vp", "nvim /home/x/bin/pnpm", "vim -c 'echo' /x/pytest", "less /x/vitest.mjs",
      "grep -r --headless chromium", "cat /x/node_modules/vitest/vitest.mjs"];

    const at = (c: string): ProcRow => row(1000, 1, c);
    expect(yes.filter((c) => !isTestOrDev(at(c)))).toEqual([]);
    expect(no.filter((c) => isTestOrDev(at(c)))).toEqual([]);
  });

  test("a program is matched by its own name, never by an argument", () => {
    expect(programNames(row(1, 0, "nvim node_modules/vitest/dist/index.js"))).toEqual(["nvim"]);
    expect(programNames(row(1, 0, "node /x/node_modules/vitest/vitest.mjs run", { comm: "node" }))).toEqual(["node", "vitest.mjs"]);
    expect(programNames(row(1, 0, "/bin/sh /tmp/bin/vitest", { comm: "vitest" }))).toEqual(["vitest", "sh"]);
  });

  test("terminals, multiplexers, editors and interactive shells are interactive; a shell running a line or a script is not", () => {
    const yes = ["foot", "/usr/bin/ghostty", "alacritty", "kitty", "wezterm-gui", "tmux", "zellij", "nu", "-zsh", "bash", "bash -i -c x", "fish -l", "/usr/bin/nvim a.ts", "vim", "emacs", "code ."];
    const no = ["/bin/zsh -c pnpm test", "bash ci.sh", "nu -c ls", "node /x/pnpm.cjs dev", "pnpm dev"];
    expect(yes.filter((c) => !isInteractive(row(1, 0, c)))).toEqual([]);
    expect(no.filter((c) => isInteractive(row(1, 0, c)))).toEqual([]);
    expect(isInteractive(row(1, 0, "/x/tmux new -s a", { comm: "tmux: server" }))).toBe(true);
  });

  test("a shell running a command line is a job; an interactive or login shell is not", () => {
    expect([isShellRun("/bin/zsh -c pnpm test"), isShellRun("bash -lc x"), isShellRun("-zsh"), isShellRun("/usr/bin/nu"), isShellRun("bash")]).toEqual([true, true, false, false, false]);
  });

  test("$FLEET_ORPHAN_HOURS sets the minimum age, 2 h by default", () => {
    expect([minAgeOf(() => undefined), minAgeOf(() => "0.5"), minAgeOf(() => "nope")]).toEqual([7200, 1800, 7200]);
  });
});

describe("finding orphaned trees", () => {
  const table = [INIT, USER_MANAGER, ...JOB, ...TERMINAL, ...LIVE];

  test("the abandoned job is reported, from its root, with the tree's memory and the suite's command", () => {
    const found = orphansIn(table, NOW, 2 * HOURS);
    expect(found.map((f) => [f.root.pid, f.hit.pid, f.tree.map((r) => r.pid)])).toEqual([[100, 101, [100, 101, 102, 103]]]);
    const o = describeOrphan(found[0] ?? { root: INIT, tree: [], hit: INIT }, NOW, [], [], () => "/repo/ws-a");
    expect([o.pid, o.rss, o.age, o.command, o.cwd, o.workspace, o.session]).toEqual([100, 3_004_000, 5 * HOURS, "node /nix/store/x-pnpm/bin/pnpm test", "/repo/ws-a/pkg", "/repo/ws-a", "s-1"]);
  });

  test("a terminal's dev server and a live session's suite are not orphans", () => {
    const pids = orphansIn(table, NOW, 2 * HOURS).map((f) => f.root.pid);
    expect(pids).not.toContain(200);
    expect(pids).not.toContain(301);
  });

  test("a young orphan is not reported; the minimum age decides", () => {
    const young = JOB.map((r) => ({ ...r, started: NOW - 30 * 60 }));
    expect(orphansIn([INIT, ...young], NOW, 2 * HOURS)).toEqual([]);
    expect(orphansIn([INIT, ...young], NOW, 10 * 60).map((f) => f.root.pid)).toEqual([100]);
  });

  test("a tree the user manager (a subreaper) adopted counts as one PID 1 adopted", () => {
    const adopted = [INIT, USER_MANAGER, row(400, 900, "node /x/node_modules/vitest/vitest.mjs", { comm: "node", rss: 50 })];
    expect(orphansIn(adopted, NOW, 2 * HOURS).map((f) => [f.root.pid, f.hit.pid])).toEqual([[400, 400]]);
  });

  test("a root in the exempt set (a served fleet's preview dev server) is not reported", () => {
    const preview = [INIT, row(500, 1, "/bin/sh -c pnpm dev --port 4000", { comm: "sh" }), row(501, 500, "node /x/bin/pnpm dev --port 4000", { comm: "node" })];
    expect(orphansIn(preview, NOW, 2 * HOURS).map((f) => f.root.pid)).toEqual([500]);
    expect(orphansIn(preview, NOW, 2 * HOURS, new Set([500]))).toEqual([]);
  });

  test("the review's probes: an editor on a vitest file, an editor on files named pnpm or vp, a live session's job, a terminal's tree", () => {
    const base = [INIT, USER_MANAGER];
    const editors = [row(500, 900, "nvim node_modules/vitest/dist/index.js"), row(501, 900, "nvim scripts/vp"), row(502, 900, "nvim /home/x/bin/pnpm")];
    expect(orphansIn([...base, ...editors], NOW, 2 * HOURS)).toEqual([]);

    const nohup = [row(905, 900, "claude", { comm: "claude" }), row(600, 900, "zsh -c pnpm dev", { session: "live-session" }), row(601, 600, "node /x/pnpm.cjs dev", { comm: "node" })];
    expect(orphansIn([...base, ...nohup], NOW, 2 * HOURS).map((f) => f.root.pid)).toEqual([600]);
    expect(orphansIn([...base, ...nohup], NOW, 2 * HOURS, new Set(), new Set(["live-session"]))).toEqual([]);
    const tasked = nohup.map((r) => (r.pid === 600 ? { ...r, session: undefined, tasks: "/tmp/claude-1000/-repo/live-session" } : r));
    expect(orphansIn([...base, ...tasked], NOW, 2 * HOURS, new Set(), new Set(["live-session"]))).toEqual([]);

    const terminal = [row(700, 900, "/bin/sh -c foot"), row(701, 700, "foot"), row(702, 701, "nu"), row(703, 702, "nvim a.ts"), row(704, 702, "node /x/pnpm.cjs dev", { comm: "node" })];
    expect(orphansIn([...base, ...terminal], NOW, 2 * HOURS)).toEqual([]);
  });

  test("a tree whose session leader is alive on a terminal is not reported; once the leader is gone, it is", () => {
    const leader = row(800, 900, "/usr/bin/nu", { comm: "nu", sid: 800, tty: 34817 });
    const job = [row(810, 900, "/bin/sh -c pnpm dev", { comm: "sh", sid: 800, tty: 34817 }), row(811, 810, "node /x/pnpm.cjs dev", { comm: "node", sid: 800, tty: 34817 })];
    expect(orphansIn([INIT, USER_MANAGER, leader, ...job], NOW, 2 * HOURS)).toEqual([]);
    expect(orphansIn([INIT, USER_MANAGER, ...job], NOW, 2 * HOURS).map((f) => f.root.pid)).toEqual([810]);
    const own = job.map((r) => ({ ...r, sid: 810, tty: 0 }));
    expect(orphansIn([INIT, USER_MANAGER, leader, ...own], NOW, 2 * HOURS).map((f) => f.root.pid)).toEqual([810]);
  });

  test("live sessions are read from Claude Code's record of each running claude process", () => {
    const config = tmp("fleet-orphans-config-");
    mkdirSync(join(config, "sessions"));
    writeFileSync(join(config, "sessions", "905.json"), JSON.stringify({ pid: 905, sessionId: "live-session" }));
    writeFileSync(join(config, "sessions", "906.json"), JSON.stringify({ pid: 906, sessionId: "gone-session" }));
    const rows = [INIT, row(905, 900, "claude", { comm: "claude" }), row(906, 900, "sleep 1", { comm: "sleep" })];
    expect([...liveSessionsOf(rows, config)]).toEqual(["live-session"]);
  });

  test("an orphaned shell running something that is no test or dev process is not reported", () => {
    expect(orphansIn([INIT, row(600, 1, "/bin/sh -c sleep 999", { comm: "sh" }), row(601, 600, "sleep 999", { comm: "sleep" })], NOW, 2 * HOURS)).toEqual([]);
  });
});

describe("who started it", () => {
  const scratch = "/tmp/claude-1000/-repo/s-1/scratchpad/coordinator";

  test("the session in its environment names the fleet whose registry entry records it, or whose DIR is in its scratchpad", () => {
    const found = orphansIn([INIT, ...JOB], NOW, 2 * HOURS)[0];

    if (found === undefined) throw new Error("no orphan");
    expect(describeOrphan(found, NOW, [entry("other", "/x/y/z"), entry("ui", "/a/b/c", { session_id: "s-1" })], []).fleet).toBe("ui");
    expect(describeOrphan(found, NOW, [entry("api", scratch)], []).fleet).toBe("api");
  });

  test("without a session in its environment, the task file it writes names the session", () => {
    const job = JOB.map((r, i) => (i === 0 ? { ...r, session: undefined, tasks: "/tmp/claude-1000/-repo/s-1" } : r));
    const found = orphansIn([INIT, ...job], NOW, 2 * HOURS)[0];

    if (found === undefined) throw new Error("no orphan");
    const o = describeOrphan(found, NOW, [entry("api", scratch)], []);
    expect([o.session, o.fleet]).toEqual(["s-1", "api"]);
  });

  test("with no session at all, the fleet whose heartbeats ran in its cwd or its workspace", () => {
    const job = JOB.map((r, i) => (i === 0 ? { ...r, session: undefined } : r));
    const found = orphansIn([INIT, ...job], NOW, 2 * HOURS)[0];

    if (found === undefined) throw new Error("no orphan");
    const beats: BeatOf[] = [{ fleet: "top", session: "z", cwd: "/" }, { fleet: "ws", session: "s-9", cwd: "/repo/ws-a" }];
    const o = describeOrphan(found, NOW, [], beats, () => "/repo/ws-a");
    expect([o.session, o.fleet]).toEqual([null, "ws"]);
    expect(fleetOfCwd("/repo/ws-b/deep", null, [{ fleet: "b", session: "s", cwd: "/repo/ws-b" }, { fleet: "home", session: "t", cwd: "/home" }], "/home/l")).toBe("b");
    expect(fleetOfCwd("/home/l/x", null, [{ fleet: "home", session: "t", cwd: "/home/l" }, { fleet: "root", session: "u", cwd: "/home" }], "/home/l")).toBeNull();
  });
});

describe("the Mac's ps", () => {
  test("ps rows become the table, start from etime", () => {
    const text = "  100     1   4000 05:00:00 ??       zsh  /bin/zsh -c pnpm test\n  101   100 900000 04:59:59 ttys003  node node /x/vitest/vitest.mjs run\ngarbage\n";
    expect(psTable(text, NOW).map((r) => [r.pid, r.ppid, r.rss, r.started, r.tty, r.comm, r.command])).toEqual([
      [100, 1, 4000, NOW - 5 * HOURS, 0, "zsh", "/bin/zsh -c pnpm test"],
      [101, 100, 900000, NOW - 5 * HOURS + 1, 1, "node", "node /x/vitest/vitest.mjs run"],
    ]);
  });
});

describe.skipIf(process.platform !== "linux")("stopping a tree (real processes this test starts)", () => {
  let roots: number[] = [];

  afterEach(() => {
    for (const pid of roots) spawnSync("pkill", ["-KILL", "-P", String(pid)]);

    for (const pid of roots) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }

    roots = [];
  });

  /** An orphaned job of our own: a shell running a fake `vitest` (that ignores TERM) and a sleep, its parent gone. */
  function orphanJob(): number {
    const dir = tmp("fleet-orphans-");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "vitest"), "#!/bin/sh\ntrap '' TERM\nsleep 600 &\nwait\n");
    chmodSync(join(bin, "vitest"), 0o755);
    const pidFile = join(dir, "root.pid");
    // setsid: a session of its own, off any terminal the test runs on (a tree on a live terminal is never reported).
    spawnSync("/bin/sh", ["-c", `setsid /bin/sh -c 'echo $$ > ${pidFile}; ${join(bin, "vitest")} & sleep 600; true' & exit 0`], { stdio: "ignore" });

    for (let i = 0; i < 50 && !readable(pidFile); i += 1) Bun.sleepSync(20);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    roots.push(pid);
    Bun.sleepSync(200);

    return pid;
  }

  function readable(path: string): boolean {
    try {
      return readFileSync(path, "utf8").trim() !== "";
    } catch {
      return false;
    }
  }

  /** The machine's table, our root shown as adopted by PID 1 whatever reaper took it here. */
  function adopted(root: number): () => ProcRow[] {
    return () => processTable().map((r) => (r.pid === root ? { ...r, ppid: 1 } : r));
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");

      return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
    } catch {
      return false;
    }
  }

  test("Stop kills every process of the tree, the grandchild that ignores TERM included", async () => {
    const root = orphanJob();
    const rows = adopted(root);
    const found = orphansIn(rows(), Date.now() / 1000, 0).find((f) => f.root.pid === root);

    if (found === undefined) throw new Error("the job is not reported");
    const pids = found.tree.map((r) => r.pid);
    expect(pids.length).toBeGreaterThanOrEqual(4);
    expect(found.hit.command).toContain("/bin/vitest");
    const done = await stopOrphan(root, found.root.started, 0, new Set(), rows);
    expect("why" in done ? done.why : done.left).toEqual([]);
    expect(pids.filter(alive)).toEqual([]);
  }, 20_000);

  test("Stop signals the tree's own processes, never their process group: a group member outside the tree lives", async () => {
    const dir = tmp("fleet-orphans-group-");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "vitest"), "#!/bin/sh\nsleep 600 &\nwait\n");
    chmodSync(join(bin, "vitest"), 0o755);
    const pidFile = join(dir, "root.pid");
    const outsideFile = join(dir, "outside.pid");
    spawnSync("/bin/sh", ["-c", `setsid /bin/sh -c 'echo $$ > ${pidFile}; (sleep 601 & echo $! > ${outsideFile}); ${join(bin, "vitest")} & sleep 600; true' & exit 0`], { stdio: "ignore" });

    for (let i = 0; i < 50 && !(readable(pidFile) && readable(outsideFile)); i += 1) Bun.sleepSync(20);
    const root = Number(readFileSync(pidFile, "utf8").trim());
    const outside = Number(readFileSync(outsideFile, "utf8").trim());
    roots.push(root, outside);
    Bun.sleepSync(200);
    const rows = adopted(root);
    const found = orphansIn(rows(), Date.now() / 1000, 0).find((f) => f.root.pid === root);

    if (found === undefined) throw new Error("the job is not reported");
    expect(found.tree.map((r) => r.pid)).not.toContain(outside);
    const done = await stopOrphan(root, found.root.started, 0, new Set(), rows);
    expect("why" in done ? done.why : done.left).toEqual([]);
    expect(found.tree.map((r) => r.pid).filter(alive)).toEqual([]);
    expect(alive(outside)).toBe(true);
  }, 20_000);

  test("a start time other than the page's stops nothing", async () => {
    const root = orphanJob();
    const rows = adopted(root);
    const found = orphansIn(rows(), Date.now() / 1000, 0).find((f) => f.root.pid === root);

    if (found === undefined) throw new Error("the job is not reported");
    const done = await stopOrphan(root, found.root.started - 100, 0, new Set(), rows);
    expect("why" in done ? done.why : "").toContain("not the one the page showed");
    expect(found.tree.map((r) => r.pid).filter(alive)).toEqual(found.tree.map((r) => r.pid));
    const gone = await stopOrphan(4_000_000, 1, 0, new Set(), rows);
    expect("why" in gone ? gone.why : "").toContain("no orphaned test or dev process");
    await stopTree(found.tree, 500);
    expect(found.tree.map((r) => r.pid).filter(alive)).toEqual([]);
  }, 20_000);
});
