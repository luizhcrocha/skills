/**
 * `fleet fleets gate run`: a suite through the gate, as one process tree that dies whole, within the memory budget
 * all runs share and in the queue's order. Each test runs the CLI as its own process (signals are part of the
 * surface), with its own registry; the scope tests need a systemd user manager and are skipped where there is
 * none (the Mac). gate.test.ts has the admission rules themselves.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { capBytes } from "../src/gate.ts";
import { asArray, asNumber, asObject, type JsonObject } from "../src/json.ts";
import { runArgs, scopeAvailable } from "../src/gate-run.ts";
import { baseEnv, FLEET, tmp, type Environment } from "./support.ts";

let home: string;

let env: Environment;

const SCOPE = scopeAvailable((name) => process.env[name]);

// Each run is a fleet process or two, and a stopped tree has seconds of grace.
setDefaultTimeout(30_000);

beforeEach(() => {
  home = tmp("fleet-gate-run-");
  // This checkout's fleet, whatever newer one the machine has, and no cap, budget or weight from the session's own environment.
  env = baseEnv(home, { FLEET_NO_FORWARD: "1" });

  for (const key of ["FLEET_GATE_MEMORY_MAX", "FLEET_GATE_MEMORY_BUDGET", "FLEET_GATE_CPU_WEIGHT", "FLEET_GATE_SCOPE"]) delete env[key];
});

interface Done {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function gate(args: readonly string[], more: Readonly<Environment> = {}): Done {
  const done = Bun.spawnSync([FLEET, "fleets", "gate", ...args], { env: { ...env, ...more }, stdout: "pipe", stderr: "pipe" });

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
function running(args: readonly string[], more: Readonly<Environment> = {}): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([FLEET, "fleets", "gate", "run", ...args], { env: { ...env, ...more }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
      name: "ui", command: ["pnpm", "test"], waitS: 1800, minutes: 60, mem: undefined, timeoutS: 3600,
    });
    expect(runArgs(["infra", "--for", "5", "--timeout", "30", "--mem", "8G", "--", "just", "test"])?.timeoutS).toBe(30);
    expect(runArgs(["infra", "--for", "1", "--timeout", "300", "--", "x"])?.timeoutS).toBe(60);
    expect(runArgs(["--as", "ui", "pnpm", "test"])).toBeUndefined();
    expect(runArgs(["--as", "ui", "--"])).toBeUndefined();
    expect(runArgs(["--as", "ui", "extra", "--", "x"])).toBeUndefined();
    expect(runArgs(["--wait", "soon", "ui", "--", "x"])).toBeUndefined();
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
    const one = running(["--as", "w1", "--mem", "50%", "--", "sleep", "5"]);

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

  test("two default runs at once; a third waits and, out of time, names the holders and its place", async () => {
    const runs = [running(["--as", "w1", "--", "sleep", "30"], more), running(["--as", "w2", "--", "sleep", "30"], more)];

    try {
      expect(await until(() => standing().holders.length === 2, 10000)).toBe(true);
      const third = gate(["run", "--as", "w3", "--wait", "1", "--", "sh", "-c", "echo ran"], more);
      expect(third.code).toBe(75);
      expect(third.stdout).toBe("");
      expect(third.stderr).toMatch(/the gate is held by w[12] \(no fleet\) since \S+, until \S+, cap [\d.]+G: gate run: sleep 30; and held by w[12] \(no fleet\)/);
      expect(third.stderr).toContain("place 1 in the queue; gave up after 1s without running the command (exit 75)");
      expect(standing().queue).toEqual([]);
    } finally {
      await stopAll(runs);
    }

    expect(first()).toBe("free");
  });

  test("a run of the whole budget waits for a default run, and a default run that comes after does not pass it", async () => {
    const dir = tmp("fleet-gate-order-");
    const small = running(["--as", "small", "--", "sh", "-c", `echo small >> ${dir}/order; sleep 4`], more);
    expect(await until(() => standing().holders.length === 1, 10000)).toBe(true);
    const big = running(["--as", "big", "--mem", "50%", "--wait", "60", "--", "sh", "-c", `echo big >> ${dir}/order`], more);
    const runs = [small, big];

    try {
      expect(await until(() => standing().queue.length === 1, 10000)).toBe(true);
      // It would fit beside `small`, and is refused: `big` is before it.
      const passing = gate(["run", "--as", "late", "--wait", "0", "--", "sh", "-c", `echo late >> ${dir}/order`], more);
      expect(passing.code).toBe(75);
      expect(passing.stderr).toContain("place 2 in the queue, behind big");

      const late = running(["--as", "late", "--wait", "60", "--", "sh", "-c", `echo late >> ${dir}/order`], more);
      runs.push(late);
      expect(await until(() => standing().queue.length === 2, 10000)).toBe(true);
      const lines = gate([]).stdout.split("\n");
      expect(lines[0]).toMatch(/^held by small \(no fleet\) since \S+, until \S+, cap [\d.]+G: gate run: sh -c /);
      expect(lines[1]).toMatch(/^budget [\d.]+G \(50%\): [\d.]+G held, [\d.]+G free$/);
      expect(lines[2]).toMatch(/^queue 1: big \(no fleet\), [\d.]+G, waiting \d+s: gate run: sh -c /);
      expect(lines[3]).toMatch(/^queue 2: late \(no fleet\), [\d.]+G, waiting \d+s: gate run: sh -c /);
      expect(standing().queue.map((w) => [w["place"], w["name"]])).toEqual([[1, "big"], [2, "late"]]);

      expect(await small.exited).toBe(0);
      expect(await big.exited).toBe(0);
      expect(await late.exited).toBe(0);
      expect(readFileSync(join(dir, "order"), "utf8")).toBe("small\nbig\nlate\n");
      expect(await new Response(big.stderr).text()).toMatch(/big holds the gate \(token [0-9a-f]{8}, until \S+\), after \d+s of waiting/);
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
    expect(over.stderr).toMatch(/the memory cap '60%' \([\d.]+G\) is more than the budget of all runs together, 50% \([\d.]+G\)/);
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
    expect(gaveUp).toMatchObject({ name: "w2", what: "just test-changed a b c d", asked: "8G", cap: 8 * 1024 ** 3, ran: null, code: 75, peak: null });
    expect(asNumber(gaveUp?.["waited"])).toBeGreaterThanOrEqual(1);

    const lines = gate([]).stdout.trim().split("\n");
    expect(lines[0]).toContain("held by other (no fleet)");
    expect(lines.at(-1)).toMatch(/^last 24 h: 1 runs, wait median 0s, p90 \d+s, memory peak max [\d.]+[KMG], 1 gave up waiting$/);
    expect(standing().day).toMatchObject({ runs: 1, gave_up: 1, median_wait: 0, capped: 0 });
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
      const beside = gate(["run", "--as", "y", "--mem", "50%", "--wait", "0", "--", "sh", "-c", "echo ran"], scope);
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
      expect(gate(["run", "--as", "c", "--mem", "50%", "--wait", "0", "--", "sh", "-c", "echo ran"], scope).code).toBe(75);
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
      expect(gate(["run", "--as", "big", "--mem", "50%", "--wait", "0", "--", "sh", "-c", "echo ran"], scope).code).toBe(75);
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
    expect(gate(["run", "--as", "big", "--mem", "50%", "--wait", "0", "--", "sh", "-c", "echo ran"], scope).code).toBe(75);
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
  test("a child over the cap is killed by the kernel inside the scope, and the run says so", () => {
    const hog = ["python3", "-c", "x = bytearray(400 * 1024 * 1024); print('survived')"];
    const done = gate(["run", "--as", "w1", "--mem", "64M", "--", ...hog], { FLEET_GATE_SCOPE: "1" });
    expect(done.stdout).not.toContain("survived");
    expect(done.code).toBe(137);
    expect(done.stderr).toContain("MemoryMax=64.0M");
    expect(done.stderr).toMatch(/the memory cap \(MemoryMax=64\.0M\) killed \d+ process\(es\)\. /);
    expect(done.stderr).toContain(
      "Run it again with the whole budget: `fleet fleets gate run --as w1 --mem 50% -- python3 -c 'x = bytearray(400 * 1024 * 1024); print('\\''survived'\\'')'`",
    );
    expect(first()).toBe("free");
    expect(records()[0]).toMatchObject({ name: "w1", asked: "64M", cap: 64 * 1024 ** 2, code: 137 });
    expect(asNumber(records()[0]?.["killed"])).toBeGreaterThan(0);
    expect(gate([]).stdout).toMatch(/\nlast 24 h: 1 runs, .*, 1 hit the cap\n$/);
  });

  test("a run that had the whole budget is told so, with the flags it was given kept for the other", () => {
    const hog = ["python3", "-c", "x = bytearray(400 * 1024 * 1024)"];
    const whole = gate(["run", "--as", "w1", "--", ...hog], { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_BUDGET: "64M" });
    expect(whole.code).toBe(137);
    expect(whole.stderr).toContain("It had the whole budget (64M, 64.0M): the command needs fewer processes at once");
    expect(whole.stderr).not.toContain("Run it again");
    // The way out of a cap is fewer processes, never a wider budget: the line names no variable to set.
    expect(whole.stderr.split("\n").find((line) => line.includes("the memory cap"))).not.toContain("FLEET_GATE");

    const part = gate(["run", "--as", "w 1;x", "--wait", "5", "--for", "9", "--timeout", "60", "--mem", "64M", "--", ...hog], { FLEET_GATE_SCOPE: "1" });
    expect(part.stderr).toContain("`fleet fleets gate run --as 'w 1;x' --wait 5 --for 9 --timeout 60 --mem 50% -- python3 -c ");
  });

  test("the default cap is a quarter of the RAM, $FLEET_GATE_MEMORY_MAX sets another, and a smaller budget lowers the default", () => {
    expect(gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1" }).stderr).toContain("(25% of ");
    expect(gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_MAX: "50%" }).stderr).toContain("(50% of ");
    const lowered = gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_BUDGET: "256M" });
    expect(lowered.code).toBe(0);
    expect(lowered.stderr).toContain("MemoryMax=256.0M, no swap");
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
});
