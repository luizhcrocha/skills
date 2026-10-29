/**
 * The plan's usage (Python's `usage.py`), captured from what Claude Code hands a status line: its
 * `rate_limits` (the 5-hour and 7-day windows, each `used_percentage` and `resets_at`) are kept in
 * `REGISTRY/usage/reading.json` and the manager's page is sent them. Sessions on one machine may run
 * under different logins, and the status line's input does not say which, so a reading is kept per
 * account: the one logged in to the session's config directory (`.claude.json`'s `oauthAccount`).
 * Within an account's window usage only grows, so an idle session's older figure never replaces a
 * newer one; a window that resets later is a new one. The page shows first the account whose session
 * captured last, then the others.
 */
import { renameSync } from "node:fs";
import { join } from "node:path";

import { readObject } from "./registry.ts";
import { makeDirs, readText, writeText } from "./files.ts";
import { asArray, asBoolean, asNumber, asObject, asString, dumps, type Json, type JsonObject, type JsonOut } from "./json.ts";

/** The windows a reading holds, and how the CLI names them. */
export const WINDOWS = new Map([
  ["five_hour", "5-hour window"],
  ["seven_day", "7-day window"],
]);

/** Who a session is logged in as: the key its reading is kept under, and the email the page names it by. */
export interface Account {
  readonly key: string;
  readonly email: string | null;
}

/** A session with no login recorded, and the file from before accounts. */
export const UNKNOWN: Account = { key: "unknown", email: null };

/** One account's reading: its email, when its session last captured (`seen`), and its windows. */
interface Held {
  readonly email: string | null;
  readonly seen: number;
  readonly windows: ReadonlyMap<string, JsonObject>;
}

function readingPath(home: string): string {
  return join(home, "usage", "reading.json");
}

const isNumber = (v: Json | undefined): boolean => asNumber(v) !== undefined && asBoolean(v) === undefined;

function isReading(value: Json | undefined): value is JsonObject {
  const object = asObject(value);

  return object !== undefined && isNumber(object["used_percentage"]) && isNumber(object["resets_at"]);
}

/**
 * Who the session is logged in as, from its config's `.claude.json` (where Claude Code keeps it:
 * `$CLAUDE_CONFIG_DIR`, else the home directory); only `oauthAccount`'s ids and email are read. The key
 * is the account and its organization, whose plan the limits are. A config with no login is
 * {@link UNKNOWN}; undefined when the file is there but can't be read, so nothing is kept under a wrong name.
 */
export function accountOf(env: (name: string) => string | undefined): Account | undefined {
  const config = env("CLAUDE_CONFIG_DIR");
  const path = join(config !== undefined && config !== "" ? config : (env("HOME") ?? ""), ".claude.json");
  const text = readText(path);

  if (text === undefined) return UNKNOWN;
  let held: Json;

  try {
    held = JSON.parse(text);
  } catch {
    return undefined;
  }

  const oauth = asObject(asObject(held)?.["oauthAccount"]);
  const uuid = asString(oauth?.["accountUuid"]);

  if (uuid === undefined || uuid === "") return UNKNOWN;
  const org = asString(oauth?.["organizationUuid"]);
  const email = asString(oauth?.["emailAddress"]);

  return { key: org !== undefined && org !== "" ? `${uuid}:${org}` : uuid, email: email !== undefined && email !== "" ? email : null };
}

/**
 * What is held, by account, the one that captured last first. The file before accounts (its windows at
 * the top) reads as {@link UNKNOWN}, seen when its newest window was.
 */
function readAccounts(home: string): Map<string, Held> {
  const file = readObject(readingPath(home));
  const out = new Map<string, Held>();

  if (file === undefined) return out;
  const given = "accounts" in file ? asObject(file["accounts"]) : { [UNKNOWN.key]: file };

  for (const [key, value] of Object.entries(given ?? {})) {
    const entry = asObject(value);
    const windows = new Map<string, JsonObject>();

    for (const window of WINDOWS.keys()) {
      const reading = entry?.[window];

      if (isReading(reading)) windows.set(window, reading);
    }

    if (entry === undefined || windows.size === 0) continue;
    const ats = [...windows.values()].flatMap((r) => (isNumber(r["at"]) ? [asNumber(r["at"]) ?? 0] : []));
    const seen = isNumber(entry["seen"]) ? (asNumber(entry["seen"]) ?? 0) : Math.max(0, ...ats);
    out.set(key, { email: asString(entry["email"]) ?? null, seen, windows });
  }

  return out;
}

