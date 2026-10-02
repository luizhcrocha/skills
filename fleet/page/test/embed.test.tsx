/**
 * Working through what waits on the user from the manager's page: a fleet's decision opens on the manager's
 * own decision page, as that fleet's page in a frame (`?embed=1`); the frame shows the decision alone and
 * tells the manager its height and an answer sent; the manager steps to the previous and next, and once one
 * is answered goes on to the next (or, with that turned off, says what comes next); text selected in the frame
 * shows the manager's selection toolbar over it, and its Reply writes to that fleet's coordinator; what would
 * open the fleet's chat (Change my answer, Ask in the chat) writes in the frame itself. Run in happy-dom.
 */
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import type { DetachedWindowAPI } from "happy-dom";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import { evidence } from "../src/DecisionPage.tsx";
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

/** The page at `address`, with `view`, the chat live, posts to `chat` answered 201. */
function open(address: string, view: View): void {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  posted.length = 0;
  toParent.length = 0;
  history.replaceState(null, "", address);
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, a post to chat, else not found.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "skills") return new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 });

    if (url === "chat") {
      const body: { text: string; decision?: string; re?: number } = JSON.parse(String(init?.body));
      posted.push(body);

      return new Response(JSON.stringify({ id: 98 + posted.length, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text, decision: body.decision, re: body.re }), { status: 201 });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  /* The frame loads an empty page of the fleet, in happy-dom's own fetch. */
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
}

function go(hash: string): void {
  location.hash = hash;
  page.ui.route();
  flush();
}

/** The page once the hash changes and the posts made settle, as a browser runs them after the event. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

/** The switch "Go to the next once answered", turned off. */
function stayOnAnswer(): void {
  const toggle = root.querySelector<HTMLButtonElement>("#dv-advance");
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  toggle?.click();
  flush();
  expect(toggle?.getAttribute("aria-checked")).toBe("false");
}

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  dispose?.();
  root.remove();
  document.documentElement.classList.remove("embed");
  history.replaceState(null, "", "/f/billing/");
});

const frame = (): HTMLIFrameElement | null => root.querySelector<HTMLIFrameElement>("#dv-embed");

const queueLine = (): string => root.querySelector("#dv-queue .dv-queue-row .dv-meta")?.textContent ?? "";

const before = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

/** The manager's view with `fleet`'s open decisions replaced by `decisions`. */
function withFleet(view: View, fleet: string, decisions: View[]): View {
  // SAFETY: the fixture's coordinators are records, as managerView writes them.
  const coordinators = view["coordinators"] as View[];

  return { ...view, coordinators: coordinators.map((c) => (c["id"] === fleet ? { ...c, decisions } : c)) };
}

const INFRA_D4: View = { id: "d4", ref: "D4", kind: "decision", title: "Pin the nix channel", question: "Pin it?", why: "", blocking: false, asks: "user", opened: before(20), revised: null, answered: null };

const queueHref = (rel: string): string | null | undefined => root.querySelector(`#dv-queue a[data-queue="${rel}"]`)?.getAttribute("href");

/** A message from `source`, as a frame's postMessage arrives. */
function arrive(data: Json, source: Window | null | undefined): void {
  // SAFETY: happy-dom's MessageEvent takes a window as its source, as a browser's does.
  window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
  flush();
}

test("on the manager's page a fleet's decision opens on the manager's own page, as that fleet's page in a frame", () => {
  open("/f/manager/", managerView(NOW));
  const row = root.querySelector<HTMLAnchorElement>("#decision-list a.ask");
  expect(row?.getAttribute("href")).toBe("#decision/billing/d1");
  go("#decision/billing/d1");
  expect(root.querySelector("#decision")?.hasAttribute("hidden")).toBe(false);
  expect(frame()?.getAttribute("src")).toBe("/f/billing/?embed=1#decision/d1");
  expect(frame()?.getAttribute("title")).toBe("D1 Rounding rule for totals, in billing");
  expect(root.querySelector("#decision .dv-back")?.getAttribute("href")).toBe("#decisions");
  expect(root.querySelector("#dv-info")).toBeNull();
  expect(queueLine()).toBe("1 of 2 waiting on you");
});

