/**
 * What the session transcripts say (Python's `spend.py`): a DIR at `…/<project>/<session>/scratchpad/<name>`
 * names its session's transcript under `$CLAUDE_CONFIG_DIR/projects/`, and its workers' under
 * `<session>/subagents/agent-<id>.jsonl`. Any other DIR has none, and every figure read here is absent
 * (open-23: a worker's heartbeat, [heartbeat.ts](heartbeat.ts), is read first).
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { parseInstant, stampOf } from "./clock.ts";
import { exists, isDir, listDir, mtimeOf, readText, resolvePath } from "./files.ts";
import { asNumber, asObject, asString, parseJson, truthy, type JsonObject } from "./json.ts";
import * as Option from "effect/Option";

/** Where Claude Code keeps transcripts: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function configDir(env: (name: string) => string | undefined): string {
  const given = env("CLAUDE_CONFIG_DIR");

  return given !== undefined && given !== "" ? given : join(env("HOME") ?? "", ".claude");
}

/** The transcript of the session whose scratchpad holds `root`, or undefined. */
export function transcriptOf(root: string, config: string): string | undefined {
  const parts = resolvePath(root).split(sep);
  parts[0] = sep;

  if (parts.length < 4 || parts.at(-2) !== "scratchpad") return undefined;

  return join(config, "projects", parts.at(-4) ?? "", `${parts.at(-3) ?? ""}.jsonl`);
}

/** The folder beside session `sessionId`'s transcript (`projects/<project>/<session>`), in whichever project
 * holds that transcript or folder, or undefined. */
