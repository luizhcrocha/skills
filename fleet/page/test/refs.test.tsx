/**
 * A reference in words a fleet wrote links to the row it names: "D18" in a question, why, option or reason
 * opens D18's page, and on hover or focus a tip says its title and its answer; another fleet's ("billing's D3")
 * links on a manager's page; a row's own id (`d30`) links in the words of the fleet that has that row. One the
 * page cannot find stays plain text, and so does a short word standing alone (`D1`, `s3`) outside a decision's
 * own words. The pure halves first (`refRuns`, then `targetsOf` and `refHref` on the fixtures' ledgers), then
 * happy-dom.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import { refBook, refHref, refRuns, scopeOf, targetsOf, type RefPlace, type RefRun } from "../src/refs.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, managerView, refsManagerView, type View } from "./fixtures.ts";

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

  /** The words of `runs` that are references. */
  const named = (runs: readonly RefRun[]): string[] => runs.flatMap((r) => (r.kind === "ref" ? [r.num] : []));

  test("a number is a capital and digits: a decision's, a standing approval's, a link's, a roadblock's; a one-digit one only in a decision's own words", () => {
    const words = "D18, A87, I2, S1, G26, N3, P4, then K2, L25 and R30; not d18, X9, B2 or DD18.";

    expect(named(refRuns(words, [], undefined, true))).toEqual(["D18", "A87", "I2", "S1", "G26", "N3", "P4", "K2", "L25", "R30"]);
    expect(named(refRuns(words))).toEqual(["D18", "A87", "G26", "L25", "R30"]);
  });

  test("a short word standing alone is a database or a bucket far more often than a row: text in running words, whatever the ledger holds", () => {
    const rows = new Set(["d1", "r2", "s3", "v2", "d30"]);
    const isId = (word: string): boolean => rows.has(word);
    const words = "Move off D1 onto Postgres; Cloudflare R2 and S3 stay. Rows s3, v2, d1 and r2 too; d30 and D30 are rows.";

    expect(named(refRuns(words, fleets, isId))).toEqual(["d30", "D30"]);
    expect(named(refRuns(words, fleets, isId, true))).toEqual(["D1", "R2", "S3", "s3", "v2", "d1", "r2", "d30", "D30"]);
    /* With its fleet named it is a reference everywhere: "pipeline's L1" is said of a row. */
    expect(refRuns("pipeline's L1 and Infra's d1", fleets)).toEqual([
      { kind: "ref", num: "L1", fleet: "pipeline", question: null, text: "pipeline's L1" },
      { kind: "text", text: " and " },
      { kind: "ref", num: "d1", fleet: "infra", question: null, text: "Infra's d1" },
    ]);
  });

  test("a range and a list link each end, read in the fleet named before them; a word after a slash is one nowhere else", () => {
    const isId = (word: string): boolean => word === "d69";

    expect(refRuns("D30-D32, D62/D65 and D41/d69, question 2", [], isId)).toEqual([
      { kind: "ref", num: "D30", fleet: null, question: null, text: "D30" },
      { kind: "text", text: "-" },
      { kind: "ref", num: "D32", fleet: null, question: null, text: "D32" },
      { kind: "text", text: ", " },
      { kind: "ref", num: "D62", fleet: null, question: null, text: "D62" },
      { kind: "text", text: "/" },
      { kind: "ref", num: "D65", fleet: null, question: null, text: "D65" },
      { kind: "text", text: " and " },
      { kind: "ref", num: "D41", fleet: null, question: null, text: "D41" },
      { kind: "text", text: "/" },
      { kind: "ref", num: "d69", fleet: null, question: 2, text: "d69, question 2" },
    ]);
    expect(refRuns("infra's D30-D32/D40", fleets).flatMap((r) => (r.kind === "ref" ? [[r.fleet, r.num, r.text]] : []))).toEqual([
      ["infra", "D30", "infra's D30"],
      ["infra", "D32", "D32"],
      ["infra", "D40", "D40"],
    ]);
    /* A part that is no row makes it a word or a path; a short end stays text beside one that links. */
    expect(named(refRuns("docs/D30, fleet/D18/body, D30-post, pre-D30, D30-32 and d70/D30", [], isId))).toEqual([]);
    expect(named(refRuns("D1-D30 and D2/D40", [], isId))).toEqual(["D30", "D40"]);
  });

  test("a row's own id is one only as written, and only when the fleet whose words they are has that row", () => {
    const rows = new Set(["d30", "l245", "deploy-0067", "m0067-loop"]);
    const isId = (word: string): boolean => rows.has(word);

    expect(refRuns("read the bench design (d30): idea, model, seams", [], isId)).toEqual([
      { kind: "text", text: "read the bench design (" },
      { kind: "ref", num: "d30", fleet: null, question: null, text: "d30" },
      { kind: "text", text: "): idea, model, seams" },
    ]);
    expect(named(refRuns("after l245 and deploy-0067, then m0067-loop.", [], isId))).toEqual(["l245", "deploy-0067", "m0067-loop"]);
    expect(named(refRuns("read the bench design (d30)", [], () => false))).toEqual([]);
    expect(named(refRuns("d31, Deploy-0067, DEPLOY-0067 and L245 the id", [], isId))).toEqual(["L245"]);
  });

  test("a row whose id is an ordinary word (no digit in it) is never one, whatever the ledger holds", () => {
    expect(named(refRuns("the new bench, its preview and the read-cache", [], () => true))).toEqual([]);
  });

  test("never inside a longer word, a version, a file name, a path, an address or code", () => {
    const isId = (word: string): boolean => word === "d30" || word === "v1" || word === "a1b2";

    for (const words of [
      "d30x and xd30, d30_notes, pre-d30, d30-post",
      "tstack 1.9.43, v1.9.43 and Bun 1.4.2",
      "the file d30.md, D18.html and notes.d30",
      "docs/d30, fleet/D18/body and decisions/d30.html",
      "https://hub.example/f/perf/#decision/perf/d30 and http://d30.example:7501/D18?x=d30&y=D18",
      "the hash 9f3a1b2 and 3fa9d30, a1b2c3d4",
      "`d30` and `fleet state decision D18` in code",
      "#12 in the chat, `#12` in code, me@d30, id=d30, ?D18",
    ]) {
      expect([words, named(refRuns(words, [], isId))]).toEqual([words, []]);
    }

    expect(named(refRuns("(d30), 'd30': d30; d30. D18! [D18] “d30” d30/", [], isId))).toEqual(["d30", "d30", "d30", "d30", "D18", "D18", "d30", "d30"]);
  });

  test("never inside a word of another script, and never in a fenced block, closed or not", () => {
    const isId = (word: string): boolean => word === "d30";

    expect(named(refRuns("éD30, D30é, naïved30, d30ß, D30\u0301 and año D18", [], isId))).toEqual(["D18"]);
    expect(named(refRuns("Ran:\n```\nfleet state decision d30 --ref D30\n```\nthen D18.", [], isId))).toEqual(["D18"]);
    expect(named(refRuns("See D18.\n```nu\nopen d30 | get D30", [], isId))).toEqual(["D18"]);
  });

  test("a fleet's name is looked for just before the word: the same work however long the words before, and a name the look cut is none", () => {
    /** Milliseconds to read `n` words that are no reference, each one a candidate with nothing linked before it. */
    const cost = (n: number): number => {
      const words = Array.from({ length: n }, (_, i) => "b" + String(i)).join(" ");
      const t = performance.now();

      refRuns(words, fleets);

      return performance.now() - t;
    };

    cost(2_000);
    const [small, large] = [cost(2_000), cost(32_000)];

    /* Sixteen times the words: about sixteen times the work when each look is bounded, hundreds when each reads all that came before. */
    expect(large / Math.max(small, 0.5)).toBeLessThan(64);
    expect(refRuns("x ".repeat(5_000) + "infra's D30", fleets).at(-1)).toEqual({ kind: "ref", num: "D30", fleet: "infra", question: null, text: "infra's D30" });
    expect(refRuns("a".repeat(200) + " D30", [{ id: "a".repeat(79), names: [] }]).at(-1)).toEqual({ kind: "ref", num: "D30", fleet: null, question: null, text: "D30" });
  });
});

