/**
 * When the page's comments go out (src/autosend.ts), through its interface: the quiet timer (a save
 * restarts it, editing holds it, a tick past it sends), each trigger (leaving, answering, Send now, quiet),
 * a failed send tried again later; the one batch per decision with its @-cites in its Markdown and the
 * conversations' messages after it; the answer's ride-along; the page-exit send (keepalive up to its budget,
 * plain past it); and what waits, kept in the browser under 1.9.33's drafts key, with a storage that throws.
 */
import { expect, test } from "bun:test";

import { answerBody, autoStep, citesOf, clock, countOf, exitPosts, IDLE, KEEPALIVE_MAX, leftOf, loadPending, NONE, pageQuote, owing, perRecipient, planSend, QUIET_MS, QUIET_WORDS, running, savePending, sentWords, without, type Auto, type AutoEvent, type Pending, type SendReason } from "../src/autosend.ts";
import type { MarkDecision, MarkItem, RosterRow } from "../src/core.ts";
import { draftsKey, saveDrafts, type DraftStore } from "../src/marks.ts";

const T0 = Date.parse("2026-10-10T12:00:00Z");

const D30: MarkDecision = { id: "d30", ref: "D30", title: "Benchmark architecture", revision: "2026-10-10T10:28:40Z" };

const quote = (text: string) => ({ text, prefix: "", suffix: "", hint: "under “The idea” · a paragraph", blocks: [{ exact: text, prefix: "", suffix: "" }] });

const item = (n: number, comment: string): MarkItem => ({ n, kind: "comment", quote: quote("Every model call is saved"), comment });

const ROSTER: RosterRow[] = [
  { id: "coordinator", name: "coordinator", status: "", task: "" },
  { id: "a1", name: "skills", status: "running", task: "" },
  { id: "a2", name: "casos", status: "", task: "" },
];

/** The decision's owner on a fleet's page (its host) and who can be cited. */
const WHO = { owner: "coordinator", host: "coordinator", roster: ROSTER, next: 100, known: new Map<number, MarkItem>() } as const;

/** A store in memory, or one whose every call throws (a private window, blocked site data). */
function memory(): DraftStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();

  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

const broken: DraftStore = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

/** Where a run of events left the auto-send, and the sends it asked for, in order. */
interface Ran {
  readonly auto: Auto;
  readonly sends: (readonly [number, SendReason])[];
}

/** Run events through the auto-send from `a`, each at its time. */
function run(a: Auto, events: readonly (readonly [number, AutoEvent])[]): Ran {
  let auto = a;
  const sends: (readonly [number, SendReason])[] = [];

  for (const [at, e] of events) {
    const out = autoStep(auto, e, at);
    auto = out.auto;

    if (out.send) sends.push([at, out.send]);
  }

  return { auto, sends };
}

const tick = { _tag: "tick" } as const;

const saved = { _tag: "saved" } as const;

test("the quiet period is 3 minutes after a save, said as m:ss", () => {
  const t = running(T0);

  expect(QUIET_MS).toBe(180_000);
  expect(QUIET_WORDS).toBe("3 min");
  expect(leftOf(t, T0)).toBe(QUIET_MS);
  expect(clock(leftOf(t, T0 + 2_000) ?? 0)).toBe("2:58");
  expect(leftOf(IDLE, T0)).toBeNull();
});

test("quiet: a tick past the quiet period after the last save sends, once; a tick before it does not", () => {
  const { sends, auto } = run({ timer: IDLE, editing: false, pending: 1 }, [
    [T0, saved],
    [T0 + QUIET_MS - 1, tick],
    [T0 + QUIET_MS, tick],
    [T0 + QUIET_MS + 1000, tick],
  ]);

  expect(sends).toEqual([[T0 + QUIET_MS, "quiet"]]);
  expect(auto.timer).toEqual(IDLE);
});

test("a new or edited comment restarts the timer", () => {
  const { sends } = run({ timer: IDLE, editing: false, pending: 2 }, [
    [T0, saved],
    [T0 + 100_000, saved],
    [T0 + QUIET_MS, tick],
    [T0 + 100_000 + QUIET_MS, tick],
  ]);

  expect(sends).toEqual([[T0 + 100_000 + QUIET_MS, "quiet"]]);
});

