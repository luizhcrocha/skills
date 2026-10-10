/**
 * Only words Luiz can see make a mark's quote, in headless Chromium: a table of the CSS-only ways a body can
 * hide words or cover them (in its own style, or through a stylesheet rule the static reading may not follow),
 * each placed in D30's body around visible words. Selecting the hidden words alone, the frame's script (which
 * runs alone in the frame and reads its layout) refuses them with a reason and the selection bar says so; a
 * selection across them keeps only the words around them. Each must hold for the frame's own message, and for
 * the quote the composer takes (the page's static reading of the body is the second gate). Visible words in a
 * table, a code block, a list and a show-me style SVG figure are still quoted. The table's second half, and words
 * in a scroller and on a dark shape, are visibility-reach-browser.test.ts (the helpers: visibility-kit.ts). Skipped
 * when no Chromium is found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { expect, test } from "bun:test";

import { found, HIDDEN, hiddenRows, openD30, quoteOf, SECRET, SEEN, SEEN_BODY, sleep, tell, useVisibilityBrowser } from "./visibility-kit.ts";
import { D30_BODY } from "./marks-fixtures.ts";

useVisibilityBrowser();

test.skipIf(!found)("hidden or covered words (the first half of the table): the frame refuses them alone and drops them from a selection across them; no quote holds them", async () => {
  expect(await hiddenRows(HIDDEN.slice(0, 11))).toEqual({ live: [], quoted: [] });
}, 300_000);

test.skipIf(!found)("visible words in a table, a code block, a list and a show-me SVG figure are still quoted", async () => {
  const { page, frame } = await openD30(SEEN_BODY);
  const failed: string[] = [];

  for (const [name, words] of SEEN) {
    const told = await tell(page, frame, words);

    if (told.refused || (told.anchor?.blocks ?? []).map((b) => b.exact).join("") !== words) failed.push(`${name}: the frame told ${JSON.stringify(told)}`);
    const { quote, problem } = await quoteOf(page);

    if (quote !== words || problem) failed.push(`${name}: quoted ${JSON.stringify(quote)} (${problem})`);
  }

  expect(failed).toEqual([]);
}, 120_000);

test.skipIf(!found)("words in a closed <details> are refused, and quoted once Luiz opens it", async () => {
  const { page, frame } = await openD30(D30_BODY + `<details><summary>More</summary><p>${SECRET}</p></details>`);

  expect((await tell(page, frame, SECRET)).refused).toBe("closed");
  expect((await quoteOf(page)).note).toContain("closed section");
  await frame.click("summary");
  await sleep(300);
  expect((await tell(page, frame, SECRET)).refused).toBeUndefined();
  expect((await quoteOf(page)).quote).toBe(SECRET);
}, 60_000);
