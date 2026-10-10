/**
 * The follow-through on a batch of marks: a batch stays open on the host's watch until every mark is
 * answered. A mark that asks for a change (`delete`, `replace`, `comment`, `general`) counts as answered only
 * when an answer names it (`--mark`) and the decision was revised after the batch, or that answer says why
 * not (`--no-change`, stored as `keep`); a `question` counts as answered by any answer that names it; a mark
 * a later batch on the same decision withdraws (`withdrawn`) is closed. The
 * watch reminds the host of each open batch every FLEET_BATCH_REMIND_S, at most once per period.
 */
import { parseInstant } from "../clock.ts";
import { asArray, asNumber, asObject, asString, truthy, type Json, type JsonObject } from "../json.ts";
import { secondsNow, type Machine } from "../world.ts";
import { hostOf, isBatch, markNumbers, oneLine, pyText, stateOfDir, withdrawnNumbers } from "./chat.ts";
import { readChat, type Message } from "./store.ts";

/** How often the host's watch reminds it of a batch still open (FLEET_BATCH_REMIND_S). */
export const BATCH_REMIND_S = 30 * 60;

/** A batch of marks some of which are not closed yet. */
export interface OpenBatch {
  readonly batch: Message;
  readonly marked: Marked;
  /** The decision as the ledger has it now, when it does. */
  readonly decision: JsonObject | undefined;
  /** Marks no answer names. */
  readonly unanswered: readonly number[];
  /** Marks that ask for a change, answered with neither a revision of the decision since the batch nor a reason. */
  readonly unrevised: readonly number[];
}

/** What the follow-through reads of a batch's `marks`: its decision as the page had it, and each mark's kind. */
interface Marked {
  readonly id: string | undefined;
  readonly ref: string | undefined;
  readonly title: string | undefined;
  readonly revision: string | undefined;
  readonly kinds: ReadonlyMap<number, string>;
  /** The marks that reply in an earlier mark's thread (a `general` with `on`): conversation, closed by any answer. */
  readonly replies: ReadonlySet<number>;
}

/** The `marks` of a stored batch, parsed once (`marksOf` checked them when they were stored). */
function markedOf(batch: Message): Marked {
  const marks = asObject(batch.stored["marks"]);
  const decision = asObject(marks?.["decision"]);

  const kinds = new Map(
    (asArray(marks?.["items"]) ?? []).flatMap((item) => {
      const n = asNumber(asObject(item)?.["n"]);

      return n === undefined ? [] : [[n, asString(asObject(item)?.["kind"]) ?? ""] as const];
    }),
  );

  const replies = new Set(
    (asArray(marks?.["items"]) ?? []).flatMap((item) => {
      const n = asNumber(asObject(item)?.["n"]);

      return n === undefined || asNumber(asObject(item)?.["on"]) === undefined ? [] : [n];
    }),
  );

  return { id: asString(decision?.["id"]), ref: asString(decision?.["ref"]), title: asString(decision?.["title"]), revision: asString(decision?.["revision"]), kinds, replies };
}

/** Whether `decision` was revised since `batch`: its `revised` later than the batch's time, or its revision
 * (`revised`, else `opened`) another than the one the batch marked. */
function revisedSince(decision: JsonObject | undefined, batch: Message, marked: Marked): boolean {
  if (decision === undefined) return false;
  const revised = truthy(decision["revised"]) ? pyText(decision["revised"]) : undefined;
  const now = revised ?? (truthy(decision["opened"]) ? pyText(decision["opened"]) : undefined);
  const after = revised === undefined ? undefined : parseInstant(revised);
  const sent = parseInstant(pyText(batch.at));

  return (after !== undefined && sent !== undefined && after > sent) || (now !== undefined && marked.revision !== undefined && now !== marked.revision);
}

