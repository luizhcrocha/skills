/**
 * What a ledger command says on stderr beside its work: live rows in a still fleet, a stale Now line, a
 * Now line naming a closed decision (in this ledger, or on a manager's in a fleet's), and a worker
 * recorded done whose report reads as unfinished. The chat's warning is the chat's ({@link ../chat/chat.ts}).
 */
import { join } from "node:path";

import { parseInstant } from "../clock.ts";
import { Refusal } from "../errors.ts";
import { readObject } from "../registry.ts";
import { secondsNow, type Machine } from "../world.ts";
import { copyLedger, decodeLedger, type Ledger } from "./model.ts";
import { findDecision, number } from "./numbers.ts";

/** The statuses of a worker row that is still at work. */
export const LIVE = ["running", "queued", "blocked"] as const;

/** A Now line not said again for this long is pointed out. */
export const NOW_STALE_S = 30 * 60;

/** Words a report uses when the work did not finish. */
export const UNFINISHED =
  /\b(refused|parked|not met|unmet|could(?:n't| not)|failed to|gave up|incomplete|unfinished|blocked on|waiting on|skipped|not done)\b/i;

/** Whether a worker status is live. */
export function isLive(status: string): boolean {
  return LIVE.some((live) => live === status);
}

/** The warning about worker rows still live while the fleet is paused or done. */
export function staleRows(ledger: Ledger): string | undefined {
  if (ledger.status !== "paused" && ledger.status !== "done") return undefined;
  const rows = ledger.agents.filter((a) => isLive(a.status)).map((a) => a.id);

  if (rows.length === 0) return undefined;

  return (
    `state: ${rows.join(", ")} still read as ${LIVE.join("/")} while the fleet is ${ledger.status}; ` +
    `if they are not working, \`state.py <dir> park "why"\` stops their rows in one command.`
  );
}

/** The warning about a Now line not said again for {@link NOW_STALE_S}. */
export function staleNow(machine: Machine, ledger: Ledger): string | undefined {
  const said = ledger.now_at;
  const at = said === undefined || said === null || said === "" ? undefined : parseInstant(said);
  const age = at === undefined ? undefined : secondsNow(machine) - at / 1000;

  if (age !== undefined && age < NOW_STALE_S) return undefined;
  const when = age === undefined ? "never stamped" : `said ${Math.floor(age / 60)} min ago`;
  const now = [...ledger.now].slice(0, 160).join("");

  return (
    `state: the page's Now line (${when}) reads: "${now}". If it is no longer what is ` +
    `happening, say it again: \`state.py <dir> set --now "..."\` (the same words also restamp it).`
  );
}

const REF = /\b([DAISGLR]\d+)\b/g;

/** The decisions a Now line names by number that are already closed: in this ledger ("A6"), and on a
 * manager's, in a fleet's ("infra I2", "infra-coordinator I2"). */
export function closedNamed(machine: Machine, ledger: Ledger, text: string): string[] {
  const own = copyLedger(ledger);
  number(own);
  const ledgers = new Map<string, Ledger | undefined>([["", own]]);

  if (ledger.role === "manager") {
    for (const e of machine.registry.live()) {
      if (e.role === "manager") continue;
      const raw = readObject(join(e.dir, "state.json"));
      const theirs = raw === undefined ? undefined : decodeLedger(raw);

      if (theirs === undefined || theirs instanceof Refusal) {
        ledgers.set(e.id, undefined);
        continue;
      }

      number(theirs);
      ledgers.set(e.id, theirs);
    }
  }

  const found: string[] = [];

  for (const m of text.matchAll(REF)) {
    const ref = m[1] ?? "";
    const before = text.slice(0, m.index).split(/\s+/).filter((w) => w !== "");
    const word = (before.at(-1) ?? "").toLowerCase().replace(/^[,:;(]+|[,:;(]+$/g, "");
    const fleet = [...ledgers.keys()].find((f) => f !== "" && (word === f || word === f.split("-")[0])) ?? "";
    const target = ledgers.get(fleet);
    const d = target === undefined ? undefined : findDecision(target, ref);

    if (d !== undefined && d.status !== "open") found.push(`${fleet === "" ? "" : `${fleet} `}${ref} (${d.title ?? "None"}) is ${d.status}`);
  }

  return found;
}
