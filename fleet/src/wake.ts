/**
 * The hub's wake: a fleet's host whose chat watch died is told to arm it again, through the socket Claude
 * Code's cross-session messaging listens on for each session process.
 *
 * A `--once` watch exits with the message it prints, and the session it wakes must arm the next one. A turn
 * that ends with no Stop (a usage-limit error, a compaction, a long run) arms none, and the Stop guard has
 * nothing to act on: the user's next messages wait unread. The hub looks every {@link WAKE_MS}: when no
 * watch of a served fleet's host runs (an orphaned one is none; a watch that just ended is none either: the
 * ten minutes `listening` gives a host are not the hub's), the user's messages wait unread, the oldest has
 * waited `FLEET_UNHEARD_S` and the session is idle, it writes one line to the session's socket ({@link deliver}),
 * a fixed template that says only "arm the watch" ({@link wakeText}). Whether it may is {@link mayWake}, one
 * pure function of what was read; what it did is kept per fleet in memory and in `REGISTRY/hub/wakes.json`
 * ({@link Wakes}), so a hub that restarts does not wake again at once.
 *
 * Whom it writes to is checked before every write ({@link deliverTo}, host.ts `reach`): the registry entry's
 * process runs, is Claude Code, started when the entry says, and holds the socket named after it. A live pid
 * and a socket file are not that. Idle is more than a quiet transcript: a tool call writes nothing while it
 * runs, so a session whose last `tool_use` has no result is in a turn (transcripts.ts `toolAwaited`). And one
 * wake at a time: no second is written until the session wrote its transcript after the first. That holds
 * under concurrency: whatever decides and writes a wake for a fleet (the hub's look, the user's "Wake now")
 * runs one at a time for that fleet ({@link Wakes.serial}), and records the wake before it is sent
 * ({@link Wakes.reserve}), so whoever looks next counts it. A fleet the look cannot read (its chat, or what
 * it reads of its session) is that fleet's failed look ({@link Blind}): logged once, shown on the page, and
 * the look goes on with the others.
 *
 * Measured on Linux with Claude Code 2.1.296 (2026-10-12): the socket is
 * `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`, `<pid>` the session's `claude` process, the pid a registry entry
 * records; one line of JSON and a close start a turn in an idle session within 2 s, with no token asked of
 * the sender; a line written while a turn runs is queued and runs as a turn of its own; the socket answers
 * nothing, so a connect and a write that succeed are all the sender knows; the session reads the line as
 * `Another Claude session sent a message: ...`, never as its user. Read in the binary and its docs, not
 * measured: the Mac's directory (`/private/tmp/cc-socks-<uid>`, else `/private/tmp/cc-socks`), an inbox of at
 * most 50 lines that rate-limits repeats, a receiver in a bypass-permissions mode holding a peer's message
 * for approval, no socket for a `--bare` session. The line's format is the binary's debug hint, not its
 * documented interface: a release may change it, and then a wake is a plain "could not wake" on the page.
 */
