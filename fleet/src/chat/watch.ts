/**
 * The chat's long-running commands: `watch` (what is open for WHO, then each new message as it lands,
 * with a manager's or coordinator's `!` lines) and `wait` (the user's answer to one of these decisions).
 * They poll the store every 0.3 s; a pinned clock (FLEET_NOW) dates what they measure, not their pace.
 */
import { closeSync, openSync, utimesSync } from "node:fs";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { parseInstant } from "../clock.ts";
import { ChatError } from "../errors.ts";
import { readText, remove, resolvePath, writeText } from "../files.ts";
import { answeredAt, answeredGrill, answerRecorded, decisionRow, FAILED, silentWorkers } from "../health.ts";
import { Out } from "../io.ts";
import { asArray, asObject, asString, dumps, parseObject, pyRepr, type Json, type JsonObject } from "../json.ts";
import { decodeLedger, type Decision, type Ledger } from "../ledger/model.ts";
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
import { FleetNews } from "./news.ts";
import { unreadLine } from "../news/news.ts";
import { isWatch } from "./watchers.ts";
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
    const at = answeredAt(d, said);
    const mark = `answer:${pyText(d["id"])}:${at ?? "None"}`;

    if (at === undefined || (told.has(mark) && told.get(mark) !== false)) continue;
    const instant = parseInstant(at);

    if (instant === undefined) continue;

    if (secondsNow(machine) - instant / 1000 < unheardS) continue;
    told.set(mark, true);
    const m = [...said].reverse().find((x) => x.decision !== undefined && pyRepr(x.decision) === pyRepr(d["id"]) && pyText(x.at) === at);
    const ref = asString(d["ref"]) ?? pyText(d["id"]);
    lines.push(
      `! ${entry.id} has not recorded the user's answer to ${ref} (${oneLine(d["title"])}), ` +
        `given at ${at.slice(11, 16)} as #${m?.id ?? "?"}: "${[...oneLine(m?.text ?? "")].slice(0, 120).join("")}". SendMessage its session ` +
        `(${entry.session ?? entry.id}) to record it: \`fleet state <dir> decision ${ref} --decide ...\`.`,
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
 * messages unanswered, the answers they have not recorded, their silent workers; each told once (kept in the
 * manager's DIR). */
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
 * so a watch armed again is not woken by it at once; `fleet state` says it at every command until then. */
function answeredGrillings(root: string, told: Map<string, Json>): string[] {
  const lines: string[] = [];

  for (const d of numberedLedger(root)?.decisions ?? []) {
    const mark = `grill:${d.id}:${d.revised !== undefined && d.revised !== null && d.revised !== "" ? d.revised : d.opened}`;

    if (!answeredGrill(d) || (told.has(mark) && told.get(mark) !== false)) continue;
    told.set(mark, true);
    const ref = d.ref !== undefined && d.ref !== "" ? d.ref : d.id;
    lines.push(
      `! ${ref} (${oneLine(d.title)}): every question is answered and the grilling is still open. Record it now: ` +
        `\`fleet state <dir> decision ${ref} --decide "..." --resolution "grilling finished"\`, or withdraw it with its reason.`,
    );
  }

  return lines;
}

/** For a coordinator's watch: its own silent workers, the messages its workers left unanswered for
 * FLEET_NUDGE_S (ten minutes), and its grillings answered and not recorded, each told once across watches. */
export function ownSilent(machine: Machine, root: string): string[] {
  const toldPath = join(root, "watch-coordinator.told");
  const told = readTold(toldPath);

  const lines = [
    ...silentLines(machine, root, undefined, told),
    ...nudgeLines(machine, root, told, seconds(machine.env, "FLEET_NUDGE_S", NUDGE_S)),
    ...answeredGrillings(root, told),
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
 * each new message to WHO as it lands. A `--once` watch holds its pid in DIR/watch-WHO.pid while it runs,
 * and on exiting moves the cursor to the last message it printed: what it handed to the session it wakes
 * is what was read. Without `--once` it never exits, so it runs only on a terminal and marks nothing read. */
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

      yield* follow(machine, root, who, request);

      return;
    }

    const pulse = pulsePath(root, who);
    const held = intOf(readText(pulse));

    if (held !== undefined && held > 0 && held !== process.pid && isWatch(held, root, who)) {
      return yield* Effect.fail(
        new ChatError({
          reason:
            `a watch as ${who} already runs for ${root} (pid ${held}), and its lines wake the session that armed it. ` +
            `Leave it running; if that session is gone, \`kill ${held}\` and arm the watch again.`,
        }),
      );
    }

    const pid = String(process.pid);
    writeText(pulse, pid);

    const end = (): void => {
      if (readText(pulse) === pid) remove(pulse);
      touch(leftPath(root, who), secondsNow(machine));
    };

    const onSignal = (): void => {
      end();
      process.exit(0);
    };

    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const last = yield* follow(machine, root, who, request);

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

/** What `watch` prints; the id of the last message it printed when it exits (`--once`). */
function follow(machine: Machine, root: string, who: string, request: WatchRequest): Effect.Effect<number | undefined, never, Out> {
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
    const checkS = seconds(machine.env, "FLEET_CHECK_S", 30);
    // A new line does not end the watch at once: it settles, so one wake carries a burst of lines.
    const settle = settleOf(machine.env, request.settle);
    let checked: number | undefined;

    for (;;) {
      const now = performance.now() / 1000;

      if (request.once && ((window !== undefined && now >= window) || settle.due(now))) return last;
      yield* Effect.sleep(POLL_MS);
      const fresh = tail.read().filter((m) => m.to.includes(who) || (request.all && m.from === "user" && waitsHere(m)));
      show(fresh);

      if (tell() && window === undefined) window = performance.now() / 1000 + request.batch;
      let lines: string[] = [];
      const backlog = checked === undefined;

      if ((who === "manager" || who === "coordinator") && (checked === undefined || performance.now() / 1000 - checked >= checkS)) {
        checked = performance.now() / 1000;
        lines = who === "manager" ? fleetsUnheard(machine, resolvePath(root)) : ownSilent(machine, root);

        for (const line of lines) out.out(`${line}\n`);
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

/** What `wait` says of a decision already closed. */
function closedLine(d: Decision): string {
  const label = d.ref !== undefined && d.ref !== "" ? d.ref : d.id;
  const answer = d.answer ?? "";

  return `${label} is already ${d.status}: ${answer !== "" ? answer : (d.resolution ?? "None")}\n`;
}

/** `wait`: the user's answer to one of these open decisions (ids or numbers), printed the moment it is
 * given; one given already and not recorded (a reply to it records nothing) prints at once. The ledger is read again at every poll, so
 * a decision closed meanwhile (withdrawn, or decided without an answer on the page) ends the wait as one
 * closed before does (open-21). */
export function wait(machine: Machine, root: string, keys: readonly string[]): Effect.Effect<void, ChatError, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const ledger = numberedLedger(root);
    const wanted = new Map<string, { readonly label: string; readonly kind: string; readonly row: JsonObject }>();

    for (const key of keys) {
      const d = ledger === undefined ? undefined : findDecision(ledger, key);

      if (d === undefined) return yield* Effect.fail(new ChatError({ reason: `no decision '${key}' in ${root}` }));
      const label = d.ref !== undefined && d.ref !== "" ? d.ref : d.id;

      if (d.status !== "open") {
        out.out(closedLine(d));

        return;
      }

      wanted.set(d.id, { label, kind: d.kind, row: decisionRow(d) });
    }

    let tail: Tail | undefined;

    for (;;) {
      const first = tail === undefined;
      const messages = tail === undefined ? readChat(root) : tail.read();

      for (const m of messages) {
        const d = asString(m.decision) === undefined ? undefined : wanted.get(asString(m.decision) ?? "");

        if (d === undefined || m.from !== "user") continue;

        // Given already, it is news until the decision records it (answerRecorded); a reply does not.
        if (first && answerRecorded(d.row, m)) continue;

        for (const line of renderLines(machine, root, [m])) out.out(`${line}\n`);
        out.out(
          d.kind === "action" && m.text.startsWith(FAILED)
            ? `-> the user's step ${d.label} failed, and it is not done: fix it and re-present it, \`fleet state ${root} decision ${d.label} --manual ...\`, or --withdraw "why"; never --decide\n`
            : `-> the user answered ${d.label}: record it first, \`fleet state ${root} decision ${d.label} --decide ...\`\n`,
        );

        return;
      }

      if (tail === undefined) tail = new Tail(root, messages.reduce((max, m) => Math.max(max, m.id), 0));
      const now = numberedLedger(root);
      const closed = [...wanted.keys()].map((id) => (now === undefined ? undefined : findDecision(now, id))).find((d) => d !== undefined && d.status !== "open");

      if (closed !== undefined) {
        out.out(closedLine(closed));

        return;
      }

      yield* Effect.sleep(POLL_MS);
    }
  });
}
