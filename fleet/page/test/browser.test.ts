/**
 * The built template in a real browser (headless Chromium over CDP), fed by a real event stream: a
 * `state` event that changes one worker leaves a marked row node, the window's scroll, the chat's
 * scroll, an open sheet, the switcher and a typed draft as they were, and a `chat` event appends one
 * message. Every field that writes to the session (the composer, a decision's note, a grilling's own
 * answer) opens its list of skills on "/", typed with real keys; the fields whose text is data or a
 * search do not. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { agentsOf, coordinatorChat, coordinatorView, type View } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

declare global {
  /** What the tests leave on the page's window, to compare after an update. */
  interface Window {
    kept: Element | null;
    sel: HTMLSelectElement | null;
    first: Element | null;
  }
}

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

const SKILLS = [
  { name: "tstack:tdd", description: "Test-first development.", hint: "[what to fix]", source: "plugin" },
  { name: "tstack:research", description: "Investigate a question.", hint: "<question>", source: "plugin" },
  { name: "deploy", description: "Deploy the site.", hint: "", source: "project" },
];

let browser: Browser;

let harness: Harness;

let page: Page;

beforeAll(async () => {
  if (!found) return;
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: coordinatorView(NOW), messages: coordinatorChat(NOW), skills: SKILLS });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 700 });
  await page.goto(harness.url + "#fleet", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live" && document.querySelectorAll("#chat-log article.msg").length === 5);
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

/** The view with worker `id` changed by `change`. */
function changed(id: string, change: (a: View) => View): View {
  const view = coordinatorView(NOW);

  return { ...view, agents: agentsOf(view).map((a) => (a["id"] === id ? change(a) : a)) };
}

test.skipIf(!found)("a state event over the stream updates one row in place and keeps the viewer's place", async () => {
  await page.evaluate(() => {
    window.kept = document.querySelector("#agent-a1");
    document.querySelector("#agent-a1")?.setAttribute("data-marked", "yes");
    window.sel = document.querySelector("#switch select");
    window.scrollTo(0, 300);
    const log = document.querySelector("#chat-log");

    if (log) log.scrollTop = 0;
    const say = document.querySelector<HTMLTextAreaElement>("#say");
    say?.focus();
  });
  await page.keyboard.type("a draft in flight");
  const before = await page.evaluate(() => ({ y: window.scrollY, sel: document.querySelector<HTMLSelectElement>("#switch select")?.value }));

  harness.setView(changed("a2", (a) => ({ ...a, tokens: 777_000 })));
  await page.waitForFunction(() => document.querySelector("#agent-a2 .c-tokens")?.textContent === "777,000");

  const after = await page.evaluate(() => {
    return {
      same: window.kept === document.querySelector("#agent-a1"),
      marked: document.querySelector("#agent-a1")?.getAttribute("data-marked"),
      y: window.scrollY,
      chatTop: document.querySelector("#chat-log")?.scrollTop,
      sel: document.querySelector<HTMLSelectElement>("#switch select")?.value,
      sameSelect: window.sel === document.querySelector("#switch select"),
      draft: document.querySelector<HTMLTextAreaElement>("#say")?.value,
      focused: document.activeElement?.id,
    };
  });

  expect(after).toEqual({ same: true, marked: "yes", y: before.y, chatTop: 0, sel: before.sel, sameSelect: true, draft: "a draft in flight", focused: "say" });
});

test.skipIf(!found)("an open worker sheet stays open through a state event", async () => {
  await page.click("#agent-a3 .who");
  await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("#worker")?.open === true);
  harness.setView(changed("a3", (a) => ({ ...a, status: "running" })));
  await page.waitForFunction(() => document.querySelector("#worker .sheet-head .pill")?.textContent === "running");
  expect(await page.evaluate(() => document.querySelector<HTMLDialogElement>("#worker")?.open)).toBe(true);
  await page.keyboard.press("Escape");
});

test.skipIf(!found)("a chat event appends one message and leaves the others' nodes", async () => {
  await page.evaluate(() => {
    window.first = document.querySelector("#chat-log article.msg");
  });
  harness.say({ id: 6, at: new Date(NOW).toISOString(), from: "a3", to: ["user"], text: "Found the key." });
  await page.waitForFunction(() => document.querySelectorAll("#chat-log article.msg").length === 6);
  expect(await page.evaluate(() => window.first === document.querySelector("#chat-log article.msg"))).toBe(true);
});

