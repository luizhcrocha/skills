/**
 * Comments on the words the dashboard itself draws on a decision's page (SPEC "Marks on a decision", the
 * page): its title, question, why, an option and its consequence, a manual step, the recommendation, a line
 * of its history. Those are the page's own DOM, so a selection there is Luiz's own, read from the page
 * directly: the element it falls in names the field (`data-field`), and the words are anchored within that
 * field's text as a body's block is (`exact` with up to 32 characters each side). A mark's quote carries the
 * field (`quote.field`), its hint says it in words, and it is found again by field and context.
 */
import { Core, type Json, type JsonRecord, type MarkQuote } from "./core.ts";
import { oneLine } from "./marks.ts";

/** Whether `s` names a field of a decision's page: `title`, `question`, `why`, `step`, `recommendation`, `option:<id>`, `option:<id>:consequence`, `history:<n>`. */
export const isField = (s: string): boolean => Core.isField(s);

/** A field, as a hint says where the words were: "the question", "option B's consequence", "manual step". */
export function fieldHint(field: string): string {
  const [head = "", id = "", tail = ""] = field.split(":");

  switch (head) {
    case "title":
      return "the title";
    case "question":
      return "the question";
    case "why":
      return "why it needs you";
    case "step":
      return "manual step";
    case "recommendation":
      return "the recommendation";
    case "option":
      return tail ? `option ${id}'s consequence` : `option ${id}`;
    case "history":
      return `history, line ${id}`;
    default:
      return field;
  }
}

/** Words selected in a field: the field, and the words with up to 32 characters of the field's text on each side. */
export interface FieldClaim {
  readonly field: string;
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * The words from `start` to `end` of a field's `text` as a claim, their white space at each end left out;
 * null when they are none, or the field is not one.
 */
export function claimOf(field: string, text: string, start: number, end: number): FieldClaim | null {
  if (!isField(field) || start < 0 || end > text.length || end <= start) return null;
  const raw = text.slice(start, end);
  const a = start + (raw.length - raw.trimStart().length);
  const b = end - (raw.length - raw.trimEnd().length);

  if (b <= a) return null;
  const exact = text.slice(a, b).slice(0, 2000);

  return { field, exact, prefix: text.slice(Math.max(0, a - 32), a), suffix: text.slice(a + exact.length, a + exact.length + 32) };
}

/** A field's claim as a mark's quote: its words on one line, the field, and the field in words. */
export const fieldQuote = (c: FieldClaim): MarkQuote => ({ text: oneLine(c.exact, 2000), prefix: c.prefix, suffix: c.suffix, hint: fieldHint(c.field), blocks: [{ exact: c.exact, prefix: c.prefix, suffix: c.suffix }], field: c.field });

const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

const isText = (v: Json | undefined): v is string => v === String(v);

/** A field claim as posted (by the fleet's page inside the manager's), typed and within its limits; null for anything else. */
export function parseFieldClaim(v: Json | undefined): FieldClaim | null {
  if (!isRecord(v)) return null;
  const { field, exact, prefix, suffix } = v;

  if (!isText(field) || !isField(field) || !isText(exact) || !exact.trim() || exact.length > 2000 || !isText(prefix) || prefix.length > 64 || !isText(suffix) || suffix.length > 64) return null;

  return { field, exact, prefix, suffix };
}