import { accessSync, constants, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import { cursorPath, hostOf, intOf, pyText, unreadFromUser, watchLive, type Listening } from "./chat/chat.ts";
import { storePath } from "./chat/store.ts";
import { parseInstant, stampOf } from "./clock.ts";
import { exists, FLEET_BIN, makeDirs, mtimeOf, readText, writeAtomic } from "./files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseObject, type JsonObject } from "./json.ts";
import { PROBE, reach, recordedHost, type Presence, type Probe } from "./host.ts";
import { stripHidden } from "./ledger/permission-words.ts";
import { readObject, type Entry } from "./registry.ts";
import { servingTranscriptOf, toolAwaited, usageLimitHit, type LimitHit } from "./transcripts.ts";
import { accountOf, windowsOf, type WindowReading } from "./usage.ts";
import type { Machine } from "./world.ts";

import * as Option from "effect/Option";

/** How often the hub looks for a host to wake. */
export const WAKE_MS = 30_000;

/** How long the user's oldest unread message waits before the first wake, unless `FLEET_UNHEARD_S` says: the
 * time a manager's watch waits before it tells, when no hub runs. */
export const UNHEARD_S = 120;

/** A session whose transcript was written this recently is in a turn: the plugin's mid-turn nudge tells it,
 * and the hub waits. */
export const IDLE_S = 30;

/** How long after the user's "Wake now" the next one may come. */
export const NOW_S = 60;

/** How long after a wake the next one for the same unread message may come: after the first, after the second. */
export const AGAIN_S = [10 * 60, 30 * 60] as const;

/** The most wakes for one unread message, and the most for one fleet in an hour. */
export const WAKES_MAX = 3;

const HOUR_MS = 3600 * 1000;

/** How long a usage-limit error holds a session when nothing says when its limit resets: the short window's length. */
export const LIMIT_S = 5 * 3600;

/** How long a session's socket may take to accept the line. */
const DELIVER_MS = 2000;

/** What a fleet's id and its DIR may hold to be written in the wake: letters, digits, `.`, `_`, `/` and `-`.
 * Nothing that reads as markup, a mention, a label (`SYSTEM:`), a list or a second command. */
const PLAIN = /^[A-Za-z0-9._/-]+$/u;

/** What the hub reads of a host: whether a watch of its runs, and the user's unread messages. */
export interface Heard {
  /** Whether a `--once` watch as the host runs now, for a session that is not gone. Not `listening`'s `on`:
   * a watch that ended in the last ten minutes, or a host that spoke in them, is not on here. */
  readonly on: boolean;
  readonly unread: number;
  /** The id of the oldest unread message: with the fleet, the key a wake is counted under. */
  readonly first: number | undefined;
  /** When it was written, in ms; undefined when its stamp does not read (then it has waited long enough). */
  readonly sinceMs: number | undefined;
}

/** The session that hosts a fleet, as the hub reads it. */
export interface Session {
  /** The ledger's `status`. */
  readonly status: string;
  /** Whether the session can be written to (host.ts `reach`): the entry's process is the Claude Code session
   * that served the fleet, and the socket named after it is its own. `gone` and `unknown` say why. */
  readonly there: Presence;
  /** Seconds since its transcript was last written; undefined when it has none to read. */
  readonly idleS: number | undefined;
  /** When its transcript was last written, in ms; undefined when it has none to read. */
  readonly writtenMs: number | undefined;
  /** Whether its last entry is a usage-limit error whose limit can still be in force ({@link limitInForce}). */
  readonly limited: boolean;
  /** Whether a tool call of its turn awaits its result (transcripts.ts `toolAwaited`): it is in a turn,
   * however quiet its transcript. */
  readonly inCall: boolean;
}

/** One wake written, or tried. */
export interface Wake {
  /** When, as a stamp. */
  readonly at: string;
  /** The oldest unread message it was for. */
  readonly first: number;
  /** The hub's timer, or the user's "Wake now". */
  readonly by: "hub" | "user";
  /** Why it could not be written; null when it was. */
  readonly error: string | null;
}

/** What the hub did for one fleet. */
export interface WakeRecord {
  /** The fleet's id when it was last woken (the record is kept by DIR). */
  readonly fleet: string;
  readonly wakes: readonly Wake[];
}

/** Why the hub does not wake a fleet now. */
export type Why = "listening" | "nothing unread" | "paused" | "done" | "unknown" | "gone" | "limit" | "young" | "busy" | "queued" | "backoff" | "spent" | "cap";

export type Verdict = { readonly wake: true } | { readonly wake: false; readonly why: Why };

const no = (why: Why): Verdict => ({ wake: false, why });

const msOf = (wake: Wake): number => parseInstant(wake.at) ?? 0;

/** The last wake that was written, when the session has not written its transcript since: it sits in the
 * session's inbox, unread, and another would only queue behind it and cost a turn of its own. Undefined when
 * the session wrote after it, when no wake was written, and for a session with no transcript to read. */
export function queued(record: WakeRecord | undefined, session: Session): Wake | undefined {
  const last = (record?.wakes ?? []).findLast((w) => w.error === null);

  return last !== undefined && session.writtenMs !== undefined && session.writtenMs <= msOf(last) ? last : undefined;
}

/** How many wakes were written or tried for the fleet in the hour before `nowMs`, the user's among them. */
const inHour = (wakes: readonly Wake[], nowMs: number): Wake[] => wakes.filter((w) => nowMs - msOf(w) < HOUR_MS);

/**
 * Whether the hub may wake a fleet's host now.
 *
 * Never: a host whose watch runs, nothing unread, a fleet paused or done, a session whose last entry is a
 * usage-limit error still in force. Not now: the machine did not say whether the session is there
 * (`unknown`: the next look asks again); the oldest unread message has waited less than `unheardS`; the
 * session is in a turn (`busy`: its transcript was written less than {@link IDLE_S} ago, or a tool call of
 * its turn awaits its result); the last wake written was not read yet ({@link queued}). Then the backoff,
 * counted over the hub's own wakes for the oldest unread message: the first at once, the second no sooner
 * than 10 min after it, the third no sooner than 30 min after that, and no fourth; and whatever the message
 * and whoever asked, at most {@link WAKES_MAX} in an hour. A wake that could not be written counts as one, so
 * a socket that refuses is not tried every look. Last, a session that is not there (`gone`): {@link wakePass}
 * records that as a wake that failed, so it is paced as one, and whoever reads the record knows the hub
 * cannot wake this fleet.
 */
export function mayWake(heard: Heard, record: WakeRecord | undefined, session: Session, nowMs: number, unheardS: number): Verdict {
  if (heard.on) return no("listening");

  if (heard.unread === 0 || heard.first === undefined) return no("nothing unread");

  if (session.status === "paused" || session.status === "done") return no(session.status);

  if (session.there.is === "unknown") return no("unknown");

  if (session.limited) return no("limit");

  if (heard.sinceMs !== undefined && nowMs - heard.sinceMs < unheardS * 1000) return no("young");

  if (session.inCall || (session.idleS !== undefined && session.idleS < IDLE_S)) return no("busy");

  if (queued(record, session) !== undefined) return no("queued");
  const wakes = record?.wakes ?? [];
  const mine = wakes.filter((w) => w.first === heard.first && w.by === "hub");
  const last = mine.at(-1);

  if (mine.length >= WAKES_MAX) return no("spent");

  if (last !== undefined && nowMs - msOf(last) < (AGAIN_S[mine.length - 1] ?? 0) * 1000) return no("backoff");

  if (inHour(wakes, nowMs).length >= WAKES_MAX) return no("cap");

  if (session.there.is === "gone") return no("gone");

  return { wake: true };
}

/**
 * Whether the hub's wake is working for a fleet, as its record says: false when the last wake could not be
 * written (the session is gone, its socket refused, its name cannot be written), when the hub wrote all it
 * allows for the message that waits first (`first`), or when the hour's wakes are spent. A manager's watch
 * tells a fleet that does not read its chat only then: a hub that runs and can do nothing is no hub to it.
 */
export function wakeWorks(record: WakeRecord | undefined, first: number | undefined, nowMs: number): boolean {
  const wakes = record?.wakes ?? [];

  if ((wakes.at(-1)?.error ?? null) !== null) return false;

  if (first !== undefined && wakes.filter((w) => w.first === first && w.by === "hub").length >= WAKES_MAX) return false;

  return inHour(wakes, nowMs).length < WAKES_MAX;
}

/** Why the user's "Wake now" is held, and until when if a time ends it. */
export interface Held {
  readonly why: string;
  /** When it may be used again, in ms; undefined when no time ends the hold (the session must read first). */
  readonly againMs: number | undefined;
}

/**
 * Why the user's "Wake now" is held for a fleet, or undefined when it may be used: one in {@link NOW_S}; at
 * most {@link WAKES_MAX} wakes in an hour, the hub's and the user's together; and none while the last wake
 * written was not read ({@link queued}). The button skips what the hub waits for (the backoff, the idle
 * time, the usage limit, the message's age), never these: each wake costs the session a turn.
 */
export function nowHeld(record: WakeRecord | undefined, session: Session, nowMs: number): Held | undefined {
  const wakes = record?.wakes ?? [];
  const mine = wakes.findLast((w) => w.by === "user");

  if (mine !== undefined && nowMs - msOf(mine) < NOW_S * 1000) return { why: "you woke it less than a minute ago", againMs: msOf(mine) + NOW_S * 1000 };
  const recent = inHour(wakes, nowMs);

  if (recent.length >= WAKES_MAX) return { why: `${String(WAKES_MAX)} wakes in the last hour, the most a fleet is written`, againMs: msOf(recent[recent.length - WAKES_MAX] ?? recent[0] ?? { at: "", first: 0, by: "hub", error: null }) + HOUR_MS };

  return queued(record, session) === undefined ? undefined : { why: "the session has not read the last wake yet: another would queue behind it", againMs: undefined };
}

/**
 * Whether the usage limit a turn ended on (`hit`) can still be in force at `nowMs`. Once it cannot, the
 * session is an idle one like any other, and the ordinary rules wake it.
 *
 * It holds until, in this order:
 * 1. the reading's: `resets_at` of the window that was full at the error in the machine's usage reading
 *    (`reading`, usage.ts): a window at 100 % that resets after the error, the one the entry names when it
 *    names one, else any (the later reset when two are full);
 * 2. the entry's own: the reset it carries (`quotaLimits.resetsAt`), when the reading has no such window;
 * 3. the fallback: {@link LIMIT_S} (5 h, the short window's length) after the entry was written.
 */
export function limitInForce(hit: LimitHit, reading: readonly WindowReading[], nowMs: number): boolean {
  const full = reading.filter((w) => w.used >= 100 && w.resetsAtMs > hit.atMs && (hit.window === undefined || w.window === hit.window));
  const own = hit.resetsAtMs !== undefined && hit.resetsAtMs > hit.atMs ? hit.resetsAtMs : hit.atMs + LIMIT_S * 1000;

  return nowMs < (full.length > 0 ? Math.max(...full.map((w) => w.resetsAtMs)) : own);
}

/**
 * The wake's text: a fixed template from the hub, with the fleet's id, its DIR, how many of the user's
 * messages wait and since which, and the command that arms the watch, the one the Stop guard names
 * (`watch_command` and `DEAF` in hooks/tstack-hook: keep the two the same). No word of anyone's message, no
 * mention, nothing to do but arm the watch. An Error when the id or the DIR cannot be written plainly.
 */
export function wakeText(fleet: string, dir: string, role: string, unread: number, seen: number): string | Error {
  if (!PLAIN.test(fleet) || !PLAIN.test(dir)) return new Error("the fleet's id or its folder cannot be written in a plain command");

  return (
    `[hub] ${fleet} (${dir}): the chat watch is not running and ${String(unread)} message(s) from the user wait unread since #${String(seen)}. ` +
    `Arm it as a background command (run_in_background: true, timeout: 3300000): \`${FLEET_BIN} chat ${dir} watch --as ${role} --all --resume --once\`; it prints them first.`
  );
}

/** The one line a session's socket takes for `text`. */
export function lineOf(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/** The folder of the sessions' sockets: `FLEET_CC_SOCKS` when set (the tests'), else Claude Code's own:
 * `$XDG_RUNTIME_DIR/cc-socks` (`/run/user/<uid>/cc-socks`); on the Mac `/private/tmp/cc-socks-<uid>`, else
 * `/private/tmp/cc-socks` (the Mac's is read in the binary, not measured). */
export function socksDir(env: (name: string) => string | undefined): string {
  const given = env("FLEET_CC_SOCKS");

  if (given !== undefined && given !== "") return given;
  const uid = String(process.getuid?.() ?? "");

  if (process.platform === "darwin") return exists(`/private/tmp/cc-socks-${uid}`) ? `/private/tmp/cc-socks-${uid}` : "/private/tmp/cc-socks";
  const runtime = env("XDG_RUNTIME_DIR");

  return join(runtime !== undefined && runtime !== "" ? runtime : `/run/user/${uid}`, "cc-socks");
}

/** The socket of the session process `pid` in `socks`. */
export function socketOf(socks: string, pid: number): string {
  return join(socks, `${String(pid)}.sock`);
}

/** Why a connection failed, in words. */
function reasonOf(cause: Error & { readonly code?: string }): string {
  if (cause.code === "ENOENT") return "the session has no socket";

  if (cause.code === "ECONNREFUSED") return "the session's socket refused the connection";

  return `the session's socket failed (${cause.code ?? cause.message})`;
}

/**
 * Write `text` to the session socket at `path`: connect, one line of JSON ({@link lineOf}), close. Undefined
 * when the line was written; else why not, in words. The socket answers nothing, so a written line is all
 * that is known: whether a turn began is seen later, when the watch runs again or it does not.
 */
export function deliver(path: string, text: string, timeoutMs: number = DELIVER_MS): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ path });

    const finish = (why: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(why);
    };

    const timer = setTimeout(() => finish("the session's socket did not take the line in time"), timeoutMs);
    socket.once("error", (cause) => finish(reasonOf(cause)));
    socket.once("connect", () => socket.end(lineOf(text), () => finish(undefined)));
  });
}

