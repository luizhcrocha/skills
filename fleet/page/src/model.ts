/**
 * The page's state and what changes it: one store for the fleet's state, fed by the stream's `state` events
 * and the poll and reconciled row by row (so a row that did not change keeps its DOM), one for the
 * conversation, fed by `chat` events and sends, and the viewer's own signals (the view, the chat's place,
 * the open sheet, the drafts). The components only read this and call its actions.
 */
import { createMemo, createSignal, createStore, flush, reconcile, type Accessor } from "solid-js";

import { Core, type Agent, type Coordinator, type Decision, type Json, type JsonRecord, type Message, type Place, type Prefs, type Queue, type Quote, type RosterRow, type Skill, type State } from "./core.ts";
import { agoAt } from "./format.ts";

/** Someone the page can name: a worker, or on a manager's page a coordinator under its fleet's name. */
export interface Person {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly agent?: Agent;
  readonly coordinator?: Coordinator;
}

/** The chat's link to the server. */
export type Conn = "off" | "connecting" | "live" | "reconnecting" | "unavailable";

/** Whether a value is a JSON object. */
const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

/** Whether a value is a string. */
const isText = (v: Json | undefined): v is string => v === String(v);

/** The key a row keeps across states: its id, or for an event its moment, kind and words. */
export function rowKey(item: JsonRecord): string | undefined {
  const id = item["id"];

  if (isText(id)) return id;
  const at = item["at"];

  return isText(at) ? `${at}|${String(item["kind"])}|${String(item["text"])}` : undefined;
}

/** Rows with a key each, made unique by a count where two rows would share one. */
export function keyed<T>(rows: readonly T[], key: (row: T) => string): { key: string; row: T }[] {
  const seen = new Map<string, number>();

  return rows.map((row) => {
    const k = key(row);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);

    return { key: n ? `${k}#${n}` : k, row };
  });
}

/**
 * The narrowest window the chat docks in, beside the page; below it the chat is a sheet over the page.
 * page.css's media queries say the same number (dock.test.tsx holds them to it).
 */
export const DOCK_MIN_PX = 920;

/** The media queries the layout follows, as signals. */
function media(query: string): Accessor<boolean> {
  const list = globalThis.matchMedia?.(query);
  const [matches, setMatches] = createSignal(list?.matches ?? false);

  list?.addEventListener("change", () => setMatches(list.matches));

  return matches;
}

/** The skills the session can run, as the hub lists them at `skills`, cached for a minute. */
async function fetchSkills(): Promise<Skill[]> {
  const res = await fetch("skills", { cache: "no-store" });

  if (!res.ok) return [];
  // SAFETY: parsed JSON, read through the checks below.
  const body = (await res.json()) as Json;
  const list = isRecord(body) && Array.isArray(body["skills"]) ? body["skills"] : [];

  return list.filter(isRecord).flatMap((s) => {
    const name = s["name"];

    return isText(name) && name ? [{ name, description: isText(s["description"]) ? s["description"] : "", hint: isText(s["hint"]) ? s["hint"] : "", source: isText(s["source"]) ? s["source"] : "" }] : [];
  });
}

/** The page's model. */
export type Model = ReturnType<typeof createModel>;

