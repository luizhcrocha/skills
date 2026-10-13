/**
 * The combined preview's updater: which workers the merge takes, and the loop that looks every
 * `FLEET_PREVIEW_S` seconds (3 by default) and records what changed. An idle look costs one `jj util
 * snapshot` per worker (nothing to record: "No snapshot needed") and one read of the workspaces' commits;
 * the merge is rebuilt, and the record written, only when a commit moved.
 *
 * A worker the merge leaves out because its workspace would conflict it (`merge.ts`) is recorded with the
 * files (`left_out`), shown by `status` and the page, and told to the fleet's host in its chat, from the
 * hub's name: a fact about the machine, as its other `[hub]` lines are. The line is a fixed sentence: a
 * file's name is in it as a JSON string, cut short, and a line the chat already holds is not written again
 * within `TOLD_AGAIN_MIN` minutes, however often the worker goes out and back in.
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { hostOf } from "../chat/chat.ts";
import { appendLocked } from "../chat/store.ts";
import { parseInstant, stampOf } from "../clock.ts";
import { PreviewError } from "../errors.ts";
import { isDir, readText } from "../files.ts";
import { asArray, asObject, asString, parseObject, type Json, type JsonObject } from "../json.ts";
import { HUB_NAME } from "../registry.ts";
import type { Machine } from "../world.ts";
import { freshMemory, listed, look, quoted, type Memory, type Pick } from "./merge.ts";
import { hasRecord, readRecord, updateRecord, type LeftOut, type PreviewRecord } from "./record.ts";

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
  /** Whether its workspace was added out of the preview (`fleet ws DIR add … --no-preview`): out until
   * `fleet preview DIR include` takes it in. */
  readonly out: boolean;
}

/** What a workspace's row holds under `preview` when it was added out of the combined preview. */
export const OUT = "out";

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

    return [{ id, workspace, path, status: asString(agent?.["status"]), name: asString(agent?.["name"]) ?? id, out: row["preview"] === OUT }];
  });
}

/** What the record says of the workers: who was taken in or out, whom the last look merged, and whom it
 * left out because its workspace would conflict the merge. */
interface Choices {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly merged: readonly { readonly id: string }[];
  readonly left: readonly LeftOut[];
}

/** Whether this worker is out of the merge by someone's word: taken out (`exclude`), or its workspace added
 * out of the preview (`ws add --no-preview`) and not taken in since. */
function takenOut(c: Candidate, record: Choices): boolean {
  return record.exclude.includes(c.id) || (c.out && !record.include.includes(c.id));
}

/** Whether the merge takes this worker whatever its commits: at work, or taken in by hand, and not taken out. */
function always(c: Candidate, record: Choices): boolean {
  return !takenOut(c, record) && (record.include.includes(c.id) || (c.status !== undefined && LIVE.has(c.status)));
}

/** Whether the merge takes this worker: not taken out, and at work, taken in, or (as the last look found)
 * with changes the stack has not; and not left out by the last look. */
export function included(c: Candidate, record: Choices): boolean {
  if (record.left.some((l) => l.id === c.id)) return false;

  return always(c, record) || (!takenOut(c, record) && record.merged.some((m) => m.id === c.id));
}

/** Why the merge leaves a worker out, in a few words: `its own @ is conflicted in "a.txt"`, `its edits
 * conflict with a1's in "a.txt"`, `its edits conflict with the stack in "a.txt"`. Each path is quoted and
 * cut short (`quoted`), and at most five are named: a file's name is a worker's text, and this sentence
 * goes into the hub's line. */
export function leftWhy(l: LeftOut): string {
  const files = l.conflicts.length === 0 ? "" : ` in ${listed(l.conflicts.map((c) => quoted(c.path)))}`;

  if (l.own) return `its own @ is conflicted${files}`;
  const others = [...new Set(l.conflicts.flatMap((c) => c.workers))];

  return `its edits conflict with ${others.length === 0 ? "the stack" : and(others.map((w) => `${w}'s`))}${files}`;
}

