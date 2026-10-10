/**
 * The Links view on the manager's page (`linksView`): what waits on the user first, the active links by kind,
 * the inactive ones folded under All and listed under Inactive, the kind and fleet filters, and each row's
 * badge, plain title, round, "for", status and port. Run in happy-dom, through `takeState`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Link } from "../src/core.ts";
import { arrange, inactiveWhy, placeOf, plainTitle, roundOf } from "../src/links.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { linksView } from "./fixtures.ts";

const NOW = Date.now();

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "#links";
  // SAFETY: the stub answers the one call the page makes with `fetch` here, the skills list; anything else is not found.
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input) === "skills" ? new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 }) : new Response("{}", { status: 404 })) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(linksView(NOW));

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.ui.route();
  flush();
});

afterEach(() => {
  dispose();
  root.remove();
});

const view = (): Element | null => root.querySelector("#links-view");

/** Each group's heading and the ids of its rows, in order. */
function groups(): [string, string[]][] {
  return [...(view()?.querySelectorAll(".link-group, .link-inactive") ?? [])].map((g) => [
    g.querySelector("h2")?.firstChild?.textContent?.trim() ?? "",
    [...g.querySelectorAll(".link-row")].map((r) => r.getAttribute("data-link") ?? ""),
  ]);
}

const press = (selector: string): void => {
  root.querySelector<HTMLButtonElement>(selector)?.click();
  flush();
};

test("Active shows what needs the user first, then each kind; nothing inactive", () => {
  expect(groups()).toEqual([
    ["Needs you", ["l1"]],
    ["Live previews", ["l2"]],
    ["Prototypes", ["l3"]],
    ["Docs", ["l4", "l5", "l11"]],
    ["Services", ["l6"]],
  ]);
  expect(root.querySelector('[data-showing="active"]')?.getAttribute("aria-pressed")).toBe("true");
  expect([...root.querySelectorAll("#link-filters [data-showing] .n")].map((n) => n.textContent)).toEqual(["7", "4", "11"]);
});

test("Inactive lists the done, the closed, the down and the gone by kind; All folds them under the active", () => {
  press('[data-showing="inactive"]');
  expect(groups()).toEqual([
    ["Prototypes, inactive", ["l7", "l8"]],
    ["Tools, inactive", ["l9"]],
    ["Docs, inactive", ["l10"]],
  ]);
  press('[data-showing="all"]');
  const folded = root.querySelector<HTMLDetailsElement>("#links-inactive");
  expect([folded?.open, folded?.querySelectorAll(".link-row").length]).toEqual([false, 4]);
  expect(groups()[0]).toEqual(["Needs you", ["l1"]]);
  expect(localStorage.getItem("fleet-board:links-showing") ?? Object.keys(localStorage).find((k) => k.endsWith("links-showing"))).toBeTruthy();
});

test("a kind chip and the fleet selector narrow the list", () => {
  press('#link-filters [data-kind="prototype"]');
  expect(groups()).toEqual([["Prototypes", ["l3"]]]);
  press('#link-filters [data-kind="prototype"]');
  const select = root.querySelector<HTMLSelectElement>("#link-fleet");
  expect([...(select?.options ?? [])].map((o) => o.value)).toEqual(["", "billing", "infra"]);

  if (select) {
    select.value = "infra";
    select.dispatchEvent(new Event("change"));
  }

  flush();
  expect(groups().map((g) => g[0])).toEqual(["Docs", "Services"]);
});

