/**
 * A permission in plain words: the title, question and why the CLI writes for a call auto mode refused, and the
 * classifier's category as what it means for the user. Pure, with no imports, so the page's browser bundle
 * takes it as it is (fleet/page/src/core.ts imports this file).
 *
 * The words never understate the call. Only a simple call gets a summary: one command, after at most one
 * `cd <path> &&` or `cd <path>;`, with no operator, substitution, redirection to a file, sudo or inline code,
 * and no text that expands at run time (a variable or a brace expansion anywhere, a glob as the program).
 * Its summary is the whole command line after `timeout N`, `secretspec run --` and `uv run`, every flag kept.
 * Any other call is named a compound command with its count of parts and the risky things found in it, never
 * by its first part. The page shows the exact call above the answer buttons either way.
 */

/** The classifier's categories as what they mean for the user, each a clause that starts with "it". */
const CAUSES: readonly (readonly [RegExp, string])[] = [
  [/real[- ]world transactions?/iu, "it may spend money or act outside this machine"],
  [/production reads?/iu, "it reads live production data"],
  [/production (?:writes?|changes?|deploy)/iu, "it changes live production systems"],
  [/\bpii\b|personal data/iu, "it handles personal data about people"],
  [/shared resources?/iu, "it changes something other people or systems share"],
  [/credential/iu, "it looks at passwords, tokens or keys"],
  [/sensitive[- ]source/iu, "it uses data from a sensitive source"],
  [/git destructive/iu, "it can erase work in git: history or changes not yet saved"],
  [/classifier unavailable/iu, "its safety check was down, so it stopped the call to be safe"],
  [/permission grant/iu, "it changes what agents are allowed to do"],
  [/exfiltrat/iu, "it may send data off this machine"],
  [/destructive|delet/iu, "it deletes or overwrites things"],
];

/** The category a cause names: `[Real-World Transactions]`, or `auto mode classifier: Production Reads (…)`. */
function categoryOf(cause: string): string {
  const bracketed = /\[([^\]]+)\]/u.exec(cause)?.[1];

  if (bracketed !== undefined) return bracketed.trim();

  return cause
    .replace(/^auto mode classifier:\s*/iu, "")
    .replace(/\s*\(.*$/su, "")
    .trim();
}

/** What the classifier's `cause` means for the user, as a clause that starts with "it" ("it may spend money
 * or act outside this machine"); a category this list does not know is named as auto mode's own check. */
export function plainCause(cause: string): string {
  const category = categoryOf(cause);

  for (const [pattern, words] of CAUSES) if (pattern.test(category)) return words;

  return category === "" ? "it is a kind of call auto mode does not run on its own" : `it falls under the “${category}” check`;
}

/** Whether a code point hides or reorders text: a C0 control but tab, DEL, a C1 control, or a bidi mark,
 * embedding, override or isolate. */
function hides(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** `text` with each character that hides or reorders it on a screen (`hides`) written out as `\u{…}`. */
export function showHidden(text: string): string {
  let out = "";

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += hides(code) ? `\\u{${code.toString(16).toUpperCase()}}` : ch;
  }

  return out;
}

/** `text` without the characters that hide or reorder it on a screen (`hides`). */
export function stripHidden(text: string): string {
  let out = "";

  for (const ch of text) if (!hides(ch.codePointAt(0) ?? 0)) out += ch;

  return out;
}

function hasHidden(text: string): boolean {
  for (const ch of text) if (hides(ch.codePointAt(0) ?? 0)) return true;

  return false;
}

/** A word of a command line: its text with the quotes taken off, and where it stands in the line. */
interface Word {
  readonly text: string;
  readonly start: number;
  /** The word as written, quotes and all. */
  readonly raw: string;
}

/** What of a word the shell expands as it runs it: its unquoted characters (each quoted or escaped one as
 * `_`), where a brace or a glob is live, and whether a `$` outside single quotes reads a variable. */
interface Live {
  readonly bare: string;
  readonly dollar: boolean;
}

