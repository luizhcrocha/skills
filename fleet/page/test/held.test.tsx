/**
 * An item the fleet holds: the user answered an action, the fleet must fix the code before the action can
 * run, so it held it. The page lists it under Waiting with the reason, names no stuck answer, and words what
 * waits by kind; a revision brings it back to the user's list. Run in happy-dom, through `takeState`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, type Message, type View } from "./fixtures.ts";

const NOW = Date.now();

const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

const ACTION: View = {
  id: "a1",
  ref: "A1",
  kind: "action",
  title: "Run the pipeline role cut",
  question: "Run the role cut on the pipeline.",
  status: "open",
  blocking: false,
  asks: "user",
  opened: at(60),
  manual: "just cut --roles",
  options: [],
};

const HELD: View = { ...ACTION, held: "fix the role cut first", held_at: at(40) };

const ANSWER: Message = { id: 7, at: at(45), from: "user", to: ["coordinator"], text: "It needs a code change first.", decision: "a1" };

const REPLY: Message = { id: 8, at: at(44), from: "coordinator", to: ["user"], text: "Rerun when I post the new command.", re: 7 };

/** A message as the stream carries it: plain JSON. */
const wire = (m: Message): Json => JSON.parse(JSON.stringify(m));

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

/** The fixture's fleet with only these items. */
function viewWith(...decisions: View[]): View {
  return { ...coordinatorView(NOW), decisions, roadblocks: [] };
}

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, empty; anything else, not found.
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input) === "skills" ? new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 }) : new Response("{}", { status: 404 })) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(viewWith(HELD));

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();

  for (const m of [ANSWER, REPLY]) page.ui.addMessage(wire(m), false);
  page.m.setConn("live");
  flush();
});

afterEach(() => {
  dispose();
  root.remove();
});

const headline = (): string => root.querySelector("#lead .lead-line")?.textContent ?? "";

const bucket = (name: string): HTMLButtonElement | null => root.querySelector(`#decision-seg button[data-bucket="${name}"]`);

test("a held action sits in Waiting with its reason, and nothing is stuck", () => {
  expect(headline()).toBe("Nothing waits on you.");
  expect(root.querySelector("#lead .lead-detail")?.textContent).toBe("1 action is with the fleet, back to you when it is ready.");
  /* The fixture's blocked worker is silent; no answer is stuck. */
  expect(root.querySelector("#lead .stuck")?.textContent ?? "").not.toContain("not recorded");
  bucket("waiting")?.click();
  flush();
  const row = root.querySelector('#decision-list a[href="#decision/a1"]');
  expect(row?.querySelector(".detail")?.textContent).toBe("With the fleet: fix the role cut first");
  expect(row?.querySelector(".pill")?.textContent ?? row?.textContent).toContain("with the fleet");
});

test("its page says it is with the fleet, and since when", () => {
  location.hash = "#decision/a1";
  page.ui.route();
  flush();
  const note = root.querySelector("#decision .note.held");
  expect(note?.querySelector("h3")?.textContent).toBe("With the fleet");
  expect(note?.querySelector("p")?.textContent).toBe("fix the role cut first");
  expect(note?.querySelector(".dv-meta")?.textContent).toMatch(/^Held .+, 4\d min ago\. It comes back to you when the coordinator asks again\.$/u);
});

test("a plain reply to the answer does not hand it back; a revision after it does", () => {
  page.m.takeState(JSON.stringify(viewWith(ACTION)));
  flush();
  expect(headline()).toBe("Nothing waits on you.");
  expect(root.querySelector("#lead .lead-detail")?.textContent).toBe("Your answer waits to be recorded.");
  page.m.takeState(JSON.stringify(viewWith({ ...ACTION, revised: at(5), change: "the role cut is fixed: run this", manual: "just cut --roles --fixed" })));
  flush();
  expect(headline()).toBe("1 action waits on you.");
  expect(root.querySelector("#nav-decisions")?.textContent).toBe("1");
  expect(root.querySelector('a[data-view="decisions"]')?.getAttribute("title")).toBe("1 action waits on you");
});

test("what waits is named by kind: one of each of two kinds, and things for three", () => {
  const input: View = { ...ACTION, id: "i1", ref: "I1", kind: "input", title: "Footer", opened: at(30) };
  const choice: View = { ...ACTION, id: "d1", ref: "D1", kind: "decision", title: "Rounding", opened: at(20), recommend: "a", options: [{ id: "a", label: "A", consequence: "x" }, { id: "b", label: "B", consequence: "y" }] };
  page.m.takeState(JSON.stringify(viewWith({ ...ACTION, revised: at(5) }, choice)));
  flush();
  expect(headline()).toBe("1 decision and 1 action wait on you.");
  page.m.takeState(JSON.stringify(viewWith({ ...ACTION, revised: at(5) }, choice, input)));
  flush();
  expect(headline()).toBe("3 things wait on you.");
});
