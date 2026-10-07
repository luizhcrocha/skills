/**
 * Heartbeats: the plugin's hook (`hooks/tstack-hook`, `fleet_heartbeat`) writes one small JSON file per
 * session, and per subagent, in `DIR/heartbeats/` at every tool call, session start and stop, and
 * subagent start and stop. Read here for when each worker was last seen and what it last ran; a worker
 * with no heartbeat falls back to its transcript's time ({@link lastActivity}).
 */
import { basename, dirname, join, sep } from "node:path";

import * as Option from "effect/Option";

import { parseInstant } from "./clock.ts";
import { isDir, listDir, readText } from "./files.ts";
import { asArray, asObject, asString, parseJson, type JsonObject } from "./json.ts";
import { lastActivity, workerNamedIn } from "./transcripts.ts";

/** One heartbeat file. */
export interface Beat {
  readonly session: string;
  /** Claude Code's id of the subagent that beat, or null for the session itself. */
  readonly agent: string | null;
  /** `$FLEET_WORKER` of the process that beat: a worker launched as its own session. */
  readonly worker: string | null;
  readonly cwd: string | null;
  /** The session's project directory (`$CLAUDE_PROJECT_DIR`), where its settings live; the cwd follows its shell. */
  readonly project: string | null;
  /** The jj workspace the session's cwd is in, by name. */
  readonly workspace: string | null;
  /** The absolute path the tool call named, if any. */
  readonly path: string | null;
  readonly tool: string | null;
  readonly event: string | null;
  /** The stamp as written, and the instant it names in seconds. */
  readonly stamp: string;
  readonly at: number;
  readonly transcript: string | null;
  readonly agentTranscript: string | null;
}

function text(o: JsonObject, key: string): string | null {
  const value = asString(o[key]);

  return value === undefined || value === "" ? null : value;
}

/** Every heartbeat in DIR; a file that does not parse, or has no session or time, is skipped. */
export function readBeats(root: string): Beat[] {
  const folder = join(root, "heartbeats");

  if (!isDir(folder)) return [];

  return listDir(folder).flatMap((name) => {
    if (!name.endsWith(".json") || name.startsWith(".")) return [];
    const o = asObject(Option.getOrUndefined(parseJson(readText(join(folder, name)) ?? "")));
    const session = o === undefined ? null : text(o, "session");
    const stamp = o === undefined ? null : text(o, "at");
    const at = stamp === null ? undefined : parseInstant(stamp);

    if (o === undefined || session === null || stamp === null || at === undefined) return [];

    return [
      {
        session,
        agent: text(o, "agent"),
        worker: text(o, "worker"),
        cwd: text(o, "cwd"),
        project: text(o, "project"),
        workspace: text(o, "workspace"),
        path: text(o, "path"),
        tool: text(o, "tool"),
        event: text(o, "event"),
        stamp,
        at: at / 1000,
        transcript: text(o, "transcript"),
        agentTranscript: text(o, "agent_transcript"),
      },
    ];
  });
}

function rowsOf(state: JsonObject, key: string): JsonObject[] {
  return (asArray(state[key]) ?? []).flatMap((r) => {
    const o = asObject(r);

    return o === undefined ? [] : [o];
  });
}

function inside(path: string | null, folder: string): boolean {
  return path !== null && (path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep));
}

/** The subagent's own transcript: the one the hook named, else `<session>/subagents/agent-<id>.jsonl`
 * beside the session's. */
function agentTranscriptOf(beat: Beat): string | undefined {
  if (beat.agentTranscript !== null) return beat.agentTranscript;

  if (beat.agent === null || beat.transcript === null) return undefined;

  return join(dirname(beat.transcript), basename(beat.transcript, ".jsonl"), "subagents", `agent-${beat.agent}.jsonl`);
}

/** What {@link workerOf} looks a beat up in: the ledger's workers and live workspaces, read once per ledger
 * rather than once per beat (a fleet keeps a heartbeat file per subagent, hundreds of them). */
