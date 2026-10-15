/**
 * The chat store, DIR/chat.jsonl: one message per line, appended under an exclusive `flock`. A line that
 * does not parse as a message is skipped by every reader, a torn last line is left alone (the next
 * append starts on a new line), and bytes that are not UTF-8 are read with replacement.
 */
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { readBytes } from "../files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseJson, type Json, type JsonObject, type JsonOut } from "../json.ts";
import { withExclusiveLock } from "../lock.ts";

/** One part of a message's text: plain, or a resolved mention. */
export type Part = {
  readonly text: string;
  readonly mention?: string;
};

/** A message as read: what every reader needs typed, and the whole stored object. */
export interface Message {
  readonly id: number;
  readonly from: string;
  readonly to: readonly string[];
  readonly text: string;
  /** The id of the message this one answers (any JSON a hand-written line holds; null when none). */
  readonly re: Json;
  readonly at: Json | undefined;
  readonly decision: Json | undefined;
  readonly author: Json | undefined;
  readonly side: Json | undefined;
  readonly quote: Json | undefined;
  readonly parts: readonly Part[];
  /** The stored object, with `re` and `parts` defaulted as Python reads them. */
  readonly stored: JsonObject;
}

const isInt = Schema.is(Schema.Int);

/** The store of `root`. */
export function storePath(root: string): string {
  return join(root, "chat.jsonl");
}

function partsOf(value: Json | undefined, text: string): Part[] {
  const items = asArray(value);

  if (items === undefined) return [{ text }];

  return items.flatMap((item) => {
    const object = asObject(item);
    const partText = asString(object?.["text"]);

    if (partText === undefined) return [];
    const mention = asString(object?.["mention"]);

    return [mention === undefined ? { text: partText } : { text: partText, mention }];
  });
}

/** The message a stored object is, or undefined when it lacks `id` (int), `from`, `to` (list) or `text`. */
export function messageOf(object: JsonObject): Message | undefined {
  const id = object["id"];
  const from = asString(object["from"]);
  const to = asArray(object["to"]);
  const text = asString(object["text"]);

  if (id === undefined || !isInt(id) || from === undefined || to === undefined || text === undefined) return undefined;
  const re = object["re"] === undefined ? null : (object["re"] ?? null);

  const stored: JsonObject = {
    ...object,
    re,
    parts: object["parts"] === undefined ? [{ text }] : (object["parts"] ?? null),
  };

  return {
    id: asNumber(id) ?? 0,
    from,
    to: to.map((x) => asString(x) ?? String(x)),
    text,
    re,
    at: object["at"],
    decision: object["decision"],
    author: object["author"],
    side: object["side"],
    quote: object["quote"],
    parts: partsOf(object["parts"], text),
    stored,
  };
}

/** The messages in the complete lines of `data`. */
export function parseStore(data: Buffer): Message[] {
  const messages: Message[] = [];

  for (const line of data.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    const object = asObject(Option.getOrUndefined(parseJson(line)));
    const message = object === undefined ? undefined : messageOf(object);

    if (message !== undefined) messages.push(message);
  }

  return messages;
}

/** How many bytes before its offset a {@link Tail} keeps, to tell an append from a rewrite. */
const SEAM = 256;

/** Reads the store incrementally: each `read()` returns the messages appended since the last one, a line
 * only once its newline is there. A store rewritten whole (a moved team's export, review O7, rewrites it in
 * place when its last line is not the fleet's) is read again from its start, its ids above the last returned:
 * read on from the old offset, the rewrite's bytes there fall mid-line and the line holding them is lost. */
export class Tail {
  private offset = 0;
  /** The last bytes read, which end at `offset`: still there, the store was only appended to. */
  private seam = Buffer.alloc(0);
  private after: number;
  readonly root: string;

  constructor(root: string, after = 0) {
    this.root = root;
    this.after = after;
  }

  read(): Message[] {
    const path = storePath(this.root);
    let fd: number;

    try {
      fd = openSync(path, "r");
    } catch {
      return [];
    }

    let complete: Buffer;

    try {
      const size = fstatSync(fd).size;
      const seen = Buffer.alloc(this.seam.length);

      if (size >= this.offset && seen.length > 0) readSync(fd, seen, 0, seen.length, this.offset - seen.length);

      if (size < this.offset || !seen.equals(this.seam)) {
        this.offset = 0;
        this.seam = Buffer.alloc(0);
      }

      if (size === this.offset) return [];
      const chunk = Buffer.alloc(size - this.offset);
      readSync(fd, chunk, 0, chunk.length, this.offset);
      complete = chunk.subarray(0, chunk.lastIndexOf(0x0a) + 1);
    } finally {
      closeSync(fd);
    }

    this.offset += complete.length;
    this.seam = Buffer.from(Buffer.concat([this.seam, complete.subarray(-SEAM)]).subarray(-SEAM));
    const out: Message[] = [];

    for (const m of parseStore(complete)) {
      if (m.id > this.after) {
        out.push(m);
        this.after = m.id;
      }
    }

    return out;
  }
}

/** Every message of `root` with id > `after`, oldest first. */
export function readChat(root: string, after = 0): Message[] {
  return new Tail(root, after).read();
}

/** What {@link appendLocked} decides inside the lock, from the messages already stored. */
export type Compose = (known: readonly Message[], nextId: number) => JsonOut | Error;

/** What {@link appendAllLocked} decides inside the lock: the messages to write, in order, the first taking
 * the next id. */
export type ComposeAll = (known: readonly Message[], nextId: number) => readonly JsonOut[] | Error;

/** Append one message under the store's lock: `compose` builds it from what is stored (its id is the
 * next one) or refuses with an error, which is returned and nothing is written. */
export function appendLocked(root: string, compose: Compose): Message | Error {
  const stored = appendAllLocked(root, (known, nextId) => {
    const message = compose(known, nextId);

    return message instanceof Error ? message : [message];
  });

  return stored instanceof Error ? stored : (stored[0] ?? new Error("nothing was stored"));
}

/** Append several messages in one write under the store's lock, so a reader sees them all at once or none:
 * `compose` builds them from what is stored or refuses with an error, which is returned and nothing is
 * written. */
export function appendAllLocked(root: string, compose: ComposeAll): Message[] | Error {
  const fd = openSync(storePath(root), "a+");

  try {
    return withExclusiveLock(fd, () => {
      const size = fstatSync(fd).size;
      const data = Buffer.alloc(size);

      if (size > 0) readSync(fd, data, 0, size, 0);
      const known = parseStore(data);
      const nextId = known.reduce((max, m) => Math.max(max, m.id), 0) + 1;
      const messages = compose(known, nextId);

      if (messages instanceof Error) return messages;
      const torn = size > 0 && data[size - 1] !== 0x0a;
      const lines = messages.map((message) => dumps(message, { ensureAscii: false }));
      const bytes = Buffer.from(`${torn ? "\n" : ""}${lines.map((line) => `${line}\n`).join("")}`, "utf8");
      let at = 0;

      while (at < bytes.length) at += writeSync(fd, bytes, at);

      const read = lines.map((line) => {
        const object = asObject(Option.getOrUndefined(parseJson(line)));

        return object === undefined ? undefined : messageOf(object);
      });

      return read.some((m) => m === undefined) ? new Error("the stored message does not read back") : read.flatMap((m) => (m === undefined ? [] : [m]));
    });
  } finally {
    closeSync(fd);
  }
}

/** The raw bytes of the store, or undefined. */
export function storeBytes(root: string): Buffer | undefined {
  return readBytes(storePath(root));
}
