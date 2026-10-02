/**
 * A quote remembers where it was taken (`quote.at`: the page's address, a part of it, or a chat message),
 * and the chat shows its label as a link back there: Reply and Side chat record the place, the post
 * carries it, and a click on the label opens the place and marks the quoted text. Run in happy-dom.
 */
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import type { DetachedWindowAPI } from "happy-dom";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorChat, coordinatorView, managerView, type Message, type View } from "./fixtures.ts";

/** happy-dom's handle on the window the tests run in. */
declare const happyDOM: DetachedWindowAPI;

const NOW = Date.now();

let page: { m: Model; ui: Ui };

let dispose: (() => void) | undefined;

let root: HTMLElement;

/** Every post the page made to the hub's chat. */
const posted: Json[] = [];

/** A message as the stream carries it: plain JSON. */
const wire = (m: Message): Json => JSON.parse(JSON.stringify(m));

/** The page at `address`, with `view` and `messages`, the chat live, posts to `chat` answered 201. */
function open(address: string, view: View, messages: readonly Message[] = []): void {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  posted.length = 0;
  history.replaceState(null, "", address);
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, a post to chat, else not found.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "skills") return new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 });

    if (url === "chat") {
      const body: { text: string; quote?: Json } = JSON.parse(String(init?.body));
      posted.push(body);

      return new Response(JSON.stringify({ id: 90 + posted.length, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text, quote: body.quote ?? null }), { status: 201 });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  /* A fleet's frame on the manager's page loads an empty page, in happy-dom's own fetch. */
  happyDOM.settings.fetch.interceptor = { beforeAsyncRequest: async ({ window: w }) => new w.Response("<!doctype html><title>billing</title>", { headers: { "Content-Type": "text/html" } }) };
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();

  for (const m of messages) page.ui.addMessage(wire(m), false);
  page.m.setConn("live");
  flush();
  page.ui.route();
  flush();
}

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  getSelection()?.removeAllRanges();
  dispose?.();
  root.remove();
  history.replaceState(null, "", "/f/billing/");
  happyDOM.setViewport({ width: 1280, height: 900 });
});

const tool = (): HTMLElement | null => document.getElementById("seltool");

/** Select the text of `selector` as a keyboard would, and wait for the toolbar to show. */
async function select(selector: string): Promise<string> {
  const el = root.querySelector(selector);

  if (!el) throw new Error(`nothing at ${selector}`);
  const range = document.createRange();
  range.selectNodeContents(el);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await new Promise((r) => setTimeout(r, 300));
  flush();
  expect(tool()?.hidden).toBe(false);

  return String(getSelection());
}

/** Press one of the toolbar's buttons. */
function press(sel: "reply" | "side"): void {
  tool()?.querySelector<HTMLButtonElement>(`[data-sel="${sel}"]`)?.click();
  flush();
}

/** Write `text` on the composer and send it. */
async function send(text: string): Promise<void> {
  const say = root.querySelector<HTMLTextAreaElement>("#say");

  if (say) say.value += text;
  page.ui.afterEdit();
  await page.ui.send();
  flush();
}

/** A message of the viewer's quoting `quote`. */
const quoting = (id: number, quote: NonNullable<Message["quote"]>): Message => ({ id, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: "why?", author: "luiz@example.com", quote });

const label = (id: number): Element | null | undefined => root.querySelector(`#chat-log article.msg[data-id="${id}"] .msg-quote .from`);

const marked = (): string[] => [...document.querySelectorAll(".found")].map((el) => el.id || el.getAttribute("data-id") || String(el.textContent).trim().slice(0, 60));

test("Reply on a decision's text records the decision's address and the part of its page, and the post carries it", async () => {
  open("/f/billing/#decision/d1", coordinatorView(NOW));
  const text = await select("#dv-info .dv-question");
  press("reply");
  const at = { hash: "#decision/d1", anchor: "dv-info" };
  expect(page.m.quote()).toEqual({ text, from: "Rounding rule for totals", at });
  await send("per line, why not?");
  expect(posted).toEqual([{ text: "per line, why not?", quote: { text, from: "Rounding rule for totals", at } }]);
});

