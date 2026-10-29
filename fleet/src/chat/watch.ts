/**
 * The chat's long-running commands: `watch` (what is open for WHO, then each new message as it lands,
 * with a manager's or coordinator's `!` lines) and `wait` (the user's answer to one of these decisions).
 * They poll the store every 0.3 s; a pinned clock (FLEET_NOW) dates what they measure, not their pace.
 */
import { closeSync, openSync, utimesSync } from "node:fs";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { ADVISOR } from "../advisor/advisor.ts";
import { parseInstant } from "../clock.ts";
import { ChatError } from "../errors.ts";
import { isMoved, readText, remove, resolvePath, writeText } from "../files.ts";
import { answeredAt, answeredGrill, answerRecorded, closeProgram, decisionRow, explainCommand, FAILED, failedProgram, onCardProgram, owed, silentWorkers, stepProgram, unexplained } from "../health.ts";
import { Out } from "../io.ts";
import { asArray, asNumber, asObject, asString, dumps, parseObject, pyRepr, type Json, type JsonObject } from "../json.ts";
import { decodeLedger, type Decision, type Ledger } from "../ledger/model.ts";
import { refusalRev } from "../ledger/permission.ts";
import { draftLine, draftReminder } from "../ledger/refusal-draft.ts";
import { lanesMeet } from "../ledger/lanes.ts";
import { staleDrafts, untoldDrafts } from "../ledger/warnings.ts";
import { stripHidden } from "../ledger/permission-words.ts";
import { findDecision, number } from "../ledger/numbers.ts";
import { Refusal } from "../errors.ts";
import { readObject } from "../registry.ts";
import { activeAt } from "../transcripts.ts";
import { secondsNow, type Machine } from "../world.ts";
import {
  cursorPath,
  handedOver,
  hostOf,
  intOf,
  leftPath,
  listening,
  oneLine,
  openAmong,
  openFromUser,
  participant,
  pulsePath,
  pyText,
  renderLines,
  rosterOf,
  stateOfDir,
  waitsHere,
} from "./chat.ts";
import { BATCH_REMIND_S, batchReminders } from "./batches.ts";
import { FleetNews } from "./news.ts";
import { unreadLine } from "../news/news.ts";
import { isHost, liveHost, type Host } from "../host.ts";
import { displacedLine } from "../takeover.ts";
import { foreign, forgetOwner, isWatch, orphaned, ownerWords, readOwner, recordOwner, sessionAbove, type Owner } from "./watchers.ts";
import { readChat, Tail, type Message } from "./store.ts";
import * as Option from "effect/Option";

const POLL_MS = 300;

/** A `--once` watch's quiet time after a new line before it exits (FLEET_WATCH_SETTLE, `--settle`). */
export const SETTLE_S = 30;

/** The same after the user's message to WHO (FLEET_WATCH_SETTLE_USER): the user never waits long. */
export const SETTLE_USER_S = 10;

/** The longest a `--once` watch holds its first new line (FLEET_WATCH_SETTLE_MAX). */
export const SETTLE_MAX_S = 120;

/**
 * When a `--once` watch that printed new lines exits: once no line came for `settle` seconds, `user` seconds
 * after the user's last message to WHO (never longer than `settle`), and `cap` seconds after the first line
 * at most. Times are any monotonic seconds, so a test drives it with its own. Python's `chat.Settle`.
 */
export class Settle {
  private readonly settle: number;
  private readonly user: number;
  private readonly cap: number;
  private first: number | undefined;
  private last = 0;
  private userLast: number | undefined;

  constructor(settle: number, user: number, cap: number) {
    this.settle = settle;
    this.user = Math.min(user, settle);
    this.cap = cap;
  }

  /** A new line was printed at `now`; `user` when it is the user's message to WHO. */
  saw(now: number, user = false): void {
    this.first ??= now;
    this.last = now;

    if (user) this.userLast = now;
  }

  /** Whether the watch exits at `now`. */
  due(now: number): boolean {
    if (this.first === undefined) return false;
    let end = Math.min(this.first + this.cap, this.last + this.settle);

    if (this.userLast !== undefined) end = Math.min(end, this.userLast + this.user);

    return now >= end;
  }
}

/** The settle of a watch: `--settle`, else FLEET_WATCH_SETTLE, else {@link SETTLE_S}; the user's and the cap
 * from the environment. */
export function settleOf(env: (name: string) => string | undefined, given: number | undefined): Settle {
  return new Settle(given ?? seconds(env, "FLEET_WATCH_SETTLE", SETTLE_S), seconds(env, "FLEET_WATCH_SETTLE_USER", SETTLE_USER_S), seconds(env, "FLEET_WATCH_SETTLE_MAX", SETTLE_MAX_S));
}

/** What `watch` was asked. */
export interface WatchRequest {
  readonly who: string;
  readonly after: number;
  readonly all: boolean;
  readonly resume: boolean;
  readonly once: boolean;
  /** A manager's: also what the user does on every other fleet's page. */
  readonly fleets: boolean;
  /** With `fleets` and `once`: how long the first news of the other fleets waits for more. */
  readonly batch: number;
  /** With `once`: how long a new line waits for more before the watch exits (`--settle`); undefined for
   * FLEET_WATCH_SETTLE, else {@link SETTLE_S}. */
  readonly settle?: number | undefined;
  /** Whether stdout is a terminal: a watch without `once` runs only there. */
  readonly terminal: boolean;
  /** Whether stdout is /dev/null: what the watch prints wakes nobody there, so it does not run. */
  readonly devnull: boolean;
}

