/**
 * The card "Unlock 1Password": on every page while 1Password is locked on the machine (the view's `onepw`,
 * fleet/src/onepw.ts), above everything else that waits, reading as an action of the user's. Its one button
 * posts to the hub, which tells the held fleets; the card goes when the state does. Run in happy-dom, through
 * `takeState`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, managerView, type View } from "./fixtures.ts";

const NOW = Date.now();

const ONEPW: View = {
  since: new Date(NOW - 42 * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z"),
  why: "SSH signing through 1Password failed",
  waiting: [
    { who: "skills", what: "a push or fetch over SSH and reading secrets" },
    { who: "a session outside the fleets", what: "the GitHub CLI" },
    { who: 7, what: "dropped: no name" },
  ],
};

let posted: { readonly url: string; readonly method: string; readonly type: string; readonly body: string }[] = [];

let answer: () => Response;

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

function show(view: View, conn: "live" | "unavailable" = "live"): void {
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.m.setConn(conn);
  flush();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((wake) => setTimeout(wake, 0));
    flush();
  }
}

const text = (sel: string): string => (root.querySelector(sel)?.textContent ?? "").replace(/\s+/gu, " ").trim();

const button = (): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>("#onepw-unlocked");

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  posted = [];
  answer = () => Response.json({ cleared: true, told: [{ fleet: "skills", to: "coordinator", id: 4 }] });
  // SAFETY: the stub answers the page's fetch calls; only the URL, the method, the type and the body are read.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url !== "onepw/unlocked") return new Response("{}", { status: 404 });
    posted.push({ url, method: init?.method ?? "GET", type: new Headers(init?.headers).get("Content-Type") ?? "", body: String(init?.body ?? "") });

    return answer();
  }) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  dispose();
  root.remove();
});

test("while 1Password is locked, a fleet's page and the manager's open with the card: why, who waits for what, since when", () => {
  for (const view of [coordinatorView(NOW), managerView(NOW)]) {
    show({ ...view, onepw: ONEPW });
    const card = root.querySelector("#onepw .ask");
    expect(card?.className).toBe("ask open blocking");
    expect(text("#onepw .ask-head")).toBe("Unlock 1Passwordblocks worksomething to do");
    expect(text("#onepw .ask > .detail")).toBe("1Password, here or on the machine you are connected from, is refusing commands: SSH signing through 1Password failed. Unlock the app, then say so here.");
    expect([...root.querySelectorAll("#onepw .onepw-waits")].map((l) => (l.textContent ?? "").replace(/\s+/gu, " ").trim())).toEqual([
      "Waiting: skills, for a push or fetch over SSH and reading secrets.",
      "Waiting: a session outside the fleets, for the GitHub CLI.",
    ]);
    expect(text("#onepw .ask > .meta")).toStartWith("Asked 42 min ago.");
    expect(button()?.textContent).toBe("1Password is unlocked");
    expect(button()?.disabled).toBe(false);
    expect(root.querySelector("#decisions")?.firstElementChild?.id).toBe("onepw");
    dispose();
    root.replaceChildren();
  }
});

test("cleared and then locked again, it is the same card marked still locked: asked since the same moment, and when a command failed again", () => {
  const stamp = (ago: number): string => new Date(NOW - ago).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const view = coordinatorView(NOW);
  show({ ...view, onepw: { ...ONEPW, again: stamp(5 * 60_000) } });
  expect(page.m.state.onepw?.again).toBe(stamp(5 * 60_000));
  expect(root.querySelector("#onepw .ask")?.className).toBe("ask open blocking");
  expect(text("#onepw .ask-head")).toBe("Unlock 1Passwordblocks workstill lockedsomething to do");
  expect([...root.querySelectorAll("#onepw .ask-head .pill")].map((p) => p.className)).toEqual(["pill blocking", "pill warning", "pill plain"]);
  expect([...root.querySelectorAll("#onepw .ask > .detail")].slice(0, 2).map((l) => (l.textContent ?? "").replace(/\s+/gu, " ").trim())).toEqual([
    "1Password, here or on the machine you are connected from, is refusing commands: SSH signing through 1Password failed. Unlock the app, then say so here.",
    "It was cleared and a command failed again 5 min ago.",
  ]);
  expect(root.querySelectorAll("#onepw .onepw-waits").length).toBe(2);
  expect(text("#onepw .ask > .meta")).toStartWith("Asked 42 min ago.");
  expect(button()?.textContent).toBe("1Password is unlocked");
  page.m.takeState(JSON.stringify({ ...view, onepw: { ...ONEPW, again: stamp(20_000) }, updated: new Date(NOW + 1000).toISOString() }));
  flush();
  expect(text("#onepw .onepw-again")).toBe("It was cleared and a command failed again just now.");
  page.m.takeState(JSON.stringify({ ...view, onepw: ONEPW, updated: new Date(NOW + 2000).toISOString() }));
  flush();
  expect([text("#onepw .ask-head"), root.querySelector("#onepw .onepw-again")]).toEqual(["Unlock 1Passwordblocks worksomething to do", null]);
});

test("a card that was never cleared, or whose `again` is no stamp, is not marked still locked", () => {
  for (const again of [undefined, null, 1_791_000_000, true, "", "soon", { at: ONEPW["since"] }] as const) {
    const onepw: Json = again === undefined ? ONEPW : { ...ONEPW, again };
    show({ ...coordinatorView(NOW), onepw });
    expect(page.m.state.onepw?.again).toBeNull();
    expect(text("#onepw .ask-head")).toBe("Unlock 1Passwordblocks worksomething to do");
    expect(root.querySelector("#onepw .onepw-again")).toBeNull();
    expect(root.querySelectorAll("#onepw .ask > .detail").length).toBe(3);
    expect(text("#onepw .ask > .meta")).toStartWith("Asked 42 min ago.");
    dispose();
    root.replaceChildren();
  }
});

test("the lead counts the card as one action that blocks work", () => {
  const view = { ...coordinatorView(NOW), decisions: [] };
  show(view);
  expect([text("#lead .lead-line"), root.querySelector("#onepw")]).toEqual(["Nothing waits on you.", null]);
  page.m.takeState(JSON.stringify({ ...view, onepw: ONEPW }));
  flush();
  expect([text("#lead .lead-line"), text("#lead .lead-detail"), root.querySelector("#lead")?.className]).toEqual(["1 action waits on you.", "It blocks work.", "lead blocking"]);
});

test("the button posts to the hub, says the fleets are told, and the card goes when the state does", async () => {
  const view = coordinatorView(NOW);
  show({ ...view, onepw: ONEPW });
  button()?.click();
  await settle();
  expect(posted).toEqual([{ url: "onepw/unlocked", method: "POST", type: "application/json", body: "{}" }]);
  expect(text("#onepw-said")).toBe("The fleets are told.");
  page.m.takeState(JSON.stringify({ ...view, updated: new Date(NOW + 1000).toISOString() }));
  flush();
  expect(root.querySelector("#onepw")).toBeNull();
  expect(page.m.state.onepw).toBeNull();
});

test("a refusal shows the hub's reason and the card stays", async () => {
  answer = () => Response.json({ error: "only luiz@example.com can write here" }, { status: 403 });
  show({ ...coordinatorView(NOW), onepw: ONEPW });
  button()?.click();
  await settle();
  expect(text("#onepw-said")).toBe("only luiz@example.com can write here");
  expect(button()?.disabled).toBe(false);
});

test("a copy of the page that cannot reach the hub shows the card with its button disabled, and says why", async () => {
  show({ ...coordinatorView(NOW), onepw: ONEPW }, "unavailable");
  expect(button()?.disabled).toBe(true);
  expect(text("#onepw-said")).toBe("This copy of the page cannot tell the hub.");
  button()?.click();
  await settle();
  expect(posted).toEqual([]);
});

test("a view without the key, or with one that is no card, shows none", () => {
  for (const onepw of [undefined, null, "locked", { why: "no since" }] as const) {
    const view: Json = onepw === undefined ? coordinatorView(NOW) : { ...coordinatorView(NOW), onepw };
    expect(Core.parseState(view)?.onepw).toBeNull();
  }

  show(coordinatorView(NOW));
  expect(root.querySelector("#onepw")).toBeNull();
});
