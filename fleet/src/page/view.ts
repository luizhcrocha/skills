/**
 * The state as the page shows it (Python's `fleets.view`): the ledger with its numbers, what its
 * session spent, whether its host reads the chat, when each worker last wrote, its links up or down,
 * and what the machine serves that no link names. A manager's carries every coordinator being served
 * (`summary`), the plan's usage and the gate; a coordinator's, how to reach its manager. The ledger
 * itself is left as it is. Key order is Python's, so the page's payload is byte for byte the same.
 */
import { join } from "node:path";

import { readChat, type Message } from "../chat/store.ts";
import { listening } from "../chat/chat.ts";
import { resolvePath } from "../files.ts";
import { answeredAt, isoOf, silentWorkers } from "../health.ts";
import { asArray, asNumber, asObject, asString, truthy, type Json, type JsonObject } from "../json.ts";
import { readObject, type Entry } from "../registry.ts";
import { workerActivity } from "../heartbeat.ts";
import { activeAt, SpendReader, type Spent } from "../transcripts.ts";
import { readUsage } from "../usage.ts";
import type { Machine } from "../world.ts";
import { isRunning, lastError, logTail } from "../preview/devserver.ts";
import { readRecord, type DevServer } from "../preview/record.ts";
import { readPortStates, type PortState } from "../hub/preview-ports.ts";
import { runningHub } from "../hub/server.ts";
import { candidates, everyMs, included } from "../preview/updater.ts";
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

/** The fleet's chat about the open item `d`, which its page reads to tell whether it waits on the user: the
 * user's messages tagged with it and the replies to them, each with what that rule reads. */
function saidAbout(d: JsonObject, said: readonly Message[]): JsonObject[] {
  const answers = new Set(said.flatMap((m) => (m.from === "user" && m.decision === d["id"] ? [m.id] : [])));
  const about = (m: Message): boolean => answers.has(m.id) || (m.from !== "user" && answers.has(asNumber(m.re) ?? Number.NaN));

  return said.flatMap((m) => (about(m) ? [{ id: m.id, at: m.at ?? null, from: m.from, to: m.stored["to"] ?? [], text: m.text, re: m.re, decision: m.decision ?? null }] : []));
}

/** A grilling's questions still open, with what its page reads to count those left to answer. */
function openQuestions(d: JsonObject): JsonObject[] {
  return (asArray(d["questions"]) ?? []).flatMap((item) => {
    const q = asObject(item);

    return q !== undefined && q["status"] === "open" ? [{ id: q["id"] ?? null, of: q["of"] ?? null, status: "open", asked: q["asked"] ?? null }] : [];
  });
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
      .map((d) => {
        const row = {
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
          said: saidAbout(d, said),
        };

        const asked = d["kind"] === "grill" ? { ...row, questions: openQuestions(d) } : row;

        // Held: the fleet works on the user's answer first (only a held decision has the keys, as in Python).
        return truthy(d["held"]) ? { ...asked, held: d["held"] ?? null, held_at: d["held_at"] ?? null } : asked;
      }),
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

/** What the running hub says of a root-mode preview's public port: the https address it serves it at, or why it cannot serve it. */
function publicState(machine: Machine, port: number | null): Pick<PortState, "url" | "error"> {
  const home = machine.registry.place.home;
  const hub = port === null ? undefined : runningHub(home);
  const state = hub === undefined ? undefined : readPortStates(home, hub.pid)?.find((p) => p.port === port);

  return { url: state?.url ?? null, error: state?.error ?? null };
}

/** A dev server as the page shows it: whether it runs and answers, its port, its last error, and in root
 * mode its public port, the https address the hub serves it at (the page links it), and why the hub
 * cannot serve https there. */
function serverView(machine: Machine, lookups: Lookups, s: DevServer | null): JsonObject {
  const running = s !== null && s.pid !== null && isRunning(s.pid);
  const pub = running ? publicState(machine, s?.public ?? null) : { url: null, error: null };

  return {
    running,
    up: running && s !== null ? (lookups.up([`http://127.0.0.1:${s.port}/`])[0] ?? false) : false,
    port: s?.port ?? null,
    log: s === null ? null : lastError(logTail(s.log)),
    public: s?.public ?? null,
    public_url: pub.url,
    public_error: pub.error,
  };
}

/** The fleet's preview as the page shows it, when it has one (`DIR/preview.json`): the address, every
 * worker's workspace with whether the merge takes it, the conflicts, the dev servers' last errors. */
export function previewView(machine: Machine, lookups: Lookups, root: string, state: JsonObject, address: string | null): JsonObject | undefined {
  const record = readRecord(root);

  if (record === undefined) return undefined;
  const combined = record.path !== "";

  const workers = candidates(state).map((c) => {
    const merged = record.merged.find((m) => m.id === c.id);

    return {
      id: c.id,
      name: c.name,
      status: c.status ?? null,
      included: included(c, record),
      commit: merged?.commit.slice(0, 12) ?? null,
      change: merged?.change.slice(0, 8) ?? null,
    };
  });

  return {
    url: combined ? "preview/" : null,
    address: combined && address !== null ? `${address}preview/` : null,
    ...serverView(machine, lookups, combined ? record.server : null),
    updater: record.updater !== null && isRunning(record.updater),
    every: everyMs(machine) / 1000,
    workers,
    conflicts: record.conflicts.map((c) => ({ path: c.path, workers: [...c.workers] })),
    error: record.error,
    updated: record.updated,
    per_worker: record.workers.map((w) => ({
      worker: w.worker,
      url: `preview/${encodeURIComponent(w.worker)}/`,
      address: address === null ? null : `${address}preview/${encodeURIComponent(w.worker)}/`,
      ...serverView(machine, lookups, w),
    })),
  };
}

/** The state of the DIR `root` as the page shows it. */
export function view(machine: Machine, lookups: Lookups, given: JsonObject, rootGiven: string): JsonObject {
  const root = resolvePath(rootGiven);
  let state: JsonObject = numberState(given);
  const heard = listening(machine, root);
  state = { ...state, spent: spentJson(lookups.spend.of(root, machine.config)), chat: { on: heard.on, seen: heard.seen, unread: heard.unread, since: heard.since } };
  const seen = workerActivity(root, machine.config, state);

  // `active` is when the worker was last seen; `beat`, only when a heartbeat says it, what it last ran.
  const agents = (asArray(state["agents"]) ?? []).map((item) => {
    const a = asObject(item);
    const id = asString(a?.["id"]);
    const at = id === undefined ? undefined : seen.get(id);

    if (a === undefined || at === undefined) return item;

    return at.by === "heartbeat" ? { ...a, active: isoOf(at.at), beat: { tool: at.tool, event: at.event } } : { ...a, active: isoOf(at.at) };
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
      gate: registry.gate(machine.now()) ?? null,
      links,
      found: foundJson(unlisted(lookups.discovered(), links)),
    };
  }

  const mine = me === undefined ? [] : lookups.discovered().filter((x) => x.fleet === me.id);
  const manager = registry.manager();
  state = { ...state, links, found: foundJson(unlisted(mine, links)) };
  // Only a fleet with a preview gets the key: the Python oracle's view has none, and no trace has a preview.
  const preview = previewView(machine, lookups, root, state, me?.url ?? null);

  if (preview !== undefined) state = { ...state, preview };

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
