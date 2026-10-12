/**
 * The inbox of a decision's page, as threads, with no DOM: the page's main thread (a side chat the page keeps
 * per decision, held with the decision's owner, SPEC API 5), then one thread per mark (pending or sent, with
 * the fleet's answers to it and Luiz's replies in it) and one per side chat on the decision's words,
 * newest activity first. Read from the chat as the page has it and from what waits to be sent.
 *
 * An answer to a batch that names no mark is never left out of a comment's thread: it is the one comment's
 * when the batch has one (marks.ts `sentOf`), and with several it shows in each one's thread as the whole
 * batch's (`whole`), answering none of them.
 */
import type { MarkBatch, MarkItem, MarkKind, Message } from "./core.ts";
import { sentOf } from "./marks.ts";
import type { Pending, PendingMsg } from "./autosend.ts";

/** Where a mark's thread stands: waiting to be sent, sent, or answered by the fleet. */
export type MarkStatus = "pending" | "sent" | "answered";

/** One message of a thread as the inbox shows it. */
export interface Turn {
  /** The chat message's id; null for one still waiting to be sent. */
  readonly id: number | null;
  /** The pending message's key, for one still waiting. */
  readonly key: string;
  readonly mine: boolean;
  /** Who said it: "You", the fleet (the page's host stands for it), or an agent's name. */
  readonly who: string;
  readonly text: string;
  /** Words it quotes, one line ("" for none). */
  readonly quote: string;
  readonly at: string;
  /** Why the fleet leaves the mark as it is (an answer `--no-change`); "" for none. */
  readonly keep: string;
  /**
   * The comments it answers at once, by number, when it is the fleet's answer to their whole batch naming
   * none of them; empty for any other message. Such an answer leaves each comment as it was: not answered,
   * and not unread for it.
   */
  readonly whole: readonly number[];
  /** A batch of comments in the page's thread, shown as its card. */
  readonly marks?: MarkBatch;
}

interface Common {
  readonly key: string;
  readonly turns: readonly Turn[];
  /** Its newest activity, for the order: the last message's id, past every stored one while something waits. */
  readonly last: number;
  readonly unread: boolean;
  /** Whether something in it waits to be sent. */
  readonly waits: boolean;
}

/** A thread of the inbox: the page's main thread, a mark's, a side chat on words, or the fleet's answers to a batch that name no mark. */
export type Thread =
  | (Common & { readonly _tag: "page"; readonly opener: number | null })
  | (Common & { readonly _tag: "side"; readonly opener: number | null; readonly quote: string })
  | (Common & { readonly _tag: "mark"; readonly item: MarkItem; readonly status: MarkStatus; readonly batch: number | null; readonly kind: MarkKind; readonly withdrawn: boolean })
  | (Common & { readonly _tag: "loose"; readonly batch: number });

/** What the inbox is read from. */
export interface InboxSource {
  readonly messages: readonly Message[];
  /** The decision's place (`#decision/<id>`, or `#decision/<fleet>/<id>` on the manager's page). */
  readonly hash: string;
  readonly pending: Pending;
  /** The page's host, as the chat names it (`coordinator`, `manager`), and the fleet it stands for. */
  readonly host: string;
  readonly owner: string;
  /** The last fleet message read in each thread, by key; one not there was read up to `base`. */
  readonly read: { readonly [key: string]: number };
  readonly base: number;
  /** Side chats started on words that have no message yet: their keys and quotes. */
  readonly fresh: readonly { readonly key: string; readonly quote: string }[];
}

/** The inbox: the main thread, and the rest, newest activity first. */
export interface Inbox {
  readonly page: Thread & { readonly _tag: "page" };
  readonly threads: readonly Thread[];
}

/** A mark thread's key. */
export const markKey = (n: number): string => "m:" + String(n);

/** The words a reply in a sent mark's thread starts with, so the fleet and the inbox know the mark it is about. */
export const replyLead = (n: number): string => `Mark #${String(n)}: `;