/** The batches of the user's to `host` with a mark not yet closed, oldest first. */
export function openBatches(messages: readonly Message[], decisions: readonly Json[], host: string): OpenBatch[] {
  const rows = decisions.flatMap((d) => {
    const row = asObject(d);

    return row === undefined ? [] : [row];
  });

  const received = messages.filter((m) => m.from === "user" && m.to.includes(host) && isBatch(m));

  return received.flatMap((batch) => {
    const numbers = markNumbers(batch);

    if (numbers.length === 0) return [];
    const marked = markedOf(batch);
    // A later batch on the same decision may withdraw a mark: it is closed, whatever was answered.
    const withdrawn = new Set(received.filter((later) => later.id > batch.id && markedOf(later).id === marked.id).flatMap(withdrawnNumbers));
    const decision = rows.find((d) => d["id"] === marked.id);
    // A decision no longer open (or gone) can no longer be revised: any answer naming a mark closes it.
    const settled = decision === undefined || (decision["status"] ?? "open") !== "open";
    const revised = settled || revisedSince(decision, batch, marked);
    const answers = messages.filter((m) => m.from !== "user" && m.re === batch.id);
    const unanswered: number[] = [];
    const unrevised: number[] = [];

    for (const n of numbers.filter((k) => !withdrawn.has(k))) {
      const naming = answers.filter((m) => (asArray(m.stored["mark"]) ?? []).includes(n));

      if (naming.length === 0) unanswered.push(n);
      else if (marked.kinds.get(n) !== "question" && !marked.replies.has(n) && !revised && !naming.some((m) => asString(m.stored["keep"]) !== undefined)) unrevised.push(n);
    }

    return unanswered.length === 0 && unrevised.length === 0 ? [] : [{ batch, marked, decision, unanswered, unrevised }];
  });
}

/** Which period of `remindS` seconds since the batch `now` falls in (0 for the first, which is not told). */
export function remindPeriod(sentS: number, nowS: number, remindS: number): number {
  return remindS <= 0 ? 0 : Math.floor((nowS - sentS) / remindS);
}

/** `mark 2` or `marks 1, 3`. */
function listed(word: string, numbers: readonly number[]): string {
  return `${word}${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}`;
}

/** The `!` reminder of each batch to the host of `root` still open a whole period after it came, told once per
 * period (`batch:<id>` in `told`, the period last told). */
export function batchReminders(machine: Machine, root: string, told: Map<string, Json>, remindS: number): string[] {
  const host = hostOf(root);
  const lines: string[] = [];

  for (const open of openBatches(readChat(root), asArray(stateOfDir(root)["decisions"]) ?? [], host)) {
    const sentMs = parseInstant(pyText(open.batch.at));

    if (sentMs === undefined) continue;
    const period = remindPeriod(sentMs / 1000, secondsNow(machine), remindS);
    const key = `batch:${open.batch.id}`;
    const last = asNumber(told.get(key));

    if (period < 1 || (last !== undefined && last >= period)) continue;
    told.set(key, period);
    const ref = asString(open.decision?.["ref"]) ?? open.marked.ref ?? open.marked.id ?? "?";
    const title = asString(open.decision?.["title"]) ?? open.marked.title ?? "";

    const parts = [
      ...(open.unanswered.length === 0 ? [] : [`${listed("mark", open.unanswered)} unanswered`]),
      ...(open.unrevised.length === 0 ? [] : [`${listed("mark", open.unrevised)} answered, but ${oneLine(ref)} is not revised since`]),
    ];

    const minutes = Math.floor((secondsNow(machine) - sentMs / 1000) / 60);

    lines.push(
      `! batch #${open.batch.id} on ${oneLine(ref)} (${oneLine(title)}) is still open after ${minutes} min: ${parts.join("; ")}. ` +
        `Close each mark: revise the decision (\`fleet state ${root} decision ${oneLine(ref)} --body FILE --log "..."\`) and answer it ` +
        `(\`fleet chat ${root} say --as ${host} --re ${open.batch.id} --mark N "..."\`), or keep it as it is and say why ` +
        `(\`--re ${open.batch.id} --mark N --no-change "<why>" "..."\`). "Agreed, rewriting" without the revision leaves it open.`,
    );
  }

  return lines;
}
