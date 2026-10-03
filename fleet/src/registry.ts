/**
 * The registry of the fleets served on this machine (Python's `fleets.py`): `REGISTRY/<fleet>.json` per
 * fleet, `REGISTRY/gate/gate.json` for the one gate slot. Every read (`live`) forgets a fleet whose
 * server died or whose entry is malformed, and renames one whose session got a title (open-25). A
 * forgotten fleet's last entry stays in `REGISTRY/names/<fleet>.json` until its dir is served again,
 * so a restarted session (`claude respawn`: a new pid, the same session id) gets its name back.
 * Entries are written atomically, in Python's format (indent 2, ASCII escapes).
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { isDir, listDir, makeDirs, readText, remove, resolvePath, writeAtomic, writeText } from "./files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseObject, type Json, type JsonObject } from "./json.ts";
import { transcriptOf } from "./transcripts.ts";

/** The names the chat keeps for itself. */
export const KEPT_NAMES = ["coordinator", "manager", "user"] as const;

/** Whether the chat keeps `name` for itself. */
export function isKept(name: string): boolean {
  return KEPT_NAMES.some((kept) => kept === name);
}

/** One fleet being served. */
export interface Entry {
  readonly id: string;
  readonly role: string;
  readonly dir: string;
  readonly url: string;
  readonly session: string | null;
  readonly since: string;
  /** The ids it had before its session's number was dropped (`3.ui-coordinator`): the hub sends them on to `id`. */
  readonly aliases: readonly string[];
  /** The entry as written, with what this model does not read. */
  readonly raw: JsonObject;
}

/** Where the registry is and what it reads beside it. */
export interface RegistryPlace {
  /** `$FLEET_HOME`, else `$XDG_STATE_HOME/fleet-board`, else `~/.local/state/fleet-board`. */
  readonly home: string;
  /** Where session transcripts are (`$CLAUDE_CONFIG_DIR`), for session titles. */
  readonly config: string;
}

/** The registry's place from the environment. */
export function registryPlace(env: (name: string) => string | undefined, config: string): RegistryPlace {
  const given = env("FLEET_HOME");

  if (given !== undefined && given !== "") return { home: given, config };
  const state = env("XDG_STATE_HOME");
  const base = state !== undefined && state !== "" ? state : join(env("HOME") ?? "", ".local", "state");

  return { home: join(base, "fleet-board"), config };
}

/** A fleet's name made from text: runs of other characters as `-`, trimmed of `-` and `.`, lower case. */
export function slug(text: string): string {
  return text
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
}

/** A session's name without the number Claude Code puts before it on a restart: `3.ui-coordinator` is `ui-coordinator`. */
export function unnumbered(session: string): string {
  return session.replace(/^[0-9]+\.(?=[\s\S])/, "");
}

/** The fleet name a session's name gives: its slug, without the session's number. */
export function fleetName(session: string): string {
  return slug(unnumbered(session));
}

/** Whether `to` is the id `from` without its session's number (`3.ui-coordinator` to `ui-coordinator`). */
export function dropsNumber(from: string, to: string): boolean {
  return from !== to && /^[0-9]+\./.test(from) && unnumbered(from) === to;
}

/** The aliases an entry keeps once its id goes from `from` to `to`: every rename keeps `from`, so its address still answers. */
export function aliasesAfter(raw: JsonObject, from: string, to: string): string[] {
  const kept = aliasesOf(raw).filter((a) => a !== to);

  if (from !== "" && from !== to && !kept.includes(from)) kept.push(from);

  return kept;
}

/** The session whose scratchpad holds `root` (`…/<project>/<session>/scratchpad/<name>`), or undefined. */
export function scratchpadSession(root: string, config: string): string | undefined {
  return transcriptOf(root, config)?.split("/").at(-1)?.replace(/\.jsonl$/, "");
}

