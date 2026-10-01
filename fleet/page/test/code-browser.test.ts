/**
 * Code blocks in a real browser (the built template in headless Chromium, fed by the harness's event
 * stream). A block scrolls inside itself on a phone and never widens the page; its copy button is a
 * finger's size and copies exactly its code; it keeps its node through a state event. Skipped when no
 * Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { agentsOf, codeChat, codeView } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

declare global {
  /** What the tests leave on the page's window. */
  interface Window {
    block: Element | null;
  }
}

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

const MODAL = "with-env {…} { modal volume delete -y cr-lab-hf-cache; modal volume list }";

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

test.skipIf(!found)("at 390 px a block scrolls inside itself and the page does not overflow; the copy button is 44 px", async () => {
  const page = await open(390, "#decision/a8");

  const got = await page.evaluate(() => {
    const pre = document.querySelector<HTMLElement>("#dv-answer figure.code pre");
    const copy = document.querySelector<HTMLElement>("#dv-answer .code-copy")?.getBoundingClientRect();

    return {
      page: document.documentElement.scrollWidth,
      inner: innerWidth,
      scrolls: pre ? pre.scrollWidth > pre.clientWidth : false,
      overflow: pre ? getComputedStyle(pre).overflowX : "",
      copy: copy ? [copy.width, copy.height] : [],
    };
  });

  expect(got.page).toBeLessThanOrEqual(got.inner);
  expect(got.scrolls).toBe(true);
  expect(got.overflow).toBe("auto");
  expect(Math.min(...got.copy)).toBeGreaterThanOrEqual(44);

  /* A block in a chat bubble scrolls inside the bubble, and the log does not widen. */
  await page.click("#chat-toggle");

  const chat = await page.evaluate(() => {
    const log = document.querySelector<HTMLElement>("#chat-log");
    const pre = document.querySelector<HTMLElement>('#chat-log article[data-id="6"] pre');

    return { log: log ? log.scrollWidth <= log.clientWidth : false, page: document.documentElement.scrollWidth, pre: pre ? pre.scrollWidth > pre.clientWidth : false };
  });

  expect(chat).toEqual({ log: true, page: 390, pre: true });
  await page.close();
});

test.skipIf(!found)("Copy puts exactly the block's code on the clipboard, says Copied for about 2 s, and each block has its own", async () => {
  const page = await open(1280, "#decision/a8");
  await page.click("#dv-answer .code-copy");
  await page.waitForFunction(() => document.querySelector("#dv-answer .code-copy")?.textContent === "Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MODAL);
  await page.waitForFunction(() => document.querySelector("#dv-answer .code-copy")?.textContent === "Copy", { timeout: 3000 });

  await page.click('#chat-log article[data-id="6"] .code-copy');
  await page.waitForFunction(() => document.querySelector('#chat-log article[data-id="6"] .code-copy')?.textContent === "Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("modal volume list | where name =~ hf | get name");
  await page.close();
});

test.skipIf(!found)("a block keeps its node and its wrap switch through a state event that does not change it", async () => {
  const page = await open(1280, "#decision/a8");
  await page.click("#dv-answer .code-wrap");
  await page.evaluate(() => {
    window.block = document.querySelector("#dv-answer figure.code");
  });
  const view = codeView(NOW);
  harness.setView({ ...view, agents: agentsOf(view).map((a) => (a["id"] === "a2" ? { ...a, tokens: 424_242 } : a)) });
  await page.waitForFunction(() => document.querySelector("#agent-a2 .c-tokens")?.textContent === "424,242");

  expect(await page.evaluate(() => ({ same: window.block === document.querySelector("#dv-answer figure.code"), wrap: document.querySelector("#dv-answer figure.code pre")?.classList.contains("wrap") }))).toEqual({ same: true, wrap: true });
  harness.setView(codeView(NOW));
  await page.close();
});