function liveOf(raw: string): Live {
  let bare = "";
  let dollar = false;
  let i = 0;
  const reads = (at: number): boolean => raw[at] === "$" && /[A-Za-z_{0-9@*#?$!-]/u.test(raw[at + 1] ?? "");

  while (i < raw.length) {
    const c = raw[i] ?? "";

    if (c === "'") {
      const end = raw.indexOf("'", i + 1);
      const stop = end < 0 ? raw.length : end + 1;
      bare += "_".repeat(stop - i);
      i = stop;
    } else if (c === '"') {
      let j = i + 1;

      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === "\\") j += 1;
        else if (reads(j)) dollar = true;
        j += 1;
      }

      const stop = Math.min(raw.length, j + 1);
      bare += "_".repeat(stop - i);
      i = stop;
    } else if (c === "\\") {
      bare += "__";
      i += 2;
    } else {
      if (reads(i)) dollar = true;
      bare += c;
      i += 1;
    }
  }

  return { bare, dollar };
}

/** The words of one command whose text expands at run time, so what runs is not what the call reads: a
 * variable (`$B`, `"$@"`, `${X}`) or a brace expansion anywhere, a glob as the program. */
function expandsIn(words: readonly Word[]): string[] {
  const out: string[] = [];
  const live = words.map((w) => liveOf(w.raw));
  let at = 0;

  while (at < words.length && /^[A-Za-z_]\w*=/u.test(words[at]?.text ?? "") && !live[at]?.dollar) at += 1;
  const program = new Set([0, at, at + wrappersIn(words.slice(at).map((w) => w.text))]);

  words.forEach((w, i) => {
    const l = live[i];

    if (l === undefined) return;
    const brace = /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/u.test(l.bare);
    const glob = program.has(i) && w.raw !== "[" && /[?*[]/u.test(l.bare);

    if (l.dollar || brace || glob) out.push(w.raw);
  });

  return out;
}

/** A redirection: its operator (`>`, `2>>`, `<<`, `2>&1`), its target, and whether it only copies a stream
 * onto another (`2>&1`, `>&-`), which names no file. */
interface Redirect {
  readonly op: string;
  readonly target: string;
  readonly dup: boolean;
}

type Token = { readonly word: Word } | { readonly op: string } | { readonly redirect: Redirect };

/** A command line read as a shell would split it: its tokens, the scripts it substitutes (`$(…)`, backticks,
 * `<(…)`), and what it holds that this reading cannot follow (an unclosed quote, `$'…'`). */
interface Lexed {
  readonly tokens: readonly Token[];
  readonly subs: readonly string[];
  readonly marks: readonly string[];
}

/** The index just past the `)` that closes the `(` at `open`, skipping quoted text; the line's end when none does. */
function closing(command: string, open: number): number {
  let depth = 0;
  let i = open;

  while (i < command.length) {
    const c = command[i];

    if (c === "\\") i += 2;
    else if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      i = end < 0 ? command.length : end + 1;
    } else {
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;

        if (depth === 0) return i + 1;
      }

      i += 1;
    }
  }

  return command.length;
}

