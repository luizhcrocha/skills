/**
 * A permission (TypeScript's alone, SPEC.md "Permission grants"): a tool call the user may let through once.
 * The plugin's hook opens one for an Agent spawn the harness refused in auto mode, with the call as the
 * harness saw it; a host words one from the refusal draft of any other refused call (refusal-draft.ts: the
 * classifier's cause, the host's words); a coordinator opens one before it runs a call the user must say yes
 * to (an ask: no cause, and up to MAX_CALLS exact commands, each granted once). This module makes the row's refusal and its two options, and
 * holds the one rule both the CLI and the hub check a call against: an exact allow rule, `Bash(<call>)`, and
 * only for a call it can express; or, for a spawn, `Agent(<its input as JSON>)`, which the plugin's
 * PreToolUse hook matches (auto mode drops Agent allow rules from the settings, and a hook's allow is what
 * clears a refused spawn).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import * as Effect from "effect/Effect";

import { stateRefusal, type Refusal } from "../errors.ts";
import { isFleetCli } from "../files.ts";
import { asArray, asObject, asString, type Json } from "../json.ts";
import { HOOK_FILES } from "../ws/hook.ts";
import { ALLOW_KIND, ALLOW_KIND_LABEL, allowKindWords, offersKind } from "./allow-kind.ts";
import type { Choice, RefusedCall } from "./model.ts";

export { ALLOW_KIND, ALLOW_KIND_LABEL, allowKindWords, offersKind } from "./allow-kind.ts";

/** The tools a permission handles: a shell command, and a subagent's spawn. */
export const PERMISSION_TOOLS: readonly string[] = ["Bash", "Agent"];

/** The option that grants the call once. */
export const ALLOW_ONCE = "allow-once";

/** Whether an answer to a permission lets its calls through, once: it begins with allow-once or allow-kind. */
export function allows(answer: string): boolean {
  const text = answer.trim().toLowerCase();

  return text.startsWith(ALLOW_ONCE) || text.startsWith(ALLOW_KIND);
}

/** Whether an answer to a permission asks for a rule for its kind: it begins with allow-kind. */
export function asksKind(answer: string): boolean {
  return answer.trim().toLowerCase().startsWith(ALLOW_KIND);
}

/** How long a grant the call has not used stays; the hook's GRANT_TTL_S is the same. */
const GRANT_TTL_MIN = 30;

/** The longest Bash call a permission holds: the user reads it whole, wrapped, on a phone (about a screen and a
 * half at 390 px); a longer one is a script. */
export const MAX_CALL_CHARS = 2000;

/** The most exact commands one permission asks for: a deploy sequence (build, migrate, deploy, check), read
 * in full on a phone before one tap. */
export const MAX_CALLS = 10;

/** The exact rule that lets `tool`'s `call` through. */
export function ruleOf(tool: string, call: string): string {
  return `${tool}(${call})`;
}

/** The revision of a permission's call: a hash of its exact rule. An explanation names it (`--call`), so one
 * written for a call the hook has since replaced is refused, not shown with the new call. */
export function callRev(rule: string): string {
  return createHash("sha256").update(rule).digest("hex").slice(0, 12);
}

/** A permission's calls in the order asked: its `call`, then its `more`. */
export function callsOf(r: Pick<RefusedCall, "call" | "more">): readonly string[] {
  return [r.call, ...(r.more ?? [])];
}

/** A permission's calls on one line: the call, or each one numbered when it asks for several. */
export function callsLine(r: Pick<RefusedCall, "call" | "more">): string {
  const calls = callsOf(r);

  return calls.length === 1 ? r.call : calls.map((call, k) => `(${String(k + 1)}) ${call}`).join(" ");
}

/** The exact rules a permission's allow-once grants, one per call, in order. */
export function rulesOf(r: Pick<RefusedCall, "tool" | "call" | "more">): readonly string[] {
  return callsOf(r).map((call) => ruleOf(r.tool, call));
}

/** The revision of everything a permission asks for: `callRev` of its rule, or of its rules one per line (no
 * rule holds a newline) when it asks for several. */
export function refusalRev(r: Pick<RefusedCall, "tool" | "call" | "more"> | null | undefined): string {
  return callRev(r === null || r === undefined ? "" : rulesOf(r).join("\n"));
}

/** Whether the permission was asked before its call ran (no cause), not opened from a refusal. */
export function isAsk(r: Pick<RefusedCall, "cause">): boolean {
  return r.cause === "";
}

/** Why no exact rule can let `tool`'s `call` through and be read by the user as what runs, or undefined when
 * one can. An Agent call is its input as a JSON object, which the hook alone matches. For Bash: a newline
 * ends a rule, a `*` would match more than the call, a backslash
 * starts an escape in Claude Code's rule parser, so the rule would not match the call, and no exact rule cleared
 * a piped command (measured on Claude Code 2.1.296, four runs of four; `&&`, `;`, an assignment, `$( )` and
 * `2>&1` cleared). A character outside printable ASCII is one the user cannot tell from what it imitates (a
 * Cyrillic `e`, a zero-width space, a right-to-left override that shows the command reversed, a no-break space,
 * a tab); a space at either end is one Claude Code trims before it matches; and a call past MAX_CALL_CHARS is
 * not read whole. */
