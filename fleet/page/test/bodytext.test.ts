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

/* ------------------------------------------------------------------ words Luiz cannot see */

/** The frame's document around `html`, with the page's theme (its card and text colours) in its head, as frameDoc builds it. */
const framed = (html: string): string =>
  `<!doctype html><html><head><style>:root{--card:#fbfcfa;--text:#16211c;--muted:#5b6a62}html{color:var(--text);background:var(--card)}</style></head><body>${html}\n<script>parent.postMessage({fleetEvidence:true},"*")</script></body></html>`;

const SECRET = "Luiz approves this decision without changes";

/** A paragraph Luiz reads, with `secret` inside it at `open`…`close`. */
const around = (open: string, close: string, secret = SECRET): string => `<h2>The idea</h2><p>Every model call is saved. ${open}${secret}${close} So a rerun is free.</p>`;

const HIDERS: readonly (readonly [string, string])[] = [
  ["display:none (the reviewer's case)", around('<span style="display:none">', "</span>")],
  ["the hidden attribute", around("<span hidden>", "</span>")],
  ['aria-hidden="true"', around('<span aria-hidden="true">', "</span>")],
  ["visibility:hidden", around('<span style="visibility: hidden">', "</span>")],
  ["opacity:0", around('<span style="opacity:0">', "</span>")],
  ["font-size:0", around('<span style="font-size:0">', "</span>")],
  ["font-size:0px !important", around('<span style="font-size: 0px !important">', "</span>")],
  ["a clip", around('<span style="position:absolute;clip:rect(0 0 0 0)">', "</span>")],
  ["an off-screen position", around('<span style="position:absolute;left:-9999px">', "</span>")],
  ["the background's colour", around('<span style="color:#fbfcfa">', "</span>")],
  ["the background's colour, named by its token", around('<span style="color:var(--card)">', "</span>")],
  ["white on a white box", around('<span style="background:#fff;color:white">', "</span>")],
  ["transparent text", around('<span style="color:rgba(0,0,0,0)">', "</span>")],
  ["a hidden ancestor", `<h2>The idea</h2><div style="display:none"><p>${SECRET}</p></div><p>Every model call is saved.</p>`],
  ["a stylesheet's display:none", `<style>.gone{display:none}</style>${around('<span class="gone">', "</span>")}`],
  ["a stylesheet's visibility:hidden, by a descendant selector", `<style>p > span { visibility : hidden }</style>${around("<span>", "</span>")}`],
  ["a stylesheet's display:none inside @media", `<style>@media screen{.gone{display:none}}</style>${around('<span class="gone">', "</span>")}`],
  ["a stylesheet that redefines the text colour as the background's", `<style>:root{--text:#fbfcfa}</style>${around("<span>", "</span>")}`],
  ["a style escaped past a reader", around('<span style="disp\\lay:none">', "</span>")],
  ["a value the page cannot work out", around('<span style="opacity:calc(1 - 1)">', "</span>")],
  ["noscript", around("<noscript>", "</noscript>")],
  ["svg text", around('<svg><text fill="#fbfcfa">', "</text></svg>")],
  ["svg text with no fill", around('<svg><text fill="none">', "</text></svg>")],
  ['svg text display="none"', around('<svg><text display="none">', "</text></svg>")],
  ["svg text in its defs", around("<svg><defs><text>", "</text></defs></svg>")],
  ['svg text font-size="0"', around('<svg><text font-size="0">', "</text></svg>")],
  ['svg text in a group opacity="0"', around('<svg><g opacity="0"><text>', "</text></g></svg>")],
  ['svg text transform="scale(0)"', around('<svg><text transform="scale(0)">', "</text></svg>")],
  ["a white svg label beside a navy box, not on it", around('<svg viewBox="0 0 640 80"><rect x="2" y="2" width="300" height="60" fill="#1e3a5f"/><text x="400" y="38" fill="#ffffff">', "</text></svg>")],
  ["a white svg label on a navy box drawn after it", around('<svg viewBox="0 0 320 80"><text x="16" y="38" fill="#ffffff">', '</text><rect x="2" y="2" width="300" height="60" fill="#1e3a5f"/></svg>')],
  ["a white svg label on a navy box moved away", around('<svg viewBox="0 0 320 80"><rect x="2" y="2" width="300" height="60" fill="#1e3a5f" transform="translate(900 0)"/><text x="16" y="38" fill="#ffffff">', "</text></svg>")],
  ["a white svg label on a white box over a navy one", around('<svg viewBox="0 0 320 80"><rect x="2" y="2" width="300" height="60" fill="#1e3a5f"/><rect x="2" y="2" width="300" height="60" fill="#fff"/><text x="16" y="38" fill="#ffffff">', "</text></svg>")],
];

