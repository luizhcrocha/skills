/**
 * The chat sheet on a phone with the keyboard open, in a real browser (the built template in headless
 * Chromium, fed by the harness). Chromium has no on-screen keyboard, so the test stands in for iOS Safari's:
 * the layout viewport keeps its 844 px and only the visual viewport shrinks, its `resize` event fired. The
 * sheet fills what is on screen, its header one row, the composer whole above the keyboard and capped at
 * 40% of it, and nothing of the page shows under it. On the manager's page, over a fleet's grilling in its
 * frame, the page behind is not painted at all while the sheet covers it: iOS shows the strip between the
 * visual viewport and the keyboard through its translucent bars, and there it showed the frame's question
 * cards. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH). FLEET_SHEET_SHOT=<path>
 * saves a screenshot of the sheet with the keyboard up.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import type { Json } from "../src/core.ts";
import { codeChat, codeView, coordinatorChat, coordinatorView, managerChat, managerView, type View } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

declare global {
  /** What the test leaves on the page's window: the keyboard's height, set and announced. */
  interface Window {
    keyboard: (height: number) => void;
  }
}

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

const LONG = Array.from({ length: 24 }, (_, i) => `Line ${i + 1}: Hermes is just an interface, as the UI and the chat are; the fleet is the engine.`).join("\n");

let browser: Browser;

let harness: Harness;

let manager: Harness;

let billing: Harness;

/** The hub: the manager's page at /f/manager/, billing's (the frame on a decision of billing) beside it. */
let hub: ReturnType<typeof Bun.serve>;

/** Rows of a list in a view that are objects. */
const rows = (v: Json | undefined): View[] => (Array.isArray(v) ? v.filter((x): x is View => x !== null && Object(x) === x && !Array.isArray(x)) : []);

/** Billing's view with G1's first question asked with options, as a grilling card shows them: radio cards. */
function grillingView(): View {
  const view = coordinatorView(NOW);

  const options = [
    { id: "a", label: "Stay in Postgres", consequence: "one safe save" },
    { id: "b", label: "Move to Neo4j", consequence: "every save touches two databases" },
  ];

  const question = { id: "q1", title: "Where the legal terms live", body: "Should the legal terms stay in Postgres or move to Neo4j?", recommend: "a", reason: "One save updates them in one step.", status: "open", asked: view["started"], options };

  return { ...view, decisions: rows(view["decisions"]).map((d) => (d["id"] === "g1" ? { ...d, questions: [question, ...rows(d["questions"]).slice(1)] } : d)) };
}

/** The manager's view with billing's G1 open, so it waits on the user there. */
function managerGrillingView(): View {
  const view = managerView(NOW);
  const g1 = { id: "g1", ref: "G1", kind: "grill", title: "The notes feature", question: "Questions on the notes feature", why: "", blocking: false, asks: "user", opened: view["started"], revised: null, answered: null };

  return { ...view, coordinators: rows(view["coordinators"]).map((c) => (c["id"] === "billing" ? { ...c, decisions: [...rows(c["decisions"]), g1] } : c)) };
}

beforeAll(async () => {
  if (!found) return;
  const template = readFileSync(TEMPLATE, "utf8");
  harness = serveHarness({ template, view: codeView(NOW), messages: codeChat(NOW) });
  manager = serveHarness({ template, view: managerGrillingView(), messages: managerChat(NOW) });
  billing = serveHarness({ template, view: grillingView(), messages: coordinatorChat(NOW) });
  hub = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      const to = new URL(url.pathname.startsWith("/f/manager/") ? manager.url : billing.url).origin;

      return fetch(to + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.body });
    },
  });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  void hub.stop(true);
  harness.stop();
  manager.stop();
  billing.stop();
});

/** The page at 390 × 844 on a decision (`url`, by default a coordinator's A2), its visual viewport the test's to shrink. */
async function open(url = harness.url + "#decision/a8"): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument((t: number) => {
    Date.now = () => t;
    let keyboard = 0;
    const vv = new EventTarget();
    Object.defineProperties(vv, {
      width: { get: () => innerWidth },
      height: { get: () => document.documentElement.clientHeight - keyboard },
      offsetLeft: { get: () => 0 },
      offsetTop: { get: () => 0 },
      pageLeft: { get: () => scrollX },
      pageTop: { get: () => scrollY },
      scale: { get: () => 1 },
    });
    Object.defineProperty(window, "visualViewport", { get: () => vv, configurable: true });
    window.keyboard = (h: number) => {
      keyboard = h;
      vv.dispatchEvent(new Event("resize"));
    };
  }, NOW);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");

  return page;
}

