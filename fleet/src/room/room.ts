/**
 * The project room as one team folder holds it (room design, slice 5). The host's export writes the project's room
 * lines to `DIR/room.jsonl` and its members to `DIR/room.json` in every team folder it exports; this module only
 * reads them. A line wakes the team it names (directly or through one of its workers), and the manager team also
 * for the user's untagged line; an untagged line from a team wakes nobody, and a team's own line never wakes it.
 * What a team has seen is kept beside them: `room.cursor` (the last id pulled with `fleet room … since`) and
 * `room.seen` (the ids a wake showed, its lines and their `re` chains). What it did is appended to
 * `room-events.jsonl` (pull, delivered, forwarded), which the export ships to the cloud's counters.
 */
import { appendFileSync, statSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";

import { oneLine } from "../chat/chat.ts";
import { parseInstant } from "../clock.ts";
import { exists, readText, writeText } from "../files.ts";
import { asArray, asNumber, asObject, asString, parseJson, parseObject, type Json } from "../json.ts";
import { movedTeam } from "../registry.ts";
import { secondsNow, type Machine } from "../world.ts";

/** Whom a tagged line names: a team, or one worker of it. */
export interface RoomTarget {
  readonly team: string;
  readonly agent?: string;
}

/** One line of the room, as the export writes it (packages/ledger/src/room.ts `RoomLine`). */
export interface RoomLine {
  readonly id: number;
  readonly at: string;
  readonly project: string;
  /** `user`, or the FleetId of the team that wrote it. */
  readonly from: string;
  readonly to: "everyone" | readonly RoomTarget[];
  readonly re: number | null;
  readonly text: string;
}

/** The room's members as `room.json` gives them: the project, its manager team, and every team. */
export interface RoomMembers {
  readonly project: string;
  readonly manager: string | null;
  readonly teams: readonly { readonly id: string; readonly role: string }[];
}

/** One counter event, appended to `room-events.jsonl`. */
export type RoomEvent =
  | { readonly kind: "pull"; readonly team: string; readonly since: number; readonly lines: number }
  | { readonly kind: "delivered"; readonly team: string; readonly line: number; readonly how: "watch" | "wake" }
  | { readonly kind: "forwarded"; readonly team: string; readonly line: number; readonly agent: string };

/** How many lines of a `re` chain a wake shows, and about how many tokens (chars / 4). */
export const CHAIN_LINES = 5;

export const CHAIN_TOKENS = 600;

/** How long a forward to a worker may stay unacked before the coordinator's watch tells it again. */
export const FORWARD_S = 10 * 60;

const LINES = "room.jsonl";

const MEMBERS = "room.json";

const CURSOR = "room.cursor";

const SEEN = "room.seen";

const EVENTS = "room-events.jsonl";

function targetOf(value: Json | undefined): RoomTarget | undefined {
  const o = asObject(value);
  const team = asString(o?.["team"]);
  const agent = asString(o?.["agent"]);

  if (team === undefined) return undefined;

  return agent === undefined ? { team } : { team, agent };
}

function lineOf(value: Json | undefined): RoomLine | undefined {
  const o = asObject(value);
  const id = asNumber(o?.["id"]);
  const from = asString(o?.["from"]);
  const text = asString(o?.["text"]);
  const re = asNumber(o?.["re"]);
  const rawTo = o?.["to"];
  const given = asArray(rawTo);
  const targets = given?.flatMap((t) => targetOf(t) ?? []);

  if (o === undefined || id === undefined || !Number.isInteger(id) || from === undefined || text === undefined) return undefined;
  const to = rawTo === "everyone" ? "everyone" : targets !== undefined && targets.length === given?.length ? targets : undefined;

  if (to === undefined) return undefined;

  return { id, at: asString(o["at"]) ?? "", project: asString(o["project"]) ?? "", from, to, re: re !== undefined && Number.isInteger(re) ? re : null, text };
}

/** The room lines in the folder at `root`, by id; a row that is not a line (a torn write, another shape) is skipped. */
export function readRoom(root: string): RoomLine[] {
  const byId = new Map<number, RoomLine>();

  for (const text of (readText(join(root, LINES)) ?? "").split("\n")) {
    if (text.trim() === "") continue;
    const line = lineOf(Option.getOrUndefined(parseJson(text)));

    if (line !== undefined) byId.set(line.id, line);
  }

  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** The members `room.json` gives the folder at `root`, or undefined when it holds none (a team under no project). */
export function membersOf(root: string): RoomMembers | undefined {
  const o = Option.getOrUndefined(parseObject(readText(join(root, MEMBERS)) ?? ""));
  const project = asString(o?.["project"]);

  if (o === undefined || project === undefined) return undefined;

  const teams = (asArray(o["teams"]) ?? []).flatMap((t) => {
    const id = asString(asObject(t)?.["id"]);

    return id === undefined ? [] : [{ id, role: asString(asObject(t)?.["role"]) ?? "" }];
  });

  return { project, manager: asString(o["manager"]) ?? null, teams };
}

/** The FleetId of the team whose folder is `root`: the one its cloud.json names. */
export function teamOf(root: string): string | undefined {
  return movedTeam(root)?.id;
}

/** Whether `line` wakes `team`, in a room whose manager team is `manager`. */
export function wakes(line: RoomLine, team: string, manager: string | null): boolean {
  if (line.from === team) return false;

  if (line.to === "everyone") return line.from === "user" && manager === team;

  return line.to.some((t) => t.team === team);
}

/** The `re` chain of line `id`, nearest first, as the fleet's ledger `chainOf` cuts it: at most {@link CHAIN_LINES}
 * lines and {@link CHAIN_TOKENS} tokens (characters / 4, rounded up). The nearest line is cut to the budget rather
 * than left out; a farther one that does not fit, or a line met twice, ends the chain. */
export function chainOf(lines: readonly RoomLine[], id: number): RoomLine[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const chain: RoomLine[] = [];
  const met = new Set([id]);
  let budget = CHAIN_TOKENS;
  let next = byId.get(id)?.re ?? null;

  while (next !== null && !met.has(next) && chain.length < CHAIN_LINES) {
    const line = byId.get(next);

    if (line === undefined) break;
    met.add(next);
    const tokens = Math.ceil(line.text.length / 4);

    if (tokens > budget) {
      if (chain.length === 0) chain.push({ ...line, text: `${line.text.slice(0, budget * 4 - 1)}…` });

      break;
    }

    chain.push(line);
    budget -= tokens;
    next = line.re;
  }

  return chain;
}

/** The last id pulled by `fleet room … since`, 0 before any. */
export function cursorOf(root: string): number {
  const n = Number((readText(join(root, CURSOR)) ?? "").trim());

  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function writeCursor(root: string, id: number): void {
  writeText(join(root, CURSOR), String(id));
}

/** The ids a wake has shown the team, the lines that woke it and their chains: one id a line, appended by this
 * watch and by the host's session-wake alike (apps/host room.ts `markDelivered`). */
export function seenOf(root: string): Set<number> {
  const ids = (readText(join(root, SEEN)) ?? "").split("\n").map((l) => Number(l.trim()));

  return new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0));
}

/** Append the ids not seen yet, one a line. */
export function addSeen(root: string, ids: Iterable<number>): void {
  const seen = seenOf(root);
  const fresh = [...new Set(ids)].filter((id) => !seen.has(id));

  if (fresh.length > 0) appendFileSync(join(root, SEEN), fresh.map((id) => `${id}\n`).join(""));
}

/** Append one counter event, stamped now as the host stamps its own (ISO, UTC). */
export function recordEvent(machine: Machine, root: string, event: RoomEvent): void {
  const { kind, ...rest } = event;

  appendFileSync(join(root, EVENTS), `${JSON.stringify({ kind, at: machine.now().toISOString(), ...rest })}\n`);
}

/** The forwards of the folder at `root` already acked: `line:agent`, from its forwarded events. */
export function forwardedOf(root: string): Set<string> {
  const done = new Set<string>();

  for (const text of (readText(join(root, EVENTS)) ?? "").split("\n")) {
    const o = asObject(Option.getOrUndefined(parseJson(text)));

    if (o?.["kind"] === "forwarded") done.add(`${String(asNumber(o["line"]))}:${asString(o["agent"]) ?? ""}`);
  }

  return done;
}

/** How a line's sender reads to `team`, as the fleet's ledger `roomWakeText` says it: `you` for the user (the room's
 * owner), `us` for the team itself, `manager` for the manager team, else the team's id. */
function who(from: string, team: string, manager: string | null): string {
  if (from === "user") return "you";

  if (from === team) return "us";

  return from === manager ? "manager" : from;
}

function whom(to: RoomLine["to"], manager: string | null): string {
  if (to === "everyone") return "everyone";

  return to.map((t) => (t.agent !== undefined ? `@${t.team}/${t.agent}` : t.team === manager ? "@manager" : `@${t.team}`)).join(" ");
}

/** A line's text on one line: its whitespace runs as one space, as the fleet's ledger prints it; no control character. */
function flat(text: string): string {
  return oneLine(text.replace(/\s+/gu, " ").trim());
}

/** A line as `fleet room … since` prints it: `#4 you -> @api/c208: text ↳#3`. */
export function sinceLine(line: RoomLine, team: string, manager: string | null): string {
  const re = line.re === null ? "" : ` ↳#${line.re}`;

  return `#${line.id} ${who(line.from, team, manager)} -> ${whom(line.to, manager)}: ${flat(line.text)}${re}`;
}

/** The forward of line `id` to `agent` by `team`, as a wake and its reminder say it. `--as` because every team folder
 * of the project on this machine holds the room. */
function forwardCommand(project: string, team: string, id: number, agent: string): string {
  return `(SendMessage ${agent}), then \`fleet room ${project} forwarded ${id} --to ${agent} --as ${team}\``;
}

/** The `!` line for each worker of `team` that `line` names: its coordinator forwards the line verbatim. */
export function forwardLines(line: RoomLine, team: string, project: string): string[] {
  if (line.to === "everyone") return [];

  return line.to.flatMap((t) => (t.team === team && t.agent !== undefined ? [`! forward #${line.id} verbatim ${forwardCommand(project, team, line.id, t.agent)}`] : []));
}

/** What a waking line prints: the line, and its `re` chain on one line. */
export function wakeLines(lines: readonly RoomLine[], line: RoomLine, team: string, members: RoomMembers): string[] {
  const { manager, project } = members;
  const out = [`room ${project} #${line.id} from ${who(line.from, team, manager)} to ${whom(line.to, manager)}: ${flat(line.text)}`];
  const chain = chainOf(lines, line.id);

  if (chain.length > 0) out.push(`  ${chain.map((c) => `re #${c.id} ${who(c.from, team, manager)}: ${flat(c.text)}`).join("   ")}`);

  return out;
}

/** The room of the team folder at `root`, when it has one: its lines, members and team. */
export interface Room {
  readonly root: string;
  readonly team: string;
  readonly members: RoomMembers;
  readonly lines: RoomLine[];
}

export function roomAt(root: string): Room | undefined {
  const members = membersOf(root);
  const team = teamOf(root);

  if (members === undefined || team === undefined) return undefined;

  return { root, team, members, lines: readRoom(root) };
}

/** The lines that wake the team, past its cursor, that no wake has shown it yet: the host's `roomWaking` rule. */
export function waiting(room: Room, seen: ReadonlySet<number> = seenOf(room.root)): RoomLine[] {
  const cursor = cursorOf(room.root);

  return room.lines.filter((l) => l.id > cursor && !seen.has(l.id) && wakes(l, room.team, room.members.manager));
}

/** The pointer to what the team at `root` has not read: lines past its cursor, never shown in a wake, not its own.
 * Undefined when there are none, or the folder has no room. It rides on wakes that happen anyway, never one itself. */
export function roomPointer(root: string): string | undefined {
  const room = roomAt(root);

  if (room === undefined) return undefined;
  const cursor = cursorOf(root);
  const seen = seenOf(root);
  const count = room.lines.filter((l) => l.id > cursor && !seen.has(l.id) && l.from !== room.team).length;

  if (count === 0) return undefined;

  return `room: ${count} ${count === 1 ? "line" : "lines"} since #${cursor} you did not read; \`fleet room ${room.members.project} since ${cursor} --as ${room.team}\``;
}

/** The `!` lines for the forwards of `root`'s room shown in a wake and not acked for `forwardS`: each told once
 * (`told` keeps it, as the coordinator's other reminders). */
export function forwardReminders(machine: Machine, root: string, told: Map<string, Json>, forwardS: number): string[] {
  const room = roomAt(root);

  if (room === undefined || !exists(join(root, SEEN))) return [];
  const seen = seenOf(root);
  const acked = forwardedOf(root);
  const out: string[] = [];

  for (const line of room.lines) {
    if (!seen.has(line.id) || line.to === "everyone" || !wakes(line, room.team, room.members.manager)) continue;
    const at = parseInstant(line.at);

    if (at === undefined || secondsNow(machine) - at / 1000 < forwardS) continue;

    for (const t of line.to) {
      if (t.team !== room.team || t.agent === undefined) continue;
      const mark = `room-forward:${line.id}:${t.agent}`;

      if (acked.has(`${line.id}:${t.agent}`) || (told.has(mark) && told.get(mark) !== false)) continue;
      told.set(mark, true);
      out.push(`! #${line.id} for ${t.agent} is not forwarded yet: forward it verbatim ${forwardCommand(room.members.project, room.team, line.id, t.agent)}`);
    }
  }

  return out;
}

/** The lines a {@link RoomWatch} prints for the waking lines it took, and whether one is the user's. */
export interface RoomWake {
  readonly lines: string[];
  readonly user: boolean;
}

/** What a `--once` watch of the team at `root` takes from the room: each waking line once, with its chain. Nothing is
 * marked shown until {@link RoomWatch.commit}: a watch that stood down handed nothing to anyone. */
export class RoomWatch {
  private readonly root: string;
  private readonly shown = new Set<number>();
  private readonly woke: number[] = [];
  private readonly forwarding: string[] = [];
  private stamp = "";

  constructor(root: string) {
    this.root = root;
  }

  /** The lines to print for the waking lines that came since the last call, and whether one is the user's. */
  take(): RoomWake {
    const path = join(this.root, LINES);
    let stamp = "";

    try {
      const s = statSync(path);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      return { lines: [], user: false };
    }

    if (stamp === this.stamp) return { lines: [], user: false };
    this.stamp = stamp;
    const room = roomAt(this.root);

    if (room === undefined) return { lines: [], user: false };
    const seen = seenOf(this.root);
    const fresh = waiting(room, seen).filter((l) => !this.shown.has(l.id));
    const lines: string[] = [];

    for (const line of fresh) {
      lines.push(...wakeLines(room.lines, line, room.team, room.members));
      this.forwarding.push(...forwardLines(line, room.team, room.members.project));
      this.woke.push(line.id);
      this.shown.add(line.id);

      for (const c of chainOf(room.lines, line.id)) this.shown.add(c.id);
    }

    return { lines, user: fresh.some((l) => l.from === "user") };
  }

  /** The forwards the lines taken ask for, said last as a wake's `!` lines are, after the pointer. */
  forwards(): readonly string[] {
    return this.forwarding;
  }

  /** Mark what was shown as seen, and record each waking line delivered. */
  commit(machine: Machine): void {
    if (this.shown.size === 0) return;
    const team = teamOf(this.root);

    addSeen(this.root, this.shown);

    if (team !== undefined) for (const line of this.woke) recordEvent(machine, this.root, { kind: "delivered", team, line, how: "watch" });
  }
}
