/**
 * The content policy's rows (content-policy-kit.ts) on the manager's page, inside the fleet's frame: none runs or
 * navigates, the frame holds nothing the sanitiser forbids, and the fleet's scripts (sizing, the selection bar,
 * the marks) work. Skipped when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { expect, test } from "bun:test";

import { bodyFrame, eachRow, found, usePolicyBrowser } from "./content-policy-kit.ts";

usePolicyBrowser();

test.skipIf(!found)("on the manager's page, inside the fleet's frame: no row runs or navigates, and the fleet's scripts work", async () => {
  const failed = await eachRow(async (page, hub) => {
    const url = `${hub.origin}/f/manager/#decision/perf/d30`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");
    const frame = await bodyFrame(page);
    await page.waitForSelector("#mk-rail");

    return { url, frame, height: () => page.$eval("#dv-embed", (e) => e.getBoundingClientRect().height) };
  });

  expect(failed).toEqual([]);
}, 120_000);
