/**
 * What the content-policy tests share (content-policy-browser, content-policy-manager-browser, mxss-browser): the
 * rows a body may try, the mutation-XSS table, a stand-in hub that serves D30's body (and by itself through
 * `servedBody`), a page that hears what ran, and each row's trouble where the body shows. Split over files so
 * the gate runs them side by side. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";

import { servedBody } from "../../src/hub/body-policy.ts";
import { coordinatorChat, managerChat } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";
import { D30_BODY, marksManagerView, marksView } from "./marks-fixtures.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

export const found = chromium !== "" && existsSync(chromium);

export const NOW = Date.parse("2026-10-10T12:00:00Z");

/** A 1×1 PNG, base64. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** The stand-in hub's origin, as a row's body names it. */
export const HUB = "__HUB__";

/** A script that tells it ran: a message to the top page, and a request to the hub. */
const ping = (row: string): string => `top.postMessage({ran:'${row}'},'*');new Image().src='${HUB}/ran/${row}'`;

/** The same, as the text of an attribute in double quotes. */
const attr = (row: string): string => ping(row).replaceAll("'", "&#39;");

/** A row: what the body holds, and whether Luiz presses `#act` in it. */
export interface Row {
  readonly name: string;
  readonly html: string;
  readonly press?: true;
}

export const ROWS: readonly Row[] = [
  { name: "script", html: `<script>${ping("script")}</script>` },
  { name: "onload", html: `<img src="data:image/png;base64,${PNG}" onload="${attr("onload")}">` },
  { name: "onerror", html: `<img src="data:," onerror="${attr("onerror")}">` },
  { name: "javascript: link", html: `<a id="act" href="javascript:${attr("jslink")}">Open</a>`, press: true },
  { name: "javascript: link, target=_self", html: `<a id="act" target="_self" href="javascript:${attr("jsself")}">Open</a>`, press: true },
  { name: "iframe srcdoc", html: `<iframe srcdoc="&lt;script&gt;${attr("srcdoc")}&lt;/script&gt;&lt;img src=x onerror=&quot;${attr("srcdocimg")}&quot;&gt;"></iframe>` },
  { name: "object", html: `<object data="data:text/html,%3Cscript%3E${encodeURIComponent(ping("object"))}%3C/script%3E"></object>` },
  { name: "embed", html: `<embed type="image/svg+xml" src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" onload="${attr("embed")}"/>`)}">` },
  { name: "svg script", html: `<svg width="10" height="10"><script>${ping("svgscript")}</script></svg>` },
  { name: "svg onload", html: `<svg width="10" height="10" onload="${attr("svgonload")}"><rect width="10" height="10"/></svg>` },
  { name: "meta refresh to javascript:", html: `<meta http-equiv="refresh" content="0;url=javascript:${attr("metajs")}">` },
  { name: "meta refresh to a URL", html: `<meta http-equiv="Refresh" content="0; url=${HUB}/nav/meta">` },
  { name: "form submission", html: `<form action="${HUB}/nav/form" method="get"><input name="q" value="1"><button id="act">Send</button></form>`, press: true },
  { name: "form submission, target=_top", html: `<form action="${HUB}/nav/formtop" method="get" target="_top"><button id="act">Send</button></form>`, press: true },
  { name: "a target=_top", html: `<a id="act" target="_top" href="${HUB}/nav/top">Top</a>`, press: true },
  { name: "base href", html: `<base href="${HUB}/nav/base/"><img src="b.png" alt=""><a id="act" target="_self" href="here.html">Here</a>`, press: true },
  { name: "meta refresh, its http-equiv an entity", html: `<meta http-equiv="&#114;efresh" content="0;url=${HUB}/nav/entity">` },
  { name: "meta refresh, its http-equiv a hex entity", html: `<meta http-equiv="re&#x66;resh" content="0;url=${HUB}/nav/entity2">` },
  { name: "mutation XSS: noscript and style", html: `<noscript><style></noscript><meta http-equiv=refresh content="0;url=${HUB}/nav/noscript"></style></noscript>` },
  { name: "mutation XSS: form, math, mglyph", html: `<form><math><mtext></form><form><mglyph><style></math><meta http-equiv=refresh content="0;url=${HUB}/nav/formmath">` },
  { name: "an SVG link with no target", html: `<svg width="200" height="50"><a id="act" href="${HUB}/nav/svga"><rect width="200" height="50" fill="red"/></a></svg>`, press: true },
  { name: "an SVG link, target=_self", html: `<svg width="200" height="50"><a id="act" target="_self" href="${HUB}/nav/svgself"><rect width="200" height="50" fill="red"/></a></svg>`, press: true },
];

