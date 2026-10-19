/**
 * The gate (gate.ts) through its interface: admission by the memory budget, the queue's order, holds and waiters
 * whose process is gone, the files an older fleet reads and wrote, and the runs' records. Each asker is a real
 * process (a `sleep`), since a hold and a place in the queue live as long as the process that asked.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { asArray, asObject, asString, type JsonObject } from "../src/json.ts";
import { capBytes, endOf, floorOf, Gate, holdText, memAvailable, type Hold, type RunRecord, type Waiting } from "../src/gate.ts";
import { readJson, tmp } from "./support.ts";

const GB = 1024 ** 3;

/** The budget of these tests: two runs of a quarter of a 64 GB machine fit it. */
const BUDGET = 32 * GB;

const QUARTER = 16 * GB;

let dir: string;

let gate: Gate;

let served: string[];

let procs: Bun.Subprocess[];

beforeEach(() => {
  dir = join(tmp("fleet-gate-"), "gate");
  served = [];
  gate = new Gate(dir, () => served);
  procs = [];
});

afterEach(async () => {
  for (const p of procs) p.kill("SIGKILL");
  await Promise.all(procs.map(async (p) => p.exited));
});

/** A process to ask as: its pid. */
function asker(): number {
  const p = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });

  procs.push(p);

  return p.pid;
}

async function die(pid: number): Promise<void> {
  const p = procs.find((x) => x.pid === pid);

  p?.kill("SIGKILL");
  await p?.exited;
}

/** The instant `seconds` after noon. */
function at(seconds: number): Date {
  return new Date(Date.parse("2026-10-05T12:00:00Z") + seconds * 1000);
}

interface Asked {
  readonly took?: Hold;
  readonly waiting?: Waiting;
}

/** `name` asks for `cap` bytes (undefined: the whole budget) as the process `pid`, ready to wait. */
function ask(name: string, pid: number, cap: number | undefined, seconds = 0, waitS = 600): Asked {
  return gate.ask({ holder: { name, kind: "session" }, what: `suite ${name}`, seconds: 3600, cap, budget: BUDGET, pid, runs: true, waitS }, at(seconds));
}

/** The runner of `hold` frees it, as a run does at its end. */
function end(hold: Hold | undefined, seconds: number): ReturnType<Gate["free"]> {
  return gate.free(hold?.token ?? "", at(seconds), hold?.pid);
}

/** `name` takes by hand, as `gate take` does: `cap` bytes, or the whole budget. */
function take(name: string, cap: number | undefined, seconds = 0, kind: "fleet" | "session" = "session"): Asked {
  return gate.ask({ holder: { name, kind }, what: `build ${name}`, seconds: 3600, cap, budget: BUDGET, pid: asker(), runs: false, waitS: 0 }, at(seconds));
}

function names(of: readonly { readonly name: string }[] | undefined): string[] {
  return (of ?? []).map((x) => x.name);
}

function file(): JsonObject {
  return readJson(join(dir, "gate.json"));
}

/** Add `more` to the first hold the gate keeps (with a cap, gate.json carries it in `holds`), as an older fleet's run wrote its mark. */
function mark(more: JsonObject): void {
  const kept = file();
  const [first, ...rest] = asArray(kept["holds"]) ?? [];

  writeFileSync(join(dir, "gate.json"), JSON.stringify({ ...kept, holds: [{ ...asObject(first), ...more }, ...rest] }));
}

/** Whether a fleet from before the budget (1.9.44) reads `held` as a live hold at `now`: its whole test. */
function olderFleetReadsHeld(held: JsonObject, now: Date): boolean {
  const until = Date.parse(asString(held["until"]) ?? "");

  if (!Number.isNaN(until) && now.getTime() >= until) return false;

  if (held["kind"] !== "session") return false; // no fleet is served in these tests

  return held["pid"] === undefined;
}

