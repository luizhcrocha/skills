/**
 * The finder (Ctrl/⌘K) on a coordinator's page, in happy-dom: with nothing typed, the places opened last
 * and a row per kind to narrow to; the kinds as tabs that Tab and Shift+Tab cycle with the focus kept in
 * the field, and their prefixes ("d:") that select a tab, which Backspace in an empty field drops; five rows
 * a kind and a "show more"; Enter opens here, Ctrl/⌘+Enter in a new tab; Escape clears, then closes; rows
 * drawn stay put while the fleet's state streams in. Where it sits on the screen is finder-browser.test.ts's.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorChat, coordinatorView, managerView, type View } from "./fixtures.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

let page: { m: Model; ui: Ui };

let dispose: (() => void) | undefined;

let root: HTMLElement;

/** What the page opened in a new tab. */
const opened: string[] = [];

/** The page at `address` with `view`, and the coordinator's chat. */
function open(view: View = coordinatorView(NOW), address = "/f/billing/", keep = false): void {
  Object.assign(globalThis, { FleetCore: Core });

  if (!keep) localStorage.clear();
  opened.length = 0;
  history.replaceState(null, "", address);
  // SAFETY: the stub answers the calls the page makes with `fetch`; nothing else of `typeof fetch` is used.
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 404 })) as typeof fetch;
  // SAFETY: the page only passes a URL; the test keeps it.
  window.open = ((url: string) => {
    opened.push(String(url));

    return null;
  }) as typeof window.open;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();

  for (const msg of view["role"] === "manager" ? [] : coordinatorChat(NOW)) page.ui.addMessage(JSON.parse(JSON.stringify(msg)), false);
  page.m.setConn("live");
  flush();
}

function close(): void {
  page.ui.refs.finder?.close();
  dispose?.();
  dispose = undefined;
  root.remove();
}

beforeEach(() => open());

afterEach(close);

function go(hash: string): void {
  location.hash = hash;
  page.ui.route();
  flush();
}

const field = (): HTMLInputElement => {
  const f = page.ui.refs.findQ;

  if (!f) throw new Error("no finder field");

  return f;
};

function key(k: string, mods: KeyboardEventInit = {}): void {
  field().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  flush();
}

function type(text: string): void {
  field().value = text;
  field().dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

function finder(): void {
  page.ui.openFinder();
  flush();
}

/** The sections drawn, each its heading and its rows' words. */
const sections = (): [string, string[]][] =>
  [...root.querySelectorAll<HTMLElement>("#find-list [role=group]")].map((g) => [
    g.querySelector(".find-group .gh")?.textContent ?? "",
    [...g.querySelectorAll<HTMLElement>(".find-row")].map((o) => o.querySelector(".tt")?.textContent ?? ""),
  ]);

const heads = (): string[] => sections().map(([h]) => h);

const tab = (): string => root.querySelector<HTMLElement>('#find-tabs [role=tab][aria-selected="true"] .rl')?.textContent ?? "";

/** The rail as drawn: each kind's name and count. */
const rail = (): string[] => [...root.querySelectorAll<HTMLElement>("#find-tabs [role=tab]")].map((t) => (t.querySelector(".rl")?.textContent ?? "") + " " + (t.querySelector(".rn")?.textContent ?? ""));

/** The record pane as the eye reads it: its kind, title, pills, lead line, options, facts, the thread's lines (the found one starred), its buttons. */
interface PaneSeen {
  readonly kind: string;
  readonly title: string;
  readonly pills: string[];
  readonly lead: string;
  readonly options: string[];
  readonly facts: string[];
  readonly thread: string[];
  readonly buttons: string[];
}

function pane(): PaneSeen {
  const pv = root.querySelector<HTMLElement>("#find-pv");
  const all = (sel: string): HTMLElement[] => [...(pv?.querySelectorAll<HTMLElement>(sel) ?? [])];
  const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/gu, " ").trim();

  return {
    kind: text(pv?.querySelector(".find-pv-k")),
    title: text(pv?.querySelector(".find-pv-t")),
    pills: all(".find-pv-pills .pill").map(text),
    lead: text(pv?.querySelector(".find-pv-lead")),
    options: all(".find-pv-opts li").map(text),
    facts: all(".find-pv-facts > div").map((d) => text(d.querySelector("dt")) + ": " + text(d.querySelector("dd"))),
    thread: all(".find-pv-thread li").map((l) => (l.classList.contains("hit") ? "* " : "") + text(l.querySelector(".x"))),
    buttons: all(".find-pv-act button").map((b) => b.dataset["act"] ?? ""),
  };
}

/** A button of the record pane, clicked. */
function act(which: "open" | "second"): void {
  const b = root.querySelector<HTMLButtonElement>(`#find-pv [data-act="${which}"]`);

  if (!b) throw new Error("no " + which + " button");
  b.click();
  flush();
}

