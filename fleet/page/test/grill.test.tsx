/**
 * A grilling with every question answered that the fleet has not recorded: it waits on the fleet, not on the
 * user, and the page says exactly that (in Waiting, on its own page and on the manager's), never that it is
 * decided; once recorded it is Done. The chat after the last answer (a recap, amendments) changes nothing.
 * Run in happy-dom, through `takeState`.
 */
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, managerView, type Message, type View } from "./fixtures.ts";

const NOW = Date.now();

const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

const question = (id: string): View => ({ id, title: `T ${id}`, body: "B", recommend: "R", reason: "W", of: null, status: "answered", answer: "ok", asked: at(60), answered: at(30) });

const G6: View = {
  id: "g6",
  ref: "G6",
  kind: "grill",
  title: "Search",
  question: "Every question is answered",
  status: "open",
  blocking: false,
  asks: "user",
  opened: at(60),
  revised: at(50),
  options: [],
  questions: [question("q1"), question("q2")],
};

const DECIDED: View = { ...G6, status: "decided", answer: "one seam, local first", resolution: "grilling finished", closed: at(1) };

/** The last answer, the coordinator's recap asking for a "confirm" in the chat, then its amendments. */
const SAID: Message[] = [
  { id: 128, at: at(30), from: "user", to: ["coordinator"], text: "Q1: ok\nQ2: ok", decision: "g6" },
  { id: 129, at: at(29), from: "coordinator", to: ["user"], text: "That empties the tree. Say 'confirm'.", re: 128, decision: "g6" },
  { id: 130, at: at(20), from: "coordinator", to: ["user"], text: "The advisor's amendments.", decision: "g6" },
];

const PILL = "answered, waiting to be recorded";

/** A message as the stream carries it: plain JSON. */
const wire = (m: Message): Json => JSON.parse(JSON.stringify(m));

let page: { m: Model; ui: Ui };

let dispose: (() => void) | undefined;

let root: HTMLElement;

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

  for (const m of SAID) page.ui.addMessage(wire(m), false);
  page.m.setConn("live");
  flush();
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  root.remove();
});

/** The rows of one list, by the text of each. */
function listed(bucket: string): string[] {
  root.querySelector<HTMLButtonElement>(`#decision-seg button[data-bucket="${bucket}"]`)?.click();
  flush();

  return [...root.querySelectorAll("#decision-list a")].map((a) => a.textContent ?? "");
}

test("on its fleet's page it is in Waiting, answered and waiting to be recorded, never decided", () => {
  mount({ ...coordinatorView(NOW), decisions: [G6], roadblocks: [] });
  expect(listed("active").some((t) => t.includes("Search"))).toBe(false);
  expect(listed("done").some((t) => t.includes("Search"))).toBe(false);
  expect(listed("waiting").some((t) => t.includes("Search"))).toBe(true);
  expect(root.querySelector('#decision-list a[href="#decision/g6"] .pill')?.textContent).toBe(PILL);
});

test("its own page says every question is answered and the fleet has yet to record it", () => {
  mount({ ...coordinatorView(NOW), decisions: [G6], roadblocks: [] });
  location.hash = "#decision/g6";
  page.ui.route();
  flush();
  const view = root.querySelector("#decision");
  expect(view?.querySelector(".dv-pills .pill")?.textContent).toBe(PILL);
  expect(view?.querySelector(".note.recording h3")?.textContent).toBe("Every question is answered");
  expect(view?.querySelector(".note.recording p")?.textContent).toBe("The coordinator has yet to record it; the fleet acts on it once it is recorded.");
  expect(view?.textContent).not.toContain("Decided");
});

test("recorded, it moves to Done", () => {
  mount({ ...coordinatorView(NOW), decisions: [G6], roadblocks: [] });
  page.m.takeState(JSON.stringify({ ...coordinatorView(NOW), decisions: [DECIDED], roadblocks: [] }));
  flush();
  expect(listed("waiting").some((t) => t.includes("Search"))).toBe(false);
  expect(listed("done").some((t) => t.includes("Decided: one seam, local first"))).toBe(true);
});

test("on the manager's page, a fleet's grilling with nothing left to answer reads the same", () => {
  const view = managerView(NOW);
  // SAFETY: the fixture's coordinators are records, as managerView writes them.
  const coordinators = view["coordinators"] as View[];
  // As `summary` in src/page/view.ts sends it: open, with its open questions only (none) and the fleet's chat about it.
  const grilling: View = { id: "g6", ref: "G6", kind: "grill", title: "Search", question: "Every question is answered", why: null, blocking: false, asks: "user", opened: at(60), revised: at(50), answered: null, said: SAID.map(wire), questions: [] };
  mount({ ...view, coordinators: coordinators.map((c) => (c["id"] === "billing" ? { ...c, decisions: [grilling] } : c)) });
  expect(listed("active").some((t) => t.includes("Search"))).toBe(false);
  listed("waiting");
  expect(root.querySelector('#decision-list a[href="#decision/billing/g6"] .pill')?.textContent).toBe(PILL);
});