/** `raw` with `aliases` set to `aliases`, or without the key when there are none. */
function withAliases(raw: JsonObject, aliases: readonly string[]): JsonObject {
  if (aliases.length > 0) return { ...raw, aliases: [...aliases] };
  const { aliases: _dropped, ...rest } = raw;

  return rest;
}

/** The role a ledger gives its DIR's host. */
export function roleOf(state: JsonObject | undefined): "manager" | "coordinator" {
  return state?.["role"] === "manager" ? "manager" : "coordinator";
}

/** The JSON object in `path`, or undefined. */
export function readObject(path: string): JsonObject | undefined {
  const text = readText(path);

  return text === undefined ? undefined : Option.getOrUndefined(parseObject(text));
}

function pidOf(value: Json | undefined): number | undefined {
  const number = asNumber(value);

  if (number !== undefined) return Number.isFinite(number) ? Math.trunc(number) : undefined;

  if (value === true) return 1;

  if (value === false) return 0;
  const text = asString(value)?.trim();

  return text !== undefined && /^[+-]?\d+$/.test(text) ? Number(text) : undefined;
}

/** Whether process `pid` runs (and may be signalled by us). */
export function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/** The pid an entry lives as long as: the session `fleet serve` found, or `--pid`. */
export function pidOfEntry(entry: Entry): number | undefined {
  return pidOf(entry.raw["pid"]);
}

function entryOf(raw: JsonObject): Entry | undefined {
  const id = asString(raw["id"]);
  const dir = asString(raw["dir"]);

  if (id === undefined || dir === undefined || !alive(pidOf(raw["pid"]))) return undefined;

  return {
    id,
    dir,
    role: asString(raw["role"]) ?? "coordinator",
    url: asString(raw["url"]) ?? "",
    session: asString(raw["session"]) ?? null,
    since: asString(raw["since"]) ?? "",
    aliases: aliasesOf(raw),
    raw,
  };
}

function aliasesOf(raw: JsonObject): string[] {
  return (asArray(raw["aliases"]) ?? []).flatMap((a) => {
    const alias = asString(a);

    return alias === undefined ? [] : [alias];
  });
}

/** The registry of this machine's fleets. */
export class Registry {
  readonly place: RegistryPlace;

  constructor(place: RegistryPlace) {
    this.place = place;
  }

  private path(id: string): string {
    return join(this.place.home, `${id}.json`);
  }

  private entryFiles(): string[] {
    return listDir(this.place.home).filter((name) => name.endsWith(".json") && !isDir(join(this.place.home, name)));
  }

  /** The title (its /rename) of the session whose scratchpad holds `root`, else of session `sessionId`, or undefined. */
  titleOf(root: string, sessionId?: string | null): string | undefined {
    const transcript = transcriptOf(root, this.place.config);
    const folder = transcript !== undefined ? transcript.replace(/\.jsonl$/, "") : this.sessionFolder(sessionId);

    if (folder === undefined) return undefined;
    const value = readObject(join(folder, "custom-title.json"));
    const title = asString(value?.["customTitle"])?.trim();

    return title === undefined || title === "" ? undefined : title;
  }

