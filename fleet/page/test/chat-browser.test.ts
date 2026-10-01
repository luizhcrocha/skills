/**
 * The chat in a real browser (the built template in headless Chromium, fed by the harness's event stream),
 * on a day and a half of conversation: where the bubbles sit at 390 and 1280 px, the size of every control
 * a finger taps on a phone, decision activity (left out, a marker when shown, the decision page's thread),
 * and a `chat` event appended in place with the chat's scroll and the draft as they were. Skipped when no
 * Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { chatConversation, chatView } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

declare global {
  /** What the tests leave on the page's window, to compare after an update. */
  interface Window {
    firstRow: Element | null;
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
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: chatView(NOW), messages: chatConversation(NOW) });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

/** A page at `width`, a phone's below 500 px, with the chat in view and its stream replayed. */
async function open(width: number): Promise<Page> {
  const page = await browser.newPage();
  const phone = width < 500;
  await page.setViewport({ width, height: phone ? 844 : 900, isMobile: phone, hasTouch: phone });
  await page.evaluateOnNewDocument((t: number) => {
    Date.now = () => t;
  }, NOW);
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live" && document.querySelector('#chat-log article[data-id="13"]') !== null);

  /* Decision activity starts left out, whatever an earlier test chose. */
  if (await page.$('#chat-decisions[aria-checked="true"]')) await page.click("#chat-decisions");

  if (phone) await page.click("#chat-toggle");

  return page;
}

/** Each bubble in the chat: whose, and where it sits against the log's inner box. */
async function bubbles(page: Page): Promise<{ id: string; mine: boolean; left: number; right: number; share: number }[]> {
  return page.evaluate(() => {
    const log = document.querySelector<HTMLElement>("#chat-log");

    if (!log) return [];
    const box = log.getBoundingClientRect();
    const cs = getComputedStyle(log);
    const left = box.left + parseFloat(cs.paddingLeft);
    const right = box.right - parseFloat(cs.paddingRight) - (log.offsetWidth - log.clientWidth);
    const inner = right - left;

    return [...log.querySelectorAll<HTMLElement>("article.msg")].map((a) => {
      const r = a.getBoundingClientRect();

      return { id: a.dataset["id"] ?? "", mine: a.closest(".turn")?.classList.contains("from-user") ?? false, left: r.left - left, right: right - r.right, share: r.width / inner };
    });
  });
}

for (const width of [390, 1280]) {
  test.skipIf(!found)(`at ${width} px the viewer's messages sit on the right and the fleet's on the left, none wider than 80%`, async () => {
    const page = await open(width);
    const all = await bubbles(page);

    expect(all.map((b) => b.id)).toEqual(["1", "2", "3", "4", "5", "10", "11", "12", "13"]);

    for (const b of all) {
      expect(b.share).toBeLessThanOrEqual(0.8 + 0.005);

      if (b.mine) expect(b.right).toBeLessThan(1);
      else expect(b.left).toBeLessThan(1);
    }

    await page.close();
  });
}

test.skipIf(!found)("on a phone every control in the chat is at least 44 px each way", async () => {
  const page = await open(390);
  await page.click("#chat-decisions");
  await page.waitForSelector("#chat-log .dmark");

  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#chat .reply-btn, #chat .re-line, #chat-decisions, #chat .side-link button, #chat .dmark a, #chat .turn-head .who, #chat-close, #send")].flatMap((el) => {
      const r = el.getBoundingClientRect();

      return getComputedStyle(el).visibility === "hidden" || r.width === 0 || (r.width >= 43.5 && r.height >= 43.5) ? [] : [`${el.className || el.id} ${Math.round(r.width)}x${Math.round(r.height)}`];
    }),
  );

  expect(small).toEqual([]);
  await page.click("#chat-decisions");
  await page.close();
});

test.skipIf(!found)("decision activity: left out of the chat, a marker when shown, a thread on the decision's page", async () => {
  const page = await open(1280);
  const ids = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#chat-log [data-id]")].map((el) => el.dataset["id"] ?? ""));

  expect(await ids()).not.toContain("8");
  await page.click("#chat-decisions");
  await page.waitForSelector('#chat-log .dmark[data-id="8"]');
  expect(await page.evaluate(() => document.querySelector('#chat-log .dmark[data-id="9"] .dmark-line')?.textContent?.startsWith("coordinator on D18: Recorded"))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("fleet:/f/billing/chat-decisions"))).toBe("true");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('#chat-log .dmark[data-id="8"]');
  await page.click("#chat-decisions");
  await page.waitForFunction(() => document.querySelector('#chat-log [data-id="8"]') === null);

  await page.evaluate(() => {
    location.hash = "#decision/d18";
  });
  await page.waitForSelector("#dv-thread");
  const sides = await page.evaluate(() => [...document.querySelectorAll("#dv-thread li.turn")].map((li) => (li.classList.contains("from-user") ? "me" : "fleet")));
  expect(sides).toEqual(["me", "fleet"]);
  await page.close();
});

test.skipIf(!found)("a chat event is appended in place: the rows keep their nodes, the chat its scroll, the composer its draft", async () => {
  const page = await open(1280);
  await page.focus("#say");
  await page.keyboard.type("a draft in flight");
  await page.evaluate(() => {
    const log = document.querySelector("#chat-log");
    window.firstRow = log?.firstElementChild ?? null;

    if (log) log.scrollTop = 0;
  });

  harness.say({ id: 14, at: new Date(NOW).toISOString(), from: "a3", to: ["user"], text: "Found the key." });
  await page.waitForSelector('#chat-log article[data-id="14"]');

  const after = await page.evaluate(() => ({
    same: window.firstRow === document.querySelector("#chat-log")?.firstElementChild,
    top: document.querySelector("#chat-log")?.scrollTop,
    last: document.querySelector("#chat-log")?.lastElementChild?.querySelector("article")?.getAttribute("data-id"),
    draft: document.querySelector<HTMLTextAreaElement>("#say")?.value,
    focused: document.activeElement?.id,
  }));

  expect(after).toEqual({ same: true, top: 0, last: "14", draft: "a draft in flight", focused: "say" });

  /* At its end, the chat stays at its end. */
  await page.evaluate(() => {
    const log = document.querySelector("#chat-log");

    if (log) log.scrollTop = log.scrollHeight;
  });
  harness.say({ id: 15, at: new Date(NOW).toISOString(), from: "a3", to: ["user"], text: "Adapter unblocked." });
  await page.waitForSelector('#chat-log article[data-id="15"]');
  expect(await page.evaluate(() => {
    const log = document.querySelector("#chat-log");

    return log ? log.scrollHeight - log.scrollTop - log.clientHeight < 2 : false;
  })).toBe(true);
  await page.close();
});