const REDIRECT = /^(?:&>>|&>|<<<|<<-|<<|<>|<&|<\(|<|>>|>&|>\||>\(|>)/u;

function lex(command: string): Lexed {
  const tokens: Token[] = [];
  const subs: string[] = [];
  const marks: string[] = [];
  let word = "";
  let start = -1;
  let redirect: string | undefined;
  let i = 0;

  const begin = (): void => {
    if (start < 0) start = i;
  };

  const push = (): void => {
    if (start >= 0) {
      if (redirect !== undefined) tokens.push({ redirect: { op: redirect, target: word, dup: false } });
      else tokens.push({ word: { text: word, start, raw: command.slice(start, i) } });
      redirect = undefined;
    }

    word = "";
    start = -1;
  };

  /** The `$(…)` at `i`, kept in the word and read as a script of its own. */
  const substitution = (): void => {
    const end = closing(command, i + 1);

    if (command[end - 1] !== ")") marks.push("unclosed (");
    subs.push(command.slice(i + 2, end - 1));
    word += command.slice(i, end);
    i = end;
  };

  /** The backtick script at `i`, kept in the word and read as a script of its own. */
  const backticks = (): void => {
    const end = command.indexOf("`", i + 1);

    if (end < 0) marks.push("unclosed quote");
    subs.push(command.slice(i + 1, end < 0 ? undefined : end));
    word += command.slice(i, end < 0 ? undefined : end + 1);
    i = end < 0 ? command.length : end + 1;
  };

  while (i < command.length) {
    const c = command[i] ?? "";
    const next = command[i + 1] ?? "";
    const two = c + next;

    if (c === "'") {
      begin();
      const end = command.indexOf("'", i + 1);

      if (end < 0) marks.push("unclosed quote");
      word += command.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? command.length : end + 1;
    } else if (c === '"') {
      begin();
      i += 1;

      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          word += command[i + 1] ?? "";
          i += 2;
        } else if (command[i] === "`") backticks();
        else if (command.startsWith("$(", i)) substitution();
        else {
          word += command[i] ?? "";
          i += 1;
        }
      }

      if (i >= command.length) marks.push("unclosed quote");
      i += 1;
    } else if (c === "\\") {
      begin();
      word += next;
      i += 2;
    } else if (c === "`") {
      begin();
      backticks();
    } else if (two === "$(") {
      begin();
      substitution();
    } else if (two === "$'" || two === '$"') {
      begin();
      marks.push("$'…' quoting");
      i += 1;
    } else if (c === "\n" || c === "\r") {
      push();
      tokens.push({ op: ";" });
      i += 1;
    } else if (/\s/u.test(c)) {
      push();
      i += 1;
    } else if (c === "<" || c === ">" || two === "&>") {
      // `2>` takes the digits before it as its stream; `a2>` does not.
      let fd = "";

      if (start >= 0 && /^\d+$/u.test(word) && command.slice(start, i) === word) {
        fd = word;
        word = "";
        start = -1;
      } else push();
      const op = REDIRECT.exec(command.slice(i))?.[0] ?? c;

      if (op === "<(" || op === ">(") {
        begin();
        marks.push("process substitution");
        const end = closing(command, i + 1);
        subs.push(command.slice(i + 2, end - 1));
        word += command.slice(i, end);
        i = end;
      } else if ((op === ">&" || op === "<&") && /^(?:\d+|-)(?![\w./~-])/u.test(command.slice(i + 2))) {
        const target = /^(?:\d+|-)/u.exec(command.slice(i + 2))?.[0] ?? "";
        tokens.push({ redirect: { op: fd + op + target, target: "&" + target, dup: true } });
        i += 2 + target.length;
      } else {
        push();
        redirect = fd + op;
        i += op.length;
      }
    } else if (two === "&&" || two === "||" || two === ";;" || two === "|&") {
      push();
      tokens.push({ op: two });
      i += 2;
    } else if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      push();
      tokens.push({ op: c });
      i += 1;
    } else {
      begin();
      word += c;
      i += 1;
    }
  }

  push();

  if (redirect !== undefined) tokens.push({ redirect: { op: redirect, target: "", dup: false } });

  return { tokens, subs, marks };
}

/** One command of a command line: its words, its redirections, and the operator before it (`|`, `&&`, …). */
interface Segment {
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
  readonly after: string | undefined;
  readonly before: string | undefined;
}

function segmentsOf(tokens: readonly Token[]): Segment[] {
  const out: Segment[] = [];
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let after: string | undefined;

  const close = (before: string | undefined): void => {
    if (words.length > 0 || redirects.length > 0) out.push({ words, redirects, after, before });
    words = [];
    redirects = [];
  };

  for (const t of tokens) {
    if ("op" in t) {
      close(t.op);
      after = t.op;
    } else if ("word" in t) words.push(t.word);
    else redirects.push(t.redirect);
  }

  close(undefined);

  return out;
}

function base(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");

  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** Shell words that open or close a compound command; a loop's or a case's head is no command of its own. */
const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "{", "}", "[[", "]]", "coproc"]);