test("editing a comment pauses the timer with what it had left, and it runs on from there after", () => {
  const { sends, auto } = run({ timer: IDLE, editing: false, pending: 1 }, [
    [T0, saved],
    [T0 + 60_000, { _tag: "editStart" }],
    [T0 + QUIET_MS + 600_000, tick],
  ]);

  expect(sends).toEqual([]);
  expect(auto.timer).toEqual({ _tag: "paused", left: QUIET_MS - 60_000 });

  const after = run(auto, [
    [T0 + 1_000_000, { _tag: "editEnd" }],
    [T0 + 1_000_000 + QUIET_MS - 60_001, tick],
    [T0 + 1_000_000 + QUIET_MS - 60_000, tick],
  ]);

  expect(after.sends).toEqual([[T0 + 1_000_000 + QUIET_MS - 60_000, "quiet"]]);
});

test("a comment saved while another is being edited starts the period again, held until the editing ends", () => {
  const { auto } = run({ timer: IDLE, editing: false, pending: 1 }, [
    [T0, saved],
    [T0 + 1000, { _tag: "editStart" }],
    [T0 + 200_000, saved],
  ]);

  expect(auto.timer).toEqual({ _tag: "paused", left: QUIET_MS });
});

test("a reset (the plane held) gives what waits the whole quiet period again; with nothing waiting it does nothing", () => {
  const { sends, auto } = run({ timer: IDLE, editing: false, pending: 2 }, [
    [T0, saved],
    [T0 + QUIET_MS - 1000, { _tag: "reset" }],
    [T0 + QUIET_MS, tick],
    [T0 + 2 * QUIET_MS - 1001, tick],
    [T0 + 2 * QUIET_MS - 1000, tick],
  ]);

  expect(sends).toEqual([[T0 + 2 * QUIET_MS - 1000, "quiet"]]);
  expect(auto.timer).toEqual(IDLE);
  expect(run({ timer: IDLE, editing: false, pending: 0 }, [[T0, { _tag: "reset" }]]).auto.timer).toEqual(IDLE);
  expect(run({ timer: { _tag: "paused", left: 5 }, editing: true, pending: 1 }, [[T0, { _tag: "reset" }]]).auto.timer).toEqual({ _tag: "paused", left: QUIET_MS });
});

test("leaving, answering and Send now send at once; nothing pending sends nothing", () => {
  for (const reason of ["leave", "answer", "now"] as const) {
    expect(run({ timer: running(T0), editing: false, pending: 3 }, [[T0 + 5, { _tag: "send", reason }]]).sends).toEqual([[T0 + 5, reason]]);
    expect(run({ timer: IDLE, editing: false, pending: 0 }, [[T0 + 5, { _tag: "send", reason }]]).sends).toEqual([]);
  }

  /* While a comment is being written too: Luiz's own Send now, or leaving, does not wait for it. */
  expect(run({ timer: { _tag: "paused", left: 10 }, editing: true, pending: 1 }, [[T0, { _tag: "send", reason: "now" }]]).sends).toEqual([[T0, "now"]]);
});

test("a failed send keeps the comments and tries again after another quiet period", () => {
  const { sends } = run({ timer: IDLE, editing: false, pending: 1 }, [
    [T0, saved],
    [T0 + QUIET_MS, tick],
    [T0 + QUIET_MS + 10, { _tag: "failed" }],
    [T0 + QUIET_MS + 20, tick],
    [T0 + 2 * QUIET_MS + 10, tick],
  ]);

  expect(sends).toEqual([
    [T0 + QUIET_MS, "quiet"],
    [T0 + 2 * QUIET_MS + 10, "quiet"],
  ]);
});

