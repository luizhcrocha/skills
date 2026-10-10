/**
 * Marks on the decision shown (SPEC "Marks on a decision"): the selection bar's Comment, Delete, Replace
 * and Question open a composer for the words selected in the body; the marks collect in a list at the end
 * of the page (a bottom sheet, opened by a floating button that shows their count), numbered and
 * highlighted in the body's frame; one Send posts them all as one chat message to the fleet that owns
 * the decision, after a preview of that message and of who gets it. The fleet's answers show under the
 * marks they name; answered marks stay, dimmed, or fold into a History, as the viewer chooses.
 *
 * It lives on the top page: on a fleet's page beside its own evidence frame, on the manager's page after
 * a fleet's decision (that fleet's page in a frame, which relays the messages to the body's frame inside
 * it). The frame runs the body's own scripts, so what it posts is a claim, never a command: a selection is
 * confirmed against the body as this page parsed it (bodytext.ts) before it becomes a quote, where each
 * mark is now is found in that same text, and only the user's own input on this page acts. Esc closes the
 * topmost layer, one per press (the composer or the preview, then the sheet, then the selection bar);
 * Cmd+Enter on a Mac, Ctrl+Enter elsewhere, saves the mark with focus in the composer, sends with focus
 * in the preview, and opens the preview with focus on the marks or nowhere. Keys pressed inside the frame
 * do none of it (Esc there closes the selection bar only).
 */
import { createEffect, createMemo, createSignal, flush, onCleanup, onSettled } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { listen, tf, usePage } from "./bits.tsx";
import { Core, type Json, type JsonRecord, type MarkDecision, type MarkItem, type MarkKind, type MarkQuote, type Message } from "./core.ts";
import { readBody } from "./bodytext.ts";
import { parseFrameSaid } from "./embed.ts";
import { deliveryWords, KIND_WORDS, loadDrafts, makeBatch, nextNumber, placeMark, QUOTED_KINDS, quoteLines, saveDrafts, sentOf, type Batch, type Claimed, type DraftStore } from "./marks.ts";
import { Rich } from "./Rich.tsx";

/** Where a decision's marks go, and the frame they are painted in. */
export interface MarkTarget {
  /** The browser storage key of its drafts (`draftsKey`). */
  readonly key: string;
  /** Its place on this page, as a batch's `at` names it. */
  readonly hash: string;
  /** The fleet that owns it, as the preview names it. */
  readonly fleet: string;
  /** The decision as the page has it now; null while it is not known. */
  readonly decision: () => MarkDecision | null;
  /** The frame its body's messages come from and go to: the evidence frame, or on the manager's page the fleet's frame. */
  readonly frame: () => HTMLIFrameElement | null;
  /** The whole document the body's frame was given (its srcdoc), which the page reads itself; null while it is not known. */
  readonly body: () => string | null;
  /** Whether marks may be made here (a decision, not a grilling). */
  readonly allowed: () => boolean;
  /** Whether `frame` is a fleet's page on the manager's (same origin, relaying), not the sandboxed body frame (origin "null"). */
  readonly relayed: boolean;
}

/** What the selection bar asks of the marks on the decision shown. */
export interface MarkDesk {
  /** Whether the bar offers the kinds of mark: the body's frame answered and the chat can be written. */
  readonly on: () => boolean;
  /** Start a mark of `kind` on the selection: asked of the frame as it is now, else `claim`, the one the bar has; confirmed against the body either way. */
  readonly begin: (kind: MarkKind, claim: readonly Claimed[]) => void;
  /** Whether a layer over the bar is open (the composer, the preview, the sheet): Esc is theirs first. */
  readonly layered: () => boolean;
  /** Whether the marks acted on `e` (an Esc they took), so the bar leaves it. */
  readonly took: (e: Event) => boolean;
}

/** Where the selection bar finds the marks of the decision shown, while their list is on the page. */
export interface MarkDeskSlot {
  current: MarkDesk | null;
}

/** The marks of the decision shown, while their list is on the page; the selection bar reads it. */
export const markDesk: MarkDeskSlot = { current: null };

