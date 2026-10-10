/**
 * Comments on the words the dashboard draws (src/fields.ts): the fields a quote may name, each said in
 * words; the claim of words in a field (their context, their white space trimmed); its quote; a stored mark
 * keeping its field (and dropping one it may not name); the batch's Markdown saying where the words were; and
 * what the fleet's page and the manager's tell each other of them, rebuilt and checked.
 */
import { expect, test } from "bun:test";

import { Core } from "../src/core.ts";
import { claimOf, fieldHint, fieldQuote, isField } from "../src/fields.ts";
import { parseEmbedMessage, parseFieldPaints } from "../src/embed.ts";
import { makeBatch } from "../src/marks.ts";

test("the fields a quote may name, and nothing else", () => {
  for (const f of ["title", "question", "why", "step", "recommendation", "option:B", "option:a-1:consequence", "history:3"]) expect(isField(f)).toBe(true);

  for (const f of ["", "body", "option:", "option:B:label", "history:0", "history:x", "step:2", "question "]) expect(isField(f)).toBe(false);
});

test("each field said in words, as a hint", () => {
  expect(["title", "question", "why", "step", "recommendation", "option:B", "option:B:consequence", "history:2"].map(fieldHint)).toEqual(["the title", "the question", "why it needs you", "manual step", "the recommendation", "option B", "option B's consequence", "history, line 2"]);
});

test("a claim is the words with up to 32 characters of the field's text each side, white space at its ends left out", () => {
  const text = "Run it from the infra checkout: cd servers/infra; secretspec run -- tasks/deploy-worker, then tell me.";
  const start = text.indexOf("cd servers");
  const end = text.indexOf(", then");

  expect(claimOf("step", text, start - 1, end + 1)).toEqual({ field: "step", exact: "cd servers/infra; secretspec run -- tasks/deploy-worker,", prefix: text.slice(start - 32, start), suffix: " then tell me." });
  expect(claimOf("step", text, 3, 3)).toBeNull();
  expect(claimOf("step", "a   b", 1, 4)).toBeNull();
  expect(claimOf("nowhere", text, 0, 4)).toBeNull();
});

test("its quote names the field and says it in words; a stored mark keeps a field it may name and drops one it may not", () => {
  const q = fieldQuote({ field: "option:B:consequence", exact: "tell me\nwhat", prefix: "p", suffix: "s" });

  expect(q).toEqual({ text: "tell me what", prefix: "p", suffix: "s", hint: "option B's consequence", blocks: [{ exact: "tell me\nwhat", prefix: "p", suffix: "s" }], field: "option:B:consequence" });
  expect(Core.parseMarkItem({ n: 1, kind: "comment", quote: JSON.parse(JSON.stringify(q)), comment: "c" })?.quote?.field).toBe("option:B:consequence");
  expect(Core.parseMarkItem({ n: 1, kind: "comment", quote: { ...JSON.parse(JSON.stringify(q)), field: "body" }, comment: "c" })?.quote?.field).toBeUndefined();

  const md = makeBatch({ id: "l220", title: "Deploy", revision: "r" }, "#decision/l220", [{ item: { n: 1, kind: "comment", quote: fieldQuote({ field: "step", exact: "secretspec run", prefix: "", suffix: "" }), comment: "use the tier" }, outdated: false }]);

  expect(md.text).toContain("1. [#1] **Comment** on “secretspec run” (manual step)");
  expect(md.marks.items[0]?.quote?.field).toBe("step");
});

test("the fleet's page tells the manager's of words in a field, and is told its field marks, each rebuilt and checked", () => {
  const select = { fleetEmbed: true, select: { text: "secretspec run", rect: { top: 1, bottom: 2, left: 1, width: 9 }, from: "L220", touch: false, at: { hash: "#decision/l220" }, field: { field: "step", exact: "secretspec run", prefix: "cd x; ", suffix: " -- y", extra: 1 } } };

  expect(parseEmbedMessage(select)).toMatchObject({ kind: "select", field: { field: "step", exact: "secretspec run", prefix: "cd x; ", suffix: " -- y" } });
  expect(parseEmbedMessage({ ...select, select: { ...select.select, field: { field: "body", exact: "x", prefix: "", suffix: "" } } })).not.toHaveProperty("field");
  expect(parseEmbedMessage({ fleetEmbed: true, fieldTap: "m:3" })).toEqual({ kind: "fieldTap", id: "m:3" });
  expect(parseEmbedMessage({ fleetEmbed: true, fieldTap: "d3" })).toBeNull();

  const paint = { id: "m:1", n: 1, field: "option:B:consequence", kind: "question", blocks: [{ exact: "what", prefix: "", suffix: "" }], status: "pending", unread: true, active: false } as const;

  expect(parseFieldPaints({ annotFields: true, marks: [paint, { ...paint, id: "m:2", field: "nowhere" }, { ...paint, id: "m:3", status: "lost" }, { ...paint, id: "m:4", kind: "general" }] })).toEqual([paint]);
  expect(parseFieldPaints({ annotPaint: true, marks: [paint] })).toBeNull();
});
