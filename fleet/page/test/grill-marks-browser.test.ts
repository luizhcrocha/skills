/**
 * Comments on a grilling in a real browser (the built template in headless Chromium, fed by the harness, which
 * serves the Skills fleet's G30 and its context, trimmed from the real one): a grilling takes marks as a decision
 * does. Its context (the body, in the sandboxed frame: a paragraph, a list item, a table cell, a label of an SVG
 * that carries its own `<style>`), its title, and each question's own words (its title, the question, an option,
 * the option's consequence, the reason) offer the kinds of mark, keep a pending comment with its pin, and go as
 * one batch naming where each was; inside the manager's page too, to that fleet. Skipped when no Chromium is
 * found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type BrowserContext, type Frame, type Page } from "puppeteer-core";

import { coordinatorChat, coordinatorView, managerChat, managerView, type View } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

/* Each test drives a real browser through many steps: a plain `bun test` (5 s) would cut it short. */
setDefaultTimeout(60_000);

const NOW = Date.parse("2026-10-13T19:00:00Z");

/** G30's context, trimmed from the real one: a paragraph, a list, an SVG with a `<style>` of its own, a table with no `<thead>`. */
const G30_BODY = `<p>You proposed three changes to fleet, to go with the new <b>fleet work</b> list.</p>
<ol>
  <li>Every repo is a workspace, so there can be several fleets.</li>
  <li>Agents stop using the command line directly and use a "code mode".</li>
</ol>
<h3>Today and what you propose</h3>
<svg viewBox="0 0 640 100" role="img" aria-label="Today each fleet session keeps its own record file." style="max-width:100%;height:auto;font:12px sans-serif">
  <style>
    .b{fill:none;stroke:currentColor;stroke-width:1.2;rx:6}
    .t{fill:currentColor}
    .m{fill:currentColor;opacity:.7}
  </style>
  <text x="10" y="16" class="t" font-weight="700">Today</text>
  <rect x="10" y="26" width="130" height="40" class="b"/><text x="20" y="43" class="t">Fleet session</text><text x="20" y="58" class="m">runs commands</text>
  <rect x="180" y="26" width="150" height="40" class="b"/><text x="190" y="43" class="t">Its own record file</text><text x="190" y="58" class="m">in a temporary folder</text>
</svg>
<h3>Facts found since the round opened</h3>
<table>
  <tr><th>Question</th><th>What was found</th><th>What it means here</th></tr>
  <tr><td>Why Infra left D1</td><td>From São Paulo a write took 19 ms on Neon and 131 ms on D1.</td><td>This weighs on Q3.</td></tr>
  <tr><td>Size of a rewrite</td><td>fleet is 29,000 lines of code.</td><td>This weighs on Q5.</td></tr>
</table>`;

/** G30 as the Skills fleet's ledger keeps it: a grilling with a context, revised once, two questions asked with options. */
const G30: View = {
  id: "fleet-rearch",
  ref: "G30",
  kind: "grill",
  title: "Re-architect fleet: workspaces, code mode and one database",
  question: "2 questions to answer",
  why: null,
  status: "open",
  blocking: false,
  asks: "user",
  opened: "2026-10-13T18:27:35Z",
  revised: "2026-10-13T18:35:20Z",
  change: "D190 (fleet work) folded in on Luiz's word.",
  body: true,
  page: true,
  options: [],
  questions: [
    {
      id: "q1",
      title: "What the new design must fix first",
      body: "Which one problem must the new design solve, if it could solve only one?",
      recommend: "a",
      reason: "Finished work was lost today because nothing counted it and records died with their session.",
      of: null,
      status: "open",
      answer: null,
      asked: "2026-10-13T18:27:35Z",
      options: [
        { id: "a", label: "Work stops being forgotten", consequence: "Every change, decision and promise is in one record that outlives a session." },
        { id: "b", label: "One view from anywhere", consequence: "You see and answer every fleet from any machine or phone." },
      ],
    },
    {
      id: "q2",
      title: "What a workspace is",
      body: "When you say every repo is a workspace, what does the workspace own?",
      recommend: "a",
      reason: "Today five fleets work in one repo and each keeps its own record.",
      of: null,
      status: "open",
      answer: null,
      asked: "2026-10-13T18:27:35Z",
      options: [
        { id: "a", label: "The repo's one shared record", consequence: "One list of work, decisions and landing turns per repo." },
        { id: "b", label: "Only a grouping on the page", consequence: "Fleets stay as they are; the page groups them by repo." },
      ],
    },
  ],
};

