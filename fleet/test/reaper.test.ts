/** The gate reaper: `judge` over handed Snapshots, the kill through handed `KillIo`s, and one real-process test that
 * kills only what it spawned. Never a process of the machine: a fake table's pids are never signalled for real. */
import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Gate } from "../src/gate.ts";
import { childrenOf, processTable, sessionOf, STOP_GRACE_MS, treeOf, type ProcRow } from "../src/orphans.ts";
import { DEFAULTS, judge, Killable, ownerOf, reapGroup, reapNow, reportText, waiterClause, type AuditLine, type Judged, type KillIo, type Report, type Snapshot } from "../src/reaper.ts";
import { fileAuditLog, realKillIo } from "../src/reaper-read.ts";
import { baseEnv, FLEET, sleep, tmp } from "./support.ts";

const NOW = 1_800_000_000;

const APP = "/user.slice/user-1000.slice/user@1000.service/app.slice";

const REX = `${APP}/rex.service`;

const G = 1024 ** 3;

const FLOOR = 8 * G;

setDefaultTimeout(30_000);

/** A row of a test's table: its cgroup and idleness travel with it. */
type Row = ProcRow & { readonly cg?: string; readonly idle?: number; readonly swap?: number };

function proc(pid: number, ppid: number, command: string, more: Partial<Row> = {}): Row {
  return { pid, ppid, started: NOW - 7200, rss: 1000, comm: (command.split(" ")[0] ?? "").split("/").at(-1) ?? "", command, ...more };
}

function snapshot(rows: readonly Row[], more: Partial<Snapshot> = {}): Snapshot {
  return {
    rows,
    cgroupOf: new Map(rows.map((r) => [r.pid, r.cg ?? REX])),
    idleOf: new Map(rows.map((r) => [r.pid, r.idle ?? 3600])),
    liveSessions: new Set(),
    liveWorkspaces: new Set(),
    recordOf: new Map(),
    transcriptAt: new Map(),
    gateUnits: new Map(),
    exempt: new Set(),
    swapOf: new Map(rows.map((r) => [r.pid, r.swap ?? 0])),
    meminfo: { available: 20 * G, total: 64 * G },
    now: NOW,
    ...more,
  };
}

function verdicts(snap: Snapshot): Judged[] {
  return [...judge(snap, DEFAULTS, FLOOR).groups];
}

function holding(report: Report | readonly Judged[], pid: number): Judged {
  const groups = "groups" in report ? report.groups : report;
  const found = groups.find((j) => j.group.procs.some((r) => r.pid === pid));

  if (found === undefined) throw new Error(`no group holds ${String(pid)}`);

  return found;
}

const VITEST = "node /repo/ws/node_modules/vitest/dist/workers/forks.js";

const UUID = "f1f9105c-1111-4222-8333-444455556666";

const SYSTEMD = proc(500, 1, "/lib/systemd/systemd --user", { comm: "systemd", cg: `${APP}/../init.scope` });

/** A stale pool a dead session left: zsh, the runner, and `workers` workers of 1G each, adopted by systemd. */
function pool(at: number, session: string, workers = 2, more: Partial<Row> = {}): Row[] {
  return [
    proc(at, 500, "/bin/zsh -c eval 'pnpm test'", { comm: "zsh", session, cwd: "/repo/ws", ...more }),
    proc(at + 1, at, "node /repo/ws/node_modules/vitest/vitest.mjs run", { comm: "node", rss: 200_000, session, ...more }),
    ...Array.from({ length: workers }, (_, i) => proc(at + 2 + i, at + 1, "node /repo/ws/node_modules/vitest/dist/workers/forks.js", { comm: "MainThread", rss: 1024 * 1024, session, ...more })),
  ];
}

/** The fleets' chat watches of the 10-08 incident: each under its live session. */
function watch(at: number, session: string): Row[] {
  return [
    proc(at, 500, `claude --resume ${session}`, { comm: "claude", rss: 900_000, tty: 34816, sid: at }),
    proc(at + 1, at, "/bin/zsh -c eval 'fleet chat watch'", { comm: "zsh", session, sid: at + 1 }),
    proc(at + 2, at + 1, "bun /x/fleet/src/main.ts chat /dir watch", { comm: "bun", rss: 300 * 1024, session, sid: at + 1, idle: 9000 }),
  ];
}

function fixture(): Row[] {
  const lines = readFileSync(join(import.meta.dir, "fixtures", "reaper-snapshot.tsv"), "utf8").trim().split("\n").slice(1);

  return lines.map((line) => {
    const [pid = "", ppid = "", sid = "", tty = "", etimes = "", rss = "", comm = "", cg = "", session = "", , args = ""] = line.split("\t");

    const row = { pid: Number(pid), ppid: Number(ppid), sid: Number(sid), tty: tty === "?" || tty === "" ? 0 : 34816, started: NOW - Number(etimes), rss: Number(rss), comm, command: args, cg };

    return session === "" || session === "?" ? row : { ...row, session };
  });
}

/** What a fixture row names, by the words the requirement uses. */
function named(r: Row): string | undefined {
  if (r.comm === "claude") return "claude";

  if (/main\.ts chat( |$)/.test(r.command)) return "chat watch";

  if (r.cg?.endsWith("/fleet-host.service") === true) return "fleet host";

  if (r.cg?.endsWith("/1password.service") === true || ["1password", "1Password-Brows", "op"].includes(r.comm)) return "1password";

  return ["helium", "zen", "slack"].includes(r.comm) ? "owner app" : undefined;
}

/** A KillIo over a table a test hands: it records every call, in order, and signals nothing real. */
function fakeIo(rows: () => readonly ProcRow[], more: Partial<KillIo> = {}) {
  const calls: string[] = [];

  const io: KillIo = {
    signal: (pid, sig) => calls.push(`${sig} ${String(pid)}`),
    table: rows,
    sleep: () => Promise.resolve(),
    record: (line: AuditLine) => calls.push(`audit ${line.line}`),
    now: () => "2027-01-15T08:00:00Z",
    ...more,
  };

  return { io, calls };
}

