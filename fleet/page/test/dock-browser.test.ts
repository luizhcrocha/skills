/**
 * The chat beside the manager's page in a real browser (the built template in headless Chromium, fed by
 * the harness's event stream): at 960 and 1024 px it docks, and on the Overview, the Fleet, the manager's
 * decision and a fleet's decision framed there nothing of the page leaves its column, nothing scrolls
 * sideways, and the chat covers none of it; at 800 px it is a sheet over the page, behind a scrim a click
 * closes. A coordinator's page at 920 px, the narrowest docked width, keeps its tabs in its column. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { coordinatorChat, coordinatorView, managerChat, managerView } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

let browser: Browser;

let harness: Harness;

let fleet: Harness;

beforeAll(async () => {
  if (!found) return;
  const template = readFileSync(TEMPLATE, "utf8");
  harness = serveHarness({ template, view: managerView(NOW), messages: managerChat(NOW) });
  fleet = serveHarness({ template, view: coordinatorView(NOW), messages: coordinatorChat(NOW) });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
  fleet.stop();
});

/** The manager's page (or `on`'s) at `width`, its stream replayed. */
async function open(width: number, on: Harness = harness, said = 2): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }]);
  await page.evaluateOnNewDocument((t: number) => {
    Date.now = () => t;
  }, NOW);
  await page.goto(on.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((n: number) => document.querySelector("#conn")?.textContent === "Live" && document.querySelectorAll("#chat-log article.msg").length === n, {}, said);

  return page;
}

/** What breaks the layout on the view at `hash`: elements past the page's column, sideways scrollers, the chat over the page. */
async function breaks(page: Page, hash: string): Promise<string[]> {
  await page.evaluate((h: string) => {
    location.hash = h;
  }, hash);
  await new Promise((r) => setTimeout(r, 250));

  return page.evaluate(() => {
    const out: string[] = [];
    const main = document.querySelector("#main")?.getBoundingClientRect();
    const chat = document.querySelector("#chat")?.getBoundingClientRect();

    if (!main || !chat) return ["no #main or #chat"];
    const name = (e: Element): string => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + [...e.classList].map((c) => "." + c).join("");

    if (chat.width === 0) out.push("the chat is not shown");

    if (chat.left < main.right - 0.5) out.push(`the chat (from ${String(chat.left)}) covers the page (to ${String(main.right)})`);

    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push(`the page scrolls sideways (${String(document.documentElement.scrollWidth)} > ${String(document.documentElement.clientWidth)})`);

    for (const e of document.querySelectorAll("#main *")) {
      const r = e.getBoundingClientRect();

      if (r.width === 0 || r.height === 0 || e.closest("[hidden]")) continue;

      if (r.right > main.right + 0.5 || r.left < main.left - 0.5) out.push(`${name(e)} spans ${String(Math.round(r.left))}..${String(Math.round(r.right))} outside ${String(Math.round(main.left))}..${String(Math.round(main.right))}`);
      const ox = getComputedStyle(e).overflowX;

      if ((ox === "auto" || ox === "scroll") && e.scrollWidth > e.clientWidth + 1) out.push(`${name(e)} scrolls sideways (${String(e.scrollWidth)} > ${String(e.clientWidth)})`);
    }

    return out;
  });
}

const VIEWS = ["", "#fleet", "#decision/d9", "#decision/billing/d1"];

for (const width of [960, 1024]) {
  test.skipIf(!found)(`at ${String(width)} px the chat docks beside the manager's page, and no view overflows its column`, async () => {
    const page = await open(width);

    expect(await page.evaluate(() => document.querySelector("#chat")?.classList.contains("open") === false && !document.querySelector<HTMLElement>("#app")?.inert)).toBe(true);

    for (const hash of VIEWS) expect({ hash, breaks: await breaks(page, hash) }).toEqual({ hash, breaks: [] });
    await page.close();
  });
}

test.skipIf(!found)("at the narrowest docked width, 920 px, a coordinator's page keeps its six tabs in its column", async () => {
  const page = await open(920, fleet, 5);

  for (const hash of ["", "#plan", "#fleet", "#links", "#log", "#decision/d1"]) expect({ hash, breaks: await breaks(page, hash) }).toEqual({ hash, breaks: [] });
  await page.close();
});

test.skipIf(!found)("at 800 px the chat is a sheet over the page, behind a scrim a click closes", async () => {
  const page = await open(800);
  await page.click("#chat-toggle");
  await page.waitForFunction(() => document.querySelector("#chat")?.classList.contains("open") === true);

  const scrim = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("#chat-scrim");
    const r = el?.getBoundingClientRect();

    return el && r ? { left: r.left, width: r.width, height: r.height, bg: getComputedStyle(el).backgroundColor, top: document.elementFromPoint(100, 400) === el } : null;
  });

  expect(scrim).not.toBeNull();
  expect(scrim?.width).toBe(800);
  expect(scrim?.height).toBe(900);
  expect(scrim?.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(scrim?.top).toBe(true);

  await page.mouse.click(100, 400);
  await page.waitForFunction(() => document.querySelector("#chat")?.classList.contains("open") === false && !document.querySelector<HTMLElement>("#app")?.inert);
  await page.close();
});
