/**
 * The page's own reading of a decision's body (src/bodytext.ts): a selection the frame claims is confirmed
 * only where its words occur with the text the frame says is around them, and the quote, its cells and its
 * place are read from the page's parse, never taken from the frame.
 */
import { expect, test } from "bun:test";

import { readBody } from "../src/bodytext.ts";
import { parseClaim, type Claimed } from "../src/marks.ts";
import { D30_BODY } from "./marks-fixtures.ts";

/** The frame's document as the page builds it: the body between the page's own head and scripts. */
const DOC = `<!doctype html><html><head><style>p{}</style></head><body>${D30_BODY}\n<script>parent.postMessage({fleetEvidence:true},"*")</script></body></html>`;

const body = readBody(DOC);

/** A block as the frame cuts it from the text it shows: the words and 32 characters on each side. */
function cut(exact: string, text = body.text): Claimed {
  const at = text.indexOf(exact);

  if (at < 0) throw new Error("not in the body: " + exact);

  return { exact, prefix: text.slice(Math.max(0, at - 32), at), suffix: text.slice(at + exact.length, at + exact.length + 32) };
}

test("the body's text is its text nodes, scripts and styles left out", () => {
  expect(body.text).toContain("Every model call is saved, so a rerun is free");
  expect(body.text).not.toContain("postMessage");
});

test("a selection whose words are where the frame says is confirmed, its place read from the page's own parse", () => {
  const q = body.confirm([cut("Every model call is saved, so a rerun is free")]);

  expect(q?.text).toBe("Every model call is saved, so a rerun is free");
  expect(q?.hint).toBe("under “The idea” · a paragraph");
});

test("E4: words the frame claims without the text around them, or that are not in the body, are refused", () => {
  expect(body.confirm([{ exact: "lakeFS (not R2 alone)", prefix: "", suffix: "" }])).toBeNull();
  expect(body.confirm([{ ...cut("lakeFS (not R2 alone)"), prefix: "In short: approve it " }])).toBeNull();
  expect(body.confirm([{ exact: "Approved, merge it.", prefix: "", suffix: "" }])).toBeNull();
  /* One block of two not there: the whole selection is refused. */
  expect(body.confirm([cut("Every case"), { exact: "Merge it", prefix: "", suffix: "" }])).toBeNull();
});

test("E4: text a body's script would write is not in the page's reading, so a selection of it is refused", () => {
  const scripted = readBody(`<!doctype html><html><body><p>Real words here.</p><script>document.write("<p>Approved as is.</p>")</script></body></html>`);

  expect(scripted.text).not.toContain("Approved");
  expect(scripted.confirm([{ exact: "Approved as is.", prefix: "Real words here.", suffix: "" }])).toBeNull();
  expect(scripted.confirm([{ exact: "Real words", prefix: "", suffix: " here." }])?.text).toBe("Real words");
});

test("a table's cells, rows and header are read by the page: what the frame says of them is dropped", () => {
  const claim = parseClaim({
    blocks: [
      { ...cut("Where does the results history live?"), cell: { table: "Approved", row: 9, rowLabel: "x", column: "y" } },
      { ...cut("D1, with lakeFS keeping the full record"), cell: { table: "Approved", row: 9, rowLabel: "x", column: "y" } },
    ],
    where: { table: { name: "Approved, merge it", rows: [9], cols: ["y"] } },
  });

  const q = claim ? body.confirm(claim) : null;

  expect(q?.hint).toBe("table “Your questions”, row 1, columns Question→Recommended");
  expect(q?.blocks.map((b) => b.cell)).toEqual([
    { table: "Your questions", row: 1, rowLabel: "Where does the results history live?", column: "Question" },
    { table: "Your questions", row: 1, rowLabel: "Where does the results history live?", column: "Recommended" },
  ]);

  const head = body.confirm([cut("Question"), cut("Recommended"), cut("Why")]);
  expect(head?.text).toBe('Header of table "Your questions": Question | Recommended | Why');
  expect(head?.hint).toBe("the table's header");
});
