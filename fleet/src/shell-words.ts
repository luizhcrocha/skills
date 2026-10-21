/**
 * A Bash command line as its simple commands, read the way the shell would split it, for telling what an
 * agent's Bash call read or wrote ([waste.ts](waste.ts)). It follows quotes (`'…'`, `"…"` with its `\"`, `\\`,
 * `\$` and `` \` `` escapes, a backslash outside them), cuts at `;`, `&&`, `||`, `|`, `&`, `(`, `)` and newlines
 * (counting the subshells `(` and `)` open and close), keeps redirections apart from the words, keeps `$((…))`
 * whole in its word, drops `#` comments and heredoc bodies, and expands `$NAME`, `${NAME}` and a leading `~`
 * from the variables it is given. It does not run `$(…)`, backticks, `eval` or nested shells.
 *
 * npm's shell-quote (1.12.0, checked 2026-10-21) was the maintained alternative; it splits an unbalanced `'`
 * into separate words, gives `2>` as a word `2` and an operator `>` (so `a 2>f` and `a 2 >f` read alike), and
 * knows no heredoc, so this module stays.
 */

/** How a part of a word was written: bare, in single quotes (or backslash-escaped), or in double quotes. */
export type Quote = "" | "'" | '"';

/** A run of a word's characters written the same way. */
export interface Part {
  readonly text: string;
  readonly quote: Quote;
}

/** A word as written: its parts, so expansion knows what was quoted. */
export type Word = readonly Part[];

/** A redirection: its operator with any fd (`>`, `>>`, `2>`, `&>`, `>&`, `<`, `<<`, `<<<` …) and its target. */
export interface Redirect {
  readonly op: string;
  readonly target: Word;
}

/** One simple command: its words (the program first) and its redirections, wherever they stood, and the
 * subshells (`(`) opened just before it and closed (`)`) just after it. */
export interface Simple {
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
  readonly opens: number;
  readonly closes: number;
}

/** A command line read: its simple commands, and the line without heredoc bodies, comments or quoted text (a
 * quoted string kept as `''` or `""`), for matching a program or a loop by its shape. */
export interface Lexed {
  readonly commands: readonly Simple[];
  readonly bare: string;
}

/** The text of a word, quotes dropped and nothing expanded. */
export const literal = (word: Word): string => word.map((p) => p.text).join("");

const lineEnd = (text: string, from: number): number => {
  const at = text.indexOf("\n", from);

  return at === -1 ? text.length : at;
};

/** Read `command` as its simple commands. An unbalanced quote runs to the end of its line, not of the command. */
export function lex(command: string): Lexed {
  const text = command;
  const commands: { words: Word[]; redirects: Redirect[]; opens: number; closes: number }[] = [];
  let opens = 0;
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let parts: Part[] = [];
  let open = false;
  let op: string | undefined;
  let heredocs: string[] = [];
  let bare = "";

  const push = (chunk: string, quote: Quote): void => {
    const last = parts.at(-1);

    if (last !== undefined && last.quote === quote) parts[parts.length - 1] = { text: last.text + chunk, quote };
    else parts.push({ text: chunk, quote });
    open = true;
  };

  const endWord = (): void => {
    if (!open) return;

    if (op === undefined) words.push(parts);
    else {
      redirects.push({ op, target: parts });

      if (op === "<<" || op === "<<-") heredocs.push(literal(parts));
      op = undefined;
    }

    parts = [];
    open = false;
  };

  const cut = (): void => {
    endWord();
    op = undefined;

    if (words.length > 0 || redirects.length > 0) {
      commands.push({ words, redirects, opens, closes: 0 });
      opens = 0;
    }

    words = [];
    redirects = [];
  };

  /** Past the heredoc bodies that start after the newline at `at`; where the last one's closing line ends. */
  const skipBodies = (at: number): number => {
    let i = at;

    for (const until of heredocs) {
      while (i < text.length) {
        const end = lineEnd(text, i + 1);
        const line = text.slice(i + 1, end);
        i = end;

        if (line.trim() === until) break;
      }
    }

    heredocs = [];

    return i;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);

    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const stop = close === -1 ? lineEnd(text, i + 1) : close;
      push(text.slice(i + 1, stop), "'");
      bare += "''";
      i = close === -1 ? stop - 1 : stop;
    } else if (ch === '"') {
      i = doubleQuoted(text, i, push) - 1;
      bare += '""';
    } else if (ch === "\\") {
      if (next !== "\n" && next !== "") push(next, "'");
      i += 1;
    } else if (ch === "#" && !open) i = lineEnd(text, i) - 1;
    else if (ch === "\n") {
      cut();
      bare += "\n";

      if (heredocs.length > 0) i = skipBodies(i) - 1;
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      bare += " ";
    } else if (ch === ">" || ch === "<" || (ch === "&" && next === ">")) {
      const only = parts[0];
      const fd = op === undefined && parts.length === 1 && only !== undefined && only.quote === "" && /^\d+$/.test(only.text) ? only.text : "";

      if (fd === "") endWord();
      else {
        parts = [];
        open = false;
      }

      let o = fd + ch;

      while (/[<>&]/.test(text.charAt(i + 1))) o += text.charAt(++i);

      if ((o === "<<" && text.charAt(i + 1) === "-") || (o.endsWith(">") && text.charAt(i + 1) === "|")) o += text.charAt(++i);
      op = o;
      bare += o;
    } else if (ch === "$" && text.startsWith("((", i + 1)) {
      const end = arithmeticEnd(text, i + 3);
      push(text.slice(i, end), "");
      bare += "$(())";
      i = end - 1;
    } else if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      cut();
      bare += ch;

      const last = commands.at(-1);

      if (ch === "(") opens += 1;
      else if (ch === ")" && opens > 0) opens -= 1;
      else if (ch === ")" && last !== undefined) last.closes += 1;
    } else {
      push(ch, "");
      bare += ch;
    }
  }

  cut();

  return { commands, bare };
}