describe("admission by the budget", () => {
  test("two default runs hold at once, and a third waits", () => {
    expect(ask("a", asker(), QUARTER).took?.cap).toBe(QUARTER);
    expect(ask("b", asker(), QUARTER).took?.name).toBe("b");
    const third = ask("c", asker(), QUARTER);
    expect(third.took).toBeUndefined();
    expect(names(third.waiting?.holders)).toEqual(["a", "b"]);
    expect(names(gate.standing(at(1)).holders)).toEqual(["a", "b"]);
    expect(names(gate.standing(at(1)).queue)).toEqual(["c"]);
  });

  test("a run of the whole budget waits for both default runs to end", () => {
    const a = ask("a", asker(), QUARTER).took;
    const b = ask("b", asker(), QUARTER).took;
    const big = asker();
    expect(ask("big", big, BUDGET).waiting?.holders.length).toBe(2);
    expect(end(a, 1)).toEqual({ freed: true });
    expect(names(ask("big", big, BUDGET, 2).waiting?.holders)).toEqual(["b"]);
    expect(end(b, 3)).toEqual({ freed: true });
    expect(ask("big", big, BUDGET, 4).took?.cap).toBe(BUDGET);
  });

  test("a default run behind a waiting whole-budget run does not pass it, though it would fit", () => {
    const a = ask("a", asker(), QUARTER).took;
    const big = asker();
    const small = asker();
    expect(ask("big", big, BUDGET).took).toBeUndefined();
    const behind = ask("small", small, QUARTER, 1);
    expect(behind.took).toBeUndefined();
    expect(names(behind.waiting?.ahead)).toEqual(["big"]);
    expect(names(gate.standing(at(1)).holders)).toEqual(["a"]);

    end(a, 2);
    expect(ask("small", small, QUARTER, 3).took).toBeUndefined();
    const took = ask("big", big, BUDGET, 3).took;
    expect(took?.name).toBe("big");
    expect(names(ask("small", small, QUARTER, 4).waiting?.holders)).toEqual(["big"]);
    end(took, 5);
    expect(ask("small", small, QUARTER, 6).took?.name).toBe("small");
  });

  test("a hold taken by hand is the whole budget, and one with a cap leaves the rest", () => {
    const hand = gate.ask({ holder: { name: "builder", kind: "session" }, what: "a build", seconds: 3600, cap: undefined, budget: BUDGET, pid: asker(), runs: false, waitS: 0 }, at(0));
    expect("took" in hand && hand.took.cap).toBeUndefined();
    expect(ask("a", asker(), QUARTER, 1, 0).took).toBeUndefined();
    expect(gate.free("builder", at(2))).toEqual({ freed: true });

    const part = gate.ask({ holder: { name: "builder", kind: "session" }, what: "a build", seconds: 3600, cap: QUARTER, budget: BUDGET, pid: asker(), runs: false, waitS: 0 }, at(3));
    expect("took" in part).toBe(true);
    expect(ask("a", asker(), QUARTER, 4, 0).took?.name).toBe("a");
    expect(ask("b", asker(), QUARTER, 5, 0).took).toBeUndefined();
  });

  test("an ask that does not wait never joins the queue", () => {
    ask("a", asker(), BUDGET);
    expect(ask("b", asker(), QUARTER, 1, 0).took).toBeUndefined();
    expect(gate.standing(at(2)).queue).toEqual([]);
    expect(existsSync(join(dir, "queue.json"))).toBe(false);
  });

  test("two holds of one name, taken in the same second for the same thing, have tokens of their own", () => {
    const one = ask("a", asker(), QUARTER).took;
    const two = ask("a", asker(), QUARTER).took;
    expect(one?.token).toMatch(/^[0-9a-f]{8}$/);
    expect(two?.token).toMatch(/^[0-9a-f]{8}$/);
    expect(two?.token).not.toBe(one?.token);
    expect(end(one, 1)).toEqual({ freed: true });
    expect(names(gate.standing(at(1)).holders)).toEqual(["a"]);
    expect(end(two, 2)).toEqual({ freed: true });
    expect(gate.standing(at(2)).holders).toEqual([]);
  });

  test("a release names a hold of the gate, or is refused with the holders", () => {
    take("a", QUARTER);
    take("b", QUARTER);
    const refused = gate.free("nobody", at(1));
    expect("held" in refused && names(refused.held)).toEqual(["a", "b"]);
    expect(gate.free("a", at(1))).toEqual({ freed: true });
    expect(names(gate.standing(at(1)).holders)).toEqual(["b"]);
  });

  test("a caller that reads a larger budget is admitted against the smallest one", () => {
    const wide = (name: string, cap: number, waitS = 0): Asked =>
      gate.ask({ holder: { name, kind: "session" }, what: `suite ${name}`, seconds: 3600, cap, budget: 2 * BUDGET, pid: asker(), runs: true, waitS }, at(1));

    const a = ask("a", asker(), QUARTER).took;
    // Three quarters beside a quarter fit the budget this caller reads, twice the holder's: not the holder's.
    expect(wide("b", 3 * QUARTER).took).toBeUndefined();
    expect(wide("b", QUARTER).took?.budget).toBe(2 * BUDGET);
    expect(wide("c", QUARTER).took).toBeUndefined();

    // Alone, it has the budget it reads; whoever comes after is held to the smaller one it reads itself.
    for (const hold of gate.standing(at(2)).holders) end(hold, 2);
    expect(a?.budget).toBe(BUDGET);
    expect(wide("b", 3 * QUARTER).took?.cap).toBe(3 * QUARTER);
    expect(ask("d", asker(), QUARTER, 3, 0).took).toBeUndefined();
  });

  test("only its runner frees a run's hold: by its name or its token anyone else is refused, and the run stays counted", () => {
    const pid = asker();
    const a = ask("a", pid, QUARTER).took;
    const byName = gate.free("a", at(1));
    expect("running" in byName && byName.running.map((h) => h.pid)).toEqual([pid]);
    const byToken = gate.free(a?.token ?? "", at(1));
    expect("running" in byToken && names(byToken.running)).toEqual(["a"]);
    expect(names(gate.standing(at(1)).holders)).toEqual(["a"]);
    expect(ask("big", asker(), BUDGET, 2, 0).took).toBeUndefined();

    // A hold `a` took by hand goes by its name; the run's stays.
    take("a", QUARTER, 3);
    expect(gate.free("a", at(4))).toEqual({ freed: true });
    expect(gate.standing(at(4)).holders.map((h) => h.pid)).toEqual([pid]);
    expect(gate.free(a?.token ?? "", at(5), pid)).toEqual({ freed: true });
    expect(gate.standing(at(5)).holders).toEqual([]);
  });
});

