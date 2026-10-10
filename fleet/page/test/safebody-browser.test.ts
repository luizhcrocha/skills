/**
 * The body's sanitiser and its second parse (safebody.ts) on their own, in headless Chromium: the second parse,
 * which the frame's parse is checked by, finds what the frame would hold that is forbidden (a `<meta>`, a
 * `noscript` the inert parse read otherwise, a handler, a `javascript:` link, a link not opening a window of its
 * own, markup a second parse changes) and passes a clean body; a body it refuses is shown as its plain text
 * under a notice; every link, HTML or SVG, opens a window of its own; a picture loads from `data:` or the hub
 * only; an `id` that would clobber a DOM property is kept as `user-content-<id>`, with the body's `#<id>` links. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

let browser: Browser;

let page: Page;

let server: ReturnType<typeof Bun.serve> | null = null;

let dir = "";

beforeAll(async () => {
  if (!found) return;
  dir = mkdtempSync(join(tmpdir(), "safebody-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `import * as safe from ${JSON.stringify(join(import.meta.dir, "..", "src", "safebody.ts"))};\nObject.assign(globalThis, { safe });\n`);
  const out = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife", conditions: ["browser"] });

  if (!out.success) throw new Error(out.logs.join("\n"));
  const script = await out.outputs[0]?.text();

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;

      if (path === "/safe.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });

      return new Response(`<!doctype html><html><head><script src="/safe.js"></script></head><body></body></html>`, { headers: { "Content-Type": "text/html" } });
    },
  });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${String(server.port)}/f/perf/`);
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  void server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/** The module as the entry above puts it on the window. */
declare global {
  var safe: typeof import("../src/safebody.ts");
}

/** What the second parse finds in `html`, given as it is (not sanitised first). */
const reparse = (html: string): Promise<readonly string[]> => page.evaluate((h: string) => globalThis.safe.reparse(h), html);

/** `html` as the frame is given it: sanitised against the hub's `decisions/`, then checked. */
const shown = (html: string, refuse = false): Promise<string> =>
  page.evaluate(
    (h: string, r: boolean) => {
      const { safe } = globalThis;

      return safe.safeBody(h, new URL("decisions/", location.href).href, r ? () => Promise.resolve(["refused by the test"]) : undefined);
    },
    html,
    refuse,
  );

test.skipIf(!found)("the second parse finds what the frame would hold that is forbidden, and passes a clean body", async () => {
  expect(await reparse('<p>Plain <a href="x" target="_blank" rel="noopener">link</a></p><table><tbody><tr><td>a</td></tr></tbody></table>')).toEqual([]);
  expect(await reparse('<p>x</p><meta http-equiv="refresh" content="0;url=/elsewhere">')).toContain("<meta>");
  expect(await reparse('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>')).toContain("<noscript>");
  expect(await reparse("<img src=x onerror=alert(1)>")).toContain("img[onerror]");
  expect(await reparse('<a href=" java\tscript:alert(1)" target="_blank">x</a>')).toEqual([expect.stringMatching(/^a\[href\] javascript:/u)]);
  expect(await reparse('<a href="/x">x</a>')).toEqual(["a without target=_blank"]);
  expect(await reparse('<svg><a href="/x"><text>x</text></a></svg>')).toEqual(["a without target=_blank"]);
  expect(await reparse("<table><div>moved out</div></table>")).toEqual(["changed by a second parse"]);
});

test.skipIf(!found)("a body the second parse refuses is shown as its plain text under a notice, with none of its markup", async () => {
  const doc = await shown('<h2>The idea</h2><p>Every model call is saved <b>&amp; kept</b>.</p><script>alert(1)</script>', true);

  expect(doc).toStartWith("<p class=\"callout\">This decision's body could not be shown safely. Its text:</p><pre");
  expect(doc).toContain("The ideaEvery model call is saved &amp; kept.");
  expect(doc).not.toContain("<b>");
  expect(doc).not.toContain("alert");
});

