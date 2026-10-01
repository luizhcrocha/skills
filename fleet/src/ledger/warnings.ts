/**
 * What a ledger command says on stderr beside its work: live rows in a still fleet, a stale Now line, a
 * Now line naming a closed decision (in this ledger, or on a manager's in a fleet's), a worker recorded
 * done whose report reads as unfinished, an answer on the page not recorded, decisions left open when the
 * fleet is done, lanes that overlap, and a done worker's workspace not pruned. The chat's warning is the
 * chat's ({@link ../chat/chat.ts}).
 */
import { join } from "node:path";

import type { Message } from "../chat/store.ts";
import { parseInstant } from "../clock.ts";
import { Refusal } from "../errors.ts";
import { answeredAt } from "../health.ts";
import { asArray, asObject, asString, type JsonObject } from "../json.ts";
import { readObject } from "../registry.ts";
import { secondsNow, type Machine } from "../world.ts";
import { copyLedger, decodeLedger, type Ledger } from "./model.ts";
import { lanesMeet } from "./lanes.ts";
import { findDecision, number } from "./numbers.ts";

/** The statuses of a worker row that is still at work. */
export const LIVE = ["running", "queued", "blocked"] as const;

/** A Now line not said again for this long is pointed out. */
export const NOW_STALE_S = 30 * 60;

