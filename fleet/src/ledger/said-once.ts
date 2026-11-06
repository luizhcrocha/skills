/**
 * The informational warnings a state command prints once: a line that leaves nothing wrong when it goes unheeded
 * (unread news, a stale Now line, idle workspaces) is said once per distinct mark, again when its mark changes or
 * {@link againS} after it was last said. A warning that asks for an act passes through: it repeats until the act
 * happens. What was said, and when, is `DIR/state-warnings.told`, `{kind: {mark, at}}`.
 */
import { join } from "node:path";

import { parseInstant, stampOf } from "../clock.ts";
import { exists, writeText } from "../files.ts";
import { asObject, asString, type Json } from "../json.ts";
import { readObject } from "../registry.ts";
import { secondsNow, type Machine } from "../world.ts";

/** The file under a fleet's DIR that keeps what was said. */
export const SAID_ONCE_FILE = "state-warnings.told";

/** How long, by default, an informational warning stays unsaid when nothing in it changed. */
export const SAID_AGAIN_S = 30 * 60;

/** A warning: its `text`; an informational one also its `kind` (one per source) and the `mark` that tells a new one
 * from the last (the text unless a part of it moves with the clock alone, as a Now line's age does). With no `kind`
 * it asks for an act and is said every time. */
export interface Warning {
  readonly text: string;
  readonly kind?: string;
  readonly mark?: string;
}

/** A warning that asks for an act: said on every command. */
export function acting(text: string | undefined): Warning | undefined {
  return text === undefined ? undefined : { text };
}

/** An informational warning of `kind`: said once per `mark` (its text by default). */
export function informing(kind: string, text: string | undefined, mark?: string): Warning | undefined {
  if (text === undefined) return undefined;

  return mark === undefined ? { kind, text } : { kind, text, mark };
}

/** $FLEET_WARN_AGAIN_S, else {@link SAID_AGAIN_S}; 0 or less says every warning on every command and keeps no file
 * (the oracle's replays). */
export function againS(env: (name: string) => string | undefined): number {
  const text = env("FLEET_WARN_AGAIN_S")?.trim();
  const given = text === undefined || text === "" ? Number.NaN : Number(text);

  return Number.isFinite(given) ? given : SAID_AGAIN_S;
}

/** Of `warnings`, the texts to print now, in their order: every acting one, and each informational one not said
 * with its mark within {@link againS}. What is printed is kept in DIR's file, and a kind not among `warnings` is
 * forgotten, so the same line coming back later is said again. */
export function sayOnce(machine: Machine, root: string, warnings: readonly (Warning | undefined)[]): string[] {
  const given = warnings.filter((w) => w !== undefined);
  const after = againS(machine.env);

  if (after <= 0 || (given.every((w) => w.kind === undefined) && !exists(join(root, SAID_ONCE_FILE)))) return given.map((w) => w.text);
  const path = join(root, SAID_ONCE_FILE);
  const before = readObject(path) ?? {};
  const now = secondsNow(machine);
  const kept = new Map<string, Json>();
  const say: string[] = [];

  for (const w of given) {
    if (w.kind === undefined) {
      say.push(w.text);
      continue;
    }

    const mark = w.mark ?? w.text;
    const last = asObject(before[w.kind]);
    const at = parseInstant(asString(last?.["at"]) ?? "");
    const fresh = last !== undefined && asString(last["mark"]) === mark && at !== undefined && now - at / 1000 < after;

    if (fresh) {
      kept.set(w.kind, last);
      continue;
    }

    say.push(w.text);
    kept.set(w.kind, { mark, at: stampOf(machine.now()) });
  }

  const text = JSON.stringify(Object.fromEntries(kept));

  if (text !== JSON.stringify(before)) writeText(path, `${text}\n`);

  return say;
}
