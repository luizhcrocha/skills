/**
 * The chat between the user and the fleet (Python's `chat.py` module): who takes part, who a message
 * reaches (`address`, the one implementation of the rule, shared with the server; the cases in
 * `tests/recipients.json` are its contract), appending, what is open for whom, the printed line, and
 * whether the host reads its chat (`listening`).
 */
import { join } from "node:path";

import { parseInstant } from "../clock.ts";
import { ChatError } from "../errors.ts";
import { readObject, roleOf, type Entry } from "../registry.ts";
import { mtimeOf, readText, resolvePath } from "../files.ts";
import { asArray, asNumber, asObject, asString, pyRepr, truthy, type Json, type JsonObject } from "../json.ts";
import { secondsNow, type Machine } from "../world.ts";
import { appendAllLocked, messageOf, readChat, type Message, type Part } from "./store.ts";
import { liveHost } from "../host.ts";
import { liveWatch, TREE } from "./watchers.ts";
import { allStored, imageNotes, imagePathsOf, imagesOf, IMAGES_REFUSED, markImageNotes, markImages, MAX_IMAGES } from "./attachments.ts";

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

/** Marks one batch carries, at most. */
export const MARKS_MAX = 100;

/** Characters of a mark's comment or replacement. */
export const MARK_TEXT_MAX = 4000;

/** Blocks one mark's quote crosses, at most. */
const BLOCKS_MAX = 200;

/** Characters kept of the body's text around a quote or a block. */
const CONTEXT_MAX = 64;

/** Characters kept of where a quote was, in words. */
const HINT_MAX = 300;

const MARK_KINDS: readonly string[] = ["comment", "delete", "replace", "question", "general"];

function marksRefused(what: string): ChatError {
  return new ChatError({ reason: `marks are {decision, at, items}: ${what}` });
}

function cut(text: string, max: number): string {
  return [...text].slice(0, max).join("");
}

/** `given[key]` as a string: undefined when absent or null, refused when it is anything else. */
function textOf(given: JsonObject, key: string, where: string): string | undefined | ChatError {
  const value = given[key];

  if (value === undefined || value === null) return undefined;

  return asString(value) ?? marksRefused(`${where}.${key} is not a string`);
}

function decisionOfMarks(value: Json | undefined): JsonObject | ChatError {
  const given = asObject(value);

  if (given === undefined) return marksRefused("decision is {id, ref?, title, revision}");
  const fields: [string, string][] = [];

  for (const key of ["id", "ref", "title", "revision"]) {
    const text = textOf(given, key, "decision");

    if (text instanceof ChatError) return text;

    if ((key === "id" || key === "revision") && (text === undefined || text === "" || [...text].length > PLACE_MAX)) {
      return marksRefused(`decision.${key} is a string of 1 to ${PLACE_MAX} characters`);
    }

    if (key === "title" && text === undefined) return marksRefused("decision.title is a string");

    if (text !== undefined && (text !== "" || key === "title")) fields.push([key, cut(text, PLACE_MAX)]);
  }

  return Object.fromEntries(fields);
}

function blockOf(value: Json, where: string): JsonObject | ChatError {
  const given = asObject(value);
  const exact = given === undefined ? undefined : textOf(given, "exact", where);

  if (exact instanceof ChatError) return exact;

  if (given === undefined || exact === undefined || exact === "") return marksRefused(`${where} is {exact, prefix, suffix, cell?}, exact the block's text`);
  const block: [string, Json][] = [["exact", cut(exact, QUOTE_MAX)]];

  for (const key of ["prefix", "suffix"]) {
    const text = textOf(given, key, where);

    if (text instanceof ChatError) return text;
    block.push([key, cut(text ?? "", CONTEXT_MAX)]);
  }

  if (given["cell"] === undefined || given["cell"] === null) return Object.fromEntries(block);
  const cell = asObject(given["cell"]);
  const row = asNumber(cell?.["row"]);

  if (cell === undefined || row === undefined || !Number.isInteger(row) || row < 0) return marksRefused(`${where}.cell is {table, row, rowLabel, column, head?}, row a row number`);
  const kept: [string, Json][] = [];

  for (const key of ["table", "row", "rowLabel", "column"]) {
    const text = key === "row" ? undefined : textOf(cell, key, `${where}.cell`);

    if (text instanceof ChatError) return text;
    kept.push([key, key === "row" ? row : cut(text ?? "", PLACE_MAX)]);
  }

  if (cell["head"] === true) kept.push(["head", true]);
  block.push(["cell", Object.fromEntries(kept)]);

  return Object.fromEntries(block);
}

/** The decision's own text a mark's quote is in, when it is not the body (`quote.field`): the page renders
 * it, not the frame. An option's id is 1 to 60 characters of [A-Za-z0-9_.-]; a history line is its number;
 * `<id>:` before title, question, recommendation or an option names a grilling's question's own, by the id the
 * card holds (1 to 32 letters, digits, _ or -: `q1`, `Q1`, `file-upload`), the ledger's `MARK_FIELD`. */
