/**
 * A decision's body under its Content-Security-Policy, in headless Chromium: in the dashboard's frame (the built
 * template, fed by the harness behind a stand-in hub that also serves a picture), the body's own `<script>`, its
 * inline handlers, its `javascript:` link and its frame do nothing, while the fleet's own script (sizing, tables,
 * marks) runs and a show-me SVG, a `data:` picture and the hub's picture render; a body that tries to take the
 * fleet's script by an unclosed tag runs nothing. The body as the hub serves it by itself is plain text under the
 * header: nothing in it renders, runs or navigates. A script in an isolated world, as an extension's content script runs (picasso), still reads
 * the frame. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";

import { servedBody } from "../src/body-policy.ts";
import { coordinatorChat } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";
import { D30_BODY, marksView } from "./marks-fixtures.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-10T12:00:00Z");

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

/** Everything a body may try, and the static things it may show. */
const HOSTILE = `
<script>window.ranScript = true; parent.postMessage({ fleetEvidence: true, height: 7 }, "*");</script>
<img id="broken" src="data:," onerror="window.ranHandler = true">
<button id="press" onclick="window.ranClick = true">Press</button>
<a id="jslink" href="javascript:window.ranLink = true" target="_self">A link</a>
<iframe id="inner" src="framed.html"></iframe>
<object id="obj" data="framed.html"></object>
<form id="form" action="sent.html" method="get" target="_self"><button id="send">Send</button></form>
<svg id="diagram" viewBox="0 0 120 40" width="120" height="40" onload="window.ranSvg = true"><rect x="1" y="1" width="50" height="38" fill="var(--accent-soft)" stroke="var(--line)"/><text x="8" y="24">store</text><path d="M52 20h40" stroke="var(--text)"/></svg>
<img id="data" src="data:image/png;base64,${PNG.toString("base64")}" alt="a data picture">
<img id="hubpic" src="pic.png" alt="the hub's picture">
<table><tr><th>Idea</th><th>What it means here</th></tr><tr><td>One record</td><td>Today the model, its allowed operations, its prompt and its output shape live in four places.</td></tr></table>`;

let browser: Browser;

let template = "";

const cleanups: (() => void)[] = [];

beforeAll(async () => {
  if (!found) return;
  template = readFileSync(TEMPLATE, "utf8");
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  for (const c of cleanups) c();

  if (found) await browser.close();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The stand-in hub: where it listens, and the paths it was asked for. */
interface Hub {
  readonly origin: string;
  readonly asked: string[];
  readonly harness: Harness;
}

/** A stand-in hub: perf's page and D30's body (`body`) from the harness, `decisions/pic.png`, the body by itself as the hub serves it (`servedBody`) at `decisions/raw.html`, and every path asked. */
function hubFor(body: string): Hub {
  const harness = serveHarness({ template, view: marksView(NOW), messages: coordinatorChat(NOW), bodies: { d30: body } });
  const asked: string[] = [];

  const hub = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      asked.push(url.pathname);

      if (url.pathname.endsWith("/decisions/pic.png")) return new Response(PNG, { headers: { "Content-Type": "image/png" } });

      if (url.pathname.endsWith("/decisions/raw.html")) return servedBody(body, "text/html;charset=utf-8", {});

      return fetch(new URL(harness.url).origin + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.body });
    },
  });

  cleanups.push(() => {
    void hub.stop(true);
    harness.stop();
  });

  return { origin: `http://127.0.0.1:${String(hub.port)}`, asked, harness };
}

/** The frame the decision's body is in, once its text is there. */
async function evFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 80; i += 1) {
    for (const f of page.frames()) {
      if (f === page.mainFrame() || f.detached) continue;
      const ok = await f.evaluate(() => document.body?.textContent?.includes("The idea") === true).catch(() => false);

      if (ok) return f;
    }

    await sleep(100);
  }

  throw new Error("no evidence frame");
}

/** perf's page on D30, its body `body`, and the frame. */
async function openD30(body: string): Promise<{ readonly page: Page; readonly frame: Frame; readonly asked: string[]; readonly origin: string }> {
  const { origin, asked } = hubFor(body);
  const context = await browser.createBrowserContext();
  cleanups.push(() => void context.close().catch(() => undefined));
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${origin}/f/perf/#decision/d30`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");
  const frame = await evFrame(page);
  await sleep(500);

  return { page, frame, asked, origin };
}

/** What the body's scripts would have left on the frame's window. */
/** What the body's scripts would have left on the frame's window, as JSON (a mark each script, handler or link sets). */
const ran = async (f: Frame): Promise<string> =>
  String(await f.evaluate("JSON.stringify([window.ranScript, window.ranHandler, window.ranClick, window.ranLink, window.ranSvg, window.stolen].map((v) => v ?? null))"));