test("one send: the owner's batch of every mark (its @-cites in the Markdown), a cited agent's batch, then one message per conversation", () => {
  const p: Pending = {
    items: [item(2, "@skills should this link to the document?"), item(1, "show the class")],
    msgs: [
      { key: "k1", to: { _tag: "page" }, text: "When does the suspension end?" },
      { key: "k2", to: { _tag: "side", id: 40 }, text: "and the second?" },
      { key: "k3", to: { _tag: "page" }, text: "Why this one?", quote: { text: "Mov. 54\n suspends", from: "x" } },
      { key: "k4", to: { _tag: "new", key: "s1", quote: { text: "Deferido", from: "the evidence", at: { hash: "#decision/d30", anchor: "dv-body" } } }, text: "who asked?" },
    ],
  };

  const posts = planSend(p, { decision: D30, hash: "#decision/d30", page: null, outdated: new Set([2]), ...WHO });

  /* Every message batches: the page thread's words are the owner's batch's `general` items (numbered from `next`); a side chat's keep their own post, after. */
  expect(posts.map((x) => x.carries)).toEqual([
    { items: [1, 2], msgs: ["k1", "k3"] },
    { items: [], msgs: [], owed: ["100:a1"] },
    { items: [], msgs: ["k2"] },
    { items: [], msgs: ["k4"] },
  ]);
  const batch = posts[0]?.body;
  expect(String(batch?.text)).toContain("   > @skills should this link to the document?");
  expect(String(batch?.text)).toContain("_(no longer found on revision 2026-10-10T10:28:40Z)_");
  expect(batch?.marks).toMatchObject({ decision: D30, at: { hash: "#decision/d30" }, to: "coordinator" });
  expect(batch?.marks?.items.map((i) => [i.n, i.kind, i.comment ?? ""])).toEqual([
    [1, "comment", "show the class"],
    [2, "comment", "@skills should this link to the document?"],
    [100, "general", "When does the suspension end?"],
    [101, "general", "> Mov. 54\n> suspends\n\nWhy this one?"],
  ]);
  /* No main thread yet: the owner's batch goes side-less, and opens it. */
  expect(batch).not.toHaveProperty("side");
  expect(posts[1]?.body.marks?.to).toBe("a1");
  expect(posts[1]?.body.marks?.items.map((i) => i.n)).toEqual([2]);
  expect(posts[2]?.body).toEqual({ text: "and the second?", side: 40 });
  expect(posts[3]?.body).toEqual({ text: "who asked?", side: "new", quote: { text: "Deferido", from: "the evidence", at: { hash: "#decision/d30", anchor: "dv-body" } } });

  /* Once the main thread is open, the owner's batch goes into it. */
  expect(planSend({ items: [], msgs: [{ key: "k1", to: { _tag: "page" }, text: "hi" }] }, { decision: D30, hash: "#decision/d30", page: 77, outdated: new Set(), ...WHO }).map((x) => [x.body.side, x.body.marks?.items, x.carries])).toEqual([[77, [{ n: 100, kind: "general", comment: "hi" }], { items: [], msgs: ["k1"] }]]);

  /* A reply in comment 5's thread goes, a `general` item on 5, to whoever comment 5 reached. */
  const known = new Map([[5, item(5, "@casos see")]]);
  expect(planSend({ items: [], msgs: [{ key: "r", to: { _tag: "mark", n: 5 }, text: "and also this" }] }, { decision: D30, hash: "#decision/d30", page: 77, outdated: new Set(), ...WHO, known }).map((x) => [x.body.marks?.to, x.body.marks?.items])).toEqual([
    ["coordinator", [{ n: 100, kind: "general", comment: "and also this", on: 5 }]],
    ["a2", [{ n: 100, kind: "general", comment: "and also this", on: 5 }]],
  ]);
  /* Grouped by thread: the comment's words once, then each reply. */
  expect(planSend({ items: [], msgs: [{ key: "r", to: { _tag: "mark", n: 5 }, text: "and also this" }, { key: "s", to: { _tag: "mark", n: 5 }, text: "and that" }] }, { decision: D30, hash: "#decision/d30", page: 77, outdated: new Set(), ...WHO, known })[0]?.body.text).toContain("**Replies**\n- On #5 “Every model call is saved”:\n  > and also this\n  > and that");
  expect(planSend(NONE, { decision: D30, hash: "#decision/d30", page: null, outdated: new Set(), ...WHO })).toEqual([]);
  expect(pageQuote({ id: "d9", title: "  Two\nlines ", revision: "r" }, "#decision/perf/d9").text).toBe("Two lines");
});

