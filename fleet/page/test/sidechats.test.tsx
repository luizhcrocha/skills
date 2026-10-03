/**
 * The side chats, organised: a list in the chat panel, newest activity first, the last hour's apart at its
 * top, each with its title, the item it is about, its last message's time and what is unread; searchable by
 * text and filtered by item; a side chat archived leaves the list for its Archived view until something new
 * is said in it, kept in this browser across a reload. Run in happy-dom; where the chat's scroll returns
 * to is `sidechats-browser.test.ts`'s.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { chatView, sideChats, type Message } from "./fixtures.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

beforeAll(() => setSystemTime(new Date(NOW)));

afterAll(() => setSystemTime());

let page: { m: Model; ui: Ui };

let dispose: (() => void) | undefined;

let root: HTMLElement;

const wire = (m: Message): Json => JSON.parse(JSON.stringify(m));

/** The page as a reload opens it: this browser's storage as it is, the conversation replayed. */
function load(): void {
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(chatView(NOW));

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();

  for (const m of sideChats(NOW)) page.ui.addMessage(wire(m), false);
  page.m.setConn("live");
  flush();
}

function reload(): void {
  dispose?.();
  root.remove();
  load();
}

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  /* The main chat was read up to #13, the last message before these side chats. */
  localStorage.setItem("fleet:/f/billing/chat-read", "13");
  location.hash = "";
  // SAFETY: the stub answers the calls the page makes with `fetch`; nothing else of `typeof fetch` is used.
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 404 })) as typeof fetch;
  load();
});

afterEach(() => {
  dispose?.();
  root.remove();
});

const q = <T extends Element = HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);

const click = (sel: string): void => {
  const el = q(sel);

  if (!el) throw new Error(`nothing at ${sel}`);
  el.click();
  flush();
};

/** The list's rows as words: a group's heading, or a side chat's id, title, item, time and unread count. */
const listSaid = (): string[] =>
  [...(q("#sl-rows")?.children ?? [])].map((li) =>
    li.classList.contains("sl-group")
      ? "## " + String(li.textContent)
      : [li.getAttribute("data-side"), li.querySelector(".sl-title")?.textContent, li.querySelector(".sl-about")?.textContent, li.querySelector("time")?.textContent, li.querySelector(".sl-unread")?.textContent ?? "0"].join(" | "),
  );

