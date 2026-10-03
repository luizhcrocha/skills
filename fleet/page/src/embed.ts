/**
 * What a fleet's page in the manager's frame (`?embed=1`) tells the manager, posted to its own origin only:
 * its height, `{fleetEmbed: true, height}`, an answer sent there, `{fleetEmbed: true, answered}`, text
 * selected in it, `{fleetEmbed: true, select: {text, rect, from, touch, at?}}` (`at` the place on the fleet's
 * page, as a quote keeps it; `text` empty and `rect` null once cleared), and what only the manager's page can do: open another of the fleet's decisions there,
 * `{fleetEmbed: true, open}`, its finder, `{fleetEmbed: true, finder: true}`, and its composer about the
 * decision shown, `{fleetEmbed: true, ask: {id, ref, title, question, side, text}}` (Ask in the chat, Side
 * chat, Change my answer: `side` a new side chat, `text` the first words).
 */
import { Core, type ItemRef, type Json, type JsonRecord, type QuoteAt } from "./core.ts";

/** Where a selection sits in the frame's viewport: its first line's top, its last line's bottom, and across. */
export type SelRect = { readonly top: number; readonly bottom: number; readonly left: number; readonly width: number };

/** A message from the frame, as the manager reads it. */
export type EmbedMessage =
  | { readonly kind: "height"; readonly height: number }
  | { readonly kind: "answered"; readonly id: string }
  | { readonly kind: "select"; readonly text: string; readonly rect: SelRect | null; readonly from: string; readonly touch: boolean; readonly at: QuoteAt | null }
  | { readonly kind: "open"; readonly id: string }
  | { readonly kind: "finder" }
  | { readonly kind: "ask"; readonly item: ItemRef; readonly side: boolean; readonly text: string };

/** The tallest a frame is made, whatever height it reports. */
export const FRAME_MAX_PX = 20_000;

const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

const isNumber = (v: Json | undefined): v is number => v === Number(v);

const isString = (v: Json | undefined): v is string => v === String(v);

/** A selection's place as posted, or null when it is not one. */
export function parseSelRect(v: Json | undefined): SelRect | null {
  if (!isRecord(v)) return null;
  const { top, bottom, left, width } = v;

  return isNumber(top) && isNumber(bottom) && isNumber(left) && isNumber(width) ? { top, bottom, left, width } : null;
}

/** A selection as posted: text with its place, or the empty text of one cleared; null for anything else. */
function parseSelect(v: Json | undefined): EmbedMessage | null {
  if (!isRecord(v)) return null;
  const { text, from } = v;
  const rect = parseSelRect(v["rect"]);

  if (!isString(text) || !isString(from) || (text && !rect)) return null;

  return { kind: "select", text, rect: text ? rect : null, from, touch: v["touch"] === true, at: text ? Core.parseQuoteAt(v["at"]) : null };
}

/** What a decision's evidence frame posts of its selection (`{fleetSelect, text, rect}`), or null for any other message. */
export function parseEvidenceSelect(data: Json | undefined): { readonly text: string; readonly rect: SelRect | null; readonly touch: boolean } | null {
  if (!isRecord(data) || data["fleetSelect"] !== true) return null;
  const text = data["text"];

  return { text: isString(text) ? text : "", rect: parseSelRect(data["rect"]), touch: data["touch"] === true };
}

/** An ask about the decision shown, as posted; null for anything else. */
function parseAsk(v: Json | undefined): EmbedMessage | null {
  if (!isRecord(v)) return null;
  const { id, ref, title, question, text } = v;

  if (!isString(id) || !/^[A-Za-z0-9_.-]+$/u.test(id) || !isString(title) || !isString(question)) return null;

  return { kind: "ask", item: isString(ref) && ref ? { id, ref, title, question } : { id, title, question }, side: v["side"] === true, text: isString(text) ? text : "" };
}

/** A message as the frame posts it, or null for anything else (the evidence frame's, another page's). */
export function parseEmbedMessage(data: Json | undefined): EmbedMessage | null {
  if (!isRecord(data) || data["fleetEmbed"] !== true) return null;
  const height = data["height"];
  const answered = data["answered"];

  if ("select" in data) return parseSelect(data["select"]);

  if ("open" in data) {
    const id = data["open"];

    return isString(id) && /^[A-Za-z0-9_.-]+$/u.test(id) ? { kind: "open", id } : null;
  }

  if ("finder" in data) return data["finder"] === true ? { kind: "finder" } : null;

  if ("ask" in data) return parseAsk(data["ask"]);

  if (height === Number(height) && Number(height) > 0) return { kind: "height", height: Number(height) };

  return answered === String(answered) && answered ? { kind: "answered", id: String(answered) } : null;
}

const post = (data: Json): void => parent.postMessage(data, location.origin);

export const postHeight = (): void => post({ fleetEmbed: true, height: Math.ceil(document.documentElement.getBoundingClientRect().height) });

export const postAnswered = (id: string): void => post({ fleetEmbed: true, answered: id });

/** Text selected in the frame, where it sits, where on the page it is (as words and as a place), and whether a touch made it; empty text once cleared. */
export function postSelect(text: string, rect: SelRect | null, from: string, touch: boolean, at: QuoteAt | null = null): void {
  const select = { text, rect: text ? rect : null, from: text ? from : "", touch: text ? touch : false };

  post({ fleetEmbed: true, select: text && at ? { ...select, at: { ...at } } : select });
}

/** Another of the fleet's decisions, to open on the manager's page. */
export const postOpen = (id: string): void => post({ fleetEmbed: true, open: id });

/** The manager's finder, asked for from inside the frame. */
export const postFinder = (): void => post({ fleetEmbed: true, finder: true });

/** The manager's composer, asked for about `item` from inside the frame: in a new side chat with `side`, starting with `text`. */
export const postAsk = (item: ItemRef, side: boolean, text: string): void => post({ fleetEmbed: true, ask: { id: item.id, ref: item.ref ?? "", title: item.title, question: item.question, side, text } });
