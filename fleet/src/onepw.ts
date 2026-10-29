/**
 * 1Password locked: the machine's one record that a command needing 1Password failed because the app is
 * locked, and that Luiz was asked to unlock it. `REGISTRY/onepw/locked.json` is the state (absent: not known
 * to be locked), every read-modify-write of it under an exclusive `flock` of `REGISTRY/onepw/onepw.lock`
 * (the plugin's hook takes the same one with `fcntl.flock`), `REGISTRY/onepw/onepw.log` one line per event.
 *
 * A lock is per kind ({@link KINDS}): SSH signing through the 1Password agent, and secrets read through the
 * 1Password app. The hook writes the state and holds the fleets' commands of a kind while it is locked. This
 * module reads it ({@link readState}, {@link locked}), clears every locked kind as Luiz ({@link clear}), and
 * settles what is over ({@link settle}): each held fleet is told, at most once in {@link NOTICE_GAP_S}, in its
 * chat when its host's watch runs and in its session when it does not. A kind that was cleared stays in the
 * state for {@link REOPEN_S}, so a command that fails again reopens the same card. Nothing here probes
 * 1Password: a kind clears on Luiz's answer, on a command of that kind that succeeds (the hook, which lets one
 * held command through every 15 minutes to test a lock: a kind's `probe`, kept here as it was read), or by
 * lapse.
 *
 * A state that does not read ({@link Reason}) is never a lock: the settle sets it aside, once.
 */
import { appendFileSync, closeSync, openSync, renameSync } from "node:fs";
import { join } from "node:path";

import { hostOf, watchLive } from "./chat/chat.ts";
import { appendLocked } from "./chat/store.ts";
import { parseInstant, stampOf } from "./clock.ts";
import { exists, makeDirs, readText, remove, resolvePath, strerror, writeAtomic } from "./files.ts";
import { PROBE, type Probe } from "./host.ts";
import { asArray, asObject, asString, dumps, parseObject, truthy, type Json, type JsonObject, type JsonOut } from "./json.ts";
import { withExclusiveLock } from "./lock.ts";
import { HUB_NAME, type Entry } from "./registry.ts";
import { deliver, deliverTo, type Delivered, type Send } from "./wake.ts";
import type { Machine } from "./world.ts";

import * as Option from "effect/Option";

/** How long a lock holds with no answer before it lapses, in seconds, unless `FLEET_ONEPW_LAPSE_S` says. */
export const LAPSE_S = 7200;

/** How long after a kind was cleared a failure of that kind reopens the same card, in seconds: the kind stays
 * in the state that long. */
export const REOPEN_S = 600;

/** The least time between two notices to one fleet DIR, in seconds. A notice inside it is owed. */
export const NOTICE_GAP_S = 1800;

/** The most hosts a kind keeps. */
export const HOSTS_MAX = 20;

/** How far ahead of now a `since` may be and still read (two clocks, two writers), in seconds. */
const SKEW_S = 60;

/** The kinds of lock, in the order every list of them is written. */
export const KINDS = ["ssh-agent", "op-desktop"] as const;

/** What is locked: SSH signing through the 1Password agent, or secrets read through the 1Password app. */
export type Kind = (typeof KINDS)[number];

/** Why a state file does not read, in the fixed words the log takes: nothing of the file itself. */
export type Reason = "not JSON" | "no kinds" | "an unknown kind" | "a kind's since" | "a kind's cleared" | "waiting" | "told";

/** A state file that does not read: never a lock. */
export interface Broken {
  readonly broken: Reason;
}

/** Why a kind was locked, as the hook writes it: the only words of a kind that reach a page or a terminal. */
const WHYS: readonly string[] = ["SSH signing through 1Password failed", "the 1Password prompt was dismissed", "the 1Password prompt timed out", "the 1Password app did not answer"];

/** What is said of a kind whose `why` is none of {@link WHYS}. */
const NO_WHY = "a command that uses 1Password failed";

/** Who waits when a row names no fleet, in Luiz's words. */
const NO_FLEET = "a session outside the fleets";

const ID = /^[A-Za-z0-9_.-]{1,64}$/u;

const TOOL_WORDS = /^[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+){0,3}$/u;

const HOST = /^[a-z0-9._-]{1,253}$/u;