/** The open lists under a caret, with where each sits against the focused field. */
async function shown(): Promise<{ id: string; names: string[]; selected: string; below: boolean; above: boolean; expanded: string | null | undefined }[]> {
  return page.evaluate(() => {
    const field = document.activeElement;
    const box = field?.getBoundingClientRect();

    return [...document.querySelectorAll<HTMLElement>('ul.mentions[role="listbox"]')].flatMap((l) => {
      if (l.hidden || l.getClientRects().length === 0) return [];
      const r = l.getBoundingClientRect();

      return [
        {
          id: l.id,
          names: [...l.querySelectorAll(".m-name")].map((n) => n.textContent ?? ""),
          selected: l.querySelector('[aria-selected="true"] .m-name')?.textContent ?? "",
          below: box !== undefined && r.top >= box.bottom - 1,
          above: box !== undefined && r.bottom <= box.top + 1,
          expanded: field?.getAttribute("aria-expanded"),
        },
      ];
    });
  });
}

/** Focus `selector` on the page at `hash`, emptied. */
async function focusField(hash: string, selector: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await page.waitForSelector(selector, { visible: true });
  await page.evaluate((sel) => {
    const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(sel);

    if (!el) return;
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
  }, selector);
}

const value = (selector: string): Promise<string> => page.evaluate((sel) => document.querySelector<HTMLTextAreaElement>(sel)?.value ?? "", selector);

const IN_SCOPE = [
  { name: "the chat's composer", hash: "#fleet", field: "#say", list: "mentions", side: "above" },
  { name: "a decision's note", hash: "#decision/d1", field: '#dv-answer textarea[name="note"]', list: "dv-note-skills", side: "below" },
  { name: "a grilling's own answer", hash: "#decision/g1", field: '#dv-answer textarea[name="q1-text"]', list: "dv-skills-q1", side: "below" },
] as const;

for (const f of IN_SCOPE) {
  test.skipIf(!found)(`${f.name}: "/" opens its list, typing narrows it, arrows and Enter or Tab pick into the field, Escape closes`, async () => {
    await focusField(f.hash, f.field);
    await page.keyboard.type("/");
    await page.waitForFunction((id) => document.querySelectorAll(`#${id} li`).length === 3, {}, f.list);
    let lists = await shown();
    expect(lists.map((l) => l.id)).toEqual([f.list]);
    expect(lists[0]?.[f.side]).toBe(true);
    expect(lists[0]?.expanded).toBe("true");

    await page.keyboard.type("tst");
    lists = await shown();
    expect(lists[0]?.names).toEqual(["tstack:tdd", "tstack:research"]);
    await page.keyboard.press("ArrowDown");
    expect((await shown())[0]?.selected).toBe("tstack:research");
    await page.keyboard.press("Enter");
    expect(await value(f.field)).toBe("/tstack:research ");
    expect(await shown()).toEqual([]);

    await focusField(f.hash, f.field);
    await page.keyboard.type("/dep");
    await page.keyboard.press("Tab");
    expect(await value(f.field)).toBe("/deploy ");
    expect(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), f.field)).toBe(true);

    await focusField(f.hash, f.field);
    await page.keyboard.type("/t");
    expect((await shown()).map((l) => l.id)).toEqual([f.list]);
    await page.keyboard.press("Escape");
    expect(await shown()).toEqual([]);
    expect(await value(f.field)).toBe("/t");
    await focusField(f.hash, f.field);
  });
}

for (const f of IN_SCOPE) {
  test.skipIf(!found)(`${f.name}: a "/" that starts a word mid-text opens the list, and a pick replaces only that word; "a/b" opens nothing`, async () => {
    await focusField(f.hash, f.field);
    await page.keyboard.type("please run /tst");
    await page.waitForFunction((id) => document.querySelectorAll(`#${id} li`).length === 2, {}, f.list);
    const lists = await shown();
    expect(lists.map((l) => l.id)).toEqual([f.list]);
    expect(lists[0]?.[f.side]).toBe(true);
    await page.keyboard.press("Enter");
    expect(await value(f.field)).toBe("please run /tstack:tdd ");
    expect(await shown()).toEqual([]);

    await focusField(f.hash, f.field);
    await page.keyboard.type("see a/tst and https://x/tst");
    expect(await shown()).toEqual([]);
    await focusField(f.hash, f.field);
  });
}

test.skipIf(!found)("the fields whose text is data or a search open no list on /", async () => {
  for (const [hash, selector] of [
    ["#decision/i1", '#dv-answer textarea[name="value"]'],
    ["#decision/s1", '#dv-answer input[name="value"]'],
    ["#fleet", "#f-q"],
  ] as const) {
    await focusField(hash, selector);
    await page.keyboard.type("/t");
    expect(await shown()).toEqual([]);
    await focusField(hash, selector);
  }

  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("#finder")?.open === true);
  await page.keyboard.type("/t");
  expect(await shown()).toEqual([]);
  await page.keyboard.press("Escape");
});
