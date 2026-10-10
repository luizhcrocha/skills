/**
 * A batch of comments as the chat names it (src/marks.ts `batchHead`, src/chatlog.ts `sideSummaries`): its
 * head from the structured marks, and the side chat a batch opened (a decision page's thread) titled by it,
 * about its decision, never by the batch's Markdown.
 */
import { expect, test } from "bun:test";

import { sideSummaries } from "../src/chatlog.ts";
import { Core, type Json, type Message } from "../src/core.ts";
import { batchHead } from "../src/marks.ts";

const msg = (fields: { [key: string]: Json }): Message => {
  const m = Core.parseMessage({ at: "2026-10-10T12:00:00Z", to: [], ...fields });

  if (!m) throw new Error("not a message");

  return m;
};

const marks = (n: number) => ({ decision: { id: "l220", ref: "L220", title: "Deploy", revision: "r" }, at: { hash: "#decision/infra/l220" }, items: Array.from({ length: n }, (_, i) => ({ n: i + 1, kind: "comment", quote: { text: "nu", prefix: "", suffix: "", hint: "manual step", blocks: [{ exact: "nu", prefix: "", suffix: "" }], field: "step" }, comment: "c" })), to: "infra" });

test("a batch's head: how many comments, on which decision", () => {
  expect(batchHead(Core.parseMarks(marks(1)) ?? { decision: { id: "x", title: "", revision: "" }, at: { hash: "#x" }, items: [] })).toBe("1 comment on L220");
  expect(Core.parseMarks(marks(3))?.to).toBe("infra");
  expect(batchHead(Core.parseMarks(marks(3)) ?? { decision: { id: "x", title: "", revision: "" }, at: { hash: "#x" }, items: [] })).toBe("3 comments on L220");
});

test("the side chat a batch opened is titled by the batch and about its decision, not by its Markdown", () => {
  const all = [msg({ id: 5, from: "user", text: "**Marks on L220**: Deploy\n\n1. [#1] **Comment** on “nu” (manual step)", marks: marks(2) }), msg({ id: 6, from: "infra", text: "Tier 1, done.", side: 5 })];
  const [s] = sideSummaries(all, () => 0);

  expect(s?.title).toBe("2 comments on L220");
  expect(s?.decision).toBe("infra/l220");
  expect(s?.unread).toBe(1);
});