function seconds(env: (name: string) => string | undefined, name: string, fallback: number): number {
  const given = Number(env(name));

  return env(name) === undefined || Number.isNaN(given) ? fallback : given;
}

function readTold(path: string): Map<string, Json> {
  const told = new Map<string, Json>();
  const text = readText(path);
  const object = text === undefined ? undefined : Option.getOrUndefined(parseObject(text));

  for (const [key, value] of Object.entries(object ?? {})) told.set(key, value);

  return told;
}

function writeTold(path: string, told: ReadonlyMap<string, Json>): void {
  writeText(path, dumps(Object.fromEntries(told)));
}

function silentLines(machine: Machine, root: string, fleet: string | undefined, told: Map<string, Json>): string[] {
  const lines: string[] = [];

  for (const w of silentWorkers(machine, root, stateOfDir(root))) {
    const mark = `silent:${fleet ?? ""}:${w.id}:${w.active}`;

    if (told.has(mark) && told.get(mark) !== false) continue;
    told.set(mark, true);
    const where = fleet === undefined ? "worker" : `${fleet}'s worker`;
    lines.push(
      `! ${where} ${w.id} (${oneLine(w.name)}) has written nothing since ${w.active.slice(11, 16)} though the ledger says it runs. ` +
        (fleet === undefined ? `Ask it where it stands (SendMessage ${w.id}), or park it with the reason.` : `SendMessage ${fleet} to check it.`),
    );
  }

  return lines;
}

/** How long a worker may stay queued (on a rule, the gate slot, a landing turn) before the watch tells. */
const QUEUED_S = 30 * 60;

/** Whether a queued row waits behind a running or blocked worker's lane: the fleet's own ordering, no rule's. */
function behindLane(rows: readonly (JsonObject | undefined)[], a: JsonObject): boolean {
  const laneOf = (r: JsonObject): string[] => (asArray(r["lane"]) ?? []).flatMap((x) => asString(x) ?? []);
  const mine = laneOf(a);

  return rows.some(
    (o) =>
      o !== undefined &&
      o !== a &&
      (o["status"] === "running" || o["status"] === "blocked") &&
      laneOf(o).some((y) => mine.some((x) => lanesMeet(x, y))),
  );
}

/** The `!` line for each worker of `root` queued for over {@link QUEUED_S} since its row last changed (the row
 * keeps no time it was queued), as a silent one gets: the wait goes on the Now line with its cost, and the rule,
 * gate slot or turn behind it is offered to the user to drop or yield. A row queued behind a live lane and the
 * advisor, queued while it waits for questions, get none. Each wait told once. */
function queuedLines(machine: Machine, root: string, fleet: string | undefined, told: Map<string, Json>): string[] {
  const lines: string[] = [];
  const now = secondsNow(machine);
  const rows = (asArray(stateOfDir(root)["agents"]) ?? []).map(asObject);

  for (const a of rows) {
    const id = asString(a?.["id"]);
    const since = asString(a?.["updated"]) ?? asString(a?.["started"]);
    const at = since === undefined ? undefined : parseInstant(since);

    if (a === undefined || id === undefined || id === ADVISOR || a["status"] !== "queued" || since === undefined || at === undefined) continue;
    const waited = now - at / 1000;
    const mark = `queued:${fleet ?? ""}:${id}:${since}`;

    if (waited <= QUEUED_S || (told.has(mark) && told.get(mark) !== false) || behindLane(rows, a)) continue;
    told.set(mark, true);
    const name = asString(a["name"]) ?? id;
    const where = fleet === undefined ? "worker" : `${fleet}'s worker`;
    lines.push(
      `! ${where} ${id} (${oneLine(name === "" ? id : name)}) has waited queued since ${since.slice(11, 16)} (${String(Math.floor(waited / 60))} min). ` +
        (fleet === undefined
          ? "Put the wait on the Now line (what it waits on, which rule, gate or turn holds it, the time so far) and offer the user to drop the rule or yield as a decision."
          : `SendMessage ${fleet} to put it on its Now line.`),
    );
  }

  return lines;
}

function numberedDecisions(root: string): JsonObject[] {
  const raw = readObject(join(root, "state.json"));
  const ledger = raw === undefined ? undefined : decodeLedger(raw);

  if (ledger === undefined || ledger instanceof Refusal) {
    return (asArray(raw?.["decisions"]) ?? []).flatMap((d) => {
      const o = asObject(d);

      return o === undefined ? [] : [o];
    });
  }

  number(ledger);

  return (ledger.decisions ?? []).map((d) => ({ ...decisionRow(d), ref: d.ref ?? null, title: d.title }));
}

