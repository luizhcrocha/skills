/**
 * The conversation as the chat lays it out, a messenger's way: one row per message in the order they
 * were sent, a day's separator where the day changes, consecutive messages of one sender within five
 * minutes under one name and time, and a reply quoting the message it answers unless that message sits
 * right above it. Side chats are a link in the main conversation, where their latest message falls.
 *
 * Decision activity (a message that carries a decision, such as an answer, a grilling's answers or a
 * note, and every message whose `re` chain leads to one) is the control plane's, not the conversation's:
 * the chat leaves it out unless the viewer asks for it, and then shows each as a one-line marker that
 * leads to the decision. The decision's page shows it in full, as that decision's thread.
 */
import { Core, type Message, type Side } from "./core.ts";

/** How far apart two messages of one sender may be and still share their name and time. */
export const GROUP_MS = 5 * 60_000;

/** A message as the chat shows it. */
export interface Item {
  readonly message: Message;
  /** For a message from the viewer, who has not answered it yet. */
  readonly waiting: readonly string[];
  /** It starts a run of its sender's messages: its name and time are shown. */
  head: boolean;
  /** It ends a run of its sender's messages. */
  tail: boolean;
  /** The message it answers, quoted on one line; null when it answers none, or the one right above it. */
  quote: number | null;
}

/** A row of the chat. */
export type Row =
  | { readonly kind: "day"; readonly key: string; readonly day: string }
  | { readonly kind: "msg"; readonly key: string; readonly item: Item }
  | { readonly kind: "mark"; readonly key: string; readonly message: Message; readonly decision: string }
  | { readonly kind: "side"; readonly key: string; readonly side: Side };

/**
 * The decision activity among `messages`: each message that carries a decision, and each whose `re` chain
 * leads to one, with the decision it is about (its own when it carries one, else the one of what it answers).
 */
export function decisionTrail(messages: Iterable<Message>): Map<number, string> {
  const trail = new Map<number, string>();

  for (const m of [...messages].sort((a, b) => a.id - b.id)) {
    const about = m.decision || (m.re == null ? undefined : trail.get(m.re));

    if (about) trail.set(m.id, about);
  }

  return trail;
}

