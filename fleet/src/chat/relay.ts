/**
 * Direct delivery between the manager's page and the coordinators' chats, both done by the hub:
 *
 * - `deliveries`: a message the user writes on the manager's page to one or more live coordinators is
 *   written, as the hub stores it, into each one's own chat as the user's message to `coordinator`, with
 *   `via: {fleet: "manager", id}`; the manager's message records each copy in `delivered: [{fleet, id}]`
 *   (the link). A reply, a side chat and a quote go across in the coordinator's own numbering, the quote's
 *   place (`at`) as the fleet's page can follow it (`quoteIn`).
 * - `Courier`: each answer of a coordinator in its own chat to a delivered message (`re` its id) is
 *   mirrored onto the manager's page from `<fleet>`, as the answer to the original, with
 *   `via: {fleet, id}`. The mirror is checked against the manager's chat under its lock, so it is written
 *   once however often the courier reads.
 */
import { resolvePath } from "../files.ts";
import { asArray, asNumber, asObject, asString, truthy, type Json } from "../json.ts";
import type { Entry } from "../registry.ts";
import type { Machine } from "../world.ts";
import { fromManager } from "./chat.ts";
import { appendLocked, readChat, Tail, type Message } from "./store.ts";

/** One copy of a message in a coordinator's chat: the fleet and the copy's id there. */
export interface Delivery {
  readonly fleet: string;
  readonly id: number;
}

/** What the manager's message holds when it is delivered: the fields as stored. */
export interface Delivered {
  readonly id: number;
  readonly at: string;
  readonly text: string;
  readonly re: number | null;
  readonly side: Json | undefined;
  readonly author: string | undefined;
  readonly quote: Json | undefined;
}

/** A message as delivery and the courier store it, built in the store's key order (`via` last). */
interface Copy {
  id: number;
  at: string;
  from: string;
  to: string[];
  text: string;
  re: number | null;
  parts: { text: string }[];
  author?: string;
  quote?: Json;
  side?: Json;
  via?: { fleet: string; id: number };
}

/** What `mirror` finds instead of writing: the answer is on the manager's page already, or its original is not. */
const MIRRORED = new Error("mirrored already");

const NO_ORIGINAL = new Error("the original is not on the manager's page");

/** Whether `name` (as recorded when it was delivered or mirrored) is the fleet of `entry`. */
function names(entry: Entry, name: Json | undefined): boolean {
  const given = asString(name);

  return given !== undefined && (given === entry.id || entry.aliases.includes(given));
}

/** The live coordinators of this machine, the manager's own DIR left out. */
export function coordinators(machine: Machine, managerRoot: string): Entry[] {
  const me = resolvePath(managerRoot);

  return machine.registry.live().filter((e) => e.role !== "manager" && e.dir !== me);
}

/** The id of the copy of `m` that `entry` has: delivered to it, or mirrored from it. */
function copyIn(entry: Entry, m: Message): number | undefined {
  for (const row of asArray(m.stored["delivered"]) ?? []) {
    const d = asObject(row);

    if (names(entry, d?.["fleet"])) return asNumber(d?.["id"]);
  }

  const via = asObject(m.stored["via"]);

  return names(entry, via?.["fleet"]) ? asNumber(via?.["id"]) : undefined;
}

/** The side chat in `entry`'s chat that the manager's side chat `side` continues, or "new" for one there. */
function sideIn(entry: Entry, known: readonly Message[], side: number): number | "new" {
  const theirs = readChat(entry.dir);

  for (const m of known) {
    if (m.side !== side) continue;
    const copy = copyIn(entry, m);
    const there = copy === undefined ? undefined : theirs.find((t) => t.id === copy);

    if (there !== undefined && truthy(there.side)) return asNumber(there.side) ?? "new";
  }

  return "new";
}

/**
 * The quote as `entry`'s copy carries it. Its place (`at`) is an address on the manager's page: one of
 * `entry`'s own decisions shown there (`#decision/<fleet>/<id>`) becomes that decision's address on the
 * fleet's own page; any other place keeps the manager's address and gains `page`, the manager's page's path,
 * so the link on the fleet's page leads to it. Without the manager's path the place is dropped.
 */
function quoteIn(entry: Entry, quote: Json | undefined, managerPage: string | undefined): Json | undefined {
  const q = asObject(quote);
  const at = asObject(q?.["at"]);

  if (q === undefined || at === undefined) return quote;
  const { at: _place, ...rest } = q;
  const own = /^#decision\/([^/]+)\/([^/]+)$/u.exec(asString(at["hash"]) ?? "");
  let fleet: string | undefined;

  try {
    fleet = own?.[1] === undefined ? undefined : decodeURIComponent(own[1]);
  } catch {
    fleet = undefined;
  }

  if (own?.[2] !== undefined && names(entry, fleet)) return { ...rest, at: { ...at, hash: "#decision/" + own[2] } };

  return managerPage === undefined ? rest : { ...rest, at: { ...at, page: managerPage } };
}