test("the frame is sized by the height it reports, and only its own messages count", () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  arrive({ fleetEmbed: true, height: 1200 }, window);
  expect(frame()?.style.height).toBe("");
  arrive({ fleetEmbed: true, height: 640.4 }, frame()?.contentWindow);
  expect(frame()?.style.height).toBe("641px");
});

test("previous and next walk what waits on the user, in the list's order, the manager's own included", () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  const next = root.querySelector<HTMLAnchorElement>('#dv-queue a[data-queue="next"]');
  expect(next?.getAttribute("href")).toBe("#decision/d9");
  expect(root.querySelector('#dv-queue a[data-queue="prev"]')).toBeNull();
  go("#decision/d9");
  expect(queueLine()).toBe("2 of 2 waiting on you");
  expect(root.querySelector('#dv-queue a[data-queue="prev"]')?.getAttribute("href")).toBe("#decision/billing/d1");
  expect(root.querySelector("#dv-embed")).toBeNull();
  expect(root.querySelector("#dv-info h1")?.textContent).toBe("D1 Which fleet gets the gate first");
});

test("an answer sent in the frame goes on to the next, says which was answered, and Previous goes back to it", async () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  arrive({ fleetEmbed: true, answered: "d2" }, frame()?.contentWindow);
  await settle();
  expect(location.hash).toBe("#decision/billing/d1");
  arrive({ fleetEmbed: true, answered: "d1" }, frame()?.contentWindow);
  expect(root.querySelector("#dv-answered")).toBeNull();
  await settle();
  expect(location.hash).toBe("#decision/d9");
  expect(page.m.viewing()).toBe("d9");
  expect(root.querySelector("#dv-advanced")?.textContent).toBe("Answered D1 Rounding rule for totals in billing.");
  expect(root.querySelector("#dv-advanced")?.getAttribute("role")).toBe("status");
  expect(root.querySelector("#dv-answered")).toBeNull();
  expect(document.activeElement).toBe(root.querySelector("#decision"));
  expect(queueHref("prev")).toBe("#decision/billing/d1");
  go("#decision/billing/d1");
  expect(root.querySelector("#dv-advanced")).toBeNull();
});

test("going to another decision by any other way clears the note of the one answered", async () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  arrive({ fleetEmbed: true, answered: "d1" }, frame()?.contentWindow);
  await settle();
  expect(root.querySelector("#dv-advanced")).not.toBeNull();
  go("#decisions");
  go("#decision/d9");
  expect(root.querySelector("#dv-advanced")).toBeNull();
});

test("turned off, an answer sent in the frame says what comes next, with Next focused, and stays on the page", async () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  stayOnAnswer();
  arrive({ fleetEmbed: true, answered: "d2" }, frame()?.contentWindow);
  expect(root.querySelector("#dv-answered")).toBeNull();
  arrive({ fleetEmbed: true, answered: "d1" }, frame()?.contentWindow);
  expect(root.querySelector("#dv-answered")?.textContent).toBe("Answered. Next: D1 Which fleet gets the gate first");
  expect(document.activeElement).toBe(root.querySelector('#dv-queue a[data-queue="next"]'));
  await settle();
  expect(location.hash).toBe("#decision/billing/d1");
  expect(root.querySelector("#dv-advanced")).toBeNull();
});

/** The manager's view with billing's d1 answered, as the next state tells it. */
function billingAnswered(view: View): string {
  const billing = Core.parseState(view)?.coordinators.find((c) => c.id === "billing");
  const d1 = { ...billing?.decisions[0], answered: new Date(NOW).toISOString() };
  // SAFETY: the fixture's coordinators are records, as managerView writes them.
  const coordinators = view["coordinators"] as View[];

  return JSON.stringify({ ...view, coordinators: coordinators.map((c) => (c["id"] === "billing" ? { ...c, decisions: [d1] } : c)) });
}

