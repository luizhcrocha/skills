/**
 * Where a standing approval comes from (Python's `decisions.approval_source`): a decided choice or input, or a
 * grilling's question, that the user answered on the page, in this fleet's ledger or, as `FLEET/DECISION`, in a
 * served fleet's, found through the registry; a grilling's by one question (`:Q<n>`), answered while the others
 * may still be open. Only the user's own plain yes to that exact
 * item grants: the ledger's answer and the user's message the hub wrote (`from: user`) must both be one of
 * {@link APPROVES}, whole; a choice's decided option must be one that says yes, and the one the user picked. The
 * same check backs `fleet state DIR approval add` and `fleet fleets approval add`.
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { readChat, type Message } from "../chat/store.ts";
import { parseInstant } from "../clock.ts";
import { Refusal } from "../errors.ts";
import { isDir, listDir, readText, resolvePath } from "../files.ts";
import { asArray, asNumber, asObject, asString, parseJson, pyStr, type JsonObject } from "../json.ts";
import { alive, pidOf } from "../registry.ts";
import type { Machine } from "../world.ts";
import { parseLedger, type Approval, type Choice, type Decision, type Ledger, type Question } from "./model.ts";
import { findDecision } from "./numbers.ts";
import { CHOICE_KINDS } from "./validate.ts";

/** `[FLEET/]DECISION[:Q<n>]`: a decision of this fleet, or of FLEET, and a grilling's question. */
export const SOURCE = /^(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)(?::[Qq]([0-9]+))?$/u;

/** The whole answers that give a standing approval: a plain yes, nothing after it. */
export const APPROVES = ["yes", "y", "approve", "approved", "sim", "ok"] as const;

/** What a refusal over an answer that is not a plain yes tells the coordinator to do. */
const ASK_AGAIN = "only a plain yes (yes, approve, sim, ok) gives a standing approval; ask the user again for a plain yes or no, one rule to a question";

/** A `--ref` read into its parts: the fleet (undefined for this one), the decision, the question's id (`q2`). */
export interface SourceRef {
  readonly fleet: string | undefined;
  readonly key: string;
  readonly question: string | undefined;
}

/** `text` read as `[FLEET/]DECISION[:Q<n>]`, or undefined. */
export function parseSource(text: string): SourceRef | undefined {
  const m = SOURCE.exec(text);

  if (m === null) return undefined;
  const n = m[3];

  return { fleet: m[1], key: m[2] ?? "", question: n === undefined ? undefined : `q${String(Number(n))}` };
}

/** A served fleet as the registry records it. */
export interface ServedFleet {
  readonly id: string;
  readonly dir: string;
}

/** The registry entries in `dir` that name a fleet and its DIR; `live`, only those whose pid runs. */
function entriesIn(dir: string, live: boolean): JsonObject[] {
  const entries: JsonObject[] = [];

  for (const file of listDir(dir).filter((n) => n.endsWith(".json")).sort()) {
    const path = join(dir, file);

    if (isDir(path)) continue;
    const entry = asObject(Option.getOrUndefined(parseJson(readText(path) ?? "")));

    if (entry !== undefined && asString(entry["id"]) !== undefined && asString(entry["dir"]) !== undefined && (!live || alive(pidOf(entry["pid"])))) entries.push(entry);
  }

  return entries;
}

function named(entries: readonly JsonObject[], name: string): ServedFleet | undefined {
  const found = entries.find((e) => e["id"] === name) ?? entries.find((e) => (asArray(e["aliases"]) ?? []).some((a) => a === name));

  return found === undefined ? undefined : { id: asString(found["id"]) ?? "", dir: asString(found["dir"]) ?? "" };
}

/** The registry's live entry for the fleet called `name` (its id, else one of its aliases), read without
 * touching the registry; undefined when no fleet of that name is served. `stopped`: else the entry the registry
 * keeps for a fleet no longer served (`REGISTRY/names/`), whose ledger is still where it was. */
export function servedFleet(machine: Machine, name: string, stopped = false): ServedFleet | undefined {
  const home = machine.registry.place.home;

  return named(entriesIn(home, true), name) ?? (stopped ? named(entriesIn(join(home, "names"), false), name) : undefined);
}

/** The names the fleet served from `root` goes by in the registry (its id and aliases, live or kept), read
 * without touching it: an approval in its own ledger may name its decisions as `<name>/G2`. */
