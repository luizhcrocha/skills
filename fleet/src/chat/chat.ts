/**
 * The chat between the user and the fleet (Python's `chat.py` module): who takes part, who a message
 * reaches (`address`, the one implementation of the rule, shared with the server; the cases in
 * `tests/recipients.json` are its contract), appending, what is open for whom, the printed line, and
 * whether the host reads its chat (`listening`).
 */
import { join } from "node:path";

import { parseInstant } from "../clock.ts";
import { ChatError } from "../errors.ts";
import { readObject, roleOf } from "../registry.ts";
import { mtimeOf, readText, resolvePath } from "../files.ts";
import { asArray, asNumber, asObject, asString, pyRepr, truthy, type Json, type JsonObject } from "../json.ts";
import { secondsNow, type Machine } from "../world.ts";
import { appendLocked, readChat, type Message, type Part } from "./store.ts";
import { liveWatch } from "./watchers.ts";

/** Characters of a selected excerpt a message carries. */
export const QUOTE_MAX = 2000;

/** Characters of each field of a quote's place (`at`). */
export const PLACE_MAX = 200;

const PLACE_REFUSED = "a quote's place is {hash, anchor?, message?}: strings, the hash starting with #, the message a message's id, each at most 200 characters";

/**
 * Where a quote was taken, as the page that sent it can open it again: `hash` (its location hash), `anchor`
 * (an element id there) and `message` (a chat message's id), strings of at most PLACE_MAX characters with
 * no control characters. Other keys are dropped; undefined when there is none.
 */
function placeOf(at: Json | undefined): JsonObject | undefined | ChatError {
  if (at === undefined || at === null) return undefined;
  const given = asObject(at);
  const hash = asString(given?.["hash"]);

  if (given === undefined || hash === undefined || !hash.startsWith("#")) return new ChatError({ reason: PLACE_REFUSED });
  const fields: [string, string][] = [];

  for (const key of ["hash", "anchor", "message"]) {
    const value = given[key];

    if (value === undefined || value === null || value === "") continue;
    const text = asString(value);

    // oxlint-disable-next-line no-control-regex -- control characters are what it refuses.
    if (text === undefined || [...text].length > PLACE_MAX || /[\u0000-\u001f\u007f]/u.test(text)) return new ChatError({ reason: PLACE_REFUSED });
    fields.push([key, text]);
  }

  const place: JsonObject = Object.fromEntries(fields);
  const message = asString(place["message"]);

  return message !== undefined && !/^[0-9]+$/u.test(message) ? new ChatError({ reason: PLACE_REFUSED }) : place;
}

/** A host whose watch ended, or who spoke, this recently still counts as reading. */
export const READING_GRACE_S = 10 * 60;

/** DIR/state.json as the chat reads it: an object, or empty. */
export function stateOfDir(root: string): JsonObject {
  return readObject(join(root, "state.json")) ?? {};
}

/** Who runs the chat of DIR: `manager` in a manager's, else `coordinator`. */
export function hostOf(root: string): "manager" | "coordinator" {
  return roleOf(stateOfDir(root));
}

/** One participant beside the host. */
export interface Member {
  readonly id: string;
  readonly name: string;
}

/** Who takes part in a DIR's chat. */
export interface Roster {
  readonly host: string;
  readonly members: readonly Member[];
}

/** The roster of DIR: every agents[] row, whatever its status, and in a manager's DIR each coordinator
 * being served, under its fleet's name. */
export function rosterOf(machine: Machine, root: string): Roster {
  const state = stateOfDir(root);
  const members: Member[] = [];

  for (const row of asArray(state["agents"]) ?? []) {
    const agent = asObject(row);
    const id = asString(agent?.["id"]);

    if (agent === undefined || id === undefined) continue;
    const name = agent["name"];
    members.push({ id, name: name === undefined ? id : (asString(name) ?? pyRepr(name)) });
  }

  const host = roleOf(state);

  if (host === "manager") {
    const dir = resolvePath(root);

    for (const e of machine.registry.live()) {
      if (e.role !== "manager" && e.dir !== dir) members.push({ id: e.id, name: e.id });
    }
  }

  return { host, members };
}

