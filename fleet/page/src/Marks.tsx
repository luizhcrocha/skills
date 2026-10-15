/**
 * Comments on the decision shown (SPEC "Marks on a decision", the page): the selection bar's Comment,
 * Delete, Replace and Question open a composer for the words selected in the body; each saved mark is a
 * thread of the page's inbox, pending (its pin amber) until it is sent, with the page's main thread (a side
 * chat held with the decision's owner) on top and a thread per side chat on the decision's words. The
 * rail's inbox button opens the inbox (a dot for unread answers); its paper plane, badged with the pending
 * count and ringed by the countdown, sends everything pending now, and its hover card (a long-press on a phone) says what waits, for
 * whom, when it goes by itself, and the last send. Pending things go by themselves (autosend.ts): on leaving
 * the page, with the answer to the decision, or a quiet period after the last save or edit (QUIET_MS).
 *
 * It lives on the top page: on a fleet's page beside its own evidence frame, on the manager's page after
 * a fleet's decision (that fleet's page in a frame, which relays the messages to the body's frame inside
 * it). The frame runs the body's own scripts, so what it posts is a claim, never a command: a selection is
 * confirmed against the body as this page parsed it (bodytext.ts) before it becomes a quote, where each
 * mark is now is found in that same text, and only the user's own input on this page saves, sends,
 * restarts or pauses anything. Esc closes the topmost layer, one per press (a menu, the composer, the
 * inbox, then the selection bar). Cmd+Enter on a Mac, Ctrl+Enter elsewhere, saves what a box holds (in a
 * thread already sent, sends it); with Shift it sends it now, and anywhere on the page outside a box it
 * sends everything pending now. Keys pressed inside the frame do none of it (Esc there closes the selection
 * bar only).
 */
import { createEffect, createMemo, createSignal, flush, onCleanup, onSettled } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { autoStep, clock, countOf, exitPosts, IDLE, leftOf, loadPending, perRecipient, planSend, QUIET_MS, QUIET_WORDS, REASON_WORDS, batched, owing, refKey, savePending, sentWords, without, type Auto, type AutoEvent, type ChatPost, type Pending, type PendingMsg, type Post, type SendReason, type SendTarget, type ThreadRef } from "./autosend.ts";
import { listen, tf, usePage, When } from "./bits.tsx";
import { readBody } from "./bodytext.ts";
import { CaretList } from "./CaretList.tsx";
import { Core, type Json, type JsonRecord, type MarkDecision, type MarkItem, type MarkKind, type MarkQuote, type Quote } from "./core.ts";
import { chatHeaders } from "./chat-headers.ts";
import { parseEmbedMessage, parseEvidenceSelect, parseFrameSaid, realTap } from "./embed.ts";
import { inboxOf, lastLine, newestFleet, splitDone, unreadCount, wholeWords, type Thread, type Turn } from "./inbox.ts";
import { KIND_WORDS, nextNumber, placeMark, QUOTED_KINDS, quoteLines, sentOf, type Claimed, type DraftStore } from "./marks.ts";
import { plural } from "./format.ts";
import { BatchCard, inboxOpener, inboxRequest } from "./BatchCard.tsx";
import { fieldDelete, fieldTap, setFieldPaints, type FieldPaint } from "./FieldMarks.tsx";
import { fieldQuote, type FieldClaim } from "./fields.ts";
import { outbox } from "./outbox.ts";
import { Rich } from "./Rich.tsx";

/** Where a decision's marks go, and the frame they are painted in. */
export interface MarkTarget {
  /** The browser storage key of what waits to be sent (`draftsKey`). */
  readonly key: string;
  /** Its place on this page, as a batch's `at` names it. */
  readonly hash: string;
  /** The fleet that owns it, as the inbox names it. */
  readonly fleet: string;
  /** The decision as the page has it now; null while it is not known. */
  readonly decision: () => MarkDecision | null;
  /** Whether it has been answered (it no longer waits on Luiz), null while it is not known: when it turns answered, what waits goes. */
  readonly answered: () => boolean | null;
  /** The frame its body's messages come from and go to: the evidence frame, or on the manager's page the fleet's frame. */
  readonly frame: () => HTMLIFrameElement | null;
  /** The whole document the body's frame was given (its srcdoc), which the page reads itself; null while it is not known. */
  readonly body: () => string | null;
  /** Whether marks may be made here (a decision or a grilling the ledger holds, not a notice). */
  readonly allowed: () => boolean;
  /** Whether `frame` is a fleet's page on the manager's (same origin, relaying), not the sandboxed body frame (origin "null"). */
  readonly relayed: boolean;
  /** Whether `e` is `frame` speaking: the body's frame from the document the page gave it (its token), or the fleet's page relaying. */
  readonly speaks: (e: MessageEvent<Json>) => boolean;
}

/** What the selection bar and the answer's form ask of the marks on the decision shown. */
export interface MarkDesk {
  /** Whether the bar offers the kinds of mark: the body's frame answered and the chat can be written. */
  readonly on: () => boolean;
  /** Start a mark of `kind` on the selection: asked of the frame as it is now, else `claim`, the one the bar has; confirmed against the body either way. */
  readonly begin: (kind: MarkKind, claim: readonly Claimed[]) => void;
  /** Whether a layer over the bar is open (a menu, the composer, the inbox): Esc is theirs first. */
  readonly layered: () => boolean;
  /** Whether the marks acted on `e` (an Esc they took), so the bar leaves it. */
  readonly took: (e: Event) => boolean;
  /** Whether words of the fields the dashboard draws can be marked: the decision takes comments, and the chat can be written. */
  readonly fieldsOn: () => boolean;
  /** Start a mark of `kind` on words of such a field (Luiz's own selection on this page, or the fleet's page framed on the manager's). */
  readonly beginField: (kind: MarkKind, claim: FieldClaim) => void;
  /** Reply on words of the body: the page's main thread, the words quoted in its box. */
  readonly reply: (quote: Quote) => void;
  /** Side chat on words of the body: a new thread of the inbox on them. */
  readonly side: (quote: Quote) => void;
  /** The answer to decision `id` is about to be posted: the batch of its pending marks to ride along (null: none), held until `rode`. */
  readonly ride: (id: string) => Post | null;
  /** The answer was posted (`stored`, the hub's answer to it; null when refused or unreachable): the batch is cleared once stored, and the conversations' pending messages go after it. */
  readonly rode: (ride: Post | null, stored: Json | null) => void;
}

/** Where the selection bar finds the marks of the decision shown, while its inbox is on the page. */
export interface MarkDeskSlot {
  current: MarkDesk | null;
}

/** The marks of the decision shown, while their inbox is on the page; the selection bar and the answer's form read it. */
export const markDesk: MarkDeskSlot = { current: null };

/** The modifier key of the platform, as a hint on a button. */
const MAC = /Mac|iPhone|iPad/u.test(globalThis.navigator?.platform ?? "");

const KEY_SAVE = MAC ? "⌘↵" : "Ctrl+↵";

const KEY_NOW = MAC ? "⌘⇧↵" : "Ctrl+Shift+↵";

/** How long a tapped kind waits for the frame's selection as it is now before taking the bar's. */
const NOW_MS = 400;

/** How long the frame's selection, as it last told the page, stands for the selection it answers with now. */
const TOLD_MS = 10_000;

/** How long a send's toast stays. */
const TOAST_MS = 2200;

/** How long a deletion's toast offers Undo. */
const UNDO_MS = 5000;

/** How long a press held on the paper plane takes to reset the auto-send's countdown (and show its card). */
const HOLD_MS = 600;

/** A press on the plane released sooner than this is a tap (Send now); later, and before HOLD_MS, it is a hold let go: nothing. */
const TAP_MS = 250;

/** A selection's words with what the frame and the browser may differ on left out: spacing, case (a text-transform), soft hyphens and zero-width characters. */
const squash = (s: string): string => s.replace(/[\s­​-‍⁠﻿]+/gu, "").toLowerCase();

const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

/** What the composer says of a selection the body's text does not confirm. */
const UNCONFIRMED = "Could not confirm this selection in the decision's text. Select the words again.";

/** The mark the composer is open on: a new one (`n` null) or a pending one, its kind as picked. */
interface Editing {
  readonly n: number | null;
  readonly kind: MarkKind;
  readonly quote: MarkQuote | null;
  readonly comment: string;
  readonly replacement: string;
}

/** The last send, as the hover card says it. */
interface LastSend {
  readonly at: string;
  readonly text: string;
}

/** The label over the composer's text, by kind. */
const TEXT_LABEL = { comment: "Comment", delete: "Why remove it (optional)", replace: "Why (optional)", question: "Your question", general: "About the whole decision" } as const satisfies { readonly [K in MarkKind]: string };

