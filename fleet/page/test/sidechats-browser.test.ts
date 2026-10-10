/**
 * The side chats in a real browser (the built template in headless Chromium, fed by the harness): Back to
 * the chat returns the main chat to where it was scrolled, not its top; a side chat opened again from the
 * list is where it was left; an archived side chat stays archived across a reload. Skipped when no Chromium
 * is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { chatView, sideChats, type Message } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

let browser: Browser;

let harness: Harness;

/** Thirty more exchanges in the side chat on D18, so it scrolls. */
function longSide(): Message[] {
  return Array.from({ length: 30 }, (_, i): Message => ({ id: 40 + i, at: new Date(NOW - (2 - i / 30) * 60_000).toISOString(), from: i % 2 ? "coordinator" : "user", to: [i % 2 ? "user" : "coordinator"], text: `Line ${i} of the long side chat.`, side: 22 }));
}

beforeAll(async () => {
  if (!found) return;
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: chatView(NOW), messages: [...sideChats(NOW), ...longSide()] });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

async function open(width: number): Promise<Page> {
  const page = await browser.newPage();
  const phone = width < 500;
  await page.setViewport({ width, height: phone ? 844 : 700, isMobile: phone, hasTouch: phone });
  await page.evaluateOnNewDocument((t: number) => {
    Date.now = () => t;
  }, NOW);
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live" && document.querySelector('#chat-log article[data-id="13"]') !== null);

  /* Opening the overlay focuses the composer, which on a phone brings the chat to its end a moment later (the keyboard's). */
  if (phone) {
    await page.click("#chat-toggle");
    await new Promise((r) => setTimeout(r, 400));
  }

  return page;
}

const scrollTop = (page: Page): Promise<number> => page.evaluate(() => document.querySelector("#chat-log")?.scrollTop ?? -1);

/** Scroll the chat to `top` as a reader would, the scroll event included. */
async function scrollTo(page: Page, top: number): Promise<number> {
  await page.evaluate((t: number) => {
    const log = document.querySelector("#chat-log");

    if (log) log.scrollTop = t;
  }, top);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  return scrollTop(page);
}

/** The chat log's scroll position once it has come to rest within 2 px of `top` (the page restores it a frame or
 * two after the click that switched chats), or where it stands after 3 s. */
async function settledAt(page: Page, top: number): Promise<number> {
  await page
    .waitForFunction((t: number) => Math.abs((document.querySelector("#chat-log")?.scrollTop ?? -1e9) - t) < 2, { timeout: 3000 }, top)
    .catch(() => undefined);

  return scrollTop(page);
}

for (const width of [1280, 390]) {
  test.skipIf(!found)(`at ${width} px, Back to the chat returns the main chat to where it was, and a side chat from the list to where it was left`, async () => {
    const page = await open(width);
    const main = await scrollTo(page, 150);
    expect(main).toBeGreaterThan(100);

    await page.click("#side-list-btn");
    await page.click('#sl-rows [data-side="22"] .sl-open');
    await page.waitForFunction(() => document.querySelector('#chat-log article[data-id="69"]') !== null);
    /* A side chat opened for the first time shows its end. */
    await page
      .waitForFunction(
        () => {
          const log = document.querySelector("#chat-log");

          return log !== null && log.scrollHeight - log.scrollTop - log.clientHeight < 2;
        },
        { timeout: 3000 },
      )
      .catch(() => undefined);
    expect(await page.evaluate(() => {
      const log = document.querySelector("#chat-log");

      return log ? log.scrollHeight - log.scrollTop - log.clientHeight : -1;
    })).toBeLessThan(2);
    const side = await scrollTo(page, 120);

    await page.click("#side-back");
    await page.waitForFunction(() => document.querySelector('#chat-log article[data-id="13"]') !== null);
    expect(Math.abs((await settledAt(page, main)) - main)).toBeLessThan(2);

    await page.click("#side-list-btn");
    await page.click('#sl-rows [data-side="22"] .sl-open');
    await page.waitForFunction(() => document.querySelector('#chat-log article[data-id="69"]') !== null);
    expect(Math.abs((await settledAt(page, side)) - side)).toBeLessThan(2);

    await page.click("#side-all");
    await page.click("#sl-back");
    expect(Math.abs((await settledAt(page, main)) - main)).toBeLessThan(2);
    await page.close();
  });
}

test.skipIf(!found)("an archived side chat stays archived across a reload, and comes back when unarchived", async () => {
  const page = await open(1280);
  const listed = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll("#sl-rows .sl-row")].map((li) => li.getAttribute("data-side") ?? ""));

  await page.click("#side-list-btn");
  expect(await listed()).toEqual(["22", "20", "6"]);
  await page.click('#sl-rows [data-side="20"] .sl-arch');
  expect(await listed()).toEqual(["22", "6"]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live" && document.querySelector('#chat-log article[data-id="13"]') !== null);
  await page.click("#side-list-btn");
  expect(await listed()).toEqual(["22", "6"]);
  await page.click("#sl-archived");
  expect(await listed()).toEqual(["20"]);
  await page.click('#sl-rows [data-side="20"] .sl-arch');
  await page.click("#sl-open");
  expect(await listed()).toEqual(["22", "20", "6"]);
  await page.close();
});
