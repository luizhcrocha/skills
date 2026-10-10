/**
 * Where a standing approval comes from (Python's `decisions.approval_source`): a decided choice, input or
 * grilling the user answered on the page, in this fleet's ledger or, as `FLEET/DECISION`, in a served fleet's,
 * found through the registry; a grilling's by one question (`:Q<n>`) answered yes or approve. The same check
 * backs `fleet state DIR approval add` and `fleet fleets approval add`.
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { readChat } from "../chat/store.ts";
import { Refusal } from "../errors.ts";
import { isDir, listDir, readText, resolvePath } from "../files.ts";
import { asArray, asObject, asString, parseJson, pyStr, type JsonObject } from "../json.ts";
import { alive, pidOf } from "../registry.ts";
import type { Machine } from "../world.ts";
import { parseLedger, type Approval, type Ledger, type Question } from "./model.ts";
import { findDecision } from "./numbers.ts";
import { CHOICE_KINDS } from "./validate.ts";

/** `[FLEET/]DECISION[:Q<n>]`: a decision of this fleet, or of FLEET, and a grilling's question. */
export const SOURCE = /^(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)(?::[Qq]([0-9]+))?$/u;

/** The first word of a grilling question's answer that gives a standing approval. */
const APPROVES = ["yes", "approve", "approved"] as const;

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

/** The registry's live entry for the fleet called `name` (its id, else one of its aliases), read without
 * touching the registry; undefined when no fleet of that name is served. */
export function servedFleet(machine: Machine, name: string): ServedFleet | undefined {
  const home = machine.registry.place.home;
  const entries: JsonObject[] = [];

  for (const file of listDir(home).filter((n) => n.endsWith(".json")).sort()) {
    const path = join(home, file);

    if (isDir(path)) continue;
    const entry = asObject(Option.getOrUndefined(parseJson(readText(path) ?? "")));

    if (entry !== undefined && asString(entry["id"]) !== undefined && asString(entry["dir"]) !== undefined && alive(pidOf(entry["pid"]))) entries.push(entry);
  }

  const found = entries.find((e) => e["id"] === name) ?? entries.find((e) => (asArray(e["aliases"]) ?? []).some((a) => a === name));

  return found === undefined ? undefined : { id: asString(found["id"]) ?? "", dir: asString(found["dir"]) ?? "" };
}

/** Whether a grilling question was answered yes or approve: its answer's first word, after an option's key
 * (`(a)`, `a:`) is read as that option's label and "as recommended" as its recommendation. */
export function approves(q: Question): boolean {
  let text = (q.answer ?? "").trim();

  if (text.toLowerCase().startsWith("as recommended")) text = q.recommend ?? "";
  const head = /^\(?([A-Za-z0-9]+)\)?:?(?=\s|$)/u.exec(text);
  const key = head?.[1]?.toLowerCase();
  const option = key === undefined ? undefined : (q.options ?? []).find((o) => o.id.toLowerCase() === key);

  if (option !== undefined) text = option.label;
  const word = /^[^A-Za-z]*([A-Za-z]+)/u.exec(text)?.[1]?.toLowerCase();

  return word !== undefined && APPROVES.some((w) => w === word);
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

/** Where `approval add --ref TEXT` comes from, checked as a standing approval needs it: a decided choice,
 * input or grilling asked of the user on the page, with the user's message tagged with it in that fleet's chat
 * (the hub's: only it writes as the user). The row's fields, or why not. */
export function approvalSource(machine: Machine, root: string, here: Ledger | undefined, text: string): Source | NoSource {
  const parsed = parseSource(text);

  if (parsed === undefined) return new NoSource(`--ref reads [FLEET/]DECISION[:Q<n>] (D7, manager/G5:Q1), got ${pyStr(text)}`);
  const { fleet, key, question } = parsed;
  let ledger = here;
  let dir = root;
  let where: ServedFleet | undefined;

  if (fleet !== undefined) {
    where = servedFleet(machine, fleet);

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

  if (d.status !== "decided") return new NoSource(`${name} is ${d.status}: a standing approval comes from a decision the user decided`);

  if (!CHOICE_KINDS.some((k) => k === d.kind) || (d.asks ?? "user") !== "user" || d.page === false) {
    return new NoSource(`${name} was not asked of the user on the page: only the user's own answer there gives a standing approval; ask them with a decision that names the rule`);
  }

  if (question !== undefined) {
    const q = (d.questions ?? []).find((x) => x.id === question);

    if (q === undefined) return new NoSource(`${name} has no question ${question.toUpperCase()}`);
    label = `${label}:${question.toUpperCase()}`;

    if (q.status !== "answered") return new NoSource(`${label} is ${q.status}: a standing approval comes from a question the user answered yes or approve`);

    if (!approves(q)) {
      return new NoSource(`${label} was answered ${q.answer === undefined || q.answer === null ? "None" : pyStr(q.answer)}: a standing approval comes from a question answered yes or approve; ask it again, one rule to a question`);
    }
  }

  const m = readChat(resolvePath(dir))
    .filter((x) => x.decision === d.id && x.from === "user")
    .at(-1);

  if (m === undefined) return new NoSource(`${name} has no answer from the user in the chat: only the user's own answer on the page gives a standing approval`);
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