test("Side chat on a chat message's text records the message", async () => {
  open("/f/billing/#plan", coordinatorView(NOW), coordinatorChat(NOW));
  page.ui.openChat();
  flush();
  const text = await select('#chat-log article.msg[data-id="4"] .msg-text');
  press("side");
  expect(page.m.focus()).toBe("new");
  expect(page.m.quote()).toEqual({ text, from: "the chat, invoice-gen", at: { hash: "#plan", message: "4" } });
});

test("on the manager's page, Reply on a fleet's framed decision records the manager's address of it", async () => {
  open("/f/manager/#decision/billing/d1", managerView(NOW));
  const frame = root.querySelector<HTMLIFrameElement>("#dv-embed");
  // SAFETY: happy-dom's MessageEvent takes a window as its source, as a browser's does.
  const source = frame?.contentWindow as MessageEventSource;
  const select = { text: "per line or on the total", rect: { top: 100, bottom: 118, left: 40, width: 60 }, from: "Rounding rule for totals", touch: false, at: { hash: "#decision/d1", anchor: "dv-info" } };
  window.dispatchEvent(new MessageEvent("message", { data: { fleetEmbed: true, select }, source }));
  flush();
  press("reply");
  expect(page.m.quote()).toEqual({ text: "per line or on the total", from: "Rounding rule for totals, in billing", at: { hash: "#decision/billing/d1", anchor: "dv-info" } });
});

test("a quote's label with its place is a link: a click opens the place and marks the quoted text", () => {
  const quote = { text: "per line or on the total", from: "Rounding rule for totals", at: { hash: "#decision/d1", anchor: "dv-info" } };
  open("/f/billing/#plan", coordinatorView(NOW), [quoting(6, quote)]);
  const link = label(6);
  expect([link?.tagName, link?.getAttribute("href"), link?.textContent]).toEqual(["A", "#decision/d1", "From Rounding rule for totals"]);
  link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  flush();
  expect([location.hash, page.m.viewing()]).toEqual(["#decision/d1", "d1"]);
  const found = document.querySelector("#dv-info .found");
  expect(found?.textContent).toContain("per line or on the total");
  expect(marked()).toHaveLength(1);
});

test("a quote of a chat message leads to it in the chat, in its side chat, and marks it", () => {
  const side: Message = { id: 7, at: new Date(NOW).toISOString(), from: "coordinator", to: ["user"], text: "An aside on the key.", side: 7 };
  open("/f/billing/#plan", coordinatorView(NOW), [...coordinatorChat(NOW), side, quoting(8, { text: "An aside", from: "the chat, coordinator", at: { hash: "#plan", message: "7" } })]);
  page.ui.openChat();
  flush();
  label(8)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  flush();
  expect([location.hash, page.m.focus()]).toEqual(["#plan", 7]);
  expect(marked()).toEqual(["7"]);
});

test("an old quote with no place shows its label as text, as before", () => {
  open("/f/billing/#plan", coordinatorView(NOW), [quoting(6, { text: "per line", from: "Rounding rule for totals" })]);
  const from = label(6);
  expect([from?.tagName, from?.getAttribute("href"), from?.textContent]).toEqual(["SPAN", null, "From Rounding rule for totals"]);
  expect(root.querySelector('#chat-log article.msg[data-id="6"] .msg-quote')?.textContent).toBe("From Rounding rule for totalsper line");
});

test("on a phone, the link closes the chat over the page and lands on the place", () => {
  happyDOM.setViewport({ width: 390, height: 844 });
  open("/f/billing/#plan", coordinatorView(NOW), [quoting(6, { text: "per line or on the total", from: "Rounding rule for totals", at: { hash: "#decision/d1", anchor: "dv-info" } })]);
  page.ui.openChat();
  flush();
  expect([page.m.docked(), page.m.chatOpen()]).toEqual([false, true]);
  label(6)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  flush();
  expect([page.m.chatOpen(), page.m.viewing()]).toEqual([false, "d1"]);
  expect(document.querySelector("#dv-info .found")).not.toBeNull();
});

test("a place on another page, as a fleet's copy of the manager's message carries it, links to that page", () => {
  open("/f/billing/#plan", coordinatorView(NOW), [quoting(6, { text: "the gate", from: "the Plan", at: { hash: "#plan", page: "/f/manager/" } })]);
  expect(label(6)?.getAttribute("href")).toBe("/f/manager/#plan");
});
