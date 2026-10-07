/**
 * Screenshots of the page from the fixtures, in headless Chromium: a manager's page and a coordinator's,
 * at 390×900 and 1280×900, light and dark, for comparing two templates by eye.
 *
 *     bun test/screens.ts TEMPLATE OUT_DIR [--chromium PATH] [--extra | --chat | --code | --scopes]
 *
 * `--extra` adds the open notifications panel, the chat overlay on a phone and a decision's page.
 * `--chat` shoots only the chat, on the conversation of `chatConversation` (the overlay on a phone, the
 * docked panel at 1280), at its end and scrolled to its start, with decision activity left out and shown,
 * and D18's page with its thread. `--code` shoots code blocks and the selection toolbar on `codeView`:
 * A2 (Luiz's Modal clean-up, prose and a nu block), A3 (an old one-command `--manual`), a chat message
 * with a block, and a selection with its toolbar, in a decision's text and in the chat. `--scopes` shoots
 * the manager's decision lists on `managerScopesView`, every agent's and then infra's alone.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Page } from "puppeteer-core";

import { chatConversation, chatView, codeChat, codeView, coordinatorChat, coordinatorView, managerChat, managerScopesView, managerView } from "./fixtures.ts";
import { serveHarness } from "./harness.ts";

const [templatePath, out] = process.argv.slice(2);

const chromiumAt = process.argv.indexOf("--chromium");

const executablePath = chromiumAt > 0 ? (process.argv[chromiumAt + 1] ?? "") : "/run/current-system/sw/bin/chromium";

if (!templatePath || !out) {
  console.error("usage: bun test/screens.ts TEMPLATE OUT_DIR [--chromium PATH] [--extra]");
  process.exit(2);
}

mkdirSync(out, { recursive: true });

const template = readFileSync(templatePath, "utf8");

const now = Date.parse("2026-10-01T12:00:00Z");

const skills = [
  { name: "tstack:tdd", description: "Test-first development and choosing the right evidence.", hint: "[what to build or fix]", source: "plugin" },
  { name: "tstack:research", description: "Investigate a question against primary sources.", hint: "<question>", source: "plugin" },
  { name: "deploy", description: "Deploy the site.", hint: "", source: "project" },
];

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--hide-scrollbars", "--font-render-hinting=none"] });

async function shoot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: join(out ?? ".", name + ".png") });
}

/** The chat alone: its end, then its start, at both widths and in both themes. */
async function shootChat(): Promise<void> {
  const harness = serveHarness({ template, view: chatView(now), messages: chatConversation(now), skills });

  for (const [w, h] of [
    [390, 844],
    [1280, 900],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, isMobile: w < 500, hasTouch: w < 500 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }]);
      await page.evaluateOnNewDocument((t: number) => {
        Date.now = () => t;
      }, now);
      await page.goto(harness.url, { waitUntil: "networkidle2" });
      await page.waitForFunction(() => document.querySelector(`#chat-log article[data-id="13"]`) !== null);

      if (w < 500) await page.click("#chat-toggle");
      await page.evaluate(() => {
        const log = document.querySelector("#chat-log");

        if (log) log.scrollTop = log.scrollHeight;
      });
      await shoot(page, `chat-${w}-${theme}`);
      await page.evaluate(() => {
        const log = document.querySelector("#chat-log");

        if (log) log.scrollTop = 0;
      });
      await shoot(page, `chat-${w}-${theme}-top`);

      /* Decision activity shown, as markers (the new page); the old page has no switch. */
      if (await page.$("#chat-decisions")) {
        await page.click("#chat-decisions");
        await page.mouse.move(1, 1);
        await page.evaluate(() => document.querySelector("#chat-log .dmark")?.scrollIntoView({ block: "center" }));
        await shoot(page, `chat-${w}-${theme}-activity`);
        await page.click("#chat-decisions");
        await page.mouse.move(1, 1);
      }

      await page.goto(harness.url + "#decision/d18", { waitUntil: "networkidle2" });
      await page.evaluate(() => document.querySelector("#dv-thread, #dv-answer")?.scrollIntoView({ block: "center" }));
      await shoot(page, `chat-${w}-${theme}-decision`);
      await page.close();
    }
  }

  harness.stop();
}

/** Select the text of `selector` as a finger or a mouse would, and wait for the toolbar. */
async function select(page: Page, selector: string, touch: boolean): Promise<void> {
  await page.evaluate(
    (sel: string, t: boolean) => {
      const el = document.querySelector(sel);
      el?.scrollIntoView({ block: "center" });
      const range = document.createRange();

      if (el) range.selectNodeContents(el);
      const opts = { bubbles: true, pointerType: t ? "touch" : "mouse", button: 0, isPrimary: true };
      el?.dispatchEvent(new PointerEvent("pointerdown", opts));
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      el?.dispatchEvent(new PointerEvent("pointerup", opts));
    },
    selector,
    touch,
  );
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#seltool")?.hidden === false);
}

