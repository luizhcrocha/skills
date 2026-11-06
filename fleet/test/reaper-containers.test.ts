/** The reaper's containers: judged by their compose folder, read through a fake docker, stopped through a fake one. */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Gate } from "../src/gate.ts";
import type { ContainerRow, Place } from "../src/reaper-containers.ts";
import { containersOf, dockerStopper, type DockerIo } from "../src/reaper-read.ts";
import { DEFAULTS, judge, reapNow, reportText, waiterClause, type AuditLine, type KillIo, type Snapshot } from "../src/reaper.ts";
import { baseEnv, FLEET, tmp } from "./support.ts";

const NOW = 1_800_000_000;

const G = 1024 ** 3;

const M = 1024 ** 2;

const GONE = "/home/u/repos/proj-b193/servers/case-analysis/dev/explorer/split";

const CERT = "/home/u/repos/proj-cert";

const idOf = (n: number): string => String(n).padStart(2, "0").repeat(32);

function box(n: number, place: Place, more: Partial<ContainerRow> = {}): ContainerRow {
  return { id: idOf(n), name: `c${String(n)}`, started: NOW - 2 * 86_400, rss: 512 * M, place, ...more };
}

function snapshot(containers: readonly ContainerRow[], more: Partial<Snapshot> = {}): Snapshot {
  return {
    rows: [],
    cgroupOf: new Map(),
    idleOf: new Map(),
    swapOf: new Map(),
    liveSessions: new Set(),
    liveWorkspaces: new Set(),
    recordOf: new Map(),
    transcriptAt: new Map(),
    gateUnits: new Map(),
    exempt: new Set(),
    containers,
    meminfo: { available: 20 * G, total: 64 * G },
    now: NOW,
    ...more,
  };
}

const verdictOf = (snap: Snapshot, n: number) => judge(snap, DEFAULTS, 8 * G).containers.find((j) => j.container.id === idOf(n))?.verdict;

/** A KillIo whose docker and signals only record. */
function fakeIo() {
  const calls: string[] = [];

  const io: KillIo = {
    signal: (pid, sig) => calls.push(`${sig} ${String(pid)}`),
    table: () => [],
    sleep: () => Promise.resolve(),
    record: (line: AuditLine) => calls.push(`audit ${line.line}`),
    now: () => "2027-01-15T08:00:00Z",
    docker: { stop: (id) => calls.push(`docker stop ${id}`) > 0, remove: (id) => calls.push(`docker rm ${id}`) > 0 },
  };

  return { io, calls };
}

describe("the verdicts", () => {
  test("a container whose workspace folder is gone is reaped, whatever its size", () => {
    expect(verdictOf(snapshot([box(1, { kind: "gone", dir: GONE }, { rss: 24 * M })]), 1)).toEqual({ kind: "reap", why: { ageS: 2 * 86_400, rss: 24 * M } });
  });

  test("one just started is not, nor one where a live Claude works", () => {
    expect(verdictOf(snapshot([box(1, { kind: "gone", dir: GONE }, { started: NOW - 60 })]), 1)).toEqual({ kind: "skip", why: "young" });
    expect(verdictOf(snapshot([box(1, { kind: "gone", dir: GONE })], { liveWorkspaces: new Set([GONE]) }), 1)).toEqual({ kind: "ask", why: "owner live" });
    expect(verdictOf(snapshot([box(1, { kind: "gone", dir: `${CERT}/dev/deleted` })], { liveWorkspaces: new Set([CERT]) }), 1)).toEqual({ kind: "ask", why: "owner live" });
  });

  test("a present workspace with its owner dead is reported once it is old, never reaped", () => {
    const place: Place = { kind: "present", dir: `${CERT}/servers/dev/postgres`, workspace: CERT };

    expect(verdictOf(snapshot([box(1, place)]), 1)).toEqual({ kind: "ask", why: "owner gone, workspace present" });
    expect(verdictOf(snapshot([box(1, place, { started: NOW - 3600 })]), 1)).toEqual({ kind: "skip", why: "young" });
    expect(verdictOf(snapshot([box(1, place, { rss: 24 * M })]), 1)).toEqual({ kind: "skip", why: "small" });
  });

  test("a present workspace with a live owner is reported under it", () => {
    const place: Place = { kind: "present", dir: `${CERT}/servers/dev/postgres`, workspace: CERT };

    expect(verdictOf(snapshot([box(1, place)], { liveWorkspaces: new Set([CERT]) }), 1)).toEqual({ kind: "ask", why: "owner live" });
  });

  test("an unlabeled container is reported, never reaped, however old and big", () => {
    expect(verdictOf(snapshot([box(1, { kind: "unlabeled" }, { rss: 4 * G, started: NOW - 90 * 86_400 })]), 1)).toEqual({ kind: "ask", why: "no compose label" });
  });

  test("the report sums containers and prints them as groups, marked as containers", () => {
    const report = judge(snapshot([box(1, { kind: "gone", dir: GONE }), box(2, { kind: "unlabeled" }, { rss: G, name: "buildx_buildkit_x" })]), DEFAULTS, 8 * G);
    const lines = reportText(report, DEFAULTS);

    expect(report.reapable).toBe(512 * M);
    expect(report.held).toBe(G);
    expect(lines).toContainEqual(expect.stringMatching(/^reap +512M +up +48h +workspace gone +container c1 {2}\/home\/u\/repos\/proj-b193\/.* docker stop, then rm; volumes kept {2}container-c1:/));
    expect(lines).toContainEqual(expect.stringMatching(/^ask +1\.0G +up +48h +no compose label +container buildx_buildkit_x {2}no compose label: ask them/));
    expect(waiterClause(report)).toContain("1 orphaned group holds 512M");
  });
});

