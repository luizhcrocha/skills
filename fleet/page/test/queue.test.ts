/**
 * The manager's walk through what waits on the user (`queueOf`), the address of another fleet's decision on
 * the manager's page (`decisionRoute`, `decisionHref`, `parseFleetDecision`, the finder's rows), and what a
 * fleet's page in the manager's frame tells it (`parseEmbedMessage`).
 */
import { expect, test } from "bun:test";

import { Core, type Decision, type Message } from "../src/core.ts";
import { parseEmbedMessage } from "../src/embed.ts";
import { managerView } from "./fixtures.ts";

const item = (id: string, extra: Partial<Decision> = {}): Decision => ({ id, kind: "decision", title: "T" + id, question: "q", status: "open", blocking: false, asks: "user", options: [], opened: "2026-09-28T10:00:00Z", ...extra });

const DECISIONS: Decision[] = [
  item("d1", { opened: "2026-09-28T10:05:00Z" }),
  item("d2", { status: "decided", closed: "2026-09-28T11:00:00Z" }),
  item("d3", { asks: "manager" }),
  item("billing/d1", { fleet: "billing", blocking: true, opened: "2026-09-28T10:30:00Z" }),
  item("infra/d4", { fleet: "infra", opened: "2026-09-28T10:01:00Z" }),
  item("billing/d2", { fleet: "billing", answered: "2026-09-28T10:40:00Z", opened: "2026-09-28T10:02:00Z" }),
];

const WAITED = ["billing/d1", "infra/d4", "d1"];

test("the queue is what waits on the user, in the order of the Waits on you list", () => {
  const listed = Core.decisionRows(DECISIONS, null)
    .filter((r) => Core.bucketOf(r.item, []) === "active")
    .map((r) => r.item.id);

  expect(Core.queueOf(DECISIONS, [], null).ids).toEqual(listed);
  expect(listed).toEqual(WAITED);
});

test("a decision in the queue: its place and the ones on either side", () => {
  expect(Core.queueOf(DECISIONS, [], "infra/d4")).toEqual({ ids: WAITED, at: 2, prev: "billing/d1", next: "d1" });
  expect(Core.queueOf(DECISIONS, [], "billing/d1")).toMatchObject({ at: 1, prev: null, next: "infra/d4" });
  expect(Core.queueOf(DECISIONS, [], "d1")).toMatchObject({ at: 3, prev: "infra/d4", next: null });
});

test("an answered decision still open keeps its place in the order: the next is the one after it", () => {
  const answered = DECISIONS.map((d) => (d.id === "infra/d4" ? { ...d, answered: "2026-09-28T10:50:00Z" } : d));
  expect(Core.queueOf(answered, [], "infra/d4")).toEqual({ ids: ["billing/d1", "d1"], at: 0, prev: "billing/d1", next: "d1" });
  const sent: Message = { id: 1, at: "2026-09-28T10:51:00Z", from: "user", to: ["coordinator"], text: "a", re: null, parts: [], decision: "d1", author: "", quote: null, side: null };
  expect(Core.queueOf(DECISIONS, [sent], "d1")).toMatchObject({ ids: ["billing/d1", "infra/d4"], at: 0, prev: "infra/d4", next: null });
});

test("a decision decided since: its neighbours are the ones around where it waited", () => {
  const decided = DECISIONS.map((d) => (d.id === "d1" ? { ...d, status: "decided", closed: "2026-09-28T11:30:00Z" } : d));
  const waited = ["billing/d1", "d1", "infra/d4"];
  expect(Core.queueOf(decided, [], "d1", waited)).toEqual({ ids: ["billing/d1", "infra/d4"], at: 0, prev: "billing/d1", next: "infra/d4" });
  expect(Core.queueOf(decided, [], "d1")).toMatchObject({ prev: null, next: "billing/d1" });
});

test("a fleet's decision gone from the manager's state: its neighbours are the ones around where it waited", () => {
  const gone = DECISIONS.filter((d) => d.id !== "infra/d4");
  expect(Core.queueOf(gone, [], "infra/d4", WAITED)).toEqual({ ids: ["billing/d1", "d1"], at: 0, prev: "billing/d1", next: "d1" });
  expect(Core.queueOf(gone.filter((d) => d.id !== "d1"), [], "infra/d4", WAITED)).toMatchObject({ prev: "billing/d1", next: null });
});

