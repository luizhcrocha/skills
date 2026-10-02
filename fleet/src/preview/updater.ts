/**
 * The combined preview's updater: which workers the merge takes, and the loop that looks every
 * `FLEET_PREVIEW_S` seconds (3 by default) and records what changed. An idle look costs one `jj util
 * snapshot` per worker (nothing to record: "No snapshot needed") and one read of the workspaces' commits;
 * the merge is rebuilt, and the record written, only when a commit moved.
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { stampOf } from "../clock.ts";
import { PreviewError } from "../errors.ts";
import { isDir, readText } from "../files.ts";
import { asArray, asObject, asString, parseObject, type Json, type JsonObject } from "../json.ts";
import type { Machine } from "../world.ts";
import { freshMemory, look, type Memory, type Pick } from "./merge.ts";
import { readRecord, updateRecord, type PreviewRecord } from "./record.ts";

/** A worker in one of these is at work: its workspace is in the preview unless taken out. Any other worker
 * is in it while its changes are not in the stack. */
const LIVE = new Set(["running", "queued", "blocked"]);

/** How often the updater looks, in seconds, unless `FLEET_PREVIEW_S` says otherwise. */
export const DEFAULT_EVERY_S = 3;

/** The updater's interval in milliseconds. */
export function everyMs(machine: Machine): number {
  const given = Number(machine.env("FLEET_PREVIEW_S"));

  return 1000 * (Number.isFinite(given) && given > 0 ? given : DEFAULT_EVERY_S);
}

/** A worker's workspace the preview may take: an active `workspaces[]` row that is no preview. */
export interface Candidate extends Pick {
  /** The worker's status, or undefined when the ledger has no row for it. */
  readonly status: string | undefined;
  readonly name: string;
}

/** `value` as a list of one object, or none. */
function objectOf(value: Json): JsonObject[] {
  const o = asObject(value);

  return o === undefined ? [] : [o];
}

/** The ledger in DIR, read only. */
export function readLedger(root: string): JsonObject | undefined {
  return Option.getOrUndefined(parseObject(readText(join(root, "state.json")) ?? ""));
}

/** Every worker's workspace the preview may take, in the ledger's order. */
export function candidates(raw: JsonObject | undefined): Candidate[] {
  const agents = (asArray(raw?.["agents"]) ?? []).flatMap((a) => objectOf(a));

  return (asArray(raw?.["workspaces"]) ?? []).flatMap((item) => {
    const row = asObject(item);
    const workspace = asString(row?.["id"]);
    const path = asString(row?.["path"]);

    if (row === undefined || workspace === undefined || path === undefined || row["status"] === "pruned" || row["kind"] === "preview") return [];
    const id = asString(row["agent"]) ?? workspace;
    const agent = agents.find((a) => asString(a["id"]) === id);

    return [{ id, workspace, path, status: asString(agent?.["status"]), name: asString(agent?.["name"]) ?? id }];
  });
}

/** What the record says of the workers: who was taken in or out, and whom the last look merged. */
interface Choices {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly merged: readonly { readonly id: string }[];
}

/** Whether the merge takes this worker whatever its commits: at work, or taken in by hand, and not taken out. */
function always(c: Candidate, record: Choices): boolean {
  return !record.exclude.includes(c.id) && (record.include.includes(c.id) || (c.status !== undefined && LIVE.has(c.status)));
}

/** Whether the merge takes this worker: not taken out, and at work, taken in, or (as the last look found)
 * with changes the stack has not. */
export function included(c: Candidate, record: Choices): boolean {
  return always(c, record) || (!record.exclude.includes(c.id) && record.merged.some((m) => m.id === c.id));
}

/** Why a worker is in the merge or out of it, for `status`: taken out, taken in, its status when at work,
 * else its status and whether its changes are merged, already in the stack, or gone with its workspace. */
export function standing(c: Candidate, record: Choices): string {
  const status = c.status ?? "no row";

  if (record.exclude.includes(c.id)) return "taken out";

  if (record.include.includes(c.id)) return "taken in";

  if (always(c, record)) return status;

  if (record.merged.some((m) => m.id === c.id)) return `${status}, merged`;

  return isDir(c.path) ? `${status}, already in the stack` : `${status}, its workspace is gone`;
}

function sameMerge(a: PreviewRecord, b: PreviewRecord): boolean {
  return (
    a.commit === b.commit &&
    a.stack === b.stack &&
    a.error === b.error &&
    JSON.stringify(a.merged) === JSON.stringify(b.merged) &&
    JSON.stringify(a.conflicts) === JSON.stringify(b.conflicts)
  );
}

/** One look at the fleet in DIR: the merge brought up to date and, when anything changed, recorded. The
 * record as it stands after; undefined when there is no preview. */
export function lookOnce(machine: Machine, root: string, memory: Memory): PreviewRecord | undefined {
  const record = readRecord(root);

  if (record === undefined) return undefined;
  const picked = candidates(readLedger(root)).flatMap((c) => (record.exclude.includes(c.id) ? [] : [{ ...c, untilIntegrated: !always(c, record) }]));
  const found = look(record.repo, record.workspace, record.path, picked, memory);

  return updateRecord(root, (now) => {
    if (now === undefined) return undefined;
    const next: PreviewRecord = { ...now, merged: found.merged, stack: found.stack, commit: found.commit, conflicts: found.conflicts, error: found.error };

    if (sameMerge(now, next)) return undefined;

    return { ...next, updated: stampOf(machine.now()) };
  });
}

/** The updater's loop: look, wait, look again, until the record no longer names this process (stopped, or
 * another updater took over) or a signal stops it. It waits up to ten seconds for `start` to record it. */
export async function runUpdater(machine: Machine, root: string): Promise<number> {
  const memory = freshMemory();
  const every = everyMs(machine);
  let stopping = false;

  process.once("SIGTERM", () => {
    stopping = true;
  });

  process.once("SIGINT", () => {
    stopping = true;
  });

  for (let waited = 0; readRecord(root)?.updater !== process.pid; waited += 100) {
    if (waited >= 10_000) return 1;
    await Bun.sleep(100);
  }

  while (!stopping && readRecord(root)?.updater === process.pid) {
    try {
      lookOnce(machine, root, memory);
    } catch (cause: unknown) {
      process.stderr.write(`preview: a look failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }

    await Bun.sleep(every);
  }

  return 0;
}

/** Take `worker` into the merge (`include`) or out of it; the record after, or why not. */
export function pick(root: string, raw: JsonObject | undefined, worker: string, include: boolean): PreviewRecord | PreviewError {
  const cand = candidates(raw).find((c) => c.id === worker || c.workspace === worker);

  if (cand === undefined) return new PreviewError({ reason: `${worker} has no active workspace in this fleet` });
  let missing = false;

  const next = updateRecord(root, (now) => {
    if (now === undefined) {
      missing = true;

      return undefined;
    }

    const exclude = now.exclude.filter((w) => w !== cand.id);
    const taken = now.include.filter((w) => w !== cand.id);

    return include ? { ...now, include: [...taken, cand.id], exclude } : { ...now, include: taken, exclude: [...exclude, cand.id] };
  });

  return missing || next === undefined ? new PreviewError({ reason: `there is no preview: \`fleet preview ${root} start\` makes one` }) : next;
}

export { freshMemory };
