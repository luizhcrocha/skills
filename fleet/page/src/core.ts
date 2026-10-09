/**
 * The page's rules that need no browser: the composer's keys, the @token and the /command at the caret, the
 * roster, the conversation's threads, the decisions' order and answers, the viewer's preferences, the
 * state and messages as they arrive. Pure functions over plain values. The build emits this module alone
 * as the template's `fleet-core` script (`var FleetCore`), which `tests/page.test.mjs` evaluates, and the
 * page reads it from there. Who a message reaches, and which @tokens are mentions, is the fleet chat's
 * rule alone (fleet/src/chat): the page renders the `parts` and `to` the server resolved.
 */

/** A JSON value as parsed. */
export type Json = null | boolean | number | string | readonly Json[] | JsonRecord;

/** A JSON object as parsed. */
export interface JsonRecord {
  readonly [key: string]: Json | undefined;
}

/** A message's text after a token was put in it, with where the caret goes. */
export interface Edited {
  readonly text: string;
  readonly caret: number;
}

/** A text the page posts. */
export interface Posted {
  readonly text: string;
  /** A permission's rule as the page showed it: the hub grants that rule alone. */
  readonly rule?: string;
}

/** A lookup of one text by another, for the keys a table names. */
export interface Lookup {
  readonly [key: string]: string | undefined;
}

/** What waits on the user, as a headline, its detail and the tone the page gives it. */
export interface Lead {
  readonly headline: string;
  readonly detail: string;
  readonly tone: string;
}

/** What a notification is to the viewer. */
export interface Weight {
  readonly important: boolean;
  readonly forYou: boolean;
}

/** The questions of a grilling in their threads, with how many wait on the viewer and on the fleet, and
 * whether every question is answered while it is still open: the fleet has yet to record it. */
export interface Grilling {
  readonly questions: GrillEntry[];
  readonly toAnswer: number;
  readonly waiting: number;
  readonly answered: boolean;
}

/** What the page spent, in four figures. */
export interface Spent {
  readonly output: number;
  readonly input: number;
  readonly cached: number;
  readonly answers: number;
}

/** Whether a chat's host reads it. */
export interface Hearing {
  readonly on: boolean;
  readonly seen: number;
  readonly unread: number;
  readonly since: string;
}

/** An option of a decision. */
export interface DecisionOption {
  readonly id: string;
  readonly label?: string;
  readonly consequence?: string;
}

/** A grilling's question. */
export interface Question {
  readonly id: string;
  readonly title?: string;
  readonly body?: string;
  readonly recommend?: string;
  readonly reason?: string;
  readonly status?: string;
  readonly asked?: string;
  readonly of?: string;
  readonly answer?: string;
  readonly dropped?: string;
  /** Its choices, when asked with `--option`. */
  readonly options?: readonly DecisionOption[];
}

/** The call auto mode refused, which a permission lets through once. */
export interface RefusedCall {
  readonly tool: string;
  readonly call: string;
  readonly rule: string;
  readonly cause: string;
  readonly root: string;
  readonly agent_id: string | null;
}

/** A decision as the page renders it. */
export interface Decision {
  readonly id: string;
  readonly ref?: string;
  readonly title: string;
  readonly question: string;
  readonly kind: string;
  readonly status: string;
  readonly blocking: boolean;
  readonly asks: "user" | "manager";
  readonly options: readonly DecisionOption[];
  readonly questions?: readonly Question[];
  readonly opened?: string;
  readonly revised?: string;
  readonly closed?: string;
  readonly answered?: string | boolean | null;
  readonly answer?: string;
  readonly resolution?: string;
  readonly change?: string;
  readonly why?: string;
  readonly recommend?: string;
  readonly reason?: string;
  readonly milestone?: string;
  readonly step?: string;
  readonly agent?: string;
  readonly supersedes?: string;
  readonly secret?: string;
  readonly manual?: string;
  readonly body?: boolean | string;
  readonly page?: boolean;
  /** On a manager's page, the fleet that holds the decision. */
  readonly fleet?: string;
  /** On a manager's page, that fleet's chat about it: the user's answers there and the fleet's replies. */
  readonly said?: readonly Message[] | undefined;
  /** What the fleet does first with the viewer's answer: the item is with the fleet until it is re-presented. */
  readonly held?: string | null;
  /** When the fleet held it. */
  readonly held_at?: string | null;
  /** A permission's refused call. */
  readonly refusal?: RefusedCall | null;
}

/** A worker. */
export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly task: string;
  readonly lane: readonly string[];
  readonly tokens: number;
  readonly duration_ms: number;
  readonly rounds: number;
  readonly skill?: string;
  readonly model?: string;
  /** The thinking effort it was spawned at; absent on a row recorded before efforts were. */
  readonly effort?: string;
  readonly milestone?: string;
  readonly brief?: string;
  readonly report?: string;
  readonly updated?: string;
  readonly active?: string;
  readonly beat?: { readonly tool?: string; readonly event?: string };
  /** Who gave the name: "user" (on this page), "coordinator", "session" (its subagent's); absent while it is the id. */
  readonly name_by?: string;
}

/** A step of the roadmap. */
export interface Step {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly agent?: string;
}

/** A milestone of the roadmap. */
export interface Milestone {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly Step[];
}

/** A roadblock. */
export interface Roadblock {
  readonly id: string;
  readonly ref?: string;
  readonly title: string;
  readonly resolved: boolean;
  readonly severity?: string;
  readonly needs?: string;
  readonly since?: string;
  readonly detail?: string;
  readonly agent?: string;
  readonly decision?: string;
}

/** A link the fleet named. */
export interface Link {
  readonly id: string;
  readonly ref?: string;
  readonly url: string;
  readonly title: string;
  readonly kind: "page" | "dev";
  readonly up: boolean;
  readonly fleet: string;
  readonly note: string;
  readonly decision: string;
}

/** Something the machine serves that no fleet named. */
export interface Found {
  readonly url: string;
  readonly up: boolean;
  readonly fleet: string;
  readonly cwd: string;
  readonly command: string;
  readonly port: number;
}

/** A worker's workspace as the preview shows it: whether the merge takes it, at which commit. */
export interface PreviewWorker {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly included: boolean;
  readonly commit: string;
  readonly change: string;
}

/** A file the preview's merge left conflicted, and the workers whose changes touch it. */
export interface PreviewConflict {
  readonly path: string;
  readonly workers: readonly string[];
}

/** A dev server's state, as the page shows it. */
export interface PreviewServer {
  readonly running: boolean;
  readonly up: boolean;
  readonly port: number | null;
  /** Its log's last error, while the server has not reloaded since. */
  readonly log: string;
  /** In root mode, the public port the hub serves it at, at the root of its own origin; else null. */
  readonly public: number | null;
  /** The https address the hub serves that port at (`https://<MagicDNS name>:<port>/`), or "" while it does not. */
  readonly publicUrl: string;
  /** Why the hub cannot serve https on that port, or "". */
  readonly publicError: string;
}

/** A dev server in one worker's own workspace. */
export interface PreviewOwn extends PreviewServer {
  readonly worker: string;
  readonly url: string;
  readonly address: string;
}

/** The fleet's live preview: every worker's in-progress edits merged and served (`fleet preview`). */
export interface Preview extends PreviewServer {
  /** Its path beside the page (`preview/`), or "" when only per-worker previews run. */
  readonly url: string;
  readonly address: string;
  readonly updater: boolean;
  readonly every: number;
  readonly workers: readonly PreviewWorker[];
  readonly conflicts: readonly PreviewConflict[];
  /** Why the updater's last look failed, or "". */
  readonly error: string;
  readonly updated: string;
  readonly own: readonly PreviewOwn[];
}

/** A row a fleet gives the manager's finder. */
export interface IndexRow {
  readonly group: string;
  readonly title: string;
  readonly ref?: string;
  readonly sub?: string;
  readonly hint?: string;
  readonly hash?: string;
}

/** A coordinator, on a manager's page. */
export interface Coordinator {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly status: string;
  readonly now: string;
  readonly url: string;
  readonly session: string;
  readonly tokens: number;
  readonly roadblocks: number;
  readonly spent: Spent | null;
  readonly hearing: Hearing | null;
  readonly active: string;
  readonly index: readonly JsonRecord[];
  readonly workers: JsonRecord;
  readonly lanes: readonly string[];
  readonly decisions: readonly Decision[];
  readonly updated?: string;
  readonly silent?: readonly JsonRecord[];
}

/** A logged event. */
export interface FleetEvent {
  readonly at: string;
  readonly kind: string;
  readonly text: string;
  readonly agent?: string;
  readonly decision?: string;
  readonly important?: boolean;
}

/** Something held for later. */
export interface Kept {
  readonly id: string;
  readonly text: string;
  readonly at: string;
}

/** A plan usage window as the status line saw it. */
export interface UsageWindow {
  readonly used_percentage?: number;
  readonly resets_at?: number;
  readonly at?: number;
}

