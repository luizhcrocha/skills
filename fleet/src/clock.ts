/**
 * The fleet's one clock, as `scripts/clock.py`: `FLEET_NOW` (an ISO 8601 instant with its offset) stops it
 * there, unset it is the machine's. Every stamp and every age measured against a stamp or a file time
 * reads the time through this service. Timers that only pace a loop stay real.
 */
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/** The instant now, as the fleet reads it. */
export class Clock extends Context.Service<Clock, { readonly now: () => Date }>()("fleet/Clock") {}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/;

/** The instant an ISO 8601 text names, in ms since the epoch, as Python's `datetime.fromisoformat` reads it
 * (a text without an offset is read as UTC); undefined when it does not parse. */
export function parseInstant(text: string): number | undefined {
  const m = ISO.exec(text.trim());

  if (m === null) return undefined;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", zone] = m;
  const ms = Number((frac + "000").slice(0, 3));
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);

  if (Number.isNaN(base)) return undefined;

  if (zone === undefined || zone === "Z") return base;
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(/:/g, "");
  const offset = Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4) || "0") * 60 + Number(digits.slice(4, 6) || "0");

  return base - sign * offset * 1000;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** An instant as the ledger writes it: local time (TZ) with its offset, to the second
 * (`2026-01-05T09:00:00+00:00`), as `clock.stamp()` does. */
export function stampOf(at: Date): string {
  const offsetMin = -at.getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);

  return (
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}` +
    `T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`
  );
}

/** The clock `FLEET_NOW` names, else the machine's. A `FLEET_NOW` that does not parse stops nothing. */
export function clockFrom(fixed: string | undefined): Layer.Layer<Clock> {
  const at = fixed === undefined || fixed === "" ? undefined : parseInstant(fixed);

  return Layer.succeed(Clock, { now: () => (at === undefined ? new Date() : new Date(at)) });
}

/** Whether stamp `a` is at or after stamp `b`, as instants; as strings when either does not parse (open-13:
 * two offsets, a DST change or a moved machine, misorder the strings). */
export function atOrAfter(a: string, b: string): boolean {
  const x = parseInstant(a);
  const y = parseInstant(b);

  return x !== undefined && y !== undefined ? x >= y : a >= b;
}

/** Stamps in time order, those that do not parse after them, as strings (Python's `clock.order`). */
export function byInstant(a: string, b: string): number {
  const x = parseInstant(a);
  const y = parseInstant(b);

  if (x !== undefined && y !== undefined) return x - y;

  if (x !== undefined) return -1;

  if (y !== undefined) return 1;

  return a < b ? -1 : a > b ? 1 : 0;
}
