/**
 * A permission (TypeScript's alone, SPEC.md "Permission grants"): a tool call the user may let through once.
 * The plugin's hook opens one for a call the harness refused in auto mode, with the call as the harness saw
 * it; a coordinator opens one before it runs a call the user must say yes to (an ask: no cause, and up to
 * MAX_CALLS exact commands, each granted once). This module makes the row's refusal and its two options, and
 * holds the one rule both the CLI and the hub check a call against: an exact allow rule, `Bash(<call>)`, and
 * only for a call it can express; or, for a spawn, `Agent(<its input as JSON>)`, which the plugin's
 * PreToolUse hook matches (auto mode drops Agent allow rules from the settings, and a hook's allow is what
 * clears a refused spawn).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import * as Effect from "effect/Effect";

import { stateRefusal, type Refusal } from "../errors.ts";
import { asObject, type Json } from "../json.ts";
import type { Choice, RefusedCall } from "./model.ts";

/** The tools a permission handles: a shell command, and a subagent's spawn. */
export const PERMISSION_TOOLS: readonly string[] = ["Bash", "Agent"];

/** The option that grants the call once. */
export const ALLOW_ONCE = "allow-once";

/** How long a grant the call has not used stays; the hook's GRANT_TTL_S is the same. */
const GRANT_TTL_MIN = 30;

/** The same in milliseconds: the hub takes a grant's rule back itself once it is this old (hub/grants.ts). */
export const GRANT_TTL_MS = GRANT_TTL_MIN * 60_000;

/** The longest Bash call a permission holds: the user reads it whole, wrapped, on a phone (about a screen and a
 * half at 390 px); a longer one is a script. The hook's CALL_MAX_CHARS is the same. */
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
 * one can. An Agent call is its input as a JSON object, which the hook alone matches. For Bash the hook's
 * `_holdable` refuses the same calls: a newline ends a rule, a `*` would match more than the call, a backslash
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

/** The programs whose first argument is the script they run. */
const INTERPRETERS: readonly string[] = ["bash", "sh", "node", "python", "python3"];

/** Words that only lead to the command that runs: shell keywords, and the wrappers that take a command. */
const LEADERS: readonly string[] = ["{", "!", "if", "then", "else", "elif", "do", "while", "until", "time", "nice", "nohup", "command", "builtin", "noglob", "exec", "env", "timeout", "stdbuf"];

/** The words of each simple command of a Bash call a permission can hold (no backslash, pipe or newline): split
 * on `;`, `&&`, `||`, `&` and the parentheses of a group outside quotes, each word without its quotes. */
function simpleCommands(call: string): string[][] {
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

  for (const [at, c] of [...call].entries()) {
    if (quote !== "") {
      if (c === quote) quote = "";
      else word = (word ?? "") + c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === " " || c === "\t") endWord();
    else if (c === ";" || c === "(" || c === ")" || (c === "&" && call[at - 1] !== ">" && call[at - 1] !== "<" && call[at + 1] !== ">")) endCommand();
    else word = (word ?? "") + c;
  }

  endCommand();

  return commands;
}

/** The script file each simple command of a Bash call runs, where its text names one: the first argument of an
 * interpreter (INTERPRETERS: `bash <path>`, `sh`, `node`, `python`, `python3`), or a command given as a path
 * (`<path> args`). A command found by name (`just deploy`, `pnpm run deploy`, `wrangler deploy`) names none: what
 * it runs is looked up when it runs. Assignments, shell keywords and wrappers before the command are skipped. */
export function scriptsOf(call: string): string[] {
  return simpleCommands(call).flatMap((all) => {
    let words = all;

    for (;;) {
      const [first = "", ...rest] = words;

      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(first)) words = rest;
      else if (LEADERS.includes(first)) words = rest.slice(rest.findIndex((w) => !w.startsWith("-") && !/^[0-9.]+[smhd]?$/u.test(w)) >>> 0);
      else break;
    }

    const [program = "", argument] = words;

    if (INTERPRETERS.includes(program)) return argument === undefined || argument.startsWith("-") ? [] : [argument];

    return program.includes("/") ? [program] : [];
  });
}

/** Why a Bash call cannot be asked for before it runs, though a rule can hold it: the user allows what they read,
 * so the call names what it runs. A command substitution is decided when it runs, and a script named by a
 * relative path is whatever file that path finds from the directory the call happens to run in. */