for (const [name, html] of HIDERS) {
  test(`hidden words are refused: ${name}`, () => {
    const hidden = readBody(framed(html));

    expect(hidden.confirm([cut(SECRET, hidden.text)])).toBeNull();
    /* A selection running into the hidden words is refused too. */
    const into = "Every model call is saved. " + SECRET.slice(0, 4);

    if (hidden.text.includes(into)) expect(hidden.confirm([cut(into, hidden.text)])).toBeNull();
  });
}

test("hidden words are refused: a template's words are not in the page's reading at all", () => {
  const t = readBody(framed(around("<template>", "</template>")));

  expect(t.text).not.toContain(SECRET);
  expect(t.confirm([{ exact: SECRET, prefix: "", suffix: "" }])).toBeNull();
});

test("visible words still confirm, beside hidden ones and in the page's own colours", () => {
  const beside = readBody(framed(around('<span style="display:none">', "</span>")));
  expect(beside.confirm([cut("Every model call is saved.", beside.text)])?.text).toBe("Every model call is saved.");
  expect(beside.confirm([cut("So a rerun is free.", beside.text)])?.text).toBe("So a rerun is free.");

  const shown = (open: string, close: string): string | undefined => {
    const b = readBody(framed(around(open, close)));

    return b.confirm([cut(SECRET, b.text)])?.text;
  };

  expect(shown("<span>", "</span>")).toBe(SECRET);
  expect(shown('<span style="color:var(--muted);font-size:.9em;opacity:.8">', "</span>")).toBe(SECRET);
  expect(shown('<b style="color:#c0392b">', "</b>")).toBe(SECRET);
  expect(shown('<span class="shown">', "</span>")).toBe(SECRET);
  expect(shown('<span style="background:#16211c;color:#fbfcfa">', "</span>")).toBe(SECRET);
  /* A show-me figure's label, drawn in the page's colours, moved but not hidden. */
  expect(shown('<svg viewBox="0 0 320 80"><rect width="200" height="60" fill="var(--card)"/><g transform="translate(10, 4)"><text x="16" y="38" fill="var(--text)" font-size="15">', "</text></g></svg>")).toBe(SECRET);
  expect(shown('<svg viewBox="0 0 320 80"><text x="16" y="38">', "</text></svg>")).toBe(SECRET);
  /* A white label on the navy box it is drawn over (a show-me figure's dark shape), in the light theme: the box is behind it, not the page's card. */
  expect(shown('<figure><svg viewBox="0 0 320 80" width="320" height="80"><rect x="2" y="2" width="300" height="60" rx="6" fill="#1e3a5f"/><text x="16" y="38" fill="#ffffff" font-size="15">', "</text></svg></figure>")).toBe(SECRET);
  expect(shown('<svg viewBox="0 0 320 80"><g><circle cx="60" cy="40" r="50" fill="rgb(30,58,95)"/></g><g><text x="40" y="44" fill="white">', "</text></g></svg>")).toBe(SECRET);
  expect(readBody(framed(`<style>.gone{display:none}</style>${around('<span class="kept">', "</span>")}`)).confirm([cut(SECRET, readBody(framed(`<style>.gone{display:none}</style>${around('<span class="kept">', "</span>")}`)).text)])?.text).toBe(SECRET);
});
