/**
 * The page's text format, for free text that can carry code: a `--manual`, a decision's question, why,
 * reason and option consequences, a grilling's question, a chat message, a roadblock's detail. It is a
 * small subset of Markdown, and only this:
 *
 * - paragraphs, split on a blank line; a single line break stays a line break;
 * - inline code, a run of backticks closed by a run of the same length (`` `x` ``);
 * - fenced blocks, a line of three or more backticks with an optional language tag (```` ```nu ````),
 *   closed by a line of at least as many backticks, or by the end of the text.
 *
 * Nothing else is markup: no raw HTML, no emphasis, no links. The result is plain data (strings), and the
 * page renders it as text nodes, so text that looks like HTML stays text.
 */

/** Inline text: words, or inline code. */
export type Span = { readonly kind: "text"; readonly text: string } | { readonly kind: "code"; readonly text: string };

/** A block of text: a paragraph of spans, or a code block with its language ("" when the fence named none). */
export type Block = { readonly kind: "para"; readonly spans: readonly Span[] } | { readonly kind: "code"; readonly lang: string; readonly text: string };

const FENCE = /^ {0,3}(`{3,})[ \t]*([^`\s]*)[^`]*$/u;

/** The spans of one paragraph: inline code where a run of backticks is closed by a run as long; the rest as words. */
export function spansOf(text: string): Span[] {
  const out: Span[] = [];
  let words = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "`") {
      words += text[i];
      i++;
      continue;
    }

    let n = 0;

    while (text[i + n] === "`") n++;
    const run = "`".repeat(n);
    let close = text.indexOf(run, i + n);

    /* The closing run is exactly as long: a longer one is not it. */
    while (close >= 0 && text[close + n] === "`") {
      let k = close;

      while (text[k] === "`") k++;
      close = text.indexOf(run, k);
    }

    if (close < 0) {
      words += run;
      i += n;
      continue;
    }

    let code = text.slice(i + n, close).replace(/\n/gu, " ");

    if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);

    if (words) out.push({ kind: "text", text: words });
    words = "";
    out.push({ kind: "code", text: code });
    i = close + n;
  }

  if (words) out.push({ kind: "text", text: words });

  return out;
}

/** The paragraphs of a stretch of text with no fence in it. */
function paragraphs(lines: readonly string[]): Block[] {
  return lines
    .join("\n")
    .split(/\n[ \t]*\n/u)
    .map((p) => p.replace(/^\n+|\s+$/gu, ""))
    .filter((p) => p.trim() !== "")
    .map((p) => ({ kind: "para", spans: spansOf(p) }));
}

/** The blocks of `text`, in order. */
export function parseText(text: string): Block[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const out: Block[] = [];
  let prose: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const open = FENCE.exec(lines[i] ?? "");

    if (!open) {
      prose.push(lines[i] ?? "");
      i++;
      continue;
    }

    const ticks = open[1]?.length ?? 3;
    const close = new RegExp(`^ {0,3}\`{${String(ticks)},}[ \\t]*$`, "u");
    const body: string[] = [];
    i++;

    while (i < lines.length && !close.test(lines[i] ?? "")) {
      body.push(lines[i] ?? "");
      i++;
    }

    i++;
    out.push(...paragraphs(prose));
    prose = [];
    out.push({ kind: "code", lang: (open[2] ?? "").toLowerCase(), text: body.join("\n") });
  }

  out.push(...paragraphs(prose));

  return out;
}

/**
 * Whether a line of a `--manual` with no fence is a command rather than prose: one line, and not a
 * sentence. A sentence ends with `.`, `!`, `?` or `:` (an ellipsis, `...`, is not an end), or opens with a capitalised word and a space
 * ("Restart the server"). Nothing else is guessed.
 */
export function looksLikeCommand(text: string): boolean {
  const t = text.trim();

  return t !== "" && !t.includes("\n") && !t.includes("`") && !/(?<!\.)[.!?:]$/u.test(t) && !/^\p{Lu}\p{Ll}*\s/u.test(t);
}

/** Whether `text` uses the format at all: a fence or inline code. Text that does not is shown as it always was. */
export function isFormatted(text: string): boolean {
  return text.includes("`");
}

/** The blocks of a `--manual`: the format when it uses it; else one `nu` block when every line is a command; else the text as it is. */
export function manualBlocks(text: string): Block[] | null {
  if (isFormatted(text)) return parseText(text);
  const lines = text.split("\n").filter((l) => l.trim() !== "");

  return lines.length > 0 && lines.every((l) => looksLikeCommand(l)) ? [{ kind: "code", lang: "nu", text: text.trim() }] : null;
}
