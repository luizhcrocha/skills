/**
 * The machine's numbers: one counter per letter (D, A, I, S, G, N, P, L, R, K) in the registry,
 * `REGISTRY/numbers/numbers.json`, taken under `REGISTRY/numbers/numbers.lock`, so two fleets never give one
 * number (D29 names one item on the machine, whichever fleet holds it). A number taken is above the
 * counter and above the asking ledger's own highest. The counter is seeded once, when its file is missing
 * or unreadable, from the highest of each letter in every ledger the registry names (served, dead, kept, or
 * named on the page), so it starts above every old number; after that it is the source.
 *
 * A registry that exists, or that `$FLEET_HOME` names, and whose counter cannot be locked or written gives
 * no number: the write is refused, so no number repeats. Only a standalone fleet (no registry on this
 * machine) numbers from its own ledger, and is warned.
 */
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";

import { isDir, makeDirs, readText, resolvePath, strerror, writeAtomic } from "../files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseObject, type JsonObject } from "../json.ts";
import { withExclusiveLock } from "../lock.ts";
import { readObject, Registry, registryPlace } from "../registry.ts";
import type { Machine } from "../world.ts";
import type { Ledger } from "./model.ts";
import { highest, misnumbered, number, readsAsNumber, unnumbered, type NextNumber, type Numbered } from "./numbers.ts";

/** The registry exists but its counter could not be taken: why. The write is refused. */
export class Unreachable {
  readonly why: string;

  constructor(why: string) {
    this.why = why;
  }
}

/** No registry on this machine: a standalone fleet numbers from its own ledger. */
class Standalone {
  readonly why: string;

  constructor(why: string) {
    this.why = why;
  }
}

/** A new row's id reads as a number that is not the one it was given: the write is refused, nothing taken. */
export class Misnumbered {
  readonly why: string;

  constructor(why: string) {
    this.why = why;
  }
}

/** What a body of {@link withCounter} returns to leave the counter as it was: `value` without taking anything. */
class Unkept<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }
}

/** What a command that took numbers prints (on stderr), or why it is refused. */
export type Taken<T> = { readonly value: T; readonly warnings: readonly string[] } | Unreachable;

/** The counter's ways in: the next number of a letter above the asking ledger's highest, a number given by hand
 * that the counter must stay at or above, and the last number of a letter given, read without taking one. */
interface Counter {
  readonly next: NextNumber;
  readonly reserve: (prefix: string, n: number) => void;
  readonly current: (prefix: string) => number;
}

/** The highest number of each letter among the rows of `state` (a ledger as JSON), into `into`. */
function highestIn(state: JsonObject, into: Map<string, number>): void {
  const rows = (key: string): JsonObject[] =>
    (asArray(state[key]) ?? []).flatMap((r) => {
      const row = asObject(r);

      return row === undefined ? [] : [row];
    });

  const refs = [...["decisions", "links", "roadblocks"].flatMap((key) => rows(key).map((r) => asString(r["ref"]))), ...rows("approvals").map((a) => asString(a["id"]))];

  for (const ref of refs) {
    const m = ref === undefined ? null : /^([A-Z])(\d+)$/u.exec(ref);
    const letter = m?.[1];

    if (letter !== undefined) into.set(letter, Math.max(into.get(letter) ?? 0, Number(m?.[2])));
  }
}

/** The highest number of each letter in the ledgers of every fleet `registry` names: the counter's seed. */
function highestKnown(registry: Registry): Map<string, number> {
  const found = new Map<string, number>();

  for (const dir of registry.ledgerDirs()) {
    const state = readObject(join(dir, "state.json"));

    if (state !== undefined) highestIn(state, found);
  }

  return found;
}

/** The counter as stored, or undefined when it must be seeded (no file, or not a JSON object). */
function stored(path: string): Map<string, number> | undefined {
  const text = readText(path);
  const object = text === undefined ? undefined : Option.getOrUndefined(parseObject(text));

  if (object === undefined) return undefined;
  const counters = new Map<string, number>();

  for (const [letter, value] of Object.entries(object)) {
    const n = asNumber(value);

    if (n !== undefined && Number.isInteger(n)) counters.set(letter, n);
  }

  return counters;
}