export function namesOf(machine: Machine, root: string): string[] {
  const home = machine.registry.place.home;
  const dir = resolvePath(root);

  return [...entriesIn(home, false), ...entriesIn(join(home, "names"), false)]
    .filter((e) => e["dir"] === dir)
    .flatMap((e) => [asString(e["id"]) ?? "", ...(asArray(e["aliases"]) ?? []).flatMap((a) => asString(a) ?? [])])
    .filter((n) => n !== "");
}

/** The `--ref` an approval was added from: its ref, and `:Q<n>` when it came from a grilling's question. */
export function refOf(a: Approval): string {
  return a.question === undefined || a.question === "" ? a.ref : `${a.ref}:${a.question.toUpperCase()}`;
}

/** Whether approval `a` came from decision `d` of the fleet whose names are `names` (its own ledger's), and,
 * given `question`, from that question of it. */
export function comesFrom(a: Approval, d: Decision, names: readonly string[], question?: string): boolean {
  const num = d.ref !== undefined && d.ref !== "" ? d.ref : d.id;
  const ours = a.ref === d.id || names.some((n) => a.ref === `${n}/${num}` || a.ref === `${n}/${d.id}`);

  return ours && (question === undefined || a.question === question);
}

/** `text` trimmed, in lower case, without the full stops and exclamation marks it ends with. */
function folded(text: string): string {
  return text.trim().toLowerCase().replace(/[.!\s]+$/u, "");
}

/** Whether `text`, whole, is a plain yes: one of {@link APPROVES}, nothing before or after it. */
export function plainYes(text: string): boolean {
  const word = folded(text);

  return APPROVES.some((w) => w === word);
}

/** An answer read plainly: its words, and the option it picks when it names one. */
export interface Plain {
  readonly words: string;
  readonly option: Choice | undefined;
}

/** An answer as given on the page, read plainly: "as recommended" (or the page's "ok, as recommended (X)") as
 * the recommendation, a trailing "(as recommended)" dropped, an option's key (`a`, `(a)`, `a: <its label>`) or
 * its label as that option. Undefined when words follow an option's key that are not its label ("(a) but not on
 * fridays"): a qualifier, never a plain answer. */
export function plainAnswer(text: string, options: readonly Choice[] = [], recommend?: string | null): Plain | undefined {
  let t = text.trim();
  const rec = /^ok,\s*as recommended\s*\((.*)\)$/isu.exec(t);

  if (rec !== null) t = (recommend ?? rec[1] ?? "").trim();
  else if (/^as recommended[.!]*$/iu.test(t)) t = (recommend ?? "").trim();
  t = t.replace(/\s*\(as recommended\)$/iu, "");
  const keyed = /^\(?([A-Za-z0-9]+)\)?(?:(?:\s*:\s*|\s+)(.*))?$/su.exec(t);
  const key = keyed?.[1]?.toLowerCase();
  const option = key === undefined ? undefined : options.find((o) => o.id.toLowerCase() === key);

  if (option !== undefined) {
    const rest = keyed?.[2];

    return rest === undefined || folded(rest) === folded(option.label) ? { words: option.label, option } : undefined;
  }

  return { words: t, option: options.find((o) => folded(o.label) === folded(t)) };
}

/** Whether a grilling question was answered with a plain yes ({@link plainAnswer}, {@link plainYes}). */
export function approves(q: Question): boolean {
  const plain = plainAnswer(q.answer ?? "", q.options ?? [], q.recommend);

  return plain !== undefined && plainYes(plain.words);
}

/** The user's own words to question `qid` of grilling `d`, from the chat the hub writes: the last "Q<n>: ..." line
 * of a message of theirs about the grilling (with the lines under it that are no question's), else a message of
 * theirs that answers (`re`) a message naming that question alone. Undefined when they never answered it.
 * Only words after the question's last asking count: a message whose id is over `after` (the chat's last id
 * when it was asked; ids only grow), else, for a question recorded without one, a message not older than `since`. */
