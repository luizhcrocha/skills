/**
 * Numbers given on a copy of a ledger read as plain JSON (Python's `decisions.number` on the page's
 * copy): the page and a manager's summaries show a row's number even when the ledger was written by
 * hand or by an older version, without decoding it into the typed model. Same rule as
 * `ledger/numbers.ts`: a letter for the kind and 1 + the highest number of that letter, skipping a
 * number another row has as its id; decisions in `opened` order, links and roadblocks in list order.
 */
import { asArray, asObject, asString, pyRepr, truthy, type Json, type JsonObject } from "../json.ts";
import { PREFIX } from "../ledger/numbers.ts";

/** Python's `str()` of a JSON value. */
export function pyStr(value: Json | undefined): string {
  return asString(value) ?? pyRepr(value);
}

function nextRef(rows: readonly JsonObject[], prefix: string, row: JsonObject): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let n = 1;

  for (const r of rows) {
    const m = pattern.exec(r["ref"] === undefined ? "" : pyStr(r["ref"]));

    if (m !== null) n = Math.max(n, Number(m[1]) + 1);
  }

  const ids = new Set(rows.flatMap((r) => {
    const id = asString(r["id"]);

    return r === row || id === undefined ? [] : [id];
  }));

  while (ids.has(`${prefix}${n}`)) n += 1;

  return `${prefix}${n}`;
}

function objects(value: Json | undefined): JsonObject[] {
  return (asArray(value) ?? []).flatMap((item) => {
    const row = asObject(item);

    return row === undefined ? [] : [row];
  });
}

/** `state` with a number on every decision, link and roadblock that has none; the rest as it was. */
export function numberState(state: JsonObject): JsonObject {
  const given = new Map<JsonObject, string>();
  const decisions = objects(state["decisions"]);
  const waiting = decisions.filter((d) => !truthy(d["ref"]));
  const opened = (d: JsonObject): string => (d["opened"] === undefined ? "" : pyStr(d["opened"]));
  const byOpened = [...waiting].sort((a, b) => (opened(a) < opened(b) ? -1 : opened(a) > opened(b) ? 1 : 0));
  const withRefs = (rows: readonly JsonObject[]): JsonObject[] => rows.map((r) => (given.has(r) ? { ...r, ref: given.get(r) ?? "" } : r));

  for (const d of byOpened) {
    const kind = asString(d["kind"]);
    const prefix = kind === undefined ? "D" : (PREFIX.get(kind) ?? "D");
    given.set(d, nextRef(withRefs(decisions), prefix, d));
  }

  let out: JsonObject = { ...state };

  if (decisions.length > 0) out = { ...out, decisions: renumbered(state["decisions"], given) };

  for (const [key, prefix] of [
    ["links", "L"],
    ["roadblocks", "R"],
  ] as const) {
    const rows = objects(state[key]);

    for (const r of rows) {
      if (!truthy(r["ref"])) given.set(r, nextRef(withRefs(rows), prefix, r));
    }

    if (rows.length > 0) out = { ...out, [key]: renumbered(state[key], given) };
  }

  return out;
}

function renumbered(list: Json | undefined, given: ReadonlyMap<JsonObject, string>): Json[] {
  return (asArray(list) ?? []).map((item) => {
    const row = asObject(item);
    const ref = row === undefined ? undefined : given.get(row);

    return row === undefined || ref === undefined ? item : { ...row, ref };
  });
}