describe("admission by the memory available", () => {
  const FLOOR = 8 * GB;

  /** What a scope's cgroup says it uses: memory.current, and the file cache memory.stat counts in it. */
  interface Use {
    readonly current: number;
    readonly file: number;
  }

  /** The machine as a test sets it: a meminfo of 64 GB with `available` bytes of MemAvailable, and a cgroup root
   * whose scopes `scopes` names use what they say. */
  function machine(available: number, scopes: Readonly<Record<string, Use>> = {}): (name: string) => string | undefined {
    const info = join(dir, "..", "meminfo");
    const root = join(dir, "..", "cgroup");
    writeFileSync(info, `MemTotal:       67108864 kB\nMemAvailable:   ${String(available / 1024)} kB\n`);

    for (const [unit, use] of Object.entries(scopes)) {
      mkdirSync(join(root, `${unit}.scope`), { recursive: true });
      writeFileSync(join(root, `${unit}.scope`, "memory.current"), `${String(use.current)}\n`);
      writeFileSync(join(root, `${unit}.scope`, "memory.stat"), `anon ${String(use.current - use.file)}\nfile ${String(use.file)}\nkernel 0\n`);
    }

    return (name) => (name === "FLEET_MEMINFO" ? info : name === "FLEET_CGROUP_ROOT" ? root : undefined);
  }

  /** `name` asks for `cap` bytes on the machine `env`, keeping {@link FLOOR} free; an ask of the whole budget counts a
   * quarter of the RAM. */
  function askOn(env: (name: string) => string | undefined, name: string, pid: number, cap: number | undefined, seconds = 0, waitS = 600): Asked {
    return gate.ask({ holder: { name, kind: "session" }, what: `suite ${name}`, seconds: 3600, cap, budget: BUDGET, pid, runs: true, waitS, memory: { floor: FLOOR, whole: QUARTER, env } }, at(seconds));
  }

  function askWith(available: number, name: string, pid: number, cap: number | undefined, seconds = 0, waitS = 600): Asked {
    return askOn(machine(available), name, pid, cap, seconds, waitS);
  }

  test("a run goes ahead while MemAvailable less its cap keeps the floor free", () => {
    const took = askWith(24 * GB, "a", asker(), QUARTER);
    expect(took.took?.cap).toBe(QUARTER);
    expect(took.waiting).toBeUndefined();
  });

  test("below the floor a run waits in the queue, and goes once memory frees", () => {
    const pid = asker();
    const short = askWith(20 * GB, "a", pid, QUARTER);
    expect(short.took).toBeUndefined();
    expect(short.waiting?.holders).toEqual([]);
    expect(short.waiting?.short).toEqual({ available: 20 * GB, unused: 0, part: QUARTER, whole: false, floor: FLOOR });
    expect(names(gate.standing(at(1)).queue)).toEqual(["a"]);
    expect(gate.standing(at(1)).holders).toEqual([]);

    expect(askWith(23 * GB, "a", pid, QUARTER, 5).took).toBeUndefined();
    expect(askWith(24 * GB, "a", pid, QUARTER, 10).took?.name).toBe("a");
    expect(gate.standing(at(11)).queue).toEqual([]);
  });

  test("an ask that does not wait is refused below the floor, and keeps no place", () => {
    const refused = askWith(20 * GB, "a", asker(), QUARTER, 0, 0);
    expect(refused.took).toBeUndefined();
    expect(refused.waiting?.short).toEqual({ available: 20 * GB, unused: 0, part: QUARTER, whole: false, floor: FLOOR });
    expect(gate.standing(at(1)).queue).toEqual([]);
  });

  test("the floor is one more condition: with memory to spare, the budget still admits two default runs", () => {
    expect(askWith(200 * GB, "a", asker(), QUARTER).took?.name).toBe("a");
    expect(askWith(200 * GB, "b", asker(), QUARTER).took?.name).toBe("b");
    const third = askWith(200 * GB, "c", asker(), QUARTER);
    expect(third.took).toBeUndefined();
    expect(names(third.waiting?.holders)).toEqual(["a", "b"]);
    expect(third.waiting?.short).toBeUndefined();
  });

  // The 22:58 case: MemAvailable is read before either run has used any memory, so each would see room for itself.
  test("two runs asked seconds apart: the second counts the first's cap, which its scope has not used yet", () => {
    expect(askWith(36 * GB, "a", asker(), QUARTER, 0, 0).took?.name).toBe("a");
    const second = askWith(36 * GB, "b", asker(), QUARTER, 1, 0);
    expect(second.took).toBeUndefined();
    expect(second.waiting?.short).toEqual({ available: 36 * GB, unused: QUARTER, part: QUARTER, whole: false, floor: FLOOR });
  });

  test("a hold counts the part of its cap its scope does not use yet, its file cache not counted as used", () => {
    const first = askWith(40 * GB, "a", asker(), QUARTER).took;
    const unit = first?.unit ?? "";
    expect(unit).toMatch(/^fleet-gate-/);

    // 14G in the scope, 4G of it file cache that MemAvailable already counts as available: 10G used, 6G still to come.
    const cached = askOn(machine(28 * GB, { [unit]: { current: 14 * GB, file: 4 * GB } }), "b", asker(), QUARTER, 1, 0);
    expect(cached.waiting?.short).toEqual({ available: 28 * GB, unused: 6 * GB, part: QUARTER, whole: false, floor: FLOOR });

    // A scope that used more than its cap leaves nothing unused.
    expect(askOn(machine(24 * GB, { [unit]: { current: 17 * GB, file: 0 } }), "b", asker(), QUARTER, 2, 0).took?.name).toBe("b");
  });

  test("an ask of the whole budget counts one run's cap against the floor: no other hold runs beside it", () => {
    const short = askWith(QUARTER + 7 * GB, "all", asker(), undefined, 0, 0);
    expect(short.waiting?.short).toEqual({ available: QUARTER + 7 * GB, unused: 0, part: QUARTER, whole: true, floor: FLOOR });
    expect(askWith(QUARTER + FLOOR, "all", asker(), undefined, 1, 0).took?.cap).toBeUndefined();
  });

  test("a run waiting only for memory does not hold back a smaller one that fits the budget and the floor", () => {
    const big = asker();
    expect(askWith(20 * GB, "big", big, QUARTER).took).toBeUndefined();
    expect(gate.standing(at(1)).queue[0]).toMatchObject({ name: "big", memory: true });
    expect(askWith(20 * GB, "small", asker(), GB, 1).took?.name).toBe("small");
    expect(askWith(30 * GB, "big", big, QUARTER, 2).took?.name).toBe("big");

    // One that waits on the budget keeps its place: whoever comes after it waits behind it.
    const c = askWith(200 * GB, "c", asker(), QUARTER, 3);
    expect(names(c.waiting?.holders)).toEqual(["small", "big"]);
    expect(gate.standing(at(4)).queue[0]).toMatchObject({ name: "c", memory: false });
    const behind = askWith(200 * GB, "tiny", asker(), GB, 5);
    expect(behind.took).toBeUndefined();
    expect(names(behind.waiting?.ahead)).toEqual(["c"]);
  });
});