const FIELD = /^(?:title|question|why|step|recommendation|option:[A-Za-z0-9_.-]{1,60}(?::consequence)?|history:[0-9]+|[A-Za-z0-9_-]{1,32}:(?:title|question|recommendation|option:[A-Za-z0-9_.-]{1,60}(?::consequence)?))$/u;

const FIELDS_SAID =
  "title, question, why, step, recommendation, option:<id>, option:<id>:consequence or history:<n>, or of a grilling's question <id>:title, <id>:question, <id>:recommendation, <id>:option:<id> or <id>:option:<id>:consequence";

function markQuoteOf(value: Json | undefined, where: string): JsonObject | ChatError {
  const given = asObject(value);
  const text = given === undefined ? undefined : textOf(given, "text", where);

  if (text instanceof ChatError) return text;

  if (given === undefined || text === undefined || text.trim() === "") return marksRefused(`${where} is {text, prefix, suffix, hint, blocks}, text the words marked`);
  const quote: [string, Json][] = [["text", cut(text, QUOTE_MAX)]];

  for (const [key, max] of [["prefix", CONTEXT_MAX], ["suffix", CONTEXT_MAX], ["hint", HINT_MAX]] as const) {
    const field = textOf(given, key, where);

    if (field instanceof ChatError) return field;
    quote.push([key, cut(field ?? "", max)]);
  }

  const field = textOf(given, "field", where);

  if (field instanceof ChatError) return field;

  if (field !== undefined && !FIELD.test(field)) return marksRefused(`${where}.field is ${FIELDS_SAID}`);

  if (field !== undefined) quote.push(["field", field]);
  const blocks = asArray(given["blocks"]);

  if (blocks === undefined || blocks.length === 0 || blocks.length > BLOCKS_MAX) return marksRefused(`${where}.blocks is a list of 1 to ${BLOCKS_MAX} blocks`);
  const kept: JsonObject[] = [];

  for (const [i, raw] of blocks.entries()) {
    const block = blockOf(raw, `${where}.blocks[${i}]`);

    if (block instanceof ChatError) return block;

    if (field !== undefined && block["cell"] !== undefined) return marksRefused(`${where}.blocks[${i}] is in ${field}, the page's own text: it has no cell`);
    kept.push(block);
  }

  quote.push(["blocks", kept]);

  return Object.fromEntries(quote);
}

function markOf(value: Json, at: number, seen: Set<number>): JsonObject | ChatError {
  const given = asObject(value);

  if (given === undefined) return marksRefused(`items[${at}] is {n, kind, quote?, comment?, replacement?}`);
  const n = asNumber(given["n"]);

  if (n === undefined || !Number.isInteger(n) || n < 1) return marksRefused(`items[${at}].n is a positive whole number`);
  const where = `mark ${n}`;

  if (seen.has(n)) return marksRefused(`mark ${n} is in the batch twice`);
  seen.add(n);
  const kind = asString(given["kind"]);

  if (kind === undefined || !MARK_KINDS.includes(kind)) return marksRefused(`${where}.kind is one of ${MARK_KINDS.join(", ")}`);
  const mark: [string, Json][] = [["n", n], ["kind", kind]];
  const quoted = given["quote"] !== undefined && given["quote"] !== null;

  if (kind === "general" && quoted) return marksRefused(`${where} is a general mark: it has no quote`);

  if (kind !== "general") {
    const quote = markQuoteOf(given["quote"], `${where}.quote`);

    if (quote instanceof ChatError) return quote;
    mark.push(["quote", quote]);
  }

  const images = given["images"] === undefined || given["images"] === null ? [] : imagePathsOf(given["images"]);

  if (images === undefined) return marksRefused(`${where}.images is a list of at most ${MAX_IMAGES} attachments/<hash>.<png|jpg|webp|gif> paths`);

  for (const key of ["comment", "replacement"]) {
    const text = textOf(given, key, where);

    if (text instanceof ChatError) return text;

    if (text !== undefined && [...text].length > MARK_TEXT_MAX) return marksRefused(`${where}.${key} is longer than ${MARK_TEXT_MAX} characters`);
    // A comment, a question or a general mark says something: its words, or an image in their place.
    const needed = key === "comment" ? (kind === "comment" || kind === "question" || kind === "general") && images.length === 0 : kind === "replace";

    if (needed && (text === undefined || text.trim() === "")) return marksRefused(`${where} is a ${kind} mark: it needs its ${key}`);

    if (key === "replacement" && !needed && text !== undefined) return marksRefused(`${where} is a ${kind} mark: only a replace mark has a replacement`);

    if (text !== undefined && text.trim() !== "") mark.push([key, text]);
  }

  if (images.length > 0) mark.push(["images", images]);

  if (given["on"] !== undefined && given["on"] !== null) {
    const on = asNumber(given["on"]);

    if (kind !== "general") return marksRefused(`${where}.on is only for a general reply`);

    if (on === undefined || !Number.isInteger(on) || on < 1) return marksRefused(`${where}.on is the number of an earlier mark it replies to`);
    mark.push(["on", on]);
  }

  return Object.fromEntries(mark);
}

