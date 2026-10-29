/**
 * The state as the page shows it (Python's `fleets.view`): the ledger with its numbers, what its
 * session spent, whether its host reads the chat, when each worker last wrote, its links up or down,
 * and what the machine serves that no link names. A manager's carries every coordinator being served
 * (`summary`), the plan's usage and the gate; a coordinator's, how to reach its manager; every page's, the
 * card that asks Luiz to unlock 1Password while it is locked (`onepw`, onepw.ts). The ledger
 * itself is left as it is. Key order is Python's, so the page's payload is byte for byte the same.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import { readChat, type Message } from "../chat/store.ts";
import { listening, type Listening } from "../chat/chat.ts";
import { resolvePath } from "../files.ts";
import { answeredAt, isoOf, silentWorkers } from "../health.ts";
import { asArray, asNumber, asObject, asString, truthy, type Json, type JsonObject } from "../json.ts";
import { gateOf } from "../gate.ts";
import { readObject, type Entry } from "../registry.ts";
import { workerActivity } from "../heartbeat.ts";
import { activeAt, SpendReader, type Spent } from "../transcripts.ts";
import { readUsage } from "../usage.ts";
import type { Machine } from "../world.ts";
import { cardOf } from "../onepw.ts";
import type { Orphan } from "../orphans.ts";
import { lastError, logTail } from "../preview/devserver.ts";
import { readRecord, serverProc, updaterProc, type DevServer } from "../preview/record.ts";
import { runs } from "../preview/tracked.ts";
import { readPortStates, type PortState } from "../hub/preview-ports.ts";
import { runningPreviewServer } from "../hub/preview-server.ts";
import { candidates, everyMs, included, said } from "../preview/updater.ts";
import { filePathOf, filesRoot, linkKind, reachOf, servedRel } from "../ledger/links.ts";
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
  /** The hub's: each link's last HTTP probe, with when it was checked and since when it reads so; `up` null
   * (the view's `up: null`) while unknown. Without it, a link is up when `up` says so. */
  readonly probe?: (urls: readonly string[]) => readonly (Probed | undefined)[];
  /** The hub's: this machine's MagicDNS suffix, the only `*.ts.net` names a link reaches it by (`null`: none).
   * Without it any `*.ts.net` name is this machine's tailnet, as the Python twin reads it. */
  readonly tailnet?: () => string | null;
  /** The hub's: the machine's orphaned test and dev processes (orphans.ts), shown on the manager's page. */
  readonly orphans?: () => readonly Orphan[];
  /** The hub's: what it did to wake a fleet whose host does not listen while the user's messages wait
   * (wake.ts `deafView`); undefined for a host that listens. */
  readonly deaf?: (entry: Entry, heard: Listening) => JsonObject | undefined;
  /** The hub's: a fleet its last look could not read, and why (wake.ts `Wakes.blindView`); undefined while it reads. */
  readonly blind?: (entry: Entry) => JsonObject | undefined;
  /** The hub's: the fleet's last takeover (`fleet serve --take-over`), until the host has read a message the
   * user wrote after it (takeover.ts `takeoverView`). */
  readonly takeover?: (entry: Entry, heard: Listening) => JsonObject | undefined;
}

/** A link's last probe. */
export interface Probed {
  /** Null while unknown: never probed yet, or the probe itself failed. */
  readonly up: boolean | null;
  /** When it was checked, and since when it has read up (or down), as stamps. */
  readonly checked: string;
  readonly since: string;
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
  const said = saidIn(entry.dir);
  const lanes = [...new Set(running.flatMap((a) => (truthy(a["lane"]) ? (asArray(a["lane"]) ?? []) : []).map((l) => pyStr(l))))].sort();
  const heard = heardIn(machine, entry.dir);