/** The roster id `who` names, any case: the host, then ids, then names, in state.json order. */
export function resolveWho(roster: Roster, who: string): string | undefined {
  const key = who.toLowerCase();

  if (key === roster.host) return key;

  return (
    roster.members.find((m) => m.id.toLowerCase() === key)?.id ?? roster.members.find((m) => m.name.toLowerCase() === key)?.id
  );
}

const MENTION = /@([A-Za-z0-9_.-]+)/g;

/** `text` split into plain parts and resolved mentions, which join back into `text` exactly. A token that
 * names nobody is tried again without its trailing dots and dashes ("@a1." ends a sentence). */
export function partsOf(roster: Roster, text: string): Part[] {
  const parts: Part[] = [];
  let plain = "";
  let at = 0;

  for (const match of text.matchAll(MENTION)) {
    let token = match[1] ?? "";
    let who = resolveWho(roster, token);

    if (who === undefined) {
      token = token.replace(/[.-]+$/, "");
      who = token === "" ? undefined : resolveWho(roster, token);
    }

    if (who === undefined) continue;
    plain += text.slice(at, match.index);

    if (plain !== "") parts.push({ text: plain });
    parts.push({ text: `@${token}`, mention: who });
    plain = "";
    at = match.index + 1 + token.length;
  }

  plain += text.slice(at);

  return plain === "" ? parts : [...parts, { text: plain }];
}

/** The id of `who`, or "user" when the caller allows it; anyone else is refused. */
export function participant(roster: Roster, who: string, allowUser: boolean): string | ChatError {
  if (who === "user") {
    return allowUser
      ? who
      : new ChatError({ reason: `only the dashboard server speaks as the user; use --as ${roster.host} or your own id` });
  }

  const found = resolveWho(roster, who);

  if (found !== undefined) return found;
  const ids = roster.members.map((m) => m.id);
  const known = ids.length > 0 ? `the last ids it has are ${ids.slice(-5).join(", ")}` : "it has no worker yet";

  return new ChatError({
    reason:
      `unknown participant '${who}': no worker row by that id or name in this DIR's state.json ` +
      `(${known}). Check DIR is your fleet's dashboard directory (your brief names it), and that ` +
      `the coordinator recorded you (\`fleet state DIR agent ${who} ...\`) before you started; else use --as ${roster.host}`,
  });
}

/** Who a message reaches and its parts. */
export interface Addressed {
  readonly from: string;
  readonly to: string[];
  readonly parts: Part[];
}

/** Who a message from `sender` would reach now, and its text split into parts. */
export function address(
  machine: Machine,
  root: string,
  message: { readonly sender: string; readonly text: string; readonly re?: number | null; readonly allowUser?: boolean },
): Addressed | ChatError {
  const roster = rosterOf(machine, root);
  const sender = participant(roster, message.sender, message.allowUser ?? false);

  if (sender instanceof ChatError) return sender;
  const parts = partsOf(roster, message.text);
  const named = parts.flatMap((p) => (p.mention === undefined ? [] : [p.mention]));

  if (message.re !== undefined && message.re !== null) {
    const re = message.re;
    const answered = readChat(root).find((m) => m.id === re);

    if (answered === undefined) return new ChatError({ reason: `unknown message #${re}` });
    named.push(answered.from);
  }

  const to: string[] = sender === "user" ? [] : ["user"];

  for (const who of named) {
    if (who !== sender && !to.includes(who)) to.push(who);
  }

  return { from: sender, to: to.length > 0 ? to : [roster.host], parts };
}

/** A message as `append` stores it, in Python's key order. */
interface StoredMessage {
  id: number;
  at: string;
  from: string;
  to: string[];
  text: string;
  re: number | null;
  parts: Part[];
  author?: string;
  decision?: string;
  quote?: JsonObject;
  side?: Json;
  origin?: string;
}

/** A message to append. */
export interface Draft {
  readonly sender: string;
  readonly text: string;
  readonly re?: number | null;
  readonly author?: string;
  readonly allowUser?: boolean;
  readonly decision?: string;
  readonly quote?: JsonObject;
  /** "new" opens a side chat; a number continues one. */
  readonly side?: number | "new";
  /** The page of another origin the user posted from (the hub's config allows it), as its `Origin`. */
  readonly origin?: string;
  /** Called under the store's lock with the message about to be stored and what the store holds: the
   * fields it returns are stored with it (the hub's delivery to the coordinators, `delivered`). */
  readonly alongside?: (message: JsonObject, known: readonly Message[]) => JsonObject | undefined;
}

