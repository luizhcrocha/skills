/**
 * A decision's history as its page replays it: what the ledger logged about it (asked, changed, passed on,
 * held, decided, withdrawn; a grilling's rounds) and the answers given on the page, newest first, each as a
 * word for what happened and the text that says what.
 */
import type { Decision, FleetEvent, Message } from "./core.ts";

/** One moment of a decision's history. */
export interface HistoryEntry {
  readonly at: string;
  /** What happened, in a word or two: Asked, Changed, Answered, Held by the fleet, Decided. */
  readonly what: string;
  /** What it said: the change, the answer, the reason. */
  readonly text: string;
  /** Where it is from: the ledger's event, or the chat's answer. */
  readonly source: "event" | "answer";
  /** Its key on the page: its source and place there. */
  readonly key: string;
}

/** `text` after `head` when it starts with it, else null. */
function after(text: string, head: string): string | null {
  return text.startsWith(head) ? text.slice(head.length) : null;
}

/** An event about the decision titled `title`, as an entry; the title the CLI prefixes is taken off. */
function fromEvent(e: FleetEvent, title: string, n: number): HistoryEntry {
  const at = e.at;
  const t = e.text;
  const entry = (what: string, text: string): HistoryEntry => ({ at, what, text, source: "event", key: "e" + String(n) });

  /* The title may have changed since the event: when it is not the prefix, the CLI's own separators say where it ends. */
  const titled = after(t, title + ": ") !== null;
  const cut = (sep: string): string | null => after(t, title + sep) ?? (!titled && t.includes(sep) ? t.slice(t.indexOf(sep) + sep.length) : null);

  if (e.kind === "asked") {
    const manager = after(t, "For the manager: ");

    if (manager !== null) return entry("Asked the manager", after(manager, title + ": ") ?? manager);
    const passed = cut(" now asks you: ");

    if (passed !== null) return entry("Passed to you", passed);
    const changed = cut(" changed: ");

    /* A revision with no --log says only the fields it was given. */
    if (changed !== null) return entry("Changed", /^[a-z_]+(?:, [a-z_]+)*$/u.test(changed) ? `no note; fields given: ${changed}` : changed);

    return entry("Asked", after(t, title + ": ") ?? t);
  }

  if (e.kind === "note") {
    const held = cut(" held by the fleet: ");

    if (held !== null) return entry("Held by the fleet", held);

    if (t.endsWith(" no longer held by the fleet")) return entry("Back with you", "no longer held by the fleet");

    return entry("Note", t);
  }

  if (e.kind === "decision") return entry("Decided", after(t, title + ": ") ?? t);

  if (e.kind === "resolved") {
    const withdrawn = cut(" withdrawn: ");

    return withdrawn === null ? entry("Resolved", t) : entry("Withdrawn", withdrawn);
  }

  return entry(e.kind.charAt(0).toUpperCase() + e.kind.slice(1), t);
}

/** Decision `d`'s history from the fleet's events and the chat, newest first. */
export function historyOf(d: Decision, events: readonly FleetEvent[], messages: readonly Message[]): HistoryEntry[] {
  const grill = d.kind === "grill";
  const out: HistoryEntry[] = events.flatMap((e, n) => (e.decision === d.id ? [fromEvent(e, d.title, n)] : []));

  for (const m of messages) {
    if (m.from === "user" && m.decision === d.id) out.push({ at: m.at, what: grill ? "You answered a round" : "You answered", text: m.text, source: "answer", key: "m" + String(m.id) });
  }

  return out
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => (b.t || 0) - (a.t || 0) || b.i - a.i)
    .map((x) => x.e);
}

/** Whether an entry's text fits one line without being cut: short, and no line break. */
export function fitsOneLine(text: string): boolean {
  return [...text].length <= 90 && !text.includes("\n");
}