/** The state as the page renders it. */
export interface State {
  readonly project: string;
  readonly goal: string;
  readonly status: string;
  readonly now: string;
  readonly started: string;
  readonly updated: string;
  readonly now_at?: string;
  readonly role: "manager" | "coordinator";
  readonly manager: { readonly id: string; readonly url: string; readonly session: string } | null;
  readonly fleet?: string;
  readonly fleets?: readonly string[];
  /** What the hub serves this fleet as: its id and its session's name; null off the hub. */
  readonly named: { readonly id: string; readonly session: string | null } | null;
  readonly coordinators: readonly Coordinator[];
  /** The account whose session captured last: its email (`account`, null when not recorded), `seen`, its windows, and `others`, the same for each other account. */
  readonly usage: JsonRecord | null;
  readonly gate: { readonly fleet: string; readonly what: string; readonly since: string } | null;
  readonly spent: Spent | null;
  readonly hearing: Hearing | null;
  readonly roadmap: readonly Milestone[];
  readonly agents: readonly Agent[];
  readonly roadblocks: readonly Roadblock[];
  readonly decisions: readonly Decision[];
  readonly links: readonly Link[];
  readonly found: readonly Found[];
  readonly kept: readonly Kept[];
  readonly events: readonly FleetEvent[];
  readonly preview: Preview | null;
}

/** A part of a message: text, or a mention of a participant. */
export interface Part {
  readonly text: string;
  readonly mention?: string;
}

/** A chat message as the server stores it. */
export interface Message {
  readonly id: number;
  readonly at: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly text: string;
  readonly re: number | null;
  readonly parts: readonly Part[];
  readonly decision: string;
  readonly author: string;
  readonly quote: Quote | null;
  readonly side: number | null;
}

/**
 * Where a quote was taken, as the page that sent it opens it again: `hash`, the location hash of the place
 * (`#decision/d1`, `#plan`, `#agent-a2`); `anchor`, an element's id there; `message`, a chat message's id
 * when the text was selected in the chat; `page`, the path of another page the place is on (set by the
 * hub on a fleet's copy of the manager's message).
 */
export interface QuoteAt {
  readonly hash: string;
  readonly anchor?: string;
  readonly message?: string;
  readonly page?: string;
}

/** The excerpt of the page a message is about: the text, where it was as words (`from`), and as a place (`at`). */
export interface Quote {
  readonly text: string;
  readonly from: string;
  readonly at?: QuoteAt;
}

/** A key as the composer sees it. */
export interface KeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** What a key in the composer does. */
export type KeyAction = "send" | "blur" | "next" | "prev" | "pick" | "close";

/** A participant the composer can write to. */
export interface RosterRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly task: string;
}

/** A token being typed at the caret: an @mention or a /command. */
export interface TokenAt {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** A skill the fleet's session can run, as the hub lists it. */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly hint: string;
  readonly source: string;
}

/** A thread entry: a message and who it still waits on. */
export interface Entry {
  readonly message: Message;
  readonly waiting: readonly string[];
}

/** A thread of the conversation. */
export interface Thread {
  readonly root: Entry;
  readonly replies: Entry[];
  last: number;
}

/** A side chat. */
export interface Side {
  readonly id: number;
  quote: Message["quote"];
  count: number;
  last: number;
  first: string;
}

/** Where a finder row leads. */
export type Go =
  | { readonly kind: "decision"; readonly id: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "view"; readonly hash: string }
  | { readonly kind: "worker"; readonly id: string }
  | { readonly kind: "message"; readonly id: number; readonly side: number | null };

/** A finder row. */
export interface FindRow {
  /** The row's place, one per row and the same on every state: what the recents and the highlight hold. */
  readonly key: string;
  readonly group: string;
  readonly ref: string;
  readonly title: string;
  readonly sub: string;
  readonly hint: string;
  /** What kind of item a decision row is ("action", "grilling"), said as a pill; "" for the other rows. */
  readonly pill: string;
  readonly go: Go;
}

/** A storage as the preferences use it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A literal's type widened: "" to string, 0 to number, false to boolean. */
export type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T;

/** The viewer's preferences. */
export interface Prefs {
  get<T extends Json>(key: string, fallback: T): Widen<T>;
  set(key: string, value: Json): void;
  remove(key: string): void;
}

/** A notification as the page lists it. */
export interface Notice {
  readonly at: string;
  readonly kind: string;
  readonly text: string;
  readonly decision?: string;
  readonly chat?: number;
  readonly important?: boolean;
}

/** What has been read. */
export interface SeenNotices {
  readonly lastSeen: string;
  readonly chatRead: number;
  readonly readOf: { readonly [decision: string]: string | undefined };
  readonly readKeys: ReadonlySet<string>;
}

/** Something stuck. */
export interface StuckRow {
  readonly fleet: string;
  readonly ref: string;
  readonly title: string;
  readonly since: string;
  readonly what: string;
  readonly id?: string;
  readonly agent?: string;
  /** The kind of the item an unrecorded answer is about. */
  readonly kind?: string;
}

const TOKEN = /[A-Za-z0-9_.-]/u;

const NAME = /^[A-Za-z0-9_.-]+$/u;

/** Whether `v` is a string (a JSON value read without `typeof`). */
const isText = (v: Json | undefined): v is string => v === String(v);

/** Whether `v` is a JSON object. */
const isRow = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

/**
 * What a key in the composer does: "send", "blur", or, while a list (mentions, commands) is open, "next",
 * "prev", "pick" and "close"; null leaves the key to the field. Enter sends and Shift+Enter breaks the
 * line; on a coarse pointer (a finger on an on-screen keyboard) Enter breaks the line and the button
 * sends, though Ctrl or Cmd with Enter still sends. Nothing acts while an input method composes a word.
 * While the list is open, Enter and Tab pick instead of sending.
 */
function keyOf(e: KeyLike | null | undefined, coarse: boolean, listOpen: boolean): KeyAction | null {
  if (!e || e.isComposing === true || e.keyCode === 229) return null;
  const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;

  if (listOpen) {
    if (e.key === "ArrowDown") return "next";

    if (e.key === "ArrowUp") return "prev";

    if ((e.key === "Enter" || e.key === "Tab") && plain) return "pick";

    if (e.key === "Escape") return "close";
  }

  if (e.key === "Escape") return "blur";

  if (e.key !== "Enter" || e.shiftKey || e.altKey) return null;

  if (coarse && !e.ctrlKey && !e.metaKey) return null;

  return "send";
}

/** Who runs the chat of this state: the manager in a manager's, the coordinator in a fleet's. */
const hostOf = (state: { readonly role?: string } | null | undefined): string => (state && state.role === "manager" ? "manager" : "coordinator");

/** A state's fields the roster reads. */
interface RosterSource {
  readonly role?: string;
  readonly status?: string;
  readonly now?: string;
  readonly agents?: readonly { readonly id: string; readonly name?: string; readonly status?: string; readonly task?: string }[];
  readonly coordinators?: readonly { readonly id: string; readonly status?: string; readonly now?: string }[];
}

/**
 * Who can be written to: the host first, then the agents, running ones before the rest, each in spawn
 * order, then in a manager's state the coordinators, each under its fleet's name. The host's status and
 * task are the fleet's.
 */
function rosterOf(state: RosterSource | null | undefined): RosterRow[] {
  const agents = state?.agents ?? [];
  const host = hostOf(state);
  const row = (a: (typeof agents)[number]): RosterRow => ({ id: a.id, name: a.name || a.id, status: a.status || "", task: a.task || "" });

  return [{ id: host, name: host, status: state?.status || "", task: state?.now || "" }].concat(
    agents.filter((a) => a.status === "running").map(row),
    agents.filter((a) => a.status !== "running").map(row),
    (state?.coordinators ?? []).map((c) => ({ id: c.id, name: c.id, status: c.status || "", task: c.now || "" })),
  );
}

/**
 * The token being typed at the caret: {start, end, query} when the caret ends `trigger` and a run of `chars`,
 * and `opens` allows the character before the trigger (undefined at the start of the text), else null.
 */
function tokenAt(given: string | null | undefined, caret: number | null | undefined, trigger: string, chars: RegExp, opens: (before: string | undefined) => boolean): TokenAt | null {
  const text = String(given ?? "");
  let i = Math.max(0, Math.min(caret ?? text.length, text.length));
  const end = i;

  while (i > 0 && chars.test(text[i - 1] ?? "")) i--;

  if (i === 0 || text[i - 1] !== trigger) return null;
  const start = i - 1;

  if (!opens(start > 0 ? text[start - 1] : undefined)) return null;

  return { start, end, query: text.slice(i, end) };
}

/**
 * The mention being typed at the caret: {start, end, query} when the caret ends "@query" and the "@" starts
 * a word (so an address like a@b does not open the list), else null.
 */
function mentionAt(given: string | null | undefined, caret?: number | null): TokenAt | null {
  return tokenAt(given, caret, "@", TOKEN, (before) => before === undefined || !TOKEN.test(before));
}

/**
 * The roster narrowed to `query`, matched by id or name in any case: those starting with it first, then
 * those containing it, each group in roster order.
 */
function filterRoster(roster: readonly RosterRow[], query: string | null | undefined): RosterRow[] {
  const q = String(query ?? "").toLowerCase();

  if (!q) return roster.slice();
  const starts: RosterRow[] = [];
  const has: RosterRow[] = [];

  for (const r of roster) {
    const id = r.id.toLowerCase();
    const name = r.name.toLowerCase();

    if (id.startsWith(q) || name.startsWith(q)) starts.push(r);
    else if (id.includes(q) || name.includes(q)) has.push(r);
  }

  return starts.concat(has);
}

