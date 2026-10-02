/**
 * What the user did on the other fleets' pages, for a manager's watch (`watch --as manager --fleets`):
 * each message from the user (an answer to a decision or not), each decision opened for the user, and each
 * one decided, withdrawn or held. Python's `chat.FleetNews`, line for line.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";

import { Refusal } from "../errors.ts";
import { readText, writeText } from "../files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseJson, pyRepr, truthy, type Json, type JsonObject, type JsonOut } from "../json.ts";
import { decodeLedger } from "../ledger/model.ts";
import { number } from "../ledger/numbers.ts";
import type { Machine } from "../world.ts";
import { fromManager, oneLine, pyText, stateOfDir } from "./chat.ts";
import { Tail } from "./store.ts";

const BREAKS = new Set(["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", " ", " "]);

/** Characters of a message's first line a fleet's news line carries. */
export const FIRST_LINE_MAX = 200;

function trimSpaces(text: string): string {
  return text.replace(/^ +| +$/g, "");
}

/** The first line of `value` that has text, as one printed line of at most {@link FIRST_LINE_MAX}
 * characters, with ` …` when there is more. */
export function firstLine(value: Json | undefined): string {
  const chars = [...pyText(value)];
  let start = 0;

  while (start < chars.length && (chars[start] === " " || chars[start] === "\t" || BREAKS.has(chars[start] ?? ""))) start += 1;
  let cut = start;

  while (cut < chars.length && !BREAKS.has(chars[cut] ?? "")) cut += 1;
  let line = [...trimSpaces(oneLine(chars.slice(start, cut).join("")))];
  let more = chars.slice(cut).some((c) => !BREAKS.has(c) && c !== " " && c !== "\t");

  if (line.length > FIRST_LINE_MAX) {
    line = [...line.slice(0, FIRST_LINE_MAX).join("").replace(/ +$/, "")];
    more = true;
  }

  return line.join("") + (more ? " …" : "");
}

/** Where a decision stands, as the manager's watch compares it: `open:<who looks first>`, `held`, or its status. */
function markOf(d: JsonObject): string {
  if (d["status"] === "open") return truthy(d["held"]) ? "held" : `open:${truthy(d["asks"]) ? pyText(d["asks"]) : "user"}`;

  return pyText(d["status"]);
}

function refOf(d: JsonObject): string {
  return truthy(d["ref"]) ? pyText(d["ref"]) : pyText(d["id"]);
}

/** The line for a decision of `fleet` that now stands at `mark`, or undefined when that is not news. */
function newsOf(fleet: string, d: JsonObject, mark: string): string | undefined {
  const head = `${fleet} ${refOf(d)}`;
  const title = oneLine(d["title"]);

  if (mark === "open:user") return `${head} opened for you: ${title}` + (d["blocking"] === true ? " (blocks work)" : "");
  let said: string;

  if (mark === "held") said = asString(d["held"]) === undefined ? "" : firstLine(d["held"]);
  else if (mark === "decided") said = firstLine(truthy(d["answer"]) ? d["answer"] : truthy(d["resolution"]) ? d["resolution"] : "");
  else if (mark === "withdrawn") said = firstLine(truthy(d["resolution"]) ? d["resolution"] : "");
  else return undefined;

  return `${head} ${mark}: ${title}` + (said === "" ? "" : `: ${said}`);
}

/** A fleet's cursor: the last message id read and where each decision stood. */
interface Seen {
  readonly fleet: string;
  readonly dir: string;
  readonly chat: number;
  readonly decisions: ReadonlyMap<string, string>;
}

function seenOf(row: Json): Seen | undefined {
  const o = asObject(row);
  const dir = asString(o?.["dir"]);
  const chat = asNumber(o?.["chat"]);
  const marks = asObject(o?.["decisions"]);

  if (o === undefined || dir === undefined || chat === undefined || !Number.isInteger(chat) || marks === undefined) return undefined;

  return {
    fleet: pyText(o["fleet"]),
    dir,
    chat,
    decisions: new Map(Object.entries(marks).map(([id, mark]) => [id, pyText(mark)])),
  };
}