export function whyNoRule(tool: string, call: string): string | undefined {
  if (tool === "Agent") return isJsonObject(call) ? undefined : "an Agent call is its tool input, a JSON object";

  if (call.trim() === "") return "the call is empty";

  if (call.includes("\n") || call.includes("\r")) return "the call has a newline, which an exact allow rule cannot hold";

  if (call.includes("*")) return "the call has a *, which an allow rule reads as a wildcard";

  if (call.includes("\\")) return "the call has a backslash, which an allow rule reads as an escape";

  if (call.includes("|")) return "the call has a |, and no exact allow rule clears a piped command";
  const odd = [...call].findIndex((c) => c < " " || c > "~");

  if (odd >= 0) {
    const code = ([...call][odd] ?? "").codePointAt(0) ?? 0;

    return `the call has a character outside printable ASCII at position ${String(odd + 1)} (U+${code.toString(16).toUpperCase().padStart(4, "0")}), which the user cannot tell from a plain one on the card`;
  }

  if (call !== call.trim()) return "the call starts or ends with a space, which is no part of the command";

  if (call.length > MAX_CALL_CHARS) return `the call is ${String(call.length)} characters, and a permission's call is at most ${String(MAX_CALL_CHARS)}, so the user reads it whole`;

  return undefined;
}

/** What to ask for when no exact rule can hold a Bash call: a form one can, never an action in its place. */
export const SUPPORTED_FORM =
  "Ask for a form an exact rule can hold: put the lines in a script in the repo (tasks/<name>.sh, where the user reads them) and ask for " +
  "`bash <its absolute path>`, or give the commands one by one (--call for the first, --then for each next, each a Bash call of its own). " +
  "An action (--manual) is for a step only the user can take, not for a command the fleet can run";

/** The programs whose first argument is the script they run (`.` and `source` read it into the shell). */
const INTERPRETERS: readonly string[] = ["bash", "sh", "node", "python", "python3", ".", "source"];

/** Words that only lead to the command that runs: shell keywords, and the wrappers that take a command. */
const LEADERS: readonly string[] = ["{", "!", "if", "then", "else", "elif", "do", "while", "until", "time", "nice", "nohup", "command", "builtin", "noglob", "exec", "env", "timeout", "stdbuf"];

/** The words of each simple command of a Bash call a permission can hold (no backslash, pipe or newline): split
 * on `;`, `&&`, `||`, `&` and the parentheses of a group outside quotes, each word without its quotes. With
 * `anyCall`, for a call as the harness saw it, a pipe and a newline end a command too. */
export function simpleCommands(call: string, anyCall = false): string[][] {
  return splitCall(call, anyCall, (c) => c);
}

/** simpleCommands with each quoted character given as `quoted` has it from the character and its quote (`'` or
 * `"`), so a view of the words can tell what bash reads outside quotes (expandedWord) or inside single quotes
 * (LITERAL_DOLLAR). */
function splitCall(call: string, anyCall: boolean, quoted: (c: string, quote: string) => string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  let quote = "";

  const endWord = (): void => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };

  const endCommand = (): void => {
    endWord();

    if (words.length > 0) commands.push(words);
    words = [];
  };

  const chars = Array.from(call);

  for (const [at, c] of chars.entries()) {
    if (quote !== "") {
      if (c === quote) quote = "";
      else word = (word ?? "") + quoted(c, quote);
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === " " || c === "\t") endWord();
    else if (anyCall && (c === "|" || c === "\n" || c === "\r")) endCommand();
    else if (c === ";" || c === "(" || c === ")" || (c === "&" && chars[at - 1] !== ">" && chars[at - 1] !== "<" && chars[at + 1] !== ">")) endCommand();
    else word = (word ?? "") + c;
  }

  endCommand();

  return commands;
}

/** The simple commands of a Bash call (simpleCommands, each quoted character as `quoted` gives it), each also split
 * at a word of only `|` and `&`. whyNoRule refuses a `|` first on every path, so such a word is a quoted one (`'|'`,
 * `'&&'`), which bash passes as an argument; reading it as a separator fails closed. */
function pieces(call: string, quoted: (c: string, quote: string) => string = (c) => c): string[][] {
  return splitCall(call, false, quoted).flatMap((all) => {
    const found: string[][] = [[]];

    for (const word of all) {
      if (/^[|&]+$/u.test(word)) found.push([]);
      else found.at(-1)?.push(word);
    }

    return found.filter((words) => words.length > 0);
  });
}

