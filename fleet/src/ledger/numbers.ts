/**
 * Numbers (refs) and lookups. Every decision, link and roadblock gets a number once, on the write
 * after it is recorded: a letter for its kind and 1 + the highest number of that letter, skipping a
 * number another row of the list has as its id (open-1). A lookup takes an id first, then a number.
 */
import { byInstant } from "../clock.ts";
import type { Decision, Ledger, Milestone } from "./model.ts";

/** The letter of each decision kind's number (an unknown kind numbers as a decision). */
export const PREFIX = new Map([
  ["decision", "D"],
  ["action", "A"],
  ["input", "I"],
  ["secret", "S"],
  ["grill", "G"],
]);

/** A row with an id and maybe a number. */
interface Numbered {
  readonly id: string;
  ref?: string;
}

/** The row whose id is `key`, else the one whose number is `key`. */
export function find<T extends { readonly id: string; readonly ref?: string | undefined }>(
  rows: readonly T[] | undefined,
  key: string,
): T | undefined {
  return rows?.find((r) => r.id === key) ?? rows?.find((r) => r.ref !== undefined && r.ref !== "" && r.ref === key);
}

/** The decision `key` names (an id, else a number). */
export function findDecision(ledger: Ledger, key: string): Decision | undefined {
  return find(ledger.decisions, key);
}

function nextRef(rows: readonly Numbered[], prefix: string, row: Numbered): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let n = 1;

  for (const r of rows) {
    const m = pattern.exec(r.ref ?? "");

    if (m !== null) n = Math.max(n, Number(m[1]) + 1);
  }

  const ids = new Set(rows.flatMap((r) => (r === row ? [] : [r.id])));

  while (ids.has(`${prefix}${n}`)) n += 1;

  return `${prefix}${n}`;
}

/** Give each decision, link and roadblock without a number its number (decisions in `opened` order, as
 * instants, open-13; links and roadblocks in list order). */
export function number(ledger: Ledger): void {
  const decisions = ledger.decisions ?? [];
  const waiting = decisions.filter((d) => d.ref === undefined || d.ref === "");
  const byOpened = [...waiting].sort((a, b) => byInstant(a.opened, b.opened));

  for (const d of byOpened) d.ref = nextRef(decisions, PREFIX.get(d.kind) ?? "D", d);

  for (const [rows, prefix] of [
    [ledger.links ?? [], "L"],
    [ledger.roadblocks, "R"],
  ] as const) {
    for (const r of rows) {
      if (r.ref === undefined || r.ref === "") r.ref = nextRef(rows, prefix, r);
    }
  }
}

/** The milestone that holds step `id`. */
export function milestoneOfStep(ledger: Ledger, id: string): Milestone | undefined {
  return ledger.roadmap.find((m) => find(m.steps, id) !== undefined);
}

/** The next free step id for `milestone` (`step next`): the letters of its last step whose id is letters
 * then digits (else the milestone's first letter, lower-cased, else `s`), and 1 + the highest number any
 * step of the ledger with those letters has. */
export function nextStepId(ledger: Ledger, milestone: string): string {
  const m = find(ledger.roadmap, milestone);

  const letters = (m?.steps ?? []).flatMap((s) => {
    const found = /^([A-Za-z]+)\d+$/.exec(s.id);

    return found?.[1] === undefined ? [] : [found[1]];
  });

  const first = /^[A-Za-z]/.exec(milestone)?.[0].toLowerCase();
  const prefix = letters.at(-1) ?? (first === undefined || first === "" ? "s" : first);
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let n = 0;

  for (const mm of ledger.roadmap) {
    for (const s of mm.steps) {
      const found = pattern.exec(s.id);

      if (found !== null) n = Math.max(n, Number(found[1]));
    }
  }

  return `${prefix}${n + 1}`;
}
