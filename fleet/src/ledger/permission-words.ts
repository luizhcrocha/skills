/**
 * A permission in plain words: the title, question and why the CLI writes for a call auto mode refused, the
 * classifier's category as what it means for the user, and the gist of the call (`vlmrun.py run`, not the
 * whole `cd …; timeout … sh -c '…'`). Pure, with no imports, so the page's browser bundle takes it as it is
 * (fleet/page/src/core.ts imports this file).
 *
 * The coordinator explains a permission after the hook opens it (the call, why the worker needs it, the cost
 * and risk, what a denial means, its recommendation); until then the page shows that it waits for that.
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

type Token = { readonly word: string } | { readonly op: string };

/** A shell command's words and operators; quotes are taken off, redirections and their targets dropped. */
function tokens(command: string): Token[] {
  const out: Token[] = [];
  let word = "";
  let has = false;
  let drop = false;

  const push = (): void => {
    if (has && !drop) out.push({ word });

    if (has) drop = false;
    word = "";
    has = false;
  };

  let i = 0;

  while (i < command.length) {
    const c = command[i] ?? "";
    const two = command.slice(i, i + 2);

    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end < 0 ? undefined : end);
      has = true;
      i = end < 0 ? command.length : end + 1;
    } else if (c === '"') {
      let j = i + 1;

      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) j += 1;
        word += command[j] ?? "";
        j += 1;
      }

      has = true;
      i = j + 1;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[i + 1] ?? "";
      has = true;
      i += 2;
    } else if (/\s/u.test(c)) {
      push();
      i += 1;
    } else if (c === ">" || c === "<" || two === "&>") {
      // A redirection: `2>&1` names no file; `> log`, `>> log`, `&> log` name one, which goes too.
      if (/^\d+$/u.test(word)) {
        word = "";
        has = false;
      } else push();
      i += two === "&>" || two === ">>" || two === "<<" ? 2 : 1;

      if (command[i] === "&") {
        i += 1;

        while (/[\d-]/u.test(command[i] ?? "")) i += 1;
      } else drop = true;
    } else if (two === "&&" || two === "||") {
      push();
      out.push({ op: two });
      i += 2;
    } else if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      push();
      out.push({ op: c });
      i += 1;
    } else {
      word += c;
      has = true;
      i += 1;
    }
  }

  push();

  return out;
}

/** The commands of a command line: its words between operators. */
function segments(command: string): string[][] {
  const out: string[][] = [[]];

  for (const t of tokens(command)) {
    if ("op" in t) out.push([]);
    else out.at(-1)?.push(t.word);
  }

  return out.filter((s) => s.length > 0);
}

const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "while", "until", "do", "for", "{", "time"]);

const CLOSERS = new Set(["done", "fi", "}", "esac"]);

const PLAIN_WRAPPERS = new Set(["nohup", "exec", "command", "sudo", "stdbuf", "caffeinate", "npx", "bunx", "pnpx", "xargs"]);

const INTERPRETERS = /^(?:python[\d.]*|node|bun|deno|ruby|perl|tsx|ts-node)$/u;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "nu", "fish"]);

/** `uv run`'s flags that take a value. */
const UV_VALUED = new Set(["--with", "--project", "--directory", "--python", "-p", "--package", "--env-file", "--extra", "--group", "--from"]);

const SIMPLE = /^[A-Za-z][\w.:-]*$/u;