function unrecorded(machine: Machine, entry: { readonly id: string; readonly dir: string; readonly session: string | null }, told: Map<string, Json>, unheardS: number): string[] {
  const said = readChat(entry.dir);
  const lines: string[] = [];

  for (const d of numberedDecisions(entry.dir)) {
    if (d["status"] !== "open") continue;
    const at = answeredAt(d, said, isMoved(entry.dir));
    const mark = `answer:${pyText(d["id"])}:${at ?? "None"}`;

    if (at === undefined || (told.has(mark) && told.get(mark) !== false)) continue;
    const instant = parseInstant(at);

    if (instant === undefined) continue;

    if (secondsNow(machine) - instant / 1000 < unheardS) continue;
    told.set(mark, true);
    const m = [...said].reverse().find((x) => x.decision !== undefined && pyRepr(x.decision) === pyRepr(d["id"]) && pyText(x.at) === at);
    const ref = asString(d["ref"]) ?? pyText(d["id"]);
    const words = `"${[...oneLine(m?.text ?? "")].slice(0, 120).join("")}"`;
    const session = entry.session ?? entry.id;

    // A moved team's card is decided by the user's answer on the page as it is sent: a line that left it open
    // (words typed in the chat, a None of these, a Failed:) is one no program can record.
    lines.push(
      isMoved(entry.dir)
        ? `! ${entry.id} has not answered the user's #${m?.id ?? "?"} on ${ref} (${oneLine(d["title"])}), given at ${at.slice(11, 16)}, ` +
            `and ${ref} is still open: ${words}. SendMessage its session (${session}) to answer it with ` +
            `${onCardProgram("<dir>", pyText(d["id"]), ref, m?.id ?? 0)}, or, for a None of these or a Failed:, to revise or withdraw ${ref}.`
        : `! ${entry.id} has not recorded the user's answer to ${ref} (${oneLine(d["title"])}), ` +
            `given at ${at.slice(11, 16)} as #${m?.id ?? "?"}: ${words}. SendMessage its session ` +
            `(${session}) to record it: \`fleet state <dir> decision ${ref} --decide ...\`.`,
    );
  }

  return lines;
}

/** How long the user's message to a fleet's host may go without a reply (`--re`) before the manager is told. */
export const UNANSWERED_S = 10 * 60;

/** The `!` line for the user's messages to the host of fleet `entry` that it has not answered (no message but
 * the user's with that `re`, and no closed decision it answered) for `unansweredS`, read or not: a watch that
 * moved the cursor and woke no one leaves them unread nowhere. Each message told once. */
function unanswered(machine: Machine, entry: { readonly id: string; readonly dir: string; readonly session: string | null }, told: Map<string, Json>, unansweredS: number): string[] {
  const said = readChat(entry.dir);
  const replied = new Set(said.flatMap((m) => (m.from !== "user" && m.re !== null ? [pyRepr(m.re)] : [])));

  const late = openFromUser(entry.dir, said).filter((m) => {
    const at = parseInstant(pyText(m.at));
    const mark = `unanswered:${entry.id}:${m.id}`;

    return (
      !replied.has(String(m.id)) &&
      waitsHere(m) &&
      at !== undefined &&
      secondsNow(machine) - at / 1000 >= unansweredS &&
      !(told.has(mark) && told.get(mark) !== false)
    );
  });

  if (late.length === 0) return [];

  for (const m of late) told.set(`unanswered:${entry.id}:${m.id}`, true);
  const host = hostOf(entry.dir);
  const shown = late.map((m) => `#${m.id} at ${pyText(m.at).slice(11, 16)} "${[...oneLine(m.text)].slice(0, 120).join("")}"`).join(", ");

  return [
    `! ${entry.id} has not answered the user for more than ${Math.floor(unansweredS / 60)} min: ${shown}. SendMessage its session ` +
      `(${entry.session ?? entry.id}) to answer it with \`fleet chat ${entry.dir} say --as ${host} --re N ...\`, and to arm its watch as a background command, ` +
      `\`fleet chat ${entry.dir} watch --as ${host} --all --resume --once\`; \`fleet chat ${entry.dir} log --after ${(late[0]?.id ?? 1) - 1}\` shows them.`,
  ];
}

/** For a manager's watch: the fleets that do not read their chat while the user waits, or leave the user's
 * messages unanswered, the answers they have not recorded, their silent workers and those queued past half an
 * hour; each told once (kept in the manager's DIR); and the manager's own batches of marks still open, once per FLEET_BATCH_REMIND_S. */
export function fleetsUnheard(machine: Machine, me: string): string[] {
  const toldPath = join(me, "watch-manager.told");
  const told = readTold(toldPath);
  const unheardS = seconds(machine.env, "FLEET_UNHEARD_S", 120);
  const unansweredS = seconds(machine.env, "FLEET_UNANSWERED_S", UNANSWERED_S);
  const lines: string[] = [];

  for (const e of machine.registry.live()) {
    if (e.role === "manager" || e.dir === me) continue;
    lines.push(...unrecorded(machine, e, told, unheardS));
    lines.push(...silentLines(machine, e.dir, e.id, told));
    lines.push(...queuedLines(machine, e.dir, e.id, told));
    const heard = listening(machine, e.dir);
    const since = heard.since === null ? "None" : pyText(heard.since);
    const mark = `${heard.seen}:${heard.unread}:${since}`;
    const at = heard.since === null ? undefined : parseInstant(pyText(heard.since));
    const waited = at === undefined ? unheardS : secondsNow(machine) - at / 1000;

    if (heard.on || heard.unread === 0 || told.get(e.id) === mark || waited < unheardS) {
      lines.push(...unanswered(machine, e, told, unansweredS));
      continue;
    }

    told.set(e.id, mark);
    const active = activeAt(e.dir, machine.config, asString(e.raw["session_id"]));
    const activeAtS = active === undefined ? undefined : parseInstant(active);

    const gone =
      active !== undefined && activeAtS !== undefined && secondsNow(machine) - activeAtS / 1000 > 1800
        ? ` Its session last wrote at ${active.slice(0, 16).replace("T", " ")}; it may be gone.`
        : "";

    lines.push(
      `! ${e.id} does not read its chat: ${heard.unread} message(s) from the user since ` +
        `#${heard.seen}, the oldest at ${since.slice(11, 16)}. SendMessage its session ` +
        `(${e.session ?? e.id}) to arm its watch as a background command, \`fleet chat ${e.dir} watch --as coordinator --all --resume --once\`; \`fleet chat ${e.dir} log --after ${heard.seen}\` shows them.${gone}`,
    );
  }

  // The manager's own refusal drafts: a call of its session, or of a worker of its own.
  lines.push(...draftReminders(machine, me, told));
  lines.push(...batchReminders(machine, me, told, seconds(machine.env, "FLEET_BATCH_REMIND_S", BATCH_REMIND_S)));

  if (lines.length > 0) writeTold(toldPath, told);

  return lines;
}