describe("the 10-08 replay", () => {
  const live = ["aaaa0001", "aaaa0002", "aaaa0003", "aaaa0004", "aaaa0005", "aaaa0006"];

  const rows: Row[] = [
    SYSTEMD,
    ...live.flatMap((s, i) => watch(1000 + i * 10, s)),
    ...pool(2000, "dead0001"),
    ...pool(2100, "dead0002", 3),
    ...pool(2200, "dead0003"),
    proc(3000, 500, "/opt/1password/1password --silent", { comm: "1password", rss: 3 * 1024 * 1024, cg: `${APP}/1password.service` }),
    proc(3100, 500, "/bin/zsh -c just test", { comm: "zsh", session: "dead0004" }),
    proc(3101, 3100, "fleet fleets gate run --as x -- just test", { comm: "bun", session: "dead0004" }),
    proc(3102, 3101, "node /repo/node_modules/vitest/vitest.mjs run", { comm: "node", rss: 4 * 1024 * 1024, session: "dead0004", cg: `${APP}/fleet-gate-2a03c954-745327.scope` }),
  ];

  const snap = (): Snapshot => snapshot(rows, { liveSessions: new Set(live), gateUnits: new Map([["fleet-gate-2a03c954-745327", "fx-i4"]]) });

  test("watches and 1Password and the gate scope live; the pools with dead owners die", () => {
    const report = judge(snap(), DEFAULTS, FLOOR);

    for (const [i] of live.entries()) {
      expect(holding(report, 1000 + i * 10).verdict).toEqual({ kind: "never", why: "claude session" });
      expect(holding(report, 1002 + i * 10).verdict).toEqual({ kind: "never", why: "chat watch" });
    }

    expect(holding(report, 3000).verdict).toEqual({ kind: "never", why: "1password" });
    expect(holding(report, 3102).verdict).toEqual({ kind: "never", why: "live gate scope" });

    for (const at of [2000, 2100, 2200]) expect(holding(report, at).verdict.kind).toBe("reap");
    expect(report.reapable).toBe(holding(report, 2000).group.rss + holding(report, 2100).group.rss + holding(report, 2200).group.rss);
  });

  test("the kill takes the pools' pids alone, TERM then KILL", async () => {
    const report = judge(snap(), DEFAULTS, FLOOR);
    const pools = new Set(report.groups.filter((j) => j.verdict.kind === "reap").flatMap((j) => j.group.procs.map((r) => r.pid)));
    const { io, calls } = fakeIo(() => rows);

    for (const j of report.groups) {
      const k = Killable.ofReap(j);

      if (k !== undefined) await reapGroup(k, io, 1);
    }

    const signalled = calls.filter((c) => c.startsWith("SIG"));
    const hit = new Set(signalled.map((c) => Number(c.split(" ")[1])));

    expect(hit).toEqual(pools);
    expect(signalled.filter((c) => c.startsWith("SIGTERM")).length).toBe(pools.size);
    expect(signalled.filter((c) => c.startsWith("SIGKILL")).length).toBe(pools.size);

    for (const pid of pools) expect(signalled.indexOf(`SIGTERM ${String(pid)}`)).toBeLessThan(signalled.indexOf(`SIGKILL ${String(pid)}`));
  });
});

describe("the real sample", () => {
  const sessions = (rows: readonly Row[]): Set<string> => new Set(rows.flatMap((r) => (r.session === undefined ? [] : [r.session])));

  test("as sampled: nothing to reap, the live sessions' pools a card per session, fleet-work never", () => {
    const rows = fixture();
    const report = judge(snapshot(rows, { liveSessions: sessions(rows) }), DEFAULTS, FLOOR);

    expect(report.groups.filter((j) => j.verdict.kind === "reap")).toEqual([]);
    const cards = report.groups.filter((j) => j.verdict.kind === "ask" && j.group.owner.kind === "session");
    const owners = cards.map((j) => (j.group.owner.kind === "session" ? j.group.owner.id : ""));

    expect(new Set(owners).size).toBe(owners.length);
    expect(owners).toContain("b74e1af0");
    expect(holding(cards, rows.find((r) => r.session === "b74e1af0" && r.comm === "MainThread" && r.rss > 1024 * 1024)?.pid ?? 0).verdict).toEqual({ kind: "ask", why: "owner live" });

    for (const r of rows) if (r.cg?.endsWith("/fleet-work.service") === true) expect(holding(report, r.pid).verdict.kind).toBe("never");
  });

  /** Every row named claude, a chat watch, the fleet host, 1Password or the browser, with its owner made dead, idle and big. */
  const deadAndBig = (rows: readonly Row[]): Row[] => rows.map((r) => (named(r) === undefined ? r : { ...r, session: "gone0000", rss: 2 * 1024 * 1024 }));

  test("every named row is never, even with a dead owner", () => {
    const rows = deadAndBig(fixture());
    const report = judge(snapshot(rows), DEFAULTS, FLOOR);
    const seen = new Set<string>();

    for (const r of rows) {
      const name = named(r);

      if (name === undefined) continue;
      seen.add(name);
      expect([r.pid, name, holding(report, r.pid).verdict.kind]).toEqual([r.pid, name, "never"]);
    }

    expect(seen).toEqual(new Set(["claude", "chat watch", "fleet host", "1password", "owner app"]));
  });

  test("the names hold in the shared unit too, where no cgroup test helps", () => {
    const rows = deadAndBig(fixture()).map((r) => (r.cg?.endsWith("/fleet-host.service") === true ? r : { ...r, cg: REX }));
    const report = judge(snapshot(rows), DEFAULTS, FLOOR);

    for (const r of rows) if (named(r) !== undefined) expect([r.pid, holding(report, r.pid).verdict.kind]).toEqual([r.pid, "never"]);
  });

  test("no reap group ever holds a Claude row, a chat watch or a never cgroup, whoever owns what", () => {
    const rows = fixture();

    for (const live of [new Set<string>(), sessions(rows)]) {
      for (const j of verdicts(snapshot(rows, { liveSessions: live }))) {
        if (j.verdict.kind !== "reap") continue;

        for (const r of j.group.procs) {
          // SAFETY: the snapshot was built from these Rows; judging keeps the rows it was given.
          expect(named(r as Row)).toBeUndefined();
        }
      }
    }
  });
});

