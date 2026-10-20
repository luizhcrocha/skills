/**
 * A worker held queued (`agent --status queued`: on a rule, the gate slot, a landing turn) past thirty minutes
 * gets a `!` line from the coordinator's chat watch, as a silent one does, so the wait and its cost reach the
 * Now line instead of passing unseen (on 10-20 a bench waited a day on two serializing rules nobody showed).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { fleetsUnheard, ownSilent } from "../src/chat/watch.ts";
import { machineOf, type Machine } from "../src/world.ts";
import { tmp } from "./support.ts";

let base: string;

let dir: string;

let machine: Machine;

let zone: string | undefined;

afterEach(() => {
  if (zone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = zone;
});

beforeEach(() => {
  zone = process.env["TZ"];
  process.env["TZ"] = "UTC";
  base = tmp("fleet-queued-");
  dir = join(base, "coordinator");
  mkdirSync(dir, { recursive: true });

  const env = new Map([
    ["CLAUDE_CONFIG_DIR", join(base, "config")],
    ["FLEET_HOME", join(base, "registry")],
    ["FLEET_DISCOVER", "0"],
    ["HOME", base],
  ]);

  machine = machineOf(
    () => new Date("2026-01-05T10:00:00Z"),
    (name) => env.get(name),
  );
  const row = (id: string, status: string, updated: string, lane: string[] = []) => ({ id, name: `bench ${id}`, task: "t", status, lane, milestone: "m1", started: "2026-01-05T08:00:00+00:00", updated });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      project: "p",
      goal: "g",
      status: "running",
      now: "n",
      started: "s",
      roadmap: [],
      roadblocks: [],
      decisions: [],
      events: [],
      agents: [
        row("a4", "queued", "2026-01-05T09:00:00+00:00"),
        row("a5", "queued", "2026-01-05T09:30:00+00:00"), // exactly 30 min: not yet
        row("a6", "done", "2026-01-05T08:00:00+00:00"),
        row("a7", "queued", "2026-01-05T09:00:00+00:00", ["src/x.ts"]), // behind a8's lane: the fleet's own ordering
        row("a8", "running", "2026-01-05T09:55:00+00:00", ["src/"]),
        row("advisor", "queued", "2026-01-05T08:00:00+00:00"), // the advisor waits queued for questions
      ],
    }),
  );
});

test("a worker queued past thirty minutes on a rule, the gate slot or a turn is told once, with the time so far and what to do about it", () => {
  const queued = ownSilent(machine, dir).filter((l) => l.includes("queued"));
  expect(queued).toEqual([
    "! worker a4 (bench a4) has waited queued since 09:00 (60 min). Put the wait on the Now line (what it waits on, " +
      "which rule, gate or turn holds it, the time so far) and offer the user to drop the rule or yield as a decision.",
  ]);
  expect(ownSilent(machine, dir).filter((l) => l.includes("queued"))).toEqual([]);
});

test("a worker queued behind a live lane, or the advisor waiting for questions, gets no line: the fleet ordered it", () => {
  expect(ownSilent(machine, dir).filter((l) => / a7 | advisor /u.test(l))).toEqual([]);
});

test("a manager's watch tells it of another fleet's worker queued past thirty minutes, so it can yield the turn or the slot", () => {
  mkdirSync(join(base, "registry"), { recursive: true });
  writeFileSync(join(base, "registry", "acme.json"), JSON.stringify({ id: "acme", role: "coordinator", dir, url: "http://box/f/acme/", pid: process.pid, session: null, since: "t" }));
  const me = join(base, "manager");
  mkdirSync(me, { recursive: true });
  expect(fleetsUnheard(machine, me).filter((l) => l.includes("queued"))).toEqual([
    "! acme's worker a4 (bench a4) has waited queued since 09:00 (60 min). SendMessage acme to put it on its Now line.",
  ]);
});
