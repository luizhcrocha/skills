/**
 * The selection toolbar in a real browser (the built template in headless Chromium, fed by the harness's
 * event stream): it never covers the selection, lets a right-click reach the browser untouched (the
 * browser's menu with Copy), copies exactly the selection, shows only once the selection rests, and closes
 * on Escape and on a scroll; a quote sent from it leads back, from the chat, to where it was taken. Skipped
 * when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
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

/** Select `selector`'s text as a finger leaves it (a touch press, the selection, the release); the selection's text. */
const touchSelect = (page: Page, selector: string): Promise<string> =>
  page.evaluate(async (sel: string) => {
    const el = document.querySelector(sel);
    const range = document.createRange();

    if (el) range.selectNodeContents(el);
    const opts = { bubbles: true, pointerType: "touch", button: 0, isPrimary: true };
    el?.dispatchEvent(new PointerEvent("pointerdown", opts));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    el?.dispatchEvent(new PointerEvent("pointerup", opts));
    await new Promise((r) => setTimeout(r, 400));

    return String(getSelection());
  }, selector);

/** The bar's box, the visual viewport's, and the tops of the page's bars at the bottom (the tab bar, the composer). */
const docked = (page: Page): Promise<{ hidden: boolean; bar: { top: number; bottom: number; left: number; right: number }; vv: { top: number; bottom: number; left: number; right: number }; floor: number }> =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("#seltool");
    const b = el?.getBoundingClientRect() ?? new DOMRect();
    const vv = visualViewport;

    const floors = [...document.querySelectorAll(".tabs, .chat .composer")].flatMap((x) => {
      const r = x.getBoundingClientRect();

      return r.height > 0 && r.top > innerHeight / 2 ? [r.top] : [];
    });

    return {
      hidden: el?.hidden !== false,
      bar: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
      vv: vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height, left: vv.offsetLeft, right: vv.offsetLeft + vv.width } : { top: 0, bottom: innerHeight, left: 0, right: innerWidth },
      floor: Math.min(innerHeight, ...floors),
    };
  });

