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

test("commandAt: the /query ending at the caret, when the / starts the field or follows a space or a newline", () => {
  assert.deepEqual(Core.commandAt("/", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(Core.commandAt("/tst more", 4), { start: 0, end: 4, query: "tst" });
  assert.deepEqual(Core.commandAt("please run /tst", 15), { start: 11, end: 15, query: "tst" });
  assert.deepEqual(Core.commandAt("line one\n/res", 13), { start: 9, end: 13, query: "res" });
  assert.deepEqual(Core.commandAt("run /tstack:tdd now", 9), { start: 4, end: 9, query: "tsta" }, "the query stops at the caret");
});

test("commandAt: no command inside a word, in a path or URL, after a space, or without a /", () => {
  assert.equal(Core.commandAt("a/b", 3), null);
  assert.equal(Core.commandAt("see https://x/y", 15), null);
  assert.equal(Core.commandAt("see https:/", 11), null);
  assert.equal(Core.commandAt("see https://", 12), null);
  assert.equal(Core.commandAt("(/tst", 5), null);
  assert.equal(Core.commandAt("/tst ", 5), null);
  assert.equal(Core.commandAt("plain words", 5), null);
  assert.equal(Core.commandAt("", 0), null);
});

test("insertCommand: '/name ' in place of the token, the rest of its word too, the caret after it", () => {
  const skill = { name: "tstack:bro" };
  assert.deepEqual(Core.insertCommand("/tst", Core.commandAt("/tst", 4), skill), { text: "/tstack:bro ", caret: 12 });
  assert.deepEqual(Core.insertCommand("please run /tst", Core.commandAt("please run /tst", 15), skill), { text: "please run /tstack:bro ", caret: 23 });
  const mid = "run /tsxx then more";
  assert.deepEqual(Core.insertCommand(mid, Core.commandAt(mid, 7), skill), { text: "run /tstack:bro then more", caret: 16 }, "an existing space is reused");
  const lead = "/t fix it";
  assert.deepEqual(Core.insertCommand(lead, Core.commandAt(lead, 2), skill), { text: "/tstack:bro fix it", caret: 12 });
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

const item = (id, extra = {}) => ({ id, kind: "decision", title: "T" + id, question: "q", status: "open", blocking: false, opened: "2026-09-28T10:00:00Z", revised: null, closed: null, ...extra });

test("decisionRows: open and blocking first, then open, oldest first in each, then closed, newest first", () => {
  const rows = Core.decisionRows([
    item("d1", { opened: "2026-09-28T10:05:00Z" }),
    item("d2", { status: "decided", closed: "2026-09-28T11:00:00Z" }),
    item("d3", { blocking: true, opened: "2026-09-28T10:30:00Z" }),
    item("d4", { status: "withdrawn", closed: "2026-09-28T12:00:00Z" }),
    item("d5", { blocking: true, opened: "2026-09-28T10:10:00Z" }),
    item("d6", { opened: "2026-09-28T10:01:00Z" }),
  ], {});
  assert.deepEqual(rows.map((r) => r.item.id), ["d5", "d3", "d6", "d1", "d4", "d2"]);
  assert.deepEqual(Core.decisionRows(undefined, {}), []);
});

test("decisionRows: an open item is new until seen, and changed when revised after it was seen", () => {
  const seen = { d1: "2026-09-28T10:00:00Z", d2: "2026-09-28T10:20:00Z", d4: "2026-09-28T10:00:00Z" };
  const rows = Core.decisionRows([
    item("d1", { revised: "2026-09-28T10:20:00Z" }),
    item("d2", { revised: "2026-09-28T10:20:00Z" }),
    item("d3"),
    item("d4", { status: "decided", closed: "2026-09-28T11:00:00Z", revised: "2026-09-28T10:30:00Z" }),
  ], seen);
  assert.deepEqual(rows.map((r) => [r.item.id, r.mark]), [["d1", "changed"], ["d2", ""], ["d3", "new"], ["d4", ""]]);
  assert.deepEqual(Core.decisionRows([item("d3")], null).map((r) => r.mark), ["new"]);
});

test("decisionRoute: the decision a location hash names", () => {
  assert.equal(Core.decisionRoute("#decision/d1"), "d1");
  assert.equal(Core.decisionRoute("#decision/schema.v2-a"), "schema.v2-a");
  assert.equal(Core.decisionRoute("#decision/billing/d1", true), "billing/d1", "another fleet's, on the manager's page");
  for (const hash of ["", "#", "#decisions", "#decision/", "#decision/a/b", "#decision/a b", "#roadmap", undefined]) assert.equal(Core.decisionRoute(hash), null, String(hash));
});

test("pendingAnswer: the user's latest answer given after the item last changed, with the replies to it", () => {
  const d = item("d1", { opened: "2026-09-28T10:00:00Z", revised: "2026-09-28T10:30:00Z" });
  const at = (m, iso, decision) => ({ ...m, at: iso, ...(decision ? { decision } : {}) });
  const messages = [
    at(msg(1, "user", ["coordinator"]), "2026-09-28T10:10:00Z", "d1"),
    at(msg(2, "user", ["coordinator"]), "2026-09-28T10:40:00Z", "d2"),
    at(msg(3, "user", ["coordinator"]), "2026-09-28T10:41:00Z", "d1"),
    at(msg(4, "coordinator", ["user"], 3), "2026-09-28T10:42:00Z"),
    at(msg(5, "user", ["coordinator"]), "2026-09-28T10:43:00Z"),
    at(msg(6, "a2", ["user"], 1), "2026-09-28T10:44:00Z"),
  ];
  const pending = Core.pendingAnswer(d, messages);
  assert.equal(pending.answer.id, 3);
  assert.deepEqual(pending.replies.map((m) => m.id), [4]);
  assert.equal(Core.pendingAnswer(item("d1", { revised: "2026-09-28T10:50:00Z" }), messages), null, "a revision after the answer asks again");
  assert.equal(Core.pendingAnswer(item("d1", { status: "decided" }), messages), null, "a closed item waits on nothing");
  assert.equal(Core.pendingAnswer(item("d9"), messages), null);
  assert.equal(Core.pendingAnswer(item("d9"), []), null);
});

test("answerText: a decision is one option with an optional note, or none of them with a note", () => {
  const d = item("d1", { options: [{ id: "A", label: "migrate now", consequence: "c" }, { id: "B", label: "keep both", consequence: "c" }] });
  assert.deepEqual(Core.answerText(d, { choice: "B", note: "" }), { text: "B: keep both" });
  assert.deepEqual(Core.answerText(d, { choice: "B", note: "  after the release \n" }), { text: "B: keep both\nafter the release" });
  assert.deepEqual(Core.answerText(d, { choice: "none", note: "split the table" }), { text: "None of these: split the table" });
  assert.equal(Core.answerText(d, { choice: "none", note: " " }).error, "Say what you want instead.");
  assert.equal(Core.answerText(d, { choice: "", note: "x" }).error, "Pick one option.");
  assert.equal(Core.answerText(d, { choice: "Z", note: "" }).error, "Pick one option.");
});

test("answerText: an input is its text, a secret a reference or done by hand, an action done", () => {
  assert.deepEqual(Core.answerText(item("d1", { kind: "input" }), { value: " 200 per minute " }), { text: "200 per minute" });
  assert.equal(Core.answerText(item("d1", { kind: "input" }), { value: "" }).error, "Write your answer.");
  const secret = item("d1", { kind: "secret", secret: "NEO4J_PASSWORD" });
  assert.deepEqual(Core.answerText(secret, { value: "op://Engineering/Neo4j/password" }), { text: "op://Engineering/Neo4j/password" });
  assert.deepEqual(Core.answerText(secret, { done: true, note: "" }), { text: "Set by hand." });
  assert.equal(Core.answerText(secret, { value: " " }).error, "Give the reference or the item's name.");
  assert.deepEqual(Core.answerText(item("d1", { kind: "action" }), { done: true, note: "ran on the NAS too" }), { text: "Done.\nran on the NAS too" });
});

test("answerText and failedAnswer: an action that failed is Failed: with what happened, which it needs", () => {
  const action = item("d1", { kind: "action", status: "open", opened: "2026-09-29T15:00:00Z" });
  assert.deepEqual(Core.answerText(action, { failed: true, note: " just: recipe `cut` not found \n" }), { text: "Failed: just: recipe `cut` not found" });
  assert.equal(Core.answerText(action, { failed: true, note: "  " }).error, "Say what happened: what you ran and what it said.");
  const said = (text, at = "2026-09-29T15:10:00Z", id = 80) => ({ id, from: "user", decision: "d1", at, text });
  assert.equal(Core.failedAnswer(action, [said("Failed: no such recipe\nfull log")]).id, 80);
  assert.equal(Core.failureWords(said("Failed: no such recipe\nfull log")), "no such recipe");
  assert.equal(Core.failureWords(said("Failed: " + "x".repeat(80))), "x".repeat(60) + "…");
  assert.equal(Core.failedAnswer(action, [said("Failed: x"), said("Done.", "2026-09-29T15:11:00Z", 81)]), null);
  assert.equal(Core.failedAnswer({ ...action, revised: "2026-09-29T15:20:00Z" }, [said("Failed: x")]), null);
  assert.equal(Core.failedAnswer({ ...action, kind: "input" }, [said("Failed: x")]), null);
  assert.equal(Core.failedAnswer({ ...action, status: "withdrawn" }, [said("Failed: x")]), null);
});

test("parseState: a state the page can render, with every list present, or null", () => {
  const parsed = Core.parseState({ project: "p", goal: "g", status: "running", now: "n", started: "2026-09-28T10:00:00Z", agents: [{ id: "a1", name: "x", status: "done", task: "t" }] });
  assert.deepEqual([parsed.roadmap, parsed.roadblocks, parsed.decisions, parsed.events], [[], [], [], []]);
  assert.deepEqual(parsed.agents[0], { id: "a1", name: "x", status: "done", task: "t", lane: [], tokens: 0, duration_ms: 0, rounds: 1 });
  assert.equal(parsed.updated, "2026-09-28T10:00:00Z", "a state never rendered was last updated when it began");
  for (const bad of [null, undefined, "text", 3, [], { project: "p" }, { project: "p", goal: "g", status: "running", now: "n", started: "x", agents: "none" }, { project: 1, goal: "g", status: "s", now: "n", started: "x" }]) assert.equal(Core.parseState(bad), null, JSON.stringify(bad));
});

test("parseState: rows that are not rows are dropped, and a row keeps the fields the page does not know", () => {
  const parsed = Core.parseState({ project: "p", goal: "g", status: "running", now: "n", started: "x", agents: [null, { name: "no id" }, { id: "a1", extra: 1 }], decisions: [{ id: "d1", title: "T" }, "x"], events: [{ at: "x", kind: "note", text: "t" }, { text: 1 }] });
  assert.deepEqual(parsed.agents, [{ id: "a1", extra: 1, name: "a1", status: "", task: "", lane: [], tokens: 0, duration_ms: 0, rounds: 1 }]);
  assert.deepEqual(parsed.decisions.map((d) => [d.id, d.status, d.kind, d.options]), [["d1", "open", "decision", []]]);
  assert.equal(parsed.events.length, 1);
});

test("parseMessage: a chat message as the server stores it, or null", () => {
  const m = Core.parseMessage({ id: 3, at: "2026-09-28T10:00:00Z", from: "a1", to: ["user"], text: "hi", re: 1, parts: [{ text: "hi" }], decision: "d1" });
  assert.deepEqual(m, { id: 3, at: "2026-09-28T10:00:00Z", from: "a1", to: ["user"], text: "hi", re: 1, parts: [{ text: "hi" }], decision: "d1", author: "", quote: null, side: null });
  assert.deepEqual(Core.parseMessage({ id: 1, from: "user", to: [], text: "x" }), { id: 1, at: "", from: "user", to: [], text: "x", re: null, parts: [{ text: "x" }], decision: "", author: "", quote: null, side: null });
  for (const bad of [null, "x", {}, { id: "1", from: "a", to: [], text: "x" }, { id: 1, from: "a", to: "user", text: "x" }, { id: 1, from: "a", to: [], text: 3 }, { error: "refused" }]) assert.equal(Core.parseMessage(bad), null, JSON.stringify(bad));
});

test("viewOf: the view a location hash names, the decision it opens, and the place to scroll to", () => {
  assert.deepEqual(Core.viewOf(""), { view: "decisions", decision: null, anchor: null });
  assert.deepEqual(Core.viewOf("#"), { view: "decisions", decision: null, anchor: null });
  assert.deepEqual(Core.viewOf("#decisions"), { view: "decisions", decision: null, anchor: null });
  assert.deepEqual(Core.viewOf("#decision/d1"), { view: "decisions", decision: "d1", anchor: null });
  assert.deepEqual(Core.viewOf("#plan"), { view: "plan", decision: null, anchor: null });
  assert.deepEqual(Core.viewOf("#fleet"), { view: "fleet", decision: null, anchor: null });
  assert.deepEqual(Core.viewOf("#log"), { view: "log", decision: null, anchor: null });
  assert.deepEqual(Core.viewOf("#roadblocks"), { view: "plan", decision: null, anchor: "roadblocks" }, "the addresses the page had before it had views");
  assert.deepEqual(Core.viewOf("#roadmap"), { view: "plan", decision: null, anchor: "roadmap" });
  assert.deepEqual(Core.viewOf("#tokens"), { view: "fleet", decision: null, anchor: "tokens" });
  assert.deepEqual(Core.viewOf("#activity"), { view: "log", decision: null, anchor: "activity" });
  assert.deepEqual(Core.viewOf("#agent-a1"), { view: "fleet", decision: null, anchor: "agent-a1" });
  assert.deepEqual(Core.viewOf("#nonsense"), { view: "decisions", decision: null, anchor: null });
});

test("leadOf: what waits on the user, said in a sentence", () => {
  const lead = (...rows) => Core.leadOf(rows);
  assert.deepEqual(lead(), { headline: "Nothing waits on you.", detail: "", tone: "clear" });
  assert.deepEqual(lead(item("d1", { status: "decided" })), { headline: "Nothing waits on you.", detail: "", tone: "clear" });
  assert.deepEqual(lead(item("d1")), { headline: "1 decision waits on you.", detail: "Work goes on meanwhile.", tone: "waiting" });
  assert.deepEqual(lead(item("d1", { blocking: true })), { headline: "1 decision waits on you.", detail: "It blocks work.", tone: "blocking" });
  assert.deepEqual(lead(item("d1"), item("d2", { blocking: true }), item("d3")), { headline: "3 decisions wait on you.", detail: "1 of them blocks work.", tone: "blocking" });
  assert.deepEqual(lead(item("d1", { blocking: true }), item("d2", { blocking: true })), { headline: "2 decisions wait on you.", detail: "Both block work.", tone: "blocking" });
  assert.deepEqual(lead(item("d1", { blocking: true }), item("d2", { blocking: true }), item("d3", { blocking: true }), item("d4")), { headline: "4 decisions wait on you.", detail: "3 of them block work.", tone: "blocking" });
  assert.deepEqual(lead(item("d1", { blocking: true }), item("d2", { blocking: true }), item("d3", { blocking: true })), { headline: "3 decisions wait on you.", detail: "All of them block work.", tone: "blocking" });
});

test("toastOf: one toast for everything that arrived, the newest important one first", () => {
  const ev = (text, extra = {}) => ({ at: "x", kind: "note", text, ...extra });
  assert.equal(Core.toastOf([]), null);
  assert.deepEqual(Core.toastOf([ev("a")]), { shown: ev("a"), more: 0, sticky: false });
  assert.deepEqual(Core.toastOf([ev("a"), ev("b"), ev("c")]), { shown: ev("c"), more: 2, sticky: false });
  const urgent = ev("b", { important: true });
  assert.deepEqual(Core.toastOf([ev("a"), urgent, ev("c")]), { shown: urgent, more: 2, sticky: true }, "what needs the viewer is what is shown");
  assert.deepEqual(Core.toastOf([urgent, ev("c", { important: true })]).shown.text, "c");
});

test("parseState: a manager's state holds the coordinators, a coordinator's the way to its manager", () => {
  const base = { project: "p", goal: "g", status: "running", now: "n", started: "x" };
  const plain = Core.parseState(base);
  assert.deepEqual([plain.role, plain.coordinators, plain.manager], ["coordinator", [], null]);
  const led = Core.parseState({ ...base, manager: { id: "manager", url: "https://box/", session: "m" } });
  assert.deepEqual(led.manager, { id: "manager", url: "https://box/", session: "m" });
  assert.equal(Core.parseState({ ...base, manager: { id: "manager" } }).manager, null, "a manager that cannot be reached is none");
  const m = Core.parseState({ ...base, role: "manager", coordinators: [{ id: "billing", name: "acme-billing", status: "running", now: "landing", url: "https://box:1/", decisions: [{ id: "d1", title: "Schema", asks: "user", blocking: true }, { title: "no id" }] }, { name: "no id" }] });
  assert.equal(m.role, "manager");
  assert.deepEqual(m.coordinators.map((c) => [c.id, c.name, c.url, c.session, c.tokens, c.roadblocks, c.workers, c.lanes]), [["billing", "acme-billing", "https://box:1/", "", 0, 0, {}, []]]);
  assert.deepEqual(m.coordinators[0].decisions.map((d) => [d.id, d.asks, d.blocking, d.status]), [["d1", "user", true, "open"]]);
});

test("rosterOf: a manager's chat reaches the manager and the coordinators, by their fleet's name", () => {
  const state = Core.parseState({ project: "p", goal: "g", status: "running", now: "three fleets", started: "x", role: "manager",
    agents: [{ id: "w1", name: "release-notes", status: "running", task: "t" }],
    coordinators: [{ id: "billing", name: "acme-billing", status: "running", now: "landing the adapter" }, { id: "infra", name: "infra", status: "blocked", now: "waiting" }] });
  assert.deepEqual(Core.rosterOf(state).map((r) => [r.id, r.name, r.status, r.task]), [
    ["manager", "manager", "running", "three fleets"], ["w1", "release-notes", "running", "t"],
    ["billing", "billing", "running", "landing the adapter"], ["infra", "infra", "blocked", "waiting"]]);
});

test("decisionRows and leadOf: what is with the manager waits on the manager, after what waits on the viewer", () => {
  const rows = Core.decisionRows([
    item("d1", { asks: "manager", blocking: true, opened: "2026-09-28T09:00:00Z" }),
    item("d2", { opened: "2026-09-28T10:00:00Z" }),
    item("d3", { status: "decided", closed: "2026-09-28T11:00:00Z" }),
    item("billing/d1", { fleet: "billing", blocking: true }),
  ], {});
  assert.deepEqual(rows.map((r) => [r.item.id, r.mark]), [["billing/d1", ""], ["d2", "new"], ["d1", "new"], ["d3", ""]], "another fleet's row: that fleet's page knows whether it was seen");
  assert.deepEqual(Core.leadOf([item("d1", { asks: "manager", blocking: true })]), { headline: "Nothing waits on you.", detail: "", tone: "clear" });
  assert.deepEqual(Core.leadOf([item("d1", { asks: "manager", blocking: true }), item("d2")]), { headline: "1 decision waits on you.", detail: "Work goes on meanwhile.", tone: "waiting" });
});

test("usageOf: each window the status line saw, how full it is, and whether it has reset since", () => {
  const now = Date.parse("2026-09-28T22:00:00Z"), s = (iso) => Date.parse(iso) / 1000;
  const rows = Core.usageOf({ five_hour: { used_percentage: 42.4, resets_at: s("2026-09-29T01:00:00Z"), at: s("2026-09-28T21:59:30Z") },
    seven_day: { used_percentage: 91, resets_at: s("2026-10-05T21:00:00Z"), at: s("2026-09-28T21:50:00Z") } }, now);
  assert.deepEqual(rows, [
    { key: "five_hour", label: "Session, 5 hours", short: "session", percent: 42, tone: "ok", reset: false, resetsAt: Date.parse("2026-09-29T01:00:00Z"), readAt: Date.parse("2026-09-28T21:59:30Z") },
    { key: "seven_day", label: "Week, 7 days", short: "week", percent: 91, tone: "critical", reset: false, resetsAt: Date.parse("2026-10-05T21:00:00Z"), readAt: Date.parse("2026-09-28T21:50:00Z") }]);
  assert.equal(Core.usageOf({ five_hour: { used_percentage: 80, resets_at: s("2026-09-29T01:00:00Z"), at: 1 } }, now)[0].tone, "warning");
  const past = Core.usageOf({ five_hour: { used_percentage: 97, resets_at: s("2026-09-28T21:00:00Z"), at: s("2026-09-28T20:00:00Z") } }, now);
  assert.deepEqual([past[0].reset, past[0].tone, past[0].percent], [true, "ok", 0], "a window that reset since the reading starts again from nothing");
  for (const none of [null, undefined, {}, { five_hour: "soon" }, { five_hour: { used_percentage: "many", resets_at: 1 } }]) assert.deepEqual(Core.usageOf(none, now), []);
  assert.equal(Core.usageOf({ five_hour: { used_percentage: 140, resets_at: s("2026-09-29T01:00:00Z"), at: 1 } }, now)[0].percent, 100);
});

test("usageOthersOf: the other accounts' windows that have not reset, each account once, as sent", () => {
  const now = Date.parse("2026-09-28T22:00:00Z"), s = (iso) => Date.parse(iso) / 1000;
  const usage = { account: "home@example.com", seen: s("2026-09-28T21:59:00Z"), seven_day: { used_percentage: 30, resets_at: s("2026-10-05T21:00:00Z"), at: 1 },
    others: [
      { account: "work@example.com", seen: s("2026-09-28T14:00:00Z"), five_hour: { used_percentage: 41, resets_at: s("2026-09-28T21:00:00Z"), at: 1 }, seven_day: { used_percentage: 100, resets_at: s("2026-10-01T09:00:00Z"), at: 1 } },
      { account: null, seen: 5, seven_day: { used_percentage: 64, resets_at: s("2026-10-02T09:00:00Z"), at: 1 } },
      { account: "gone@example.com", seen: 4, five_hour: { used_percentage: 90, resets_at: s("2026-09-28T20:00:00Z"), at: 1 } }] };
  assert.deepEqual(Core.usageOf(usage, now).map((r) => [r.key, r.percent]), [["seven_day", 30]], "the account that worked last is the main reading");
  assert.deepEqual([Core.usageAccountOf(usage), Core.usageAccountOf(usage.others[1]), Core.usageAccountOf({ five_hour: {} }), Core.usageAccountOf(null)], ["home@example.com", null, null, null]);
  assert.deepEqual(Core.usageOthersOf(usage, now).map((o) => [o.account, o.rows.map((r) => [r.key, r.percent, r.tone])]), [
    ["work@example.com", [["seven_day", 100, "critical"]]],
    [null, [["seven_day", 64, "ok"]]]], "a window that reset says nothing of now, and an account with none left is left out");
  for (const none of [null, undefined, {}, usage.others[0], { others: "x" }, { others: [null, 3] }]) assert.deepEqual(Core.usageOthersOf(none, now), []);
});

test("parseState: what a coordinator itself spent is four figures, or none", () => {
  const base = { project: "p", goal: "g", status: "running", now: "n", started: "x" };
  assert.equal(Core.parseState(base).spent, null);
  assert.deepEqual(Core.parseState({ ...base, spent: { output: 100, input: 5000, cached: 4000, answers: 3, extra: 1 } }).spent, { output: 100, input: 5000, cached: 4000, answers: 3 });
  assert.equal(Core.parseState({ ...base, spent: { output: "many" } }).spent, null);
  const m = Core.parseState({ ...base, role: "manager", coordinators: [{ id: "a", spent: { output: 7, input: 9, cached: 8, answers: 1 } }, { id: "b" }] });
  assert.deepEqual(m.coordinators.map((c) => c.spent), [{ output: 7, input: 9, cached: 8, answers: 1 }, null]);
});

test("noticeOf: only what asks the viewer something open is important; routine flags are not", () => {
  const open = (id) => id === "d1";
  assert.deepEqual(Core.noticeOf({ kind: "asked", decision: "d1" }, open), { important: true, forYou: true });
  assert.deepEqual(Core.noticeOf({ kind: "asked", decision: "d2" }, open), { important: false, forYou: false }, "a decision already closed");
  assert.deepEqual(Core.noticeOf({ kind: "integrated", important: true }, open), { important: false, forYou: false });
  assert.deepEqual(Core.noticeOf({ kind: "note", decision: "d1" }, open), { important: false, forYou: true });
  assert.deepEqual(Core.noticeOf({ kind: "message" }, open), { important: false, forYou: true });
  assert.deepEqual(Core.noticeOf({ kind: "message", decision: "d1" }, open), { important: true, forYou: true });
});

test("hearingOf and unreadBy: the user's messages after what the host's watch read are unread", () => {
  assert.equal(Core.hearingOf(undefined), null);
  assert.equal(Core.hearingOf({ on: "yes", seen: 1 }), null);
  const h = Core.hearingOf({ on: false, seen: 37, unread: 2, since: "2026-09-29T07:47:40-05:00" });
  assert.deepEqual(h, { on: false, seen: 37, unread: 2, since: "2026-09-29T07:47:40-05:00" });
  assert.equal(Core.unreadBy(h, { id: 41, from: "user" }), true);
  assert.equal(Core.unreadBy(h, { id: 37, from: "user" }), false);
  assert.equal(Core.unreadBy(h, { id: 41, from: "coordinator" }), false);
  assert.equal(Core.unreadBy(null, { id: 41, from: "user" }), false, "a server that says nothing claims nothing");
});

test("parseState: the host's hearing and each coordinator's", () => {
  const st = Core.parseState({ project: "p", goal: "g", status: "running", now: "n", started: "x", chat: { on: true, seen: 3, unread: 0, since: null },
    coordinators: [{ id: "infra", chat: { on: false, seen: 37, unread: 5, since: "t" } }] });
  assert.deepEqual(st.hearing, { on: true, seen: 3, unread: 0, since: "" });
  assert.equal(st.coordinators[0].hearing.unread, 5);
});

test("staleNow: a now-line not said again for 30 minutes reads as stale", () => {
  const at = "2026-09-29T08:00:00-05:00", t = Date.parse(at);
  assert.equal(Core.staleNow(at, t + 29 * 60000), false);
  assert.equal(Core.staleNow(at, t + 31 * 60000), true);
  assert.equal(Core.staleNow(undefined, t), true, "a line never stamped reads as stale");
});

test("grillState: follow-ups under what they follow, sent answers until recorded, a reply hands it back", () => {
  const g = { id: "g1", kind: "grill", questions: [
    { id: "q1", title: "Where", body: "b", recommend: "tab", status: "open", of: null, asked: "2026-09-29T10:00:00Z" },
    { id: "q2", title: "Secrets", body: "b", recommend: "refs", status: "answered", answer: "refs", of: null, asked: "2026-09-29T10:00:00Z" },
    { id: "q3", title: "Order", body: "b", recommend: "newest", status: "open", of: "q1", asked: "2026-09-29T10:05:00Z" }] };
  let s = Core.grillState(g, []);
  assert.deepEqual(s.questions.map((e) => [e.q.id, e.depth]), [["q1", 0], ["q3", 1], ["q2", 0]]);
  assert.equal(s.toAnswer, 2);
  const sent = { id: 7, from: "user", decision: "g1", at: "2026-09-29T10:06:00Z", text: "Q1: a sidebar\nQ3: ok, as recommended (newest)", re: null };
  s = Core.grillState(g, [sent]);
  assert.equal(s.toAnswer, 0); assert.equal(s.waiting, 2);
  assert.equal(s.questions[0].sent.text, "a sidebar");
  s = Core.grillState(g, [sent, { id: 8, from: "coordinator", re: 7, text: "which sidebar?", at: "2026-09-29T10:07:00Z" }]);
  assert.equal(s.toAnswer, 2, "a reply to the answers hands both back");
  const early = { ...sent, at: "2026-09-29T10:01:00Z" };
  assert.equal(Core.grillState(g, [early]).questions[1].sent, null, "an answer sent before the question was asked is not its answer");
});

test("grillAnswerText: one line per question answered now", () => {
  const g = { questions: [{ id: "q1", recommend: "a tab" }, { id: "q2", recommend: "refs" }, { id: "q3", recommend: "x" }] };
  assert.deepEqual(Core.grillAnswerText(g, [{ id: "q1", pick: "rec", text: "" }, { id: "q2", pick: "own", text: "env\nvars" }, { id: "q3", pick: "later" }]),
    { text: "Q1: ok, as recommended (a tab)\nQ2: env vars" });
  assert.ok(Core.grillAnswerText(g, [{ id: "q1", pick: "own", text: " " }]).error);
  assert.ok(Core.grillAnswerText(g, [{ id: "q1", pick: "later" }]).error);
});

test("parseMessage keeps a quote and a side chat", () => {
  const m = Core.parseMessage({ id: 5, from: "user", to: ["coordinator"], text: "why?", side: 5, quote: { text: "14.1M", from: "Fleet" } });
  assert.deepEqual([m.quote, m.side], [{ text: "14.1M", from: "Fleet" }, 5]);
  assert.equal(Core.parseMessage({ id: 6, from: "user", to: [], text: "x", quote: { text: " " }, side: "5" }).quote, null);
});

test("parseMessage keeps where a quote was, and drops a place that is not one", () => {
  const at = { hash: "#decision/d1", anchor: "dv-info" };
  assert.deepEqual(Core.parseMessage({ id: 5, from: "user", to: [], text: "why?", quote: { text: "per line", from: "Rounding", at } }).quote, { text: "per line", from: "Rounding", at });
  assert.deepEqual(Core.parseMessage({ id: 5, from: "user", to: [], text: "x", quote: { text: "t", from: "", at: { hash: "#plan", message: "3", page: "/f/manager/" } } }).quote.at, { hash: "#plan", message: "3", page: "/f/manager/" });
  for (const bad of [{ hash: "plan" }, { hash: 5 }, "#plan", { hash: "#plan", message: 3 }, { hash: "#plan", page: "https://evil.example/" }]) {
    assert.deepEqual(Core.parseMessage({ id: 5, from: "user", to: [], text: "x", quote: { text: "t", from: "F", at: bad } }).quote, { text: "t", from: "F" });
  }
});

test("sidesOf: one per side chat, with its quote and how many messages it holds", () => {
  const ms = [{ id: 1, text: "main" }, { id: 2, side: 2, text: "what is l19?", quote: { text: "l19", from: "Plan" } },
    { id: 3, side: 2, text: "the watchdog fix" }, { id: 4, text: "main again" }, { id: 5, side: 5, text: "and this?", quote: null }];
  assert.deepEqual(Core.sidesOf(ms), [{ id: 2, quote: { text: "l19", from: "Plan" }, count: 2, last: 3, first: "what is l19?" },
    { id: 5, quote: null, count: 1, last: 5, first: "and this?" }]);
});

test("excerptOf: the selection with its blank space made one, cut to what a message carries", () => {
  assert.equal(Core.excerptOf("  a   b \n\n  c "), "a b\nc");
  assert.equal(Core.excerptOf("x"), "");
  assert.equal(Core.excerptOf("y".repeat(3000)).length, 2000);
});

test("awaiting: an answer sent stops the wait at once; a reply does not hand it back, a revision after it does", () => {
  const d = { id: "d1", kind: "decision", status: "open", asks: "user", opened: "2026-09-29T10:00:00Z" };
  const answer = { id: 4, from: "user", decision: "d1", at: "2026-09-29T10:05:00Z", text: "yes" };
  assert.equal(Core.awaiting(d, []), true);
  assert.equal(Core.awaiting(d, [answer]), false);
  const reply = { id: 5, from: "coordinator", re: 4, text: "Rerun when I post the new command", at: "2026-09-29T10:06:00Z" };
  assert.equal(Core.awaiting(d, [answer, reply]), false, "the fleet's reply leaves it with the fleet");
  assert.equal(Core.awaiting({ ...d, revised: "2026-09-29T10:30:00Z" }, [answer, reply]), true, "revised after the answer: it asks anew");
  assert.equal(Core.awaiting({ ...d, revised: "2026-09-29T10:01:00Z" }, [answer]), false, "revised before the answer");
  assert.equal(Core.awaiting({ ...d, answered: true }, []), false, "a fleet's decision on the manager's page");
  assert.equal(Core.awaiting({ ...d, asks: "manager" }, []), false);
  assert.equal(Core.awaiting({ ...d, status: "decided" }, []), false);
});

test("unreadNotice: opening a decision reads what came about it until then; a click reads one", () => {
  const e = { at: "2026-09-29T10:00:00Z", decision: "d1", kind: "asked" };
  const seen = (x) => ({ lastSeen: "", chatRead: 0, readOf: {}, readKeys: new Set(), ...x });
  assert.equal(Core.unreadNotice(e, "k", seen({})), true);
  assert.equal(Core.unreadNotice(e, "k", seen({ readOf: { d1: "2026-09-29T10:05:00Z" } })), false);
  assert.equal(Core.unreadNotice({ ...e, at: "2026-09-29T10:06:00Z" }, "k2", seen({ readOf: { d1: "2026-09-29T10:05:00Z" } })), true, "what came after the visit");
  assert.equal(Core.unreadNotice(e, "k", seen({ readKeys: new Set(["k"]) })), false);
  assert.equal(Core.unreadNotice({ at: e.at, chat: 7 }, "c", seen({ chatRead: 7 })), false);
  assert.equal(Core.unreadNotice(e, "k", seen({ lastSeen: "2026-09-29T11:00:00Z" })), false);
});

test("bucketOf: waits on you, waiting on someone else, or done", () => {
  const d = { id: "d1", kind: "decision", status: "open", asks: "user", opened: "2026-09-29T10:00:00Z" };
  const answer = { id: 4, from: "user", decision: "d1", at: "2026-09-29T10:05:00Z", text: "yes" };
  assert.equal(Core.bucketOf(d, []), "active");
  assert.equal(Core.bucketOf(d, [answer]), "waiting");
  assert.equal(Core.bucketOf({ ...d, asks: "manager" }, []), "waiting");
  assert.equal(Core.bucketOf({ ...d, status: "withdrawn" }, []), "done");
  const g = { id: "g1", kind: "grill", status: "open", asks: "user", opened: "x", questions: [{ id: "q1", title: "t", status: "answered", asked: "x" }] };
  assert.equal(Core.bucketOf(g, []), "waiting", "a grilling with nothing left to answer waits on the fleet");
  const q = { ...g, questions: [{ id: "q1", title: "t", status: "open", asked: "x" }] };
  assert.equal(Core.bucketOf(q, []), "active", "a grilling with questions left waits on you");
});

test("held: an item the fleet holds sits in Waiting with its reason, never stuck, until it is revised", () => {
  const d = { id: "a1", ref: "A1", title: "Run the pipeline role cut", kind: "action", status: "open", asks: "user", opened: "2026-09-29T10:00:00Z" };
  const answer = { id: 4, from: "user", decision: "a1", at: "2026-09-29T10:05:00Z", text: "it needs a code change first" };
  const held = { ...d, held: "fix the role cut first", held_at: "2026-09-29T10:06:00Z" };
  assert.equal(Core.isHeld(held), true);
  assert.equal(Core.isHeld({ ...held, status: "decided" }), false);
  assert.equal(Core.awaiting(held, [answer]), false);
  assert.equal(Core.awaiting(held, []), false, "held even with no answer on the page (said in the session)");
  assert.equal(Core.bucketOf(held, [answer]), "waiting");
  const now = Date.parse("2026-09-29T11:00:00Z");
  assert.deepEqual(Core.stuckOf({ decisions: [d] }, [], [answer], now).map((r) => [r.ref, r.what, r.kind]), [["A1", "answer not recorded", "action"]]);
  assert.equal(Core.stuckOf({ decisions: [held] }, [], [answer], now).length, 0, "the hold recorded the answer");
  const later = { ...answer, id: 6, at: "2026-09-29T10:20:00Z", text: "actually, run it" };
  assert.equal(Core.stuckOf({ decisions: [held] }, [], [answer, later], now).length, 1, "an answer after the hold is news again");
  const back = { id: "a1", ref: "A1", title: d.title, kind: "action", status: "open", asks: "user", opened: d.opened, revised: "2026-09-29T10:40:00Z" };
  assert.equal(Core.awaiting(back, [answer]), true, "revised (the hold cleared): back on your list");
  assert.equal(Core.leadOf([back]).headline, "1 action waits on you.");
});

test("kindCount: items named by kind, plural and mixed, three kinds or more as things", () => {
  const k = (...kinds) => kinds.map((kind) => ({ kind }));
  assert.equal(Core.kindCount(k("action")), "1 action waits");
  assert.equal(Core.kindCount(k("decision", "decision")), "2 decisions wait");
  assert.equal(Core.kindCount(k("action", "decision")), "1 decision and 1 action wait");
  assert.equal(Core.kindCount(k("grill", "input", "input")), "2 inputs and 1 grilling wait");
  assert.equal(Core.kindCount(k("decision", "action", "secret")), "3 things wait");
  assert.equal(Core.kindCount(k("poll")), "1 decision waits", "a kind the page does not know reads as a decision");
  assert.equal(Core.kindCount(k("action"), ["is", "are"]), "1 action is");
  assert.equal(Core.kindCount([]), "");
  assert.equal(Core.kindWord("grill"), "grilling");
  assert.equal(Core.leadOf([item("d1"), item("a1", { kind: "action", blocking: true })]).headline, "1 decision and 1 action wait on you.");
  assert.equal(Core.leadOf([item("s1", { kind: "secret" }), item("i1", { kind: "input" }), item("d1")]).headline, "3 things wait on you.");
});

test("stuckOf: an answer the fleet has not recorded after five minutes, a chat nobody reads", () => {
  const now = Date.parse("2026-09-29T15:40:00Z");
  const own = { decisions: [{ id: "d-a", ref: "A6", title: "Two things", kind: "action", status: "open", asks: "user", opened: "2026-09-29T15:13:00Z" }],
    hearing: { on: false, seen: 80, unread: 1, since: "2026-09-29T15:22:00Z" } };
  const answer = { id: 80, from: "user", decision: "d-a", at: "2026-09-29T15:18:00Z", text: "Done." };
  const rows = Core.stuckOf(own, [], [answer], now);
  assert.deepEqual(rows.map((r) => [r.ref, r.what]), [["A6", "answer not recorded"], ["", "chat not read"]]);
  assert.equal(Core.stuckOf(own, [], [answer], Date.parse("2026-09-29T15:20:00Z")).length, 0, "not before five minutes");
  const reply = { id: 81, from: "coordinator", to: ["user"], re: 80, at: "2026-09-29T15:19:00Z", text: "Recorded" };
  assert.deepEqual(Core.stuckOf({ decisions: own.decisions }, [], [answer, reply], now).map((r) => [r.ref, r.what]), [["A6", "answer not recorded"]],
    "a reply in the chat does not record it: only the decision command does");
  const fleets = [{ id: "infra", decisions: [{ id: "d-a", ref: "A6", title: "Two things", answered: "2026-09-29T15:18:00Z" }], hearing: { on: true, seen: 80, unread: 0 } }];
  assert.deepEqual(Core.stuckOf({ decisions: [] }, fleets, [], now).map((r) => [r.fleet, r.ref]), [["infra", "A6"]]);
});

test("glanceOf: running workers, current steps and the next ones, computed from the ledger", () => {
  const state = { agents: [{ id: "b1", name: "a", status: "running" }, { id: "b2", status: "done" }, { id: "b3", name: "c", status: "blocked" }],
    roadmap: [{ id: "m1", steps: [{ id: "l1", title: "x", status: "done" }, { id: "l2", title: "y", status: "current" }, { id: "l3", title: "z", status: "pending" }, { id: "l4", title: "w", status: "pending" }] }] };
  const g = Core.glanceOf(state, 1);
  assert.deepEqual(g.running, { shown: [{ id: "b1", name: "a", blocked: false }], more: 1 });
  assert.deepEqual(g.current.shown.map((s) => s.id), ["l2"]);
  assert.deepEqual([g.next.shown.map((s) => s.id), g.next.more], [["l3"], 1]);
});

test("closedInNow: a Now line naming a closed decision, in the ledger or in a fleet", () => {
  const own = [{ ref: "A6", title: "Unblock", status: "decided" }, { ref: "D2", title: "Open one", status: "open" }];
  const fleets = { "infra-coordinator": [{ ref: "I2", title: "Neon key", status: "decided" }] };
  assert.deepEqual(Core.closedInNow("Waits on Luiz: infra I2 and D2; A6 done", own, fleets).map((c) => [c.fleet, c.ref]), [["infra-coordinator", "I2"], ["", "A6"]]);
  assert.deepEqual(Core.closedInNow("Waits on Luiz: D2", own, fleets), []);
});

test("stuckOf: a running worker silent for twenty minutes, here or in a fleet", () => {
  const now = Date.parse("2026-09-29T17:00:00Z");
  const own = { decisions: [], agents: [{ id: "b50", name: "neon-latency", status: "running", active: "2026-09-29T16:30:00Z" },
    { id: "b51", status: "running", active: "2026-09-29T16:55:00Z" }, { id: "b52", status: "done", active: "2026-09-29T10:00:00Z" }] };
  assert.deepEqual(Core.stuckOf(own, [], [], now).map((r) => [r.ref, r.what]), [["b50", "worker silent"]]);
  const fleets = [{ id: "infra", decisions: [], silent: [{ id: "b42", name: "neo4j-container", active: "2026-09-29T16:07:00Z" }] }];
  assert.deepEqual(Core.stuckOf({ decisions: [] }, fleets, [], now).map((r) => [r.fleet, r.ref]), [["infra", "b42"]]);
});

test("notices: done under a standing approval, in no decision list, never waiting, stuck or counted; newest first", () => {
  const now = Date.parse("2026-10-09T17:00:00Z");
  const notice = (id, closed, extra = {}) => ({ id, ref: id.toUpperCase(), kind: "notice", title: id, question: "Landed it.", status: "decided", answer: "done", resolution: "under A1", under: "A1", undo: "jj undo", blocking: false, asks: "user", options: [], opened: closed, closed, ...extra });
  const open = { id: "d1", ref: "D1", kind: "decision", title: "Open", question: "?", status: "open", blocking: true, asks: "user", options: [], opened: "2026-10-09T16:00:00Z" };
  const n1 = notice("n1", "2026-10-09T16:10:00Z");
  const n2 = notice("n2", "2026-10-09T16:50:00Z");
  /* One the ledger left open, by mistake, still never waits. */
  const n3 = notice("n3", "2026-10-09T16:20:00Z", { status: "open", closed: undefined });
  const all = [open, n1, n2, n3];
  const answered = [{ id: 5, at: "2026-10-09T16:30:00Z", from: "user", to: ["coordinator"], text: "Landed?", decision: "n3" }];
  assert.deepEqual(Core.decisionRows(all, {}).map((r) => r.item.id), ["d1"]);
  assert.deepEqual(Core.queueOf(all, [], null).ids, ["d1"]);
  assert.deepEqual(all.filter((d) => Core.awaiting(d, [])).map((d) => d.id), ["d1"]);
  assert.equal(Core.bucketOf(n1, []), "done");
  assert.deepEqual(Core.stuckOf({ decisions: [n1, n2, n3] }, [], answered, now), []);
  assert.equal(Core.leadOf(all.filter((d) => Core.awaiting(d, []))).headline, "1 decision waits on you.");
  assert.deepEqual(Core.noticesOf(all).map((d) => d.id), ["n2", "n3", "n1"]);
  assert.equal(Core.isNotice(n1), true);
  assert.equal(Core.kindWord("notice"), "notice");
});

test("parseState and revokeText: standing approvals, active unless revoked, and the message that revokes one", () => {
  const base = { project: "p", goal: "g", status: "running", now: "n", started: "2026-10-09T10:00:00Z" };
  assert.deepEqual(Core.parseState(base).approvals, []);
  const s = Core.parseState({ ...base, approvals: [{ id: "A1", rule: "land a reviewed stack", by: "luiz", ref: "d7", message: 14, added: "2026-10-09T11:00:00Z", status: "active" }, { id: "A2", rule: "r", status: "revoked", revoked: "2026-10-09T12:00:00Z", revoked_why: "no" }, { rule: "no id" }, "x"] });
  assert.deepEqual(s.approvals.map((a) => [a.id, a.status, a.message, a.revoked_why]), [["A1", "active", 14, ""], ["A2", "revoked", null, "no"]]);
  assert.equal(Core.revokeText(s.approvals[0]), 'Revoke standing approval A1 ("land a reviewed stack"): routine acts under it go back to asking me.');
  assert.deepEqual(Core.viewOf("#approval-A1"), { view: "decisions", decision: null, anchor: "approval-A1" });
  assert.deepEqual(Core.viewOf("#approvals"), { view: "decisions", decision: null, anchor: "approvals" });
});