/** How a wake is written: {@link deliver}, or a test's own. */
export type Send = (path: string, text: string) => Promise<string | undefined>;

/** Whether the session hosting `entry`'s fleet can be written to in `socks` (host.ts `reach`). */
function reachOf(entry: Entry, socks: string, probe: Probe): Presence {
  const host = recordedHost(entry);

  return reach(host, host === undefined ? undefined : socketOf(socks, host.pid), probe);
}

/** What a verified write did: the line was written; or it was not, and why; or the machine did not say
 * whether the session is there (`unknown`), and nothing was tried. */
export type Delivered = { readonly written: true } | { readonly written: false; readonly unknown: boolean; readonly why: string };

/**
 * Write `text` to the socket of the session that hosts `entry`'s fleet, when that session is there: its
 * process is the Claude Code session the entry names and the socket is its own (host.ts `reach`, asked here,
 * at the write). The one way anything of the hub's reaches a session's socket.
 */
export async function deliverTo(entry: Entry, socks: string, text: string, send: Send = deliver, probe: Probe = PROBE): Promise<Delivered> {
  const host = recordedHost(entry);
  const there = reachOf(entry, socks, probe);

  if (there.is !== "there" || host === undefined) return { written: false, unknown: there.is === "unknown", why: there.is === "there" ? "the registry names no process for it" : `the session is ${there.is === "gone" ? "gone" : "not known to be there"}: ${there.why}` };
  const failed = await send(socketOf(socks, host.pid), text);

  return failed === undefined ? { written: true } : { written: false, unknown: false, why: failed };
}