/** A local calendar day, "2026-10-01"; empty when `at` is not a moment. */
export function dayOf(at: string | number): string {
  const t = new Date(at);

  if (isNaN(t.getTime())) return "";

  return `${String(t.getFullYear())}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

const WEEKDAY = new Intl.DateTimeFormat([], { weekday: "long", day: "numeric", month: "long" });

const DATED = new Intl.DateTimeFormat([], { day: "numeric", month: "long", year: "numeric" });

/** A day's separator in words, seen at `now`: "Today", "Yesterday", "Tuesday 29 September", with its year when it is not this one. */
export function dayWords(day: string, now: number): string {
  const [y, m, d] = day.split("-").map(Number);

  if (!y || !m || !d) return "";
  const at = new Date(y, m - 1, d);
  const today = new Date(now);

  if (day === dayOf(now)) return "Today";

  if (day === dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime())) return "Yesterday";

  return y === today.getFullYear() ? WEEKDAY.format(at) : DATED.format(at);
}

/** Who a run of messages belongs to: the sender, and on the viewer's side the login that wrote it. */
const senderKey = (m: Message): string => m.from + "\u0000" + (m.from === "user" ? m.author : "");

/** Marks the runs among `items`, in order: each starts a run unless the one before is its sender's, within GROUP_MS. */
function group(items: readonly Item[]): void {
  let prev: Item | undefined;

  for (const it of items) {
    const gap = Date.parse(it.message.at) - Date.parse(prev?.message.at ?? "");
    const joins = prev !== undefined && senderKey(prev.message) === senderKey(it.message) && gap >= 0 && gap <= GROUP_MS;

    it.head = !joins;

    if (joins && prev) prev.tail = false;
    prev = it;
  }
}

/** Quotes, in `items`, the message each answers when it is among `shown` and is not the one right before it. */
function quote(items: readonly Item[], shown: ReadonlySet<number>): void {
  let prev: Item | undefined;

  for (const it of items) {
    const re = it.message.re;
    it.quote = re != null && shown.has(re) && re !== prev?.message.id ? re : null;
    prev = it;
  }
}

/** Who has not answered each of the viewer's messages: its recipients, less those whose reply names it. */
function itemsOf(all: readonly Message[]): (m: Message) => Item {
  const answered = new Set(all.flatMap((m) => (m.re == null ? [] : [String(m.re) + "\u0000" + m.from])));

  return (m) => ({ message: m, waiting: m.from === "user" ? m.to.filter((r) => !answered.has(String(m.id) + "\u0000" + r)) : [], head: true, tail: true, quote: null });
}

/** A message or a side chat's link, placed at the id of its latest message. */
interface Unit {
  readonly at: number;
  readonly row: Row;
}

/**
 * The rows of the chat: the main conversation (`focus` null), where every side chat is a link, or the side
 * chat opened by message `focus`. Decision activity is left out, or with `decisions` shown as markers.
 */
export function chatRows(all: readonly Message[], focus: number | "new" | null, decisions: boolean): Row[] {
  const sorted = [...all].sort((a, b) => a.id - b.id);
  const byId = new Map(sorted.map((m) => [m.id, m]));
  const trail = decisionTrail(sorted);
  const item = itemsOf(sorted);
  const units: Unit[] = [];

  for (const m of sorted) {
    if (focus == null ? m.side != null : m.side !== focus) continue;
    const about = trail.get(m.id);

    if (about === undefined) units.push({ at: m.id, row: { kind: "msg", key: "m:" + String(m.id), item: item(m) } });
    else if (decisions) units.push({ at: m.id, row: { kind: "mark", key: "d:" + String(m.id), message: m, decision: about } });
  }

  if (focus == null) for (const side of Core.sidesOf(sorted)) units.push({ at: side.last, row: { kind: "side", key: "side:" + String(side.id), side } });
  units.sort((a, b) => a.at - b.at);
  const shown = new Set(units.flatMap((u) => (u.row.kind === "msg" ? [u.at] : [])));

  /* Day separators, and the runs and quotes of the messages between two rows of another kind. */
  const rows: Row[] = [];
  let day = "";
  let run: Item[] = [];

  const close = (): void => {
    group(run);
    quote(run, shown);
    run = [];
  };

  for (const u of units) {
    const d = dayOf(byId.get(u.at)?.at ?? "");

    if (d && d !== day) {
      close();
      day = d;
      rows.push({ kind: "day", key: "day:" + d, day: d });
    }

    if (u.row.kind === "msg") run.push(u.row.item);
    else close();
    rows.push(u.row);
  }

  close();

  return rows;
}

/**
 * Decision `id`'s thread: the viewer's answers and notes on it, what was asked about it (a message quoting its
 * page, and the side chat such a message opens), and every reply to them, in order, as the chat would show them.
 */
export function decisionThread(all: readonly Message[], id: string): Item[] {
  const sorted = [...all].sort((a, b) => a.id - b.id);
  const trail = decisionTrail(sorted);
  const item = itemsOf(sorted);
  const asked = new Set<number>();
  const sides = new Set<number>();

  for (const m of sorted) {
    const about = Core.quoteDecision(m.quote) === id;

    if (about && m.side === m.id) sides.add(m.id);

    if (about || (m.re != null && asked.has(m.re)) || (m.side != null && sides.has(m.side))) asked.add(m.id);
  }

  const items = sorted.flatMap((m) => (trail.get(m.id) === id || asked.has(m.id) ? [item(m)] : []));

  group(items);
  quote(items, new Set(items.map((it) => it.message.id)));

  return items;
}

/** How many messages from the fleet the viewer has not read, decision activity counted only when it is shown. */
export function unreadInChat(all: readonly Message[], read: number, decisions: boolean): number {
  const trail = decisions ? null : decisionTrail(all);

  return all.filter((m) => m.from !== "user" && m.id > read && !trail?.has(m.id)).length;
}

/** A side chat as its list shows it. */
export interface SideSummary {
  readonly id: number;
  /** The first line of what opened it, or where its quote is from. */
  readonly title: string;
  /** Where its quote is from, as words. */
  readonly from: string;
  /** The decision whose page its quote was taken on, as the page addresses it; null for any other place. */
  readonly decision: string | null;
  /** Its last message's id and time. */
  readonly last: number;
  readonly lastAt: string;
  readonly count: number;
  /** The fleet's messages in it after `readOf(id)`. */
  readonly unread: number;
  /** Every word in it and its quote, in lower case, for a search. */
  readonly words: string;
}

/** The side chats among `all`, newest activity first; `readOf` is the last message read in each. */
export function sideSummaries(all: readonly Message[], readOf: (side: number) => number): SideSummary[] {
  const byId = new Map(all.map((m) => [m.id, m]));

  return Core.sidesOf(all)
    .map((s): SideSummary => {
      const inSide = all.filter((m) => m.side === s.id);
      const from = s.quote?.from ?? "";
      const first = (s.first.trim().split("\n")[0] ?? "").trim();

      return {
        id: s.id,
        title: first || from || "Side chat",
        from,
        decision: Core.quoteDecision(s.quote),
        last: s.last,
        lastAt: byId.get(s.last)?.at ?? "",
        count: s.count,
        unread: inSide.filter((m) => m.from !== "user" && m.id > readOf(s.id)).length,
        words: [from, s.quote?.text ?? "", ...inSide.map((m) => m.text)].join("\n").toLowerCase(),
      };
    })
    .sort((a, b) => b.last - a.last);
}
