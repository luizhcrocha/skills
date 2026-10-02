/**
 * The manager's page holds a fleet's open item in "Waits on you" exactly when that fleet's own page does: the
 * summary the manager is sent (`summary` in src/page/view.ts) run through the page's own rule
 * (`Core.bucketOf` in page/src/core.ts) gives each item the bucket the fleet's page gives it from its ledger
 * and its chat, for every kind, answered or not, replied to, revised, held, or the manager's.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, expect, test } from "bun:test";

import { Core, type Decision, type Message } from "../page/src/core.ts";
import type { JsonObject } from "../src/json.ts";
import { cliLookups } from "../src/page/lookups.ts";
import { view } from "../src/page/view.ts";
import { baseEnv, machine, tmp, type Environment } from "./support.ts";

let base: string;

let env: Environment;

beforeEach(() => {
  base = tmp("fleet-waits-");
  env = baseEnv(join(base, "registry"));
});

const OPENED = "2026-10-02T10:00:00+00:00";

const KINDS = ["decision", "input", "secret", "action", "permission"];

/** Every way an item of `kind` can stand: never answered, answered, answered and replied to, answered before
 * it was revised, held by the fleet, the manager's. */
function itemsOf(kind: string): JsonObject[] {
  const item = (id: string, more: JsonObject = {}): JsonObject => ({ id: `${kind}-${id}`, kind, title: id, question: "q", status: "open", opened: OPENED, ...more });

  return [
    item("open"),
    item("sent"),
    item("replied"),
    item("stale", { revised: "2026-10-02T10:20:00+00:00" }),
    item("held", { held: "after the cost work", held_at: "2026-10-02T10:40:00+00:00" }),
    item("manager", { asks: "manager" }),
  ];
}

const question = (id: string, status: string, of: string | null = null): JsonObject => ({ id, title: "T", body: "B", recommend: "R", reason: "W", of, status, answer: null, asked: OPENED });

const grill = (id: string, questions: JsonObject[]): JsonObject => ({ id, kind: "grill", title: id, question: "q", status: "open", opened: OPENED, questions });

/** G3: the fleet's turn (every question answered); G4: the user's (none answered); G5 answered in the chat;
 * G6 answered in part; G7 answered and replied to, so asked again. */
const GRILLS: JsonObject[] = [
  grill("G3", [question("q1", "answered"), question("q2", "answered"), question("q3", "answered")]),
  grill("G4", [question("q1", "open"), question("q2", "open")]),
  grill("G5", [question("q1", "open"), question("q2", "open", "q1")]),
  grill("G6", [question("q1", "open"), question("q2", "open")]),
  grill("G7", [question("q1", "open")]),
];

/** The fleet's chat: the user's answers and the fleet's replies to some. */
function chatOf(): JsonObject[] {
  const said: JsonObject[] = [];

  const say = (from: string, text: string, at: string, more: JsonObject = {}): number => {
    const id = said.length + 1;
    said.push({ id, at, from, to: [from === "user" ? "coordinator" : "user"], text, re: null, ...more });

    return id;
  };

  for (const kind of KINDS) {
    say("user", "a", "2026-10-02T10:30:00+00:00", { decision: `${kind}-sent` });
    say("coordinator", "which a?", "2026-10-02T10:31:00+00:00", { re: say("user", "a", "2026-10-02T10:30:00+00:00", { decision: `${kind}-replied` }) });
    say("user", "a", "2026-10-02T10:10:00+00:00", { decision: `${kind}-stale` });
    say("user", "a", "2026-10-02T10:30:00+00:00", { decision: `${kind}-held` });
  }

  say("user", "Q1: yes\nQ2: no", "2026-10-02T10:30:00+00:00", { decision: "G5" });
  say("user", "Q1: yes", "2026-10-02T10:30:00+00:00", { decision: "G6" });
  say("coordinator", "yes to which?", "2026-10-02T10:31:00+00:00", { re: say("user", "Q1: yes", "2026-10-02T10:30:00+00:00", { decision: "G7" }) });

  return said;
}

function makeFleet(name: string, more: JsonObject): string {
  const root = join(base, name, "coordinator");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "state.json"), JSON.stringify({ project: name, goal: "g", status: "running", now: "n", started: "x", roadmap: [], agents: [], roadblocks: [], decisions: [], events: [], ...more }));

  return root;
}

function stateOf(root: string): JsonObject {
  // SAFETY: the fixture wrote this file as a JSON object a moment ago.
  return JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as JsonObject;
}

test("every open item waits on the user on the manager's page exactly when it does on its fleet's own", () => {
  const ui = makeFleet("ui", { decisions: [...KINDS.flatMap(itemsOf), ...GRILLS] });
  const said = chatOf();
  writeFileSync(join(ui, "chat.jsonl"), said.map((m) => `${JSON.stringify(m)}\n`).join(""));
  machine(env).registry.register(ui, "u1", process.pid, OPENED);
  const m = makeFleet("m", { role: "manager" });
  machine(env).registry.register(m, "u9", process.pid, OPENED);

  const messages: Message[] = said.flatMap((x) => Core.parseMessage(x) ?? []);
  const own = Core.parseState(view(machine(env), cliLookups(), stateOf(ui), ui))?.decisions ?? [];
  const fleet = Core.parseState(view(machine(env), cliLookups(), stateOf(m), m))?.coordinators[0];
  // As the manager's page lists a fleet's decision (model.ts, everyDecision): `<fleet>/<id>`, with its fleet.
  const listed: Decision[] = (fleet?.decisions ?? []).map((d) => ({ ...d, id: `${fleet?.id ?? ""}/${d.id}`, fleet: fleet?.id ?? "" }));

  const onItsPage = Object.fromEntries(own.map((d) => [d.id, Core.bucketOf(d, messages)]));
  const onTheManagers = Object.fromEntries(listed.map((d) => [d.id.replace(/^ui\//u, ""), Core.bucketOf(d, [])]));

  expect(onTheManagers).toEqual(onItsPage);
  expect(Object.keys(onItsPage)).toHaveLength(KINDS.length * 6 + GRILLS.length);
  expect(onItsPage).toMatchObject({ G3: "waiting", G4: "active", G5: "waiting", G6: "active", G7: "active" });

  for (const kind of KINDS) {
    expect([`open`, `sent`, `replied`, `stale`, `held`, `manager`].map((s) => onItsPage[`${kind}-${s}`])).toEqual(["active", "waiting", "waiting", "active", "waiting", "waiting"]);
  }

  expect(Core.queueOf(listed, [], null).ids.toSorted()).toEqual(listed.flatMap((d) => (onItsPage[d.id.replace(/^ui\//u, "")] === "active" ? [d.id] : [])).toSorted());
});
