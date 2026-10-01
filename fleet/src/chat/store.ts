/**
 * The chat store, DIR/chat.jsonl: one message per line, appended under an exclusive `flock`. A line that
 * does not parse as a message is skipped by every reader, a torn last line is left alone (the next
 * append starts on a new line), and bytes that are not UTF-8 are read with replacement.
 */
import { closeSync, fstatSync, openSync, readSync, statSync, writeSync } from "node:fs";
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

/** Reads the store incrementally: each `read()` returns the messages appended since the last one, a line
 * only once its newline is there. */
export class Tail {
  private offset = 0;
  private after: number;
  readonly root: string;

  constructor(root: string, after = 0) {
    this.root = root;
    this.after = after;
  }

  read(): Message[] {
    const path = storePath(this.root);
    let size: number;

    try {
      size = statSync(path).size;
    } catch {
      return [];
    }

    if (size < this.offset) this.offset = 0;

    if (size === this.offset) return [];
    const chunk = Buffer.alloc(size - this.offset);
    const fd = openSync(path, "r");

    try {
      readSync(fd, chunk, 0, chunk.length, this.offset);
    } finally {
      closeSync(fd);
    }

    const complete = chunk.subarray(0, chunk.lastIndexOf(0x0a) + 1);
    this.offset += complete.length;
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

/** Append one message under the store's lock: `compose` builds it from what is stored (its id is the
 * next one) or refuses with an error, which is returned and nothing is written. */
export function appendLocked(root: string, compose: Compose): Message | Error {
  const fd = openSync(storePath(root), "a+");

  try {
    return withExclusiveLock(fd, () => {
      const size = fstatSync(fd).size;
      const data = Buffer.alloc(size);

      if (size > 0) readSync(fd, data, 0, size, 0);
      const known = parseStore(data);
      const nextId = known.reduce((max, m) => Math.max(max, m.id), 0) + 1;
      const message = compose(known, nextId);

      if (message instanceof Error) return message;
      const torn = size > 0 && data[size - 1] !== 0x0a;
      const line = `${torn ? "\n" : ""}${dumps(message, { ensureAscii: false })}\n`;
      const bytes = Buffer.from(line, "utf8");
      let at = 0;

      while (at < bytes.length) at += writeSync(fd, bytes, at);

      const read = asObject(Option.getOrUndefined(parseJson(dumps(message, { ensureAscii: false }))));

      return (read === undefined ? undefined : messageOf(read)) ?? new Error("the stored message does not read back");
    });
  } finally {
    closeSync(fd);
  }
}

/** The raw bytes of the store, or undefined. */
export function storeBytes(root: string): Buffer | undefined {
  return readBytes(storePath(root));
}
