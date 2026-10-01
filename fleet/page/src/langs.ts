/**
 * The languages @tanstack/highlight does not ship, written for its `defineLanguage`: nushell (what Luiz
 * runs, so the one done in full), nix and rust. A tokenizer returns ranges of the code with a class; the
 * gaps stay plain text.
 *
 * nu follows nushell's own syntax (the nushell book, tree-sitter-nu): commands at the head of a pipeline
 * element, flags, `$variables` with their cell paths, strings ('raw', "escaped", `backtick`, r#'...'#),
 * interpolation `$"... (expr) ..."` with the expression tokenized as nu again, records `{key: value}`,
 * closures `{|x| ...}`, pipes, numbers with units, comments.
 */
import { defineLanguage, type HighlightTokenClass, type TokenizerContext, type TokenRange } from "@tanstack/highlight/core";

const NU_KEYWORDS = new Set(["let", "mut", "const", "def", "export", "use", "module", "source", "source-env", "alias", "extern", "overlay", "hide", "if", "else", "for", "in", "while", "loop", "match", "try", "catch", "return", "break", "continue"]);

const NU_OPERATORS = new Set(["and", "or", "xor", "not", "not-in", "in", "like", "not-like", "starts-with", "ends-with", "has", "not-has", "mod", "bit-and", "bit-or", "bit-xor", "bit-shl", "bit-shr"]);

const NU_LITERALS = new Set(["true", "false", "null"]);

const WORD = /[A-Za-z_][\w-]*/uy;

/** The rest of a bare word that is a path or a name with dots: `servers/billing`, `./run.nu`, `cr-lab.hf`. */
const BARE = /[\w./~@%+-]*/uy;

/** A bare word that opens with a path: `./x`, `../x`, `~/x`, `/abs`. */
const PATH = /(?:\.{1,2}\/|~\/?|\/(?=[\w.~]))[\w./~@%+-]*/uy;

const NUMBER = /-?(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)(?:ns|us|µs|ms|sec|min|hr|day|wk|b|kb|mb|gb|tb|pb|kib|mib|gib|tib|pib)?(?![\w-])/iuy;

const OPERATOR = /\|\||\||=~|!~|==|!=|<=|>=|\+\+=?|\.\.[<=]?|=>|[-+*/]=|\*\*|\/\/|[=<>+*/!?]|o\+e>|e>|o>/uy;

/** A record key's colon after a word or a quoted key: `{key: v}`. */
const COLON = /\s*:/uy;

/** Where the next word starts a command: the start, a new line, after `|`, `;`, `{`, `(` or a closure's parameters. */
const HEADS = new Set(["\n", "|", ";", "{", "(", ""]);

/** The end of a quoted string that starts at `i` with `quote`; backslash escapes only in double quotes. */
function quoteEnd(code: string, i: number, quote: string): number {
  let j = i + 1;

  while (j < code.length && code[j] !== quote) j += code[j] === "\\" && quote === '"' ? 2 : 1;

  return Math.min(j + 1, code.length);
}

/** The index just after the `)` that closes the `(` at `i`, skipping strings; the end when it is not closed. */
function parenEnd(code: string, i: number): number {
  let depth = 0;
  let j = i;

  while (j < code.length) {
    const c = code[j] ?? "";

    if (c === '"' || c === "'" || c === "`") {
      j = quoteEnd(code, j, c);
      continue;
    }

    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j + 1;
    j++;
  }

  return code.length;
}

/** `$"..."` or `$'...'` at `i`: the literal parts as strings, each `(expr)` as nu. */
function interpolation(code: string, i: number, ctx: TokenizerContext, out: TokenRange[]): number {
  const quote = code[i + 1] ?? '"';
  let start = i;
  let j = i + 2;

  while (j < code.length && code[j] !== quote) {
    if (code[j] === "\\" && quote === '"') {
      j += 2;
      continue;
    }

    if (code[j] === "(") {
      if (j > start) out.push({ start, end: j, className: "string" });
      const end = parenEnd(code, j);
      out.push({ start: j, end: j + 1, className: "operator" });

      for (const r of ctx.tokenize(code.slice(j + 1, end - 1), "nu")) out.push({ ...r, start: r.start + j + 1, end: r.end + j + 1 });

      if (code[end - 1] === ")") out.push({ start: end - 1, end, className: "operator" });
      j = start = end;
      continue;
    }

    j++;
  }

  const end = Math.min(j + 1, code.length);

  if (end > start) out.push({ start, end, className: "string" });

  return end;
}

/** What sticky `re` matches in `code` at `i`, or "". */
function matchAt(re: RegExp, code: string, i: number): string {
  re.lastIndex = i;

  return re.exec(code)?.[0] ?? "";
}

