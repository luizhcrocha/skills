/**
 * The finder in a real browser (headless Chromium), at 1280 and at a phone's 390 in the dark scheme: Ctrl+K
 * opens it with the places opened last on top; real keys narrow it ("d:" selects a tab, Tab cycles) with the
 * focus kept in the field; nothing scrolls sideways but the row of tabs; on a phone it fills the screen with a
 * close button and no key legend. FLEET_SHOTS=DIR keeps a screenshot of each. Skipped when no Chromium is
 * found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { coordinatorChat, coordinatorView } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const SHOTS = process.env["FLEET_SHOTS"] ?? "";

const NOW = Date.parse("2026-10-01T12:00:00Z");

let browser: Browser;

let harness: Harness;

beforeAll(async () => {
  if (!found) return;
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: coordinatorView(NOW), messages: coordinatorChat(NOW) });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });

  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

/** A page at `width`, in `scheme`, that opened D1's page and the plan, then the finder. */
async function opened(width: number, scheme: "light" | "dark"): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 860 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");
  await page.evaluate(() => localStorage.clear());

  for (const hash of ["#decision/d1", "#log", "#plan"]) {
    await page.evaluate((h) => (location.hash = h), hash);
    await page.waitForFunction((h) => location.hash === h, {}, hash);
  }

  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("#finder")?.open === true);

  return page;
}

/** A screenshot once the sheet has finished rising, when FLEET_SHOTS asks for them. */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === "finished"));
  await page.screenshot({ path: join(SHOTS, name) });
}

/** What the finder shows, as the eye reads it. */
function look(page: Page): Promise<{ heads: string[]; tab: string; focus: boolean; sideways: boolean; tabsScroll: boolean; legend: boolean; close: boolean; full: boolean }> {
  return page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>("#finder");
    const shown = (el: Element | null): boolean => !!el && el.getClientRects().length > 0;
    const box = dialog?.getBoundingClientRect();
    const tabs = document.querySelector<HTMLElement>("#find-tabs");

    return {
      heads: [...document.querySelectorAll("#find-list .find-group")].map((h) => h.textContent ?? ""),
      tab: document.querySelector('#find-tabs [aria-selected="true"]')?.textContent ?? "",
      focus: document.activeElement?.id === "find-q",
      sideways: [...(dialog?.querySelectorAll<HTMLElement>(".finder-in, .find-list") ?? [])].some((el) => el.scrollWidth > el.clientWidth + 1) || document.documentElement.scrollWidth > innerWidth,
      tabsScroll: !!tabs && getComputedStyle(tabs).overflowX === "auto",
      legend: shown(document.querySelector(".find-foot")),
      close: shown(document.querySelector(".find-x")),
      full: !!box && Math.round(box.width) === innerWidth && Math.round(box.height) === innerHeight,
    };
  });
}

for (const [width, scheme] of [
  [1280, "light"],
  [1280, "dark"],
  [390, "dark"],
] as const) {
  test.skipIf(!found)(`at ${String(width)}, ${scheme}: the recents first, keys that narrow it, nothing sideways`, async () => {
    const page = await opened(width, scheme);
    const phone = width < 760;

    expect(await look(page)).toMatchObject({ heads: ["Recent", "Narrow to"], tab: "All", focus: true, sideways: false, tabsScroll: true, legend: !phone, close: phone, full: phone });

    await shot(page, `finder-${String(width)}-${scheme}-empty.png`);
    await page.keyboard.type("d:");
    expect(await look(page)).toMatchObject({ heads: ["Decisions"], tab: "Decisions", focus: true });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    expect(await look(page)).toMatchObject({ tab: "Roadblocks", focus: true });
    await page.keyboard.press("Escape");
    await page.keyboard.type("in");
    expect(await look(page)).toMatchObject({ tab: "All", focus: true, sideways: false });

    await shot(page, `finder-${String(width)}-${scheme}-query.png`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("#finder")?.open === false);
    await page.close();
  });
}