const LEAD = /^Mark #(\d+): /u;

/**
 * Whether `m` opens the main thread of the decision at `hash`: Luiz's, quoting the decision at the page, a
 * side chat of its own; or a batch of comments on the decision in no side chat (the page's thread when none
 * was open, its batches after going into it).
 */
const opensPage = (m: Message, hash: string): boolean =>
  m.from === "user" && ((m.side === m.id && m.quote?.at?.hash === hash && m.quote.at.anchor === "dv-page") || (m.side === null && m.marks?.at.hash === hash));

/** Whether `m` opens a side chat on the decision at `hash`'s words (not its main thread). */
const opensSide = (m: Message, hash: string): boolean => m.from === "user" && m.side === m.id && m.quote?.at?.hash === hash && m.quote.at.anchor !== "dv-page";

/** The first message of the decision's main thread, when it has one. */
export const pageOpener = (messages: readonly Message[], hash: string): Message | undefined => messages.find((m) => opensPage(m, hash));

const oneLine = (s: string): string => s.replace(/\s+/gu, " ").trim();

/** The inbox of the decision at `src.hash`. */
export function inboxOf(src: InboxSource): Inbox {
  const { messages, hash, pending } = src;
  const ids = messages.reduce((top, m) => Math.max(top, m.id), 0);
  const who = (m: Message): string => (m.from === "user" ? "You" : m.from === src.host ? src.owner : m.from);

  const turn = (m: Message, text = m.text): Turn => ({ id: m.id, key: "c" + String(m.id), mine: m.from === "user", who: who(m), text, quote: m.quote && !opensPage(m, hash) && !opensSide(m, hash) ? oneLine(m.quote.text) : "", at: m.at, keep: m.keep ?? "", whole: [] });

  const waiting = (p: PendingMsg): Turn => ({ id: null, key: p.key, mine: true, who: "You", text: p.text, quote: p.quote ? oneLine(p.quote.text) : "", at: "", keep: "", whole: [] });
  const lastOf = (turns: readonly Turn[], waits: boolean): number => (waits ? ids + 1 : Math.max(0, ...turns.map((t) => t.id ?? 0)));
  const unreadOf = (key: string, turns: readonly Turn[]): boolean => turns.some((t) => !t.mine && t.id !== null && t.id > (src.read[key] ?? src.base));

  /* The main thread: its openers (the first names it; a page that left two, as a page leaving can, shows both as one) and the messages in them, then what waits for it. */
  const openers = new Set(messages.flatMap((m) => (opensPage(m, hash) ? [m.id] : [])));
  const opener = pageOpener(messages, hash);
  const inPage = (m: Message): boolean => openers.has(m.id) || (m.side !== null && openers.has(m.side));
  const pageTurns = [...messages.filter(inPage).map((m) => (m.marks ? { ...turn(m, ""), marks: m.marks } : turn(m))), ...pending.msgs.filter((p) => p.to._tag === "page").map(waiting)];
  const pageWaits = pending.msgs.some((p) => p.to._tag === "page");
  const page = { _tag: "page" as const, key: "page", opener: opener?.id ?? null, turns: pageTurns, last: lastOf(pageTurns, pageWaits), unread: unreadOf("page", pageTurns), waits: pageWaits };

  /* Side chats on the decision's words: stored ones, then new ones (with words waiting, or none yet). */
  const sides: Thread[] = messages
    .filter((m) => opensSide(m, hash))
    .map((o) => {
      const key = "side:" + String(o.id);
      const waits = pending.msgs.filter((p) => p.to._tag === "side" && p.to.id === o.id);
      const turns = [...messages.filter((m) => m.side === o.id).map((m) => turn(m)), ...waits.map(waiting)];

      return { _tag: "side", key, opener: o.id, quote: oneLine(o.quote?.text ?? ""), turns, last: lastOf(turns, waits.length > 0), unread: unreadOf(key, turns), waits: waits.length > 0 };
    });

  const fresh = new Map<string, string>();

  for (const p of pending.msgs) if (p.to._tag === "new") fresh.set(p.to.key, oneLine(p.to.quote.text));

  for (const f of src.fresh) if (!fresh.has(f.key)) fresh.set(f.key, oneLine(f.quote));

  for (const [k, quote] of fresh) {
    const turns = pending.msgs.filter((p) => p.to._tag === "new" && p.to.key === k).map(waiting);

    sides.push({ _tag: "side", key: "new:" + k, opener: null, quote, turns, last: ids + 1, unread: false, waits: turns.length > 0 });
  }

  /* Marks: sent ones with the answers that name them and the replies in them, then pending ones. */
  const sent = sentOf(messages, hash);
  /* Sent comments Luiz withdrew: told in a later batch, or waiting to be. */
  const gone = new Set([...messages.flatMap((m) => (m.marks?.at.hash === hash ? (m.marks.withdrawn ?? []) : [])), ...(pending.withdrawn ?? [])]);
  const batches = new Set(sent.marks.map((s) => s.batch));
  const owner = new Map<number, number>();

  /* An answer naming a reply (a `general` item on a comment) belongs to that comment's thread. */
  for (const s of sent.marks) for (const a of s.answers) if (!owner.has(a.id)) owner.set(a.id, s.item.on ?? s.item.n);

  /* Replies in a mark's thread, and the fleet's answers to them, follow the `re` chain back to it. */
  for (const m of messages) {
    if (owner.has(m.id) || m.re === null) continue;
    const lead = m.from === "user" ? LEAD.exec(m.text) : null;
    const n = lead && (batches.has(m.re) || owner.has(m.re)) ? Number(lead[1]) : owner.get(m.re);

    if (n !== undefined && !batches.has(m.id)) owner.set(m.id, n);
  }

  /* Luiz's replies batched in a comment's thread (`general` items on it), sent and waiting. */
  const atOf = (id: number): string => messages.find((m) => m.id === id)?.at ?? "";
  const repliesTo = (n: number): Turn[] => sent.marks.flatMap((r) => (r.item.kind === "general" && r.item.on === n ? [{ id: r.batch, key: `g${String(r.batch)}-${String(r.item.n)}`, mine: true, who: "You", text: r.item.comment ?? "", quote: "", at: atOf(r.batch), keep: "", whole: [] }] : []));
  const waitingTo = (n: number): PendingMsg[] => pending.msgs.filter((p) => p.to._tag === "mark" && p.to.n === n);

  /* The fleet's answers to a whole batch, naming no mark, in the thread of each comment the batch is about (its comments, and the ones its replies are in). */
  const wholeOf = new Map<number, Turn[]>();

  for (const l of sent.loose) {
    const about = [...new Set(sent.marks.flatMap((s) => (s.batch !== l.batch ? [] : s.item.kind !== "general" ? [s.item.n] : s.item.on === undefined ? [] : [s.item.on])))];

    for (const n of about) wholeOf.set(n, [...(wholeOf.get(n) ?? []), ...l.answers.map((m) => ({ ...turn(m), whole: about }))]);
  }

  const marks: Thread[] = sent.marks.flatMap((s): Thread[] => {
    if (s.item.kind === "general") return [];
    const n = s.item.n;
    const key = markKey(n);
    const later = [...repliesTo(n), ...messages.filter((m) => owner.get(m.id) === n).map((m) => turn(m, m.from === "user" ? m.text.replace(LEAD, "") : m.text)), ...(wholeOf.get(n) ?? [])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    const waits = waitingTo(n);
    const turns = [{ id: s.batch, key: "b" + String(s.batch), mine: true, who: "You", text: commentOf(s.item), quote: "", at: atOf(s.batch), keep: "", whole: [] }, ...later, ...waits.map(waiting)];
    /* What was said to this comment alone: the thread's place in the order and its unread dot come from it. */
    const own = turns.filter((t) => t.whole.length === 0);
    /* A reply waiting in the thread makes it pending again, until it goes. */
    const status: MarkStatus = waits.length ? "pending" : s.answers.length ? "answered" : "sent";
    const holds = waits.length > 0 || (pending.withdrawn ?? []).includes(n);

    return [{ _tag: "mark", key, item: s.item, kind: s.item.kind, status, batch: s.batch, turns, last: lastOf(own, holds), unread: unreadOf(key, own), waits: holds, withdrawn: gone.has(n) }];
  });

  for (const item of pending.items) {
    const turns = [{ id: null, key: "d" + String(item.n), mine: true, who: "You", text: commentOf(item), quote: "", at: "", keep: "", whole: [] }];

    marks.push({ _tag: "mark", key: markKey(item.n), item, kind: item.kind, status: "pending", batch: null, turns, last: ids + 1 + item.n, unread: false, waits: true, withdrawn: false });
  }

  const loose: Thread[] = sent.loose.map((l) => {
    const key = "loose:" + String(l.batch);
    const turns = l.answers.map((m) => turn(m));

    return { _tag: "loose", key, batch: l.batch, turns, last: lastOf(turns, false), unread: unreadOf(key, turns), waits: false };
  });

  return { page, threads: [...marks, ...sides, ...loose].sort((a, b) => b.last - a.last) };
}

/** A mark's own words as its thread's first message: the replacement, then the comment. */
export function commentOf(item: MarkItem): string {
  const lines = [item.kind === "replace" && item.replacement ? `Replace with “${item.replacement}”` : "", item.comment ?? ""].filter(Boolean);

  return lines.join("\n") || (item.kind === "delete" ? "Remove these words." : "");
}

/** The comments an answer to a whole batch is about, in words: "comment 2", "comments 1, 2 and 4". */
export const wholeWords = (ns: readonly number[]): string => (ns.length < 2 ? `comment ${ns.join("")}` : `comments ${ns.slice(0, -1).join(", ")} and ${String(ns.at(-1))}`);

/** The newest fleet message of each thread, to mark it read once it is open. */
export const newestFleet = (t: Thread): number => Math.max(0, ...t.turns.filter((x) => !x.mine && x.id !== null).map((x) => x.id ?? 0));

/** The number of threads with an answer Luiz has not read. */
export const unreadCount = (box: Inbox): number => [box.page, ...box.threads].filter((t) => t.unread).length;

/** A thread's last line, as the list shows it: who said it, and what. */
export function lastLine(t: Thread): { readonly who: string; readonly text: string; readonly waits: boolean } | null {
  const x = t.turns.at(-1);

  return x ? { who: x.who, text: oneLine(x.text) || (x.quote ? "“" + x.quote + "”" : ""), waits: x.id === null } : null;
}

/**
 * Whether a thread's work is done: a mark answered or withdrawn, the fleet's answers to a batch, or a side chat resolved
 * (nothing waits in it and the fleet spoke last, answering Luiz's last message). The page's main thread
 * never is.
 */
export function isDone(t: Thread): boolean {
  switch (t._tag) {
    case "page":
      return false;
    case "mark":
      return t.status === "answered" || t.withdrawn;
    case "loose":
      return true;
    case "side": {
      const last = t.turns.at(-1);

      return !t.waits && last !== undefined && !last.mine;
    }
  }
}

/** The inbox's threads as it lists them: open ones, and the ones folded apart. */
export interface Split {
  readonly open: readonly Thread[];
  readonly done: readonly Thread[];
}

/** The inbox's threads, with done ones apart when Luiz hides them (`hide`), and withdrawn comments apart always, as history: the rest in order, then those, in order. */
export function splitDone(threads: readonly Thread[], hide: boolean): Split {
  const apart = (t: Thread): boolean => (t._tag === "mark" && t.withdrawn) || (hide && isDone(t));

  return { open: threads.filter((t) => !apart(t)), done: threads.filter(apart) };
}