/** A fleet's page, as the fixture's billing fleet: where it is, for a reference's address. */
const FLEET_PLACE: RefPlace = { manager: false, managerPage: "/f/manager/", fleetPage: (fleet) => `/f/${fleet}/` };

const MANAGER_PLACE: RefPlace = { manager: true, managerPage: "/f/manager/", fleetPage: (fleet) => `/f/${fleet}/` };

describe("targetsOf and refHref", () => {
  /** Where the reference `num` leads, in words `fleet` wrote (with `named` said before it), on the page of `view` at `place`. */
  const leads = (view: View, place: RefPlace, fleet: string | null, num: string, named: string | null = null): (string | null)[] => {
    const state = Core.parseState(view);

    if (!state) throw new Error("the fixture is not a state");
    const book = refBook(state);

    return targetsOf(book, scopeOf(book, fleet), named, num).map((t) => refHref(t, place));
  };

  test("on a fleet's own page: each kind of row by its number or its id, and nothing for a row it has not", () => {
    const view = { ...coordinatorView(NOW), approvals: [{ id: "K1", rule: "r", by: "luiz", ref: "d1", message: 1, added: at(9), status: "active" }] };
    const to = (num: string): (string | null)[] => leads(view, FLEET_PLACE, null, num);

    expect([to("D1"), to("d1"), to("A1"), to("a7")]).toEqual([["#decision/billing/d1-rounding-rule-for-totals"], ["#decision/billing/d1-rounding-rule-for-totals"], ["#decision/billing/a1-enable-test-mode-webhooks"], ["#decision/billing/a1-enable-test-mode-webhooks"]]);
    expect([to("L1"), to("l1"), to("R2"), to("r2"), to("K1")]).toEqual([["#link-billing/l1"], ["#link-billing/l1"], ["#roadblock-r2"], ["#roadblock-r2"], ["#approval-K1"]]);
    expect([to("s3"), to("m2"), to("a2"), to("k1")]).toEqual([["#step-s3"], ["#milestone-m2"], ["#agent-a2"], ["#kept-k1"]]);
    expect([to("d99"), to("D99"), to("K9"), to("D1x"), to("billing")]).toEqual([[], [], [], [], []]);
    /* Its own fleet named ("billing's d1") is its own ledger; another's is that fleet's decision on the manager's page. */
    expect(leads(view, FLEET_PLACE, null, "D1", "billing")).toEqual(["#decision/billing/d1-rounding-rule-for-totals"]);
    expect(leads(view, FLEET_PLACE, null, "d172", "infra")).toEqual(["/f/manager/#decision/infra/d172"]);
  });

  test("a word after a fleet's name that names no row stays text: where the page holds that ledger it knows, where it does not only a decision's number or id links", () => {
    /* The manager's page holds perf's ledger: "perf p95" and a decision perf never had name nothing. */
    expect(leads(refsManagerView(NOW), MANAGER_PLACE, null, "d30", "perf")).toEqual(["#decision/perf/d130-t-d130"]);
    expect([leads(refsManagerView(NOW), MANAGER_PLACE, null, "p95", "perf"), leads(refsManagerView(NOW), MANAGER_PLACE, null, "d31", "perf")]).toEqual([[], []]);
    /* A fleet's page knows another fleet only by name: a percentile, a worker and a link are no decision of it. */
    const to = (num: string): (string | null)[] => leads(coordinatorView(NOW), FLEET_PLACE, null, num, "infra");

    expect([to("p95"), to("a96"), to("b42"), to("l205"), to("deploy-0067")]).toEqual([[], [], [], [], []]);
    expect([to("G6"), to("D40"), to("d172")]).toEqual([["/f/manager/#decision/infra/G6"], ["/f/manager/#decision/infra/D40"], ["/f/manager/#decision/infra/d172"]]);
  });

  test("on the manager's page an id is looked up only in the fleet whose words they are, and leads to that fleet's row", () => {
    const view = refsManagerView(NOW);

    expect(leads(view, MANAGER_PLACE, "perf", "d30")).toEqual(["#decision/perf/d130-t-d130"]);
    expect(leads(view, MANAGER_PLACE, "perf", "d58")).toEqual(["#decision/perf/d158-t-d158"]);
    /* The manager's own words name its own d30; billing has none, and infra's is another row. */
    expect(leads(view, MANAGER_PLACE, null, "d30")).toEqual(["#decision/d7-the-manager-s-own"]);
    expect(leads(view, MANAGER_PLACE, "billing", "d30")).toEqual([]);
    expect(leads(view, MANAGER_PLACE, "infra", "d30")).toEqual([]);
    expect(leads(view, MANAGER_PLACE, "perf", "d31")).toEqual([]);
  });

  test("on the manager's page a number is its fleet's first, then whoever holds it; a fleet's link is in the Links view, its roadblock, step and worker on its own page", () => {
    const view = refsManagerView(NOW);

    expect(leads(view, MANAGER_PLACE, "perf", "D130")).toEqual(["#decision/perf/d130-t-d130"]);
    expect(leads(view, MANAGER_PLACE, null, "D130")).toEqual(["#decision/perf/d130-t-d130"]);
    expect(leads(view, MANAGER_PLACE, "billing", "D130")).toEqual(["#decision/perf/d130-t-d130"]);
    expect(leads(view, MANAGER_PLACE, "infra", "D30")).toEqual(["#decision/infra/d30-t-d30"]);
    expect(leads(view, MANAGER_PLACE, "perf", "L25")).toEqual(["#link-perf/bench"]);
    expect(leads(view, MANAGER_PLACE, "perf", "R7")).toEqual(["/f/perf/#roadblocks"]);
    expect(leads(view, MANAGER_PLACE, "perf", "s3")).toEqual(["/f/perf/#step-s3"]);
    expect(leads(view, MANAGER_PLACE, "perf", "a2")).toEqual(["/f/perf/#agent-a2"]);
    expect(leads(view, MANAGER_PLACE, null, "D1").toSorted()).toEqual(["#decision/billing/d1-rounding-rule-for-totals", "#decision/infra/d1-t-d1"]);
  });

  test("the addresses a reference leads to are ones the page routes", () => {
    expect(Core.viewOf("#decision/perf/d30", true)).toEqual({ view: "decisions", decision: "perf/d30", anchor: null });
    expect(Core.viewOf("#link-perf/bench", true)).toEqual({ view: "links", decision: null, anchor: "link-perf/bench" });
    expect(Core.viewOf("#link-l1")).toEqual({ view: "links", decision: null, anchor: "link-l1" });

    for (const name of ["roadblock-r2", "step-s3", "milestone-m2", "kept-k1"]) expect(Core.viewOf("#" + name)).toEqual({ view: "plan", decision: null, anchor: name });
  });
});

