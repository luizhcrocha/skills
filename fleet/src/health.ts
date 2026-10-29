/**
 * What a fleet looks like from outside its own session: the user's answers its coordinator has not
 * recorded, the grillings answered and not recorded, the workers the ledger says run but whose
 * transcripts are silent. Read by `fleet fleets` and by a manager's or coordinator's chat watch.
 */
import { atOrAfter, stampOf } from "./clock.ts";
import type { Message } from "./chat/store.ts";
import { asArray, asObject, asString, dumps, pyRepr, truthy, type JsonObject, type JsonOut } from "./json.ts";
import { workerActivity } from "./heartbeat.ts";
import type { Decision } from "./ledger/model.ts";
import movedPrograms from "./moved-programs.json" with { type: "json" };
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

/** Whether `d` is an open permission the coordinator has not explained yet. On a team that has `moved` to the
 * cloud none is: a program may not set a permission's recommend (the cloud's fold refuses it), the CLI that
 * would refuses to write there, and the cloud's page never shows a permission as waiting for an explanation. */
export function unexplained(d: Pick<Decision, "kind" | "status" | "recommend">, moved: boolean): boolean {
  return !moved && d.status === "open" && !explained(d);
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

/** A program of moved-programs.json's, its `{name}`s filled with `values` as JSON literals, ASCII-escaped as the
 * hook's `_js` writes them (Python's json.dumps). */
function program(template: string, values: Readonly<Record<string, JsonOut>>): string {
  return template.replace(/\{(\w+)\}/gu, (_, name: string) => dumps(values[name] ?? null));
}

function onStdin(dir: string, text: string): string {
  return `one program on the stdin of \`FLEET_DIR=${dir} fleet-run\`: \`${text}\``;
}

/** How a moved team (files.ts `isMoved`) closes its grilling `key`, the ledger row's id (the page's ref, G6, is not
 * one), once the user answered every question on the page: grill.close with `resolution`, which closes it decided,
 * since the fleet's owner-answer gate refuses `decision.decide` (decision.withdraw closes a card too, but as one nobody
 * needs). The hook's nudge says the same program (`close_program` in hooks/tstack-hook.py, from moved-programs.json). */
export function closeProgram(dir: string, key: string, resolution: string): string {
  return onStdin(dir, program(movedPrograms.close, { key, resolution }));
}

/** How a moved team sets step `id` of `milestone`: one program per `[status, agent]` of `steps`, each an alternative to
 * the one before. The watch says it for a step its worker left. */
export function stepProgram(dir: string, milestone: string, id: string, title: string, steps: readonly (readonly [string, string])[]): string {
  const [first, ...rest] = steps.map(([status, agent]) =>
    program("step({milestone}, {id}, {title}, {status}, {agent}); return records.apply(ops);", { milestone, id, title, status, agent }),
  );

  return [onStdin(dir, first ?? ""), ...rest.map((text) => `\`${text}\``)].join(", or ");
}

/** How a moved team answers the user's line #`re` on its card `key` (the ledger row's id), `number` on the page, that
 * left the card open: words typed in the chat, a None of these or a Failed:. Only the user's answer on the card
 * records it, so the reply asks for that, naming the card's number, which the page links. The hook's nudge says the
 * same program (`on_card_program` in hooks/tstack-hook.py, from moved-programs.json). */
export function onCardProgram(dir: string, key: string, number: string, re: number): string {
  const reply = movedPrograms.reply.replace("{number}", number);

  return onStdin(dir, program(movedPrograms.onCard, { reply, re, key }));
}

/** How a moved team settles its action `key` (the ledger row's id) the user ran and that failed: no program may decide
 * it, so the fix is re-presented (decision.revise with the new manual) or the action is withdrawn, each one program. */
export function failedProgram(dir: string, key: string): string {
  const revise = program('decision.revise({key}, { manual: "..." }, "what changed"); return records.apply(ops);', { key });
  const withdraw = program('decision.withdraw({key}, "why"); return records.apply(ops);', { key });

  return `${onStdin(dir, revise)}, or \`${withdraw}\``;
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

/** Whether the user allowed permission `d` on the page since it last changed: their latest answer to it, stored
 * by the hub (the CLI stores no message as the user) once it had granted the call, begins with `allow-once` or
 * `allow-kind`.
 * Only that answer grants; a fleet that records one the user never gave is refused (`decision --decide`). */
export function allowedByUser(d: Pick<Decision, "id" | "opened" | "revised">, said: readonly Message[]): boolean {
  const since = d.revised !== undefined && d.revised !== null && d.revised !== "" ? d.revised : d.opened;
  const last = said.filter((m) => m.from === "user" && m.decision === d.id && atOrAfter(str(m.at), since)).at(-1);
  const text = last?.text.trim().toLowerCase() ?? "";

  return text.startsWith("allow-once") || text.startsWith("allow-kind");
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

/** Whether the fleet still owes the user's line `m` on decision `d`, `said` being the chat: `d` has not recorded it
 * ({@link answerRecorded}), and, on a `moved` team, nothing answers it (`re`). There no program can record the line, so
 * the reply asking for the answer on the card is all the fleet owes; the hook pops its nudge on the same reply
 * (`fleet_chat_nudge`). */
export function owed(d: JsonObject, m: Message, said: readonly Message[], moved: boolean): boolean {
  return !answerRecorded(d, m) && !(moved && said.some((x) => x.from !== "user" && x.re === m.id));
}

/** When the user's latest line on decision `d` the fleet still owes ({@link owed}) was sent (stamps compared as
 * instants, open-13); undefined when there is none. Python's `decisions.answered_at`, for a team not `moved`. */
export function answeredAt(d: JsonObject, said: readonly Message[], moved = false): string | undefined {
  const id = d["id"];
  const last = said.filter((m) => m.decision !== undefined && pyRepr(m.decision) === pyRepr(id) && m.from === "user" && owed(d, m, said, moved)).at(-1);

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