describe("MemAvailable and the floor", () => {
  const meminfo = (text: string): string => {
    const path = join(dir, "..", "meminfo");
    writeFileSync(path, text);

    return path;
  };

  test("MemAvailable is read from /proc/meminfo, or the file $FLEET_MEMINFO names; none where it cannot be read", () => {
    const path = meminfo("MemTotal:       65536000 kB\nMemFree:         1000000 kB\nMemAvailable:   14889779 kB\n");
    expect(memAvailable((name) => (name === "FLEET_MEMINFO" ? path : undefined))).toBe(14889779 * 1024);
    expect(memAvailable((name) => (name === "FLEET_MEMINFO" ? join(dir, "none") : undefined))).toBeUndefined();
    expect(memAvailable((name) => (name === "FLEET_MEMINFO" ? meminfo("MemTotal: 1 kB\n") : undefined))).toBeUndefined();
  });

  test("the floor is --floor, else $FLEET_GATE_MEMORY_FLOOR, else 8G; any zero keeps nothing free", () => {
    const env = (floor: string | undefined) => (name: string): string | undefined => (name === "FLEET_GATE_MEMORY_FLOOR" ? floor : undefined);
    expect(floorOf(undefined, env(undefined))).toEqual({ spec: "8G", bytes: 8 * GB });
    expect(floorOf(undefined, env(" 4G "))).toEqual({ spec: "4G", bytes: 4 * GB });
    expect(floorOf(undefined, env(""))).toEqual({ spec: "8G", bytes: 8 * GB });
    expect(floorOf("2G", env("4G"))).toEqual({ spec: "2G", bytes: 2 * GB });

    for (const zero of ["0", "0G", "0.0M", "0%"]) expect(floorOf(zero, env(undefined))).toEqual({ spec: zero, bytes: 0 });
    expect(floorOf("lots", env(undefined))).toBeUndefined();
    expect(floorOf(undefined, env("-1G"))).toBeUndefined();
  });

  test("a share of the RAM is of the MemTotal the same meminfo says", () => {
    const path = meminfo("MemTotal:       16777216 kB\nMemAvailable:   12582912 kB\n");
    expect(floorOf("50%", (name) => (name === "FLEET_MEMINFO" ? path : undefined))).toEqual({ spec: "50%", bytes: 8 * GB });
  });
});