const HEADS = new Set(["for", "select", "case", "function"]);

const MARKED_KEYWORDS = new Set(["if", "for", "while", "until", "case", "select", "function", "coproc"]);

/** Programs that run another command as someone else or from their input. */
const ELEVATORS = new Set(["sudo", "doas", "run0", "pkexec", "su"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "nu", "busybox"]);

const NETWORK = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet"]);

const NAMED = new Set(["dd", "chmod", "chown", "kill", "pkill", "killall", "shutdown", "reboot", "kubectl", "psql", "mysql", "aws", "gcloud", "op", "truncate", "shred"]);

/** Flags of a Python interpreter that take a value. */
const PY_VALUED = new Set(["-W", "-X", "-Q"]);

/** Flags of Node, Bun and Deno that take a value. */
const JS_VALUED = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions"]);

/** The leading flags of the program at `at`, skipping the values of `valued`. */
function leadingFlags(words: readonly string[], at: number, valued: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  let i = at + 1;

  while (i < words.length && (words[i] ?? "").startsWith("-") && words[i] !== "--" && words[i] !== "-") {
    const flag = words[i] ?? "";
    out.push(flag);
    i += valued.has(flag) ? 2 : 1;
  }

  return out;
}

/** Inline code a command runs (`sh -c '…'`, `python3 -c '…'`, `node -e '…'`, `eval '…'`): its marker and,
 * for a shell or eval, the script, read as a command line of its own. */
interface Inline {
  readonly mark: string;
  readonly script: string | undefined;
}

function inlineOf(words: readonly string[]): Inline | undefined {
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? "";
    const name = base(w);

    if (name === "eval") return { mark: "eval", script: words.slice(i + 1).join(" ") };

    if (SHELLS.has(name)) {
      const flags = leadingFlags(words, i);
      const at = flags.findIndex((f) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(f) || f === "--command");

      if (at >= 0) return { mark: `${name} -c`, script: words[i + 1 + at + 1] ?? "" };
    }

    if (/^(?:python|pypy)[\d.]*$/u.test(name) && leadingFlags(words, i, PY_VALUED).some((f) => /^-[A-Za-z]*c$/u.test(f))) return { mark: `${name} -c`, script: undefined };

    if (/^(?:node|nodejs|bun|deno|tsx)$/u.test(name)) {
      if (name === "deno" && words[i + 1] === "eval") return { mark: "deno eval", script: undefined };

      if (leadingFlags(words, i, JS_VALUED).some((f) => /^-[a-z]*[ep]$|^--(?:eval|print)(?:=|$)/u.test(f))) return { mark: `${name} -e`, script: undefined };
    }

    if (/^(?:perl|ruby|lua|php|osascript|awk|gawk)$/u.test(name) && leadingFlags(words, i).some((f) => /^-[A-Za-z]*[eEr]$/u.test(f))) return { mark: `${name} -e`, script: undefined };
  }

  return undefined;
}

/** The risky things one command does, as markers: `rm -rf`, `git push --force`, `curl`, `sudo`. */
function risksOf(words: readonly string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < words.length; i += 1) {
    const name = base(words[i] ?? "");

    if (ELEVATORS.has(name) || name === "xargs") out.push(name);
    else if (name === "rm") {
      const flags = leadingFlags(words, i);
      out.push(flags.length > 0 ? `rm ${flags.join(" ")}` : "rm");
    } else if (name === "git") {
      const rest = words.slice(i + 1);

      if (rest.includes("push") && rest.some((w) => /^(?:-f|--force(?:-with-lease)?(?:=.*)?|\+.+)$/u.test(w))) out.push("git push --force");
      else if (rest.includes("reset") && rest.includes("--hard")) out.push("git reset --hard");
      else if (rest.includes("clean")) out.push("git clean");
    } else if (NETWORK.has(name) || NAMED.has(name) || name.startsWith("mkfs")) out.push(name);
  }

  return out;
}

/** What a compound command line holds: how many commands, the risky things found, and the folders it
 * changes into, as written. */
