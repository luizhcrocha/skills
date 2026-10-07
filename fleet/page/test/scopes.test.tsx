/**
 * The manager's quick filter by agent on the Decisions view: a chip per agent with an open decision, one at
 * a time, narrowing the list and its lists' counts (never the tab's badge or the lead), reached by the
 * arrow keys, kept per browser, and back to all once its agent has nothing open.
 */
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json, type State } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import { coordinatorView, managerScopesView, type View } from "./fixtures.ts";

const NOW = Date.now();

let dispose: (() => void) | undefined;

let root: HTMLElement | undefined;

afterEach(() => {
  dispose?.();
  root?.remove();
});

function stateOf(view: View): State {
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");

  return state;
}

function mount(view: View, stored?: Json) {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();

  if (stored !== undefined) localStorage.setItem("fleet:/f/billing/d-scope", JSON.stringify(stored));
  location.hash = "";
  // SAFETY: the stub answers the calls the page makes with `fetch` (none of them matter here); nothing else of `typeof fetch` is used.
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 404 })) as typeof fetch;
  const at = document.createElement("div");
  document.body.append(at);
  let model: Model | undefined;
  dispose = render(() => <App state={stateOf(view)} live={false} expose={(p) => (model = p.m)} />, at);
  flush();
  root = at;

  if (!model) throw new Error("the page did not expose its model");

  return { page: at, m: model };
}

const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/gu, " ").trim();

const chips = (page: HTMLElement): HTMLButtonElement[] => [...page.querySelectorAll<HTMLButtonElement>("#decision-scope button")];

const pressed = (page: HTMLElement): string[] => chips(page).filter((b) => b.getAttribute("aria-pressed") === "true").map(text);

const listed = (page: HTMLElement): string[] => [...page.querySelectorAll("#decision-list a.ask")].map((a) => a.getAttribute("href") ?? "");

const counts = (page: HTMLElement): string[] => [...page.querySelectorAll("#decision-seg button")].map(text);

const chip = (page: HTMLElement, name: string): HTMLButtonElement => {
  const b = chips(page).find((x) => text(x).startsWith(name + " "));

  if (!b) throw new Error(`no chip ${name}`);

  return b;
};

function key(el: Element, k: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  flush();
}

test("a chip per agent with an open decision, counted, after All; one pressed; a toolbar", () => {
  const { page } = mount(managerScopesView(NOW));
  const bar = page.querySelector("#decision-scope");
  expect(bar?.getAttribute("role")).toBe("toolbar");
  expect(bar?.getAttribute("aria-label")).toBe("Decisions for");
  expect(chips(page).map(text)).toEqual(["All 5", "billing 1", "infra 2", "site 1", "no agent 1"]);
  expect(pressed(page)).toEqual(["All 5"]);
});

test("a chip narrows the list and its lists' counts; the tab's badge and the lead still count every fleet", () => {
  const { page } = mount(managerScopesView(NOW));
  const badge = text(page.querySelector("#nav-decisions"));
  const lead = text(page.querySelector(".lead-line"));
  chip(page, "infra").click();
  flush();
  expect(pressed(page)).toEqual(["infra 2"]);
  expect(listed(page)).toEqual(["#decision/infra/d4", "#decision/infra/d5"]);
  expect(counts(page)).toEqual(["Waits on you 2", "Waiting 0", "Done 0"]);
  expect(text(page.querySelector("#nav-decisions"))).toBe(badge);
  expect(text(page.querySelector(".lead-line"))).toBe(lead);

  chip(page, "no agent").click();
  flush();
  expect(listed(page)).toEqual(["#decision/d9"]);
});

test("a second click on the pressed chip, or Escape in the toolbar, shows every agent's again", () => {
  const { page } = mount(managerScopesView(NOW));
  chip(page, "site").click();
  flush();
  expect(listed(page)).toEqual(["#decision/site/d2"]);
  chip(page, "site").click();
  flush();
  expect(pressed(page)).toEqual(["All 5"]);
  expect(listed(page).length).toBe(5);

  chip(page, "site").click();
  flush();
  key(chip(page, "site"), "Escape");
  expect(pressed(page)).toEqual(["All 5"]);
});

test("one chip is in the tab order; the arrows, Home and End move between them", () => {
  const { page } = mount(managerScopesView(NOW));
  const tabbable = (): string[] => chips(page).filter((b) => b.tabIndex === 0).map(text);
  expect(tabbable()).toEqual(["All 5"]);

  chips(page)[0]?.focus();
  key(chips(page)[0] ?? page, "ArrowRight");
  expect(text(document.activeElement)).toBe("billing 1");
  expect(tabbable()).toEqual(["billing 1"]);
  key(document.activeElement ?? page, "ArrowLeft");
  key(document.activeElement ?? page, "ArrowLeft");
  expect(text(document.activeElement)).toBe("no agent 1");
  key(document.activeElement ?? page, "Home");
  expect(text(document.activeElement)).toBe("All 5");
  key(document.activeElement ?? page, "End");
  expect(text(document.activeElement)).toBe("no agent 1");
  expect(pressed(page)).toEqual(["All 5"]);
});

test("the scope is kept per browser and comes back on the next load", () => {
  const first = mount(managerScopesView(NOW));
  chip(first.page, "infra").click();
  flush();
  expect(localStorage.getItem("fleet:/f/billing/d-scope")).toBe(JSON.stringify("fleet:infra"));
  dispose?.();
  root?.remove();

  const { page } = mount(managerScopesView(NOW), "fleet:infra");
  expect(pressed(page)).toEqual(["infra 2"]);
  expect(listed(page)).toEqual(["#decision/infra/d4", "#decision/infra/d5"]);
});

test("a stored scope whose agent has nothing open, or that was never one, is all", () => {
  expect(pressed(mount(managerScopesView(NOW), "fleet:gone").page)).toEqual(["All 5"]);
  dispose?.();
  root?.remove();
  expect(pressed(mount(managerScopesView(NOW), 7).page)).toEqual(["All 5"]);
});

test("once the scope's last open decision is closed its chip goes and the list is every agent's", () => {
  const { page, m } = mount(managerScopesView(NOW));
  chip(page, "site").click();
  flush();
  expect(listed(page)).toEqual(["#decision/site/d2"]);

  m.applyState(stateOf(managerScopesView(NOW, ["site/d2"])));
  flush();
  expect(chips(page).map(text)).toEqual(["All 4", "billing 1", "infra 2", "no agent 1"]);
  expect(pressed(page)).toEqual(["All 4"]);
  expect(listed(page).length).toBe(4);
  expect(localStorage.getItem("fleet:/f/billing/d-scope")).toBe(JSON.stringify(""));

  m.applyState(stateOf(managerScopesView(NOW)));
  flush();
  expect(pressed(page)).toEqual(["All 5"]);
});

test("a fleet's own page has no filter", () => {
  const { page } = mount(coordinatorView(NOW));
  expect(page.querySelector("#decision-scope")).toBeNull();
});
