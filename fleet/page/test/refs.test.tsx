/**
 * A decision's number in an item's words links to that decision: "D18" in a question, why, option or reason
 * opens D18's page, and on hover or focus a tip says its title and its answer; another fleet's ("billing's D3")
 * links on a manager's page. A number the page cannot find stays plain text. Pure split first, then happy-dom.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import { refRuns } from "../src/refs.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, managerView, type View } from "./fixtures.ts";

const NOW = Date.now();

const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

describe("refRuns", () => {
  const fleets = [{ id: "pipeline", names: [] }, { id: "infra", names: ["Infra coordinator"] }];

  test("a bare number is a capital and digits; a known fleet named before it, any case, goes with its number or id", () => {
    expect(refRuns("As D18 said, pipeline's D40 and Infra's d172, question 2; not CA1116, D18x or d26.", fleets)).toEqual([
      { kind: "text", text: "As " },
      { kind: "ref", num: "D18", fleet: null, question: null, text: "D18" },
      { kind: "text", text: " said, " },
      { kind: "ref", num: "D40", fleet: "pipeline", question: null, text: "pipeline's D40" },
      { kind: "text", text: " and " },
      { kind: "ref", num: "d172", fleet: "infra", question: 2, text: "Infra's d172, question 2" },
      { kind: "text", text: "; not CA1116, D18x or d26." },
    ]);
  });

  test("a question named as Q2 goes with its number; a word that is no fleet stays text", () => {
    expect(refRuns("G26 Q2 and acme's d3", fleets)).toEqual([
      { kind: "ref", num: "G26", fleet: null, question: 2, text: "G26 Q2" },
      { kind: "text", text: " and acme's d3" },
    ]);
  });
});

const D18: View = {
  id: "d18",
  ref: "D18",
  kind: "decision",
  title: "Claude over MCP stays read-only",
  question: "Read-only for now?",
  status: "decided",
  answer: "A: read-only until per-person login, except graph questions",
  blocking: false,
  asks: "user",
  opened: at(1500),
  closed: at(1400),
  options: [],
};

const D26: View = {
  id: "d26",
  ref: "D26",
  kind: "decision",
  title: "Block case processing over MCP",
  question: "Claude over MCP can still start case processing, though D18 keeps it read-only. Block it now?",
  why: "Until you answer, D99 and D18 stand.",
  status: "open",
  blocking: false,
  asks: "user",
  opened: at(30),
  options: [
    { id: "A", label: "Block it", consequence: "as D18 chose" },
    { id: "B", label: "Leave it", consequence: "open until login lands" },
  ],
  recommend: "A",
  reason: "D18 already decided it.",
};

let page: { m: Model; ui: Ui };

let dispose: (() => void) | undefined;

let root: HTMLElement;

afterEach(() => {
  if (dispose === undefined) return;
  dispose();
  dispose = undefined;
  root.remove();
});

function mount(view: View): void {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
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
  location.hash = "#decision/d26";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  flush();
}

test("a decision's number in the question, why, option and reason links to it; one not found stays text", () => {
  mount({ ...coordinatorView(NOW), decisions: [D18, D26], roadblocks: [] });
  const links = [...root.querySelectorAll<HTMLAnchorElement>("#decision a.dref")];
  expect(links.map((a) => a.getAttribute("href"))).toEqual(["#decision/d18", "#decision/d18", "#decision/d18", "#decision/d18"]);
  expect(root.querySelector("#decision .dv-why")?.textContent).toContain("D99");
  expect([...root.querySelectorAll("#decision a.dref")].some((a) => a.textContent === "D99")).toBe(false);
});

test("hover or focus shows its title and answer", () => {
  mount({ ...coordinatorView(NOW), decisions: [D18, D26], roadblocks: [] });
  const wrap = root.querySelector<HTMLElement>("#decision .dv-question .dref-wrap");
  expect(wrap?.querySelector(".dref-tip")).toBeNull();
  wrap?.dispatchEvent(new MouseEvent("mouseenter"));
  flush();
  const tip = wrap?.querySelector(".dref-tip")?.textContent ?? "";
  expect(tip).toStartWith("D18 Claude over MCP stays read-only: decided ");
  expect(tip).toEndWith(": A: read-only until per-person login, except graph questions.");
  expect(wrap?.querySelector("a")?.getAttribute("aria-describedby")).toBe(wrap?.querySelector(".dref-tip")?.id ?? "x");
  wrap?.dispatchEvent(new MouseEvent("mouseleave"));
  flush();
  expect(wrap?.querySelector(".dref-tip")).toBeNull();
});

/** Infra's ledger as the hub serves it (f/infra/state.json): G172 decided on 10-07, its question 2 answered. */
const INFRA = {
  ...coordinatorView(NOW),
  fleet: "infra",
  decisions: [
    {
      id: "d172",
      ref: "G72",
      kind: "grill",
      title: "Where the case chat runs",
      question: "Every question is answered",
      status: "decided",
      answer: "the chat stays on Workers",
      resolution: "grilling finished",
      blocking: false,
      asks: "user",
      opened: "2026-10-07T09:00:00Z",
      closed: "2026-10-07T15:00:00Z",
      options: [],
      questions: [
        { id: "q1", title: "Where it runs", status: "answered", answer: "Workers" },
        { id: "q2", title: "Who may start case processing", status: "answered", answer: "only the pipeline, never Claude over MCP" },
      ],
    },
  ],
};