/** One simple command as fromProgram reads it: the assignments before its program, and the words from it. */
interface Command {
  readonly assignments: readonly string[];
  readonly words: readonly string[];
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/u;

/** Where one simple command's program stands, the one place every port finds it: output redirections aside
 * (withoutOutputs), the shell keywords (KEYWORDS) and assignments (`NAME=`, `NAME+=`) before it skipped, and with
 * `leaders`, the words that only lead to it (LEADERS) with their flags and durations. whyNoCommand reads it
 * without leaders, so it refuses a wrapper; runningCommands with them, so scriptsOf binds the script of any call
 * whyNoAsk holds. */
function fromProgram(all: readonly string[], leaders: boolean): Command {
  const assignments: string[] = [];
  let words = withoutOutputs(all);

  for (;;) {
    const [first, ...rest] = words;

    if (first === undefined) break;

    if (leaders && LEADERS.includes(first)) words = rest.slice(rest.findIndex((w) => !w.startsWith("-") && !/^[0-9.]+[smhd]?$/u.test(w)) >>> 0);
    else if (KEYWORDS.includes(first)) words = rest;
    else if (ASSIGNMENT.test(first)) {
      assignments.push(first);
      words = rest;
    } else break;
  }

  return { assignments, words };
}

/** Each simple command of a Bash call from the program that runs (fromProgram, leaders skipped). */
function runningCommands(call: string): (readonly string[])[] {
  return pieces(call).map((all) => fromProgram(all, true).words);
}

/** The script file each simple command of a Bash call runs, where its text names one: the first argument of an
 * interpreter (INTERPRETERS: `bash <path>`, `sh`, `node`, `python`, `python3`, `.`, `source`), or a command given
 * as a path (`<path> args`). A command found by name (`just deploy`, `pnpm run deploy`, `wrangler deploy`) names
 * none: what it runs is looked up when it runs. An interpreter's flag first names none either (`python3 -m
 * pytest`, `bash -c '…'`): whyNoAsk refuses one whose flags a script follows. */
export function scriptsOf(call: string): string[] {
  return runningCommands(call).flatMap(([program = "", argument]) => {
    if (INTERPRETERS.includes(program)) return argument === undefined || argument.startsWith("-") ? [] : [argument];

    return program.includes("/") ? [program] : [];
  });
}

/** A `fleet ws DIR trash NAME` call's fleet ledger folder and workspace name. */
export interface WsTrash {
  readonly dir: string;
  readonly name: string;
}

/** The fleet ledger and workspace of each `fleet ws DIR trash NAME` of a Bash call (the fleet CLI bare or by its
 * path, isFleetCli; DIR absolute, as a trash card names it), whose trash runs that workspace's repo's pre-remove
 * hook (cli/ws.ts trashNamed). */
export function wsTrashesOf(call: string): WsTrash[] {
  return runningCommands(call).flatMap(([program = "", group, dir, sub, name]) =>
    (program === "fleet" || isFleetCli(program, (key) => process.env[key])) && group === "ws" && sub === "trash" && dir !== undefined && isAbsolute(dir) && name !== undefined ? [{ dir, name }] : [],
  );
}

/** The `.fleet/ws-*` hook files a Bash call's `fleet ws DIR trash NAME` runs (wsTrashesOf): the pre-remove hook
 * of the repo DIR/state.json records for workspace NAME (ws/hook.ts HOOK_FILES), which runsOf binds as a script
 * when it is there, and by its absence (ABSENT_SHA256) when it is not, so a hook made after the ask grants nothing. */
export function wsHooksOf(call: string): string[] {
  return wsTrashesOf(call).flatMap((trash) => {
    const hook = wsHookOf(trash);

    return hook === undefined ? [] : [hook];
  });
}

/** The pre-remove hook one `fleet ws DIR trash NAME` runs (wsHooksOf), or undefined when DIR/state.json does not
 * read or records no workspace NAME with an absolute repo: whyNoAsks then refuses the call, as no card can bind it. */
function wsHookOf({ dir, name }: WsTrash): string | undefined {
  let ledger: Json;

  try {
    // SAFETY: JSON.parse returns JSON values only.
    ledger = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as Json;
  } catch {
    return undefined;
  }

  const row = (asArray(asObject(ledger)?.["workspaces"]) ?? []).map(asObject).find((w) => asString(w?.["id"]) === name && w?.["status"] !== "pruned");
  const repo = asString(row?.["repo"]);

  return repo !== undefined && isAbsolute(repo) ? join(repo, HOOK_FILES["pre-remove"]) : undefined;
}

/** A command's words without its output redirections and their targets (`> /tmp/x.log`, `>>`, `2>`, `&>`, `2>&1`,
 * `>&2`): what they name is written, not run. An input redirection (`< ./x.sh`, `<<<`) stays, and whyNoAsk refuses
 * it. */
function withoutOutputs(words: readonly string[]): string[] {
  let target = false;

  return words.filter((word) => {
    const skip = target || /^(?:[0-9]*|&)>/u.test(word);

    target = !target && /^(?:[0-9]*|&)>[>&|]?$/u.test(word);

    return !skip;
  });
}

/** The shell keywords a command may start with, which run nothing of their own. */
const KEYWORDS: readonly string[] = ["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time"];

/** The variables an assignment may set on a page ask: none changes what a command runs. */
const ASSIGNABLE: readonly string[] = ["CI", "TZ", "NO_COLOR", "FORCE_COLOR"];

/** The programs that run nothing but themselves, whatever their words (not sed, awk, rg or printf: `sed e`,
 * `system()`, `rg --pre` and `printf -v PATH` do). */
const INERT: readonly string[] = ["ls", "cat", "echo", "cd", "pwd", "true", "false", "head", "tail", "wc", "grep", "jq", "date", "sleep", "diff", "tee"];

/** The programs that run a command they are given, which the user does not read as a call of its own. */
const WRAPPERS: readonly string[] = ["env", "timeout", "nice", "nohup", "stdbuf", "exec", "command", "builtin", "sudo", "xargs", "find", "eval"];

const PACKAGE_RUNNER = ["exec", "dlx", "x", "create", "init", "config", "c", "set", "--script-shell", "--node-options"];

/** The project runners a page ask holds, each with the flags and subcommands that run code the call does not name
 * (refusedAt says where each counts), and `config`, which writes what a later call runs (`git config`, `jj config
 * set`, `gh config set`, `npm config set`). What a runner runs otherwise (the repo's scripts, config, hooks and
 * tests) is the residual of a page ask: the user allows the repo's own. So is the folder a call runs in: wrangler's
 * `--cwd` and just's `-d` are refused for reading another folder's config, but a `cd` before the call, `git -C` and
 * `jj -R` change the folder too, and are held (belt and braces, not a closed class). */
const RUNNERS = new Map<string, readonly string[]>([
  ["git", ["-c", "--config-env", "--exec-path", "--upload-pack", "--receive-pack", "--exec", "-O", "--open-files-in-pager", "--extcmd", "--tool", "config", "bisect", "submodule", "filter-branch", "difftool", "mergetool", "rebase", "clone"]],
  ["jj", ["--config", "--config-toml", "--config-file", "--tool", "util", "config"]],
  ["just", ["-f", "--justfile", "-d", "--working-directory", "--shell", "-c", "--command", "--dotenv-path"]],
  ["pnpm", PACKAGE_RUNNER],
  ["npm", PACKAGE_RUNNER],
  ["vp", ["exec"]],
  ["cargo", ["--config", "-Z"]],
  ["go", ["run", "generate", "-exec", "-toolexec"]],
  ["gh", ["extension", "ext", "alias", "config"]],
  ["wrangler", ["-c", "--config", "--cwd"]],
  ["fleet", ["run", "start", "serve", "hub", "capture"]],
]);

/** The fleet CLI's `preview` subcommands a page ask holds: the others start the dev command the fleet's preview
 * records (`start`), change it (`set`), or feed a worker's code to the running server (`include`, `exclude`). */
const FLEET_PREVIEW: readonly string[] = ["status", "stop"];

/** The fleet CLI's `ws` subcommands that run the repo's `.fleet/ws-*` hooks (ws/hook.ts), wherever they stand after
 * `ws`: an agent can change those files between the ask and the yes, and nothing binds them. `ws trash`, the one
 * ws call made for a card, runs the pre-remove hook too, which runsOf binds (wsHooksOf). */
const FLEET_WS_HOOKED: readonly string[] = ["add", "prune"];

/** An interpreter's flag that gives it code to run in place of a script file: `bash -c` (alone or in a bundle such
 * as `-lc`), `node -e`/`-p`/`--eval`/`--print`, `python -c`. */
const INLINE_FLAGS = new Map([
  ["bash", /^-[A-Za-z]*c/u],
  ["sh", /^-[A-Za-z]*c/u],
  ["node", /^(?:-[ep]+|--eval|--print)(?:=|$)/u],
  ["python", /^-[A-Za-z]*c/u],
  ["python3", /^-[A-Za-z]*c/u],
]);

/** Whether a word is a refused flag or subcommand of a runner: a subcommand by itself, a flag by its name whatever
 * its dashes or `=value`, a long flag also by a prefix of its name (`--upl=` for `--upload-pack`, as git's
 * parse-options and npm's nopt take a unique one), and a one-letter flag also glued or bundled (`-ccore.pager=x`,
 * `-vf`). */
function refusedWord(word: string, refused: string): boolean {
  if (!refused.startsWith("-")) return word === refused;

  if (!word.startsWith("-")) return false;
  const name = (flag: string): string => flag.replace(/^-+/u, "").split("=")[0] ?? "";
  const given = name(word);

  return given === name(refused) || (refused.startsWith("--") && word.startsWith("--") && given !== "" && name(refused).startsWith(given)) || (refused.length === 2 && /^-[^-]/u.test(word) && word.includes(refused.slice(1)));
}

/** The flags of a package runner that take the next word as their value, so its subcommand is past it (pnpm
 * --filter x test). Only flags known to take one: a boolean read as one would hide the subcommand after it. */
const SUBCOMMAND_VALUED = new Map<string, readonly string[]>([
  ["pnpm", ["--filter", "-F", "-C", "--dir"]],
  ["npm", ["--prefix", "-w", "--workspace"]],
]);

/** git's own options that take the next word as their value, before its subcommand. */
const GIT_VALUED: readonly string[] = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"];

/** The index of the first word past the flags and the values of `valued`: a runner's subcommand. */
function subcommandAt(args: readonly string[], valued: readonly string[]): number {
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? "";

    if (!word.startsWith("-")) return at;

    if (valued.includes(word)) at += 1;
  }

