/**
 * The finder's (Ctrl/⌘K) matching and layout, pure, after Casos's navigator (catalog/match.ts,
 * search/groups.ts, search/prefix.ts).
 *
 * Matching: case and accents folded ("peticao" finds "Petição"), every word of the query must hit the
 * row's title, ref or second line; in the title a word at its start scores most, at a word's start less,
 * inside a word least; a ref typed whole comes first; one short word may match the title's letters in
 * order, ranked after every real hit. Kinds weigh a little, for the lists that mix them (the recents).
 * Ties: named things alphabetical, the chat and the log in their own order, newest first. A linear scan:
 * a page holds a few hundred rows.
 *
 * Layout: the recents (the places opened last) first, then one section per kind in GROUPS' order, five
 * rows each and a "show more"; with nothing typed, the recents and a row per kind to narrow to. A tab (or
 * its prefix, "d:") keeps one kind and draws up to fifty of it.
 */
import type { FindRow } from "./core.ts";
import type { Recent } from "./recents.ts";

/** Characters `[start, end)` of a title that matched. */
export type Range = readonly [number, number];

/** A kind of row: its key in FindRow.group, its heading, its prefix letter, a row of it in one word. */
export interface Group {
  readonly key: string;
  readonly heading: string;
  readonly prefix: string;
  readonly one: string;
  readonly weight: number;
}

/**
 * The kinds in the order the finder draws them: what waits on the viewer first (decisions, a fleet, a
 * roadblock), then who does the work, the plan, what was said, the links, and the log last.
 */
export const GROUPS: readonly Group[] = [
  { key: "decisions", heading: "Decisions", prefix: "d", one: "decision", weight: 6 },
  { key: "coordinators", heading: "Fleets", prefix: "f", one: "fleet", weight: 5 },
  { key: "roadblocks", heading: "Roadblocks", prefix: "r", one: "roadblock", weight: 4 },
  { key: "workers", heading: "Workers", prefix: "w", one: "worker", weight: 5 },
  { key: "plan", heading: "Plan", prefix: "p", one: "step", weight: 4 },
  { key: "chat", heading: "Chat", prefix: "c", one: "message", weight: 2 },
  { key: "links", heading: "Links", prefix: "l", one: "link", weight: 3 },
  { key: "log", heading: "Log", prefix: "g", one: "event", weight: 1 },
];

/** A view of the page, as a recent place. */
export const VIEW_GROUP: Group = { key: "views", heading: "Views", prefix: "", one: "view", weight: 3 };

/** The kind `key` stands for; a view for one the finder does not list. */
export const groupOf = (key: string): Group => GROUPS.find((g) => g.key === key) ?? VIEW_GROUP;

/** Rows a kind draws: five among the others, fifty under its tab; the recents three once words are typed. */
export const CAP = { all: 5, tab: 50, recentsFound: 3 } as const;

/** Kinds whose rows keep their own order on a tie (newest first) instead of the alphabet's. */
const OWN_ORDER: ReadonlySet<string> = new Set(["chat", "log"]);

/** One UTF-16 unit folded alone: lower case, accents stripped, cut or padded to its own length. */
function foldChar(ch: string): string {
  const base = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

  return base.length === ch.length ? base : base.slice(0, ch.length).padEnd(ch.length, " ");
}

/** A text folded for matching: lower case, accents stripped, one index per original unit, so offsets carry over. */
export function fold(text: string): string {
  let out = "";

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (code < 0x80) {
      out += text[i]?.toLowerCase() ?? "";
      continue;
    }

    const wide = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
    out += foldChar(text.slice(i, wide ? i + 2 : i + 1));

    if (wide) i++;
  }

  return out;
}

/** What ends a word before a hit: a space, a hyphen, a slash, a stop, a comma, a colon, a bracket, a quote. */
const BREAKS = new Set(" \t\n-/.,:;(['\"#@_");

const atWordStart = (hay: string, at: number): boolean => at === 0 || BREAKS.has(hay[at - 1] ?? "");

/** The query's words, folded. */
const wordsOf = (query: string): string[] => fold(query).split(/\s+/u).filter(Boolean);