/** The session hosting `entry`'s fleet, as read now. */
export function sessionOf(machine: Machine, entry: Entry, socks: string, probe: Probe = PROBE): Session {
  const host = recordedHost(entry);
  const transcript = servingTranscriptOf(entry.dir, machine.config, asString(entry.raw["session_id"]));
  const written = transcript === undefined ? undefined : mtimeOf(transcript);
  const hit = transcript === undefined ? undefined : usageLimitHit(transcript);
  // A call written before the process that runs now started was another process's: nothing runs it.
  const startedMs = host === undefined ? undefined : probe.startedMs(host.pid);

  return {
    status: asString(readObject(join(entry.dir, "state.json"))?.["status"]) ?? "",
    there: reachOf(entry, socks, probe),
    idleS: written === undefined ? undefined : machine.now().getTime() / 1000 - written,
    writtenMs: written === undefined ? undefined : written * 1000,
    limited: hit !== undefined && limitInForce(hit, windowsOf(machine.registry.place.home, accountOf(machine.env)), machine.now().getTime()),
    inCall: transcript !== undefined && toolAwaited(transcript, startedMs === undefined ? undefined : startedMs - 1000),
  };
}

/** `REGISTRY/hub/wakes.json`: what the hub did for each fleet, by DIR. */
export function wakesPath(machine: Machine): string {
  return join(machine.registry.place.home, "hub", "wakes.json");
}

function wakeOf(row: JsonObject | undefined): Wake | undefined {
  const at = asString(row?.["at"]);
  const first = asNumber(row?.["first"]);
  const error = asString(row?.["error"]);

  if (row === undefined || at === undefined || first === undefined || parseInstant(at) === undefined) return undefined;

  return { at, first, by: row["by"] === "user" ? "user" : "hub", error: error ?? null };
}

