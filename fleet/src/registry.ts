/**
 * The registry of the fleets served on this machine (Python's `fleets.py`): `REGISTRY/<fleet>.json` per
 * fleet, `REGISTRY/gate/gate.json` for the one gate slot. Every read (`live`) forgets a fleet whose
 * server died or whose entry is malformed, and renames one whose session got a title (open-25).
 * Entries are written atomically, in Python's format (indent 2, ASCII escapes).
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { isDir, listDir, makeDirs, readText, remove, resolvePath, writeAtomic, writeText } from "./files.ts";
import { asNumber, asObject, asString, dumps, parseObject, type Json, type JsonObject } from "./json.ts";
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
    raw,
  };
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

  /** The title of the session whose scratchpad holds `root` (its /rename), or undefined. */
  titleOf(root: string): string | undefined {
    const transcript = transcriptOf(root, this.place.config);

    if (transcript === undefined) return undefined;
    const value = readObject(join(transcript.replace(/\.jsonl$/, ""), "custom-title.json"));
    const title = asString(value?.["customTitle"])?.trim();

    return title === undefined || title === "" ? undefined : title;
  }

  private write(raw: JsonObject, changes: Readonly<Record<string, Json>>): Entry {
    const next: JsonObject = { ...raw, ...changes };
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

      if (entry === undefined) remove(path);
      else entries.push(entry);
    }

    entries.forEach((entry, i) => {
      const title = this.titleOf(entry.dir);

      if (title === undefined || title === entry.session) return;
      let next = entry.role === "manager" ? entry.id : slug(title);
      const kept = isKept(next) && entry.role !== "manager";

      if (next === "" || kept || entries.some((e) => e !== entry && e.id === next)) next = entry.id;

      if (next !== entry.id) remove(this.path(entry.id));
      entries[i] = this.write(entry.raw, { id: next, session: title });
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

  /** Record that `root` is served at `url` by `pid`; a fleet that registers again keeps its name and session. */
  register(root: string, url: string, pid: number, stamp: string): Entry {
    const dir = resolvePath(root);
    const state = readObject(join(dir, "state.json"));

    const known = this.entryFiles()
      .map((name) => readObject(join(this.place.home, name)))
      .find((e) => e !== undefined && e["dir"] === dir && asString(e["id"]) !== undefined && e["id"] !== "");

    const role = roleOf(state);
    const others = this.live().filter((e) => e.dir !== dir);
    const title = this.titleOf(dir);
    const kept = isKept;
    const knownId = asString(known?.["id"]);
    let name: string;

    if (title !== undefined && role !== "manager" && slug(title) !== "" && !kept(slug(title)) && !others.some((e) => e.id === slug(title))) {
      name = slug(title);
    } else if (knownId !== undefined) {
      name = knownId;
    } else {
      const project = asString(state?.["project"]);
      let base = role === "manager" ? "manager" : slug(project !== undefined && project !== "" ? project : (dir.split("/").at(-2) ?? ""));

      if (base === "") base = "fleet";

      if (role !== "manager" && kept(base)) base += "-fleet";
      const taken = new Set(others.map((e) => e.id));
      name = base;

      for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
    }

    if (knownId !== undefined && knownId !== name) remove(this.path(knownId));
    const session = title ?? (known === undefined ? null : (asString(known["session"]) ?? null));

    return this.write(
      {},
      { id: name, role, dir, url, pid, session, since: known === undefined ? stamp : (asString(known["since"]) ?? stamp) },
    );
  }

  /** Forget the fleet served from `root`. */
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
    const next = entry.role === "manager" ? "manager" : slug(session);

    if (next === "" || (isKept(next) && entry.role !== "manager")) {
      return { why: `'${session}' cannot name a fleet; the chat keeps ['coordinator', 'manager', 'user'] for itself` };
    }

    if (this.live().some((e) => e.id === next && e.dir !== entry.dir)) {
      return { why: `another fleet is already called '${next}'; pick another session name` };
    }

    if (next !== entry.id) remove(this.path(entry.id));

    return this.write(entry.raw, { id: next, session });
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