const active = (): string => root.querySelector<HTMLElement>('#find-list [role=option][aria-selected="true"]')?.querySelector(".tt")?.textContent ?? "";

test("nothing opened yet: a row per kind to narrow to, with its prefix; Enter on one selects its tab", () => {
  finder();
  expect(heads()).toEqual(["Narrow to"]);
  const [, hints] = sections()[0] ?? ["", []];
  expect(hints).toEqual(["Decisions", "Roadblocks", "Workers", "Plan", "Chat", "Links", "Log"]);
  expect(root.querySelector(".find-hint kbd")?.textContent).toBe("d:");
  key("Enter");
  expect(tab()).toBe("Decisions");
  expect(heads()).toEqual(["Decisions"]);
  expect(document.activeElement).toBe(field());
});

test("the places opened are the recents, newest first, the one shown left out, and kept for the next visit", () => {
  go("#decision/d1");
  page.ui.openWorker("a2");
  flush();
  page.ui.refs.worker?.close();
  go("#plan");
  finder();
  expect(sections()[0]).toEqual(["Recent", ["invoice-gen", "Rounding rule for totals"]]);
  expect(heads()).toEqual(["Recent", "Narrow to"]);
  expect(root.querySelector('#find-list [role=group] [role=option] .pill')?.textContent).toBe("worker");

  /* Picked from the finder: a chat message is a place too. */
  type("restricted key");
  const msg = [...root.querySelectorAll<HTMLElement>("#find-list [role=option]")].find((o) => o.dataset["key"] === "chat:c:5");

  if (!msg) throw new Error("no message row");
  msg.click();
  flush();
  close();

  open(coordinatorView(NOW), "/f/billing/", true);
  go("#log");
  finder();
  expect(sections()[0]?.[1]).toEqual(["The adapter is blocked on the restricted key (S1).", "Plan", "invoice-gen", "Rounding rule for totals"]);

  /* A query keeps the recents that match it on top, three at most, and draws them once. */
  type("round");
  expect(sections()[0]).toEqual(["Recent", ["Rounding rule for totals"]]);
  expect(heads()).not.toContain("Decisions");
});

test("Tab and Shift+Tab cycle the kinds with the focus kept in the field; a prefix selects its tab; Backspace in an empty field drops it", () => {
  finder();
  field().focus();
  expect(tab()).toBe("All");
  key("Tab");
  expect(tab()).toBe("Decisions");
  key("Tab");
  expect(tab()).toBe("Roadblocks");
  key("Tab", { shiftKey: true });
  key("Tab", { shiftKey: true });
  expect(tab()).toBe("All");
  key("Tab", { shiftKey: true });
  expect(tab()).toBe("Log");
  expect(document.activeElement).toBe(field());

  type("w:inv");
  expect(tab()).toBe("Workers");
  expect(field().value).toBe("inv");
  expect(sections()).toEqual([["Workers", ["invoice-gen", "docs-pass", "notes-impl", "research-stripe"]]]);
  type("");
  expect(tab()).toBe("Workers");
  key("Backspace");
  expect(tab()).toBe("All");
  expect(root.querySelector(".find-foot")?.textContent).toContain("d: decisions");
});

test("five rows a kind, then a row that shows the rest, the field kept", () => {
  finder();
  type("e");
  const plan = sections().find(([h]) => h === "Plan");
  expect(plan?.[1]).toHaveLength(5);
  const more = [...root.querySelectorAll<HTMLElement>(".find-more")].find((m) => m.dataset["key"] === "more:plan");
  expect(more?.textContent).toContain("1 more");
  more?.click();
  flush();
  expect(sections().find(([h]) => h === "Plan")?.[1]).toHaveLength(6);
  expect(document.activeElement).toBe(field());
});

test("Up and Down go round the rows; the letters that matched are marked", () => {
  finder();
  type("rounding");
  expect(active()).toBe("Rounding rule for totals");
  expect(root.querySelector('#find-list [aria-selected="true"] mark')?.textContent).toBe("Rounding");
  const n = root.querySelectorAll("#find-list [role=option]").length;
  key("ArrowUp");
  expect(root.querySelectorAll("#find-list [role=option]")[n - 1]?.getAttribute("aria-selected")).toBe("true");
  key("ArrowDown");
  expect(active()).toBe("Rounding rule for totals");
});

test("Enter opens the row here; Ctrl/⌘+Enter opens it in a new tab", () => {
  finder();
  type("D1");
  key("Enter", { ctrlKey: true });
  expect(opened).toEqual(["/f/billing/#decision/d1"]);
  expect(location.hash).not.toBe("#decision/d1");
  finder();
  type("D1");
  key("Enter");
  expect(location.hash).toBe("#decision/d1");
});

