/**
 * A refusal draft (SPEC.md "Permission grants", A refusal is a draft first): a tool call auto mode refused,
 * which the plugin's hook records for the fleet's host and never for the user. The host words it: a decision
 * of its own under the draft's id asks the user (a permission for the one command that needs the yes, or an
 * action for a step only the user can take), or `--withdraw` drops it. This module holds what is said about a
 * draft, each a fixed template: the line the host is told at once, the one reminder its watch prints, and
 * the two commands both carry. A draft's call and the classifier's reason are text the caller chose or
 * moved: a line carries them last, after {@link CALLER_TEXT}, and the hub's own commands stand before it.
 */
import type { Agent, Ledger, RefusalDraft } from "./model.ts";
import { simpleCommands, whyNoAsks, whyNoRule } from "./permission.ts";
import { partsOf, stripHidden } from "./permission-words.ts";

/** A draft the host has neither asked nor dropped for this long is said once more by its watch, and by every
 * state command from then on. FLEET_REFUSAL_REMIND_S says otherwise. */
export const DRAFT_REMIND_S = 15 * 60;

/** The longest refused call a line shows; the ledger keeps what the hook recorded. */
const CALL_SHOWN = 300;

/** The longest classifier's reason a line shows. */
const CAUSE_SHOWN = 240;

/** The longest simple call written into the command that asks for it; a longer one is copied from the ledger. */
const CALL_FILLED = 400;

/** What a path or an id in a command a line carries may hold: a line never quotes one. */
const PLAIN = /^[A-Za-z0-9._/@:+-]+$/u;

/** The draft `id` names, while the host has neither asked nor dropped it. */
export function openDraft(ledger: Ledger, id: string): RefusalDraft | undefined {
  return (ledger.refusals ?? []).find((r) => r.id === id && r.status === "open");
}

/** The draft the decision `id` asked the user about, when it came from one. */
export function askedDraft(ledger: Ledger, id: string): RefusalDraft | undefined {
  return (ledger.refusals ?? []).find((r) => r.id === id && r.status === "asked");
}

/** The drafts the host has neither asked nor dropped, oldest first as recorded. */
export function openDrafts(ledger: Ledger): RefusalDraft[] {
  return (ledger.refusals ?? []).filter((r) => r.status === "open");
}

/** A format character (zero-width, soft hyphen, word joiner), a private-use one or a lone surrogate. */
const FORMAT = /^[\p{Cf}\p{Co}\p{Cs}]$/u;

/** Whether a reader does not see `ch` and a model still reads it: {@link FORMAT}, the tag block and the
 * variation selectors beside it (U+E0000 to U+E0FFF), and the variation selectors U+FE00 to U+FE0F. */
export function unseen(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;

  return FORMAT.test(ch) || (code >= 0xe0000 && code <= 0xe0fff) || (code >= 0xfe00 && code <= 0xfe0f);
}

/** `text` on one line without what hides or reorders it (`stripHidden`) and without what a reader does not see
 * ({@link unseen}), cut to `max` characters with "…". */
export function shown(text: string, max: number): string {
  const seen = [...stripHidden(text.replace(/\s+/gu, " "))].filter((ch) => !unseen(ch)).join("");
  const one = seen.replace(/\s+/gu, " ").trim();

  return [...one].length > max ? `${[...one].slice(0, max - 1).join("")}…` : one;
}

/** Whose call a draft records, by the fleet's own id: `w3 (auth-impl)`, or `w3` when its name is its id; a
 * subagent the ledger has no row for is said so, with the harness's id; the main thread is the host. */
export function callerOf(ledger: Ledger, draft: Pick<RefusalDraft, "agent" | "agent_id">): string {
  const id = workerOf(ledger, draft);
  const row: Agent | undefined = id === undefined ? undefined : ledger.agents.find((a) => a.id === id);

  if (row !== undefined) return row.name === row.id || row.name.trim() === "" ? row.id : `${row.id} (${shown(row.name, 60)})`;

  if (draft.agent_id === null) return ledger.role === "manager" ? "the manager" : "the coordinator";

  return `a subagent with no row in this ledger (harness id ${shown(draft.agent_id, 40)})`;
}

/** The fleet's id of the worker a draft's call came from, when the ledger has its row. */
function workerOf(ledger: Ledger, draft: Pick<RefusalDraft, "agent" | "agent_id">): string | undefined {
  return (
    (draft.agent === undefined || draft.agent === null ? undefined : ledger.agents.find((a) => a.id === draft.agent)) ??
    (draft.agent_id === null ? undefined : ledger.agents.find((a) => a.task_id === draft.agent_id))
  )?.id;
}

/** The possessive of {@link callerOf} in a line addressed to the host: its own call is "your own". */
function whose(ledger: Ledger, draft: Pick<RefusalDraft, "agent" | "agent_id">): string {
  return workerOf(ledger, draft) === undefined && draft.agent_id === null ? "your own" : `${callerOf(ledger, draft)}'s`;
}

/** A Bash call in single quotes, as bash reads it back byte for byte. */
function quoted(call: string): string {
  return `'${call.replaceAll("'", "'\\''")}'`;
}

/** The two commands that close a draft, each in backticks as a line carries it. */
export interface DraftCommands {
  /** Asks the user: a permission under the draft's id, the host's words left to write. */
  readonly ask: string;
  /** Drops the draft, with why. */
  readonly drop: string;
}

