/**
 * Every place the page shows words a fleet wrote links the references in them (refs.ts), rendered in
 * happy-dom: the Links view's row of Luiz's screenshot ("For you: read the bench design (d30): idea, model,
 * seams") on the fleet's own page and on the manager's, where the id is read in that fleet's ledger alone;
 * the decision rows, the Now line, the plan, the log and the chat; a row that is itself a link keeps its tap,
 * and no link ends up inside a link or a button. What stays text there: a short word standing alone (infra's
 * D1 is a database), Luiz's own words, a quote, a line of the hub's. Then the body's frame: what the page
 * tells it, and its script run on a body.
 */
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core } from "../src/core.ts";
import { claimIn } from "../src/FieldMarks.tsx";
import type { Model } from "../src/model.ts";
import { bodyRefs, refScript, tappedRef, type Lead } from "../src/refframe.ts";
import type { Ui } from "../src/ui.ts";
import { refsFleetView, refsManagerView, type View } from "./fixtures.ts";

const NOW = Date.now();

let page: { m: Model; ui: Ui };

let dispose: (() => void) | undefined;

let root: HTMLElement;

afterEach(() => {
  if (dispose === undefined) return;
  dispose();
  dispose = undefined;
  root.remove();
});

/** Render the page on `view`, at `hash`. */
function mount(view: View, hash: string): void {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = hash;
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, empty; anything else, not found.
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input) === "skills" ? new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 }) : new Response("{}", { status: 404 })) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.m.setConn("live");
  page.ui.route();
  flush();
}

/** Go to `hash`, as a tap on a link to it does. */
function go(hash: string): void {
  location.hash = hash;
  page.ui.route();
  flush();
}

/** Each reference linked under `selector`: its words and where it leads. */
const linked = (selector: string): (string | null)[][] => [...root.querySelectorAll<HTMLAnchorElement>(`${selector} a.dref`)].map((a) => [a.textContent, a.getAttribute("href")]);

const text = (selector: string): string => (root.querySelector(selector)?.textContent ?? "").replace(/\s+/gu, " ").trim();

/** A link inside a link or a button, or a button inside a link: what HTML does not allow, anywhere on the page. */
const nested = (): number => root.querySelectorAll("a a, button a, a button").length;

const ROW = '#links-view .link-row[data-link="bench"]';

test("the screenshot's row on the fleet's own page: d30 in what Luiz does there links to that decision, closed or not", () => {
  mount(refsFleetView(NOW), "#links");
  expect(text(`${ROW} .link-for`)).toBe("For you: read the bench design (d30): idea, model, seams");
  expect(linked(`${ROW} .link-for`)).toEqual([["d30", "#decision/perf/d130-the-bench-s-model"]]);
  expect(linked(`${ROW} .detail`)).toEqual([["D130", "#decision/perf/d130-the-bench-s-model"]]);
  /* The title opens the link itself: the reference it names stands beside it, a link of its own. */
  expect(root.querySelector(`${ROW} .link-title`)?.getAttribute("href")).toBe("https://claude.ai/artifact/bench");
  expect(root.querySelector(`${ROW} .link-title a`)).toBeNull();
  expect(linked(`${ROW} .block-head .refs-beside`)).toEqual([["D130", "#decision/perf/d130-the-bench-s-model"]]);
  expect(root.querySelector(ROW)?.id).toBe("link-perf/bench");
  go("#decision/d30");
  expect(root.querySelector("#decision h1")?.textContent).toContain("The bench's model");
});

test("the same row on the manager's page: the id is perf's, so the link opens perf's d30, never the manager's own d30", () => {
  mount(refsManagerView(NOW), "#links");
  expect(text(`${ROW} .link-for`)).toBe("For you: read the bench design (d30): idea, model, seams");
  expect(linked(`${ROW} .link-for`)).toEqual([["d30", "#decision/perf/d130-t-d130"]]);
  expect(linked(`${ROW} .detail`)).toEqual([
    ["D130", "#decision/perf/d130-t-d130"],
    ["L25", "#link-perf/bench"],
  ]);
  /* Billing wrote "(d30)" too and has no such row: its words stay text. */
  expect(text('#links-view .link-row[data-link="l1"] .link-for')).toBe("For you: mark each decision (d30)");
  expect(linked('#links-view .link-row[data-link="l1"]')).toEqual([]);
  expect(nested()).toBe(0);
  go("#decision/perf/d30");
  expect(root.querySelector<HTMLIFrameElement>("#dv-embed")?.getAttribute("src")).toEndWith("f/perf/?embed=1#decision/d30");
});

