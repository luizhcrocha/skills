/**
 * `fleet fleets gate run`: a suite through the gate, as one process tree that dies whole, within the memory budget
 * all runs share and in the queue's order. Each test runs the CLI as its own process (signals are part of the
 * surface), with its own registry; the scope tests need a systemd user manager and are skipped where there is
 * none (the Mac). gate.test.ts has the admission rules themselves.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { capBytes, cpusHere, memEstimate, sizeText } from "../src/gate.ts";
import { asArray, asNumber, asObject, type JsonObject } from "../src/json.ts";
import { runArgs, scopeAvailable } from "../src/gate-run.ts";
import { baseEnv, FLEET, tmp, type Environment } from "./support.ts";

let home: string;

let env: Environment;

const SCOPE = scopeAvailable((name) => process.env[name]);

// Each run is a fleet process or two, and a stopped tree has seconds of grace.
setDefaultTimeout(30_000);

beforeEach(() => {
  home = join(tmp("fleet-gate-run-"), "registry");
  mkdirSync(home);
  // This checkout's fleet, whatever newer one the machine has (baseEnv drops the session's FLEET_GATE_* settings).
  env = baseEnv(home, { FLEET_NO_FORWARD: "1" });
});

interface Done {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function gate(args: readonly string[], more: Readonly<Environment> = {}, cwd?: string): Done {
  const done = Bun.spawnSync([FLEET, "fleets", "gate", ...args], { env: { ...env, ...more }, stdout: "pipe", stderr: "pipe", cwd: cwd ?? process.cwd() });

  return { code: done.exitCode ?? -1, stdout: done.stdout.toString(), stderr: done.stderr.toString() };
}

function holdFile(): string {
  return join(home, "gate", "gate.json");
}

/** `fleet fleets gate`'s first line: `free`, or the first hold. */
function first(): string {
  return gate([]).stdout.split("\n")[0] ?? "";
}

/** The records of the runs, a line each. */
function records(): JsonObject[] {
  return readFileSync(join(home, "gate", "runs.jsonl"), "utf8").trim().split("\n").map((line) => asObject(JSON.parse(line)) ?? {});
}

/** `fleet fleets gate --json`. */
function standing() {
  const said = asObject(JSON.parse(gate(["--json"]).stdout)) ?? {};
  const rows = (key: string): JsonObject[] => (asArray(said[key]) ?? []).map((row) => asObject(row) ?? {});

  return { holders: rows("holders"), queue: rows("queue"), day: asObject(said["day"]) };
}

/** The budget's bytes, as `fleet fleets gate --json` says it. */
function budgetBytes(): number {
  return asNumber(asObject(asObject(JSON.parse(gate(["--json"]).stdout))?.["budget"])?.["bytes"]) ?? 0;
}

/** The holds as gate.json keeps them. */
function holds(): JsonObject[] {
  const kept = asObject(JSON.parse(readFileSync(holdFile(), "utf8"))) ?? {};
  const several = (asArray(kept["holds"]) ?? []).map((hold) => asObject(hold) ?? {});

  return several.length > 0 ? several : [kept];
}

/** A `gate run` left running, with what it said so far kept for the test's end. */
function running(args: readonly string[], more: Readonly<Environment> = {}, cwd?: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([FLEET, "fleets", "gate", "run", ...args], { env: { ...env, ...more }, stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: cwd ?? process.cwd() });
}

async function stopAll(runs: readonly Bun.Subprocess[]): Promise<void> {
  for (const run of runs) run.kill("SIGTERM");
  await Promise.all(runs.map(async (run) => run.exited));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(50);
  }

  return check();
}

function pidIn(path: string): number {
  return Number(readFileSync(path, "utf8").trim());
}

/** A command that starts a child and a grandchild in a session of its own (out of every process group), writes their pids, and sleeps. */
function tree(dir: string): string[] {
  return ["sh", "-c", `sleep 300 & echo $! > ${dir}/child; setsid sleep 301 >/dev/null 2>&1 & echo $! > ${dir}/escaped; sleep 302 & echo $! > ${dir}/last; wait`];
}

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
    await Bun.sleep(1500);
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
    const run = running(["--as", "k", "--timeout", "3", "--", "sh", "-c", `echo $$ > ${dir}/pid; exec sleep 60`], scope);
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
    const done = gate(["run", "--as", "w1", "--", "sh", "-c", "echo ran"], { PATH: `${bin}:${process.env["PATH"] ?? ""}` });
    expect(done.code).toBe(0);
    expect(done.stdout).toBe("ran\n");
    expect(done.stderr).toMatch(/warning: systemctl --user did not answer in 5s.*, so nothing caps the command's memory: this run asks for the whole budget/);
    expect(records()[0]).toMatchObject({ asked: "all (no scope)" });
  }, 30_000);
});

