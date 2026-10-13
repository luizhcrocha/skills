/**
 * What the visibility tests share (visibility-browser, visibility-reach-browser): the CSS-only ways a body hides
 * or covers words, perf's page on D30 in headless Chromium recording what the frame tells of a selection, the
 * quote the composer takes, and the run of a set of hiding rows. Split over files so the gate runs them side by
 * side. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";

import { coordinatorChat } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";
import { D30_BODY, marksView } from "./marks-fixtures.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

export const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-10T12:00:00Z");

/** The words a row hides. */
export const SECRET = "Luiz approves without changes";

/** A visible paragraph around the hidden words: `open` and `close` wrap them, `style` goes before it. */
const around = (open: string, close: string, style = ""): string => `${style}<p id="row">Before these words ${open}${SECRET}${close} after these words.</p>`;

/** The ways a body hides or covers words with CSS alone. */
export const HIDDEN: readonly (readonly [string, string])[] = [
  ["display:none", around('<span style="display:none">', "</span>")],
  ["visibility:hidden", around('<span style="visibility:hidden">', "</span>")],
  ["opacity:0", around('<span style="opacity:0">', "</span>")],
  ["font-size:0", around('<span style="font-size:0">', "</span>")],
  ["color:transparent", around('<span style="color:transparent">', "</span>")],
  ["color equal to the background (#fff on #fff)", around('<span style="color:#fff;background:#fff">', "</span>")],
  ["color equal to the background (the page's card on the card)", around('<span style="color:var(--card)">', "</span>")],
  ["text-indent:-9999px", around('<span style="display:block;text-indent:-9999px">', "</span>")],
  ["position:absolute; left:-9999px", around('<span style="position:absolute;left:-9999px">', "</span>")],
  ["clip-path:inset(100%)", around('<span style="clip-path:inset(100%)">', "</span>")],
  ["transform:scale(0)", around('<span style="display:inline-block;transform:scale(0)">', "</span>")],
  ["max-height:0; overflow:hidden", around('<span style="display:block;max-height:0;overflow:hidden">', "</span>")],
  ["width:0; overflow:hidden", around('<span style="display:inline-block;width:0;overflow:hidden;white-space:nowrap;vertical-align:top">', "</span>")],
  ["line-height:0; overflow:hidden", around('<span style="display:block;line-height:0;overflow:hidden">', "</span>")],
  ["a closed <details>", `<p>Before these words</p><details><summary>More</summary><p>${SECRET}</p></details><p>after these words.</p>`],
  ["an opaque element positioned over it", around('<span style="position:relative">', '<span style="position:absolute;inset:-2px;background:var(--card)"></span></span>')],
  ["an opaque element over it that lets the pointer through", around('<span style="position:relative">', '<span style="position:absolute;inset:-2px;background:var(--card);pointer-events:none"></span></span>')],
  ["a stylesheet rule with :not()", around('<span class="s">', "</span>", "<style>#row span:not(.keep){opacity:0}</style>")],
  ["a stylesheet rule with a sibling selector", around('<i class="m"></i><span>', "</span>", "<style>i.m + span{color:transparent}</style>")],
  ["a stylesheet rule with an attribute selector", around('<span data-k="secret">', "</span>", '<style>[data-k^="sec"]{font-size:0}</style>')],
  ["a stylesheet rule in @media all", around('<span class="mq">', "</span>", "<style>@media all{.mq{position:absolute;left:-9999px}}</style>")],
];

/** A show-me style figure: an SVG drawn with the page's colours, its label in it, and a caption. */
const FIGURE = `<figure><svg viewBox="0 0 320 80" width="320" height="80" role="img" aria-label="The saved calls store"><rect x="2" y="2" width="200" height="60" rx="6" fill="var(--accent-soft)" stroke="var(--accent)"/><text x="16" y="38" fill="var(--text)" font-size="15">Saved calls store</text><path d="M204 32h100" stroke="var(--text)"/></svg><figcaption>The store every rerun reads.</figcaption></figure>`;

