/**
 * A decision's page reads top-down: the title, the ask large, what it blocks or assumes, the body (folded when
 * long), the recommendation as a callout, the options, the conversation, then the history newest first, the earlier moments
 * folded. A question recorded before the 400-character rule is shown in parts (its asking sentence large,
 * the rest in paragraphs, its numbered run as a list) without changing what is stored. The parts and the
 * history are pure (`askParts`, `historyOf`); the page is run in happy-dom.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { askParts } from "../src/ask.ts";
import { Core, type Decision, type FleetEvent, type Json, type Message as CoreMessage } from "../src/core.ts";
import { historyOf } from "../src/history.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, type Message, type View } from "./fixtures.ts";

const NOW = Date.now();

const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

const LONG =
  "The plan: OCR keeps running in our container, sending only the pages that need it to a GPU, with Tesseract as the fallback. " +
  "Today's OCR rule is fixed first and must beat today's on the labelled page set before anything ships. " +
  "Old documents with scanned pages are re-read from a list (about US$0.011 a page), priced from a pilot that comes back to you. " +
  "Four settings: (1) GPUs (10 at once): entities 6, OCR 3, Chandra 1. (2) A US$5 cap for the checks. " +
  "(3) Old files' copies go up to Box only after a trial you look at. (4) No PDF/A for now. Approve?";

describe("askParts", () => {
  test("a short question is the ask as it is", () => {
    expect(askParts("Lock now or tonight?")).toEqual({ lead: "Lock now or tonight?", more: [] });
  });

  test("a long one: its asking sentence large, the rest in paragraphs, its numbered run as a list", () => {
    const ask = askParts(LONG);
    expect(ask.lead).toBe("Approve?");
    expect(askParts(LONG, "OCR build: approve the plan and its four settings").lead).toBe("OCR build: approve the plan and its four settings?");
    expect(askParts(LONG.replace("Approve?", "Do you approve the plan with these four settings?"), "OCR build").lead).toBe("Do you approve the plan with these four settings?");
    expect(ask.more.at(-1)).toEqual({
      kind: "list",
      items: ["GPUs (10 at once): entities 6, OCR 3, Chandra 1.", "A US$5 cap for the checks.", "Old files' copies go up to Box only after a trial you look at.", "No PDF/A for now."],
    });
    const paras = ask.more.flatMap((p) => (p.kind === "para" ? [p.text] : []));
    expect(paras[0]).toStartWith("The plan: OCR keeps running");
    expect(paras.at(-1)).toEndWith("Four settings:");
    expect(paras.join(" ")).toContain("(about US$0.011 a page)");
  });

  test("with no question mark, the first sentence leads", () => {
    const q = "Ship the fix tonight. " + "It touches the parser and the index, and the tests pass on the labelled set. ".repeat(5);
    expect(askParts(q).lead).toBe("Ship the fix tonight.");
  });

  test("a question already laid out in paragraphs leads with its first; one with code is left whole", () => {
    const q = "Approve the cut?\n\n" + "x ".repeat(200);
    expect(askParts(q).lead).toBe("Approve the cut?");
    const code = "Run this?\n```nu\nls\n```\n" + "y".repeat(400);
    expect(askParts(code)).toEqual({ lead: code, more: [] });
  });
});

describe("historyOf", () => {
  // SAFETY: historyOf reads only a decision's id, kind and title.
  const d = { id: "d1", kind: "decision", title: "OCR build" } as Decision;
  const ev = (minutes: number, kind: string, text: string): FleetEvent => ({ at: at(minutes), kind, text, decision: "d1" });

  test("newest first, each moment named, the title taken off", () => {
    const events = [ev(50, "asked", "OCR build: Approve?"), ev(40, "asked", "OCR build changed: the cap is US$5 now"), ev(30, "asked", "OCR build changed: kind, title, question"), ev(5, "decision", "OCR build: A: Approve (answered on the page (#14))")];
    // SAFETY: historyOf reads only a message's at, from, decision and text.
    const answer = { id: 14, at: at(10), from: "user", decision: "d1", text: "A: Approve" } as CoreMessage;
    expect(historyOf(d, events, [answer]).map((e) => `${e.what}: ${e.text}`)).toEqual([
      "Decided: A: Approve (answered on the page (#14))",
      "You answered: A: Approve",
      "Changed: no note; fields given: kind, title, question",
      "Changed: the cap is US$5 now",
      "Asked: Approve?",
    ]);
  });
});

const D40: View = {
  id: "d40",
  ref: "D40",
  kind: "decision",
  title: "OCR build: approve the plan and its four settings",
  question: LONG,
  why: "Nothing runs until you answer.",
  status: "open",
  blocking: false,
  asks: "user",
  opened: at(60),
  revised: at(20),
  options: [
    { id: "A", label: "Approve as proposed", consequence: "Step 1 starts today at US$0." },
    { id: "B", label: "Approve, change a setting", consequence: "Name the setting by its number in the note." },
  ],
  recommend: "A",
  reason: "It fixes the blind spot first and writes nothing to Box before your trial.",
};

const EVENTS = [
  { at: at(60), kind: "asked", text: `${String(D40["title"])}: ${LONG}`, decision: "d40" },
  { at: at(20), kind: "asked", text: `${String(D40["title"])} changed: infra reviewed the design`, decision: "d40" },
];

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, empty; anything else, not found.
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input) === "skills" ? new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 }) : new Response("{}", { status: 404 })) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
  const view: View = { ...coordinatorView(NOW), decisions: [D40], roadblocks: [], events: EVENTS };
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  const answer: Message = { id: 9, at: at(10), from: "user", to: ["coordinator"], text: "B: Approve, change a setting\n\nMake the cap US$10.", decision: "d40" };
  // SAFETY: a fixture message, as plain JSON is what the stream carries.
  page.ui.addMessage(JSON.parse(JSON.stringify(answer)) as Json, false);
  page.m.setConn("live");
  location.hash = "#decision/d40";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  flush();
});

afterEach(() => {
  dispose();
  root.remove();
});

test("the page reads top-down: the ask, the details, the recommendation, the options, then the history", () => {
  const order = ["#dv-info .dv-question", "#dv-info .dv-why", "#dv-body", ".dv-rec", "#dv-answer", "#dv-history"].map((sel) => root.querySelector(sel));
  expect(order.every((el) => el !== null)).toBe(true);

  for (let i = 1; i < order.length; i++) {
    const before = order[i - 1];
    const after = order[i];

    if (before && after) expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }

  expect(root.querySelector(".dv-fold #dv-body")).not.toBeNull();
  expect(root.querySelector(".dv-rec .dv-rec-pick")?.textContent).toBe("A: Approve as proposed");
});

test("a legacy long question shows its ask large and the rest in parts, its settings as a list", () => {
  expect(root.querySelector("#dv-info .dv-question")?.textContent).toBe("OCR build: approve the plan and its four settings?");
  const items = [...root.querySelectorAll(".dv-ask-more ol > li")].map((li) => li.textContent);
  expect(items).toEqual(["GPUs (10 at once): entities 6, OCR 3, Chandra 1.", "A US$5 cap for the checks.", "Old files' copies go up to Box only after a trial you look at.", "No PDF/A for now."]);
  expect(page.m.decisionById("d40")?.question).toBe(LONG);
});

test("the history: the latest moment shows, the earlier fold, a long one opens to its whole text", () => {
  const history = root.querySelector("#dv-history");
  const latest = history?.querySelector(":scope > .dv-h-list > li");
  expect(latest?.querySelector(".dv-h-what")?.textContent).toBe("You answered");
  expect(history?.querySelector(".dv-h-more > summary")?.textContent).toBe("2 earlier");
  const asked = [...(history?.querySelectorAll(".dv-h-more li") ?? [])].at(-1);
  expect(asked?.querySelector(".dv-h-what")?.textContent).toBe("Asked");
  expect(asked?.querySelector("details .dv-h-full")?.textContent).toContain("Four settings:");
});