/** Where the letters of `needle` sit in `hay`, in order; null when they do not all. */
function subsequence(hay: string, needle: string): Range[] | null {
  const ranges: Range[] = [];
  let from = 0;

  for (const ch of needle) {
    const at = hay.indexOf(ch, from);

    if (at === -1) return null;
    ranges.push([at, at + 1]);
    from = at + 1;
  }

  return ranges;
}

/** A row the query found: how well, and which characters of its title. */
export interface Hit {
  readonly row: FindRow;
  readonly score: number;
  readonly ranges: readonly Range[];
}

/** Ranges in order, the overlapping ones joined. */
function joined(ranges: Range[]): Range[] {
  const out: [number, number][] = [];

  for (const [a, b] of ranges.toSorted((x, y) => x[0] - y[0])) {
    const last = out.at(-1);

    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }

  return out;
}

/** How `row` meets the folded `words`, or null when one of them misses it. An empty query meets every row. */
function hitOf(row: FindRow, words: readonly string[]): Hit | null {
  if (!words.length) return { row, score: 0, ranges: [] };
  const title = fold(row.title);
  const ref = fold(row.ref);
  const sub = fold(row.sub);
  const ranges: Range[] = [];
  let score = ref !== "" && ref === words.join(" ") ? 1000 : 0;

  for (const w of words) {
    const t = title.indexOf(w);

    if (t !== -1) {
      score += t === 0 ? 30 : atWordStart(title, t) ? 20 : 8;
      ranges.push([t, t + w.length]);
    } else if (ref.includes(w)) score += ref.startsWith(w) ? 16 : 6;
    else if (sub.includes(w)) score += atWordStart(sub, sub.indexOf(w)) ? 10 : 4;
    else {
      const loose = words.length === 1 && w.length <= 4 ? subsequence(title, w) : null;

      /* Letters in order: below every real hit, whatever the kind. */
      return loose ? { row, score: -1, ranges: loose } : null;
    }
  }

  return { row, score: score + groupOf(row.group).weight, ranges: joined(ranges) };
}

/** The characters of `title` the query's words hit; [] when none or nothing typed. */
export function rangesIn(title: string, query: string): readonly Range[] {
  const words = wordsOf(query);

  return words.length ? (hitOf({ key: "", group: "", ref: "", title, sub: "", hint: "", pill: "", go: { kind: "view", hash: "" } }, words)?.ranges ?? []) : [];
}

/** Best first: the score, then the kind's own order (chat, log) or the alphabet, then the given order. */
function better(a: Hit & { readonly i: number }, b: Hit & { readonly i: number }): number {
  if (b.score !== a.score) return b.score - a.score;

  if (a.row.group === b.row.group && OWN_ORDER.has(a.row.group)) return a.i - b.i;
  const x = fold(a.row.title);
  const y = fold(b.row.title);

  return x < y ? -1 : x > y ? 1 : a.i - b.i;
}

/** The rows `query` finds, best first; every row, in its order, for an empty query. */
export function rank(rows: readonly FindRow[], query: string): Hit[] {
  const words = wordsOf(query);
  const hits: (Hit & { readonly i: number })[] = [];

  rows.forEach((row, i) => {
    const hit = hitOf(row, words);

    if (hit) hits.push({ ...hit, i });
  });

  return words.length ? hits.sort(better) : hits;
}

/** A title cut into its matched and unmatched parts, for `<mark>`. */
export function highlight(title: string, ranges: readonly Range[]): { readonly text: string; readonly hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;

  for (const [start, end] of ranges) {
    if (start < at) continue;

    if (start > at) parts.push({ text: title.slice(at, start), hit: false });
    parts.push({ text: title.slice(start, end), hit: true });
    at = end;
  }

  if (at < title.length || !parts.length) parts.push({ text: title.slice(at), hit: false });

  return parts;
}

/** What a typed query asks: the kind its prefix ("d:") narrows to, else null, and its words. */
export function readPrefix(raw: string): { readonly group: string | null; readonly words: string } {
  const m = /^\s*([a-z]):\s*(.*)$/isu.exec(raw);
  const g = m ? GROUPS.find((x) => x.prefix === (m[1] ?? "").toLowerCase()) : undefined;

  return g && m ? { group: g.key, words: (m[2] ?? "").trim() } : { group: null, words: raw.trim() };
}

