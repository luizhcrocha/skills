/**
 * `fleet search WORDS...`: find a fleet command by what it does. The index is built from every command's
 * help ({@link fleetCommands}): one entry per command and one per subcommand its help names, ranked by the
 * words they share with the query, a word in the name counting three times.
 */
import * as Effect from "effect/Effect";

import { Out } from "../io.ts";
import type { World } from "../world.ts";
import { COMMAND_NAMES, fleetCommands, oneLine, SEARCH_HELP, summaryOf, type FleetCommand } from "./commands.ts";

/** One searchable command line. */
export interface SearchEntry {
  readonly command: string;
  readonly verb: string | undefined;
  /** What is printed: `fleet COMMAND [DIR] VERB ARGS`. */
  readonly line: string;
  readonly summary: string;
  /** Every word of its help that is not its name: the summary, the arguments, the options. */
  readonly text: string;
}

/** How many entries a search prints. */
const TOP = 5;

const NAME_WEIGHT = 3;

/** Words a query uses that say nothing about a command. */
const STOP = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "it", "how", "do", "i", "my", "what", "with"]);

const VERB = /^[a-z][a-z-]*$/;

/** The lowercase words of `text`. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Whether a query word names this word: the same, its prefix (4 letters or more), or it plus a suffix of 1 or 2 (`workspaces`). */
function fits(term: string, word: string): boolean {
  return term === word || (term.length >= 4 && word.startsWith(term)) || (word.length >= 4 && term.length - word.length <= 2 && term.startsWith(word));
}

/** `text` split on ` | ` and `; ` outside brackets. */
function alternatives(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === "[" || ch === "{" || ch === "(") depth++;
    else if (ch === "]" || ch === "}" || ch === ")") depth--;
    else if (depth === 0 && (text.startsWith(" | ", i) || text.startsWith("; ", i))) {
      parts.push(text.slice(from, i));
      from = i + (ch === ";" ? 2 : 3);
      i = from - 1;
    }
  }

  parts.push(text.slice(from));

  return parts.flatMap((p) => (p.trim() === "" ? [] : [p.trim()]));
}

/** A usage piece without `fleet COMMAND`, split into its uppercase prefix (DIR, PROJECT) and the rest. */
/** A usage piece's uppercase prefix and the rest of its tokens. */
interface Piece {
  readonly prefix: string[];
  readonly rest: string[];
}

function stripped(piece: string, command: string): Piece {
  const tokens = piece.split(" ").filter((t) => t !== "");

  if (tokens[0] === "fleet") tokens.splice(0, tokens[1] === command ? 2 : 1);
  const prefix: string[] = [];

  while (tokens[0] !== undefined && /^[A-Z_]+$/.test(tokens[0]) && tokens[0] !== "COMMAND") prefix.push(tokens.shift() ?? "");

  if (tokens[0] === "[-h]") tokens.shift();

  return { prefix, rest: tokens };
}