test("one batch per agent reached: the owner's holds all seven, each cited agent's only the comments citing it, in page order; the owner's joins the page thread", () => {
  const items = [item(7, "plain"), item(1, "@skills one"), item(4, "plain"), item(2, "plain"), item(5, "@skills and @casos"), item(3, "plain"), item(6, "@coordinator plain")];
  const posts = planSend({ items, msgs: [] }, { decision: D30, hash: "#decision/d30", page: 50, outdated: new Set(), ...WHO });

  expect(posts.map((x) => [x.body.marks?.to, x.body.marks?.items.map((i) => i.n), x.body.side])).toEqual([
    ["coordinator", [1, 2, 3, 4, 5, 6, 7], 50],
    ["a1", [1, 5], undefined],
    ["a2", [5], undefined],
  ]);
  expect(posts.map((x) => x.carries.items)).toEqual([[1, 2, 3, 4, 5, 6, 7], [], []]);

  /* A thread's Send now sends that comment alone, to whom it reaches. */
  expect(planSend({ items: [items[4] ?? item(5, "")], msgs: [] }, { decision: D30, hash: "#decision/d30", page: 50, outdated: new Set(), ...WHO }).map((x) => [x.body.marks?.to, x.body.marks?.items.map((i) => i.n)])).toEqual([
    ["coordinator", [5]],
    ["a1", [5]],
    ["a2", [5]],
  ]);

  /* The hover card's count per agent: the owner every comment, a cited agent its own. */
  expect(perRecipient({ items, msgs: [{ key: "k", to: { _tag: "page" }, text: "@casos see" }] }, WHO)).toEqual([
    { to: "coordinator", n: 8 },
    { to: "a1", n: 2 },
    { to: "a2", n: 2 },
  ]);
});

test("a sent post's marks and messages leave the pending; the rest stay", () => {
  const p: Pending = { items: [item(1, "a"), item(2, "b")], msgs: [{ key: "k1", to: { _tag: "page" }, text: "x" }] };

  expect(without(p, { items: [1], msgs: [] })).toEqual({ items: [item(2, "b")], msgs: p.msgs });
  expect(countOf(without(p, { items: [1, 2], msgs: ["k1"] }))).toBe(0);
});

test("the answer carries the decision's pending marks as `batch`, beside its own fields", () => {
  const [ride] = planSend({ items: [item(1, "fix it")], msgs: [] }, { decision: D30, hash: "#decision/d30", page: 12, outdated: new Set(), ...WHO });
  const out = answerBody({ text: "D30: approve", choice: "A" }, "d30", ride ?? null);

  expect(out.decision).toBe("d30");
  expect(out.text).toBe("D30: approve");
  expect(out.batch).toEqual({ text: ride?.body.text ?? "", marks: ride?.body.marks ?? null, side: 12 });
  expect(answerBody({ text: "x" }, "d30", null)).toEqual({ text: "x", decision: "d30" });
});

test("a page leaving sends keepalive posts up to 60 KB in all, the rest as plain fetches", () => {
  const big = "x".repeat(40 * 1024);
  const posts = planSend({ items: [item(1, "y".repeat(20 * 1024))], msgs: [{ key: "k1", to: { _tag: "page" }, text: big }, { key: "k2", to: { _tag: "side", id: 3 }, text: "small" }] }, { decision: D30, hash: "#decision/d30", page: 9, outdated: new Set(), ...WHO });
  const out = exitPosts(posts);

  expect(out.map((x) => x.keepalive)).toEqual([false, true]);
  expect(KEEPALIVE_MAX).toBe(61_440);
  expect(JSON.parse(out[1]?.json ?? "{}")).toEqual({ text: "small", side: 3 });
});

test("who a send reaches, with how many comments each, and the send in words", () => {
  const p: Pending = { items: [item(1, "@skills look"), item(2, "and @Skills again, @nobody, mail me@a1.com")], msgs: [{ key: "k", to: { _tag: "page" }, text: "@casos and @coordinator" }] };

  expect(perRecipient(p, WHO)).toEqual([
    { to: "coordinator", n: 3 },
    { to: "a1", n: 2 },
    { to: "a2", n: 1 },
  ]);
  expect(citesOf("hi @a1.", ROSTER).map((r) => r.id)).toEqual(["a1"]);
  expect(perRecipient(NONE, WHO)).toEqual([{ to: "coordinator", n: 0 }]);
  expect(sentWords(["3 to perf"], "leave")).toBe("Sent: 3 to perf (you left the page).");
  expect(sentWords(["4 to perf", "2 to skills"], "now")).toBe("Sent: 4 to perf, 2 to skills.");
});