interface Scan {
  readonly parts: number;
  readonly marks: readonly string[];
  readonly cds: readonly string[];
}

function scan(command: string, depth = 0): Scan {
  const lexed = lex(command);
  const marks: string[] = [...lexed.marks];
  const cds: string[] = [];
  let parts = 0;

  // A newline shows on the page; a carriage return or a bidi override does not.
  if (hasHidden(command.replaceAll("\n", ""))) marks.push("hidden characters");

  if (command.includes("`") && lexed.subs.length === 0) marks.push("backticks");

  const inner = (script: string): void => {
    if (depth >= 4) {
      parts += 1;

      return;
    }

    const s = scan(script, depth + 1);
    parts += Math.max(1, s.parts);
    marks.push(...s.marks);
    cds.push(...s.cds);
  };

  for (const sub of lexed.subs) {
    marks.push("command substitution");
    inner(sub);
  }

  for (const seg of segmentsOf(lexed.tokens)) {
    if (seg.after === "|" || seg.after === "|&") marks.push(`pipe to ${base(seg.words.find((w) => !KEYWORDS.has(w.text))?.text ?? "a command")}`);

    if (seg.before === "&") marks.push("background &");

    if (seg.after === "(") marks.push("subshell");

    for (const r of seg.redirects) {
      if (r.dup) continue;

      if (r.op.endsWith("<<") || r.op.endsWith("<<-")) marks.push("heredoc");
      else if (r.op.endsWith("<<<")) marks.push("here-string");
      else if (r.op.startsWith("<") || /^\d*<[>&]?$/u.test(r.op)) marks.push(`redirect from ${r.target}`);
      else marks.push(`redirect to ${r.target}`);
    }

    let words = seg.words.map((w) => w.text);
    let head = false;

    while (words.length > 0 && KEYWORDS.has(words[0] ?? "")) {
      if (MARKED_KEYWORDS.has(words[0] ?? "")) marks.push(words[0] ?? "");

      head ||= HEADS.has(words[0] ?? "");
      words = words.slice(1);
    }

    if (words.length === 0 || head) continue;

    if (words[0] === "cd" || words[0] === "pushd") {
      const to = words.slice(1).find((w) => !w.startsWith("-"));

      if (to !== undefined) cds.push(to);
    }

    const code = inlineOf(words);
    marks.push(...risksOf(words));
    marks.push(...expandsIn(seg.words.slice(seg.words.length - words.length)).map((w) => `expands at run time: ${w}`));

    if (code !== undefined) {
      marks.push(code.mark);

      if (code.script !== undefined) {
        inner(code.script);
        continue;
      }
    }

    parts += 1;
  }

  return { parts, marks, cds };
}

/** A simple call: what it runs, the folder its one leading `cd` changes into, and the command's own words. */
interface Simple {
  readonly gist: string;
  readonly cd: string | undefined;
  readonly words: readonly string[];
}

/** The number of leading words that are wrappers a summary leaves out: `timeout N`, `secretspec run --`,
 * `uv run` (without flags of its own, which may add packages). */
function wrappersIn(words: readonly string[]): number {
  let k = 0;

  for (;;) {
    const w = words[k];

    if (w === "timeout") {
      let j = k + 1;

      while ((words[j] ?? "").startsWith("-")) j += ["-s", "--signal", "-k", "--kill-after"].includes(words[j] ?? "") ? 2 : 1;

      if (!/^\d+(?:\.\d+)?[smhd]?$/u.test(words[j] ?? "")) return k;
      k = j + 1;
    } else if (w === "secretspec" && words[k + 1] === "run" && words[k + 2] === "--") k += 3;
    else if (w === "uv" && words[k + 1] === "run" && words[k + 2] !== undefined && !(words[k + 2] ?? "").startsWith("-")) k += 2;
    else return k;
  }
}

/** The call as a simple one, or undefined when it is not: one command, after at most one `cd <path> &&` or
 * `cd <path>;`, with no other operator, no substitution or backtick, no redirection to or from a file (`2>&1`
 * copies a stream and names none), no sudo, eval or xargs, no inline code, no compound keyword. */