/** Whether `hash` is the place of decision `id`: `#decision/<id>` on a fleet's page, `#decision/<fleet>/<id>`
 * on the manager's, the id encoded as the page encodes it. */
function placesDecision(hash: string, id: string): boolean {
  const tail = "/" + id.split("/").map(encodeURIComponent).join("/");

  if (!hash.startsWith("#decision/") || !hash.endsWith(tail)) return false;
  const fleet = hash.slice("#decision".length, hash.length - tail.length);

  return fleet === "" || /^\/[^/]+$/u.test(fleet);
}

const MARKS_ALONE = "a batch of marks is a message of its own: no decision, quote or side chat with it";

/** Why a batch of marks cannot go with the other fields a message has, or undefined when it can. A side chat
 * it may name (an id) is checked against the store: only its decision's page thread takes it (`pageThreadOf`). */
export function marksAlone(message: { readonly marks?: Json | undefined; readonly decision?: Json | undefined; readonly quote?: Json | undefined; readonly side?: Json | undefined }): ChatError | undefined {
  const given = (value: Json | undefined): boolean => value !== undefined && value !== null && value !== "";
  const side = asNumber(message.side ?? undefined);
  const threaded = given(message.side) && (side === undefined || !Number.isInteger(side));

  if (!given(message.marks) || (![message.decision, message.quote].some(given) && !threaded)) return undefined;

  return new ChatError({ reason: MARKS_ALONE });
}

/** Whether `m` may open a side chat without carrying `side` itself: a side-less message of the user's that is
 * a batch of marks, or that quotes a decision's page as a whole (`anchor: "dv-page"`), its page thread. */
function opensThread(m: Message): boolean {
  if (m.from !== "user" || truthy(m.side)) return false;

  return (isBatch(m) && toOwner(m)) || asObject(asObject(m.quote)?.["at"])?.["anchor"] === "dv-page";
}

/** Whether a stored batch went to its decision's owner: it names no `marks.to`, or its one recipient is the
 * fleet its place names (`#decision/<fleet>/<id>`) or, on a page of its own, the host. */
function toOwner(m: Message): boolean {
  const marks = asObject(m.stored["marks"]);

  if (marks?.["to"] === undefined) return true;
  const fleet = quotedFleet(placedBy(marks), []);
  const to = m.to[0];

  return fleet === undefined ? to === "coordinator" || to === "manager" : to === fleet;
}

/** Whether side chat `id` is in `known`: a message carries it, or message `id` opens a thread by itself (`opensThread`). */
export function sideChatIn(known: readonly Message[], id: number): boolean {
  return known.some((m) => m.side === id || (m.id === id && opensThread(m)));
}

/** The side chat `m` is in, for a reply to it to join: its own `side`, or its id when it opens a page thread
 * by itself (`opensThread`), from the moment it is stored; undefined otherwise. */
export function threadOf(m: Message): Json | undefined {
  if (truthy(m.side)) return m.side;

  return opensThread(m) ? m.id : undefined;
}

/** Whether `opener` opens the page thread of the decision at `hash`: it quotes that page as a whole (`at` that
 * hash, `anchor: "dv-page"`), or it is a side-less batch of marks on that decision. */
function pageThreadOf(opener: Message | undefined, hash: string | undefined): boolean {
  if (opener === undefined || hash === undefined) return false;
  const at = asObject(asObject(opener.quote)?.["at"]);

  if (asString(at?.["hash"]) === hash && at?.["anchor"] === "dv-page") return true;

  return opensThread(opener) && isBatch(opener) && asString(asObject(asObject(opener.stored["marks"])?.["at"])?.["hash"]) === hash;
}

/**
 * The marks a batch carries (`marks`, on the user's message): `{decision: {id, ref?, title, revision}, at:
 * {hash}, items: [{n, kind, quote?, comment?, replacement?}]}`, other keys dropped and long quoted text cut;
 * any other shape is refused, saying what is wrong. Undefined when there are none.
 */
export function marksOf(value: Json | undefined): JsonObject | undefined | ChatError {
  if (value === undefined || value === null) return undefined;
  const given = asObject(value);

  if (given === undefined) return marksRefused("not an object");
  const decision = decisionOfMarks(given["decision"]);

  if (decision instanceof ChatError) return decision;
  const at = asObject(given["at"]);
  const hash = asString(at?.["hash"]);

  // oxlint-disable-next-line no-control-regex -- control characters are what it refuses.
  if (hash === undefined || !hash.startsWith("#") || [...hash].length > PLACE_MAX || /[\u0000-\u001f\u007f]/u.test(hash)) {
    return marksRefused(`at is {hash}, the decision's place, a # and at most ${PLACE_MAX} characters`);
  }

  if (!placesDecision(hash, asString(decision["id"]) ?? "")) return marksRefused(`at.hash ${hash} is not the place of decision ${pyText(decision["id"] ?? null)}`);

  const withdrawn = withdrawnOf(given["withdrawn"]);

  if (withdrawn instanceof ChatError) return withdrawn;
  const items = asArray(given["items"]);

  if (items === undefined || items.length > MARKS_MAX || (items.length === 0 && withdrawn === undefined)) {
    return marksRefused(`items is a list of 1 to ${MARKS_MAX} marks (none only beside a withdrawal)`);
  }

  const seen = new Set<number>();
  const marks: JsonObject[] = [];

  for (const [i, raw] of items.entries()) {
    const mark = markOf(raw, i, seen);

    if (mark instanceof ChatError) return mark;
    marks.push(mark);
  }

  const to = textOf(given, "to", "marks");

  if (to instanceof ChatError) return to;

  // oxlint-disable-next-line no-control-regex -- control characters are what it refuses.
  if (to !== undefined && (to === "" || [...to].length > PLACE_MAX || /[\u0000-\u001f\u007f]/u.test(to))) return marksRefused(`to is the one agent the batch is for, 1 to ${PLACE_MAX} characters`);

  const batch: JsonObject = to === undefined ? { decision, at: { hash }, items: marks } : { decision, at: { hash }, to, items: marks };

  return withdrawn === undefined ? batch : { ...batch, withdrawn };
}