test("a reference to a link the filters hide (a done one) still lands on its row: every link shows, its fold open, until a filter is picked", () => {
  mount(refsManagerView(NOW), "#links");
  expect(root.querySelector('#links-view .link-row[data-link="old"]')).toBeNull();
  go("#link-perf/old");
  expect(root.querySelector('[data-showing="all"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(root.querySelector<HTMLDetailsElement>("#links-inactive")?.open).toBe(true);
  expect(root.querySelector('#links-inactive .link-row[data-link="old"]')?.id).toBe("link-perf/old");
  root.querySelector<HTMLButtonElement>('[data-showing="active"]')?.click();
  flush();
  expect(root.querySelector('#links-view .link-row[data-link="old"]')).toBeNull();
  /* The pick ended that arrival alone: following the same reference again shows the link again. */
  go("#decisions");
  go("#link-perf/old");
  expect(root.querySelector('#links-inactive .link-row[data-link="old"]')?.id).toBe("link-perf/old");
  expect(root.querySelector('[data-showing="all"]')?.getAttribute("aria-pressed")).toBe("true");
});

test("a row whose id is a word the page uses in an element's id (list, filters, fleet) is still the one element its address names", () => {
  const view = refsFleetView(NOW);
  const row = (id: string, extra: View): View => ({ id, ...extra });

  mount(
    {
      ...view,
      kept: ["list", "notes"].map((id) => row(id, { text: "A note.", at: new Date(NOW - 1000).toISOString() })),
      roadblocks: ["list", "r11"].map((id) => row(id, { ref: "", title: "A roadblock", severity: "warning", needs: "n", since: new Date(NOW - 1000).toISOString(), resolved: false })),
      links: ["filters", "fleet", "inactive", "view"].map((id) => row(id, { ref: "", kind: "doc", title: "A link", url: "https://example.com/" + id, fleet: "", note: "", decision: "", for: null, reach: "external", up: false })),
    },
    "#plan",
  );

  /** The elements of the page that share an id with another. */
  const twice = (): string[] => {
    const ids = Array.from(root.querySelectorAll("[id]"), (e) => e.id);

    return ids.filter((id, i) => ids.indexOf(id) !== i);
  };

  expect(twice()).toEqual([]);
  go("#kept-list");
  expect([page.m.place().anchor, document.getElementById("kept-list")?.className]).toEqual(["kept-list", "block"]);
  expect(document.getElementById("roadblock-list")?.classList.contains("block")).toBe(true);
  go("#links");
  expect(twice()).toEqual([]);
  expect(["link-filters", "link-fleet"].map((id) => document.getElementById(id)?.getAttribute("data-link"))).toEqual(["filters", "fleet"]);
});

test("a decision's row opens its page from anywhere on it, and a reference in its words is a link of its own beside that", () => {
  mount(refsFleetView(NOW), "#decisions");
  const row = root.querySelector('#decision-list a.ask-head[href="#decision/perf/d158-which-bench-runs-nightly-after-d30"]')?.closest(".ask");
  expect(row?.querySelector("a.ask-head b")?.textContent).toBe("D158 Which bench runs nightly, after d30");
  /* In a row's words a short word standing alone stays text, though the ledger holds a roadblock R1 and a step s3. */
  expect([...(row?.querySelectorAll<HTMLAnchorElement>(".detail a.dref") ?? [])].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
    ["d30", "#decision/perf/d130-the-bench-s-model"],
    ["R11", "#roadblock-r11"],
  ]);
  expect([...(row?.querySelectorAll<HTMLAnchorElement>(".meta a.dref") ?? [])].map((a) => a.getAttribute("href"))).toEqual(["#step-s13"]);
  expect([...(row?.querySelectorAll<HTMLAnchorElement>(":scope > .refs-beside a.dref") ?? [])].map((a) => a.getAttribute("href"))).toEqual(["#decision/perf/d130-the-bench-s-model"]);
  expect(row?.querySelector(".detail")?.textContent).toBe("As d30 chose the model, which bench runs nightly? R1 still blocks the adapter, R11 the bench.");
  expect(nested()).toBe(0);
});

test("a database, a bucket and a store named by a letter and a digit stay text in running words, on the fleet's page and the manager's", () => {
  mount(refsFleetView(NOW), "#log");
  /* The fleet holds a decision D1, a roadblock R2 and a step s3: the log's words name none of them. */
  expect(text("#log")).toContain("Moved off D1 onto Postgres; Cloudflare R2 keeps the exports, S3 the rest (s3).");
  expect(linked("#log").filter(([words]) => words !== "d30" && words !== "R11")).toEqual([]);
  page.ui.addMessage({ id: 1, at: new Date(NOW).toISOString(), from: "coordinator", to: ["user"], text: "Move off D1 onto Postgres; d30 and D130 said so, Cloudflare R2 stays." }, false);
  flush();
  expect(linked('#chat-log .msg[data-id="1"]')).toEqual([
    ["d30", "#decision/perf/d130-the-bench-s-model"],
    ["D130", "#decision/perf/d130-the-bench-s-model"],
  ]);
  dispose?.();
  root.remove();
  mount(refsManagerView(NOW), "#fleet");
  const strip = [...root.querySelectorAll("#coordinator-list .strip")].find((s) => s.querySelector(".who")?.textContent === "infra");

  expect(strip?.querySelector(".detail")?.textContent).toBe("Move off D1 onto Postgres; Cloudflare R2 keeps the exports.");
  expect(strip?.querySelectorAll("a.dref").length).toBe(0);
});

test("the Now line, the plan, the workers and the log link what they name; a worker's id opens that worker", () => {
  mount(refsFleetView(NOW), "#decisions");
  expect(linked("#lead .now")).toEqual([
    ["d30", "#decision/perf/d130-the-bench-s-model"],
    ["d58", "#decision/perf/d158-which-bench-runs-nightly-after-d30"],
    ["a12", "#agent-a12"],
  ]);
  expect(root.querySelector('#lead .now a.dref[data-ref="a12"]')?.getAttribute("data-agent")).toBe("a12");
  expect(nested()).toBe(0);
  go("#plan");
  expect(linked("#kept-k1")).toEqual([["d30", "#decision/perf/d130-the-bench-s-model"]]);
  expect(root.querySelector("#roadblock-r1 .block-title")?.textContent).toBe("No restricted Stripe key");
  expect([root.querySelector("#step-s3")?.tagName, root.querySelector("#milestone-m2")?.className]).toEqual(["LI", "milestone"]);
  expect(nested()).toBe(0);
  go("#log");
  expect(linked("#log")).toEqual([
    ["d30", "#decision/perf/d130-the-bench-s-model"],
    ["R11", "#roadblock-r11"],
    ["d30", "#decision/perf/d130-the-bench-s-model"],
  ]);
  expect(text("#log")).toContain("d30 decided: one seam; deploy-0067 does not exist");
  go("#fleet");
  expect(nested()).toBe(0);
});

test("on the manager's page a fleet's Now line and its messages are read in that fleet's ledger, the manager's own in its own", () => {
  mount(refsManagerView(NOW), "#fleet");
  const strip = [...root.querySelectorAll("#coordinator-list .strip")].find((s) => s.querySelector(".who")?.textContent === "perf");
  expect([...(strip?.querySelectorAll<HTMLAnchorElement>(".detail a.dref") ?? [])].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
    ["d30", "#decision/perf/d130-t-d130"],
    ["d58", "#decision/perf/d158-t-d158"],
  ]);
  go("#decisions");
  expect(linked("#lead .now")).toEqual([["d30", "#decision/d7-the-manager-s-own"]]);
  /* Perf's open decision in the manager's list: its question names perf's d30. */
  const row = root.querySelector('#decision-list a.ask-head[href="#decision/perf/d158-which-bench-runs-nightly-after-d30"]')?.closest(".ask");
  expect([...(row?.querySelectorAll<HTMLAnchorElement>(".detail a.dref") ?? [])].map((a) => a.getAttribute("href"))).toEqual(["#decision/perf/d130-t-d130"]);
  page.ui.addMessage({ id: 1, at: new Date(NOW).toISOString(), from: "perf", to: ["user"], text: "d30 is recorded; `d30` in code is not a link." }, false);
  page.ui.addMessage({ id: 2, at: new Date(NOW).toISOString(), from: "manager", to: ["user"], text: "My d30 still waits on you." }, false);
  flush();
  expect(linked('#chat-log .msg[data-id="1"]')).toEqual([["d30", "#decision/perf/d130-t-d130"]]);
  expect(linked('#chat-log .msg[data-id="2"]')).toEqual([["d30", "#decision/d7-the-manager-s-own"]]);
  expect(nested()).toBe(0);
});

