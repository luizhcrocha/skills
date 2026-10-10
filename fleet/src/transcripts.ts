/**
 * What the session transcripts say (Python's `spend.py`): a DIR at `…/<project>/<session>/scratchpad/<name>`
 * names its session's transcript under `$CLAUDE_CONFIG_DIR/projects/`, and its workers' under
 * `<session>/subagents/agent-<id>.jsonl`. Any other DIR has none, and every figure read here is absent
 * (open-23: a worker's heartbeat, [heartbeat.ts](heartbeat.ts), is read first).
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { stampOf } from "./clock.ts";
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

  /** The last AI title in the transcript at `path`, or undefined when it has none. */
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
      const chunk = readRange(path, held.offset, size);
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
