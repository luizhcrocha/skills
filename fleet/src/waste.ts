/**
 * What a worker wasted, read from its own transcript (`subagents/agent-<task id>.jsonl`): the standing
 * form of three one-off studies (2026-10-10 and the cap study of 2026-10-20): poll loops held 36% of
 * workers' Bash wait, separate probe calls 31%, calls above 150k tokens 34% of cost. A call is one
 * assistant message with usage, deduplicated by message id (Claude Code writes a streamed message as a
 * line per content block, each with the same usage). The record holds counts, seconds, token figures,
 * tool names and read paths, never a message, a command or a tool result: transcripts hold secrets.
 */
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import * as Option from "effect/Option";

import { readText } from "./files.ts";
import { asArray, asNumber, asObject, asString, parseJson, type Json, type JsonObject } from "./json.ts";
import { assignmentOf, expand, lex, literal, type Word } from "./shell-words.ts";

/** One call, for a timeline. */
export interface CallPoint {
  readonly index: number;
  /** input + cache read + cache creation. */
  readonly context: number;
  readonly cache_read: number;
  readonly cache_creation: number;
  /** From the user line (a tool result, a prompt) before the message to the message's last line; null without both stamps. */
  readonly latency_ms: number | null;
  /** The tools the call used, in order. */
  readonly tools: readonly string[];
  /** The tool results seen before the call, estimated at {@link CHARS_PER_TOKEN} characters a token (an image
   * at {@link IMAGE_TOKENS}), as a share of its context, at most 1. */
  readonly tool_result_share: number;
}

/** What one worker wasted. */
export interface WorkerWaste {
  readonly calls: number;
  readonly peak_context: number;
  /** Calls whose context passed {@link CAP}, their cache read + input, and that as a share of the worker's. */
  readonly past_cap: { readonly calls: number; readonly tokens: number; readonly share: number };
  /** cache read / (cache read + cache creation + input); misses are calls that created more cache than they read. */
  readonly cache: { readonly hit_ratio: number; readonly misses: number };
  /** Files read more than once (the Read tool, or `cat`, `head`, `tail`, `sed -n`, `less` on a path), the reads past
   * each one's first, and the 3 most read paths. */
  readonly rereads: { readonly files: number; readonly rereads: number; readonly top: readonly { readonly path: string; readonly reads: number }[] };
  /** Poll-like Bash calls and the seconds they held, beside the seconds every foreground Bash call held. */
  readonly polls: { readonly calls: number; readonly seconds: number; readonly bash_seconds: number };
  /** Runs of {@link RUN} or more consecutive probe or screenshot calls, the calls in them and the seconds they held. */
  readonly probe_runs: { readonly runs: number; readonly calls: number; readonly seconds: number };
  /** The calls before the first write (Edit, Write, NotebookEdit outside /tmp and /dev, or a Bash write:
   * {@link bashWrites}); all of them when it never wrote. */
  readonly ramp: { readonly calls: number; readonly wrote: boolean };
  readonly series: readonly CallPoint[];
}

/** The context past which a call is a handoff's (the 150k rule). */
const CAP = 150_000;

/** The consecutive probe calls that one script could have made. */
const RUN = 3;

/** One foreground sleep this long or longer is a wait the brief forbids (one under about 30 seconds is allowed). */
const LONG_SLEEP_S = 30;

const CHARS_PER_TOKEN = 4;

/** An image's tokens, as Anthropic documents a ~1.15 megapixel one. */
const IMAGE_TOKENS = 1600;

const WRITES: ReadonlySet<string> = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