/**
 * The text with the mention at `at` replaced by "@name " (the id when the name is not a mention token), and
 * the caret after it. The rest of a word under the caret is replaced too.
 */
function insertMention(given: string | null | undefined, at: TokenAt, entry: { readonly id: string; readonly name: string }): Edited {
  const text = String(given ?? "");
  let end = at.end;

  while (end < text.length && TOKEN.test(text[end] ?? "")) end++;
  const token = "@" + (NAME.test(entry.name) ? entry.name : entry.id);
  const after = text.slice(end);
  const next = text.slice(0, at.start) + token + (after.startsWith(" ") ? "" : " ") + after;

  return { text: next, caret: at.start + token.length + 1 };
}

const COMMAND = /[A-Za-z0-9_.:-]/u;

/**
 * The command being typed at the caret: {start, end, query} when the caret ends "/query" and the "/" starts
 * the text or follows a space or a newline (so a path like a/b or a URL does not open the list), else null.
 * "/" alone lists every skill.
 */
function commandAt(given: string | null | undefined, caret?: number | null): TokenAt | null {
  return tokenAt(given, caret, "/", COMMAND, (before) => before === undefined || /\s/u.test(before));
}

/**
 * The skills narrowed to `query`, in any case: a name (or its part after the plugin's "plugin:") starting
 * with it first, then a name containing it, then a description containing it, each group in the given
 * order.
 */
function filterSkills(skills: readonly Skill[], query: string | null | undefined): Skill[] {
  const q = String(query ?? "").toLowerCase();

  if (!q) return skills.slice();
  const starts: Skill[] = [];
  const has: Skill[] = [];
  const says: Skill[] = [];

  for (const s of skills) {
    const name = s.name.toLowerCase();
    const bare = name.slice(name.indexOf(":") + 1);

    if (name.startsWith(q) || bare.startsWith(q)) starts.push(s);
    else if (name.includes(q)) has.push(s);
    else if (s.description.toLowerCase().includes(q)) says.push(s);
  }

  return starts.concat(has, says);
}

/** The text with the command at `at` replaced by "/name ", and the caret after it; the rest of the word under the caret goes too. */
function insertCommand(given: string | null | undefined, at: TokenAt, skill: { readonly name: string }): Edited {
  const text = String(given ?? "");
  let end = at.end;

  while (end < text.length && COMMAND.test(text[end] ?? "")) end++;
  const token = "/" + skill.name + " ";
  const after = text.slice(end).replace(/^ /u, "");

  return { text: text.slice(0, at.start) + token + after, caret: at.start + token.length };
}

/**
 * The conversation as threads: each message that answers none (or one not in the log) starts a thread, and
 * every reply, however deep, joins the thread of the message it answers. Threads are ordered by their
 * latest message, so a new reply brings its thread to the end. Each entry carries `waiting`: for a user
 * message, the recipients that have not answered it yet.
 */
function fold(messages: Iterable<Message>): Thread[] {
  const list = [...messages].sort((a, b) => a.id - b.id);
  const byId = new Map(list.map((m) => [m.id, m]));
  const answered = new Set(list.filter((m) => m.re != null).map((m) => String(m.re) + "\u0000" + m.from));
  const entry = (m: Message): Entry => ({ message: m, waiting: m.from === "user" ? (m.to || []).filter((r) => !answered.has(String(m.id) + "\u0000" + r)) : [] });
  const threads = new Map<number, Thread>();

  for (const m of list) {
    let root = m;
    const seen = new Set<number>();

    for (let up = root.re == null ? undefined : byId.get(root.re); up !== undefined && up.id < root.id && !seen.has(root.id); up = root.re == null ? undefined : byId.get(root.re)) {
      seen.add(root.id);
      root = up;
    }

    const t = threads.get(root.id);

    if (root === m || !t) threads.set(m.id, { root: entry(m), replies: [], last: m.id });
    else {
      t.replies.push(entry(m));
      t.last = m.id;
    }
  }

  return [...threads.values()].sort((a, b) => a.last - b.last);
}

/**
 * The side chats among the messages: one per opener, with its quote, how many messages it holds, and its
 * last message's id, in the order they were opened.
 */
function sidesOf(messages: Iterable<Message>): Side[] {
  const sides = new Map<number, Side>();

  for (const m of [...messages].sort((a, b) => a.id - b.id)) {
    if (m.side == null) continue;
    const s = sides.get(m.side) ?? { id: m.side, quote: null, count: 0, last: 0, first: "" };

    if (m.id === m.side) {
      s.quote = m.quote;
      s.first = m.text;
    }

    s.count++;
    s.last = m.id;
    sides.set(m.side, s);
  }

  return [...sides.values()];
}

/** The longest quote a message carries. */
const QUOTE_MAX = 2000;

/**
 * The text a selection toolbar offers: the selected text with its runs of blank space made one, cut to what
 * a message carries. Empty when there is nothing worth quoting.
 */
function excerptOf(text: string | null | undefined): string {
  const t = String(text ?? "")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s*\n\s*/gu, "\n")
    .trim();

  return t.length < 2 ? "" : t.slice(0, QUOTE_MAX);
}

/**
 * The finder's (Ctrl/⌘K) rows: everything the page holds that one would look up, each with where it leads
 * and a key for its place: `d:<id>` a decision (`d:<fleet>/<id>` another fleet's), `w:<id>` a worker, `c:<id>`
 * a chat message, `u:<url>` a link or a fleet, and the rows that lead to a view by their own id.
 */
function findRows(state: Partial<State>, messages: Iterable<Message> | null | undefined): FindRow[] {
  const rows: FindRow[] = [];

  const one = (t: Json | undefined): string =>
    String(t ?? "")
      .replace(/\s+/gu, " ")
      .trim();

  for (const d of state.decisions ?? []) {
    rows.push({
      key: "d:" + d.id,
      group: "decisions",
      ref: d.ref || "",
      title: one(d.title),
      sub: one(d.status === "open" ? d.question : d.answer || d.resolution || d.status),
      hint: d.status === "open" ? "open" : d.status,
      pill: kindWord(d.kind),
      go: { kind: "decision", id: d.id },
    });
  }

  for (const c of state.coordinators ?? []) {
    for (const x of Array.isArray(c.index) ? c.index : []) {
      if (!x || !isText(x["title"]) || !isText(x["group"])) continue;
      const hint = x["hint"];
      const decision = x["group"] === "decisions" && isText(x["hash"]) ? decisionRoute(x["hash"]) : null;
      const url = c.url ? c.url + String(x["hash"] || "") : "";
      rows.push({
        key: decision ? "d:" + c.id + "/" + decision : "x:" + c.id + ":" + x["group"] + ":" + String(x["ref"] || x["title"]),
        group: x["group"],
        ref: String(x["ref"] || ""),
        title: one(x["title"]),
        sub: one(x["sub"]),
        hint: c.id + (hint ? ", " + String(hint) : ""),
        pill: "",
        go: decision ? { kind: "decision", id: c.id + "/" + decision } : { kind: "url", url },
      });
    }
  }

  for (const l of state.links ?? []) rows.push({ key: "u:" + l.url, group: "links", ref: l.ref || "", title: one(l.title), sub: one(l.url), hint: (l.kind === "page" ? "page" : "dev") + (l.up ? "" : ", down"), pill: "", go: { kind: "url", url: l.url } });

  for (const c of state.coordinators ?? []) rows.push({ key: "f:" + c.id, group: "coordinators", ref: "", title: c.id, sub: one(c.now), hint: c.status, pill: "", go: { kind: "url", url: c.url } });

  for (const r of state.roadblocks ?? []) rows.push({ key: "r:" + (r.id || r.ref || r.title), group: "roadblocks", ref: r.ref || "", title: one(r.title), sub: one(r.detail), hint: r.resolved ? "resolved" : "open", pill: "", go: { kind: "view", hash: "#roadblocks" } });

  for (const m of state.roadmap ?? []) for (const st of m.steps || []) rows.push({ key: "p:" + m.id + "/" + st.id, group: "plan", ref: st.id, title: one(st.title), sub: one(m.title), hint: st.status || "", pill: "", go: { kind: "view", hash: "#plan" } });

  for (const a of state.agents ?? []) rows.push({ key: "w:" + a.id, group: "workers", ref: a.id, title: one(a.name), sub: one(a.task), hint: a.status || "", pill: "", go: { kind: "worker", id: a.id } });

  for (const m of [...(messages ?? [])].sort((a, b) => b.id - a.id)) {
    rows.push({
      key: "c:" + String(m.id),
      group: "chat",
      ref: "#" + String(m.id),
      title: one(m.text).slice(0, 140),
      sub: one(m.from === "user" ? m.author || "you" : m.from),
      hint: m.side ? "side chat" : "",
      pill: "",
      go: { kind: "message", id: m.id, side: m.side },
    });
  }

  for (const e of [...(state.events ?? [])].slice(-300).reverse()) {
    rows.push({ key: "g:" + e.at + " " + e.kind + " " + e.text.slice(0, 60), group: "log", ref: "", title: one(e.text).slice(0, 140), sub: one(e.kind + (e.agent ? ", " + e.agent : "")), hint: "", pill: "", go: { kind: "view", hash: "#log" } });
  }

  return rows;
}

