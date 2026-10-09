/**
 * Decision numbers in an item's words ("D18", "G26", "pipeline's D40"): a past decision named so the reader
 * need not remember it. A number is split out of the text with the fleet named before it, when that word is a
 * fleet this page knows; the page links each one it can find to its decision.
 */

/** A run of words: plain text, or a decision's number (and the fleet named before it). */
export type RefRun = { readonly kind: "text"; readonly text: string } | { readonly kind: "ref"; readonly num: string; readonly fleet: string | null; readonly text: string };

/** A decision's number: its kind's letter and digits, standing alone. */
const NUMBER = /(?<![A-Za-z0-9_/])([DAISGP]\d+)(?![A-Za-z0-9_])/gu;

/** The word just before a number, possibly possessive: "pipeline's ", "infra ". */
const FLEET_BEFORE = /([A-Za-z0-9][\w.@-]*?)(?:'s|’s)?\s+$/u;

/** `text` as runs, each decision number its own run; `fleets`: the fleets whose name may come before one. */
export function refRuns(text: string, fleets: readonly string[] = []): RefRun[] {
  const out: RefRun[] = [];
  let at = 0;

  for (const m of text.matchAll(NUMBER)) {
    const start = m.index;
    const before = FLEET_BEFORE.exec(text.slice(at, start));
    const fleet = before && fleets.includes(before[1] ?? "") ? (before[1] ?? null) : null;
    const from = fleet !== null && before ? at + before.index : start;

    if (from > at) out.push({ kind: "text", text: text.slice(at, from) });
    out.push({ kind: "ref", num: m[1] ?? "", fleet, text: text.slice(from, start + m[0].length) });
    at = start + m[0].length;
  }

  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });

  return out;
}
