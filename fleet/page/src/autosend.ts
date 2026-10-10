/**
 * When the comments Luiz leaves on a decision's page go out, with no DOM (SPEC "Marks on a decision", the
 * page): a saved comment waits as pending, kept per viewer in the browser under the decision's drafts key,
 * and everything pending goes out together on whichever comes first: leaving the page, answering the
 * decision (the batch rides along with the answer), or a quiet period (QUIET_MS) after the last save or edit, which a
 * new or edited comment restarts and editing one pauses. Send now bypasses the wait.
 *
 * One send is one batch of marks for the decision (one chat message, addressed by the hub to the decision's
 * owner and whoever its comments @-cite), then one message per conversation of the page with words waiting
 * (its main thread, a side chat), back to back. Only Luiz's own input drives this: what the decision's frame
 * posts never saves, sends, restarts or pauses anything; the caller feeds only his events.
 */
import { Core, type Json, type JsonRecord, type MarkBatch, type MarkDecision, type MarkItem, type Quote, type QuoteAt, type RosterRow } from "./core.ts";
import { makeBatch, type Batch, type DraftStore } from "./marks.ts";

/** How long pending comments wait after the last save or edit before they go by themselves: 3 minutes. */
export const QUIET_MS = 180_000;

/** The quiet period as the page says it: `3 min`. */
export const QUIET_WORDS = `${String(Math.round(QUIET_MS / 60_000))} min`;

/** The most a page-exit send hands the browser as `keepalive` requests, all together (it allows 64 KB in flight). */
export const KEEPALIVE_MAX = 60 * 1024;

/** What sent the pending comments. */
export type SendReason = "leave" | "answer" | "quiet" | "now";

/** Each reason, as the hover card and the toast say it. */
export const REASON_WORDS = { leave: "you left the page", answer: "with your answer", quiet: `after ${QUIET_WORDS} quiet`, now: "Send now" } as const satisfies { readonly [K in SendReason]: string };

/* ------------------------------------------------------------------ the timer */

/** The auto-send timer: idle with nothing pending, running to a deadline, or paused (a comment being written or edited) with the time it had left. */
export type Timer = { readonly _tag: "idle" } | { readonly _tag: "running"; readonly deadline: number } | { readonly _tag: "paused"; readonly left: number };

/** Nothing pending, nothing timed. */
export const IDLE: Timer = { _tag: "idle" };

/** The whole quiet period, running from `now`. */
export const running = (now: number): Timer => ({ _tag: "running", deadline: now + QUIET_MS });

/** The whole quiet period, held (a comment is being written or edited). */
export const held: Timer = { _tag: "paused", left: QUIET_MS };

/** Writing or editing a comment began at `now`: a running timer holds what it had left. */
export const pause = (t: Timer, now: number): Timer => (t._tag === "running" ? { _tag: "paused", left: Math.max(0, t.deadline - now) } : t);

/** Writing or editing ended at `now`: a held timer runs on from what it had left. */
export const resume = (t: Timer, now: number): Timer => (t._tag === "paused" ? { _tag: "running", deadline: now + t.left } : t);

/** How long until the timer sends, in ms; null when idle. */
export function leftOf(t: Timer, now: number): number | null {
  switch (t._tag) {
    case "idle":
      return null;
    case "running":
      return Math.max(0, t.deadline - now);
    case "paused":
      return t.left;
  }
}

/** Whether the quiet period is over at `now` (a held timer never is). */
export const due = (t: Timer, now: number): boolean => t._tag === "running" && now >= t.deadline;

/** The time left as the card says it: `6:58`. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));

  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
}

/** What Luiz did on the page that the timer hears. Never anything the decision's frame posts. */
export type AutoEvent =
  | { readonly _tag: "saved" }
  | { readonly _tag: "reset" }
  | { readonly _tag: "editStart" }
  | { readonly _tag: "editEnd" }
  | { readonly _tag: "tick" }
  | { readonly _tag: "send"; readonly reason: Exclude<SendReason, "quiet"> }
  | { readonly _tag: "failed" };

