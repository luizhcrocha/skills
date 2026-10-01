/**
 * What the viewer does on the page, across its parts: the view in the address, the chat's place (docked,
 * collapsed, an overlay with its history entry), the composer (its draft, the @mention and /command lists,
 * the "To" line, sending), the worker sheet, the finder, the notifications panel, the selection toolbar.
 * The state of these lives here, in signals no update of the fleet's state touches.
 */
import { createEffect, createMemo, createSignal, flush } from "solid-js";

import { Core, type Decision, type FindRow, type Json, type JsonRecord, type RosterRow, type Skill, type TokenAt } from "./core.ts";
import type { Model } from "./model.ts";
import { createNotify } from "./notify.ts";

/** An open list under the caret: people to mention, or skills to run. */
export type Pick =
  | { readonly kind: "mention"; readonly items: readonly RosterRow[]; readonly at: TokenAt }
  | { readonly kind: "command"; readonly items: readonly Skill[]; readonly at: TokenAt };

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
  quote?: { text: string; from: string };
  side?: number | "new";
}

/** Whether a parsed value is an object rather than null, a list or a scalar. */
const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

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

  const [list, setList] = createSignal<Pick | null>(null);
  const [listIndex, setListIndex] = createSignal(0);
  let dismissed = -1;
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

  function closeList(): void {
    setList(null);
  }

  /** A message from the stream or a send: the conversation stays at its end when it was there. */
  function addMessage(data: Json, live: boolean): void {
    const stick = nearBottom();
    m.addMessage(data, live);

    if (stick) toBottom();
  }

  /** The list under the caret: skills while the first word starts with "/", people after an "@". */
  function updateList(): void {
    const say = refs.say;

    if (!say) return;
    const collapsed = say.selectionStart === say.selectionEnd && document.activeElement === say;
    const command = collapsed ? Core.commandAt(say.value, say.selectionStart) : null;
    const at = collapsed && !command ? Core.mentionAt(say.value, say.selectionStart) : null;
    const token = command ?? at;

    if (!token || token.start === dismissed) {
      if (!token) dismissed = -1;
      closeList();

      return;
    }

    const was = list();
    const same = was !== null && was.at.query === token.query && was.at.start === token.start && was.kind === (command ? "command" : "mention");

    if (command) {
      if (!m.skillsFresh()) {
        void m.loadSkills().then(() => {
          if (refs.say && document.activeElement === refs.say && Core.commandAt(refs.say.value, refs.say.selectionStart)?.query === command.query) updateList();
        });
      }

      const items = Core.filterSkills(m.skills(), command.query);

      if (!items.length) {
        closeList();

        return;
      }

      setList({ kind: "command", items, at: command });
      setListIndex(same ? Math.min(listIndex(), items.length - 1) : 0);
    } else if (at) {
      const items = Core.filterRoster(m.roster(), at.query);

      if (!items.length) {
        closeList();

        return;
      }

      setList({ kind: "mention", items, at });
      setListIndex(same ? Math.min(listIndex(), items.length - 1) : 0);
    }

    flush();
  }

  /** Put the picked person or skill in the text, the caret after it. */
  function pick(i: number): void {
    const open = list();
    const say = refs.say;

    if (!open || !say) return;
    const out = open.kind === "command" ? (open.items[i] ? Core.insertCommand(say.value, open.at, open.items[i]) : null) : open.items[i] ? Core.insertMention(say.value, open.at, open.items[i]) : null;

    if (!out) return;
    say.value = out.text;
    say.setSelectionRange(out.caret, out.caret);
    closeList();
    afterEdit();
  }

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
    const open = list();
    const action = Core.keyOf(e, m.coarse(), open !== null);

    if (!action) return;

    if ((action === "next" || action === "prev") && open) {
      e.preventDefault();
      setListIndex((listIndex() + (action === "next" ? 1 : -1) + open.items.length) % open.items.length);
      flush();

      return;
    }

    if (action === "pick") {
      e.preventDefault();
      pick(listIndex());

      return;
    }

    if (action === "close") {
      e.preventDefault();
      dismissed = open ? open.at.start : -1;
      closeList();

      return;
    }

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

    try {
      const res = await fetch("chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

  /** "Change my answer": the chat, with a first line about the decision. */
  function changeAnswer(d: Decision | undefined): void {
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

    if (g.kind === "decision") location.hash = "#decision/" + g.id;
    else if (g.kind === "url" && g.url) {
      if (newTab || /^https?:/u.test(g.url)) window.open(g.url, "_blank", "noopener");
      else location.href = g.url;
    } else if (g.kind === "worker") {
      location.hash = "#fleet";
      openWorker(g.id);
    } else if (g.kind === "view") location.hash = g.hash;
    else if (g.kind === "message") {
      m.setFocus(g.side ?? null);
      m.setQuote(null);
      flush();
      openChat();
      const el = refs.chatLog?.querySelector(`article.msg[data-id="${g.id}"]`);

      if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.add("found");
        setTimeout(() => el.classList.remove("found"), 1600);
      }
    }
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

  const [picked, setPicked] = createSignal<{ text: string; from: string } | null>(null);
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
    if (live && msg.from !== "user" && !m.chatInView()) notify.message(msg);
  });

  /* ------------------------------------------------------------------ the view in the address */

  let shown = "";

  /** One view at a time: the tab of the view in the address is current, and a decision's page stands in for the views while it is open. */
  function route(): void {
    const at = Core.viewOf(location.hash);
    const id = at.decision;
    const was = m.viewing();
    const place = id ? "decision/" + id : at.view;

    if (id && was !== id) setChangedNote(null);
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
    list,
    listIndex,
    setListIndex,
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
    seen,
    changedNote,
    answeringAgain,
    setAnsweringAgain,
    bucket,
    setBucket,
    revisionOf,
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
