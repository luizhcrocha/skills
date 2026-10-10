/**
 * Marks on a decision's body (SPEC "Marks on a decision"): the user selects words in the body's frame and
 * leaves a comment, a deletion, a replacement or a question on them, plus comments on the whole decision;
 * one Send delivers them all as one chat message to the fleet that owns the decision, and the fleet's
 * answers name the marks they answer.
 *
 * This module is the rules, with no DOM: a selection the frame claims (`parseClaim`), and one the page read
 * from its own parse of the body (bodytext.ts) turned into a quote (its lines and where it was, as words,
 * every frame-supplied word one line, `oneLine`); where a mark's blocks are in a revised body
 * (`placeMark`, which the frame runs too, so it uses nothing outside itself); the batch and its Markdown,
 * frame-supplied words escaped; the drafts kept in the browser; and the sent marks with their answers,
 * read back from the chat.
 */
import { Core, type Json, type JsonRecord, type MarkBatch, type MarkBlock, type MarkDecision, type MarkItem, type MarkKind, type MarkQuote, type Message } from "./core.ts";

/** The kinds a selection can be marked as, in the bar's order. */
export const QUOTED_KINDS: readonly MarkKind[] = ["comment", "delete", "replace", "question"];

/** Each kind, as a button and a list say it. */
export const KIND_WORDS = { comment: "Comment", delete: "Delete", replace: "Replace", question: "Question", general: "General" } as const satisfies { readonly [K in MarkKind]: string };

/** The most marks one batch carries (the server refuses more). */
export const BATCH_MAX = 100;

/** The longest a quoted block's words, a hint, and a cell's or section's name are kept (SPEC). */
const WORDS_MAX = 2000;

const HINT_MAX = 300;

const NAME_MAX = 200;

/**
 * Words the frame (or an agent) supplied, as one plain line before they enter a mark or its message:
 * every whitespace run (a newline too) one space, control, format and bidi characters gone, at most
 * `max` characters.
 */