/** The entries one command's help gives: the command itself, then each subcommand it names. */
export function entriesOf(command: FleetCommand): SearchEntry[] {
  const name = command.name;
  const lines = command.help.split("\n");
  const summary = summaryOf(command);
  const usages = lines.filter((l) => l.startsWith("usage: ")).map((l) => l.slice("usage: ".length));
  const first = stripped(usages[0] ?? "", name);
  const prefix = first.prefix;
  const head = (more: readonly string[]): string => ["fleet", name, ...more].join(" ").replace(/\s+/g, " ");
  const verbs = new Set<string>();
  const pieces: { readonly verb: string; readonly line: string }[] = [];

  for (const usage of usages) {
    const body = stripped(usage, name);
    const braces = /^\{([a-z,-]+)\}/.exec(body.rest[0] ?? "");

    if (braces?.[1] !== undefined) {
      for (const v of braces[1].split(",")) verbs.add(v);

      continue;
    }

    for (const [i, alt] of alternatives(body.rest.join(" ")).entries()) {
      const piece = i === 0 ? { prefix: body.prefix, rest: alt.split(" ") } : stripped(alt, name);
      const verb = piece?.rest[0];

      if (verb === undefined || !VERB.test(verb)) continue;
      verbs.add(verb);
      pieces.push({ verb, line: head([...(i > 0 && alt.startsWith("fleet ") ? piece.prefix : body.prefix), ...piece.rest]) });
    }
  }

  const listed = /^Commands: ([a-z, -]+)\./m.exec(command.help)?.[1];

  for (const v of listed?.split(", ") ?? []) verbs.add(v);

  const entries: SearchEntry[] = [
    { command: name, verb: undefined, line: head([...prefix, ...(verbs.size > 0 ? ["…"] : first.rest)]), summary, text: `${summary} ${usages.join(" ")}` },
  ];

  const described = new Set<string>();

  // The indent of the subcommand line whose continuation lines follow, so a continuation that starts with a
  // subcommand's name (tab's "run COMMAND in tab …") is not one.
  let block = -1;

  for (const [i, raw] of lines.entries()) {
    const indent = /^\s*/.exec(raw)?.[0].length ?? 0;
    const verb = raw.trim().split(" ")[0] ?? "";

    if (block >= 0 && indent > block && raw.trim() !== "") continue;
    block = -1;

    if (indent < 2 || raw.startsWith("usage: ") || !verbs.has(verb)) continue;
    block = indent;
    const chunks = raw.trim().split(/\s{3,}/);
    const args = chunks.findIndex((c, at) => at > 0 && !/^[-[{A-Z]/.test(c));
    const sig = chunks.slice(0, args < 0 ? undefined : args).join(" ");
    const inline = args < 0 ? "" : chunks.slice(args).join(" ");
    const more: string[] = [];
    const said: string[] = inline === "" ? [] : [inline];

    for (const next of lines.slice(i + 1)) {
      if ((/^\s*/.exec(next)?.[0].length ?? 0) <= indent || next.trim() === "") break;
      const t = next.trim();

      if (/^(\[|--|\|)/.test(t) && said.length === 0) more.push(t);
      else said.push(t);
    }

    described.add(verb);
    entries.push({ command: name, verb, line: head([...prefix, sig]), summary: said.length > 0 ? oneLine(said.join(" ")) : summary, text: [sig, ...more, ...said].join(" ") });
  }

  for (const p of pieces) {
    if (!described.has(p.verb) && !entries.some((e) => e.line === p.line)) entries.push({ command: name, verb: p.verb, line: p.line, summary, text: p.line });
  }

  return entries;
}

/** A query's score on one entry: per word, {@link NAME_WEIGHT} when it fits the name, 1 when it fits the rest. */
export function scoreOf(entry: SearchEntry, terms: readonly string[]): number {
  const name = [entry.command, ...(entry.verb === undefined ? [] : [entry.verb])];
  const rest = words(`${entry.summary} ${entry.text}`);

  return terms.reduce((sum, term) => sum + (name.some((w) => fits(term, w)) ? NAME_WEIGHT : rest.some((w) => fits(term, w)) ? 1 : 0), 0);
}

/** The query's words that count. */
export function termsOf(query: readonly string[]): string[] {
  return [...new Set(words(query.join(" ")).filter((w) => !STOP.has(w)))];
}

/** The best {@link TOP} entries for `query`, best first (ties in table order). */
export function search(commands: readonly FleetCommand[], query: readonly string[]): SearchEntry[] {
  const terms = termsOf(query);

  return commands
    .flatMap(entriesOf)
    .flatMap((entry, at) => {
      const score = scoreOf(entry, terms);

      return score > 0 ? [{ entry, at, score }] : [];
    })
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, TOP)
    .map((s) => s.entry);
}

/** What `fleet search` prints for these hits: each line, its summary, and the --help that details it. */
export function hitsText(hits: readonly SearchEntry[], query: readonly string[]): string {
  if (hits.length === 0) return `no fleet command matches '${query.join(" ")}'; the commands: ${COMMAND_NAMES.join(", ")}\n`;

  return hits.map((h) => `${h.line} — ${h.summary}\n  fleet ${h.command} --help\n`).join("");
}

/** Run `fleet search ARGV`. */
export function searchCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (argv[0] === "-h" || argv[0] === "--help") {
      out.out(`${SEARCH_HELP}\n`);

      return 0;
    }

    if (termsOf(argv).length === 0) {
      out.err(`usage: fleet search WORDS...\nfleet search: error: give the words a command's help would hold\n`);

      return 2;
    }

    const hits = search(yield* fleetCommands(), argv);

    out.out(hitsText(hits, argv));

    return hits.length > 0 ? 0 : 1;
  });
}