/** The rows of a view's list (a manager's fleets). */
const views = (list: View[string]): View[] => (Array.isArray(list) ? list.filter((c): c is View => c !== null && Object(c) === c && !Array.isArray(c)) : []);

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
  expect(links.map((a) => a.getAttribute("href"))).toEqual(["#decision/billing/d18-claude-over-mcp-stays-read-only", "#decision/billing/d18-claude-over-mcp-stays-read-only", "#decision/billing/d18-claude-over-mcp-stays-read-only", "#decision/billing/d18-claude-over-mcp-stays-read-only"]);
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
  const coordinators = views(view["coordinators"]).map((c) => (c["id"] === "infra" ? { ...c, index: [{ group: "decisions", ref: "G72", title: "Where the case chat runs", sub: "", hint: "decided", hash: "#decision/d172" }] } : c));

  mount({ ...view, coordinators, decisions: [{ ...D27, id: "d9", ref: "D1" }] });
  location.hash = "#decision/d9";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  flush();
  const link = root.querySelector<HTMLAnchorElement>("#decision .dv-question a.dref");
  expect(link?.getAttribute("href")).toBe("#decision/infra/g72-where-the-case-chat-runs");
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

/** Fleet `c` of a manager's view (`coordinators`) whose index also holds decisions numbered `refs` (closed ones too). */
function holding(c: View, refs: readonly string[]): View {
  const own = Array.isArray(c["index"]) ? c["index"] : [];

  return { ...c, index: [...own, ...refs.map((ref) => ({ group: "decisions", ref, title: "T", sub: "", hint: "decided", hash: `#decision/${ref.toLowerCase()}` }))] };
}

