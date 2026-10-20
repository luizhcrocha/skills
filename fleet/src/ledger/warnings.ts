/**
 * What a ledger command says on stderr beside its work: live rows in a still fleet, a stale Now line, a
 * Now line naming a closed decision (in this ledger, or on a manager's in a fleet's), a worker recorded
 * done whose report reads as unfinished, an answer on the page not recorded, decisions left open when the
 * fleet is done, lanes that overlap, and a done worker's workspace not pruned. The chat's warning is the
 * chat's ({@link ../chat/chat.ts}).
 */
import { join } from "node:path";

import type { Message } from "../chat/store.ts";
import { atOrAfter, parseInstant } from "../clock.ts";
import { Refusal } from "../errors.ts";
import { answeredAt, answeredGrill, closeProgram, decisionRow, explainCommand, failedAnswer, failureWords, onCardProgram, unexplained } from "../health.ts";
import { asArray, asNumber, asObject, asString, type JsonObject } from "../json.ts";
import { readObject } from "../registry.ts";
import { callsLine, refusalRev } from "./permission.ts";
import { showHidden } from "./permission-words.ts";
import { secondsNow, type Machine } from "../world.ts";
import { copyLedger, decodeLedger, type Ledger, type RefusalDraft } from "./model.ts";
import { DRAFT_REMIND_S, openDrafts } from "./refusal-draft.ts";
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
 * and the fleet has not acted on it, so it is recorded before any other work. A grilling with every
 * question answered is said so until it is decided or withdrawn, whatever the chat said after the last
 * answer (a reply to it, a recap, amendments). A permission not explained is asked for, unless the team has
 * `moved` to the cloud, where no program can explain it (health's `unexplained`). On a moved team no program records
 * an answer (the fleet's owner-answer gate): a grilling answered in full is told as one to close (health's
 * `closeProgram`), and a line from the user that left its card open as one to answer on the card (`onCardProgram`). */
export function unrecorded(ledger: Ledger, said: readonly Message[], moved: boolean): string[] {
  const numbered = copyLedger(ledger);
  number(numbered);
  const lines: string[] = [];

  for (const d of numbered.decisions ?? []) {
    if (d.status !== "open") continue;

    if (answeredGrill(d)) {
      lines.push(
        `state: every question of ${d.ref ?? d.id} (${d.title ?? "None"}) is answered and the grilling is still open; ` +
          (moved
            ? `close it before any other work with ${closeProgram("<dir>", d.id, "grilling finished")}.`
            : `record it before any other work: \`fleet state <dir> decision ${d.ref ?? d.id} --decide "..." --resolution "grilling finished"\`, or --withdraw "why".`),
      );
      continue;
    }

    const failed = failedAnswer(d, said);

    if (failed !== undefined) {
      const ref = d.ref ?? d.id;
      const heldSince = d.held !== undefined && d.held !== null && d.held !== "" && d.held_at !== undefined && d.held_at !== null && atOrAfter(d.held_at, String(failed.at));

      // Held since it failed: the fleet says it works on the fix.
      if (!heldSince) {
        lines.push(
          `state: the user ran ${ref} (${d.title ?? "None"}) and it failed, #${failed.id} at ${String(failed.at).slice(11, 16)}: ${failureWords(failed)}. ` +
            `It is not done: fix what failed and re-present it (\`fleet state <dir> decision ${ref} --manual "..." --log "what changed"\`), ` +
            `or \`--withdraw "why"\`; never --decide it. Answer #${failed.id} with --re.`,
        );
      }

      continue;
    }

    const at = answeredAt(decisionRow(d), said);

    if (at === undefined) {
      if (unexplained(d, moved)) {
        lines.push(
          `state: ${d.ref ?? d.id} (${d.title ?? "None"}) is a call auto mode refused, and the user cannot judge it yet. Its call is ` +
            `${showHidden(d.refusal === undefined || d.refusal === null ? "" : callsLine(d.refusal))} (revision ${refusalRev(d.refusal)}): explain it now, ` +
            `${explainCommand("fleet", "<dir>", d.ref ?? d.id, refusalRev(d.refusal))}.`,
        );
      }

      continue;
    }

    const m = [...said].reverse().find((x) => x.decision === d.id && x.from === "user" && x.at === at);
    const n = m?.id ?? "?";
    lines.push(
      moved
        ? `state: #${n} from the user on ${d.ref ?? d.id} (${d.title ?? "None"}) at ${at.slice(11, 16)} left it open: only the user's answer on ` +
            `the card records it. Answer #${n} before any other work with ${onCardProgram("<dir>", d.id, d.ref ?? d.id, m?.id ?? 0)}, ` +
            `or, for a None of these, revise or withdraw ${d.ref ?? d.id}.`
        : `state: the user answered ${d.ref ?? d.id} (${d.title ?? "None"}) as #${n} at ${at.slice(11, 16)}; ` +
            `record it before any other work: \`fleet state <dir> decision ${d.ref ?? d.id} --decide "..." --resolution "answer given on the page (#${n})"\`, then answer #${n} with --re.`,
    );
  }

  return lines;
}

/** The seconds a refusal draft may stay open before it is pointed out: FLEET_REFUSAL_REMIND_S, else {@link DRAFT_REMIND_S}. */
export function draftRemindS(env: (name: string) => string | undefined): number {
  const given = Number(env("FLEET_REFUSAL_REMIND_S"));

  return env("FLEET_REFUSAL_REMIND_S") === undefined || Number.isNaN(given) ? DRAFT_REMIND_S : given;
}

/** The refusal drafts of `ledger` the host has left open for {@link draftRemindS}, each with the minutes it waited. */
export function staleDrafts(machine: Machine, ledger: Ledger): { readonly draft: RefusalDraft; readonly minutes: number }[] {
  const now = secondsNow(machine);
  const after = draftRemindS(machine.env);

  return openDrafts(ledger).flatMap((draft) => {
    const at = parseInstant(draft.opened);
    const waited = at === undefined ? undefined : now - at / 1000;

    return waited === undefined || waited < after ? [] : [{ draft, minutes: Math.floor(waited / 60) }];
  });
}

/** The refusal drafts left open that long, in one line whatever their number: nothing reaches the user from one
 * by time alone, so every state command says how many wait, their ids and where to read them, until the host
 * asks each in its own words or drops it. `show` lists each with its call; the watch's reminder carries the
 * two commands. */
export function draftsLeft(machine: Machine, ledger: Ledger, dir: string): string | undefined {
  const stale = staleDrafts(machine, ledger);
  const [first] = stale;

  if (first === undefined) return undefined;
  const longest = Math.max(...stale.map((s) => s.minutes));
  const what = stale.length === 1 ? `refusal draft ${first.draft.id} has waited ${String(longest)} min` : `${String(stale.length)} refusal drafts (${stale.map((s) => s.draft.id).join(", ")}) have waited up to ${String(longest)} min`;

  return (
    `state: ${what}: nothing was asked of the user, and nothing will be until you ask. See ${stale.length === 1 ? "it" : "them"} with \`fleet state ${dir} show\`, ` +
    `then ask each in your words (\`decision ID --kind permission ...\`) or drop it (\`decision ID --withdraw "why"\`).`
  );
}

/** The open refusal drafts whose line reached neither the host's chat nor its session (`told: false`). */
export function untoldDrafts(ledger: Ledger): RefusalDraft[] {
  return openDrafts(ledger).filter((r) => r.told === false);
}

/** When the fleet is set done with decisions or refusal drafts still open: each decision is withdrawn with its
 * reason, each draft asked or dropped, or named in the last message as left open on purpose. */
export function leftOpen(ledger: Ledger, settingDone: boolean): string | undefined {
  const still = settingDone ? (ledger.decisions ?? []).filter((d) => d.status === "open").map((d) => (d.ref !== undefined && d.ref !== "" ? d.ref : d.id)) : [];
  const drafts = settingDone ? openDrafts(ledger).map((r) => `refusal draft ${r.id}`) : [];

  if (still.length === 0 && drafts.length === 0) return undefined;

  return (
    `state: the fleet is done with ${[...still, ...drafts].join(", ")} still open: withdraw each with its reason ` +
    `(\`decision ID --withdraw "why"\`), or name it in your last message as left open on purpose.`
  );
}

/** The live lanes worker `id`'s lane meets when it is running: per running or blocked worker, the entries of
 * `id`'s lane that meet one of its own (L7). */
function laneHits(ledger: Ledger, id: string): string[] {
  const a = ledger.agents.find((x) => x.id === id);

  if (a?.status !== "running") return [];
  const hits: string[] = [];

  for (const other of ledger.agents) {
    if (other === a || (other.status !== "running" && other.status !== "blocked")) continue;
    const shared = [...new Set((a.lane ?? []).filter((x) => (other.lane ?? []).some((y) => lanesMeet(x, y))))].sort();

    if (shared.length > 0) hits.push(`${other.id}'s (${other.status}: ${shared.join(", ")})`);
  }

  return hits;
}

/** Whether the fleet's workers share one working copy (`set --workspaces shared`). */
export function sharesWorkingCopy(ledger: Ledger): boolean {
  return ledger.workspace_mode === "shared";
}

/** When worker `id`, recorded as running, shares files with another running or blocked worker's lane: two
 * workers on the same files collide at integration, so the task waits or joins that worker's queue. A
 * shared fleet refuses it instead ({@link sharedOverlap}), so it never warns. */
export function overlapping(ledger: Ledger, id: string): string | undefined {
  const hits = sharesWorkingCopy(ledger) ? [] : laneHits(ledger, id);

  if (hits.length === 0) return undefined;

  return (
    `state: ${id}'s lane overlaps ${hits.join("; ")}. A task whose files overlap a running lane waits ` +
    "(`--status queued`) or joins that worker's queue."
  );
}

/** Why worker `id` cannot run in a shared fleet: its lane meets a running or blocked worker's, and in one
 * working copy the two would edit the same files under each other. Undefined when it can. */
export function sharedOverlap(ledger: Ledger, id: string): string | undefined {
  const hits = sharesWorkingCopy(ledger) ? laneHits(ledger, id) : [];

  if (hits.length === 0) return undefined;

  return (
    `${id}'s lane overlaps ${hits.join("; ")}, and this fleet's workers share one working copy (\`set --workspaces shared\`), ` +
    "where two workers on the same files overwrite each other: record it `--status queued` until that worker is done, " +
    "or give the task to that worker."
  );
}

/** A workspace `fleet ws add` recorded and `prune` has not removed. */
export interface ActiveWorkspace {
  readonly id: string;
  readonly agent: string;
  readonly path: string;
  /** The port its worker runs a dev server on (`fleet ws add` gives one), when it has one. */
  readonly port: number | undefined;
  /** The fleet's combined preview (`fleet preview`), never a worker's. */
  readonly preview: boolean;
}

/** The workspaces of a ledger that are still active, from its raw JSON (`workspaces` is `fleet ws`'s key). */
export function activeWorkspaces(raw: JsonObject | undefined): ActiveWorkspace[] {
  return (asArray(raw?.["workspaces"]) ?? []).flatMap((item) => {
    const row = asObject(item);
    const id = asString(row?.["id"]);

    return row === undefined || id === undefined || row["status"] === "pruned" ? [] : [{ id, agent: asString(row["agent"]) ?? id, path: asString(row["path"]) ?? "", port: asNumber(row["port"]), preview: row["kind"] === "preview" }];
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
        "bring its changes into the stack, then prune it (`fleet ws <dir> prune`, a dry run, then --apply), " +
        `or hand it to the next worker of its lane (\`fleet ws <dir> add <next> --reuse ${done.length === 1 ? (done[0]?.id ?? "") : "<workspace>"}\`).`,
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

/** More idle workspaces than this in one fleet are pointed out on every state command. */
export const IDLE_MAX = 4;

/** When the fleet holds more than {@link IDLE_MAX} idle workspaces: a worker's whose worker is no longer at
 * work (`prune`'s first rule: done, failed, stopped, or no row; one handed over is its new worker's). Each
 * still costs its disk and its setup, and nobody prunes them unless told. */
export function idleWorkspaces(ledger: Ledger, workspaces: readonly ActiveWorkspace[]): string | undefined {
  const idle = workspaces.filter((w) => {
    const status = ledger.agents.find((a) => a.id === w.agent)?.status;

    return !w.preview && (status === undefined || !isLive(status));
  });

  if (idle.length <= IDLE_MAX) return undefined;

  return (
    `state: ${String(idle.length)} idle workspaces (${idle.map((w) => w.id).join(", ")}), more than ${String(IDLE_MAX)}: their workers are no longer at work. ` +
    "`fleet ws <dir> prune --apply` removes each whose changes are in the stack and keeps the others, naming why; " +
    "the next worker of a lane reuses its workspace (`fleet ws <dir> add <next> --reuse <workspace>`) rather than making one."
  );
}
