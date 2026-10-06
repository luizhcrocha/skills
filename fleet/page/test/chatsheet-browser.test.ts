/**
 * The chat sheet on a phone with the keyboard open, in a real browser (the built template in headless
 * Chromium, fed by the harness). Chromium has no on-screen keyboard, so the test stands in for iOS Safari's:
 * the layout viewport keeps its 844 px and only the visual viewport shrinks, its `resize` event fired. The
 * sheet fills what is on screen, its header one row, the composer whole above the keyboard and capped at
 * 40% of it, and nothing of the page shows under it. Skipped when no Chromium is found (FLEET_CHROMIUM, or
 * chromium on the PATH). FLEET_SHEET_SHOT=<path> saves a screenshot of the sheet with the keyboard up.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { codeChat, codeView } from "./fixtures.ts";
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

beforeAll(async () => {
  if (!found) return;
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: codeView(NOW), messages: codeChat(NOW) });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

/** The page at 390 × 844 on a decision, its visual viewport the test's to shrink. */
async function open(): Promise<Page> {
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
  await page.goto(harness.url + "#decision/a8", { waitUntil: "domcontentloaded" });
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
