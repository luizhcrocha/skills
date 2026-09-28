// The dashboard page's rules that need no browser (the `fleet-core` script in assets/dashboard.html):
// the composer's keys, mentions, the roster, and the conversation's threads.
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
  assert.deepEqual(roster[0], { id: "coordinator", name: "coordinator", status: "running", task: "Two workers on milestone 2", order: -1 });
  assert.deepEqual(roster[1], { id: "a2", name: "invoice-gen", status: "running", task: "Generate", order: 1 });
  assert.deepEqual(Core.rosterOf({ agents: [] }).map((r) => r.id), ["coordinator"]);
});

test("resolve: coordinator, then ids in state order, then names in state order, whatever the display order", () => {
  // b2 is running, so the roster shows it first; its name is b1's id.
  const r = Core.rosterOf({ agents: [{ id: "b1", name: "first", status: "done" }, { id: "b2", name: "b1", status: "running" }, { id: "b3", name: "first", status: "running" }] });
  assert.deepEqual(r.map((x) => x.id), ["coordinator", "b2", "b3", "b1"]);
  assert.equal(Core.resolve(r, "b1"), "b1", "an id wins over a name");
  assert.equal(Core.resolve(r, "FIRST"), "b1", "of two names, the earlier agent in state order");
  assert.equal(Core.resolve(r, "Coordinator"), "coordinator");
  assert.equal(Core.resolve(r, "nobody"), null);
  assert.deepEqual(Core.recipientsOf("@b1 please", r, "user"), ["b1"]);
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

test("segments: resolved mentions by id or name in any case; unresolved stay text", () => {
  assert.deepEqual(Core.segments("Hi @Invoice-Gen and @A1, not @nobody", roster), [
    { text: "Hi " }, { text: "@Invoice-Gen", mention: "a2" }, { text: " and " }, { text: "@A1", mention: "a1" }, { text: ", not @nobody" },
  ]);
  assert.deepEqual(Core.segments("ask @coordinator", roster), [{ text: "ask " }, { text: "@coordinator", mention: "coordinator" }]);
});

test("segments: a trailing dot or dash is punctuation unless the name has it (as chat.py reads it)", () => {
  assert.deepEqual(Core.segments("thanks @a2.", roster), [{ text: "thanks " }, { text: "@a2", mention: "a2" }, { text: "." }]);
  assert.deepEqual(Core.segments("@stripe.adapter", roster), [{ text: "@stripe.adapter", mention: "a3" }]);
  assert.deepEqual(Core.segments("@a2--", roster), [{ text: "@a2", mention: "a2" }, { text: "--" }]);
});

test("recipientsOf: a user message goes to its mentions, else the coordinator; a fleet message adds the user", () => {
  assert.deepEqual(Core.recipientsOf("hello", roster, "user"), ["coordinator"]);
  assert.deepEqual(Core.recipientsOf("@a2 and @invoice-gen and @a1", roster, "user"), ["a2", "a1"]);
  assert.deepEqual(Core.recipientsOf("@a2 ping @a1", roster, "a2"), ["user", "a1"], "the sender is not its own recipient");
  assert.deepEqual(Core.recipientsOf("done", roster, "coordinator"), ["user"]);
});

test("recipientsOf: a reply also reaches the sender of what it answers, never the replier itself", () => {
  assert.deepEqual(Core.recipientsOf("thanks", roster, "user", "a2"), ["a2"], "no mention needed, and no coordinator");
  assert.deepEqual(Core.recipientsOf("thanks @a1", roster, "user", "a2"), ["a1", "a2"]);
  assert.deepEqual(Core.recipientsOf("thanks @a2", roster, "user", "a2"), ["a2"], "once each");
  assert.deepEqual(Core.recipientsOf("ok", roster, "user", "coordinator"), ["coordinator"]);
  assert.deepEqual(Core.recipientsOf("noted", roster, "a2", "user"), ["user"], "an agent answering the user");
  assert.deepEqual(Core.recipientsOf("noted", roster, "a2", "a1"), ["user", "a1"], "an agent answering another agent");
  assert.deepEqual(Core.recipientsOf("hm", roster, "a2", "a2"), ["user"], "answering itself adds no one");
  assert.deepEqual(Core.recipientsOf("hello", roster, "user", null), ["coordinator"]);
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

test("drafts: kept in the store, cleared when blank, and nothing kept when the store throws", () => {
  const map = new Map();
  const store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  const d = Core.drafts(store, "k");
  assert.equal(d.read(), "");
  d.write("half a thought");
  assert.equal(d.read(), "half a thought");
  d.write("   ");
  assert.equal(map.has("k"), false);
  d.write("again"); d.clear();
  assert.equal(d.read(), "");
  const broken = Core.drafts({ getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } }, "k");
  assert.equal(broken.read(), "");
  assert.doesNotThrow(() => { broken.write("x"); broken.clear(); });
  assert.equal(Core.drafts(null, "k").read(), "");
});

// The cases shared with tests/test_chat.py: the page resolves recipients exactly as chat.py does.
const shared = JSON.parse(readFileSync(new URL("./recipients.json", import.meta.url), "utf8"));
for (const [i, group] of shared.entries()) {
  const sharedRoster = Core.rosterOf(group.roster);
  for (const c of group.cases) {
    test(`recipients.json[${i}]: ${c.name}`, () => {
      assert.deepEqual(Core.recipientsOf(c.text, sharedRoster, c.sender, c.re_sender), c.to);
    });
  }
}