describe("the owner", () => {
  test("the id in the environment, live or dead", () => {
    const rows = [SYSTEMD, ...pool(100, "s-1")];

    expect(ownerOf(rows.slice(1), snapshot(rows))).toMatchObject({ kind: "session", id: "s-1", live: false });
    expect(ownerOf(rows.slice(1), snapshot(rows, { liveSessions: new Set(["s-1"]) }))).toMatchObject({ kind: "session", id: "s-1", live: true });
  });

  test("a Claude above it makes it live, whatever id its environment carries", () => {
    const rows = [SYSTEMD, proc(10, 500, "claude", { comm: "claude" }), proc(11, 10, "node server.js", { comm: "node" }), proc(12, 10, "node job.js", { comm: "node", session: "old-id" })];
    const snap = snapshot(rows);

    // SAFETY: `rows` above holds four rows.
    expect(ownerOf([rows[2] as Row], snap)).toMatchObject({ kind: "session", live: true });
    // SAFETY: `rows` above holds four rows.
    expect(ownerOf([rows[3] as Row], snap)).toMatchObject({ kind: "session", id: "old-id", live: true });
  });

  test("a session a live Claude resumed is in `liveSessions`, and its old jobs get a card", () => {
    const rows = [SYSTEMD, ...pool(100, "s-1")];

    expect(holding(verdicts(snapshot(rows, { liveSessions: new Set(["s-1"]) })), 100).verdict).toEqual({ kind: "ask", why: "owner live" });
  });

  test("a gate unit, from the gate's holds; a hand-made scope is its session's", () => {
    const gateRow = proc(20, 500, "node suite.js", { comm: "node", cg: `${APP}/fleet-gate-ab-1.scope` });
    const handRow = proc(30, 500, "node mutate.js", { comm: "node", session: "s-2", cg: `${APP}/fx-i4-mutate.scope` });
    const snap = snapshot([SYSTEMD, gateRow, handRow], { gateUnits: new Map([["fleet-gate-ab-1", "fx-i4"]]), liveSessions: new Set(["s-2"]) });

    expect(ownerOf([gateRow], snap)).toEqual({ kind: "gate", unit: "fleet-gate-ab-1", hold: "fx-i4" });
    expect(ownerOf([handRow], snap)).toMatchObject({ kind: "session", id: "s-2", live: true });
  });

  test("a gate unit is never even with its session dead, and a held hand-named scope is the gate's", () => {
    const rows = [SYSTEMD, proc(20, 500, "node suite.js", { comm: "node", rss: 4 * 1024 * 1024, session: "dead", cg: `${APP}/my-run.scope` })];

    expect(holding(verdicts(snapshot(rows, { gateUnits: new Map([["my-run", "fx"]]) })), 20).verdict).toEqual({ kind: "never", why: "live gate scope" });
  });

  test("a sid leader on a terminal, else a named unit, else unknown; the shared unit names no owner", () => {
    const leader = proc(40, 500, "/usr/bin/foot", { comm: "foot", tty: 34816, sid: 40 });
    const shellJob = proc(41, 40, "node dev.js", { comm: "node", sid: 40 });
    const inUnit = proc(50, 500, "node worker.js", { comm: "node", sid: 50, cg: `${APP}/box-index.service` });
    const inRex = proc(60, 500, "node stray.js", { comm: "node", sid: 60 });
    const snap = snapshot([SYSTEMD, leader, shellJob, inUnit, inRex]);

    expect(ownerOf([shellJob], snap)).toEqual({ kind: "terminal", leader: 40 });
    expect(ownerOf([inUnit], snap)).toEqual({ kind: "unit", unit: "box-index.service" });
    expect(ownerOf([inRex], snap)).toEqual({ kind: "unknown" });
  });
});

describe("what a kill unasked needs", () => {
  const big = (more: Partial<Row> = {}): Row[] => [SYSTEMD, proc(100, 500, VITEST, { comm: "node", rss: 1024 * 1024, ...more })];

  test("over both thresholds, named constants at 256M and 15 minutes", () => {
    expect(DEFAULTS).toEqual({ minRss: 256 * 1024 ** 2, idleS: 900 });
    expect(holding(verdicts(snapshot(big({ session: "d", rss: 256 * 1024, idle: 900 }))), 100).verdict.kind).toBe("reap");
    expect(holding(verdicts(snapshot(big({ session: "d", rss: 256 * 1024 - 1 }))), 100).verdict).toEqual({ kind: "skip", why: "small" });
    expect(holding(verdicts(snapshot(big({ session: "d", idle: 899 }))), 100).verdict).toEqual({ kind: "skip", why: "busy" });
  });

  test("a tree with no idleness reading is busy", () => {
    const rows = big({ session: "d" });

    expect(holding(verdicts(snapshot(rows, { idleOf: new Map() })), 100).verdict).toEqual({ kind: "skip", why: "busy" });
  });

  test("the thresholds move the verdict", () => {
    const rows = big({ session: "d", idle: 60 });

    expect(holding(judge(snapshot(rows), { minRss: DEFAULTS.minRss, idleS: 30 }, FLOOR), 100).verdict.kind).toBe("reap");
    expect(holding(judge(snapshot(rows), { minRss: 2 * G, idleS: 30 }, FLOOR), 100).verdict).toEqual({ kind: "skip", why: "small" });
  });

  test("a dead pid whose transcript was written within the idle time is a card, not a kill", () => {
    const rows = big({ session: "d" });

    expect(holding(verdicts(snapshot(rows, { transcriptAt: new Map([["d", NOW - 60]]) })), 100).verdict).toEqual({ kind: "ask", why: "owner unknown" });
    expect(holding(verdicts(snapshot(rows, { transcriptAt: new Map([["d", NOW - 900]]) })), 100).verdict.kind).toBe("reap");
  });

  test("no transcript found still reaps while the tree carries a session id, from its env or its task file", () => {
    expect(holding(verdicts(snapshot(big({ session: "d" }))), 100).verdict.kind).toBe("reap");
    expect(holding(verdicts(snapshot(big({ tasks: `/tmp/claude-1000/-repo/${UUID}` }))), 100).verdict.kind).toBe("reap");
  });

  test("no session id at all is a card, however dead it looks", () => {
    expect(holding(verdicts(snapshot(big())), 100).verdict).toEqual({ kind: "ask", why: "owner unknown" });
  });

  test("a dead session's tree in a live terminal's session is a card, not a kill", () => {
    const rows = [SYSTEMD, proc(90, 500, "/usr/bin/foot", { comm: "foot", tty: 34816, sid: 90 }), proc(100, 500, "node job.js", { comm: "node", rss: 1024 * 1024, session: "d", sid: 90 })];

    expect(holding(verdicts(snapshot(rows)), 100).verdict).toEqual({ kind: "ask", why: "owner unknown" });
  });

  test("a served fleet's preview server, and anything else exempt, is never", () => {
    expect(holding(verdicts(snapshot(big({ session: "d" }), { exempt: new Set([100]) })), 100).verdict).toEqual({ kind: "never", why: "exempt" });
  });

  test("the row reading no cgroup is never: no reading is no kill", () => {
    expect(holding(verdicts(snapshot(big({ session: "d" }), { cgroupOf: new Map() })), 100).verdict).toEqual({ kind: "never", why: "outside app.slice" });
  });

  test("every fleet-*.service is never, by prefix", () => {
    expect(holding(verdicts(snapshot(big({ session: "d", cg: `${APP}/fleet-anything.service` }))), 100).verdict).toEqual({ kind: "never", why: "fleet host" });
  });
});

