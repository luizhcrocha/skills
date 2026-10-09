/**
 * A grilling question reads like a small decision: its title, the question in plain size, its options as
 * cards with the recommended one marked, the reason as a callout with its sources apart, and a field for the
 * user's own words. A question asked before options puts them in its prose, "(a) …; (b) …", and is read into
 * cards without changing what is stored. A follow-up says what it follows. The grilling's body is its context,
 * once, above the first question. One send carries every answer. Pure parts first, then the page in happy-dom.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Question } from "../src/core.ts";
import { grillAsk, grillReason } from "../src/grill.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, type View } from "./fixtures.ts";

const NOW = Date.now();

const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

/** G26's Q2 as infra asked it, before options. */
const LEGACY: Question = {
  id: "q2",
  title: "Is the ontology a graph-domain thing",
  body: "Should ontology_terms/ontology_decisions move to Neo4j? (a) no, stay in Postgres; (b) yes, with the loop; (c) stay in Postgres and mirror them as nodes for graph.ask",
  recommend: "(a), adding (c) only if a question needs it",
  reason:
    "The registry's correctness rests on one transaction under the vocabulary lock (postgres/vocabulary-store.ts:5-9) and the version join that owes passes; Workers reach Aura over HTTP with no cross-store transaction, so (b) splits every loop turn across two stores non-atomically. ADR-0020 d5 already says the ontology appears in the graph only as labels and types.",
  status: "open",
  asked: at(30),
};

/** The same question, asked with options. */
const CARDS: Question = {
  id: "q1",
  title: "Where the legal terms live",
  body: "Should the list of legal terms, and the decisions about them, stay in Postgres or move to the graph database (Neo4j)?",
  recommend: "a",
  reason: "Today one save updates the terms safely in one step; splitting them across two databases means a save can half-succeed.",
  options: [
    { id: "a", label: "Stay in Postgres", consequence: "one safe save; the graph shows the terms as labels, as today" },
    { id: "b", label: "Move to Neo4j", consequence: "every save touches two databases, and a failure leaves them out of step" },
  ],
  status: "open",
  asked: at(30),
};

describe("grillAsk", () => {
  test("a question asked before options is read into cards, its recommendation mapped to one", () => {
    const shown = grillAsk(LEGACY);
    expect(shown.lead).toBe("Should ontology_terms/ontology_decisions move to Neo4j?");
    expect(shown.options.map((o) => `${o.id}: ${String(o.label)}`)).toEqual(["a: no, stay in Postgres", "b: yes, with the loop", "c: stay in Postgres and mirror them as nodes for graph.ask"]);
    expect(shown.recommended).toBe("a");
    expect(shown.also).toBe("adding (c) only if a question needs it");
    expect(shown.parsed).toBe(true);
  });

  test("a parenthesis that is not an option stays in the question", () => {
    const shown = grillAsk({ ...LEGACY, body: "When inference (Jev, Cypher patterns) derives a new term, where does it live? (a) Postgres; (b) Neo4j", recommend: "(a)" });
    expect(shown.lead).toBe("When inference (Jev, Cypher patterns) derives a new term, where does it live?");
    expect(shown.options.length).toBe(2);
  });

  test("a question with options keeps them; one with no run of options has none", () => {
    expect(grillAsk(CARDS)).toMatchObject({ lead: CARDS.body, options: CARDS.options, recommended: "a", parsed: false });
    expect(grillAsk({ ...LEGACY, body: "Keep it? (a) yes" }).options).toEqual([]);
  });

  test("a reason's parenthesised sources are taken out and listed apart", () => {
    const r = grillReason(LEGACY.reason ?? "");
    expect(r.text).toStartWith("The registry's correctness rests on one transaction under the vocabulary lock and the version join that owes passes; Workers");
    expect(r.sources).toEqual(["postgres/vocabulary-store.ts:5-9"]);
  });
});

const G26: View = {
  id: "g26",
  ref: "G26",
  kind: "grill",
  title: "Where the legal terms and the graph live",
  question: "3 questions to answer",
  status: "open",
  blocking: false,
  asks: "user",
  opened: at(30),
  options: [],
  body: true,
  // SAFETY: a question is plain JSON, as the ledger stores it.
  questions: [CARDS, LEGACY, { ...CARDS, id: "q3", title: "Who checks a new term", of: "q1", options: [{ id: "a", label: "A person", consequence: "slower" }, { id: "b", label: "Nobody", consequence: "faster" }], recommend: "b" }].map((q) => JSON.parse(JSON.stringify(q)) as View),
};

let page: { m: Model; ui: Ui };

let dispose: (() => void) | undefined;

let root: HTMLElement;

const posted: { text: string; decision?: string }[] = [];