/** Words a report uses when the work did not finish. */
export const UNFINISHED =
  /\b(refused|parked|not met|unmet|could(?:n't| not)|failed to|gave up|incomplete|unfinished|blocked on|waiting on|skipped|not done)\b/i;

/** Whether a worker status is live. */
export function isLive(status: string): boolean {
  return LIVE.some((live) => live === status);
}

/** The warning about worker rows still live while the fleet is paused or done. */
export function staleRows(ledger: Ledger): string | undefined {
  if (ledger.status !== "paused" && ledger.status !== "done") return undefined;
  const rows = ledger.agents.filter((a) => isLive(a.status)).map((a) => a.id);

  if (rows.length === 0) return undefined;

  return (
    `state: ${rows.join(", ")} still read as ${LIVE.join("/")} while the fleet is ${ledger.status}; ` +
    `if they are not working, \`fleet state <dir> park "why"\` stops their rows in one command.`
  );
}

/** The warning about a Now line not said again for {@link NOW_STALE_S}. */
export function staleNow(machine: Machine, ledger: Ledger): string | undefined {
  const said = ledger.now_at;
  const at = said === undefined || said === null || said === "" ? undefined : parseInstant(said);
  const age = at === undefined ? undefined : secondsNow(machine) - at / 1000;

  if (age !== undefined && age < NOW_STALE_S) return undefined;
  const when = age === undefined ? "never stamped" : `said ${Math.floor(age / 60)} min ago`;
  const now = [...ledger.now].slice(0, 160).join("");

  return (
    `state: the page's Now line (${when}) reads: "${now}". If it is no longer what is ` +
    `happening, say it again: \`fleet state <dir> set --now "..."\` (the same words also restamp it).`
  );
}

const REF = /\b([DAISGLR]\d+)\b/g;

/** The decisions a Now line names by number that are already closed: in this ledger ("A6"), and on a
 * manager's, in a fleet's ("infra I2", "infra-coordinator I2"). */
export function closedNamed(machine: Machine, ledger: Ledger, text: string): string[] {
  const own = copyLedger(ledger);
  number(own);
  const ledgers = new Map<string, Ledger | undefined>([["", own]]);

  if (ledger.role === "manager") {
    for (const e of machine.registry.live()) {
      if (e.role === "manager") continue;
      const raw = readObject(join(e.dir, "state.json"));
      const theirs = raw === undefined ? undefined : decodeLedger(raw);

      if (theirs === undefined || theirs instanceof Refusal) {
        ledgers.set(e.id, undefined);
        continue;
      }

      number(theirs);
      ledgers.set(e.id, theirs);
    }
  }

  const found: string[] = [];

  for (const m of text.matchAll(REF)) {
    const ref = m[1] ?? "";
    const before = text.slice(0, m.index).split(/\s+/).filter((w) => w !== "");
    const word = (before.at(-1) ?? "").toLowerCase().replace(/^[,:;(]+|[,:;(]+$/g, "");
    const fleet = [...ledgers.keys()].find((f) => f !== "" && (word === f || word === f.split("-")[0])) ?? "";
    const target = ledgers.get(fleet);
    const d = target === undefined ? undefined : findDecision(target, ref);

    if (d !== undefined && d.status !== "open") found.push(`${fleet === "" ? "" : `${fleet} `}${ref} (${d.title ?? "None"}) is ${d.status}`);
  }

  return found;
}

/** For each answer the user gave on the page that the ledger has not recorded: the page shows it as sent
 * and the fleet has not acted on it, so it is recorded before any other work. */
export function unrecorded(ledger: Ledger, said: readonly Message[]): string[] {
  const numbered = copyLedger(ledger);
  number(numbered);
  const lines: string[] = [];

  for (const d of numbered.decisions ?? []) {
    if (d.status !== "open") continue;
    const at = answeredAt({ id: d.id, opened: d.opened, revised: d.revised ?? null }, said);

    if (at === undefined) continue;
    const m = [...said].reverse().find((x) => x.decision === d.id && x.from === "user" && x.at === at);
    const n = m?.id ?? "?";
    lines.push(
      `state: the user answered ${d.ref ?? d.id} (${d.title ?? "None"}) as #${n} at ${at.slice(11, 16)}; record it before any other ` +
        `work: \`fleet state <dir> decision ${d.ref ?? d.id} --decide "..." --resolution "answered on the page (#${n})"\`, then answer #${n} with --re.`,
    );
  }

  return lines;
}

/** When the fleet is set done with decisions still open: each is withdrawn with its reason, or named in
 * the last message as left open on purpose. */
export function leftOpen(ledger: Ledger, settingDone: boolean): string | undefined {
  const still = settingDone ? (ledger.decisions ?? []).filter((d) => d.status === "open").map((d) => (d.ref !== undefined && d.ref !== "" ? d.ref : d.id)) : [];

  if (still.length === 0) return undefined;

  return (
    `state: the fleet is done with ${still.join(", ")} still open: withdraw each with its reason ` +
    `(\`decision ID --withdraw "why"\`), or name it in your last message as left open on purpose.`
  );
}

/** When worker `id`, recorded as running, shares files with another running or blocked worker's lane: two
 * workers on the same files collide at integration, so the task waits or joins that worker's queue. */
export function overlapping(ledger: Ledger, id: string): string | undefined {
  const a = ledger.agents.find((x) => x.id === id);

  if (a?.status !== "running") return undefined;
  const hits: string[] = [];

  for (const other of ledger.agents) {
    if (other === a || (other.status !== "running" && other.status !== "blocked")) continue;
    const shared = [...new Set((a.lane ?? []).filter((x) => (other.lane ?? []).some((y) => lanesMeet(x, y))))].sort();

    if (shared.length > 0) hits.push(`${other.id}'s (${other.status}: ${shared.join(", ")})`);
  }

  if (hits.length === 0) return undefined;

  return (
    `state: ${a.id}'s lane overlaps ${hits.join("; ")}. A task whose files overlap a running lane waits ` +
    "(`--status queued`) or joins that worker's queue."
  );
}

/** The worker models the policy approves; any other is the user's to approve, case by case (L3). */
export const POLICY_MODELS: readonly string[] = ["opus", "sonnet", "fable"];

/** When `agent` records worker `id` on a model outside the policy: accepted, and the user's to approve. */
export function offPolicy(id: string, model: string | undefined): string | undefined {
  if (model === undefined || model === "" || POLICY_MODELS.includes(model)) return undefined;

  return `state: ${id} is recorded on ${model}, outside the model policy (${POLICY_MODELS.join(", ")}): spawning it on ${model} needs the user's OK.`;
}

/** A workspace `fleet ws add` recorded and `prune` has not removed. */
export interface ActiveWorkspace {
  readonly id: string;
  readonly agent: string;
  readonly path: string;
}

/** The workspaces of a ledger that are still active, from its raw JSON (`workspaces` is `fleet ws`'s key). */
export function activeWorkspaces(raw: JsonObject | undefined): ActiveWorkspace[] {
  return (asArray(raw?.["workspaces"]) ?? []).flatMap((item) => {
    const row = asObject(item);
    const id = asString(row?.["id"]);

    return row === undefined || id === undefined || row["status"] === "pruned" ? [] : [{ id, agent: asString(row["agent"]) ?? id, path: asString(row["path"]) ?? "" }];
  });
}

/** When a worker is done and its workspace is still there, or the fleet is set done with workspaces left:
 * a done worker's changes are integrated into the stack and its workspace pruned. */
export function unpruned(ledger: Ledger, workspaces: readonly ActiveWorkspace[], settingDone: boolean): string[] {
  const done = workspaces.filter((w) => ledger.agents.some((a) => a.id === w.agent && a.status === "done"));
  const lines: string[] = [];

  if (done.length > 0) {
    lines.push(
      `state: ${done.map((w) => `${w.agent}'s workspace ${w.id}`).join(", ")} still there though its worker is done: ` +
        "bring its changes into the stack, then `fleet ws <dir> prune` (a dry run, then --apply).",
    );
  }

  if (settingDone && workspaces.length > 0) {
    lines.push(
      `state: the fleet is done with workspace(s) ${workspaces.map((w) => w.id).join(", ")} not pruned: ` +
        "`fleet ws <dir> list` says what each holds; integrate it or keep it with its reason, then `fleet ws <dir> prune`.",
    );
  }

  return lines;
}