function search(text: string): void {
  const input = q<HTMLInputElement>("#sl-q");

  if (!input) throw new Error("no search");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

function filter(value: string): void {
  const select = q<HTMLSelectElement>("#sl-item");

  if (!select) throw new Error("no filter");
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flush();
}

test("the chat's tools lead to the side chats, with how many answers are unread in them", () => {
  expect(q("#side-list-btn")?.textContent).toBe("Side chats3");
  expect(q("#side-list-btn")?.getAttribute("aria-label")).toBe("Side chats, 3 unread");
  click("#side-list-btn");

  expect(q("#side-list")?.hidden).toBe(false);
  expect(q("#chat-log")?.hidden).toBe(true);
  expect(q("#composer")?.hidden).toBe(true);
});

test("the list: newest activity first, the last hour's at its top, each with its title, item, time and unread", () => {
  click("#side-list-btn");

  expect(listSaid()).toEqual([
    "## Last hour",
    "22 | Can we run it on 1k rows instead? | D18 Load check on the full ledger | 3 min ago | 2",
    "20 | Why is S1 still open? | the Plan | 29 min ago | 1",
    "## Earlier",
    "6 | Is that true for credit notes too? | D1 Rounding rule for totals | 2 h 29 min ago | 0",
  ]);
});

test("a side chat opens from the list, its answers read; Back to the chat leaves it, All side chats returns to the list", () => {
  click("#side-list-btn");
  click('#sl-rows [data-side="22"] .sl-open');

  expect(page.m.focus()).toBe(22);
  expect(q("#side-list")?.hidden).toBe(true);
  expect(q("#chat-log")?.hidden).toBe(false);
  expect(q("#side-head .side-about")?.textContent).toBe("D18 Load check on the full ledger");
  expect([...root.querySelectorAll("#chat-log article.msg")].map((a) => a.getAttribute("data-id"))).toEqual(["22", "23", "24"]);
  expect(q("#side-list-btn")?.textContent).toBe("Side chats1");

  click("#side-all");
  expect(q("#side-list")?.hidden).toBe(false);
  expect(listSaid()[1]).toBe("22 | Can we run it on 1k rows instead? | D18 Load check on the full ledger | 3 min ago | 0");

  click("#sl-back");
  expect(page.m.focus()).toBeNull();
  expect(q("#side-list")?.hidden).toBe(true);
  expect(q("#composer")?.hidden).toBe(false);
});

test("the list is searched in every message of each side chat, and its item", () => {
  click("#side-list-btn");
  search("credit");
  expect(listSaid()).toEqual(["## Earlier", "6 | Is that true for credit notes too? | D1 Rounding rule for totals | 2 h 29 min ago | 0"]);
  search("FINANCE");
  expect(listSaid().map((r) => r.split(" | ")[0])).toEqual(["## Last hour", "20"]);
  search("load check");
  expect(listSaid().map((r) => r.split(" | ")[0])).toEqual(["## Last hour", "22"]);
  search("nothing like this");
  expect(listSaid()).toEqual([]);
  expect(q(".sl-empty")?.textContent).toBe("No side chat matches.");
});

test("the list is filtered by the item a side chat is about", () => {
  click("#side-list-btn");
  expect([...(q<HTMLSelectElement>("#sl-item")?.options ?? [])].map((o) => `${o.value}=${o.textContent}`)).toEqual([
    "=All items",
    "d:d1=D1 Rounding rule for totals",
    "d:d18=D18 Load check on the full ledger",
    "q:the Plan=the Plan",
  ]);
  filter("d:d18");
  expect(listSaid().map((r) => r.split(" | ")[0])).toEqual(["## Last hour", "22"]);
  filter("q:the Plan");
  expect(listSaid().map((r) => r.split(" | ")[0])).toEqual(["## Last hour", "20"]);
  filter("");
  expect(listSaid().length).toBe(5);
});

test("a side chat archived leaves the list for Archived, stays so across a reload, and comes back unarchived", () => {
  click("#side-list-btn");
  click('#sl-rows [data-side="20"] .sl-arch');
  expect(listSaid().map((r) => r.split(" | ")[0])).toEqual(["## Last hour", "22", "## Earlier", "6"]);
  expect(q("#sl-archived")?.textContent).toBe("Archived 1");

  reload();
  click("#side-list-btn");
  expect(listSaid().map((r) => r.split(" | ")[0])).toEqual(["## Last hour", "22", "## Earlier", "6"]);
  click("#sl-archived");
  expect(q("#sl-archived")?.getAttribute("aria-pressed")).toBe("true");
  expect(listSaid().map((r) => r.split(" | ")[0])).toEqual(["## Last hour", "20"]);
  expect(q('#sl-rows [data-side="20"] .sl-arch')?.getAttribute("aria-label")).toBe("Unarchive");
  click('#sl-rows [data-side="20"] .sl-arch');
  expect(listSaid()).toEqual([]);

  reload();
  click("#side-list-btn");
  expect(listSaid().map((r) => r.split(" | ")[0])).toEqual(["## Last hour", "22", "20", "## Earlier", "6"]);
});

test("a side chat is archived from its own head too, and something new said in it brings it back", () => {
  click("#side-list-btn");
  click('#sl-rows [data-side="6"] .sl-open');
  expect(q("#side-archive")?.textContent).toBe("Archive");
  click("#side-archive");
  expect(q("#side-archive")?.textContent).toBe("Unarchive");
  click("#side-all");
  expect(listSaid().map((r) => r.split(" | ")[0])).toEqual(["## Last hour", "22", "20"]);

  page.ui.addMessage({ id: 30, at: new Date(NOW).toISOString(), from: "coordinator", to: ["user"], text: "Credit notes: one more case.", side: 6 }, true);
  flush();
  expect(listSaid().map((r) => r.split(" | ")[0])).toEqual(["## Last hour", "6", "22", "20"]);
});
