/**
 * What a fleet's page in the manager's frame (`?embed=1`) tells the manager, posted to its own origin only:
 * its height, `{fleetEmbed: true, height}`, an answer sent there, `{fleetEmbed: true, answered}`, text
 * selected in it, `{fleetEmbed: true, select: {text, rect, from, touch, at?, anchor?}}` (`at` the place on the fleet's
 * page, as a quote keeps it; `anchor` a selection in the decision's body as its frame reads it, for a mark;
 * `text` empty and `rect` null once cleared), and what only the manager's page can do: open another of the fleet's decisions there,
 * `{fleetEmbed: true, open}`, its finder, `{fleetEmbed: true, finder: true}`, and its composer about the
 * decision shown, `{fleetEmbed: true, ask: {id, ref, title, question, side, text}}` (Ask in the chat, Side
 * chat, Change my answer: `side` a new side chat, `text` the first words).
 * The marks' messages between the manager and the body's frame (`annot…`, markframe.ts) pass through the
 * fleet's page both ways, each rebuilt from its own fields and nothing else (`parseFrameSaid`,
 * `parseFrameCommand`): the body's scripts post from the same frame, so nothing the frame says rides along.
 */
import { Core, type ItemRef, type Json, type JsonRecord, type MarkKind, type QuoteAt } from "./core.ts";
import { parseClaim, QUOTED_KINDS, type Claimed } from "./marks.ts";

/** Where a selection sits in the frame's viewport: its first line's top, its last line's bottom, and across. */
export type SelRect = { readonly top: number; readonly bottom: number; readonly left: number; readonly width: number };

/** A message from the frame, as the manager reads it. */
export type EmbedMessage =
  | { readonly kind: "height"; readonly height: number }
  | { readonly kind: "answered"; readonly id: string }
  | { readonly kind: "select"; readonly text: string; readonly rect: SelRect | null; readonly from: string; readonly touch: boolean; readonly at: QuoteAt | null; readonly anchor?: readonly Claimed[] }
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

  const said = { kind: "select", text, rect: text ? rect : null, from, touch: v["touch"] === true, at: text ? Core.parseQuoteAt(v["at"]) : null } as const;
  const anchor = text ? parseClaim(v["anchor"]) : null;

  return anchor ? { ...said, anchor } : said;
}

/** A selection's blocks as a message carries them: only their words and the text around them. */
const claimJson = (claim: readonly Claimed[]): JsonRecord => ({ blocks: claim.map((b) => ({ exact: b.exact, prefix: b.prefix, suffix: b.suffix })) });

/**
 * What a decision's evidence frame posts of its selection (`{fleetSelect, text, rect, touch, anchor}`), or
 * null for any other message: `anchor` the blocks it claims (to be checked against the body), `raw` the
 * same rebuilt for relaying, nothing else of the message.
 */
export function parseEvidenceSelect(data: Json | undefined): { readonly text: string; readonly rect: SelRect | null; readonly touch: boolean; readonly anchor: readonly Claimed[] | null; readonly raw: Json } | null {
  if (!isRecord(data) || data["fleetSelect"] !== true) return null;
  const text = isString(data["text"]) ? data["text"] : "";
  const anchor = text ? parseClaim(data["anchor"]) : null;

  return { text, rect: parseSelRect(data["rect"]), touch: data["touch"] === true, anchor, raw: anchor ? claimJson(anchor) : null };
}

/**
 * A marks' message from a decision's body frame (markframe.ts), as the page reads it: that it is ready (or
 * painted), the selection it claims for a kind of mark the page asked about, a mark it says was tapped, and
 * Escape pressed in it. A claim, never a command: the page checks a selection against the body, acts on a
 * tap only after a real one, and lets Escape close the selection bar only.
 */
export type FrameSaid =
  | { readonly kind: "ready" }
  | { readonly kind: "placed" }
  | { readonly kind: "now"; readonly mark: MarkKind; readonly claim: readonly Claimed[] | null }
  | { readonly kind: "tap"; readonly id: string }
  | { readonly kind: "esc" };

/** A mark's id as the page names it to the frame: `d<n>` a draft, `s<batch>-<n>` one sent. */
const MARK_ID = /^(d\d{1,9}|s\d{1,12}-\d{1,9})$/u;