/** A side chat on a passage of the decision, as a finger starts one: the selection, then the bar's Side chat. */
async function sideChatOnQuote(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const el = document.querySelector("#dv-answer .manual-rich > p");
    const range = document.createRange();

    if (el) range.selectNodeContents(el);
    const opts = { bubbles: true, pointerType: "touch", button: 0, isPrimary: true };
    el?.dispatchEvent(new PointerEvent("pointerdown", opts));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    el?.dispatchEvent(new PointerEvent("pointerup", opts));
    await new Promise((r) => setTimeout(r, 400));
  });
  await page.tap('#seltool [data-sel="side"]');
  await page.waitForFunction(() => document.querySelector("#chat.open") !== null && document.querySelector<HTMLElement>("#quote")?.hidden === false);
}

/** Past the sheet's rise and the next two frames. */
const settle = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => r())), 300)));

const isPng = (path: string): path is `${string}.png` => path.endsWith(".png");

interface Edges {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

/** What the sheet shows with the keyboard up. */
interface Sheet {
  readonly vv: Edges;
  readonly sheet: Edges;
  readonly head: number;
  readonly composer: Edges;
  readonly box: Edges;
  readonly quote: Edges;
  readonly say: { readonly bottom: number; readonly client: number; readonly scroll: number; readonly overflow: string };
  /** The page's own elements hit between the sheet's bottom and the layout viewport's. */
  readonly under: readonly string[];
  readonly tabsShown: boolean;
  readonly pageScrolls: boolean;
}

const measure = (page: Page): Promise<Sheet> =>
  page.evaluate((): Sheet => {
    const edges = (sel: string): Edges => {
      const r = document.querySelector(sel)?.getBoundingClientRect() ?? new DOMRect();

      return { top: r.top, bottom: r.bottom, height: r.height };
    };

    const vv = visualViewport;
    const sheet = edges("#chat");
    const say = document.querySelector<HTMLTextAreaElement>("#say");
    const head = ["#chat .chat-head", "#chat-tools", "#side-head"].reduce((n, sel) => n + edges(sel).height, 0);
    const under: string[] = [];

    for (let y = Math.ceil(sheet.bottom) + 1; y < innerHeight; y += 8) {
      const hit = document.elementFromPoint(195, y);

      if (hit && !hit.closest("#chat")) under.push(`${y}: ${hit.tagName.toLowerCase()}${hit.id ? "#" + hit.id : ""}.${[...hit.classList].join(".")}`);
    }

    const tabs = document.querySelector(".tabs");
    const tr = tabs?.getBoundingClientRect();

    return {
      vv: { top: vv?.offsetTop ?? 0, bottom: (vv?.offsetTop ?? 0) + (vv?.height ?? innerHeight), height: vv?.height ?? innerHeight },
      sheet,
      head,
      composer: edges("#composer"),
      box: edges("#box"),
      quote: edges("#quote"),
      say: { bottom: say?.getBoundingClientRect().bottom ?? 0, client: say?.clientHeight ?? 0, scroll: say?.scrollHeight ?? 0, overflow: say ? getComputedStyle(say).overflowY : "" },
      under: under.slice(0, 5),
      tabsShown: Boolean(tabs && tr && tr.height > 0 && getComputedStyle(tabs).visibility === "visible"),
      pageScrolls: getComputedStyle(document.documentElement).overflowY !== "hidden",
    };
  });

test.skipIf(!found)("on a phone with the keyboard up, a side chat's sheet fills what is on screen: one header row, the quote and the whole composer above the keyboard, capped at 40%, nothing of the page under it", async () => {
  const page = await open();
  await sideChatOnQuote(page);

  await page.evaluate(() => window.keyboard(344));
  await page.evaluate((text: string) => {
    const say = document.querySelector<HTMLTextAreaElement>("#say");

    if (!say) return;
    say.value = text;
    say.dispatchEvent(new Event("input", { bubbles: true }));
  }, LONG);
  await settle(page);
  const got = await measure(page);

  const shot = process.env["FLEET_SHEET_SHOT"];

  if (shot && isPng(shot)) {
    await page.evaluate((bottom: number) => {
      const line = document.createElement("div");
      line.style.cssText = `position:fixed;left:0;right:0;top:${bottom}px;height:0;border-top:2px dashed #d00;z-index:999`;
      line.title = "the keyboard's top";
      document.body.append(line);
    }, got.vv.bottom);
    await page.screenshot({ path: shot });
  }

  expect(got.vv.bottom).toBe(500);
  expect(got.sheet.top).toBeCloseTo(got.vv.top, 0);
  expect(got.sheet.bottom).toBeCloseTo(got.vv.bottom, 0);
  expect(got.head).toBeLessThanOrEqual(64);
  expect(got.quote.height).toBeGreaterThan(0);
  expect(got.quote.top).toBeGreaterThanOrEqual(got.sheet.top + got.head);
  expect(got.composer.bottom).toBeLessThanOrEqual(got.vv.bottom + 0.5);
  expect(got.say.bottom).toBeLessThanOrEqual(got.vv.bottom + 0.5);
  expect(got.box.height).toBeGreaterThan(0.3 * got.vv.height);
  expect(got.box.height).toBeLessThanOrEqual(0.4 * got.vv.height + 0.5);
  expect(got.say.scroll > got.say.client ? got.say.overflow : "auto").toBe("auto");
  expect(got.under).toEqual([]);
  expect(got.tabsShown).toBe(false);
  expect(got.pageScrolls).toBe(false);

  /* The keyboard down, the header is whole again and the composer still inside the sheet. */
  await page.evaluate(() => window.keyboard(0));
  await settle(page);
  const down = await measure(page);
  expect(down.sheet.bottom).toBeCloseTo(844, 0);
  expect(down.head).toBeGreaterThan(64);
  expect(down.composer.bottom).toBeLessThanOrEqual(844.5);
  await page.close();
});

test.skipIf(!found)("on the manager's page, a side chat over a fleet's grilling with the keyboard up leaves nothing of the page painted between the composer and the bottom of the screen", async () => {
  const page = await open(`http://127.0.0.1:${String(hub.port)}/f/manager/#decision/billing/g1`);
  const frame = await (await page.waitForSelector("#dv-embed"))?.contentFrame();
  const side = await frame?.waitForSelector(".gq input[type=radio]").then(() => frame.waitForSelector("[data-discuss-side]"));

  if (!side) throw new Error("no Side chat on billing's G1 in the frame");
  await side.tap();
  await page.waitForFunction(() => document.querySelector("#chat.open") !== null && document.querySelector<HTMLElement>("#side-head")?.hidden === false);
  await page.focus("#say");
  await page.evaluate(() => window.keyboard(344));
  await settle(page);

  const got = await page.evaluate(() => {
    const composer = document.querySelector("#composer")?.getBoundingClientRect() ?? new DOMRect();
    const top = Math.max(composer.bottom, (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight));
    const name = (e: Element): string => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + [...e.classList].map((c) => "." + c).join("");
    const painted: string[] = [];
    const sheet = document.querySelector("#chat");

    for (const el of document.querySelectorAll("body *")) {
      if (!sheet || el.closest("#chat") || el.contains(sheet)) continue;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);

      if (r.width > 0 && r.height > 0 && r.bottom > top && r.top < innerHeight && r.right > 0 && r.left < innerWidth && style.visibility === "visible" && style.opacity !== "0") painted.push(name(el));
    }

    const card = getComputedStyle(document.querySelector("#chat") ?? document.body).backgroundColor;

    return { top, painted: painted.slice(0, 6), canvas: [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor].map((c) => (c === "rgba(0, 0, 0, 0)" ? "" : c === card ? "card" : c)) };
  });

  expect(got.top).toBeGreaterThanOrEqual(499.5);
  expect(got.painted).toEqual([]);
  expect(got.canvas).toEqual(["card", "card"]);

  /* The sheet closed, the page is back. */
  await page.evaluate(() => window.keyboard(0));
  await page.tap("#chat-close");
  await page.waitForFunction(() => document.querySelector("#chat.open") === null);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector("#dv-embed") ?? document.body).visibility)).toBe("visible");
  await page.close();
});