describe("groups", () => {
  test("a live owner's hogs are one group, however many workers and pools; small trees stay out", () => {
    const rows = [SYSTEMD, proc(10, 500, "claude", { comm: "claude", tty: 34816, sid: 10 }), proc(100, 10, "/bin/zsh -c test", { comm: "zsh", session: "s-1", sid: 100 }), ...Array.from({ length: 16 }, (_, i) => proc(101 + i, 100, "node worker", { comm: "MainThread", rss: 400 * 1024, session: "s-1", sid: 100 })), proc(200, 10, "/bin/zsh -c test", { comm: "zsh", session: "s-1", sid: 200 }), proc(201, 200, "node worker", { comm: "MainThread", rss: 400 * 1024, session: "s-1", sid: 200 }), proc(300, 10, "/bin/zsh -c sleep 5", { comm: "zsh", session: "s-1", sid: 300 })];
    const groups = verdicts(snapshot(rows, { liveSessions: new Set(["s-1"]) }));
    const cards = groups.filter((j) => j.verdict.kind === "ask");

    expect(cards.length).toBe(1);
    expect(cards[0]?.group.procs.map((r) => r.pid)).toContain(201);
    expect(cards[0]?.group.procs.length).toBe(19);
    expect(holding(groups, 300).verdict).toEqual({ kind: "skip", why: "small" });
  });

  test("two sessions are two groups", () => {
    const rows = [SYSTEMD, ...pool(100, "s-1"), ...pool(200, "s-2")];
    const groups = verdicts(snapshot(rows, { liveSessions: new Set(["s-1", "s-2"]) })).filter((j) => j.verdict.kind === "ask");

    expect(groups.length).toBe(2);
  });

  test("a dead owner's busy pool does not save its idle one, nor dies with it", () => {
    const rows = [SYSTEMD, ...pool(100, "d"), ...pool(200, "d", 2, { idle: 5 })];
    const groups = verdicts(snapshot(rows));

    expect(holding(groups, 100).verdict.kind).toBe("reap");
    expect(holding(groups, 200).verdict).toEqual({ kind: "skip", why: "busy" });
  });

  test("the key is the owner, the root and its start: stable across reports", () => {
    const rows = [SYSTEMD, ...pool(100, "d")];
    const key = holding(verdicts(snapshot(rows)), 100).group.key;

    expect(key).toBe(`session-d:100:${String(NOW - 7200)}`);
    expect(holding(verdicts(snapshot(rows)), 100).group.key).toBe(key);
  });
});

describe("Killable", () => {
  const rows = [SYSTEMD, ...pool(100, "dead"), proc(200, 500, "claude", { comm: "claude" }), ...pool(300, "live")];
  const groups = verdicts(snapshot(rows, { liveSessions: new Set(["live"]) }));

  test("only a reap verdict", () => {
    expect(Killable.ofReap(holding(groups, 100))?.group.procs[0]?.pid).toBe(100);
    expect(Killable.ofReap(holding(groups, 200))).toBeUndefined();
    expect(Killable.ofReap(holding(groups, 300))).toBeUndefined();
  });
});

describe("the kill", () => {
  const rows = [SYSTEMD, ...pool(100, "d")];

  const killable = (): Killable => {
    const k = Killable.ofReap(holding(verdicts(snapshot(rows)), 100));

    if (k === undefined) throw new Error("no reap verdict");

    return k;
  };

  test("a pid whose start changed is not signalled, and the record says reused", async () => {
    const table = rows.map((r) => (r.pid === 102 ? { ...r, started: r.started + 60 } : r));
    const { io, calls } = fakeIo(() => table);
    const reaped = await reapGroup(killable(), io, 1);

    expect(calls.some((c) => c.endsWith(" 102"))).toBe(false);
    expect(calls.some((c) => c === "SIGTERM 103")).toBe(true);
    expect(reaped.reused).toEqual([102]);
  });

  test("root last on the TERM; a child re-parented mid-kill still gets its KILL", async () => {
    let term = 0;
    const { io, calls } = fakeIo(() => (term > 0 ? rows.map((r) => (r.pid === 103 ? { ...r, ppid: 500 } : r)) : rows), { signal: (pid, sig) => { term += 1; calls.push(`${sig} ${String(pid)}`); } });
    await reapGroup(killable(), io, 1);
    const terms = calls.filter((c) => c.startsWith("SIGTERM"));

    expect(terms.at(-1)).toBe("SIGTERM 100");
    expect(calls).toContain("SIGKILL 103");
  });

  test("what left on the TERM gets no KILL, and is counted as freed", async () => {
    let termed = false;
    const { io, calls } = fakeIo(() => (termed ? rows.filter((r) => r.pid === 500) : rows), { signal: (pid, sig) => { termed = true; calls.push(`${sig} ${String(pid)}`); } });
    const reaped = await reapGroup(killable(), io, 1);

    expect(calls.filter((c) => c.startsWith("SIGKILL"))).toEqual([]);
    expect(reaped.left).toEqual([]);
    expect(reaped.freed).toBe(killable().group.rss);
  });

  test("the audit line is on disk before the first signal", async () => {
    const dir = tmp("fleet-reaper-");
    const log = fileAuditLog(join(dir, "gate"));
    const k = killable();
    const { io } = fakeIo(() => rows, { record: log.append, signal: () => { throw new Error("the first signal"); } });

    await expect(reapGroup(k, io, 1)).rejects.toThrow("the first signal");
    // SAFETY: the log's lines are the AuditLines this test just had recorded.
    const kill = readFileSync(join(dir, "gate", "reaper.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as AuditLine).find((line) => line.line === "kill");

    expect(kill?.line === "kill" ? kill.pids.map((p) => p.pid).sort() : []).toEqual([100, 101, 102, 103]);
    expect(kill?.line === "kill" ? [kill.comm, kill.what] : []).toEqual(["MainThread", "vitest x3"]);
  });

  test("an audit log that cannot be written stops the kill", async () => {
    const { io, calls } = fakeIo(() => rows, { record: () => { throw new Error("disk full"); } });

    await expect(reapGroup(killable(), io, 1)).rejects.toThrow("disk full");
    expect(calls.filter((c) => c.startsWith("SIG"))).toEqual([]);
  });

  test("a real tree the test spawned dies through the real seam, its siblings live", async () => {
    const dir = tmp("fleet-reaper-");
    const doomed = Bun.spawn(["sh", "-c", "sleep 300 & sleep 300 & wait"], { stdout: "ignore", stderr: "ignore" });
    const spared = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });

    try {
      await sleep(100);
      const table = processTable();
      const tree = treeOf(doomed.pid, childrenOf(table)).flatMap((pid) => table.find((r) => r.pid === pid) ?? []);

      expect(tree.length).toBe(3);
      const rows2 = tree.map((r) => ({ ...r, session: "gone", rss: 1024 * 1024, command: VITEST, argv: undefined, comm: "node" }));
      const j = holding(verdicts(snapshot(rows2)), doomed.pid);
      const k = Killable.ofReap(j);

      if (k === undefined) throw new Error("no reap verdict");
      const reaped = await reapGroup(k, realKillIo(fileAuditLog(join(dir, "gate"))), 2000);

      expect(reaped.left).toEqual([]);
      expect(await doomed.exited).not.toBe(0);
      expect(spared.killed).toBe(false);
      expect(processTable().some((r) => r.pid === spared.pid)).toBe(true);
    } finally {
      doomed.kill("SIGKILL");
      spared.kill("SIGKILL");
    }
  });
});

