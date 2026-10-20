/**
 * References in a real browser (the built template in headless Chromium, fed by the harness; refs.ts,
 * refframe.ts): on a phone the Links view's row of Luiz's screenshot links its d30 and a tap opens perf's
 * decision on the manager's page; a tip that shows moves no words; a decision's row opens its page from
 * anywhere on it, and the reference in its words opens the row it names; in a decision's body (the sandboxed
 * frame, whose script is the page's own source as the build left it) a reference is a link, and a tap on it
 * takes the page there, from a fleet's own page and from inside the manager's frame, where the link's own
 * address is the fleet's whole page; a tap on the pin of a mark that ends in a reference is the mark's, and
 * takes the page nowhere. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";

import { coordinatorChat, managerChat, refsFleetView, refsManagerView, type View } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-13T12:00:00Z");

/** d58's body, as perf wrote it: its ledger's d30 by id and by number, in code, and in a link of the body's own; then a database and a roadblock's number, a letter and a digit each (perf holds a D1 and an R1). */
const BODY = `<h2>The bench</h2>
<p id="words">As d30 chose the model (D130), the nightly bench replays saved calls; d31 is no row, and <code>d30</code> is code.</p>
<p><a href="https://example.com/d30">d30 elsewhere</a></p>
<p id="short">Move off D1 onto Postgres; R1 still blocks the adapter.</p>`;

/** perf's page, its d58 with a body. */
function fleetView(): View {
  const view = refsFleetView(NOW);
  const decisions = Array.isArray(view["decisions"]) ? view["decisions"] : [];

  return { ...view, decisions: decisions.map((d) => (d !== null && Object(d) === d && !Array.isArray(d) && d["id"] === "d58" ? { ...d, body: true } : d)) };
}

let browser: Browser;

let manager: Harness;

let fleet: Harness;

let hub: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!found) return;
  const template = readFileSync(TEMPLATE, "utf8");
  manager = serveHarness({ template, view: refsManagerView(NOW), messages: managerChat(NOW) });
  fleet = serveHarness({ template, view: fleetView(), messages: coordinatorChat(NOW), bodies: { d58: BODY } });
  /* One origin, as the hub is: the manager's page at /f/manager/, perf's at every other /f/<fleet>/. */
  hub = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      const to = new URL(url.pathname.startsWith("/f/manager/") ? manager.url : fleet.url).origin;

      return fetch(to + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.body });
    },
  });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  void hub.stop(true);
  manager.stop();
  fleet.stop();
});

