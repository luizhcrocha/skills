/**
 * The manager's queue on a fleet's decision in a real browser (the built template in headless Chromium, fed
 * by the harness): once the decision shown has left the queue (a state with no decisions, as a poll of the
 * ledger gives while the stream reconnects) and come back, every state event after that leaves the
 * viewer's scroll where it was. Skipped when no Chromium is found (FLEET_CHROMIUM, or
 * chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser } from "puppeteer-core";

import { coordinatorChat, coordinatorView, managerChat, managerView, type View } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

let browser: Browser;

let harness: Harness;

let fleet: Harness;

/** The hub: the manager's page at /f/manager/, billing's (the frame on a decision of billing) beside it. */
let hub: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!found) return;
  const template = readFileSync(TEMPLATE, "utf8");
  harness = serveHarness({ template, view: managerView(NOW), messages: managerChat(NOW) });
  fleet = serveHarness({ template, view: coordinatorView(NOW), messages: coordinatorChat(NOW) });
  hub = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      const to = new URL(url.pathname.startsWith("/f/manager/") ? harness.url : fleet.url).origin;

      return fetch(to + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.body });
    },
  });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  void hub.stop(true);
  harness.stop();
  fleet.stop();
});

/** The manager's view as of `tick` seconds on: a live update that changes nothing in the queue. */
const tick = (n: number): View => ({ ...managerView(NOW), updated: new Date(NOW + n * 1000).toISOString() });

/** The manager's view with no decision anywhere, as the ledger alone has it. */
function bare(): View {
  const view = managerView(NOW);
  const fleets = Array.isArray(view["coordinators"]) ? view["coordinators"].filter((c): c is View => c !== null && Object(c) === c && !Array.isArray(c)) : [];

  return { ...view, decisions: [], coordinators: fleets.map((c) => ({ ...c, decisions: [] })) };
}

test.skipIf(!found)("a decision that left the queue and came back keeps the viewer's scroll through later state events", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 600 });
  await page.goto(`http://127.0.0.1:${String(hub.port)}/f/manager/#decision/billing/d1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live" && document.querySelector('#dv-queue a[data-queue="next"]') !== null);

  harness.setView(bare());
  await page.waitForFunction(() => document.querySelector('#dv-queue a[data-queue="next"]') === null);
  harness.setView(tick(1));
  await page.waitForFunction(() => document.querySelector('#dv-queue a[data-queue="next"]') !== null && document.documentElement.scrollHeight > innerHeight + 300);

  for (let n = 2; n <= 4; n += 1) {
    await page.evaluate(() => window.scrollTo(0, 300));
    const before = await page.evaluate(() => scrollY);
    harness.setView(tick(n));
    await new Promise((r) => setTimeout(r, 400));

    expect(before).toBe(300);
    expect(await page.evaluate(() => scrollY)).toBe(300);
  }

  await page.close();
});