/** What of a fleet the hub's look could not read: its chat (the messages, the cursor, the watch's files) or its
 * session (the ledger's status, the transcript, the usage reading). */
export type Unread = "chat" | "session";

/** A fleet the hub's look failed at: the hub cannot tell whether its host listens, and wakes nobody for it. */
export interface Blind {
  /** When the look first failed this way, as a stamp. */
  readonly since: string;
  readonly what: Unread;
  /** Why, in the machine's words, on one line. */
  readonly why: string;
}

/** What the look failed at, in the log's words. */
const FAILED_WORDS: Readonly<Record<Unread, string>> = { chat: "cannot read its chat", session: "cannot read its session" };

/** A wake recorded before it was sent ({@link Wakes.reserve}). */
export interface Reserved {
  /** The wake as recorded: as one that was written. */
  readonly wake: Wake;
  /** The line was not written: the wake stays in the record as one that failed, with `why`. The wake as it stands. */
  readonly fail: (why: string) => Wake;
  /** Nothing was tried: the wake leaves the record. */
  readonly release: () => void;
}

/** The most of a failure's reason that is kept: it is shown on the page and written in the log. */
const WHY_MAX = 300;

/** Why `cause` failed, on one line, with nothing that hides or reorders it on a screen. */
function whyOf(cause: unknown): string {
  const said = cause instanceof Error ? cause.message : String(cause);

  return [...stripHidden(said.replace(/\s+/gu, " ")).trim()].slice(0, WHY_MAX).join("");
}

/**
 * What the hub did for each fleet: in memory, and written through to {@link wakesPath} so a hub that starts
 * again counts the wakes of the one before. A file that does not read is no record; one that cannot be
 * written stops nothing (the memory still paces this hub).
 *
 * It is also where a fleet's wakes are kept in order: {@link serial} runs what decides and writes a wake one
 * at a time for a fleet, and {@link reserve} records a wake before it is sent. And it holds each fleet's
 * failed look ({@link blind}), in memory only: the next look says it again or clears it.
 */
export class Wakes {
  private readonly held = new Map<string, WakeRecord>();
  private readonly turns = new Map<string, Promise<void>>();
  private readonly blinded = new Map<string, Blind>();
  private readonly path: string;
  private readonly log: (line: string) => void;

  /** `log` takes one line when a look fails at a fleet in a new way; the hub gives its own. */
  constructor(machine: Machine, log: (line: string) => void = () => undefined) {
    this.path = wakesPath(machine);
    this.log = log;
    const raw = Option.getOrUndefined(parseObject(readText(this.path) ?? ""));

    for (const [dir, value] of Object.entries(raw ?? {})) {
      const row = asObject(value);
      const wakes = (asArray(row?.["wakes"]) ?? []).flatMap((w) => wakeOf(asObject(w)) ?? []);

      if (wakes.length > 0) this.held.set(dir, { fleet: asString(row?.["fleet"]) ?? "", wakes });
    }
  }

  /** What was done for the fleet at `dir`. */
  of(dir: string): WakeRecord | undefined {
    return this.held.get(dir);
  }

  /**
   * Run `work` for the fleet at `dir` when nothing else of that fleet's runs: the hub's look and each "Wake
   * now" read the record, decide and write inside it, so no two of them decide from the same record. One
   * fleet's work never waits for another's. What `work` gives; a `work` that throws rejects for its caller
   * alone, and the next one runs all the same.
   */
  serial<T>(dir: string, work: () => Promise<T>): Promise<T> {
    const done = (this.turns.get(dir) ?? Promise.resolve()).then(work);

    const turn = done.then(
      () => undefined,
      () => undefined,
    );

    this.turns.set(dir, turn);

    void turn.then(() => {
      if (this.turns.get(dir) === turn) this.turns.delete(dir);
    });

    return done;
  }

  /** Record `wake` for the fleet at `dir`, the hub's or the user's: each counts in the hour's. */
  note(dir: string, fleet: string, wake: Wake): void {
    this.held.set(dir, { fleet, wakes: [...(this.held.get(dir)?.wakes ?? []), wake] });
    this.save();
  }

  /**
   * Record a wake for the fleet at `dir` before it is sent, as one that was written: until the send is over,
   * every reader of the record counts it (the minute, the hour's three, "the last wake was not read"), and a
   * hub that dies in the send has not forgotten it. A line that was written leaves it as it is; one that was
   * not marks it as a wake that failed ({@link Reserved.fail}); when nothing was tried it is taken out
   * ({@link Reserved.release}).
   */
  reserve(dir: string, fleet: string, wake: Wake): Reserved {
    this.note(dir, fleet, wake);

    const settle = (settled: Wake | undefined): void => {
      const record = this.held.get(dir);
      const wakes = (record?.wakes ?? []).flatMap((w) => (w === wake ? (settled ?? []) : [w]));

      if (wakes.length === 0) this.held.delete(dir);
      else this.held.set(dir, { fleet: record?.fleet ?? fleet, wakes });
      this.save();
    };

    return {
      wake,
      fail: (why) => {
        const failed: Wake = { ...wake, error: why };
        settle(failed);

        return failed;
      },
      release: () => settle(undefined),
    };
  }

