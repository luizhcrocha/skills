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
  assert.deepEqual(m, { id: 3, at: "2026-09-28T10:00:00Z", from: "a1", to: ["user"], text: "hi", re: 1, parts: [{ text: "hi" }], decision: "d1", author: "" });
  assert.deepEqual(Core.parseMessage({ id: 1, from: "user", to: [], text: "x" }), { id: 1, at: "", from: "user", to: [], text: "x", re: null, parts: [{ text: "x" }], decision: "", author: "" });
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
    item("billing/d1", { href: "https://box:1/#decision/d1", blocking: true }),
  ], {});
  assert.deepEqual(rows.map((r) => [r.item.id, r.mark]), [["billing/d1", ""], ["d2", "new"], ["d1", "new"], ["d3", ""]], "another fleet's row is opened on that fleet's page, which knows whether it was seen");
  assert.deepEqual(Core.leadOf([item("d1", { asks: "manager", blocking: true })]), { headline: "Nothing waits on you.", detail: "", tone: "clear" });
  assert.deepEqual(Core.leadOf([item("d1", { asks: "manager", blocking: true }), item("d2")]), { headline: "1 decision waits on you.", detail: "Work goes on meanwhile.", tone: "waiting" });
});

test("usageOf: each window the status line saw, how full it is, and whether it has reset since", () => {
  const now = Date.parse("2026-09-28T22:00:00Z"), s = (iso) => Date.parse(iso) / 1000;
  const rows = Core.usageOf({ five_hour: { used_percentage: 42.4, resets_at: s("2026-09-29T01:00:00Z"), at: s("2026-09-28T21:59:30Z") },
    seven_day: { used_percentage: 91, resets_at: s("2026-10-05T21:00:00Z"), at: s("2026-09-28T21:50:00Z") } }, now);
  assert.deepEqual(rows, [
    { key: "five_hour", label: "Session, 5 hours", percent: 42, tone: "ok", reset: false, resetsAt: Date.parse("2026-09-29T01:00:00Z"), readAt: Date.parse("2026-09-28T21:59:30Z") },
    { key: "seven_day", label: "Week, 7 days", percent: 91, tone: "critical", reset: false, resetsAt: Date.parse("2026-10-05T21:00:00Z"), readAt: Date.parse("2026-09-28T21:50:00Z") }]);
  assert.equal(Core.usageOf({ five_hour: { used_percentage: 80, resets_at: s("2026-09-29T01:00:00Z"), at: 1 } }, now)[0].tone, "warning");
  const past = Core.usageOf({ five_hour: { used_percentage: 97, resets_at: s("2026-09-28T21:00:00Z"), at: s("2026-09-28T20:00:00Z") } }, now);
  assert.deepEqual([past[0].reset, past[0].tone, past[0].percent], [true, "ok", 0], "a window that reset since the reading starts again from nothing");
  for (const none of [null, undefined, {}, { five_hour: "soon" }, { five_hour: { used_percentage: "many", resets_at: 1 } }]) assert.deepEqual(Core.usageOf(none, now), []);
  assert.equal(Core.usageOf({ five_hour: { used_percentage: 140, resets_at: s("2026-09-29T01:00:00Z"), at: 1 } }, now)[0].percent, 100);
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
  assert.equal(Core.staleNow(undefined, t), false, "a state from before now_at claims nothing");
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
