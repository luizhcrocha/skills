/**
 * The selection toolbar in a real browser (the built template in headless Chromium, fed by the harness's
 * event stream): it never covers the selection, lets a right-click reach the browser untouched (the
 * browser's menu with Copy), copies exactly the selection, shows only once the selection rests, and closes
 * on Escape and on a scroll. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { codeChat, codeView } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

declare global {
  /** What the tests leave on the page's window. */
  interface Window {
    menu: { target: string; prevented: boolean } | null;
  }
}

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

let browser: Browser;

let harness: Harness;

beforeAll(async () => {
  if (!found) return;
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: codeView(NOW), messages: codeChat(NOW) });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
  await browser.defaultBrowserContext().overridePermissions(new URL(harness.url).origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

/** The page at `width` (a phone's below 500 px) on `hash`, its stream replayed. */
async function open(width: number, hash: string): Promise<Page> {
  const page = await browser.newPage();
  const phone = width < 500;
  await page.setViewport({ width, height: phone ? 844 : 900, isMobile: phone, hasTouch: phone });
  await page.evaluateOnNewDocument((t: number) => {
    Date.now = () => t;
  }, NOW);
  await page.goto(harness.url + hash, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live" && document.querySelector('#chat-log article[data-id="7"]') !== null);

  return page;
}

/** Select the text of `selector`'s first text by dragging the mouse across it; the selection's text. */
async function dragSelect(page: Page, selector: string): Promise<string> {
  const box = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    const range = document.createRange();

    if (el) range.selectNodeContents(el);
    const rects = [...range.getClientRects()];
    const first = rects[0];
    const last = rects.at(-1);

    return first && last ? { x0: first.left + 1, y0: first.top + first.height / 2, x1: last.right - 1, y1: last.top + last.height / 2 } : null;
  }, selector);

  if (!box) throw new Error(`nothing to select at ${selector}`);
  await page.mouse.move(box.x0, box.y0);
  await page.mouse.down();
  await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 4 });
  /* During the drag the bar stays away. */
  expect(await page.evaluate(() => document.querySelector<HTMLElement>("#seltool")?.hidden)).toBe(true);
  await page.mouse.move(box.x1, box.y1, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#seltool")?.hidden === false);

  return page.evaluate(() => String(getSelection()));
}

/** Whether the toolbar's box meets any line of the selection. */
const covers = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const bar = document.querySelector("#seltool")?.getBoundingClientRect();
    const sel = getSelection();

    if (!bar || !sel?.rangeCount) return true;

    return [...sel.getRangeAt(0).getClientRects()].some((r) => r.width > 0 && bar.left < r.right && bar.right > r.left && bar.top < r.bottom && bar.bottom > r.top);
  });

/** Note the next `contextmenu` as it reaches the document after every handler. */
const watchMenu = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.menu = null;
    document.addEventListener(
      "contextmenu",
      (e) => {
        window.menu = { target: e.target instanceof Element ? e.target.tagName : "#text", prevented: e.defaultPrevented };
      },
      { once: true },
    );
  });

for (const [where, hash, selector] of [
  ["a chat message", "", '#chat-log article[data-id="4"] .msg-text p'],
  ["a decision's text", "#decision/a8", "#dv-answer .manual-rich > p"],
] as const) {
  test.skipIf(!found)(`selecting ${where}: the bar sits off the selection, a right-click reaches the browser, Copy copies the selection`, async () => {
    const page = await open(1280, hash);
    const text = await dragSelect(page, selector);

    expect(text.length).toBeGreaterThan(10);
    expect(await covers(page)).toBe(false);
    expect(await page.evaluate(() => [...document.querySelectorAll("#seltool button")].map((b) => b.textContent))).toEqual(["Copy", "Reply", "Side chat"]);

    /* Copy: exactly the selection. */
    await page.click('#seltool [data-sel="copy"]');
    await page.waitForFunction(() => document.querySelector('#seltool [data-sel="copy"]')?.textContent === "Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

    /* A right-click on the selection: the event is the browser's, the bar goes, the selection stays. */
    await watchMenu(page);

    const mid = await page.evaluate(() => {
      const r = getSelection()?.getRangeAt(0).getClientRects()[0];

      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
    });

    await page.mouse.click(mid.x, mid.y, { button: "right" });
    await page.waitForFunction(() => window.menu !== null);
    expect(await page.evaluate(() => window.menu?.prevented)).toBe(false);
    expect(await page.evaluate(() => document.querySelector<HTMLElement>("#seltool")?.hidden)).toBe(true);
    expect(await page.evaluate(() => String(getSelection()))).toBe(text);
    await page.close();
  });
}

test.skipIf(!found)("Escape and a scroll close the bar", async () => {
  const page = await open(1280, "#decision/a8");
  await dragSelect(page, "#dv-answer .manual-rich > p");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.querySelector<HTMLElement>("#seltool")?.hidden)).toBe(true);
  /* A press inside a selection drags it; the next selection starts from none. */
  await page.evaluate(() => getSelection()?.removeAllRanges());

  await dragSelect(page, "#dv-answer .manual-rich > p");
  await page.evaluate(() => {
    document.body.style.paddingBottom = "2000px";
    window.scrollBy(0, 40);
  });
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#seltool")?.hidden === true);
  await page.close();
});

test.skipIf(!found)("on a phone the bar sits below the selection, clear of its handles, inside the viewport", async () => {
  const page = await open(390, "#decision/a8");

  const got = await page.evaluate(async () => {
    const p = document.querySelector("#dv-answer .manual-rich > p");
    const range = document.createRange();

    if (p?.firstChild) range.selectNodeContents(p);
    const opts = { bubbles: true, pointerType: "touch", button: 0, isPrimary: true };
    p?.dispatchEvent(new PointerEvent("pointerdown", opts));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    p?.dispatchEvent(new PointerEvent("pointerup", opts));
    await new Promise((r) => setTimeout(r, 400));
    const bar = document.querySelector<HTMLElement>("#seltool");
    const b = bar?.getBoundingClientRect();
    const last = [...range.getClientRects()].at(-1);

    return { hidden: bar?.hidden, below: b && last ? b.top - last.bottom : -1, left: b?.left ?? -1, right: b?.right ?? 999 };
  });

  expect(got.hidden).toBe(false);
  expect(got.below).toBeGreaterThanOrEqual(24);
  expect(got.left).toBeGreaterThanOrEqual(0);
  expect(got.right).toBeLessThanOrEqual(390);
  expect(await covers(page)).toBe(false);
  await page.close();
});