/** A message to a worker that it has not answered for this long is forwarded by the coordinator (L1). */
export const NUDGE_S = 10 * 60;

/** The `!` lines for messages to the workers of `root` that the addressee has not answered (no `--re`
 * from it) for `nudgeS`: workers read their inbox at checkpoints, and only a message left this long is
 * forwarded by SendMessage. Each told once. */
function nudgeLines(machine: Machine, root: string, told: Map<string, Json>, nudgeS: number): string[] {
  const messages = readChat(root);
  const lines: string[] = [];

  for (const w of rosterOf(machine, root).members) {
    for (const m of openAmong(messages, w.id)) {
      const mark = `nudge:${m.id}:${w.id}`;
      const at = parseInstant(pyText(m.at));

      if (m.from === w.id || at === undefined || (told.has(mark) && told.get(mark) !== false)) continue;
      const waited = secondsNow(machine) - at / 1000;

      if (waited < nudgeS) continue;
      told.set(mark, true);
      const who = w.name === w.id ? w.id : `${w.id} (${oneLine(w.name)})`;
      lines.push(
        `! worker ${who} has not answered #${m.id} from ${oneLine(m.from)} for ${Math.floor(waited / 60)} min: ` +
          `"${[...oneLine(m.text)].slice(0, 120).join("")}". Forward it (SendMessage ${w.id}).`,
      );
    }
  }

  return lines;
}

/** The `!` lines for the grillings of `root` with every question answered and still open, whatever the
 * chat said since: the fleet records each before other work. Each told once per round (its last change),
 * so a watch armed again is not woken by it at once; `fleet state` says it at every command until then. A moved
 * team is told the program that closes it (health's `closeProgram`). */
function answeredGrillings(root: string, told: Map<string, Json>): string[] {
  const lines: string[] = [];
  const moved = isMoved(root);

  for (const d of numberedLedger(root)?.decisions ?? []) {
    const mark = `grill:${d.id}:${d.revised !== undefined && d.revised !== null && d.revised !== "" ? d.revised : d.opened}`;

    if (!answeredGrill(d) || (told.has(mark) && told.get(mark) !== false)) continue;
    told.set(mark, true);
    const ref = d.ref !== undefined && d.ref !== "" ? d.ref : d.id;
    lines.push(
      `! ${ref} (${oneLine(d.title)}): every question is answered and the grilling is still open. ` +
        (moved
          ? `Close it now with ${closeProgram("<dir>", d.id, "grilling finished")}.`
          : `Record it now: \`fleet state <dir> decision ${ref} --decide "..." --resolution "grilling finished"\`, or withdraw it with its reason.`),
    );
  }

  return lines;
}

/** The `!` lines for the steps of `root` their worker left: current under a done worker (the cloud refuses that done
 * now, but a ledger from before keeps it, and an unmoved team's CLI does not refuse it), or current or pending under a
 * stopped or failed one. Each told once per change of its worker, as a grilling answered is. */
export function strandedSteps(root: string, told: Map<string, Json>): string[] {
  const ledger = numberedLedger(root);
  const lines: string[] = [];
  const moved = isMoved(root);
  const workers = new Map((ledger?.agents ?? []).map((a) => [a.id, a]));

  for (const m of ledger?.roadmap ?? []) {
    for (const s of m.steps) {
      const w = s.agent === undefined || s.agent === null ? undefined : workers.get(s.agent);

      if (w === undefined) continue;
      const done = w.status === "done" && s.status === "current";
      const left = (w.status === "stopped" || w.status === "failed") && (s.status === "current" || s.status === "pending");
      const mark = `stranded:${m.id}/${s.id}:${w.updated ?? w.started ?? ""}`;

      if ((!done && !left) || (told.has(mark) && told.get(mark) !== false)) continue;
      told.set(mark, true);
      const head = `! ${oneLine(m.id)}/${oneLine(s.id)} (${oneLine(s.title)}): its worker ${oneLine(w.id)}`;

      if (done) {
        const close = moved
          ? stepProgram("<dir>", m.id, s.id, s.title, [["done", w.id]])
          : `\`fleet state <dir> step ${s.id} --milestone ${m.id} --status done\``;

        lines.push(`${head} is done and the step is still current. Close it now with ${close}, or hand it to another worker.`);
      } else {
        const ways = moved
          ? stepProgram("<dir>", m.id, s.id, s.title, [["current", "<new worker>"], ["dropped", w.id]])
          : `\`fleet state <dir> step ${s.id} --milestone ${m.id} --status current --agent <new worker>\`, or \`fleet state <dir> step ${s.id} --milestone ${m.id} --remove "<why>"\``;

        lines.push(`${head} ${w.status} and the step is still ${s.status}. Retake it with a fresh worker, or drop it and its changes: ${ways}.`);
      }
    }
  }

  return lines;
}