/** `a`, `a and b`, `a, b and c`. */
function and(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** Each left-out worker as a sentence, for `start` and the page. */
export function leftLines(record: { readonly left: readonly LeftOut[] }): string[] {
  return record.left.map((l) => `${l.id} is left out of the merge: ${leftWhy(l)}`);
}

/** What the updater has to say of the last look, for the page: why it failed, and whom it left out. */
export function said(record: { readonly error: string | null; readonly left: readonly LeftOut[] }): string | null {
  const all = [...(record.error === null ? [] : [record.error]), ...leftLines(record)];

  return all.length === 0 ? null : all.join("; ");
}

/** Why a worker is in the merge or out of it, for `status`: taken out, added out of the preview, left out
 * with the conflict, taken in, its status when at work, else its status and whether its changes are merged,
 * already in the stack, or gone with its workspace. */
export function standing(c: Candidate, record: Choices): string {
  const status = c.status ?? "no row";

  if (record.exclude.includes(c.id)) return "taken out";

  if (takenOut(c, record)) return "added out of the preview";
  const left = record.left.find((l) => l.id === c.id);

  if (left !== undefined) return `left out: ${leftWhy(left)}`;

  if (record.include.includes(c.id)) return "taken in";

  if (always(c, record)) return status;

  if (record.merged.some((m) => m.id === c.id)) return `${status}, merged`;

  return isDir(c.path) ? `${status}, already in the stack` : `${status}, its workspace is gone`;
}

/** The revset the ledger's `preview.stack` names (`fleet preview DIR set --stack`), or null for the default rule. */
export function ledgerStack(raw: JsonObject | undefined): string | null {
  const revset = asString(asObject(raw?.["preview"])?.["stack"]);

  return revset === undefined || revset.trim() === "" ? null : revset;
}

function sameMerge(a: PreviewRecord, b: PreviewRecord): boolean {
  return (
    a.commit === b.commit &&
    a.stack === b.stack &&
    a.stackFrom === b.stackFrom &&
    a.error === b.error &&
    JSON.stringify(a.merged) === JSON.stringify(b.merged) &&
    JSON.stringify(a.left) === JSON.stringify(b.left) &&
    JSON.stringify(a.conflicts) === JSON.stringify(b.conflicts)
  );
}

/** One look at the fleet in DIR: the merge brought up to date and, when anything changed, recorded. The
 * stack is `start --stack`'s revset, else the ledger's, else the default rule. A look that fails records
 * only why: the last good merge stands. A worker the look leaves out that the last one did not is told to
 * the fleet's host in its chat (`tell`). The record as it stands after; undefined when there is no preview. */
export function lookOnce(machine: Machine, root: string, memory: Memory): PreviewRecord | undefined {
  const record = readRecord(root);

  if (record === undefined) return undefined;
  const ledger = readLedger(root);
  const picked = candidates(ledger).flatMap((c) => (takenOut(c, record) ? [] : [{ ...c, untilIntegrated: !always(c, record) }]));
  const found = look(record.repo, record.workspace, record.path, picked, memory, record.stackGiven ?? ledgerStack(ledger), record);
  const news: LeftOut[] = [];

  const after = updateRecord(root, (now) => {
    if (now === undefined) return undefined;

    const next: PreviewRecord = found.failed
      ? { ...now, error: found.error }
      : { ...now, merged: found.merged, left: found.left, stack: found.stack, stackFrom: found.stackFrom, commit: found.commit, conflicts: found.conflicts, error: found.error };

    if (sameMerge(now, next)) return undefined;
    news.push(...next.left.filter((l) => !now.left.some((was) => was.id === l.id)));

    return { ...next, updated: stampOf(machine.now()) };
  });

  for (const l of news) tell(machine, root, l);

  return after;
}

/** The line the fleet's host gets in its chat when the merge leaves a worker out. */
export function leftNotice(root: string, l: LeftOut): string {
  return (
    `[hub] The preview left ${l.id} out of its merge: ${leftWhy(l)}. It keeps serving the merge without ${l.id}, and takes it back in once it merges clean ` +
    `(\`fleet preview ${root} status\`; \`fleet preview ${root} exclude ${l.id}\` keeps it out).`
  );
}

/** How long, in minutes, the chat is not told again what it already holds: a worker that goes out of the
 * merge and back in at every save would otherwise wake the host at each. */
export const TOLD_AGAIN_MIN = 10;

/** A notice the chat already holds, said less than `TOLD_AGAIN_MIN` minutes ago: not written again. */
class SaidLately extends Error {}

/** Append the notice to the fleet's chat, from the hub's name to the fleet's host, unless the chat holds
 * the same line (the same worker, for the same reason) from the last `TOLD_AGAIN_MIN` minutes. A chat
 * that does not take it stops nothing: the record, `status` and the page say the same. */
function tell(machine: Machine, root: string, l: LeftOut): void {
  const text = leftNotice(root, l);
  const now = machine.now();
  const since = now.getTime() - TOLD_AGAIN_MIN * 60_000;

  try {
    const stored = appendLocked(root, (known, nextId) => {
      const lately = known.some((m) => m.from === HUB_NAME && m.text === text && (parseInstant(asString(m.at) ?? "") ?? 0) > since);

      return lately ? new SaidLately() : { id: nextId, at: stampOf(now), from: HUB_NAME, to: [hostOf(root)], text, re: null, parts: [{ text }] };
    });

    if (stored instanceof Error && !(stored instanceof SaidLately)) process.stderr.write(`preview: the chat did not take the line about ${l.id}: ${stored.message}\n`);
  } catch (cause: unknown) {
    process.stderr.write(`preview: the chat did not take the line about ${l.id}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  }
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
    // A worker taken out is no longer left out: the next look does not try it.
    const left = include ? now.left : now.left.filter((l) => l.id !== cand.id);

    return include ? { ...now, include: [...taken, cand.id], exclude } : { ...now, include: taken, exclude: [...exclude, cand.id], left };
  });

  return missing || next === undefined ? new PreviewError({ reason: `there is no preview: \`fleet preview ${root} start\` makes one` }) : next;
}

/** Forget that `worker` was taken into the merge by hand (`include`): its workspace is gone (`fleet ws DIR
 * prune`), or added anew out of the preview (`fleet ws DIR add … --no-preview`), and a choice made for the
 * workspace that was there says nothing of the next one. */
export function forgetIncluded(root: string, worker: string): void {
  if (!hasRecord(root)) return;
  updateRecord(root, (now) => (now === undefined || !now.include.includes(worker) ? undefined : { ...now, include: now.include.filter((w) => w !== worker) }));
}

export { freshMemory };
