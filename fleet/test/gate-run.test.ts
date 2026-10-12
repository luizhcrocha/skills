/**
 * `fleet fleets gate run`: a full suite through the gate slot, as one process tree that dies whole. Each test
 * runs the CLI as its own process (signals are part of the surface), with its own registry; the scope tests
 * need a systemd user manager and are skipped where there is none (the Mac).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { capBytes, runArgs, scopeAvailable } from "../src/gate-run.ts";
import { baseEnv, FLEET, tmp, type Environment } from "./support.ts";

let home: string;

let env: Environment;

const SCOPE = scopeAvailable((name) => process.env[name]);

// Each run is a fleet process or two, and a stopped tree has seconds of grace.
setDefaultTimeout(30_000);

beforeEach(() => {
  home = tmp("fleet-gate-run-");
  env = baseEnv(home);
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
    expect(gate([]).stdout).toBe("free\n");
  });

  test("a command past its --timeout is stopped, its whole tree with it, exit 124, and the slot freed", async () => {
    const dir = tmp("fleet-gate-tree-");
    const done = gate(["run", "--as", "w1", "--timeout", "2", "--", ...tree(dir)], more);
    expect(done.code).toBe(124);
    expect(done.stderr).toContain("still running after 2s");
    expect(gate([]).stdout).toBe("free\n");
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
    expect(gate([]).stdout).toBe("free\n");
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
    expect(gate([]).stdout).toBe("free\n");
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

  test("a hold its own name took by hand covers the run, and stays its taker's", () => {
    expect(gate(["take", "--as", "w1", "just test"]).code).toBe(0);
    const done = gate(["run", "--as", "w1", "--wait", "0", "--", "sh", "-c", "echo ran"]);
    expect(done.code).toBe(0);
    expect(done.stdout).toBe("ran\n");
    expect(done.stderr).toContain("running under that hold");
    expect(gate([]).stdout).toContain("held by w1");
  });

  test("one run per hold: a second run under the same hand-taken hold waits, then runs once the first is done", async () => {
    expect(gate(["take", "--as", "w1", "just test"]).code).toBe(0);
    const dir = tmp("fleet-gate-join-");
    const first = Bun.spawn([FLEET, "fleets", "gate", "run", "--as", "w1", "--", "sh", "-c", `touch ${dir}/first; sleep 3; touch ${dir}/first-done`], { env, stdout: "pipe", stderr: "pipe" });

    try {
      expect(await until(() => existsSync(join(dir, "first")), 10000)).toBe(true);
      const refused = gate(["run", "--as", "w1", "--wait", "0", "--", "sh", "-c", "echo ran"]);
      expect(refused.code).toBe(75);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("w1's hold already has a gate run");
      expect(refused.stderr).toContain("without running the command (exit 75)");

      const second = Bun.spawn([FLEET, "fleets", "gate", "run", "--as", "w1", "--wait", "30", "--", "sh", "-c", `test -e ${dir}/first-done && echo ran`], { env, stdout: "pipe", stderr: "pipe" });
      expect(await first.exited).toBe(0);
      expect(await second.exited).toBe(0);
      expect(await new Response(second.stdout).text()).toBe("ran\n");
      expect(gate([]).stdout).toContain("held by w1");
      expect(JSON.parse(readFileSync(holdFile(), "utf8"))).not.toHaveProperty("runner");
    } finally {
      first.kill("SIGTERM");
      await first.exited;
    }
  });

  test("a dead runner's mark on a hand-taken hold does not block the next run", () => {
    expect(gate(["take", "--as", "w1", "just test"]).code).toBe(0);
    const held = readFileSync(holdFile(), "utf8").trim();
    writeFileSync(holdFile(), `${held.slice(0, -1)}, "runner": ${String(2 ** 22 + 7)}}`);
    const done = gate(["run", "--as", "w1", "--wait", "0", "--", "sh", "-c", "echo ran"]);
    expect(done.code).toBe(0);
    expect(done.stdout).toBe("ran\n");
  });

  test("a run past its time says so with its exit code", () => {
    const done = gate(["run", "--as", "w1", "--timeout", "1", "--", "sleep", "30"], { FLEET_GATE_SCOPE: "0" });
    expect(done.code).toBe(124);
    expect(done.stderr).toMatch(/stopped at its 1s limit after [\d.]+s \(exit 124\); freed the gate/);
  });

  test("another run's hold by the same name is not shared: a second suite waits", async () => {
    const first = Bun.spawn([FLEET, "fleets", "gate", "run", "--as", "w1", "--", "sleep", "5"], { env, stdout: "pipe", stderr: "pipe" });

    try {
      const deadline = Date.now() + 10000;

      while (!existsSync(holdFile()) && Date.now() < deadline) Bun.sleepSync(50);
      const second = gate(["run", "--as", "w1", "--wait", "0", "--", "sh", "-c", "echo ran"]);
      expect(second.code).toBe(75);
      expect(second.stdout).toBe("");
    } finally {
      first.kill("SIGTERM");
      await first.exited;
    }
  });
});

describe.skipIf(!SCOPE)("gate run's memory cap", () => {
  test("a child over the cap is killed by the kernel inside the scope, and the run says so", () => {
    const hog = ["python3", "-c", "x = bytearray(400 * 1024 * 1024); print('survived')"];
    const done = gate(["run", "--as", "w1", "--mem", "64M", "--", ...hog], { FLEET_GATE_SCOPE: "1" });
    expect(done.stdout).not.toContain("survived");
    expect(done.code).toBe(137);
    expect(done.stderr).toContain("MemoryMax=64.0M");
    expect(done.stderr).toMatch(/the memory cap \(MemoryMax=64\.0M\) killed \d+ process\(es\)/);
    expect(gate([]).stdout).toBe("free\n");
  });

  test("the default cap is half the RAM, and $FLEET_GATE_MEMORY_MAX sets another", () => {
    expect(gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1" }).stderr).toContain("(50% of ");
    expect(gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_MAX: "25%" }).stderr).toContain("(25% of ");
  });
});
