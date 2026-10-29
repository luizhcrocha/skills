/**
 * A fleet moved to another session with `fleet serve DIR --take-over`, said where the user and the displaced
 * session see it. The command takes the page and the chat watch from a host that still runs, and any session
 * can type it; so it is never silent:
 *
 * - {@link recordTakeover} writes an event in the fleet's ledger and one line in its chat, from the hub's name
 *   ({@link HUB}) to the user, a fixed template ({@link takeoverText}): who displaced whom, their pids and
 *   when each process started, and when. The line carries the same facts as a `takeover` object.
 * - {@link displacedLine} is the one line the displaced host's watch prints before it stands down (chat/watch.ts).
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { appendLocked, readChat, type Message } from "./chat/store.ts";
import { parseInstant, stampOf } from "./clock.ts";
import { Refusal } from "./errors.ts";
import { readText, writeText } from "./files.ts";
import { asNumber, asObject, asString, type Json } from "./json.ts";
import { ledgerText, parseLedger } from "./ledger/model.ts";
import { withLedgerLock } from "./ledger/store.ts";
import { validate } from "./ledger/validate.ts";
import { startedMsOf } from "./procs.ts";
import type { Machine } from "./world.ts";

/** Who the hub's own lines in a chat are from. */
export const HUB = "fleet-hub";

/** What a session's id may hold to be written in a line a session or the user reads. */
const SESSION = /^[A-Za-z0-9._-]{1,128}$/u;

/** One side of a takeover: a session's process. */
export interface Party {
  readonly pid: number;
  /** When that process started, as a stamp; null when the machine did not say. */
  readonly started: string | null;
  /** The Claude Code session's id; null when none was recorded, or it is not plain. */
  readonly session: string | null;
}

/** A takeover, as the fleet's chat holds it. */
export interface Takeover {
  /** The id of the chat line that says it. */
  readonly id: number;
  /** When, as a stamp. */
  readonly at: string;
  /** The session that hosts the fleet since. */
  readonly by: Party;
  /** The session it displaced, which was running. */
  readonly from: Party;
}

/** The process `pid` of the session `session`, as a takeover names it: `startedMs` reads when it started
 * (procs.ts `startedMsOf`; a test gives its own). */
export function partyOf(pid: number, session: string | undefined, startedMs: (pid: number) => number | undefined = startedMsOf): Party {
  const ms = startedMs(pid);

  return { pid, started: ms === undefined ? null : stampOf(new Date(ms)), session: session !== undefined && SESSION.test(session) ? session : null };
}

function words(p: Party): string {
  return `session ${p.session ?? "not recorded"} (pid ${String(p.pid)}, started ${p.started ?? "at a time the machine did not say"})`;
}

/** The chat line of a takeover: a fixed template of the two sessions and the time, nothing else. */
export function takeoverText(at: string, by: Party, from: Party): string {
  return (
    `[hub] This fleet's host changed at ${at}: ${words(by)} took it over with \`fleet serve --take-over\` from ${words(from)}, which was running. ` +
    `The page, the chat watch and the hub's wakes are the new session's now. If you did not ask for this, say so here.`
  );
}

/** The ledger's event of a takeover. */
function eventText(by: Party, from: Party): string {
  return `Host changed: ${words(by)} took the fleet over with \`fleet serve --take-over\` from ${words(from)}, which was running.`;
}

/** What {@link recordTakeover} wrote: whether the ledger has the event, the chat line's id, and why either
 * was not written. */
export interface Recorded {
  readonly event: boolean;
  readonly message: number | undefined;
  readonly faults: readonly string[];
}

/** Why the ledger in `root` could not take the event, or undefined when it did. Written under the ledger's
 * lock, as `fleet state` writes. */