  return args.length;
}

/** Whether a runner's refused word counts at args[at]: git's `-c` only before git's subcommand, where git reads it
 * as its own (`git grep -c` counts); a package runner's subcommand only as its subcommand (`pnpm --filter x test`);
 * the fleet CLI's only in its first three words, where it reads its subcommands (`fleet usage capture`, `fleet
 * preview DIR start`), and in `fleet tell` none, as its words are a message; every other one anywhere. */
function refusedAt(program: string, args: readonly string[], refused: string, at: number): boolean {
  if (program === "git" && refused === "-c") return at < subcommandAt(args, GIT_VALUED);

  if (refused.startsWith("-")) return true;

  if (program === "fleet") return at < (args[0] === "tell" ? 1 : 3);
  const valued = SUBCOMMAND_VALUED.get(program);

  return valued === undefined || at === subcommandAt(args, valued);
}

/** The unquoted characters of a word bash expands when the call runs, past a `$`: a glob (`?`, `*`, `[…]`), which
 * a file of the working directory turns into its name (`jj ut?l` into `jj util`), and a brace expansion (`{a,b}`,
 * `{1..3}`), which makes words of its own. */
const EXPANDING = /[?*]|\[.*\]|\{.*(?:,|\.\.).*\}/su;

/** The first word of a call that bash expands by its characters outside quotes (EXPANDING), as simpleCommands gives
 * it: each quoted character is read as `_`, which expands nothing. */