export function sessionFolderOf(config: string, sessionId: string | null | undefined): string | undefined {
  if (sessionId === undefined || sessionId === null || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined;
  const projects = join(config, "projects");

  return listDir(projects)
    .map((project) => join(projects, project, sessionId))
    .find((folder) => isDir(folder) || exists(`${folder}.jsonl`));
}

/** The transcript of the session serving `root` now: session `sessionId`'s, the one its registry entry
 * records (`fleet serve` writes it; a resumed session has a new id while `root` stays in the scratchpad of
 * the session that made it), when that transcript is found, else the scratchpad's; undefined when neither. */
export function servingTranscriptOf(root: string, config: string, sessionId?: string | null): string | undefined {
  const folder = sessionFolderOf(config, sessionId);

  return folder !== undefined && exists(`${folder}.jsonl`) ? `${folder}.jsonl` : transcriptOf(root, config);
}

/** When the session serving `root` (session `sessionId`, else the scratchpad's) last wrote its transcript,
 * as a local stamp, or undefined. */
export function activeAt(root: string, config: string, sessionId?: string | null): string | undefined {
  const path = servingTranscriptOf(root, config, sessionId);
  const at = path === undefined ? undefined : mtimeOf(path);

  return at === undefined ? undefined : stampOf(new Date(at * 1000));
}

/** How much of a transcript's end is read for its last entry. */
const TAIL_BYTES = 256 * 1024;

/** A usage-limit error a session's turn ended on, as its transcript holds it. */
export interface LimitHit {
  /** When the error was written, in ms: the entry's `timestamp`, else the transcript's last write. */
  readonly atMs: number;
  /** The window that was full, as the entry names it (`quotaLimits.rateLimitType`: `five_hour`,
   * `seven_day`); undefined when it names none (out of usage credits, an older Claude Code). */
  readonly window: string | undefined;
  /** When the entry says that window resets, in ms (`quotaLimits.resetsAt`, in seconds); undefined when it does not. */
  readonly resetsAtMs: number | undefined;
}

/**
 * The usage-limit error the session's last entry in the transcript at `path` is, or undefined when its
 * last entry is anything else: the turn ended on it, and a new turn would end on it again while the limit
 * holds (whether it still does is wake.ts `limitInForce`).
 *
 * The shape, read from Claude Code 2.1.29x transcripts (2026-10-12): the error is one line with
 * `"type": "assistant"`, `"isApiErrorMessage": true` and `"error": "rate_limit"` (its `apiErrorStatus` is
 * 429 and its `message.model` `<synthetic>`); the session limit, the weekly limit, the monthly spend limit
 * and "out of usage credits" all carry it, and a server or login error carries another `error`. It has a
 * `timestamp`, and, but for "out of usage credits", `quotaLimits` with `rateLimitType` (`five_hour` or
 * `seven_day`) and `resetsAt` (seconds since the epoch). Lines whose `type` is neither `assistant` nor
 * `user` follow it (the turn's duration, the bridge's state, the cost): they are passed over, so the last
 * entry is the last `assistant` or `user` line. Only the last {@link TAIL_BYTES} are read; a line cut by
 * that, and a transcript with no such line in them, is no error.
 */
export function usageLimitHit(path: string): LimitHit | undefined {
  let size: number;

  try {
    size = statSync(path).size;
  } catch {
    return undefined;
  }

  const from = Math.max(0, size - TAIL_BYTES);
  let lines: string[];

  try {
    lines = readRange(path, from, size).toString("utf8").split("\n");
  } catch {
    return undefined;
  }

  // The first line of a tail that does not start the file is cut: it is not read.
  for (let i = lines.length - 1; i >= (from > 0 ? 1 : 0); i -= 1) {
    const row = asObject(Option.getOrUndefined(parseJson(lines[i] ?? "")));
    const type = row?.["type"];

    if (row === undefined || (type !== "assistant" && type !== "user")) continue;

    if (type !== "assistant" || row["isApiErrorMessage"] !== true || row["error"] !== "rate_limit") return undefined;
    const quota = asObject(row["quotaLimits"]);
    const resets = asNumber(quota?.["resetsAt"]);

    return {
      atMs: parseInstant(asString(row["timestamp"]) ?? "") ?? (mtimeOf(path) ?? 0) * 1000,
      window: asString(quota?.["rateLimitType"]),
      resetsAtMs: resets === undefined ? undefined : resets * 1000,
    };
  }

  return undefined;
}

/** The `type` and the content blocks of one transcript row that is an entry (`assistant` or `user`); undefined
 * for any other row. */
function entryOf(row: JsonObject): { readonly type: "assistant" | "user"; readonly blocks: readonly JsonObject[] } | undefined {
  const type = row["type"];

  if (type !== "assistant" && type !== "user") return undefined;
  const content = asObject(row["message"])?.["content"];

  const blocks = (Array.isArray(content) ? content : []).flatMap((b) => {
    const block = asObject(b);

    return block === undefined ? [] : [block];
  });

  return { type, blocks };
}

/** Where a session's turn stands, as its transcript holds it ({@link turnOf}). */
export type Turn = "finished" | "call" | "open";

/**
 * Where the session's turn stands, as the last {@link TAIL_BYTES} of the transcript at `path` hold it:
 *
 * - `finished`: Claude Code closed the turn, and nothing of the session's was written since. The session waits
 *   for a prompt.
 * - `call`: a tool call of the turn awaits its result. A tool call writes nothing while it runs (a build, a
 *   subagent in the foreground, a permission prompt nobody answered), so the session is in a turn however
 *   quiet its transcript.
 * - `open`: anything else. The model has a prompt, a notification or a result to answer and has written
 *   nothing yet, or it writes; or the turn ended with no mark of it (an interrupt, a local command, a
 *   compaction), or the tail holds no line of the session's. The transcript does not tell these apart: the
 *   caller waits for it to go quiet.
 *
 * Read from Claude Code 2.1.286 to 2.1.296 transcripts of interactive sessions (2026-10-13):
 *
 * - The close is one line, `"type": "system"`, `"subtype": "turn_duration"`, written after the Stop hooks ran
 *   (`stop_hook_summary` stands before it), a median 0.1 s after the assistant's last line (`message.stop_reason`
 *   `end_turn`), and after an API error too (a usage limit, a server error). A Stop hook that blocks writes
 *   none: the turn goes on. In ten hosts' transcripts the line after each of 7283 closes was a `user` line;
 *   over 23 interactive sessions an `assistant` line followed once in about 9700. A headless session
 *   (`entrypoint` `sdk-cli`) writes none, so its turn never reads as finished.
 * - `stop_reason` does not say it: every line of a message carries the message's own (`tool_use` on the
 *   thinking block before a call), and `end_turn` stands before the Stop hooks ran.
 * - A turn begins with a `user` line: a prompt, a `<task-notification>`, or an `isMeta` line (4076 of the
 *   7283 lines that followed a close). The line is written when the turn begins; the model's first line
 *   comes a median 3.8 s later, more than 30 s later in 179 of 34138, and nothing of the session's is
 *   written meanwhile.
 * - A tool call: an `assistant` line carries one content block, a `tool_use` with its `id`; its result is a
 *   later `user` line with a `tool_result` block naming that id (`tool_use_id`); an interrupted call is given a
 *   result too. A `user` line that carries no result and is not `isMeta` is a prompt: what was open before it
 *   is not this turn's.
 * - A compaction writes its summary as a `user` line (`isCompactSummary`), in a turn or between two: one of the
 *   ten hosts had been compacted 55 minutes after its last close, with nothing after. It begins no turn and
 *   ends none.
 * - `queue-operation` lines say nothing of the session's turn: a subagent's background command is enqueued in
 *   the session's transcript too.
 *
 * A subagent's lines (`isSidechain`) are not the session's. A call written before `sinceMs` (when the process
 * that runs now started) was another process's: the session was closed in the middle of it and resumed, and
 * nothing runs it now. A transcript that cannot be read is `open`.
 */
export function turnOf(path: string, sinceMs: number | undefined = undefined): Turn {
  let size: number;

  try {
    size = statSync(path).size;
  } catch {
    return "open";
  }

  const from = Math.max(0, size - TAIL_BYTES);
  let lines: string[];

  try {
    lines = readRange(path, from, size).toString("utf8").split("\n");
  } catch {
    return "open";
  }

  const awaited = new Map<string, number | undefined>();
  let finished = false;

  // The first line of a tail that does not start the file is cut: it is not read.
  for (const line of lines.slice(from > 0 ? 1 : 0)) {
    const row = asObject(Option.getOrUndefined(parseJson(line)));

    if (row === undefined || row["isSidechain"] === true) continue;

    if (row["type"] === "system" && row["subtype"] === "turn_duration") {
      finished = true;
      awaited.clear();

      continue;
    }

    const entry = entryOf(row);

    // A compaction's summary is a `user` line and no prompt: the turn stands where it stood.
    if (entry === undefined || row["isCompactSummary"] === true) continue;
    finished = false;

    if (entry.type === "assistant") {
      for (const block of entry.blocks) {
        const id = asString(block["id"]);

        if (block["type"] === "tool_use" && id !== undefined) awaited.set(id, parseInstant(asString(row["timestamp"]) ?? ""));
      }

      continue;
    }

    const results = entry.blocks.filter((b) => b["type"] === "tool_result");

    for (const result of results) awaited.delete(asString(result["tool_use_id"]) ?? "");

    if (results.length === 0 && row["isMeta"] !== true) awaited.clear();
  }

  if (finished) return "finished";

  return [...awaited.values()].some((at) => sinceMs === undefined || at === undefined || at >= sinceMs) ? "call" : "open";
}

const WHO = /(?:your id is|You are) ([A-Za-z][A-Za-z0-9_.-]*?)[,.\s"]/;

/** How much of a transcript's start is read for its first line. */
const HEAD_BYTES = 20000;

/** The worker ids already read, by transcript path: a transcript only grows, so once its first line is
 * whole (or the head read is full) it names the same worker until the file is replaced (another inode). */
const namedHeads = new Map<string, { readonly inode: bigint; readonly id: string | undefined }>();

/** The worker id a subagent's transcript was given on its first line (its brief's `your id is X`), or
 * undefined. Reads only the transcript's first {@link HEAD_BYTES} bytes, and an unchanged file not again. */
export function workerNamedIn(path: string): string | undefined {
  let inode: bigint;

  try {
    inode = statSync(path, { bigint: true }).ino;
  } catch {
    namedHeads.delete(path);

    return undefined;
  }

  const held = namedHeads.get(path);

  if (held !== undefined && held.inode === inode) return held.id;
  let head: Buffer;

  try {
    head = readHead(path, HEAD_BYTES);
  } catch {
    return undefined;
  }

  const id = WHO.exec(head.toString("utf8").split("\n")[0] ?? "")?.[1];

  if (head.includes(0x0a) || head.length >= HEAD_BYTES) namedHeads.set(path, { inode, id });

  return id;
}

function subagents(root: string, config: string): string | undefined {
  const transcript = transcriptOf(root, config);

  return transcript === undefined ? undefined : join(transcript.replace(/\.jsonl$/, ""), "subagents");
}

/** When each worker of that session last wrote its transcript, by the id its brief gave it, in seconds. */
export function lastActivity(root: string, config: string): Map<string, number> {
  const folder = subagents(root, config);
  const seen = new Map<string, number>();

  if (folder === undefined || !isDir(folder)) return seen;

  for (const name of listDir(folder)) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    const path = join(folder, name);
    const id = workerNamedIn(path);
    const at = mtimeOf(path);

    if (id === undefined || at === undefined) continue;
    seen.set(id, Math.max(seen.get(id) ?? 0, at));
  }

  return seen;
}

function figures(usage: JsonObject): readonly [number, number, number, number] {
  const number = (key: string): number => Math.trunc(asNumber(usage[key]) ?? 0);

  return [number("output_tokens"), number("input_tokens"), number("cache_creation_input_tokens"), number("cache_read_input_tokens")];
}

function rows(text: string): JsonObject[] {
  return text.split("\n").flatMap((line) => {
    const row = asObject(Option.getOrUndefined(parseJson(line)));

    return row === undefined ? [] : [row];
  });
}

/** The name a session gave worker `taskId`: its subagent's meta.json `name` (the Agent tool's), else its
 * `description`, in the first of the session `folders` that has it; undefined without one. */
export function workerTitle(folders: readonly string[], taskId: string): string | undefined {
  const text = folders.map((folder) => readText(join(folder, "subagents", `agent-${taskId}.meta.json`))).find((t) => t !== undefined);
  const meta = text === undefined ? undefined : asObject(Option.getOrUndefined(parseJson(text)));

  for (const key of ["name", "description"]) {
    const value = asString(meta?.[key])?.trim();

    if (value !== undefined && value !== "") return value;
  }

  return undefined;
}

/** What a worker has used, from its own transcript. */
export interface WorkerFigures {
  readonly tokens: number;
  readonly duration_ms: number;
  readonly at: number;
}

/** The worker `taskId`'s context at its last answer, its duration (first line to last) and the
 * transcript's mtime; undefined without such a transcript or any usage in it. */
export function workerFigures(root: string, config: string, taskId: string): WorkerFigures | undefined {
  const folder = subagents(root, config);

  if (folder === undefined) return undefined;
  const path = join(folder, `agent-${taskId}.jsonl`);
  const at = mtimeOf(path);
  const text = readText(path);

  if (at === undefined || text === undefined) return undefined;
  let last: JsonObject | undefined;
  let first: string | undefined;
  let latest: string | undefined;

  for (const row of rows(text)) {
    const stamp = asString(row["timestamp"]);

    if (stamp !== undefined) {
      first ??= stamp;
      latest = stamp;
    }

    const usage = asObject(asObject(row["message"])?.["usage"]);

    if (usage !== undefined) last = usage;
  }

  if (last === undefined) return undefined;
  const [output, fresh, written, cached] = figures(last);
  const from = first === undefined ? NaN : Date.parse(first);
  const to = latest === undefined ? NaN : Date.parse(latest);
  const span = Number.isNaN(from) || Number.isNaN(to) ? 0 : Math.trunc(to - from);

  return { tokens: output + fresh + written + cached, duration_ms: span, at };
}

/** What a session spent in its own answers. */
export interface Spent {
  readonly output: number;
  readonly input: number;
  readonly cached: number;
  readonly answers: number;
}

interface Held {
  offset: number;
  inode: bigint;
  looked: number;
  spent: Spent;
  readonly answers: Map<string, readonly [number, number, number, number]>;
}

/** Reads what sessions spent, each transcript from where the last look stopped (Python's `spend.of`):
 * a long-running reader (the hub) reads a growing transcript once. */
export class SpendReader {
  private readonly held = new Map<string, Held>();

  /** What the session that owns `root` spent, or undefined when it has no transcript. The transcript
   * is looked at again once `waitS` seconds have passed since the last look. */
  of(root: string, config: string, waitS = 5): Spent | undefined {
    const path = transcriptOf(root, config);

    if (path === undefined) return undefined;
    const now = performance.now() / 1000;
    let held = this.held.get(path);

    if (held !== undefined && now - held.looked < waitS) return held.spent;
    let stat: { readonly size: bigint; readonly ino: bigint };

    try {
      stat = statSync(path, { bigint: true });
    } catch {
      this.held.delete(path);

      return undefined;
    }

    const size = Number(stat.size);

    if (held === undefined || size < held.offset || stat.ino !== held.inode) {
      held = { offset: 0, inode: stat.ino, looked: now, spent: { output: 0, input: 0, cached: 0, answers: 0 }, answers: new Map() };
    }

    if (size > held.offset) {
      const chunk = readRange(path, held.offset, size);
      const whole = chunk.subarray(0, chunk.lastIndexOf(0x0a) + 1);
      held.offset += whole.length;

      for (const line of whole.toString("utf8").split("\n")) {
        if (!line.includes('"usage"')) continue;
        const record = asObject(Option.getOrUndefined(parseJson(line)));
        const message = asObject(record?.["message"]);

        if (record === undefined || record["type"] !== "assistant" || truthy(record["isSidechain"]) || message === undefined) continue;
        const usage = asObject(message["usage"]);
        const id = asString(message["id"]);

        if (usage !== undefined && id !== undefined) held.answers.set(id, figures(usage));
      }
    }

    let output = 0;
    let input = 0;
    let cached = 0;

    for (const [o, fresh, written, read] of held.answers.values()) {
      output += o;
      input += fresh + written;
      cached += read;
    }

    held.looked = now;
    held.spent = { output, input: input + cached, cached, answers: held.answers.size };
    this.held.set(path, held);

    return held.spent;
  }
}

/** Reads the last AI title (`{"type": "ai-title", "aiTitle": …}`) of transcripts, each from where the last
 * read stopped, so the registry, read every second by the hub, reads a growing transcript once. */
export class AiTitles {
  private readonly held = new Map<string, { offset: number; inode: bigint; title: string | undefined }>();

  /** The last AI title in the transcript at `path`, or undefined when it has none; of one that cannot be
   * read, the last it read. */
  latest(path: string): string | undefined {
    let stat: { readonly size: bigint; readonly ino: bigint };

    try {
      stat = statSync(path, { bigint: true });
    } catch {
      this.held.delete(path);

      return undefined;
    }

    const size = Number(stat.size);
    let held = this.held.get(path);

    if (held === undefined || size < held.offset || stat.ino !== held.inode) held = { offset: 0, inode: stat.ino, title: undefined };

    if (size > held.offset) {
      let chunk: Buffer;

      try {
        chunk = readRange(path, held.offset, size);
      } catch {
        // A transcript that cannot be read names nothing new: the registry reads every fleet's, and one
        // fleet's file must not stop the others being listed.
        return held.title;
      }

      const whole = chunk.subarray(0, chunk.lastIndexOf(0x0a) + 1);
      held.offset += whole.length;

      for (const line of whole.toString("utf8").split("\n")) {
        if (!line.includes('"ai-title"')) continue;
        const record = asObject(Option.getOrUndefined(parseJson(line)));
        const title = record?.["type"] === "ai-title" ? asString(record["aiTitle"])?.trim() : undefined;

        if (title !== undefined && title !== "") held.title = title;
      }
    }

    this.held.set(path, held);

    return held.title;
  }
}

/** The first `most` bytes of `path`, fewer when it is shorter. */
function readHead(path: string, most: number): Buffer {
  const chunk = Buffer.alloc(most);
  const fd = openSync(path, "r");

  try {
    return chunk.subarray(0, readSync(fd, chunk, 0, most, 0));
  } finally {
    closeSync(fd);
  }
}

function readRange(path: string, from: number, to: number): Buffer {
  const chunk = Buffer.alloc(to - from);
  const fd = openSync(path, "r");

  try {
    readSync(fd, chunk, 0, chunk.length, from);
  } finally {
    closeSync(fd);
  }

  return chunk;
}

/** What the session that owns `root` spent, read now, or undefined when it has no transcript. */
export function spentBy(root: string, config: string): Spent | undefined {
  return new SpendReader().of(root, config, 0);
}