describe("the queue", () => {
  test("waiters are admitted in the order they arrived", () => {
    const holder = ask("first", asker(), BUDGET).took;
    const [w1, w2, w3] = [asker(), asker(), asker()];
    ask("w1", w1, BUDGET, 1);
    ask("w2", w2, QUARTER, 2);
    ask("w3", w3, QUARTER, 3);
    expect(names(gate.standing(at(4)).queue)).toEqual(["w1", "w2", "w3"]);

    end(holder, 5);
    expect(names(ask("w3", w3, QUARTER, 6).waiting?.ahead)).toEqual(["w1", "w2"]);
    expect(names(ask("w2", w2, QUARTER, 6).waiting?.ahead)).toEqual(["w1"]);
    const first = ask("w1", w1, BUDGET, 6).took;
    expect(first?.name).toBe("w1");
    expect(names(gate.standing(at(7)).queue)).toEqual(["w2", "w3"]);

    end(first, 8);
    expect(ask("w3", w3, QUARTER, 9).took).toBeUndefined();
    expect(ask("w2", w2, QUARTER, 9).took?.name).toBe("w2");
    expect(ask("w3", w3, QUARTER, 9).took?.name).toBe("w3");
    expect(gate.standing(at(9)).queue).toEqual([]);
  });

  test("a waiter keeps its place across asks", () => {
    ask("first", asker(), BUDGET);
    const [w1, w2] = [asker(), asker()];
    ask("w1", w1, QUARTER, 1);
    ask("w2", w2, QUARTER, 2);
    ask("w1", w1, QUARTER, 3);
    ask("w2", w2, QUARTER, 4);
    expect(names(gate.standing(at(5)).queue)).toEqual(["w1", "w2"]);
    expect(gate.standing(at(5)).queue[0]?.since).toBe(gate.standing(at(1)).queue[0]?.since ?? "");
  });

  test("a waiter whose process is gone leaves the queue", async () => {
    const holder = ask("first", asker(), BUDGET).took;
    const [w1, w2] = [asker(), asker()];
    ask("w1", w1, BUDGET, 1);
    ask("w2", w2, QUARTER, 2);
    expect(names(ask("w2", w2, QUARTER, 3).waiting?.ahead)).toEqual(["w1"]);

    await die(w1);
    expect(names(gate.standing(at(4)).queue)).toEqual(["w2"]);
    end(holder, 5);
    expect(ask("w2", w2, QUARTER, 6).took?.name).toBe("w2");
  });

  test("a waiter that stopped asking is dropped once its own wait has run out", () => {
    ask("first", asker(), BUDGET);
    const [w1, w2] = [asker(), asker()];
    ask("w1", w1, BUDGET, 0, 30);
    ask("w2", w2, QUARTER, 1, 600);
    expect(names(gate.standing(at(39)).queue)).toEqual(["w1", "w2"]);
    expect(names(gate.standing(at(40)).queue)).toEqual(["w2"]);
  });

  test("a waiter that gives up leaves its place", () => {
    ask("first", asker(), BUDGET);
    const [w1, w2] = [asker(), asker()];
    ask("w1", w1, BUDGET, 1);
    ask("w2", w2, QUARTER, 2);
    gate.leave(w1, at(3));
    expect(names(gate.standing(at(3)).queue)).toEqual(["w2"]);
  });
});