export function whyNoAsk(call: string): string | undefined {
  if (call.includes("$(") || call.includes("`") || call.includes("<(") || call.includes(">(")) {
    return "the call has a command substitution ($( ), backticks or <( )), so what it runs is decided when it runs, not when the user reads it: give the value itself, or put the lines in a script";
  }

  const relative = scriptsOf(call).find((path) => !isAbsolute(path));

  if (relative !== undefined) {
    return `the call runs the script ${relative} by a relative path: give its absolute path, so the file the user allows is the file that runs`;
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

/** The files a permission's calls are bound to, as the row and the page hold them: `<n> <sha256> <path>` for each
 * script call n runs by an absolute path that can be read now (`scriptsOf`). The hub grants a call only while
 * its files hash to what the page showed, and the hook lets it run only while they still do. A call with no
 * entry is bound to no file. */
export function runsOf(calls: readonly string[]): string[] {
  return calls.flatMap((call, k) =>
    [...new Set(scriptsOf(call))].flatMap((path) => {
      const sha = isAbsolute(path) ? fileSha256(path) : undefined;

      return sha === undefined ? [] : [`${String(k + 1)} ${sha} ${path}`];
    }),
  );
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

/** Why the calls of an ask cannot be asked for (`whyNoAsk`, and a script that cannot be read), naming which. The hub
 * checks a row by the same rule before it grants. */
export function whyNoAsks(calls: readonly string[]): string | undefined {
  for (const [k, call] of calls.entries()) {
    const which = calls.length === 1 ? "this call" : `call ${String(k + 1)} of ${String(calls.length)} (\`${call}\`)`;
    const why = whyNoAsk(call);

    if (why !== undefined) return `no permission for ${which}: ${why}`;
    const unread = scriptsOf(call).find((path) => fileSha256(path) === undefined);

    if (unread !== undefined) return `no permission for ${which}: it runs ${unread}, which is no file that can be read, so the user would allow a file that is not there`;
  }

  return undefined;
}

/** The refusal a permission row carries, or why the CLI refuses to open one. */
export function makeRefusedCall(given: RefusedGiven): Effect.Effect<RefusedCall, Refusal> {
  if (!PERMISSION_TOOLS.includes(given.tool)) return Effect.fail(stateRefusal(`a permission handles ${PERMISSION_TOOLS.join(" and ")} alone, got --tool ${given.tool}`));
  const more = given.more ?? [];
  const calls = [given.call, ...more];
  const why = whyNoCalls(given.tool, calls) ?? (given.tool === "Bash" && given.cause === "" ? whyNoAsks(calls) : undefined);

  if (why !== undefined) return Effect.fail(stateRefusal(given.tool === "Bash" && why.startsWith("no permission for ") ? `${why}. ${SUPPORTED_FORM}` : why));

  if (!isAbsolute(given.root)) return Effect.fail(stateRefusal(`--root is the session's project directory, an absolute path, got ${given.root}`));
  const row: RefusedCall = { tool: given.tool, call: given.call, rule: ruleOf(given.tool, given.call), cause: given.cause, root: given.root, agent_id: given.agentId };

  if (more.length > 0) row.more = [...more];
  const runs = given.tool === "Bash" ? runsOf(calls) : [];

  if (runs.length > 0) row.runs = runs;

  return Effect.succeed(row);
}

/** A permission's two options, which the CLI sets itself, each saying what it means for the user; the rule
 * and the file it goes into show with the call on the page. */
export function permissionOptions(refusal: RefusedCall): Choice[] {
  const count = callsOf(refusal).length;
  const who = isAsk(refusal) ? "the fleet" : "the worker";
  const stopped = isAsk(refusal) ? "the fleet does not run it; your note goes to it" : "the worker stays stopped; your note goes to it";

  if (count > 1) {
    return [
      {
        id: ALLOW_ONCE,
        label: `Allow these ${String(count)} calls, once each`,
        consequence: `${who} runs exactly the ${String(count)} calls shown above, once each, and nothing like them after: each one-time grant goes once its call ran, and any left go after ${String(GRANT_TTL_MIN)} minutes`,
      },
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
    { id: "deny", label: "Deny", consequence: stopped },
  ];
}
