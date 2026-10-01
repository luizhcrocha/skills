/**
 * The state as the page shows it (Python's `fleets.view`): the ledger with its numbers, what its
 * session spent, whether its host reads the chat, when each worker last wrote, its links up or down,
 * and what the machine serves that no link names. A manager's carries every coordinator being served
 * (`summary`), the plan's usage and the gate; a coordinator's, how to reach its manager. The ledger
 * itself is left as it is. Key order is Python's, so the page's payload is byte for byte the same.
 */
import { join } from "node:path";

import { readChat } from "../chat/store.ts";
import { listening } from "../chat/chat.ts";
import { resolvePath } from "../files.ts";
import { answeredAt, isoOf, silentWorkers } from "../health.ts";
import { asArray, asNumber, asObject, asString, truthy, type Json, type JsonObject } from "../json.ts";
import { readObject, type Entry } from "../registry.ts";
import { activeAt, lastActivity, SpendReader, type Spent } from "../transcripts.ts";
import { readUsage } from "../usage.ts";
import type { Machine } from "../world.ts";
import { numberState, pyStr } from "./number.ts";
import { splitUrl } from "./url.ts";

/** A port the machine serves that is no fleet's dashboard (Python's `served.discovered`). */
export interface Found {
  readonly port: number;
  readonly url: string;
  readonly target: string;
  readonly pid: number | null;
  readonly cwd: string;
  readonly command: string;
  readonly fleet: string | null;
  readonly up: boolean;
}

/** What the view reads beyond the files: link probes, the machine's served ports, spend. The CLI
 * renders with one look at each; the hub keeps them warm between looks. */
export interface Lookups {
  /** Whether each address is answered on this machine. */
  readonly up: (urls: readonly string[]) => boolean[];
  /** The served ports, as last looked at. */
  readonly discovered: () => readonly Found[];
  /** What the session that owns a DIR spent. */
  readonly spend: SpendReader;
}

function rows(state: JsonObject, key: string): JsonObject[] {
  return (asArray(state[key]) ?? []).flatMap((r) => {
    const o = asObject(r);

    return o === undefined ? [] : [o];
  });
}

function spentJson(spent: Spent | undefined): Json {
  return spent === undefined ? null : { output: spent.output, input: spent.input, cached: spent.cached, answers: spent.answers };
}

/** Python's whitespace, as `str.split()` splits on it. */
// oxlint-disable-next-line no-control-regex -- Python's str.split() splits on the separators \x1c-\x1f, so the page's search text must too.
const PY_SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** One line of at most 200 characters, as the manager's search shows a field. */
function one(value: Json | undefined): string {
  const text = truthy(value) ? pyStr(value) : "";

  return [...text.split(PY_SPACE).filter((w) => w !== "").join(" ")].slice(0, 200).join("");
}

function orEmpty(value: Json | undefined): Json {
  return truthy(value) ? (value ?? "") : "";
}

/** What the manager's search finds in a fleet: every decision, roadblock, plan step and worker. */
function searchIndex(state: JsonObject): JsonObject[] {
  const found: JsonObject[] = [];

  for (const d of rows(state, "decisions")) {
    if (!truthy(d["id"])) continue;
    const open = d["status"] === "open";
    found.push({
      group: "decisions",
      ref: orEmpty(d["ref"]),
      title: one(d["title"]),
      sub: one(open ? d["question"] : truthy(d["answer"]) ? d["answer"] : d["resolution"]),
      hint: pyStr(orEmpty(d["status"])),
      hash: `#decision/${pyStr(d["id"])}`,
    });
  }

  for (const r of rows(state, "roadblocks")) {
    found.push({
      group: "roadblocks",
      ref: orEmpty(r["ref"]),
      title: one(r["title"]),
      sub: one(r["detail"]),
      hint: truthy(r["resolved"]) ? "resolved" : "open",
      hash: "#roadblocks",
    });
  }

  for (const m of rows(state, "roadmap")) {
    for (const st of rows({ steps: truthy(m["steps"]) ? (m["steps"] ?? []) : [] }, "steps")) {
      found.push({
        group: "plan",
        ref: pyStr(orEmpty(st["id"])),
        title: one(st["title"]),
        sub: one(m["title"]),
        hint: pyStr(orEmpty(st["status"])),
        hash: "#plan",
      });
    }
  }

  for (const a of rows(state, "agents")) {
    found.push({
      group: "workers",
      ref: pyStr(orEmpty(a["id"])),
      title: one(a["name"]),
      sub: one(a["task"]),
      hint: pyStr(orEmpty(a["status"])),
      hash: `#agent-${pyStr(orEmpty(a["id"]))}`,
    });
  }

  return found;
}

const LIVE = new Set(["running", "blocked", "queued"]);

function intOf(value: Json | undefined): number {
  if (!truthy(value)) return 0;
  const n = asNumber(value);

  if (n !== undefined) return Math.trunc(n);
  const text = asString(value)?.trim();

  return text !== undefined && /^[+-]?\d+$/.test(text) ? Number(text) : 0;
}

/** A fleet as the manager's page and the manager read it: who it is, what it does, what waits in it,
 * what its workers and its coordinator spent. */