test("Luiz's own words, a quote and a line of the hub's link nothing; what a fleet wrote beside them still does", () => {
  const at = new Date(NOW).toISOString();

  mount(refsFleetView(NOW), "#decisions");
  page.ui.addMessage({ id: 1, at, from: "user", to: ["coordinator"], text: "Is d30 done? And D130, the R11 one." }, false);
  page.ui.addMessage({ id: 2, at, from: "fleet-hub", to: ["coordinator"], text: "[hub] perf: 3 message(s) from the user wait unread since #12 (d30)." }, false);
  page.ui.addMessage({ id: 3, at, from: "coordinator", to: ["user"], text: "[hub] relayed: d30 is recorded." }, false);
  page.ui.addMessage({ id: 4, at, from: "coordinator", to: ["user"], text: "Yes: d30 is recorded.", quote: { text: "Bench design out for review (d30)", from: "perf" } }, false);
  page.ui.addMessage({ id: 5, at, from: "user", to: ["coordinator"], text: "A: as d30 said", decision: "d58" }, false);
  flush();
  expect([1, 2, 3, 5].map((id) => linked(`#chat-log .msg[data-id="${String(id)}"]`))).toEqual([[], [], [], []]);
  expect(text('#chat-log .msg[data-id="4"] .msg-quote')).toContain("Bench design out for review (d30)");
  expect(linked('#chat-log .msg[data-id="4"] .msg-quote')).toEqual([]);
  expect(linked('#chat-log .msg[data-id="4"]')).toEqual([["d30", "#decision/perf/d130-the-bench-s-model"]]);
  /* The same answer in the decision's history is his words still; the fleet's entry beside it links. */
  go("#decision/d58");
  expect(text("#decision .dv-h.answer")).toContain("A: as d30 said");
  expect(linked("#decision .dv-h.answer")).toEqual([]);
  expect(linked("#decision .dv-h.event")).toEqual([["R11", "#roadblock-r11"]]);
});