test("what waits is kept under 1.9.33's drafts key, survives a reload, and a storage that throws keeps nothing and breaks nothing", () => {
  const store = memory();
  const key = draftsKey("perf", "d30");
  const p: Pending = { items: [item(1, "a")], msgs: [{ key: "k1", to: { _tag: "new", key: "s1", quote: { text: "words", from: "x", at: { hash: "#decision/d30", anchor: "dv-body" } } }, text: "hi" }] };

  expect(savePending(store, key, p)).toBe(true);
  expect(loadPending(store, key)).toEqual(p);
  expect(savePending(store, key, NONE)).toBe(true);
  expect(store.map.has(key)).toBe(false);

  /* 1.9.33's unsent marks, a list, are pending marks now. */
  saveDrafts(store, key, [item(4, "old draft")]);
  expect(loadPending(store, key)).toEqual({ items: [item(4, "old draft")], msgs: [] });

  /* Junk and a refusing storage: nothing waits, nothing throws. */
  store.setItem(key, '{"items":[{"n":"x"}],"msgs":[{"key":"k","to":{"_tag":"side","id":-1},"text":"t"},5]}');
  expect(loadPending(store, key)).toEqual(NONE);
  store.setItem(key, "{not json");
  expect(loadPending(store, key)).toEqual(NONE);
  expect(loadPending(broken, key)).toEqual(NONE);
  expect(savePending(broken, key, p)).toBe(false);
  expect(loadPending(null, key)).toEqual(NONE);
});

test("a withdrawal waits like a comment and rides the owner's next batch: alone, a batch of no items; with comments waiting, in their batch", () => {
  const alone: Pending = { items: [], msgs: [], withdrawn: [5] };

  expect(countOf(alone)).toBe(1);
  const [only, ...rest] = planSend(alone, { decision: D30, hash: "#decision/d30", page: 9, outdated: new Set(), ...WHO });
  expect(rest).toEqual([]);
  expect(only?.body.marks).toMatchObject({ items: [], withdrawn: [5], to: "coordinator" });
  expect(only?.body.side).toBe(9);
  expect(only?.body.text).toContain("Luiz withdrew comment #5.");
  expect(only?.carries).toEqual({ items: [], msgs: [], withdrawn: [5] });

  /* With comments waiting, the same one batch: no wake of its own. */
  const both = planSend({ items: [item(6, "new")], msgs: [], withdrawn: [5] }, { decision: D30, hash: "#decision/d30", page: null, outdated: new Set(), ...WHO });
  expect(both.map((x) => [x.body.marks?.items.map((i) => i.n), x.body.marks?.withdrawn])).toEqual([[[6], [5]]]);
  expect(without({ items: [item(6, "new")], msgs: [], withdrawn: [5] }, both[0]?.carries ?? { items: [], msgs: [] })).toEqual({ items: [], msgs: [] });

  /* Kept in the browser with the rest. */
  const store = memory();
  savePending(store, "k", alone);
  expect(loadPending(store, "k")).toEqual(alone);
});

test("a cited agent's batch is owed once the owner's is stored, until it is stored itself: a failed one goes again first on the next send", () => {
  const t = { decision: D30, hash: "#decision/d30", page: 9, outdated: new Set<number>(), ...WHO };
  const p: Pending = { items: [item(1, "@skills look"), item(2, "plain")], msgs: [] };
  const [owner, cited] = planSend(p, t);

  /* The owner's post leaves the cited batch owed; the cited post clears it. */
  expect(owner?.owes?.map((o) => [o.key, o.marks.to, o.marks.items.map((i) => i.n)])).toEqual([["100:a1", "a1", [1]]]);
  expect(cited?.carries).toEqual({ items: [], msgs: [], owed: ["100:a1"] });

  /* The owner's stored, the cited one failed: the comments are gone, the cited batch still owed (counted, kept). */
  const after = owing(without(p, owner?.carries ?? { items: [], msgs: [] }), owner?.owes ?? []);
  expect(after).toEqual({ items: [], msgs: [], owed: owner?.owes ?? [] });
  expect(countOf(after)).toBe(1);
  const store = memory();
  savePending(store, "k", after);
  expect(loadPending(store, "k")).toEqual(after);

  /* The next send posts it first, as it was, and clears it once stored; nothing else goes. */
  const again = planSend(after, t);
  expect(again.map((x) => [x.body.marks?.to, x.body.marks?.items.map((i) => i.n), x.carries])).toEqual([["a1", [1], { items: [], msgs: [], owed: ["100:a1"] }]]);
  expect(countOf(without(after, again[0]?.carries ?? { items: [], msgs: [] }))).toBe(0);
});
