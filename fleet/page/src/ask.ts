/**
 * A decision's question as its page shows it. A question is the ask alone (the CLI refuses one over 400
 * characters), but one recorded before that rule can hold a whole plan in one paragraph. Such a question is
 * shown in parts, without changing what is stored: the ask itself (its first sentence that asks, else its
 * first sentence) large, and the rest in reading type, its sentences in short paragraphs and a run of
 * numbered items, "(1) … (2) …", as a list.
 */

/** A part of the rest of a long question: a paragraph, or a numbered list. */
export type AskPart = { readonly kind: "para"; readonly text: string } | { readonly kind: "list"; readonly items: readonly string[] };

/** The question as shown: the ask, and the rest when it was long. */
export interface Ask {
  readonly lead: string;
  readonly more: readonly AskPart[];
}

/** A question longer than this, in characters, is shown in parts. */
export const ASK_LONG = 300;

/** A paragraph of the rest closes once it reaches this many characters, at the end of a sentence. */
const PARA = 220;

const SENTENCE_END = /(?<=[.!?])\s+(?=["'“(\p{Lu}\p{N}$])/u;

const chars = (text: string): number => [...text].length;

/** The sentences of `text`, split where a sentence ends and the next starts with a capital, a digit, a quote or a parenthesis. */
export function sentencesOf(text: string): string[] {
  return text
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Sentences gathered into paragraphs of about PARA characters. */
function paragraphs(text: string): AskPart[] {
  const out: AskPart[] = [];
  let run = "";

  for (const s of sentencesOf(text)) {
    run = run === "" ? s : run + " " + s;

    if (chars(run) >= PARA) {
      out.push({ kind: "para", text: run });
      run = "";
    }
  }

  if (run !== "") out.push({ kind: "para", text: run });

  return out;
}

/** Where each item of a numbered run "(1) … (2) …" starts in `text`, in order from 1; empty with fewer than two. */
function markers(text: string): number[] {
  const at: number[] = [];
  let from = 0;

  for (let n = 1; ; n++) {
    const i = text.indexOf(`(${String(n)}) `, from);

    if (i < 0 || (i > 0 && !/\s/u.test(text[i - 1] ?? ""))) break;
    at.push(i);
    from = i + 1;
  }

  return at.length >= 2 ? at : [];
}

/** The rest of a long question in parts: paragraphs, and its numbered run as a list. */
function partsOf(text: string): AskPart[] {
  const at = markers(text);

  if (at.length === 0) return paragraphs(text);
  const items = at.map((start, k) => text.slice(start, at[k + 1] ?? text.length).replace(/^\(\d+\)\s+/u, "").trim());
  const last = items.pop() ?? "";
  const [lastItem = "", ...after] = sentencesOf(last);

  return [...paragraphs(text.slice(0, at[0])), { kind: "list", items: [...items, lastItem] }, ...paragraphs(after.join(" "))];
}

/** The question `q` as shown: as it is when short or already laid out (paragraphs, code); else the ask and the rest in parts. */
export function askParts(q: string): Ask {
  if (chars(q) <= ASK_LONG || q.includes("```")) return { lead: q, more: [] };

  if (q.includes("\n\n")) {
    const [first = "", ...rest] = q.split(/\n\s*\n/u);

    return { lead: first.trim(), more: rest.map((p) => ({ kind: "para", text: p.trim() })) };
  }

  const sentences = sentencesOf(q.replace(/\s+/gu, " "));
  const at = Math.max(0, sentences.findIndex((s) => s.endsWith("?")));
  const lead = sentences[at] ?? q;
  const rest = sentences.filter((_, i) => i !== at).join(" ");

  return { lead, more: rest === "" ? [] : partsOf(rest) };
}