/** Append a message and return it as stored, with the recipients and parts `address` resolves. */
export function append(machine: Machine, root: string, draft: Draft, at: string): Message | ChatError {
  const resolved = address(machine, root, draft);

  if (resolved instanceof ChatError) return resolved;

  if (draft.text.trim() === "") return new ChatError({ reason: "the message has no text" });

  if (!draft.text.isWellFormed()) return new ChatError({ reason: "the text is not valid UTF-8" });
  let quote: JsonObject | undefined;

  if (draft.quote !== undefined) {
    const text = asString(draft.quote["text"]);

    if (text === undefined || text.trim() === "") return new ChatError({ reason: "a quote is the selected text, with where it was" });
    const from = draft.quote["from"];
    const place = placeOf(draft.quote["at"]);

    if (place instanceof ChatError) return place;
    quote = { text: [...text.trim()].slice(0, QUOTE_MAX).join(""), from: [...(truthy(from) ? (asString(from) ?? pyRepr(from)) : "")].slice(0, 200).join("") };

    if (place !== undefined) quote = { ...quote, at: place };
  }

  const stored = appendLocked(root, (known, nextId) => {
    const parent = draft.re === undefined || draft.re === null ? undefined : known.find((m) => m.id === draft.re);
    let side: Json | undefined;

    if (draft.side === "new") side = nextId;
    else if (draft.side !== undefined) {
      const wanted = draft.side;

      if (!known.some((m) => m.side === wanted)) return new ChatError({ reason: `no side chat #${wanted}` });
      side = wanted;
    } else if (parent !== undefined && truthy(parent.side)) side = parent.side;

    const message: StoredMessage = {
      id: nextId,
      at,
      from: resolved.from,
      to: resolved.to,
      text: draft.text,
      re: draft.re ?? null,
      parts: resolved.parts.map((p) => (p.mention === undefined ? { text: p.text } : { text: p.text, mention: p.mention })),
    };

    if (draft.author !== undefined && draft.author !== "" && resolved.from === "user") message.author = draft.author;

    if (draft.decision !== undefined && draft.decision !== "") message.decision = draft.decision;

    if (quote !== undefined) message.quote = quote;

    if (side !== undefined && truthy(side)) message.side = side;

    if (draft.origin !== undefined && draft.origin !== "" && resolved.from === "user") message.origin = draft.origin;
    const built: JsonObject = { ...message };

    return { ...built, ...draft.alongside?.(built, known) };
  });

  return stored instanceof Error && !(stored instanceof ChatError) ? new ChatError({ reason: stored.message }) : stored;
}

/** The messages addressed to `who` that `who` has not answered. */
export function openAmong(messages: readonly Message[], who: string): Message[] {
  const answered = new Set(messages.map((m) => `${pyRepr(m.re)}\u0000${m.from}`));

  return messages.filter((m) => m.to.includes(who) && !answered.has(`${m.id}\u0000${who}`));
}

/** The messages with id > `after` open for `who` (the user allowed), oldest first. */
export function openFor(machine: Machine, root: string, who: string, after = 0): Message[] | ChatError {
  const id = participant(rosterOf(machine, root), who, true);

  if (id instanceof ChatError) return id;

  return openAmong(readChat(root), id).filter((m) => m.id > after);
}

const BREAKS = new Set(["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]);

/** `text` with each line break (CRLF as one) as ` ⏎ `. */
function marksBreaks(text: string): string {
  let out = "";

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";

    if (char === "\r" && text[i + 1] === "\n") {
      out += " \u23ce ";
      i += 1;
    } else out += BREAKS.has(char) ? " \u23ce " : char;
  }

  return out;
}

/** Whether a code point is a C0 or C1 control character. */
function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;

  return code <= 0x1f || (code >= 0x80 && code <= 0x9f);
}

/** Python's `str()` of a JSON value. */
export function pyText(value: Json | undefined): string {
  return asString(value) ?? pyRepr(value);
}

/** `value` as text that never prints as more than one line: breaks become ⏎, a tab a space, controls go. */
export function oneLine(value: Json | undefined): string {
  const text = marksBreaks(pyText(value)).replace(/\t/g, " ");

  return [...text].filter((char) => !isControl(char)).join("");
}