test("a decision that does not wait and never waited here, or none, starts the queue at its first", () => {
  expect(Core.queueOf(DECISIONS, [], "billing/d9", WAITED)).toMatchObject({ at: 0, prev: null, next: "billing/d1" });
  expect(Core.queueOf(DECISIONS, [], "d2")).toMatchObject({ at: 0, prev: null, next: "billing/d1" });
  expect(Core.queueOf(DECISIONS, [], null)).toMatchObject({ at: 0, prev: null, next: "billing/d1" });
  expect(Core.queueOf([], [], null)).toEqual({ ids: [], at: 0, prev: null, next: null });
});

test("decisionRoute: <fleet>/<id> names a fleet's decision on a manager's page only", () => {
  expect(Core.decisionRoute("#decision/billing/d1", true)).toBe("billing/d1");
  expect(Core.decisionRoute("#decision/ui@box/d1", true)).toBe("ui@box/d1");
  expect(Core.decisionRoute("#decision/ui%40box/d1", true)).toBe("ui@box/d1");
  expect(Core.decisionRoute("#decision/d1", true)).toBe("d1");
  expect(Core.decisionRoute("#decision/d1")).toBe("d1");
  expect(Core.decisionRoute("#decision/billing/d1")).toBeNull();

  for (const hash of ["#decision/a/b/c", "#decision/a/", "#decision//b", "#decision/a b/c", "#decision/a@b", "#decision/a%2/b", "#decision/a/b%2Fc"]) expect([hash, Core.decisionRoute(hash, true)]).toEqual([hash, null]);
  expect(Core.viewOf("#decision/billing/d1", true)).toEqual({ view: "decisions", decision: "billing/d1", anchor: null });
  expect(Core.viewOf("#decision/billing/d1")).toEqual({ view: "decisions", decision: null, anchor: null });
});

test("decisionHref: each segment encoded, so <fleet>/<id> stays a route", () => {
  expect(Core.decisionHref("d1")).toBe("#decision/d1");
  expect(Core.decisionHref("ui@box/d1")).toBe("#decision/ui%40box/d1");

  for (const id of ["d1", "billing/d1", "ui@box/schema.v2-a"]) expect(Core.decisionRoute(Core.decisionHref(id), true)).toBe(id);
});

test("parseFleetDecision: the fleet and its own id, for a decision another fleet holds", () => {
  expect(Core.parseFleetDecision("billing/d1")).toEqual({ fleet: "billing", id: "d1" });
  expect(Core.parseFleetDecision("d1")).toBeNull();
  expect(Core.parseFleetDecision(null)).toBeNull();
});

test("the finder opens a fleet's decision on the manager's own page", () => {
  const state = Core.parseState(managerView(Date.now()));

  if (!state) throw new Error("the fixture is not a state");
  const rows = Core.findRows(state, []).filter((r) => r.hint.startsWith("billing"));
  expect(rows.map((r) => r.go)).toEqual([{ kind: "decision", id: "billing/d1" }]);
});

test("parseEmbedMessage: a frame's height or an answer it sent, anything else nothing", () => {
  expect(parseEmbedMessage({ fleetEmbed: true, height: 640.4 })).toEqual({ kind: "height", height: 640.4 });
  expect(parseEmbedMessage({ fleetEmbed: true, answered: "d1" })).toEqual({ kind: "answered", id: "d1" });

  for (const data of [null, undefined, "x", [], { height: 3 }, { fleetEmbed: true }, { fleetEmbed: true, height: -1 }, { fleetEmbed: true, height: "3" }, { fleetEmbed: true, answered: "" }, { fleetEvidence: true, height: 3 }]) expect(parseEmbedMessage(data)).toBeNull();
});

test("parseEmbedMessage: a selection in the frame, its place and where it is; cleared, no place", () => {
  const rect = { top: 10, bottom: 28, left: 4.5, width: 80 };
  expect(parseEmbedMessage({ fleetEmbed: true, select: { text: "per line", rect, from: "Rounding" } })).toEqual({ kind: "select", text: "per line", rect, from: "Rounding" });
  expect(parseEmbedMessage({ fleetEmbed: true, select: { text: "", rect: null, from: "" } })).toEqual({ kind: "select", text: "", rect: null, from: "" });

  for (const select of [null, "per line", { text: 3, rect, from: "" }, { text: "x", rect: null, from: "" }, { text: "x", rect: { ...rect, top: "10" }, from: "" }, { text: "x", rect: { top: 1, bottom: 2, left: 3 }, from: "" }, { text: "x", rect, from: null }])
    expect(parseEmbedMessage({ fleetEmbed: true, select })).toBeNull();
});
