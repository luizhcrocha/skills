/**
 * The manager's quick filter by agent (`scopes`, `narrow`, `held`): who an open decision is for, counted,
 * and the list narrowed to one of them, with no DOM.
 */
import { expect, test } from "bun:test";

import type { Decision } from "../src/core.ts";
import { ALL, held, narrow, NO_AGENT, scopeOf, scopes } from "../src/scope.ts";

const item = (id: string, extra: Partial<Decision> = {}): Decision => ({ id, kind: "decision", title: "T" + id, question: "q", status: "open", blocking: false, asks: "user", options: [], ...extra });

const DECISIONS: Decision[] = [
  item("d1"),
  item("d2", { agent: "a7" }),
  item("d3", { status: "decided" }),
  item("d4", { agent: "a7", status: "withdrawn" }),
  item("billing/d1", { fleet: "billing", agent: "a2" }),
  item("billing/d2", { fleet: "billing" }),
  item("infra/d4", { fleet: "infra" }),
  item("site/d10", { fleet: "site" }),
  item("site/d2", { fleet: "site" }),
];

test("a fleet's decision is that fleet's, whatever worker it names; the manager's own is its worker's, or no agent's", () => {
  expect(scopeOf(item("billing/d1", { fleet: "billing", agent: "a2" }))).toBe("fleet:billing");
  expect(scopeOf(item("d2", { agent: "a7" }))).toBe("agent:a7");
  expect(scopeOf(item("d1"))).toBe(NO_AGENT);
  expect(scopeOf(item("d1", { agent: "" }))).toBe(NO_AGENT);
});

test("one scope per agent with an open decision, counted, in name order, the decisions with no agent last", () => {
  expect(scopes(DECISIONS)).toEqual([
    { key: "agent:a7", agent: "a7", fleet: false, count: 1 },
    { key: "fleet:billing", agent: "billing", fleet: true, count: 2 },
    { key: "fleet:infra", agent: "infra", fleet: true, count: 1 },
    { key: "fleet:site", agent: "site", fleet: true, count: 2 },
    { key: NO_AGENT, agent: null, fleet: false, count: 1 },
  ]);
});

test("a fleet and a worker of the same name are two scopes", () => {
  expect(scopes([item("x/d1", { fleet: "x" }), item("d2", { agent: "x" })]).map((s) => s.key)).toEqual(["agent:x", "fleet:x"]);
});

test("nothing open, no scope", () => {
  expect(scopes([item("d1", { status: "decided" })])).toEqual([]);
  expect(scopes([])).toEqual([]);
});

test("narrowing keeps one scope's decisions in their order, closed ones too; all keeps every one", () => {
  expect(narrow(DECISIONS, "fleet:site").map((d) => d.id)).toEqual(["site/d10", "site/d2"]);
  expect(narrow(DECISIONS, "agent:a7").map((d) => d.id)).toEqual(["d2", "d4"]);
  expect(narrow(DECISIONS, NO_AGENT).map((d) => d.id)).toEqual(["d1", "d3"]);
  expect(narrow(DECISIONS, ALL)).toEqual(DECISIONS);
});

test("a chosen scope holds while it has an open decision; once it has none, or never existed, it is all", () => {
  const list = scopes(DECISIONS);
  expect(held(list, "fleet:infra")).toBe("fleet:infra");
  expect(held(list, ALL)).toBe(ALL);
  expect(held(list, "fleet:gone")).toBe(ALL);
  expect(held(scopes(DECISIONS.filter((d) => d.id !== "infra/d4")), "fleet:infra")).toBe(ALL);
  expect(held(list, 42)).toBe(ALL);
  expect(held(list, null)).toBe(ALL);
});