const at = (path: string): string => `http://127.0.0.1:${String(hub.port)}${path}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The body's frame of the decision `page` (or the fleet's page in the manager's frame, `within`) shows, once its references are linked. */
async function bodyFrame(page: Page, within?: Frame): Promise<Frame> {
  for (let i = 0; i < 100; i += 1) {
    const holder = await (within ?? page).$("#dv-frame iframe[srcdoc]");
    const f = await holder?.contentFrame();

    if (f && (await f.evaluate(() => document.querySelector("a.dref") !== null).catch(() => false))) return f;
    await sleep(100);
  }

  throw new Error("no body frame with a reference linked");
}

test.skipIf(!found)("on a phone, the Links row's d30 is a link in its words; a tip moves nothing; a tap opens perf's decision on the manager's page", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(at("/f/manager/#links"), { waitUntil: "domcontentloaded" });
  const row = '#links-view .link-row[data-link="bench"]';
  await page.waitForSelector(`${row} .link-for a.dref`);
  /* The page's fonts come from Google after the row shows: their swap moves the link 4 px left and 1 px down. Read
   * before it, the link moved on a loaded machine and the tip took the blame. */
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const read = () =>
    page.evaluate((sel: string) => {
      const p = document.querySelector(`${sel} .link-for`);
      const a = p?.querySelector<HTMLAnchorElement>("a.dref");
      const box = p?.getBoundingClientRect();
      const link = a?.getBoundingClientRect();

      return {
        words: (p?.textContent ?? "").replace(/\s+/gu, " ").trim().replace(/D130.*$/u, ""),
        href: a?.getAttribute("href"),
        box: box ? [Math.round(box.top), Math.round(box.height)] : null,
        link: link ? [Math.round(link.left), Math.round(link.top), Math.round(link.width)] : null,
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        nested: document.querySelectorAll("a a, button a, a button").length,
      };
    }, row);

  const before = await read();
  expect(before.words).toBe("For you: read the bench design (d30): idea, model, seams");
  expect([before.href, before.sideways, before.nested]).toEqual(["#decision/perf/d130-t-d130", false, 0]);
  /* Focus shows its tip: the words and the link stay where they were. */
  await page.focus(`${row} .link-for a.dref`);
  await page.waitForSelector(`${row} .link-for .dref-tip`);
  const tipped = await read();
  expect([tipped.box, tipped.link, tipped.sideways]).toEqual([before.box, before.link, false]);
  /* Its tip says what the page holds of it, then what perf's ledger says (read through the hub). */
  await page.waitForFunction((sel: string) => document.querySelector(`${sel} .link-for .dref-tip`)?.textContent?.startsWith("D130 The bench's model, in perf: decided ") === true, {}, row);
  await page.tap(`${row} .link-for a.dref`);
  await page.waitForFunction(() => location.hash === "#decision/perf/d130-t-d130");
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>("#dv-embed")?.getAttribute("src")?.endsWith("f/perf/?embed=1#decision/d30") === true);
  const embedded = await (await page.waitForSelector("#dv-embed"))?.contentFrame();
  await embedded?.waitForFunction(() => document.querySelector("#decision h1")?.textContent?.includes("The bench's model") === true);
  await page.close();
});

test.skipIf(!found)("a decision's row opens its page from anywhere on it; the reference in its words opens the row it names", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(at("/f/perf/#decisions"), { waitUntil: "domcontentloaded" });
  const row = '#decision-list .ask:has(> a.ask-head[href="#decision/perf/d158-which-bench-runs-nightly-after-d30"])';
  await page.waitForSelector(`${row} .detail a.dref`);
  expect(await page.$eval(`${row} .detail a.dref`, (a) => [a.textContent, a.getAttribute("href")])).toEqual(["d30", "#decision/perf/d130-the-bench-s-model"]);

  /* A tap on the row's words that are no reference (its last line) opens the row's decision: the head's link lies over them. */
  const meta = await page.$eval(`${row} .meta`, (e) => {
    e.scrollIntoView({ block: "center" });
    const box = e.getBoundingClientRect();
    const at = { x: box.x + 6, y: box.y + box.height - 4 };
    const hit = document.elementFromPoint(at.x, at.y);

    return { ...at, hit: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : "" };
  });

  expect(meta.hit).toBe("a.ask-head");
  await page.touchscreen.tap(meta.x, meta.y);
  await page.waitForFunction(() => location.hash === "#decision/perf/d158-which-bench-runs-nightly-after-d30");
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#decisions");
  await page.$eval(`${row} .detail a.dref`, (e) => e.scrollIntoView({ block: "center" }));
  await page.tap(`${row} .detail a.dref`);
  await page.waitForFunction(() => location.hash === "#decision/perf/d130-the-bench-s-model");
  await page.close();
});

test.skipIf(!found)("in a decision's body a reference is a link the frame's own script made, and a tap on it takes the page there", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => (m.type() === "error" && /Content Security Policy|Refused/u.test(m.text()) ? errors.push(m.text()) : undefined));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(at("/f/perf/#decision/d58"), { waitUntil: "domcontentloaded" });
  const f = await bodyFrame(page);

  expect(
    await f.evaluate(() => ({
      words: document.querySelector("#words")?.textContent,
      made: [...document.querySelectorAll<HTMLAnchorElement>("a.dref")].map((a) => [a.textContent, a.href.replace(/^https?:\/\/[^/]+/u, ""), a.target, a.rel, a.title.slice(0, 26)]),
      code: document.querySelector("code")?.children.length,
      own: document.querySelector('a[href="https://example.com/d30"]')?.children.length,
    })),
  ).toEqual({
    words: "As d30 chose the model (D130), the nightly bench replays saved calls; d31 is no row, and d30 is code.",
    made: [
      ["d30", "/f/perf/#decision/perf/d130-the-bench-s-model", "_blank", "noopener noreferrer", "D130 The bench's model: de"],
      ["D130", "/f/perf/#decision/perf/d130-the-bench-s-model", "_blank", "noopener noreferrer", "D130 The bench's model: de"],
    ],
    code: 0,
    own: 0,
  });
  /* The frame may not take the page anywhere: its script says which reference was tapped, and the page goes. */
  await f.click("a.dref");
  await page.waitForFunction(() => location.hash === "#decision/perf/d130-the-bench-s-model");
  expect(await page.$eval("#decision h1", (h) => h.textContent)).toContain("The bench's model");
  expect(errors).toEqual([]);
  await page.close();
});

test.skipIf(!found)("a tap on the pin of a mark that ends in a body's reference is the mark's: the page stays on the decision", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(at("/f/perf/#decision/d58"), { waitUntil: "domcontentloaded" });
  const f = await bodyFrame(page);

  /* A mark whose words end in the reference, painted as the page paints one (markframe.ts): its pin goes after the mark, inside the reference's link. */
  await page.$eval("#dv-frame iframe", (frame) => {
    const mark = { id: "m1", n: 1, kind: "comment", blocks: [{ exact: "As d30", prefix: "", suffix: " chose the model (D130), the nig" }], done: false, active: false, show: true, status: "pending", unread: false };

    if (frame instanceof HTMLIFrameElement) frame.contentWindow?.postMessage({ annotPaint: true, marks: [mark] }, "*");
  });
  await f.waitForSelector("[data-pin]");
  await page.$eval("#dv-frame iframe", (frame) => frame.scrollIntoView({ block: "center" }));

  /* The pin's number is drawn above the end of the words (its ::after), a few pixels up and left of the pin's own box. */
  const pin = await f.evaluate(() => {
    const foot = document.querySelector("[data-pin]");
    const box = foot?.getBoundingClientRect();
    const point = { x: (box?.x ?? 0) - 6, y: (box?.y ?? 0) - 4 };

    return { ...point, within: foot?.parentElement?.closest("a.dref") !== null, hit: document.elementFromPoint(point.x, point.y) === foot };
  });

  expect([pin.within, pin.hit]).toEqual([true, true]);
  const frame = await (await page.$("#dv-frame iframe"))?.boundingBox();

  if (!frame) throw new Error("no body frame on the page");
  await page.mouse.click(frame.x + pin.x, frame.y + pin.y);
  expect(await page.waitForFunction(() => location.hash !== "#decision/d58", { timeout: 1500 }).then(() => "left", () => "stayed")).toBe("stayed");
  /* The words of the reference beside the mark still lead where they did. */
  await f.click('a.dref[href$="#decision/perf/d130-the-bench-s-model"]:not(:has(mark))');
  await page.waitForFunction(() => location.hash === "#decision/perf/d130-the-bench-s-model");
  await page.close();
});

test.skipIf(!found)("inside the manager's frame, a tap on a body's reference opens that decision on the manager's page", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(at("/f/manager/#decision/perf/d58"), { waitUntil: "domcontentloaded" });
  const embedded = await (await page.waitForSelector("#dv-embed"))?.contentFrame();

  if (!embedded) throw new Error("no fleet frame");
  const f = await bodyFrame(page, embedded);

  /* The link's own address (a window the browser opens for a modified click) is the fleet's whole page, never the bare one the manager's frame shows. */
  expect(await embedded.evaluate(() => location.search)).toBe("?embed=1");
  expect(await f.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>("a.dref")].map((a) => a.href.replace(/^https?:\/\/[^/]+/u, "")))).toEqual(["/f/perf/#decision/perf/d130-the-bench-s-model", "/f/perf/#decision/perf/d130-the-bench-s-model"]);
  await f.click("a.dref");
  await page.waitForFunction(() => location.hash === "#decision/perf/d30");
  /* A reference in the fleet's own words there (its title names d30) opens on the manager's page too. */
  await page.evaluate(() => void (location.hash = "#decision/perf/d58"));
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>("#dv-embed")?.getAttribute("src")?.endsWith("#decision/d58") === true);
  const again = await (await page.waitForSelector("#dv-embed"))?.contentFrame();
  await (await again?.waitForSelector("#decision h1 a.dref"))?.click();
  await page.waitForFunction(() => location.hash === "#decision/perf/d30");
  await page.close();
});
