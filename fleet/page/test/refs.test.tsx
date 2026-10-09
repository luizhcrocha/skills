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
import { coordinatorView, type View } from "./fixtures.ts";

const NOW = Date.now();

const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

describe("refRuns", () => {
  test("a number stands alone; a known fleet named before it goes with it", () => {
    expect(refRuns("As D18 said, and pipeline's D40 too; not CA1116 or D18x.", ["pipeline"])).toEqual([
      { kind: "text", text: "As " },
      { kind: "ref", num: "D18", fleet: null, text: "D18" },
      { kind: "text", text: " said, and " },
      { kind: "ref", num: "D40", fleet: "pipeline", text: "pipeline's D40" },
      { kind: "text", text: " too; not CA1116 or D18x." },
    ]);
    expect(refRuns("the D40 word", [])).toEqual([
      { kind: "text", text: "the " },
      { kind: "ref", num: "D40", fleet: null, text: "D40" },
      { kind: "text", text: " word" },
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
  expect(wrap?.querySelector(".dref-tip")?.textContent).toBe("D18 Claude over MCP stays read-only: decided: A: read-only until per-person login, except graph questions");
  expect(wrap?.querySelector("a")?.getAttribute("aria-describedby")).toBe(wrap?.querySelector(".dref-tip")?.id ?? "x");
  wrap?.dispatchEvent(new MouseEvent("mouseleave"));
  flush();
  expect(wrap?.querySelector(".dref-tip")).toBeNull();
});