test.skipIf(!found)("every link, HTML or SVG, opens a window of its own; a picture loads from data: or the hub only; nothing that runs is kept", async () => {
  const doc = await shown(
    '<p><a href="https://example.com/x" target="_top">top</a> <a href="javascript:alert(1)">js</a></p>' +
      '<svg width="20" height="20"><a href="https://example.com/y"><rect width="20" height="20"/></a><a xlink:href="https://example.com/z"><text>z</text></a></svg>' +
      '<img id="data" src="data:image/png;base64,AAAA"><img id="hub" src="pic.png"><img id="away" src="https://example.com/p.png"><img id="srcset" src="pic.png" srcset="https://example.com/p.png 2x">' +
      '<div class="callout" style="color:var(--muted)"><details><summary>More</summary><pre><code>bench run</code></pre></details></div>',
  );

  const parsed = await page.evaluate((h: string) => {
    const t = document.createElement("template");

    t.innerHTML = h;

    return {
      links: [...t.content.querySelectorAll("a")].map((a) => `${a.getAttribute("target") ?? ""} ${a.getAttribute("rel") ?? ""} ${a.getAttribute("href") ?? a.getAttribute("xlink:href") ?? ""}`),
      pictures: [...t.content.querySelectorAll("img")].map((i) => `${i.id}:${i.getAttribute("src") ?? ""}:${i.getAttribute("srcset") ?? ""}`),
      kept: [".callout[style]", "details summary", "pre code"].map((q) => t.content.querySelector(q) !== null),
    };
  }, doc);

  expect(parsed.links).toEqual([
    "_blank noopener noreferrer https://example.com/x",
    "_blank noopener noreferrer ",
    "_blank noopener noreferrer https://example.com/y",
    "_blank noopener noreferrer https://example.com/z",
  ]);
  expect(parsed.pictures).toEqual(["data:data:image/png;base64,AAAA:", "hub:pic.png:", "away::", "srcset:pic.png:"]);
  expect(parsed.kept).toEqual([true, true, true]);
});

test.skipIf(!found)("a body that opens with its own stylesheet keeps it", async () => {
  expect(await shown("<style>.gone{display:none}</style><p>Kept <span class=\"gone\">hidden</span></p>")).toBe('<style>.gone{display:none}</style><p>Kept <span class="gone">hidden</span></p>');
});

test.skipIf(!found)("an id or name that would clobber a DOM property is kept as user-content-<it>, and the body's links to it follow; others stay as written", async () => {
  const doc = await shown(
    '<p><a href="#open">Open questions</a> <a href="#forms">Forms</a> <a href="#dv-info">Info</a> <a href="#nowhere">gone</a></p>' +
      '<h2 id="open">Open questions</h2><h2 id="forms">Forms</h2><h2 id="dv-info">Info</h2><a name="action">old anchor</a>' +
      '<svg width="10" height="10"><defs><linearGradient id="title"></linearGradient></defs><a href="#title"><text>t</text></a><a xlink:href="#title"><text>x</text></a></svg>',
  );

  const parsed = await page.evaluate((h: string) => {
    const t = document.createElement("template");

    t.innerHTML = h;

    return {
      ids: [...t.content.querySelectorAll("[id]")].map((e) => e.id),
      names: [...t.content.querySelectorAll("[name]")].map((e) => e.getAttribute("name")),
      hrefs: [...t.content.querySelectorAll("a")].flatMap((e) => e.getAttribute("href") ?? e.getAttribute("xlink:href") ?? []),
    };
  }, doc);

  expect(parsed).toEqual({
    ids: ["user-content-open", "user-content-forms", "dv-info", "user-content-title"],
    names: ["user-content-action"],
    hrefs: ["#user-content-open", "#user-content-forms", "#dv-info", "#nowhere", "#user-content-title", "#user-content-title"],
  });
});