  /** Forget what no longer counts for the fleet at `dir`: a wake older than an hour, unless it was for the
   * message that still waits first (`first`; undefined when none does). */
  prune(dir: string, nowMs: number, first: number | undefined): void {
    const record = this.held.get(dir);

    if (record === undefined) return;
    const wakes = record.wakes.filter((w) => w.first === first || nowMs - msOf(w) < HOUR_MS);

    if (wakes.length === record.wakes.length) return;

    if (wakes.length === 0) this.held.delete(dir);
    else this.held.set(dir, { ...record, wakes });
    this.save();
  }

  /** The failed look at the fleet at `dir`, while its last look failed; undefined once one worked. */
  blind(dir: string): Blind | undefined {
    return this.blinded.get(dir);
  }

  /**
   * What the page shows of a fleet the hub's last look could not read ({@link failed}): since when, what
   * (`chat` or `session`) and why, `{"since", "what", "why"}`. Undefined while the look reads it. For such a
   * fleet the hub cannot tell whether its host listens, and wakes nobody.
   */
  blindView(dir: string): JsonObject | undefined {
    const blind = this.blinded.get(dir);

    return blind === undefined ? undefined : { since: blind.since, what: blind.what, why: blind.why };
  }

  /**
   * The look at `fleet` (at `dir`) failed reading `what`, at `at`: it is that fleet's failed look until one
   * works ({@link saw}). Logged in one line when it is news (the fleet's look worked before, or failed at
   * something else), never at every look. The record.
   */
  failed(dir: string, fleet: string, what: Unread, cause: unknown, at: Date): Blind {
    const before = this.blinded.get(dir);
    const why = whyOf(cause);

    if (before?.what === what) {
      const same: Blind = before.why === why ? before : { ...before, why };
      this.blinded.set(dir, same);

      return same;
    }

    const blind: Blind = { since: stampOf(at), what, why };
    this.blinded.set(dir, blind);
    this.log(`wake: ${fleet} (${dir}): the hub ${FAILED_WORDS[what]}: ${why}. Nobody is woken for it until that works; the other fleets are looked at as before.`);

    return blind;
  }

  /** The look at the fleet at `dir` worked: it has no failed look any more. */
  saw(dir: string): void {
    this.blinded.delete(dir);
  }

  private save(): void {
    try {
      makeDirs(join(this.path, ".."));
      writeAtomic(this.path, `${dumps(Object.fromEntries([...this.held].map(([dir, r]) => [dir, { fleet: r.fleet, wakes: r.wakes.map((w) => ({ ...w })) }])), { indent: 2 })}\n`);
    } catch {
      // the file is for the next hub: this one keeps counting in memory
    }
  }
}

/** A fleet whose host has no watch running while the user's messages wait. */
interface Deaf {
  /** The host's cursor: the last message a `--once` watch exited with. */
  readonly seen: number;
  readonly unread: number;
  /** The oldest unread message: its id, and when it was written. */
  readonly first: number;
  readonly since: string;
}

/**
 * The fleet at `dir` when no watch of its host runs while the user's messages wait there; else why it is not
 * that. The hub's own reading, not `listening`'s: that one counts a host as reading for ten minutes after its
 * watch ended or it spoke, which would keep the commonest disconnection (the watch exits on a message, the
 * host answers and ends its turn without arming the next) unwoken for those ten minutes. What that grace is
 * for, a host busy with the message its watch just printed, the idle check covers.
 */
function deafAt(machine: Machine, dir: string): Deaf | "watching" | "nothing unread" {
  if (watchLive(machine, dir)) return "watching";
  const seen = intOf(readText(cursorPath(dir, hostOf(dir)))) ?? 0;
  const unread = unreadFromUser(dir, seen);
  const first = unread[0];

  return first === undefined ? "nothing unread" : { seen, unread: unread.length, first: first.id, since: pyText(first.at) };
}

const isDeaf = (read: Deaf | string): read is Deaf => read !== String(read);

/** What a wake did. */
export interface Woken {
  readonly fleet: string;
  readonly dir: string;
  readonly wake: Wake;
}

/** What reaches a session's socket, and how: the folder of the sockets, the write, the machine's processes.
 * The hub's own are {@link socksDir}, {@link deliver} and host.ts `PROBE`; a test gives its own. */
export interface Reach {
  readonly socks: string;
  readonly send: Send;
  readonly probe: Probe;
}

/**
 * Write one wake for `entry`'s fleet and record it, written or not. It is recorded before it is sent
 * ({@link Wakes.reserve}), and the caller holds the fleet's turn ({@link Wakes.serial}): nothing else decides
 * a wake for this fleet until this one is settled. Undefined, and nothing left in the record, when the machine
 * did not say whether the session is there: the next look asks again. It never throws: a write that throws is
 * a wake that failed.
 */
