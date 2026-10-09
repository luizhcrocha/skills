/**
 * The machine's news (`fleet news`, Python's `news.py`): what a session tells the fleets that wakes nobody,
 * release notes, FYIs and rules, in one append-only, numbered `REGISTRY/news/news.jsonl`, with a cursor per
 * reader in `REGISTRY/news/read/<fleet>`. A reader sees an item addressed to `all` or to it, never its own.
 * A coordinator learns of unread news from one line ({@link unreadLine}) on a wake that happens anyway: its
 * chat watch exiting for a real message, every `fleet state` command, the plugin's SessionStart and Stop hooks.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";

import { stampOf } from "../clock.ts";
import { Refusal } from "../errors.ts";
import { exists, isDir, listDir, makeDirs, readBytes, readText, writeText } from "../files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseJson, pyStr, type Json } from "../json.ts";
import { oneLine } from "../chat/chat.ts";
import { withExclusiveLock } from "../lock.ts";
import { alive, pidOf } from "../registry.ts";
import type { Machine } from "../world.ts";

/** What an item is. */
export const KINDS = ["release", "fyi", "rule"] as const;

/** Characters of one item: news is short; a long part goes in a file named by its path. */
export const TEXT_MAX = 1000;

const NAME = /^[A-Za-z0-9_.-]+$/u;

/** One item as stored. */
export interface Item {
  readonly id: number;
  readonly at: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly kind: string;
  readonly keep: boolean;
  readonly text: string;
}

/** The news folder of this machine's registry. */
export function newsFolder(machine: Machine): string {
  return join(machine.registry.place.home, "news");
}

function logPath(machine: Machine): string {
  return join(newsFolder(machine), "news.jsonl");
}

function cursorPath(machine: Machine, fleet: string): string {
  return join(newsFolder(machine), "read", fleet);
}

function refused(reason: string): Refusal {
  return new Refusal({ speaker: "news", reason });
}

function itemOf(row: Json | undefined): Item | undefined {
  const o = asObject(row);
  const id = asNumber(o?.["id"]);
  const from = asString(o?.["from"]);
  const to = asArray(o?.["to"]);
  const text = asString(o?.["text"]);

  if (o === undefined || id === undefined || !Number.isInteger(id) || from === undefined || to === undefined || text === undefined) return undefined;

  return {
    id,
    at: asString(o["at"]) ?? "",
    from,
    to: to.map((t) => asString(t) ?? String(t)),
    kind: asString(o["kind"]) ?? "",
    keep: o["keep"] === true,
    text,
  };
}

function parseItems(data: Buffer): Item[] {
  return data
    .toString("utf8")
    .split("\n")
    .flatMap((raw) => {
      if (raw.trim() === "") return [];
      const item = itemOf(Option.getOrUndefined(parseJson(raw)));

      return item === undefined ? [] : [item];
    });
}

/** Every item, oldest first. */
export function readNews(machine: Machine): Item[] {
  const data = readBytes(logPath(machine));

  return data === undefined ? [] : parseItems(data);
}

function name(value: string, what: string): string | Refusal {
  const given = value.trim();

  return NAME.test(given) ? given : refused(`${what} is a fleet's or a session's name ([A-Za-z0-9_.-]), not ${pyStr(given)}`);
}

/** What `post` takes. */
export interface Post {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly keep: boolean;
  readonly text: string;
}

/** Append an item under the log's lock; the item as stored, or why it is refused. */
export function post(machine: Machine, given: Post): Item | Refusal {
  const from = name(given.from, "--from");

  if (from instanceof Refusal) return from;
  const names = given.to.split(",").map((n) => n.trim());
  let to: string[];

  if (names.length === 1 && names[0] === "all") {
    to = ["all"];
  } else if (names.includes("all")) {
    return refused("--to is `all` or a list of fleets, not both");
  } else {
    to = [];

    for (const n of names) {
      const ok = name(n, "--to");

      if (ok instanceof Refusal) return ok;

      if (!to.includes(ok)) to.push(ok);
    }
  }

  if (given.text.trim() === "") return refused("the item has no text");
  const length = [...given.text].length;

  if (length > TEXT_MAX) {
    return refused(`an item is at most ${TEXT_MAX} characters, and this one is ${length}: say it short, and put the long part in a file and give its path`);
  }

  makeDirs(newsFolder(machine));
  const fd = openSync(logPath(machine), "a+");

  try {
    return withExclusiveLock(fd, () => {
      const size = fstatSync(fd).size;
      const data = Buffer.alloc(size);

      if (size > 0) readSync(fd, data, 0, size, 0);
      const id = parseItems(data).reduce((max, i) => Math.max(max, i.id), 0) + 1;
      const item: Item = { id, at: stampOf(machine.now()), from, to, kind: given.kind, keep: given.keep, text: given.text.trim() };
      const torn = size > 0 && data[size - 1] !== 0x0a;
      const bytes = Buffer.from(`${torn ? "\n" : ""}${dumps({ ...item, to: [...item.to] }, { ensureAscii: false })}\n`, "utf8");
      let at = 0;

      while (at < bytes.length) at += writeSync(fd, bytes, at);

      return item;
    });
  } finally {
    closeSync(fd);
  }
}