/** The `!` lines for the permissions of `root` the coordinator has not explained and the user has not
 * answered: the hook opened each from a refused spawn (before refusal drafts, from any refused call), and the
 * page shows it as waiting for the explanation. A moved team has none (health's `unexplained`).
 * Told once per round (its last change), as a grilling answered is. */
function unexplainedPermissions(root: string, told: Map<string, Json>): string[] {
  const lines: string[] = [];
  const said = readChat(root);
  const moved = isMoved(root);

  for (const d of numberedLedger(root)?.decisions ?? []) {
    const mark = `explain:${d.id}:${d.revised !== undefined && d.revised !== null && d.revised !== "" ? d.revised : d.opened}`;

    if (!unexplained(d, moved) || answeredAt(decisionRow(d), said) !== undefined || (told.has(mark) && told.get(mark) !== false)) continue;
    told.set(mark, true);
    const ref = d.ref !== undefined && d.ref !== "" ? d.ref : d.id;
    lines.push(
      `! ${ref} (${oneLine(d.title)}): auto mode refused a worker's call, and the page waits for your explanation. ` +
        `Explain it now: ${explainCommand("fleet", root, ref, refusalRev(d.refusal))}.`,
    );
  }

  return lines;
}

/** The `!` line for each refusal draft of `root` its host has neither asked nor dropped for FLEET_REFUSAL_REMIND_S
 * (fifteen minutes): the hook told the host when it opened, and nothing reaches the user from it by time alone.
 * Each draft is told once. Before that, a draft whose line reached the host nowhere when it opened (`told:
 * false`) is said in full, at once and once. */
export function draftReminders(machine: Machine, root: string, told: Map<string, Json>): string[] {
  const ledger = numberedLedger(root);
  const lines: string[] = [];

  if (ledger === undefined) return lines;

  for (const draft of untoldDrafts(ledger)) {
    const mark = `refusal-line:${draft.id}:${draft.opened}`;

    if (told.has(mark) && told.get(mark) !== false) continue;
    told.set(mark, true);
    lines.push(`! the hub could not tell you this when it happened. ${draftLine("fleet", root, ledger, draft)}`);
  }

  for (const { draft, minutes } of staleDrafts(machine, ledger)) {
    const mark = `refusal:${draft.id}:${draft.opened}`;

    if (told.has(mark) && told.get(mark) !== false) continue;
    told.set(mark, true);
    lines.push(`! ${draftReminder("fleet", root, ledger, draft, minutes)}`);
  }

  return lines;
}

/** For a coordinator's watch: its own silent workers and those queued past half an hour, the messages its
 * workers left unanswered for FLEET_NUDGE_S (ten minutes), its grillings answered and not recorded, the steps its workers left, its permissions not explained, its
 * refusal drafts left open for fifteen minutes, each told once across watches, and its batches of marks still
 * open, once per FLEET_BATCH_REMIND_S. */
export function ownSilent(machine: Machine, root: string): string[] {
  const toldPath = join(root, "watch-coordinator.told");
  const told = readTold(toldPath);

  const lines = [
    ...silentLines(machine, root, undefined, told),
    ...queuedLines(machine, root, undefined, told),
    ...nudgeLines(machine, root, told, seconds(machine.env, "FLEET_NUDGE_S", NUDGE_S)),
    ...answeredGrillings(root, told),
    ...strandedSteps(root, told),
    ...unexplainedPermissions(root, told),
    ...draftReminders(machine, root, told),
    ...batchReminders(machine, root, told, seconds(machine.env, "FLEET_BATCH_REMIND_S", BATCH_REMIND_S)),
  ];

  if (lines.length > 0) writeTold(toldPath, told);

  return lines;
}

function touch(path: string, at: number): void {
  try {
    closeSync(openSync(path, "a"));
    utimesSync(path, at, at);
  } catch {
    // the watch ends either way
  }
}

/** `watch`: what is open for WHO (with `--all`, every open message from the user too) with id > N, then
 * each new message to WHO as it lands. A `--once` watch holds its pid in DIR/watch-WHO.pid from its first
 * read of the chat on (a line sent once the file is there is a new line, not one that waited), and on
 * exiting moves the cursor to the last message it printed: what it handed to the session it wakes is what
 * was read. Without `--once` it never exits, so it runs only on a terminal and marks nothing read. */