/** Write `message` into one coordinator's chat; its id there, or undefined when it could not be. */
function deliverTo(entry: Entry, known: readonly Message[], message: Delivered, managerPage: string | undefined): number | undefined {
  const parent = message.re === null ? undefined : known.find((m) => m.id === message.re);
  const re = parent === undefined ? null : (copyIn(entry, parent) ?? null);
  const continued = asNumber(message.side);
  const side = continued === message.id ? "new" : continued === undefined ? undefined : sideIn(entry, known, continued);

  const stored = appendLocked(entry.dir, (theirs, nextId) => {
    const answered = re === null ? undefined : theirs.find((m) => m.id === re);
    let own: Json | undefined;

    if (side === "new") own = nextId;
    else if (side !== undefined) own = theirs.some((m) => m.side === side) ? side : nextId;
    else if (answered !== undefined && truthy(answered.side)) own = answered.side;

    const copy: Copy = {
      id: nextId,
      at: message.at,
      from: "user",
      to: ["coordinator"],
      text: message.text,
      re: answered === undefined ? null : re,
      parts: [{ text: message.text }],
    };

    if (message.author !== undefined) copy.author = message.author;

    const quote = quoteIn(entry, message.quote, managerPage);

    if (quote !== undefined) copy.quote = quote;

    if (own !== undefined) copy.side = own;
    copy.via = { fleet: "manager", id: message.id };

    return { ...copy };
  });

  return stored instanceof Error ? undefined : stored.id;
}

/** Deliver the manager's `message`, addressed `to`, into the chat of each live coordinator among `to`;
 * called under the manager's store lock (`known` is what it holds). A fleet whose chat cannot be written
 * is left out: the message waits for the manager there, as before. */
export function deliveries(machine: Machine, managerRoot: string, known: readonly Message[], to: readonly string[], message: Delivered): Delivery[] {
  const out: Delivery[] = [];
  const manager = machine.registry.find(managerRoot);
  const managerPage = manager === undefined ? undefined : `/f/${encodeURIComponent(manager.id)}/`;

  for (const fleet of to) {
    const entry = coordinators(machine, managerRoot).find((e) => e.id === fleet);

    if (entry === undefined) continue;
    let id: number | undefined;

    try {
      id = deliverTo(entry, known, message, managerPage);
    } catch {
      id = undefined;
    }

    if (id !== undefined) out.push({ fleet: entry.id, id });
  }

  return out;
}

/** What the courier has read of one coordinator's chat. */
interface Reading {
  readonly tail: Tail;
  /** Each delivered copy's id there, to the manager's message it copies. */
  readonly links: Map<number, number>;
}

/** Mirrors the coordinators' answers to delivered messages onto the manager's page. */
export class Courier {
  private readonly read = new Map<string, Reading>();

  /** Read what each coordinator's chat gained and mirror its answers to delivered messages; how many it wrote. */
  relay(machine: Machine): number {
    const manager = machine.registry.manager();

    if (manager === undefined) return 0;
    let wrote = 0;

    for (const entry of coordinators(machine, manager.dir)) {
      let reading = this.read.get(entry.dir);

      if (reading === undefined) {
        reading = { tail: new Tail(entry.dir), links: new Map() };
        this.read.set(entry.dir, reading);
      }

      try {
        for (const m of reading.tail.read()) {
          if (m.from === "user" && fromManager(m)) {
            const original = asNumber(asObject(m.stored["via"])?.["id"]);

            if (original !== undefined) reading.links.set(m.id, original);
          } else if (m.from === "coordinator") {
            const original = reading.links.get(asNumber(m.re) ?? 0);

            if (original !== undefined && mirror(manager.dir, entry, m, original)) wrote += 1;
          }
        }
      } catch {
        // read it all again next time: what was mirrored is not written twice
        this.read.delete(entry.dir);
      }
    }

    return wrote;
  }
}

/** Write `answer`, from `entry`'s chat, onto the manager's page as the answer to its message `original`;
 * false when it is there already. */
function mirror(managerRoot: string, entry: Entry, answer: Message, original: number): boolean {
  const stored = appendLocked(managerRoot, (known, nextId) => {
    const there = known.some((m) => m.re === original && names(entry, asObject(m.stored["via"])?.["fleet"]) && asNumber(asObject(m.stored["via"])?.["id"]) === answer.id);

    if (there) return MIRRORED;
    const parent = known.find((m) => m.id === original);

    if (parent === undefined) return NO_ORIGINAL;

    const copy: Copy = {
      id: nextId,
      at: asString(answer.at) ?? "",
      from: entry.id,
      to: ["user"],
      text: answer.text,
      re: original,
      parts: [{ text: answer.text }],
    };

    if (answer.quote !== undefined) copy.quote = answer.quote;

    if (truthy(parent.side)) copy.side = parent.side ?? null;
    copy.via = { fleet: entry.id, id: answer.id };

    return { ...copy };
  });

  if (stored === MIRRORED || stored === NO_ORIGINAL) return false;

  if (stored instanceof Error) throw stored;

  return true;
}
