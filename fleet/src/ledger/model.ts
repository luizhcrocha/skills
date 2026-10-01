/**
 * The ledger (DIR/state.json) as typed rows: decoded from the JSON a Python or TypeScript writer left,
 * and encoded back with the keys it had, in the order it had them, new keys after (as Python's dicts
 * keep insertion order). Keys this model does not know are kept as they were. Decoding refuses only
 * what the rows cannot hold (a missing required key, a value of the wrong JSON type); everything else a
 * row may get wrong (an unknown status, a duplicate id) is the final check's ({@link ./validate.ts}).
 */
import * as Option from "effect/Option";

import { invalid, type Refusal } from "../errors.ts";
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  dumps,
  parseObject,
  pyRepr,
  type Json,
  type JsonObject,
  type JsonOut,
} from "../json.ts";

/** A step of a milestone. */
export interface Step {
  id: string;
  title: string;
  status: string;
  agent?: string | null;
}

/** A milestone of the roadmap, with its steps in the order of their turn. */
export interface Milestone {
  id: string;
  title: string;
  steps: Step[];
}

/** A worker row. */
export interface Agent {
  id: string;
  name: string;
  task: string;
  skill?: string;
  model?: string;
  status: string;
  lane: string[];
  milestone: string;
  tokens?: number;
  duration_ms?: number;
  rounds?: number;
  started?: string;
  updated?: string;
  brief?: string;
  report?: string;
  task_id?: string;
  measured?: string | number;
}

/** Something a worker or the fleet waits on. */
export interface Roadblock {
  id: string;
  title: string;
  detail?: string | null;
  agent?: string | null;
  severity: string;
  needs: string;
  decision?: string | null;
  since: string;
  resolved: boolean;
  ref?: string;
}

/** One option of a choice. */
export interface Choice {
  id: string;
  label: string;
  consequence: string;
}

/** One question of a grilling. */
export interface Question {
  id: string;
  title: string;
  body?: string | null;
  recommend?: string | null;
  reason?: string | null;
  of?: string | null;
  status: string;
  answer?: string | null;
  asked?: string | null;
  answered?: string | null;
  dropped?: string | null;
}

/** A decision, input, secret, action or grilling: what waits on the user (or the manager). */
export interface Decision {
  id: string;
  kind: string;
  title: string;
  question: string;
  why?: string | null;
  blocking?: boolean;
  agent?: string | null;
  options?: Choice[];
  recommend?: string | null;
  reason?: string | null;
  secret?: string | null;
  manual?: string | null;
  body?: boolean;
  page?: boolean;
  supersedes?: string | null;
  status: string;
  answer?: string | null;
  resolution?: string | null;
  change?: string | null;
  asks?: string;
  opened: string;
  revised?: string | null;
  closed?: string | null;
  questions?: Question[];
  step?: string | null;
  milestone?: string | null;
  ref?: string;
}

/** One entry of the append-only event log. */
export interface LedgerEvent {
  at: string;
  agent?: string | null;
  kind: string;
  text: string;
  important?: boolean;
  decision?: string | null;
}

/** A dev server or a purpose-built page the user opens. */
export interface Link {
  id: string;
  url: string;
  title: string;
  kind: string;
  decision?: string | null;
  agent?: string | null;
  note?: string | null;
  since?: string;
  ref?: string;
}

/** What must outlive a compaction. */
export interface Kept {
  id: string;
  text: string;
  at: string;
}

/** The whole ledger. */
export interface Ledger {
  role?: string;
  project: string;
  goal: string;
  status: string;
  now: string;
  now_at?: string | null;
  started: string;
  updated?: string;
  roadmap: Milestone[];
  agents: Agent[];
  roadblocks: Roadblock[];
  decisions?: Decision[];
  events: LedgerEvent[];
  links?: Link[];
  kept?: Kept[];
}

/** The keys a row came with, in their order, and the ones this model does not know. */
interface Origin {
  readonly order: string[];
  readonly unknown: Map<string, Json>;
}

/** Any row of the ledger, the ledger included. */
export type Row = Step | Milestone | Agent | Roadblock | Choice | Question | Decision | LedgerEvent | Link | Kept | Ledger;

const origins = new WeakMap<Row, Origin>();

/** Forget that `row` had `key`: set again later, it goes last, as a Python dict puts a popped key. */
export function dropKey(row: Row, key: string): void {
  const origin = origins.get(row);

  if (origin === undefined) return;
  const at = origin.order.indexOf(key);

  if (at >= 0) origin.order.splice(at, 1);
}