export function watch(machine: Machine, root: string, request: WatchRequest): Effect.Effect<void, ChatError, Out> {
  return Effect.gen(function* () {
    const roster = rosterOf(machine, root);
    const who = participant(roster, request.who, false);

    if (who instanceof ChatError) return yield* Effect.fail(who);

    if (request.fleets && who !== "manager") {
      return yield* Effect.fail(new ChatError({ reason: "--fleets is the manager's: only a watch `--as manager` follows the other fleets' pages" }));
    }

    if (request.devnull) {
      return yield* Effect.fail(
        new ChatError({
          reason:
            `a watch whose output goes to /dev/null wakes nobody, yet it would mark what it reads as read. ` +
            `Run \`fleet chat ${root} watch --as ${who} --all --resume --once${request.fleets ? " --fleets" : ""}\` as a background command of the session ` +
            `(run_in_background: true), never with \`& disown\` or its output redirected to /dev/null.`,
        }),
      );
    }

    if (!request.once) {
      if (!request.terminal) {
        return yield* Effect.fail(
          new ChatError({
            reason:
              `a watch without --once needs a terminal: in a background command it never exits, so nothing wakes the session. ` +
              `Arm \`fleet chat ${root} watch --as ${who} --all --resume --once\` instead.`,
          }),
        );
      }

      yield* follow(machine, root, who, request, undefined, false);

      return;
    }

    // The host's watch is the host's alone: a copy of its session (a fork, a second resume) or a terminal that
    // armed one would be woken in its place and move its cursor, and the host would hear nothing.
    const host = who === hostOf(root) ? liveHost(machine.registry, root) : undefined;
    const copy = host === undefined ? undefined : notHost(root, who, host);

    if (copy !== undefined) return yield* Effect.fail(new ChatError({ reason: copy }));
    const pulse = pulsePath(root, who);
    const owner = readOwner(root, who);

    // The watch the pid file names, and the one the record names: a watch writes its record before its first
    // read and its pid file after it, so one still in that read is found by its record alone. A held watch
    // whose session is gone, or is not the fleet's host, hears for nobody the fleet knows: this one takes its
    // place, and that one, finding the pid file no longer its own, exits with nothing more printed and nothing
    // marked read.
    for (const held of new Set([intOf(readText(pulse)), owner?.watch])) {
      if (held !== undefined && held > 0 && held !== process.pid && isWatch(held, root, who) && !orphaned(held, owner) && !foreign(held, owner, host)) {
        return yield* Effect.fail(
          new ChatError({
            reason:
              `a watch as ${who} already runs for ${root} (pid ${held}), ${ownerWords(held, owner)}. ` +
              `Leave it running: there is nothing to stop and nothing to arm.`,
          }),
        );
      }
    }

    const pid = String(process.pid);
    const mine = recordOwner(root, who);
    let nobody = false;

    const end = (): void => {
      forgetOwner(root, who);

      if (readText(pulse) === pid) remove(pulse);

      // A watch that stood down handed nothing to anyone: it leaves no mark that the host was reading.
      if (!nobody) touch(leftPath(root, who), secondsNow(machine));
    };

    const onSignal = (): void => {
      end();
      process.exit(0);
    };

    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // A watch that another took the place of while it was in its first read (it was orphaned, or not the
        // host's) finds the record no longer its own: it stands down, and the pid file stays the other's.
        const armed = (): boolean => {
          if (readOwner(root, who)?.watch !== process.pid) return false;
          writeText(pulse, pid);

          return true;
        };

        const last = yield* follow(machine, root, who, request, mine, host !== undefined, armed);

        if (last === NOBODY) {
          nobody = true;

          return;
        }

        if (last !== undefined) writeText(cursorPath(root, who), String(last));

        // The news never wakes anyone: it rides on a wake the chat makes.
        const told = who === hostOf(root) ? unreadLine(machine, root) : undefined;

        if (told !== undefined) (yield* Out).out(`${told}\n`);
      }),
      Effect.sync(() => {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        end();
      }),
    );
  });
}

/**
 * Why this process may not arm a `--once` watch as the host of the fleet at `root`, whose host is `host`: it
 * runs under another Claude Code session, or under none. Undefined when it runs under the host.
 */
function notHost(root: string, who: string, host: Host): string | undefined {
  const me = sessionAbove(process.pid);

  if (me !== undefined && isHost(host, me.pid, me.started)) return undefined;
  const whose = `this fleet's host is the Claude Code session running as pid ${String(host.pid)} (the one \`fleet serve\` recorded), and a watch as ${who} wakes that session and marks its messages read`;

  return me === undefined
    ? `${whose}. This command runs outside it: to read along, \`fleet chat ${root} watch --as ${who}\` without --once marks nothing read.`
    : `${whose}. You are pid ${String(me.pid)}, a copy of it (a fork, or a second resume of its transcript): arm nothing, and leave its chat to it. ` +
        `If this session is to host the fleet from now on, \`fleet serve ${root} --take-over\` first, which is recorded in the fleet's ledger and chat and shown to the user on its page.`;
}

/** What {@link follow} gives back when the watch stood down because it hears for nobody: nothing it printed
 * is marked read, so the next watch prints it again. */
const NOBODY = "nobody";

/** How often a `--once` watch looks whether the session that armed it still runs, in seconds. */
const OWNER_CHECK_S = 3;

/** Whether another watch took the place of this `--once` one: the pid file names a pid that is not its own.
 * A pid file that is gone, or does not read, is not that: another watch's exit removes it, and this one goes on. */
function taken(root: string, who: string): boolean {
  const named = intOf(readText(pulsePath(root, who)));

  return named !== undefined && named > 0 && named !== process.pid;
}

/** What `watch` prints; the id of the last message it printed when it exits (`--once`), or {@link NOBODY}
 * when it stood down: another watch took its place, the session that armed it (`mine`) is gone, or (`hosted`:
 * a watch as the host's role, armed by the fleet's host) the fleet has another host now. Standing down is
 * silent but for that last case: the displaced host is told in one line (takeover.ts `displacedLine`).
 * `armed` runs once the first read of the chat is done; when it says no, the watch stands down. */