export function userAnswerTo(
  chat: readonly Message[],
  d: Decision,
  qid: string,
  since?: string | null,
  after?: number | null,
): { readonly words: string; readonly message: Message } | undefined {
  const n = qid.slice(1);
  const byId = new Map(chat.map((m) => [m.id, m]));
  const from = after !== undefined && after !== null ? undefined : since === undefined || since === null ? undefined : parseInstant(since);
  let found: { words: string; message: Message } | undefined;

  for (const m of chat) {
    if (m.from !== "user") continue;

    if (after !== undefined && after !== null && m.id <= after) continue;

    if (from !== undefined && (parseInstant(asString(m.at) ?? "") ?? -Infinity) < from) continue;
    const lines = m.text.split("\n");
    const heads = lines.map((line) => /^\s*Q(\d+)\s*:\s*(.*)$/iu.exec(line));

    if (heads.some((h) => h !== null)) {
      if (m.decision !== d.id) continue;

      heads.forEach((h, i) => {
        if (h === null || String(Number(h[1])) !== n) return;
        const more: string[] = [];

        for (let j = i + 1; j < lines.length && heads[j] === null; j += 1) if ((lines[j] ?? "").trim() !== "") more.push((lines[j] ?? "").trim());
        found = { words: [h[2] ?? "", ...more].join(" ").trim(), message: m };
      });
      continue;
    }

    const re = asNumber(m.re);
    const asked = re === undefined ? undefined : byId.get(re);

    if (asked === undefined || (m.decision !== d.id && asked.decision !== d.id)) continue;
    const named = new Set([...asked.text.matchAll(/\bQ(\d+)\b/giu)].map((x) => String(Number(x[1]))));

    if (named.size === 1 && named.has(n)) found = { words: m.text.trim(), message: m };
  }

  return found;
}

/** What an approval row takes from where it came from. */
export interface Source {
  /** The decision's id here, or `FLEET/<its number>` in another fleet. */
  readonly ref: string;
  readonly question: string | undefined;
  readonly message: number;
  readonly author: string | undefined;
  /** How the CLI names it: `D7`, `manager/G5:Q1`. */
  readonly label: string;
  /** The decision a logged event is tagged with: this fleet's only. */
  readonly decision: string | undefined;
  /** The decision's id in its own ledger, and that ledger's DIR. */
  readonly id: string;
  readonly dir: string;
}

/** Why a `--ref` gives no standing approval. */
export class NoSource {
  readonly why: string;

  constructor(why: string) {
    this.why = why;
  }
}

/** Another fleet's ledger, or why it cannot be read. */
function ledgerAt(fleet: ServedFleet): Ledger | NoSource {
  const path = join(fleet.dir, "state.json");
  const read = Option.getOrUndefined(parseLedger(readText(path) ?? ""));

  return read === undefined || read instanceof Refusal ? new NoSource(`fleet '${fleet.id}' has no ledger at ${path}`) : read;
}

/** Where `approval add --ref TEXT` comes from, checked as a standing approval needs it: a decided choice or
 * input, or a grilling's answered question (the grilling itself may be open), none withdrawn or superseded,
 * asked of the user on the page, the user's words after the question's last asking,
 * decided with a plain yes, and the user's own message in that
 * fleet's chat (the hub's: only it writes as the user) saying that same plain yes to that item: for a grilling,
 * their answer to that question; for a choice, their pick of the decided option. The row's fields, or why not. */
