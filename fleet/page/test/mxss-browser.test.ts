/**
 * Mutation-XSS shapes (content-policy-kit.ts's MXSS: the review's, and DOMPurify's own past bypasses that apply to
 * a body) in a fleet's page, in headless Chromium: none navigates the frame, and none survives into it as an
 * element, handler, `javascript:` address or link the sanitiser forbids. Skipped when no Chromium is found
 * (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { expect, test } from "bun:test";

import { bodyFrame, eachRow, found, MXSS, usePolicyBrowser } from "./content-policy-kit.ts";

usePolicyBrowser();

test.skipIf(!found)("mutation XSS: in a fleet's page no shape navigates the frame or survives into it", async () => {
  const failed = await eachRow(
    async (page, hub) => {
      const url = `${hub.origin}/f/perf/#decision/d30`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");

      return { url, frame: await bodyFrame(page), height: null };
    },
    MXSS.map(([name, html]) => ({ name, html })),
  );

  expect(failed).toEqual([]);
}, 180_000);
