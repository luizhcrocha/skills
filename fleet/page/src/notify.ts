/**
 * Notifications: every fleet event is one, and so is every chat message from the fleet. What waits on the
 * viewer is important (a chime, a toast that stays, "needs you"). Unread state and preferences live in this
 * browser only. Toasts never stack: one stands for all that arrived.
 */
import { createMemo, createSignal, flush } from "solid-js";

import { Core, type FleetEvent, type Message, type NoticePrefs } from "./core.ts";
import { fleetMark } from "./mark.ts";
import type { Model } from "./model.ts";

/** A notification: an event of the ledger or a message from the fleet. */
export interface Item {
  readonly key: string;
  readonly at: string;
  readonly kind: string;
  readonly text: string;
  readonly agent: string | null;
  readonly decision?: string;
  readonly chat?: number;
  readonly important: boolean;
  readonly forYou: boolean;
}

/** A notification as it arrives, before the page says what it is to the viewer. */
export type Arrival = Omit<Item, "important" | "forYou">;

/** Why browser alerts are off or waiting, and whether the browser cannot show them at all. */
export interface BrowserNote {
  readonly text: string;
  readonly unsupported: boolean;
}

/** The notifications of the page. */
export type Notify = ReturnType<typeof createNotify>;

/** What the page does when a notification is opened. */
export interface NotifyHooks {
  readonly openChat: () => void;
  readonly openPanel: () => void;
  readonly panelOpen: () => boolean;
}