export function approvalSource(machine: Machine, root: string, here: Ledger | undefined, text: string, stopped = false): Source | NoSource {
  const parsed = parseSource(text);

  if (parsed === undefined) return new NoSource(`--ref reads [FLEET/]DECISION[:Q<n>] (D7, manager/G5:Q1), got ${pyStr(text)}`);
  const { fleet, key, question } = parsed;
  let ledger = here;
  let dir = root;
  let where: ServedFleet | undefined;

  if (fleet !== undefined) {
    where = servedFleet(machine, fleet, stopped);

    if (where === undefined) return new NoSource(`no fleet '${fleet}' is being served: --ref FLEET/DECISION names a decision in a fleet \`fleet fleets list\` names`);
    const read = ledgerAt(where);

    if (read instanceof NoSource) return read;
    ledger = read;
    dir = where.dir;
  }

  const d = ledger === undefined ? undefined : findDecision(ledger, key);

  if (d === undefined) return new NoSource(`unknown decision '${key}'${where === undefined ? "" : ` in ${where.id}`}`);
  const num = d.ref !== undefined && d.ref !== "" ? d.ref : d.id;
  let label = `${where === undefined ? "" : `${where.id}/`}${num}`;
  const name = `${label} (${d.title ?? "None"})`;

  if (question !== undefined && d.kind !== "grill") return new NoSource(`${name} is a ${d.kind}, not a grilling: :${question.toUpperCase()} names a grilling's question`);

  if (question === undefined && d.kind === "grill") return new NoSource(`${name} is a grilling: name the question the user answered yes or approve (${label}:Q1)`);

  if (d.status === "withdrawn") return new NoSource(`${name} was withdrawn: a standing approval comes from a decision that stands`);
  const over = (ledger?.decisions ?? []).find((x) => x.supersedes === d.id);

  if (over !== undefined) {
    return new NoSource(`${name} is superseded by ${over.ref !== undefined && over.ref !== "" ? over.ref : over.id}: a standing approval comes from a decision that stands`);
  }

  if (question === undefined && d.status !== "decided") return new NoSource(`${name} is ${d.status}: a standing approval comes from a decision the user decided`);

  if (!CHOICE_KINDS.some((k) => k === d.kind) || (d.asks ?? "user") !== "user" || d.page === false) {
    return new NoSource(`${name} was not asked of the user on the page: only the user's own answer there gives a standing approval; ask them with a decision that names the rule`);
  }

  const chat = readChat(resolvePath(dir));
  let m: Message | undefined;

  if (question !== undefined) {
    const q = (d.questions ?? []).find((x) => x.id === question);

    if (q === undefined) return new NoSource(`${name} has no question ${question.toUpperCase()}`);
    label = `${label}:${question.toUpperCase()}`;

    if (q.status !== "answered") {
      return new NoSource(`${label} is ${q.status}${q.status === "open" ? ", not answered yet" : ""}: a standing approval comes from a question the user answered yes or approve`);
    }

    if (!approves(q)) return new NoSource(`${label} was answered ${q.answer === undefined || q.answer === null ? "None" : pyStr(q.answer)}: ${ASK_AGAIN}`);
    const said = userAnswerTo(chat, d, question, q.asked, q.asked_after);

    if (said === undefined) {
      const since = q.asked === undefined || q.asked === null ? "" : ` since it was last asked (${q.asked})`;

      return new NoSource(`${label} has no answer from the user in the chat${since}: only the user's own answer on the page gives a standing approval`);
    }

    const plain = plainAnswer(said.words, q.options ?? [], q.recommend);

    if (plain === undefined || !plainYes(plain.words)) {
      return new NoSource(`${label}: the user's own answer in the chat (#${String(said.message.id)}) is ${pyStr(said.words)}, not a plain yes: ${ASK_AGAIN}`);
    }

    m = said.message;
  } else {
    m = chat.filter((x) => x.decision === d.id && x.from === "user").at(-1);

    if (m === undefined) return new NoSource(`${name} has no answer from the user in the chat: only the user's own answer on the page gives a standing approval`);
    const options = d.options ?? [];
    const decided = plainAnswer(d.answer ?? "", options);

    if (decided === undefined || (options.length > 0 && decided.option === undefined) || !plainYes(decided.words)) {
      return new NoSource(`${name} was decided ${d.answer === undefined || d.answer === null ? "None" : pyStr(d.answer)}, not a plain yes: ${ASK_AGAIN}`);
    }

    const picked = plainAnswer(m.text, options);

    if (picked === undefined || picked.option !== decided.option || !plainYes(picked.words)) {
      return new NoSource(`${name}: the user's own answer in the chat (#${String(m.id)}) is ${pyStr(m.text)}, not a plain yes: ${ASK_AGAIN}`);
    }
  }

  const author = asString(m.author);

  return {
    ref: where === undefined ? d.id : `${where.id}/${num}`,
    question,
    message: m.id,
    author: author === undefined || author === "" ? undefined : author,
    label,
    decision: where === undefined ? d.id : undefined,
    id: d.id,
    dir,
  };
}

/** Whether approval `a` comes from `ref` (FLEET/DECISION) and `question`; `local`, in the source fleet's own
 * ledger, is the decision's id there, which an approval added without FLEET/ names. */
export function sameSource(a: Approval, ref: string, question: string | undefined, local?: string): boolean {
  return (a.ref === ref || (local !== undefined && a.ref === local)) && a.question === question;
}
