// The dashboard page's rules that need no browser (the `fleet-core` script in assets/dashboard.html):
// the composer's keys, the @token at the caret, the roster list, the threads, and the preferences store.
// Who a message reaches is chat.py's rule and is tested there (tests/recipients.json).
// Run from the repo root: node --test skills/productivity/coordinator/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../assets/dashboard.html", import.meta.url), "utf8");
const source = html.match(/<script id="fleet-core">([\s\S]*?)<\/script>/)[1];
// The script declares `var FleetCore` and touches no browser API, so it runs as a plain function body.
const Core = new Function(source + "\nreturn FleetCore;")();

const STATE = {
  status: "running",
  now: "Two workers on milestone 2",
  agents: [
    { id: "a1", name: "research-stripe", status: "done", task: "Research" },
    { id: "a2", name: "invoice-gen", status: "running", task: "Generate" },
    { id: "a3", name: "stripe.adapter", status: "blocked", task: "Adapt" },
    { id: "a4", name: "notes impl", status: "running", task: "Notes" },
  ],
};
const roster = Core.rosterOf(STATE);
const key = (key, extra = {}) => ({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, ...extra });

test("keyOf: Enter sends and Shift+Enter breaks the line on a keyboard", () => {
  assert.equal(Core.keyOf(key("Enter"), false, false), "send");
  assert.equal(Core.keyOf(key("Enter", { shiftKey: true }), false, false), null);
  assert.equal(Core.keyOf(key("Enter", { altKey: true }), false, false), null);
  assert.equal(Core.keyOf(key("a"), false, false), null);
});

test("keyOf: on a coarse pointer Enter breaks the line, Ctrl or Cmd with Enter still sends", () => {
  assert.equal(Core.keyOf(key("Enter"), true, false), null);
  assert.equal(Core.keyOf(key("Enter", { ctrlKey: true }), true, false), "send");
  assert.equal(Core.keyOf(key("Enter", { metaKey: true }), true, false), "send");
});

test("keyOf: Escape blurs, and nothing acts during IME composition", () => {
  assert.equal(Core.keyOf(key("Escape"), false, false), "blur");
  assert.equal(Core.keyOf(key("Enter", { isComposing: true }), false, false), null);
  assert.equal(Core.keyOf(key("Enter", { keyCode: 229 }), false, false), null);
  assert.equal(Core.keyOf(key("Enter", { isComposing: true }), false, true), null);
});

test("keyOf: while the mention list is open, arrows move, Enter and Tab pick, Escape closes", () => {
  assert.equal(Core.keyOf(key("ArrowDown"), false, true), "next");
  assert.equal(Core.keyOf(key("ArrowUp"), false, true), "prev");
  assert.equal(Core.keyOf(key("Enter"), false, true), "pick");
  assert.equal(Core.keyOf(key("Enter"), true, true), "pick");
  assert.equal(Core.keyOf(key("Tab"), false, true), "pick");
  assert.equal(Core.keyOf(key("Escape"), false, true), "close");
  assert.equal(Core.keyOf(key("Tab", { shiftKey: true }), false, true), null);
  assert.equal(Core.keyOf(key("Tab"), false, false), null);
});

test("rosterOf: the coordinator first, then running agents, then the rest in spawn order", () => {
  assert.deepEqual(roster.map((r) => r.id), ["coordinator", "a2", "a4", "a1", "a3"]);
  assert.deepEqual(roster[0], { id: "coordinator", name: "coordinator", status: "running", task: "Two workers on milestone 2" });
  assert.deepEqual(roster[1], { id: "a2", name: "invoice-gen", status: "running", task: "Generate" });
  assert.deepEqual(Core.rosterOf({ agents: [] }).map((r) => r.id), ["coordinator"]);
});

test("mentionAt: the @query ending at the caret, when the @ starts a word", () => {
  assert.deepEqual(Core.mentionAt("Hi @", 4), { start: 3, end: 4, query: "" });
  assert.deepEqual(Core.mentionAt("Hi @inv", 7), { start: 3, end: 7, query: "inv" });
  assert.deepEqual(Core.mentionAt("@inv and more", 4), { start: 0, end: 4, query: "inv" });
  assert.deepEqual(Core.mentionAt("(@a1", 4), { start: 1, end: 4, query: "a1" });
  assert.deepEqual(Core.mentionAt("Hi @invoice-gen", 7), { start: 3, end: 7, query: "inv" }, "the query stops at the caret");
});

test("mentionAt: no mention after a space, in an address, or without an @", () => {
  assert.equal(Core.mentionAt("Hi @inv ", 8), null);
  assert.equal(Core.mentionAt("mail me@example.com", 14), null);
  assert.equal(Core.mentionAt("plain words", 5), null);
  assert.equal(Core.mentionAt("", 0), null);
});

test("filterRoster: by id or name in any case, prefixes before substrings, roster order kept", () => {
  assert.deepEqual(Core.filterRoster(roster, "").map((r) => r.id), ["coordinator", "a2", "a4", "a1", "a3"]);
  assert.deepEqual(Core.filterRoster(roster, "INV").map((r) => r.id), ["a2"]);
  assert.deepEqual(Core.filterRoster(roster, "a").map((r) => r.id), ["a2", "a4", "a1", "a3", "coordinator"], "ids a1..a4 start with a; coordinator contains it");
  assert.deepEqual(Core.filterRoster(roster, "stripe").map((r) => r.id), ["a3", "a1"], "stripe.adapter starts with it; research-stripe contains it");
  assert.deepEqual(Core.filterRoster(roster, "zzz").map((r) => r.id), []);
});

