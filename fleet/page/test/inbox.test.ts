/**
 * The inbox's threads (src/inbox.ts), read from the chat and from what waits: the page's main thread found
 * by its opener (empty before any message), a mark's thread with the answers naming it, a no-change reason,
 * Luiz's replies and the fleet's answers to them, side chats on the decision's words, a batch's loose
 * answers; pending ones first, then newest activity; unread answers.
 */
import { expect, test } from "bun:test";

import { inboxOf, isDone, lastLine, newestFleet, replyLead, splitDone, unreadCount, type InboxSource, type Thread } from "../src/inbox.ts";
import { Core, type Json, type MarkItem, type Message } from "../src/core.ts";
import { NONE } from "../src/autosend.ts";

const HASH = "#decision/d30";

const quote = (text: string) => ({ text, prefix: "", suffix: "", hint: "", blocks: [{ exact: text, prefix: "", suffix: "" }] });

const item = (n: number, kind: MarkItem["kind"], comment: string): MarkItem => ({ n, kind, quote: quote("words " + String(n)), comment });

/** A chat message as the server stores it, parsed as the page parses it. */
function msg(fields: { [key: string]: Json }): Message {
  const m = Core.parseMessage({ at: "2026-10-10T12:00:00Z", to: [], ...fields });

  if (!m) throw new Error("not a message");

  return m;
}

const batch = (id: number, items: readonly MarkItem[]): Message => msg({ id, from: "user", text: "**Marks on D30**", marks: { decision: { id: "d30", title: "D30", revision: "r1" }, at: { hash: HASH }, items: JSON.parse(JSON.stringify(items)) } });

const CHAT: Message[] = [
  msg({ id: 1, from: "coordinator", text: "unrelated" }),
  batch(10, [{ ...item(1, "replace", "shorter"), replacement: "brief" }, item(2, "question", "why?")]),
  msg({ id: 11, from: "coordinator", text: "Shortened.", re: 10, mark: [1] }),
  msg({ id: 12, from: "coordinator", text: "Left it: the court's words.", re: 10, mark: [2], keep: "it quotes the court" }),
  msg({ id: 13, from: "user", text: replyLead(2) + "fine, but add a note", re: 12 }),
  msg({ id: 14, from: "coordinator", text: "Note added.", re: 13 }),
  msg({ id: 15, from: "coordinator", text: "Thanks for the batch.", re: 10 }),
  msg({ id: 20, from: "user", text: "When does it end?", side: "new", quote: { text: "D30 Bench", from: "page", at: { hash: HASH, anchor: "dv-page" } } }),
  msg({ id: 21, from: "coordinator", text: "On 07/11.", side: 20 }),
  msg({ id: 30, from: "user", text: "who asked?", side: "new", quote: { text: "Deferido o requerimento", from: "the evidence", at: { hash: HASH, anchor: "dv-body" } } }),
  msg({ id: 31, from: "a1", text: "The defendant.", side: 30 }),
  msg({ id: 40, from: "user", text: "other decision", side: "new", quote: { text: "x", from: "", at: { hash: "#decision/d31", anchor: "dv-page" } } }),
];

/* The parser keeps a new side chat's own id as its side, as the hub stores it. */
const STORED = CHAT.map((m) => (m.id === 20 || m.id === 30 || m.id === 40 ? { ...m, side: m.id } : m));

const source = (over: Partial<InboxSource> = {}): InboxSource => ({ messages: STORED, hash: HASH, pending: NONE, host: "coordinator", owner: "perf", read: {}, base: 0, fresh: [], ...over });

const keyed = (ts: readonly Thread[]): string[] => ts.map((t) => t.key);

test("the main thread is the page's own side chat, the fleet named in words, its batches as cards; empty before any message", () => {
  const box = inboxOf(source());

  /* A batch in no side chat was the decision's first: it names the thread, and the page's own opener after it shows in it too. */
  expect(box.page.opener).toBe(10);
  expect(box.page.turns.map((t) => [t.who, t.text, t.marks?.items.length ?? 0])).toEqual([
    ["You", "", 2],
    ["You", "When does it end?", 0],
    ["perf", "On 07/11.", 0],
  ]);
  /* The opener's own quote is the page's marker, not words to show. */
  expect(box.page.turns[1]?.quote).toBe("");

  const later = inboxOf(source({ messages: STORED.filter((m) => !m.marks) }));
  expect([later.page.opener, later.page.turns.length]).toEqual([20, 2]);

  /* A batch sent into the thread (its `side`) is a card in it. */
  const into = inboxOf(source({ messages: [...STORED.filter((m) => !m.marks), { ...batch(50, [item(9, "comment", "late")]), side: 20 }] }));
  expect(into.page.turns.map((t) => t.marks?.items.map((i) => i.n) ?? t.text)).toEqual(["When does it end?", "On 07/11.", [9]]);

  const empty = inboxOf(source({ messages: STORED.filter((m) => m.id !== 20 && m.side !== 20 && !m.marks) }));
  expect([empty.page.opener, empty.page.turns.length]).toEqual([null, 0]);
});