/** One kind's lock, as the state names it. */
export interface KindLock {
  readonly kind: Kind;
  /** When the kind was first seen failing: the time Luiz was asked at. */
  readonly since: string;
  readonly sinceMs: number;
  /** One of the hook's fixed reasons, else that a command that uses 1Password failed. */
  readonly why: string;
  /** `ssh-agent` only: the hosts seen failing through the agent. */
  readonly hosts: readonly string[];
  /** When it was locked again inside {@link REOPEN_S} of a clear; undefined when it never was. */
  readonly again: string | undefined;
  /** When it was cleared, in ms; undefined while nobody cleared it. */
  readonly clearedMs: number | undefined;
  /** When a settle first saw it past its lapse: the lapse is logged once. */
  readonly lapsed: string | undefined;
  /** The kind as written, with what this module does not read. */
  readonly raw: JsonObject;
}

/** One held command, as the state names it. Neither the session id nor the worker id is read: no reader of
 * this module needs them. */
export interface Waiting {
  /** The fleet's DIR, resolved; undefined for a session of no registered fleet. */
  readonly dir: string | undefined;
  /** The fleet's id as the hook read it: stale once the fleet is renamed, so a name is resolved from `dir`. */
  readonly fleet: string | undefined;
  readonly kind: Kind;
  /** The tool's words (`jj git push`), never its arguments; the kind when the row's own are not such words. */
  readonly what: string;
}

/** A row and the object it was read from, which is what is written back. */
interface Row extends Waiting {
  readonly raw: JsonObject;
}

/** The state in `locked.json`, as it parses. */
export interface State {
  /** The kinds it names, in {@link KINDS}' order. */
  readonly kinds: readonly KindLock[];
  readonly waiting: readonly Waiting[];
  /** When each fleet DIR last got a notice, in ms. */
  readonly told: ReadonlyMap<string, number>;
}

/** {@link State} with what is written back. */
interface Parsed extends State {
  readonly waiting: readonly Row[];
  readonly raw: JsonObject;
}

/** How a kind stands at an instant. */
type Standing = "locked" | "cleared" | "lapsed";

/** 1Password while at least one kind is locked. */
export interface Lock {
  /** The locked kinds, in {@link KINDS}' order. */
  readonly kinds: readonly Kind[];
  /** The earliest `since` among them: when Luiz was first asked. */
  readonly since: string;
  readonly sinceMs: number;
  /** Why that kind was locked. */
  readonly why: string;
  /** The latest time a locked kind was locked again after a clear; undefined when none was. */
  readonly again: string | undefined;
  /** The rows whose kind is locked. */
  readonly waiting: readonly Waiting[];
}

/** One fleet told that a hold is over. */
export interface Told {
  readonly fleet: string;
  /** The fleet's host, who the notice is for. */
  readonly to: string;
  /** The notice's id in the fleet's chat; undefined for one written to the session. */
  readonly id: number | undefined;
  /** Where it was written: the fleet's chat, or its host's session (the watch was dead). */
  readonly via: "chat" | "session";
  readonly text: string;
}

/** What a settle did: who was told. Empty when it only kept the state (a lapse noted, a row dropped, a kind
 * or a stamp pruned). */
export interface Settled {
  readonly told: readonly Told[];
}

/** How a settle reaches a session whose watch is dead: the folder of the sessions' sockets, the write and
 * the machine's processes (wake.ts `deliverTo`). The CLI's own are wake.ts `socksDir`, `deliver` and host.ts
 * `PROBE`; a test gives its own. */
export interface How {
  readonly socks: string;
  readonly send?: Send | undefined;
  readonly probe?: Probe | undefined;
}

/** A kind that is over, as a notice dates it. */
export interface Over {
  readonly kind: Kind;
  readonly how: "cleared" | "lapsed";
  readonly sinceMs: number;
  /** When it was cleared, or when its lapse ran out, in ms. */
  readonly overMs: number;
}

function folder(machine: Machine): string {
  return join(machine.registry.place.home, "onepw");
}

/** `REGISTRY/onepw/locked.json`. */
export function statePath(machine: Machine): string {
  return join(folder(machine), "locked.json");
}