/** The timer with what it knows: whether a comment is being written or edited, and how many things wait. */
export interface Auto {
  readonly timer: Timer;
  readonly editing: boolean;
  readonly pending: number;
}

/** The auto-send after an event, and the send it asks for (null: none). */
export interface Stepped {
  readonly auto: Auto;
  readonly send: SendReason | null;
}

/**
 * The auto-send's next state on `e` at `now`, and the send it asks for (null: none). A save restarts the
 * quiet period, and so does Luiz's own reset (a press held on the paper plane); editing holds it; a tick past it sends ("quiet"); leaving, answering and Send now send at
 * once; a send that failed starts the period again, so it is tried later, the comments kept. Nothing
 * pending: idle, and nothing to send.
 */
export function autoStep(a: Auto, e: AutoEvent, now: number): Stepped {
  const editing = e._tag === "editStart" ? true : e._tag === "editEnd" ? false : a.editing;

  if (a.pending <= 0) return { auto: { ...a, timer: IDLE, editing }, send: null };

  switch (e._tag) {
    case "saved":
    case "reset":
    case "failed":
      return { auto: { ...a, timer: a.editing ? held : running(now) }, send: null };
    case "editStart":
      return { auto: { ...a, editing, timer: a.timer._tag === "idle" ? held : pause(a.timer, now) }, send: null };
    case "editEnd":
      return { auto: { ...a, editing, timer: a.timer._tag === "idle" ? running(now) : resume(a.timer, now) }, send: null };

    case "tick":
      return due(a.timer, now) ? { auto: { ...a, timer: IDLE }, send: "quiet" } : { auto: a, send: null };
    case "send":
      return { auto: { ...a, timer: IDLE }, send: e.reason };
  }
}

/* ------------------------------------------------------------------ what waits */

/** Where a pending message goes: the page's main thread, a side chat of the page (its opener's id), or a side chat it starts on quoted words. */
export type ThreadRef = { readonly _tag: "page" } | { readonly _tag: "mark"; readonly n: number } | { readonly _tag: "side"; readonly id: number } | { readonly _tag: "new"; readonly key: string; readonly quote: Quote };

/** A message saved in one of the page's conversations, waiting to go with the rest; `quote`, words it quotes (a Reply). */
export interface PendingMsg {
  readonly key: string;
  readonly to: ThreadRef;
  readonly text: string;
  readonly quote?: Quote;
}

/** Everything waiting to be sent from a decision's page: its marks (the batch's items) and the messages of its conversations. */
export interface Pending {
  readonly items: readonly MarkItem[];
  readonly msgs: readonly PendingMsg[];
  /** Sent comments Luiz withdrew (their numbers): the next batch to the owner tells it. */
  readonly withdrawn?: readonly number[];
  /** Cited agents' batches still owed once the owner's was stored: each kept until it is stored, tried again on the next send. */
  readonly owed?: readonly OwedBatch[];
}

/** A cited agent's batch, owed: its key, its Markdown and its marks, as it will be posted. */
export interface OwedBatch {
  readonly key: string;
  readonly text: string;
  readonly marks: MarkBatch;
}

/** Nothing waits. */
export const NONE: Pending = { items: [], msgs: [] };

/** How many things wait: each mark and each message. */
export const countOf = (p: Pending): number => p.items.length + p.msgs.length + (p.withdrawn?.length ?? 0) + (p.owed?.length ?? 0);

const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

const isText = (v: Json | undefined): v is string => v === String(v);

/** A quote as kept: its text and place, typed; null for anything else. */
function parseQuote(v: Json | undefined): Quote | null {
  if (!isRecord(v) || !isText(v["text"]) || !v["text"].trim()) return null;
  const at: QuoteAt | null = Core.parseQuoteAt(v["at"]);
  const q: Quote = { text: v["text"], from: isText(v["from"]) ? v["from"] : "" };

  return at ? { ...q, at } : q;
}

