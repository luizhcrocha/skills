/**
 * An evidence table on a phone, in headless Chromium: a table whose cells carry sentences becomes one card per
 * row, each value under its column's name, whether its header row sits in a <thead> or is a plain first row of
 * <th> cells (agent-tools' D28 wrote it that way and kept its sideways scroll). A table of short values stays a
 * table. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import puppeteer, { type Browser } from "puppeteer-core";

import { frameDoc } from "../src/DecisionPage.tsx";

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const SENTENCE = "Today the model, its allowed operations, its prompt and its output shape live in four places.";

const BODY = `<table id="plain"><tr><th>Idea</th><th>What it means here</th></tr><tr><td>One record</td><td>${SENTENCE}</td></tr></table>
<table id="thead"><thead><tr><th>Idea</th><th>What it means here</th></tr></thead><tbody><tr><td>One record</td><td>${SENTENCE}</td></tr></tbody></table>
<table id="short"><tr><th>Setup</th><th>Run 1</th></tr><tr><td>One agent</td><td>14</td></tr></table>`;

let browser: Browser;

beforeAll(async () => {
  if (found) browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
});

test.skipIf(!found)("a table of sentences becomes cards on a phone, with or without a thead", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setContent(frameDoc(BODY));

  const read = (id: string) =>
    page.evaluate((id) => {
      const t = document.querySelector<HTMLTableElement>(`#${id}`)!;
      const head = t.rows[0]!;
      const cell = t.rows[1]!.cells[1]!;

      return {
        cards: t.classList.contains("cards"),
        headShown: head.getClientRects().length > 0,
        label: cell.getAttribute("data-label"),
        scrolls: t.scrollWidth > t.clientWidth,
      };
    }, id);

  expect(await read("plain")).toEqual({ cards: true, headShown: false, label: "What it means here", scrolls: false });
  expect(await read("thead")).toEqual({ cards: true, headShown: false, label: "What it means here", scrolls: false });
  expect((await read("short")).cards).toBe(false);
  await page.close();
});