/** The modifier key of the platform, as a hint on a button: ⌘↵ on a Mac, else Ctrl+↵. */
const KB = /Mac|iPhone|iPad/u.test(globalThis.navigator?.platform ?? "") ? "⌘↵" : "Ctrl+↵";

/** How long a tapped kind waits for the frame's selection as it is now before taking the bar's. */
const NOW_MS = 400;

const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

/** Where a mark's words are in the body now, as the page found them in its own reading of it. */
interface Placed {
  readonly status: string;
  readonly found: number;
  readonly total: number;
}

/** What the composer says of a selection the body's text does not confirm. */
const UNCONFIRMED = "Could not confirm this selection in the decision's text. Select the words again.";

/** A mark in the list: a draft, or one sent with its answers. */
interface Row {
  readonly id: string;
  readonly item: MarkItem;
  readonly sent: boolean;
  readonly answers: readonly Message[];
}

/** The mark the composer is open on: a new one (`n` null) or a draft, its kind as picked. */
interface Editing {
  readonly n: number | null;
  readonly kind: MarkKind;
  readonly quote: MarkQuote | null;
  readonly comment: string;
  readonly replacement: string;
}

/** The Send preview: the batch, the words on who gets it, and why the server refused it. */
interface Preview {
  readonly batch: Batch;
  readonly dest: string;
  readonly error: string;
  readonly busy: boolean;
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

/** The marks on one decision: the list, its button and sheet, the composer and the Send preview. */
export function Marks(props: { readonly target: MarkTarget }): JSX.Element {
  const { m, ui } = usePage();
  const t = props.target;
  const store = storage();
  const [drafts, setDrafts] = createSignal<readonly MarkItem[]>(loadDrafts(store, t.key));
  const [ready, setReady] = createSignal(false);

  /* The body as this page read it from the document it gave the frame: the text marks are found in and selections checked against. */
  const body = createMemo(() => {
    const doc = t.body();

    return doc ? readBody(doc) : null;
  });

  /* Each time the frame is (re)made and ready: a revision's new frame is painted again. */
  const [frameGen, setFrameGen] = createSignal(0);
  /* The masthead's height: the list's controls stick under it. */
  const [mast, setMast] = createSignal(0);
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const [problem, setProblem] = createSignal("");
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [sheet, setSheet] = createSignal(false);
  const [inView, setInView] = createSignal(false);
  const [stuck, setStuck] = createSignal(false);
  const [mode, setMode] = createSignal<"keep" | "clear">(m.prefs.get("marks-answered", "keep") === "clear" ? "clear" : "keep");
  const sent = createMemo(() => sentOf(m.messages(), t.hash));
  /* The list shows wherever marks may be made (a general comment needs no frame); the bar's kinds need the frame ready. */
  const listed = (): boolean => t.allowed() && m.chatWritable();
  const on = (): boolean => ready() && body() !== null && listed();
  let section: HTMLElement | undefined;
  let list: HTMLDivElement | undefined;
  let ctl: HTMLDivElement | undefined;
  let textBox: HTMLTextAreaElement | undefined;
  let withBox: HTMLTextAreaElement | undefined;
  let sendButton: HTMLButtonElement | undefined;
  let composerBox: HTMLDivElement | undefined;
  let previewBox: HTMLDivElement | undefined;
  let composerOpener: Element | null = null;
  let sheetOpener: Element | null = null;
  let pending: { readonly kind: MarkKind; readonly claim: readonly Claimed[]; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  const took = new WeakSet<Event>();

  const keep = (items: readonly MarkItem[]): void => {
    setDrafts(items);
    saveDrafts(store, t.key, items);
  };

  const rows = createMemo((): Row[] => {
    const all = [...drafts().map((item) => ({ id: "d" + String(item.n), item, sent: false, answers: [] })), ...sent().marks.map((s) => ({ id: `s${String(s.batch)}-${String(s.item.n)}`, item: s.item, sent: true, answers: s.answers }))];

    return all.sort((a, b) => Number(a.item.kind === "general") - Number(b.item.kind === "general") || a.item.n - b.item.n);
  });

  /* Where each mark's words are in the body now, found in the page's own reading of it (the frame paints them, and is not asked). */
  const placed = createMemo((): ReadonlyMap<string, Placed> => {
    const b = body();
    const out = new Map<string, Placed>();

    if (!b) return out;

    for (const r of rows()) {
      const q = r.item.quote;

      if (!q) continue;
      const p = placeMark(q.blocks, b.text);
      out.set(r.id, { status: p.status, found: p.found, total: p.total });
    }

    return out;
  });

  const answered = (r: Row): boolean => r.answers.length > 0;
  const shown = createMemo(() => rows().filter((r) => !(answered(r) && mode() === "clear")));
  const history = createMemo(() => rows().filter((r) => answered(r) && mode() === "clear"));
  const unsent = (): number => drafts().length;
  const statusOf = (r: Row): string => (r.item.kind === "general" ? "" : (placed().get(r.id)?.status ?? "current"));
  const outdated = (): number => rows().filter((r) => statusOf(r) === "outdated").length;

  const post = (data: Json): void => {
    t.frame()?.contentWindow?.postMessage(data, "*");
  };

  /* The marks painted in the body: every quoted one, the one being edited outlined, answered ones faded (or gone, cleared). */
  createEffect(
    () => ({ list: rows(), mode: mode(), editing: editing()?.n ?? null, ready: ready(), gen: frameGen() }),
    (s) => {
      if (!s.ready) return;

      const marks = s.list.flatMap((r) =>
        r.item.quote ? [{ id: r.id, n: r.item.n, kind: r.item.kind, blocks: r.item.quote.blocks.map((b) => ({ exact: b.exact, prefix: b.prefix, suffix: b.suffix })), done: answered(r), active: !r.sent && s.editing === r.item.n, show: !(answered(r) && s.mode === "clear") }] : [],
      );

      post({ annotPaint: true, marks });
    },
  );

  const opener = (): Element | null => (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);

  /* Focus back on what opened a layer; a list item drawn again since is found by its mark's id. */
  const restore = (el: Element | null): void => {
    const id = el instanceof HTMLElement ? el.dataset["id"] : undefined;
    const back = el && !el.isConnected && id ? document.querySelector(`.mk-item[data-id="${id}"]`) : el;

    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
  };

  function openComposer(e: Editing, said = ""): void {
    if (!editing() && !preview()) composerOpener = opener();
    setProblem(said);
    setEditing(e);
    flush();

    if (textBox) textBox.value = e.comment;

    if (withBox) withBox.value = e.replacement;

    if (!m.coarse()) (e.kind === "replace" ? withBox : textBox)?.focus();
  }

  const openDraft = (n: number): void => {
    const d = drafts().find((x) => x.n === n);

    if (d) openComposer({ n, kind: d.kind, quote: d.quote ?? null, comment: d.comment ?? "", replacement: d.replacement ?? "" });
  };

  function closeComposer(): void {
    setEditing(null);
    setPreview(null);
    setProblem("");
    flush();
    post({ annotClearSel: true });
    restore(composerOpener);
    composerOpener = null;
  }

  function save(): void {
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

    const n = e.n ?? nextNumber(sent(), drafts());
    let item: MarkItem = e.quote && e.kind !== "general" ? { n, kind: e.kind, quote: e.quote } : { n, kind: "general" };

    if (comment) item = { ...item, comment };

    if (item.kind === "replace") item = { ...item, replacement };
    keep(e.n === null ? [...drafts(), item] : drafts().map((d) => (d.n === e.n ? item : d)));
    closeComposer();
  }

  const remove = (): void => {
    const n = editing()?.n;

    if (n !== null && n !== undefined) keep(drafts().filter((d) => d.n !== n));
    closeComposer();
  };

  /* ------------------------------------------------------------------ the sheet and the button */

  const markStuck = (): void => {
    if (!list || !ctl) return;
    setStuck(sheet() ? list.scrollTop > 0 : list.getBoundingClientRect().top < ctl.getBoundingClientRect().top - 1);
  };

  const checkInView = (): void => {
    if (sheet() || !section) return;
    const r = section.getBoundingClientRect();
    setInView(r.height > 0 && r.top < innerHeight - 24 && r.bottom > 24);
  };

  function openSheet(): void {
    if (!sheet()) sheetOpener = opener();
    setSheet(true);
    flush();

    if (list) list.scrollTop = 0;
    markStuck();
  }

  function closeSheet(): void {
    setSheet(false);
    flush();
    markStuck();
    checkInView();
    restore(sheetOpener);
    sheetOpener = null;
  }

  /* ------------------------------------------------------------------ send */

  const hostName = (): string => Core.hostOf(m.state);

  /** Who gets the batch, in words. */
  const destOf = (count: number, to: readonly string[] | null): string =>
    deliveryWords({ fleet: t.fleet, ref: t.decision()?.ref || t.decision()?.id || "it", own: !t.relayed, host: hostName(), count, drafts: drafts().length }, to);

  function openPreview(): void {
    const d = t.decision();

    if (!d || !drafts().length) return;

    const batch = makeBatch(
      d,
      t.hash,
      drafts().map((item) => ({ item, outdated: placed().get("d" + String(item.n))?.status === "outdated" })),
    );

    if (!editing() && !preview()) composerOpener = opener() ?? sendButton ?? null;
    setPreview({ batch, dest: destOf(batch.marks.items.length, null), error: "", busy: false });
    flush();
    /* Focus in the preview: Cmd/Ctrl+Enter sends only from there, and a plain Enter sends nothing. */
    previewBox?.focus({ preventScroll: true });
    void fetch("chat/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: batch.text, marks: batch.marks }) })
      .then(async (res): Promise<Json> => (res.ok ? await res.json() : null))
      .then((data) => {
        const to = isRecord(data) && Array.isArray(data["to"]) ? data["to"].map(String) : null;
        const p = preview();

        if (p && p.batch === batch && to?.length) setPreview({ ...p, dest: destOf(batch.marks.items.length, to) });
      })
      .catch(() => undefined);
  }

  async function send(): Promise<void> {
    const p = preview();

    if (!p || p.busy) return;
    const json = JSON.stringify({ text: p.batch.text, marks: p.batch.marks });
    const over = Core.tooBig(json, m.maxBytes());

    if (over) {
      setPreview({ ...p, error: over });

      return;
    }

    setPreview({ ...p, busy: true, error: "" });
    flush();

    try {
      const res = await fetch("chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
      let data: Json = null;

      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.status !== 201) {
        const said = isRecord(data) ? data["error"] : undefined;
        setPreview({ ...p, busy: false, error: said === String(said) && said ? said : `The server refused the marks (${String(res.status)}). They are kept.` });

        return;
      }

      ui.addMessage(data, true);
      const gone = new Set(p.batch.marks.items.map((i) => i.n));
      keep(drafts().filter((d) => !gone.has(d.n)));
      closeComposer();
    } catch {
      setPreview({ ...p, busy: false, error: "Could not reach the dashboard's server. The marks are kept; send again when it is back." });
    } finally {
      flush();
    }
  }

  /* ------------------------------------------------------------------ keys and the frame */

  /** Esc: the topmost layer closes, one per press. */
  function dismissTop(): boolean {
    if (editing() || preview()) {
      closeComposer();

      return true;
    }

    if (sheet()) {
      closeSheet();

      return true;
    }

    return false;
  }

  /**
   * Cmd/Ctrl+Enter, pressed on this page: what focus is in decides, and it acts on that one target only.
   * In the preview it sends; in the composer it saves; on the marks' list or nowhere (no other layer open)
   * it opens the preview. Anywhere else (the chat's box, another field, a frame) it is not the marks' key.
   */
  function submitTop(): boolean {
    const a = document.activeElement;
    const nowhere = a === null || a === document.body || a === document.documentElement;

    if (preview()) {
      if (!previewBox?.contains(a)) return false;
      void send();

      return true;
    }

    if (editing()) {
      if (!composerBox?.contains(a)) return false;
      save();

      return true;
    }

    if (!(nowhere || section?.contains(a)) || (a instanceof Element && a.matches("textarea, input, select, [contenteditable]")) || !unsent() || !listed()) return false;
    openPreview();

    return true;
  }

  listen(document, "keydown", (e) => {
    if (e.key === "Escape" && dismissTop()) {
      took.add(e);
      e.preventDefault();
    }

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && submitTop()) e.preventDefault();
  });

  const onTap = (id: string): void => {
    const row = rows().find((r) => r.id === id);

    if (!row) return;

    if (!row.sent) {
      openDraft(row.item.n);

      return;
    }

    openSheet();
    document.querySelector<HTMLElement>(`.mk-item[data-id="${id}"]`)?.focus();
  };

  /* A selection the body's frame claims, as a quote read from the page's own reading of the body; null when it does not confirm. */
  const confirmed = (claim: readonly Claimed[] | null): MarkQuote | null => (claim ? (body()?.confirm(claim) ?? null) : null);

  /* A new mark's composer on what the frame claims was selected: the confirmed quote, or none and why. */
  const openOn = (kind: MarkKind, claim: readonly Claimed[] | null): void => {
    const quote = confirmed(claim);

    if (!editing()) openComposer({ n: null, kind, quote, comment: "", replacement: "" }, quote ? "" : UNCONFIRMED);
  };

  /* A tap the frame tells of acts only when it was one: focus in that frame and the user's own press just now (activation the body's scripts cannot make). */
  const tapped = (fr: HTMLIFrameElement): boolean => document.activeElement === fr && globalThis.navigator?.userActivation?.isActive === true;

  listen(window, "message", (e) => {
    const fr = t.frame();

    /* The body frame is sandboxed (origin "null"); a fleet's page on the manager's is this page's origin, and relays the body's messages rebuilt. */
    const said = fr && e.source === fr.contentWindow && e.origin === (t.relayed ? location.origin : "null") ? parseFrameSaid(e.data) : null;

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
        const quote = pending && said.mark === pending.kind ? confirmed(said.claim) : null;

        if (pending && quote) {
          clearTimeout(pending.timer);
          pending = null;

          if (!editing()) openComposer({ n: null, kind: said.mark, quote, comment: "", replacement: "" });
        }

        break;
      }

      case "tap":
        if (tapped(fr)) onTap(said.id);

        break;
      case "esc":
        /* Escape in the frame closes the selection bar only (Overlays.tsx), never a layer of the marks. */
        break;
    }
  });

