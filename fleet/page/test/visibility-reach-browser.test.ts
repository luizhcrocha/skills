/**
 * Only words Luiz can see make a mark's quote, continued (visibility-browser.test.ts has the first half of the
 * hiding table): the second half of the CSS-only ways to hide or cover words, refused; and words Luiz reaches
 * by scrolling a code block or a wide table sideways, wherever it is scrolled, and a show-me figure's white label
 * on its navy box, quoted in the light and the dark theme. Skipped when no Chromium is found (FLEET_CHROMIUM, or
 * chromium on the PATH).
 */
import { expect, test } from "bun:test";

import { D30_BODY } from "./marks-fixtures.ts";
import { found, HIDDEN, hiddenRows, openD30, quoteOf, tell, useVisibilityBrowser } from "./visibility-kit.ts";

useVisibilityBrowser();

test.skipIf(!found)("hidden or covered words (the second half of the table): the frame refuses them alone and drops them from a selection across them; no quote holds them", async () => {
  expect(await hiddenRows(HIDDEN.slice(11))).toEqual({ live: [], quoted: [] });
}, 300_000);

/** A code block and a wide table that scroll sideways, and a show-me figure's white label on its navy box. */
const REACH_BODY =
  D30_BODY +
  `<pre><code>short line here\n${"x".repeat(300)} tailword</code></pre>` +
  `<table id="wide"><tr>${Array.from({ length: 14 }, (_, i) => `<td>col ${String(i)} text</td>`).join("")}<td>farcell words</td></tr></table>` +
  `<figure><svg viewBox="0 0 320 80" width="320" height="80"><rect x="2" y="2" width="300" height="60" rx="6" fill="#1e3a5f"/><text x="16" y="38" fill="#ffffff" font-size="15">White label on navy box</text></svg></figure>`;

/** Words Luiz reaches by scrolling a code block or a table sideways, wherever it is scrolled, and the label: each with where its scrollers are scrolled to (0, or their far end). */
const REACHED: readonly (readonly [string, string, number])[] = [
  ["a code block's first words, scrolled to its end", "short line here", 99999],
  ["a code block's tail past the page's width", "tailword", 0],
  ["a wide table's far cell past the page's width", "farcell words", 0],
  ["a wide table's first cell, scrolled to its end", "col 0 text", 99999],
  ["a white SVG label on its navy box", "White label on navy box", 0],
];

for (const dark of [false, true]) {
  test.skipIf(!found)(`words in a sideways scroller's scroll area, and a white label on a navy shape, are quoted (${dark ? "dark" : "light"})`, async () => {
    const { page, frame } = await openD30(REACH_BODY, dark);
    const failed: string[] = [];

    for (const [name, words, scrolled] of REACHED) {
      await frame.evaluate((x: number) => {
        for (const e of document.querySelectorAll("pre, table")) e.scrollLeft = x;
      }, scrolled);
      const told = await tell(page, frame, words);

      if (told.refused || (told.anchor?.blocks ?? []).map((b) => b.exact).join("") !== words) failed.push(`${name}: the frame told ${JSON.stringify(told)}`);
      const { quote, problem } = await quoteOf(page);

      if (quote !== words || problem) failed.push(`${name}: quoted ${JSON.stringify(quote)} (${problem})`);
    }

    expect(failed).toEqual([]);
  }, 120_000);
}