/** The decisions of a ledger as JSON rows, with the numbers the next write gives them. */
function numberedRows(state: JsonObject): JsonObject[] {
  const rows = (asArray(state["decisions"]) ?? []).flatMap((r) => {
    const o = asObject(r);

    return o !== undefined && asString(o["id"]) !== undefined ? [o] : [];
  });

  const ledger = decodeLedger(state);

  if (ledger instanceof Refusal) return rows;
  number(ledger);
  const refs = new Map((ledger.decisions ?? []).map((d) => [d.id, d.ref ?? null]));

  return rows.map((d): JsonObject => ({ ...d, ref: truthy(d["ref"]) ? (d["ref"] ?? null) : (refs.get(pyText(d["id"])) ?? null) }));
}

/**
 * The other fleets' news, read again at each poll. Cursors are per fleet, kept by its directory (a fleet
 * keeps them through a rename) in DIR/watch-manager.fleets.json. A fleet seen for the first time is read from
 * then on; with `resume` the cursors of the last watch are taken up, so nothing is missed or told twice.
 */
export class FleetNews {
  private readonly path: string;
  private readonly seen = new Map<string, Seen>();
  private readonly tails = new Map<string, Tail>();
  private readonly states = new Map<string, { readonly key: string; readonly rows: JsonObject[] }>();
  private saved: string | undefined;
  private readonly machine: Machine;
  private readonly me: string;

  constructor(machine: Machine, me: string, resume: boolean) {
    this.machine = machine;
    this.me = me;
    this.path = join(me, "watch-manager.fleets.json");

    if (!resume) return;
    const text = readText(this.path);
    const rows = text === undefined ? undefined : Option.getOrUndefined(parseJson(text));

    for (const row of asArray(rows) ?? []) {
      const s = seenOf(row);

      if (s !== undefined) this.seen.set(s.dir, s);
    }
  }

  private decisions(root: string): JsonObject[] {
    let key = "";

    try {
      const st = statSync(join(root, "state.json"));
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      key = "";
    }

    const held = this.states.get(root);

    if (held !== undefined && held.key === key) return held.rows;
    const rows = numberedRows(stateOfDir(root));
    this.states.set(root, { key, rows });

    return rows;
  }

  /** The news since the last read, one line each, fleet by fleet (messages, then decisions). */
  read(): string[] {
    const lines: string[] = [];

    for (const e of this.machine.registry.live()) {
      const root = e.dir;

      if (e.role === "manager" || root === this.me) continue;
      const rows = this.decisions(root);
      const before = this.seen.get(root);
      let tail = this.tails.get(root);

      if (tail === undefined) {
        tail = new Tail(root, before?.chat ?? 0);
        this.tails.set(root, tail);
      }

      const said = tail.read();
      const last = said.reduce((max, m) => Math.max(max, m.id), before?.chat ?? 0);
      const marks = new Map(rows.map((d) => [pyText(d["id"]), markOf(d)]));
      this.seen.set(root, { fleet: e.id, dir: root, chat: last, decisions: marks });

      if (before === undefined) continue;

      for (const m of said) {
        // A message the hub delivered from the manager's page is the manager's own news.
        if (m.from !== "user" || fromManager(m)) continue;

        if (truthy(m.decision)) {
          const key = pyRepr(m.decision);
          const d = rows.find((r) => pyRepr(r["id"]) === key) ?? rows.find((r) => truthy(r["ref"]) && pyRepr(r["ref"]) === key);
          const what = d === undefined ? oneLine(m.decision) : `${refOf(d)} ${oneLine(d["title"])}`;
          lines.push(`${e.id}: you answered ${what}: ${firstLine(m.text)}`);
        } else {
          lines.push(`${e.id}: you wrote to ${oneLine(m.to.join(", "))}: ${firstLine(m.text)}`);
        }
      }

      for (const d of rows) {
        const id = pyText(d["id"]);
        const mark = marks.get(id) ?? "";

        if (before.decisions.get(id) === mark) continue;
        const line = newsOf(e.id, d, mark);

        if (line !== undefined) lines.push(line);
      }
    }

    return lines;
  }

  /** Keeps the cursors in DIR/watch-manager.fleets.json when they changed. */
  save(): void {
    const rows: JsonOut[] = [...this.seen.values()].map((s) => ({
      fleet: s.fleet,
      dir: s.dir,
      chat: s.chat,
      decisions: Object.fromEntries(s.decisions),
    }));

    const text = dumps(rows);

    if (text === this.saved) return;
    writeText(this.path, `${text}\n`);
    this.saved = text;
  }
}