/** The model of a page that opened with `initial`. */
export function createModel(initial: State) {
  /* Under the manager's address every fleet's page shares one browser storage: each keeps its own under
     its path (/f/<fleet>/). A page at its own address keeps the plain prefix it always had. */
  const underHub = /^\/f\/[^/]+\//u.test(location.pathname);
  /** Shown inside the manager's page (`?embed=1`): the decision's page alone, with no chat and no notifications. */
  const embed = new URLSearchParams(location.search).get("embed") === "1";

  const prefs: Prefs = Core.prefsOf(
    (() => {
      try {
        return globalThis.localStorage;
      } catch {
        return null;
      }
    })(),
    underHub ? "fleet:" + location.pathname : "fleet:",
  );

  const phone = media("(max-width: 759.98px)");
  const docked = media(`(min-width: ${String(DOCK_MIN_PX)}px)`);
  const coarse = media("(pointer: coarse)");

  /* ------------------------------------------------------------------ the fleet's state */

  const withUrls = (s: State): State => (s.role === "manager" ? { ...s, coordinators: s.coordinators.map((c) => ({ ...c, url: "f/" + encodeURIComponent(c.id) + "/" })) } : s);
  const [state, setState] = createStore<State>(withUrls(initial));
  const [now, setNow] = createSignal(Date.now());
  /** Ticks every 30 s, so "5 min ago" stays current. */
  const [tick, setTick] = createSignal(Date.now());

  setInterval(() => setTick(Date.now()), 30_000);

  const ago = (iso: string | null | undefined): string => agoAt(iso, tick());
  let lastState = JSON.stringify(initial);
  const stateListeners: (() => void)[] = [];

  /** Take a new state: reconciled into the store row by row, by id; unchanged rows keep their DOM. */
  function applyState(next: State): void {
    const shown = withUrls(next);
    setState((draft) => {
      reconcile(shown, rowKey)(draft);
    });
    setNow(Date.now());
    setTick(Date.now());
    flush();

    for (const fn of stateListeners) fn();
  }

  /** A state as it arrived (the stream, a poll): applied when its content differs from the last one. */
  function takeState(raw: string): void {
    let next: State | null = null;

    try {
      // SAFETY: JSON.parse returns JSON; parseState checks it.
      next = Core.parseState(JSON.parse(raw) as Json);
    } catch {
      next = null;
    }

    if (!next) return;
    const key = JSON.stringify(next);

    if (key === lastState) return;
    lastState = key;
    applyState(next);
  }

  const host = createMemo(() => Core.hostOf(state));
  const managed = createMemo(() => state.role === "manager");

  const people = createMemo((): Person[] =>
    state.agents.map((a): Person => ({ id: a.id, name: a.name, status: a.status, agent: a })).concat(state.coordinators.map((c): Person => ({ id: c.id, name: c.id, status: c.status, coordinator: c }))),
  );

  const personIndex = createMemo(() => new Map(people().map((p, i) => [p.id, i])));
  const person = (id: string | null | undefined): Person | undefined => (id ? people()[personIndex().get(id) ?? -1] : undefined);
  /** A participant's spawn colour. */
  const colorOf = (id: string | null | undefined): string => `var(--s${((personIndex().get(id ?? "") ?? -1) % 8) + 1})`;
  /** A participant's colour: the worker's spawn colour, the accent for the host. */
  const colourOfId = (id: string): string => (person(id) ? colorOf(id) : id === host() ? "var(--accent)" : "var(--faint)");
  const nameOf = (id: string): string => person(id)?.name || id;
  const roster = createMemo((): RosterRow[] => Core.rosterOf(state));

  /** A decision of this ledger by its id, else by its number ("D141", any case), as a link from another fleet may name it. */
  const decisionById = (id: string | null | undefined): Decision | undefined =>
    id ? (state.decisions.find((d) => d.id === id) ?? state.decisions.find((d) => d.ref !== undefined && d.ref.toLowerCase() === id.toLowerCase())) : undefined;

  /** The ledger's decisions, and on a manager's page the ones open in each fleet, as "<fleet>/<id>". */
  const everyDecision = createMemo((): Decision[] => state.decisions.concat(state.coordinators.flatMap((c) => c.decisions.map((d) => ({ ...d, id: c.id + "/" + d.id, fleet: c.id })))));
  const everyById = createMemo(() => new Map(everyDecision().map((d) => [d.id, d])));
  /** A decision of this ledger or, on a manager's page, a fleet's ("<fleet>/<id>"). */
  const decisionAnywhere = (id: string | null | undefined): Decision | undefined => (id ? everyById().get(id) : undefined);

  /* Where the manager's page and the fleets' pages live, so moving between them stays on one address: the
     manager's root, and /f/<fleet>/ under it. Null when there is no manager. */
  const hubRoot = (): string | null => (underHub || state.role === "manager" ? "/" : state.manager ? state.manager.url : null);
  const fleetPage = (id: string): string => String(hubRoot()) + "f/" + encodeURIComponent(id) + "/";

  /** The manager's own page: on the hub its /f/<id>/ (the hub's root is the index of every fleet, not the manager). */
  const managerPage = (): string | null =>
    state.role === "manager"
      ? underHub
        ? location.pathname.replace(/^(\/f\/[^/]+\/).*$/u, "$1")
        : "/"
      : state.manager
        ? underHub
          ? "/f/" + encodeURIComponent(state.manager.id) + "/"
          : state.manager.url
        : null;

  /* ------------------------------------------------------------------ the conversation */

  const [chat, setChat] = createStore<{ list: Message[] }>({ list: [] });
  const messageIds = new Set<number>();
  let lastId = 0;
  const messages = (): readonly Message[] => chat.list;
  const messageById = (id: number | null): Message | undefined => (id === null ? undefined : chat.list.find((m) => m.id === id));
  const [conn, setConnSignal] = createSignal<Conn>("off");
  const [write, setWrite] = createSignal<{ ok: boolean; reason: string }>({ ok: true, reason: "" });
  const [you, setYou] = createSignal("");
  /** The most bytes a post to the chat may have, as the stream's hello says; unknown until it does. */
  const [maxBytes, setMaxBytes] = createSignal<number | undefined>(undefined);
  const [reply, setReply] = createSignal<number | null>(null);
  const [quote, setQuote] = createSignal<Quote | null>(null);
  /** The side chat shown: its opener's id, "new" while one is being started, null for the main chat. */
  const [focus, setFocus] = createSignal<number | "new" | null>(null);
  /** The overlay view, below the docked width. */
  const [chatOpen, setChatOpen] = createSignal(false);
  const [collapsedPref, setCollapsedPref] = createSignal<boolean | null>(prefs.get<boolean | null>("chat-collapsed", null));
  const [read, setRead] = createSignal(prefs.get("chat-read", 0));
  const [sending, setSending] = createSignal(false);
  /** Whether the chat shows decision activity (answers, notes and the replies to them) as markers; off unless asked for. */
  const [decisionActivity, setDecisionActivity] = createSignal(prefs.get("chat-decisions", false) === true);
  /** Whether the decision's page goes on to the next that waits once the one shown is answered; on unless turned off. */
  const [advance, setAdvance] = createSignal(prefs.get("decision-advance", true) === true);
  const [visible, setVisible] = createSignal(document.visibilityState === "visible");

  document.addEventListener("visibilitychange", () => setVisible(document.visibilityState === "visible"));

  const chatAvailable = (): boolean => conn() !== "unavailable" && conn() !== "off";
  const chatWritable = (): boolean => chatAvailable() && write().ok;
  const chatCollapsed = (): boolean => collapsedPref() ?? conn() === "unavailable";
  const chatInView = (): boolean => !embed && visible() && (docked() ? !chatCollapsed() : chatOpen());
  const messageListeners: ((m: Message, live: boolean) => void)[] = [];

  /** A message from the stream or from a send, kept once by its id. `live` marks one that arrived after the first replay. */
  function addMessage(received: Json, live: boolean): void {
    const m = Core.parseMessage(received);

    if (!m || messageIds.has(m.id)) return;
    messageIds.add(m.id);
    lastId = Math.max(lastId, m.id);

    for (const fn of messageListeners) fn(m, live);
    setChat((d) => {
      d.list.push(m);
    });
    flush();
  }

  /* ------------------------------------------------------------------ the view */

  const [place, setPlace] = createSignal<Place>(Core.viewOf(location.hash, initial.role === "manager"));
  const viewing = (): string | null => place().decision;
  /** The queue as it was while the decision shown last waited on the viewer. */
  const [waited, setWaited] = createSignal<readonly string[]>([]);
  const queue = createMemo((): Queue => Core.queueOf(everyDecision(), chat.list, viewing(), waited()));

  /* ------------------------------------------------------------------ the composer */

  const [draft, setDraft] = createSignal(String(prefs.get("chat-draft", "")));
  const [skills, setSkills] = createSignal<Skill[]>([]);
  let skillsAt = 0;
  let skillsLoadedAt = 0;
  let skillsAsked: Promise<void> | null = null;

  /** The skills, asked of the hub at most once a minute. */
  function loadSkills(): Promise<void> {
    if (skillsAsked && Date.now() - skillsAt < 60_000) return skillsAsked;
    skillsAt = Date.now();
    skillsAsked = fetchSkills()
      .then((list) => {
        setSkills(list);
        flush();
      })
      .catch(() => {
        setSkills([]);
      })
      .finally(() => {
        skillsLoadedAt = Date.now();
      });

    return skillsAsked;
  }

  /** Name worker `agent`, or without one this fleet, from the page through the hub: "" once it is named,
   * else why not. A fleet that takes a new name moves to its new address. */
  async function rename(name: string, agent?: string): Promise<string> {
    try {
      const res = await fetch("name", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(agent === undefined ? { name } : { agent, name }) });
      // SAFETY: the hub answers a refusal with {error} and a fleet's name with {path}; anything else shows as its status.
      const body = (await res.json().catch(() => ({}))) as { readonly error?: string; readonly path?: string };

      if (!res.ok) return body.error ?? `the hub answered ${String(res.status)}`;

      if (body.path !== undefined && underHub && !location.pathname.startsWith(body.path)) location.replace(body.path + location.hash);

      return "";
    } catch {
      return "the hub did not answer";
    }
  }

  return {
    prefs,
    underHub,
    embed,
    phone,
    docked,
    coarse,
    state,
    now,
    tick,
    ago,
    applyState,
    takeState,
    onState: (fn: () => void) => stateListeners.push(fn),
    host,
    managed,
    people,
    person,
    colorOf,
    colourOfId,
    nameOf,
    roster,
    decisionById,
    everyDecision,
    decisionAnywhere,
    hubRoot,
    fleetPage,
    managerPage,
    chat,
    messages,
    messageById,
    lastId: () => lastId,
    addMessage,
    onMessage: (fn: (m: Message, live: boolean) => void) => messageListeners.push(fn),
    conn,
    setConn: (c: Conn) => setConnSignal(c),
    write,
    setWrite,
    you,
    setYou,
    maxBytes,
    setMaxBytes,
    reply,
    setReply,
    quote,
    setQuote,
    focus,
    setFocus,
    chatOpen,
    setChatOpen,
    collapsedPref,
    setCollapsed: (v: boolean) => {
      setCollapsedPref(v);
      prefs.set("chat-collapsed", v);
    },
    read,
    setRead: (id: number) => {
      setRead(id);
      prefs.set("chat-read", id);
    },
    sending,
    setSending,
    decisionActivity,
    setDecisionActivity: (on: boolean) => {
      setDecisionActivity(on);
      prefs.set("chat-decisions", on);
    },
    advance,
    setAdvance: (on: boolean) => {
      setAdvance(on);
      prefs.set("decision-advance", on);
    },
    chatAvailable,
    chatWritable,
    chatCollapsed,
    chatInView,
    place,
    setPlace,
    viewing,
    queue,
    waited,
    setWaited,
    draft,
    setDraft,
    skills,
    loadSkills,
    rename,
    /** Whether the skills were read in the last minute. */
    skillsFresh: () => skillsLoadedAt > 0 && Date.now() - skillsLoadedAt < 60_000,
  };
}