function parseRef(v: Json | undefined): ThreadRef | null {
  if (!isRecord(v)) return null;

  if (v["_tag"] === "page") return { _tag: "page" };

  if (v["_tag"] === "mark" && Number.isInteger(v["n"]) && Number(v["n"]) > 0) return { _tag: "mark", n: Number(v["n"]) };

  if (v["_tag"] === "side" && Number.isInteger(v["id"]) && Number(v["id"]) > 0) return { _tag: "side", id: Number(v["id"]) };
  const quote = parseQuote(v["quote"]);

  return v["_tag"] === "new" && isText(v["key"]) && v["key"] && quote ? { _tag: "new", key: v["key"], quote } : null;
}

function parseMsg(v: Json | undefined): PendingMsg | null {
  if (!isRecord(v) || !isText(v["key"]) || !isText(v["text"]) || !v["text"].trim()) return null;
  const to = parseRef(v["to"]);
  const quote = parseQuote(v["quote"]);

  if (!to) return null;
  const msg: PendingMsg = { key: v["key"], to, text: v["text"] };

  return quote ? { ...msg, quote } : msg;
}

/**
 * What waits under `key` (the decision's drafts key, `draftsKey`): `{items, msgs}`, or 1.9.33's list of
 * unsent marks (each a pending mark now). Nothing when the storage refuses or holds something else.
 */
export function loadPending(store: DraftStore | null, key: string): Pending {
  try {
    const raw = store?.getItem(key) ?? null;
    const given: Json = raw === null ? null : JSON.parse(raw);
    const items = (v: Json | undefined): MarkItem[] => (Array.isArray(v) ? v.flatMap((i) => Core.parseMarkItem(i) ?? []) : []);

    if (Array.isArray(given)) return { items: items(given), msgs: [] };

    if (!isRecord(given)) return NONE;
    const msgs = given["msgs"];
    const gone = given["withdrawn"];
    const withdrawn = Array.isArray(gone) ? gone.flatMap((n) => (Number.isInteger(n) && Number(n) > 0 ? [Number(n)] : [])) : [];
    const owing = given["owed"];

    const owed = Array.isArray(owing)
      ? owing.flatMap((o): OwedBatch[] => {
          const marks = isRecord(o) ? Core.parseMarks(o["marks"]) : null;

          return isRecord(o) && isText(o["key"]) && isText(o["text"]) && marks ? [{ key: o["key"], text: o["text"], marks }] : [];
        })
      : [];

    const p: Pending = { items: items(given["items"]), msgs: Array.isArray(msgs) ? msgs.flatMap((m) => parseMsg(m) ?? []) : [] };
    const told = withdrawn.length ? { ...p, withdrawn } : p;

    return owed.length ? { ...told, owed } : told;
  } catch {
    return NONE;
  }
}

/** Keep `p` under `key` (nothing waiting: the key removed); false when the storage refuses. */
export function savePending(store: DraftStore | null, key: string, p: Pending): boolean {
  try {
    if (!store) return false;

    if (countOf(p)) store.setItem(key, JSON.stringify(p));
    else store.removeItem(key);

    return true;
  } catch {
    return false;
  }
}

/** `p` without what a send carried: its marks by number, its messages by key. */
export function without(p: Pending, sent: Carried): Pending {
  const rest: Pending = { items: p.items.filter((i) => !sent.items.includes(i.n)), msgs: p.msgs.filter((m) => !sent.msgs.includes(m.key)) };
  const withdrawn = (p.withdrawn ?? []).filter((n) => !(sent.withdrawn ?? []).includes(n));
  const owed = (p.owed ?? []).filter((o) => !(sent.owed ?? []).includes(o.key));
  const told = withdrawn.length ? { ...rest, withdrawn } : rest;

  return owed.length ? { ...told, owed } : told;
}

/** `p` owing these cited batches too (the owner's batch that made them was stored). */
export const owing = (p: Pending, more: readonly OwedBatch[]): Pending => (more.length ? { ...p, owed: [...(p.owed ?? []).filter((o) => !more.some((m) => m.key === o.key)), ...more] } : p);