/** One item as one printed line: `#3 2026-01-05 09:00 skills -> all [rule, keep]: text`. */
export function newsLine(item: Item): string {
  const at = item.at.slice(0, 16).replace("T", " ");
  const save = item.keep ? "keep" : "do not save";

  return `#${item.id} ${at} ${oneLine(item.from)} -> ${item.to.map((t) => oneLine(t)).join(", ")} [${oneLine(item.kind === "" ? "fyi" : item.kind)}, ${save}]: ${oneLine(item.text)}`;
}

function cursorOf(machine: Machine, fleet: string): number {
  const n = Number.parseInt((readText(cursorPath(machine, fleet)) ?? "").trim(), 10);

  return Number.isNaN(n) ? 0 : n;
}

/** The items `fleet` reads: to all or to it, not its own. */
export function forReader(items: readonly Item[], fleet: string): Item[] {
  return items.filter((i) => (i.to.includes("all") || i.to.includes(fleet)) && i.from !== fleet);
}

/** What `fleet` has not read yet, oldest first. */
export function unread(machine: Machine, fleet: string): Item[] {
  const after = cursorOf(machine, fleet);

  return forReader(readNews(machine), fleet).filter((i) => i.id > after);
}

/** Move `fleet`'s cursor past every item of `items` (those not for it too). */
export function markRead(machine: Machine, fleet: string, items: readonly Item[]): void {
  const last = items.reduce((max, i) => Math.max(max, i.id), 0);

  if (last <= cursorOf(machine, fleet)) return;
  makeDirs(join(newsFolder(machine), "read"));
  writeText(cursorPath(machine, fleet), String(last));
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The name the registry gives the fleet at `root`, read without touching the registry (no entry is pruned
 * or renamed here): the first entry, by file name, whose dir is root. */
export function fleetOf(machine: Machine, root: string): string | undefined {
  const home = machine.registry.place.home;
  const want = real(root);

  for (const file of listDir(home).filter((n) => n.endsWith(".json")).sort()) {
    const path = join(home, file);

    if (isDir(path)) continue;
    const entry = asObject(Option.getOrUndefined(parseJson(readText(path) ?? "")));
    const dir = asString(entry?.["dir"]);
    const id = asString(entry?.["id"]);

    if (dir !== undefined && id !== undefined && real(dir) === want) return id;
  }

  return undefined;
}

/** The name of the manager the registry serves, read without touching the registry: the first entry, by file
 * name, whose role is manager and whose process runs; undefined when there is none. */
export function managerOf(machine: Machine): string | undefined {
  const home = machine.registry.place.home;

  for (const file of listDir(home).filter((n) => n.endsWith(".json")).sort()) {
    const path = join(home, file);

    if (isDir(path)) continue;
    const entry = asObject(Option.getOrUndefined(parseJson(readText(path) ?? "")));
    const id = asString(entry?.["id"]);

    if (entry?.["role"] === "manager" && id !== undefined && alive(pidOf(entry["pid"]))) return id;
  }

  return undefined;
}

/** The one line that tells the fleet at `root` of its unread news, or undefined: none, no news file, or a
 * fleet the registry does not name. */
export function unreadLine(machine: Machine, root: string): string | undefined {
  if (!exists(logPath(machine))) return undefined;
  const fleet = fleetOf(machine, root);

  if (fleet === undefined) return undefined;
  const count = unread(machine, fleet).length;

  return count === 0 ? undefined : `news: ${count} unread for ${fleet}, never a wake: \`fleet news read --as ${fleet}\``;
}

/** `read --as FLEET`'s check of the name. */
export function readerName(value: string): string | Refusal {
  return name(value, "--as");
}