const D27: View = { ...D26, id: "d27", ref: "D27", question: "Should Claude over MCP be blocked, as Infra's d172, question 2 settled?", why: "w", reason: "r", options: [] };

test("another fleet's decided decision links to the manager's page, and its tip reads that fleet's ledger: title, answer, when, the question", async () => {
  const fetched: string[] = [];
  mount({ ...coordinatorView(NOW), decisions: [D27], roadblocks: [] });
  // SAFETY: the stub answers the fleet's state.json with infra's ledger, else not found.
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input));

    return String(input).endsWith("f/infra/state.json") ? new Response(JSON.stringify(INFRA), { status: 200 }) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  location.hash = "#decision/d27";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  flush();
  const link = root.querySelector<HTMLAnchorElement>("#decision .dv-question a.dref");
  expect(link?.textContent).toBe("Infra's d172, question 2");
  expect(link?.getAttribute("href")).toBe(page.m.managerPage() + "#decision/infra/d172");
  expect(link?.getAttribute("target")).toBe("_top");
  link?.parentElement?.dispatchEvent(new MouseEvent("mouseenter"));
  flush();
  await new Promise((r) => setTimeout(r, 20));
  flush();
  const tip = root.querySelector("#decision .dref-tip")?.textContent ?? "";
  expect(fetched).toEqual(["/f/infra/state.json"]);
  expect(tip).toStartWith("G72 Where the case chat runs, in infra: decided ");
  expect(tip).toEndWith(". Question 2, Who may start case processing: only the pipeline, never Claude over MCP.");
});

test("on the manager's page it links to the fleet's decision there, which the fleet's own page opens, closed or by its number", () => {
  const view = managerView(NOW);
  mount({ ...view, decisions: [{ ...D27, id: "d9", ref: "D1" }] });
  location.hash = "#decision/d9";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  flush();
  const link = root.querySelector<HTMLAnchorElement>("#decision .dv-question a.dref");
  expect(link?.getAttribute("href")).toBe("#decision/infra/d172");
  expect(link?.getAttribute("target")).toBeNull();
  location.hash = "#decision/infra/d172";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  flush();
  expect(root.querySelector<HTMLIFrameElement>("#dv-embed")?.getAttribute("src")).toEndWith("f/infra/?embed=1#decision/d172");
});

test("a fleet's own page opens a decision named by its number as well as its id, closed ones included", () => {
  mount({ ...coordinatorView(NOW), decisions: [D18, D26], roadblocks: [] });
  location.hash = "#decision/D18";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  flush();
  expect(root.querySelector("#decision h1")?.textContent).toContain("Claude over MCP stays read-only");
});