/** The Skills fleet's page with G30 open on it. */
const skillsView = (): View => ({ ...coordinatorView(NOW), named: { id: "skills", session: "Skills" }, decisions: [G30] });

/** The manager's page with the Skills fleet among its fleets and G30 open there. */
function skillsManagerView(): View {
  const view = managerView(NOW);
  const fleets = Array.isArray(view["coordinators"]) ? view["coordinators"].filter((c): c is View => c !== null && Object(c) === c && !Array.isArray(c)) : [];
  const skills: View = { ...fleets[0], id: "skills", url: "f/skills/", session: "skills", name: "skills", project: "Skills", decisions: [{ ...G30, body: undefined }], index: [] };

  return { ...view, coordinators: [...fleets, skills] };
}

let browser: Browser;

let template = "";

const open: { harness: Harness; context: BrowserContext }[] = [];

beforeAll(async () => {
  if (!found) return;
  template = readFileSync(TEMPLATE, "utf8");
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;

  for (const context of new Set(open.map((o) => o.context))) await context.close().catch(() => undefined);

  for (const o of open) o.harness.stop();

  await browser.close();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The frame the grilling's context is in, once its words are there. */
async function contextFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 80; i += 1) {
    for (const f of page.frames()) {
      if (f === page.mainFrame() || f.detached) continue;
      const ok = await f.evaluate(() => document.querySelector("#decision") === null && document.body?.textContent?.includes("Size of a rewrite") === true).catch(() => false);

      if (ok) return f;
    }

    await sleep(100);
  }

  throw new Error("no context frame");
}

/** Select `words` (in one text node) in the context's frame, as a drag leaves them. */
async function selectIn(f: Frame, words: string): Promise<void> {
  await f.evaluate((w: string) => {
    const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    for (let n = it.nextNode(); n; n = it.nextNode()) {
      const i = n instanceof Text && !n.parentElement?.closest("script, style") ? n.data.indexOf(w) : -1;

      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + w.length);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);

      return;
    }

    throw new Error("not found: " + w);
  }, words);
}

/** Select `words` in field `field` of the grilling's page in `where` (the top page, or the fleet's page framed on the manager's), as a mouse leaves them. */
async function selectField(where: Page | Frame, field: string, words: string): Promise<void> {
  const ok = await where.evaluate(
    (f: string, w: string) => {
      const el = document.querySelector(`#decision [data-field="${f}"]`);

      if (!el) return false;
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);

      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = n instanceof Text ? n.data.indexOf(w) : -1;

        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + w.length);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(r);
        el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse", isPrimary: true }));

        return true;
      }

      return false;
    },
    field,
    words,
  );

  if (!ok) throw new Error(`no “${words}” in ${field}`);
}

/** Comment on the selection the bar shows, which quotes `words`; the comment waits. */
async function comment(page: Page, words: string, text: string): Promise<void> {
  await page.waitForSelector("#seltool:not([hidden]) .seltool-marks", { timeout: 3000 });
  await page.$eval('#seltool [data-mark="comment"]', (e) => e.scrollIntoView({ block: "center" }));
  await page.click('#seltool [data-mark="comment"]');
  await page.waitForSelector("#mk-composer:not([hidden])");
  expect(await page.$eval("#mk-quote", (e) => e.textContent)).toBe(words);
  await page.type("#mk-text", text);
  await page.$eval("#mk-save", (e) => e.scrollIntoView({ block: "center" }));
  await page.click("#mk-save");
  await page.waitForSelector("#mk-composer[hidden]");
  /* The frame clears its selection and paints the mark before the next one is made. */
  await sleep(300);
}

