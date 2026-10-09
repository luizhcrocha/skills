/**
 * The finder's matching and layout (src/find.ts), pure: words folded for case and accents, every word must
 * hit, a word's start beats its inside, a short word's letters in order rank last, a ref typed whole first;
 * the prefixes; the sections in their fixed order, five rows each and a "show more", the recents first.
 */
import { expect, test } from "bun:test";

import { Core, type FindRow, type Go } from "../src/core.ts";
import { arrange, countsOf, cycleTab, fold, GROUPS, highlight, rank, readPrefix, tabsOf, type Section } from "../src/find.ts";
import type { Recent } from "../src/recents.ts";

/** A row of `group`, titled `title`. */
function row(group: string, title: string, more: Partial<FindRow> = {}): FindRow {
  const go: Go = { kind: "view", hash: "#" + group };

  return { key: group + ":" + title, group, ref: "", title, sub: "", hint: "", pill: "", go, ...more };
}

const titles = (rows: readonly { readonly row: FindRow }[]): string[] => rows.map((h) => h.row.title);

/** A section's rows' titles, its "show more" as "+n", its hints as "d: Decisions 3". */
const drawn = (s: Section): string[] => s.items.map((i) => (i.kind === "row" ? i.row.title : i.kind === "more" ? "+" + String(i.n) : `${i.prefix}: ${i.heading} ${String(i.n)}`));

test("fold: lower case, accents stripped, one character for one, so a match's offsets are the title's", () => {
  expect(fold("Petição Inicial")).toBe("peticao inicial");
  expect(fold("ÉTÉ")).toBe("ete");
  expect(fold("Ünïcödé x").length).toBe("Ünïcödé x".length);
});

test("case and accents are ignored both ways, and the match is marked on the title as written", () => {
  const hits = rank([row("plan", "Petição inicial")], "PETICAO");
  expect(titles(hits)).toEqual(["Petição inicial"]);
  expect(hits[0]?.ranges).toEqual([[0, 7]]);
  expect(titles(rank([row("plan", "Peticao inicial")], "petição"))).toEqual(["Peticao inicial"]);
});

test("every word must hit, in the title, the ref or the second line", () => {
  const rows = [row("decisions", "Rounding rule for totals", { ref: "D1", sub: "Per line or on the total?" }), row("decisions", "Rounding of taxes")];
  expect(titles(rank(rows, "rounding totals"))).toEqual(["Rounding rule for totals"]);
  expect(titles(rank(rows, "rounding per line"))).toEqual(["Rounding rule for totals"]);
  expect(titles(rank(rows, "d1 rounding"))).toEqual(["Rounding rule for totals"]);
  expect(titles(rank(rows, "rounding cents"))).toEqual([]);
});

test("a word at the title's start beats one at a word's start, which beats one inside a word", () => {
  const rows = [row("plan", "Subtotals check"), row("plan", "Check the totals"), row("plan", "Totals in cents")];
  expect(titles(rank(rows, "total"))).toEqual(["Totals in cents", "Check the totals", "Subtotals check"]);
});

test("a hit in the title beats one in the second line", () => {
  const rows = [row("plan", "Invoice generator", { sub: "Stripe" }), row("plan", "Stripe adapter")];
  expect(titles(rank(rows, "stripe"))).toEqual(["Stripe adapter", "Invoice generator"]);
});

test("one short word may match letters in order, ranked after every real hit; never two words or a long one", () => {
  const rows = [row("plan", "Invoice generator"), row("plan", "Ivgen tool")];
  const hits = rank(rows, "ivg");
  expect(titles(hits)).toEqual(["Ivgen tool", "Invoice generator"]);
  expect(hits[1]?.ranges).toEqual([
    [0, 1],
    [2, 3],
    [8, 9],
  ]);
  expect(titles(rank(rows, "invgen"))).toEqual([]);
  expect(titles(rank(rows, "ivg tool"))).toEqual(["Ivgen tool"]);
});

test("a ref typed whole comes first, before any title that holds it", () => {
  const rows = [row("chat", "about d3 and more"), row("decisions", "Two more passes", { ref: "D3" })];
  expect(titles(rank(rows, "D3"))).toEqual(["Two more passes", "about d3 and more"]);
});

