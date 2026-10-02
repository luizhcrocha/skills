/**
 * What the viewer does on the page, across its parts: the view in the address, the chat's place (docked,
 * collapsed, an overlay with its history entry), the composer (its draft, its @mention and /command list,
 * the "To" line, sending), the lists under the caret of every field that writes to a session, the
 * worker sheet, the finder, the notifications panel, the selection toolbar.
 * The state of these lives here, in signals no update of the fleet's state touches.
 */
import { createEffect, createMemo, createSignal, flush } from "solid-js";

import { createCarets } from "./carets.ts";
import { decisionTrail } from "./chatlog.ts";
import { Core, type Decision, type FindRow, type Json, type JsonRecord, type Quote, type QuoteAt } from "./core.ts";
import type { Model } from "./model.ts";
import { createNotify } from "./notify.ts";

/** The timer and sequence number of the recipients preview. */
interface PreviewTimer {
  seq: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** What the page asks the server who a draft would reach. */
interface PreviewBody {
  text: string;
  re?: number;
}

/** What the page posts as a chat message. */
interface ChatBody {
  text: string;
  re?: number;
  quote?: Quote;
  side?: number | "new";
}

/** Whether a parsed value is an object rather than null, a list or a scalar. */
const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

/** Text as a quote is looked for on the page: its runs of white space one space, in lower case. */
const plain = (text: string | null | undefined): string => String(text ?? "").replace(/\s+/gu, " ").trim().toLowerCase();

/**
 * The innermost element in `box` whose text holds the quoted `text` (or, when the excerpt spans more than one,
 * the start of its first line); null when the page no longer has it.
 */
export function quotedIn(box: Element, text: string): Element | null {
  for (const needle of [plain(text), plain(text.split("\n")[0]).slice(0, 60)]) {
    if (needle.length < 2 || !plain(box.textContent).includes(needle)) continue;
    let at: Element = box;

    for (let inner: Element | undefined = box; inner; inner = [...at.children].find((c) => plain(c.textContent).includes(needle))) at = inner;

    return at;
  }

  return null;
}

/** Mark `el` for a moment where it is scrolled to, as the finder marks what it found. */
function markFound(el: Element): void {
  el.scrollIntoView({ block: "center" });
  el.classList.add("found");
  setTimeout(() => el.classList.remove("found"), 1600);
}

/** In `doc`, the quoted text at place `at` (its anchor, else `box`), marked; the anchor itself when the text is gone. */
function markQuoted(doc: Document, box: Element | null, at: QuoteAt, text: string): void {
  const anchor = at.anchor ? doc.getElementById(at.anchor) : null;
  const where = anchor ?? box;
  const found = where ? (quotedIn(where, text) ?? anchor) : null;

  if (found) markFound(found);
}

/** The elements the actions reach. */
export interface Refs {
  say?: HTMLTextAreaElement;
  chatLog?: HTMLOListElement;
  chatTitle?: HTMLHeadingElement;
  chatToggle?: HTMLButtonElement;
  chat?: HTMLElement;
  worker?: HTMLDialogElement;
  finder?: HTMLDialogElement;
  findQ?: HTMLInputElement;
  decision?: HTMLElement;
  panel?: HTMLElement;
  bell?: HTMLButtonElement;
  seltool?: HTMLElement;
  mentions?: HTMLUListElement;
}

/** The viewer's controls. */
export type Ui = ReturnType<typeof createUi>;

/** The filters of the worker list, by their element ids. */
export const FILTERS = ["f-status", "f-milestone", "f-skill", "f-model", "f-q"] as const;

/** One worker filter. */
export type Filter = (typeof FILTERS)[number];

/** The controls of the page over the model `m`. */
export function createUi(m: Model) {
  const refs: Refs = {};
  const store = m.prefs;

  /* ------------------------------------------------------------------ the panel */

  const [panelOpen, setPanelOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpenSignal] = createSignal(store.get("n-settings-open", false));

  const setSettingsOpen = (open: boolean): void => {
    setSettingsOpenSignal(open);
    store.set("n-settings-open", open);
  };

  /* ------------------------------------------------------------------ the chat's place */

  let pushed = false;
  let opener: HTMLElement | null = null;

  const nearBottom = (): boolean => {
    const log = refs.chatLog;

    return !log || log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  };

  const toBottom = (): void => {
    const log = refs.chatLog;

    if (log) log.scrollTop = log.scrollHeight;
  };

  function openChat(): void {
    if (m.docked()) {
      m.setCollapsed(false);
      flush();
      toBottom();

      return;
    }

    if (m.chatOpen()) return;
    const at = document.activeElement;
    opener = at instanceof HTMLElement && at !== document.body && !refs.chat?.contains(at) ? at : null;
    m.setChatOpen(true);

    try {
      history.pushState({ fleetChat: true }, "");
      pushed = true;
    } catch {
      pushed = false;
    }

    flush();
    toBottom();
    (m.chatWritable() ? refs.say : refs.chatTitle)?.focus({ preventScroll: true });
  }

  /** Closing the overlay gives focus back to what opened it. */
  function overlayClosed(): void {
    m.setChatOpen(false);
    closeList();
    flush();
    const back = opener && opener.isConnected && !opener.closest("[inert]") ? opener : refs.chatToggle;
    opener = null;
    back?.focus({ preventScroll: true });
  }

  function closeChat(): void {
    if (m.docked()) {
      m.setCollapsed(true);

      return;
    }

    if (!m.chatOpen()) return;
    refs.say?.blur();

    if (pushed) {
      pushed = false;

      try {
        history.back();
      } catch {
        // the view is closed either way
      }
    }

    overlayClosed();
  }

  addEventListener("popstate", () => {
    if (m.chatOpen()) {
      pushed = false;
      overlayClosed();
    }
  });

  createEffect(
    () => m.docked(),
    (docked) => {
      if (docked && m.chatOpen()) {
        m.setChatOpen(false);
        pushed = false;
        opener = null;
      }
    },
  );

  /* The chat is read up to its newest message from the fleet while it is in view. */
  createEffect(
    () => [m.chatInView(), Math.max(0, ...m.messages().filter((x) => x.from !== "user").map((x) => x.id))] as const,
    ([inView, top]) => {
      if (inView && top > m.read()) m.setRead(top);
    },
  );

  /* ------------------------------------------------------------------ the composer */

  const carets = createCarets(m);
  const composer = carets.make({ id: "mentions", option: "mention-", mentions: true, field: () => refs.say });
  const [to, setTo] = createSignal<readonly string[] | null>(null);
  const [error, setError] = createSignal("");
  const sized = Boolean(globalThis.CSS?.supports?.("field-sizing", "content"));
  const preview: PreviewTimer = { seq: 0, timer: undefined };

  function fit(): void {
    const say = refs.say;

    if (sized || !say) return;
    say.style.height = "auto";
    const cs = getComputedStyle(say);
    const line = parseFloat(cs.lineHeight) || 23;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    say.style.height = String(Math.min(say.scrollHeight, line * 8 + pad)) + "px";
  }

  const closeList = (): void => composer.close();

  /** A message from the stream or a send: the conversation stays at its end when it was there. */
  function addMessage(data: Json, live: boolean): void {
    const stick = nearBottom();
    m.addMessage(data, live);

    if (stick) toBottom();
  }

  /** The composer's list under the caret: skills while the first word starts with "/", people after an "@". */
  const updateList = (): void => composer.update();

  /** Put the picked person or skill in the composer, the caret after it. */
  const pick = (i: number): void => composer.pick(i);

  /** The "To" line: who the server says this text would reach, asked once the viewer pauses. */
  function askPreview(now = false): void {
    clearTimeout(preview.timer);
    const say = refs.say;

    if (!m.chatWritable() || !say || (say.value.trim() === "" && m.reply() == null)) {
      preview.seq++;

      return;
    }

    preview.timer = setTimeout(
      () => {
        const seq = ++preview.seq;
        const body: PreviewBody = { text: say.value };
        const re = m.reply();

        if (re != null) body.re = re;
        void fetch("chat/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
          .then(async (res): Promise<Json> => (res.ok ? await res.json() : null))
          .then((data) => {
            if (seq !== preview.seq) return;
            const given = isRecord(data) ? data["to"] : undefined;
            setTo(Array.isArray(given) ? given.map(String) : null);
          })
          .catch(() => {
            if (seq === preview.seq) setTo(null);
          });
      },
      now ? 0 : 200,
    );
  }

  /** After the text changed: kept as the draft, fitted, the lists and the "To" line asked again. */
  function afterEdit(): void {
    const say = refs.say;

    if (!say) return;

    if (say.value.trim()) store.set("chat-draft", say.value);
    else store.remove("chat-draft");
    m.setDraft(say.value);
    fit();
    updateList();
    askPreview();
  }

  function onKey(e: KeyboardEvent): void {
    if (composer.key(e)) return;
    const action = Core.keyOf(e, m.coarse(), composer.list() !== null);

    if (!action) return;

    if (action === "blur") {
      refs.say?.blur();

      return;
    }

    if (action === "send") {
      e.preventDefault();
      void send();
    }
  }

  async function send(): Promise<void> {
    const say = refs.say;
    const text = say?.value.trim() ?? "";

    if (!say || !text || m.sending() || !m.chatWritable()) return;
    m.setSending(true);
    setError("");
    const body: ChatBody = { text };
    const re = m.reply();
    const quote = m.quote();
    const focus = m.focus();

    if (re != null) body.re = re;

    if (quote) body.quote = { ...quote };

    if (focus != null) body.side = focus;
    const json = JSON.stringify(body);
    const over = Core.tooBig(json, m.maxBytes());

    if (over) {
      setError(over);
      m.setSending(false);
      flush();

      return;
    }

    try {
      const res = await fetch("chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
      let data: Json = null;

      try {
        data = await res.json();
      } catch {
        data = null;
      }

      const record = isRecord(data) ? data : null;

      if (res.status !== 201) {
        setError(String(record?.["error"] || `The server refused the message (${res.status}). Your draft is kept.`));

        return;
      }

      say.value = "";
      store.remove("chat-draft");
      m.setDraft("");
      m.setReply(null);
      m.setQuote(null);
      setTo(null);
      askPreview();
      fit();

      if (focus === "new" && Number.isInteger(record?.["side"])) m.setFocus(Number(record?.["side"]));
      addMessage(data, true);
      closeList();
    } catch {
      setError("Could not reach the dashboard's server. Your draft is kept; send again when it is back.");
    } finally {
      m.setSending(false);
      flush();
    }
  }

  /** Replying: the composer answers a message from the fleet. */
  function replyTo(id: number): void {
    const msg = m.messageById(id);

    if (!msg || msg.from === "user" || !m.chatWritable()) return;
    m.setReply(id);
    flush();
    afterEdit();
    askPreview(true);
    const say = refs.say;
    say?.focus();
    say?.setSelectionRange(say.value.length, say.value.length);
  }

  function clearReply(): void {
    m.setReply(null);
    flush();
    askPreview(true);
  }

  /** Starting a message to a worker, from its sheet. */
  function writeTo(id: string): void {
    openChat();

    if (!m.chatWritable()) return;
    const say = refs.say;

    if (!say) return;
    const name = m.person(id)?.name;
    const token = "@" + (name && /^[A-Za-z0-9_.-]+$/u.test(name) ? name : id);

    if (!say.value.toLowerCase().includes(token.toLowerCase())) say.value = token + " " + say.value.replace(/^\s+/u, "");
    afterEdit();
    say.focus();
    say.setSelectionRange(say.value.length, say.value.length);
  }

  /* ------------------------------------------------------------------ writing from the manager's frame */

  /** Inside the manager's frame, which has no chat: the decision a message is being written about on its page, and the words it starts with. */
  const [askHere, setAskHere] = createSignal<{ readonly id: string; readonly text: string } | null>(null);
  /** The messages sent from the frame about a decision with no thread to reply in: its thread shows them, and the replies to them. */
  const [askedHere, setAskedHere] = createSignal<readonly { readonly decision: string; readonly id: number }[]>([]);

  /** The messages sent from the frame about decision `id` with no thread to reply in. */
  const askedAbout = (id: string): number[] => askedHere().flatMap((a) => (a.decision === id ? [a.id] : []));

  /** "Ask in the chat" inside the manager's frame: a message about `d`, written on its page. */
  function askAbout(d: Decision | undefined): void {
    if (d && m.chatWritable()) setAskHere({ id: d.id, text: `About "${d.title}": ` });
  }

  /** "Change my answer": the chat, with a first line about the decision; inside the manager's frame, written on the decision's page. */
  function changeAnswer(d: Decision | undefined): void {
    if (m.embed) {
      if (d && m.chatWritable()) setAskHere({ id: d.id, text: `About "${d.title}": I want to change my answer. ` });

      return;
    }

    openChat();
    const say = refs.say;

    if (!d || !m.chatWritable() || !say) return;

    if (!say.value.trim()) say.value = `About "${d.title}": I want to change my answer. `;
    afterEdit();
    say.focus();
    say.setSelectionRange(say.value.length, say.value.length);
  }

  /* ------------------------------------------------------------------ the worker sheet */

  const [sheetFor, setSheetFor] = createSignal<string | null>(null);

  function openWorker(id: string): void {
    if (!m.person(id)) return;
    setSheetFor(id);
    flush();

    if (refs.worker && !refs.worker.open) refs.worker.showModal();
  }

  m.onState(() => {
    const id = sheetFor();

    if (id && refs.worker?.open && !m.person(id)) refs.worker.close();
  });

  /* ------------------------------------------------------------------ the finder */

  const [findQuery, setFindQuery] = createSignal("");
  const [foundAt, setFoundAt] = createSignal(0);
  const [finderOpen, setFinderOpen] = createSignal(false);

  const found = createMemo((): FindRow[] => {
    if (!finderOpen()) return [];
    const q = findQuery();
    const rows = Core.findRank(Core.findRows(m.state, m.messages()), q);
    const perGroup = new Map<string, number>();

    return rows.filter((r) => {
      const n = perGroup.get(r.group) ?? 0;
      perGroup.set(r.group, n + 1);

      return q.trim() ? n < 12 : n < 5;
    });
  });

  function openFinder(): void {
    const finder = refs.finder;

    if (!finder) return;

    if (finder.open) {
      refs.findQ?.select();

      return;
    }

    if (refs.findQ) refs.findQ.value = "";
    setFindQuery("");
    setFoundAt(0);
    setFinderOpen(true);
    flush();
    finder.showModal();
    refs.findQ?.focus();
  }

  function go(r: FindRow, newTab: boolean): void {
    refs.finder?.close();
    const g = r.go;

    if (g.kind === "decision") location.hash = Core.decisionHref(g.id);
    else if (g.kind === "url" && g.url) {
      if (newTab || /^https?:/u.test(g.url)) window.open(g.url, "_blank", "noopener");
      else location.href = g.url;
    } else if (g.kind === "worker") {
      location.hash = "#fleet";
      openWorker(g.id);
    } else if (g.kind === "view") location.hash = g.hash;
    else if (g.kind === "message") {
      /* Decision activity the chat leaves out is read on its decision's page. */
      const about = decisionTrail(m.messages()).get(g.id);

      if (about !== undefined && !m.decisionActivity()) {
        location.hash = Core.decisionHref(about);

        return;
      }

      m.setFocus(g.side ?? null);
      m.setQuote(null);
      flush();
      openChat();
      const el = refs.chatLog?.querySelector(`[data-id="${g.id}"]`);

      if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.add("found");
        setTimeout(() => el.classList.remove("found"), 1600);
      }
    }
  }

  /* ------------------------------------------------------------------ a quote's place */

  /**
   * Go back to where quote `q` was taken (`q.at`) and mark the quoted text: a chat message in the chat (its
   * side chat opened); a place on this page by its address, the overlay chat closed on a phone; a fleet's
   * decision framed on the manager's page inside its frame, once it has loaded; another page by loading it.
   */
  function goQuote(q: Quote): void {
    const at = q.at;

    if (!at) return;

    if (at.page && at.page !== location.pathname) {
      location.href = at.page + at.hash;

      return;
    }

    if (at.message) {
      const msg = m.messageById(Number(at.message));

      if (!msg) return;

      if (m.focus() !== msg.side) {
        m.setFocus(msg.side);
        m.setQuote(null);
        m.setReply(null);
      }

      flush();
      openChat();
      const el = refs.chatLog?.querySelector(`[data-id="${CSS.escape(at.message)}"]`);

      if (el) markFound(el);

      return;
    }

    const overlay = !m.docked() && m.chatOpen();

    if (location.hash !== at.hash) {
      /* The overlay's own history entry becomes the place, so Back leaves it for where the chat was opened. */
      if (overlay && pushed) {
        pushed = false;
        location.replace(at.hash);
      } else location.hash = at.hash;
      route();
    } else if (overlay) closeChat();
    flush();
    const place = Core.viewOf(at.hash, m.managed());
    const frame = place.decision && Core.parseFleetDecision(place.decision) ? refs.decision?.querySelector<HTMLIFrameElement>("#dv-embed") : null;

    if (!frame) {
      markQuoted(document, place.decision ? (refs.decision ?? null) : document.querySelector(`section.view[data-view="${place.view}"]`), at, q.text);

      return;
    }

    /* The fleet's page in the frame is this page's origin: the quote is marked in it once it has loaded. */
    const inFrame = (): void => {
      const doc = frame.contentDocument;

      if (doc) markQuoted(doc, doc.getElementById("decision"), at, q.text);
    };

    frame.scrollIntoView({ block: "start" });

    if (frame.contentDocument?.readyState === "complete" && frame.contentDocument.getElementById("decision")) inFrame();
    else frame.addEventListener("load", inFrame, { once: true });
  }

  /* ------------------------------------------------------------------ the decision's page */

  const [seen, setSeen] = createSignal<{ readonly [id: string]: string }>(store.get<{ [id: string]: string }>("d-seen", {}));
  const [changedNote, setChangedNote] = createSignal<{ id: string; at: string; text: string } | null>(null);
  const [answeringAgain, setAnsweringAgain] = createSignal<string | null>(null);
  const [bucket, setBucketSignal] = createSignal(store.get("d-bucket", "active"));

  const setBucket = (b: string): void => {
    setBucketSignal(b);
    store.set("d-bucket", b);
  };

  const revisionOf = (d: Decision): string => d.revised || d.opened || "";

  /** The decision shown that was answered while it was shown, said with what comes next. */
  const [answered, setAnswered] = createSignal<string | null>(null);
  let shownId: string | null = null;
  let shownWaited = false;
  /** The decision answered that the page went on from, said on the one it went to until the user moves on. */
  const [advancedFrom, setAdvancedFrom] = createSignal<string | null>(null);

  /* Answered here, in a fleet's page inside this one, or anywhere the next state tells of: it left the queue while shown. */
  createEffect(
    () => ({ id: m.viewing(), waits: m.queue().at > 0, ids: m.queue().ids }),
    (now) => {
      if (now.waits && now.ids.join("\n") !== m.waited().join("\n")) m.setWaited(now.ids);

      if (now.id !== shownId) setAnswered(null);
      else if (now.id && shownWaited && !now.waits) setAnswered(now.id);
      shownId = now.id;
      shownWaited = now.waits;
    },
  );

  /* Once the decision shown is answered, the page goes on to the next that waits, when asked to and there is one. */
  createEffect(answered, (id) => {
    const next = m.queue().next;

    if (!id || id !== m.viewing() || !next || !m.advance()) return;
    setAdvancedFrom(id);
    location.hash = Core.decisionHref(next);
  });

  /* Opening a decision's page records the revision seen; a revision since the last look is said. */
  createEffect(
    () => {
      const id = m.viewing();
      const d = id ? m.decisionById(id) : undefined;

      return d ? { id: d.id, open: d.status === "open", revised: d.revised ?? "", change: d.change ?? "", revision: revisionOf(d) } : null;
    },
    (d) => {
      if (!d) return;
      const last = seen()[d.id];

      if (d.open && d.revised && last && Core.stamp(d.revised) > Core.stamp(last)) setChangedNote({ id: d.id, at: d.revised, text: d.change });

      if (last !== d.revision) {
        const next = { ...seen(), [d.id]: d.revision };
        setSeen(next);
        store.set("d-seen", next);
      }
    },
  );

  /* ------------------------------------------------------------------ the selection toolbar */

  const [picked, setPicked] = createSignal<Quote | null>(null);
  const [toolAt, setToolAt] = createSignal<{ top: number; left: number } | null>(null);

  /* ------------------------------------------------------------------ notifications */

  const notify = createNotify(m, {
    openChat,
    openPanel: () => {
      setPanelOpen(true);
      notify.showAudioNote();
    },
    panelOpen,
  });

  m.onMessage((msg, live) => {
    if (live && !m.embed && msg.from !== "user" && !m.chatInView()) notify.message(msg);
  });

  /* ------------------------------------------------------------------ the view in the address */

  let shown = "";

  /** One view at a time: the tab of the view in the address is current, and a decision's page stands in for the views while it is open. */
  function route(): void {
    const at = Core.viewOf(location.hash, m.managed());
    const id = at.decision;
    const was = m.viewing();
    const place = id ? "decision/" + id : at.view;

    if (id && was !== id) setChangedNote(null);

    /* The going-on itself leaves the decision answered; leaving the one it landed on, any way, ends the note. */
    if (was !== id && was !== advancedFrom()) setAdvancedFrom(null);
    m.setPlace(at);

    if (!m.docked() && m.chatOpen()) {
      pushed = false;
      overlayClosed();
    }

    if (panelOpen()) setPanelOpen(false);

    if (id) notify.about(id);
    flush();
    const target = at.anchor ? document.getElementById(at.anchor) : null;

    if (target) target.scrollIntoView();
    else if (shown && shown !== place) window.scrollTo(0, 0);

    if (id && was !== id && shown) refs.decision?.focus({ preventScroll: true });
    shown = place;
  }

  /* ------------------------------------------------------------------ the worker list */

  const [filters, setFilters] = createSignal<{ readonly [key in Filter]: string }>({
    "f-status": String(store.get("f-status", "")),
    "f-milestone": String(store.get("f-milestone", "")),
    "f-skill": String(store.get("f-skill", "")),
    "f-model": String(store.get("f-model", "")),
    "f-q": String(store.get("f-q", "")),
  });

  const setFilter = (key: Filter, value: string): void => {
    setFilters({ ...filters(), [key]: value });
    store.set(key, value);
  };

  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set(store.get<string[]>("expanded", [])));

  const toggleExpanded = (id: string): void => {
    const next = new Set(expanded());

    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
    store.set("expanded", [...next]);
  };

  return {
    refs,
    notify,
    panelOpen,
    setPanelOpen,
    settingsOpen,
    setSettingsOpen,
    openChat,
    closeChat,
    nearBottom,
    toBottom,
    addMessage,
    carets,
    composer,
    list: composer.list,
    listIndex: composer.index,
    setListIndex: composer.setIndex,
    pick,
    closeList,
    updateList,
    afterEdit,
    onKey,
    send,
    fit,
    to,
    error,
    setError,
    askPreview,
    replyTo,
    clearReply,
    writeTo,
    changeAnswer,
    askAbout,
    askHere,
    setAskHere,
    askedHere,
    setAskedHere,
    askedAbout,
    sheetFor,
    openWorker,
    finderOpen,
    setFinderOpen,
    findQuery,
    setFindQuery,
    foundAt,
    setFoundAt,
    found,
    openFinder,
    go,
    goQuote,
    seen,
    changedNote,
    answeringAgain,
    setAnsweringAgain,
    bucket,
    setBucket,
    revisionOf,
    answered,
    setAnswered,
    advancedFrom,
    picked,
    setPicked,
    toolAt,
    setToolAt,
    route,
    filters,
    setFilter,
    expanded,
    toggleExpanded,
  };
}