describe("reap under the gate's lock", () => {
  let dir: string;
  let gate: Gate;

  beforeEach(() => {
    dir = join(tmp("fleet-reaper-"), "gate");
    gate = new Gate(dir, () => []);
  });

  /** Whether another process could take the gate's lock now, through `flock(2)` as the gate does. */
  const lockFree = (): boolean => {
    const probe = "import fcntl,sys\nf=open(sys.argv[1],'a+')\ntry:\n  fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept OSError:\n  sys.exit(3)\n";

    return Bun.spawnSync(["python3", "-c", probe, join(dir, "gate.lock")]).exitCode === 0;
  };

  const rows = [SYSTEMD, ...pool(100, "dead"), ...pool(200, "live"), proc(300, 500, "claude", { comm: "claude" })];

  const snap = (): Snapshot => snapshot(rows, { liveSessions: new Set(["live"]) });

  test("held from the snapshot to the last signal, and free after", async () => {
    const seen: string[] = [];
    const log = fileAuditLog(dir);
    let left = rows;

    const { io } = fakeIo(() => left, {
      record: log.append,
      signal: (pid, sig) => {
        seen.push(`${sig} ${String(pid)} ${lockFree() ? "free" : "held"}`);
        left = rows.filter((r) => r.pid !== pid || sig === "SIGTERM");
      },
    });

    const outcome = await reapNow(
      {
        gate,
        read: () => {
          seen.push(`snapshot ${lockFree() ? "free" : "held"}`);

          return snap();
        },
        io,
        floor: FLOOR,
        graceMs: 1,
      },
    );

    expect(outcome.reaped.map((r) => r.key)).toEqual([holding(outcome.report, 100).group.key]);
    expect(seen.length).toBeGreaterThan(4);
    expect(seen.filter((s) => s.endsWith("free"))).toEqual([]);
    expect(lockFree()).toBe(true);
  });

  test("every group's audit line is written before the first signal to any group; a failed record signals nothing", async () => {
    const two = [...rows, ...pool(400, "dead2")];
    let lines = 0;

    const { io, calls } = fakeIo(() => two, { record: (l) => {
      calls.push(`audit ${l.line}`);

      if (l.line === "kill" && (lines += 1) === 2) throw new Error("disk full");
    } });

    await expect(reapNow({ gate, read: () => snapshot(two, { liveSessions: new Set(["live"]) }), io, floor: FLOOR, graceMs: 1 })).rejects.toThrow("disk full");
    expect(calls.filter((c) => c.startsWith("SIG"))).toEqual([]);
    const ok = fakeIo(() => two);

    await reapNow({ gate, read: () => snapshot(two, { liveSessions: new Set(["live"]) }), io: ok.io, floor: FLOOR, graceMs: 1 });
    expect(ok.calls.findLastIndex((c) => c === "audit kill")).toBeLessThan(ok.calls.findIndex((c) => c.startsWith("SIG")));
  });

});

describe("the waiter's clause", () => {
  test("says what reap would free and what is an owner's; nothing when nothing helps", () => {
    const rows = [SYSTEMD, ...pool(100, "dead"), ...pool(200, "dead2"), ...pool(300, "b74e1af0")];
    const said = waiterClause(judge(snapshot(rows, { liveSessions: new Set(["b74e1af0"]) }), DEFAULTS, FLOOR));

    expect(said).toContain("2 orphaned groups hold");
    expect(said).toContain("`fleet fleets gate reap`");
    expect(said).toContain("session b74e1af0");
    expect(waiterClause(judge(snapshot([SYSTEMD]), DEFAULTS, FLOOR))).toBeUndefined();
  });
});