function expandedWord(call: string): string | undefined {
  const at = splitCall(call, false, () => "_").flat().findIndex((w) => EXPANDING.test(w));

  return at === -1 ? undefined : simpleCommands(call).flat()[at];
}

/** The refusal of a call no page ask can hold, with the reason and the form that can. */
const noPage = (reason: string): string =>
  `no page ask can hold this call: ${reason}; run it in the terminal, or put it in a script and ask for \`bash <its absolute path>\``;

const RELATIVE = (path: string): string => `the call runs the script ${path} by a relative path: give its absolute path, so the file the user allows is the file that runs`;

const FLAGGED = "the call runs a script after interpreter flags: give `bash <path>` with no flags (put `set -x`/`-e` in the script)";

/** Why no page ask holds an interpreter's command: it binds `I <absolute path> [args]`, and runs nothing past a
 * few exact forms (`bash -n <path>`, `bash -c '<code>'` held to whyNoAsk, `node --check <path>`, `node --version`,
 * `python3 -m pytest …`, `python3 --version`). */
function whyNoInterpreter(program: string, args: readonly string[]): string | undefined {
  const [first, ...more] = args;
  const [next] = more;

  if (first === undefined) return noPage(`${program} with no script reads its code from its input`);

  if (!first.startsWith("-")) return isAbsolute(first) ? undefined : RELATIVE(first);
  const one = more.length === 1 && next !== undefined && !next.startsWith("-");
  const shell = program === "bash" || program === "sh";

  if (shell && first === "-n" && one) return undefined;

  if (shell && first === "-c" && more.length === 1 && next !== undefined) {
    const inner = whyNoAsk(next);

    if (inner !== undefined) return inner;
    const [script] = scriptsOf(next);

    return script === undefined ? undefined : noPage(`\`${program} -c\` runs the script ${script}, which only a call of its own binds`);
  }

  if (program === "node" && ((first === "--check" && one) || (first === "--version" && more.length === 0))) return undefined;

  if ((program === "python" || program === "python3") && ((first === "-m" && next === "pytest" && !more.some((w) => w.startsWith("/"))) || (first === "--version" && more.length === 0))) {
    return undefined;
  }

  const end = args.findIndex((w) => !w.startsWith("-"));
  const inline = (end === -1 ? args : args.slice(0, end)).find((w) => INLINE_FLAGS.get(program)?.test(w) === true);

  return inline === undefined ? FLAGGED : noPage(`\`${program} ${inline}\` runs code that no file of the call holds`);
}

/** Why no page ask holds the fleet CLI's words past its refused ones (RUNNERS): a `--` hands the words after it to
 * a command (`fleets gate run … -- <cmd>`, `usage capture -- <cmd>`), `ws add` and `ws prune` run the repo's
 * `.fleet/ws-*` hooks (FLEET_WS_HOOKED), files no permission binds, and `preview` is held only to look or stop
 * (FLEET_PREVIEW). */
function whyNoFleet(args: readonly string[]): string | undefined {
  if (args.includes("--")) return noPage("`fleet --` hands the words after it to a command, which the user reads as words of the fleet CLI");
  const [group, , sub] = args;
  const hooked = group === "ws" ? args.slice(1).find((w) => FLEET_WS_HOOKED.includes(w)) : undefined;

  if (hooked !== undefined) {
    return `no page ask can hold this call: \`fleet ws ${hooked}\` runs the repo's .fleet/ws-* hooks, files an agent can change after the ask and no permission binds: run it in the terminal`;
  }

  if (group === "preview" && sub === undefined) return noPage("`fleet preview DIR` needs its subcommand, status or stop, the two a page ask holds");

  if (group === "preview" && sub !== undefined && !FLEET_PREVIEW.includes(sub)) {
    return noPage(`\`fleet preview ${sub}\` runs or changes the dev command the fleet's preview records, which the call does not name (only status and stop are held)`);
  }

  return undefined;
}