// -- decoding -------------------------------------------------------------------------------------

/** Reads one JSON object into a row, keeping the first fault it finds. */
class Fields {
  fault: string | undefined;
  readonly object: JsonObject;
  readonly label: string;

  constructor(object: JsonObject, label: string) {
    this.object = object;
    this.label = label;
  }

  private wrong(key: string, what: string): void {
    this.fault ??= `${this.label}: '${key}' should be ${what}, got ${pyRepr(this.object[key])}`;
  }

  private missing(key: string, message: string | undefined): void {
    this.fault ??= message ?? `${this.label} is missing '${key}'`;
  }

  str(key: string, message?: string): string {
    const value = this.object[key];

    if (value === undefined) {
      this.missing(key, message);

      return "";
    }

    const text = asString(value);

    if (text === undefined) this.wrong(key, "a string");

    return text ?? "";
  }

  optStr(key: string): string | undefined {
    const value = this.object[key];

    if (value === undefined) return undefined;
    const text = asString(value);

    if (text === undefined) this.wrong(key, "a string");

    return text;
  }

  nullStr(key: string): string | null | undefined {
    const value = this.object[key];

    if (value === undefined || value === null) return value;
    const text = asString(value);

    if (text === undefined) this.wrong(key, "a string or null");

    return text ?? null;
  }

  bool(key: string, message?: string): boolean {
    const value = this.object[key];

    if (value === undefined) {
      this.missing(key, message);

      return false;
    }

    const flag = asBoolean(value);

    if (flag === undefined) this.wrong(key, "true or false");

    return flag ?? false;
  }

  optBool(key: string): boolean | undefined {
    const value = this.object[key];

    if (value === undefined) return undefined;
    const flag = asBoolean(value);

    if (flag === undefined) this.wrong(key, "true or false");

    return flag;
  }

  optNumber(key: string): number | undefined {
    const value = this.object[key];

    if (value === undefined) return undefined;
    const number = asNumber(value);

    if (number === undefined) this.wrong(key, "a number");

    return number;
  }

  strList(key: string, message?: string): string[] {
    const value = this.object[key];

    if (value === undefined) {
      this.missing(key, message);

      return [];
    }

    const items = asArray(value) ?? [];

    const texts = items.flatMap((item) => {
      const text = asString(item);

      return text === undefined ? [] : [text];
    });

    if (asArray(value) === undefined || texts.length !== items.length) this.wrong(key, "a list of strings");

    return texts;
  }

  rows<T>(key: string, read: (object: JsonObject, at: number) => Fields | T, message?: string): T[] | undefined {
    const value = this.object[key];

    if (value === undefined) {
      if (message !== undefined) this.missing(key, message);

      return undefined;
    }

    const items = asArray(value);

    if (items === undefined) {
      this.fault ??= message === undefined ? `'${key}' should be list` : `'${key}' should be list`;

      return undefined;
    }

    const out: T[] = [];
    items.forEach((item, at) => {
      const object = asObject(item);

      if (object === undefined) {
        this.fault ??= `${this.label}: '${key}' holds ${pyRepr(item)}, not an object`;

        return;
      }

      const row = read(object, at);

      if (row instanceof Fields) this.fault ??= row.fault;
      else out.push(row);
    });

    return out;
  }

  /** `row`, with where its keys came from remembered; or this reader when it found a fault. */
  done<T extends Row>(row: T, known: readonly string[]): Fields | T {
    if (this.fault !== undefined) return this;
    const unknown = new Map<string, Json>();

    for (const [key, value] of Object.entries(this.object)) {
      if (!known.includes(key)) unknown.set(key, value);
    }

    origins.set(row, { order: Object.keys(this.object), unknown });

    return row;
  }
}

/** Assign the optional fields that are present; absent ones stay absent. */
function present<T extends object>(row: T, fields: { readonly [K in keyof T]?: T[K] | undefined }): T {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) Object.assign(row, { [key]: value });
  }

  return row;
}

const STEP_KEYS = ["id", "title", "status", "agent"] as const;

function readStep(object: JsonObject): Fields | Step {
  const f = new Fields(object, "step");
  const id = asString(object["id"]) ?? "?";

  const row: Step = {
    id: f.str("id", `step ${id} is missing 'id'`),
    title: f.str("title", `step ${id} is missing 'title'`),
    status: f.str("status", `step ${id} status not in ['blocked', 'current', 'done', 'pending']`),
  };

  return f.done(present(row, { agent: f.nullStr("agent") }), STEP_KEYS);
}

