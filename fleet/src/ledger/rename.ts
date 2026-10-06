/**
 * A worker renamed from the page (the hub's `POST /f/<fleet>/name`): the name is the user's, which neither
 * the worker's session nor anything automatic replaces; an empty one hands the name back to the session's,
 * else the id. Written under the ledger's lock, which `fleet state` takes too.
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { stampOf } from "../clock.ts";
import { Refusal } from "../errors.ts";
import { readText, writeText } from "../files.ts";
import type { Machine } from "../world.ts";
import { nameFromSessions } from "./commands.ts";
import { dropKey, ledgerText, parseLedger } from "./model.ts";
import { find } from "./numbers.ts";
import { withLedgerLock } from "./store.ts";
import { nameRefusal, validate } from "./validate.ts";

/** What a worker is called after a rename, and who gave it the name (absent: it is its id). */
export interface Renamed {
  readonly name: string;
  readonly name_by?: string;
}

/** Call worker `id` of the ledger in `root` `name` (trimmed), or, when it is empty, what its session calls
 * it, else its id; why not, when the ledger cannot be read or the name could not be told apart in a mention. */
export function renameAgent(machine: Machine, root: string, id: string, name: string): Renamed | { readonly why: string } {
  return withLedgerLock(root, () => {
    const path = join(root, "state.json");
    const text = readText(path);
    const ledger = text === undefined ? undefined : Option.getOrUndefined(parseLedger(text));

    if (ledger === undefined || ledger instanceof Refusal) return { why: `no ledger in ${root}` };
    const a = find(ledger.agents, id);

    if (a === undefined) return { why: `no worker '${id}'` };
    const wanted = name.trim();

    if (wanted === "") {
      a.name = a.id;
      delete a.name_by;
      dropKey(a, "name_by");
      nameFromSessions(machine, root, ledger);
    } else {
      const why = nameRefusal(ledger, a.id, wanted);

      if (why !== undefined) return { why };
      a.name = wanted;
      a.name_by = "user";
    }

    ledger.updated = stampOf(machine.now());
    const fault = validate(ledger);

    if (fault !== undefined) return { why: fault.reason };
    writeText(path, ledgerText(ledger));

    return a.name_by === undefined ? { name: a.name } : { name: a.name, name_by: a.name_by };
  });
}