test("a row: its kind, its plain title, the fleet, what the user does there, whether it answers, its port", () => {
  const row = (id: string): Element | null | undefined => view()?.querySelector(`.link-row[data-link="${id}"]`);
  const l1 = row("l1");
  expect(l1?.querySelector(".kind-badge")?.textContent).toBe("Tool");
  expect(l1?.querySelector(".link-title")?.textContent).toBe("Gold-marking page, tier 0");
  expect(l1?.querySelector(".link-for")?.textContent).toBe("For you: mark each decision");
  expect(l1?.querySelector(".status-words")?.textContent).toMatch(/^up · checked \d\d:\d\d/u);
  expect(l1?.querySelector(".link-place")?.textContent).toBe(":4518 tool");
  expect(l1?.querySelector(".block-link")?.getAttribute("href")).toBe("#decision/billing/d1");
  expect(row("l3")?.querySelector(".round")?.textContent).toBe("round 14");
  expect(row("l4")?.querySelector(".link-title")?.getAttribute("href")).toBe("f/infra/files/auth-review.md");
  expect(row("l11")?.querySelector(".status-words")?.textContent).toBe("only on this machine");
  expect(row("l5")?.querySelector(".link-place")?.textContent).toBe("claude.ai doc");
  press('[data-showing="inactive"]');
  expect(row("l7")?.querySelector(".status-words")?.textContent).toMatch(/^down since /u);
});

test("the rules alone: why a link is inactive, its round, its place, its plain title, the layout", () => {
  const state = Core.parseState(linksView(NOW));
  const links: readonly Link[] = state?.links ?? [];
  expect(links.flatMap((l) => (inactiveWhy(l) === "" ? [] : [[l.id, inactiveWhy(l)]]))).toEqual([
    ["l7", "down"],
    ["l8", "done"],
    ["l9", "its decision is closed"],
    ["l10", "file missing"],
  ]);
  expect([roundOf("Teoria do caso prototype, round 10.2"), roundOf("rodada 3"), roundOf("Beta dev build")]).toEqual(["round 10.2", "round 3", ""]);
  expect(plainTitle("Specs for the five flip items (a193)")).toBe("Specs for the five flip items");
  expect(links.map((l) => placeOf(l)).slice(0, 6)).toEqual([":4518", ":7501", ":7501", "file", "claude.ai", ":8000"]);
  const all = arrange(links, "all", "", "");
  expect([all.needs.length, all.groups.length, all.inactive.length, all.counts]).toEqual([1, 4, 3, { active: 7, inactive: 4 }]);
});

test("a link the hub has not probed yet stays active, and its row says checking…", () => {
  dispose();
  root.remove();
  root = document.createElement("div");
  document.body.append(root);
  const fresh = { id: "l12", ref: "L12", kind: "preview", title: "New build", url: "https://box.ts.net:7600/", fleet: "billing", note: "", decision: "", for: null, reach: "machine", up: null, file: null, decision_status: null, checked: null, state_since: null };
  const state = Core.parseState({ ...linksView(NOW), links: [fresh] });

  if (!state) throw new Error("the fixture is not a state");
  const [link] = state.links ?? [];
  expect([link?.checking, link?.up, link === undefined ? "?" : inactiveWhy(link)]).toEqual([true, false, ""]);
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.ui.route();
  flush();
  expect(groups()).toEqual([["Live previews", ["l12"]]]);
  expect(view()?.querySelector('.link-row[data-link="l12"] .status-words')?.textContent).toBe("checking…");
});

test("an older view's kind is read by the fleet's own rules: an artifact is a doc, a prototype's address a prototype, a file a doc", () => {
  const old = (id: string, kind: string, url: string, title = "T") => ({ id, ref: id.toUpperCase(), kind, title, url, fleet: "billing", reach: "machine" });

  const state = Core.parseState({
    ...linksView(NOW),
    links: [
      old("l1", "dev", "https://claude.ai/artifact/x"),
      old("l2", "page", "https://box.ts.net:7501/caso/CA1/prototipo/mapa"),
      old("l3", "dev", "https://box.ts.net:7502/", "Map prototype round 3"),
      old("l4", "dev", "file:///tmp/plan.md"),
      old("l5", "dev", "https://box.ts.net:7503/"),
      old("l6", "page", "https://example.com/report"),
      old("l7", "tool", "https://claude.ai/artifact/y"),
    ],
  });

  expect(state?.links?.map((l) => l.kind)).toEqual(["doc", "prototype", "prototype", "doc", "preview", "doc", "tool"]);
});