describe("a holder that is gone", () => {
  test("a run's hold lives as long as its runner, whatever becomes of its fleet's entry; a hold by hand lapses with its fleet", () => {
    served = ["infra"];
    const run = gate.ask({ holder: { name: "infra", kind: "fleet" }, what: "gate run: just test", seconds: 3600, cap: QUARTER, budget: BUDGET, pid: asker(), runs: true, waitS: 0 }, at(0));
    expect("took" in run).toBe(true);
    take("infra", QUARTER, 1, "fleet");
    expect(gate.standing(at(2)).holders.map((h) => h.what)).toEqual(["gate run: just test", "build infra"]);

    // The fleet's session got a title, or its entry was dropped: the suite still runs, and still holds its memory.
    served = ["infra-lead"];
    expect(gate.standing(at(3)).holders.map((h) => h.what)).toEqual(["gate run: just test"]);
    expect(ask("big", asker(), BUDGET, 4, 0).took).toBeUndefined();
  });

  test("a dead runner's part of the budget is free again, and the other hold stays", async () => {
    const a = asker();
    ask("a", a, QUARTER);
    ask("b", asker(), QUARTER);
    const c = asker();
    expect(ask("c", c, QUARTER, 1).took).toBeUndefined();

    await die(a);
    expect(names(gate.standing(at(2)).holders)).toEqual(["b"]);
    expect(ask("c", c, QUARTER, 3).took?.name).toBe("c");
    expect(names(gate.standing(at(3)).holders)).toEqual(["b", "c"]);
  });

  test("a run with a cap names the scope it runs in, and lapses with its runner once that scope is gone too", async () => {
    const pid = asker();
    const run = ask("a", pid, QUARTER).took;
    expect(run?.unit).toBe(`fleet-gate-${run?.token ?? ""}-${String(pid)}`);
    expect(take("b", QUARTER, 1).took?.unit).toBeUndefined();
    // No scope of that name runs here: with its runner gone, nothing of the run is left.
    await die(pid);
    expect(names(gate.standing(at(2)).holders)).toEqual(["b"]);
  });

  test("a hold lapses at its until", () => {
    ask("a", asker(), QUARTER);
    expect(names(gate.standing(at(3599)).holders)).toEqual(["a"]);
    expect(gate.standing(at(3600)).holders).toEqual([]);
    expect(existsSync(join(dir, "gate.json"))).toBe(false);
  });

  test("a runner's pid taken by a later process is not the runner", () => {
    const pid = asker();
    ask("a", pid, QUARTER);
    const kept = file();
    const hold = asObject(asArray(kept["holds"])?.[0]) ?? {};
    writeFileSync(join(dir, "gate.json"), JSON.stringify({ ...kept, holds: [{ ...hold, started: "1" }] }));
    expect(gate.standing(at(1)).holders).toEqual([]);
  });

  test("a hold taken by hand is its taker's: a run of its own name waits for it, and its token frees it", () => {
    const hand = take("w", undefined).took;
    expect(ask("w", asker(), QUARTER, 1, 0).took).toBeUndefined();
    expect(gate.free(hand?.token ?? "", at(2))).toEqual({ freed: true });
    expect(gate.standing(at(2)).holders).toEqual([]);
  });

  test("a hold by hand an older fleet's run goes under is freed by its token, and the run's memory stays counted until the run ends", async () => {
    const hand = take("w", QUARTER).took;
    const r1 = asker();
    mark({ runner: r1, runner_unit: "fleet-gate-0a1b2c3d-1" });
    expect(gate.free(hand?.token ?? "", at(1))).toEqual({ freed: true });

    const [run] = gate.standing(at(1)).holders;
    expect(run).toMatchObject({ name: "w", pid: r1, unit: "fleet-gate-0a1b2c3d-1", cap: QUARTER, budget: BUDGET, until: hand?.until ?? "", runner: undefined });
    expect(ask("big", asker(), BUDGET, 2, 0).took).toBeUndefined();

    await die(r1);
    expect(gate.standing(at(3)).holders).toEqual([]);
  });

  test("a runner's mark an older fleet's run left keeps a fleet's hold by hand while that run goes, and not after", async () => {
    served = ["infra"];
    take("infra", QUARTER, 0, "fleet");
    const r1 = asker();
    mark({ runner: r1 });
    served = ["infra-lead"];
    expect(names(gate.standing(at(1)).holders)).toEqual(["infra"]);
    expect(ask("big", asker(), BUDGET, 1, 0).took).toBeUndefined();

    await die(r1);
    expect(gate.standing(at(2)).holders).toEqual([]);

    // A mark whose pid a later process has is no run's.
    served = ["infra"];
    take("infra", QUARTER, 3, "fleet");
    mark({ runner: asker(), runner_started: "1" });
    served = ["infra-lead"];
    expect(gate.standing(at(4)).holders).toEqual([]);
  });

  test("a name with a line break is, to a release, the name it was kept under", () => {
    expect(take("a\nb", undefined).took?.name).toBe("a b");
    expect(gate.free("a\nb", at(1))).toEqual({ freed: true });
    expect(gate.standing(at(1)).holders).toEqual([]);
  });

  test("a run is ended by its scope's name when it has one, else by its runner while that pid is still the runner's", () => {
    const pid = asker();
    const scoped = ask("a", pid, QUARTER).took;
    expect(scoped === undefined ? undefined : endOf(scoped)).toBe(`systemctl --user stop ${scoped?.unit ?? ""}.scope`);
    end(scoped, 1);

    const bare = ask("b", pid, undefined, 2).took;
    expect(bare === undefined ? undefined : endOf(bare)).toBe(`kill ${String(pid)}`);
    // The pid is another process's by now: nothing of this run is left to stop, and that process is not named.
    expect(bare === undefined ? "" : endOf({ ...bare, raw: { ...bare.raw, started: "1" } })).toBeUndefined();
  });

});