/** The coordinators the hub delivered this message to, into their own chats (`delivered`, on a message the
 * user wrote on the manager's page): each answers it there, so the manager does not forward it. */
export function handedOver(m: Message): Set<string> {
  const rows = asArray(m.stored["delivered"]) ?? [];

  return new Set(rows.flatMap((r) => {
    const fleet = asString(asObject(r)?.["fleet"]);

    return fleet === undefined ? [] : [fleet];
  }));
}

/** Whether a recipient of `m` has it only in this chat: one the hub did not deliver it to. */
export function waitsHere(m: Message): boolean {
  const handed = handedOver(m);

  return m.to.some((r) => !handed.has(r));
}

/** A message the hub delivered from the manager's page (`via` the manager). */
export function fromManager(m: Message): boolean {
  return asObject(m.stored["via"])?.["fleet"] === "manager";
}

/** ` [delivered to infra #7]` on a message the hub delivered, ` [via manager #12]` on its copy and on an
 * answer mirrored back, ` [from https://host:7501]` on one the user posted from a page of another origin. */
function marks(m: Message): string {
  let out = "";

  const rows = (asArray(m.stored["delivered"]) ?? []).flatMap((r) => {
    const row = asObject(r);

    return row === undefined || row["fleet"] === undefined || row["fleet"] === null ? [] : [row];
  });


  if (rows.length > 0) out += ` [delivered to ${rows.map((r) => `${oneLine(r["fleet"])} #${oneLine(r["id"] ?? null)}`).join(", ")}]`;
  const via = asObject(m.stored["via"]);

  if (via !== undefined && via["fleet"] !== undefined && via["fleet"] !== null) out += ` [via ${oneLine(via["fleet"])} #${oneLine(via["id"] ?? null)}]`;
  const origin = asString(m.stored["origin"]);

  if (origin !== undefined && origin !== "") out += ` [from ${oneLine(origin)}]`;

  return out;
}

/** Each message as its one printed line: `#12 user (login) -> a1 (notes-impl) [D1 d1]: text [re #9]`. */
export function renderLines(machine: Machine, root: string, messages: readonly Message[]): string[] {
  const names = new Map(rosterOf(machine, root).members.map((m) => [m.id, m.name]));
  const refs = new Map<string, string>();

  for (const row of asArray(stateOfDir(root)["decisions"]) ?? []) {
    const d = asObject(row);
    const ref = d?.["ref"];

    if (d !== undefined && truthy(ref)) refs.set(pyText(d["id"]), pyText(ref));
  }

  const label = (id: string, extra?: Json): string => {
    const shown = extra !== undefined && truthy(extra) ? pyText(extra) : (names.get(id) ?? id);

    return oneLine(shown === id ? id : `${id} (${shown})`);
  };

  return messages.map((m) => {
    let line = `#${m.id} ${label(m.from, m.from === "user" ? m.author : undefined)} -> ${m.to.map((id) => label(id)).join(", ")}`;

    if (truthy(m.decision)) {
      const ref = refs.get(pyText(m.decision));
      line += ` [${oneLine(ref === undefined ? "" : `${ref} `)}${oneLine(m.decision)}]`;
    }

    if (truthy(m.side)) line += ` [side chat #${pyText(m.side)}]`;
    line += marks(m);
    const quote = asObject(m.quote);
    const quoted = asString(quote?.["text"]);

    if (quote !== undefined && quoted !== undefined) {
      const from = truthy(quote["from"]) ? ` ${oneLine(quote["from"])}` : "";
      line += ` (quoting${from}: "${oneLine(quoted)}")`;
    }

    line += `: ${oneLine(m.text)}`;

    if (m.re !== null) line += ` [re #${oneLine(m.re)}]`;

    return line;
  });
}

/** The id of the last message a `--once` watch as `who` exited with: handed to the session it woke. */
export function cursorPath(root: string, who: string): string {
  return join(root, `watch-${who}.cursor`);
}

/** Touched when a watch as `who` ends. */
export function leftPath(root: string, who: string): string {
  return join(root, `watch-${who}.left`);
}

/** Where a running `--once` watch as `who` keeps its process id. */
export function pulsePath(root: string, who: string): string {
  return join(root, `watch-${who}.pid`);
}