describe("an unasked kill needs a positive match", () => {
  const dead = (command: string, more: Partial<Row> = {}): Row[] => [SYSTEMD, proc(100, 500, command, { rss: 1024 * 1024, session: "d", ...more })];
  const PW = "/home/u/.cache/ms-playwright/chromium-1/chrome-linux/chrome --user-data-dir=/tmp/playwright_chromiumdev_profile-x";

  test.each([VITEST, "node /r/node_modules/.bin/jest", "node /r/node_modules/typescript/lib/tsserver.js", "/nix/store/x/bin/devenv mcp", "bun test src", PW])("%s is reaped", (command) => {
    expect(holding(verdicts(snapshot(dead(command))), 100).verdict.kind).toBe("reap");
  });

  test.each([["python3 /r/backfill.py", "backfill.py"], ["pg_dump -h db", "pg_dump"], ["aws s3 cp a b", "aws"], ["node /x/vitest/backfill.js", "backfill.js"], ["node /r/tsserver-tools/upload.js", "upload.js"], ["uvicorn app:app", "uvicorn"], ["nohup-renamed", "nohup-renamed"]])("%s with a dead owner is a card naming why", (command, name) => {
    const v = holding(verdicts(snapshot(dead(command))), 100).verdict;

    expect(v.kind).toBe("ask");
    expect(v.kind === "ask" ? v.why : "").toBe(`not a known rebuildable kind: ${name}`);
  });

  test("one big unknown process keeps the whole tree from a kill; a small shell does not", () => {
    const rows = [...dead(VITEST), proc(101, 100, "pg_dump -h db", { rss: 1024 * 1024, session: "d" })];

    expect(holding(verdicts(snapshot(rows)), 100).verdict.kind).toBe("ask");
    expect(holding(verdicts(snapshot([...dead("/bin/zsh -c x", { rss: 1000 }), proc(101, 100, VITEST, { rss: 1024 * 1024, session: "d" })])), 100).verdict.kind).toBe("reap");
  });

  test.each(["chromium --user-data-dir=/home/u/p", "chrome", "firefox", ".chrome-wrapped"])("%s is the owner's", (command) => {
    expect(holding(verdicts(snapshot(dead(command))), 100).verdict).toEqual({ kind: "never", why: "owner app" });
  });

  test("an fd on tasks/ names a session only under Claude's tmp or projects, with a UUID", () => {
    for (const tasks of ["/mnt/work", "/x/projects/p/task-session", `/mnt/work/${UUID}`, "/tmp/claude-1000/-repo/not-a-uuid"]) {
      expect(sessionOf(proc(1, 0, "x", { tasks }))).toBeUndefined();
      expect(holding(verdicts(snapshot(dead(VITEST, { session: undefined, tasks }))), 100).verdict.kind).toBe("ask");
    }

    expect(sessionOf(proc(1, 0, "x", { tasks: `/tmp/claude-1000/-repo/${UUID}` }))).toBe(UUID);
  });

  test("a live Claude in the tree's workspace or session folder makes it a card, whatever id it carries", () => {
    const rows = dead(VITEST, { session: "f1f9105c", cwd: "/repo/ws/sub" });

    expect(holding(verdicts(snapshot(rows, { liveWorkspaces: new Set(["/repo/ws"]) })), 100).verdict).toEqual({ kind: "ask", why: "owner live" });
    expect(holding(verdicts(snapshot(rows, { liveWorkspaces: new Set(["/repo/w"]) })), 100).verdict.kind).toBe("reap");
    expect(holding(verdicts(snapshot(dead(VITEST, { session: "f1f9105c", cwd: "/tmp/claude-1000/-r/e2d00c84/scratchpad" }), { liveSessions: new Set(["e2d00c84"]) })), 100).verdict).toEqual({ kind: "ask", why: "owner live" });
  });

  test("a tree of more than one id, or a root with none, is a card", () => {
    const none = [SYSTEMD, proc(100, 500, VITEST, { rss: 1024 * 1024 }), proc(101, 100, VITEST, { rss: 1024 * 1024, session: "dead" })];
    const mixed = [SYSTEMD, proc(100, 500, VITEST, { rss: 1024 * 1024, session: "dead" }), proc(101, 100, VITEST, { rss: 1024 * 1024, session: "live" })];

    expect(holding(verdicts(snapshot(none)), 100).verdict.kind).toBe("ask");
    expect(holding(verdicts(snapshot(mixed, { liveSessions: new Set(["live"]) })), 100).verdict.kind).toBe("ask");
    expect(holding(verdicts(snapshot(mixed)), 100).verdict.kind).toBe("ask");
  });

  test("a fleet-preview scope is never, whoever owns it", () => {
    expect(holding(verdicts(snapshot(dead(VITEST, { cg: `${APP}/fleet-preview-acme-1.scope` }))), 100).verdict.kind).toBe("never");
  });

  test("the stop's grace is the gate's 5 s", () => {
    expect(STOP_GRACE_MS).toBe(5000);
  });

  test("mcp is read off the executable and subcommand, never a folder in a path", () => {
    const live = (command: string): Snapshot => snapshot(dead(command, { session: "s" }), { liveSessions: new Set(["s"]) });

    expect(holding(verdicts(live("node /x/custom-mcp-servers/node_modules/vitest/dist/workers/forks.js")), 100).verdict).toEqual({ kind: "ask", why: "owner live" });

    for (const command of ["/bin/devenv mcp", "node /x/mcp-server.js", "/opt/foo-mcp --stdio"]) expect(holding(verdicts(live(command)), 100).verdict).toEqual({ kind: "never", why: "mcp under live session" });
  });

  test("a Claude started with -r names the resumed session, its record first, its pid last", () => {
    const rows = (claude: string) => [SYSTEMD, proc(10, 500, claude, { comm: "claude" }), proc(11, 10, "node job.js", { comm: "node" })];
    // SAFETY: `rows` always builds three rows, so index 2 is there.
    const of = (claude: string, more: Partial<Snapshot> = {}) => ownerOf([rows(claude)[2] as Row], snapshot(rows(claude), more));

    expect(of("claude -r e2d00c84")).toMatchObject({ id: "e2d00c84", live: true });
    expect(of("claude --resume=e2d00c84")).toMatchObject({ id: "e2d00c84" });
    expect(of("claude -r", { recordOf: new Map([[10, "rec-1"]]) })).toMatchObject({ id: "rec-1" });
    expect(of("claude -r --model x")).toMatchObject({ id: "claude-10" });
  });

  test("a report at other thresholds says gate reap will not do its reap lines", () => {
    const report = judge(snapshot(dead(VITEST, { idle: 60 })), { minRss: DEFAULTS.minRss, idleS: 30 }, FLOOR);

    expect(reportText(report, { minRss: DEFAULTS.minRss, idleS: 30 }).join("\n")).toContain("`gate reap` judges at 256M and 15m");
    expect(reportText(judge(snapshot(dead(VITEST)), DEFAULTS, FLOOR), DEFAULTS).join("\n")).not.toContain("judges at");
  });
});

