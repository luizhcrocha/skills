/**
 * Numbers (refs) and lookups. Every decision, link and roadblock gets a number once, on the write
 * after it is recorded: a letter for its kind and a number above the highest of that letter, skipping a
 * number another row of the list has as its id (open-1). On a write, the machine's fleets share one
 * counter per letter (`shared-numbers.ts`), so a number names one item on the machine; a copy numbered
 * for reading, or a standalone fleet (no registry on the machine), takes 1 + the highest of this ledger. A lookup takes
 * an id first, then a number.
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
  ["notice", "N"],
  ["permission", "P"],
  ["rule", "D"],
]);

/** Whether `id` reads as an item number (a counter's letter and digits, as D217 or K3): a page links it as
 * one, so a new row may take it only as its own number. */
export function readsAsNumber(id: string): boolean {
  return /^[DAISGNPLRK][0-9]+$/u.test(id);
}

/** Why a new row under `id`, which reads as a number, is refused: its number is `ref`. */
export function misnumbered(id: string, ref: string): string {
  return `${id} reads as a card number, and this card's number will be ${ref}: use a word id (s3-tool), or ${ref}`;
}

/** The ids of the rows a write numbers (decisions, links, roadblocks): those a ledger held before a command keep
 * their id, whatever it reads as. */
export function numberedIds(ledger: Ledger): Set<string> {
  return new Set([...(ledger.decisions ?? []), ...(ledger.links ?? []), ...ledger.roadblocks].map((r) => r.id));
}

/** A row with an id and maybe a number. */
export interface Numbered {
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

/** The next number of letter `prefix` above `above`, from the machine's shared counter. */
export type NextNumber = (prefix: string, above: number) => number;

/** The highest number of letter `prefix` among `refs`, 0 when none has one. */
export function highest(refs: readonly (string | undefined)[], prefix: string): number {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let n = 0;

  for (const ref of refs) {
    const m = pattern.exec(ref ?? "");

    if (m !== null) n = Math.max(n, Number(m[1]));
  }

  return n;
}

function nextRef(rows: readonly Numbered[], prefix: string, row: Numbered, next: NextNumber | undefined): string {
  const local = highest(rows.map((r) => r.ref), prefix);
  const take = (above: number): number => (next === undefined ? above + 1 : next(prefix, above));
  const ids = new Set(rows.flatMap((r) => (r === row ? [] : [r.id])));
  let n = take(local);

  while (ids.has(`${prefix}${n}`)) n = take(n);

  return `${prefix}${n}`;
}

/** Whether a row of `ledger` waits for its number. */
export function unnumbered(ledger: Ledger): boolean {
  return [...(ledger.decisions ?? []), ...(ledger.links ?? []), ...ledger.roadblocks].some((r) => r.ref === undefined || r.ref === "");
}

/** Give each decision, link and roadblock without a number its number (decisions in `opened` order, as
 * instants, open-13; links and roadblocks in list order), from `next` when given, else from this ledger
 * alone. The rows numbered. */
export function number(ledger: Ledger, next?: NextNumber): Numbered[] {
  const decisions = ledger.decisions ?? [];
  const waiting = decisions.filter((d) => d.ref === undefined || d.ref === "");
  const byOpened = [...waiting].sort((a, b) => byInstant(a.opened, b.opened));
  const given: Numbered[] = [];

  for (const d of byOpened) {
    d.ref = nextRef(decisions, PREFIX.get(d.kind) ?? "D", d, next);
    given.push(d);
  }

  for (const [rows, prefix] of [
    [ledger.links ?? [], "L"],
    [ledger.roadblocks, "R"],
  ] as const) {
    for (const r of rows) {
      if (r.ref === undefined || r.ref === "") {
        r.ref = nextRef(rows, prefix, r, next);
        given.push(r);
      }
    }
  }

  return given;
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