const SLEEP = /(?:^|[;&|(]\s*|\s)sleep\s+(\d+(?:\.\d+)?)/g;

const FOLLOW = /\btail\b[^;&|]*?\s(?:-[A-Za-z]*[fF][A-Za-z]*|--follow\S*)(?=\s|$)|(?:^|[;&|(]\s*)watch\s/;

/** A command that changes something: a write tool's work done in Bash, so a repeat after it is no poll. */
const MUTATES =
  /(?:^|[;&|(]\s*)(?:rm|mv|cp|mkdir|touch|tee|chmod|chown|ln|dd|truncate|install|kill|pkill)\b|\b(?:sed|perl)\s+-i|\bjj\s+(?:new|describe|commit|squash|split|abandon|rebase|edit|restore|bookmark|git\s+push|workspace\s+add)\b|\bgit\s+(?:commit|push|checkout|reset|add|rebase|merge|stash)\b|\b(?:bun|npm|pnpm|yarn)\s+(?:add|install|i)\b|(?:^|[^0-9&>])>{1,2}(?!&|\s*\/dev\/null)/;

/** A Bash command that probes something one script could have batched: a request, a screenshot (a program whose
 * name holds `screenshot`), a one-line or heredoc experiment, in any segment of the command line. */
const PROBE =
  /(?:^|[;&|(]\s*|\btimeout\s+\S+\s+)(?:(?:curl|wget|http|xh|picasso|playwright|npx\s+playwright|bunx\s+playwright|grim|scrot|chromium|google-chrome)\b|(?:[^\s;&|()]*\/)?[\w.-]*screenshot)|\b(?:python3?|node|bun|deno)\s+-(?:[ce]\b|(?=\s|$))/;

interface Use {
  readonly name: string;
  /** The working directory the transcript line records. */
  readonly cwd: string | undefined;
  readonly input: JsonObject;
  readonly id: string;
  readonly atMs: number | undefined;
}

interface Call {
  input: number;
  read: number;
  created: number;
  lastMs: number | undefined;
  readonly beforeMs: number | undefined;
  readonly toolTokensBefore: number;
  readonly uses: Use[];
}

function stampOf(row: JsonObject): number | undefined {
  const at = Date.parse(asString(row["timestamp"]) ?? "");

  return Number.isNaN(at) ? undefined : at;
}

function tokensOf(content: Json | undefined): number {
  const text = asString(content);

  if (text !== undefined) return text.length / CHARS_PER_TOKEN;

  return (asArray(content) ?? []).reduce<number>((sum, block) => {
    const b = asObject(block);

    if (b?.["type"] === "image") return sum + IMAGE_TOKENS;

    return sum + (asString(b?.["text"])?.length ?? 0) / CHARS_PER_TOKEN;
  }, 0);
}

/** A transcript's calls in order, and when each tool use got its result (ms, by tool use id). */
interface Parsed {
  readonly calls: Call[];
  readonly resultAt: Map<string, number>;
}

function callsIn(text: string): Parsed {
  const byId = new Map<string, Call>();
  const calls: Call[] = [];
  const resultAt = new Map<string, number>();
  let userAt: number | undefined;
  let toolTokens = 0;

  for (const line of text.split("\n")) {
    const row = asObject(Option.getOrUndefined(parseJson(line)));
    const message = asObject(row?.["message"]);

    if (row === undefined || message === undefined) continue;
    const at = stampOf(row);
    const blocks = (asArray(message["content"]) ?? []).map((b) => asObject(b)).filter((b): b is JsonObject => b !== undefined);

    if (row["type"] === "user") {
      userAt = at ?? userAt;

      for (const b of blocks.filter((b) => b["type"] === "tool_result")) {
        if (at !== undefined) resultAt.set(asString(b["tool_use_id"]) ?? "", at);
        toolTokens += tokensOf(b["content"]);
      }

      continue;
    }

    const usage = asObject(message["usage"]);

    if (row["type"] !== "assistant" || usage === undefined) continue;
    const id = asString(message["id"]);
    let call = id === undefined ? undefined : byId.get(id);

    if (call === undefined) {
      call = { input: 0, read: 0, created: 0, lastMs: undefined, beforeMs: userAt, toolTokensBefore: toolTokens, uses: [] };
      calls.push(call);

      if (id !== undefined) byId.set(id, call);
    }

    call.input = Math.trunc(asNumber(usage["input_tokens"]) ?? 0);
    call.read = Math.trunc(asNumber(usage["cache_read_input_tokens"]) ?? 0);
    call.created = Math.trunc(asNumber(usage["cache_creation_input_tokens"]) ?? 0);
    call.lastMs = at ?? call.lastMs;

    for (const b of blocks.filter((b) => b["type"] === "tool_use")) {
      call.uses.push({ name: asString(b["name"]) ?? "", cwd: asString(row["cwd"]), input: asObject(b["input"]) ?? {}, id: asString(b["id"]) ?? "", atMs: at });
    }
  }

  return { calls, resultAt };
}

const contextOf = (c: Call): number => c.input + c.read + c.created;

const commandOf = (u: Use): string => (asString(u.input["command"]) ?? "").trim().replace(/\s+/g, " ");

const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash"]);

/** `command` without heredoc bodies, comments or quoted text, and with the script a nested shell's `-c` runs
 * (to `depth` levels), on one line: what a poll's, a probe's or a mutation's shape is matched against. */
function bareText(command: string, depth = 2): string {
  const lexed = lex(command);

  const nested = lexed.commands.flatMap((c) => {
    const at = programAt(c.words);
    const words = c.words.slice(at).map(literal);

    const flag = words.findIndex((w, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
    const script = words[flag + 1];

    return depth > 0 && SHELLS.has(basename(words[0] ?? "")) && flag !== -1 && script !== undefined ? [bareText(script, depth - 1)] : [];
  });

  return [lexed.bare, ...nested]
    .join("\n")
    .replace(/\s*\n\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
}

const bareOf = (u: Use): string => bareText(asString(u.input["command"]) ?? "");

const background = (u: Use): boolean => u.input["run_in_background"] === true;

/** Words that open or close a compound command, or prefix the program that runs. */
const PREFIXES: ReadonlySet<string> = new Set(["env", "sudo", "time", "nice", "command", "exec", "do", "then", "else", "elif", "if", "while", "until", "!", "{", "}"]);

/** Where a simple command's program stands, past variable assignments, keywords, `env`, `sudo`, `time`, `nice`,
 * `command` and `timeout [OPTIONS] DURATION`. */
function programAt(words: readonly Word[]): number {
  let k = 0;

  while (k < words.length) {
    const w = literal(words[k] ?? []);

    if (assignmentOf(words[k] ?? []) !== undefined || PREFIXES.has(w)) k += 1;
    else if (w === "timeout") {
      k += 1;

      while (literal(words[k] ?? []).startsWith("-")) k += 1;
      k += 1;
    } else break;
  }

  return k;
}

const outsideScratch = (path: string): boolean => !/^\/(?:tmp|dev)(?:\/|$)/.test(path);

/** A path as the Read tool's key, against `cwd`; undefined for an unknown word, a pattern, or a relative path without `cwd`. */
function pathKey(word: string | undefined, cwd: string | undefined): string | undefined {
  if (word === undefined || word === "" || word === "-" || /[$*?{}`~]/.test(word)) return undefined;

  if (word.startsWith("/")) return resolve(word);

  return cwd === undefined ? undefined : resolve(cwd, word);
}

/** One simple command of a Bash call, its words expanded (undefined where unknown), and the directory it runs in. */
interface Run {
  readonly program: string;
  readonly args: readonly (string | undefined)[];
  readonly redirects: readonly { readonly op: string; readonly target: string | undefined }[];
  readonly here: string | undefined;
}

/**
 * Each simple command of `command`, run from `cwd` with `home` as HOME: a `cd` followed, and the variables a
 * `NAME=value` (or `export NAME=value`) on its own sets expanded in the commands after it; both only until the
 * `( … )` they stand in closes.
 */
function* commandsIn(command: string, cwd: string | undefined, home: string): Generator<Run> {
  let vars = new Map([["HOME", home]]);
  let here = cwd;
  const outer: { readonly vars: Map<string, string>; readonly here: string | undefined }[] = [];

  for (const c of lex(command).commands) {
    for (let k = 0; k < c.opens; k++) outer.push({ vars: new Map(vars), here });
    const at = programAt(c.words);
    const program = basename(literal(c.words[at] ?? []));
    const rest = c.words.slice(at + 1);
    const sets = at === c.words.length ? c.words : program === "export" ? rest : [];

    for (const w of sets) {
      const [name, value] = assignmentOf(w) ?? [];

      if (name === undefined || value === undefined) continue;
      const v = expand(value, vars);

      if (v === undefined) vars.delete(name);
      else vars.set(name, v);
    }

    const args = rest.map((w) => expand(w, vars));
    const redirects = c.redirects.map((r) => ({ op: r.op, target: expand(r.target, vars) }));

    if (program === "cd") here = args.length === 0 ? home : pathKey(args[0], here);
    else yield { program, args, redirects, here };

    for (let k = 0; k < c.closes; k++) ({ vars, here } = outer.pop() ?? { vars, here });
  }
}

/** The files a command's args name, past options and the values `valued` options take. */
function fileArgs(args: readonly (string | undefined)[], valued: ReadonlySet<string>): (string | undefined)[] {
  const files: (string | undefined)[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a !== undefined && valued.has(a)) i += 1;
    else if (a === undefined || !a.startsWith("-")) files.push(a);
  }

  return files;
}

const HEAD_TAIL_VALUED: ReadonlySet<string> = new Set(["-n", "-c", "--lines", "--bytes"]);

const SED_VALUED: ReadonlySet<string> = new Set(["-e", "-f", "--expression", "--file", "-l", "--line-length"]);

const sedInPlace = (args: readonly (string | undefined)[]): boolean => args.some((a) => a !== undefined && /^-[A-Za-z]*i|^--in-place/.test(a));

/** The files `sed` edits or reads: past its script, the first word when no `-e` or `-f` gives one. */
function sedFiles(args: readonly (string | undefined)[]): (string | undefined)[] {
  const scripted = args.some((a) => a !== undefined && /^(?:-e|-f|--expression|--file)/.test(a));

  return fileArgs(args, SED_VALUED).slice(scripted ? 0 : 1);
}

/** The files a Bash command reads whole or in part with `cat`, `head`, `tail`, `sed -n` or `less`, as Read paths. */
function bashReads(command: string, cwd: string | undefined, home: string): string[] {
  const read: string[] = [];

  for (const { program, args, here } of commandsIn(command, cwd, home)) {
    let words: (string | undefined)[] = [];

    if (program === "cat" || program === "less") words = fileArgs(args, new Set());
    else if (program === "head" || program === "tail") words = fileArgs(args, HEAD_TAIL_VALUED);
    else if (program === "sed" && args.includes("-n") && !sedInPlace(args)) words = sedFiles(args);

    for (const w of words) {
      const key = pathKey(w, here);

      if (key !== undefined) read.push(key);
    }
  }

  return read;
}

const JJ_VALUED: ReadonlySet<string> = new Set(["-R", "--repository", "--at-op", "--at-operation", "--config", "--config-file", "--color"]);

/** A redirection that writes a file: `>`, `>>`, `>|`, `N>`, `&>`, `&>>`, or `>&` to a word that is no fd. */
const writesTo = (op: string, target: string | undefined): boolean => /^(?:\d*|&)>(?:>|\|)?$/.test(op) || (/^\d*>&$/.test(op) && target !== undefined && !/^(?:\d+|-)$/.test(target));

/** Whether a Bash command writes: a redirect, `sed -i` or `tee` to a file known to be outside /tmp and /dev (a
 * path through an unknown variable is not known), `patch`, `jj describe`, `jj commit` or `jj squash`. */
function bashWrites(command: string, cwd: string | undefined, home: string): boolean {
  for (const { program, args, redirects, here } of commandsIn(command, cwd, home)) {
    const outside = (w: string | undefined): boolean => {
      const key = pathKey(w, here);

      return key !== undefined && outsideScratch(key);
    };

    if (redirects.some((r) => writesTo(r.op, r.target) && outside(r.target))) return true;

    if (program === "sed" && sedInPlace(args) && sedFiles(args).some(outside)) return true;

    if (program === "tee" && fileArgs(args, new Set()).some(outside)) return true;

    if (program === "patch") return true;

    if (program === "jj") {
      const sub = args.find((a, i) => a !== undefined && !a.startsWith("-") && !JJ_VALUED.has(args[i - 1] ?? ""));

      if (sub !== undefined && ["describe", "desc", "commit", "squash"].includes(sub)) return true;
    }
  }

  return false;
}

/** Whether a write tool's use writes outside /tmp and /dev, as {@link bashWrites} counts a Bash write: a
 * scratchpad note is no product write. A path it does not name, or one not known, counts. */
function toolWrites(u: Use): boolean {
  const key = pathKey(asString(u.input["file_path"]) ?? asString(u.input["notebook_path"]), u.cwd);

  return key === undefined || outsideScratch(key);
}

/** Words after which a command starts, as after a `;`. */
const LEADS: ReadonlySet<string> = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);

/** Whether `bare` runs `sleep` inside a `while`, `until` or `for` loop: between the loop's keyword and its `done`,
 * each of them a word where a command starts. */
function sleepsInLoop(bare: string): boolean {
  let depth = 0;
  let start = true;

  for (const [w] of bare.matchAll(/[;&|()]|[^\s;&|()]+/g)) {
    if (start && (w === "while" || w === "until" || w === "for")) depth += 1;
    else if (start && w === "done") depth = Math.max(0, depth - 1);
    else if (w === "sleep" && depth > 0) return true;
    start = /^[;&|()]$/.test(w) || LEADS.has(w);
  }

  return false;
}

/** Whether `bare` (a {@link bareOf}) is a poll: a sleep loop, a long sleep, `tail -f` (after any options) or `watch`. */
function isPollCommand(bare: string): boolean {
  if (sleepsInLoop(bare) || FOLLOW.test(bare)) return true;

  return [...bare.matchAll(SLEEP)].some((m) => Number(m[1]) >= LONG_SLEEP_S);
}

function isProbe(u: Use): boolean {
  if (/screenshot/i.test(u.name) || (u.name.endsWith("__computer") && u.input["action"] === "screenshot")) return true;

  return u.name === "Bash" && !background(u) && PROBE.test(bareOf(u));
}

function polls(calls: readonly Call[], held: (u: Use) => number, writes: (u: Use) => boolean): WorkerWaste["polls"] {
  const seen = new Set<string>();
  let count = 0;
  let seconds = 0;
  let bash = 0;

  for (const u of calls.flatMap((c) => c.uses)) {
    if (WRITES.has(u.name)) seen.clear();

    if (u.name !== "Bash" || background(u)) continue;
    const command = commandOf(u);
    const bare = bareOf(u);
    const readOnly = !MUTATES.test(bare) && !writes(u);
    bash += held(u);

    if (isPollCommand(bare) || (readOnly && seen.has(command))) {
      count += 1;
      seconds += held(u);
    }

    if (readOnly) seen.add(command);
    else seen.clear();
  }

  return { calls: count, seconds, bash_seconds: bash };
}

function probeRuns(calls: readonly Call[], held: (u: Use) => number): WorkerWaste["probe_runs"] {
  let runs = 0;
  let inRuns = 0;
  let seconds = 0;
  let run: Call[] = [];

  const close = (): void => {
    if (run.length >= RUN) {
      runs += 1;
      inRuns += run.length;
      seconds += run.reduce((sum, c) => sum + Math.max(0, ...c.uses.map(held)), 0);
    }

    run = [];
  };

  for (const c of calls) {
    if (c.uses.length > 0 && c.uses.every(isProbe)) run.push(c);
    else close();
  }

  close();

  return { runs, calls: inRuns, seconds };
}

function rereads(calls: readonly Call[], home: string): WorkerWaste["rereads"] {
  const reads = new Map<string, number>();

  for (const u of calls.flatMap((c) => c.uses)) {
    const file = u.name === "Read" ? asString(u.input["file_path"]) : undefined;
    const paths = u.name === "Bash" ? bashReads(asString(u.input["command"]) ?? "", u.cwd, home) : file === undefined ? [] : [pathKey(file, u.cwd) ?? file];

    for (const path of paths) reads.set(path, (reads.get(path) ?? 0) + 1);
  }

  const again = [...reads].filter(([, n]) => n > 1).sort(([pa, a], [pb, b]) => b - a || pa.localeCompare(pb));

  return { files: again.length, rereads: again.reduce((sum, [, n]) => sum + n - 1, 0), top: again.slice(0, 3).map(([path, n]) => ({ path, reads: n })) };
}

/** What the worker whose transcript is at `path` wasted, `~` in its commands being `home`; undefined without that
 * file or any call with usage in it. */
export function wasteOf(path: string, home: string = homedir()): WorkerWaste | undefined {
  const text = readText(path);

  if (text === undefined) return undefined;
  const { calls, resultAt } = callsIn(text);

  if (calls.length === 0) return undefined;

  const held = (u: Use): number => {
    const done = resultAt.get(u.id);

    return done === undefined || u.atMs === undefined ? 0 : Math.max(0, (done - u.atMs) / 1000);
  };

  const writes = (u: Use): boolean => (WRITES.has(u.name) && toolWrites(u)) || (u.name === "Bash" && bashWrites(asString(u.input["command"]) ?? "", u.cwd, home));
  const paid = (c: Call): number => c.read + c.input;
  const past = calls.filter((c) => contextOf(c) > CAP);
  const allPaid = calls.reduce((sum, c) => sum + paid(c), 0);
  const pastPaid = past.reduce((sum, c) => sum + paid(c), 0);
  const read = calls.reduce((sum, c) => sum + c.read, 0);
  const fed = calls.reduce((sum, c) => sum + contextOf(c), 0);
  const firstWrite = calls.findIndex((c) => c.uses.some(writes));

  return {
    calls: calls.length,
    peak_context: Math.max(...calls.map(contextOf)),
    past_cap: { calls: past.length, tokens: pastPaid, share: allPaid === 0 ? 0 : pastPaid / allPaid },
    cache: { hit_ratio: fed === 0 ? 0 : read / fed, misses: calls.filter((c) => c.created > c.read).length },
    rereads: rereads(calls, home),
    polls: polls(calls, held, writes),
    probe_runs: probeRuns(calls, held),
    ramp: firstWrite === -1 ? { calls: calls.length, wrote: false } : { calls: firstWrite, wrote: true },
    series: calls.map((c, index) => ({
      index,
      context: contextOf(c),
      cache_read: c.read,
      cache_creation: c.created,
      latency_ms: c.lastMs === undefined || c.beforeMs === undefined ? null : c.lastMs - c.beforeMs,
      tools: c.uses.map((u) => u.name),
      tool_result_share: contextOf(c) === 0 ? 0 : Math.min(1, c.toolTokensBefore / contextOf(c)),
    })),
  };
}
