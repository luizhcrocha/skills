/**
 * Standing approvals: the fleet does a routine act without asking, under an approval the user gave once,
 * and records it as a notice. The Decisions view lists the notices under the decisions (never in them, never
 * counted as waiting) and the approvals with Revoke, which posts a plain chat message; a notice's page reads
 * as a record; a decision's page says what the advisor said. Run in happy-dom, through `takeState`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import { rank } from "../src/find.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, type View } from "./fixtures.ts";

const NOW = Date.now();

const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

const RULE = "land a stack that passed the full gate and a review";

const APPROVAL: View = { id: "K1", rule: RULE, by: "luiz", ref: "d1", message: 14, author: "luiz@github", added: at(120), status: "active" };

const REVOKED: View = { id: "K2", rule: "restart a silent worker", by: "luiz", ref: "d1", message: 9, added: at(200), status: "revoked", revoked: at(90), revoked_why: "it restarted one mid-migration" };

/** A notice: closed as it was recorded, done under K1. */
function notice(n: number, minutes: number, extra: View = {}): View {
  return {
    id: "n" + String(n),
    ref: "N" + String(n),
    kind: "notice",
    title: `Landed stack ${String(n)}`,
    question: `Landed the \`invoice-gen\` stack ${String(n)} on master.`,
    status: "decided",
    answer: "done",
    resolution: "under K1",
    blocking: false,
    asks: "user",
    options: [],
    opened: at(minutes),
    closed: at(minutes),
    under: "K1",
    undo: "Back it out:\n\n```nu\njj undo\n```",
    ...extra,
  };
}

const posted: Json[] = [];

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

/** The fixture's fleet, with these notices added to its decisions and these approvals. */
function viewWith(notices: readonly View[], approvals?: readonly View[]): View {
  const base = coordinatorView(NOW);
  const decisions = Array.isArray(base["decisions"]) ? base["decisions"] : [];
  const view: View = { ...base, decisions: [...decisions, ...notices] };

  return approvals ? { ...view, approvals: [...approvals] } : view;
}

/** Render the page on `view`. */
function show(view: View): void {
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.m.setConn("live");
  flush();
}

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  posted.length = 0;
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, a post to chat, else not found.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "skills") return new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 });

    if (url === "chat") {
      const body: { text: string } = JSON.parse(String(init?.body));
      posted.push(body);

      return new Response(JSON.stringify({ id: 99, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text }), { status: 201 });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  dispose();
  root.remove();
});

const text = (sel: string): string => root.querySelector(sel)?.textContent ?? "";

const counts = (): string[] => [...root.querySelectorAll("#decision-seg button")].map((b) => b.textContent);

/** What waits on the viewer, as every count on the page says it. */
function waits() {
  return {
    headline: text("#lead .lead-line"),
    detail: text("#lead .lead-detail"),
    stuck: text("#lead .stuck"),
    badge: text("#nav-decisions"),
    tab: root.querySelector('a[data-view="decisions"]')?.getAttribute("title"),
    counts: counts(),
  };
}

test("notices sit under the decisions, newest first, and change nothing that waits on you", () => {
  show(viewWith([]));
  const before = waits();
  expect(root.querySelector("#notices")).toBeNull();
  expect(root.querySelector("#approvals")).toBeNull();
  dispose();
  root.replaceChildren();

  show(viewWith([notice(1, 30), notice(2, 5)], [APPROVAL]));
  expect(waits()).toEqual(before);
  expect(page.m.queue().ids).not.toContain("n1");

  for (const b of root.querySelectorAll<HTMLButtonElement>("#decision-seg button")) {
    b.click();
    flush();
    expect(root.querySelector('#decision-list a[href^="#decision/n"]')).toBeNull();
  }

  expect(text("#notices h2")).toBe("Done under your approvals");
  const rows = [...root.querySelectorAll("#notice-list .notice")];
  expect(rows.map((r) => r.querySelector(".notice-head")?.textContent)).toEqual(["N2 Landed stack 2", "N1 Landed stack 1"]);
  const first = rows[0];
  expect(first?.querySelector(".notice-head")?.getAttribute("href")).toBe("#decision/n2");
  expect(first?.querySelector(".notice-what")?.textContent).toBe("Landed the invoice-gen stack 2 on master.");
  expect(first?.querySelector(".notice-what code.ic")?.textContent).toBe("invoice-gen");
  expect(first?.querySelector(".notice-undo > b")?.textContent).toBe("Undo:");
  expect(first?.querySelector('.notice-undo figure.code[data-lang="nu"] code')?.textContent).toBe("jj undo");
  expect(first?.querySelector(".notice-undo .code-copy")).not.toBeNull();
  expect(first?.querySelector(".meta")?.textContent).toBe("under K1 · 5 min ago");
  expect(first?.querySelector('.meta a[href="#approval-K1"]')).not.toBeNull();
});

