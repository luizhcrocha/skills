/**
 * "Ask in the chat" on a decision, an action or a grilling is Reply and Side chat on the whole item: the
 * composer opens (docked, or the overlay on a phone) with a chip quoting the item (its ref and title, the
 * question as the text, its page as `at`, a link back there), in the main chat or in a new side chat, with
 * @mentions and /skills, and the message carries no `decision` (that would make it an answer). The item's
 * thread on its page shows what was asked about it. Inside the manager's frame, the frame asks the manager,
 * whose composer writes to the fleet's coordinator as the selection toolbar's Reply does. Run in happy-dom.
 */
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import type { DetachedWindowAPI } from "happy-dom";

import { App } from "../src/App.tsx";
import { decisionThread } from "../src/chatlog.ts";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, managerView, type View } from "./fixtures.ts";

/** happy-dom's handle on the window the tests run in. */
declare const happyDOM: DetachedWindowAPI;

const NOW = Date.now();

let page: { m: Model; ui: Ui };

let dispose: (() => void) | undefined;

let root: HTMLElement;

/** Every post the page made to the hub's chat, and to its parent window. */
const posted: Json[] = [];

const toParent: Json[] = [];

const SKILLS = [{ name: "tstack:tdd", description: "Test-first development.", hint: "[what to fix]", source: "plugin" }];

/** The page at `address`, with `view`, the chat live, posts to `chat` answered 201. */
function open(address: string, view: View, width = 1280): void {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  posted.length = 0;
  toParent.length = 0;
  happyDOM.setViewport({ width, height: 900 });
  history.replaceState(null, "", address);
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, a post to chat, else not found.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "skills") return new Response(JSON.stringify({ skills: SKILLS, builtins: false }), { status: 200 });

    if (url === "chat") {
      const body: { text: string; quote?: Json; side?: Json } = JSON.parse(String(init?.body));
      posted.push(body);
      const side = body.side === "new" ? 90 + posted.length : (body.side ?? null);

      return new Response(JSON.stringify({ id: 90 + posted.length, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text, quote: body.quote ?? null, side }), { status: 201 });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  happyDOM.settings.fetch.interceptor = { beforeAsyncRequest: async ({ window: w }) => new w.Response("<!doctype html><title>billing</title>", { headers: { "Content-Type": "text/html" } }) };
  // SAFETY: the page posts plain JSON to its parent; the test keeps it instead.
  window.postMessage = ((data: Json) => void toParent.push(data)) as typeof window.postMessage;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.m.setConn("live");
  flush();
  page.ui.route();
  flush();
}

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  dispose?.();
  root.remove();
  document.documentElement.classList.remove("embed");
  history.replaceState(null, "", "/f/billing/");
  happyDOM.setViewport({ width: 1280, height: 900 });
});

function go(hash: string): void {
  location.hash = hash;
  page.ui.route();
  flush();
}

const say = (): HTMLTextAreaElement => {
  const el = root.querySelector<HTMLTextAreaElement>("#say");

  if (!el) throw new Error("no composer");

  return el;
};