test("ties: named things alphabetical, the chat and the log newest first (their order)", () => {
  expect(titles(rank([row("plan", "Notes zeta"), row("plan", "Notes alfa")], "notes"))).toEqual(["Notes alfa", "Notes zeta"]);
  expect(titles(rank([row("chat", "notes zeta"), row("chat", "notes alfa")], "notes"))).toEqual(["notes zeta", "notes alfa"]);
});

test("a kind weighs a little: of two equal hits the decision before the log line", () => {
  expect(titles(rank([row("log", "Stripe key"), row("decisions", "Stripe key")], "stripe")).length).toBe(2);
  expect(rank([row("log", "Stripe key"), row("decisions", "Stripe key")], "stripe").map((h) => h.row.group)).toEqual(["decisions", "log"]);
});

test("the rows a fleet's state gives, as the finder always found them", () => {
  const state = Core.parseState({
    project: "p",
    goal: "g",
    status: "running",
    now: "",
    started: "2026-10-01T09:00:00Z",
    decisions: [
      { id: "d-cuts", ref: "D3", title: "Two more passes", question: "Run both now?", status: "open", kind: "decision" },
      { id: "d-key", ref: "A1", title: "Rotate the key", question: "q", status: "decided", answer: "done", kind: "action" },
    ],
    links: [{ id: "l1", ref: "L1", title: "Lab review", url: "https://b.ts.net:47843/", kind: "page", up: true }],
    roadmap: [{ id: "m1", title: "Deploy", steps: [{ id: "l19", title: "Watchdog counts per file", status: "current" }] }],
    agents: [{ id: "b41", name: "audio-research", task: "Audio intelligence", status: "done" }],
    events: [{ at: "2026-10-01T10:00:00Z", kind: "note", text: "passes ran" }],
  });

  if (!state) throw new Error("not a state");
  const rows = Core.findRows(state, [{ id: 9, at: "2026-10-01T10:00:00Z", from: "user", to: [], text: "run both passes", author: "luiz", parts: [], re: null, decision: "", quote: null, side: null }]);
  expect(rank(rows, "D3")[0]?.row.title).toBe("Two more passes");
  expect(rank(rows, "watchdog file")[0]?.row.ref).toBe("l19");
  expect(rank(rows, "nothing like this")).toEqual([]);
  expect(rows.find((r) => r.ref === "A1")?.pill).toBe("action");
  expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
});

test("readPrefix: a letter and a colon narrow to a kind; anything else is words", () => {
  expect(readPrefix("d:fix")).toEqual({ group: "decisions", words: "fix" });
  expect(readPrefix("D: fix it")).toEqual({ group: "decisions", words: "fix it" });
  expect(readPrefix("w:")).toEqual({ group: "workers", words: "" });
  expect(readPrefix("g:spawned")).toEqual({ group: "log", words: "spawned" });
  expect(readPrefix("x:fix")).toEqual({ group: null, words: "x:fix" });
  expect(readPrefix("d fix")).toEqual({ group: null, words: "d fix" });
  expect(readPrefix("@a2")).toEqual({ group: null, words: "@a2" });
  expect(readPrefix("/tdd")).toEqual({ group: null, words: "/tdd" });

  for (const g of GROUPS) expect(readPrefix(g.prefix + ":").group).toBe(g.key);
  expect(new Set(GROUPS.map((g) => g.prefix)).size).toBe(GROUPS.length);
});

test("highlight: the title cut into its matched and unmatched parts", () => {
  expect(highlight("Rounding rule", [[0, 5]])).toEqual([
    { text: "Round", hit: true },
    { text: "ing rule", hit: false },
  ]);
  expect(highlight("abc", [])).toEqual([{ text: "abc", hit: false }]);
});

/** A recent of `r`, visited `ago` minutes back. */
const recent = (r: FindRow, ago: number): Recent => ({ ...r, at: 1_000_000 - ago * 60_000 });

/** The row at `i` of ROWS. */
const nth = (i: number): FindRow => {
  const r = ROWS[i];

  if (!r) throw new Error("no row " + String(i));

  return r;
};

/** Section `i` of `sections`. */
const sec = (sections: readonly Section[], i: number): Section => {
  const s = sections[i];

  if (!s) throw new Error("no section " + String(i));

  return s;
};

const ROWS: FindRow[] = [
  row("decisions", "Rounding rule", { key: "d:d1", ref: "D1" }),
  row("decisions", "Stripe key", { key: "d:s1", ref: "S1" }),
  ...["Research", "Generator", "Adapter", "Notes", "Docs", "Load"].map((t) => row("plan", "Step " + t)),
  row("workers", "invoice-gen", { key: "w:a2" }),
  row("chat", "Step by step, please"),
];