describe("gate.json and the fleets before the budget", () => {
  const old = { fleet: "old", kind: "session", what: "gate run: just test", since: "2026-10-05T11:50:00+00:00", until: "2026-10-05T12:50:00+00:00", token: "0badc0de" };

  test("a hold an older fleet wrote is the whole budget: nothing fits beside it", () => {
    makeGateFile({ ...old, pid: process.pid });
    const refused = ask("a", asker(), QUARTER, 1, 0);
    expect(refused.took).toBeUndefined();
    expect(refused.waiting?.holders[0]?.cap).toBeUndefined();
    expect(gate.standing(at(1)).holders.map(holdText)).toEqual(["held by old (no fleet) since 2026-10-05T11:50:00+00:00, until 2026-10-05T12:50:00+00:00: gate run: just test"]);
    expect(gate.head(at(1))).toEqual({ ...old, pid: process.pid });
    expect("running" in gate.free("0badc0de", at(2))).toBe(true);
    expect(gate.free("0badc0de", at(2), process.pid)).toEqual({ freed: true });
    expect(ask("a", asker(), QUARTER, 3, 0).took?.name).toBe("a");
  });

  test("an older fleet's hold lapses as it did: at its until, with its runner, with its fleet", async () => {
    makeGateFile(old);
    expect(gate.standing(at(3000)).holders).toEqual([]);

    const runner = asker();
    makeGateFile({ ...old, pid: runner });
    expect(names(gate.standing(at(1)).holders)).toEqual(["old"]);
    await die(runner);
    expect(gate.standing(at(2)).holders).toEqual([]);

    makeGateFile({ fleet: "infra", what: "the test suite", since: "2026-10-05T11:50:00+00:00" });
    expect(gate.standing(at(1)).holders).toEqual([]);
    makeGateFile({ fleet: "infra", what: "the test suite", since: "2026-10-05T11:50:00+00:00" });
    served = ["infra"];
    expect(gate.head(at(1))).toEqual({ fleet: "infra", what: "the test suite", since: "2026-10-05T11:50:00+00:00" });
  });

  test("one hold of the whole budget, taken by hand, is written as older fleets wrote it", () => {
    gate.ask({ holder: { name: "builder", kind: "session" }, what: "a build", seconds: 3600, cap: undefined, budget: BUDGET, pid: asker(), runs: false, waitS: 0 }, at(0));
    expect(Object.keys(file()).toSorted()).toEqual(["fleet", "kind", "since", "token", "until", "what"]);
    expect(file()["fleet"]).toBe("builder");
  });

  test("holds with a cap are written so that an older fleet reads the gate as held while any of them lives", () => {
    const a = ask("a", asker(), QUARTER).took;
    const one = file();
    expect(olderFleetReadsHeld(one, at(1))).toBe(true);
    expect(one["fleet"]).toBe("a (16.0G)");

    const b = ask("b", asker(), QUARTER, 60).took;
    const two = file();
    expect(asArray(two["holds"])?.length).toBe(2);
    // What an older fleet tests: no runner to find dead, a session's hold (no fleet to find gone), the last until.
    expect(two["pid"]).toBeUndefined();
    expect(two["kind"]).toBe("session");
    expect(two["until"]).toBe(b?.until ?? "");
    expect(olderFleetReadsHeld(two, at(3599))).toBe(true);
    expect(olderFleetReadsHeld(two, at(3659))).toBe(true);
    expect(olderFleetReadsHeld(two, at(3660))).toBe(false);
    expect(gate.standing(at(3660)).holders).toEqual([]);
    // Nothing an older fleet can free or run under: its name is no hold's, and it has no token to free it by.
    expect([a?.name, b?.name]).not.toContain(asString(two["fleet"]));
    expect(a?.token).toBeDefined();
    expect(two).not.toHaveProperty("token");
    expect(one).not.toHaveProperty("token");
    expect(two["what"]).toBe("suite a | suite b");
  });

  test("a run of the whole budget is never written bare: an older fleet would drop it with its fleet", () => {
    served = ["infra"];
    gate.ask({ holder: { name: "infra", kind: "fleet" }, what: "gate run: just test", seconds: 3600, cap: undefined, budget: BUDGET, pid: asker(), runs: true, waitS: 0 }, at(0));
    expect(file()).toMatchObject({ fleet: "infra (all)", kind: "session", v: 2 });
    expect(file()["pid"]).toBeUndefined();
    expect(olderFleetReadsHeld(file(), at(1))).toBe(true);
    expect(ask("a", asker(), QUARTER, 1, 0).took).toBeUndefined();
  });

  test("a name or a label with a line break or a control character is one line wherever the gate prints it", () => {
    const took = gate.ask({ holder: { name: "w1\nfree", kind: "session" }, what: "suite\r\n\u001b[2Kfree\u2028x", seconds: 3600, cap: QUARTER, budget: BUDGET, pid: asker(), runs: false, waitS: 0 }, at(0));
    expect("took" in took && holdText(took.took)).toBe("held by w1 free (no fleet) since 2026-10-05T12:00:00+00:00, until 2026-10-05T13:00:00+00:00, cap 16.0G: suite [2Kfree x");
    expect(JSON.stringify(file())).not.toMatch(/\\n|\\r|\\u001b|\\u2028/);
    makeGateFile({ fleet: "x\nfree", kind: "session", what: "a\tb\u0007", since: "2026-10-05T11:50:00+00:00\nfree" });
    expect(gate.standing(at(1)).holders.map(holdText)).toEqual(["held by x free (no fleet) since 2026-10-05T11:50:00+00:00 free: a b"]);
  });

  test("a file whose holds this fleet cannot read is one hold of the whole budget", () => {
    makeGateFile({ ...old, v: 3, holds: "packed" });
    const refused = ask("a", asker(), QUARTER, 1, 0);
    expect(refused.took).toBeUndefined();
    expect(names(refused.waiting?.holders)).toEqual(["old"]);
  });

  function makeGateFile(content: JsonObject): void {
    gate.standing(at(0));
    gate.free("", at(0));
    writeFileSync(join(dir, "gate.json"), JSON.stringify(content));
  }
});

