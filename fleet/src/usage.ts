/**
 * The plan's usage (Python's `usage.py`), captured from what Claude Code hands a status line: its
 * `rate_limits` (the 5-hour and 7-day windows, each `used_percentage` and `resets_at`) are kept in
 * `REGISTRY/usage/reading.json` and the manager's page is sent them. Within a window usage only grows,
 * so an idle session's older figure never replaces a newer one; a window that resets later is a new one.
 */
import { renameSync } from "node:fs";
import { join } from "node:path";

import { readObject } from "./registry.ts";
import { makeDirs, writeText } from "./files.ts";
import { asBoolean, asNumber, asObject, dumps, type Json, type JsonObject } from "./json.ts";

/** The windows a reading holds, and how the CLI names them. */
export const WINDOWS = new Map([
  ["five_hour", "5-hour window"],
  ["seven_day", "7-day window"],
]);

function readingPath(home: string): string {
  return join(home, "usage", "reading.json");
}

function isReading(value: Json | undefined): value is JsonObject {
  const object = asObject(value);
  const number = (v: Json | undefined): boolean => asNumber(v) !== undefined && asBoolean(v) === undefined;

  return object !== undefined && number(object["used_percentage"]) && number(object["resets_at"]);
}

/** What is held, `{window: {used_percentage, resets_at, at}}` in the file's order, or undefined. */
export function readUsage(home: string): JsonObject | undefined {
  const held = readObject(readingPath(home));

  if (held === undefined) return undefined;
  const windows: JsonObject = Object.fromEntries(Object.entries(held).filter(([key, value]) => WINDOWS.has(key) && isReading(value)));

  return Object.keys(windows).length > 0 ? windows : undefined;
}

/** Fold a status line's `rate_limits` into what is held, at `nowS` (seconds since the epoch). */
export function keepUsage(home: string, limits: Json | undefined, nowS: number, pid: number): void {
  const given = asObject(limits);

  if (given === undefined) return;
  const held = new Map<string, Json>(Object.entries(readUsage(home) ?? {}));
  let changed = false;

  for (const window of WINDOWS.keys()) {
    const next = given[window];

    if (!isReading(next)) continue;
    const old = asObject(held.get(window));
    const resets = asNumber(next["resets_at"]) ?? 0;
    const used = asNumber(next["used_percentage"]) ?? 0;
    const oldResets = asNumber(old?.["resets_at"]) ?? 0;
    const newer = old === undefined || resets > oldResets || (resets === oldResets && used >= (asNumber(old["used_percentage"]) ?? 0));

    if (newer) {
      held.set(window, { used_percentage: used, resets_at: resets, at: Math.trunc(nowS) });
      changed = true;
    }
  }

  if (!changed) return;
  const path = readingPath(home);
  makeDirs(join(home, "usage"));
  const scratch = join(home, "usage", `reading.${pid}.tmp`);
  writeText(scratch, `${dumps(Object.fromEntries(held))}\n`);
  renameSync(scratch, path);
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

  for (const [window, label] of WINDOWS) {
    const r = asObject(held[window]);

    if (r === undefined) continue;
    const resetsAt = asNumber(r["resets_at"]) ?? 0;
    const at = new Date(resetsAt * 1000);
    const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const resets = resetsAt <= nowS ? "has reset since" : `resets ${DAYS[at.getDay()] ?? ""} ${hhmm}`;
    const used = gFormat(asNumber(r["used_percentage"]) ?? 0);
    lines.push(`${label}: ${used}% used, ${resets}, read ${Math.trunc(nowS - (asNumber(r["at"]) ?? 0))} s ago`);
  }

  return lines;
}