/** Open the context all the way, when the page folded it. */
async function unfold(page: Page): Promise<void> {
  const toggle = await page.waitForSelector(".dv-fold-toggle", { timeout: 1500 }).catch(() => null);

  if (toggle && (await page.$(".dv-fold.folded"))) await toggle.click();
  await page.waitForFunction(() => document.querySelector(".dv-fold.folded") === null, { timeout: 2000 });
}

/** The quotes of the last batch of marks posted to `h`: where each was (its field, or "body"), its hint and its words. */
function quotes(h: Harness): string[] {
  const items = h.posted.findLast((p) => p.marks !== undefined)?.marks?.["items"];

  return (Array.isArray(items) ? items : []).map((i) => {
    const q = i !== null && Object(i) === i && !Array.isArray(i) ? i["quote"] : null;

    return q !== null && q !== undefined && Object(q) === q && !Array.isArray(q) ? `${String(q["field"] ?? "body")} | ${String(q["hint"])} | ${String(q["text"])}` : "no quote";
  });
}

/** The words of the grilling's context and where the frame says each is. */
const CONTEXT: readonly (readonly [string, string])[] = [
  ["three changes to fleet", "a paragraph"],
  ["Every repo is a workspace", "a list item"],
  ["Its own record file", "under “Today and what you propose” · text"],
  ["Why Infra left D1", "table “Facts found since the round opened”, row 1, column Question"],
];

/** The words of the grilling's own text, the field each is in and the field said in words. */
const FIELDS: readonly (readonly [string, string, string])[] = [
  ["title", "code mode", "the title"],
  ["q1:title", "must fix first", "Q1, the title"],
  ["q1:question", "Which one problem", "Q1, the question"],
  ["q1:option:a", "Work stops being forgotten", "Q1, option a"],
  ["q1:option:b:consequence", "any machine or phone", "Q1, option b's consequence"],
  ["q1:recommendation", "nothing counted it", "Q1, the recommendation"],
  ["q2:option:a:consequence", "landing turns", "Q2, option a's consequence"],
];