describe("the kill", () => {
  const gate = (): Gate => new Gate(join(tmp("fleet-reaper-c-"), "gate"), () => []);

  test("a gone workspace's container is recorded, stopped, then removed; nothing else is touched", async () => {
    const { io, calls } = fakeIo();
    const snap = snapshot([box(1, { kind: "gone", dir: GONE }), box(2, { kind: "unlabeled" }), box(3, { kind: "present", dir: CERT, workspace: CERT })]);
    const outcome = await reapNow({ gate: gate(), read: () => snap, io, floor: 0 });

    expect(calls).toEqual(["audit container", `docker stop ${idOf(1)}`, `docker rm ${idOf(1)}`, "audit removed"]);
    expect(outcome.removed).toEqual([{ key: expect.stringContaining("container-c1:"), name: "c1", stopped: true, removed: true, freed: 512 * M }]);
  });

  test("one that does not stop is not removed", async () => {
    const { io, calls } = fakeIo();
    const outcome = await reapNow({ gate: gate(), read: () => snapshot([box(1, { kind: "gone", dir: GONE })]), io: { ...io, docker: { ...io.docker, stop: () => false } }, floor: 0 });

    expect(calls).not.toContain(`docker rm ${idOf(1)}`);
    expect(outcome.removed[0]).toMatchObject({ stopped: false, removed: false, freed: 0 });
  });

  test("the real stopper runs `docker stop ID` and `docker rm ID`, never with -v", () => {
    const ran: (readonly string[])[] = [];

    const stopper = dockerStopper((args) => {
      ran.push(args);

      return "";
    });

    stopper.stop(idOf(1));
    stopper.remove(idOf(1));
    expect(ran).toEqual([["stop", idOf(1)], ["rm", idOf(1)]]);
  });
});

describe("the reader", () => {
  const inspect = (n: number, labels: Record<string, string> | null, pid = 1000 + n) => ({ Id: idOf(n), Name: `/c${String(n)}`, State: { Running: true, Pid: pid, StartedAt: "2026-11-04T10:00:00.5Z" }, Config: { Labels: labels } });

  function fakeDocker(listed: readonly ReturnType<typeof inspect>[], more: Partial<DockerIo> = {}): DockerIo {
    const there = new Set(["/home/u/repos", CERT, `${CERT}/dev`]);

    return {
      run: (args) => (args[0] === "ps" ? listed.map((c) => c.Id).join("\n") : JSON.stringify(listed)),
      cgroupOf: (pid) => `/system.slice/docker-${idOf(pid - 1000)}.scope`,
      memoryOf: () => 24 * M,
      missing: (path) => !there.has(path),
      workspaceOf: (path) => (path === CERT || path.startsWith(`${CERT}/`) ? CERT : undefined),
      ...more,
    };
  }

  const wd = (dir: string) => ({ "com.docker.compose.project.working_dir": dir });

  test("docker absent, refused or slow is no containers, never an error", () => {
    expect(containersOf(fakeDocker([], { run: () => undefined }))).toEqual([]);
    expect(containersOf(fakeDocker([inspect(1, wd(GONE))], { run: (args) => (args[0] === "ps" ? idOf(1) : undefined) }))).toEqual([]);
  });

  test("the compose folder decides the place", () => {
    const found = containersOf(fakeDocker([inspect(1, wd(GONE)), inspect(2, wd(`${CERT}/dev`)), inspect(3, wd(`${CERT}/dev/gone-subfolder`)), inspect(4, null)]));

    expect(found.map((c) => [c.name, c.place])).toEqual([
      ["c1", { kind: "gone", dir: GONE }],
      ["c2", { kind: "present", dir: `${CERT}/dev`, workspace: CERT }],
      ["c3", { kind: "gone", dir: `${CERT}/dev/gone-subfolder` }],
      ["c4", { kind: "unlabeled" }],
    ]);
    expect(found[0]).toMatchObject({ id: idOf(1), rss: 24 * M, started: Date.parse("2026-11-04T10:00:00.5Z") / 1000 });
  });

  test("a container whose processes are not on this machine is never gone", () => {
    const found = containersOf(fakeDocker([inspect(1, wd(GONE))], { cgroupOf: () => "/user.slice/other.scope" }));

    expect(found[0]?.place).toEqual({ kind: "present", dir: GONE, workspace: undefined });
    expect(found[0]?.rss).toBe(0);
  });
});

describe("the CLI", () => {
  test("hogs --read-only prints a handed snapshot's containers", () => {
    const home = join(tmp("fleet-reaper-c-"), "registry");
    const path = join(dirname(home), "snapshot.json");

    writeFileSync(path, JSON.stringify({ rows: [], containers: [box(1, { kind: "gone", dir: GONE })], meminfo: { available: 20 * G, total: 64 * G }, now: NOW }));
    const done = Bun.spawnSync([FLEET, "fleets", "gate", "hogs", "--read-only"], { env: { ...baseEnv(home, { FLEET_NO_FORWARD: "1", FLEET_GATE_SCOPE: "0" }), FLEET_REAPER_SNAPSHOT: path }, stdout: "pipe", stderr: "pipe" });

    expect(done.exitCode).toBe(0);
    expect(done.stdout.toString()).toMatch(/^reap +512M +up +48h +workspace gone +container c1 /m);
  });
});