function shown(held: Held): JsonObject {
  return { account: held.email, seen: held.seen, ...Object.fromEntries(held.windows) };
}

/**
 * What the page is sent: the account whose session captured last, `{account (its email, null when not
 * recorded), seen, window..., others: [the same for every other account, latest first]}`, or undefined.
 */
export function readUsage(home: string): JsonObject | undefined {
  const held = [...readAccounts(home).values()].toSorted((a, b) => b.seen - a.seen);
  const [first, ...rest] = held;

  return first === undefined ? undefined : { ...shown(first), others: rest.map(shown) };
}

/**
 * Fold a status line's `rate_limits` into `account`'s reading, at `nowS` (seconds since the epoch). A window
 * the input leaves out is kept. Another account's reading whose windows have all reset is dropped.
 */
export function keepUsage(home: string, limits: Json | undefined, nowS: number, pid: number, account: Account | undefined): void {
  const given = asObject(limits);

  if (given === undefined || account === undefined) return;
  const held = readAccounts(home);
  const windows = new Map(held.get(account.key)?.windows ?? []);
  let any = false;

  for (const window of WINDOWS.keys()) {
    const next = given[window];

    if (!isReading(next)) continue;
    any = true;
    const old = windows.get(window);
    const resets = asNumber(next["resets_at"]) ?? 0;
    const used = asNumber(next["used_percentage"]) ?? 0;
    const oldResets = asNumber(old?.["resets_at"]) ?? 0;
    const newer = old === undefined || resets > oldResets || (resets === oldResets && used >= (asNumber(old["used_percentage"]) ?? 0));

    if (newer) windows.set(window, { used_percentage: used, resets_at: resets, at: Math.trunc(nowS) });
  }

  if (!any) return;
  const kept = new Map<string, JsonOut>([[account.key, entryOf({ email: account.email, seen: Math.trunc(nowS), windows })]]);

  for (const [key, other] of held) {
    const live = [...other.windows.values()].some((r) => (asNumber(r["resets_at"]) ?? 0) > nowS);

    if (key !== account.key && live) kept.set(key, entryOf(other));
  }

  const text = `${dumps({ accounts: Object.fromEntries(kept) })}\n`;
  const path = readingPath(home);

  if (readText(path) === text) return;
  makeDirs(join(home, "usage"));
  const scratch = join(home, "usage", `reading.${pid}.tmp`);
  writeText(scratch, text);
  renameSync(scratch, path);
}

function entryOf(held: Held): JsonOut {
  const windows = [...WINDOWS.keys()].flatMap((w) => {
    const r = held.windows.get(w);

    return r === undefined ? [] : [[w, r] as const];
  });

  return { email: held.email, seen: held.seen, ...Object.fromEntries(windows) };
}

/** A number as Python's `%g` writes it: six significant digits, no trailing zeros. */
export function gFormat(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e6) return String(value);

  return String(Number(value.toPrecision(6)));
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The lines `usage show` prints, at `nowS`. */
export function usageLines(home: string, nowS: number): string[] {
  const held = readUsage(home);

  if (held === undefined) return ["no usage captured yet: the status line has not run through `fleet usage capture`"];
  const lines: string[] = [];

  for (const [i, r] of [held, ...(asArray(held["others"]) ?? [])].entries()) {
    const reading = asObject(r) ?? {};
    const name = asString(reading["account"]) ?? "an account not recorded";
    lines.push(i === 0 ? `${name}, the session that worked last:` : `${name}:`);

    for (const [window, label] of WINDOWS) {
      const w = asObject(reading[window]);

      if (w === undefined) continue;
      const resetsAt = asNumber(w["resets_at"]) ?? 0;
      const at = new Date(resetsAt * 1000);
      const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      const resets = resetsAt <= nowS ? "has reset since" : `resets ${DAYS[at.getDay()] ?? ""} ${hhmm}`;
      const used = gFormat(asNumber(w["used_percentage"]) ?? 0);
      lines.push(`  ${label}: ${used}% used, ${resets}, read ${Math.trunc(nowS - (asNumber(w["at"]) ?? 0))} s ago`);
    }
  }

  return lines;
}