/** How many messages to the user arrived after the last one read. */
function unreadCount(messages: Iterable<Message>, readId: number | null | undefined): number {
  let n = 0;

  for (const m of messages) if (m.from !== "user" && m.id > (readId || 0)) n++;

  return n;
}

/**
 * The viewer's preferences in a Storage (the browser's localStorage), each under prefix + key as JSON: read
 * with a default, write, remove. A storage that is missing or throws (a private window, blocked site data)
 * keeps nothing and reads every default.
 */
function prefsOf(storage: StorageLike | null | undefined, prefix: string): Prefs {
  const attempt = <T>(fn: (s: StorageLike) => T, fallback: T): T => {
    try {
      return storage ? fn(storage) : fallback;
    } catch {
      return fallback;
    }
  };

  return {
    get: <T extends Json>(key: string, fallback: T): Widen<T> =>
      attempt(
        (s) => {
          const v = s.getItem(prefix + key);

          // SAFETY: what the page stored under this key is what it reads back; a value it cannot parse throws to the fallback.
          return (v === null ? fallback : JSON.parse(v)) as Widen<T>;
        },
        // SAFETY: a literal fallback is a value of its widened type.
        fallback as Widen<T>,
      ),
    set: (key: string, value: Json): void => attempt((s) => s.setItem(prefix + key, JSON.stringify(value)), undefined),
    remove: (key: string): void => attempt((s) => s.removeItem(prefix + key), undefined),
  };
}

/** A moment's milliseconds, or 0 when it is not one. */
const stamp = (iso: string | null | undefined | boolean): number => {
  const t = Date.parse(String(iso ?? ""));

  return isNaN(t) ? 0 : t;
};

/**
 * The decisions as the user should read them: open and blocking first, then the other open ones, oldest
 * first in each, then the ones the manager looks at first, then the closed ones, newest first. `seen` maps
 * an id to the revision the viewer last opened; an open item never opened is marked "new", one revised
 * since is "changed". A row with a `fleet` is another fleet's, whose own page knows whether it was seen, and
 * carries no mark here.
 */
function decisionRows(decisions: readonly Decision[] | null | undefined, seen: { readonly [id: string]: string | undefined } | null | undefined): { item: Decision; mark: string }[] {
  const rank = (d: Decision): number => (d.status !== "open" ? 3 : d.asks === "manager" ? 2 : d.blocking ? 0 : 1);
  const rows = [...(decisions ?? [])].sort((a, b) => rank(a) - rank(b) || (rank(a) === 3 ? stamp(b.closed) - stamp(a.closed) : stamp(a.opened) - stamp(b.opened)));

  return rows.map((d) => {
    const last = seen?.[d.id];
    const mark = d.status !== "open" || d.fleet ? "" : !last ? "new" : d.revised && stamp(d.revised) > stamp(last) ? "changed" : "";

    return { item: d, mark };
  });
}

/** A grilling's question as its page shows it. */
export interface GrillEntry {
  readonly q: Question;
  readonly depth: number;
  readonly sent: { readonly text: string; readonly at: string; readonly id: number; readonly replied: boolean } | null;
}

/**
 * A grilling as its page shows it: the questions in reading order (a follow-up right under what it
 * follows), each with the answer the viewer sent and the fleet has not recorded yet (the latest "Q3: ..."
 * line of theirs about this grilling since the question was asked, and whether the fleet replied to it),
 * how many still wait on the viewer, and whether every question is answered and the fleet has yet to record it.
 */
function grillState(given: Decision, messages: Iterable<Message> | null | undefined): Grilling {
  const { item, chat } = asItsFleet(given, messages);
  const qs = Array.isArray(item.questions) ? item.questions.filter((q) => q && isText(q.id)) : [];
  const list = [...chat].sort((a, b) => a.id - b.id);

  const sentFor = (q: Question): GrillEntry["sent"] => {
    let sent: { text: string; at: string; id: number } | null = null;

    for (const m of list) {
      if (m.from !== "user" || m.decision !== item.id || stamp(m.at) < stamp(q.asked)) continue;

      for (const line of String(m.text).split("\n")) {
        const hit = /^\s*Q(\d+)\s*:\s*(.*)$/iu.exec(line);

        if (hit && "q" + (hit[1] ?? "") === q.id) sent = { text: hit[2] ?? "", at: m.at, id: m.id };
      }
    }

    const found = sent;

    return found && { ...found, replied: list.some((m) => m.re === found.id && m.from !== "user") };
  };

  const ordered: GrillEntry[] = [];
  const placed = new Set<string>();

  const place = (q: Question, depth: number): void => {
    if (placed.has(q.id)) return;
    placed.add(q.id);
    ordered.push({ q, depth, sent: q.status === "open" ? sentFor(q) : null });
    qs.filter((c) => c.of === q.id).forEach((c) => place(c, depth + 1));
  };

  qs.filter((q) => !q.of || !qs.some((p) => p.id === q.of)).forEach((q) => place(q, 0));
  const toAnswer = ordered.filter((e) => e.q.status === "open" && (!e.sent || e.sent.replied)).length;

  return {
    questions: ordered,
    toAnswer,
    waiting: ordered.filter((e) => e.q.status === "open" && e.sent && !e.sent.replied).length,
    // The ledger's rule (`answeredGrill`, fleet/src/health.ts): open, no question left open. A fleet's grilling
    // on the manager's page carries its open questions only, so none there reads the same.
    answered: item.status === "open" && !ordered.some((e) => e.q.status === "open"),
  };
}

/** A grilling question's choice in the form: the recommendation, the viewer's own words, later, or an option by its id (with its label). */
export interface GrillPick {
  readonly id: string;
  readonly pick: string;
  readonly text?: string | null;
  readonly label?: string | null;
  readonly recommended?: boolean;
}

/**
 * The message a grilling's form sends: one "Q3: answer" line per question the viewer answered now; an option
 * picked reads "Q3: b: <label>", "(as recommended)" when it is, and the viewer's words after it as a note.
 */
function grillAnswerText(item: Decision, picks: readonly GrillPick[]): { text: string } | { error: string } {
  const lines: string[] = [];

  for (const p of picks) {
    const q = (item.questions ?? []).find((x) => x.id === p.id);

    if (!q || p.pick === "later") continue;

    const own = String(p.text ?? "")
      .trim()
      .replace(/\s*\n\s*/gu, " ");

    if (p.pick === "own" && !own) return { error: `${q.id.toUpperCase()}: write your answer, or take the recommendation.` };
    const note = own ? ". " + own : "";

    if (p.pick === "rec") lines.push(`${q.id.toUpperCase()}: ok, as recommended (${String(q.recommend)})${note}`);
    else if (p.pick === "own") lines.push(`${q.id.toUpperCase()}: ${own}`);
    else lines.push(`${q.id.toUpperCase()}: ${p.pick}${p.label ? ": " + p.label : ""}${p.recommended ? " (as recommended)" : ""}${note}`);
  }

  return lines.length ? { text: lines.join("\n") } : { error: "Answer at least one question." };
}