test("a fleet's decision that leaves the queue on the next state goes on to the next", async () => {
  const view = managerView(NOW);
  open("/f/manager/", view);
  go("#decision/billing/d1");
  page.m.takeState(billingAnswered(view));
  flush();
  await settle();
  expect(location.hash).toBe("#decision/d9");
  expect(root.querySelector("#dv-advanced")?.textContent).toBe("Answered D1 Rounding rule for totals in billing.");
  expect(document.activeElement).toBe(root.querySelector("#decision"));
  expect(queueHref("prev")).toBe("#decision/billing/d1");
});

test("turned off, a fleet's decision that leaves the queue on the next state is answered too", async () => {
  const view = managerView(NOW);
  open("/f/manager/", view);
  go("#decision/billing/d1");
  stayOnAnswer();
  page.m.takeState(billingAnswered(view));
  flush();
  expect(root.querySelector("#dv-answered")?.textContent).toBe("Answered. Next: D1 Which fleet gets the gate first");
  expect(queueLine()).toBe("1 waiting on you");
  await settle();
  expect(location.hash).toBe("#decision/billing/d1");
  go("#decision/d9");
  expect(root.querySelector("#dv-answered")).toBeNull();
});

test("going on is a setting kept in this browser, on unless turned off", () => {
  open("/f/manager/", managerView(NOW));
  expect(page.m.advance()).toBe(true);
  go("#decision/billing/d1");
  stayOnAnswer();
  dispose?.();
  root.remove();
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(managerView(NOW));

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  expect(page.m.advance()).toBe(false);
  page.ui.route();
  flush();
  expect(root.querySelector("#dv-advance")?.getAttribute("aria-checked")).toBe("false");
});

test("a fleet's decision answered and then gone from the next state keeps Next on the one that followed it", () => {
  const view = withFleet(managerView(NOW), "infra", [INFRA_D4]);
  open("/f/manager/", view);
  go("#decision/infra/d4");
  stayOnAnswer();
  expect(queueLine()).toBe("2 of 3 waiting on you");
  arrive({ fleetEmbed: true, answered: "d4" }, frame()?.contentWindow);
  page.m.takeState(JSON.stringify(withFleet(view, "infra", [])));
  flush();
  expect([queueHref("prev"), queueHref("next")]).toEqual(["#decision/billing/d1", "#decision/d9"]);
  expect(root.querySelector("#dv-answered")?.textContent).toBe("Answered. Next: D1 Which fleet gets the gate first");
  expect(frame()?.getAttribute("src")).toBe("/f/infra/?embed=1#decision/d4");
});

test("the manager's own decision, answered and then decided, keeps Next on the one that followed it", async () => {
  const d8 = { id: "d8", ref: "D2", kind: "decision", title: "Name the release", question: "Which name?", status: "open", blocking: false, asks: "user", opened: before(5), options: [{ id: "a", label: "Ada", consequence: "" }] };
  const view = managerView(NOW);
  // SAFETY: the fixture's decisions are records, as managerView writes them.
  const own = view["decisions"] as View[];
  open("/f/manager/", { ...view, decisions: [...own, d8] });
  go("#decision/d9");
  stayOnAnswer();
  root.querySelector<HTMLInputElement>('#dv-answer input[name="choice"][value="a"]')?.click();
  root.querySelector<HTMLFormElement>("#dv-answer form")?.requestSubmit();
  await new Promise((r) => setTimeout(r, 0));
  flush();
  expect(root.querySelector("#dv-answered")?.textContent).toBe("Answered. Next: D2 Name the release");
  page.m.takeState(JSON.stringify({ ...view, decisions: [{ ...own[0], status: "decided", answer: "a: Billing", closed: before(0) }, d8] }));
  flush();
  expect([queueHref("prev"), queueHref("next")]).toEqual(["#decision/billing/d1", "#decision/d8"]);
  expect(root.querySelector("#dv-answered")?.textContent).toBe("Answered. Next: D2 Name the release");
});