/** Type `text` into the composer with the caret at its end. */
async function type(text: string): Promise<void> {
  const el = say();
  el.focus();
  el.value = text;
  el.setSelectionRange(text.length, text.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

const D1_QUOTE = { text: "How should invoice totals round: per line or on the total?", from: "D1 Rounding rule for totals", at: { hash: "#decision/d1", anchor: "dv-info" } };

test("Ask in the chat opens the composer with the item as a quote: its ref and title, a link back, in the main chat", async () => {
  open("/f/billing/#decision/d1", coordinatorView(NOW));
  page.m.setCollapsed(true);
  flush();
  root.querySelector<HTMLButtonElement>("#dv-answer [data-discuss]")?.click();
  flush();

  expect(page.m.chatCollapsed()).toBe(false);
  expect(page.m.focus()).toBeNull();
  expect(page.m.quote()).toEqual(D1_QUOTE);
  expect(root.querySelector<HTMLElement>("#quote")?.hidden).toBe(false);
  expect(root.querySelector("#quote-text")?.textContent).toBe("Quoting D1 Rounding rule for totals: How should invoice totals round: per line or on the total?");
  expect(root.querySelector("#quote-text a")?.getAttribute("href")).toBe("#decision/d1");
  expect(document.activeElement).toBe(say());

  await type("what does Stripe do?");
  await page.ui.send();
  await settle();
  expect(posted).toEqual([{ text: "what does Stripe do?", quote: D1_QUOTE }]);
  expect(page.m.quote()).toBeNull();
});

test("Side chat on an item opens a new side chat about it; the post carries side 'new' and no decision", async () => {
  open("/f/billing/#decision/d1", coordinatorView(NOW));
  root.querySelector<HTMLButtonElement>("#dv-answer [data-discuss-side]")?.click();
  flush();

  expect(page.m.focus()).toBe("new");
  expect(root.querySelector("#quote-text")?.textContent).toBe("Side chat on D1 Rounding rule for totals: How should invoice totals round: per line or on the total?");
  await type("is per line ever right?");
  await page.ui.send();
  await settle();
  expect(posted).toEqual([{ text: "is per line ever right?", quote: D1_QUOTE, side: "new" }]);
  expect(page.m.focus()).toBe(91);
});

test("on a phone the item's ask opens the chat's overlay, as Reply does", () => {
  open("/f/billing/#decision/d1", coordinatorView(NOW), 390);
  root.querySelector<HTMLButtonElement>("#dv-answer [data-discuss]")?.click();
  flush();
  expect(page.m.chatOpen()).toBe(true);
  expect(page.m.quote()).toEqual(D1_QUOTE);
  page.ui.closeChat();
  flush();
});

test("the item's ask lists people after @ and skills after /, as the composer does", async () => {
  open("/f/billing/#decision/d1", coordinatorView(NOW));
  await page.m.loadSkills();
  root.querySelector<HTMLButtonElement>("#dv-answer [data-discuss]")?.click();
  flush();
  await type("@inv");
  expect(root.querySelector<HTMLElement>("#mentions")?.hidden).toBe(false);
  expect(root.querySelector("#mentions")?.getAttribute("aria-label")).toBe("Mention someone");
  await type("/tst");
  await settle();
  expect(root.querySelector<HTMLElement>("#mentions")?.hidden).toBe(false);
  expect([...root.querySelectorAll("#mentions li .m-name")].map((li) => li.textContent)).toEqual(["tstack:tdd"]);
  expect(page.m.quote()).toEqual(D1_QUOTE);
});

test("an action and a grilling offer both, and quote their own ref and title", () => {
  const view = coordinatorView(NOW);
  // SAFETY: the fixture's decisions are records, as coordinatorView writes them.
  const decisions = view["decisions"] as View[];
  open("/f/billing/#decision/g1", { ...view, decisions: [...decisions, { id: "a8", ref: "A2", kind: "action", title: "Delete the cache", question: "Delete the volume?", status: "open", blocking: false, asks: "user", opened: new Date(NOW).toISOString(), options: [] }] });

  root.querySelector<HTMLButtonElement>("#dv-answer [data-discuss-side]")?.click();
  flush();
  expect(page.m.quote()?.from).toBe("G1 The notes feature");
  expect(page.m.quote()?.at).toEqual({ hash: "#decision/g1", anchor: "dv-info" });

  go("#decision/a8");
  root.querySelector<HTMLButtonElement>("#dv-answer [data-discuss]")?.click();
  flush();
  expect(page.m.quote()).toEqual({ text: "Delete the volume?", from: "A2 Delete the cache", at: { hash: "#decision/a8", anchor: "dv-info" } });
  expect(page.m.focus()).toBeNull();
});

test("the chip's link goes back to the item", () => {
  open("/f/billing/#decision/d1", coordinatorView(NOW));
  root.querySelector<HTMLButtonElement>("#dv-answer [data-discuss]")?.click();
  flush();
  go("#plan");
  root.querySelector<HTMLAnchorElement>("#quote-text a")?.click();
  flush();
  expect(location.hash).toBe("#decision/d1");
  expect(page.m.quote()).toEqual(D1_QUOTE);
});

test("what was asked about an item, and the replies, are its thread on its page, in the main chat or a side chat", () => {
  open("/f/billing/#decision/d1", coordinatorView(NOW));
  const at = new Date(NOW).toISOString();
  page.ui.addMessage({ id: 30, at, from: "user", to: ["coordinator"], text: "what does Stripe do?", quote: D1_QUOTE }, true);
  page.ui.addMessage({ id: 31, at, from: "coordinator", to: ["user"], text: "It rounds the total.", re: 30 }, true);
  page.ui.addMessage({ id: 32, at, from: "user", to: ["coordinator"], text: "side question", quote: D1_QUOTE, side: 32 }, true);
  page.ui.addMessage({ id: 33, at, from: "user", to: ["coordinator"], text: "and a follow-up", side: 32 }, true);
  page.ui.addMessage({ id: 34, at, from: "user", to: ["coordinator"], text: "about something else" }, true);
  flush();

  expect(decisionThread(page.m.messages(), "d1").map((it) => it.message.id)).toEqual([30, 31, 32, 33]);
  expect([...root.querySelectorAll("#dv-thread article.msg")].map((a) => a.getAttribute("data-id"))).toEqual(["30", "31", "32", "33"]);
  /* Asked in the main chat, it stays in the main chat too. */
  expect(root.querySelector('#chat-log article.msg[data-id="30"]')).not.toBeNull();
});

test("Change my answer is the item's ask with its first words", () => {
  const view = coordinatorView(NOW);
  // SAFETY: the fixture's decisions are records, as coordinatorView writes them.
  const decisions = view["decisions"] as View[];
  open("/f/billing/#decision/d1", { ...view, decisions: decisions.map((d) => (d["id"] === "d1" ? { ...d, status: "decided", answer: "b: Round the total", closed: new Date(NOW).toISOString() } : d)) });
  root.querySelector<HTMLButtonElement>("#dv-answer [data-change]")?.click();
  flush();
  expect(page.m.quote()).toEqual(D1_QUOTE);
  expect(say().value).toBe("I want to change my answer. ");
  expect([say().selectionStart, say().selectionEnd]).toEqual([28, 28]);
});

test("in the manager's frame, Ask in the chat and Side chat ask the manager, with the item, and write nothing in the frame", () => {
  open("/f/billing/?embed=1#decision/d1", coordinatorView(NOW));
  root.querySelector<HTMLButtonElement>("#dv-answer [data-discuss]")?.click();
  root.querySelector<HTMLButtonElement>("#dv-answer [data-discuss-side]")?.click();
  flush();
  const item = { id: "d1", ref: "D1", title: "Rounding rule for totals", question: "How should invoice totals round: per line or on the total?" };

  expect(toParent.filter((d) => d !== null && Object(d) === d && "ask" in Object(d))).toEqual([
    { fleetEmbed: true, ask: { ...item, side: false, text: "" } },
    { fleetEmbed: true, ask: { ...item, side: true, text: "" } },
  ]);
  expect(root.querySelector("#dv-ask")).toBeNull();
  expect(posted).toEqual([]);
});

test("on the manager's page, the frame's ask opens the manager's composer to the fleet's coordinator, the item quoted at its address there", async () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  const frame = root.querySelector<HTMLIFrameElement>("#dv-embed");
  const item = { id: "d1", ref: "D1", title: "Rounding rule for totals", question: "Per line or on the total?" };

  window.dispatchEvent(new MessageEvent("message", { data: { fleetEmbed: true, ask: { ...item, side: true, text: "" } }, source: frame?.contentWindow ?? null }));
  flush();
  const quote = { text: "Per line or on the total?", from: "D1 Rounding rule for totals, in billing", at: { hash: "#decision/billing/d1", anchor: "dv-info" } };
  expect(page.m.quote()).toEqual(quote);
  expect(page.m.focus()).toBe("new");
  expect(say().value).toBe("@billing ");
  expect(document.activeElement).toBe(say());

  /* Another window's message is not the frame's. */
  page.m.setQuote(null);
  window.dispatchEvent(new MessageEvent("message", { data: { fleetEmbed: true, ask: { ...item, side: false, text: "" } }, source: window }));
  flush();
  expect(page.m.quote()).toBeNull();

  window.dispatchEvent(new MessageEvent("message", { data: { fleetEmbed: true, ask: { ...item, side: false, text: "I want to change my answer. " } }, source: frame?.contentWindow ?? null }));
  flush();
  expect(page.m.focus()).toBeNull();
  expect(say().value).toBe("@billing I want to change my answer. ");
  await type(say().value + "per line");
  await page.ui.send();
  await settle();
  expect(posted).toEqual([{ text: "@billing I want to change my answer. per line", quote }]);
});
