/**
 * Working through what waits on the user from the manager's page: a fleet's decision opens on the manager's
 * own decision page, as that fleet's page in a frame (`?embed=1`); the frame shows the decision alone and
 * tells the manager its height and an answer sent; the manager steps to the previous and next, and says
 * what comes next once one is answered. Run in happy-dom.
 */
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import type { DetachedWindowAPI } from "happy-dom";

import { App } from "../src/App.tsx";
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
      const body: { text: string; decision?: string } = JSON.parse(String(init?.body));
      posted.push(body);

      return new Response(JSON.stringify({ id: 98 + posted.length, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text, decision: body.decision }), { status: 201 });
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

test("an answer sent in the frame says what comes next, with Next focused, and stays on the page", () => {
  open("/f/manager/", managerView(NOW));
  go("#decision/billing/d1");
  arrive({ fleetEmbed: true, answered: "d2" }, frame()?.contentWindow);
  expect(root.querySelector("#dv-answered")).toBeNull();
  arrive({ fleetEmbed: true, answered: "d1" }, frame()?.contentWindow);
  expect(root.querySelector("#dv-answered")?.textContent).toBe("Answered. Next: D1 Which fleet gets the gate first");
  expect(document.activeElement).toBe(root.querySelector('#dv-queue a[data-queue="next"]'));
  expect(location.hash).toBe("#decision/billing/d1");
});

test("a fleet's decision that leaves the queue on the next state is answered too", () => {
  const view = managerView(NOW);
  open("/f/manager/", view);
  go("#decision/billing/d1");
  const billing = Core.parseState(view)?.coordinators.find((c) => c.id === "billing");
  const d1 = { ...billing?.decisions[0], answered: new Date(NOW).toISOString() };
  // SAFETY: the fixture's coordinators are records, as managerView writes them.
  const coordinators = view["coordinators"] as View[];
  const answered = coordinators.map((c) => (c["id"] === "billing" ? { ...c, decisions: [d1] } : c));
  page.m.takeState(JSON.stringify({ ...view, coordinators: answered }));
  flush();
  expect(root.querySelector("#dv-answered")?.textContent).toBe("Answered. Next: D1 Which fleet gets the gate first");
  expect(queueLine()).toBe("1 waiting on you");
  go("#decision/d9");
  expect(root.querySelector("#dv-answered")).toBeNull();
});

test("a fleet's decision answered and then gone from the next state keeps Next on the one that followed it", () => {
  const view = withFleet(managerView(NOW), "infra", [INFRA_D4]);
  open("/f/manager/", view);
  go("#decision/infra/d4");
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
  expect(root.querySelector("#dv-answer [data-discuss]")?.getAttribute("href")).toBe("/f/billing/#decision/d1");
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