export interface Roster {
  readonly ids: ReadonlySet<string>;
  /** Each `task_id` to the id of the first row that holds it. */
  readonly byTask: ReadonlyMap<string, string | undefined>;
  readonly workspaces: readonly { readonly id: string | undefined; readonly path: string | undefined; readonly agent: string | undefined }[];
}

/** The {@link Roster} of ledger `state`. */
export function rosterOf(state: JsonObject): Roster {
  const agents = rowsOf(state, "agents");
  const ids = new Set(agents.flatMap((a) => (asString(a["id"]) === undefined ? [] : [asString(a["id"]) ?? ""])));
  const byTask = new Map<string, string | undefined>();

  for (const a of agents) {
    const task = asString(a["task_id"]);

    if (task !== undefined && !byTask.has(task)) byTask.set(task, asString(a["id"]));
  }

  const workspaces = rowsOf(state, "workspaces")
    .filter((w) => w["status"] !== "pruned")
    .map((w) => ({ id: asString(w["id"]), path: asString(w["path"]), agent: asString(w["agent"]) }));

  return { ids, byTask, workspaces };
}

/** Which worker of the ledger beat, in this order: `$FLEET_WORKER`; the subagent whose `task_id` the
 * row holds; the subagent whose transcript's first line gives it its id; the jj workspace `fleet ws
 * add` made for it (by name, or by the cwd or the tool's path inside it); a workspace named after the
 * worker. Undefined when none says. */
export function workerOf(beat: Beat, state: JsonObject, named: (path: string) => string | undefined = workerNamedIn): string | undefined {
  return workerIn(beat, rosterOf(state), named);
}

/** {@link workerOf} against a ledger's {@link Roster}, read once for many beats. */
export function workerIn(beat: Beat, roster: Roster, named: (path: string) => string | undefined = workerNamedIn): string | undefined {
  const known = (id: string | null | undefined): string | undefined => (id !== null && id !== undefined && roster.ids.has(id) ? id : undefined);

  const byWorker = known(beat.worker);

  if (byWorker !== undefined) return byWorker;

  if (beat.agent !== null) {
    if (roster.byTask.has(beat.agent)) return known(roster.byTask.get(beat.agent));
    const transcript = agentTranscriptOf(beat);
    const byBrief = transcript === undefined ? undefined : known(named(transcript));

    if (byBrief !== undefined) return byBrief;
  }

  for (const w of roster.workspaces) {
    const mine = (w.id !== undefined && beat.workspace === w.id) || (w.path !== undefined && (inside(beat.cwd, w.path) || inside(beat.path, w.path)));

    if (mine) return known(w.agent ?? w.id);
  }

  return beat.agent === null ? known(beat.workspace) : undefined;
}

/** When a worker was last seen and how: by its heartbeat (its last tool call, or the event) or, with
 * none, by its transcript. */
export interface Seen {
  /** Seconds since the epoch. */
  readonly at: number;
  readonly by: "heartbeat" | "transcript";
  readonly tool: string | null;
  readonly event: string | null;
}

/** Each worker's last sign of life in DIR: its newest heartbeat, else its transcript's time. */
export function workerActivity(root: string, config: string, state: JsonObject, named: (path: string) => string | undefined = workerNamedIn): Map<string, Seen> {
  const seen = new Map<string, Seen>();
  const roster = rosterOf(state);
  const names = new Map<string, string | undefined>();

  const once = (path: string): string | undefined => {
    if (!names.has(path)) names.set(path, named(path));

    return names.get(path);
  };

  for (const beat of readBeats(root)) {
    const id = workerIn(beat, roster, once);
    const held = id === undefined ? undefined : seen.get(id);

    if (id !== undefined && (held === undefined || beat.at > held.at)) seen.set(id, { at: beat.at, by: "heartbeat", tool: beat.tool, event: beat.event });
  }

  for (const [id, at] of lastActivity(root, config)) {
    if (!seen.has(id)) seen.set(id, { at, by: "transcript", tool: null, event: null });
  }

  return seen;
}