describe("the allow-list, from the review's crafted trees", () => {
  const S = "d";
  const row = (pid: number, ppid: number, words: readonly string[], rssM: number, more: Partial<Row> = {}): Row => ({ ...proc(pid, ppid, words.join(" "), { argv: words, rss: rssM * 1024, session: S, ...more }) });
  const V = ["node", "/w/node_modules/vitest/vitest.mjs", "run"];
  const verdictOfTree = (rows: readonly Row[]): Judged["verdict"] => holding(verdicts(snapshot([SYSTEMD, ...rows])), rows[0]?.pid ?? 0).verdict;
  const kindOfTree = (rows: readonly Row[]): string => verdictOfTree(rows).kind;

  test("a real tree reaps: the live box's vitest worker with vitest's own suppress-warnings", () => {
    const script = "/w/node_modules/.pnpm/vitest@5.0.5_x/node_modules/vitest";

    expect(kindOfTree([row(100, 500, ["/nix/store/n/bin/node", "--experimental-import-meta-resolve", "--require", `${script}/suppress-warnings.cjs`, "--conditions", "node", "--conditions", "development", `${script}/dist/workers/forks.js`], 400, { comm: "MainThread" })])).toBe("reap");
    expect(kindOfTree([row(100, 500, ["node", "/w/s/node_modules/.bin/../../../../node_modules/.pnpm/vp@1/node_modules/vite-plus/bin/vp", "test", "--run"], 400)])).toBe("reap");
    expect(kindOfTree([row(100, 500, ["node", "/nix/store/z-typescript-5.9.3/lib/node_modules/typescript/lib/tsserver.js", "--useInferredProjectPerProjectRoot"], 400, { comm: "MainThread" })])).toBe("reap");
  });

  describe("only a Playwright browser's children inherit", () => {
    test("devenv mcp -> postgres 2G is ask", () => {
      expect(kindOfTree([row(100, 500, ["devenv", "mcp"], 40), row(101, 100, ["postgres", "-D", "/w/pg"], 2048)])).toBe("ask");
    });

    test("mcp -> devenv up -> process-compose -> postgres + next dev is ask", () => {
      expect(kindOfTree([row(100, 500, ["devenv", "mcp"], 40), row(101, 100, ["devenv", "up"], 60), row(102, 101, ["process-compose", "up"], 80), row(103, 102, ["postgres"], 1024), row(104, 102, ["node", "/w/node_modules/.bin/next", "dev"], 800)])).toBe("ask");
    });

    test("a browser's over-bound child with a browser's comm goes with it; a python under it does not", () => {
      const pw = ["/c/chrome", "--user-data-dir=/tmp/playwright_chromiumdev_profile-a"];

      expect(kindOfTree([row(100, 500, pw, 300, { comm: "chrome" }), row(101, 100, ["/c/chrome", "--type=renderer"], 900, { comm: "chrome" })])).toBe("reap");
      expect(kindOfTree([row(100, 500, pw, 300, { comm: "chrome" }), row(101, 100, ["python3", "job.py"], 900)])).toBe("ask");
    });
  });

  describe("the bound counts swap, and allows only shells and small helpers", () => {
    test("bash -> a 28M python with 1G swapped + a 300M vitest is ask", () => {
      expect(kindOfTree([row(100, 500, ["bash", "-c", "x"], 4), row(101, 100, ["python3", "backfill.py"], 28, { swap: 1024 * 1024 }), row(102, 100, V, 300)])).toBe("ask");
    });

    test("a small shell's own swap counts: bash with 1G swapped is over the bound", () => {
      expect(kindOfTree([row(100, 500, ["bash", "-c", "x"], 4, { swap: 1024 * 1024 }), row(102, 100, V, 300)])).toBe("ask");
    });

    test("a row with no swap reading proves nothing small", () => {
      const rows = [row(100, 500, ["bash", "-c", "x"], 4), row(102, 100, V, 300)];
      const swapOf = new Map([[102, 0], [500, 0]]);

      expect(holding(verdicts(snapshot([SYSTEMD, ...rows], { swapOf })), 100).verdict.kind).toBe("ask");
    });

    test("bun test under a 30M python wrapper is ask", () => {
      expect(kindOfTree([row(100, 500, ["python3", "wrap.py"], 30), row(101, 100, ["bun", "test"], 300)])).toBe("ask");
    });

    test("33M vitest + 9 x 31M python is ask", () => {
      expect(kindOfTree([row(100, 500, ["bash", "-c", "x"], 4), row(101, 100, V, 33), ...Array.from({ length: 9 }, (_, i) => row(110 + i, 100, ["python3", "w.py"], 31))])).toBe("ask");
    });

    test.each(["bash", "sh", "zsh", "nu", "timeout", "flock", "chrome_crashpad"])("a small %s stays with its runner", (comm) => {
      expect(kindOfTree([row(100, 500, [comm, "-c", "x"], 4), row(101, 100, V, 300)])).toBe("reap");
    });
  });

  describe("argv alone proves nothing: comm and package layout must agree", () => {
    test.each<[string, readonly string[], string | undefined]>([
      ["a Playwright flag on python", ["python3", "job.py", "--user-data-dir=/tmp/playwright_chromiumdev_profile-a"], undefined],
      ["~/bin/vitest", ["/home/u/bin/vitest", "--daemon"], undefined],
      ["~/bin/tsserver", ["/home/u/bin/tsserver"], undefined],
      ["node -r ./backfill.js .bin/vitest", ["node", "-r", "./backfill.js", "node_modules/.bin/vitest"], undefined],
      ["node --require=./backfill.js", ["node", "--require=./backfill.js", "node_modules/.bin/vitest"], undefined],
      ["node --import=./state.mjs", ["node", "--import=./state.mjs", "node_modules/.bin/vitest"], undefined],
      ["node --loader ./x.mjs", ["node", "--loader", "./x.mjs", "node_modules/.bin/vitest"], undefined],
      ["--require of a suppress-warnings that is not vitest's", ["node", "--require", "/w/suppress-warnings.cjs", "node_modules/.bin/vitest"], undefined],
      ["an option that takes the script for its value", ["node", "--title", "node_modules/.bin/vitest", "./backfill.js"], undefined],
      ["an orphan jest-worker under next", ["node", "/w/node_modules/next/node_modules/jest-worker/build/workers/processChild.js"], "processChild.js"],
      ["vitest-backfill.py", ["python3", "/w/vitest-backfill.py"], "vitest-backfill.py"],
      ["an exec'd vitest-backfill.py", ["/w/vitest-backfill.py"], "vitest-backfill.py"],
      ["/x/vitest/server.js", ["node", "/x/vitest/server.js"], "server.js"],
      ["wrapper.js .bin/vitest", ["node", "wrapper.js", "node_modules/.bin/vitest"], "wrapper.js"],
      ["tail -f tsserver", ["tail", "-f", "tsserver"], "tail"],
      [".bin/vitest outside node_modules", ["node", "/x/.bin/vitest"], undefined],
      ["node /x/tsserver.js", ["node", "/x/tsserver.js"], "tsserver.js"],
    ])("%s is ask", (_, words, program) => {
      const v = verdictOfTree([row(100, 500, words, 400)]);

      expect(v.kind).toBe("ask");

      if (program !== undefined) expect(v.kind === "ask" ? v.why : "").toBe(`not a known rebuildable kind: ${program}`);
    });

    test("a node (vitest 1) title on python is ask; on node it is vitest", () => {
      expect(kindOfTree([row(100, 500, ["node (vitest 1)"], 900, { comm: "python3" })])).toBe("ask");
      expect(kindOfTree([row(100, 500, ["node (vitest 1)"], 900, { comm: "node (vitest 1)" })])).toBe("reap");
    });

    test("a jest-worker under a jest root is jest", () => {
      expect(kindOfTree([row(100, 500, ["node", "/w/node_modules/.bin/jest"], 300), row(101, 100, ["node", "/w/node_modules/jest-worker/build/workers/processChild.js"], 300)])).toBe("reap");
    });
  });

  test("only the stdio devenv mcp matches: an HTTP one may have a live client elsewhere", () => {
    expect(kindOfTree([row(100, 500, ["devenv", "mcp"], 300)])).toBe("reap");
    expect(kindOfTree([row(100, 500, ["devenv", "mcp", "--http", "7777"], 300)])).toBe("ask");
  });

  test("many small vitest workers read as vitest, and nothing over the bound stays ask", () => {
    const rows = [row(100, 500, ["bash", "-c", "x"], 4), ...Array.from({ length: 10 }, (_, i) => row(110 + i, 100, ["node", "/w/node_modules/vitest/dist/w.js"], 30))];

    expect(verdictOfTree(rows)).toEqual({ kind: "ask", why: "nothing over the bound: vitest x10" });
  });

  test("hogs says whose an ask row is, with the session and the size", () => {
    const report = judge(snapshot([SYSTEMD, ...pool(100, "liveone")], { liveSessions: new Set(["liveone"]) }), DEFAULTS, FLOOR);

    expect(reportText(report, DEFAULTS).find((line) => line.startsWith("ask"))).toMatch(/2\.2G.*session liveone \(live\).*held by a live or unknown owner: ask them/);
  });
});