/** Visible words that must still be quoted: in a table, a code block, a list, a figure. */
export const SEEN: readonly (readonly [string, string])[] = [
  ["a table cell", "lakeFS (not R2 alone)"],
  ["a code block", "bench run --cached"],
  ["a list item", "a new database beside the ones"],
  ["a show-me SVG figure's label", "Saved calls store"],
  ["a figure's caption", "The store every rerun reads."],
];

export const SEEN_BODY = D30_BODY + "<pre><code>bench run --cached --suite smoke</code></pre>" + FIGURE;

let browser: Browser;

let template = "";

const cleanups: (() => void)[] = [];

/** The browser and the built template for a file's tests, launched before them and closed after. */
export function useVisibilityBrowser(): void {
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

/** perf's page on D30, its body `body`, recording the frame's selection messages on the page; the page and the frame. */
export async function openD30(body: string, dark = false): Promise<{ readonly page: Page; readonly frame: Frame; readonly harness: Harness }> {
  const harness = serveHarness({ template, view: marksView(NOW), messages: coordinatorChat(NOW), bodies: { d30: body } });
  const context = await browser.createBrowserContext();
  cleanups.push(() => {
    void context.close().catch(() => undefined);
    harness.stop();
  });
  const page = await context.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => {
    addEventListener("message", (e: MessageEvent<{ fleetSelect?: boolean } | null>) => {
      if (e.data && e.data.fleetSelect === true) document.documentElement.dataset["told"] = JSON.stringify(e.data);
    });
  });
  await page.goto(new URL(harness.url).origin + "/f/perf/#decision/d30", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");
  await page.waitForSelector("#mk-rail");
  const toggle = await page.waitForSelector(".dv-fold-toggle", { timeout: 1500 }).catch(() => null);

  if (toggle && (await page.$(".dv-fold.folded"))) await toggle.click();
  const frame = await (await page.$("#dv-frame iframe"))?.contentFrame();

  if (!frame) throw new Error("no body frame");
  await frame.waitForFunction(() => document.body?.textContent?.includes("The idea") === true);
  await page.waitForFunction(() => (document.querySelector("#dv-frame iframe")?.getBoundingClientRect().height ?? 0) > 300);
  await sleep(400);

  return { page, frame, harness };
}

/** Select in the frame from the start of `from` to the end of `to`, as a drag would: the words may run over
 * several text nodes (a reference in them is a link of its own, refframe.ts). */
async function selectIn(f: Frame, from: string, to = from): Promise<void> {
  await f.evaluate(
    (a: string, b: string) => {
      const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes: TextAt[] = [];
      let all = "";

      for (let n = it.nextNode(); n; n = it.nextNode()) {
        if (!(n instanceof Text) || /^(STYLE|SCRIPT)$/u.test(n.parentNode?.nodeName ?? "")) continue;
        nodes.push({ n, i: all.length });
        all += n.data;
      }

      /* The node and offset of place `at` of the body's words: `end` takes the node the words end in, not the next one's start. */
      const place = (at: number, end: boolean): TextAt => {
        const hit = nodes.findLast((x) => (end ? x.i < at : x.i <= at));

        if (!hit) throw new Error("no text at " + String(at));

        return { n: hit.n, i: at - hit.i };
      };

      const find = (w: string): number => {
        const i = all.indexOf(w);

        if (i < 0) throw new Error("not found: " + w);

        return i;
      };

      const x = place(find(a), false);
      const y = place(find(b) + b.length, true);
      const r = document.createRange();
      r.setStart(x.n, x.i);
      r.setEnd(y.n, y.i);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
    },
    from,
    to,
  );
}

/** Where words are: a text node and an offset (in it, or of its start in the body's words). */
interface TextAt {
  readonly n: Text;
  readonly i: number;
}

/** What the frame last told the page of its selection. */
export interface Told {
  readonly text?: string;
  readonly refused?: string;
  readonly anchor?: { readonly blocks?: readonly { readonly exact?: string }[] } | null;
}

/** Clear the frame's selection and what it told, then select `from`…`to` and wait for the frame to tell of it. */
export async function tell(page: Page, f: Frame, from: string, to = from): Promise<Told> {
  await f.evaluate(() => getSelection()?.removeAllRanges());
  await sleep(350);
  await page.evaluate(() => void delete document.documentElement.dataset["told"]);
  await selectIn(f, from, to);
  await page.waitForFunction(() => document.documentElement.dataset["told"] !== undefined, { timeout: 3000 });
  await sleep(300);

  const told = await page.evaluate(() => document.documentElement.dataset["told"] ?? "{}");

  // SAFETY: the page keeps the frame's own fleetSelect message as the JSON it was; every field read is optional.
  return JSON.parse(told) as Told;
}

/** Whether `s` holds any of the hidden words. */
export const leaks = (s: string): boolean => /approves|without|changes/u.test(s);

/** The words the frame offered as a selection: its text and its blocks. */
export const offered = (t: Told): string => (t.text ?? "") + " " + (t.anchor?.blocks ?? []).map((b) => b.exact ?? "").join(" ");

/** The quote the composer takes for the selection the bar shows, or "" when the bar offers no mark (with the bar's note). */
export async function quoteOf(page: Page): Promise<{ readonly quote: string; readonly note: string; readonly problem: string }> {
  const bar = await page.waitForSelector("#seltool:not([hidden])", { timeout: 3000 }).catch(() => null);

  if (!bar) return { quote: "", note: "", problem: "" };
  const note = await page.$eval("#seltool", (e) => e.querySelector(".seltool-note")?.textContent ?? "");

  if (!(await page.$("#seltool .seltool-marks"))) return { quote: "", note, problem: "" };
  await page.$eval('#seltool [data-mark="comment"]', (e) => e.scrollIntoView({ block: "center" }));
  await page.click('#seltool [data-mark="comment"]');
  await page.waitForSelector("#mk-composer:not([hidden])");
  const quote = await page.$eval("#mk-quote", (e) => e.textContent ?? "");
  const problem = await page.$eval("#mk-composer .mk-problem", (e) => e.textContent ?? "");
  await page.click("#mk-cancel");
  await page.waitForSelector("#mk-composer[hidden]");
  await sleep(200);

  return { quote, note, problem };
}

/** Each of `rows` (a name and the body's added HTML): what the frame offered and what was quoted of the hidden words; both empty when every row held. */
export async function hiddenRows(rows: readonly (readonly [string, string])[]): Promise<{ readonly live: string[]; readonly quoted: string[] }> {
  const live: string[] = [];
  const quoted: string[] = [];

  for (const [name, html] of rows) {
    const { page, frame } = await openD30(D30_BODY + html);

    /* The hidden words alone: the frame refuses them, with why; the bar says so and offers no mark. */
    const alone = await tell(page, frame, SECRET);

    if (leaks(offered(alone)) || (alone.text === "" && !alone.refused && alone.anchor)) live.push(`${name}: alone, the frame offered ${JSON.stringify(offered(alone).trim())}`);
    else if (!alone.refused && (alone.text ?? "") === "" && (alone.anchor?.blocks ?? []).length === 0) live.push(`${name}: alone, the frame told no reason`);
    const one = await quoteOf(page);

    if (leaks(one.quote)) quoted.push(`${name}: alone, quoted ${JSON.stringify(one.quote)}`);

    if (alone.refused && !one.note) quoted.push(`${name}: alone, the bar gave no reason`);

    /* Across them: the frame keeps the words around them; the quote never holds them. */
    const across = await tell(page, frame, "Before these words", "after these words.");

    if (leaks(offered(across))) live.push(`${name}: across, the frame offered ${JSON.stringify(offered(across).trim())}`);
    const two = await quoteOf(page);

    if (leaks(two.quote)) quoted.push(`${name}: across, quoted ${JSON.stringify(two.quote)}`);
    await page.close();
  }

  return { live, quoted };
}