test("a notice never waits, even if the ledger left it open", () => {
  show(viewWith([]));
  const before = waits();
  page.m.takeState(JSON.stringify(viewWith([notice(1, 30, { status: "open", closed: undefined })], [APPROVAL])));
  flush();
  expect(waits()).toEqual(before);
});

test("past the ten newest, the rest fold behind Show all", () => {
  show(viewWith(Array.from({ length: 12 }, (_, i) => notice(i + 1, 60 - i)), [APPROVAL]));
  expect(root.querySelectorAll("#notice-list .notice")).toHaveLength(10);
  expect(root.querySelector("#notice-list .notice-head")?.textContent).toBe("N12 Landed stack 12");
  const more = root.querySelector<HTMLButtonElement>("#notices-all");
  expect(more?.textContent).toBe("Show all 12");
  more?.click();
  flush();
  expect(root.querySelectorAll("#notice-list .notice")).toHaveLength(12);
  expect(more?.textContent).toBe("Show the 10 newest");
});

test("the approvals: the rule, where it was given, what was done under it, and Revoke posts a plain message", async () => {
  show(viewWith([notice(1, 30), notice(2, 5)], [APPROVAL, REVOKED]));
  const row = root.querySelector("#approval-list #approval-K1");
  expect(row?.querySelector(".approval-rule")?.textContent).toBe(`K1 ${RULE}`);
  const meta = row?.querySelector(".meta")?.textContent ?? "";
  expect(meta).toMatch(/^from D1 \(#14\), .+, by luiz · 2 done under it$/u);
  expect(row?.querySelector(".meta a.dref")?.getAttribute("href")).toBe("#decision/d1");
  expect(root.querySelectorAll("#approval-list .approval")).toHaveLength(1);

  const fold = root.querySelector<HTMLDetailsElement>("#approvals-revoked");
  expect(fold?.open).toBe(false);
  expect(fold?.querySelector("summary")?.textContent).toBe("Revoked (1)");
  expect(fold?.querySelector("#approval-K2 .meta")?.textContent).toMatch(/^Revoked .+: it restarted one mid-migration\. Given from D1 \(#9\), .+, by luiz\.$/u);
  expect(fold?.querySelector("button")).toBeNull();

  const revoke = row?.querySelector<HTMLButtonElement>("button[data-revoke]");
  expect(revoke?.textContent).toBe("Revoke");
  expect(revoke?.disabled).toBe(false);
  revoke?.click();
  await Bun.sleep(0);
  flush();
  expect(posted).toEqual([{ text: `Revoke standing approval K1 ("${RULE}"): routine acts under it go back to asking me.` }]);
  expect(revoke?.textContent).toBe("Revoke sent");
  expect(revoke?.disabled).toBe(true);

  /* A state that leaves the approval as it was keeps the button sent; one that revokes it moves it to the fold. */
  page.m.takeState(JSON.stringify({ ...viewWith([notice(1, 30), notice(2, 5), notice(3, 1)], [APPROVAL, REVOKED]) }));
  flush();
  expect(root.querySelector<HTMLButtonElement>("#approval-K1 button[data-revoke]")?.textContent).toBe("Revoke sent");
  expect(root.querySelector<HTMLButtonElement>("#approval-K1 button[data-revoke]")?.disabled).toBe(true);
  page.m.takeState(JSON.stringify(viewWith([notice(1, 30), notice(2, 5)], [{ ...APPROVAL, status: "revoked", revoked: at(0), revoked_why: "asked from the page" }, REVOKED])));
  flush();
  expect(root.querySelector("#approval-list")).toBeNull();
  expect(text("#approvals-revoked summary")).toBe("Revoked (2)");
  expect(posted).toHaveLength(1);
});

test("a viewer who may not write sees Revoke disabled, with the reason", () => {
  show(viewWith([notice(1, 30)], [APPROVAL]));
  page.m.setWrite({ ok: false, reason: "Only luiz@example.com can write here." });
  flush();
  const revoke = root.querySelector<HTMLButtonElement>("#approval-K1 button[data-revoke]");
  expect(revoke?.disabled).toBe(true);
  expect(revoke?.getAttribute("title")).toBe("Only luiz@example.com can write here.");
  expect(revoke?.getAttribute("aria-describedby")).toBe("approvals-why");
  expect(text("#approvals-why")).toBe("Only luiz@example.com can write here.");
  revoke?.click();
  expect(posted).toHaveLength(0);
});

test("a decision's page says what the advisor said under the recommendation, muted when it was not asked", () => {
  const base = coordinatorView(NOW);
  const decisions = Array.isArray(base["decisions"]) ? base["decisions"] : [];
  // SAFETY: the fixture's decisions are records, as coordinatorView writes them.
  const withAdvice = (advised: string | undefined): View => ({ ...base, decisions: decisions.map((d) => ((d as View)["id"] === "d1" ? { ...(d as View), advised } : d)) });
  show(withAdvice("Take B: Stripe rounds the total, and D1's lines stay exact enough."));
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  const line = root.querySelector("#dv-advised");
  expect(line?.textContent).toBe("Advisor: Take B: Stripe rounds the total, and D1's lines stay exact enough.");
  expect(line?.classList.contains("muted")).toBe(false);
  expect(line?.previousElementSibling?.classList.contains("dv-rec")).toBe(true);

  page.m.takeState(JSON.stringify(withAdvice("none: routine, the rule is the ledger's")));
  flush();
  expect(text("#dv-advised")).toBe("Advisor not asked: routine, the rule is the ledger's");
  expect(root.querySelector("#dv-advised")?.classList.contains("muted")).toBe(true);

  page.m.takeState(JSON.stringify(withAdvice(undefined)));
  flush();
  expect(root.querySelector("#dv-advised")).toBeNull();
});

test("a notice's page reads as a record: what was done, under which approval, how to undo it; nothing to answer", () => {
  show(viewWith([notice(1, 30, { why: "the gate and the review passed at 14:02" })], [APPROVAL]));
  location.hash = "#decision/n1";
  page.ui.route();
  flush();
  expect(text("#decision h1")).toBe("N1 Landed stack 1");
  expect(text("#decision .dv-pills")).toBe("donedone under your approval");
  expect(text("#dv-notice .dv-notice-under")).toBe(`Done under K1: ${RULE}`);
  expect(root.querySelector('#dv-notice a[href="#approval-K1"]')).not.toBeNull();
  expect(text("#decision .dv-question")).toBe("Landed the invoice-gen stack 1 on master.");
  expect(text("#decision .dv-undo h3")).toBe("Undo");
  expect(text('#decision .dv-undo figure.code[data-lang="nu"] code')).toBe("jj undo");
  expect(root.querySelector("#decision [data-change]")).toBeNull();
  expect(root.querySelector("#decision [data-add]")).toBeNull();
  expect(root.querySelector("#decision form.dv-form")).toBeNull();
  expect(root.querySelector("#decision .note.decided:not(#dv-notice)")).toBeNull();
});

test("the finder finds a notice by its number and words, and an approval by its rule", () => {
  show(viewWith([notice(3, 5)], [APPROVAL]));
  const rows = Core.findRows(page.m.state, page.m.messages());
  const n3 = rank(rows, "N3")[0]?.row;
  expect(n3?.go).toEqual({ kind: "decision", id: "n3" });
  expect(n3?.pill).toBe("notice");
  expect(rank(rows, "invoice-gen stack")[0]?.row.ref).toBe("N3");
  const a1 = rank(rows, "full gate review")[0]?.row;
  expect(a1?.group).toBe("approvals");
  expect(a1?.go).toEqual({ kind: "view", hash: "#approval-K1" });
  expect(Core.viewOf("#approval-K1")).toEqual({ view: "decisions", decision: null, anchor: "approval-K1" });
});

test("a K number in an item's words links to that standing approval, and an unknown one stays text", () => {
  show(viewWith([notice(1, 5, { question: "Landed it under K1, not K7." })], [APPROVAL]));
  location.hash = "#decision/n1";
  flush();
  const link = root.querySelector<HTMLAnchorElement>('a.dref[data-ref="K1"]');
  expect(link?.getAttribute("href")).toBe("#approval-K1");
  expect(root.querySelector('a.dref[data-ref="K7"]')).toBeNull();
  link?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  link?.parentElement?.dispatchEvent(new MouseEvent("mouseenter"));
  flush();
  expect(root.querySelector(".dref-tip")?.textContent ?? "").toStartWith(`K1 standing approval: ${RULE}; given `);
});