/** Run `body` with the machine's counter, under its lock, and keep what it took, unless it returns {@link Unkept}. */
function withCounter<T>(registry: Registry, body: (counter: Counter) => T | Unkept<T>): T | Unreachable | Standalone {
  const home = registry.place.home;

  if (registry.place.named !== true && !isDir(home)) return new Standalone(`no fleet registry at ${home}`);
  const dir = join(home, "numbers");
  const path = join(dir, "numbers.json");
  const lock = join(dir, "numbers.lock");
  let fd: number;

  try {
    makeDirs(dir);
    fd = openSync(lock, "a+");
  } catch (e) {
    return new Unreachable(`cannot open the number counter's lock ${lock}: ${strerror(e)}`);
  }

  try {
    return withExclusiveLock(fd, () => {
      const kept = stored(path);
      const counters = kept ?? highestKnown(registry);
      let changed = kept === undefined;

      const next: NextNumber = (prefix, above) => {
        const n = Math.max(counters.get(prefix) ?? 0, above) + 1;
        counters.set(prefix, n);
        changed = true;

        return n;
      };

      const reserve = (prefix: string, n: number): void => {
        if ((counters.get(prefix) ?? 0) >= n) return;
        counters.set(prefix, n);
        changed = true;
      };

      const result = body({ next, reserve, current: (prefix) => counters.get(prefix) ?? 0 });

      if (result instanceof Unkept) return result.value;

      if (!changed) return result;

      try {
        writeAtomic(path, `${dumps(Object.fromEntries(counters), { indent: 2 })}\n`);
      } catch (e) {
        return new Unreachable(`cannot write the number counter ${path}: ${strerror(e)}`);
      }

      return result;
    });
  } catch (e) {
    return new Unreachable(`cannot lock the number counter ${lock}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    closeSync(fd);
  }
}

/** What a standalone fleet is told when it numbers from its own ledger. */
function alone(why: Standalone): string {
  return `state: ${why.why}: numbered from this ledger alone, so a number may repeat another standalone fleet's.`;
}

/** What a fleet is told when it numbers from one registry while it is registered in the usual one
 * (`$FLEET_HOME` or `$XDG_STATE_HOME` set for one and not the other); undefined when it is not so. */
function elsewhere(machine: Machine, root: string): string | undefined {
  const used = machine.registry.place.home;
  const usual = registryPlace((name) => (name === "FLEET_HOME" || name === "XDG_STATE_HOME" ? undefined : machine.env(name)), machine.config).home;

  if (resolvePath(used) === resolvePath(usual) || !isDir(usual)) return undefined;
  const here = resolvePath(root);
  const servedThere = new Registry({ home: usual, config: machine.config }).ledgerDirs().some((d) => resolvePath(d) === here);

  if (!servedThere || machine.registry.ledgerDirs().some((d) => resolvePath(d) === here)) return undefined;

  return (
    `state: this fleet is served from the registry at ${usual} but numbers from ${used} ($FLEET_HOME or $XDG_STATE_HOME): ` +
    `its numbers may repeat those of the other fleets registered at ${usual}. Unset them, or point them at ${usual}.`
  );
}

/** Number every row of `ledger` (the fleet at `root`) that has none, from the machine's counter; a standalone
 * fleet from its own ledger, warned. {@link Unreachable} when the registry's counter cannot be taken, and
 * {@link Misnumbered} when a new row (its id not in `kept`, the ids the ledger held before the command) has an
 * id that reads as a number other than the one it is given, checked where the number is taken, so a number
 * another fleet took since the command looked is caught: either way the rows are left without a number, the
 * counter as it was, and the caller refuses the write. */
export function numberOnMachine(machine: Machine, root: string, ledger: Ledger, kept: ReadonlySet<string>): Taken<undefined> | Misnumbered {
  if (!unnumbered(ledger)) return { value: undefined, warnings: [] };
  let given: Numbered[] = [];

  const wrong = (rows: readonly Numbered[]): Misnumbered | undefined => {
    const row = rows.find((r) => !kept.has(r.id) && readsAsNumber(r.id) && r.ref !== r.id);

    return row === undefined ? undefined : new Misnumbered(misnumbered(row.id, row.ref ?? ""));
  };

  const took = withCounter(machine.registry, ({ next }): Misnumbered | undefined | Unkept<Misnumbered | undefined> => {
    given = number(ledger, next);
    const refused = wrong(given);

    return refused === undefined ? undefined : new Unkept(refused);
  });

  if (took instanceof Standalone) {
    given = number(ledger);
    const refused = wrong(given);

    if (refused === undefined) return { value: undefined, warnings: [alone(took)] };

    for (const row of given) delete row.ref;

    return refused;
  }

  if (took instanceof Unreachable || took instanceof Misnumbered) {
    for (const row of given) delete row.ref;

    return took;
  }

  const warning = elsewhere(machine, root);

  return { value: undefined, warnings: warning === undefined ? [] : [warning] };
}

/** The number a new decision of letter `prefix` would be given on this write, read from
 * the machine's counter without taking it; a standalone fleet's from its own ledger. {@link Unreachable}
 * when the registry's counter cannot be read. */
export function nextDecisionRef(machine: Machine, ledger: Ledger, prefix: string): string | Unreachable {
  const rows = ledger.decisions ?? [];
  const local = highest(rows.map((r) => r.ref), prefix);
  const ids = new Set(rows.map((r) => r.id));

  const after = (counted: number): string => {
    let n = Math.max(counted, local) + 1;

    while (ids.has(`${prefix}${String(n)}`)) n += 1;

    return `${prefix}${String(n)}`;
  };

  const peeked = withCounter(machine.registry, ({ current }) => new Unkept(current(prefix)));

  if (peeked instanceof Standalone) return after(0);

  if (peeked instanceof Unreachable) return peeked;

  return after(peeked);
}

/** An approval's K: for `next`, the machine's next above `above` (the ledger's highest); else `given` (K and a
 * number) as it is, with the counter raised to it, so the counter never gives it again. */
export function approvalNumber(machine: Machine, root: string, given: string, above: number): Taken<number> {
  const asked = given === "next" ? undefined : Number(given.slice(1));

  const took = withCounter(machine.registry, ({ next, reserve }) => {
    if (asked === undefined) return next("K", above);
    reserve("K", asked);

    return asked;
  });

  if (took instanceof Standalone) return { value: asked ?? above + 1, warnings: asked === undefined ? [alone(took)] : [] };

  if (took instanceof Unreachable) return took;
  const warning = elsewhere(machine, root);

  return { value: took, warnings: warning === undefined ? [] : [warning] };
}

/** Why a write that needed numbers is refused when the registry's counter could not be taken. */
export function refusedFor(why: Unreachable): string {
  return `${why.why}: nothing was written, so no number repeats another fleet's. fix the registry's numbers/ directory (its permissions, the disk) and run the command again`;
}