async function wakeOne(machine: Machine, wakes: Wakes, to: Reach, entry: Entry, deaf: Deaf, by: Wake["by"]): Promise<Woken | undefined> {
  const text = wakeText(entry.id, entry.dir, hostOf(entry.dir), deaf.unread, deaf.seen);
  const wake: Wake = { at: stampOf(machine.now()), first: deaf.first, by, error: null };

  if (text instanceof Error) {
    const failed: Wake = { ...wake, error: text.message };
    wakes.note(entry.dir, entry.id, failed);

    return { fleet: entry.id, dir: entry.dir, wake: failed };
  }

  const reserved = wakes.reserve(entry.dir, entry.id, wake);
  const done = await deliverTo(entry, to.socks, text, to.send, to.probe).catch((cause: unknown): Delivered => ({ written: false, unknown: false, why: whyOf(cause) }));

  if (!done.written && done.unknown) {
    reserved.release();

    return undefined;
  }

  return { fleet: entry.id, dir: entry.dir, wake: done.written ? reserved.wake : reserved.fail(done.why) };
}

/** `FLEET_UNHEARD_S` as a manager's watch reads it: a number, else {@link UNHEARD_S}. */
function unheardSeconds(env: (name: string) => string | undefined): number {
  const given = Number(env("FLEET_UNHEARD_S"));

  return env("FLEET_UNHEARD_S") === undefined || Number.isNaN(given) ? UNHEARD_S : given;
}

/**
 * Throw when the chat of the fleet at `dir` is there and cannot be read (its file, or the folder it is in):
 * the store's readers take a file they cannot stat for an empty chat (chat/store.ts `Tail`), and the look
 * would take the fleet for one where nothing waits. A fleet with no chat yet has nothing to read.
 */
function chatReads(dir: string): void {
  const path = storePath(dir);

  try {
    accessSync(path, constants.R_OK);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;

    throw cause;
  }

  if (!statSync(path).isFile()) throw new Error(`${path} is not a file`);
}

/** What one look reads of a fleet whose host has no watch running while the user's messages wait. */
interface Read {
  readonly deaf: Deaf;
  readonly session: Session;
  readonly nowMs: number;
}

/**
 * What the look reads of `entry`'s fleet: undefined when its host listens or nothing waits, and when it
 * cannot be read. That last is the fleet's failed look ({@link Wakes.failed}: logged once, shown on the page
 * as {@link Wakes.blindView}); a look that reads clears it. It never throws, so one fleet's broken folder or
 * transcript is that fleet's alone.
 */
function readFleet(machine: Machine, wakes: Wakes, to: Reach, entry: Entry): Read | undefined {
  let reading: Unread = "chat";

  try {
    chatReads(entry.dir);
    const deaf = deafAt(machine, entry.dir);
    const nowMs = machine.now().getTime();
    wakes.prune(entry.dir, nowMs, isDeaf(deaf) ? deaf.first : undefined);
    reading = "session";
    const read = isDeaf(deaf) ? { deaf, session: sessionOf(machine, entry, to.socks, to.probe), nowMs } : undefined;
    wakes.saw(entry.dir);

    return read;
  } catch (cause: unknown) {
    wakes.failed(entry.dir, entry.id, reading, cause, machine.now());

    return undefined;
  }
}

/**
 * One look of the hub at every served fleet, the manager's too: each whose host {@link mayWake} is written
 * one wake; one that may be woken but is not there is recorded as a wake that failed, with why. What it wrote
 * or tried; a fleet it left alone is not in it. Each fleet is read and woken in that fleet's turn
 * ({@link Wakes.serial}), so a "Wake now" that arrives meanwhile decides after it, from the record it left;
 * a fleet that cannot be read is left out, with its failed look recorded, and the others are looked at.
 */
export async function wakePass(machine: Machine, wakes: Wakes, socks: string, send: Send = deliver, probe: Probe = PROBE): Promise<Woken[]> {
  const unheardS = unheardSeconds(machine.env);
  const to: Reach = { socks, send, probe };
  const done: Woken[] = [];

  for (const entry of machine.registry.live()) {
    const woken = await wakes.serial(entry.dir, async () => {
      const read = readFleet(machine, wakes, to, entry);

      if (read === undefined) return undefined;
      const heard: Heard = { on: false, unread: read.deaf.unread, first: read.deaf.first, sinceMs: parseInstant(read.deaf.since) };
      const verdict = mayWake(heard, wakes.of(entry.dir), read.session, read.nowMs, unheardS);

      // `gone` is the last of the reasons: all else allowed a wake, and there is nobody to write it to.
      return !verdict.wake && verdict.why !== "gone" ? undefined : wakeOne(machine, wakes, to, entry, read.deaf, "hub");
    });

    if (woken !== undefined) done.push(woken);
  }

  return done;
}

/** Why the user's "Wake now" wrote nothing: `held` when a limit of its own holds it ({@link nowHeld}; `again`
 * is when it may be used, a stamp, when a time ends the hold), else there is nothing to wake or nobody to
 * write to. */
export interface NotWoken {
  readonly why: string;
  readonly held: boolean;
  readonly again: string | null;
}