test("on the manager's page a bare number its own ledger lacks links to the fleet that holds it, served or kept; one several hold shows each in a decision's own words, and stays text in running words", () => {
  const view = managerView(NOW);
  const coordinators = views(view["coordinators"]).map((c) => (c["id"] === "infra" ? holding(c, ["D512", "D17"]) : c["id"] === "billing" ? holding(c, ["D17"]) : c));
  const stopped = [{ id: "old-fleet", index: [{ group: "decisions", ref: "D88", title: "T", sub: "", hint: "decided", hash: "#decision/d88" }] }];

  mount({ ...view, coordinators, stopped, decisions: [{ ...D27, id: "d9", ref: "D1", title: "After D512 and D17", question: "As D512 said, as D17 said, and D88?" }] });
  location.hash = "#decision/d9";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  flush();
  const links = [...root.querySelectorAll<HTMLAnchorElement>("#decision .dv-question a.dref")];
  expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
    ["D512", "#decision/infra/d512-t"],
    ["D17 in billing", "#decision/billing/d17-t"],
    ["D17 in infra", "#decision/infra/d17-t"],
    ["D88", "#decision/old-fleet/d88-t"],
  ]);
  expect(root.querySelector("#decision .dv-question .dref-choices")?.textContent).toBe("D17 in billing · D17 in infra");
  /* The title is running words: no row of choices in the middle of it. */
  expect(root.querySelector("#decision h1")?.textContent).toBe("D1 After D512 and D17");
  expect([...root.querySelectorAll<HTMLAnchorElement>("#decision h1 a.dref")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["D512", "#decision/infra/d512-t"]]);
});
