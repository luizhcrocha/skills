/**
 * What a fleet looks like from outside its own session: the user's answers its coordinator has not
 * recorded, the workers the ledger says run but whose transcripts are silent. Read by `fleet fleets`
 * and by a manager's or coordinator's chat watch.
 */
import { stampOf } from "./clock.ts";
import type { Message } from "./chat/store.ts";
import { asArray, asObject, asString, pyRepr, type JsonObject } from "./json.ts";
import { lastActivity } from "./transcripts.ts";
import { secondsNow, type Machine } from "./world.ts";

/** A running worker that has written nothing for this long is silent. */
export const SILENT_S = 20 * 60;

/** A local stamp of seconds since the epoch. */
export function isoOf(seconds: number): string {
  return stampOf(new Date(seconds * 1000));
}

function str(value: JsonObject[string] | undefined): string {
  return asString(value) ?? (value === undefined || value === null ? "" : pyRepr(value));
}

/** When the user's answer to the open decision `d`, given after it last changed and not replied to,
 * was sent (strings compared, open-13); undefined when there is none. */
export function answeredAt(d: JsonObject, said: readonly Message[]): string | undefined {
  const revised = d["revised"];
  const opened = d["opened"];
  const since = revised !== undefined && revised !== null && revised !== "" ? str(revised) : str(opened);
  const id = d["id"];

  const answers = said.filter(
    (m) =>
      m.decision !== undefined &&
      pyRepr(m.decision) === pyRepr(id) &&
      m.from === "user" &&
      str(m.at) >= since &&
      !said.some((r) => r.from !== "user" && r.re === m.id),
  );

  const last = answers.at(-1);

  return last === undefined ? undefined : str(last.at);
}

/** A silent worker. */
export interface Silent {
  readonly id: string;
  readonly name: string;
  readonly active: string;
}

/** The workers of DIR the ledger says are running or blocked whose transcript has not moved for
 * {@link SILENT_S}, oldest silence first. */
export function silentWorkers(machine: Machine, root: string, state: JsonObject): Silent[] {
  const seen = lastActivity(root, machine.config);
  const now = secondsNow(machine);
  const rows: Silent[] = [];

  for (const row of asArray(state["agents"]) ?? []) {
    const a = asObject(row);
    const id = asString(a?.["id"]);
    const status = a?.["status"];

    if (a === undefined || id === undefined || (status !== "running" && status !== "blocked")) continue;
    const at = seen.get(id);

    if (at === undefined || now - at <= SILENT_S) continue;
    const name = a["name"];
    rows.push({ id, name: name === undefined || name === null || name === "" ? id : str(name), active: isoOf(at) });
  }

  return rows.sort((x, y) => (x.active < y.active ? -1 : x.active > y.active ? 1 : 0));
}