/** A marks' message from the body's frame, rebuilt from its own fields; null for anything else. */
export function parseFrameSaid(data: Json | undefined): FrameSaid | null {
  if (!isRecord(data)) return null;

  if (data["annotReady"] === true) return { kind: "ready" };

  if (data["annotPlaced"] === true) return { kind: "placed" };

  if (data["annotNowSel"] === true) {
    const mark = QUOTED_KINDS.find((k) => k === data["kind"]);

    return mark ? { kind: "now", mark, claim: parseClaim(data["anchor"]) } : null;
  }

  if (data["annotTap"] === true) {
    const id = data["id"];

    return isString(id) && MARK_ID.test(id) ? { kind: "tap", id } : null;
  }

  return data["annotEsc"] === true ? { kind: "esc" } : null;
}

/** A frame's message as the fleet's page relays it to the manager's: its own fields, rebuilt, and nothing else. */
export function frameSaidJson(said: FrameSaid): JsonRecord {
  switch (said.kind) {
    case "ready":
      return { annotReady: true };
    case "placed":
      return { annotPlaced: true };
    case "now":
      return { annotNowSel: true, kind: said.mark, anchor: said.claim ? claimJson(said.claim) : null };
    case "tap":
      return { annotTap: true, id: said.id };
    case "esc":
      return { annotEsc: true };
  }
}

/** One mark as the page tells the frame to paint it. */
const paintOf = (v: Json | undefined): JsonRecord | null => {
  if (!isRecord(v) || !isString(v["id"]) || !MARK_ID.test(v["id"]) || !isNumber(v["n"]) || !isString(v["kind"]) || !Array.isArray(v["blocks"])) return null;
  const claim = parseClaim(v);

  return claim ? { ...claimJson(claim), id: v["id"], n: v["n"], kind: v["kind"], done: v["done"] === true, active: v["active"] === true, show: v["show"] === true } : null;
};

/**
 * A marks' message from the manager's page to the body's frame, as the fleet's page relays it: paint these
 * marks, read the selection now for a kind, clear the selection; rebuilt from its own fields, null for anything else.
 */
export function parseFrameCommand(data: Json | undefined): JsonRecord | null {
  if (!isRecord(data)) return null;

  if (data["annotPaint"] === true) {
    const marks: JsonRecord[] = [];

    for (const m of Array.isArray(data["marks"]) ? data["marks"] : []) {
      const paint = paintOf(m);

      if (paint) marks.push(paint);
    }

    return { annotPaint: true, marks };
  }

  if (data["annotNow"] !== undefined) {
    const mark = QUOTED_KINDS.find((k) => k === data["annotNow"]);

    return mark ? { annotNow: mark } : null;
  }

  return data["annotClearSel"] === true ? { annotClearSel: true } : null;
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

/** Text selected in the frame, where it sits, where on the page it is (as words and as a place), whether a touch made it, and in the body's frame the selection as it reads it (`anchor`); empty text once cleared. */
export function postSelect(text: string, rect: SelRect | null, from: string, touch: boolean, at: QuoteAt | null = null, anchor: Json = null): void {
  const select = { text, rect: text ? rect : null, from: text ? from : "", touch: text ? touch : false };
  const placed = text && at ? { ...select, at: { ...at } } : select;

  post({ fleetEmbed: true, select: text && anchor !== null ? { ...placed, anchor } : placed });
}

/** A marks' message from the body's frame, told to the manager: rebuilt from its own fields. */
export const postMark = (said: FrameSaid): void => post(frameSaidJson(said));

/** Another of the fleet's decisions, to open on the manager's page. */
export const postOpen = (id: string): void => post({ fleetEmbed: true, open: id });

/** The manager's finder, asked for from inside the frame. */
export const postFinder = (): void => post({ fleetEmbed: true, finder: true });

/** The manager's composer, asked for about `item` from inside the frame: in a new side chat with `side`, starting with `text`. */
export const postAsk = (item: ItemRef, side: boolean, text: string): void => post({ fleetEmbed: true, ask: { id: item.id, ref: item.ref ?? "", title: item.title, question: item.question, side, text } });
