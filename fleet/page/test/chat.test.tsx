/**
 * The chat laid out as a messenger, in happy-dom, on a day and a half of conversation (`chatConversation`):
 * the viewer's messages and the fleet's apart, runs of one sender, day separators, reply quotes, side
 * chats, decision activity left out (a marker each when asked for, a thread on the decision's page), and a
 * message appended in place with the draft kept. Where things sit on the screen is `browser.test.ts`'s.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { decisionThread } from "../src/chatlog.ts";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { chatConversation, chatView, type Message } from "./fixtures.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

// The page labels days ("Today", "Yesterday") from its own clock: hold it at NOW, or the labels move with the calendar.
beforeAll(() => setSystemTime(new Date(NOW)));

afterAll(() => setSystemTime());

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

/** A message as the stream carries it: plain JSON. */
const wire = (m: Message): Json => JSON.parse(JSON.stringify(m));

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  // SAFETY: the stub answers the calls the page makes with `fetch`; nothing else of `typeof fetch` is used.
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 404 })) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(chatView(NOW));

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();

  for (const m of chatConversation(NOW)) page.ui.addMessage(wire(m), false);
  page.m.setConn("live");
  flush();
});

afterEach(() => {
  dispose();
  root.remove();
});

const log = (): HTMLElement => {
  const el = root.querySelector<HTMLElement>("#chat-log");

  if (!el) throw new Error("no chat log");

  return el;
};

/** The turn (the row) of message `id` in the chat. */
const turn = (id: number): HTMLElement | null | undefined => log().querySelector(`article.msg[data-id="${id}"]`)?.closest<HTMLElement>("li.turn");

/** The chat's rows as words: a day, a message's id and side, a marker, a side chat. */
const rowsSaid = (): string[] =>
  [...log().children].map((li) =>
    li.classList.contains("day")
      ? "day " + String(li.textContent)
      : li.classList.contains("turn")
        ? `${li.classList.contains("from-user") ? "me" : "fleet"} #${String(li.querySelector("article")?.getAttribute("data-id"))}`
        : li.classList.contains("dmark")
          ? "mark #" + String(li.getAttribute("data-id"))
          : li.classList.contains("side-link")
            ? "side"
            : String(li.className),
  );

test("the viewer's messages and the fleet's are told apart, each under a day, with no decision activity", () => {
  expect(rowsSaid()).toEqual(["day Yesterday", "me #1", "fleet #2", "fleet #3", "day Today", "fleet #4", "fleet #5", "side", "fleet #10", "me #11", "fleet #12", "me #13"]);
  expect(turn(4)?.querySelector(".turn-head .who")?.textContent).toBe("invoice-gen");
  expect(turn(4)?.getAttribute("style")).toContain("var(--s2)");
  expect(turn(13)?.querySelector(".wait")?.textContent).toBe("Not read yet");
  expect(turn(1)?.querySelector(".wait")?.textContent).toBe("Answered");
  expect(root.querySelector("#chat-decisions")?.getAttribute("aria-checked")).toBe("false");
  expect(root.querySelector<HTMLElement>("#chat-decisions-note")?.hidden).toBe(false);
  expect(root.querySelector("#chat-decisions-note")?.textContent).toBe("2 decision messages hidden");
});

test("a run of one sender within five minutes is one name and time; a later message starts a run", () => {
  expect(turn(2)?.classList.contains("head")).toBe(true);
  expect(turn(2)?.classList.contains("tail")).toBe(false);
  expect(turn(3)?.classList.contains("head")).toBe(false);
  expect(turn(3)?.querySelector(".turn-head")).toBeNull();
  expect(turn(3)?.classList.contains("tail")).toBe(true);
  expect(turn(5)?.querySelector(".turn-head")).toBeNull();
  /* #10 is the coordinator's too, but long after #3: a run of its own. */
  expect(turn(10)?.querySelector(".turn-head time")?.getAttribute("datetime")).toBe(chatConversation(NOW)[9]?.at ?? "");
});

test("a reply quotes what it answers on one line, unless that is right above it; a tap on the quote shows it", () => {
  const re = turn(11)?.querySelector<HTMLButtonElement>(".re-line");

  expect(re?.dataset["goto"]).toBe("4");
  expect(re?.querySelector("b")?.textContent).toBe("invoice-gen");
  expect(re?.querySelector("span")?.textContent).toBe("Round 2 done: the generator writes every invoice of the sample ledger (412 rows) in 1.8 s…");
  expect(turn(12)?.querySelector(".re-line")).toBeNull();
  expect(turn(2)?.querySelector(".re-line")).toBeNull();

  re?.click();
  flush();
  expect(log().querySelector('article.msg[data-id="4"]')?.classList.contains("found")).toBe(true);
  expect(page.m.reply()).toBeNull();
});

test("a side chat is a link where its last message falls, and opens on its quote and messages", () => {
  log().querySelector<HTMLButtonElement>(".side-link button")?.click();
  flush();

  expect(rowsSaid()).toEqual(["day Today", "me #6", "fleet #7"]);
  expect(turn(6)?.querySelector(".msg-quote")?.textContent).toBe("From D1 Rounding rule for totalsStripe rounds on the total; matching it avoids one-cent drift.");
});