/** The marks a batch withdraws (`withdrawn`): distinct positive whole numbers, at most MARKS_MAX; undefined
 * when there are none. */
function withdrawnOf(value: Json | undefined): number[] | undefined | ChatError {
  if (value === undefined || value === null) return undefined;
  const given = asArray(value);
  const numbers = (given ?? []).map((n) => asNumber(n));
  const whole = numbers.flatMap((n) => (n !== undefined && Number.isInteger(n) && n >= 1 ? [n] : []));

  if (given === undefined || whole.length !== given.length || new Set(whole).size !== whole.length || whole.length > MARKS_MAX) {
    return marksRefused(`withdrawn is a list of up to ${MARKS_MAX} distinct mark numbers`);
  }

  return whole.length === 0 ? undefined : whole;
}

/** The marks a stored batch withdraws; empty for any other message. */
export function withdrawnNumbers(m: Message): number[] {
  return (asArray(asObject(m.stored["marks"])?.["withdrawn"]) ?? []).flatMap((n) => {
    const got = asNumber(n);

    return got === undefined ? [] : [got];
  });
}

/** Whether `m` is a batch of marks: its `marks` name a decision (some marks, or only a withdrawal). */
export function isBatch(m: Message): boolean {
  return asObject(asObject(m.stored["marks"])?.["decision"]) !== undefined;
}