  const onScroll = (): void => {
    markStuck();
    checkInView();
  };

  listen(window, "scroll", onScroll);
  listen(window, "resize", checkInView);

  onSettled(() => {
    checkInView();
    /* A frame that was ready before this list was made answers this with where nothing is: it is ready. */
    post({ annotPaint: true, marks: [] });

    if (!("ResizeObserver" in globalThis)) return;
    const head = document.querySelector(".masthead");

    const watch = new ResizeObserver(() => {
      setMast(head?.getBoundingClientRect().height ?? 0);
      checkInView();
    });

    watch.observe(document.body);

    if (head) watch.observe(head);
    onCleanup(() => watch.disconnect());
  });

  const desk: MarkDesk = {
    on,
    begin: (kind, claim) => {
      if (pending) clearTimeout(pending.timer);
      /* The frame's selection as it is at the tap: the one the bar has may lag a drag that just ended. */

      const timer = setTimeout(() => {
        pending = null;
        openOn(kind, claim);
      }, NOW_MS);

      pending = { kind, claim, timer };
      post({ annotNow: kind });
    },
    layered: () => editing() !== null || preview() !== null || sheet(),
    took: (e) => took.has(e),
  };

  markDesk.current = desk;
  onCleanup(() => {
    if (pending) clearTimeout(pending.timer);

    if (markDesk.current === desk) markDesk.current = null;
  });