function mount(view: View): void {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  posted.length = 0;
  location.hash = "";
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, the context, a post to chat.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "skills") return new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 });

    if (url.startsWith("decisions/g26.html")) return new Response("<h2>In short</h2><p>The loop writes Postgres.</p>", { status: 200 });

    if (url === "chat") {
      const body: { text: string; decision?: string } = JSON.parse(String(init?.body));
      posted.push(body);

      return new Response(JSON.stringify({ id: 50 + posted.length, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text, decision: body.decision }), { status: 201 });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.m.setConn("live");
  flush();
  location.hash = "#decision/g26";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  flush();
}

afterEach(() => {
  if (dispose === undefined) return;
  dispose();
  dispose = undefined;
  root.remove();
});

const card = (q: string): HTMLElement | null => root.querySelector<HTMLElement>(`fieldset.gq[data-q="${q}"]`);

test("each question reads like a small decision: title, question, options as cards, the recommended marked, the reason as a callout", () => {
  mount({ ...coordinatorView(NOW), decisions: [G26], roadblocks: [] });
  const q1 = card("q1");
  expect(q1?.querySelector("legend")?.textContent).toBe("Q1 Where the legal terms live");
  expect(q1?.querySelector(".gq-ask")?.textContent).toBe(CARDS.body);
  expect([...(q1?.querySelectorAll(".gq-options .option .label") ?? [])].map((l) => l.textContent)).toEqual(["a: Stay in Postgresrecommended", "b: Move to Neo4j"]);
  expect(q1?.querySelector(".gq-options .option .consequence")?.textContent).toBe("one safe save; the graph shows the terms as labels, as today");
  expect(q1?.querySelector(".gq-rec h4")?.textContent).toBe("Recommended: a, Stay in Postgres");
  expect(q1?.querySelector('input[value="own"]')).not.toBeNull();
  expect(q1?.querySelector("textarea")).not.toBeNull();
});

test("a legacy question's inline options are cards, its sources folded apart; what is stored is unchanged", () => {
  mount({ ...coordinatorView(NOW), decisions: [G26], roadblocks: [] });
  const q2 = card("q2");
  expect(q2?.querySelector(".gq-ask")?.textContent).toBe("Should ontology_terms/ontology_decisions move to Neo4j?");
  expect(q2?.querySelectorAll(".gq-options .option").length).toBe(3);
  expect(q2?.querySelector(".gq-rec h4")?.textContent).toBe("Recommended: a, no, stay in Postgres (adding (c) only if a question needs it)");
  expect(q2?.querySelector(".gq-sources summary")?.textContent).toBe("Sources (1)");
  expect(q2?.querySelector(".gq-why.folded")).not.toBeNull();
  expect(page.m.decisionById("g26")?.questions?.[1]?.body).toBe(LEGACY.body);
});

test("a follow-up sits under what it follows and names it", () => {
  mount({ ...coordinatorView(NOW), decisions: [G26], roadblocks: [] });
  const order = [...root.querySelectorAll<HTMLElement>("fieldset.gq")].map((f) => f.dataset["q"]);
  expect(order).toEqual(["q1", "q3", "q2"]);
  expect(card("q3")?.classList.contains("follow")).toBe(true);
  expect(card("q3")?.querySelector(".gq-of")?.textContent).toBe("Follows up Q1: Where the legal terms live");
});

test("the grilling's body is its context, once, above the first question", () => {
  mount({ ...coordinatorView(NOW), decisions: [G26], roadblocks: [] });
  const context = root.querySelector("#dv-body");
  expect(context?.querySelector("h2")?.textContent).toBe("The context");
  expect(root.querySelectorAll("#dv-body").length).toBe(1);
  const first = card("q1");
  expect(context && first ? context.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
});

test("one send carries every answer: an option by its id and label, a note to it, the user's own words", async () => {
  mount({ ...coordinatorView(NOW), decisions: [G26], roadblocks: [] });

  const pick = (q: string, value: string): void => {
    card(q)?.querySelector<HTMLInputElement>(`input[value="${value}"]`)?.click();
  };

  const type = (q: string, text: string): void => {
    const box = card(q)?.querySelector("textarea");

    if (!box) return;
    box.value = text;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  };

  pick("q1", "a");
  type("q1", "keep the labels as they are");
  expect(card("q1")?.querySelector<HTMLInputElement>('input[value="a"]')?.checked).toBe(true);
  pick("q2", "b");
  type("q3", "ask me per case");
  expect(card("q3")?.querySelector<HTMLInputElement>('input[value="own"]')?.checked).toBe(true);
  root.querySelector<HTMLButtonElement>(".dv-form.grill button[type=submit]")?.click();
  await new Promise((r) => setTimeout(r, 20));
  flush();
  expect(posted).toHaveLength(1);
  expect(posted[0]?.decision).toBe("g26");
  expect(posted[0]?.text).toBe("Q1: a: Stay in Postgres (as recommended). keep the labels as they are\nQ3: ask me per case\nQ2: b: yes, with the loop");
});