/** The index past the `))` that closes the `$((` whose body starts at `from`, its own parentheses balanced, or
 * the end of its line when it has none. */
function arithmeticEnd(text: string, from: number): number {
  let depth = 2;

  for (let j = from; j < text.length && text.charAt(j) !== "\n"; j++) {
    const c = text.charAt(j);

    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;

    if (depth === 0) return j + 1;
  }

  return lineEnd(text, from);
}

/** Read the double-quoted string opening at `from` into `push`; the index past its closing quote (or the end of
 * its line, when it has none). */
function doubleQuoted(text: string, from: number, push: (chunk: string, quote: Quote) => void): number {
  const scan = (limit: number, emit: boolean): number | undefined => {
    let chunk = "";

    for (let j = from + 1; j < limit; j++) {
      const c = text.charAt(j);

      if (c === '"') {
        if (emit) push(chunk, '"');

        return j + 1;
      }

      if (c === "\\" && '"\\$`\n'.includes(text.charAt(j + 1)) && j + 1 < limit) {
        const escaped = text.charAt(j + 1);

        if (emit && escaped !== "\n") {
          push(chunk, '"');
          push(escaped, "'");
          chunk = "";
        }

        j += 1;
      } else chunk += c;
    }

    if (emit) push(chunk, '"');

    return undefined;
  };

  const closed = scan(text.length, false);

  if (closed !== undefined) return scan(text.length, true) ?? closed;
  const end = lineEnd(text, from + 1);
  scan(end, true);

  return end;
}

/** `NAME=value` as its name and its value's word, or undefined for any other word. */
export function assignmentOf(word: Word): readonly [string, Word] | undefined {
  const [head, ...rest] = word;
  const m = head === undefined || head.quote !== "" ? null : /^([A-Za-z_]\w*)=/.exec(head.text);

  if (m === null || head === undefined) return undefined;
  const value = head.text.slice(m[0].length);

  return [m[1] ?? "", [...(value === "" ? [] : [{ text: value, quote: "" as const }]), ...rest]];
}

const VARIABLE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;

/** A word as the shell would expand it with `vars` (`HOME` for a leading bare `~`), or undefined when it uses a
 * variable `vars` lacks, `$(…)`, a backtick or any other `$` form. */
export function expand(word: Word, vars: ReadonlyMap<string, string>): string | undefined {
  let out = "";

  for (const [k, p] of word.entries()) {
    if (p.quote === "'") {
      out += p.text;
      continue;
    }

    let t = p.text;

    if (k === 0 && p.quote === "" && /^~(?:\/|$)/.test(t)) {
      const home = vars.get("HOME");

      if (home === undefined) return undefined;
      t = home + t.slice(1);
    }

    let unknown = false;

    const replaced = t.replace(VARIABLE, (_, braced: string | undefined, plain: string | undefined) => {
      const value = vars.get(braced ?? plain ?? "");

      if (value === undefined) unknown = true;

      return value ?? "";
    });

    if (unknown || replaced.includes("$") || replaced.includes("`")) return undefined;
    out += replaced;
  }

  return out;
}