test("on the manager's page, Ctrl/⌘+Enter on a fleet's decision opens that fleet's own page", () => {
  close();
  open(managerView(NOW), "/f/manager/");
  finder();
  type("rounding");
  key("Enter", { metaKey: true });
  expect(opened).toEqual([page.m.fleetPage("billing") + "#decision/d1"]);
});

test("Escape clears the words and the tab, then closes", () => {
  finder();
  type("d:round");
  key("Escape");
  expect([field().value, tab()]).toEqual(["", "All"]);
  expect(page.ui.refs.finder?.open).toBe(true);
  key("Escape");
  expect(page.ui.refs.finder?.open).toBe(false);
});

test("rows drawn stay put while the fleet's state streams in; the next keystroke takes the new ones", () => {
  finder();
  type("c:");
  key("ArrowDown");
  const before = sections();
  const at = active();
  page.ui.addMessage({ id: 6, at: new Date(NOW).toISOString(), from: "coordinator", to: ["user"], text: "A new message on top." }, true);
  flush();
  expect(sections()).toEqual(before);
  expect(active()).toBe(at);
  type("new message");
  expect(sections()).toEqual([["Chat", ["A new message on top."]]]);
});

test("the record pane shows the highlighted row's record, per kind", () => {
  finder();
  type("d:rounding");
  expect(pane()).toMatchObject({ kind: "Decision", title: "D1 Rounding rule for totals", pills: ["open", "blocking"], lead: "How should invoice totals round: per line or on the total?", options: ["a Round each line", "b Round the total recommended"], buttons: ["open", "second"] });
  expect(pane().facts).toContain("For: you");

  type("w:invoice-gen");
  expect(pane()).toMatchObject({ kind: "Worker", title: "a2 invoice-gen", pills: ["running"], lead: "Generate invoices from the ledger and post them to Stripe" });
  expect(pane().facts).toContain("Lane: src/invoices/, test/invoices/");

  type("c:keep the totals");
  expect(pane().thread).toEqual(["Two workers on milestone 2. The rounding rule (D1) is yours.", "* @invoice-gen keep the totals in cents", "Will do: every amount is an integer of cents now."]);
  expect(pane().buttons).toEqual(["open"]);

  type("p:adapter");
  expect(pane()).toMatchObject({ kind: "Plan step", pills: ["blocked"] });
  expect(pane().facts).toContain("Milestone: Generate and post");

  type("l:api dev");
  expect(pane().facts).toEqual(expect.arrayContaining(["Address: http://127.0.0.1:5173/", "Answers: no"]));
});

test("the record pane follows the highlight, and a kind to narrow to or a \"show more\" says what Enter does", () => {
  finder();
  expect(pane()).toMatchObject({ kind: "Narrow to", title: "Decisions" });
  key("ArrowDown");
  expect(pane().title).toBe("Roadblocks");
  type("e");
  const first = active();
  expect(pane().title).toContain(first);
  key("ArrowDown");
  expect(active()).not.toBe(first);
  expect(pane().title).toContain(active());

  const more = [...root.querySelectorAll<HTMLElement>("#find-list [role=option]")].findIndex((o) => o.dataset["key"] === "more:plan");
  page.ui.setFoundAt(more);
  flush();
  expect(pane()).toMatchObject({ title: "1 more", buttons: ["open"] });
  act("open");
  expect(sections().find(([h]) => h === "Plan")?.[1]).toHaveLength(6);
});

test("the rail: All and each kind with its count, the words' hits; a click narrows; Tab and a prefix still select", () => {
  finder();
  expect(rail()).toEqual(["All 32", "Decisions 5", "Roadblocks 2", "Workers 6", "Plan 6", "Chat 5", "Links 2", "Log 6"]);
  type("stripe");
  expect(rail().slice(0, 4)).toEqual(["All 9", "Decisions 1", "Roadblocks 1", "Workers 3"]);
  root.querySelectorAll<HTMLElement>("#find-tabs [role=tab]")[3]?.click();
  flush();
  expect(tab()).toBe("Workers");
  expect(heads()).toEqual(["Workers"]);
  expect(document.activeElement).toBe(field());
  key("Tab");
  expect(tab()).toBe("Plan");
  type("d:");
  expect(tab()).toBe("Decisions");
});

test("the pane's buttons do the row's two actions: Open here, New tab as Ctrl/⌘+Enter does", () => {
  finder();
  type("D1");
  act("second");
  expect(opened).toEqual(["/f/billing/#decision/d1"]);
  expect(location.hash).not.toBe("#decision/d1");
  finder();
  type("D1");
  act("open");
  expect(location.hash).toBe("#decision/d1");
  expect(page.ui.refs.finder?.open).toBe(false);
});