  /* ------------------------------------------------------------------ the list */

  const onListClick = (e: Event): void => {
    const target = e.target instanceof Element ? e.target : null;

    if (!target || target.closest("details, a")) return;
    const li = target.closest<HTMLElement>(".mk-item");
    const row = rows().find((r) => r.id === li?.dataset["id"]);

    if (row && !row.sent) openDraft(row.item.n);
  };

  const Item = (p: { readonly row: Row }): JSX.Element => {
    const r = (): Row => p.row;
    const status = (): string => statusOf(r());

    const part = (): string => {
      const at = placed().get(r().id);

      return status() !== "outdated" && at && at.total > 1 && at.found < at.total ? ` · ${String(at.found)} of ${String(at.total)} parts still found` : "";
    };

    return (
      <li class={`mk-item k-${r().item.kind}${status() === "outdated" ? " outdated" : ""}${answered(r()) ? " done" : ""}`} data-id={r().id} tabindex="0">
        <span class="mk-n">{r().item.kind === "general" ? "G" : r().item.n}</span>
        <div class="mk-body">
          <div class="mk-top">
            <span class="mk-kind">{KIND_WORDS[r().item.kind]}</span>
            <Show when={status() === "outdated" || status() === "moved"}>
              <span class={"mk-tag " + status()}>{status()}</span>
            </Show>
            <span class={"mk-tag" + (answered(r()) ? " answered" : r().sent ? " sent" : "")}>{answered(r()) ? "answered" : r().sent ? "sent" : "draft"}</span>
          </div>
          <Show when={r().item.quote}>
            {(q) => (
              <blockquote class={q().blocks.length > 1 ? "multi" : ""}>
                <QuoteView quote={q()} />
              </blockquote>
            )}
          </Show>
          <Show when={r().item.kind === "replace" && r().item.replacement}>
            <div class="mk-with">
              with <b>{r().item.replacement}</b>
            </div>
          </Show>
          <Show when={r().item.comment}>
            <div class="mk-c">{r().item.comment}</div>
          </Show>
          <Show when={r().item.quote}>
            {(q) => <div class="mk-hint">{status() === "outdated" ? "This text is no longer in the decision; the mark keeps its quote." : q().hint + part()}</div>}
          </Show>
        </div>
        <For each={r().answers} keyed={(a) => a.id}>
          {(a) => (
            <details class="mk-reply">
              <summary>
                <span class="who">{a().from === hostName() ? t.fleet : a().from}</span>
                <span class="gist">{a().text}</span>
              </summary>
              <div class="full">
                <Rich text={a().text} />
              </div>
            </details>
          )}
        </For>
      </li>
    );
  };