/** Nothing the body tried ran. */
const NOTHING_RAN = JSON.stringify([null, null, null, null, null, null]);

test.skipIf(!found)("in the frame: the body's scripts, handlers, javascript: link, frame, object and form do nothing; the fleet's own script runs; pictures show", async () => {
  const { page, frame, asked } = await openD30(D30_BODY + HOSTILE);

  await frame.click("#press");
  await frame.click("#jslink");
  await frame.click("#send");
  await sleep(500);
  expect(await ran(frame)).toBe(NOTHING_RAN);
  expect(asked.filter((p) => p.endsWith("/framed.html") || p.endsWith("/sent.html"))).toEqual([]);
  expect(await frame.evaluate(() => location.href)).toBe("about:srcdoc");

  /* The fleet's own script: the tables' labels, the frame's height (the body's forged 7 px never sticks), the marks. */
  expect(await frame.$eval("table:last-of-type td:last-child", (e) => e.getAttribute("data-label"))).toBe("What it means here");
  expect(await page.$eval("#dv-frame iframe", (e) => e.getBoundingClientRect().height)).toBeGreaterThan(300);

  /* The pictures: an inline SVG drawn with the page's colours, a data: picture, the hub's picture by a relative path. */
  expect(await frame.$eval("#diagram", (e) => Math.round(e.getBoundingClientRect().width))).toBe(120);
  expect(await frame.$eval("#diagram rect", (e) => getComputedStyle(e).stroke)).not.toBe("none");
  expect(await frame.$eval("#data", (e) => (e instanceof HTMLImageElement ? e.naturalWidth : 0))).toBe(1);
  expect(await frame.$eval("#hubpic", (e) => (e instanceof HTMLImageElement ? e.naturalWidth : 0))).toBe(1);
  expect(asked.filter((p) => p.endsWith("/decisions/pic.png")).length).toBeGreaterThan(0);
});

test.skipIf(!found)("in the frame: a selection still reaches the page (fleetSelect), and a picasso-style isolated world still reads the frame", async () => {
  const { page, frame } = await openD30(D30_BODY + HOSTILE);
  await page.evaluate('addEventListener("message", (e) => { if (e.data && e.data.fleetSelect === true) window.heard = (window.heard || "") + "|" + e.data.text })');
  await frame.evaluate(() => {
    const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    for (let n = it.nextNode(); n; n = it.nextNode()) {
      const i = n instanceof Text ? n.data.indexOf("The idea") : -1;

      if (n instanceof Text && i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + "The idea".length);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(r);

        return;
      }
    }
  });
  await page.waitForSelector("#seltool:not([hidden])", { timeout: 3000 });
  await sleep(300);
  expect(String(await page.evaluate('window.heard || ""')).split("|")).toContain("The idea");

  /* An extension's content script runs in an isolated world of its own, which the page's policy does not reach. */
  const cdp = await page.createCDPSession();
  const tree = await cdp.send("Page.getFrameTree");
  const child = tree.frameTree.childFrames?.find((c) => c.frame.url === "about:srcdoc");
  expect(child).toBeDefined();
  const world = await cdp.send("Page.createIsolatedWorld", { frameId: child?.frame.id ?? "", worldName: "picasso-like" });
  const seen = await cdp.send("Runtime.evaluate", { contextId: world.executionContextId, expression: "document.querySelector('#diagram') !== null && document.body.textContent.includes('The idea')", returnByValue: true });
  expect(seen.result.value).toBe(true);
});

test.skipIf(!found)("in the frame: a body that leaves a <script tag open to take the fleet's nonce runs nothing", async () => {
  const { frame } = await openD30(D30_BODY + '<script src="data:text/javascript,window.stolen=true" x=');
  await sleep(300);
  expect(await ran(frame)).toBe(NOTHING_RAN);
});

test.skipIf(!found)("served by itself, as the hub serves it: plain text, so nothing in it renders, runs, loads or navigates", async () => {
  const body = D30_BODY + HOSTILE + `<meta http-equiv="&#114;efresh" content="0;url=gone.html">`;
  const { origin, asked } = hubFor(body);
  const context = await browser.createBrowserContext();
  cleanups.push(() => void context.close().catch(() => undefined));
  const page = await context.newPage();
  const url = `${origin}/f/perf/decisions/raw.html`;
  await page.goto(url, { waitUntil: "load" });
  await sleep(800);
  const frame = page.mainFrame();

  expect(page.url()).toBe(url);
  expect(await frame.evaluate(() => document.contentType)).toBe("text/plain");
  expect(await frame.evaluate(() => document.body.textContent)).toBe(body);
  expect(await frame.$("#press")).toBeNull();
  expect(await ran(frame)).toBe(NOTHING_RAN);
  expect(asked.filter((p) => p.endsWith("/framed.html") || p.endsWith("/pic.png") || p.endsWith("/gone.html"))).toEqual([]);
});