test("a mark's thread: its words, the answers naming it, the no-change reason, Luiz's reply and the answer to it", () => {
  const box = inboxOf(source());
  const two = box.threads.find((t) => t.key === "m:2");

  expect(two?._tag === "mark" ? two.status : "").toBe("answered");
  expect(two?.turns.map((t) => [t.who, t.text, t.keep])).toEqual([
    ["You", "why?", ""],
    ["perf", "Left it: the court's words.", "it quotes the court"],
    ["You", "fine, but add a note", ""],
    ["perf", "Note added.", ""],
  ]);
  expect(box.threads.find((t) => t.key === "m:1")?.turns.map((t) => t.text)).toEqual(["Replace with “brief”\nshorter", "Shortened."]);
  expect(box.threads.find((t) => t._tag === "loose")?.turns.map((t) => t.text)).toEqual(["Thanks for the batch."]);
});

test("side chats on the decision's words, not another decision's; a new one shows before its first message", () => {
  const box = inboxOf(source({ fresh: [{ key: "s9", quote: "R2 is faster" }] }));
  const sides = box.threads.filter((t) => t._tag === "side");

  expect(sides.map((t) => (t._tag === "side" ? [t.key, t.quote, t.turns.map((x) => x.who).join(",")] : []))).toEqual([
    ["new:s9", "R2 is faster", ""],
    ["side:30", "Deferido o requerimento", "You,a1"],
  ]);
});

test("pending comes first, newest activity after; what waits shows in its thread as not sent", () => {
  const pending = {
    items: [item(3, "comment", "@skills look")],
    msgs: [
      { key: "k1", to: { _tag: "page" as const }, text: "and the second?" },
      { key: "k2", to: { _tag: "side" as const, id: 30 }, text: "sure?" },
    ],
  };

  const box = inboxOf(source({ pending }));

  expect(keyed(box.threads)).toEqual(["m:3", "side:30", "loose:10", "m:2", "m:1"]);
  expect(box.threads[0]?._tag === "mark" ? box.threads[0].status : "").toBe("pending");
  expect(box.page.waits).toBe(true);
  expect(box.page.turns.at(-1)).toMatchObject({ id: null, text: "and the second?" });
  expect(lastLine(box.page)).toEqual({ who: "You", text: "and the second?", waits: true });
});

test("an answer read up to its thread's newest is not unread; one past it is", () => {
  const all = inboxOf(source());

  expect(unreadCount(all)).toBe(5);
  const page = all.page;
  const read = { page: newestFleet(page), "m:1": 11, "m:2": 14, "side:30": 31 };
  const box = inboxOf(source({ read }));

  expect([box.page.unread, ...box.threads.map((t) => t.unread)]).toEqual([false, false, true, false, false]);
  expect(unreadCount(inboxOf(source({ base: 100 })))).toBe(0);
});

test("hiding answered work: answered marks, a batch's answers and resolved side chats go apart, in order; nothing does when shown", () => {
  const box = inboxOf(source({ pending: { items: [item(3, "comment", "new")], msgs: [] } }));
  const hidden = splitDone(box.threads, true);

  expect(keyed(hidden.open)).toEqual(["m:3"]);
  expect(keyed(hidden.done)).toEqual(["side:30", "loose:10", "m:2", "m:1"]);
  expect(splitDone(box.threads, false)).toEqual({ open: box.threads, done: [] });

  /* A side chat whose last word is Luiz's, or with words waiting, is still open. */
  const asked = inboxOf(source({ messages: [...STORED, msg({ id: 60, from: "user", text: "and then?", side: 30 })] }));
  expect(asked.threads.filter((t) => t.key === "side:30").map(isDone)).toEqual([false]);
  expect(isDone(box.page)).toBe(false);
});

test("a withdrawn comment is marked so and kept apart as history, whether it was answered or not", () => {
  const box = inboxOf(source({ pending: { items: [], msgs: [], withdrawn: [1] }, messages: [...STORED, { ...batch(70, []), marks: { decision: { id: "d30", title: "D30", revision: "r1" }, at: { hash: HASH }, items: [], withdrawn: [2] } }] }));
  const flags = box.threads.flatMap((t) => (t._tag === "mark" ? [[t.key, t.withdrawn, t.waits]] : []));

  expect(flags).toEqual([
    ["m:1", true, true],
    ["m:2", true, false],
  ]);
  expect(keyed(splitDone(box.threads, false).done)).toEqual(["m:1", "m:2"]);
});

test("every message batches: a reply in a comment's thread, sent as a `general` item on it or waiting, shows in that thread; an answer naming it too", () => {
  const reply = { ...batch(80, [{ n: 9, kind: "general", comment: "and the totals?", on: 2 }]), side: 20 };
  const answer = msg({ id: 81, from: "coordinator", text: "Totals too.", re: 80, mark: [9] });
  const box = inboxOf(source({ messages: [...STORED, reply, answer], pending: { items: [], msgs: [{ key: "w", to: { _tag: "mark", n: 2 }, text: "one more" }] } }));
  const two = box.threads.find((t) => t.key === "m:2");

  expect(two?.turns.map((t) => [t.who, t.text, t.id === null])).toEqual([
    ["You", "why?", false],
    ["perf", "Left it: the court's words.", false],
    ["You", "fine, but add a note", false],
    ["perf", "Note added.", false],
    ["You", "and the totals?", false],
    ["perf", "Totals too.", false],
    ["You", "one more", true],
  ]);
  expect(two?.waits).toBe(true);
  /* No thread of its own for a reply item. */
  expect(box.threads.some((t) => t.key === "m:9")).toBe(false);
});