test("on the manager's page the Stuck box and the finder open a fleet's decision on the manager's own page", () => {
  const d1: View = { id: "d1", ref: "D1", kind: "decision", title: "Rounding rule for totals", question: "Per line or on the total?", why: "", blocking: true, asks: "user", opened: before(40), revised: null, answered: before(10) };
  open("/f/manager/", withFleet(managerView(NOW), "billing", [d1]));
  expect([...root.querySelectorAll<HTMLAnchorElement>("#lead .stuck a")].map((a) => a.getAttribute("href"))).toContain("#decision/billing/d1");
  page.ui.go({ group: "decisions", ref: "D1", title: "Rounding rule for totals", sub: "", hint: "billing, open", go: { kind: "decision", id: "billing/d1" } }, false);
  page.ui.route();
  flush();
  expect(location.hash).toBe("#decision/billing/d1");
  expect(frame()?.getAttribute("src")).toBe("/f/billing/?embed=1#decision/d1");
});

test("a fleet's grilling waits on the user on the manager's page while its own page would: questions left that the user has not answered in that fleet's chat", () => {
  const asked = before(30);
  const q = (id: string): View => ({ id, of: null, status: "open", asked });
  const said = (id: number, text: string, decision: string | null, more: View = {}): View => ({ id, at: before(20), from: "user", to: ["coordinator"], text, re: null, decision, ...more });
  const grill = (id: string, questions: View[], heard: View[], answered: string | null): View => ({ id, ref: id, kind: "grill", title: "Grilling " + id, question: "q", why: null, blocking: false, asks: "user", opened: asked, revised: null, answered, questions, said: heard });

  /* As the summary sends them: G3 every question answered (the fleet's turn), G4 none (the user's), G5 every
     one answered in the fleet's chat, G6 one of two; d5 answered there and replied to by the fleet. */
  open(
    "/f/manager/",
    withFleet(managerView(NOW), "billing", [
      grill("G3", [], [], null),
      grill("G4", [q("q1"), q("q2")], [], null),
      grill("G5", [q("q1")], [said(1, "Q1: yes", "G5")], before(20)),
      grill("G6", [q("q1"), q("q2")], [said(2, "Q1: yes", "G6")], before(20)),
      { ...INFRA_D4, id: "d5", ref: "D5", said: [said(3, "a", "d5"), { ...said(4, "which a?", null, { from: "coordinator", to: ["user"], re: 3 }), at: before(19) }] },
    ]),
  );
  const listed = (): (string | null)[] => [...root.querySelectorAll<HTMLAnchorElement>("#decision-list a.ask")].map((a) => a.getAttribute("href"));

  expect(listed().toSorted()).toEqual(["#decision/billing/G4", "#decision/billing/G6", "#decision/d9"]);
  expect(page.m.queue().ids.toSorted()).toEqual(["billing/G4", "billing/G6", "d9"]);
  root.querySelector<HTMLButtonElement>('[data-bucket="waiting"]')?.click();
  flush();
  expect(listed().toSorted()).toEqual(["#decision/billing/G3", "#decision/billing/G5", "#decision/billing/d5"]);
});

test("on a fleet's own page a <fleet>/<id> address names no decision, as before", () => {
  open("/f/billing/", coordinatorView(NOW));
  go("#decision/billing/d1");
  expect(page.m.viewing()).toBeNull();
  expect(root.querySelector("#app")?.hasAttribute("hidden")).toBe(false);
  expect(root.querySelector("#decision")?.hasAttribute("hidden")).toBe(true);
});

test("the manager's own decision answered on its page says nothing else waits when it was the last", async () => {
  open("/f/manager/", { ...managerView(NOW), coordinators: [] });
  go("#decision/d9");
  root.querySelector<HTMLInputElement>('#dv-answer input[name="choice"][value="a"]')?.click();
  root.querySelector<HTMLFormElement>("#dv-answer form")?.requestSubmit();
  await new Promise((r) => setTimeout(r, 0));
  flush();
  expect(posted).toHaveLength(1);
  expect(root.querySelector("#dv-answered")?.textContent).toBe("Answered. Nothing else waits on you.");
  expect(toParent).toEqual([]);
  await settle();
  expect(location.hash).toBe("#decision/d9");
  expect(root.querySelector("#dv-advanced")).toBeNull();
});