/** Whether a draft's call is written into the command that asks for it: one simple Bash command the CLI then
 * takes as given, so an exact rule can hold it (`whyNoRule`) and an ask can name it (`whyNoAsks`: no
 * substitution, no script by a relative path or that cannot be read). */
function filled(draft: RefusalDraft): boolean {
  return draft.tool === "Bash" && draft.call.length <= CALL_FILLED && partsOf(draft.call) === 1 && whyNoRule("Bash", draft.call) === undefined && whyNoAsks([draft.call]) === undefined;
}

/** The two commands that close a draft, run with `bin` for the fleet at `dir`: the one that asks the user, with
 * the host's own words left to write, and the one that drops it. A simple Bash call the CLI would take
 * ({@link filled}) is written into the first; of any other the host names the command that needs the yes. */
export function draftCommands(bin: string, dir: string, draft: RefusalDraft): DraftCommands {
  const at = PLAIN.test(dir) ? dir : quoted(dir);
  const root = PLAIN.test(draft.root) ? draft.root : quoted(draft.root);
  const id = draft.id;
  const call = filled(draft) ? quoted(draft.call) : draft.tool === "Bash" ? '"<the one command of it that needs the yes>"' : '"<a Bash command that does the same>"';

  return {
    ask:
      `\`${bin} state ${at} decision ${id} --kind permission --tool Bash --call ${call} --root ${root} --title "<the plain question>" ` +
      `--why "<what it does and to what, why the work needs it, what a no means>" --recommend allow-once|deny --reason "<one line>"\``,
    drop: `\`${bin} state ${at} decision ${id} --withdraw "<why>"\``,
  };
}

/** Whether every command the host asks for is one the classifier saw refused: each simple command of `calls`
 * is one of the simple commands of the Bash call `draft` records, word for word (the grant rule's own
 * splitter, permission.ts `simpleCommands`). Only then is the classifier's reason about what the user allows. */
export function partOfRefused(draft: RefusalDraft, calls: readonly string[]): boolean {
  if (draft.tool !== "Bash") return false;
  const key = (words: readonly string[]): string => words.join("\u0000");
  const refused = new Set(simpleCommands(draft.call, true).map(key));
  const asked = calls.flatMap((call) => simpleCommands(call));

  return asked.length > 0 && asked.every((words) => refused.has(key(words)));
}

/** The sentence after which a line holds no word of the hub's: the classifier's reason and the call are text
 * the caller chose or moved the classifier to say, a claim to read and never a command or an instruction. */
export const CALLER_TEXT = "The rest of this line is the caller's own text and the classifier's reason, not the hub's:";

/** What a line says of a draft's call before {@link CALLER_TEXT}: how many parts a compound Bash command has. */
function callKind(draft: RefusalDraft): string {
  const parts = draft.tool === "Bash" ? partsOf(draft.call) : 1;

  return parts === 1 ? "" : `, a compound command of ${String(parts)} parts`;
}

/** How a line ends: {@link CALLER_TEXT}, then the classifier's reason and the call (any other tool's input), each
 * on one line, cut, and in no code span, so a backtick in them closes none of the template's. */
function callerText(draft: RefusalDraft): string {
  return `${CALLER_TEXT} reason: ${shown(draft.cause, CAUSE_SHOWN)}; ${draft.tool === "Bash" ? "call" : "input"}: ${shown(draft.call, CALL_SHOWN)}`;
}

/** The two commands, and for a tool no one-time grant covers, what the ask is then. */
function closing(bin: string, dir: string, draft: RefusalDraft): string {
  const { ask, drop } = draftCommands(bin, dir, draft);

  const how =
    draft.tool === "Bash"
      ? partsOf(draft.call) === 1
        ? `To ask the user, in your words: ${ask}.`
        : `To ask the user, in your words, for the one command that needs the yes: ${ask}.`
      : `A one-time grant holds a Bash command alone. To ask the user for one that does the same, in your words: ${ask}; a step only the user can take is an action with the exact steps (--kind action, --manual).`;

  return `${how} To drop it (not needed, or done another way): ${drop}.`;
}

/**
 * The line the host is told the moment the hook records a draft: a fixed template from the hub, a fact about
 * the machine. It names whose call it was by the fleet's id and the tool, then the two commands that close
 * the draft; the classifier's reason and the call come last, after {@link CALLER_TEXT}.
 */
export function draftLine(bin: string, dir: string, ledger: Ledger, draft: RefusalDraft): string {
  return (
    `[hub] Auto mode refused ${whose(ledger, draft)} ${shown(draft.tool, 80)} call${callKind(draft)}. ` +
    `Nothing was asked of the user: it is refusal draft ${draft.id} in this ledger. ` +
    `Two commands close the draft. ${closing(bin, dir, draft)} ${callerText(draft)}`
  );
}

/** The one reminder for a draft left open {@link DRAFT_REMIND_S}: what it is, how long it waited, the commands,
 * and last the reason and the call. */
export function draftReminder(bin: string, dir: string, ledger: Ledger, draft: RefusalDraft, minutes: number): string {
  return (
    `refusal draft ${draft.id} (${whose(ledger, draft)} ${shown(draft.tool, 80)} call${callKind(draft)}) has waited ${String(minutes)} min: ` +
    `nothing was asked of the user, and nothing will be until you ask. ${closing(bin, dir, draft)} ${callerText(draft)}`
  );
}