test.skipIf(!found)("on a phone the bar docks at the bottom of the screen, centred, over the tab bar, off the selection; Copy works and a scroll keeps it", async () => {
  const page = await open(390, "#decision/a8");
  const text = await touchSelect(page, "#dv-answer .manual-rich > p");
  const got = await docked(page);

  expect(got.hidden).toBe(false);
  expect(got.floor).toBeLessThan(844);
  expect(got.bar.bottom).toBeCloseTo(got.floor - 8, 0);
  expect((got.bar.left + got.bar.right) / 2).toBeCloseTo(195, 0);
  expect(await covers(page)).toBe(false);
  expect(await page.evaluate(() => [...document.querySelectorAll("#seltool button")].map((b) => b.textContent))).toEqual(["Copy", "Reply", "Side chat"]);

  await page.tap('#seltool [data-sel="copy"]');
  await page.waitForFunction(() => document.querySelector('#seltool [data-sel="copy"]')?.textContent === "Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

  /* A scroll, as the phone makes one while the handles move: docked, the bar stays where it was. */
  await page.evaluate(async () => {
    document.body.style.paddingBottom = "2000px";
    window.scrollBy(0, 40);
    await new Promise((r) => setTimeout(r, 100));
  });
  const after = await docked(page);
  expect(after.hidden).toBe(false);
  expect(after.bar.bottom).toBeCloseTo(got.bar.bottom, 0);
  await page.close();
});

test.skipIf(!found)("on a phone, a selection down by the tab bar puts the bar at the top of the screen", async () => {
  const page = await open(390, "#decision/a8");
  await page.evaluate(() => {
    const p = document.querySelector<HTMLElement>("#dv-answer .manual-rich > p");
    const r = p?.getBoundingClientRect();

    /* The paragraph moved down to end 30 px over the tab bar. */
    if (p && r) p.style.marginTop = String(innerHeight - 62 - 30 - r.bottom) + "px";
  });
  await touchSelect(page, "#dv-answer .manual-rich > p");
  const got = await docked(page);

  expect(got.hidden).toBe(false);
  expect(got.bar.top).toBeCloseTo(8, 0);
  expect(await covers(page)).toBe(false);
  await page.close();
});

test.skipIf(!found)("on a phone pinch-zoomed, the bar docks inside what is on screen, at the screen's scale", async () => {
  const page = await open(390, "#decision/a8");
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await page.waitForFunction(() => visualViewport?.scale === 2);
  await touchSelect(page, "#dv-answer .manual-rich > p");
  const got = await docked(page);

  expect(got.hidden).toBe(false);
  expect(got.bar.top).toBeGreaterThanOrEqual(got.vv.top);
  expect(got.bar.bottom).toBeLessThanOrEqual(got.vv.bottom);
  expect(got.bar.left).toBeGreaterThanOrEqual(got.vv.left);
  expect(got.bar.right).toBeLessThanOrEqual(got.vv.right);
  /* Drawn at half size: on screen, as tall as unzoomed. */
  expect(got.bar.bottom - got.bar.top).toBeLessThan(30);
  await page.close();
});

test.skipIf(!found)("on a phone with the chat open, text selected in a message docks the bar over the composer, not on it", async () => {
  const page = await open(390, "");
  await page.click("#chat-toggle");
  await page.waitForFunction(() => document.documentElement.classList.contains("chat-open"));
  await touchSelect(page, '#chat-log article[data-id="4"] .msg-text p');
  const got = await docked(page);
  const composer = await page.evaluate(() => document.querySelector(".chat .composer")?.getBoundingClientRect().top ?? 0);

  expect(got.hidden).toBe(false);
  expect(composer).toBeGreaterThan(400);
  expect(got.bar.bottom).toBeLessThanOrEqual(composer);
  expect(await covers(page)).toBe(false);
  await page.tap('#seltool [data-sel="reply"]');
  await page.waitForFunction(() => document.querySelector("#seltool")?.hasAttribute("hidden") && document.querySelector<HTMLElement>("#quote")?.hidden === false);
  await page.close();
});

for (const width of [1280, 390]) {
  test.skipIf(!found)(`at ${width} px, Reply on a decision's text, sent, leads back there from the chat: the label is a link that opens the decision and marks the text`, async () => {
    const page = await open(width, "#decision/a8");
    const phone = width < 500;

    /* Select the decision's why, as a mouse or a finger leaves it, and Reply. */
    await page.evaluate(async (touch: boolean) => {
      const p = [...document.querySelectorAll("#dv-info p")].find((el) => el.textContent?.includes("stale weights"));
      const range = document.createRange();

      if (p) range.selectNodeContents(p);
      const opts = { bubbles: true, pointerType: touch ? "touch" : "mouse", button: 0, isPrimary: true };
      p?.dispatchEvent(new PointerEvent("pointerdown", opts));
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      p?.dispatchEvent(new PointerEvent("pointerup", opts));
    }, phone);
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#seltool")?.hidden === false);
    await page.click('#seltool [data-sel="reply"]');
    await page.type("#say", "why now?");
    await page.click("#send");
    const sent = await page.waitForFunction(() => document.querySelector('#chat-log .msg-quote a.from[href="#decision/a8"]')?.closest("article")?.getAttribute("data-id"));
    const id = String(await sent.jsonValue());
    expect(harness.posted.at(-1)?.quote?.at).toEqual({ hash: "#decision/a8", anchor: "dv-info" });

    /* Elsewhere on the page, the chat open, a click on the label goes back. */
    await page.evaluate(() => {
      location.hash = "#plan";
    });
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("#decision")?.offsetParent);

    if (phone) {
      await page.click("#chat-toggle");
      await page.waitForFunction(() => document.documentElement.classList.contains("chat-open"));
    }

    const link = `#chat-log article[data-id="${id}"] .msg-quote a.from`;
    const label = await page.evaluate((sel: string) => document.querySelector(sel)?.getBoundingClientRect().height ?? 0, link);
    expect(label).toBeGreaterThanOrEqual(phone ? 43.5 : 18);
    await page.click(link);
    await page.waitForFunction(() => location.hash === "#decision/a8" && document.querySelector("#dv-info .found") !== null);

    const landed = await page.evaluate(() => {
      const el = document.querySelector("#dv-info .found");
      const r = el?.getBoundingClientRect();

      return { text: el?.textContent ?? "", inView: r ? r.top >= 0 && r.bottom <= innerHeight : false, chatOpen: document.documentElement.classList.contains("chat-open") };
    });

    expect(landed.text).toContain("stale weights");
    expect(landed.inView).toBe(true);
    expect(landed.chatOpen).toBe(false);
    await page.close();
  });
}