/* ------------------------------------------------------------------ one send */

/** What one post carries of the pending: its marks' numbers and its messages' keys. */
export interface Carried {
  readonly items: readonly number[];
  readonly msgs: readonly string[];
  /** The withdrawals it tells of. */
  readonly withdrawn?: readonly number[];
  /** The owed cited batches it is (their keys). */
  readonly owed?: readonly string[];
}

/** A chat message as the page posts it: a batch of marks, or words in a side chat (an existing one, or a new one on quoted words). */
export interface ChatPost {
  readonly text: string;
  readonly marks?: MarkBatch;
  readonly side?: number | "new";
  readonly quote?: Quote;
  readonly re?: number;
}

/** One chat message a send posts, and what it carries of the pending (cleared once it is stored). */
export interface Post {
  readonly body: ChatPost;
  readonly carries: Carried;
  /** The cited agents' batches this (the owner's) leaves owed once it is stored, each cleared as it is. */
  readonly owes?: readonly OwedBatch[];
}

/** The decision a send is for, as the page has it: its batch's head, its place, and the opener of its main thread, once there is one. */
export interface SendTarget {
  readonly decision: MarkDecision;
  readonly hash: string;
  /** The id of the page's main thread's first message; null while it has none. */
  readonly page: number | null;
  /** The marks whose words are no longer in the decision's body. */
  readonly outdated: ReadonlySet<number>;
  /** The decision's owner as the hub names it: the page's host on a fleet's page, the fleet on the manager's. */
  readonly owner: string;
  /** The page's host, as the chat names it: citing it cites the owner. */
  readonly host: string;
  /** Who the words can @-cite. */
  readonly roster: readonly RosterRow[];
  /** The number the next item takes (one past every comment sent or waiting): a batched message's. */
  readonly next: number;
  /** The decision's comments by number, sent or waiting: a reply goes to whoever its comment reached. */
  readonly known: ReadonlyMap<number, MarkItem>;
}

/** The quote that opens a decision page's main thread (SPEC, API 5): the decision's title on one line, at the page. */
export const pageQuote = (d: MarkDecision, hash: string): Quote => ({ text: (d.ref ? d.ref + " " : "") + d.title.replace(/\s+/gu, " ").trim() || d.id, from: "this decision's page", at: { hash, anchor: "dv-page" } });

/** A message's words with the words it quotes before them, as Markdown quote lines. */
const quoting = (m: PendingMsg): string => (m.quote ? m.quote.text.split("\n").map((l) => "> " + l.replace(/\s+/gu, " ").trim()).join("\n") + "\n\n" + m.text : m.text);

/** The key of the conversation a pending message goes to. */
export function refKey(r: ThreadRef): string {
  switch (r._tag) {
    case "page":
      return "page";
    case "mark":
      return "m:" + String(r.n);
    case "side":
      return "side:" + String(r.id);
    case "new":
      return "new:" + r.key;
  }
}

/** Whether a pending message goes in the batch (the page's thread, a comment's thread), not a side chat's own post. */
export const batched = (m: PendingMsg): boolean => m.to._tag === "page" || m.to._tag === "mark";

/** The pending marks as the decision's one batch: its Markdown (each comment's @-cites in it, so the hub addresses them) and its structured marks. */
export const batchOf = (items: readonly MarkItem[], t: SendTarget): Batch => makeBatch(t.decision, t.hash, items.map((item) => ({ item, outdated: t.outdated.has(item.n) })));

/** The agents a mark's words @-cite besides the decision's owner, as the hub names them, in the order cited. */
export const citedBy = (item: MarkItem, t: Pick<SendTarget, "owner" | "host" | "roster">): string[] =>
  citesOf([item.comment ?? "", item.replacement ?? ""].join("\n"), t.roster).flatMap((r) => (r.id === t.host || r.id === t.owner ? [] : [r.id]));