export function oneLine(s: string, max: number): string {
  const t = s
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();

  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** One-lined words set in the message's Markdown as text: every character Markdown could read as markup escaped. */
const md = (s: string, max: number): string => oneLine(s, max).replace(/[\\`*_[\]<>|~#]/gu, "\\$&");

/** `md`, for words that start a line's content: a list or heading marker at their start escaped too. */
const mdLead = (s: string, max: number): string =>
  md(s, max)
    .replace(/^([-+=])/u, "\\$1")
    .replace(/^(\d+)([.)])/u, "$1\\$2");

const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

const isText = (v: Json | undefined): v is string => v === String(v);

const texts = (v: Json | undefined): string[] => (Array.isArray(v) ? v.flatMap((x) => (isText(x) ? [x] : [])) : []);

const numbers = (v: Json | undefined): number[] => (Array.isArray(v) ? v.flatMap((x) => (Number.isInteger(x) ? [Number(x)] : [])) : []);

/* ------------------------------------------------------------------ a selection, as words */

/**
 * Where a selection was, as the frame reads it: a table's name with the rows and columns it crosses, or
 * the block it starts in (its tag, the heading above it, a cell's column and row).
 */
type Where =
  | { readonly _tag: "table"; readonly name: string; readonly rows: readonly number[]; readonly cols: readonly string[] }
  | { readonly _tag: "block"; readonly tag: string; readonly section: string; readonly label: string; readonly row: number };

/** A line of a quote as read: a table's header row, a row's heading, one cell of it, or a block's text. */
export type QuoteLine =
  | { readonly _tag: "head"; readonly table: string; readonly cells: readonly string[] }
  | { readonly _tag: "row"; readonly label: string }
  | { readonly _tag: "cell"; readonly column: string; readonly text: string }
  | { readonly _tag: "text"; readonly text: string };

/**
 * The lines of a quote: one block's text alone; across blocks, one line per paragraph or list item, and
 * table cells as "column: text" under a line for their row, a header row as one line with its cells.
 */
export function quoteLines(blocks: readonly MarkBlock[]): QuoteLine[] {
  const only = blocks.length === 1 ? blocks[0] : undefined;

  if (only) return [{ _tag: "text", text: oneLine(only.exact, WORDS_MAX) }];
  const out: QuoteLine[] = [];
  let last = "";

  for (const b of blocks) {
    const cell = b.cell;

    if (cell?.head) {
      const key = "head|" + cell.table;

      if (key !== last) out.push({ _tag: "head", table: oneLine(cell.table, NAME_MAX), cells: blocks.flatMap((h) => (h.cell?.head && h.cell.table === cell.table ? [oneLine(h.exact, WORDS_MAX)] : [])) });
      last = key;
    } else if (cell) {
      const key = cell.table + "|" + String(cell.row);

      if (key !== last) out.push({ _tag: "row", label: oneLine(cell.rowLabel, NAME_MAX) });
      last = key;
      out.push({ _tag: "cell", column: oneLine(cell.column, NAME_MAX), text: oneLine(b.exact, WORDS_MAX) });
    } else {
      last = "";
      out.push({ _tag: "text", text: oneLine(b.exact, WORDS_MAX) });
    }
  }

  return out;
}

/** A quote's text as stored (SPEC): its lines, a header row `Header of table "<name>": A | B`, a row `Row '<first cell>'`, a cell `  <column>: <text>`. */
export function quoteText(blocks: readonly MarkBlock[]): string {
  return quoteLines(blocks)
    .map((l) => {
      switch (l._tag) {
        case "head":
          return `Header of table "${l.table || "untitled"}": ${l.cells.join(" | ")}`;
        case "row":
          return `Row '${l.label}'`;
        case "cell":
          return `  ${l.column}: ${l.text}`;
        case "text":
          return l.text;
      }
    })
    .join("\n");
}

/** A quote on one line, for a bar or a gist: its lines joined. */
export const quoteGist = (q: MarkQuote): string =>
  quoteLines(q.blocks)
    .map((l) => (l._tag === "head" ? l.cells.join(" | ") : l._tag === "row" ? l.label : l.text))
    .filter(Boolean)
    .join(" / ");

/** Where a selection was, as words: `table “T”, rows 1–3, columns A→C`, `the table's header`, `under “Section” · a paragraph`. */
function hintOf(where: Where): string {
  if (where._tag === "table") {
    const { name, rows, cols } = where;

    if (!rows.length) return "the table's header";
    const first = rows[0] ?? 0;
    const lastRow = rows.at(-1) ?? first;
    const rowWords = rows.length === 1 ? `row ${String(first)}` : `rows ${String(first)}–${String(lastRow)}`;
    const colWords = cols.length === 1 ? `column ${cols[0] ?? ""}` : `columns ${cols[0] ?? ""}→${cols.at(-1) ?? ""}`;

    return `table “${name || "untitled"}”, ${rowWords}, ${colWords}`;
  }

  const kind = where.label ? `the “${where.label}” cell, row ${String(where.row)}` : where.tag === "li" ? "a list item" : where.tag === "p" ? "a paragraph" : where.tag;

  return (where.section ? `under “${where.section}” · ` : "") + kind;
}

/** Where a selection was, as the frame posts it; a paragraph with nothing known when it posts nothing usable. */
function parseWhere(v: Json | undefined): Where {
  if (isRecord(v) && isRecord(v["table"])) {
    const t = v["table"];

    return { _tag: "table", name: isText(t["name"]) ? oneLine(t["name"], NAME_MAX) : "", rows: numbers(t["rows"]), cols: texts(t["cols"]).map((c) => oneLine(c, NAME_MAX)) };
  }

  const row = isRecord(v) ? v["row"] : undefined;
  const field = (key: string): string => (isRecord(v) && isText(v[key]) ? oneLine(v[key], NAME_MAX) : "");

  return { _tag: "block", tag: field("tag") || "p", section: field("section"), label: field("label"), row: Number.isInteger(row) ? Number(row) : 0 };
}

/** One block of a selection as the frame claims it: its words and up to 32 characters of the body's text on each side. */
export interface Claimed {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
}

/** The most blocks one selection crosses (SPEC). */
const BLOCKS_MAX = 200;

/**
 * A selection as the frame claims it (`{blocks: [{exact, prefix, suffix}]}`), only those fields, typed
 * and within their limits; null for anything else. A claim to check against the body, never a quote.
 */
export function parseClaim(v: Json | undefined): Claimed[] | null {
  if (!isRecord(v) || !Array.isArray(v["blocks"]) || !v["blocks"].length || v["blocks"].length > BLOCKS_MAX) return null;
  const out: Claimed[] = [];

  for (const b of v["blocks"]) {
    if (!isRecord(b)) return null;
    const { exact, prefix, suffix } = b;

    if (!isText(exact) || !exact || exact.length > WORDS_MAX || !isText(prefix) || prefix.length > 64 || !isText(suffix) || suffix.length > 64) return null;
    out.push({ exact, prefix, suffix });
  }

  return out;
}

/** A selection as the page read it (`{blocks, where}`) as a mark's quote, every word one line; null when it is not one. */
export function parseSelection(v: Json | undefined): MarkQuote | null {
  if (!isRecord(v)) return null;
  const item = Core.parseMarkItem({ n: 1, kind: "comment", quote: { blocks: v["blocks"] ?? null } });

  const blocks = (item?.quote?.blocks ?? []).map((b): MarkBlock => {
    const c = b.cell;

    return c ? { ...b, cell: { ...c, table: oneLine(c.table, NAME_MAX), rowLabel: oneLine(c.rowLabel, NAME_MAX), column: oneLine(c.column, NAME_MAX) } } : b;
  });

  const first = blocks[0];
  const last = blocks.at(-1);

  if (!first || !last) return null;

  return { text: quoteText(blocks), prefix: first.prefix, suffix: last.suffix, hint: oneLine(hintOf(parseWhere(v["where"])), HINT_MAX), blocks };
}

/* ------------------------------------------------------------------ a mark, found again */

/** Where a mark's blocks are in a body's text: `current` all where they were, `moved` found elsewhere or only some, `outdated` none. */
export interface Placement {
  readonly status: "current" | "moved" | "outdated";
  readonly found: number;
  readonly total: number;
  readonly spans: readonly { readonly start: number; readonly end: number }[];
}

/**
 * Find a mark's blocks in `text` (the body's text, as the frame reads it): each block at the one place
 * its words occur whose prefix and suffix still match best, scored by the characters of each (32 at
 * most) that still match next to the words; else the same words with the whitespace collapsed, scored
 * the same way. A block is found only when that best place matches at least half its context and no
 * other place matches as well: a phrase repeated elsewhere ("not") never takes a lost mark's place. The
 * page and the frame both run it (the frame its own source), so it uses nothing outside itself.
 */
export function placeMark(blocks: readonly { readonly exact: string; readonly prefix: string; readonly suffix: string }[], text: string): Placement {
  const common = (a: string, b: string, fromEnd: boolean): number => {
    let n = 0;

    while (n < a.length && n < b.length && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n += 1;

    return n;
  };

  /* The one place of `q` in `hay` whose context best matches `pre` and `suf`: null when none matches half of it, or two match it equally. */
  const pick = (hay: string, q: string, pre: string, suf: string): { at: number; whole: boolean } | null => {
    const before = pre.slice(-32);
    const after = suf.slice(0, 32);
    const most = before.length + after.length;
    let best = -1;
    let top = -1;
    let tie = false;

    for (let i = q ? hay.indexOf(q) : -1; i >= 0; i = hay.indexOf(q, i + 1)) {
      const score = common(hay.slice(Math.max(0, i - 32), i), before, true) + common(hay.slice(i + q.length, i + q.length + 32), after, false);

      if (score > top) {
        best = i;
        top = score;
        tie = false;
      } else if (score === top) tie = true;
    }

    return best < 0 || tie || top * 2 < most ? null : { at: best, whole: top === most };
  };

  const squeeze = (s: string): string => s.replace(/\s+/gu, " ");

  const locate = (g: { readonly exact: string; readonly prefix: string; readonly suffix: string }): { start: number; end: number; exact: boolean } | null => {
    const hit = pick(text, g.exact, g.prefix, g.suffix);

    if (hit) return { start: hit.at, end: hit.at + g.exact.length, exact: hit.whole };
    const map: number[] = [];
    let flatText = "";
    let space = false;

    for (let k = 0; k < text.length; k += 1) {
      const ws = /\s/u.test(text.charAt(k));

      if (ws && space) continue;
      space = ws;
      flatText += ws ? " " : text.charAt(k);
      map.push(k);
    }

    const q = squeeze(g.exact).trim();
    const loose = pick(flatText, q, squeeze(g.prefix), squeeze(g.suffix));
    const start = loose ? map[loose.at] : undefined;
    const end = loose ? map[loose.at + q.length - 1] : undefined;

    return start !== undefined && end !== undefined ? { start, end: end + 1, exact: false } : null;
  };

  const spans: { start: number; end: number }[] = [];
  let moved = false;

  for (const g of blocks) {
    const at = locate(g);

    if (!at) {
      moved = true;
      continue;
    }

    if (!at.exact) moved = true;
    spans.push({ start: at.start, end: at.end });
  }

  return { status: spans.length === 0 ? "outdated" : moved ? "moved" : "current", found: spans.length, total: blocks.length, spans };
}

/* ------------------------------------------------------------------ the batch */

/** A mark to send, and whether its words were gone from the body when it was sent. */
export interface Sendable {
  readonly item: MarkItem;
  readonly outdated: boolean;
}

/** A comment's lines, each quoted under a list item. */
const quoted = (text: string, indent: string): string[] => text.split("\n").map((l) => `${indent}> ${l}`);

/** A multi-block quote as a nested Markdown list: rows with "column: text" items, or one item per block; every frame-supplied word one line, escaped. */
function quoteList(blocks: readonly MarkBlock[]): string[] {
  return quoteLines(blocks).map((l) => {
    switch (l._tag) {
      case "head":
        return `   - Header of table “${md(l.table, NAME_MAX) || "untitled"}”: ${l.cells.map((c) => md(c, WORDS_MAX)).join(" | ")}`;
      case "row":
        return `   - Row “${md(l.label, NAME_MAX)}”`;
      case "cell":
        return `     - ${mdLead(l.column, NAME_MAX)}: ${md(l.text, WORDS_MAX)}`;
      case "text":
        return `   - “${md(l.text, WORDS_MAX)}”`;
    }
  });
}

/** One quoted mark in the message, numbered `i` in it and `#n` on the decision; `revision` the one it was sent on. */
function itemMarkdown(s: Sendable, i: number, revision: string): string[] {
  const { item } = s;
  const q = item.quote;

  if (!q) return [];
  const gone = s.outdated ? ` _(no longer found on revision ${md(revision, NAME_MAX)})_` : "";
  const n = `${String(i)}. [#${String(item.n)}]`;
  const comment = item.comment ? quoted(item.comment, "   ") : [];
  const withText = item.kind === "replace" ? [`   with: “${item.replacement ?? ""}”`] : [];
  const hint = md(q.hint, HINT_MAX);
  const where = hint ? ` (${hint})` : "";

  if (q.blocks.length > 1) {
    const head = { comment: "**Comment** on", question: "**Question** on", delete: "**Remove this**:", replace: "**Replace**", general: "" }[item.kind];
    const span = q.blocks.some((b) => b.cell) ? hint : `${String(q.blocks.length)} blocks${where}`;

    return [`${n} ${head} ${span}${gone}`, ...quoteList(q.blocks), ...withText, ...comment];
  }

  const words = `“${md(q.text, WORDS_MAX)}”${where}`;
  /* A deletion's words, one line, go in a fence longer than any run of backticks in them, so none of them closes it. */
  const plain = oneLine(q.text, WORDS_MAX);
  const fence = "`".repeat(Math.max(3, ...(plain.match(/`+/gu) ?? []).map((r) => r.length + 1)));

  switch (item.kind) {
    case "delete":
      return [`${n} **Remove this**${where}${gone}`, `   ${fence}`, `   ${plain}`, `   ${fence}`, ...comment];
    case "replace":
      return [`${n} **Replace** ${words}${gone}`, ...withText, ...comment];
    case "question":
      return [`${n} **Question** on ${words}${gone}`, ...(comment.length ? comment : ["   > (no text)"])];
    default:
      return [`${n} **Comment** on ${words}${gone}`, ...(comment.length ? comment : ["   > (no comment)"])];
  }
}

/** The batch's message as people read it: the decision, then each mark with its words and comment, the general comments last. */
export function batchMarkdown(decision: MarkDecision, hash: string, list: readonly Sendable[]): string {
  const count = `${String(list.length)} mark${list.length === 1 ? "" : "s"}`;
  const revision = decision.revision || "?";
  const out = [`**Marks on ${md(decision.ref || decision.id, NAME_MAX)}**: ${md(decision.title, WORDS_MAX)}`, `_${count} on revision ${md(revision, NAME_MAX)} · ${hash}_`, ""];
  let i = 0;

  for (const s of list) {
    if (s.item.kind === "general") continue;
    i += 1;
    out.push(...itemMarkdown(s, i, revision), "");
  }

  const general = list.filter((s) => s.item.kind === "general");

  if (general.length) {
    out.push("**General**");

    for (const g of general) out.push(...quoted(g.item.comment ?? "", ""), "");
  }

  return out.join("\n").trim();
}

/** A batch as it is posted to the chat: the Markdown people read and the marks, structured. */
export interface Batch {
  readonly text: string;
  readonly marks: MarkBatch;
}

/** The one chat message that sends `list`: its Markdown `text` and its structured `marks` (SPEC), quoted marks first, then the general ones. */
export function makeBatch(decision: MarkDecision, hash: string, list: readonly Sendable[]): Batch {
  const ordered = [...list].sort((a, b) => Number(a.item.kind === "general") - Number(b.item.kind === "general") || a.item.n - b.item.n).slice(0, BATCH_MAX);

  return { text: batchMarkdown(decision, hash, ordered), marks: { decision, at: { hash }, items: ordered.map((s) => s.item) } };
}

/** Who a batch reaches, as the page and the server say it. */
export interface Delivery {
  /** The fleet that owns the decision. */
  readonly fleet: string;
  /** The decision's ref (or id). */
  readonly ref: string;
  /** Whether the decision is this page's own (its host stands for the fleet), not a fleet's on the manager's page. */
  readonly own: boolean;
  /** The page's host as the server names it: `coordinator` or `manager`. */
  readonly host: string;
  /** The marks in the batch, and the drafts there are (a batch takes at most BATCH_MAX). */
  readonly count: number;
  readonly drafts: number;
}

/**
 * The preview's words on who gets the batch: the owning fleet (no other fleet sees it), or the names the
 * server's preview gave (`to`, null until it answers). On the manager's page a fleet missing from them is
 * not running, and the batch goes to the manager; drafts past BATCH_MAX wait for the next Send.
 */
export function deliveryWords(d: Delivery, to: readonly string[] | null): string {
  const marks = `${String(d.count)} mark${d.count === 1 ? "" : "s"}`;
  const rest = d.drafts > d.count ? ` ${String(d.count)} of ${String(d.drafts)}; the rest stay as drafts.` : "";

  if (!d.own && to && !to.includes(d.fleet)) return `${d.fleet} is not running: this goes to the manager as one chat message, ${marks}.${rest}`;
  const names = (to ?? [d.fleet]).map((x) => (d.own && x === d.host ? d.fleet : x));

  if (names.length === 1 && names[0] === d.fleet) return `Would be delivered to ${d.fleet} (owner of ${d.ref}) as one chat message, ${marks}. No other fleet sees it.${rest}`;

  return `Would be delivered to ${names.join(", ")} as one chat message, ${marks}.${rest}`;
}

/* ------------------------------------------------------------------ the drafts */

/** The browser storage the drafts are kept in (localStorage), as much of it as they use. */
export interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where a decision's unsent marks are kept, per viewer: one key per fleet and decision. */
export const draftsKey = (fleet: string, id: string): string => `fleet-marks:${fleet}:${id}`;

/** The unsent marks kept under `key`; none when there are none, the storage refuses, or what it holds is not marks. */
export function loadDrafts(store: DraftStore | null, key: string): MarkItem[] {
  try {
    const raw = store?.getItem(key) ?? null;
    const given: Json = raw === null ? null : JSON.parse(raw);

    return Array.isArray(given) ? given.flatMap((i) => Core.parseMarkItem(i) ?? []) : [];
  } catch {
    return [];
  }
}

/** Keep `items` under `key` (none: the key removed); false when the storage refuses. */
export function saveDrafts(store: DraftStore | null, key: string, items: readonly MarkItem[]): boolean {
  try {
    if (!store) return false;

    if (items.length) store.setItem(key, JSON.stringify(items));
    else store.removeItem(key);

    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ what was sent, and the answers */

/** A sent mark: the message that carried it, the mark, and the fleet's answers that name it. */
export interface SentMark {
  readonly batch: number;
  readonly item: MarkItem;
  readonly answers: readonly Message[];
}

/** The marks sent on the decision at `hash`, with their answers; and the answers to a batch that name no mark. */
export interface Sent {
  readonly marks: readonly SentMark[];
  readonly loose: readonly { readonly batch: number; readonly answers: readonly Message[] }[];
}

/** The decision's sent marks, read from the chat: every batch whose place is `hash`, and every answer `re` one of them. */
export function sentOf(messages: readonly Message[], hash: string): Sent {
  const marks: SentMark[] = [];
  const loose: { batch: number; answers: Message[] }[] = [];

  for (const b of messages) {
    if (!b.marks || b.marks.at.hash !== hash) continue;
    const answers = messages.filter((a) => a.re === b.id && a.from !== "user");

    for (const item of b.marks.items) marks.push({ batch: b.id, item, answers: answers.filter((a) => a.mark?.includes(item.n)) });
    const plain = answers.filter((a) => !a.mark?.length);

    if (plain.length) loose.push({ batch: b.id, answers: plain });
  }

  return { marks, loose };
}

/** The number the next mark on the decision takes: one past every mark sent or drafted. */
export const nextNumber = (sent: Sent, drafts: readonly MarkItem[]): number => Math.max(0, ...sent.marks.map((s) => s.item.n), ...drafts.map((d) => d.n)) + 1;
