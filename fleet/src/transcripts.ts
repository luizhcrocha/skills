/**
 * What the session transcripts say (Python's `spend.py`): a DIR at `…/<project>/<session>/scratchpad/<name>`
 * names its session's transcript under `$CLAUDE_CONFIG_DIR/projects/`, and its workers' under
 * `<session>/subagents/agent-<id>.jsonl`. Any other DIR has none, and every figure read here is absent
 * (open-23: stage 4 replaces this with the heartbeat).
 */
import { join, sep } from "node:path";

import { stampOf } from "./clock.ts";
import { isDir, listDir, mtimeOf, readBytes, readText, resolvePath } from "./files.ts";
import { asNumber, asObject, asString, parseJson, type JsonObject } from "./json.ts";
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

/** When that session last wrote its transcript, as a local stamp, or undefined. */
export function activeAt(root: string, config: string): string | undefined {
  const path = transcriptOf(root, config);
  const at = path === undefined ? undefined : mtimeOf(path);

  return at === undefined ? undefined : stampOf(new Date(at * 1000));
}

const WHO = /(?:your id is|You are) ([A-Za-z][A-Za-z0-9_.-]*?)[,.\s"]/;

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
    const head = readBytes(path)?.subarray(0, 20000).toString("utf8");

    if (head === undefined) continue;
    const firstLine = head.split("\n")[0] ?? "";
    const id = WHO.exec(firstLine)?.[1];
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

/** What the session that owns `root` spent, or undefined when it has no transcript. */
export function spentBy(root: string, config: string): Spent | undefined {
  const path = transcriptOf(root, config);
  const text = path === undefined ? undefined : readText(path);

  if (text === undefined) return undefined;
  const whole = text.slice(0, text.lastIndexOf("\n") + 1);
  const answers = new Map<string, readonly [number, number, number, number]>();

  for (const line of whole.split("\n")) {
    if (!line.includes('"usage"')) continue;
    const record = asObject(Option.getOrUndefined(parseJson(line)));
    const message = asObject(record?.["message"]);

    if (record === undefined || record["type"] !== "assistant" || record["isSidechain"] === true || message === undefined) continue;
    const usage = asObject(message["usage"]);
    const id = asString(message["id"]);

    if (usage !== undefined && id !== undefined) answers.set(id, figures(usage));
  }

  let output = 0;
  let input = 0;
  let cached = 0;

  for (const [o, fresh, written, read] of answers.values()) {
    output += o;
    input += fresh + written;
    cached += read;
  }

  return { output, input: input + cached, cached, answers: answers.size };
}