function simpleOf(command: string): Simple | undefined {
  if (hasHidden(command) || command.includes("`")) return undefined;
  const lexed = lex(command);

  if (lexed.marks.length > 0 || lexed.subs.length > 0) return undefined;
  const ops = lexed.tokens.filter((t) => "op" in t).map((t) => ("op" in t ? t.op : ""));
  const segs = segmentsOf(lexed.tokens);

  if (segs.some((s) => s.redirects.some((r) => !r.dup))) return undefined;
  let cd: string | undefined;
  let seg = segs[0];

  if (segs.length === 2 && ops.length === 1 && (ops[0] === "&&" || ops[0] === ";")) {
    const first = segs[0]?.words.map((w) => w.text) ?? [];

    if (first.length !== 2 || first[0] !== "cd" || (first[1] ?? "").startsWith("-") || (segs[0]?.redirects.length ?? 0) > 0) return undefined;

    if (expandsIn(segs[0]?.words ?? []).length > 0) return undefined;
    cd = first[1];
    seg = segs[1];
  } else if (segs.length !== 1 || ops.length > 0) return undefined;

  const words = seg?.words.map((w) => w.text) ?? [];

  if (seg === undefined || words.length === 0 || KEYWORDS.has(words[0] ?? "") || words[0] === "cd" || words[0] === "pushd") return undefined;

  if (inlineOf(words) !== undefined || words.some((w) => ELEVATORS.has(base(w)) || base(w) === "xargs" || base(w) === "eval")) return undefined;

  if (expandsIn(seg.words).length > 0) return undefined;
  const skip = wrappersIn(words);
  const from = seg.words[skip < words.length ? skip : 0]?.start ?? 0;

  return { gist: command.slice(from).replace(/\s+/gu, " ").trim(), cd, words: words.slice(skip < words.length ? skip : 0) };
}

/** The folders a Bash call changes into before what it runs, as written, at every level (`sh -c '…'`
 * too): the session's workspace in `cd /repo-m1; …` tells which worker made it. */
export function foldersOf(call: string): readonly string[] {
  return scan(call).cds;
}

/** A path's parts, `.` and `..` resolved: `/a/b/../c` is `["a", "c"]`. */
function components(path: string): string[] {
  const out: string[] = [];

  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;

    if (part === "..") out.pop();
    else out.push(part);
  }

  return out;
}

/** Flags that point a command at another folder than the one it runs in. */
const ELSEWHERE_FLAGS = /^(?:-C|--cwd|--directory|--dir|--prefix|--project|--git-dir|--work-tree|--root|--manifest-path|-chdir)(?:=|$)/u;

/** Whether a command's arguments reach outside the folder it runs in: another folder by flag (`-C`), an
 * absolute or home path, a `..`, or a variable that may hold any of these. */
function leaves(args: readonly string[]): boolean {
  return args.some((w) => ELSEWHERE_FLAGS.test(w) || /(?:^|[=:,])[/~$]/u.test(w) || /(?:^|[/=])\.\.(?:\/|$)/u.test(w));
}

/** Where a simple call runs, in words: the folder its `cd` changes into, relative to the session root when
 * inside it (by path parts, so `/r/repo-evil` is not inside `/r/repo`), else in full; nothing when it has no
 * `cd`, or its command then works outside that folder. */
function placeOf(simple: Simple, root: string): string | undefined {
  const cd = simple.cd;

  if (cd === undefined || leaves(simple.words.slice(1))) return undefined;

  if (!cd.startsWith("/")) return cd;
  const parts = components(cd);
  const rootParts = components(root);

  if (rootParts.length <= parts.length && rootParts.every((p, i) => parts[i] === p)) {
    const rel = parts.slice(rootParts.length).join("/");

    return rel === "" ? "the repo root" : rel;
  }

  return "/" + parts.join("/");
}

/** `text` on one line, cut to `max` characters with "…". */
function cut(text: string, max: number): string {
  const one = text.replace(/\s+/gu, " ").trim();

  return [...one].length > max ? [...one].slice(0, max - 1).join("") + "…" : one;
}

