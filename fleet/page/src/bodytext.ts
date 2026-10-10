/**
 * A decision's body as the page reads it itself (SPEC "Marks on a decision"). The frame runs the body's own
 * scripts next to the marks' script, so what it posts is a claim: the page parses the same document it gave
 * the frame (its srcdoc) with DOMParser, where no script runs, and checks the claim against that text. A
 * selection is confirmed only when each of its blocks occurs there with the text the frame says is around
 * it; the quote, its cells and where it was are then read from the page's own parse, not from the frame.
 */
import type { Json, JsonRecord, MarkQuote } from "./core.ts";
import { parseSelection, type Claimed } from "./marks.ts";

/** The elements a selection is cut into blocks by, as the frame cuts it (markframe.ts). */
const BLOCK = "p,li,td,th,h1,h2,h3,h4,pre,dd,dt,caption,figcaption,blockquote";

/** The characters of the body's text the frame keeps on each side of a block. */
const AROUND = 32;

/** A decision's body as the page read it: its text, as the frame reads its own, and the check of a selection. */
export interface BodyText {
  /** The body's text nodes (no script or style), joined. */
  readonly text: string;
  /** The selection `claim` as a quote read from this body; null when a block of it is not there with the text around it. */
  readonly confirm: (claim: readonly Claimed[]) => MarkQuote | null;
}

/** A table cell, as a mark keeps it. */
type CellAt = { readonly table: string; readonly row: number; readonly rowLabel: string; readonly column: string; readonly head?: true };

const words = (n: Node | null | undefined): string => (n?.textContent ?? "").trim();

/** Read `srcdoc` (the frame's whole document) as the frame shows it, with no script run. */
export function readBody(srcdoc: string): BodyText {
  const doc = new DOMParser().parseFromString(srcdoc, "text/html");
  const list: { node: Text; start: number }[] = [];
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let pos = 0;

  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!(n instanceof Text) || /^(SCRIPT|STYLE)$/u.test(n.parentNode?.nodeName ?? "")) continue;
    list.push({ node: n, start: pos });
    pos += n.data.length;
  }

  const text = list.map((t) => t.node.data).join("");

  const nodeAt = (at: number): Text | null => list.find((t) => at >= t.start && at < t.start + t.node.data.length)?.node ?? null;

  /* Where `exact` is with exactly `prefix` before it and `suffix` after it, as the frame cuts them; -1 when nowhere. */
  const find = (b: Claimed): number => {
    for (let i = text.indexOf(b.exact); i >= 0; i = text.indexOf(b.exact, i + 1)) {
      const end = i + b.exact.length;

      if (text.slice(Math.max(0, i - AROUND), i) === b.prefix && text.slice(end, end + AROUND) === b.suffix) return i;
    }

    return -1;
  };

  /* A table's own children by tag, its rows and a row's cells, read from the elements (not the table APIs, so any DOM reads them alike). */
  const childOf = (el: Element, tag: string): Element | null => [...el.children].find((c) => c.tagName === tag) ?? null;

  const rowsOf = (table: Element): Element[] => [...table.querySelectorAll("tr")].filter((r) => r.closest("table") === table);

  const cellsOf = (tr: Element | null | undefined): Element[] => (tr ? [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH") : []);

  /* A table's header row: its head's first row, a row the page marks `head`, else a first row of only header cells (as the frame's table script finds it). */
  const headRow = (table: Element, rows: readonly Element[]): Element | null => {
    const thead = childOf(table, "THEAD");
    const first = rows[0];
    const firstCells = cellsOf(first);

    const inHead = thead ? rows.find((r) => r.parentElement === thead) : undefined;

    return inHead ?? rows.find((r) => r.classList.contains("head")) ?? (first && firstCells.length && firstCells.every((c) => c.tagName === "TH") ? first : null);
  };

  const before = (a: Node, b: Node): boolean => a === b || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  /* The heading above `el` (or `el` itself), among `tags`. */
  const headingOf = (el: Element, tags: string): string => {
    let name = "";

    for (const h of doc.body.querySelectorAll(tags)) if (before(h, el)) name = words(h);

    return name;
  };

  const tableName = (table: Element): string => {
    const caption = childOf(table, "CAPTION");

    return caption ? words(caption) : headingOf(table, "h1,h2,h3,h4");
  };

  const cellOf = (td: Element): CellAt | null => {
    const tr = td.parentElement;
    const table = td.closest("table");

    if (!tr || tr.tagName !== "TR" || !table) return null;
    const rows = rowsOf(table);
    const head = headRow(table, rows);
    const index = cellsOf(tr).indexOf(td);
    const isHead = tr === head || tr.parentElement?.tagName === "THEAD";
    const named = cellsOf(head)[index];
    const column = named ? words(named) : (td.getAttribute("data-label") ?? "column " + String(index + 1));
    const body = rows.filter((r) => r !== head && r.parentElement?.tagName !== "THEAD");
    const cell = { table: tableName(table), row: isHead ? 0 : body.indexOf(tr) + 1, rowLabel: words(cellsOf(tr)[0]), column };

    return isHead ? { ...cell, head: true } : cell;
  };

  const confirm = (claim: readonly Claimed[]): MarkQuote | null => {
    const blocks: JsonRecord[] = [];
    const cells: CellAt[] = [];
    let first: Element | null = null;

    for (const b of claim) {
      const at = find(b);
      const el = at < 0 ? null : (nodeAt(at)?.parentElement ?? null);

      if (!el) return null;
      const blk = el.closest(BLOCK) ?? el;
      const cell = blk.tagName === "TD" || blk.tagName === "TH" ? cellOf(blk) : null;
      const block = { exact: b.exact, prefix: b.prefix, suffix: b.suffix };
      first ??= blk;

      if (cell) cells.push(cell);
      blocks.push(cell ? { ...block, cell } : block);
    }

    let where: Json;

    if (cells.length) {
      const rows: number[] = [];
      const cols: string[] = [];

      for (const c of cells) {
        if (!c.head && !rows.includes(c.row)) rows.push(c.row);

        if (!cols.includes(c.column)) cols.push(c.column);
      }

      where = { table: { name: cells[0]?.table ?? "", rows, cols } };
    } else {
      where = first ? { tag: first.tagName.toLowerCase(), section: headingOf(first, "h1,h2,h3"), label: first.getAttribute("data-label") ?? "", row: 0 } : null;
    }

    return parseSelection({ blocks, where });
  };

  return { text, confirm };
}