/**
 * Mutation-XSS shapes, each of which, let through, navigates the frame (a `<meta>` refresh to the hub's `/nav/`)
 * or carries a handler or a `javascript:` link: the reviewer's (an inert template's parse differs from the frame's),
 * and the shapes of DOMPurify's own past bypasses (its test suite) that apply to a body.
 */
export const MXSS: readonly (readonly [string, string])[] = [
  ["noscript and style (review)", `<noscript><style></noscript><meta http-equiv=refresh content="0;url=${HUB}/nav/m1"></style></noscript>`],
  ["form, math, mglyph (review)", `<form><math><mtext></form><form><mglyph><style></math><meta http-equiv=refresh content="0;url=${HUB}/nav/m2">`],
  ["a declarative shadow root", `<div><template shadowrootmode="open"><meta http-equiv="refresh" content="0;url=${HUB}/nav/m3"></template></div>`],
  ["svg style breakout", `<svg><style><meta http-equiv=refresh content="0;url=${HUB}/nav/m4"></style></svg>`],
  ["svg, p, style (DOMPurify 2.0.0)", `<svg></p><style><a id="</style><meta http-equiv=refresh content='0;url=${HUB}/nav/m5'><img src=1 onerror=${attr("m5")}>">`],
  ["math, mtext, table, mglyph, style, comment (2.0.1)", `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;meta http-equiv=refresh content='0;url=${HUB}/nav/m6'&gt;&lt;img src=1 onerror=${attr("m6")}&gt;">`],
  ["math, mi, mglyph, svg, mtext, textarea (2.2.2)", `<math><mi><mglyph><svg><mtext><textarea><path id="</textarea><meta http-equiv=refresh content='0;url=${HUB}/nav/m7'><img onerror=${attr("m7")} src=1>"></path></textarea></mtext></svg></mglyph></mi></math>`],
  ["form, math, mtext, mglyph, svg, style (2.2.3)", `<form><math><mtext></form><form><mglyph><svg><mtext><style><path id="</style><meta http-equiv=refresh content='0;url=${HUB}/nav/m8'><img onerror=${attr("m8")} src>">`],
  ["noscript title", `<noscript><p title="</noscript><meta http-equiv=refresh content='0;url=${HUB}/nav/m9'><img src=x onerror=${attr("m9")}>"></noscript>`],
  ["noembed title", `<noembed><p title="</noembed><meta http-equiv=refresh content='0;url=${HUB}/nav/m10'>"></noembed>`],
  ["xmp title", `<xmp><p title="</xmp><meta http-equiv=refresh content='0;url=${HUB}/nav/m11'>"></xmp>`],
  ["comment in an attribute", `<!--<img src="--><meta http-equiv=refresh content='0;url=${HUB}/nav/m12'><img src=x onerror=${attr("m12")}//">`],
  ["svg foreignObject", `<svg><foreignObject><meta http-equiv=refresh content="0;url=${HUB}/nav/m13"></foreignObject></svg>`],
  ["math annotation-xml", `<math><annotation-xml encoding="text/html"><style><meta http-equiv=refresh content='0;url=${HUB}/nav/m14'></style></annotation-xml></math>`],
  ["select, template, style comment", `<select><template><style><!--</style><a rel="--></template></select><meta http-equiv=refresh content='0;url=${HUB}/nav/m15'>">`],
  ["a form in a table", `<table><form><tr><td><meta http-equiv=refresh content="0;url=${HUB}/nav/m16"></td></tr></form></table>`],
  ["javascript: as an entity", `<a href="&#x6A;avascript:${attr("m17")}">x</a>`],
  ["svg xlink:href javascript:", `<svg><a xlink:href="javascript:${attr("m18")}"><text x="20" y="20">x</text></a></svg>`],
  ["svg animate turning a link to javascript:", `<svg><a><animate attributeName="href" values="javascript:${attr("m19")}"/><text x="20" y="20">x</text></a></svg>`],
  ["button formaction", `<button form="f" formaction="javascript:${attr("m20")}">x</button>`],
  ["iframe srcdoc with a refresh", `<iframe srcdoc="&lt;meta http-equiv=refresh content='0;url=${HUB}/nav/m21'&gt;"></iframe>`],
  ["a tab or newline in javascript:", `<a href="java&#x09;script:${attr("m22")}">x</a><a href="java&#x0A;script:${attr("m23")}">y</a>`],
  ["a style element's end in an SVG title", `<svg><title><style></title><meta http-equiv=refresh content='0;url=${HUB}/nav/m24'></style></svg>`],
];