/** Python's `int()` of a file's text: an integer with blanks around it, else undefined. */
export function intOf(text: string | undefined): number | undefined {
  const trimmed = text?.trim().replace(/_/g, "");

  return trimmed !== undefined && /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** The ids (as pyRepr) of DIR's decisions that are no longer open. */
function closedDecisions(root: string): Set<string> {
  const closed = new Set<string>();

  for (const row of asArray(stateOfDir(root)["decisions"]) ?? []) {
    const d = asObject(row);

    if (d !== undefined && d["status"] !== "open") closed.add(pyRepr(d["id"]));
  }

  return closed;
}

/** The user's messages to the host of DIR that the host has not answered with `--re`, leaving out an answer
 * to a decision since closed: it was recorded in the ledger. Oldest first. */
export function openFromUser(root: string, messages: readonly Message[] = readChat(root)): Message[] {
  const closed = closedDecisions(root);

  return openAmong(messages, hostOf(root)).filter((m) => m.from === "user" && !(truthy(m.decision) && closed.has(pyRepr(m.decision))));
}

/** Messages a host's `say` without `--re` names, at most. */
const OPEN_SHOWN = 5;

/** What the host is told when it writes with no `--re` while the user's messages to it are open: the reply
 * would leave them looking unanswered. Undefined otherwise. */
export function noReWarning(root: string, sent: Message): string | undefined {
  if (sent.from !== hostOf(root) || sent.re !== null) return undefined;
  const open = openFromUser(root);

  if (open.length === 0) return undefined;
  const shown = open.slice(-OPEN_SHOWN).map((m) => `#${m.id} ${pyText(m.at).slice(11, 16)}`);
  const earlier = open.length > OPEN_SHOWN ? ` (and ${open.length - OPEN_SHOWN} earlier)` : "";

  return `chat: open from the user: ${shown.join(", ")}${earlier} — add \`--re N\` if this answers one`;
}

/** Whether the host of DIR reads its chat now, and how far it has read. */
export interface Listening {
  readonly on: boolean;
  readonly seen: number;
  readonly unread: number;
  readonly since: Json | null;
}

/** Whether the host of DIR reads its chat: a live `--once` watch (the one its pid file names, else one found
 * among the running processes), a watch that ended or a message it sent in the last ten minutes; the last
 * message a `--once` watch exited with; the user's messages after it that still wait. */
export function listening(machine: Machine, root: string): Listening {
  const who = hostOf(root);
  const now = secondsNow(machine);
  let on = liveWatch(root, who, intOf(readText(pulsePath(root, who)))) !== undefined;
  const messages = readChat(root);

  if (!on) {
    const left = mtimeOf(leftPath(root, who));
    on = left !== undefined && now - left < READING_GRACE_S;

    if (!on) {
      const last = [...messages].reverse().find((m) => m.from === who);
      const at = last === undefined ? undefined : parseInstant(pyText(last.at));
      on = at !== undefined && now - at / 1000 < READING_GRACE_S;
    }
  }

  const seen = intOf(readText(cursorPath(root, who))) ?? 0;
  const answered = new Set(messages.flatMap((m) => (m.from !== "user" && m.re !== null ? [pyRepr(m.re)] : [])));
  const closed = closedDecisions(root);

  const unread = messages.filter(
    (m) =>
      m.id > seen &&
      m.from === "user" &&
      !answered.has(String(m.id)) &&
      !(truthy(m.decision) && closed.has(pyRepr(m.decision))) &&
      // So does one the hub delivered to every coordinator it names: each reads it in its own chat.
      waitsHere(m),
  );

  return { on, seen, unread: unread.length, since: unread[0]?.at ?? null };
}

/** What the host must be told when the user writes to a chat nobody reads, or undefined. */
export function deafWarning(machine: Machine, root: string): string | undefined {
  const heard = listening(machine, root);

  if (heard.on || heard.unread === 0) return undefined;

  return (
    `chat: the user wrote ${heard.unread} message(s) since #${heard.seen} that no watch has read. ` +
    `Arm \`fleet chat ${root} watch --as ${hostOf(root)} --all --resume --once\` as a background command; it prints them first.`
  );
}

/** The number a JSON value holds, for ids. */
export function idOf(value: Json | undefined): number | undefined {
  return asNumber(value);
}
