/**
 * Screenshots of the page from the fixtures, in headless Chromium: a manager's page and a coordinator's,
 * at 390×900 and 1280×900, light and dark, for comparing two templates by eye.
 *
 *     bun test/screens.ts TEMPLATE OUT_DIR [--chromium PATH] [--extra]
 *
 * `--extra` adds the open notifications panel, the chat overlay on a phone and a decision's page.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Page } from "puppeteer-core";

import { coordinatorChat, coordinatorView, managerChat, managerView } from "./fixtures.ts";
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