/** Code blocks and the selection toolbar, at both widths and in both themes. */
async function shootCode(): Promise<void> {
  const harness = serveHarness({ template, view: codeView(now), messages: codeChat(now), skills });

  for (const [w, h] of [
    [390, 844],
    [1280, 900],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      const phone = w < 500;
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }]);
      await page.evaluateOnNewDocument((t: number) => {
        Date.now = () => t;
      }, now);

      for (const [id, name] of [
        ["a8", "modal"],
        ["a9", "legacy"],
      ] as const) {
        await page.goto(harness.url + "#decision/" + id, { waitUntil: "networkidle2" });
        await page.evaluate(() => document.querySelector("#dv-answer .dv-block")?.scrollIntoView({ block: "center" }));
        await shoot(page, `code-${w}-${theme}-${name}`);
      }

      await page.goto(harness.url + "#decision/a8", { waitUntil: "networkidle2" });
      await select(page, "#dv-answer .manual-rich > p", phone);
      await shoot(page, `sel-${w}-${theme}-decision`);
      await page.evaluate(() => getSelection()?.removeAllRanges());

      if (phone) await page.click("#chat-toggle");
      await page.evaluate(() => {
        const log = document.querySelector("#chat-log");

        if (log) log.scrollTop = log.scrollHeight;
      });
      await shoot(page, `code-${w}-${theme}-chat`);
      await select(page, '#chat-log article[data-id="4"] .msg-text p', phone);
      await shoot(page, `sel-${w}-${theme}-chat`);
      await page.close();
    }
  }

  harness.stop();
}

if (process.argv.includes("--code")) {
  await shootCode();
  await browser.close();
  console.log(`screenshots in ${out}`);
  process.exit(0);
}

/** The manager's quick filter by agent: the decision lists for every agent, then infra's chip pressed. */
async function shootScopes(): Promise<void> {
  const harness = serveHarness({ template, view: managerScopesView(now), messages: managerChat(now), skills });

  for (const [w, h] of [
    [390, 900],
    [1280, 900],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, isMobile: w < 500, hasTouch: w < 500 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }]);
      await page.evaluateOnNewDocument((t: number) => {
        Date.now = () => t;
        localStorage.clear();
      }, now);
      await page.goto(harness.url, { waitUntil: "networkidle2" });
      await page.waitForSelector("#decision-scope");
      await page.evaluate(() => document.querySelector("#decision-seg")?.scrollIntoView({ block: "start" }));
      await shoot(page, `scopes-${w}-${theme}-all`);
      const infra = await page.$$("#decision-scope button");
      await infra[2]?.click();
      await page.evaluate(() => document.querySelector("#decision-seg")?.scrollIntoView({ block: "start" }));
      await shoot(page, `scopes-${w}-${theme}-infra`);
      await page.close();
    }
  }

  harness.stop();
}

if (process.argv.includes("--scopes")) {
  await shootScopes();
  await browser.close();
  console.log(`screenshots in ${out}`);
  process.exit(0);
}

if (process.argv.includes("--chat")) {
  await shootChat();
  await browser.close();
  console.log(`screenshots in ${out}`);
  process.exit(0);
}

for (const role of ["coordinator", "manager"] as const) {
  const harness = serveHarness({
    template,
    view: role === "manager" ? managerView(now) : coordinatorView(now),
    messages: role === "manager" ? managerChat(now) : coordinatorChat(now),
    skills,
  });

  for (const [w, h] of [
    [390, 900],
    [1280, 900],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: w < 500, hasTouch: w < 500 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }]);
      await page.evaluateOnNewDocument((t: number) => {
        Date.now = () => t;
      }, now);
      await page.goto(harness.url, { waitUntil: "networkidle2" });
      await shoot(page, `${role}-${w}-${theme}`);

      if (process.argv.includes("--extra")) {
        await page.click("#bell");
        await shoot(page, `${role}-${w}-${theme}-panel`);

        /* The settings behind the gear (the new page); the old page has none. */
        if (await page.$("#n-gear")) {
          await page.click("#n-gear");
          await shoot(page, `${role}-${w}-${theme}-panel-settings`);
          await page.click("#n-gear");
        }

        await page.click("#bell");

        for (const view of ["plan", "fleet", "links", "log"]) {
          await page.goto(harness.url + "#" + view, { waitUntil: "networkidle2" });
          await shoot(page, `${role}-${w}-${theme}-${view}`);
        }

        await page.goto(harness.url, { waitUntil: "networkidle2" });

        if (w < 500) {
          await page.click("#chat-toggle");
          await shoot(page, `${role}-${w}-${theme}-chat`);
          await page.goBack();
        }

        if (role === "coordinator") {
          await page.goto(harness.url + "#decision/d1", { waitUntil: "networkidle2" });
          await shoot(page, `${role}-${w}-${theme}-decision`);
        }
      }

      await page.close();
    }
  }

  harness.stop();
}

await browser.close();

console.log(`screenshots in ${out}`);
