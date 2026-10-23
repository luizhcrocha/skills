/**
 * `fleet fleets gate run`: a suite through the gate, as one process tree that dies whole, within the memory budget
 * all runs share and in the queue's order. Each test runs the CLI as its own process (signals are part of the
 * surface), with its own registry; the scope tests need a systemd user manager and are skipped where there is
 * none (the Mac). gate.test.ts has the admission rules themselves; gate-run-scope.test.ts the run's scope, its record
 * and its asks, a file of their own so that bun_files.py runs the two at once, each within its per-file limit.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { capBytes, memEstimate } from "../src/gate.ts";
import { asNumber, type JsonObject } from "../src/json.ts";
import { runArgs } from "../src/gate-run.ts";
import { alive, budgetBytes, env, first, freshRegistry, gate, holdFile, holds, home, pidIn, records, running, SCOPE, standing, stopAll, tree, until } from "./gate-run-support.ts";
import { FLEET, tmp, type Environment } from "./support.ts";

// Each run is a fleet process or two, and a stopped tree has seconds of grace.
setDefaultTimeout(30_000);

beforeEach(freshRegistry);

describe("gate run's arguments", () => {
  test("a fleet or --as, then the command after --", () => {
    expect(runArgs(["--as", "ui", "--wait", "1800", "--", "pnpm", "test"])).toEqual({
      name: "ui", command: ["pnpm", "test"], waitS: 1800, minutes: 60, mem: undefined, floor: undefined, timeoutS: 3600, cpus: undefined, landing: false,
    });
    expect(runArgs(["infra", "--for", "5", "--timeout", "30", "--mem", "8G", "--", "just", "test"])?.timeoutS).toBe(30);
    expect(runArgs(["infra", "--for", "1", "--timeout", "300", "--", "x"])?.timeoutS).toBe(60);
    expect(runArgs(["--as", "ui", "pnpm", "test"])).toBeUndefined();
    expect(runArgs(["--as", "ui", "--"])).toBeUndefined();
    expect(runArgs(["--as", "ui", "extra", "--", "x"])).toBeUndefined();
    expect(runArgs(["--wait", "soon", "ui", "--", "x"])).toBeUndefined();
    expect(runArgs(["ui", "--cpus", "4", "--landing", "--", "x"])).toMatchObject({ cpus: 4, landing: true });
    expect(runArgs(["ui", "--cpus", "0", "--", "x"])).toBeUndefined();
    expect(runArgs(["ui", "--cpus", "many", "--", "x"])).toBeUndefined();
  });

  test("a cap from a run's last peak is that peak and a quarter, in whole MiB, 2G at least", () => {
    expect(memEstimate(2.5 * 1024 ** 3)).toBe(3.125 * 1024 ** 3);
    expect(memEstimate(1024 ** 2)).toBe(2 * 1024 ** 3);
    expect(memEstimate(1.7 * 1024 ** 3 + 1) % 1024 ** 2).toBe(0);
  });

  test("the cap is a share of the RAM or a size", () => {
    const total = 64 * 1024 ** 3;
    expect(capBytes("50%", total)).toBe(32 * 1024 ** 3);
    expect(capBytes("24G", total)).toBe(24 * 1024 ** 3);
    expect(capBytes("512M", total)).toBe(512 * 1024 ** 2);
    expect(capBytes("1073741824", total)).toBe(1024 ** 3);
    expect(capBytes("150%", total)).toBeUndefined();
    expect(capBytes("lots", total)).toBeUndefined();
    expect(capBytes("50%", undefined)).toBeUndefined();
  });

  test("a bad command line is the usage, exit 1", () => {
    const done = gate(["run", "--as", "ui", "pnpm", "test"]);
    expect(done.code).toBe(1);
    expect(done.stderr).toContain("usage: fleet fleets gate run");
  });
});

describe.each(SCOPE ? [["a systemd scope", "1"], ["a process group", "0"]] : [["a process group", "0"]])("gate run in %s", (_, scope) => {
  const more = { FLEET_GATE_SCOPE: scope };

  test("passes the command's exit code through and frees the slot, on success and on failure", () => {
    const ok = gate(["run", "--as", "w1", "--", "sh", "-c", "echo out; echo err >&2"], more);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe("out\n");
    expect(ok.stderr).toContain("err\n");
    expect(ok.stderr).toContain("freed the gate");
    expect(existsSync(holdFile())).toBe(false);

    const bad = gate(["run", "--as", "w1", "--", "sh", "-c", "exit 3"], more);
    expect(bad.code).toBe(3);
    expect(first()).toBe("free");
  });

  // vitest 4.1.10 reads $VITEST_MAX_WORKERS over a project's fileParallelism: false (casos-contracts' postgres project),
  // so the gate sets no tool's own variable: a config that wants the run's CPUs reads $FLEET_GATE_RUN_CPUS.
  test("the command gets $FLEET_GATE_RUN_CPUS, its CPU quota (else the CPU budget) at most 8, always the run's own; $VITEST_MAX_WORKERS and $FLEET_GATE_CPUS are left alone", () => {
    const sees = ["sh", "-c", "echo \"$FLEET_GATE_RUN_CPUS ${FLEET_GATE_CPUS-unset} ${VITEST_MAX_WORKERS-unset}\""];
    const set = gate(["run", "--as", "w1", "--cpus", "2", "--", ...sees], { ...more, FLEET_GATE_CPU_BUDGET: "24" });
    expect(set.code).toBe(0);
    expect(set.stdout).toBe("8 unset unset\n");
    expect(set.stderr).not.toContain("VITEST_MAX_WORKERS=");

    if (set.stderr.includes(", CPUQuota=")) {
      expect(set.stderr).toContain("; FLEET_GATE_RUN_CPUS=8 for a config to size its pool by (its CPU quota, 8 at most): ");
    } else {
      expect(set.stderr).toContain("; FLEET_GATE_RUN_CPUS=8 for a config to size its pool by (the CPU budget, 8 at most: no CPU quota): ");
    }

    if (scope === "0") expect(gate(["run", "--as", "w1", "--cpus", "2", "--", ...sees], { ...more, FLEET_GATE_CPU_BUDGET: "3" }).stdout).toBe("3 unset unset\n");

    // A caller's $FLEET_GATE_CPUS is the quota it asks, as before: 16, and the pool's 8 still; a caller's own
    // $FLEET_GATE_RUN_CPUS is the gate's to say.
    const callers = gate(["run", "--as", "w1", "--cpus", "2", "--", ...sees], { ...more, FLEET_GATE_CPU_BUDGET: "24", FLEET_GATE_CPUS: "16", FLEET_GATE_RUN_CPUS: "5", VITEST_MAX_WORKERS: "3" });
    expect(callers.stdout).toBe("8 16 3\n");
    expect(callers.stderr).not.toContain("VITEST_MAX_WORKERS=");

    if (callers.stderr.includes(", CPUQuota=")) expect(callers.stderr).toContain(", CPUQuota=1600% (16 of ");
  });

  // Logged only, to set thresholds by: 10-22's loadavg reached 75 under a 24-CPU budget.
  test("the machine's pressure at the run's start and end, and the most it reached between, go on its record; with no /proc/pressure, none", () => {
    const root = tmp("fleet-gate-proc-");
    const pressure = join(root, "pressure");
    mkdirSync(pressure);
    const psi = (some: string, full: string): string => `some avg10=${some} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full} avg60=0.00 avg300=0.00 total=1\n`;
    writeFileSync(join(pressure, "cpu"), "some avg10=5.00 avg60=0.00 avg300=0.00 total=1\n");
    writeFileSync(join(pressure, "memory"), psi("1.00", "0.50"));
    writeFileSync(join(pressure, "io"), psi("2.00", "1.00"));
    writeFileSync(join(root, "high"), psi("40.00", "20.00"));
    writeFileSync(join(root, "low"), psi("3.00", "0.25"));
    const memory = join(pressure, "memory");

    const done = gate(["run", "--as", "w1", "--", "sh", "-c", `cp ${root}/high ${memory}; sleep 1; cp ${root}/low ${memory}`], { ...more, FLEET_PROC_ROOT: root, FLEET_GATE_PRESSURE_MS: "50" });
    expect(done.code).toBe(0);
    expect(records()[0]).toMatchObject({
      psi_start: { cpu_some: 5, memory_some: 1, memory_full: 0.5, io_some: 2, io_full: 1 },
      psi_end: { cpu_some: 5, memory_some: 3, memory_full: 0.25, io_some: 2, io_full: 1 },
      psi_max: { cpu_some: 5, memory_some: 40, memory_full: 20, io_some: 2, io_full: 1 },
    });

    expect(gate(["run", "--as", "w1", "--", "true"], more).code).toBe(0);
    expect(Object.keys(records()[1] ?? {}).filter((key) => key.startsWith("psi"))).toEqual([]);
  });

  test("a command past its --timeout is stopped, its whole tree with it, exit 124, and the slot freed", async () => {
    const dir = tmp("fleet-gate-tree-");
    const done = gate(["run", "--as", "w1", "--timeout", "2", "--", ...tree(dir)], more);
    expect(done.code).toBe(124);
    expect(done.stderr).toContain("still running after 2s");
    expect(first()).toBe("free");
    expect(await until(() => !alive(pidIn(join(dir, "child"))) && !alive(pidIn(join(dir, "last"))), 8000)).toBe(true);

    if (scope === "1") expect(await until(() => !alive(pidIn(join(dir, "escaped"))), 8000)).toBe(true);
    else process.kill(pidIn(join(dir, "escaped")), "SIGKILL"); // a group cannot hold a process that left it: the scope can
  });

  test("SIGTERM to the runner stops the whole tree, frees the slot, exit 143", async () => {
    const dir = tmp("fleet-gate-tree-");
    const runner = Bun.spawn([FLEET, "fleets", "gate", "run", "--as", "w1", "--", ...tree(dir)], { env: { ...env, ...more }, stdout: "pipe", stderr: "pipe" });
    expect(await until(() => existsSync(join(dir, "last")), 10000)).toBe(true);
    expect(gate([]).stdout).toContain("held by w1 (no fleet)");
    runner.kill("SIGTERM");
    expect(await runner.exited).toBe(143);
    expect(first()).toBe("free");
    expect(await until(() => !alive(pidIn(join(dir, "child"))) && !alive(pidIn(join(dir, "last"))), 8000)).toBe(true);

    if (scope === "1") expect(await until(() => !alive(pidIn(join(dir, "escaped"))), 8000)).toBe(true);
    else process.kill(pidIn(join(dir, "escaped")), "SIGKILL");
  });

  test("SIGKILL to the runner: the watchdog stops the tree, and the slot lapses with the runner", async () => {
    const dir = tmp("fleet-gate-tree-");
    const runner = Bun.spawn([FLEET, "fleets", "gate", "run", "--as", "w1", "--", ...tree(dir)], { env: { ...env, ...more }, stdout: "pipe", stderr: "pipe" });
    expect(await until(() => existsSync(join(dir, "last")), 10000)).toBe(true);
    runner.kill("SIGKILL");
    await runner.exited;
    // In a scope the hold is counted until the watchdog has stopped the scope: the tree still holds its memory.
    expect(await until(() => first() === "free", 12000)).toBe(true);
    expect(await until(() => !alive(pidIn(join(dir, "child"))) && !alive(pidIn(join(dir, "last"))), 12000)).toBe(true);

    if (scope === "1") expect(await until(() => !alive(pidIn(join(dir, "escaped"))), 8000)).toBe(true);
    else process.kill(pidIn(join(dir, "escaped")), "SIGKILL");
  });
});

describe("gate run and the slot", () => {
  test("it waits for another's hold and gives up after --wait, exit 75, running nothing", () => {
    expect(gate(["take", "--as", "other", "browser tests"]).code).toBe(0);
    const done = gate(["run", "--as", "w1", "--wait", "1", "--", "sh", "-c", "echo ran"]);
    expect(done.code).toBe(75);
    expect(done.stdout).toBe("");
    expect(done.stderr).toContain("the gate is held by other");
    expect(gate([]).stdout).toContain("held by other");
  });

  test("it takes the slot once another frees it within --wait", async () => {
    const took = gate(["take", "--as", "other", "browser tests"]);
    const token = /fleet fleets gate free (\S+)`/.exec(took.stdout)?.[1] ?? "";
    const runner = Bun.spawn([FLEET, "fleets", "gate", "run", "--as", "w1", "--wait", "30", "--", "sh", "-c", "echo ran"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await until(() => standing().queue.length === 1, 10000)).toBe(true);
    expect(gate(["free", token]).code).toBe(0);
    expect(await runner.exited).toBe(0);
    expect(await new Response(runner.stdout).text()).toBe("ran\n");
  });

  test("a run never goes under a hold taken by hand, its own name's included: it waits as anyone does", () => {
    expect(gate(["take", "--as", "w1", "just test"]).code).toBe(0);
    const done = gate(["run", "--as", "w1", "--wait", "0", "--", "sh", "-c", "echo ran"]);
    expect(done.code).toBe(75);
    expect(done.stdout).toBe("");
    expect(done.stderr).toContain("the gate is held by w1");
    expect(done.stderr).toContain("w1 holds the gate by hand, and a gate run never runs under a hold taken by hand: free it with its token first");
    expect(holds()[0]).not.toHaveProperty("runner");
    expect(records()[0]).toMatchObject({ name: "w1", code: 75, ran: null });
  });

  test("a run past its time says so with its exit code", () => {
    const done = gate(["run", "--as", "w1", "--timeout", "1", "--", "sleep", "30"], { FLEET_GATE_SCOPE: "0" });
    expect(done.code).toBe(124);
    expect(done.stderr).toMatch(/stopped at its 1s limit after [\d.]+s \(exit 124\); freed the gate/);
  });

  test("another run's hold by the same name is not shared: a second suite of the whole budget waits", async () => {
    const one = running(["--as", "w1", "--landing", "--mem", "50%", "--", "sleep", "5"]);

    try {
      expect(await until(() => existsSync(holdFile()), 10000)).toBe(true);
      const second = gate(["run", "--as", "w1", "--wait", "0", "--", "sh", "-c", "echo ran"]);
      expect(second.code).toBe(75);
      expect(second.stdout).toBe("");
    } finally {
      await stopAll([one]);
    }
  });
});

describe.skipIf(!SCOPE)("gate run and the budget", () => {
  // In scopes: only a run the kernel caps takes a part of the budget (without one it takes it all, below).
  const more = { FLEET_GATE_SCOPE: "1" };

  test("a landing gate and a default run at once; a third waits and, out of time, names the holders and its place", async () => {
    const runs = [running(["--as", "w1", "--landing", "--", "sleep", "30"], more), running(["--as", "w2", "--", "sleep", "30"], more)];

    try {
      expect(await until(() => standing().holders.length === 2, 10000)).toBe(true);
      const third = gate(["run", "--as", "w3", "--wait", "1", "--", "sh", "-c", "echo ran"], more);
      expect(third.code).toBe(75);
      expect(third.stdout).toBe("");
      expect(third.stderr).toMatch(/the gate is held by w[12] \(no fleet\) since \S+, until \S+, estimate [\d.]+G, \d+ CPUs(, a landing gate)?: gate run: sleep 30; and held by w[12] \(no fleet\)/);
      expect(third.stderr).toContain("place 1 in the queue; gave up after 1s without running the command (exit 75)");
      expect(standing().queue).toEqual([]);
    } finally {
      await stopAll(runs);
    }

    expect(first()).toBe("free");
  });

  test("a landing gate of the whole budget waits for a small run, and a small run that comes after does not pass it", async () => {
    const dir = tmp("fleet-gate-order-");
    // `small` holds the gate until the test has read the queue (a minute at most), however slow the machine.
    const hold = `i=0; while [ ! -e ${dir}/release ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`;
    const small = running(["--as", "small", "--mem", "4G", "--cpus", "2", "--", "sh", "-c", `echo small >> ${dir}/order; ${hold}`], more);
    expect(await until(() => standing().holders.length === 1, 10000)).toBe(true);
    const big = running(["--as", "big", "--landing", "--mem", "50%", "--wait", "60", "--", "sh", "-c", `echo big >> ${dir}/order`], more);
    const runs = [small, big];

    try {
      expect(await until(() => standing().queue.length === 1, 10000)).toBe(true);
      // It would fit beside `small`, and is refused: `big` is before it.
      const passing = gate(["run", "--as", "late", "--mem", "4G", "--cpus", "2", "--wait", "0", "--", "sh", "-c", `echo late >> ${dir}/order`], more);
      expect(passing.code).toBe(75);
      expect(passing.stderr).toContain("place 2 in the queue, behind big");

      const late = running(["--as", "late", "--mem", "4G", "--cpus", "2", "--wait", "60", "--", "sh", "-c", `echo late >> ${dir}/order`], more);
      runs.push(late);
      expect(await until(() => standing().queue.length === 2, 10000)).toBe(true);
      const lines = gate([]).stdout.split("\n");
      expect(lines[0]).toMatch(/^held by small \(no fleet\) since \S+, until \S+, estimate 4\.0G, 2 CPUs: gate run: sh -c /);
      expect(lines[1]).toMatch(/^budget [\d.]+G \(50%\): 4\.0G held, [\d.]+G free; CPUs \d+: 2 held, \d+ free$/);
      expect(lines[2]).toMatch(/^queue 1: big \(no fleet\), [\d.]+G, \d+ CPUs, a landing gate, waiting \d+s: gate run: sh -c /);
      expect(lines[3]).toMatch(/^queue 2: late \(no fleet\), 4\.0G, 2 CPUs, waiting \d+s: gate run: sh -c /);
      expect(standing().queue.map((w) => [w["place"], w["name"]])).toEqual([[1, "big"], [2, "late"]]);

      writeFileSync(join(dir, "release"), "");
      expect(await small.exited).toBe(0);
      expect(await big.exited).toBe(0);
      expect(await late.exited).toBe(0);
      expect(readFileSync(join(dir, "order"), "utf8")).toBe("small\nbig\nlate\n");
      expect(await new Response(big.stderr).text()).toMatch(/big holds the gate as a landing gate \(token [0-9a-f]{8}, until \S+\), after \d+s of waiting/);
    } finally {
      await stopAll(runs);
    }
  });

  test("a waiter that is killed leaves the queue, and the next one is not held up by it", async () => {
    const took = gate(["take", "--as", "other", "a build"]);
    const dead = running(["--as", "dead", "--wait", "60", "--", "true"], more);
    expect(await until(() => standing().queue.length === 1, 10000)).toBe(true);
    const next = running(["--as", "next", "--wait", "60", "--", "sh", "-c", "echo ran"], more);

    try {
      expect(await until(() => standing().queue.length === 2, 10000)).toBe(true);
      dead.kill("SIGKILL");
      await dead.exited;
      expect(standing().queue.map((w) => w["name"])).toEqual(["next"]);
      expect(gate(["free", /fleet fleets gate free (\S+)`/.exec(took.stdout)?.[1] ?? ""]).code).toBe(0);
      expect(await next.exited).toBe(0);
      expect(await new Response(next.stdout).text()).toBe("ran\n");
    } finally {
      await stopAll([dead, next]);
    }
  });

  test("many runs at once: never more than the budget holds, and every one runs", async () => {
    const dir = tmp("fleet-gate-race-");
    // Each run notes how many run with it, itself included.
    const body = `mkdir ${dir}/in.$$; ls ${dir} | grep -c '^in' > ${dir}/seen.$$; sleep 0.3; rmdir ${dir}/in.$$`;
    const runs = Array.from({ length: 6 }, (_, i) => running(["--as", `w${String(i)}`, "--wait", "120", "--", "sh", "-c", body], more));

    try {
      expect(await Promise.all(runs.map(async (run) => run.exited))).toEqual([0, 0, 0, 0, 0, 0]);
      const seen = readdirSync(dir).filter((name) => name.startsWith("seen.")).map((name) => Number(readFileSync(join(dir, name), "utf8")));
      expect(seen.length).toBe(6);
      expect(Math.max(...seen)).toBeLessThanOrEqual(2);
      expect(records().length).toBe(6);
    } finally {
      await stopAll(runs);
    }
  }, 90_000);

  test("a cap over the budget, or one that cannot be read, is refused before anything waits or runs (exit 2)", () => {
    const over = gate(["run", "--as", "w1", "--mem", "60%", "--", "sh", "-c", "echo ran"], more);
    expect(over.code).toBe(2);
    expect(over.stdout).toBe("");
    expect(over.stderr).toMatch(/the memory estimate '60%' \([\d.]+G\) is more than the budget of all runs together, 50% \([\d.]+G\)/);
    expect(gate(["run", "--as", "w1", "--mem", "lots", "--", "true"], more).code).toBe(2);
    // A share that rounds to no bytes would be a scope with no memory at all.
    const none = gate(["run", "--as", "w1", "--mem", "0.0000000001%", "--", "sh", "-c", "echo ran"], more);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("64M at least");
    expect(gate(["run", "--as", "w1", "--", "true"], { ...more, FLEET_GATE_MEMORY_BUDGET: "all" }).stderr).toContain("cannot read the budget");
    expect(existsSync(holdFile())).toBe(false);
  });

  test("$FLEET_GATE_MEMORY_BUDGET sets the budget: a quarter of the RAM holds one default run", async () => {
    const budget = { ...more, FLEET_GATE_MEMORY_BUDGET: "25%" };
    const one = running(["--as", "w1", "--", "sleep", "30"], budget);

    try {
      expect(await until(() => standing().holders.length === 1, 10000)).toBe(true);
      expect(gate(["run", "--as", "w2", "--wait", "0", "--", "true"], budget).code).toBe(75);
      // A caller that reads the default, larger budget is held to the holder's.
      expect(gate(["run", "--as", "w2", "--wait", "0", "--", "true"], more).code).toBe(75);
    } finally {
      await stopAll([one]);
    }
  });

  test("a line is kept for each run and each give-up, and `fleet fleets gate` sums the day up", () => {
    expect(gate(["run", "--as", "w1", "--", "sh", "-c", "exit 3"], more).code).toBe(3);
    expect(gate(["take", "--as", "other", "a build"]).code).toBe(0);
    expect(gate(["run", "--as", "w2", "--wait", "1", "--mem", "8G", "--", "just", "test-changed", "a", "b", "c", "d", "e"], more).code).toBe(75);

    const [ran, gaveUp] = records();
    expect(ran).toMatchObject({ name: "w1", kind: "session", what: "sh -c 'exit 3'", asked: "25%", waited: 0, code: 3, killed: 0 });
    expect(asNumber(ran?.["peak"])).toBeGreaterThan(0);
    expect(asNumber(ran?.["ran"])).toBeGreaterThanOrEqual(0);
    expect(asNumber(ran?.["cap"])).toBeGreaterThan(0);
    // Its estimate is its part of the budget; its cap, the ceiling it would have run under, the whole budget.
    expect(gaveUp).toMatchObject({ name: "w2", what: "just test-changed a b c d e", asked: "8G", estimate: 8 * 1024 ** 3, cap: budgetBytes(), ran: null, code: 75, peak: null });
    expect(asNumber(gaveUp?.["waited"])).toBeGreaterThanOrEqual(1);

    const lines = gate([]).stdout.trim().split("\n");
    expect(lines[0]).toContain("held by other (no fleet)");
    expect(lines.at(-1)).toMatch(/^last 24 h: 1 runs, wait median 0s, p90 \d+s, memory peak max [\d.]+[KMG], 1 gave up waiting$/);
    expect(standing().day).toMatchObject({ runs: 1, gave_up: 1, median_wait: 0, capped: 0 });
  });
});

describe("gate run and the memory available", () => {
  const GB = 1024 ** 3;

  /** No scope, so the run asks for the whole budget, 32G, and counts its cap, 16G, against the floor; a meminfo whose
   * MemAvailable is `available` bytes. */
  function withAvailable(available: number, more: Readonly<Environment> = {}): Environment {
    const path = join(home, "meminfo");
    writeFileSync(path, `MemTotal:       67108864 kB\nMemAvailable:   ${String(available / 1024)} kB\n`);

    return { FLEET_GATE_SCOPE: "0", FLEET_GATE_MEMORY_BUDGET: "32G", FLEET_GATE_MEMORY_MAX: "16G", FLEET_MEMINFO: path, ...more };
  }

  test("below the floor it waits in the queue, says why, and gives up at --wait, exit 75, running nothing", () => {
    const done = gate(["run", "--as", "w1", "--wait", "1", "--", "sh", "-c", "echo ran"], withAvailable(20 * GB));
    expect(done.code).toBe(75);
    expect(done.stdout).toBe("");
    expect(done.stderr).toContain("gate run: waiting for the memory floor: not enough memory: 24.0G needed, 20.0G available (16.0G for this run, one run's cap, as it takes the whole budget, 8.0G floor); place 1 in the queue; waiting up to 1s\n");
    expect(done.stderr).toContain(
      "gate run: waiting for the memory floor: not enough memory: 24.0G needed, 20.0G available (16.0G for this run, one run's cap, as it takes the whole budget, 8.0G floor); place 1 in the queue; gave up after 1s without running the command (exit 75). " +
        "Run it again later, or with a longer --wait\n",
    );
    expect(records()[0]).toMatchObject({ name: "w1", code: 75, ran: null });
    expect(standing()).toMatchObject({ holders: [], queue: [] });
  });

  // Two runs each go past their 8G estimate toward the 31G ceiling at once, on a 62G machine whose sessions use 30G.
  test.skipIf(!SCOPE)("runs past their estimates leave MemAvailable under the floor: a new run waits for the memory floor, and nothing running is touched", async () => {
    const root = join(home, "cgroup");
    const meminfo = join(home, "meminfo");
    // 62G less the sessions' 30G and the two runs' 14G each: 4G available.
    writeFileSync(meminfo, `MemTotal:       ${String(62 * 1024 * 1024)} kB\nMemAvailable:   ${String(4 * 1024 * 1024)} kB\n`);
    const runners = [Bun.spawn(["sleep", "300"]), Bun.spawn(["sleep", "300"])];

    const hold = (n: number, pid: number): JsonObject => ({
      fleet: `run${String(n)}`, kind: "session", what: `gate run: suite ${String(n)}`, since: new Date().toISOString(), until: new Date(Date.now() + 3600_000).toISOString(),
      token: `0a1b2c3${String(n)}`, cap: 8 * GB, budget: 31 * GB, pid, unit: `fleet-gate-0a1b2c3${String(n)}-${String(pid)}`, cpus: 8,
    });

    const kept = runners.map((r, i) => hold(i + 1, r.pid));

    for (const h of kept) {
      mkdirSync(join(root, `${String(h["unit"])}.scope`), { recursive: true });
      writeFileSync(join(root, `${String(h["unit"])}.scope`, "memory.current"), `${String(14 * GB)}\n`);
      writeFileSync(join(root, `${String(h["unit"])}.scope`, "memory.stat"), "anon 0\nfile 0\n");
    }

    mkdirSync(join(home, "gate"), { recursive: true });
    writeFileSync(holdFile(), JSON.stringify({ fleet: "run1", kind: "session", what: "w", since: new Date().toISOString(), v: 2, holds: kept }));
    const machine = { FLEET_GATE_SCOPE: "1", FLEET_MEMINFO: meminfo, FLEET_CGROUP_ROOT: root, FLEET_GATE_MEMORY_FLOOR: "8G" };

    try {
      // 8G + 8G + 4G fit the 31G budget: what it lacks is the floor, 4G available less its 4G.
      const late = gate(["run", "--as", "late", "--mem", "4G", "--cpus", "2", "--wait", "1", "--", "sh", "-c", "echo ran"], machine);
      expect(late.code).toBe(75);
      expect(late.stdout).toBe("");
      expect(late.stderr).toContain("gate run: waiting for the memory floor: the gate is held by run1 (no fleet) since ");
      expect(late.stderr).toContain(", estimate 8.0G, 8 CPUs: gate run: suite 1; and held by run2 ");
      expect(late.stderr).toContain("not enough memory: 12.0G needed, 4.0G available (4.0G for this run, 8.0G floor)");
      expect(late.stderr).not.toContain("waiting for memory:");
      // The runs past their estimates go on: their runners live, and their holds are as they were.
      expect(runners.map((r) => alive(r.pid))).toEqual([true, true]);
      expect(holds()).toEqual(kept);
    } finally {
      for (const r of runners) r.kill("SIGKILL");
      await Promise.all(runners.map(async (r) => r.exited));
    }
  });

  test("it runs once memory frees within --wait", async () => {
    const short = withAvailable(20 * GB);
    const runner = Bun.spawn([FLEET, "fleets", "gate", "run", "--as", "w1", "--wait", "30", "--", "sh", "-c", "echo ran"], { env: { ...env, ...short }, stdout: "pipe", stderr: "pipe" });
    expect(await until(() => standing().queue.length === 1, 10000)).toBe(true);
    withAvailable(24 * GB);
    expect(await runner.exited).toBe(0);
    expect(await new Response(runner.stdout).text()).toBe("ran\n");
  });

  test("--floor, else $FLEET_GATE_MEMORY_FLOOR, sets the floor; one that cannot be read is refused before anything waits (exit 2)", () => {
    expect(gate(["run", "--as", "w1", "--floor", "4G", "--", "true"], withAvailable(20 * GB)).code).toBe(0);
    expect(gate(["run", "--as", "w1", "--", "true"], withAvailable(20 * GB, { FLEET_GATE_MEMORY_FLOOR: "4G" })).code).toBe(0);
    const bad = gate(["run", "--as", "w1", "--floor", "lots", "--", "sh", "-c", "echo ran"], withAvailable(64 * GB));
    expect(bad.code).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toBe("gate run: cannot read --floor 'lots': give a size (8G) or a share of the RAM (12%), 64M at least, or 0 to keep nothing free\n");
  });

  test("where MemAvailable cannot be read, --floor is ignored, and says so", () => {
    const done = gate(["run", "--as", "w1", "--floor", "4G", "--", "true"], { FLEET_GATE_SCOPE: "0" });
    expect(done.code).toBe(0);
    expect(done.stderr).toContain("gate run: no MemAvailable here (no /proc/meminfo): --floor is ignored, and only the budget counts\n");
  });
});