/** A segment of a decision's address, decoded, when it is one `rule` allows. */
function segment(text: string, rule: RegExp): string | null {
  try {
    const v = decodeURIComponent(text);

    return rule.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The decision a location hash names ("#decision/d1"), or null. On a manager's page (`fleets`) it may name
 * another fleet's as "#decision/<fleet>/<id>"; a fleet's id may hold the "@" of a peer's.
 */
function decisionRoute(hash: string | null | undefined, fleets = false): string | null {
  const m = /^#decision\/([^/]+)(?:\/([^/]+))?$/u.exec(String(hash ?? ""));

  if (!m) return null;
  const [, first = "", second] = m;

  if (second === undefined) return segment(first, /^[A-Za-z0-9_.-]+$/u);
  const fleet = fleets ? segment(first, /^[A-Za-z0-9_.@-]+$/u) : null;
  const id = segment(second, /^[A-Za-z0-9_.-]+$/u);

  return fleet && id ? fleet + "/" + id : null;
}

/** The address of a decision's page: each segment encoded, so "<fleet>/<id>" stays a route. */
const decisionHref = (id: string): string => "#decision/" + id.split("/").map(encodeURIComponent).join("/");

/** The fleet and its own id, for a decision the manager's page names as "<fleet>/<id>"; null for the page's own. */
function parseFleetDecision(id: string | null | undefined): { fleet: string; id: string } | null {
  const at = String(id ?? "").indexOf("/");

  return id && at > 0 ? { fleet: id.slice(0, at), id: id.slice(at + 1) } : null;
}

/** An item a question is about as a whole: its id as this page addresses it ("d1", "<fleet>/d1"), its ref, title and question. */
export interface ItemRef {
  readonly id: string;
  readonly ref?: string | undefined;
  readonly title: string;
  readonly question: string;
}

/**
 * The quote a question about a whole item carries (Ask in the chat, Change my answer): its question as the
 * text, its ref and title as where it is from (in `fleet`, on the manager's page), its page as the place.
 * Not `decision`: a message that carries one is an answer.
 */
function itemQuote(d: ItemRef, fleet: string | null = null): Quote {
  const name = [d.ref ?? "", d.title].filter(Boolean).join(" ");

  return { text: excerptOf(d.question) || excerptOf(d.title) || d.title, from: fleet ? `${name}, in ${fleet}` : name, at: { hash: decisionHref(d.id), anchor: "dv-info" } };
}

/** The decision whose page a quote was taken on, as the page addresses it; null for any other place. */
function quoteDecision(q: Quote | null | undefined): string | null {
  const id = /^#decision\/(.+)$/u.exec(q?.at?.hash ?? "")?.[1];

  try {
    return id ? id.split("/").map(decodeURIComponent).join("/") : null;
  } catch {
    return null;
  }
}

/** What waits on the viewer, in order, and where one decision stands in it. */
export interface Queue {
  readonly ids: readonly string[];
  /** The decision's place, from 1; 0 when it does not wait on the viewer. */
  readonly at: number;
  readonly prev: string | null;
  readonly next: string | null;
}

/**
 * The decisions that wait on the viewer in the order of the "Waits on you" list, and the ones before and
 * after `id`, going round to the first after the last. A decision still open keeps its place in that order once answered. One decided since, or gone
 * from the state (a fleet's lists only its open ones), is placed by `waited`, the queue as it was while it
 * waited; else the next is the queue's first.
 */
function queueOf(decisions: readonly Decision[] | null | undefined, messages: Iterable<Message> | null | undefined, id: string | null | undefined, waited: readonly string[] = []): Queue {
  const list = [...(messages ?? [])];
  const rows = decisionRows(decisions, null).filter((r) => r.item.status === "open");
  const ids = rows.filter((r) => awaiting(r.item, list)).map((r) => r.item.id);
  const shown = id ?? "";
  const listed = rows.some((r) => r.item.id === shown);
  const order = (listed || !waited.includes(shown) ? rows.map((r) => r.item.id) : waited).filter((x) => x === shown || ids.includes(x));
  const here = order.indexOf(shown);

  const round = order.find((x) => x !== shown && ids.includes(x)) ?? null;

  return { ids, at: ids.indexOf(shown) + 1, prev: here > 0 ? (order[here - 1] ?? null) : null, next: (here < 0 ? ids[0] : (order[here + 1] ?? round)) ?? null };
}

/**
 * The answer an open decision waits to see recorded: the user's latest message tagged with it and sent after
 * the item last changed, with the fleet's replies to that message. Null when there is none, and for a
 * closed item.
 */
function pendingAnswer(item: Decision | null | undefined, messages: Iterable<Message> | null | undefined): { answer: Message; replies: Message[] } | null {
  if (!item || item.status !== "open" || item.kind === "grill") return null;
  const since = stamp(item.revised || item.opened);
  let answer: Message | null = null;
  const list = [...(messages ?? [])].sort((a, b) => a.id - b.id);

  for (const m of list) if (m.from === "user" && m.decision === item.id && stamp(m.at) >= since) answer = m;
  const found = answer;

  return found && { answer: found, replies: list.filter((m) => m.re === found.id && m.from !== "user") };
}

/** How the answer to an action the viewer ran and that failed begins: `Failed: <what happened>`. */
const FAILED = "Failed:";

/**
 * The viewer's answer that says open action `item` failed: their latest answer since it last changed, when it
 * begins `Failed:`. Null otherwise. Neither a reply nor a hold settles it; a revision (the fix, re-presented)
 * or a withdrawal does. The fleet's `failedAnswer` (fleet/src/health.ts) by the same rule.
 */
function failedAnswer(item: Decision | null | undefined, messages: Iterable<Message> | null | undefined): Message | null {
  if (!item || item.kind !== "action") return null;
  const p = pendingAnswer(item, messages);

  return p && p.answer.text.startsWith(FAILED) ? p.answer : null;
}

/** The first words of a failed answer: its note's first line, cut at 60 characters. */
function failureWords(m: Pick<Message, "text">): string {
  const line = (m.text.slice(FAILED.length).trim().split("\n")[0] ?? "").trim();
  const chars = [...line];

  return chars.length > 60 ? chars.slice(0, 60).join("") + "…" : line;
}

/** What the decision's form gave. */
export interface AnswerForm {
  readonly choice?: string;
  readonly note?: string;
  readonly value?: string;
  readonly done?: boolean;
  /** An action the viewer ran and that failed: the note says what happened. */
  readonly failed?: boolean;
}

/** Why `body`, the JSON a composer would post, is too big to send under the server's limit `max` (from the
 * stream's hello), or "" when it may go or no limit is known: the size counts the body's UTF-8 bytes, as the
 * server's Content-Length does. */
function tooBig(body: string, max: number | undefined): string {
  const bytes = new TextEncoder().encode(body).length;

  if (max === undefined || bytes <= max) return "";

  return `This message is ${Math.ceil(bytes / 1024)} KiB; the most a message can be is ${Math.floor(max / 1024)} KiB. Shorten it, or put the long part in a file and give its path.`;
}

/**
 * What the page posts for the answer given in `form`: {text}, or {error} saying what is missing. A decision
 * is one option with an optional note, or "none" with a note that says what instead; a permission is one of
 * its two options with an optional note, and the rule it showed.
 */
function answerText(item: Decision, form: AnswerForm): Posted | { error: string } {
  const note = String(form.note ?? "").trim();
  const value = String(form.value ?? "").trim();
  const withNote = (text: string): Posted => ({ text: note ? text + "\n" + note : text });

  if (item.kind === "decision" || item.kind === "permission") {
    if (form.choice === "none" && item.kind === "decision") return note ? { text: "None of these: " + note } : { error: "Say what you want instead." };
    const option = (item.options || []).find((o) => o.id === form.choice);

    if (!option) return { error: "Pick one option." };
    const posted = withNote(option.id + ": " + String(option.label));

    return item.kind === "permission" && item.refusal ? { ...posted, rule: item.refusal.rule } : posted;
  }

  if (form.failed && item.kind === "action") return note ? { text: FAILED + " " + note } : { error: "Say what happened: what you ran and what it said." };

  if (form.done) return withNote(item.kind === "secret" ? "Set by hand." : "Done.");

  if (item.kind === "secret") return value ? { text: value } : { error: "Give the reference or the item's name." };

  return value ? { text: value } : { error: "Write your answer." };
}

/** The preview as the page shows it, or null when the fleet has none (the ledger's own `preview` entry, the
 * dev command, is no preview: it has no workers). Paths beside the page only, never another origin. */
function previewOf(v: Json | undefined): Preview | null {
  if (!isRow(v) || !Array.isArray(v["workers"])) return null;
  const text = (x: Json | undefined): string => (isText(x) ? x : "");
  const beside = (x: Json | undefined): string => (isText(x) && /^preview\/(?:[^/?#]+\/)?$/u.test(x) ? x : "");

  const server = (r: JsonRecord): PreviewServer => ({
    running: r["running"] === true,
    up: r["up"] === true,
    port: Number.isFinite(r["port"]) ? Number(r["port"]) : null,
    log: text(r["log"]),
    public: Number.isInteger(r["public"]) && Number(r["public"]) > 0 && Number(r["public"]) < 65536 ? Number(r["public"]) : null,
    publicUrl: text(r["public_url"]).startsWith("https://") ? text(r["public_url"]) : "",
    publicError: text(r["public_error"]),
  });

  return {
    ...server(v),
    url: beside(v["url"]),
    address: text(v["address"]),
    updater: v["updater"] === true,
    every: Number.isFinite(v["every"]) ? Number(v["every"]) : 3,
    workers: v["workers"].filter(isRow).flatMap((w) =>
      isText(w["id"]) ? [{ id: w["id"], name: text(w["name"]) || w["id"], status: text(w["status"]), included: w["included"] === true, commit: text(w["commit"]), change: text(w["change"]) }] : [],
    ),
    conflicts: (Array.isArray(v["conflicts"]) ? v["conflicts"] : []).filter(isRow).flatMap((c) =>
      isText(c["path"]) ? [{ path: c["path"], workers: Array.isArray(c["workers"]) ? c["workers"].filter(isText) : [] }] : [],
    ),
    error: text(v["error"]),
    updated: text(v["updated"]),
    own: (Array.isArray(v["per_worker"]) ? v["per_worker"] : []).filter(isRow).flatMap((w) =>
      isText(w["worker"]) && beside(w["url"]) ? [{ ...server(w), worker: w["worker"], url: beside(w["url"]), address: text(w["address"]) }] : [],
    ),
  };
}

/**
 * The state as the page renders it, from whatever arrived (the embedded script, the stream, a poll): the
 * five texts have to be there, every list is present, and a row that is not a row is dropped. Null when it
 * is not a state, so the page keeps the one it has.
 */
function parseState(value: Json | undefined): State | null {
  if (!isRow(value)) return null;

  for (const key of ["project", "goal", "status", "now", "started"]) if (!isText(value[key])) return null;
  const lists: { [key: string]: JsonRecord[] } = {};

  for (const key of ["roadmap", "agents", "roadblocks", "decisions", "events"]) {
    const rows = value[key] ?? [];

    if (!Array.isArray(rows)) return null;
    lists[key] = rows.filter(isRow);
  }

  const text = <F>(v: Json | undefined, fallback: F): string | F => (isText(v) ? v : fallback);
  const count = <F>(v: Json | undefined, fallback: F): number | F => (Number.isFinite(v) ? Number(v) : fallback);
  const withId = (rows: readonly JsonRecord[]): JsonRecord[] => rows.filter((r) => isText(r["id"]) && r["id"]);
  const list = (v: Json | undefined): JsonRecord[] => (Array.isArray(v) ? v.filter(isRow) : []);

  const decision = (d: JsonRecord): Decision => {
    const built = {
      ...d,
      id: text(d["id"], ""),
      title: text(d["title"], d["id"]),
      question: text(d["question"], ""),
      kind: text(d["kind"], "decision"),
      status: text(d["status"], "open"),
      blocking: d["blocking"] === true,
      asks: d["asks"] === "manager" ? "manager" : "user",
      options: list(d["options"]),
      said: Array.isArray(d["said"]) ? d["said"].flatMap((m) => parseMessage(m) ?? []) : undefined,
    };

    // SAFETY: a decision keeps the ledger's fields as they are and gets the ones the page relies on here; the
    // rows inside (options, questions) pass through as the ledger wrote them, which the renderer validated.
    const isDecision = (_b: typeof built): _b is typeof built & Decision => true;

    if (!isDecision(built)) throw new TypeError("not a decision");

    return built;
  };

  const above = isRow(value["manager"]) && isText(value["manager"]["url"]) && value["manager"]["url"] ? value["manager"] : null;

  const spent = (v: Json | undefined): Spent | null =>
    isRow(v) && ["output", "input", "cached", "answers"].every((k) => Number.isFinite(v[k])) ? { output: Number(v["output"]), input: Number(v["input"]), cached: Number(v["cached"]), answers: Number(v["answers"]) } : null;

  const lane = (v: Json | undefined): string[] => (Array.isArray(v) ? v.map(String) : []);
  const rows = (key: string): JsonRecord[] => lists[key] ?? [];
  const gate = value["gate"];
  const named = value["named"];

  const shown = {
    ...value,
    project: text(value["project"], ""),
    goal: text(value["goal"], ""),
    status: text(value["status"], ""),
    now: text(value["now"], ""),
    started: text(value["started"], ""),
    role: value["role"] === "manager" ? "manager" : "coordinator",
    manager: above && { id: text(above["id"], "manager"), url: above["url"], session: text(above["session"], "") },
    named: isRow(named) && isText(named["id"]) ? { id: named["id"], session: isText(named["session"]) ? named["session"] : null } : null,
    coordinators: withId(list(value["coordinators"])).map((c) => ({
      ...c,
      name: text(c["name"], c["id"]),
      goal: text(c["goal"], ""),
      status: text(c["status"], "unknown"),
      now: text(c["now"], ""),
      url: text(c["url"], ""),
      session: text(c["session"], ""),
      tokens: count(c["tokens"], 0),
      roadblocks: count(c["roadblocks"], 0),
      spent: spent(c["spent"]),
      hearing: hearingOf(c["chat"]),
      active: text(c["active"], ""),
      index: list(c["index"]),
      workers: isRow(c["workers"]) ? c["workers"] : {},
      lanes: lane(c["lanes"]),
      decisions: withId(list(c["decisions"])).map(decision),
    })),
    usage: isRow(value["usage"]) ? value["usage"] : null,
    gate: isRow(gate) && isText(gate["fleet"]) ? { fleet: gate["fleet"], what: text(gate["what"], ""), since: text(gate["since"], "") } : null,
    spent: spent(value["spent"]),
    hearing: hearingOf(value["chat"]),
    updated: text(value["updated"], value["started"]),
    roadmap: withId(rows("roadmap")).map((m) => ({ ...m, title: text(m["title"], m["id"]), steps: withId(Array.isArray(m["steps"]) ? m["steps"].filter(isRow) : []) })),
    agents: withId(rows("agents")).map((a) => ({
      ...a,
      name: text(a["name"], a["id"]),
      status: text(a["status"], ""),
      task: text(a["task"], ""),
      lane: lane(a["lane"]),
      tokens: count(a["tokens"], 0),
      duration_ms: count(a["duration_ms"], 0),
      rounds: count(a["rounds"], 1),
    })),
    roadblocks: withId(rows("roadblocks")).map((r) => ({ ...r, title: text(r["title"], r["id"]), resolved: r["resolved"] === true })),
    decisions: withId(rows("decisions")).map(decision),
    links: withId(list(value["links"]))
      .filter((l) => isText(l["url"]) && /^https?:\/\//u.test(l["url"]))
      .map((l) => ({
        ...l,
        title: text(l["title"], l["id"]),
        kind: l["kind"] === "page" ? "page" : "dev",
        up: l["up"] === true,
        fleet: text(l["fleet"], ""),
        note: text(l["note"], ""),
        decision: text(l["decision"], ""),
      })),
    found: list(value["found"])
      .filter((f) => isText(f["url"]) && f["url"].startsWith('https://'))
      .map((f) => ({ url: f["url"], up: f["up"] === true, fleet: text(f["fleet"], ""), cwd: text(f["cwd"], ""), command: text(f["command"], ""), port: count(f["port"], 0) })),
    kept: withId(list(value["kept"])).map((k) => ({ ...k, text: text(k["text"], ""), at: text(k["at"], "") })),
    preview: previewOf(value["preview"]),
    events: rows("events")
      .filter((e) => isText(e["text"]) && isText(e["kind"]))
      .map((e) => ({ ...e, at: text(e["at"], "") })),
  };

  // SAFETY: every field the page reads was checked or defaulted above; the rest passes through as the ledger wrote it.
  const isState = (_b: typeof shown): _b is typeof shown & State => true;

  return isState(shown) ? shown : null;
}

/**
 * Whether a chat's host reads it, as the server reports it: a watch is running (`on`), the last message it
 * read (`seen`), how many from the user wait unread. Null when the server said nothing (a copy of the page,
 * an older server), so the page claims nothing either way.
 */
function hearingOf(v: Json | undefined): Hearing | null {
  if (!isRow(v) || (v["on"] !== true && v["on"] !== false) || !Number.isInteger(v["seen"])) return null;

  return { on: v["on"], seen: Number(v["seen"]), unread: Number.isInteger(v["unread"]) ? Number(v["unread"]) : 0, since: isText(v["since"]) ? v["since"] : "" };
}

/** A cut list: what is shown, and how many more. */
export interface Cut<T> {
  readonly shown: T[];
  readonly more: number;
}

/** A worker the glance names. */
export interface GlanceAgent {
  readonly id: string;
  readonly name: string;
  readonly blocked: boolean;
}

/** A step the glance names. */
export interface GlanceStep {
  readonly id: string;
  readonly title: string | undefined;
}

/** What the ledger says is going on: the workers running, the steps current, the steps next. */
export interface Glance {
  readonly running: Cut<GlanceAgent>;
  readonly current: Cut<GlanceStep>;
  readonly next: Cut<GlanceStep>;
}

/**
 * What the ledger says is going on, computed, so no one has to write it: the workers running, the steps
 * current, the next ones in the plan's order. Each list is cut to `max` with how many more.
 */
function glanceOf(
  state: Pick<State, "roadmap" | "agents">,
  max = 3,
): Glance {
  const cut = <T>(xs: T[]): Cut<T> => ({ shown: xs.slice(0, max), more: Math.max(0, xs.length - max) });
  const steps = (state.roadmap ?? []).flatMap((m) => m.steps ?? []);

  return {
    running: cut((state.agents ?? []).filter((a) => a.status === "running" || a.status === "blocked").map((a) => ({ id: a.id, name: a.name || a.id, blocked: a.status === "blocked" }))),
    current: cut(steps.filter((st) => st.status === "current" || st.status === "blocked").map((st) => ({ id: st.id, title: st.title }))),
    next: cut(steps.filter((st) => st.status === "pending").map((st) => ({ id: st.id, title: st.title }))),
  };
}

/** A row `closedInNow` looks a number up in. */
export interface NumberedRow {
  readonly ref?: string;
  readonly title?: string;
  readonly status?: string;
  readonly hint?: string;
}

/**
 * The decisions a Now line names by number (A6, "infra I2") that are closed already: a line that says
 * something waits on the user when it no longer does. `fleets` maps a fleet id to its rows.
 */
function closedInNow(given: string | null | undefined, own: readonly NumberedRow[] | null | undefined, fleets: { readonly [fleet: string]: readonly NumberedRow[] } | null | undefined): { fleet: string; ref: string; title: string | undefined; status: string }[] {
  const found: { fleet: string; ref: string; title: string | undefined; status: string }[] = [];
  const re = /\b([DAISGLR]\d+)\b/gu;
  const text = String(given ?? "");

  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before =
      text
        .slice(0, m.index)
        .trim()
        .split(/\s+/u)
        .pop()
        ?.toLowerCase()
        .replace(/[,:;(]/gu, "") || "";

    const fleet = Object.keys(fleets ?? {}).find((f) => before === f || before === f.split("-")[0]) || "";
    const rows = fleet ? fleets?.[fleet] : own;
    const ref = m[1] ?? "";
    const d = (rows ?? []).find((x) => x.ref === ref);
    const status = d && (d.status || d.hint);

    if (d && status && status !== "open") found.push({ fleet, ref, title: d.title, status });
  }

  return found;
}

/** Whether a now-line said at `at` is old enough to read as stale: 30 minutes without being said again. */
const staleNow = (at: string | null | undefined, now: number): boolean => !isText(at) || at === "" || isNaN(Date.parse(at)) || now - Date.parse(at) > 30 * 60 * 1000;

/** Whether the user's message `m` is still unread by the host: after the last one its watch printed. */
const unreadBy = (hearing: Hearing | null, m: Pick<Message, "from" | "id">): boolean => hearing !== null && m.from === "user" && m.id > hearing.seen;

/** The longest each field of a quote's place may be, as the server takes it. */
const PLACE_MAX = 200;

/**
 * A quote's place as the server stores it, or null for anything else: strings of at most PLACE_MAX
 * characters, the hash starting with "#", the message a message's id, the page a path on this host.
 */
function parseQuoteAt(value: Json | undefined): QuoteAt | null {
  if (!isRow(value)) return null;
  const { hash, anchor, message, page } = value;
  const fits = (v: Json | undefined): boolean => v === undefined || v === null || (isText(v) && [...v].length <= PLACE_MAX);

  if (!isText(hash) || !hash.startsWith("#") || ![hash, anchor, message, page].every(fits)) return null;

  if (isText(message) && !/^[0-9]+$/u.test(message)) return null;

  if (isText(page) && !/^\/(?![/\\])\S*$/u.test(page)) return null;

  let at: QuoteAt = { hash };

  if (isText(anchor) && anchor) at = { ...at, anchor };

  if (isText(message)) at = { ...at, message };

  if (isText(page)) at = { ...at, page };

  return at;
}

/** A chat message as the server stores it, or null for anything else (an error body, a torn line). */
function parseMessage(value: Json | undefined): Message | null {
  if (!isRow(value)) return null;
  const id = value["id"];
  const from = value["from"];
  const text = value["text"];
  const to = value["to"];

  if (!Number.isInteger(id) || !isText(from) || !isText(text) || !Array.isArray(to)) return null;
  const given = value["parts"];

  const parts: Part[] = Array.isArray(given)
    ? given.filter(isRow).flatMap((p) => {
        const t = p["text"];
        const mention = p["mention"];

        if (!isText(t)) return [];

        return [isText(mention) ? { ...p, text: t, mention } : { ...p, text: t }];
      })
    : [];

  const quote = value["quote"];
  const at = isRow(quote) ? parseQuoteAt(quote["at"]) : null;
  const quoted: { text: string; from: string; at?: QuoteAt } | null = isRow(quote) && isText(quote["text"]) && quote["text"].trim() ? { text: quote["text"], from: isText(quote["from"]) ? quote["from"] : "" } : null;

  if (quoted && at) quoted.at = at;

  return {
    id: Number(id),
    at: isText(value["at"]) ? value["at"] : "",
    from,
    to: to.map(String),
    text,
    re: Number.isInteger(value["re"]) ? Number(value["re"]) : null,
    parts: parts.length ? parts : [{ text }],
    decision: isText(value["decision"]) ? value["decision"] : "",
    author: isText(value["author"]) ? value["author"] : "",
    quote: quoted,
    side: Number.isInteger(value["side"]) ? Number(value["side"]) : null,
  };
}

/** The page's views, in the dock's order. */
const VIEWS: readonly string[] = ["decisions", "plan", "fleet", "links", "log"];

const MOVED: Lookup = { roadmap: "plan", roadblocks: "plan", tokens: "fleet", activity: "log" };

/** Where a hash leads. */
export interface Place {
  readonly view: string;
  readonly decision: string | null;
  readonly anchor: string | null;
}

/**
 * Where a location hash leads: the view, the decision it opens, the element to scroll to. The addresses the
 * page had as one long scroll still lead to where their section went. `fleets` as for `decisionRoute`.
 */
function viewOf(hash: string | null | undefined, fleets = false): Place {
  const decision = decisionRoute(hash, fleets);
  const name = String(hash ?? "").replace(/^#/u, "");
  const moved = MOVED[name];

  if (decision) return { view: "decisions", decision, anchor: null };

  if (VIEWS.includes(name)) return { view: name, decision: null, anchor: null };

  if (moved) return { view: moved, decision: null, anchor: name };

  if (/^agent-[A-Za-z0-9_.-]+$/u.test(name)) return { view: "fleet", decision: null, anchor: name };

  return { view: "decisions", decision: null, anchor: null };
}

/** Whether the fleet holds the item: it has the viewer's answer and works on it before it comes back. */
const isHeld = (d: Pick<Decision, "status" | "held"> | null | undefined): boolean => Boolean(d && d.status === "open" && isText(d.held) && d.held);

/**
 * Whether a decision still waits on the viewer: open, theirs (not the manager's), not held by the fleet, and
 * not answered since it was last asked. An answer sent counts at once, before the fleet records it; a fleet's
 * reply to it does not hand it back (the chat shows the reply), a revision after it does (the item asks
 * anew). A grilling waits while questions are left; a fleet's decision on the manager's page says so itself.
 */
function awaiting(d: Decision | null | undefined, messages: Iterable<Message> | null | undefined): boolean {
  if (!d || d.status !== "open" || d.asks === "manager" || isHeld(d)) return false;

  // A fleet's row from a summary without its chat: what the summary says was answered.
  if (!d.said && d.answered) return false;
  const { item, chat } = asItsFleet(d, messages);

  if (item.kind === "grill") return grillState(item, chat).toAnswer > 0;

  return !pendingAnswer(item, chat);
}

/**
 * A decision as its own fleet's page holds it, with the chat that page reads about it: a fleet's on the
 * manager's page is `<fleet>/<id>` there and carries that fleet's chat about it (`said`), which the manager's
 * chat is not; any other is itself, with the chat given.
 */
function asItsFleet(d: Decision, messages: Iterable<Message> | null | undefined): { item: Decision; chat: Iterable<Message> } {
  const { said, ...item } = d;

  return said ? { item: { ...item, id: d.id.slice(d.id.lastIndexOf("/") + 1) }, chat: said } : { item: d, chat: messages ?? [] };
}

/**
 * Which list a decision belongs in: "active" while it waits on the viewer, "waiting" while it is open but
 * with someone else (an answer sent and not recorded, held by the fleet, the manager's to look at, a grilling
 * with nothing left to answer), "done" once decided or withdrawn.
 */
function bucketOf(d: Decision | null | undefined, messages: Iterable<Message> | null | undefined): string {
  if (!d || d.status !== "open") return "done";

  return awaiting(d, messages) ? "active" : "waiting";
}

/** The decision lists, with their labels. */
const BUCKETS: readonly (readonly [string, string])[] = [
  ["active", "Waits on you"],
  ["waiting", "Waiting"],
  ["done", "Done"],
];

const STUCK_MS = 5 * 60 * 1000;

const SILENT_MS = 20 * 60 * 1000;

/**
 * A worker the ledger says runs that has not been seen for SILENT_MS: no tool call by its heartbeat, else
 * nothing written to its transcript.
 */
const silentWorker = (a: Pick<Agent, "status" | "active">, now: number): boolean => (a.status === "running" || a.status === "blocked") && isText(a.active) && now - stamp(a.active) > SILENT_MS;

/**
 * What is stuck, said first on the page: an answer the fleet has had for more than STUCK_MS and has not
 * recorded, and a fleet that does not read its chat while the user's messages wait there. On a fleet's page
 * `fleets` holds the page itself; on the manager's, every coordinator.
 */
function stuckOf(
  own: Partial<Pick<State, "decisions" | "agents" | "hearing">>,
  coordinators: readonly Partial<Coordinator>[] | null | undefined,
  messages: Iterable<Message> | null | undefined,
  now: number,
): StuckRow[] {
  const rows: StuckRow[] = [];
  const list = [...(messages ?? [])];

  for (const d of own.decisions ?? []) {
    if (d.status !== "open" || d.kind === "grill") continue;
    const p = pendingAnswer(d, list);

    // A hold records the answers given until then; one given after it is news again. A reply in the chat
    // records nothing: only the decision command does (the ledger's `answerRecorded`, fleet/src/health.ts).
    if (!p || (isHeld(d) && stamp(p.answer.at) <= stamp(d.held_at))) continue;

    if (now - stamp(p.answer.at) > STUCK_MS) rows.push({ fleet: "", ref: d.ref || "", title: d.title, since: p.answer.at, what: "answer not recorded", id: d.id, kind: d.kind });
  }

  const hearing = own.hearing;

  if (hearing && !hearing.on && hearing.unread && now - stamp(hearing.since) > STUCK_MS) {
    rows.push({ fleet: "", ref: "", title: `${hearing.unread} message${hearing.unread === 1 ? "" : "s"} unread`, since: hearing.since, what: "chat not read" });
  }

  for (const a of own.agents ?? []) if (silentWorker(a, now)) rows.push({ fleet: "", ref: a.id, title: a.name || a.id, since: a.active ?? "", what: "worker silent", agent: a.id });

  for (const c of coordinators ?? []) {
    const fleet = c.id ?? "";

    for (const w of Array.isArray(c.silent) ? c.silent : []) if (w && isText(w["active"])) rows.push({ fleet, ref: String(w["id"]), title: String(w["name"] || w["id"]), since: w["active"], what: "worker silent" });

    for (const d of c.decisions ?? []) if (isText(d.answered) && now - stamp(d.answered) > STUCK_MS) rows.push({ fleet, ref: d.ref || "", title: d.title, since: d.answered, what: "answer not recorded", id: d.id, kind: d.kind });
    const h = c.hearing;

    if (h && !h.on && h.unread && now - stamp(h.since) > STUCK_MS) rows.push({ fleet, ref: "", title: `${h.unread} message${h.unread === 1 ? "" : "s"} from you unread`, since: h.since, what: "chat not read" });
  }

  return rows.sort((a, b) => stamp(a.since) - stamp(b.since));
}

/** Each kind of item in words, singular and plural, in the order a count names them. */
const KIND_NAMES: readonly (readonly [string, string, string])[] = [
  ["decision", "decision", "decisions"],
  ["action", "action", "actions"],
  ["input", "input", "inputs"],
  ["secret", "secret", "secrets"],
  ["grill", "grilling", "grillings"],
  ["permission", "permission", "permissions"],
];

/** An item's kind as one word ("action", "grilling"); one the page does not know reads as a decision. */
const kindWord = (kind: string | null | undefined): string => (KIND_NAMES.find((k) => k[0] === kind) ?? KIND_NAMES[0] ?? ["", "decision"])[1];

/**
 * Items counted by kind, in words, with the verb agreeing: "1 action waits", "2 decisions wait", "1 decision
 * and 1 action wait"; three kinds or more are "3 things wait". Empty for no items.
 */
function kindCount(items: readonly Pick<Decision, "kind">[] | null | undefined, verb: readonly [string, string] = ["waits", "wait"]): string {
  const list = items ?? [];

  if (!list.length) return "";

  const known = (kind: string): boolean => KIND_NAMES.some((k) => k[0] === kind);

  const parts = KIND_NAMES.flatMap(([kind, one, many]) => {
    const n = list.filter((d) => (known(d.kind) ? d.kind : "decision") === kind).length;

    return n ? [`${n} ${n === 1 ? one : many}`] : [];
  });

  const words = parts.length > 2 ? `${list.length} things` : parts.join(" and ");

  return `${words} ${list.length === 1 ? verb[0] : verb[1]}`;
}

/** What waits on the user, as the sentence the page opens with: the items given, counted by kind. */
function leadOf(decisions: readonly Pick<Decision, "status" | "asks" | "blocking" | "kind">[] | null | undefined): Lead {
  const open = (decisions ?? []).filter((d) => d.status === "open" && d.asks !== "manager");
  const holding = open.filter((d) => d.blocking).length;

  if (!open.length) return { headline: "Nothing waits on you.", detail: "", tone: "clear" };
  const headline = `${kindCount(open)} on you.`;

  if (!holding) return { headline, detail: "Work goes on meanwhile.", tone: "waiting" };
  const detail = open.length === 1 ? "It blocks work." : holding === open.length ? (holding === 2 ? "Both block work." : "All of them block work.") : `${holding} of them block${holding === 1 ? "s" : ""} work.`;

  return { headline, detail, tone: "blocking" };
}

/**
 * What a notification is to the viewer. `forYou`: it asks them something, is about a decision open for
 * them, or is a message from the fleet (the chat is theirs); the rest is the fleet's own record.
 * `important` (chime, a toast that stays, "needs you"): it asks them something still open. A flag the
 * coordinator set on a routine event does not make it important: only what waits on the viewer does.
 */
function noticeOf(e: Pick<Notice, "decision" | "kind">, openForYou: (id: string) => boolean): Weight {
  const asks = Boolean(e.decision) && openForYou(e.decision ?? "");
  const important = asks && (e.kind === "asked" || e.kind === "blocked" || e.kind === "message");

  return { important, forYou: asks || e.kind === "message" };
}

/**
 * Whether a notification is still unread: newer than "mark all read", a message after the last one read in
 * the chat, not opened from the list, and not about a decision whose page the viewer opened after it
 * arrived.
 */
function unreadNotice(e: Notice, key: string, seen: SeenNotices): boolean {
  const at = stamp(e.at);

  if (seen.lastSeen && at <= stamp(seen.lastSeen)) return false;

  if (e.chat && e.chat <= (seen.chatRead || 0)) return false;

  if (seen.readKeys && seen.readKeys.has(key)) return false;
  const opened = e.decision && seen.readOf ? seen.readOf[e.decision] : undefined;

  return !(opened && at <= stamp(opened));
}

/**
 * The one toast that stands for everything that arrived and was not dismissed: the newest event that needs
 * the viewer, else the newest, with how many more there are. It stays while any of them needs the viewer.
 * Null when nothing is pending.
 */
function toastOf<T extends { readonly important?: boolean }>(pending: readonly T[]): { shown: T; more: number; sticky: boolean } | null {
  const urgent = pending.filter((e) => e.important);
  const from = urgent.length ? urgent : pending;
  const shown = from[from.length - 1];

  if (shown === undefined) return null;

  return { shown, more: pending.length - 1, sticky: urgent.length > 0 };
}

/** The usage windows the page shows, with their labels and, for another account's line, their short names. */
const WINDOWS: readonly (readonly [string, string, string])[] = [
  ["five_hour", "Session, 5 hours", "session"],
  ["seven_day", "Week, 7 days", "week"],
];

/** A usage window as the page shows it. */
export interface UsageRow {
  readonly key: string;
  readonly label: string;
  readonly short: string;
  readonly percent: number;
  readonly tone: string;
  readonly reset: boolean;
  readonly resetsAt: number;
  readonly readAt: number;
}

/**
 * The plan's usage as the status line last saw it, one row per window: how full it is, when it resets, when
 * it was read. A window that reset since the reading starts again from nothing. `usage` is the account whose
 * session captured last (its windows at the top), or one of the others.
 */
function usageOf(usage: Json | undefined, now: number): UsageRow[] {
  const rows: UsageRow[] = [];

  if (!isRow(usage)) return rows;

  for (const [key, label, short] of WINDOWS) {
    const r = usage[key];

    if (!isRow(r) || !Number.isFinite(r["used_percentage"]) || !Number.isFinite(r["resets_at"])) continue;
    const resetsAt = Number(r["resets_at"]) * 1000;
    const reset = resetsAt <= now;
    const percent = reset ? 0 : Math.max(0, Math.min(100, Math.round(Number(r["used_percentage"]))));
    const readAt = Number.isFinite(r["at"]) ? Number(r["at"]) * 1000 : 0;
    rows.push({ key, label, short, percent, tone: percent >= 90 ? "critical" : percent >= 75 ? "warning" : "ok", reset, resetsAt, readAt });
  }

  return rows;
}

/** Whose the reading is: the email of the account whose session captured last, or null when not recorded. */
function usageAccountOf(usage: Json | undefined): string | null {
  return isRow(usage) && isText(usage["account"]) && usage["account"] !== "" ? usage["account"] : null;
}

/** Another account's reading: its email (null when not recorded) and its windows that have not reset. */
export interface UsageOther {
  readonly account: string | null;
  readonly rows: readonly UsageRow[];
}

/**
 * The other accounts with a reading inside a window, in the order sent (the latest first): a window that
 * reset says nothing of now, and an account with none left is left out.
 */
function usageOthersOf(usage: Json | undefined, now: number): UsageOther[] {
  const others = isRow(usage) && Array.isArray(usage["others"]) ? usage["others"] : [];

  return others.flatMap((o: Json) => {
    const rows = usageOf(o, now).filter((r) => !r.reset);

    return isRow(o) && rows.length ? [{ account: isText(o["account"]) ? o["account"] : null, rows }] : [];
  });
}

/** The notification settings, each off, important or all, and who they are about. */
export interface NoticePrefs {
  readonly about: string;
  readonly sound: string;
  readonly toasts: string;
  readonly browser: string;
}

/** The notification settings in one line, for the panel's head while they are folded: sound · toasts · browser. */
function prefsLine(prefs: NoticePrefs): string {
  const word = (v: string): string => (v === "important" ? "important" : v === "all" ? "all" : "off");

  return `${prefs.about === "all" ? "everything" : "to me"} · sound ${word(prefs.sound)} · toasts ${word(prefs.toasts)} · alerts ${word(prefs.browser)}`;
}

/** The page's rules, as one value: what the `fleet-core` script defines as `FleetCore`. */
export const Core = {
  keyOf,
  hostOf,
  rosterOf,
  usageOf,
  usageAccountOf,
  usageOthersOf,
  mentionAt,
  filterRoster,
  insertMention,
  commandAt,
  filterSkills,
  insertCommand,
  fold,
  unreadCount,
  prefsOf,
  toastOf,
  decisionRows,
  decisionRoute,
  decisionHref,
  parseFleetDecision,
  itemQuote,
  quoteDecision,
  queueOf,
  pendingAnswer,
  awaiting,
  isHeld,
  bucketOf,
  BUCKETS,
  kindWord,
  kindCount,
  stuckOf,
  silentWorker,
  findRows,
  grillState,
  grillAnswerText,
  sidesOf,
  excerptOf,
  answerText,
  failedAnswer,
  failureWords,
  tooBig,
  parseState,
  parseMessage,
  parseQuoteAt,
  hearingOf,
  unreadBy,
  noticeOf,
  unreadNotice,
  staleNow,
  glanceOf,
  closedInNow,
  viewOf,
  leadOf,
  prefsLine,
  VIEWS,
  stamp,
};

/** The rules' type, for the page that reads them from the `fleet-core` script. */
export type CoreApi = typeof Core;