test("decision activity is left out by default, a marker each when asked for, and remembered", () => {
  expect(log().querySelector('[data-id="8"]')).toBeNull();
  expect(log().querySelector('[data-id="9"]')).toBeNull();

  root.querySelector<HTMLButtonElement>("#chat-decisions")?.click();
  flush();

  expect(rowsSaid()).toEqual(["day Yesterday", "me #1", "fleet #2", "fleet #3", "day Today", "fleet #4", "fleet #5", "side", "mark #8", "mark #9", "fleet #10", "me #11", "fleet #12", "me #13"]);
  const answer = log().querySelector<HTMLElement>('.dmark[data-id="8"]');
  const ack = log().querySelector<HTMLElement>('.dmark[data-id="9"]');

  expect(answer?.querySelector("a")?.getAttribute("href")).toBe("#decision/d18");
  expect(answer?.querySelector(".dmark-line")?.textContent).toBe("You answered D18 · None of these: Re-run after the cost improvements work is done");
  expect(ack?.querySelector(".dmark-line")?.textContent).toBe("coordinator on D18: Recorded D18: the load check waits for the cost work, and I re-run it the day that lands.");
  expect(answer?.querySelector("article")).toBeNull();
  expect(localStorage.getItem("fleet:/f/billing/chat-decisions")).toBe("true");
  expect(root.querySelector<HTMLElement>("#chat-decisions-note")?.hidden).toBe(true);
  /* #10 follows a marker: it starts its run again. */
  expect(turn(10)?.classList.contains("head")).toBe(true);
});

test("a decision's page holds its thread: the answer on the viewer's side, the acknowledgement on the fleet's", () => {
  location.hash = "#decision/d18";
  page.ui.route();
  flush();
  const thread = root.querySelector("#dv-thread");

  expect(thread?.querySelector("h3")?.textContent).toBe("In the chat");
  expect([...(thread?.querySelectorAll("li.turn") ?? [])].map((li) => `${li.classList.contains("from-user") ? "me" : "fleet"} ${String(li.querySelector(".msg-text")?.textContent)}`)).toEqual([
    "me None of these: Re-run after the cost improvements work is done",
    "fleet Recorded D18: the load check waits for the cost work, and I re-run it the day that lands.",
  ]);
  expect(thread?.querySelector(".reply-btn")).toBeNull();
  /* D1's thread is the side chat opened on a quote of its page. */
  expect(decisionThread(page.m.messages(), "d1").map((it) => it.message.id)).toEqual([6, 7]);

  location.hash = "#decision/g1";
  page.ui.route();
  flush();
  expect(root.querySelector("#dv-thread")).toBeNull();
});

test("a later reply to the decision's thread joins it, and stays out of the chat", () => {
  page.ui.addMessage({ id: 14, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: "And tell me when it ran.", re: 9 }, true);
  flush();

  expect(log().querySelector('[data-id="14"]')).toBeNull();
  expect(decisionThread(page.m.messages(), "d18").map((it) => it.message.id)).toEqual([8, 9, 14]);
});

test("the Chat tab counts unread decision activity only while the chat shows it", () => {
  page.m.setCollapsed(true);
  flush();
  const badge = (): string | null => (root.querySelector<HTMLElement>("#chat-badge")?.hidden ? null : (root.querySelector("#chat-badge")?.textContent ?? null));

  expect(badge()).toBeNull();
  page.ui.addMessage({ id: 14, at: new Date(NOW).toISOString(), from: "coordinator", to: ["user"], text: "D18: noted again.", re: 8 }, true);
  flush();
  expect(badge()).toBeNull();
  page.ui.addMessage({ id: 15, at: new Date(NOW).toISOString(), from: "coordinator", to: ["user"], text: "The adapter is unblocked." }, true);
  flush();
  expect(badge()).toBe("1");
  page.m.setDecisionActivity(true);
  flush();
  expect(badge()).toBe("2");
});

test("the finder leads to a decision's page for activity the chat leaves out", () => {
  page.ui.go({ key: "c:9", pill: "", group: "Chat", ref: "#9", title: "", sub: "", hint: "", go: { kind: "message", id: 9, side: null } }, false);
  flush();
  expect(location.hash).toBe("#decision/d18");
});

test("a new message is appended in place: every row keeps its node, the draft and the open reply stay", () => {
  const say = root.querySelector<HTMLTextAreaElement>("#say");

  if (!say) throw new Error("no composer");
  page.ui.replyTo(12);
  say.value = "half a reply";
  say.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  const rows = [...log().children];
  const articles = [...log().querySelectorAll("article.msg")];
  const tail = turn(12);

  page.ui.addMessage({ id: 14, at: new Date(NOW + 60_000).toISOString(), from: "a2", to: ["user"], text: "And the PR is green." }, true);
  flush();

  const now = [...log().children];
  expect(now.length).toBe(rows.length + 1);
  rows.forEach((r, i) => expect(now[i]).toBe(r));
  articles.forEach((a) => expect(a.isConnected).toBe(true));
  expect(turn(14) === now.at(-1)).toBe(true);
  expect(turn(12)).toBe(tail);
  expect(say.value).toBe("half a reply");
  expect(page.m.reply()).toBe(12);
  expect(turn(12)?.querySelector("article")?.classList.contains("replying")).toBe(true);

  /* One more from the same sender within five minutes joins its run: the earlier one's node stays, it is no longer the tail. */
  page.ui.addMessage({ id: 15, at: new Date(NOW + 120_000).toISOString(), from: "a2", to: ["user"], text: "Merged." }, true);
  flush();
  expect(turn(14) === now.at(-1)).toBe(true);
  expect(turn(14)?.classList.contains("tail")).toBe(false);
  expect(turn(15)?.querySelector(".turn-head")).toBeNull();
});