/** A `$` in single quotes, which bash reads as written (`echo '$HOME'`), read as `_`; in double quotes or outside
 * quotes it expands, and stays. */
const LITERAL_DOLLAR = (c: string, quote: string): string => (quote === "'" && c === "$" ? "_" : c);

/** Why no page ask holds one simple command, or undefined: see whyNoAsk. `bare` is the same command with each `$`
 * bash reads as written masked (LITERAL_DOLLAR), word for word, so the `$` check sees only the ones that expand. */
function whyNoCommand(all: readonly string[], bare: readonly string[]): string | undefined {
  const { assignments, words } = fromProgram(all, false);
  const seen = [...assignments, ...words];
  const at = withoutOutputs(bare).findIndex((w) => w.includes("$"));

  if (at !== -1) return noPage(`\`${withoutOutputs(all)[at] ?? ""}\` has a $, which the shell expands when the call runs`);
  const name = assignments.map((w) => ASSIGNMENT.exec(w)?.[1] ?? "").find((n) => !ASSIGNABLE.includes(n));

  if (name !== undefined) return noPage(`the assignment to ${name} changes what the command runs (only CI, TZ, NO_COLOR and FORCE_COLOR are held)`);
  const input = seen.find((w) => w.includes("<"));

  if (input !== undefined) return noPage(`\`${input}\` redirects the command's input, which no permission binds`);
  const [given, ...args] = words;

  if (given === undefined || INERT.includes(given)) return undefined;
  const named = isAbsolute(given) && given.endsWith("/fleet");

  if (named && !isFleetCli(given, (name) => process.env[name])) {
    return noPage(`${given} is not the fleet CLI: a program named fleet by its path is held only at one of the plugin's install paths, by a path with no \`.\`, \`..\` or empty component`);
  }

  const program = named ? "fleet" : given;

  if (program.includes("/")) return isAbsolute(program) ? noPage(`${program} is run as a program, and only an interpreter's script is bound to its file`) : RELATIVE(program);

  if (INTERPRETERS.includes(program)) return whyNoInterpreter(program, args);

  if (WRAPPERS.includes(program)) return noPage(`${program} runs another command, which the user does not read as a call of its own`);

  if (program === "bun") {
    const [sub, name] = args;
    const named = sub === "run" && name !== undefined && !/^-|[/.]/u.test(name);

    return sub === "test" || named ? undefined : noPage(`\`bun ${sub ?? ""}\` runs code the call does not name`);
  }

  const refused = RUNNERS.get(program);

  if (refused === undefined) return noPage(`${program} is not a program a page ask holds`);
  const word = args.find((w, at) => refused.some((r) => refusedWord(w, r) && refusedAt(program, args, r, at)));

  if (word !== undefined) return noPage(`\`${program} ${word}\` runs code the call does not name`);

  return program === "fleet" ? whyNoFleet(args) : undefined;
}

/** Why a Bash call cannot be asked for before it runs, though a rule can hold it: the user allows what they read,
 * so the call names what it runs. A command substitution is decided when it runs, and so is a word bash expands
 * outside quotes, a glob or a brace expansion (expandedWord), which refusedWord would read as written. Then each
 * simple command (pieces: also split at a quoted `'|'` or `'&&'` word, which fails closed), from its program as
 * fromProgram finds it, is held to what a page ask can bind. A word with a `$` outside single quotes expands when it
 * runs; an assignment
 * other than CI, TZ, NO_COLOR or FORCE_COLOR changes what runs (`PATH=`, `BASH_ENV=`, `NODE_OPTIONS=`); an input
 * redirection feeds what no file binds. An interpreter (INTERPRETERS) binds `<interpreter> <absolute path>` and
 * refuses a relative script or its flags (whyNoInterpreter). A program given by a path is bound to no file, but for
 * tstack's own CLI by its full path (`…/fleet` whose real path is one of the plugin's install paths, isFleetCli,
 * which `fleet ws trash` takes on a card, its file bound by runsOf). An inert program (INERT) runs only itself; a
 * project runner (RUNNERS) runs the repo's own, past the flags and subcommands that run what the call does not
 * name; a wrapper (WRAPPERS) and any other program are refused. */
export function whyNoAsk(call: string): string | undefined {
  if (call.includes("$(") || call.includes("`") || call.includes("<(") || call.includes(">(")) {
    return "the call has a command substitution ($( ), backticks, <( ) or >( )), so what it runs is decided when it runs, not when the user reads it: give the value itself, or put the lines in a script";
  }

  const expanded = expandedWord(call);

  if (expanded !== undefined) return noPage(`the call has a word bash would expand (${expanded}): quote it or give it literally`);

  const bare = pieces(call, LITERAL_DOLLAR);

  for (const [k, words] of pieces(call).entries()) {
    const why = whyNoCommand(words, bare[k] ?? words);

    if (why !== undefined) return why;
  }

  return undefined;
}