function follow(
  machine: Machine,
  root: string,
  who: string,
  request: WatchRequest,
  mine: Owner | undefined,
  hosted: boolean,
  armed?: () => boolean,
): Effect.Effect<number | typeof NOBODY | undefined, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    let last: number | undefined;

    const show = (messages: readonly Message[]): void => {
      for (const line of renderLines(machine, root, messages)) out.out(`${line}\n`);
      last = messages.at(-1)?.id ?? last;
    };

    let after = request.after;

    if (request.resume) after = Math.max(after, intOf(readText(cursorPath(root, who))) ?? after);
    const tail = new Tail(root);
    const messages = tail.read();

    if (armed?.() === false) return NOBODY;
    const wanted = new Set(openAmong(messages, who).map((m) => m.id));

    if (request.all) {
      for (const r of new Set([hostOf(root), ...rosterOf(machine, root).members.map((m) => m.id)])) {
        for (const m of openAmong(messages, r)) if (m.from === "user" && !handedOver(m).has(r)) wanted.add(m.id);
      }
    }

    const first = messages.filter((m) => m.id > after && wanted.has(m.id));
    show(first);
    const news = request.fleets ? new FleetNews(machine, resolvePath(root), request.resume) : undefined;

    const tell = (): boolean => {
      const told = news?.read() ?? [];

      for (const line of told) out.out(`${line}\n`);

      if (request.once) news?.save();

      return told.length > 0;
    };

    // The other fleets' news comes in batches: the first opens a window of --batch seconds, and the watch
    // tells all that lands in it before it exits, so one wake covers a burst of the user's actions.
    let window = tell() ? performance.now() / 1000 + request.batch : undefined;

    // What waited already is not held back.
    if (request.once && first.length > 0) return last;

    /** What this watch says when the fleet has another host now and it was the old host's (`hosted`): the
     * line of takeover.ts `displacedLine`. Undefined while the host is the session that armed it, or unknown. */
    const displaced = (): string | undefined => {
      if (!hosted || mine === undefined) return undefined;
      const entry = machine.registry.find(root);
      const host = liveHost(machine.registry, root);

      return host !== undefined && foreign(process.pid, mine, host) ? displacedLine(machine, root, host.pid, asString(entry?.raw["session_id"])) : undefined;
    };

    const checkS = seconds(machine.env, "FLEET_CHECK_S", 30);
    // A new line does not end the watch at once: it settles, so one wake carries a burst of lines.
    const settle = settleOf(machine.env, request.settle);
    let checked: number | undefined;
    let looked = performance.now() / 1000;

    for (;;) {
      const now = performance.now() / 1000;

      if (request.once && ((window !== undefined && now >= window) || settle.due(now))) return last;
      yield* Effect.sleep(POLL_MS);

      // Another watch took this one's place. When that is the new host's, after a takeover, this session is told.
      if (request.once && taken(root, who)) {
        const line = displaced();

        if (line !== undefined) out.out(`${line}\n`);

        return NOBODY;
      }

      // An orphan must not print the user's next message to nobody and mark it read: it looks for its session.
      if (mine !== undefined && mine.session !== null && performance.now() / 1000 - looked >= OWNER_CHECK_S) {
        looked = performance.now() / 1000;

        if (orphaned(process.pid, mine)) return NOBODY;

        // `fleet serve --take-over` moved the fleet to another session: this watch is the old host's. Its
        // session is told once, as the watch stands down, so the displaced host is not left waiting on a
        // watch that went without a word.
        const line = displaced();

        if (line !== undefined) {
          out.out(`${line}\n`);

          return NOBODY;
        }
      }

      const fresh = tail.read().filter((m) => m.to.includes(who) || (request.all && m.from === "user" && waitsHere(m)));
      show(fresh);

      if (tell() && window === undefined) window = performance.now() / 1000 + request.batch;
      let lines: string[] = [];
      const backlog = checked === undefined;

      if ((who === "manager" || who === "coordinator") && (checked === undefined || performance.now() / 1000 - checked >= checkS)) {
        checked = performance.now() / 1000;
        lines = who === "manager" ? fleetsUnheard(machine, resolvePath(root)) : ownSilent(machine, root);

        // A title or a name in a line may carry a bidi override or a control character: they never reach the session.
        for (const line of lines) out.out(`${stripHidden(line)}\n`);
      }

      // The first look's `!` lines were due before the watch began.
      if (request.once && backlog && lines.length > 0) return last;

      if (request.once && (fresh.length > 0 || lines.length > 0)) settle.saw(performance.now() / 1000, fresh.some((m) => m.from === "user" && m.to.includes(who)));
    }
  });
}

function numberedLedger(root: string): Ledger | undefined {
  const decoded = decodeLedger(stateOfDir(root));
  const ledger = decoded instanceof Refusal ? undefined : decoded;

  if (ledger !== undefined) number(ledger);

  return ledger;
}

/** The chat line of the user's answer that decided card `id` on the page (its `answer_line`, which the cloud writes and
 * this ledger's model does not know), or undefined when it has none. */
function answerLine(root: string, id: string): number | undefined {
  const row = (asArray(stateOfDir(root)["decisions"]) ?? []).map(asObject).find((r) => r?.["id"] === id);
  const line = asNumber(row?.["answer_line"]);

  return line !== undefined && Number.isInteger(line) ? line : undefined;
}

/** What `wait` says of a moved team's card `d` the user answered on the page with their line #`line`. */
function answeredOnCard(label: string, d: Decision, line: number): string {
  const answer = d.answer ?? "";

  return `-> the user answered ${label} on the card, which records it (${d.status}: ${answer !== "" ? answer : (d.resolution ?? "None")}): answer #${line} and act on it\n`;
}

/** What `wait` says of a decision already closed: on a moved team, one the user answered on the page (it has an
 * `answer_line`) is that answer, whether a chat line has come yet or not. */