let browser: Browser;

let template = "";

const cleanups: (() => void)[] = [];

/** The browser and the built template for a file's tests, launched before them and closed after. */
export function usePolicyBrowser(): void {
  beforeAll(async () => {
    if (!found) return;
    template = readFileSync(TEMPLATE, "utf8");
    browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
  });

  afterAll(async () => {
    for (const c of cleanups) c();

    if (found) await browser.close();
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The stand-in hub: perf's page (and the manager's) from harnesses, perf's bodies by itself through `servedBody`, the paths asked. */
export interface Hub {
  readonly origin: string;
  readonly asked: string[];
  readonly fleet: Harness;
  setBody(html: string): void;
}

/** A stand-in hub serving D30's body `html` (with {@link HUB} its origin) and extra pages under `/f/perf/x/`. */
export function hubFor(html: string, extra: Record<string, string> = {}): Hub {
  const fleet = serveHarness({ template, view: marksView(NOW), messages: coordinatorChat(NOW), bodies: { d30: "" } });
  const manager = serveHarness({ template, view: marksManagerView(NOW), messages: managerChat(NOW) });
  const asked: string[] = [];
  let body = html;

  const hub = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      asked.push(url.pathname);
      const page = extra[url.pathname];

      if (page !== undefined) return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });

      if (url.pathname === "/f/perf/decisions/d30.html") return servedBody(new TextEncoder().encode(body), "text/html;charset=utf-8", { "Cache-Control": "no-store" });

      if (url.pathname.startsWith("/ran/") || url.pathname.startsWith("/nav/")) return new Response("<p>gone</p>", { headers: { "Content-Type": "text/html" } });
      const to = new URL(url.pathname.startsWith("/f/manager/") ? manager.url : fleet.url).origin;

      return fetch(to + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.body });
    },
  });

  const origin = `http://127.0.0.1:${String(hub.port)}`;
  body = html.replaceAll(HUB, origin);

  cleanups.push(() => {
    void hub.stop(true);
    fleet.stop();
    manager.stop();
  });

  return { origin, asked, fleet, setBody: (h) => (body = h.replaceAll(HUB, origin)) };
}

/** The windows each page's links opened (a link the body names a window for opens one of its own: allowed, and not a navigation). */
const popups = new WeakMap<Page, string[]>();

/** A page of its own, hearing every `{ran}` message on its top window. */
export async function freshPage(): Promise<Page> {
  const context = await browser.createBrowserContext();
  cleanups.push(() => void context.close().catch(() => undefined));
  const page = await context.newPage();
  const opened: string[] = [];
  popups.set(page, opened);
  context.on("targetcreated", (t) => {
    if (t.type() === "page") void t.page().then(async (p) => {
      await sleep(300);
      opened.push(new URL(p?.url() ?? "about:blank").pathname);
    });
  });
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => {
    addEventListener("message", (e: MessageEvent<{ ran?: string } | null>) => {
      const ran = e.data?.ran;

      if (ran !== undefined && ran === String(ran)) document.documentElement.dataset["ran"] = (document.documentElement.dataset["ran"] ?? "") + ran + " ";
    });
  });

  return page;
}

/** The frame D30's body is in, once its text is there. */
export async function bodyFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 80; i += 1) {
    for (const f of page.frames()) {
      if (f === page.mainFrame() || f.detached || f.url().includes("embed=1")) continue;
      const ok = await f.evaluate(() => document.body?.textContent?.includes("The idea") === true).catch(() => false);

      if (ok) return f;
    }

    await sleep(100);
  }

  throw new Error("no body frame");
}