test.skipIf(!found)("a grilling takes comments as a decision does: on its context (a paragraph, a list, an SVG's label, a table cell), its title and each question's words, sent as one batch saying where each was", async () => {
  const harness = serveHarness({ template, view: skillsView(), messages: coordinatorChat(NOW), bodies: { "fleet-rearch": G30_BODY } });
  const context = await browser.createBrowserContext();
  open.push({ harness, context });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(new URL(harness.url).origin + "/f/skills/#decision/fleet-rearch", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");
  const frame = await contextFrame(page);

  /* The inbox and the paper plane are there, as on a decision. */
  await page.waitForSelector("#mk-rail", { timeout: 3000 });
  await unfold(page);

  for (const [words] of CONTEXT) {
    await selectIn(frame, words);
    await page.waitForSelector("#seltool:not([hidden]) .seltool-marks", { timeout: 3000 });
    expect(await page.$$eval("#seltool button", (bs) => bs.map((b) => b.textContent))).toEqual(["Copy", "Reply", "Side chat", "Comment", "Delete", "Replace", "Question"]);
    await comment(page, words, "On the context.");
  }

  /* A drag of the mouse over an option's words, as Luiz makes it: the bar offers the marks, and the drag picked no answer. */
  const label = await page.$eval('#decision [data-field="q1:option:a"] > span', (e) => {
    e.scrollIntoView({ block: "center" });
    const b = e.getBoundingClientRect();

    return { left: b.left, right: b.right, y: b.top + b.height / 2 };
  });

  await page.mouse.move(label.left + 2, label.y);
  await page.mouse.down();
  await page.mouse.move(label.right - 2, label.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector("#seltool:not([hidden]) .seltool-marks", { timeout: 3000 });
  expect(await page.evaluate(() => String(getSelection()))).toContain("Work stops being");
  expect(await page.$$eval('form.grill input[type="radio"]:checked', (rs) => rs.map((r) => (r instanceof HTMLInputElement ? r.value : "")))).toEqual(["later", "later"]);

  for (const [field, words] of FIELDS) {
    await selectField(page, field, words);
    await comment(page, words, "On the grilling's own words.");
  }

  /* Each waits with its pin: the context's in the frame, a field's over the page. */
  expect(await frame.$$eval("span[data-pin].st-pending", (ps) => ps.map((p) => p.getAttribute("data-pin")))).toEqual(["1", "2", "3", "4"]);
  expect((await page.$$eval("#fd-pins .fd-pin.st-pending", (ps) => ps.map((p) => p.getAttribute("data-of") ?? ""))).sort()).toEqual(FIELDS.map(([field]) => field).sort());

  await page.click("#mk-now");
  await page.waitForFunction(() => document.querySelector(".mk-badge")?.hasAttribute("hidden") === true);
  const batch = harness.posted.findLast((p) => p.marks !== undefined);
  expect(batch?.marks?.["at"]).toEqual({ hash: "#decision/fleet-rearch" });
  expect(batch?.marks?.["decision"]).toEqual({ id: "fleet-rearch", ref: "G30", title: "Re-architect fleet: workspaces, code mode and one database", revision: "2026-10-13T18:35:20Z" });
  expect(quotes(harness)).toEqual([...CONTEXT.map(([words, hint]) => `body | ${hint} | ${words}`), ...FIELDS.map(([field, words, hint]) => `${field} | ${hint} | ${words}`)]);
  expect(batch?.text).toContain("**Comment** on “Which one problem” (Q1, the question)");
  expect(errors).toEqual([]);
});

test.skipIf(!found)("on the manager's page, a fleet's grilling takes comments over its frame: on its context and on a question's words, sent to that fleet", async () => {
  const manager = serveHarness({ template, view: skillsManagerView(), messages: managerChat(NOW) });
  const fleet = serveHarness({ template, view: skillsView(), messages: coordinatorChat(NOW), bodies: { "fleet-rearch": G30_BODY } });

  const hub = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      const to = new URL(url.pathname.startsWith("/f/manager/") ? manager.url : fleet.url).origin;

      return fetch(to + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.body });
    },
  });

  const context = await browser.createBrowserContext();
  open.push({ harness: manager, context }, { harness: fleet, context });

  try {
    const top = await context.newPage();
    await top.setViewport({ width: 1280, height: 900 });
    await top.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await top.goto(`http://127.0.0.1:${String(hub.port)}/f/manager/#decision/skills/fleet-rearch`, { waitUntil: "domcontentloaded" });
    await top.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");
    const frame = await contextFrame(top);
    await top.waitForSelector("#mk-rail", { timeout: 3000 });
    const inner = top.frames().find((x) => x.url().includes("embed=1"));

    if (!inner) throw new Error("no fleet frame");
    await inner.waitForSelector('#decision [data-field="q1:question"]', { timeout: 4000 });

    await selectIn(frame, "Why Infra left D1");
    await comment(top, "Why Infra left D1", "Say which decision.");
    await selectField(inner, "q1:question", "Which one problem");
    await comment(top, "Which one problem", "Only one?");
    await inner.waitForFunction(() => document.querySelector('#fd-pins .fd-pin.st-pending[data-of="q1:question"]') !== null, { polling: 100, timeout: 4000 });

    await top.click("#mk-now");
    await top.waitForFunction(() => document.querySelector(".mk-badge")?.hasAttribute("hidden") === true);
    expect(manager.posted.at(-1)?.marks?.["at"]).toEqual({ hash: "#decision/skills/fleet-rearch" });
    expect(quotes(manager)).toEqual(["body | table “Facts found since the round opened”, row 1, column Question | Why Infra left D1", "q1:question | Q1, the question | Which one problem"]);
    expect(fleet.posted.length).toBe(0);
  } finally {
    void hub.stop(true);
  }
});