/** `REGISTRY/onepw/locked.json.broken`: the last state that did not read. */
export function brokenPath(machine: Machine): string {
  return `${statePath(machine)}.broken`;
}

/** `REGISTRY/onepw/onepw.log`. */
export function logPath(machine: Machine): string {
  return join(folder(machine), "onepw.log");
}

/** How long a lock holds with no answer, in seconds: `FLEET_ONEPW_LAPSE_S` when it is a number, as the hook
 * reads it (0 or less: nothing ever holds); unset, empty or no number, {@link LAPSE_S}. */
export function lapseSeconds(env: (name: string) => string | undefined): number {
  const given = (env("FLEET_ONEPW_LAPSE_S") ?? "").trim();
  const seconds = Number(given);

  return given === "" || Number.isNaN(seconds) ? LAPSE_S : seconds;
}

/** `text` on one line, without control characters, at most `max` characters. */
function plain(text: string, max: number): string {
  // oxlint-disable-next-line no-control-regex -- the state is a file: no control character of it reaches a chat, a page or the log.
  return [...text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").replace(/ {2,}/gu, " ").trim()].slice(0, max).join("");
}

function kindOf(text: string | undefined): Kind | undefined {
  return KINDS.find((kind) => kind === text);
}

/** A stamp of the state that parses: its text and its instant. */
function stampIn(value: Json | undefined): { readonly at: string; readonly ms: number } | undefined {
  const at = asString(value)?.trim();
  const ms = at === undefined ? undefined : parseInstant(at);

  return at === undefined || ms === undefined ? undefined : { at, ms };
}

function rowOf(item: Json): Row | undefined {
  const raw = asObject(item);
  const kind = kindOf(asString(raw?.["kind"]));

  if (raw === undefined || kind === undefined) return undefined;
  const dir = asString(raw["dir"]);
  const fleet = asString(raw["fleet"]);
  const what = asString(raw["what"]) ?? "";

  return {
    dir: dir === undefined || dir === "" ? undefined : resolvePath(dir),
    fleet: fleet !== undefined && ID.test(fleet) ? fleet : undefined,
    kind,
    what: TOOL_WORDS.test(what) && what.length <= 40 ? what : kind,
    raw,
  };
}

function hostsOf(value: Json | undefined): string[] {
  const hosts = (asArray(value) ?? []).flatMap((item) => {
    const host = asString(item);

    return host !== undefined && HOST.test(host) ? [host] : [];
  });

  return [...new Set(hosts)].slice(0, HOSTS_MAX);
}

/** The kind `kind` of `raw`, or why it does not read. A `since` up to {@link SKEW_S} ahead of `nowMs` reads. */
function kindLockOf(kind: Kind, raw: JsonObject | undefined, nowMs: number): KindLock | Broken {
  const since = stampIn(raw?.["since"]);

  if (raw === undefined || since === undefined || since.ms - nowMs > SKEW_S * 1000) return { broken: "a kind's since" };
  // As the hook reads it: any `cleared` that is not empty.
  const cleared = truthy(raw["cleared"]) ? (stampIn(asObject(raw["cleared"])?.["at"]) ?? "unread") : undefined;

  if (cleared === "unread") return { broken: "a kind's cleared" };
  const why = asString(raw["why"]) ?? "";

  return {
    kind,
    since: since.at,
    sinceMs: since.ms,
    why: WHYS.includes(why) ? why : NO_WHY,
    hosts: hostsOf(raw["hosts"]),
    again: stampIn(raw["again"])?.at,
    clearedMs: cleared?.ms,
    lapsed: stampIn(raw["lapsed"])?.at,
    raw,
  };
}

const isBroken = (read: KindLock | Broken): read is Broken => "broken" in read;

/**
 * The state `text` holds at `nowMs`, or why it does not read, the first of these, as the hook reads it: no
 * JSON object; `kinds` missing or no object; a key of `kinds` that is no {@link Kind}; then each kind in the
 * file's order: it is no object, or its `since` is no stamp or is more than {@link SKEW_S} ahead, or its
 * `cleared` is not empty and no object with an `at` that parses; then a `waiting` that is no list; a `told`
 * that is no object. Dropped and tolerated: a row that is no object or names no kind, a `hosts` that is no
 * list and its items that are no host, an `again`, a `lapsed` or a `told` stamp that does not parse.
 */
function parse(text: string, nowMs: number): Parsed | Broken {
  const raw = Option.getOrUndefined(parseObject(text));

  if (raw === undefined) return { broken: "not JSON" };
  const named = asObject(raw["kinds"]);

  if (named === undefined) return { broken: "no kinds" };

  if (Object.keys(named).some((key) => kindOf(key) === undefined)) return { broken: "an unknown kind" };

  const read = Object.keys(named).flatMap((key) => {
    const kind = kindOf(key);

    return kind === undefined ? [] : [kindLockOf(kind, asObject(named[key]), nowMs)];
  });

  const fault = read.find(isBroken);

  if (fault !== undefined) return fault;
  const waiting = raw["waiting"] === undefined ? [] : asArray(raw["waiting"]);

  if (waiting === undefined) return { broken: "waiting" };
  const told = raw["told"] === undefined ? {} : asObject(raw["told"]);

  if (told === undefined) return { broken: "told" };

  return {
    kinds: KINDS.flatMap((kind) => read.flatMap((r) => (!isBroken(r) && r.kind === kind ? [r] : []))),
    waiting: waiting.flatMap((item) => rowOf(item) ?? []),
    told: new Map(
      Object.entries(told).flatMap(([dir, value]) => {
        const at = stampIn(value);

        return at === undefined || dir === "" ? [] : [[resolvePath(dir), at.ms] as const];
      }),
    ),
    raw,
  };
}

function readParsed(machine: Machine, now: Date): Parsed | Broken | undefined {
  const text = readText(statePath(machine));

  return text === undefined ? undefined : parse(text, now.getTime());
}

/** The state on disk at `now`: as it parses, undefined when there is none, or {@link Broken} with why it does
 * not read. A broken state is not a lock, and nothing here moves it. */
export function readState(machine: Machine, now: Date = machine.now()): State | Broken | undefined {
  return readParsed(machine, now);
}

/** How `lock` stands at `nowMs` with a lapse of `lapse` seconds: cleared when anybody cleared it; else lapsed
 * once it is that old; else locked. A `since` ahead of now counts as now. */
function standing(lock: KindLock, nowMs: number, lapse: number): Standing {
  if (lock.clearedMs !== undefined) return "cleared";

  return Math.max(0, nowMs - lock.sinceMs) >= lapse * 1000 ? "lapsed" : "locked";
}

function lockOf(machine: Machine, state: State, now: Date): Lock | undefined {
  const lapse = lapseSeconds(machine.env);
  const held = state.kinds.filter((k) => standing(k, now.getTime(), lapse) === "locked");
  const first = held.reduce<KindLock | undefined>((least, k) => (least === undefined || k.sinceMs < least.sinceMs ? k : least), undefined);

  if (first === undefined) return undefined;
  const kinds = held.map((k) => k.kind);
  const again = held.flatMap((k) => (k.again === undefined ? [] : [k.again])).sort((a, b) => (parseInstant(b) ?? 0) - (parseInstant(a) ?? 0))[0];

  return { kinds, since: first.since, sinceMs: first.sinceMs, why: first.why, again, waiting: state.waiting.filter((row) => kinds.includes(row.kind)) };
}

/** The lock at `now` while at least one kind is locked: the locked kinds, the earliest `since` among them and
 * that kind's `why`, the latest `again`, and the rows of those kinds. Undefined when 1Password is not known to
 * be locked: no state, a broken one, every kind cleared or past its lapse. */
export function locked(machine: Machine, now: Date = machine.now()): Lock | undefined {
  const state = readState(machine, now);

  return state === undefined || "broken" in state ? undefined : lockOf(machine, state, now);
}

/** Run `body` under the state's lock (`REGISTRY/onepw/onepw.lock`, the one the hook's `fcntl.flock` takes),
 * so a detection, a clear and a settle never interleave. */
function underLock<T>(machine: Machine, body: () => T): T {
  makeDirs(folder(machine));
  const fd = openSync(join(folder(machine), "onepw.lock"), "a+");

  try {
    return withExclusiveLock(fd, body);
  } finally {
    closeSync(fd);
  }
}

/** Append one event to the log; called under the lock. A log that cannot be written stops nothing. */
function log(machine: Machine, now: Date, text: string): void {
  try {
    appendFileSync(logPath(machine), `${stampOf(now)} ${plain(text, 600)}\n`, "utf8");
  } catch {
    // the log is a record, never a gate
  }
}

/** What is written back, under the lock. */
interface Kept {
  readonly kinds: readonly KindLock[];
  readonly waiting: readonly Row[];
  readonly told: ReadonlyMap<string, number>;
}

/** Write the state under the lock, version 2: each kind as it was read with its hosts and stamps as they
 * parsed, the rows as they were read, each `told` as a stamp. */
function write(machine: Machine, raw: JsonObject, kept: Kept): void {
  const kinds = kept.kinds.map((k): readonly [string, JsonOut] => [k.kind, { ...k.raw, hosts: k.hosts.length > 0 ? k.hosts : undefined, again: k.again, lapsed: k.lapsed }]);

  const written: JsonOut = {
    ...raw,
    v: 2,
    kinds: Object.fromEntries(kinds),
    waiting: kept.waiting.map((row) => row.raw),
    told: Object.fromEntries([...kept.told].map(([dir, ms]) => [dir, stampOf(new Date(ms))] as const)),
  };

  writeAtomic(statePath(machine), `${dumps(written, { indent: 2 })}\n`);
}

/**
 * Clear every locked kind as `by` (Luiz: `fleet onepw unlocked` in a terminal), with a
 * note of how. Nothing is told here: {@link settle} tells the fleets. The lock it cleared, or undefined when
 * nothing was locked (then nothing is written).
 */
export function clear(machine: Machine, by: "user", note: string): Lock | undefined {
  if (locked(machine) === undefined) return undefined;

  return underLock(machine, () => {
    const now = machine.now();
    const state = readParsed(machine, now);
    const lock = state === undefined || "broken" in state ? undefined : lockOf(machine, state, now);

    if (state === undefined || "broken" in state || lock === undefined) return undefined;
    const said = plain(note, 200);
    const cleared = { at: stampOf(now), by, note: said };
    const kinds = state.kinds.map((k) => (lock.kinds.includes(k.kind) ? { ...k, clearedMs: now.getTime(), raw: { ...k.raw, cleared } } : k));
    write(machine, state.raw, { ...state, kinds });
    log(machine, now, `cleared by ${by}${said === "" ? "" : `: ${said}`}`);

    return lock;
  });
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** `HH:MM`, local, of an instant in ms. */
function clockOf(ms: number): string {
  const at = new Date(ms);

  return `${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** A span of seconds in words: `2 h`, `1 h 30 min`, `45 s`. */
function spanWords(seconds: number): string {
  const whole = Math.round(seconds);
  const parts = [[Math.floor(whole / 3600), "h"] as const, [Math.floor((whole % 3600) / 60), "min"] as const, [whole % 60, "s"] as const];

  return parts.flatMap(([n, unit]) => (n > 0 ? [`${String(n)} ${unit}`] : [])).join(" ") || "0 s";
}

/** `items` as a sentence lists them: `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** What a fleet's agents read for a kind that was held there: the notice's fixed words. */
function heldWords(kind: Kind): string {
  return kind === "ssh-agent" ? "SSH through the 1Password agent (jj and git remotes, ssh)" : "secrets read through the 1Password app (op, secretspec, gh, aws)";
}

/** What Luiz reads for a kind a fleet waits for: the card's fixed words. */
function cardWords(kind: Kind): string {
  return kind === "ssh-agent" ? "SSH (a push, a fetch or a connection)" : "reading secrets";
}

/**
 * The notice a held fleet gets when its kinds are `over`: a dated fact, what was held there, and `Retry`. A
 * fixed template: of the state it carries only the kinds, in the notice's own words and {@link KINDS}' order,
 * and two instants as `HH:MM`, never a row's words, a worker, a session, a fleet or a host. When a kind was
 * cleared it says unlocked, at the latest clear; when every kind lapsed it says so, at the latest lapse; both
 * since the earliest `since`. A `[hub]` line is a fact about the machine, never a command and never Luiz.
 */
export function noticeText(over: readonly Over[], lapse: number): string {
  const kinds = KINDS.filter((kind) => over.some((o) => o.kind === kind));
  const since = clockOf(Math.min(...over.map((o) => o.sinceMs)));
  const here = `Held here: ${listed(kinds.map(heldWords))}.`;
  const cleared = over.filter((o) => o.how === "cleared");

  if (cleared.length > 0) return `[hub] 1Password is unlocked (${clockOf(Math.max(...cleared.map((o) => o.overMs)))}; locked since ${since}). ${here} Retry.`;

  return `[hub] The 1Password hold lapsed (${clockOf(Math.max(...over.map((o) => o.overMs)))}; locked since ${since}, ${spanWords(lapse)} with no answer). ${here} Retry once.`;
}

/** `rows` by fleet DIR, in the order first seen; the rows of no fleet under `undefined`. */
function byDir<R extends Waiting>(rows: readonly R[]): Map<string | undefined, R[]> {
  const groups = new Map<string | undefined, R[]>();

  for (const row of rows) {
    const group = groups.get(row.dir);

    if (group === undefined) groups.set(row.dir, [row]);
    else group.push(row);
  }

  return groups;
}

/** Append `text` to `entry`'s chat, from `fleet-hub` to its host; the notice as stored, or why it could not be. */
function post(entry: Entry, to: string, text: string, now: Date): Told | Error {
  try {
    const stored = appendLocked(entry.dir, (_known, nextId) => ({ id: nextId, at: stampOf(now), from: HUB_NAME, to: [to], text, re: null, parts: [{ text }] }));

    return stored instanceof Error ? stored : { fleet: entry.id, to, id: stored.id, via: "chat", text };
  } catch (cause: unknown) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
}

/** One fleet a settle decided to tell, under the lock. */
interface Notice {
  readonly entry: Entry;
  readonly to: string;
  readonly text: string;
  /** The notice in the fleet's chat, when its watch runs and the chat took it. */
  readonly stored: Told | undefined;
  /** Why the chat did not take it; undefined when it took it or was not tried (the watch is dead). */
  readonly chatWhy: string | undefined;
}

/** Set aside a state that does not read, under the lock: it becomes {@link brokenPath} (an older one is
 * replaced) and one line says why, in fixed words. After it there is no state, so nothing logs again. */
function setAside(machine: Machine, reason: Reason, now: Date): void {
  try {
    renameSync(statePath(machine), brokenPath(machine));
  } catch {
    return;
  }

  log(machine, now, `set aside: the state did not read (${reason})`);
}

/**
 * The first phase of a settle, under the lock: what changes in the state, and the fleets to tell. A kind seen
 * past its lapse is marked and logged once. Rows of a kind that is over are due: those of no fleet are
 * dropped, those of a DIR no fleet is served at are logged and dropped, those of a DIR told less than
 * {@link NOTICE_GAP_S} ago are left (the notice is owed), and the others' fleet is told, the DIR stamped and
 * the rows dropped. A fleet whose host's watch runs is told here, in its chat; the others are left to the
 * second phase. Then a kind that is over with no row left, lapsed or cleared {@link REOPEN_S} ago, is
 * removed, and so is a stamp older than the gap; with nothing left the file is removed. Undefined when
 * nothing changed (no state, or one that did not read, which is set aside).
 */
function decide(machine: Machine): Notice[] | undefined {
  return underLock(machine, () => {
    const now = machine.now();
    const nowMs = now.getTime();
    const state = readParsed(machine, now);

    if (state === undefined) return undefined;

    if ("broken" in state) {
      setAside(machine, state.broken, now);

      return undefined;
    }

    const lapse = lapseSeconds(machine.env);
    const young = (ms: number): boolean => Math.abs(nowMs - ms) < NOTICE_GAP_S * 1000;
    const unmarked = state.kinds.filter((k) => standing(k, nowMs, lapse) === "lapsed" && k.lapsed === undefined);

    for (const k of unmarked) log(machine, now, `lapsed: ${k.kind} locked since ${stampOf(new Date(k.sinceMs))}, ${spanWords(lapse)} with no answer`);
    const kinds = state.kinds.map((k) => (unmarked.includes(k) ? { ...k, lapsed: stampOf(now) } : k));

    const over = kinds.flatMap((k): Over[] => {
      const how = standing(k, nowMs, lapse);

      return how === "locked" ? [] : [{ kind: k.kind, how, sinceMs: k.sinceMs, overMs: k.clearedMs ?? k.sinceMs + lapse * 1000 }];
    });

    const due = state.waiting.filter((row) => over.some((o) => o.kind === row.kind));
    // A row of a kind the state does not name has no instant to date a notice with: nobody can be told of it.
    const dropped = new Set(state.waiting.filter((row) => !kinds.some((k) => k.kind === row.kind)));
    const told = new Map(state.told);
    const notices: Notice[] = [];
    const live = due.length > 0 ? machine.registry.live() : [];

    for (const [dir, rows] of byDir(due)) {
      const entry = dir === undefined ? undefined : live.find((e) => e.dir === dir);
      const last = dir === undefined ? undefined : told.get(dir);

      if (entry !== undefined && last !== undefined && young(last)) continue;

      for (const row of rows) dropped.add(row);

      if (dir === undefined) continue;

      if (entry === undefined) {
        log(machine, now, `not told: no fleet is served at ${dir}`);
        continue;
      }

      const to = hostOf(entry.dir);
      const text = noticeText(over.filter((o) => rows.some((row) => row.kind === o.kind)), lapse);
      const stored = watchLive(machine, entry.dir) ? post(entry, to, text, now) : undefined;
      told.set(dir, nowMs);

      if (stored !== undefined && !(stored instanceof Error)) log(machine, now, `told ${stored.fleet} (${stored.to}, #${String(stored.id)}): ${stored.text}`);
      notices.push({ entry, to, text, stored: stored instanceof Error ? undefined : stored, chatWhy: stored instanceof Error ? stored.message : undefined });
    }

    const waiting = state.waiting.filter((row) => !dropped.has(row));

    const kept = kinds.filter((k) => {
      const how = standing(k, nowMs, lapse);

      return how === "locked" || waiting.some((row) => row.kind === k.kind) || (how === "cleared" && Math.abs(nowMs - (k.clearedMs ?? nowMs)) < REOPEN_S * 1000);
    });

    for (const [dir, ms] of told) if (!young(ms)) told.delete(dir);

    if (unmarked.length === 0 && dropped.size === 0 && kept.length === kinds.length && told.size === state.told.size) return undefined;

    if (kept.length === 0 && waiting.length === 0 && told.size === 0) remove(statePath(machine));
    else write(machine, state.raw, { kinds: kept, waiting, told });

    return notices;
  });
}

/**
 * Settle what is over (a kind cleared, or past its lapse): {@link decide} under the lock, which tells in its
 * chat each fleet whose host's watch runs; then, the lock released, each fleet whose watch is dead is told in
 * its session, through wake.ts `deliverTo` (the one verified way to a session's socket), and in its chat when
 * that writes nothing. Every notice is logged: `told F (HOST, #ID): TEXT`, `told F (its session): TEXT`, or
 * `could not tell F: WHY` when neither took it. A fleet is told once however many callers: the first stamps
 * its DIR and drops its rows. Who was told, or undefined when nothing changed.
 */
export async function settle(machine: Machine, how: How): Promise<Settled | undefined> {
  if (!exists(statePath(machine))) return undefined;
  const notices = decide(machine);

  if (notices === undefined) return undefined;
  const told: Told[] = [];

  for (const notice of notices) {
    if (notice.stored !== undefined) {
      told.push(notice.stored);
      continue;
    }

    const { entry, to, text } = notice;
    const sent = await deliverTo(entry, how.socks, text, how.send ?? deliver, how.probe ?? PROBE).catch((cause: unknown): Delivered => ({ written: false, unknown: false, why: strerror(cause) }));
    const now = machine.now();

    if (sent.written) {
      told.push({ fleet: entry.id, to, id: undefined, via: "session", text });
      underLock(machine, () => log(machine, now, `told ${entry.id} (its session): ${text}`));
      continue;
    }

    const stored = notice.chatWhy === undefined ? post(entry, to, text, now) : new Error(notice.chatWhy);

    if (stored instanceof Error) {
      underLock(machine, () => log(machine, now, `could not tell ${entry.id}: ${sent.why}; its chat: ${stored.message}`));
      continue;
    }

    told.push(stored);
    underLock(machine, () => log(machine, now, `told ${stored.fleet} (${stored.to}, #${String(stored.id)}): ${stored.text}`));
  }

  return { told };
}

/** Who waits and for which rows, by the name Luiz knows each fleet by: its id in the registry now (served or
 * kept), else the one the hook read, else that it is no longer served; the rows of no fleet last. */
function byName(machine: Machine, waiting: readonly Waiting[]): { readonly who: string; readonly rows: readonly Waiting[] }[] {
  const groups = [...byDir(waiting)];
  const known = groups.length > 0 ? machine.registry.known() : [];
  const named = groups.flatMap(([dir, rows]) => (dir === undefined ? [] : [{ who: known.find((e) => e.dir === dir)?.id ?? rows[0]?.fleet ?? "a fleet no longer served", rows }]));

  return [...named, ...groups.flatMap(([dir, rows]) => (dir === undefined ? [{ who: NO_FLEET, rows }] : []))];
}

/**
 * The card on every page while 1Password is locked, undefined otherwise: since when (the earliest locked
 * kind), why, when a locked kind was locked again after a clear (`again`, else null), and who waits for what,
 * one row per fleet, in the card's own words for each locked kind. Rows of a kind that is over are not on it,
 * and neither is a worker id, a session id or a row's own words.
 */
export function cardOf(machine: Machine): JsonObject | undefined {
  const lock = locked(machine);

  if (lock === undefined) return undefined;

  return {
    since: lock.since,
    why: lock.why,
    again: lock.again ?? null,
    waiting: byName(machine, lock.waiting).map(({ who, rows }) => ({ who, what: listed(KINDS.flatMap((kind) => (rows.some((r) => r.kind === kind) ? [cardWords(kind)] : []))) })),
  };
}

/** How many fleet DIRs have rows of a kind that is over: a notice each is owed (no `fleet onepw unlocked` has settled since,
 * or the DIR was told less than {@link NOTICE_GAP_S} ago). */
function owed(machine: Machine, state: State, now: Date): number {
  const lapse = lapseSeconds(machine.env);
  const over = state.kinds.filter((k) => standing(k, now.getTime(), lapse) !== "locked").map((k) => k.kind);

  return new Set(state.waiting.flatMap((row) => (row.dir !== undefined && over.includes(row.kind) ? [row.dir] : []))).size;
}

/** The line that says a hold is over and fleets are not told yet, with how many; undefined when none is owed
 * a notice, there is no state, or it does not read. */
export function owedLine(machine: Machine, now: Date = machine.now()): string | undefined {
  const state = readState(machine, now);
  const untold = state === undefined || "broken" in state ? 0 : owed(machine, state, now);

  return untold === 0 ? undefined : `a hold is over and ${String(untold)} fleet(s) are not told yet: each is told the next time the user clears the lock from his own terminal, once ${spanWords(NOTICE_GAP_S)} have passed since it was last told`;
}

/**
 * `fleet onepw`'s text, for a terminal or an agent: each locked kind with since when and why, and who waits
 * for what in the tools' own words; `not known to be locked` otherwise. A second line ({@link owedLine}) when
 * a hold is over and fleets are not told yet. It reads only: a state that does not read is not known to be
 * locked.
 */
export function statusLine(machine: Machine): string {
  const now = machine.now();
  const state = readState(machine, now);

  if (state === undefined || "broken" in state) return "1Password: not known to be locked";
  const lock = lockOf(machine, state, now);
  const untold = owedLine(machine, now);
  const after = untold === undefined ? "" : `\n${untold}`;

  if (lock === undefined) return `1Password: not known to be locked${after}`;
  const kinds = state.kinds.filter((k) => lock.kinds.includes(k.kind)).map((k) => `${k.kind} since ${clockOf(k.sinceMs)} (${k.why})`);
  const waiting = byName(machine, lock.waiting).map(({ who, rows }) => `${who} (${[...new Set(rows.map((r) => r.what))].join(", ")})`);

  return `1Password: locked: ${kinds.join(", ")}; ${waiting.length === 0 ? "nothing waits" : `waiting: ${waiting.join(", ")}`}${after}`;
}