test("insertMention: '@name ' at the caret, replacing the query and the rest of the word", () => {
  const gen = roster.find((r) => r.id === "a2");
  const at = Core.mentionAt("Hi @inv", 7);
  assert.deepEqual(Core.insertMention("Hi @inv", at, gen), { text: "Hi @invoice-gen ", caret: 16 });
  const mid = Core.mentionAt("Hi @invxx there", 7);
  assert.deepEqual(Core.insertMention("Hi @invxx there", mid, gen), { text: "Hi @invoice-gen there", caret: 16 }, "an existing space is reused");
  const notes = roster.find((r) => r.id === "a4");
  assert.deepEqual(Core.insertMention("@no", Core.mentionAt("@no", 3), notes), { text: "@a4 ", caret: 4 }, "a name that is not a mention token inserts the id");
});

const msg = (id, from, to, re = null, text = "m" + id) => ({ id, at: "2026-09-28T10:00:0" + (id % 10) + "Z", from, to, text, re });

test("fold: replies join the thread of what they answer, however deep", () => {
  const threads = Core.fold([
    msg(1, "user", ["a2", "a1"]),
    msg(2, "a2", ["user"], 1),
    msg(3, "coordinator", ["user"]),
    msg(4, "user", ["a2"], 2),
  ]);
  assert.deepEqual(threads.map((t) => [t.root.message.id, t.replies.map((r) => r.message.id)]), [[3, []], [1, [2, 4]]],
    "the thread with the latest message comes last");
});

test("fold: a user message waits on each recipient until it answers with re", () => {
  const [t] = Core.fold([msg(1, "user", ["a2", "a1"]), msg(2, "a2", ["user"], 1)]);
  assert.deepEqual(t.root.waiting, ["a1"]);
  assert.deepEqual(t.replies[0].waiting, [], "fleet messages wait on no one");
  const [done] = Core.fold([msg(1, "user", ["a2", "a1"]), msg(2, "a2", ["user"], 1), msg(3, "a1", ["user"], 1)]);
  assert.deepEqual(done.root.waiting, []);
  const [other] = Core.fold([msg(1, "user", ["a2"]), msg(2, "a1", ["user"], 1)]);
  assert.deepEqual(other.root.waiting, ["a2"], "an answer from someone else does not count");
});

test("fold: order-independent, and a reply to an unknown message starts its own thread", () => {
  const a = Core.fold([msg(2, "a2", ["user"], 1), msg(1, "user", ["a2"])]);
  assert.deepEqual(a.map((t) => t.root.message.id), [1]);
  const b = Core.fold([msg(5, "a2", ["user"], 99)]);
  assert.deepEqual(b.map((t) => t.root.message.id), [5]);
  assert.deepEqual(Core.fold([]), []);
});

test("unreadCount: fleet messages after the last read one", () => {
  const list = [msg(1, "user", ["a2"]), msg(2, "a2", ["user"], 1), msg(3, "coordinator", ["user"])];
  assert.equal(Core.unreadCount(list, 0), 2);
  assert.equal(Core.unreadCount(list, 2), 1);
  assert.equal(Core.unreadCount(list, 3), 0);
});

test("prefsOf: read with a default, write, remove, each under prefix + key as JSON", () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const p = Core.prefsOf(storage, "fleet:");
  assert.equal(p.get("f-status", ""), "");
  p.set("f-status", "done");
  p.set("expanded", ["a1", "a2"]);
  p.set("chat-collapsed", false);
  assert.equal(map.get("fleet:f-status"), '"done"', "the encoding the page has always used");
  assert.deepEqual(p.get("expanded", []), ["a1", "a2"]);
  assert.equal(p.get("chat-collapsed", null), false, "a stored false is not the default");
  p.remove("f-status");
  assert.equal(p.get("f-status", "all"), "all");
  assert.equal(map.has("fleet:f-status"), false);
});

test("prefsOf: reads what the previous version stored, and a value it cannot parse as absent", () => {
  const map = new Map([["fleet:f-milestone", JSON.stringify("m2")], ["fleet:n-sound", JSON.stringify("off")], ["fleet:chat-draft", "raw text from before"]]);
  const p = Core.prefsOf({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) }, "fleet:");
  assert.equal(p.get("f-milestone", ""), "m2");
  assert.equal(p.get("n-sound", "important"), "off");
  assert.equal(p.get("chat-draft", ""), "", "a draft stored raw reads as absent once");
});

test("prefsOf: a missing or throwing storage keeps nothing and reads every default", () => {
  const boom = () => { throw new Error("denied"); };
  for (const storage of [null, undefined, { getItem: boom, setItem: boom, removeItem: boom }]) {
    const p = Core.prefsOf(storage, "fleet:");
    assert.doesNotThrow(() => { p.set("k", 1); p.remove("k"); });
    assert.deepEqual(p.get("k", ["default"]), ["default"]);
  }
});