const MILESTONE_KEYS = ["id", "title", "steps"] as const;

function readMilestone(object: JsonObject): Fields | Milestone {
  const id = asString(object["id"]) ?? "?";
  const f = new Fields(object, `milestone ${id}`);

  const row: Milestone = {
    id: f.str("id"),
    title: f.str("title"),
    steps: f.rows("steps", readStep, `milestone ${id} is missing 'steps'`) ?? [],
  };

  return f.done(row, MILESTONE_KEYS);
}

/** The keys of a worker row, in the order a new row has them. */
export const AGENT_KEYS = [
  "id",
  "name",
  "task",
  "skill",
  "model",
  "status",
  "lane",
  "milestone",
  "tokens",
  "duration_ms",
  "rounds",
  "started",
  "updated",
  "brief",
  "report",
  "task_id",
  "measured",
] as const;

function readMeasured(f: Fields, object: JsonObject): string | number | undefined {
  const value = object["measured"];

  if (value === undefined) return undefined;
  const text = asString(value);

  if (text !== undefined) return text;

  return f.optNumber("measured");
}

function readAgent(object: JsonObject): Fields | Agent {
  const id = asString(object["id"]) ?? "?";
  const f = new Fields(object, `agent ${id}`);
  const missing = (key: string): string => `agent ${id} is missing '${key}'`;

  const row: Agent = {
    id: f.str("id", missing("id")),
    name: f.str("name", missing("name")),
    task: f.str("task", missing("task")),
    status: f.str("status", missing("status")),
    lane: f.strList("lane", missing("lane")),
    milestone: f.str("milestone", missing("milestone")),
  };

  present(row, {
    skill: f.optStr("skill"),
    model: f.optStr("model"),
    tokens: f.optNumber("tokens"),
    duration_ms: f.optNumber("duration_ms"),
    rounds: f.optNumber("rounds"),
    started: f.optStr("started"),
    updated: f.optStr("updated"),
    brief: f.optStr("brief"),
    report: f.optStr("report"),
    task_id: f.optStr("task_id"),
    measured: readMeasured(f, object),
  });

  return f.done(row, AGENT_KEYS);
}

/** The keys of a roadblock, in the order a new one has them. */
export const ROADBLOCK_KEYS = [
  "id",
  "title",
  "detail",
  "agent",
  "severity",
  "needs",
  "decision",
  "since",
  "resolved",
  "ref",
] as const;

function readRoadblock(object: JsonObject): Fields | Roadblock {
  const id = asString(object["id"]) ?? "?";
  const f = new Fields(object, `roadblock ${id}`);

  const row: Roadblock = {
    id: f.str("id"),
    title: f.str("title"),
    severity: f.str("severity"),
    needs: f.str("needs"),
    since: f.str("since"),
    resolved: f.bool("resolved"),
  };

  present(row, {
    detail: f.nullStr("detail"),
    agent: f.nullStr("agent"),
    decision: f.nullStr("decision"),
    ref: f.optStr("ref"),
  });

  return f.done(row, ROADBLOCK_KEYS);
}

const CHOICE_KEYS = ["id", "label", "consequence"] as const;

function readChoice(decision: string): (object: JsonObject) => Fields | Choice {
  return (object) => {
    const f = new Fields(object, `decision ${decision}`);
    const message = `decision ${decision} has an option without id, label and consequence`;

    const row: Choice = {
      id: f.str("id", message),
      label: f.str("label", message),
      consequence: f.str("consequence", message),
    };

    if (f.fault !== undefined) f.fault = message;

    return f.done(row, CHOICE_KEYS);
  };
}

/** The keys of a grilling's question, in the order a new one has them. */
export const QUESTION_KEYS = [
  "id",
  "title",
  "body",
  "recommend",
  "reason",
  "of",
  "status",
  "answer",
  "asked",
  "answered",
  "dropped",
] as const;

function readQuestion(decision: string): (object: JsonObject) => Fields | Question {
  return (object) => {
    const f = new Fields(object, `grilling ${decision}`);
    const row: Question = { id: f.str("id"), title: f.str("title"), status: f.str("status") };

    if (f.fault !== undefined) {
      f.fault = `grilling ${decision} has a question without id, title, or a status in ['open', 'answered', 'dropped']`;
    }

    present(row, {
      body: f.nullStr("body"),
      recommend: f.nullStr("recommend"),
      reason: f.nullStr("reason"),
      of: f.nullStr("of"),
      answer: f.nullStr("answer"),
      asked: f.nullStr("asked"),
      answered: f.nullStr("answered"),
      dropped: f.nullStr("dropped"),
    });

    return f.done(row, QUESTION_KEYS);
  };
}

