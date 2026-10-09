/**
 * Decision numbers in an item's words ("D18", "G26", "Infra's d172, question 2"): a past decision named so the
 * reader need not remember it. A bare number is a decision's own number (a capital and digits). One with a
 * fleet named before it ("infra's", any case, a fleet's id or name this page knows) may be that fleet's number
 * or its id, in any case. A question named after it ("question 2", "Q2") goes with it.
 */

/** A run of words: plain text, or a decision's number, the fleet named before it, and a question named after it. */
export type RefRun =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ref"; readonly num: string; readonly fleet: string | null; readonly question: number | null; readonly text: string };

/** A fleet this page knows: its id, and the names it may be called by. */
export interface KnownFleet {
  readonly id: string;
  readonly names: readonly string[];
}

/** A word that may be a decision's number or id: a letter, then letters, digits, '_' or '-', ending in digits. */
const CANDIDATE = /(?<![A-Za-z0-9_/-])([A-Za-z][A-Za-z0-9_-]*?\d+)(?![A-Za-z0-9_-])/gu;

/** A decision's own number, standing alone. */
const BARE = /^[DAISGP]\d+$/u;

/** The word just before a number, possibly possessive: "pipeline's ", "Infra ". */
const FLEET_BEFORE = /([A-Za-z0-9][\w.@-]*?)(?:'s|’s)?\s+$/u;

/** A question named right after a number: ", question 2", " Q2". */
const QUESTION_AFTER = /^,?\s+(?:question\s+|Q)(\d+)(?![A-Za-z0-9_])/iu;

/** The fleet `word` names, by its id or a name, any case. */
function fleetNamed(word: string, fleets: readonly KnownFleet[]): string | null {
  const w = word.toLowerCase();

  return fleets.find((f) => f.id.toLowerCase() === w || f.names.some((n) => n.toLowerCase() === w))?.id ?? null;
}

/** `text` as runs, each decision number its own run; `fleets`: the fleets whose name may come before one. */
export function refRuns(text: string, fleets: readonly KnownFleet[] = []): RefRun[] {
  const out: RefRun[] = [];
  let at = 0;

  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index;

    if (start < at) continue;
    const num = m[1] ?? "";
    const before = FLEET_BEFORE.exec(text.slice(at, start));
    const fleet = before ? fleetNamed(before[1] ?? "", fleets) : null;

    if (fleet === null && !BARE.test(num)) continue;
    const from = fleet !== null && before ? at + before.index : start;
    const after = QUESTION_AFTER.exec(text.slice(start + num.length));
    const end = start + num.length + (after ? after[0].length : 0);

    if (from > at) out.push({ kind: "text", text: text.slice(at, from) });
    out.push({ kind: "ref", num, fleet, question: after ? Number(after[1]) : null, text: text.slice(from, end) });
    at = end;
  }

  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });

  return out;
}
