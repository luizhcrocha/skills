/**
 * A long-lived fleet's page stays linear in its ledger. Infra's page froze the manager's for 18 s: every
 * row that names a decision scanned all of them (1,327 events and 793 messages, each over 243 decisions),
 * and the stream's replay added the chat one message at a time, each one computing again what reads the
 * conversation. Here a synthetic ledger as large (250 decisions, 1,500 events, 800 messages) is rendered
 * and its chat replayed through the stream, and the reads of the ledger's rows are counted by getters (the
 * store calls one on every read): scanning or recomputing per row would read them hundreds of thousands of
 * times. The log shows its newest lines and more on asking. Run in happy-dom.
 */
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Decision, type Json, type State } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { LOG_STEP } from "../src/Views.tsx";
import { coordinatorView, managerView, type View } from "./fixtures.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

const DECISIONS = 250;

const EVENTS = 1500;

const MESSAGES = 800;

/** Reads of each field of the rows under count, by field. */
const reads = new Map<string, number>();

const readsOf = (field: string): number => reads.get(field) ?? 0;

/**
 * `row` with each field a getter that counts its reads as `<what>.<field>`. The store calls a getter on every
 * read (it keeps no copy of a getter's value), so every read through the page's store is counted.
 */
function counted<T extends object>(row: T, what: string): T {
  const fields: PropertyDescriptorMap = {};

  for (const [key, value] of Object.entries(row)) {
    fields[key] = {
      enumerable: true,
      get: () => {
        reads.set(`${what}.${key}`, readsOf(`${what}.${key}`) + 1);

        return value;
      },
    };
  }

  // SAFETY: the same fields, each read through a getter that returns its value.
  return Object.defineProperties({}, fields) as T;
}

const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

/** `n` decisions, every fourth open, every tenth replacing the one before it. */
function decisions(n: number, prefix = "d"): View[] {
  return Array.from({ length: n }, (_, i) => {
    const d: View = {
      id: `${prefix}${String(i + 1)}`,
      ref: `D${String(i + 1)}`,
      kind: "decision",
      title: `Decision ${String(i + 1)}`,
      question: `Which way for case ${String(i + 1)}?`,
      status: i % 4 === 0 ? "open" : "decided",
      blocking: false,
      asks: "user",
      opened: at(10_000 - i),
      manual: `step ${String(i + 1)}`,
      options: [],
    };

    const placed: View = i % 3 ? { ...d, milestone: `m${String(i % 10)}`, step: `s${String(i % 100)}` } : { ...d, milestone: `m${String(i % 10)}` };

    return i % 10 === 9 ? { ...placed, supersedes: `${prefix}${String(i)}` } : placed;
  });
}

/** A roadmap of 10 milestones of 10 steps each, the decisions tied to its steps in turn. */
const roadmap = (): View[] =>
  Array.from({ length: 10 }, (_, i) => ({ id: `m${String(i)}`, title: `Milestone ${String(i)}`, steps: Array.from({ length: 10 }, (_, j) => ({ id: `s${String(i * 10 + j)}`, title: `Step ${String(i * 10 + j)}`, status: "current" })) }));

/** `n` log lines, each about a decision (some by its number, as a link from another fleet names it). */
const events = (n: number): View[] =>
  Array.from({ length: n }, (_, i) => ({ at: at(n - i), kind: i % 3 ? "asked" : "message", text: `event ${String(i)}`, decision: i % 7 ? `d${String((i % DECISIONS) + 1)}` : `D${String((i % DECISIONS) + 1)}` }));

/** `n` messages of the chat, each about a decision. */
const messages = (n: number): Json[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, at: at(n - i), from: i % 2 ? "coordinator" : "user", to: [i % 2 ? "user" : "coordinator"], text: `message ${String(i)}`, decision: `d${String((i % DECISIONS) + 1)}` }));

/** The stream the page opens, driven by the test. */
class FakeStream {
  static readonly CONNECTING = 0;
  static last: FakeStream | undefined;
  readyState = 1;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, ((ev: { data: string }) => void)[]>();

  constructor() {
    FakeStream.last = this;
  }

  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close(): void {
    this.readyState = 2;
  }