/** The most markers a compound command's title lists. */
const MARKS_SHOWN = 6;

/** A compound call's markers as a list: each once, in the order found. */
function markList(marks: readonly string[]): string {
  const seen = [...new Set(marks.map((m) => cut(m, 40)))];
  const shown = seen.slice(0, MARKS_SHOWN);

  return seen.length > MARKS_SHOWN ? `${shown.join(", ")} and ${String(seen.length - MARKS_SHOWN)} more` : shown.join(", ");
}

/** The worker a refused call came from, as the ledger records it. */
export interface RefusedBy {
  readonly name: string;
  readonly lane: readonly string[];
}

/** The refused call, as a permission records it. */
export interface RefusalFacts {
  readonly tool: string;
  readonly call: string;
  readonly cause: string;
  readonly root: string;
  readonly agent_id: string | null;
}

/** A refused spawn as the caller read it from the Agent call's input: its agent type and description (the
 * prompt's first line when it has none). */
export interface Spawn {
  readonly type: string;
  readonly description: string;
}

/** Who the refused call came from, in words: the worker's name, else "a worker" for a subagent the ledger does
 * not know, else the session's `host` (its main thread). Never the harness's agent id. */
export function whoRefused(r: Pick<RefusalFacts, "agent_id">, by: RefusedBy | undefined, host: string): string {
  if (by !== undefined && by.name.trim() !== "") return stripHidden(by.name).trim();

  return r.agent_id === null ? `the ${host}` : "a worker";
}

/** The words a permission opens with, written from its call: its title, question and why. */
export interface PermissionWords {
  readonly title: string;
  readonly question: string;
  readonly why: string;
}

/** The longest summary of a simple call. */
const GIST_MAX = 100;

/** A permission's title, question and why. A simple call: "Allow <who> to run `<its command line>` in
 * <folder>?"; any other: "Allow <who> to run a compound command (<N> parts, <risky markers>)?"; a spawn names
 * its description as the worker's words. Without the characters that hide or reorder text. */
export function permissionWords(r: RefusalFacts, by: RefusedBy | undefined, host: string, spawn: Spawn = { type: "general-purpose", description: "" }): PermissionWords {
  const who = whoRefused(r, by, host);
  const why = `Auto mode stopped this call: ${plainCause(r.cause)}. Only you can let it through.`;
  const clean = (w: PermissionWords): PermissionWords => ({ title: stripHidden(w.title), question: stripHidden(w.question), why: stripHidden(w.why) });

  if (r.tool === "Agent") {
    const describer = by === undefined && r.agent_id === null ? who : "the worker";
    const said = cut(stripHidden(spawn.description), 60);
    const described = said === "" ? "" : `, described by ${describer} as “${said}”`;

    return clean({
      title: `Allow ${who} to start a ${cut(spawn.type, 40)} agent${described}?`,
      question: `Let ${who} start this exact ${cut(spawn.type, 40)} agent once? Read its input in full below before you answer.`,
      why,
    });
  }

  const simple = simpleOf(r.call);

  if (simple !== undefined) {
    const what = cut(simple.gist, GIST_MAX);
    const place = placeOf(simple, r.root);
    const where = (place === undefined ? "" : ` in ${place}`) + (what === simple.gist ? "" : " (cut, see the exact call)");

    return clean({
      title: `Allow ${who} to run \`${what}\`${where}?`,
      question: `Let ${who} run this exact call once? It runs \`${what}\`${where}.`,
      why,
    });
  }

  const found = scan(r.call);
  const parts = Math.max(1, found.parts);
  const count = `${String(parts)} ${parts === 1 ? "part" : "parts"}`;
  const marks = markList(found.marks);

  return clean({
    title: `Allow ${who} to run a compound command (${count}${marks === "" ? "" : `, ${marks}`})?`,
    question: `Let ${who} run this exact call once? It is a compound command of ${count}: read the exact call in full below before you answer.`,
    why,
  });
}