test("a decision's own page links its title, an option's label, its history; its body's frame is told only the references this ledger holds", () => {
  mount(refsFleetView(NOW), "#decision/d58");
  expect(linked("#decision h1")).toEqual([["d30", "#decision/perf/d130-the-bench-s-model"]]);
  expect(root.querySelector("#decision h1")?.textContent).toBe("D158 Which bench runs nightly, after d30");
  expect(linked("#decision .option .label")).toEqual([["d30", "#decision/perf/d130-the-bench-s-model"]]);
  /* The question is the decision's own words, where a one-digit number always linked: R1 is the roadblock here. */
  expect(linked("#decision .dv-question")).toEqual([
    ["d30", "#decision/perf/d130-the-bench-s-model"],
    ["R1", "#roadblock-r1"],
    ["R11", "#roadblock-r11"],
  ]);
  expect(nested()).toBe(0);

  const lead = (fleet: string | null, num: string): Lead | null => (fleet === null && (num === "d30" || num === "D130") ? { go: "#decision/d30", href: "http://hub/f/perf/#decision/d30", tip: "D130 The bench's <model>" } : null);
  const body = '<p>As d30 chose (D130), not D999; <code>d30</code>, <a href="x" target="_blank">d30</a>.</p><p>d30 again.</p>';
  const refs = bodyRefs(body, [], (word) => word === "d30", lead);

  expect(refs.leads).toEqual(["#decision/d30", "#decision/d30"]);
  expect(Object.values(refs.told.known).map((k) => k.n)).toEqual([0, 1]);
  /* A body is running words: the page never asks where a short word standing alone leads, so the frame is told of none. */
  const asked: string[] = [];

  const short = bodyRefs("<p>Move off D1 onto Postgres (d1), then D130.</p>", [], () => true, (fleet, num) => {
    asked.push(num);

    return lead(fleet, num);
  });

  expect([asked, Object.keys(short.told.known)]).toEqual([["D130"], ["\u0000D130"]]);
});

