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

/** The questions of a grilling in their threads, with how many wait on the viewer and on the fleet. */
export interface Grilling {
  readonly questions: GrillEntry[];
  readonly toAnswer: number;
  readonly waiting: number;
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
  readonly href?: string;
  readonly fleet?: string;
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
  readonly milestone?: string;
  readonly brief?: string;
  readonly report?: string;
  readonly updated?: string;
  readonly active?: string;
  readonly beat?: { readonly tool?: string; readonly event?: string };
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
  readonly coordinators: readonly Coordinator[];
  readonly usage: { readonly [window: string]: UsageWindow | undefined } | null;
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
  readonly quote: { readonly text: string; readonly from: string } | null;
  readonly side: number | null;
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
  readonly group: string;
  readonly ref: string;
  readonly title: string;
  readonly sub: string;
  readonly hint: string;
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
 * The mention being typed at the caret: {start, end, query} when the caret ends "@query" and the "@" starts
 * a word (so an address like a@b does not open the list), else null.
 */
function mentionAt(given: string | null | undefined, caret?: number | null): TokenAt | null {
  const text = String(given ?? "");
  let i = Math.max(0, Math.min(caret ?? text.length, text.length));
  const end = i;

  while (i > 0 && TOKEN.test(text[i - 1] ?? "")) i--;

  if (i === 0 || text[i - 1] !== "@") return null;
  const start = i - 1;

  if (start > 0 && TOKEN.test(text[start - 1] ?? "")) return null;

  return { start, end, query: text.slice(i, end) };
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
 * The command being typed: {start: 0, end, query} while the message starts with "/" and the caret is still
 * in that first word, else null. "/" alone lists every skill.
 */
function commandAt(given: string | null | undefined, caret?: number | null): TokenAt | null {
  const text = String(given ?? "");
  const end = Math.max(0, Math.min(caret ?? text.length, text.length));

  if (!text.startsWith("/") || end === 0) return null;

  for (let i = 1; i < end; i++) if (!COMMAND.test(text[i] ?? "")) return null;

  return { start: 0, end, query: text.slice(1, end) };
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

/** The text with the command at `at` replaced by "/name ", and the caret after it; the rest of the first word goes too. */
function insertCommand(given: string | null | undefined, at: TokenAt, skill: { readonly name: string }): Edited {
  const text = String(given ?? "");
  let end = at.end;

  while (end < text.length && COMMAND.test(text[end] ?? "")) end++;
  const token = "/" + skill.name;
  const after = text.slice(end).replace(/^ /u, "");

  return { text: token + " " + after, caret: token.length + 1 };
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

/** The finder's groups, in the order it shows them, with their headings. */
const FIND_GROUPS: readonly (readonly [string, string])[] = [
  ["decisions", "Decisions and actions"],
  ["links", "Links"],
  ["coordinators", "Coordinators"],
  ["roadblocks", "Roadblocks"],
  ["plan", "Plan"],
  ["workers", "Workers"],
  ["chat", "Chat"],
  ["log", "Log"],
];

/** The one-letter prefixes that narrow the finder to a group. */
const FIND_PREFIX: Lookup = { d: "decisions", l: "links", r: "roadblocks", p: "plan", w: "workers", c: "chat", f: "coordinators" };

/** The finder's (Ctrl/⌘K) rows: everything the page holds that one would look up, each with where it leads. */
function findRows(state: Partial<State>, messages: Iterable<Message> | null | undefined): FindRow[] {
  const rows: FindRow[] = [];

  const one = (t: Json | undefined): string =>
    String(t ?? "")
      .replace(/\s+/gu, " ")
      .trim();

  for (const d of state.decisions ?? []) {
    rows.push({
      group: "decisions",
      ref: d.ref || "",
      title: one(d.title),
      sub: one(d.status === "open" ? d.question : d.answer || d.resolution || d.status),
      hint: d.status === "open" ? "open" : d.status,
      go: { kind: "decision", id: d.id },
    });
  }

  for (const c of state.coordinators ?? []) {
    for (const x of Array.isArray(c.index) ? c.index : []) {
      if (!x || !isText(x["title"]) || !isText(x["group"])) continue;
      const hint = x["hint"];
      rows.push({
        group: x["group"],
        ref: String(x["ref"] || ""),
        title: one(x["title"]),
        sub: one(x["sub"]),
        hint: c.id + (hint ? ", " + String(hint) : ""),
        go: { kind: "url", url: c.url ? c.url + String(x["hash"] || "") : "" },
      });
    }
  }

  for (const l of state.links ?? []) rows.push({ group: "links", ref: l.ref || "", title: one(l.title), sub: one(l.url), hint: (l.kind === "page" ? "page" : "dev") + (l.up ? "" : ", down"), go: { kind: "url", url: l.url } });

  for (const c of state.coordinators ?? []) rows.push({ group: "coordinators", ref: "", title: c.id, sub: one(c.now), hint: c.status, go: { kind: "url", url: c.url } });

  for (const r of state.roadblocks ?? []) rows.push({ group: "roadblocks", ref: r.ref || "", title: one(r.title), sub: one(r.detail), hint: r.resolved ? "resolved" : "open", go: { kind: "view", hash: "#roadblocks" } });

  for (const m of state.roadmap ?? []) for (const st of m.steps || []) rows.push({ group: "plan", ref: st.id, title: one(st.title), sub: one(m.title), hint: st.status || "", go: { kind: "view", hash: "#plan" } });

  for (const a of state.agents ?? []) rows.push({ group: "workers", ref: a.id, title: one(a.name), sub: one(a.task), hint: a.status || "", go: { kind: "worker", id: a.id } });

  for (const m of [...(messages ?? [])].sort((a, b) => b.id - a.id)) {
    rows.push({
      group: "chat",
      ref: "#" + String(m.id),
      title: one(m.text).slice(0, 140),
      sub: one(m.from === "user" ? m.author || "you" : m.from),
      hint: m.side ? "side chat" : "",
      go: { kind: "message", id: m.id, side: m.side },
    });
  }

  for (const e of [...(state.events ?? [])].slice(-300).reverse()) rows.push({ group: "log", ref: "", title: one(e.text).slice(0, 140), sub: one(e.kind + (e.agent ? ", " + e.agent : "")), hint: "", go: { kind: "view", hash: "#log" } });

  return rows;
}

/**
 * The rows a query finds, best first: "d fix" looks in decisions only, "D3" finds that number first, and
 * every word must appear in the title, the second line or the number.
 */
function findRank(rows: readonly FindRow[], query: string | null | undefined): FindRow[] {
  let q = String(query ?? "").trim();
  let only: string | null = null;
  const pre = /^([a-z])\s+(.*)$/iu.exec(q);
  const narrowed = pre ? FIND_PREFIX[(pre[1] ?? "").toLowerCase()] : undefined;

  if (pre && narrowed) {
    only = narrowed;
    q = pre[2] ?? "";
  } else if (pre === null && FIND_PREFIX[q.toLowerCase()] && q.length === 1) {
    only = FIND_PREFIX[q.toLowerCase()] ?? null;
    q = "";
  }

  const words = q.toLowerCase().split(/\s+/u).filter(Boolean);
  const scored: { r: FindRow; exact: boolean; group: number; score: number; i: number }[] = [];

  rows.forEach((r, i) => {
    if (only && r.group !== only) return;
    const ref = r.ref.toLowerCase();
    const title = r.title.toLowerCase();
    const hay = ref + " " + title + " " + r.sub.toLowerCase();

    if (!words.every((w) => hay.includes(w))) return;
    const exact = words.length > 0 && ref === q.toLowerCase();
    const score = !words.length ? 0 : (title.startsWith(words[0] ?? "") ? 20 : 0) + words.filter((w) => title.includes(w)).length * 5;
    scored.push({ r, exact, group: FIND_GROUPS.findIndex(([key]) => key === r.group), score, i });
  });

  return scored.sort((a, b) => Number(b.exact) - Number(a.exact) || a.group - b.group || b.score - a.score || a.i - b.i).map((x) => x.r);
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
 * since is "changed". A row with an `href` is another fleet's, opened on that fleet's page, and carries no
 * mark here.
 */
function decisionRows(decisions: readonly Decision[] | null | undefined, seen: { readonly [id: string]: string | undefined } | null | undefined): { item: Decision; mark: string }[] {
  const rank = (d: Decision): number => (d.status !== "open" ? 3 : d.asks === "manager" ? 2 : d.blocking ? 0 : 1);
  const rows = [...(decisions ?? [])].sort((a, b) => rank(a) - rank(b) || (rank(a) === 3 ? stamp(b.closed) - stamp(a.closed) : stamp(a.opened) - stamp(b.opened)));

  return rows.map((d) => {
    const last = seen?.[d.id];
    const mark = d.status !== "open" || d.href ? "" : !last ? "new" : d.revised && stamp(d.revised) > stamp(last) ? "changed" : "";

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
 * and how many still wait on the viewer.
 */
function grillState(item: Decision, messages: Iterable<Message> | null | undefined): Grilling {
  const qs = Array.isArray(item.questions) ? item.questions.filter((q) => q && isText(q.id)) : [];
  const list = [...(messages ?? [])].sort((a, b) => a.id - b.id);

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

  return { questions: ordered, toAnswer, waiting: ordered.filter((e) => e.q.status === "open" && e.sent && !e.sent.replied).length };
}

/** The message a grilling's form sends: one "Q3: answer" line per question the viewer answered now. */
function grillAnswerText(item: Decision, picks: readonly { readonly id: string; readonly pick: string; readonly text?: string | null }[]): { text: string } | { error: string } {
  const lines: string[] = [];

  for (const p of picks) {
    const q = (item.questions ?? []).find((x) => x.id === p.id);

    if (!q || p.pick === "later") continue;

    const own = String(p.text ?? "")
      .trim()
      .replace(/\s*\n\s*/gu, " ");

    if (p.pick === "own" && !own) return { error: `${q.id.toUpperCase()}: write your answer, or take the recommendation.` };
    lines.push(`${q.id.toUpperCase()}: ${p.pick === "rec" ? "ok, as recommended (" + String(q.recommend) + ")" + (own ? ". " + own : "") : own}`);
  }

  return lines.length ? { text: lines.join("\n") } : { error: "Answer at least one question." };
}

/** The decision a location hash names ("#decision/d1"), or null. */
function decisionRoute(hash: string | null | undefined): string | null {
  const m = /^#decision\/([A-Za-z0-9_.-]+)$/u.exec(String(hash ?? ""));

  return m ? (m[1] ?? null) : null;
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

/** What the decision's form gave. */
export interface AnswerForm {
  readonly choice?: string;
  readonly note?: string;
  readonly value?: string;
  readonly done?: boolean;
}

/**
 * What the page posts for the answer given in `form`: {text}, or {error} saying what is missing. A decision
 * is one option with an optional note, or "none" with a note that says what instead; a permission is one of
 * its two options with an optional note.
 */
function answerText(item: Decision, form: AnswerForm): { text: string } | { error: string } {
  const note = String(form.note ?? "").trim();
  const value = String(form.value ?? "").trim();
  const withNote = (text: string): Posted => ({ text: note ? text + "\n" + note : text });

  if (item.kind === "decision" || item.kind === "permission") {
    if (form.choice === "none" && item.kind === "decision") return note ? { text: "None of these: " + note } : { error: "Say what you want instead." };
    const option = (item.options || []).find((o) => o.id === form.choice);

    return option ? withNote(option.id + ": " + String(option.label)) : { error: "Pick one option." };
  }

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

  const shown = {
    ...value,
    project: text(value["project"], ""),
    goal: text(value["goal"], ""),
    status: text(value["status"], ""),
    now: text(value["now"], ""),
    started: text(value["started"], ""),
    role: value["role"] === "manager" ? "manager" : "coordinator",
    manager: above && { id: text(above["id"], "manager"), url: above["url"], session: text(above["session"], "") },
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
  const quoted = isRow(quote) && isText(quote["text"]) && quote["text"].trim() ? { text: quote["text"], from: isText(quote["from"]) ? quote["from"] : "" } : null;

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
 * page had as one long scroll still lead to where their section went.
 */
function viewOf(hash: string | null | undefined): Place {
  const decision = decisionRoute(hash);
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
  if (!d || d.status !== "open" || d.asks === "manager" || d.answered || isHeld(d)) return false;
  const list = [...(messages ?? [])];

  if (d.kind === "grill") return grillState(d, list).toAnswer > 0;

  return !pendingAnswer(d, list);
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

    // A hold records the answers given until then; one given after it is news again.
    if (!p || p.replies.length || (isHeld(d) && stamp(p.answer.at) <= stamp(d.held_at))) continue;

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

/** The usage windows the page shows, with their labels. */
const WINDOWS: readonly (readonly [string, string])[] = [
  ["five_hour", "Session, 5 hours"],
  ["seven_day", "Week, 7 days"],
];

/** A usage window as the page shows it. */
export interface UsageRow {
  readonly key: string;
  readonly label: string;
  readonly percent: number;
  readonly tone: string;
  readonly reset: boolean;
  readonly resetsAt: number;
  readonly readAt: number;
}

/**
 * The plan's usage as the status line last saw it, one row per window: how full it is, when it resets, when
 * it was read. A window that reset since the reading starts again from nothing.
 */
function usageOf(usage: State["usage"] | null | undefined, now: number): UsageRow[] {
  const rows: UsageRow[] = [];

  for (const [key, label] of WINDOWS) {
    const r = usage?.[key];

    if (!r || !Number.isFinite(r.used_percentage) || !Number.isFinite(r.resets_at)) continue;
    const resetsAt = Number(r.resets_at) * 1000;
    const reset = resetsAt <= now;
    const percent = reset ? 0 : Math.max(0, Math.min(100, Math.round(Number(r.used_percentage))));
    rows.push({ key, label, percent, tone: percent >= 90 ? "critical" : percent >= 75 ? "warning" : "ok", reset, resetsAt, readAt: Number.isFinite(r.at) ? Number(r.at) * 1000 : 0 });
  }

  return rows;
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
  findRank,
  FIND_GROUPS,
  FIND_PREFIX,
  grillState,
  grillAnswerText,
  sidesOf,
  excerptOf,
  answerText,
  parseState,
  parseMessage,
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