/** One batch per agent a send reaches: the owner's with every mark, then each cited agent's with the marks that cite it, each in page order. */
export function groupsOf(items: readonly MarkItem[], t: Pick<SendTarget, "owner" | "host" | "roster"> & { readonly known?: ReadonlyMap<number, MarkItem> }): { readonly to: string; readonly items: readonly MarkItem[] }[] {
  if (!items.length) return [];
  const ordered = [...items].sort((a, b) => a.n - b.n);
  const cited = new Map<string, MarkItem[]>();

  /* A reply (a `general` item `on` a comment) reaches whoever its comment reached. */
  const reach = (item: MarkItem): string[] => {
    const of = item.on === undefined ? item : t.known?.get(item.on);

    return of ? citedBy(of, t) : [];
  };

  for (const item of ordered) for (const id of reach(item)) cited.set(id, [...(cited.get(id) ?? []), item]);

  return [{ to: t.owner, items: ordered }, ...[...cited].map(([to, list]) => ({ to, items: list }))];
}

/**
 * The posts that send `p`: one batch per agent its marks reach (`marks.to`): the owner's first, with every
 * mark, in the page's main thread once it has one (else it opens it); then each cited agent's; then one
 * message per conversation with words waiting, its messages joined in order: in the page's main thread (its first message opens it,
 * quoting the decision at the page), a side chat, or a new side chat on its quoted words.
 */
export function planSend(p: Pending, t: SendTarget): Post[] {
  const posts: Post[] = [];
  const withdrawn = p.withdrawn ?? [];

  /* Every message batches: one in the page's thread is a `general` item, a reply in comment n's thread a `general` item `on` n; numbered from `next`. */
  const inBatch = p.msgs.filter(batched);

  const generals = inBatch.map((m, i): MarkItem => {
    const item: MarkItem = { n: t.next + i, kind: "general", comment: quoting(m) };

    return m.to._tag === "mark" ? { ...item, on: m.to.n } : item;
  });

  /* Cited batches owed from a send that stored the owner's but not them: first, each cleared once stored. */
  for (const o of p.owed ?? []) posts.push({ body: { text: o.text, marks: o.marks }, carries: { items: [], msgs: [], owed: [o.key] } });

  const items = [...p.items, ...generals];
  const groups = groupsOf(items, t);

  const all = (groups.length || !withdrawn.length ? groups : [{ to: t.owner, items: [] }]).map((group, i) => {
    const b = makeBatch(t.decision, t.hash, group.items.map((item) => ({ item, outdated: t.outdated.has(item.n) })), i === 0 ? withdrawn : [], (n) => t.known.get(n)?.quote?.text ?? "");

    return { text: b.text, marks: { ...b.marks, to: group.to }, key: `${String(t.next)}:${group.to}` };
  });

  const [owner, ...cited] = all;

  /* The owner's batch holds every comment, message and withdrawal, joins the page's thread and, once stored, clears them and leaves the cited agents' batches owed; each of those is cleared once it is stored. */
  if (owner) {
    const own = { items: p.items.map((x) => x.n).sort((x, y) => x - y), msgs: inBatch.map((m) => m.key) };
    const carries = withdrawn.length ? { ...own, withdrawn } : own;
    const body = t.page === null ? { text: owner.text, marks: owner.marks } : { text: owner.text, marks: owner.marks, side: t.page };
    posts.push(cited.length ? { body, carries, owes: cited } : { body, carries });
  }

  for (const c of cited) posts.push({ body: { text: c.text, marks: c.marks }, carries: { items: [], msgs: [], owed: [c.key] } });

  /* A side chat's words keep their own thread: one post each, after the batches. */
  const order: string[] = [];
  const by = new Map<string, PendingMsg[]>();

  for (const m of p.msgs) {
    if (batched(m)) continue;
    const k = refKey(m.to);
    const list = by.get(k);

    if (list) list.push(m);
    else {
      by.set(k, [m]);
      order.push(k);
    }
  }

  for (const k of order) {
    const list = by.get(k) ?? [];
    const to = list[0]?.to;
    const text = list.map(quoting).join("\n\n");
    const carries = { items: [], msgs: list.map((m) => m.key) };

    if (to?._tag === "side") posts.push({ body: { text, side: to.id }, carries });
    else if (to?._tag === "new") posts.push({ body: { text, side: "new", quote: { ...to.quote } }, carries });
  }

  return posts;
}