function base(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");

  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** What a command line runs, past its wrappers: `vlmrun.py run` for `timeout 3000 secretspec run -- sh -c
 * 'cd x && uv run python -I vlmrun.py run'`, with the directories it changed into before it. */
interface Gist {
  readonly what: string | undefined;
  readonly cds: readonly string[];
}

function gistOf(command: string, depth = 0): Gist {
  const cds: string[] = [];

  for (const segment of segments(command)) {
    let words = [...segment];

    while (words.length > 0 && KEYWORDS.has(words[0] ?? "")) words = words.slice(1);

    if (words.length === 0 || CLOSERS.has(words[0] ?? "")) continue;
    const found = unwrap(words, depth);

    if ("cd" in found) {
      if (found.cd !== undefined) cds.push(found.cd);
      continue;
    }

    if ("inner" in found) {
      cds.push(...found.inner.cds);

      if (found.inner.what !== undefined) return { what: found.inner.what, cds };
      continue;
    }

    return { what: found.what, cds };
  }

  return { what: undefined, cds };
}

type Unwrapped = { readonly cd: string | undefined } | { readonly inner: Gist } | { readonly what: string };

/** One command's program and its first plain words, past `VAR=x`, `timeout`, `env`, `secretspec run --`, `uv
 * run`, an interpreter and its flags; `sh -c '…'` is read as a command line of its own. */
function unwrap(given: readonly string[], depth: number): Unwrapped {
  let words = [...given];

  const flags = (valued: ReadonlySet<string> = new Set()): void => {
    while (words.length > 0 && (words[0] ?? "").startsWith("-") && words[0] !== "--") {
      const flag = words[0] ?? "";
      words = words.slice(valued.has(flag) ? 2 : 1);
    }
  };

  for (;;) {
    while (words.length > 0 && /^[A-Za-z_]\w*=/u.test(words[0] ?? "")) words = words.slice(1);
    const head = words[0];

    if (head === undefined) return { cd: undefined };
    const name = base(head);

    if (name === "cd" || name === "pushd") return { cd: words.find((w, i) => i > 0 && !w.startsWith("-")) };

    if (name === "timeout") {
      words = words.slice(1);
      flags(new Set(["-s", "--signal", "-k", "--kill-after"]));
      words = words.slice(1);
    } else if (name === "nice") {
      words = words.slice(1);
      flags(new Set(["-n"]));
    } else if (name === "env") {
      words = words.slice(1);
      flags(new Set(["-u", "-C"]));
    } else if (PLAIN_WRAPPERS.has(name)) {
      words = words.slice(1);
      flags();
    } else if (words[1] === "run" && ["secretspec", "op", "dotenv", "doppler"].includes(name)) {
      const dashes = words.indexOf("--");
      words = dashes < 0 ? words.slice(2) : words.slice(dashes + 1);

      if (dashes < 0) flags();
    } else if (name === "uv" && words[1] === "run") {
      words = words.slice(2);
      flags(UV_VALUED);
    } else if (SHELLS.has(name)) {
      const c = words.findIndex((w, i) => i > 0 && /^-\w*c$/u.test(w));
      const script = c < 0 ? undefined : words[c + 1];

      if (script !== undefined && depth < 4) return { inner: gistOf(script, depth + 1) };
      words = words.slice(1);
      flags();
    } else if (INTERPRETERS.test(name)) {
      words = words.slice(1);

      if (name === "bun" && words[0] === "run") words = words.slice(1);
      flags(new Set(["-X", "-W"]));

      if (words[0] === "-m") words = words.slice(1);
    } else {
      const shown = [name];

      for (const w of words.slice(1)) {
        if (shown.length >= 3 || !SIMPLE.test(w)) break;
        shown.push(w);
      }

      return { what: shown.join(" ") };
    }
  }
}

/** The folders a Bash call changes into before what it runs, as written: the session's workspace in
 * `cd /repo-m1; …` tells which worker made it. */
export function foldersOf(call: string): readonly string[] {
  return gistOf(call).cds;
}

/** A call's gist cut to `max` characters. */
function cut(text: string, max: number): string {
  const one = text.replace(/\s+/gu, " ").trim();

  return [...one].length > max ? [...one].slice(0, max - 1).join("") + "…" : one;
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

/** Where a lane's work is, as a word: `lab-sameness` for `servers/case-analysis/tasks/lab-sameness/**`. */
function laneWord(lane: readonly string[]): string | undefined {
  for (const entry of lane.flatMap((l) => l.split(","))) {
    const path = entry.trim().replace(/(?:\/\*+)+$/u, "").replace(/\*+$/u, "");

    if (path === "" || /\s|read-only|^none/u.test(path)) continue;
    const word = base(path).replace(/[-_.]+$/u, "");

    if (word !== "") return word;
  }

  return undefined;
}

/** Where the call runs, as a word: the folder it changed into last, unless that is the session root or a worker's
 * workspace beside it (`<root>-<id>`); else the worker's lane. */
function placeOf(cds: readonly string[], root: string, by: RefusedBy | undefined): string | undefined {
  const rootBase = base(root);
  const last = cds.at(-1);

  if (last !== undefined && !last.startsWith("$") && !last.startsWith("~")) {
    const word = base(last);

    if (word !== "" && word !== "." && word !== ".." && !(last.startsWith("/") && word.startsWith(rootBase))) return word;
  }

  return by === undefined ? undefined : laneWord(by.lane);
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
  if (by !== undefined && by.name.trim() !== "") return by.name.trim();

  return r.agent_id === null ? `the ${host}` : "a worker";
}

/** The words a permission opens with, written from its call: its title, question and why. */
export interface PermissionWords {
  readonly title: string;
  readonly question: string;
  readonly why: string;
}

/** A permission's title, question and why: "Allow <who> to run `vlmrun.py run` (lab-sameness)?", the ask in one
 * sentence, and the classifier's category in plain words. */
export function permissionWords(r: RefusalFacts, by: RefusedBy | undefined, host: string, spawn: Spawn = { type: "general-purpose", description: "" }): PermissionWords {
  const who = whoRefused(r, by, host);
  const why = `Auto mode stopped this call: ${plainCause(r.cause)}. Only you can let it through.`;

  if (r.tool === "Agent") {
    const what = spawn.description === "" ? "an agent" : `the agent “${cut(spawn.description, 60)}”`;

    return {
      title: `Allow ${who} to start ${what}?`,
      question: `Let ${who} start this exact ${spawn.type} agent once?`,
      why,
    };
  }

  const gist = gistOf(r.call);
  const what = cut(gist.what ?? r.call, 40);
  const place = placeOf(gist.cds, r.root, by);
  const where = place === undefined || place === what ? "" : ` (${place})`;

  return {
    title: `Allow ${who} to run \`${what}\`${where}?`,
    question: `Let ${who} run this exact call once? It runs \`${what}\`${place === undefined || place === what ? "" : ` in ${place}`}.`,
    why,
  };
}