  /** The folder beside session `sessionId`'s transcript, in whichever project holds it, or undefined. */
  private sessionFolder(sessionId: string | null | undefined): string | undefined {
    if (sessionId === undefined || sessionId === null || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined;
    const projects = join(this.place.config, "projects");

    return listDir(projects)
      .map((project) => join(projects, project, sessionId))
      .find((folder) => isDir(folder));
  }

  private namesDir(): string {
    return join(this.place.home, "names");
  }

  /** Keep a forgotten fleet's entry, by its name and in place of any kept before for its dir, so its dir or its session served again gets its name back. */
  private keepName(raw: JsonObject): void {
    const dir = asString(raw["dir"]);
    const id = asString(raw["id"]);

    if (dir === undefined || id === undefined || id === "" || id.includes("/")) return;

    for (const old of this.keptNames()) if (old.raw["dir"] === dir) remove(old.path);
    makeDirs(this.namesDir());
    writeAtomic(join(this.namesDir(), `${id}.json`), `${dumps(raw, { indent: 2 })}\n`);
  }

  /** The kept entries of fleets no longer served, with their files. */
  private keptNames(): { readonly path: string; readonly raw: JsonObject }[] {
    return listDir(this.namesDir())
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const path = join(this.namesDir(), name);
        const raw = readObject(path);

        return raw === undefined || asString(raw["id"]) === undefined ? [] : [{ path, raw }];
      });
  }

  private write(raw: JsonObject, changes: Readonly<Record<string, Json>>, aliases: readonly string[]): Entry {
    const next = withAliases({ ...raw, ...changes }, aliases);
    makeDirs(this.place.home);
    const id = asString(next["id"]) ?? "";
    writeAtomic(this.path(id), `${dumps(next, { indent: 2 })}\n`);

    return {
      id,
      dir: asString(next["dir"]) ?? "",
      role: asString(next["role"]) ?? "coordinator",
      url: asString(next["url"]) ?? "",
      session: asString(next["session"]) ?? null,
      since: asString(next["since"]) ?? "",
      aliases: aliasesOf(next),
      raw: next,
    };
  }

  /** The fleets whose server runs, oldest first; the dead are forgotten, a renamed session renames its fleet. */
  live(): Entry[] {
    const entries: Entry[] = [];

    for (const name of this.entryFiles()) {
      const path = join(this.place.home, name);
      const raw = readObject(path);
      const entry = raw === undefined ? undefined : entryOf(raw);

      if (entry === undefined) {
        if (raw !== undefined) this.keepName(raw);
        remove(path);
      } else entries.push(entry);
    }

    entries.forEach((entry, i) => {
      const title = this.titleOf(entry.dir, asString(entry.raw["session_id"]));

      if (title === undefined || title === entry.session) return;
      let next = entry.role === "manager" ? entry.id : fleetName(title);
      const kept = isKept(next) && entry.role !== "manager";

      if (next === "" || kept || entries.some((e) => e !== entry && e.id === next)) next = entry.id;

      if (next !== entry.id) remove(this.path(entry.id));
      entries[i] = this.write(entry.raw, { id: next, session: title }, aliasesAfter(entry.raw, entry.id, next));
    });

    return entries.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
  }

  /** The live fleet served from `root`. */
  find(root: string): Entry | undefined {
    const dir = resolvePath(root);

    return this.live().find((e) => e.dir === dir);
  }

  /** The manager, when one is served. */
  manager(): Entry | undefined {
    return this.live().find((e) => e.role === "manager");
  }

  /**
   * Record that `root` is served at `url` by `pid`, for session `sessionId` (else the session whose scratchpad
   * holds it). A fleet that registers again keeps its name, aliases and session: from its own entry, else from
   * the kept entry of its dir, else from the kept entry of its session (a respawned session serving another dir).
   * A brand-new fleet is named after its session's title, else its project.
   */
  register(root: string, url: string, pid: number, stamp: string, sessionId?: string): Entry {
    const dir = resolvePath(root);
    const state = readObject(join(dir, "state.json"));

    const known = this.entryFiles()
      .map((name) => readObject(join(this.place.home, name)))
      .find((e) => e !== undefined && e["dir"] === dir && asString(e["id"]) !== undefined && e["id"] !== "");

    const role = roleOf(state);
    const others = this.live().filter((e) => e.dir !== dir);
    const taken = (id: string): boolean => id === "" || others.some((e) => e.id === id);
    const kept = this.keptNames();
    const keptOfDir = kept.find((k) => k.raw["dir"] === dir);
    const session = sessionId ?? scratchpadSession(dir, this.place.config) ?? asString((known ?? keptOfDir?.raw)?.["session_id"]);
    const keptOfSession = session === undefined ? undefined : kept.find((k) => k.raw["session_id"] === session && !taken(asString(k.raw["id"]) ?? ""));
    const prior = known ?? (keptOfDir !== undefined && !taken(asString(keptOfDir.raw["id"]) ?? "") ? keptOfDir.raw : keptOfSession?.raw);
    const title = this.titleOf(dir, session);
    const priorId = asString(prior?.["id"]);
    const priorSession = asString(prior?.["session"]);
    const free = (id: string): boolean => !taken(id) && !isKept(id);
    let name: string;

    if (title !== undefined && role !== "manager" && free(fleetName(title))) {
      name = fleetName(title);
    } else if (priorId !== undefined) {
      // An entry named before session numbers were dropped (`3.ui-coordinator`) drops its number now.
      const unnumberedId = priorSession === undefined || role === "manager" ? priorId : fleetName(priorSession);
      name = dropsNumber(priorId, unnumberedId) && free(unnumberedId) ? unnumberedId : priorId;
    } else {
      const project = asString(state?.["project"]);
      let base = role === "manager" ? "manager" : slug(project !== undefined && project !== "" ? project : (dir.split("/").at(-2) ?? ""));

      if (base === "") base = "fleet";

      if (role !== "manager" && isKept(base)) base += "-fleet";
      name = base;

      for (let n = 2; taken(name); n += 1) name = `${base}-${n}`;
    }

    const knownId = asString(known?.["id"]);

    if (knownId !== undefined && knownId !== name) remove(this.path(knownId));

    for (const used of [keptOfDir, prior === keptOfSession?.raw ? keptOfSession : undefined]) if (used !== undefined) remove(used.path);

    return this.write(
      {},
      {
        id: name,
        role,
        dir,
        url,
        pid,
        session: title ?? priorSession ?? null,
        session_id: session ?? null,
        since: known === undefined ? stamp : (asString(known["since"]) ?? stamp),
      },
      prior === undefined || priorId === undefined ? [] : aliasesAfter(prior, priorId, name),
    );
  }

  /** Forget the fleet served from `root` (`fleet serve --stop`): a stop is on purpose, so its name is not kept. */
  unregister(root: string): void {
    const dir = resolvePath(root);

    for (const name of this.entryFiles()) {
      const path = join(this.place.home, name);

      if (readObject(path)?.["dir"] === dir) remove(path);
    }
  }

  /** Give the fleet served from `root` its session's name: the entry, or why not. */
  name(root: string, session: string): Entry | { readonly why: string } {
    const entry = this.find(root);

    if (entry === undefined) return { why: `${root} is not being served; serve it with \`fleet serve\` first` };
    const next = entry.role === "manager" ? "manager" : fleetName(session);

    if (next === "" || (isKept(next) && entry.role !== "manager")) {
      return { why: `'${session}' cannot name a fleet; the chat keeps ['coordinator', 'manager', 'user'] for itself` };
    }

    if (this.live().some((e) => e.id === next && e.dir !== entry.dir)) {
      return { why: `another fleet is already called '${next}'; pick another session name` };
    }

    if (next !== entry.id) remove(this.path(entry.id));

    return this.write(entry.raw, { id: next, session }, aliasesAfter(entry.raw, entry.id, next));
  }

  private gatePath(): string {
    return join(this.place.home, "gate", "gate.json");
  }

  /** Who holds the gate slot, or undefined; a hold by a fleet no longer served is forgotten. */
  gate(): JsonObject | undefined {
    const held = readObject(this.gatePath());

    if (held !== undefined && this.live().some((e) => e.id === held["fleet"])) return held;
    remove(this.gatePath());

    return undefined;
  }

  /** `fleet` takes the gate for `what`. */
  takeGate(fleet: string, what: string, stamp: string): void {
    makeDirs(join(this.place.home, "gate"));
    writeText(this.gatePath(), dumps({ fleet, what, since: stamp }));
  }

  /** The gate is free again. */
  freeGate(): void {
    remove(this.gatePath());
  }
}

/** The state.json of `entry`'s fleet, or undefined. */
export function stateOf(entry: Entry): JsonObject | undefined {
  return asObject(readObject(join(entry.dir, "state.json")));
}
