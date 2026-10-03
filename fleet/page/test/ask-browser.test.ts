/**
 * "Ask in the chat" in a real browser (the built template in headless Chromium, fed by the harness): on a
 * decision's page, Side chat docks the composer beside it at 1280 px with the item quoted and linked, lists
 * people after "@", and sends a new side chat about the item; on a phone, Ask in the chat opens the chat's
 * overlay with the item quoted. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { chatConversation, chatView } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

let browser: Browser;

let harness: Harness;

beforeAll(async () => {
  if (!found) return;
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: chatView(NOW), messages: chatConversation(NOW) });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

/** D1's page at `width`, a phone's below 500 px, its stream replayed. */
async function open(width: number): Promise<Page> {
  const page = await browser.newPage();
  const phone = width < 500;
  await page.setViewport({ width, height: phone ? 844 : 900, isMobile: phone, hasTouch: phone });
  await page.goto(harness.url + "#decision/d1", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live" && document.querySelector('#chat-log article[data-id="13"]') !== null);

  return page;
}

const chip = (page: Page): Promise<{ shown: boolean; text: string; link: string; linkText: string }> =>
  page.evaluate(() => {
    const q = document.querySelector<HTMLElement>("#quote");
    const a = q?.querySelector<HTMLAnchorElement>("a.quote-from");

    return { shown: Boolean(q && q.getClientRects().length), text: q?.textContent ?? "", link: a?.getAttribute("href") ?? "", linkText: a?.textContent ?? "" };
  });

test.skipIf(!found)("at 1280 px, Side chat on a decision docks the composer with the item quoted, lists @ people, and sends a side chat about it", async () => {
  const page = await open(1280);
  await page.click("#dv-answer [data-discuss-side]");
  const c = await chip(page);

  expect(c.shown).toBe(true);
  expect(c.text).toStartWith("Side chat on D1 Rounding rule for totals: How should invoice totals round");
  expect([c.link, c.linkText]).toEqual(["#decision/d1", "D1 Rounding rule for totals"]);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("say");

  await page.keyboard.type("@inv");
  await page.waitForFunction(() => !document.querySelector<HTMLElement>("#mentions")?.hidden);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const say = document.querySelector<HTMLTextAreaElement>("#say");

    if (say) say.value = "";
  });
  await page.keyboard.type("is per line ever right?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector<HTMLElement>("#side-head")?.hidden);

  expect(harness.posted.at(-1)).toMatchObject({
    text: "is per line ever right?",
    quote: { text: "How should invoice totals round: per line or on the total?", from: "D1 Rounding rule for totals", at: { hash: "#decision/d1", anchor: "dv-info" } },
  });
  expect(harness.posted.at(-1)?.side).toBe(harness.posted.at(-1)?.id);
  expect(harness.posted.at(-1)?.decision).toBeUndefined();
  await page.close();
});

test.skipIf(!found)("on a phone, Ask in the chat opens the chat's overlay with the item quoted", async () => {
  const page = await open(390);
  await page.click("#dv-answer [data-discuss]");
  await page.waitForSelector("#chat.open");
  const c = await chip(page);

  expect(c.shown).toBe(true);
  expect(c.text).toStartWith("Quoting D1 Rounding rule for totals:");
  await page.close();
});
