/**
 * What a fleet looks like from outside its own session: the user's answers its coordinator has not
 * recorded, the grillings answered and not recorded, the workers the ledger says run but whose
 * transcripts are silent. Read by `fleet fleets` and by a manager's or coordinator's chat watch.
 */
import { atOrAfter, stampOf } from "./clock.ts";
import type { Message } from "./chat/store.ts";
import { asArray, asObject, asString, pyRepr, truthy, type JsonObject } from "./json.ts";
import { workerActivity } from "./heartbeat.ts";
import type { Decision } from "./ledger/model.ts";
import { secondsNow, type Machine } from "./world.ts";

/** A running worker that has made no tool call (by its heartbeat) or written nothing (by its transcript,
 * without one) for this long is silent. */
export const SILENT_S = 20 * 60;

/** A local stamp of seconds since the epoch. */
export function isoOf(seconds: number): string {
  return stampOf(new Date(seconds * 1000));
}

function str(value: JsonObject[string] | undefined): string {
  return asString(value) ?? (value === undefined || value === null ? "" : pyRepr(value));
}

/** Whether `d` is a grilling still open with no question left open: every question is answered (or
 * dropped) and the fleet has yet to record it (`--decide` or `--withdraw`). Read from the ledger's
 * question statuses, whatever the chat said since; `show`, the state warnings and the coordinator's
 * watch say it from this, and the page's `grillState` by the same rule. Python's
 * `decisions.answered_grill`. */
export function answeredGrill(d: Pick<Decision, "kind" | "status" | "questions">): boolean {
  return d.kind === "grill" && d.status === "open" && !(d.questions ?? []).some((q) => q.status === "open");
}

/** Whether `d` is explained: a permission is once the coordinator gave its recommendation (with the why and
 * the body), the hook's record of the refused call having none; any other kind is. The page shows a
 * permission that is not as waiting for the coordinator's explanation, by the same rule. */
export function explained(d: Pick<Decision, "kind" | "recommend">): boolean {
  return d.kind !== "permission" || (d.recommend ?? "") !== "";
}

/** Whether `d` is an open permission the coordinator has not explained yet. */
export function unexplained(d: Pick<Decision, "kind" | "status" | "recommend">): boolean {
  return d.status === "open" && !explained(d);
}

/** The command that explains permission `ref` of the fleet in `dir`, run with `bin`, for its call of revision
 * `rev` (permission.ts `callRev`), and what its body says. */
export function explainCommand(bin: string, dir: string, ref: string, rev: string): string {
  return (
    `\`${bin} state ${dir} decision ${ref} --call ${rev} --why "<why the worker needs it, one or two plain lines>" --body FILE ` +
    `--recommend allow-once|deny --reason "<one line>" --log "explained"\`, the body saying what the call does, why the worker needs it, ` +
    "its cost and risk (money, time, data, outside systems) and what a denial means"
  );
}

/** How the page's answer to an action the user ran and that failed begins: `Failed: <what happened>`. */
export const FAILED = "Failed:";

/** The user's latest answer to the open action `d`, given since it last changed, when it says the step
 * failed (`Failed: ...`); undefined otherwise. Neither a reply nor a hold settles it: the step is not done
 * until the fleet revises it (the fix, re-presented) or withdraws it. Python's `decisions.failed_answer`,
 * the page's `failedAnswer`. */
export function failedAnswer(d: Pick<Decision, "id" | "kind" | "status" | "opened" | "revised">, said: readonly Message[]): Message | undefined {
  if (d.kind !== "action" || d.status !== "open") return undefined;
  const since = d.revised !== undefined && d.revised !== null && d.revised !== "" ? d.revised : d.opened;
  const last = said.filter((m) => m.from === "user" && m.decision === d.id && atOrAfter(str(m.at), since)).at(-1);

  return last?.text.startsWith(FAILED) === true ? last : undefined;
}

/** The first words of a failed answer: its note's first line, cut at 60 characters. */
export function failureWords(m: Pick<Message, "text">): string {
  const line = (m.text.slice(FAILED.length).trim().split("\n")[0] ?? "").trim();
  const chars = [...line];

  return chars.length > 60 ? chars.slice(0, 60).join("") + "…" : line;
}

/** Whether decision `d` has recorded the user's answer `m`: its own state changed at or after it. Closed
 * (decided or withdrawn), it has recorded every answer; open, it has recorded one given before it was opened
 * or last revised, one given until it was held (`held_at`, the fleet works on it first), and, on a grilling,
 * one given before a question was answered or dropped. A reply in the chat records nothing: only the
 * decision command does (D115 sat waiting two days behind a "Recorded B"). Python's `decisions.recorded`. */
export function answerRecorded(d: JsonObject, m: Message): boolean {
  const status = d["status"];

  if (status !== undefined && status !== "open") return true;
  const at = str(m.at);
  const revised = d["revised"];
  const since = revised !== undefined && revised !== null && revised !== "" ? str(revised) : str(d["opened"]);
  const heldAt = truthy(d["held"]) ? str(d["held_at"]) : "";

  if (!atOrAfter(at, since) || (heldAt !== "" && atOrAfter(heldAt, at))) return true;

  return (asArray(d["questions"]) ?? []).some((q) => {
    const answered = asString(asObject(q)?.["answered"]);

    return answered !== undefined && answered !== "" && atOrAfter(answered, at);
  });
}

/** The fields of decision `d` that {@link answerRecorded} reads, as its ledger row holds them. */
export function decisionRow(d: Pick<Decision, "id" | "status" | "opened" | "revised" | "held" | "held_at" | "questions">): JsonObject {
  return {
    id: d.id,
    status: d.status,
    opened: d.opened,
    revised: d.revised ?? null,
    held: d.held ?? null,
    held_at: d.held_at ?? null,
    questions: (d.questions ?? []).map((q) => ({ id: q.id, status: q.status, answered: q.answered ?? null })),
  };
}

/** When the user's latest answer to decision `d` that it has not recorded ({@link answerRecorded}) was sent
 * (stamps compared as instants, open-13); undefined when there is none. Python's `decisions.answered_at`. */
export function answeredAt(d: JsonObject, said: readonly Message[]): string | undefined {
  const id = d["id"];
  const last = said.filter((m) => m.decision !== undefined && pyRepr(m.decision) === pyRepr(id) && m.from === "user" && !answerRecorded(d, m)).at(-1);

  return last === undefined ? undefined : str(last.at);
}

/** A silent worker. */
export interface Silent {
  readonly id: string;
  readonly name: string;
  readonly active: string;
}

/** The workers of DIR the ledger says are running or blocked that have not been seen for
 * {@link SILENT_S} (their last heartbeat, else their transcript), oldest silence first. */
export function silentWorkers(machine: Machine, root: string, state: JsonObject): Silent[] {
  const seen = workerActivity(root, machine.config, state);
  const now = secondsNow(machine);
  const rows: Silent[] = [];

  for (const row of asArray(state["agents"]) ?? []) {
    const a = asObject(row);
    const id = asString(a?.["id"]);
    const status = a?.["status"];

    if (a === undefined || id === undefined || (status !== "running" && status !== "blocked")) continue;
    const at = seen.get(id)?.at;

    if (at === undefined || now - at <= SILENT_S) continue;
    const name = a["name"];
    rows.push({ id, name: name === undefined || name === null || name === "" ? id : str(name), active: isoOf(at) });
  }

  return rows.sort((x, y) => (x.active < y.active ? -1 : x.active > y.active ? 1 : 0));
}
