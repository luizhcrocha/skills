/**
 * The gate (gate.ts) through its interface: admission by the memory budget, the queue's order, holds and waiters
 * whose process is gone, the files an older fleet reads and wrote, and the runs' records. Each asker is a real
 * process (a `sleep`), since a hold and a place in the queue live as long as the process that asked.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { asArray, asObject, asString, type JsonObject } from "../src/json.ts";
import { capBytes, endOf, Gate, holdText, type Hold, type RunRecord, type Waiting } from "../src/gate.ts";
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

  test("one run at a time under a hold taken by hand, and a dead runner's mark counts for nothing", async () => {
    gate.ask({ holder: { name: "w", kind: "session" }, what: "by hand", seconds: 3600, cap: undefined, budget: BUDGET, pid: asker(), runs: false, waitS: 0 }, at(0));
    const [r1, r2] = [asker(), asker()];
    const first = gate.join("w", r1, at(1), 6);
    expect(first !== undefined && "joined" in first && first.joined.runner).toBe(r1);
    const second = gate.join("w", r2, at(2), 6);
    expect(second !== undefined && "busy" in second && second.busy.runner).toBe(r1);
    expect(gate.join("other", r2, at(2), 6)).toBeUndefined();

    await die(r1);
    const third = gate.join("w", r2, at(3), 6);
    expect(third !== undefined && "joined" in third).toBe(true);
    gate.unjoin(r2, at(4));
    expect(file()).not.toHaveProperty("runner");
    expect(file()).not.toHaveProperty("runner_started");
    expect(names(gate.standing(at(4)).holders)).toEqual(["w"]);
  });

  test("a hold taken by hand is not freed under its run: the release names the runner, and the hold stays counted", async () => {
    const hand = take("w", undefined).took;
    const r1 = asker();
    expect(gate.join("w", r1, at(1), 6)).toHaveProperty("joined");

    for (const key of ["w", hand?.token ?? ""]) {
      const refused = gate.free(key, at(2));
      expect("running" in refused && refused.running.map((h) => h.runner)).toEqual([r1]);
    }

    expect(names(gate.standing(at(2)).holders)).toEqual(["w"]);
    expect(ask("big", asker(), BUDGET, 3, 0).took).toBeUndefined();

    await die(r1);
    expect(gate.free(hand?.token ?? "", at(4))).toEqual({ freed: true });
    expect(gate.standing(at(4)).holders).toEqual([]);
  });

  test("a fleet's hold by hand lives under its run though the fleet's entry goes, and lapses with the fleet once the run is done", async () => {
    served = ["infra"];
    take("infra", QUARTER, 0, "fleet");
    const r1 = asker();
    expect(gate.join("infra", r1, at(1), 6)).toHaveProperty("joined");

    served = ["infra-lead"];
    expect(names(gate.standing(at(2)).holders)).toEqual(["infra"]);
    expect(ask("big", asker(), BUDGET, 2, 0).took).toBeUndefined();

    await die(r1);
    expect(gate.standing(at(3)).holders).toEqual([]);
  });

  test("a run under a hold by hand records its scope on the hold, and leaves nothing of itself when it is done", () => {
    take("w", QUARTER);
    const r1 = asker();
    const unit = `fleet-gate-0a1b2c3d-${String(r1)}`;
    const under = gate.join("w", r1, at(1), 6, unit);
    expect(under !== undefined && "joined" in under && under.joined.runnerUnit).toBe(unit);
    expect(asObject(asArray(file()["holds"])?.[0])).toMatchObject({ runner: r1, runner_unit: unit });

    gate.unjoin(r1, at(2));
    expect(Object.keys(asObject(asArray(file()["holds"])?.[0]) ?? {}).filter((key) => key.startsWith("runner"))).toEqual([]);
  });

  test("a name with a line break is, to a run and to a release, the name it was kept under", () => {
    expect(take("a\nb", undefined).took?.name).toBe("a b");
    const r1 = asker();
    expect(gate.join("a\nb", r1, at(1), 6)).toHaveProperty("joined");
    gate.unjoin(r1, at(2));
    expect(gate.free("a\nb", at(3))).toEqual({ freed: true });
    expect(gate.standing(at(3)).holders).toEqual([]);
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

  test("a runner's mark whose pid a later process has is taken over", () => {
    take("w", undefined);
    const [r1, r2] = [asker(), asker()];
    gate.join("w", r1, at(1), 6);
    writeFileSync(join(dir, "gate.json"), JSON.stringify({ ...file(), runner_started: "1" }));
    const next = gate.join("w", r2, at(2), 6);
    expect(next !== undefined && "joined" in next && next.joined.runner).toBe(r2);
  });

  test("a hold about to lapse is not one to run under: a run cannot outlive it", () => {
    take("w", undefined);
    expect(gate.join("w", asker(), at(3594), 6)).toBeDefined();
    gate.unjoin(gate.standing(at(3594)).holders[0]?.runner ?? 0, at(3594));
    expect(gate.join("w", asker(), at(3595), 6)).toBeUndefined();
    expect(names(gate.standing(at(3595)).holders)).toEqual(["w"]);
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