  const count = (): number => rows().length;
  const away = (): boolean => inView() || ui.picked() !== null || sheet() || editing() !== null || preview() !== null;

  return (
    <Show when={listed()}>
      <section class={"mk-section" + (sheet() ? " holding" : "")} id="mk-section" aria-labelledby="mk-title" style={mast() ? `--mk-top:${String(mast())}px` : undefined} ref={(el) => (section = el)}>
        <div class={"mk-marks" + (sheet() ? " sheeted" : "")} id="mk-marks" tabindex="-1" ref={(el) => (list = el)} onScroll={markStuck}>
          <div class={"mk-ctl" + (stuck() ? " stuck" : "")} id="mk-ctl" ref={(el) => (ctl = el)}>
            <span class="mk-grab" />
            <div class="mk-head">
              <h2 id="mk-title">
                Marks{" "}
                <span class="mk-count" id="mk-count">
                  {count() ? String(count()) + (outdated() ? ` · ${String(outdated())} outdated` : "") : "none"}
                </span>
              </h2>
              <Show when={sheet()}>
                <button type="button" class="btn ghost" id="mk-close" onClick={closeSheet}>
                  Close
                </button>
              </Show>
              <button type="button" class="btn primary" id="mk-send" disabled={!unsent()} ref={(el) => (sendButton = el)} onClick={openPreview}>
                {unsent() ? `Send ${String(unsent())}` : "Send all"} <kbd class="kb">{KB}</kbd>
              </button>
            </div>
            <div class="mk-tools">
              <button type="button" class="btn" id="mk-general" onClick={() => openComposer({ n: null, kind: "general", quote: null, comment: "", replacement: "" })}>
                General comment
              </button>
              <span class="mk-toggle" role="group" aria-label="Answered marks">
                <For each={["keep", "clear"] as const}>
                  {(v) => (
                    <button
                      type="button"
                      id={"mk-" + v}
                      aria-pressed={tf(mode() === v)}
                      onClick={() => {
                        setMode(v);
                        m.prefs.set("marks-answered", v);
                      }}
                    >
                      Answered: {v}
                    </button>
                  )}
                </For>
              </span>
            </div>
          </div>
          <ol class="mk-list" id="mk-list" onClick={onListClick} onKeyDown={(e) => e.key === "Enter" && !e.metaKey && !e.ctrlKey && e.target instanceof HTMLElement && e.target.matches(".mk-item") && onListClick(e)}>
            <For each={shown()} keyed={(r) => r.id} fallback={<li class="mk-empty">No marks yet. Select words in the details to mark them, or add a general comment.</li>}>
              {(r) => <Item row={r()} />}
            </For>
            <For each={sent().loose} keyed={(l) => l.batch}>
              {(l) => (
                <li class="mk-item mk-loose">
                  <span class="mk-n">↩</span>
                  <div class="mk-body">
                    <div class="mk-top">
                      <span class="mk-kind">Answer to your marks</span>
                    </div>
                    <For each={l().answers} keyed={(a) => a.id}>
                      {(a) => <Rich class="mk-c" text={a().text} />}
                    </For>
                  </div>
                </li>
              )}
            </For>
          </ol>
          <Show when={history().length}>
            <details class="mk-history" id="mk-history">
              <summary>History: {history().length} answered</summary>
              <ol class="mk-list" onClick={onListClick}>
                <For each={history()} keyed={(r) => r.id}>
                  {(r) => <Item row={r()} />}
                </For>
              </ol>
            </details>
          </Show>
        </div>
      </section>
      <div class="mk-scrim" hidden={!sheet()} onClick={closeSheet} />
      <button type="button" class={"mk-fab" + (away() ? " away" : "")} id="mk-fab" aria-label="Marks" aria-controls="mk-marks" tabindex={away() ? -1 : 0} onClick={openSheet}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h16v11H9l-5 4z" />
          <path d="M8 9h8M8 12h5" />
        </svg>
        <span class="mk-badge" id="mk-badge" hidden={!count()}>
          {count()}
        </span>
      </button>
      <div class="mk-scrim top" hidden={!editing() && !preview()} onClick={closeComposer} />
      <div class={"mk-sheet k-" + (editing()?.kind ?? "comment")} id="mk-composer" role="dialog" aria-labelledby="mk-c-title" hidden={!editing()} ref={(el) => (composerBox = el)}>
        <h3 id="mk-c-title">{editing()?.n ? `Mark #${String(editing()?.n)}` : editing()?.kind === "general" ? "General comment" : "New mark"}</h3>
        <Show when={editing()?.kind !== "general"}>
          <div class="mk-kinds" id="mk-kinds">
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
          <label>Quoted</label>
          <blockquote id="mk-quote">
            <Show when={editing()?.quote}>{(q) => <QuoteView quote={q()} />}</Show>
          </blockquote>
        </Show>
        <div hidden={editing()?.kind !== "replace"}>
          <label for="mk-with">Replace with</label>
          <textarea id="mk-with" rows="2" maxlength="4000" ref={(el) => (withBox = el)} />
        </div>
        <label for="mk-text">{TEXT_LABEL[editing()?.kind ?? "comment"]}</label>
        <textarea id="mk-text" maxlength="4000" ref={(el) => (textBox = el)} />
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
          <button type="button" class="btn primary" id="mk-save" onClick={save}>
            Save <kbd class="kb">{KB}</kbd>
          </button>
        </div>
      </div>
      <div class="mk-sheet" id="mk-preview" role="dialog" aria-labelledby="mk-p-title" tabindex="-1" hidden={!preview()} ref={(el) => (previewBox = el)}>
        <h3 id="mk-p-title">Send all: the one chat message</h3>
        <p class="mk-dest" id="mk-dest">
          {preview()?.dest}
        </p>
        <pre class="mk-md" id="mk-md">
          {preview()?.batch.text}
        </pre>
        <p class="mk-problem" role="alert" id="mk-error" hidden={!preview()?.error}>
          {preview()?.error}
        </p>
        <div class="mk-acts">
          <button type="button" class="btn ghost" id="mk-back" onClick={closeComposer}>
            Back
          </button>
          <button type="button" class="btn" id="mk-copy" onClick={() => void navigator.clipboard?.writeText(preview()?.batch.text ?? "").catch(() => undefined)}>
            Copy Markdown
          </button>
          <button type="button" class="btn primary" id="mk-go" disabled={preview()?.busy === true} onClick={() => void send()}>
            Send <kbd class="kb">{KB}</kbd>
          </button>
        </div>
      </div>
    </Show>
  );
}