  /** Event `type` with `data`, as the browser dispatches one. */
  send(type: string, data: Json): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

let page: { m: Model; ui: Ui };

let dispose: (() => void) | undefined;

/** The page at `address` with `view`, its decisions and events counted, live on the fake stream. */
function open(address: string, view: View): void {
  Object.assign(globalThis, { FleetCore: Core, EventSource: FakeStream });
  localStorage.clear();
  history.replaceState(null, "", address);
  globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 }), { preconnect: () => undefined });
  const parsed = Core.parseState(view);

  if (!parsed) throw new Error("the view is not a state");

  const state: State = {
    ...parsed,
    decisions: parsed.decisions.map((d) => counted(d, "decision")),
    events: parsed.events.map((e) => counted(e, "event")),
    coordinators: parsed.coordinators.map((c) => ({ ...c, decisions: c.decisions.map((d): Decision => counted(d, "fleet decision")) })),
  };

  const root = document.createElement("div");

  document.body.append(root);
  reads.clear();
  dispose = render(() => <App state={state} expose={(p) => (page = p)} />, root);
  flush();
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  FakeStream.last = undefined;
});

/** The stream's replay of `list` in one go, as one chunk of the network dispatches it, then its drain. */
async function replay(list: readonly Json[]): Promise<void> {
  const stream = FakeStream.last;

  if (!stream) throw new Error("the page opened no stream");
  stream.send("open", {});

  for (const msg of list) stream.send("chat", msg);
  await new Promise((done) => setTimeout(done, 20));
  flush();
}

test("a coordinator's log of 1,500 events about 250 decisions, and a replay of 800 messages, read each row a bounded number of times", async () => {
  open("/f/billing/#log", { ...coordinatorView(NOW), roadmap: roadmap(), decisions: decisions(DECISIONS), events: events(EVENTS) });
  await replay(messages(MESSAGES));

  expect(page.m.messages()).toHaveLength(MESSAGES);
  /* Each row naming a decision reads an index: the ids are read about 14 times each (the index, the lists, the
     queue), not once a row (a scan in decisionById reads them 550,000 times). */
  expect(readsOf("decision.id")).toBeLessThan(DECISIONS * 40);
  /* The replay computes what reads the conversation once, not once a message: the events are read about 7 times each. */
  expect(readsOf("event.text")).toBeLessThan(EVENTS * 20);
  /* Whether a decision waits reads the fields it weighs, not a copy of every field: a field no list shows is read
     at most once each, by the JSON the page keeps of the state it opened with. */
  expect(readsOf("decision.manual")).toBeLessThanOrEqual(DECISIONS);
  /* The plan's chips group the decisions once, not once a step (100 steps): each step field is read a few times. */
  expect(readsOf("decision.step")).toBeLessThan(DECISIONS * 20);
  expect(page.m.decisionById("D7")?.id).toBe("d7");
  expect(page.m.supersededBy("d9")?.id).toBe("d10");
});

test("the log shows its newest lines, and more on asking", () => {
  open("/f/billing/#log", { ...coordinatorView(NOW), decisions: decisions(DECISIONS), events: events(EVENTS) });
  const lines = (): number => document.querySelectorAll("#log > li").length;
  const more = (): HTMLButtonElement | null => document.querySelector("#log-more");

  expect(lines()).toBe(LOG_STEP);
  expect(document.querySelector("#log > li")?.textContent).toContain(`event ${String(EVENTS - 1)}`);
  expect(more()?.textContent).toBe(`Show ${String(LOG_STEP)} more of ${String(EVENTS - LOG_STEP)}`);
  more()?.click();
  flush();
  expect(lines()).toBe(2 * LOG_STEP);

  while (more()) {
    more()?.click();
    flush();
  }

  expect(lines()).toBe(EVENTS);
});

test("a log not shown makes none of its lines", () => {
  open("/f/billing/", { ...coordinatorView(NOW), decisions: decisions(DECISIONS), events: events(EVENTS) });

  expect(document.querySelectorAll("#log > li")).toHaveLength(0);
  location.hash = "#log";
  page.ui.route();
  flush();
  expect(document.querySelectorAll("#log > li")).toHaveLength(LOG_STEP);
});

test("a manager's list of 250 open fleet decisions reads no field a row does not show", async () => {
  const view = managerView(NOW);
  const fleets = Array.isArray(view["coordinators"]) ? view["coordinators"] : [];
  open("/f/manager/", { ...view, coordinators: fleets.map((c, i) => (i === 0 && c !== null && Object(c) === c && !Array.isArray(c) ? { ...c, decisions: decisions(DECISIONS, "x").map((d) => ({ ...d, status: "open" })) } : c)) });
  await replay([]);

  expect(page.m.everyDecision().filter((d) => d.fleet !== undefined && d.id.includes("/x"))).toHaveLength(DECISIONS);
  /* No list shows a fleet decision's manual: it is read at most once each, by the JSON the page keeps of its first
     state; copying every field would read it again each time the list is made. */
  expect(readsOf("fleet decision.manual")).toBeLessThanOrEqual(DECISIONS);
});