/** The tabs: All (""), then each kind the rows hold, in GROUPS' order. */
export function tabsOf(rows: readonly FindRow[]): string[] {
  const held = new Set(rows.map((r) => r.group));

  return ["", ...GROUPS.flatMap((g) => (held.has(g.key) ? [g.key] : []))];
}

/** The tab `by` steps from `tab`, round the ends; from a tab not shown, the first after All. */
export function cycleTab(tabs: readonly string[], tab: string, by: 1 | -1): string {
  const at = Math.max(0, tabs.indexOf(tab));

  return tabs[(at + by + tabs.length) % tabs.length] ?? "";
}

/** A line of the finder's list. */
export type Item =
  | { readonly kind: "row"; readonly key: string; readonly row: FindRow; readonly recent: boolean }
  | { readonly kind: "more"; readonly key: string; readonly section: string; readonly n: number }
  | { readonly kind: "hint"; readonly key: string; readonly group: string; readonly heading: string; readonly prefix: string; readonly n: number };

/** A section of the list under its heading. */
export interface Section {
  readonly id: string;
  readonly heading: string;
  readonly items: readonly Item[];
}

/** What the list is drawn from. */
export interface ArrangeInput {
  readonly rows: readonly FindRow[];
  /** The places opened last, newest first. */
  readonly recents: readonly Recent[];
  /** The words typed, the prefix taken off. */
  readonly query: string;
  /** The kind narrowed to; "" for all. */
  readonly tab: string;
  /** The sections whose "show more" was taken. */
  readonly more: ReadonlySet<string>;
  /** The key of the place shown now, left out of the recents. */
  readonly here: string | null;
}

/** `hits` as a section's items: `cap` of them, then a "show more" for the rest unless it was taken. */
function capped(id: string, hits: readonly FindRow[], cap: number, more: ReadonlySet<string>, recent: boolean): Item[] {
  const n = more.has(id) ? hits.length : Math.min(cap, hits.length);
  const items: Item[] = hits.slice(0, n).map((row) => ({ kind: "row", key: id + ":" + row.key, row, recent }));

  if (n < hits.length) items.push({ kind: "more", key: "more:" + id, section: id, n: hits.length - n });

  return items;
}

/** The finder's list: its sections, in order, each with its items. */
export function arrange(input: ArrangeInput): Section[] {
  const { rows, query, tab, more } = input;
  const words = wordsOf(query);
  const live = new Map(rows.map((r) => [r.key, r]));
  const sections: Section[] = [];
  const shown = new Set<string>();

  if (!tab) {
    /* A recent takes its row's words as they are now; a place gone keeps the words it had. */
    const places = input.recents.flatMap((r): FindRow[] => (r.key === input.here ? [] : [live.get(r.key) ?? r]));

    /* Best first, and of equal hits the one opened last. */
    const hits = places
      .flatMap((row, i) => {
        const h = hitOf(row, words);

        return h ? [{ h, i }] : [];
      })
      .sort((a, b) => b.h.score - a.h.score || a.i - b.i)
      .map(({ h }) => h.row);

    const items = capped("recents", hits, words.length ? CAP.recentsFound : CAP.all, more, true);

    for (const it of items) if (it.kind === "row") shown.add(it.row.key);

    if (items.length) sections.push({ id: "recents", heading: "Recent", items });
  }

  if (!tab && !words.length) {
    const items: Item[] = GROUPS.flatMap((g): Item[] => {
      const n = rows.filter((r) => r.group === g.key).length;

      return n ? [{ kind: "hint", key: "hint:" + g.key, group: g.key, heading: g.heading, prefix: g.prefix, n }] : [];
    });

    if (items.length) sections.push({ id: "hints", heading: "Narrow to", items });

    return sections;
  }

  const found = rank(
    rows.filter((r) => (!tab || r.group === tab) && !shown.has(r.key)),
    query,
  );

  for (const g of GROUPS) {
    if (tab && g.key !== tab) continue;
    const hits = found.flatMap((h) => (h.row.group === g.key ? [h.row] : []));

    if (hits.length) sections.push({ id: g.key, heading: g.heading, items: capped(g.key, hits, tab ? CAP.tab : CAP.all, more, false) });
  }

  return sections;
}

/** The selectable items of `sections`, in the order the arrows walk them. */
export const itemsOf = (sections: readonly Section[]): Item[] => sections.flatMap((s) => s.items);
