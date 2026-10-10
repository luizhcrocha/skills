/**
 * The Links view at a phone's width, in a real browser (the built template in headless Chromium, fed by the
 * harness): at 390 px, under Active and under All with the inactive group opened, nothing scrolls sideways
 * and every row, its badge and its status line stay inside the page's column. Skipped when no Chromium is
 * found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { linksView, managerChat } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

let browser: Browser;

let harness: Harness;

beforeAll(async () => {
  if (!found) return;
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: linksView(NOW), messages: managerChat(NOW) });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

/** What leaves the column at this width: a sideways scroll, a row or a part of one past the viewport. */
function outside(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const width = document.documentElement.clientWidth;

    if (document.documentElement.scrollWidth > width) out.push(`the page scrolls sideways (${String(document.documentElement.scrollWidth)} > ${String(width)})`);

    for (const e of document.querySelectorAll("#links-view .link-row, #links-view .kind-badge, #links-view .link-status, #link-filters")) {
      const r = e.getBoundingClientRect();

      if (r.width > 0 && (r.left < -0.5 || r.right > width + 0.5)) out.push(`${e.className} ${e.getAttribute("data-link") ?? ""} spans ${String(r.left)}..${String(r.right)}`);
    }

    return out;
  });
}

test.skipIf(!found)("at a phone's width the Links view stays in its column, under Active and under All", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(harness.url + "#links", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#links-view .link-row");
  expect(await page.$$eval("#links-view .link-row", (rows) => rows.length)).toBe(7);
  expect(await outside(page)).toEqual([]);
  await page.click('[data-showing="all"]');
  await page.click("#links-inactive > summary");
  await new Promise((r) => setTimeout(r, 100));
  expect(await page.$$eval("#links-view .link-row", (rows) => rows.filter((r) => r.getBoundingClientRect().height > 0).length)).toBe(11);
  expect(await outside(page)).toEqual([]);
  await page.close();
});