describe("the CLI", () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(() => {
    home = join(tmp("fleet-reaper-"), "registry");
    env = baseEnv(home, { FLEET_NO_FORWARD: "1", FLEET_GATE_SCOPE: "0" });
  });

  const fleets = (args: readonly string[], more: Record<string, string> = {}) => {
    const done = Bun.spawnSync([FLEET, "fleets", "gate", ...args], { env: { ...env, ...more }, stdout: "pipe", stderr: "pipe" });

    return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
  };

  const handed = (rows: readonly Row[], live: readonly string[] = []): string => {
    const path = join(dirname(home), "snapshot.json");
    const snap = snapshot(rows, { liveSessions: new Set(live) });

    writeFileSync(path, JSON.stringify({ rows: snap.rows, cgroupOf: [...snap.cgroupOf], idleOf: [...snap.idleOf], liveSessions: [...snap.liveSessions], meminfo: snap.meminfo, now: snap.now }));

    return path;
  };

  const hog = (): Row[] => [SYSTEMD, proc(4_000_000, 500, VITEST, { rss: 1024 * 1024, session: "gone" })];

  test.each(["--group k", "--group=k", "--yes", "key", "restore"])("reap refuses %s, with nothing done", (words) => {
    const done = fleets(["reap", ...words.split(" ")]);

    expect(done.code).toBe(75);
    expect(done.err).toContain("it takes only --json");
  });

  test("restore is no verb, and hogs refuses a flag it does not read", () => {
    expect(fleets(["restore", "k"]).code).not.toBe(0);
    expect(fleets(["hogs", "--read-only", "--group=k"]).code).not.toBe(0);
  });

  test("the handed snapshot is refused on reap and on a hogs that writes, with nothing done", () => {
    const snap = handed(hog());
    const done = fleets(["reap"], { FLEET_REAPER_SNAPSHOT: snap });

    expect(done.code).toBe(75);
    expect(done.err).toContain("FLEET_REAPER_SNAPSHOT");
    expect(done.out).not.toContain("reaped");
    expect(fleets(["hogs"], { FLEET_REAPER_SNAPSHOT: snap }).code).not.toBe(0);
    expect(Bun.file(join(home, "gate", "reaper.jsonl")).size).toBe(0);
  });

  test("a waiter's clause does not read the handed snapshot", () => {
    const meminfo = join(dirname(home), "meminfo");

    writeFileSync(meminfo, `MemTotal: ${String(64 * 1024 * 1024)} kB\nMemAvailable: ${String(1024 * 1024)} kB\n`);
    const done = fleets(["run", "--as", "w", "--wait", "1", "--mem", "1G", "--", "true"], { FLEET_MEMINFO: meminfo, FLEET_GATE_MEMORY_BUDGET: "32G", FLEET_GATE_MEMORY_FLOOR: "8G", FLEET_REAPER_SNAPSHOT: handed([SYSTEMD, proc(4_000_000, 500, VITEST, { rss: 7000 * 1024 * 1024, session: "gone" })]) });

    expect(done.code).toBe(75);
    expect(done.err).not.toContain("7000");
    expect(Bun.file(join(home, "gate", "reaper.jsonl")).size).toBe(0);
  });

  test("hogs --read-only prints a line per group, writes nothing, and never signals", () => {
    const done = fleets(["hogs", "--read-only"], { FLEET_REAPER_SNAPSHOT: handed([...hog(), proc(10, 500, "claude", { comm: "claude", rss: 1024 * 1024 })]) });

    expect(done.err).toBe("");
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/^reap +1\.0G +idle 1h +owner gone \(session gone\)/m);
    expect(done.out).toMatch(/^never .*Claude sessions x1/m);
    expect(done.out).toMatch(/^free /m);
    expect(Bun.file(join(home, "gate", "reaper.jsonl")).size).toBe(0);
  });
});