/** The browser's storage, or null where reading it throws. */
function storage(): DraftStore | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** A mark's thread, or null for any other. */
const asMark = (th: Thread): (Thread & { readonly _tag: "mark" }) | null => (th._tag === "mark" ? th : null);

/** A side chat's thread, or null for any other. */
const asSide = (th: Thread): (Thread & { readonly _tag: "side" }) | null => (th._tag === "side" ? th : null);

/** A key for a message or a side chat made on this page. */
const freshKey = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** An icon of the rail and the inbox (lucide's shapes). */
function Icon(props: { readonly d: readonly string[]; readonly size?: number }): JSX.Element {
  return (
    <svg class="i" viewBox="0 0 24 24" width={props.size ?? 20} height={props.size ?? 20} aria-hidden="true" data-plane={props.d === ICON.plane ? "" : undefined}>
      <For each={props.d}>{(d) => <path d={d} />}</For>
    </svg>
  );
}

const ICON = {
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  plane: ["m22 2-7 20-4-9-9-4z", "M22 2 11 13"],
  back: ["m15 18-6-6 6-6"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  chev: ["m6 9 6 6 6-6"],
  up: ["M12 19V5", "m5 12 7-7 7 7"],
  chat: ["M7.9 20A9 9 0 1 0 4 16.1L2 22z"],
  side: ["M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z", "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
} as const;

/** A mark's quote as read: one line per block, cells under their row, a header row in one line. */
function QuoteView(props: { readonly quote: MarkQuote }): JSX.Element {
  const lines = createMemo(() => quoteLines(props.quote.blocks));

  return (
    <Show when={props.quote.blocks.length > 1} fallback={<>{props.quote.text}</>}>
      <For each={lines()}>
        {(line) => {
          switch (line._tag) {
            case "head":
              return (
                <div class="qrow">
                  Header of table “{line.table || "untitled"}”: <span class="qhd">{line.cells.join(" | ")}</span>
                </div>
              );
            case "row":
              return <div class="qrow">Row ‘{line.label}’</div>;
            case "cell":
              return (
                <div class="qcell">
                  <span class="qh">{line.column}:</span> {line.text}
                </div>
              );
            case "text":
              return <div class="qline">{line.text}</div>;
          }
        }}
      </For>
    </Show>
  );
}

/** The split button: the primary (`main`, with its key) and, behind its chevron, Send now (this one alone, at once). */
function Split(props: { readonly id: string; readonly main: string; readonly open: boolean; readonly onMain: () => void; readonly onNow: () => void; readonly onMenu: () => void }): JSX.Element {
  return (
    <div class="mk-split">
      <button type="button" class="sp-main" id={props.id + "-save"} title={`${props.main}: goes with the rest (${KEY_SAVE})`} onClick={() => props.onMain()}>
        {props.main} <kbd class="kb">{KEY_SAVE}</kbd>
      </button>
      <button type="button" class="sp-chev" id={props.id + "-chev"} aria-label="More send options" aria-haspopup="menu" aria-expanded={tf(props.open)} onClick={() => props.onMenu()}>
        <Icon d={ICON.chev} size={16} />
      </button>
      <div class="sp-menu" role="menu" hidden={!props.open}>
        <button type="button" role="menuitem" id={props.id + "-sendnow"} onClick={() => props.onNow()}>
          <Icon d={ICON.plane} size={16} />
          <span>
            <b>Send now</b>
            <small>This one alone, at once</small>
          </span>
          <kbd class="kb">{KEY_NOW}</kbd>
        </button>
      </div>
    </div>
  );
}

/** The inbox of the decision's page, its rail, its composer, and when what waits goes. */
export function Marks(props: { readonly target: MarkTarget }): JSX.Element {
  const { m, ui } = usePage();
  const t = props.target;
  const store = storage();
  const [pending, setPending] = createSignal<Pending>(loadPending(store, t.key));
  const [ready, setReady] = createSignal(false);

  /* The body as this page read it from the document it gave the frame: the text marks are found in and selections checked against. */
  const body = createMemo(() => {
    const doc = t.body();

    return doc ? readBody(doc) : null;
  });

  /* Each time the frame is (re)made and ready: a revision's new frame is painted again. */
  const [frameGen, setFrameGen] = createSignal(0);
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const [problem, setProblem] = createSignal("");
  const [open, setOpen] = createSignal(false);
  const [thread, setThread] = createSignal<string | null>(null);
  /* Side chats started on words that have no message yet. */
  const [fresh, setFresh] = createSignal<readonly { readonly key: string; readonly quote: Quote }[]>([]);
  /* Words a Reply quotes into the main thread's box. */
  const [chip, setChip] = createSignal<Quote | null>(null);
  /* The pending message the thread's box is editing. */
  const [editMsg, setEditMsg] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<"composer" | null>(null);
  const [boxError, setBoxError] = createSignal("");
  const [card, setCard] = createSignal(false);
  const [toast, setToast] = createSignal("");
  const [undo, setUndo] = createSignal<(() => void) | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const kept = m.prefs.get<JsonRecord | null>("mk-last:" + t.key, null);
  const [last, setLast] = createSignal<LastSend | null>(kept && kept["at"] === String(kept["at"]) && kept["text"] === String(kept["text"]) ? { at: String(kept["at"]), text: String(kept["text"]) } : null);
  const [read, setRead] = createSignal<{ readonly [key: string]: number }>(m.prefs.get<{ [key: string]: number }>("inbox-read:" + t.hash, {}));
  const base = Number(m.prefs.get("side-read-base", m.read())) || 0;
  const sent = createMemo(() => sentOf(m.messages(), t.hash));
  /* Answered work hidden (per viewer, the 1.9.33 keep/clear choice): its highlights and pins leave the page, its threads fold away. */
  const [hideDone, setHideDoneSignal] = createSignal(m.prefs.get("marks-answered", "keep") === "clear");

  const setHideDone = (on: boolean): void => {
    setHideDoneSignal(on);
    m.prefs.set("marks-answered", on ? "clear" : "keep");
  };

  /* The inbox shows wherever marks may be made; the bar's kinds need the frame ready. */
  const listed = (): boolean => t.allowed() && m.chatWritable();
  const on = (): boolean => ready() && body() !== null && listed();
  const hostName = (): string => Core.hostOf(m.state);
  /* The decision's owner as the hub names it: this page's host, or on the manager's page the fleet whose decision it is. */
  const ownerName = (): string => (t.relayed ? t.fleet : hostName());
  let composerBox: HTMLDivElement | undefined;
  let textBox: HTMLTextAreaElement | undefined;
  let withBox: HTMLTextAreaElement | undefined;
  let boxEl: HTMLTextAreaElement | undefined;
  let inboxButton: HTMLButtonElement | undefined;
  let composerOpener: Element | null = null;
  let panelOpener: Element | null = null;
  let waitingKind: { readonly kind: MarkKind; readonly claim: readonly Claimed[]; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let longPress: ReturnType<typeof setTimeout> | undefined;
  /* A hold on the plane completed: the click its release makes sends nothing. */
  let longFired = false;
  /* The plane held: the ring refills while it is; `done`, the reset it made (a pulse, the card says so). */
  const [holding, setHolding] = createSignal(false);
  const [resetAt, setResetAt] = createSignal(0);
  /* A send in flight (or an answer carrying the batch): nothing else sends until it is over. */
  let busy = false;
  /* The lock is the answer's, carrying the batch along (ride, until rode). */
  let riding = false;
  /* The cited agents' batches of the plan the answer's batch came from, to post after it. */
  let ridePlan: Post[] = [];
  let alive = true;
  let hiddenToast = "";
  const boxDrafts = new Map<string, string>();
  const took = new WeakSet<Event>();
  const composerCaret = ui.carets.make({ id: "mk-mentions", option: "mk-mention-", mentions: true });
  const boxCaret = ui.carets.make({ id: "mk-box-mentions", option: "mk-box-mention-", mentions: true });

  /* What waits, kept and read back at once: two events in one task (hidden, then pagehide) see the first's send. */
  const keep = (p: Pending): void => {
    setPending(p);
    savePending(store, t.key, p);
    flush();
  };

  const count = (): number => countOf(pending());

  /* ------------------------------------------------------------------ the timer: only Luiz's own input moves it */

  let auto: Auto = { timer: IDLE, editing: false, pending: count() };
  const [timer, setTimer] = createSignal(auto.timer);

  const step = (e: AutoEvent): SendReason | null => {
    const out = autoStep({ ...auto, pending: count() }, e, Date.now());
    auto = out.auto;
    setTimer(auto.timer);

    return out.send;
  };

  /* Pending things kept from before: the quiet period starts on load. */
  if (count()) step({ _tag: "saved" });

  /* ------------------------------------------------------------------ the inbox */

  const box = createMemo(() =>
    inboxOf({
      messages: m.messages(),
      hash: t.hash,
      pending: pending(),
      host: hostName(),
      owner: t.fleet,
      read: read(),
      base,
      fresh: fresh().map((f) => ({ key: f.key, quote: f.quote.text })),
    }),
  );

  const current = (): Thread | null => {
    const k = thread();

    return k === null ? null : k === "page" ? box().page : (box().threads.find((x) => x.key === k) ?? null);
  };

  const unread = (): number => unreadCount(box());

  /* Where each mark's words are in the body now, found in the page's own reading of it (the frame paints them, and is not asked). */
  const placed = createMemo((): ReadonlyMap<number, string> => {
    const b = body();
    const out = new Map<number, string>();

    if (!b) return out;

    for (const th of box().threads) if (th._tag === "mark" && th.item.quote && th.item.quote.field === undefined) out.set(th.item.n, placeMark(th.item.quote.blocks, b.text).status);

    return out;
  });

  const outdated = (): ReadonlySet<number> => new Set([...placed()].flatMap(([n, s]) => (s === "outdated" ? [n] : [])));

  const post = (data: Json): void => {
    t.frame()?.contentWindow?.postMessage(data, "*");
  };

  /* The marks painted in the body, each with its pin: pending amber, sent grey, answered green, a dot when unread; the one open outlined. */
  const paint = createMemo(() => {
    const active = open() ? thread() : null;
    const editingN = editing()?.n ?? null;

    return JSON.stringify(
      box().threads.flatMap((th) =>
        th._tag === "mark" && th.item.quote && th.item.quote.field === undefined && !th.withdrawn && !(hideDone() && th.status === "answered")
          ? [{ id: th.key, n: th.item.n, kind: th.item.kind, blocks: th.item.quote.blocks.map((b) => ({ exact: b.exact, prefix: b.prefix, suffix: b.suffix })), done: th.status === "answered", active: active === th.key || editingN === th.item.n, show: true, status: th.status, unread: th.unread }]
          : [],
      ),
    );
  });

  /* The marks on the fields the dashboard draws (its title, an option, a manual step…), painted in the page's own DOM: here, or in the fleet's page framed on the manager's. */
  const fieldList = createMemo((): FieldPaint[] => {
    const active = open() ? thread() : null;
    const editingN = editing()?.n ?? null;

    return box().threads.flatMap((th) => {
      const field = th._tag === "mark" ? th.item.quote?.field : undefined;

      return th._tag === "mark" && th.item.quote && field !== undefined && !th.withdrawn && !(hideDone() && th.status === "answered")
        ? [{ id: th.key, n: th.item.n, field, kind: th.item.kind, blocks: th.item.quote.blocks.map((b) => ({ exact: b.exact, prefix: b.prefix, suffix: b.suffix })), status: th.status, unread: th.unread, active: active === th.key || editingN === th.item.n }]
        : [];
    });
  });

  const postFields = (): void => {
    if (t.relayed) post({ annotFields: true, marks: fieldList().map((p) => ({ ...p, blocks: p.blocks.map((b) => ({ ...b })) })) });
    else setFieldPaints(fieldList());
  };

  createEffect(fieldList, postFields);

  /* A pin of a field on this page is the page's own: a tap on it opens its thread, its long-press, context menu or Delete key deletes it. */
  if (!t.relayed) {
    fieldTap.current = (id) => box().threads.some((th) => th.key === id) && openInbox(id);
    fieldDelete.current = (id) => deleteMark(id);
  }

  /* Painted again only when what shows changed, or the frame was made again: a repaint moves the frame's selection, and tells of it again. */
  createEffect(
    () => ({ marks: paint(), ready: ready(), gen: frameGen() }),
    (s, was) => {
      if (!s.ready || (was && was.ready && was.marks === s.marks && was.gen === s.gen)) return;
      post({ annotPaint: true, marks: JSON.parse(s.marks) });
    },
  );

  /* A thread open in the inbox is read up to its newest answer. */
  createEffect(
    () => {
      const th = open() ? current() : null;

      return th ? { key: th.key, top: newestFleet(th) } : null;
    },
    (x) => {
      if (!x || x.top <= (read()[x.key] ?? base)) return;
      const next = { ...read(), [x.key]: x.top };
      setRead(next);
      m.prefs.set("inbox-read:" + t.hash, next);
    },
  );

  const opener = (): Element | null => (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);

  const restore = (el: Element | null): void => {
    if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
  };

  const say = (text: string, undo: (() => void) | null = null): void => {
    setToast(text);
    setUndo(() => undo);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => {
        setToast("");
        setUndo(null);
      },
      undo ? UNDO_MS : TOAST_MS,
    );
  };

  /**
   * Delete comment `key`: a pending one goes outright (it never reaches the agent); a sent one is withdrawn,
   * its highlight and pin off the page, the withdrawal waiting (counted, timed) to ride the next batch to its
   * owner. Undone from the toast within UNDO_MS, while it has not gone.
   */
  const deleteMark = (key: string): void => {
    const th = box().threads.find((x) => x.key === key);

    if (!th || th._tag !== "mark" || th.withdrawn) return;
    const n = th.item.n;

    if (th.status === "pending") {
      const item = th.item;
      keep({ ...pending(), items: pending().items.filter((i) => i.n !== n) });
      keepTimed();

      if (thread() === key) showThread(null);
      say("Comment deleted", () => {
        if (!pending().items.some((i) => i.n === n)) keep({ ...pending(), items: [...pending().items, item] });
        step({ _tag: "saved" });
      });

      return;
    }

    keep({ ...pending(), withdrawn: [...(pending().withdrawn ?? []), n] });
    step({ _tag: "saved" });
    say("Comment withdrawn", () => {
      const left = (pending().withdrawn ?? []).filter((x) => x !== n);
      const p = pending();
      keep(left.length ? { ...p, withdrawn: left } : { items: p.items, msgs: p.msgs });
      keepTimed();
    });
  };

  /* ------------------------------------------------------------------ sending */

  const target = (): SendTarget | null => {
    const d = t.decision();

    const known = new Map([...sent().marks.map((x) => [x.item.n, x.item] as const), ...pending().items.map((i) => [i.n, i] as const)]);

    return d ? { decision: d, hash: t.hash, page: box().page.opener, outdated: outdated(), owner: ownerName(), host: hostName(), roster: m.roster(), next: nextNumber(sent(), pending().items), known } : null;
  };

  const sentNote = (p: Pending, reason: SendReason): void => {
    const text = sentWords(partsOf(p), reason);
    const at = new Date().toISOString();
    setLast({ at, text });
    m.prefs.set("mk-last:" + t.key, { at, text });

    if (!alive) return;

    if (document.visibilityState === "hidden") hiddenToast = text;
    else say(text);
  };

  /* A side chat a post started now has its id: the thread open on it follows. */
  const started = (p: Post, stored: JsonRecord): void => {
    const side = stored["side"];
    const quote = p.body.quote;

    if (p.body.side !== "new" || !Number.isInteger(side) || !quote) return;
    const was = fresh().find((f) => f.quote.text === quote.text);

    if (!was) return;
    setFresh(fresh().filter((f) => f !== was));

    if (thread() === "new:" + was.key) setThread("side:" + String(side));
  };

  /** Post one message; its stored form, or why it was not stored. */
  async function postOne(body: ChatPost): Promise<{ readonly stored: JsonRecord } | { readonly error: string }> {
    const json = JSON.stringify(body);
    const over = Core.tooBig(json, m.maxBytes());

    if (over) return { error: over };

    try {
      const res = await fetch("chat", { method: "POST", headers: chatHeaders(), body: json });
      let data: Json = null;

      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.status !== 201 || !isRecord(data)) {
        const said = isRecord(data) ? data["error"] : undefined;

        return { error: said === String(said) && said ? said : `The server refused it (${String(res.status)}). It is kept.` };
      }

      ui.addMessage(data, true);

      return { stored: data };
    } catch {
      return { error: "Could not reach the dashboard's server. What waits is kept; it goes when the server is back." };
    }
  }

  /** What waits keeps its quiet period: one left idle (a send that could not start, or left some behind) runs again. */
  const keepTimed = (): void => {
    if (count() && timer()._tag === "idle") step({ _tag: "failed" });
    else step({ _tag: "tick" });
  };

  /**
   * Send `p` (all that waits, or one thread's) now, for `reason`: the batch, then each conversation's
   * messages, back to back; each cleared once stored. `carried`, marks an answer already took along, for the note.
   */
  async function sendSet(p: Pending, reason: SendReason, carried = 0): Promise<void> {
    const tg = target();

    if (!tg || busy || !countOf(p)) {
      keepTimed();

      return;
    }

    busy = true;
    let n = 0;
    let error = "";

    try {
      /* The batches first (the owner's, then each cited agent's), then the conversations' messages, planned once the owner's batch is stored: one that opened the page's thread gives them their thread. */
      let page = tg.page;

      const send = async (one: Post): Promise<boolean> => {
        const out = await postOne(one.body);

        if ("error" in out) {
          error = out.error;

          return false;
        }

        /* Stored: what it carried is gone; the owner's leaves the cited agents' batches owed until each is stored. */
        keep(owing(without(pending(), one.carries), one.owes ?? []));
        started(one, out.stored);
        n += one.carries.items.length + one.carries.msgs.length + (one.carries.withdrawn?.length ?? 0);
        const id = out.stored["id"];

        if (page === null && one.body.marks?.to === tg.owner && one.body.side === undefined && Number.isInteger(id)) page = Number(id);

        return true;
      };

      let ok = true;

      /* One plan, numbered once: the batches (the owner's with every comment and line, then each cited agent's), then the side chats' posts. */
      for (const one of planSend(p, tg)) if (ok) ok = await send(one);
    } finally {
      busy = false;
    }

    if (n + carried) sentNote(p, reason);

    if (error) {
      say(error);
      step({ _tag: "failed" });
    }

    keepTimed();
    flush();
  }

  const sendAll = (reason: SendReason): void => {
    if (reason !== "quiet" && step({ _tag: "send", reason }) === null) return;
    void sendSet(pending(), reason);
  };

  /** What waits in thread `key` alone. */
  const pendingOf = (key: string): Pending => {
    const p = pending();
    const n = key.startsWith("m:") ? Number(key.slice(2)) : NaN;

    return { items: p.items.filter((i) => i.n === n), msgs: p.msgs.filter((x) => refKey(x.to) === key) };
  };

  /* The page going away (pagehide, hidden): what waits goes as keepalive posts, cleared once handed to the browser; a post past the budget as a plain one, cleared once stored. */
  const leaveNow = (): void => {
    const tg = target();
    const p = pending();

    if (busy || !tg || !countOf(p)) return;
    const plain: Promise<void>[] = [];

    for (const x of exitPosts(planSend(p, tg))) {
      const req = fetch("chat", { method: "POST", keepalive: x.keepalive, headers: chatHeaders(), body: x.json });

      if (x.keepalive) {
        keep(without(pending(), x.post.carries));
        req.catch(() => undefined);
      } else {
        plain.push(
          req
            .then(async (res) => {
              const data: Json = res.status === 201 ? await res.json() : null;

              if (!isRecord(data)) return;
              keep(without(pending(), x.post.carries));
              ui.addMessage(data, true);
            })
            .catch(() => undefined),
        );
      }
    }

    /* A post past the keepalive budget is in flight until stored: hiding the page again, or its pagehide after, does not send it twice. */
    if (plain.length) {
      busy = true;
      void Promise.all(plain).then(() => {
        busy = false;
      });
    }

    sentNote(p, "leave");
    step({ _tag: "tick" });
  };

  listen(window, "pagehide", leaveNow);
  listen(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") leaveNow();
    else if (hiddenToast) {
      say(hiddenToast);
      hiddenToast = "";
    }
  });

  /* Answered (here or anywhere the next state tells of): what waits goes, unless the answer carried it. */
  createEffect(t.answered, (answered, was) => {
    if (answered === true && was === false && alive) sendAll("answer");
  });

  /* While something waits, the clock ticks: the quiet period's end sends, and the ring and card count down. */
  createEffect(
    () => count() > 0,
    (waits) => {
      if (!waits) return;

      const id = setInterval(() => {
        setNow(Date.now());

        if (step({ _tag: "tick" }) === "quiet") sendAll("quiet");
      }, 1000);

      return () => clearInterval(id);
    },
  );

  /* ------------------------------------------------------------------ the composer */

  function openComposer(e: Editing, said = ""): void {
    if (!editing()) {
      composerOpener = opener();
      step({ _tag: "editStart" });
    }

    setProblem(said);
    setEditing(e);
    setMenu(null);
    flush();

    if (textBox) textBox.value = e.comment;

    if (withBox) withBox.value = e.replacement;

    if (!m.coarse()) (e.kind === "replace" ? withBox : textBox)?.focus();
  }

  const openDraft = (n: number): void => {
    const d = pending().items.find((x) => x.n === n);

    if (d) openComposer({ n, kind: d.kind, quote: d.quote ?? null, comment: d.comment ?? "", replacement: d.replacement ?? "" });
  };

  function closeComposer(): void {
    if (!editing()) return;
    setEditing(null);
    setProblem("");
    setMenu(null);
    composerCaret.close();
    flush();
    post({ annotClearSel: true });
    step({ _tag: "editEnd" });
    restore(composerOpener);
    composerOpener = null;
  }

  /** Save the composer's mark as pending (the quiet period starts again); `then` "send" sends it at once, alone (Send now). */
  function save(then: "wait" | "send"): void {
    const e = editing();

    if (!e) return;
    const comment = textBox?.value.trim() ?? "";
    const replacement = withBox?.value.trim() ?? "";

    if (e.kind !== "general" && !e.quote) {
      setProblem(UNCONFIRMED);

      return;
    }

    if (e.kind === "replace" && !replacement) {
      setProblem("Write the words to put in its place.");
      withBox?.focus();

      return;
    }

    if ((e.kind === "comment" || e.kind === "question" || e.kind === "general") && !comment) {
      setProblem(e.kind === "question" ? "Write your question." : "Write your comment.");
      textBox?.focus();

      return;
    }

    const items = pending().items;
    const n = e.n ?? nextNumber(sent(), items);
    let item: MarkItem = e.quote && e.kind !== "general" ? { n, kind: e.kind, quote: e.quote } : { n, kind: "general" };

    if (comment) item = { ...item, comment };

    if (item.kind === "replace") item = { ...item, replacement };
    keep({ ...pending(), items: e.n === null ? [...items, item] : items.map((d) => (d.n === e.n ? item : d)) });
    step({ _tag: "saved" });
    closeComposer();

    if (then === "send") void sendSet({ items: [item], msgs: [] }, "now");
  }

  const remove = (): void => {
    const n = editing()?.n;

    if (n !== null && n !== undefined) keep({ ...pending(), items: pending().items.filter((d) => d.n !== n) });
    closeComposer();
  };

  /* ------------------------------------------------------------------ the inbox panel and its threads */

  function openInbox(key: string | null): void {
    if (!open()) panelOpener = opener();
    keepBox();
    setOpen(true);
    setThread(key);
    setMenu(null);
    setBoxError("");
    flush();
    fillBox();
  }

  function closeInbox(): void {
    if (!open()) return;
    keepBox();
    stopEdit();
    setOpen(false);
    setThread(null);
    setMenu(null);
    boxCaret.close();
    flush();
    restore(panelOpener && panelOpener.isConnected && !(panelOpener instanceof HTMLIFrameElement) ? panelOpener : (inboxButton ?? null));
    panelOpener = null;
  }

  /* The box keeps what was typed in each thread while another is open. */
  const keepBox = (): void => {
    const k = thread();

    if (boxEl && k !== null && editMsg() === null) boxDrafts.set(k, boxEl.value);
  };

  const fillBox = (): void => {
    const k = thread();
    const turns = document.getElementById("mk-turns");

    if (turns) turns.scrollTop = turns.scrollHeight;

    if (!boxEl || k === null) return;
    boxEl.value = boxDrafts.get(k) ?? "";

    if (!m.coarse()) {
      boxEl.focus({ preventScroll: true });
      boxEl.setSelectionRange(boxEl.value.length, boxEl.value.length);
    }
  };

  const showThread = (key: string | null): void => {
    keepBox();
    stopEdit();
    setThread(key);
    setMenu(null);
    setBoxError("");
    flush();
    fillBox();
  };

  const stopEdit = (): void => {
    if (editMsg() === null) return;
    setEditMsg(null);

    if (boxEl) boxEl.value = "";
    step({ _tag: "editEnd" });
  };

  /** Where a message of thread `th` goes while it waits. */
  const refOf = (th: Thread): ThreadRef | null => {
    if (th._tag === "page" || th._tag === "loose") return { _tag: "page" };

    if (th._tag === "mark") return { _tag: "mark", n: th.item.n };

    if (th.opener !== null) return { _tag: "side", id: th.opener };
    const k = th.key.slice(4);
    const f = fresh().find((x) => x.key === k) ?? pending().msgs.flatMap((x) => (x.to._tag === "new" && x.to.key === k ? [{ key: k, quote: x.to.quote }] : []))[0];

    return f ? { _tag: "new", key: f.key, quote: f.quote } : null;
  };

  /**
   * The thread box's words, added to the thread's wait: every message batches (a pending comment's thread
   * adds to its comment; a comment already sent takes a reply on it; the page's thread a line of its own).
   * With "send" the thread then goes at once, its waiting words as they are when the box is empty.
   */
  async function submitBox(then: "add" | "send"): Promise<void> {
    const th = current();
    const text = boxEl?.value.trim() ?? "";

    if (!th || !boxEl) return;

    if (!text) {
      if (then === "send" && countOf(pendingOf(th.key))) await sendSet(pendingOf(th.key), "now");

      return;
    }

    setBoxError("");
    setMenu(null);
    const edited = editMsg();

    if (edited !== null) {
      keep({ ...pending(), msgs: pending().msgs.map((x) => (x.key === edited ? { ...x, text } : x)) });
      setEditMsg(null);
      boxEl.value = "";
      step({ _tag: "saved" });
      step({ _tag: "editEnd" });
    } else if (th._tag === "mark" && th.status === "pending") {
      keep({ ...pending(), items: pending().items.map((i) => (i.n === th.item.n ? { ...i, comment: (i.comment ? i.comment + "\n" : "") + text } : i)) });
      boxEl.value = "";
      step({ _tag: "saved" });
    } else {
      const to = refOf(th);

      if (!to) return;
      const q = th._tag === "page" ? chip() : null;
      const msg: PendingMsg = q ? { key: freshKey(), to, text, quote: q } : { key: freshKey(), to, text };
      keep({ ...pending(), msgs: [...pending().msgs, msg] });
      setChip(null);
      boxEl.value = "";
      step({ _tag: "saved" });
    }

    boxDrafts.delete(th.key);
    flush();

    if (then === "send") await sendSet(pendingOf(current()?.key ?? th.key), "now");
  }

  const editTurn = (th: Thread, turn: Turn): void => {
    if (th._tag === "mark") {
      openDraft(th.item.n);

      return;
    }

    if (!boxEl) return;

    if (editMsg() === null) step({ _tag: "editStart" });
    setEditMsg(turn.key);
    boxEl.value = turn.text;
    boxEl.focus();
  };

  /* ------------------------------------------------------------------ keys and the frame */

  /** Esc: the topmost layer closes, one per press. */
  function dismissTop(): boolean {
    if (menu()) {
      setMenu(null);

      return true;
    }

    if (editing()) {
      closeComposer();

      return true;
    }

    if (editMsg() !== null) {
      stopEdit();

      return true;
    }

    if (open()) {
      closeInbox();

      return true;
    }

    if (card()) {
      setCard(false);

      return true;
    }

    return false;
  }

  listen(document, "keydown", (e) => {
    if (e.key === "Escape") {
      if (dismissTop()) {
        took.add(e);
        e.preventDefault();
      }

      return;
    }

    if (e.key !== "Enter" || e.altKey || e.defaultPrevented) return;
    const a = document.activeElement;

    /* In a thread's box Enter submits (Shift+Enter is a new line); with Cmd/Ctrl+Shift it sends the thread now. */
    if (boxEl && a === boxEl && !(e.shiftKey && !(e.metaKey || e.ctrlKey)) && !e.isComposing) {
      e.preventDefault();
      void submitBox(e.shiftKey ? "send" : "add");

      return;
    }

    if (!(e.metaKey || e.ctrlKey)) return;

    if (editing() && composerBox?.contains(a)) {
      e.preventDefault();
      save(e.shiftKey ? "send" : "wait");

      return;
    }

    /* Send now, from anywhere on the page but a field (and never from the frame, whose keys stay there). */
    if (e.shiftKey && count() && !(a instanceof HTMLIFrameElement) && !(a instanceof Element && a.matches("textarea, input, select, [contenteditable]"))) {
      e.preventDefault();
      sendAll("now");
    }
  });

  /* A selection the body's frame claims, as a quote read from the page's own reading of the body; null when it does not confirm. */
  const confirmed = (claim: readonly Claimed[] | null): MarkQuote | null => (claim ? (body()?.confirm(claim) ?? null) : null);

  /* A new mark's composer on what the frame claims was selected: the confirmed quote, or none and why. */
  const openOn = (kind: MarkKind, claim: readonly Claimed[] | null): void => {
    const quote = confirmed(claim);

    if (!editing()) openComposer({ n: null, kind, quote, comment: "", replacement: "" }, quote ? "" : UNCONFIRMED);
  };

  /*
   * The selection the frame last told of (`fleetSelect`, or the fleet's page relaying it), when, and whether
   * the user's own press in that frame was live then. The frame's answer to `annotNow` is taken only when
   * it is these words, told after a real press, just now; an answer the body confirms waits for that while
   * the kind waits (the frame tells of a selection a moment after it rests). The body's scripts can post
   * both messages, so this only raises the bar; that only words the user can see confirm (bodytext.ts) is
   * what holds.
   */
  let told: { readonly text: string; readonly at: number; readonly real: boolean } | null = null;
  let answer: { readonly kind: MarkKind; readonly claim: readonly Claimed[]; readonly quote: MarkQuote } | null = null;

  const asTold = (claim: readonly Claimed[]): boolean =>
    told !== null && told.real && Date.now() - told.at <= TOLD_MS && squash(told.text) !== "" && squash(told.text) === squash(claim.map((b) => b.exact).join(""));

  /* The frame's answer, once it is the selection the frame told of, opens the composer on it. */
  const takeAnswer = (): void => {
    if (!waitingKind || !answer || answer.kind !== waitingKind.kind || !asTold(answer.claim)) return;
    clearTimeout(waitingKind.timer);
    waitingKind = null;
    const { kind, quote } = answer;
    answer = null;

    if (!editing()) openComposer({ n: null, kind, quote, comment: "", replacement: "" });
  };

  listen(window, "message", (e) => {
    const fr = t.frame();

    /* The body frame is sandboxed (origin "null"); a fleet's page on the manager's is this page's origin, and relays the body's messages rebuilt. */
    const fromFrame = fr !== null && e.source === fr.contentWindow && e.origin === (t.relayed ? location.origin : "null") && t.speaks(e);
    const relayed = fromFrame && t.relayed ? parseEmbedMessage(e.data) : null;

    /* The fleet's page (this page's own code, same origin) is ready or resized: it is told the field marks again; a tap on one of its pins, Luiz's own, opens that thread. */
    if (fr && relayed?.kind === "height") postFields();

    if (fr && relayed?.kind === "fieldTap" && globalThis.navigator?.userActivation?.isActive === true && box().threads.some((th) => th.key === relayed.id)) openInbox(relayed.id);

    if (fr && relayed?.kind === "fieldDelete" && globalThis.navigator?.userActivation?.isActive === true) deleteMark(relayed.id);

    const selected = fromFrame ? (t.relayed ? (relayed?.kind === "select" ? relayed : null) : parseEvidenceSelect(e.data)) : null;

    if (fr && selected) {
      told = { text: selected.text, at: Date.now(), real: realTap(fr) };
      takeAnswer();
    }

    const said = fromFrame ? parseFrameSaid(e.data) : null;

    if (!fr || !said) return;

    switch (said.kind) {
      case "ready":
        setFrameGen(frameGen() + 1);
        setReady(true);

        break;
      case "placed":
        setReady(true);

        break;
      case "now": {
        /* The selection as it is now, for the kind the page asked about; one the body does not confirm waits for the frame's own answer, or the bar's. */
        const quote = waitingKind && said.mark === waitingKind.kind ? confirmed(said.claim) : null;

        if (quote && said.claim) {
          answer = { kind: said.mark, claim: said.claim, quote };
          takeAnswer();
        }

        break;
      }

      case "tap":
        /* A tap on a mark or its pin opens its thread: only Luiz's own. */
        if (realTap(fr) && box().threads.some((th) => th.key === said.id)) openInbox(said.id);

        break;
      case "esc":
        /* Escape in the frame closes the selection bar only (Overlays.tsx), never a layer of the marks. */
        break;
    }
  });

  /* Where the masthead (its tabs too) ends on screen: the rail and the inbox sit under it, whatever is above it and however it sticks. */
  const [mast, setMast] = createSignal(0);

  const measureMast = (): void => {
    setMast(Math.max(0, document.querySelector(".masthead")?.getBoundingClientRect().bottom ?? 0));
  };

  listen(window, "scroll", measureMast);
  listen(window, "resize", measureMast);

  /* The keyboard comes or goes (the visual viewport resizes): a thread open keeps its newest message in view above its box. */
  const keepNewest = (): void => {
    const turns = document.getElementById("mk-turns");

    if (open() && turns) turns.scrollTop = turns.scrollHeight;
  };

  globalThis.visualViewport?.addEventListener("resize", keepNewest);
  onCleanup(() => globalThis.visualViewport?.removeEventListener("resize", keepNewest));

  onSettled(() => {
    /* A frame that was ready before this inbox was made answers this with where nothing is: it is ready. */
    post({ annotPaint: true, marks: [] });
    measureMast();
    const head = document.querySelector(".masthead");

    if (!head || !("ResizeObserver" in globalThis)) return;
    const watch = new ResizeObserver(measureMast);
    watch.observe(head);
    onCleanup(() => watch.disconnect());
  });

  /** Luiz's own reset of the countdown: the whole quiet period again, said in the card, with a pulse and a tap of the phone. */
  const resetTimer = (): void => {
    if (!count()) return;
    step({ _tag: "reset" });
    setNow(Date.now());
    setResetAt(Date.now());
    setCard(true);
    globalThis.navigator?.vibrate?.(10);
  };

  /* A press held on the paper plane for HOLD_MS resets the countdown and shows the card (on a phone, the card's way in); released early, nothing. A press elsewhere puts the card away. */
  listen(document, "pointerdown", (e) => {
    const on = e.target instanceof Element ? e.target.closest("#mk-now, #mk-card") : null;

    if (card() && !on) setCard(false);

    if (!(e.target instanceof Element) || !e.target.closest("#mk-now") || e.button !== 0 || !count()) return;
    longFired = false;
    clearTimeout(longPress);
    setHolding(true);
    pressedAt = Date.now();
    longPress = setTimeout(() => {
      longFired = true;
      setHolding(false);
      resetTimer();
    }, HOLD_MS);
  });

  /** Whether focus or the pointer goes into the plane's card (its Reset timer): the card stays. */
  const intoCard = (to: EventTarget | null): boolean => to instanceof Element && to.closest("#mk-card") !== null;

  let pressedAt = 0;

  const letGo = (): void => {
    clearTimeout(longPress);

    /* A hold let go early cancels: the ring springs back, and its release is no tap. */
    if (holding() && Date.now() - pressedAt >= TAP_MS) longFired = true;
    setHolding(false);
  };

  for (const type of ["pointerup", "pointercancel"] as const) listen(document, type, letGo);

  const desk: MarkDesk = {
    on,
    begin: (kind, claim) => {
      if (waitingKind) clearTimeout(waitingKind.timer);

      /* The frame's selection as it is at the tap: the one the bar has may lag a drag that just ended. */
      const timer = setTimeout(() => {
        waitingKind = null;
        answer = null;
        openOn(kind, claim);
      }, NOW_MS);

      waitingKind = { kind, claim, timer };
      answer = null;
      post({ annotNow: kind });
    },
    layered: () => editing() !== null || open() || menu() !== null,
    took: (e) => took.has(e),
    fieldsOn: listed,
    beginField: (kind, claim) => {
      if (!editing()) openComposer({ n: null, kind, quote: fieldQuote(claim), comment: "", replacement: "" });
    },
    reply: (quote) => {
      setChip(quote);
      openInbox("page");
    },
    side: (quote) => {
      const key = freshKey();
      setFresh([...fresh(), { key, quote }]);
      openInbox("new:" + key);
    },
    ride: (id) => {
      const tg = target();

      if (busy || t.relayed || !tg || tg.decision.id !== id || !count()) return null;
      /* The batches, numbered once: the owner's rides along; the cited agents' go after the answer. */
      const plan = planSend({ ...pending(), msgs: pending().msgs.filter(batched) }, tg);
      const owners = plan[0];

      if (!owners?.body.marks) return null;
      busy = true;
      riding = true;
      ridePlan = plan.slice(1);

      return owners;
    },
    rode: (ride, stored) => {
      /* Only the answer that took the lock gives it back: another send may hold it. */
      if (!riding) return;
      riding = false;

      if (!isRecord(stored)) {
        busy = false;
        keepTimed();

        return;
      }

      const p = pending();
      const b = stored["batch"];
      const rode = ride !== null && isRecord(b);

      /* The owner's batch rode along with the answer: what it carried is gone, the cited agents' batches owed. */
      if (rode) {
        ui.addMessage(b, true);
        keep(owing(without(pending(), ride.carries), ride.owes ?? []));
      }

      const n = rode ? ride.carries.items.length : 0;
      const cited = rode ? ridePlan : [];
      ridePlan = [];

      step({ _tag: "send", reason: "answer" });
      /* The lock held through the cited batches (each cleared once stored, owed if not), then what else waits, read as it is then: nothing goes twice. */
      void (async (): Promise<void> => {
        try {
          for (const one of cited) {
            const out = await postOne(one.body);

            if ("error" in out) break;
            keep(without(pending(), one.carries));
          }
        } finally {
          busy = false;
        }

        if (countOf(pending())) await sendSet(pending(), "answer", n);
        else if (n) {
          sentNote(p, "answer");
          keepTimed();
        }
      })();
    },
  };

  markDesk.current = desk;
  /* A message in the main chat while this page is shown sends what waits here first. */
  outbox.current = () => (count() ? sendSet(pending(), "now") : Promise.resolve());

  /* A batch card in the chat opens this inbox on its thread: at once when it is this decision's, or once its page is shown. */
  inboxOpener.current = (hash, key) => {
    if (hash !== t.hash || !listed()) return false;
    openInbox(key !== null && box().threads.some((th) => th.key === key) ? key : null);

    return true;
  };

  onSettled(() => {
    const asked = inboxRequest.current;

    if (asked?.hash !== t.hash) return;
    inboxRequest.current = null;
    openInbox(asked.key !== null && box().threads.some((th) => th.key === asked.key) ? asked.key : null);
  });
  onCleanup(() => {
    alive = false;

    if (waitingKind) clearTimeout(waitingKind.timer);
    clearTimeout(toastTimer);
    clearTimeout(longPress);

    if (markDesk.current === desk) markDesk.current = null;
    outbox.current = null;
    inboxOpener.current = null;

    if (t.relayed) post({ annotFields: true, marks: [] });
    else {
      setFieldPaints([]);
      fieldTap.current = null;
      fieldDelete.current = null;
    }

    /* Moving to another decision or view is leaving the page: what waits goes now. */
    if (count()) void sendSet(pending(), "leave");
  });

  /* ------------------------------------------------------------------ the views */

  /* Who a send reaches, in words, with how many comments each: "3 to perf, 1 to skills". */
  const nameOf = (id: string): string => (id === ownerName() ? t.fleet : (m.roster().find((r) => r.id === id)?.name ?? id));
  const partsOf = (p: Pending): string[] => perRecipient(p, { owner: ownerName(), host: hostName(), roster: m.roster() }).map((r) => `${String(r.n)} to ${nameOf(r.to)}`);
  const rec = (): string[] => partsOf(pending());
  const left = (): number => leftOf(timer(), now()) ?? QUIET_MS;
  const RING = 2 * Math.PI * 20;
  const away = (): boolean => ui.picked() !== null || editing() !== null || open();

  const Row = (p: { readonly th: Thread }): JSX.Element => {
    const th = (): Thread => p.th;
    const line = (): ReturnType<typeof lastLine> => lastLine(th());
    const at = (): string => th().turns.at(-1)?.at ?? "";

    return (
      <li>
        <button type="button" class={"mk-row t-" + th()._tag + (asMark(th()) ? " k-" + (asMark(th())?.kind ?? "") : "") + (th().unread ? " unread" : "")} data-thread={th().key} onClick={() => showThread(th().key)}>
          <span class="mk-l1">
            {rowHead(th())}
            <When at={at()} relative />
            <Show when={th().unread}>
              <i class="mk-dot" aria-label="unread" />
            </Show>
          </span>
          <span class="mk-l2">
            <Show when={asMark(th())?.withdrawn ? "withdrawn" : (asMark(th())?.status ?? (th().waits ? "pending" : ""))}>{(s) => <span class={"pill st-" + s()}>{s()}</span>}</Show>
            <span class="mk-last">
              <Show when={line()} fallback={<span class="mk-who">No messages yet</span>}>
                {(l) => (
                  <>
                    <span class="mk-who">
                      {l().who}
                      {l().waits ? " · not sent" : ""}:
                    </span>{" "}
                    {l().text}
                  </>
                )}
              </Show>
            </span>
          </span>
        </button>
      </li>
    );
  };

  const rowHead = (th: Thread): JSX.Element => {
    switch (th._tag) {
      case "page":
        return (
          <>
            <span class="mk-title">
              <Icon d={ICON.chat} size={16} />
              Page chat
            </span>
            <span class="mk-to">with {t.fleet}</span>
          </>
        );
      case "side":
        return (
          <>
            <span class="mk-title">
              <Icon d={ICON.side} size={16} />
              Side chat
            </span>
            <span class="mk-q">“{th.quote}”</span>
          </>
        );
      case "mark":
        return (
          <>
            <span class="mk-n">{th.item.kind === "general" ? "G" : th.item.n}</span>
            <span class="mk-kind">{KIND_WORDS[th.item.kind]}</span>
            <span class="mk-q">{th.item.quote ? "“" + th.item.quote.text.replace(/\s+/gu, " ") + "”" : "the whole decision"}</span>
          </>
        );
      case "loose":
        return <span class="mk-title">Answer to your comments</span>;
    }
  };

  const threadHead = (th: Thread): JSX.Element => {
    switch (th._tag) {
      case "page":
        return (
          <>
            <h2>Page chat</h2>
            <span class="mk-to">with {t.fleet}, about this decision</span>
          </>
        );
      case "side":
        return (
          <>
            <h2>Side chat</h2>
            <span class="mk-to">with {t.fleet}, about these words</span>
          </>
        );
      case "mark":
        return (
          <>
            <h2>
              <span class="mk-n">{th.item.kind === "general" ? "G" : th.item.n}</span>
              <span class={"mk-kind k-" + th.item.kind}>{KIND_WORDS[th.item.kind]}</span>
              <span class={"pill st-" + (th.withdrawn ? "withdrawn" : th.status)}>{th.withdrawn ? "withdrawn" : th.status}</span>
            </h2>
            <span class="mk-to">to {t.fleet}</span>
          </>
        );
      case "loose":
        return (
          <>
            <h2>Answer to your comments</h2>
            <span class="mk-to">from {t.fleet}</span>
          </>
        );
    }
  };

  /** A mark thread's words, where they were, and whether they are still in the decision. */
  const MarkWords = (p: { readonly th: Thread & { readonly _tag: "mark" } }): JSX.Element => {
    const status = (): string => placed().get(p.th.item.n) ?? "current";

    return (
      <Show when={p.th.item.quote}>
        {(q) => (
          <div class={"mk-words k-" + p.th.item.kind}>
            <blockquote class={q().blocks.length > 1 ? "multi" : ""}>
              <QuoteView quote={q()} />
            </blockquote>
            <p class="mk-hint">
              <Show when={status() !== "current"}>
                <span class={"mk-tag " + status()}>{status()}</span>{" "}
              </Show>
              {status() === "outdated" ? "This text is no longer in the decision; the mark keeps its quote." : q().hint}
            </p>
          </div>
        )}
      </Show>
    );
  };

  const Turns = (p: { readonly th: Thread }): JSX.Element => (
    <ol class="mk-turns" id="mk-turns">
      <For each={p.th.turns} keyed={(x) => x.key} fallback={<li class="mk-empty">{p.th._tag === "page" ? `Ask ${t.fleet} about this decision. It reads the page with you.` : "Write the first message: it goes with the rest."}</li>}>
        {(x, i) => {
          const prev = (): Turn | undefined => p.th.turns[i() - 1];
          const head = (): boolean => prev()?.who !== x().who;

          return (
            <li class={"turn " + (x().mine ? "from-user" : "from-fleet") + (head() ? " head" : "")} data-key={x().key}>
              <Show when={head()}>
                <div class="turn-head">
                  <span class="name">{x().who}</span>
                  <When at={x().at} relative />
                </div>
              </Show>
              <div class={"mk-msg" + (x().id === null ? " pending" : "") + (editMsg() === x().key ? " editing" : "")}>
                <Show when={x().whole.length}>
                  <span class="mk-whole">To the whole batch: {wholeWords(x().whole)}</span>
                </Show>
                <Show when={x().quote}>
                  <span class="mk-msg-q">“{x().quote}”</span>
                </Show>
                <Show when={x().marks} fallback={<Show when={x().mine} fallback={<Rich text={x().text} refs />}><span class="mk-msg-text">{x().text}</span></Show>}>
                  {(b) => <BatchCard marks={b()} />}
                </Show>
                <Show when={x().keep}>
                  <span class="mk-keep">No change: {x().keep}</span>
                </Show>
                <Show when={x().id === null}>
                  <span class="pill st-pending">not sent</span>
                  <button type="button" class="mk-edit" onClick={() => editTurn(p.th, x())}>
                    Edit
                  </button>
                </Show>
              </div>
            </li>
          );
        }}
      </For>
    </ol>
  );

  const split = createMemo(() => splitDone(box().threads, hideDone()));

  /** The "Hide answered" switch: in the inbox's head and the plane's card, the same choice. */
  const HideToggle = (p: { readonly id: string }): JSX.Element => (
    <button type="button" class="mk-hide" id={p.id} aria-pressed={tf(hideDone())} onClick={() => setHideDone(!hideDone())}>
      Hide answered
    </button>
  );

  const placeholder = (th: Thread): string =>
    editMsg() !== null ? "Edit the message…" : th._tag === "mark" && th.status === "pending" ? "Add to the comment… @ an agent, / a skill" : th._tag === "mark" ? "Reply… @ an agent, / a skill" : `Ask ${t.fleet}… @ an agent, / a skill`;

  return (
    <Show when={listed()}>
      <div style={mast() ? `--mk-top:${String(Math.round(mast()))}px` : undefined} class="mk-root">
      <div class={"mk-rail" + (open() ? " open" : "") + (away() ? " away" : "")} id="mk-rail">
        <button type="button" class={"mk-inbox" + (open() ? " on" : "")} id="mk-inbox" aria-label={`Inbox${unread() ? `: ${String(unread())} unread` : ""}`} aria-expanded={tf(open())} aria-controls="mk-panel" ref={(el) => (inboxButton = el)} onClick={() => (open() ? closeInbox() : openInbox(null))}>
          <Icon d={ICON.inbox} />
          <i class="mk-unread" id="mk-unread" hidden={!unread()} />
        </button>
        <button
          type="button"
          class={"mk-now" + (count() ? " on" : "") + (resetAt() && now() - resetAt() < 1000 ? " pulsed" : "")}
          id="mk-now"
          aria-disabled={tf(!count())}
          aria-describedby="mk-card"
          aria-label={count() ? `Send ${String(count())} now (${KEY_NOW})` : "Nothing waiting to send"}
          onContextMenu={(e) => e.preventDefault()}
          onPointerEnter={(e) => e.pointerType === "mouse" && setCard(true)}
          onPointerLeave={(e) => {
            letGo();

            if (e.pointerType === "mouse" && !intoCard(e.relatedTarget)) setCard(false);
          }}
          onFocus={() => setCard(true)}
          onBlur={(e) => !intoCard(e.relatedTarget) && setCard(false)}
          onClick={(e) => {
            if (longFired) {
              longFired = false;

              return;
            }

            /* Shift+click (or the card's Reset timer) resets the countdown, for a keyboard and a mouse alike. */
            if (e.shiftKey) {
              resetTimer();

              return;
            }

            setCard(false);

            if (count()) sendAll("now");
          }}
        >
          <Show when={count()}>
            <svg class={"mk-ring" + (timer()._tag === "paused" ? " paused" : "") + (holding() ? " holding" : "")} viewBox="0 0 44 44" aria-hidden="true">
              <circle class="bg" cx="22" cy="22" r="20" />
              <circle class="fg" cx="22" cy="22" r="20" style={`stroke-dasharray:${String(RING)};stroke-dashoffset:${String(holding() ? 0 : RING * (1 - Math.min(1, left() / QUIET_MS)))}`} />
            </svg>
          </Show>
          <Icon d={ICON.plane} size={18} />
          <b class="mk-badge" id="mk-badge" hidden={!count()}>
            {count()}
          </b>
        </button>
        <div class={"mk-card" + (card() ? " show" : "")} id="mk-card" role="tooltip" onPointerLeave={(e) => e.pointerType === "mouse" && !(e.relatedTarget instanceof Element && e.relatedTarget.closest("#mk-now")) && setCard(false)}>
          <Show
            when={count()}
            fallback={
              <p class="c-head">
                <b>Nothing waiting</b>
                <span>Saved comments go out by themselves</span>
              </p>
            }
          >
            <p class="c-head">
              <b class="num" id="mk-card-count">
                {count()} waiting
              </b>
              <span id="mk-card-to">{rec().join(", ")}</span>
            </p>
            <p class="c-eta">
              <span class="c-k">Auto-send</span>
              <b class="num" id="mk-card-eta">
                {timer()._tag === "paused" ? "paused while you write" : `in ${clock(left())}`}
              </b>
            </p>
            <p class="c-why">Goes by itself, one batch, when you leave the page, answer the decision, or after {QUIET_WORDS} quiet.</p>
            <Show when={resetAt() && now() - resetAt() < 4000}>
              <p class="c-reset" id="mk-card-reset" role="status">
                Timer reset: sends in {clock(QUIET_MS)}
              </p>
            </Show>
            <p class="c-act">
              <Show when={!m.coarse()} fallback={<>Tap the plane to send {count()} now · hold it to reset the timer</>}>
                Click to send {count()} now <kbd class="kb">{KEY_NOW}</kbd> · hold, or Shift+click, to reset the timer
              </Show>
            </p>
            <HideToggle id="mk-card-hide" />
            <button type="button" class="btn small c-reset-btn" id="mk-card-reset-btn" onClick={resetTimer}>
              Reset timer
            </button>
          </Show>
          <Show when={last()}>
            {(l) => (
              <p class="c-last" id="mk-card-last">
                <span class="c-k">
                  Last sent · <When at={l().at} />
                </span>
                {l().text}
              </p>
            )}
          </Show>
        </div>
      </div>
      <Show when={open()}>
        <aside class="mk-panel" id="mk-panel" role="dialog" aria-label="Inbox" data-thread={thread() ?? ""}>
          <Show
            when={current()}
            fallback={
              <>
                <header class="mk-head">
                  <h2>Inbox</h2>
                  <span class="mk-count num" id="mk-count">
                    {plural(box().threads.filter((x) => x._tag === "mark").length, "comment")}
                  </span>
                  <HideToggle id="mk-hide" />
                  <button type="button" class="mk-icon" id="mk-close" aria-label="Close (Esc)" onClick={closeInbox}>
                    <Icon d={ICON.x} />
                  </button>
                </header>
                <div class="mk-scroll">
                <ul class="mk-threads" id="mk-threads">
                  <Row th={box().page} />
                  <For each={split().open} keyed={(x) => x.key}>
                    {(x) => <Row th={x()} />}
                  </For>
                </ul>
                <Show when={split().done.length}>
                  <details class="mk-done" id="mk-done">
                    <summary>Answered ({split().done.length})</summary>
                    <ul class="mk-threads">
                      <For each={split().done} keyed={(x) => x.key}>
                        {(x) => <Row th={x()} />}
                      </For>
                    </ul>
                  </details>
                </Show>
                </div>
              </>
            }
          >
            {(th) => (
              <>
                <header class="mk-head">
                  <button type="button" class="mk-icon" id="mk-back" aria-label="Back to the inbox" onClick={() => showThread(null)}>
                    <Icon d={ICON.back} />
                  </button>
                  <div class="mk-th">
                    {threadHead(th())}
                  </div>
                  <Show when={asMark(th()) && !asMark(th())?.withdrawn}>
                    <button type="button" class="mk-icon" id="mk-delete" aria-label={asMark(th())?.status === "pending" ? "Delete the comment" : "Withdraw the comment"} title={asMark(th())?.status === "pending" ? "Delete" : "Withdraw"} onClick={() => deleteMark(th().key)}>
                      <Icon d={ICON.trash} size={18} />
                    </button>
                  </Show>
                  <button type="button" class="mk-icon" id="mk-close" aria-label="Close (Esc)" onClick={closeInbox}>
                    <Icon d={ICON.x} />
                  </button>
                </header>
                <Show when={asMark(th())}>{(mk) => <MarkWords th={mk()} />}</Show>
                <Show when={asSide(th())?.quote}>
                  {(q) => (
                    <div class="mk-words k-side">
                      <blockquote>{q()}</blockquote>
                    </div>
                  )}
                </Show>
                <Turns th={th()} />
                <div class="mk-composer">
                  <div class="mk-box waits">
                    <Show when={editMsg() !== null ? "Editing your message · the timer waits" : th()._tag === "page" && chip() ? `Quoting “${(chip()?.text ?? "").replace(/\s+/gu, " ")}”` : ""}>
                      {(c) => (
                        <div class="mk-chip">
                          <span class="mk-chip-text">{c()}</span>
                          <button type="button" class="mk-icon" aria-label={editMsg() !== null ? "Stop editing" : "Remove the quote"} onClick={() => (editMsg() !== null ? stopEdit() : setChip(null))}>
                            <Icon d={ICON.x} size={16} />
                          </button>
                        </div>
                      )}
                    </Show>
                    <div class="caret-wrap">
                      <textarea
                        id="mk-box"
                        rows="1"
                        maxlength="4000"
                        placeholder={placeholder(th())}
                        ref={(el) => {
                          boxEl = el;
                          boxCaret.attach(el);
                        }}
                        onInput={() => setBoxError("")}
                      />
                      <CaretList caret={boxCaret} />
                    </div>
                    <div class="mk-sends">
                      <button type="button" class="mk-send" id="mk-box-send" title={`Add, waits with the rest (Enter or ${KEY_SAVE})`} aria-label="Add to the wait" onClick={() => void submitBox("add")}>
                        <Icon d={ICON.up} size={18} />
                      </button>
                      <button type="button" class="mk-send now" id="mk-box-now" title={`Send this thread now (${KEY_NOW})`} aria-label="Send this thread now" onClick={() => void submitBox("send")}>
                        <Icon d={ICON.plane} size={17} />
                      </button>
                    </div>
                  </div>
                  <p class="mk-problem" role="alert" hidden={!boxError()}>
                    {boxError()}
                  </p>
                  <p class="mk-hint" id="mk-box-hint">
                    <Show when={!m.coarse()} fallback={<>↑ adds to the wait · the plane sends this thread now</>}>
                      Enter adds to the wait · <kbd class="kb">{KEY_NOW}</kbd> sends this thread now
                    </Show>
                  </p>
                </div>
              </>
            )}
          </Show>
        </aside>
      </Show>
      <div class="mk-scrim" hidden={!editing()} onClick={closeComposer} />
      <div class={"mk-sheet k-" + (editing()?.kind ?? "comment")} id="mk-composer" role="dialog" aria-labelledby="mk-c-title" hidden={!editing()} ref={(el) => (composerBox = el)}>
        <h3 id="mk-c-title">{editing()?.n ? `Comment #${String(editing()?.n)}` : editing()?.kind === "general" ? "General comment" : "New comment"}</h3>
        <Show when={editing()?.kind !== "general"}>
          <div class="mk-kinds" id="mk-kinds" role="group" aria-label="Kind of comment">
            <For each={QUOTED_KINDS}>
              {(k) => (
                <button
                  type="button"
                  class={"k-" + k}
                  data-k={k}
                  aria-pressed={tf(editing()?.kind === k)}
                  onClick={() => {
                    const e = editing();

                    if (e) setEditing({ ...e, kind: k });
                  }}
                >
                  {KIND_WORDS[k]}
                </button>
              )}
            </For>
          </div>
          <blockquote id="mk-quote">
            <Show when={editing()?.quote}>{(q) => <QuoteView quote={q()} />}</Show>
          </blockquote>
        </Show>
        <div hidden={editing()?.kind !== "replace"}>
          <label for="mk-with">Replace with</label>
          <textarea id="mk-with" rows="2" maxlength="4000" ref={(el) => (withBox = el)} />
        </div>
        <label for="mk-text">{TEXT_LABEL[editing()?.kind ?? "comment"]}</label>
        <div class="caret-wrap">
          <textarea
            id="mk-text"
            maxlength="4000"
            placeholder="@ an agent, / a skill"
            ref={(el) => {
              textBox = el;
              composerCaret.attach(el);
            }}
          />
          <CaretList caret={composerCaret} />
        </div>
        <p class="mk-problem" role="alert" hidden={!problem()}>
          {problem()}
        </p>
        <div class="mk-acts">
          <Show when={editing()?.n}>
            <button type="button" class="btn danger left" id="mk-remove" onClick={remove}>
              Remove
            </button>
          </Show>
          <button type="button" class="btn ghost" id="mk-cancel" onClick={closeComposer}>
            Cancel
          </button>
          <Split id="mk" main="Save" open={menu() === "composer"} onMain={() => save("wait")} onNow={() => save("send")} onMenu={() => setMenu(menu() === "composer" ? null : "composer")} />
        </div>
        <p class="mk-hint">
          Saved comments go with the rest: when you leave, answer, or after {QUIET_WORDS} quiet.{" "}
          <Show when={!m.coarse()} fallback={<>Send now is behind the arrow beside Save.</>}>
            {REASON_WORDS.now}: <kbd class="kb">{KEY_NOW}</kbd>
          </Show>
        </p>
      </div>
      <div class="mk-toast" id="mk-toast" role="status" hidden={!toast()}>
        <span id="mk-toast-text">{toast()}</span>
        <Show when={undo()}>
          {(u) => (
            <>
              {" · "}
              <button
                type="button"
                class="mk-undo"
                id="mk-undo"
                onClick={() => {
                  u()();
                  setToast("");
                  setUndo(null);
                }}
              >
                Undo
              </button>
            </>
          )}
        </Show>
      </div>
      </div>
    </Show>
  );
}