test("embedded, a fleet's page is its decision alone, tells its height, and tells the manager of an answer", async () => {
  open("/f/billing/?embed=1#decision/d1", coordinatorView(NOW));
  page.ui.route();
  flush();
  expect(document.documentElement.classList.contains("embed")).toBe(true);

  for (const id of ["masthead", "app", "chat", "toasts", "finder"]) expect([id, document.getElementById(id)]).toEqual([id, null]);
  expect(root.querySelector("#decision .dv-back")).toBeNull();
  expect(root.querySelector("#dv-queue")).toBeNull();
  expect(root.querySelector("#dv-info h1")?.textContent).toBe("D1 Rounding rule for totals");
  expect(root.querySelector("#dv-answer button[data-discuss]")).not.toBeNull();
  expect(toParent).toContainEqual({ fleetEmbed: true, height: expect.any(Number) });
  root.querySelector<HTMLInputElement>('#dv-answer input[name="choice"][value="b"]')?.click();
  root.querySelector<HTMLFormElement>("#dv-answer form")?.requestSubmit();
  await new Promise((r) => setTimeout(r, 0));
  flush();
  expect(posted).toEqual([{ text: "b: Round the total", decision: "d1" }]);
  expect(toParent).toContainEqual({ fleetEmbed: true, answered: "d1" });
});

test("embedded, a grilling tells the manager it was answered only once nothing is left to answer", async () => {
  const q = (id: string): View => ({ id, title: "Q " + id, body: "?", recommend: "yes", status: "open", asked: before(15) });
  const grill: View = { id: "g2", ref: "G2", kind: "grill", title: "Two questions", question: "Two questions", status: "open", blocking: false, asks: "user", opened: before(15), options: [], questions: [q("q1"), q("q2")] };
  open("/f/billing/?embed=1#decision/g2", { ...coordinatorView(NOW), decisions: [grill] });
  page.ui.route();
  flush();

  const answer = async (qid: string): Promise<void> => {
    root.querySelector<HTMLInputElement>(`#dv-answer fieldset[data-q="${qid}"] input[value="rec"]`)?.click();
    root.querySelector<HTMLFormElement>("#dv-answer form")?.requestSubmit();
    await new Promise((r) => setTimeout(r, 0));
    flush();
  };

  await answer("q1");
  expect(posted).toHaveLength(1);
  expect(toParent).not.toContainEqual({ fleetEmbed: true, answered: "g2" });
  await answer("q2");
  expect(posted).toHaveLength(2);
  expect(toParent).toContainEqual({ fleetEmbed: true, answered: "g2" });
});

test("embedded, a fleet message makes no notification and the chat is not marked read", () => {
  open("/f/billing/?embed=1#decision/d1", coordinatorView(NOW));
  page.ui.addMessage({ id: 50, at: new Date(NOW).toISOString(), from: "coordinator", to: ["user"], text: "Picked up." }, true);
  flush();
  expect(page.ui.notify.toast()).toBeNull();
  expect(page.m.read()).toBe(0);
});

test("viewed normally, the fleet's page keeps its masthead, chat and back link, and no queue", () => {
  open("/f/billing/", coordinatorView(NOW));
  go("#decision/d1");
  expect(document.documentElement.classList.contains("embed")).toBe(false);
  expect(document.getElementById("masthead")).not.toBeNull();
  expect(document.getElementById("chat")).not.toBeNull();
  expect(root.querySelector("#decision .dv-back")).not.toBeNull();
  expect(root.querySelector("#dv-queue")).toBeNull();
  expect(root.querySelector("#dv-answer button[data-discuss]")).not.toBeNull();
});

/** `el` placed at `top`, `left` of its viewport, as a browser lays it out. */
function placeAt<T extends Element>(el: T | null | undefined, top: number, left: number): T {
  if (!el) throw new Error("nothing to place");
  el.getBoundingClientRect = () => new DOMRect(left, top, 800, 600);

  return el;
}

const tool = (): HTMLElement | null => document.getElementById("seltool");

const SELECTED = { text: "per line or on the total", rect: { top: 100, bottom: 118, left: 40, width: 60 }, from: "Rounding rule for totals", touch: false };