/** The `n` of each mark a stored batch carries; empty for a message without marks. */
export function markNumbers(m: Message): number[] {
  return (asArray(asObject(m.stored["marks"])?.["items"]) ?? []).flatMap((item) => {
    const n = asNumber(asObject(item)?.["n"]);

    return n === undefined ? [] : [n];
  });
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

/** Who a message from `sender` would reach now, and its text split into parts. A batch of marks of the
 * user's reaches the decision's owner (`batchOwner`) and whoever it cites; on the manager's page, a message of
 * the user's in a side chat that a fleet owns (`ownersOf`) reaches the owners and whoever it cites. Either
 * also reaches the sender of the message it replies to, and no one else. */
export function address(
  machine: Machine,
  root: string,
  message: {
    readonly sender: string;
    readonly text: string;
    readonly re?: number | null;
    readonly side?: number | "new";
    readonly quote?: JsonObject;
    /** A batch's marks: on the manager's page their decision's fleet owns it, as a side chat's. */
    readonly marks?: JsonObject;
    readonly allowUser?: boolean;
  },
): Addressed | ChatError {
  const roster = rosterOf(machine, root);
  const sender = participant(roster, message.sender, message.allowUser ?? false);

  if (sender instanceof ChatError) return sender;
  const parts = partsOf(roster, message.text);
  const cited = parts.flatMap((p) => (p.mention === undefined ? [] : [p.mention]));
  const re = message.re ?? null;
  const batch = sender === "user" && message.marks !== undefined;
  const owned = sender === "user" && roster.host === "manager";
  const known = re !== null || owned ? readChat(root) : [];
  const answered = re === null ? undefined : known.find((m) => m.id === re);

  if (re !== null && answered === undefined) return new ChatError({ reason: `unknown message #${re}` });
  let owners: string[] = [];

  if (batch) {
    const owner = batchOwner(machine, root, roster, message.marks);
    const named = asString(message.marks?.["to"]);

    if (named !== undefined) {
      const one = recipientOf(roster, named);

      if (one === undefined) return new ChatError({ reason: `marks.to ${named} names no one in this chat` });

      if (one !== owner && !cited.includes(one)) return new ChatError({ reason: `a batch goes to the decision's owner (${owner}) or to an agent its text cites, and ${named} is neither` });

      if (one !== owner && message.side !== undefined) return new ChatError({ reason: `a batch to ${named} goes in no side chat: the page thread is ${owner}'s` });

      return { from: sender, to: [one], parts };
    }

    owners = [owner];
  } else if (owned) owners = ownersOf(machine, root, known, message.side, answered, message.quote, cited);
  const replied = answered === undefined ? [] : [answered.from];
  const named = owners.length > 0 ? [...owners, ...cited, ...replied] : [...cited, ...replied];
  const to: string[] = sender === "user" ? [] : ["user"];

  for (const who of named) {
    if (who !== sender && !to.includes(who)) to.push(who);
  }

  return { from: sender, to: to.length > 0 ? to : [roster.host], parts };
}

/** The fleet a quote's place on the manager's page is an item of: a decision or grilling of its
 * (`#decision/<fleet>/<id>`), or a message from it in the chat. Never `#agent-<x>`: that anchor is a
 * worker's row on the manager's page, not a fleet's, and the page has no anchor of a fleet's own row. */
function quotedFleet(quote: Json | undefined, known: readonly Message[]): string | undefined {
  const at = asObject(asObject(quote)?.["at"]);
  const message = asString(at?.["message"]);

  if (message !== undefined && /^[0-9]+$/u.test(message)) return known.find((m) => m.id === Number(message))?.from;

  for (const place of [asString(at?.["hash"]), asString(at?.["anchor"])]) {
    const named = /^#decision\/([^/]+)\/[^/]+$/u.exec(place ?? "")?.[1];

    if (named === undefined) continue;

    try {
      return decodeURIComponent(named);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** A batch's place as a quote holds one (`{at}`), so a batch is owned as a quote is; undefined without marks. */
function placedBy(marks: Json | undefined): Json | undefined {
  const at = asObject(marks)?.["at"];

  return at === undefined ? undefined : { at };
}

/** Whom `name` names, as a mention would (`partsOf`): the host, an id or a name, any case, tried again
 * without trailing dots and dashes. */
function recipientOf(roster: Roster, name: string): string | undefined {
  const token = name.replace(/^@/u, "");
  const stripped = token.replace(/[.-]+$/u, "");

  return resolveWho(roster, token) ?? (stripped === "" ? undefined : resolveWho(roster, stripped));
}

/** The owner of the decision a batch of marks is on (`batchOwner`), as the hub checks a ride-along by it. */
export function ownerOfBatch(machine: Machine, root: string, marks: JsonObject | undefined): string {
  return batchOwner(machine, root, rosterOf(machine, root), marks);
}

/** The live fleets the manager of `root` serves, its own DIR left out. */
function servedFleets(machine: Machine, root: string): Entry[] {
  const dir = resolvePath(root);

  return machine.registry.live().filter((e) => e.role !== "manager" && e.dir !== dir);
}

/** The fleet `name` names among `fleets`: a fleet's id exactly, or an alias exactly one fleet has; an
 * ambiguous one names none. */
function fleetNamed(fleets: readonly Entry[], name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const exact = fleets.find((e) => e.id === name);

  if (exact !== undefined) return exact.id;
  const aliased = fleets.filter((e) => e.aliases.includes(name));

  return aliased.length === 1 ? aliased[0]?.id : undefined;
}

/** Who owns the decision a batch of marks is on: on a fleet's page its host; on the manager's page the live
 * fleet its place names (`#decision/<fleet>/<id>`), else the manager (its own decision, or a fleet gone). */
function batchOwner(machine: Machine, root: string, roster: Roster, marks: JsonObject | undefined): string {
  if (roster.host !== "manager") return roster.host;

  return fleetNamed(servedFleets(machine, root), quotedFleet(placedBy(marks), [])) ?? roster.host;
}

/**
 * The fleets that own the side chat a message of the user's on the manager's page is in: the fleet whose
 * item its first message quotes, and the fleets that first message cites. None for a message outside a side
 * chat, or in one about the manager's own things. `cited` and `quote` are the message's own, for a message
 * that opens a side chat; `answered` passes on its side chat to a reply.
 */
function ownersOf(
  machine: Machine,
  root: string,
  known: readonly Message[],
  side: number | "new" | undefined,
  answered: Message | undefined,
  quote: Json | undefined,
  cited: readonly string[],
): string[] {
  const fleets = servedFleets(machine, root);
  let opener: { readonly quote: Json | undefined; readonly cited: readonly string[] } | undefined;

  if (side === "new") opener = { quote, cited };
  else {
    const thread = side ?? (answered === undefined ? undefined : asNumber(threadOf(answered)));
    const first = thread === undefined ? undefined : known.find((m) => m.id === thread);

    if (first !== undefined) opener = { quote: first.quote ?? placedBy(first.stored["marks"]), cited: first.parts.flatMap((p) => (p.mention === undefined ? [] : [p.mention])) };
  }

  if (opener === undefined) return [];
  const owners: string[] = [];

  for (const name of [quotedFleet(opener.quote, known), ...opener.cited]) {
    const fleet = fleetNamed(fleets, name);

    if (fleet !== undefined && !owners.includes(fleet)) owners.push(fleet);
  }

  return owners;
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
  marks?: JsonObject;
  mark?: number[];
  keep?: string;
  images?: string[];
  side?: Json;
  opens?: string;
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
  /** A batch of marks on a decision's body, as the page sends it (`marksOf` checks it). */
  readonly marks?: JsonObject;
  /** The marks of the batch `re` names that this message answers (`n` of each). */
  readonly mark?: readonly number[];
  /** Why the marks this message answers (`mark`) leave the decision as it is (`say --no-change`). */
  readonly keep?: string;
  /** The images pasted with it, as the page names them (`attachments/<hash>.<ext>`; `imagesOf` checks them). */
  readonly images?: Json;
  /** "new" opens a side chat; a number continues one. */
  readonly side?: number | "new";
  /** With `side: "new"`, the page's key for the side chat it opens (`opensOf` checks it): a later post with the
   * same key on the same decision joins that side chat instead of opening another. */
  readonly opens?: Json;
  /** The page of another origin the user posted from (the hub's config allows it), as its `Origin`. */
  readonly origin?: string;
  /** Called under the store's lock with the message about to be stored and what the store holds: the
   * fields it returns are stored with it (the hub's delivery to the coordinators, `delivered`). */
  readonly alongside?: (message: JsonObject, known: readonly Message[]) => JsonObject | undefined;
}

/** A draft checked and addressed (`prepare`), ready to be written. */
export interface Prepared {
  readonly draft: Draft;
  readonly resolved: Addressed;
  readonly marks: JsonObject | undefined;
  readonly answering: readonly number[] | undefined;
  readonly keep: string | undefined;
  readonly quote: JsonObject | undefined;
  readonly images: readonly string[];
  readonly opens: string | undefined;
}

/** What a side chat's open key may be: short, of letters, digits, `-` and `_`. */
const OPEN_KEY = /^[A-Za-z0-9_-]{1,64}$/u;

/** A draft's open key, checked (undefined when it has none), or why it is refused. */
function opensOf(draft: Draft): string | undefined | ChatError {
  if (draft.opens === undefined || draft.opens === null) return undefined;

  if (draft.side !== "new") return new ChatError({ reason: "opens goes with side new: it names the side chat the post opens" });
  const key = asString(draft.opens);

  return key !== undefined && OPEN_KEY.test(key) ? key : new ChatError({ reason: "opens is the page's key for the side chat it opens: 1 to 64 of A-Z, a-z, 0-9, - and _" });
}

/** The page a quote was taken on (`at.hash`), which a side chat's open key is kept per. */
const quotedPage = (quote: Json | undefined): string | undefined => asString(asObject(asObject(quote)?.["at"])?.["hash"]);

/** The side chat a post with open key `key` on the page `quote` was taken on joins: the one a post with that key
 * there opened, or undefined when none did. */
function openedBy(known: readonly Message[], key: string, quote: Json | undefined): number | undefined {
  return known.find((m) => m.side === m.id && m.stored["opens"] === key && quotedPage(m.quote) === quotedPage(quote))?.id;
}

/** Check a draft and resolve whom it reaches, before anything is written: what `append` refuses outside the
 * store's lock. */
export function prepare(machine: Machine, root: string, draft: Draft): Prepared | ChatError {
  const resolved = address(machine, root, draft);

  if (resolved instanceof ChatError) return resolved;

  const images = imagesOf(root, draft.images);

  if (images === undefined) return new ChatError({ reason: IMAGES_REFUSED });

  if (draft.text.trim() === "" && images.length === 0) return new ChatError({ reason: "the message has no text" });

  if (!draft.text.isWellFormed()) return new ChatError({ reason: "the text is not valid UTF-8" });
  const marks = marksAlone(draft) ?? marksOf(draft.marks);

  if (marks instanceof ChatError) return marks;

  if (!allStored(root, markImages(marks).map(([, p]) => p))) return new ChatError({ reason: IMAGES_REFUSED });
  const answering = draft.mark === undefined || draft.mark.length === 0 ? undefined : [...new Set(draft.mark)];
  const keep = draft.keep?.trim();

  if (keep !== undefined && (keep === "" || [...keep].length > MARK_TEXT_MAX)) return new ChatError({ reason: `--no-change takes why, in 1 to ${MARK_TEXT_MAX} characters` });
  const opens = opensOf(draft);

  if (opens instanceof ChatError) return opens;
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

  return { draft, resolved, marks, answering, keep, quote, images, opens };
}

/** The mark an answer from `sender` to `parent` answers when it names none (no `--mark`): the batch's one mark,
 * since it can answer no other; undefined for a batch of several, a message without marks, and the user's
 * own words. So the page shows the answer in that mark's thread, and the follow-through counts it. */
function soleMark(sender: string, parent: Message | undefined): readonly number[] | undefined {
  const numbers = sender === "user" || parent === undefined ? [] : markNumbers(parent);

  return numbers.length === 1 ? numbers : undefined;
}

/** What `say` tells whoever answers a batch of several marks naming none (`--re` with no `--mark`): the
 * answer is the whole batch's, each mark stays unanswered on the page and on the watch. Undefined otherwise. */
export function noMarkWarning(root: string, sent: Message): string | undefined {
  if (sent.from === "user" || sent.re === null || (asArray(sent.stored["mark"]) ?? []).length > 0) return undefined;
  const numbers = readChat(root).flatMap((m) => (m.id === sent.re ? markNumbers(m) : []));

  return numbers.length < 2 ? undefined : `chat: #${pyText(sent.re)} carries marks ${numbers.join(", ")} and this answer names none: it answers no mark — add \`--mark N[,N...]\` to answer them`;
}

/** The message `p` is as stored with id `nextId` after `known` (before its `alongside`), or why the store
 * refuses it. */
function composed(p: Prepared, known: readonly Message[], nextId: number, at: string): JsonObject | ChatError {
  const { draft, resolved } = p;
  const parent = draft.re === undefined || draft.re === null ? undefined : known.find((m) => m.id === draft.re);
  const answering = p.answering ?? soleMark(resolved.from, parent);

  if (p.keep !== undefined && answering === undefined) return new ChatError({ reason: "--no-change needs --mark: the marks it leaves as they are" });

  if (answering !== undefined) {
    const batch = parent === undefined ? [] : markNumbers(parent);

    if (parent === undefined || batch.length === 0) return new ChatError({ reason: "--mark needs --re to a message with marks" });
    const stray = answering.find((n) => !batch.includes(n));

    if (stray !== undefined) return new ChatError({ reason: `mark ${stray} is not in message #${parent.id}` });
  }

  let side: Json | undefined;
  /* A post with the open key of a side chat already opened on its page joins it, as a message of it: no quote. */
  const joins = p.opens === undefined || draft.side !== "new" ? undefined : openedBy(known, p.opens, p.quote);

  if (draft.side === "new") side = joins ?? nextId;
  else if (draft.side !== undefined) {
    const wanted = draft.side;

    if (!sideChatIn(known, wanted)) return new ChatError({ reason: `no side chat #${wanted}` });

    // A batch goes in one side chat only: its decision's page thread.
    if (p.marks !== undefined && !pageThreadOf(known.find((m) => m.id === wanted), asString(asObject(p.marks["at"])?.["hash"]))) return new ChatError({ reason: MARKS_ALONE });
    side = wanted;
  } else if (parent !== undefined) side = threadOf(parent);

  const message: StoredMessage = {
    id: nextId,
    at,
    from: resolved.from,
    to: resolved.to,
    text: draft.text,
    re: draft.re ?? null,
    parts: resolved.parts.map((part) => (part.mention === undefined ? { text: part.text } : { text: part.text, mention: part.mention })),
  };

  if (draft.author !== undefined && draft.author !== "" && resolved.from === "user") message.author = draft.author;

  if (draft.decision !== undefined && draft.decision !== "") message.decision = draft.decision;

  if (p.quote !== undefined && joins === undefined) message.quote = p.quote;

  if (p.opens !== undefined && joins === undefined) message.opens = p.opens;

  if (p.marks !== undefined) message.marks = p.marks;

  if (answering !== undefined) message.mark = [...answering];

  if (p.keep !== undefined) message.keep = p.keep;

  if (p.images.length > 0) message.images = [...p.images];

  if (side !== undefined && truthy(side)) message.side = side;

  if (draft.origin !== undefined && draft.origin !== "" && resolved.from === "user") message.origin = draft.origin;

  return { ...message };
}

/** The messages `prepared` would be after `known`, each composed after the ones before it, without their
 * `alongside`; the first refusal instead. */
function composedAll(prepared: readonly Prepared[], known: readonly Message[], nextId: number, at: string): { readonly message: JsonObject; readonly before: readonly Message[] }[] | ChatError {
  const seen = [...known];
  const out: { readonly message: JsonObject; readonly before: readonly Message[] }[] = [];

  for (const [i, p] of prepared.entries()) {
    const message = composed(p, seen, nextId + i, at);

    if (message instanceof ChatError) return message;
    out.push({ message, before: [...seen] });
    const read = messageOf(message);

    if (read !== undefined) seen.push(read);
  }

  return out;
}

/** Why the store would refuse `prepared` now (a `--mark` or a side chat it does not hold), or undefined:
 * the hub asks before it grants anything. The write checks again under the lock. */
export function storeRefusal(root: string, prepared: readonly Prepared[], at: string): ChatError | undefined {
  const known = readChat(root);
  const got = composedAll(prepared, known, known.reduce((max, m) => Math.max(max, m.id), 0) + 1, at);

  return got instanceof ChatError ? got : undefined;
}

/** Append prepared messages in one write under the store's lock, in order, so a watch reads them in one
 * wake; each is composed after the ones before it. Nothing is written, and no `alongside` runs (the hub's
 * delivery to the coordinators), when any is refused. */
export function appendAll(root: string, prepared: readonly Prepared[], at: string): Message[] | ChatError {
  const stored = appendAllLocked(root, (known, nextId) => {
    const all = composedAll(prepared, known, nextId, at);

    if (all instanceof ChatError) return all;

    return all.map(({ message, before }, i) => ({ ...message, ...prepared[i]?.draft.alongside?.(message, before) }));
  });

  return stored instanceof Error && !(stored instanceof ChatError) ? new ChatError({ reason: stored.message }) : stored;
}

/** Append a message and return it as stored, with the recipients and parts `address` resolves. */
export function append(machine: Machine, root: string, draft: Draft, at: string): Message | ChatError {
  const prepared = prepare(machine, root, draft);

  if (prepared instanceof ChatError) return prepared;
  const stored = appendAll(root, [prepared], at);

  return stored instanceof ChatError ? stored : (stored[0] ?? new ChatError({ reason: "nothing was stored" }));
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

/** ` [3 marks on D30 d30, revision 2026-10-10T09:12:00Z; answer each with --re 12 --mark N]` on a batch of marks
 * (`answer with --re 12 --mark 4` for its one mark; no answer asked of a batch that only withdraws); empty on
 * any other message. The line itself says how to answer, so each answer lands in its mark's thread. */
function batchOf(m: Message, refs: ReadonlyMap<string, string>): string {
  const marks = asObject(m.stored["marks"]);
  const decision = asObject(marks?.["decision"]);

  if (marks === undefined || decision === undefined) return "";
  const count = (asArray(marks["items"]) ?? []).length;
  const id = pyText(decision["id"] ?? null);
  const ref = truthy(decision["ref"]) ? pyText(decision["ref"]) : refs.get(id);
  const gone = withdrawnNumbers(m);
  const withdrew = gone.length === 0 ? "" : `withdrew mark${gone.length === 1 ? "" : "s"} ${gone.join(", ")}`;
  const what = count === 0 ? withdrew : `${count} mark${count === 1 ? "" : "s"}${withdrew === "" ? "" : `, ${withdrew}`}`;
  const numbers = markNumbers(m);
  const answer = numbers.length === 0 ? "" : numbers.length === 1 ? `; answer with --re ${m.id} --mark ${numbers.join("")}` : `; answer each with --re ${m.id} --mark N`;

  return ` [${what} on ${oneLine(ref === undefined ? id : `${ref} ${id}`)}, revision ${oneLine(decision["revision"] ?? null)}${answer}]`;
}

/** `, mark 2` or `, marks 1, 3` on an answer to marks of a batch, then `, no change: <why>` when it keeps
 * them as they are; empty on any other message. */
function answered(m: Message): string {
  const numbers = (asArray(m.stored["mark"]) ?? []).map((n) => oneLine(n));
  const keep = asString(m.stored["keep"]);

  if (numbers.length === 0) return "";

  return `, mark${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}${keep === undefined ? "" : `, no change: ${oneLine(keep)}`}`;
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

    line += batchOf(m, refs);

    if (truthy(m.side)) line += ` [side chat #${pyText(m.side)}]`;
    line += marks(m);
    const quote = asObject(m.quote);
    const quoted = asString(quote?.["text"]);

    if (quote !== undefined && quoted !== undefined) {
      const from = truthy(quote["from"]) ? ` ${oneLine(quote["from"])}` : "";
      line += ` (quoting${from}: "${oneLine(quoted)}")`;
    }

    line += `: ${[oneLine(m.text), ...imageNotes(root, m.stored["images"]), ...markImageNotes(root, m.stored["marks"])].filter((s) => s !== "").join(" ")}`;

    if (m.re !== null) line += ` [re #${oneLine(m.re)}${answered(m)}]`;

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

/** The user's messages to the host of DIR after `seen` (the last a `--once` watch exited with) that still
 * wait: not answered with `--re`, not an answer to a decision since closed. Oldest first. */
export function unreadFromUser(root: string, seen: number, messages: readonly Message[] = readChat(root)): Message[] {
  const answered = new Set(messages.flatMap((m) => (m.from !== "user" && m.re !== null ? [pyRepr(m.re)] : [])));
  const closed = closedDecisions(root);

  return messages.filter(
    (m) =>
      m.id > seen &&
      m.from === "user" &&
      !answered.has(String(m.id)) &&
      !(truthy(m.decision) && closed.has(pyRepr(m.decision))) &&
      // So does one the hub delivered to every coordinator it names: each reads it in its own chat.
      waitsHere(m),
  );
}

/** Whether a `--once` watch as the host of DIR runs now, for the session that hosts the fleet (watchers.ts):
 * the one its pid file names, else one found among the running processes; never one whose session is gone,
 * nor one armed by a session that is not the host the registry names (a copy of it). No grace: a watch that
 * just ended is none. */
export function watchLive(machine: Machine, root: string): boolean {
  const who = hostOf(root);

  return liveWatch(root, who, intOf(readText(pulsePath(root, who))), TREE, liveHost(machine.registry, root)) !== undefined;
}

/** Whether the host of DIR reads its chat: a live `--once` watch (the one its pid file names, else one found
 * among the running processes; never one whose session is gone, watchers.ts), a watch that ended or a message
 * it sent in the last ten minutes; the last message a `--once` watch exited with; the user's messages after
 * it that still wait. */
export function listening(machine: Machine, root: string): Listening {
  const who = hostOf(root);
  const now = secondsNow(machine);
  let on = watchLive(machine, root);
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
  const unread = unreadFromUser(root, seen, messages);

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
