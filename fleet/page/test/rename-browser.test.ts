/**
 * Renaming in place, in a real browser (the built template in headless Chromium, fed by the harness's event
 * stream): the fleet's name in the header and a worker's in its sheet turn into a field on the pencil; Enter
 * posts the name to the hub, which the next state shows; a refusal stays under the field; Escape leaves the
 * name as it was and the sheet open. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { coordinatorChat, coordinatorView } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

let browser: Browser;

let harness: Harness;

let page: Page;

beforeAll(async () => {
  if (!found) return;
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: { ...coordinatorView(NOW), named: { id: "billing", session: "Billing" } }, messages: coordinatorChat(NOW) });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(harness.url + "#fleet", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

/** The text of the element `selector` names, or null. */
function textOf(selector: string): Promise<string | null> {
  return page.evaluate((s: string) => document.querySelector(s)?.textContent ?? null, selector);
}

test.skipIf(!found)("the fleet's name turns into a field, and Enter names the fleet", async () => {
  expect(await textOf("#top-fleet")).toBe("Billing");
  await page.click("#top-fleet-rename");
  await page.waitForFunction(() => document.activeElement?.id === "top-fleet-field");
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>("#top-fleet-field")?.value)).toBe("Billing");
  await page.keyboard.type("Invoices");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#top-fleet")?.textContent === "Invoices");
  expect(harness.renames.at(-1)).toEqual({ name: "Invoices" });
  expect(await page.evaluate(() => document.querySelector("#top-fleet-field"))).toBeNull();
});

test.skipIf(!found)("a worker's name in its sheet turns into a field: a refusal stays, Escape keeps the name and the sheet, Enter renames", async () => {
  await page.click("#agent-a2 .who");
  await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("#worker")?.open === true);
  expect(await textOf("#worker-name")).toBe("invoice-gen");

  await page.click("#worker-rename");
  await page.waitForFunction(() => document.activeElement?.id === "worker-field");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#worker-name")?.textContent === "invoice-gen");
  expect(await page.evaluate(() => document.querySelector<HTMLDialogElement>("#worker")?.open)).toBe(true);

  await page.click("#worker-rename");
  await page.waitForFunction(() => document.activeElement?.id === "worker-field");
  const other = await page.evaluate(() => document.querySelector("#agent-a1 .who")?.textContent ?? "");
  await page.keyboard.type(other);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#worker-why")?.textContent?.includes("a mention could not tell them apart") === true);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("worker-field");

  await page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>("#worker-field");

    if (field) field.value = "";
  });
  await page.keyboard.type("Invoice writer");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#worker-name")?.textContent === "Invoice writer");
  expect(harness.renames.at(-1)).toEqual({ agent: "a2", name: "Invoice writer" });
  expect(await textOf("#agent-a2 .who")).toBe("Invoice writer");
});