test("text selected in a fleet's frame shows the manager's toolbar over it, and Reply writes to that fleet's coordinator", async () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  const f = placeAt(frame(), 200, 30);
  arrive({ fleetEmbed: true, select: SELECTED }, f.contentWindow);
  expect(tool()?.hidden).toBe(false);
  expect([tool()?.style.top, tool()?.style.left]).toEqual(["292px", "100px"]);
  expect([...(tool()?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual(["Copy", "Reply", "Side chat"]);
  tool()?.querySelector<HTMLButtonElement>('[data-sel="reply"]')?.click();
  flush();
  expect(tool()?.hidden).toBe(true);
  const say = root.querySelector<HTMLTextAreaElement>("#say");
  expect(say?.value).toBe("@billing ");
  expect(document.activeElement).toBe(say);
  expect(root.querySelector("#quote-text")?.textContent).toBe("Quoting Rounding rule for totals, in billing: per line or on the total");

  if (say) say.value += "why not per line?";
  page.ui.afterEdit();
  await page.ui.send();
  expect(posted).toEqual([{ text: "@billing why not per line?", quote: { text: "per line or on the total", from: "Rounding rule for totals, in billing" } }]);
});

test("Side chat on text selected in a fleet's frame opens a side chat addressed to that fleet's coordinator", () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  arrive({ fleetEmbed: true, select: SELECTED }, frame()?.contentWindow);
  tool()?.querySelector<HTMLButtonElement>('[data-sel="side"]')?.click();
  flush();
  expect(root.querySelector<HTMLTextAreaElement>("#say")?.value).toBe("@billing ");
  expect(page.m.focus()).toBe("new");
  expect(root.querySelector("#quote-text")?.textContent).toBe("Side chat on Rounding rule for totals, in billing: per line or on the total");
});

test("a selection from anything but the fleet's frame is ignored, and the frame's cleared selection hides the toolbar", () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  arrive({ fleetEmbed: true, select: SELECTED }, window);
  arrive({ fleetEmbed: true, select: SELECTED }, null);
  expect(tool()?.hidden).toBe(true);
  arrive({ fleetEmbed: true, select: SELECTED }, frame()?.contentWindow);
  expect(tool()?.hidden).toBe(false);
  arrive({ fleetEmbed: true, select: { text: "", rect: null, from: "" } }, window);
  expect(tool()?.hidden).toBe(false);
  arrive({ fleetEmbed: true, select: { text: "", rect: null, from: "" } }, frame()?.contentWindow);
  expect(tool()?.hidden).toBe(true);
});

/** The selections the embedded page told its parent of. */
const selects = (): Json[] => toParent.filter((d) => d !== null && Object(d) === d && !Array.isArray(d) && "select" in Object(d));

test("embedded, the fleet's page tells the manager of text selected in it once it rests, and of the selection cleared", async () => {
  open("/f/billing/?embed=1#decision/d1", coordinatorView(NOW));
  page.ui.route();
  flush();
  const range = document.createRange();
  range.selectNodeContents(root.querySelector("#dv-info h1") ?? root);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  expect(selects()).toEqual([]);
  await new Promise((r) => setTimeout(r, 250));
  const rect = { top: expect.any(Number), bottom: expect.any(Number), left: expect.any(Number), width: expect.any(Number) };
  expect(selects()).toEqual([{ fleetEmbed: true, select: { text: String(getSelection()), rect, from: "Rounding rule for totals", touch: false } }]);
  expect(String(getSelection())).toContain("Rounding rule for totals");
  getSelection()?.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  await new Promise((r) => setTimeout(r, 250));
  expect(selects().at(-1)).toEqual({ fleetEmbed: true, select: { text: "", rect: null, from: "", touch: false } });
});