export function summary(machine: Machine, lookups: Lookups, entry: Entry): JsonObject {
  const raw = readObject(join(entry.dir, "state.json"));
  const state = raw === undefined ? {} : numberState(raw);
  const agents = rows(state, "agents");
  const counts = new Map<string, number>();

  for (const a of agents) counts.set(pyStr(a["status"]), (counts.get(pyStr(a["status"])) ?? 0) + 1);
  const workers: JsonObject = Object.fromEntries(counts);

  const running = agents.filter((a) => LIVE.has(asString(a["status"]) ?? ""));
  const said = readChat(entry.dir);
  const lanes = [...new Set(running.flatMap((a) => (truthy(a["lane"]) ? (asArray(a["lane"]) ?? []) : []).map((l) => pyStr(l))))].sort();
  const heard = listening(machine, entry.dir);

  return {
    id: entry.id,
    url: entry.url,
    session: entry.raw["session"] ?? null,
    dir: entry.dir,
    name: entry.id,
    project: pyStr(orEmpty(state["project"])),
    goal: pyStr(orEmpty(state["goal"])),
    status: raw !== undefined && truthy(raw["status"]) ? pyStr(raw["status"]) : "unknown",
    now: pyStr(orEmpty(state["now"])),
    updated: state["updated"] ?? null,
    workers,
    tokens: agents.reduce((sum, a) => sum + intOf(a["tokens"]), 0),
    spent: spentJson(lookups.spend.of(entry.dir, machine.config)),
    chat: { on: heard.on, seen: heard.seen, unread: heard.unread, since: heard.since },
    active: activeAt(entry.dir, machine.config) ?? null,
    now_at: state["now_at"] ?? null,
    lanes,
    roadblocks: rows(state, "roadblocks").filter((r) => !truthy(r["resolved"])).length,
    index: searchIndex(state),
    silent: silentWorkers(machine, entry.dir, state).map((w) => ({ id: w.id, name: w.name, active: w.active })),
    decisions: rows(state, "decisions")
      .filter((d) => d["status"] === "open" && asString(d["id"]) !== undefined)
      .map((d) => ({
        id: d["id"] ?? null,
        ref: d["ref"] ?? null,
        kind: d["kind"] === undefined ? "decision" : d["kind"],
        title: d["title"] ?? null,
        question: d["question"] ?? null,
        why: d["why"] ?? null,
        blocking: d["blocking"] === true,
        asks: truthy(d["asks"]) ? (d["asks"] ?? "user") : "user",
        opened: d["opened"] ?? null,
        revised: d["revised"] ?? null,
        answered: answeredAt(d, said) ?? null,
      })),
  };
}

/** The fleet's own links as the page shows them: each with whether it answers now. */
export function linksOf(lookups: Lookups, state: JsonObject): JsonObject[] {
  const links = rows(state, "links").filter((l) => asString(l["url"]) !== undefined);
  const up = lookups.up(links.map((l) => asString(l["url"]) ?? ""));

  return links.map((l, i) => ({ ...l, up: up[i] ?? false }));
}

/** What the machine serves that no link names: a served port whose address no link points at. */
export function unlisted(found: readonly Found[], links: readonly JsonObject[]): Found[] {
  const ports = new Set(links.map((l) => splitUrl(asString(l["url"]) ?? "").port));

  return found.filter((x) => !ports.has(x.port));
}

function foundJson(found: readonly Found[]): JsonObject[] {
  return found.map((x) => ({ port: x.port, url: x.url, target: x.target, pid: x.pid, cwd: x.cwd, command: x.command, fleet: x.fleet, up: x.up }));
}

/** The state of the DIR `root` as the page shows it. */
export function view(machine: Machine, lookups: Lookups, given: JsonObject, rootGiven: string): JsonObject {
  const root = resolvePath(rootGiven);
  let state: JsonObject = numberState(given);
  const heard = listening(machine, root);
  state = { ...state, spent: spentJson(lookups.spend.of(root, machine.config)), chat: { on: heard.on, seen: heard.seen, unread: heard.unread, since: heard.since } };
  const seen = lastActivity(root, machine.config);

  const agents = (asArray(state["agents"]) ?? []).map((item) => {
    const a = asObject(item);
    const id = asString(a?.["id"]);
    const at = id === undefined ? undefined : seen.get(id);

    return a === undefined || at === undefined ? item : { ...a, active: isoOf(at) };
  });

  state = { ...state, agents };

  const registry = machine.registry;
  const me = registry.find(root);
  const links: JsonObject[] = linksOf(lookups, state).map((l) => ({ ...l, fleet: me?.id ?? null }));

  if (state["role"] === "manager") {
    const others = registry.live().filter((e) => e.role !== "manager" && e.dir !== root);

    for (const e of others) {
      const theirs = numberState(readObject(join(e.dir, "state.json")) ?? {});

      for (const l of linksOf(lookups, theirs)) links.push({ ...l, fleet: e.id });
    }

    return {
      ...state,
      coordinators: others.map((e) => summary(machine, lookups, e)),
      usage: readUsage(registry.place.home) ?? null,
      gate: registry.gate() ?? null,
      links,
      found: foundJson(unlisted(lookups.discovered(), links)),
    };
  }

  const mine = me === undefined ? [] : lookups.discovered().filter((x) => x.fleet === me.id);
  const manager = registry.manager();
  state = { ...state, links, found: foundJson(unlisted(mine, links)) };

  if (manager === undefined) return state;

  return {
    ...state,
    manager: { id: manager.id, url: manager.url, session: manager.raw["session"] ?? null },
    fleet: me?.id ?? null,
    fleets: registry
      .live()
      .filter((e) => e.role !== "manager")
      .map((e) => e.id),
  };
}