/** Notifications over the model `m`. */
export function createNotify(m: Model, hooks: NotifyHooks) {
  const store = m.prefs;
  const keyOf = (e: { readonly key?: string; readonly at: string; readonly text: string }): string => e.key || e.at + "|" + e.text;
  const [lastSeen, setLastSeen] = createSignal(store.get("n-lastSeen", ""));
  const [readOf, setReadOf] = createSignal<{ readonly [decision: string]: string }>(store.get<{ [decision: string]: string }>("n-readOf", {}));
  const [readKeys, setReadKeys] = createSignal<ReadonlySet<string>>(new Set(store.get<string[]>("n-readKeys", [])));
  const [clearedBefore, setClearedBefore] = createSignal(store.get("n-cleared", ""));

  const [prefs, setPrefs] = createSignal<NoticePrefs>({
    about: store.get("n-about", "mine"),
    sound: store.get("n-sound", "important"),
    toasts: store.get("n-toasts", "all"),
    browser: store.get("n-browser", "off"),
  });

  const [audioNote, setAudioNote] = createSignal(false);
  const [browserTick, setBrowserTick] = createSignal(0);

  const keepRead = (): void => {
    store.set("n-readOf", readOf());
    store.set("n-readKeys", [...readKeys()].slice(-400));
  };

  /** Change one setting, kept in this browser. */
  function setPref(name: keyof NoticePrefs, value: string): void {
    setPrefs({ ...prefs(), [name]: value });
    store.set("n-" + name, value);

    if (name === "browser" && value !== "off" && canNotify() && Notification.permission === "default") void Notification.requestPermission().then(() => setBrowserTick(browserTick() + 1));
    flush();
  }

  /* Browser-level alerts: system notifications while the tab is hidden. Needs a secure origin (the tailnet
     HTTPS URL) and a permission the viewer grants from the panel. */
  const canNotify = (): boolean => "Notification" in globalThis && globalThis.isSecureContext;
  let iconPng: string | null = null;
  const notifIcon = (): string => iconPng || "data:image/svg+xml," + encodeURIComponent(fleetMark(0, false).replace(/\s+/gu, " "));

  try {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      c.getContext("2d")?.drawImage(img, 0, 0, 128, 128);
      iconPng = c.toDataURL("image/png");
    };

    img.src = notifIcon();
  } catch {
    // the svg stands in
  }

  /** Why browser alerts are off or waiting, in one line; empty when they work. */
  const browserNote = createMemo((): BrowserNote => {
    browserTick();

    if (!canNotify()) {
      return {
        text: !globalThis.isSecureContext
          ? "Browser alerts need the https address."
          : /iPhone|iPad|iPod/u.test(navigator.userAgent)
            ? "Safari on iPhone has no browser alerts for web pages; sound and toasts work while the page is open."
            : "Browser alerts are not supported in this browser.",
        unsupported: true,
      };
    }

    if (prefs().browser !== "off" && Notification.permission === "denied") return { text: "Browser alerts are blocked in this browser's site settings.", unsupported: false };

    if (prefs().browser !== "off" && Notification.permission === "default") return { text: "Waiting for permission.", unsupported: false };

    return { text: "", unsupported: false };
  });

  const who = (e: Pick<Item, "agent">): string => (e.agent ? m.nameOf(e.agent) : m.host());

  function browserAlert(e: Item): void {
    const p = prefs();

    if (p.browser === "off" || (p.browser === "important" && !e.important)) return;

    if (!canNotify() || Notification.permission !== "granted" || document.visibilityState === "visible") return;

    try {
      const n = new Notification((e.important ? "Needs you: " : "") + m.state.project, { body: `${who(e)}, ${e.kind}\n${e.text}`, icon: notifIcon(), tag: keyOf(e), requireInteraction: e.important, silent: p.sound === "off" });
      n.onclick = () => {
        window.focus();
        n.close();

        if (e.chat) hooks.openChat();
        else if (e.decision) location.hash = "#decision/" + e.decision;
        else if (!hooks.panelOpen()) hooks.openPanel();
      };
    } catch {
      // the browser refused; the toast and badge still show
    }
  }

  let ctx: AudioContext | null = null;

  const audio = (): AudioContext | null => {
    try {
      ctx = ctx ?? new AudioContext();
    } catch {
      ctx = null;
    }

    return ctx;
  };

  function chime(important: boolean): void {
    const c = audio();

    if (!c || c.state !== "running") {
      setAudioNote(true);

      return;
    }

    setAudioNote(false);
    const notes = important ? [660, 880, 1320] : [880];

    notes.forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = c.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (important ? 0.5 : 0.35));
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + 0.6);
    });
  }

  const unlock = (): void => {
    const c = audio();

    if (c && c.state === "suspended") void c.resume().then(() => setAudioNote(false));
  };

  document.addEventListener("pointerdown", unlock, { passive: true });
  document.addEventListener("keydown", unlock);

  const fromMessage = (msg: Message): Arrival => {
    const arrival: Arrival = {
      key: "chat:" + String(msg.id),
      chat: msg.id,
      at: msg.at,
      kind: "message",
      agent: msg.from === m.host() ? null : msg.from,
      text: msg.text,
    };

    return msg.decision ? { ...arrival, decision: msg.decision } : arrival;
  };

  const fromEvent = (e: FleetEvent): Arrival => {
    const arrival: Arrival = { key: keyOf(e), at: e.at, kind: e.kind, text: e.text, agent: e.agent ?? null };

    return e.decision ? { ...arrival, decision: e.decision } : arrival;
  };

  const openForYou = (id: string): boolean => {
    const d = m.decisionById(id);

    return Boolean(d) && d?.status === "open" && d.asks !== "manager";
  };

  const tag = (e: Arrival): Item => ({ ...e, ...Core.noticeOf(e, openForYou) });
  const wanted = (e: Item): boolean => prefs().about === "all" || e.forYou;

  /** The arrivals the viewer wants, as items, in order. */
  const wantedItems = (arrived: readonly Arrival[]): Item[] =>
    arrived.flatMap((e) => {
      const item = tag(e);

      return wanted(item) ? [item] : [];
    });

  const time = Core.stamp;

  /** Every notification wanted, newest first. */
  const items = createMemo((): Item[] =>
    wantedItems([...m.state.events.map(fromEvent), ...m.messages().filter((x) => x.from !== "user").map(fromMessage)])
      .filter((e) => !clearedBefore() || time(e.at) > time(clearedBefore()))
      .sort((a, b) => time(b.at) - time(a.at)),
  );

  const isUnread = (e: Item): boolean => Core.unreadNotice(e, e.key, { lastSeen: lastSeen(), chatRead: m.read(), readOf: readOf(), readKeys: readKeys() });
  const unread = createMemo(() => items().filter(isUnread));

  /* ------------------------------------------------------------------ toasts */

  const [pending, setPending] = createSignal<Item[]>([]);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = createMemo(() => Core.toastOf(pending()));

  function showPending(next: Item[]): void {
    clearTimeout(toastTimer);
    setPending(next);
    const t = Core.toastOf(next);

    if (t && !t.sticky) {
      toastTimer = setTimeout(() => {
        setPending([]);
      }, 7000);
    }
  }

  function addToast(e: Item, into: Item[]): void {
    const p = prefs();

    if (p.toasts === "off" || (p.toasts === "important" && !e.important)) return;
    into.push(e);
  }

  /** A click on the toast: it goes, and opens what it is about, or the list when it stands for several. */
  function openToast(onButton: boolean): boolean {
    const t = Core.toastOf(pending());
    showPending([]);

    if (!t || onButton) return false;

    if (t.more) {
      if (!hooks.panelOpen()) {
        hooks.openPanel();

        return true;
      }
    } else if (t.shown.chat) hooks.openChat();
    else if (t.shown.decision) location.hash = "#decision/" + t.shown.decision;
    else if (!hooks.panelOpen()) {
      hooks.openPanel();

      return true;
    }

    return false;
  }

  function announce(arrived: readonly Arrival[]): void {
    const fresh = wantedItems(arrived);
    const next = [...pending()];

    fresh.forEach((e) => addToast(e, next));

    if (next.length !== pending().length) showPending(next);
    fresh.forEach(browserAlert);
    const imp = fresh.some((e) => e.important);
    const p = prefs();

    if (fresh.length && (p.sound === "all" || (p.sound === "important" && imp))) chime(imp);
  }

  let booted = false;
  let keys = new Set<string>();

  /** After a state: what is new in the log comes up; on load, only the important events with no decision page. */
  function sync(): void {
    const fresh = booted ? m.state.events.filter((e) => !keys.has(keyOf(e))) : [];
    keys = new Set(m.state.events.map(keyOf));

    if (!booted) {
      booted = true;
      const next: Item[] = [];

      unread()
        .filter((e) => e.important && !e.decision)
        .reverse()
        .forEach((e) => addToast(e, next));

      if (next.length) showPending(next);
    } else announce(fresh.map(fromEvent));
  }

  /** The viewer opened a decision's page: what was pending about it has been seen, and what arrived about it until now is read. */
  function about(decision: string): void {
    showPending(pending().filter((e) => e.decision !== decision));
    setReadOf({ ...readOf(), [decision]: new Date().toISOString() });
    flush();
    keepRead();
  }

  function markRead(): void {
    const at = new Date().toISOString();
    setLastSeen(at);
    store.set("n-lastSeen", at);
  }

  function clear(): void {
    const at = new Date().toISOString();
    setClearedBefore(at);
    store.set("n-cleared", at);
    markRead();
  }

  /** A notification opened from the list is read, whatever it leads to. */
  function readOne(key: string): void {
    setReadKeys(new Set([...readKeys(), key]));
    flush();
    keepRead();
  }

  function testSound(): void {
    unlock();
    setTimeout(() => chime(true), 50);
  }

  return {
    prefs,
    setPref,
    items,
    unread,
    isUnread,
    who,
    toast,
    openToast,
    dismissToast: () => showPending([]),
    sync,
    message: (msg: Message) => announce([fromMessage(msg)]),
    about,
    markRead,
    clear,
    readOne,
    testSound,
    audioNote,
    showAudioNote: () => {
      const c = audio();

      if (c && c.state !== "running") setAudioNote(true);
    },
    browserNote,
  };
}
