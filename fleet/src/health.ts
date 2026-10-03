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

/** When the user's answer to the open decision `d`, given after it last changed and not replied to,
 * was sent (stamps compared as instants, open-13); undefined when there is none. A held decision
 * (`held`, the fleet works on it first) has recorded every answer given until `held_at`. */
export function answeredAt(d: JsonObject, said: readonly Message[]): string | undefined {
  const revised = d["revised"];
  const opened = d["opened"];
  const since = revised !== undefined && revised !== null && revised !== "" ? str(revised) : str(opened);
  const id = d["id"];
  const heldAt = truthy(d["held"]) ? str(d["held_at"]) : undefined;

  const answers = said.filter(
    (m) =>
      m.decision !== undefined &&
      pyRepr(m.decision) === pyRepr(id) &&
      m.from === "user" &&
      atOrAfter(str(m.at), since) &&
      !(heldAt !== undefined && heldAt !== "" && atOrAfter(heldAt, str(m.at))) &&
      !said.some((r) => r.from !== "user" && r.re === m.id),
  );

  const last = answers.at(-1);

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