test("embedded, the fleet's page passes its evidence frame's selection on to the manager, placed in the page", () => {
  const view = coordinatorView(NOW);
  // SAFETY: the fixture's decisions are records, as coordinatorView writes them.
  const decisions = view["decisions"] as View[];
  open("/f/billing/?embed=1#decision/d1", { ...view, decisions: decisions.map((d) => (d["id"] === "d1" ? { ...d, body: true } : d)) });
  page.ui.route();
  flush();
  const ev = placeAt(evidence.frame, 300, 16);
  arrive({ fleetSelect: true, text: "one-cent drift", rect: { top: 10, bottom: 28, left: 5, width: 90 }, touch: true }, ev.contentWindow);
  expect(selects()).toEqual([{ fleetEmbed: true, select: { text: "one-cent drift", rect: { top: 310, bottom: 328, left: 21, width: 90 }, from: "the evidence of Rounding rule for totals", touch: true } }]);
  arrive({ fleetSelect: true, text: "elsewhere", rect: { top: 1, bottom: 2, left: 3, width: 4 } }, window);
  arrive({ fleetSelect: true, text: "", rect: null }, ev.contentWindow);
  expect(selects()).toEqual([
    { fleetEmbed: true, select: { text: "one-cent drift", rect: { top: 310, bottom: 328, left: 21, width: 90 }, from: "the evidence of Rounding rule for totals", touch: true } },
    { fleetEmbed: true, select: { text: "", rect: null, from: "", touch: false } },
  ]);
});

test("a touch selection in a fleet's frame puts the toolbar below it, clear of the handles", () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  const f = placeAt(frame(), 200, 30);
  arrive({ fleetEmbed: true, select: { ...SELECTED, touch: true } }, f.contentWindow);
  expect([tool()?.style.top, tool()?.style.left]).toEqual(["348px", "100px"]);
});

test("embedded, a pointer of touch marks the selection told to the manager as a touch one", async () => {
  open("/f/billing/?embed=1#decision/d1", coordinatorView(NOW));
  page.ui.route();
  flush();
  const h1 = root.querySelector("#dv-info h1") ?? root;
  h1.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
  const range = document.createRange();
  range.selectNodeContents(h1);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await new Promise((r) => setTimeout(r, 250));
  expect(selects().at(-1)).toMatchObject({ select: { touch: true } });
  getSelection()?.removeAllRanges();
});

/** The fleet's view with d1 decided, its answer and the coordinator's reply in the chat. */
function decidedD1(): View {
  const view = coordinatorView(NOW);
  // SAFETY: the fixture's decisions are records, as coordinatorView writes them.
  const decisions = view["decisions"] as View[];

  return { ...view, decisions: decisions.map((d) => (d["id"] === "d1" ? { ...d, status: "decided", answer: "b: Round the total", resolution: "Answered on the page.", closed: before(5) } : d)) };
}

const asking = (): HTMLTextAreaElement | null => root.querySelector<HTMLTextAreaElement>("#dv-ask textarea");

const threadIds = (): string[] => [...root.querySelectorAll("#dv-thread article.msg")].map((a) => a.getAttribute("data-id") ?? "");

test("embedded, Change my answer writes to the fleet's coordinator in the frame, and its reply shows in the thread", async () => {
  open("/f/billing/?embed=1#decision/d1", decidedD1());
  page.ui.route();
  page.ui.addMessage({ id: 20, at: before(10), from: "user", to: ["coordinator"], text: "b: Round the total", decision: "d1" }, false);
  page.ui.addMessage({ id: 21, at: before(6), from: "coordinator", to: ["user"], text: "Recorded.", re: 20 }, false);
  flush();
  expect(asking()).toBeNull();
  root.querySelector<HTMLButtonElement>("#dv-answer [data-change]")?.click();
  flush();
  const say = asking();
  const text = 'About "Rounding rule for totals": I want to change my answer. ';
  expect(say?.value).toBe(text);
  expect(document.activeElement).toBe(say);
  expect([say?.selectionStart, say?.selectionEnd]).toEqual([text.length, text.length]);

  if (say) say.value += "Per line after all.";
  root.querySelector<HTMLButtonElement>("#dv-ask [data-ask-send]")?.click();
  await settle();
  expect(posted).toEqual([{ text: text + "Per line after all.", re: 21 }]);
  expect(asking()).toBeNull();
  expect(root.querySelector("#dv-ask-sent")?.textContent).toBe("Sent to the coordinator. Its reply shows above, in the chat.");
  expect(threadIds()).toEqual(["20", "21", "99"]);
  page.ui.addMessage({ id: 100, at: new Date(NOW).toISOString(), from: "coordinator", to: ["user"], text: "Reopened as D1.", re: 99 }, true);
  flush();
  expect(threadIds()).toEqual(["20", "21", "99", "100"]);
  expect(toParent.filter((d) => d !== null && Object(d) === d && "answered" in Object(d))).toEqual([]);
});

