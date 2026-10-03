/**
 * The places this browser opened last on a page, for the finder (after Casos's navigation/places.ts and
 * kept.ts): a decision's page, a worker's sheet, a view, a chat message, a link. Each is a finder row (its
 * key, words and where it leads) and when it was opened; the list holds each key once, newest first, at most
 * RECENTS_KEPT, in the page's own storage (its prefs, per page path) under a version. What is read back is
 * parsed: another version, or anything not a list of places, is nothing kept, and a bad entry is dropped
 * alone. Each visit reads the storage again before it writes, so what another tab of the page opened
 * meanwhile is kept too.
 */
import { createSignal, type Accessor } from "solid-js";

import type { FindRow, Go, Json, JsonRecord, Prefs } from "./core.ts";

/** A place opened, and when (epoch ms). */
export interface Recent extends FindRow {
  readonly at: number;
}

/** How many places the list keeps. */
export const RECENTS_KEPT = 50;

/** The prefs key the list is under. */
export const RECENTS_KEY = "find-recent";

const VERSION = 1;

/** Whether a parsed value is an object rather than null, a list or a scalar. */
const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

/** A JSON object's fields, or null. */
const recordOf = (v: Json | undefined): JsonRecord | null => (isRecord(v) ? v : null);

const text = (v: Json | undefined): v is string => v === String(v);

/** Whether a parsed value is a finite number. */
const isNumber = (v: Json | undefined): v is number => v === Number(v) && Number.isFinite(v);

/** Where a stored place leads, when it is a place the page still knows how to go to. */
function goOf(v: Json | undefined): Go | null {
  const g = recordOf(v);

  if (!g) return null;
  const { kind } = g;

  if ((kind === "decision" || kind === "worker") && text(g["id"]) && g["id"]) return { kind, id: g["id"] };

  if (kind === "url" && text(g["url"])) return { kind, url: g["url"] };

  if (kind === "view" && text(g["hash"])) return { kind, hash: g["hash"] };
  const side = g["side"];

  if (kind === "message" && Number.isInteger(g["id"]) && (side === null || Number.isInteger(side))) return { kind, id: Number(g["id"]), side: side === null ? null : Number(side) };

  return null;
}

/** One stored place, or null when it is not one. */
function placeOf(v: Json | undefined): Recent | null {
  const p = recordOf(v);
  const go = p ? goOf(p["go"]) : null;

  if (!p || !go || !text(p["key"]) || !p["key"] || !text(p["group"]) || !text(p["title"]) || !isNumber(p["at"])) return null;
  const str = (k: string): string => (text(p[k]) ? String(p[k]) : "");

  return { key: p["key"], group: p["group"], ref: str("ref"), title: p["title"], sub: str("sub"), hint: str("hint"), pill: str("pill"), go, at: p["at"] };
}

/** The places in a stored value: [] for another version or anything else. */
export function parseRecents(v: Json | undefined): Recent[] {
  const kept = recordOf(v);
  const places = kept?.["places"];

  if (!kept || kept["v"] !== VERSION || !Array.isArray(places)) return [];

  return places.flatMap((p) => placeOf(p) ?? []);
}

/** Two lists as one: each key once, by its newest visit, newest first, at most RECENTS_KEPT. */
export function merged(a: readonly Recent[], b: readonly Recent[]): Recent[] {
  const byKey = new Map<string, Recent>();

  for (const r of [...a, ...b]) {
    const seen = byKey.get(r.key);

    if (!seen || r.at > seen.at) byKey.set(r.key, r);
  }

  return [...byKey.values()].sort((x, y) => y.at - x.at).slice(0, RECENTS_KEPT);
}

/** The list after visiting `place`: it moves to the front with its words and time, once. */
export const visited = (list: readonly Recent[], place: Recent): Recent[] => [place, ...list.filter((r) => r.key !== place.key)].slice(0, RECENTS_KEPT);

/** A page's recents. */
export interface Recents {
  /** The places, newest first. */
  readonly list: Accessor<readonly Recent[]>;
  /** Records a visit, in the list and the storage. */
  visit(place: FindRow): void;
  /** Reads the storage again: what another tab opened. */
  reload(): void;
}

/** The recents kept in `prefs`, timed by `now`. */
export function createRecents(prefs: Pick<Prefs, "get" | "set">, now: () => number = Date.now): Recents {
  const read = (): Recent[] => parseRecents(prefs.get<Json>(RECENTS_KEY, null));
  /* The list as it is now: a signal's write is read back only once it flushes. */
  let list: readonly Recent[] = read();
  const [get, set] = createSignal<readonly Recent[]>(list);

  return {
    /* Tracked through the signal, read from the list itself, so a visit is there at once. */
    list: () => {
      get();

      return list;
    },
    visit(place) {
      list = visited(merged(list, read()), { ...place, at: now() });
      prefs.set(RECENTS_KEY, { v: VERSION, places: list.map((r) => ({ ...r, go: { ...r.go } })) });
      set(list);
    },
    reload() {
      list = merged(list, read());
      set(list);
    },
  };
}