test("an empty query: the places opened last, the one shown now left out, then a row per kind to narrow to", () => {
  const recents = [recent(nth(0), 1), recent(nth(8), 2), recent({ ...row("views", "Plan"), key: "v:plan" }, 3)];
  const s = arrange({ rows: ROWS, recents, query: "", tab: "", more: new Set(), here: "v:plan" });
  expect(s.map((x) => x.id)).toEqual(["recents", "hints"]);
  expect(drawn(sec(s, 0))).toEqual(["Rounding rule", "invoice-gen"]);
  expect(drawn(sec(s, 1))).toEqual(["d: Decisions 2", "w: Workers 1", "p: Plan 6", "c: Chat 1"]);
});

test("nothing opened yet: only the kinds", () => {
  expect(arrange({ rows: ROWS, recents: [], query: "", tab: "", more: new Set(), here: null }).map((x) => x.id)).toEqual(["hints"]);
});

test("a query: the recents that match (three at most), then each kind in its fixed order, five rows and a show more; a recent is not drawn twice", () => {
  const recents = [recent(nth(3), 1)];
  const s = arrange({ rows: ROWS, recents, query: "step", tab: "", more: new Set(), here: null });
  expect(s.map((x) => x.id)).toEqual(["recents", "plan", "chat"]);
  expect(drawn(sec(s, 0))).toEqual(["Step Generator"]);
  expect(drawn(sec(s, 1))).toEqual(["Step Adapter", "Step Docs", "Step Load", "Step Notes", "Step Research"]);
  expect(drawn(sec(s, 2))).toEqual(["Step by step, please"]);

  const all = arrange({ rows: ROWS, recents: [], query: "step", tab: "", more: new Set(), here: null });
  expect(drawn(sec(all, 0))).toEqual(["Step Adapter", "Step Docs", "Step Generator", "Step Load", "Step Notes", "+1"]);
  const more = arrange({ rows: ROWS, recents: [], query: "step", tab: "", more: new Set(["plan"]), here: null });
  expect(drawn(sec(more, 0))).toHaveLength(6);
  expect(GROUPS.map((g) => g.key)).toEqual(["decisions", "approvals", "coordinators", "roadblocks", "workers", "plan", "chat", "links", "log"]);
});

test("a tab: that kind alone, every row up to fifty, with or without words; no recents", () => {
  const s = arrange({ rows: ROWS, recents: [recent(nth(3), 1)], query: "", tab: "plan", more: new Set(), here: null });
  expect(s.map((x) => x.id)).toEqual(["plan"]);
  expect(drawn(sec(s, 0))).toHaveLength(6);
  const many = Array.from({ length: 60 }, (_, i) => row("log", "line " + String(i)));
  expect(drawn(sec(arrange({ rows: many, recents: [], query: "line", tab: "log", more: new Set(), here: null }), 0)).at(-1)).toBe("+10");
});

test("a recent takes the row's words as they are now, and a place gone keeps the words it had", () => {
  const was = recent({ ...(nth(0)), title: "Rounding (old title)" }, 1);
  const gone = recent(row("workers", "retired-worker", { key: "w:old" }), 2);
  const s = arrange({ rows: ROWS, recents: [was, gone], query: "", tab: "", more: new Set(), here: null });
  expect(drawn(sec(s, 0))).toEqual(["Rounding rule", "retired-worker"]);
});

test("the tabs: All, then each kind the page holds; Tab and Shift+Tab go round", () => {
  const tabs = tabsOf(ROWS);
  expect(tabs).toEqual(["", "decisions", "workers", "plan", "chat"]);
  expect(cycleTab(tabs, "", 1)).toBe("decisions");
  expect(cycleTab(tabs, "chat", 1)).toBe("");
  expect(cycleTab(tabs, "", -1)).toBe("chat");
  expect(cycleTab(tabs, "links", 1)).toBe("decisions");
});

test("the rail's counts: the rows of each kind the words find, whatever the tab; All the sum", () => {
  expect([...countsOf(ROWS, "")]).toEqual([["", 10], ["decisions", 2], ["workers", 1], ["plan", 6], ["chat", 1]]);
  expect([...countsOf(ROWS, "step")]).toEqual([["", 7], ["decisions", 0], ["workers", 0], ["plan", 6], ["chat", 1]]);
});