describe.skipIf(!SCOPE)("gate run's scope", () => {
  test("a child over the ceiling, the whole budget, is killed by the kernel inside the scope, and the run says so", () => {
    const hog = ["python3", "-c", "x = bytearray(400 * 1024 * 1024); print('survived')"];
    const done = gate(["run", "--as", "w1", "--wait", "5", "--", ...hog], { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_BUDGET: "64M" });
    expect(done.stdout).not.toContain("survived");
    expect(done.code).toBe(137);
    expect(done.stderr).toContain("MemoryMax=64.0M (the budget), no swap");
    // oom_kill counts the machine-wide OOM killer's kills too: the line blames neither the run alone nor names a
    // flag or variable that widens it.
    expect(done.stderr).toMatch(/\ngate run: \d+ process\(es\) of the run killed for memory: the run or the machine ran out \(its ceiling MemoryMax=64\.0M is the whole budget, 64M\)\n/);
    expect(done.stderr).not.toContain("Run it again");
    expect(done.stderr.split("\n").find((line) => line.includes("killed for memory"))).not.toContain("FLEET_GATE");
    expect(first()).toBe("free");
    expect(records()[0]).toMatchObject({ name: "w1", asked: "25%", cap: 64 * 1024 ** 2, estimate: 64 * 1024 ** 2, code: 137 });
    expect(asNumber(records()[0]?.["killed"])).toBeGreaterThan(0);
    expect(gate([]).stdout).toMatch(/\nlast 24 h: 1 runs, .*, 1 hit the cap\n$/);
  });

  test("the estimate is a quarter of the RAM by default, $FLEET_GATE_MEMORY_MAX with no earlier run, and a smaller budget lowers it; the ceiling is the budget", () => {
    const budget = budgetBytes();
    const plain = gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1" });
    expect(plain.stderr).toContain("from the default 25% (no earlier run)");
    expect(plain.stderr).toContain(`; MemoryMax=${sizeText(budget)} (the budget, 50% of `);
    expect(gate(["run", "--as", "w1", "--", "sh", "-c", "true"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_MAX: "50%" }).stderr).toContain("from $FLEET_GATE_MEMORY_MAX 50% (no earlier run)");
    const lowered = gate(["run", "--as", "w1", "--", "sh", "-c", ":"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_BUDGET: "256M" });
    expect(lowered.code).toBe(0);
    expect(lowered.stderr).toContain("estimate 256.0M from the default 25% (no earlier run), lowered from ");
    expect(lowered.stderr).toContain("MemoryMax=256.0M (the budget), no swap");
  });

  test("the command reaches the scope word for word: systemd-run does not rewrite its dollar signs", () => {
    const done = gate(["run", "--as", "w1", "--", "sh", "-c", "echo ${FLEET_HOME} $$"], { FLEET_GATE_SCOPE: "1" });
    expect(done.code).toBe(0);
    expect(done.stdout).toMatch(new RegExp(`^${home} \\d+\n$`));
  });

  test("the scope's memory peak is kept, when the command ends and when it is stopped", () => {
    expect(gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1" }).stderr).toMatch(/exit 0 after [\d.]+s, memory peak [\d.]+[KMG]; freed the gate/);
    expect(gate(["run", "--as", "w1", "--timeout", "1", "--", "sleep", "30"], { FLEET_GATE_SCOPE: "1" }).code).toBe(124);
    expect(records().map((r) => (asNumber(r["peak"]) ?? 0) > 0)).toEqual([true, true]);
    expect(asNumber(standing().day?.["max_peak"])).toBeGreaterThan(0);
  });

  test("a process of the run that asks for an app scope of its own, as Chromium does, is taken back: the cap, the peak and the stop count it", () => {
    const dir = tmp("fleet-gate-app-");
    const app = `app-fleet-test-${String(process.pid)}-${String(Date.now())}`;

    // systemd-run --scope asks the user manager for the scope over D-Bus and execs into it, as Chromium's browser process asks for app-org.chromium.Chromium-<pid>.scope.
    const command = `systemd-run --user --scope --quiet --collect --unit ${app} sleep 300 & echo $! > ${dir}/pid; sleep 2; ` +
      `if [ "$(cat /proc/$(cat ${dir}/pid)/cgroup)" = "$(cat /proc/self/cgroup)" ]; then echo inside; else echo outside; fi`;

    try {
      const done = gate(["run", "--as", "w1", "--", "sh", "-c", command], { FLEET_GATE_SCOPE: "1" });
      expect(done.stdout).toBe("inside\n");
      expect(done.stderr).toContain(`took back into the run's scope the processes of the run that had left it for an app scope (1 from ${app}.scope)`);
      expect(alive(pidIn(join(dir, "pid")))).toBe(false);
    } finally {
      Bun.spawnSync(["systemctl", "--user", "stop", `${app}.scope`], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("an app scope's process whose chain reaches the run only through another scope (a gate run inside the run) is that scope's, and left alone", () => {
    const dir = tmp("fleet-gate-nested-");
    const stamp = `${String(process.pid)}-${String(Date.now())}`;
    const [inner, bare, marked] = [`fleet-test-inner-${stamp}`, `app-fleet-test-bare-${stamp}`, `app-fleet-test-marked-${stamp}`];

    // The inner scope is a gate run inside the run, its own FLEET_GATE_RUN: one escapee keeps it, one has none, so only its parent chain says whose it is.
    const launch = `env -u FLEET_GATE_RUN systemd-run --user --scope --quiet --collect --unit ${bare} sleep 300 & echo $! > ${dir}/bare; ` +
      `systemd-run --user --scope --quiet --collect --unit ${marked} sleep 300 & echo $! > ${dir}/marked; wait`;

    const command = `FLEET_GATE_RUN=${inner} systemd-run --user --scope --quiet --collect --unit ${inner} sh -c '${launch}' >/dev/null 2>&1 & sleep 2; ` +
      `for p in bare marked; do sed -n 's/.*\\///p' /proc/$(cat ${dir}/$p)/cgroup; done`;

    try {
      const done = gate(["run", "--as", "w1", "--", "sh", "-c", command], { FLEET_GATE_SCOPE: "1" });
      expect(done.stdout).toBe(`${bare}.scope\n${marked}.scope\n`);
      expect(done.stderr).not.toContain("took back");
    } finally {
      for (const unit of [inner, bare, marked]) Bun.spawnSync(["systemctl", "--user", "stop", `${unit}.scope`], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("a process of the run orphaned before it asks for an app scope is still taken back, by the FLEET_GATE_RUN it carries", () => {
    const dir = tmp("fleet-gate-orphan-");
    const app = `app-fleet-test-orphan-${String(process.pid)}-${String(Date.now())}`;

    // The shell that starts it exits first: the user manager inherits it, and no parent chain leads back to the run.
    const command = `sh -c '(sleep 0.5; exec systemd-run --user --scope --quiet --collect --unit ${app} sleep 300) >/dev/null 2>&1 & echo $! > ${dir}/pid'; sleep 3; ` +
      `if [ "$(cat /proc/$(cat ${dir}/pid)/cgroup)" = "$(cat /proc/self/cgroup)" ]; then echo inside; else echo outside; fi`;

    try {
      const done = gate(["run", "--as", "w1", "--", "sh", "-c", command], { FLEET_GATE_SCOPE: "1" });
      expect(done.stdout).toBe("inside\n");
      expect(done.stderr).toContain(`(1 from ${app}.scope)`);
      expect(alive(pidIn(join(dir, "pid")))).toBe(false);
    } finally {
      Bun.spawnSync(["systemctl", "--user", "stop", `${app}.scope`], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("a process of the run that leaves for an app scope as the run ends dies with the run's stop, and the run says so", () => {
    const dir = tmp("fleet-gate-late-");
    const app = `app-fleet-test-late-${String(process.pid)}-${String(Date.now())}`;

    // The command ends the moment its child is in the app scope: no sweep of the run's sees it while the run goes.
    const command = `systemd-run --user --scope --quiet --collect --unit ${app} sleep 300 >/dev/null 2>&1 & echo $! > ${dir}/pid; ` +
      `while [ "$(cat /proc/$!/cgroup)" = "$(cat /proc/self/cgroup)" ]; do :; done`;

    try {
      const done = gate(["run", "--as", "w1", "--", "sh", "-c", command], { FLEET_GATE_SCOPE: "1" });
      expect(alive(pidIn(join(dir, "pid")))).toBe(false);
      expect(done.stderr.includes(`(1 from ${app}.scope)`) || done.stderr.includes(`(1 in ${app}.scope)`)).toBe(true);
    } finally {
      Bun.spawnSync(["systemctl", "--user", "stop", `${app}.scope`], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("a process the run could not take back is named, with the error, and dies with the run's stop", () => {
    const dir = tmp("fleet-gate-refused-");
    const app = `app-fleet-test-refused-${String(process.pid)}-${String(Date.now())}`;

    // The run's own cgroup.procs, read-only, refuses the runner's write.
    const command = `chmod a-w "/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)/cgroup.procs"; ` +
      `systemd-run --user --scope --quiet --collect --unit ${app} sleep 300 >/dev/null 2>&1 & echo $! > ${dir}/pid; sleep 1.5`;

    try {
      const done = gate(["run", "--as", "w1", "--", "sh", "-c", command], { FLEET_GATE_SCOPE: "1" });
      expect(done.stderr).toContain(`gate run: could not take back 1 from ${app}.scope: EACCES`);
      expect(alive(pidIn(join(dir, "pid")))).toBe(false);
    } finally {
      Bun.spawnSync(["systemctl", "--user", "stop", `${app}.scope`], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("the scope has a CPU weight, so two runs share the cores evenly; without one the run is niced", () => {
    const weight = ["sh", "-c", 'cat "/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)/cpu.weight"'];
    const weighed = gate(["run", "--as", "w1", "--", ...weight], { FLEET_GATE_SCOPE: "1" });

    // Where the user manager has the cpu controller, the scope is weighed; elsewhere it says why not and nices.
    if (weighed.stderr.includes("CPUWeight=100")) {
      expect(weighed.stdout).toBe("100\n");
      expect(gate(["run", "--as", "w1", "--", ...weight], { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPU_WEIGHT: "300" }).stdout).toBe("300\n");
    } else {
      expect(weighed.stderr).toContain("nice 5 (no CPU weight");
    }

    const niced = gate(["run", "--as", "w1", "--", "sh", "-c", "nice"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPU_WEIGHT: "0" });
    expect(niced.stderr).toContain("nice 5 (no CPU weight");
    expect(Number(niced.stdout)).toBeGreaterThanOrEqual(5);
  });

  test("the scope has a CPU quota, so a pool sized by a count that reads it (nproc, Node's) starts no more workers than that", () => {
    const sees = ["sh", "-c", "nproc; node -p 'require(\"os\").availableParallelism()'"];
    const all = cpusHere();
    const half = Math.max(2, Math.floor(all / 2));
    // --cpus is the estimate, for admission alone: the quota is the same for every run.
    const halved = gate(["run", "--as", "w1", "--cpus", "2", "--", ...sees], { FLEET_GATE_SCOPE: "1" });

    // Where the user manager has no cpu controller there is no quota, as there is no weight, and the run says so.
    if (!halved.stderr.includes("CPUWeight=")) {
      expect(halved.stderr).toContain("no CPUQuota (the systemd user manager has no cpu controller)");

      return;
    }

    if (half < all) {
      expect(halved.stdout).toBe(`${String(half)}\n${String(half)}\n`);
      expect(halved.stderr).toContain(`CPUQuota=${String(half * 100)}% (${String(half)} of ${String(all)} CPUs: nproc, Node's os.availableParallelism(), Rust's and Go's (1.25 on) count ${String(half)}, so a pool they size starts ${String(half)} workers; one sized by os.cpus(), Bun's os.availableParallelism(), a config's maxWorkers or Playwright keeps its size)`);
    }

    if (all > 3) expect(gate(["run", "--as", "w1", "--", ...sees], { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPUS: "3" }).stdout).toBe("3\n3\n");

    // $FLEET_GATE_CPUS as large as the machine: no quota.
    const whole = gate(["run", "--as", "w1", "--", ...sees], { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPUS: String(all) });
    expect(whole.stdout).toBe(`${String(all)}\n${String(all)}\n`);
    expect(whole.stderr).toContain(`no CPUQuota ($FLEET_GATE_CPUS is ${String(all)}, at least the machine's ${String(all)} CPUs)`);
  });

  test("a $FLEET_GATE_CPUS that is not a whole number is named in the run's line, and half the CPUs taken", () => {
    for (const given of ["abc", "-1", "2.5", "+4", ""]) {
      const said = gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPUS: given });
      expect(said.stderr).toContain(`$FLEET_GATE_CPUS "${given}" is not a whole number of CPUs: half the CPUs taken`);
    }
  });
});

describe.skipIf(!SCOPE)("gate run's record, and its estimate from the last runs", () => {
  const more = { FLEET_GATE_SCOPE: "1" };
  /** A command of more than 80 characters, a word each that needs no quoting: its record's `what` is these words. */
  const long = ["sh", "-c", "true", "first-word", "second-word", "third-word", "fourth-word", "fifth-word", "sixth-word", "seventh-word", "eighth-word"];

  function sh(cwd: string, command: readonly string[]): string {
    const done = Bun.spawnSync([...command], { cwd, env: { ...process.env, JJ_USER: "t", JJ_EMAIL: "t@example.com" }, stdout: "pipe", stderr: "pipe" });
    expect(done.exitCode).toBe(0);

    return done.stdout.toString().trim();
  }

  function gitRepo(): string {
    const dir = tmp("fleet-gate-git-");
    sh(dir, ["git", "init", "-q"]);
    sh(dir, ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one"]);

    return dir;
  }

  test("in a git repository a run keeps the repository's common directory, its root, HEAD, the whole command, its CPU seconds and its CPUs", () => {
    const repo = gitRepo();
    expect(gate(["run", "--as", "w1", "--", ...long], more, repo).code).toBe(0);
    const [kept] = records();
    expect(long.join(" ").length).toBeGreaterThan(80);
    expect(kept).toMatchObject({ repo: realpathSync(join(repo, ".git")), workspace: sh(repo, ["git", "rev-parse", "--show-toplevel"]), commit: sh(repo, ["git", "rev-parse", "HEAD"]), what: long.join(" ") });
    expect(asNumber(kept?.["cpu_s"])).toBeGreaterThan(0);
    expect(asNumber(kept?.["cpus"])).toBeGreaterThan(0);
    expect(asNumber(kept?.["estimate"])).toBeGreaterThan(0);
    expect(kept?.["landing"]).toBeUndefined();
  });

  test.skipIf(Bun.which("jj") === null)("in a jj repository the commit is @-'s, and a landing gate is marked", () => {
    const repo = tmp("fleet-gate-jj-");
    sh(repo, ["jj", "git", "init", "--quiet"]);
    writeFileSync(join(repo, "a"), "a\n");
    sh(repo, ["jj", "commit", "--quiet", "-m", "one"]);
    const parent = sh(repo, ["jj", "log", "--ignore-working-copy", "--no-graph", "-r", "@-", "-T", "commit_id"]);
    expect(gate(["run", "--as", "w1", "--landing", "--", "true"], more, repo).code).toBe(0);
    expect(records()[0]).toMatchObject({ repo: realpathSync(join(repo, ".jj", "repo")), workspace: realpathSync(repo), commit: parent, what: "true", landing: true });
  });

  test.skipIf(Bun.which("jj") === null)("a new jj workspace has its repository's history", () => {
    const repo = tmp("fleet-gate-jj-");
    sh(repo, ["jj", "git", "init", "--quiet"]);
    const other = join(tmp("fleet-gate-ws-"), "ws");
    sh(repo, ["jj", "workspace", "add", "--quiet", other]);
    expect(gate(["run", "--as", "w1", "--", "true"], more, repo).code).toBe(0);
    expect(gate(["run", "--as", "w1", "--", "true"], more, other).stderr).toContain(", estimate 2.0G from its last run (");
    expect(records()[1]).toMatchObject({ repo: realpathSync(join(repo, ".jj", "repo")), workspace: realpathSync(other) });
  });

  test("a run with no --mem is estimated from its last runs' peak in the same repository; with none, by the default", () => {
    const repo = gitRepo();
    const first = gate(["run", "--as", "w1", "--", "true"], more, repo);
    expect(first.stderr).toMatch(/, estimate [\d.]+G from the default 25% \(no earlier run\) and 8 of the \d+ CPUs of all runs from the default \(no earlier run\); MemoryMax=[\d.]+G \(the budget, 50% of /);
    // A first run is never light: it has no runs to say it is short.
    expect(first.stderr).not.toContain("a light run");
    const [measured] = records();

    const second = gate(["run", "--as", "w1", "--", "true"], more, repo);
    const peak = asNumber(measured?.["peak"]) ?? 0;
    expect(second.stderr).toContain(`, estimate 2.0G from its last run (${sizeText(peak)} peak at ${String(measured?.["at"])}) and `);
    expect(second.stderr).toContain(`; MemoryMax=${sizeText(budgetBytes())} (the budget`);
    // An estimate of 4G at most and each of its last runs 2 minutes at most: a light run.
    expect(second.stderr).toContain("w1 holds the gate, a light run (token");
    expect(records()[1]).toMatchObject({ asked: "last runs", estimate: 2 * 1024 ** 3, cap: budgetBytes() });

    // --mem is the run's own; another command, or the same in another repository, has no earlier run.
    expect(gate(["run", "--as", "w1", "--mem", "3G", "--", "true"], more, repo).stderr).toContain(", estimate 3.0G from --mem and ");
    expect(gate(["run", "--as", "w1", "--", "sh", "-c", "true"], more, repo).stderr).toContain("(no earlier run)");
    expect(gate(["run", "--as", "w1", "--", "true"], more, gitRepo()).stderr).toContain("(no earlier run)");
  });

  // A run's peak past its estimate is not killed: only the ceiling, the whole budget, limits it, and the peak raises
  // the next run's estimate, whatever its end.
  test("a run past its estimate goes on under the ceiling, the same for every run, and its peak, a failure's too, raises the next estimate", () => {
    const repo = gitRepo();
    const hog = ["python3", "-c", "x = bytearray(400 * 1024 * 1024); print('survived'); raise SystemExit(3)"];
    const over = gate(["run", "--as", "w1", "--mem", "64M", "--", ...hog], more, repo);
    expect(over.stdout).toBe("survived\n");
    expect(over.code).toBe(3);
    expect(over.stderr).toContain(`, estimate 64.0M from --mem and `);
    expect(over.stderr).toContain(`; MemoryMax=${sizeText(budgetBytes())} (the budget`);
    const [ran] = records();
    expect(ran).toMatchObject({ estimate: 64 * 1024 ** 2, cap: budgetBytes(), code: 3, killed: 0 });
    const peak = asNumber(ran?.["peak"]) ?? 0;
    expect(peak).toBeGreaterThan(400 * 1024 ** 2);

    const next = gate(["run", "--as", "w1", "--", ...hog], more, repo);
    expect(next.stderr).toContain(`, estimate 2.0G from its last run (${sizeText(peak)} peak at ${String(ran?.["at"])}) and `);
    expect(records()[1]).toMatchObject({ asked: "last runs", estimate: 2 * 1024 ** 3, cap: budgetBytes() });
  });

  test("outside a repository a run keeps neither, and is never capped from an earlier one", () => {
    const dir = tmp("fleet-gate-norepo-");
    expect(gate(["run", "--as", "w1", "--", "true"], more, dir).code).toBe(0);
    expect(gate(["run", "--as", "w1", "--", "true"], more, dir).stderr).toContain("(no earlier run)");
    expect(Object.keys(records()[0] ?? {})).not.toContain("repo");
    expect(Object.keys(records()[0] ?? {})).not.toContain("commit");
  });

  test("lines an older fleet kept, without the new fields, still read", () => {
    const repo = gitRepo();
    mkdirSync(join(home, "gate"), { recursive: true });
    const older = { at: new Date().toISOString(), name: "w", kind: "session", what: "true", asked: "25%", cap: 16 * 1024 ** 3, waited: 30, ran: 5, code: 0, peak: 1024 ** 3, killed: 0 };
    writeFileSync(join(home, "gate", "runs.jsonl"), `${JSON.stringify(older)}\n`);

    // The older line names no repository: it is no run's history.
    expect(gate(["run", "--as", "w1", "--", "true"], more, repo).stderr).toContain("(no earlier run)");
    expect(records().length).toBe(2);
    expect(gate([]).stdout).toMatch(/^last 24 h: 2 runs, wait median 0s, p90 30s, memory peak max 1\.0G$/m);
  });
});

describe.skipIf(!SCOPE)("gate run's asks: the CPUs, light runs, --landing", () => {
  const GB = 1024 ** 3;
  const AT = "2026-10-20T12:00:00.000Z";
  const half = Math.max(2, Math.floor(cpusHere() / 2));
  /** A CPU budget of half the machine's CPUs and 8, on any machine. */
  const cpuEnv = { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPU_BUDGET: String(half + 8) };
  const memEnv = { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_BUDGET: "32G", FLEET_GATE_MEMORY_MAX: "16G", FLEET_GATE_MEMORY_FLOOR: "0" };

  /** A git repository: its directory, and the repository its runs are kept under. */
  interface Repository {
    readonly dir: string;
    readonly id: string;
  }

  function repository(): Repository {
    const dir = tmp("fleet-gate-ask-");
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: dir }).exitCode).toBe(0);

    return { dir, id: realpathSync(join(dir, ".git")) };
  }

  /** Runs kept before the test's, a line each. */
  function kept(...runs: readonly JsonObject[]): void {
    mkdirSync(join(home, "gate"), { recursive: true });
    const line = (more: JsonObject): string => JSON.stringify({ at: AT, name: "w", kind: "session", asked: "25%", cap: 16 * GB, waited: 0, ran: 60, code: 0, peak: GB, killed: 0, ...more });
    writeFileSync(join(home, "gate", "runs.jsonl"), `${runs.map(line).join("\n")}\n`);
  }

  function last(): JsonObject {
    return records().at(-1) ?? {};
  }

  // A fleet's gate is one script that runs the tiers one after another: one gate run, one scope, one cap.
  test("a landing gate that is a script of tiers is admitted once, estimated from that script's runs in any session's scratchpad", () => {
    const repo = repository();

    const pad = (session: string): string => {
      const dir = join(tmp("fleet-gate-pad-"), session, "scratchpad");

      mkdirSync(dir, { recursive: true });

      return dir;
    };

    const before = join(pad("21adec87-2e88-42c8-b0b5-5f8352b34ddd"), "gate-grafo.sh");
    const now = join(pad("9f1c0d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f"), "gate-grafo.sh");
    const seen = join(home, "seen.json");
    writeFileSync(now, ["#!/usr/bin/env bash", "echo '=== tier check'; true; c=$?", `cp ${holdFile()} ${seen}`, "echo '=== tier test'; sh -c true; t=$?",
      "echo '=== tier browser'; true; b=$?", `[ "$c$t$b" = "000" ]`, ""].join("\n"));
    kept({ repo: repo.id, what: `bash ${before}`, landing: true, peak: 6.8 * GB });

    const done = gate(["run", "--as", "w1", "--landing", "--", "bash", now], memEnv, repo.dir);
    expect(done.code).toBe(0);
    expect(done.stdout).toBe("=== tier check\n=== tier test\n=== tier browser\n");
    expect(done.stderr).toContain(`, estimate ${sizeText(memEstimate(6.8 * GB))} from its last run (6.8G peak at ${AT})`);

    // While its tiers ran, the gate held one hold, this run's: no tier asked the gate again.
    const during = asObject(JSON.parse(readFileSync(seen, "utf8"))) ?? {};
    const held = (asArray(during["holds"]) ?? [during]).map((hold) => asObject(hold) ?? {});
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ landing: true, cap: memEstimate(6.8 * GB) });
    expect(records()).toHaveLength(2);
    expect(last()).toMatchObject({ what: `bash ${now}`, landing: true, code: 0 });
  });

  test("--cpus past the CPU budget of all runs together is refused, exit 2, a landing gate's too: --landing has no room of its own", () => {
    const over = gate(["run", "--as", "w1", "--cpus", String(half + 9), "--", "true"], cpuEnv);
    expect(over.code).toBe(2);
    expect(over.stderr).toBe(`gate run: --cpus ${String(half + 9)} is more than the CPU budget of all runs together (${String(half + 8)}): ask for at most that\n`);
    expect(gate(["run", "--as", "w1", "--landing", "--cpus", String(half + 9), "--", "true"], cpuEnv).code).toBe(2);
    expect(gate(["run", "--as", "w1", "--cpus", String(half + 8), "--", "true"], cpuEnv).code).toBe(0);
    expect(last()).toMatchObject({ cpus: half + 8 });
  });

  test("--landing is recorded, and changes nothing else: the same estimate as the run unmarked", () => {
    const repo = repository();
    kept({ repo: repo.id, what: "true", ran: 100, cpu_s: 400, peak: 6 * GB });
    const marked = gate(["run", "--as", "w1", "--landing", "--", "true"], cpuEnv, repo.dir);
    expect(marked.code).toBe(0);
    expect(marked.stderr).toContain("w1 holds the gate as a landing gate (token");
    expect(last()).toMatchObject({ landing: true, estimate: memEstimate(6 * GB), cpus: 5 });
    const plain = gate(["run", "--as", "w1", "--", "true"], cpuEnv, repo.dir);
    expect(plain.code).toBe(0);
    expect(last()).toMatchObject({ estimate: memEstimate(6 * GB), cpus: 5 });
    expect(last()["landing"]).toBeUndefined();
  });

  test("a run estimates the CPUs its last runs used on average times 1.25, 2 at least; 8 with none", () => {
    const repo = repository();
    kept({ repo: repo.id, what: "true", ran: 100, cpu_s: 400 }, { repo: repo.id, what: "sh -c true", ran: 100, cpu_s: 10 });
    const sized = gate(["run", "--as", "w1", "--", "true"], cpuEnv, repo.dir);
    expect(sized.stderr).toContain(` and 5 of the ${String(half + 8)} CPUs of all runs from its last run (4.0 used on average)`);
    expect(last()["cpus"]).toBe(5);
    gate(["run", "--as", "w1", "--", "sh", "-c", "true"], cpuEnv, repo.dir);
    expect(last()["cpus"]).toBe(2);
    gate(["run", "--as", "w1", "--", "sh", "-c", ":"], cpuEnv, repo.dir);
    expect(last()["cpus"]).toBe(8);
  });

  // A 16-CPU machine's budget is 8: a suite that used 12 on a larger one would ask 15 and never fit.
  test("a run whose last runs give more CPUs than the CPU budget asks the budget, and is admitted", () => {
    const repo = repository();
    kept({ repo: repo.id, what: "true", ran: 100, cpu_s: 1200 });
    const small = { ...memEnv, FLEET_GATE_CPU_BUDGET: "8" };
    const done = gate(["run", "--as", "w1", "--wait", "0", "--", "true"], small, repo.dir);
    expect(done.code).toBe(0);
    expect(done.stderr).toContain(" and 8 of the 8 CPUs of all runs from its last run (12.0 used on average)");
    expect(last()).toMatchObject({ code: 0, cpus: 8 });
  });

  test("a light run: an estimate of 4G at most and each of its last 3 runs 2 minutes at most, each at its bound", () => {
    const repo = repository();
    kept(
      { repo: repo.id, what: "true", ran: 120, peak: 3.2 * GB },
      { repo: repo.id, what: "sh -c true", ran: 121, peak: GB },
      { repo: repo.id, what: "sh -c :", ran: 60, peak: 3.3 * GB },
      { repo: repo.id, what: "echo", ran: 121, peak: GB },
      { repo: repo.id, what: "echo", ran: 30, peak: GB },
      { repo: repo.id, what: "echo", ran: 30, peak: GB },
    );
    const light = gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1" }, repo.dir);
    expect(light.stderr).toContain(", estimate 4.0G from its last run");
    expect(light.stderr).toContain("w1 holds the gate, a light run (token");
    expect(gate(["run", "--as", "w1", "--", "sh", "-c", "true"], { FLEET_GATE_SCOPE: "1" }, repo.dir).stderr).not.toContain("a light run");
    const big = gate(["run", "--as", "w1", "--", "sh", "-c", ":"], { FLEET_GATE_SCOPE: "1" }, repo.dir);
    expect(big.stderr).toContain(", estimate 4.1G from its last run");
    expect(big.stderr).not.toContain("a light run");
    // A first run is never light, however small its estimate: it has no runs to say it is short.
    expect(gate(["run", "--as", "w1", "--mem", "2G", "--", "sh", "-c", "exit 0"], { FLEET_GATE_SCOPE: "1" }, repo.dir).stderr).not.toContain("a light run");
    // Two short runs and one of 121s before them: not light.
    const third = gate(["run", "--as", "w1", "--", "echo"], { FLEET_GATE_SCOPE: "1" }, repo.dir);
    expect(third.stderr).toContain("from its last 3 runs");
    expect(third.stderr).not.toContain("a light run");
  });

  // 2026-10-20 13:37: load 66.8 on 32 cores with 25G available; a gate timed out with no failed assertion.
  test("a run whose memory fits waits while the holds' CPUs fill the CPU budget, and its line says it waits for CPU", async () => {
    const both = { ...memEnv, ...cpuEnv };
    const runs = [running(["--as", "gate", "--landing", "--cpus", String(half), "--", "sleep", "30"], both), running(["--as", "bench", "--mem", "2G", "--cpus", "8", "--", "sleep", "30"], both)];

    try {
      expect(await until(() => standing().holders.length === 2, 10000)).toBe(true);
      expect(standing().holders.reduce((sum, h) => sum + (asNumber(h["cpus"]) ?? 0), 0)).toBe(half + 8);

      const late = gate(["run", "--as", "late", "--mem", "2G", "--cpus", "2", "--wait", "1", "--", "sh", "-c", "echo ran"], both);
      expect(late.code).toBe(75);
      expect(late.stdout).toBe("");
      expect(late.stderr).toContain("gate run: waiting for CPU: the gate is held by ");
      expect(late.stderr).not.toContain("waiting for memory");
    } finally {
      await stopAll(runs);
    }
  });

  test("a tier and a light run, each at the CPUs its last runs give, run at once", async () => {
    const repo = repository();
    kept({ repo: repo.id, what: "sleep 30", ran: 300, cpu_s: 1200, peak: 3 * GB }, { repo: repo.id, what: "true", ran: 10, cpu_s: 1, peak: 0.1 * GB });
    const tier = running(["--as", "tier", "--", "sleep", "30"], cpuEnv, repo.dir);

    try {
      expect(await until(() => standing().holders.length === 1, 10000)).toBe(true);
      expect(standing().holders[0]?.["cpus"]).toBe(5);
      const light = gate(["run", "--as", "light", "--wait", "0", "--", "true"], cpuEnv, repo.dir);
      expect(light.stderr).toContain("light holds the gate, a light run (token");
      expect(light.code).toBe(0);
      expect(last()).toMatchObject({ name: "light", cpus: 2 });
    } finally {
      await stopAll([tier]);
    }
  });
});