  const shown = {
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
    // Only from a hub, and only for a host that does not listen: the twin's page and every trace have no such key.
    ...deafKey(lookups, entry, heard),
    active: activeAt(entry.dir, machine.config, asString(entry.raw["session_id"])) ?? null,
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

  // Only a team moved to the cloud has the key: its `url` is then its cloud page, which the manager's page links, never frames.
  return entry.moved === true ? { ...shown, moved: true } : shown;
}

/** The status of the decision `key` names in `state` (by id, else by number), or null. */
function decisionStatus(state: JsonObject, key: Json | undefined): Json {
  const k = asString(key);

  if (k === undefined || k === "") return null;
  const ds = rows(state, "decisions");
  const d = ds.find((x) => x["id"] === k) ?? ds.find((x) => x["ref"] === k);

  return d === undefined ? null : (d["status"] ?? null);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The links of the fleet whose ledger is `state` and DIR `root`, as the page shows them: each with its kind as
 * the user sees it, where it is reached from, whether it answers now (a file: whether it is there), the status
 * of the decision it serves, and, for a file under the fleet's files root, the hub path it is served at
 * (`prefix` + `files/…`: `prefix` is how the page showing it reaches that fleet). */
export function linksOf(machine: Machine, lookups: Lookups, state: JsonObject, root: string, prefix = ""): JsonObject[] {
  const links = rows(state, "links").filter((l) => asString(l["url"]) !== undefined);
  const urls = links.map((l) => asString(l["url"]) ?? "");
  const suffix = lookups.tailnet?.();
  const reach = urls.map((u) => reachOf(u, suffix));
  const probed = urls.filter((_, i) => reach[i] === "machine");
  const up = lookups.probe === undefined ? lookups.up(probed) : [];
  const seen = lookups.probe === undefined ? [] : lookups.probe(probed);
  const base = filesRoot(root, machine.env);
  let n = 0;

  return links.map((l, i) => {
    const url = urls[i] ?? "";
    const where = reach[i] ?? "external";
    const shown = { kind: linkKind(asString(l["kind"]), url, asString(l["title"])), reach: where };
    const decision_status = decisionStatus(state, l["decision"]);

    if (where === "file") {
      const path = filePathOf(url);
      const rel = path === undefined ? undefined : servedRel(base, path);

      return { ...l, ...shown, up: path !== undefined && isFile(path), file: rel === undefined ? null : `${prefix}files/${rel}`, decision_status };
    }

    if (where === "external") return { ...l, ...shown, up: false, file: null, decision_status };
    const at = n;
    n += 1;

    if (lookups.probe === undefined) return { ...l, ...shown, up: up[at] ?? false, file: null, decision_status };
    const p = seen[at];

    const stamp = (x: string | undefined): string | null => (x === undefined || x === "" ? null : x);

    return { ...l, ...shown, up: p === undefined ? null : p.up, file: null, decision_status, checked: stamp(p?.checked), state_since: stamp(p?.since) };
  });
}

/** What the machine serves that no link names: a served port whose address no link points at. */
export function unlisted(found: readonly Found[], links: readonly JsonObject[]): Found[] {
  const ports = new Set(links.map((l) => splitUrl(asString(l["url"]) ?? "").port));

  return found.filter((x) => !ports.has(x.port));
}

function foundJson(found: readonly Found[]): JsonObject[] {
  return found.map((x) => ({ port: x.port, url: x.url, target: x.target, pid: x.pid, cwd: x.cwd, command: x.command, fleet: x.fleet, up: x.up }));
}

function orphanJson(o: Orphan): JsonObject {
  return { pid: o.pid, started: o.started, command: o.command, age: o.age, rss: o.rss, cwd: o.cwd, workspace: o.workspace, session: o.session, fleet: o.fleet };
}

/** What the running preview server says of a root-mode preview's public port: the https address it serves it at, or why it cannot serve it. */
function publicState(machine: Machine, port: number | null): Pick<PortState, "url" | "error"> {
  const home = machine.registry.place.home;
  const server = port === null ? undefined : runningPreviewServer(home);
  const state = server === undefined ? undefined : readPortStates(home, server)?.find((p) => p.port === port);

  return { url: state?.url ?? null, error: state?.error ?? null };
}

/** A dev server as the page shows it: whether it runs and answers, its port, its last error, and in root
 * mode its public port, the https address the hub serves it at (the page links it), and why the hub
 * cannot serve https there. */
function serverView(machine: Machine, lookups: Lookups, s: DevServer | null): JsonObject {
  const running = s !== null && runs(serverProc(s));
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
 * worker's workspace with whether the merge takes it (a worker left out because its workspace would
 * conflict it is not `included`, and `error`, which the page shows, says why in a sentence), the dev
 * servers' last errors. */
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
    updater: runs(updaterProc(record)),
    every: everyMs(machine) / 1000,
    workers,
    conflicts: record.conflicts.map((c) => ({ path: c.path, workers: [...c.workers] })),
    error: said(record),
    updated: record.updated,
    per_worker: record.workers.map((w) => ({
      worker: w.worker,
      url: `preview/${encodeURIComponent(w.worker)}/`,
      address: address === null ? null : `${address}preview/${encodeURIComponent(w.worker)}/`,
      ...serverView(machine, lookups, w),
    })),
  };
}