/** A file's sha256, or undefined when it cannot be read. */
export function fileSha256(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/** The sha256 a run entry gives a `fleet ws DIR trash` hook file that does not exist (`<n> <64 zeros> <path>`): the
 * card binds the hook's absence, in the form every reader of `runs` already parses, as no file's content hashes to
 * it. The office host grants only while the file is still absent, and the hook lets the call run only while it is. */
export const ABSENT_SHA256 = "0".repeat(64);

/** The files a permission's calls are bound to, as the row and the page hold them: `<n> <sha256> <path>` for each
 * script call n runs by an absolute path that can be read now (`scriptsOf`), and for each `fleet ws DIR trash`, the
 * repo's pre-remove hook it runs (`wsHooksOf`), by its sha256 when it is there and by ABSENT_SHA256 when it does not
 * exist (trash then runs none). The office host grants a call only while its files hash to what the page showed, and the
 * hook lets it run only while they still do. A call with no entry is bound to no file. */
export function runsOf(calls: readonly string[]): string[] {
  return calls.flatMap((call, k) => {
    const hooks = wsHooksOf(call);

    return [...new Set([...scriptsOf(call), ...hooks])].flatMap((path) => {
      const sha = isAbsolute(path) ? fileSha256(path) : undefined;
      const absent = sha === undefined && hooks.includes(path) && !existsSync(path) ? ABSENT_SHA256 : undefined;
      const bound = sha ?? absent;

      return bound === undefined ? [] : [`${String(k + 1)} ${bound} ${path}`];
    });
  });
}

/** Why the files a permission's calls run now (`bound`, runsOf at the yes) are not the ones its card showed (`asked`),
 * or undefined: a script edited after the card opened, or a ws hook that appeared after it, grants nothing. An
 * absence entry on a path that is no ws hook (a script's, which runsOf binds by its hash alone) names the script. */
export function whyRunsMoved(asked: readonly string[], bound: readonly string[]): string | undefined {
  if (asked.length === bound.length && asked.every((entry, k) => entry === bound[k])) return undefined;
  const appeared = asked.map(readRun).find((run) => run?.sha256 === ABSENT_SHA256 && bound.some((entry) => readRun(entry)?.path === run.path && readRun(entry)?.sha256 !== ABSENT_SHA256));

  if (appeared !== undefined && !appeared.path.endsWith(`/${HOOK_FILES["pre-remove"]}`)) {
    return `the card binds the script ${appeared.path} by the absence entry, which only a ws hook takes, and the file is there, so the yes would allow a file the card did not show: ask the coordinator to record the permission again`;
  }

  if (appeared !== undefined) return `the repo's ws hook appeared after the ask (${appeared.path}), so the yes would allow a file the card did not show: ask the coordinator to record the permission again`;
  const [odd = ""] = [...asked.filter((entry) => !bound.includes(entry)), ...bound.filter((entry) => !asked.includes(entry))];
  const path = readRun(odd)?.path;

  return `a file this permission's call runs changed after it was asked for${path === undefined ? "" : ` (${path})`}, so the yes would allow another file than the one shown: ask the coordinator to record the permission again`;
}

/** One entry of `runsOf`, read back: the call's number, the file and its sha256; undefined when it does not read. */
export function readRun(entry: string): { readonly n: number; readonly sha256: string; readonly path: string } | undefined {
  const found = /^([1-9][0-9]*) ([0-9a-f]{64}) (\/.*)$/u.exec(entry);

  return found === null ? undefined : { n: Number(found[1]), sha256: found[2] ?? "", path: found[3] ?? "" };
}

function isJsonObject(text: string): boolean {
  try {
    // SAFETY: JSON.parse returns JSON values only.
    return asObject(JSON.parse(text) as Json) !== undefined;
  } catch {
    return false;
  }
}

/** The file a grant of `tool`'s call for a session rooted at `root` goes into: its settings for Bash; for
 * Agent, whose allow rules auto mode drops, the grants file the plugin's PreToolUse hook reads (the hook's
 * AGENT_GRANTS). Both sit in `.claude`, a path auto mode routes an agent's write of to the classifier. */
export function grantFileOf(tool: string, root: string): string {
  return join(root, ".claude", tool === "Agent" ? "tstack-grants.json" : "settings.local.json");
}

/** What the hook gives for a refused call. */
export interface RefusedGiven {
  readonly tool: string;
  readonly call: string;
  readonly cause: string;
  readonly root: string;
  readonly agentId: string | null;
  /** The further calls an ask carries, each granted once with the first (`--then`); none for one call. */
  readonly more?: readonly string[];
  /** The host wrote the call itself, from a refusal draft: with a cause, it is still held to what an ask is
   * (`whyNoAsks`), since the user allows what they read and this text never ran into the classifier. */
  readonly ahead?: boolean;
}

/** Why the calls of a permission cannot be asked for together, or undefined: each one an exact rule can hold,
 * none twice (one rule is one run), at most MAX_CALLS, and several only of Bash commands. The hub checks a
 * row by the same rule before it grants. */
export function whyNoCalls(tool: string, calls: readonly string[]): string | undefined {
  if (calls.length > 1 && tool !== "Bash") return "several calls on one permission are Bash commands; an Agent spawn is asked for alone";

  if (calls.length > MAX_CALLS) return `a permission asks for at most ${String(MAX_CALLS)} calls, and this one has ${String(calls.length)}: a longer sequence is a script (\`bash tasks/<name>.sh\`)`;

  for (const [k, call] of calls.entries()) {
    const why = whyNoRule(tool, call);
    const which = calls.length === 1 ? "this call" : `call ${String(k + 1)} of ${String(calls.length)} (\`${call}\`)`;

    if (why !== undefined) return `no permission for ${which}: ${why}`;
    const twin = calls.indexOf(call);

    if (twin !== k) return `call ${String(k + 1)} is call ${String(twin + 1)} again (\`${call}\`): one grant is one run, so a command asked for twice cannot be granted twice`;
  }

  return undefined;
}

/** Why the calls of an ask cannot be asked for (`whyNoAsk`, a script that cannot be read, and a `fleet ws DIR trash
 * NAME` whose repo's pre-remove hook runsOf cannot bind: the workspace's repo is not found, or the hook is there and
 * cannot be read, a folder or a file of mode 000, which an agent could swap for a script after the yes), naming
 * which. The office host checks a row by the same rule before it grants, and the fleet repo's whyNoGrant refuses a trash card
 * whose runs hold no entry for the hook. */
export function whyNoAsks(calls: readonly string[]): string | undefined {
  for (const [k, call] of calls.entries()) {
    const which = calls.length === 1 ? "this call" : `call ${String(k + 1)} of ${String(calls.length)} (\`${call}\`)`;
    const why = whyNoAsk(call);

    if (why !== undefined) return `no permission for ${which}: ${why}`;
    const unread = scriptsOf(call).find((path) => fileSha256(path) === undefined);

    if (unread !== undefined) return `no permission for ${which}: it runs ${unread}, which is no file that can be read, so the user would allow a file that is not there`;

    for (const trash of wsTrashesOf(call)) {
      const hook = wsHookOf(trash);

      if (hook === undefined) return `no permission for ${which}: the fleet ledger ${trash.dir} records no workspace ${trash.name} with its repo, so the card cannot bind the file trash runs`;

      if (existsSync(hook) && fileSha256(hook) === undefined) return `no permission for ${which}: the repo's ws hook ${hook} cannot be read, so the card cannot bind the file trash runs`;
    }
  }

  return undefined;
}

/** The refusal a permission row carries, or why the CLI refuses to open one. */
export function makeRefusedCall(given: RefusedGiven): Effect.Effect<RefusedCall, Refusal> {
  if (!PERMISSION_TOOLS.includes(given.tool)) return Effect.fail(stateRefusal(`a permission handles ${PERMISSION_TOOLS.join(" and ")} alone, got --tool ${given.tool}`));
  const more = given.more ?? [];
  const calls = [given.call, ...more];
  const rule = whyNoCalls(given.tool, calls);

  if (rule !== undefined) return Effect.fail(stateRefusal(given.tool === "Bash" && rule.startsWith("no permission for ") ? `${rule}. ${SUPPORTED_FORM}` : rule));
  const ask = given.tool === "Bash" && (given.cause === "" || given.ahead === true) ? whyNoAsks(calls) : undefined;

  if (ask !== undefined) return Effect.fail(stateRefusal(ask));

  if (!isAbsolute(given.root)) return Effect.fail(stateRefusal(`--root is the session's project directory, an absolute path, got ${given.root}`));
  const row: RefusedCall = { tool: given.tool, call: given.call, rule: ruleOf(given.tool, given.call), cause: given.cause, root: given.root, agent_id: given.agentId };

  if (more.length > 0) row.more = [...more];
  const runs = given.tool === "Bash" ? runsOf(calls) : [];

  if (runs.length > 0) row.runs = runs;

  return Effect.succeed(row);
}

/** A permission's options, which the CLI sets itself, each saying what it means for the user: allow-once, then
 * allow-kind on a Bash card its opener did not hold to once (`offersKind`), then deny. The rule and the file it
 * goes into show with the call on the page. */
export function permissionOptions(refusal: RefusedCall): Choice[] {
  const count = callsOf(refusal).length;
  const who = isAsk(refusal) ? "the fleet" : "the worker";
  const stopped = isAsk(refusal) ? "the fleet does not run it; your note goes to it" : "the worker stays stopped; your note goes to it";
  const kind: Choice[] = offersKind(refusal) ? [{ id: ALLOW_KIND, label: ALLOW_KIND_LABEL, consequence: allowKindWords(count) }] : [];

  if (count > 1) {
    return [
      {
        id: ALLOW_ONCE,
        label: `Allow these ${String(count)} calls, once each`,
        consequence: `${who} runs exactly the ${String(count)} calls shown above, once each, and nothing like them after: each one-time grant goes once its call ran, and any left go after ${String(GRANT_TTL_MIN)} minutes`,
      },
      ...kind,
      { id: "deny", label: "Deny", consequence: stopped.replace("run it", "run any of them") },
    ];
  }

  const what = refusal.tool === "Agent" ? "starts exactly the agent shown above, once" : "runs exactly the call shown above, once";

  return [
    {
      id: ALLOW_ONCE,
      label: "Allow this call once",
      consequence: `${who} ${what}, and nothing like it after: the one-time grant goes once it is used, or after ${String(GRANT_TTL_MIN)} minutes`,
    },
    ...kind,
    { id: "deny", label: "Deny", consequence: stopped },
  ];
}