/** Nushell. */
export const nu = defineLanguage({
  name: "nu",
  aliases: ["nushell"],
  tokenize(code, ctx) {
    const out: TokenRange[] = [];
    const brackets: string[] = [];
    /* The last significant character, to know whether a word heads a pipeline element. */
    let prev = "";
    let i = 0;

    const push = (end: number, className: HighlightTokenClass): void => {
      out.push({ start: i, end, className });
      i = end;
    };

    while (i < code.length) {
      const c = code[i] ?? "";
      const at = (re: RegExp): string => matchAt(re, code, i);

      if (c === "\n") {
        /* A new line starts a command, except inside a list or a parenthesised expression. */
        if (brackets.at(-1) !== "[" && brackets.at(-1) !== "(") prev = "\n";
        i++;
        continue;
      }

      if (c === " " || c === "\t" || c === "\r") {
        i++;
        continue;
      }

      if (c === "#" && (i === 0 || /[\s;|({]/u.test(code[i - 1] ?? ""))) {
        const nl = code.indexOf("\n", i);
        push(nl < 0 ? code.length : nl, "comment");
        continue;
      }

      if (c === "$" && (code[i + 1] === '"' || code[i + 1] === "'")) {
        i = interpolation(code, i, ctx, out);
        prev = "s";
        continue;
      }

      if (c === "r" && code[i + 1] === "#") {
        const m = /r(#+)'[\s\S]*?'\1/uy;
        m.lastIndex = i;
        const raw = m.exec(code)?.[0];

        if (raw) {
          push(i + raw.length, "string");
          prev = "s";
          continue;
        }
      }

      if (c === '"' || c === "'" || c === "`") {
        const end = quoteEnd(code, i, c);
        /* A quoted record key: `{"k": v}`. */
        push(end, brackets.at(-1) === "{" && matchAt(COLON, code, end) !== "" ? "property" : "string");
        prev = "s";
        continue;
      }

      if (c === "$") {
        const name = /\$[\w-]*/uy;
        name.lastIndex = i;
        const v = name.exec(code)?.[0] ?? "$";
        push(i + v.length, "variable");

        /* A cell path: `$env.HOME`, `$x.0.name?`. */
        const path = /(?:\.[\w-]+\??)+/uy;
        path.lastIndex = i;
        const p = path.exec(code)?.[0];

        if (p) push(i + p.length, "property");
        prev = "v";
        continue;
      }

      if (c === "{") {
        brackets.push("{");
        push(i + 1, "operator");
        /* A closure's parameters: `{|x, y| ...}`. */
        const params = /\s*\|([^|\n]*)\|/uy;
        params.lastIndex = i;
        const m = params.exec(code);

        if (m) {
          const bar = code.indexOf("|", i);
          i = bar;
          push(bar + 1, "operator");
          const names = /[A-Za-z_][\w-]*/gu;
          const base = i;

          for (const n of (m[1] ?? "").matchAll(names)) out.push({ start: base + (n.index ?? 0), end: base + (n.index ?? 0) + n[0].length, className: "variable" });
          i = base + (m[1] ?? "").length;
          push(i + 1, "operator");
        }

        prev = "{";
        continue;
      }

      if (c === "}" || c === "]" || c === ")") {
        brackets.pop();
        push(i + 1, "operator");
        prev = c;
        continue;
      }

      if (c === "[" || c === "(") {
        brackets.push(c);
        push(i + 1, "operator");
        prev = c;
        continue;
      }

      if (c === ";" || c === "," || c === ":") {
        push(i + 1, "operator");
        prev = c;
        continue;
      }

      /* A flag: `--force`, `-y`, after blank space. */
      if (c === "-" && /[\s([]/u.test(code[i - 1] ?? " ")) {
        const flag = at(/--?[A-Za-z][\w-]*/uy);

        if (flag) {
          push(i + flag.length, "attr");
          prev = "w";
          continue;
        }
      }

      const num = at(NUMBER);

      if (num && !/[\w-]/u.test(code[i - 1] ?? "")) {
        push(i + num.length, "number");
        prev = "n";
        continue;
      }

      const path = at(PATH);

      if (path && !/[\w)\]}]/u.test(code[i - 1] ?? "")) {
        if (HEADS.has(prev)) push(i + path.length, "command");
        else i += path.length;
        prev = "w";
        continue;
      }

      const word = at(WORD);

      if (word) {
        BARE.lastIndex = i + word.length;
        const rest = /^[./~@%+]/u.test(code[i + word.length] ?? "") ? (BARE.exec(code)?.[0] ?? "") : "";
        const end = i + word.length + rest.length;
        const keyHere = !rest && brackets.at(-1) === "{" && matchAt(COLON, code, end) !== "";

        if (keyHere) push(end, "property");
        else if (NU_LITERALS.has(word)) push(end, "literal");
        else if (HEADS.has(prev) && NU_KEYWORDS.has(word)) push(end, "keyword");
        else if (HEADS.has(prev)) push(end, "command");
        else if (NU_KEYWORDS.has(word) && (word === "else" || word === "in" || word === "catch")) push(end, "keyword");
        else if (NU_OPERATORS.has(word)) push(end, "operator");
        else i = end;

        prev = keyHere ? "k" : "w";
        continue;
      }

      const op = at(OPERATOR);

      if (op) {
        push(i + op.length, "operator");
        prev = op === "|" ? "|" : "o";
        continue;
      }

      i++;
      prev = "w";
    }

    return out;
  },
});

/** A tokenizer from rules tried in order at each position; the first that matches there wins. */
function scanner(rules: readonly (readonly [RegExp, HighlightTokenClass])[]): (code: string) => TokenRange[] {
  const sticky = rules.map(([re, cls]) => [new RegExp(re.source, re.flags.replace(/[gy]/gu, "") + "y"), cls] as const);

  return (code) => {
    const out: TokenRange[] = [];
    let i = 0;

    outer: while (i < code.length) {
      for (const [re, cls] of sticky) {
        re.lastIndex = i;
        const m = re.exec(code);

        if (!m || !m[0]) continue;
        out.push({ start: i, end: i + m[0].length, className: cls });
        i += m[0].length;
        continue outer;
      }

      /* A word no rule claims is skipped whole, so a keyword is never found inside it. */
      const w = /[\w$]+|./suy;
      w.lastIndex = i;
      i += w.exec(code)?.[0].length ?? 1;
    }

    return out;
  };
}

const RUST_KEYWORDS = /(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while)\b/u;

/** Rust. */
export const rust = defineLanguage({
  name: "rust",
  aliases: ["rs"],
  tokenize: scanner([
    [/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/u, "comment"],
    [/#!?\[[^\]\n]*\]/u, "meta"],
    [/b?r(#*)"[\s\S]*?"\1|b?"(?:\\[\s\S]|[^"\\])*"?|b?'(?:\\.|[^'\\])'/u, "string"],
    [/'[A-Za-z_]\w*/u, "type"],
    [RUST_KEYWORDS, "keyword"],
    [/(?:true|false|None|Some|Ok|Err)\b/u, "literal"],
    [/\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:[iu](?:8|16|32|64|128|size)|f32|f64)?\b|0x[\da-fA-F_]+\b/u, "number"],
    [/[A-Za-z_]\w*!/u, "function"],
    [/[A-Z]\w*/u, "type"],
    [/[a-z_]\w*(?=\s*(?:::<[^>]*>)?\()/u, "function"],
    [/::|->|=>|[-+*/%=<>!&|^?]=?/u, "operator"],
  ]),
});

const nixRules = scanner([
  [/#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/u, "comment"],
  [/(?:let|in|with|rec|inherit|if|then|else|assert|or)\b/u, "keyword"],
  [/(?:true|false|null)\b/u, "literal"],
  [/(?:import|builtins|map|toString|throw|abort|derivation)\b/u, "function"],
  [/(?:\.{1,2}|~)?\/[\w./+-]+|<[\w./+-]+>/u, "string"],
  [/https?:\/\/[^\s;]+/u, "link"],
  [/\d+(?:\.\d+)?\b/u, "number"],
  [/[A-Za-z_][\w'-]*(?:\.[A-Za-z_][\w'-]*)*(?=\s*=[^=])/u, "property"],
  [/==|!=|<=|>=|&&|\|\||->|\/\/|\+\+|[=:;?@!<>+*/-]/u, "operator"],
]);

/** The end of a nix string (`"..."` or `''...''`) at `i`, its `${...}` given to `inner`. */
function nixString(code: string, i: number, out: TokenRange[], ctx: TokenizerContext): number {
  const long = code.startsWith("''", i);
  let start = i;
  let j = i + (long ? 2 : 1);

  while (j < code.length) {
    if (long ? code.startsWith("''", j) && code[j + 2] !== "$" && code[j + 2] !== "'" : code[j] === '"') break;

    if (!long && code[j] === "\\") {
      j += 2;
      continue;
    }

    if (code.startsWith("${", j)) {
      out.push({ start, end: j + 2, className: "string" });
      let depth = 1;
      let k = j + 2;

      while (k < code.length && depth) {
        if (code[k] === "{") depth++;
        else if (code[k] === "}") depth--;
        k++;
      }

      for (const r of ctx.tokenize(code.slice(j + 2, k - 1), "nix")) out.push({ ...r, start: r.start + j + 2, end: r.end + j + 2 });
      start = k - 1;
      j = k;
      continue;
    }

    j++;
  }

  const end = Math.min(j + (long ? 2 : 1), code.length);
  out.push({ start, end, className: "string" });

  return end;
}

/** Nix. */
export const nix = defineLanguage({
  name: "nix",
  tokenize(code, ctx) {
    const out: TokenRange[] = [];
    let from = 0;
    let i = 0;

    const flush = (to: number): void => {
      for (const r of nixRules(code.slice(from, to))) out.push({ ...r, start: r.start + from, end: r.end + from });
    };

    while (i < code.length) {
      if (code[i] === "#") {
        const nl = code.indexOf("\n", i);
        i = nl < 0 ? code.length : nl;
        continue;
      }

      if (code[i] === '"' || code.startsWith("''", i)) {
        flush(i);
        i = from = nixString(code, i, out, ctx);
        continue;
      }

      i++;
    }

    flush(code.length);

    return out;
  },
});