/** What only a hub says of a fleet it serves, each key only when it holds: `{deaf}` for one whose host does
 * not listen while the user's messages wait (since when, and what the hub did to wake it), `{blind}` for one
 * the hub's look cannot read, `{takeover}` for one that changed host and whose user was not heard since.
 * Nothing otherwise, and nothing without a hub. */
function deafKey(lookups: Lookups, entry: Entry | undefined, heard: Listening): JsonObject {
  if (entry === undefined) return {};

  const said: readonly (readonly [string, JsonObject | undefined])[] = [
    ["deaf", lookups.deaf?.(entry, heard)],
    ["blind", lookups.blind?.(entry)],
    ["takeover", unreadable(heard) ? undefined : lookups.takeover?.(entry, heard)],
  ];

  return Object.fromEntries(said.flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])));
}

/** What a chat that cannot be read is heard as: nobody reading, nothing known to wait. */
const UNHEARD: Listening = { on: false, seen: 0, unread: 0, since: null };

const unreadable = (heard: Listening): boolean => heard === UNHEARD;

/** Whether the host of `dir` reads its chat ({@link listening}); {@link UNHEARD} of a chat that cannot be
 * read, so the page of that fleet, and the manager's, still render: the hub's look says why (`blind`). */
function heardIn(machine: Machine, dir: string): Listening {
  try {
    return listening(machine, dir);
  } catch {
    return UNHEARD;
  }
}

/** What was said in `dir`; nothing of a chat that cannot be read. */
function saidIn(dir: string): Message[] {
  try {
    return readChat(dir);
  } catch {
    return [];
  }
}

/** The state of the DIR `root` as the page shows it. */
export function view(machine: Machine, lookups: Lookups, given: JsonObject, rootGiven: string): JsonObject {
  const shown = ledgerView(machine, lookups, given, rootGiven);
  const onepw = cardOf(machine);

  // The machine's one card, on every page, and only while 1Password is locked: with none, the frozen Python
  // twin's page and every trace read the same.
  return onepw === undefined ? shown : { ...shown, onepw };
}

function ledgerView(machine: Machine, lookups: Lookups, given: JsonObject, rootGiven: string): JsonObject {
  const root = resolvePath(rootGiven);
  let state: JsonObject = numberState(given);
  const heard = heardIn(machine, root);
  state = { ...state, spent: spentJson(lookups.spend.of(root, machine.config)), chat: { on: heard.on, seen: heard.seen, unread: heard.unread, since: heard.since }, ...deafKey(lookups, machine.registry.find(root), heard) };
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
  const links: JsonObject[] = linksOf(machine, lookups, state, root).map((l) => ({ ...l, fleet: me?.id ?? null }));

  if (state["role"] === "manager") {
    const others = registry.shown().filter((e) => e.role !== "manager" && e.dir !== root);

    for (const e of others) {
      const theirs = numberState(readObject(join(e.dir, "state.json")) ?? {});

      for (const l of linksOf(machine, lookups, theirs, resolvePath(e.dir), `f/${encodeURIComponent(e.id)}/`)) links.push({ ...l, fleet: e.id });
    }

    // The fleets the registry keeps but no longer serves that hold decisions: their numbers, so a bare one names its holder on the page.
    const stopped = registry
      .known()
      .filter((e) => e.role !== "manager" && e.dir !== root && !others.some((o) => o.id === e.id))
      .flatMap((e) => {
        const index = searchIndex(numberState(readObject(join(e.dir, "state.json")) ?? {})).filter((x) => x["group"] === "decisions");

        return index.length > 0 ? [{ id: e.id, index }] : [];
      });

    const shown = {
      ...state,
      coordinators: others.map((e) => summary(machine, lookups, e)),
      usage: readUsage(registry.place.home) ?? null,
      gate: gateOf(registry).head(machine.now()) ?? null,
      links,
      found: foundJson(unlisted(lookups.discovered(), links)),
    };

    const orphans = (lookups.orphans?.() ?? []).map(orphanJson);
    // Each key only when there is one, so the frozen Python twin's page reads the same with none stopped or orphaned.
    const kept = stopped.length > 0 ? { ...shown, stopped } : shown;

    return orphans.length > 0 ? { ...kept, orphans } : kept;
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