/** Select "The idea" in `f`. */
export async function selectIdea(f: Frame): Promise<void> {
  await f.evaluate(() => {
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
}

/** What ran or navigated, as words; empty when nothing did. */
async function trouble(page: Page, hub: Hub, startUrl: string, frame: Frame | null): Promise<string[]> {
  const out: string[] = [];
  const ran = await page.evaluate(() => document.documentElement.dataset["ran"] ?? "").catch(() => "");

  if (ran.trim()) out.push("ran: " + ran.trim());
  const opened = popups.get(page) ?? [];
  const hits = hub.asked.filter((p) => p.startsWith("/ran/") || (p.startsWith("/nav/") && !opened.includes(p)));

  if (hits.length) out.push("asked: " + hits.join(" "));

  if (page.url() !== startUrl) out.push("page went to " + page.url());

  if (frame) {
    const at = frame.detached ? "detached" : frame.url();

    if (at !== "about:srcdoc") out.push("frame went to " + at);
  }

  return out;
}

/** What the body as shown in `frame` holds that the sanitiser forbids: an element, a handler, a `javascript:` address, a link that does not open a window of its own, a script besides the fleet's one. */
async function forbiddenIn(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => {
    const out: string[] = [];
    const scripts = document.body.querySelectorAll("script").length;

    if (scripts !== 1) out.push(`${String(scripts)} scripts`);

    for (const el of document.body.querySelectorAll("*")) {
      const n = el.localName;

      if (/^(?:meta|base|form|noscript|math|iframe|frame|object|embed|template|link|noembed|xmp)$/u.test(n)) out.push(`<${n}>`);

      if ((n === "a" || n === "area") && el.getAttribute("target") !== "_blank") out.push(`${n} without target=_blank`);

      for (const a of el.attributes) {
        if (/^on/iu.test(a.name)) out.push(`${n}[${a.name}]`);

        if (/^(?:javascript|vbscript):/iu.test([...a.value].filter((c) => c.charCodeAt(0) > 32).join(""))) out.push(`${n}[${a.name}] javascript:`);
      }
    }

    return out;
  });
}

/** The fleet's own scripts on a page showing the body in `frame`: its height, the bar on a selection, the kinds of mark. */
async function ownScripts(page: Page, frame: Frame, height: () => Promise<number>): Promise<string[]> {
  const out: string[] = [];

  if ((await height()) < 300) out.push("frame not sized");
  await selectIdea(frame);
  const bar = await page.waitForSelector("#seltool:not([hidden]) .seltool-marks", { timeout: 3000 }).catch(() => null);

  if (!bar) out.push("no selection bar with marks");

  return out;
}

/** Where a row's body shows: the page's address, the frame it is in (null when it is the page itself, as plain text), and how tall it shows. */
export interface Shown {
  readonly url: string;
  readonly frame: Frame | null;
  readonly height: (() => Promise<number>) | null;
}

/** Each row's trouble where the body shows: `open` opens the page and gives the frame and how tall it shows. */
export async function eachRow(open: (page: Page, hub: Hub) => Promise<Shown>, rows: readonly Row[] = ROWS): Promise<string[]> {
  const failed: string[] = [];

  for (const row of rows) {
    const hub = hubFor(D30_BODY + row.html);
    const page = await freshPage();
    const { url, frame, height } = await open(page, hub);

    /* By itself, the body is text: nothing in it to press. */
    if (row.press && frame) await frame.click("#act").catch(() => failed.push(`${row.name}: could not press it`));

    if (!frame) {
      const shown = await page.evaluate(() => ({ type: document.contentType, elements: document.body.querySelectorAll("*:not(pre)").length }));

      if (shown.type !== "text/plain" || shown.elements !== 0) failed.push(`${row.name}: by itself it rendered (${shown.type}, ${String(shown.elements)} elements)`);
    }

    await sleep(800);
    await page.bringToFront();
    const bad = await trouble(page, hub, url, frame);

    if (frame && !frame.detached && frame.url() === "about:srcdoc") bad.push(...(await forbiddenIn(frame)));

    if (frame && height && !frame.detached && frame.url() === "about:srcdoc") bad.push(...(await ownScripts(page, frame, height)));

    if (bad.length) failed.push(`${row.name}: ${bad.join("; ")}`);
    await page.close();
  }

  return failed;
}