function closedLine(root: string, d: Decision): string {
  const label = d.ref !== undefined && d.ref !== "" ? d.ref : d.id;
  const line = isMoved(root) ? answerLine(root, d.id) : undefined;
  const answer = d.answer ?? "";

  return line !== undefined ? answeredOnCard(label, d, line) : `${label} is already ${d.status}: ${answer !== "" ? answer : (d.resolution ?? "None")}\n`;
}

/** What `wait` says of the user's line `m` on a moved team's card `w`, read again as the line came: the card closed
 * meanwhile ({@link closedLine}); a grilling with no question left open, to close with grill.close; an action that
 * failed, to revise or withdraw; a line the card recorded (a grilling's question answered on the page, a hold), to act on
 * and wait again; else a line that left the card open, to answer with the on-card reply. */
function movedNews(root: string, w: { readonly key: string; readonly label: string; readonly kind: string }, m: Message): string {
  const ledger = numberedLedger(root);
  const card = ledger === undefined ? undefined : findDecision(ledger, w.key);

  if (card !== undefined && card.status !== "open") return closedLine(root, card);

  if (card !== undefined && answeredGrill(card)) {
    return `-> the user answered every question of ${w.label} on the card: close it now with ${closeProgram(root, w.key, "grilling finished")}, then answer #${m.id} and act on it\n`;
  }

  if (w.kind === "action" && m.text.startsWith(FAILED)) {
    return `-> the user's step ${w.label} failed, and it is not done: fix it and re-present it, or withdraw it, with ${failedProgram(root, w.key)}; never decide it\n`;
  }

  if (card !== undefined && answerRecorded(decisionRow(card), m)) {
    return `-> the user's #${m.id} on ${w.label} is recorded on the card, which stays open: act on it, then re-arm wait ${w.label}\n`;
  }

  return (
    `-> #${m.id} from the user left ${w.label} open: only the user's answer on the card records it. Answer #${m.id} with ` +
    `${onCardProgram(root, w.key, w.label, m.id)}, or, for a None of these, revise or withdraw ${w.label}\n`
  );
}

/** `wait`: the user's answer to one of these open decisions (ids or numbers), printed the moment it is
 * given; one given already and not recorded (a reply to it records nothing, except on a moved team, where the reply is
 * all that is owed: health's `owed`) prints at once. The ledger is read again at every poll, so
 * a decision closed meanwhile (withdrawn, or decided without an answer on the page) ends the wait as one
 * closed before does (open-21). On a moved team the user's answer on the page decides the card as it is sent: a card
 * decided with an `answer_line` is told as that answer, #answer_line, at the start or at any poll, with no need of its
 * chat line; a grilling with no question left open, at the start or by a line, as one to close (`closeProgram`); any
 * other line as {@link movedNews} says. */
export function wait(machine: Machine, root: string, keys: readonly string[]): Effect.Effect<void, ChatError, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const ledger = numberedLedger(root);
    const wanted = new Map<string, { readonly key: string; readonly label: string; readonly kind: string; readonly row: JsonObject }>();
    const moved = isMoved(root);

    for (const key of keys) {
      const d = ledger === undefined ? undefined : findDecision(ledger, key);

      if (d === undefined) return yield* Effect.fail(new ChatError({ reason: `no decision '${key}' in ${root}` }));
      const label = d.ref !== undefined && d.ref !== "" ? d.ref : d.id;

      if (d.status !== "open") {
        out.out(closedLine(root, d));

        return;
      }

      if (moved && answeredGrill(d)) {
        out.out(`-> the user answered every question of ${label} on the card: close it now with ${closeProgram(root, d.id, "grilling finished")}\n`);

        return;
      }

      wanted.set(d.id, { key: d.id, label, kind: d.kind, row: decisionRow(d) });
    }

    let tail: Tail | undefined;

    for (;;) {
      const first = tail === undefined;
      const messages = tail === undefined ? readChat(root) : tail.read();

      for (const m of messages) {
        const d = asString(m.decision) === undefined ? undefined : wanted.get(asString(m.decision) ?? "");

        if (d === undefined || m.from !== "user") continue;

        // Given already, it is news until the decision records it or, on a moved team, a reply answers it (owed).
        if (first && !owed(d.row, m, messages, moved)) continue;

        for (const line of renderLines(machine, root, [m])) out.out(`${line}\n`);

        if (moved) {
          out.out(movedNews(root, d, m));

          return;
        }

        out.out(
          d.kind === "action" && m.text.startsWith(FAILED)
            ? `-> the user's step ${d.label} failed, and it is not done: fix it and re-present it, \`fleet state ${root} decision ${d.label} --manual ...\`, or --withdraw "why"; never --decide\n`
            : d.kind === "permission"
              ? `-> the user answered ${d.label}: record it first, \`fleet state ${root} decision ${d.label} --decide "<allow-once, allow-kind or deny>" --resolution "answer given on the page (#${m.id})"\`; ` +
                "for an allow-once or allow-kind that prints the exact call to run, and nothing of it runs before; an allow-kind then asks you for a rule card (the --decide output says how)\n"
              : `-> the user answered ${d.label}: record it first, \`fleet state ${root} decision ${d.label} --decide ...\`\n`,
        );

        return;
      }

      if (tail === undefined) tail = new Tail(root, messages.reduce((max, m) => Math.max(max, m.id), 0));
      const now = numberedLedger(root);
      const closed = [...wanted.keys()].map((id) => (now === undefined ? undefined : findDecision(now, id))).find((d) => d !== undefined && d.status !== "open");

      if (closed !== undefined) {
        out.out(closedLine(root, closed));

        return;
      }

      yield* Effect.sleep(POLL_MS);
    }
  });
}
