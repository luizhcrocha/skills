/**
 * Numbers, durations and moments in the page's words: "182k", "21 min", "5 min ago", a clock time today
 * and a day and time otherwise.
 */
import type { Spent } from "./core.ts";

const INT = new Intl.NumberFormat("en-US");

const CLOCK = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });

const DAY_CLOCK = new Intl.DateTimeFormat([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const FULL = new Intl.DateTimeFormat([], { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

const DAY = new Intl.DateTimeFormat([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** A whole number with thousands separators. */
export const fmtInt = (n: number | null | undefined): string => INT.format(Number(n || 0));

/** A count in three figures: 1.2B, 3.4M, 182k. */
export const fmtShort = (n: number): string => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? String(Math.round(n / 1e3)) + "k" : String(n));

/** What a session itself spent, in words: what it wrote, what it read, how much of that came from the cache. */
export const spentWords = (s: Spent): string =>
  `${fmtShort(s.output)} written, ${fmtShort(s.input)} read${s.input ? ` (${Math.round((100 * s.cached) / s.input)}% from the cache)` : ""}, in ${fmtInt(s.answers)} answers`;

/** A duration: "45 s", "21 min", "2 h 5 min"; empty for none. */
export function fmtDur(ms: number | null | undefined): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);

  if (s < 60) return String(s) + " s";
  const m = Math.floor(s / 60);

  if (m < 60) return String(m) + " min";
  const h = Math.floor(m / 60);

  return String(h) + " h " + String(m % 60) + " min";
}

/** How long ago `iso` was at `now`: "just now", "5 min ago"; empty when it is not a moment. */
export function agoAt(iso: string | null | undefined, now: number): string {
  const t = Date.parse(String(iso ?? ""));

  if (isNaN(t)) return "";
  const d = Math.max(0, now - t);

  return d < 60e3 ? "just now" : fmtDur(d) + " ago";
}

/** A moment as a clock time when it is today, with its day when it is not. */
export function clock(iso: string | null | undefined): string {
  const t = new Date(String(iso ?? ""));

  if (isNaN(t.getTime())) return "";

  return t.toDateString() === new Date().toDateString() ? CLOCK.format(t) : DAY_CLOCK.format(t);
}

/** A moment in full, for a tooltip. */
export function fullTime(iso: string | null | undefined): string {
  const t = new Date(String(iso ?? ""));

  return isNaN(t.getTime()) ? "" : FULL.format(t);
}

/** A moment as a weekday and a time. */
export const dayTime = (ms: number): string => DAY.format(new Date(ms));

/** "1 message", "3 messages". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