describe("a cap", () => {
  test("is a share of the RAM or a size, 64 MiB at least: a share that rounds to nothing is refused", () => {
    const total = 64 * GB;
    expect(capBytes("25%", total)).toBe(QUARTER);
    expect(capBytes("64M", total)).toBe(64 * 1024 ** 2);
    expect(capBytes("63M", total)).toBeUndefined();
    expect(capBytes("0.0000000001%", total)).toBeUndefined();
    expect(capBytes("1e-12%", total)).toBeUndefined();
    expect(capBytes("0", total)).toBeUndefined();
    expect(capBytes("1", total)).toBeUndefined();
  });
});

describe("the runs' records", () => {
  function run(minute: number, more: Partial<RunRecord>): RunRecord {
    return { at: new Date(Date.parse("2026-10-05T12:00:00Z") + minute * 60_000).toISOString(), name: "w", kind: "session", what: "just test-changed", asked: "25%", cap: QUARTER, waited: 0, ran: 60, code: 0, peak: GB, killed: 0, ...more };
  }

  test("no record, no numbers", () => {
    expect(gate.day(at(0))).toBeUndefined();
  });

  test("a line per run, and the last day in numbers", () => {
    for (let i = 1; i <= 10; i += 1) gate.record(run(i, { waited: i * 10, peak: i * GB }));
    gate.record(run(11, { waited: 1800, ran: null, code: 75, peak: null }));
    gate.record(run(12, { waited: 5, code: 137, killed: 2, peak: 16 * GB }));
    gate.record(run(-25 * 60, { waited: 9999, peak: 60 * GB }));

    const lines = readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(13);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ at: "2026-10-05T12:01:00.000Z", name: "w", kind: "session", what: "just test-changed", asked: "25%", cap: QUARTER, waited: 10, ran: 60, code: 0, peak: GB, killed: 0 });
    // The day's twelve waits in order: 5, 10 ... 100, 1800. The run of the day before is out.
    expect(gate.day(at(13 * 60))).toEqual({ runs: 11, gaveUp: 1, medianWait: 50, p90Wait: 100, maxPeak: 16 * GB, capped: 1 });
    expect(gate.day(at(13 * 60 + 24 * 3600))).toBeUndefined();
  });

  test("the records keep their newest lines", () => {
    for (let i = 0; i < 2001; i += 1) gate.record(run(0, { waited: i }));
    const lines = readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1000);
    expect(JSON.parse(lines.at(-1) ?? "").waited).toBe(2000);
  });
});