/**
 * The answer's post with the decision's pending marks riding along (SPEC, API 2): `batch` holds the batch's
 * text and marks, and the hub stores it and the answer in one write, the batch first. `answer` is the
 * answer's fields as the form built them.
 */
export function answerBody<A extends object>(answer: A, decision: string, ride: Post | null): A & { readonly decision: string; readonly batch?: { readonly text: string; readonly marks: MarkBatch | null; readonly side?: number } } {
  const side = ride?.body.side;

  if (!ride) return { ...answer, decision };

  return Number.isInteger(side) ? { ...answer, decision, batch: { text: ride.body.text, marks: ride.body.marks ?? null, side: Number(side) } } : { ...answer, decision, batch: { text: ride.body.text, marks: ride.body.marks ?? null } };
}

/** How a post leaves a page that is going away: its body, and whether the browser keeps it alive past the page (keepalive) or it is a plain fetch. */
export interface ExitPost {
  readonly post: Post;
  readonly json: string;
  readonly keepalive: boolean;
}

/** UTF-8 bytes of `s`. */
const bytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * The posts a page leaving sends (SPEC, API 3): each as `keepalive` while all of them so far stay within
 * KEEPALIVE_MAX, the rest as plain fetches (the page is still alive on `visibilitychange`). A keepalive one
 * is cleared from the pending once dispatched; a plain one only once it is stored.
 */
export function exitPosts(posts: readonly Post[]): ExitPost[] {
  let used = 0;

  return posts.map((post) => {
    const json = JSON.stringify(post.body);
    const size = bytes(json);
    const keepalive = used + size <= KEEPALIVE_MAX;

    if (keepalive) used += size;

    return { post, json, keepalive };
  });
}

/* ------------------------------------------------------------------ who gets it */

/** The people `text` @-cites, as the roster names them: each `@name` or `@id` that is someone on it. */
export function citesOf(text: string, roster: readonly RosterRow[]): RosterRow[] {
  const out: RosterRow[] = [];

  for (const m of text.matchAll(/(?:^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]+)/gu)) {
    const word = (m[1] ?? "").replace(/[.-]+$/u, "").toLowerCase();
    const who = roster.find((r) => r.id.toLowerCase() === word || r.name.toLowerCase() === word);

    if (who && !out.includes(who)) out.push(who);
  }

  return out;
}

/**
 * How many comments go to each agent a send reaches: the owner (every mark and message), then each one the
 * words @-cite, by the hub's names, in the order first cited.
 */
export function perRecipient(p: Pending, t: Pick<SendTarget, "owner" | "host" | "roster">): { readonly to: string; readonly n: number }[] {
  const out = new Map<string, number>([[t.owner, countOf(p)]]);

  const cite = (words: string): void => {
    for (const r of citesOf(words, t.roster)) if (r.id !== t.host && r.id !== t.owner) out.set(r.id, (out.get(r.id) ?? 0) + 1);
  };

  for (const i of p.items) cite([i.comment ?? "", i.replacement ?? ""].join("\n"));

  for (const m of p.msgs) cite(m.text);

  return [...out].map(([to, n]) => ({ to, n }));
}

/** A send as the card's last line and the toast say it, one part per agent it reached: `Sent: 4 to perf, 2 to skills (you left the page).` */
export function sentWords(parts: readonly string[], reason: SendReason): string {
  const what = `Sent: ${parts.join(", ")}`;

  return reason === "now" ? what + "." : `${what} (${REASON_WORDS[reason]}).`;
}