/**
 * The user's "Wake now" for `entry`'s fleet: one wake at once, whatever the hub's backoff, the idle time, the
 * usage limit and the message's age say (the user knows what the hub cannot). Its own limits hold
 * ({@link nowHeld}): one a minute, the hour's {@link WAKES_MAX} with the hub's, none while the last was not
 * read. It is recorded as the hub's are and counts in the hour's; it neither restarts nor advances the hub's
 * count for the message. A `why` when it is held, when there is nothing to wake (a watch runs, nothing waits
 * unread) or when the session is not there; then nothing is written and nothing recorded. It reads, decides and
 * writes in the fleet's turn ({@link Wakes.serial}): of any number asked at once, and the hub's look with
 * them, one is written and the others are held by it. It rejects when the fleet cannot be read.
 */
export function wakeNow(machine: Machine, wakes: Wakes, socks: string, entry: Entry, send: Send = deliver, probe: Probe = PROBE): Promise<Woken | NotWoken> {
  const not = (why: string, held = false, again: string | null = null): NotWoken => ({ why, held, again });

  return wakes.serial(entry.dir, async () => {
    // A chat that cannot be read is not one where nothing waits: the click is told why, as the look records it.
    chatReads(entry.dir);
    const deaf = deafAt(machine, entry.dir);

    if (!isDeaf(deaf)) return not(deaf === "watching" ? "the fleet's host is listening: there is nothing to wake" : "none of your messages waits unread: there is nothing to wake");
    const session = sessionOf(machine, entry, socks, probe);
    const held = nowHeld(wakes.of(entry.dir), session, machine.now().getTime());

    if (held !== undefined) return not(`not woken: ${held.why}`, true, held.againMs === undefined ? null : stampOf(new Date(held.againMs)));

    if (session.there.is === "gone") return not(`the session is gone (${session.there.why}): there is nobody to write to. Open it in a terminal`);
    const woken = session.there.is === "unknown" ? undefined : await wakeOne(machine, wakes, { socks, send, probe }, entry, deaf, "user");

    return woken ?? not(`${session.there.is === "unknown" ? session.there.why : "the machine did not say whether the session is there"}: nothing was written. Try again`);
  });
}

/**
 * What the page shows of a fleet whose host has no watch running while the user's messages wait, once the
 * oldest has waited `FLEET_UNHEARD_S` (the wake's own threshold, so the line does not flash during an
 * ordinary exchange); undefined otherwise, and for a fleet paused or done, which the hub leaves alone. Since
 * when and how many, the oldest's id, when it was woken for it, and where it stands (`end`, null while the
 * hub still wakes): `gone` (the session is not there, with `why`), `unknown` (the machine did not say; the
 * hub asks again), `limit` (a usage-limit error still in force), `failed` (the last wake could not be
 * written, with `why`), `spent` ({@link WAKES_MAX} wakes of the hub and no answer), `queued` (the last wake
 * was not read yet), `busy` (a tool call of its turn awaits its result). And the user's "Wake now": `held`
 * says why it cannot be used now, `again` when it can when a time ends the hold ({@link nowHeld}). `heard`
 * is what the view already read: with nothing unread there, nothing more is read. It never throws into the
 * page: of a fleet that cannot be read it says nothing, and {@link Wakes.blindView} says why.
 */
export function deafView(machine: Machine, wakes: Wakes, socks: string, entry: Entry, heard: Listening, probe: Probe = PROBE): JsonObject | undefined {
  try {
    return deafRead(machine, wakes, socks, entry, heard, probe);
  } catch {
    // What cannot be read is the hub's look's to say (`Wakes.blindView`), within one look.
    return undefined;
  }
}

function deafRead(machine: Machine, wakes: Wakes, socks: string, entry: Entry, heard: Listening, probe: Probe): JsonObject | undefined {
  const deaf = heard.unread === 0 ? "nothing unread" : deafAt(machine, entry.dir);

  if (!isDeaf(deaf)) return undefined;
  const sinceMs = parseInstant(deaf.since);
  const nowMs = machine.now().getTime();

  if (sinceMs !== undefined && nowMs - sinceMs < unheardSeconds(machine.env) * 1000) return undefined;
  const session = sessionOf(machine, entry, socks, probe);

  if (session.status === "paused" || session.status === "done") return undefined;
  const record = wakes.of(entry.dir);
  const mine = (record?.wakes ?? []).filter((w) => w.first === deaf.first);
  const failed = mine.at(-1)?.error ?? null;
  const spent = mine.filter((w) => w.by === "hub").length >= WAKES_MAX;

  const end =
    session.there.is !== "there"
      ? session.there.is
      : session.limited
        ? "limit"
        : failed !== null
          ? "failed"
          : spent
            ? "spent"
            : queued(record, session) !== undefined
              ? "queued"
              : session.inCall
                ? "busy"
                : null;

  const held = nowHeld(record, session, nowMs);

  return {
    since: deaf.since,
    unread: deaf.unread,
    first: deaf.first,
    woken: mine.filter((w) => w.error === null).map((w) => w.at),
    end,
    why: session.there.is !== "there" ? session.there.why : end === "failed" ? failed : null,
    held: held?.why ?? null,
    again: held?.againMs === undefined ? null : stampOf(new Date(held.againMs)),
  };
}