describe("what keeps the memory within the budget", () => {
  const scope = { FLEET_GATE_SCOPE: SCOPE ? "1" : "0" };

  test("a fleet's run holds its memory after the fleet's entry is gone", async () => {
    const keeper = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(home, "f1.json"), JSON.stringify({ id: "f1", dir: tmp("fleet-gate-f1-"), pid: keeper.pid, url: "", since: "2026-10-13T00:00:00+00:00", session: "f1" }));
    const run = running(["f1", "--", "sleep", "30"], scope);

    try {
      expect(await until(() => standing().holders.length === 1, 10000)).toBe(true);
      expect(standing().holders[0]).toMatchObject({ name: "f1", kind: "fleet" });
      unlinkSync(join(home, "f1.json"));
      expect(first()).toContain("held by f1 since");
      const beside = gate(["run", "--as", "y", "--landing", "--mem", "50%", "--wait", "0", "--", "sh", "-c", "echo ran"], scope);
      expect(beside.code).toBe(75);
      expect(beside.stdout).toBe("");
    } finally {
      await stopAll([run]);
      keeper.kill("SIGKILL");
      await keeper.exited;
    }
  });

  test.skipIf(!SCOPE)("a caller that reads a larger budget does not widen it beside another's run", async () => {
    const one = running(["--as", "a", "--", "sleep", "30"], scope);

    try {
      expect(await until(() => standing().holders.length === 1, 10000)).toBe(true);
      const wide = gate(["run", "--as", "b", "--mem", "75%", "--wait", "0", "--", "sh", "-c", "echo ran"], { ...scope, FLEET_GATE_MEMORY_BUDGET: "100%" });
      expect(wide.code).toBe(75);
      expect(wide.stdout).toBe("");
      expect(standing().holders.map((h) => h["name"])).toEqual(["a"]);
    } finally {
      await stopAll([one]);
    }
  });

  test("a release does not drop the hold of a run that is still going: it says how to end the run", async () => {
    const one = running(["--as", "a", "--", "sleep", "30"], scope);

    try {
      expect(await until(() => standing().holders.length === 1, 10000)).toBe(true);

      for (const key of ["a", String(holds()[0]?.["token"])]) {
        const refused = gate(["free", key]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toMatch(SCOPE
          ? /^fleets: a's gate run \(pid \d+\) is still going: gate run: sleep 30; a run's hold is freed when the run ends\. To end it, with every process it started: `systemctl --user stop fleet-gate-[0-9a-f]{8}-\d+\.scope`\n$/
          : /^fleets: a's gate run \(pid \d+\) is still going: gate run: sleep 30; a run's hold is freed when the run ends\. To end it, with every process it started: `kill \d+`\n$/);
      }

      expect(standing().holders.map((h) => h["name"])).toEqual(["a"]);
      expect(gate(["run", "--as", "c", "--landing", "--mem", "50%", "--wait", "0", "--", "sh", "-c", "echo ran"], scope).code).toBe(75);
    } finally {
      await stopAll([one]);
    }

    expect(first()).toBe("free");
  });

  test("a hold taken by hand stays its taker's: a run of the same name waits, and the token frees the hold", async () => {
    const token = /^token ([0-9a-f]+),/m.exec(gate(["take", "--as", "a", "by hand"]).stdout)?.[1] ?? "";
    const dir = tmp("fleet-gate-same-name-");
    const one = Bun.spawn([FLEET, "fleets", "gate", "run", "--as", "a", "--wait", "30", "--", "sh", "-c", `touch ${dir}/ran; echo ran`], { env: { ...env, ...scope }, stdout: "pipe", stderr: "pipe" });

    try {
      expect(await until(() => standing().queue.length === 1, 10000)).toBe(true);
      expect(holds()[0]).not.toHaveProperty("runner");
      expect(existsSync(join(dir, "ran"))).toBe(false);

      const freed = gate(["free", token]);
      expect(freed.stderr).toBe("");
      expect(freed.stdout).toBe("free\n");
      expect(await one.exited).toBe(0);
      expect(await new Response(one.stdout).text()).toBe("ran\n");
    } finally {
      one.kill("SIGTERM");
      await one.exited;
    }

    expect(first()).toBe("free");
  });

  test.skipIf(!SCOPE)("a scope that does not stop keeps its hold: the run says so, and the gate still counts it", async () => {
    const bin = tmp("fleet-gate-bin-");
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh\ncase " $* " in *" stop "*) exit 1;; esac\nexec ${Bun.which("systemctl") ?? "systemctl"} "$@"\n`, { mode: 0o755 });
    const done = gate(["run", "--as", "s", "--timeout", "20", "--", "sh", "-c", "sleep 30 >/dev/null 2>&1 & echo ran"], { ...scope, PATH: `${bin}:${process.env["PATH"] ?? ""}` });
    const unit = String(holds()[0]?.["unit"]);

    try {
      expect(done.code).toBe(0);
      expect(done.stdout).toBe("ran\n");
      expect(done.stderr).toContain(`the scope ${unit}.scope still has processes after its stop: its hold stays while it does. Stop it: \`systemctl --user stop ${unit}.scope\``);
      expect(first()).toContain("held by s (no fleet)");
      expect(gate(["run", "--as", "big", "--landing", "--mem", "50%", "--wait", "0", "--", "sh", "-c", "echo ran"], scope).code).toBe(75);
    } finally {
      Bun.spawnSync(["systemctl", "--user", "stop", `${unit}.scope`]);
    }

    expect(await until(() => first() === "free", 5000)).toBe(true);
  });

  test.skipIf(!SCOPE)("the scope stops itself a grace after the run's time, and the hold outlasts the stop", async () => {
    const dir = tmp("fleet-gate-limit-");
    const show = `systemctl --user show "$(basename "$(sed -n 's/^0:://p' /proc/self/cgroup)")" -p RuntimeMaxUSec --value > ${dir}/limit; sleep 30`;
    const run = running(["--as", "w1", "--for", "2", "--timeout", "20", "--", "sh", "-c", show], scope);

    try {
      expect(await until(() => existsSync(join(dir, "limit")) && readFileSync(join(dir, "limit"), "utf8").trim() !== "", 10000)).toBe(true);
      expect(readFileSync(join(dir, "limit"), "utf8").trim()).toBe("25s");
      const [hold] = holds();
      expect((Date.parse(String(hold?.["until"])) - Date.parse(String(hold?.["since"]))) / 1000).toBe(2 * 60 + 15);
    } finally {
      await stopAll([run]);
    }
  });

  test.skipIf(!SCOPE)("a scope whose runner and watchdog were both killed is counted while it lives, and ends at its own limit", async () => {
    const dir = tmp("fleet-gate-orphan-");
    const run = running(["--as", "k", "--timeout", "3", "--", "sh", "-c", `echo $$ > ${dir}/pid; exec sleep 60`], { ...scope, FLEET_GATE_STOP_GRACE_S: "1" });
    expect(await until(() => existsSync(join(dir, "pid")) && /^\d+\n$/.test(readFileSync(join(dir, "pid"), "utf8")), 10000)).toBe(true);
    const children = Bun.spawnSync(["pgrep", "-P", String(run.pid)]).stdout.toString().trim().split("\n").map(Number);
    const dogs = children.filter((pid) => readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").includes("while kill -0"));
    expect(dogs.length).toBe(1);

    for (const dog of dogs) process.kill(dog, "SIGKILL");
    run.kill("SIGKILL");
    await run.exited;
    // Nobody is left to stop it, and it still holds its memory: the gate counts it, and nothing fits beside it and another.
    expect(alive(pidIn(join(dir, "pid")))).toBe(true);
    expect(first()).toContain("held by k (no fleet)");
    expect(gate(["run", "--as", "big", "--landing", "--mem", "50%", "--wait", "0", "--", "sh", "-c", "echo ran"], scope).code).toBe(75);
    const refused = gate(["free", "k"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/`systemctl --user stop fleet-gate-[0-9a-f]{8}-\d+\.scope`\n$/);
    // The scope's own RuntimeMaxSec stops it, at the run's time and a grace, and its part of the budget is free again.
    expect(await until(() => !alive(pidIn(join(dir, "pid"))), 20000)).toBe(true);
    expect(await until(() => first() === "free", 5000)).toBe(true);
  }, 40_000);

  test("without a scope nothing caps a run, so it takes the whole budget: one at a time", async () => {
    const bare = { FLEET_GATE_SCOPE: "0" };
    const one = running(["--as", "a", "--", "sleep", "30"], bare);

    try {
      expect(await until(() => standing().holders.length === 1, 10000)).toBe(true);
      expect(standing().holders[0]?.["cap"]).toBeNull();
      const second = gate(["run", "--as", "b", "--wait", "0", "--", "sh", "-c", "echo ran"], bare);
      expect(second.code).toBe(75);
      expect(second.stdout).toBe("");
      expect(second.stderr).toContain("warning: $FLEET_GATE_SCOPE is 0, so nothing caps the command's memory: this run asks for the whole budget, one run at a time");
      expect(gate(["run", "--as", "c", "--wait", "0", "--", "sh", "-c", "echo ran"], scope).code).toBe(75);
    } finally {
      await stopAll([one]);
    }

    expect(records().at(-1)).toMatchObject({ name: "a", asked: "all (no scope)", cap: budgetBytes(), peak: null });
  });

  test.skipIf(!SCOPE)("a systemd user manager that does not answer in time is said, and the run takes the whole budget", () => {
    const bin = tmp("fleet-gate-bin-");
    writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const done = gate(["run", "--as", "w1", "--", "sh", "-c", "echo ran"], { PATH: `${bin}:${process.env["PATH"] ?? ""}`, FLEET_GATE_SCOPE_PROBE_MS: "200" });
    expect(done.code).toBe(0);
    expect(done.stdout).toBe("ran\n");
    expect(done.stderr).toMatch(/warning: systemctl --user did not answer in 0\.2s.*, so nothing caps the command's memory: this run asks for the whole budget/);
    expect(records()[0]).toMatchObject({ asked: "all (no scope)" });
  }, 30_000);
});