test("embedded, Ask in the chat writes in the frame too, and a decision with no thread yet shows the message and its reply", async () => {
  open("/f/billing/?embed=1#decision/d1", coordinatorView(NOW));
  page.ui.route();
  flush();
  root.querySelector<HTMLButtonElement>("#dv-answer button[data-discuss]")?.click();
  flush();
  expect(asking()?.value).toBe('About "Rounding rule for totals": ');

  if (asking()) (asking() ?? { value: "" }).value += "what does Stripe do?";
  root.querySelector<HTMLButtonElement>("#dv-ask [data-ask-send]")?.click();
  await settle();
  expect(posted).toEqual([{ text: 'About "Rounding rule for totals": what does Stripe do?' }]);
  expect(threadIds()).toEqual(["99"]);
  page.ui.addMessage({ id: 100, at: new Date(NOW).toISOString(), from: "coordinator", to: ["user"], text: "It rounds the total.", re: 99 }, true);
  flush();
  expect(threadIds()).toEqual(["99", "100"]);
});

test("embedded, a message the server refuses stays in the frame's composer with the reason", async () => {
  open("/f/billing/?embed=1#decision/d1", decidedD1());
  page.ui.route();
  flush();
  root.querySelector<HTMLButtonElement>("#dv-answer [data-change]")?.click();
  flush();
  const ok = globalThis.fetch;
  // SAFETY: the page calls only `fetch` itself; the stub refuses every message.
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ error: "the chat is closed" }), { status: 403 })) as typeof fetch;
  root.querySelector<HTMLButtonElement>("#dv-ask [data-ask-send]")?.click();
  await settle();
  globalThis.fetch = ok;
  expect(asking()?.value).toBe('About "Rounding rule for totals": I want to change my answer. ');
  expect(root.querySelector("#dv-ask [role=alert]")?.textContent).toBe("the chat is closed");
  expect(root.querySelector("#dv-ask-sent")).toBeNull();
});

test("embedded, another decision's link asks the manager to open it, and Ctrl+K opens the manager's finder", () => {
  const view = coordinatorView(NOW);
  // SAFETY: the fixture's decisions are records, as coordinatorView writes them.
  const decisions = view["decisions"] as View[];
  open("/f/billing/?embed=1#decision/d1", { ...view, decisions: decisions.map((d) => (d["id"] === "d1" ? { ...d, supersedes: "a7" } : d)) });
  page.ui.route();
  flush();
  const link = root.querySelector<HTMLAnchorElement>('#dv-info a[href="#decision/a7"]');
  expect(link).not.toBeNull();
  link?.click();
  flush();
  expect(location.hash).toBe("#decision/d1");
  expect(toParent).toContainEqual({ fleetEmbed: true, open: "a7" });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  expect(toParent).toContainEqual({ fleetEmbed: true, finder: true });
});

test("on the manager's page, the fleet's frame opens another of its decisions on the manager's page, and the finder", () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  arrive({ fleetEmbed: true, open: "d7" }, window);
  expect(location.hash).toBe("#decision/billing/d1");
  arrive({ fleetEmbed: true, open: "d7" }, frame()?.contentWindow);
  page.ui.route();
  flush();
  expect(location.hash).toBe("#decision/billing/d7");
  expect(frame()?.getAttribute("src")).toBe("/f/billing/?embed=1#decision/d7");
  arrive({ fleetEmbed: true, finder: true }, frame()?.contentWindow);
  expect(page.ui.finderOpen()).toBe(true);
});