function recordEvent(machine: Machine, root: string, at: string, text: string): string | undefined {
  return withLedgerLock(root, () => {
    const path = join(root, "state.json");
    const read = readText(path);
    const ledger = read === undefined ? undefined : Option.getOrUndefined(parseLedger(read));

    if (ledger === undefined || ledger instanceof Refusal) return `no ledger reads in ${root}`;
    ledger.events.push({ at, agent: null, kind: "note", text, important: true });
    ledger.updated = stampOf(machine.now());
    const fault = validate(ledger);

    if (fault !== undefined) return fault.reason;
    writeText(path, ledgerText(ledger));

    return undefined;
  });
}

/**
 * Record that the session `by` took the fleet in `root` over from `from`, which was running: an event in the
 * ledger (a `note`, marked important) and a line in the chat from {@link HUB} to the user. Each is tried
 * whatever became of the other, and neither stops the takeover: a session resumed in a new process must be
 * able to take its fleet back though the ledger does not read. What was written, and why what was not.
 */
export function recordTakeover(machine: Machine, root: string, by: Party, from: Party): Recorded {
  const at = stampOf(machine.now());
  const faults: string[] = [];
  let event = false;
  let message: number | undefined;

  try {
    const fault = recordEvent(machine, root, at, eventText(by, from));

    if (fault === undefined) event = true;
    else faults.push(`the ledger did not take the event: ${fault}`);
  } catch (cause: unknown) {
    faults.push(`the ledger did not take the event: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  try {
    const text = takeoverText(at, by, from);
    const stored = appendLocked(root, (_known, nextId) => ({ id: nextId, at, from: HUB, to: ["user"], text, re: null, parts: [{ text }], takeover: { at, by: { ...by }, from: { ...from } } }));

    if (stored instanceof Error) faults.push(`the chat did not take the line: ${stored.message}`);
    else message = stored.id;
  } catch (cause: unknown) {
    faults.push(`the chat did not take the line: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  return { event, message, faults };
}

function partyRead(value: Json | undefined): Party | undefined {
  const row = asObject(value);
  const pid = asNumber(row?.["pid"]);
  const started = asString(row?.["started"]);
  const session = asString(row?.["session"]);

  if (row === undefined || pid === undefined || !Number.isInteger(pid)) return undefined;

  return { pid, started: started !== undefined && parseInstant(started) !== undefined ? started : null, session: session !== undefined && SESSION.test(session) ? session : null };
}

/** The takeover `m` says, when it is a line of the hub's that carries one. */
function takeoverOf(m: Message): Takeover | undefined {
  const row = m.from === HUB ? asObject(m.stored["takeover"]) : undefined;
  const at = asString(row?.["at"]);
  const by = partyRead(row?.["by"]);
  const from = partyRead(row?.["from"]);

  return at === undefined || parseInstant(at) === undefined || by === undefined || from === undefined ? undefined : { id: m.id, at, by, from };
}

/** The last takeover the chat of `root` holds, or undefined. */
export function lastTakeover(root: string, messages: readonly Message[] = readChat(root)): Takeover | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const found = m === undefined ? undefined : takeoverOf(m);

    if (found !== undefined) return found;
  }

  return undefined;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The one line the displaced host's watch prints before it stands down: who hosts the fleet in `root` now
 * (`pid`, and `session` when the registry names a plain one), and when it was displaced: the time of the
 * takeover the chat records for that process, else now.
 */
export function displacedLine(machine: Machine, root: string, pid: number, session: string | undefined): string {
  const last = lastTakeover(root);
  const at = new Date((last?.by.pid === pid ? parseInstant(last.at) : undefined) ?? machine.now().getTime());

  return (
    `chat: this fleet's host is now session ${session !== undefined && SESSION.test(session) ? session : "not recorded"} (pid ${String(pid)}); ` +
    `you were displaced at ${two(at.getHours())}:${two(at.getMinutes())} by \`fleet serve --take-over\`, and this watch stands down with nothing marked read. ` +
    `If that was not intended, tell the user on the page.`
  );
}