/** The keys of a decision, in the order a new one has them. */
export const DECISION_KEYS = [
  "id",
  "kind",
  "title",
  "question",
  "why",
  "blocking",
  "agent",
  "options",
  "recommend",
  "reason",
  "secret",
  "manual",
  "body",
  "page",
  "supersedes",
  "status",
  "answer",
  "resolution",
  "change",
  "asks",
  "opened",
  "revised",
  "closed",
  "step",
  "milestone",
  "ref",
  "questions",
] as const;

function readDecision(object: JsonObject): Fields | Decision {
  const id = asString(object["id"]) ?? "?";
  const f = new Fields(object, `decision ${id}`);
  const missing = (key: string): string => `decision ${id} is missing '${key}'`;

  const row: Decision = {
    id: f.str("id", missing("id")),
    kind: f.str("kind", missing("kind")),
    title: f.str("title", missing("title")),
    question: f.str("question", missing("question")),
    status: f.str("status", missing("status")),
    opened: f.str("opened", missing("opened")),
  };

  present(row, {
    why: f.nullStr("why"),
    blocking: f.optBool("blocking"),
    agent: f.nullStr("agent"),
    options: f.rows("options", readChoice(id)),
    recommend: f.nullStr("recommend"),
    reason: f.nullStr("reason"),
    secret: f.nullStr("secret"),
    manual: f.nullStr("manual"),
    body: f.optBool("body"),
    page: f.optBool("page"),
    supersedes: f.nullStr("supersedes"),
    answer: f.nullStr("answer"),
    resolution: f.nullStr("resolution"),
    change: f.nullStr("change"),
    asks: f.optStr("asks"),
    revised: f.nullStr("revised"),
    closed: f.nullStr("closed"),
    questions: f.rows("questions", readQuestion(id)),
    step: f.nullStr("step"),
    milestone: f.nullStr("milestone"),
    ref: f.optStr("ref"),
  });

  return f.done(row, DECISION_KEYS);
}

const EVENT_KEYS = ["at", "agent", "kind", "text", "important", "decision"] as const;

function readEvent(object: JsonObject): Fields | LedgerEvent {
  const f = new Fields(object, "event");
  const missing = (key: string): string => `event is missing '${key}': ${pyRepr(object)}`;

  const row: LedgerEvent = {
    at: f.str("at", missing("at")),
    kind: f.str("kind", missing("kind")),
    text: f.str("text", missing("text")),
  };

  present(row, { agent: f.nullStr("agent"), important: f.optBool("important"), decision: f.nullStr("decision") });

  return f.done(row, EVENT_KEYS);
}

/** The keys of a link, in the order a new one has them. */
export const LINK_KEYS = ["id", "url", "title", "kind", "decision", "agent", "note", "since", "ref"] as const;

function readLink(object: JsonObject): Fields | Link {
  const f = new Fields(object, `link ${asString(object["id"]) ?? "?"}`);
  const row: Link = { id: f.str("id"), url: f.str("url"), title: f.str("title"), kind: f.str("kind") };
  present(row, {
    decision: f.nullStr("decision"),
    agent: f.nullStr("agent"),
    note: f.nullStr("note"),
    since: f.optStr("since"),
    ref: f.optStr("ref"),
  });

  return f.done(row, LINK_KEYS);
}

const KEPT_KEYS = ["id", "text", "at"] as const;

function readKept(object: JsonObject): Fields | Kept {
  const f = new Fields(object, `kept ${asString(object["id"]) ?? "?"}`);

  return f.done({ id: f.str("id"), text: f.str("text"), at: f.str("at") }, KEPT_KEYS);
}

/** The keys of a ledger, in the order a new one has them. */
export const LEDGER_KEYS = [
  "role",
  "project",
  "goal",
  "status",
  "now",
  "now_at",
  "started",
  "updated",
  "roadmap",
  "agents",
  "roadblocks",
  "decisions",
  "events",
  "links",
  "kept",
] as const;

const REQUIRED: ReadonlyArray<readonly [string, "str" | "list"]> = [
  ["project", "str"],
  ["goal", "str"],
  ["status", "str"],
  ["now", "str"],
  ["started", "str"],
  ["roadmap", "list"],
  ["agents", "list"],
  ["roadblocks", "list"],
  ["events", "list"],
];

