/**
 * A grilling question as its page shows it, like a small decision: the question in plain words, its options
 * as cards, the recommended one marked, and the reason with its sources apart. A question asked with
 * `--option` carries its options; one asked before them puts them in its prose, "(a) … ; (b) … ; (c) …", and
 * is read into cards here without changing what is stored. A reason's sources in parentheses (a path with a
 * line, an ADR, a decision's number) are taken out of its sentence and listed apart, folded.
 */
import { sentencesOf } from "./ask.ts";
import type { DecisionOption, Question } from "./core.ts";

/** A question as shown: the ask, its options, which one is recommended and what the recommendation adds. */
export interface GrillAsk {
  readonly lead: string;
  /** Prose after the options, when the question went on. */
  readonly after: string;
  readonly options: readonly DecisionOption[];
  /** Whether the options were read from the question's prose. */
  readonly parsed: boolean;
  /** The recommended option's id, when the recommendation names one. */
  readonly recommended: string | null;
  /** What the recommendation says beyond the option's id ("adding (c) only if a question needs it"). */
  readonly also: string;
}

/** A reason as shown: its words, and the sources taken out of them. */
export interface GrillReason {
  readonly text: string;
  readonly sources: readonly string[];
}

/** What reads as a source, not a reason: a path with a line (store.ts:5-9), an ADR, a decision's number (D27). */
const SOURCE = /(?<![A-Za-z0-9_])(?:[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?|ADR[- ]?\d+|D\d+)(?![A-Za-z0-9_])/u;

/** Where each option of a run "(a) … (b) …" starts in `text`, from (a) on, letters in order; empty with fewer than two. */
function markers(text: string): { at: number; id: string }[] {
  const found: { at: number; id: string }[] = [];
  let from = 0;

  for (const id of "abcdefgh") {
    const re = new RegExp(`(?:^|\\s)\\(${id}\\)\\s`, "iu");
    const m = re.exec(text.slice(from));

    if (m === null) break;
    const at = from + m.index + (m[0].startsWith("(") ? 0 : 1);
    found.push({ at, id });
    from = at + 3;
  }

  return found.length >= 2 ? found : [];
}

/** An option's words from the prose, without the separator that ran into the next one. */
function labelOf(text: string): string {
  return text
    .replace(/^\(\w\)\s*/u, "")
    .trim()
    .replace(/[;,]\s*(?:or|and)?$/u, "")
    .replace(/\s+(?:or|and)$/u, "")
    .trim();
}

/** The option a recommendation names ("a", "(a)", "B: …", "(a), adding (c) …"), and what it says beyond it. */
function recommendedOf(recommend: string, options: readonly DecisionOption[]): { id: string | null; also: string } {
  const m = /^\s*\(?([A-Za-z0-9_.-]+?)\)?(?=$|[\s,.:;])[\s,.:;]*/u.exec(recommend);
  const hit = m ? options.find((o) => o.id.toLowerCase() === (m[1] ?? "").toLowerCase()) : undefined;

  return hit && m ? { id: hit.id, also: recommend.slice(m[0].length).trim() } : { id: null, also: recommend.trim() };
}

/** Question `q` as its page shows it. */
export function grillAsk(q: Question): GrillAsk {
  const body = (q.body ?? "").trim();
  const recommend = q.recommend ?? "";

  if (q.options && q.options.length > 0) {
    const rec = recommendedOf(recommend, q.options);

    return { lead: body, after: "", options: q.options, parsed: false, recommended: rec.id, also: rec.also };
  }

  const at = markers(body);

  if (at.length === 0 || body.includes("```")) return { lead: body, after: "", options: [], parsed: false, recommended: null, also: recommend };
  const parts = at.map((m, k) => body.slice(m.at, at[k + 1]?.at ?? body.length));
  const last = parts.pop() ?? "";
  const [lastItem = "", ...after] = sentencesOf(last);
  const options = [...parts, lastItem].map((p, k) => ({ id: at[k]?.id ?? "", label: labelOf(p) }));
  const rec = recommendedOf(recommend, options);

  return { lead: body.slice(0, at[0]?.at ?? 0).trim(), after: after.join(" "), options, parsed: true, recommended: rec.id, also: rec.also };
}

/** Reason `text` with its parenthesised sources taken out and listed apart, each once, in order. */
export function grillReason(text: string): GrillReason {
  const sources: string[] = [];

  const kept = text.replace(/\s*\(([^()]*)\)/gu, (whole, inner: string) => {
    if (!SOURCE.test(inner)) return whole;

    if (!sources.includes(inner.trim())) sources.push(inner.trim());

    return "";
  });

  return { text: kept.replace(/\s+([,.;:])/gu, "$1").trim(), sources };
}
