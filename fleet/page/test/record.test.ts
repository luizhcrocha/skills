/**
 * The finder's record pane (src/record.ts), pure: what the highlighted row's record says, per kind, from the
 * page's state as it is now: a decision's question, options with the recommended one, status and who it is
 * for; a worker's status, task and lane; a message with the one before and after it; a plan step's milestone
 * and status; a link's address and whether it answers; and the Ctrl/⌘+Enter action's words, none when it
 * does what Enter does.
 */
import { expect, test } from "bun:test";

import { Core, type FindRow, type Message, type State } from "../src/core.ts";
import { recordOf } from "../src/record.ts";
import { coordinatorChat, coordinatorView } from "./fixtures.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

const state = ((): State => {
  const s = Core.parseState(coordinatorView(NOW));

  if (!s) throw new Error("the fixture is not a state");

  return s;
})();

const messages: Message[] = coordinatorChat(NOW).flatMap((m) => Core.parseMessage(JSON.parse(JSON.stringify(m))) ?? []);

const rows = Core.findRows(state, messages);

/** The row of `key`. */
function row(key: string): FindRow {
  const r = rows.find((x) => x.key === key);

  if (!r) throw new Error("no row " + key);

  return r;
}

const facts = (key: string): Record<string, string> => Object.fromEntries(recordOf(row(key), state, messages).facts.map((f) => [f.label, f.value]));

test("a decision: its question, its options with the recommended one, its status and who it is for", () => {
  const r = recordOf(row("d:d1"), state, messages);
  expect(r).toMatchObject({ kind: "Decision", ref: "D1", title: "Rounding rule for totals", lead: "How should invoice totals round: per line or on the total?" });
  expect(r.pills.map((p) => p.text)).toEqual(["open", "blocking"]);
  expect(r.options).toEqual([
    { id: "a", label: "Round each line", recommended: false },
    { id: "b", label: "Round the total", recommended: true },
  ]);
  expect(facts("d:d1")).toMatchObject({ For: "you", "Raised by": "invoice-gen" });
  expect(r.second).toBe("New tab");
});

test("an action decided: its kind, its answer", () => {
  const r = recordOf(row("d:a7"), state, messages);
  expect(r.kind).toBe("Action");
  expect(r.pills.map((p) => p.text)).toEqual(["decided"]);
  expect(facts("d:a7")["Answer"]).toBe("Done.");
});

test("a worker: its status, its task, its lane", () => {
  const r = recordOf(row("w:a2"), state, messages);
  expect(r).toMatchObject({ kind: "Worker", title: "invoice-gen", lead: "Generate invoices from the ledger and post them to Stripe" });
  expect(r.pills).toEqual([{ text: "running", tone: "running" }]);
  expect(facts("w:a2")).toMatchObject({ Lane: "src/invoices/, test/invoices/", Milestone: "Generate and post", Model: "opus" });
  expect(facts("w:a1")["Lane"]).toBe("none");
});

test("a message: the one before and after it, in its own conversation", () => {
  const r = recordOf(row("c:3"), state, messages);
  expect(r.thread.map((l) => [l.id, l.who, l.hit])).toEqual([
    [2, "coordinator", false],
    [3, "you", true],
    [4, "invoice-gen", false],
  ]);
  expect(r.second).toBeNull();
  expect(recordOf(row("c:5"), state, messages).thread.map((l) => l.id)).toEqual([4, 5]);
});

test("a plan step: its milestone and its status", () => {
  const r = recordOf(row("p:m2/s3"), state, messages);
  expect(r).toMatchObject({ kind: "Plan step", ref: "s3", title: "Stripe adapter" });
  expect(r.pills).toEqual([{ text: "blocked", tone: "blocked" }]);
  expect(facts("p:m2/s3")).toMatchObject({ Milestone: "Generate and post", Worker: "stripe.adapter" });
});

test("a link: its address and whether it answers", () => {
  expect(facts("u:https://example.ts.net:8443/preview/")).toMatchObject({ Address: "https://example.ts.net:8443/preview/", Answers: "yes" });
  expect(facts("u:http://127.0.0.1:5173/")["Answers"]).toBe("no");
  expect(recordOf(row("u:http://127.0.0.1:5173/"), state, messages).pills).toEqual([{ text: "down", tone: "failed" }]);
});

test("a roadblock and a log line say what the row knows; a place gone keeps the row's own words", () => {
  expect(recordOf(row("r:r1"), state, messages)).toMatchObject({ kind: "Roadblock", lead: "The adapter cannot call the 2026-09 API without a restricted key." });
  const gone: FindRow = { key: "d:zz", group: "decisions", ref: "D9", title: "Gone", sub: "What it asked", hint: "open", pill: "", go: { kind: "decision", id: "zz" } };
  expect(recordOf(gone, state, messages)).toMatchObject({ kind: "Decision", ref: "D9", title: "Gone", lead: "What it asked" });
});