/** The ledger a JSON object holds, or the first fault in it, worded as the final check words it. */
export function decodeLedger(object: JsonObject): Ledger | Refusal {
  for (const [key, kind] of REQUIRED) {
    const value = object[key];

    if (value === undefined) return invalid(`state is missing '${key}'`);
    const ok = kind === "str" ? asString(value) !== undefined : asArray(value) !== undefined;

    if (!ok) return invalid(`'${key}' should be ${kind}`);
  }

  const f = new Fields(object, "state");

  const row: Ledger = {
    project: f.str("project"),
    goal: f.str("goal"),
    status: f.str("status"),
    now: f.str("now"),
    started: f.str("started"),
    roadmap: f.rows("roadmap", readMilestone) ?? [],
    agents: f.rows("agents", readAgent) ?? [],
    roadblocks: f.rows("roadblocks", readRoadblock) ?? [],
    events: f.rows("events", readEvent) ?? [],
  };

  present(row, {
    role: f.optStr("role"),
    now_at: f.nullStr("now_at"),
    updated: f.optStr("updated"),
    decisions: f.rows("decisions", readDecision),
    links: f.rows("links", readLink),
    kept: f.rows("kept", readKept),
  });
  const done = f.done(row, LEDGER_KEYS);

  return done instanceof Fields ? invalid(done.fault ?? "state.json is not a ledger") : done;
}

/** The ledger `text` holds: none when it is not a JSON object, else the ledger or its first fault. */
export function parseLedger(text: string): Option.Option<Ledger | Refusal> {
  return Option.map(parseObject(text), decodeLedger);
}

// -- encoding -------------------------------------------------------------------------------------

/** A row as the JSON object it is written as. */
interface Encoded {
  [key: string]: JsonOut | undefined;
}

/** `fields` as one JSON object: the row's keys in the order it came with, then the keys it got since in
 * the order it got them (as a Python dict orders them), then the keys this model does not know. */
function encodeRow(row: Row, fields: Encoded): Encoded {
  const origin = origins.get(row);
  const out: Encoded = {};

  for (const key of [...(origin?.order ?? []), ...Object.keys(fields)]) {
    if (key in out) continue;
    const value = fields[key];

    if (value !== undefined) out[key] = value;
    else if (origin?.unknown.has(key) === true) out[key] = origin.unknown.get(key) ?? null;
  }

  for (const [key, value] of origin?.unknown ?? []) {
    if (!(key in out)) out[key] = value;
  }

  return out;
}

function encodeStep(step: Step): Encoded {
  return encodeRow(step, { ...step });
}

function encodeMilestone(m: Milestone): Encoded {
  return encodeRow(m, { id: m.id, title: m.title, steps: m.steps.map(encodeStep) });
}

function encodeDecision(d: Decision): Encoded {
  return encodeRow(
    d,
    {
      ...d,
      options: d.options?.map((o) => encodeRow(o, { ...o })),
      questions: d.questions?.map((q) => encodeRow(q, { ...q })),
    },
  );
}

/** The ledger as the JSON object state.json holds. */
export function encodeLedger(ledger: Ledger): Encoded {
  return encodeRow(
    ledger,
    {
      ...ledger,
      roadmap: ledger.roadmap.map(encodeMilestone),
      agents: ledger.agents.map((a) => encodeRow(a, { ...a, lane: [...a.lane] })),
      roadblocks: ledger.roadblocks.map((r) => encodeRow(r, { ...r })),
      decisions: ledger.decisions?.map(encodeDecision),
      events: ledger.events.map((e) => encodeRow(e, { ...e })),
      links: ledger.links?.map((l) => encodeRow(l, { ...l })),
      kept: ledger.kept?.map((k) => encodeRow(k, { ...k })),
    },
  );
}

/** The ledger as state.json's text: two-space indent, UTF-8 unescaped, a final newline. */
export function ledgerText(ledger: Ledger): string {
  return `${dumps(encodeLedger(ledger), { indent: 2, ensureAscii: false })}\n`;
}

/** A deep copy of the ledger, with where its keys came from. */
export function copyLedger(ledger: Ledger): Ledger {
  const copy = parseLedger(ledgerText(ledger));

  // SAFETY: a ledger encoded by ledgerText decodes again: every row it writes is one decodeLedger reads.
  return Option.getOrThrow(copy) as Ledger;
}