test("a tip that shows in a field is the page's words, not the field's: a mark claims the same words of the field, tip or no tip", () => {
  mount(refsFleetView(NOW), "#decision/d58");
  const label = root.querySelector<HTMLElement>('#decision [data-field="option:a"]');
  const walk = document.createTreeWalker(label ?? root, NodeFilter.SHOW_TEXT);
  let named: Node | null = null;

  for (let n = walk.nextNode(); n; n = walk.nextNode()) if ((n.nodeValue ?? "").includes("named")) named = n;

  if (!label || !named) throw new Error("no option's label that names d30");

  /** What a selection of "named" (the word after the reference) and of the whole label claim. */
  const claims = (): unknown[] => {
    const word = document.createRange();
    const all = document.createRange();
    const from = (named?.nodeValue ?? "").indexOf("named");

    word.setStart(named ?? label, from);
    word.setEnd(named ?? label, from + "named".length);
    all.selectNodeContents(label);

    return [claimIn(label, word), claimIn(label, all)];
  };

  const plain = claims();

  expect(plain[0]).toMatchObject({ field: "option:a", exact: "named" });
  label.querySelector(".dref-wrap")?.dispatchEvent(new MouseEvent("mouseenter"));
  flush();
  expect(label.querySelector(".dref-tip")?.textContent).toStartWith("D130 The bench's model: decided");
  expect(claims()).toEqual(plain);
});

test("the frame's script, run on a body as its own source: a link around each reference told, built by the DOM, and a tap says only its number", async () => {
  const told = { fleets: [], known: { "\u0000d30": { n: 0, tip: "D130 The bench's <model>", href: "http://hub/f/perf/#decision/d30" } } };
  const holder = document.createElement("div");
  const posted: unknown[] = [];
  const onMessage = (e: MessageEvent): void => void posted.push(e.data);

  holder.innerHTML = '<p>As d30 chose (D130), not d30x; <code>d30</code>, <a href="x" target="_blank">d30</a>.</p>';
  document.body.replaceChildren(holder);
  window.addEventListener("message", onMessage);

  try {
    const script = refScript(told, "tok");

    /* Its JSON cannot end the script element or open a comment in it. */
    expect(script).not.toContain("<model>");
    expect(script).not.toMatch(/<\/script|<!--/iu);
    // SAFETY: the script is the page's own source (`String(refFrame)` and `String(refRuns)`), run here as the frame runs it.
    new Function(script)();
    const made = [...holder.querySelectorAll<HTMLAnchorElement>("a.dref")];

    expect(holder.textContent).toBe("As d30 chose (D130), not d30x; d30, d30.");
    expect(made.map((a) => [a.textContent, a.getAttribute("href"), a.target, a.rel, a.title])).toEqual([["d30", "http://hub/f/perf/#decision/d30", "_blank", "noopener noreferrer", "D130 The bench's <model>"]]);
    expect(holder.querySelector("code")?.children.length).toBe(0);
    made[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    /* The body's own link is the body's: the script says nothing of it. A modified click is the browser's. */
    holder.querySelector<HTMLAnchorElement>('a[href="x"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    made[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    /* A mark that ends in the link (markframe.ts `wrap`): its words in a <mark>, its pin after it, both inside the link. A tap on either is the mark's. */
    const mark = document.createElement("mark");
    const pin = document.createElement("span");

    mark.className = "am k-comment";
    pin.setAttribute("data-pin", "1");
    mark.append(...(made[0]?.childNodes ?? []));
    made[0]?.append(mark, pin);

    for (const at of [mark, pin]) {
      const tap = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });

      at.dispatchEvent(tap);
      expect(tap.defaultPrevented).toBe(false);
    }

    await new Promise((r) => setTimeout(r, 20));
  } finally {
    window.removeEventListener("message", onMessage);
    holder.remove();
  }

  expect(posted).toEqual([{ fleetFrame: "tok", fleetRef: 0 }]);
  expect(tappedRef({ fleetFrame: "tok", fleetRef: 0 })).toBe(0);
  expect([tappedRef({ fleetRef: "0" }), tappedRef({ fleetRef: -1 }), tappedRef({ fleetRef: 0.5 }), tappedRef({ fleetEvidence: true })]).toEqual([null, null, null, null]);
});
