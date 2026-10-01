/**
 * The built template in a real browser (headless Chromium over CDP), fed by a real event stream: a
 * `state` event that changes one worker leaves a marked row node, the window's scroll, the chat's
 * scroll, an open sheet, the switcher and a typed draft as they were, and a `chat` event appends one
 * message. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { agentsOf, coordinatorChat, coordinatorView, type View } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

declare global {
  /** What the tests leave on the page's window, to compare after an update. */
  interface Window {
    kept: Element | null;
    sel: HTMLSelectElement | null;
    first: Element | null;
  }
}

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

let browser: Browser;

let harness: Harness;

let page: Page;

beforeAll(async () => {
  if (!found) return;
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: coordinatorView(NOW), messages: coordinatorChat(NOW) });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 700 });
  await page.goto(harness.url + "#fleet", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live" && document.querySelectorAll("#chat-log article.msg").length === 5);
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

/** The view with worker `id` changed by `change`. */
function changed(id: string, change: (a: View) => View): View {
  const view = coordinatorView(NOW);

  return { ...view, agents: agentsOf(view).map((a) => (a["id"] === id ? change(a) : a)) };
}

test.skipIf(!found)("a state event over the stream updates one row in place and keeps the viewer's place", async () => {
  await page.evaluate(() => {
    window.kept = document.querySelector("#agent-a1");
    document.querySelector("#agent-a1")?.setAttribute("data-marked", "yes");
    window.sel = document.querySelector("#switch select");
    window.scrollTo(0, 300);
    const log = document.querySelector("#chat-log");

    if (log) log.scrollTop = 0;
    const say = document.querySelector<HTMLTextAreaElement>("#say");
    say?.focus();
  });
  await page.keyboard.type("a draft in flight");
  const before = await page.evaluate(() => ({ y: window.scrollY, sel: document.querySelector<HTMLSelectElement>("#switch select")?.value }));

  harness.setView(changed("a2", (a) => ({ ...a, tokens: 777_000 })));
  await page.waitForFunction(() => document.querySelector("#agent-a2 .c-tokens")?.textContent === "777,000");

  const after = await page.evaluate(() => {
    return {
      same: window.kept === document.querySelector("#agent-a1"),
      marked: document.querySelector("#agent-a1")?.getAttribute("data-marked"),
      y: window.scrollY,
      chatTop: document.querySelector("#chat-log")?.scrollTop,
      sel: document.querySelector<HTMLSelectElement>("#switch select")?.value,
      sameSelect: window.sel === document.querySelector("#switch select"),
      draft: document.querySelector<HTMLTextAreaElement>("#say")?.value,
      focused: document.activeElement?.id,
    };
  });

  expect(after).toEqual({ same: true, marked: "yes", y: before.y, chatTop: 0, sel: before.sel, sameSelect: true, draft: "a draft in flight", focused: "say" });
});

test.skipIf(!found)("an open worker sheet stays open through a state event", async () => {
  await page.click("#agent-a3 .who");
  await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("#worker")?.open === true);
  harness.setView(changed("a3", (a) => ({ ...a, status: "running" })));
  await page.waitForFunction(() => document.querySelector("#worker .sheet-head .pill")?.textContent === "running");
  expect(await page.evaluate(() => document.querySelector<HTMLDialogElement>("#worker")?.open)).toBe(true);
  await page.keyboard.press("Escape");
});

test.skipIf(!found)("a chat event appends one message and leaves the others' nodes", async () => {
  await page.evaluate(() => {
    window.first = document.querySelector("#chat-log article.msg");
  });
  harness.say({ id: 6, at: new Date(NOW).toISOString(), from: "a3", to: ["user"], text: "Found the key." });
  await page.waitForFunction(() => document.querySelectorAll("#chat-log article.msg").length === 6);
  expect(await page.evaluate(() => window.first === document.querySelector("#chat-log article.msg"))).toBe(true);
});
